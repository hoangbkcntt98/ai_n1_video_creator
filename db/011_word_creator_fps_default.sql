-- Preserve FPS of existing videos; only new rows without an explicit FPS use 25.
ALTER TABLE word_creator_questions ALTER COLUMN fps SET DEFAULT 25;
