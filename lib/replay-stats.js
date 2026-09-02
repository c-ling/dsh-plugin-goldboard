/**
 * plan-06 batch replay statistics: rule hit-rate reporting over a window of
 * past Beijing trading days.
 *
 * Read-only analysis: no alerts, no model calls, no strategy behaviour
 * changes. Two replay universes are supported (`lane`):
 *
 *   - "cmb" (default): replays on the PERSISTED 招行积存金 series collected by
 *     this host (live polls + manual minute backfill) — the desk the user
 *     actually trades, so hit rates transfer 1:1. No network is touched: each
 *     day slices the local 5m/60m series point-in-time (session date ≤ day).
 *     Depth is bounded by the rolling bar window; days beyond it are reported
 *     as daysSkippedNoData instead of being silently dropped.
 *   - "au9999": the original Eastmoney universe. For every trading day in the
 *     window the engine pulls that day's 5m + 60m klines ONCE per calendar day
 *     (point-in-time `end=<day>` requests, memoized in-process), then steps
 *     along the day's closed 5m bars calling the indicators + computePlan PURE
 *     path — the alert state machine never runs, while the confirmBars/cooldown
 *     signal policy stays active because it is part of the signal semantics.
 *
 * In both universes each directional event is traced forward over the 5m
 * series (MFE/MAE +30m/+60m, target/stop/breakeven touches, net P&L held to
 * session end), and everything aggregates into a bounded report.
 *
 * v5 separates decisions from execution: a suggested limit becomes pending,
 * is eligible from the next complete 5m bar, and fills only when the correct
 * executable ask/bid path touches it before expiry. The report retains the
 * continuous zero-position account and independent signal diagnostics, adding
 * fill provenance, ambiguity, session completeness, costs and equity metrics.

 * Two simulated passes per day keep both rule families observable:
 *   - flat pass  (position zeroed, nominal budget)  → buy_setup / add_position
 *   - hold pass  (synthetic position at the day's open) → sell_* family
 *
 * Data-depth reality (see DESIGN §7.6): minute coverage for the data gates is
 * derived by splitting real 5m bars; the chosen lane's price series feeds both
 * indicators and outcomes, so results are only quoted in that lane's own
 * terms (disclosed in report.caveats).
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
import {
  EXECUTION_MODEL_VERSION,
  accountExecution,
  resolveExecutionBar,
  resolveExecutionQuote,
  valuePosition,
} from "./execution.js";
import { round2 } from "./shared.js";
import { writeJsonAtomic, readJson } from "./store.js";

/** Report schema version (bump on wire-shape changes). */
export const REPLAY_STATS_VERSION = 5;
export const REPLAY_STATS_LEGACY_VERSION = 4;
export const REPLAY_FILL_POLICY = "next-bar-limit";
export const REPLAY_AMBIGUITY_POLICY = "conservative-stop";

/**
 * Provenance identities for the currently deployed control report. These are
 * report labels, not claims that the strategy or its data has been validated.
 * Bump the relevant identity when its semantics change; keep the existing
 * `version` field for the replay wire schema itself.
 */
export const REPLAY_STRATEGY_ID = "control";
export const REPLAY_STRATEGY_VERSION = "goldboard-control-v1";
export const REPLAY_DATA_SCHEMA_VERSION = "goldboard-market-data-v1";
/** Describes the configurable session calendar used by replay, not an official instrument calendar. */
export const REPLAY_CALENDAR_VERSION = "goldboard-configured-session-v1";
export const REPLAY_EVIDENCE_STATUSES = Object.freeze({
  EXPLORATORY: "exploratory",
  VALIDATED: "validated",
});
export const REPLAY_VALIDATION_REQUIREMENTS = Object.freeze({
  minimumHistoryMonths: 12,
  targetHistoryMonths: 24,
  walkForward: Object.freeze({
    trainMonths: 6,
    testMonths: 1,
    rolling: "monthly",
    parametersFrozen: true,
  }),
  requireMultipleOosFolds: true,
  requireRealBidAskEvidence: true,
  requireVerifiedCostSemantics: true,
  requireBenchmarkComparison: true,
  requireUncertaintyIntervals: true,
});

/** Default look-back window in trading days. */
export const REPLAY_DAYS_DEFAULT = 10;
/** Window bounds (source history depth limits the useful maximum). */
export const REPLAY_DAYS_MIN = 1;
export const REPLAY_DAYS_MAX = 30;
/** Same-(window,lane) reports younger than this are served from cache. */
export const REPLAY_CACHE_TTL_MS = 60 * 60_000;
/** detail=true truncates the per-event list to its most recent entries. */
export const REPLAY_DETAIL_EVENT_CAP = 200;
/** detail=true also bounds account-level signals that could not be executed. */
export const REPLAY_UNEXECUTED_SIGNAL_CAP = 200;
/** Nominal budget (grams) forced for the flat pass so buy_setup can emit. */
export const REPLAY_NOMINAL_MAX_GRAMS = 100;
/** 5m klines pulled per day (≈2+ sessions incl. warm-up tail). */
export const REPLAY_BARS5_LIMIT = 500;
/** 60m klines pulled per day (trend context incl. multi-day warm-up). */
export const REPLAY_BARS60_LIMIT = 300;
/** Pause between per-day pulls: keeps the batch burst under the source's
 *  anti-scraping threshold (observed empty-reply limiting on Eastmoney). */
export const REPLAY_DAY_PACE_MS = 300;
/** Replay universes; "cmb" (persisted accumulated-gold series) is the default. */
export const REPLAY_LANES = Object.freeze(["cmb", "au9999"]);
export const REPLAY_LANE_DEFAULT = "cmb";
/**
 * Live-CMB customer sell price synthesized as buy − spread for the hold pass
 * and every sell-side outcome (the persisted bar series stores the customer
 * BUY stream). Matches the observed market-center spread (~5 CNY/g); disclosed
 * via the lane caveat because historical spread wobbles day to day.
 */
export const REPLAY_CMB_SPREAD_PER_GRAM = 5;

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

/** Return the configured session bounds for a Beijing session date. */
export function replaySessionBounds(day, config) {
  const cfg = normalizeConfig(config);
  const calendar = buildSessionCalendar(cfg);
  const midnight = Date.parse(`${day}T00:00:00Z`);
  const openMs = Date.parse(`${day}T${cfg.tradingHours.open}:00+08:00`);
  const closeMs = midnight - 8 * 60 * 60 * 1000 + calendar.closeMin * 60_000;
  return {
    day,
    openMs,
    closeMs,
    open: new Date(openMs).toISOString(),
    close: new Date(closeMs).toISOString(),
  };
}

/** Classify a session without treating the last observed bar as its close. */
export function replaySessionStatus(day, bars5, config, asOf = new Date()) {
  const bounds = replaySessionBounds(day, config);
  const asOfMs = new Date(asOf).getTime();
  const list = (Array.isArray(bars5) ? bars5 : [])
    .filter((bar) => bar && Number.isFinite(Number(bar.t)) && sessionDateForTimestamp(Number(bar.t), config) === day)
    .filter((bar) => isOpenMinute(config, Number(bar.t)))
    .sort((a, b) => Number(a.t) - Number(b.t));
  if (!(asOfMs >= bounds.closeMs)) return { status: asOfMs < bounds.openMs ? "future" : "partial", ...bounds, asOf: new Date(asOfMs).toISOString() };
  const last = list[list.length - 1];
  const complete = !!last && Number(last.t) + BAR5_SPAN_MS >= bounds.closeMs;
  return {
    status: complete ? "complete" : "partial",
    ...bounds,
    asOf: new Date(asOfMs).toISOString(),
    lastObservedMs: last ? Number(last.t) + BAR5_SPAN_MS : null,
  };
}

/**
 * The most recent tradeable Beijing session dates (oldest first). By default
 * only sessions whose configured close has passed are returned; callers may
 * opt into the current partial session explicitly for mark-to-as-of analysis.
 */
