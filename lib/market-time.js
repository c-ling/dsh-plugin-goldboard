import { normalizeConfig } from "./config.js";
import { minimumCoverageForWindow } from "./market-quality.js";

const BEIJING_OFFSET_MS = 8 * 60 * 60 * 1000;

export const CALENDAR_VERSIONS = Object.freeze({
  CMB: "goldboard-cmb-reminder-v2",
  SGE: "goldboard-sge-calendar-v1",
  XAU: "goldboard-xau-24x5-v1",
  GCF: "goldboard-comex-diagnostic-v1",
  UNKNOWN: "goldboard-calendar-unknown-v1",
});

function parseTime(value, fallback) {
  const match = /^(\d{2}):(\d{2})$/.exec(value);
  if (!match) return fallback;
  return Number(match[1]) * 60 + Number(match[2]);
}

export function beijingParts(now) {
  const date = now instanceof Date ? now : new Date(now);
  const shifted = new Date(date.getTime() + BEIJING_OFFSET_MS);
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

function normalizedInstrument(value) {
  const key = String(value ?? "").toUpperCase();
  if (["CMB", "CMB_ACCUMULATED_GOLD"].includes(key)) return "CMB";
  if (["AU9999", "AU99.99", "SGE"].includes(key)) return "SGE";
  if (["XAU", "XAU/USD", "XAUUSD"].includes(key)) return "XAU";
  if (["GCF", "GC=F"].includes(key)) return "GCF";
  return "UNKNOWN";
}

const sessionCalendarCache = new WeakMap();

/** Build the configurable CMB reminder calendar retained for compatibility. */
export function buildSessionCalendar(config) {
  if (config && typeof config === "object" && sessionCalendarCache.has(config)) {
    return sessionCalendarCache.get(config);
  }
  const cfg = normalizeConfig(config);
  const openMin = parseTime(cfg.tradingHours.open, 9 * 60);
  const closeMin = parseTime(cfg.tradingHours.close, 26 * 60);
  const calendar = {
    id: "cmb",
    instrument: "CMB_ACCUMULATED_GOLD",
    version: CALENDAR_VERSIONS.CMB,
    timezone: "Asia/Shanghai",
    source: "configured-reminder-policy",
    kind: "beijing-segments",
    openMin,
    closeMin,
    segments: [{ openMin, closeMin }],
    weekdaysOnly: cfg.tradingHours.weekdaysOnly === true,
    holidaySet: new Set(cfg.tradingHours.holidays ?? []),
  };
  if (config && typeof config === "object") sessionCalendarCache.set(config, calendar);
  return calendar;
}

const SGE_CALENDAR = Object.freeze({
  id: "sge",
  instrument: "Au99.99",
  version: CALENDAR_VERSIONS.SGE,
  timezone: "Asia/Shanghai",
  source: "sge-published-session-template",
  kind: "beijing-segments",
  openMin: 9 * 60,
  closeMin: 26 * 60 + 30,
  reportOpenMin: 9 * 60,
  reportCloseMin: 26 * 60 + 30,
  segments: Object.freeze([
    Object.freeze({ openMin: 9 * 60, closeMin: 11 * 60 + 30 }),
    Object.freeze({ openMin: 13 * 60 + 30, closeMin: 15 * 60 + 30 }),
    Object.freeze({ openMin: 20 * 60, closeMin: 26 * 60 + 30 }),
  ]),
  weekdaysOnly: true,
  holidaySet: new Set(),
});

const XAU_CALENDAR = Object.freeze({
  id: "xau",
  instrument: "XAU/USD",
  version: CALENDAR_VERSIONS.XAU,
  timezone: "UTC",
  source: "fixed-24x5-session-template",
  kind: "utc-24x5",
  openMin: 0,
  closeMin: 24 * 60,
  segments: Object.freeze([]),
  weekdaysOnly: false,
  holidaySet: new Set(),
});

const GCF_CALENDAR = Object.freeze({
  ...XAU_CALENDAR,
  id: "gcf",
  instrument: "GC=F",
  version: CALENDAR_VERSIONS.GCF,
  source: "diagnostic-futures-24x5-template",
});

const UNKNOWN_CALENDAR = Object.freeze({
  id: "unknown",
  instrument: null,
  version: CALENDAR_VERSIONS.UNKNOWN,
  timezone: "UTC",
  source: "unknown",
  kind: "closed",
  openMin: 0,
  closeMin: 0,
  segments: Object.freeze([]),
  weekdaysOnly: false,
  holidaySet: new Set(),
});

/** Resolve an independent, versioned calendar adapter for one instrument. */
export function getTradingCalendar(instrument, config = {}) {
  switch (normalizedInstrument(instrument)) {
    case "CMB": return buildSessionCalendar(config);
    case "SGE": return SGE_CALENDAR;
    case "XAU": return XAU_CALENDAR;
    case "GCF": return GCF_CALENDAR;
    default: return UNKNOWN_CALENDAR;
  }
}

export function calendarVersionForInstrument(instrument, config = {}) {
  return getTradingCalendar(instrument, config).version;
}

/** Calendar-aware weekday/holiday test. */
function calendarTradeable(calendar, date, day) {
  if (calendar.holidaySet?.has(date)) return false;
  if (!calendar.weekdaysOnly) return true;
  return day >= 1 && day <= 5;
}

function utcParts(timestamp) {
  const date = new Date(timestamp);
  return {
    date: date.toISOString().slice(0, 10),
    minutes: date.getUTCHours() * 60 + date.getUTCMinutes(),
    day: date.getUTCDay(),
  };
}

function xauOpen(timestamp) {
  const parts = utcParts(timestamp);
  if (parts.day === 6) return false;
  if (parts.day === 0) return parts.minutes >= 22 * 60;
  if (parts.day === 5) return parts.minutes < 22 * 60;
  return true;
}

function openSegment(calendar, timestamp) {
  if (calendar.kind === "utc-24x5") {
    if (!xauOpen(timestamp)) return null;
    const parts = utcParts(timestamp);
    const weekStartOffset = parts.day === 0 ? 0 : -parts.day;
    const sunday = dateStringForOffset(parts.date, weekStartOffset);
    const openMs = Date.parse(`${sunday}T22:00:00Z`);
    const closeMs = openMs + 5 * 24 * 60 * 60_000;
    return { ownerDate: sunday, openMs, closeMs, segmentIndex: 0 };
  }
  if (calendar.kind !== "beijing-segments") return null;
  const parts = beijingParts(new Date(timestamp));
  const yesterdayDate = dateStringForOffset(parts.date, -1);
  const yesterdayDay = (parts.day + 6) % 7;
  for (let index = 0; index < calendar.segments.length; index += 1) {
    const segment = calendar.segments[index];
    const todayClose = Math.min(segment.closeMin, 1440);
    if (calendarTradeable(calendar, parts.date, parts.day)
      && parts.minutes >= segment.openMin && parts.minutes < todayClose) {
      const midnight = Date.parse(`${parts.date}T00:00:00+08:00`);
      return {
        ownerDate: parts.date,
        openMs: midnight + segment.openMin * 60_000,
        closeMs: midnight + segment.closeMin * 60_000,
        segmentIndex: index,
      };
    }
    if (segment.closeMin > 1440
      && calendarTradeable(calendar, yesterdayDate, yesterdayDay)
      && parts.minutes < segment.closeMin - 1440) {
      const midnight = Date.parse(`${yesterdayDate}T00:00:00+08:00`);
      return {
        ownerDate: yesterdayDate,
        openMs: midnight + segment.openMin * 60_000,
        closeMs: midnight + segment.closeMin * 60_000,
        segmentIndex: index,
      };
    }
  }
  return null;
}

/** Return true when a minute is open under a prebuilt calendar or CMB config. */
export function isOpenMinute(calendarOrConfig, timestamp) {
  const calendar = calendarOrConfig?.kind
    ? calendarOrConfig
    : buildSessionCalendar(calendarOrConfig);
  return openSegment(calendar, timestamp) !== null;
}

export function isInstrumentOpen(instrument, timestamp, config = {}) {
  return isOpenMinute(getTradingCalendar(instrument, config), timestamp);
}

/** Session/trading-day owner for durable partitions and report grouping. */
export function tradingDayForTimestamp(instrument, timestamp, config = {}) {
  const calendar = getTradingCalendar(instrument, config);
  const segment = openSegment(calendar, timestamp);
  if (segment) return segment.ownerDate;
  return calendar.timezone === "Asia/Shanghai"
    ? beijingDateForNow(new Date(timestamp))
    : new Date(timestamp).toISOString().slice(0, 10);
}

/** Keep only bars whose start time falls inside configured CMB reminder hours. */
export function filterBarsToTradingHours(bars, config) {
  return filterBarsToMarketHours(bars, "CMB", config);
}

/** Keep only bars whose start time belongs to the instrument calendar. */
export function filterBarsToMarketHours(bars, instrument, config = {}) {
  if (!Array.isArray(bars)) return [];
  const calendar = getTradingCalendar(instrument, config);
  return bars.filter((bar) => bar && Number.isFinite(Number(bar.t)) && isOpenMinute(calendar, Number(bar.t)));
}

function expectedSlots(end, minutes, calendar) {
  const slots = [];
  let cursor = end;
  const maxScanMs = 10 * 24 * 60 * 60_000;
  const scanEnd = end - maxScanMs;
  while (slots.length < minutes && cursor > scanEnd) {
    if (!calendar || isOpenMinute(calendar, cursor)) slots.push(cursor);
    cursor -= 60_000;
  }
  return slots;
}

/**
 * Full coverage facts. `coverageRatio` retains the historical re-anchored
 * denominator, while effectiveSampleMinutes/reanchored/missingBuckets prevent
 * a short post-outage fragment from being mistaken for a complete window.
 */
export const COVERAGE_REANCHOR_GAP_MINUTES = 8;

export function inspectWindowCoverage(bars1m, now, minutes, configOrCalendar = null) {
  const windowMinutes = Math.max(0, Math.floor(Number(minutes) || 0));
  if (!Array.isArray(bars1m) || windowMinutes === 0) {
    return {
      windowMinutes,
      coverageRatio: 0,
      expectedSampleMinutes: windowMinutes,
      effectiveSampleMinutes: 0,
      observedSampleMinutes: 0,
      largestGapMinutes: 0,
      minutesSinceLastGap: null,
      reanchored: false,
      reanchorGapMinutes: 0,
      missingBuckets: [],
      complete: false,
    };
  }
  const end = alignStart(new Date(now).getTime(), 1);
  const allowReanchor = configOrCalendar !== null && configOrCalendar !== undefined;
  const calendar = allowReanchor
    ? (configOrCalendar.kind ? configOrCalendar : buildSessionCalendar(configOrCalendar))
    : null;
  const slots = expectedSlots(end, windowMinutes, calendar);
  const slotSet = new Set(slots);
  const observed = new Set();
  for (const bar of bars1m) {
    const t = alignStart(Number(bar?.t), 1);
    if (!slotSet.has(t) || bar?.partial === true) continue;
    if (Number.isFinite(Number(bar?.c)) && Number(bar.c) > 0) observed.add(t);
  }

  const missing = slots.map((slot) => !observed.has(slot));
  let largestGapMinutes = 0;
  let run = 0;
  let firstMissingIndex = -1;
  let reanchorStart = -1;
  let reanchorGapMinutes = 0;
  for (let index = 0; index < missing.length; index += 1) {
    if (!missing[index]) {
      run = 0;
      continue;
    }
    if (firstMissingIndex < 0) firstMissingIndex = index;
    run += 1;
    largestGapMinutes = Math.max(largestGapMinutes, run);
    if (allowReanchor && reanchorStart < 0 && run >= COVERAGE_REANCHOR_GAP_MINUTES) {
      reanchorStart = index - run + 1;
    }
    if (reanchorStart >= 0 && index >= reanchorStart && run > reanchorGapMinutes) {
      reanchorGapMinutes = run;
    }
  }

  const effectiveSlots = reanchorStart >= 0 ? slots.slice(0, reanchorStart) : slots;
  const observedSampleMinutes = effectiveSlots.reduce((count, slot) => count + (observed.has(slot) ? 1 : 0), 0);
  const coverageRatio = effectiveSlots.length === 0 ? 0 : observedSampleMinutes / effectiveSlots.length;
  const missingBuckets = slots
    .filter((slot) => !observed.has(slot))
    .slice()
    .reverse()
    .map((slot) => new Date(slot).toISOString());
  return {
    windowMinutes,
    coverageRatio,
    expectedSampleMinutes: windowMinutes,
    effectiveSampleMinutes: effectiveSlots.length,
    observedSampleMinutes,
    largestGapMinutes,
    minutesSinceLastGap: firstMissingIndex < 0 ? null : firstMissingIndex,
    reanchored: reanchorStart >= 0,
    reanchorGapMinutes,
    missingBuckets,
    complete: slots.length === windowMinutes && effectiveSlots.length === windowMinutes && observedSampleMinutes === windowMinutes,
  };
}

/** Compatibility ratio view over inspectWindowCoverage(). */
export function windowCoverage(bars1m, now, minutes, config) {
  return inspectWindowCoverage(bars1m, now, minutes, config).coverageRatio;
}

// Data coverage & multi-timeframe resampling (5/10/30/60).
export const PLAN_WINDOWS = Object.freeze([5, 10, 30, 60]);
export const SESSION_WARMUP_MS = 60 * 60_000;
export const MIDNIGHT_WINDOW_END_MINUTES = 60;

/** Bucket-start alignment for a timestamp at intervalMinutes granularity. */
export function alignStart(timestamp, intervalMinutes) {
  if (intervalMinutes === 1440) {
    const shifted = new Date(timestamp + BEIJING_OFFSET_MS);
    const date = shifted.toISOString().slice(0, 10);
    return Date.parse(`${date}T00:00:00+08:00`);
  }
  const span = intervalMinutes * 60_000;
  return Math.floor(timestamp / span) * span;
}

function nextOpenForCalendar(calendar, now = new Date()) {
  const nowMs = new Date(now).getTime();
  if (calendar.kind === "utc-24x5") {
    for (let offset = 1; offset <= 8 * 24 * 60; offset += 1) {
      const candidate = alignStart(nowMs, 1) + offset * 60_000;
      if (isOpenMinute(calendar, candidate) && !isOpenMinute(calendar, candidate - 60_000)) {
        return new Date(candidate).toISOString();
      }
    }
    return null;
  }
  if (calendar.kind !== "beijing-segments") return null;
  const today = beijingParts(new Date(nowMs));
  let best = Infinity;
  for (let offset = 0; offset <= 370; offset += 1) {
    const date = dateStringForOffset(today.date, offset);
    const day = (today.day + offset) % 7;
    if (!calendarTradeable(calendar, date, day)) continue;
    const midnight = Date.parse(`${date}T00:00:00+08:00`);
    for (const segment of calendar.segments) {
      const candidate = midnight + segment.openMin * 60_000;
      if (candidate > nowMs && candidate < best) best = candidate;
    }
    if (Number.isFinite(best)) break;
  }
  return Number.isFinite(best) ? new Date(best).toISOString() : null;
}

/** Next CMB reminder opening retained for compatibility. */
export function computeNextMarketOpen(config, now = new Date()) {
  return nextOpenForCalendar(buildSessionCalendar(config), now);
}

export function computeInstrumentMarketState(instrument, config = {}, now = new Date()) {
  const calendar = getTradingCalendar(instrument, config);
  const segment = openSegment(calendar, new Date(now).getTime());
  return {
    state: segment ? "open" : "closed",
    sessionStart: segment ? new Date(segment.openMs).toISOString() : null,
    msToClose: segment ? Math.max(0, segment.closeMs - new Date(now).getTime()) : 0,
    nextOpen: segment ? null : nextOpenForCalendar(calendar, now),
    calendarVersion: calendar.version,
    calendarId: calendar.id,
  };
}

/** CMB reminder state retained as the plan/alert market gate. */
export function computeMarketState(config, now = new Date()) {
  const state = computeInstrumentMarketState("CMB", config, now);
  return { state: state.state, sessionStart: state.sessionStart, msToClose: state.msToClose };
}

/** Coverage gate with backward-compatible ratios plus complete detail. */
export function coverageGate(bars1m, now, windows = PLAN_WINDOWS, config = null, instrument = "CMB") {
  if (windows && typeof windows === "object" && !Array.isArray(windows)) {
    config = windows;
    windows = PLAN_WINDOWS;
  }
  const calendar = config
    ? (config.kind ? config : getTradingCalendar(instrument, config))
    : null;
  const coverage = {};
  const details = {};
  const failing = [];
  for (const minutes of PLAN_WINDOWS) {
    const detail = inspectWindowCoverage(bars1m, now, minutes, calendar);
    details[minutes] = detail;
    coverage[minutes] = Math.round(detail.coverageRatio * 100) / 100;
    if (windows.includes(minutes) && !(detail.coverageRatio > minimumCoverageForWindow(minutes))) failing.push(minutes);
  }
  return {
    ok: failing.length === 0,
    complete: windows.every((minutes) => details[minutes]?.complete === true),
    coverage,
    details,
    failing,
  };
}
