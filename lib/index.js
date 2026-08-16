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
 *     execution: Au99.99 signals + a configurable fixed CMB spread,
 *     buy fee 0 / sell fee 5 CNY per gram;
 *   - edge-triggered alerts (no cooldown, no quiet hours) delivered through
 *     host system notifications and webhooks;
 *   - JSON routes consumed by the browser half.
 *
 * This plugin never places orders. Every suggestion is advisory only.
 */

import { createHmac } from "node:crypto";
import { execFile } from "node:child_process";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { homedir, platform } from "node:os";
import { join } from "node:path";

export const name = "dsh-plugin-goldboard";
export const inject = ["webServer"];

// ── constants ──────────────────────────────────────────────────────────────

const CONFIG_FILE = "config.json";
const STATE_FILE = "state.json";
const ALERTS_LOG_FILE = "alerts-log.json";
const MAX_CONFIG_BYTES = 256 * 1024;
const MAX_BARS = 288;
const QUOTE_TIMEOUT_MS = 6_000;
const FETCH_TIMEOUT_MS = 10_000;
const DEFAULT_POLL_MS = 30_000;
const STALE_QUOTE_MS = 15 * 60 * 1000;
const USER_AGENT = "dsh-plugin-goldboard/0.1 (+DeepSeek Harness plugin)";

const BAR_INTERVALS = Object.freeze([1, 5, 15, 60]);
const EASTMONEY_KLT = Object.freeze({ 5: 5, 15: 15, 30: 30, 60: 60, 101: 101 });

const ACTION_LABELS_ZH = Object.freeze({
  buy_setup: "出现买入信号",
  sell_take_profit: "到达止盈参考",
  sell_trailing: "移动止盈提醒",
  sell_stop: "止损参考",
  sell_weakness: "走弱减仓参考",
  close_by_session_end: "日内了结提醒",
  spread_alert: "内外盘价差异常",
  data_stale: "行情数据过期",
});

const ACTION_LABELS_EN = Object.freeze({
  buy_setup: "Buy setup",
  sell_take_profit: "Take-profit reference",
  sell_trailing: "Trailing stop reference",
  sell_stop: "Stop-loss reference",
  sell_weakness: "Weakness / reduce reference",
  close_by_session_end: "Close before session end",
  spread_alert: "Domestic vs international spread alert",
  data_stale: "Stale market data",
});

// ── config defaults / normalization ────────────────────────────────────────

