/**
 * dsh-plugin-goldboard host half.
 *
 * Gold dashboard + intraday decision support for the DeepSeek Harness web GUI.
 * The host half owns:
 *
 *   - free public quote collection (SGE Au99.99 / XAU spot / USDCNY),
 *     multi-source fallback, source circuit breaker and disk cache;
 *   - bar history (Eastmoney Au99.99 klines + self-built XAU minute bars);
 *   - indicator calculation (SMA/EMA/RSI/MACD/Bollinger/ATR);
 *   - a transparent intraday plan engine for China Merchants Bank 积存金
 *     execution: Au99.99 (or international-converted) signals + a configurable
 *     fixed CMB spread, buy fee 0 / sell fee 5 CNY per gram;
 *   - edge-triggered alerts (no cooldown, no quiet hours) delivered through
 *     host system notifications and webhooks;
 *   - JSON routes consumed by the browser half.
 *
 * This plugin never places orders. Every suggestion is advisory only.
 */

import { createHmac } from "node:crypto";
import { execFile } from "node:child_process";
import { open, appendFile, mkdir, readFile, rename, stat, writeFile } from "node:fs/promises";
import { homedir, platform } from "node:os";
import { join } from "node:path";

import { AnalysisModule } from "./analysis.js";
import { AnalysisLogStore } from "./analysis-log.js";
import {
  CALCULATION_VERSION,
  INDICATOR_METHODS,
  assessMarketQuality,
  closedBars,
  isBarClosed,
  minimumCoverageForWindow,
  normalizeBarRecord,
  normalizeQuoteRecord,
} from "./market-quality.js";

export {
  CALCULATION_VERSION,
  INDICATOR_METHODS,
  assessMarketQuality,
  closedBars,
  isBarClosed,
  minimumCoverageForWindow,
  normalizeBarRecord,
  normalizeQuoteRecord,
} from "./market-quality.js";

export const name = "dsh-plugin-goldboard";
export const inject = ["webServer", "llm"];

// ── constants ──────────────────────────────────────────────────────────────

const CONFIG_FILE = "config.json";
const STATE_FILE = "state.json";
const ALERTS_LOG_FILE = "alerts-log.json";
const API_LOG_FILE = "api-log.json";
const ANALYSIS_LOG_FILE = "analysis-log.jsonl";
const MAX_API_LOGS = 500;
// Rotate api-log.jsonl once it exceeds this size (old file kept as `.1`,
// single generation). Without rotation the log grows without bound because
// every quote poll appends one line per attempted source.
const API_LOG_MAX_BYTES = 2 * 1024 * 1024;
// Tail-read window: reads never load more than the last 256KB of the log.
const API_LOG_TAIL_BYTES = 256 * 1024;
const MAX_CONFIG_BYTES = 256 * 1024;
const MAX_BARS = 1440;
// GET /snapshot serves the cached snapshot when the previous build is younger
// than this. Ticks refresh the snapshot every poll (default 30s), so a 2s
// window absorbs polling bursts / parallel tabs without re-running computePlan.
const SNAPSHOT_REBUILD_MIN_MS = 2_000;
// Minimum interval between two state.json writes that only carry bar data.
// Bars are the bulk of state.json (1–3MB); persisting them on every 30s tick
// burned MB-level disk writes around the clock. A crash loses at most ~5
// minutes of synthetic 1m bars — rebuilt by quote polling + kline backfill
// after restart. Non-bar mutations (alerts, orders, quotes) still write
// immediately.
const STATE_BARS_FLUSH_MS = 5 * 60_000;
// Today-trend points per lane in /snapshot. A single trading session is at
// most 1020 minutes (17h); 1080 leaves headroom while keeping the payload
// well under the ~1MB the old 1440 cap could produce.
const TREND_POINTS = 1080;
// v1.2.x seeded 60m buckets by overwriting each hour bucket with the last 5m
// sub-bar's OHLC (no aggregation). Those corrupt buckets persist in
// state.json for up to 60 days (MAX_BARS), silently degrading the ind60
// EMA20 trend filter. Bump this version whenever the seeding format changes:
// state.json records `barsSeedVersion`; on mismatch the affected lanes are
// dropped and rebuilt by seedBars on the next tick.
const BARS_SEED_VERSION = 2;
const QUOTE_TIMEOUT_MS = 6_000;
const FETCH_TIMEOUT_MS = 10_000;
const DEFAULT_POLL_MS = 30_000;
const STALE_QUOTE_MS = 15 * 60 * 1000;
const CIRCUIT_FAIL_THRESHOLD = 3;
const CIRCUIT_OPEN_MS = 10 * 60 * 1000;
const USER_AGENT = "dsh-plugin-goldboard/0.1 (+DeepSeek Harness plugin)";

const SGE_QUOTATIONS_URL = "https://www.sge.com.cn/graph/quotations";
const SGE_DAILY_URL = "https://www.sge.com.cn/graph/Dailyhq";
const SIXTY_SECONDS_URL = "https://60s.viki.moe/v2/gold-price";
const GOLD_API_URL = "https://api.gold-api.com/price/XAU";
const GOLD_PRICE_TODAY_URL = "https://goldprice.today/api.php?data=live";
const YAHOO_XAU_URL = "https://query1.finance.yahoo.com/v8/finance/chart/GC=F?interval=1d&range=1d";
const YAHOO_XAU_HISTORY_URL = "https://query1.finance.yahoo.com/v8/finance/chart/GC=F?interval=1d&range=5y";
const JIJINHAO_URL = "https://api.jijinhao.com/quoteCenter/realTime.htm?codes=JO_42660,JO_42657,JO_42653,JO_42625,JO_42646,JO_42634,JO_42632,JO_52678,JO_52670,JO_52674,JO_42638";
const JD_GOLD_URL = "https://api.jdjygold.com/gw2/generic/jrm/h5/m/stdLatestPrice?productSku=1961543816";

const BAR_INTERVALS = Object.freeze([1, 5, 15, 60, 1440]);
const EASTMONEY_KLT = Object.freeze({ 5: 5, 15: 15, 30: 30, 60: 60, 101: 101 });
const AU_BAR_META = Object.freeze({ source: "eastmoney", instrument: "Au99.99", market: "sge", currency: "CNY", unit: "gram" });
const XAU_BAR_META = Object.freeze({ source: "eastmoney", instrument: "XAU/USD", market: "spot", currency: "USD", unit: "troy_ounce" });
const GCF_BAR_META = Object.freeze({ source: "yahoo", instrument: "GC=F", market: "futures", currency: "USD", unit: "troy_ounce" });
const CMB_BAR_META = Object.freeze({ source: "manual", synthetic: true, instrument: "CMB_ACCUMULATED_GOLD", market: "bank", currency: "CNY", unit: "gram" });

const ACTION_LABELS_ZH = Object.freeze({
  buy_setup: "出现买入机会啦，可以考虑入手～",
  add_position: "金价回调企稳，可以考虑补一点仓～",
  reduce_position: "金价冲高回落，可以考虑先减点仓～",
  sell_take_profit: "当前金价已经达到盈利目标啦，可以考虑卖出哦～",
  sell_trailing: "金价短线走弱啦，记得保护好利润～",
  sell_stop: "金价跌到止损位啦，注意控制风险～",
  sell_weakness: "盘面有点走弱，可以考虑减仓避险～",
  close_by_session_end: "快到收盘时间啦，注意日内了结～",
  spread_alert: "内外盘价差有点异常，多留意一下～",
  data_stale: "行情数据好像过期了，稍后再看～",
  data_incomplete: "当前数据有缺失，暂不给出建议～",
  wait: "暂时没有合适机会，再等等看～",
  market_closed: "现在是休市时间哦～",
  no_data: "还在等行情数据～",
  no_budget: "已经达到投入上限啦，先不加仓～",
  cancel_order: "原挂单建议已失效，请撤销未成交挂单～",
  order_updated: "挂单建议已更新，请按新建议处理～",
});

const ACTION_LABELS_EN = Object.freeze({
  buy_setup: "Buy opportunity spotted!",
  add_position: "Time to add a bit?",
  reduce_position: "Consider trimming some",
  sell_take_profit: "Target reached — consider selling!",
  sell_trailing: "Pullback detected — protect your profit",
  sell_stop: "Stop hit — manage risk",
  sell_weakness: "Momentum fading — consider reducing",
  close_by_session_end: "Session ending soon — consider closing",
  spread_alert: "Spread looks unusual",
  data_stale: "Market data may be stale",
  data_incomplete: "Data incomplete — no suggestion for now",
  wait: "No opportunity yet",
  market_closed: "Market is closed",
  no_data: "Waiting for quotes",
  no_budget: "Position limit reached",
  cancel_order: "Previous order suggestion is no longer valid — cancel any unfilled order",
  order_updated: "Order suggestion updated — follow the new suggestion",
});

// ── config defaults / normalization ────────────────────────────────────────

export const DEFAULT_CONFIG = Object.freeze({
  fee: Object.freeze({ buyPerGram: 0, sellPerGram: 5 }),
  // 2026-08 实测：国际金价折算约 950.00 时招行积存金约 951.72，故默认价差校准为 +1.72。
  cmb: Object.freeze({ buySpreadPerGram: 1.72, sellSpreadPerGram: 1.72 }),
  position: Object.freeze({ grams: 0, avgCostPerGram: 0, lots: Object.freeze([]) }),
  limits: Object.freeze({ maxGrams: 0 }),
  manualPrevClose: Object.freeze({ AU9999: null, XAU: null, CMB: null }),
  strategy: Object.freeze({
    minProfitPerGram: 1,
    maxLossPerGram: 2,
    slippagePerGram: 0.2,
    estimatedSpreadPerGram: 0.2,
    rsiOversold: 35,
    rsiOverbought: 75,
    atrFactor: 0.3,
    nearSupportPct: 0.5,
    minRemainGrams: 0,
    signalCooldownMinutes: 30,
    confirmBars: 2,
    scoreThreshold: 5,
  }),
  tradingHours: Object.freeze({
    weekdaysOnly: true,
    open: "09:00",
    close: "26:00",
    holidays: Object.freeze([]),
  }),
  analysis: Object.freeze({
    enabled: false,
    provider: "",
    model: "",
    reasoningEffort: "",
    temperature: 0.1,
    maxTokens: 1600,
    trigger: "manual",
    cooldownMinutes: 5,
    timeoutMs: 60_000,
    maxLogEntries: 500,
    riskDisclosure: "技术面参考，非投资建议。",
  }),
  system: Object.freeze({ enabled: false }),
  webhooks: Object.freeze({
    feishu: Object.freeze({ enabled: false, url: "", secret: "", bodyTemplate: "" }),
    dingtalk: Object.freeze({ enabled: false, url: "", secret: "", bodyTemplate: "" }),
    wecom: Object.freeze({ enabled: false, url: "", bodyTemplate: "" }),
    generic: Object.freeze([]),
  }),
});

function num(value, fallback, min = -Infinity, max = Infinity) {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, n));
}

function nullableNum(value, max = 1000000) {
  if (value === "" || value === null || value === undefined) return null;
  const n = Number(value);
  if (!Number.isFinite(n) || n <= 0) return null;
  return Math.round(Math.min(max, Math.max(0, n)) * 100) / 100;
}

function bool(value, fallback) {
  return typeof value === "boolean" ? value : fallback;
}

function str(value, limit = 4096) {
  return typeof value === "string" ? value.slice(0, limit) : "";
}

function cleanHolidays(value) {
  if (!Array.isArray(value)) return [];
  const out = [];
  for (const entry of value) {
    if (typeof entry !== "string") continue;
    const date = entry.slice(0, 10);
    if (/^\d{4}-\d{2}-\d{2}$/.test(date) && !out.includes(date)) out.push(date);
  }
  return out;
}

function cleanHeaders(value) {
  const out = {};
  if (typeof value !== "object" || value === null || Array.isArray(value)) return out;
  let count = 0;
  for (const [key, entry] of Object.entries(value)) {
    if (count >= 32) break;
    if (typeof entry !== "string") continue;
    out[key.slice(0, 128)] = entry.slice(0, 4096);
    count += 1;
  }
  return out;
}

function cleanGenericItem(entry, index) {
  const id = str(entry?.id).slice(0, 64) || `wh-${index + 1}`;
  return {
    id,
    name: str(entry?.name).slice(0, 64) || id,
    enabled: bool(entry?.enabled, false),
    url: str(entry?.url),
    headers: cleanHeaders(entry?.headers),
    bodyTemplate: str(entry?.bodyTemplate),
  };
}

function cleanLots(value) {
  if (!Array.isArray(value)) return [];
  const out = [];
  for (const entry of value) {
    if (!entry || typeof entry !== "object") continue;
    const grams = num(entry.grams, 0, 0, 100000);
    const price = Math.round(num(entry.price, 0, 0, 1000000) * 100) / 100;
    if (grams <= 0 || price <= 0) continue;
    out.push({
      id: str(entry.id, 64) || `lot-${out.length + 1}`,
      grams,
      price,
      time: str(entry.time, 64) || new Date().toISOString(),
      status: entry.status === "closed" ? "closed" : "open",
    });
  }
  return out;
}

function positionFromLots(lots) {
  const open = lots.filter((lot) => lot.status !== "closed");
  const grams = open.reduce((sum, lot) => sum + lot.grams, 0);
  const avgCostPerGram = grams > 0 ? open.reduce((sum, lot) => sum + lot.grams * lot.price, 0) / grams : 0;
  return { grams, avgCostPerGram };
}

function normalizePosition(value) {
  const source = value && typeof value === "object" ? value : {};
  const hasLots = Array.isArray(source.lots);
  const lots = cleanLots(source.lots);
  if (lots.length > 0) {
    const derived = positionFromLots(lots);
    return {
      grams: derived.grams,
      avgCostPerGram: derived.avgCostPerGram,
      lots,
    };
  }
  // An explicit empty lots array is the settings UI's clear-position value.
  // Only legacy payloads without lots may fall back to aggregate fields.
  if (hasLots) return { grams: 0, avgCostPerGram: 0, lots: [] };
  const grams = num(source.grams, DEFAULT_CONFIG.position.grams, 0, 100000);
  const avgCostPerGram = num(source.avgCostPerGram, DEFAULT_CONFIG.position.avgCostPerGram, 0, 1000000);
  const fallbackLots = grams > 0 && avgCostPerGram > 0
    ? [{ id: "lot-1", grams, price: avgCostPerGram, time: new Date().toISOString(), status: "open" }]
    : [];
  return {
    grams,
    avgCostPerGram,
    lots: fallbackLots,
  };
}

/** Merge an arbitrary stored/input value over the defaults and sanitize it. */
export function normalizeConfig(value) {
  const source = typeof value === "object" && value !== null ? value : {};
  const fee = typeof source.fee === "object" && source.fee !== null ? source.fee : {};
  const cmb = typeof source.cmb === "object" && source.cmb !== null ? source.cmb : {};
  const position = typeof source.position === "object" && source.position !== null ? source.position : {};
  const limits = typeof source.limits === "object" && source.limits !== null ? source.limits : {};
  const manualPrevClose = typeof source.manualPrevClose === "object" && source.manualPrevClose !== null ? source.manualPrevClose : {};
  const strategy = typeof source.strategy === "object" && source.strategy !== null ? source.strategy : {};
  const tradingHours = typeof source.tradingHours === "object" && source.tradingHours !== null ? source.tradingHours : {};
  const analysis = typeof source.analysis === "object" && source.analysis !== null ? source.analysis : {};
  const system = typeof source.system === "object" && source.system !== null ? source.system : {};
  const webhooks = typeof source.webhooks === "object" && source.webhooks !== null ? source.webhooks : {};
  const feishu = typeof webhooks.feishu === "object" && webhooks.feishu !== null ? webhooks.feishu : {};
  const dingtalk = typeof webhooks.dingtalk === "object" && webhooks.dingtalk !== null ? webhooks.dingtalk : {};
  const wecom = typeof webhooks.wecom === "object" && webhooks.wecom !== null ? webhooks.wecom : {};
  const generic = Array.isArray(webhooks.generic) ? webhooks.generic : [];
  return {
    fee: {
      buyPerGram: num(fee.buyPerGram, DEFAULT_CONFIG.fee.buyPerGram, 0, 100),
      sellPerGram: num(fee.sellPerGram, DEFAULT_CONFIG.fee.sellPerGram, 0, 100),
    },
    cmb: {
      buySpreadPerGram: num(cmb.buySpreadPerGram, DEFAULT_CONFIG.cmb.buySpreadPerGram, -100, 100),
      sellSpreadPerGram: num(cmb.sellSpreadPerGram, DEFAULT_CONFIG.cmb.sellSpreadPerGram, -100, 100),
    },
    limits: {
      maxGrams: num(limits.maxGrams, DEFAULT_CONFIG.limits.maxGrams, 0, 100000),
    },
    manualPrevClose: {
      AU9999: nullableNum(manualPrevClose.AU9999),
      XAU: nullableNum(manualPrevClose.XAU),
      CMB: nullableNum(manualPrevClose.CMB),
    },
    position: normalizePosition(position),
    strategy: {
      minProfitPerGram: num(strategy.minProfitPerGram, DEFAULT_CONFIG.strategy.minProfitPerGram, 0, 100),
      maxLossPerGram: num(strategy.maxLossPerGram, DEFAULT_CONFIG.strategy.maxLossPerGram, 0, 1000),
      slippagePerGram: num(strategy.slippagePerGram, DEFAULT_CONFIG.strategy.slippagePerGram, 0, 50),
      estimatedSpreadPerGram: num(strategy.estimatedSpreadPerGram, DEFAULT_CONFIG.strategy.estimatedSpreadPerGram, 0, 50),
      rsiOversold: num(strategy.rsiOversold, DEFAULT_CONFIG.strategy.rsiOversold, 1, 50),
      rsiOverbought: num(strategy.rsiOverbought, DEFAULT_CONFIG.strategy.rsiOverbought, 50, 99),
      atrFactor: num(strategy.atrFactor, DEFAULT_CONFIG.strategy.atrFactor, 0.05, 2),
      nearSupportPct: num(strategy.nearSupportPct, DEFAULT_CONFIG.strategy.nearSupportPct, 0.05, 10),
      minRemainGrams: num(strategy.minRemainGrams, DEFAULT_CONFIG.strategy.minRemainGrams, 0, 100000),
      signalCooldownMinutes: num(strategy.signalCooldownMinutes, DEFAULT_CONFIG.strategy.signalCooldownMinutes, 0, 1440),
      confirmBars: num(strategy.confirmBars, DEFAULT_CONFIG.strategy.confirmBars, 1, 10),
      scoreThreshold: num(strategy.scoreThreshold, DEFAULT_CONFIG.strategy.scoreThreshold, 1, 10),
    },
    tradingHours: {
      weekdaysOnly: bool(tradingHours.weekdaysOnly, DEFAULT_CONFIG.tradingHours.weekdaysOnly),
      open: /^\d{2}:\d{2}$/.test(tradingHours.open) ? tradingHours.open : DEFAULT_CONFIG.tradingHours.open,
      close: /^\d{2}:\d{2}$/.test(tradingHours.close) ? tradingHours.close : DEFAULT_CONFIG.tradingHours.close,
      holidays: cleanHolidays(tradingHours.holidays),
    },
    analysis: {
      enabled: bool(analysis.enabled, DEFAULT_CONFIG.analysis.enabled),
      provider: str(analysis.provider, 128),
      model: str(analysis.model, 256),
      reasoningEffort: str(analysis.reasoningEffort, 64),
      temperature: num(analysis.temperature, DEFAULT_CONFIG.analysis.temperature, 0, 2),
      maxTokens: Math.round(num(analysis.maxTokens, DEFAULT_CONFIG.analysis.maxTokens, 128, 32_000)),
      trigger: analysis.trigger === "manual" ? "manual" : DEFAULT_CONFIG.analysis.trigger,
      cooldownMinutes: num(analysis.cooldownMinutes, DEFAULT_CONFIG.analysis.cooldownMinutes, 0, 1_440),
      timeoutMs: Math.round(num(analysis.timeoutMs, DEFAULT_CONFIG.analysis.timeoutMs, 5_000, 180_000)),
      maxLogEntries: Math.round(num(analysis.maxLogEntries, DEFAULT_CONFIG.analysis.maxLogEntries, 10, 5_000)),
      riskDisclosure: str(analysis.riskDisclosure, 512) || DEFAULT_CONFIG.analysis.riskDisclosure,
    },
    system: { enabled: bool(system.enabled, DEFAULT_CONFIG.system.enabled) },
    webhooks: {
      feishu: { enabled: bool(feishu.enabled, false), url: str(feishu.url), secret: str(feishu.secret), bodyTemplate: str(feishu.bodyTemplate) },
      dingtalk: { enabled: bool(dingtalk.enabled, false), url: str(dingtalk.url), secret: str(dingtalk.secret), bodyTemplate: str(dingtalk.bodyTemplate) },
      wecom: { enabled: bool(wecom.enabled, false), url: str(wecom.url), bodyTemplate: str(wecom.bodyTemplate) },
      generic: generic.slice(0, 32).map(cleanGenericItem),
    },
  };
}

const SECRET_PATHS = Object.freeze([
  ["webhooks", "feishu", "secret"],
  ["webhooks", "dingtalk", "secret"],
]);

function readPath(config, path) {
  let node = config;
  for (const key of path) {
    if (node === null || typeof node !== "object") return undefined;
    node = node[key];
  }
  return node;
}

/** Produce the wire view: secret fields blanked plus a `secretSet` sidecar. */
export function redactConfig(config) {
  const normalized = normalizeConfig(config);
  const value = JSON.parse(JSON.stringify(normalized));
  const secretSet = {};
  for (const path of SECRET_PATHS) {
    const node = path.slice(0, -1).reduce((acc, key) => acc[key], value);
    const leaf = path[path.length - 1];
    secretSet[path.join(".")] = node[leaf] !== "";
    node[leaf] = "";
  }
  return { config: value, secretSet };
}

/** Merge a wire write: keep stored secrets on "", replace on non-empty, clear listed paths. */
export function mergeSecrets(stored, incoming, clearSecrets) {
  const next = JSON.parse(JSON.stringify(incoming === null || typeof incoming !== "object" ? {} : incoming));
  const clears = new Set(Array.isArray(clearSecrets) ? clearSecrets.filter((entry) => typeof entry === "string") : []);
  for (const path of SECRET_PATHS) {
    const key = path.join(".");
    let node = next;
    for (let index = 0; index < path.length - 1; index += 1) {
      if (node[path[index]] === null || typeof node[path[index]] !== "object") node[path[index]] = {};
      node = node[path[index]];
    }
    const leaf = path[path.length - 1];
    const incomingValue = readPath(incoming, path);
    if (clears.has(key)) node[leaf] = "";
    else if (typeof incomingValue === "string" && incomingValue !== "") node[leaf] = incomingValue;
    else node[leaf] = readPath(stored, path) ?? "";
  }
  return next;
}

// ── paths / persistence ────────────────────────────────────────────────────

export function dshHome() {
  return process.env.DSH_HOME ?? join(homedir(), ".dsh");
}

export function pluginDir() {
  return join(dshHome(), "storages", "dsh-plugin-goldboard");
}

async function readJson(file, fallback) {
  try {
    const text = await readFile(file, "utf8");
    return JSON.parse(text);
  } catch {
    return fallback;
  }
}

function makeWriteQueue() {
  let chain = Promise.resolve();
  return function enqueue(fn) {
    chain = chain.then(fn, fn);
    return chain;
  };
}

function writeJsonAtomic(file, value, queue) {
  return queue(async () => {
    const tmp = `${file}.tmp`;
    await writeFile(tmp, JSON.stringify(value, null, 2), "utf8");
    await rename(tmp, file);
  });
}

// ── API call logging ──────────────────────────────────────────────────────

const DATA_SOURCES = Object.freeze([
  Object.freeze({ id: "sina-domestic", nameZh: "新浪财经 Au99.99", nameEn: "Sina Finance Au99.99", source: "sina", kind: "domestic", instrument: "AU9999", url: "https://hq.sinajs.cn/list=gds_AU9999" }),
  Object.freeze({ id: "sge-domestic", nameZh: "上金所 SGE Au99.99", nameEn: "SGE Au99.99", source: "sge", kind: "domestic", instrument: "AU9999", url: "https://www.sge.com.cn/graph/quotations" }),
  Object.freeze({ id: "sge-history", nameZh: "上金所 SGE 历史", nameEn: "SGE History", source: "sge", kind: "history", instrument: null, url: "https://www.sge.com.cn/graph/Dailyhq" }),
  Object.freeze({ id: "eastmoney-domestic", nameZh: "东方财富 Au99.99", nameEn: "Eastmoney Au99.99", source: "eastmoney", kind: "domestic", instrument: "AU9999", url: "https://push2.eastmoney.com/api/qt/stock/get?secid=118.AU9999" }),
  Object.freeze({ id: "sixty-domestic", nameZh: "60s API 国内金价", nameEn: "60s API Domestic", source: "60s", kind: "domestic", instrument: "AU9999", url: "https://60s.viki.moe/v2/gold-price" }),
  Object.freeze({ id: "tencent-xau", nameZh: "腾讯行情 XAU", nameEn: "Tencent XAU", source: "tencent", kind: "xau", instrument: "XAU", url: "https://qt.gtimg.cn/q=hf_XAU" }),
  Object.freeze({ id: "sina-xau", nameZh: "新浪财经 XAU", nameEn: "Sina Finance XAU", source: "sina", kind: "xau", instrument: "XAU", url: "https://hq.sinajs.cn/list=hf_XAU" }),
  Object.freeze({ id: "gold-api-xau", nameZh: "gold-api.com XAU", nameEn: "gold-api.com XAU", source: "gold-api", kind: "xau", instrument: "XAU", url: "https://api.gold-api.com/price/XAU" }),
  Object.freeze({ id: "sixty-xau", nameZh: "60s API 国际金价", nameEn: "60s API International", source: "60s", kind: "xau", instrument: "XAU", url: "https://60s.viki.moe/v2/gold-price" }),
  Object.freeze({ id: "goldprice-today-xau", nameZh: "GoldPrice.Today XAU", nameEn: "GoldPrice.Today XAU", source: "goldprice-today", kind: "xau", instrument: "XAU", url: "https://goldprice.today/api.php?data=live" }),
  Object.freeze({ id: "yahoo-xau", nameZh: "Yahoo Finance COMEX 黄金期货", nameEn: "Yahoo Finance COMEX Gold Futures", source: "yahoo", kind: "futures", instrument: "GC=F", market: "futures", url: "https://query1.finance.yahoo.com/v8/finance/chart/GC=F" }),
  Object.freeze({ id: "yahoo-history-xau", nameZh: "Yahoo Finance COMEX 黄金期货日线", nameEn: "Yahoo Finance COMEX Gold Futures Daily", source: "yahoo", kind: "history", instrument: "GC=F", market: "futures", url: "https://query1.finance.yahoo.com/v8/finance/chart/GC=F?interval=1d&range=5y" }),
  Object.freeze({ id: "tencent-usdcny", nameZh: "腾讯行情 USDCNY", nameEn: "Tencent USDCNY", source: "tencent", kind: "usdcny", instrument: "USDCNY", url: "https://qt.gtimg.cn/q=whUSDCNY" }),
  Object.freeze({ id: "cmb-market-center", nameZh: "招商银行积存金", nameEn: "CMB 积存金", source: "cmb", kind: "cmb", instrument: "CMB", url: "https://mbmodule-openapi.paas.cmbchina.com/product/v1/func/market-center" }),
  Object.freeze({ id: "jijinhao-brand", nameZh: "金投网品牌金价", nameEn: "Jinjinhao Brand Gold", source: "jijinhao", kind: "brand", instrument: null, url: "https://api.jijinhao.com/quoteCenter/realTime.htm" }),
  Object.freeze({ id: "jdjy-gold", nameZh: "京东金融积存金", nameEn: "JD Finance Accumulated Gold", source: "jdjy", kind: "cmb", instrument: null, url: "https://api.jdjygold.com/gw2/generic/jrm/h5/m/stdLatestPrice" }),
  Object.freeze({ id: "eastmoney-kline-au", nameZh: "东方财富 Au99.99 K线", nameEn: "Eastmoney Au99.99 K-line", source: "eastmoney", kind: "history", instrument: null, url: "https://push2his.eastmoney.com/api/qt/stock/kline/get?secid=118.AU9999" }),
  Object.freeze({ id: "eastmoney-kline-xau", nameZh: "东方财富 XAU K线", nameEn: "Eastmoney XAU K-line", source: "eastmoney", kind: "history", instrument: null, url: "https://push2his.eastmoney.com/api/qt/stock/kline/get?secid=122.XAU" }),
]);

