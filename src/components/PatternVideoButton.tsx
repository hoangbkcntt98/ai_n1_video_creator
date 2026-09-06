"use client";

import { useState } from "react";
import YouTubeUploader from "./YouTubeUploader";
import SchedulePicker from "./SchedulePicker";

const basePath = process.env.NEXT_PUBLIC_BASE_PATH || "";
type VideoData = {
  relativePath: string;
  title: string;
  caption: string;
  facebookVideoId: string | null;
  scheduledPublishAt: string | null;
  publishedAt: string | null;
};

function videoUrl(relativePath: string) {
  const encoded = btoa(unescape(encodeURIComponent(relativePath))).replaceAll("/", "_").replaceAll("+", "-");
  return `${basePath}/api/videos/${encoded}`;
}
function formatDate(value: string | null) { return value ? new Date(value).toLocaleString("en-US") : ""; }

export default function PatternVideoButton({ patternId, patternName, initialVideo }: { patternId: number; patternName: string; initialVideo?: VideoData | null }) {
  const [showModal, setShowModal] = useState(false);
  const [videos, setVideo] = useState<VideoData | null>(initialVideo || null);
  const [title, setTitle] = useState(initialVideo?.title || patternName);
  const [caption, setCaption] = useState(initialVideo?.caption || "");
  const [scheduledAt, setScheduledAt] = useState(initialVideo?.scheduledPublishAt || "");
  const [busy, setBusy] = useState("");
  const [message, setMessage] = useState("");

  async function open() {
    setMessage("");
    try {
      const response = await fetch(`${basePath}/api/videos`);
      const body = await response.json() as { videos?: VideoData[]; error?: string };
      if (!response.ok) throw new Error(body.error || "Could not read videos list.");
      const match = body.videos?.find((item) => {
        const name = item.relativePath.split("/").pop()?.replace(/_video\.mp4$/i, "");
        return name === patternName || item.title === patternName;
      });
      if (!match) throw new Error(`No videos found for pattern "${patternName}" (#${patternId}).`);
      setVideo(match); setTitle(match.title || patternName); setCaption(match.caption || ""); setScheduledAt(match.scheduledPublishAt || ""); setShowModal(true);
    } catch (error) { alert(error instanceof Error ? error.message : "Video not found."); }
  }

  async function request(method: "PATCH" | "POST", body: Record<string, unknown>, success: string) {
    if (!videos) return;
    setBusy(method); setMessage("");
    try {
      const response = await fetch(`${basePath}/api/videos`, { method, headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
      const payload = await response.json() as { error?: string };
      if (!response.ok) throw new Error(payload.error || "Action failed.");
      setMessage(success);
      if (method === "PATCH") setVideo((current) => current ? { ...current, title, caption } : current);
    } catch (error) { setMessage(error instanceof Error ? error.message : "Action failed."); }
    finally { setBusy(""); }
  }
  async function save() { await request("PATCH", { path: videos?.relativePath, title, caption }, "Content saved."); }
  async function publish(schedule: boolean) {
    if (!videos) return;
    if (!caption.trim()) { setMessage("Enter a caption before publishing to Facebook."); return; }
    if (!schedule && !window.confirm("Publish this video to the Facebook Page now? This external action cannot be undone.")) return;
    if (schedule && !scheduledAt) { setMessage("Choose a publishing time."); return; }
    await request("POST", { action: "publish", path: videos.relativePath, title, caption, scheduledAt: schedule ? new Date(scheduledAt).toISOString() : undefined, confirmPublish: true }, schedule ? "Facebook post scheduled." : "Facebook publishing request created.");
  }

  return <>
    <button type="button" onClick={() => void open()} style={{ padding: "4px 10px", border: "1px solid #4a7c59", borderRadius: "5px", background: "#1a4d2e", color: "#a8e6cf", fontSize: "11px", fontWeight: 600, cursor: "pointer" }}>Video / Publish</button>
    {showModal && videos ? <div style={{ position: "fixed", inset: 0, background: "rgba(0,0,0,.85)", display: "flex", alignItems: "center", justifyContent: "center", zIndex: 9999 }} onClick={() => setShowModal(false)}>
      <div style={{ background: "#0a192c", padding: 20, borderRadius: 12, maxWidth: "90vw", width: 820, maxHeight: "94vh", overflow: "auto", boxShadow: "0 10px 40px rgba(0,0,0,.5)" }} onClick={(event) => event.stopPropagation()}>
        <div style={{ display: "flex", justifyContent: "space-between", marginBottom: 12 }}><h3 style={{ color: "#e8eff8", margin: 0 }}>{patternName} (#{patternId})</h3><button type="button" onClick={() => setShowModal(false)} style={{ background: "transparent", border: 0, color: "#fff", fontSize: 24, cursor: "pointer" }}>×</button></div>
        <video controls style={{ width: "100%", maxHeight: 420, borderRadius: 8, background: "#000" }} src={videoUrl(videos.relativePath)} />
        <label style={{ display: "grid", gap: 5, marginTop: 14, color: "#aebfd6", fontSize: 12 }}>Title<input value={title} onChange={(event) => setTitle(event.target.value)} maxLength={300} style={{ padding: 9 }} /></label>
        <label style={{ display: "grid", gap: 5, marginTop: 10, color: "#aebfd6", fontSize: 12 }}>Caption / Description<textarea value={caption} onChange={(event) => setCaption(event.target.value)} maxLength={5000} rows={5} style={{ padding: 9, resize: "vertical" }} /></label>
        <label style={{ display: "grid", gap: 5, marginTop: 10, color: "#aebfd6", fontSize: 12 }}>Facebook Schedule<SchedulePicker value={scheduledAt} onChange={setScheduledAt} placeholder="Choose publishing date and time" /></label>
        <div style={{ display: "flex", flexWrap: "wrap", gap: 8, marginTop: 14 }}><button type="button" disabled={Boolean(busy)} onClick={() => void save()}>Save Content</button><button type="button" disabled={Boolean(busy)} onClick={() => void publish(false)} style={{ background: "#1a4d2e", color: "#a8e6cf" }}>Publish to Facebook</button><button type="button" disabled={Boolean(busy)} onClick={() => void publish(true)} style={{ background: "#25486c", color: "#b9dbff" }}>Schedule Facebook Post</button><YouTubeUploader key={videos.relativePath} videoPath={videos.relativePath} title={title} caption={caption} disabled={Boolean(busy)} /></div>
        {videos.publishedAt ? <p style={{ color: "#8cf0c8", fontSize: 12 }}>Published: {formatDate(videos.publishedAt)} · ID {videos.facebookVideoId}</p> : null}{videos.scheduledPublishAt ? <p style={{ color: "#ffe2a1", fontSize: 12 }}>Scheduled: {formatDate(videos.scheduledPublishAt)} · ID {videos.facebookVideoId}</p> : null}{message ? <p style={{ color: message.startsWith("Content") || message.startsWith("Facebook") ? "#8cf0c8" : "#ffb7ba", fontSize: 12 }}>{message}</p> : null}
        <p style={{ color: "#7890ae", fontSize: 11, fontFamily: "monospace", wordBreak: "break-all" }}>{videos.relativePath}</p>
      </div>
    </div> : null}
  </>;
}
