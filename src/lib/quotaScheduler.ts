import { configuredCodexQuotaAccount, configuredQuotaThresholdPercent, accountRemainingPercent, loadConfiguredCodexQuota } from "@/lib/codexQuota";
import { ensureVideoCreatorSchema, query } from "@/lib/db";
import { startGeneration } from "@/lib/pipeline";

export type CodexQuotaSchedule = {
  enabled: boolean;
  runDay: number;
  runTime: string;
  timezone: string;
  thresholdPercent: number;
  account: string;
  cycleActive: boolean;
  lastTriggerDate: string | null;
  activeRunId: number | null;
  lastQuotaPercent: number | null;
  lastError: string | null;
  updatedAt: string;
};

type ScheduleRow = {
  enabled: boolean;
  run_day: number;
  run_time: string;
  timezone: string;
  threshold_percent: string | number;
  cycle_active: boolean;
  last_trigger_date: string | null;
  active_run_id: number | null;
  last_quota_percent: string | number | null;
  last_error: string | null;
  updated_at: string;
};

function mapSchedule(row: ScheduleRow): CodexQuotaSchedule {
  return {
    enabled: row.enabled,
    runDay: row.run_day,
    runTime: row.run_time.slice(0, 5),
    timezone: row.timezone,
    thresholdPercent: Number(row.threshold_percent),
    account: configuredCodexQuotaAccount(),
    cycleActive: row.cycle_active,
    lastTriggerDate: row.last_trigger_date,
    activeRunId: row.active_run_id,
    lastQuotaPercent: row.last_quota_percent === null ? null : Number(row.last_quota_percent),
    lastError: row.last_error,
    updatedAt: row.updated_at,
  };
}

function validateTime(value: string) {
  if (!/^(?:[01]\d|2[0-3]):[0-5]\d$/.test(value)) throw new Error("Run time must use HH:mm format.");
  return value;
}

function validateDay(value: number) {
  if (!Number.isInteger(value) || value < 0 || value > 6) throw new Error("Run day must be between Sunday and Saturday.");
  return value;
}

function validateTimezone(value: string) {
  const timezone = value.trim();
  if (!timezone || timezone.length > 100) throw new Error("Choose a valid timezone.");
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: timezone }).format();
  } catch {
    throw new Error("Choose a valid timezone.");
  }
  return timezone;
}

export async function getCodexQuotaSchedule() {
  await ensureVideoCreatorSchema();
  const result = await query<ScheduleRow>(`SELECT enabled, run_day, run_time::text, timezone,
    threshold_percent, cycle_active, last_trigger_date::text, active_run_id,
    last_quota_percent, last_error, updated_at::text
    FROM video_creator_quota_schedule WHERE id = 1`);
  if (!result.rows[0]) throw new Error("Codex quota schedule is not configured.");
  return mapSchedule(result.rows[0]);
}

export async function updateCodexQuotaSchedule(input: {
  enabled: boolean;
  runDay: number;
  runTime: string;
  timezone: string;
}) {
  const runDay = validateDay(input.runDay);
  const runTime = validateTime(input.runTime);
  const timezone = validateTimezone(input.timezone);
  const threshold = configuredQuotaThresholdPercent();
  await ensureVideoCreatorSchema();
  const result = await query<ScheduleRow>(`INSERT INTO video_creator_quota_schedule
    (id, enabled, run_day, run_time, timezone, threshold_percent, cycle_active, last_error, updated_at)
    VALUES (1, $1, $2, $3::time, $4, $5, FALSE, NULL, NOW())
    ON CONFLICT (id) DO UPDATE SET
      enabled = EXCLUDED.enabled, run_day = EXCLUDED.run_day, run_time = EXCLUDED.run_time,
      timezone = EXCLUDED.timezone, threshold_percent = EXCLUDED.threshold_percent,
      cycle_active = CASE WHEN EXCLUDED.enabled THEN video_creator_quota_schedule.cycle_active ELSE FALSE END,
      last_error = NULL, updated_at = NOW()
    RETURNING enabled, run_day, run_time::text, timezone, threshold_percent,
      cycle_active, last_trigger_date::text, active_run_id, last_quota_percent,
      last_error, updated_at::text`,
    [input.enabled, runDay, runTime, timezone, threshold]);
  if (!result.rows[0]) throw new Error("Codex quota schedule is not configured.");
  return mapSchedule(result.rows[0]);
}

