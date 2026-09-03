/**
 * Position sizing, order-suggestion factory and the confirm/cooldown signal
 * policy.
 *
 * plan-05: extracted from the old monolith via plan.js so the plan pipeline
 * file stays under the per-module line budget. Pure functions only; magic
 * numbers are named at the top (plan-05 §A.4).
 */

import { inspectQuoteDependency } from "./market-quality.js";
import { CONFIDENCE_MAX, round2 } from "./shared.js";

export { CONFIDENCE_MAX } from "./shared.js";

// ── named constants ─────────────────────────────────────────────────────────
/** Grams per troy ounce — XAU USD/oz → CNY/g conversion factor. */
export const TROY_OUNCE_GRAMS = 31.1034768;
// 目标仓位区间：轻仓 20%、标准 60%；单次最多补 maxGrams 的 10%。
export const POSITION_BAND_LIGHT_RATIO = 0.2;
export const POSITION_BAND_MID_RATIO = 0.6;
export const POSITION_STEP_RATIO = 0.1;
/** msToClose below which holders are nudged to close by session end (gated by strategy.closeBySessionEnd). */
export const SESSION_END_WINDOW_MS = 30 * 60_000;
/** Suggested orders expire this long before session close… */
export const ORDER_VALID_UNTIL_MARGIN_MS = 10 * 60_000;
/** …but never sooner than one minute from issuance. */
export const ORDER_VALID_UNTIL_MIN_MS = 60_000;
/** Buy suggestions step the limit price one tick above the technical level. */
export const LIMIT_PRICE_STEP = 0.1;
// ── pricing / sizing helpers ────────────────────────────────────────────────

/**
 * Auditable XAU/USD -> CNY/gram conversion. Both dependencies pass the same
 * freshness/future checks used by the plan quality gate; no caller may create
 * a fallback price from only one healthy leg.
 */
export function inspectXauConversion({ xau, usdcny, asOf = Date.now() } = {}) {
  const dependencies = [
    inspectQuoteDependency("XAU", xau, asOf),
    inspectQuoteDependency("USDCNY", usdcny, asOf),
  ];
  const reasonCodes = [];
  if (!xau || xau.market === "futures" || xau.instrument === "GC=F" || xau.source === "yahoo") {
    reasonCodes.push("xau_spot_unavailable");
  }
  for (const dependency of dependencies) {
    if (dependency.future || Number(dependency.futureSkewMs) > 0) reasonCodes.push(`${dependency.id.toLowerCase()}_future`);
    if (dependency.stale) reasonCodes.push(`${dependency.id.toLowerCase()}_stale`);
  }
  const xauPrice = Number(xau?.price);
  const usd = Number(usdcny?.price);
  if (!(xauPrice > 0)) reasonCodes.push("xau_price_invalid");
  if (!(usd > 0)) reasonCodes.push("usdcny_price_invalid");
  const uniqueReasonCodes = [...new Set(reasonCodes)];
  const value = uniqueReasonCodes.length === 0
    ? round2(xauPrice * usd / TROY_OUNCE_GRAMS)
    : null;
  return {
    ready: value !== null,
    value,
    reasonCodes: uniqueReasonCodes,
    dependencies,
    asOf: new Date(asOf).toISOString(),
  };
}

/** International spot gold (USD/oz) converted to CNY per gram, or null. */
export function xauCnyPerGram(xau, usdcny, asOf = Date.now()) {
  return inspectXauConversion({ xau, usdcny, asOf }).value;
}

/** True when the international-converted CMB fallback estimate is usable. */
export function hasCmbFallback(xau, usdcny, asOf = Date.now()) {
  return inspectXauConversion({ xau, usdcny, asOf }).ready;
}

function floorGrams(value) {
  if (!Number.isFinite(value) || value <= 0) return 0;
  return Math.floor(value * 100) / 100;
}

function positionBands(maxGrams) {
  return {
    lightMax: maxGrams > 0 ? maxGrams * POSITION_BAND_LIGHT_RATIO : 0,
    midMax: maxGrams > 0 ? maxGrams * POSITION_BAND_MID_RATIO : 0,
  };
}

