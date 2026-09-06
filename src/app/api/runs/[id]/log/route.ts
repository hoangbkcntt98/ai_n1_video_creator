import { promises as fs } from "node:fs";
import path from "node:path";
import { appConfig } from "@/lib/config";
import { ensureVideoCreatorSchema, query } from "@/lib/db";
import { normalizeOutputVideo, parseOutputVideo } from "@/lib/pipeline";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const MAX_LOG_BYTES = 160_000;

type RunLogRow = {
  id: number;
  status: "running" | "success" | "failed";
  log_path: string;
  error: string | null;
  started_at: string;
  finished_at: string | null;
  output_video: string | null;
};

function safeLogPath(logPath: string) {
  const root = path.resolve(appConfig.logDir(), "video-creator", "runs");
  const target = path.resolve(logPath);
  if (!target.startsWith(`${root}${path.sep}`) || path.extname(target) !== ".log") {
    throw new Error("Đường dẫn log không hợp lệ.");
  }
  return target;
}

async function readLogTail(logPath: string) {
  const filePath = safeLogPath(logPath);
  const stat = await fs.stat(filePath).catch(() => null);
  if (!stat?.isFile()) return "Chưa có dữ liệu log.";
  const length = Math.min(stat.size, MAX_LOG_BYTES);
  const handle = await fs.open(filePath, "r");
  try {
    const buffer = Buffer.alloc(length);
    await handle.read(buffer, 0, length, Math.max(0, stat.size - length));
    const prefix = stat.size > MAX_LOG_BYTES ? "... log cũ hơn đã ẩn ...\n" : "";
    return prefix + buffer.toString("utf8");
  } finally {
    await handle.close();
  }
}

export async function GET(_request: Request, context: { params: Promise<{ id: string }> }) {
  const { id } = await context.params;
  const runId = Number(id);
  if (!Number.isSafeInteger(runId) || runId <= 0) {
    return Response.json({ error: "Run ID không hợp lệ." }, { status: 400 });
  }

  try {
    await ensureVideoCreatorSchema();
    const result = await query<RunLogRow>(`SELECT id, status, log_path, error, started_at, finished_at, output_video
      FROM video_creator_runs WHERE id = $1`, [runId]);
    const run = result.rows[0];
    if (!run) return Response.json({ error: "Không tìm thấy pipeline run." }, { status: 404 });
    const log = await readLogTail(run.log_path);
    run.output_video = run.output_video
      ? (normalizeOutputVideo(run.output_video) || run.output_video)
      : (parseOutputVideo(log) || null);
    return Response.json({ run, log });
  } catch (error) {
    return Response.json({ error: error instanceof Error ? error.message : "Không đọc được log pipeline." }, { status: 500 });
  }
}
