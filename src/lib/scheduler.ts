import { ensureVideoCreatorSchema, query } from "@/lib/db";
import { startGeneration } from "@/lib/pipeline";
import { startQuotaScheduler } from "@/lib/quotaScheduler";
import { validateYouTubePublishSettings, youtubeConfiguration } from "@/lib/youtube";

export type DailySchedule = {
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
  enabled: boolean;
  mode: DailySchedule["mode"];
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
  youtube_privacy: DailySchedule["youtubePrivacy"];
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

function mapSchedule(row: ScheduleRow): DailySchedule {
  const startsAtUtc = row.starts_at ? new Date(row.starts_at).toISOString() : null;
  const lastRunAt = row.last_scheduled_at ? new Date(row.last_scheduled_at).toISOString() : null;
  const timing = row.enabled && row.mode === "interval" && startsAtUtc
    ? intervalTiming(startsAtUtc, row.interval_hours, lastRunAt) : null;
  return {
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

const scheduleColumns = `enabled, mode, run_time::text, timezone, starts_at::text,
  to_char(starts_at AT TIME ZONE timezone, 'YYYY-MM-DD"T"HH24:MI:SS') AS starts_at_local,
  interval_hours, videos_per_run, revision::text, force_recreate,
  publish_to_facebook, publish_to_youtube, youtube_privacy,
  youtube_made_for_kids, youtube_contains_synthetic_media,
  last_run_date::text, last_scheduled_at::text, last_run_id, last_error, updated_at::text`;

export async function getDailySchedule() {
  await ensureVideoCreatorSchema();
  const result = await query<ScheduleRow>(`SELECT ${scheduleColumns},
    (SELECT COUNT(*) FROM video_creator_schedule_jobs jobs
      WHERE jobs.schedule_id = video_creator_schedule.id AND jobs.schedule_revision = video_creator_schedule.revision
        AND NOT jobs.cancelled AND NOT EXISTS (SELECT 1 FROM video_creator_runs WHERE schedule_job_id = jobs.id)) AS pending_videos
    FROM video_creator_schedule WHERE id = 1`);
  if (!result.rows[0]) throw new Error("Daily schedule is not configured.");
  return mapSchedule(result.rows[0]);
}

export async function updateDailySchedule(input: {
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
  const mode = input.mode === undefined ? "daily" : input.mode;
  if (mode !== "daily" && mode !== "interval") throw new Error("Choose daily or interval schedule mode.");
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
    SELECT 1, $1, $2::time, $3, $4, $5, $6, $7, $8, $9,
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
      mode, interval?.startsAt ?? null, interval?.intervalHours ?? 5, interval?.videosPerRun ?? 1]);
  if (!result.rows[0]) throw new Error("Start time does not exist in the selected timezone (daylight-saving change).");
  return mapSchedule(result.rows[0]);
}

export async function deleteDailySchedule() {
  await ensureVideoCreatorSchema();
  await query(`DELETE FROM video_creator_schedule WHERE id = 1`);
}

function zonedNow(timezone: string, now: Date) {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: timezone, year: "numeric", month: "2-digit", day: "2-digit",
    hour: "2-digit", minute: "2-digit", hourCycle: "h23",
  }).formatToParts(now);
  const values = Object.fromEntries(parts.map((part) => [part.type, part.value]));
  return { date: `${values.year}-${values.month}-${values.day}`, time: `${values.hour}:${values.minute}` };
}

type Job = { id: number; scheduled_for: string; settings: Parameters<typeof startGeneration>[0] };

