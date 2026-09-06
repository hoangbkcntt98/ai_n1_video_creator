-- Existing databases also receive this migration through ensureVideoCreatorSchema.
ALTER TABLE video_creator_runs
  DROP CONSTRAINT IF EXISTS video_creator_runs_action_check,
  ADD CONSTRAINT video_creator_runs_action_check
    CHECK (action IN ('create_next', 'generate_pattern', 'publish', 'youtube_publish'));
ALTER TABLE video_creator_videos
  ADD COLUMN IF NOT EXISTS youtube_video_id TEXT,
  ADD COLUMN IF NOT EXISTS youtube_uploaded_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS youtube_privacy TEXT;
