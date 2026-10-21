import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { DEFAULT_CONFIG, normalizeConfig } from "../lib/config.js";
import { valuePosition } from "../lib/execution.js";
import { classifyOrderTransition } from "../lib/alerts.js";
import { DATA_SOURCES } from "../lib/sources.js";
import {
  RISK_CONFIG_VERSION,
  RISK_POLICY_VERSION,
  RiskPolicy,
  evaluateBuyRisk,
} from "../lib/risk.js";
import {
  SIGNAL_LEDGER_VERSION,
  createSignalLedger,
  normalizeSignalLedger,
  projectSignalLedger,
  reconcileLedgerPosition,
  recordLedgerDecision,
  summarizeSignalLedger,
} from "../lib/signal-ledger.js";
import {
  STATE_SCHEMA_VERSION,
  loadStateWithMigration,
  makeWriteQueue,
  restoreRuntimeState,
} from "../lib/store.js";

const AS_OF = "2026-08-14T02:00:00.000Z";

function budgetConfig(patch = {}) {
  return normalizeConfig({
    fee: { buyPerGram: 0, sellPerGram: 0 },
    limits: { maxGrams: 1000 },
    strategy: { slippagePerGram: 0, signalCooldownMinutes: 0 },
    risk: {
      mode: "budget",
      maxRiskPerTradeCny: 1000,
      volatilityTarget: 1,
      ...patch,
    },
  });
}

function buyRisk(config, patch = {}) {
  return evaluateBuyRisk(config, {
    action: "buy_setup",
    currentGrams: 0,
    executableAsk: 101,
    executableBid: 100,
    suggestedPrice: 101,
    atrPerGram: 1,
    asOf: AS_OF,
    ...patch,
  });
}

function candidatePlan(patch = {}) {
  return {
    action: "buy_setup",
    candidateAction: "buy_setup",
    strategyVersion: "goldboard-control-v1",
    instrument: "CMB",
    signalBarT: Date.parse(AS_OF) - 300_000,
    signalPrice: 100,
    grams: 2,
    reasonCodes: ["trend_ema20_up"],
    activeSignals: [{ code: "trend_ema20_up", action: "buy_setup", side: "buy" }],
    suppressedSignals: [],
    suggestedOrder: {
      action: "buy_setup",
      instrument: "CMB",
      side: "buy",
      signalPrice: 100,
      cmbEstimatedPrice: 101,
      price: 101,
      grams: 2,
      validUntil: "2026-08-14T03:00:00.000Z",
    },
    ...patch,
  };
}

function record(ledger, plan, patch = {}) {
  return recordLedgerDecision(ledger, {
    plan,
    config: normalizeConfig({ position: { grams: 0, avgCostPerGram: 0 }, limits: { maxGrams: 100 } }),
    transition: { event: "record" },
    asOf: AS_OF,
    ...patch,
  });
}

test("risk config is versioned, opt-in, zero-friendly, and schema-aligned", () => {
  const normalized = normalizeConfig({
    risk: {
      version: "old",
      mode: "unknown",
      maxDailyLossCny: -1,
      maxAddsPerDay: 2.9,
      volatilityTarget: 0,
    },
    strategy: { orderRepricePct: 0, maxLossPerGram: 0 },
  });
  assert.equal(normalized.risk.version, RISK_CONFIG_VERSION);
  assert.equal(normalized.risk.mode, "fixed_grams");
  assert.equal(normalized.risk.maxDailyLossCny, 0);
  assert.equal(normalized.risk.maxAddsPerDay, 2);
  assert.equal(normalized.risk.volatilityTarget, 0);
  assert.equal(normalized.strategy.orderRepricePct, 0);
  assert.equal(normalized.strategy.maxLossPerGram, 0);
  assert.deepEqual(normalizeConfig({}).risk, normalizeConfig(DEFAULT_CONFIG).risk);
});

test("data-source English names contain no Chinese residue", () => {
  assert.deepEqual(DATA_SOURCES.filter((source) => /\p{Script=Han}/u.test(source.nameEn)).map((source) => source.id), []);
});

