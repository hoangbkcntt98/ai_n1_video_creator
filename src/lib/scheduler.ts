import { ensureVideoCreatorSchema, query } from "@/lib/db";
import { startGeneration } from "@/lib/pipeline";
import { startQuotaScheduler } from "@/lib/quotaScheduler";
import { validateYouTubePublishSettings, youtubeConfiguration } from "@/lib/youtube";

export type PipelineSchedule = {
  id: number;
  enabled: boolean;
  mode: "daily" | "interval";
  runTime: string;
  timezone: string;
  startsAt: string | null;
  startsAtUtc: string | null;
  intervalHours: number;
  videosPerRun: number;
  nextRunAt: string | null;
  pendingVideos: number;
  forceRecreate: boolean;
  publishToFacebook: boolean;
  publishToYouTube: boolean;
  youtubePrivacy: "private" | "unlisted" | "public";
  youtubeMadeForKids: boolean | null;
  youtubeContainsSyntheticMedia: boolean | null;
  lastRunDate: string | null;
  lastRunAt: string | null;
  lastRunId: number | null;
  lastError: string | null;
  revision: string;
  updatedAt: string;
};

type ScheduleRow = {
  id: number;
  enabled: boolean;
  mode: PipelineSchedule["mode"];
  run_time: string;
  timezone: string;
  starts_at: string | null;
  starts_at_local: string | null;
  interval_hours: number;
  videos_per_run: number;
  pending_videos?: string | number;
  force_recreate: boolean;
  publish_to_facebook: boolean;
  publish_to_youtube: boolean;
  youtube_privacy: PipelineSchedule["youtubePrivacy"];
  youtube_made_for_kids: boolean | null;
  youtube_contains_synthetic_media: boolean | null;
  last_run_date: string | null;
  last_scheduled_at: string | null;
  last_run_id: number | null;
  last_error: string | null;
  revision: string;
  updated_at: string;
};

// Absolute elapsed hours, anchored to the original start (not completion time).
// After downtime, only the latest due occurrence is eligible; no catch-up storm.
export function intervalTiming(start: string, hours: number, last: string | null, now = new Date()) {
  const anchor = Date.parse(start);
  const interval = hours * 3_600_000;
  const current = now.getTime();
  const latest = anchor + Math.floor((current - anchor) / interval) * interval;
  const previous = last ? Date.parse(last) : -Infinity;
  const due = current >= anchor && latest > previous ? new Date(latest).toISOString() : null;
  const next = current < anchor ? anchor : Math.max(latest, previous) + interval;
  return { due, next: new Date(next).toISOString() };
}

function mapSchedule(row: ScheduleRow): PipelineSchedule {
  const startsAtUtc = row.starts_at ? new Date(row.starts_at).toISOString() : null;
  const lastRunAt = row.last_scheduled_at ? new Date(row.last_scheduled_at).toISOString() : null;
  const timing = row.enabled && row.mode === "interval" && startsAtUtc
    ? intervalTiming(startsAtUtc, row.interval_hours, lastRunAt) : null;
  return {
    id: row.id,
    enabled: row.enabled,
    mode: row.mode ?? "daily",
    runTime: row.run_time.slice(0, 5),
    timezone: row.timezone,
    startsAt: row.starts_at_local ?? null,
    startsAtUtc,
    intervalHours: row.interval_hours ?? 5,
    videosPerRun: row.videos_per_run ?? 1,
    nextRunAt: timing ? timing.due ?? timing.next : null,
    pendingVideos: Number(row.pending_videos ?? 0),
    forceRecreate: row.force_recreate,
    publishToFacebook: row.publish_to_facebook,
    publishToYouTube: row.publish_to_youtube,
    youtubePrivacy: row.youtube_privacy,
    youtubeMadeForKids: row.youtube_made_for_kids,
    youtubeContainsSyntheticMedia: row.youtube_contains_synthetic_media,
    lastRunDate: row.last_run_date,
    lastRunAt,
    lastRunId: row.last_run_id,
    lastError: row.last_error,
    revision: row.revision,
    updatedAt: row.updated_at,
  };
}