export function listReplayTradingDays(config, days, now = new Date(), options = {}) {
  const calendar = buildSessionCalendar(config);
  const requested = Math.max(0, Math.floor(Number(days) || 0));
  const today = beijingDateForNow(now);
  const todayParts = beijingParts(now);
  const overnightTail = calendar.closeMin > 1440 ? calendar.closeMin - 1440 : 0;
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
  for (let offset = 0; offset < 400 && out.length < requested; offset += 1) {
    const date = new Date(cursor.getTime() - offset * 86_400_000).toISOString().slice(0, 10);
    const day = new Date(`${date}T00:00:00Z`).getUTCDay();
    if (!tradeable(date, day)) continue;
    const bounds = replaySessionBounds(date, config);
    if (options.includePartial === true || bounds.closeMs <= new Date(now).getTime()) out.push(date);
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
 * CMB-lane quote synthesized from one persisted accumulated-gold 5m bar. The
 * persisted CMB series records the customer BUY price; the customer sell side
 * is synthesized as buy − REPLAY_CMB_SPREAD_PER_GRAM, mirroring the live
 * market-center quote shape the plan engine consumes.
 */
export function synthCmbReplayQuote(price, atMs) {
  const buy = round2(price);
  const sell = round2(buy - REPLAY_CMB_SPREAD_PER_GRAM);
  return {
    price: buy,
    buyPrice: buy,
    sellPrice: sell,
    customerBuy: buy,
    customerSell: sell,
    source: "cmb",
    updatedAt: atMs,
    receivedAt: new Date(atMs).toISOString(),
    staleAfterMs: 15 * 60_000,
  };
}

/** Quote factory + wire identity for one replay universe. */
function laneProfile(lane) {
  if (lane === "cmb") {
    return {
      instrument: "CMB",
      quote: synthCmbReplayQuote,
      caveats: ["lane-cmb-persisted-bars"],
    };
  }
  return {
    instrument: "Au99.99",
    quote: synthReplayQuote,
    caveats: ["lane-au9999-only"],
  };
}

/**
 * Point-in-time slice of a LOCAL persisted series for one replay day: every
 * bar whose session date is ≤ the day being replayed (warm-up tails included,
 * future days excluded). The live arrays are rolling windows, so depth is
 * bounded — callers surface missing days as daysSkippedNoData.
 */
export function sliceCmbDaySeries(rawBars5, rawBars60, day, config) {
  const cfg = normalizeConfig(config);
  const pick = (list) => [...(Array.isArray(list) ? list : [])]
    .map((bar) => normalizeBarRecord(bar))
    .filter((bar) => bar !== null && sessionDateForTimestamp(bar.t, cfg) <= day)
    .filter((bar) => sessionDateForTimestamp(bar.t, cfg) === day
      || bar.t >= replaySessionBounds(day, cfg).openMs - 10 * 24 * 60 * 60_000);
  return { bars5: pick(rawBars5), bars60: pick(rawBars60) };
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

/** Continuous replay always starts from zero rather than the user's live lots. */
function continuousReplayConfig(config) {
  const base = normalizeConfig(config);
  return {
    ...base,
    position: { grams: 0, avgCostPerGram: 0, lots: [] },
  };
}

function emptyReplayPortfolio() {
  return { grams: 0, costBasisCny: 0, cashFlowCny: 0, realizedPnlCny: 0 };
}

function positionFromReplayPortfolio(portfolio, timestamp) {
  const grams = Math.max(0, Number(portfolio?.grams) || 0);
  const costBasisCny = Math.max(0, Number(portfolio?.costBasisCny) || 0);
  const avgCostPerGram = grams > 0 ? round2(costBasisCny / grams) : 0;
  return {
    grams,
    avgCostPerGram,
    lots: grams > 0 ? [{
      id: "replay-continuous-open",
      grams,
      price: avgCostPerGram,
      time: timestamp,
      status: "open",
    }] : [],
  };
}

function floorReplayGrams(value) {
  return Math.floor(Math.max(0, Number(value) || 0) * 100) / 100;
}

/**
 * Fill one suggested order into the continuous simulated account. Cash flow is
 * signed (buy < 0, sell > 0); cost basis includes buy fees and slippage so a
 * completed sale's realized P&L is directly comparable to the final net P&L.
 */
export function executeReplayTrade(portfolio, plan, config, fields = {}) {
  const cfg = normalizeConfig(config);
  const source = portfolio && typeof portfolio === "object" ? portfolio : emptyReplayPortfolio();
  const order = plan?.suggestedOrder;
  const side = order?.side === "sell" ? "sell" : order?.side === "buy" ? "buy" : null;
  const price = Number(order?.price);
  const requestedGrams = floorReplayGrams(order?.grams);
  if (side === null || !(price > 0) || requestedGrams <= 0) return { portfolio: source, trade: null };

  const beforeGrams = Math.max(0, Number(source.grams) || 0);
  const beforeCostBasis = Math.max(0, Number(source.costBasisCny) || 0);
  const beforeAvgCost = beforeGrams > 0 ? beforeCostBasis / beforeGrams : 0;
  const maxGrams = Math.max(0, Number(cfg.limits.maxGrams) || 0);
  const grams = side === "buy"
    ? floorReplayGrams(Math.min(requestedGrams, Math.max(0, maxGrams - beforeGrams)))
    : floorReplayGrams(Math.min(requestedGrams, beforeGrams));
  if (grams <= 0) return { portfolio: source, trade: null };

  const ledger = accountExecution({
    side,
    grams,
    fillPrice: price,
    quote: side === "buy" ? { ask: price } : { bid: price },
  }, cfg);
  if (!ledger.ok) return { portfolio: source, trade: null };
  const feeCny = round2(ledger.feeCny + ledger.slippageCny); // compatibility total
  const grossCny = ledger.grossCny;
  const cashFlowCny = ledger.cashFlowCny;
  const next = { ...source };
  let realizedPnlCny = null;
  if (side === "buy") {
    next.grams = round2(beforeGrams + grams);
    next.costBasisCny = round2(beforeCostBasis + grossCny + feeCny);
  } else {
    const releasedCost = round2(beforeAvgCost * grams);
    next.grams = round2(Math.max(0, beforeGrams - grams));
    next.costBasisCny = next.grams > 0 ? round2(Math.max(0, beforeCostBasis - releasedCost)) : 0;
    realizedPnlCny = round2(cashFlowCny - releasedCost);
    next.realizedPnlCny = round2((Number(source.realizedPnlCny) || 0) + realizedPnlCny);
  }
  next.cashFlowCny = round2((Number(source.cashFlowCny) || 0) + cashFlowCny);
  const afterAvgCost = next.grams > 0 ? round2(next.costBasisCny / next.grams) : 0;
  return {
    portfolio: next,
    trade: {
      kind: "trade",
      t: fields.t,
      day: fields.day,
      action: plan.action,
      side,
      price: round2(price),
      grams,
      grossCny,
      feeCny,
      explicitFeeCny: ledger.feeCny,
      slippageCny: ledger.slippageCny,
      cashFlowCny,
      realizedPnlCny,
      executionVersion: ledger.executionVersion,
      synthetic: fields.synthetic === true,
      quoteQuality: fields.quoteQuality ?? null,
      costComponents: ledger.components,
      positionBeforeGrams: round2(beforeGrams),
      positionAfterGrams: next.grams,
      avgCostAfterCnyPerGram: afterAvgCost,
    },
  };
}

function summarizeContinuousPortfolio(portfolio, trades, lastMarkPrice, config, execution = {}) {
  const cfg = normalizeConfig(config);
  const grams = Math.max(0, Number(portfolio?.grams) || 0);
  const costBasisCny = Math.max(0, Number(portfolio?.costBasisCny) || 0);
  const cashFlowCny = Number(portfolio?.cashFlowCny) || 0;
  const realizedNetCny = Number(portfolio?.realizedPnlCny) || 0;
  const markPrice = Number(lastMarkPrice);
  const markQuote = Number.isFinite(markPrice) && markPrice > 0
    ? { bid: markPrice, synthetic: execution.realBidAsk === true ? false : true, quality: execution.realBidAsk === true ? "primary" : "proxy" }
    : null;
  const markPosition = positionFromReplayPortfolio(portfolio, null);
  const valuation = valuePosition(markPosition, markQuote, cfg);
  const endingLiquidationValueCny = valuation.available ? valuation.liquidationValueCny : (grams === 0 ? 0 : null);
  const unrealizedNetCny = endingLiquidationValueCny === null ? null : round2(endingLiquidationValueCny - costBasisCny);
  const totalNetCny = endingLiquidationValueCny === null ? null : round2(cashFlowCny + endingLiquidationValueCny);
  const exits = trades.filter((trade) => trade.side === "sell" && Number.isFinite(trade.realizedPnlCny));
  const entries = trades.filter((trade) => trade.side === "buy");
  const curve = Array.isArray(execution.equityCurve) ? execution.equityCurve.slice() : [];
  let maxDrawdownCny = null;
  let maxDrawdownPct = null;
  let drawdownDurationMs = 0;
  let drawdownStarted = null;
  let peakEquity = -Infinity;
  for (const point of curve) {
    if (Number.isFinite(point.equity)) {
      if (point.equity > peakEquity) {
        peakEquity = point.equity;
        drawdownStarted = null;
      }
      if (Number.isFinite(point.drawdown) && point.drawdown < 0) {
        if (drawdownStarted === null) drawdownStarted = Date.parse(point.t);
        const duration = Date.parse(point.t) - drawdownStarted;
        if (Number.isFinite(duration)) drawdownDurationMs = Math.max(drawdownDurationMs, duration);
        maxDrawdownCny = maxDrawdownCny === null ? point.drawdown : Math.min(maxDrawdownCny, point.drawdown);
        if (peakEquity > 0) {
          const pct = point.drawdown / peakEquity;
          maxDrawdownPct = maxDrawdownPct === null ? pct : Math.min(maxDrawdownPct, pct);
        }
      }
    }
  }
  const costBreakdown = trades.reduce((sum, trade) => ({
    buyFeeCny: round2(sum.buyFeeCny + (trade.side === "buy" ? Number(trade.explicitFeeCny ?? trade.feeCny ?? 0) : 0)),
    sellFeeCny: round2(sum.sellFeeCny + (trade.side === "sell" ? Number(trade.explicitFeeCny ?? trade.feeCny ?? 0) : 0)),
    slippageCny: round2(sum.slippageCny + Number(trade.slippageCny ?? 0)),
    grossBuyCny: round2(sum.grossBuyCny + (trade.side === "buy" ? Number(trade.grossCny) || 0 : 0)),
    grossSellCny: round2(sum.grossSellCny + (trade.side === "sell" ? Number(trade.grossCny) || 0 : 0)),
  }), { buyFeeCny: 0, sellFeeCny: 0, slippageCny: 0, grossBuyCny: 0, grossSellCny: 0 });
  const positiveRealized = exits.filter((trade) => trade.realizedPnlCny > 0).reduce((sum, trade) => sum + trade.realizedPnlCny, 0);
  const negativeRealized = exits.filter((trade) => trade.realizedPnlCny < 0).reduce((sum, trade) => sum + Math.abs(trade.realizedPnlCny), 0);
  return {
    accounting: "continuous-zero-position",
    startingGrams: 0,
    endingGrams: round2(grams),
    endingMarkPrice: Number.isFinite(markPrice) && markPrice > 0 ? round2(markPrice) : null,
    endingLiquidationValueCny,
    totalNetCny,
    realizedNetCny: round2(realizedNetCny),
    unrealizedNetCny,
    tradeCount: trades.length,
    entryTrades: entries.length,
    exitTrades: exits.length,
    winRate: rate(exits.filter((trade) => trade.realizedPnlCny > 0).length, exits.length),
    fillCount: Array.isArray(execution.fills) ? execution.fills.length : trades.length,
    maxDrawdownCny,
    maxDrawdownPct: maxDrawdownPct === null ? null : round2(maxDrawdownPct),
    drawdownDurationMs,
    equityCurve: curve,
    turnoverCny: round2(costBreakdown.grossBuyCny + costBreakdown.grossSellCny),
    profitFactor: negativeRealized > 0 ? round2(positiveRealized / negativeRealized) : positiveRealized > 0 ? null : null,
    costBreakdown,
    // Compatibility aliases for clients that only need counts.
    eventsWithOutcome: trades.length,
    entryEvents: entries.length,
    exitEvents: exits.length,
    avgNetPerGram: null,
    avgNetCnyPerEvent: trades.length > 0 && totalNetCny !== null ? round2(totalNetCny / trades.length) : null,
  };
}

/**
 * Forward outcome of one directional event over executable bid/ask paths.
 * With old one-sided bars the execution module supplies a clearly labelled
 * proxy path; callers can set `requireExecutableBid` to return unknown instead.
 * Same-bar target/stop touches are never ordered by JavaScript branch order.
 */
export function computeForwardOutcome(event, futureBars, config, sessionEndMs, options = {}) {
  const cfg = normalizeConfig(config);
  const isEntry = event.action === "buy_setup" || event.action === "add_position";
  const entry = Number(event.executionPrice ?? event.price);
  const buyCost = Number(cfg.fee.buyPerGram) + Number(cfg.strategy.slippagePerGram);
  const sellCost = Number(cfg.fee.sellPerGram) + Number(cfg.strategy.slippagePerGram);
  const costPerGram = buyCost + sellCost;
  const out = {
    entry: round2(entry),
    entryExecutionPrice: Number.isFinite(entry) ? round2(entry) : null,
    costPerGram: round2(costPerGram),
    costBreakdown: {
      buyFeePerGram: round2(cfg.fee.buyPerGram),
      sellFeePerGram: round2(cfg.fee.sellPerGram),
      buySlippagePerGram: round2(cfg.strategy.slippagePerGram),
      sellSlippagePerGram: round2(cfg.strategy.slippagePerGram),
    },
    executionQuality: "unknown",
    realBidAsk: false,
    mfe30m: null,
    mae30m: null,
    mfe60m: null,
    mae60m: null,
    postExitDrift60m: null,
    targetHit: null,
    stopHit: null,
    breakevenTouched: null,
    breakevenTouchQuality: "unknown",
    firstTouch: null,
    conservativeTouch: null,
    ambiguousBar: false,
    bestCaseNet: null,
    worstCaseNet: null,
    ambiguityImpactCny: null,
    sessionEndNet: null,
    sessionEndPrice: null,
    markToAsOfNet: null,
    markToAsOfPrice: null,
    sessionEndQuality: "unknown",
    horizonBars: 0,
  };
  if (!Number.isFinite(entry) || entry <= 0) return out;

  let maxHigh30 = -Infinity;
  let minLow30 = Infinity;
  let maxHigh60 = -Infinity;
  let minLow60 = Infinity;
  let close60 = null;
  let sessionLastBidClose = null;
  let targetHit = false;
  let stopHit = false;
  let breakevenTouched = false;
  let firstTouch = null;
  let conservativeTouch = null;
  let ambiguousBar = false;
  let counted = 0;
  let sawBid = false;
  let sawRealBidAsk = false;
  const target = Number.isFinite(Number(event.targetPrice)) ? Number(event.targetPrice) : null;
  const stop = Number.isFinite(Number(event.stopPrice)) ? Number(event.stopPrice) : null;
  const breakeven = Number.isFinite(Number(event.breakeven)) ? Number(event.breakeven) : null;
  const pathByTime = options.executionPath instanceof Map ? options.executionPath : null;
  const lane = options.lane ?? event.signalLane;
  const pathFor = (bar) => pathByTime?.get(Number(bar.t)) ?? resolveExecutionBar({
    bar,
    lane,
    cmbSpreadPerGram: options.cmbSpreadPerGram ?? REPLAY_CMB_SPREAD_PER_GRAM,
    buyOffset: options.buyOffset ?? cfg.cmb.buySpreadPerGram,
    sellOffset: options.sellOffset ?? cfg.cmb.sellSpreadPerGram,
  }, cfg);

  for (const rawBar of Array.isArray(futureBars) ? futureBars : []) {
    const bar = rawBar;
    if (!bar || !Number.isFinite(Number(bar.t))) continue;
    if (Number(bar.t) >= sessionEndMs) break;
    counted += 1;
    const path = pathFor(bar);
    const bidBar = path?.bidBar;
    if (!bidBar) continue;
    sawBid = true;
    if (path.realBidAsk === true) sawRealBidAsk = true;
    const age = Number(bar.t) + BAR5_SPAN_MS - Number(event.tMs);
    if (age > 0 && age <= HORIZON_30M_MS) {
      maxHigh30 = Math.max(maxHigh30, bidBar.h);
      minLow30 = Math.min(minLow30, bidBar.l);
    }
    if (age > 0 && age <= HORIZON_60M_MS) {
      maxHigh60 = Math.max(maxHigh60, bidBar.h);
      minLow60 = Math.min(minLow60, bidBar.l);
      close60 = bidBar.c;
    }
    if (isEntry) {
      const touchedTarget = target !== null && bidBar.h >= target;
      const touchedStop = stop !== null && bidBar.l <= stop;
      if (touchedTarget) targetHit = true;
      if (touchedStop) stopHit = true;
      if (touchedTarget && touchedStop) {
        ambiguousBar = true;
        if (firstTouch === null) {
          firstTouch = "ambiguous";
          conservativeTouch = "stop";
        }
      } else if (firstTouch === null) {
        if (touchedTarget) {
          firstTouch = "target";
          conservativeTouch = "target";
        } else if (touchedStop) {
          firstTouch = "stop";
          conservativeTouch = "stop";
        }
      }
      if (breakeven !== null && bidBar.h >= breakeven) breakevenTouched = true;
    }
    sessionLastBidClose = bidBar.c;
  }
  out.horizonBars = counted;
  out.executionQuality = sawBid ? (sawRealBidAsk ? "executable" : "proxy") : "unknown";
  out.realBidAsk = sawRealBidAsk;
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
    out.targetHit = target === null || !sawBid ? null : targetHit;
    out.stopHit = stop === null || !sawBid ? null : stopHit;
    out.breakevenTouched = breakeven === null || !sawBid ? null : breakevenTouched;
    out.breakevenTouchQuality = sawBid ? (sawRealBidAsk ? "executable" : "proxy") : "unknown";
    out.firstTouch = firstTouch;
    out.conservativeTouch = conservativeTouch;
    out.ambiguousBar = ambiguousBar;
    if (ambiguousBar && target !== null && stop !== null) {
      const best = target - entry - costPerGram;
      const worst = stop - entry - costPerGram;
      out.bestCaseNet = round2(best);
      out.worstCaseNet = round2(worst);
      out.ambiguityImpactCny = round2((best - worst) * Math.max(0, Number(event.grams) || 0));
    }
    if (sessionLastBidClose !== null) {
      out.markToAsOfPrice = round2(sessionLastBidClose);
      const buy = accountExecution({ side: "buy", grams: 1, fillPrice: entry, quote: { ask: entry } }, cfg);
      const sell = accountExecution({ side: "sell", grams: 1, fillPrice: sessionLastBidClose, quote: { bid: sessionLastBidClose } }, cfg);
      out.markToAsOfNet = buy.ok && sell.ok ? round2(buy.cashFlowCny + sell.cashFlowCny) : null;
      const complete = options.sessionComplete !== false;
      out.sessionEndQuality = complete ? out.executionQuality : "partial-asof";
      if (complete) {
        out.sessionEndPrice = out.markToAsOfPrice;
        out.sessionEndNet = out.markToAsOfNet;
      }
    }
  } else {
    out.postExitDrift60m = close60 === null ? null : round2(close60 - entry);
    if (sessionLastBidClose !== null) {
      out.markToAsOfPrice = round2(sessionLastBidClose);
      out.markToAsOfNet = round2(entry - sessionLastBidClose - costPerGram);
      out.sessionEndQuality = options.sessionComplete === false ? "partial-asof" : out.executionQuality;
      if (options.sessionComplete !== false) {
        out.sessionEndPrice = out.markToAsOfPrice;
        out.sessionEndNet = out.markToAsOfNet;
      }
    }
  }
  if (options.requireExecutableBid === true && !sawRealBidAsk) {
    out.executionQuality = "unknown";
    out.targetHit = null;
    out.stopHit = null;
    out.breakevenTouched = null;
    out.breakevenTouchQuality = "unknown";
    out.mfe30m = null;
    out.mae30m = null;
    out.mfe60m = null;
    out.mae60m = null;
    out.postExitDrift60m = null;
    out.sessionEndNet = null;
    out.sessionEndPrice = null;
    out.markToAsOfNet = null;
    out.markToAsOfPrice = null;
    out.sessionEndQuality = "unknown";
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

function nonNegativeInteger(value) {
  const number = Number(value);
  return Number.isFinite(number) ? Math.max(0, Math.floor(number)) : 0;
}

function validationRequirementsView() {
  return {
    ...REPLAY_VALIDATION_REQUIREMENTS,
    walkForward: { ...REPLAY_VALIDATION_REQUIREMENTS.walkForward },
  };
}

/** Report-level cost assumptions; this never replaces the execution ledger. */
function buildReplayCostAssumptions(params, lane) {
  const config = normalizeConfig(params);
  return {
    accountingModel: EXECUTION_MODEL_VERSION,
    explicitFeePerGram: {
      buy: round2(Number(config.fee.buyPerGram) || 0),
      sell: round2(Number(config.fee.sellPerGram) || 0),
    },
    slippagePerGram: {
      buy: round2(Number(config.strategy.slippagePerGram) || 0),
      sell: round2(Number(config.strategy.slippagePerGram) || 0),
    },
    configuredFallbackOffsetPerGram: {
      buy: round2(Number(config.cmb.buySpreadPerGram) || 0),
      sell: round2(Number(config.cmb.sellSpreadPerGram) || 0),
    },
    estimatedSpreadPerGram: round2(Number(config.strategy.estimatedSpreadPerGram) || 0),
    historicalCmbProxySpreadPerGram: lane === "cmb" ? REPLAY_CMB_SPREAD_PER_GRAM : null,
    sourceCode: "config-and-replay-policy",
    productAgreementVerified: false,
    realBidAskQuotedSpreadIncluded: true,
  };
}

/** Classify the execution-path evidence without inventing unavailable samples. */
function buildExecutionCoverage(diagnostics) {
  const rawBars = nonNegativeInteger(diagnostics?.bars);
  const realBidAskBars = Math.min(rawBars, nonNegativeInteger(diagnostics?.realBidAskBars));
  const proxyBars = Math.min(
    Math.max(0, rawBars - realBidAskBars),
    nonNegativeInteger(diagnostics?.syntheticBars),
  );
  const unknownBars = Math.max(0, rawBars - realBidAskBars - proxyBars);
  return {
    denominator: "continuous-replay-bars",
    bars: rawBars,
    realBidAskBars,
    proxyBars,
    unknownBars,
    realBidAskCoverage: rate(realBidAskBars, rawBars),
    proxyBidAskCoverage: rate(proxyBars, rawBars),
    unknownBidAskCoverage: rate(unknownBars, rawBars),
  };
}

/** Current replay is deliberately never promoted to a validation result. */
function buildValidationGate({ daysEvaluated, completeDays, partialDays, excludedDays, daysSkippedNoData, daysFailed, executionCoverage }) {
  const unmet = [
    "long_term_history_not_available",
    "no_oos_validation",
    "cost_semantics_unverified",
    "no_benchmark_comparison",
    "no_uncertainty_intervals",
  ];
  if (executionCoverage.realBidAskCoverage !== 1) unmet.push("proxy_or_unknown_execution");
  if (Number(partialDays) > 0 || Number(excludedDays) > 0 || Number(daysSkippedNoData) > 0 || Number(daysFailed) > 0) {
    unmet.push("incomplete_sessions");
  }
  return {
    status: "not_eligible",
    eligible: false,
    unmet,
    requirements: validationRequirementsView(),
    observed: {
      replayDays: Math.max(0, Number(daysEvaluated) || 0),
      completeDays: Math.max(0, Number(completeDays) || 0),
      partialDays: Math.max(0, Number(partialDays) || 0),
      excludedDays: Math.max(0, Number(excludedDays) || 0),
      daysSkippedNoData: Math.max(0, Number(daysSkippedNoData) || 0),
      daysFailed: Math.max(0, Number(daysFailed) || 0),
      longTermHistoryAvailable: false,
      oosFolds: 0,
    },
  };
}

function meanOf(values) {
  const finite = values.filter((value) => Number.isFinite(value));
  if (finite.length === 0) return null;
  return round2(finite.reduce((sum, value) => sum + value, 0) / finite.length);
}

/**
 * Independent-event aggregate retained for the per-action signal-quality
 * tables. It is deliberately not used as the account-level P&L.
 */
function aggregateSignalQuality(events) {
  const counted = events.filter((event) => event.outcome && Number.isFinite(event.outcome.sessionEndNet));
  const isEntry = (event) => event.action === "buy_setup" || event.action === "add_position";
  const entryCounted = counted.filter(isEntry);
  const exitCounted = counted.filter((event) => !isEntry(event));
  const totalNetCnyRaw = counted.reduce(
    (sum, event) => sum + event.outcome.sessionEndNet * Math.max(0, Number(event.grams) || 0),
    0,
  );
  return {
    eventsWithOutcome: counted.length,
    entryEvents: entryCounted.length,
    exitEvents: exitCounted.length,
    winRate: rate(counted.filter((event) => event.outcome.sessionEndNet > 0).length, counted.length),
    avgNetPerGram: meanOf(counted.map((event) => event.outcome.sessionEndNet)),
    totalNetCny: counted.length > 0 ? round2(totalNetCnyRaw) : null,
    avgNetCnyPerEvent: counted.length > 0 ? round2(totalNetCnyRaw / counted.length) : null,
  };
}

/**
 * Aggregate replay events + step counters into the wire report. Pure and
 * deterministic — the same inputs always produce the same JSON.
 */
export function aggregateReplayReport({
  events,
  continuous,
  steps,
  blockedSteps,
  daysRequested,
  daysEvaluated,
  daysFailed,
  failures = [],
  params,
  generatedAt,
  window,
  daysSkippedNoData = 0,
  completeDays = daysEvaluated,
  partialDays = 0,
  excludedDays = 0,
  sessionDiagnostics = [],
  reportId = null,
}) {
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
      filledCount: group.filter((event) => event.fillStatus === "filled").length,
      expiredCount: group.filter((event) => event.fillStatus === "expired").length,
      pendingCount: group.filter((event) => event.fillStatus === "pending").length,
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
      const score = Number(event.ruleScore ?? event.confidenceScore);
      return Number.isFinite(score) && score >= bucket.min && score <= bucket.max;
    });
    const withTarget = group.filter((event) => event.outcome && event.outcome.targetHit !== null);
    return {
      bucket: bucket.label,
      events: group.length,
      filledEvents: group.filter((event) => event.fillStatus === "filled").length,
      targetHitRate: rate(withTarget.filter((event) => event.outcome.targetHit === true).length, withTarget.length),
      avgMfe30m: meanOf(group.map((event) => event.outcome?.mfe30m)),
      sessionEndAvgNet: meanOf(group.map((event) => event.outcome?.sessionEndNet)),
    };
  }).filter((bucket) => bucket.events > 0);

  const lane = REPLAY_LANES.includes(params?.lane) ? params.lane : REPLAY_LANE_DEFAULT;
  const profile = laneProfile(lane);
  const orderList = Array.isArray(continuous?.orders) ? continuous.orders : [];
  const fillList = Array.isArray(continuous?.fills) ? continuous.fills : [];
  const pendingList = Array.isArray(continuous?.pendingOrders) ? continuous.pendingOrders : [];
  const unexecutedList = Array.isArray(continuous?.unexecutedSignals) ? continuous.unexecutedSignals : [];
  const unexecutedTotal = Number.isFinite(Number(continuous?.executionDiagnostics?.unexecutedSignals))
    ? Number(continuous.executionDiagnostics.unexecutedSignals)
    : unexecutedList.length;
  const signalAmbiguousBarCount = events.filter((event) => event.outcome?.ambiguousBar === true).length;
  const executionAmbiguousFillCount = fillList.filter((fill) => fill.ambiguousBar === true).length;
  const placed = orderList.length + pendingList.length;
  const filled = fillList.length;
  const expired = orderList.filter((order) => order.status === "expired").length;
  const averageDelayValues = fillList.map((fill) => Date.parse(fill.fillAt) - Date.parse(fill.eligibleAt)).filter(Number.isFinite);
  const diagnostics = continuous?.executionDiagnostics ?? {};
  const executionCoverage = buildExecutionCoverage(diagnostics);
  const realBidAskCoverage = executionCoverage.realBidAskCoverage;
  const costAssumptions = buildReplayCostAssumptions(params, lane);
  const validationGate = buildValidationGate({
    daysEvaluated,
    completeDays,
    partialDays,
    excludedDays,
    daysSkippedNoData,
    daysFailed,
    executionCoverage,
  });
  const caveats = [
    ...profile.caveats,
    "minute-coverage-from-5m",
    "synthetic-lane-sampling",
    "history-depth-limited",
    "continuous-zero-position",
    "next-bar-limit-fills",
    "conservative-ambiguous-bars",
    "complete-session-only",
    "two-simulated-passes",
    "past-performance-advisory",
  ];
  return {
    // `version` is the existing replay wire schema version; the other fields
    // freeze the identities that produced this particular diagnostic.
    version: REPLAY_STATS_VERSION,
    reportId,
    generatedAt: new Date(generatedAt).toISOString(),
    strategyId: REPLAY_STRATEGY_ID,
    strategyVersion: REPLAY_STRATEGY_VERSION,
    calculationVersion: CALCULATION_VERSION,
    dataSchemaVersion: REPLAY_DATA_SCHEMA_VERSION,
    executionVersion: EXECUTION_MODEL_VERSION,
    calendarVersion: REPLAY_CALENDAR_VERSION,
    evidenceStatus: REPLAY_EVIDENCE_STATUSES.EXPLORATORY,
    validationGate,
    lane,
    fillPolicy: REPLAY_FILL_POLICY,
    ambiguityPolicy: REPLAY_AMBIGUITY_POLICY,
    costAssumptions,
    executionCoverage,
    params: { ...params, lane },
    window,
    daysRequested,
    daysEvaluated,
    completeDays,
    partialDays,
    excludedDays,
    daysSkippedNoData,
    daysFailed,
    sessionDiagnostics: Array.isArray(sessionDiagnostics) ? sessionDiagnostics.slice() : [],
    totals: {
      steps,
      directionalEvents: events.length,
      unexecutedSignals: unexecutedTotal,
      blockedSteps,
      coverageBlockedRatio: rate(blockedSteps, steps),
    },
    orders: {
      placed,
      filled,
      expired,
      pending: pendingList.length,
      replaced: orderList.filter((order) => order.status === "replaced").length,
      ambiguous: executionAmbiguousFillCount,
    },
    fillRate: rate(filled, placed),
    expiryRate: rate(expired, placed),
    averageDelayMs: averageDelayValues.length > 0
      ? Math.round(averageDelayValues.reduce((sum, value) => sum + value, 0) / averageDelayValues.length)
      : null,
    signalAmbiguousBarCount,
    executionAmbiguousFillCount,
    ambiguousBarCount: signalAmbiguousBarCount, // compatibility alias
    realBidAskCoverage,
    // Continuous account P&L starts at zero grams; independent signal metrics
    // remain separate so they cannot be mistaken for a cumulative account.
    overall: summarizeContinuousPortfolio(
      continuous?.portfolio ?? emptyReplayPortfolio(),
      Array.isArray(continuous?.trades) ? continuous.trades : [],
      continuous?.lastMarkPrice,
      params,
      continuous,
    ),
    signalQuality: aggregateSignalQuality(events),
    perAction,
    ruleScoreBuckets: confidenceBuckets,
    confidenceBuckets, // v1.10 compatibility alias
    caveats,
    failures: failures.slice(),
  };
}

