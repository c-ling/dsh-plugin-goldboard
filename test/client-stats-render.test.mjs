/**
 * 策略统计 render-model smoke test (v1.10.0).
 *
 * Executes the real client bundle's SettingsSection component against hook
 * stubs and asserts the new two-layer stats layout renders:
 *   - merged "overall" cards (v3 reports carry report.overall);
 *   - replay-parameter snapshot line;
 *   - grouped entry/exit tables;
 *   - graceful degradation for legacy v2 persisted reports (no overall /
 *     params.strategy): cards fall back to per-action averages, snapshot line
 *     hidden, groups still render.
 *
 * No DOM: el() records element descriptors, so only the component body runs —
 * exactly the code paths this test owns.
 */

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import { normalizeConfig } from "../lib/config.js";

const CLIENT_SOURCE = readFileSync(new URL("../lib/client.js", import.meta.url), "utf8");

/** useState call order inside SettingsSection — seed by index. */
const STATE = { DATA: 0, DRAFT: 1, STATS_RESULT: 20 };

function reactStubWith(seeds) {
  let index = 0;
  return {
    createElement(type, props, ...children) { return { type, props, children }; },
    memo: (fn) => fn,
    useState(initial) {
      const i = index++;
      if (Object.prototype.hasOwnProperty.call(seeds, i)) {
        const value = seeds[i];
        return [typeof value === "function" ? value() : value, () => {}];
      }
      return [typeof initial === "function" ? initial() : initial, () => {}];
    },
    useCallback: (fn) => fn,
    useEffect: () => {},
    useMemo: (fn) => fn(),
    useRef: (value) => ({ current: value }),
    useSyncExternalStore: () => null,
  };
}

function loadSettingsSection() {
  let captured;
  const windowStub = { __ModuleLoader__: { load(spec) { captured = spec; } } };
  const style = { setAttribute() {}, dataset: {}, textContent: "" };
  const documentStub = {
    querySelector() { return null; },
    createElement() { return style; },
    head: { appendChild() {} },
  };
  new Function("window", "document", CLIENT_SOURCE)(windowStub, documentStub);
  assert.ok(captured, "client bundle is captured");

  let settingsSection = null;
  const slotsStub = {
    register(entry, component) { return { entry, component }; },
    inject(slot, factory) {
      const registered = factory();
      if (registered?.entry?.name === "settings.section") settingsSection = registered.component;
      return () => {};
    },
  };
  const localeStub = { bind: () => (key) => key, register: () => () => {} };
  const ctx = {
    get(id) {
      if (id === "slots") return slotsStub;
      if (id === "locale") return localeStub;
      return undefined;
    },
    effect(fn) { fn(); return () => {}; },
  };
  const clientExports = captured.factory((id) => {
    throw new Error("unexpected require: " + id); // replaced below
  });
  void clientExports;
  return { captured, ctxStubOf() {
    return function requireWith(reactStubs) {
      return function (id) { if (id === "react") return reactStubs; throw new Error("unexpected require: " + id); };
    };
  }, slotsKey: () => slotsStub };
}

function renderStats(reportFixture) {
  let captured;
  {
    // Capture the bundle spec (same recipe as host.test.mjs).
    const windowStub = { __ModuleLoader__: { load(spec) { captured = spec; } } };
    const style = { setAttribute() {}, dataset: {}, textContent: "" };
    const documentStub = {
      querySelector() { return null; },
      createElement() { return style; },
      head: { appendChild() {} },
    };
    new Function("window", "document", CLIENT_SOURCE)(windowStub, documentStub);
  }
  assert.ok(captured, "client bundle is captured");

  let settingsSection = null;
  const slotsStub = {
    register(entry, component) { return { entry, component }; },
    inject(slot, factory) {
      const registered = factory();
      if (registered?.entry?.name === "settings.section") settingsSection = registered.component;
      return () => {};
    },
  };
  const localeStub = { bind: () => (key) => key, register: () => () => {} };
  const reactHooks = reactStubWith({
    [STATE.DRAFT]: normalizeConfig({}),
    [STATE.STATS_RESULT]: reportFixture,
  });
  const clientExports = captured.factory((id) => {
    if (id === "react") return reactHooks;
    throw new Error("unexpected require: " + id);
  });
  clientExports.apply({
    get(id) {
      if (id === "slots") return slotsStub;
      if (id === "locale") return localeStub;
      return undefined;
    },
    effect(fn) { fn(); return () => {}; },
  });
  assert.ok(settingsSection, "SettingsSection component is registered");
  const tree = settingsSection({ t: (key, params) => {
    if (key === "statsParamConfirmBars") return `cb${params.n}`;
    return key;
  } });
  assert.ok(tree, "component rendered a tree");
  return tree;
}

function collectStrings(node, out = []) {
  if (node === null || node === undefined || typeof node === "boolean") return out;
  if (typeof node === "string" || typeof node === "number") { out.push(String(node)); return out; }
  if (Array.isArray(node)) { node.forEach((child) => collectStrings(child, out)); return out; }
  if (typeof node === "object") {
    if (node.props && node.props.title) out.push(`title:${node.props.title}`);
    if (node.children !== undefined) collectStrings(node.children, out);
  }
  return out;
}