/** Grams for the next buy suggestion given the configured budget bands. */
export function suggestedGrams(config) {
  const maxGrams = config.limits.maxGrams;
  const currentGrams = config.position.grams;
  if (maxGrams <= 0) return 0;
  const bands = positionBands(maxGrams);
  const remaining = maxGrams - currentGrams;
  if (remaining <= 0) return 0;
  // 目标仓位区间：轻仓补到 20%，标准补到 60%，重仓只补到上限。
  // 单次最多补 maxGrams 的 10%，避免一次把仓位打满。
  const target = currentGrams < bands.lightMax ? bands.lightMax : currentGrams < bands.midMax ? bands.midMax : maxGrams;
  const desired = Math.max(0, target - currentGrams);
  const maxStep = Math.max(1, maxGrams * POSITION_STEP_RATIO);
  const grams = Math.min(desired, maxStep, remaining);
  return floorGrams(grams);
}

/** staged reduction size; sell_stop / session end may flatten entirely. */
export function stageReduceGrams(maxGrams, currentGrams, action, minRemainGrams = 0) {
  if (currentGrams <= 0) return 0;
  // 止损和收盘了结允许清仓；其他减仓按目标仓位区间保留底仓。
  if (action === "sell_stop" || action === "close_by_session_end") return currentGrams;
  if (maxGrams <= 0) {
    const fallback = Math.max(1, Math.floor(currentGrams * POSITION_STEP_RATIO * 100) / 100);
    return Math.min(currentGrams, fallback);
  }
  const bands = positionBands(maxGrams);
  let target;
  if (action === "sell_take_profit") {
    // 止盈：重仓先降到标准区，标准区降到轻仓区，已轻仓可保留最小底仓或直接了结。
    target = currentGrams > bands.midMax ? bands.midMax : currentGrams > bands.lightMax ? bands.lightMax : 0;
  } else {
    // reduce_position / sell_trailing / sell_weakness：逐级降到目标区间，已处于轻仓区间时不再重复减仓。
    target = currentGrams > bands.midMax ? bands.midMax : currentGrams > bands.lightMax ? bands.lightMax : currentGrams;
  }
  target = Math.max(target, minRemainGrams);
  const reduce = Math.min(currentGrams, Math.max(0, currentGrams - target));
  return floorGrams(reduce);
}

export function defaultSignalState() {
  return {
    lastAction: null,
    lastSide: null,
    lastAt: null,
    lastPositionGrams: 0,
    lastPrice: null,
    buyStreak: 0,
    sellStreak: 0,
    // Per-side clock of the last counted closed 5m bar, so repeated
    // evaluations within the same bar never double-count confirmation.
    lastBarT: { buy: null, sell: null },
    // Signal-lane instrument memory: switching lanes invalidates streaks.
    instrument: null,
  };
}

function planSide(action) {
  if (action === "buy_setup" || action === "add_position") return "buy";
  if (SELL_ACTIONS.includes(action)) return "sell";
  return null;
}

/** Actions that exit/reduce a position (drive the sell message wording). */
export const SELL_ACTIONS = Object.freeze([
  "sell_take_profit",
  "sell_trailing",
  "sell_stop",
  "sell_weakness",
  "reduce_position",
  "close_by_session_end",
]);

const RISK_NOTE_TEXT = "技术面参考，非投资建议";

/**
 * Single constructor for wire-facing order suggestions (plan-05 §A.2):
 * replaces the three duplicated literals inside computePlan.
 */
export function makeSuggestedOrder({ action, instrument, side, signalPrice, cmbEstimatedPrice, cmbLive, grams, validUntil, reasonCodes }) {
  return {
    action,
    instrument,
    side,
    signalPrice,
    cmbEstimatedPrice,
    cmbLive,
    price: cmbEstimatedPrice,
    grams,
    validUntil,
    reasonCodes,
    riskNote: RISK_NOTE_TEXT,
  };
}

/** Order expiry anchored to session close with the documented margins. */
export function orderValidUntil(now, msToClose) {
  return new Date(now.getTime() + Math.max(msToClose - ORDER_VALID_UNTIL_MARGIN_MS, ORDER_VALID_UNTIL_MIN_MS)).toISOString();
}

