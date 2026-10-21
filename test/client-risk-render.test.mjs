import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const SOURCE = readFileSync(new URL("../lib/client.js", import.meta.url), "utf8");

function collectStrings(node, out = []) {
  if (node === null || node === undefined || node === false) return out;
  if (typeof node === "string" || typeof node === "number") {
    out.push(String(node));
    return out;
  }
  if (Array.isArray(node)) {
    for (const child of node) collectStrings(child, out);
    return out;
  }
  if (typeof node === "object") {
    if (node.props && node.props.title) out.push(String(node.props.title));
    if (node.props && node.props["aria-label"]) out.push(String(node.props["aria-label"]));
    collectStrings(node.children, out);
  }
  return out;
}

function loadOverview() {
  let spec;
  const windowStub = {
    innerWidth: 1280,
    innerHeight: 800,
    localStorage: { getItem: () => null, setItem: () => {} },
    __ModuleLoader__: { load(value) { spec = value; } },
  };
  const style = { setAttribute() {}, dataset: {}, textContent: "" };
  const documentStub = {
    hidden: false,
    querySelector: () => null,
    createElement: () => style,
    head: { appendChild() {} },
  };
  new Function("window", "document", SOURCE)(windowStub, documentStub);
  assert.ok(spec);

  const React = {
    Component: class { constructor(props) { this.props = props; this.state = {}; } setState() {} },
    createElement(type, props, ...children) { return { type, props: props || {}, children }; },
    memo: (fn) => fn,
    useState(initial) { return [typeof initial === "function" ? initial() : initial, () => {}]; },
    useCallback: (fn) => fn,
    useEffect: () => {},
    useMemo: (fn) => fn(),
    useRef: (value) => ({ current: value }),
    useSyncExternalStore: () => null,
  };
  const exports = spec.factory((id) => {
    if (id === "react") return React;
    throw new Error("unexpected require: " + id);
  });
  assert.equal(typeof exports.OverviewTab, "function");
  return exports.OverviewTab;
}

function renderOverview(snapshot, options = {}) {
  const OverviewTab = loadOverview();
  return OverviewTab({
    t: (key) => key,
    snap: snapshot,
    error: "",
    loading: false,
    onRefresh: () => {},
    onOpenTab: options.onOpenTab ?? (() => {}),
    onOpenLedger: options.onOpenLedger,
  });
}

function baseSnapshot(plan) {
  return {
    ok: true,
    serverTime: "2026-08-14T02:00:00.000Z",
    marketState: "open",
    market: { state: "open", open: "09:00", close: "26:00" },
    quotes: { AU9999: null, XAU: null, USDCNY: null, CMB: null },
    derived: { cmb: null },
    trend: { AU9999_1m: [], XAU_1m: [], CMB_1m: [] },
    indicators: {},
    position: { grams: 10, avgCostPerGram: 100, valuationAvailable: true, feeAdjustedPnl: -50 },
    risk: {
      mode: "fixed_grams",
      gate: { triggered: true, allowNewBuy: false, allowProtectiveExit: true, reasonCodes: ["max_daily_loss"] },
      losses: { dailyLossCny: 120, weeklyLossCny: 120, drawdownCny: 120 },
      adds: { today: 1, activeSetup: 0 },
    },
    ledger: { counts: { decisions: 2, orders: 1, notExecuted: 1 }, activeSetupId: "setup-1" },
    plan,
  };
}

test("overview renders explicit blocked-gate and risk-sizing facts", () => {
  const tree = renderOverview(baseSnapshot({
    action: "wait",
    candidateAction: "add_position",
    reasonCodes: ["max_daily_loss"],
    activeSignals: [],
    suppressedSignals: [{ action: "add_position", side: "buy", reasonCodes: ["max_daily_loss"] }],
    risk: {
      nominalAmountCny: 0,
      stopDistancePerGram: 5,
      riskPerGram: 10.4,
      worstCaseLossCny: 0,
      availableRiskBudgetCny: 0,
      riskBudgetRatio: 0,
      reasonCodes: ["max_daily_loss"],
    },
    suggestedOrder: null,
  }));
  const strings = collectStrings(tree);
  for (const key of ["riskGateBlocked", "riskGateProtectiveExitAllowed", "riskStopDistance", "riskPerGram", "riskAvailableBudget", "riskBudgetRatio"]) {
    assert.ok(strings.some((value) => value.includes(key)), `${key} rendered`);
  }
  assert.ok(strings.some((value) => value.includes("max_daily_loss")), "blocked reason remains visible");
});

test("overview still renders a protective sell while the new-buy gate is blocked", () => {
  const tree = renderOverview(baseSnapshot({
    action: "sell_stop",
    candidateAction: "sell_stop",
    reasonCodes: ["stop_loss"],
    activeSignals: [{ code: "stop_loss", action: "sell_stop", side: "sell" }],
    suppressedSignals: [],
    risk: null,
    suggestedOrder: {
      action: "sell_stop",
      instrument: "CMB",
      side: "sell",
      signalPrice: 95,
      cmbEstimatedPrice: 94,
      grams: 10,
      validUntil: "2026-08-14T03:00:00.000Z",
    },
  }));
  const strings = collectStrings(tree);
  assert.ok(strings.includes("riskGateBlocked"));
  assert.ok(strings.includes("riskGateProtectiveExitAllowed"));
  assert.ok(strings.some((value) => value.includes("sell")), "protective sell order remains actionable in the UI");
});


test("overview ledger buttons forward the open/reset intent", () => {
  const calls = [];
  const tree = renderOverview(baseSnapshot({
    action: "wait",
    candidateAction: null,
    reasonCodes: [],
    activeSignals: [],
    suppressedSignals: [],
    risk: null,
    suggestedOrder: null,
  }), { onOpenLedger: (reset) => calls.push(reset === true) });
  const buttons = [];
  (function walk(node) {
    if (!node || typeof node !== "object") return;
    if (Array.isArray(node)) { node.forEach(walk); return; }
    if (node.type === "button") buttons.push(node);
    walk(node.children);
  })(tree);
  const label = (button) => collectStrings(button.children).join("|");
  const reset = buttons.find((button) => label(button).includes("resetPosition"));
  const ledger = buttons.find((button) => label(button).includes("ledgerDetails"));
  assert.ok(reset, "reset position button rendered");
  assert.ok(ledger, "view ledger button rendered");
  reset.props.onClick();
  ledger.props.onClick();
  assert.deepEqual(calls, [true, false]);
});
