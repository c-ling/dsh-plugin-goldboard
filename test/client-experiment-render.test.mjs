import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const SOURCE = readFileSync(new URL("../lib/client.js", import.meta.url), "utf8");

function createHooks(seeds = {}) {
  let index = 0;
  const effects = [];
  const cleanups = [];
  return {
    reset() { index = 0; },
    flushEffects() {
      while (effects.length) {
        const cleanup = effects.shift()();
        if (typeof cleanup === "function") cleanups.push(cleanup);
      }
    },
    cleanup() {
      while (cleanups.length) cleanups.pop()();
    },
    createElement(type, props, ...children) {
      const nextProps = { ...(props || {}) };
      if (children.length === 1) nextProps.children = children[0];
      else if (children.length > 1) nextProps.children = children;
      return { type, props: nextProps, children };
    },
    memo: (fn) => fn,
    Component: class { constructor(props) { this.props = props; this.state = {}; } setState() {} },
    useState(initial) {
      const current = index++;
      const value = Object.prototype.hasOwnProperty.call(seeds, current)
        ? seeds[current]
        : typeof initial === "function" ? initial() : initial;
      return [value, () => {}];
    },
    useCallback: (fn) => fn,
    useEffect(fn) { effects.push(fn); },
    useMemo: (fn) => fn(),
    useRef: (value) => ({ current: value }),
    useSyncExternalStore: () => null,
  };
}

function loadPanel(hooks) {
  let spec;
  const windowStub = { __ModuleLoader__: { load(value) { spec = value; } } };
  const style = { setAttribute() {}, dataset: {}, textContent: "" };
  const documentStub = {
    querySelector: () => null,
    createElement: () => style,
    head: { appendChild() {} },
    addEventListener(name, listener) { globalThis.document?.addEventListener?.(name, listener); },
    removeEventListener(name, listener) { globalThis.document?.removeEventListener?.(name, listener); },
  };
  new Function("window", "document", SOURCE)(windowStub, documentStub);
  assert.ok(spec, "factory bundle captured");
  const exports = spec.factory((id) => {
    if (id === "react") return hooks;
    throw new Error("unexpected require: " + id);
  });
  assert.equal(typeof exports.StrategyExperimentPanel, "function");
  return exports.StrategyExperimentPanel;
}

function expandTree(node) {
  if (node === null || node === undefined || typeof node === "boolean") return node;
  if (Array.isArray(node)) return node.map(expandTree);
  if (typeof node !== "object") return node;
  if (typeof node.type === "function") return expandTree(node.type(node.props || {}));
  return { ...node, children: expandTree(node.children) };
}

function collectStrings(node, out = []) {
  if (node === null || node === undefined || typeof node === "boolean") return out;
  if (typeof node === "string" || typeof node === "number") {
    out.push(String(node));
    return out;
  }
  if (Array.isArray(node)) {
    node.forEach((child) => collectStrings(child, out));
    return out;
  }
  if (typeof node === "object") {
    if (node.props?.title) out.push("title:" + node.props.title);
    if (node.props?.["aria-label"]) out.push("aria:" + node.props["aria-label"]);
    collectStrings(node.children, out);
  }
  return out;
}

function findNodes(node, predicate, out = []) {
  if (!node || typeof node !== "object") return out;
  if (Array.isArray(node)) {
    node.forEach((child) => findNodes(child, predicate, out));
    return out;
  }
  if (predicate(node)) out.push(node);
  findNodes(node.children, predicate, out);
  return out;
}

function baseConfig(enabled = false) {
  return {
    experiments: {
      version: "goldboard-strategy-experiment-config-v1",
      enabled,
      enabledStrategyIds: ["control", "orb-trend-pullback"],
      signalLanes: ["cmb", "au9999", "xau"],
      costMultipliers: [1, 1.5, 2],
      parameterMultipliers: [0.8, 1, 1.2],
      ablations: ["none", "without-regime-filter"],
      maxScenarios: 48,
      orb: {
        openingRangeBars: 6,
        breakoutAtrBuffer: 0.1,
        pullbackAtrTolerance: 0.35,
        setupExpiryBars: 12,
        orderValidityBars: 3,
        stopAtrMultiplier: 0.75,
        targetAtrMultiplier: 1.5,
        grams: 1,
        requireTrendRegime: true,
        requiredFactorIds: [],
        factorMaxAgeMs: 86400000,
      },
    },
  };
}