function validateTime(value: string) {
  if (!/^(?:[01]\d|2[0-3]):[0-5]\d$/.test(value)) throw new Error("Run time must use HH:mm format.");
  return value;
}

export function validateTimezone(value: string) {
  const timezone = value.trim();
  if (!timezone || timezone.length > 100) throw new Error("Choose a valid timezone.");
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: timezone }).format();
  } catch {
    throw new Error("Choose a valid timezone.");
  }
  return timezone;
}

export function validateIntervalSettings(input: { startsAt?: unknown; intervalHours?: unknown; videosPerRun?: unknown }) {
  const { startsAt, intervalHours, videosPerRun } = input;
  if (typeof startsAt !== "string" || !/^\d{4}-\d{2}-\d{2}T(?:[01]\d|2[0-3]):[0-5]\d(?::[0-5]\d)?$/.test(startsAt)) {
    throw new Error("Choose a start date and time (YYYY-MM-DDTHH:mm:ss) in the selected timezone.");
  }
  const normalized = startsAt.length === 16 ? `${startsAt}:00` : startsAt;
  const date = new Date(`${normalized}Z`);
  if (!Number.isFinite(date.getTime()) || date.toISOString().slice(0, 19) !== normalized || date.getUTCFullYear() < 1970) {
    throw new Error("Choose a valid start date and time, from year 1970 onward.");
  }
  if (typeof intervalHours !== "number" || !Number.isInteger(intervalHours) || intervalHours < 1 || intervalHours > 8760) {
    throw new Error("Interval must be a whole number of hours between 1 and 8760.");
  }
  if (typeof videosPerRun !== "number" || !Number.isInteger(videosPerRun) || videosPerRun < 1 || videosPerRun > 100) {
    throw new Error("Videos per batch must be a whole number between 1 and 100.");
  }
  return { startsAt: normalized, intervalHours, videosPerRun };
}

const scheduleColumns = `id, enabled, mode, run_time::text, timezone, starts_at::text,
  to_char(starts_at AT TIME ZONE timezone, 'YYYY-MM-DD"T"HH24:MI:SS') AS starts_at_local,
  interval_hours, videos_per_run, revision::text, force_recreate,
  publish_to_facebook, publish_to_youtube, youtube_privacy,
  youtube_made_for_kids, youtube_contains_synthetic_media,
  last_run_date::text, last_scheduled_at::text, last_run_id, last_error, updated_at::text`;

export function validateScheduleMode(mode: unknown): PipelineSchedule["mode"] {
  if (mode !== "daily" && mode !== "interval") throw new Error("Choose daily or interval schedule mode.");
  return mode;
}

function scheduleId(mode: unknown) {
  return validateScheduleMode(mode) === "daily" ? 1 : 2;
}

export async function getPipelineSchedule(mode: PipelineSchedule["mode"] = "daily") {
  const id = scheduleId(mode);
  await ensureVideoCreatorSchema();
  const result = await query<ScheduleRow>(`SELECT ${scheduleColumns},
    (SELECT COUNT(*) FROM video_creator_schedule_jobs jobs
      WHERE jobs.schedule_id = video_creator_schedule.id AND jobs.schedule_revision = video_creator_schedule.revision
        AND NOT jobs.cancelled AND NOT EXISTS (SELECT 1 FROM video_creator_runs WHERE schedule_job_id = jobs.id)) AS pending_videos
    FROM video_creator_schedule WHERE id = $1`, [id]);
  if (!result.rows[0]) throw new Error(`${mode === "daily" ? "Daily" : "Interval"} schedule is not configured.`);
  return mapSchedule(result.rows[0]);
}

