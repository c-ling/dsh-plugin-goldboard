/**
 * plan-06 batch replay statistics: rule hit-rate reporting over a window of
 * past Beijing trading days.
 *
 * Read-only analysis: no alerts, no model calls, no strategy behaviour
 * changes. For every trading day in the window the engine pulls that day's
 * 5m + 60m klines ONCE per calendar day (point-in-time `end=<day>` requests,
 * memoized in-process), then steps along the day's closed 5m bars calling the
 * indicators + computePlan PURE path — the alert state machine never runs,
 * while the confirmBars/cooldown signal policy stays active because it is
 * part of the signal semantics. Each directional event is traced forward over
 * the 5m series (MFE/MAE +30m/+60m, target/stop/breakeven touches, net P&L
 * held to session end), and everything aggregates into a bounded report.
 *
 * Two simulated passes per day keep both rule families observable:
 *   - flat pass  (position zeroed, nominal budget)  → buy_setup / add_position
 *   - hold pass  (synthetic position at the day's open) → sell_* family
 *
 * Data-depth reality (see DESIGN §7.6): 1m bars are synthetic and short-lived,
 * so minute coverage for the data gates is derived by splitting the real 5m
 * klines; the statistics universe is the Au99.99 lane (Eastmoney history);
 * CMB live-lane behaviour is out of scope and disclosed in report.caveats.
 */

import { normalizeConfig } from "./config.js";
import {
  AU_BAR_META,
  MAX_BARS,
} from "./bars.js";
import {
  CALCULATION_VERSION,
  normalizeBarRecord,
} from "./market-quality.js";
import {
  beijingDateForNow,
  beijingParts,
  buildSessionCalendar,
  isOpenMinute,
} from "./market-time.js";
import { computePlan } from "./plan.js";
import { defaultSignalState, SELL_ACTIONS } from "./sizing.js";
import { round2 } from "./shared.js";
import { writeJsonAtomic, readJson } from "./store.js";

/** Report schema version (bump on wire-shape changes). */
export const REPLAY_STATS_VERSION = 1;
/** Default look-back window in trading days. */
export const REPLAY_DAYS_DEFAULT = 10;
/** Window bounds (source history depth limits the useful maximum). */
export const REPLAY_DAYS_MIN = 1;
export const REPLAY_DAYS_MAX = 30;
/** Same-window reports younger than this are served from cache. */
export const REPLAY_CACHE_TTL_MS = 60 * 60_000;
/** detail=true truncates the per-event list to its most recent entries. */
export const REPLAY_DETAIL_EVENT_CAP = 200;
/** Nominal budget (grams) forced for the flat pass so buy_setup can emit. */
export const REPLAY_NOMINAL_MAX_GRAMS = 100;
/** 5m klines pulled per day (≈2+ sessions incl. warm-up tail). */
export const REPLAY_BARS5_LIMIT = 500;
/** 60m klines pulled per day (trend context incl. multi-day warm-up). */
export const REPLAY_BARS60_LIMIT = 300;
/** Pause between per-day pulls: keeps the batch burst under the source's
 *  anti-scraping threshold (observed empty-reply limiting on Eastmoney). */
export const REPLAY_DAY_PACE_MS = 300;

const BAR5_SPAN_MS = 5 * 60_000;
const MINUTE_MS = 60_000;
/** Forward-trace horizons. */
const HORIZON_30M_MS = 30 * MINUTE_MS;
const HORIZON_60M_MS = 60 * MINUTE_MS;

/** Directional actions recorded as events (buy side + the sell family). */
export const REPLAY_TRACKED_ACTIONS = Object.freeze([
  "buy_setup",
  "add_position",
  ...SELL_ACTIONS,
]);

// ── Beijing trading-day enumeration ────────────────────────────────────────

/** "YYYY-MM-DD" of the session that owns `timestamp` (bars after midnight
 *  belong to the previous day's session when the session closes past 24:00). */
export function sessionDateForTimestamp(timestamp, config) {
  const calendar = buildSessionCalendar(config);
  const parts = beijingParts(new Date(timestamp));
  const overnightTail = calendar.closeMin > 1440 ? calendar.closeMin - 1440 : 0;
  if (overnightTail > 0 && parts.minutes < overnightTail) {
    const shifted = new Date(Date.parse(`${parts.date}T00:00:00Z`) - 24 * 60 * 60 * 1000);
    return shifted.toISOString().slice(0, 10);
  }
  return parts.date;
}