const apiLogs = [];
let apiLogPath = null;
let apiLogWriteQueue = null;

/**
 * Rotate the JSONL log when it exceeds API_LOG_MAX_BYTES: the current file
 * becomes `<name>.1` (previous `.1` is overwritten, single generation kept).
 * Exported for tests.
 */
export async function rotateApiLogIfNeeded(path, maxBytes = API_LOG_MAX_BYTES) {
  let size = 0;
  try {
    const info = await stat(path);
    size = info.size;
  } catch (error) {
    if (error?.code === "ENOENT") return false;
    throw error;
  }
  if (size <= maxBytes) return false;
  await rename(path, `${path}.1`);
  return true;
}

async function persistApiLog(entry) {
  if (!apiLogPath || !apiLogWriteQueue) return;
  try {
    await apiLogWriteQueue(async () => {
      await rotateApiLogIfNeeded(apiLogPath);
      await appendFile(apiLogPath, JSON.stringify(entry) + "\n", "utf8");
    });
  } catch {
    // Log persistence is best-effort and must never break quote collection.
  }
}

function setApiLogSink(path, queue) {
  apiLogPath = path;
  apiLogWriteQueue = queue;
}

/**
 * Read at most the last API_LOG_TAIL_BYTES of a JSONL log and parse the last
 * MAX_API_LOGS entries (newest first). Files smaller than the tail window are
 * read whole (previous behaviour). A torn first line — inevitable when the
 * window starts mid-JSON — is dropped instead of failing the read.
 * Exported for tests.
 */
export async function readApiLogsFromFile(path, tailBytes = API_LOG_TAIL_BYTES) {
  let handle;
  try {
    handle = await open(path, "r");
  } catch (error) {
    if (error?.code === "ENOENT") return [];
    throw error;
  }
  try {
    const info = await handle.stat();
    const start = Math.max(0, info.size - tailBytes);
    const length = info.size - start;
    const buffer = Buffer.alloc(length);
    await handle.read(buffer, 0, length, start);
    const lines = buffer.toString("utf8").split("\n");
    // Drop the torn head line unless the window covers the file from byte 0.
    if (start > 0) lines.shift();
    const out = [];
    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      try {
        out.push(JSON.parse(trimmed));
      } catch {
        // Skip malformed lines.
      }
    }
    return out.slice(-MAX_API_LOGS).reverse();
  } finally {
    await handle.close();
  }
}

async function readApiLogs() {
  if (!apiLogPath) return [];
  try {
    return await readApiLogsFromFile(apiLogPath);
  } catch {
    // Ignore read failures; logs are best-effort.
    return [];
  }
}

function recordApiCall(entry) {
  const logEntry = {
    id: `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`,
    time: new Date().toISOString(),
    sourceId: entry.sourceId,
    source: entry.source,
    kind: entry.kind,
    url: entry.url,
    ok: entry.ok === true,
    status: entry.status,
    durationMs: entry.durationMs,
    error: entry.error ? String(entry.error).slice(0, 500) : undefined,
  };
  apiLogs.unshift(logEntry);
  if (apiLogs.length > MAX_API_LOGS) apiLogs.length = MAX_API_LOGS;
  void persistApiLog(logEntry);
}

function getApiLogs(sourceId) {
  if (!sourceId) return apiLogs.slice();
  return apiLogs.filter((entry) => entry.sourceId === sourceId);
}

// ── source circuit breaker ────────────────────────────────────────────────
//
// A source is opened (skipped) after CIRCUIT_FAIL_THRESHOLD consecutive
// failures and stays open for CIRCUIT_OPEN_MS. This prevents a broken free
// API from being hammered on every poll and forces fallback to the next
// available source sooner.

const circuitState = new Map();

function circuitInfo(sourceId) {
  const state = circuitState.get(sourceId);
  if (!state) return { open: false, failures: 0 };
  if (state.openedAt && Date.now() - state.openedAt >= CIRCUIT_OPEN_MS) {
    circuitState.delete(sourceId);
    return { open: false, failures: 0 };
  }
  return { open: Boolean(state.openedAt), failures: state.failures };
}

export function isCircuitOpen(sourceId) {
  return circuitInfo(sourceId).open;
}

export function markSourceSuccess(sourceId) {
  circuitState.delete(sourceId);
}

export function markSourceFailure(sourceId) {
  if (isCircuitOpen(sourceId)) return;
  const state = circuitState.get(sourceId) || { failures: 0, openedAt: null };
  state.failures += 1;
  if (state.failures >= CIRCUIT_FAIL_THRESHOLD) {
    state.openedAt = Date.now();
  }
  circuitState.set(sourceId, state);
}

async function trackedCall(entry, fn) {
  if (isCircuitOpen(entry.sourceId)) {
    throw new Error(`source circuit open: ${entry.sourceId}`);
  }
  const startedAt = Date.now();
  try {
    const result = await fn();
    const ok = !!result && (Array.isArray(result) ? result.length > 0 : true);
    if (ok) markSourceSuccess(entry.sourceId);
    else markSourceFailure(entry.sourceId);
    recordApiCall({
      ...entry,
      ok,
      durationMs: Date.now() - startedAt,
      error: ok ? undefined : "empty or parse failed",
    });
    return result;
  } catch (error) {
    markSourceFailure(entry.sourceId);
    recordApiCall({
      ...entry,
      ok: false,
      durationMs: Date.now() - startedAt,
      error: error?.message ?? String(error ?? "request failed"),
    });
    throw error;
  }
}

function dataSourceView(runtime) {
  const now = Date.now();
  return DATA_SOURCES.map((source) => {
    const logs = getApiLogs(source.id);
    const last = logs[0] || null;
    const quoteKey = source.instrument === "GC=F" ? "GCF" : source.instrument;
    const quote = quoteKey ? runtime.quotes?.[quoteKey] : null;
    const current = quote && quote.source === source.source
      ? {
          price: quote.price,
          updatedAt: quote.updatedAt,
          stale: !Number.isFinite(quote.updatedAt) || now - quote.updatedAt > STALE_QUOTE_MS || !isDomesticQuoteFresh(quote, new Date(now)),
          instrument: quote.instrument,
          market: quote.market,
          quality: quote.quality,
        }
      : null;
    return {
      id: source.id,
      nameZh: source.nameZh,
      nameEn: source.nameEn,
      source: source.source,
      kind: source.kind,
      instrument: source.instrument,
      url: source.url,
      status: last ? (last.ok ? "ok" : "error") : "unknown",
      lastTime: last?.time,
      lastOk: last?.ok,
      lastError: last?.error,
      lastDurationMs: last?.durationMs,
      current,
      logCount: logs.length,
    };
  });
}

// ── HTTP helpers ───────────────────────────────────────────────────────────

// Testability seam: every outbound request goes through fetchImpl so tests
// can inject slow/fast fake sources and assert chain-budget behaviour
// (see __setFetchImpl).
let fetchImpl = (...args) => fetch(...args);

/** Test-only hook: replace the outbound fetch implementation. Returns the previous one. */
export function __setFetchImpl(impl) {
  const previous = fetchImpl;
  fetchImpl = typeof impl === "function" ? impl : (...args) => fetch(...args);
  return previous;
}

const GB18030_DECODER = new TextDecoder("gb18030");

/**
 * Fetch a URL with a hard timeout that covers headers AND body, linked to an
 * optional chain-level abort signal. The old helper stopped its timer once
 * headers arrived, so a stalled body could hang a quote chain indefinitely;
 * here the whole exchange is bounded.
 */
async function fetchBody(url, options, timeoutMs, chainSignal, decode) {
  const controller = new AbortController();
  const onChainAbort = () => controller.abort(chainSignal.reason);
  if (chainSignal) {
    if (chainSignal.aborted) controller.abort(chainSignal.reason);
    else chainSignal.addEventListener("abort", onChainAbort, { once: true });
  }
  const timer = setTimeout(() => controller.abort(new Error(`timeout after ${timeoutMs}ms`)), timeoutMs);
  try {
    const response = await fetchImpl(url, { ...options, signal: controller.signal });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    return await decode(response);
  } finally {
    clearTimeout(timer);
    if (chainSignal) chainSignal.removeEventListener("abort", onChainAbort);
  }
}

async function fetchWithTimeout(url, options = {}, timeoutMs = FETCH_TIMEOUT_MS) {
  return fetchBody(url, options, timeoutMs, null, (response) => response);
}

async function fetchUtf8(url, options = {}, timeoutMs = FETCH_TIMEOUT_MS, chainSignal = null) {
  return fetchBody(url, options, timeoutMs, chainSignal, (response) => response.text());
}

async function fetchGb18030(url, options = {}, timeoutMs = QUOTE_TIMEOUT_MS, chainSignal = null) {
  return fetchBody(url, options, timeoutMs, chainSignal, async (response) => GB18030_DECODER.decode(await response.arrayBuffer()));
}

// ── quote parsers (exported for tests) ─────────────────────────────────────

export function parseSinaDomesticQuote(text) {
  const match = text.match(/"([^"]*)"/);
  if (!match) return null;
  const f = match[1].split(",");
  if (f.length < 13 || !Number.isFinite(Number(f[0]))) return null;
  const price = Number(f[0]);
  if (!(price > 0)) return null;
  return {
    price,
    bid: Number(f[2]) || undefined,
    ask: Number(f[3]) || undefined,
    high: Number(f[4]) || undefined,
    low: Number(f[5]) || undefined,
    prevClose: Number(f[7]) || undefined,
    open: Number(f[8]) || undefined,
    time: f[6],
    date: f[12],
    name: f[13],
  };
}

export function parseTencentXauQuote(text) {
  const match = text.match(/="([^"]*)"/);
  if (!match) return null;
  const f = match[1].split(",");
  if (f.length < 13 || !Number.isFinite(Number(f[0]))) return null;
  const price = Number(f[0]);
  if (!(price > 0)) return null;
  return {
    price,
    high: Number(f[4]) || undefined,
    low: Number(f[5]) || undefined,
    time: f[6],
    prevClose: Number(f[8]) || undefined,
    date: f[12],
    name: f[13],
  };
}

export function parseTencentForexQuote(text) {
  const match = text.match(/="([^"]*)"/);
  if (!match) return null;
  const f = match[1].split("~");
  const price = Number(f[3]);
  if (!(price > 0)) return null;
  return { price, name: f[1], time: f[5], prevClose: Number(f[4]) || undefined };
}

export function parseEastmoneyDomesticQuote(json) {
  const data = json?.data;
  if (!data || !Number.isFinite(Number(data.f43))) return null;
  const scale = 100;
  const price = Number(data.f43) / scale;
  if (!(price > 0)) return null;
  return {
    price,
    high: Number(data.f44) / scale || undefined,
    low: Number(data.f45) / scale || undefined,
    open: Number(data.f46) / scale || undefined,
    prevClose: Number(data.f60) / scale || undefined,
    time: data.f86 ? String(data.f86) : undefined,
  };
}

function beijingDateForNow(now) {
  const shifted = new Date(now.getTime() + 8 * 60 * 60 * 1000);
  return shifted.toISOString().slice(0, 10);
}

export function parseQuoteTimestamp(quote, now = new Date()) {
  if (!quote) return null;
  const nowDate = now instanceof Date ? now : new Date(now);
  let date = typeof quote.date === "string" ? quote.date.trim() : "";
  let time = typeof quote.time === "string" ? quote.time.trim() : "";
  if (!time) return null;
  if (/^\d{8}\d{6}$/.test(time)) {
    date = `${time.slice(0, 4)}-${time.slice(4, 6)}-${time.slice(6, 8)}`;
    time = `${time.slice(8, 10)}:${time.slice(10, 12)}:${time.slice(12, 14)}`;
  }
  const separator = time.includes("T") ? "T" : time.includes(" ") ? " " : "";
  if (separator) {
    const parts = time.split(separator);
    if (!date && /^\d{4}-\d{2}-\d{2}$/.test(parts[0] || "")) {
      date = parts[0];
      time = parts[1] || "";
    } else if (parts.length >= 2) {
      date = parts[0];
      time = parts[1] || "";
    }
  }
  if (!date) date = beijingDateForNow(nowDate);
  if (!/^\d{2}:\d{2}(:\d{2})?$/.test(time)) return null;
  if (time.length === 5) time += ":00";
  const timestamp = Date.parse(`${date}T${time}+08:00`);
  return Number.isFinite(timestamp) ? timestamp : null;
}

export function isDomesticQuoteFresh(quote, now = new Date(), maxAgeMs = STALE_QUOTE_MS) {
  if (!quote) return false;
  const nowDate = now instanceof Date ? now : new Date(now);
  const timestamp = parseQuoteTimestamp(quote, nowDate);
  // When the source does not include a timestamp, trust the HTTP response.
  if (timestamp === null) return true;
  return nowDate.getTime() - timestamp <= maxAgeMs;
}

export function parseEastmoneyKlines(json) {
  const klines = json?.data?.klines;
  if (!Array.isArray(klines)) return [];
  const out = [];
  for (const line of klines) {
    const f = line.split(",");
    if (f.length < 6) continue;
    const rawDate = f[0].trim();
    const normalizedDate = rawDate.includes(" ") ? rawDate.replace(" ", "T") : rawDate;
    const isoDate = normalizedDate.includes("T") ? `${normalizedDate}+08:00` : `${normalizedDate}T00:00:00+08:00`;
    const t = new Date(isoDate).getTime();
    if (!Number.isFinite(t)) continue;
    // Eastmoney sometimes returns placeholder bars after the close with zero
    // volume and the last traded price repeated (e.g. Au99.99 flat at 952.4
    // after 16:00). They are not real trades, so do not feed them into the
    // today trend.
    const volume = Number(f[5]);
    if (!Number.isFinite(volume) || volume <= 0) continue;
    out.push({
      t,
      o: Number(f[1]),
      c: Number(f[2]),
      h: Number(f[3]),
      l: Number(f[4]),
    });
  }
  return out;
}

function firstPositiveNumber(...values) {
  for (const value of values) {
    const normalized = typeof value === "string"
      ? value.replace(/[,，\s]/g, "").replace(/[^\d.]/g, "")
      : value;
    const n = Number(normalized);
    if (Number.isFinite(n) && n > 0) return n;
  }
  return null;
}

function parseSgeRow(row, meta) {
  if (!row) return null;
  if (Array.isArray(row)) {
    const values = row.map((value) => (value === null || value === undefined ? "" : String(value)));
    const first = values[0] || "";
    const firstNum = Number(first);
    let price;
    let open;
    let high;
    let low;
    let prevClose;
    if (Number.isFinite(firstNum) && firstNum > 0) {
      price = firstNum;
      open = firstPositiveNumber(values[1]);
      high = firstPositiveNumber(values[2]);
      low = firstPositiveNumber(values[3]);
      prevClose = firstPositiveNumber(values[4]);
    } else {
      price = firstPositiveNumber(values[1], values[2]);
      open = firstPositiveNumber(values[2]);
      high = firstPositiveNumber(values[3]);
      low = firstPositiveNumber(values[4]);
      prevClose = firstPositiveNumber(values[5]);
    }
    if (!price) return null;
    return {
      price,
      open,
      high,
      low,
      prevClose,
      time: typeof meta?.times === "string" ? meta.times : undefined,
      date: typeof meta?.date === "string" ? meta.date : undefined,
      name: typeof meta?.name === "string" ? meta.name : undefined,
    };
  }
  if (typeof row !== "object") return null;
  const price = firstPositiveNumber(
    row.price,
    row.last,
    row.zxj,
    row.latest,
    row.close,
    row["最新价"],
    row["现价"],
  );
  if (!price) return null;
  return {
    price,
    open: firstPositiveNumber(row.open, row["开盘价"]),
    high: firstPositiveNumber(row.high, row["最高价"]),
    low: firstPositiveNumber(row.low, row["最低价"]),
    prevClose: firstPositiveNumber(row.prevClose, row.preClose, row["昨收"]),
    time: row.time || row.times || meta?.times || undefined,
    date: row.date || meta?.date || undefined,
    name: row.name || row.symbol || row.variety || undefined,
  };
}

/**
 * Parse the SGE realtime quotations endpoint.
 * The endpoint can return either an array of rows (AKShare style) or an object
 * with a `data`/`list` array. Each row is accepted as an array or object.
 */
export function parseSgeQuote(json) {
  if (!json || typeof json !== "object") return null;
  const data = json.data ?? json.list ?? json.result ?? json;
  const rows = Array.isArray(data)
    ? data
    : (data && typeof data === "object" && Array.isArray(data.list) ? data.list : null);
  if (rows) {
    for (const row of rows) {
      const parsed = parseSgeRow(row, json);
      if (parsed) return parsed;
    }
  }
  const direct = parseSgeRow(json, json);
  if (direct) return direct;
  function find(value, depth = 0) {
    if (!value || typeof value !== "object" || depth > 8) return null;
    if (Array.isArray(value)) {
      for (const item of value) {
        const found = find(item, depth + 1);
        if (found) return found;
      }
      return null;
    }
    const parsed = parseSgeRow(value, json);
    if (parsed) return parsed;
    for (const key of Object.keys(value)) {
      const found = find(value[key], depth + 1);
      if (found) return found;
    }
    return null;
  }
  return find(json);
}

/**
 * Parse the SGE daily history endpoint (`/graph/Dailyhq`).
 * The documented row shape is `[日期, 开, 收, 低, 高]`.
 */
export function parseSgeDailyBars(json) {
  if (!json || typeof json !== "object") return [];
  const rows = json.time ?? json.data ?? json.list ?? json.result;
  if (!Array.isArray(rows)) return [];
  const out = [];
  for (const row of rows) {
    if (!row) continue;
    if (Array.isArray(row)) {
      if (row.length < 5) continue;
      const date = String(row[0] ?? "");
      const open = firstPositiveNumber(row[1]);
      const close = firstPositiveNumber(row[2]);
      const low = firstPositiveNumber(row[3]);
      const high = firstPositiveNumber(row[4]);
      if (!date || !open || !close || !low || !high) continue;
      const t = Date.parse(`${date}T00:00:00+08:00`);
      if (!Number.isFinite(t)) continue;
      out.push({ t, o: open, c: close, h: high, l: low });
    } else if (typeof row === "object") {
      const date = row.date || row.time || row["日期"];
      const open = firstPositiveNumber(row.open, row["开盘"]);
      const close = firstPositiveNumber(row.close, row["收盘"]);
      const low = firstPositiveNumber(row.low, row["最低"]);
      const high = firstPositiveNumber(row.high, row["最高"]);
      if (!date || !open || !close || !low || !high) continue;
      const t = Date.parse(`${date}T00:00:00+08:00`);
      if (!Number.isFinite(t)) continue;
      out.push({ t, o: open, c: close, h: high, l: low });
    }
  }
  return out.sort((a, b) => a.t - b.t);
}

function parseNumericEntry(value) {
  if (typeof value === "number") return Number.isFinite(value) && value > 0 ? value : null;
  if (typeof value !== "string") return null;
  const cleaned = value.replace(/[,，\s]/g, "").replace(/[^\d.]/g, "");
  const n = Number(cleaned);
  return Number.isFinite(n) && n > 0 ? n : null;
}

/**
 * Parse the 60s.viki.moe `/v2/gold-price` aggregate response.
 * Returns `{ domestic, xau, ... }` where each is a minimal quote object.
 */
export function parseSixtySecondsGoldPrice(json) {
  if (!json || typeof json !== "object") return null;
  const metals = (json.metals && typeof json.metals === "object") ? json.metals : json;
  const entries = {};
  for (const [key, value] of Object.entries(metals)) {
    const n = parseNumericEntry(value);
    if (n !== null) entries[key] = n;
  }
  const pick = (keys) => {
    for (const key of keys) {
      if (entries[key] !== undefined) return entries[key];
    }
    return null;
  };
  const domestic = pick([
    "黄金_9999",
    "黄金9999",
    "黄金价格",
    "今日金价",
    "Au99.99",
    "国内金价",
    "黄金_T+D",
    "黄金T+D",
  ]);
  const xau = pick([
    "伦敦金",
    "伦敦现货金",
    "国际金价",
    "纽约黄金",
    "现货黄金",
    "XAU",
  ]);
  const result = {
    updatedAt: json.updated_at ?? json.updatedAt ?? json.update_time ?? json.time,
  };
  if (domestic) result.domestic = { price: domestic };
  if (xau) result.xau = { price: xau };
  if (json.stores !== undefined) result.stores = json.stores;
  if (json.banks !== undefined) result.banks = json.banks;
  if (json.recycle !== undefined) result.recycle = json.recycle;
  if (result.domestic || result.xau) return result;
  return null;
}

export function parseGoldApiQuote(json) {
  if (!json || typeof json !== "object") return null;
  const price = Number(json.price);
  if (!(price > 0)) return null;
  return {
    price,
    currency: json.currency || "USD",
    symbol: json.symbol || "XAU",
    name: json.name,
    time: json.updatedAt || json.updated_at || undefined,
    updatedAt: json.updatedAt || json.updated_at || undefined,
  };
}

export function parseGoldPriceTodayQuote(json) {
  if (!json || typeof json !== "object") return null;
  function find(value, depth = 0) {
    if (!value || typeof value !== "object" || depth > 8) return null;
    if (Array.isArray(value)) {
      for (const item of value) {
        const found = find(item, depth + 1);
        if (found) return found;
      }
      return null;
    }
    const xauNode = value.XAU ?? value.xau;
    if (xauNode) {
      const usdNode = xauNode.USD ?? xauNode.usd ?? xauNode;
      const direct = firstPositiveNumber(
        typeof usdNode === "object" ? usdNode?.price : usdNode,
        typeof usdNode === "object" ? usdNode?.latest : undefined,
        typeof usdNode === "object" ? usdNode?.value : undefined,
        typeof usdNode === "object" ? usdNode?.last : undefined,
        typeof usdNode === "object" ? usdNode?.rate : undefined,
        typeof xauNode === "object" ? xauNode?.price : xauNode,
        typeof xauNode === "object" ? xauNode?.latest : undefined,
        typeof xauNode === "object" ? xauNode?.value : undefined,
      );
      if (direct) return direct;
    }
    if ((value.symbol === "XAU" || value.code === "XAU" || value.name === "Gold") && Number.isFinite(Number(value.price))) {
      const direct = Number(value.price);
      if (direct > 0) return direct;
    }
    for (const key of Object.keys(value)) {
      const found = find(value[key], depth + 1);
      if (found) return found;
    }
    return null;
  }
  const price = find(json);
  if (!price) return null;
  return { price, currency: "USD", symbol: "XAU", time: json.updated_at || json.updatedAt || undefined, updatedAt: json.updated_at || json.updatedAt || undefined };
}

export function parseYahooFinanceQuote(json) {
  if (!json || typeof json !== "object") return null;
  const result = json?.chart?.result?.[0];
  if (!result || typeof result !== "object") return null;
  const meta = result.meta || {};
  let price = Number(meta.regularMarketPrice);
  if (!(price > 0)) {
    const closes = result?.indicators?.quote?.[0]?.close;
    if (Array.isArray(closes)) {
      for (let index = closes.length - 1; index >= 0; index -= 1) {
        const candidate = Number(closes[index]);
        if (Number.isFinite(candidate) && candidate > 0) {
          price = candidate;
          break;
        }
      }
    }
  }
  if (!(price > 0)) return null;
  const prevClose = Number(meta.chartPreviousClose ?? meta.previousClose ?? meta.regularMarketPreviousClose);
  return {
    price,
    prevClose: Number.isFinite(prevClose) && prevClose > 0 ? prevClose : undefined,
    time: meta.regularMarketTime
      ? new Date(Number(meta.regularMarketTime) * 1000).toISOString()
      : undefined,
    updatedAt: meta.regularMarketTime
      ? new Date(Number(meta.regularMarketTime) * 1000).toISOString()
      : undefined,
    currency: meta.currency || "USD",
    symbol: "GC=F",
  };
}

