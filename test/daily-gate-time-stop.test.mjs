import assert from "node:assert/strict";
import test from "node:test";

import { confidenceSignals, computePlan } from "../lib/plan.js";
import { normalizeConfig } from "../lib/config.js";
import { defaultSignalState } from "../lib/sizing.js";

const NOW = new Date("2026-08-14T02:00:00Z");

function indicator(ema20, ema20Prev) {
  return {
    ema20, ema20Prev, rsi14: 45, sma20: 99.5, recentLow: 99.6,
    boll: { lower: 99 }, macd: { histogram: 1 }, atr14: 1,
  };
}

function series(daily) {
  return {
    ind5: indicator(100, 99),
    ind10: indicator(100, 99),
    ind30: indicator(100, 99),
    ind60: indicator(99, 98),
    technicalPrice: 100,
    daily,
  };
}

const STRATEGY = { nearSupportPct: 0.5, rsiOversold: 35, requireDailyUptrend: true };

test("daily gate blocks a buy when the completed daily bar is below a falling EMA20", () => {
  const result = confidenceSignals(series({ close: 98, ema20: 100, ema20Prev: 101, rising: false }), STRATEGY);
  assert.equal(result.dailyTrendUp, false);
  assert.equal(result.trendUp, false);
  assert.equal(result.buySetup, false);
});

test("daily gate passes when the completed daily bar is above a rising EMA20", () => {
  const result = confidenceSignals(series({ close: 102, ema20: 100, ema20Prev: 99, rising: true }), STRATEGY);
  assert.equal(result.dailyTrendUp, true);
  assert.equal(result.trendUp, true);
  assert.equal(result.buySetup, true);
});

test("daily gate fails closed when daily history is missing", () => {
  const result = confidenceSignals(series(null), STRATEGY);
  assert.equal(result.dailyTrendUp, false);
  assert.equal(result.buySetup, false);
  const off = confidenceSignals(series(null), { ...STRATEGY, requireDailyUptrend: false });
  assert.equal(off.trendUp, true);
});

function oneMinBars(now, minutes = 60, price = 889.13) {
  const end = Math.floor(new Date(now).getTime() / 60_000) * 60_000;
  const out = [];
  for (let i = 0; i < minutes; i += 1) out.push({ t: end - i * 60_000, o: price, h: price, l: price, c: price });
  return out;
}

function fiveMinBars(now, count = 100, price = 889.13) {
  const end = Math.floor(new Date(now).getTime() / (5 * 60_000)) * 5 * 60_000;
  const out = [];
  for (let i = 0; i < count; i += 1) out.push({ t: end - (i + 1) * 5 * 60_000, o: price, h: price, l: price, c: price });
  return out;
}

function sixtyMinBars(now, count = 80, price = 889.13) {
  const end = Math.floor(new Date(now).getTime() / (60 * 60_000)) * 60 * 60_000;
  const out = [];
  for (let i = 0; i < count; i += 1) out.push({ t: end - (i + 1) * 60 * 60_000, o: price, h: price, l: price, c: price });
  return out;
}

function runtimeWithLot(now, lotTime, bars5 = fiveMinBars(now, 400)) {
  return {
    quotes: {
      AU9999: null,
      CMB: { price: (889.13 + 884.13) / 2, buyPrice: 889.13, sellPrice: 884.13, source: "cmb", updatedAt: now.getTime() },
      XAU: null,
      USDCNY: null,
    },
    bars: {
      AU9999: { 1: [], 5: [], 60: [], 1440: [] },
      XAU: { 1: [], 5: [], 60: [], 1440: [] },
      CMB: { 1: oneMinBars(now), 5: bars5, 60: sixtyMinBars(now), 1440: [] },
    },
    signalState: defaultSignalState(),
  };
}

function positionConfig(extra = {}) {
  return normalizeConfig({
    position: {
      grams: 0,
      avgCostPerGram: 0,
      lots: [{ id: "lot-1", grams: 10, price: 880, time: new Date(NOW.getTime() - 50 * 5 * 60_000).toISOString(), status: "open" }],
    },
    limits: { maxGrams: 100 },
    fee: { buyPerGram: 0, sellPerGram: 0 },
    strategy: {
      minProfitPerGram: 10,
      maxLossPerGram: 12,
      slippagePerGram: 0.2,
      signalCooldownMinutes: 0,
      maxBarsBeforeTarget: 24,
      ...extra,
    },
  });
}

test("pre-arm time stop exits when the target was not reached in N closed 5m bars", () => {
  const plan = computePlan(runtimeWithLot(NOW, NOW.getTime() - 50 * 5 * 60_000), positionConfig(), NOW);
  assert.equal(plan.action, "sell_time_stop");
  assert.ok(plan.reasonCodes.includes("pre_target_timeout"));
  assert.equal(plan.suggestedOrder.side, "sell");
  assert.equal(plan.suggestedOrder.grams, 10);
  assert.ok(plan.heldBars >= 24);
});

test("pre-arm time stop is inert when disabled", () => {
  const plan = computePlan(
    runtimeWithLot(NOW, NOW.getTime() - 50 * 5 * 60_000),
    positionConfig({ maxBarsBeforeTarget: 0 }),
    NOW,
  );
  assert.notEqual(plan.action, "sell_time_stop");
});

test("pre-arm time stop does not fire before the bar budget is reached", () => {
  const plan = computePlan(
    runtimeWithLot(NOW, NOW.getTime() - 50 * 5 * 60_000),
    positionConfig({ maxBarsBeforeTarget: 80 }),
    NOW,
  );
  assert.notEqual(plan.action, "sell_time_stop");
});

test("daily-gate and time-stop config fields normalize and clamp", () => {
  const cfg = normalizeConfig({
    strategy: { requireDailyUptrend: "yes", maxBarsBeforeTarget: -5 },
  });
  assert.equal(cfg.strategy.requireDailyUptrend, false);
  assert.equal(cfg.strategy.maxBarsBeforeTarget, 0);
  const clamped = normalizeConfig({ strategy: { maxBarsBeforeTarget: 99999 } });
  assert.equal(clamped.strategy.maxBarsBeforeTarget, 10000);
});
