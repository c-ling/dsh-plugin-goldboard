import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  BARS_SEED_VERSION,
  DEFAULT_CONFIG,
  CONFIDENCE_MAX,
  __setFetchImpl,
  __setQuoteChainTiming,
  aggregateSubBars,
  apply,
  applyManualCmbMinuteBars,
  applySignalPolicy,
  atr,
  bollinger,
  buildSessionCalendar,
  listMissingCmbMinuteSlots,
  buildAlertMessage,
    buildOrderChangeMessage,
    sameSuggestedOrder,
  buildOrderDriftNote,
  classifyOrderTransition,
  ORDER_UPDATE_MIN_DELTA_PER_GRAM,
  runAlertEvaluation,
  buildSnapshot,
  computeMarketState,
  computeNextMarketOpen,
  computePlan,
  coverageGate,
  defaultSignalState,
  fetchDomesticQuote,
  isOpenMinute,
  markSourceSuccess,
  mergeSecrets,
  mergeKlines,
  migrateBarsSeedVersion,
  normalizeConfig,
  parseCmbMarketCenterQuote,
  parseManualCmbMinuteEntries,
  parseEastmoneyKlines,
  parseGoldApiQuote,
  parseGoldPriceTodayQuote,
  parseJdGoldQuote,
  parseJijinhaoQuote,
  parseSgeDailyBars,
  parseSgeQuote,
  parseSinaDomesticQuote,
  parseSixtySecondsGoldPrice,
  parseTencentForexQuote,
  parseTencentXauQuote,
  parseYahooFinanceKlines,
  parseYahooFinanceQuote,
  readApiLogsFromFile,
  recordTick,
  redactConfig,
  resampleBars,
  restoreRuntimeState,
  rotateApiLogIfNeeded,
  rsi,
  seedBars,
  sma,
  snapshotCacheStale,
  windowCoverage,
} from "../lib/index.js";
import { sendGeneric, validateGenericWebhookConfig } from "../lib/alerts.js";

/** Build `minutes` minute-aligned 1m bars ending at `now` (a Date or ms). */
test("analysis model timeout defaults to 60 seconds", () => {
  assert.equal(DEFAULT_CONFIG.analysis.timeoutMs, 60_000);
  assert.equal(normalizeConfig({}).analysis.timeoutMs, 60_000);
});

function oneMinBars(now, minutes = 60, price = 950) {
  const end = Math.floor(new Date(now).getTime() / 60_000) * 60_000;
  const out = [];
  for (let i = 0; i < minutes; i += 1) {
    out.push({ t: end - i * 60_000, o: price, h: price, l: price, c: price });
  }
  return out;
}

/**
 * Full coverage for the freshest `freshMinutes`, then every third minute.
 * Gaps stay ≤2 consecutive minutes so coverage-seam anchoring never fires and
 * the ratios reflect plain rolling windows (used by tests that need a
 * sub-threshold long window without simulating an outage).
 */
function thinnedOneMinBars(now, total, freshMinutes, price = 950) {
  const end = Math.floor(new Date(now).getTime() / 60_000) * 60_000;
  const out = [];
  for (let i = 0; i < total; i += 1) {
    if (i < freshMinutes || (i - freshMinutes) % 3 === 0) {
      out.push({ t: end - i * 60_000, o: price, h: price, l: price, c: price });
    }
  }
  return out;
}

test("normalizeConfig applies defaults and sanitizes input", () => {
  const config = normalizeConfig({
    fee: { buyPerGram: "bad", sellPerGram: 99 },
    cmb: { buySpreadPerGram: -3, sellSpreadPerGram: 2 },
    position: { grams: -5, avgCostPerGram: 940 },
    limits: { maxGrams: 20, maxAmount: 999999999 },
    strategy: { minProfitPerGram: 1 },
    tradingHours: { open: "09:00", close: "26:00", holidays: ["2026-10-01", "bad", "2026-10-01"] },
    webhooks: { generic: [{ name: "n", url: "u" }] },
  });

  assert.equal(config.fee.buyPerGram, 0);
  assert.equal(config.fee.sellPerGram, 99);
  assert.equal(config.cmb.buySpreadPerGram, -3);
  assert.equal(config.position.grams, 0);
  assert.equal(config.position.avgCostPerGram, 940);
  assert.deepEqual(config.position.lots, []);
  assert.equal(config.limits.maxGrams, 20);
  assert.equal("maxAmount" in config.limits, false);
  assert.equal(config.strategy.minProfitPerGram, 1);
  assert.deepEqual(config.tradingHours.holidays, ["2026-10-01"]);
  assert.equal(config.webhooks.generic[0].id, "wh-1");
  assert.equal(config.webhooks.generic[0].name, "n");
  assert.equal(normalizeConfig({ strategy: { scoreThreshold: 10 } }).strategy.scoreThreshold, CONFIDENCE_MAX);
});

test("manual prev close overrides are normalized and applied to snapshots", () => {
  const config = normalizeConfig({ manualPrevClose: { AU9999: "bad", XAU: 123.456, CMB: "" } });
  assert.equal(config.manualPrevClose.AU9999, null);
  assert.equal(config.manualPrevClose.XAU, 123.46);
  assert.equal(config.manualPrevClose.CMB, null);

  const now = new Date("2026-08-15T03:00:00Z");
  const snap = buildSnapshot({
    quotes: {
      AU9999: { price: 950, prevClose: 940.72, source: "test", updatedAt: now.getTime() },
      XAU: { price: 4375.8, prevClose: 4350.88, source: "test", updatedAt: now.getTime() },
      USDCNY: { price: 6.7421, source: "test", updatedAt: now.getTime() },
      CMB: null,
    },
    bars: { AU9999: { 1: [] }, XAU: { 1: [] }, CMB: { 1: [] } },
    plan: null,
  }, { ...config, manualPrevClose: { AU9999: 123.45, XAU: 4567.89, CMB: 888.88 } }, now);
  assert.equal(snap.quotes.AU9999.prevClose, 123.45);
  assert.equal(snap.quotes.XAU.prevClose, 4567.89);
  assert.equal(snap.manualPrevClose.CMB, 888.88);
});

test("recordTick persists real CMB ask/bid OHLC alongside the legacy price bar", () => {
  const bars = { 1: [], 5: [], 15: [], 60: [], 1440: [] };
  const first = Date.parse("2026-08-14T02:00:10.000Z");
  recordTick(bars, {
    price: 105,
    buyPrice: 105,
    sellPrice: 100,
    source: "cmb",
    instrument: "CMB_ACCUMULATED_GOLD",
  }, first);
  recordTick(bars, {
    price: 106,
    buyPrice: 106,
    sellPrice: 99,
    source: "cmb",
    instrument: "CMB_ACCUMULATED_GOLD",
  }, first + 20_000);
  const bar = bars[1][0];
  assert.equal(bar.askO, 105);
  assert.equal(bar.askH, 106);
  assert.equal(bar.askL, 105);
  assert.equal(bar.askC, 106);
  assert.equal(bar.bidO, 100);
  assert.equal(bar.bidH, 100);
  assert.equal(bar.bidL, 99);
  assert.equal(bar.bidC, 99);
  assert.equal(bar.executionSideComplete, true);

  recordTick(bars, { price: 104, source: "xau-fx-derived" }, first + 30_000);
  assert.equal(bar.executionSideComplete, false, "a later one-sided tick invalidates real side completeness");
  assert.equal(bar.askO, undefined);
  assert.equal(bar.bidO, undefined);

  const nextMinute = first + 60_000;
  recordTick(bars, { price: 104, source: "xau-fx-derived" }, nextMinute);
  recordTick(bars, { price: 105, buyPrice: 105, sellPrice: 100, source: "cmb" }, nextMinute + 20_000);
  const reverseMixed = bars[1][1];
  assert.equal(reverseMixed.executionSideComplete, false, "a late live tick cannot certify an earlier one-sided path");
  assert.equal(reverseMixed.askO, undefined);
});

test("manual CMB minute entries are parsed and applied without overwriting existing bars", () => {
  const now = new Date("2026-08-14T01:05:00Z"); // Beijing 09:05 Friday
  const parsed = parseManualCmbMinuteEntries("09:00 950.00\n09:01 950.10\nbad line", now);
  assert.equal(parsed.entries.length, 2);
  assert.equal(parsed.errors.length, 1);

  const existingT = Date.parse("2026-08-14T01:00:00Z");
  const runtime = {
    bars: {
      CMB: {
        1: [{ t: existingT, o: 949, h: 949.5, l: 948.8, c: 949.2, synthetic: true, source: "cmb", instrument: "CMB_ACCUMULATED_GOLD", market: "bank", currency: "CNY", unit: "gram" }],
        5: [],
        15: [],
        60: [],
        1440: [],
      },
    },
  };
  const result = applyManualCmbMinuteBars(runtime, parsed.entries, {}, now);
  assert.equal(result.added, 1);
  assert.equal(result.skipped, 1);
  assert.equal(runtime.bars.CMB[1].length, 2);
  assert.equal(runtime.bars.CMB[1][0].c, 949.2);
  assert.equal(runtime.bars.CMB[1][1].source, "manual");
  assert.equal(runtime.bars.CMB[1][1].synthetic, true);
  assert.equal(runtime.bars.CMB[5].length, 1);
  assert.equal(runtime.bars.CMB[5][0].c, 950.1);
});

test("listMissingCmbMinuteSlots returns today's open minutes without a CMB 1m bar", () => {
  const now = new Date("2026-08-14T01:05:00Z"); // Beijing 09:05 Friday
  const runtime = {
    bars: {
      CMB: {
        1: [{ t: Date.parse("2026-08-14T01:00:00Z"), o: 949, h: 949.5, l: 948.8, c: 949.2 }],
      },
    },
  };
  const result = listMissingCmbMinuteSlots(runtime, normalizeConfig({ tradingHours: { open: "09:00", close: "18:00", weekdaysOnly: false } }), now);
  assert.equal(result.date, "2026-08-14");
  assert.deepEqual(result.slots, ["09:01", "09:02", "09:03", "09:04", "09:05"]);
});



test("normalizeConfig derives total grams and average cost from lots", () => {
  const config = normalizeConfig({
    position: {
      lots: [
        { id: "a", grams: 10, price: 945 },
        { id: "b", grams: 20, price: 950 },
      ],
    },
  });
  assert.equal(config.position.grams, 30);
  assert.equal(config.position.avgCostPerGram, 948.3333333333334);
  assert.equal(config.position.lots.length, 2);
});

test("normalizeConfig preserves an explicitly cleared position", () => {
  const config = normalizeConfig({
    position: {
      grams: 30,
      avgCostPerGram: 948.33,
      lots: [],
    },
    limits: { maxGrams: 0 },
  });
  assert.equal(config.position.grams, 0);
  assert.equal(config.position.avgCostPerGram, 0);
  assert.deepEqual(config.position.lots, []);
  assert.equal(config.limits.maxGrams, 0);
});

test("redactConfig blanks secrets and mergeSecrets keeps empty values", () => {
  const stored = normalizeConfig({ webhooks: { feishu: { secret: "s3" } } });
  const redacted = redactConfig(stored);
  assert.equal(redacted.config.webhooks.feishu.secret, "");
  assert.equal(redacted.secretSet["webhooks.feishu.secret"], true);

  const merged = mergeSecrets(stored, { webhooks: { feishu: { secret: "" } } }, []);
  assert.equal(merged.webhooks.feishu.secret, "s3");
  const cleared = mergeSecrets(stored, { webhooks: { feishu: { secret: "new" } } }, ["webhooks.feishu.secret"]);
  assert.equal(cleared.webhooks.feishu.secret, "");
});

test("parses free quote fixtures", () => {
  const domestic = parseSinaDomesticQuote(
    'var hq_str_gds_AU9999="950.00,0,940.10,951.99,954.50,946.00,02:30:00,940.72,946.00,2282,301.00,1.00,2026-08-15,沪金99";',
  );
  assert.equal(domestic.price, 950);
  assert.equal(domestic.ask, 951.99);
  assert.equal(domestic.prevClose, 940.72);

  const xau = parseTencentXauQuote(
    'v_hf_XAU="4375.80,0.57,4375.80,4376.41,4396.82,4311.03,04:54:00,4350.88,4353.38,0,0,0,2026-08-15,伦敦金（现货黄金）";',
  );
  assert.equal(xau.price, 4375.8);
  assert.equal(xau.high, 4396.82);
  assert.equal(xau.low, 4311.03);

  const usdcny = parseTencentForexQuote(
    'v_whUSDCNY="310~美元人民币~USDCNY~6.7421~0~20260815025956~6.7433~6.7460~6.7460~6.7410~6.7421~6.7429~-0.0012~-0.02~-0.05~-0.15~-0.49~-0.79~-3.50~7.1893~6.7410~2026-08-14";',
  );
  assert.equal(usdcny.price, 6.7421);

  const cmb = parseCmbMarketCenterQuote({
    data: {
      zBuyPrc: "960.43",
      zSelPrc: "955.43",
    },
  });
  assert.equal(cmb.buyPrice, 960.43);
  assert.equal(cmb.sellPrice, 955.43);
  assert.equal(cmb.price, 960.43);
  assert.equal(cmb.average, 957.93);


  const bars = parseEastmoneyKlines({
    data: {
      klines: [
        "2026-08-11,940.00,946.70,965.00,938.00,481298,4592537344.00,2.86",
        "2026-08-12,952.50,955.75,958.00,950.00,326510,3115872032.00,0.85",
        "2026-08-14 23:00,950.00,948.81,953.89,948.81,214,2033109.00,0.53",
      ],
    },
  });
  assert.equal(bars.length, 3);
  assert.equal(bars[0].o, 940);
  assert.equal(bars[0].c, 946.7);
  assert.equal(bars[0].h, 965);
  assert.equal(bars[0].l, 938);
  assert.ok(bars[2].t > bars[1].t);
});

