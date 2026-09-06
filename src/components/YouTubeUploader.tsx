"use client";

import { useEffect, useId, useState } from "react";
import type { VideoRecord } from "@/lib/video";
import styles from "./YouTubeUploader.module.css";

const basePath = process.env.NEXT_PUBLIC_BASE_PATH || "";
type UploadRun = { id: number; status: string; error: string | null };
type Props = { videoPath: string; title: string; caption: string; disabled?: boolean };

// Shares the existing video editor. No second video picker, form, or page.
export default function YouTubeUploader({ videoPath, title, caption, disabled = false }: Props) {
  const panelId = useId();
  const [open, setOpen] = useState(false);
  const [video, setVideo] = useState<VideoRecord | null>(null);
  const [privacy, setPrivacy] = useState("private");
  const [audience, setAudience] = useState("");
  const [synthetic, setSynthetic] = useState("");
  const [configured, setConfigured] = useState(false);
  const [missing, setMissing] = useState<string[]>([]);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [run, setRun] = useState<UploadRun | null>(null);
  const [log, setLog] = useState("");
  const [error, setError] = useState("");

  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    Promise.all([
      fetch(`${basePath}/api/youtube`, { cache: "no-store" }),
      fetch(`${basePath}/api/videos`, { cache: "no-store" }),
    ]).then(async ([configResponse, videosResponse]) => {
      if (!configResponse.ok || !videosResponse.ok) throw new Error("Could not load YouTube settings or video details.");
      const config = await configResponse.json();
      const body = await videosResponse.json() as { videos: VideoRecord[] };
      if (cancelled) return;
      setConfigured(config.configured);
      setMissing(config.missing);
      setVideo(body.videos.find((item) => item.relativePath === videoPath) || null);
    }).catch((reason) => {
      if (!cancelled) setError(reason instanceof Error ? reason.message : "Could not load YouTube settings.");
    }).finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [open, videoPath]);

  const runId = run?.id;
  const runStatus = run?.status;
  useEffect(() => {
    if (!runId || runStatus !== "running") return;
    let cancelled = false;
    let timer: number | undefined;
    async function poll() {
      try {
        const response = await fetch(`${basePath}/api/runs/${runId}/log`, { cache: "no-store" });
        const body = await response.json() as { run?: UploadRun; log?: string; error?: string };
        if (!response.ok || !body.run) throw new Error(body.error || "Could not read upload status.");
        if (cancelled) return;
        setLog(body.log || "");
        setError("");
        if (body.run.status === "success") {
          const result = await fetch(`${basePath}/api/videos`, { cache: "no-store" });
          if (!result.ok) throw new Error("Upload finished, but video details could not be refreshed.");
          const videos = (await result.json()).videos as VideoRecord[];
          if (cancelled) return;
          setVideo(videos.find((item) => item.relativePath === videoPath) || null);
        }
        setRun(body.run);
        if (body.run.status !== "running") return;
      } catch (reason) {
        if (!cancelled) setError(reason instanceof Error ? reason.message : "Could not read upload status.");
      }
      if (!cancelled) timer = window.setTimeout(() => void poll(), 4000);
    }
    void poll();
    return () => { cancelled = true; window.clearTimeout(timer); };
  }, [runId, runStatus, videoPath]);

  const contentError = !title.trim() || [...title.trim()].length > 100 || /[<>]/.test(title)
    ? "Edit the shared Title above: YouTube requires 1–100 characters, without < or >."
    : new TextEncoder().encode(caption).length > 5000 || /[<>]/.test(caption)
      ? "Edit the shared Caption / Description above: YouTube allows 5000 UTF-8 bytes, without < or >."
      : "";
  const locked = disabled || loading || busy || runStatus === "running";

  async function upload() {
    if (locked || !configured || !audience || !synthetic || contentError) return;
    const duplicate = video?.youtubeVideoId ? " This video was already uploaded. Continuing creates a separate YouTube video." : "";
    if (!window.confirm(`Upload this video to the connected YouTube channel with ${privacy} visibility?${duplicate}`)) return;
    setBusy(true);
    setError("");
    try {
      const response = await fetch(`${basePath}/api/youtube`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          path: videoPath, title, description: caption, privacy,
          madeForKids: audience === "yes", containsSyntheticMedia: synthetic === "yes", confirmUpload: true,
        }),
      });
      const body = await response.json() as { error?: string; run: UploadRun };
      if (!response.ok) throw new Error(body.error || "Could not start upload.");
      setRun(body.run);
      setLog("");
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "Upload failed.");
    } finally {
      setBusy(false);
    }
  }

  return <>
    <button type="button" className={styles.trigger} aria-expanded={open} aria-controls={panelId}
      disabled={disabled && !open} onClick={() => {
        if (!open) { setLoading(true); setConfigured(false); setError(""); }
        setOpen(!open);
      }}>
      {open ? "Hide YouTube Options" : runStatus === "running" ? "YouTube Uploading..." : "Upload to YouTube"}
    </button>
    {open ? <section id={panelId} className={styles.panel} aria-label="YouTube upload options">
      <h4>YouTube</h4>
      <p>Uses this video and the Title and Caption / Description above. Facebook scheduling does not apply to YouTube.</p>
      {loading ? <p role="status">Loading YouTube settings...</p> : !configured && missing.length ? (
        <p className={styles.warning}>Setup required: {missing.join(", ")}. Follow <code>docs/YOUTUBE_SETUP.vi.md</code>, then restart the app.</p>
      ) : null}
      <fieldset disabled={locked}>
        <legend>Upload settings</legend>
        <div className={styles.row}>
          <label>Visibility
            <select value={privacy} onChange={(event) => setPrivacy(event.target.value)}>
              <option value="private">Private</option><option value="unlisted">Unlisted</option><option value="public">Public</option>
            </select>
          </label>
          <label>Made for kids?
            <select value={audience} onChange={(event) => setAudience(event.target.value)}>
              <option value="">Choose audience</option><option value="no">No</option><option value="yes">Yes</option>
            </select>
          </label>
          <label>Realistic altered or synthetic content?
            <select value={synthetic} onChange={(event) => setSynthetic(event.target.value)}>
              <option value="">Choose disclosure</option><option value="no">No</option><option value="yes">Yes</option>
            </select>
          </label>
        </div>
        {contentError ? <p className={styles.warning} role="alert">{contentError}</p> : null}
        <button className="primary" disabled={!configured || !videoPath || !audience || !synthetic || !!contentError} type="button" onClick={() => void upload()}>
          {busy ? "Starting..." : runStatus === "running" ? "Uploading..." : "Confirm YouTube Upload"}
        </button>
      </fieldset>
      {video?.youtubeVideoId ? <p className={styles.warning}>
        Already uploaded: <a href={`https://www.youtube.com/watch?v=${encodeURIComponent(video.youtubeVideoId)}`} target="_blank" rel="noreferrer">View on YouTube</a>
        {video.youtubeUploadedAt ? ` · ${new Date(video.youtubeUploadedAt).toLocaleString()}` : ""}
        {video.youtubePrivacy ? ` · ${video.youtubePrivacy}` : ""}. Uploading again creates a separate video.
      </p> : null}
      {error ? <p className={styles.warning} role="alert">{error}</p> : null}
      {run ? <p role="status">YouTube run #{run.id}: {run.status}.
        {run.status === "success" ? " Upload accepted; YouTube processing may still be in progress." : ""}
        {run.error ? ` ${run.error}` : ""}
        {" "}Track this upload in Dashboard → Run History even after closing these options.
      </p> : null}
      {log ? <details><summary>Upload log</summary><pre className={styles.log}>{log}</pre></details> : null}
    </section> : null}
  </>;
}
