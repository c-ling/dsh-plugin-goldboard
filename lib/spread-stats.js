/**
 * CMB dynamic-spread samples and domestic-premium statistics (plan-03).
 *
 * plan-05: extracted from the old monolith via plan.js. Pure functions over
 * plain sample/history arrays; constants carry the documented tuning caps.
 */

import { median, round2 } from "./shared.js";

// Live-CMB mid-spread samples backing the dynamic fallback estimate: rolling
// capacity, per-sample TTL, minimum sample count, and min spacing between two
// samples. Below MIN_SAMPLES the static configured spread stays in force.
export const CMB_SPREAD_SAMPLE_CAPACITY = 512;
export const CMB_SPREAD_SAMPLE_TTL_MS = 6 * 60 * 60 * 1000;
export const CMB_SPREAD_MIN_SAMPLES = 30;
export const CMB_SPREAD_MIN_INTERVAL_MS = 60_000;

// Daily domestic-premium history feeding the spread_alert statistics window:
// population σ over completed Beijing days, anomaly beyond ±2σ (Bollinger
// convention). Fewer than PREMIUM_MIN_DAYS days only warns.
export const PREMIUM_HISTORY_CAP = 60;
export const PREMIUM_MIN_DAYS = 20;
// Intraday premium observations kept for one Beijing day's running median.
export const PREMIUM_DAY_SAMPLE_CAP = 1440;

/**
 * Upsert today's premium record: one entry per Beijing date holding the
 * running median of that day's domesticPremiumPerGram observations taken
 * before close. Completed days feed assessSpreadPremium; the list rolls at
 * PREMIUM_HISTORY_CAP entries.
 */
export function updatePremiumHistory(history, date, samples) {
  const base = Array.isArray(history) ? history.filter((entry) => entry && typeof entry === "object" && typeof entry.date === "string" && Number.isFinite(Number(entry.premiumPerGram))) : [];
  const value = median(samples);
  if (value === null) return base.filter((entry) => entry.date !== date);
  const rest = base.filter((entry) => entry.date !== date);
  rest.push({ date, premiumPerGram: Math.round(value * 100) / 100 });
  return rest.slice(-PREMIUM_HISTORY_CAP);
}

/**
 * spread_alert statistics (plan-03 03.2): population mean/σ over completed
 * days (Bollinger convention); anomaly when |today − mean| > 2σ. With fewer
 * than PREMIUM_MIN_DAYS samples the check reports ready:false so callers can
 * surface a "still accumulating" warning instead of an alert.
 */
export function assessSpreadPremium(history, todayValue) {
  const values = (Array.isArray(history) ? history : [])
    .map((entry) => Number(entry?.premiumPerGram))
    .filter((value) => Number.isFinite(value));
  const sampleCount = values.length;
  const today = Number(todayValue);
  if (sampleCount < PREMIUM_MIN_DAYS || !Number.isFinite(today)) {
    return { ready: false, anomaly: false, sampleCount, mean: null, sigma: null, deviationSigma: null };
  }
  const mean = values.reduce((sum, value) => sum + value, 0) / sampleCount;
  const sigma = Math.sqrt(values.reduce((sum, value) => sum + (value - mean) ** 2, 0) / sampleCount);
  const deviationSigma = sigma > 0 ? Math.abs(today - mean) / sigma : (today === mean ? 0 : Infinity);
  return {
    ready: true,
    anomaly: sigma > 0 && Math.abs(today - mean) > 2 * sigma,
    sampleCount,
    mean: Math.round(mean * 100) / 100,
    sigma: Math.round(sigma * 100) / 100,
    deviationSigma: Number.isFinite(deviationSigma) ? Math.round(deviationSigma * 100) / 100 : null,
  };
}

/** Drop expired/invalid offset samples and enforce the rolling capacity. */
export function cleanCmbSpreadSamples(samples, nowMs, ttlMs = CMB_SPREAD_SAMPLE_TTL_MS, capacity = CMB_SPREAD_SAMPLE_CAPACITY) {
  const fresh = (Array.isArray(samples) ? samples : []).filter((sample) => {
    const t = Number(sample?.t);
    const hasSides = Number.isFinite(Number(sample?.buyOffset)) && Number.isFinite(Number(sample?.sellOffset));
    const hasLegacyMid = Number.isFinite(Number(sample?.spreadMid));
    return Number.isFinite(t) && (hasSides || hasLegacyMid) && nowMs - t >= 0 && nowMs - t <= ttlMs;
  });
  return fresh.slice(-capacity);
}