/**
 * Apply confirmation/cooldown policy to one plan evaluation.
 *
 * confirmBars semantics: the condition must hold on N *consecutive closed 5m
 * bars* of the signal lane. The clock is the latest closed 5m bar's `t`
 * (plan.signalBarT): several evaluations within the same bar count once, and
 * both streaks reset whenever the action leaves the direction set, the signal
 * instrument changes, or the market closes — a stale streak from hours ago can
 * never wave a lone signal through.
 */
export function applySignalPolicy(plan, signalState, cfg, now) {
  const next = { ...signalState, lastBarT: { ...(signalState.lastBarT ?? { buy: null, sell: null }) } };
  const resetStreaks = () => {
    next.buyStreak = 0;
    next.sellStreak = 0;
    next.lastBarT = { buy: null, sell: null };
  };
  // A fill/position edit invalidates the confirmation streak, but the last
  // same-side action clock survives. Clearing cooldown here allowed one setup
  // to refill every few bars after each simulated/user-confirmed fill.
  if (signalState.lastPositionGrams !== cfg.position.grams) {
    next.lastPositionGrams = cfg.position.grams;
    resetStreaks();
  }
  // Signal-lane switch: counts from the previous instrument are meaningless.
  const instrumentKey = plan.instrument ?? null;
  if (next.instrument !== instrumentKey) {
    next.instrument = instrumentKey;
    resetStreaks();
  }
  // Session end / closed market invalidates any in-progress confirmation.
  if (plan.marketState === "closed") {
    resetStreaks();
  }
  const side = planSide(plan.action);
  // Non-directional evaluation (wait / no_data / data_incomplete / ...): the
  // signal set ended, so confirmation counting restarts from zero.
  if (!side) {
    resetStreaks();
    return { plan, signalState: next };
  }
  const cooldownMs = (cfg.strategy.signalCooldownMinutes || 0) * 60_000;
  const emergency = plan.action === "sell_stop" || plan.action === "close_by_session_end";
  const sameSide = next.lastSide === side;
  const lastAt = next.lastAt ? Date.parse(next.lastAt) : NaN;
  const inCooldown = sameSide && Number.isFinite(lastAt) && cooldownMs > 0 && (now.getTime() - lastAt) < cooldownMs;
  if (inCooldown && !emergency) {
    plan.action = "wait";
    plan.suggestedOrder = null;
    plan.grams = 0;
    if (!plan.reasonCodes.includes("cooldown_active")) plan.reasonCodes.push("cooldown_active");
    return { plan, signalState: next };
  }
  const confirmBars = Math.max(1, cfg.strategy.confirmBars || 1);
  const streakKey = side === "buy" ? "buyStreak" : "sellStreak";
  const sideClock = side === "buy" ? "buy" : "sell";
  const barT = Number.isFinite(Number(plan.signalBarT)) ? Number(plan.signalBarT) : null;
  // Advance the count only when this is a new closed bar for this side.
  if (barT === null || next.lastBarT[sideClock] !== barT) {
    next[streakKey] = (next[streakKey] || 0) + 1;
    if (barT !== null) next.lastBarT[sideClock] = barT;
  }
  const currentStreak = next[streakKey] || 0;
  const needsConfirm = confirmBars > 1 && !emergency && plan.action !== "sell_take_profit";
  if (needsConfirm && currentStreak < confirmBars) {
    plan.action = "wait";
    plan.suggestedOrder = null;
    plan.grams = 0;
    if (!plan.reasonCodes.includes("signal_confirming")) plan.reasonCodes.push("signal_confirming");
    return { plan, signalState: next };
  }
  // 信号确认通过：记录本次建议，用于同方向冷却。
  next.lastAction = plan.action;
  next.lastSide = side;
  next.lastAt = new Date(now.getTime()).toISOString();
  next.lastPositionGrams = cfg.position.grams;
  next.lastPrice = plan.signalPrice;
  const otherKey = side === "buy" ? "sellStreak" : "buyStreak";
  next[otherKey] = 0;
  return { plan, signalState: next };
}
