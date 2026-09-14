import { randomUUID } from "node:crypto";
import { promises as fs } from "node:fs";
import { db, query } from "@/lib/db";
import { generateWordCreator, type WordCreatorOptions, type WordCreatorLogger } from "@/lib/wordCreator";

export type WordCreatorLog = {
  id: string;
  level: "info" | "error";
  source: string | null;
  message: string;
  created_at: string;
};

export type WordCreatorJob = {
  id: string;
  status: "queued" | "running" | "completed" | "failed";
  total: number;
  processed: number;
  generated: number;
  current_source: string | null;
  errors: Array<{ source: string; error: string }>;
  error: string | null;
  logs?: WordCreatorLog[];
};

let schemaPromise: Promise<void> | undefined;

async function ensureJobsSchema() {
  if (!schemaPromise) {
    schemaPromise = (async () => {
      // Keep in sync with db/008_word_creator_jobs.sql.
      await query(`CREATE TABLE IF NOT EXISTS word_creator_jobs (
        id UUID PRIMARY KEY,
        status TEXT NOT NULL DEFAULT 'queued'
          CHECK (status IN ('queued', 'running', 'completed', 'failed')),
        options JSONB NOT NULL,
        total INTEGER NOT NULL DEFAULT 0,
        processed INTEGER NOT NULL DEFAULT 0,
        generated INTEGER NOT NULL DEFAULT 0,
        current_source TEXT,
        errors JSONB NOT NULL DEFAULT '[]',
        error TEXT,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        finished_at TIMESTAMPTZ
      )`);
      await query(`CREATE UNIQUE INDEX IF NOT EXISTS word_creator_one_active_job_idx
        ON word_creator_jobs ((1)) WHERE status IN ('queued', 'running')`);
      await query(`CREATE TABLE IF NOT EXISTS word_creator_job_logs (
        id BIGSERIAL PRIMARY KEY,
        job_id UUID NOT NULL REFERENCES word_creator_jobs(id) ON DELETE CASCADE,
        level TEXT NOT NULL CHECK (level IN ('info', 'error')),
        source TEXT,
        message TEXT NOT NULL,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )`);
      await query(`CREATE INDEX IF NOT EXISTS word_creator_job_logs_job_idx
        ON word_creator_job_logs (job_id, id DESC)`);
    })().catch((error) => { schemaPromise = undefined; throw error; });
  }
  await schemaPromise;
}

const columns = "id, status, total, processed, generated, current_source, errors, error";

export async function enqueueWordCreator(options: WordCreatorOptions, reuseActive = true) {
  await ensureJobsSchema();
  // Return existing active job if a client retries after a lost HTTP response.
  const result = await query<WordCreatorJob>(`INSERT INTO word_creator_jobs (id, options)
    VALUES ($1, $2::jsonb)
    ON CONFLICT ((1)) WHERE status IN ('queued', 'running')
    ${reuseActive ? "DO UPDATE SET updated_at = word_creator_jobs.updated_at" : "DO NOTHING"}
    RETURNING ${columns}`, [randomUUID(), JSON.stringify(options)]);
  if (!result.rows[0]) throw Object.assign(new Error("Kanji worker is busy."), { code: "23505" });
  startWordCreatorWorker();
  return result.rows[0];
}

export async function getWordCreatorJob(id?: string) {
  await ensureJobsSchema();
  const result = id
    ? await query<WordCreatorJob>(`SELECT ${columns} FROM word_creator_jobs WHERE id = $1::uuid`, [id])
    : await query<WordCreatorJob>(`SELECT ${columns} FROM word_creator_jobs ORDER BY created_at DESC LIMIT 1`);
  const job = result.rows[0];
  if (!job) return null;
  const logs = await query<WordCreatorLog>(`SELECT id::text, level, source, message, created_at::text
    FROM word_creator_job_logs WHERE job_id = $1 ORDER BY word_creator_job_logs.id DESC LIMIT 200`, [job.id]);
  return { ...job, logs: logs.rows.reverse() };
}

