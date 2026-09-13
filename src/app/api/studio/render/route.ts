import { promises as fs } from "node:fs";
import path from "node:path";
import { appConfig, resolvedOutputPath, toRelativeOutputPath } from "@/lib/config";
import { saveVideoDetails } from "@/lib/video";
import { ensureStudioDirs, resolveStudioPath, runCommand, safeStudioName, studioRoot } from "@/lib/studio";
import { resolveLibraryPath, saveLibraryAsset } from "@/lib/studioLibrary";

export const runtime = "nodejs";
const MAX_IMAGES = 24;
const MAX_VIDEOS = 20;
const MAX_AUDIO_FILES = 20;
const MAX_AUDIO_SLOTS = 10;
const MAX_IMAGE_BYTES = 25 * 1024 * 1024;
const MAX_AUDIO_BYTES = 300 * 1024 * 1024;
const imageExtensions = new Set([".jpg", ".jpeg", ".png", ".webp", ".gif"]);
const videoExtensions = new Set([".mp4", ".mov", ".m4v", ".webm", ".mkv", ".avi"]);
const audioExtensions = new Set([".mp3", ".wav", ".m4a", ".aac", ".ogg", ".flac"]);

function safeUploadName(name: string, fallback: string) {
  const ext = path.extname(name).toLowerCase();
  return `${Date.now()}-${Math.random().toString(36).slice(2, 8)}${ext || fallback}`;
}

function requestedAssetName(form: FormData, key: string, fallback: string) {
  const value = String(form.get(key) || "").trim().slice(0, 200);
  return value || fallback;
}

async function saveUpload(file: File, dir: string, allowed: Set<string>, maxBytes: number, kind: string) {
  const ext = path.extname(file.name).toLowerCase();
  if (!allowed.has(ext) || (file.type && !file.type.startsWith(`${kind}/`) && kind === "image")) throw new Error(`Định dạng ${kind} không được hỗ trợ.`);
  if (file.size <= 0 || file.size > maxBytes) throw new Error(`File ${kind} quá lớn.`);
  const target = path.join(dir, safeUploadName(file.name, kind === "image" ? ".jpg" : ".mp3"));
  await fs.writeFile(target, Buffer.from(await file.arrayBuffer()), { mode: 0o640 });
  return target;
}

