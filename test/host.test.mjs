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
  mergeSecrets,
  normalizeConfig,
  parseEastmoneyKlines,
  parseSinaDomesticQuote,
  parseTencentForexQuote,
  parseTencentXauQuote,
  redactConfig,
  rsi,
  sma,
} from "../lib/index.js";

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
  assert.equal(config.limits.maxAmount, 100000000);
  assert.equal(config.strategy.minProfitPerGram, 1);
  assert.deepEqual(config.tradingHours.holidays, ["2026-10-01"]);
  assert.equal(config.webhooks.generic[0].id, "wh-1");
  assert.equal(config.webhooks.generic[0].name, "n");
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

test("snapshot calibrates CMB price and exposes the next market open", () => {
  const now = new Date("2026-08-15T03:00:00Z");
  const snapshot = buildSnapshot({
    quotes: { AU9999: { price: 950, prevClose: 940.72, source: "test", updatedAt: now.getTime() }, XAU: null, USDCNY: null },
    bars: { AU9999: { 5: [] }, XAU: { 5: [] } },
    plan: null,
  }, DEFAULT_CONFIG, now);
  assert.equal(snapshot.derived.cmb.buyPrice, 951.72);
  assert.equal(snapshot.derived.cmb.sellPrice, 951.72);
  assert.equal(snapshot.market.state, "closed");
  assert.equal(snapshot.market.nextOpen, "2026-08-17T01:00:00.000Z");
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
      XAU: { price: 4375, source: "tencent", updatedAt: Date.now() },
      USDCNY: { price: 6.74, source: "tencent", updatedAt: Date.now() },
    },
    bars: {
      AU9999: { 5: [], 60: [] },
      XAU: { 5: [], 60: [] },
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
      AU9999: {
        5: makeBars(now - 120 * 5 * 60_000, now, 945, 0.03),
        60: makeBars(now - 120 * 60 * 60_000, now, 930, 0.08),
      },
      XAU: { 5: [], 60: [] },
    },
  };
  const plan = computePlan(runtime, normalizeConfig({ limits: { maxGrams: 50 } }), new Date("2026-08-14T02:00:00Z"));
  assert.equal(plan.action, "buy_setup");
  assert.equal(plan.suggestedOrder.side, "buy");
  assert.equal(plan.suggestedOrder.grams, 50);
  assert.ok(plan.targetPrice > plan.breakeven);
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
