-- Also applied automatically by ensureVideoCreatorSchema.
-- Stable slots: daily = 1, interval = 2. Preserve existing interval jobs/history.
DO $$
BEGIN
  LOCK TABLE video_creator_schedule, video_creator_schedule_jobs IN ACCESS EXCLUSIVE MODE;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conrelid = 'video_creator_schedule'::regclass
      AND conname = 'video_creator_schedule_slot_check'
  ) THEN
    ALTER TABLE video_creator_schedule DROP CONSTRAINT IF EXISTS video_creator_schedule_id_check;
    ALTER TABLE video_creator_schedule_jobs
      DROP CONSTRAINT video_creator_schedule_jobs_schedule_id_fkey,
      ADD CONSTRAINT video_creator_schedule_jobs_schedule_id_fkey
        FOREIGN KEY (schedule_id) REFERENCES video_creator_schedule(id) ON UPDATE CASCADE ON DELETE CASCADE;
    UPDATE video_creator_schedule SET id = 2 WHERE id = 1 AND mode = 'interval';
    ALTER TABLE video_creator_schedule ADD CONSTRAINT video_creator_schedule_slot_check
      CHECK ((id = 1 AND mode = 'daily') OR (id = 2 AND mode = 'interval'));
  END IF;
END $$;
