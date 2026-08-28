/**
 * Plan engine: signal-lane resolution, dynamic CMB spread calibration,
 * premium statistics, and the intraday suggestion pipeline.
 *
 * plan-05: extracted from the old monolithic lib/index.js and decomposed —
 * computePlan is now an orchestrator over four pure stages:
 *
 *   1. `selectSignalInstrument` — lane stickiness + availability + prices;
 *   2. `buildPlanSeries`        — closed-bar series, indicator sets, spreads;
 *   3. `positionBranch`         — every suggestion while holding a position;
 *   4. `flatBranch`             — the flat-market entry / wait tail.
 *
 * All three previously-duplicated `suggestedOrder` literals go through one
 * parameterized factory (`makeSuggestedOrder`). Pure with respect to `now`;
 * only `runtime.laneState` is advanced (documented sticky-lane memory).
 */

import {
  MIDNIGHT_WINDOW_END_MINUTES,
  PLAN_WINDOWS,
  SESSION_WARMUP_MS,
  beijingParts,
  computeMarketState,
  coverageGate,
  filterBarsToTradingHours,
} from "./market-time.js";
import {
  CALCULATION_VERSION,
  INDICATOR_METHODS,
  assessMarketQuality,
  closedBars,
  isBarClosed,
  minimumCoverageForWindow,
} from "./market-quality.js";
import { computeIndicatorSet, resampleBars } from "./indicators.js";
import { STALE_QUOTE_MS, isDomesticQuoteFresh } from "./parsers.js";
import { finite, round2 } from "./shared.js";
import { normalizeConfig } from "./config.js";
import { accountExecution, resolveExecutionQuote, valuePosition } from "./execution.js";
import {
  CMB_SPREAD_MIN_INTERVAL_MS,
  CMB_SPREAD_SAMPLE_CAPACITY,
  PREMIUM_DAY_SAMPLE_CAP,
  PREMIUM_HISTORY_CAP,
  assessSpreadPremium,
  cleanCmbSpreadSamples,
  dynamicCmbSpread,
} from "./spread-stats.js";
import {
  CONFIDENCE_MAX,
  LIMIT_PRICE_STEP,
  ORDER_VALID_UNTIL_MARGIN_MS,
  ORDER_VALID_UNTIL_MIN_MS,
  SELL_ACTIONS,
  SESSION_END_WINDOW_MS,
  TROY_OUNCE_GRAMS,
  applySignalPolicy,
  defaultSignalState,
  hasCmbFallback,
  makeSuggestedOrder,
  orderValidUntil,
  stageReduceGrams,
  suggestedGrams,
  xauCnyPerGram,
} from "./sizing.js";

// plan-05: sizing / spread-stats / signal-policy symbols moved to their own
// modules; re-exported here so the historical import surface stays stable.
export {
  CMB_SPREAD_SAMPLE_CAPACITY,
  CMB_SPREAD_SAMPLE_TTL_MS,
  CMB_SPREAD_MIN_SAMPLES,
  CMB_SPREAD_MIN_INTERVAL_MS,
  PREMIUM_HISTORY_CAP,
  PREMIUM_MIN_DAYS,
  PREMIUM_DAY_SAMPLE_CAP,
  updatePremiumHistory,
  assessSpreadPremium,
  cleanCmbSpreadSamples,
  dynamicCmbSpread,
} from "./spread-stats.js";
export {
  TROY_OUNCE_GRAMS,
  POSITION_BAND_LIGHT_RATIO,
  POSITION_BAND_MID_RATIO,
  POSITION_STEP_RATIO,
  SELL_ACTIONS,
  applySignalPolicy,
  defaultSignalState,
  makeSuggestedOrder,
  stageReduceGrams,
  suggestedGrams,
  xauCnyPerGram,
  hasCmbFallback,
} from "./sizing.js";

// ── plan-03: signal-lane stickiness ────────────────────────────────────────
// A lane switch needs LANE_SWITCH_TICKS consecutive unavailable polls
// (≈90s at the default 30s poll); switching back to a higher-priority lane
// needs LANE_RECOVER_TICKS consecutive available polls. This keeps one noisy
// CMB tick from flipping the whole indicator history to another instrument.
export const LANE_SWITCH_TICKS = 3;
export const LANE_RECOVER_TICKS = 3;
// Signal lanes in priority order: live CMB → international spot converted →
// SGE Au99.99. computePlan resolves exactly one of these per evaluation.
export const SIGNAL_LANES = Object.freeze(["CMB", "XAU", "AU9999"]);

/** msToClose below which holders are nudged to close by session end (only when strategy.closeBySessionEnd is on). */
export { SESSION_END_WINDOW_MS, ORDER_VALID_UNTIL_MARGIN_MS, ORDER_VALID_UNTIL_MIN_MS, LIMIT_PRICE_STEP, CONFIDENCE_MAX } from "./sizing.js";

/**
 * Per-lane availability snapshot used by resolveSignalLane. Pure so tests can
 * feed synthetic quote records; mirrors the availability predicates that
 * computePlan historically inlined.
 *
 * The CMB lane additionally consults `runtime.laneHealth.CMB.ok` (written by
 * refreshQuotes on every poll): a rejected/invalid CMB fetch marks the lane
 * unavailable immediately even though the last good quote is still on hand,
 * which is what lets the stickiness counter start counting within ticks of an
 * outage instead of waiting for the 15-minute stale horizon.
 */
