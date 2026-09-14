import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import vm from "node:vm";
import { randomUUID } from "node:crypto";
import pg from "pg";
import ts from "typescript";

// Keep integration workers serialized with each other, never with real renders.
const testLockKey = 1_000_000 + Number.parseInt(randomUUID().slice(0, 6), 16);

function load(file, mocks) {
  const exports = {};
  const input = fs.readFileSync(file, "utf8");
  const source = ts.transpileModule(file.endsWith("/jobs.ts")
    ? input.replaceAll("824731, 1", `${testLockKey}, 1`) : input, {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 },
  }).outputText;
  vm.runInNewContext(source, {
    exports, process: { env: { NODE_ENV: "test" } }, console, Error,
    require(name) {
      if (!(name in mocks)) throw new Error(`Unexpected import ${name}`);
      return mocks[name];
    },
  });
  return exports;
}

function route(overrides = {}, creatorOverrides = {}) {
  return load("src/app/api/word-creator/route.ts", {
    "next/server": { NextResponse: { json: (body, init) => Response.json(body, init) } },
    "@/lib/wordCreator/index": { listWordCreatorQuestions: async () => [], ...creatorOverrides },
    "@/lib/wordCreator/jobs": {
      enqueueWordCreator: async () => ({ id: randomUUID(), status: "queued" }),
      getWordCreatorJob: async () => null,
      ...overrides,
    },
  });
}

test("POST returns 202 with job ID, without waiting for video rendering", async () => {
  let options;
  const id = randomUUID();
  const api = route({ enqueueWordCreator: async (input) => {
    options = input;
    return { id, status: "queued" };
  } });
  const response = await api.POST({ json: async () => ({ limit: 2, durationSeconds: 10, source: " 遭 " }) });
  assert.equal(response.status, 202);
  assert.equal(response.headers.get("Cache-Control"), "no-store");
  assert.deepEqual(await response.json(), { job: { id, status: "queued" } });
  assert.deepEqual(JSON.parse(JSON.stringify(options)), { limit: 2, source: "遭", durationSeconds: 10, fps: 25, autoFps: true });
});

test("POST passes selected FPS to background job", async () => {
  for (const fps of [1, 24, 40, 60]) {
    let options;
    const api = route({ enqueueWordCreator: async (input) => {
      options = input;
      return { id: randomUUID(), status: "queued" };
    } });
    const response = await api.POST({ json: async () => ({ fps }) });
    assert.equal(response.status, 202);
    assert.equal(options.fps, fps);
  }
});

test("POST rejects invalid FPS before creating a job", async () => {
  const api = route({ enqueueWordCreator: () => { assert.fail("Must not enqueue"); } });
  for (const fps of [0, -1, 61, 29.97, "", "30", null, true, [], {}]) {
    const response = await api.POST({ json: async () => ({ fps }) });
    assert.equal(response.status, 400);
    assert.match((await response.json()).error, /FPS/);
  }
});

test("POST accepts fixed FPS mode and rejects invalid autoFps", async () => {
  let options;
  const api = route({ enqueueWordCreator: async (input) => { options = input; return { id: randomUUID(), status: "queued" }; } });
  assert.equal((await api.POST({ json: async () => ({ fps: 25, autoFps: false }) })).status, 202);
  assert.equal(options.autoFps, false);
  assert.equal((await api.POST({ json: async () => ({ autoFps: "true" }) })).status, 400);
});

test("POST rejects invalid body/limits without enqueuing", async () => {
  const api = route({ enqueueWordCreator: () => { throw new Error("Must not enqueue"); } });
  for (const input of [null, [], { limit: 0 }, { limit: 501 }, { durationSeconds: 0 }, { durationSeconds: 301 }]) {
    const response = await api.POST({ json: async () => input });
    assert.equal(response.status, 400);
    assert.ok((await response.json()).error);
  }
});

