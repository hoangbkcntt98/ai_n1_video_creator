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
        error TEXT,
        started_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        finished_at TIMESTAMPTZ
      )`);
      await query(`CREATE UNIQUE INDEX IF NOT EXISTS video_creator_one_active_run_idx
        ON video_creator_runs ((1)) WHERE status = 'running'`);
      await query(`CREATE INDEX IF NOT EXISTS video_creator_runs_status_idx
        ON video_creator_runs (status, started_at DESC)`);
      await query(`CREATE TABLE IF NOT EXISTS video_creator_videos (
        relative_path TEXT PRIMARY KEY,
        title TEXT NOT NULL DEFAULT '',
        caption TEXT NOT NULL DEFAULT '',
        facebook_video_id TEXT,
        published_at TIMESTAMPTZ,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )`);
    })().catch((error) => { schemaPromise = undefined; throw error; });
  }
  return schemaPromise;
}
