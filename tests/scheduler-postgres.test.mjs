import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";
import { EventEmitter } from "node:events";
import { randomUUID } from "node:crypto";
import pg from "pg";
import ts from "typescript";

function load(file, mocks) {
  const exports = {};
  const source = ts.transpileModule(fs.readFileSync(file, "utf8"), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020, esModuleInterop: true },
  }).outputText;
  vm.runInNewContext(source, { exports, require: (name) => {
    if (!(name in mocks)) throw new Error(`Unexpected import ${name}`);
    return mocks[name];
  }, process, Buffer, Error, Date, console, setInterval: () => ({ unref() {} }), clearInterval() {} });
  return exports;
}

// Opt-in only. Every object lives in a unique scratch schema; no public tables,
// credentials, real files, Python workers or external uploads are touched.
test("PostgreSQL schedule queue integration", { skip: !process.env.SCHEDULE_TEST_DATABASE_URL }, async (t) => {
  const connectionString = process.env.SCHEDULE_TEST_DATABASE_URL;
  const schema = `schedule_test_${randomUUID().replaceAll("-", "")}`;
  const admin = new pg.Client({ connectionString });
  await admin.connect();
  await admin.query(`CREATE SCHEMA "${schema}"`);
  const pool = new pg.Pool({ connectionString, max: 5, options: `-c search_path=${schema}` });
  t.after(async () => {
    await pool.end();
    await admin.query(`DROP SCHEMA "${schema}" CASCADE`);
    await admin.end();
  });
  const newDb = () => load("src/lib/db.ts", {
    pg: { Pool: class { constructor() { return pool; } } },
    "@/lib/config": { appConfig: { databaseUrl: () => connectionString } },
  });
  const db = newDb();
  await db.ensureVideoCreatorSchema();
  await pool.query(fs.readFileSync("db/004_interval_schedule.sql", "utf8")); // idempotent migration
  const errors = [];
  const query = async (...args) => {
    try { return await pool.query(...args); } catch (error) { if (error.code !== "23505") errors.push(error); throw error; }
  };
  const files = new Map();
  const workers = [];
  let captionGate = null;
  let configured = true;
  const youtube = { ...load("src/lib/youtube.ts", {}), youtubeConfiguration: () => ({ configured, missing: ["YOUTUBE_REFRESH_TOKEN"] }) };
  const pipeline = load("src/lib/pipeline.ts", {
    "node:fs": {
      promises: {
        mkdir: async () => {}, chmod: async () => {}, access: async () => {},
        realpath: async (name) => name, stat: async () => ({ isFile: () => true, size: 1024 }),
        writeFile: async (name, value) => files.set(name, value),
        appendFile: async (name, value) => files.set(name, (files.get(name) || "") + value),
        readFile: async (name) => {
          if (name.endsWith("_reel_caption.txt")) { if (captionGate) await captionGate; return "Caption"; }
          if (!files.has(name)) throw new Error("Missing file");
          return files.get(name);
        },
      },
      appendFileSync: (name, value) => files.set(name, (files.get(name) || "") + value), openSync: () => 1, closeSync() {},
    },
    "node:path": path,
    "node:child_process": { spawn: () => {
      const worker = new EventEmitter(); worker.pid = 1000 + workers.length; worker.unref = () => {};
      workers.push(worker); return worker;
    } },
    "@/lib/db": { ...db, query },
    "@/lib/config": {
      appConfig: { logDir: () => "/logs", dataDir: () => "/data", skillDir: () => "/skill", outputDir: () => "/outputs",
        pipelineConfig: () => ({ facebook: { pageId: "test-page", pageToken: "test-token" } }) },
      resolvedOutputPath: (name) => path.join("/outputs", name),
      toRelativeOutputPath: (name) => path.relative("/outputs", name),
    },
    "@/lib/video": { markFacebookPublished: async () => {}, markFacebookScheduled: async () => {},
      markYouTubeUploaded: async () => {}, saveVideoDetails: async () => {} },
    "@/lib/youtube": youtube,
  });
  function scheduler() {
    return load("src/lib/scheduler.ts", { "@/lib/db": { ...db, query }, "@/lib/pipeline": pipeline,
      "@/lib/quotaScheduler": {}, "@/lib/youtube": youtube });
  }
  const service = scheduler();
  const input = { enabled: true, mode: "interval", startsAt: "2026-09-12T15:00:00", intervalHours: 5, videosPerRun: 4,
    runTime: "09:00", timezone: "Asia/Ho_Chi_Minh", forceRecreate: false, publishToFacebook: false };
  const start = new Date("2026-09-12T08:00:00Z");
  const dailyInput = { ...input, mode: "daily", runTime: "15:00", forceRecreate: true };
  async function reset(changes = {}) {
    await pool.query("TRUNCATE video_creator_runs, video_creator_schedule RESTART IDENTITY CASCADE");
    workers.length = 0; files.clear(); errors.length = 0; configured = true; captionGate = null;
    return service.updatePipelineSchedule({ ...input, ...changes });
  }
  async function runs() { return (await pool.query("SELECT * FROM video_creator_runs ORDER BY id")).rows; }
  async function jobs() { return (await pool.query("SELECT * FROM video_creator_schedule_jobs ORDER BY id")).rows; }
  async function finish(code = 0) {
    const run = (await runs()).find((row) => row.status === "running");
    assert.ok(run, "Expected active worker");
    files.set(run.log_path, code ? "Generation failed" : run.action === "youtube_publish"
      ? '{"success":true,"video_id":"abcdefghijk","video_path":"/outputs/example_video.mp4","privacy_status":"private"}'
      : run.action === "publish" ? '{"success":true,"video_id":"facebook-id"}'
        : 'Video ready: /outputs/example_video.mp4\n{"success":true}');
    await workers.find((worker) => worker.pid === run.runner_pid).listeners("close")[0](code);
  }

  for (const mode of ["daily", "interval"]) {
    for (const method of ["runtime", "sql"]) {
      await t.test(`${method} migration preserves legacy ${mode} schedule, queued jobs and run history`, async () => {
        await pool.query("TRUNCATE video_creator_runs, video_creator_schedule RESTART IDENTITY CASCADE");
        // Recreate the old singleton constraint and non-cascading update FK.
        await pool.query(`ALTER TABLE video_creator_schedule DROP CONSTRAINT video_creator_schedule_slot_check;
          ALTER TABLE video_creator_schedule ADD CONSTRAINT video_creator_schedule_id_check CHECK (id = 1);
          ALTER TABLE video_creator_schedule_jobs
            DROP CONSTRAINT video_creator_schedule_jobs_schedule_id_fkey,
            ADD CONSTRAINT video_creator_schedule_jobs_schedule_id_fkey
              FOREIGN KEY (schedule_id) REFERENCES video_creator_schedule(id) ON DELETE CASCADE`);
        await pool.query(`INSERT INTO video_creator_schedule
          (id, enabled, mode, starts_at, interval_hours, videos_per_run, revision, last_scheduled_at,
            last_run_date, last_run_id, last_error, publish_to_youtube, youtube_made_for_kids, youtube_contains_synthetic_media)
          VALUES (1, TRUE, $1, $2, 5, $3, 7, $2, '2026-09-12', 1, 'existing error', TRUE, FALSE, TRUE)`,
        [mode, start, mode === "daily" ? 1 : 4]);
        await pool.query(`INSERT INTO video_creator_schedule_jobs (schedule_id, schedule_revision, scheduled_for, position, settings)
          VALUES (1, 7, $1, 1, '{"forceRecreate":true}'), (1, 7, $1, 2, '{"forceRecreate":false}')`, [start]);
        await pool.query(`INSERT INTO video_creator_runs (action, status, log_path, schedule_job_id)
          VALUES ('create_next', 'success', '/logs/migrated.log', 1)`);
        const before = (await pool.query("SELECT * FROM video_creator_schedule")).rows[0];
        const beforeJobs = await jobs();
        const beforeRuns = await runs();
        if (method === "runtime") {
          await newDb().ensureVideoCreatorSchema();
          await newDb().ensureVideoCreatorSchema();
        } else {
          const migration = fs.readFileSync("db/005_independent_schedules.sql", "utf8");
          await Promise.all([pool.query(migration), pool.query(migration)]);
        }
        const id = mode === "daily" ? 1 : 2;
        assert.deepEqual((await pool.query("SELECT * FROM video_creator_schedule")).rows, [{ ...before, id }]);
        assert.deepEqual(await jobs(), beforeJobs.map((job) => ({ ...job, schedule_id: id })));
        assert.deepEqual(await runs(), beforeRuns);
        assert.equal((await service.getPipelineSchedule(mode)).pendingVideos, 1);
        await assert.rejects(service.getPipelineSchedule(mode === "daily" ? "interval" : "daily"), /not configured/);
        await assert.rejects(pool.query("INSERT INTO video_creator_schedule (id, mode) VALUES ($1, $2)",
          [id === 1 ? 2 : 1, mode]), (error) => error.code === "23514");
      });
    }
  }

  await t.test("both schedules queue when busy and drain once across concurrent ticks/restarts", async () => {
    await reset();
    await service.updatePipelineSchedule(dailyInput);
    await pipeline.startGeneration({});
    await Promise.all(Array.from({ length: 5 }, () => scheduler().tickSchedule(start)));
    const queued = await jobs();
    assert.equal(queued.filter((job) => job.schedule_id === 1).length, 1);
    assert.equal(queued.filter((job) => job.schedule_id === 2).length, 4);
    assert.equal((await runs()).length, 1, "manual worker retains its slot");
    assert.equal((await service.getPipelineSchedule("daily")).pendingVideos, 1);
    assert.equal((await service.getPipelineSchedule("interval")).pendingVideos, 4);
    assert.equal(queued.find((job) => job.schedule_id === 1).settings.forceRecreate, true);
    assert.equal(queued.find((job) => job.schedule_id === 2).settings.forceRecreate, false);
    await finish();
    for (let i = 0; i < 5; i++) {
      await Promise.all(Array.from({ length: 3 }, () => scheduler().tickSchedule(start)));
      assert.equal((await runs()).length, i + 2);
      await finish();
    }
    await service.tickSchedule(start);
    const consumed = (await runs()).slice(1).map((run) => Number(run.schedule_job_id));
    assert.deepEqual(consumed, queued.map((job) => Number(job.id)), "oldest queued job wins regardless of slot");
    assert.equal((await service.getPipelineSchedule("daily")).pendingVideos, 0);
    assert.equal((await service.getPipelineSchedule("interval")).pendingVideos, 0);
    await service.tickSchedule(new Date("2026-09-12T13:00:00Z"));
    assert.equal((await jobs()).filter((job) => job.schedule_id === 1).length, 1, "daily does not repeat with interval");
    assert.equal((await jobs()).filter((job) => job.schedule_id === 2).length, 8);
    await finish();
    await service.tickSchedule(new Date("2026-09-13T08:00:00Z"));
    assert.equal((await jobs()).filter((job) => job.schedule_id === 1).length, 2, "daily queues again despite interval backlog");
    assert.deepEqual(errors, []);
  });

  for (const mode of ["daily", "interval"]) {
    await t.test(`edit/disable/delete ${mode} leaves other schedule and its queue unchanged`, async () => {
      await reset();
      await service.updatePipelineSchedule(dailyInput);
      await pipeline.startGeneration({});
      await service.tickSchedule(start);
      const other = mode === "daily" ? "interval" : "daily";
      const otherBefore = await service.getPipelineSchedule(other);
      const otherJobs = (await jobs()).filter((job) => job.schedule_id === otherBefore.id);
      const target = mode === "daily" ? dailyInput : input;
      for (const enabled of [true, false]) {
        await service.updatePipelineSchedule({ ...target, enabled, forceRecreate: !target.forceRecreate });
        assert.deepEqual(await service.getPipelineSchedule(other), otherBefore);
        assert.deepEqual((await jobs()).filter((job) => job.schedule_id === otherBefore.id), otherJobs);
        assert.equal((await service.getPipelineSchedule(mode)).pendingVideos, 0);
      }
      await service.deletePipelineSchedule(mode);
      await assert.rejects(service.getPipelineSchedule(mode), /not configured/);
      assert.deepEqual(await service.getPipelineSchedule(other), otherBefore);
      assert.deepEqual(await jobs(), otherJobs);
      await finish();
      await service.tickSchedule(start);
      assert.ok((await runs()).at(-1).schedule_job_id, "remaining schedule still dispatches");
      assert.deepEqual(errors, []);
    });
  }

  await t.test("failed generation only cancels owning batch with same revision and due time", async () => {
    // Make interval oldest at the exact same occurrence timestamp as daily.
    await reset();
    await pipeline.startGeneration({});
    await service.tickSchedule(start);
    await service.updatePipelineSchedule(dailyInput);
    await service.tickSchedule(start);
    await finish();
    await service.tickSchedule(start);
    const first = (await runs()).at(-1);
    assert.equal((await jobs()).find((job) => job.id === first.schedule_job_id).schedule_id, 2);
    await finish(1);
    await service.tickSchedule(start);
    assert.equal((await jobs()).filter((job) => job.schedule_id === 2 && job.cancelled).length, 3);
    assert.equal((await jobs()).filter((job) => job.schedule_id === 1 && job.cancelled).length, 0);
    assert.match((await service.getPipelineSchedule("interval")).lastError, /remaining videos/);
    assert.equal((await service.getPipelineSchedule("daily")).lastError, null);
    const last = (await runs()).at(-1);
    assert.equal((await jobs()).find((job) => job.id === last.schedule_job_id).schedule_id, 1);
    assert.deepEqual(errors, []);
  });

  await t.test("invalid settings in daily do not prevent interval dispatch", async () => {
    await reset();
    await service.updatePipelineSchedule(dailyInput);
    await pool.query("UPDATE video_creator_schedule SET timezone = 'Invalid/Timezone' WHERE id = 1");
    await service.tickSchedule(start);
    assert.equal((await runs()).length, 1);
    assert.ok((await service.getPipelineSchedule("daily")).lastError);
    assert.equal((await service.getPipelineSchedule("interval")).lastError, null);
    assert.equal((await jobs()).length, 4);
    assert.deepEqual(errors, []);
  });

  await t.test("timezone conversion, DST gap validation and legacy daily defaults", async () => {
    const saved = await reset();
    assert.equal(saved.startsAt, input.startsAt);
    assert.equal(saved.startsAtUtc, start.toISOString());
    await assert.rejects(service.updatePipelineSchedule({ ...input, timezone: "America/New_York", startsAt: "2026-03-08T02:30:00" }), /does not exist/);
    const ambiguous = await service.updatePipelineSchedule({ ...input, timezone: "America/New_York", startsAt: "2026-11-01T01:30:00" });
    assert.equal(ambiguous.startsAtUtc, "2026-11-01T06:30:00.000Z");
    await reset({ mode: "daily" });
    await service.tickSchedule(new Date("2026-09-12T01:59:59Z"));
    assert.equal((await runs()).length, 0);
    await service.tickSchedule(new Date("2026-09-12T02:00:00Z"));
    assert.equal((await runs()).length, 1);
    assert.equal((await jobs()).length, 1);
    await finish();
    await service.tickSchedule(start);
    assert.equal((await runs()).length, 1);
    assert.deepEqual(errors, []);
  });

  await t.test("four sequential videos per occurrence, restart continuation, no drift", async () => {
    await reset();
    await service.tickSchedule(new Date(start.getTime() - 1));
    assert.equal((await jobs()).length, 0);
    await service.tickSchedule(start);
    assert.deepEqual(errors, []);
    assert.equal((await jobs()).length, 4);
    assert.equal((await runs()).length, 1);
    assert.equal((await service.getPipelineSchedule("interval")).pendingVideos, 3);
    for (let i = 1; i <= 4; i++) {
      await service.tickSchedule(start); // active run cannot consume another job
      assert.equal((await runs()).length, i);
      await finish();
      await scheduler().tickSchedule(start); // new module, same persisted queue
      assert.equal((await runs()).length, Math.min(i + 1, 4));
    }
    await service.tickSchedule(new Date("2026-09-12T12:59:59Z"));
    assert.equal((await jobs()).length, 4);
    await service.tickSchedule(new Date("2026-09-12T13:00:00Z"));
    assert.equal((await jobs()).length, 8);
    assert.equal((await runs()).length, 5);
    assert.deepEqual(errors, []);
  });

  await t.test("concurrent ticks create one batch and one generation", async () => {
    await reset();
    await Promise.all(Array.from({ length: 5 }, () => scheduler().tickSchedule(start)));
    assert.deepEqual(errors, []);
    assert.equal((await jobs()).length, 4);
    assert.equal((await runs()).length, 1);
    await finish();
    await Promise.all(Array.from({ length: 5 }, () => scheduler().tickSchedule(start)));
    assert.equal((await runs()).length, 2);
    assert.deepEqual(errors, []);
  });

  await t.test("busy worker waits; missed occurrences coalesce to latest", async () => {
    await reset();
    await pipeline.startGeneration({});
    await service.tickSchedule(start);
    assert.equal((await jobs()).length, 4, "batch queues even while manual worker is busy");
    await finish();
    const later = new Date("2026-09-14T10:32:00Z");
    // Persisted batch completes before coalescing missed occurrences.
    for (let i = 0; i < 4; i++) {
      await service.tickSchedule(later);
      await finish();
    }
    await service.tickSchedule(later);
    assert.equal((await jobs()).length, 8);
    assert.equal((await service.getPipelineSchedule("interval")).lastRunAt, "2026-09-14T10:00:00.000Z");
    assert.deepEqual(errors, []);
  });

  await t.test("uploads finish before next generation, including claimed-intent gap", async () => {
    await reset({ publishToFacebook: true, publishToYouTube: true, youtubePrivacy: "private",
      youtubeMadeForKids: false, youtubeContainsSyntheticMedia: true });
    await service.tickSchedule(start);
    // Gate caption reading after generation completion/intent claim.
    let release;
    captionGate = new Promise((resolve) => { release = resolve; });
    // The generated-details save also reads caption before finishing the run;
    // wait for that first, then explicitly emulate the protected claimed state.
    await pool.query("UPDATE video_creator_runs SET status = 'success', after_run_publish = NULL WHERE id = 1");
    await service.tickSchedule(start);
    assert.equal((await runs()).length, 1, "after_run_pending protects the claim-to-upload gap");
    await pool.query(`UPDATE video_creator_runs SET status = 'running', after_run_publish = $1::jsonb WHERE id = 1`,
      [JSON.stringify({ facebook: true, youtube: { privacy: "private", madeForKids: false, containsSyntheticMedia: true } })]);
    release(); captionGate = null;
    await finish();
    assert.deepEqual((await runs()).map((r) => r.action), ["create_next", "publish"]);
    await service.tickSchedule(start);
    assert.equal((await runs()).length, 2);
    await finish();
    assert.deepEqual((await runs()).map((r) => r.action), ["create_next", "publish", "youtube_publish"]);
    await service.tickSchedule(start);
    assert.equal((await runs()).length, 3);
    await finish();
    await service.tickSchedule(start);
    assert.equal((await runs()).at(-1).action, "create_next");
    assert.equal((await runs()).length, 4);
    assert.deepEqual(errors, []);
  });

  await t.test("disable/edit/delete cannot dispatch stale jobs, running work continues", async () => {
    await reset();
    await service.tickSchedule(start);
    const queued = (await jobs())[1];
    await service.updatePipelineSchedule({ ...input, enabled: false });
    assert.equal((await service.getPipelineSchedule("interval")).pendingVideos, 0);
    await finish();
    await assert.rejects(pipeline.startGeneration({ scheduleJobId: queued.id }), /no longer pending/);
    await service.tickSchedule(start);
    assert.equal((await runs()).length, 1);
    await service.updatePipelineSchedule(input);
    await service.tickSchedule(start);
    assert.equal((await runs()).length, 1, "same cadence must not replay claimed occurrence");
    await service.updatePipelineSchedule({ ...input, startsAt: "2026-09-12T16:00:00" });
    await service.tickSchedule(new Date("2026-09-12T09:00:00Z"));
    assert.equal((await runs()).length, 2);
    await service.deletePipelineSchedule("interval");
    assert.equal((await jobs()).length, 0);
    await finish();
    assert.equal((await runs()).length, 2, "history remains after deleting schedule");
    assert.deepEqual(errors, []);
  });

  await t.test("generation failure cancels remainder, next timed batch still runs", async () => {
    await reset();
    await service.tickSchedule(start);
    await finish(1);
    await service.tickSchedule(start);
    assert.equal((await jobs()).filter((job) => job.cancelled).length, 3);
    assert.equal((await runs()).length, 1);
    assert.match((await service.getPipelineSchedule("interval")).lastError, /remaining videos/);
    await service.tickSchedule(new Date("2026-09-12T13:00:00Z"));
    assert.equal((await runs()).length, 2);
    assert.equal((await jobs()).length, 8);
    assert.deepEqual(errors, []);
  });

  await t.test("crash before PID persistence fails consumed job without replay or queue deadlock", async () => {
    await reset({ publishToYouTube: true, youtubePrivacy: "private", youtubeMadeForKids: false, youtubeContainsSyntheticMedia: true });
    await service.tickSchedule(start);
    await pool.query(`UPDATE video_creator_runs SET runner_pid = NULL, started_at = NOW() - INTERVAL '11 minutes'`);
    await scheduler().tickSchedule(start);
    assert.equal((await runs()).length, 1);
    assert.equal((await runs())[0].status, "failed");
    assert.equal((await runs())[0].after_run_pending, false);
    assert.equal((await jobs()).filter((job) => job.cancelled).length, 3);
    assert.equal((await service.getPipelineSchedule("interval")).pendingVideos, 0);
    assert.deepEqual(errors, []);
  });

  await t.test("preflight failure stops batch instead of retrying every tick", async () => {
    await reset({ publishToYouTube: true, youtubePrivacy: "private", youtubeMadeForKids: false, youtubeContainsSyntheticMedia: true });
    configured = false;
    await service.tickSchedule(start);
    assert.equal((await jobs()).filter((job) => job.cancelled).length, 4);
    assert.match((await service.getPipelineSchedule("interval")).lastError, /OAuth/);
    await service.tickSchedule(start);
    assert.equal((await jobs()).length, 4);
    assert.equal((await runs()).length, 0);
    assert.deepEqual(errors, []);
  });
});