test("parses newly added free gold source fixtures", () => {
  const sge = parseSgeQuote({
    times: "2026-08-18 15:30:00",
    data: [["Au99.99", "950.00", "946.00", "954.50", "946.00", "940.72"]],
  });
  assert.equal(sge.price, 950);
  assert.equal(sge.high, 954.5);
  assert.equal(sge.time, "2026-08-18 15:30:00");

  const sgeDaily = parseSgeDailyBars({
    time: [
      ["2026-08-17", "945.00", "950.00", "943.00", "952.00"],
      ["2026-08-18", "950.00", "955.00", "948.00", "956.00"],
    ],
  });
  assert.equal(sgeDaily.length, 2);
  assert.equal(sgeDaily[0].o, 945);
  assert.equal(sgeDaily[0].c, 950);
  assert.equal(sgeDaily[0].l, 943);
  assert.equal(sgeDaily[0].h, 952);

  const sixty = parseSixtySecondsGoldPrice({
    metals: { "黄金_9999": "950.00", "伦敦金": "4375.80" },
    updated_at: "2026-08-18T12:00:00Z",
  });
  assert.equal(sixty.domestic.price, 950);
  assert.equal(sixty.xau.price, 4375.8);

  const goldApi = parseGoldApiQuote({
    price: 4427.3,
    symbol: "XAU",
    currency: "USD",
    updatedAt: "2026-08-17T16:38:33Z",
  });
  assert.equal(goldApi.price, 4427.3);

  const gpt = parseGoldPriceTodayQuote({ data: { XAU: { USD: { price: 4427.3 } } } });
  assert.equal(gpt.price, 4427.3);

  const yahoo = parseYahooFinanceQuote({
    chart: { result: [{ meta: { regularMarketPrice: 4427.3, chartPreviousClose: 4400 } }] },
  });
  assert.equal(yahoo.price, 4427.3);
  assert.equal(yahoo.prevClose, 4400);

  const yahooKlines = parseYahooFinanceKlines({
    chart: {
      result: [{
        timestamp: [1755388800, 1755475200],
        indicators: { quote: [{ open: [4400, 4420], high: [4430, 4435], low: [4390, 4410], close: [4427.3, 4432.5] }] },
      }],
    },
  });
  assert.equal(yahooKlines.length, 2);
  assert.equal(yahooKlines[0].o, 4400);
  assert.equal(yahooKlines[0].c, 4427.3);
  assert.equal(yahooKlines[1].h, 4435);

  const jijin = parseJijinhaoQuote('var quote_json = {"data":[{"code":"JO_42660","name":"周大福","q63":"960.00"}]};');
  assert.equal(jijin.price, 960);
  assert.equal(jijin.name, "周大福");

  const jd = parseJdGoldQuote({ resultData: { datas: { price: "958.00", productName: "积存金" } } });
  assert.equal(jd.price, 958);
  assert.equal(jd.name, "积存金");
});

test("market state follows CMB weekdays 09:00-26:00 calendar", () => {
  const config = normalizeConfig({ tradingHours: { open: "09:00", close: "26:00", weekdaysOnly: true } });
  // Friday 10:00 Beijing = Friday 02:00 UTC.
  assert.equal(computeMarketState(config, new Date("2026-08-14T02:00:00Z")).state, "open");
  // Saturday 01:00 Beijing = Friday 17:00 UTC, still the Friday session.
  const fridayLate = computeMarketState(config, new Date("2026-08-14T17:00:00Z"));
  assert.equal(fridayLate.state, "open");
  assert.equal(fridayLate.msToClose, 60 * 60_000);
  // Saturday 11:00 Beijing is closed.
  assert.equal(computeMarketState(config, new Date("2026-08-15T03:00:00Z")).state, "closed");
  // Monday 08:59 Beijing is closed.
  assert.equal(computeMarketState(config, new Date("2026-08-17T00:59:00Z")).state, "closed");
  // Monday 09:00 Beijing is open.
  assert.equal(computeMarketState(config, new Date("2026-08-17T01:00:00Z")).state, "open");

  const holiday = normalizeConfig({ tradingHours: { open: "09:00", close: "26:00", weekdaysOnly: true, holidays: ["2026-08-14"] } });
  assert.equal(computeMarketState(holiday, new Date("2026-08-14T02:00:00Z")).state, "closed");
});

test("next market open skips weekends and holidays", () => {
  const config = normalizeConfig({ tradingHours: { open: "09:00", close: "26:00", weekdaysOnly: true, holidays: ["2026-08-17"] } });
  // Saturday 11:00 Beijing -> Monday is a holiday, so Tuesday 09:00 Beijing.
  assert.equal(computeNextMarketOpen(config, new Date("2026-08-15T03:00:00Z")), "2026-08-18T01:00:00.000Z");
  // Friday after close -> Monday 09:00 Beijing.
  assert.equal(computeNextMarketOpen(normalizeConfig({}), new Date("2026-08-14T10:00:00Z")), "2026-08-17T01:00:00.000Z");
});

test("snapshot exposes CMB live price when available and falls back to spread estimate", () => {
  const now = new Date("2026-08-15T03:00:00Z");
  const fallbackSnapshot = buildSnapshot({
    quotes: {
      AU9999: { price: 950, prevClose: 940.72, source: "test", updatedAt: now.getTime() },
      XAU: { price: 4375.8, prevClose: 4350.88, source: "test", updatedAt: now.getTime() },
      USDCNY: { price: 6.7421, source: "test", updatedAt: now.getTime() },
    },
    bars: { AU9999: { 5: [] }, XAU: { 5: [] }, CMB: { 5: [] } },
    plan: null,
  }, DEFAULT_CONFIG, now);
  assert.equal(fallbackSnapshot.derived.cmb.buyPrice, 950.23);
  assert.equal(fallbackSnapshot.derived.cmb.sellPrice, 950.03);
  assert.equal(fallbackSnapshot.derived.cmb.sellPriceAfterFee, 944.83);
  assert.equal(fallbackSnapshot.derived.cmb.costComponents.explicitFeePerGram, 5);
  assert.equal(fallbackSnapshot.derived.cmb.costComponents.slippagePerGram, 0.2);
  assert.equal(fallbackSnapshot.derived.cmb.live, false);
  assert.equal(fallbackSnapshot.derived.cmb.sourceNote, "cmb-synthetic-bid-ask");
  assert.equal(fallbackSnapshot.market.state, "closed");
  assert.equal(fallbackSnapshot.market.nextOpen, "2026-08-17T01:00:00.000Z");

  const liveSnapshot = buildSnapshot({
    quotes: {
      AU9999: { price: 950, prevClose: 940.72, source: "test", updatedAt: now.getTime() },
      CMB: { price: 960.43, buyPrice: 960.43, sellPrice: 955.43, source: "cmb", updatedAt: now.getTime() },
      XAU: null,
      USDCNY: null,
    },
    bars: { AU9999: { 1: [] }, XAU: { 1: [] }, CMB: { 1: [] } },
    plan: null,
  }, DEFAULT_CONFIG, now);
  assert.equal(liveSnapshot.derived.cmb.buyPrice, 960.43);
  assert.equal(liveSnapshot.derived.cmb.sellPrice, 955.43);
  assert.equal(liveSnapshot.derived.cmb.sellPriceAfterFee, 950.23);
  assert.equal(liveSnapshot.derived.cmb.average, 957.93);
  assert.equal(liveSnapshot.derived.cmb.live, true);
  assert.equal(liveSnapshot.derived.cmb.sourceNote, "cmb-live-bid-ask");
  assert.equal(liveSnapshot.quotes.CMB.price, 960.43);
  assert.equal(liveSnapshot.quotes.CMB.average, 957.93);
  assert.equal(liveSnapshot.trend.CMB_1m.length, 0);
});

test("plan engine uses international-converted fallback when CMB and Au99.99 are missing", () => {
  const now = new Date("2026-08-14T02:00:00Z");
  const runtime = {
    quotes: {
      AU9999: null,
      XAU: { price: 4375.8, source: "test", updatedAt: now.getTime() },
      USDCNY: { price: 6.7421, source: "test", updatedAt: now.getTime() },
    },
    bars: { AU9999: { 1: [], 5: [], 60: [] }, XAU: { 1: oneMinBars(now, 60), 5: [], 60: [] }, CMB: { 1: [], 5: [], 60: [] } },
  };
  const plan = computePlan(runtime, DEFAULT_CONFIG, now);
  assert.equal(plan.marketState, "open");
  assert.equal(plan.action, "wait");
  assert.equal(plan.instrument, "XAU");
  assert.equal(plan.signalPrice, 948.51);
  assert.equal(plan.cmbEstimatedPrice, 950.03);
});

test("indicator helpers produce expected values", () => {
  const values = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10];
  assert.equal(sma(values, 3), 9);
  assert.equal(sma(values, 3, 3), 3);
  assert.ok(rsi(values, 14).toString(), "rsi is a number");
  const boll = bollinger(values, 5, 2);
  assert.equal(boll.mid, 8);
  assert.ok(boll.upper > boll.mid);
  assert.ok(boll.lower < boll.mid);

  const bars = [];
  for (let index = 0; index < 15; index += 1) {
    const close = index + 2;
    bars.push({ t: index, o: close - 1, h: close + 1, l: close - 1.5, c: close });
  }
  assert.ok(atr(bars, 14) > 0);
});

test("plan engine computes sell signal when target is reached", () => {
  const runtime = {
    quotes: {
      AU9999: { price: 965, bid: 964, ask: 966, source: "sina", updatedAt: Date.parse("2026-08-14T02:00:00Z") },
      XAU: { price: 4400, source: "tencent", updatedAt: Date.parse("2026-08-14T02:00:00Z") },
      USDCNY: { price: 6.74, source: "tencent", updatedAt: Date.parse("2026-08-14T02:00:00Z") },
    },
    bars: {
      AU9999: { 1: [], 5: [], 60: [] },
      XAU: { 1: oneMinBars("2026-08-14T02:00:00Z", 60), 5: [], 60: [] },
    },
  };
  const config = normalizeConfig({
    position: { grams: 10, avgCostPerGram: 945 },
    fee: { buyPerGram: 0, sellPerGram: 5 },
  });
  const plan = computePlan(runtime, config, new Date("2026-08-14T02:00:00Z"));
  assert.equal(plan.marketState, "open");
  assert.equal(plan.action, "sell_take_profit");
  assert.ok(plan.suggestedOrder.price > plan.breakeven);
  assert.equal(plan.suggestedOrder.side, "sell");
  // 分批卖出：10 克持仓时，单次建议卖出 1 克（10%）
  assert.equal(plan.suggestedOrder.grams, 1);
});

test("plan engine sizes take-profit sells from max grams when configured", () => {
  const runtime = {
    quotes: {
      AU9999: { price: 965, bid: 964, ask: 966, source: "sina", updatedAt: Date.parse("2026-08-14T02:00:00Z") },
      XAU: { price: 4400, source: "tencent", updatedAt: Date.parse("2026-08-14T02:00:00Z") },
      USDCNY: { price: 6.74, source: "tencent", updatedAt: Date.parse("2026-08-14T02:00:00Z") },
    },
    bars: {
      AU9999: { 1: [], 5: [], 60: [] },
      XAU: { 1: oneMinBars("2026-08-14T02:00:00Z", 60), 5: [], 60: [] },
    },
  };
  const config = normalizeConfig({
    position: { grams: 10, avgCostPerGram: 945 },
    limits: { maxGrams: 100 },
    fee: { buyPerGram: 0, sellPerGram: 5 },
  });
  const plan = computePlan(runtime, config, new Date("2026-08-14T02:00:00Z"));
  assert.equal(plan.action, "sell_take_profit");
  // 最大投入 100 克、当前 10 克：已处于轻仓区间（20% 以下），止盈允许直接清仓
  assert.equal(plan.suggestedOrder.grams, 10);
});

test("plan engine uses live CMB prices when provided", () => {
  const now = new Date("2026-08-14T02:00:00Z").getTime();
  const runtime = {
    quotes: {
      AU9999: { price: 965, bid: 964, ask: 966, source: "sina", updatedAt: now },
      CMB: { price: 972.43, buyPrice: 974.43, sellPrice: 970.43, source: "cmb", updatedAt: now },
      XAU: null,
      USDCNY: null,
    },
    bars: {
      AU9999: { 1: [], 5: [], 60: [] },
      XAU: { 1: [], 5: [], 60: [] },
      CMB: { 1: oneMinBars("2026-08-14T02:00:00Z", 60), 5: [], 60: [] },
    },
  };
  const config = normalizeConfig({
    position: { grams: 10, avgCostPerGram: 945 },
    fee: { buyPerGram: 0, sellPerGram: 5 },
  });
  const plan = computePlan(runtime, config, new Date("2026-08-14T02:00:00Z"));
  assert.equal(plan.marketState, "open");
  assert.equal(plan.action, "sell_take_profit");
  assert.equal(plan.position.cmbNow, 970.43);
  assert.equal(plan.position.feeAdjustedPnl, 200.3);
  assert.equal(plan.position.effectiveExitPrice, 965.23);
  assert.equal(plan.position.effectiveEntryPrice, 945.2);
  assert.equal(plan.breakeven, 950.4);
  assert.equal(plan.stopPrice, 948.4);
  assert.equal(plan.signalPrice, 974.43);
  assert.equal(plan.suggestedOrder.cmbEstimatedPrice, 970.43);
  assert.equal(plan.suggestedOrder.price, 970.43);
});

test("fallback and live stop logic trigger at the configured effective loss", () => {
  const now = new Date("2026-08-14T02:00:00Z");
  const config = normalizeConfig({
    position: { grams: 10, avgCostPerGram: 100 },
    fee: { sellPerGram: 2 },
    strategy: { maxLossPerGram: 2, slippagePerGram: 0.5 },
  });
  const liveRuntime = {
    quotes: {
      AU9999: null,
      CMB: { price: 105, buyPrice: 105, sellPrice: 101, source: "cmb", updatedAt: now.getTime() },
      XAU: null,
      USDCNY: null,
    },
    bars: { AU9999: { 1: [], 5: [], 60: [] }, XAU: { 1: [], 5: [], 60: [] }, CMB: { 1: oneMinBars(now, 60), 5: [], 60: [] } },
  };
  const livePlan = computePlan(liveRuntime, config, now);
  assert.equal(livePlan.position.profitPerGram, -2);
  assert.equal(livePlan.stopPrice, 101);
  assert.equal(livePlan.action, "sell_stop");

  const fallbackRuntime = {
    quotes: {
      AU9999: { price: 101.2, bid: 101.1, ask: 101.3, source: "test", updatedAt: now.getTime() },
      CMB: null,
      XAU: null,
      USDCNY: null,
    },
    bars: { AU9999: { 1: oneMinBars(now, 60, 101.2), 5: [], 60: [] }, XAU: { 1: [], 5: [], 60: [] }, CMB: { 1: [], 5: [], 60: [] } },
  };
  const fallbackConfig = normalizeConfig({
    ...config,
    cmb: { buySpreadPerGram: 0, sellSpreadPerGram: 0 },
    strategy: { ...config.strategy, estimatedSpreadPerGram: 0.2 },
  });
  const fallbackPlan = computePlan(fallbackRuntime, fallbackConfig, now);
  assert.equal(fallbackPlan.position.profitPerGram, -2);
  assert.equal(fallbackPlan.action, "sell_stop");
});

test("plan engine still works with live CMB when Au99.99 is missing", () => {
  const now = new Date("2026-08-14T02:00:00Z").getTime();
  const runtime = {
    quotes: {
      AU9999: null,
      CMB: { price: 960.43, buyPrice: 960.43, sellPrice: 955.43, source: "cmb", updatedAt: now },
      XAU: null,
      USDCNY: null,
    },
    bars: { AU9999: { 1: [], 5: [], 60: [] }, XAU: { 1: [], 5: [], 60: [] }, CMB: { 1: oneMinBars("2026-08-14T02:00:00Z", 60), 5: [], 60: [] } },
  };
  const config = normalizeConfig({
    position: { grams: 10, avgCostPerGram: 945 },
    limits: { maxGrams: 100 },
  });
  const plan = computePlan(runtime, config, new Date("2026-08-14T02:00:00Z"));
  assert.equal(plan.marketState, "open");
  assert.notEqual(plan.action, "no_data");
  assert.equal(plan.instrument, "CMB");
  assert.equal(plan.signalPrice, 960.43);
  assert.equal(plan.cmbEstimatedPrice, 955.43);
});

