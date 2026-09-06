"use client";
/* eslint-disable @next/next/no-img-element */

import { useEffect, useMemo, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import styles from "./VideoStudio.module.css";

const basePath = process.env.NEXT_PUBLIC_BASE_PATH || "";
const voices = [
  ["ja-JP-NanamiNeural", "Nanami · Japanese"],
  ["ja-JP-KeitaNeural", "Keita · Japanese"],
  ["en-US-AriaNeural", "Aria · English"],
  ["vi-VN-HoaiMyNeural", "Hoài My · Vietnamese"],
] as const;
type AudioSlot = { file: File | null; libraryPath: string; name: string; ttsText: string; voice: string; ttsPath: string; ttsUrl: string };
type ImageItem = { file: File | null; path: string; name: string; size: number };
type LibraryAsset = { path: string; name: string; size: number };
const emptyAudioSlot = (): AudioSlot => ({ file: null, libraryPath: "", name: "", ttsText: "", voice: "ja-JP-NanamiNeural", ttsPath: "", ttsUrl: "" });

function videoUrl(relativePath: string) {
  const encoded = btoa(unescape(encodeURIComponent(relativePath))).replaceAll("/", "_").replaceAll("+", "-");
  return `${basePath}/api/videos/${encoded}`;
}

function assetUrl(relativePath: string) {
  return `${basePath}/api/studio/library/file?path=${encodeURIComponent(relativePath)}`;
}

export default function VideoStudio() {
  const router = useRouter();
  const imageInput = useRef<HTMLInputElement>(null);
  const audioInput = useRef<HTMLInputElement>(null);
  const [images, setImages] = useState<ImageItem[]>([]);
  const [audioSlots, setAudioSlots] = useState<AudioSlot[]>(() => Array.from({ length: 10 }, emptyAudioSlot));
  const [libraryImages, setLibraryImages] = useState<LibraryAsset[]>([]);
  const [libraryAudio, setLibraryAudio] = useState<LibraryAsset[]>([]);
  const [libraryPicker, setLibraryPicker] = useState<"images" | "audio" | null>(null);
  const [activeAudioSlot, setActiveAudioSlot] = useState(0);
  const [activeTtsSlot, setActiveTtsSlot] = useState<number | null>(null);
  const [title, setTitle] = useState("");
  const [caption, setCaption] = useState("");
  const [imageDurations, setImageDurations] = useState<number[]>([]);
  const [busy, setBusy] = useState<"tts" | "render" | null>(null);
  const [imagePrompt, setImagePrompt] = useState("");
  const [busyImage, setBusyImage] = useState(false);
  const [message, setMessage] = useState("");
  const [error, setError] = useState("");
  const [resultPath, setResultPath] = useState("");

  useEffect(() => {
    fetch(`${basePath}/api/studio/library`).then((response) => response.ok ? response.json() : Promise.reject(new Error("Could not read library."))).then((body: { images?: LibraryAsset[]; audio?: LibraryAsset[] }) => {
      setLibraryImages(body.images || []);
      setLibraryAudio(body.audio || []);
    }).catch(() => undefined);
  }, []);
  const totalSize = useMemo(() => images.reduce((sum, file) => sum + file.size, 0), [images]);
  function selectImages(event: React.ChangeEvent<HTMLInputElement>) {
    const selected = Array.from(event.target.files || []).slice(0, Math.max(0, 24 - images.length));
    setImages((current) => [...current, ...selected.map((file) => ({ file, path: "", name: file.name, size: file.size }))].slice(0, 24));
    setImageDurations((current) => [...current, ...selected.map(() => 4)].slice(0, 24));
    event.target.value = "";
  }
  function addLibraryImage(path: string) {
    const asset = libraryImages.find((item) => item.path === path);
    if (!asset || images.length >= 24) return;
    setImages((current) => [...current, { file: null, path: asset.path, name: asset.name, size: asset.size }]);
    setImageDurations((current) => [...current, 4]);
    setLibraryPicker(null);
  }
  function chooseLibraryAudio(path: string) {
    const asset = libraryAudio.find((item) => item.path === path);
    if (!asset) return;
    updateAudioSlot(activeAudioSlot, { file: null, libraryPath: asset.path, name: asset.name, ttsPath: "", ttsUrl: "" });
    setLibraryPicker(null);
  }
  function removeImage(index: number) {
    setImages((current) => current.filter((_, itemIndex) => itemIndex !== index));
    setImageDurations((current) => current.filter((_, itemIndex) => itemIndex !== index));
  }
  function updateImageDuration(index: number, value: string) {
    const parsed = Number(value);
    setImageDurations((current) => current.map((duration, itemIndex) => itemIndex === index ? (Number.isFinite(parsed) ? parsed : duration) : duration));
  }

  async function generateImage() {
    const prompt = imagePrompt.trim();
    if (!prompt || images.length >= 24) return;
    setError(""); setMessage(""); setBusyImage(true);
    try {
      const response = await fetch(`${basePath}/api/studio/image`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ prompt }),
      });
      const body = await response.json() as { error?: string; path?: string; name?: string; size?: number };
      if (!response.ok || !body.path) throw new Error(body.error || "Could not generate image.");
      const asset = { file: null, path: body.path, name: body.name || "generated-image.png", size: body.size || 0 };
      setImages((current) => [...current, asset].slice(0, 24));
      setImageDurations((current) => [...current, 4].slice(0, 24));
      setLibraryImages((current) => current.some((item) => item.path === asset.path) ? current : [...current, asset]);
      setImagePrompt("");
      setMessage("Image generated from prompt and added to scene list.");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not generate image.");
    } finally {
      setBusyImage(false);
    }
  }

  function updateAudioSlot(index: number, patch: Partial<AudioSlot>) {
    setAudioSlots((current) => current.map((slot, slotIndex) => slotIndex === index ? { ...slot, ...patch } : slot));
  }
  function chooseAudio(slotIndex: number) {
    setActiveAudioSlot(slotIndex);
    audioInput.current?.click();
  }
  async function generateTts(slotIndex: number) {
    const slot = audioSlots[slotIndex];
    if (!slot.ttsText.trim()) return;
    setError(""); setMessage(""); setBusy("tts"); setActiveTtsSlot(slotIndex);
    try {
      const response = await fetch(`${basePath}/api/studio/tts`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ text: slot.ttsText, voice: slot.voice }) });
      const body = await response.json() as { error?: string; audioPath?: string; audioUrl?: string };
      if (!response.ok) throw new Error(body.error || "Could not generate TTS.");
      updateAudioSlot(slotIndex, { file: null, libraryPath: "", name: slot.name || `tts-${slotIndex + 1}.mp3`, ttsPath: body.audioPath || "", ttsUrl: body.audioUrl ? `${basePath}${body.audioUrl}` : "" });
      setMessage(`Created TTS audio for audio #${slotIndex + 1}.`);
    } catch (err) { setError(err instanceof Error ? err.message : "Could not generate TTS."); }
    finally { setBusy(null); }
  }

  async function renderVideo() {
    setError(""); setMessage(""); setResultPath("");
    if (!images.length) { setError("Choose at least one image."); return; }
    setBusy("render");
    try {
      const form = new FormData();
      images.forEach((image, index) => {
        if (image.file) form.append(`image_${index}`, image.file);
        else form.set(`imageLibraryPath_${index}`, image.path);
        form.set(`imageName_${index}`, image.name.trim());
      });
      audioSlots.forEach((slot, index) => {
        if (slot.file) form.append(`audio_${index}`, slot.file);
        else if (slot.libraryPath) form.set(`audioLibraryPath_${index}`, slot.libraryPath);
        else if (slot.ttsPath) form.set(`ttsAudioPath_${index}`, slot.ttsPath);
        if (slot.name.trim()) form.set(`audioName_${index}`, slot.name.trim());
      });
      form.set("title", title); form.set("caption", caption); form.set("imageDurations", JSON.stringify(imageDurations));
      const response = await fetch(`${basePath}/api/studio/render`, { method: "POST", body: form });
      const body = await response.json() as { error?: string; path?: string };
      if (!response.ok) throw new Error(body.error || "Could not create video.");
      setResultPath(body.path || ""); setMessage("Video created and added to Video Library."); router.refresh();
    } catch (err) { setError(err instanceof Error ? err.message : "Could not create video."); }
    finally { setBusy(null); }
  }

  return <div className={styles.layout}>
    <section className={styles.panel}>
      <div className={styles.panelTitle}><div><p className="eyebrow">1 · IMAGES</p><h2>Choose Images for Scenes</h2></div><span>{images.length}/24 images</span></div>
      <div className={styles.libraryPickers}><button type="button" className="primary" onClick={() => imageInput.current?.click()} disabled={busy !== null || busyImage}>+ Upload Images</button><button type="button" onClick={() => setLibraryPicker("images")} disabled={busy !== null || busyImage || images.length >= 24}>+ Choose Image from Library</button></div>
      <input ref={imageInput} hidden type="file" accept="image/jpeg,image/png,image/webp,image/gif" multiple onChange={selectImages} />
      <div className={styles.generatedImage}>
        <label className={styles.field}>Image Generation Prompt<textarea rows={3} maxLength={12000} value={imagePrompt} onChange={(event) => setImagePrompt(event.target.value)} placeholder="Example: Tokyo street at night, cinematic style, vertical frame..." disabled={busy !== null || busyImage || images.length >= 24} /></label>
        <button type="button" onClick={() => void generateImage()} disabled={busy !== null || busyImage || images.length >= 24 || !imagePrompt.trim()}>{busyImage ? "Generating Image..." : "Generate Image from Prompt"}</button>
      </div>
      {images.length ? <div className={styles.fileList}>{images.map((image, index) => <div className={styles.fileRow} key={`${image.path || image.name}-${index}`}><span className={styles.index}>{index + 1}</span><span className={styles.fileInfo}><label className={styles.renameField}>Image Name<input type="text" value={image.name} maxLength={200} onChange={(event) => setImages((current) => current.map((item, itemIndex) => itemIndex === index ? { ...item, name: event.target.value } : item))} disabled={busy !== null} /></label><small>{image.path ? "From Library" : "New Upload"}</small><label className={styles.durationField}>Seconds<input type="number" min="0.5" max="60" step="0.5" value={imageDurations[index] ?? 4} onChange={(event) => updateImageDuration(index, event.target.value)} disabled={busy !== null} /></label></span><small>{(image.size / 1024 / 1024).toFixed(1)} MB</small><button type="button" onClick={() => removeImage(index)} disabled={busy !== null}>×</button></div>)}</div> : <p className={styles.hint}>Images are centered with a black background in a vertical 1080 × 1920 frame.</p>}
      <p className={styles.hint}>Set each image duration separately (0.5–60 seconds).</p>
      <p className={styles.meta}>{images.length ? `${(totalSize / 1024 / 1024).toFixed(1)} MB total` : ""}</p>
    </section>

    <section className={styles.panel}>
      <div className={styles.panelTitle}><div><p className="eyebrow">2 · AUDIO</p><h2>Background Music or Voiceover</h2></div></div>
      <input ref={audioInput} hidden type="file" accept="audio/*" onChange={(event) => { const file = event.target.files?.[0] || null; if (file) updateAudioSlot(activeAudioSlot, { file, libraryPath: "", name: file.name, ttsPath: "", ttsUrl: "" }); event.target.value = ""; }} />
      <div className={styles.audioSlots}>{audioSlots.map((slot, index) => <div className={styles.audioSlot} key={index}>
        <div className={styles.audioSlotHeader}><span className={styles.audioNumber}>{index + 1}</span><strong>Audio #{index + 1}</strong>{slot.file ? <small>{slot.file.name}</small> : slot.libraryPath ? <small>From Library</small> : slot.ttsPath ? <small>Generated with TTS</small> : <small>No audio</small>}</div>
        <label className={styles.renameField}>Audio Name<input type="text" value={slot.name} maxLength={200} onChange={(event) => updateAudioSlot(index, { name: event.target.value })} placeholder={`audio-${index + 1}.mp3`} disabled={busy !== null} /></label>
        <div className={styles.audioSlotActions}><button type="button" onClick={() => chooseAudio(index)} disabled={busy !== null}>Upload Audio</button><button type="button" onClick={() => { setActiveAudioSlot(index); setLibraryPicker("audio"); }} disabled={busy !== null}>Choose from Library</button>{slot.file || slot.libraryPath ? <button type="button" onClick={() => updateAudioSlot(index, { file: null, libraryPath: "", name: "" })} disabled={busy !== null}>Remove Audio</button> : null}</div>
        <label className={styles.field}>TTS Content<textarea rows={2} maxLength={12000} value={slot.ttsText} onChange={(event) => updateAudioSlot(index, { ttsText: event.target.value })} placeholder="Or enter narration for this audio..." disabled={busy !== null || Boolean(slot.file) || Boolean(slot.libraryPath)} /></label>
        <div className={styles.audioSlotBottom}><select value={slot.voice} onChange={(event) => updateAudioSlot(index, { voice: event.target.value })} disabled={busy !== null || Boolean(slot.file) || Boolean(slot.libraryPath)}>{voices.map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select><button type="button" onClick={() => void generateTts(index)} disabled={busy !== null || Boolean(slot.file) || Boolean(slot.libraryPath) || !slot.ttsText.trim()}>{busy === "tts" && activeTtsSlot === index ? "Generating..." : "Generate TTS"}</button>{slot.ttsUrl ? <audio controls src={slot.ttsUrl} /> : null}</div>
      </div>)}</div>
      <p className={styles.hint}>Choose one audio file or generate TTS for each record. Audio is concatenated in order #1 → #10.</p>
    </section>

    <section className={`${styles.panel} ${styles.details}`}>
      <div className={styles.panelTitle}><div><p className="eyebrow">3 · VIDEO EXPORT</p><h2>Video Details</h2></div></div>
      <label className={styles.field}>Title (optional)<input type="text" maxLength={300} value={title} onChange={(event) => setTitle(event.target.value)} placeholder="Video Studio" /></label>
      <label className={styles.field}>Facebook Caption (optional)<textarea rows={5} maxLength={5000} value={caption} onChange={(event) => setCaption(event.target.value)} placeholder="You can edit the caption before publishing in Video Library." /></label>
      <button type="button" className="primary" onClick={() => void renderVideo()} disabled={busy !== null || !images.length}>{busy === "render" ? "Rendering video..." : "Create MP4 Video"}</button>
      {message ? <p className={styles.success} role="status">{message}</p> : null}{error ? <p className={styles.error} role="alert">{error}</p> : null}
      {resultPath ? <div className={styles.result}><video controls src={videoUrl(resultPath)} /><a href={videoUrl(resultPath)} target="_blank" rel="noreferrer">Open Created Video</a><small>{resultPath}</small></div> : null}
    </section>
    {libraryPicker ? <div className={styles.modalBackdrop} role="presentation" onMouseDown={() => setLibraryPicker(null)}><div className={styles.libraryModal} role="dialog" aria-modal="true" aria-labelledby="library-picker-title" onMouseDown={(event) => event.stopPropagation()}><div className={styles.modalHeader}><div><p className="eyebrow">LIBRARY</p><h2 id="library-picker-title">{libraryPicker === "images" ? "Choose Image from Library" : "Choose Audio from Library"}</h2></div><button type="button" onClick={() => setLibraryPicker(null)} aria-label="Close">×</button></div>{(libraryPicker === "images" ? libraryImages : libraryAudio).length ? <div className={styles.libraryGrid}>{(libraryPicker === "images" ? libraryImages : libraryAudio).map((asset) => <article className={styles.libraryCard} key={asset.path}>{libraryPicker === "images" ? <img src={assetUrl(asset.path)} alt={asset.name} loading="lazy" /> : <audio controls preload="metadata" src={assetUrl(asset.path)} />}<strong title={asset.name}>{asset.name}</strong><small>{(asset.size / 1024 / 1024).toFixed(1)} MB</small><button type="button" className="primary" onClick={() => libraryPicker === "images" ? addLibraryImage(asset.path) : chooseLibraryAudio(asset.path)}>Select</button></article>)}</div> : <p className={styles.hint}>Library has no {libraryPicker === "images" ? "images" : "audio"}.</p>}</div></div> : null}
  </div>;
}
