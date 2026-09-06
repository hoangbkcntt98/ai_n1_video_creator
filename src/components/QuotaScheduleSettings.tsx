"use client";

import { useEffect, useState } from "react";
import styles from "@/app/page.module.css";

const basePath = process.env.NEXT_PUBLIC_BASE_PATH || "";
const days = [
  "Sunday",
  "Monday",
  "Tuesday",
  "Wednesday",
  "Thursday",
  "Friday",
  "Saturday",
];
const timezoneOptions = [
  "UTC",
  "Asia/Tokyo",
  "Asia/Ho_Chi_Minh",
  "Asia/Singapore",
  "Europe/London",
  "Europe/Paris",
  "America/New_York",
  "America/Los_Angeles",
];

type Schedule = {
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

export default function QuotaScheduleSettings() {
  const [schedule, setSchedule] = useState<Schedule | null>(null);
  const [runDay, setRunDay] = useState(0);
  const [runTime, setRunTime] = useState("00:00");
  const [timezone, setTimezone] = useState("UTC");
  const [enabled, setEnabled] = useState(false);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");
  const [error, setError] = useState("");

  useEffect(() => {
    const browserTimezone = Intl.DateTimeFormat().resolvedOptions().timeZone;
    fetch(`${basePath}/api/quota-schedule`, { cache: "no-store" })
      .then(async (response) => {
        const body = await response.json() as { schedule?: Schedule; error?: string };
        if (response.status === 404) return null;
        if (!response.ok || !body.schedule) throw new Error(body.error || "Could not read quota schedule.");
        return body.schedule;
      })
      .then((value) => {
        if (!value) {
          setTimezone(browserTimezone || "UTC");
          return;
        }
        setSchedule(value);
        setRunDay(value.runDay);
        setRunTime(value.runTime);
        setTimezone(value.timezone || browserTimezone || "UTC");
        setEnabled(value.enabled);
      })
      .catch((reason) => setError(reason instanceof Error ? reason.message : "Could not read quota schedule."));
  }, []);

  async function save() {
    setBusy(true);
    setMessage("");
    setError("");
    try {
      const response = await fetch(`${basePath}/api/quota-schedule`, {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ enabled, runDay, runTime, timezone }),
      });
      const body = await response.json() as { schedule?: Schedule; error?: string };
      if (!response.ok || !body.schedule) throw new Error(body.error || "Could not save quota schedule.");
      setSchedule(body.schedule);
      setMessage(enabled ? `Quota cycle enabled for ${days[body.schedule.runDay]} at ${body.schedule.runTime} (${body.schedule.timezone}).` : "Quota cycle disabled.");
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "Could not save quota schedule.");
    } finally {
      setBusy(false);
    }
  }

  async function remove() {
    if (!window.confirm("Delete Codex quota schedule?")) return;
    setBusy(true);
    setMessage("");
    setError("");
    try {
      const response = await fetch(`${basePath}/api/quota-schedule`, { method: "DELETE" });
      const body = await response.json() as { error?: string };
      if (!response.ok) throw new Error(body.error || "Could not delete quota schedule.");
      setSchedule(null);
      setEnabled(false);
      setMessage("Codex quota schedule deleted.");
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "Could not delete quota schedule.");
    } finally {
      setBusy(false);
    }
  }

  const account = schedule?.account || "Set CODEX_QUOTA_ACCOUNT in .env.local";
  const threshold = schedule?.thresholdPercent ?? 10;

  return (
    <section className={styles.schedulePanel}>
      <div className={styles.sectionHeading}>
        <div>
          <p className="eyebrow">CODEX AUTOMATION</p>
          <h2>Quota Pipeline Schedule</h2>
        </div>
        <span className={enabled ? styles.scheduleEnabled : styles.scheduleDisabled}>
          {schedule?.cycleActive ? "Running cycle" : enabled ? "Enabled" : "Disabled"}
        </span>
      </div>
      <p className={styles.scheduleDescription}>
        At selected time, check Codex quota and create the next video repeatedly until remaining quota reaches {threshold}% or less.
      </p>
      <p className={styles.scheduleMeta}>Account: {account} · Stop threshold: {threshold}% remaining</p>
      <div className={styles.scheduleFields}>
        <label className={styles.scheduleToggle}>
          <input type="checkbox" checked={enabled} onChange={(event) => setEnabled(event.target.checked)} disabled={busy} />
          Enable quota cycle
        </label>
        <label>
          Day
          <select value={runDay} onChange={(event) => setRunDay(Number(event.target.value))} disabled={busy}>
            {days.map((day, index) => <option value={index} key={day}>{day}</option>)}
          </select>
        </label>
        <label>
          Time
          <input type="time" value={runTime} onChange={(event) => setRunTime(event.target.value)} disabled={busy} />
        </label>
        <label>
          Timezone
          <input list="quota-schedule-timezones" value={timezone} onChange={(event) => setTimezone(event.target.value)} disabled={busy} />
          <datalist id="quota-schedule-timezones">{timezoneOptions.map((option) => <option value={option} key={option} />)}</datalist>
        </label>
        <button type="button" className="primary" onClick={() => void save()} disabled={busy}>
          {busy ? "Saving..." : "Save Quota Schedule"}
        </button>
        {schedule ? <button type="button" onClick={() => void remove()} disabled={busy}>Delete Schedule</button> : null}
      </div>
      {schedule?.lastTriggerDate ? <p className={styles.scheduleMeta}>Last cycle: {schedule.lastTriggerDate}{schedule.lastQuotaPercent !== null ? ` · ${schedule.lastQuotaPercent.toFixed(1)}% remaining` : ""}{schedule.activeRunId ? ` · Run #${schedule.activeRunId}` : ""}</p> : null}
      {schedule?.lastError ? <p className={styles.scheduleError}>Last error: {schedule.lastError}</p> : null}
      {message ? <p className={styles.scheduleSuccess} role="status">{message}</p> : null}
      {error ? <p className={styles.scheduleError} role="alert">{error}</p> : null}
    </section>
  );
}