test("budget sizing is monotone under ATR, spread, slippage, and fees", () => {
  const baseConfig = budgetConfig();
  const base = buyRisk(baseConfig);
  const highAtr = buyRisk(baseConfig, { atrPerGram: 4 });
  const highSpread = buyRisk(baseConfig, { executableAsk: 106, executableBid: 100, suggestedPrice: 106 });
  const highSlippage = buyRisk(normalizeConfig({
    ...baseConfig,
    strategy: { ...baseConfig.strategy, slippagePerGram: 2 },
  }));
  const highFees = buyRisk(normalizeConfig({
    ...baseConfig,
    fee: { buyPerGram: 2, sellPerGram: 3 },
  }));

  assert.equal(base.allowed, true);
  assert.ok(highAtr.suggestedGrams <= base.suggestedGrams);
  assert.ok(highSpread.suggestedGrams <= base.suggestedGrams);
  assert.ok(highSlippage.suggestedGrams <= base.suggestedGrams);
  assert.ok(highFees.suggestedGrams <= base.suggestedGrams);
  assert.ok(base.worstCaseLossCny <= baseConfig.risk.maxRiskPerTradeCny);
  assert.equal(base.riskPolicyVersion, RISK_POLICY_VERSION);
});

test("buy sizing takes the minimum gram, amount, trade-risk, loss, and liquidity constraint", () => {
  const config = budgetConfig({
    maxAmountCny: 500,
    maxRiskPerTradeCny: 1000,
    maxDailyLossCny: 100,
    maxWeeklyLossCny: 200,
    maxDrawdownCny: 150,
    liquidityCapGrams: 2,
  });
  const result = buyRisk(config, {
    ledgerSummary: {
      lossIncludesUnrealized: true,
      dailyLossCny: 96,
      weeklyLossCny: 196,
      drawdownCny: 146,
    },
  });
  assert.equal(result.allowed, true);
  assert.ok(result.suggestedGrams <= 2);
  assert.ok(result.nominalAmountCny <= 500);
  assert.ok(result.worstCaseLossCny <= 5, "daily/drawdown remaining budget bounds worst loss");
  assert.ok(result.bindingConstraints.includes("max_daily_loss"));
  assert.ok(result.bindingConstraints.includes("max_drawdown"));

  const conservativeAmount = buyRisk(budgetConfig({ maxAmountCny: 200, maxRiskPerTradeCny: 10000 }), {
    executableAsk: 110,
    executableBid: 109,
    suggestedPrice: 100,
  });
  assert.ok(conservativeAmount.suggestedGrams <= 1.81);
  assert.ok(conservativeAmount.nominalAmountCny <= 200, "current executable ask bounds nominal exposure");
});

test("period-loss gates suppress buys while RiskPolicy always permits protective sells", () => {
  const config = budgetConfig({ maxDailyLossCny: 100, maxWeeklyLossCny: 200, maxDrawdownCny: 300 });
  const summary = {
    lossIncludesUnrealized: true,
    dailyLossCny: 100,
    weeklyLossCny: 200,
    drawdownCny: 300,
  };
  const buy = buyRisk(config, { ledgerSummary: summary });
  assert.equal(buy.allowed, false);
  assert.deepEqual(buy.reasonCodes.slice().sort(), ["max_daily_loss", "max_drawdown", "max_weekly_loss"].sort());
  assert.equal(buy.suggestedGrams, 0);

  const sell = new RiskPolicy(config).evaluate({
    side: "sell",
    fixedGrams: 10,
    action: "sell_stop",
    ledgerSummary: summary,
  });
  assert.equal(sell.allowed, true);
  assert.equal(sell.suggestedGrams, 10);
  assert.equal(sell.gate.allowProtectiveExit, true);
});

