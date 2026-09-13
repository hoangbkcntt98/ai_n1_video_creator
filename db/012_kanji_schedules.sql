-- Existing slots 1/2 stay Grammar. Kanji slots 3/4 start unconfigured.
ALTER TABLE video_creator_schedule
  ADD COLUMN IF NOT EXISTS kind TEXT NOT NULL DEFAULT 'grammar',
  ADD COLUMN IF NOT EXISTS kanji_options JSONB NOT NULL DEFAULT '{"durationSeconds":10,"fps":25,"autoFps":true}';
ALTER TABLE video_creator_schedule DROP CONSTRAINT IF EXISTS video_creator_schedule_slot_check;
ALTER TABLE video_creator_schedule ADD CONSTRAINT video_creator_schedule_slot_check CHECK (
  (kind = 'grammar' AND ((id = 1 AND mode = 'daily') OR (id = 2 AND mode = 'interval'))) OR
  (kind = 'kanji' AND ((id = 3 AND mode = 'daily') OR (id = 4 AND mode = 'interval')))
);
ALTER TABLE video_creator_runs DROP CONSTRAINT IF EXISTS video_creator_runs_action_check;
ALTER TABLE video_creator_runs ADD CONSTRAINT video_creator_runs_action_check
  CHECK (action IN ('create_next', 'generate_pattern', 'publish', 'youtube_publish', 'create_kanji'));
