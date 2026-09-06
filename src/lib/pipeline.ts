import { createWriteStream, promises as fs } from "node:fs";
import { spawn } from "node:child_process";
import path from "node:path";
import { appConfig, resolvedOutputPath, toRelativeOutputPath } from "@/lib/config";
import { ensureVideoCreatorSchema, query } from "@/lib/db";
import { markFacebookPublished, markFacebookScheduled, saveVideoDetails } from "@/lib/video";

type RunAction = "create_next" | "generate_pattern" | "publish";
export type Run = {
  id: number; action: RunAction; pattern_id: number | null; pattern_name: string | null;
  status: "running" | "success" | "failed"; log_path: string; error: string | null;
  started_at: string; finished_at: string | null;
  output_video?: string | null;
};

function safeLogName() {
  return new Date().toISOString().replaceAll(":", "-").replaceAll(".", "-");
}

async function writeRuntimeConfig() {
  const configPath = path.join(process.cwd(), ".pipeline-runtime.json");
  await fs.writeFile(configPath, `${JSON.stringify(appConfig.pipelineConfig(), null, 2)}\n`, { mode: 0o600 });
  await fs.chmod(configPath, 0o600);
  return configPath;
}

async function createRun(action: RunAction, patternId?: number, patternName?: string) {
  await ensureVideoCreatorSchema();
  const logDir = path.join(appConfig.logDir(), "video-creator", "runs");
  await fs.mkdir(logDir, { recursive: true });
  const logPath = path.join(logDir, `${safeLogName()}-${action}.log`);
  const result = await query<Run>(`INSERT INTO video_creator_runs (action, pattern_id, pattern_name, log_path)
    VALUES ($1, $2, $3, $4) RETURNING *`, [action, patternId ?? null, patternName ?? null, logPath]);
  return result.rows[0];
}

async function finishRun(id: number, status: "success" | "failed", error?: string, outputVideo?: string) {
  await query(`UPDATE video_creator_runs SET status = $2, error = $3, finished_at = NOW(), output_video = $4 WHERE id = $1`,
    [id, status, error?.slice(0, 4000) ?? null, outputVideo ?? null]);
}