export async function tickWordCreatorJobs() {
  await ensureJobsSchema();
  const client = await db().connect();
  let locked = false;
  let connectionError: Error | undefined;
  const onError = (error: Error) => { connectionError = error; };
  client.on("error", onError);
  try {
    // Session lock spans the whole batch, including Chromium/FFmpeg awaits.
    // Multiple Next workers cannot render the same HTML at the same time.
    const lock = await client.query<{ locked: boolean }>("SELECT pg_try_advisory_lock(824731, 1) AS locked");
    locked = lock.rows[0].locked;
    if (!locked) return;
    // Owning the lock means no previous worker still owns a running job.
    // Do not silently repeat AI calls/rendering after a server restart.
    const interrupted = await client.query<{ options: WordCreatorOptions; error: string }>(`WITH interrupted AS (UPDATE word_creator_jobs SET status = 'failed',
      error = 'Tạo video bị gián đoạn do worker dừng hoặc server khởi động lại. Hãy tạo lại.',
      current_source = NULL, finished_at = NOW(), updated_at = NOW()
      WHERE status = 'running' RETURNING id, error, options), logged AS (
      INSERT INTO word_creator_job_logs (job_id, level, message)
      SELECT id, 'error', error FROM interrupted RETURNING id)
      SELECT options, error FROM interrupted`);
    for (const previous of interrupted.rows) {
      if (previous.options.pipelineRunId) {
        const { finishKanjiGeneration } = await import("@/lib/pipeline");
        await finishKanjiGeneration(previous.options.pipelineRunId, undefined, previous.error);
      }
    }
    const pending = await client.query<WordCreatorJob & { options: WordCreatorOptions }>(
      `UPDATE word_creator_jobs SET status = 'running', updated_at = NOW()
       WHERE id = (SELECT id FROM word_creator_jobs WHERE status = 'queued' ORDER BY created_at LIMIT 1)
       RETURNING ${columns}, options`,
    );
    const job = pending.rows[0];
    if (!job) return;
    let runLogPath: string | undefined;
    if (job.options.pipelineRunId) {
      const run = (await client.query<{ status: string; log_path: string }>(
        "SELECT status, log_path FROM video_creator_runs WHERE id = $1 AND action = 'create_kanji'", [job.options.pipelineRunId])).rows[0];
      if (!run || run.status !== "running") {
        await client.query(`UPDATE word_creator_jobs SET status = 'failed', error = 'Scheduled run interrupted; not replayed.',
          finished_at = NOW(), updated_at = NOW() WHERE id = $1`, [job.id]);
        return;
      }
      runLogPath = run.log_path;
    }
    const log: WordCreatorLogger = async (message, level = "info", source) => {
      if (connectionError) throw connectionError;
      await client.query(`INSERT INTO word_creator_job_logs (job_id, level, source, message)
        VALUES ($1, $2, $3, $4)`, [job.id, level, source ?? null, message.slice(0, 4000)]);
      if (runLogPath) await fs.appendFile(runLogPath, `[${new Date().toISOString()}] ${level} ${source || ""} ${message}\n`);
    };
    try {
      await log("Worker bắt đầu tạo video.");
      const result = await generateWordCreator(job.options, async (progress) => {
        if (connectionError) throw connectionError;
        await client.query(`UPDATE word_creator_jobs SET total = $2, processed = $3,
          generated = $4, current_source = $5, errors = $6::jsonb, updated_at = NOW()
          WHERE id = $1`,
        [job.id, progress.total, progress.processed, progress.generated,
          progress.currentSource, JSON.stringify(progress.errors)]);
      }, log);
      if (job.options.pipelineRunId && !result.generated) {
        throw new Error(result.errors[0]?.error || "Không còn Kanji chưa tạo. Chọn Force recreate để tạo lại.");
      }
      await log("Tác vụ hoàn tất.");
      await client.query(`UPDATE word_creator_jobs SET status = 'completed',
        current_source = NULL, finished_at = NOW(), updated_at = NOW() WHERE id = $1`, [job.id]);
      if (job.options.pipelineRunId) {
        const { finishKanjiGeneration } = await import("@/lib/pipeline");
        await finishKanjiGeneration(job.options.pipelineRunId, result.results[0]);
      }
    } catch (error) {
      await log(error instanceof Error ? error.message : "Không tạo được WordCreator.", "error");
      await client.query(`UPDATE word_creator_jobs SET status = 'failed', error = $2,
        current_source = NULL, finished_at = NOW(), updated_at = NOW() WHERE id = $1`,
      [job.id, error instanceof Error ? error.message : "Không tạo được WordCreator."]);
      if (job.options.pipelineRunId) {
        const { finishKanjiGeneration } = await import("@/lib/pipeline");
        await finishKanjiGeneration(job.options.pipelineRunId, undefined, error instanceof Error ? error.message : "Kanji render failed.");
      }
    }
  } finally {
    if (locked && !connectionError) {
      await client.query("SELECT pg_advisory_unlock(824731, 1)").catch((error: Error) => { connectionError = error; });
    }
    client.removeListener("error", onError);
    client.release(connectionError);
  }
}

type WorkerState = typeof globalThis & { __wordCreatorWorkerStarted?: boolean };

export function startWordCreatorWorker() {
  const state = globalThis as WorkerState;
  if (state.__wordCreatorWorkerStarted || process.env.NODE_ENV === "test") return;
  state.__wordCreatorWorkerStarted = true;
  let ticking = false;
  const tick = async () => {
    if (ticking) return;
    ticking = true;
    try {
      await tickWordCreatorJobs();
    } catch (error) {
      console.error("WordCreator worker:", error);
    } finally {
      ticking = false;
    }
  };
  // Persistent Node/PM2 worker; never await rendering inside an HTTP request.
  const timer = setInterval(() => { void tick(); }, 2_000);
  timer.unref();
}
