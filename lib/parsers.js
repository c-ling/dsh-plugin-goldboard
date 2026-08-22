/**
 * Pure quote/kline parsers — one function per upstream wire format.
 *
 * plan-05: extracted from the old monolithic lib/index.js (and out of
 * sources.js, which now owns only transport + registry state). No I/O and no
 * module state: every parser maps raw text/JSON to a plain quote/bar record
 * or null.
 */

import { beijingDateForNow } from "./market-time.js";

/** Quotes older than this are flagged stale everywhere (15 minutes). */
export const STALE_QUOTE_MS = 15 * 60 * 1000;

// ── quote timestamp freshness ──────────────────────────────────────────────

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

// ── parsers (pure; exported for tests) ─────────────────────────────────────

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
  // Eastmoney encodes CNY/gram prices scaled by exactly 100 (f43/f44/f45…).
  const EASTMONEY_PRICE_SCALE = 100;
  const price = Number(data.f43) / EASTMONEY_PRICE_SCALE;
  if (!(price > 0)) return null;
  return {
    price,
    high: Number(data.f44) / EASTMONEY_PRICE_SCALE || undefined,
    low: Number(data.f45) / EASTMONEY_PRICE_SCALE || undefined,
    open: Number(data.f46) / EASTMONEY_PRICE_SCALE || undefined,
    prevClose: Number(data.f60) / EASTMONEY_PRICE_SCALE || undefined,
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

