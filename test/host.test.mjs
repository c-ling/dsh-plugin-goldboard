import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import {
  DEFAULT_CONFIG,
  atr,
  bollinger,
  buildAlertMessage,
  buildSnapshot,
  computeMarketState,
  computeNextMarketOpen,
  computePlan,
  coverageGate,
  mergeSecrets,
  normalizeConfig,
  parseCmbMarketCenterQuote,
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
  redactConfig,
  resampleBars,
  rsi,
  sma,
  windowCoverage,
} from "../lib/index.js";

/** Build `minutes` minute-aligned 1m bars ending at `now` (a Date or ms). */
function oneMinBars(now, minutes = 60, price = 950) {
  const end = Math.floor(new Date(now).getTime() / 60_000) * 60_000;
  const out = [];
  for (let i = 0; i < minutes; i += 1) {
    out.push({ t: end - i * 60_000, o: price, h: price, l: price, c: price });
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
  assert.equal(fallbackSnapshot.derived.cmb.sellPrice, 950.23);
  assert.equal(fallbackSnapshot.derived.cmb.sellPriceAfterFee, 945.23);
  assert.equal(fallbackSnapshot.derived.cmb.live, false);
  assert.match(fallbackSnapshot.derived.cmb.sourceNote, /国际金价/);
  assert.doesNotMatch(fallbackSnapshot.derived.cmb.sourceNote, /Au99\.99/);
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
  assert.equal(liveSnapshot.derived.cmb.sellPriceAfterFee, 955.43);
  assert.equal(liveSnapshot.derived.cmb.average, 957.93);
  assert.equal(liveSnapshot.derived.cmb.live, true);
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
  assert.equal(plan.cmbEstimatedPrice, 950.23);
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

  const bars = [
    { t: 0, o: 1, h: 3, l: 0.5, c: 2 },
    { t: 1, o: 2, h: 4, l: 1.5, c: 3 },
    { t: 2, o: 3, h: 5, l: 2, c: 4 },
  ];
  assert.ok(atr(bars, 14) > 0);
});