export const DEFAULT_CONFIG = Object.freeze({
  fee: Object.freeze({ buyPerGram: 0, sellPerGram: 5 }),
  // 2026-08 实测：Au99.99 950.00 时招行积存金约 951.72，故默认价差校准为 +1.72。
  cmb: Object.freeze({ buySpreadPerGram: 1.72, sellSpreadPerGram: 1.72 }),
  position: Object.freeze({ grams: 0, avgCostPerGram: 0 }),
  limits: Object.freeze({ maxGrams: 0, maxAmount: 0 }),
  strategy: Object.freeze({
    minProfitPerGram: 1,
    maxLossPerGram: 2,
    slippagePerGram: 0.2,
    estimatedSpreadPerGram: 0.2,
    rsiOversold: 35,
    rsiOverbought: 75,
    atrFactor: 0.3,
    nearSupportPct: 0.5,
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
    position: {
      grams: num(position.grams, DEFAULT_CONFIG.position.grams, 0, 100000),
      avgCostPerGram: num(position.avgCostPerGram, DEFAULT_CONFIG.position.avgCostPerGram, 0, 1000000),
    },
    limits: {
      maxGrams: num(limits.maxGrams, DEFAULT_CONFIG.limits.maxGrams, 0, 100000),
      maxAmount: num(limits.maxAmount, DEFAULT_CONFIG.limits.maxAmount, 0, 100000000),
    },
    strategy: {
      minProfitPerGram: num(strategy.minProfitPerGram, DEFAULT_CONFIG.strategy.minProfitPerGram, 0, 100),
      maxLossPerGram: num(strategy.maxLossPerGram, DEFAULT_CONFIG.strategy.maxLossPerGram, 0, 1000),
      slippagePerGram: num(strategy.slippagePerGram, DEFAULT_CONFIG.strategy.slippagePerGram, 0, 50),
      estimatedSpreadPerGram: num(strategy.estimatedSpreadPerGram, DEFAULT_CONFIG.strategy.estimatedSpreadPerGram, 0, 50),
      rsiOversold: num(strategy.rsiOversold, DEFAULT_CONFIG.strategy.rsiOversold, 1, 50),
      rsiOverbought: num(strategy.rsiOverbought, DEFAULT_CONFIG.strategy.rsiOverbought, 50, 99),
      atrFactor: num(strategy.atrFactor, DEFAULT_CONFIG.strategy.atrFactor, 0.05, 2),
      nearSupportPct: num(strategy.nearSupportPct, DEFAULT_CONFIG.strategy.nearSupportPct, 0.05, 10),
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

// ── quote collection ───────────────────────────────────────────────────────

async function fetchDomesticQuote() {
  try {
    const text = await fetchGb18030("https://hq.sinajs.cn/list=gds_AU9999", {
      headers: { Referer: "https://finance.sina.com.cn/", "User-Agent": USER_AGENT },
    });
    const quote = parseSinaDomesticQuote(text);
    if (quote) return { ...quote, source: "sina" };
  } catch {
    // fall through
  }
  try {
    const text = await fetchUtf8(
      "https://push2.eastmoney.com/api/qt/stock/get?secid=118.AU9999&fields=f43,f44,f45,f46,f60,f86,f170",
      { headers: { Referer: "https://quote.eastmoney.com/", "User-Agent": USER_AGENT } },
    );
    const quote = parseEastmoneyDomesticQuote(JSON.parse(text));
    if (quote) return { ...quote, source: "eastmoney" };
  } catch {
    // fall through
  }
  return null;
}

async function fetchXauQuote() {
  try {
    const text = await fetchGb18030("https://qt.gtimg.cn/q=hf_XAU", {
      headers: { "User-Agent": USER_AGENT },
    });
    const quote = parseTencentXauQuote(text);
    if (quote) return { ...quote, source: "tencent" };
  } catch {
    // fall through
  }
  try {
    const text = await fetchGb18030("https://hq.sinajs.cn/list=hf_XAU", {
      headers: { Referer: "https://finance.sina.com.cn/", "User-Agent": USER_AGENT },
    });
    const quote = parseTencentXauQuote(text);
    if (quote) return { ...quote, source: "sina" };
  } catch {
    // fall through
  }
  return null;
}

async function fetchUsdcnyQuote() {
  try {
    const text = await fetchGb18030("https://qt.gtimg.cn/q=whUSDCNY", {
      headers: { "User-Agent": USER_AGENT },
    });
    const quote = parseTencentForexQuote(text);
    if (quote) return { ...quote, source: "tencent" };
  } catch {
    // fall through
  }
  return null;
}

async function fetchEastmoneyBars(secid, klt, limit = 120) {
  const url =
    `https://push2his.eastmoney.com/api/qt/stock/kline/get?secid=${secid}&klt=${klt}&fqt=1&lmt=${limit}` +
    "&end=20500101&iscca=1&fields1=f1,f2,f3,f4,f5,f6,f7,f8&fields2=f51,f52,f53,f54,f55,f56,f57,f58";
  const text = await fetchUtf8(url, {
    headers: { Referer: "https://quote.eastmoney.com/", "User-Agent": USER_AGENT },
  });
  return parseEastmoneyKlines(JSON.parse(text));
}

// ── bars ───────────────────────────────────────────────────────────────────

function alignStart(timestamp, intervalMinutes) {
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
  for (const bar of klines) {
    const t = alignStart(bar.t, 5);
    upsertBar(bars[5], { t, o: bar.o, h: bar.h, l: bar.l, c: bar.c });
    const t60 = alignStart(bar.t, 60);
    upsertBar(bars[60], { t, o: bar.o, h: bar.h, l: bar.l, c: bar.c });
  }
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

function suggestedGrams(config, price) {
  let grams = config.limits.maxGrams > 0 ? config.limits.maxGrams - config.position.grams : Infinity;
  if (config.limits.maxAmount > 0) {
    const amountGrams = Math.floor(config.limits.maxAmount / price * 100) / 100;
    grams = Math.min(grams, amountGrams);
  }
  if (!Number.isFinite(grams) || grams <= 0) return 0;
  return Math.min(100000, Math.floor(grams * 100) / 100);
}

export function computePlan(runtime, config, now = new Date()) {
  const cfg = normalizeConfig(config);
  const domestic = runtime.quotes?.AU9999;
  const xau = runtime.quotes?.XAU;
  const usdcny = runtime.quotes?.USDCNY;
  const market = computeMarketState(cfg, now);

  const base = {
    action: "no_data",
    marketState: market.state,
    instrument: "Au99.99",
    signalPrice: domestic?.price,
    cmbEstimatedPrice: Number.isFinite(domestic?.price)
      ? round2(domestic.price + cfg.cmb.buySpreadPerGram)
      : undefined,
    grams: 0,
    reasonCodes: [],
    breakeven: undefined,
    targetPrice: undefined,
    stopPrice: undefined,
    suggestedOrder: null,
  };

  if (!domestic || !Number.isFinite(domestic.price) || domestic.price <= 0) {
    base.reasonCodes.push("quote_missing");
    return base;
  }

  const bars5 = runtime.bars?.AU9999?.[5] ?? [];
  const bars60 = runtime.bars?.AU9999?.[60] ?? [];
  const ind5 = computeIndicatorSet(bars5);
  const ind60 = computeIndicatorSet(bars60);
  const price = domestic.price;
  const cmbBuy = round2(price + cfg.cmb.buySpreadPerGram);
  const cmbSell = round2(price + cfg.cmb.sellSpreadPerGram);
  const estSpread = finite(domestic.ask - domestic.bid, cfg.strategy.estimatedSpreadPerGram);
  const slippage = cfg.strategy.slippagePerGram;
  const fee = cfg.fee;
  const spreadCmb = cfg.cmb;
  const pos = cfg.position;
  const strategy = cfg.strategy;

  base.signalPrice = round2(price);
  base.cmbEstimatedPrice = cmbSell;
  base.indicators = { ind5, ind60, xauCnyPerGram: undefined };
  if (Number.isFinite(xau?.price) && Number.isFinite(usdcny?.price)) {
    base.xauCnyPerGram = round2(xau.price * usdcny.price / 31.1034768);
  }

  if (market.state !== "open") {
    base.action = "market_closed";
    base.reasonCodes.push("market_closed");
    return base;
  }

  const quoteStale = Number.isFinite(domestic.updatedAt) && now.getTime() - domestic.updatedAt > STALE_QUOTE_MS;
  if (quoteStale) {
    base.action = "data_stale";
    base.reasonCodes.push("stale_quote");
    return base;
  }

  // Existing position: user's avg cost is their actual CMB entry cost.
  if (pos.grams > 0) {
    const avgCost = pos.avgCostPerGram || 0;
    const exitNeeded = round2(avgCost + fee.sellPerGram + estSpread + slippage);
    const cmbNow = cmbSell;
    const pnl = round2((cmbNow - fee.sellPerGram - avgCost) * pos.grams);
    base.position = {
      grams: pos.grams,
      avgCostPerGram: round2(avgCost),
      cmbNow,
      feeAdjustedPnl: pnl,
      exitNeeded,
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
    base.stopPrice = round2(avgCost - strategy.maxLossPerGram - fee.sellPerGram);

    if (cmbNow >= targetPrice) {
      base.action = "sell_take_profit";
      base.reasonCodes.push("target_reached");
    } else if (Number.isFinite(ind5.sma20) && bars5.length >= 1) {
      const last = bars5[bars5.length - 1];
      if (last.c < ind5.sma20 && pnl > 0) {
        base.action = "sell_trailing";
        base.reasonCodes.push("break_below_sma20_with_profit");
      }
    }
    if (base.action === "sell_take_profit" || base.action === "sell_trailing") {
      // keep the stronger signal
    } else if (cmbNow <= base.stopPrice) {
      base.action = "sell_stop";
      base.reasonCodes.push("stop_reached");
    } else if (Number.isFinite(ind5.rsi14) && ind5.rsi14 > strategy.rsiOverbought) {
      const last = bars5[bars5.length - 1];
      const prev = bars5[bars5.length - 2];
      if (last && prev && last.c < last.o && last.h - last.c > (ind5.atr14 || 0.5)) {
        base.action = "sell_weakness";
        base.reasonCodes.push("rsi_overbought", "bearish_bar");
      }
    }
    if (market.msToClose <= 30 * 60_000 && base.action !== "sell_stop") {
      base.action = "close_by_session_end";
      base.reasonCodes.push("session_ending");
    }

    base.suggestedOrder = {
      action: base.action,
      instrument: base.instrument,
      side: "sell",
      signalPrice: base.signalPrice,
      cmbEstimatedPrice: cmbSell,
      price: cmbSell,
      grams: base.grams,
      validUntil: new Date(now.getTime() + Math.max(market.msToClose - 10 * 60_000, 60_000)).toISOString(),
      reasonCodes: base.reasonCodes,
      riskNote: "技术面参考，非投资建议",
    };
    return base;
  }

  // Flat: intraday long setup.
  const trendUp = Number.isFinite(ind60.ema20) && Number.isFinite(ind60.ema20Prev) && ind60.ema20 > ind60.ema20Prev;
  const nearSupport = Number.isFinite(ind5.recentLow)
    ? (price - ind5.recentLow) / price * 100 <= strategy.nearSupportPct
    : false;
  const nearLowerBand = Number.isFinite(ind5.boll.lower)
    ? price <= ind5.boll.lower * (1 + strategy.nearSupportPct / 100)
    : false;
  const rsiRecovering = Number.isFinite(ind5.rsi14) && ind5.rsi14 > strategy.rsiOversold && ind5.rsi14 < 50;
  const aboveSma20 = Number.isFinite(ind5.sma20) && price > ind5.sma20;
  const buySetup = trendUp && (nearSupport || nearLowerBand) && (rsiRecovering || aboveSma20);

  if (buySetup) {
    const cmbBuyPrice = cmbBuy;
    const entryCost = round2(cmbBuyPrice + fee.buyPerGram);
    const breakeven = round2(entryCost + fee.sellPerGram + estSpread + slippage);
    const atrValue = Number.isFinite(ind5.atr14) ? ind5.atr14 : 1;
    const suggestedSignalPrice = round2(Math.min(price + 0.1, (ind5.recentLow ?? price) + atrValue * strategy.atrFactor));
    const suggestedCmbPrice = round2(suggestedSignalPrice + spreadCmb.buySpreadPerGram);
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
    base.suggestedOrder = {
      action: base.action,
      instrument: base.instrument,
      side: "buy",
      signalPrice: suggestedSignalPrice,
      cmbEstimatedPrice: suggestedCmbPrice,
      price: suggestedCmbPrice,
      grams,
      validUntil: new Date(now.getTime() + Math.max(market.msToClose - 10 * 60_000, 60_000)).toISOString(),
      reasonCodes: base.reasonCodes,
      riskNote: "技术面参考，非投资建议",
    };
    return base;
  }

  base.action = "wait";
  base.breakeven = round2(cmbBuy + fee.buyPerGram + fee.sellPerGram + estSpread + slippage);
  base.targetPrice = base.breakeven + strategy.minProfitPerGram;
  base.reasonCodes.push(trendUp ? "trigger_not_confirmed" : "trend_filter_not_met");
  return base;
}

// ── snapshot builder ───────────────────────────────────────────────────────

function quoteView(quote, now) {
  if (!quote) return null;
  const stale = !Number.isFinite(quote.updatedAt) || now - quote.updatedAt > STALE_QUOTE_MS;
  return {
    price: quote.price,
    bid: quote.bid,
    ask: quote.ask,
    high: quote.high,
    low: quote.low,
    open: quote.open,
    prevClose: quote.prevClose,
    time: quote.time,
    date: quote.date,
    source: quote.source,
    stale,
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
  const plan = runtime.plan ?? computePlan(runtime, cfg, now);
  const domestic = runtime.quotes?.AU9999;
  const xau = runtime.quotes?.XAU;
  const usdcny = runtime.quotes?.USDCNY;
  const derived = {};
  if (Number.isFinite(xau?.price) && Number.isFinite(usdcny?.price)) {
    derived.xauCnyPerGram = round2(xau.price * usdcny.price / 31.1034768);
  }
  if (Number.isFinite(domestic?.price) && Number.isFinite(derived.xauCnyPerGram)) {
    derived.domesticPremiumPerGram = round2(domestic.price - derived.xauCnyPerGram);
    derived.domesticPremiumPct = round2(derived.domesticPremiumPerGram / derived.xauCnyPerGram);
  }
  if (Number.isFinite(domestic?.price)) {
    derived.cmb = {
      buyPrice: round2(domestic.price + cfg.cmb.buySpreadPerGram),
      sellPrice: round2(domestic.price + cfg.cmb.sellSpreadPerGram),
        sellPriceAfterFee: round2(domestic.price + cfg.cmb.sellSpreadPerGram - cfg.fee.sellPerGram),
      sourceNote: `Au99.99 + ${cfg.cmb.buySpreadPerGram}/${cfg.cmb.sellSpreadPerGram} 元/克估算，卖出已扣 ${cfg.fee.sellPerGram} 元/克手续费`,
    };
  }
  const market = computeMarketState(cfg, now);
  market.nextOpen = computeNextMarketOpen(cfg, now);
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
      AU9999: quoteView(domestic, now),
      XAU: quoteView(xau, now),
      USDCNY: quoteView(usdcny, now),
    },
    derived,
    trend: {
      AU9999_5m: barsView(runtime.bars?.AU9999?.[5]),
      XAU_5m: barsView(runtime.bars?.XAU?.[5]),
    },
    indicators: plan.indicators ?? {},
    position: plan.position ?? {
      grams: cfg.position.grams,
      avgCostPerGram: cfg.position.avgCostPerGram,
      cmbNow: derived.cmb?.sellPrice,
      feeAdjustedPnl: 0,
      exitNeeded: round2(cfg.position.avgCostPerGram + cfg.fee.sellPerGram + cfg.strategy.estimatedSpreadPerGram + cfg.strategy.slippagePerGram),
    },
    plan: {
      action: plan.action,
      reasonCodes: plan.reasonCodes ?? [],
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
  const params = {
    action: label,
    instrument: order?.instrument ?? "Au99.99",
    price: order?.signalPrice ?? plan?.signalPrice ?? "",
    cmbPrice: order?.cmbEstimatedPrice ?? plan?.cmbEstimatedPrice ?? "",
    target: plan?.targetPrice ?? "",
    grams: order?.grams ?? plan?.grams ?? "",
    time: new Date().toISOString(),
  };
  const title = zh ? `黄金看板 · ${label}` : `Gold Board · ${label}`;
  const body = zh
    ? `Au99.99 ${params.price} 元/克 · 招行估算 ${params.cmbPrice} 元/克\n${params.action}：${params.instrument} ${params.grams}g${params.target ? ` · 目标 ${params.target}` : ""}`
    : `Au99.99 ${params.price} CNY/g · CMB est. ${params.cmbPrice} CNY/g\n${params.action}: ${params.instrument} ${params.grams}g${params.target ? ` · target ${params.target}` : ""}`;
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
    quotes: { AU9999: null, XAU: null, USDCNY: null },
    bars: { AU9999: ensureBars({}), XAU: ensureBars({}) },
    plan: null,
    alertState: {},
    localeHint: "zh",
    lastAlertLog: [],
    lastSnapshot: null,
    ready: false,
    ticking: false,
  };

  const configPath = join(stateDir, CONFIG_FILE);
  const statePath = join(stateDir, STATE_FILE);
  const alertsPath = join(stateDir, ALERTS_LOG_FILE);

  function recordQuote(key, quote) {
    if (!quote) return;
    quote.updatedAt = Date.now();
    runtime.quotes[key] = quote;
    recordTick(runtime.bars[key], quote, quote.updatedAt);
  }

  function persistState() {
    return writeJsonAtomic(statePath, {
      quotes: runtime.quotes,
      bars: runtime.bars,
      alertState: runtime.alertState,
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

  async function refreshQuotes() {
    const results = await Promise.allSettled([
      fetchDomesticQuote(),
      fetchXauQuote(),
      fetchUsdcnyQuote(),
    ]);
    const [domestic, xau, usdcny] = results;
    if (domestic.status === "fulfilled") recordQuote("AU9999", domestic.value);
    if (xau.status === "fulfilled") recordQuote("XAU", xau.value);
    if (usdcny.status === "fulfilled") recordQuote("USDCNY", usdcny.value);
    // If a quote source is down, keep previous values; stale flag is derived from updatedAt.
  }

  async function seedHistory() {
    const bars5 = runtime.bars.AU9999[5];
    if (bars5.length < 60) {
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
        if (klines.length > 0) {
          for (const bar of klines) upsertBar(runtime.bars.AU9999[60], bar);
        }
      } catch (error) {
        logger?.warn?.(`dsh-plugin-goldboard: seed AU9999 60m failed: ${String(error?.message ?? error)}`);
      }
    }
  }

  async function tick() {
    if (runtime.ticking) return;
    runtime.ticking = true;
    try {
      await refreshQuotes();
      await seedHistory();
      runtime.plan = computePlan(runtime, runtime.config);
      if (runtime.plan.action === "no_data" && runtime.quotes.AU9999 === null) {
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
            };
          }
          runtime.alertState = typeof savedState.alertState === "object" && savedState.alertState !== null ? savedState.alertState : {};
          if (typeof savedState.localeHint === "string") runtime.localeHint = savedState.localeHint;
          if (Array.isArray(savedState.lastAlertLog)) runtime.lastAlertLog = savedState.lastAlertLog.slice(0, 200);
        }
      } catch (error) {
        logger?.warn?.(`dsh-plugin-goldboard: state load failed: ${String(error?.message ?? error)}`);
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
          const limit = Math.min(288, Math.max(1, Number(url.searchParams.get("limit") ?? 288)));
          if (instrument !== "AU9999" && instrument !== "XAU") {
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
