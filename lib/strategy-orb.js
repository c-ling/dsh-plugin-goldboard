import { createHash } from "node:crypto";

import { canonicalFactorRecordsAsOf, evaluateRequiredFactors } from "./factor-contract.js";
import { classifyMarketRegime } from "./market-regime.js";
import { createStrategyAdapter, defineStrategyDescriptor } from "./strategy-contract.js";

export const ORB_STRATEGY_ID = "orb-trend-pullback";
export const ORB_STRATEGY_STATE_VERSION = "goldboard-orb-state-v1";
export const ORB_STRATEGY_PARAMETER_VERSION = "goldboard-orb-params-v1";

export const ORB_STRATEGY_DESCRIPTOR = defineStrategyDescriptor({
  strategyId: ORB_STRATEGY_ID,
  strategyVersion: "goldboard-orb-trend-pullback-v1",
  role: "experimental",
  lanes: ["cmb", "xau", "au9999"],
  executionInstrument: "CMB_ACCUMULATED_GOLD",
  signalSemantics: "state_machine",
  parameterSchemaVersion: ORB_STRATEGY_PARAMETER_VERSION,
  requiredFeatures: ["opening-range", "atr14", "market-regime"],
  requiredFactors: [],
  ablations: ["without-regime-filter"],
});

export const DEFAULT_ORB_STRATEGY_PARAMETERS = Object.freeze({
  openingRangeBars: 6,
  breakoutAtrBuffer: 0.1,
  pullbackAtrTolerance: 0.35,
  setupExpiryBars: 12,
  orderValidityBars: 3,
  stopAtrMultiplier: 0.75,
  targetAtrMultiplier: 1.5,
  grams: 1,
  requireTrendRegime: true,
  requiredFactorIds: Object.freeze([]),
  factorMaxAgeMs: 24 * 60 * 60_000,
});

function finite(value, fallback, min, max) {
  const number = Number(value);
  return Number.isFinite(number) ? Math.min(max, Math.max(min, number)) : fallback;
}

function integer(value, fallback, min, max) {
  return Math.floor(finite(value, fallback, min, max));
}

function ids(value) {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value) || value.length > 16
    || value.some((entry) => typeof entry !== "string" || !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(entry))) {
    throw new TypeError("requiredFactorIds must contain at most 16 lowercase kebab ids");
  }
  return [...new Set(value)];
}

export function normalizeOrbStrategyParameters(value = {}, multiplier = 1) {
  const source = value && typeof value === "object" && !Array.isArray(value) ? value : {};
  const scale = finite(multiplier, 1, 0.5, 2);
  return {
    version: ORB_STRATEGY_PARAMETER_VERSION,
    openingRangeBars: integer(source.openingRangeBars, DEFAULT_ORB_STRATEGY_PARAMETERS.openingRangeBars, 2, 24),
    breakoutAtrBuffer: finite(source.breakoutAtrBuffer, DEFAULT_ORB_STRATEGY_PARAMETERS.breakoutAtrBuffer, 0, 5),
    pullbackAtrTolerance: finite(
      Number(source.pullbackAtrTolerance ?? DEFAULT_ORB_STRATEGY_PARAMETERS.pullbackAtrTolerance) * scale,
      DEFAULT_ORB_STRATEGY_PARAMETERS.pullbackAtrTolerance,
      0,
      5,
    ),
    setupExpiryBars: integer(source.setupExpiryBars, DEFAULT_ORB_STRATEGY_PARAMETERS.setupExpiryBars, 1, 144),
    orderValidityBars: integer(source.orderValidityBars, DEFAULT_ORB_STRATEGY_PARAMETERS.orderValidityBars, 1, 24),
    stopAtrMultiplier: finite(source.stopAtrMultiplier, DEFAULT_ORB_STRATEGY_PARAMETERS.stopAtrMultiplier, 0.1, 10),
    targetAtrMultiplier: finite(source.targetAtrMultiplier, DEFAULT_ORB_STRATEGY_PARAMETERS.targetAtrMultiplier, 0.1, 20),
    grams: finite(source.grams, DEFAULT_ORB_STRATEGY_PARAMETERS.grams, 0.01, 100_000),
    requireTrendRegime: typeof source.requireTrendRegime === "boolean"
      ? source.requireTrendRegime : DEFAULT_ORB_STRATEGY_PARAMETERS.requireTrendRegime,
    requiredFactorIds: ids(source.requiredFactorIds),
    factorMaxAgeMs: integer(source.factorMaxAgeMs, DEFAULT_ORB_STRATEGY_PARAMETERS.factorMaxAgeMs, 1, 365 * 24 * 60 * 60_000),
  };
}

