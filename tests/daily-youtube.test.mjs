import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";
import { EventEmitter } from "node:events";
import ts from "typescript";

function load(file, mocks) {
  const exports = {};
  const source = ts.transpileModule(fs.readFileSync(file, "utf8"), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020, esModuleInterop: true },
  }).outputText;
  vm.runInNewContext(source, { exports, require: (name) => {
    if (!(name in mocks)) throw new Error(`Unexpected import ${name}`);
    return mocks[name];
  }, process, Buffer, Error, console, setInterval: () => ({ unref() {} }), clearInterval() {} });
  return exports;
}
const youtube = load("src/lib/youtube.ts", {});
const settings = { privacy: "private", madeForKids: false, containsSyntheticMedia: true };

function pipelineHarness() {
  const rows = [];
  const files = new Map([["/data/20260911/example_reel_caption.txt", "Generated caption"]]);
  const workers = new Map();
  const scheduleErrors = [];
  const savedVideos = [];
  async function query(sql, values = []) {
    const row = rows.find((r) => r.id === values[0]);
    if (sql.includes("INSERT INTO video_creator_runs")) {
      assert.equal(rows.some((r) => r.status === "running"), false, "Only one pipeline/upload may run at a time");
      const run = { id: rows.length + 1, action: values[0], log_path: values[3], status: "running", runner_pid: null,
        after_run_publish: values[4] ? JSON.parse(values[4]) : null };
      rows.push(run);
      return { rows: [{ ...run }] };
    }
    if (sql.includes("WITH pending AS")) {
      if (!row?.after_run_publish || row.status === "running") return { rows: [] };
      const claimed = { after_run_publish: row.after_run_publish, status: row.status, error: row.error };
      row.after_run_publish = null;
      return { rows: [claimed] };
    }
    if (sql.includes("SET status = $2")) {
      Object.assign(row, { status: values[1], error: values[2], output_video: values[3], runner_pid: null });
    } else if (sql.includes("SET runner_pid = $2")) {
      if (row.status === "running") row.runner_pid = values[1];
    } else if (sql.includes("SET after_run_publish = NULL")) {
      row.after_run_publish = null;
    } else if (sql.includes("UPDATE video_creator_schedule")) {
      scheduleErrors.push(values[1]);
    } else if (sql.includes("WHERE status = 'running'")) {
      return { rows: rows.filter((r) => r.status === "running" && r.runner_pid).map((r) => ({ ...r })) };
    } else if (sql.includes("WHERE status <> 'running'")) {
      return { rows: rows.filter((r) => r.status !== "running" && r.after_run_publish).map((r) => ({ ...r })) };
    } else throw new Error(`Unexpected SQL: ${sql}`);
    return { rows: [] };
  }
  const fakeFs = {
    mkdir: async () => {}, chmod: async () => {}, access: async () => {},
    realpath: async (name) => name,
    stat: async () => ({ isFile: () => true, size: 1024 }),
    writeFile: async (name, value) => { files.set(name, value); },
    readFile: async (name) => { if (!files.has(name)) throw new Error("Not found"); return files.get(name); },
    appendFile: async (name, value) => { files.set(name, (files.get(name) || "") + value); },
  };
  const api = load("src/lib/pipeline.ts", {
    "node:fs": { promises: fakeFs, appendFileSync: (name, value) => files.set(name, (files.get(name) || "") + value), openSync: () => 1, closeSync() {} },
    "node:path": path,
    "node:child_process": { spawn: () => {
      const id = rows.at(-1).id;
      const child = new EventEmitter(); child.pid = 1000 + id; child.unref = () => {};
      workers.set(id, child);
      return child;
    } },
    "@/lib/config": {
      appConfig: { logDir: () => "/logs", dataDir: () => "/data", skillDir: () => "/skill", outputDir: () => "/outputs",
        pipelineConfig: () => ({ facebook: { pageId: "test-page", pageToken: "test-token" } }) },
      resolvedOutputPath: (name) => path.join("/outputs", name),
      toRelativeOutputPath: (name) => path.relative("/outputs", name),
    },
    "@/lib/db": { ensureVideoCreatorSchema: async () => {}, query, processAlive: () => false },
    "@/lib/video": { markFacebookPublished: async () => {}, markFacebookScheduled: async () => {},
      markYouTubeUploaded: async (...args) => { savedVideos.push(args); }, saveVideoDetails: async () => {} },
    "@/lib/youtube": { ...youtube, youtubeConfiguration: () => ({ configured: true, missing: [] }) },
  });
  async function finish(id, code = 0, output) {
    const row = rows.find((r) => r.id === id);
    files.set(row.log_path, output ?? (row.action === "create_next"
      ? 'Video ready: /outputs/20260911/example_video.mp4\n{"success":true}\n'
      : row.action === "publish" ? '{"success":true,"video_id":"facebook-id"}\n'
        : '{"success":true,"video_id":"abcdefghijk","video_path":"/outputs/20260911/example_video.mp4","privacy_status":"private"}\n'));
    workers.get(id).emit("close", code);
    for (let i = 0; i < 8; i++) await new Promise(setImmediate);
  }
  return { api, rows, files, finish, scheduleErrors, savedVideos };
}