/**
 * Parse Yahoo Finance chart history into OHLC bars.
 * Yahoo returns epoch seconds in `timestamp` and parallel arrays in
 * `indicators.quote[0]` (open/high/low/close/volume).
 */
export function parseYahooFinanceKlines(json) {
  if (!json || typeof json !== "object") return [];
  const result = json?.chart?.result?.[0];
  if (!result || typeof result !== "object") return [];
  const timestamps = Array.isArray(result.timestamp) ? result.timestamp : [];
  const quote = result?.indicators?.quote?.[0] || {};
  const opens = Array.isArray(quote.open) ? quote.open : [];
  const highs = Array.isArray(quote.high) ? quote.high : [];
  const lows = Array.isArray(quote.low) ? quote.low : [];
  const closes = Array.isArray(quote.close) ? quote.close : [];
  const out = [];
  for (let index = 0; index < timestamps.length; index += 1) {
    const t = Number(timestamps[index]);
    const o = Number(opens[index]);
    const h = Number(highs[index]);
    const l = Number(lows[index]);
    const c = Number(closes[index]);
    if (!Number.isFinite(t) || !(o > 0) || !(h > 0) || !(l > 0) || !(c > 0)) continue;
    out.push({ t: t * 1000, o, h, l, c });
  }
  return out.sort((a, b) => a.t - b.t);
}

export function parseJijinhaoQuote(text) {
  let json = text;
  if (typeof text === "string") {
    const start = text.indexOf("{");
    const end = text.lastIndexOf("}");
    if (start >= 0 && end > start) {
      try {
        json = JSON.parse(text.slice(start, end + 1));
      } catch {
        return null;
      }
    } else {
      return null;
    }
  }
  if (!json || typeof json !== "object") return null;
  function find(value, depth = 0) {
    if (!value || typeof value !== "object" || depth > 8) return null;
    if (Array.isArray(value)) {
      for (const item of value) {
        const found = find(item, depth + 1);
        if (found) return found;
      }
      return null;
    }
    const price = firstPositiveNumber(value.q63);
    if (price) {
      return {
        price,
        name: value.name || value.q13 || value.q14 || value.code,
        code: value.code,
        time: value.time || value.q64 || value.q65 || undefined,
      };
    }
    for (const key of Object.keys(value)) {
      const found = find(value[key], depth + 1);
      if (found) return found;
    }
    return null;
  }
  return find(json);
}

export function parseJdGoldQuote(json) {
  if (!json || typeof json !== "object") return null;
  function find(value, depth = 0) {
    if (!value || typeof value !== "object" || depth > 8) return null;
    if (Array.isArray(value)) {
      for (const item of value) {
        const found = find(item, depth + 1);
        if (found) return found;
      }
      return null;
    }
    const price = firstPositiveNumber(
      value.price,
      value.latestPrice,
      value.salePrice,
      value.stdLatestPrice,
      value.currentPrice,
      value.amount,
    );
    if (price) {
      return {
        price,
        name: value.productName || value.skuName || value.name || value.goodsName,
        time: value.updateTime || value.updatedAt || value.time || undefined,
      };
    }
    for (const key of Object.keys(value)) {
      const found = find(value[key], depth + 1);
      if (found) return found;
    }
    return null;
  }
  return find(json);
}

export function parseCmbMarketCenterQuote(payload) {
  function find(value) {
    if (Array.isArray(value)) {
      for (const item of value) {
        const found = find(item);
        if (found) return found;
      }
      return null;
    }
    if (!value || typeof value !== "object") return null;
    if (Object.prototype.hasOwnProperty.call(value, "zBuyPrc") || Object.prototype.hasOwnProperty.call(value, "zSelPrc")) {
      const buy = Number(value.zBuyPrc);
      const sell = Number(value.zSelPrc);
      if (Number.isFinite(buy) && Number.isFinite(sell) && buy > 0 && sell > 0) {
        return { buyPrice: buy, sellPrice: sell };
      }
    }
    for (const key of Object.keys(value)) {
      const found = find(value[key]);
      if (found) return found;
    }
    return null;
  }

  const found = find(payload);
  if (!found) return null;
  const buyPrice = Math.round(found.buyPrice * 100) / 100;
  const sellPrice = Math.round(found.sellPrice * 100) / 100;
  const average = Math.round(((buyPrice + sellPrice) / 2) * 100) / 100;
  return {
    // CMB trend line is drawn from the customer buy price; average is kept
    // only for compatibility and is not used as the pricing formula.
    price: buyPrice,
    average,
    buyPrice,
    sellPrice,
  };
}

const CMB_API_URL = "https://mbmodule-openapi.paas.cmbchina.com/product/v1/func/market-center";
const CMB_API_PARAMS = JSON.stringify([{ prdType: "H", prdCode: "" }]);

export async function fetchCmbQuote() {
  const chain = quoteChain();
  return trackedCall({
    sourceId: "cmb-market-center",
    source: "cmb",
    kind: "cmb",
    url: CMB_API_URL,
  }, async () => {
    let lastError = null;
    // The upstream koishi plugin uses a form-encoded POST; also keep a JSON
    // POST and a GET fallback in case the endpoint only accepts those. The
    // three transports share one 12s chain budget instead of stacking 3×6s.
    const transports = [
      (timeoutMs) => fetchUtf8(CMB_API_URL, {
        method: "POST",
        headers: {
          "content-type": "application/x-www-form-urlencoded; charset=UTF-8",
          "user-agent": USER_AGENT,
          "referer": "https://mbmodule-openapi.paas.cmbchina.com/",
        },
        body: `params=${encodeURIComponent(CMB_API_PARAMS)}`,
      }, timeoutMs, chain.signal),
      (timeoutMs) => fetchUtf8(CMB_API_URL, {
        method: "POST",
        headers: {
          "content-type": "application/json; charset=UTF-8",
          "user-agent": USER_AGENT,
          "referer": "https://mbmodule-openapi.paas.cmbchina.com/",
        },
        body: JSON.stringify({ params: CMB_API_PARAMS }),
      }, timeoutMs, chain.signal),
      (timeoutMs) => fetchUtf8(`${CMB_API_URL}?params=${encodeURIComponent(CMB_API_PARAMS)}`, {
        headers: { "user-agent": USER_AGENT, "referer": "https://mbmodule-openapi.paas.cmbchina.com/" },
      }, timeoutMs, chain.signal),
    ];
    try {
      for (let index = 0; index < transports.length; index += 1) {
        const timeoutMs = chain.sourceTimeoutMs(transports.length - index);
        if (timeoutMs <= 0) break; // chain budget exhausted
        try {
          const text = await transports[index](timeoutMs);
          const parsed = parseCmbMarketCenterQuote(JSON.parse(text));
          if (parsed) return { ...parsed, source: "cmb" };
          lastError = new Error("CMB market center response did not contain zBuyPrc/zSelPrc");
        } catch (error) {
          lastError = error;
        }
      }
    } finally {
      chain.settle();
    }
    throw lastError ?? new Error("CMB quote fetch failed");
  });
}

// ── additional free quote sources ──────────────────────────────────────────

export async function fetchSgeQuote(opts = {}) {
  return trackedCall({
    sourceId: "sge-domestic",
    source: "sge",
    kind: "domestic",
    instrument: "AU9999",
    url: SGE_QUOTATIONS_URL,
  }, async () => {
    const text = await fetchUtf8(SGE_QUOTATIONS_URL, {
      method: "POST",
      headers: {
        "content-type": "application/x-www-form-urlencoded; charset=UTF-8",
        "referer": "https://www.sge.com.cn/sjzx/mrhq",
        "user-agent": USER_AGENT,
      },
      body: "instid=Au99.99",
    }, opts.timeoutMs ?? QUOTE_TIMEOUT_MS, opts.signal ?? null);
    const parsed = parseSgeQuote(JSON.parse(text));
    return parsed ? { ...parsed, source: "sge" } : null;
  });
}

export async function fetchSgeDailyBars() {
  return trackedCall({
    sourceId: "sge-history",
    source: "sge",
    kind: "history",
    instrument: null,
    url: SGE_DAILY_URL,
  }, async () => {
    const text = await fetchUtf8(SGE_DAILY_URL, {
      method: "POST",
      headers: {
        "content-type": "application/x-www-form-urlencoded; charset=UTF-8",
        "referer": "https://www.sge.com.cn/sjzx/mrhq",
        "user-agent": USER_AGENT,
      },
      body: "instid=Au99.99",
    }, QUOTE_TIMEOUT_MS);
    return parseSgeDailyBars(JSON.parse(text));
  });
}

let sixtySecondsInflight = null;

async function fetchSixtySecondsRaw(opts = {}) {
  if (!sixtySecondsInflight) {
    sixtySecondsInflight = (async () => {
      const text = await fetchUtf8(SIXTY_SECONDS_URL, {
        headers: { "user-agent": USER_AGENT },
      }, opts.timeoutMs ?? QUOTE_TIMEOUT_MS, opts.signal ?? null);
      return parseSixtySecondsGoldPrice(JSON.parse(text));
    })().finally(() => {
      sixtySecondsInflight = null;
    });
  }
  return sixtySecondsInflight;
}

export async function fetchSixtySecondsQuote(sourceId = "sixty-domestic", kind = "domestic", instrument = "AU9999", opts = {}) {
  return trackedCall({
    sourceId,
    source: "60s",
    kind,
    instrument,
    url: SIXTY_SECONDS_URL,
  }, async () => {
    const parsed = await fetchSixtySecondsRaw(opts);
    return parsed ? { ...parsed, source: "60s" } : null;
  });
}

export async function fetchGoldApiQuote(opts = {}) {
  return trackedCall({
    sourceId: "gold-api-xau",
    source: "gold-api",
    kind: "xau",
    instrument: "XAU",
    url: GOLD_API_URL,
  }, async () => {
    const text = await fetchUtf8(GOLD_API_URL, {
      headers: { "user-agent": USER_AGENT },
    }, opts.timeoutMs ?? QUOTE_TIMEOUT_MS, opts.signal ?? null);
    const parsed = parseGoldApiQuote(JSON.parse(text));
    return parsed ? { ...parsed, source: "gold-api" } : null;
  });
}

export async function fetchGoldPriceTodayQuote(opts = {}) {
  return trackedCall({
    sourceId: "goldprice-today-xau",
    source: "goldprice-today",
    kind: "xau",
    instrument: "XAU",
    url: GOLD_PRICE_TODAY_URL,
  }, async () => {
    const text = await fetchUtf8(GOLD_PRICE_TODAY_URL, {
      headers: { "user-agent": USER_AGENT },
    }, opts.timeoutMs ?? QUOTE_TIMEOUT_MS, opts.signal ?? null);
    const parsed = parseGoldPriceTodayQuote(JSON.parse(text));
    return parsed ? { ...parsed, source: "goldprice-today" } : null;
  });
}

export async function fetchYahooXauQuote(opts = {}) {
  return trackedCall({
    sourceId: "yahoo-xau",
    source: "yahoo",
    kind: "xau",
    instrument: "XAU",
    url: YAHOO_XAU_URL,
  }, async () => {
    const text = await fetchUtf8(YAHOO_XAU_URL, {
      headers: { "user-agent": USER_AGENT, "accept": "application/json" },
    }, opts.timeoutMs ?? QUOTE_TIMEOUT_MS, opts.signal ?? null);
    const parsed = parseYahooFinanceQuote(JSON.parse(text));
    return parsed ? { ...parsed, source: "yahoo" } : null;
  });
}

export async function fetchYahooXauDailyBars() {
  return trackedCall({
    sourceId: "yahoo-history-xau",
    source: "yahoo",
    kind: "history",
    instrument: null,
    url: YAHOO_XAU_HISTORY_URL,
  }, async () => {
    const text = await fetchUtf8(YAHOO_XAU_HISTORY_URL, {
      headers: { "user-agent": USER_AGENT, "accept": "application/json" },
    }, FETCH_TIMEOUT_MS);
    return parseYahooFinanceKlines(JSON.parse(text));
  });
}

export async function fetchJijinhaoQuote() {
  return trackedCall({
    sourceId: "jijinhao-brand",
    source: "jijinhao",
    kind: "brand",
    instrument: null,
    url: JIJINHAO_URL,
  }, async () => {
    const text = await fetchUtf8(JIJINHAO_URL, {
      headers: {
        "referer": "https://quote.cngold.org/",
        "user-agent": USER_AGENT,
      },
    }, QUOTE_TIMEOUT_MS);
    const parsed = parseJijinhaoQuote(text);
    return parsed ? { ...parsed, source: "jijinhao" } : null;
  });
}

export async function fetchJdGoldQuote() {
  return trackedCall({
    sourceId: "jdjy-gold",
    source: "jdjy",
    kind: "cmb",
    instrument: null,
    url: JD_GOLD_URL,
  }, async () => {
    const text = await fetchUtf8(JD_GOLD_URL, {
      headers: { "user-agent": USER_AGENT },
    }, QUOTE_TIMEOUT_MS);
    const parsed = parseJdGoldQuote(JSON.parse(text));
    return parsed ? { ...parsed, source: "jdjy" } : null;
  });
}

// ── quote collection ───────────────────────────────────────────────────────

// One shared deadline per fallback chain. Previously each source stacked its
// own full 6s timeout, so a dead domestic chain could block a tick for ~24s
// (XAU chain: ~42s). Now a source's timeout is its share of the remaining
// budget, clamped to [3.5s, 6s] and never above the remaining budget; once
// the budget is gone the rest of the chain is skipped. The chain's
// AbortController is aborted when the chain settles (first success or
// exhaustion), so no request or half-read body outlives it.
const QUOTE_CHAIN_BUDGET_MS = 12_000;
const QUOTE_MIN_SOURCE_TIMEOUT_MS = 3_500;

// Production constants above; the live values are mutable only through
// __setQuoteChainTiming so latency tests can shrink them.
let quoteChainBudgetMs = QUOTE_CHAIN_BUDGET_MS;
let quoteChainMinSourceTimeoutMs = QUOTE_MIN_SOURCE_TIMEOUT_MS;

/** Test-only hook: override chain budget / per-source timeout floor. Returns the previous values. */
export function __setQuoteChainTiming(opts = {}) {
  const previous = { budgetMs: quoteChainBudgetMs, minSourceTimeoutMs: quoteChainMinSourceTimeoutMs };
  if (Number.isFinite(opts.budgetMs)) quoteChainBudgetMs = Math.max(1, opts.budgetMs);
  if (Number.isFinite(opts.minSourceTimeoutMs)) quoteChainMinSourceTimeoutMs = Math.max(1, opts.minSourceTimeoutMs);
  return previous;
}

function quoteChain(totalMs = quoteChainBudgetMs) {
  const controller = new AbortController();
  const deadline = Date.now() + totalMs;
  return {
    signal: controller.signal,
    remainingMs() {
      return deadline - Date.now();
    },
    /** Per-source timeout for an attempt with `sourcesLeft` sources remaining. */
    sourceTimeoutMs(sourcesLeft) {
      const remaining = this.remainingMs();
      if (remaining <= quoteChainMinSourceTimeoutMs) return 0;
      const share = Math.ceil(remaining / Math.max(1, sourcesLeft));
      return Math.min(Math.max(share, quoteChainMinSourceTimeoutMs), QUOTE_TIMEOUT_MS, remaining);
    },
    /** Abort everything still attached to this chain (idempotent). */
    settle() {
      controller.abort(new Error("quote chain settled"));
    },
  };
}

export async function fetchDomesticQuote(now = new Date()) {
  const chain = quoteChain();
  // sina → SGE → eastmoney → 60s, sharing one 12s budget.
  const attempts = [
    // 1: sina (stale check inside the tracked call)
    async (timeoutMs) => trackedCall({
      sourceId: "sina-domestic",
      source: "sina",
      kind: "domestic",
      url: "https://hq.sinajs.cn/list=gds_AU9999",
    }, async () => {
      const text = await fetchGb18030("https://hq.sinajs.cn/list=gds_AU9999", {
        headers: { Referer: "https://finance.sina.com.cn/", "User-Agent": USER_AGENT },
      }, timeoutMs, chain.signal);
      const parsed = parseSinaDomesticQuote(text);
      if (parsed && !isDomesticQuoteFresh(parsed, now)) {
        const error = new Error(`stale domestic quote: ${parsed.date} ${parsed.time}`);
        error.code = "STALE_QUOTE";
        throw error;
      }
      return parsed ? { ...parsed, source: "sina" } : null;
    }),
    // 2: SGE (stale check after the tracked call)
    async (timeoutMs) => {
      const quote = await fetchSgeQuote({ timeoutMs, signal: chain.signal });
      if (quote && !isDomesticQuoteFresh(quote, now)) {
        const error = new Error(`stale SGE domestic quote: ${quote.time ?? quote.date ?? ""}`);
        error.code = "STALE_QUOTE";
        throw error;
      }
      return quote;
    },
    // 3: eastmoney (stale check inside the tracked call)
    async (timeoutMs) => trackedCall({
      sourceId: "eastmoney-domestic",
      source: "eastmoney",
      kind: "domestic",
      url: "https://push2.eastmoney.com/api/qt/stock/get?secid=118.AU9999",
    }, async () => {
      const text = await fetchUtf8(
        "https://push2.eastmoney.com/api/qt/stock/get?secid=118.AU9999&fields=f43,f44,f45,f46,f60,f86,f170",
        { headers: { Referer: "https://quote.eastmoney.com/", "User-Agent": USER_AGENT } },
        timeoutMs,
        chain.signal,
      );
      const parsed = parseEastmoneyDomesticQuote(JSON.parse(text));
      if (parsed && !isDomesticQuoteFresh(parsed, now)) {
        const error = new Error(`stale domestic quote: ${parsed.time}`);
        error.code = "STALE_QUOTE";
        throw error;
      }
      return parsed ? { ...parsed, source: "eastmoney" } : null;
    }),
    // 4: 60s aggregate
    async (timeoutMs) => {
      const aggregate = await fetchSixtySecondsQuote("sixty-domestic", "domestic", "AU9999", { timeoutMs, signal: chain.signal });
      const domestic = aggregate?.domestic;
      if (domestic && Number.isFinite(domestic.price) && domestic.price > 0) {
        return {
          ...domestic,
          source: "60s",
          time: aggregate.updatedAt || undefined,
        };
      }
      return null;
    },
  ];
  try {
    for (let index = 0; index < attempts.length; index += 1) {
      const timeoutMs = chain.sourceTimeoutMs(attempts.length - index);
      if (timeoutMs <= 0) break; // chain budget exhausted
      try {
        const quote = await attempts[index](timeoutMs);
        if (quote) return quote;
      } catch {
        // fall through to the next source
      }
    }
    return null;
  } finally {
    // First success or full exhaustion: nothing of this chain may outlive it.
    chain.settle();
  }
}

async function fetchXauQuote() {
  const chain = quoteChain();
  // tencent → sina XAU → gold-api → 60s → goldprice.today → yahoo GC=F,
  // sharing one 12s budget (previously up to ~42s of stacked timeouts).
  const attempts = [
    async (timeoutMs) => trackedCall({
      sourceId: "tencent-xau",
      source: "tencent",
      kind: "xau",
      url: "https://qt.gtimg.cn/q=hf_XAU",
    }, async () => {
      const text = await fetchGb18030("https://qt.gtimg.cn/q=hf_XAU", {
        headers: { "User-Agent": USER_AGENT },
      }, timeoutMs, chain.signal);
      const parsed = parseTencentXauQuote(text);
      return parsed ? { ...parsed, source: "tencent" } : null;
    }),
    async (timeoutMs) => trackedCall({
      sourceId: "sina-xau",
      source: "sina",
      kind: "xau",
      url: "https://hq.sinajs.cn/list=hf_XAU",
    }, async () => {
      const text = await fetchGb18030("https://hq.sinajs.cn/list=hf_XAU", {
        headers: { Referer: "https://finance.sina.com.cn/", "User-Agent": USER_AGENT },
      }, timeoutMs, chain.signal);
      const parsed = parseTencentXauQuote(text);
      return parsed ? { ...parsed, source: "sina" } : null;
    }),
    async (timeoutMs) => fetchGoldApiQuote({ timeoutMs, signal: chain.signal }),
    async (timeoutMs) => {
      const aggregate = await fetchSixtySecondsQuote("sixty-xau", "xau", "XAU", { timeoutMs, signal: chain.signal });
      const xau = aggregate?.xau;
      if (xau && Number.isFinite(xau.price) && xau.price > 0) {
        return {
          ...xau,
          source: "60s",
          time: aggregate.updatedAt || undefined,
        };
      }
      return null;
    },
    async (timeoutMs) => fetchGoldPriceTodayQuote({ timeoutMs, signal: chain.signal }),
    async (timeoutMs) => fetchYahooXauQuote({ timeoutMs, signal: chain.signal }),
  ];
  try {
    for (let index = 0; index < attempts.length; index += 1) {
      const timeoutMs = chain.sourceTimeoutMs(attempts.length - index);
      if (timeoutMs <= 0) break; // chain budget exhausted
      try {
        const quote = await attempts[index](timeoutMs);
        if (quote) return quote;
      } catch {
        // fall through to the next source
      }
    }
    return null;
  } finally {
    chain.settle();
  }
}

async function fetchUsdcnyQuote() {
  const chain = quoteChain();
  try {
    const timeoutMs = chain.sourceTimeoutMs(1);
    if (timeoutMs <= 0) return null;
    return await trackedCall({
      sourceId: "tencent-usdcny",
      source: "tencent",
      kind: "usdcny",
      url: "https://qt.gtimg.cn/q=whUSDCNY",
    }, async () => {
      const text = await fetchGb18030("https://qt.gtimg.cn/q=whUSDCNY", {
        headers: { "User-Agent": USER_AGENT },
      }, timeoutMs, chain.signal);
      const parsed = parseTencentForexQuote(text);
      return parsed ? { ...parsed, source: "tencent" } : null;
    });
  } catch {
    return null;
  } finally {
    chain.settle();
  }
}

async function fetchEastmoneyBars(secid, klt, limit = 120) {
  const sourceId = secid === "118.AU9999" ? "eastmoney-kline-au" : secid === "122.XAU" ? "eastmoney-kline-xau" : "eastmoney-kline-au";
  const url =
    `https://push2his.eastmoney.com/api/qt/stock/kline/get?secid=${secid}&klt=${klt}&fqt=1&lmt=${limit}` +
    "&end=20500101&iscca=1&fields1=f1,f2,f3,f4,f5,f6,f7,f8&fields2=f51,f52,f53,f54,f55,f56,f57,f58";
  return trackedCall({
    sourceId,
    source: "eastmoney",
    kind: "history",
    url,
  }, async () => {
    const text = await fetchUtf8(url, {
      headers: { Referer: "https://quote.eastmoney.com/", "User-Agent": USER_AGENT },
    });
    return parseEastmoneyKlines(JSON.parse(text));
  });
}

// ── bars ───────────────────────────────────────────────────────────────────

function alignStart(timestamp, intervalMinutes) {
  if (intervalMinutes === 1440) {
    // Daily bars are aligned to Beijing calendar dates so SGE/Eastmoney/Yahoo
    // history can share one consistent timeline.
    const shifted = new Date(timestamp + 8 * 60 * 60 * 1000);
    const date = shifted.toISOString().slice(0, 10);
    return Date.parse(`${date}T00:00:00+08:00`);
  }
  const span = intervalMinutes * 60_000;
  return Math.floor(timestamp / span) * span;
}

function upsertBar(list, bar) {
  const last = list[list.length - 1];
  if (last && last.t === bar.t) {
    last.h = Math.max(last.h, bar.h);
    last.l = Math.min(last.l, bar.l);
    last.c = bar.c;
    last.synthetic = last.synthetic === true || bar.synthetic === true;
    for (const key of ["source", "instrument", "market", "currency", "unit"]) {
      if (bar[key] !== undefined) last[key] = bar[key];
    }
    return;
  }
  list.push(bar);
  if (list.length > MAX_BARS) list.splice(0, list.length - MAX_BARS);
}

function recordTick(bars, quote, timestamp) {
  if (!bars) return;
  for (const interval of BAR_INTERVALS) {
    const list = bars[interval];
    if (!list) continue;
    const t = alignStart(timestamp, interval);
    const bar = normalizeBarRecord(
      { t, o: quote.price, h: quote.price, l: quote.price, c: quote.price, synthetic: true },
      quote,
    );
    if (bar) upsertBar(list, bar);
  }
}

function ensureBars(bars) {
  const source = bars && typeof bars === "object" ? bars : {};
  const out = {};
  for (const interval of BAR_INTERVALS) {
    out[interval] = Array.isArray(source[interval])
      ? source[interval].map((bar) => normalizeBarRecord(bar)).filter(Boolean).sort((a, b) => a.t - b.t).slice(-MAX_BARS)
      : [];
  }
  return out;
}

/**
 * Drop bars persisted by an older seeding format. State written before
 * `BARS_SEED_VERSION` (or without the field) carries corrupt 60m buckets in
 * the AU9999/XAU lanes; their [5] and [60] series are discarded so the
 * fixed seedBars rebuilds them on the next tick. Other lanes and intervals
 * are preserved. Returns true when a migration was applied.
 */
export function migrateBarsSeedVersion(bars, savedVersion) {
  if (savedVersion === BARS_SEED_VERSION) return false;
  for (const lane of ["AU9999", "XAU"]) {
    const laneBars = bars && typeof bars === "object" ? bars[lane] : null;
    if (!laneBars || typeof laneBars !== "object") continue;
    if (Array.isArray(laneBars[5])) laneBars[5].length = 0;
    if (Array.isArray(laneBars[60])) laneBars[60].length = 0;
  }
  return true;
}

function seedBars(bars, klines, metadata = {}, now = new Date()) {
  mergeKlines(bars[5], klines, 5, metadata);
  aggregateSubBars(bars[60], klines, 60, metadata, now);
}

function mergeKlines(list, klines, intervalMinutes, metadata = {}) {
  const byTime = new Map();
  for (const raw of list) {
    const bar = normalizeBarRecord(raw);
    if (bar) byTime.set(bar.t, bar);
  }
  for (const raw of klines) {
    const normalized = normalizeBarRecord(raw, { ...metadata, synthetic: false });
    if (!normalized) continue;
    const t = alignStart(normalized.t, intervalMinutes);
    const bar = { ...normalized, t, synthetic: false };
    const existing = byTime.get(t);
    if (existing) {
      existing.o = bar.o;
      existing.h = bar.h;
      existing.l = bar.l;
      existing.c = bar.c;
      existing.synthetic = false;
      for (const key of ["source", "instrument", "market", "currency", "unit"]) {
        if (bar[key] !== undefined) existing[key] = bar[key];
      }
    } else {
      byTime.set(t, bar);
    }
  }
  const merged = Array.from(byTime.values()).sort((a, b) => a.t - b.t);
  list.length = 0;
  list.push(...merged.slice(-MAX_BARS));
}