function canonical(value) {
  if (value === null) return "null";
  if (typeof value === "number") return Number.isFinite(value) ? JSON.stringify(value) : "null";
  if (typeof value === "boolean" || typeof value === "string") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (!value || typeof value !== "object") return "null";
  return `{${Object.keys(value).filter((key) => value[key] !== undefined).sort()
    .map((key) => `${JSON.stringify(key)}:${canonical(value[key])}`).join(",")}}`;
}

function digest(value, length = 24) {
  return createHash("sha256").update(canonical(value)).digest("hex").slice(0, length);
}

function frameTimestamp(frame) {
  const value = frame?.timestamp ?? frame?.at ?? frame?.time ?? frame?.t;
  const parsed = typeof value === "number" ? value : Date.parse(value ?? "");
  return Number.isFinite(parsed) ? parsed : null;
}

function sessionKey(frame, atMs) {
  if (typeof frame?.session === "string" && frame.session) return frame.session;
  if (frame?.session && typeof frame.session === "object" && frame.session.day) return String(frame.session.day);
  if (typeof frame?.day === "string" && frame.day) return frame.day;
  return Number.isFinite(atMs) ? new Date(atMs).toISOString().slice(0, 10) : null;
}

function frameBar(frame, atMs) {
  const hasExplicitBarT = frame?.barT !== null && frame?.barT !== undefined && frame?.barT !== "";
  const explicitBarT = hasExplicitBarT ? Number(frame.barT) : null;
  const t = Number(Number.isFinite(explicitBarT) ? explicitBarT : frame?.t ?? atMs);
  const o = Number(frame?.o ?? frame?.open ?? frame?.close);
  const h = Number(frame?.h ?? frame?.high ?? frame?.close);
  const l = Number(frame?.l ?? frame?.low ?? frame?.close);
  const c = Number(frame?.c ?? frame?.close);
  const intervalMs = Math.max(1, Number(frame?.barIntervalMs) || 5 * 60_000);
  if (![t, o, h, l, c].every(Number.isFinite) || o <= 0 || h <= 0 || l <= 0 || c <= 0 || h < l) return null;
  if (Number.isFinite(atMs) && (t > atMs || t + intervalMs > atMs)) return null;
  return { t, o, h, l, c, partial: frame?.partial === true };
}

function executionPrice(frame, side) {
  const path = frame?.execution ?? frame?.executionPath ?? {};
  const raw = side === "buy"
    ? frame?.askC ?? path?.askBar?.c ?? path?.ask?.c ?? path?.ask?.close
    : frame?.bidC ?? path?.bidBar?.c ?? path?.bid?.c ?? path?.bid?.close;
  const value = Number(raw);
  return Number.isFinite(value) && value > 0 ? value : null;
}

function averageTrueRange(bars, period = 14) {
  if (!Array.isArray(bars) || bars.length < 2) return null;
  const values = [];
  for (let index = 1; index < bars.length; index += 1) {
    const previous = bars[index - 1];
    const current = bars[index];
    values.push(Math.max(current.h - current.l, Math.abs(current.h - previous.c), Math.abs(current.l - previous.c)));
  }
  const selected = values.slice(-Math.min(period, values.length));
  const result = selected.reduce((sum, value) => sum + value, 0) / selected.length;
  return Number.isFinite(result) && result > 0 ? result : null;
}

function baseState(session, basisFingerprint = null, signalLane = null) {
  return {
    version: ORB_STRATEGY_STATE_VERSION,
    session,
    basisFingerprint,
    signalLane,
    phase: "observing",
    barIndex: 0,
    openingBars: 0,
    rangeHigh: null,
    rangeLow: null,
    previousClose: null,
    armedAt: null,
    armedBarIndex: null,
    triggeredAt: null,
    setupId: null,
    targetPrice: null,
    stopPrice: null,
    entryValidUntil: null,
    exitValidUntil: null,
    positionSeen: false,
    exitIssued: false,
    lastObservedFillId: null,
    bars: [],
  };
}