// ── per-day replay (pure over its inputs) ──────────────────────────────────

/**
 * Replay one trading day. `bars5All` / `bars60All` are the point-in-time
 * series for this day (including pre-day warm-up tail); stepping follows the
 * day's in-session 5m bars. `options.lane` picks the replay universe ("cmb" —
 * the persisted accumulated-gold series — or "au9999", the Eastmoney series).
 *
 * Each bar is evaluated twice — once per simulated pass — and each pass
 * carries ONE signal state across the whole day: confirmBars streaks,
 * same-direction cooldown and lane-instrument resets behave exactly like the
 * live tick loop, only reset at day boundaries (alert state machine absent).
 * Returns `{ steps, blockedSteps, events }`; steps/blockedSteps count every
 * pass evaluation, events carry their forward outcome.
 */
export function replayTradingDay(day, rawBars5All, rawBars60All, config, options = {}) {
  const cfgBase = normalizeConfig(config);
  const calendar = buildSessionCalendar(cfgBase);
  // A direct pure replay call has no external as-of clock, so treat the
  // configured close as its analysis instant. The engine passes its real clock
  // explicitly and can therefore classify the current session as partial.
  const requestedBounds = replaySessionBounds(day, cfgBase);
  const asOf = options.asOf === undefined ? new Date(requestedBounds.closeMs) : new Date(options.asOf);
  // Pure-function default stays "au9999"; the engine always resolves and
  // passes its lane explicitly (its default universe is "cmb").
  const profile = laneProfile(REPLAY_LANES.includes(options.lane) ? options.lane : "au9999");
  // Defensive sort: fetch adapters normally return ascending series already.
  const bars5All = [...(Array.isArray(rawBars5All) ? rawBars5All : [])].sort((a, b) => a.t - b.t);
  const bars60All = [...(Array.isArray(rawBars60All) ? rawBars60All : [])].sort((a, b) => a.t - b.t);
  const session = replaySessionStatus(day, bars5All, cfgBase, asOf);
  const inSession = (bar) => {
    if (!bar || !Number.isFinite(bar.t)) return false;
    return sessionDateForTimestamp(bar.t, cfgBase) === day && isOpenMinute(calendar, bar.t);
  };
  const minuteBars = expandBarsToMinuteBars(bars5All).map((bar) =>
    profile.instrument === "CMB" ? { ...bar, source: "replay-coverage-cmb", instrument: "CMB_ACCUMULATED_GOLD", market: "bank", currency: "CNY", unit: "gram" } : bar,
  );
  const dayBars5 = bars5All.filter(inSession);
  const events = [];
  let steps = 0;
  let blockedSteps = 0;
  if (dayBars5.length === 0) return {
    steps,
    blockedSteps,
    events,
    sessionStatus: session.status,
    sessionEnd: session.close,
    asOf: session.asOf,
  };

  const dayOpenPrice = dayBars5[0].c;
  const passConfigs = {
    flat: statsPassConfig(cfgBase, "flat", dayOpenPrice),
    hold: statsPassConfig(cfgBase, "hold", dayOpenPrice),
  };
  // Always use the configured session close. An observed tail shorter than
  // that close is partial and must never be labelled as a session-end result.
  const sessionEndMs = session.closeMs;

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
    // The signal lane's series feeds both quotes and indicator history; the
    // other lanes stay empty so availability resolves to exactly this lane.
    const feedKey = profile.instrument === "CMB" ? "CMB" : "AU9999";
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
      runtime.quotes[feedKey] = replayQuoteForBar(bar, profile, stepNowMs, passConfig);
      runtime.bars[feedKey][1] = minuteBars.slice(Math.max(0, cursorMinute - MAX_BARS), cursorMinute);
      runtime.bars[feedKey][5] = bars5All.slice(Math.max(0, cursor5 - MAX_BARS), cursor5);
      runtime.bars[feedKey][60] = bars60All.slice(Math.max(0, cursor60 - MAX_BARS), cursor60);

      const plan = computePlan(runtime, passConfig, new Date(stepNowMs));
      if (plan.signalState) runtime.signalState = plan.signalState;
      if (plan.action === "data_incomplete") blockedSteps += 1;
      if (!REPLAY_TRACKED_ACTIONS.includes(plan.action)) continue;
      const event = {
        day,
        // `t` is the signal instant (the closed bar's end), while `barT`
        // preserves the source bucket start for diagnostics.
        t: new Date(stepNowMs).toISOString(),
        tMs: stepNowMs,
        barT: new Date(bar.t).toISOString(),
        pass,
        action: plan.action,
        instrument: plan.instrument,
        signalLane: plan.signalLane,
        price: plan.signalPrice,
        limitPrice: Number.isFinite(Number(plan.suggestedOrder?.price))
          ? Number(plan.suggestedOrder.price)
          : null,
        // Nominal size the pass would have traded (flat-pass budget / hold-pass
        // position) — turns per-gram nets into CNY sums in the overall block.
        grams: Number.isFinite(Number(plan.grams)) ? Math.max(0, Number(plan.grams)) : 0,
        ruleScore: plan.ruleScore ?? plan.confidenceScore,
        confidenceScore: plan.confidenceScore,
        targetPrice: plan.targetPrice,
        stopPrice: plan.stopPrice,
        breakeven: plan.breakeven,
        executionVersion: plan.execution?.executionVersion ?? EXECUTION_MODEL_VERSION,
      };
      const futureBars = bars5All.slice(cursor5).filter((futureBar) =>
        Number(futureBar?.t) + BAR5_SPAN_MS <= asOf.getTime()
      );
      const simulated = simulateReplayEventOrder(event, plan.suggestedOrder, futureBars, passConfig, {
        lane: profile.instrument === "CMB" ? "cmb" : "au9999",
        sessionEndMs,
        asOfMs: asOf.getTime(),
        sessionComplete: session.status === "complete",
        requireExecutableBid: options.requireExecutableBid === true,
      });
      event.fillStatus = simulated.status;
      event.fill = simulated.fill;
      event.executionPrice = simulated.fill?.fillPrice ?? null;
      event.outcome = simulated.outcome;
      events.push(event);
    }
  }
  return {
    steps,
    blockedSteps,
    events,
    sessionStatus: session.status,
    sessionEnd: session.close,
    asOf: session.asOf,
  };
}