const catalog = [
  { strategyId: "control", strategyVersion: "goldboard-control-v1", live: true, enabled: true, canDisable: false },
  { strategyId: "orb-trend-pullback", strategyVersion: "goldboard-orb-trend-pullback-v1", live: false, enabled: true, canDisable: true },
];

function reportFixture() {
  return {
    version: 1,
    schema: "goldboard-strategy-experiment-v1",
    status: "partial",
    experimentId: "experiment-fixture",
    experimentFingerprint: "f".repeat(64),
    scenarios: [
      {
        scenarioId: "control-cmb",
        strategyId: "control",
        signalLane: "cmb",
        costMultiplier: 1,
        parameterMultiplier: 1,
        ablation: "none",
        status: "completed",
        metrics: { netPnlCny: 10, maxDrawdownCny: 4 },
        oos: { status: "insufficient_data", registeredFolds: 1, completedFolds: 0 },
      },
      {
        scenarioId: "orb-xau",
        strategyId: "orb-trend-pullback",
        signalLane: "xau",
        costMultiplier: 2,
        parameterMultiplier: 1.2,
        ablation: "without-regime-filter",
        status: "unavailable",
        reasonCodes: ["unsupported_lane"],
        oos: { status: "insufficient_data", registeredFolds: 0, completedFolds: 0 },
      },
    ],
    comparisons: [{
      strategyId: "orb-trend-pullback",
      signalLane: "cmb",
      candidateScenarioId: "orb-cmb",
      netPnlDeltaCny: 3,
      maxDrawdownDeltaCny: 1,
    }],
    promotion: {
      status: "not_eligible",
      eligible: false,
      liveStrategyChanged: false,
      candidates: [{
        strategyId: "orb-trend-pullback",
        status: "not_eligible",
        eligible: false,
        reasonCodes: ["oos_not_validated", "cost_stress_unstable"],
      }],
    },
    benchmarkCapabilities: [
      { id: "arima", status: "unavailable", reasonCode: "training_artifact_missing" },
      { id: "xgboost", status: "unavailable", reasonCode: "point_in_time_features_missing" },
    ],
  };
}

const t = (key) => key;

function basisFixture(config = baseConfig(true), strategies = catalog) {
  const experiments = structuredClone(config.experiments);
  experiments.enabledStrategyIds.sort();
  experiments.signalLanes.sort();
  experiments.costMultipliers.sort();
  experiments.parameterMultipliers.sort();
  experiments.ablations.sort();
  experiments.orb.requiredFactorIds.sort();
  return {
    experiments,
    fee: config.fee || {},
    cmb: config.cmb || {},
    limits: { maxGrams: config.limits?.maxGrams ?? null },
    risk: config.risk || {},
    controlStrategy: config.strategy || {},
    tradingHours: config.tradingHours || {},
    manualPrevClose: config.manualPrevClose || {},
    strategyDescriptors: strategies.map((entry) => ({
      strategyId: entry.strategyId || null,
      strategyVersion: entry.strategyVersion || null,
      descriptorFingerprint: entry.descriptorFingerprint || null,
      adapterFingerprint: entry.adapterFingerprint || null,
      executionInstrument: entry.executionInstrument || null,
      lanes: Array.isArray(entry.lanes) ? entry.lanes.slice().sort() : [],
    })).sort((left, right) => left.strategyId.localeCompare(right.strategyId)),
  };
}

function freshEligibleReport(config = baseConfig(true), strategies = catalog) {
  const basis = basisFixture(config, strategies);
  return {
    ...reportFixture(),
    generatedAt: "2026-08-14T04:01:00.000Z",
    asOf: "2026-08-14T04:00:00.000Z",
    run: { days: 10, mode: "diagnostic" },
    config: structuredClone(config.experiments),
    provenance: { basis, basisFingerprint: "basis-fixture" },
    promotion: {
      status: "eligible_to_apply", eligible: true, liveStrategyChanged: false,
      candidates: [{ strategyId: "orb-trend-pullback", status: "eligible_to_apply", eligible: true, reasonCodes: [] }],
    },
  };
}