/**
 * Build `intervalMinutes` buckets from finer sub-bar klines (e.g. 5m → 60m)
 * with true OHLC aggregation. Unlike mergeKlines — which would leave each
 * bucket holding only the last sub-bar's OHLC — this merges every completed
 * bucket: o = first sub-bar open, h = max high, l = min low, c = last close.
 * Only buckets that have fully ended (bucket start + interval <= now) are
 * produced; the still-open hour is left to the recordTick quote path so no
 * half-built bucket is ever seeded. Metadata comes from the first sub-bar of
 * each bucket and synthetic stays false.
 */
function aggregateSubBars(list, subKlines, intervalMinutes, metadata = {}, now = new Date()) {
  const nowMs = new Date(now).getTime();
  const spanMs = intervalMinutes * 60_000;
  const byTime = new Map();
  // Existing buckets (e.g. tick-recorded synthetic hours) survive unless the
  // aggregated seed history covers the same bucket.
  for (const raw of list) {
    const bar = normalizeBarRecord(raw);
    if (bar) byTime.set(bar.t, bar);
  }
  const buckets = new Map();
  for (const raw of subKlines) {
    const normalized = normalizeBarRecord(raw, { ...metadata, synthetic: false });
    if (!normalized) continue;
    const t = alignStart(normalized.t, intervalMinutes);
    if (t + spanMs > nowMs) continue; // skip the still-open bucket
    const existing = buckets.get(t);
    if (!existing) {
      buckets.set(t, {
        t,
        o: normalized.o,
        h: normalized.h,
        l: normalized.l,
        c: normalized.c,
        source: normalized.source,
        instrument: normalized.instrument,
        market: normalized.market,
        currency: normalized.currency,
        unit: normalized.unit,
        synthetic: false,
      });
      continue;
    }
    existing.h = Math.max(existing.h, normalized.h);
    existing.l = Math.min(existing.l, normalized.l);
    existing.c = normalized.c;
  }
  for (const [t, bar] of buckets) byTime.set(t, bar);
  mergeBarMap(list, byTime);
}

/** Replace `list` with `byTime` bars sorted by time and capped at MAX_BARS. */
function mergeBarMap(list, byTime) {
  const merged = Array.from(byTime.values()).sort((a, b) => a.t - b.t);
  list.length = 0;
  list.push(...merged.slice(-MAX_BARS));
}

export { aggregateSubBars, mergeKlines, seedBars, BARS_SEED_VERSION };

/**
 * Detect missing intraday 5m bars. A gap between two recent bars is treated
 * as missing when it is larger than one normal interval but still within a
 * single session (less than 6 hours), which avoids treating overnight and
 * weekend breaks as something to backfill.
 */
function hasMissingRecentBars(list, now, intervalMinutes = 5) {
  if (!Array.isArray(list) || list.length === 0) return false;
  const span = intervalMinutes * 60_000;
  const maxGapMs = 6 * 60 * 60 * 1000;
  const dayMs = 24 * 60 * 60 * 1000;
  for (let index = 1; index < list.length; index += 1) {
    const prev = list[index - 1];
    const bar = list[index];
    if (!prev || !bar) continue;
    if (now - bar.t > dayMs) continue;
    const gap = bar.t - prev.t;
    if (gap > span * 1.5 && gap < maxGapMs) return true;
  }
  return false;
}

/**
 * Detect missing leading 5m bars at the start of the current Beijing day.
 * For example, if the first bar of the day is 00:10, 00:00/00:05 are missing
 * and should be backfilled when a later quote arrives.
 */
function hasMissingLeadingBars(list, now, intervalMinutes = 5) {
  if (!Array.isArray(list) || list.length === 0) return false;
  const span = intervalMinutes * 60_000;
  const maxGapMs = 6 * 60 * 60 * 1000;
  const nowDate = now instanceof Date ? now : new Date(now);
  const today = beijingDateForNow(nowDate);
  let first = null;
  for (const bar of list) {
    if (!bar) continue;
    if (beijingDateForNow(new Date(bar.t)) === today) {
      first = bar;
      break;
    }
  }
  if (!first) return false;
  const firstParts = beijingParts(new Date(first.t));
  const midnight = Date.UTC(firstParts.date.slice(0, 4), Number(firstParts.date.slice(5, 7)) - 1, Number(firstParts.date.slice(8, 10))) - 8 * 60 * 60 * 1000;
  const gap = first.t - midnight;
  return gap > span * 1.5 && gap < maxGapMs;
}

/**
 * Parse user-supplied CMB minute prices from either a text block
 * ("HH:mm price" or "YYYY-MM-DD HH:mm price" per line) or an array of
 * `{ time, price }` objects. Returns entries aligned to 1-minute buckets.
 */
export function parseManualCmbMinuteEntries(input, now = new Date()) {
  const nowDate = now instanceof Date ? now : new Date(now);
  const entries = [];
  const errors = [];
  const pushError = (message) => {
    if (errors.length < 20) errors.push(message);
  };
  const handle = (timeText, priceText, raw) => {
    const ts = parseQuoteTimestamp({ time: timeText }, nowDate);
    const price = Number(priceText);
    if (!ts) {
      pushError(`无法解析时间：${raw || timeText}`);
      return;
    }
    if (!Number.isFinite(price) || price <= 0) {
      pushError(`价格无效：${raw || priceText}`);
      return;
    }
    entries.push({
      t: alignStart(ts, 1),
      price: Math.round(price * 100) / 100,
      raw: raw || `${timeText} ${priceText}`,
    });
  };

  if (typeof input === "string") {
    const lines = input.split(/\r?\n/);
    lines.forEach((line, index) => {
      const trimmed = line.trim();
      if (!trimmed) return;
      const parts = trimmed.split(/\s+/);
      if (parts.length === 2) {
        handle(parts[0], parts[1], trimmed);
      } else if (parts.length >= 3 && /^\d{4}-\d{2}-\d{2}$/.test(parts[0])) {
        handle(`${parts[0]} ${parts[1]}`, parts[2], trimmed);
      } else {
        pushError(`第 ${index + 1} 行格式应为 "HH:mm 价格"：${trimmed}`);
      }
    });
  } else if (Array.isArray(input)) {
    input.forEach((item, index) => {
      if (!item || typeof item !== "object") {
        pushError(`第 ${index + 1} 条格式无效`);
        return;
      }
      const timeText = item.time ?? item.minute ?? item.datetime;
      const priceText = item.price;
      if (timeText === undefined || priceText === undefined) {
        pushError(`第 ${index + 1} 条缺少 time/price`);
        return;
      }
      handle(String(timeText), String(priceText), `${timeText} ${priceText}`);
    });
  } else if (input && typeof input === "object") {
    for (const [timeText, priceText] of Object.entries(input)) {
      if (timeText === undefined || priceText === undefined) continue;
      handle(String(timeText), String(priceText), `${timeText} ${priceText}`);
    }
  } else {
    pushError("输入格式不支持");
  }

  return { entries, errors };
}

/**
 * Insert manual CMB 1-minute prices into runtime bars without overwriting
 * existing bars. Missing higher-interval buckets (5/15/60/1440) are rebuilt
 * from the available 1-minute bars so coverage and indicators can use them.
 */
export function applyManualCmbMinuteBars(runtime, entries, config, now = new Date()) {
  const nowDate = now instanceof Date ? now : new Date(now);
  const today = beijingDateForNow(nowDate);
  const cmb = runtime?.bars?.CMB;
  if (!cmb || !Array.isArray(entries)) return { added: 0, skipped: 0 };
  const cmb1 = Array.isArray(cmb[1]) ? cmb[1] : (cmb[1] = []);
  const existing = new Map(cmb1.map((bar) => [bar.t, bar]));
  let added = 0;
  let skipped = 0;

  for (const entry of entries) {
    const t = alignStart(Number(entry.t), 1);
    if (!Number.isFinite(t)) {
      skipped += 1;
      continue;
    }
    if (beijingDateForNow(new Date(t)) !== today) {
      skipped += 1;
      continue;
    }
    if (t > nowDate.getTime()) {
      skipped += 1;
      continue;
    }
    if (!isOpenMinute(config, t)) {
      skipped += 1;
      continue;
    }
    if (existing.has(t)) {
      skipped += 1;
      continue;
    }
    const price = Math.round(Number(entry.price) * 100) / 100;
    const bar = normalizeBarRecord(
      { t, o: price, h: price, l: price, c: price, ...CMB_BAR_META },
      CMB_BAR_META,
    );
    if (!bar) {
      skipped += 1;
      continue;
    }
    cmb1.push(bar);
    existing.set(t, bar);
    added += 1;
  }

  if (added > 0) {
    cmb1.sort((a, b) => a.t - b.t);
    if (cmb1.length > MAX_BARS) cmb1.splice(0, cmb1.length - MAX_BARS);

    for (const interval of [5, 15, 60, 1440]) {
      const list = Array.isArray(cmb[interval]) ? cmb[interval] : (cmb[interval] = []);
      const existingInterval = new Map(list.map((bar) => [bar.t, bar]));
      const groups = new Map();
      for (const bar of cmb1) {
        if (!bar || beijingDateForNow(new Date(bar.t)) !== today) continue;
        const bucket = alignStart(bar.t, interval);
        if (existingInterval.has(bucket)) continue;
        if (!groups.has(bucket)) groups.set(bucket, []);
        groups.get(bucket).push(bar);
      }
      for (const [bucket, bars] of groups) {
        const bar = normalizeBarRecord(
          {
            t: bucket,
            o: bars[0].o,
            h: Math.max(...bars.map((item) => item.h)),
            l: Math.min(...bars.map((item) => item.l)),
            c: bars[bars.length - 1].c,
            ...CMB_BAR_META,
          },
          CMB_BAR_META,
        );
        if (bar) list.push(bar);
      }
      if (list.length > 0) {
        list.sort((a, b) => a.t - b.t);
        if (list.length > MAX_BARS) list.splice(0, list.length - MAX_BARS);
      }
    }
  }

  return { added, skipped };
}

/**
 * List today's Beijing-time minutes (up to now) that are inside the configured
 * trading session but do not yet have a CMB 1-minute bar. Used by the settings
 * page to let users quickly fill the missing minute prices.
 */
export function listMissingCmbMinuteSlots(runtime, config, now = new Date()) {
  const nowDate = now instanceof Date ? now : new Date(now);
  const today = beijingDateForNow(nowDate);
  const cmb1 = Array.isArray(runtime?.bars?.CMB?.[1]) ? runtime.bars.CMB[1] : [];
  const existing = new Set(cmb1.map((bar) => alignStart(Number(bar.t), 1)));
  const calendar = buildSessionCalendar(config);
  const slots = [];
  const midnight = Date.parse(`${today}T00:00:00+08:00`);
  const end = alignStart(nowDate.getTime(), 1);
  for (let t = midnight; t <= end; t += 60_000) {
    if (!isOpenMinute(calendar, t)) continue;
    if (existing.has(t)) continue;
    const parts = beijingParts(new Date(t));
    const hh = String(Math.floor(parts.minutes / 60)).padStart(2, "0");
    const mm = String(parts.minutes % 60).padStart(2, "0");
    slots.push(`${hh}:${mm}`);
  }
  return { date: today, slots };
}




// ── data coverage & multi-timeframe resampling (5/10/30/60) ────────────────

const PLAN_WINDOWS = Object.freeze([5, 10, 30, 60]);
// 开盘后 1 小时内 30/60 分钟窗口天然不足，只校验 5/10 分钟窗口；数据参考仍尽量覆盖 5/10/30/60。
// 每天北京时间 00:00-01:00 也处于较长周期窗口天然不足的阶段，同样只校验 5/10 分钟窗口。
const SESSION_WARMUP_MS = 60 * 60_000;
const MIDNIGHT_WINDOW_END_MINUTES = 60;

/**
 * Pre-parsed trading-session calendar: everything `isOpenMinute` needs,
 * computed once per config object instead of once per minute checked.
 *
 * Callers that check thousands of minutes per snapshot (windowCoverage,
 * filterBarsToTradingHours, listMissingCmbMinuteSlots) previously re-ran
 * `normalizeConfig` — a deep clone — for every single minute. The result is
 * memoized by input object identity (`WeakMap`): the runtime only ever
 * replaces `runtime.config` wholesale on settings save / load, so identity
 * is a safe cache key, and the WeakMap lets stale configs be GC'd.
 */
const sessionCalendarCache = new WeakMap();

export function buildSessionCalendar(config) {
  if (config && typeof config === "object" && sessionCalendarCache.has(config)) {
    return sessionCalendarCache.get(config);
  }
  const cfg = normalizeConfig(config);
  const calendar = {
    openMin: parseTime(cfg.tradingHours.open, 9 * 60),
    closeMin: parseTime(cfg.tradingHours.close, 26 * 60),
    weekdaysOnly: cfg.tradingHours.weekdaysOnly === true,
    holidaySet: new Set(cfg.tradingHours.holidays ?? []),
  };
  if (config && typeof config === "object") sessionCalendarCache.set(config, calendar);
  return calendar;
}

/** Calendar-aware weekday/holiday test (pure counterpart of isTradingDate). */
function calendarTradeable(calendar, date, day) {
  if (calendar.holidaySet.has(date)) return false;
  if (!calendar.weekdaysOnly) return true;
  return day >= 1 && day <= 5;
}

/**
 * Return true when a Beijing-time minute is inside a configured trading
 * session. A session that closes after midnight (e.g. 09:00 -> 26:00) also
 * covers the early hours of the next calendar day before `close - 24h`.
 *
 * Accepts a prebuilt calendar (preferred: build once per snapshot via
 * buildSessionCalendar) or a raw config for convenience.
 */
export function isOpenMinute(calendarOrConfig, timestamp) {
  const calendar = calendarOrConfig && Number.isFinite(calendarOrConfig.openMin)
    ? calendarOrConfig
    : buildSessionCalendar(calendarOrConfig);
  const parts = beijingParts(new Date(timestamp));
  const todayTradeable = calendarTradeable(calendar, parts.date, parts.day);
  const yesterdayDate = dateStringForOffset(parts.date, -1);
  const yesterdayDay = (parts.day + 6) % 7;
  const yesterdayTradeable = calendarTradeable(calendar, yesterdayDate, yesterdayDay);
  const todayClose = Math.min(calendar.closeMin, 1440);
  if (todayTradeable && parts.minutes >= calendar.openMin && parts.minutes < todayClose) return true;
  if (yesterdayTradeable && calendar.closeMin > 1440 && parts.minutes < calendar.closeMin - 1440) return true;
  return false;
}

/** Keep only bars whose start time falls inside configured trading hours. */
export function filterBarsToTradingHours(bars, config) {
  if (!Array.isArray(bars)) return [];
  const calendar = buildSessionCalendar(config);
  return bars.filter((bar) => bar && Number.isFinite(bar.t) && isOpenMinute(calendar, bar.t));
}

/**
 * Per-minute coverage of a 1-minute bar list over the last `minutes` minutes
 * ending at `now`. Each minute is expected to carry one price point (the host
 * polls ~30s so a 1m bar is recorded per minute); a point counts as valid when
 * a 1-minute bar with a finite, positive close exists for that minute.
 * Returns a ratio in [0, 1].
 *
 * When `config` is provided, the window is measured in *trading minutes*: the
 * configured closed period (e.g. 02:00-09:00) is skipped, so a 09:xx session
 * can reuse data from the previous session before 02:00.
 */
export function windowCoverage(bars1m, now, minutes, config) {
  if (!Array.isArray(bars1m) || !(minutes > 0)) return 0;
  const end = alignStart(now, 1);
  if (config) {
    const calendar = buildSessionCalendar(config);
    const slots = [];
    let cursor = end;
    // Safety net: never scan more than 10 days even with long holidays/weekends.
    const maxScanMs = 10 * 24 * 60 * 60 * 1000;
    const scanEnd = end - maxScanMs;
    while (slots.length < minutes && cursor > scanEnd) {
      if (isOpenMinute(calendar, cursor)) slots.push(cursor);
      cursor -= 60_000;
    }
    if (slots.length === 0) return 0;
    const byMinute = new Map();
    for (const bar of bars1m) {
      if (!bar || !Number.isFinite(bar.t) || !Number.isFinite(bar.c) || !(bar.c > 0)) continue;
      byMinute.set(alignStart(bar.t, 1), true);
    }
    let valid = 0;
    for (const slot of slots) {
      if (byMinute.has(slot)) valid += 1;
    }
    return valid / slots.length;
  }
  const start = end - (minutes - 1) * 60_000;
  let valid = 0;
  for (const bar of bars1m) {
    if (!bar || !Number.isFinite(bar.t)) continue;
    if (bar.t < start || bar.t > end) continue;
    if (Number.isFinite(bar.c) && bar.c > 0) valid += 1;
  }
  return valid / minutes;
}

/**
 * Data-quality gate for the plan: every active window (default PLAN_WINDOWS)
 * must exceed its coverage threshold (80% for 5/10m, 60% for 30/60m),
 * otherwise no suggestion may be emitted (the board should tell the user data is missing
 * instead). Coverage for all PLAN_WINDOWS is still reported for display.
 */
export function coverageGate(bars1m, now, windows = PLAN_WINDOWS, config = null) {
  // Allow `coverageGate(bars, now, config)` as a convenient shorthand.
  if (windows && typeof windows === "object" && !Array.isArray(windows)) {
    config = windows;
    windows = PLAN_WINDOWS;
  }
  const coverage = {};
  const failing = [];
  for (const minutes of PLAN_WINDOWS) {
    const ratio = windowCoverage(bars1m, now, minutes, config);
    coverage[minutes] = round2(ratio);
    if (windows.includes(minutes) && !(ratio > minimumCoverageForWindow(minutes))) failing.push(minutes);
  }
  return { ok: failing.length === 0, coverage, failing };
}

/**
 * Aggregate 5-minute bars into a longer interval (factor 2 -> 10m, 6 -> 30m).
 * The trailing partial bucket is kept so the latest bar reflects live data.
 */
export function resampleBars(bars5, factor) {
  if (!Array.isArray(bars5) || !(factor > 0)) return [];
  const out = [];
  const intervalMinutes = 5 * factor;
  const fiveMinuteMs = 5 * 60_000;
  // Do not aggregate across large non-trading gaps (daily 02:00-09:00 close,
  // weekends, holidays). Within each contiguous run we keep the original
  // trailing-partial-bucket behaviour.
  const flush = (run) => {
    for (let index = 0; index < run.length; index += factor) {
      const chunk = run.slice(index, index + factor).filter((bar) => bar && Number.isFinite(bar.t));
      if (chunk.length === 0) continue;
      const first = chunk[0];
      const last = chunk[chunk.length - 1];
      out.push({
        t: alignStart(last.t, intervalMinutes),
        o: first.o,
        h: Math.max(...chunk.map((bar) => bar.h)),
        l: Math.min(...chunk.map((bar) => bar.l)),
        c: last.c,
        synthetic: chunk.some((bar) => bar.synthetic === true),
        source: chunk.every((bar) => bar.source === first.source) ? first.source : "resampled",
        instrument: first.instrument,
        market: first.market,
        currency: first.currency,
        unit: first.unit,
      });
    }
  };
  let run = [];
  let prevT = null;
  for (const bar of bars5) {
    if (!bar || !Number.isFinite(bar.t)) continue;
    if (prevT !== null && bar.t - prevT > fiveMinuteMs * 1.5 && run.length > 0) {
      flush(run);
      run = [];
    }
    run.push(bar);
    prevT = bar.t;
  }
  if (run.length > 0) flush(run);
  return out;
}


// ── indicators (exported for tests) ────────────────────────────────────────

function mean(values) {
  if (values.length === 0) return NaN;
  return values.reduce((acc, value) => acc + value, 0) / values.length;
}

export function sma(values, period, end = values.length - 1) {
  if (period <= 0 || end < period - 1 || end >= values.length) return NaN;
  const start = end - period + 1;
  const slice = values.slice(start, end + 1);
  return slice.every(Number.isFinite) ? mean(slice) : NaN;
}

/** EMA with the conventional period-SMA seed; pre-warm values stay NaN. */
export function emaSeries(values, period) {
  if (period <= 0 || values.length === 0) return [];
  const out = new Array(values.length).fill(NaN);
  if (values.length < period) return out;
  const seed = values.slice(0, period);
  if (!seed.every(Number.isFinite)) return out;
  const k = 2 / (period + 1);
  let prev = mean(seed);
  out[period - 1] = prev;
  for (let i = period; i < values.length; i += 1) {
    if (!Number.isFinite(values[i])) continue;
    prev = values[i] * k + prev * (1 - k);
    out[i] = prev;
  }
  return out;
}

/** Wilder RSI, seeded from the first complete period and then smoothed. */
export function rsi(values, period = 14) {
  if (values.length < period + 1 || period <= 0) return NaN;
  let avgGain = 0;
  let avgLoss = 0;
  for (let i = 1; i <= period; i += 1) {
    const diff = values[i] - values[i - 1];
    if (diff >= 0) avgGain += diff;
    else avgLoss -= diff;
  }
  avgGain /= period;
  avgLoss /= period;
  for (let i = period + 1; i < values.length; i += 1) {
    const diff = values[i] - values[i - 1];
    const gain = diff > 0 ? diff : 0;
    const loss = diff < 0 ? -diff : 0;
    avgGain = (avgGain * (period - 1) + gain) / period;
    avgLoss = (avgLoss * (period - 1) + loss) / period;
  }
  if (avgGain === 0 && avgLoss === 0) return 50;
  if (avgLoss === 0) return 100;
  const relativeStrength = avgGain / avgLoss;
  return 100 - 100 / (1 + relativeStrength);
}

export function bollinger(values, period = 20, mult = 2, end = values.length - 1) {
  const mid = sma(values, period, end);
  if (!Number.isFinite(mid)) return { mid: NaN, upper: NaN, lower: NaN };
  const start = end - period + 1;
  let variance = 0;
  for (let i = start; i <= end; i += 1) variance += (values[i] - mid) ** 2;
  const sd = Math.sqrt(variance / period);
  return { mid, upper: mid + mult * sd, lower: mid - mult * sd };
}

/** Wilder ATR, requiring period + 1 bars for its initial true-range seed. */
export function atr(bars, period = 14) {
  if (!Array.isArray(bars) || bars.length < period + 1 || period <= 0) return NaN;
  const trueRanges = [];
  for (let i = 1; i < bars.length; i += 1) {
    const prev = bars[i - 1];
    const bar = bars[i];
    trueRanges.push(Math.max(bar.h - bar.l, Math.abs(bar.h - prev.c), Math.abs(bar.l - prev.c)));
  }
  let value = mean(trueRanges.slice(0, period));
  for (let i = period; i < trueRanges.length; i += 1) {
    value = (value * (period - 1) + trueRanges[i]) / period;
  }
  return value;
}

export function macd(values, fast = 12, slow = 26, signal = 9) {
  const emaFast = emaSeries(values, fast);
  const emaSlow = emaSeries(values, slow);
  const dif = [];
  for (let i = 0; i < values.length; i += 1) {
    if (Number.isFinite(emaFast[i]) && Number.isFinite(emaSlow[i])) dif.push(emaFast[i] - emaSlow[i]);
  }
  const deaSeries = emaSeries(dif, signal);
  const latestDif = dif[dif.length - 1] ?? NaN;
  const latestDea = deaSeries[deaSeries.length - 1] ?? NaN;
  return {
    dif: latestDif,
    dea: latestDea,
    histogram: latestDif - latestDea,
  };
}

export function computeIndicatorSet(bars) {
  const normalized = (Array.isArray(bars) ? bars : []).map((bar) => normalizeBarRecord(bar)).filter(Boolean);
  const closes = normalized.map((bar) => bar.c);
  const ema20 = emaSeries(closes, 20);
  const last20 = normalized.length >= 20 ? normalized.slice(-20) : [];
  const planWarmupReady = normalized.length >= 20
    && Number.isFinite(ema20[ema20.length - 1])
    && Number.isFinite(ema20[ema20.length - 2]);
  const last = normalized[normalized.length - 1];
  return {
    calculationVersion: CALCULATION_VERSION,
    methods: INDICATOR_METHODS,
    count: closes.length,
    sampleCount: closes.length,
    warmupReady: closes.length >= 60,
    planWarmupReady,
    barComplete: true,
    synthetic: normalized.some((bar) => bar.synthetic === true),
    instrument: last?.instrument,
    market: last?.market,
    currency: last?.currency,
    unit: last?.unit,
    sma5: sma(closes, 5),
    sma20: sma(closes, 20),
    sma60: sma(closes, 60),
    ema20: ema20[ema20.length - 1] ?? NaN,
    ema20Prev: ema20[ema20.length - 2] ?? NaN,
    rsi14: rsi(closes, 14),
    boll: bollinger(closes, 20, 2),
    atr14: atr(normalized, 14),
    macd: macd(closes),
    recentHigh: last20.length === 20 ? Math.max(...last20.map((bar) => bar.h)) : NaN,
    recentLow: last20.length === 20 ? Math.min(...last20.map((bar) => bar.l)) : NaN,
  };
}

// ── market session (China Merchants Bank 积存金 rules) ─────────────────────

function parseTime(value, fallback) {
  const match = /^(\d{2}):(\d{2})$/.exec(value);
  if (!match) return fallback;
  return Number(match[1]) * 60 + Number(match[2]);
}

function beijingParts(now) {
  const shifted = new Date(now.getTime() + 8 * 60 * 60 * 1000);
  return {
    date: shifted.toISOString().slice(0, 10),
    minutes: shifted.getUTCHours() * 60 + shifted.getUTCMinutes(),
    day: shifted.getUTCDay(),
  };
}

function dateStringForOffset(base, offsetDays) {
  const date = new Date(`${base}T00:00:00Z`);
  date.setUTCDate(date.getUTCDate() + offsetDays);
  return date.toISOString().slice(0, 10);
}

