import assert from "node:assert/strict";
import test from "node:test";

import {
  CALCULATION_VERSION,
  DEFAULT_CONFIG,
  assessMarketQuality,
  buildSnapshot,
  closedBars,
  computeIndicatorSet,
  computePlan,
  normalizeConfig,
  normalizeQuoteRecord,
  replayMarketPlan,
} from "../lib/testing.js";

function bars(count, intervalMinutes, end, base = 100, metadata = {}) {
  const out = [];
  const endMs = new Date(end).getTime();
  for (let index = count - 1; index >= 0; index -= 1) {
    const t = endMs - index * intervalMinutes * 60_000;
    const o = base + (count - index - 1) * 0.2;
    const c = o + 0.15;
    out.push({ t, o, h: c + 0.1, l: o - 0.1, c, ...metadata });
  }
  return out;
}

function minuteBars(count, end, price = 950) {
  return bars(count, 1, end, price, { synthetic: true, instrument: "XAU/USD", market: "spot", currency: "USD", unit: "troy_ounce" });
}

test("quote normalization keeps spot XAU and Yahoo GC=F futures distinct", () => {
  const now = Date.parse("2026-08-14T02:00:00Z");
  const spot = normalizeQuoteRecord("XAU", { price: 4_375, source: "tencent" }, now);
  const futures = normalizeQuoteRecord("XAU", { price: 4_380, source: "yahoo" }, now);
  const cmb = normalizeQuoteRecord("CMB", { price: 951, buyPrice: 953, sellPrice: 948, source: "cmb" }, now);

  assert.equal(spot.instrument, "XAU/USD");
  assert.equal(spot.market, "spot");
  assert.equal(futures.instrument, "GC=F");
  assert.equal(futures.market, "futures");
  assert.equal(futures.quality, "fallback");
  assert.equal(cmb.customerBuy, 953);
  assert.equal(cmb.customerSell, 948);
  assert.equal(cmb.spread, 5);
});

test("quote timestamps normalize compact Beijing, epoch seconds/milliseconds and ISO inputs consistently", () => {
  const receivedAt = Date.parse("2026-08-28T12:03:00.000Z");
  const compact = normalizeQuoteRecord("USDCNY", {
    price: 6.8,
    source: "tencent",
    time: "20260828200250",
  }, receivedAt);
  assert.equal(compact.sourceTimestamp, "2026-08-28T12:02:50.000Z");

  const epoch = normalizeQuoteRecord("XAU", { price: 4_000, source: "test", sourceTimestamp: receivedAt }, receivedAt);
  assert.equal(epoch.sourceTimestamp, "2026-08-28T12:03:00.000Z");

  const iso = normalizeQuoteRecord("XAU", { price: 4_000, source: "test", sourceTimestamp: "2026-08-28T12:01:00.000Z" }, receivedAt);
  assert.equal(iso.sourceTimestamp, "2026-08-28T12:01:00.000Z");

  const epochSeconds = Math.floor(receivedAt / 1000);
  const secondsNumber = normalizeQuoteRecord("XAU", { price: 4_000, source: "test", sourceTimestamp: epochSeconds }, receivedAt);
  const secondsString = normalizeQuoteRecord("XAU", { price: 4_000, source: "test", sourceTimestamp: String(epochSeconds) }, receivedAt);
  assert.equal(secondsNumber.sourceTimestamp, "2026-08-28T12:03:00.000Z");
  assert.equal(secondsString.sourceTimestamp, "2026-08-28T12:03:00.000Z");

  const invalid = normalizeQuoteRecord("XAU", { price: 4_000, source: "test", sourceTimestamp: "not-a-date" }, receivedAt);
  assert.equal(invalid.sourceTimestamp, null);
});

test("quality blocks timestamps materially in the future", () => {
  const now = new Date("2026-08-28T12:03:00.000Z");
  const quality = assessMarketQuality({
    now,
    quote: normalizeQuoteRecord("XAU", {
      price: 4_000,
      source: "test",
      sourceTimestamp: "2026-08-28T12:10:00.000Z",
    }, now.getTime()),
    coverage: { 5: 1, 10: 1, 30: 1, 60: 1 },
    requiredCoverage: [],
    indicators: { ind5: { count: 20, warmupReady: true, planWarmupReady: true } },
    marketState: "open",
  });
  assert.equal(quality.ready, false);
  assert.ok(quality.reasonCodes.includes("timestamp_future"));
  assert.equal(quality.quote.futureSkewMs, 7 * 60_000);
});

