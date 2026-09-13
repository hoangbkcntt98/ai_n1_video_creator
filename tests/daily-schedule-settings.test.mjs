import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import vm from "node:vm";
import { createRequire } from "node:module";
import ts from "typescript";

const require = createRequire(import.meta.url);
const compiled = ts.transpileModule(fs.readFileSync("src/components/PipelineScheduleSettings.tsx", "utf8"), {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020, jsx: ts.JsxEmit.ReactJSX },
}).outputText;

function harness(saved = null, mode = "daily") {
  const slots = [], effects = [], calls = [];
  let index = 0, tree;
  const exports = {};
  const hooks = {
    useState(initial) {
      const slot = index++;
      if (!(slot in slots)) slots[slot] = initial;
      return [slots[slot], (value) => { slots[slot] = value; }];
    },
    useEffect(effect) {
      const slot = index++;
      if (!slots[slot]) { slots[slot] = true; effects.push(effect); }
    },
  };
  vm.runInNewContext(compiled, {
    exports, process, Error, setInterval: () => 1, clearInterval() {},
    require: (name) => name === "react" ? hooks : name.endsWith(".css") ? { default: {} } : require(name),
    window: { confirm: () => true },
    fetch: async (url, options) => {
      calls.push({ url, options });
      if (options?.method === "DELETE") return { ok: true, json: async () => ({ ok: true }) };
      if (options?.method === "PUT") {
        const input = JSON.parse(options.body);
        return { ok: true, json: async () => ({ schedule: { ...input, startsAtUtc: "2026-09-12T08:00:00Z", nextRunAt: null } }) };
      }
      return { ok: !!saved, status: saved ? 200 : 404, json: async () => ({ schedule: saved }) };
    },
  });
  function render() {
    index = 0; tree = exports.default({ mode }); effects.splice(0).forEach((effect) => effect());
  }
  function nodes(type) {
    const found = [];
    function visit(node) {
      if (Array.isArray(node)) return node.forEach(visit);
      if (!node || typeof node !== "object") return;
      if (node.type === type) found.push(node);
      visit(node.props?.children);
    }
    visit(tree); return found;
  }
  async function settle() { await new Promise(setImmediate); render(); }
  function change(label, value) {
    const target = nodes("label").find((node) => node.props.children.some((child) => typeof child === "string" && child.trim() === label));
    assert.ok(target, `Missing label: ${label}`);
    const input = target.props.children.find((node) => node?.type === "input" || node?.type === "select");
    input.props.onChange({ target: { value, checked: value } }); render();
  }
  function save() { nodes("button").find((node) => node.props.children === "Save Schedule").props.onClick(); }
  render();
  return { calls, nodes, settle, render, change, save };
}

test("interval panel sends user's 5-hour/4-video example without a mode switch", async () => {
  const ui = harness(null, "interval"); await ui.settle();
  assert.equal(ui.nodes("input").some((node) => node.props.type === "time"), false);
  assert.equal(ui.nodes("select").length, 0);
  ui.change("Start date and time", "2026-09-12T15:00:00");
  ui.change("Repeat every (hours)", "5");
  ui.change("Videos per batch", "4");
  ui.change("Timezone", "Asia/Ho_Chi_Minh");
  ui.nodes("input").find((node) => node.props.type === "checkbox").props.onChange({ target: { checked: true } });
  ui.render(); ui.save(); await ui.settle();
  const puts = ui.calls.filter((call) => call.options?.method === "PUT");
  assert.equal(puts.length, 1);
  assert.match(puts[0].url, /\/api\/schedule\?mode=interval$/);
  const payload = JSON.parse(puts[0].options.body);
  assert.equal(payload.enabled, true);
  assert.equal(payload.mode, "interval");
  assert.equal(payload.startsAt, "2026-09-12T15:00:00");
  assert.equal(payload.timezone, "Asia/Ho_Chi_Minh");
  assert.equal(payload.intervalHours, 5);
  assert.equal(payload.videosPerRun, 4);
  assert.equal(ui.nodes("input").find((node) => node.props.type === "datetime-local").props.step, "1");
});