export function laneAvailability(runtime) {
  const cmbQuote = runtime?.quotes?.CMB;
  const cmbQuoteValid = !!cmbQuote
    && Number.isFinite(Number(cmbQuote.buyPrice)) && Number.isFinite(Number(cmbQuote.sellPrice))
    && Number(cmbQuote.buyPrice) > 0 && Number(cmbQuote.sellPrice) > 0
    && Number(cmbQuote.buyPrice) >= Number(cmbQuote.sellPrice);
  const xau = runtime?.quotes?.XAU;
  const usdcny = runtime?.quotes?.USDCNY;
  const domestic = runtime?.quotes?.AU9999;
  const xauCny = xauCnyPerGram(xau, usdcny);
  const hasDomestic = !!domestic && Number.isFinite(domestic.price) && domestic.price > 0;
  const cmbHealthy = runtime?.laneHealth?.CMB?.ok !== false;
  return {
    CMB: { available: cmbQuoteValid && cmbHealthy },
    XAU: { available: xauCny !== null && xauCny > 0 },
    AU9999: { available: hasDomestic },
    cmbQuoteValid,
    xauCny,
    hasXauFallback: xauCny !== null && xauCny > 0,
    hasDomestic,
  };
}

/**
 * Signal-lane stickiness (plan-03 03.1).
 *
 * - Downgrade: while the current lane is unavailable, count consecutive
 *   evaluations; after `switchTicks` counts, move to the next priority lane
 *   that IS available and emit `switchedTo` (edge).
 * - Recovery: while a higher-priority lane is available again, count; after
 *   `recoverTicks` counts, move back up and emit `switchedTo`.
 * - Closed market: no counting at all (pending state cleared), so overnight
 *   gaps never carry a half-counted switch into the next session.
 *
 * `switchedTo` is set only on the tick where the lane actually changes — the
 * caller turns that edge into the one-shot `lane_switched` notice.
 */
export function resolveSignalLane(laneState, availability, options = {}) {
  const current = SIGNAL_LANES.includes(laneState?.lane) ? laneState.lane : null;
  if (options.marketOpen === false) {
    return { lane: current, pendingLane: null, pendingTicks: 0, switchedTo: null };
  }
  if (current === null) {
    // No established lane memory (fresh boot before the first resolved tick,
    // or a stateless computePlan call such as manual replay): resolve
    // directly to the highest-priority available lane, exactly like the
    // pre-stickiness behaviour.
    const direct = SIGNAL_LANES.find((key) => availability[key]?.available === true) ?? null;
    return { lane: direct, pendingLane: null, pendingTicks: 0, switchedTo: direct };
  }
  const switchTicks = Math.max(1, Number(options.switchTicks) || LANE_SWITCH_TICKS);
  const recoverTicks = Math.max(1, Number(options.recoverTicks) || LANE_RECOVER_TICKS);
  const pendingCandidate = SIGNAL_LANES.includes(laneState?.pendingLane) ? laneState.pendingLane : null;
  const pendingBase = pendingCandidate !== null && Number.isFinite(laneState?.pendingTicks)
    ? Math.max(0, Math.floor(laneState.pendingTicks))
    : 0;

  // Downgrade path: current lane unavailable.
  if (availability[current]?.available !== true) {
    const candidate = SIGNAL_LANES.find((key) => key !== current && availability[key]?.available === true) ?? null;
    if (candidate === null) {
      return { lane: current, pendingLane: null, pendingTicks: 0, switchedTo: null };
    }
    const counted = pendingCandidate === candidate ? pendingBase + 1 : 1;
    if (counted >= switchTicks) {
      return { lane: candidate, pendingLane: null, pendingTicks: 0, switchedTo: candidate };
    }
    return { lane: current, pendingLane: candidate, pendingTicks: counted, switchedTo: null };
  }

  // Recovery path: current lane fine — check whether a higher-priority lane
  // came back and stayed available long enough to justify moving back up.
  const higher = [];
  for (const key of SIGNAL_LANES) {
    if (key === current) break;
    higher.push(key);
  }
  const recovered = higher.find((key) => availability[key]?.available === true) ?? null;
  if (recovered === null) {
    return { lane: current, pendingLane: null, pendingTicks: 0, switchedTo: null };
  }
  const counted = pendingCandidate === recovered ? pendingBase + 1 : 1;
  if (counted >= recoverTicks) {
    return { lane: recovered, pendingLane: null, pendingTicks: 0, switchedTo: recovered };
  }
  return { lane: current, pendingLane: recovered, pendingTicks: counted, switchedTo: null };
}

/**
 * Weakness detection on the latest CLOSED 5m bar (plan-03 03.2):
 * bearish engulfing of the previous body, or an upper shadow longer than
 * atr14 × shadowAtrMult. Pure; both flags are reported for reason codes.
 */
