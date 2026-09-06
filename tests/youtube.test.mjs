import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import ts from "typescript";
import vm from "node:vm";

const source = fs.readFileSync("src/lib/youtube.ts", "utf8");
const compiled = ts.transpileModule(source, {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2017 },
});
const exported = {};
vm.runInNewContext(compiled.outputText, { exports: exported, Buffer, process });
const valid = {
  path: "20260906/test.mp4", title: "日本語", description: "Description", privacy: "private",
  madeForKids: false, containsSyntheticMedia: true, confirmUpload: true,
};

test("requires explicit upload confirmation and audience declarations", () => {
  assert.equal(exported.validateYouTubeUpload(valid).privacy, "private");
  for (const field of ["confirmUpload", "madeForKids", "containsSyntheticMedia"]) {
    assert.throws(() => exported.validateYouTubeUpload({ ...valid, [field]: undefined }));
  }
});
test("rejects invalid visibility, empty title, HTML brackets, or non-MP4", () => {
  for (const change of [{ privacy: "invalid" }, { title: " " }, { title: "<title>" }, { path: "file.txt" }]) {
    assert.throws(() => exported.validateYouTubeUpload({ ...valid, ...change }));
  }
});
test("validates title characters and description UTF-8 bytes", () => {
  assert.throws(() => exported.validateYouTubeUpload({ ...valid, title: "a".repeat(101) }));
  assert.throws(() => exported.validateYouTubeUpload({ ...valid, description: "日".repeat(1667) }));
  assert.equal(exported.validateYouTubeUpload({ ...valid, description: "a".repeat(5000) }).description.length, 5000);
});
