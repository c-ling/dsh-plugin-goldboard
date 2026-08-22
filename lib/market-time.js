/**
 * Beijing-time market calendar and session arithmetic.
 *
 * plan-05: extracted from the old monolithic lib/index.js. All functions are
 * pure with respect to their inputs; the only cache is the WeakMap keyed by
 * config object identity (the runtime replaces runtime.config wholesale, so
 * identity is a safe key and stale entries are GC-able).
 */

import { normalizeConfig } from "./config.js";
import { minimumCoverageForWindow } from "./market-quality.js";

function parseTime(value, fallback) {
  const match = /^(\d{2}):(\d{2})$/.exec(value);
  if (!match) return fallback;
  return Number(match[1]) * 60 + Number(match[2]);
}

export function beijingParts(now) {
  const shifted = new Date(now.getTime() + 8 * 60 * 60 * 1000);
  return {
    date: shifted.toISOString().slice(0, 10),
    minutes: shifted.getUTCHours() * 60 + shifted.getUTCMinutes(),
    day: shifted.getUTCDay(),
  };
}

/** Beijing calendar date ("YYYY-MM-DD") for an instant. */
export function beijingDateForNow(now) {
  return beijingParts(now).date;
}

function dateStringForOffset(base, offsetDays) {
  const date = new Date(`${base}T00:00:00Z`);
  date.setUTCDate(date.getUTCDate() + offsetDays);
  return date.toISOString().slice(0, 10);
}

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

// ── data coverage & multi-timeframe resampling (5/10/30/60) ────────────────

export const PLAN_WINDOWS = Object.freeze([5, 10, 30, 60]);
// 开盘后 1 小时内 30/60 分钟窗口天然不足，只校验 5/10 分钟窗口；数据参考仍尽量覆盖 5/10/30/60。
// 每天北京时间 00:00-01:00 也处于较长周期窗口天然不足的阶段，同样只校验 5/10 分钟窗口。
export const SESSION_WARMUP_MS = 60 * 60_000;
export const MIDNIGHT_WINDOW_END_MINUTES = 60;

/** Bucket-start alignment for a timestamp at `intervalMinutes` granularity. */
export function alignStart(timestamp, intervalMinutes) {
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
    coverage[minutes] = Math.round(ratio * 100) / 100;
    if (windows.includes(minutes) && !(ratio > minimumCoverageForWindow(minutes))) failing.push(minutes);
  }
  return { ok: failing.length === 0, coverage, failing };
}