export async function tickSchedule(now = new Date()) {
  try {
    const schedule = await getDailySchedule();
    if (!schedule.enabled) return;
    // Cover a restart after inserting a scheduled run but before storing its PID.
    // Consume that job as failed rather than launching it a second time.
    await query(`UPDATE video_creator_runs SET status = 'failed',
      error = 'Scheduled worker did not record its PID. Check run log before retrying.',
      finished_at = NOW(), after_run_publish = NULL, after_run_pending = FALSE
      WHERE schedule_job_id IS NOT NULL AND status = 'running' AND runner_pid IS NULL
        AND started_at < NOW() - INTERVAL '10 minutes'`);
    // Do not steal the single worker slot from a pipeline or its pending uploads.
    const busy = await query(`SELECT 1 FROM video_creator_runs
      WHERE status = 'running' OR after_run_pending OR after_run_publish IS NOT NULL LIMIT 1`);
    if (busy.rows.length) return;

    // A failed generation may keep selecting the same grammar pattern. Stop the
    // remaining jobs in that batch; the next timed batch can try again.
    await query(`WITH failed AS (
      SELECT jobs.scheduled_for, runs.id, runs.error FROM video_creator_schedule_jobs jobs
      JOIN video_creator_runs runs ON runs.schedule_job_id = jobs.id
      WHERE jobs.schedule_revision = $1::bigint AND jobs.schedule_id = 1 AND runs.status = 'failed'
    ), cancelled AS (
      UPDATE video_creator_schedule_jobs jobs SET cancelled = TRUE FROM failed
      WHERE jobs.schedule_id = 1 AND jobs.schedule_revision = $1::bigint
        AND jobs.scheduled_for = failed.scheduled_for AND NOT jobs.cancelled
        AND NOT EXISTS (SELECT 1 FROM video_creator_runs WHERE schedule_job_id = jobs.id)
      RETURNING jobs.id
    ) UPDATE video_creator_schedule SET last_error = LEFT(
        'Scheduled generation failed; remaining videos in that batch cancelled. See run #' || failed.id || ': ' || COALESCE(failed.error, ''), 4000)
      FROM failed WHERE video_creator_schedule.id = 1 AND revision = $1::bigint
        AND (last_run_id = failed.id OR
          (last_run_id IS NULL AND last_scheduled_at = failed.scheduled_for))`, [schedule.revision]);

    async function pendingJob() {
      const result = await query<Job>(`SELECT jobs.id, jobs.scheduled_for::text, jobs.settings
        FROM video_creator_schedule_jobs jobs
        WHERE jobs.schedule_id = 1 AND jobs.schedule_revision = $1::bigint AND NOT jobs.cancelled
          AND NOT EXISTS (SELECT 1 FROM video_creator_runs WHERE schedule_job_id = jobs.id)
        ORDER BY jobs.scheduled_for, jobs.position LIMIT 1`, [schedule.revision]);
      return result.rows[0];
    }
    let job = await pendingJob();
    if (!job) {
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
      // Claim occurrence and persist every video in one atomic statement. Revision
      // guards against stale ticks after edit/disable; only one process can claim.
      await query(`WITH claimed AS (
        UPDATE video_creator_schedule SET last_scheduled_at = $2::timestamptz,
          last_run_date = $3::date, last_run_id = NULL, last_error = NULL, updated_at = NOW()
        WHERE id = 1 AND enabled AND revision = $1::bigint
          AND last_scheduled_at IS NOT DISTINCT FROM $4::timestamptz
          AND (mode = 'interval' OR last_run_date IS DISTINCT FROM $3::date)
        RETURNING id, revision, videos_per_run
      ) INSERT INTO video_creator_schedule_jobs (schedule_id, schedule_revision, scheduled_for, position, settings)
        SELECT claimed.id, claimed.revision, $2::timestamptz, position, $5::jsonb
        FROM claimed CROSS JOIN LATERAL generate_series(1, claimed.videos_per_run) AS position`,
      [schedule.revision, due, local.date, schedule.lastRunAt, JSON.stringify(settings)]);
      job = await pendingJob();
    }
    if (!job) return;
    try {
      // The run stores a unique job ID during insertion, before spawning Python.
      // A restart cannot create another run for a job already consumed.
      const run = await startGeneration({ ...job.settings, scheduleJobId: job.id });
      await query(`UPDATE video_creator_schedule SET last_run_id = $1, updated_at = NOW()
        WHERE id = 1 AND revision = $2::bigint`, [run.id, schedule.revision]);
    } catch (error) {
      // Another scheduler/manual request won the worker slot: leave job queued.
      if ((error as { code?: string })?.code === "23505" ||
          (error instanceof Error && error.message === "Scheduled video is no longer pending.")) return;
      const message = error instanceof Error ? error.message : "Scheduled pipeline failed.";
      await query(`UPDATE video_creator_schedule_jobs SET cancelled = TRUE
        WHERE schedule_id = 1 AND schedule_revision = $1::bigint AND scheduled_for = $2::timestamptz`,
      [schedule.revision, job.scheduled_for]);
      await query(`UPDATE video_creator_schedule SET last_error = $1, updated_at = NOW()
        WHERE id = 1 AND revision = $2::bigint`, [message.slice(0, 4000), schedule.revision]);
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