/** Seed only point-in-time bar history; trading lifecycle always starts flat for the test window. */
export function createOrbWarmupState(frames = [], session = null, options = {}) {
  const bars = frames.map((frame) => {
    const atMs = frameTimestamp(frame);
    return frameBar(frame, atMs);
  }).filter((bar) => bar && bar.partial !== true).slice(-120);
  const parameters = normalizeOrbStrategyParameters(options.parameters, options.parameterMultiplier);
  const signalLane = String(options.lane ?? "cmb").toLowerCase();
  const basisFingerprint = digest({ parameters, ablation: options.ablation ?? "none", signalLane }, 64);
  return {
    ...baseState(session, basisFingerprint, signalLane),
    bars,
    previousClose: Number.isFinite(Number(bars.at(-1)?.c)) ? Number(bars.at(-1).c) : null,
  };
}

function normalizeState(value, session, portfolioGrams = 0, basisFingerprint = null, signalLane = null) {
  if (!value || value.version !== ORB_STRATEGY_STATE_VERSION
    || value.basisFingerprint !== basisFingerprint || value.signalLane !== signalLane) {
    return baseState(session, basisFingerprint, signalLane);
  }
  const prior = structuredClone(value);
  const carriedBars = Array.isArray(prior.bars) ? prior.bars.slice(-120) : [];
  if (prior.session === session) {
    return {
      ...baseState(session, basisFingerprint, signalLane),
      ...prior,
      session,
      positionSeen: prior.positionSeen === true || portfolioGrams > 0,
      bars: carriedBars,
    };
  }
  const next = {
    ...baseState(session, basisFingerprint, signalLane),
    lastObservedFillId: typeof prior.lastObservedFillId === "string" ? prior.lastObservedFillId : null,
    bars: carriedBars,
    previousClose: Number.isFinite(Number(carriedBars.at(-1)?.c)) ? Number(carriedBars.at(-1).c) : null,
  };
  const protectiveState = portfolioGrams > 0 && prior.phase === "triggered"
    && Number.isFinite(Number(prior.stopPrice)) && Number.isFinite(Number(prior.targetPrice));
  if (protectiveState) {
    next.phase = "triggered";
    next.triggeredAt = prior.triggeredAt ?? null;
    next.setupId = prior.setupId ?? null;
    next.stopPrice = Number(prior.stopPrice);
    next.targetPrice = Number(prior.targetPrice);
    next.positionSeen = true;
    next.exitIssued = false;
    next.exitValidUntil = null;
  }
  return next;
}

function signal(code, state, extra = {}) {
  return {
    code,
    strategyId: ORB_STRATEGY_DESCRIPTOR.strategyId,
    semantics: ORB_STRATEGY_DESCRIPTOR.signalSemantics,
    setupId: state.setupId,
    phase: state.phase,
    ...extra,
  };
}

function lifecycle(state, reasonCodes = []) {
  return {
    stateVersion: ORB_STRATEGY_STATE_VERSION,
    setupId: state.setupId,
    phase: state.phase,
    session: state.session,
    armedAt: state.armedAt,
    triggeredAt: state.triggeredAt,
    rangeHigh: state.rangeHigh,
    rangeLow: state.rangeLow,
    stopPrice: state.stopPrice,
    targetPrice: state.targetPrice,
    entryValidUntil: state.entryValidUntil,
    exitValidUntil: state.exitValidUntil,
    positionSeen: state.positionSeen === true,
    exitIssued: state.exitIssued === true,
    reasonCodes,
  };
}

function holdEvaluation(state, reasonCodes, options = {}) {
  const suppressedSignals = options.suppressed === true
    ? reasonCodes.map((code) => signal(code, state, { status: "suppressed" })) : [];
  return {
    decision: options.recordDecision === true ? {
      action: "wait",
      strategyId: ORB_STRATEGY_DESCRIPTOR.strategyId,
      strategyVersion: ORB_STRATEGY_DESCRIPTOR.strategyVersion,
      reasonCodes,
      setupLifecycle: lifecycle(state, reasonCodes),
      marketRegime: options.regime ?? null,
    } : null,
    valuation: null,
    nextState: state,
    activeSignals: options.activeSignals ?? [],
    suppressedSignals,
    diagnostics: [
      { type: "setup_lifecycle", value: lifecycle(state, reasonCodes) },
      ...(options.regime ? [{ type: "market_regime", value: options.regime }] : []),
      ...(options.factorGate ? [{ type: "factor_gate", value: options.factorGate }] : []),
    ],
  };
}