function offsetCap(staticOffset) {
  // A zero static offset is valid and must not collapse a non-zero calibrated
  // value to zero. One CNY/g supplies only a safety cap, not a fallback value.
  return Math.max(1, Math.abs(Number(staticOffset) || 0)) * 3;
}

function clampOffset(value, staticOffset) {
  const cap = offsetCap(staticOffset);
  return round2(Math.max(-cap, Math.min(cap, value)));
}

function calibrationFacts(samples, method, legacy) {
  const ordered = samples.slice().sort((left, right) => Number(left.t) - Number(right.t));
  const sources = { cmb: new Set(), xau: new Set(), usdcny: new Set() };
  for (const sample of ordered) {
    for (const key of Object.keys(sources)) {
      const value = sample?.sources?.[key];
      if (typeof value === "string" && value !== "") sources[key].add(value);
    }
  }
  return {
    method,
    sampleCount: ordered.length,
    from: ordered.length > 0 ? new Date(Number(ordered[0].t)).toISOString() : null,
    to: ordered.length > 0 ? new Date(Number(ordered[ordered.length - 1].t)).toISOString() : null,
    sources: Object.fromEntries(Object.entries(sources).map(([key, values]) => [key, [...values].sort()])),
    legacy,
  };
}

export function describeCmbSpreadSamples(samples, nowMs) {
  const fresh = cleanCmbSpreadSamples(samples, nowMs);
  const sideSamples = fresh.filter((sample) =>
    Number.isFinite(Number(sample?.buyOffset)) && Number.isFinite(Number(sample?.sellOffset))
  );
  const selected = sideSamples.length > 0 ? sideSamples : fresh;
  return {
    ...calibrationFacts(selected, sideSamples.length > 0 ? "insufficient-bid-ask-samples" : "insufficient-legacy-samples", sideSamples.length === 0),
    ready: false,
    minimumSamples: CMB_SPREAD_MIN_SAMPLES,
  };
}

/**
 * Median buy/sell offsets over fresh samples. New samples preserve both sides;
 * old `spreadMid` state remains readable but is explicitly marked legacy and
 * cannot be mistaken for an observed bid/ask spread.
 */
export function dynamicCmbSpread(samples, nowMs, staticOffsets) {
  const fresh = cleanCmbSpreadSamples(samples, nowMs);
  const sideSamples = fresh.filter((sample) =>
    Number.isFinite(Number(sample?.buyOffset)) && Number.isFinite(Number(sample?.sellOffset))
  );
  const legacySamples = fresh.filter((sample) => Number.isFinite(Number(sample?.spreadMid)));
  const staticBuy = typeof staticOffsets === "object" && staticOffsets !== null
    ? Number(staticOffsets.buyOffset ?? staticOffsets.buySpreadPerGram)
    : Number(staticOffsets);
  const staticSell = typeof staticOffsets === "object" && staticOffsets !== null
    ? Number(staticOffsets.sellOffset ?? staticOffsets.sellSpreadPerGram)
    : Number(staticOffsets);

  if (sideSamples.length >= CMB_SPREAD_MIN_SAMPLES) {
    const rawBuy = median(sideSamples.map((sample) => Number(sample.buyOffset)));
    const rawSell = median(sideSamples.map((sample) => Number(sample.sellOffset)));
    if (rawBuy === null || rawSell === null) return null;
    const buyOffset = clampOffset(rawBuy, staticBuy);
    const sellOffset = clampOffset(rawSell, staticSell);
    return {
      buyOffset,
      sellOffset,
      spread: round2((buyOffset + sellOffset) / 2),
      sampleCount: sideSamples.length,
      legacy: false,
      calibration: calibrationFacts(sideSamples, "median-bid-ask-offset", false),
    };
  }

  if (legacySamples.length < CMB_SPREAD_MIN_SAMPLES) return null;
  const rawMedian = median(legacySamples.map((sample) => Number(sample.spreadMid)));
  if (rawMedian === null) return null;
  const buyOffset = clampOffset(rawMedian, staticBuy);
  const sellOffset = clampOffset(rawMedian, staticSell);
  return {
    buyOffset,
    sellOffset,
    spread: round2((buyOffset + sellOffset) / 2),
    sampleCount: legacySamples.length,
    legacy: true,
    calibration: calibrationFacts(legacySamples, "median-legacy-mid-offset", true),
  };
}
