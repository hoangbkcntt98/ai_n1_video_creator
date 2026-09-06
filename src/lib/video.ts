import { promises as fs } from "node:fs";
import path from "node:path";
import { appConfig, resolvedOutputPath, toRelativeOutputPath } from "@/lib/config";
import { ensureVideoCreatorSchema, query } from "@/lib/db";

export type VideoRecord = {
  relativePath: string; title: string; caption: string; size: number; modifiedAt: string;
  facebookVideoId: string | null; scheduledPublishAt: string | null; publishedAt: string | null;
  youtubeVideoId: string | null; youtubeUploadedAt: string | null; youtubePrivacy: string | null;
};

type StoredVideo = {
  relative_path: string; title: string; caption: string; facebook_video_id: string | null;
  scheduled_publish_at: string | null; published_at: string | null;
  youtube_video_id: string | null; youtube_uploaded_at: string | null; youtube_privacy: string | null;
};

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
      const result = await query<StoredVideo>(`SELECT relative_path, title, caption, facebook_video_id, scheduled_publish_at, published_at,
        youtube_video_id, youtube_uploaded_at, youtube_privacy
        FROM video_creator_videos WHERE relative_path = ANY($1::text[])`, [relativePaths]);
      stored = new Map(result.rows.map((item) => [item.relative_path, item]));
    }
  } catch { /* Video files still work when database is temporarily unavailable. */ }
  const records = await Promise.all(snapshots.map(async ({ filePath, stat }) => {
    const relativePath = toRelativeOutputPath(filePath);
    const row = stored.get(relativePath);
    const fallbackTitle = path.basename(filePath, ".mp4").replace(/_video$/i, "").replaceAll("_", " ");
    const fallbackCaptionPath = path.join(
      appConfig.dataDir(),
      path.dirname(relativePath),
      `${path.basename(filePath, ".mp4").replace(/_video$/i, "")}_reel_caption.txt`,
    );
    const fallbackCaption = row?.caption
      ? ""
      : await fs.readFile(fallbackCaptionPath, "utf8").catch(() => "");
    return {
      relativePath, title: row?.title || fallbackTitle,
      caption: row?.caption || fallbackCaption.trim(), size: stat.size, modifiedAt: stat.mtime.toISOString(),
      facebookVideoId: row?.facebook_video_id || null,
      scheduledPublishAt: row?.scheduled_publish_at || null,
      publishedAt: row?.published_at || null,
      youtubeVideoId: row?.youtube_video_id || null,
      youtubeUploadedAt: row?.youtube_uploaded_at || null,
      youtubePrivacy: row?.youtube_privacy || null,
    };
  }));
  return records.sort((a, b) => b.modifiedAt.localeCompare(a.modifiedAt)).slice(0, 80);
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

export async function deleteVideo(relativePath: string) {
  const target = resolvedOutputPath(relativePath);
  if (!target.toLowerCase().endsWith(".mp4")) throw new Error("Chỉ có thể xóa file video MP4.");
  const stat = await fs.stat(target).catch(() => null);
  if (!stat?.isFile()) throw new Error("Không tìm thấy video.");
  await fs.unlink(target);
  try {
    await ensureVideoCreatorSchema();
    await query(`DELETE FROM video_creator_videos WHERE relative_path = $1`, [relativePath]);
  } catch {
    // The video is already deleted; stale metadata is harmless and can be cleaned later.
  }
}

export async function markFacebookPublished(relativePath: string, videoId: string) {
  await ensureVideoCreatorSchema();
  await query(`INSERT INTO video_creator_videos (relative_path, facebook_video_id, published_at, updated_at)
    VALUES ($1, $2, NOW(), NOW())
    ON CONFLICT (relative_path) DO UPDATE SET facebook_video_id = EXCLUDED.facebook_video_id,
      published_at = NOW(), updated_at = NOW()`, [relativePath, videoId]);
  await markGrammarPublished(relativePath, videoId);
}

export async function markYouTubeUploaded(relativePath: string, videoId: string, privacy: string) {
  await ensureVideoCreatorSchema();
  await query(`INSERT INTO video_creator_videos
      (relative_path, youtube_video_id, youtube_uploaded_at, youtube_privacy, updated_at)
    VALUES ($1, $2, NOW(), $3, NOW())
    ON CONFLICT (relative_path) DO UPDATE SET youtube_video_id = EXCLUDED.youtube_video_id,
      youtube_uploaded_at = CASE WHEN video_creator_videos.youtube_video_id = EXCLUDED.youtube_video_id
        THEN COALESCE(video_creator_videos.youtube_uploaded_at, NOW()) ELSE NOW() END,
      youtube_privacy = EXCLUDED.youtube_privacy, updated_at = NOW()`,
    [relativePath, videoId, privacy]);
}

async function markGrammarPublished(relativePath: string, videoId: string) {
  const patternName = path.basename(relativePath).replace(/_video\.mp4$/i, "");
  if (!patternName) return;
  try {
    const match = await query<{ id: number }>(
      `SELECT id FROM grammar_patterns WHERE pattern = $1 LIMIT 1`,
      [patternName],
    );
    const patternId = match.rows[0]?.id;
    if (!patternId) return;
    const pageId = process.env.FACEBOOK_PAGE_ID?.trim() || "1049787484892726";
    await query(
      `SELECT mark_grammar_ok(p_pattern_id := $1, p_facebook_video_id := $2, p_facebook_page_id := $3)`,
      [patternId, videoId, pageId],
    );
  } catch {
    // Facebook upload already succeeded; metadata sync must not turn it into
    // a failed upload run.
  }
}

export async function markFacebookScheduled(relativePath: string, videoId: string, scheduledAt: Date) {
  await ensureVideoCreatorSchema();
  await query(`INSERT INTO video_creator_videos (relative_path, facebook_video_id, scheduled_publish_at, published_at, updated_at)
    VALUES ($1, $2, $3, NULL, NOW())
    ON CONFLICT (relative_path) DO UPDATE SET facebook_video_id = EXCLUDED.facebook_video_id,
      scheduled_publish_at = EXCLUDED.scheduled_publish_at, published_at = NULL, updated_at = NOW()`,
    [relativePath, videoId, scheduledAt]);
}
