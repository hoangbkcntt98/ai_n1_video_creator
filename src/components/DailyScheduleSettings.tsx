"use client";

import { useEffect, useState } from "react";
import styles from "@/app/page.module.css";
import type { DailySchedule as Schedule } from "@/lib/scheduler";

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

export default function DailyScheduleSettings() {
  const [schedule, setSchedule] = useState<Schedule | null>(null);
  const [runTime, setRunTime] = useState("09:00");
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
    fetch(`${basePath}/api/schedule`, { cache: "no-store" })
      .then(async (response) => {
        const body = await response.json() as { schedule?: Schedule; error?: string };
        if (response.status === 404) return null;
        if (!response.ok || !body.schedule) throw new Error(body.error || "Could not read daily schedule.");
        return body.schedule;
      })
      .then((value) => {
        if (!value) return;
        setSchedule(value);
        setRunTime(value.runTime);
        setTimezone(value.timezone || browserTimezone || "UTC");
        setEnabled(value.enabled);
        setForceRecreate(value.forceRecreate);
        setPublishToFacebook(value.publishToFacebook);
        setPublishToYouTube(value.publishToYouTube ?? false);
        setYoutubePrivacy(value.youtubePrivacy || "private");
        setYoutubeAudience(typeof value.youtubeMadeForKids === "boolean" ? value.youtubeMadeForKids ? "yes" : "no" : "");
        setYoutubeSynthetic(typeof value.youtubeContainsSyntheticMedia === "boolean" ? value.youtubeContainsSyntheticMedia ? "yes" : "no" : "");
      })
      .catch((reason) => setError(reason instanceof Error ? reason.message : "Could not read daily schedule."));
  }, []);

  async function save() {
    if (publishToYouTube && (!youtubeAudience || !youtubeSynthetic)) {
      setError("Choose the YouTube audience and altered/synthetic content settings.");
      return;
    }
    if (enabled && publishToYouTube && !window.confirm(
      `Enable automatic YouTube uploads with ${youtubePrivacy} visibility after each daily video is created? Future uploads will not ask for confirmation. The selected audience and content disclosure apply to every generated video.`,
    )) return;
    setBusy(true);
    setMessage("");
    setError("");
    try {
      const response = await fetch(`${basePath}/api/schedule`, {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          enabled, runTime, timezone, forceRecreate, publishToFacebook, publishToYouTube, youtubePrivacy,
          youtubeMadeForKids: youtubeAudience ? youtubeAudience === "yes" : null,
          youtubeContainsSyntheticMedia: youtubeSynthetic ? youtubeSynthetic === "yes" : null,
        }),
      });
      const body = await response.json() as { schedule?: Schedule; error?: string };
      if (!response.ok || !body.schedule) throw new Error(body.error || "Could not save daily schedule.");
      setSchedule(body.schedule);
      setMessage(enabled ? `Daily pipeline enabled at ${body.schedule.runTime} (${body.schedule.timezone}).` : "Daily pipeline disabled.");
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "Could not save daily schedule.");
    } finally {
      setBusy(false);
    }
  }

  async function remove() {
    if (!window.confirm("Delete daily pipeline schedule?")) return;
    setBusy(true);
    setMessage("");
    setError("");
    try {
      const response = await fetch(`${basePath}/api/schedule`, { method: "DELETE" });
      const body = await response.json() as { error?: string };
      if (!response.ok) throw new Error(body.error || "Could not delete daily schedule.");
      setSchedule(null);
      setEnabled(false);
      setPublishToFacebook(false);
      setPublishToYouTube(false);
      setYoutubePrivacy("private");
      setYoutubeAudience("");
      setYoutubeSynthetic("");
      setMessage("Daily pipeline schedule deleted.");
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "Could not delete daily schedule.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className={styles.schedulePanel}>
      <div className={styles.sectionHeading}>
        <div>
          <p className="eyebrow">AUTOMATION</p>
          <h2>Daily Pipeline Schedule</h2>
        </div>
        <span className={enabled ? styles.scheduleEnabled : styles.scheduleDisabled}>{enabled ? "Enabled" : "Disabled"}</span>
      </div>
      <p className={styles.scheduleDescription}>Run the next grammar pattern automatically once per day.</p>
      <div className={styles.scheduleFields}>
        <label className={styles.scheduleToggle}>
          <input type="checkbox" checked={enabled} onChange={(event) => setEnabled(event.target.checked)} disabled={busy} />
          Enable daily run
        </label>
        <label>
          Time
          <input type="time" value={runTime} onChange={(event) => setRunTime(event.target.value)} disabled={busy} />
        </label>
        <label>
          Timezone
          <input list="schedule-timezones" value={timezone} onChange={(event) => setTimezone(event.target.value)} disabled={busy} />
          <datalist id="schedule-timezones">{timezoneOptions.map((option) => <option value={option} key={option} />)}</datalist>
        </label>
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
          <p className={styles.scheduleDescription}>Uses the generated title and caption. These settings apply to every daily video. If both platforms are selected, Facebook uploads first, then YouTube. Track upload runs in Run History.</p>
        </> : null}
        <button type="button" className="primary" onClick={() => void save()} disabled={busy}>
          {busy ? "Saving..." : "Save Schedule"}
        </button>
        {schedule ? <button type="button" onClick={() => void remove()} disabled={busy}>Delete Schedule</button> : null}
      </div>
      {schedule?.lastRunDate ? <p className={styles.scheduleMeta}>Last run: {schedule.lastRunDate}{schedule.lastRunId ? ` · Run #${schedule.lastRunId}` : ""}</p> : null}
      {schedule?.lastError ? <p className={styles.scheduleError}>Last error: {schedule.lastError}</p> : null}
      {message ? <p className={styles.scheduleSuccess} role="status">{message}</p> : null}
      {error ? <p className={styles.scheduleError} role="alert">{error}</p> : null}
    </section>
  );
}