/**
 * The most recent `days` tradeable Beijing session dates (oldest first),
 * counting today's session even when it has not opened yet — its partial
 * data simply contributes fewer steps. Pure; calendar-aware.
 */
export function listReplayTradingDays(config, days, now = new Date()) {
  const calendar = buildSessionCalendar(config);
  const cfg = normalizeConfig(config);
  const today = beijingDateForNow(now);
  const todayParts = beijingParts(now);
  const overnightTail = calendar.closeMin > 1440 ? calendar.closeMin - 1440 : 0;
  // A session that opened yesterday and is still running (before its overnight
  // close) counts as "today's" session only after Beijing midnight; before
  // midnight the session date is today itself.
  const todaySession = overnightTail > 0 && todayParts.minutes < overnightTail
    ? new Date(Date.parse(`${today}T00:00:00Z`) - 86_400_000).toISOString().slice(0, 10)
    : today;
  const tradeable = (date, day) => {
    if (calendar.holidaySet.has(date)) return false;
    if (!calendar.weekdaysOnly) return true;
    return day >= 1 && day <= 5;
  };
  const out = [];
  const cursor = new Date(`${todaySession}T00:00:00Z`);
  // Weekdays are derived from each candidate date itself: when an overnight
  // session makes todaySession ≠ today's calendar date, arithmetic offsets
  // from today's weekday would be off by one.
  for (let offset = 0; offset < 400 && out.length < days; offset += 1) {
    const date = new Date(cursor.getTime() - offset * 86_400_000).toISOString().slice(0, 10);
    const day = new Date(`${date}T00:00:00Z`).getUTCDay();
    if (!tradeable(date, day)) continue;
    out.push(date);
  }
  return out.reverse();
}

// ── fixture helpers (pure) ─────────────────────────────────────────────────

/** AU9999-lane quote synthesized from one closed 5m bar. No `time` field on
 *  purpose: parseQuoteTimestamp then trusts the (replay) response instant. */
export function synthReplayQuote(price, atMs) {
  return {
    price: round2(price),
    bid: round2(price - 0.5),
    ask: round2(price + 0.5),
    source: "eastmoney",
    updatedAt: atMs,
    receivedAt: new Date(atMs).toISOString(),
    staleAfterMs: 15 * 60_000,
  };
}

/**
 * Minute-coverage bars derived from real 5m klines: each bar contributes its
 * five minute slots plus — when a following bar exists within 10 minutes —
 * one slot at its own close instant, so the "forming minute" a live poller
 * would always have is present at step boundaries without hiding real gaps.
 * Coverage-only lanes: never used by indicators.
 */
export function expandBarsToMinuteBars(bars5) {
  const out = [];
  const list = (Array.isArray(bars5) ? bars5 : []).map((bar) => normalizeBarRecord(bar)).filter(Boolean);
  for (let i = 0; i < list.length; i += 1) {
    const bar = list[i];
    for (let slot = 0; slot < 5; slot += 1) {
      const t = bar.t + slot * MINUTE_MS;
      out.push({ t, o: bar.o, h: bar.h, l: bar.l, c: bar.c, synthetic: true, source: "replay-coverage" });
    }
    const next = list[i + 1];
    if (next && next.t - bar.t <= 10 * MINUTE_MS) {
      out.push({ t: bar.t + 5 * MINUTE_MS, o: bar.o, h: bar.h, l: bar.l, c: bar.c, synthetic: true, source: "replay-coverage" });
    }
  }
  return out;
}

/**
 * Config clone for one simulated pass. `flat` zeroes the position and forces
 * a nominal budget (users without a configured budget would otherwise never
 * see buy_setup in the report); `hold` synthesizes a position opened at the
 * day's first in-session price so the sell family has something to react to.
 * Both passes share every strategy knob with the live config.
 */
