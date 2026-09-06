import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import vm from "node:vm";
import { createRequire } from "node:module";
import ts from "typescript";

const require = createRequire(import.meta.url);
const compiled = ts.transpileModule(fs.readFileSync("src/components/YouTubeUploader.tsx", "utf8"), {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020, jsx: ts.JsxEmit.ReactJSX },
}).outputText;

// Small hook harness: exercise the component's events/effects without a browser or network.
function harness({ configured = true, confirm = true, duplicate = false } = {}) {
  const slots = [];
  const pending = [];
  const calls = [];
  const confirmations = [];
  let index = 0;
  let tree;
  let props = { videoPath: "20260906/test.mp4", title: "Existing title", caption: "Existing caption" };
  const exports = {};
  const hooks = {
    useId: () => "youtube-options",
    useState(initial) {
      const slot = index++;
      if (!(slot in slots)) slots[slot] = initial;
      return [slots[slot], (value) => { slots[slot] = typeof value === "function" ? value(slots[slot]) : value; }];
    },
    useEffect(effect, deps) {
      const slot = index++;
      if (!slots[slot] || deps.some((value, i) => value !== slots[slot].deps[i])) {
        slots[slot]?.cleanup?.();
        slots[slot] = { deps };
        pending.push(() => { slots[slot].cleanup = effect(); });
      }
    },
  };
  vm.runInNewContext(compiled, {
    exports, process, TextEncoder,
    require: (name) => name === "react" ? hooks : name.endsWith(".css") ? { default: {} } : require(name),
    window: {
      confirm: (message) => { confirmations.push(message); return confirm; },
      setTimeout: () => 1, clearTimeout: () => {},
    },
    fetch: async (url, options) => {
      calls.push({ url, options });
      const body = options?.method === "POST" ? { run: { id: 31, status: "running", error: null } }
        : url.endsWith("/api/youtube") ? { configured, missing: configured ? [] : ["YOUTUBE_CLIENT_ID"] }
          : url.endsWith("/api/videos") ? { videos: [{ relativePath: props.videoPath, youtubeVideoId: duplicate ? "abcdefghijk" : null }] }
            : { run: { id: 31, status: "running", error: null }, log: "Uploading" };
      return { ok: true, json: async () => body };
    },
  });
  function render(changes = {}) {
    props = { ...props, ...changes };
    index = 0;
    tree = exports.default(props);
    pending.splice(0).forEach((effect) => effect());
  }
  function nodes(type) {
    const found = [];
    function visit(node) {
      if (Array.isArray(node)) return node.forEach(visit);
      if (!node || typeof node !== "object") return;
      if (node.type === type) found.push(node);
      visit(node.props?.children);
    }
    visit(tree);
    return found;
  }
  async function settle() { await new Promise(setImmediate); render(); }
  async function open() { nodes("button")[0].props.onClick(); render(); await settle(); }
  async function choose() {
    const selects = nodes("select");
    selects[1].props.onChange({ target: { value: "no" } });
    selects[2].props.onChange({ target: { value: "yes" } });
    render();
  }
  render();
  return { calls, confirmations, render, nodes, open, choose, settle, submit: () => nodes("button").at(-1).props.onClick() };
}

test("YouTube expands inline without another video selector or nested form", async () => {
  const ui = harness();
  assert.equal(ui.calls.length, 0);
  assert.equal(ui.nodes("button")[0].props.children, "Upload to YouTube");
  await ui.open();
  assert.equal(ui.nodes("section").length, 1);
  assert.equal(ui.nodes("form").length, 0);
  assert.equal(ui.nodes("input").length, 0);
  assert.equal(ui.nodes("textarea").length, 0);
  assert.equal(ui.nodes("select").length, 3);
  assert.equal(ui.nodes("select")[0].props.value, "private");
  assert.equal(ui.nodes("button").at(-1).props.disabled, true);
});

test("upload uses latest unsaved shared title/caption and only YouTube endpoint", async () => {
  const ui = harness();
  await ui.open();
  await ui.choose();
  ui.render({ title: "Edited 日本語", caption: "Unsaved description" });
  ui.submit();
  await ui.settle();
  const posts = ui.calls.filter((call) => call.options?.method === "POST");
  assert.equal(posts.length, 1);
  assert.equal(posts[0].url, "/api/youtube");
  assert.deepEqual(JSON.parse(posts[0].options.body), {
    path: "20260906/test.mp4", title: "Edited 日本語", description: "Unsaved description",
    privacy: "private", madeForKids: false, containsSyntheticMedia: true, confirmUpload: true,
  });
  assert.equal(ui.nodes("fieldset")[0].props.disabled, true);
});

test("cancelled confirmation or missing configuration never uploads", async () => {
  for (const options of [{ confirm: false }, { configured: false }]) {
    const ui = harness(options);
    await ui.open();
    await ui.choose();
    ui.submit();
    await ui.settle();
    assert.equal(ui.calls.some((call) => call.options?.method === "POST"), false);
  }
});

test("shared content exceeding YouTube limits blocks upload without truncation", async () => {
  const ui = harness();
  await ui.open();
  await ui.choose();
  for (const changes of [{ title: "x".repeat(101) }, { title: "Valid", caption: "日".repeat(1667) }]) {
    ui.render(changes);
    assert.equal(ui.nodes("button").at(-1).props.disabled, true);
    ui.submit();
  }
  assert.equal(ui.calls.some((call) => call.options?.method === "POST"), false);
});

test("duplicate uploads require explicit warning in confirmation", async () => {
  const ui = harness({ duplicate: true, confirm: false });
  await ui.open();
  await ui.choose();
  ui.submit();
  assert.match(ui.confirmations[0], /already uploaded.*separate YouTube video/);
  assert.equal(ui.nodes("a")[0].props.href, "https://www.youtube.com/watch?v=abcdefghijk");
});
