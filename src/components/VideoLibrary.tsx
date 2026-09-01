"use client";

import { useRef, useState } from "react";
import { useRouter } from "next/navigation";
import type { VideoRecord } from "@/lib/video";

type Props = { videos: VideoRecord[] };
const formatter = new Intl.NumberFormat("vi-VN", { style: "unit", unit: "megabyte", unitDisplay: "short", maximumFractionDigits: 1 });
const basePath = process.env.NEXT_PUBLIC_BASE_PATH || "";
function videoUrl(relativePath: string) { return `${basePath}/api/videos/${encodeURIComponent(btoa(unescape(encodeURIComponent(relativePath))).replaceAll("/", "_").replaceAll("+", "-"))}`; }

export default function VideoLibrary({ videos }: Props) {
  const router = useRouter();
  const inputRef = useRef<HTMLInputElement>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [message, setMessage] = useState("");

  async function request(url: string, init: RequestInit, key: string) {
    setBusy(key); setMessage("");
    try {
      const response = await fetch(url, init);
      const body = await response.json() as { error?: string; run?: { id: number } };
      if (!response.ok) throw new Error(body.error || "Thao tác lỗi.");
      setMessage(body.run ? `Đã tạo Facebook upload run #${body.run.id}.` : "Đã lưu.");
      router.refresh();
    } catch (error) { setMessage(error instanceof Error ? error.message : "Có lỗi."); }
    finally { setBusy(null); }
  }

  async function save(video: VideoRecord, form: HTMLFormElement) {
    const fields = new FormData(form);
    await request(`${basePath}/api/videos`, { method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify({ path: video.relativePath, title: fields.get("title"), caption: fields.get("caption") }) }, `save:${video.relativePath}`);
  }

  async function publish(video: VideoRecord, form: HTMLFormElement) {
    const fields = new FormData(form); const caption = String(fields.get("caption") || "");
    if (!caption.trim()) { setMessage("Nhập caption trước khi đăng Facebook."); return; }
    if (!window.confirm("Đăng video này lên Facebook Page ngay? Đây là hành động bên ngoài, không thể tự hoàn tác.")) return;
    await request(`${basePath}/api/videos`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ action: "publish", path: video.relativePath, caption, confirmPublish: true }) }, `publish:${video.relativePath}`);
  }

  async function upload() {
    const file = inputRef.current?.files?.[0]; if (!file) return;
    const form = new FormData(); form.set("video", file);
    await request(`${basePath}/api/videos/upload`, { method: "POST", body: form }, "upload");
    if (inputRef.current) inputRef.current.value = "";
  }

  return <section className="library"><div className="sectionTitle"><div><p className="eyebrow">OUTPUT_DIR</p><h2>Video MP4</h2></div><div className="upload"><input ref={inputRef} type="file" accept="video/mp4" onChange={upload} disabled={busy !== null}/><span>Hoặc tải MP4 để sửa caption, đăng Facebook.</span></div></div>
    {message && <p className="runMessage" role="status">{message}</p>}
    {!videos.length ? <p className="empty">Chưa có video. Tạo pipeline hoặc tải MP4 lên.</p> : <div className="videoGrid">{videos.map((video) => <article className="videoCard" key={video.relativePath}>
      <video controls preload="metadata" src={videoUrl(video.relativePath)} />
      <form onSubmit={(event) => { event.preventDefault(); void save(video, event.currentTarget); }}>
        <label>Tiêu đề<input name="title" defaultValue={video.title} maxLength={300}/></label>
        <label>Caption Facebook<textarea name="caption" defaultValue={video.caption} maxLength={5000} rows={5} placeholder="Viết caption trước khi đăng Facebook"/></label>
        <p className="videoMeta">{formatter.format(video.size / 1024 / 1024)} · {new Date(video.modifiedAt).toLocaleString("vi-VN")}<br/>{video.relativePath}</p>
        {video.facebookVideoId ? <p className="published">Đã đăng Facebook · ID {video.facebookVideoId}</p> : null}
        <div className="cardActions"><button type="submit" disabled={busy !== null}>Lưu nội dung</button><button type="button" className="facebook" disabled={busy !== null} onClick={(event) => { const form = event.currentTarget.closest("form"); if (form) void publish(video, form); }}>Đăng Facebook</button></div>
      </form>
    </article>)}</div>}
  </section>;
}