test("dashboard reload restores saved interval and shows next batch with timezone", async () => {
  const ui = harness({ enabled: true, mode: "interval", startsAt: "2026-09-12T15:00:00", intervalHours: 5,
    videosPerRun: 4, runTime: "09:00", timezone: "Asia/Ho_Chi_Minh", pendingVideos: 3,
    nextRunAt: "2026-09-12T13:00:00Z", publishToFacebook: false, publishToYouTube: false }, "interval");
  await ui.settle();
  assert.equal(ui.nodes("h2")[0].props.children, "Repeat every N hours");
  assert.equal(ui.nodes("input").find((node) => node.props.type === "datetime-local").props.value, "2026-09-12T15:00:00");
  assert.deepEqual(ui.nodes("input").filter((node) => node.props.type === "number").map((node) => node.props.value), ["5", "4"]);
  assert.ok(ui.nodes("p").some((node) => JSON.stringify(node.props.children).includes("20:00:00")));
});

test("dashboard rejects empty start or nonpositive/fractional batch settings without saving", async () => {
  const ui = harness(null, "interval"); await ui.settle();
  ui.save(); await ui.settle();
  ui.change("Start date and time", "2026-09-12T15:00:00");
  for (const [label, value] of [["Repeat every (hours)", "0"], ["Repeat every (hours)", "1.5"], ["Videos per batch", "101"]]) {
    ui.change(label, value); ui.save(); await ui.settle();
    assert.ok(ui.nodes("p").some((node) => node.props.role === "alert"));
  }
  assert.equal(ui.calls.filter((call) => call.options?.method === "PUT").length, 0);
});

test("daily and interval panels have separate fields, requests, state and element IDs", async () => {
  const daily = harness();
  const interval = harness({ mode: "interval", enabled: true, startsAt: "2026-09-12T15:00:00",
    runTime: "09:00", timezone: "Asia/Ho_Chi_Minh", intervalHours: 5, videosPerRun: 4 }, "interval");
  await daily.settle(); await interval.settle();
  assert.equal(daily.nodes("h2")[0].props.children, "Daily Schedule");
  assert.equal(daily.nodes("input").some((node) => node.props.type === "time"), true);
  assert.equal(daily.nodes("input").some((node) => node.props.type === "datetime-local"), false);
  for (const tag of ["h2", "datalist"]) {
    assert.notEqual(daily.nodes(tag)[0].props.id, interval.nodes(tag)[0].props.id);
  }
  daily.change("Time", "11:30");
  daily.change("Enable schedule", true);
  daily.save(); await daily.settle();
  assert.equal(JSON.parse(daily.calls.at(-1).options.body).mode, "daily");
  assert.ok(daily.calls.every((call) => call.url.endsWith("?mode=daily")));
  assert.equal(interval.calls.length, 1);
  interval.nodes("button").find((node) => node.props.children === "Delete Schedule").props.onClick();
  await interval.settle();
  assert.ok(interval.calls.every((call) => call.url.endsWith("?mode=interval")));
  assert.equal(interval.calls.at(-1).options.method, "DELETE");
  assert.equal(interval.nodes("h2")[0].props.children, "Repeat every N hours");
  assert.equal(interval.nodes("input").find((node) => node.props.type === "datetime-local").props.value, "");
  assert.equal(daily.nodes("input").find((node) => node.props.type === "time").props.value, "11:30");
  assert.equal(daily.nodes("input").find((node) => node.props.type === "checkbox").props.checked, true);
  const page = fs.readFileSync("src/app/page.tsx", "utf8");
  assert.match(page, /<PipelineScheduleSettings mode="daily" \/>/);
  assert.match(page, /<PipelineScheduleSettings mode="interval" \/>/);
});