export function statsPassConfig(config, mode, dayOpenPrice) {
  const base = normalizeConfig(config);
  const maxGrams = Math.max(base.limits.maxGrams, REPLAY_NOMINAL_MAX_GRAMS);
  const position = mode === "hold"
    ? {
        grams: Math.min(REPLAY_NOMINAL_MAX_GRAMS, maxGrams),
        avgCostPerGram: round2(dayOpenPrice),
        lots: [{
          id: "replay-hold",
          grams: Math.min(REPLAY_NOMINAL_MAX_GRAMS, maxGrams),
          price: round2(dayOpenPrice),
          time: "",
        }],
      }
    : { grams: 0, avgCostPerGram: 0, lots: [] };
  return {
    ...base,
    limits: { ...base.limits, maxGrams },
    position,
  };
}

/**
 * Forward outcome of one directional event, traced over the 5m series that
 * follows it (crossing into the next early-morning session is allowed).
 *
 * Entry events (buy_setup / add_position) get the full treatment: target /
 * stop / breakeven touches until the event's session ends (chronological
 * first touch wins), MFE/MAE over +30m/+60m, and the net P&L of holding to
 * session end after buy+sell fees, estimated spread and slippage.
 *
 * Sell-family events close longs, so "hit" columns do not apply; they report
 * the post-exit 60m drift (negative = the exit beat holding) and the net
 * saving of exiting versus holding to session end, net of the same costs.
 */
export function computeForwardOutcome(event, futureBars, config, sessionEndMs) {
  const cfg = normalizeConfig(config);
  const isEntry = event.action === "buy_setup" || event.action === "add_position";
  const costPerGram = cfg.fee.buyPerGram + cfg.fee.sellPerGram + cfg.strategy.estimatedSpreadPerGram + cfg.strategy.slippagePerGram;
  const entry = Number(event.price);
  const out = {
    entry: round2(entry),
    costPerGram: round2(costPerGram),
    mfe30m: null,
    mae30m: null,
    mfe60m: null,
    mae60m: null,
    postExitDrift60m: null,
    targetHit: null,
    stopHit: null,
    breakevenTouched: null,
    firstTouch: null,
    sessionEndNet: null,
    sessionEndPrice: null,
    horizonBars: 0,
  };
  if (!Number.isFinite(entry) || entry <= 0) return out;

  let maxHigh30 = -Infinity;
  let minLow30 = Infinity;
  let maxHigh60 = -Infinity;
  let minLow60 = Infinity;
  let close60 = null;
  let sessionLastClose = null;
  let targetHit = false;
  let stopHit = false;
  let breakevenTouched = false;
  let firstTouch = null;
  let counted = 0;
  const target = Number.isFinite(Number(event.targetPrice)) ? Number(event.targetPrice) : null;
  const stop = Number.isFinite(Number(event.stopPrice)) ? Number(event.stopPrice) : null;
  const breakeven = Number.isFinite(Number(event.breakeven)) ? Number(event.breakeven) : null;

  for (const bar of futureBars) {
    if (!bar || !Number.isFinite(bar.t)) continue;
    if (bar.t >= sessionEndMs) break;
    counted += 1;
    const age = bar.t - event.tMs;
    if (age > 0 && age <= HORIZON_30M_MS) {
      maxHigh30 = Math.max(maxHigh30, bar.h);
      minLow30 = Math.min(minLow30, bar.l);
    }
    if (age > 0 && age <= HORIZON_60M_MS) {
      maxHigh60 = Math.max(maxHigh60, bar.h);
      minLow60 = Math.min(minLow60, bar.l);
      close60 = bar.c;
    }
    if (isEntry) {
      if (target !== null && bar.h >= target) {
        targetHit = true;
        if (firstTouch === null) firstTouch = "target";
      }
      if (stop !== null && bar.l <= stop) {
        stopHit = true;
        if (firstTouch === null) firstTouch = "stop";
      }
      if (breakeven !== null && bar.l <= breakeven) breakevenTouched = true;
    }
    sessionLastClose = bar.c;
  }
  out.horizonBars = counted;
  const safe = (value, { clampZero = false } = {}) => {
    if (!Number.isFinite(value)) return null;
    const rounded = round2(value);
    return clampZero && rounded < 0 ? 0 : rounded;
  };
  out.mfe30m = safe(maxHigh30 === -Infinity ? NaN : (isEntry ? maxHigh30 : entry - minLow30) - (isEntry ? entry : 0), { clampZero: !isEntry });
  out.mae30m = safe(minLow30 === Infinity ? NaN : (isEntry ? entry - minLow30 : maxHigh30 - entry), { clampZero: isEntry });
  out.mfe60m = safe(maxHigh60 === -Infinity ? NaN : (isEntry ? maxHigh60 : entry - minLow60) - (isEntry ? entry : 0), { clampZero: !isEntry });
  out.mae60m = safe(minLow60 === Infinity ? NaN : (isEntry ? entry - minLow60 : maxHigh60 - entry), { clampZero: isEntry });
  if (isEntry) {
    out.targetHit = target === null ? null : targetHit;
    out.stopHit = stop === null ? null : stopHit;
    out.breakevenTouched = breakeven === null ? null : breakevenTouched;
    out.firstTouch = firstTouch;
    if (sessionLastClose !== null) {
      out.sessionEndPrice = round2(sessionLastClose);
      out.sessionEndNet = round2(sessionLastClose - entry - costPerGram);
    }
  } else {
    // Post-exit drift: negative means the price fell after the sell — the
    // exit was better than holding.
    out.postExitDrift60m = close60 === null ? null : round2(close60 - entry);
    if (sessionLastClose !== null) {
      out.sessionEndPrice = round2(sessionLastClose);
      out.sessionEndNet = round2(entry - sessionLastClose - costPerGram);
    }
  }
  return out;
}

