import { createWriteStream, promises as fs } from "node:fs";
import { spawn } from "node:child_process";
import path from "node:path";
import { appConfig, resolvedOutputPath } from "@/lib/config";
import { ensureVideoCreatorSchema, query } from "@/lib/db";
import { markFacebookPublished } from "@/lib/video";

type RunAction = "create_next" | "generate_pattern" | "publish";
export type Run = {
  id: number; action: RunAction; pattern_id: number | null; pattern_name: string | null;
  status: "running" | "success" | "failed"; log_path: string; error: string | null;
  started_at: string; finished_at: string | null;
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

async function finishRun(id: number, status: "success" | "failed", error?: string) {
  await query(`UPDATE video_creator_runs SET status = $2, error = $3, finished_at = NOW() WHERE id = $1`,
    [id, status, error?.slice(0, 4000) ?? null]);
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
      if (afterSuccess) await afterSuccess(stdout);
      await finishRun(run.id, "success");
    } catch (error) {
      await finishRun(run.id, "failed", error instanceof Error ? error.message : "Pipeline lỗi không xác định.");
    } finally { log.end(); }
  });
  child.unref();
}

export async function startGeneration(input: { patternId?: number; patternName?: string }) {
  const selected = input.patternId !== undefined;
  if (selected && (!Number.isInteger(input.patternId) || input.patternId! <= 0 || !input.patternName?.trim())) {
    throw new Error("Chọn mẫu ngữ pháp hợp lệ trước khi tạo video.");
  }
  const configPath = await writeRuntimeConfig();
  const run = await createRun(selected ? "generate_pattern" : "create_next", input.patternId, input.patternName?.trim());
  const args = ["grammar_pipeline_module/jlpt_n1_video_pipeline.py", "--config", configPath, "--step", "all", "--skip-publish"];
  if (selected) args.push("--pattern-id", String(input.patternId), "--pattern-name", input.patternName!.trim());
  trackProcess(run, "python3", args);
  return run;
}

export async function startFacebookPublish(relativePath: string, caption: string) {
  const videoFile = resolvedOutputPath(relativePath);
  const stat = await fs.stat(videoFile);
  if (!stat.isFile() || stat.size <= 0) throw new Error("Không tìm thấy video MP4 để đăng.");
  if (!caption.trim()) throw new Error("Nhập caption trước khi đăng Facebook.");
  const run = await createRun("publish");
  const captionDir = path.join(appConfig.dataDir(), "video-creator", "captions");
  await fs.mkdir(captionDir, { recursive: true });
  const captionPath = path.join(captionDir, `${run.id}.txt`);
  await fs.writeFile(captionPath, caption.trim(), { mode: 0o600 });
  const args = ["grammar_pipeline_module/publish_reel.py", "--page-id", appConfig.pipelineConfig().facebook.pageId,
    "--page-token", appConfig.pipelineConfig().facebook.pageToken, "--video-file", videoFile, "--description-file", captionPath];
  trackProcess(run, "python3", args, async (stdout) => {
    const payload = JSON.parse(stdout.trim()) as { video_id?: string; success?: boolean };
    if (!payload.success || !payload.video_id) throw new Error("Facebook không trả về video ID sau khi đăng.");
    await markFacebookPublished(relativePath, payload.video_id);
  });
  return run;
}

export async function listRuns() {
  await ensureVideoCreatorSchema();
  const result = await query<Run>(`SELECT * FROM video_creator_runs ORDER BY started_at DESC LIMIT 12`);
  return result.rows;
}