export function computeMarketState(config, now = new Date()) {
  const cfg = normalizeConfig(config);
  const calendar = buildSessionCalendar(cfg);
  const openMin = calendar.openMin;
  const closeMin = calendar.closeMin;
  const today = beijingParts(now);
  const yesterdayDate = dateStringForOffset(today.date, -1);
  const yesterdayDay = (today.day + 6) % 7;
  const yesterdayTradeable = calendarTradeable(calendar, yesterdayDate, yesterdayDay);
  const todayTradeable = calendarTradeable(calendar, today.date, today.day);

  let open = false;
  let sessionStart = null;
  let closeInMinutes = 0;
  if (todayTradeable && today.minutes >= openMin && today.minutes < closeMin) {
    open = true;
    sessionStart = `${today.date}T${cfg.tradingHours.open}:00+08:00`;
    closeInMinutes = closeMin - today.minutes;
  }
  if (!open && yesterdayTradeable && closeMin > 1440 && today.minutes < closeMin - 1440) {
    open = true;
    sessionStart = `${yesterdayDate}T${cfg.tradingHours.open}:00+08:00`;
    closeInMinutes = closeMin - 1440 - today.minutes;
  }
  const msToClose = open ? closeInMinutes * 60_000 : 0;
  return { state: open ? "open" : "closed", sessionStart, msToClose };
}

/** Next Beijing-time session opening as an ISO timestamp (UTC instant). */
export function computeNextMarketOpen(config, now = new Date()) {
  const cfg = normalizeConfig(config);
  const calendar = buildSessionCalendar(cfg);
  const openMin = calendar.openMin;
  const closeMin = calendar.closeMin;
  if (openMin >= closeMin) return null;

  const today = beijingParts(now);
  const nowMs = now.getTime();
  for (let offset = 0; offset <= 370; offset += 1) {
    const date = dateStringForOffset(today.date, offset);
    const day = (today.day + offset) % 7;
    if (!calendarTradeable(calendar, date, day)) continue;
    const openMs = Date.parse(`${date}T${cfg.tradingHours.open}:00+08:00`);
    if (Number.isFinite(openMs) && openMs > nowMs) return new Date(openMs).toISOString();
  }
  return null;
}

// ── plan engine ────────────────────────────────────────────────────────────

function finite(value, fallback) {
  return Number.isFinite(value) ? value : fallback;
}

function round2(value) {
  return Math.round(value * 100) / 100;
}

function xauCnyPerGram(xau, usdcny) {
  if (!xau || !usdcny) return null;
  if (xau.market === "futures" || xau.instrument === "GC=F" || xau.source === "yahoo") return null;
  const xauPrice = Number(xau.price);
  const usd = Number(usdcny.price);
  if (!(xauPrice > 0) || !(usd > 0)) return null;
  return round2(xauPrice * usd / 31.1034768);
}

function hasCmbFallback(xau, usdcny) {
  const value = xauCnyPerGram(xau, usdcny);
  return value !== null && value > 0;
}

function floorGrams(value) {
  if (!Number.isFinite(value) || value <= 0) return 0;
  return Math.floor(value * 100) / 100;
}

function positionBands(maxGrams) {
  return {
    lightMax: maxGrams > 0 ? maxGrams * 0.2 : 0,
    midMax: maxGrams > 0 ? maxGrams * 0.6 : 0,
  };
}

function suggestedGrams(config, price) {
  const maxGrams = config.limits.maxGrams;
  const currentGrams = config.position.grams;
  if (maxGrams <= 0) return 0;
  const bands = positionBands(maxGrams);
  const remaining = maxGrams - currentGrams;
  if (remaining <= 0) return 0;
  // 目标仓位区间：轻仓补到 20%，标准补到 60%，重仓只补到上限。
  // 单次最多补 maxGrams 的 10%，避免一次把仓位打满。
  const target = currentGrams < bands.lightMax ? bands.lightMax : currentGrams < bands.midMax ? bands.midMax : maxGrams;
  const desired = Math.max(0, target - currentGrams);
  const maxStep = Math.max(1, maxGrams * 0.1);
  const grams = Math.min(desired, maxStep, remaining);
  return floorGrams(grams);
}

function stageReduceGrams(maxGrams, currentGrams, action, minRemainGrams = 0) {
  if (currentGrams <= 0) return 0;
  // 止损和收盘了结允许清仓；其他减仓按目标仓位区间保留底仓。
  if (action === "sell_stop" || action === "close_by_session_end") return currentGrams;
  if (maxGrams <= 0) {
    const fallback = Math.max(1, Math.floor(currentGrams * 0.1 * 100) / 100);
    return Math.min(currentGrams, fallback);
  }
  const bands = positionBands(maxGrams);
  let target;
  if (action === "sell_take_profit") {
    // 止盈：重仓先降到标准区，标准区降到轻仓区，已轻仓可保留最小底仓或直接了结。
    target = currentGrams > bands.midMax ? bands.midMax : currentGrams > bands.lightMax ? bands.lightMax : 0;
  } else {
    // reduce_position / sell_trailing / sell_weakness：逐级降到目标区间，已处于轻仓区间时不再重复减仓。
    target = currentGrams > bands.midMax ? bands.midMax : currentGrams > bands.lightMax ? bands.lightMax : currentGrams;
  }
  target = Math.max(target, minRemainGrams);
  const reduce = Math.min(currentGrams, Math.max(0, currentGrams - target));
  return floorGrams(reduce);
}

function defaultSignalState() {
  return {
    lastAction: null,
    lastSide: null,
    lastAt: null,
    lastPositionGrams: 0,
    lastPrice: null,
    buyStreak: 0,
    sellStreak: 0,
    // Per-side clock of the last counted closed 5m bar, so repeated
    // evaluations within the same bar never double-count confirmation.
    lastBarT: { buy: null, sell: null },
    // Signal-lane instrument memory: switching lanes invalidates streaks.
    instrument: null,
  };
}

function planSide(action) {
  if (action === "buy_setup" || action === "add_position") return "buy";
  if (["sell_take_profit", "sell_trailing", "sell_stop", "sell_weakness", "reduce_position", "close_by_session_end"].includes(action)) return "sell";
  return null;
}

export { applySignalPolicy, defaultSignalState };

/**
 * Apply confirmation/cooldown policy to one plan evaluation.
 *
 * confirmBars semantics: the condition must hold on N *consecutive closed 5m
 * bars* of the signal lane. The clock is the latest closed 5m bar's `t`
 * (plan.signalBarT): several evaluations within the same bar count once, and
 * both streaks reset whenever the action leaves the direction set, the signal
 * instrument changes, or the market closes — a stale streak from hours ago can
 * never wave a lone signal through.
 */
function applySignalPolicy(plan, signalState, cfg, now) {
  const next = { ...signalState, lastBarT: { ...(signalState.lastBarT ?? { buy: null, sell: null }) } };
  const resetStreaks = () => {
    next.buyStreak = 0;
    next.sellStreak = 0;
    next.lastBarT = { buy: null, sell: null };
  };
  // 用户更新持仓后，重置同方向冷却与确认计数，避免旧信号继续“追杀”新仓位。
  if (signalState.lastPositionGrams !== cfg.position.grams) {
    next.lastAction = null;
    next.lastSide = null;
    next.lastAt = null;
    next.lastPositionGrams = cfg.position.grams;
    resetStreaks();
  }
  // Signal-lane switch: counts from the previous instrument are meaningless.
  const instrumentKey = plan.instrument ?? null;
  if (next.instrument !== instrumentKey) {
    next.instrument = instrumentKey;
    resetStreaks();
  }
  // Session end / closed market invalidates any in-progress confirmation.
  if (plan.marketState === "closed") {
    resetStreaks();
  }
  const side = planSide(plan.action);
  // Non-directional evaluation (wait / no_data / data_incomplete / ...): the
  // signal set ended, so confirmation counting restarts from zero.
  if (!side) {
    resetStreaks();
    return { plan, signalState: next };
  }
  const cooldownMs = (cfg.strategy.signalCooldownMinutes || 0) * 60_000;
  const emergency = plan.action === "sell_stop" || plan.action === "close_by_session_end";
  const sameSide = next.lastSide === side;
  const lastAt = next.lastAt ? Date.parse(next.lastAt) : NaN;
  const inCooldown = sameSide && Number.isFinite(lastAt) && cooldownMs > 0 && (now.getTime() - lastAt) < cooldownMs;
  if (inCooldown && !emergency) {
    plan.action = "wait";
    plan.suggestedOrder = null;
    plan.grams = 0;
    if (!plan.reasonCodes.includes("cooldown_active")) plan.reasonCodes.push("cooldown_active");
    return { plan, signalState: next };
  }
  const confirmBars = Math.max(1, cfg.strategy.confirmBars || 1);
  const streakKey = side === "buy" ? "buyStreak" : "sellStreak";
  const sideClock = side === "buy" ? "buy" : "sell";
  const barT = Number.isFinite(Number(plan.signalBarT)) ? Number(plan.signalBarT) : null;
  // Advance the count only when this is a new closed bar for this side.
  if (barT === null || next.lastBarT[sideClock] !== barT) {
    next[streakKey] = (next[streakKey] || 0) + 1;
    if (barT !== null) next.lastBarT[sideClock] = barT;
  }
  const currentStreak = next[streakKey] || 0;
  const needsConfirm = confirmBars > 1 && !emergency && plan.action !== "sell_take_profit";
  if (needsConfirm && currentStreak < confirmBars) {
    plan.action = "wait";
    plan.suggestedOrder = null;
    plan.grams = 0;
    if (!plan.reasonCodes.includes("signal_confirming")) plan.reasonCodes.push("signal_confirming");
    return { plan, signalState: next };
  }
  // 信号确认通过：记录本次建议，用于同方向冷却。
  next.lastAction = plan.action;
  next.lastSide = side;
  next.lastAt = new Date(now.getTime()).toISOString();
  next.lastPositionGrams = cfg.position.grams;
  next.lastPrice = plan.signalPrice;
  const otherKey = side === "buy" ? "sellStreak" : "buyStreak";
  next[otherKey] = 0;
  return { plan, signalState: next };
}

export function computePlan(runtime, config, now = new Date()) {
  const cfg = normalizeConfig(config);
  const domestic = runtime.quotes?.AU9999;
  const cmbQuote = runtime.quotes?.CMB;
  const xau = runtime.quotes?.XAU;
  const usdcny = runtime.quotes?.USDCNY;
  const market = computeMarketState(cfg, now);
  const hasDomestic = !!domestic && Number.isFinite(domestic.price) && domestic.price > 0;
  const xauIsSpot = !!xau
    && xau.market !== "futures"
    && xau.instrument !== "GC=F"
    && xau.source !== "yahoo";
  const xauCny = xauIsSpot ? xauCnyPerGram(xau, usdcny) : null;
  const hasXauFallback = xauIsSpot && hasCmbFallback(xau, usdcny);
  const liveCmb = cmbQuote && Number.isFinite(Number(cmbQuote.buyPrice)) && Number.isFinite(Number(cmbQuote.sellPrice))
    && Number(cmbQuote.buyPrice) > 0 && Number(cmbQuote.sellPrice) > 0;
  // 信号标的口径：招行实时 → 国际金价按汇率折算 → Au99.99。
  // 数据覆盖率门槛按同一口径统计信号标的的 1 分钟 bars。
  const hasSignal = liveCmb || hasXauFallback || hasDomestic;
  const useXauSignal = !liveCmb && hasXauFallback;
  const useDomesticSignal = !liveCmb && !hasXauFallback && hasDomestic;
  const cmbBase = xauCny ?? (hasDomestic ? domestic.price : undefined);

  const base = {
    action: "no_data",
    marketState: market.state,
    instrument: liveCmb ? "CMB" : (useXauSignal ? "XAU" : "Au99.99"),
    signalPrice: liveCmb ? Number(cmbQuote.buyPrice) : (useXauSignal ? xauCny : (hasDomestic ? domestic.price : undefined)),
    cmbEstimatedPrice: liveCmb
      ? round2(Number(cmbQuote.sellPrice))
      : (cmbBase !== undefined ? round2(cmbBase + cfg.cmb.buySpreadPerGram) : undefined),
    grams: 0,
    reasonCodes: [],
    breakeven: undefined,
    targetPrice: undefined,
    stopPrice: undefined,
    suggestedOrder: null,
  };

  const hasSignalState = !!runtime.signalState;
  const signalState = runtime.signalState || defaultSignalState();
  function finish(plan) {
    if (!hasSignalState) return plan;
    const applied = applySignalPolicy(plan, signalState, cfg, now);
    plan.signalState = applied.signalState;
    return plan;
  }

  if (!hasSignal) {
    const staleDomestic = hasDomestic
      && ((Number.isFinite(domestic.updatedAt) && now.getTime() - domestic.updatedAt > STALE_QUOTE_MS) || !isDomesticQuoteFresh(domestic, now));
    if (staleDomestic) {
      base.action = "data_stale";
      base.reasonCodes.push("stale_quote");
    } else {
      base.reasonCodes.push("quote_missing");
    }
    return finish(base);
  }

  const price = liveCmb ? round2(Number(cmbQuote.buyPrice)) : (useXauSignal ? xauCny : domestic.price);
  const selectedQuote = liveCmb ? cmbQuote : useXauSignal ? xau : domestic;
  // XAU indicators remain in their native USD/troy-ounce unit. Only the price
  // levels shown to the CMB user are converted with the current FX rate.
  const technicalPrice = useXauSignal ? Number(xau.price) : price;
  const signalFactor = useXauSignal ? price / technicalPrice : 1;
  const rawBars5 = (liveCmb ? runtime.bars?.CMB?.[5] : useXauSignal ? runtime.bars?.XAU?.[5] : runtime.bars?.AU9999?.[5]) ?? [];
  const rawBars60 = (liveCmb ? runtime.bars?.CMB?.[60] : useXauSignal ? runtime.bars?.XAU?.[60] : runtime.bars?.AU9999?.[60]) ?? [];
  // Formal indicators never include the current, still-open bucket.
  const bars5 = closedBars(rawBars5, 5, now);
  const bars60 = closedBars(rawBars60, 60, now);
  // Clock for confirmBars: the signal lane's latest closed 5m bar. Multiple
  // evaluations within the same bar must not double-count confirmation.
  base.signalBarT = bars5.length > 0 ? bars5[bars5.length - 1].t : undefined;
  // 10m/30m bars are resampled from closed 5m bars, so a partial longer bucket
  // can never leak into the formal indicator set.
  const bars10 = resampleBars(bars5, 2).filter((bar) => isBarClosed(bar, 10, now));
  const bars30 = resampleBars(bars5, 6).filter((bar) => isBarClosed(bar, 30, now));
  const indicatorMeta = useXauSignal
    ? { instrument: "XAU/USD", market: "spot", currency: "USD", unit: "troy_ounce" }
    : liveCmb
      ? { instrument: "CMB_ACCUMULATED_GOLD", market: "bank", currency: "CNY", unit: "gram" }
      : { instrument: "Au99.99", market: "sge", currency: "CNY", unit: "gram" };
  const withIndicatorMeta = (value) => ({ ...value, ...indicatorMeta });
  const ind5 = withIndicatorMeta(computeIndicatorSet(bars5));
  const ind10 = withIndicatorMeta(computeIndicatorSet(bars10));
  const ind30 = withIndicatorMeta(computeIndicatorSet(bars30));
  const ind60 = withIndicatorMeta(computeIndicatorSet(bars60));
  const cmbBuy = liveCmb ? round2(Number(cmbQuote.buyPrice)) : round2(cmbBase + cfg.cmb.buySpreadPerGram);
  const cmbSell = liveCmb ? round2(Number(cmbQuote.sellPrice)) : round2(cmbBase + cfg.cmb.sellSpreadPerGram);
  const cmbBuySpread = round2(cmbBuy - price);
  const cmbSellSpread = round2(cmbSell - price);
  const estSpread = hasDomestic ? finite(domestic.ask - domestic.bid, cfg.strategy.estimatedSpreadPerGram) : cfg.strategy.estimatedSpreadPerGram;
  const slippage = cfg.strategy.slippagePerGram;
  const fee = cfg.fee;
  // 实时招行卖出价本身已是扣费后的价格，因此浮盈亏/止损不再重复扣卖出费；
  // 但回本价仍要按用户设置的买入/卖出手续费展示，避免低估实际回本要求。
  const pnlSellFee = liveCmb ? 0 : fee.sellPerGram;
  const breakevenBuyFee = fee.buyPerGram;
  const breakevenSellFee = fee.sellPerGram;
  const spreadCmb = { buySpreadPerGram: cmbBuySpread, sellSpreadPerGram: cmbSellSpread };
  const technicalStep = 0.1 / signalFactor;
  const toSignalPrice = (value) => round2(value * signalFactor);
  const pos = cfg.position;
  const strategy = cfg.strategy;

  base.signalPrice = round2(price);
  base.cmbEstimatedPrice = cmbSell;
  base.cmbLive = liveCmb;
  base.indicators = {
    calculationVersion: CALCULATION_VERSION,
    methods: INDICATOR_METHODS,
    instrument: indicatorMeta.instrument,
    market: indicatorMeta.market,
    currency: indicatorMeta.currency,
    unit: indicatorMeta.unit,
    ind5,
    ind10,
    ind30,
    ind60,
    xauCnyPerGram: xauCny ?? undefined,
  };
  if (xauCny !== null) base.xauCnyPerGram = xauCny;

  if (market.state !== "open") {
    base.action = "market_closed";
    base.reasonCodes.push("market_closed");
    return finish(base);
  }

  const xauStale = Number.isFinite(xau?.updatedAt) && now.getTime() - xau.updatedAt > STALE_QUOTE_MS;
  const usdcnyStale = Number.isFinite(usdcny?.updatedAt) && now.getTime() - usdcny.updatedAt > STALE_QUOTE_MS;
  const domesticStale = hasDomestic && ((Number.isFinite(domestic.updatedAt) && now.getTime() - domestic.updatedAt > STALE_QUOTE_MS) || !isDomesticQuoteFresh(domestic, now));
  const quoteStale = !liveCmb && (
    (useXauSignal && (xauStale || usdcnyStale)) ||
    (useDomesticSignal && domesticStale)
  );
  if (quoteStale) {
    base.action = "data_stale";
    base.reasonCodes.push("stale_quote");
    return finish(base);
  }

  // Data-quality gate: a suggestion is only produced when the active windows
  // have >80% valid per-minute data for 5/10m and >60% for 30/60m
  // on the signal instrument's own bars;
  // otherwise tell the user data is missing and stay silent. In the first
  // hour after the session opens, and during the daily 00:00-01:00 Beijing
  // window, 30/60-minute windows are only checked when the session-aware
  // window already has enough data (e.g. 09:xx can reuse the previous
  // session's pre-02:00 data); otherwise those longer windows are naturally
  // thin and only 5/10-minute windows are validated.
  const gateBars1m = filterBarsToTradingHours((liveCmb ? runtime.bars?.CMB?.[1] : useXauSignal ? runtime.bars?.XAU?.[1] : runtime.bars?.AU9999?.[1]) ?? [], cfg);
  const minutesSinceOpen = market.sessionStart ? (now.getTime() - Date.parse(market.sessionStart)) / 60_000 : Infinity;
  const inSessionWarmup = Number.isFinite(minutesSinceOpen) && minutesSinceOpen * 60_000 < SESSION_WARMUP_MS;
  const inMidnightWindow = beijingParts(now).minutes < MIDNIGHT_WINDOW_END_MINUTES;
  // Coverage is computed once for all PLAN_WINDOWS; only the pass/fail
  // decision depends on the active window set (full set vs 5/10-only warm-up).
  const fullGate = coverageGate(gateBars1m, now, PLAN_WINDOWS, cfg);
  const longWindowsReady = fullGate.coverage[30] > minimumCoverageForWindow(30) && fullGate.coverage[60] > minimumCoverageForWindow(60);
  const gateWindows = ((inSessionWarmup || inMidnightWindow) && !longWindowsReady) ? [5, 10] : PLAN_WINDOWS;
  const gateFailing = gateWindows.filter((minutes) => !(fullGate.coverage[minutes] > minimumCoverageForWindow(minutes)));
  base.dataCoverage = fullGate.coverage;
  const sourceDisagreementPct = hasDomestic && xauCny !== null
    ? (Number(domestic.price) - xauCny) / xauCny * 100
    : NaN;
  base.dataQuality = assessMarketQuality({
    now,
    quote: selectedQuote,
    bars: bars5,
    coverage: fullGate.coverage,
    requiredCoverage: gateWindows,
    indicators: { ind5, ind10, ind30, ind60 },
    marketState: market.state,
    expectedMarket: useXauSignal ? "spot" : undefined,
    sourceDisagreementPct,
    cmbSpread: cmbBuy - cmbSell,
  });
  if (gateFailing.length > 0) {
    base.action = "data_incomplete";
    base.reasonCodes = gateFailing.map((minutes) => `data_incomplete_${minutes}m`);
    return finish(base);
  }
  const indicatorDataPresent = bars5.length > 0 || bars10.length > 0 || bars30.length > 0 || bars60.length > 0;
  // A completely cold series cannot support an indicator-based entry, but
  // quote-only protective exits and a transparent `wait` remain available.
  // Once any formal series exists, an incomplete warm-up is a hard gate.
  const hardQualityFailures = base.dataQuality.reasonCodes.filter((code) => [
    "bars_invalid",
    ...(indicatorDataPresent ? ["indicator_warmup"] : []),
    "instrument_mismatch",
    "source_disagreement",
    "cmb_spread_missing",
  ].includes(code));
  if (hardQualityFailures.length > 0) {
    base.action = "data_incomplete";
    base.reasonCodes = hardQualityFailures;
    return finish(base);
  }

  // Multi-timeframe trend: EMA20 must be rising on 10/30/60-minute bars
  // (10m/30m are resampled from the 5m bars) instead of 60m alone, so the
  // suggestion references 5/10/30/60-minute data as a whole.
  const emaRising = (ind) => Number.isFinite(ind.ema20) && Number.isFinite(ind.ema20Prev) && ind.ema20 > ind.ema20Prev;
  const trendUp = emaRising(ind60) && emaRising(ind30) && emaRising(ind10);
  const nearSupport = Number.isFinite(ind5.recentLow)
    ? (technicalPrice - ind5.recentLow) / technicalPrice * 100 <= strategy.nearSupportPct
    : false;
  const nearLowerBand = Number.isFinite(ind5.boll.lower)
    ? technicalPrice <= ind5.boll.lower * (1 + strategy.nearSupportPct / 100)
    : false;
  const rsiRecovering = Number.isFinite(ind5.rsi14) && ind5.rsi14 > strategy.rsiOversold && ind5.rsi14 < 50;
  const aboveSma20 = Number.isFinite(ind5.sma20) && technicalPrice > ind5.sma20;
  const buySetup = trendUp && (nearSupport || nearLowerBand) && (rsiRecovering || aboveSma20);
  const emaUpCount = [ind10, ind30, ind60].filter(emaRising).length;
  const macdPositive = Number.isFinite(ind5.macd?.histogram) && ind5.macd.histogram > 0;
  const confidenceScore = emaUpCount
    + (nearSupport ? 1 : 0)
    + (nearLowerBand ? 1 : 0)
    + (rsiRecovering ? 1 : 0)
    + (aboveSma20 ? 1 : 0)
    + (macdPositive ? 1 : 0);
  base.confidenceScore = confidenceScore;
  base.confidenceMax = 8;

  // Existing position: user's avg cost is their actual CMB entry cost.
  if (pos.grams > 0) {
    const lots = Array.isArray(pos.lots) ? pos.lots.filter((lot) => lot.status !== "closed") : [];
    const avgCost = pos.avgCostPerGram || 0;
    const exitNeeded = round2(avgCost + breakevenSellFee + estSpread + slippage);
    const cmbNow = cmbSell;
    const pnl = round2((cmbNow - pnlSellFee - avgCost) * pos.grams);
    base.position = {
      grams: pos.grams,
      avgCostPerGram: round2(avgCost),
      cmbNow,
      feeAdjustedPnl: pnl,
      exitNeeded,
      lots: lots.map((lot) => ({
        id: lot.id,
        grams: lot.grams,
        price: lot.price,
        time: lot.time,
        cmbNow,
        feeAdjustedPnl: round2((cmbNow - pnlSellFee - lot.price) * lot.grams),
        profitPerGram: round2(cmbNow - pnlSellFee - lot.price),
      })),
    };
    base.breakeven = exitNeeded;
    base.grams = pos.grams;

    const resistance = Number.isFinite(ind5.recentHigh)
      ? ind5.recentHigh * signalFactor + spreadCmb.sellSpreadPerGram
      : undefined;
    const atrValue = Number.isFinite(ind5.atr14) ? ind5.atr14 * signalFactor : strategy.minProfitPerGram;
    const targetPrice = Math.max(
      exitNeeded + strategy.minProfitPerGram,
      finite(resistance, exitNeeded + atrValue) - atrValue * strategy.atrFactor,
    );
    base.targetPrice = round2(targetPrice);
    base.stopPrice = round2(avgCost - strategy.maxLossPerGram - pnlSellFee);

    if (cmbNow >= targetPrice) {
      const reduceGrams = stageReduceGrams(cfg.limits.maxGrams, pos.grams, "sell_take_profit", cfg.strategy.minRemainGrams);
      if (reduceGrams > 0) {
        base.action = "sell_take_profit";
        base.grams = reduceGrams;
        base.reasonCodes.push("target_reached");
        if (base.grams < pos.grams) base.reasonCodes.push("target_band_reduce");
      } else {
        base.action = "wait";
        base.reasonCodes.push("already_light_position");
      }
    } else if (cmbNow <= base.stopPrice) {
      base.action = "sell_stop";
      base.reasonCodes.push("stop_reached");
    } else if (market.msToClose <= 30 * 60_000) {
      base.action = "close_by_session_end";
      base.reasonCodes.push("session_ending");
    } else {
      const last = bars5[bars5.length - 1];
      const prev = bars5[bars5.length - 2];
      const overboughtBearish = pnl > 0 && Number.isFinite(ind5.rsi14) && ind5.rsi14 > strategy.rsiOverbought
        && !!(last && prev && last.c < last.o && last.h - last.c > (ind5.atr14 || 0.5));
      const trailingBreak = pnl > 0 && Number.isFinite(ind5.sma20) && bars5.length >= 1 && !!(last && last.c < ind5.sma20);
      if (overboughtBearish) {
        const reduceGrams = stageReduceGrams(cfg.limits.maxGrams, pos.grams, "reduce_position", cfg.strategy.minRemainGrams);
        if (reduceGrams > 0) {
          base.action = "reduce_position";
          base.grams = reduceGrams;
          base.reasonCodes.push("rsi_overbought", "bearish_bar", "reduce_on_weakness");
          if (base.grams < pos.grams) base.reasonCodes.push("target_band_reduce");
        } else {
          base.action = "wait";
          base.reasonCodes.push("already_light_position");
        }
      } else if (trailingBreak) {
        const reduceGrams = stageReduceGrams(cfg.limits.maxGrams, pos.grams, "sell_trailing", cfg.strategy.minRemainGrams);
        if (reduceGrams > 0) {
          base.action = "sell_trailing";
          base.grams = reduceGrams;
          base.reasonCodes.push("break_below_sma20_with_profit");
          if (base.grams < pos.grams) base.reasonCodes.push("target_band_reduce");
        } else {
          base.action = "wait";
          base.reasonCodes.push("already_light_position");
        }
      } else {
        const remaining = cfg.limits.maxGrams > 0 ? cfg.limits.maxGrams - pos.grams : Infinity;
        if (buySetup && remaining > 0 && confidenceScore >= strategy.scoreThreshold) {
          const atrValueAdd = Number.isFinite(ind5.atr14) ? ind5.atr14 : 1 / signalFactor;
          const suggestedTechnicalPrice = Math.min(
            technicalPrice + technicalStep,
            (Number.isFinite(ind5.recentLow) ? ind5.recentLow : technicalPrice) + atrValueAdd * strategy.atrFactor,
          );
          const suggestedSignalPrice = toSignalPrice(suggestedTechnicalPrice);
          const suggestedCmbPrice = round2(suggestedSignalPrice + spreadCmb.buySpreadPerGram);
          const grams = suggestedGrams(cfg, suggestedCmbPrice);
          base.action = grams > 0 ? "add_position" : "no_budget";
          base.grams = grams;
          // 买入/补仓只是建议：在用户实际更新持仓前，回本价/目标价/止损位继续按当前持仓配置展示
          base.reasonCodes.push("trend_ema20_up");
          if (nearSupport) base.reasonCodes.push("near_support");
          if (nearLowerBand) base.reasonCodes.push("near_lower_band");
          if (rsiRecovering) base.reasonCodes.push("rsi_rebound");
          if (grams > 0) {
            base.reasonCodes.push("target_band_add");
            base.suggestedOrder = {
              action: base.action,
              instrument: base.instrument,
              side: "buy",
              signalPrice: suggestedSignalPrice,
              cmbEstimatedPrice: suggestedCmbPrice,
              cmbLive: liveCmb,
              price: suggestedCmbPrice,
              grams,
              validUntil: new Date(now.getTime() + Math.max(market.msToClose - 10 * 60_000, 60_000)).toISOString(),
              reasonCodes: base.reasonCodes,
              riskNote: "技术面参考，非投资建议",
            };
          }
          return finish(base);
        }
        base.action = "wait";
        base.reasonCodes.push(trendUp ? "trigger_not_confirmed" : "trend_filter_not_met");
        if (buySetup && confidenceScore < strategy.scoreThreshold) base.reasonCodes.push("score_not_enough");
      }
    }
    const sellActions = new Set([
      "sell_take_profit",
      "sell_trailing",
      "sell_stop",
      "reduce_position",
      "close_by_session_end",
    ]);
    if (sellActions.has(base.action)) {
      base.suggestedOrder = {
        action: base.action,
        instrument: base.instrument,
        side: "sell",
        signalPrice: base.signalPrice,
        cmbEstimatedPrice: cmbSell,
        cmbLive: liveCmb,
        price: cmbSell,
        grams: base.grams,
        validUntil: new Date(now.getTime() + Math.max(market.msToClose - 10 * 60_000, 60_000)).toISOString(),
        reasonCodes: base.reasonCodes,
        riskNote: "技术面参考，非投资建议",
      };
    }
    return finish(base);
  }

  // Flat: intraday long setup.
  if (buySetup && confidenceScore >= strategy.scoreThreshold) {
    const atrValue = Number.isFinite(ind5.atr14) ? ind5.atr14 : 1 / signalFactor;
    const suggestedTechnicalPrice = Math.min(
      technicalPrice + technicalStep,
      (Number.isFinite(ind5.recentLow) ? ind5.recentLow : technicalPrice) + atrValue * strategy.atrFactor,
    );
    const suggestedSignalPrice = toSignalPrice(suggestedTechnicalPrice);
    const suggestedCmbPrice = round2(suggestedSignalPrice + spreadCmb.buySpreadPerGram);
    const entryCost = round2(suggestedCmbPrice + breakevenBuyFee);
    const breakeven = round2(entryCost + breakevenSellFee + estSpread + slippage);
    const grams = suggestedGrams(cfg, suggestedCmbPrice);
    const targetPrice = Math.max(
      breakeven + strategy.minProfitPerGram,
      Number.isFinite(ind5.recentHigh)
        ? ind5.recentHigh * signalFactor - atrValue * signalFactor * strategy.atrFactor + spreadCmb.sellSpreadPerGram
        : breakeven + atrValue * signalFactor,
    );
    base.action = grams > 0 ? "buy_setup" : "no_budget";
    base.grams = grams;
    base.breakeven = breakeven;
    base.targetPrice = round2(targetPrice);
    base.reasonCodes.push("trend_ema20_up");
    if (nearSupport) base.reasonCodes.push("near_support");
    if (nearLowerBand) base.reasonCodes.push("near_lower_band");
    if (rsiRecovering) base.reasonCodes.push("rsi_rebound");
    if (grams > 0) base.reasonCodes.push("target_band_add");
    base.suggestedOrder = {
      action: base.action,
      instrument: base.instrument,
      side: "buy",
      signalPrice: suggestedSignalPrice,
      cmbEstimatedPrice: suggestedCmbPrice,
      cmbLive: liveCmb,
      price: suggestedCmbPrice,
      grams,
      validUntil: new Date(now.getTime() + Math.max(market.msToClose - 10 * 60_000, 60_000)).toISOString(),
      reasonCodes: base.reasonCodes,
      riskNote: "技术面参考，非投资建议",
    };
    return finish(base);
  }

  base.action = "wait";
  base.breakeven = round2(cmbBuy + breakevenBuyFee + breakevenSellFee + estSpread + slippage);
  base.targetPrice = base.breakeven + strategy.minProfitPerGram;
  base.reasonCodes.push(trendUp ? "trigger_not_confirmed" : "trend_filter_not_met");
  if (buySetup && confidenceScore < strategy.scoreThreshold) base.reasonCodes.push("score_not_enough");
  return finish(base);
}

