/**
 * Replay diagnostics render-model smoke test (v1.11.0 / report v5).
 *
 * Executes the real client bundle's SettingsSection component against hook
 * stubs and asserts the new two-layer stats layout renders:
 *   - v5 execution banner, diagnostics and continuous-account cards;
 *   - replay-parameter snapshot line and grouped diagnostic tables;
 *   - explicit legacy treatment for persisted v4 reports, with no v5 account
 *     cards or execution-quality tables inferred from their old shape.
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
const STATE = { DATA: 0, DRAFT: 1, STATS_RESULT: 20, STATS_DETAILS_OPEN: 22 };

function reactStubWith(seeds) {
  let index = 0;
  let activeSeeds = seeds;
  return {
    createElement(type, props, ...children) { return { type, props, children }; },
    memo: (fn) => fn,
    useState(initial) {
      const i = index++;
      if (Object.prototype.hasOwnProperty.call(activeSeeds, i)) {
        const value = activeSeeds[i];
        return [typeof value === "function" ? value() : value, () => {}];
      }
      return [typeof initial === "function" ? initial() : initial, () => {}];
    },
    useCallback: (fn) => fn,
    useEffect: () => {},
    useMemo: (fn) => fn(),
    useRef: (value) => ({ current: value }),
    useSyncExternalStore: () => null,
    reset(nextSeeds = {}) { index = 0; activeSeeds = nextSeeds; },
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

function renderStats(reportFixture, options = {}) {
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
    [STATE.STATS_DETAILS_OPEN]: options.details ? true : false,
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
  const translate = (key, params) => {
    if (key === "statsParamConfirmBars") return `cb${params.n}`;
    if (key === "statsUnexecutedReason_position_limit") return "reason-position-limit";
    return key;
  };
  const tree = settingsSection({ t: translate });
  assert.ok(tree, "component rendered a tree");
  if (!options.details) return tree;

  const dialogNode = findNodes(tree, (node) => typeof node.type === "function" && node.type.name === "ReplayStatsDetailsDialog")[0];
  assert.ok(dialogNode, "ReplayStatsDetailsDialog is mounted");
  reactHooks.reset({
    0: options.details.orders ?? [],
    1: Object.prototype.hasOwnProperty.call(options.details, "unexecutedSignals") ? options.details.unexecutedSignals : null,
    2: reportFixture.report?.overall ?? null,
    3: "",
    4: false,
  });
  const dialogTree = dialogNode.type({ ...dialogNode.props, t: translate });
  assert.ok(dialogTree, "details dialog rendered a tree");
  return dialogTree;
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
  if (version === 5) {
    base.calculationVersion = "goldboard-indicators-v3";
    base.strategyId = "control";
    base.strategyVersion = "goldboard-control-v1";
    base.dataSchemaVersion = "goldboard-market-data-v1";
    base.calendarVersion = "goldboard-configured-session-v1";
    base.lane = "cmb";
    base.executionVersion = "goldboard-execution-v1";
    base.fillPolicy = "next-bar-limit";
    base.ambiguityPolicy = "conservative-stop";
    base.evidenceStatus = "exploratory";
    base.validationGate = {
      status: "not_eligible",
      eligible: false,
      unmet: ["long_term_history_not_available", "no_oos_validation", "cost_semantics_unverified"],
    };
    base.costAssumptions = {
      explicitFeePerGram: { buy: 0, sell: 5 },
      slippagePerGram: { buy: 0.2, sell: 0.2 },
      configuredFallbackOffsetPerGram: { buy: 1.72, sell: 1.72 },
      estimatedSpreadPerGram: 0.2,
      historicalCmbProxySpreadPerGram: 5,
      productAgreementVerified: false,
      realBidAskQuotedSpreadIncluded: true,
    };
    base.executionCoverage = {
      denominator: "continuous-replay-bars",
      bars: 10,
      realBidAskBars: 2,
      proxyBars: 7,
      unknownBars: 1,
      realBidAskCoverage: 0.2,
      proxyBidAskCoverage: 0.7,
      unknownBidAskCoverage: 0.1,
    };
    base.completeDays = 8;
    base.partialDays = 0;
    base.fillRate = 0.5;
    base.expiryRate = 0.25;
    base.averageDelayMs = 420000;
    base.ambiguousBarCount = 2;
    base.realBidAskCoverage = 0.2;
    base.totals.unexecutedSignals = 2;
    base.caveats = [
      "lane-cmb-persisted-bars",
      "next-bar-limit-fills",
      "conservative-ambiguous-bars",
      "complete-session-only",
    ];
  }
  return base;
}

test("stats panel renders v5 execution diagnostics and continuous-account cards", () => {
  const tree = renderStats({ ok: true, cached: false, report: fixtureReport(5) });
  const strings = collectStrings(tree);
  assert.ok(strings.includes("statsV5Banner"), "v5 simulation banner");
  assert.ok(strings.includes("statsGeneratedAt"), "report generation time");
  assert.ok(strings.includes("statsStrategy"), "control strategy identity");
  assert.ok(strings.includes("statsVersions"), "report provenance versions");
  assert.ok(strings.includes("statsExecution"), "execution semantics");
  assert.ok(strings.includes("statsEvidenceExploratory"), "exploratory evidence status");
  assert.ok(strings.includes("statsValidationNotEligible"), "validation gate warning");
  assert.ok(strings.includes("statsCostAssumptions"), "cost assumptions");
  assert.ok(strings.includes("statsCostFees"), "cost fee assumptions");
  assert.ok(strings.includes("statsCostQuotedSpread"), "real quote spread rule is shown when real bars exist");
  assert.ok(strings.includes("statsProxyBidAskCoverage"), "proxy coverage");
  assert.ok(strings.includes("statsAverageDelay"), "average delay");
  assert.ok(strings.includes("statsFillRate"), "fill-rate diagnostic");
  assert.ok(strings.includes("statsExpiryRate"), "expiry diagnostic");
  assert.ok(strings.includes("statsAmbiguousBars"), "ambiguity diagnostic");
  assert.ok(strings.includes("statsBidAskCoverage"), "bid/ask coverage diagnostic");
  assert.ok(strings.includes("statsUnexecutedCount"), "unexecuted account-signal count");
  assert.ok(strings.includes("statsOverallTitle"), "continuous-account section title");
  assert.ok(strings.includes("+160.00"), `total net card value, signed numbers seen: ${strings.filter((s) => /^[+-]\d/.test(s)).join("|")}`);
  assert.ok(strings.includes("statsCardRealizedNet"), "realized P&L card");
  assert.ok(strings.includes("statsDetails"), "details action");
  assert.ok(strings.includes("statsParamsTitle") && strings.includes("cb2"), "parameter snapshot");
  assert.ok(strings.includes("statsGroupEntryTitle") && strings.includes("statsGroupExitTitle"), "v5 diagnostic groups");
  const tips = strings.filter((text) => text.startsWith("title:statsTip"));
  assert.ok(tips.includes("title:statsTipHoldNet"));
  assert.ok(tips.includes("title:statsTipExitSaving"));
});

test("stats details render account orders and position-limit signals separately", () => {
  const tree = renderStats({ ok: true, cached: false, report: fixtureReport(5) }, {
    details: {
      orders: [{
        orderId: "replay-order-1",
        signalAt: "2026-08-28T09:10:00.000Z",
        fillAt: "2026-08-28T09:15:00.000Z",
        status: "filled",
        action: "add_position",
        fillPrice: 996.43,
        grams: 10,
        positionBeforeGrams: 90,
        positionAfterGrams: 100,
      }],
      unexecutedSignals: [{
        signalAt: "2026-08-28T09:30:00.000Z",
        status: "not_executed",
        action: "add_position",
        signalPrice: 996.49,
        limitPrice: 995.88,
        positionBeforeGrams: 100,
        maxGrams: 100,
        reasonCode: "position_limit",
      }],
    },
  });
  const strings = collectStrings(tree);
  assert.ok(strings.includes("statsOrdersTitle"), "simulated orders remain in their own table");
  assert.ok(strings.includes("statsUnexecutedTitle"), "unexecuted signals get a dedicated table");
  assert.ok(strings.includes("statsSignalNotExecuted"), "signal is explicitly not executed");
  assert.ok(strings.includes("reason-position-limit"), "position-limit reason is visible");
  assert.ok(strings.includes("100.00 / 100.00"), "position and configured limit are shown together");
  assert.ok(strings.includes("995.88"), "the suggested limit remains visible without a fill");
  assert.ok(!strings.includes("996.49"), "the current signal-lane price is not mislabeled as the limit");
});

test("stats details tell old v5 reports to regenerate when blocked-signal data is absent", () => {
  const report = fixtureReport(5);
  delete report.totals.unexecutedSignals;
  const panelStrings = collectStrings(renderStats({ ok: true, cached: true, report }));
  assert.ok(panelStrings.includes("statsUnexecutedCountUnavailable"), "old reports do not claim zero blocked signals");

  const tree = renderStats({ ok: true, cached: true, report }, {
    details: { orders: [] },
  });
  const strings = collectStrings(tree);
  assert.ok(strings.includes("statsUnexecutedUnavailable"));
  assert.ok(!strings.includes("statsUnexecutedTitle"), "missing data is not presented as an empty signal set");
});

test("stats panel treats persisted v4 reports as legacy diagnostics", () => {
  const tree = renderStats({ ok: true, cached: true, report: fixtureReport(4) });
  const strings = collectStrings(tree);
  assert.ok(strings.includes("statsLegacyReport"), "legacy execution warning");
  assert.ok(!strings.includes("statsV5Banner"), "no v5 label on old data");
  assert.ok(!strings.includes("statsOverallTitle"), "legacy account output is not promoted as v5 P&L");
  assert.ok(!strings.includes("statsGroupEntryTitle") && !strings.includes("statsGroupExitTitle"), "old touch metrics are not promoted as v5 diagnostics");
  assert.ok(strings.includes("statsParamsTitle"), "legacy parameter snapshot remains readable");
});

test("stats panel limits the quoted-spread rule to reports with real bid/ask bars", () => {
  const report = fixtureReport(5);
  report.executionCoverage.realBidAskBars = 0;
  report.executionCoverage.proxyBars = 9;
  report.executionCoverage.realBidAskCoverage = 0;
  report.executionCoverage.proxyBidAskCoverage = 0.9;
  const strings = collectStrings(renderStats({ ok: true, cached: true, report }));
  assert.ok(!strings.includes("statsCostQuotedSpread"));
  assert.ok(strings.includes("statsCostProxy"));
});

test("stats panel accepts a validated label only with an explicit eligible gate", () => {
  const report = fixtureReport(5);
  report.evidenceStatus = "validated";
  report.validationGate = { status: "eligible", eligible: true, unmet: [] };
  const strings = collectStrings(renderStats({ ok: true, cached: true, report }));
  assert.ok(strings.includes("statsEvidenceValidated"));
  assert.ok(!strings.includes("statsEvidenceExploratory"));
  assert.ok(!strings.includes("statsValidationNotEligible"));
});

test("stats panel does not infer missing stage-zero metadata from an old report", () => {
  const report = fixtureReport(5);
  delete report.evidenceStatus;
  delete report.validationGate;
  delete report.costAssumptions;
  delete report.executionCoverage;
  report.caveats = ["future-caveat"];
  const strings = collectStrings(renderStats({ ok: true, cached: true, report }));
  assert.ok(strings.includes("statsEvidenceUnavailable"), "missing evidence status stays unknown");
  assert.ok(strings.includes("statsCostUnavailable"), "missing costs are not filled from current defaults");
  assert.ok(strings.includes("statsCoverageUnavailable"), "missing coverage is not treated as zero");
  assert.ok(strings.includes("statsCaveatUnknown"), "unknown caveat renders safely");
  assert.ok(!strings.includes("statsEvidenceValidated"), "legacy report is never promoted to validated");
});
