"use client";

import { useEffect, useState } from "react";
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
type PublishRun = { id: number; status: "running" | "success" | "failed"; error?: string | null };

async function readJson<T>(response: Response): Promise<T> {
  try { return JSON.parse(await response.text()) as T; }
  catch { throw new Error(`API không trả JSON (HTTP ${response.status}). Hãy kiểm tra trạng thái trước khi gửi lại.`); }
}

function videoUrl(relativePath: string) {
  const encoded = btoa(unescape(encodeURIComponent(relativePath))).replaceAll("/", "_").replaceAll("+", "-");
  return `${basePath}/api/videos/${encoded}`;
}
function formatDate(value: string | null) { return value ? new Date(value).toLocaleString("en-US") : ""; }

export default function PatternVideoButton({ patternId, patternName, initialVideo, videoPath, label }: { patternId: number; patternName: string; initialVideo?: VideoData | null; videoPath?: string; label?: string }) {
  const [showModal, setShowModal] = useState(false);
  const [videos, setVideo] = useState<VideoData | null>(initialVideo || null);
  const [title, setTitle] = useState(initialVideo?.title || patternName);
  const [caption, setCaption] = useState(initialVideo?.caption || "");
  const [scheduledAt, setScheduledAt] = useState(initialVideo?.scheduledPublishAt || "");
  const [busy, setBusy] = useState("");
  const [message, setMessage] = useState("");
  const [run, setRun] = useState<PublishRun | null>(null);
  const [uploadLog, setUploadLog] = useState("");
  const activeRunId = run?.status === "running" ? run.id : null;
  const disabled = Boolean(busy) || activeRunId !== null;
  const currentPath = videos?.relativePath;

  useEffect(() => {
    if (!activeRunId) return;
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout>;
    const poll = async () => {
      let again = true;
      try {
        const response = await fetch(`${basePath}/api/runs/${activeRunId}/log`, { cache: "no-store", signal: controller.signal });
        const body = await readJson<{ run?: PublishRun; log?: string; error?: string }>(response);
        if (!response.ok || !body.run) {
          if (response.status === 401 || response.status === 404) again = false;
          throw new Error(body.error || "Không đọc được trạng thái upload.");
        }
        if (controller.signal.aborted) return;
        setUploadLog(body.log || "");
        if (body.run.status !== "running") {
          again = false;
          let result = body.run.status === "failed"
            ? `Upload thất bại: ${body.run.error || "Xem log."}`
            : "Facebook đã xử lý xong yêu cầu đăng / lên lịch.";
          if (body.run.status === "success" && currentPath) {
            try {
              const details = await fetch(`${basePath}/api/videos?path=${encodeURIComponent(currentPath)}`, { cache: "no-store", signal: controller.signal });
              const payload = await readJson<{ video?: VideoData; error?: string }>(details);
              if (!details.ok || !payload.video) throw new Error(payload.error || "Không đọc được video.");
              if (controller.signal.aborted) return;
              setVideo(payload.video);
            } catch {
              result += " Chưa tải lại được thông tin video; mở lại để kiểm tra.";
            }
          }
          if (controller.signal.aborted) return;
          setMessage(result);
          setRun(body.run);
        } else setMessage("Facebook đang upload / xử lý lịch đăng...");
      } catch (error) {
        if (!controller.signal.aborted) setMessage(error instanceof Error ? error.message : "Không đọc được trạng thái upload.");
      } finally {
        if (again && !controller.signal.aborted) timer = setTimeout(() => void poll(), 2_000);
      }
    };
    void poll();
    return () => { controller.abort(); clearTimeout(timer); };
  }, [activeRunId, currentPath]);

  async function open() {
    if (!run) setMessage("");
    try {
      const response = await fetch(`${basePath}/api/videos${videoPath ? `?path=${encodeURIComponent(videoPath)}` : ""}`, { cache: "no-store" });
      const body = await readJson<{ video?: VideoData; videos?: VideoData[]; error?: string }>(response);
      if (!response.ok) throw new Error(body.error || "Could not read videos list.");
      const match = videoPath ? body.video : body.videos?.find((item) => {
        const name = item.relativePath.split("/").pop()?.replace(/_video\.mp4$/i, "");
        return name === patternName || item.title === patternName;
      });
      if (!match) throw new Error(`No videos found for pattern "${patternName}" (#${patternId}).`);
      setVideo(match); setTitle(match.title || patternName); setCaption(match.caption || ""); setScheduledAt(match.scheduledPublishAt || ""); setShowModal(true);
    } catch (error) { alert(error instanceof Error ? error.message : "Video not found."); }
  }

  async function request(method: "PATCH" | "POST", body: Record<string, unknown>, success: string) {
    if (!videos || disabled) return;
    setBusy(method); setMessage("");
    try {
      const response = await fetch(`${basePath}/api/videos`, { method, headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
      const payload = await readJson<{ error?: string; run?: PublishRun }>(response);
      if (!response.ok) throw new Error(payload.error || "Action failed.");
      if (method === "POST") {
        if (!payload.run) throw new Error("Không nhận được mã upload. Kiểm tra trạng thái trước khi gửi lại.");
        setUploadLog("");
        setRun(payload.run);
      }
      setMessage(success);
      if (method === "PATCH") setVideo((current) => current ? { ...current, title, caption } : current);
    } catch (error) { setMessage(error instanceof Error ? error.message : "Action failed."); }
    finally { setBusy(""); }
  }
  async function save() { await request("PATCH", { path: videos?.relativePath, title, caption }, "Content saved."); }
  async function publish(schedule: boolean) {
    if (!videos || disabled) return;
    if (!caption.trim()) { setMessage("Enter a caption before publishing to Facebook."); return; }
    if (schedule && !scheduledAt) { setMessage("Choose a publishing time."); return; }
    const date = schedule ? new Date(scheduledAt) : null;
    if (date && (!Number.isFinite(date.getTime()) || date.getTime() < Date.now() + 600_000 || date.getTime() > Date.now() + 29 * 86_400_000)) {
      setMessage("Lịch đăng phải cách hiện tại từ 10 phút đến 29 ngày.");
      return;
    }
    const warning = videos.facebookVideoId ? " Video đã có bài đăng hoặc lịch đăng. Tiếp tục có thể tạo bài trùng." : "";
    if (!window.confirm((date
      ? `Xác nhận upload video lên Facebook và đặt lịch đăng lúc ${date.toLocaleString()}?`
      : "Xác nhận đăng video lên Facebook ngay? Đây là hành động công khai bên ngoài ứng dụng.") + warning)) return;
    await request("POST", { action: "publish", path: videos.relativePath, title, caption, scheduledAt: date?.toISOString(), confirmPublish: true }, "Đã nhận yêu cầu. Facebook đang upload / xử lý lịch đăng...");
  }

  return <>
    <button type="button" onClick={() => void open()} style={{ padding: "4px 10px", border: "1px solid #4a7c59", borderRadius: "5px", background: "#1a4d2e", color: "#a8e6cf", fontSize: "11px", fontWeight: 600, cursor: "pointer" }}>{label || "Video / Publish"}</button>
    {showModal && videos ? <div style={{ position: "fixed", inset: 0, background: "rgba(0,0,0,.85)", display: "flex", alignItems: "center", justifyContent: "center", zIndex: 9999 }} onClick={() => setShowModal(false)}>
      <div style={{ background: "#0a192c", padding: 20, borderRadius: 12, maxWidth: "90vw", width: 820, maxHeight: "94vh", overflow: "auto", boxShadow: "0 10px 40px rgba(0,0,0,.5)" }} onClick={(event) => event.stopPropagation()}>
        <div style={{ display: "flex", justifyContent: "space-between", marginBottom: 12 }}><h3 style={{ color: "#e8eff8", margin: 0 }}>{patternName} (#{patternId})</h3><button type="button" onClick={() => setShowModal(false)} style={{ background: "transparent", border: 0, color: "#fff", fontSize: 24, cursor: "pointer" }}>×</button></div>
        <video controls style={{ width: "100%", maxHeight: 420, borderRadius: 8, background: "#000" }} src={videoUrl(videos.relativePath)} />
        <fieldset disabled={disabled} style={{ border: 0, padding: 0, margin: 0 }}>
        <label style={{ display: "grid", gap: 5, marginTop: 14, color: "#aebfd6", fontSize: 12 }}>Title<input value={title} onChange={(event) => setTitle(event.target.value)} maxLength={300} style={{ padding: 9 }} /></label>
        <label style={{ display: "grid", gap: 5, marginTop: 10, color: "#aebfd6", fontSize: 12 }}>Caption / Description<textarea value={caption} onChange={(event) => setCaption(event.target.value)} maxLength={5000} rows={5} style={{ padding: 9, resize: "vertical" }} /></label>
        <label style={{ display: "grid", gap: 5, marginTop: 10, color: "#aebfd6", fontSize: 12 }}>Facebook Schedule<SchedulePicker value={scheduledAt} onChange={setScheduledAt} placeholder="Choose publishing date and time" /></label>
        <div style={{ display: "flex", flexWrap: "wrap", gap: 8, marginTop: 14 }}><button type="button" disabled={disabled} onClick={() => void save()}>Save Content</button><button type="button" disabled={disabled} onClick={() => void publish(false)} style={{ background: "#1a4d2e", color: "#a8e6cf" }}>Publish to Facebook</button><button type="button" disabled={disabled} onClick={() => void publish(true)} style={{ background: "#25486c", color: "#b9dbff" }}>Schedule Facebook Post</button><YouTubeUploader key={videos.relativePath} videoPath={videos.relativePath} title={title} caption={caption} disabled={disabled} /></div>
        </fieldset>
        {videos.publishedAt ? <p style={{ color: "#8cf0c8", fontSize: 12 }}>Published: {formatDate(videos.publishedAt)} · ID {videos.facebookVideoId}</p> : null}{videos.scheduledPublishAt ? <p style={{ color: "#ffe2a1", fontSize: 12 }}>Scheduled: {formatDate(videos.scheduledPublishAt)} · ID {videos.facebookVideoId}</p> : null}{message ? <p style={{ color: message.startsWith("Content") || message.startsWith("Facebook") ? "#8cf0c8" : "#ffb7ba", fontSize: 12 }}>{message}</p> : null}
        <p style={{ color: "#7890ae", fontSize: 11, fontFamily: "monospace", wordBreak: "break-all" }}>{videos.relativePath}</p>
        {run ? <p role="status">Upload #{run.id}: {run.status}</p> : null}
        {uploadLog ? <pre role="log" aria-label="Log upload" style={{ whiteSpace: "pre-wrap", overflowWrap: "anywhere", maxHeight: 240, overflow: "auto", color: "#aebfd6" }}>{uploadLog}</pre> : null}
      </div>
    </div> : null}
  </>;
}