// ── aggregation ────────────────────────────────────────────────────────────

const CONFIDENCE_BUCKETS = Object.freeze([
  { id: "le4", label: "≤4", min: -Infinity, max: 4 },
  { id: "eq5", label: "5", min: 5, max: 5 },
  { id: "eq6", label: "6", min: 6, max: 6 },
  { id: "ge7", label: "≥7", min: 7, max: Infinity },
]);

function rate(numerator, denominator) {
  if (!(denominator > 0) || numerator === null) return null;
  return Math.round((numerator / denominator) * 10_000) / 10_000;
}

function meanOf(values) {
  const finite = values.filter((value) => Number.isFinite(value));
  if (finite.length === 0) return null;
  return round2(finite.reduce((sum, value) => sum + value, 0) / finite.length);
}

/**
 * Aggregate replay events + step counters into the wire report. Pure and
 * deterministic — the same inputs always produce the same JSON.
 */
export function aggregateReplayReport({ events, steps, blockedSteps, daysRequested, daysEvaluated, daysFailed, failures, params, generatedAt, window }) {
  const perAction = [];
  for (const action of REPLAY_TRACKED_ACTIONS) {
    const group = events.filter((event) => event.action === action);
    if (group.length === 0) continue;
    const outcomes = group.map((event) => event.outcome).filter(Boolean);
    const entries = outcomes.filter((outcome) => outcome.targetHit !== null);
    const laneSplit = {};
    for (const event of group) {
      const lane = event.signalLane || "unknown";
      laneSplit[lane] = (laneSplit[lane] || 0) + 1;
    }
    perAction.push({
      action,
      count: group.length,
      targetHitRate: rate(entries.filter((outcome) => outcome.targetHit === true).length, entries.length),
      stopHitRate: rate(entries.filter((outcome) => outcome.stopHit === true).length, entries.length),
      breakevenTouchedRate: rate(entries.filter((outcome) => outcome.breakevenTouched === true).length, entries.length),
      avgMfe30m: meanOf(outcomes.map((outcome) => outcome.mfe30m)),
      avgMae30m: meanOf(outcomes.map((outcome) => outcome.mae30m)),
      avgMfe60m: meanOf(outcomes.map((outcome) => outcome.mfe60m)),
      avgMae60m: meanOf(outcomes.map((outcome) => outcome.mae60m)),
      avgPostExitDrift60m: meanOf(outcomes.map((outcome) => outcome.postExitDrift60m)),
      sessionEndAvgNet: meanOf(outcomes.map((outcome) => outcome.sessionEndNet)),
      perLaneSplit: laneSplit,
    });
  }
  const entryEvents = events.filter((event) => event.action === "buy_setup" || event.action === "add_position");
  const confidenceBuckets = CONFIDENCE_BUCKETS.map((bucket) => {
    const group = entryEvents.filter((event) => {
      const score = Number(event.confidenceScore);
      return Number.isFinite(score) && score >= bucket.min && score <= bucket.max;
    });
    const withTarget = group.filter((event) => event.outcome && event.outcome.targetHit !== null);
    return {
      bucket: bucket.label,
      events: group.length,
      targetHitRate: rate(withTarget.filter((event) => event.outcome.targetHit === true).length, withTarget.length),
      avgMfe30m: meanOf(group.map((event) => event.outcome?.mfe30m)),
      sessionEndAvgNet: meanOf(group.map((event) => event.outcome?.sessionEndNet)),
    };
  }).filter((bucket) => bucket.events > 0);

  const caveats = [
    "lane-au9999-only",
    "minute-coverage-from-5m",
    "synthetic-lane-sampling",
    "history-depth-limited",
    "two-simulated-passes",
    "past-performance-advisory",
  ];
  return {
    version: REPLAY_STATS_VERSION,
    generatedAt: new Date(generatedAt).toISOString(),
    calculationVersion: CALCULATION_VERSION,
    params: { ...params, lane: "auto" },
    window,
    daysRequested,
    daysEvaluated,
    daysFailed,
    totals: {
      steps,
      directionalEvents: events.length,
      blockedSteps,
      coverageBlockedRatio: rate(blockedSteps, steps),
    },
    perAction,
    confidenceBuckets,
    caveats,
    failures: failures.slice(),
  };
}

