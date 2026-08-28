/**
 * Bar lifecycle: tick recording, kline merging/aggregation, seeding, seed
 * version migration and manual CMB minute-bar ingestion.
 *
 * plan-05: extracted from the old monolithic lib/index.js. Functions mutate
 * the caller's bar buckets in place (the runtime's arrays), exactly as before.
 */

import {
  alignStart,
  beijingDateForNow,
  beijingParts,
  buildSessionCalendar,
  isOpenMinute,
} from "./market-time.js";
import { normalizeBarRecord } from "./market-quality.js";
import { parseQuoteTimestamp } from "./sources.js";

/** All intervals persisted per lane (1m/5m/15m/60m/daily). */
export const BAR_INTERVALS = Object.freeze([1, 5, 15, 60, 1440]);
/** Rolling per-interval cap. */
export const MAX_BARS = 1440;

// v1.2.x seeded 60m buckets by overwriting each hour bucket with the last 5m
// sub-bar's OHLC (no aggregation). Those corrupt buckets persist in
// state.json for up to 60 days (MAX_BARS), silently degrading the ind60
// EMA20 trend filter. Bump this version whenever the seeding format changes:
// state.json records `barsSeedVersion`; on mismatch the affected lanes are
// dropped and rebuilt by seedBars on the next tick.
export const BARS_SEED_VERSION = 2;

export const AU_BAR_META = Object.freeze({ source: "eastmoney", instrument: "Au99.99", market: "sge", currency: "CNY", unit: "gram" });
export const XAU_BAR_META = Object.freeze({ source: "eastmoney", instrument: "XAU/USD", market: "spot", currency: "USD", unit: "troy_ounce" });
export const GCF_BAR_META = Object.freeze({ source: "yahoo", instrument: "GC=F", market: "futures", currency: "USD", unit: "troy_ounce" });
export const CMB_BAR_META = Object.freeze({ source: "manual", synthetic: true, instrument: "CMB_ACCUMULATED_GOLD", market: "bank", currency: "CNY", unit: "gram" });

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
    const compatibleSides = last.executionSideComplete === true
      && bar.executionSideComplete === true
      && last.executionSideSource === bar.executionSideSource;
    if (compatibleSides) {
      for (const prefix of ["ask", "bid"]) {
        const highKey = `${prefix}H`;
        const lowKey = `${prefix}L`;
        const closeKey = `${prefix}C`;
        last[highKey] = Math.max(last[highKey], bar[highKey]);
        last[lowKey] = Math.min(last[lowKey], bar[lowKey]);
        last[closeKey] = bar[closeKey];
      }
    } else {
      last.executionSideComplete = false;
      delete last.executionSideSource;
      for (const key of ["askO", "askH", "askL", "askC", "bidO", "bidH", "bidL", "bidC"]) delete last[key];
    }
    return;
  }
  list.push(bar);
  if (list.length > MAX_BARS) list.splice(0, list.length - MAX_BARS);
}

/** Fold one normalized quote into every interval's bucket for `timestamp`. */
export function recordTick(bars, quote, timestamp) {
  if (!bars) return;
  for (const interval of BAR_INTERVALS) {
    const list = bars[interval];
    if (!list) continue;
    const t = alignStart(timestamp, interval);
    const ask = Number(quote.customerBuy ?? quote.buyPrice ?? quote.ask);
    const bid = Number(quote.customerSell ?? quote.sellPrice ?? quote.bid);
    const hasAsk = Number.isFinite(ask) && ask > 0;
    const hasBid = Number.isFinite(bid) && bid > 0;
    const sideFields = {
      executionSideComplete: hasAsk && hasBid,
      ...(hasAsk && hasBid && typeof quote.source === "string" ? { executionSideSource: quote.source } : {}),
      ...(hasAsk ? { askO: ask, askH: ask, askL: ask, askC: ask } : {}),
      ...(hasBid ? { bidO: bid, bidH: bid, bidL: bid, bidC: bid } : {}),
    };
    const bar = normalizeBarRecord(
      { t, o: quote.price, h: quote.price, l: quote.price, c: quote.price, synthetic: true, ...sideFields },
      quote,
    );
    if (bar) upsertBar(list, bar);
  }
}

/** Normalize/validate a whole lane map ({1:[],5:[],…}) from untrusted state. */
export function ensureBars(bars) {
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

export function mergeKlines(list, klines, intervalMinutes, metadata = {}) {
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
export function aggregateSubBars(list, subKlines, intervalMinutes, metadata = {}, now = new Date()) {
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

/** Seed one lane from kline history: direct 5m merge + aggregated 60m. */
export function seedBars(bars, klines, metadata = {}, now = new Date()) {
  mergeKlines(bars[5], klines, 5, metadata);
  aggregateSubBars(bars[60], klines, 60, metadata, now);
}

/**
 * Detect missing intraday 5m bars. A gap between two recent bars is treated
 * as missing when it is larger than one normal interval but still within a
 * single session (less than 6 hours), which avoids treating overnight and
 * weekend breaks as something to backfill.
 */
export function hasMissingRecentBars(list, now, intervalMinutes = 5) {
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
export function hasMissingLeadingBars(list, now, intervalMinutes = 5) {
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
