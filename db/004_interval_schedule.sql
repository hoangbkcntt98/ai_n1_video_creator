-- Also applied automatically by ensureVideoCreatorSchema.
ALTER TABLE video_creator_runs
  ADD COLUMN IF NOT EXISTS schedule_job_id BIGINT,
  ADD COLUMN IF NOT EXISTS after_run_pending BOOLEAN NOT NULL DEFAULT FALSE;
CREATE UNIQUE INDEX IF NOT EXISTS video_creator_run_schedule_job_idx
  ON video_creator_runs (schedule_job_id) WHERE schedule_job_id IS NOT NULL;

ALTER TABLE video_creator_schedule
  ADD COLUMN IF NOT EXISTS mode TEXT NOT NULL DEFAULT 'daily' CHECK (mode IN ('daily', 'interval')),
  ADD COLUMN IF NOT EXISTS starts_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS interval_hours INTEGER NOT NULL DEFAULT 5 CHECK (interval_hours BETWEEN 1 AND 8760),
  ADD COLUMN IF NOT EXISTS videos_per_run INTEGER NOT NULL DEFAULT 1 CHECK (videos_per_run BETWEEN 1 AND 100),
  ADD COLUMN IF NOT EXISTS revision BIGINT NOT NULL DEFAULT 1,
  ADD COLUMN IF NOT EXISTS last_scheduled_at TIMESTAMPTZ;

CREATE TABLE IF NOT EXISTS video_creator_schedule_jobs (
  id BIGSERIAL PRIMARY KEY,
  schedule_id INTEGER NOT NULL REFERENCES video_creator_schedule(id) ON DELETE CASCADE,
  schedule_revision BIGINT NOT NULL,
  scheduled_for TIMESTAMPTZ NOT NULL,
  position INTEGER NOT NULL,
  settings JSONB NOT NULL,
  cancelled BOOLEAN NOT NULL DEFAULT FALSE,
  UNIQUE (schedule_id, schedule_revision, scheduled_for, position)
);