export async function updatePipelineSchedule(input: {
  enabled: boolean;
  mode?: unknown;
  startsAt?: unknown;
  intervalHours?: unknown;
  videosPerRun?: unknown;
  runTime: string;
  timezone: string;
  forceRecreate: boolean;
  publishToFacebook: boolean;
  publishToYouTube?: boolean;
  youtubePrivacy?: unknown;
  youtubeMadeForKids?: unknown;
  youtubeContainsSyntheticMedia?: unknown;
}) {
  const mode = validateScheduleMode(input.mode === undefined ? "daily" : input.mode);
  const runTime = validateTime(input.runTime);
  const timezone = validateTimezone(input.timezone);
  const interval = mode === "interval" ? validateIntervalSettings(input) : null;
  const youtube = input.publishToYouTube ? validateYouTubePublishSettings({
    privacy: input.youtubePrivacy,
    madeForKids: input.youtubeMadeForKids,
    containsSyntheticMedia: input.youtubeContainsSyntheticMedia,
  }) : null;
  if (input.enabled && youtube && !youtubeConfiguration().configured) {
    throw new Error("Configure YouTube OAuth credentials in .env.local before enabling automatic uploads.");
  }
  await ensureVideoCreatorSchema();
  // Round-trip rejects non-existent local times during a daylight-saving jump.
  // PostgreSQL chooses the standard-time occurrence for an ambiguous fall-back time.
  const result = await query<ScheduleRow>(`INSERT INTO video_creator_schedule
    (id, enabled, run_time, timezone, force_recreate, publish_to_facebook,
      publish_to_youtube, youtube_privacy, youtube_made_for_kids, youtube_contains_synthetic_media,
      mode, starts_at, interval_hours, videos_per_run, last_error, updated_at)
    SELECT $14, $1, $2::time, $3, $4, $5, $6, $7, $8, $9,
      $10, $11::timestamp AT TIME ZONE $3, $12, $13, NULL, NOW()
    WHERE $11::timestamp IS NULL OR
      (($11::timestamp AT TIME ZONE $3) AT TIME ZONE $3) = $11::timestamp
    ON CONFLICT (id) DO UPDATE SET
      enabled = EXCLUDED.enabled, run_time = EXCLUDED.run_time, timezone = EXCLUDED.timezone,
      force_recreate = EXCLUDED.force_recreate, publish_to_facebook = EXCLUDED.publish_to_facebook,
      publish_to_youtube = EXCLUDED.publish_to_youtube, youtube_privacy = EXCLUDED.youtube_privacy,
      youtube_made_for_kids = EXCLUDED.youtube_made_for_kids,
      youtube_contains_synthetic_media = EXCLUDED.youtube_contains_synthetic_media,
      mode = EXCLUDED.mode, starts_at = EXCLUDED.starts_at,
      interval_hours = EXCLUDED.interval_hours, videos_per_run = EXCLUDED.videos_per_run,
      revision = video_creator_schedule.revision + 1,
      last_scheduled_at = CASE WHEN
        (video_creator_schedule.mode, video_creator_schedule.starts_at, video_creator_schedule.interval_hours)
          IS DISTINCT FROM (EXCLUDED.mode, EXCLUDED.starts_at, EXCLUDED.interval_hours)
        THEN NULL ELSE video_creator_schedule.last_scheduled_at END,
      last_run_date = CASE WHEN
        (video_creator_schedule.mode, video_creator_schedule.run_time, video_creator_schedule.timezone)
          IS DISTINCT FROM (EXCLUDED.mode, EXCLUDED.run_time, EXCLUDED.timezone)
        THEN NULL ELSE video_creator_schedule.last_run_date END,
      last_error = NULL, updated_at = NOW()
    RETURNING ${scheduleColumns}`,
    [input.enabled, runTime, timezone, input.forceRecreate, input.publishToFacebook,
      Boolean(youtube), youtube?.privacy ?? "private", youtube?.madeForKids ?? null, youtube?.containsSyntheticMedia ?? null,
      mode, interval?.startsAt ?? null, interval?.intervalHours ?? 5, interval?.videosPerRun ?? 1, scheduleId(mode)]);
  if (!result.rows[0]) throw new Error("Start time does not exist in the selected timezone (daylight-saving change).");
  return mapSchedule(result.rows[0]);
}

export async function deletePipelineSchedule(mode: PipelineSchedule["mode"] = "daily") {
  const id = scheduleId(mode);
  await ensureVideoCreatorSchema();
  await query(`DELETE FROM video_creator_schedule WHERE id = $1`, [id]);
}

function zonedNow(timezone: string, now: Date) {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: timezone, year: "numeric", month: "2-digit", day: "2-digit",
    hour: "2-digit", minute: "2-digit", hourCycle: "h23",
  }).formatToParts(now);
  const values = Object.fromEntries(parts.map((part) => [part.type, part.value]));
  return { date: `${values.year}-${values.month}-${values.day}`, time: `${values.hour}:${values.minute}` };
}

