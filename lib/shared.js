/**
 * Shared numeric helpers for the goldboard host modules.
 *
 * plan-05: these lived as file-private helpers inside the old 5.7k-line
 * lib/index.js. Extracting them keeps every module on one implementation of
 * rounding / clamping instead of drifting per-file copies.
 */

/** Denominator of the transparent strategy rule score. */
export const CONFIDENCE_MAX = 8;

/** Clamp a numeric input into [min, max], falling back when not finite. */
export function num(value, fallback, min = -Infinity, max = Infinity) {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, n));
}

/** Round to two decimals (the plugin's universal price/amount quantum). */
export function round2(value) {
  return Math.round(value * 100) / 100;
}

/** `value` when finite, `fallback` otherwise. */
export function finite(value, fallback) {
  return Number.isFinite(value) ? value : fallback;
}

/** Median of a numeric list (average of the two middle values on even size). */
export function median(values) {
  const list = (Array.isArray(values) ? values : [])
    .filter((value) => value !== null && value !== undefined && Number.isFinite(Number(value)))
    .map((value) => Number(value))
    .sort((a, b) => a - b);
  if (list.length === 0) return null;
  const mid = Math.floor(list.length / 2);
  return list.length % 2 === 1 ? list[mid] : (list[mid - 1] + list[mid]) / 2;
}

/** Arithmetic mean; NaN for an empty list (indicator warm-up semantics). */
export function mean(values) {
  if (values.length === 0) return NaN;
  return values.reduce((acc, value) => acc + value, 0) / values.length;
}
