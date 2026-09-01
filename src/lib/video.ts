import { promises as fs } from "node:fs";
import path from "node:path";
import { appConfig, resolvedOutputPath, toRelativeOutputPath } from "@/lib/config";
import { ensureVideoCreatorSchema, query } from "@/lib/db";

export type VideoRecord = {
  relativePath: string; title: string; caption: string; size: number; modifiedAt: string;
  facebookVideoId: string | null; publishedAt: string | null;
};

type StoredVideo = { relative_path: string; title: string; caption: string; facebook_video_id: string | null; published_at: string | null };

async function discoverMp4Files(dir: string, level = 0): Promise<string[]> {
  if (level > 3) return [];
  const entries = await fs.readdir(dir, { withFileTypes: true }).catch(() => []);
  const found = await Promise.all(entries.map(async (entry) => {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) return discoverMp4Files(full, level + 1);
    return entry.isFile() && entry.name.toLowerCase().endsWith(".mp4") ? [full] : [];
  }));
  return found.flat();
}

export async function listVideos(): Promise<VideoRecord[]> {
  const files = await discoverMp4Files(appConfig.outputDir());
  const snapshots = await Promise.all(files.map(async (filePath) => ({ filePath, stat: await fs.stat(filePath) })));
  const relativePaths = snapshots.map(({ filePath }) => toRelativeOutputPath(filePath));
  let stored = new Map<string, StoredVideo>();
  try {
    await ensureVideoCreatorSchema();
    if (relativePaths.length) {
      const result = await query<StoredVideo>(`SELECT relative_path, title, caption, facebook_video_id, published_at
        FROM video_creator_videos WHERE relative_path = ANY($1::text[])`, [relativePaths]);
      stored = new Map(result.rows.map((item) => [item.relative_path, item]));
    }
  } catch { /* Video files still work when database is temporarily unavailable. */ }
  return snapshots.map(({ filePath, stat }) => {
    const relativePath = toRelativeOutputPath(filePath);
    const row = stored.get(relativePath);
    return {
      relativePath, title: row?.title || path.basename(filePath, ".mp4").replaceAll("_", " "),
      caption: row?.caption || "", size: stat.size, modifiedAt: stat.mtime.toISOString(),
      facebookVideoId: row?.facebook_video_id || null, publishedAt: row?.published_at || null,
    };
  }).sort((a, b) => b.modifiedAt.localeCompare(a.modifiedAt)).slice(0, 80);
}

export async function saveVideoDetails(relativePath: string, input: { title?: string; caption?: string }) {
  resolvedOutputPath(relativePath);
  await ensureVideoCreatorSchema();
  const title = (input.title || "").trim().slice(0, 300);
  const caption = (input.caption || "").trim().slice(0, 5000);
  await query(`INSERT INTO video_creator_videos (relative_path, title, caption, updated_at)
    VALUES ($1, $2, $3, NOW())
    ON CONFLICT (relative_path) DO UPDATE SET title = EXCLUDED.title, caption = EXCLUDED.caption, updated_at = NOW()`,
    [relativePath, title, caption]);
}

export async function markFacebookPublished(relativePath: string, videoId: string) {
  await ensureVideoCreatorSchema();
  await query(`INSERT INTO video_creator_videos (relative_path, facebook_video_id, published_at, updated_at)
    VALUES ($1, $2, NOW(), NOW())
    ON CONFLICT (relative_path) DO UPDATE SET facebook_video_id = EXCLUDED.facebook_video_id,
      published_at = NOW(), updated_at = NOW()`, [relativePath, videoId]);
}