test("closedBars excludes the active bucket and preserves synthetic metadata", () => {
  const now = new Date("2026-08-14T02:03:00Z");
  const series = [
    { t: Date.parse("2026-08-14T01:55:00Z"), o: 100, h: 102, l: 99, c: 101, synthetic: true },
    { t: Date.parse("2026-08-14T02:00:00Z"), o: 101, h: 103, l: 100, c: 102, synthetic: true },
  ];
  const result = closedBars(series, 5, now);
  assert.equal(result.length, 1);
  assert.equal(result[0].synthetic, true);
  assert.equal(result[0].t, series[0].t);
});

test("indicator set requires complete warm-up and reports calculation metadata", () => {
  const end = new Date("2026-08-14T02:00:00Z");
  const short = computeIndicatorSet(bars(20, 5, end));
  const ready = computeIndicatorSet(bars(61, 5, end, 100, { synthetic: true }));

  assert.equal(short.calculationVersion, CALCULATION_VERSION);
  assert.equal(short.warmupReady, false);
  assert.equal(short.planWarmupReady, false);
  assert.ok(Number.isNaN(short.sma60));
  assert.equal(ready.warmupReady, true);
  assert.equal(ready.planWarmupReady, true);
  assert.ok(Number.isFinite(ready.sma60));
  assert.ok(Number.isFinite(ready.rsi14));
  assert.ok(Number.isFinite(ready.atr14));
  assert.equal(ready.synthetic, true);
});

test("quality module blocks stale, invalid and under-warmed inputs", () => {
  const now = new Date("2026-08-14T02:00:00Z");
  const quality = assessMarketQuality({
    now,
    quote: { price: 950, updatedAt: now.getTime() - 20 * 60_000, staleAfterMs: 15 * 60_000, instrument: "XAU/USD", market: "spot" },
    bars: [{ t: now.getTime() - 10 * 60_000, o: 100, h: 99, l: 101, c: 100 }],
    coverage: { 5: 1, 10: 1, 30: 0.5, 60: 0.5 },
    requiredCoverage: [5, 10, 30, 60],
    indicators: { ind5: { count: 20, warmupReady: false, planWarmupReady: false } },
    marketState: "open",
    expectedMarket: "spot",
  });

  assert.equal(quality.ready, false);
  assert.ok(quality.reasonCodes.includes("data_stale"));
  assert.ok(quality.reasonCodes.includes("bars_invalid"));
  assert.ok(quality.reasonCodes.includes("data_incomplete_30m"));
  assert.ok(quality.reasonCodes.includes("indicator_warmup"));
});

test("quality blocks a compound XAU quote when its FX dependency is stale or future", () => {
  const now = new Date("2026-08-28T12:03:00.000Z");
  const quality = assessMarketQuality({
    now,
    quote: { price: 4_000, updatedAt: now.getTime(), staleAfterMs: 15 * 60_000, instrument: "XAU/USD", market: "spot" },
    dependencies: [
      { id: "XAU", quote: { price: 4_000, updatedAt: now.getTime(), sourceTimestamp: "2026-08-28T12:02:00.000Z" } },
      { id: "USDCNY", quote: { price: 6.8, updatedAt: now.getTime(), sourceTimestamp: "2026-08-28T11:40:00.000Z" } },
    ],
    coverage: { 5: 1, 10: 1, 30: 1, 60: 1 },
    requiredCoverage: [],
    indicators: { ind5: { count: 20, warmupReady: true, planWarmupReady: true } },
    marketState: "open",
    expectedMarket: "spot",
  });
  assert.equal(quality.ready, false);
  assert.ok(quality.reasonCodes.includes("dependency_stale"));
  assert.equal(quality.dependencies.find((entry) => entry.id === "USDCNY").stale, true);

  const future = assessMarketQuality({
    now,
    quote: { price: 4_000, updatedAt: now.getTime(), staleAfterMs: 15 * 60_000 },
    dependencies: [{ id: "USDCNY", quote: { price: 6.8, updatedAt: now.getTime(), sourceTimestamp: "2026-08-28T12:10:00.000Z" } }],
    coverage: {},
    requiredCoverage: [],
    indicators: { ind5: { count: 20, warmupReady: true, planWarmupReady: true } },
    marketState: "open",
  });
  assert.ok(future.reasonCodes.includes("dependency_future"));
});

test("quality applies the 60% coverage threshold to 30/60-minute windows", () => {
  const now = new Date("2026-08-14T02:00:00Z");
  const quality = assessMarketQuality({
    now,
    quote: { price: 950, updatedAt: now.getTime(), staleAfterMs: 15 * 60_000, instrument: "XAU/USD", market: "spot" },
    coverage: { 5: 1, 10: 1, 30: 0.7, 60: 0.7 },
    requiredCoverage: [5, 10, 30, 60],
    indicators: { ind5: { count: 20, warmupReady: true, planWarmupReady: true } },
    marketState: "open",
    expectedMarket: "spot",
  });

  assert.ok(!quality.reasonCodes.includes("data_incomplete_30m"));
  assert.ok(!quality.reasonCodes.includes("data_incomplete_60m"));
});

