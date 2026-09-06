import { ensureVideoCreatorSchema, query } from "@/lib/db";
import { startGeneration } from "@/lib/pipeline";

export type DailySchedule = {
  enabled: boolean;
  runTime: string;
  timezone: string;
  forceRecreate: boolean;
  publishToFacebook: boolean;
  lastRunDate: string | null;
  lastRunId: number | null;
  lastError: string | null;
  updatedAt: string;
};

type ScheduleRow = {
  enabled: boolean;
  run_time: string;
  timezone: string;
  force_recreate: boolean;
  publish_to_facebook: boolean;
  last_run_date: string | null;
  last_run_id: number | null;
  last_error: string | null;
  updated_at: string;
};

function mapSchedule(row: ScheduleRow): DailySchedule {
  return {
    enabled: row.enabled,
    runTime: row.run_time.slice(0, 5),
    timezone: row.timezone,
    forceRecreate: row.force_recreate,
    publishToFacebook: row.publish_to_facebook,
    lastRunDate: row.last_run_date,
    lastRunId: row.last_run_id,
    lastError: row.last_error,
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

export async function getDailySchedule() {
  await ensureVideoCreatorSchema();
  const result = await query<ScheduleRow>(`SELECT enabled, run_time::text, timezone, force_recreate,
    publish_to_facebook,
    last_run_date::text, last_run_id, last_error, updated_at::text
    FROM video_creator_schedule WHERE id = 1`);
  if (!result.rows[0]) throw new Error("Daily schedule is not configured.");
  return mapSchedule(result.rows[0]);
}

export async function updateDailySchedule(input: {
  enabled: boolean;
  runTime: string;
  timezone: string;
  forceRecreate: boolean;
  publishToFacebook: boolean;
}) {
  const runTime = validateTime(input.runTime);
  const timezone = validateTimezone(input.timezone);
  await ensureVideoCreatorSchema();
  const result = await query<ScheduleRow>(`INSERT INTO video_creator_schedule
    (id, enabled, run_time, timezone, force_recreate, publish_to_facebook, last_error, updated_at)
    VALUES (1, $1, $2::time, $3, $4, $5, NULL, NOW())
    ON CONFLICT (id) DO UPDATE SET
      enabled = EXCLUDED.enabled, run_time = EXCLUDED.run_time, timezone = EXCLUDED.timezone,
      force_recreate = EXCLUDED.force_recreate, publish_to_facebook = EXCLUDED.publish_to_facebook,
      last_error = NULL, updated_at = NOW()
    RETURNING enabled, run_time::text, timezone, force_recreate,
      publish_to_facebook,
      last_run_date::text, last_run_id, last_error, updated_at::text`,
    [input.enabled, runTime, timezone, input.forceRecreate, input.publishToFacebook]);
  if (!result.rows[0]) throw new Error("Daily schedule is not configured.");
  return mapSchedule(result.rows[0]);
}

export async function deleteDailySchedule() {
  await ensureVideoCreatorSchema();
  await query(`DELETE FROM video_creator_schedule WHERE id = 1`);
}

function zonedNow(timezone: string, now = new Date()) {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: timezone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).formatToParts(now);
  const values = Object.fromEntries(parts.map((part) => [part.type, part.value]));
  return {
    date: `${values.year}-${values.month}-${values.day}`,
    time: `${values.hour}:${values.minute}`,
  };
}

async function tick() {
  try {
    const schedule = await getDailySchedule();
    if (!schedule.enabled) return;
    const now = zonedNow(schedule.timezone);
    if (now.time < schedule.runTime || schedule.lastRunDate === now.date) return;

    const claimed = await query(`UPDATE video_creator_schedule
      SET last_run_date = $1::date, last_run_id = NULL, last_error = NULL, updated_at = NOW()
      WHERE id = 1 AND enabled = TRUE
        AND (last_run_date IS NULL OR last_run_date <> $1::date)`,
      [now.date]);
    if (claimed.rowCount !== 1) return;

    try {
      const run = await startGeneration({
        forceRecreate: schedule.forceRecreate,
        publishToFacebook: schedule.publishToFacebook,
      });
      await query(`UPDATE video_creator_schedule SET last_run_id = $1, updated_at = NOW() WHERE id = 1`, [run.id]);
    } catch (error) {
      const message = error instanceof Error ? error.message : "Scheduled pipeline failed.";
      await query(`UPDATE video_creator_schedule SET last_error = $1, updated_at = NOW() WHERE id = 1`, [message.slice(0, 4000)]);
    }
  } catch {
    // Scheduler retries on next tick. Do not crash web process.
  }
}

type SchedulerGlobal = typeof globalThis & { __videoCreatorScheduler?: boolean };

export function startScheduler() {
  const state = globalThis as SchedulerGlobal;
  if (state.__videoCreatorScheduler || process.env.NODE_ENV === "test") return;
  state.__videoCreatorScheduler = true;
  const timer = setInterval(() => { void tick(); }, 60_000);
  timer.unref();
  const initial = setTimeout(() => { void tick(); }, 2_000);
  initial.unref();
}
