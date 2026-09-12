import { appendFileSync, closeSync, openSync, promises as fs } from "node:fs";
import { spawn } from "node:child_process";
import path from "node:path";
import { appConfig, resolvedOutputPath, toRelativeOutputPath } from "@/lib/config";
import { ensureVideoCreatorSchema, processAlive, query } from "@/lib/db";
import { markFacebookPublished, markFacebookScheduled, markYouTubeUploaded, saveVideoDetails } from "@/lib/video";
import { validateYouTubePublishSettings, validateYouTubeUpload, youtubeConfiguration, type YouTubeUploadInput, type YouTubePublishSettings } from "@/lib/youtube";

type AfterRunPublish = {
  facebook?: boolean;
  youtube?: YouTubePublishSettings;
  outputVideo?: string;
  sourceRunId?: number;
};

type RunAction = "create_next" | "generate_pattern" | "publish" | "youtube_publish";
export type Run = {
  id: number; action: RunAction; pattern_id: number | null; pattern_name: string | null;
  status: "running" | "success" | "failed"; log_path: string; error: string | null;
  started_at: string; finished_at: string | null;
  output_video?: string | null; runner_pid?: number | null;
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

async function createRun(action: RunAction, patternId?: number, patternName?: string, afterRunPublish?: AfterRunPublish) {
  await ensureVideoCreatorSchema();
  const logDir = path.join(appConfig.logDir(), "video-creator", "runs");
  await fs.mkdir(logDir, { recursive: true });
  const logPath = path.join(logDir, `${safeLogName()}-${action}.log`);
  const result = await query<Run>(`INSERT INTO video_creator_runs (action, pattern_id, pattern_name, log_path, after_run_publish)
    VALUES ($1, $2, $3, $4, $5::jsonb) RETURNING *`,
    [action, patternId ?? null, patternName ?? null, logPath, afterRunPublish ? JSON.stringify(afterRunPublish) : null]);
  return result.rows[0];
}

// Persist intent on the source run before starting Python. Claim once after the
// worker ends, so restart recovery cannot launch duplicate external uploads.
async function publishAfterRun(run: Pick<Run, "id" | "log_path" | "action">, outputVideo?: string) {
  const result = await query<{ after_run_publish: AfterRunPublish; status: string; error: string | null }>(`
    WITH pending AS (
      SELECT id, after_run_publish FROM video_creator_runs
      WHERE id = $1 AND status <> 'running' AND after_run_publish IS NOT NULL FOR UPDATE
    )
    UPDATE video_creator_runs AS runs SET after_run_publish = NULL FROM pending
    WHERE runs.id = pending.id
    RETURNING pending.after_run_publish, runs.status, runs.error`, [run.id]);
  const row = result.rows[0];
  if (!row) return;
  const plan = row.after_run_publish;
  const sourceRunId = plan.sourceRunId ?? run.id;
  async function report(message: string) {
    await fs.appendFile(run.log_path, `\nAutomatic publishing: ${message}\n`);
    await query(`UPDATE video_creator_schedule SET
      last_error = LEFT(CONCAT_WS(E'\\n', NULLIF(last_error, ''), $2::text), 4000), updated_at = NOW()
      WHERE last_run_id = $1`, [sourceRunId, message]);
  }
  if (row.status === "failed") {
    await report(`Run #${run.id} failed: ${row.error || "See run log."}`);
    if (run.action !== "publish") return; // Never upload a failed generation.
  }
  if (!plan.facebook && !plan.youtube) return;
  const video = outputVideo || plan.outputVideo;
  try {
    if (!video) throw new Error("Video created, but output video path is missing.");
    const patternName = path.basename(video).replace(/_video\.mp4$/i, "");
    const captionPath = path.join(appConfig.dataDir(), path.dirname(video), `${patternName}_reel_caption.txt`);
    const caption = await fs.readFile(captionPath, "utf8").catch(() => "");
    const title = patternName.replaceAll("_", " ").trim();
    if (plan.facebook) {
      try {
        const upload = await startFacebookPublish(video, caption, { title }, {
          youtube: plan.youtube, outputVideo: video, sourceRunId,
        });
        await fs.appendFile(run.log_path, `\nAutomatic Facebook upload: run #${upload.id}.\n`).catch(() => {});
        return; // YouTube starts only after the Facebook worker finishes.
      } catch (error) {
        await report(`Facebook upload could not start: ${error instanceof Error ? error.message : "Unknown error"}`);
        // A preflight failure on Facebook must not prevent YouTube uploading.
      }
    }
    if (plan.youtube) {
      const input = validateYouTubeUpload({
        path: video, title, description: caption, ...plan.youtube, confirmUpload: true,
      });
      const upload = await startYouTubePublish(input, { sourceRunId, outputVideo: video });
      await fs.appendFile(run.log_path, `\nAutomatic YouTube upload: run #${upload.id}.\n`);
    }
  } catch (error) {
    await report(error instanceof Error ? error.message : "Automatic publishing failed.");
  }
}

async function finishRun(id: number, status: "success" | "failed", error?: string, outputVideo?: string) {
  await query(`UPDATE video_creator_runs SET status = $2, error = $3, finished_at = NOW(), output_video = $4, runner_pid = NULL WHERE id = $1`,
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

async function trackProcess(
  run: Run,
  command: string,
  args: string[],
  afterSuccess?: (stdout: string, outputVideo?: string) => Promise<void>,
) {
  const safeArgs = args.map((arg, index) => args[index - 1] === "--page-token" ? "[REDACTED]" : (arg.includes(" ") ? JSON.stringify(arg) : arg));
  const header = `$ ${command} ${safeArgs.join(" ")}\n\n`;
  appendFileSync(run.log_path, header, { mode: 0o600 });
  let child;
  try {
    const logFd = openSync(run.log_path, "a");
    child = spawn(command, args, {
      cwd: appConfig.skillDir(),
      env: process.env,
      detached: true,
      stdio: ["ignore", logFd, logFd],
    });
    closeSync(logFd);
  } catch (error) {
    await finishRun(run.id, "failed", error instanceof Error ? error.message : "Không khởi động được pipeline.");
    await publishAfterRun(run);
    return;
  }
  child.on("error", (error) => {
    void fs.appendFile(run.log_path, `\nProcess error: ${error.message}\n`);
    void finishRun(run.id, "failed", error.message).then(() => publishAfterRun(run)).catch(() => {});
  });
  child.on("close", async (code) => {
    try {
      const output = await fs.readFile(run.log_path, "utf8").catch(() => "");
      if (code !== 0) throw new Error((output.split(/\r?\n/).slice(-20).join("\n") || `Pipeline kết thúc với mã ${code}.`).trim());
      // Python logging is written to stderr by default, while the final JSON
      // status is written to stdout. Parse both streams for the output path.
      const outputVideo = parseOutputVideo(output);
      const jsonLine = output.split(/\r?\n/).reverse().find((line) => {
        try { return Boolean(JSON.parse(line.trim()) && line.trim().startsWith("{")); } catch { return false; }
      })?.trim() || output;
      if (afterSuccess) await afterSuccess(jsonLine, outputVideo);
      if (outputVideo && run.action !== "youtube_publish") await saveGeneratedVideoDetails(outputVideo).catch(() => {});
      await finishRun(run.id, "success", undefined, outputVideo);
    } catch (error) {
      await finishRun(run.id, "failed", error instanceof Error ? error.message : "Pipeline lỗi không xác định.");
    }
    await publishAfterRun(run, parseOutputVideo(await fs.readFile(run.log_path, "utf8").catch(() => ""))).catch(async (error) => {
      await fs.appendFile(run.log_path, `\nPost-run action error: ${error instanceof Error ? error.message : "Unknown error"}\n`);
    });
  });
  await query(`UPDATE video_creator_runs SET runner_pid = $2 WHERE id = $1 AND status = 'running'`, [run.id, child.pid ?? null]);
  child.unref();
}

export async function startYouTubePublish(input: YouTubeUploadInput, afterRunPublish?: AfterRunPublish) {
  const configuration = youtubeConfiguration();
  if (!configuration.configured) throw new Error(`Set ${configuration.missing.join(", ")} in .env.local.`);
  const root = await fs.realpath(appConfig.outputDir());
  const videoFile = await fs.realpath(resolvedOutputPath(input.path));
  if (!videoFile.startsWith(`${root}${path.sep}`)) throw new Error("Video must be inside OUTPUT_DIR.");
  const stat = await fs.stat(videoFile);
  if (!stat.isFile() || stat.size <= 0) throw new Error("Video is missing or empty.");
  const script = path.join(process.cwd(), "scripts", "publish_youtube.py");
  await fs.access(script);
  const run = await createRun("youtube_publish", undefined, undefined, afterRunPublish);
  try {
    const jobPath = `${run.log_path}.json`;
    await fs.writeFile(jobPath, JSON.stringify({ ...input, videoFile }), { mode: 0o600 });
    await trackProcess(run, "python3", [script, jobPath], async (stdout) => {
      await recordYouTubeResult(input.path, stdout);
    });
  } catch (error) {
    await finishRun(run.id, "failed", error instanceof Error ? error.message : "Could not start YouTube upload.");
    await query(`UPDATE video_creator_runs SET after_run_publish = NULL WHERE id = $1`, [run.id]);
    throw error;
  }
  return run;
}

async function recordYouTubeResult(relativePath: string, output: string) {
  const line = output.split(/\r?\n/).reverse().find((item) => item.trim().startsWith('{"success":'));
  const result = JSON.parse(line || output) as { success?: boolean; video_id?: string; privacy_status?: string };
  if (!result.success || !result.video_id || !/^[A-Za-z0-9_-]{11}$/.test(result.video_id)) {
    throw new Error("YouTube returned no valid video ID. Check YouTube Studio before retrying.");
  }
  await markYouTubeUploaded(relativePath, result.video_id, result.privacy_status || "private");
}

export async function startGeneration(input: {
  patternId?: number;
  patternName?: string;
  forceRecreate?: boolean;
  publishToFacebook?: boolean;
  youtube?: YouTubePublishSettings;
}) {
  const selected = input.patternId !== undefined;
  if (selected && (!Number.isInteger(input.patternId) || input.patternId! <= 0 || !input.patternName?.trim())) {
    throw new Error("Chọn mẫu ngữ pháp hợp lệ trước khi tạo video.");
  }
  const youtube = input.youtube ? validateYouTubePublishSettings(input.youtube) : undefined;
  if (youtube && !youtubeConfiguration().configured) throw new Error("Configure YouTube OAuth credentials in .env.local first.");
  const configPath = await writeRuntimeConfig();
  const run = await createRun(selected ? "generate_pattern" : "create_next", input.patternId, input.patternName?.trim(),
    input.publishToFacebook || youtube ? { facebook: input.publishToFacebook, youtube } : undefined);
  const args = ["grammar_pipeline_module/jlpt_n1_video_pipeline.py", "--config", configPath, "--step", "all", "--skip-publish"];
  if (selected) args.push("--pattern-id", String(input.patternId), "--pattern-name", input.patternName!.trim());
  if (input.forceRecreate) args.push("--force-recreate");
  try {
    await trackProcess(run, "python3", args);
  } catch (error) {
    await finishRun(run.id, "failed", error instanceof Error ? error.message : "Could not start generation.");
    await publishAfterRun(run);
    throw error;
  }
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
  afterRunPublish?: AfterRunPublish,
) {
  const videoFile = resolvedOutputPath(relativePath);
  const stat = await fs.stat(videoFile);
  if (!stat.isFile() || stat.size <= 0) throw new Error("Không tìm thấy video MP4 để đăng.");
  if (!caption.trim()) throw new Error("Nhập caption trước khi đăng Facebook.");
  const scheduledAt = parseScheduledAt(options.scheduledAt);
  const run = await createRun("publish", undefined, undefined, afterRunPublish);
  try {
    const captionDir = path.join(appConfig.dataDir(), "video-creator", "captions");
    await fs.mkdir(captionDir, { recursive: true });
    const captionPath = path.join(captionDir, `${run.id}.txt`);
    await fs.writeFile(captionPath, caption.trim(), { mode: 0o600 });
    const args = ["grammar_pipeline_module/publish_reel.py", "--page-id", appConfig.pipelineConfig().facebook.pageId,
      "--page-token", appConfig.pipelineConfig().facebook.pageToken, "--video-file", videoFile, "--description-file", captionPath];
    if (options.title?.trim()) args.push("--title", options.title.trim());
    if (scheduledAt) args.push("--scheduled-publish-time", String(Math.floor(scheduledAt.getTime() / 1000)));
    await trackProcess(run, "python3", args, async (stdout) => {
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
  } catch (error) {
    await finishRun(run.id, "failed", error instanceof Error ? error.message : "Could not start Facebook upload.");
    // The caller handles a start failure; leave no second continuation to retry.
    await query(`UPDATE video_creator_runs SET after_run_publish = NULL WHERE id = $1`, [run.id]);
    throw error;
  }
  return run;
}

const resumedRuns = new Set<number>();

async function finalizeResumedRun(run: Pick<Run, "id" | "log_path" | "action">) {
  const output = await fs.readFile(run.log_path, "utf8").catch(() => "");
  const outputVideo = parseOutputVideo(output);
  const succeeded = /PIPELINE COMPLETED SUCCESSFULLY|^\s*\{\s*"success"\s*:\s*true\b/m.test(output);
  if (succeeded) {
    if (run.action === "youtube_publish") {
      if (!outputVideo) throw new Error("YouTube upload log has no video path.");
      await recordYouTubeResult(outputVideo, output);
    } else if (outputVideo) await saveGeneratedVideoDetails(outputVideo).catch(() => {});
    await finishRun(run.id, "success", undefined, outputVideo);
  } else {
    await finishRun(run.id, "failed", "Pipeline process ended during application restart.");
  }
  await publishAfterRun(run, outputVideo).catch(async (error) => {
    await fs.appendFile(run.log_path, `\nPost-run recovery error: ${error instanceof Error ? error.message : "Unknown error"}\n`);
  });
}

function monitorResumedRun(run: Pick<Run, "id" | "log_path" | "action">, pid: number) {
  if (resumedRuns.has(run.id)) return;
  resumedRuns.add(run.id);
  const timer = setInterval(() => {
    if (processAlive(pid)) return;
    clearInterval(timer);
    resumedRuns.delete(run.id);
    void finalizeResumedRun(run).catch(() => {
      void finishRun(run.id, "failed", "Could not recover upload metadata. Check YouTube Studio before retrying.");
    });
  }, 5_000);
  timer.unref();
}

export async function resumeActiveRuns() {
  await ensureVideoCreatorSchema();
  const result = await query<Pick<Run, "id" | "log_path" | "runner_pid" | "action">>(
    `SELECT id, log_path, runner_pid, action FROM video_creator_runs
     WHERE status = 'running' AND runner_pid IS NOT NULL`,
  );
  for (const run of result.rows) {
    if (run.runner_pid && processAlive(run.runner_pid)) monitorResumedRun(run, run.runner_pid);
    else await finalizeResumedRun(run);
  }
  // Also cover restart between marking a worker finished and claiming its
  // publishing continuation. Runs without an explicit saved opt-in are ignored.
  const pending = await query<Run>(`SELECT * FROM video_creator_runs
    WHERE status <> 'running' AND after_run_publish IS NOT NULL ORDER BY id`);
  for (const run of pending.rows) {
    await publishAfterRun(run, run.output_video || undefined);
  }
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