/** Build a synthetic or persisted executable path for one replay bar. */
function replayExecutionPath(bar, profile, config) {
  return resolveExecutionBar({
    bar,
    lane: profile.instrument === "CMB" ? "cmb" : "au9999",
    cmbSpreadPerGram: profile.instrument === "CMB" ? REPLAY_CMB_SPREAD_PER_GRAM : undefined,
    buyOffset: config.cmb.buySpreadPerGram,
    sellOffset: config.cmb.sellSpreadPerGram,
  }, config);
}

function replayQuoteForBar(bar, profile, atMs, config) {
  if (profile.instrument !== "CMB") return profile.quote(bar.c, atMs);
  const path = replayExecutionPath(bar, profile, config);
  if (!path.available || !path.askBar || !path.bidBar) return profile.quote(bar.c, atMs);
  const ask = round2(path.askBar.c);
  const bid = round2(path.bidBar.c);
  return {
    price: ask,
    buyPrice: ask,
    sellPrice: bid,
    customerBuy: ask,
    customerSell: bid,
    source: path.source ?? "cmb-replay",
    synthetic: path.synthetic === true,
    quality: path.realBidAsk === true ? "primary" : "degraded",
    updatedAt: atMs,
    receivedAt: new Date(atMs).toISOString(),
    staleAfterMs: 15 * 60_000,
  };
}