export async function deleteCodexQuotaSchedule() {
  await ensureVideoCreatorSchema();
  await query(`DELETE FROM video_creator_quota_schedule WHERE id = 1`);
}

function zonedNow(timezone: string, now = new Date()) {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: timezone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    weekday: "short",
    hourCycle: "h23",
  }).formatToParts(now);
  const values = Object.fromEntries(parts.map((part) => [part.type, part.value]));
  const day = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"].indexOf(values.weekday);
  return {
    date: `${values.year}-${values.month}-${values.day}`,
    time: `${values.hour}:${values.minute}`,
    day: day < 0 ? 0 : day,
  };
}

async function saveScheduleState(values: {
  cycleActive?: boolean;
  activeRunId?: number | null;
  lastQuotaPercent?: number | null;
  lastError?: string | null;
}) {
  const sets: string[] = [];
  const params: unknown[] = [];
  for (const [column, value] of [
    ["cycle_active", values.cycleActive],
    ["active_run_id", values.activeRunId],
    ["last_quota_percent", values.lastQuotaPercent],
    ["last_error", values.lastError],
  ] as const) {
    if (value === undefined) continue;
    params.push(value);
    sets.push(`${column} = $${params.length}`);
  }
  if (!sets.length) return;
  params.push(1);
  await query(`UPDATE video_creator_quota_schedule SET ${sets.join(", ")}, updated_at = NOW() WHERE id = $${params.length}`, params);
}

async function runQuotaCycle(schedule: CodexQuotaSchedule) {
  try {
    const quota = await loadConfiguredCodexQuota();
    const remaining = accountRemainingPercent(quota.account);
    await saveScheduleState({ lastQuotaPercent: remaining, lastError: null });
    if (remaining === null) throw new Error("Codex quota response has no usable session or weekly quota.");
    if (remaining <= schedule.thresholdPercent) {
      await saveScheduleState({ cycleActive: false, activeRunId: null });
      return;
    }

    const run = await startGeneration({ forceRecreate: false });
    await saveScheduleState({ activeRunId: run.id });
  } catch (error) {
    await saveScheduleState({
      lastError: error instanceof Error ? error.message : "Quota pipeline failed.",
      activeRunId: null,
    });
  }
}

async function tick() {
  try {
    const schedule = await getCodexQuotaSchedule();
    if (!schedule.enabled) return;

    if (schedule.cycleActive) {
      if (schedule.activeRunId !== null) {
        const result = await query<{ status: string }>(
          `SELECT status FROM video_creator_runs WHERE id = $1`,
          [schedule.activeRunId],
        );
        const status = result.rows[0]?.status;
        if (status === "running") return;
        if (status === "failed") {
          await saveScheduleState({
            cycleActive: false,
            activeRunId: null,
            lastError: "Quota pipeline run failed; cycle stopped.",
          });
          return;
        }
        await saveScheduleState({ activeRunId: null });
      }
      await runQuotaCycle(schedule);
      return;
    }

    const now = zonedNow(schedule.timezone);
    if (now.day !== schedule.runDay || now.time < schedule.runTime || schedule.lastTriggerDate === now.date) return;
    const claimed = await query(`UPDATE video_creator_quota_schedule
      SET cycle_active = TRUE, last_trigger_date = $1::date, active_run_id = NULL,
          last_error = NULL, updated_at = NOW()
      WHERE id = 1 AND enabled = TRUE
        AND (last_trigger_date IS NULL OR last_trigger_date <> $1::date)`,
      [now.date]);
    if (claimed.rowCount !== 1) return;
    await runQuotaCycle({ ...schedule, cycleActive: true, lastTriggerDate: now.date, activeRunId: null });
  } catch {
    // Retry on next scheduler tick.
  }
}

type SchedulerGlobal = typeof globalThis & { __videoCreatorQuotaScheduler?: boolean };

export function startQuotaScheduler() {
  const state = globalThis as SchedulerGlobal;
  if (state.__videoCreatorQuotaScheduler || process.env.NODE_ENV === "test") return;
  state.__videoCreatorQuotaScheduler = true;
  const timer = setInterval(() => { void tick(); }, 60_000);
  timer.unref();
  const initial = setTimeout(() => { void tick(); }, 3_000);
  initial.unref();
}
