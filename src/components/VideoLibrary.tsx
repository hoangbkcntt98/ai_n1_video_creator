"use client";

import { useRef, useState } from "react";
import { useRouter } from "next/navigation";
import type { VideoRecord } from "@/lib/video";
import YouTubeUploader from "./YouTubeUploader";
import SchedulePicker from "./SchedulePicker";

type Props = { videos: VideoRecord[] };
const formatter = new Intl.NumberFormat("en-US", { style: "unit", unit: "megabyte", unitDisplay: "short", maximumFractionDigits: 1 });
const basePath = process.env.NEXT_PUBLIC_BASE_PATH || "";
function videoUrl(relativePath: string) { return `${basePath}/api/videos/${encodeURIComponent(btoa(unescape(encodeURIComponent(relativePath))).replaceAll("/", "_").replaceAll("+", "-"))}`; }

export default function VideoLibrary({ videos }: Props) {
  const router = useRouter();
  const inputRef = useRef<HTMLInputElement>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [message, setMessage] = useState("");
  const [drafts, setDrafts] = useState<Record<string, { title: string; caption: string }>>({});
  const [scheduledValues, setScheduledValues] = useState<Record<string, string>>({});

  async function request(url: string, init: RequestInit, key: string, successMessage?: string) {
    setBusy(key); setMessage("");
    try {
      const response = await fetch(url, init);
      const body = await response.json() as { error?: string; run?: { id: number } };
      if (!response.ok) throw new Error(body.error || "Action failed.");
      setMessage(successMessage || (body.run ? `Created Facebook upload run #${body.run.id}.` : "Saved."));
      router.refresh();
    } catch (error) { setMessage(error instanceof Error ? error.message : "An error occurred."); }
    finally { setBusy(null); }
  }

  async function save(videos: VideoRecord, form: HTMLFormElement) {
    const fields = new FormData(form);
    await request(`${basePath}/api/videos`, { method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify({ path: videos.relativePath, title: fields.get("title"), caption: fields.get("caption") }) }, `save:${videos.relativePath}`);
  }

  async function publish(videos: VideoRecord, form: HTMLFormElement, schedule = false) {
    const fields = new FormData(form);
    const caption = String(fields.get("caption") || "");
    const title = String(fields.get("title") || "");
    const scheduleInput = String(fields.get("scheduledAt") || "");
    if (!caption.trim()) { setMessage("Enter a caption before publishing to Facebook."); return; }
    let scheduledAt: string | undefined;
    if (schedule) {
      if (!scheduleInput) { setMessage("Choose a publishing time."); return; }
      const date = new Date(scheduleInput);
      if (Number.isNaN(date.getTime())) { setMessage("Invalid scheduled time."); return; }
      scheduledAt = date.toISOString();
    } else if (!window.confirm("Publish this video to the Facebook Page now? This external action cannot be undone.")) return;
    await request(
      `${basePath}/api/videos`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ action: "publish", path: videos.relativePath, title, caption, scheduledAt, confirmPublish: true }),
      },
      `publish:${videos.relativePath}`,
      schedule ? "Facebook post scheduled." : undefined,
    );
  }

  async function upload() {
    const file = inputRef.current?.files?.[0]; if (!file) return;
    const form = new FormData(); form.set("video", file);
    await request(`${basePath}/api/videos/upload`, { method: "POST", body: form }, "upload");
    if (inputRef.current) inputRef.current.value = "";
  }

  return <section className="library"><div className="sectionTitle"><div><p className="eyebrow">OUTPUT_DIR</p><h2>MP4 Videos</h2></div><div className="upload"><input ref={inputRef} type="file" accept="video/mp4" onChange={upload} disabled={busy !== null}/><span>Or upload an MP4 to edit its caption and publish to Facebook or YouTube.</span></div></div>
    {message && <p className="runMessage" role="status">{message}</p>}
    {!videos.length ? <p className="empty">No videos yet. Run the pipeline or upload an MP4.</p> : <div className="videoGrid">{videos.map((videos) => <article className="videoCard" key={videos.relativePath}>
      <video controls preload="metadata" src={videoUrl(videos.relativePath)} />
      <form onSubmit={(event) => { event.preventDefault(); void save(videos, event.currentTarget); }}>
        <label>Title<input name="title" value={drafts[videos.relativePath]?.title ?? videos.title} onChange={(event) => setDrafts((current) => ({ ...current, [videos.relativePath]: { title: event.target.value, caption: current[videos.relativePath]?.caption ?? videos.caption } }))} maxLength={300}/></label>
        <label>Caption / Description<textarea name="caption" value={drafts[videos.relativePath]?.caption ?? videos.caption} onChange={(event) => setDrafts((current) => ({ ...current, [videos.relativePath]: { title: current[videos.relativePath]?.title ?? videos.title, caption: event.target.value } }))} maxLength={5000} rows={5} placeholder="Write a caption or YouTube description"/></label>
        <p className="videoMeta">{formatter.format(videos.size / 1024 / 1024)} · {new Date(videos.modifiedAt).toLocaleString("en-US")}<br/>{videos.relativePath}</p>
        {videos.scheduledPublishAt ? <p className="published">Scheduled: {new Date(videos.scheduledPublishAt).toLocaleString("en-US")} · ID {videos.facebookVideoId}</p> : null}
        {videos.facebookVideoId && !videos.scheduledPublishAt ? <p className="published">Published to Facebook · ID {videos.facebookVideoId}</p> : null}
        <label>Facebook schedule (leave empty to publish now)<SchedulePicker name="scheduledAt" value={scheduledValues[videos.relativePath] ?? videos.scheduledPublishAt ?? ""} onChange={(value) => setScheduledValues((current) => ({ ...current, [videos.relativePath]: value }))} /></label>
        <div className="cardActions"><button type="submit" disabled={busy !== null}>Save Content</button><button type="button" className="facebook" disabled={busy !== null} onClick={(event) => { const form = event.currentTarget.closest("form"); if (form) void publish(videos, form); }}>Publish to Facebook</button><button type="button" className="schedule" disabled={busy !== null} onClick={(event) => { const form = event.currentTarget.closest("form"); if (form) void publish(videos, form, true); }}>Schedule Facebook Post</button><YouTubeUploader videoPath={videos.relativePath} title={drafts[videos.relativePath]?.title ?? videos.title} caption={drafts[videos.relativePath]?.caption ?? videos.caption} disabled={busy !== null} /></div>
      </form>
    </article>)}</div>}
  </section>;
}
