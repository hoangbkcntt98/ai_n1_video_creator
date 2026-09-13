import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";
import ts from "typescript";

function load(file, mocks) {
  const exports = {};
  const code = ts.transpileModule(fs.readFileSync(file, "utf8"), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2021, esModuleInterop: true },
  }).outputText;
  vm.runInNewContext(code, { exports, Response, URL, Error, require(name) {
    if (!(name in mocks)) throw new Error(`Unexpected import ${name}`);
    return mocks[name];
  } });
  return exports;
}

test("exact-path video lookup reads older Kanji metadata without listing latest 80 files", async () => {
  const queries = [];
  const lib = load("src/lib/video.ts", {
    "node:path": path,
    "node:fs": { promises: { stat: async (file) => {
      if (file.endsWith("missing.mp4")) throw new Error("ENOENT");
      return { isFile: () => true, size: 1000, mtime: new Date("2026-01-01") };
    } } },
    "@/lib/config": { resolvedOutputPath: (relative) => {
      if (relative.includes("..")) throw new Error("Invalid path");
      return `/output/${relative}`;
    } },
    "@/lib/db": { ensureVideoCreatorSchema: async () => {}, query: async (sql, values) => {
      queries.push({ sql, values });
      return { rows: [{ title: "語", caption: "Kanji", facebook_video_id: "test-id", scheduled_publish_at: "2026-09-14T00:00:00Z" }] };
    } },
  });
  const video = await lib.getVideoDetails("old/語.mp4");
  assert.equal(video.relativePath, "old/語.mp4");
  assert.equal(video.facebookVideoId, "test-id");
  assert.equal(video.scheduledPublishAt, "2026-09-14T00:00:00Z");
  assert.match(queries[0].sql, /WHERE relative_path = \$1/);
  assert.equal(queries[0].values[0], "old/語.mp4");
  assert.equal(await lib.getVideoDetails("missing.mp4"), null);
  assert.equal(await lib.getVideoDetails("image.png"), null);
  await assert.rejects(lib.getVideoDetails("../outside.mp4"), /Invalid path/);
  assert.equal(queries.length, 1);
});

test("videos GET preserves library response and supports exact-path JSON 404", async () => {
  const route = load("src/app/api/videos/route.ts", {
    "@/lib/pipeline": {},
    "@/lib/video": {
      listVideos: async () => [{ relativePath: "new.mp4" }],
      getVideoDetails: async (relativePath) => relativePath === "old/語.mp4" ? { relativePath } : null,
    },
  });
  const response = await route.GET(new Request("http://localhost/api/videos?path=old%2F%E8%AA%9E.mp4"));
  assert.equal(response.status, 200);
  assert.equal(response.headers.get("Cache-Control"), "no-store");
  assert.deepEqual(await response.json(), { video: { relativePath: "old/語.mp4" } });
  const missing = await route.GET(new Request("http://localhost/api/videos?path=missing.mp4"));
  assert.equal(missing.status, 404);
  assert.ok((await missing.json()).error);
  const library = await route.GET(new Request("http://localhost/api/videos"));
  assert.deepEqual(await library.json(), { videos: [{ relativePath: "new.mp4" }] });
});