function orderDecision({ state, frame, side, action, grams, limitPrice, targetPrice, stopPrice, atrPerGram = null, reasonCodes, regime }) {
  const atMs = frameTimestamp(frame);
  // Expiry is exclusive at a frame timestamp; add one interval so N configured
  // bars means exactly the next N bars can fill a next-bar order.
  const validUntil = new Date(atMs + (state.parameters.orderValidityBars + 1) * 5 * 60_000).toISOString();
  if (side === "buy") state.entryValidUntil = validUntil;
  else state.exitValidUntil = validUntil;
  return {
    decision: {
      action,
      candidateAction: action,
      strategyId: ORB_STRATEGY_DESCRIPTOR.strategyId,
      strategyVersion: ORB_STRATEGY_DESCRIPTOR.strategyVersion,
      signalLane: frame.lane ?? null,
      instrument: frame.instrument ?? null,
      executionInstrument: ORB_STRATEGY_DESCRIPTOR.executionInstrument,
      signalPrice: Number(frame.c ?? frame.close),
      ruleScore: side === "buy" ? 5 : 4,
      ruleScoreMax: 5,
      reasonCodes,
      marketRegime: regime,
      setupLifecycle: lifecycle(state, reasonCodes),
      suggestedOrder: {
        action,
        setupId: state.setupId,
        instrument: ORB_STRATEGY_DESCRIPTOR.executionInstrument,
        side,
        signalPrice: Number(frame.c ?? frame.close),
        cmbEstimatedPrice: limitPrice,
        limitPrice,
        grams,
        targetPrice,
        stopPrice,
        atrPerGram,
        validUntil,
        reasonCodes,
      },
    },
    valuation: null,
    nextState: state,
    activeSignals: reasonCodes.map((code) => signal(code, state, { side, action })),
    suppressedSignals: [],
    diagnostics: [
      { type: "setup_lifecycle", value: lifecycle(state, reasonCodes) },
      { type: "market_regime", value: regime },
    ],
  };
}

