"use client";
/* eslint-disable @next/next/no-img-element */

import { useState } from "react";
import type { StudioAsset } from "@/lib/studioLibrary";
import type { VideoRecord } from "@/lib/video";
import styles from "./page.module.css";

const basePath = process.env.NEXT_PUBLIC_BASE_PATH || "";

type LibraryData = {
  images: StudioAsset[];
  audio: StudioAsset[];
  videos: VideoRecord[];
};

function assetUrl(relativePath: string) {
  return `${basePath}/api/studio/library/file?path=${encodeURIComponent(relativePath)}`;
}

function videoUrl(relativePath: string) {
  const encoded = btoa(unescape(encodeURIComponent(relativePath))).replaceAll("/", "_").replaceAll("+", "-");
  return `${basePath}/api/videos/${encoded}`;
}

export default function LibraryBrowser({ initialLibrary }: { initialLibrary: LibraryData }) {
  const [library, setLibrary] = useState(initialLibrary);
  const [deleting, setDeleting] = useState("");

  async function remove(category: keyof LibraryData, relativePath: string, label: string) {
    if (!window.confirm(`Remove ${label} from library? This action cannot be undone.`)) return;
    const key = `${category}:${relativePath}`;
    setDeleting(key);
    try {
      const response = await fetch(`${basePath}/api/studio/library`, {
        method: "DELETE",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ category, path: relativePath }),
      });
      const body = await response.json().catch(() => ({})) as { error?: string };
      if (!response.ok) throw new Error(body.error || "Could not delete item.");
      setLibrary((current) => ({ ...current, [category]: current[category].filter((item) => {
        const itemPath = "relativePath" in item ? item.relativePath : item.path;
        return itemPath !== relativePath;
      }) }));
    } catch (error) {
      window.alert(error instanceof Error ? error.message : "Could not delete item.");
    } finally {
      setDeleting("");
    }
  }

  return <>
    <section className={styles.section}><div className={styles.sectionTitle}><h2>Created Videos</h2><span>{library.videos.length} videos</span></div>{library.videos.length ? <div className={styles.videoGrid}>{library.videos.map((videos) => {
      const key = `videos:${videos.relativePath}`;
      return <article className={styles.videoCard} key={videos.relativePath}><video controls preload="metadata" src={videoUrl(videos.relativePath)} /><strong>{videos.title || videos.relativePath}</strong><small>{new Date(videos.modifiedAt).toLocaleString("en-US")}</small><button type="button" className={styles.deleteButton} disabled={deleting === key} onClick={() => void remove("videos", videos.relativePath, "video")}>{deleting === key ? "Deleting..." : "Delete Video"}</button></article>;
    })}</div> : <p className={styles.empty}>No videos yet.</p>}</section>
    <section className={styles.section}><div className={styles.sectionTitle}><h2>Used Images</h2><span>{library.images.length} images</span></div>{library.images.length ? <div className={styles.imageGrid}>{library.images.map((image) => {
      const key = `images:${image.path}`;
      return <figure key={image.path}><img src={assetUrl(image.path)} alt={image.name} loading="lazy" /><figcaption>{image.name}<small>{new Date(image.modifiedAt).toLocaleString("en-US")}</small></figcaption><button type="button" className={styles.deleteButton} disabled={deleting === key} onClick={() => void remove("images", image.path, "image")}>{deleting === key ? "Deleting..." : "Delete Image"}</button></figure>;
    })}</div> : <p className={styles.empty}>No saved images.</p>}</section>
    <section className={styles.section}><div className={styles.sectionTitle}><h2>Used Audio</h2><span>{library.audio.length} audio</span></div>{library.audio.length ? <div className={styles.audioGrid}>{library.audio.map((audio) => {
      const key = `audio:${audio.path}`;
      return <article className={styles.audioCard} key={audio.path}><strong>{audio.name}</strong><audio controls preload="metadata" src={assetUrl(audio.path)} /><small>{new Date(audio.modifiedAt).toLocaleString("en-US")}</small><button type="button" className={styles.deleteButton} disabled={deleting === key} onClick={() => void remove("audio", audio.path, "audio")}>{deleting === key ? "Deleting..." : "Remove Audio"}</button></article>;
    })}</div> : <p className={styles.empty}>No saved audio.</p>}</section>
  </>;
}
