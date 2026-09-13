ALTER TABLE word_creator_questions
  ADD COLUMN IF NOT EXISTS status TEXT
    CHECK (status IN ('queued', 'video_generated', 'publish_facebook_ok', 'publish_youtube_ok', 'failed')),
  ADD COLUMN IF NOT EXISTS last_error TEXT;
CREATE INDEX IF NOT EXISTS word_creator_questions_status_idx
  ON word_creator_questions (status, updated_at DESC)
  WHERE status IS NULL OR status = 'queued' OR status = 'video_generated';
