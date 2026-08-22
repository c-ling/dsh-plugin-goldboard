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

/** Drop expired/invalid spread samples and enforce the rolling capacity. */
export function cleanCmbSpreadSamples(samples, nowMs, ttlMs = CMB_SPREAD_SAMPLE_TTL_MS, capacity = CMB_SPREAD_SAMPLE_CAPACITY) {
  const fresh = (Array.isArray(samples) ? samples : []).filter((sample) => {
    const t = Number(sample?.t);
    const value = Number(sample?.spreadMid);
    return Number.isFinite(t) && Number.isFinite(value) && nowMs - t >= 0 && nowMs - t <= ttlMs;
  });
  return fresh.slice(-capacity);
}

/** Median mid-spread over fresh samples, or null below MIN_SAMPLES (plan-03 03.3). */
export function dynamicCmbSpread(samples, nowMs, staticSpreadPerGram) {
  const fresh = cleanCmbSpreadSamples(samples, nowMs);
  if (fresh.length < CMB_SPREAD_MIN_SAMPLES) return null;
  const rawMedian = median(fresh.map((sample) => sample.spreadMid));
  if (rawMedian === null) return null;
  // Clamp into [0, static × 3]: a pathological sample window must not push the
  // fallback estimate wildly away from the configured calibration.
  const anchor = Math.max(0, Number(staticSpreadPerGram) || 0);
  return { spread: round2(Math.min(anchor * 3, Math.max(0, rawMedian))), sampleCount: fresh.length };
}
