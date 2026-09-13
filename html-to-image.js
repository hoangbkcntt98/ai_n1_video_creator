/* eslint-disable @typescript-eslint/no-require-imports */
const puppeteer = require("puppeteer-core");
const fs = require("fs");
const path = require("path");
const { execFile } = require("child_process");
const { promisify } = require("util");
const { pathToFileURL, fileURLToPath } = require("url");

const execFileAsync = promisify(execFile);

function option(name, fallback) {
  const index = process.argv.indexOf(name);
  return index >= 0 && process.argv[index + 1] ? process.argv[index + 1] : fallback;
}

function browserExecutable() {
  const candidates = [
    process.env.PUPPETEER_EXECUTABLE_PATH,
    "/usr/bin/google-chrome",
    "/usr/bin/chromium",
    "/usr/bin/chromium-browser",
    "/home/opc/.cache/ms-playwright/chromium-1243/chrome-linux-arm64/chrome",
  ].filter(Boolean);
  return candidates.find((candidate) => fs.statSync(candidate, { throwIfNoEntry: false })?.isFile()) || candidates[0];
}

function chooseFps(requested, delays) {
  if (!Number.isInteger(requested) || requested < 1 || requested > 60) throw new Error("FPS phải từ 1 đến 60.");
  if (!delays.length) return { fps: requested, exact: true };
  const gcd = (a, b) => b ? gcd(b, a % b) : a;
  // GIF delays use centiseconds. Include 100 to find an INTEGER video rate
  // whose frame boundaries contain every GIF transition (80ms => 25 FPS).
  const divisor = delays.reduce((value, seconds) => {
    if (!Number.isFinite(seconds) || seconds <= 0) throw new Error("GIF có thời lượng frame không hợp lệ.");
    return gcd(value, Math.max(1, Math.round(seconds * 100)));
  }, 100);
  const step = 100 / divisor;
  if (step > 60) return { fps: 60, exact: false };
  const next = Math.ceil(requested / step) * step;
  return { fps: next <= 60 ? next : Math.floor(60 / step) * step, exact: true };
}

async function gifDelays(file) {
  const { stdout } = await execFileAsync(process.env.FFPROBE_PATH || "ffprobe", [
    "-v", "error", "-ignore_loop", "1", "-select_streams", "v:0",
    "-show_entries", "frame=pkt_duration_time,duration_time", "-of", "json", file,
  ], { maxBuffer: 12 * 1024 * 1024, timeout: 60_000 });
  const frames = JSON.parse(stdout).frames;
  if (!frames?.length) throw new Error(`Không đọc được frame GIF: ${file}`);
  return frames.map((frame) => Number(frame.duration_time ?? frame.pkt_duration_time));
}

function overlayArguments(overlays) {
  if (!overlays.length) return ["-vf", "pad=ceil(iw/2)*2:ceil(ih/2)*2"];
  const filters = ["[0:v]setpts=PTS-STARTPTS[bg0]"];
  overlays.forEach(({ x, y, width, height, fit }, i) => {
    if (![x, y, width, height].every(Number.isInteger) || width < 1 || height < 1) throw new Error("Kích thước GIF không hợp lệ.");
    const scale = fit === "fill" ? `scale=${width}:${height}` : fit === "cover"
      ? `scale=${width}:${height}:force_original_aspect_ratio=increase,crop=${width}:${height}`
      : `scale=${width}:${height}:force_original_aspect_ratio=decrease,format=rgba,pad=${width}:${height}:(ow-iw)/2:(oh-ih)/2:color=black@0`;
    filters.push(`[${i + 1}:v]setpts=PTS-STARTPTS,${scale},format=rgba[gif${i}]`);
    filters.push(`[bg${i}][gif${i}]overlay=x=${x}:y=${y}:shortest=1:format=auto[bg${i + 1}]`);
  });
  filters.push(`[bg${overlays.length}]pad=ceil(iw/2)*2:ceil(ih/2)*2[out]`);
  return ["-filter_complex", filters.join(";"), "-map", "[out]"];
}