function strategyEvaluation(input, factoryOptions) {
  const frame = input?.marketFrame ?? {};
  const atMs = frameTimestamp(frame);
  const requestedSession = sessionKey(frame, atMs);
  const portfolioGrams = Math.max(0, Number(input?.portfolio?.grams) || 0);
  const parameterSource = input?.params?.strategyParameters ?? factoryOptions.parameters;
  const parameterMultiplier = input?.params?.parameterMultiplier ?? factoryOptions.parameterMultiplier;
  const parameters = normalizeOrbStrategyParameters(parameterSource, parameterMultiplier);
  const ablation = input?.params?.ablation ?? factoryOptions.ablation ?? "none";
  const signalLane = String(frame?.lane ?? input?.params?.signalLane ?? "cmb").toLowerCase();
  const basisFingerprint = digest({ parameters, ablation, signalLane }, 64);
  const bar = frameBar(frame, atMs);
  if (atMs === null || !bar || !requestedSession || frame.complete === false || bar.partial) {
    const priorSession = input?.previousState?.version === ORB_STRATEGY_STATE_VERSION
      ? input.previousState.session : requestedSession;
    const state = normalizeState(input?.previousState, priorSession, portfolioGrams, basisFingerprint, signalLane);
    state.parameters = parameters;
    return holdEvaluation(state, ["market_frame_invalid"], { suppressed: true, recordDecision: true });
  }

  const session = requestedSession;
  const state = normalizeState(input?.previousState, session, portfolioGrams, basisFingerprint, signalLane);
  state.parameters = parameters;
  const replayFills = Array.isArray(input?.replay?.fills) ? input.replay.fills : [];
  const lastObservedIndex = state.lastObservedFillId === null
    ? -1 : replayFills.findIndex((fill) => fill?.fillId === state.lastObservedFillId);
  const unseenFills = lastObservedIndex >= 0 ? replayFills.slice(lastObservedIndex + 1) : replayFills;
  if (unseenFills.some((fill) => fill?.side === "buy"
    && (fill.setupId === null || fill.setupId === undefined || fill.setupId === state.setupId))) state.positionSeen = true;
  const latestFillId = replayFills.at(-1)?.fillId;
  if (typeof latestFillId === "string") state.lastObservedFillId = latestFillId;
  const previousBarT = Number(state.bars.at(-1)?.t);
  if (Number.isFinite(previousBarT) && bar.t <= previousBarT) {
    return holdEvaluation(state, [bar.t === previousBarT ? "market_frame_duplicate" : "market_frame_out_of_order"], {
      suppressed: true,
      recordDecision: true,
    });
  }
  state.barIndex += 1;
  state.bars = [...state.bars, bar].slice(-120);
  state.previousClose = Number.isFinite(Number(state.previousClose)) ? Number(state.previousClose) : null;

  const regime = classifyMarketRegime({ bars: state.bars, observedAt: new Date(atMs).toISOString() });
  const openingRange = Number.isFinite(Number(state.rangeHigh)) && Number.isFinite(Number(state.rangeLow))
    ? Number(state.rangeHigh) - Number(state.rangeLow) : bar.h - bar.l;
  const atr = averageTrueRange(state.bars) ?? Math.max(0.01, openingRange);
  if (state.phase === "triggered") {
    state.positionSeen = state.positionSeen === true || portfolioGrams > 0;
    if (portfolioGrams <= 0 && state.positionSeen) {
      state.phase = "expired";
      state.exitIssued = false;
      state.exitValidUntil = null;
      state.previousClose = bar.c;
      return holdEvaluation(state, ["orb_position_closed"], { recordDecision: true, regime });
    }
    if (portfolioGrams <= 0) {
      const entryValidUntilMs = Date.parse(state.entryValidUntil ?? "");
      if (Number.isFinite(entryValidUntilMs) && atMs < entryValidUntilMs) {
        state.previousClose = bar.c;
        return holdEvaluation(state, ["orb_entry_pending"], { regime });
      }
      state.phase = "expired";
      state.triggeredAt = null;
      state.entryValidUntil = null;
      state.stopPrice = null;
      state.targetPrice = null;
      state.exitIssued = false;
      state.exitValidUntil = null;
      state.previousClose = bar.c;
      return holdEvaluation(state, ["orb_entry_expired"], { suppressed: true, recordDecision: true, regime });
    } else {
      const exitValidUntilMs = Date.parse(state.exitValidUntil ?? "");
      if (state.exitIssued && (!Number.isFinite(exitValidUntilMs) || atMs >= exitValidUntilMs)) {
        state.exitIssued = false;
        state.exitValidUntil = null;
      }
      const bid = executionPrice(frame, "sell");
      if (!state.exitIssued && bid !== null && Number.isFinite(Number(state.stopPrice)) && bid <= state.stopPrice) {
        state.exitIssued = true;
        return orderDecision({
          state, frame, side: "sell", action: "sell_stop", grams: portfolioGrams, limitPrice: bid,
          targetPrice: state.targetPrice, stopPrice: state.stopPrice,
          reasonCodes: ["orb_stop_reached"], regime,
        });
      }
      if (!state.exitIssued && bid !== null && Number.isFinite(Number(state.targetPrice)) && bid >= state.targetPrice) {
        state.exitIssued = true;
        return orderDecision({
          state, frame, side: "sell", action: "sell_take_profit", grams: portfolioGrams, limitPrice: bid,
          targetPrice: state.targetPrice, stopPrice: state.stopPrice,
          reasonCodes: ["orb_target_reached"], regime,
        });
      }
      state.previousClose = bar.c;
      return holdEvaluation(state, [state.exitIssued ? "orb_exit_pending" : "orb_setup_triggered"], { regime });
    }
  }

  if (state.openingBars < parameters.openingRangeBars) {
    state.openingBars += 1;
    state.rangeHigh = state.rangeHigh === null ? bar.h : Math.max(state.rangeHigh, bar.h);
    state.rangeLow = state.rangeLow === null ? bar.l : Math.min(state.rangeLow, bar.l);
    state.previousClose = bar.c;
    return holdEvaluation(state, ["opening_range_observing"], {
      activeSignals: [signal("opening_range_observing", state, { observedBars: state.openingBars, requiredBars: parameters.openingRangeBars })],
    });
  }

  if (state.phase === "armed") {
    const barsArmed = state.barIndex - Number(state.armedBarIndex ?? state.barIndex);
    if (barsArmed > parameters.setupExpiryBars) {
      state.phase = "expired";
      state.previousClose = bar.c;
      return holdEvaluation(state, ["orb_setup_expired"], { suppressed: true, recordDecision: true, regime });
    }
    const pullbackTouched = bar.l <= state.rangeHigh + atr * parameters.pullbackAtrTolerance;
    const reclaimed = bar.c >= state.rangeHigh;
    if (pullbackTouched && reclaimed) {
      const factorRecords = input?.params?.factorRecords ?? factoryOptions.factorRecords ?? [];
      const factorGate = evaluateRequiredFactors({
        requiredFactorIds: parameters.requiredFactorIds,
        records: factorRecords,
        asOf: new Date(atMs).toISOString(),
        maxAgeMs: parameters.factorMaxAgeMs,
      });
      if (factorGate.decision !== "proceed") {
        state.previousClose = bar.c;
        return holdEvaluation(state, ["required_factor_unavailable"], {
          suppressed: true, recordDecision: true, regime, factorGate,
        });
      }
      const regimeRequired = parameters.requireTrendRegime && ablation !== "without-regime-filter";
      if (regimeRequired && !(regime.regime === "trend" && regime.direction === "up")) {
        state.previousClose = bar.c;
        return holdEvaluation(state, ["regime_not_uptrend"], { suppressed: true, recordDecision: true, regime, factorGate });
      }
      const ask = executionPrice(frame, "buy");
      if (ask === null) {
        state.previousClose = bar.c;
        return holdEvaluation(state, ["execution_ask_unavailable"], { suppressed: true, recordDecision: true, regime, factorGate });
      }
      const available = Number.isFinite(Number(input?.portfolio?.maxGrams))
        ? Math.max(0, Number(input.portfolio.maxGrams) - (Number(input.portfolio.grams) || 0))
        : parameters.grams;
      const grams = Math.min(parameters.grams, available);
      if (!(grams > 0)) {
        state.previousClose = bar.c;
        return holdEvaluation(state, ["position_limit"], { suppressed: true, recordDecision: true, regime, factorGate });
      }
      state.phase = "triggered";
      state.triggeredAt = new Date(atMs).toISOString();
      const independentExecutionBasis = typeof frame.executionLane === "string"
        && frame.executionLane !== frame.lane;
      const projectedRangeLow = independentExecutionBasis
        ? Number(state.rangeLow) + (ask - Number(bar.c))
        : Number(state.rangeLow);
      state.stopPrice = Math.min(
        ask - 0.01,
        Math.max(projectedRangeLow, ask - atr * parameters.stopAtrMultiplier),
      );
      state.targetPrice = ask + atr * parameters.targetAtrMultiplier;
      state.previousClose = bar.c;
      return orderDecision({
        state, frame, side: "buy", action: "buy_setup", grams, limitPrice: ask,
        targetPrice: state.targetPrice, stopPrice: state.stopPrice, atrPerGram: atr,
        reasonCodes: ["orb_breakout_armed", "orb_pullback_reclaimed", ...(regimeRequired ? ["regime_trend_up"] : ["regime_filter_ablated"])],
        regime,
      });
    }
    state.previousClose = bar.c;
    return holdEvaluation(state, ["orb_waiting_for_pullback"], {
      activeSignals: [signal("orb_breakout_armed", state)],
      regime,
    });
  }

  if (state.phase === "expired") {
    state.previousClose = bar.c;
    return holdEvaluation(state, ["orb_setup_expired"], { regime });
  }

  const breakoutLevel = state.rangeHigh + atr * parameters.breakoutAtrBuffer;
  const crossed = state.previousClose !== null && state.previousClose <= breakoutLevel && bar.c > breakoutLevel;
  if (crossed) {
    state.phase = "armed";
    state.armedAt = new Date(atMs).toISOString();
    state.armedBarIndex = state.barIndex;
    state.setupId = `orb-setup-${digest({ session, rangeHigh: state.rangeHigh, rangeLow: state.rangeLow, armedAt: state.armedAt })}`;
    state.previousClose = bar.c;
    return holdEvaluation(state, ["orb_breakout_armed"], {
      recordDecision: true,
      activeSignals: [signal("orb_breakout_armed", state, { breakoutLevel })],
      regime,
    });
  }

  state.previousClose = bar.c;
  return holdEvaluation(state, ["orb_breakout_not_crossed"], { regime });
}

export function createOrbTrendPullbackStrategy(options = {}) {
  const parameters = normalizeOrbStrategyParameters(options.parameters, options.parameterMultiplier);
  const ablation = options.ablation === "without-regime-filter" ? options.ablation : "none";
  const factorRecords = canonicalFactorRecordsAsOf(options.factorRecords, { asOf: options.asOf });
  const identity = digest({ descriptor: ORB_STRATEGY_DESCRIPTOR.descriptorFingerprint, parameters, ablation, factorRecords }, 32);
  return createStrategyAdapter({
    descriptor: ORB_STRATEGY_DESCRIPTOR,
    adapterFingerprint: `orb-trend-pullback-v1:${identity}`,
    evaluate(input) {
      return strategyEvaluation(input, {
        parameters,
        parameterMultiplier: 1,
        ablation,
        factorRecords,
      });
    },
  });
}