test("zero disables new risk gates, zero stop distance, and order drift", () => {
  const config = normalizeConfig({
    limits: { maxGrams: 100 },
    strategy: { maxLossPerGram: 0, orderRepricePct: 0 },
    risk: {
      mode: "fixed_grams",
      maxAmountCny: 0,
      maxRiskPerTradeCny: 0,
      maxDailyLossCny: 0,
      maxWeeklyLossCny: 0,
      maxDrawdownCny: 0,
      liquidityCapGrams: 0,
      maxAddsPerSetup: 0,
      maxAddsPerDay: 0,
    },
  });
  const result = buyRisk(config, { fixedGrams: 10 });
  assert.equal(result.allowed, true);
  assert.equal(result.suggestedGrams, 10);
  const zeroRisk = buyRisk(normalizeConfig({
    fee: { buyPerGram: 0, sellPerGram: 0 },
    limits: { maxGrams: 100 },
    strategy: { slippagePerGram: 0 },
    risk: { mode: "fixed_grams" },
  }), { fixedGrams: 10, executableAsk: 100, executableBid: 100, suggestedPrice: 100, atrPerGram: null });
  assert.equal(zeroRisk.allowed, true, "fixed sizing does not require risk-per-gram when every cash risk gate is off");
  assert.equal(zeroRisk.suggestedGrams, 10);

  const valuation = valuePosition({ grams: 10, avgCostPerGram: 100 }, { bid: 100, ask: 101 }, config);
  assert.equal(valuation.stopBid, null);
  assert.equal(valuation.stopTriggered, false);

  const order = { side: "buy", action: "buy_setup", signalPrice: 100, cmbEstimatedPrice: 101, grams: 10, validUntil: "2026-08-14T03:00:00Z" };
  const transition = classifyOrderTransition({
    previousOrder: order,
    currentOrder: null,
    plan: { action: "wait", marketState: "open", signalPrice: 120 },
    positionGrams: 0,
    repricePct: 0,
    now: new Date(AS_OF),
  });
  assert.equal(transition.event, "hold");
});

test("add gates cover setup/day counts, price improvement, cooldown, and loss de-risking", () => {
  const config = budgetConfig({
    maxAddsPerSetup: 1,
    maxAddsPerDay: 1,
    minAddPriceImprovementPerGram: 1,
    consecutiveLossDeRisk: 2,
  });
  const blocked = buyRisk(config, {
    action: "add_position",
    suggestedPrice: 100,
    ledgerSummary: {
      activeSetupAdds: 1,
      addsToday: 1,
      activeSetupLastBuyPrice: 100.5,
      consecutiveLosses: 2,
      lastBuyFillAt: "2026-08-14T01:59:00.000Z",
    },
  });
  assert.equal(blocked.allowed, false);
  assert.ok(blocked.reasonCodes.includes("max_adds_per_setup"));
  assert.ok(blocked.reasonCodes.includes("max_adds_per_day"));
  assert.ok(blocked.reasonCodes.includes("min_add_price_improvement"));

  const deRisk = buyRisk(budgetConfig({ consecutiveLossDeRisk: 2 }), {
    ledgerSummary: { consecutiveLosses: 2 },
  });
  const normal = buyRisk(budgetConfig({ consecutiveLossDeRisk: 2 }), {
    ledgerSummary: { consecutiveLosses: 0 },
  });
  assert.equal(deRisk.allowed, true);
  assert.ok(deRisk.suggestedGrams <= normal.suggestedGrams / 2 + 0.01);
  assert.equal(deRisk.deRiskFactor, 0.5);

  const cooldownConfig = normalizeConfig({
    ...budgetConfig(),
    strategy: { ...budgetConfig().strategy, signalCooldownMinutes: 30 },
  });
  const cooldown = buyRisk(cooldownConfig, {
    ledgerSummary: { lastBuyFillAt: "2026-08-14T01:59:00.000Z" },
  });
  assert.equal(cooldown.allowed, false);
  assert.ok(cooldown.reasonCodes.includes("post_fill_cooldown"));
});

