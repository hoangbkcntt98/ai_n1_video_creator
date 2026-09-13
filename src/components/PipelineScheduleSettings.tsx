"use client";

import { useEffect, useState } from "react";
import styles from "@/app/page.module.css";
import type { PipelineSchedule as Schedule } from "@/lib/scheduler";

const basePath = process.env.NEXT_PUBLIC_BASE_PATH || "";
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

export default function PipelineScheduleSettings({ mode }: { mode: Schedule["mode"] }) {
  const title = mode === "daily" ? "Daily Schedule" : "Repeat every N hours";
  const endpoint = `${basePath}/api/schedule?mode=${mode}`;
  const [schedule, setSchedule] = useState<Schedule | null>(null);
  const [runTime, setRunTime] = useState("09:00");
  const [startsAt, setStartsAt] = useState("");
  const [intervalHours, setIntervalHours] = useState("5");
  const [videosPerRun, setVideosPerRun] = useState("4");
  const [timezone, setTimezone] = useState("UTC");
  const [enabled, setEnabled] = useState(false);
  const [forceRecreate, setForceRecreate] = useState(false);
  const [publishToFacebook, setPublishToFacebook] = useState(false);
  const [publishToYouTube, setPublishToYouTube] = useState(false);
  const [youtubePrivacy, setYoutubePrivacy] = useState<Schedule["youtubePrivacy"]>("private");
  const [youtubeAudience, setYoutubeAudience] = useState("");
  const [youtubeSynthetic, setYoutubeSynthetic] = useState("");
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");
  const [error, setError] = useState("");

  useEffect(() => {
    const browserTimezone = Intl.DateTimeFormat().resolvedOptions().timeZone;
    let disposed = false;
    const readSchedule = () => fetch(endpoint, { cache: "no-store" })
      .then(async (response) => {
        const body = await response.json() as { schedule?: Schedule; error?: string };
        if (response.status === 404) return null;
        if (!response.ok || !body.schedule) throw new Error(body.error || "Could not read schedule.");
        return body.schedule;
      });
    readSchedule().then((value) => {
        if (!value || disposed) return;
        setSchedule(value);
        setRunTime(value.runTime);
        setStartsAt(value.startsAt ?? "");
        setIntervalHours(String(value.intervalHours ?? 5));
        setVideosPerRun(String(value.mode === "interval" ? value.videosPerRun : 4));
        setTimezone(value.timezone || browserTimezone || "UTC");
        setEnabled(value.enabled);
        setForceRecreate(value.forceRecreate);
        setPublishToFacebook(value.publishToFacebook);
        setPublishToYouTube(value.publishToYouTube ?? false);
        setYoutubePrivacy(value.youtubePrivacy || "private");
        setYoutubeAudience(typeof value.youtubeMadeForKids === "boolean" ? value.youtubeMadeForKids ? "yes" : "no" : "");
        setYoutubeSynthetic(typeof value.youtubeContainsSyntheticMedia === "boolean" ? value.youtubeContainsSyntheticMedia ? "yes" : "no" : "");
      })
      .catch((reason) => {
        if (!disposed) setError(reason instanceof Error ? reason.message : "Could not read schedule.");
      });
    // Refresh queue/next-run status without overwriting fields being edited.
    const timer = setInterval(() => {
      void readSchedule().then((value) => { if (!disposed) setSchedule(value); }).catch(() => {});
    }, 15_000);
    return () => { disposed = true; clearInterval(timer); };
  }, [endpoint]);

  async function save() {
    if (mode === "interval" && (!startsAt || !Number.isInteger(Number(intervalHours)) ||
        Number(intervalHours) < 1 || Number(intervalHours) > 8760 ||
        !Number.isInteger(Number(videosPerRun)) || Number(videosPerRun) < 1 || Number(videosPerRun) > 100)) {
      setError("Choose a start date/time, interval of 1–8760 whole hours, and 1–100 videos per batch.");
      return;
    }
    if (publishToYouTube && (!youtubeAudience || !youtubeSynthetic)) {
      setError("Choose the YouTube audience and altered/synthetic content settings.");
      return;
    }
    if (enabled && publishToYouTube && !window.confirm(
      `Enable automatic YouTube uploads with ${youtubePrivacy} visibility after each scheduled video is created? Future uploads will not ask for confirmation. The selected audience and content disclosure apply to every generated video.`,
    )) return;
    setBusy(true);
    setMessage("");
    setError("");
    try {
      const response = await fetch(endpoint, {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          enabled, runTime, timezone, forceRecreate, publishToFacebook, publishToYouTube, youtubePrivacy,
          mode, startsAt, intervalHours: Number(intervalHours), videosPerRun: Number(videosPerRun),
          youtubeMadeForKids: youtubeAudience ? youtubeAudience === "yes" : null,
          youtubeContainsSyntheticMedia: youtubeSynthetic ? youtubeSynthetic === "yes" : null,
        }),
      });
      const body = await response.json() as { schedule?: Schedule; error?: string };
      if (!response.ok || !body.schedule) throw new Error(body.error || "Could not save schedule.");
      setSchedule(body.schedule);
      setMessage(!enabled ? `${title} disabled.` : mode === "interval"
        ? `Create ${body.schedule.videosPerRun} videos every ${body.schedule.intervalHours} hours from ${body.schedule.startsAt?.replace("T", " ")} (${body.schedule.timezone}).`
        : `Daily pipeline enabled at ${body.schedule.runTime} (${body.schedule.timezone}).`);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "Could not save schedule.");
    } finally {
      setBusy(false);
    }
  }

  async function remove() {
    if (!window.confirm(`Delete ${title} and cancel its queued videos? The other schedule is unchanged. Running videos and their uploads will continue.`)) return;
    setBusy(true);
    setMessage("");
    setError("");
    try {
      const response = await fetch(endpoint, { method: "DELETE" });
      const body = await response.json() as { error?: string };
      if (!response.ok) throw new Error(body.error || "Could not delete schedule.");
      setSchedule(null);
      setEnabled(false);
      setStartsAt("");
      setIntervalHours("5");
      setVideosPerRun("4");
      setPublishToFacebook(false);
      setPublishToYouTube(false);
      setYoutubePrivacy("private");
      setYoutubeAudience("");
      setYoutubeSynthetic("");
      setMessage(`${title} deleted.`);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "Could not delete schedule.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className={styles.schedulePanel} aria-labelledby={`schedule-heading-${mode}`}>
      <div className={styles.sectionHeading}>
        <div>
          <p className="eyebrow">AUTOMATION</p>
          <h2 id={`schedule-heading-${mode}`}>{title}</h2>
        </div>
        <span className={enabled ? styles.scheduleEnabled : styles.scheduleDisabled}>{enabled ? "Enabled" : "Disabled"}</span>
      </div>
      <p className={styles.scheduleDescription}>
        {mode === "daily" ? "Create one video each day at the selected time." : "Repeat a batch every N hours from a chosen start time."}
        {" "}Both schedules can be enabled independently. Due videos share one worker and run sequentially with their selected uploads.
      </p>
      <div className={styles.scheduleFields}>
        <label className={styles.scheduleToggle}>
          <input type="checkbox" checked={enabled} onChange={(event) => setEnabled(event.target.checked)} disabled={busy} />
          Enable schedule
        </label>
        {mode === "daily" ? <label>
          Time
          <input type="time" value={runTime} onChange={(event) => setRunTime(event.target.value)} disabled={busy} />
        </label> : <>
          <label>
            Start date and time
            <input type="datetime-local" step="1" value={startsAt} onChange={(event) => setStartsAt(event.target.value)} disabled={busy} />
          </label>
          <label>
            Repeat every (hours)
            <input type="number" min="1" max="8760" step="1" value={intervalHours} onChange={(event) => setIntervalHours(event.target.value)} disabled={busy} />
          </label>
          <label>
            Videos per batch
            <input type="number" min="1" max="100" step="1" value={videosPerRun} onChange={(event) => setVideosPerRun(event.target.value)} disabled={busy} />
          </label>
        </>}
        <label>
          Timezone
          <input list={`schedule-timezones-${mode}`} value={timezone} onChange={(event) => setTimezone(event.target.value)} disabled={busy} />
          <datalist id={`schedule-timezones-${mode}`}>{timezoneOptions.map((option) => <option value={option} key={option} />)}</datalist>
        </label>
        {mode === "interval" ? <p className={styles.scheduleDescription}>
          Start time uses the timezone above, not the server timezone. For example: 4 videos every 5 hours from 12/09/2026 15:00:00.
          {" "}Batches stay anchored to that start. If busy or offline, finish queued videos first, then run only the latest missed batch.
        </p> : null}
        <label className={styles.scheduleToggle}>
          <input type="checkbox" checked={forceRecreate} onChange={(event) => setForceRecreate(event.target.checked)} disabled={busy} />
          Force recreate existing content
        </label>
        <label className={styles.scheduleToggle}>
          <input type="checkbox" checked={publishToFacebook} onChange={(event) => setPublishToFacebook(event.target.checked)} disabled={busy} />
          Publish to Facebook after video creation
        </label>
        <label className={styles.scheduleToggle}>
          <input type="checkbox" checked={publishToYouTube} onChange={(event) => setPublishToYouTube(event.target.checked)} disabled={busy} />
          Publish to YouTube after video creation
        </label>
        {publishToYouTube ? <>
          <label>YouTube visibility
            <select value={youtubePrivacy} onChange={(event) => setYoutubePrivacy(event.target.value as Schedule["youtubePrivacy"])} disabled={busy}>
              <option value="private">Private</option><option value="unlisted">Unlisted</option><option value="public">Public</option>
            </select>
          </label>
          <label>YouTube: Made for kids?
            <select value={youtubeAudience} onChange={(event) => setYoutubeAudience(event.target.value)} disabled={busy}>
              <option value="">Choose audience</option><option value="no">No</option><option value="yes">Yes</option>
            </select>
          </label>
          <label>YouTube: Realistic altered or synthetic content?
            <select value={youtubeSynthetic} onChange={(event) => setYoutubeSynthetic(event.target.value)} disabled={busy}>
              <option value="">Choose disclosure</option><option value="no">No</option><option value="yes">Yes</option>
            </select>
          </label>
          <p className={styles.scheduleDescription}>Uses the generated title and caption. These settings apply to every scheduled video. If both platforms are selected, Facebook uploads first, then YouTube. Track upload runs in Run History.</p>
        </> : null}
        <button type="button" className="primary" onClick={() => void save()} disabled={busy}>
          {busy ? "Saving..." : "Save Schedule"}
        </button>
        {schedule ? <button type="button" onClick={() => void remove()} disabled={busy}>Delete Schedule</button> : null}
      </div>
      <p className={styles.scheduleDescription}>Saving or disabling cancels this schedule&apos;s videos not yet started. The other schedule is unchanged. Running videos and their uploads continue.</p>
      {schedule?.nextRunAt ? <p className={styles.scheduleMeta}>Next batch: {new Intl.DateTimeFormat("en-GB", {
        timeZone: schedule.timezone, dateStyle: "short", timeStyle: "medium",
      }).format(new Date(schedule.nextRunAt))} ({schedule.timezone})</p> : null}
      {schedule?.pendingVideos ? <p className={styles.scheduleMeta}>Videos queued: {schedule.pendingVideos}</p> : null}
      {schedule?.lastRunDate ? <p className={styles.scheduleMeta}>Last run: {schedule.lastRunDate}{schedule.lastRunId ? ` · Run #${schedule.lastRunId}` : ""}</p> : null}
      {schedule?.lastError ? <p className={styles.scheduleError}>Last error: {schedule.lastError}</p> : null}
      {message ? <p className={styles.scheduleSuccess} role="status">{message}</p> : null}
      {error ? <p className={styles.scheduleError} role="alert">{error}</p> : null}
    </section>
  );
}