function findNodes(node, predicate, out = []) {
  if (!node || typeof node !== "object") return out;
  if (Array.isArray(node)) { node.forEach((child) => findNodes(child, predicate, out)); return out; }
  if (predicate(node)) out.push(node);
  if (node.children !== undefined) findNodes(node.children, predicate, out);
  return out;
}

function fixtureReport(version) {
  const base = {
    version,
    generatedAt: "2026-08-14T04:00:00.000Z",
    calculationVersion: "goldboard-indicators-v2",
    params: { days: 10, lane: "cmb" },
    window: { from: "2026-08-03", to: "2026-08-14" },
    daysRequested: 10,
    daysEvaluated: 8,
    daysSkippedNoData: 1,
    daysFailed: 0,
    totals: { steps: 4080, directionalEvents: 3, blockedSteps: 12, coverageBlockedRatio: 0.0029 },
    perAction: [
      { action: "buy_setup", count: 2, targetHitRate: 0.5, stopHitRate: 0, breakevenTouchedRate: 0.5, avgMfe30m: 1.2, avgMae30m: 0.8, avgMfe60m: 1.6, avgMae60m: 1.1, avgPostExitDrift60m: null, sessionEndAvgNet: 0.4, perLaneSplit: { CMB: 2 } },
      { action: "sell_weakness", count: 1, targetHitRate: null, stopHitRate: null, breakevenTouchedRate: null, avgMfe30m: 0.7, avgMae30m: 0.3, avgMfe60m: 0.9, avgMae60m: 0.5, avgPostExitDrift60m: -1.5, sessionEndAvgNet: 0.8, perLaneSplit: { CMB: 1 } },
    ],
    confidenceBuckets: [],
    caveats: ["lane-cmb-persisted-bars", "minute-coverage-from-5m", "synthetic-lane-sampling", "history-depth-limited", "continuous-zero-position", "two-simulated-passes", "past-performance-advisory"],
    failures: [],
  };
  if (version >= 4) {
    base.params.fee = { buyPerGram: 0, sellPerGram: 5 };
    base.params.limits = { maxGrams: 10 };
    base.params.strategy = normalizeConfig({}).strategy;
    base.overall = {
      accounting: "continuous-zero-position",
      startingGrams: 0,
      endingGrams: 5,
      endingMarkPrice: 960,
      totalNetCny: 160,
      realizedNetCny: 50,
      unrealizedNetCny: 110,
      eventsWithOutcome: 3,
      entryEvents: 2,
      exitEvents: 1,
    };
  }
  return base;
}

test("stats panel renders the continuous zero-position view for v4 reports", () => {
  const tree = renderStats({ ok: true, cached: false, report: fixtureReport(4) });
  const strings = collectStrings(tree);
  // Continuous account cards present with their independently explained values.
  assert.ok(strings.includes("statsOverallTitle"), "continuous-account section title");
  assert.ok(strings.includes("+160.00"), `total net card value, signed numbers seen: ${strings.filter((s) => /^[+-]\d/.test(s)).join("|")}`);
  assert.ok(strings.includes("statsCardRealizedNet"), "realized P&L card");
  assert.ok(strings.includes("statsCardUnrealizedNet"), "ending holding P&L card");
  assert.ok(strings.includes("statsCardEndingPosition"), "ending position card");
  assert.ok(strings.includes("statsDetails"), "total net card exposes the operation details action");
  assert.ok(strings.includes("5.00"), "ending position value");
  // Parameter snapshot line reflects the strategy values used.
  assert.ok(strings.includes("statsParamsTitle"), "params snapshot label");
  assert.ok(strings.includes("cb2"), "confirmBars chip interpolated");
  assert.ok(strings.includes("statsParamCloseOff"), "closeBySessionEnd=off chip");
  // Grouped tables render with their own headers.
  assert.ok(strings.includes("statsGroupEntryTitle"), "entry group");
  assert.ok(strings.includes("statsGroupExitTitle"), "exit group");
  assert.ok(strings.includes("statsTableHoldNet"), "hold-to-end column (entry family)");
  assert.ok(strings.includes("statsTableExitSaving"), "exit-vs-holding column (sell family)");
  // Header tooltips carry the explanation copy.
  const tips = strings.filter((text) => text.startsWith("title:statsTip"));
  assert.ok(tips.includes("title:statsTipHoldNet"), `hold-net tooltip, tips seen: ${tips.join("|")}`);
  assert.ok(tips.includes("title:statsTipExitSaving"), "exit-saving tooltip present");
});

test("stats panel degrades gracefully for legacy v2 reports (no overall/params)", () => {
  const tree = renderStats({ ok: true, cached: true, report: fixtureReport(2) });
  const strings = collectStrings(tree);
  // Older independent-event reports retain their quality tables, but must not
  // be mislabeled as a continuous zero-position account.
  assert.ok(!strings.includes("statsOverallTitle"), "legacy total is not shown as continuous account P&L");
  assert.ok(strings.includes("statsGroupEntryTitle") && strings.includes("statsGroupExitTitle"), "groups render");
  // No parameter snapshot line without params.strategy.
  assert.ok(!strings.includes("statsParamsTitle"), "params snapshot hidden for v2 reports");
});
