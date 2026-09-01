CREATE TABLE IF NOT EXISTS video_creator_runs (
  id BIGSERIAL PRIMARY KEY,
  action TEXT NOT NULL CHECK (action IN ('create_next', 'generate_pattern', 'publish')),
  pattern_id BIGINT,
  pattern_name TEXT,
  status TEXT NOT NULL DEFAULT 'running' CHECK (status IN ('running', 'success', 'failed')),
  log_path TEXT NOT NULL,
  error TEXT,
  started_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  finished_at TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS video_creator_runs_status_idx ON video_creator_runs (status, started_at DESC);
CREATE TABLE IF NOT EXISTS video_creator_videos (
  relative_path TEXT PRIMARY KEY,
  title TEXT NOT NULL DEFAULT '',
  caption TEXT NOT NULL DEFAULT '',
  facebook_video_id TEXT,
  published_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