export function isBearishWeaknessBar(last, prev, atr14, options = {}) {
  if (!last || typeof last !== "object") return { engulfing: false, longUpperShadow: false, weakness: false };
  const mult = Number.isFinite(Number(options.shadowAtrMult)) ? Number(options.shadowAtrMult) : 1.0;
  const o = Number(last.o);
  const h = Number(last.h);
  const c = Number(last.c);
  if (![o, h, c].every(Number.isFinite)) {
    return { engulfing: false, longUpperShadow: false, weakness: false };
  }
  let engulfing = false;
  if (c < o && prev && typeof prev === "object") {
    const po = Number(prev.o);
    const pc = Number(prev.c);
    if (Number.isFinite(po) && Number.isFinite(pc) && pc > po && o >= pc && c <= po) {
      engulfing = true;
    }
  }
  const atrValue = Number(atr14);
  const upperShadow = h - Math.max(o, c);
  const longUpperShadow = Number.isFinite(atrValue) && atrValue > 0
    && Number.isFinite(upperShadow) && upperShadow > atrValue * mult;
  return { engulfing, longUpperShadow, weakness: engulfing || longUpperShadow };
}


// ── computePlan orchestration ───────────────────────────────────────────────

/**
 * Stage 1 — resolve the signal lane and build the base plan envelope.
 * Returns `{ cfg, market, availability, laneDecision, laneSwitchedFrom,
 * signalLane, liveCmb, useXauSignal, useDomesticSignal, hasSignal, xauCny,
 * cmbBase, cmbBuyOffset, cmbSellOffset, quotes, base }`.
 */
function selectSignalInstrument(runtime, config, now) {
  const cfg = normalizeConfig(config);
  const domestic = runtime.quotes?.AU9999;
  const cmbQuote = runtime.quotes?.CMB;
  const xau = runtime.quotes?.XAU;
  const usdcny = runtime.quotes?.USDCNY;
  const market = computeMarketState(cfg, now);
  const availability = laneAvailability(runtime);
  const hasDomestic = availability.hasDomestic;

  // Signal-lane stickiness (plan-03 03.1): the active lane only moves after
  // several consecutive evaluations agree (see resolveSignalLane). The
  // previous lane is remembered so the switch edge can fire the one-shot
  // lane_switched notice, and applySignalPolicy resets its confirm streaks
  // whenever the resulting plan.instrument changes lanes.
  const previousLaneState = runtime.laneState && SIGNAL_LANES.includes(runtime.laneState.lane)
    ? runtime.laneState
    : null;
  const previousLane = previousLaneState?.lane ?? null;
  const laneDecision = resolveSignalLane(
    previousLaneState ?? { lane: null, pendingLane: null, pendingTicks: 0 },
    availability,
    { marketOpen: market.state === "open" },
  );
  if (runtime.laneState) {
    runtime.laneState = {
      lane: laneDecision.lane,
      pendingLane: laneDecision.pendingLane,
      pendingTicks: laneDecision.pendingTicks,
    };
  }
  const signalLane = laneDecision.lane;
  const laneSwitchedFrom = laneDecision.switchedTo !== null && previousLane !== null && laneDecision.switchedTo !== previousLane
    ? previousLane
    : null;

  // 信号标的口径：招行实时 → 国际金价按汇率折算 → Au99.99（粘滞切换见上）。
  // 数据覆盖率门槛按同一口径统计信号标的的 1 分钟 bars。
  // While a downgrade is still pending (unhealthy lane, counter running), the
  // plan keeps evaluating on the current lane's last-known data and reports
  // `signal_lane_degraded`; only a confirmed switch re-bases every series.
  const liveCmb = signalLane === "CMB" && availability.cmbQuoteValid;
  const useXauSignal = signalLane === "XAU";
  const useDomesticSignal = signalLane === "AU9999";
  const hasSignal = availability.CMB.available || availability.XAU.available || availability.AU9999.available;
  const xauCny = availability.xauCny;
  const cmbBase = xauCny ?? (hasDomestic ? domestic.price : undefined);

  // Dynamic CMB calibration preserves customer buy/sell offsets separately.
  // Legacy mid-only samples remain readable but are explicitly identified by
  // dynamicSpread.legacy and never treated as observed bid/ask history.
  const dynamicSpread = dynamicCmbSpread(runtime.cmbSpreadSamples, now.getTime(), {
    buyOffset: cfg.cmb.buySpreadPerGram,
    sellOffset: cfg.cmb.sellSpreadPerGram,
  });
  const cmbBuyOffset = dynamicSpread ? dynamicSpread.buyOffset : cfg.cmb.buySpreadPerGram;
  const cmbSellOffset = dynamicSpread ? dynamicSpread.sellOffset : cfg.cmb.sellSpreadPerGram;

  const base = {
    action: "no_data",
    marketState: market.state,
    instrument: signalLane === "CMB" ? "CMB" : (useXauSignal ? "XAU" : "Au99.99"),
    signalLane,
    ...(laneSwitchedFrom !== null ? { laneSwitchedFrom } : {}),
    signalPrice: liveCmb ? Number(cmbQuote.buyPrice) : (useXauSignal ? xauCny : (hasDomestic ? domestic.price : undefined)),
    cmbEstimatedPrice: liveCmb
      ? round2(Number(cmbQuote.sellPrice))
      : (cmbBase !== undefined ? round2(cmbBase + cmbBuyOffset) : undefined),
    grams: 0,
    reasonCodes: [],
    breakeven: undefined,
    targetPrice: undefined,
    stopPrice: undefined,
    suggestedOrder: null,
  };

  return {
    cfg, market, availability, laneDecision, laneSwitchedFrom, signalLane,
    liveCmb, useXauSignal, useDomesticSignal, hasSignal, xauCny, cmbBase,
    cmbBuyOffset, cmbSellOffset,
    quotes: { domestic, cmbQuote, xau, usdcny },
    positionEntryCostsIncluded: runtime.positionCostBasisIncludesEntryCosts === true,
    base,
  };
}

