/**
 * Technical indicator primitives and the aggregate indicator set.
 *
 * plan-05: extracted from the old monolithic lib/index.js. Pure math only —
 * no I/O, no module state. All functions tolerate short/cold series by
 * returning NaN (never throw), matching the historical contract.
 */

import {
  CALCULATION_VERSION,
  INDICATOR_METHODS,
  normalizeBarRecord,
} from "./market-quality.js";
import { mean } from "./shared.js";
import { alignStart } from "./market-time.js";

// Closed 5m bars required before an indicator set reports warmupReady
// (plan-03 gates hard on planWarmupReady = 20; 60 keeps the long SMA/EMA
// family meaningful before any signal is allowed).
export const INDICATOR_WARMUP_BARS = 60;

/**
 * Aggregate 5-minute bars into natural longer buckets (factor 2 -> 10m,
 * factor 6 -> 30m). Incomplete buckets remain visible with `partial:true`,
 * but formal strategy callers must exclude them from indicators.
 */
export function resampleBars(bars5, factor) {
  if (!Array.isArray(bars5) || !(factor > 0)) return [];
  const expectedSamples = Math.max(1, Math.floor(factor));
  const intervalMinutes = 5 * expectedSamples;
  const fiveMinuteMs = 5 * 60_000;
  const buckets = new Map();
  const ordered = bars5
    .filter((bar) => bar && Number.isFinite(Number(bar.t)))
    .slice()
    .sort((a, b) => Number(a.t) - Number(b.t));
  for (const bar of ordered) {
    const bucket = alignStart(Number(bar.t), intervalMinutes);
    if (!buckets.has(bucket)) buckets.set(bucket, []);
    buckets.get(bucket).push(bar);
  }

  const out = [];
  for (const [bucket, chunk] of buckets) {
    const first = chunk[0];
    const last = chunk[chunk.length - 1];
    const expectedTimes = new Set(
      Array.from({ length: expectedSamples }, (_, index) => bucket + index * fiveMinuteMs),
    );
    const actualTimes = new Set(chunk.map((bar) => Number(bar.t)));
    const partial = chunk.length !== expectedSamples
      || actualTimes.size !== expectedSamples
      || [...expectedTimes].some((timestamp) => !actualTimes.has(timestamp))
      || chunk.some((bar) => bar.partial === true);
    const result = {
      t: bucket,
      o: first.o,
      h: Math.max(...chunk.map((bar) => bar.h)),
      l: Math.min(...chunk.map((bar) => bar.l)),
      c: last.c,
      synthetic: chunk.some((bar) => bar.synthetic === true),
      partial,
      sampleCount: chunk.length,
      expectedSamples,
      source: chunk.every((bar) => bar.source === first.source) ? first.source : "resampled",
      sourceTimestamp: last.sourceTimestamp,
      receivedAt: last.receivedAt,
      ingestedAt: last.ingestedAt,
      quality: chunk.every((bar) => bar.quality === first.quality) ? first.quality : "degraded",
      instrument: first.instrument,
      market: first.market,
      currency: first.currency,
      unit: first.unit,
    };
    const executionSideComplete = chunk.every((bar) => bar.executionSideComplete === true)
      && chunk.every((bar) => bar.executionSideSource === first.executionSideSource);
    if (executionSideComplete && !partial) {
      result.executionSideComplete = true;
      result.executionSideSource = first.executionSideSource;
      result.executionEvidence = first.executionEvidence;
      for (const prefix of ["ask", "bid"]) {
        result[`${prefix}O`] = Number(first[`${prefix}O`]);
        result[`${prefix}H`] = Math.max(...chunk.map((bar) => Number(bar[`${prefix}H`])));
        result[`${prefix}L`] = Math.min(...chunk.map((bar) => Number(bar[`${prefix}L`])));
        result[`${prefix}C`] = Number(last[`${prefix}C`]);
      }
    } else if (chunk.some((bar) => bar.executionSideComplete !== undefined)) {
      result.executionSideComplete = false;
      result.executionEvidence = {
        mode: chunk.some((bar) => bar.executionEvidence?.mode === "proxy") ? "proxy" : "unknown",
        askSource: null,
        bidSource: null,
      };
    }
    const normalized = normalizeBarRecord(result);
    if (normalized) out.push(normalized);
  }
  return out;
}

export function sma(values, period, end = values.length - 1) {
  if (period <= 0 || end < period - 1 || end >= values.length) return NaN;
  const start = end - period + 1;
  const slice = values.slice(start, end + 1);
  return slice.every(Number.isFinite) ? mean(slice) : NaN;
}

/** EMA with the conventional period-SMA seed; pre-warm values stay NaN. */
export function emaSeries(values, period) {
  if (period <= 0 || values.length === 0) return [];
  const out = new Array(values.length).fill(NaN);
  if (values.length < period) return out;
  const seed = values.slice(0, period);
  if (!seed.every(Number.isFinite)) return out;
  const k = 2 / (period + 1);
  let prev = mean(seed);
  out[period - 1] = prev;
  for (let i = period; i < values.length; i += 1) {
    if (!Number.isFinite(values[i])) continue;
    prev = values[i] * k + prev * (1 - k);
    out[i] = prev;
  }
  return out;
}