test("daily YouTube opt-in uses generated title/caption and saves upload result", async () => {
  const h = pipelineHarness();
  const run = await h.api.startGeneration({ youtube: settings });
  assert.equal(h.rows.length, 1);
  assert.deepEqual(h.rows[0].after_run_publish.youtube, settings);
  await h.finish(run.id);
  assert.deepEqual(h.rows.map((r) => r.action), ["create_next", "youtube_publish"]);
  const job = JSON.parse(h.files.get(`${h.rows[1].log_path}.json`));
  assert.equal(job.title, "example");
  assert.equal(job.description, "Generated caption");
  assert.equal(job.madeForKids, false);
  assert.equal(job.containsSyntheticMedia, true);
  await h.finish(2);
  assert.equal(h.savedVideos.length, 1);
  assert.equal(h.rows[1].status, "success");
});

test("both platforms upload sequentially, including Facebook failure", async () => {
  for (const failed of [false, true]) {
    const h = pipelineHarness();
    await h.api.startGeneration({ publishToFacebook: true, youtube: settings });
    await h.finish(1);
    assert.deepEqual(h.rows.map((r) => r.action), ["create_next", "publish"]);
    await h.finish(2, failed ? 1 : 0, failed ? "Facebook upload failed" : undefined);
    assert.deepEqual(h.rows.map((r) => r.action), ["create_next", "publish", "youtube_publish"]);
    if (failed) assert.match(h.scheduleErrors[0], /Run #2 failed/);
  }
});

test("disabled YouTube and failed generation never start a YouTube upload", async () => {
  const h = pipelineHarness();
  await h.api.startGeneration({});
  await h.finish(1);
  assert.equal(h.rows.length, 1);
  await h.api.startGeneration({ youtube: settings });
  await h.finish(2, 1, "Generation failed");
  assert.equal(h.rows.length, 2);
  assert.match(h.scheduleErrors[0], /Generation failed/);
});

test("Facebook-only automation keeps working", async () => {
  const h = pipelineHarness();
  await h.api.startGeneration({ publishToFacebook: true });
  await h.finish(1);
  await h.finish(2);
  assert.deepEqual(h.rows.map((r) => r.action), ["create_next", "publish"]);
});

test("restart recovers saved continuation once, even when Facebook worker ended", async () => {
  const h = pipelineHarness();
  await h.api.startGeneration({ publishToFacebook: true, youtube: settings });
  await h.finish(1);
  h.files.set(h.rows[1].log_path, '{"success":true,"video_id":"facebook-id"}\n');
  await h.api.resumeActiveRuns();
  assert.deepEqual(h.rows.map((r) => r.action), ["create_next", "publish", "youtube_publish"]);
  await h.finish(3);
  await h.api.resumeActiveRuns();
  assert.equal(h.rows.length, 3, "Restart must not duplicate uploads");
});

test("invalid generated YouTube metadata reports error without starting upload", async () => {
  const h = pipelineHarness();
  h.files.set("/data/20260911/example_reel_caption.txt", "日".repeat(1667));
  await h.api.startGeneration({ youtube: settings });
  await h.finish(1);
  assert.equal(h.rows.length, 1);
  assert.equal(h.rows[0].status, "success", "Video generation remains successful");
  assert.match(h.scheduleErrors[0], /5000 UTF-8 bytes/);
});

test("schedule validates YouTube settings and persists independent Facebook/YouTube choices", async () => {
  const calls = [];
  const scheduler = load("src/lib/scheduler.ts", {
    "@/lib/db": { ensureVideoCreatorSchema: async () => {}, query: async (sql, values) => {
      calls.push({ sql, values });
      return { rows: [{ enabled: values[0], run_time: values[1], timezone: values[2], force_recreate: values[3],
        publish_to_facebook: values[4], publish_to_youtube: values[5], youtube_privacy: values[6],
        youtube_made_for_kids: values[7], youtube_contains_synthetic_media: values[8] }] };
    } },
    "@/lib/pipeline": {}, "@/lib/quotaScheduler": {},
    "@/lib/youtube": { ...youtube, youtubeConfiguration: () => ({ configured: true }) },
  });
  const input = { enabled: true, runTime: "09:00", timezone: "UTC", forceRecreate: false, publishToFacebook: true,
    publishToYouTube: true, youtubePrivacy: "public", youtubeMadeForKids: false, youtubeContainsSyntheticMedia: true };
  const result = await scheduler.updateDailySchedule(input);
  assert.equal(result.publishToFacebook, true);
  assert.equal(result.publishToYouTube, true);
  assert.equal(result.youtubePrivacy, "public");
  assert.equal(result.youtubeMadeForKids, false);
  for (const change of [{ youtubePrivacy: "invalid" }, { youtubeMadeForKids: null }, { youtubeContainsSyntheticMedia: null }]) {
    await assert.rejects(scheduler.updateDailySchedule({ ...input, ...change }));
  }
  assert.equal(calls.length, 1);
  const disabled = await scheduler.updateDailySchedule({ ...input, publishToYouTube: false, youtubeMadeForKids: null });
  assert.equal(disabled.publishToYouTube, false);
});