test("plan engine ignores stale Au99.99 when live CMB is available", () => {
  const now = new Date("2026-08-14T02:00:00Z");
  const runtime = {
    quotes: {
      AU9999: { price: 965, bid: 964, ask: 966, source: "sina", updatedAt: now.getTime() - 20 * 60_000 },
      CMB: { price: 960.43, buyPrice: 960.43, sellPrice: 955.43, source: "cmb", updatedAt: now.getTime() },
      XAU: null,
      USDCNY: null,
    },
    bars: { AU9999: { 1: [], 5: [], 60: [] }, XAU: { 1: [], 5: [], 60: [] }, CMB: { 1: oneMinBars(now, 60), 5: [], 60: [] } },
  };
  const config = normalizeConfig({
    position: { grams: 10, avgCostPerGram: 945 },
    limits: { maxGrams: 100 },
  });
  const plan = computePlan(runtime, config, now);
  assert.equal(plan.marketState, "open");
  assert.notEqual(plan.action, "data_stale");
  assert.notEqual(plan.action, "no_data");
});




test("plan engine stays quiet when market is closed", () => {
  const runtime = {
    quotes: {
      AU9999: { price: 950, bid: 949, ask: 951, source: "sina", updatedAt: Date.parse("2026-08-14T02:00:00Z") },
      XAU: { price: 4375, source: "tencent", updatedAt: Date.parse("2026-08-14T02:00:00Z") },
      USDCNY: { price: 6.74, source: "tencent", updatedAt: Date.parse("2026-08-14T02:00:00Z") },
    },
    bars: { AU9999: { 5: [], 60: [] }, XAU: { 5: [], 60: [] } },
  };
  const plan = computePlan(runtime, DEFAULT_CONFIG, new Date("2026-08-16T03:00:00Z"));
  assert.equal(plan.marketState, "closed");
  assert.equal(plan.action, "market_closed");
});

test("plan engine computes buy setup when intraday trend and support align", () => {
  function makeBars(start, end, base, rise) {
    const bars = [];
    let price = base - 210 * rise;
    for (let t = start - 210 * 5 * 60_000; t <= end; t += 5 * 60_000) {
      const o = price;
      const c = price + rise;
      price = c;
      bars.push({ t, o, h: c + 0.5, l: o - 0.5, c });
    }
    return bars;
  }
  const now = new Date("2026-08-14T02:00:00Z").getTime();
  const runtime = {
    quotes: {
      AU9999: { price: 951, bid: 950.8, ask: 951.2, source: "test", updatedAt: now },
      XAU: { price: 4375, source: "test", updatedAt: now },
      USDCNY: { price: 6.74, source: "test", updatedAt: now },
    },
    bars: {
      AU9999: { 1: [], 5: [], 60: [] },
      // XAU 是首选信号标的：bars 用美元口径，折算后与现价一致
      XAU: {
        1: oneMinBars("2026-08-14T02:00:00Z", 60),
        5: makeBars(now - 150 * 5 * 60_000, now, 4315, 0.4),
        60: makeBars(now - 120 * 60 * 60_000, now, 4315, 0.5),
      },
    },
  };
  const plan = computePlan(runtime, normalizeConfig({ limits: { maxGrams: 50 } }), new Date("2026-08-14T02:00:00Z"));
  assert.equal(plan.action, "buy_setup");
  assert.equal(plan.suggestedOrder.side, "buy");
  // 分批买入：最大投入 50 克时，单次建议 5 克（10%）
  assert.equal(plan.suggestedOrder.grams, 5);
  assert.ok(plan.targetPrice > plan.breakeven);
  // 回本价应基于建议买入价计算，而不是当前市场买入价
  assert.ok(plan.breakeven > plan.suggestedOrder.cmbEstimatedPrice);
});

test("plan engine suggests add position when holding and setup aligns", () => {
  function makeBars(start, end, base, rise) {
    const bars = [];
    let price = base - 210 * rise;
    for (let t = start - 210 * 5 * 60_000; t <= end; t += 5 * 60_000) {
      const o = price;
      const c = price + rise;
      price = c;
      bars.push({ t, o, h: c + 0.5, l: o - 0.5, c });
    }
    return bars;
  }
  const now = new Date("2026-08-14T02:00:00Z").getTime();
  const runtime = {
    quotes: {
      AU9999: { price: 951, bid: 950.8, ask: 951.2, source: "test", updatedAt: now },
      XAU: { price: 4375, source: "test", updatedAt: now },
      USDCNY: { price: 6.74, source: "test", updatedAt: now },
    },
    bars: {
      AU9999: { 1: [], 5: [], 60: [] },
      XAU: {
        1: oneMinBars("2026-08-14T02:00:00Z", 60),
        5: makeBars(now - 150 * 5 * 60_000, now, 4315, 0.4),
        60: makeBars(now - 120 * 60 * 60_000, now, 4315, 0.5),
      },
    },
  };
  const config = normalizeConfig({
    position: { lots: [{ id: "a", grams: 10, price: 945 }] },
    limits: { maxGrams: 50 },
    strategy: { minProfitPerGram: 10 },
  });
  const plan = computePlan(runtime, config, new Date("2026-08-14T02:00:00Z"));
  assert.equal(plan.action, "add_position");
  assert.equal(plan.suggestedOrder.side, "buy");
  assert.ok(plan.suggestedOrder.grams > 0);
  assert.equal(plan.position.lots.length, 1);
  // 补仓只是建议：在用户实际更新持仓前，回本价/目标价继续按当前持仓配置展示
  assert.equal(plan.breakeven, plan.position.exitNeeded);
  assert.ok(plan.targetPrice > plan.breakeven);
});

test("plan engine suggests reduce position on overbought weakness", () => {
  function makeBarsWithDrop(start, end, base, rise, dropEnd) {
    const bars = [];
    let price = base - 210 * rise;
    for (let t = start - 210 * 5 * 60_000; t <= end; t += 5 * 60_000) {
      const o = price;
      if (t >= dropEnd) {
        const c = price - 0.2;
        bars.push({ t, o: price + 0.2, h: price + 3, l: c - 0.2, c });
        price = c;
      } else {
        const c = price + rise;
        bars.push({ t, o, h: c + 0.5, l: o - 0.5, c });
        price = c;
      }
    }
    return bars;
  }
  const now = new Date("2026-08-14T02:00:00Z").getTime();
  const dropEnd = now - 5 * 60_000;
  const runtime = {
    quotes: {
      AU9999: { price: 958, bid: 957.8, ask: 958.2, source: "test", updatedAt: now },
      XAU: { price: 4375, source: "test", updatedAt: now },
      USDCNY: { price: 6.74, source: "test", updatedAt: now },
    },
    bars: {
      AU9999: { 1: [], 5: [], 60: [] },
      XAU: {
        1: oneMinBars("2026-08-14T02:00:00Z", 60),
        5: makeBarsWithDrop(now - 150 * 5 * 60_000, now, 4315, 0.5, dropEnd),
        60: makeBarsWithDrop(now - 120 * 60 * 60_000, now, 4315, 0.5, dropEnd),
      },
    },
  };
  const config = normalizeConfig({
    position: { lots: [{ id: "a", grams: 30, price: 930 }] },
    limits: { maxGrams: 100 },
    strategy: { minProfitPerGram: 10 },
  });
  const plan = computePlan(runtime, config, new Date("2026-08-14T02:00:00Z"));
  assert.equal(plan.action, "reduce_position");
  assert.equal(plan.suggestedOrder.side, "sell");
  // 最大投入 100 克、当前 30 克：按目标仓位区间降到轻仓上限 20 克，因此建议卖出 10 克
  assert.equal(plan.suggestedOrder.grams, 10);
  assert.ok(plan.suggestedOrder.grams < plan.position.grams);
});

test("plan engine does not reduce an already-light position", () => {
  function makeBarsWithDrop(start, end, base, rise, dropEnd) {
    const bars = [];
    let price = base - 210 * rise;
    for (let t = start - 210 * 5 * 60_000; t <= end; t += 5 * 60_000) {
      const o = price;
      if (t >= dropEnd) {
        const c = price - 0.2;
        bars.push({ t, o: price + 0.2, h: price + 3, l: c - 0.2, c });
        price = c;
      } else {
        const c = price + rise;
        bars.push({ t, o, h: c + 0.5, l: o - 0.5, c });
        price = c;
      }
    }
    return bars;
  }
  const now = new Date("2026-08-14T02:00:00Z").getTime();
  const dropEnd = now - 5 * 60_000;
  const runtime = {
    quotes: {
      AU9999: { price: 958, bid: 957.8, ask: 958.2, source: "test", updatedAt: now },
      XAU: { price: 4375, source: "test", updatedAt: now },
      USDCNY: { price: 6.74, source: "test", updatedAt: now },
    },
    bars: {
      AU9999: { 1: [], 5: [], 60: [] },
      XAU: {
        1: oneMinBars("2026-08-14T02:00:00Z", 60),
        5: makeBarsWithDrop(now - 150 * 5 * 60_000, now, 4315, 0.5, dropEnd),
        60: makeBarsWithDrop(now - 120 * 60 * 60_000, now, 4315, 0.5, dropEnd),
      },
    },
  };
  const config = normalizeConfig({
    position: { lots: [{ id: "a", grams: 10, price: 930 }] },
    limits: { maxGrams: 100 },
    strategy: { minProfitPerGram: 10 },
  });
  const plan = computePlan(runtime, config, new Date("2026-08-14T02:00:00Z"));
  assert.equal(plan.action, "wait");
  assert.ok(plan.reasonCodes.includes("already_light_position"));
  assert.equal(plan.suggestedOrder, null);
});

test("plan engine applies same-direction cooldown when signalState is present", () => {
  const now = new Date("2026-08-14T02:00:00Z");
  const runtime = {
    quotes: {
      AU9999: { price: 965, bid: 964, ask: 966, source: "sina", updatedAt: now.getTime() },
      XAU: { price: 4400, source: "tencent", updatedAt: now.getTime() },
      USDCNY: { price: 6.74, source: "tencent", updatedAt: now.getTime() },
    },
    bars: {
      AU9999: { 1: [], 5: [], 60: [] },
      XAU: { 1: oneMinBars("2026-08-14T02:00:00Z", 60), 5: [], 60: [] },
    },
    signalState: {
      lastAction: "sell_take_profit",
      lastSide: "sell",
      lastAt: new Date(now.getTime() - 5 * 60_000).toISOString(),
      lastPositionGrams: 10,
      lastPrice: 965,
      buyStreak: 0,
      sellStreak: 0,
    },
  };
  const config = normalizeConfig({
    position: { grams: 10, avgCostPerGram: 945 },
    limits: { maxGrams: 100 },
    fee: { buyPerGram: 0, sellPerGram: 5 },
    strategy: { signalCooldownMinutes: 30, confirmBars: 1 },
  });
  const plan = computePlan(runtime, config, now);
  assert.equal(plan.action, "wait");
  assert.ok(plan.reasonCodes.includes("cooldown_active"));
  assert.equal(plan.suggestedOrder, null);
});

test("plan engine preserves same-side cooldown when user position changes", () => {
  const now = new Date("2026-08-14T02:00:00Z");
  const runtime = {
    quotes: {
      AU9999: { price: 965, bid: 964, ask: 966, source: "sina", updatedAt: now.getTime() },
      XAU: { price: 4400, source: "tencent", updatedAt: now.getTime() },
      USDCNY: { price: 6.74, source: "tencent", updatedAt: now.getTime() },
    },
    bars: {
      AU9999: { 1: [], 5: [], 60: [] },
      XAU: { 1: oneMinBars("2026-08-14T02:00:00Z", 60), 5: [], 60: [] },
    },
    signalState: {
      lastAction: "sell_take_profit",
      lastSide: "sell",
      lastAt: new Date(now.getTime() - 5 * 60_000).toISOString(),
      lastPositionGrams: 20,
      lastPrice: 965,
      buyStreak: 0,
      sellStreak: 0,
    },
  };
  const config = normalizeConfig({
    position: { grams: 10, avgCostPerGram: 945 },
    limits: { maxGrams: 100 },
    fee: { buyPerGram: 0, sellPerGram: 5 },
    strategy: { signalCooldownMinutes: 30, confirmBars: 1 },
  });
  const plan = computePlan(runtime, config, now);
  assert.equal(plan.action, "wait");
  assert.equal(plan.suggestedOrder, null);
  assert.ok(plan.reasonCodes.includes("cooldown_active"));
  assert.equal(plan.signalState.lastPositionGrams, 10);
  assert.equal(plan.signalState.lastSide, "sell");
});

test("plan engine requires consecutive confirmation before issuing a buy signal", () => {
  function makeBars(start, end, base, rise) {
    const bars = [];
    let price = base - 210 * rise;
    for (let t = start - 210 * 5 * 60_000; t <= end; t += 5 * 60_000) {
      const o = price;
      const c = price + rise;
      price = c;
      bars.push({ t, o, h: c + 0.5, l: o - 0.5, c });
    }
    return bars;
  }
  // confirmBars counts *closed 5m bars*: two evaluations inside the same bar
  // count once, and only a newer closed bar advances the streak.
  const now = new Date("2026-08-14T02:00:00Z");
  const nextBar = new Date(now.getTime() + 5 * 60_000);
  function makeRuntime(at) {
    return {
      quotes: {
        AU9999: { price: 951, bid: 950.8, ask: 951.2, source: "test", updatedAt: at },
        XAU: { price: 4375, source: "test", updatedAt: at },
        USDCNY: { price: 6.74, source: "test", updatedAt: at },
      },
      bars: {
        AU9999: { 1: [], 5: [], 60: [] },
        XAU: {
          1: oneMinBars(at, 60),
          5: makeBars(at - 150 * 5 * 60_000, at, 4315, 0.4),
          60: makeBars(at - 120 * 60 * 60_000, at, 4315, 0.5),
        },
      },
      signalState: {
        lastAction: null,
        lastSide: null,
        lastAt: null,
        lastPositionGrams: 0,
        lastPrice: null,
        buyStreak: 0,
        sellStreak: 0,
      },
    };
  }
  const config = normalizeConfig({
    limits: { maxGrams: 50 },
    strategy: { confirmBars: 2, signalCooldownMinutes: 0 },
  });
  const first = computePlan(makeRuntime(now.getTime()), config, now);
  assert.equal(first.action, "wait");
  assert.ok(first.reasonCodes.includes("signal_confirming"));
  assert.equal(first.signalState.buyStreak, 1);

  // Same closed bar again: still confirming, no double count.
  const runtimeRepeat = makeRuntime(now.getTime());
  runtimeRepeat.signalState = first.signalState;
  const repeat = computePlan(runtimeRepeat, config, new Date(now.getTime() + 30_000));
  assert.equal(repeat.action, "wait");
  assert.ok(repeat.reasonCodes.includes("signal_confirming"));
  assert.equal(repeat.signalState.buyStreak, 1);

  // Next closed bar: streak reaches confirmBars → fired.
  const runtimeSecond = makeRuntime(nextBar.getTime());
  runtimeSecond.signalState = first.signalState;
  const second = computePlan(runtimeSecond, config, nextBar);
  assert.equal(second.action, "buy_setup");
  assert.equal(second.suggestedOrder.side, "buy");
  assert.equal(second.signalState.buyStreak, 2);
});

