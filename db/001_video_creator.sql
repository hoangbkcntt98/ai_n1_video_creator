CREATE TABLE IF NOT EXISTS video_creator_runs (
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
);
CREATE INDEX IF NOT EXISTS video_creator_runs_status_idx ON video_creator_runs (status, started_at DESC);
CREATE TABLE IF NOT EXISTS video_creator_videos (
  relative_path TEXT PRIMARY KEY,
  title TEXT NOT NULL DEFAULT '',
  caption TEXT NOT NULL DEFAULT '',
  facebook_video_id TEXT,
  scheduled_publish_at TIMESTAMPTZ,
  published_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE TABLE IF NOT EXISTS video_creator_schedule (
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
);
INSERT INTO video_creator_schedule (id) VALUES (1) ON CONFLICT (id) DO NOTHING;
CREATE TABLE IF NOT EXISTS video_creator_quota_schedule (
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
);
INSERT INTO video_creator_quota_schedule (id) VALUES (1) ON CONFLICT (id) DO NOTHING;
