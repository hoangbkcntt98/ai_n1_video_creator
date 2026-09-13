ALTER TABLE word_creator_questions
  ADD COLUMN IF NOT EXISTS video_path TEXT,
  ADD COLUMN IF NOT EXISTS duration_seconds NUMERIC;