test("plan engine refuses to trade on stale quotes", () => {
  const now = new Date("2026-08-14T02:00:00Z");
  const runtime = {
    quotes: {
      AU9999: { price: 950, bid: 949, ask: 951, source: "sina", updatedAt: now.getTime() - 20 * 60_000 },
      XAU: null,
      USDCNY: null,
    },
    bars: { AU9999: { 5: [], 60: [] }, XAU: { 5: [], 60: [] } },
  };
  const plan = computePlan(runtime, DEFAULT_CONFIG, now);
  assert.equal(plan.marketState, "open");
  assert.equal(plan.action, "data_stale");
  assert.ok(plan.reasonCodes.includes("stale_quote"));
});

test("coverage gate requires >80% for 5/10m and >60% for 30/60m valid per-minute data", () => {
  const now = new Date("2026-08-14T02:00:00Z");
  const full = oneMinBars(now, 60);
  assert.equal(windowCoverage(full, now, 60), 1);
  assert.equal(windowCoverage(full, now, 5), 1);
  assert.equal(windowCoverage([], now, 60), 0);
  assert.equal(windowCoverage(null, now, 60), 0);
  assert.equal(windowCoverage(undefined, now, 60), 0);

  // Only the most recent 30 of 60 minutes carry data.
  const half = oneMinBars(now, 30);
  assert.equal(windowCoverage(half, now, 60), 0.5);
  assert.equal(windowCoverage(half, now, 30), 1);

  const gateOk = coverageGate(full, now);
  assert.equal(gateOk.ok, true);
  assert.deepEqual(gateOk.failing, []);

  const gateBad = coverageGate(half, now);
  assert.equal(gateBad.ok, false);
  assert.deepEqual(gateBad.failing, [60]);
  assert.equal(gateBad.coverage[60], 0.5);
  assert.equal(gateBad.coverage[5], 1);

  // Missing minute inside the 5m window: 4/5 = 80% is NOT enough,
  // while 10/30/60 remain above their applicable thresholds.
  const missingMinute = oneMinBars(now, 60).filter((bar) => bar.t !== Math.floor(now.getTime() / 60_000) * 60_000 - 2 * 60_000);
  const gateGap = coverageGate(missingMinute, now);
  assert.equal(gateGap.ok, false);
  assert.deepEqual(gateGap.failing, [5]);
  assert.equal(gateGap.coverage[10], 0.9);

  // 37/60 is above the 60% long-window threshold, while 5/10m remain complete.
  const longWindowsValid = coverageGate(oneMinBars(now, 37), now);
  assert.equal(longWindowsValid.ok, true);
  assert.deepEqual(longWindowsValid.failing, []);
  assert.equal(longWindowsValid.coverage[60], 0.62);

  // Restricted windows: coverage is reported for all four windows, but only
  // the passed windows are validated (the session warm-up behaviour).
  const gateRelaxed = coverageGate(oneMinBars(now, 30), now, [5, 10]);
  assert.equal(gateRelaxed.ok, true);
  assert.deepEqual(gateRelaxed.failing, []);
  assert.equal(gateRelaxed.coverage[60], 0.5);
  const gateStrict = coverageGate(oneMinBars(now, 30), now);
  assert.equal(gateStrict.ok, false);
  assert.deepEqual(gateStrict.failing, [60]);
});

test("coverage re-anchors below an outage seam instead of staying poisoned", () => {
  // 2026-08-25 morning blackout shape: a ≥8-minute contiguous hole (host
  // asleep / source down), then quotes resume. The trailing windows must be
  // measured over the post-seam segment only — a 55-minute hole used to keep
  // the 60m gate red for another full hour after data had recovered.
  const now = new Date("2026-08-14T02:40:00Z");
  const config = {}; // resolved through the same calendar defaults as production
  const fresh = oneMinBars(now, 6); // only the newest 6 minutes carry bars

  // Long windows re-anchor to the seam: 6/6 fresh minutes → fully covered.
  assert.equal(windowCoverage(fresh, now, 60, config), 1);
  assert.equal(windowCoverage(fresh, now, 30, config), 1);
  const gate = coverageGate(fresh, now, [5, 10, 30, 60], config);
  // Only the 10m window still counts its rolling seam tail (6/10 = 0.6); the
  // long windows are already green right after quotes resume.
  assert.deepEqual(gate.failing, [10]);
  assert.equal(gate.coverage[60], 1);
  assert.equal(gate.coverage[10], 0.6);
  // With ten fresh minutes every window is green immediately.
  const gateTen = coverageGate(oneMinBars(now, 10), now, [5, 10, 30, 60], config);
  assert.equal(gateTen.ok, true);
  assert.deepEqual(gateTen.failing, []);

  // Short windows never scan far enough back to complete the seam run, so the
  // seam tail is still counted inside them (conservative by design): 6/10.
  assert.equal(windowCoverage(fresh, now, 10, config), 0.6);

  // An ongoing outage stays red: every scanned slot is missing.
  assert.equal(windowCoverage([], now, 30, config), 0);
  assert.equal(coverageGate([], now, [5, 10, 30, 60], config).ok, false);

  // Scattered single-minute blips are not seams: ratio reflects them as before.
  const blip = oneMinBars(now, 60).filter((bar) => bar.t !== Math.floor(now.getTime() / 60_000) * 60_000 - 3 * 60_000);
  assert.equal(windowCoverage(blip, now, 10, config), 0.9);
});

test("resampleBars aggregates by natural 10m/30m buckets and marks partial buckets", () => {
  const end = Date.parse("2026-08-14T01:55:00Z");
  const bars5 = [];
  for (let i = 0; i < 12; i += 1) {
    const t = end - (11 - i) * 5 * 60_000;
    bars5.push({ t, o: 940 + i, h: 942 + i, l: 939 + i, c: 941 + i });
  }
  const bars10 = resampleBars(bars5, 2);
  assert.equal(bars10.length, 6);
  assert.equal(bars10[0].t, Date.parse("2026-08-14T01:00:00Z"));
  assert.equal(bars10[0].o, 940);
  assert.equal(bars10[0].h, 943);
  assert.equal(bars10[0].l, 939);
  assert.equal(bars10[0].c, 942);
  assert.equal(bars10[0].partial, false);
  assert.equal(bars10[5].t, Date.parse("2026-08-14T01:50:00Z"));
  assert.equal(bars10[5].c, 952);

  const bars30 = resampleBars(bars5, 6);
  assert.equal(bars30.length, 2);
  assert.equal(bars30[0].t, Date.parse("2026-08-14T01:00:00Z"));
  assert.equal(bars30[0].o, 940);
  assert.equal(bars30[0].h, 947);
  assert.equal(bars30[0].c, 946);
  assert.equal(bars30[1].t, Date.parse("2026-08-14T01:30:00Z"));
  assert.equal(bars30[1].o, 946);
  assert.equal(bars30[1].c, 952);

  const shiftedStart = bars5.slice(3, 7); // 01:15..01:30 crosses a natural boundary
  const shifted30 = resampleBars(shiftedStart, 6);
  assert.equal(shifted30.length, 2, "bars never cross a natural 30m boundary");
  assert.deepEqual(shifted30.map((bar) => bar.t), [
    Date.parse("2026-08-14T01:00:00Z"),
    Date.parse("2026-08-14T01:30:00Z"),
  ]);
  assert.ok(shifted30.every((bar) => bar.partial === true));

  const missingChild = resampleBars(bars5.slice(0, 6).filter((_, index) => index !== 2), 6);
  assert.equal(missingChild[0].partial, true);
  assert.equal(missingChild[0].sampleCount, 5);
  assert.equal(missingChild[0].expectedSamples, 6);
  assert.deepEqual(resampleBars([], 2), []);
});

test("plan engine withholds suggestions when 30/60m coverage is below 60%", () => {
  const now = new Date("2026-08-14T02:00:00Z");
  const runtime = {
    quotes: {
      AU9999: { price: 950, bid: 949, ask: 951, source: "test", updatedAt: now.getTime() },
      XAU: { price: 4375.8, source: "test", updatedAt: now.getTime() },
      USDCNY: { price: 6.7421, source: "test", updatedAt: now.getTime() },
    },
    bars: {
      AU9999: { 1: [], 5: [], 60: [] },
      XAU: { 1: thinnedOneMinBars(now, 60, 14), 5: [], 60: [] },
      CMB: { 1: [], 5: [], 60: [] },
    },
  };
  const plan = computePlan(runtime, DEFAULT_CONFIG, now);
  assert.equal(plan.action, "data_incomplete");
  assert.deepEqual(plan.reasonCodes, ["data_incomplete_60m"]);
  assert.equal(plan.suggestedOrder, null);
  assert.equal(plan.dataCoverage[60], 0.5);
  assert.equal(plan.dataCoverage[5], 1);
  assert.ok(plan.indicators && plan.indicators.ind5);
});

test("plan engine requires EMA20 rising on 10/30/60m for the trend filter", () => {
  function makeBars(start, end, base, rise) {
    const bars = [];
    let price = base - 210 * rise;
    for (let t = start - 210 * 5 * 60_000; t <= end; t += 5 * 60_000) {
      const o = price;
      const c = price + rise;
      price = c;
      bars.push({ t, o, h: c + 0.5, l: o - 0.5, c });
    }
    return bars;
  }
  const now = new Date("2026-08-14T02:00:00Z");
  const runtime = {
    quotes: {
      AU9999: { price: 950, bid: 949, ask: 951, source: "test", updatedAt: now.getTime() },
      XAU: { price: 4375, source: "test", updatedAt: now.getTime() },
      USDCNY: { price: 6.74, source: "test", updatedAt: now.getTime() },
    },
    bars: {
      // 60m trend is up, but the 5m series is flat, so the 10m/30m EMA20
      // (resampled from 5m) are flat: the multi-timeframe filter must fail.
      AU9999: { 1: [], 5: [], 60: [] },
      XAU: {
        1: oneMinBars(now, 60),
        5: makeBars(now.getTime() - 150 * 5 * 60_000, now.getTime(), 4315, 0),
        60: makeBars(now.getTime() - 120 * 60 * 60_000, now.getTime(), 4300, 0.08),
      },
    },
  };
  const plan = computePlan(runtime, normalizeConfig({ limits: { maxGrams: 50 } }), now);
  assert.equal(plan.action, "wait");
  assert.ok(plan.reasonCodes.includes("trend_filter_not_met"));
  assert.ok(plan.indicators.ind10 && plan.indicators.ind30);
  assert.equal(plan.suggestedOrder, null);
});

test("snapshot values a position from fresh bid even when strategy data is incomplete", () => {
  const now = new Date("2026-08-14T02:00:00Z");
  const config = normalizeConfig({
    position: { grams: 10, avgCostPerGram: 100 },
    fee: { buyPerGram: 0, sellPerGram: 2 },
    strategy: { slippagePerGram: 0.5 },
  });
  const snap = buildSnapshot({
    quotes: {
      AU9999: { price: 950, prevClose: 940.72, source: "test", updatedAt: now.getTime() },
      CMB: { price: 105, buyPrice: 105, sellPrice: 95, source: "cmb", updatedAt: now.getTime() },
      XAU: null,
      USDCNY: null,
    },
    bars: {
      AU9999: { 1: [], 5: [], 60: [] },
      XAU: { 1: [], 5: [] },
      CMB: { 1: thinnedOneMinBars(now, 60, 14), 5: [] },
    },
    plan: null,
  }, config, now);
  assert.equal(snap.plan.action, "data_incomplete");
  assert.equal(snap.plan.dataCoverage[60], 0.5);
  assert.equal(snap.plan.dataCoverage[5], 1);
  assert.equal(snap.plan.suggestedOrder, null);
  assert.equal(snap.position.valuationAvailable, true);
  assert.equal(snap.position.effectiveExitPrice, 92.5);
  assert.equal(snap.position.effectiveEntryPrice, 100.5);
  assert.equal(snap.position.feeAdjustedPnl, -80);
});

test("snapshot reports unavailable valuation instead of zero for a stale executable bid", () => {
  const now = new Date("2026-08-14T02:00:00Z");
  const config = normalizeConfig({ position: { grams: 10, avgCostPerGram: 100 } });
  const snap = buildSnapshot({
    quotes: {
      AU9999: null,
      CMB: { price: 105, buyPrice: 105, sellPrice: 95, source: "cmb", updatedAt: now.getTime() - 20 * 60_000 },
      XAU: null,
      USDCNY: null,
    },
    bars: { AU9999: { 1: [] }, XAU: { 1: [] }, CMB: { 1: [], 5: [], 60: [] } },
    plan: null,
  }, config, now);
  assert.equal(snap.plan.action, "data_stale");
  assert.equal(snap.position.valuationAvailable, false);
  assert.equal(snap.position.feeAdjustedPnl, null);
  assert.equal(snap.position.valuationReasonCode, "execution_bid_unavailable");
});

test("plan engine prefers XAU-converted signal over Au99.99 when CMB is not live", () => {
  const now = new Date("2026-08-14T02:00:00Z");
  const runtime = {
    quotes: {
      AU9999: { price: 965, bid: 964, ask: 966, source: "sina", updatedAt: now.getTime() },
      XAU: { price: 4400, source: "tencent", updatedAt: now.getTime() },
      USDCNY: { price: 6.74, source: "tencent", updatedAt: now.getTime() },
    },
    bars: { AU9999: { 1: [], 5: [], 60: [] }, XAU: { 1: oneMinBars(now, 60), 5: [], 60: [] } },
  };
  const plan = computePlan(runtime, DEFAULT_CONFIG, now);
  assert.equal(plan.instrument, "XAU");
  assert.ok(Math.abs(plan.signalPrice - 953.46) < 0.01);
  assert.equal(plan.action, "wait");
});

test("plan engine falls back to Au99.99 when no international conversion is available", () => {
  const now = new Date("2026-08-14T02:00:00Z");
  const runtime = {
    quotes: {
      AU9999: { price: 950, bid: 949, ask: 951, source: "sina", updatedAt: now.getTime() },
      XAU: null,
      USDCNY: null,
    },
    bars: { AU9999: { 1: oneMinBars(now, 60), 5: [], 60: [] }, XAU: { 1: [], 5: [], 60: [] } },
  };
  const plan = computePlan(runtime, DEFAULT_CONFIG, now);
  assert.equal(plan.instrument, "Au99.99");
  assert.equal(plan.signalPrice, 950);
  assert.equal(plan.action, "wait");
  // 招行价按 Au99.99 + 价差估算（+1.72）
  assert.equal(plan.cmbEstimatedPrice, 951.52);
});

test("plan engine checks only 5/10m coverage during the first hour of a session", () => {
  const now = new Date("2026-08-14T01:30:00Z"); // Friday 09:30 Beijing: 30 min into the session
  const runtime = {
    quotes: {
      AU9999: { price: 950, bid: 949, ask: 951, source: "test", updatedAt: now.getTime() },
      XAU: { price: 4375.8, source: "test", updatedAt: now.getTime() },
      USDCNY: { price: 6.7421, source: "test", updatedAt: now.getTime() },
    },
    bars: {
      AU9999: { 1: [], 5: [], 60: [] },
      XAU: { 1: thinnedOneMinBars(now, 60, 14), 5: [], 60: [] },
      CMB: { 1: [], 5: [], 60: [] },
    },
  };
  const plan = computePlan(runtime, DEFAULT_CONFIG, now);
  // The 60m window is only ~67% covered (the seam at yesterday's session end
  // truncates the scanned slots to today's segment), but 30/60m are not
  // validated during the warm-up hour; the plan proceeds (wait) instead of
  // data_incomplete.
  assert.equal(plan.action, "wait");
  assert.ok(!plan.reasonCodes.some((code) => code.startsWith("data_incomplete")));
  assert.equal(plan.dataCoverage[60], 0.67);
  assert.equal(plan.dataCoverage[5], 1);
});