test("plan engine computes sell signal when target is reached", () => {
  const runtime = {
    quotes: {
      AU9999: { price: 965, bid: 964, ask: 966, source: "sina", updatedAt: Date.now() },
      XAU: { price: 4400, source: "tencent", updatedAt: Date.now() },
      USDCNY: { price: 6.74, source: "tencent", updatedAt: Date.now() },
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
      AU9999: { price: 965, bid: 964, ask: 966, source: "sina", updatedAt: Date.now() },
      XAU: { price: 4400, source: "tencent", updatedAt: Date.now() },
      USDCNY: { price: 6.74, source: "tencent", updatedAt: Date.now() },
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
  const now = Date.now();
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
  assert.equal(plan.position.feeAdjustedPnl, 254.3);
  assert.equal(plan.breakeven, 952.2);
  assert.equal(plan.signalPrice, 974.43);
  assert.equal(plan.suggestedOrder.cmbEstimatedPrice, 970.43);
  assert.equal(plan.suggestedOrder.price, 970.43);
});

test("plan engine still works with live CMB when Au99.99 is missing", () => {
  const now = Date.now();
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
      AU9999: { price: 950, bid: 949, ask: 951, source: "sina", updatedAt: Date.now() },
      XAU: { price: 4375, source: "tencent", updatedAt: Date.now() },
      USDCNY: { price: 6.74, source: "tencent", updatedAt: Date.now() },
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
    let price = base;
    for (let t = start; t <= end; t += 5 * 60_000) {
      const o = price;
      const c = price + rise;
      price = c;
      bars.push({ t, o, h: c + 0.5, l: o - 0.5, c });
    }
    return bars;
  }
  const now = Date.now();
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
        5: makeBars(now - 120 * 5 * 60_000, now, 4315, 0.5),
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
    let price = base;
    for (let t = start; t <= end; t += 5 * 60_000) {
      const o = price;
      const c = price + rise;
      price = c;
      bars.push({ t, o, h: c + 0.5, l: o - 0.5, c });
    }
    return bars;
  }
  const now = Date.now();
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
        5: makeBars(now - 120 * 5 * 60_000, now, 4315, 0.5),
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
    let price = base;
    for (let t = start; t <= end; t += 5 * 60_000) {
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
  const now = Date.now();
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
        5: makeBarsWithDrop(now - 120 * 5 * 60_000, now, 4315, 0.5, dropEnd),
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
    let price = base;
    for (let t = start; t <= end; t += 5 * 60_000) {
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
  const now = Date.now();
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
        5: makeBarsWithDrop(now - 120 * 5 * 60_000, now, 4315, 0.5, dropEnd),
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

test("plan engine resets cooldown when user position changes", () => {
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
  assert.equal(plan.action, "sell_take_profit");
  assert.equal(plan.suggestedOrder.side, "sell");
  assert.ok(!plan.reasonCodes.includes("cooldown_active"));
});

test("plan engine requires consecutive confirmation before issuing a buy signal", () => {
  function makeBars(start, end, base, rise) {
    const bars = [];
    let price = base;
    for (let t = start; t <= end; t += 5 * 60_000) {
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
      AU9999: { price: 951, bid: 950.8, ask: 951.2, source: "test", updatedAt: now.getTime() },
      XAU: { price: 4375, source: "test", updatedAt: now.getTime() },
      USDCNY: { price: 6.74, source: "test", updatedAt: now.getTime() },
    },
    bars: {
      AU9999: { 1: [], 5: [], 60: [] },
      XAU: {
        1: oneMinBars("2026-08-14T02:00:00Z", 60),
        5: makeBars(now.getTime() - 120 * 5 * 60_000, now.getTime(), 4315, 0.5),
        60: makeBars(now.getTime() - 120 * 60 * 60_000, now.getTime(), 4315, 0.5),
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
  const config = normalizeConfig({
    limits: { maxGrams: 50 },
    strategy: { confirmBars: 2, signalCooldownMinutes: 0 },
  });
  const first = computePlan(runtime, config, now);
  assert.equal(first.action, "wait");
  assert.ok(first.reasonCodes.includes("signal_confirming"));
  assert.equal(first.signalState.buyStreak, 1);

  runtime.signalState = first.signalState;
  const second = computePlan(runtime, config, now);
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

test("coverage gate requires >80% valid per-minute data in every 5/10/30/60 window", () => {
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
  // while 10/30/60 stay above 80%.
  const missingMinute = oneMinBars(now, 60).filter((bar) => bar.t !== Math.floor(now.getTime() / 60_000) * 60_000 - 2 * 60_000);
  const gateGap = coverageGate(missingMinute, now);
  assert.equal(gateGap.ok, false);
  assert.deepEqual(gateGap.failing, [5]);
  assert.equal(gateGap.coverage[10], 0.9);

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

test("resampleBars aggregates 5m bars into 10m/30m bars", () => {
  const end = Date.parse("2026-08-14T02:00:00Z"); // on both 5m and 10m boundaries
  const bars5 = [];
  for (let i = 0; i < 12; i += 1) {
    const t = end - (11 - i) * 5 * 60_000;
    bars5.push({ t, o: 940 + i, h: 942 + i, l: 939 + i, c: 941 + i });
  }
  const bars10 = resampleBars(bars5, 2);
  assert.equal(bars10.length, 6);
  assert.equal(bars10[0].t, end - 50 * 60_000);
  assert.equal(bars10[0].o, 940);
  assert.equal(bars10[0].h, 943);
  assert.equal(bars10[0].l, 939);
  assert.equal(bars10[0].c, 942);
  assert.equal(bars10[5].t, end);
  assert.equal(bars10[5].c, 952);

  const bars30 = resampleBars(bars5, 6);
  assert.equal(bars30.length, 2);
  assert.equal(bars30[0].t, end - 30 * 60_000);
  assert.equal(bars30[0].o, 940);
  assert.equal(bars30[0].h, 947);
  assert.equal(bars30[0].c, 946);
  assert.equal(bars30[1].t, end);
  assert.equal(bars30[1].o, 946);
  assert.equal(bars30[1].c, 952);
  assert.deepEqual(resampleBars([], 2), []);
});

test("plan engine withholds suggestions when per-minute coverage is below 80%", () => {
  const now = new Date("2026-08-14T02:00:00Z");
  const runtime = {
    quotes: {
      AU9999: { price: 950, bid: 949, ask: 951, source: "test", updatedAt: now.getTime() },
      XAU: { price: 4375.8, source: "test", updatedAt: now.getTime() },
      USDCNY: { price: 6.7421, source: "test", updatedAt: now.getTime() },
    },
    bars: {
      AU9999: { 1: [], 5: [], 60: [] },
      XAU: { 1: oneMinBars(now, 30), 5: [], 60: [] },
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
    let price = base;
    for (let t = start; t <= end; t += 5 * 60_000) {
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
        5: makeBars(now.getTime() - 120 * 5 * 60_000, now.getTime(), 4315, 0),
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

test("snapshot exposes data coverage alongside an incomplete plan", () => {
  const now = new Date("2026-08-14T02:00:00Z");
  const snap = buildSnapshot({
    quotes: {
      AU9999: { price: 950, prevClose: 940.72, source: "test", updatedAt: now.getTime() },
      XAU: { price: 4375.8, prevClose: 4350.88, source: "test", updatedAt: now.getTime() },
      USDCNY: { price: 6.7421, source: "test", updatedAt: now.getTime() },
    },
    bars: {
      AU9999: { 1: [], 5: [], 60: [] },
      XAU: { 1: oneMinBars(now, 40), 5: [] },
      CMB: { 1: [], 5: [] },
    },
    plan: null,
  }, DEFAULT_CONFIG, now);
  assert.equal(snap.plan.action, "data_incomplete");
  assert.equal(snap.plan.dataCoverage[60], 0.67);
  assert.equal(snap.plan.dataCoverage[5], 1);
  assert.equal(snap.plan.suggestedOrder, null);
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
  assert.equal(plan.cmbEstimatedPrice, 951.72);
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
      XAU: { 1: oneMinBars(now, 30), 5: [], 60: [] },
      CMB: { 1: [], 5: [], 60: [] },
    },
  };
  const plan = computePlan(runtime, DEFAULT_CONFIG, now);
  // The 60m window is only 50% covered, but 30/60m are not validated during
  // the warm-up hour; the plan proceeds (wait) instead of data_incomplete.
  assert.equal(plan.action, "wait");
  assert.ok(!plan.reasonCodes.some((code) => code.startsWith("data_incomplete")));
  assert.equal(plan.dataCoverage[60], 0.5);
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
      XAU: { 1: oneMinBars(now, 30), 5: [], 60: [] },
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
      XAU: { 1: oneMinBars(now, 30), 5: [], 60: [] },
      CMB: { 1: [], 5: [], 60: [] },
    },
  };
  const plan = computePlan(runtime, DEFAULT_CONFIG, now);
  assert.equal(plan.action, "data_incomplete");
  assert.ok(plan.reasonCodes.includes("data_incomplete_60m"));
  assert.ok(!plan.reasonCodes.includes("data_incomplete_5m"));
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

test("alert message uses live CMB sell price after fee for sell actions", () => {
  const config = normalizeConfig({ cmb: { buySpreadPerGram: 2.84, sellSpreadPerGram: 0 } });
  const message = buildAlertMessage({
    action: "sell_take_profit",
    signalPrice: 952.4,
    cmbEstimatedPrice: 952.4,
    targetPrice: 960,
    suggestedOrder: { instrument: "Au99.99", signalPrice: 952.4, cmbEstimatedPrice: 952.4, grams: 15 },
  }, config, "zh");
  assert.match(message.body, /947\.4/);
  assert.doesNotMatch(message.body, /招行估算 952\.4/);
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
  assert.match(message.body, /建议卖出 6克/);
  assert.match(message.body, /卖出目标价 951\.44 元\/克/);
  assert.doesNotMatch(message.body, /\bCMB\b 956\.49 元\/克 · 招行 951\.49/);
});

test("alert message labels buy side and CMB buy price clearly", () => {
  const message = buildAlertMessage({
    action: "buy_setup",
    signalPrice: 948,
    cmbEstimatedPrice: 950,
    targetPrice: 956,
    suggestedOrder: { instrument: "Au99.99", side: "buy", signalPrice: 948, cmbEstimatedPrice: 950, grams: 10 },
  }, DEFAULT_CONFIG, "zh");
  assert.match(message.body, /Au99\.99 现价 948 元\/克/);
  assert.match(message.body, /招行买入价 950 元\/克/);
  assert.match(message.body, /建议买入 10克/);
  assert.match(message.body, /目标价 956 元\/克/);
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
    if (id === "react") return { createElement: function () {} };
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