/**
 * Stage 2 — build closed-bar series, indicator sets and the derived price/
 * spread bundle; fill the corresponding fields on the base plan.
 */
function buildPlanSeries(runtime, lc, now) {
  const { cfg, liveCmb, useXauSignal, xauCny, cmbBase, cmbBuyOffset, cmbSellOffset, quotes } = lc;
  const { domestic, cmbQuote, xau } = quotes;
  const base = lc.base;
  const hasDomestic = lc.availability.hasDomestic;

  const price = liveCmb
    ? round2(Number(cmbQuote.buyPrice))
    : (useXauSignal && xauCny !== null ? xauCny : (hasDomestic ? domestic.price : xauCny));
  const selectedQuote = liveCmb ? cmbQuote : (useXauSignal && xau ? xau : domestic);
  // XAU indicators remain in their native USD/troy-ounce unit. Only the price
  // levels shown to the CMB user are converted with the current FX rate.
  const technicalPrice = useXauSignal && xau ? Number(xau.price) : price;
  const signalFactor = useXauSignal && xau && Number(technicalPrice) > 0 ? price / technicalPrice : 1;
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
  const bars10 = resampleBars(bars5, 2).filter((bar) => bar.partial !== true && isBarClosed(bar, 10, now));
  const bars30 = resampleBars(bars5, 6).filter((bar) => bar.partial !== true && isBarClosed(bar, 30, now));
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
  const executionQuote = resolveExecutionQuote({
    quote: liveCmb ? cmbQuote : null,
    referencePrice: cmbBase,
    buyOffset: cmbBuyOffset,
    sellOffset: cmbSellOffset,
    source: liveCmb ? "cmb" : (useXauSignal ? "xau-fx-fallback" : "au9999-fallback"),
    asOf: now.toISOString(),
  }, cfg);
  const cmbBuy = executionQuote.ask;
  const cmbSell = executionQuote.bid;
  const cmbBuySpread = round2(cmbBuy - price);
  const cmbSellSpread = round2(cmbSell - price);
  const spreadCmb = { buySpreadPerGram: cmbBuySpread, sellSpreadPerGram: cmbSellSpread };
  const technicalStep = LIMIT_PRICE_STEP / signalFactor;
  const toSignalPrice = (value) => round2(value * signalFactor);

  base.signalPrice = round2(price);
  base.cmbEstimatedPrice = cmbSell;
  base.cmbLive = liveCmb;
  base.execution = executionQuote;
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

  return {
    price, selectedQuote, technicalPrice, signalFactor,
    bars5, bars10, bars30, bars60, indicatorMeta,
    ind5, ind10, ind30, ind60,
    cmbBuy, cmbSell, cmbBuySpread, cmbSellSpread,
    executionQuote,
    spreadCmb, technicalStep, toSignalPrice,
  };
}

/**
 * Coverage + quality gate (exact original order): fills base.dataCoverage /
 * base.dataQuality, then returns the failing lists. Empty arrays mean pass.
 */