test("plan engine still withholds suggestions in the first hour when 5/10m coverage fails", () => {
  const now = new Date("2026-08-14T01:30:00Z"); // Friday 09:30 Beijing
  const end = Math.floor(now.getTime() / 60_000) * 60_000;
  // Remove three minutes inside the last 10 (incl. two inside the last 5).
  const sparse = oneMinBars(now, 30).filter((bar) =>
    bar.t !== end - 2 * 60_000 && bar.t !== end - 4 * 60_000 && bar.t !== end - 6 * 60_000,
  );
  const runtime = {
    quotes: {
      AU9999: { price: 950, bid: 949, ask: 951, source: "test", updatedAt: now.getTime() },
      XAU: { price: 4375.8, source: "test", updatedAt: now.getTime() },
      USDCNY: { price: 6.7421, source: "test", updatedAt: now.getTime() },
    },
    bars: {
      AU9999: { 1: [], 5: [], 60: [] },
      XAU: { 1: sparse, 5: [], 60: [] },
      CMB: { 1: [], 5: [], 60: [] },
    },
  };
  const plan = computePlan(runtime, DEFAULT_CONFIG, now);
  assert.equal(plan.action, "data_incomplete");
  assert.ok(plan.reasonCodes.includes("data_incomplete_5m"));
  assert.ok(plan.reasonCodes.includes("data_incomplete_10m"));
  assert.ok(!plan.reasonCodes.includes("data_incomplete_30m"));
  assert.ok(!plan.reasonCodes.includes("data_incomplete_60m"));
  assert.equal(plan.suggestedOrder, null);
});

test("plan engine checks only 5/10m coverage during the daily 00:00-01:00 Beijing window", () => {
  const now = new Date("2026-08-14T16:30:00Z"); // Saturday 00:30 Beijing, still Friday's session
  const runtime = {
    quotes: {
      AU9999: { price: 950, bid: 949, ask: 951, source: "test", updatedAt: now.getTime() },
      XAU: { price: 4375.8, source: "test", updatedAt: now.getTime() },
      USDCNY: { price: 6.7421, source: "test", updatedAt: now.getTime() },
    },
    bars: {
      AU9999: { 1: [], 5: [], 60: [] },
      XAU: { 1: thinnedOneMinBars(now, 60, 14), 5: [], 60: [] },
      CMB: { 1: [], 5: [], 60: [] },
    },
  };
  const plan = computePlan(runtime, DEFAULT_CONFIG, now);
  // The 60m window is only 50% covered, but 30/60m are not validated during
  // the daily 00:00-01:00 Beijing window; the plan proceeds (wait) instead of
  // data_incomplete.
  assert.equal(plan.action, "wait");
  assert.ok(!plan.reasonCodes.some((code) => code.startsWith("data_incomplete")));
  assert.equal(plan.dataCoverage[60], 0.5);
  assert.equal(plan.dataCoverage[5], 1);
});

test("plan engine still withholds suggestions in 00:00-01:00 when 5/10m coverage fails", () => {
  const now = new Date("2026-08-14T16:30:00Z"); // Saturday 00:30 Beijing
  const end = Math.floor(now.getTime() / 60_000) * 60_000;
  // Remove three minutes inside the last 10 (incl. two inside the last 5).
  const sparse = oneMinBars(now, 30).filter((bar) =>
    bar.t !== end - 2 * 60_000 && bar.t !== end - 4 * 60_000 && bar.t !== end - 6 * 60_000,
  );
  const runtime = {
    quotes: {
      AU9999: { price: 950, bid: 949, ask: 951, source: "test", updatedAt: now.getTime() },
      XAU: { price: 4375.8, source: "test", updatedAt: now.getTime() },
      USDCNY: { price: 6.7421, source: "test", updatedAt: now.getTime() },
    },
    bars: {
      AU9999: { 1: [], 5: [], 60: [] },
      XAU: { 1: sparse, 5: [], 60: [] },
      CMB: { 1: [], 5: [], 60: [] },
    },
  };
  const plan = computePlan(runtime, DEFAULT_CONFIG, now);
  assert.equal(plan.action, "data_incomplete");
  assert.ok(plan.reasonCodes.includes("data_incomplete_5m"));
  assert.ok(plan.reasonCodes.includes("data_incomplete_10m"));
  assert.ok(!plan.reasonCodes.includes("data_incomplete_30m"));
  assert.ok(!plan.reasonCodes.includes("data_incomplete_60m"));
  assert.equal(plan.suggestedOrder, null);
});

test("plan engine does not relax 30/60m coverage after 01:00 Beijing", () => {
  const now = new Date("2026-08-14T17:00:00Z"); // Saturday 01:00 Beijing, still Friday's session
  const runtime = {
    quotes: {
      AU9999: { price: 950, bid: 949, ask: 951, source: "test", updatedAt: now.getTime() },
      XAU: { price: 4375.8, source: "test", updatedAt: now.getTime() },
      USDCNY: { price: 6.7421, source: "test", updatedAt: now.getTime() },
    },
    bars: {
      AU9999: { 1: [], 5: [], 60: [] },
      XAU: { 1: thinnedOneMinBars(now, 60, 14), 5: [], 60: [] },
      CMB: { 1: [], 5: [], 60: [] },
    },
  };
  const plan = computePlan(runtime, DEFAULT_CONFIG, now);
  assert.equal(plan.action, "data_incomplete");
  assert.ok(plan.reasonCodes.includes("data_incomplete_60m"));
  assert.ok(!plan.reasonCodes.includes("data_incomplete_5m"));
});

test("generic webhook validation pins public DNS and blocks unsafe targets or headers", async () => {
  const publicConfig = await validateGenericWebhookConfig({
    url: "https://hooks.example.com/path",
    headers: { Authorization: "Bearer token", "X-Signature": "abc" },
  }, { lookup: async () => [{ address: "93.184.216.34", family: 4 }] });
  assert.equal(publicConfig.url, "https://hooks.example.com/path");
  assert.equal(publicConfig.address, "93.184.216.34");
  assert.deepEqual(publicConfig.headers, { authorization: "Bearer token", "x-signature": "abc" });

  const blocked = async (cfg, options = {}) => assert.rejects(
    validateGenericWebhookConfig(cfg, options),
    (error) => error?.code === "WEBHOOK_URL_BLOCKED",
  );
  await blocked({ url: "http://example.com" });
  await blocked({ url: "https://user:secret@example.com" });
  await blocked({ url: "https://127.0.0.1/hook" });
  await blocked({ url: "https://[::1]/hook" });
  await blocked({ url: "https://[::ffff:127.0.0.1]/hook" });
  await blocked({ url: "https://[fc00::1]/hook" });
  await blocked({ url: "https://[fe80::1]/hook" });
  await blocked({ url: "https://localhost/hook" });
  await blocked({ url: "https://host.local/hook" });
  await blocked({ url: "https://metadata.example/hook" }, {
    lookup: async () => [{ address: "169.254.169.254", family: 4 }],
  });
  await blocked({ url: "https://mixed.example/hook" }, {
    lookup: async () => [
      { address: "93.184.216.34", family: 4 },
      { address: "10.0.0.1", family: 4 },
    ],
  });
  await blocked({ url: "https://example.com", headers: { Host: "internal" } }, {
    lookup: async () => [{ address: "93.184.216.34", family: 4 }],
  });
  await blocked({ url: "https://example.com", headers: { "X-Test": "ok\r\nHost: internal" } }, {
    lookup: async () => [{ address: "93.184.216.34", family: 4 }],
  });
});

test("generic webhook transport receives the pinned address and rejects non-2xx", async () => {
  let connectedAddress = null;
  const lookup = async () => [{ address: "93.184.216.34", family: 4 }];
  await sendGeneric({ enabled: true, url: "https://hooks.example.com/path", headers: {} }, "hello", {
    lookup,
    transport: async (validated) => {
      connectedAddress = validated.address;
      return { ok: true, status: 200, text: async () => "" };
    },
  });
  assert.equal(connectedAddress, "93.184.216.34", "transport uses the validated address without a second lookup");

  await assert.rejects(
    sendGeneric({ enabled: true, url: "https://hooks.example.com/path", headers: {} }, "hello", {
      lookup,
      transport: async () => ({ ok: false, status: 500, text: async () => "failed" }),
    }),
    (error) => error?.code === "WEBHOOK_HTTP_ERROR",
  );
});

test("alert message contains action and CMB estimated price", () => {
  const message = buildAlertMessage({
    action: "buy_setup",
    signalPrice: 948,
    cmbEstimatedPrice: 950,
    targetPrice: 956,
    suggestedOrder: { instrument: "Au99.99", signalPrice: 948, cmbEstimatedPrice: 950, grams: 10 },
  }, DEFAULT_CONFIG, "zh");
  assert.match(message.body, /Au99\.99/);
  assert.match(message.body, /950/);
  assert.equal(message.action, "buy_setup");
});

test("alert message shows the executable CMB sell quote without disguising fees as price", () => {
  const config = normalizeConfig({ cmb: { buySpreadPerGram: 2.84, sellSpreadPerGram: 0 } });
  const message = buildAlertMessage({
    action: "sell_take_profit",
    signalPrice: 952.4,
    cmbEstimatedPrice: 952.4,
    targetPrice: 960,
    suggestedOrder: { instrument: "Au99.99", signalPrice: 952.4, cmbEstimatedPrice: 952.4, grams: 15 },
  }, config, "zh");
  assert.match(message.body, /952\.4/);
  assert.doesNotMatch(message.body, /947\.4/);
});

test("alert message does not subtract fee when live CMB price is used", () => {
  const config = normalizeConfig({ fee: { sellPerGram: 5 } });
  const message = buildAlertMessage({
    action: "sell_take_profit",
    cmbLive: true,
    signalPrice: 952.4,
    cmbEstimatedPrice: 955.43,
    targetPrice: 960,
    suggestedOrder: { instrument: "Au99.99", signalPrice: 952.4, cmbEstimatedPrice: 955.43, cmbLive: true, grams: 15 },
  }, config, "zh");
  assert.match(message.body, /955\.43/);
  assert.doesNotMatch(message.body, /950\.43/);
});

test("alert message labels CMB product, side and target clearly", () => {
  const message = buildAlertMessage({
    action: "sell_take_profit",
    cmbLive: true,
    signalPrice: 956.49,
    cmbEstimatedPrice: 951.49,
    targetPrice: 951.44,
    suggestedOrder: {
      instrument: "CMB",
      side: "sell",
      cmbLive: true,
      signalPrice: 956.49,
      cmbEstimatedPrice: 951.49,
      grams: 6,
    },
  }, DEFAULT_CONFIG, "zh");
  assert.match(message.body, /招行积存金 现价 956\.49 元\/克/);
  assert.match(message.body, /招行卖出价 951\.49 元\/克/);
  assert.match(message.body, /建议按招行卖出价 951\.49 卖出 6克/);
  assert.match(message.body, /卖出目标价 951\.44 元\/克/);
  assert.doesNotMatch(message.body, /\bCMB\b 956\.49 元\/克 · 招行 951\.49/);
});

test("alert message labels buy side and CMB buy price clearly", () => {
  const config = normalizeConfig({ cmb: { buySpreadPerGram: 2, sellSpreadPerGram: 1 } });
  const message = buildAlertMessage({
    action: "buy_setup",
    signalPrice: 948,
    cmbEstimatedPrice: 949,
    targetPrice: 956,
    suggestedOrder: { instrument: "Au99.99", side: "buy", signalPrice: 946, cmbEstimatedPrice: 948, grams: 10 },
  }, config, "zh");
  assert.match(message.body, /Au99\.99 现价 948 元\/克/);
  assert.match(message.body, /招行买入价 950 元\/克/);
  assert.match(message.body, /建议挂单买入 10克/);
  assert.match(message.body, /挂单价 948 元\/克/);
  assert.match(message.body, /卖出目标价 956 元\/克/);
});

test("live CMB buy alert shows current price, not the lower suggested limit price", () => {
  const message = buildAlertMessage({
    action: "add_position",
    cmbLive: true,
    signalPrice: 950.78,
    cmbEstimatedPrice: 945.78,
    targetPrice: 945.85,
    suggestedOrder: { instrument: "CMB", side: "buy", cmbLive: true, signalPrice: 947.48, cmbEstimatedPrice: 947.48, grams: 10 },
  }, DEFAULT_CONFIG, "zh");
  assert.match(message.body, /招行积存金 现价 950\.78 元\/克/);
  assert.match(message.body, /招行买入价 950\.78 元\/克/);
  assert.match(message.body, /建议挂单买入 10克/);
  assert.match(message.body, /挂单价 947\.48 元\/克/);
  assert.match(message.body, /卖出目标价 945\.85 元\/克/);
  assert.doesNotMatch(message.body, /现价 947\.48/);
});

test("order change message tells user to cancel a previous buy order", () => {
  const message = buildOrderChangeMessage({
    action: "wait",
    signalPrice: 980,
  }, {
    side: "buy",
    action: "buy_setup",
    instrument: "CMB",
    cmbEstimatedPrice: 972.97,
    grams: 10,
  }, "cancel", DEFAULT_CONFIG, "zh");
  assert.equal(message.action, "cancel_order");
  assert.match(message.body, /请撤销原买入挂单 10克/);
  assert.match(message.body, /原挂单价 972\.97 元\/克/);
  assert.match(message.body, /当前建议：暂时没有合适机会/);
});

test("order change message tells user when a suggestion is updated", () => {
  const oldOrder = {
    side: "buy",
    action: "buy_setup",
    instrument: "CMB",
    cmbEstimatedPrice: 972.97,
    grams: 10,
  };
  const newPlan = {
    action: "buy_setup",
    signalPrice: 980,
    targetPrice: 988,
    suggestedOrder: {
      side: "buy",
      action: "buy_setup",
      instrument: "CMB",
      cmbEstimatedPrice: 974.2,
      grams: 10,
    },
  };
  const message = buildOrderChangeMessage(newPlan, oldOrder, "update", DEFAULT_CONFIG, "zh");
  assert.equal(message.action, "order_updated");
  assert.match(message.body, /原买入挂单 10克已更新/);
  assert.match(message.body, /原挂单价 972\.97 元\/克/);
  assert.match(message.body, /新挂单价 974\.2 元\/克/);
});