test("experiment panel defaults disabled and renders fixed control plus replay candidate", () => {
  const hooks = createHooks({
    0: catalog, 1: baseConfig(false).experiments, 2: null, 3: null,
    4: null, 5: false, 6: null, 7: 10, 8: "diagnostic",
  });
  const Panel = loadPanel(hooks);
  const root = Panel({ t, cfg: baseConfig(false), update() {} });
  const tree = expandTree(root);
  const strings = collectStrings(tree);
  for (const key of [
    "experimentTitle",
    "experimentDisabledHint",
    "experimentControl",
    "experimentOrb",
    "experimentLiveFixed",
    "experimentReplayOnly",
    "experimentSignalLanes",
    "experimentCostMatrix",
    "experimentParameterMatrix",
    "experimentAblationMatrix",
    "experimentPromotionPreset",
    "experimentBreakoutBuffer",
    "experimentOrderValidityBars",
    "experimentRequiredFactors",
    "experimentEmpty",
  ]) assert.ok(strings.some((value) => value.includes(key)), key + " rendered");
  const runButton = findNodes(tree, (node) => node.type === "button" && node.children?.includes("experimentRun"))[0];
  assert.ok(runButton);
  assert.equal(runButton.props.disabled, true);
});

test("experiment panel exposes stale strategy IDs so old configuration can be cleaned", () => {
  const config = baseConfig(true);
  config.experiments.enabledStrategyIds.push("removed-strategy");
  let updated = null;
  const hooks = createHooks({
    0: catalog, 1: config.experiments, 2: "basis-fixture", 3: basisFixture(config),
    4: null, 5: false, 6: null, 7: 10, 8: "diagnostic",
  });
  const Panel = loadPanel(hooks);
  const tree = expandTree(Panel({
    t,
    cfg: config,
    update(mutator) {
      updated = structuredClone(config);
      mutator(updated);
    },
  }));
  const staleSwitch = findNodes(tree, (node) => node.type === "button"
    && node.props?.role === "switch" && node.props["aria-label"] === "experimentUnregistered")[0];
  assert.ok(staleSwitch);
  assert.equal(staleSwitch.props["aria-checked"], true);
  staleSwitch.props.onClick();
  assert.equal(updated.experiments.enabledStrategyIds.includes("removed-strategy"), false);
  const runButton = findNodes(tree, (node) => node.type === "button" && node.children?.includes("experimentRun"))[0];
  assert.equal(runButton.props.disabled, true);
});

test("experiment panel renders scenario, comparison, fail-closed promotion, and unavailable benchmarks", () => {
  const hooks = createHooks({
    0: catalog, 1: baseConfig(true).experiments, 2: "catalog-basis", 3: {},
    4: reportFixture(), 5: false, 6: null, 7: 20, 8: "walk-forward",
  });
  const Panel = loadPanel(hooks);
  const root = Panel({ t, cfg: baseConfig(true), update() {} });
  const tree = expandTree(root);
  const strings = collectStrings(tree);
  for (const key of [
    "experimentReportSchema",
    "experimentReportStatus",
    "experimentReportId",
    "experimentFingerprint",
    "experimentReportStale",
    "experimentScenarios",
    "experimentScenarioNet",
    "experimentStatus_completed",
    "experimentStatus_unavailable",
    "experimentComparisons",
    "experimentPromotion",
    "experimentPromotionSafe",
    "experimentBenchmarkCapabilities",
    "experimentBenchmarkUnavailable",
  ]) assert.ok(strings.some((value) => value.includes(key)), key + " rendered");
  assert.ok(strings.some((value) => value.includes("experimentPromotionReasons")), "promotion reason summary rendered");
  assert.ok(!strings.includes("statsEvidenceValidated"));
  assert.ok(!strings.includes("experimentPromotionEligible"));
});