// ── snapshot builder ───────────────────────────────────────────────────────

function quoteView(quote, now) {
  if (!quote) return null;
  const stale = !Number.isFinite(quote.updatedAt) || now - quote.updatedAt > STALE_QUOTE_MS || !(quote.price > 0) || !isDomesticQuoteFresh(quote, now);
  return {
    price: quote.price,
    bid: quote.bid,
    ask: quote.ask,
    high: quote.high,
    low: quote.low,
    open: quote.open,
    prevClose: quote.prevClose,
    buyPrice: quote.buyPrice,
    sellPrice: quote.sellPrice,
    average: quote.average ?? (Number.isFinite(Number(quote.buyPrice)) && Number.isFinite(Number(quote.sellPrice))
      ? round2((Number(quote.buyPrice) + Number(quote.sellPrice)) / 2)
      : undefined),
    time: quote.time,
    date: quote.date,
    source: quote.source,
    instrument: quote.instrument,
    market: quote.market,
    currency: quote.currency,
    unit: quote.unit,
    sourceTimestamp: quote.sourceTimestamp,
    receivedAt: quote.receivedAt,
    staleAfterMs: quote.staleAfterMs,
    quality: quote.quality,
    customerBuy: quote.customerBuy ?? quote.buyPrice,
    customerSell: quote.customerSell ?? quote.sellPrice,
    spread: quote.spread,
    stale,
    ...(quote.error === true ? { error: true } : {}),
  };
}

/**
 * Wire view of a bar list.
 *
 * `meta: false` (slim mode, used by the /snapshot trend arrays) emits exactly
 * { t, o, h, l, c }: every bar in a lane carries identical provenance
 * (repeated source/instrument/market/currency/unit is pure waste), and the
 * browser half only reads t/o/h/l/c from trend bars (`complete` is
 * recomputable client-side and unused there). Slimming keeps a typical
 * fully-populated snapshot under the 300KB budget; the /bars detail endpoint
 * keeps full metadata.
 */
function barsView(bars, limit = 288, intervalMinutes = 1, now = Date.now(), meta = true) {
  if (!Array.isArray(bars)) return [];
  return bars.slice(-limit).map((bar) => (
    meta ? {
      t: new Date(bar.t).toISOString(),
      o: round2(bar.o),
      h: round2(bar.h),
      l: round2(bar.l),
      c: round2(bar.c),
      complete: isBarClosed(bar, intervalMinutes, now),
      ...(bar.synthetic === true ? { synthetic: true } : {}),
      ...(bar.source !== undefined ? { source: bar.source } : {}),
      ...(bar.instrument !== undefined ? { instrument: bar.instrument } : {}),
      ...(bar.market !== undefined ? { market: bar.market } : {}),
      ...(bar.currency !== undefined ? { currency: bar.currency } : {}),
      ...(bar.unit !== undefined ? { unit: bar.unit } : {}),
    } : {
      t: new Date(bar.t).toISOString(),
      o: round2(bar.o),
      h: round2(bar.h),
      l: round2(bar.l),
      c: round2(bar.c),
    }
  ));
}

/**
 * Cache decision for GET /snapshot. Pure so tests can inject both clocks:
 * a cached snapshot is served while it is younger than `minMs`.
 */
export function snapshotCacheStale(builtAtMs, nowMs, minMs = SNAPSHOT_REBUILD_MIN_MS) {
  return !(Number.isFinite(builtAtMs) && nowMs - builtAtMs < minMs);
}

export function buildSnapshot(runtime, config, now = new Date()) {
  const cfg = normalizeConfig(config);
  const domestic = runtime.quotes?.AU9999;
  const xau = runtime.quotes?.XAU;
  const usdcny = runtime.quotes?.USDCNY;
  const basePlan = runtime.plan ?? computePlan(runtime, cfg, now);
  const xauIsSpot = !!xau
    && xau.market !== "futures"
    && xau.instrument !== "GC=F"
    && xau.source !== "yahoo";
  const xauCny = xauIsSpot ? xauCnyPerGram(xau, usdcny) : null;
  const hasXauFallback = xauIsSpot && hasCmbFallback(xau, usdcny);
  const hasDomestic = !!domestic && Number.isFinite(domestic.price) && domestic.price > 0;
  const cmbQuote = runtime.quotes?.CMB;
  const liveCmb = cmbQuote && Number.isFinite(Number(cmbQuote.buyPrice)) && Number.isFinite(Number(cmbQuote.sellPrice))
    && Number(cmbQuote.buyPrice) > 0 && Number(cmbQuote.sellPrice) > 0;
  const fallbackMissing = !liveCmb && !hasXauFallback;
  const plan = basePlan.action === "no_data" && fallbackMissing
    ? { ...basePlan, action: "data_stale", reasonCodes: ["quote_missing"] }
    : basePlan;
  const derived = {};
  if (xauCny !== null) {
    derived.xauCnyPerGram = xauCny;
  }
  if (Number.isFinite(domestic?.price) && domestic.price > 0 && xauCny !== null) {
    derived.domesticPremiumPerGram = round2(domestic.price - xauCny);
    derived.domesticPremiumRatio = Math.round((derived.domesticPremiumPerGram / xauCny) * 1_000_000) / 1_000_000;
    derived.domesticPremiumPct = round2(derived.domesticPremiumRatio * 100);
  }
  if (liveCmb || hasXauFallback || hasDomestic) {
    const cmbBase = xauCny ?? (hasDomestic ? domestic.price : undefined);
    const cmbBuy = liveCmb ? round2(Number(cmbQuote.buyPrice)) : round2(cmbBase + cfg.cmb.buySpreadPerGram);
    const cmbSell = liveCmb ? round2(Number(cmbQuote.sellPrice)) : round2(cmbBase + cfg.cmb.sellSpreadPerGram);
    const cmbSellAfterFee = liveCmb ? cmbSell : round2(cmbSell - cfg.fee.sellPerGram);
    derived.cmb = {
      buyPrice: cmbBuy,
      sellPrice: cmbSell,
      customerBuy: cmbBuy,
      customerSell: cmbSell,
      spread: round2(cmbBuy - cmbSell),
      effectiveExitPrice: cmbSellAfterFee,
      average: round2((cmbBuy + cmbSell) / 2),
      sellPriceAfterFee: cmbSellAfterFee,
      live: Boolean(liveCmb),
      ...(!liveCmb ? { basePrice: cmbBase } : {}),
      sourceNote: liveCmb
        ? "招行接口实时价"
        : (xauCny !== null
          ? `国际金价按汇率折算 ${xauCny} + ${cfg.cmb.buySpreadPerGram}/${cfg.cmb.sellSpreadPerGram} 元/克估算，卖出已扣 ${cfg.fee.sellPerGram} 元/克手续费`
          : `Au99.99 ${domestic.price} + ${cfg.cmb.buySpreadPerGram}/${cfg.cmb.sellSpreadPerGram} 元/克估算，卖出已扣 ${cfg.fee.sellPerGram} 元/克手续费`),
    };
  }
  const market = computeMarketState(cfg, now);
  market.nextOpen = computeNextMarketOpen(cfg, now);
  const auView = quoteView(domestic, now);
  const xauView = quoteView(xau, now);
  const cmbView = quoteView(runtime.quotes?.CMB, now);
  if (auView && cfg.manualPrevClose.AU9999) auView.prevClose = cfg.manualPrevClose.AU9999;
  if (xauView && cfg.manualPrevClose.XAU) xauView.prevClose = cfg.manualPrevClose.XAU;
  if (cmbView && cfg.manualPrevClose.CMB) cmbView.prevClose = cfg.manualPrevClose.CMB;
  if (cmbView) {
    cmbView.customerBuy = cmbView.customerBuy ?? cmbView.buyPrice;
    cmbView.customerSell = cmbView.customerSell ?? cmbView.sellPrice;
    cmbView.spread = Number.isFinite(Number(cmbView.customerBuy)) && Number.isFinite(Number(cmbView.customerSell))
      ? round2(Number(cmbView.customerBuy) - Number(cmbView.customerSell))
      : undefined;
    cmbView.effectiveExitPrice = cmbView.customerSell;
  }
  const auQuote = auView && Number(auView.price) > 0
    ? auView
    : { price: 0, source: "error", updatedAt: 0, stale: true, error: true };
  const qualityInstrument = plan.instrument === "CMB" ? "CMB" : plan.instrument === "XAU" ? "XAU" : "AU9999";
  const qualityQuote = runtime.quotes?.[qualityInstrument];
  const qualityBars = runtime.bars?.[qualityInstrument]?.[5] ?? [];
  const quality = plan.dataQuality ?? assessMarketQuality({
    now,
    quote: qualityQuote,
    bars: closedBars(qualityBars, 5, now),
    coverage: plan.dataCoverage ?? {},
    indicators: plan.indicators ? {
      ind5: plan.indicators.ind5,
      ind10: plan.indicators.ind10,
      ind30: plan.indicators.ind30,
      ind60: plan.indicators.ind60,
    } : {},
    marketState: plan.marketState ?? market.state,
    expectedMarket: qualityInstrument === "XAU" ? "spot" : undefined,
    sourceDisagreementPct: derived.domesticPremiumPct,
    cmbSpread: derived.cmb?.spread,
  });
  return {
    ok: true,
    serverTime: now.toISOString(),
    marketState: plan.marketState ?? market.state,
    market: {
      state: plan.marketState ?? market.state,
      sessionStart: plan.sessionStart ?? market.sessionStart,
      msToClose: plan.msToClose ?? market.msToClose,
      nextOpen: market.nextOpen,
      open: cfg.tradingHours.open,
      close: cfg.tradingHours.close,
    },
    quotes: {
      AU9999: auQuote,
      XAU: xauView,
      GCF: quoteView(runtime.quotes?.GCF, now),
      USDCNY: quoteView(usdcny, now),
      CMB: cmbView,
    },
    manualPrevClose: {
      AU9999: cfg.manualPrevClose.AU9999 ?? undefined,
      XAU: cfg.manualPrevClose.XAU ?? undefined,
      CMB: cfg.manualPrevClose.CMB ?? undefined,
    },
    derived,
    quality,
    trend: {
      AU9999_1m: barsView(filterBarsToTradingHours(runtime.bars?.AU9999?.[1], cfg), TREND_POINTS, 1, now, false),
      XAU_1m: barsView(filterBarsToTradingHours(runtime.bars?.XAU?.[1], cfg), TREND_POINTS, 1, now, false),
      GCF_1m: barsView(filterBarsToTradingHours(runtime.bars?.GCF?.[1], cfg), TREND_POINTS, 1, now, false),
      CMB_1m: barsView(filterBarsToTradingHours(runtime.bars?.CMB?.[1], cfg), TREND_POINTS, 1, now, false),
    },
    indicators: plan.indicators ?? {},
    position: plan.position ?? {
      grams: cfg.position.grams,
      avgCostPerGram: cfg.position.avgCostPerGram,
      cmbNow: derived.cmb?.sellPrice,
      feeAdjustedPnl: 0,
      exitNeeded: round2(cfg.position.avgCostPerGram + cfg.fee.sellPerGram + cfg.strategy.estimatedSpreadPerGram + cfg.strategy.slippagePerGram),
      lots: cfg.position.lots ?? [],
    },
    plan: {
      action: plan.action,
      instrument: plan.instrument,
      signalPrice: plan.signalPrice,
      cmbEstimatedPrice: plan.cmbEstimatedPrice,
      cmbLive: plan.cmbLive,
      reasonCodes: plan.reasonCodes ?? [],
      dataCoverage: plan.dataCoverage,
      dataQuality: plan.dataQuality ?? quality,
      confidenceScore: plan.confidenceScore,
      confidenceMax: plan.confidenceMax,
      signalState: plan.signalState,
      breakeven: plan.breakeven,
      targetPrice: plan.targetPrice,
      stopPrice: plan.stopPrice,
      suggestedOrder: plan.suggestedOrder,
    },
    pendingOrder: runtime.lastSuggestedOrder ? {
      action: runtime.lastSuggestedOrder.action,
      instrument: runtime.lastSuggestedOrder.instrument,
      side: runtime.lastSuggestedOrder.side,
      signalPrice: runtime.lastSuggestedOrder.signalPrice,
      cmbEstimatedPrice: runtime.lastSuggestedOrder.cmbEstimatedPrice,
      grams: runtime.lastSuggestedOrder.grams,
      validUntil: runtime.lastSuggestedOrder.validUntil,
      reasonCodes: runtime.lastSuggestedOrder.reasonCodes ?? [],
    } : null,
  };
}

// ── alert engine ───────────────────────────────────────────────────────────

function templateReplace(text, params) {
  return String(text).replace(/\{\{(\w+)\}\}/g, (_, key) => params[key] ?? "");
}

export function sameSuggestedOrder(a, b) {
  if (!a || !b) return false;
  return a.side === b.side
    && a.action === b.action
    && a.instrument === b.instrument
    && Number(a.cmbEstimatedPrice) === Number(b.cmbEstimatedPrice)
    && Number(a.grams) === Number(b.grams);
}

export function buildOrderChangeMessage(plan, previousOrder, kind, config, localeHint = "zh") {
  const zh = localeHint !== "en";
  const action = kind === "update" ? "order_updated" : "cancel_order";
  const old = previousOrder || null;
  const current = plan?.suggestedOrder || null;
  const oldSideZh = old?.side === "buy" ? "买入" : old?.side === "sell" ? "卖出" : "";
  const oldGrams = old?.grams ?? "";
  const oldPrice = old?.cmbEstimatedPrice ?? old?.signalPrice ?? "";
  const instrument = old?.instrument ?? plan?.instrument ?? "XAU";
  const instrumentZh = instrument === "CMB" ? "招行积存金" : instrument;
  const instrumentEn = instrument === "CMB" ? "CMB 积存金" : instrument;
  const currentSignalPrice = Number.isFinite(Number(plan?.signalPrice)) && Number(plan.signalPrice) > 0
    ? Number(plan.signalPrice)
    : (Number.isFinite(Number(old?.signalPrice)) && Number(old.signalPrice) > 0 ? Number(old.signalPrice) : (old?.signalPrice ?? plan?.signalPrice ?? ""));
  const title = zh
    ? (kind === "update" ? "黄金看板 · 挂单建议已更新" : "黄金看板 · 请撤销原挂单")
    : (kind === "update" ? "Gold Board · order suggestion updated" : "Gold Board · cancel previous order");
  const parts = [];
  if (kind === "cancel") {
    if (oldSideZh && oldGrams) parts.push(`请撤销原${oldSideZh}挂单 ${oldGrams}克`);
    else if (oldSideZh) parts.push(`请撤销原${oldSideZh}挂单`);
    if (oldPrice) parts.push(`原挂单价 ${oldPrice} 元/克`);
    if (plan?.action && plan.action !== "cancel_order") {
      const currentLabel = zh ? ACTION_LABELS_ZH[plan.action] ?? plan.action : ACTION_LABELS_EN[plan.action] ?? plan.action;
      if (currentLabel) parts.push(`当前建议：${currentLabel}`);
    }
  } else {
    if (oldSideZh && oldGrams) parts.push(`原${oldSideZh}挂单 ${oldGrams}克已更新`);
    else if (oldSideZh) parts.push(`原${oldSideZh}挂单已更新`);
    if (oldPrice) parts.push(`原挂单价 ${oldPrice} 元/克`);
    if (current) {
      const newSideZh = current.side === "buy" ? "买入" : current.side === "sell" ? "卖出" : "";
      const newGrams = current.grams ?? "";
      const newPrice = current.cmbEstimatedPrice ?? current.signalPrice ?? "";
      if (newSideZh && newGrams) parts.push(`新建议：${newSideZh} ${newGrams}克`);
      else if (newSideZh) parts.push(`新建议：${newSideZh}`);
      if (newPrice) parts.push(`新挂单价 ${newPrice} 元/克`);
      if (plan?.targetPrice) parts.push(`卖出目标价 ${plan.targetPrice} 元/克`);
    }
    if (plan?.action && plan.action !== "order_updated") {
      const currentLabel = zh ? ACTION_LABELS_ZH[plan.action] ?? plan.action : ACTION_LABELS_EN[plan.action] ?? plan.action;
      if (currentLabel) parts.push(`当前建议：${currentLabel}`);
    }
  }
  const body = zh
    ? `${instrumentZh} 现价 ${currentSignalPrice} 元/克\n${title}\n${parts.join(" · ")}`
    : `${instrumentEn} current ${currentSignalPrice} CNY/g\n${title}\n${parts.join(" · ")}`;
  return {
    title,
    body,
    action,
    params: {
      action: title,
      instrument,
      price: currentSignalPrice,
      cmbPrice: oldPrice,
      suggestedPrice: oldPrice,
      target: plan?.targetPrice ?? "",
      grams: oldGrams,
      time: new Date().toISOString(),
    },
  };
}