// ── per-day replay (pure over its inputs) ──────────────────────────────────

/**
 * Replay one trading day. `bars5All` / `bars60All` are the point-in-time
 * series fetched for this day (including pre-day warm-up tail); stepping
 * follows the day's in-session 5m bars.
 *
 * Each bar is evaluated twice — once per simulated pass — and each pass
 * carries ONE signal state across the whole day: confirmBars streaks,
 * same-direction cooldown and lane-instrument resets behave exactly like the
 * live tick loop, only reset at day boundaries (alert state machine absent).
 * Returns `{ steps, blockedSteps, events }`; steps/blockedSteps count every
 * pass evaluation, events carry their forward outcome.
 */
export function replayTradingDay(day, rawBars5All, rawBars60All, config) {
  const cfgBase = normalizeConfig(config);
  const calendar = buildSessionCalendar(cfgBase);
  // Defensive sort: fetch adapters normally return ascending series already.
  const bars5All = [...(Array.isArray(rawBars5All) ? rawBars5All : [])].sort((a, b) => a.t - b.t);
  const bars60All = [...(Array.isArray(rawBars60All) ? rawBars60All : [])].sort((a, b) => a.t - b.t);
  const inSession = (bar) => {
    if (!bar || !Number.isFinite(bar.t)) return false;
    return sessionDateForTimestamp(bar.t, cfgBase) === day && isOpenMinute(calendar, bar.t);
  };
  const minuteBars = expandBarsToMinuteBars(bars5All);
  const dayBars5 = bars5All.filter(inSession);
  const events = [];
  let steps = 0;
  let blockedSteps = 0;
  if (dayBars5.length === 0) return { steps, blockedSteps, events };

  const dayOpenPrice = dayBars5[0].c;
  const passConfigs = {
    flat: statsPassConfig(cfgBase, "flat", dayOpenPrice),
    hold: statsPassConfig(cfgBase, "hold", dayOpenPrice),
  };
  // Session end instant: close of this day's final in-session bar (Beijing
  // sessions may run past midnight; forward traces stop there).
  const lastBar = dayBars5[dayBars5.length - 1];
  const sessionEndMs = lastBar.t + BAR5_SPAN_MS;

  for (const pass of ["flat", "hold"]) {
    const passConfig = passConfigs[pass];
    // One runtime per day+pass: signalState advances across steps; laneState
    // stays absent so computePlan resolves the lane directly per evaluation.
    const runtime = {
      quotes: { AU9999: null, XAU: null, GCF: null, USDCNY: null, CMB: null },
      bars: {
        AU9999: { 1: [], 5: [], 60: [] },
        XAU: { 1: [], 5: [], 60: [] },
        GCF: { 1: [], 5: [], 60: [] },
        CMB: { 1: [], 5: [], 60: [] },
      },
      signalState: defaultSignalState(),
    };
    let cursor5 = 0;
    let cursor60 = 0;
    let cursorMinute = 0;
    for (const bar of dayBars5) {
      const stepNowMs = bar.t + BAR5_SPAN_MS;
      while (cursor5 < bars5All.length && bars5All[cursor5].t < stepNowMs) cursor5 += 1;
      while (cursor60 < bars60All.length && Number.isFinite(bars60All[cursor60]?.t) && bars60All[cursor60].t + 60 * MINUTE_MS <= stepNowMs) cursor60 += 1;
      // Minute-coverage lanes include the forming-minute marker at `now`.
      while (cursorMinute < minuteBars.length && minuteBars[cursorMinute].t <= stepNowMs) cursorMinute += 1;
      steps += 1;
      runtime.quotes.AU9999 = synthReplayQuote(bar.c, stepNowMs);
      runtime.bars.AU9999[1] = minuteBars.slice(Math.max(0, cursorMinute - MAX_BARS), cursorMinute);
      runtime.bars.AU9999[5] = bars5All.slice(Math.max(0, cursor5 - MAX_BARS), cursor5);
      runtime.bars.AU9999[60] = bars60All.slice(Math.max(0, cursor60 - MAX_BARS), cursor60);

      const plan = computePlan(runtime, passConfig, new Date(stepNowMs));
      if (plan.signalState) runtime.signalState = plan.signalState;
      if (plan.action === "data_incomplete") blockedSteps += 1;
      if (!REPLAY_TRACKED_ACTIONS.includes(plan.action)) continue;
      const event = {
        day,
        t: new Date(bar.t).toISOString(),
        tMs: bar.t,
        pass,
        action: plan.action,
        instrument: plan.instrument,
        signalLane: plan.signalLane,
        price: plan.signalPrice,
        confidenceScore: plan.confidenceScore,
        targetPrice: plan.targetPrice,
        stopPrice: plan.stopPrice,
        breakeven: plan.breakeven,
      };
      // Forward trace over the bars AFTER this one (whole fetched series so
      // horizons may cross into the next early-morning session).
      event.outcome = computeForwardOutcome(event, bars5All.slice(cursor5), passConfig, sessionEndMs);
      events.push(event);
    }
  }
  return { steps, blockedSteps, events };
}