test("GET validates job ID, returns JSON 404 and current progress without rendering", async () => {
  const id = randomUUID();
  const progress = { id, status: "running", processed: 1, total: 2 };
  const api = route({ getWordCreatorJob: async (key) => key === id ? progress : null });
  const get = (key) => api.GET({ nextUrl: new URL(`http://localhost/api/word-creator?jobId=${key}`) });
  assert.equal((await get("invalid")).status, 400);
  const missing = await get(randomUUID());
  assert.equal(missing.status, 404);
  assert.ok((await missing.json()).error);
  const response = await get(id);
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { job: progress });
});

test("GET sources forwards search/pagination, validates offset and reports Anki errors as JSON", async () => {
  const api = route({}, { listWordCreatorSources: async (search, offset) => {
    assert.equal(search, "語");
    assert.equal(offset, 100);
    return { sources: [{ source: "語", vocabulary: "語る", note_count: 2 }], hasMore: true };
  } });
  const get = (offset) => api.GET({ nextUrl: new URL(`http://localhost/api/word-creator?sources=1&q=語&offset=${offset}`) });
  for (const value of ["-1", "1.5", "NaN"]) assert.equal((await get(value)).status, 400);
  const response = await get("100");
  assert.equal(response.headers.get("Cache-Control"), "no-store");
  assert.equal((await response.json()).sources[0].source, "語");
  const broken = route({}, { listWordCreatorSources: async () => { throw new Error("Anki unavailable"); } });
  const error = await broken.GET({ nextUrl: new URL("http://localhost/api/word-creator?sources=1") });
  assert.equal(error.status, 500);
  assert.equal((await error.json()).error, "Anki unavailable");
});