export function buildAlertMessage(plan, config, localeHint = "zh") {
  const action = plan?.action ?? "no_data";
  const order = plan?.suggestedOrder;
  const zh = localeHint !== "en";
  const label = zh ? ACTION_LABELS_ZH[action] ?? action : ACTION_LABELS_EN[action] ?? action;
  const cfg = normalizeConfig(config);
  // For the message header, show the current market price rather than the
  // suggested order price. A buy suggestion may be a limit order below the
  // current CMB price; using order.signalPrice here made the alert claim that
  // the limit price was the live "现价".
  const currentSignalPrice = Number.isFinite(Number(plan?.signalPrice)) && Number(plan.signalPrice) > 0
    ? Number(plan.signalPrice)
    : (Number.isFinite(Number(order?.signalPrice)) && Number(order.signalPrice) > 0 ? Number(order.signalPrice) : (order?.signalPrice ?? plan?.signalPrice ?? ""));
  const signalPrice = currentSignalPrice;
  const rawCmbPrice = order?.cmbEstimatedPrice ?? plan?.cmbEstimatedPrice;
  const sellActions = new Set([
    "sell_take_profit",
    "sell_trailing",
    "sell_stop",
    "sell_weakness",
    "reduce_position",
    "close_by_session_end",
  ]);
  const liveCmb = plan?.cmbLive === true || order?.cmbLive === true;
  const sellFee = liveCmb ? 0 : cfg.fee.sellPerGram;
  const instrument = order?.instrument ?? plan?.instrument ?? "XAU";
  const isSell = sellActions.has(action);
  const isBuy = !isSell && (order?.side === "buy" || action === "buy_setup" || action === "add_position");
  const sideZh = isSell ? "卖出" : isBuy ? "买入" : "";
  const sideEn = isSell ? "sell" : isBuy ? "buy" : "";
  const instrumentZh = instrument === "CMB" ? "招行积存金" : instrument;
  const instrumentEn = instrument === "CMB" ? "CMB 积存金" : instrument;
  let cmbPrice = rawCmbPrice ?? "";
  if (isBuy) {
    // Header "招行买入价" should be the current CMB customer buy price, not the
    // suggested limit order price stored in order.cmbEstimatedPrice.
    const buyBase = Number.isFinite(Number(plan?.signalPrice)) && Number(plan.signalPrice) > 0
      ? Number(plan.signalPrice)
      : (Number.isFinite(Number(plan?.xauCnyPerGram)) && Number(plan.xauCnyPerGram) > 0 ? Number(plan.xauCnyPerGram) : NaN);
    if (Number.isFinite(buyBase)) {
      cmbPrice = liveCmb ? round2(buyBase) : round2(buyBase + cfg.cmb.buySpreadPerGram);
    } else if (Number.isFinite(Number(rawCmbPrice)) && Number(rawCmbPrice) > 0) {
      cmbPrice = rawCmbPrice;
    } else {
      cmbPrice = "";
    }
  } else if (Number.isFinite(Number(rawCmbPrice)) && Number(rawCmbPrice) > 0) {
    if (isSell) {
      const sellAfterFee = round2(Number(rawCmbPrice) - sellFee);
      if (Number.isFinite(sellAfterFee)) cmbPrice = sellAfterFee;
    } else {
      cmbPrice = rawCmbPrice;
    }
  } else if (Number.isFinite(Number(plan?.xauCnyPerGram)) && Number(plan.xauCnyPerGram) > 0) {
    // Fallback to the international-converted price + configured spread when
    // the plan did not carry a live CMB price.
    const fallbackBase = Number(plan.xauCnyPerGram);
    if (isSell) {
      const sellAfterFee = round2(fallbackBase + cfg.cmb.sellSpreadPerGram - sellFee);
      if (Number.isFinite(sellAfterFee)) cmbPrice = sellAfterFee;
    } else {
      const buyEstimate = round2(fallbackBase + cfg.cmb.buySpreadPerGram);
      if (Number.isFinite(buyEstimate)) cmbPrice = buyEstimate;
    }
  }
  const suggestedCmbPrice = order?.cmbEstimatedPrice ?? order?.signalPrice ?? "";
  const params = {
    action: label,
    instrument,
    price: signalPrice ?? "",
    cmbPrice,
    suggestedPrice: suggestedCmbPrice,
    target: plan?.targetPrice ?? "",
    grams: order?.grams ?? plan?.grams ?? "",
    time: new Date().toISOString(),
  };
  const title = zh ? `黄金看板 · ${label}` : `Gold Board · ${label}`;
  const zhOrderParts = [];
  if (isBuy && params.grams) zhOrderParts.push(`建议挂单买入 ${params.grams}克`);
  else if (isSell && params.grams && Number.isFinite(Number(params.cmbPrice)) && Number(params.cmbPrice) > 0) zhOrderParts.push(`建议按招行卖出价 ${params.cmbPrice} 卖出 ${params.grams}克`);
  else if (sideZh && params.grams) zhOrderParts.push(`建议${sideZh} ${params.grams}克`);
  else if (sideZh) zhOrderParts.push(`建议${sideZh}`);
  else if (params.grams) zhOrderParts.push(`${params.grams}克`);
  if (isBuy && Number.isFinite(Number(params.suggestedPrice)) && Number(params.suggestedPrice) > 0) {
    zhOrderParts.push(`挂单价 ${params.suggestedPrice} 元/克`);
  }
  if (params.target) zhOrderParts.push(`${isBuy || isSell ? "卖出目标价" : "目标价"} ${params.target} 元/克`);
  const enOrderParts = [];
  if (isBuy && params.grams) enOrderParts.push(`Suggested limit buy ${params.grams}g`);
  else if (isSell && params.grams && Number.isFinite(Number(params.cmbPrice)) && Number(params.cmbPrice) > 0) enOrderParts.push(`Suggested sell at CMB sell price ${params.cmbPrice} ${params.grams}g`);
  else if (sideEn && params.grams) enOrderParts.push(`Suggested ${sideEn} ${params.grams}g`);
  else if (sideEn) enOrderParts.push(`Suggested ${sideEn}`);
  else if (params.grams) enOrderParts.push(`${params.grams}g`);
  if (isBuy && Number.isFinite(Number(params.suggestedPrice)) && Number(params.suggestedPrice) > 0) {
    enOrderParts.push(`Limit price ${params.suggestedPrice} CNY/g`);
  }
  if (params.target) enOrderParts.push(`${isBuy || isSell ? "sell target" : "target"} ${params.target} CNY/g`);
  const body = zh
    ? `${instrumentZh} ${isSell || isBuy ? "现价" : "参考价"} ${params.price} 元/克 · ${isSell ? "招行卖出价" : isBuy ? "招行买入价" : "招行参考价"} ${params.cmbPrice} 元/克\n${params.action}\n${zhOrderParts.join(" · ")}`
    : `${instrumentEn} ${isSell || isBuy ? "current" : "reference"} ${params.price} CNY/g · CMB ${isSell ? "sell" : isBuy ? "buy" : "reference"} price ${params.cmbPrice} CNY/g\n${params.action}\n${enOrderParts.join(" · ")}`;
  return { title, body, action, params };
}