test("same setup and closed bar reuse stable decision and order ids", () => {
  const first = record(createSignalLedger(), candidatePlan());
  const repeatedPlan = candidatePlan({
    suggestedOrder: { ...candidatePlan().suggestedOrder, cmbEstimatedPrice: 101.2, price: 101.2 },
  });
  const repeated = record(first.ledger, repeatedPlan, {
    previousOrder: first.plan.suggestedOrder,
    transition: { event: "refresh" },
    asOf: "2026-08-14T02:00:30.000Z",
  });
  assert.equal(repeated.ledger.setups.length, 1);
  assert.equal(repeated.ledger.decisions.length, 1);
  assert.equal(repeated.ledger.orders.length, 1);
  assert.equal(repeated.plan.setupId, first.plan.setupId);
  assert.equal(repeated.plan.decisionId, first.plan.decisionId);
  assert.equal(repeated.plan.suggestedOrder.orderId, first.plan.suggestedOrder.orderId);
  assert.equal(repeated.ledger.orders[0].limitPrice, 101.2, "refresh keeps the ledger's current suggested price");
  const held = recordLedgerDecision(repeated.ledger, {
    plan: { action: "wait", marketState: "open", instrument: "CMB", signalPrice: 101, reasonCodes: ["cooldown_active"], suggestedOrder: null },
    previousOrder: repeated.plan.suggestedOrder,
    transition: { event: "hold" },
    asOf: "2026-08-14T02:01:00.000Z",
  });
  assert.equal(held.ledger.activeSetupId, first.plan.setupId, "a standing order keeps its setup active through a benign wait");
  assert.equal(held.ledger.decisions.length, 1);
  assert.equal(held.ledger.orders[0].status, "pending");
});

test("order replacement preserves history and a suppressed decision creates no order", () => {
  const first = record(createSignalLedger(), candidatePlan());
  const updatedPlan = candidatePlan({
    signalBarT: Date.parse(AS_OF) - 300_000,
    suggestedOrder: { ...candidatePlan().suggestedOrder, cmbEstimatedPrice: 99, price: 99 },
  });
  const updated = recordLedgerDecision(first.ledger, {
    plan: updatedPlan,
    config: normalizeConfig({ position: { grams: 0 }, limits: { maxGrams: 100 } }),
    previousOrder: first.plan.suggestedOrder,
    transition: { event: "update" },
    asOf: "2026-08-14T02:05:00.000Z",
  });
  assert.equal(updated.ledger.decisions.length, 2, "a material same-bar replacement gets its own decision id");
  assert.equal(updated.ledger.orders.length, 2);
  assert.equal(updated.ledger.orders.filter((order) => order.status === "replaced").length, 1);
  assert.equal(updated.ledger.orders.filter((order) => order.status === "pending").length, 1);
  const replayedUpdate = recordLedgerDecision(updated.ledger, {
    plan: candidatePlan({
      signalBarT: Date.parse(AS_OF) - 300_000,
      suggestedOrder: { ...candidatePlan().suggestedOrder, cmbEstimatedPrice: 99, price: 99 },
    }),
    config: normalizeConfig({ position: { grams: 0 }, limits: { maxGrams: 100 } }),
    previousOrder: first.plan.suggestedOrder,
    transition: { event: "update" },
    asOf: "2026-08-14T02:05:00.000Z",
  });
  assert.equal(replayedUpdate.ledger.decisions.length, 2);
  assert.equal(replayedUpdate.ledger.orders.length, 2, "replaying one material update is idempotent");

  const suppressedPlan = candidatePlan({
    action: "wait",
    suggestedOrder: null,
    grams: 0,
    risk: { reasonCodes: ["max_daily_loss"], nominalAmountCny: 0, suggestedGrams: 0 },
    activeSignals: [],
    suppressedSignals: [{ action: "buy_setup", side: "buy", reasonCodes: ["max_daily_loss"] }],
  });
  const suppressed = record(createSignalLedger(), suppressedPlan);
  assert.equal(suppressed.ledger.decisions[0].status, "not_executed");
  assert.equal(suppressed.ledger.decisions[0].orderId, null);
  assert.equal(suppressed.ledger.orders.length, 0);
});

test("a triggered buy gate expires an existing pending buy without creating a replacement", () => {
  const first = record(createSignalLedger(), candidatePlan());
  const blockedPlan = {
    action: "wait",
    marketState: "open",
    instrument: "CMB",
    signalPrice: 100,
    reasonCodes: ["max_daily_loss"],
    riskGate: { triggered: true, reasonCodes: ["max_daily_loss"] },
    suggestedOrder: null,
  };
  const transition = classifyOrderTransition({
    previousOrder: first.plan.suggestedOrder,
    currentOrder: null,
    plan: blockedPlan,
    positionGrams: 0,
    repricePct: 0,
    now: new Date(AS_OF),
  });
  assert.deepEqual(transition, { event: "cancel", cause: "risk_gate", reasonCodes: ["max_daily_loss"] });
  const recorded = recordLedgerDecision(first.ledger, {
    plan: blockedPlan,
    previousOrder: first.plan.suggestedOrder,
    transition,
    asOf: AS_OF,
  });
  assert.equal(recorded.ledger.orders[0].status, "expired");
  assert.equal(recorded.ledger.orders[0].statusReason, "risk_gate");
  assert.equal(recorded.ledger.orders.filter((order) => order.status === "pending").length, 0);
});