type Job = {
  id: number;
  schedule_id: number;
  schedule_revision: string;
  scheduled_for: string;
  settings: Parameters<typeof startGeneration>[0];
};

async function prepareSchedule(schedule: PipelineSchedule, now: Date) {
  // Fail only this schedule's batch, even when both slots share a revision/time.
  await query(`WITH failed AS (
    SELECT jobs.scheduled_for, runs.id, runs.error FROM video_creator_schedule_jobs jobs
    JOIN video_creator_runs runs ON runs.schedule_job_id = jobs.id
    WHERE jobs.schedule_revision = $1::bigint AND jobs.schedule_id = $2 AND runs.status = 'failed'
  ), cancelled AS (
    UPDATE video_creator_schedule_jobs jobs SET cancelled = TRUE FROM failed
    WHERE jobs.schedule_id = $2 AND jobs.schedule_revision = $1::bigint
      AND jobs.scheduled_for = failed.scheduled_for AND NOT jobs.cancelled
      AND NOT EXISTS (SELECT 1 FROM video_creator_runs WHERE schedule_job_id = jobs.id)
    RETURNING jobs.id
  ) UPDATE video_creator_schedule SET last_error = LEFT(
      'Scheduled generation failed; remaining videos in that batch cancelled. See run #' || failed.id || ': ' || COALESCE(failed.error, ''), 4000)
    FROM failed WHERE video_creator_schedule.id = $2 AND revision = $1::bigint
      AND last_run_id = failed.id`, [schedule.revision, schedule.id]);

  const pending = await query(`SELECT 1 FROM video_creator_schedule_jobs jobs
    WHERE jobs.schedule_id = $1 AND jobs.schedule_revision = $2::bigint AND NOT jobs.cancelled
      AND NOT EXISTS (SELECT 1 FROM video_creator_runs WHERE schedule_job_id = jobs.id) LIMIT 1`,
  [schedule.id, schedule.revision]);
  if (pending.rows.length) return;
  const local = zonedNow(schedule.timezone, now);
  const due = schedule.mode === "interval"
    ? (schedule.startsAtUtc ? intervalTiming(schedule.startsAtUtc, schedule.intervalHours, schedule.lastRunAt, now).due : null)
    : local.time >= schedule.runTime && schedule.lastRunDate !== local.date ? now.toISOString() : null;
  if (!due) return;
  const settings = {
    forceRecreate: schedule.forceRecreate,
    publishToFacebook: schedule.publishToFacebook,
    youtube: schedule.publishToYouTube ? validateYouTubePublishSettings({
      privacy: schedule.youtubePrivacy, madeForKids: schedule.youtubeMadeForKids,
      containsSyntheticMedia: schedule.youtubeContainsSyntheticMedia,
    }) : undefined,
  };
  // Both schedules can queue while the shared worker is busy. Keep last_run_id
  // until dispatch so an in-flight upload still reports errors to its schedule.
  // Revision + previous occurrence guards make claiming atomic across processes.
  await query(`WITH claimed AS (
    UPDATE video_creator_schedule SET last_scheduled_at = $2::timestamptz,
      last_run_date = $3::date, last_error = NULL, updated_at = NOW()
    WHERE id = $6 AND enabled AND revision = $1::bigint
      AND last_scheduled_at IS NOT DISTINCT FROM $4::timestamptz
      AND (mode = 'interval' OR last_run_date IS DISTINCT FROM $3::date)
    RETURNING id, revision, videos_per_run
  ) INSERT INTO video_creator_schedule_jobs (schedule_id, schedule_revision, scheduled_for, position, settings)
    SELECT claimed.id, claimed.revision, $2::timestamptz, position, $5::jsonb
    FROM claimed CROSS JOIN LATERAL generate_series(1, claimed.videos_per_run) AS position`,
  [schedule.revision, due, local.date, schedule.lastRunAt, JSON.stringify(settings), schedule.id]);
}