test("experiment eligibility and Run require a fresh saved full basis", () => {
  const config = baseConfig(true);
  const report = freshEligibleReport(config);
  const basis = report.provenance.basis;
  const freshHooks = createHooks({
    0: catalog, 1: config.experiments, 2: "basis-fixture", 3: basis,
    4: report, 5: false, 6: null, 7: 10, 8: "diagnostic",
  });
  const promotionT = (key, params) => key === "experimentPromotionCandidate"
    ? `${key} ${params?.status || ""}` : key;
  const FreshPanel = loadPanel(freshHooks);
  const freshTree = expandTree(FreshPanel({ t: promotionT, cfg: config, update() {} }));
  const freshStrings = collectStrings(freshTree);
  assert.ok(freshStrings.some((value) => value.includes("experimentPromotionEligible")));
  assert.ok(!freshStrings.includes("experimentReportStale"));
  const freshRun = findNodes(freshTree, (node) => node.type === "button" && node.children?.includes("experimentRun"))[0];
  assert.equal(freshRun.props.disabled, false);

  const changed = baseConfig(true);
  changed.experiments.costMultipliers = [1, 2];
  const staleHooks = createHooks({
    0: catalog, 1: config.experiments, 2: "basis-fixture", 3: basis,
    4: report, 5: false, 6: null, 7: 10, 8: "diagnostic",
  });
  const StalePanel = loadPanel(staleHooks);
  const staleTree = expandTree(StalePanel({ t: promotionT, cfg: changed, update() {} }));
  const staleStrings = collectStrings(staleTree);
  assert.ok(staleStrings.includes("experimentReportStale"));
  assert.ok(staleStrings.includes("experimentSaveRequired"));
  assert.ok(!staleStrings.some((value) => value.includes("experimentPromotionEligible")));
  const staleRun = findNodes(staleTree, (node) => node.type === "button" && node.children?.includes("experimentRun"))[0];
  assert.equal(staleRun.props.disabled, true);

  const riskChanged = baseConfig(true);
  riskChanged.risk = { mode: "fixed_grams", maxDailyLossCny: 321 };
  const riskHooks = createHooks({
    0: catalog, 1: config.experiments, 2: "basis-fixture", 3: basis,
    4: report, 5: false, 6: null, 7: 10, 8: "diagnostic",
  });
  const RiskPanel = loadPanel(riskHooks);
  const riskTree = expandTree(RiskPanel({ t: promotionT, cfg: riskChanged, update() {} }));
  const riskStrings = collectStrings(riskTree);
  assert.ok(riskStrings.includes("experimentSaveRequired"));
  assert.ok(riskStrings.includes("experimentReportStale"));
  const riskRun = findNodes(riskTree, (node) => node.type === "button" && node.children?.includes("experimentRun"))[0];
  assert.equal(riskRun.props.disabled, true, "unsaved risk changes invalidate the full experiment basis");
});

test("experiment run posts only fresh saved selections and exposes durability warnings", async (ctx) => {
  const config = baseConfig(true);
  const report = freshEligibleReport(config);
  const basis = report.provenance.basis;
  const hooks = createHooks({
    0: catalog, 1: config.experiments, 2: "basis-fixture", 3: basis,
    4: report, 5: false, 6: {
      key: "experimentPersistWarning", warning: true,
      error: { code: "EXPERIMENT_PERSIST_FAILED" }, fallback: "EXPERIMENT_PERSIST_FAILED",
    }, 7: 10, 8: "diagnostic",
  });
  const Panel = loadPanel(hooks);
  const calls = [];
  const previousFetch = globalThis.fetch;
  globalThis.fetch = async (url, init = {}) => {
    calls.push({ url, init });
    if (String(url).endsWith("/strategies")) return { ok: true, json: async () => ({
      ok: true, strategies: catalog, config: config.experiments, basis, basisFingerprint: "basis-fixture",
    }) };
    return { ok: true, json: async () => ({ ok: true, report, persisted: false,
      persistenceError: { code: "EXPERIMENT_PERSIST_FAILED" } }) };
  };
  ctx.after(() => { globalThis.fetch = previousFetch; });
  const tree = expandTree(Panel({ t, cfg: config, update() {} }));
  assert.ok(collectStrings(tree).some((value) => value.includes("experimentPersistWarning")));
  const runButton = findNodes(tree, (node) => node.type === "button" && node.children?.includes("experimentRun"))[0];
  runButton.props.onClick();
  await new Promise((resolve) => setImmediate(resolve));
  const post = calls.find((entry) => entry.init.method === "POST");
  assert.ok(post);
  assert.deepEqual(JSON.parse(post.init.body), {
    days: 10, mode: "diagnostic",
    strategyIds: ["control", "orb-trend-pullback"],
    signalLanes: ["cmb", "au9999", "xau"],
  });
  assert.ok(post.init.signal instanceof AbortSignal);
});

test("experiment run rejects a click-time full-basis race before POST", async (ctx) => {
  const config = baseConfig(true);
  const basis = basisFixture(config);
  const hooks = createHooks({
    0: catalog, 1: config.experiments, 2: "basis-fixture", 3: basis,
    4: null, 5: false, 6: null, 7: 10, 8: "diagnostic",
  });
  const Panel = loadPanel(hooks);
  const calls = [];
  const previousFetch = globalThis.fetch;
  globalThis.fetch = async (url, init = {}) => {
    calls.push({ url: String(url), init });
    return { ok: true, json: async () => ({
      ok: true, strategies: catalog, config: config.experiments,
      basis: { ...basis, risk: { maxDailyLossCny: 999 } }, basisFingerprint: "changed-basis",
    }) };
  };
  ctx.after(() => { globalThis.fetch = previousFetch; });
  const tree = expandTree(Panel({ t, cfg: config, update() {} }));
  const runButton = findNodes(tree, (node) => node.type === "button" && node.children?.includes("experimentRun"))[0];
  assert.equal(runButton.props.disabled, false);
  runButton.props.onClick();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(calls.filter((entry) => entry.init.method === "POST").length, 0);
});

