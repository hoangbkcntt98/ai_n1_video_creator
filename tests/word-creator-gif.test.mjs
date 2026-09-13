import { test } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
const require = createRequire(import.meta.url);
const { chooseFps, overlayArguments, gifDelays } = require("../html-to-image.js");
const exec = promisify(execFile);

test("automatic integer FPS aligns all GIF transition times, not just average frame rate", () => {
  assert.deepEqual(chooseFps(25, []), { fps: 25, exact: true });
  assert.deepEqual(chooseFps(25, [0.08, 0.08]), { fps: 25, exact: true });
  assert.deepEqual(chooseFps(30, [0.08]), { fps: 50, exact: true });
  assert.deepEqual(chooseFps(60, [0.08]), { fps: 50, exact: true });
  assert.deepEqual(chooseFps(25, [0.1]), { fps: 30, exact: true });
  assert.deepEqual(chooseFps(25, [0.08, 0.1]), { fps: 50, exact: true });
  assert.deepEqual(chooseFps(25, [0.03, 0.07]), { fps: 60, exact: false });
  assert.throws(() => chooseFps(0, []), /FPS/);
  assert.throws(() => chooseFps(25, [NaN]), /GIF/);
});

test("multiple GIF overlays preserve original timestamps and layout", () => {
  const args = overlayArguments([
    { x: 20, y: 30, width: 200, height: 100, fit: "contain" },
    { x: 300, y: 500, width: 120, height: 150, fit: "cover" },
  ]);
  assert.equal(args[0], "-filter_complex");
  assert.match(args[1], /\[1:v\]setpts=PTS-STARTPTS/);
  assert.match(args[1], /\[2:v\]setpts=PTS-STARTPTS/);
  assert.match(args[1], /overlay=x=20:y=30:shortest=1/);
  assert.match(args[1], /overlay=x=300:y=500:shortest=1/);
  assert.match(args[1], /crop=120:150/);
  assert.equal(args.at(-1), "[out]");
  assert.equal(overlayArguments([])[0], "-vf");
});

// Opt-in local smoke: Chromium + FFmpeg only, no AI calls or uploads.
test("real GIF render selects 50 FPS, animates, and removes frames on success and failure", {
  skip: process.env.WORD_CREATOR_RENDER_SMOKE !== "1", timeout: 120_000,
}, async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "word-creator-gif-smoke-"));
  try {
    const delays = await gifDelays(path.resolve("spinning-bear.gif"));
    assert.ok(delays.every((delay) => delay === 0.08));
    const output = path.join(dir, "test.mp4");
    const quiz = path.join(dir, "quiz.json");
    await fs.writeFile(quiz, JSON.stringify({ Word: "遭う", AnswerA: "あう", AnswerB: "そうう", AnswerC: "あえる", AnswerD: "かう" }));
    const args = ["html-to-image.js", "--html", "template.html", "--data", quiz, "--output", output, "--duration", "0.4", "--fps", "30"];
    const result = await exec(process.execPath, args, { timeout: 90_000 });
    assert.match(result.stdout, /FPS thực tế: 50/);
    assert.match(result.stdout, /WORD_CREATOR_RESULT=.*"fps":50/);
    assert.equal((await fs.readdir(dir)).some((name) => name.startsWith(".frames-")), false);
    const info = JSON.parse((await exec("ffprobe", ["-v", "error", "-show_entries", "stream=r_frame_rate,nb_frames,width,height", "-show_entries", "format=duration", "-of", "json", output])).stdout);
    assert.equal(info.streams[0].r_frame_rate, "50/1");
    assert.equal(info.streams[0].nb_frames, "20");
    assert.equal(Number(info.format.duration), 0.4);
    const raw = await exec("ffmpeg", ["-v", "error", "-i", output, "-vf", "crop=330:300:87:1440,scale=32:32", "-pix_fmt", "gray", "-f", "rawvideo", "-"], { encoding: "buffer" });
    const frameSize = 32 * 32;
    const first = raw.stdout.subarray(0, frameSize);
    const later = raw.stdout.subarray(frameSize * 8, frameSize * 9);
    const difference = first.reduce((sum, pixel, index) => sum + Math.abs(pixel - later[index]), 0) / frameSize;
    assert.ok(difference > 1, `GIF crop must change, mean pixel difference ${difference}`);
    await assert.rejects(exec(process.execPath, args, { env: { ...process.env, FFMPEG_PATH: "/bin/false" }, timeout: 90_000 }));
    assert.equal((await fs.readdir(dir)).some((name) => name.startsWith(".frames-")), false);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});
