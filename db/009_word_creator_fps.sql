-- Existing WordCreator renders always passed --fps 30.
ALTER TABLE word_creator_questions
  ADD COLUMN IF NOT EXISTS fps SMALLINT NOT NULL DEFAULT 30 CHECK (fps BETWEEN 1 AND 60);