export function simulateReplayEventOrder(event, suggestedOrder, futureBars, config, options = {}) {
  const cfg = normalizeConfig(config);
  const signalAtMs = Number(event?.tMs);
  const limitPrice = Number(suggestedOrder?.price ?? suggestedOrder?.cmbEstimatedPrice);
  if (!suggestedOrder || !Number.isFinite(signalAtMs) || !(limitPrice > 0)) {
    return { status: "no_order", fill: null, outcome: null };
  }
  const sessionEndMs = Number(options.sessionEndMs);
  const validUntilMs = Math.min(
    sessionEndMs,
    Number.isFinite(Date.parse(suggestedOrder.validUntil ?? ""))
      ? Date.parse(suggestedOrder.validUntil)
      : sessionEndMs,
  );
  const pending = {
    side: suggestedOrder.side,
    limitPrice,
    eligibleAtMs: signalAtMs + BAR5_SPAN_MS,
    validUntilMs,
  };
  const profile = laneProfile(String(options.lane).toLowerCase() === "cmb" ? "cmb" : "au9999");
  const asOfMs = Number.isFinite(Number(options.asOfMs)) ? Number(options.asOfMs) : sessionEndMs;
  const bars = (Array.isArray(futureBars) ? futureBars : []).filter((bar) =>
    bar && Number.isFinite(Number(bar.t)) && Number(bar.t) + BAR5_SPAN_MS <= asOfMs
  );
  for (let index = 0; index < bars.length; index += 1) {
    const bar = bars[index];
    const barCloseMs = Number(bar.t) + BAR5_SPAN_MS;
    const path = replayExecutionPath(bar, profile, cfg);
    const match = evaluateReplayLimitOrder(pending, path, barCloseMs, sessionEndMs);
    if (match.status === "filled") {
      const filledEvent = {
        ...event,
        executionPrice: match.fillPrice,
        tMs: barCloseMs,
        fillAt: new Date(barCloseMs).toISOString(),
        fillStatus: "filled",
        fillQuality: path.quality ?? null,
        realBidAsk: path.realBidAsk === true,
      };
      return {
        status: "filled",
        fill: {
          fillAt: filledEvent.fillAt,
          fillPrice: round2(match.fillPrice),
          synthetic: path.synthetic === true,
          quality: path.quality ?? null,
          realBidAsk: path.realBidAsk === true,
        },
        outcome: computeForwardOutcome(filledEvent, bars.slice(index + 1), cfg, sessionEndMs, {
          lane: options.lane,
          sessionComplete: options.sessionComplete !== false,
          requireExecutableBid: options.requireExecutableBid === true,
        }),
      };
    }
    if (match.status === "expired") return { status: "expired", fill: null, outcome: null };
  }
  const expired = options.sessionComplete !== false || asOfMs >= validUntilMs;
  return { status: expired ? "expired" : "pending", fill: null, outcome: null };
}

