import assert from "node:assert/strict";
import test from "node:test";

import { advanceTargetTrail, normalizeTargetTrail } from "../lib/target-trail.js";
import { computePlan, confidenceSignals } from "../lib/plan.js";
import { normalizeConfig } from "../lib/config.js";
import { defaultSignalState } from "../lib/sizing.js";

const NOW = new Date("2026-08-14T02:00:00Z");

function oneMinBars(now, minutes = 60, price = 970) {
  const end = Math.floor(new Date(now).getTime() / 60_000) * 60_000;
  const out = [];
  for (let i = 0; i < minutes; i += 1) out.push({ t: end - i * 60_000, o: price, h: price, l: price, c: price });
  return out;
}

function cmbRuntime(now, sellPrice, signalState = defaultSignalState()) {
  const buyPrice = sellPrice + 4;
  return {
    quotes: {
      AU9999: null,
      CMB: { price: (buyPrice + sellPrice) / 2, buyPrice, sellPrice, source: "cmb", updatedAt: now.getTime() },
      XAU: null,
      USDCNY: null,
    },
    bars: {
      AU9999: { 1: [], 5: [], 60: [] },
      XAU: { 1: [], 5: [], 60: [] },
      CMB: { 1: oneMinBars(now), 5: [], 60: [] },
    },
    signalState,
  };
}

const BASE_CONFIG = {
  position: { grams: 10, avgCostPerGram: 945 },
  limits: { maxGrams: 100 },
  fee: { buyPerGram: 0, sellPerGram: 0 },
  strategy: {
    minProfitPerGram: 1,
    maxLossPerGram: 20,
    slippagePerGram: 0.2,
    signalCooldownMinutes: 0,
    targetTrailPerGram: 4,
    targetTrailBars: 24,
  },
};

test("target trail normalizes persisted state and rejects malformed shapes", () => {
  assert.equal(normalizeTargetTrail(null), null);
  assert.equal(normalizeTargetTrail({ armed: true }), null);
  assert.equal(normalizeTargetTrail({ armed: true, signature: "CMB|945", targetBid: 0, peakBid: 970 }), null);
  const state = normalizeTargetTrail({
    armed: true,
    signature: "CMB|945",
    targetBid: 946.4,
    peakBid: 970.44,
    line: 966.44,
    barsSinceHigh: 3.7,
    partialSold: true,
  });
  assert.equal(state.armed, true);
  assert.equal(state.peakBid, 970.44);
  assert.equal(state.barsSinceHigh, 3);
  assert.equal(state.partialSold, true);
});

test("target trail is inert when disabled, flat, or below target", () => {
  const base = { enabled: true, bid: 947, targetBid: 946.4, trailPerGram: 4, signature: "CMB|945", positionGrams: 10 };
  assert.equal(advanceTargetTrail(null, { ...base, enabled: false }).event, "idle");
  assert.equal(advanceTargetTrail(null, { ...base, positionGrams: 0 }).event, "idle");
  assert.equal(advanceTargetTrail(null, { ...base, bid: 946 }).event, "idle");
  assert.equal(advanceTargetTrail(null, { ...base, trailPerGram: 0 }).event, "idle");
});

test("target trail arms at target, follows the peak, and exits on retrace", () => {
  const input = { enabled: true, targetBid: 946.4, trailPerGram: 4, signature: "CMB|945", positionGrams: 10 };
  const armed = advanceTargetTrail(null, { ...input, bid: 947, signalBarT: 1000, now: "2026-08-14T02:00:00.000Z" });
  assert.equal(armed.event, "armed");
  assert.equal(armed.state.armed, true);
  assert.equal(armed.state.peakBid, 947);
  assert.equal(armed.line, 943);
  assert.equal(armed.state.armedAt, "2026-08-14T02:00:00.000Z");

  const higher = advanceTargetTrail(armed.state, { ...input, bid: 955, signalBarT: 2000 });
  assert.equal(higher.event, "hold");
  assert.equal(higher.state.peakBid, 955);
  assert.equal(higher.line, 951);
  assert.equal(higher.state.barsSinceHigh, 0);

  const held = advanceTargetTrail(higher.state, { ...input, bid: 950.9, signalBarT: 2500 });
  assert.equal(held.event, "exit_retrace");
  assert.equal(held.state.barsSinceHigh, 1);
});

test("target trail times out after N closed bars without a new high", () => {
  const input = {
    enabled: true, targetBid: 946.4, trailPerGram: 4, signature: "CMB|945",
    positionGrams: 10, timeoutBars: 2,
  };
  const armed = advanceTargetTrail(null, { ...input, bid: 947, signalBarT: 1000 });
  const first = advanceTargetTrail(armed.state, { ...input, bid: 946.5, signalBarT: 2000 });
  assert.equal(first.event, "hold");
  assert.equal(first.state.barsSinceHigh, 1);
  // Same closed bar again must not count twice.
  const repeat = advanceTargetTrail(first.state, { ...input, bid: 946.5, signalBarT: 2000 });
  assert.equal(repeat.state.barsSinceHigh, 1);
  const timeout = advanceTargetTrail(repeat.state, { ...input, bid: 946.5, signalBarT: 3000 });
  assert.equal(timeout.event, "exit_timeout");
});

