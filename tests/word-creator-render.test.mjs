import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";
import ts from "typescript";

function harness(ankiRows, effectiveFps) {
  const commands = [], queries = [], ankiQueries = [];
  const exports = {};
  const mocks = {
"node:fs": { promises: {
      readFile: async () => "<h1>{{Word}}</h1><p>{{AnswerA}} {{AnswerB}} {{AnswerC}} {{AnswerD}}</p>",
      mkdir: async () => {}, writeFile: async () => {}, unlink: async () => {},
    } },
    "node:crypto": { randomInt: () => 0 },
    "node:path": path,
    pg: { Pool: class {
      async query(sql, values) {
        ankiQueries.push({ sql, values });
        return { rows: ankiRows ?? [{ anki_note_id: 1, source: "遭", fields_json: { RequiredVocabulary: "遭う" } }] };
      }
    } },
    "@/lib/config": {
      appConfig: { ankiDatabaseUrl: () => "mock", wordCreatorOutputDir: () => "/tmp/html",
        wordCreatorDuration: () => 10, outputDir: () => "/tmp/output" },
      toRelativeOutputPath: (file) => path.relative("/tmp/output", file),
    },
    "@/lib/db": { ensureWordCreatorSchema: async () => {}, query: async (sql, values) => { queries.push({ sql, values }); return { rows: [] }; } },
    "@/lib/studio": { runCommand: async (command, args, onStdout) => {
      commands.push({ command, args });
      const fps = effectiveFps ?? Number(args[args.indexOf("--fps") + 1]);
      onStdout?.(`FPS thực tế: ${fps}\nĐã chụp 1/`);
      onStdout?.(`1 frame.\n`);
      return { stdout: `WORD_CREATOR_RESULT=${JSON.stringify({ fps })}\n` };
    } },
    "@/lib/video": { saveVideoDetails: async () => {} },
  };
  const source = ts.transpileModule(fs.readFileSync("src/lib/wordCreator.ts", "utf8"), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2021, esModuleInterop: true },
  }).outputText;
  vm.runInNewContext(source, {
    exports, require(name) {
      if (!(name in mocks)) throw new Error(`Unexpected import ${name}`);
      return mocks[name];
    },
    process: { cwd: () => "/tmp", execPath: "/usr/bin/node",
      env: { LLM_BASE_URL: "https://mock.invalid", LLM_API_KEY: "mock", LLM_MODEL: "mock" } },
    Error, AbortController, setTimeout, clearTimeout,
    fetch: async () => Response.json({ choices: [{ message: {
      content: JSON.stringify({ answers: ["あう", "そうう", "あえる", "かう"], correctIndex: 0 }),
    } }] }),
  });
  return { ...exports, commands, queries, ankiQueries };
}

test("selected FPS reaches html-to-image.js and is stored with generated question", async () => {
  for (const fps of [1, 24, 40, 60, undefined]) {
    const service = harness();
    const logs = [];
    const result = await service.generateWordCreator({ limit: 1, fps }, undefined, async (message) => { logs.push(message); });
    assert.equal(result.generated, 1);
    assert.equal(result.errors.length, 0);
    assert.equal(result.results[0].fps, fps ?? 25);
    const args = service.commands[0].args;
    const dataIdx = args.indexOf("--data");
    assert.ok(dataIdx !== -1, "renderer receives quiz data JSON");
    assert.equal(args[dataIdx + 1].endsWith(".json"), true);
    assert.equal(args[args.indexOf("--fps") + 1], String(fps ?? 25));
    const insert = service.queries.find((query) => query.sql.includes("INSERT INTO word_creator_questions"));
    assert.equal(insert.values[12], fps ?? 25);
    assert.match(insert.sql, /fps = EXCLUDED.fps/);
    assert.ok(logs.some((line) => line.includes("Gọi AI")));
    assert.ok(logs.some((line) => line.includes("frame tạm đã được xóa")));
    assert.match(logs.at(-1), /Kết quả: 1\/1 video, 0 lỗi/);
  }
});

