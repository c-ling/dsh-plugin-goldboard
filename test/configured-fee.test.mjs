import assert from "node:assert/strict";
import test from "node:test";

import { resolveExecutionQuote, valuePosition } from "../lib/execution.js";
import { evaluateBuyRisk } from "../lib/risk.js";
import { computePlan } from "../lib/plan.js";
import { computeForwardOutcome } from "../lib/replay-stats.js";
import { normalizeConfig } from "../lib/config.js";
import { defaultSignalState } from "../lib/sizing.js";

const NOW = new Date("2026-08-14T02:00:00Z");

const BASE = {
  fee: { buyPerGram: 0, sellPerGram: 5 },
  cmb: { deriveSellFromFee: true },
  strategy: { slippagePerGram: 0.2, minProfitPerGram: 1, maxLossPerGram: 20, signalCooldownMinutes: 0 },
};

function liveQuote(sellPrice = 884.26) {
  return {
    customerBuy: 889.26,
    customerSell: sellPrice,
    source: "cmb",
    quality: "primary",
    synthetic: false,
    receivedAt: NOW.toISOString(),
  };
}

function configWith(extra = {}) {
  return normalizeConfig({
    ...BASE,
    ...extra,
    cmb: { ...BASE.cmb, ...(extra.cmb ?? {}) },
    fee: { ...BASE.fee, ...(extra.fee ?? {}) },
    strategy: { ...BASE.strategy, ...(extra.strategy ?? {}) },
  });
}

function oneMinBars(now, minutes = 60, price = 889.26) {
  const end = Math.floor(new Date(now).getTime() / 60_000) * 60_000;
  const out = [];
  for (let i = 0; i < minutes; i += 1) out.push({ t: end - i * 60_000, o: price, h: price, l: price, c: price });
  return out;
}

function cmbRuntime(now, sellPrice) {
  return {
    quotes: {
      AU9999: null,
      CMB: {
        price: (889.26 + sellPrice) / 2,
        buyPrice: 889.26,
        sellPrice,
        source: "cmb",
        updatedAt: now.getTime(),
      },
      XAU: null,
      USDCNY: null,
    },
    bars: {
      AU9999: { 1: [], 5: [], 60: [] },
      XAU: { 1: [], 5: [], 60: [] },
      CMB: { 1: oneMinBars(now), 5: [], 60: [] },
    },
    signalState: defaultSignalState(),
  };
}

test("configured fee derives the bid from the live ask and marks it a proxy", () => {
  const config = configWith();
  const quote = resolveExecutionQuote({ quote: liveQuote(), asOf: NOW.toISOString() }, config);
  assert.equal(quote.ask, 889.26);
  assert.equal(quote.bid, 884.26);
  assert.equal(quote.feeIncluded, true);
  assert.equal(quote.evidence, "proxy");
  assert.equal(quote.realBidAsk, false);
  assert.equal(quote.configuredSpreadDriftPerGram, 0);
  assert.equal(quote.components.pricing, "configured-sell-fee");
});

test("configured fee ignores the live sell price and reports the drift", () => {
  const config = configWith();
  const quote = resolveExecutionQuote({ quote: liveQuote(880), asOf: NOW.toISOString() }, config);
  assert.equal(quote.bid, 884.26);
  assert.equal(quote.configuredSpreadDriftPerGram, 4.26);
});

test("configured fee is charged exactly once in position valuation", () => {
  const config = configWith();
  const quote = resolveExecutionQuote({ quote: liveQuote(), asOf: NOW.toISOString() }, config);
  const valued = valuePosition({ grams: 10, avgCostPerGram: 889.26 }, quote, config);
  // ask + slip = 889.46 entry; derived bid − slip = 884.06 exit.
  assert.equal(valued.effectiveEntryPrice, 889.46);
  assert.equal(valued.effectiveExitPrice, 884.06);
  assert.equal(valued.effectivePnlPerGram, -5.4);
  assert.equal(valued.breakEvenBid, 889.66);
});

test("legacy mode still charges the explicit sell fee on top of the live bid", () => {
  const config = configWith({ cmb: { deriveSellFromFee: false } });
  const quote = resolveExecutionQuote({ quote: liveQuote(), asOf: NOW.toISOString() }, config);
  const valued = valuePosition({ grams: 10, avgCostPerGram: 889.26 }, quote, config);
  assert.equal(valued.effectiveExitPrice, 879.06);
  assert.equal(valued.effectivePnlPerGram, -10.4);
});

test("risk sizing counts the configured fee once", () => {
  const config = configWith({ risk: { maxRiskPerTradeCny: 500 } });
  const base = configWith({ risk: { maxRiskPerTradeCny: 500 }, cmb: { deriveSellFromFee: false } });
  const input = {
    action: "buy_setup",
    fixedGrams: 10,
    currentGrams: 0,
    executableAsk: 889.26,
    executableBid: 884.26,
    suggestedPrice: 889,
    atrPerGram: 0.7,
    ledgerSummary: {},
    asOf: NOW.getTime(),
  };
  const configured = evaluateBuyRisk(config, input);
  const legacy = evaluateBuyRisk(base, input);
  assert.equal(configured.riskPerGram, 10.4);
  assert.equal(legacy.riskPerGram, 15.4);
  assert.equal(configured.executionCostPerGram, 5.4);
  assert.equal(legacy.executionCostPerGram, 10.4);
});

test("plan target and breakeven use the derived sell price", () => {
  const config = configWith({ position: { grams: 10, avgCostPerGram: 889.26 }, limits: { maxGrams: 100 } });
  const plan = computePlan(cmbRuntime(NOW, 884.26), config, NOW);
  assert.equal(plan.action, "wait");
  assert.equal(plan.breakeven, 889.66);
  assert.equal(plan.targetPrice, 890.66);
  assert.equal(plan.position.cmbNow, 884.26);
});

test("plan surfaces configured-spread drift as a reason code", () => {
  const config = configWith({ position: { grams: 10, avgCostPerGram: 889.26 }, limits: { maxGrams: 100 } });
  const plan = computePlan(cmbRuntime(NOW, 880), config, NOW);
  assert.ok(plan.reasonCodes.includes("configured_spread_drift"));
  assert.equal(plan.position.cmbNow, 884.26);
});

test("replay forward-outcome cost model stops double counting", () => {
  const configured = computeForwardOutcome(
    { action: "buy_setup", executionPrice: 889.26 },
    [],
    configWith(),
    0,
  );
  const legacy = computeForwardOutcome(
    { action: "buy_setup", executionPrice: 889.26 },
    [],
    configWith({ cmb: { deriveSellFromFee: false } }),
    0,
  );
  assert.equal(configured.costPerGram, 0.4);
  assert.equal(configured.costBreakdown.sellFeePerGram, 0);
  assert.equal(legacy.costPerGram, 5.4);
  assert.equal(legacy.costBreakdown.sellFeePerGram, 5);
});

test("deriveSellFromFee defaults off and normalizes as a boolean", () => {
  assert.equal(normalizeConfig({}).cmb.deriveSellFromFee, false);
  assert.equal(normalizeConfig({ cmb: { deriveSellFromFee: true } }).cmb.deriveSellFromFee, true);
  assert.equal(normalizeConfig({ cmb: { deriveSellFromFee: "yes" } }).cmb.deriveSellFromFee, false);
});
