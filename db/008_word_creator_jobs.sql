CREATE TABLE IF NOT EXISTS word_creator_jobs (
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
);

-- One render batch at a time; repeated clicks must not start duplicate work.
CREATE UNIQUE INDEX IF NOT EXISTS word_creator_one_active_job_idx
  ON word_creator_jobs ((1)) WHERE status IN ('queued', 'running');
