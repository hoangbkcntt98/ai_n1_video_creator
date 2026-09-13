import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import vm from "node:vm";
import { createRequire } from "node:module";
import ts from "typescript";

const require = createRequire(import.meta.url);
const compiled = ts.transpileModule(fs.readFileSync("src/components/WordCreator.tsx", "utf8"), {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020, jsx: ts.JsxEmit.ReactJSX },
}).outputText;

function harness(respond) {
  const slots = [], effects = [], timers = new Map(), calls = [];
  let index = 0, tree, timerId = 0;
  const exports = {};
  const hooks = {
    useState(initial) {
      const slot = index++;
      if (!(slot in slots)) slots[slot] = initial;
      return [slots[slot], (value) => { slots[slot] = value; }];
    },
    useEffect(effect, deps) {
      const slot = index++;
      const previous = slots[slot];
      if (!previous || deps.some((value, i) => value !== previous.deps[i])) {
        previous?.cleanup?.();
        slots[slot] = { deps };
        effects.push(() => { slots[slot].cleanup = effect(); });
      }
    },
  };
  vm.runInNewContext(compiled, {
    exports, process, Error, AbortController, encodeURIComponent, TextEncoder, btoa,
    setTimeout(fn) { timers.set(++timerId, fn); return timerId; },
    clearTimeout(id) { timers.delete(id); },
    require: (name) => name === "react" ? hooks : name === "./PatternVideoButton"
      ? { default: "PatternVideoButton" } : name.endsWith(".css") ? { default: {} } : require(name),
    fetch: async (url, options) => {
      calls.push({ url, options });
      return respond(url, options);
    },
  });
  function render() {
    index = 0;
    tree = exports.default();
    effects.splice(0).forEach((effect) => effect());
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
  async function settle() {
    for (let i = 0; i < 3; i++) { await new Promise(setImmediate); render(); }
  }
  async function tick() {
    const pending = [...timers.values()];
    timers.clear();
    pending.forEach((fn) => fn());
    await settle();
  }
  function unmount() {
    slots.forEach((slot) => slot?.cleanup?.());
  }
  render();
  return { calls, nodes, settle, tick, unmount, timers, render };
}

const job = { id: "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa", status: "queued",
  total: 2, processed: 0, generated: 0, current_source: null, errors: [], error: null };

test("UI posts once, polls progress, retries a 504 without posting again, refreshes completed videos", async () => {
  let progress = 0;
  const ui = harness((url, options) => {
    if (options?.method === "POST") return Response.json({ job }, { status: 202 });
    if (url.includes("jobId=")) {
      progress++;
      if (progress === 2) return new Response("<html>504 Gateway Timeout</html>", { status: 504 });
      return Response.json({ job: { ...job, status: progress >= 3 ? "completed" : "running",
        processed: progress >= 3 ? 2 : 1, generated: progress >= 3 ? 2 : 1 } });
    }
    return Response.json({ questions: [], job: null });
  });
  await ui.settle();
  assert.equal(ui.nodes("button")[0].props.disabled, false);
  ui.nodes("button")[0].props.onClick();
  await ui.settle();
  assert.equal(ui.nodes("button")[0].props.disabled, true);
  assert.ok(ui.nodes("p").some((node) => String(node.props.children).includes("1/2")));
  await ui.tick();
  assert.ok(ui.nodes("p").some((node) => String(node.props.children).includes("504")));
  assert.equal(ui.nodes("button")[0].props.disabled, true);
  await ui.tick();
  assert.equal(ui.nodes("button")[0].props.disabled, false);
  assert.ok(ui.nodes("p").some((node) => String(node.props.children).includes("Đã tạo 2/2")));
  assert.equal(ui.calls.filter((call) => call.options?.method === "POST").length, 1);
  assert.equal(ui.timers.size, 0);
  ui.unmount();
});

test("refresh restores running job and unmount cancels polling", async () => {
  const running = { ...job, status: "running", current_source: "語" };
  const ui = harness(() => Response.json({ questions: [], job: running }));
  await ui.settle();
  assert.equal(ui.nodes("button")[0].props.disabled, true);
  assert.ok(ui.calls.some((call) => call.url.includes("jobId=")));
  assert.equal(ui.calls.some((call) => call.options?.method === "POST"), false);
  assert.ok(ui.nodes("p").some((node) => String(node.props.children).includes("Source: 語")));
  ui.unmount();
  assert.equal(ui.timers.size, 0);
  assert.ok(ui.calls.filter((call) => call.url.includes("jobId=")).every((call) => call.options.signal.aborted));
});

test("failed background job shows saved error and permits retry", async () => {
  const failed = { ...job, status: "failed", error: "Render interrupted" };
  const ui = harness(() => Response.json({ questions: [], job: failed }));
  await ui.settle();
  assert.equal(ui.nodes("button")[0].props.disabled, false);
  assert.ok(ui.nodes("p").some((node) => String(node.props.children).includes("Render interrupted")));
  assert.equal(ui.calls.some((call) => call.url.includes("jobId=")), false);
  ui.unmount();
});

test("FPS defaults to 25 with auto mode, rejects fractions, and submits user's selected FPS", async () => {
  const ui = harness((_, options) => options?.method === "POST"
    ? Response.json({ job }, { status: 202 })
    : Response.json({ questions: [], job: null }));
  await ui.settle();
  const fpsInput = () => ui.nodes("label").find((node) => node.props.children[0] === "FPS").props.children[1];
  assert.equal(fpsInput().props.value, "25");
  assert.equal(ui.nodes("input").find((node) => node.props.type === "checkbox").props.checked, true);
  fpsInput().props.onChange({ target: { value: "29.97" } });
  ui.render();
  ui.nodes("button")[0].props.onClick();
  await ui.settle();
  assert.equal(ui.calls.some((call) => call.options?.method === "POST"), false);
  assert.ok(ui.nodes("p").some((node) => String(node.props.children).includes("FPS phải là số nguyên")));
  fpsInput().props.onChange({ target: { value: "40" } });
  ui.nodes("input").find((node) => node.props.type === "checkbox").props.onChange({ target: { checked: false } });
  ui.render();
  ui.nodes("button")[0].props.onClick();
  await ui.settle();
  assert.equal(JSON.parse(ui.calls.find((call) => call.options?.method === "POST").options.body).fps, 40);
  assert.equal(JSON.parse(ui.calls.find((call) => call.options?.method === "POST").options.body).autoFps, false);
  assert.equal(fpsInput().props.disabled, true);
  ui.unmount();
});

test("Kanji card embeds playable video with Unicode-safe URL, stored FPS, and empty state", async () => {
  const relativePath = "20260913/word-creator/遭う 語_word.mp4";
  const question = { id: 1, source: "遭", required_vocabulary: "遭う",
    answer_a: "あう", answer_b: "そうう", answer_c: "あえる", answer_d: "かう", correct_answer: "あう",
    template_path: "/tmp/遭.html", video_path: relativePath, duration_seconds: 10, fps: 40 };
  const ui = harness(() => Response.json({ questions: [question, { ...question, id: 2, video_path: null }], job: null }));
  await ui.settle();
  assert.equal(ui.nodes("video").length, 1);
  const video = ui.nodes("video")[0];
  assert.equal(video.props.controls, true);
  assert.equal(video.props.playsInline, true);
  assert.equal(video.props.preload, "none");
  const id = video.props.src.split("/").at(-1);
  assert.equal(Buffer.from(id, "base64url").toString("utf8"), relativePath);
  assert.equal(ui.nodes("a")[0].props.href, video.props.src);
  assert.equal(ui.nodes("PatternVideoButton")[0].props.videoPath, relativePath);
  assert.equal(ui.nodes("PatternVideoButton")[0].props.label, "Upload / Lên lịch");
  assert.ok(ui.nodes("small").some((node) => node.props.children.includes(40)));
  assert.ok(ui.nodes("div").some((node) => node.props.children === "Chưa có video"));
  ui.unmount();
});

test("Kanji selector fetches database options, paginates and submits selected source", async () => {
  const ui = harness((url, options) => {
    if (options?.method === "POST") return Response.json({ job }, { status: 202 });
    if (url.includes("sources=1")) return Response.json({
      sources: [{ source: "語", vocabulary: "語る", note_count: 2 }], hasMore: true,
    });
    return Response.json({ questions: [], job: null });
  });
  await ui.settle();
  await ui.tick();
  assert.ok(ui.nodes("option").some((node) => node.props.value === "語"));
  ui.nodes("select")[0].props.onChange({ target: { value: "語" } });
  ui.render();
  ui.nodes("button").find((node) => node.props.children === "Kanji tiếp").props.onClick();
  ui.render();
  await ui.tick();
  assert.ok(ui.calls.some((call) => call.url.includes("offset=100")));
  ui.nodes("input")[0].props.onChange({ target: { value: "語る" } });
  ui.render();
  await ui.tick();
  assert.ok(ui.calls.some((call) => call.url.includes(`q=${encodeURIComponent("語る")}&offset=0`)));
  ui.nodes("button")[0].props.onClick();
  await ui.settle();
  assert.equal(JSON.parse(ui.calls.find((call) => call.options?.method === "POST").options.body).source, "語");
  ui.unmount();
});

test("saved logs survive reload and source fetch errors are visible", async () => {
  const ui = harness((url) => url.includes("sources=1")
    ? Response.json({ error: "Anki unavailable" }, { status: 500 })
    : Response.json({ questions: [], job: { ...job, status: "failed", logs: [
      { id: "1", level: "info", source: "語", message: "Render frame", created_at: "2026-09-13T01:00:00Z" },
      { id: "2", level: "error", source: "語", message: "Render failed", created_at: "2026-09-13T01:01:00Z" },
    ] } }));
  await ui.settle();
  await ui.tick();
  assert.match(ui.nodes("pre")[0].props.children, /INFO \[語\] Render frame/);
  assert.match(ui.nodes("pre")[0].props.children, /ERROR \[語\] Render failed/);
  assert.ok(ui.nodes("p").some((node) => node.props.children === "Anki unavailable"));
  ui.unmount();
});
