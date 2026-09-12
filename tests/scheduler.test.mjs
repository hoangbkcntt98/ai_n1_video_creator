import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import vm from "node:vm";
import ts from "typescript";

function load(file, mocks, extra = {}) {
  const exports = {};
  const source = ts.transpileModule(fs.readFileSync(file, "utf8"), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020, esModuleInterop: true },
  }).outputText;
  vm.runInNewContext(source, { exports, require: (name) => {
    if (!(name in mocks)) throw new Error(`Unexpected import ${name}`);
    return mocks[name];
  }, process, Buffer, Error, Response, Date, console, ...extra });
  return exports;
}
const youtube = load("src/lib/youtube.ts", {});
function scheduler(query = async () => ({ rows: [] })) {
  return load("src/lib/scheduler.ts", {
    "@/lib/db": { ensureVideoCreatorSchema: async () => {}, query },
    "@/lib/pipeline": {}, "@/lib/quotaScheduler": {},
    "@/lib/youtube": { ...youtube, youtubeConfiguration: () => ({ configured: true }) },
  });
}
const api = scheduler();
const base = { enabled: true, runTime: "09:00", timezone: "Asia/Ho_Chi_Minh", forceRecreate: false,
  publishToFacebook: false, mode: "interval", startsAt: "2026-09-12T15:00:00", intervalHours: 5, videosPerRun: 4 };

test("interval is anchored to start, crossing midnight with exact seconds", () => {
  const anchor = "2026-09-12T08:00:07Z"; // 15:00:07 Vietnam
  assert.equal(api.intervalTiming(anchor, 5, null, new Date("2026-09-12T08:00:06Z")).due, null);
  assert.equal(api.intervalTiming(anchor, 5, null, new Date(anchor)).due, "2026-09-12T08:00:07.000Z");
  assert.equal(api.intervalTiming(anchor, 5, anchor, new Date("2026-09-12T12:59:59Z")).due, null);
  assert.equal(api.intervalTiming(anchor, 5, anchor, new Date("2026-09-12T18:00:07Z")).due, "2026-09-12T18:00:07.000Z");
  assert.equal(api.intervalTiming(anchor, 5, anchor, new Date("2026-09-12T18:00:07Z")).next, "2026-09-12T23:00:07.000Z");
});

test("downtime coalesces old occurrences; same occurrence never runs twice", () => {
  const anchor = "2026-09-12T08:00:00Z";
  const now = new Date("2026-09-14T10:32:00Z");
  const timing = api.intervalTiming(anchor, 5, anchor, now);
  assert.equal(timing.due, "2026-09-14T10:00:00.000Z");
  assert.equal(api.intervalTiming(anchor, 5, timing.due, now).due, null);
  assert.equal(api.intervalTiming(anchor, 5, timing.due, new Date("2026-09-12T09:00:00Z")).due, null);
});

test("interval validation rejects invalid calendar dates, ranges, types and mode", async () => {
  for (const change of [
    { startsAt: "2026-02-30T15:00:00" }, { startsAt: "2026-09-12T24:00:00" }, { startsAt: "invalid" },
    { startsAt: "2026-09-12T15:00:00Z" }, { startsAt: "1969-01-01T15:00" },
    { intervalHours: 0 }, { intervalHours: 1.5 }, { intervalHours: 8761 }, { intervalHours: "5" },
    { videosPerRun: 0 }, { videosPerRun: 101 }, { videosPerRun: 1.5 }, { videosPerRun: "4" },
    { timezone: "Not/A_Timezone" }, { mode: "weekly" }, { mode: null },
  ]) await assert.rejects(api.updateDailySchedule({ ...base, ...change }));
  assert.equal(api.validateIntervalSettings({ ...base, startsAt: "2028-02-29T15:00" }).startsAt, "2028-02-29T15:00:00");
});

test("interval fields persist without breaking old daily API payloads", async () => {
  const calls = [];
  const service = scheduler(async (sql, values) => {
    calls.push({ sql, values });
    return { rows: [{ enabled: values[0], run_time: values[1], timezone: values[2], mode: values[9],
      starts_at_local: values[10], starts_at: values[10] ? "2026-09-12T08:00:00Z" : null,
      interval_hours: values[11], videos_per_run: values[12], revision: "2" }] };
  });
  const result = await service.updateDailySchedule(base);
  assert.equal(result.startsAt, "2026-09-12T15:00:00");
  assert.equal(result.startsAtUtc, "2026-09-12T08:00:00.000Z");
  assert.equal(result.videosPerRun, 4);
  assert.equal(result.intervalHours, 5);
  assert.match(calls[0].sql, /revision = video_creator_schedule.revision \+ 1/);
  const daily = await service.updateDailySchedule({ ...base, mode: undefined, startsAt: undefined, intervalHours: undefined, videosPerRun: undefined });
  assert.equal(daily.mode, "daily");
  assert.equal(daily.videosPerRun, 1);
  assert.equal(daily.startsAt, null);
});

test("schedule route accepts interval without irrelevant daily runTime", async () => {
  const calls = [];
  const route = load("src/app/api/schedule/route.ts", {
    "@/lib/scheduler": { startScheduler() {}, updateDailySchedule: async (input) => { calls.push(input); return input; } },
  });
  const response = await route.PUT({ json: async () => ({ ...base, runTime: undefined }) });
  assert.equal(response.status, 200);
  assert.equal(calls[0].runTime, "09:00");
  assert.equal(calls[0].startsAt, base.startsAt);
  assert.equal(calls[0].videosPerRun, 4);
  const bad = await route.PUT({ json: async () => ({ ...base, timezone: 7 }) });
  assert.equal(bad.status, 400);
  assert.equal(calls.length, 1);
});