export function normalizeOutputVideo(videoPath: string) {
  const candidate = videoPath.trim().replace(/^["']|["']$/g, "");
  if (!candidate || !candidate.toLowerCase().endsWith(".mp4")) return undefined;
  try {
    return toRelativeOutputPath(path.isAbsolute(candidate) ? candidate : resolvedOutputPath(candidate));
  } catch {
    return undefined;
  }
}

/**
 * The pipeline's final JSON currently only contains `{ "success": true }`, while
 * the actual output path is printed in the preceding "Video ready:" log line.
 * Keep parsing both formats so completed runs can always point to their video.
 */
export function parseOutputVideo(output: string) {
  const lines = output.split(/\r?\n/);
  for (const line of [...lines].reverse()) {
    const ready = line.match(/Video ready:\s*(.+?\.mp4)\s*$/i);
    if (ready?.[1]) {
      const normalized = normalizeOutputVideo(ready[1]);
      if (normalized) return normalized;
    }

    try {
      const payload = JSON.parse(line.trim()) as { video_path?: unknown };
      if (typeof payload.video_path === "string") {
        const normalized = normalizeOutputVideo(payload.video_path);
        if (normalized) return normalized;
      }
    } catch {
      // Most pipeline lines are not JSON.
    }
  }
  return undefined;
}

async function saveGeneratedVideoDetails(relativePath: string) {
  const fileName = path.basename(relativePath);
  const patternName = fileName.replace(/_video\.mp4$/i, "");
  if (!patternName) return;

  const dateDir = path.dirname(relativePath);
  const captionPath = path.join(appConfig.dataDir(), dateDir, `${patternName}_reel_caption.txt`);
  const caption = await fs.readFile(captionPath, "utf8").catch(() => "");
  const title = patternName.replaceAll("_", " ").trim();
  if (!title && !caption.trim()) return;
  await saveVideoDetails(relativePath, { title, caption });
}

function trackProcess(run: Run, command: string, args: string[], afterSuccess?: (stdout: string) => Promise<void>) {
  const log = createWriteStream(run.log_path, { flags: "a", mode: 0o600 });
  const safeArgs = args.map((arg, index) => args[index - 1] === "--page-token" ? "[REDACTED]" : (arg.includes(" ") ? JSON.stringify(arg) : arg));
  log.write(`$ ${command} ${safeArgs.join(" ")}\n\n`);
  let stdout = "";
  let stderr = "";
  let child;
  try {
    child = spawn(command, args, { cwd: appConfig.skillDir(), env: process.env, stdio: ["ignore", "pipe", "pipe"] });
  } catch (error) {
    log.end();
    void finishRun(run.id, "failed", error instanceof Error ? error.message : "Không khởi động được pipeline.");
    return;
  }
  child.stdout.on("data", (data: Buffer) => { const text = data.toString(); stdout += text; log.write(text); });
  child.stderr.on("data", (data: Buffer) => { const text = data.toString(); stderr += text; log.write(text); });
  child.on("error", (error) => {
    log.write(`\nProcess error: ${error.message}\n`); log.end();
    void finishRun(run.id, "failed", error.message);
  });
  child.on("close", async (code) => {
    try {
      if (code !== 0) throw new Error((stderr || `Pipeline kết thúc với mã ${code}.`).trim());
      // Python logging is written to stderr by default, while the final JSON
      // status is written to stdout. Parse both streams for the output path.
      const outputVideo = parseOutputVideo(`${stdout}\n${stderr}`);
      if (afterSuccess) await afterSuccess(stdout);
      if (outputVideo) await saveGeneratedVideoDetails(outputVideo).catch(() => {});
      await finishRun(run.id, "success", undefined, outputVideo);
    } catch (error) {
      await finishRun(run.id, "failed", error instanceof Error ? error.message : "Pipeline lỗi không xác định.");
    } finally { log.end(); }
  });
  child.unref();
}

export async function startGeneration(input: { patternId?: number; patternName?: string; forceRecreate?: boolean }) {
  const selected = input.patternId !== undefined;
  if (selected && (!Number.isInteger(input.patternId) || input.patternId! <= 0 || !input.patternName?.trim())) {
    throw new Error("Chọn mẫu ngữ pháp hợp lệ trước khi tạo video.");
  }
  const configPath = await writeRuntimeConfig();
  const run = await createRun(selected ? "generate_pattern" : "create_next", input.patternId, input.patternName?.trim());
  const args = ["grammar_pipeline_module/jlpt_n1_video_pipeline.py", "--config", configPath, "--step", "all", "--skip-publish"];
  if (selected) args.push("--pattern-id", String(input.patternId), "--pattern-name", input.patternName!.trim());
  if (input.forceRecreate) args.push("--force-recreate");
  trackProcess(run, "python3", args);
  return run;
}

const MIN_SCHEDULE_LEAD_MS = 10 * 60 * 1000;
const MAX_SCHEDULE_LEAD_MS = 29 * 24 * 60 * 60 * 1000;

function parseScheduledAt(value?: string) {
  if (!value?.trim()) return undefined;
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) throw new Error("Thời gian lên lịch không hợp lệ.");
  if (date.getTime() < Date.now() + MIN_SCHEDULE_LEAD_MS) {
    throw new Error("Thời gian lên lịch phải cách hiện tại ít nhất 10 phút.");
  }
  if (date.getTime() > Date.now() + MAX_SCHEDULE_LEAD_MS) {
    throw new Error("Facebook chỉ cho phép lên lịch trong vòng 29 ngày.");
  }
  return date;
}

export async function startFacebookPublish(
  relativePath: string,
  caption: string,
  options: { title?: string; scheduledAt?: string } = {},
) {
  const videoFile = resolvedOutputPath(relativePath);
  const stat = await fs.stat(videoFile);
  if (!stat.isFile() || stat.size <= 0) throw new Error("Không tìm thấy video MP4 để đăng.");
  if (!caption.trim()) throw new Error("Nhập caption trước khi đăng Facebook.");
  const scheduledAt = parseScheduledAt(options.scheduledAt);
  const run = await createRun("publish");
  const captionDir = path.join(appConfig.dataDir(), "video-creator", "captions");
  await fs.mkdir(captionDir, { recursive: true });
  const captionPath = path.join(captionDir, `${run.id}.txt`);
  await fs.writeFile(captionPath, caption.trim(), { mode: 0o600 });
  const args = ["grammar_pipeline_module/publish_reel.py", "--page-id", appConfig.pipelineConfig().facebook.pageId,
    "--page-token", appConfig.pipelineConfig().facebook.pageToken, "--video-file", videoFile, "--description-file", captionPath];
  if (options.title?.trim()) args.push("--title", options.title.trim());
  if (scheduledAt) args.push("--scheduled-publish-time", String(Math.floor(scheduledAt.getTime() / 1000)));
  trackProcess(run, "python3", args, async (stdout) => {
    const payload = JSON.parse(stdout.trim()) as {
      video_id?: string; success?: boolean; scheduled_publish_time?: number | null;
    };
    if (!payload.success || !payload.video_id) throw new Error("Facebook không trả về video ID sau khi đăng.");
    if (scheduledAt || payload.scheduled_publish_time) {
      await markFacebookScheduled(
        relativePath,
        payload.video_id,
        scheduledAt || new Date(Number(payload.scheduled_publish_time) * 1000),
      );
    } else {
      await markFacebookPublished(relativePath, payload.video_id);
    }
  });
  return run;
}

export async function listRuns() {
  await ensureVideoCreatorSchema();
  const result = await query<Run>(`SELECT * FROM video_creator_runs ORDER BY started_at DESC LIMIT 12`);
  // Recover paths for runs created before output-video parsing was fixed.
  return Promise.all(result.rows.map(async (run) => {
    if (run.status !== "success") return run;
    if (run.output_video) {
      const normalized = normalizeOutputVideo(run.output_video);
      if (!normalized || normalized === run.output_video) return run;
      await query(`UPDATE video_creator_runs SET output_video = $2 WHERE id = $1`, [run.id, normalized]).catch(() => {});
      return { ...run, output_video: normalized };
    }
    const log = await fs.readFile(run.log_path, "utf8").catch(() => "");
    const outputVideo = parseOutputVideo(log);
    if (!outputVideo) return run;
    await query(`UPDATE video_creator_runs SET output_video = $2 WHERE id = $1`, [run.id, outputVideo]).catch(() => {});
    return { ...run, output_video: outputVideo };
  }));
}