test("experiment panel aborts an active request on unmount", async (ctx) => {
  const config = baseConfig(true);
  const report = freshEligibleReport(config);
  const basis = report.provenance.basis;
  const hooks = createHooks({
    0: catalog, 1: config.experiments, 2: "basis-fixture", 3: basis,
    4: report, 5: false, 6: null, 7: 10, 8: "diagnostic",
  });
  const Panel = loadPanel(hooks);
  let activeSignal = null;
  const previousFetch = globalThis.fetch;
  globalThis.fetch = async (url, init = {}) => {
    if (String(url).endsWith("/strategies") && init.signal) {
      activeSignal = init.signal;
      return new Promise(() => {});
    }
    return { ok: true, json: async () => ({ ok: true, report: null }) };
  };
  ctx.after(() => { globalThis.fetch = previousFetch; });
  const tree = expandTree(Panel({ t, cfg: config, update() {} }));
  const runButton = findNodes(tree, (node) => node.type === "button" && node.children?.includes("experimentRun"))[0];
  runButton.props.onClick();
  await Promise.resolve();
  hooks.flushEffects();
  hooks.cleanup();
  assert.equal(activeSignal?.aborted, true);
});

test("experiment panel reloads saved catalog evidence after the settings refresh event", async (ctx) => {
  const config = baseConfig(true);
  const hooks = createHooks({
    0: catalog, 1: config.experiments, 2: "basis-fixture", 3: basisFixture(config),
    4: null, 5: false, 6: null, 7: 10, 8: "diagnostic",
  });
  const Panel = loadPanel(hooks);
  const calls = [];
  let refreshListener = null;
  const previousFetch = globalThis.fetch;
  const previousDocument = globalThis.document;
  globalThis.fetch = async (url) => {
    calls.push(String(url));
    return { ok: true, json: async () => String(url).endsWith("/strategies")
      ? { ok: true, strategies: catalog, config: config.experiments, basis: basisFixture(config), basisFingerprint: "basis-fixture" }
      : { ok: true, report: null } };
  };
  globalThis.document = {
    addEventListener(name, listener) { if (name === "dsh-plugin-goldboard:refresh") refreshListener = listener; },
    removeEventListener(name, listener) {
      if (name === "dsh-plugin-goldboard:refresh" && refreshListener === listener) refreshListener = null;
    },
  };
  ctx.after(() => {
    globalThis.fetch = previousFetch;
    if (previousDocument === undefined) delete globalThis.document;
    else globalThis.document = previousDocument;
  });
  Panel({ t, cfg: config, update() {} });
  hooks.flushEffects();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(calls.length, 2);
  refreshListener();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(calls.length, 4);
  hooks.cleanup();
  assert.equal(refreshListener, null);
});

test("experiment panel renders catalog and latest-report errors without claiming eligibility", () => {
  const renderError = (message) => {
    const hooks = createHooks({
      0: [],
      1: null,
      2: null,
      3: null,
      4: null,
      5: false,
      6: message,
      7: 10,
      8: "diagnostic",
    });
    const Panel = loadPanel(hooks);
    const interpolatingT = (key, params) => key + (params?.error ? ` ${params.error}` : "");
    return collectStrings(expandTree(Panel({ t: interpolatingT, cfg: baseConfig(true), update() {} })));
  };
  const catalogStrings = renderError({
    key: "experimentCatalogError",
    error: { code: "STRATEGY_REGISTRY_UNAVAILABLE" },
    fallback: "STRATEGY_REGISTRY_UNAVAILABLE",
  });
  assert.ok(catalogStrings.some((value) => value.includes("experimentCatalogError")));
  assert.ok(catalogStrings.some((value) => value.includes("error_STRATEGY_REGISTRY_UNAVAILABLE")));

  const latestStrings = renderError({
    key: "experimentLatestError",
    error: { code: "STRATEGY_EXPERIMENTS_UNAVAILABLE" },
    fallback: "STRATEGY_EXPERIMENTS_UNAVAILABLE",
  });
  assert.ok(latestStrings.some((value) => value.includes("experimentLatestError")));
  assert.ok(!latestStrings.includes("experimentPromotionEligible"));
});
