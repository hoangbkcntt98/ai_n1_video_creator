CREATE TABLE IF NOT EXISTS word_creator_job_logs (
  id BIGSERIAL PRIMARY KEY,
  job_id UUID NOT NULL REFERENCES word_creator_jobs(id) ON DELETE CASCADE,
  level TEXT NOT NULL CHECK (level IN ('info', 'error')),
  source TEXT,
  message TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS word_creator_job_logs_job_idx
  ON word_creator_job_logs (job_id, id DESC);