function replayOrderFromPlan(plan, day, signalAtMs, sessionCloseMs, sequence, currentGrams = 0, reservedSellGrams = 0, maxGrams = 0) {
  const source = plan?.suggestedOrder;
  if (!source || (source.side !== "buy" && source.side !== "sell")) return null;
  const requested = floorReplayGrams(source.grams);
  const limitPrice = Number(source.price ?? source.cmbEstimatedPrice);
  if (requested <= 0 || !(limitPrice > 0)) return null;
  const available = source.side === "buy"
    ? Math.max(0, maxGrams - currentGrams)
    : Math.max(0, currentGrams - reservedSellGrams);
  const grams = floorReplayGrams(Math.min(requested, available));
  if (grams <= 0) return null;
  const validUntilMs = Math.min(
    sessionCloseMs,
    Number.isFinite(Date.parse(source.validUntil ?? "")) ? Date.parse(source.validUntil) : sessionCloseMs,
  );
  return {
    orderId: `replay-order-${sequence}`,
    day,
    action: source.action ?? plan.action,
    instrument: source.instrument ?? plan.instrument,
    side: source.side,
    limitPrice: round2(limitPrice),
    grams,
    remaining: grams,
    signalAt: new Date(signalAtMs).toISOString(),
    eligibleAt: new Date(signalAtMs + BAR5_SPAN_MS).toISOString(),
    eligibleAtMs: signalAtMs + BAR5_SPAN_MS,
    validUntil: new Date(validUntilMs).toISOString(),
    validUntilMs,
    status: signalAtMs + BAR5_SPAN_MS <= validUntilMs ? "pending" : "expired",
    synthetic: plan.execution?.synthetic === true,
    quoteQuality: plan.execution?.quality ?? null,
    reasonCodes: Array.isArray(source.reasonCodes) ? source.reasonCodes.slice() : [],
  };
}

function makeUnexecutedSignal(plan, day, signalAtMs, bar, currentGrams, maxGrams, reasonCode) {
  const signalPrice = Number(plan?.unexecutedSignal?.signalPrice);
  const limitPrice = Number(plan?.unexecutedSignal?.limitPrice);
  const before = Math.max(0, Number(currentGrams) || 0);
  const limit = Math.max(0, Number(maxGrams) || 0);
  return {
    kind: "unexecuted-signal",
    day,
    signalAt: new Date(signalAtMs).toISOString(),
    barT: Number.isFinite(Number(bar?.t)) ? new Date(Number(bar.t)).toISOString() : null,
    action: plan?.unexecutedSignal?.action ?? "add_position",
    instrument: plan?.instrument ?? null,
    signalLane: plan?.signalLane ?? null,
    side: "buy",
    signalPrice: Number.isFinite(signalPrice) && signalPrice > 0 ? round2(signalPrice) : null,
    limitPrice: Number.isFinite(limitPrice) && limitPrice > 0 ? round2(limitPrice) : null,
    requestedGrams: null,
    positionBeforeGrams: round2(before),
    maxGrams: round2(limit),
    availableGrams: round2(Math.max(0, limit - before)),
    status: "not_executed",
    reasonCode,
    reasonCodes: Array.isArray(plan?.reasonCodes) ? plan.reasonCodes.slice() : [reasonCode],
    ruleScore: plan?.ruleScore ?? plan?.confidenceScore ?? null,
    confidenceScore: plan?.confidenceScore ?? null,
  };
}

function sameReplayOrder(left, right) {
  return left && right && left.side === right.side
    && left.action === right.action
    && left.limitPrice === right.limitPrice
    && left.grams === right.grams;
}

/** Evaluate one pending limit order against one completed replay bar. */
export function evaluateReplayLimitOrder(order, path, barCloseMs, sessionCloseMs = Infinity) {
  const atMs = Number(barCloseMs);
  if (!order || !Number.isFinite(atMs)) return { status: "invalid", touched: false };
  if (atMs < Number(order.eligibleAtMs)) return { status: "pending", touched: false, reason: "not_eligible" };
  if (atMs > Number(order.validUntilMs) || atMs > Number(sessionCloseMs)) {
    return { status: "expired", touched: false, reason: "validity_ended" };
  }
  const executable = order.side === "buy" ? path?.askBar : path?.bidBar;
  if (!executable) return { status: "pending", touched: false, reason: "execution_path_missing" };
  const touched = order.side === "buy"
    ? Number(executable.l) <= Number(order.limitPrice)
    : Number(executable.h) >= Number(order.limitPrice);
  if (!touched) return { status: "pending", touched: false, reason: "limit_not_touched" };
  const open = Number(executable.o);
  const limit = Number(order.limitPrice);
  const fillPrice = order.side === "buy" && open <= limit
    ? open
    : order.side === "sell" && open >= limit
      ? open
      : limit;
  return { status: "filled", touched: true, fillPrice: round2(fillPrice) };
}

export function applyReplayFill(portfolio, order, path, fillAtMs, config, matchedFillPrice = null) {
  const source = portfolio && typeof portfolio === "object" ? portfolio : emptyReplayPortfolio();
  const beforeGrams = Math.max(0, Number(source.grams) || 0);
  const beforeCostBasis = Math.max(0, Number(source.costBasisCny) || 0);
  const beforeAvgCost = beforeGrams > 0 ? beforeCostBasis / beforeGrams : 0;
  const requestedGrams = floorReplayGrams(order.remaining);
  const maxGrams = Math.max(0, Number(config?.limits?.maxGrams) || 0);
  const grams = order.side === "sell"
    ? floorReplayGrams(Math.min(requestedGrams, beforeGrams))
    : floorReplayGrams(Math.min(requestedGrams, Math.max(0, maxGrams - beforeGrams)));
  if (grams <= 0) return { portfolio: source, fill: null };
  const executable = order.side === "buy" ? path?.askBar : path?.bidBar;
  const fillPrice = Number.isFinite(Number(matchedFillPrice)) ? Number(matchedFillPrice) : order.limitPrice;
  if (!executable || !(fillPrice > 0)) return { portfolio: source, fill: null };
  const quote = {
    ask: order.side === "buy" ? fillPrice : executable.c,
    bid: order.side === "sell" ? fillPrice : executable.c,
    synthetic: path.synthetic === true,
    quality: path.quality,
    spreadPerGram: Number.isFinite(Number(executable.c)) ? round2(Math.abs(Number(executable.c) - fillPrice)) : null,
  };
  const ledger = accountExecution({ side: order.side, grams, fillPrice, quote }, config);
  if (!ledger.ok) return { portfolio: source, fill: null };
  const next = { ...source };
  let realizedPnlCny = null;
  if (order.side === "buy") {
    next.grams = round2(beforeGrams + grams);
    next.costBasisCny = round2(beforeCostBasis - 0 + ledger.grossCny + ledger.feeCny + ledger.slippageCny);
  } else {
    const releasedCost = round2(beforeAvgCost * grams);
    next.grams = round2(Math.max(0, beforeGrams - grams));
    next.costBasisCny = next.grams > 0 ? round2(Math.max(0, beforeCostBasis - releasedCost)) : 0;
    realizedPnlCny = round2(ledger.cashFlowCny - releasedCost);
    next.realizedPnlCny = round2((Number(source.realizedPnlCny) || 0) + realizedPnlCny);
  }
  next.cashFlowCny = round2((Number(source.cashFlowCny) || 0) + ledger.cashFlowCny);
  return {
    portfolio: next,
    fill: {
      kind: "fill",
      orderId: order.orderId,
      action: order.action,
      side: order.side,
      day: order.day,
      signalAt: order.signalAt,
      eligibleAt: order.eligibleAt,
      fillAt: new Date(fillAtMs).toISOString(),
      status: "filled",
      price: round2(fillPrice),
      fillPrice: round2(fillPrice),
      grams,
      grossCny: ledger.grossCny,
      feeCny: round2(ledger.feeCny + ledger.slippageCny),
      explicitFeeCny: ledger.feeCny,
      slippageCny: ledger.slippageCny,
      cashFlowCny: ledger.cashFlowCny,
      realizedPnlCny,
      positionBeforeGrams: round2(beforeGrams),
      positionAfterGrams: next.grams,
      avgCostAfterCnyPerGram: next.grams > 0 ? round2(next.costBasisCny / next.grams) : 0,
      bid: path.bidBar?.c ?? null,
      ask: path.askBar?.c ?? null,
      quoteSource: path.source ?? null,
      quoteQuality: path.quality ?? null,
      synthetic: path.synthetic === true,
      ambiguousBar: false,
      executionVersion: ledger.executionVersion,
      costComponents: ledger.components,
    },
  };
}

function markReplayEquity(account, bid, timestamp, config) {
  const numericBid = Number(bid);
  if (!(numericBid > 0)) return;
  const position = positionFromReplayPortfolio(account.portfolio, timestamp);
  const valuation = valuePosition(position, { bid: numericBid, synthetic: true, quality: "proxy" }, config);
  const equity = valuation.available
    ? round2((Number(account.portfolio.cashFlowCny) || 0) + valuation.liquidationValueCny)
    : null;
  if (!Array.isArray(account.equityCurve)) account.equityCurve = [];
  account.equityCurve.push({
    t: timestamp,
    equity,
    grams: position.grams,
    markBid: round2(numericBid),
    drawdown: null,
  });
  let peak = -Infinity;
  for (const point of account.equityCurve) {
    if (Number.isFinite(point.equity)) peak = Math.max(peak, point.equity);
    if (Number.isFinite(point.equity) && Number.isFinite(peak)) point.drawdown = round2(point.equity - peak);
  }
}

/**
 * Replay one day into a single account with an explicit pending-order
 * lifecycle. The default fill is the next eligible 5m bar touching a limit;
 * no signal is treated as an immediate fill.
 */