test("sameSuggestedOrder ignores rolling validUntil and detects price changes", () => {
  const a = {
    side: "buy",
    action: "buy_setup",
    instrument: "CMB",
    cmbEstimatedPrice: 972.97,
    grams: 10,
    validUntil: "2026-08-15T01:50:00+08:00",
  };
  const b = {
    ...a,
    validUntil: "2026-08-15T02:00:00+08:00",
  };
  assert.equal(sameSuggestedOrder(a, b), true);
  assert.equal(sameSuggestedOrder(a, { ...b, cmbEstimatedPrice: 974.2 }), false);
  assert.equal(sameSuggestedOrder(a, null), false);
});

// ── v1.9.0: suggested-order lifecycle (hold instead of instant cancel) ──────

const ORDER_NOW = new Date("2026-08-13T17:40:00Z");
// Anchored to the real clock: runAlertEvaluation classifies with `new Date()`,
// so a hard-coded future stamp would silently count as expired one day.
const FUTURE_VALID = new Date(Date.now() + 60 * 60_000).toISOString();

function buyOrder(overrides = {}) {
  return {
    side: "buy",
    action: "buy_setup",
    instrument: "XAU",
    signalPrice: 949,
    cmbEstimatedPrice: 950.7,
    grams: 10,
    validUntil: FUTURE_VALID,
    issuedAt: new Date(ORDER_NOW.getTime() - 60_000).toISOString(),
    issuedPositionGrams: 0,
    ...overrides,
  };
}

test("classifyOrderTransition holds the order through benign wait evaluations", () => {
  const plan = { action: "wait", reasonCodes: ["cooldown_active"], marketState: "open", signalPrice: 950 };
  // Cooldown / confirmation flip right after issuance: |950 − 949| = 1 CNY/g is
  // far below the default 0.5 % drift threshold (≈4.75) → hold, never cancel.
  assert.equal(classifyOrderTransition({ previousOrder: buyOrder(), currentOrder: null, plan, now: ORDER_NOW }).event, "hold");
  const dataGap = { action: "data_incomplete", reasonCodes: ["data_incomplete_30m"], marketState: "open", signalPrice: 951 };
  assert.equal(classifyOrderTransition({ previousOrder: buyOrder(), currentOrder: null, plan: dataGap, now: ORDER_NOW }).event, "hold");
});

test("classifyOrderTransition reaffirms near-identical re-suggestions as refresh", () => {
  const plan = { action: "buy_setup", marketState: "open", signalPrice: 950 };
  const current = { ...buyOrder(), cmbEstimatedPrice: 951.0, validUntil: "2026-08-13T19:00:00.000Z" };
  assert.ok(Math.abs(951.0 - 950.7) < ORDER_UPDATE_MIN_DELTA_PER_GRAM);
  assert.equal(classifyOrderTransition({ previousOrder: buyOrder(), currentOrder: current, plan, now: ORDER_NOW }).event, "refresh");
  assert.equal(sameSuggestedOrder(buyOrder(), current), false, "sanity: raw comparator would call it an update");
});

test("classifyOrderTransition updates on material price/grams/side changes", () => {
  const plan = { action: "buy_setup", marketState: "open", signalPrice: 950 };
  assert.equal(
    classifyOrderTransition({ previousOrder: buyOrder(), currentOrder: { ...buyOrder(), cmbEstimatedPrice: 953 }, plan, now: ORDER_NOW }).event,
    "update",
  );
  assert.equal(
    classifyOrderTransition({ previousOrder: buyOrder(), currentOrder: { ...buyOrder(), grams: 6 }, plan, now: ORDER_NOW }).event,
    "update",
  );
  assert.equal(
    classifyOrderTransition({ previousOrder: buyOrder(), currentOrder: { ...buyOrder(), side: "sell", action: "sell_take_profit" }, plan, now: ORDER_NOW }).event,
    "update",
  );
});

test("classifyOrderTransition cancels only on conflict/supersede and drift", () => {
  // Opposite-direction emergency exit while a buy order stands.
  const stop = { action: "sell_stop", marketState: "open", signalPrice: 900 };
  assert.deepEqual(classifyOrderTransition({ previousOrder: buyOrder(), currentOrder: null, plan: stop, now: ORDER_NOW }), { event: "cancel", cause: "conflict" });
  // Same-side directional evaluation without a fresh order (e.g. no_budget).
  const superseded = { action: "buy_setup", marketState: "open", signalPrice: 950 };
  assert.deepEqual(classifyOrderTransition({ previousOrder: buyOrder(), currentOrder: null, plan: superseded, now: ORDER_NOW }), { event: "cancel", cause: "superseded" });
  // Market drifted ≥ orderRepricePct away from the limit.
  const drifted = { action: "wait", reasonCodes: ["trigger_not_confirmed"], marketState: "open", signalPrice: 956 };
  assert.equal(classifyOrderTransition({ previousOrder: buyOrder(), currentOrder: null, plan: drifted, now: ORDER_NOW }).event, "cancel_drift");
  // A tighter custom threshold drifts at the same distance.
  const waitPlan = { action: "wait", marketState: "open", signalPrice: 950 };
  assert.equal(
    classifyOrderTransition({ previousOrder: buyOrder(), currentOrder: null, plan: waitPlan, repricePct: 0.05, now: ORDER_NOW }).event,
    "cancel_drift",
    "|950−949|=1 ≥ 949×0.05%",
  );
});

test("classifyOrderTransition clears silently on fill, expiry and close", () => {
  assert.equal(classifyOrderTransition({ previousOrder: buyOrder(), currentOrder: null, plan: { action: "wait", marketState: "open" }, positionGrams: 12, now: ORDER_NOW }).event, "clear_fill");
  assert.equal(
    classifyOrderTransition({ previousOrder: buyOrder({ side: "sell", action: "sell_take_profit", issuedPositionGrams: 10 }), currentOrder: null, plan: { action: "wait", marketState: "open" }, positionGrams: 6, now: ORDER_NOW }).event,
    "clear_fill",
  );
  assert.equal(
    classifyOrderTransition({ previousOrder: buyOrder({ validUntil: new Date(Date.now() - 60_000).toISOString() }), currentOrder: null, plan: { action: "wait", marketState: "open", signalPrice: 949 }, now: new Date() }).event,
    "clear_expired",
  );
  assert.equal(classifyOrderTransition({ previousOrder: buyOrder(), currentOrder: null, plan: { action: "market_closed", marketState: "closed" }, now: ORDER_NOW }).event, "clear_closed");
  // No fill detection without a recorded baseline (legacy stored orders).
  assert.equal(
    classifyOrderTransition({ previousOrder: buyOrder({ issuedPositionGrams: undefined }), currentOrder: null, plan: { action: "wait", marketState: "open", signalPrice: 949 }, positionGrams: 999, now: ORDER_NOW }).event,
    "hold",
  );
});

function alertHarness(plan, order, config = {}) {
  const runtime = {
    plan,
    config: normalizeConfig(config),
    localeHint: "zh",
    alertState: {},
    lastSuggestedOrder: order,
  };
  const dispatched = [];
  return {
    runtime,
    dispatched,
    io: {
      async dispatchAlert(message) { dispatched.push(message); return []; },
      async logAlert() {},
    },
  };
}

test("runAlertEvaluation keeps the suggestion through cooldown waits without cancel prompts", async () => {
  const plan = { action: "wait", reasonCodes: ["cooldown_active"], marketState: "open", signalPrice: 950 };
  const { runtime, dispatched, io } = alertHarness(plan, buyOrder());
  await runAlertEvaluation(runtime, io);
  assert.equal(dispatched.length, 0, "no cancel/update alert while the order merely waits to fill");
  assert.ok(runtime.lastSuggestedOrder, "outstanding suggestion survives the wait tick");
});

test("runAlertEvaluation sends one drift-cancel notice with the deviation note", async () => {
  const plan = { action: "wait", reasonCodes: ["trigger_not_confirmed"], marketState: "open", signalPrice: 956 };
  const first = alertHarness(plan, buyOrder());
  await runAlertEvaluation(first.runtime, first.io);
  assert.equal(first.dispatched.length, 1);
  assert.equal(first.dispatched[0].action, "cancel_order");
  assert.match(first.dispatched[0].body, /已偏离原挂单价/);
  assert.match(first.dispatched[0].body, /现价 956 元\/克/);
  assert.equal(first.runtime.lastSuggestedOrder, null);
  // Second identical tick: nothing left to cancel → no repeat.
  await runAlertEvaluation(first.runtime, first.io);
  assert.equal(first.dispatched.length, 1);
});

test("runAlertEvaluation clears the order silently when the position filled", async () => {
  const plan = { action: "wait", reasonCodes: ["trigger_not_confirmed"], marketState: "open", signalPrice: 950 };
  const { runtime, dispatched, io } = alertHarness(plan, buyOrder(), { position: { lots: [{ id: "a", grams: 12, price: 950.7 }] } });
  await runAlertEvaluation(runtime, io);
  assert.equal(dispatched.length, 0, "fill detection never spams the user");
  assert.equal(runtime.lastSuggestedOrder, null);
});

test("runAlertEvaluation records issuance stamps for brand-new suggestions", async () => {
  const order = { side: "buy", action: "buy_setup", instrument: "XAU", signalPrice: 949, cmbEstimatedPrice: 950.7, grams: 10 };
  const plan = { action: "buy_setup", marketState: "open", signalPrice: 948, suggestedOrder: order };
  const { runtime, dispatched, io } = alertHarness(plan, null);
  await runAlertEvaluation(runtime, io);
  assert.equal(dispatched.length, 1, "new suggestion still fires its edge alert");
  assert.equal(runtime.lastSuggestedOrder.side, "buy");
  assert.equal(runtime.lastSuggestedOrder.issuedPositionGrams, 0, "baseline captured for fill detection");
  assert.ok(typeof runtime.lastSuggestedOrder.issuedAt === "string");
});

// ── v1.9.x: same-shape repricing storms are damped ──────────────────────────
// Observed 2026-08-25 01:44–02:00: a live sell-side suggestion re-alerted
// `order_updated` ~35 times in 16 minutes because every CMB tick moved the
// suggested limit ≥ ORDER_UPDATE_MIN_DELTA_PER_GRAM. Same-shape repricing must
// stay silent inside a quiet window and only escalate on large cumulative drift.

function sellOrder(overrides = {}) {
  return buyOrder({
    side: "sell",
    action: "sell_take_profit",
    cmbEstimatedPrice: 1000,
    issuedAt: new Date(ORDER_NOW.getTime() - 5 * 60_000).toISOString(),
    ...overrides,
  });
}

test("classifyOrderTransition damps same-shape repricing inside the quiet window", () => {
  const plan = { action: "sell_take_profit", marketState: "open", signalPrice: 1005 };
  // Stamped 60s ago: jitter +0.6 (≥ reaffirm step) is adopted silently.
  const prev = sellOrder({ updatedAt: new Date(ORDER_NOW.getTime() - 60_000).toISOString(), alertedPrice: 1000 });
  const jittered = { ...prev, cmbEstimatedPrice: 1000.6 };
  assert.equal(
    classifyOrderTransition({ previousOrder: prev, currentOrder: jittered, plan, now: ORDER_NOW }).event,
    "refresh",
    "quiet-window repricing below the escalation drift never alerts",
  );
  // Cumulative drift from the LAST NOTIFIED price escalates immediately.
  assert.equal(
    classifyOrderTransition({ previousOrder: prev, currentOrder: { ...prev, cmbEstimatedPrice: 997 }, plan, now: ORDER_NOW }).event,
    "update",
    "|997 − 1000| = 3 CNY/g reaches the escalation threshold",
  );
});

test("classifyOrderTransition notifies again once the quiet window has elapsed", () => {
  const plan = { action: "sell_take_profit", marketState: "open", signalPrice: 1005 };
  const prev = sellOrder({ updatedAt: new Date(ORDER_NOW.getTime() - 11 * 60_000).toISOString(), alertedPrice: 1000 });
  assert.equal(
    classifyOrderTransition({ previousOrder: prev, currentOrder: { ...prev, cmbEstimatedPrice: 1000.6 }, plan, now: ORDER_NOW }).event,
    "update",
    "past the quiet interval even a modest step notifies",
  );
});

test("classifyOrderTransition still updates legacy orders without damping stamps", () => {
  // Orders stored before v1.9.x carry no updatedAt/alertedPrice; behaviour for
  // them is unchanged (notify), and the first stamp re-arms damping.
  const plan = { action: "buy_setup", marketState: "open", signalPrice: 950 };
  assert.equal(
    classifyOrderTransition({ previousOrder: buyOrder(), currentOrder: { ...buyOrder(), cmbEstimatedPrice: 953 }, plan, now: ORDER_NOW }).event,
    "update",
  );
});

test("runAlertEvaluation caps a repricing storm at one notice per quiet window", async () => {
  const mkPlan = (price) => ({
    action: "sell_take_profit",
    reasonCodes: ["target_reached"],
    marketState: "open",
    signalPrice: 1005,
    suggestedOrder: {
      side: "sell", action: "sell_take_profit", instrument: "XAU", signalPrice: 1005,
      cmbEstimatedPrice: price, grams: 6, validUntil: FUTURE_VALID,
    },
  });
  const harness = alertHarness(mkPlan(1000), null);
  await runAlertEvaluation(harness.runtime, harness.io); // initial edge alert + stamp
  assert.equal(harness.dispatched.length, 1);
  const stamped = harness.runtime.lastSuggestedOrder;
  assert.ok(stamped.updatedAt && Number.isFinite(Number(stamped.alertedPrice)), "issuance stamps include updatedAt/alertedPrice");

  harness.runtime.plan = mkPlan(1000.6);
  await runAlertEvaluation(harness.runtime, harness.io); // +0.6 → damped refresh
  harness.runtime.plan = mkPlan(999.9);
  await runAlertEvaluation(harness.runtime, harness.io); // −0.7 → damped refresh
  assert.equal(harness.dispatched.length, 1, "jitter inside the quiet window stays silent");
  assert.equal(harness.runtime.lastSuggestedOrder.alertedPrice, 1000, "notified price pinned across silent refreshes");
  assert.equal(harness.runtime.lastSuggestedOrder.updatedAt, stamped.updatedAt, "quiet-window origin preserved");

  harness.runtime.plan = mkPlan(996.8);
  await runAlertEvaluation(harness.runtime, harness.io); // |Δ| = 3.2 vs notified → escalate
  assert.equal(harness.dispatched.length, 2);
  assert.equal(harness.dispatched[1].action, "order_updated");
  assert.equal(harness.runtime.lastSuggestedOrder.cmbEstimatedPrice, 996.8);
  assert.equal(harness.runtime.lastSuggestedOrder.alertedPrice, 996.8, "escalation re-pins the notified price");
});

// ── v1.9.0: session-end forced close is opt-in ──────────────────────────────

function nearCloseRuntime(now) {
  return {
    quotes: {
      AU9999: { price: 946, bid: 945.8, ask: 946.2, source: "sina", updatedAt: now.getTime() },
      XAU: { price: 4357, source: "tencent", updatedAt: now.getTime() },
      USDCNY: { price: 6.74, source: "tencent", updatedAt: now.getTime() },
    },
    bars: {
      AU9999: { 1: [], 5: [], 60: [] },
      XAU: { 1: oneMinBars(now, 60), 5: [], 60: [] },
    },
  };
}