function evaluateDataGates(base, runtime, lc, s, now) {
  const { cfg, liveCmb, useXauSignal, useDomesticSignal, quotes } = lc;
  const { domestic, cmbQuote, xau, usdcny } = quotes;
  const gateBars1m = filterBarsToTradingHours((liveCmb ? runtime.bars?.CMB?.[1] : useXauSignal ? runtime.bars?.XAU?.[1] : runtime.bars?.AU9999?.[1]) ?? [], cfg);
  const minutesSinceOpen = lc.market.sessionStart ? (now.getTime() - Date.parse(lc.market.sessionStart)) / 60_000 : Infinity;
  const inSessionWarmup = Number.isFinite(minutesSinceOpen) && minutesSinceOpen * 60_000 < SESSION_WARMUP_MS;
  const inMidnightWindow = beijingParts(now).minutes < MIDNIGHT_WINDOW_END_MINUTES;
  // Coverage is computed once for all PLAN_WINDOWS; only the pass/fail
  // decision depends on the active window set (full set vs 5/10-only warm-up).
  const fullGate = coverageGate(gateBars1m, now, PLAN_WINDOWS, cfg);
  const longWindowsReady = fullGate.coverage[30] > minimumCoverageForWindow(30) && fullGate.coverage[60] > minimumCoverageForWindow(60);
  const gateWindows = ((inSessionWarmup || inMidnightWindow) && !longWindowsReady) ? [5, 10] : PLAN_WINDOWS;
  const gateFailing = gateWindows.filter((minutes) => !(fullGate.coverage[minutes] > minimumCoverageForWindow(minutes)));
  base.dataCoverage = fullGate.coverage;
  const sourceDisagreementPct = lc.availability.hasDomestic && lc.xauCny !== null
    ? (Number(domestic.price) - lc.xauCny) / lc.xauCny * 100
    : NaN;
  base.dataQuality = assessMarketQuality({
    now,
    quote: s.selectedQuote,
    bars: s.bars5,
    coverage: fullGate.coverage,
    requiredCoverage: gateWindows,
    indicators: { ind5: s.ind5, ind10: s.ind10, ind30: s.ind30, ind60: s.ind60 },
    marketState: lc.market.state,
    expectedMarket: useXauSignal ? "spot" : undefined,
    dependencies: liveCmb
      ? [{ id: "CMB", quote: cmbQuote }]
      : useXauSignal
        ? [{ id: "XAU", quote: xau }, { id: "USDCNY", quote: usdcny }]
        : useDomesticSignal
          ? [{ id: "AU9999", quote: domestic }]
          : [],
    sourceDisagreementPct,
    cmbSpread: s.cmbBuy - s.cmbSell,
  });
  const indicatorDataPresent = s.bars5.length > 0 || s.bars10.length > 0 || s.bars30.length > 0 || s.bars60.length > 0;
  // A completely cold series cannot support an indicator-based entry, but
  // quote-only protective exits and a transparent `wait` remain available.
  // Once any formal series exists, an incomplete warm-up is a hard gate.
  const hardQualityFailures = base.dataQuality.reasonCodes.filter((code) => [
    "bars_invalid",
    ...(indicatorDataPresent ? ["indicator_warmup"] : []),
    "instrument_mismatch",
    "dependency_stale",
    "dependency_future",
    "source_disagreement",
    "cmb_spread_missing",
    "cmb_spread_invalid",
  ].includes(code));
  return { gateFailing, hardQualityFailures };
}

/** Multi-timeframe trend + trigger signals behind the confidence score. */
function confidenceSignals(s, strategy) {
  const emaRising = (ind) => Number.isFinite(ind.ema20) && Number.isFinite(ind.ema20Prev) && ind.ema20 > ind.ema20Prev;
  const trendUp = emaRising(s.ind60) && emaRising(s.ind30) && emaRising(s.ind10);
  const nearSupport = Number.isFinite(s.ind5.recentLow)
    ? (s.technicalPrice - s.ind5.recentLow) / s.technicalPrice * 100 <= strategy.nearSupportPct
    : false;
  const nearLowerBand = Number.isFinite(s.ind5.boll.lower)
    ? s.technicalPrice <= s.ind5.boll.lower * (1 + strategy.nearSupportPct / 100)
    : false;
  const rsiRecovering = Number.isFinite(s.ind5.rsi14) && s.ind5.rsi14 > strategy.rsiOversold && s.ind5.rsi14 < 50;
  const aboveSma20 = Number.isFinite(s.ind5.sma20) && s.technicalPrice > s.ind5.sma20;
  const buySetup = trendUp && (nearSupport || nearLowerBand) && (rsiRecovering || aboveSma20);
  const emaUpCount = [s.ind10, s.ind30, s.ind60].filter(emaRising).length;
  const macdPositive = Number.isFinite(s.ind5.macd?.histogram) && s.ind5.macd.histogram > 0;
  const confidenceScore = emaUpCount
    + (nearSupport ? 1 : 0)
    + (nearLowerBand ? 1 : 0)
    + (rsiRecovering ? 1 : 0)
    + (aboveSma20 ? 1 : 0)
    + (macdPositive ? 1 : 0);
  return { trendUp, nearSupport, nearLowerBand, rsiRecovering, aboveSma20, buySetup, confidenceScore };
}

/** Build portfolio valuation independently from indicator/data-quality gates. */
function attachPositionValuation(base, cfg, executionQuote, entryCostsIncluded = false) {
  const pos = cfg.position;
  const lots = Array.isArray(pos.lots) ? pos.lots.filter((lot) => lot.status !== "closed") : [];
  const valuation = valuePosition(pos, executionQuote, cfg, { entryCostsIncluded });
  base.position = {
    grams: pos.grams,
    avgCostPerGram: round2(pos.avgCostPerGram || 0),
    effectiveEntryPrice: valuation.effectiveEntryPrice,
    cmbNow: valuation.bid,
    effectiveExitPrice: valuation.effectiveExitPrice,
    feeAdjustedPnl: valuation.pnlCny,
    profitPerGram: valuation.effectivePnlPerGram,
    exitNeeded: valuation.breakEvenBid,
    valuationAvailable: valuation.available,
    valuationReasonCode: valuation.reasonCode,
    synthetic: valuation.synthetic === true,
    costs: valuation.costs ?? null,
    lots: lots.map((lot) => {
      const lotValue = valuePosition(
        { grams: lot.grams, avgCostPerGram: lot.price },
        executionQuote,
        cfg,
        { entryCostsIncluded },
      );
      return {
        id: lot.id,
        grams: lot.grams,
        price: lot.price,
        time: lot.time,
        cmbNow: lotValue.bid,
        effectiveExitPrice: lotValue.effectiveExitPrice,
        feeAdjustedPnl: lotValue.pnlCny,
        profitPerGram: lotValue.effectivePnlPerGram,
        valuationAvailable: lotValue.available,
        valuationReasonCode: lotValue.reasonCode,
      };
    }),
  };
  base.breakeven = valuation.breakEvenBid ?? undefined;
  base.stopPrice = valuation.stopBid ?? undefined;
  base.grams = pos.grams;
  return valuation;
}

