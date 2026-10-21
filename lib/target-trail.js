/**
 * Target-retrace trailing exit state machine (opt-in).
 *
 * When `strategy.targetTrailPerGram > 0`, reaching the plan's target price no
 * longer sells immediately: the position is "armed", the executable bid is
 * tracked as a peak, and the exit is triggered only when the bid falls
 * `trailPerGram` below the peak (a chandelier line that is never below
 * `target − trail`), or after `timeoutBars` closed 5m bars without a new high.
 *
 * The machine is pure: one prior state + one observation in, one next state +
 * one event out. Persistence, sizing and protective-stop precedence live in
 * plan.js; this module owns only the state transition so it can be tested
 * without a market runtime.
 */

import { round2 } from "./shared.js";

export const TARGET_TRAIL_VERSION = "goldboard-target-trail-v1";

/** Events returned by `advanceTargetTrail`. */
export const TARGET_TRAIL_EVENTS = Object.freeze([
  "idle",
  "armed",
  "partial",
  "hold",
  "exit_retrace",
  "exit_timeout",
]);

function positive(value) {
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? number : null;
}

function nonNegative(value, fallback = 0) {
  const number = Number(value);
  return Number.isFinite(number) && number >= 0 ? number : fallback;
}

function barTime(value) {
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? number : null;
}

/** Restore a persisted armed state; anything malformed becomes `null` (disarmed). */
export function normalizeTargetTrail(value) {
  if (!value || typeof value !== "object" || value.armed !== true) return null;
  const signature = typeof value.signature === "string" ? value.signature.slice(0, 128) : "";
  const targetBid = positive(value.targetBid);
  const peakBid = positive(value.peakBid);
  if (signature === "" || targetBid === null || peakBid === null) return null;
  return {
    version: TARGET_TRAIL_VERSION,
    signature,
    armed: true,
    targetBid: round2(targetBid),
    peakBid: round2(Math.max(peakBid, targetBid)),
    line: positive(value.line) === null ? null : round2(Number(value.line)),
    armedAt: typeof value.armedAt === "string" ? value.armedAt : null,
    lastBarT: barTime(value.lastBarT),
    barsSinceHigh: Math.max(0, Math.floor(nonNegative(value.barsSinceHigh))),
    partialSold: value.partialSold === true,
  };
}

function lineFor(peakBid, targetBid, trailPerGram) {
  return round2(Math.max(peakBid, targetBid) - trailPerGram);
}

/**
 * Advance the target-trail state by one plan evaluation.
 *
 * @param {object|null} prior persisted state from the previous evaluation
 * @param {object} input
 * @param {boolean} input.enabled       `strategy.targetTrailPerGram > 0`
 * @param {number}  input.bid           current executable bid
 * @param {number}  input.targetBid     the plan's target price for this position
 * @param {number}  input.trailPerGram  give-back distance from the peak
 * @param {number}  [input.timeoutBars] closed 5m bars without a new high (0 = off)
 * @param {number}  [input.partialRatio] 0 = observe only; >0 = sell this share on arming
 * @param {number}  [input.signalBarT]  latest CLOSED 5m bar timestamp
 * @param {string}  [input.signature]   position identity (instrument + entry cost)
 * @param {string}  [input.now]         ISO timestamp recorded at arming
 * @returns {{state: object|null, event: string, line: number|null, targetBid: number|null}}
 */
export function advanceTargetTrail(prior, input = {}) {
  const enabled = input.enabled === true;
  const bid = positive(input.bid);
  const targetBid = positive(input.targetBid);
  const trailPerGram = nonNegative(input.trailPerGram);
  const signature = typeof input.signature === "string" ? input.signature : "";
  const positionGrams = nonNegative(input.positionGrams);

  // Disabled, flat, missing quote or missing identity: no state may survive.
  if (!enabled || bid === null || targetBid === null || signature === "" || positionGrams <= 0) {
    return { state: null, event: "idle", line: null, targetBid: targetBid === null ? null : round2(targetBid) };
  }
  if (!(trailPerGram > 0)) {
    return { state: null, event: "idle", line: null, targetBid: round2(targetBid) };
  }

  const priorState = normalizeTargetTrail(prior);
  // A new entry cost (add) or instrument makes the old arm meaningless.
  const state = priorState && priorState.signature === signature ? priorState : null;

  if (state === null) {
    if (bid < targetBid) {
      return { state: null, event: "idle", line: null, targetBid: round2(targetBid) };
    }
    const isPartial = nonNegative(input.partialRatio) > 0;
    const armed = {
      version: TARGET_TRAIL_VERSION,
      signature,
      armed: true,
      targetBid: round2(targetBid),
      peakBid: round2(bid),
      line: lineFor(bid, targetBid, trailPerGram),
      armedAt: typeof input.now === "string" ? input.now : null,
      lastBarT: barTime(input.signalBarT),
      barsSinceHigh: 0,
      partialSold: isPartial,
    };
    return { state: armed, event: isPartial ? "partial" : "armed", line: armed.line, targetBid: armed.targetBid };
  }

  const signalBarT = barTime(input.signalBarT);
  const newHigh = bid > state.peakBid;
  let barsSinceHigh = state.barsSinceHigh;
  let lastBarT = state.lastBarT;
  if (newHigh) {
    barsSinceHigh = 0;
    lastBarT = signalBarT ?? state.lastBarT;
  } else if (signalBarT !== null && signalBarT !== state.lastBarT) {
    // Count one closed bar per evaluation, never one per elapsed minute: a
    // session gap can make timestamps jump by hours without implying bars.
    barsSinceHigh += 1;
    lastBarT = signalBarT;
  }
  const peakBid = newHigh ? round2(bid) : state.peakBid;
  const line = lineFor(peakBid, state.targetBid, trailPerGram);
  const next = {
    version: TARGET_TRAIL_VERSION,
    signature,
    armed: true,
    targetBid: state.targetBid,
    peakBid,
    line,
    armedAt: state.armedAt,
    lastBarT,
    barsSinceHigh,
    partialSold: state.partialSold,
  };

  if (bid <= line) {
    return { state: next, event: "exit_retrace", line, targetBid: next.targetBid };
  }
  const timeoutBars = Math.floor(nonNegative(input.timeoutBars));
  if (timeoutBars > 0 && barsSinceHigh >= timeoutBars) {
    return { state: next, event: "exit_timeout", line, targetBid: next.targetBid };
  }
  return { state: next, event: "hold", line, targetBid: next.targetBid };
}
