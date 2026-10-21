import { computeIndicatorSet } from "./indicators.js";

export const MARKET_REGIME_VERSION = "goldboard-market-regime-v1";
export const MARKET_REGIMES = Object.freeze(["trend", "range", "high_volatility", "unknown"]);
export const MARKET_REGIME_DIRECTIONS = Object.freeze(["up", "down", "flat", "unknown"]);
export const DEFAULT_MARKET_REGIME_THRESHOLDS = Object.freeze({
  minimumBars: 60,
  trendDistanceAtr: 1,
  trendSlopeAtr: 0.1,
  highVolatilityAtrPct: 1.5,
  rangeDistanceAtr: 0.75,
});

function finite(value, fallback) {
  const number = Number(value);
  return Number.isFinite(number) ? number : fallback;
}

function thresholds(value = {}) {
  return {
    minimumBars: Math.max(20, Math.floor(finite(value.minimumBars, DEFAULT_MARKET_REGIME_THRESHOLDS.minimumBars))),
    trendDistanceAtr: Math.max(0, finite(value.trendDistanceAtr, DEFAULT_MARKET_REGIME_THRESHOLDS.trendDistanceAtr)),
    trendSlopeAtr: Math.max(0, finite(value.trendSlopeAtr, DEFAULT_MARKET_REGIME_THRESHOLDS.trendSlopeAtr)),
    highVolatilityAtrPct: Math.max(0, finite(value.highVolatilityAtrPct, DEFAULT_MARKET_REGIME_THRESHOLDS.highVolatilityAtrPct)),
    rangeDistanceAtr: Math.max(0, finite(value.rangeDistanceAtr, DEFAULT_MARKET_REGIME_THRESHOLDS.rangeDistanceAtr)),
  };
}

function unknown(observedAt, reasonCodes, metrics = {}) {
  return {
    regime: "unknown",
    direction: "unknown",
    version: MARKET_REGIME_VERSION,
    observedAt,
    metrics,
    reasonCodes,
  };
}

export function classifyMarketRegime({ bars = [], observedAt, thresholds: inputThresholds = {} } = {}) {
  const observedMs = observedAt instanceof Date ? observedAt.getTime() : Date.parse(observedAt ?? "");
  if (!Number.isFinite(observedMs)) return unknown(null, ["observed_at_invalid"]);
  const observedIso = new Date(observedMs).toISOString();
  const source = Array.isArray(bars) ? bars : [];
  const candidates = source.filter((bar) => bar && bar.partial !== true && Number.isFinite(Number(bar.t))
    && Number(bar.t) <= observedMs && [bar.o, bar.h, bar.l, bar.c].every((value) => Number.isFinite(Number(value))));
  const byTimestamp = new Map();
  const conflictingTimestamps = new Set();
  for (const bar of candidates) {
    const normalized = {
      ...bar,
      t: Number(bar.t),
      o: Number(bar.o),
      h: Number(bar.h),
      l: Number(bar.l),
      c: Number(bar.c),
    };
    if (conflictingTimestamps.has(normalized.t)) continue;
    const current = byTimestamp.get(normalized.t);
    if (current && JSON.stringify([current.o, current.h, current.l, current.c])
      !== JSON.stringify([normalized.o, normalized.h, normalized.l, normalized.c])) {
      conflictingTimestamps.add(normalized.t);
      byTimestamp.delete(normalized.t);
      continue;
    }
    if (!current) byTimestamp.set(normalized.t, normalized);
  }
  const complete = [...byTimestamp.values()].sort((left, right) => left.t - right.t);
  if (conflictingTimestamps.size > 0) {
    return unknown(observedIso, ["conflicting_duplicate_bars"], { conflictingDuplicates: conflictingTimestamps.size });
  }
  if (complete.length === 0) return unknown(observedIso, source.length > 0 ? ["partial_bars_only"] : ["bars_missing"]);

  const limits = thresholds(inputThresholds);
  const indicators = computeIndicatorSet(complete);
  const last = complete.at(-1);
  const close = Number(last.c);
  const atr14 = Number(indicators.atr14);
  const ema20 = Number(indicators.ema20);
  const ema20Prev = Number(indicators.ema20Prev);
  const metrics = {
    sampleCount: complete.length,
    close,
    ema20: Number.isFinite(ema20) ? ema20 : null,
    ema20Prev: Number.isFinite(ema20Prev) ? ema20Prev : null,
    atr14: Number.isFinite(atr14) ? atr14 : null,
    atrPct: Number.isFinite(atr14) && close > 0 ? atr14 / close * 100 : null,
    distanceFromEmaAtr: Number.isFinite(atr14) && atr14 > 0 && Number.isFinite(ema20) ? (close - ema20) / atr14 : null,
    emaSlopeAtr: Number.isFinite(atr14) && atr14 > 0 && Number.isFinite(ema20) && Number.isFinite(ema20Prev)
      ? (ema20 - ema20Prev) / atr14
      : null,
  };
  if (complete.length < limits.minimumBars || !indicators.warmupReady
    || metrics.atrPct === null || metrics.distanceFromEmaAtr === null || metrics.emaSlopeAtr === null) {
    return unknown(observedIso, ["indicator_warmup"], metrics);
  }
  if (metrics.atrPct >= limits.highVolatilityAtrPct) {
    const direction = metrics.emaSlopeAtr > 0 ? "up" : metrics.emaSlopeAtr < 0 ? "down" : "flat";
    return { regime: "high_volatility", direction, version: MARKET_REGIME_VERSION, observedAt: observedIso, metrics, reasonCodes: ["atr_pct_high"] };
  }
  const trend = Math.abs(metrics.distanceFromEmaAtr) >= limits.trendDistanceAtr
    && Math.abs(metrics.emaSlopeAtr) >= limits.trendSlopeAtr
    && Math.sign(metrics.distanceFromEmaAtr) === Math.sign(metrics.emaSlopeAtr);
  if (trend) {
    return {
      regime: "trend",
      direction: metrics.emaSlopeAtr > 0 ? "up" : "down",
      version: MARKET_REGIME_VERSION,
      observedAt: observedIso,
      metrics,
      reasonCodes: ["ema_distance_and_slope"],
    };
  }
  const inRange = Math.abs(metrics.distanceFromEmaAtr) <= limits.rangeDistanceAtr;
  return {
    regime: "range",
    direction: "flat",
    version: MARKET_REGIME_VERSION,
    observedAt: observedIso,
    metrics,
    reasonCodes: [inRange ? "price_near_ema" : "trend_not_confirmed"],
  };
}