/**
 * Stage 3 — every suggestion while holding a position (incl. the re-buy
 * sub-branch). Mutates `base`; always returns true (the caller finishes).
 */
function positionBranch(base, lc, s, c, now) {
  const { cfg } = lc;
  const pos = cfg.position;
  const strategy = cfg.strategy;
  const valuation = attachPositionValuation(base, cfg, s.executionQuote, lc.positionEntryCostsIncluded);
  const exitNeeded = valuation.breakEvenBid;
  const cmbNow = valuation.bid;
  const pnl = valuation.pnlCny;

  const resistance = Number.isFinite(s.ind5.recentHigh)
    ? s.ind5.recentHigh * s.signalFactor + s.spreadCmb.sellSpreadPerGram
    : undefined;
  const atrValue = Number.isFinite(s.ind5.atr14) ? s.ind5.atr14 * s.signalFactor : strategy.minProfitPerGram;
  const targetPrice = Math.max(
    exitNeeded + strategy.minProfitPerGram,
    finite(resistance, exitNeeded + atrValue) - atrValue * strategy.atrFactor,
  );
  base.targetPrice = round2(targetPrice);

  if (cmbNow >= targetPrice) {
    const reduceGrams = stageReduceGrams(cfg.limits.maxGrams, pos.grams, "sell_take_profit", strategy.minRemainGrams);
    if (reduceGrams > 0) {
      base.action = "sell_take_profit";
      base.grams = reduceGrams;
      base.reasonCodes.push("target_reached");
      if (base.grams < pos.grams) base.reasonCodes.push("target_band_reduce");
    } else {
      base.action = "wait";
      base.reasonCodes.push("already_light_position");
    }
  } else if (valuation.stopTriggered) {
    base.action = "sell_stop";
    base.reasonCodes.push("stop_reached");
  } else if (cfg.strategy.closeBySessionEnd === true && lc.market.msToClose <= SESSION_END_WINDOW_MS) {
    // 收盘前强制平仓提示：仅在 strategy.closeBySessionEnd 开启时生效（默认关
    // 闭，不固定倾向于日内了结）。关闭时持仓在最后半小时继续走常规信号链。
    base.action = "close_by_session_end";
    base.reasonCodes.push("session_ending");
  } else {
    const last = s.bars5[s.bars5.length - 1];
    const prev = s.bars5[s.bars5.length - 2];
    const overboughtBearish = pnl > 0 && Number.isFinite(s.ind5.rsi14) && s.ind5.rsi14 > strategy.rsiOverbought
      && !!(last && prev && last.c < last.o && last.h - last.c > (s.ind5.atr14 || 0.5));
    const trailingBreak = pnl > 0 && Number.isFinite(s.ind5.sma20) && s.bars5.length >= 1 && !!(last && last.c < s.ind5.sma20);
    if (overboughtBearish) {
      const reduceGrams = stageReduceGrams(cfg.limits.maxGrams, pos.grams, "reduce_position", strategy.minRemainGrams);
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
      const reduceGrams = stageReduceGrams(cfg.limits.maxGrams, pos.grams, "sell_trailing", strategy.minRemainGrams);
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
      // sell_weakness (plan-03 03.2): protective trim driven by CLOSED 5m
      // bar evidence — RSI14 above strategy.weaknessRsi together with either
      // a bearish engulfing bar or an upper shadow longer than
      // atr14 × weaknessShadowAtrMult. Unlike reduce_position/sell_trailing
      // this does NOT require open profit: it also protects underwater
      // positions from riding momentum failure further down.
      const lastClosed5m = s.bars5[s.bars5.length - 1];
      const prevClosed5m = s.bars5[s.bars5.length - 2];
      const weaknessBar = isBearishWeaknessBar(lastClosed5m, prevClosed5m, s.ind5.atr14, {
        shadowAtrMult: strategy.weaknessShadowAtrMult,
      });
      const weaknessExit = Number.isFinite(s.ind5.rsi14) && s.ind5.rsi14 > strategy.weaknessRsi && weaknessBar.weakness;
      if (weaknessExit) {
        const reduceGrams = stageReduceGrams(cfg.limits.maxGrams, pos.grams, "sell_weakness", strategy.minRemainGrams);
        if (reduceGrams > 0) {
          base.action = "sell_weakness";
          base.grams = reduceGrams;
          base.reasonCodes.push("weakness_rsi_overbought");
          if (weaknessBar.engulfing) base.reasonCodes.push("bearish_engulfing");
          if (weaknessBar.longUpperShadow) base.reasonCodes.push("long_upper_shadow");
          if (base.grams < pos.grams) base.reasonCodes.push("target_band_reduce");
        } else {
          base.action = "wait";
          base.reasonCodes.push("already_light_position");
        }
      } else {
        const remaining = cfg.limits.maxGrams > 0 ? cfg.limits.maxGrams - pos.grams : Infinity;
        if (c.buySetup && remaining > 0 && c.confidenceScore >= strategy.scoreThreshold) {
          appendAddPosition(base, lc, s, now);
          return true;
        }
        base.action = "wait";
        base.reasonCodes.push(c.trendUp ? "trigger_not_confirmed" : "trend_filter_not_met");
        if (c.buySetup && c.confidenceScore < strategy.scoreThreshold) base.reasonCodes.push("score_not_enough");
      }
    }
  }
  if (SELL_ACTIONS.includes(base.action)) {
    attachSellOrder(base, lc, s, now);
  }
  return true;
}