test("last 30 minutes no longer force close_by_session_end by default", () => {
  // 01:40 Beijing (20 minutes before the 26:00 close).
  const now = new Date("2026-08-13T17:40:00Z");
  const config = normalizeConfig({
    position: { grams: 10, avgCostPerGram: 945 },
    limits: { maxGrams: 100 },
    strategy: { confirmBars: 1, signalCooldownMinutes: 0 },
  });
  const plan = computePlan(nearCloseRuntime(now), config, now);
  assert.notEqual(plan.action, "close_by_session_end", "default config has no intraday-close bias");
  assert.ok(!plan.reasonCodes.includes("session_ending"));
});

test("opting in restores the pre-close full-close nudge", () => {
  const now = new Date("2026-08-13T17:40:00Z");
  const config = normalizeConfig({
    position: { grams: 10, avgCostPerGram: 945 },
    limits: { maxGrams: 100 },
    strategy: { confirmBars: 1, signalCooldownMinutes: 0, closeBySessionEnd: true, maxLossPerGram: 100 },
  });
  const plan = computePlan(nearCloseRuntime(now), config, now);
  assert.equal(plan.action, "close_by_session_end");
  assert.ok(plan.reasonCodes.includes("session_ending"));
  assert.equal(plan.suggestedOrder.side, "sell");
});

// ── v1.9.0: persisted quotes survive host restarts (no "-" board after boot) ─

test("restoreRuntimeState folds last known quotes back into the runtime", () => {
  const runtime = { quotes: { AU9999: null, XAU: null, GCF: null, USDCNY: null, CMB: null } };
  const at = Date.now() - 60_000;
  restoreRuntimeState(runtime, {
    quotes: {
      AU9999: { price: 1001, bid: 1000.8, ask: 1001.2, source: "sina", updatedAt: at },
      XAU: { price: 4640.39, source: "tencent", updatedAt: at },
      USDCNY: { price: 6.7214, source: "tencent", updatedAt: at },
      CMB: null,
      // Error markers written by setQuoteError must not resurrect as zero rows.
      GCF: { price: 0, source: "error", error: true, stale: true, updatedAt: at },
    },
  });
  assert.equal(runtime.quotes.AU9999.price, 1001);
  assert.equal(runtime.quotes.XAU.price, 4640.39);
  assert.equal(runtime.quotes.USDCNY.price, 6.7214);
  assert.equal(runtime.quotes.CMB, null);
  assert.equal(runtime.quotes.GCF, null, "zero/error markers are dropped");
});

test("a restarted host renders numbers instead of dashes on the first snapshot", () => {
  const runtime = { quotes: { AU9999: null, XAU: null, GCF: null, USDCNY: null, CMB: null } };
  restoreRuntimeState(runtime, {
    quotes: {
      XAU: { price: 4640.39, market: "spot", instrument: "XAU", source: "tencent", updatedAt: Date.now() - 30_000 },
      USDCNY: { price: 6.7214, source: "tencent", updatedAt: Date.now() - 30_000 },
    },
  });
  const snap = buildSnapshot(runtime, DEFAULT_CONFIG, new Date());
  assert.equal(snap.ok, true);
  assert.equal(snap.quotes.XAU.price, 4640.39);
  assert.equal(
    snap.derived && snap.derived.cmb && Number.isFinite(Number(snap.derived.cmb.buyPrice)),
    true,
    "the CMB fallback estimate works immediately after a restart",
  );
});



test("client dictionaries keep zh/en key parity", () => {
  const code = readFileSync(new URL("../lib/client.js", import.meta.url), "utf8");
  let captured;
  const windowStub = { __ModuleLoader__: { load(spec) { captured = spec; } } };
  const FunctionConstructor = globalThis.Function;
  const compiled = new FunctionConstructor("window", code);
  compiled(windowStub);
  assert.ok(captured, "client bundle is captured");

  const style = {
    setAttribute() {},
    dataset: {},
    textContent: "",
  };
  const documentStub = {
    querySelector() { return null; },
    createElement() { return style; },
    head: { appendChild() {} },
  };
  const requireStub = function (id) {
    // plan-05: the factory now calls React.memo at module scope (Sparkline).
    if (id === "react") return { createElement: function () {}, memo: (fn) => fn };
    throw new Error("unexpected require: " + id);
  };
  const clientExports = captured.factory(requireStub);
  // The factory runs CSS injection only when `document` exists in the real
  // browser; the captured DICT is available for parity checks either way.
  assert.ok(clientExports.DICT);
  const zhKeys = Object.keys(clientExports.DICT.zh).sort();
  const enKeys = Object.keys(clientExports.DICT.en).sort();
  assert.deepEqual(zhKeys, enKeys);
  assert.equal(clientExports.name, "dsh-plugin-goldboard");

  const registrations = [];
  const slotsStub = {
    register(entry, component) { return { entry, component }; },
    inject(slot, factory) {
      registrations.push({ slot, registered: factory() });
      return () => {};
    },
  };
  const localeStub = {
    bind: () => (key) => key,
    register: () => () => {},
  };
  const ctxStub = {
    get(id) {
      if (id === "slots") return slotsStub;
      if (id === "locale") return localeStub;
      return undefined;
    },
    effect(fn) { fn(); return () => {}; },
  };
  clientExports.apply(ctxStub);
  assert.deepEqual(registrations.map((entry) => entry.slot), ["shell.overlay", "settings.section"]);
  assert.equal(registrations[0].registered.entry.id, "dsh-plugin-goldboard-board");
  assert.equal(registrations[1].registered.entry.id, "dsh-plugin-goldboard");
  assert.equal(registrations[1].registered.entry.order, 72);
});

// ── plan-01 §01.1: 60m bucket aggregation + seed-version migration ─────────

/** Twelve 5m sub-bars for one hour; OHLC varies deterministically per bar. */
function fiveMinuteHour(hourStartMs, hourIndex) {
  const bars = [];
  for (let j = 0; j < 12; j += 1) {
    const t = hourStartMs + j * 5 * 60_000;
    const o = hourIndex * 100 + 10 + j;
    const c = o + 5;
    bars.push({ t, o, h: c + 2, l: o - 1, c });
  }
  return bars;
}

test("aggregateSubBars builds true OHLC hour buckets and skips the open hour", () => {
  const meta = { source: "eastmoney", instrument: "Au99.99", market: "sge", currency: "CNY", unit: "gram" };
  // 09:00–12:00 Beijing: three complete hours plus one in progress.
  const hour0 = Date.parse("2026-08-14T01:00:00Z");
  const now = Date.parse("2026-08-14T04:00:00Z"); // 12:00 Beijing, hour 3 just opened
  const klines = [
    ...fiveMinuteHour(hour0, 0),
    ...fiveMinuteHour(hour0 + 60 * 60_000, 1),
    ...fiveMinuteHour(hour0 + 2 * 60 * 60_000, 2),
    ...fiveMinuteHour(hour0 + 3 * 60 * 60_000, 3).slice(0, 4), // in-progress hour
  ];
  const list = [];
  aggregateSubBars(list, klines, 60, meta, now);
  assert.equal(list.length, 3, "in-progress hour excluded");
  for (let hour = 0; hour < 3; hour += 1) {
    const bar = list[hour];
    const t = hour0 + hour * 60 * 60_000;
    assert.equal(bar.t, t);
    assert.equal(bar.o, hour * 100 + 10, "open = first sub-bar open");
    assert.equal(bar.c, hour * 100 + 21 + 5, "close = last sub-bar close");
    assert.equal(bar.h, hour * 100 + 21 + 5 + 2, "high = max sub-bar high");
    assert.equal(bar.l, hour * 100 + 10 - 1, "low = min sub-bar low");
    assert.equal(bar.synthetic, false);
    assert.equal(bar.source, "eastmoney");
    assert.equal(bar.instrument, "Au99.99");
    assert.equal(bar.market, "sge");
    assert.equal(bar.currency, "CNY");
    assert.equal(bar.unit, "gram");
  }
});

test("aggregateSubBars overwrites corrupt buckets but keeps uncovered tick bars", () => {
  const hour0 = Date.parse("2026-08-14T01:00:00Z");
  const now = hour0 + 60 * 60_000; // first hour complete, second in progress
  const klines = fiveMinuteHour(hour0, 0);
  // Pre-existing state: a corrupt bucket (last sub-bar OHLC only, as v1.2.x
  // seedBars produced) plus a tick-built synthetic bucket in a later hour.
  const corrupt = { t: hour0, o: 21, h: 28, l: 20, c: 26, synthetic: false, source: "eastmoney" };
  const tickBucket = { t: hour0 + 2 * 60 * 60_000, o: 999, h: 999, l: 999, c: 999, synthetic: true };
  const list = [corrupt, tickBucket];
  aggregateSubBars(list, klines, 60, { source: "eastmoney" }, now);
  assert.equal(list.length, 2, "uncovered tick bucket preserved");
  assert.equal(list[0].o, 10, "corrupt bucket re-aggregated from sub-bars");
  assert.equal(list[0].h, 28, "aggregated high covers all 12 sub-bars");
  assert.equal(list[0].l, 9);
  assert.equal(list[0].c, 26);
  assert.deepEqual(list[1], tickBucket);
});

test("seedBars merges 5m klines directly and aggregates the 60m lane", () => {
  const hour0 = Date.parse("2026-08-14T01:00:00Z");
  const now = hour0 + 3 * 60 * 60_000;
  const klines = [
    ...fiveMinuteHour(hour0, 0),
    ...fiveMinuteHour(hour0 + 60 * 60_000, 1),
    ...fiveMinuteHour(hour0 + 2 * 60 * 60_000, 2),
  ];
  const bars = { 5: [], 60: [] };
  seedBars(bars, klines, { source: "eastmoney", instrument: "Au99.99" }, now);
  assert.equal(bars[5].length, 36, "5m lane keeps one bar per sub-bar");
  assert.equal(bars[60].length, 3, "60m lane holds one aggregated bucket per hour");
  assert.equal(bars[60][1].o, 110);
  assert.equal(bars[60][1].c, 126);
});

test("migrateBarsSeedVersion drops stale [5]/[60] lanes and preserves the rest", () => {
  const bars = {
    AU9999: { 1: [{ t: 1, o: 1, h: 1, l: 1, c: 1 }], 5: [{ t: 2, o: 1, h: 1, l: 1, c: 1 }], 60: [{ t: 3, o: 1, h: 1, l: 1, c: 1 }], 1440: [{ t: 4, o: 1, h: 1, l: 1, c: 1 }] },
    XAU: { 5: [{ t: 5, o: 1, h: 1, l: 1, c: 1 }], 60: [{ t: 6, o: 1, h: 1, l: 1, c: 1 }] },
    GCF: { 1440: [{ t: 7, o: 1, h: 1, l: 1, c: 1 }] },
    CMB: { 1: [{ t: 8, o: 1, h: 1, l: 1, c: 1 }], 5: [{ t: 9, o: 1, h: 1, l: 1, c: 1 }] },
  };
  assert.equal(BARS_SEED_VERSION, 2);
  // Missing version field (pre-v1.3.1 state) → migrate.
  assert.equal(migrateBarsSeedVersion(bars, undefined), true);
  assert.deepEqual(bars.AU9999[5], []);
  assert.deepEqual(bars.AU9999[60], []);
  assert.equal(bars.AU9999[1].length, 1, "other intervals preserved");
  assert.equal(bars.AU9999[1440].length, 1);
  assert.deepEqual(bars.XAU[5], []);
  assert.deepEqual(bars.XAU[60], []);
  assert.equal(bars.GCF[1440].length, 1, "GCF lane untouched");
  assert.equal(bars.CMB[5].length, 1, "CMB lane untouched");

  // Old version number → migrate too.
  const old = { AU9999: { 5: [{ t: 1, o: 1, h: 1, l: 1, c: 1 }], 60: [] }, XAU: { 5: [], 60: [] } };
  assert.equal(migrateBarsSeedVersion(old, 1), true);
  assert.deepEqual(old.AU9999[5], []);

  // Current version → keep everything.
  const fresh = { AU9999: { 5: [{ t: 1, o: 1, h: 1, l: 1, c: 1 }], 60: [{ t: 2, o: 1, h: 1, l: 1, c: 1 }] }, XAU: { 5: [], 60: [] } };
  assert.equal(migrateBarsSeedVersion(fresh, BARS_SEED_VERSION), false);
  assert.equal(fresh.AU9999[5].length, 1);
  assert.equal(fresh.AU9999[60].length, 1);
});

// ── plan-01 §01.4: confirmBars counts closed bars, resets on signal-set end ─

function policyPlan(action, { signalBarT = null, instrument = "Au99.99", marketState = "open" } = {}) {
  return {
    action,
    instrument,
    marketState,
    signalPrice: 950,
    grams: 0,
    reasonCodes: [],
    suggestedOrder: null,
    ...(signalBarT !== null ? { signalBarT } : {}),
  };
}

const POLICY_CFG = normalizeConfig({ strategy: { confirmBars: 2, signalCooldownMinutes: 0 } });
const BAR_T0 = Date.parse("2026-08-14T01:05:00Z");
const BAR_T1 = BAR_T0 + 5 * 60_000;
const BAR_T2 = BAR_T0 + 10 * 60_000;

test("applySignalPolicy counts each closed 5m bar once, firing on the second bar", () => {
  let state = defaultSignalState();
  const first = applySignalPolicy(policyPlan("buy_setup", { signalBarT: BAR_T0 }), state, POLICY_CFG, new Date(BAR_T0));
  assert.equal(first.plan.action, "wait");
  assert.ok(first.plan.reasonCodes.includes("signal_confirming"));
  assert.equal(first.signalState.buyStreak, 1);
  assert.equal(first.signalState.lastBarT.buy, BAR_T0);

  // Re-evaluation 30s later, still the same closed bar: no double count.
  const repeat = applySignalPolicy(policyPlan("buy_setup", { signalBarT: BAR_T0 }), first.signalState, POLICY_CFG, new Date(BAR_T0 + 30_000));
  assert.equal(repeat.plan.action, "wait");
  assert.equal(repeat.signalState.buyStreak, 1);

  // Second distinct closed bar: streak reaches confirmBars → fired.
  const second = applySignalPolicy(policyPlan("buy_setup", { signalBarT: BAR_T1 }), repeat.signalState, POLICY_CFG, new Date(BAR_T1));
  assert.equal(second.plan.action, "buy_setup");
  assert.ok(!second.plan.reasonCodes.includes("signal_confirming"), "confirmation no longer pending");
  assert.equal(second.signalState.buyStreak, 2);
  assert.equal(second.signalState.lastBarT.buy, BAR_T1);
});

test("applySignalPolicy resets both streaks when the action leaves the direction set", () => {
  const state = { ...defaultSignalState(), buyStreak: 1, sellStreak: 2, lastBarT: { buy: BAR_T0, sell: BAR_T0 } };
  const waited = applySignalPolicy(policyPlan("wait", { signalBarT: BAR_T1 }), state, POLICY_CFG, new Date(BAR_T1));
  assert.equal(waited.signalState.buyStreak, 0);
  assert.equal(waited.signalState.sellStreak, 0);
  assert.deepEqual(waited.signalState.lastBarT, { buy: null, sell: null });
  // A later isolated buy signal starts counting from scratch instead of
  // riding the stale streak.
  const revived = applySignalPolicy(policyPlan("buy_setup", { signalBarT: BAR_T2 }), waited.signalState, POLICY_CFG, new Date(BAR_T2));
  assert.equal(revived.signalState.buyStreak, 1);
  assert.equal(revived.plan.action, "wait");
});