export function replayContinuousTradingDay(day, rawBars5All, rawBars60All, config, state, options = {}) {
  const cfgBase = continuousReplayConfig(config);
  const profile = laneProfile(REPLAY_LANES.includes(options.lane) ? options.lane : "au9999");
  const calendar = buildSessionCalendar(cfgBase);
  const bars5All = [...(Array.isArray(rawBars5All) ? rawBars5All : [])].sort((a, b) => a.t - b.t);
  const bars60All = [...(Array.isArray(rawBars60All) ? rawBars60All : [])].sort((a, b) => a.t - b.t);
  const bounds = replaySessionBounds(day, cfgBase);
  const asOfMs = options.asOf === undefined ? bounds.closeMs : new Date(options.asOf).getTime();
  const session = replaySessionStatus(day, bars5All, cfgBase, new Date(asOfMs));
  const dayBars5 = bars5All.filter((bar) => bar && Number.isFinite(bar.t)
    && sessionDateForTimestamp(bar.t, cfgBase) === day
    && isOpenMinute(calendar, bar.t)
    && bar.t + BAR5_SPAN_MS <= asOfMs
    && bar.t < bounds.closeMs);
  const minuteBars = expandBarsToMinuteBars(bars5All).map((bar) =>
    profile.instrument === "CMB" ? { ...bar, source: "replay-coverage-cmb", instrument: "CMB_ACCUMULATED_GOLD", market: "bank", currency: "CNY", unit: "gram" } : bar,
  );
  const account = state && typeof state === "object" ? state : {};
  if (!account.portfolio) account.portfolio = emptyReplayPortfolio();
  if (!account.signalState) account.signalState = defaultSignalState();
  if (!Array.isArray(account.trades)) account.trades = [];
  if (!Array.isArray(account.orders)) account.orders = [];
  if (!Array.isArray(account.fills)) account.fills = [];
  if (!Array.isArray(account.pendingOrders)) account.pendingOrders = [];
  if (!Array.isArray(account.unexecutedSignals)) account.unexecutedSignals = [];
  if (!account.executionDiagnostics || typeof account.executionDiagnostics !== "object") {
    account.executionDiagnostics = { bars: 0, realBidAskBars: 0, syntheticBars: 0, ambiguousBars: 0, unexecutedSignals: 0 };
  }
  if (!Number.isFinite(Number(account.executionDiagnostics.unexecutedSignals))) {
    account.executionDiagnostics.unexecutedSignals = account.unexecutedSignals.length;
  }
  let steps = 0;
  let blockedSteps = 0;
  const trades = [];
  if (dayBars5.length === 0) return {
    steps,
    blockedSteps,
    trades,
    orders: [],
    fills: [],
    pendingOrders: account.pendingOrders.slice(),
    unexecutedSignals: account.unexecutedSignals.slice(),
    sessionStatus: session.status,
    sessionEnd: session.close,
    asOf: session.asOf,
  };

  const runtime = {
    quotes: { AU9999: null, XAU: null, GCF: null, USDCNY: null, CMB: null },
    bars: {
      AU9999: { 1: [], 5: [], 60: [] },
      XAU: { 1: [], 5: [], 60: [] },
      GCF: { 1: [], 5: [], 60: [] },
      CMB: { 1: [], 5: [], 60: [] },
    },
    signalState: account.signalState,
    positionCostBasisIncludesEntryCosts: true,
    captureUnexecutedSignals: true,
  };
  const feedKey = profile.instrument === "CMB" ? "CMB" : "AU9999";
  let cursor5 = 0;
  let cursor60 = 0;
  let cursorMinute = 0;
  let sequence = Number(account.nextOrderSequence) || 1;
  for (const bar of dayBars5) {
    const stepNowMs = bar.t + BAR5_SPAN_MS;
    while (cursor5 < bars5All.length && bars5All[cursor5].t < stepNowMs) cursor5 += 1;
    while (cursor60 < bars60All.length && Number.isFinite(bars60All[cursor60]?.t) && bars60All[cursor60].t + 60 * MINUTE_MS <= stepNowMs) cursor60 += 1;
    while (cursorMinute < minuteBars.length && minuteBars[cursorMinute].t <= stepNowMs) cursorMinute += 1;
    steps += 1;
    const path = replayExecutionPath(bar, profile, cfgBase);
    account.executionDiagnostics.bars += 1;
    if (path.realBidAsk === true) account.executionDiagnostics.realBidAskBars += 1;
    if (path.synthetic === true && path.available === true) account.executionDiagnostics.syntheticBars += 1;
    runtime.quotes[feedKey] = replayQuoteForBar(bar, profile, stepNowMs, cfgBase);
    runtime.bars[feedKey][1] = minuteBars.slice(Math.max(0, cursorMinute - MAX_BARS), cursorMinute);
    runtime.bars[feedKey][5] = bars5All.slice(Math.max(0, cursor5 - MAX_BARS), cursor5);
    runtime.bars[feedKey][60] = bars60All.slice(Math.max(0, cursor60 - MAX_BARS), cursor60);

    // Existing orders are tested against this bar first. An order created by
    // this same step is therefore never filled by its signal bar.
    const stillPending = [];
    for (const order of account.pendingOrders) {
      const match = evaluateReplayLimitOrder(order, path, stepNowMs, bounds.closeMs);
      if (match.status === "filled") {
        const applied = applyReplayFill(account.portfolio, order, path, stepNowMs, cfgBase, match.fillPrice);
        if (applied.fill) {
          account.portfolio = applied.portfolio;
          order.status = "filled";
          order.fillAt = applied.fill.fillAt;
          account.fills.push(applied.fill);
          account.orders.push({ ...order });
          account.trades.push({
            ...applied.fill,
            kind: "trade",
            t: applied.fill.fillAt,
            price: applied.fill.fillPrice,
          });
          trades.push(account.trades[account.trades.length - 1]);
          continue;
        }
      }
      if (match.status === "expired") {
        order.status = "expired";
        order.expiredAt = new Date(stepNowMs).toISOString();
        account.orders.push(order);
        continue;
      }
      stillPending.push(order);
    }
    account.pendingOrders = stillPending;

    const timestamp = new Date(stepNowMs).toISOString();
    const stepConfig = {
      ...cfgBase,
      position: positionFromReplayPortfolio(account.portfolio, timestamp),
    };
    const plan = computePlan(runtime, stepConfig, new Date(stepNowMs));
    if (plan.signalState) runtime.signalState = plan.signalState;
    if (plan.action === "data_incomplete") blockedSteps += 1;
    if (plan.unexecutedSignal?.reasonCode === "position_limit") {
      account.executionDiagnostics.unexecutedSignals += 1;
      account.unexecutedSignals.push(makeUnexecutedSignal(
        plan,
        day,
        stepNowMs,
        bar,
        account.portfolio.grams,
        cfgBase.limits.maxGrams,
        plan.unexecutedSignal.reasonCode,
      ));
      if (account.unexecutedSignals.length > REPLAY_UNEXECUTED_SIGNAL_CAP) {
        account.unexecutedSignals.splice(0, account.unexecutedSignals.length - REPLAY_UNEXECUTED_SIGNAL_CAP);
      }
    }
    const markBid = path.bidBar?.c ?? Number(plan.cmbEstimatedPrice);
    if (Number.isFinite(Number(markBid)) && Number(markBid) > 0) {
      account.lastMarkPrice = Number(markBid);
      markReplayEquity(account, Number(markBid), timestamp, cfgBase);
    }
    if (!REPLAY_TRACKED_ACTIONS.includes(plan.action) || !plan.suggestedOrder) continue;
    const order = replayOrderFromPlan(
      plan,
      day,
      stepNowMs,
      bounds.closeMs,
      sequence,
      account.portfolio.grams,
      0,
      cfgBase.limits.maxGrams,
    );
    if (!order) continue;
    sequence += 1;
    const duplicate = account.pendingOrders.find((candidate) => sameReplayOrder(candidate, order));
    if (duplicate) {
      duplicate.lastSeenAt = timestamp;
      duplicate.validUntilMs = Math.max(duplicate.validUntilMs, order.validUntilMs);
      duplicate.validUntil = new Date(duplicate.validUntilMs).toISOString();
      continue;
    }
    // A replacement on the same side supersedes a stale limit and is recorded
    // as an expired order, never as a second simultaneous reservation.
    const replacements = account.pendingOrders.filter((candidate) => candidate.side === order.side);
    for (const replacement of replacements) {
      replacement.status = "replaced";
      replacement.replacedAt = timestamp;
      account.orders.push(replacement);
    }
    account.pendingOrders = account.pendingOrders.filter((candidate) => candidate.side !== order.side);
    if (order.status === "expired") {
      account.orders.push(order);
    } else {
      account.pendingOrders.push(order);
    }
  }
  // Complete sessions expire unfilled orders at the configured close. A
  // partial/as-of session keeps them pending so the report cannot imply expiry.
  if (session.status === "complete") {
    for (const order of account.pendingOrders) {
      order.status = "expired";
      order.expiredAt = new Date(bounds.closeMs).toISOString();
      account.orders.push(order);
    }
    account.pendingOrders = [];
  }
  account.nextOrderSequence = sequence;
  account.signalState = runtime.signalState;
  return {
    steps,
    blockedSteps,
    trades,
    orders: account.orders,
    fills: account.fills,
    pendingOrders: account.pendingOrders.slice(),
    unexecutedSignals: account.unexecutedSignals.slice(),
    sessionStatus: session.status,
    sessionEnd: session.close,
    asOf: session.asOf,
  };
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
 * @param deps.getCmbBars       () => ({bars5, bars60}) | Promise of it — the
 *                              host's PERSISTED 招行积存金 series backing the
 *                              default "cmb" replay universe (no network).
 * @param deps.file             optional replay-stats.json path (persistence)
 * @param deps.writeQueue       makeWriteQueue() enqueue fn
 * @param deps.logger           host logger
 */
export function createReplayStats(deps) {
  const { getConfig, fetchKlines, getCmbBars = null, file = null, writeQueue = null, logger = null } = deps;
  // Point-in-time per-day fetch memo: one request per (secid, klt, day) for
  // the whole process lifetime — historical klines for a closed day never
  // change, so re-running a report never re-hits the source for fetched days.
  const dayFetchMemo = new Map();
  const runningByKey = new Map();
  let reportSequence = 0;
  let lastResult = null; // { params, generatedAtMs, report, events, trades, orders, fills, unexecutedSignals }

  async function resolveCmbSeries() {
    if (typeof getCmbBars !== "function") {
      throw new Error("CMB lane replay needs a getCmbBars provider");
    }
    const provided = await getCmbBars();
    const bars5 = Array.isArray(provided?.bars5) ? provided.bars5 : [];
    const bars60 = Array.isArray(provided?.bars60) ? provided.bars60 : [];
    return { bars5, bars60 };
  }

  async function fetchDayBars(lane, day, config) {
    if (lane === "cmb") {
      const series = await resolveCmbSeries();
      const { bars5, bars60 } = sliceCmbDaySeries(series.bars5, series.bars60, day, config);
      return { bars5, bars60 };
    }
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

  async function run({
    days = REPLAY_DAYS_DEFAULT,
    force = false,
    detail = false,
    signal = null,
    now = null,
    lane = REPLAY_LANE_DEFAULT,
    includePartial = false,
    requireExecutableBid = false,
  } = {}) {
    const requestedDays = Math.min(REPLAY_DAYS_MAX, Math.max(REPLAY_DAYS_MIN, Math.floor(Number(days) || REPLAY_DAYS_DEFAULT)));
    const requestedLane = REPLAY_LANES.includes(String(lane)) ? String(lane) : REPLAY_LANE_DEFAULT;
    const requestedNow = now instanceof Date ? new Date(now.getTime()) : new Date();
    const asOfKey = now instanceof Date ? requestedNow.toISOString() : "live";
    // Config-aware v5 cache key: reports are computed under the live
    // strategy/fee parameters, so changing any of them must invalidate the
    // same-(window,lane) cached report instead of serving stale numbers for
    // up to an hour. Position is excluded on purpose — both simulated passes
    // synthesize their own position regardless of the live one.
    const configNow = normalizeConfig(getConfig());
    const configFingerprint = JSON.stringify({
      fee: configNow.fee,
      cmb: configNow.cmb,
      limits: { maxGrams: configNow.limits.maxGrams },
      strategy: configNow.strategy,
      tradingHours: configNow.tradingHours,
      strategyId: REPLAY_STRATEGY_ID,
      strategyVersion: REPLAY_STRATEGY_VERSION,
      dataSchemaVersion: REPLAY_DATA_SCHEMA_VERSION,
      calendarVersion: REPLAY_CALENDAR_VERSION,
      executionVersion: EXECUTION_MODEL_VERSION,
      fillPolicy: REPLAY_FILL_POLICY,
      ambiguityPolicy: REPLAY_AMBIGUITY_POLICY,
      includePartial: includePartial === true,
      requireExecutableBid: requireExecutableBid === true,
      asOfKey,
    });

    const cached = !force && lastResult !== null
      && lastResult.params.days === requestedDays
      && lastResult.params.lane === requestedLane
      && lastResult.params.configFingerprint === configFingerprint
      && lastResult.params.includePartial === (includePartial === true)
      && lastResult.params.requireExecutableBid === (requireExecutableBid === true)
      && Date.now() - lastResult.generatedAtMs < REPLAY_CACHE_TTL_MS;
    if (cached) {
      return envelope(lastResult, { cached: true, detail });
    }

    const runKey = `${requestedDays}|${requestedLane}|${configFingerprint}`;
    const inFlight = runningByKey.get(runKey);
    if (inFlight) {
      const joined = await withAbortSignal(inFlight, signal);
      return envelope(joined, { cached: false, detail });
    }

    const computation = (async () => {
      const config = configNow;
      const nowDate = requestedNow;
      const dayList = listReplayTradingDays(config, requestedDays, nowDate, { includePartial: includePartial === true });
      const candidateDays = dayList;
      const failures = [];
      const events = [];
      const sessionDiagnostics = [];
      const continuous = {
        portfolio: emptyReplayPortfolio(),
        signalState: defaultSignalState(),
        trades: [],
        orders: [],
        fills: [],
        pendingOrders: [],
        unexecutedSignals: [],
        equityCurve: [],
        executionDiagnostics: { bars: 0, realBidAskBars: 0, syntheticBars: 0, ambiguousBars: 0, unexecutedSignals: 0 },
        lastMarkPrice: null,
      };
      let steps = 0;
      let blockedSteps = 0;
      let daysEvaluated = 0;
      let completeDays = 0;
      let partialDays = 0;
      let excludedDays = Math.max(0, candidateDays.length - dayList.length);
      let daysSkippedNoData = 0;
      for (const [dayIndex, day] of dayList.entries()) {
        if (signal?.aborted) throw abortError(signal.reason);
        // Pace only network lanes: the CMB universe slices local arrays and
        // must not stall on the anti-scraping delay.
        if (requestedLane === "au9999") {
          if (dayIndex > 0) await new Promise((resolve) => setTimeout(resolve, REPLAY_DAY_PACE_MS));
          else await new Promise((resolve) => setImmediate(resolve));
        } else {
          await new Promise((resolve) => setImmediate(resolve));
        }
        try {
          const { bars5, bars60 } = await withAbortSignal(fetchDayBars(requestedLane, day, config), signal);
          const dayResult = replayTradingDay(day, bars5, bars60, config, {
            lane: requestedLane,
            asOf: nowDate,
            requireExecutableBid,
          });
          sessionDiagnostics.push({
            day,
            status: dayResult.sessionStatus,
            sessionEnd: dayResult.sessionEnd,
            asOf: dayResult.asOf,
          });
          if (dayResult.steps === 0) {
            daysSkippedNoData += 1;
            continue;
          }
          if (dayResult.sessionStatus === "partial" && includePartial !== true) {
            partialDays += 1;
            excludedDays += 1;
            continue;
          }
          if (dayResult.sessionStatus === "partial") partialDays += 1;
          if (dayResult.sessionStatus === "complete") completeDays += 1;
          const continuousResult = replayContinuousTradingDay(day, bars5, bars60, config, continuous, {
            lane: requestedLane,
            asOf: nowDate,
          });
          steps += dayResult.steps;
          blockedSteps += dayResult.blockedSteps;
          events.push(...dayResult.events);
          daysEvaluated += 1;
          if (continuousResult?.sessionStatus === "partial" && includePartial !== true) {
            excludedDays += 1;
          }
        } catch (error) {
          if (error?.name === "AbortError") throw error;
          failures.push({ day, error: String(error?.message ?? error).slice(0, 200) });
          logger?.warn?.(`dsh-plugin-goldboard: replay-stats day ${day} failed: ${String(error?.message ?? error)}`);
        }
      }
      if (signal?.aborted) throw abortError(signal.reason);
      const generatedAtMs = Date.now();
      const reportId = `replay-${generatedAtMs}-${++reportSequence}`;
      // Wire-visible parameter snapshot: the UI shows exactly which strategy
      // values this report was computed under (e.g. closeBySessionEnd on/off).
      const snapshot = normalizeConfig(config);
      const report = aggregateReplayReport({
        events,
        continuous,
        steps,
        blockedSteps,
        daysRequested: requestedDays,
        daysEvaluated,
        daysFailed: failures.length,
        failures,
        params: {
          days: requestedDays,
          lane: requestedLane,
          fee: snapshot.fee,
          cmb: snapshot.cmb,
          limits: { maxGrams: snapshot.limits.maxGrams },
          strategy: snapshot.strategy,
          tradingHours: snapshot.tradingHours,
          includePartial: includePartial === true,
          requireExecutableBid: requireExecutableBid === true,
        },
        generatedAt: generatedAtMs,
        window: { from: dayList[0] ?? null, to: dayList[dayList.length - 1] ?? null },
        daysSkippedNoData,
        completeDays,
        partialDays,
        excludedDays,
        sessionDiagnostics,
        reportId,
      });
      const result = {
        params: {
          days: requestedDays,
          lane: requestedLane,
          configFingerprint,
          includePartial: includePartial === true,
          requireExecutableBid: requireExecutableBid === true,
        },
        generatedAtMs,
        report,
        events,
        trades: continuous.trades,
        orders: continuous.orders,
        fills: continuous.fills,
        pendingOrders: continuous.pendingOrders,
        unexecutedSignals: continuous.unexecutedSignals.slice(),
      };
      lastResult = result;
      if (file) {
        await writeJsonAtomic(file, {
          report,
          trades: continuous.trades,
          orders: continuous.orders,
          fills: continuous.fills,
          pendingOrders: continuous.pendingOrders,
          unexecutedSignals: continuous.unexecutedSignals.slice(),
        }, writeQueue).catch((error) => {
          logger?.warn?.(`dsh-plugin-goldboard: replay-stats persist failed: ${String(error?.message ?? error)}`);
        });
      }
      return result;
    })();
    runningByKey.set(runKey, computation);
    try {
      const result = await computation;
      return envelope(result, { cached: false, detail });
    } finally {
      if (runningByKey.get(runKey) === computation) runningByKey.delete(runKey);
    }
  }

  function envelope(result, { cached, detail }) {
    const events = detail === true && Array.isArray(result.events)
      ? result.events.slice(-REPLAY_DETAIL_EVENT_CAP)
      : undefined;
    const trades = detail === true && Array.isArray(result.trades) ? result.trades.slice() : undefined;
    const orders = detail === true && Array.isArray(result.orders) ? result.orders.slice() : undefined;
    const fills = detail === true && Array.isArray(result.fills) ? result.fills.slice() : undefined;
    const pendingOrders = detail === true && Array.isArray(result.pendingOrders) ? result.pendingOrders.slice() : undefined;
    const unexecutedSignals = detail === true && Array.isArray(result.unexecutedSignals)
      ? result.unexecutedSignals.slice(-REPLAY_UNEXECUTED_SIGNAL_CAP)
      : undefined;
    return {
      ok: true,
      cached: cached === true,
      report: result.report,
      ...(events ? { events } : {}),
      ...(trades ? { trades } : {}),
      ...(orders ? { orders } : {}),
      ...(fills ? { fills } : {}),
      ...(pendingOrders ? { pendingOrders } : {}),
      ...(unexecutedSignals ? { unexecutedSignals } : {}),
    };
  }

  /** Last report: memory first, then the persisted file. Never throws. */
  async function last(detail = false) {
    if (lastResult) return envelope(lastResult, { cached: true, detail });
    if (file) {
      const saved = await readJson(file, null);
      if (saved && typeof saved === "object" && saved.report && typeof saved.report === "object") {
        const trades = Array.isArray(saved.trades) ? saved.trades : undefined;
        const orders = Array.isArray(saved.orders) ? saved.orders : undefined;
        const fills = Array.isArray(saved.fills) ? saved.fills : undefined;
        const pendingOrders = Array.isArray(saved.pendingOrders) ? saved.pendingOrders : undefined;
        const unexecutedSignals = Array.isArray(saved.unexecutedSignals)
          ? saved.unexecutedSignals.slice(-REPLAY_UNEXECUTED_SIGNAL_CAP)
          : undefined;
        return {
          ok: true,
          cached: true,
          report: saved.report,
          ...(detail && trades ? { trades } : {}),
          ...(detail && orders ? { orders } : {}),
          ...(detail && fills ? { fills } : {}),
          ...(detail && pendingOrders ? { pendingOrders } : {}),
          ...(detail && unexecutedSignals ? { unexecutedSignals } : {}),
        };
      }
    }
    return { ok: true, report: null };
  }

  return { run, last };
}
