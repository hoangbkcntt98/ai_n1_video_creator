-- Also applied automatically by ensureVideoCreatorSchema.
ALTER TABLE video_creator_schedule
  ADD COLUMN IF NOT EXISTS publish_to_youtube BOOLEAN NOT NULL DEFAULT FALSE,
  ADD COLUMN IF NOT EXISTS youtube_privacy TEXT NOT NULL DEFAULT 'private',
  ADD COLUMN IF NOT EXISTS youtube_made_for_kids BOOLEAN,
  ADD COLUMN IF NOT EXISTS youtube_contains_synthetic_media BOOLEAN;
ALTER TABLE video_creator_runs ADD COLUMN IF NOT EXISTS after_run_publish JSONB;
