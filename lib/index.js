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
import { appendFile, mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { homedir, platform } from "node:os";
import { join } from "node:path";

export const name = "dsh-plugin-goldboard";
export const inject = ["webServer"];

// ── constants ──────────────────────────────────────────────────────────────

const CONFIG_FILE = "config.json";
const STATE_FILE = "state.json";
const ALERTS_LOG_FILE = "alerts-log.json";
const API_LOG_FILE = "api-log.json";
const MAX_API_LOGS = 500;
const MAX_CONFIG_BYTES = 256 * 1024;
const MAX_BARS = 1440;
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
});

// ── config defaults / normalization ────────────────────────────────────────

export const DEFAULT_CONFIG = Object.freeze({
  fee: Object.freeze({ buyPerGram: 0, sellPerGram: 5 }),
  // 2026-08 实测：国际金价折算约 950.00 时招行积存金约 951.72，故默认价差校准为 +1.72。
  cmb: Object.freeze({ buySpreadPerGram: 1.72, sellSpreadPerGram: 1.72 }),
  position: Object.freeze({ grams: 0, avgCostPerGram: 0, lots: Object.freeze([]) }),
  limits: Object.freeze({ maxGrams: 0 }),
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
  const lots = cleanLots(source.lots);
  if (lots.length > 0) {
    const derived = positionFromLots(lots);
    return {
      grams: derived.grams,
      avgCostPerGram: derived.avgCostPerGram,
      lots,
    };
  }
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
  const strategy = typeof source.strategy === "object" && source.strategy !== null ? source.strategy : {};
  const tradingHours = typeof source.tradingHours === "object" && source.tradingHours !== null ? source.tradingHours : {};
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
  Object.freeze({ id: "yahoo-xau", nameZh: "Yahoo Finance COMEX 黄金", nameEn: "Yahoo Finance COMEX Gold", source: "yahoo", kind: "xau", instrument: "XAU", url: "https://query1.finance.yahoo.com/v8/finance/chart/GC=F" }),
  Object.freeze({ id: "yahoo-history-xau", nameZh: "Yahoo Finance 黄金日线历史", nameEn: "Yahoo Finance Gold Daily History", source: "yahoo", kind: "history", instrument: null, url: "https://query1.finance.yahoo.com/v8/finance/chart/GC=F?interval=1d&range=5y" }),
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

async function persistApiLog(entry) {
  if (!apiLogPath || !apiLogWriteQueue) return;
  try {
    await apiLogWriteQueue(async () => {
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

async function readApiLogs() {
  if (!apiLogPath) return [];
  try {
    const raw = await readFile(apiLogPath, "utf8");
    const out = [];
    for (const line of raw.split("\n")) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      try {
        out.push(JSON.parse(trimmed));
      } catch {
        // Skip malformed lines.
      }
    }
    return out.slice(-MAX_API_LOGS).reverse();
  } catch (error) {
    if (error?.code !== "ENOENT") {
      // Ignore read failures; logs are best-effort.
    }
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
    const quote = source.instrument ? runtime.quotes?.[source.instrument] : null;
    const current = quote && quote.source === source.source
      ? {
          price: quote.price,
          updatedAt: quote.updatedAt,
          stale: !Number.isFinite(quote.updatedAt) || now - quote.updatedAt > STALE_QUOTE_MS || !isDomesticQuoteFresh(quote, new Date(now)),
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

async function fetchWithTimeout(url, options = {}, timeoutMs = FETCH_TIMEOUT_MS) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(url, { ...options, signal: controller.signal });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    return response;
  } finally {
    clearTimeout(timer);
  }
}

async function fetchUtf8(url, options = {}, timeoutMs = FETCH_TIMEOUT_MS) {
  const response = await fetchWithTimeout(url, options, timeoutMs);
  return response.text();
}

async function fetchGb18030(url, options = {}, timeoutMs = QUOTE_TIMEOUT_MS) {
  const response = await fetchWithTimeout(url, options, timeoutMs);
  const bytes = await response.arrayBuffer();
  return new TextDecoder("gb18030").decode(bytes);
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
  return trackedCall({
    sourceId: "cmb-market-center",
    source: "cmb",
    kind: "cmb",
    url: CMB_API_URL,
  }, async () => {
    let lastError = null;
    // The upstream koishi plugin uses a form-encoded POST; also keep a GET
    // fallback in case the endpoint only accepts query parameters.
    try {
      const text = await fetchUtf8(CMB_API_URL, {
        method: "POST",
        headers: {
          "content-type": "application/x-www-form-urlencoded; charset=UTF-8",
          "user-agent": USER_AGENT,
          "referer": "https://mbmodule-openapi.paas.cmbchina.com/",
        },
        body: `params=${encodeURIComponent(CMB_API_PARAMS)}`,
      }, QUOTE_TIMEOUT_MS);
      const parsed = parseCmbMarketCenterQuote(JSON.parse(text));
      if (parsed) return { ...parsed, source: "cmb" };
      lastError = new Error("CMB market center response did not contain zBuyPrc/zSelPrc");
    } catch (error) {
      lastError = error;
    }
    try {
      const text = await fetchUtf8(CMB_API_URL, {
        method: "POST",
        headers: {
          "content-type": "application/json; charset=UTF-8",
          "user-agent": USER_AGENT,
          "referer": "https://mbmodule-openapi.paas.cmbchina.com/",
        },
        body: JSON.stringify({ params: CMB_API_PARAMS }),
      }, QUOTE_TIMEOUT_MS);
      const parsed = parseCmbMarketCenterQuote(JSON.parse(text));
      if (parsed) return { ...parsed, source: "cmb" };
      lastError = new Error("CMB market center response did not contain zBuyPrc/zSelPrc");
    } catch (error) {
      lastError = error;
    }
    try {
      const url = `${CMB_API_URL}?params=${encodeURIComponent(CMB_API_PARAMS)}`;
      const text = await fetchUtf8(url, {
        headers: { "user-agent": USER_AGENT, "referer": "https://mbmodule-openapi.paas.cmbchina.com/" },
      }, QUOTE_TIMEOUT_MS);
      const parsed = parseCmbMarketCenterQuote(JSON.parse(text));
      if (parsed) return { ...parsed, source: "cmb" };
      lastError = new Error("CMB market center response did not contain zBuyPrc/zSelPrc");
    } catch (error) {
      lastError = error;
    }
    throw lastError ?? new Error("CMB quote fetch failed");
  });
}

// ── additional free quote sources ──────────────────────────────────────────

export async function fetchSgeQuote() {
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
    }, QUOTE_TIMEOUT_MS);
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

async function fetchSixtySecondsRaw() {
  if (!sixtySecondsInflight) {
    sixtySecondsInflight = (async () => {
      const text = await fetchUtf8(SIXTY_SECONDS_URL, {
        headers: { "user-agent": USER_AGENT },
      }, QUOTE_TIMEOUT_MS);
      return parseSixtySecondsGoldPrice(JSON.parse(text));
    })().finally(() => {
      sixtySecondsInflight = null;
    });
  }
  return sixtySecondsInflight;
}

export async function fetchSixtySecondsQuote(sourceId = "sixty-domestic", kind = "domestic", instrument = "AU9999") {
  return trackedCall({
    sourceId,
    source: "60s",
    kind,
    instrument,
    url: SIXTY_SECONDS_URL,
  }, async () => {
    const parsed = await fetchSixtySecondsRaw();
    return parsed ? { ...parsed, source: "60s" } : null;
  });
}

export async function fetchGoldApiQuote() {
  return trackedCall({
    sourceId: "gold-api-xau",
    source: "gold-api",
    kind: "xau",
    instrument: "XAU",
    url: GOLD_API_URL,
  }, async () => {
    const text = await fetchUtf8(GOLD_API_URL, {
      headers: { "user-agent": USER_AGENT },
    }, QUOTE_TIMEOUT_MS);
    const parsed = parseGoldApiQuote(JSON.parse(text));
    return parsed ? { ...parsed, source: "gold-api" } : null;
  });
}

export async function fetchGoldPriceTodayQuote() {
  return trackedCall({
    sourceId: "goldprice-today-xau",
    source: "goldprice-today",
    kind: "xau",
    instrument: "XAU",
    url: GOLD_PRICE_TODAY_URL,
  }, async () => {
    const text = await fetchUtf8(GOLD_PRICE_TODAY_URL, {
      headers: { "user-agent": USER_AGENT },
    }, QUOTE_TIMEOUT_MS);
    const parsed = parseGoldPriceTodayQuote(JSON.parse(text));
    return parsed ? { ...parsed, source: "goldprice-today" } : null;
  });
}

export async function fetchYahooXauQuote() {
  return trackedCall({
    sourceId: "yahoo-xau",
    source: "yahoo",
    kind: "xau",
    instrument: "XAU",
    url: YAHOO_XAU_URL,
  }, async () => {
    const text = await fetchUtf8(YAHOO_XAU_URL, {
      headers: { "user-agent": USER_AGENT, "accept": "application/json" },
    }, QUOTE_TIMEOUT_MS);
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

export async function fetchDomesticQuote(now = new Date()) {
  try {
    const quote = await trackedCall({
      sourceId: "sina-domestic",
      source: "sina",
      kind: "domestic",
      url: "https://hq.sinajs.cn/list=gds_AU9999",
    }, async () => {
      const text = await fetchGb18030("https://hq.sinajs.cn/list=gds_AU9999", {
        headers: { Referer: "https://finance.sina.com.cn/", "User-Agent": USER_AGENT },
      });
      const parsed = parseSinaDomesticQuote(text);
      if (parsed && !isDomesticQuoteFresh(parsed, now)) {
        const error = new Error(`stale domestic quote: ${parsed.date} ${parsed.time}`);
        error.code = "STALE_QUOTE";
        throw error;
      }
      return parsed ? { ...parsed, source: "sina" } : null;
    });
    if (quote) return quote;
  } catch {
    // fall through
  }
  try {
    const quote = await fetchSgeQuote();
    if (quote && !isDomesticQuoteFresh(quote, now)) {
      const error = new Error(`stale SGE domestic quote: ${quote.time ?? quote.date ?? ""}`);
      error.code = "STALE_QUOTE";
      throw error;
    }
    if (quote) return quote;
  } catch {
    // fall through
  }
  try {
    const quote = await trackedCall({
      sourceId: "eastmoney-domestic",
      source: "eastmoney",
      kind: "domestic",
      url: "https://push2.eastmoney.com/api/qt/stock/get?secid=118.AU9999",
    }, async () => {
      const text = await fetchUtf8(
        "https://push2.eastmoney.com/api/qt/stock/get?secid=118.AU9999&fields=f43,f44,f45,f46,f60,f86,f170",
        { headers: { Referer: "https://quote.eastmoney.com/", "User-Agent": USER_AGENT } },
      );
      const parsed = parseEastmoneyDomesticQuote(JSON.parse(text));
      if (parsed && !isDomesticQuoteFresh(parsed, now)) {
        const error = new Error(`stale domestic quote: ${parsed.time}`);
        error.code = "STALE_QUOTE";
        throw error;
      }
      return parsed ? { ...parsed, source: "eastmoney" } : null;
    });
    if (quote) return quote;
  } catch {
    // fall through
  }
  try {
    const aggregate = await fetchSixtySecondsQuote("sixty-domestic", "domestic", "AU9999");
    const domestic = aggregate?.domestic;
    if (domestic && Number.isFinite(domestic.price) && domestic.price > 0) {
      return {
        ...domestic,
        source: "60s",
        time: aggregate.updatedAt || undefined,
      };
    }
  } catch {
    // fall through
  }
  return null;
}

async function fetchXauQuote() {
  try {
    const quote = await trackedCall({
      sourceId: "tencent-xau",
      source: "tencent",
      kind: "xau",
      url: "https://qt.gtimg.cn/q=hf_XAU",
    }, async () => {
      const text = await fetchGb18030("https://qt.gtimg.cn/q=hf_XAU", {
        headers: { "User-Agent": USER_AGENT },
      });
      const parsed = parseTencentXauQuote(text);
      return parsed ? { ...parsed, source: "tencent" } : null;
    });
    if (quote) return quote;
  } catch {
    // fall through
  }
  try {
    const quote = await trackedCall({
      sourceId: "sina-xau",
      source: "sina",
      kind: "xau",
      url: "https://hq.sinajs.cn/list=hf_XAU",
    }, async () => {
      const text = await fetchGb18030("https://hq.sinajs.cn/list=hf_XAU", {
        headers: { Referer: "https://finance.sina.com.cn/", "User-Agent": USER_AGENT },
      });
      const parsed = parseTencentXauQuote(text);
      return parsed ? { ...parsed, source: "sina" } : null;
    });
    if (quote) return quote;
  } catch {
    // fall through
  }
  try {
    const quote = await fetchGoldApiQuote();
    if (quote) return quote;
  } catch {
    // fall through
  }
  try {
    const aggregate = await fetchSixtySecondsQuote("sixty-xau", "xau", "XAU");
    const xau = aggregate?.xau;
    if (xau && Number.isFinite(xau.price) && xau.price > 0) {
      return {
        ...xau,
        source: "60s",
        time: aggregate.updatedAt || undefined,
      };
    }
  } catch {
    // fall through
  }
  try {
    const quote = await fetchGoldPriceTodayQuote();
    if (quote) return quote;
  } catch {
    // fall through
  }
  try {
    const quote = await fetchYahooXauQuote();
    if (quote) return quote;
  } catch {
    // fall through
  }
  return null;
}

async function fetchUsdcnyQuote() {
  try {
    const quote = await trackedCall({
      sourceId: "tencent-usdcny",
      source: "tencent",
      kind: "usdcny",
      url: "https://qt.gtimg.cn/q=whUSDCNY",
    }, async () => {
      const text = await fetchGb18030("https://qt.gtimg.cn/q=whUSDCNY", {
        headers: { "User-Agent": USER_AGENT },
      });
      const parsed = parseTencentForexQuote(text);
      return parsed ? { ...parsed, source: "tencent" } : null;
    });
    if (quote) return quote;
  } catch {
    // fall through
  }
  return null;
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
    upsertBar(list, { t, o: quote.price, h: quote.price, l: quote.price, c: quote.price });
  }
}

function ensureBars(bars) {
  const out = {};
  for (const interval of BAR_INTERVALS) out[interval] = bars[interval] ?? [];
  return out;
}

function seedBars(bars, klines) {
  mergeKlines(bars[5], klines, 5);
  mergeKlines(bars[60], klines, 60);
}

function mergeKlines(list, klines, intervalMinutes) {
  const byTime = new Map();
  for (const bar of list) byTime.set(bar.t, { ...bar });
  for (const bar of klines) {
    const t = alignStart(bar.t, intervalMinutes);
    const existing = byTime.get(t);
    if (existing) {
      existing.h = Math.max(existing.h, bar.h);
      existing.l = Math.min(existing.l, bar.l);
      existing.c = bar.c;
    } else {
      byTime.set(t, { t, o: bar.o, h: bar.h, l: bar.l, c: bar.c });
    }
  }
  const merged = Array.from(byTime.values()).sort((a, b) => a.t - b.t);
  list.length = 0;
  list.push(...merged.slice(-MAX_BARS));
}

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


// ── data coverage & multi-timeframe resampling (5/10/30/60) ────────────────

const PLAN_WINDOWS = Object.freeze([5, 10, 30, 60]);
const MIN_WINDOW_COVERAGE = 0.8;
// 开盘后 1 小时内 30/60 分钟窗口天然不足，只校验 5/10 分钟窗口；数据参考仍尽量覆盖 5/10/30/60。
// 每天北京时间 00:00-01:00 也处于较长周期窗口天然不足的阶段，同样只校验 5/10 分钟窗口。
const SESSION_WARMUP_MS = 60 * 60_000;
const MIDNIGHT_WINDOW_END_MINUTES = 60;

/**
 * Per-minute coverage of a 1-minute bar list over the last `minutes` minutes
 * ending at `now`. Each minute is expected to carry one price point (the host
 * polls ~30s so a 1m bar is recorded per minute); a point counts as valid when
 * a 1-minute bar with a finite, positive close exists for that minute.
 * Returns a ratio in [0, 1].
 */
export function windowCoverage(bars1m, now, minutes) {
  if (!Array.isArray(bars1m) || !(minutes > 0)) return 0;
  const end = alignStart(now, 1);
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
 * must have more than MIN_WINDOW_COVERAGE valid per-minute data, otherwise no
 * suggestion may be emitted (the board should tell the user data is missing
 * instead). Coverage for all PLAN_WINDOWS is still reported for display.
 */
export function coverageGate(bars1m, now, windows = PLAN_WINDOWS) {
  const coverage = {};
  const failing = [];
  for (const minutes of PLAN_WINDOWS) {
    const ratio = windowCoverage(bars1m, now, minutes);
    coverage[minutes] = round2(ratio);
    if (windows.includes(minutes) && !(ratio > MIN_WINDOW_COVERAGE)) failing.push(minutes);
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
  for (let index = 0; index < bars5.length; index += factor) {
    const chunk = bars5.slice(index, index + factor).filter((bar) => bar && Number.isFinite(bar.t));
    if (chunk.length === 0) continue;
    const first = chunk[0];
    const last = chunk[chunk.length - 1];
    out.push({
      t: alignStart(last.t, intervalMinutes),
      o: first.o,
      h: Math.max(...chunk.map((bar) => bar.h)),
      l: Math.min(...chunk.map((bar) => bar.l)),
      c: last.c,
    });
  }
  return out;
}


// ── indicators (exported for tests) ────────────────────────────────────────

function mean(values) {
  if (values.length === 0) return NaN;
  return values.reduce((acc, value) => acc + value, 0) / values.length;
}

export function sma(values, period, end = values.length - 1) {
  if (end < 0 || period <= 0) return NaN;
  const start = Math.max(0, end - period + 1);
  const slice = values.slice(start, end + 1);
  return mean(slice);
}

export function emaSeries(values, period) {
  if (period <= 0 || values.length === 0) return [];
  const k = 2 / (period + 1);
  const out = [];
  let prev = values[0];
  out.push(prev);
  for (let i = 1; i < values.length; i += 1) {
    prev = values[i] * k + prev * (1 - k);
    out.push(prev);
  }
  return out;
}

export function rsi(values, period = 14) {
  if (values.length < period + 1) return NaN;
  let gain = 0;
  let loss = 0;
  for (let i = values.length - period; i < values.length; i += 1) {
    const diff = values[i] - values[i - 1];
    if (diff >= 0) gain += diff;
    else loss -= diff;
  }
  if (gain + loss === 0) return 50;
  return 100 * gain / (gain + loss);
}

export function bollinger(values, period = 20, mult = 2, end = values.length - 1) {
  const mid = sma(values, period, end);
  if (!Number.isFinite(mid) || end < period - 1) return { mid: NaN, upper: NaN, lower: NaN };
  const start = end - period + 1;
  let variance = 0;
  for (let i = start; i <= end; i += 1) variance += (values[i] - mid) ** 2;
  const sd = Math.sqrt(variance / period);
  return { mid, upper: mid + mult * sd, lower: mid - mult * sd };
}

export function atr(bars, period = 14) {
  if (!Array.isArray(bars) || bars.length < 2) return NaN;
  const values = [];
  for (let i = 1; i < bars.length; i += 1) {
    const prev = bars[i - 1];
    const bar = bars[i];
    values.push(Math.max(bar.h - bar.l, Math.abs(bar.h - prev.c), Math.abs(bar.l - prev.c)));
  }
  const slice = values.slice(-period);
  return mean(slice);
}

export function macd(values, fast = 12, slow = 26, signal = 9) {
  const emaFast = emaSeries(values, fast);
  const emaSlow = emaSeries(values, slow);
  const dif = values.map((_, i) => emaFast[i] - emaSlow[i]);
  const dea = emaSeries(dif, signal);
  const index = values.length - 1;
  return {
    dif: dif[index] ?? NaN,
    dea: dea[index] ?? NaN,
    histogram: (dif[index] ?? NaN) - (dea[index] ?? NaN),
  };
}

export function computeIndicatorSet(bars) {
  const closes = bars.map((bar) => bar.c);
  const ema20 = emaSeries(closes, 20);
  return {
    count: closes.length,
    sma5: sma(closes, 5),
    sma20: sma(closes, 20),
    sma60: sma(closes, 60),
    ema20: ema20[ema20.length - 1],
    ema20Prev: ema20.length >= 2 ? ema20[ema20.length - 2] : NaN,
    rsi14: rsi(closes, 14),
    boll: bollinger(closes, 20, 2),
    atr14: atr(bars, 14),
    macd: macd(closes),
    recentHigh: bars.length ? Math.max(...bars.slice(-20).map((bar) => bar.h)) : NaN,
    recentLow: bars.length ? Math.min(...bars.slice(-20).map((bar) => bar.l)) : NaN,
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

function isTradingDate(config, date, day) {
  if (config.tradingHours.holidays.includes(date)) return false;
  if (!config.tradingHours.weekdaysOnly) return true;
  return day >= 1 && day <= 5;
}

export function computeMarketState(config, now = new Date()) {
  const cfg = normalizeConfig(config);
  const openMin = parseTime(cfg.tradingHours.open, 9 * 60);
  const closeMin = parseTime(cfg.tradingHours.close, 26 * 60);
  const today = beijingParts(now);
  const yesterdayDate = dateStringForOffset(today.date, -1);
  const yesterdayDay = (today.day + 6) % 7;
  const yesterdayTradeable = isTradingDate(cfg, yesterdayDate, yesterdayDay);
  const todayTradeable = isTradingDate(cfg, today.date, today.day);

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
  const openMin = parseTime(cfg.tradingHours.open, 9 * 60);
  const closeMin = parseTime(cfg.tradingHours.close, 26 * 60);
  if (openMin >= closeMin) return null;

  const today = beijingParts(now);
  const nowMs = now.getTime();
  for (let offset = 0; offset <= 370; offset += 1) {
    const date = dateStringForOffset(today.date, offset);
    const day = (today.day + offset) % 7;
    if (!isTradingDate(cfg, date, day)) continue;
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
  const xauPrice = Number(xau.price);
  const usd = Number(usdcny.price);
  if (!(xauPrice > 0) || !(usd > 0)) return null;
  return round2(xauPrice * usd / 31.1034768);
}

function hasCmbFallback(xau, usdcny) {
  const value = xauCnyPerGram(xau, usdcny);
  return value !== null && value > 0;
}

function convertXauBarsToCny(bars, usdcny) {
  if (!Array.isArray(bars) || !usdcny) return [];
  const usd = Number(usdcny.price);
  if (!(usd > 0)) return [];
  const factor = usd / 31.1034768;
  return bars.map((bar) => ({
    t: bar.t,
    o: round2(bar.o * factor),
    h: round2(bar.h * factor),
    l: round2(bar.l * factor),
    c: round2(bar.c * factor),
  }));
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
  };
}

function planSide(action) {
  if (action === "buy_setup" || action === "add_position") return "buy";
  if (["sell_take_profit", "sell_trailing", "sell_stop", "sell_weakness", "reduce_position", "close_by_session_end"].includes(action)) return "sell";
  return null;
}

function applySignalPolicy(plan, signalState, cfg, now) {
  const next = { ...signalState };
  // 用户更新持仓后，重置同方向冷却与确认计数，避免旧信号继续“追杀”新仓位。
  if (signalState.lastPositionGrams !== cfg.position.grams) {
    next.lastAction = null;
    next.lastSide = null;
    next.lastAt = null;
    next.lastPositionGrams = cfg.position.grams;
    next.buyStreak = 0;
    next.sellStreak = 0;
  }
  const side = planSide(plan.action);
  if (!side) {
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
  const currentStreak = (next[streakKey] || 0) + 1;
  next[streakKey] = currentStreak;
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
  const xauCny = xauCnyPerGram(xau, usdcny);
  const hasXauFallback = hasCmbFallback(xau, usdcny);
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
    return base;
  }

  const price = liveCmb ? round2(Number(cmbQuote.buyPrice)) : (useXauSignal ? xauCny : domestic.price);
  const rawBars5 = (liveCmb ? runtime.bars?.CMB?.[5] : useXauSignal ? runtime.bars?.XAU?.[5] : runtime.bars?.AU9999?.[5]) ?? [];
  const rawBars60 = (liveCmb ? runtime.bars?.CMB?.[60] : useXauSignal ? runtime.bars?.XAU?.[60] : runtime.bars?.AU9999?.[60]) ?? [];
  const bars5 = liveCmb ? rawBars5 : (useXauSignal ? convertXauBarsToCny(rawBars5, usdcny) : rawBars5);
  const bars60 = liveCmb ? rawBars60 : (useXauSignal ? convertXauBarsToCny(rawBars60, usdcny) : rawBars60);
  // 10m/30m bars are resampled from the stored 5m bars (which are seeded from
  // kline history), so the longer timeframes stay warm from cold start.
  const bars10 = resampleBars(bars5, 2);
  const bars30 = resampleBars(bars5, 6);
  const ind5 = computeIndicatorSet(bars5);
  const ind10 = computeIndicatorSet(bars10);
  const ind30 = computeIndicatorSet(bars30);
  const ind60 = computeIndicatorSet(bars60);
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
  const pos = cfg.position;
  const strategy = cfg.strategy;

  base.signalPrice = round2(price);
  base.cmbEstimatedPrice = cmbSell;
  base.cmbLive = liveCmb;
  base.indicators = { ind5, ind10, ind30, ind60, xauCnyPerGram: xauCny ?? undefined };
  if (xauCny !== null) base.xauCnyPerGram = xauCny;

  if (market.state !== "open") {
    base.action = "market_closed";
    base.reasonCodes.push("market_closed");
    return base;
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
    return base;
  }

  // Data-quality gate: a suggestion is only produced when the active windows
  // have >80% valid per-minute data on the signal instrument's own bars;
  // otherwise tell the user data is missing and stay silent. In the first
  // hour after the session opens, and during the daily 00:00-01:00 Beijing
  // window, only 5/10-minute windows are checked (the 30/60-minute windows are
  // naturally thin during those periods); the data referenced by the plan still
  // covers 5/10/30/60 as far as possible.
  const gateBars1m = (liveCmb ? runtime.bars?.CMB?.[1] : useXauSignal ? runtime.bars?.XAU?.[1] : runtime.bars?.AU9999?.[1]) ?? [];
  const minutesSinceOpen = market.sessionStart ? (now.getTime() - Date.parse(market.sessionStart)) / 60_000 : Infinity;
  const inSessionWarmup = Number.isFinite(minutesSinceOpen) && minutesSinceOpen * 60_000 < SESSION_WARMUP_MS;
  const inMidnightWindow = beijingParts(now).minutes < MIDNIGHT_WINDOW_END_MINUTES;
  const gateWindows = (inSessionWarmup || inMidnightWindow) ? [5, 10] : PLAN_WINDOWS;
  const gate = coverageGate(gateBars1m, now, gateWindows);
  base.dataCoverage = gate.coverage;
  if (!gate.ok) {
    base.action = "data_incomplete";
    base.reasonCodes = gate.failing.map((minutes) => `data_incomplete_${minutes}m`);
    return base;
  }

  // Multi-timeframe trend: EMA20 must be rising on 10/30/60-minute bars
  // (10m/30m are resampled from the 5m bars) instead of 60m alone, so the
  // suggestion references 5/10/30/60-minute data as a whole.
  const emaRising = (ind) => Number.isFinite(ind.ema20) && Number.isFinite(ind.ema20Prev) && ind.ema20 > ind.ema20Prev;
  const trendUp = emaRising(ind60) && emaRising(ind30) && emaRising(ind10);
  const nearSupport = Number.isFinite(ind5.recentLow)
    ? (price - ind5.recentLow) / price * 100 <= strategy.nearSupportPct
    : false;
  const nearLowerBand = Number.isFinite(ind5.boll.lower)
    ? price <= ind5.boll.lower * (1 + strategy.nearSupportPct / 100)
    : false;
  const rsiRecovering = Number.isFinite(ind5.rsi14) && ind5.rsi14 > strategy.rsiOversold && ind5.rsi14 < 50;
  const aboveSma20 = Number.isFinite(ind5.sma20) && price > ind5.sma20;
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

    const resistance = Number.isFinite(ind5.recentHigh) ? ind5.recentHigh + spreadCmb.sellSpreadPerGram : undefined;
    const atrValue = Number.isFinite(ind5.atr14) ? ind5.atr14 : strategy.minProfitPerGram;
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
          const atrValueAdd = Number.isFinite(ind5.atr14) ? ind5.atr14 : 1;
          const suggestedSignalPrice = round2(Math.min(price + 0.1, (ind5.recentLow ?? price) + atrValueAdd * strategy.atrFactor));
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
    const atrValue = Number.isFinite(ind5.atr14) ? ind5.atr14 : 1;
    const suggestedSignalPrice = round2(Math.min(price + 0.1, (ind5.recentLow ?? price) + atrValue * strategy.atrFactor));
    const suggestedCmbPrice = round2(suggestedSignalPrice + spreadCmb.buySpreadPerGram);
    const entryCost = round2(suggestedCmbPrice + breakevenBuyFee);
    const breakeven = round2(entryCost + breakevenSellFee + estSpread + slippage);
    const grams = suggestedGrams(cfg, suggestedCmbPrice);
    const targetPrice = Math.max(
      breakeven + strategy.minProfitPerGram,
      Number.isFinite(ind5.recentHigh)
        ? ind5.recentHigh - atrValue * strategy.atrFactor + spreadCmb.sellSpreadPerGram
        : breakeven + atrValue,
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
    stale,
    ...(quote.error === true ? { error: true } : {}),
  };
}

function barsView(bars, limit = 288) {
  if (!Array.isArray(bars)) return [];
  return bars.slice(-limit).map((bar) => ({
    t: new Date(bar.t).toISOString(),
    o: round2(bar.o),
    h: round2(bar.h),
    l: round2(bar.l),
    c: round2(bar.c),
  }));
}

export function buildSnapshot(runtime, config, now = new Date()) {
  const cfg = normalizeConfig(config);
  const domestic = runtime.quotes?.AU9999;
  const xau = runtime.quotes?.XAU;
  const usdcny = runtime.quotes?.USDCNY;
  const basePlan = runtime.plan ?? computePlan(runtime, cfg, now);
  const xauCny = xauCnyPerGram(xau, usdcny);
  const hasXauFallback = hasCmbFallback(xau, usdcny);
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
    derived.domesticPremiumPct = round2(derived.domesticPremiumPerGram / xauCny);
  }
  if (liveCmb || hasXauFallback || hasDomestic) {
    const cmbBase = xauCny ?? (hasDomestic ? domestic.price : undefined);
    const cmbBuy = liveCmb ? round2(Number(cmbQuote.buyPrice)) : round2(cmbBase + cfg.cmb.buySpreadPerGram);
    const cmbSell = liveCmb ? round2(Number(cmbQuote.sellPrice)) : round2(cmbBase + cfg.cmb.sellSpreadPerGram);
    const cmbSellAfterFee = liveCmb ? cmbSell : round2(cmbSell - cfg.fee.sellPerGram);
    derived.cmb = {
      buyPrice: cmbBuy,
      sellPrice: cmbSell,
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
  const auQuote = auView && Number(auView.price) > 0
    ? auView
    : { price: 0, source: "error", updatedAt: 0, stale: true, error: true };
  return {
    ok: true,
    serverTime: now.toISOString(),
    marketState: plan.marketState ?? market.state,
    market: {
      state: plan.marketState ?? market.state,
      sessionStart: plan.sessionStart ?? market.sessionStart,
      msToClose: plan.msToClose ?? market.msToClose,
      nextOpen: market.nextOpen,
    },
    quotes: {
      AU9999: auQuote,
      XAU: quoteView(xau, now),
      USDCNY: quoteView(usdcny, now),
      CMB: quoteView(runtime.quotes?.CMB, now),
    },
    derived,
    trend: {
      AU9999_1m: barsView(runtime.bars?.AU9999?.[1], 1440),
      XAU_1m: barsView(runtime.bars?.XAU?.[1], 1440),
      CMB_1m: barsView(runtime.bars?.CMB?.[1], 1440),
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
      reasonCodes: plan.reasonCodes ?? [],
      dataCoverage: plan.dataCoverage,
      confidenceScore: plan.confidenceScore,
      confidenceMax: plan.confidenceMax,
      signalState: plan.signalState,
      breakeven: plan.breakeven,
      targetPrice: plan.targetPrice,
      stopPrice: plan.stopPrice,
      suggestedOrder: plan.suggestedOrder,
    },
  };
}

// ── alert engine ───────────────────────────────────────────────────────────

function templateReplace(text, params) {
  return String(text).replace(/\{\{(\w+)\}\}/g, (_, key) => params[key] ?? "");
}

export function buildAlertMessage(plan, config, localeHint = "zh") {
  const action = plan?.action ?? "no_data";
  const order = plan?.suggestedOrder;
  const zh = localeHint !== "en";
  const label = zh ? ACTION_LABELS_ZH[action] ?? action : ACTION_LABELS_EN[action] ?? action;
  const cfg = normalizeConfig(config);
  const signalPrice = order?.signalPrice ?? plan?.signalPrice;
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
  let cmbPrice = rawCmbPrice ?? "";
  if (Number.isFinite(Number(rawCmbPrice)) && Number(rawCmbPrice) > 0) {
    if (sellActions.has(action)) {
      const sellAfterFee = round2(Number(rawCmbPrice) - sellFee);
      if (Number.isFinite(sellAfterFee)) cmbPrice = sellAfterFee;
    } else {
      cmbPrice = rawCmbPrice;
    }
  } else if (Number.isFinite(Number(plan?.xauCnyPerGram)) && Number(plan.xauCnyPerGram) > 0) {
    // Fallback to the international-converted price + configured spread when
    // the plan did not carry a live CMB price.
    const fallbackBase = Number(plan.xauCnyPerGram);
    if (sellActions.has(action)) {
      const sellAfterFee = round2(fallbackBase + cfg.cmb.sellSpreadPerGram - sellFee);
      if (Number.isFinite(sellAfterFee)) cmbPrice = sellAfterFee;
    } else {
      const buyEstimate = round2(fallbackBase + cfg.cmb.buySpreadPerGram);
      if (Number.isFinite(buyEstimate)) cmbPrice = buyEstimate;
    }
  }
  const instrument = order?.instrument ?? plan?.instrument ?? "XAU";
  const isSell = sellActions.has(action);
  const isBuy = !isSell && (order?.side === "buy" || action === "buy_setup" || action === "add_position");
  const sideZh = isSell ? "卖出" : isBuy ? "买入" : "";
  const sideEn = isSell ? "sell" : isBuy ? "buy" : "";
  const instrumentZh = instrument === "CMB" ? "招行积存金" : instrument;
  const instrumentEn = instrument === "CMB" ? "CMB 积存金" : instrument;
  const params = {
    action: label,
    instrument,
    price: signalPrice ?? "",
    cmbPrice,
    target: plan?.targetPrice ?? "",
    grams: order?.grams ?? plan?.grams ?? "",
    time: new Date().toISOString(),
  };
  const title = zh ? `黄金看板 · ${label}` : `Gold Board · ${label}`;
  const zhOrderParts = [];
  if (sideZh && params.grams) zhOrderParts.push(`建议${sideZh} ${params.grams}克`);
  else if (sideZh) zhOrderParts.push(`建议${sideZh}`);
  else if (params.grams) zhOrderParts.push(`${params.grams}克`);
  if (params.target) zhOrderParts.push(`${sideZh ? sideZh + "目标价" : "目标价"} ${params.target} 元/克`);
  const enOrderParts = [];
  if (sideEn && params.grams) enOrderParts.push(`Suggested ${sideEn} ${params.grams}g`);
  else if (sideEn) enOrderParts.push(`Suggested ${sideEn}`);
  else if (params.grams) enOrderParts.push(`${params.grams}g`);
  if (params.target) enOrderParts.push(`${sideEn ? sideEn + " target" : "target"} ${params.target} CNY/g`);
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

export function apply(ctx, config = {}) {
  const logger = ctx.logger;
  const webServer = ctx.webServer;
  const writeQueue = makeWriteQueue();
  const stateDir = typeof config.directory === "string" && config.directory !== "" ? config.directory : pluginDir();

  const runtime = {
    config: normalizeConfig(config),
    quotes: { AU9999: null, XAU: null, USDCNY: null, CMB: null },
    bars: { AU9999: ensureBars({}), XAU: ensureBars({}), CMB: ensureBars({}) },
    plan: null,
    alertState: {},
    signalState: defaultSignalState(),
    localeHint: "zh",
    lastAlertLog: [],
    lastSnapshot: null,
    ready: false,
    lastBackfillAt: 0,
    ticking: false,
  };

  const configPath = join(stateDir, CONFIG_FILE);
  const statePath = join(stateDir, STATE_FILE);
  const alertsPath = join(stateDir, ALERTS_LOG_FILE);
  setApiLogSink(join(stateDir, API_LOG_FILE), writeQueue);

  function recordQuote(key, quote) {
    if (!quote || !(quote.price > 0)) return;
    // Never let a stale domestic quote masquerade as a fresh tick; doing so
    // would create fake flat bars in the today trend after the source stops
    // updating (e.g. Au99.99 stuck at 952.4 after 16:00).
    if (key === "AU9999" && !isDomesticQuoteFresh(quote, new Date())) return;
    quote.updatedAt = Date.now();
    runtime.quotes[key] = quote;
    recordTick(runtime.bars[key], quote, quote.updatedAt);
  }

  function persistState() {
    return writeJsonAtomic(statePath, {
      quotes: runtime.quotes,
      bars: runtime.bars,
      alertState: runtime.alertState,
      signalState: runtime.signalState,
      localeHint: runtime.localeHint,
      lastAlertLog: runtime.lastAlertLog,
    }, writeQueue).catch((error) => logger?.warn?.(`dsh-plugin-goldboard: persist state failed: ${String(error?.message ?? error)}`));
  }

  function persistConfig() {
    return writeJsonAtomic(configPath, runtime.config, writeQueue).catch((error) => logger?.warn?.(`dsh-plugin-goldboard: persist config failed: ${String(error?.message ?? error)}`));
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
    const message = buildAlertMessage(plan, runtime.config, runtime.localeHint);
    const results = await Promise.allSettled([dispatchAlert(runtime.config, message, logger)]);
    await logAlert(message, results);
  }

  function setQuoteError(key) {
    runtime.quotes[key] = {
      price: 0,
      source: "error",
      updatedAt: 0,
      stale: true,
      error: true,
    };
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
    if (xau.status === "fulfilled") recordQuote("XAU", xau.value);
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
        const klines = await fetchEastmoneyBars("118.AU9999", 5, 288);
        if (klines.length > 0) seedBars(runtime.bars.AU9999, klines);
      } catch (error) {
        logger?.warn?.(`dsh-plugin-goldboard: seed AU9999 klines failed: ${String(error?.message ?? error)}`);
      }
    }
    if (runtime.bars.AU9999[60].length < 20) {
      try {
        const klines = await fetchEastmoneyBars("118.AU9999", 60, 240);
        if (klines.length > 0) mergeKlines(runtime.bars.AU9999[60], klines, 60);
      } catch (error) {
        logger?.warn?.(`dsh-plugin-goldboard: seed AU9999 60m failed: ${String(error?.message ?? error)}`);
      }
    }

    // XAU intraday is also useful from cold start; Eastmoney provides a stable
    // free source for the same kline shape as Au99.99.
    const xau5 = runtime.bars.XAU[5];
    if (xau5.length < 60) {
      try {
        const klines = await fetchEastmoneyBars("122.XAU", 5, 288);
        if (klines.length > 0) seedBars(runtime.bars.XAU, klines);
      } catch (error) {
        logger?.warn?.(`dsh-plugin-goldboard: seed XAU klines failed: ${String(error?.message ?? error)}`);
      }
    }
    if (runtime.bars.XAU[60].length < 20) {
      try {
        const klines = await fetchEastmoneyBars("122.XAU", 60, 240);
        if (klines.length > 0) mergeKlines(runtime.bars.XAU[60], klines, 60);
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
        if (klines.length > 0) mergeKlines(runtime.bars.AU9999[1440], klines, 1440);
      } catch (error) {
        logger?.warn?.(`dsh-plugin-goldboard: seed AU9999 daily failed: ${String(error?.message ?? error)}`);
      }
      if ((runtime.bars.AU9999[1440]?.length ?? 0) < 20) {
        try {
          const daily = await fetchSgeDailyBars();
          if (daily.length > 0) mergeKlines(runtime.bars.AU9999[1440], daily, 1440);
        } catch (sgeError) {
          logger?.warn?.(`dsh-plugin-goldboard: seed AU9999 SGE daily failed: ${String(sgeError?.message ?? sgeError)}`);
        }
      }
    }
    const xauDaily = runtime.bars.XAU[1440] ?? (runtime.bars.XAU[1440] = []);
    if (xauDaily.length < 20) {
      try {
        const klines = await fetchEastmoneyBars("122.XAU", 101, 500);
        if (klines.length > 0) mergeKlines(runtime.bars.XAU[1440], klines, 1440);
      } catch (error) {
        logger?.warn?.(`dsh-plugin-goldboard: seed XAU daily failed: ${String(error?.message ?? error)}`);
      }
      if ((runtime.bars.XAU[1440]?.length ?? 0) < 20) {
        try {
          const daily = await fetchYahooXauDailyBars();
          if (daily.length > 0) mergeKlines(runtime.bars.XAU[1440], daily, 1440);
        } catch (yahooError) {
          logger?.warn?.(`dsh-plugin-goldboard: seed XAU Yahoo daily failed: ${String(yahooError?.message ?? yahooError)}`);
        }
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
    for (const interval of [1, 5]) {
      const xauBars = runtime.bars.XAU[interval];
      const cmbBars = runtime.bars.CMB[interval];
      if (!Array.isArray(xauBars) || xauBars.length === 0 || !Array.isArray(cmbBars)) continue;
      const byTime = new Map(cmbBars.map((bar) => [bar.t, bar]));
      let changed = false;
      for (const bar of xauBars) {
        if (!bar) continue;
        if (beijingDateForNow(new Date(bar.t)) !== today) continue;
        if (byTime.has(bar.t)) continue;
        byTime.set(bar.t, {
          t: bar.t,
          o: round2(bar.o * factor + spread),
          h: round2(bar.h * factor + spread),
          l: round2(bar.l * factor + spread),
          c: round2(bar.c * factor + spread),
        });
        changed = true;
      }
      if (!changed) continue;
      const merged = Array.from(byTime.values()).sort((a, b) => a.t - b.t);
      cmbBars.length = 0;
      cmbBars.push(...merged.slice(-MAX_BARS));
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
        const klines = await fetchEastmoneyBars("118.AU9999", 5, 288);
        if (klines.length > 0) mergeKlines(runtime.bars.AU9999[5], klines, 5);
      } catch (error) {
        logger?.warn?.(`dsh-plugin-goldboard: backfill AU9999 5m failed: ${String(error?.message ?? error)}`);
      }
    }
    if (xauMissing) {
      try {
        const klines = await fetchEastmoneyBars("122.XAU", 5, 288);
        if (klines.length > 0) mergeKlines(runtime.bars.XAU[5], klines, 5);
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
      runtime.lastSnapshot = buildSnapshot(runtime, runtime.config);
      await evaluateAlerts();
      await persistState();
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
      try {
        const savedState = await readJson(statePath, null);
        if (savedState && typeof savedState === "object") {
          if (savedState.bars) {
            runtime.bars = {
              AU9999: ensureBars(savedState.bars.AU9999),
              XAU: ensureBars(savedState.bars.XAU),
              CMB: ensureBars(savedState.bars.CMB),
            };
          }
          runtime.alertState = typeof savedState.alertState === "object" && savedState.alertState !== null ? savedState.alertState : {};
          if (savedState.signalState && typeof savedState.signalState === "object" && savedState.signalState !== null) {
            runtime.signalState = { ...defaultSignalState(), ...savedState.signalState };
          }
          if (typeof savedState.localeHint === "string") runtime.localeHint = savedState.localeHint;
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
              runtime.config = normalizeConfig({ ...runtime.config, ...merged });
              await persistConfig();
              runtime.plan = computePlan(runtime, runtime.config);
              if (runtime.plan.signalState) runtime.signalState = runtime.plan.signalState;
              runtime.lastSnapshot = buildSnapshot(runtime, runtime.config);
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
        path: "/dsh-plugin-goldboard/snapshot",
        handler: async (req, res) => {
          if (req.method !== "GET") {
            sendJson(res, 405, { ok: false, error: { code: "METHOD_NOT_ALLOWED" } });
            return;
          }
          const localeHint = String(req.headers["x-dsh-locale"] ?? "").toLowerCase() === "en" ? "en" : "zh";
          if (localeHint !== runtime.localeHint) {
            runtime.localeHint = localeHint;
            void persistState();
          }
          if (!runtime.lastSnapshot || runtime.ready) {
            runtime.plan = computePlan(runtime, runtime.config);
            runtime.lastSnapshot = buildSnapshot(runtime, runtime.config);
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
          if (instrument !== "AU9999" && instrument !== "XAU" && instrument !== "CMB") {
            sendJson(res, 400, { ok: false, error: { code: "BAD_INSTRUMENT" } });
            return;
          }
          if (!BAR_INTERVALS.includes(interval)) {
            sendJson(res, 400, { ok: false, error: { code: "BAD_INTERVAL" } });
            return;
          }
          sendJson(res, 200, {
            ok: true,
            instrument,
            interval,
            bars: barsView(runtime.bars[instrument]?.[interval], limit),
          });
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
    return () => {
      clearInterval(timer);
      void persistState();
    };
  }, "dsh-plugin-goldboard: market loop");

  return runtime;
}