test("position confirmation fills one exact pending order; mismatches stay adjustments", () => {
  const baseline = reconcileLedgerPosition(createSignalLedger(), {
    nextPosition: { grams: 10, avgCostPerGram: 100 },
    asOf: "2026-08-14T01:55:00.000Z",
  });
  const addPlan = candidatePlan({
    action: "add_position",
    candidateAction: "add_position",
    suggestedOrder: { ...candidatePlan().suggestedOrder, action: "add_position", grams: 2 },
  });
  const pending = recordLedgerDecision(baseline.ledger, {
    plan: addPlan,
    config: normalizeConfig({ position: { grams: 10, avgCostPerGram: 100 }, limits: { maxGrams: 100 } }),
    transition: { event: "record" },
    asOf: AS_OF,
  });
  const staleReference = reconcileLedgerPosition(pending.ledger, {
    previousPosition: { grams: 10, avgCostPerGram: 100 },
    nextPosition: { grams: 12, avgCostPerGram: 100 },
    pendingOrder: { ...pending.plan.suggestedOrder, orderId: "order-missing" },
    asOf: "2026-08-14T02:00:30.000Z",
  });
  assert.equal(staleReference.ledger.orders[0].status, "pending", "an explicit stale order id never falls back to another pending order");
  assert.equal(staleReference.ledger.adjustments[0].reasonCode, "manual_position_adjustment");

  const filled = reconcileLedgerPosition(pending.ledger, {
    previousPosition: { grams: 10, avgCostPerGram: 100 },
    nextPosition: { grams: 12, avgCostPerGram: 100 },
    pendingOrder: pending.plan.suggestedOrder,
    config: normalizeConfig({ fee: { buyPerGram: 0, sellPerGram: 0 }, strategy: { slippagePerGram: 0 } }),
    asOf: "2026-08-14T02:01:00.000Z",
    source: "config_route",
  });
  assert.equal(filled.ledger.orders[0].status, "filled");
  assert.equal(filled.ledger.orders[0].fillEvidence, "user_position_confirmation");
  assert.equal(filled.ledger.setups[0].addsFilled, 1);
  assert.equal(summarizeSignalLedger(filled.ledger, { asOf: "2026-08-14T02:02:00.000Z" }).addsToday, 1);

  const mismatchBase = reconcileLedgerPosition(createSignalLedger(), {
    nextPosition: { grams: 10, avgCostPerGram: 100 },
    asOf: "2026-08-14T01:55:00.000Z",
  });
  const mismatchPending = recordLedgerDecision(mismatchBase.ledger, {
    plan: candidatePlan({
      action: "add_position",
      candidateAction: "add_position",
      suggestedOrder: { ...candidatePlan().suggestedOrder, action: "add_position", grams: 2 },
    }),
    config: normalizeConfig({ position: { grams: 10, avgCostPerGram: 100 }, limits: { maxGrams: 100 } }),
    transition: { event: "record" },
    asOf: AS_OF,
  });
  const mismatch = reconcileLedgerPosition(mismatchPending.ledger, {
    nextPosition: { grams: 13, avgCostPerGram: 100 },
    pendingOrder: mismatchPending.plan.suggestedOrder,
    config: normalizeConfig({ fee: { buyPerGram: 0, sellPerGram: 0 }, strategy: { slippagePerGram: 0 } }),
    asOf: "2026-08-14T02:01:00.000Z",
  });
  assert.equal(mismatch.ledger.orders[0].status, "pending", "an oversized manual edit is not forged into a fill");
  assert.equal(mismatch.ledger.adjustments[0].reasonCode, "position_change_amount_mismatch");
  const mismatchSummary = summarizeSignalLedger(mismatch.ledger, { asOf: "2026-08-14T02:02:00.000Z" });
  assert.equal(mismatchSummary.addsToday, 1, "one manual adjustment is one add event");
  assert.equal(mismatchSummary.activeSetupAdds, 1, "manual add counts against the active setup");
  const unverifiableImprovement = buyRisk(budgetConfig({ minAddPriceImprovementPerGram: 1 }), {
    action: "add_position",
    ledgerSummary: mismatchSummary,
  });
  assert.equal(unverifiableImprovement.allowed, false);
  assert.ok(unverifiableImprovement.reasonCodes.includes("min_add_price_unavailable"));

  const manual = reconcileLedgerPosition(createSignalLedger(), {
    nextPosition: { grams: 1, avgCostPerGram: 100 },
    asOf: AS_OF,
  });
  const manualNext = reconcileLedgerPosition(manual.ledger, {
    nextPosition: { grams: 3, avgCostPerGram: 100 },
    asOf: "2026-08-14T02:05:00.000Z",
  });
  assert.equal(manualNext.ledger.orders.length, 0);
  assert.equal(manualNext.ledger.adjustments.length, 1);
  assert.equal(manualNext.ledger.adjustments[0].reasonCode, "manual_position_adjustment");
  const costBasis = reconcileLedgerPosition(manualNext.ledger, {
    nextPosition: { grams: 3, avgCostPerGram: 101 },
    asOf: "2026-08-14T02:06:00.000Z",
  });
  assert.equal(costBasis.ledger.adjustments[0].kind, "cost_basis");
  assert.equal(costBasis.ledger.adjustments[0].reasonCode, "position_cost_basis_changed");
});