export async function tickSchedule(now = new Date()) {
  try {
    await ensureVideoCreatorSchema();
    // Cover a restart after inserting a scheduled run but before storing its PID.
    // Consume that job as failed rather than launching it a second time.
    await query(`UPDATE video_creator_runs SET status = 'failed',
      error = 'Scheduled worker did not record its PID. Check run log before retrying.',
      finished_at = NOW(), after_run_publish = NULL, after_run_pending = FALSE
      WHERE schedule_job_id IS NOT NULL AND status = 'running' AND runner_pid IS NULL
        AND started_at < NOW() - INTERVAL '10 minutes'`);
    const schedules = await query<ScheduleRow>(`SELECT ${scheduleColumns}
      FROM video_creator_schedule WHERE enabled ORDER BY id`);
    for (const row of schedules.rows) {
      try {
        await prepareSchedule(mapSchedule(row), now);
      } catch (error) {
        // Invalid settings in one slot must not stop the other from queuing.
        const message = error instanceof Error ? error.message : "Could not prepare scheduled batch.";
        await query(`UPDATE video_creator_schedule SET last_error = $1, updated_at = NOW()
          WHERE id = $2 AND revision = $3::bigint`, [message.slice(0, 4000), row.id, row.revision]).catch(() => {});
      }
    }
    // Global worker/upload barrier is checked AFTER preparing both queues.
    const busy = await query(`SELECT 1 FROM video_creator_runs
      WHERE status = 'running' OR after_run_pending OR after_run_publish IS NOT NULL LIMIT 1`);
    if (busy.rows.length) return;
    const pending = await query<Job>(`SELECT jobs.id, jobs.schedule_id, jobs.schedule_revision::text,
        jobs.scheduled_for::text, jobs.settings
      FROM video_creator_schedule_jobs jobs
      JOIN video_creator_schedule schedule ON schedule.id = jobs.schedule_id
        AND schedule.revision = jobs.schedule_revision AND schedule.enabled
      WHERE NOT jobs.cancelled
        AND NOT EXISTS (SELECT 1 FROM video_creator_runs WHERE schedule_job_id = jobs.id)
      ORDER BY jobs.scheduled_for, jobs.id LIMIT 1`);
    const job = pending.rows[0];
    if (!job) return;
    try {
      // Unique job ID is stored before spawning Python; restart cannot replay it.
      const run = await startGeneration({ ...job.settings, scheduleJobId: job.id });
      await query(`UPDATE video_creator_schedule SET last_run_id = $1, updated_at = NOW()
        WHERE id = $3 AND revision = $2::bigint`, [run.id, job.schedule_revision, job.schedule_id]);
    } catch (error) {
      // Another scheduler/manual request won the worker slot: leave job queued.
      if ((error as { code?: string })?.code === "23505" ||
          (error instanceof Error && error.message === "Scheduled video is no longer pending.")) return;
      const message = error instanceof Error ? error.message : "Scheduled pipeline failed.";
      await query(`UPDATE video_creator_schedule_jobs SET cancelled = TRUE
        WHERE schedule_id = $3 AND schedule_revision = $1::bigint AND scheduled_for = $2::timestamptz`,
      [job.schedule_revision, job.scheduled_for, job.schedule_id]);
      await query(`UPDATE video_creator_schedule SET last_error = $1, updated_at = NOW()
        WHERE id = $3 AND revision = $2::bigint`, [message.slice(0, 4000), job.schedule_revision, job.schedule_id]);
    }
  } catch {
    // Database/preflight failures retry on next tick, never crash the web process.
  }
}

type SchedulerGlobal = typeof globalThis & { __videoCreatorScheduler?: boolean };

export function startScheduler() {
  const state = globalThis as SchedulerGlobal;
  if (state.__videoCreatorScheduler || process.env.NODE_ENV === "test") return;
  state.__videoCreatorScheduler = true;
  let ticking = false;
  const tick = async () => {
    if (ticking) return;
    ticking = true;
    try { await tickSchedule(); } finally { ticking = false; }
  };
  const timer = setInterval(() => { void tick(); }, 10_000);
  timer.unref();
  const initial = setTimeout(() => { void tick(); }, 2_000);
  initial.unref();
  startQuotaScheduler();
}