// ── engine (single-flight + cache + persistence) ───────────────────────────

/** AbortError factory (mirrors DOMException naming for route mapping). */
function abortError(reason) {
  const error = new Error(String(reason?.message ?? reason ?? "replay statistics cancelled"));
  error.name = "AbortError";
  return error;
}

/**
 * Reject as soon as `signal` fires, even while the underlying promise (a slow
 * or wedged transport) is still pending — the abandoned work settles on its
 * own timeout and its result is discarded.
 */
function withAbortSignal(promise, signal) {
  if (!signal) return promise;
  if (signal.aborted) return Promise.reject(abortError(signal.reason));
  let onAbort = null;
  return Promise.race([
    promise,
    new Promise((_, reject) => {
      onAbort = () => reject(abortError(signal.reason));
      signal.addEventListener("abort", onAbort, { once: true });
    }),
  ]).finally(() => signal.removeEventListener("abort", onAbort));
}

/**
 * Stateful replay-statistics engine, one per plugin instance.
 *
 * @param deps.getConfig        () => live config
 * @param deps.fetchKlines      async (secid, klt, limit, endDay) => bars[]
 * @param deps.file             optional replay-stats.json path (persistence)
 * @param deps.writeQueue       makeWriteQueue() enqueue fn
 * @param deps.logger           host logger
 */