test("confirmed sell loss feeds Beijing daily/weekly loss, drawdown, and consecutive losses", () => {
  const baseline = reconcileLedgerPosition(createSignalLedger(), {
    nextPosition: { grams: 10, avgCostPerGram: 100 },
    asOf: "2026-08-14T01:50:00.000Z",
  });
  const sellPlan = candidatePlan({
    action: "sell_stop",
    candidateAction: "sell_stop",
    grams: 10,
    suggestedOrder: {
      action: "sell_stop",
      instrument: "CMB",
      side: "sell",
      signalPrice: 90,
      cmbEstimatedPrice: 90,
      grams: 10,
      validUntil: "2026-08-14T03:00:00.000Z",
    },
  });
  const pending = recordLedgerDecision(baseline.ledger, {
    plan: sellPlan,
    config: normalizeConfig({ position: { grams: 10, avgCostPerGram: 100 } }),
    transition: { event: "record" },
    asOf: AS_OF,
  });
  const filled = reconcileLedgerPosition(pending.ledger, {
    previousPosition: { grams: 10, avgCostPerGram: 100 },
    nextPosition: { grams: 0, avgCostPerGram: 0 },
    pendingOrder: pending.plan.suggestedOrder,
    config: normalizeConfig({ fee: { buyPerGram: 0, sellPerGram: 0 }, strategy: { slippagePerGram: 0 } }),
    asOf: "2026-08-14T02:02:00.000Z",
  });
  const summary = summarizeSignalLedger(filled.ledger, { asOf: "2026-08-14T02:03:00.000Z" });
  assert.equal(summary.totalRealizedPnlCny, -100);
  assert.equal(summary.dailyLossCny, 100);
  assert.equal(summary.weeklyLossCny, 100);
  assert.equal(summary.drawdownCny, 100);
  assert.equal(summary.consecutiveLosses, 1);
});