/** Buy/add suggestion appended to an existing position branch. */
function appendAddPosition(base, lc, s, now) {
  const strategy = lc.cfg.strategy;
  const atrValueAdd = Number.isFinite(s.ind5.atr14) ? s.ind5.atr14 : 1 / s.signalFactor;
  const suggestedTechnicalPrice = Math.min(
    s.technicalPrice + s.technicalStep,
    (Number.isFinite(s.ind5.recentLow) ? s.ind5.recentLow : s.technicalPrice) + atrValueAdd * strategy.atrFactor,
  );
  const suggestedSignalPrice = s.toSignalPrice(suggestedTechnicalPrice);
  const suggestedCmbPrice = round2(suggestedSignalPrice + s.spreadCmb.buySpreadPerGram);
  const grams = suggestedGrams(lc.cfg);
  base.action = grams > 0 ? "add_position" : "no_budget";
  base.grams = grams;
  // 买入/补仓只是建议：在用户实际更新持仓前，回本价/目标价/止损位继续按当前持仓配置展示
  base.reasonCodes.push("trend_ema20_up");
  collectTriggerReasons(base, s);
  if (grams > 0) {
    base.reasonCodes.push("target_band_add");
    base.suggestedOrder = makeSuggestedOrder({
      action: base.action,
      instrument: base.instrument,
      side: "buy",
      signalPrice: suggestedSignalPrice,
      cmbEstimatedPrice: suggestedCmbPrice,
      cmbLive: lc.liveCmb,
      grams,
      validUntil: orderValidUntil(now, lc.market.msToClose),
      reasonCodes: base.reasonCodes,
    });
  }
}

/** Sell-side order attached after any reducing action. */
function attachSellOrder(base, lc, s, now) {
  base.suggestedOrder = makeSuggestedOrder({
    action: base.action,
    instrument: base.instrument,
    side: "sell",
    signalPrice: base.signalPrice,
    cmbEstimatedPrice: s.cmbSell,
    cmbLive: lc.liveCmb,
    grams: base.grams,
    validUntil: orderValidUntil(now, lc.market.msToClose),
    reasonCodes: base.reasonCodes,
  });
}

/**
 * Stage 4 — flat-market entry setup and the wait tail. Mutates `base`.
 */
function flatBranch(base, lc, s, c, now) {
  const strategy = lc.cfg.strategy;
  if (c.buySetup && c.confidenceScore >= strategy.scoreThreshold) {
    const atrValue = Number.isFinite(s.ind5.atr14) ? s.ind5.atr14 : 1 / s.signalFactor;
    const suggestedTechnicalPrice = Math.min(
      s.technicalPrice + s.technicalStep,
      (Number.isFinite(s.ind5.recentLow) ? s.ind5.recentLow : s.technicalPrice) + atrValue * strategy.atrFactor,
    );
    const suggestedSignalPrice = s.toSignalPrice(suggestedTechnicalPrice);
    const suggestedCmbPrice = round2(suggestedSignalPrice + s.spreadCmb.buySpreadPerGram);
    const entryLedger = accountExecution({
      side: "buy",
      grams: 1,
      quote: s.executionQuote,
      fillPrice: suggestedCmbPrice,
    }, lc.cfg);
    const breakeven = entryLedger.breakEvenBid;
    const grams = suggestedGrams(lc.cfg);
    const targetPrice = Math.max(
      breakeven + strategy.minProfitPerGram,
      Number.isFinite(s.ind5.recentHigh)
        ? s.ind5.recentHigh * s.signalFactor - atrValue * s.signalFactor * strategy.atrFactor + s.spreadCmb.sellSpreadPerGram
        : breakeven + atrValue * s.signalFactor,
    );
    base.action = grams > 0 ? "buy_setup" : "no_budget";
    base.grams = grams;
    base.breakeven = breakeven;
    base.targetPrice = round2(targetPrice);
    base.reasonCodes.push("trend_ema20_up");
    collectTriggerReasons(base, s);
    if (grams > 0) base.reasonCodes.push("target_band_add");
    base.suggestedOrder = makeSuggestedOrder({
      action: base.action,
      instrument: base.instrument,
      side: "buy",
      signalPrice: suggestedSignalPrice,
      cmbEstimatedPrice: suggestedCmbPrice,
      cmbLive: lc.liveCmb,
      grams,
      validUntil: orderValidUntil(now, lc.market.msToClose),
      reasonCodes: base.reasonCodes,
    });
    return;
  }
  base.action = "wait";
  const currentEntry = accountExecution({ side: "buy", grams: 1, quote: s.executionQuote }, lc.cfg);
  base.breakeven = currentEntry.ok ? currentEntry.breakEvenBid : undefined;
  base.targetPrice = Number.isFinite(base.breakeven) ? base.breakeven + strategy.minProfitPerGram : undefined;
  base.reasonCodes.push(c.trendUp ? "trigger_not_confirmed" : "trend_filter_not_met");
  if (c.buySetup && c.confidenceScore < strategy.scoreThreshold) base.reasonCodes.push("score_not_enough");
}