test("quality permits a ready plan while optional 60-bar indicators are warming", () => {
  const now = new Date("2026-08-14T02:00:00Z");
  const quality = assessMarketQuality({
    now,
    quote: { price: 950, updatedAt: now.getTime(), staleAfterMs: 15 * 60_000, instrument: "XAU/USD", market: "spot" },
    bars: bars(20, 5, now, 950),
    coverage: { 5: 1, 10: 1, 30: 1, 60: 1 },
    indicators: {
      ind5: { count: 40, warmupReady: false, planWarmupReady: true },
      ind10: { count: 21, warmupReady: false, planWarmupReady: true },
      ind30: { count: 21, warmupReady: false, planWarmupReady: true },
      ind60: { count: 21, warmupReady: false, planWarmupReady: true },
    },
    marketState: "open",
    expectedMarket: "spot",
  });

  assert.equal(quality.ready, true);
  assert.equal(quality.status, "degraded");
  assert.ok(!quality.reasonCodes.includes("indicator_warmup"));
  assert.ok(quality.warnings.includes("longest_indicator_warmup"));
});

test("plan withholds executable orders until every formal indicator is warm", () => {
  const now = new Date("2026-08-14T02:00:00Z");
  const runtime = {
    quotes: {
      AU9999: null,
      XAU: normalizeQuoteRecord("XAU", { price: 4_375, source: "tencent" }, now.getTime()),
      USDCNY: normalizeQuoteRecord("USDCNY", { price: 6.74, source: "tencent" }, now.getTime()),
      CMB: null,
    },
    bars: {
      AU9999: { 1: [], 5: [], 60: [] },
      XAU: {
        1: minuteBars(60, now, 4_375),
        5: bars(20, 5, now, 4_300, { instrument: "XAU/USD", market: "spot", currency: "USD", unit: "troy_ounce" }),
        60: bars(20, 60, now, 4_000, { instrument: "XAU/USD", market: "spot", currency: "USD", unit: "troy_ounce" }),
      },
      CMB: { 1: [], 5: [], 60: [] },
    },
  };
  const plan = computePlan(runtime, normalizeConfig({ limits: { maxGrams: 50 } }), now);
  assert.equal(plan.action, "data_incomplete");
  assert.ok(plan.reasonCodes.includes("indicator_warmup"));
  assert.equal(plan.suggestedOrder, null);
});

test("snapshot exposes percentage and ratio with unambiguous units", () => {
  const now = new Date("2026-08-14T02:00:00Z");
  const runtime = {
    quotes: {
      AU9999: normalizeQuoteRecord("AU9999", { price: 950, source: "sina" }, now.getTime()),
      XAU: normalizeQuoteRecord("XAU", { price: 4_375.8, source: "tencent" }, now.getTime()),
      USDCNY: normalizeQuoteRecord("USDCNY", { price: 6.7421, source: "tencent" }, now.getTime()),
      CMB: null,
    },
    bars: { AU9999: { 1: [] }, XAU: { 1: [] }, CMB: { 1: [] } },
    plan: { action: "data_incomplete", marketState: "open", instrument: "XAU", reasonCodes: ["indicator_warmup"], suggestedOrder: null },
  };
  const snapshot = buildSnapshot(runtime, DEFAULT_CONFIG, now);
  assert.equal(snapshot.derived.domesticPremiumPerGram, 1.49);
  assert.equal(snapshot.derived.domesticPremiumRatio, 0.001571);
  assert.equal(snapshot.derived.domesticPremiumPct, 0.16);
});

test("market replay is deterministic for one fixed fixture", () => {
  const asOf = "2026-08-14T02:00:00.000Z";
  const fixture = {
    asOf,
    quotes: {
      XAU: { price: 4_375, source: "tencent", updatedAt: Date.parse(asOf) },
      USDCNY: { price: 6.74, source: "tencent", updatedAt: Date.parse(asOf) },
    },
    bars: {
      XAU: {
        1: minuteBars(60, asOf, 4_375),
        5: bars(121, 5, asOf, 4_200),
        60: bars(121, 60, asOf, 3_900),
      },
    },
  };
  const first = replayMarketPlan(fixture, DEFAULT_CONFIG);
  const second = replayMarketPlan(fixture, DEFAULT_CONFIG);
  assert.deepEqual(first, second);
  assert.equal(first.replay.calculationVersion, CALCULATION_VERSION);
  assert.equal(first.replay.deterministic, true);
});
