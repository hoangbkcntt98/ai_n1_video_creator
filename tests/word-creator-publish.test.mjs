import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import vm from "node:vm";
import { createRequire } from "node:module";
import ts from "typescript";

const require = createRequire(import.meta.url);
const compiled = ts.transpileModule(fs.readFileSync("src/components/PatternVideoButton.tsx", "utf8"), {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2021, jsx: ts.JsxEmit.ReactJSX },
}).outputText;
const video = { relativePath: "old/語_word.mp4", title: "語", caption: "WordCreator: 語",
  facebookVideoId: null, scheduledPublishAt: null, publishedAt: null };

function harness(respond, props = { patternId: 1, patternName: "語", videoPath: video.relativePath }) {
  const slots = [], effects = [], timers = new Map(), calls = [], confirmations = [];
  let index = 0, tree, timerId = 0, confirmResult = true;
  const exports = {};
  const hooks = {
    useState(initial) {
      const slot = index++;
      if (!(slot in slots)) slots[slot] = initial;
      return [slots[slot], (value) => { slots[slot] = typeof value === "function" ? value(slots[slot]) : value; }];
    },
    useEffect(effect, deps) {
      const slot = index++, previous = slots[slot];
      if (!previous || deps.some((value, i) => value !== previous.deps[i])) {
        previous?.cleanup?.();
        slots[slot] = { deps };
        effects.push(() => { slots[slot].cleanup = effect(); });
      }
    },
  };
  vm.runInNewContext(compiled, {
    exports, process, Error, AbortController, encodeURIComponent, btoa, unescape,
    window: { confirm(message) { confirmations.push(message); return confirmResult; } },
    alert: (message) => { throw new Error(message); },
    setTimeout(fn) { timers.set(++timerId, fn); return timerId; },
    clearTimeout(id) { timers.delete(id); },
    require: (name) => name === "react" ? hooks : name.startsWith("./") ? { default: name.slice(2) } : require(name),
    fetch: async (url, options) => { calls.push({ url, options }); return respond(url, options); },
  });
  function render() {
    index = 0;
    tree = exports.default(props);
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
    for (let i = 0; i < 4; i++) { await new Promise(setImmediate); render(); }
  }
  async function tick() {
    const pending = [...timers.values()];
    timers.clear();
    pending.forEach((fn) => fn());
    await settle();
  }
  function unmount() { slots.forEach((slot) => slot?.cleanup?.()); }
  render();
  return { calls, nodes, settle, tick, unmount, timers, render, confirmations,
    cancelConfirm() { confirmResult = false; } };
}

test("Kanji exact-path schedule waits for upload success, polls logs and refreshes metadata", async () => {
  let done = false;
  const schedule = new Date(Date.now() + 3_600_000).toISOString();
  const ui = harness((url, options) => {
    if (options?.method === "POST") return Response.json({ run: { id: 42, status: "running" } }, { status: 202 });
    if (url.includes("/runs/42/log")) return Response.json({
      run: { id: 42, status: done ? "success" : "running" }, log: done ? "Upload complete" : "Uploading...",
    });
    assert.ok(url.includes(`?path=${encodeURIComponent(video.relativePath)}`));
    return Response.json({ video: { ...video, scheduledPublishAt: done ? schedule : null, facebookVideoId: done ? "fb-test" : null } });
  });
  ui.nodes("button")[0].props.onClick();
  await ui.settle();
  ui.nodes("SchedulePicker")[0].props.onChange(schedule);
  ui.render();
  ui.nodes("button").find((node) => node.props.children === "Schedule Facebook Post").props.onClick();
  await ui.settle();
  assert.equal(ui.confirmations.length, 1);
  const request = JSON.parse(ui.calls.find((call) => call.options?.method === "POST").options.body);
  assert.equal(request.path, video.relativePath);
  assert.equal(request.scheduledAt, schedule);
  assert.equal(request.confirmPublish, true);
  assert.equal(ui.nodes("fieldset")[0].props.disabled, true);
  assert.match(ui.nodes("pre")[0].props.children, /Uploading/);
  assert.ok(!ui.nodes("p").some((node) => String(node.props.children).includes("đã xử lý xong")));
  done = true;
  await ui.tick();
  assert.equal(ui.nodes("fieldset")[0].props.disabled, false);
  assert.ok(ui.nodes("p").some((node) => String(node.props.children).includes("fb-test")));
  assert.match(ui.nodes("pre")[0].props.children, /Upload complete/);
  assert.equal(ui.calls.filter((call) => call.options?.method === "POST").length, 1);
  assert.equal(ui.timers.size, 0);
  ui.unmount();
});

test("invalid schedule and cancelled confirmation never upload; grammar keeps list lookup", async () => {
  const ui = harness((url, options) => {
    assert.equal(options?.method, undefined);
    assert.equal(url.split("?").length, 1);
    return Response.json({ videos: [video] });
  }, { patternId: 3, patternName: "語" });
  ui.nodes("button")[0].props.onClick();
  await ui.settle();
  const scheduleButton = () => ui.nodes("button").find((node) => node.props.children === "Schedule Facebook Post");
  for (const date of ["invalid", new Date(Date.now() + 60_000).toISOString(), new Date(Date.now() + 30 * 86_400_000).toISOString()]) {
    ui.nodes("SchedulePicker")[0].props.onChange(date);
    ui.render();
    scheduleButton().props.onClick();
    await ui.settle();
    assert.ok(ui.nodes("p").some((node) => String(node.props.children).includes("10 phút đến 29 ngày")));
  }
  assert.equal(ui.confirmations.length, 0);
  ui.nodes("SchedulePicker")[0].props.onChange(new Date(Date.now() + 3_600_000).toISOString());
  ui.render();
  ui.cancelConfirm();
  scheduleButton().props.onClick();
  await ui.settle();
  assert.equal(ui.confirmations.length, 1);
  assert.equal(ui.calls.length, 1);
  ui.unmount();
});

test("upload failure displays error and log without resubmitting", async () => {
  const ui = harness((url, options) => {
    if (options?.method === "POST") return Response.json({ run: { id: 9, status: "running" } }, { status: 202 });
    if (url.includes("/runs/9/log")) return Response.json({ run: { id: 9, status: "failed", error: "Token expired" }, log: "Facebook rejected token" });
    return Response.json({ video });
  });
  ui.nodes("button")[0].props.onClick();
  await ui.settle();
  ui.nodes("button").find((node) => node.props.children === "Publish to Facebook").props.onClick();
  await ui.settle();
  assert.ok(ui.nodes("p").some((node) => String(node.props.children).includes("Token expired")));
  assert.match(ui.nodes("pre")[0].props.children, /rejected token/);
  assert.equal(ui.nodes("fieldset")[0].props.disabled, false);
  assert.equal(ui.calls.filter((call) => call.options?.method === "POST").length, 1);
  assert.equal(ui.timers.size, 0);
  ui.unmount();
});