/** Shared near-trigger reason codes for both buy branches. */
function collectTriggerReasons(base, s) {
  if (s.signals.nearSupport) base.reasonCodes.push("near_support");
  if (s.signals.nearLowerBand) base.reasonCodes.push("near_lower_band");
  if (s.signals.rsiRecovering) base.reasonCodes.push("rsi_rebound");
}

/**
 * Evaluate the whole intraday plan for one runtime snapshot.
 * Pure with respect to `now`; advances only `runtime.laneState`.
 */
export function computePlan(runtime, config, now = new Date()) {
  const lc = selectSignalInstrument(runtime, config, now);
  const { cfg } = lc;
  const base = lc.base;
  const hasSignalState = !!runtime.signalState;
  const signalState = runtime.signalState || defaultSignalState();
  const finish = (plan) => {
    // Waiting for a confirmed downgrade: keep the marker visible even when a
    // data gate replaces reasonCodes wholesale.
    if (lc.laneDecision.pendingLane !== null && lc.laneDecision.pendingTicks > 0 && !plan.reasonCodes.includes("signal_lane_degraded")) {
      plan.reasonCodes.push("signal_lane_degraded");
    }
    if (!hasSignalState) return plan;
    const applied = applySignalPolicy(plan, signalState, cfg, now);
    plan.signalState = applied.signalState;
    return plan;
  };

  if (!lc.hasSignal) {
    const domestic = lc.quotes.domestic;
    const staleDomestic = lc.availability.hasDomestic
      && ((Number.isFinite(domestic.updatedAt) && now.getTime() - domestic.updatedAt > STALE_QUOTE_MS) || !isDomesticQuoteFresh(domestic, now));
    if (staleDomestic) {
      base.action = "data_stale";
      base.reasonCodes.push("stale_quote");
    } else {
      base.reasonCodes.push("quote_missing");
    }
    if (cfg.position.grams > 0) attachPositionValuation(base, cfg, null, lc.positionEntryCostsIncluded);
    return finish(base);
  }

  const s = buildPlanSeries(runtime, lc, now);

  const { xau, usdcny, domestic, cmbQuote } = lc.quotes;
  const xauStale = Number.isFinite(xau?.updatedAt) && now.getTime() - xau.updatedAt > STALE_QUOTE_MS;
  const usdcnyStale = Number.isFinite(usdcny?.updatedAt) && now.getTime() - usdcny.updatedAt > STALE_QUOTE_MS;
  const domesticStale = lc.availability.hasDomestic && ((Number.isFinite(domestic.updatedAt) && now.getTime() - domestic.updatedAt > STALE_QUOTE_MS) || !isDomesticQuoteFresh(domestic, now));
  const cmbStale = lc.liveCmb && (!Number.isFinite(Number(cmbQuote?.updatedAt)) || now.getTime() - Number(cmbQuote.updatedAt) > STALE_QUOTE_MS);
  const quoteStale = lc.liveCmb
    ? cmbStale
    : (lc.useXauSignal && (xauStale || usdcnyStale)) || (lc.useDomesticSignal && domesticStale);

  if (cfg.position.grams > 0) {
    attachPositionValuation(base, cfg, quoteStale ? null : s.executionQuote, lc.positionEntryCostsIncluded);
  }

  if (lc.market.state !== "open") {
    base.action = "market_closed";
    base.reasonCodes.push("market_closed");
    return finish(base);
  }
  if (quoteStale) {
    base.action = "data_stale";
    base.reasonCodes.push("stale_quote");
    return finish(base);
  }

  const { gateFailing, hardQualityFailures } = evaluateDataGates(base, runtime, lc, s, now);
  if (gateFailing.length > 0) {
    base.action = "data_incomplete";
    base.reasonCodes = gateFailing.map((minutes) => `data_incomplete_${minutes}m`);
    return finish(base);
  }
  if (hardQualityFailures.length > 0) {
    base.action = "data_incomplete";
    base.reasonCodes = hardQualityFailures;
    return finish(base);
  }

  const signals = confidenceSignals(s, cfg.strategy);
  s.signals = signals;
  base.ruleScore = signals.confidenceScore;
  base.ruleScoreMax = CONFIDENCE_MAX;
  // Wire compatibility for v1.10 clients. This is a rule-strength count, not
  // a calibrated probability or model confidence.
  base.confidenceScore = base.ruleScore;
  base.confidenceMax = base.ruleScoreMax;

  if (cfg.position.grams > 0) {
    positionBranch(base, lc, s, signals, now);
    return finish(base);
  }

  flatBranch(base, lc, s, signals, now);
  return finish(base);
}