test("daily and weekly loss budgets use gross losses rather than netting later wins", () => {
  const ledger = normalizeSignalLedger({
    ...createSignalLedger(),
    orders: [
      {
        orderId: "loss",
        action: "sell_stop",
        instrument: "CMB",
        side: "sell",
        status: "filled",
        grams: 10,
        filledGrams: 10,
        fillPrice: 90,
        filledAt: "2026-08-14T01:00:00.000Z",
        issuedAt: "2026-08-14T00:55:00.000Z",
        realizedPnlCny: -100,
      },
      {
        orderId: "win",
        action: "sell_take_profit",
        instrument: "CMB",
        side: "sell",
        status: "filled",
        grams: 10,
        filledGrams: 10,
        fillPrice: 120,
        filledAt: "2026-08-14T01:30:00.000Z",
        issuedAt: "2026-08-14T01:25:00.000Z",
        realizedPnlCny: 200,
      },
    ],
  });
  const summary = summarizeSignalLedger(ledger, { asOf: "2026-08-14T02:00:00.000Z" });
  assert.equal(summary.dailyRealizedPnlCny, 100);
  assert.equal(summary.dailyRealizedLossCny, 100);
  assert.equal(summary.weeklyRealizedLossCny, 100);
  assert.equal(summary.dailyLossCny, 100, "profit does not reopen a consumed loss budget");
});

test("unknown ledger versions preserve null facts and fail closed for new buys", () => {
  const ledger = normalizeSignalLedger({ version: "future-ledger", schemaVersion: 99, orders: [{ orderId: "x", status: "pending" }] });
  assert.equal(ledger.integrity, "unsupported_version");
  assert.equal(ledger.orders[0].signalPrice, null);
  assert.equal(ledger.orders[0].filledAt, null);
  const summary = summarizeSignalLedger(ledger, { asOf: AS_OF });
  const result = buyRisk(normalizeConfig({ limits: { maxGrams: 100 } }), {
    fixedGrams: 10,
    ledgerSummary: summary,
  });
  assert.equal(result.allowed, false);
  assert.ok(result.reasonCodes.includes("ledger_unavailable"));
});

test("state v2 migrates to v3 with a legacy pending order but no fake fills", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "goldboard-stage2-state-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const file = join(directory, "state.json");
  await writeFile(file, JSON.stringify({
    stateSchemaVersion: 2,
    dataSchemaVersion: "goldboard-market-data-v2",
    quotes: {},
    bars: {},
    lastSuggestedOrder: candidatePlan().suggestedOrder,
  }, null, 2), "utf8");

  const migrated = await loadStateWithMigration({ file, writeQueue: makeWriteQueue() });
  assert.equal(migrated.state.stateSchemaVersion, 3);
  assert.equal(migrated.state.signalLedger.version, SIGNAL_LEDGER_VERSION);
  assert.equal(migrated.state.signalLedger.orders.length, 1);
  assert.equal(migrated.state.signalLedger.orders[0].status, "pending");
  assert.equal(migrated.state.signalLedger.orders[0].provenance, "legacy_state_v2");
  assert.equal(migrated.state.signalLedger.orders[0].filledAt, null);
  assert.match(migrated.backupPath, /\.v2\.backup$/);
  assert.equal(existsSync(`${file}.migration-v3.json`), true);

  const second = await loadStateWithMigration({ file, writeQueue: makeWriteQueue() });
  assert.equal(second.migrated, false);
  const runtime = { signalLedger: createSignalLedger(), signalState: {}, lastSuggestedOrder: null };
  restoreRuntimeState(runtime, second.state);
  assert.equal(runtime.signalLedger.orders.length, 1);
  assert.equal(runtime.lastSuggestedOrder.orderId, runtime.signalLedger.orders[0].orderId);
});

test("ledger projection is bounded and exposes one consistent summary", () => {
  let ledger = createSignalLedger();
  for (let index = 0; index < 3; index += 1) {
    const result = record(ledger, candidatePlan({ signalBarT: Date.parse(AS_OF) + index * 300_000 }));
    ledger = result.ledger;
    ledger.activeSetupId = result.plan.setupId;
  }
  const defaultProjection = projectSignalLedger(ledger, { asOf: AS_OF });
  assert.equal(defaultProjection.decisions.length, 3, "missing limit uses the documented default instead of coercing null to one");
  const projected = projectSignalLedger(ledger, { asOf: AS_OF, limit: 2 });
  assert.equal(projected.ok, true);
  assert.equal(projected.version, SIGNAL_LEDGER_VERSION);
  assert.equal(projected.decisions.length, 2);
  assert.ok(projected.summary.counts.decisions >= 2);
  assert.equal(STATE_SCHEMA_VERSION, 3);
});