export function createReplayStats(deps) {
  const { getConfig, fetchKlines, file = null, writeQueue = null, logger = null } = deps;
  // Point-in-time per-day fetch memo: one request per (secid, klt, day) for
  // the whole process lifetime — historical klines for a closed day never
  // change, so re-running a report never re-hits the source for fetched days.
  const dayFetchMemo = new Map();
  let running = null;
  let lastResult = null; // { params: {days}, generatedAtMs, report, events }

  async function fetchDayBars(day) {
    const endDay = day.replaceAll("-", "");
    const memoKey5 = `118.AU9999|5|${endDay}`;
    const memoKey60 = `118.AU9999|60|${endDay}`;
    let bars5 = dayFetchMemo.get(memoKey5);
    if (bars5 === undefined) {
      bars5 = await fetchKlines("118.AU9999", 5, REPLAY_BARS5_LIMIT, endDay);
      dayFetchMemo.set(memoKey5, Array.isArray(bars5) ? bars5 : []);
    }
    let bars60 = dayFetchMemo.get(memoKey60);
    if (bars60 === undefined) {
      bars60 = await fetchKlines("118.AU9999", 60, REPLAY_BARS60_LIMIT, endDay);
      dayFetchMemo.set(memoKey60, Array.isArray(bars60) ? bars60 : []);
    }
    return { bars5, bars60 };
  }

  async function run({ days = REPLAY_DAYS_DEFAULT, force = false, detail = false, signal = null, now = null } = {}) {
    // Single-flight: a second request joins the in-flight computation.
    if (running) return running;
    const requestedDays = Math.min(REPLAY_DAYS_MAX, Math.max(REPLAY_DAYS_MIN, Math.floor(Number(days) || REPLAY_DAYS_DEFAULT)));

    const cached = !force && lastResult !== null
      && lastResult.params.days === requestedDays
      && Date.now() - lastResult.generatedAtMs < REPLAY_CACHE_TTL_MS;
    if (cached) {
      return envelope(lastResult, { cached: true, detail });
    }

    running = (async () => {
      const config = getConfig();
      const nowDate = now instanceof Date ? now : new Date();
      const dayList = listReplayTradingDays(config, requestedDays, nowDate);
      const failures = [];
      const events = [];
      let steps = 0;
      let blockedSteps = 0;
      let daysEvaluated = 0;
      for (const [dayIndex, day] of dayList.entries()) {
        if (signal?.aborted) throw abortError(signal.reason);
        // Yield to the event loop between days so the tick loop never stalls;
        // pace the burst so consecutive per-day pulls stay under the source's
        // anti-scraping threshold.
        if (dayIndex > 0) await new Promise((resolve) => setTimeout(resolve, REPLAY_DAY_PACE_MS));
        else await new Promise((resolve) => setImmediate(resolve));
        try {
          const { bars5, bars60 } = await withAbortSignal(fetchDayBars(day), signal);
          const dayResult = replayTradingDay(day, bars5, bars60, config);
          steps += dayResult.steps;
          blockedSteps += dayResult.blockedSteps;
          events.push(...dayResult.events);
          daysEvaluated += 1;
        } catch (error) {
          if (error?.name === "AbortError") throw error;
          failures.push({ day, error: String(error?.message ?? error).slice(0, 200) });
          logger?.warn?.(`dsh-plugin-goldboard: replay-stats day ${day} failed: ${String(error?.message ?? error)}`);
        }
      }
      if (signal?.aborted) throw abortError(signal.reason);
      const generatedAtMs = Date.now();
      const report = aggregateReplayReport({
        events,
        steps,
        blockedSteps,
        daysRequested: dayList.length,
        daysEvaluated,
        daysFailed: failures.length,
        failures,
        params: { days: requestedDays },
        generatedAt: generatedAtMs,
        window: { from: dayList[0] ?? null, to: dayList[dayList.length - 1] ?? null },
      });
      lastResult = { params: { days: requestedDays }, generatedAtMs, report, events };
      if (file) {
        await writeJsonAtomic(file, { report }, writeQueue).catch((error) => {
          logger?.warn?.(`dsh-plugin-goldboard: replay-stats persist failed: ${String(error?.message ?? error)}`);
        });
      }
      return envelope(lastResult, { cached: false, detail });
    })().finally(() => {
      running = null;
    });
    return running;
  }

  function envelope(result, { cached, detail }) {
    const events = detail === true && Array.isArray(result.events)
      ? result.events.slice(-REPLAY_DETAIL_EVENT_CAP)
      : undefined;
    return { ok: true, cached: cached === true, report: result.report, ...(events ? { events } : {}) };
  }

  /** Last report: memory first, then the persisted file. Never throws.
   *  `detail=true` attaches the most recent events (memory runs only —
   *  the persisted file intentionally carries just the aggregate report). */
  async function last(detail = false) {
    if (lastResult) return envelope(lastResult, { cached: true, detail });
    if (file) {
      const saved = await readJson(file, null);
      if (saved && typeof saved === "object" && saved.report && typeof saved.report === "object") {
        return { ok: true, cached: true, report: saved.report };
      }
    }
    return { ok: true, report: null };
  }

  return { run, last };
}
