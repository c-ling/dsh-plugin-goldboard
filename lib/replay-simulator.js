import { createHash } from "node:crypto";

import { strategyActionSide } from "./strategy-contract.js";

export const REPLAY_SIMULATOR_VERSION = "goldboard-replay-simulator-v1";
export const REPLAY_EVALUATION_TRACE_LIMIT = 4096;
export const REPLAY_FILL_POLICIES = Object.freeze([
  "next-bar-limit",
  "next-open",
  "signal-close",
  "delay-30s",
  "delay-60s",
  "delay-120s",
]);
export const REPLAY_AMBIGUITY_POLICIES = Object.freeze(["unknown", "conservative-stop"]);

const DEFAULT_FILL_POLICY = "next-bar-limit";
const DEFAULT_AMBIGUITY_POLICY = "unknown";

function finite(value) {
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function positive(value) {
  const number = finite(value);
  return number !== null && number > 0 ? number : null;
}

function nonNegative(value, fallback = 0) {
  const number = finite(value);
  return number !== null && number >= 0 ? number : fallback;
}

function timestampMs(value) {
  if (value instanceof Date) return Number.isFinite(value.getTime()) ? value.getTime() : null;
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  const parsed = Date.parse(value ?? "");
  return Number.isFinite(parsed) ? parsed : null;
}

function stableValue(value) {
  if (Array.isArray(value)) return value.map(stableValue);
  if (!value || typeof value !== "object") return value;
  const output = {};
  for (const key of Object.keys(value).sort()) {
    const item = value[key];
    if (item !== undefined && typeof item !== "function") output[key] = stableValue(item);
  }
  return output;
}

function immutableSnapshot(value) {
  const snapshot = stableValue(value);
  const freeze = (entry) => {
    if (!entry || typeof entry !== "object" || Object.isFrozen(entry)) return entry;
    for (const child of Object.values(entry)) freeze(child);
    return Object.freeze(entry);
  };
  return freeze(snapshot);
}

function canonicalJson(value) {
  return JSON.stringify(stableValue(value));
}

function sha256(value) {
  return `sha256:${createHash("sha256").update(String(value)).digest("hex")}`;
}

function deterministicId(prefix, value) {
  return `${prefix}-${sha256(canonicalJson(value)).slice(7, 23)}`;
}

function frameTimestamp(frame) {
  return timestampMs(frame?.timestamp ?? frame?.t ?? frame?.at ?? frame?.time);
}

function normalizeFrame(raw, index) {
  const timestamp = frameTimestamp(raw);
  if (timestamp === null || !raw || typeof raw !== "object") return null;
  return {
    ...raw,
    timestamp: new Date(timestamp).toISOString(),
    timestampMs: timestamp,
    complete: raw.complete !== false && raw.partial !== true,
    sourceIndex: index,
  };
}

function prepareFrames(frames, asOfMs) {
  const diagnostics = {
    inputFrames: Array.isArray(frames) ? frames.length : 0,
    invalidFramesIgnored: 0,
    incompleteFramesIgnored: 0,
    futureFramesIgnored: 0,
    duplicatesDropped: 0,
    conflictingDuplicates: 0,
  };
  const byTimestamp = new Map();
  const conflictedTimestamps = new Set();
  for (const [index, raw] of (Array.isArray(frames) ? frames : []).entries()) {
    const current = normalizeFrame(raw, index);
    if (!current) {
      diagnostics.invalidFramesIgnored += 1;
      continue;
    }
    if (!current.complete) {
      diagnostics.incompleteFramesIgnored += 1;
      continue;
    }
    if (current.timestampMs > asOfMs) {
      diagnostics.futureFramesIgnored += 1;
      continue;
    }
    if (conflictedTimestamps.has(current.timestampMs)) {
      diagnostics.duplicatesDropped += 1;
      continue;
    }
    if (byTimestamp.has(current.timestampMs)) {
      diagnostics.duplicatesDropped += 1;
      const previous = byTimestamp.get(current.timestampMs);
      const previousCanonical = canonicalJson(publicFrame(previous));
      const currentCanonical = canonicalJson(publicFrame(current));
      if (previousCanonical !== currentCanonical) {
        diagnostics.conflictingDuplicates += 1;
        conflictedTimestamps.add(current.timestampMs);
        byTimestamp.delete(current.timestampMs);
      }
      continue;
    }
    byTimestamp.set(current.timestampMs, current);
  }
  const prepared = [...byTimestamp.values()].sort((left, right) => left.timestampMs - right.timestampMs);
  return { frames: prepared, diagnostics };
}

function publicFrame(frame) {
  const { timestampMs: _timestampMs, sourceIndex: _sourceIndex, ...value } = frame;
  return value;
}

function clonePortfolio(value = {}) {
  const source = value && typeof value === "object" ? value : {};
  return {
    ...stableValue(source),
    grams: nonNegative(source.grams),
    cashCny: finite(source.cashCny) ?? finite(source.cashFlowCny) ?? 0,
    realizedPnlCny: finite(source.realizedPnlCny) ?? 0,
    costBasisCny: nonNegative(source.costBasisCny),
    maxGrams: finite(source.maxGrams),
  };
}

function decisionOrder(decision) {
  if (!decision || typeof decision !== "object") return null;
  return decision.order ?? decision.suggestedOrder ?? null;
}

function withDecisionOrder(decision, order) {
  if (!decision || typeof decision !== "object") return decision;
  if (Object.hasOwn(decision, "order")) return { ...decision, order };
  if (Object.hasOwn(decision, "suggestedOrder")) return { ...decision, suggestedOrder: order };
  return decision;
}

function evaluationDecision(value) {
  if (!value || typeof value !== "object") return null;
  const order = decisionOrder(value);
  return stableValue({
    action: value.action ?? order?.action ?? null,
    candidateAction: value.candidateAction ?? null,
    strategyId: value.strategyId ?? null,
    strategyVersion: value.strategyVersion ?? null,
    signalLane: value.signalLane ?? null,
    instrument: value.instrument ?? null,
    executionInstrument: value.executionInstrument ?? order?.instrument ?? null,
    reasonCodes: Array.isArray(value.reasonCodes) ? value.reasonCodes : [],
    marketRegime: value.marketRegime ?? null,
    setupLifecycle: value.setupLifecycle ?? null,
    order: order === null ? null : {
      action: order.action ?? null,
      side: order.side ?? null,
      instrument: order.instrument ?? null,
      limitPrice: order.limitPrice ?? order.price ?? order.cmbEstimatedPrice ?? null,
      grams: order.grams ?? order.quantity ?? null,
      targetPrice: order.targetPrice ?? order.target ?? null,
      stopPrice: order.stopPrice ?? order.stop ?? null,
      validUntil: order.validUntil ?? order.expiresAt ?? null,
    },
  });
}

function evaluationValuation(value) {
  if (!value || typeof value !== "object") return null;
  return stableValue({
    available: value.available ?? value.valuationAvailable ?? null,
    reasonCode: value.reasonCode ?? value.valuationReasonCode ?? null,
    grams: value.grams ?? null,
    markPrice: value.markPrice ?? value.effectiveExitPrice ?? value.bid ?? null,
    marketValueCny: value.marketValueCny ?? value.liquidationValueCny ?? null,
    realizedPnlCny: value.realizedPnlCny ?? null,
    unrealizedPnlCny: value.unrealizedPnlCny ?? value.feeAdjustedPnl ?? null,
  });
}

function normalizeOrder(raw, atMs, sequence, inputFingerprint, fillPolicy) {
  if (!raw || typeof raw !== "object") return null;
  const side = raw.side === "buy" || raw.side === "sell" ? raw.side : null;
  const limitPrice = positive(raw.limitPrice ?? raw.price ?? raw.cmbEstimatedPrice);
  const grams = positive(raw.grams ?? raw.quantity);
  if (!side || limitPrice === null || grams === null) return null;
  const validUntilMs = timestampMs(raw.validUntil ?? raw.expiresAt);
  const delayMs = fillPolicyDelayMs(fillPolicy);
  const eligibleAtMs = fillPolicy === "signal-close" ? atMs : atMs + (delayMs ?? 1);
  const orderId = deterministicId("replay-order", {
    inputFingerprint,
    sequence,
    signalAt: new Date(atMs).toISOString(),
    side,
    limitPrice,
    grams,
  });
  return {
    orderId,
    action: raw.action ?? side,
    setupId: typeof raw.setupId === "string" ? raw.setupId : null,
    instrument: raw.instrument ?? null,
    side,
    limitPrice,
    grams,
    remainingGrams: grams,
    signalAt: new Date(atMs).toISOString(),
    eligibleAfter: new Date(atMs).toISOString(),
    eligibleAt: new Date(eligibleAtMs).toISOString(),
    eligibleAtMs,
    validUntil: validUntilMs === null ? null : new Date(validUntilMs).toISOString(),
    validUntilMs,
    targetPrice: positive(raw.targetPrice ?? raw.target),
    stopPrice: positive(raw.stopPrice ?? raw.stop),
    status: "pending",
    reasonCodes: Array.isArray(raw.reasonCodes) ? raw.reasonCodes.filter((value) => typeof value === "string") : [],
  };
}

function sideBar(path, side) {
  const raw = side === "buy"
    ? path?.ask ?? path?.askBar
    : path?.bid ?? path?.bidBar;
  if (!raw || typeof raw !== "object") return null;
  const open = positive(raw.open ?? raw.o);
  const high = positive(raw.high ?? raw.h);
  const low = positive(raw.low ?? raw.l);
  const close = positive(raw.close ?? raw.c);
  return open !== null && high !== null && low !== null && close !== null
    ? { open, high, low, close }
    : null;
}

function evaluateProtectiveBracket(bracket, path, ambiguityPolicy) {
  const executable = sideBar(path, "sell");
  if (!executable) return { status: "unknown", reasonCode: "protective_execution_path_missing" };
  if (bracket.stopPrice !== null && executable.open <= bracket.stopPrice) {
    return { status: "filled", fillPrice: executable.open, action: "stop_loss", ambiguous: false, ambiguityResolution: null };
  }
  if (bracket.targetPrice !== null && executable.open >= bracket.targetPrice) {
    return { status: "filled", fillPrice: executable.open, action: "take_profit", ambiguous: false, ambiguityResolution: null };
  }
  const stopTouched = bracket.stopPrice !== null && executable.low <= bracket.stopPrice;
  const targetTouched = bracket.targetPrice !== null && executable.high >= bracket.targetPrice;
  if (!stopTouched && !targetTouched) return { status: "pending" };
  if (stopTouched && targetTouched && ambiguityPolicy === "unknown") {
    return { status: "unknown", reasonCode: "protective_bracket_dual_touch" };
  }
  const useStop = stopTouched && (!targetTouched || ambiguityPolicy === "conservative-stop");
  const fillPrice = useStop
    ? (executable.open <= bracket.stopPrice ? executable.open : bracket.stopPrice)
    : (executable.open >= bracket.targetPrice ? executable.open : bracket.targetPrice);
  return {
    status: "filled",
    fillPrice,
    action: useStop ? "stop_loss" : "take_profit",
    ambiguous: stopTouched && targetTouched,
    ambiguityResolution: stopTouched && targetTouched ? "conservative-stop" : null,
  };
}

function markBid(path, frame) {
  const executableBid = positive(path?.bid?.close ?? path?.bid?.c ?? path?.bidBar?.close ?? path?.bidBar?.c);
  if (executableBid !== null) return executableBid;
  if (path !== null && path !== undefined) return null;
  return positive(frame?.bid ?? frame?.close ?? frame?.c);
}

function fillPolicyDelayMs(fillPolicy) {
  const match = /^delay-(30|60|120)s$/.exec(fillPolicy);
  return match ? Number(match[1]) * 1000 : null;
}

function evaluateOrder(order, path, atMs, ambiguityPolicy, fillPolicy) {
  const signalAtMs = timestampMs(order.signalAt);
  const delayMs = fillPolicyDelayMs(fillPolicy);
  const eligibleAtMs = fillPolicy === "signal-close"
    ? signalAtMs
    : delayMs === null ? signalAtMs + 1 : signalAtMs + delayMs;
  if (atMs < eligibleAtMs || (fillPolicy !== "signal-close" && atMs === signalAtMs)) {
    return { status: "pending", reasonCode: "not_eligible" };
  }
  if (order.validUntilMs !== null && atMs >= order.validUntilMs) return { status: "expired", reasonCode: "validity_ended" };
  const executable = sideBar(path, order.side);
  if (!executable) return { status: "unknown", reasonCode: "execution_path_missing" };
  if (delayMs !== null) {
    const delayedPrice = positive(path?.delayedPrices?.[String(delayMs)]
      ?? path?.delayedPrices?.[`${delayMs}ms`]
      ?? executable.delayedPrices?.[String(delayMs)]
      ?? executable.delayedPrices?.[`${delayMs}ms`]);
    if (delayedPrice === null) {
      return { status: "unknown", reasonCode: "second_level_execution_path_unavailable", coarseDelay: true };
    }
    return {
      status: "filled",
      fillPrice: delayedPrice,
      ambiguous: false,
      ambiguityResolution: null,
      coarseDelay: false,
    };
  }
  if (fillPolicy === "next-bar-limit") {
    const touched = order.side === "buy"
      ? executable.low <= order.limitPrice
      : executable.high >= order.limitPrice;
    if (!touched) return { status: "pending", reasonCode: "limit_not_touched" };
  }

  // Entry fill uncertainty is distinct from the later target/stop outcome.
  // A frame adapter may flag queue/path uncertainty explicitly, but target and
  // stop prices never imply an automatic exit inside this entry transition.
  const ambiguous = path?.fillAmbiguous === true || executable.ambiguous === true;
  if (ambiguous && ambiguityPolicy === "unknown") {
    return { status: "ambiguous", reasonCode: "entry_fill_path_unknown", ambiguous: true };
  }
  const favorableOpen = order.side === "buy"
    ? executable.open <= order.limitPrice
    : executable.open >= order.limitPrice;
  const conservativeFillPrice = positive(path?.conservativeFillPrice ?? executable.conservativeFillPrice);
  const fillPrice = ambiguous && conservativeFillPrice !== null
    ? conservativeFillPrice
    : fillPolicy === "signal-close"
      ? executable.close
      : fillPolicy === "next-open"
        ? executable.open
        : favorableOpen ? executable.open : order.limitPrice;
  return {
    status: "filled",
    fillPrice,
    ambiguous,
    ambiguityResolution: ambiguous ? "conservative_fill" : null,
    coarseDelay: delayMs !== null,
  };
}

function defaultAccounting({ side, grams, fillPrice }) {
  const grossCny = grams * fillPrice;
  return {
    ok: true,
    side,
    grams,
    fillPrice,
    grossCny,
    feeCny: 0,
    slippageCny: 0,
    cashFlowCny: side === "buy" ? -grossCny : grossCny,
  };
}

function executeFill(portfolio, order, match, execution, path) {
  const request = {
    side: order.side,
    grams: order.remainingGrams,
    fillPrice: match.fillPrice,
    quote: path,
    order,
    portfolio: stableValue(portfolio),
  };
  const accounted = typeof execution.accountExecution === "function"
    ? execution.accountExecution(request)
    : defaultAccounting(request);
  if (!accounted || accounted.ok === false) {
    return { ok: false, reasonCode: accounted?.reasonCode ?? "execution_rejected" };
  }
  if (accounted.side !== undefined && accounted.side !== order.side) {
    return { ok: false, reasonCode: "execution_side_mismatch" };
  }
  const grams = positive(accounted.grams ?? request.grams);
  const fillPrice = positive(accounted.fillPrice ?? request.fillPrice);
  if (grams === null || fillPrice === null || Math.abs(grams - order.remainingGrams) > Number.EPSILON) {
    return { ok: false, reasonCode: "partial_fill_unsupported" };
  }
  const cashFlowCny = finite(accounted.cashFlowCny);
  if (cashFlowCny === null) return { ok: false, reasonCode: "execution_cash_flow_invalid" };
  if ((order.side === "buy" && cashFlowCny > Number.EPSILON)
    || (order.side === "sell" && cashFlowCny < -Number.EPSILON)) {
    return { ok: false, reasonCode: "execution_cash_flow_sign_invalid" };
  }
  for (const key of ["grossCny", "feeCny", "explicitFeeCny", "slippageCny"]) {
    if (accounted[key] !== undefined && (finite(accounted[key]) === null || Number(accounted[key]) < 0)) {
      return { ok: false, reasonCode: "execution_cost_invalid" };
    }
  }
  const available = order.side === "buy"
    ? portfolio.maxGrams === null ? grams : Math.max(0, portfolio.maxGrams - portfolio.grams)
    : portfolio.grams;
  if (available + Number.EPSILON < grams) {
    return { ok: false, reasonCode: order.side === "buy" ? "max_grams_exceeded" : "inventory_insufficient" };
  }
  if (order.side === "buy" && portfolio.enforceCash === true && portfolio.cashCny + cashFlowCny < -Number.EPSILON) {
    return { ok: false, reasonCode: "cash_insufficient" };
  }
  const beforeGrams = portfolio.grams;
  const beforeCost = portfolio.costBasisCny;
  let realizedPnlCny = accounted.realizedPnlCny === undefined ? null : finite(accounted.realizedPnlCny);
  if (accounted.realizedPnlCny !== undefined && realizedPnlCny === null) {
    return { ok: false, reasonCode: "execution_realized_pnl_invalid" };
  }
  if (order.side === "buy") {
    portfolio.grams += grams;
    portfolio.costBasisCny += Math.max(0, -cashFlowCny);
  } else {
    const releasedCost = beforeGrams > 0 ? beforeCost * (grams / beforeGrams) : 0;
    portfolio.grams -= grams;
    portfolio.costBasisCny = Math.max(0, beforeCost - releasedCost);
    if (realizedPnlCny === null) realizedPnlCny = cashFlowCny - releasedCost;
    portfolio.realizedPnlCny += realizedPnlCny;
  }
  portfolio.cashCny += cashFlowCny;
  return { ok: true, accounted, grams, fillPrice, cashFlowCny, realizedPnlCny, beforeGrams };
}

function resolvePath(execution, frame, context) {
  if (typeof execution.path === "function") return execution.path(frame, context);
  if (typeof execution.quoteBar === "function") return execution.quoteBar({ frame, bar: frame, ...context });
  if (typeof execution.resolveExecutionPath === "function") return execution.resolveExecutionPath(frame, context);
  return frame.execution ?? frame.executionPath ?? null;
}

function markPortfolio(execution, portfolio, path, frame, params) {
  if (!(Number(portfolio?.grams) > 0)) {
    return { available: true, equity: Number(portfolio?.cashCny) || 0, markPrice: null };
  }
  const bid = markBid(path, frame);
  if (bid === null) return { available: false, equity: null, markPrice: null };
  if (typeof execution.valuePosition === "function") {
    const valued = execution.valuePosition(portfolio, { bid }, { params });
    if (valued?.available === false) return { available: false, equity: null, markPrice: bid };
    const liquidation = finite(valued?.liquidationValueCny);
    return {
      available: liquidation !== null,
      equity: liquidation === null ? null : portfolio.cashCny + liquidation,
      markPrice: bid,
    };
  }
  return { available: true, equity: portfolio.cashCny + portfolio.grams * bid, markPrice: bid };
}

function adapterIdentity(adapter, kind) {
  const methodNames = kind === "strategy" ? ["evaluate"]
    : kind === "risk" ? ["evaluate", "inspect"]
      : ["path", "quoteBar", "resolveExecutionPath", "accountExecution", "valuePosition"];
  return {
    id: adapter?.strategyId ?? adapter?.executionId ?? (kind === "risk" ? "risk-policy" : null) ?? adapter?.id ?? adapter?.name ?? null,
    version: adapter?.strategyVersion ?? adapter?.executionVersion ?? adapter?.riskPolicyVersion ?? adapter?.version ?? null,
    interfaceVersion: adapter?.descriptor?.interfaceVersion ?? adapter?.interfaceVersion ?? null,
    configurationFingerprint: kind === "risk" ? sha256(canonicalJson(adapter?.config ?? null)) : null,
    descriptorFingerprint: adapter?.descriptorFingerprint ?? adapter?.descriptor?.descriptorFingerprint ?? null,
    adapterFingerprint: adapter?.adapterFingerprint ?? null,
    methods: Object.fromEntries(methodNames.map((name) => [
      name,
      typeof adapter?.[name] === "function" ? sha256(Function.prototype.toString.call(adapter[name])) : null,
    ])),
  };
}

function fingerprintInput({ frames, initialPortfolio, fillPolicy, ambiguityPolicy, asOf, params, previousState, strategy, execution, riskPolicy }) {
  return sha256(canonicalJson({
    simulatorVersion: REPLAY_SIMULATOR_VERSION,
    strategy: adapterIdentity(strategy, "strategy"),
    execution: adapterIdentity(execution, "execution"),
    riskPolicy: riskPolicy ? adapterIdentity(riskPolicy, "risk") : null,
    frames: frames.map(publicFrame),
    initialPortfolio: stableValue(initialPortfolio),
    fillPolicy,
    ambiguityPolicy,
    asOf,
    params: stableValue(params ?? {}),
    previousState: stableValue(previousState ?? null),
  }));
}

function frameSession(frame) {
  if (typeof frame?.session === "string") return frame.session;
  if (typeof frame?.session?.day === "string") return frame.session.day;
  return typeof frame?.day === "string" ? frame.day : null;
}

function beijingDay(value) {
  const timestamp = timestampMs(value);
  return timestamp === null ? null : new Date(timestamp + 8 * 60 * 60_000).toISOString().slice(0, 10);
}

function tradingWeek(day) {
  if (typeof day !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(day)) return null;
  const date = new Date(`${day}T00:00:00.000Z`);
  const weekday = date.getUTCDay() || 7;
  date.setUTCDate(date.getUTCDate() - weekday + 1);
  return date.toISOString().slice(0, 10);
}

export function summarizeReplayRiskLedger(fills, portfolio, asOf, markPrice) {
  const currentDay = beijingDay(asOf);
  const week = tradingWeek(currentDay);
  const realized = fills.filter((fill) => fill?.realizedPnlCny !== null && fill?.realizedPnlCny !== undefined
    && fill.realizedPnlCny !== "" && Number.isFinite(Number(fill.realizedPnlCny)));
  const daily = realized.filter((fill) => beijingDay(fill.fillAt) === currentDay);
  const weekly = realized.filter((fill) => tradingWeek(beijingDay(fill.fillAt)) === week);
  let cumulative = 0;
  let peak = 0;
  for (const fill of realized) {
    cumulative += Number(fill.realizedPnlCny);
    peak = Math.max(peak, cumulative);
  }
  let consecutiveLosses = 0;
  for (let index = realized.length - 1; index >= 0; index -= 1) {
    const pnl = Number(realized[index].realizedPnlCny);
    if (pnl < 0) consecutiveLosses += 1;
    else if (pnl > 0) break;
  }
  const lastFlatIndex = fills.findLastIndex((fill) => Number(fill.positionAfterGrams) <= 0);
  const activeFills = fills.slice(lastFlatIndex + 1);
  const activeBuys = activeFills.filter((fill) => fill.side === "buy");
  const latestBuy = [...fills].reverse().find((fill) => fill.side === "buy") ?? null;
  const unrealizedPnlCny = markPrice !== null && portfolio.grams > 0
    ? portfolio.grams * markPrice - portfolio.costBasisCny : 0;
  const unrealizedLossCny = Math.max(0, -unrealizedPnlCny);
  const dailyRealizedLossCny = daily.reduce((sum, fill) => sum + Math.max(0, -Number(fill.realizedPnlCny)), 0);
  const weeklyRealizedLossCny = weekly.reduce((sum, fill) => sum + Math.max(0, -Number(fill.realizedPnlCny)), 0);
  const realizedDrawdownCny = Math.max(0, peak - cumulative);
  return {
    integrity: "ok",
    lossIncludesUnrealized: true,
    dailyRealizedLossCny,
    weeklyRealizedLossCny,
    realizedDrawdownCny,
    unrealizedLossCny,
    dailyLossCny: dailyRealizedLossCny + unrealizedLossCny,
    weeklyLossCny: weeklyRealizedLossCny + unrealizedLossCny,
    drawdownCny: realizedDrawdownCny + unrealizedLossCny,
    addsToday: fills.filter((fill) => beijingDay(fill.fillAt) === currentDay
      && fill.side === "buy" && fill.action === "add_position").length,
    activeSetupAdds: activeBuys.filter((fill) => fill.action === "add_position").length,
    activeSetupLastBuyPrice: activeBuys.at(-1)?.fillPrice ?? null,
    lastBuyFillAt: latestBuy?.fillAt ?? null,
    consecutiveLosses,
  };
}

function collectStrategyFacts(summary, evaluation) {
  const increment = (target, key) => {
    if (typeof key === "string" && key) target[key] = (target[key] ?? 0) + 1;
  };
  for (const diagnostic of Array.isArray(evaluation?.diagnostics) ? evaluation.diagnostics : []) {
    if (diagnostic?.type === "market_regime") increment(summary.regimes, diagnostic.value?.regime);
    if (diagnostic?.type === "setup_lifecycle") increment(summary.setupLifecycle, diagnostic.value?.phase);
  }
  for (const signal of Array.isArray(evaluation?.activeSignals) ? evaluation.activeSignals : []) {
    increment(summary.activeSignalCounts, signal?.code ?? signal?.reasonCode);
  }
  for (const signal of Array.isArray(evaluation?.suppressedSignals) ? evaluation.suppressedSignals : []) {
    increment(summary.suppressedReasons, signal?.code ?? signal?.reasonCode);
    for (const code of Array.isArray(signal?.reasonCodes) ? signal.reasonCodes : []) increment(summary.suppressedReasons, code);
  }
}

function replayAbortError(reason) {
  const error = new Error(String(reason?.message ?? reason ?? "replay simulation cancelled"));
  error.name = "AbortError";
  return error;
}

export class ReplaySimulator {
  *_iterate(input = {}) {
    const {
      strategy,
      execution,
      riskPolicy = null,
      initialPortfolio = {},
      fillPolicy = DEFAULT_FILL_POLICY,
      ambiguityPolicy = DEFAULT_AMBIGUITY_POLICY,
      params = {},
      previousState = null,
      signal = null,
    } = input;
    if (signal?.aborted) throw replayAbortError(signal.reason);
    if (!strategy || typeof strategy.evaluate !== "function") throw new TypeError("strategy.evaluate is required");
    if (!execution || typeof execution !== "object") throw new TypeError("execution adapter is required");
    if (!REPLAY_FILL_POLICIES.includes(fillPolicy)) throw new RangeError(`unsupported fillPolicy: ${fillPolicy}`);
    if (!REPLAY_AMBIGUITY_POLICIES.includes(ambiguityPolicy)) throw new RangeError(`unsupported ambiguityPolicy: ${ambiguityPolicy}`);
    const asOfMs = timestampMs(input.asOf);
    if (asOfMs === null) throw new TypeError("asOf must be a valid timestamp");
    const asOf = new Date(asOfMs).toISOString();
    const prepared = prepareFrames(input.frames, asOfMs);
    const fingerprint = fingerprintInput({
      frames: prepared.frames,
      initialPortfolio,
      fillPolicy,
      ambiguityPolicy,
      asOf,
      params,
      previousState,
      strategy,
      execution,
      riskPolicy,
    });
    const portfolio = clonePortfolio(initialPortfolio);
    const ledger = [];
    const evaluations = [];
    const strategyFacts = { regimes: {}, setupLifecycle: {}, activeSignalCounts: {}, suppressedReasons: {} };
    let evaluationTracesDropped = 0;
    const decisions = [];
    const orders = [];
    const fills = [];
    const pendingOrders = [];
    const protectiveBrackets = [];
    const unexecutedSignals = [];
    const equityCurve = [];
    const diagnostics = {
      ...prepared.diagnostics,
      unknownExecutionPaths: 0,
      ambiguousFills: 0,
      unresolvedEntryAmbiguities: 0,
      coarseDelayFills: 0,
      secondLevelPathsUnavailable: 0,
      executionRejected: 0,
      invalidDecisions: 0,
    };
    let state = stableValue(previousState);
    let sequence = 0;

    const record = (type, at, fields = {}) => {
      const event = {
        eventId: deterministicId("replay-event", { inputFingerprint: fingerprint, sequence: ledger.length + 1, type, at, fields }),
        sequence: ledger.length + 1,
        type,
        at,
        ...fields,
      };
      ledger.push(event);
      return event;
    };
    const settleFill = (orderEntry, match, path, at, frame) => {
      const applied = executeFill(portfolio, orderEntry, match, execution, path);
      if (!applied.ok) {
        orderEntry.status = "rejected";
        orderEntry.rejectedAt = at;
        orderEntry.reasonCode = applied.reasonCode;
        diagnostics.executionRejected += 1;
        record("execution_rejected", at, { orderId: orderEntry.orderId, reasonCode: applied.reasonCode });
        return false;
      }
      orderEntry.status = "filled";
      orderEntry.fillAt = at;
      const fill = {
        fillId: deterministicId("replay-fill", { inputFingerprint: fingerprint, orderId: orderEntry.orderId, fillAt: at }),
        orderId: orderEntry.orderId,
        side: orderEntry.side,
        action: orderEntry.action,
        setupId: orderEntry.setupId ?? null,
        protectiveBracketId: orderEntry.protectiveBracketId ?? null,
        instrument: orderEntry.instrument,
        lane: frame?.lane ?? null,
        session: frameSession(frame),
        signalAt: orderEntry.signalAt,
        eligibleAt: orderEntry.eligibleAt,
        fillAt: at,
        fillPrice: applied.fillPrice,
        grams: applied.grams,
        status: "filled",
        ambiguous: match.ambiguous === true,
        ambiguityResolution: match.ambiguityResolution,
        cashFlowCny: applied.cashFlowCny,
        realizedPnlCny: applied.realizedPnlCny,
        positionBeforeGrams: applied.beforeGrams,
        positionAfterGrams: portfolio.grams,
        ask: positive(path?.askBar?.c ?? path?.ask?.c ?? path?.ask?.close),
        bid: positive(path?.bidBar?.c ?? path?.bid?.c ?? path?.bid?.close),
        evidence: path?.evidence ?? (path?.realBidAsk === true ? "real" : path?.synthetic === true ? "proxy" : "unknown"),
        realBidAsk: path?.realBidAsk === true,
        synthetic: path?.synthetic === true,
        executionVersion: applied.accounted.executionVersion ?? execution.executionVersion ?? null,
        accounting: stableValue(applied.accounted),
      };
      fills.push(Object.freeze(fill));
      if (fill.side === "buy" && (orderEntry.stopPrice !== null || orderEntry.targetPrice !== null)) {
        protectiveBrackets.push({
          bracketId: deterministicId("replay-bracket", { inputFingerprint: fingerprint, orderId: orderEntry.orderId }),
          entryOrderId: orderEntry.orderId,
          setupId: fill.setupId,
          instrument: orderEntry.instrument,
          openedAt: at,
          grams: fill.grams,
          stopPrice: orderEntry.stopPrice,
          targetPrice: orderEntry.targetPrice,
          status: "active",
          closedAt: null,
          closeAction: null,
        });
      } else if (fill.side === "sell") {
        let remaining = fill.grams;
        const activeBrackets = protectiveBrackets.filter((entry) => entry.status === "active")
          .sort((left, right) => Number(right.bracketId === orderEntry.protectiveBracketId)
            - Number(left.bracketId === orderEntry.protectiveBracketId));
        for (const bracket of activeBrackets) {
          const reduction = Math.min(bracket.grams, remaining);
          bracket.grams = Math.max(0, bracket.grams - reduction);
          remaining -= reduction;
          if (bracket.grams <= 0) {
            bracket.status = "closed";
            bracket.closedAt = at;
            bracket.closeAction = fill.action;
          }
          if (remaining <= 0) break;
        }
      }
      if (fill.ambiguous) diagnostics.ambiguousFills += 1;
      if (match.coarseDelay === true) diagnostics.coarseDelayFills += 1;
      record("order_filled", at, { orderId: orderEntry.orderId, fillId: fill.fillId });
      return true;
    };
    const settleProtectiveExit = (bracket, match, path, at, current) => {
      const exitOrder = {
        orderId: deterministicId("replay-protective-order", { inputFingerprint: fingerprint, bracketId: bracket.bracketId, at }),
        action: match.action,
        protectiveBracketId: bracket.bracketId,
        setupId: bracket.setupId ?? null,
        instrument: bracket.instrument ?? "CMB_ACCUMULATED_GOLD",
        side: "sell",
        limitPrice: match.fillPrice,
        grams: Math.min(bracket.grams, portfolio.grams),
        remainingGrams: Math.min(bracket.grams, portfolio.grams),
        signalAt: at,
        eligibleAfter: at,
        eligibleAt: at,
        eligibleAtMs: current.timestampMs,
        validUntil: at,
        validUntilMs: current.timestampMs,
        targetPrice: null,
        stopPrice: null,
        status: "pending",
        reasonCodes: [match.action === "stop_loss" ? "protective_stop_touched" : "protective_target_touched"],
      };
      if (!(exitOrder.grams > 0)) {
        bracket.status = "closed";
        bracket.closedAt = at;
        bracket.closeAction = "position_already_flat";
        return;
      }
      orders.push(exitOrder);
      record("protective_order_submitted", at, { orderId: exitOrder.orderId, bracketId: bracket.bracketId, action: exitOrder.action });
      settleFill(exitOrder, match, path, at, current);
    };

    for (const current of prepared.frames) {
      if (signal?.aborted) throw replayAbortError(signal.reason);
      const at = current.timestamp;
      const path = resolvePath(execution, publicFrame(current), { asOf: at, params, portfolio: stableValue(portfolio) });
      const survivors = [];
      for (const orderEntry of pendingOrders) {
        const match = evaluateOrder(orderEntry, path, current.timestampMs, ambiguityPolicy, fillPolicy);
        if (match.status === "unknown") {
          diagnostics.unknownExecutionPaths += 1;
          if (match.reasonCode === "second_level_execution_path_unavailable") diagnostics.secondLevelPathsUnavailable += 1;
          record("execution_unknown", at, { orderId: orderEntry.orderId, reasonCode: match.reasonCode });
          survivors.push(orderEntry);
          continue;
        }
        if (match.status === "pending") {
          survivors.push(orderEntry);
          continue;
        }
        if (match.status === "expired") {
          orderEntry.status = "expired";
          orderEntry.expiredAt = at;
          record("order_expired", at, { orderId: orderEntry.orderId, reasonCode: match.reasonCode });
          continue;
        }
        if (match.status === "ambiguous") {
          orderEntry.status = "ambiguous";
          orderEntry.resolvedAt = at;
          diagnostics.ambiguousFills += 1;
          diagnostics.unresolvedEntryAmbiguities += 1;
          record("fill_ambiguous", at, { orderId: orderEntry.orderId, reasonCode: match.reasonCode });
          continue;
        }
        settleFill(orderEntry, match, path, at, current);
      }
      pendingOrders.splice(0, pendingOrders.length, ...survivors);

      for (const bracket of protectiveBrackets.filter((entry) => entry.status === "active" && entry.openedAt !== at)) {
        const match = evaluateProtectiveBracket(bracket, path, ambiguityPolicy);
        if (match.status === "pending") continue;
        if (match.status === "unknown") {
          diagnostics.unknownExecutionPaths += 1;
          record("protective_exit_unknown", at, { bracketId: bracket.bracketId, reasonCode: match.reasonCode });
          if (match.reasonCode === "protective_bracket_dual_touch") {
            bracket.status = "unresolved";
            bracket.closedAt = at;
            bracket.closeAction = null;
          }
          continue;
        }
        settleProtectiveExit(bracket, match, path, at, current);
      }

      if (fillPolicy !== "signal-close") {
        for (const bracket of protectiveBrackets.filter((entry) => entry.status === "active" && entry.openedAt === at)) {
          const match = evaluateProtectiveBracket(bracket, path, ambiguityPolicy);
          if (match.status === "pending") continue;
          const entryAtOpen = fillPolicy === "next-open";
          const conservativeStop = ambiguityPolicy === "conservative-stop" && match.action === "stop_loss";
          if (match.status === "unknown" || (!entryAtOpen && !conservativeStop)) {
            diagnostics.unknownExecutionPaths += 1;
            bracket.status = "unresolved";
            bracket.closedAt = at;
            bracket.closeAction = null;
            record("protective_exit_unknown", at, {
              bracketId: bracket.bracketId,
              reasonCode: "protective_entry_bar_order_unknown",
            });
            continue;
          }
          settleProtectiveExit(bracket, match, path, at, current);
        }
      }

      const evaluation = strategy.evaluate({
        marketFrame: publicFrame(current),
        portfolio: stableValue(portfolio),
        params: stableValue(params),
        previousState: stableValue(state),
        asOf: at,
        replay: immutableSnapshot({
          fillCount: fills.length,
          fills,
          latestFill: fills.at(-1) ?? null,
        }),
      });
      if (evaluation && typeof evaluation === "object" && Object.hasOwn(evaluation, "nextState")) {
        state = stableValue(evaluation.nextState);
      }
      let decision = evaluation && typeof evaluation === "object" && Object.hasOwn(evaluation, "decision")
        ? evaluation.decision
        : evaluation;
      let rawOrder = decisionOrder(decision);
      let effectiveSuppressedSignals = stableValue(evaluation?.suppressedSignals ?? decision?.suppressedSignals ?? []);
      const effectiveDiagnostics = stableValue(evaluation?.diagnostics ?? []);
      if (rawOrder) {
        const nestedAction = rawOrder.action;
        const outerAction = decision?.action;
        const resolvedAction = nestedAction ?? outerAction;
        const expectedSide = strategyActionSide(resolvedAction);
        const invalidAction = (nestedAction !== undefined && outerAction !== undefined && nestedAction !== outerAction)
          || expectedSide === null || rawOrder.side !== expectedSide;
        if (invalidAction) {
          diagnostics.invalidDecisions += 1;
          effectiveDiagnostics.push({ type: "invalid_order", code: "invalid_order_action" });
          effectiveSuppressedSignals.push({ code: "invalid_order_action", status: "suppressed", source: "replay_simulator" });
          decision = {
            ...withDecisionOrder(decision, null),
            reasonCodes: [...new Set([...(Array.isArray(decision?.reasonCodes) ? decision.reasonCodes : []), "invalid_order_action"])],
            unexecutedSignal: { reasonCode: "invalid_order_action" },
          };
          rawOrder = null;
          record("decision_invalid", at, { reasonCode: "invalid_order_action" });
        } else if (nestedAction === undefined) {
          rawOrder = { ...rawOrder, action: resolvedAction };
          decision = withDecisionOrder(decision, rawOrder);
        }
      }
      if (rawOrder?.side === "buy" && riskPolicy && typeof riskPolicy.evaluate === "function") {
        const bid = markBid(path, current);
        const ask = sideBar(path, "buy")?.close ?? null;
        let riskResult;
        try {
          riskResult = riskPolicy.evaluate({
            side: "buy",
            action: rawOrder.action ?? decision?.action,
            grams: rawOrder.grams,
            fixedGrams: rawOrder.grams,
            currentGrams: portfolio.grams,
            executableAsk: ask,
            executableBid: bid,
            suggestedPrice: rawOrder.limitPrice ?? rawOrder.cmbEstimatedPrice ?? rawOrder.price,
            atrPerGram: rawOrder.atrPerGram ?? decision?.atrPerGram,
            unrealizedPnlCny: bid === null ? null : portfolio.grams * bid - portfolio.costBasisCny,
            ledgerSummary: summarizeReplayRiskLedger(fills, portfolio, at, bid),
            asOf: at,
          });
        } catch (error) {
          riskResult = { allowed: false, suggestedGrams: 0, reasonCodes: ["risk_policy_error"], error: String(error?.message ?? error) };
        }
        effectiveDiagnostics.push({ type: "risk_policy", value: stableValue(riskResult) });
        const allowedGrams = Math.min(Number(rawOrder.grams) || 0, Number(riskResult?.suggestedGrams) || 0);
        if (riskResult?.allowed !== true || !(allowedGrams > 0)) {
          const riskReasons = Array.isArray(riskResult?.reasonCodes) && riskResult.reasonCodes.length > 0
            ? riskResult.reasonCodes : ["risk_policy_blocked"];
          effectiveSuppressedSignals.push(...riskReasons.map((code) => ({ code, status: "suppressed", source: "risk_policy" })));
          decision = {
            ...withDecisionOrder(decision, null),
            reasonCodes: [...new Set([...(Array.isArray(decision?.reasonCodes) ? decision.reasonCodes : []), ...riskReasons])],
            unexecutedSignal: {
              reasonCode: riskReasons[0],
              signalPrice: decision?.signalPrice ?? null,
              limitPrice: rawOrder.limitPrice ?? rawOrder.cmbEstimatedPrice ?? rawOrder.price ?? null,
            },
          };
          rawOrder = null;
        } else if (allowedGrams !== Number(rawOrder.grams)) {
          rawOrder = { ...rawOrder, grams: allowedGrams };
          decision = withDecisionOrder(decision, rawOrder);
        }
      }
      const evaluationTrace = {
        at,
        strategyId: strategy?.strategyId ?? null,
        strategyVersion: strategy?.strategyVersion ?? null,
        decision: evaluationDecision(decision),
        valuation: evaluationValuation(evaluation?.valuation),
        nextStateFingerprint: sha256(canonicalJson(state)),
        activeSignals: stableValue(evaluation?.activeSignals ?? decision?.activeSignals ?? []),
        suppressedSignals: effectiveSuppressedSignals,
        diagnostics: effectiveDiagnostics,
      };
      collectStrategyFacts(strategyFacts, evaluationTrace);
      if (evaluations.length < REPLAY_EVALUATION_TRACE_LIMIT) evaluations.push(evaluationTrace);
      else {
        evaluations[evaluationTracesDropped % REPLAY_EVALUATION_TRACE_LIMIT] = evaluationTrace;
        evaluationTracesDropped += 1;
      }
      if (decision && typeof decision === "object") {
        const decisionRecord = {
          decisionId: deterministicId("replay-decision", {
            inputFingerprint: fingerprint,
            at,
            action: decision.action ?? null,
            order: rawOrder ?? null,
            sequence: decisions.length + 1,
          }),
          at,
          action: decision.action ?? null,
          lane: current.lane ?? null,
          session: current.session ?? current.day ?? null,
          activeSignals: stableValue(evaluation?.activeSignals ?? decision.activeSignals ?? []),
          suppressedSignals: stableValue(effectiveSuppressedSignals),
          reasonCodes: stableValue(decision.reasonCodes ?? []),
          status: rawOrder ? "order_candidate" : "not_executed",
        };
        decisions.push(decisionRecord);
        record("strategy_decision", at, { decisionId: decisionRecord.decisionId, status: decisionRecord.status });
        if (!rawOrder && (decisionRecord.suppressedSignals.length > 0 || decision.unexecutedSignal)) {
          unexecutedSignals.push({
            ...decisionRecord,
            status: "not_executed",
            reasonCode: decision.unexecutedSignal?.reasonCode ?? decisionRecord.reasonCodes[0] ?? "strategy_suppressed",
            signalPrice: finite(decision.unexecutedSignal?.signalPrice ?? decision.signalPrice),
            limitPrice: finite(decision.unexecutedSignal?.limitPrice),
            positionBeforeGrams: portfolio.grams,
            maxGrams: portfolio.maxGrams,
          });
        }
      }
      if (rawOrder) {
        sequence += 1;
        const candidate = normalizeOrder(rawOrder, current.timestampMs, sequence, fingerprint, fillPolicy);
        if (!candidate) {
          diagnostics.invalidDecisions += 1;
          record("decision_invalid", at);
        } else {
          for (let index = pendingOrders.length - 1; index >= 0; index -= 1) {
            const prior = pendingOrders[index];
            prior.status = "replaced";
            prior.replacedAt = at;
            prior.replacedBy = candidate.orderId;
            pendingOrders.splice(index, 1);
            record("order_replaced", at, { orderId: prior.orderId, replacementOrderId: candidate.orderId });
          }
          orders.push(candidate);
          if (candidate.validUntilMs !== null && candidate.validUntilMs <= current.timestampMs) {
            candidate.status = "expired";
            candidate.expiredAt = at;
            record("order_expired", at, { orderId: candidate.orderId, reasonCode: "validity_ended" });
          } else {
            pendingOrders.push(candidate);
            record("order_placed", at, { orderId: candidate.orderId });
            if (fillPolicy === "signal-close") {
              const match = evaluateOrder(candidate, path, current.timestampMs, ambiguityPolicy, fillPolicy);
              if (match.status === "filled") {
                settleFill(candidate, match, path, at, current);
                pendingOrders.splice(pendingOrders.indexOf(candidate), 1);
              } else if (match.status === "ambiguous" || match.status === "unknown") {
                candidate.status = match.status;
                candidate.resolvedAt = at;
                pendingOrders.splice(pendingOrders.indexOf(candidate), 1);
                if (match.status === "ambiguous") {
                  diagnostics.ambiguousFills += 1;
                  diagnostics.unresolvedEntryAmbiguities += 1;
                } else {
                  diagnostics.unknownExecutionPaths += 1;
                  if (match.reasonCode === "second_level_execution_path_unavailable") diagnostics.secondLevelPathsUnavailable += 1;
                }
                record(match.status === "ambiguous" ? "fill_ambiguous" : "execution_unknown", at, {
                  orderId: candidate.orderId,
                  reasonCode: match.reasonCode,
                });
              }
            }
          }
        }
      }

      const marked = markPortfolio(execution, portfolio, path, publicFrame(current), params);
      equityCurve.push({
        t: at,
        at,
        equity: marked.equity,
        markPrice: marked.markPrice,
        markBid: marked.markPrice,
        grams: portfolio.grams,
        exposureCny: marked.markPrice === null ? null : portfolio.grams * marked.markPrice,
        capitalUsedCny: portfolio.costBasisCny,
      });
      record(marked.available ? "portfolio_marked" : "mark_unknown", at, {
        equity: marked.equity,
        markPrice: marked.markPrice,
        grams: portfolio.grams,
      });
      yield null;
    }

    if (signal?.aborted) throw replayAbortError(signal.reason);
    if (evaluationTracesDropped > 0) {
      const oldestIndex = evaluationTracesDropped % REPLAY_EVALUATION_TRACE_LIMIT;
      evaluations.splice(0, evaluations.length, ...evaluations.slice(oldestIndex), ...evaluations.slice(0, oldestIndex));
    }
    diagnostics.evaluationTracesDropped = evaluationTracesDropped;
    diagnostics.unresolvedProtectiveBrackets = protectiveBrackets.filter((entry) => entry.status === "unresolved").length;
    const finalPending = [];
    for (const orderEntry of pendingOrders) {
      if (orderEntry.validUntilMs !== null && orderEntry.validUntilMs <= asOfMs) {
        orderEntry.status = "expired";
        orderEntry.expiredAt = asOf;
        record("order_expired", asOf, { orderId: orderEntry.orderId, reasonCode: "validity_ended_at_as_of" });
      } else {
        finalPending.push(orderEntry);
      }
    }
    pendingOrders.splice(0, pendingOrders.length, ...finalPending);

    const metrics = {
      orders: orders.length,
      fills: fills.length,
      pending: pendingOrders.length,
      expired: orders.filter((orderEntry) => orderEntry.status === "expired").length,
      replaced: orders.filter((orderEntry) => orderEntry.status === "replaced").length,
      ambiguous: orders.filter((orderEntry) => orderEntry.status === "ambiguous").length,
      rejected: orders.filter((orderEntry) => orderEntry.status === "rejected").length,
      fillRate: orders.length > 0 ? fills.length / orders.length : null,
    };
    return {
      simulatorVersion: REPLAY_SIMULATOR_VERSION,
      inputFingerprint: fingerprint,
      asOf,
      fillPolicy,
      ambiguityPolicy,
      framesProcessed: prepared.frames.length,
      evaluations,
      strategyFacts,
      decisions,
      orders,
      fills,
      pendingOrders: pendingOrders.slice(),
      protectiveBrackets: stableValue(protectiveBrackets),
      ledger,
      unexecuted: unexecutedSignals,
      unexecutedSignals,
      equityCurve,
      portfolio,
      metrics,
      diagnostics,
      nextState: state,
    };
  }

  run(input = {}) {
    const iterator = this._iterate(input);
    let step = iterator.next();
    while (!step.done) step = iterator.next();
    return step.value;
  }

  async runCooperative(input = {}) {
    const iterator = this._iterate(input);
    const yieldEvery = Math.min(4096, Math.max(1, Math.floor(Number(input.yieldEvery) || 128)));
    let framesSinceYield = 0;
    while (true) {
      if (input.signal?.aborted) throw replayAbortError(input.signal.reason);
      const step = iterator.next();
      if (step.done) return step.value;
      framesSinceYield += 1;
      if (framesSinceYield >= yieldEvery) {
        framesSinceYield = 0;
        await new Promise((resolve) => setImmediate(resolve));
      }
    }
  }
}

export function createReplaySimulator() {
  return new ReplaySimulator();
}

export function run(input) {
  return createReplaySimulator().run(input);
}