test("target trail resets when the entry cost signature changes", () => {
  const input = { enabled: true, targetBid: 946.4, trailPerGram: 4, positionGrams: 10 };
  const armed = advanceTargetTrail(null, { ...input, bid: 950, signature: "CMB|945", signalBarT: 1000 });
  const reset = advanceTargetTrail(armed.state, { ...input, bid: 946.2, signature: "CMB|960", signalBarT: 2000 });
  assert.equal(reset.event, "idle");
  assert.equal(reset.state, null);
  const rearmed = advanceTargetTrail(armed.state, { ...input, bid: 961, signature: "CMB|960", signalBarT: 2000 });
  assert.equal(rearmed.event, "armed");
  assert.equal(rearmed.state.signature, "CMB|960");
});

test("target trail partial sale fires once at arming", () => {
  const input = { enabled: true, targetBid: 946.4, trailPerGram: 4, signature: "CMB|945", positionGrams: 10, partialRatio: 0.5 };
  const partial = advanceTargetTrail(null, { ...input, bid: 947, signalBarT: 1000 });
  assert.equal(partial.event, "partial");
  assert.equal(partial.state.partialSold, true);
  const next = advanceTargetTrail(partial.state, { ...input, bid: 947, signalBarT: 2000 });
  assert.equal(next.event, "hold");
});

test("plan keeps the legacy immediate take-profit when target trail is disabled", () => {
  const config = normalizeConfig({ ...BASE_CONFIG, strategy: { ...BASE_CONFIG.strategy, targetTrailPerGram: 0 } });
  const plan = computePlan(cmbRuntime(NOW, 970.43), config, NOW);
  assert.equal(plan.action, "sell_take_profit");
  assert.equal(plan.suggestedOrder.grams, 10);
  assert.equal(plan.targetTrail, null);
});

test("plan arms the target trail instead of selling, then exits on retrace", () => {
  const config = normalizeConfig(BASE_CONFIG);
  const runtime = cmbRuntime(NOW, 970.43);
  const armed = computePlan(runtime, config, NOW);
  assert.equal(armed.action, "wait");
  assert.ok(armed.reasonCodes.includes("target_armed_watching"));
  assert.ok(armed.reasonCodes.includes("target_reached"));
  assert.equal(armed.suggestedOrder, null);
  assert.equal(armed.targetTrail.armed, true);
  assert.equal(armed.targetTrail.peakBid, 970.43);
  assert.equal(armed.targetTrailLine, 966.43);

  // Carry the persisted state into the next poll, then give back more than the trail.
  const later = computePlan(
    cmbRuntime(new Date(NOW.getTime() + 30_000), 966, armed.signalState),
    config,
    new Date(NOW.getTime() + 30_000),
  );
  assert.equal(later.action, "sell_target_trail");
  assert.ok(later.reasonCodes.includes("target_trail_hit"));
  assert.equal(later.suggestedOrder.side, "sell");
  assert.equal(later.suggestedOrder.grams, 10);
  assert.equal(later.targetTrail.armed, true);
});

test("plan supports an optional partial sale when the target arms", () => {
  const config = normalizeConfig({ ...BASE_CONFIG, strategy: { ...BASE_CONFIG.strategy, targetPartialRatio: 0.5 } });
  const plan = computePlan(cmbRuntime(NOW, 970.43), config, NOW);
  assert.equal(plan.action, "sell_target_trail");
  assert.ok(plan.reasonCodes.includes("target_partial_sell"));
  assert.equal(plan.suggestedOrder.grams, 5);
  assert.equal(plan.targetTrail.partialSold, true);
});

test("config normalization clamps the new target-trail and regime fields", () => {
  const cfg = normalizeConfig({
    strategy: {
      targetTrailPerGram: -3,
      targetPartialRatio: 1.5,
      targetTrailBars: 999,
      requirePriceAboveEma60: "yes",
    },
  });
  assert.equal(cfg.strategy.targetTrailPerGram, 0);
  assert.equal(cfg.strategy.targetPartialRatio, 0.9);
  assert.equal(cfg.strategy.targetTrailBars, 288);
  assert.equal(cfg.strategy.requirePriceAboveEma60, false);
  const enabled = normalizeConfig({ strategy: { requirePriceAboveEma60: true, targetTrailPerGram: 2.5 } });
  assert.equal(enabled.strategy.requirePriceAboveEma60, true);
  assert.equal(enabled.strategy.targetTrailPerGram, 2.5);
});

test("requirePriceAboveEma60 blocks a dip entry when price is below the 60m EMA20", () => {
  const ind = (ema20, ema20Prev) => ({
    ema20, ema20Prev, rsi14: 45, sma20: 99.5, recentLow: 99.6,
    boll: { lower: 99 }, macd: { histogram: 1 }, atr14: 1,
  });
  const series = {
    ind5: ind(100, 99),
    ind10: ind(100, 99),
    ind30: ind(100, 99),
    ind60: ind(101, 100),
    technicalPrice: 100,
  };
  const strategy = { nearSupportPct: 0.5, rsiOversold: 35, requirePriceAboveEma60: false };
  const off = confidenceSignals(series, strategy);
  assert.equal(off.trendUp, true);
  assert.equal(off.buySetup, true);

  const gated = confidenceSignals(series, { ...strategy, requirePriceAboveEma60: true });
  assert.equal(gated.trendUp, false);
  assert.equal(gated.buySetup, false);

  const above = confidenceSignals({ ...series, ind60: ind(99, 98) }, { ...strategy, requirePriceAboveEma60: true });
  assert.equal(above.trendUp, true);
  assert.equal(above.buySetup, true);
});