// Opt-in; isolated scratch schema, mocked renderer. No AI calls or real videos.
test("PostgreSQL WordCreator background jobs", { skip: !process.env.WORD_CREATOR_TEST_DATABASE_URL }, async (t) => {
  const connectionString = process.env.WORD_CREATOR_TEST_DATABASE_URL;
  const schema = `word_creator_test_${randomUUID().replaceAll("-", "")}`;
  const admin = new pg.Client({ connectionString });
  await admin.connect();
  await admin.query(`CREATE SCHEMA "${schema}"`);
  const pool = new pg.Pool({ connectionString, max: 5, options: `-c search_path=${schema}` });
  t.after(async () => {
    await pool.end();
    await admin.query(`DROP SCHEMA "${schema}" CASCADE`);
    await admin.end();
  });
  let generate = async () => {};
  const completedRuns = [];
  const worker = () => load("src/lib/wordCreatorJobs.ts", {
    "node:crypto": { randomUUID },
    "node:fs": { promises: { appendFile: async () => {} } },
    "@/lib/db": { query: (...args) => pool.query(...args), db: () => pool },
    "@/lib/wordCreator/index": { generateWordCreator: (...args) => generate(...args) },
    "@/lib/pipeline": { finishKanjiGeneration: async (...args) => { completedRuns.push(args); } },
  });
  const service = worker();
  await service.getWordCreatorJob();
  const secondWorker = worker();
  await secondWorker.getWordCreatorJob();
  await pool.query(fs.readFileSync("db/008_word_creator_jobs.sql", "utf8"));
  await pool.query(fs.readFileSync("db/010_word_creator_logs.sql", "utf8"));
  await pool.query(fs.readFileSync("db/010_word_creator_logs.sql", "utf8"));

  await t.test("FPS migration preserves old questions and validates new frame rates", async () => {
    await pool.query(fs.readFileSync("db/006_word_creator.sql", "utf8"));
    await pool.query(fs.readFileSync("db/007_word_creator_video.sql", "utf8"));
    await pool.query(`INSERT INTO word_creator_questions
      (source, required_vocabulary, answer_a, answer_b, answer_c, answer_d,
       correct_index, correct_answer, template_path)
      VALUES ('遭', '遭う', 'あう', 'そうう', 'あえる', 'かう', 0, 'あう', '/tmp/遭.html')`);
    const migration = fs.readFileSync("db/009_word_creator_fps.sql", "utf8");
    await pool.query(migration);
    await pool.query(migration);
    assert.equal((await pool.query("SELECT fps FROM word_creator_questions")).rows[0].fps, 30);
    await pool.query("UPDATE word_creator_questions SET fps = 40");
    assert.equal((await pool.query("SELECT fps FROM word_creator_questions")).rows[0].fps, 40);
    await assert.rejects(pool.query("UPDATE word_creator_questions SET fps = 61"), (error) => error.code === "23514");
    await pool.query(fs.readFileSync("db/011_word_creator_fps_default.sql", "utf8"));
    assert.equal((await pool.query("SELECT fps FROM word_creator_questions")).rows[0].fps, 40);
    const defaultValue = await pool.query(`SELECT column_default FROM information_schema.columns
      WHERE table_schema = $1 AND table_name = 'word_creator_questions' AND column_name = 'fps'`, [schema]);
    assert.equal(defaultValue.rows[0].column_default, "25");
  });

  await t.test("concurrent submissions reuse active job, worker persists progress and serializes rendering", async () => {
    const jobs = await Promise.all(Array.from({ length: 8 }, () => service.enqueueWordCreator({ limit: 2, fps: 40 })));
    assert.equal(new Set(jobs.map((job) => job.id)).size, 1);
    let unblock, notifyStarted;
    const gate = new Promise((resolve) => { unblock = resolve; });
    const started = new Promise((resolve) => { notifyStarted = resolve; });
    let calls = 0;
    generate = async (options, report, log) => {
      calls++;
      assert.equal(options.limit, 2);
      assert.equal(options.fps, 40);
      await report({ total: 2, processed: 1, generated: 1, currentSource: "語", errors: [] });
      await log("Render frame", "info", "語");
      notifyStarted();
      await gate;
      await report({ total: 2, processed: 2, generated: 1, currentSource: null,
        errors: [{ source: "語", error: "Mock render failure" }] });
    };
    const rendering = service.tickWordCreatorJobs();
    try {
      await started;
      const active = await service.getWordCreatorJob(jobs[0].id);
      assert.equal(active.status, "running");
      assert.equal(active.processed, 1);
      assert.equal(active.current_source, "語");
      assert.ok(active.logs.some((line) => line.source === "語" && line.message === "Render frame"));
      await secondWorker.tickWordCreatorJobs();
      assert.equal(calls, 1);
      const retry = await service.enqueueWordCreator({ limit: 500 });
      assert.equal(retry.id, active.id);
    } finally {
      unblock();
      await rendering;
    }
    const done = await service.getWordCreatorJob(jobs[0].id);
    assert.equal(done.status, "completed");
    assert.equal(done.processed, 2);
    assert.equal(done.generated, 1);
    assert.equal(done.errors[0].error, "Mock render failure");
    assert.equal(done.logs.at(-1).message, "Tác vụ hoàn tất.");
    await pool.query(`INSERT INTO word_creator_job_logs (job_id, level, message)
      SELECT $1, 'info', n::text FROM generate_series(1, 220) n`, [done.id]);
    const tail = await service.getWordCreatorJob(done.id);
    assert.equal(tail.logs.length, 200);
    assert.equal(tail.logs[0].message, "21");
    assert.equal(tail.logs.at(-1).message, "220");
  });

  await t.test("new worker recovers queued work after restart", async () => {
    const job = await service.enqueueWordCreator({ limit: 1 });
    let calls = 0;
    generate = async (_, report) => {
      calls++;
      await report({ total: 1, processed: 1, generated: 1, currentSource: null, errors: [] });
    };
    await worker().tickWordCreatorJobs();
    assert.equal(calls, 1);
    assert.equal((await service.getWordCreatorJob(job.id)).status, "completed");
  });

  await t.test("fatal failure persists JSON status and releases worker slot", async () => {
    const job = await service.enqueueWordCreator({});
    generate = async () => { throw new Error("Anki unavailable"); };
    await service.tickWordCreatorJobs();
    const failed = await service.getWordCreatorJob(job.id);
    assert.equal(failed.status, "failed");
    assert.equal(failed.error, "Anki unavailable");
    assert.equal(failed.logs.at(-1).level, "error");
    assert.equal(failed.logs.at(-1).message, "Anki unavailable");
  });

  await t.test("interrupted running job fails explicitly instead of replaying AI calls", async () => {
    const job = await service.enqueueWordCreator({});
    await pool.query("UPDATE word_creator_jobs SET status = 'running' WHERE id = $1", [job.id]);
    generate = async () => { assert.fail("Interrupted work must not replay"); };
    await worker().tickWordCreatorJobs();
    const failed = await service.getWordCreatorJob(job.id);
    assert.equal(failed.status, "failed");
    assert.match(failed.error, /khởi động lại/);
    assert.equal(failed.current_source, null);
    assert.equal(failed.logs.at(-1).message, failed.error);
  });

  await t.test("scheduled jobs use strict enqueue and complete their pipeline run", async () => {
    await pool.query(`CREATE TABLE video_creator_runs (id INT PRIMARY KEY, action TEXT, status TEXT, log_path TEXT);
      INSERT INTO video_creator_runs VALUES (1, 'create_kanji', 'running', '/mock/kanji.log')`);
    const job = await service.enqueueWordCreator({ pipelineRunId: 1, scheduled: true, limit: 1 }, false);
    await assert.rejects(service.enqueueWordCreator({ pipelineRunId: 2 }, false), (error) => error.code === "23505");
    const video = { videoPath: "語.mp4", source: "語", requiredVocabulary: "語る" };
    generate = async () => ({ generated: 1, results: [video], errors: [] });
    await service.tickWordCreatorJobs();
    assert.equal((await service.getWordCreatorJob(job.id)).status, "completed");
    assert.equal(completedRuns.at(-1)[0], 1);
    assert.deepEqual(completedRuns.at(-1)[1], video);
  });

  await t.test("exhausted Kanji fails scheduled run; stopped runs never replay", async () => {
    const job = await service.enqueueWordCreator({ pipelineRunId: 1, scheduled: true });
    generate = async () => ({ generated: 0, results: [], errors: [] });
    await service.tickWordCreatorJobs();
    assert.equal((await service.getWordCreatorJob(job.id)).status, "failed");
    assert.equal(completedRuns.at(-1)[1], undefined);
    assert.match(completedRuns.at(-1)[2], /Không còn Kanji/);
    await pool.query("UPDATE video_creator_runs SET status = 'failed' WHERE id = 1");
    const stopped = await service.enqueueWordCreator({ pipelineRunId: 1, scheduled: true });
    generate = async () => { assert.fail("Stopped scheduled run must never replay"); };
    await service.tickWordCreatorJobs();
    assert.equal((await service.getWordCreatorJob(stopped.id)).status, "failed");
    assert.match((await service.getWordCreatorJob(stopped.id)).error, /not replayed/);
  });

  await t.test("interrupted Kanji releases scheduled run and upload barrier", async () => {
    const job = await service.enqueueWordCreator({ pipelineRunId: 1, scheduled: true });
    await pool.query("UPDATE word_creator_jobs SET status = 'running' WHERE id = $1", [job.id]);
    const before = completedRuns.length;
    await service.tickWordCreatorJobs();
    assert.equal(completedRuns.length, before + 1);
    assert.equal(completedRuns.at(-1)[0], 1);
    assert.equal(completedRuns.at(-1)[1], undefined);
    assert.match(completedRuns.at(-1)[2], /khởi động lại/);
  });
});