export async function POST(request: Request) {
  const tempFiles: string[] = [];
  const libraryAssets: Array<{ source: string; category: "images" | "audio"; name: string }> = [];
  try {
    const form = await request.formData();
    await ensureStudioDirs();
    const uploadDir = path.join(studioRoot(), "uploads", `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`);
    await fs.mkdir(uploadDir, { recursive: true });
    const hasIndexedImages = Array.from({ length: MAX_IMAGES }, (_, index) => form.has(`image_${index}`) || form.has(`imageLibraryPath_${index}`)).some(Boolean);
    const uploadedVideoEntries = form.getAll("videos").filter((entry): entry is File => entry instanceof File && entry.size > 0);
    const hasIndexedVideos = uploadedVideoEntries.length > 0 || Array.from({ length: MAX_VIDEOS }, (_, index) => form.has(`video_${index}`) || form.has(`videoLibraryPath_${index}`)).some(Boolean);
    if (hasIndexedVideos) {
      if (hasIndexedImages) return Response.json({ error: "Chỉ chọn ảnh hoặc video, không chọn cả hai." }, { status: 400 });
      const videoPaths: string[] = [];
      for (let index = 0; index < MAX_VIDEOS; index += 1) {
        const videoFile = form.get(`video_${index}`);
        if (videoFile instanceof File && videoFile.size > 0) {
          const videoPath = await saveUpload(videoFile, uploadDir, videoExtensions, 1_000 * 1024 * 1024, "video");
          videoPaths.push(videoPath);
          tempFiles.push(videoPath);
          continue;
        }
        const libraryPath = String(form.get(`videoLibraryPath_${index}`) || "").trim();
        if (!libraryPath) continue;
        const resolvedPath = resolvedOutputPath(libraryPath);
        const stat = await fs.stat(resolvedPath);
        if (!stat.isFile() || !videoExtensions.has(path.extname(resolvedPath).toLowerCase())) {
          throw new Error(`Video Library #${index + 1} không hợp lệ.`);
        }
        videoPaths.push(resolvedPath);
      }
      if (!videoPaths.length && uploadedVideoEntries.length) {
        if (uploadedVideoEntries.length > MAX_VIDEOS) return Response.json({ error: `Tối đa ${MAX_VIDEOS} video cho một lần nối.` }, { status: 400 });
        for (const videoFile of uploadedVideoEntries) {
          const videoPath = await saveUpload(videoFile, uploadDir, videoExtensions, 1_000 * 1024 * 1024, "video");
          videoPaths.push(videoPath);
          tempFiles.push(videoPath);
        }
      }
      if (!videoPaths.length) return Response.json({ error: "Chọn ít nhất một video để nối." }, { status: 400 });
      if (videoPaths.length > MAX_VIDEOS) return Response.json({ error: `Tối đa ${MAX_VIDEOS} video cho một lần nối.` }, { status: 400 });

      const videoInfo = await Promise.all(videoPaths.map(async (videoPath) => {
        const durationResult = await runCommand("ffprobe", ["-v", "error", "-show_entries", "format=duration", "-of", "default=noprint_wrappers=1:nokey=1", videoPath]);
        const duration = Number.parseFloat(durationResult.stdout.trim());
        if (!Number.isFinite(duration) || duration <= 0) throw new Error("Không đọc được thời lượng video.");
        const audioResult = await runCommand("ffprobe", ["-v", "error", "-select_streams", "a:0", "-show_entries", "stream=index", "-of", "csv=p=0", videoPath]);
        return { duration, hasAudio: Boolean(audioResult.stdout.trim()) };
      }));
      const videoFilters = videoPaths.map((_, index) => {
        const duration = videoInfo[index].duration.toFixed(3);
        const audio = videoInfo[index].hasAudio
          ? `[${index}:a:0]aresample=48000,aformat=sample_fmts=fltp:sample_rates=48000:channel_layouts=stereo,apad,atrim=duration=${duration},asetpts=PTS-STARTPTS[a${index}]`
          : `anullsrc=channel_layout=stereo:sample_rate=48000,atrim=duration=${duration},asetpts=PTS-STARTPTS[a${index}]`;
        return `[${index}:v]fps=30,scale=1080:1920:force_original_aspect_ratio=decrease,pad=1080:1920:(ow-iw)/2:(oh-ih)/2:color=black,setsar=1,format=yuv420p,setpts=PTS-STARTPTS[v${index}];${audio}`;
      }).join(";");
      const concatInputs = videoPaths.map((_, index) => `[v${index}][a${index}]`).join("");
      const filterComplex = `${videoFilters};${concatInputs}concat=n=${videoPaths.length}:v=1:a=1[vout][aout]`;
      const title = String(form.get("title") || "Video Studio").trim().slice(0, 300) || "Video Studio";
      const caption = String(form.get("caption") || "").trim().slice(0, 5000);
      const date = new Date().toISOString().slice(0, 10).replaceAll("-", "");
      const outputDir = path.join(appConfig.outputDir(), date, "studio");
      await fs.mkdir(outputDir, { recursive: true });
      const outputPath = path.join(outputDir, `${Date.now()}-${safeStudioName(title)}_studio.mp4`);
      const args = ["-y", "-hide_banner", "-loglevel", "error"];
      videoPaths.forEach((videoPath) => args.push("-i", videoPath));
      const totalDuration = videoInfo.reduce((sum, item) => sum + item.duration, 0);
      args.push("-filter_complex", filterComplex, "-map", "[vout]", "-map", "[aout]",
        "-c:v", "libx264", "-preset", "veryfast", "-crf", "22", "-pix_fmt", "yuv420p",
        "-c:a", "aac", "-b:a", "192k", "-movflags", "+faststart", "-t", totalDuration.toFixed(3), outputPath);
      await runCommand("ffmpeg", args);
      const relativePath = toRelativeOutputPath(outputPath);
      await saveVideoDetails(relativePath, { title, caption });
      return Response.json({ ok: true, path: relativePath }, { status: 201 });
    }
    const imagePaths: string[] = [];
    const uploadedImageEntries = form.getAll("images").filter((entry): entry is File => entry instanceof File);
    if (hasIndexedImages) {
      for (let index = 0; index < MAX_IMAGES; index += 1) {
        const imageFile = form.get(`image_${index}`);
        if (imageFile instanceof File && imageFile.size > 0) {
          const imagePath = await saveUpload(imageFile, path.join(studioRoot(), "uploads"), imageExtensions, MAX_IMAGE_BYTES, "image");
          imagePaths.push(imagePath);
          tempFiles.push(imagePath);
          libraryAssets.push({ source: imagePath, category: "images", name: requestedAssetName(form, `imageName_${index}`, imageFile.name) });
          continue;
        }
        const libraryPath = String(form.get(`imageLibraryPath_${index}`) || "").trim();
        if (!libraryPath) continue;
        const resolvedPath = resolveLibraryPath(libraryPath);
        const stat = await fs.stat(resolvedPath);
        if (!stat.isFile() || !imageExtensions.has(path.extname(resolvedPath).toLowerCase())) throw new Error(`Ảnh Library #${index + 1} không hợp lệ.`);
        imagePaths.push(resolvedPath);
      }
    } else {
      if (uploadedImageEntries.length > MAX_IMAGES) return Response.json({ error: `Tối đa ${MAX_IMAGES} ảnh cho một video.` }, { status: 400 });
      for (const file of uploadedImageEntries) {
        const imagePath = await saveUpload(file, uploadDir, imageExtensions, MAX_IMAGE_BYTES, "image");
        imagePaths.push(imagePath);
        tempFiles.push(imagePath);
        libraryAssets.push({ source: imagePath, category: "images", name: file.name });
      }
    }
    if (!imagePaths.length) return Response.json({ error: "Chọn ít nhất một ảnh." }, { status: 400 });
    if (imagePaths.length > MAX_IMAGES) return Response.json({ error: `Tối đa ${MAX_IMAGES} ảnh cho một video.` }, { status: 400 });
    const title = String(form.get("title") || "Video Studio").trim().slice(0, 300) || "Video Studio";
    const caption = String(form.get("caption") || "").trim().slice(0, 5000);
    let imageDurations: number[];
    try {
      const rawDurations = JSON.parse(String(form.get("imageDurations") || "[]")) as unknown;
      imageDurations = Array.isArray(rawDurations) ? rawDurations.map(Number) : [];
    } catch {
      imageDurations = [];
    }
    const legacyDuration = Number(form.get("imageDuration") || 4);
    if (imageDurations.length !== imagePaths.length) imageDurations = imagePaths.map(() => legacyDuration);
    if (imageDurations.some((duration) => !Number.isFinite(duration) || duration < 0.5 || duration > 60)) {
      return Response.json({ error: "Thời lượng mỗi ảnh phải từ 0.5 đến 60 giây." }, { status: 400 });
    }
    const audioPaths: string[] = [];
    const slotAudioPaths: string[] = [];
    for (let index = 0; index < MAX_AUDIO_SLOTS; index += 1) {
      const slotFile = form.get(`audio_${index}`);
      if (slotFile instanceof File && slotFile.size > 0) {
        const slotPath = await saveUpload(slotFile, uploadDir, audioExtensions, MAX_AUDIO_BYTES, "audio");
        slotAudioPaths.push(slotPath);
        tempFiles.push(slotPath);
        libraryAssets.push({ source: slotPath, category: "audio", name: requestedAssetName(form, `audioName_${index}`, slotFile.name) });
        continue;
      }
      const slotLibraryPath = String(form.get(`audioLibraryPath_${index}`) || "").trim();
      if (slotLibraryPath) {
        const resolvedPath = resolveLibraryPath(slotLibraryPath);
        const stat = await fs.stat(resolvedPath);
        if (!stat.isFile() || !audioExtensions.has(path.extname(resolvedPath).toLowerCase())) throw new Error(`Audio Library #${index + 1} không hợp lệ.`);
        slotAudioPaths.push(resolvedPath);
        continue;
      }
      const slotTtsPath = String(form.get(`ttsAudioPath_${index}`) || "").trim();
      if (slotTtsPath) {
        const resolvedPath = resolveStudioPath(slotTtsPath);
        const stat = await fs.stat(resolvedPath);
        if (!stat.isFile() || !audioExtensions.has(path.extname(resolvedPath).toLowerCase())) throw new Error(`Audio TTS #${index + 1} không hợp lệ.`);
        slotAudioPaths.push(resolvedPath);
        libraryAssets.push({ source: resolvedPath, category: "audio", name: requestedAssetName(form, `audioName_${index}`, path.basename(resolvedPath)) });
      }
    }
    const uploadedAudio = form.getAll("audio").filter((entry): entry is File => entry instanceof File && entry.size > 0);
    if (uploadedAudio.length > MAX_AUDIO_FILES) return Response.json({ error: `Tối đa ${MAX_AUDIO_FILES} file audio cho một video.` }, { status: 400 });
    for (const audioFile of slotAudioPaths.length ? [] : uploadedAudio) {
      const audioPath = await saveUpload(audioFile, uploadDir, audioExtensions, MAX_AUDIO_BYTES, "audio");
      audioPaths.push(audioPath);
      tempFiles.push(audioPath);
      libraryAssets.push({ source: audioPath, category: "audio", name: audioFile.name });
    }
    if (slotAudioPaths.length) {
      audioPaths.push(...slotAudioPaths);
    } else if (!audioPaths.length) {
      const ttsAudioPath = String(form.get("ttsAudioPath") || "").trim();
      if (ttsAudioPath) {
        const audioPath = resolveStudioPath(ttsAudioPath);
        const stat = await fs.stat(audioPath);
        if (!stat.isFile() || !audioExtensions.has(path.extname(audioPath).toLowerCase())) throw new Error("Audio TTS không hợp lệ.");
        audioPaths.push(audioPath);
        libraryAssets.push({ source: audioPath, category: "audio", name: requestedAssetName(form, "audioName", path.basename(audioPath)) });
      }
    }

    const filters = imagePaths.map((_, index) => {
      const duration = imageDurations[index].toFixed(3);
      return `[${index}:v]fps=30,trim=duration=${duration},setpts=PTS-STARTPTS,scale=1080:1920:force_original_aspect_ratio=decrease,pad=1080:1920:(ow-iw)/2:(oh-ih)/2:color=black,setsar=1,format=yuv420p[v${index}]`;
    }).join(";");
    const concatInputs = imagePaths.map((_, index) => `[v${index}]`).join("");
    const filterComplex = `${filters};${concatInputs}concat=n=${imagePaths.length}:v=1:a=0[vout]`;

    const date = new Date().toISOString().slice(0, 10).replaceAll("-", "");
    const outputDir = path.join(appConfig.outputDir(), date, "studio");
    await fs.mkdir(outputDir, { recursive: true });
    const outputPath = path.join(outputDir, `${Date.now()}-${safeStudioName(title)}_studio.mp4`);
    const args = ["-y", "-hide_banner", "-loglevel", "error"];
    imagePaths.forEach((imagePath) => args.push("-stream_loop", "-1", "-i", imagePath));
    audioPaths.forEach((audioPath) => args.push("-i", audioPath));
    const audioFilter = audioPaths.length > 1
      ? `;${audioPaths.map((_, index) => `[${imagePaths.length + index}:a:0]aresample=48000,aformat=sample_fmts=fltp:sample_rates=48000:channel_layouts=stereo[a${index}]`).join(";")};${audioPaths.map((_, index) => `[a${index}]`).join("")}concat=n=${audioPaths.length}:v=0:a=1[aout]`
      : "";
    args.push("-filter_complex", `${filterComplex}${audioFilter}`, "-map", "[vout]");
    if (audioPaths.length) args.push("-map", audioPaths.length > 1 ? "[aout]" : `${imagePaths.length}:a:0`, "-c:a", "aac", "-b:a", "192k");
    const totalDuration = imageDurations.reduce((sum, duration) => sum + duration, 0);
    args.push("-c:v", "libx264", "-preset", "veryfast", "-crf", "22", "-pix_fmt", "yuv420p", "-r", "30", "-movflags", "+faststart", "-t", totalDuration.toFixed(3), outputPath);
    await runCommand("ffmpeg", args);
    await Promise.all(libraryAssets.map((asset) => saveLibraryAsset(asset.source, asset.category, asset.name)));
    const relativePath = toRelativeOutputPath(outputPath);
    await saveVideoDetails(relativePath, { title, caption });
    return Response.json({ ok: true, path: relativePath }, { status: 201 });
  } catch (error) {
    return Response.json({ error: error instanceof Error ? error.message : "Không tạo được video." }, { status: 500 });
  } finally {
    // Uploaded images are temporary; generated TTS files are intentionally retained for reuse.
    await Promise.all(tempFiles.map(async (filePath) => { try { await fs.rm(filePath, { force: true }); } catch { /* ignore cleanup errors */ } }));
  }
}
