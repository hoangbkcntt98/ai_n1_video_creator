import { Pool, type QueryResultRow } from "pg";
import { appConfig } from "@/lib/config";

let pool: Pool | undefined;
let schemaPromise: Promise<void> | undefined;

export function db() {
  if (!pool) pool = new Pool({ connectionString: appConfig.databaseUrl(), max: 5 });
  return pool;
}

export async function query<T extends QueryResultRow>(sql: string, values: unknown[] = []) {
  return db().query<T>(sql, values);
}

export async function ensureVideoCreatorSchema() {
  if (!schemaPromise) {
    schemaPromise = (async () => {
      await query(`CREATE TABLE IF NOT EXISTS video_creator_runs (
        id BIGSERIAL PRIMARY KEY,
        action TEXT NOT NULL CHECK (action IN ('create_next', 'generate_pattern', 'publish')),
        pattern_id BIGINT,
        pattern_name TEXT,
        status TEXT NOT NULL DEFAULT 'running' CHECK (status IN ('running', 'success', 'failed')),
        log_path TEXT NOT NULL,
        runner_pid INTEGER,
        error TEXT,
        started_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        finished_at TIMESTAMPTZ
      )`);
      await query(`CREATE UNIQUE INDEX IF NOT EXISTS video_creator_one_active_run_idx
      ON video_creator_runs ((1)) WHERE status = 'running'`);
     await query(`CREATE INDEX IF NOT EXISTS video_creator_runs_status_idx
       ON video_creator_runs (status, started_at DESC)`);
      await query(`ALTER TABLE video_creator_runs ADD COLUMN IF NOT EXISTS output_video TEXT`);
      await query(`ALTER TABLE video_creator_runs ADD COLUMN IF NOT EXISTS runner_pid INTEGER`);
      await query(`ALTER TABLE video_creator_runs ADD COLUMN IF NOT EXISTS after_run_publish JSONB`);
      await query(`ALTER TABLE video_creator_runs
        ADD COLUMN IF NOT EXISTS schedule_job_id BIGINT,
        ADD COLUMN IF NOT EXISTS after_run_pending BOOLEAN NOT NULL DEFAULT FALSE`);
      await query(`CREATE UNIQUE INDEX IF NOT EXISTS video_creator_run_schedule_job_idx
        ON video_creator_runs (schedule_job_id) WHERE schedule_job_id IS NOT NULL`);
      // Replace the original CHECK so existing installations accept YouTube runs.
      await query(`ALTER TABLE video_creator_runs DROP CONSTRAINT IF EXISTS video_creator_runs_action_check,
        ADD CONSTRAINT video_creator_runs_action_check
        CHECK (action IN ('create_next', 'generate_pattern', 'publish', 'youtube_publish'))`);
     await query(`CREATE TABLE IF NOT EXISTS video_creator_videos (
        relative_path TEXT PRIMARY KEY,
        title TEXT NOT NULL DEFAULT '',
        caption TEXT NOT NULL DEFAULT '',
        facebook_video_id TEXT,
        scheduled_publish_at TIMESTAMPTZ,
        published_at TIMESTAMPTZ,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )`);
      await query(`ALTER TABLE video_creator_videos ADD COLUMN IF NOT EXISTS scheduled_publish_at TIMESTAMPTZ`);
      await query(`ALTER TABLE video_creator_videos
        ADD COLUMN IF NOT EXISTS youtube_video_id TEXT,
        ADD COLUMN IF NOT EXISTS youtube_uploaded_at TIMESTAMPTZ,
        ADD COLUMN IF NOT EXISTS youtube_privacy TEXT`);
      await query(`CREATE TABLE IF NOT EXISTS video_creator_schedule (
        id INTEGER PRIMARY KEY DEFAULT 1 CHECK (id = 1),
        enabled BOOLEAN NOT NULL DEFAULT FALSE,
        run_time TIME NOT NULL DEFAULT '09:00',
        timezone TEXT NOT NULL DEFAULT 'UTC',
        force_recreate BOOLEAN NOT NULL DEFAULT FALSE,
        publish_to_facebook BOOLEAN NOT NULL DEFAULT FALSE,
        last_run_date DATE,
        last_run_id BIGINT,
        last_error TEXT,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )`);
      await query(`ALTER TABLE video_creator_schedule ADD COLUMN IF NOT EXISTS publish_to_facebook BOOLEAN NOT NULL DEFAULT FALSE`);
      await query(`ALTER TABLE video_creator_schedule
        ADD COLUMN IF NOT EXISTS publish_to_youtube BOOLEAN NOT NULL DEFAULT FALSE,
        ADD COLUMN IF NOT EXISTS youtube_privacy TEXT NOT NULL DEFAULT 'private',
        ADD COLUMN IF NOT EXISTS youtube_made_for_kids BOOLEAN,
        ADD COLUMN IF NOT EXISTS youtube_contains_synthetic_media BOOLEAN`);
      await query(`ALTER TABLE video_creator_schedule
        ADD COLUMN IF NOT EXISTS mode TEXT NOT NULL DEFAULT 'daily' CHECK (mode IN ('daily', 'interval')),
        ADD COLUMN IF NOT EXISTS starts_at TIMESTAMPTZ,
        ADD COLUMN IF NOT EXISTS interval_hours INTEGER NOT NULL DEFAULT 5 CHECK (interval_hours BETWEEN 1 AND 8760),
        ADD COLUMN IF NOT EXISTS videos_per_run INTEGER NOT NULL DEFAULT 1 CHECK (videos_per_run BETWEEN 1 AND 100),
        ADD COLUMN IF NOT EXISTS revision BIGINT NOT NULL DEFAULT 1,
        ADD COLUMN IF NOT EXISTS last_scheduled_at TIMESTAMPTZ`);
      await query(`CREATE TABLE IF NOT EXISTS video_creator_schedule_jobs (
        id BIGSERIAL PRIMARY KEY,
        schedule_id INTEGER NOT NULL REFERENCES video_creator_schedule(id) ON DELETE CASCADE,
        schedule_revision BIGINT NOT NULL,
        scheduled_for TIMESTAMPTZ NOT NULL,
        position INTEGER NOT NULL,
        settings JSONB NOT NULL,
        cancelled BOOLEAN NOT NULL DEFAULT FALSE,
        UNIQUE (schedule_id, schedule_revision, scheduled_for, position)
      )`);
      await query(`CREATE TABLE IF NOT EXISTS video_creator_quota_schedule (
        id INTEGER PRIMARY KEY DEFAULT 1 CHECK (id = 1),
        enabled BOOLEAN NOT NULL DEFAULT FALSE,
        run_day SMALLINT NOT NULL DEFAULT 0 CHECK (run_day BETWEEN 0 AND 6),
        run_time TIME NOT NULL DEFAULT '00:00',
        timezone TEXT NOT NULL DEFAULT 'UTC',
        threshold_percent NUMERIC NOT NULL DEFAULT 10,
        cycle_active BOOLEAN NOT NULL DEFAULT FALSE,
        last_trigger_date DATE,
        active_run_id BIGINT,
        last_quota_percent NUMERIC,
        last_error TEXT,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )`);
      await query(`ALTER TABLE video_creator_quota_schedule ADD COLUMN IF NOT EXISTS run_day SMALLINT NOT NULL DEFAULT 0`);
      await query(`ALTER TABLE video_creator_quota_schedule ADD COLUMN IF NOT EXISTS threshold_percent NUMERIC NOT NULL DEFAULT 10`);
      await query(`ALTER TABLE video_creator_quota_schedule ADD COLUMN IF NOT EXISTS cycle_active BOOLEAN NOT NULL DEFAULT FALSE`);
      await query(`ALTER TABLE video_creator_quota_schedule ADD COLUMN IF NOT EXISTS last_trigger_date DATE`);
      await query(`ALTER TABLE video_creator_quota_schedule ADD COLUMN IF NOT EXISTS active_run_id BIGINT`);
      await query(`ALTER TABLE video_creator_quota_schedule ADD COLUMN IF NOT EXISTS last_quota_percent NUMERIC`);
      await query(`ALTER TABLE video_creator_quota_schedule ADD COLUMN IF NOT EXISTS last_error TEXT`);
    })().catch((error) => { schemaPromise = undefined; throw error; });
  }
  return schemaPromise;
}

export function processAlive(pid: number) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

/**
 * Build/restart can terminate Next while Python pipeline keeps running or
 * before its PID is persisted. Clear only abandoned rows, never live workers.
 */
export async function recoverAbandonedRuns() {
  await ensureVideoCreatorSchema();
  const active = await query<{ id: number; runner_pid: number | null; started_at: string }>(
    `SELECT id, runner_pid, started_at::text FROM video_creator_runs WHERE status = 'running'`,
  );
  for (const run of active.rows) {
    const stale = run.runner_pid === null
      ? Date.now() - Date.parse(run.started_at) > 10 * 60 * 1000
      : !processAlive(run.runner_pid);
    if (stale) {
      await query(
        `UPDATE video_creator_runs
         SET status = 'failed',
             error = COALESCE(error, 'Pipeline interrupted by application restart.'),
             finished_at = COALESCE(finished_at, NOW()),
             runner_pid = NULL
         WHERE id = $1 AND status = 'running'`,
        [run.id],
      );
    }
  }
}