function appleScriptString(value) {
  return `"${String(value).replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
}

function psString(value) {
  return `"${String(value).replace(/`/g, "``").replace(/\$/g, "`$").replace(/"/g, '`"')}"`;
}

async function systemNotify(title, body) {
  const current = platform();
  if (current === "darwin") {
    await execFileAsync("osascript", ["-e", `display notification ${appleScriptString(body)} with title ${appleScriptString(title)}`]);
    return;
  }
  if (current === "linux") {
    await execFileAsync("notify-send", [title, body]);
    return;
  }
  if (current === "win32") {
    const script = [
      "[Windows.UI.Notifications.ToastNotificationManager, Windows.UI.Notifications, ContentType = WindowsRuntime] | Out-Null",
      "[Windows.Data.Xml.Dom.XmlDocument, Windows.Data.Xml.Dom.XmlDocument, ContentType = WindowsRuntime] | Out-Null",
      "$xml = [Windows.UI.Notifications.ToastNotificationManager]::GetTemplateContent([Windows.UI.Notifications.ToastTemplateType]::ToastText02)",
      "$texts = $xml.GetElementsByTagName('text')",
      `$texts.Item(0).AppendChild($xml.CreateTextNode(${psString(title)})) | Out-Null`,
      `$texts.Item(1).AppendChild($xml.CreateTextNode(${psString(body)})) | Out-Null`,
      "$toast = [Windows.UI.Notifications.ToastNotification]::new($xml)",
      '[Windows.UI.Notifications.ToastNotificationManager]::CreateToastNotifier("{1AC14E77-02E7-4E5D-B744-2EB1AE5198B7}\\WindowsPowerShell\\v1.0\\powershell.exe").Show($toast)',
    ].join("; ");
    await execFileAsync("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", script]);
    return;
  }
  throw new Error(`当前平台（${current}）不支持系统通知`);
}

function execFileAsync(file, args) {
  return new Promise((resolve, reject) => {
    execFile(file, args, { timeout: 10_000 }, (error, stdout, stderr) => {
      if (error) reject(error);
      else resolve({ stdout, stderr });
    });
  });
}

export function renderWebhookTemplate(template, message) {
  if (typeof template !== "string" || template.trim() === "") return message.body;
  return templateReplace(template, message.params);
}

/** Merge an unsaved settings-page draft over the saved channel for a test send. */
export function mergeTestConfig(saved, draft) {
  if (draft === null || typeof draft !== "object") return saved ?? {};
  const next = { ...(saved ?? {}), ...draft };
  if (Object.prototype.hasOwnProperty.call(next, "secret")) {
    next.secret = typeof draft.secret === "string" && draft.secret !== "" ? draft.secret : (saved?.secret ?? "");
  }
  if (draft.headers !== null && typeof draft.headers === "object" && saved?.headers !== null && typeof saved?.headers === "object") {
    next.headers = { ...saved.headers, ...draft.headers };
  }
  return next;
}

async function postJson(url, value, headers = {}) {
  const response = await fetchWithTimeout(url, {
    method: "POST",
    headers: { "content-type": "application/json; charset=utf-8", ...headers },
    body: JSON.stringify(value),
  });
  const text = await response.text();
  let data = null;
  if (text !== "") {
    try { data = JSON.parse(text); } catch { /* some gateways return non-JSON success */ }
  }
  return { response, data };
}

function webhookConfigError(message) {
  return Object.assign(new Error(message), { statusCode: 400, code: "WEBHOOK_NOT_CONFIGURED" });
}

async function sendFeishu(cfg, text) {
  if (!cfg?.enabled) throw webhookConfigError("飞书 webhook 未启用");
  if (!cfg.url) throw webhookConfigError("飞书 webhook 地址未配置");
  const secret = cfg.secret;
  const timestamp = Math.floor(Date.now() / 1000);
  const payload = { msg_type: "text", content: { text } };
  if (secret) {
    const stringToSign = `${timestamp}\n${secret}`;
    const sign = createHmac("sha256", stringToSign).update("").digest("base64");
    payload.timestamp = timestamp;
    payload.sign = sign;
  }
  const { data } = await postJson(cfg.url, payload);
  if (data !== null && typeof data.code === "number" && data.code !== 0) {
    throw new Error(`飞书 webhook 失败：${data.msg ?? data.code}`);
  }
}

async function sendDingtalk(cfg, text) {
  if (!cfg?.enabled) throw webhookConfigError("钉钉 webhook 未启用");
  if (!cfg.url) throw webhookConfigError("钉钉 webhook 地址未配置");
  const secret = cfg.secret;
  const timestamp = Date.now();
  let url = cfg.url;
  if (secret) {
    const stringToSign = `${timestamp}\n${secret}`;
    const sign = encodeURIComponent(createHmac("sha256", secret).update(stringToSign).digest("base64"));
    url += (url.includes("?") ? "&" : "?") + `timestamp=${timestamp}&sign=${sign}`;
  }
  const { data } = await postJson(url, { msgtype: "text", text: { content: text } });
  if (data !== null && typeof data.errcode === "number" && data.errcode !== 0) {
    throw new Error(`钉钉 webhook 失败：${data.errmsg ?? data.errcode}`);
  }
}

async function sendWecom(cfg, text) {
  if (!cfg?.enabled) throw webhookConfigError("企业微信 webhook 未启用");
  if (!cfg.url) throw webhookConfigError("企业微信 webhook 地址未配置");
  const { data } = await postJson(cfg.url, { msgtype: "text", text: { content: text } });
  if (data !== null && typeof data.errcode === "number" && data.errcode !== 0) {
    throw new Error(`企业微信 webhook 失败：${data.errmsg ?? data.errcode}`);
  }
}

async function sendGeneric(cfg, text) {
  if (!cfg?.enabled) throw webhookConfigError("通用 webhook 未启用");
  if (!cfg.url) throw webhookConfigError("通用 webhook 地址未配置");
  const headers = { "user-agent": USER_AGENT, ...cfg.headers };
  await postJson(cfg.url, { text: text }, headers);
}

export async function dispatchAlert(config, message, logger) {
  const tasks = [];
  if (config.system.enabled) {
    tasks.push(systemNotify(message.title, message.body).catch((error) => logger?.warn?.(`dsh-plugin-goldboard: system notify failed: ${String(error?.message ?? error)}`)));
  }
  const wh = config.webhooks;
  if (wh.feishu.enabled) tasks.push(sendFeishu(wh.feishu, renderWebhookTemplate(wh.feishu.bodyTemplate, message)).catch((error) => logger?.warn?.(`dsh-plugin-goldboard: feishu failed: ${String(error?.message ?? error)}`)));
  if (wh.dingtalk.enabled) tasks.push(sendDingtalk(wh.dingtalk, renderWebhookTemplate(wh.dingtalk.bodyTemplate, message)).catch((error) => logger?.warn?.(`dsh-plugin-goldboard: dingtalk failed: ${String(error?.message ?? error)}`)));
  if (wh.wecom.enabled) tasks.push(sendWecom(wh.wecom, renderWebhookTemplate(wh.wecom.bodyTemplate, message)).catch((error) => logger?.warn?.(`dsh-plugin-goldboard: wecom failed: ${String(error?.message ?? error)}`)));
  for (const generic of wh.generic) {
    if (generic.enabled) {
      tasks.push(sendGeneric(generic, renderWebhookTemplate(generic.bodyTemplate, message)).catch((error) => logger?.warn?.(`dsh-plugin-goldboard: generic ${generic.id} failed: ${String(error?.message ?? error)}`)));
    }
  }
  await Promise.allSettled(tasks);
}

// ── host apply ─────────────────────────────────────────────────────────────

function sendJson(res, status, value) {
  const body = JSON.stringify(value);
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store",
    "content-length": Buffer.byteLength(body),
  });
  res.end(body);
}

async function readBody(req, limit = MAX_CONFIG_BYTES) {
  let size = 0;
  const chunks = [];
  for await (const chunk of req) {
    size += chunk.length;
    if (size > limit) {
      const error = new Error("body too large");
      error.code = "PAYLOAD_TOO_LARGE";
      throw error;
    }
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}

/** Re-run the pure quality/indicator/plan projection over one fixed market fixture. */
export function replayMarketPlan(input, config = DEFAULT_CONFIG) {
  if (!input || typeof input !== "object") throw new TypeError("replay input must be an object");
  const asOf = new Date(input.asOf ?? input.serverTime ?? Date.now());
  if (!Number.isFinite(asOf.getTime())) throw new TypeError("replay asOf must be an ISO timestamp");
  const sourceQuotes = input.quotes && typeof input.quotes === "object" ? input.quotes : {};
  const quotes = { AU9999: null, XAU: null, GCF: null, USDCNY: null, CMB: null };
  for (const key of Object.keys(quotes)) {
    const quote = sourceQuotes[key];
    if (!quote || typeof quote !== "object") continue;
    const receivedAt = Number.isFinite(Number(quote.updatedAt))
      ? Number(quote.updatedAt)
      : Number.isFinite(Date.parse(quote.receivedAt ?? ""))
        ? Date.parse(quote.receivedAt)
        : asOf.getTime();
    quotes[key] = normalizeQuoteRecord(key, quote, receivedAt);
  }
  const sourceBars = input.bars && typeof input.bars === "object" ? input.bars : {};
  const runtime = {
    quotes,
    bars: {
      AU9999: ensureBars(sourceBars.AU9999),
      XAU: ensureBars(sourceBars.XAU),
      GCF: ensureBars(sourceBars.GCF),
      CMB: ensureBars(sourceBars.CMB),
    },
  };
  runtime.plan = computePlan(runtime, config, asOf);
  return {
    ok: true,
    replay: {
      asOf: asOf.toISOString(),
      calculationVersion: CALCULATION_VERSION,
      deterministic: true,
    },
    snapshot: buildSnapshot(runtime, config, asOf),
  };
}

export function apply(ctx, config = {}) {
  const logger = ctx.logger;
  const webServer = ctx.webServer;
  const writeQueue = makeWriteQueue();
  const stateDir = typeof config.directory === "string" && config.directory !== "" ? config.directory : pluginDir();

  const runtime = {
    config: normalizeConfig(config),
    quotes: { AU9999: null, XAU: null, GCF: null, USDCNY: null, CMB: null },
    bars: { AU9999: ensureBars({}), XAU: ensureBars({}), GCF: ensureBars({}), CMB: ensureBars({}) },
    plan: null,
    alertState: {},
    signalState: defaultSignalState(),
    lastSuggestedOrder: null,
    localeHint: "zh",
    lastAlertLog: [],
    lastSnapshot: null,
    lastSnapshotBuiltAt: 0,
    lastAnalysis: null,
    ready: false,
    lastBackfillAt: 0,
    ticking: false,
  };

  const configPath = join(stateDir, CONFIG_FILE);
  const statePath = join(stateDir, STATE_FILE);
  const alertsPath = join(stateDir, ALERTS_LOG_FILE);
  const analysisLogStore = new AnalysisLogStore({
    file: join(stateDir, ANALYSIS_LOG_FILE),
    maxEntries: runtime.config.analysis.maxLogEntries,
    logger,
  });
  setApiLogSink(join(stateDir, API_LOG_FILE), writeQueue);

  function analysisBarsFor(instrument, now) {
    const bars5 = closedBars(runtime.bars?.[instrument]?.[5] ?? [], 5, now);
    const bars10 = resampleBars(bars5, 2).filter((bar) => isBarClosed(bar, 10, now));
    const bars30 = resampleBars(bars5, 6).filter((bar) => isBarClosed(bar, 30, now));
    const bars60 = closedBars(runtime.bars?.[instrument]?.[60] ?? [], 60, now);
    const bars1d = closedBars(runtime.bars?.[instrument]?.[1440] ?? [], 1440, now);
    return {
      "5m": barsView(bars5, 120, 5, now),
      "10m": barsView(bars10, 120, 10, now),
      "30m": barsView(bars30, 120, 30, now),
      "60m": barsView(bars60, 120, 60, now),
      "1d": barsView(bars1d, 120, 1440, now),
    };
  }

  const analysisModule = new AnalysisModule({
    llm: ctx.llm ?? ctx.get?.("llm"),
    getConfig: () => runtime.config,
    getContext: async () => {
      // Freeze analysis on the exact snapshot advertised by /snapshot. A later
      // market tick creates a new snapshot rather than silently changing asOf.
      if (!runtime.lastSnapshot) refreshSnapshot(new Date());
      const snapshot = runtime.lastSnapshot;
      const now = new Date(snapshot.serverTime);
      return {
        snapshot,
        bars: {
          AU9999: analysisBarsFor("AU9999", now),
          XAU: analysisBarsFor("XAU", now),
          GCF: analysisBarsFor("GCF", now),
          CMB: analysisBarsFor("CMB", now),
        },
      };
    },
    logStore: analysisLogStore,
    logger,
    onResult: (result) => {
      runtime.lastAnalysis = result;
    },
  });
  runtime.analysis = analysisModule;
  runtime.analysisLog = analysisLogStore;

  function refreshSnapshot(now = new Date()) {
    const snapshot = buildSnapshot(runtime, runtime.config, now);
    snapshot.analysis = analysisModule.status();
    runtime.lastSnapshot = snapshot;
    runtime.lastSnapshotBuiltAt = Date.now();
    return snapshot;
  }

  function recordQuote(key, quote) {
    if (!quote || !(quote.price > 0)) return;
    // Never let a stale domestic quote masquerade as a fresh tick; doing so
    // would create fake flat bars in the today trend after the source stops
    // updating (e.g. Au99.99 stuck at 952.4 after 16:00).
    if (key === "AU9999" && !isDomesticQuoteFresh(quote, new Date())) return;
    const normalized = normalizeQuoteRecord(key, quote, Date.now());
    if (!normalized) return;
    runtime.quotes[key] = normalized;
    // Only build minute bars during configured trading hours. The daily
    // 02:00-09:00 closed period should stay out of the chart and indicators.
    if (computeMarketState(runtime.config, new Date(normalized.updatedAt)).state === "open") {
      recordTick(runtime.bars[key], normalized, normalized.updatedAt);
      markStateDirty("bars");
    }
  }

  // ── state persistence: partitioned dirty flags ──────────────────────────
  //
  // `bars` (the MB-level bulk) is written at most once per
  // STATE_BARS_FLUSH_MS, anchored to a whole-minute boundary so the write
  // lands right after the latest 1m bucket rolls over. Everything else
  // (quotes / alertState / signalState / lastSuggestedOrder / lastAlertLog,
  // KB-level) writes immediately when marked. state.json remains a single
  // file; only the write *rhythm* differs by section.
  const stateDirty = { bars: false, other: false };
  let lastStateFlushAt = 0;
  let lastFlushMinuteBucket = -1;

  function markStateDirty(section) {
    if (section === "bars") stateDirty.bars = true;
    else stateDirty.other = true;
  }

  function serializeState() {
    return {
      quotes: runtime.quotes,
      bars: runtime.bars,
      barsSeedVersion: BARS_SEED_VERSION,
      alertState: runtime.alertState,
      signalState: runtime.signalState,
      lastSuggestedOrder: runtime.lastSuggestedOrder,
      lastAlertLog: runtime.lastAlertLog,
    };
  }

  async function flushState(nowMs = Date.now()) {
    const hadBars = stateDirty.bars;
    const hadOther = stateDirty.other;
    stateDirty.bars = false;
    stateDirty.other = false;
    lastStateFlushAt = nowMs;
    lastFlushMinuteBucket = Math.floor(nowMs / 60_000);
    try {
      await writeJsonAtomic(statePath, serializeState(), writeQueue);
    } catch (error) {
      // Restore the flags so the next due tick retries the write.
      stateDirty.bars ||= hadBars;
      stateDirty.other ||= hadOther;
      logger?.warn?.(`dsh-plugin-goldboard: persist state failed: ${String(error?.message ?? error)}`);
    }
  }

  /** Write from the tick loop: honour the bars flush rhythm, others immediately. */
  function maybeFlushState() {
    const nowMs = Date.now();
    if (stateDirty.other) return flushState(nowMs);
    if (!stateDirty.bars) return undefined;
    const minuteBucket = Math.floor(nowMs / 60_000);
    const due = nowMs - lastStateFlushAt >= STATE_BARS_FLUSH_MS && minuteBucket !== lastFlushMinuteBucket;
    return due ? flushState(nowMs) : undefined;
  }

  /** Forced write: dispose final flush and user-triggered mutations. */
  function persistState() {
    return flushState();
  }

  function persistConfig() {
    return writeJsonAtomic(configPath, runtime.config, writeQueue).catch((error) => logger?.warn?.(`dsh-plugin-goldboard: persist config failed: ${String(error?.message ?? error)}`));
  }

  async function validateAnalysisConfig(nextConfig) {
    const analysis = nextConfig.analysis;
    if (analysis.enabled !== true) return;
    if (!analysis.provider || !analysis.model) {
      const error = new Error("analysis provider and model are required");
      error.code = "MODEL_NOT_SELECTED";
      throw error;
    }
    const llm = ctx.llm ?? ctx.get?.("llm");
    if (!llm || typeof llm.prepareCall !== "function") {
      const error = new Error("LLM runtime unavailable");
      error.code = "LLM_UNAVAILABLE";
      throw error;
    }
    try {
      await llm.prepareCall({
        provider: analysis.provider,
        model: analysis.model,
        ...(analysis.reasoningEffort ? { reasoningEffort: analysis.reasoningEffort } : {}),
        temperature: analysis.temperature,
        maxTokens: analysis.maxTokens,
      });
    } catch (cause) {
      const error = new Error("selected analysis model is unavailable");
      error.code = "MODEL_UNAVAILABLE";
      error.cause = cause;
      throw error;
    }
  }

  async function logAlert(message, channelResults) {
    runtime.lastAlertLog.unshift({
      time: new Date().toISOString(),
      action: message.action,
      price: message.params.price,
      cmbPrice: message.params.cmbPrice,
      grams: message.params.grams,
      sentTo: channelResults.map((entry) => entry.status === "fulfilled" ? entry.value : "error"),
    });
    runtime.lastAlertLog = runtime.lastAlertLog.slice(0, 200);
    await writeJsonAtomic(alertsPath, runtime.lastAlertLog, writeQueue).catch(() => {});
  }

  async function evaluateAlerts() {
    const plan = runtime.plan;
    if (!plan) return;
    const action = plan.action;
    const currentOrder = plan.suggestedOrder || null;
    const previousOrder = runtime.lastSuggestedOrder || null;
    const orderEvent = previousOrder
      ? (!currentOrder ? "cancel" : (!sameSuggestedOrder(previousOrder, currentOrder) ? "update" : "none"))
      : "none";

    if (orderEvent === "cancel") {
      runtime.lastSuggestedOrder = null;
      const message = buildOrderChangeMessage(plan, previousOrder, "cancel", runtime.config, runtime.localeHint);
      const results = await Promise.allSettled([dispatchAlert(runtime.config, message, logger)]);
      await logAlert(message, results);
      runtime.alertState = {};
      return;
    }

    if (orderEvent === "update") {
      runtime.lastSuggestedOrder = currentOrder;
      const message = buildOrderChangeMessage(plan, previousOrder, "update", runtime.config, runtime.localeHint);
      const results = await Promise.allSettled([dispatchAlert(runtime.config, message, logger)]);
      await logAlert(message, results);
      if (currentOrder?.action) runtime.alertState[currentOrder.action] = "fired";
      return;
    }

    const alertable = new Set([
      "buy_setup",
      "add_position",
      "reduce_position",
      "sell_take_profit",
      "sell_trailing",
      "sell_stop",
      "sell_weakness",
      "close_by_session_end",
      "spread_alert",
      "data_stale",
    ]);
    if (!alertable.has(action)) {
      runtime.alertState = {};
      return;
    }
    if (runtime.alertState[action] === "fired") return;
    runtime.alertState[action] = "fired";
    if (currentOrder) runtime.lastSuggestedOrder = currentOrder;
    const message = buildAlertMessage(plan, runtime.config, runtime.localeHint);
    const results = await Promise.allSettled([dispatchAlert(runtime.config, message, logger)]);
    await logAlert(message, results);
  }

  function setQuoteError(key) {
    runtime.quotes[key] = normalizeQuoteRecord(key, {
      price: 0,
      source: "error",
      stale: true,
      error: true,
      quality: "degraded",
    }, Date.now());
  }

  async function refreshQuotes() {
    const results = await Promise.allSettled([
      fetchDomesticQuote(),
      fetchCmbQuote(),
      fetchXauQuote(),
      fetchUsdcnyQuote(),
    ]);
    const [domestic, cmb, xau, usdcny] = results;
    if (domestic.status === "fulfilled" && domestic.value && domestic.value.price > 0) {
      recordQuote("AU9999", domestic.value);
    } else {
      // Do not keep showing a stale last trade when every domestic source
      // has failed; surface the failure as 0 so the user can see it is not
      // a live quote.
      setQuoteError("AU9999");
    }
    if (cmb.status === "fulfilled") recordQuote("CMB", cmb.value);
    if (xau.status === "fulfilled" && xau.value) {
      // Yahoo GC=F is a futures fallback and must never overwrite the spot XAU
      // series. Keep it in a separate quote/bar lane for diagnostics only.
      recordQuote(xau.value.source === "yahoo" ? "GCF" : "XAU", xau.value);
    }
    if (usdcny.status === "fulfilled") recordQuote("USDCNY", usdcny.value);
    // XAU/USDCNY/CMB intentionally keep previous values; stale flag is derived
    // from updatedAt. Domestic Au99.99 is the preferred signal instrument, and
    // XAU+USDCNY is the CMB fallback source, so failures are surfaced clearly.
    // Brand / accumulated-gold APIs are auxiliary: poll them in the background
    // so the data-source status page can show their health without delaying
    // the main quote refresh.
    void Promise.allSettled([
      fetchJijinhaoQuote(),
      fetchJdGoldQuote(),
    ]).catch(() => {});
  }

  async function seedHistory() {
    const au5 = runtime.bars.AU9999[5];
    if (au5.length < 60) {
      try {
        const klines = await fetchEastmoneyBars("118.AU9999", 5, 480);
        if (klines.length > 0) {
          seedBars(runtime.bars.AU9999, filterBarsToTradingHours(klines, runtime.config), AU_BAR_META);
          markStateDirty("bars");
        }
      } catch (error) {
        logger?.warn?.(`dsh-plugin-goldboard: seed AU9999 klines failed: ${String(error?.message ?? error)}`);
      }
    }
    if (runtime.bars.AU9999[60].length < 20) {
      try {
        const klines = await fetchEastmoneyBars("118.AU9999", 60, 240);
        if (klines.length > 0) {
          mergeKlines(runtime.bars.AU9999[60], filterBarsToTradingHours(klines, runtime.config), 60, AU_BAR_META);
          markStateDirty("bars");
        }
      } catch (error) {
        logger?.warn?.(`dsh-plugin-goldboard: seed AU9999 60m failed: ${String(error?.message ?? error)}`);
      }
    }

    // XAU intraday is also useful from cold start; Eastmoney provides a stable
    // free source for the same kline shape as Au99.99.
    const xau5 = runtime.bars.XAU[5];
    if (xau5.length < 60) {
      try {
        const klines = await fetchEastmoneyBars("122.XAU", 5, 480);
        if (klines.length > 0) {
          seedBars(runtime.bars.XAU, filterBarsToTradingHours(klines, runtime.config), XAU_BAR_META);
          markStateDirty("bars");
        }
      } catch (error) {
        logger?.warn?.(`dsh-plugin-goldboard: seed XAU klines failed: ${String(error?.message ?? error)}`);
      }
    }
    if (runtime.bars.XAU[60].length < 20) {
      try {
        const klines = await fetchEastmoneyBars("122.XAU", 60, 240);
        if (klines.length > 0) {
          mergeKlines(runtime.bars.XAU[60], filterBarsToTradingHours(klines, runtime.config), 60, XAU_BAR_META);
          markStateDirty("bars");
        }
      } catch (error) {
        logger?.warn?.(`dsh-plugin-goldboard: seed XAU 60m failed: ${String(error?.message ?? error)}`);
      }
    }

    // Daily history: Eastmoney is the primary free source for both markets;
    // SGE official history and Yahoo Finance daily chart are the documented
    // fallbacks from docs/research/gold-price-api.md.
    const auDaily = runtime.bars.AU9999[1440] ?? (runtime.bars.AU9999[1440] = []);
    if (auDaily.length < 20) {
      try {
        const klines = await fetchEastmoneyBars("118.AU9999", 101, 500);
        if (klines.length > 0) {
          mergeKlines(runtime.bars.AU9999[1440], klines, 1440, AU_BAR_META);
          markStateDirty("bars");
        }
      } catch (error) {
        logger?.warn?.(`dsh-plugin-goldboard: seed AU9999 daily failed: ${String(error?.message ?? error)}`);
      }
      if ((runtime.bars.AU9999[1440]?.length ?? 0) < 20) {
        try {
          const daily = await fetchSgeDailyBars();
          if (daily.length > 0) {
            mergeKlines(runtime.bars.AU9999[1440], daily, 1440, { ...AU_BAR_META, source: "sge" });
            markStateDirty("bars");
          }
        } catch (sgeError) {
          logger?.warn?.(`dsh-plugin-goldboard: seed AU9999 SGE daily failed: ${String(sgeError?.message ?? sgeError)}`);
        }
      }
    }
    const xauDaily = runtime.bars.XAU[1440] ?? (runtime.bars.XAU[1440] = []);
    if (xauDaily.length < 20) {
      try {
        const klines = await fetchEastmoneyBars("122.XAU", 101, 500);
        if (klines.length > 0) {
          mergeKlines(runtime.bars.XAU[1440], klines, 1440, XAU_BAR_META);
          markStateDirty("bars");
        }
      } catch (error) {
        logger?.warn?.(`dsh-plugin-goldboard: seed XAU daily failed: ${String(error?.message ?? error)}`);
      }
    }
    // Yahoo exposes COMEX GC=F futures, not XAU/USD spot. Preserve it as a
    // separate diagnostic series instead of silently backfilling spot history.
    const gcfDaily = runtime.bars.GCF[1440] ?? (runtime.bars.GCF[1440] = []);
    if (gcfDaily.length < 20) {
      try {
        const daily = await fetchYahooXauDailyBars();
        if (daily.length > 0) {
          mergeKlines(runtime.bars.GCF[1440], daily, 1440, GCF_BAR_META);
          markStateDirty("bars");
        }
      } catch (yahooError) {
        logger?.warn?.(`dsh-plugin-goldboard: seed GC=F Yahoo daily failed: ${String(yahooError?.message ?? yahooError)}`);
      }
    }
  }

  function backfillCmbFromInternational() {
    const xau = runtime.quotes.XAU;
    const usdcny = runtime.quotes.USDCNY;
    const cmbQuote = runtime.quotes.CMB;
    const basePrice = xauCnyPerGram(xau, usdcny);
    if (basePrice === null) return;
    let spread = null;
    if (cmbQuote && Number.isFinite(Number(cmbQuote.buyPrice)) && Number(cmbQuote.buyPrice) > 0) {
      spread = Number(cmbQuote.buyPrice) - basePrice;
    } else {
      spread = runtime.config.cmb.buySpreadPerGram;
    }
    if (!Number.isFinite(spread)) return;
    const now = new Date();
    const today = beijingDateForNow(now);
    const factor = Number(usdcny.price) / 31.1034768;
    const calendar = buildSessionCalendar(runtime.config);
    for (const interval of [1, 5]) {
      const xauBars = runtime.bars.XAU[interval];
      const cmbBars = runtime.bars.CMB[interval];
      if (!Array.isArray(xauBars) || xauBars.length === 0 || !Array.isArray(cmbBars)) continue;
      const byTime = new Map(cmbBars.map((bar) => [bar.t, bar]));
      let changed = false;
      for (const bar of xauBars) {
        if (!bar) continue;
        if (beijingDateForNow(new Date(bar.t)) !== today) continue;
        if (!isOpenMinute(calendar, bar.t)) continue;
        if (byTime.has(bar.t)) continue;
        byTime.set(bar.t, {
          t: bar.t,
          o: round2(bar.o * factor + spread),
          h: round2(bar.h * factor + spread),
          l: round2(bar.l * factor + spread),
          c: round2(bar.c * factor + spread),
          synthetic: true,
          source: "xau-fx-derived",
          instrument: "CMB_ACCUMULATED_GOLD",
          market: "bank",
          currency: "CNY",
          unit: "gram",
        });
        changed = true;
      }
      if (!changed) continue;
      const merged = Array.from(byTime.values()).sort((a, b) => a.t - b.t);
      cmbBars.length = 0;
      cmbBars.push(...merged.slice(-MAX_BARS));
      markStateDirty("bars");
    }
  }


  async function backfillTrend() {
    const now = Date.now();
    if (now - (runtime.lastBackfillAt || 0) < 60_000) return;
    const auMissing = hasMissingRecentBars(runtime.bars.AU9999[5], new Date(now), 5)
      || hasMissingLeadingBars(runtime.bars.AU9999[5], new Date(now), 5);
    const xauMissing = hasMissingRecentBars(runtime.bars.XAU[5], new Date(now), 5)
      || hasMissingLeadingBars(runtime.bars.XAU[5], new Date(now), 5);
    const cmbMissing = [1, 5].some((interval) =>
      runtime.bars.CMB[interval].length === 0
      || hasMissingRecentBars(runtime.bars.CMB[interval], new Date(now), interval)
      || hasMissingLeadingBars(runtime.bars.CMB[interval], new Date(now), interval)
    );
    if (!auMissing && !xauMissing && !cmbMissing) return;
    runtime.lastBackfillAt = now;
    if (auMissing) {
      try {
        const klines = await fetchEastmoneyBars("118.AU9999", 5, 480);
        if (klines.length > 0) mergeKlines(runtime.bars.AU9999[5], filterBarsToTradingHours(klines, runtime.config), 5, AU_BAR_META);
      } catch (error) {
        logger?.warn?.(`dsh-plugin-goldboard: backfill AU9999 5m failed: ${String(error?.message ?? error)}`);
      }
    }
    if (xauMissing) {
      try {
        const klines = await fetchEastmoneyBars("122.XAU", 5, 480);
        if (klines.length > 0) mergeKlines(runtime.bars.XAU[5], filterBarsToTradingHours(klines, runtime.config), 5, XAU_BAR_META);
      } catch (error) {
        logger?.warn?.(`dsh-plugin-goldboard: backfill XAU 5m failed: ${String(error?.message ?? error)}`);
      }
    }
    if (cmbMissing) {
      backfillCmbFromInternational();
    }
  }


  async function tick() {
    if (runtime.ticking) return;
    runtime.ticking = true;
    try {
      await refreshQuotes();
      await seedHistory();
      await backfillTrend();
      runtime.plan = computePlan(runtime, runtime.config);
      if (runtime.plan.signalState) runtime.signalState = runtime.plan.signalState;
      const cmbQuote = runtime.quotes.CMB;
      const cmbLive = cmbQuote && Number.isFinite(Number(cmbQuote.buyPrice)) && Number.isFinite(Number(cmbQuote.sellPrice))
        && Number(cmbQuote.buyPrice) > 0 && Number(cmbQuote.sellPrice) > 0;
      const fallbackMissing = !cmbLive && !hasCmbFallback(runtime.quotes.XAU, runtime.quotes.USDCNY);
      if (runtime.plan.action === "no_data" && fallbackMissing) {
        runtime.plan.action = "data_stale";
        runtime.plan.reasonCodes = ["quote_missing"];
      }
      refreshSnapshot();
      await evaluateAlerts();
      await maybeFlushState();
    } catch (error) {
      logger?.warn?.(`dsh-plugin-goldboard: tick failed: ${String(error?.message ?? error)}`);
    } finally {
      runtime.ticking = false;
    }
  }

  async function init() {
    try {
      await mkdir(stateDir, { recursive: true });
      try {
        const saved = await readJson(configPath, null);
        if (saved && typeof saved === "object") runtime.config = normalizeConfig({ ...runtime.config, ...saved });
      } catch (error) {
        logger?.warn?.(`dsh-plugin-goldboard: config load failed: ${String(error?.message ?? error)}`);
      }
      await analysisLogStore.setMaxEntries(runtime.config.analysis.maxLogEntries);
      await analysisLogStore.init();
      try {
        const savedState = await readJson(statePath, null);
        if (savedState && typeof savedState === "object") {
          if (savedState.bars) {
            const bars = {
              AU9999: ensureBars(savedState.bars.AU9999),
              XAU: ensureBars(savedState.bars.XAU),
              GCF: ensureBars(savedState.bars.GCF),
              CMB: ensureBars(savedState.bars.CMB),
            };
            // State from an older seeding format carries corrupt 60m buckets;
            // drop the affected series so seedBars rebuilds them (see
            // migrateBarsSeedVersion / BARS_SEED_VERSION).
            migrateBarsSeedVersion(bars, savedState.barsSeedVersion);
            runtime.bars = bars;
          }
          runtime.alertState = typeof savedState.alertState === "object" && savedState.alertState !== null ? savedState.alertState : {};
          if (savedState.signalState && typeof savedState.signalState === "object" && savedState.signalState !== null) {
            runtime.signalState = { ...defaultSignalState(), ...savedState.signalState };
          }
          if (savedState.lastSuggestedOrder && typeof savedState.lastSuggestedOrder === "object" && savedState.lastSuggestedOrder !== null) {
            runtime.lastSuggestedOrder = savedState.lastSuggestedOrder;
          }
          // localeHint is intentionally not restored: the notification-language
          // hint is session-only since v1.4.0 and defaults to "zh".
          if (Array.isArray(savedState.lastAlertLog)) runtime.lastAlertLog = savedState.lastAlertLog.slice(0, 200);
        }
      } catch (error) {
        logger?.warn?.(`dsh-plugin-goldboard: state load failed: ${String(error?.message ?? error)}`);
      }
      try {
        const savedLogs = await readApiLogs();
        if (savedLogs.length > 0) {
          apiLogs.length = 0;
          apiLogs.push(...savedLogs.slice(0, MAX_API_LOGS));
        }
      } catch (error) {
        logger?.warn?.(`dsh-plugin-goldboard: api log load failed: ${String(error?.message ?? error)}`);
      }
      await tick();
      runtime.ready = true;
    } catch (error) {
      logger?.warn?.(`dsh-plugin-goldboard: init failed: ${String(error?.message ?? error)}`);
    }
  }

  if (webServer) {
    const routes = [
      {
        path: "/dsh-plugin-goldboard/config",
        handler: async (req, res) => {
          if (req.method === "GET") {
            sendJson(res, 200, { ok: true, ...redactConfig(runtime.config) });
            return;
          }
          if (req.method === "POST") {
            try {
              const body = JSON.parse((await readBody(req)).toString("utf8"));
              const merged = mergeSecrets(runtime.config, body?.config, body?.clearSecrets);
              const nextConfig = normalizeConfig({ ...runtime.config, ...merged });
              await validateAnalysisConfig(nextConfig);
              runtime.config = nextConfig;
              await analysisLogStore.setMaxEntries(runtime.config.analysis.maxLogEntries);
              await persistConfig();
              runtime.plan = computePlan(runtime, runtime.config);
              if (runtime.plan.signalState) runtime.signalState = runtime.plan.signalState;
              refreshSnapshot();
              sendJson(res, 200, { ok: true, ...redactConfig(runtime.config) });
            } catch (error) {
              sendJson(res, error?.code === "PAYLOAD_TOO_LARGE" ? 413 : 400, {
                ok: false,
                error: { code: error?.code ?? "BAD_CONFIG", message: String(error?.message ?? error) },
              });
            }
            return;
          }
          sendJson(res, 405, { ok: false, error: { code: "METHOD_NOT_ALLOWED" } });
        },
      },
      {
        path: "/dsh-plugin-goldboard/models",
        handler: async (req, res) => {
          if (req.method !== "GET") {
            sendJson(res, 405, { ok: false, error: { code: "METHOD_NOT_ALLOWED" } });
            return;
          }
          try {
            sendJson(res, 200, { ok: true, ...(await analysisModule.models()) });
          } catch (error) {
            sendJson(res, 503, { ok: false, error: { code: "MODEL_CATALOG_UNAVAILABLE" } });
          }
        },
      },
      {
        path: "/dsh-plugin-goldboard/analysis",
        handler: async (req, res) => {
          if (req.method === "GET") {
            sendJson(res, 200, { ok: true, ...analysisModule.status() });
            return;
          }
          if (req.method !== "POST") {
            sendJson(res, 405, { ok: false, error: { code: "METHOD_NOT_ALLOWED" } });
            return;
          }
          try {
            const body = JSON.parse((await readBody(req)).toString("utf8"));
            const currentAsOf = runtime.lastSnapshot?.serverTime;
            if (body?.snapshotAsOf && currentAsOf && body.snapshotAsOf !== currentAsOf) {
              sendJson(res, 409, {
                ok: false,
                status: "stale_snapshot",
                error: { code: "SNAPSHOT_CHANGED" },
                snapshotAsOf: currentAsOf,
              });
              return;
            }
            const result = await analysisModule.run({
              force: body?.force === true,
              provider: str(body?.provider, 128),
              model: str(body?.model, 256),
              reasoningEffort: str(body?.reasoningEffort, 64),
              locale: body?.locale === "en" ? "en" : "zh",
            });
            refreshSnapshot();
            const status = result.ok ? 200 : result.status === "blocked" ? 422 : result.error?.code === "ANALYSIS_DISABLED" ? 409 : 400;
            sendJson(res, status, result);
          } catch (error) {
            sendJson(res, error?.code === "PAYLOAD_TOO_LARGE" ? 413 : 400, {
              ok: false,
              status: "error",
              error: { code: error?.code ?? "BAD_ANALYSIS_REQUEST" },
            });
          }
        },
      },
      {
        path: "/dsh-plugin-goldboard/analysis-logs",
        handler: async (req, res) => {
          if (req.method !== "GET") {
            sendJson(res, 405, { ok: false, error: { code: "METHOD_NOT_ALLOWED" } });
            return;
          }
          const url = new URL(req.url ?? "/", "http://x");
          sendJson(res, 200, analysisLogStore.query({
            limit: url.searchParams.get("limit"),
            cursor: url.searchParams.get("cursor"),
            queryId: url.searchParams.get("queryId"),
            status: url.searchParams.get("status"),
            provider: url.searchParams.get("provider"),
            model: url.searchParams.get("model"),
            from: url.searchParams.get("from"),
            to: url.searchParams.get("to"),
            detail: url.searchParams.get("detail") === "true",
          }));
        },
      },
      {
        path: "/dsh-plugin-goldboard/snapshot",
        handler: async (req, res) => {
          if (req.method !== "GET") {
            sendJson(res, 405, { ok: false, error: { code: "METHOD_NOT_ALLOWED" } });
            return;
          }
          const localeHint = String(req.headers["x-dsh-locale"] ?? "").toLowerCase() === "en" ? "en" : "zh";
          // Notification-language hint is session-only memory (v1.4.0): the
          // flip used to force a full state.json write per locale change.
          if (localeHint !== runtime.localeHint) runtime.localeHint = localeHint;
          // Serve the cached snapshot for repeated requests (poll bursts,
          // parallel tabs); ticks already rebuild it every poll cycle.
          if (!runtime.lastSnapshot || snapshotCacheStale(runtime.lastSnapshotBuiltAt, Date.now())) {
            runtime.plan = computePlan(runtime, runtime.config);
            refreshSnapshot();
          }
          sendJson(res, 200, runtime.lastSnapshot);
        },
      },
      {
        path: "/dsh-plugin-goldboard/bars",
        handler: async (req, res) => {
          if (req.method !== "GET") {
            sendJson(res, 405, { ok: false, error: { code: "METHOD_NOT_ALLOWED" } });
            return;
          }
          const url = new URL(req.url ?? "/", "http://x");
          const instrument = String(url.searchParams.get("instrument") ?? "AU9999");
          const interval = Number(url.searchParams.get("interval") ?? 5);
          const limit = Math.min(1440, Math.max(1, Number(url.searchParams.get("limit") ?? 288)));
          if (instrument !== "AU9999" && instrument !== "XAU" && instrument !== "GCF" && instrument !== "CMB") {
            sendJson(res, 400, { ok: false, error: { code: "BAD_INSTRUMENT" } });
            return;
          }
          if (!BAR_INTERVALS.includes(interval)) {
            sendJson(res, 400, { ok: false, error: { code: "BAD_INTERVAL" } });
            return;
          }
          const rawBars = runtime.bars[instrument]?.[interval] ?? [];
          const filteredBars = interval === 1440 ? rawBars : filterBarsToTradingHours(rawBars, runtime.config);
          sendJson(res, 200, {
            ok: true,
            instrument,
            interval,
            bars: barsView(filteredBars, limit, interval),
          });
        },
      },
      {
        path: "/dsh-plugin-goldboard/manual-cmb-missing",
        handler: async (req, res) => {
          if (req.method !== "GET") {
            sendJson(res, 405, { ok: false, error: { code: "METHOD_NOT_ALLOWED" } });
            return;
          }
          const now = new Date();
          const result = listMissingCmbMinuteSlots(runtime, runtime.config, now);
          sendJson(res, 200, {
            ok: true,
            date: result.date,
            serverTime: now.toISOString(),
            slots: result.slots,
          });
        },
      },

      {
        path: "/dsh-plugin-goldboard/manual-cmb-bars",
        handler: async (req, res) => {
          if (req.method !== "POST") {
            sendJson(res, 405, { ok: false, error: { code: "METHOD_NOT_ALLOWED" } });
            return;
          }
          try {
            const body = JSON.parse((await readBody(req)).toString("utf8"));
            const input = body?.text ?? body?.entries ?? body?.prices ?? body?.minutes;
            const now = new Date();
            const parsed = parseManualCmbMinuteEntries(input, now);
            if (parsed.entries.length === 0) {
              sendJson(res, 400, {
                ok: false,
                error: {
                  code: "BAD_MANUAL_CMB_ENTRIES",
                  message: parsed.errors.join("; ") || "没有可用的分钟价格",
                },
              });
              return;
            }
            const result = applyManualCmbMinuteBars(runtime, parsed.entries, runtime.config, now);
            await persistState();
            runtime.plan = computePlan(runtime, runtime.config);
            refreshSnapshot(now);
            sendJson(res, 200, {
              ok: true,
              added: result.added,
              skipped: result.skipped,
              errors: parsed.errors,
              snapshot: runtime.lastSnapshot,
            });
          } catch (error) {
            sendJson(res, error?.code === "PAYLOAD_TOO_LARGE" ? 413 : 400, {
              ok: false,
              error: { code: error?.code ?? "BAD_MANUAL_CMB_BARS", message: String(error?.message ?? error) },
            });
          }
        },
      },

      {
        path: "/dsh-plugin-goldboard/replay",
        handler: async (req, res) => {
          if (req.method !== "POST") {
            sendJson(res, 405, { ok: false, error: { code: "METHOD_NOT_ALLOWED" } });
            return;
          }
          try {
            const body = JSON.parse((await readBody(req, 2 * 1024 * 1024)).toString("utf8"));
            sendJson(res, 200, replayMarketPlan(body, runtime.config));
          } catch (error) {
            sendJson(res, error?.code === "PAYLOAD_TOO_LARGE" ? 413 : 400, {
              ok: false,
              error: { code: error?.code ?? "BAD_REPLAY_INPUT" },
            });
          }
        },
      },
      {
        path: "/dsh-plugin-goldboard/data-sources",
        handler: async (req, res) => {
          if (req.method !== "GET") {
            sendJson(res, 405, { ok: false, error: { code: "METHOD_NOT_ALLOWED" } });
            return;
          }
          sendJson(res, 200, { ok: true, sources: dataSourceView(runtime) });
        },
      },
      {
        path: "/dsh-plugin-goldboard/api-logs",
        handler: async (req, res) => {
          if (req.method !== "GET") {
            sendJson(res, 405, { ok: false, error: { code: "METHOD_NOT_ALLOWED" } });
            return;
          }
          const url = new URL(req.url ?? "/", "http://x");
          const sourceId = String(url.searchParams.get("source") ?? "");
          sendJson(res, 200, { ok: true, sourceId, logs: getApiLogs(sourceId || undefined) });
        },
      },
      {
        path: "/dsh-plugin-goldboard/test-notify",
        handler: async (req, res) => {
          if (req.method !== "POST") {
            sendJson(res, 405, { ok: false, error: { code: "METHOD_NOT_ALLOWED" } });
            return;
          }
          const fail = (status, code, message) => {
            const error = new Error(message);
            error.statusCode = status;
            error.code = code;
            throw error;
          };
          try {
            const body = JSON.parse((await readBody(req)).toString("utf8"));
            const channel = String(body?.channel ?? "system");
            const draftConfig = body?.config !== null && typeof body?.config === "object" ? body.config : {};
            const zh = runtime.localeHint !== "en";
            const testMessage = buildAlertMessage(
              { action: "buy_setup", suggestedOrder: { instrument: "Au99.99", signalPrice: 950, cmbEstimatedPrice: 951.72, grams: 1 }, targetPrice: 958, grams: 1 },
              runtime.config,
              runtime.localeHint,
            );
            testMessage.title = zh ? "黄金看板 · 测试" : "Gold Board · Test";
            testMessage.body = zh
              ? "这是一条来自 DeepSeek Harness 黄金看板插件的测试消息。"
              : "This is a test message from the DeepSeek Harness Gold Board plugin.";
            testMessage.params.action = zh ? "测试消息" : "Test message";

            if (channel === "system") {
              const systemConfig = draftConfig.system !== null && typeof draftConfig.system === "object"
                ? { ...runtime.config.system, ...draftConfig.system }
                : typeof draftConfig.enabled === "boolean"
                  ? { ...runtime.config.system, enabled: draftConfig.enabled }
                  : runtime.config.system;
              if (!systemConfig.enabled) fail(400, "SYSTEM_DISABLED", "宿主机系统通知未启用");
              await systemNotify(testMessage.title, testMessage.body);
            } else if (channel === "feishu") {
              const testConfig = mergeTestConfig(runtime.config.webhooks.feishu, draftConfig);
              await sendFeishu(testConfig, renderWebhookTemplate(testConfig.bodyTemplate, testMessage));
            } else if (channel === "dingtalk") {
              const testConfig = mergeTestConfig(runtime.config.webhooks.dingtalk, draftConfig);
              await sendDingtalk(testConfig, renderWebhookTemplate(testConfig.bodyTemplate, testMessage));
            } else if (channel === "wecom") {
              const testConfig = mergeTestConfig(runtime.config.webhooks.wecom, draftConfig);
              await sendWecom(testConfig, renderWebhookTemplate(testConfig.bodyTemplate, testMessage));
            } else if (channel === "generic") {
              const generic = runtime.config.webhooks.generic.find((entry) => entry.id === String(body?.genericId ?? ""));
              if (!generic) fail(400, "GENERIC_NOT_FOUND", "通用 webhook 不存在");
              const testConfig = mergeTestConfig(generic, draftConfig);
              await sendGeneric(testConfig, renderWebhookTemplate(testConfig.bodyTemplate, testMessage));
            } else {
              fail(400, "BAD_CHANNEL", "未知通知渠道");
            }
            sendJson(res, 200, { ok: true, note: zh ? "测试消息已发送" : "Test message sent" });
          } catch (error) {
            const status = typeof error?.statusCode === "number" ? error.statusCode : 500;
            sendJson(res, status, {
              ok: false,
              error: { code: error?.code ?? "NOTIFY_FAILED", message: String(error?.message ?? error) },
            });
          }
        },
      },
    ];

    for (const route of routes) {
      ctx.effect(() => webServer.register({ kind: "exact", path: route.path, handler: route.handler }), `dsh-plugin-goldboard: route ${route.path}`);
    }
  }

  ctx.effect(() => {
    void init();
    const timer = setInterval(() => {
      void tick();
    }, num(config.pollMs, DEFAULT_POLL_MS, 10_000, 300_000));
    // Async final flush: cordis awaits async disposers during unload, so the
    // last bars/alert state is persisted before the process exits instead of
    // racing a fire-and-forget write.
    return async () => {
      clearInterval(timer);
      analysisModule.dispose();
      await persistState();
    };
  }, "dsh-plugin-goldboard: market loop");

  return runtime;
}