async function main() {
  const firstArgument = process.argv[2] || "";
  const legacyDataPath = firstArgument && !firstArgument.startsWith("--") && firstArgument.endsWith(".json")
    ? firstArgument
    : "";
  const positional = firstArgument.startsWith("--") ? [] : process.argv.slice(2);
  const htmlFallback = legacyDataPath ? path.join(__dirname, "template.html") : (positional[0] || path.join(__dirname, "template.html"));
  const outputFallback = positional[1] || path.join(__dirname, "word-creator.mp4");
  const durationFallback = positional[2] || process.env.DURATION || 10;
  const fpsFallback = positional[3] || process.env.FPS || 25;
  const htmlPath = path.resolve(option("--html", htmlFallback));
  const videoPath = path.resolve(option("--output", outputFallback));
  const duration = Number(option("--duration", durationFallback));
  const highlightDuration = 2; // 2 seconds to show correct answer
  const requestedFps = Number(option("--fps", fpsFallback));
  const autoFps = !process.argv.includes("--fixed-fps");
  let fps = requestedFps;
  const dataPath = option("--data", legacyDataPath);

  if (!Number.isInteger(fps) || fps < 1 || fps > 60 || !Number.isFinite(duration) || duration <= 0 || duration > 300) {
    throw new Error("FPS phải từ 1 đến 60; duration phải lớn hơn 0 và không quá 300 giây.");
  }
  if (!fs.statSync(htmlPath, { throwIfNoEntry: false })?.isFile()) {
    throw new Error(`Không tìm thấy HTML: ${htmlPath}`);
  }
  if (!fs.statSync(browserExecutable(), { throwIfNoEntry: false })?.isFile()) {
    throw new Error(`Không tìm thấy Chromium. Đặt PUPPETEER_EXECUTABLE_PATH hoặc cài Chromium: ${browserExecutable()}`);
  }

  fs.mkdirSync(path.dirname(videoPath), { recursive: true });
  const frameDir = fs.mkdtempSync(path.join(path.dirname(videoPath), ".frames-"));
  let frameCount;

  let browser;
  try {
    browser = await puppeteer.launch({
      executablePath: browserExecutable(),
      headless: true,
      args: [
        "--no-sandbox",
        "--disable-setuid-sandbox",
        "--disable-dev-shm-usage",
        "--disable-background-timer-throttling",
        "--disable-renderer-backgrounding",
      ],
    });
    const page = await browser.newPage();
    await page.setViewport({ width: 1080, height: 1920, deviceScaleFactor: 1 });

    const url = pathToFileURL(htmlPath);
    url.searchParams.set("export", "1");
    await page.goto(url.href, { waitUntil: "networkidle0" });
    await page.evaluate(async () => {
      await document.fonts.ready;
      await Promise.all(Array.from(document.images, (image) => image.decode().catch(() => {})));
    });

    if (dataPath) {
      const data = JSON.parse(fs.readFileSync(path.resolve(dataPath), "utf8"));
      await page.evaluate((quiz) => {
        window.setQuiz?.(quiz);
        if (typeof quiz.correctIndex === "number") window.quizCorrectIndex = quiz.correctIndex;
      }, data);
    }
    await page.evaluate(() => window.fitText?.());

    const reel = await page.$("#reel");
    if (!reel) throw new Error("Không tìm thấy #reel.");
    const bounds = await reel.boundingBox();
    if (!bounds || Math.round(bounds.width) !== 1080 || Math.round(bounds.height) !== 1920) {
      throw new Error("Canvas phải là 1080×1920.");
    }

    // Like refer/: screenshot HTML without GIF, then overlay original GIF
    // timestamps using FFmpeg. Screenshot wall-clock speed cannot alter GIFs.
    const overlays = await page.evaluate(() => {
      const root = document.querySelector("#reel");
      const reelBox = root.getBoundingClientRect();
      return Array.from(root.querySelectorAll("img")).flatMap((image) => {
        const src = image.currentSrc || image.src;
        if (!/\.gif(?:[?#]|$)|^data:image\/gif[;,]/i.test(src)) return [];
        const box = image.getBoundingClientRect();
        const style = getComputedStyle(image);
        if (!box.width || !box.height || style.visibility === "hidden" || image.hidden) return [];
        if (!image.naturalWidth) throw new Error(`Không tải được GIF: ${src}`);
        image.style.visibility = "hidden";
        return [{ src, x: Math.round(box.x - reelBox.x), y: Math.round(box.y - reelBox.y),
          width: Math.round(box.width), height: Math.round(box.height), fit: style.objectFit }];
      });
    });
    const delays = [];
    const cache = new Map();
    for (const [index, overlay] of overlays.entries()) {
      let asset = cache.get(overlay.src);
      if (!asset) {
        let file;
        if (overlay.src.startsWith("file:")) file = fileURLToPath(overlay.src);
        else if (overlay.src.startsWith("data:image/gif")) {
          const match = /^data:image\/gif;base64,(.+)$/i.exec(overlay.src);
          if (!match) throw new Error("GIF data URL phải dùng base64.");
          file = path.join(frameDir, `gif-${index}.gif`);
          fs.writeFileSync(file, Buffer.from(match[1], "base64"));
        } else {
          throw new Error("GIF phải là file cục bộ hoặc data URL base64. Hãy tải GIF vào thư mục template.");
        }
        asset = { file, delays: await gifDelays(file) };
        cache.set(overlay.src, asset);
        delays.push(...asset.delays);
      }
      overlay.file = asset.file;
    }
    const selection = autoFps ? chooseFps(requestedFps, delays) : { fps: requestedFps, exact: false };
    fps = selection.fps;
    const totalDuration = duration + highlightDuration;
    frameCount = Math.max(1, Math.ceil(totalDuration * fps));
    console.log(`FPS yêu cầu: ${requestedFps}; FPS thực tế: ${fps}; ${overlays.length} GIF; ${frameCount} frame.${autoFps && !selection.exact ? " Giới hạn 60 FPS: một số mốc GIF sẽ được lấy mẫu gần nhất." : ""}`);
    for (let index = 0; index < frameCount; index += 1) {
      const time = index / fps;
      const isHighlightPhase = time >= duration;
      await page.evaluate(({ time, total, isHighlight }) => {
        for (const animation of document.getAnimations()) {
          animation.pause();
          animation.currentTime = time * 1000;
        }
        window.renderFrame?.(Math.min(time, total), total);
        if (isHighlight && typeof window.setCorrectAnswer === "function" && typeof window.quizCorrectIndex === "number") {
          window.setCorrectAnswer(window.quizCorrectIndex);
        }
      }, {
        time,
        total: duration,
        isHighlight: isHighlightPhase,
      });
      await reel.screenshot({
        path: path.join(frameDir, `frame-${String(index).padStart(6, "0")}.png`),
        type: "png",
      });
      if ((index + 1) % fps === 0 || index === frameCount - 1) console.log(`Đã chụp ${index + 1}/${frameCount} frame.`);
    }

    console.log("Đang ghép frame và GIF thành MP4.");
    await execFileAsync(process.env.FFMPEG_PATH || "ffmpeg", [
      "-y",
      "-hide_banner",
      "-loglevel",
      "error",
      "-framerate",
      String(fps),
      "-i",
      path.join(frameDir, "frame-%06d.png"),
      ...overlays.flatMap((overlay) => ["-stream_loop", "-1", "-ignore_loop", "1", "-i", overlay.file]),
      ...overlayArguments(overlays),
      "-frames:v", String(frameCount),
      "-an",
      "-c:v",
      "libx264",
      "-preset",
      "veryfast",
      "-crf",
      "20",
      "-pix_fmt",
      "yuv420p",
      "-r",
      String(fps),
      "-movflags",
      "+faststart",
      "-t",
      (duration + highlightDuration).toFixed(3),
      videoPath,
    ], { maxBuffer: 12 * 1024 * 1024 });
  } finally {
    await browser?.close().catch(() => undefined);
    fs.rmSync(frameDir, { recursive: true, force: true });
  }

  console.log(`Đã tạo video ${videoPath} từ ${frameCount} frame; đã xóa frame tạm.`);
  console.log(`WORD_CREATOR_RESULT=${JSON.stringify({ fps, frameCount, duration, highlightDuration, totalDuration: duration + highlightDuration, videoPath })}`);
}

module.exports = { chooseFps, gifDelays, overlayArguments };
if (require.main === module) main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
