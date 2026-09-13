CREATE TABLE IF NOT EXISTS word_creator_questions (
  id BIGSERIAL PRIMARY KEY,
  anki_note_id BIGINT,
  source TEXT NOT NULL,
  required_vocabulary TEXT NOT NULL,
  answer_a TEXT NOT NULL,
  answer_b TEXT NOT NULL,
  answer_c TEXT NOT NULL,
  answer_d TEXT NOT NULL,
  correct_index SMALLINT NOT NULL CHECK (correct_index BETWEEN 0 AND 3),
  correct_answer TEXT NOT NULL,
  template_path TEXT NOT NULL,
  video_path TEXT,
  duration_seconds NUMERIC,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (source, required_vocabulary)
);
CREATE INDEX IF NOT EXISTS word_creator_questions_source_idx ON word_creator_questions (source);