test("applySignalPolicy resets streaks on signal-instrument switch and market close", () => {
  const state = { ...defaultSignalState(), buyStreak: 1, lastBarT: { buy: BAR_T0, sell: null }, instrument: "Au99.99" };
  const switched = applySignalPolicy(policyPlan("buy_setup", { signalBarT: BAR_T1, instrument: "CMB" }), state, POLICY_CFG, new Date(BAR_T1));
  assert.equal(switched.signalState.instrument, "CMB");
  assert.equal(switched.signalState.buyStreak, 1, "count restarts on the new instrument");
  assert.equal(switched.plan.action, "wait");

  const closed = applySignalPolicy(
    policyPlan("market_closed", { instrument: "CMB", marketState: "closed" }),
    { ...defaultSignalState(), buyStreak: 3, sellStreak: 1, lastBarT: { buy: BAR_T0, sell: BAR_T0 }, instrument: "CMB" },
    POLICY_CFG,
    new Date(BAR_T1),
  );
  assert.equal(closed.signalState.buyStreak, 0);
  assert.equal(closed.signalState.sellStreak, 0);
  assert.deepEqual(closed.signalState.lastBarT, { buy: null, sell: null });
});

test("applySignalPolicy keeps sell-side counting independent of the buy clock", () => {
  const state = { ...defaultSignalState(), instrument: "Au99.99", buyStreak: 2, lastBarT: { buy: BAR_T1, sell: null } };
  // sell_stop is emergency-class: it skips confirmation and fires immediately.
  const sell = applySignalPolicy(policyPlan("sell_stop", { signalBarT: BAR_T0 }), state, POLICY_CFG, new Date(BAR_T0 + 30_000));
  assert.equal(sell.plan.action, "sell_stop");
  assert.equal(sell.signalState.buyStreak, 0, "opposite streak cleared on fire");
  assert.equal(sell.signalState.sellStreak, 1, "sell side counts its own bar clock");
  assert.equal(sell.signalState.lastBarT.buy, BAR_T1, "buy clock untouched");
  assert.equal(sell.signalState.lastBarT.sell, BAR_T0);
});

// ── plan-02: performance & resource ────────────────────────────────────────

/** Beijing wall-clock "YYYY-MM-DD HH:MM:SS" for a fresh timestamp (SGE `times` field). */
function beijingNowString(now = new Date()) {
  const iso = new Date(now.getTime() + 8 * 60 * 60 * 1000).toISOString();
  return `${iso.slice(0, 10)} ${iso.slice(11, 19)}`;
}

test("rotateApiLogIfNeeded rotates oversized logs and keeps one generation", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "goldboard-apilog-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const file = join(dir, "api-log.jsonl");

  // Small file below the threshold: no rotation.
  await writeFile(file, "{\"id\":1}\n", "utf8");
  assert.equal(await rotateApiLogIfNeeded(file, 1024), false);
  assert.equal(await readFile(file, "utf8"), "{\"id\":1}\n");

  // Oversized file: renamed to `.1`, original gone, previous `.1` overwritten.
  await rm(`${file}.1`, { force: true });
  await writeFile(`${file}.1`, "old generation\n", "utf8");
  await writeFile(file, "x".repeat(2048), "utf8");
  assert.equal(await rotateApiLogIfNeeded(file, 1024), true);
  assert.equal(await readFile(`${file}.1`, "utf8"), "x".repeat(2048));
  await assert.rejects(() => readFile(file), { code: "ENOENT" });

  // Missing file: a no-op, not a throw.
  assert.equal(await rotateApiLogIfNeeded(file, 1024), false);
});

test("readApiLogsFromFile tail-reads large logs and tolerates a torn first line", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "goldboard-apilog-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const file = join(dir, "api-log.jsonl");

  // A torn head line (as if the tail window started mid-JSON) followed by
  // 600 padded entries (~300KB total > the 256KB tail window).
  let body = '{"torn": tru';
  for (let i = 0; i < 600; i += 1) {
    body += `\n${JSON.stringify({ id: i, ok: true, url: `https://example.com/${i}`.padEnd(420, "a") })}`;
  }
  await writeFile(file, body, "utf8");

  const logs = await readApiLogsFromFile(file);
  assert.equal(logs.length, 500, "capped at MAX_API_LOGS");
  assert.equal(logs[0].id, 599, "newest first");
  assert.equal(logs[499].id, 100, "oldest kept entry");
});

test("readApiLogsFromFile keeps small-file behaviour", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "goldboard-apilog-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const file = join(dir, "api-log.jsonl");

  await writeFile(file, '{"id":1}\nnot json\n\n{"id":2}\n', "utf8");
  const logs = await readApiLogsFromFile(file);
  assert.deepEqual(logs.map((entry) => entry.id), [2, 1], "malformed/blank lines skipped, newest first");

  assert.deepEqual(await readApiLogsFromFile(join(dir, "missing.jsonl")), []);
});

function hangingFetch(calls) {
  return function (url, options = {}) {
    const entry = { url: String(url), signal: options.signal, aborted: Boolean(options.signal?.aborted) };
    calls.push(entry);
    return new Promise((resolve, reject) => {
      const onAbort = () => {
        entry.aborted = true;
        reject(new Error("aborted"));
      };
      if (options.signal?.aborted) {
        onAbort();
        return;
      }
      options.signal?.addEventListener("abort", onAbort, { once: true });
    });
  };
}

const CHAIN_SOURCE_IDS = ["sina-domestic", "sge-domestic", "eastmoney-domestic", "sixty-domestic"];

test("quote chain budget bounds total latency and aborts in-flight requests", async () => {
  const calls = [];
  const previousFetch = __setFetchImpl(hangingFetch(calls));
  const previousTiming = __setQuoteChainTiming({ budgetMs: 600, minSourceTimeoutMs: 120 });
  for (const id of CHAIN_SOURCE_IDS) markSourceSuccess(id);
  try {
    const startedAt = Date.now();
    const quote = await fetchDomesticQuote(new Date());
    const elapsed = Date.now() - startedAt;
    assert.equal(quote, null, "all sources hang -> no quote");
    assert.ok(elapsed < 2000, `chain bounded by budget+slack, took ${elapsed}ms`);
    assert.ok(calls.length >= 2, `several sources attempted (${calls.length})`);
    assert.ok(calls.every((entry) => entry.aborted), "no request left dangling after the chain settled");
  } finally {
    __setFetchImpl(previousFetch);
    __setQuoteChainTiming(previousTiming);
    for (const id of CHAIN_SOURCE_IDS) markSourceSuccess(id);
  }
});

test("quote chain stops at the first successful source and skips the rest", async () => {
  const urls = [];
  const sgePayload = JSON.stringify({
    times: beijingNowString(),
    data: [["Au99.99", "950.00", "946.00", "954.50", "946.00", "940.72"]],
  });
  const previousFetch = __setFetchImpl(async (url) => {
    urls.push(String(url));
    if (String(url).includes("hq.sinajs.cn")) throw new Error("sina down");
    if (String(url).includes("sge.com.cn")) {
      return { ok: true, text: async () => sgePayload };
    }
    throw new Error("source after the successful one must not be called");
  });
  const previousTiming = __setQuoteChainTiming({ budgetMs: 600, minSourceTimeoutMs: 120 });
  for (const id of CHAIN_SOURCE_IDS) markSourceSuccess(id);
  try {
    const quote = await fetchDomesticQuote(new Date());
    assert.equal(quote?.source, "sge");
    assert.equal(urls.length, 2, "sina failed fast, SGE succeeded, later sources skipped");
  } finally {
    __setFetchImpl(previousFetch);
    __setQuoteChainTiming(previousTiming);
    for (const id of CHAIN_SOURCE_IDS) markSourceSuccess(id);
  }
});

test("snapshot trend arrays are capped at TREND_POINTS (1080)", () => {
  const now = Date.parse("2026-08-14T04:00:00Z"); // Beijing Friday 12:00
  // Three full sessions (Mon–Wed, 09:00 → next-day 02:00 = 1020 open minutes
  // each): 3060 in-session bars, so the 1080 cap — not the session filter —
  // decides the payload size.
  const bars = [];
  for (let day = 0; day < 3; day += 1) {
    const sessionStart = Date.parse(`2026-08-10T09:00:00+08:00`) + day * 24 * 60 * 60 * 1000;
    for (let i = 0; i < 1020; i += 1) {
      bars.push({ t: sessionStart + i * 60_000, o: 950, h: 951, l: 949, c: 950.5 });
    }
  }
  const snap = buildSnapshot({
    quotes: { AU9999: { price: 950.5, source: "test", updatedAt: now } },
    bars: { AU9999: { 1: bars }, XAU: { 1: [] }, GCF: { 1: [] }, CMB: { 1: [] } },
    plan: null,
  }, normalizeConfig({}), new Date(now));
  assert.equal(snap.trend.AU9999_1m.length, 1080);
  // The newest bar is kept; older ones are dropped from the head.
  assert.equal(snap.trend.AU9999_1m[1080 - 1].t, new Date(bars[bars.length - 1].t).toISOString());
});

test("snapshot cache decision honours the rebuild window with an injected clock", () => {
  const now = 1_000_000;
  assert.equal(snapshotCacheStale(now - 1_000, now), false, "fresh snapshot is served from cache");
  assert.equal(snapshotCacheStale(now - 3_000, now), true, "snapshot older than 2s rebuilds");
  assert.equal(snapshotCacheStale(undefined, now), true, "never-built snapshot rebuilds");
  assert.equal(snapshotCacheStale(now - 5_000, now, 10_000), true === false ? true : false, "custom window respected");
  assert.equal(snapshotCacheStale(now - 11_000, now, 10_000), true, "custom window expiry");
});

test("isOpenMinute accepts a prebuilt calendar and matches config behaviour", () => {
  const config = normalizeConfig({
    tradingHours: { open: "09:00", close: "26:00", weekdaysOnly: true, holidays: ["2026-10-01"] },
  });
  const calendar = buildSessionCalendar(config);

  const beijing = (date, time) => Date.parse(`${date}T${time}:00+08:00`);
  // Calendar vs config input stay equivalent across several days that cover
  // cross-midnight tails, a holiday and a weekend.
  const samples = [
    beijing("2026-09-30", "10:00"), // Wednesday session
    beijing("2026-10-01", "01:30"), // Tuesday-opened session's early-morning tail
    beijing("2026-10-01", "02:30"), // daily close
    beijing("2026-10-01", "10:00"), // holiday Thursday: closed all day
    beijing("2026-10-02", "10:00"), // Friday: normal session
    beijing("2026-10-03", "01:00"), // Saturday early tail of Friday's session
    beijing("2026-10-03", "10:00"), // Saturday: weekend
    beijing("2026-10-05", "01:00"), // Monday early hours: Sunday not tradeable
    beijing("2026-10-05", "09:00"), // Monday open
  ];
  for (const timestamp of samples) {
    assert.equal(isOpenMinute(calendar, timestamp), isOpenMinute(config, timestamp), `minute ${new Date(timestamp).toISOString()}`);
  }

  assert.equal(isOpenMinute(calendar, beijing("2026-10-01", "10:00")), false, "holiday excluded");
  assert.equal(isOpenMinute(calendar, beijing("2026-10-03", "10:00")), false, "weekend excluded");
  assert.equal(isOpenMinute(calendar, beijing("2026-10-02", "10:00")), true, "trading Friday open");
  assert.equal(isOpenMinute(calendar, beijing("2026-10-03", "01:00")), true, "cross-midnight tail open");
});

test("buildSessionCalendar memoizes by config identity", () => {
  const config = normalizeConfig({});
  assert.equal(buildSessionCalendar(config), buildSessionCalendar(config), "same object -> same calendar");
  assert.notEqual(buildSessionCalendar(config), buildSessionCalendar(normalizeConfig({})), "new object -> new calendar");

  const defaults = buildSessionCalendar({});
  assert.equal(defaults.openMin, 9 * 60);
  assert.equal(defaults.closeMin, 26 * 60);
  assert.equal(defaults.weekdaysOnly, true);
  assert.ok(defaults.holidaySet instanceof Set);
});

test("steady-state 30 minutes throttle state.json writes to the 5-minute rhythm", { timeout: 30_000 }, async (t) => {
  const { stat } = await import("node:fs/promises");
  const dir = await mkdtemp(join(tmpdir(), "goldboard-state-"));
  t.after(() => rm(dir, { recursive: true, force: true }));

  const sinaLine = 'var hq_str_gds_AU9999="951.50,0,949.10,952.00,954.50,946.00,12:00:00,940.72,946.00,2282,301.00,1.00,2026-08-14,沪金99";';
  const previousFetch = __setFetchImpl(async (url) => {
    if (String(url).includes("hq.sinajs.cn")) return { ok: true, arrayBuffer: async () => Buffer.from(sinaLine, "utf8"), text: async () => sinaLine };
    throw new Error("source unavailable in test");
  });
  t.after(() => __setFetchImpl(previousFetch));

  let capturedDispose;
  const effects = [];
  const ctx = {
    logger: { warn: () => {} },
    effect: (fn) => {
      const dispose = fn();
      if (typeof dispose === "function") effects.push(dispose);
      capturedDispose = dispose;
    },
  };

  // Freeze the clock at Beijing Friday 12:00 and drive the real interval.
  const startMs = Date.parse("2026-08-14T04:00:00Z");
  const clock = t.mock.timers;
  clock.enable({ apis: ["Date", "setInterval"], now: startMs });

  const stateFile = join(dir, "state.json");
  // Flushes are ≥1 minute apart (minute-anchored), so sampling the file's
  // mtime after each simulated minute counts committed writes reliably
  // (fs.watch rename events are unreliable on macOS).
  const writeTimes = new Set();
  let lastMtime = -1;
  const sampleWrite = async () => {
    try {
      const info = await stat(stateFile);
      if (info.mtimeMs !== lastMtime) {
        lastMtime = info.mtimeMs;
        writeTimes.add(info.mtimeMs);
      }
    } catch {
      // not written yet
    }
  };
  const drain = async () => {
    for (let i = 0; i < 25; i += 1) await new Promise((resolve) => setImmediate(resolve));
    await new Promise((resolve) => setTimeout(resolve, 25));
  };

  const runtime = apply(ctx, { directory: dir, pollMs: 10_000 });
  try {
    await drain(); // init + first tick
    await sampleWrite();
    for (let minute = 1; minute <= 30; minute += 1) {
      clock.tick(60_000);
      await drain();
      await sampleWrite();
    }
  } finally {
    if (typeof capturedDispose === "function") await capturedDispose();
    clock.reset();
  }

  // Expected: 1 write during init, then at most one bars flush per 5 minutes
  // anchored to whole-minute boundaries (~6 more), plus the dispose final
  // flush — well under the ~60 writes the old every-tick behaviour produced.
  assert.ok(writeTimes.size >= 2, `at least init + one throttled flush (${writeTimes.size})`);
  assert.ok(writeTimes.size <= 8, `writes bounded (${writeTimes.size} <= 8)`);
});
