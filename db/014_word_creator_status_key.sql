ALTER TABLE word_creator_questions
  DROP CONSTRAINT IF EXISTS word_creator_questions_status_key,
  ADD CONSTRAINT word_creator_questions_status_key
    UNIQUE (source, required_vocabulary);