test("scheduled selection excludes generated vocabulary; force recreate rotates oldest", async () => {
  for (const forceRecreate of [false, true]) {
    const service = harness([]);
    await service.generateWordCreator({ scheduled: true, forceRecreate, source: " 語 ", limit: 1 });
    assert.match(service.queries[0].sql, /FROM word_creator_questions WHERE video_path IS NOT NULL/);
    const read = service.ankiQueries[0];
    assert.equal(read.values[0], "[]");
    assert.equal(read.values[1], "語");
    assert.equal(read.values[2], 1);
    assert.match(read.sql, /jsonb_to_recordset\(\$1::jsonb\)/);
    assert.match(read.sql, forceRecreate ? /ASC NULLS FIRST/ : /NOT EXISTS/);
  }
  const manual = harness([]);
  await manual.generateWordCreator({ source: "語" });
  assert.equal(manual.queries.length, 0, "manual generation remains unchanged");
});

test("custom setQuiz templates receive current Kanji and safely escaped quiz data", () => {
  const service = harness([]);
  const html = service.fillQuizTemplate("<body><h1>{{Word}}</h1></body>", "</script><b>語", ["あ", "い", "う", "え"]);
  assert.match(html, /&lt;\/script&gt;&lt;b&gt;語/);
  assert.match(html, /window.setQuiz\(/);
  const match = html.match(/window.setQuiz\((.*?)\);/);
  assert.ok(match);
  assert.equal(match[1].includes("</script>"), false);
  assert.equal(JSON.parse(match[1]).Word, "</script><b>語");
  assert.equal(JSON.parse(match[1]).AnswerD, "え");
});

test("renderer effective FPS is stored, manual mode is forwarded, stdout lines stream to job logs", async () => {
  const service = harness(undefined, 50);
  const logs = [];
  const result = await service.generateWordCreator({ fps: 40, autoFps: true }, undefined, async (message) => { logs.push(message); });
  assert.equal(result.results[0].fps, 50);
  assert.equal(service.queries[0].values[12], 50);
  assert.ok(logs.includes("FPS thực tế: 50"));
  assert.ok(service.commands[0].args.includes("--data"));
  assert.ok(logs.includes("Đã chụp 1/1 frame."));
  assert.equal(service.commands[0].args.includes("--fixed-fps"), false);
  const fixed = harness();
  await fixed.generateWordCreator({ fps: 40, autoFps: false });
  const fixedArgs = fixed.commands[0]?.args;
  assert.ok(fixedArgs && fixedArgs.includes("--fixed-fps"));
  assert.ok(!fixedArgs || !fixedArgs.includes("--data"));
  assert.equal(fixed.commands[0].args.includes("--fixed-fps"), true);
});

test("source search is parameterized, escapes LIKE wildcards and paginates 100 sources", async () => {
  const rows = Array.from({ length: 101 }, (_, n) => ({ source: `語${n}`, vocabulary: "語る", note_count: 1 }));
  const service = harness(rows);
  const result = await service.listWordCreatorSources(" %_\\' ", 100);
  assert.equal(result.sources.length, 100);
  assert.equal(result.hasMore, true);
  const query = service.ankiQueries[0];
  assert.equal(query.values[0], "%\\%\\_\\\\'%");
  assert.equal(query.values[1], 100);
  assert.match(query.sql, /note_type = 'AIKanjiWithImage'/);
  assert.match(query.sql, /LIMIT 101 OFFSET \$2/);
  assert.match(query.sql, /source ILIKE \$1/);
  assert.equal(query.sql.includes("%_\\'"), false);
  await assert.rejects(service.listWordCreatorSources("", -1), /offset/);
  assert.equal(service.ankiQueries.length, 1);
});

test("invalid FPS cannot launch renderer", async () => {
  const service = harness();
  for (const fps of [0, 61, 29.97, NaN]) {
    await assert.rejects(service.generateWordCreator({ fps }), /FPS/);
  }
  assert.equal(service.commands.length, 0);
});