/** Wilder RSI, seeded from the first complete period and then smoothed. */
export function rsi(values, period = 14) {
  if (values.length < period + 1 || period <= 0) return NaN;
  let avgGain = 0;
  let avgLoss = 0;
  for (let i = 1; i <= period; i += 1) {
    const diff = values[i] - values[i - 1];
    if (diff >= 0) avgGain += diff;
    else avgLoss -= diff;
  }
  avgGain /= period;
  avgLoss /= period;
  for (let i = period + 1; i < values.length; i += 1) {
    const diff = values[i] - values[i - 1];
    const gain = diff > 0 ? diff : 0;
    const loss = diff < 0 ? -diff : 0;
    avgGain = (avgGain * (period - 1) + gain) / period;
    avgLoss = (avgLoss * (period - 1) + loss) / period;
  }
  if (avgGain === 0 && avgLoss === 0) return 50;
  if (avgLoss === 0) return 100;
  const relativeStrength = avgGain / avgLoss;
  return 100 - 100 / (1 + relativeStrength);
}

export function bollinger(values, period = 20, mult = 2, end = values.length - 1) {
  const mid = sma(values, period, end);
  if (!Number.isFinite(mid)) return { mid: NaN, upper: NaN, lower: NaN };
  const start = end - period + 1;
  let variance = 0;
  for (let i = start; i <= end; i += 1) variance += (values[i] - mid) ** 2;
  const sd = Math.sqrt(variance / period);
  return { mid, upper: mid + mult * sd, lower: mid - mult * sd };
}

/** Wilder ATR, requiring period + 1 bars for its initial true-range seed. */
export function atr(bars, period = 14) {
  if (!Array.isArray(bars) || bars.length < period + 1 || period <= 0) return NaN;
  const trueRanges = [];
  for (let i = 1; i < bars.length; i += 1) {
    const prev = bars[i - 1];
    const bar = bars[i];
    trueRanges.push(Math.max(bar.h - bar.l, Math.abs(bar.h - prev.c), Math.abs(bar.l - prev.c)));
  }
  let value = mean(trueRanges.slice(0, period));
  for (let i = period; i < trueRanges.length; i += 1) {
    value = (value * (period - 1) + trueRanges[i]) / period;
  }
  return value;
}

export function macd(values, fast = 12, slow = 26, signal = 9) {
  const emaFast = emaSeries(values, fast);
  const emaSlow = emaSeries(values, slow);
  const dif = [];
  for (let i = 0; i < values.length; i += 1) {
    if (Number.isFinite(emaFast[i]) && Number.isFinite(emaSlow[i])) dif.push(emaFast[i] - emaSlow[i]);
  }
  const deaSeries = emaSeries(dif, signal);
  const latestDif = dif[dif.length - 1] ?? NaN;
  const latestDea = deaSeries[deaSeries.length - 1] ?? NaN;
  return {
    dif: latestDif,
    dea: latestDea,
    histogram: latestDif - latestDea,
  };
}

export function computeIndicatorSet(bars) {
  const normalized = (Array.isArray(bars) ? bars : [])
    .map((bar) => normalizeBarRecord(bar))
    .filter((bar) => bar !== null && bar.partial !== true);
  const closes = normalized.map((bar) => bar.c);
  const ema20 = emaSeries(closes, 20);
  const last20 = normalized.length >= 20 ? normalized.slice(-20) : [];
  const planWarmupReady = normalized.length >= 20
    && Number.isFinite(ema20[ema20.length - 1])
    && Number.isFinite(ema20[ema20.length - 2]);
  const last = normalized[normalized.length - 1];
  return {
    calculationVersion: CALCULATION_VERSION,
    methods: INDICATOR_METHODS,
    count: closes.length,
    sampleCount: closes.length,
    warmupReady: closes.length >= INDICATOR_WARMUP_BARS,
    planWarmupReady,
    synthetic: normalized.some((bar) => bar.synthetic === true),
    instrument: last?.instrument,
    market: last?.market,
    currency: last?.currency,
    unit: last?.unit,
    sma5: sma(closes, 5),
    sma20: sma(closes, 20),
    sma60: sma(closes, 60),
    ema20: ema20[ema20.length - 1] ?? NaN,
    ema20Prev: ema20[ema20.length - 2] ?? NaN,
    rsi14: rsi(closes, 14),
    boll: bollinger(closes, 20, 2),
    atr14: atr(normalized, 14),
    macd: macd(closes),
    recentHigh: last20.length === 20 ? Math.max(...last20.map((bar) => bar.h)) : NaN,
    recentLow: last20.length === 20 ? Math.min(...last20.map((bar) => bar.l)) : NaN,
  };
}
