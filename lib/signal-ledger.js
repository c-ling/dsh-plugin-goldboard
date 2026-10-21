/**
 * Durable setup, decision and advisory-order ledger.
 *
 * Position changes can confirm an existing suggestion, but an unattributed
 * manual edit is recorded only as an adjustment. The ledger never invents an
 * order or fill when a risk gate suppresses a decision.
 */

import { createHash } from "node:crypto";

import { round2 } from "./shared.js";

export const SIGNAL_LEDGER_VERSION = "goldboard-signal-ledger-v1";
export const SIGNAL_LEDGER_SCHEMA_VERSION = 1;
export const SIGNAL_LEDGER_CAPS = Object.freeze({
  setups: 200,
  decisions: 500,
  orders: 500,
  adjustments: 200,
});

const ORDER_STATUSES = new Set(["pending", "filled", "expired", "replaced"]);
const DECISION_STATUSES = new Set(["active", "pending", "not_executed"]);
const DIRECTIONAL_ACTIONS = new Set([
  "buy_setup",
  "add_position",
  "reduce_position",
  "sell_take_profit",
  "sell_target_trail",
  "sell_time_stop",
  "sell_trailing",
  "sell_stop",
  "sell_weakness",
  "close_by_session_end",
]);
const TRANSIENT_PLAN_ACTIONS = new Set(["data_stale", "data_incomplete", "no_data"]);

function finite(value, fallback = 0) {
  const number = Number(value);
  return Number.isFinite(number) ? number : fallback;
}

function nonNegative(value) {
  return Math.max(0, finite(value, 0));
}

function optionalFinite(value) {
  if (value === null || value === undefined || value === "") return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function optionalRound(value) {
  const number = optionalFinite(value);
  return number === null ? null : round2(number);
}

function cleanIso(value, fallback = null) {
  const parsed = Date.parse(value ?? "");
  if (Number.isFinite(parsed)) return new Date(parsed).toISOString();
  return fallback;
}

function asIso(value = new Date()) {
  const parsed = new Date(value);
  if (!Number.isFinite(parsed.getTime())) return new Date().toISOString();
  return parsed.toISOString();
}

function hashId(prefix, value) {
  return `${prefix}-${createHash("sha256").update(String(value)).digest("hex").slice(0, 16)}`;
}

function capNewest(entries, cap) {
  return entries.slice(0, cap);
}

function cleanCodes(value) {
  if (!Array.isArray(value)) return [];
  return [...new Set(value.filter((entry) => typeof entry === "string" && entry !== "").slice(0, 64))];
}

function cleanSignals(value) {
  if (!Array.isArray(value)) return [];
  return value.slice(0, 64).map((entry) => {
    if (typeof entry === "string") return { code: entry };
    if (!entry || typeof entry !== "object") return null;
    return {
      ...(typeof entry.code === "string" ? { code: entry.code } : {}),
      ...(typeof entry.action === "string" ? { action: entry.action } : {}),
      ...(typeof entry.side === "string" ? { side: entry.side } : {}),
      ...(typeof entry.semantics === "string" ? { semantics: entry.semantics } : {}),
      ...(typeof entry.setupId === "string" ? { setupId: entry.setupId.slice(0, 96) } : {}),
      ...(typeof entry.phase === "string" ? { phase: entry.phase.slice(0, 32) } : {}),
      ...(typeof entry.status === "string" ? { status: entry.status.slice(0, 32) } : {}),
      reasonCodes: cleanCodes(entry.reasonCodes),
    };
  }).filter(Boolean);
}

function cleanSetup(entry) {
  if (!entry || typeof entry !== "object" || typeof entry.setupId !== "string") return null;
  return {
    setupId: entry.setupId.slice(0, 96),
    side: entry.side === "sell" ? "sell" : "buy",
    instrument: String(entry.instrument ?? "unknown").slice(0, 64),
    strategyId: String(entry.strategyId ?? "control").slice(0, 96),
    strategyVersion: String(entry.strategyVersion ?? "goldboard-control-v1").slice(0, 96),
    status: entry.status === "active" ? "active" : "closed",
    openedAt: cleanIso(entry.openedAt, new Date(0).toISOString()),
    closedAt: cleanIso(entry.closedAt),
    startBarT: optionalFinite(entry.startBarT),
    lastSeenAt: cleanIso(entry.lastSeenAt, cleanIso(entry.openedAt, new Date(0).toISOString())),
    addsFilled: Math.max(0, Math.floor(finite(entry.addsFilled, 0))),
    lastBuyFillPrice: optionalRound(entry.lastBuyFillPrice),
    lastBuyFillAt: cleanIso(entry.lastBuyFillAt),
  };
}

function cleanDecision(entry) {
  if (!entry || typeof entry !== "object" || typeof entry.decisionId !== "string") return null;
  return {
    decisionId: entry.decisionId.slice(0, 96),
    setupId: typeof entry.setupId === "string" ? entry.setupId.slice(0, 96) : null,
    idempotencyKey: typeof entry.idempotencyKey === "string" ? entry.idempotencyKey.slice(0, 160) : "",
    at: cleanIso(entry.at, new Date(0).toISOString()),
    signalBarT: optionalFinite(entry.signalBarT),
    instrument: String(entry.instrument ?? "unknown").slice(0, 64),
    strategyId: String(entry.strategyId ?? "control").slice(0, 96),
    strategyVersion: String(entry.strategyVersion ?? "goldboard-control-v1").slice(0, 96),
    side: entry.side === "sell" ? "sell" : "buy",
    candidateAction: String(entry.candidateAction ?? "wait").slice(0, 64),
    action: String(entry.action ?? "wait").slice(0, 64),
    status: DECISION_STATUSES.has(entry.status) ? entry.status : "not_executed",
    activeSignals: cleanSignals(entry.activeSignals),
    suppressedSignals: cleanSignals(entry.suppressedSignals),
    reasonCodes: cleanCodes(entry.reasonCodes),
    blockedReasonCodes: cleanCodes(entry.blockedReasonCodes),
    positionGrams: round2(nonNegative(entry.positionGrams)),
    nominalAmountCny: optionalRound(entry.nominalAmountCny),
    availableRiskBudgetCny: optionalRound(entry.availableRiskBudgetCny),
    suggestedGrams: round2(nonNegative(entry.suggestedGrams)),
    orderId: typeof entry.orderId === "string" ? entry.orderId.slice(0, 96) : null,
    risk: entry.risk && typeof entry.risk === "object" ? entry.risk : null,
  };
}

function cleanOrder(entry) {
  if (!entry || typeof entry !== "object" || typeof entry.orderId !== "string") return null;
  const grams = round2(nonNegative(entry.grams));
  const requestedStatus = ORDER_STATUSES.has(entry.status) ? entry.status : "expired";
  return {
    orderId: entry.orderId.slice(0, 96),
    setupId: typeof entry.setupId === "string" ? entry.setupId.slice(0, 96) : null,
    decisionId: typeof entry.decisionId === "string" ? entry.decisionId.slice(0, 96) : null,
    action: String(entry.action ?? "buy_setup").slice(0, 64),
    instrument: String(entry.instrument ?? "unknown").slice(0, 64),
    strategyId: String(entry.strategyId ?? "control").slice(0, 96),
    strategyVersion: String(entry.strategyVersion ?? "goldboard-control-v1").slice(0, 96),
    side: entry.side === "sell" ? "sell" : "buy",
    status: requestedStatus === "pending" && grams <= 0 ? "expired" : requestedStatus,
    statusReason: typeof entry.statusReason === "string"
      ? entry.statusReason.slice(0, 96)
      : requestedStatus === "pending" && grams <= 0 ? "invalid_order_size" : null,
    signalPrice: optionalRound(entry.signalPrice),
    limitPrice: optionalRound(entry.limitPrice ?? entry.cmbEstimatedPrice),
    grams,
    issuedAt: cleanIso(entry.issuedAt, new Date(0).toISOString()),
    updatedAt: cleanIso(entry.updatedAt, cleanIso(entry.issuedAt, new Date(0).toISOString())),
    validUntil: cleanIso(entry.validUntil),
    completedAt: cleanIso(entry.completedAt),
    filledAt: cleanIso(entry.filledAt),
    filledGrams: optionalFinite(entry.filledGrams) === null ? null : round2(nonNegative(entry.filledGrams)),
    fillPrice: optionalRound(entry.fillPrice),
    fillEvidence: typeof entry.fillEvidence === "string" ? entry.fillEvidence.slice(0, 96) : null,
    realizedPnlCny: optionalRound(entry.realizedPnlCny),
    issuedPositionGrams: optionalRound(entry.issuedPositionGrams),
    issuedAvgCostPerGram: optionalRound(entry.issuedAvgCostPerGram),
    risk: entry.risk && typeof entry.risk === "object" ? entry.risk : null,
    provenance: typeof entry.provenance === "string" ? entry.provenance.slice(0, 96) : "live",
  };
}

function cleanAdjustment(entry) {
  if (!entry || typeof entry !== "object" || typeof entry.adjustmentId !== "string") return null;
  return {
    adjustmentId: entry.adjustmentId.slice(0, 96),
    at: cleanIso(entry.at, new Date(0).toISOString()),
    source: typeof entry.source === "string" ? entry.source.slice(0, 96) : "manual_config",
    direction: entry.direction === "sell" ? "sell" : entry.direction === "cost_basis" ? "cost_basis" : "buy",
    gramsBefore: round2(nonNegative(entry.gramsBefore)),
    gramsAfter: round2(nonNegative(entry.gramsAfter)),
    deltaGrams: round2(nonNegative(entry.deltaGrams)),
    attributedOrderId: typeof entry.attributedOrderId === "string" ? entry.attributedOrderId.slice(0, 96) : null,
    reasonCode: typeof entry.reasonCode === "string" ? entry.reasonCode.slice(0, 96) : "manual_position_adjustment",
    setupId: typeof entry.setupId === "string" ? entry.setupId.slice(0, 96) : null,
    kind: entry.kind === "add" ? "add" : entry.kind === "reduce" ? "reduce" : entry.kind === "cost_basis" ? "cost_basis" : "adjustment",
  };
}

export function createSignalLedger() {
  return {
    version: SIGNAL_LEDGER_VERSION,
    schemaVersion: SIGNAL_LEDGER_SCHEMA_VERSION,
    integrity: "ok",
    sequence: 0,
    activeSetupId: null,
    setups: [],
    decisions: [],
    orders: [],
    adjustments: [],
    positionAnchor: {
      grams: null,
      avgCostPerGram: null,
      observedAt: null,
    },
  };
}

/** Normalize untrusted persisted state and bound every in-state history. */
export function normalizeSignalLedger(value) {
  const hasObjectInput = !!value && typeof value === "object" && !Array.isArray(value);
  const source = hasObjectInput ? value : {};
  const unsupportedVersion = source.integrity === "unsupported_version"
    || hasObjectInput && (source.version !== SIGNAL_LEDGER_VERSION || Number(source.schemaVersion) !== SIGNAL_LEDGER_SCHEMA_VERSION);
  const setups = capNewest((Array.isArray(source.setups) ? source.setups : []).map(cleanSetup).filter(Boolean), SIGNAL_LEDGER_CAPS.setups);
  const decisions = capNewest((Array.isArray(source.decisions) ? source.decisions : []).map(cleanDecision).filter(Boolean), SIGNAL_LEDGER_CAPS.decisions);
  const orders = capNewest((Array.isArray(source.orders) ? source.orders : []).map(cleanOrder).filter(Boolean), SIGNAL_LEDGER_CAPS.orders);
  const adjustments = capNewest((Array.isArray(source.adjustments) ? source.adjustments : []).map(cleanAdjustment).filter(Boolean), SIGNAL_LEDGER_CAPS.adjustments);
  const activeSetupId = typeof source.activeSetupId === "string" && setups.some((setup) => setup.setupId === source.activeSetupId && setup.status === "active")
    ? source.activeSetupId
    : null;
  const anchor = source.positionAnchor && typeof source.positionAnchor === "object" ? source.positionAnchor : {};
  return {
    version: SIGNAL_LEDGER_VERSION,
    schemaVersion: SIGNAL_LEDGER_SCHEMA_VERSION,
    integrity: unsupportedVersion ? "unsupported_version" : "ok",
    sequence: Math.min(Number.MAX_SAFE_INTEGER - 1, Math.max(0, Math.floor(finite(source.sequence, 0)))),
    activeSetupId,
    setups,
    decisions,
    orders,
    adjustments,
    positionAnchor: {
      grams: anchor.grams !== null && anchor.grams !== undefined && Number.isFinite(Number(anchor.grams))
        ? round2(nonNegative(anchor.grams))
        : null,
      avgCostPerGram: anchor.avgCostPerGram !== null && anchor.avgCostPerGram !== undefined && Number.isFinite(Number(anchor.avgCostPerGram))
        ? round2(nonNegative(anchor.avgCostPerGram))
        : null,
      observedAt: cleanIso(anchor.observedAt),
    },
  };
}

function nextId(ledger, prefix, seed) {
  ledger.sequence += 1;
  return hashId(prefix, `${seed}|${ledger.sequence}`);
}

function activeSetup(ledger) {
  return ledger.setups.find((setup) => setup.setupId === ledger.activeSetupId && setup.status === "active") ?? null;
}

function closeActiveSetup(ledger, at) {
  const setup = activeSetup(ledger);
  if (!setup) {
    ledger.activeSetupId = null;
    return false;
  }
  setup.status = "closed";
  setup.closedAt = at;
  setup.lastSeenAt = at;
  ledger.activeSetupId = null;
  return true;
}

function setupForCandidate(ledger, candidate, plan, at) {
  const side = candidate.side === "sell" ? "sell" : "buy";
  const instrument = String(plan.instrument ?? candidate.instrument ?? "unknown");
  const strategyId = String(plan.strategyId ?? "control");
  const strategyVersion = String(plan.strategyVersion ?? "goldboard-control-v1");
  const current = activeSetup(ledger);
  if (current && current.side === side && current.instrument === instrument
    && current.strategyId === strategyId && current.strategyVersion === strategyVersion) {
    return { setup: current, created: false };
  }
  if (current) closeActiveSetup(ledger, at);
  const startBarT = Number.isFinite(Number(plan.signalBarT)) ? Number(plan.signalBarT) : null;
  const setupId = nextId(ledger, "setup", `${strategyId}|${strategyVersion}|${instrument}|${side}|${startBarT ?? at}`);
  const setup = {
    setupId,
    side,
    instrument,
    strategyId,
    strategyVersion,
    status: "active",
    openedAt: at,
    closedAt: null,
    startBarT,
    lastSeenAt: at,
    addsFilled: 0,
    lastBuyFillPrice: null,
    lastBuyFillAt: null,
  };
  ledger.setups.unshift(setup);
  ledger.setups = capNewest(ledger.setups, SIGNAL_LEDGER_CAPS.setups);
  ledger.activeSetupId = setupId;
  return { setup, created: true };
}

function candidateFromPlan(plan) {
  if (plan?.signalCandidate && typeof plan.signalCandidate === "object") {
    const side = plan.signalCandidate.side === "sell" ? "sell" : plan.signalCandidate.side === "buy" ? "buy" : null;
    if (side) return { ...plan.signalCandidate, side };
  }
  const action = DIRECTIONAL_ACTIONS.has(plan?.candidateAction) ? plan.candidateAction : plan?.action;
  if (!DIRECTIONAL_ACTIONS.has(action)) return null;
  const side = action === "buy_setup" || action === "add_position" ? "buy" : "sell";
  return { action, side, instrument: plan.instrument };
}

function decisionKey(plan, candidate, setupId, at, transition, previousOrder) {
  const barKey = Number.isFinite(Number(plan.signalBarT)) ? Number(plan.signalBarT) : Math.floor(Date.parse(at) / 300_000) * 300_000;
  const blocked = cleanCodes(plan?.risk?.reasonCodes ?? plan?.risk?.gate?.reasonCodes).sort().join(",");
  const materialOrderKey = transition?.event === "update"
    ? `${previousOrder?.orderId ?? "legacy"}:${optionalRound(plan?.signalCandidate?.limitPrice ?? plan?.suggestedOrder?.cmbEstimatedPrice ?? plan?.suggestedOrder?.price)}`
    : "";
  return [
    setupId,
    barKey,
    candidate.action,
    plan.action,
    round2(nonNegative(plan?.position?.grams ?? plan?.positionGrams)),
    round2(nonNegative(plan?.grams)),
    materialOrderKey,
    blocked,
  ].join("|");
}

function pendingOrderCandidates(ledger, previousOrder) {
  if (typeof previousOrder?.orderId === "string") {
    return ledger.orders.filter((order) => order.orderId === previousOrder.orderId && order.status === "pending");
  }
  return ledger.orders.filter((order) => order.status === "pending"
    && (!previousOrder?.side || order.side === previousOrder.side)
    && (!previousOrder?.action || order.action === previousOrder.action));
}

function findPendingOrder(ledger, previousOrder) {
  return pendingOrderCandidates(ledger, previousOrder)[0] ?? null;
}

function completeOrder(order, status, reason, at) {
  if (!order || order.status !== "pending") return false;
  order.status = status;
  order.statusReason = reason;
  order.completedAt = at;
  order.updatedAt = at;
  return true;
}

function createOrder(ledger, plan, decision, at, config) {
  const source = plan.suggestedOrder;
  if (!source || !(Number(source.grams) > 0)) return { order: null, created: false };
  const existing = ledger.orders.find((order) => order.decisionId === decision.decisionId && order.status === "pending");
  if (existing) {
    attachExistingOrder(plan, decision, existing);
    return { order: existing, created: false };
  }
  const orderId = nextId(ledger, "order", `${decision.decisionId}|${source.side}|${source.cmbEstimatedPrice}|${source.grams}`);
  const order = cleanOrder({
    orderId,
    setupId: decision.setupId,
    decisionId: decision.decisionId,
    action: source.action ?? decision.candidateAction,
    instrument: source.instrument ?? plan.instrument,
    strategyId: plan.strategyId,
    strategyVersion: plan.strategyVersion,
    side: source.side,
    status: "pending",
    signalPrice: source.signalPrice,
    limitPrice: source.cmbEstimatedPrice ?? source.price,
    grams: source.grams,
    issuedAt: source.issuedAt ?? at,
    updatedAt: at,
    validUntil: source.validUntil,
    issuedPositionGrams: config?.position?.grams,
    issuedAvgCostPerGram: config?.position?.avgCostPerGram,
    risk: source.risk ?? plan.risk ?? null,
    provenance: "live",
  });
  ledger.orders.unshift(order);
  ledger.orders = capNewest(ledger.orders, SIGNAL_LEDGER_CAPS.orders);
  plan.suggestedOrder = {
    ...source,
    orderId,
    setupId: decision.setupId,
    decisionId: decision.decisionId,
    issuedPositionGrams: order.issuedPositionGrams,
    issuedAvgCostPerGram: order.issuedAvgCostPerGram,
  };
  decision.orderId = orderId;
  return { order, created: true };
}

function attachExistingOrder(plan, decision, order) {
  if (!plan.suggestedOrder || !order) return;
  plan.suggestedOrder = {
    ...plan.suggestedOrder,
    orderId: order.orderId,
    setupId: order.setupId ?? decision.setupId,
    decisionId: order.decisionId ?? decision.decisionId,
    issuedPositionGrams: order.issuedPositionGrams,
    issuedAvgCostPerGram: order.issuedAvgCostPerGram,
  };
  decision.orderId = order.orderId;
}

function refreshPendingOrder(plan, decision, order, at) {
  if (!plan.suggestedOrder || !order) return false;
  const source = plan.suggestedOrder;
  const nextSignalPrice = optionalRound(source.signalPrice);
  const nextLimitPrice = optionalRound(source.cmbEstimatedPrice ?? source.price);
  const nextGrams = round2(nonNegative(source.grams));
  const nextRisk = source.risk ?? plan.risk ?? null;
  const material = order.signalPrice !== nextSignalPrice
    || order.limitPrice !== nextLimitPrice
    || order.grams !== nextGrams
    || JSON.stringify(order.risk) !== JSON.stringify(nextRisk);
  order.signalPrice = nextSignalPrice;
  order.limitPrice = nextLimitPrice;
  order.grams = nextGrams;
  order.validUntil = cleanIso(source.validUntil);
  order.risk = nextRisk;
  if (material) order.updatedAt = at;
  attachExistingOrder(plan, decision, order);
  return material;
}

/**
 * Record one plan decision and the matching order transition. Replaying the
 * same setup/bar/result reuses the previous decision and order identifiers.
 */
export function recordLedgerDecision(value, input = {}) {
  const ledger = normalizeSignalLedger(value);
  const plan = input.plan;
  if (!plan || typeof plan !== "object") return { ledger, plan, changed: false, effects: [] };
  const at = asIso(input.asOf);
  const candidate = candidateFromPlan(plan);
  let changed = false;
  const effects = [];
  let setup = activeSetup(ledger);
  const transition = input.transition && typeof input.transition === "object" ? input.transition : { event: plan.suggestedOrder ? "record" : null };
  const previous = findPendingOrder(ledger, input.previousOrder);

  if (candidate) {
    const selected = setupForCandidate(ledger, candidate, plan, at);
    setup = selected.setup;
    changed ||= selected.created;
    plan.setupId = setup.setupId;
  } else if (!TRANSIENT_PLAN_ACTIONS.has(plan.action) && !(transition.event === "hold" && previous)) {
    changed ||= closeActiveSetup(ledger, at);
    setup = null;
  }

  if (["clear_fill", "clear_expired", "clear_closed", "cancel", "cancel_drift"].includes(transition.event)) {
    const reason = transition.event === "clear_fill" ? "position_changed_unattributed"
      : transition.event === "clear_expired" ? "expired"
        : transition.event === "clear_closed" ? "market_closed"
          : transition.event === "cancel_drift" ? "price_drift"
            : transition.cause === "conflict" ? "direction_conflict"
              : transition.cause === "risk_gate" ? "risk_gate" : "superseded";
    if (completeOrder(previous, "expired", reason, at)) {
      changed = true;
      effects.push({ type: "order_expired", orderId: previous.orderId, reason });
    }
  }

  if (!candidate || !setup) return { ledger, plan, changed, effects };

  const idempotencyKey = decisionKey(plan, candidate, setup.setupId, at, transition, input.previousOrder);
  let decision = ledger.decisions.find((entry) => entry.idempotencyKey === idempotencyKey) ?? null;
  let decisionCreated = false;
  if (!decision) {
    setup.lastSeenAt = at;
    const blockedReasonCodes = cleanCodes(plan?.risk?.reasonCodes ?? plan?.risk?.gate?.reasonCodes);
    const hasOrder = !!plan.suggestedOrder && Number(plan.suggestedOrder.grams) > 0;
    const status = hasOrder ? "pending" : blockedReasonCodes.length > 0 || plan.action !== candidate.action ? "not_executed" : "active";
    const decisionId = nextId(ledger, "decision", idempotencyKey);
    decision = cleanDecision({
      decisionId,
      setupId: setup.setupId,
      idempotencyKey,
      at,
      signalBarT: plan.signalBarT,
      instrument: plan.instrument,
      strategyId: plan.strategyId,
      strategyVersion: plan.strategyVersion,
      side: candidate.side,
      candidateAction: candidate.action,
      action: plan.action,
      status,
      activeSignals: plan.activeSignals,
      suppressedSignals: plan.suppressedSignals,
      reasonCodes: plan.reasonCodes,
      blockedReasonCodes,
      positionGrams: input.config?.position?.grams,
      nominalAmountCny: plan.risk?.nominalAmountCny
        ?? (optionalFinite(candidate.limitPrice) !== null ? round2(optionalFinite(candidate.limitPrice) * nonNegative(candidate.grams)) : null),
      availableRiskBudgetCny: plan.risk?.availableRiskBudgetCny,
      suggestedGrams: plan.risk?.suggestedGrams ?? candidate.grams ?? plan.grams,
      risk: plan.risk ?? null,
    });
    ledger.decisions.unshift(decision);
    ledger.decisions = capNewest(ledger.decisions, SIGNAL_LEDGER_CAPS.decisions);
    decisionCreated = true;
    changed = true;
    effects.push({ type: "decision_recorded", decisionId, status });
  }
  plan.decisionId = decision.decisionId;
  plan.setupId = decision.setupId;

  if (!decisionCreated && (transition.event === "record" || transition.event === "update") && decision.orderId) {
    const existingOrder = ledger.orders.find((order) => order.orderId === decision.orderId) ?? null;
    if (existingOrder && plan.suggestedOrder) attachExistingOrder(plan, decision, existingOrder);
    return { ledger, plan, changed, effects };
  }

  if (transition.event === "update") {
    if (completeOrder(previous, "replaced", "order_updated", at)) {
      changed = true;
      effects.push({ type: "order_replaced", orderId: previous.orderId });
    }
    const created = createOrder(ledger, plan, decision, at, input.config);
    if (created.created) {
      changed = true;
      effects.push({ type: "order_pending", orderId: created.order.orderId });
    }
  } else if (transition.event === "refresh") {
    if (previous) {
      const orderChanged = refreshPendingOrder(plan, decision, previous, at);
      changed = changed || orderChanged;
    } else {
      const created = createOrder(ledger, plan, decision, at, input.config);
      if (created.created) {
        changed = true;
        effects.push({ type: "order_pending", orderId: created.order.orderId });
      }
    }
  } else if (transition.event === "record" || transition.event === null && plan.suggestedOrder) {
    const created = createOrder(ledger, plan, decision, at, input.config);
    if (created.created) {
      changed = true;
      effects.push({ type: "order_pending", orderId: created.order.orderId });
    }
  } else if (transition.event === "hold" || transition.event === "clear_fill") {
    if (plan.suggestedOrder && previous) attachExistingOrder(plan, decision, previous);
  }

  return { ledger, plan, changed, effects };
}

function positionView(position = {}) {
  return {
    grams: round2(nonNegative(position.grams)),
    avgCostPerGram: round2(nonNegative(position.avgCostPerGram)),
  };
}

function realizedPnlForConfirmedSell(order, grams, config) {
  const fillPrice = finite(order.limitPrice, NaN);
  const entryPrice = finite(order.issuedAvgCostPerGram, NaN);
  if (!(fillPrice > 0) || !(entryPrice > 0) || !(grams > 0)) return null;
  // A configured-fee bid already embeds the sell fee; subtracting it again
  // would overstate the realized loss by that fee.
  const sellFee = config?.cmb?.deriveSellFromFee === true ? 0 : nonNegative(config?.fee?.sellPerGram);
  const sellNet = fillPrice - sellFee - nonNegative(config?.strategy?.slippagePerGram);
  const entryGross = entryPrice + nonNegative(config?.fee?.buyPerGram) + nonNegative(config?.strategy?.slippagePerGram);
  return round2((sellNet - entryGross) * grams);
}

function appendAdjustment(ledger, input) {
  const adjustmentId = nextId(ledger, "adjustment", `${input.at}|${input.direction}|${input.gramsBefore}|${input.gramsAfter}|${input.reasonCode}`);
  const adjustment = cleanAdjustment({ adjustmentId, ...input });
  ledger.adjustments.unshift(adjustment);
  ledger.adjustments = capNewest(ledger.adjustments, SIGNAL_LEDGER_CAPS.adjustments);
  return adjustment;
}

/**
 * Reconcile a manually observed position change. Only a uniquely matching,
 * exactly sized pending order becomes a confirmed fill; amount mismatches stay
 * unattributed adjustments.
 */
export function reconcileLedgerPosition(value, input = {}) {
  const ledger = normalizeSignalLedger(value);
  const at = asIso(input.asOf);
  const next = positionView(input.nextPosition ?? input.position);
  const anchor = ledger.positionAnchor;
  const baseline = anchor.grams !== null && anchor.grams !== undefined && Number.isFinite(Number(anchor.grams))
    ? { grams: Number(anchor.grams), avgCostPerGram: finite(anchor.avgCostPerGram, 0) }
    : input.previousPosition && Number.isFinite(Number(input.previousPosition.grams))
      ? positionView(input.previousPosition)
      : null;
  if (!baseline) {
    ledger.positionAnchor = { ...next, observedAt: at };
    return { ledger, changed: true, effects: [{ type: "position_baseline", grams: next.grams }] };
  }
  const signedDelta = round2(next.grams - baseline.grams);
  if (Math.abs(signedDelta) < 0.001) {
    const costChanged = baseline.avgCostPerGram !== next.avgCostPerGram;
    const effects = [];
    if (costChanged) {
      const adjustment = appendAdjustment(ledger, {
        at,
        source: input.source ?? "manual_config",
        direction: "cost_basis",
        gramsBefore: baseline.grams,
        gramsAfter: next.grams,
        deltaGrams: 0,
        attributedOrderId: null,
        reasonCode: "position_cost_basis_changed",
        setupId: activeSetup(ledger)?.setupId ?? null,
        kind: "cost_basis",
      });
      effects.push({ type: "position_adjusted", adjustmentId: adjustment.adjustmentId });
    }
    const changed = costChanged || anchor.grams !== next.grams;
    ledger.positionAnchor = { ...next, observedAt: at };
    return { ledger, changed, effects };
  }

  const direction = signedDelta > 0 ? "buy" : "sell";
  const deltaGrams = Math.abs(signedDelta);
  const pendingCandidates = pendingOrderCandidates(ledger, input.pendingOrder);
  const pending = pendingCandidates.length === 1 ? pendingCandidates[0] : null;
  const directionMatches = pending && pending.side === direction;
  const orderMatches = directionMatches && Math.abs(deltaGrams - pending.grams) < 0.011;
  const effects = [];
  let attributedGrams = 0;

  if (orderMatches) {
    attributedGrams = pending.grams;
    pending.status = "filled";
    pending.statusReason = "position_confirmed";
    pending.completedAt = at;
    pending.filledAt = at;
    pending.filledGrams = round2(attributedGrams);
    pending.fillPrice = pending.limitPrice;
    pending.fillEvidence = "user_position_confirmation";
    pending.realizedPnlCny = direction === "sell"
      ? realizedPnlForConfirmedSell(pending, attributedGrams, input.config)
      : null;
    pending.updatedAt = at;
    effects.push({ type: "order_filled", orderId: pending.orderId, side: direction, grams: attributedGrams });
    if (direction === "buy" && pending.action === "add_position" && pending.setupId) {
      const setup = ledger.setups.find((entry) => entry.setupId === pending.setupId);
      if (setup) {
        setup.addsFilled += 1;
        setup.lastBuyFillPrice = pending.fillPrice;
        setup.lastBuyFillAt = at;
      }
    }
  }

  const remainder = round2(Math.max(0, deltaGrams - attributedGrams));
  if (remainder > 0 || !orderMatches) {
    const amount = orderMatches ? remainder : deltaGrams;
    if (amount > 0) {
      const adjustment = appendAdjustment(ledger, {
        at,
        source: input.source ?? "manual_config",
        direction,
        gramsBefore: baseline.grams,
        gramsAfter: next.grams,
        deltaGrams: amount,
        attributedOrderId: orderMatches ? pending.orderId : null,
        reasonCode: pendingCandidates.length > 1
          ? "position_change_multiple_pending"
          : directionMatches ? "position_change_amount_mismatch" : "manual_position_adjustment",
        setupId: activeSetup(ledger)?.setupId ?? null,
        kind: direction === "buy" && baseline.grams > 0 ? "add" : direction === "sell" ? "reduce" : "adjustment",
      });
      effects.push({ type: "position_adjusted", adjustmentId: adjustment.adjustmentId });
    }
  }

  ledger.positionAnchor = { ...next, observedAt: at };
  return { ledger, changed: true, effects };
}

function beijingDateKey(value) {
  const parts = new Intl.DateTimeFormat("en", {
    timeZone: "Asia/Shanghai",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(new Date(value));
  const byType = Object.fromEntries(parts.map((part) => [part.type, part.value]));
  return `${byType.year}-${byType.month}-${byType.day}`;
}

function weekKey(dateKey) {
  const date = new Date(`${dateKey}T00:00:00.000Z`);
  const day = date.getUTCDay() || 7;
  date.setUTCDate(date.getUTCDate() - day + 1);
  return date.toISOString().slice(0, 10);
}

/** Risk-policy aggregates at one point in time. */
export function summarizeSignalLedger(value, options = {}) {
  const ledger = normalizeSignalLedger(value);
  const asOf = asIso(options.asOf);
  const asOfMs = Date.parse(asOf);
  const today = beijingDateKey(asOf);
  const week = weekKey(today);
  const filled = ledger.orders
    .filter((order) => order.status === "filled" && Number.isFinite(Date.parse(order.filledAt ?? "")) && Date.parse(order.filledAt) <= asOfMs)
    .sort((a, b) => Date.parse(a.filledAt) - Date.parse(b.filledAt));
  const realized = filled.filter((order) => Number.isFinite(Number(order.realizedPnlCny)));
  const totalRealizedPnlCny = round2(realized.reduce((sum, order) => sum + Number(order.realizedPnlCny), 0));
  const dailyRealizedPnlCny = round2(realized
    .filter((order) => beijingDateKey(order.filledAt) === today)
    .reduce((sum, order) => sum + Number(order.realizedPnlCny), 0));
  const weeklyRealizedPnlCny = round2(realized
    .filter((order) => weekKey(beijingDateKey(order.filledAt)) === week)
    .reduce((sum, order) => sum + Number(order.realizedPnlCny), 0));
  const dailyRealizedLossCny = round2(realized
    .filter((order) => beijingDateKey(order.filledAt) === today)
    .reduce((sum, order) => sum + Math.max(0, -Number(order.realizedPnlCny)), 0));
  const weeklyRealizedLossCny = round2(realized
    .filter((order) => weekKey(beijingDateKey(order.filledAt)) === week)
    .reduce((sum, order) => sum + Math.max(0, -Number(order.realizedPnlCny)), 0));
  let cumulative = 0;
  let peak = 0;
  for (const order of realized) {
    cumulative = round2(cumulative + Number(order.realizedPnlCny));
    peak = Math.max(peak, cumulative);
  }
  const unrealizedLossCny = Math.max(0, -finite(options.unrealizedPnlCny, 0));
  const realizedDrawdownCny = round2(Math.max(0, peak - cumulative));
  const drawdownCny = round2(realizedDrawdownCny + unrealizedLossCny);
  let consecutiveLosses = 0;
  for (let index = realized.length - 1; index >= 0; index -= 1) {
    const pnl = Number(realized[index].realizedPnlCny);
    if (pnl < 0) consecutiveLosses += 1;
    else if (pnl > 0) break;
  }
  const addsTodayFromOrders = filled.filter((order) => order.side === "buy" && order.action === "add_position" && beijingDateKey(order.filledAt) === today).length;
  const addsTodayFromAdjustments = ledger.adjustments.filter((entry) => entry.kind === "add" && beijingDateKey(entry.at) === today).length;
  const setup = activeSetup(ledger);
  const activeSetupAdjustmentAdds = setup
    ? ledger.adjustments.filter((entry) => entry.kind === "add" && entry.setupId === setup.setupId).length
    : 0;
  const latestBuyFill = [...filled].reverse().find((order) => order.side === "buy") ?? null;
  const latestManualAdd = ledger.adjustments
    .filter((entry) => entry.kind === "add")
    .sort((a, b) => Date.parse(b.at) - Date.parse(a.at))[0] ?? null;
  const lastBuyFillAt = [latestBuyFill?.filledAt, latestManualAdd?.at]
    .filter((entry) => Number.isFinite(Date.parse(entry ?? "")))
    .sort((a, b) => Date.parse(b) - Date.parse(a))[0] ?? setup?.lastBuyFillAt ?? null;
  const counts = {
    setups: ledger.setups.length,
    decisions: ledger.decisions.length,
    orders: ledger.orders.length,
    pending: ledger.orders.filter((order) => order.status === "pending").length,
    filled: ledger.orders.filter((order) => order.status === "filled").length,
    expired: ledger.orders.filter((order) => order.status === "expired").length,
    replaced: ledger.orders.filter((order) => order.status === "replaced").length,
    notExecuted: ledger.decisions.filter((decision) => decision.status === "not_executed").length,
    adjustments: ledger.adjustments.length,
  };
  return {
    version: SIGNAL_LEDGER_VERSION,
    integrity: ledger.integrity,
    asOf,
    tradingDay: today,
    week,
    activeSetupId: setup?.setupId ?? null,
    activeSetupAdds: (setup?.addsFilled ?? 0) + activeSetupAdjustmentAdds,
    activeSetupLastBuyPrice: setup?.lastBuyFillPrice ?? null,
    addsToday: addsTodayFromOrders + addsTodayFromAdjustments,
    lastBuyFillAt,
    consecutiveLosses,
    totalRealizedPnlCny,
    dailyRealizedPnlCny,
    weeklyRealizedPnlCny,
    dailyRealizedLossCny,
    weeklyRealizedLossCny,
    realizedDrawdownCny,
    unrealizedLossCny: round2(unrealizedLossCny),
    dailyLossCny: round2(dailyRealizedLossCny + unrealizedLossCny),
    weeklyLossCny: round2(weeklyRealizedLossCny + unrealizedLossCny),
    drawdownCny,
    peakRealizedPnlCny: round2(peak),
    lossIncludesUnrealized: true,
    riskEvidence: "local_advisory_ledger",
    counts,
  };
}

/** Bounded read-only wire projection. */
export function projectSignalLedger(value, options = {}) {
  const ledger = normalizeSignalLedger(value);
  const requestedLimit = options.limit === null || options.limit === undefined || options.limit === ""
    ? 100
    : finite(options.limit, 100);
  const limit = Math.max(1, Math.min(500, Math.floor(requestedLimit)));
  return {
    ok: true,
    version: SIGNAL_LEDGER_VERSION,
    schemaVersion: SIGNAL_LEDGER_SCHEMA_VERSION,
    integrity: ledger.integrity,
    summary: summarizeSignalLedger(ledger, options),
    setups: ledger.setups.slice(0, limit),
    decisions: ledger.decisions.slice(0, limit),
    orders: ledger.orders.slice(0, limit),
    adjustments: ledger.adjustments.slice(0, limit),
  };
}

/** Add a v2 lastSuggestedOrder as a legacy pending record without fake fills. */
export function migrateLegacySuggestedOrder(value, suggestedOrder) {
  const ledger = normalizeSignalLedger(value);
  if (!suggestedOrder || typeof suggestedOrder !== "object" || !(Number(suggestedOrder.grams) > 0)) return ledger;
  const seed = JSON.stringify({
    side: suggestedOrder.side,
    action: suggestedOrder.action,
    instrument: suggestedOrder.instrument,
    issuedAt: suggestedOrder.issuedAt,
    price: suggestedOrder.cmbEstimatedPrice,
    grams: suggestedOrder.grams,
  });
  const orderId = hashId("order-legacy", seed);
  if (ledger.orders.some((order) => order.orderId === orderId)) return ledger;
  ledger.orders.unshift(cleanOrder({
    orderId,
    setupId: null,
    decisionId: null,
    action: suggestedOrder.action,
    instrument: suggestedOrder.instrument,
    side: suggestedOrder.side,
    status: "pending",
    signalPrice: suggestedOrder.signalPrice,
    limitPrice: suggestedOrder.cmbEstimatedPrice,
    grams: suggestedOrder.grams,
    issuedAt: suggestedOrder.issuedAt ?? new Date(0).toISOString(),
    updatedAt: suggestedOrder.updatedAt ?? suggestedOrder.issuedAt ?? new Date(0).toISOString(),
    validUntil: suggestedOrder.validUntil,
    issuedPositionGrams: suggestedOrder.issuedPositionGrams,
    issuedAvgCostPerGram: suggestedOrder.issuedAvgCostPerGram,
    provenance: "legacy_state_v2",
  }));
  ledger.orders = capNewest(ledger.orders, SIGNAL_LEDGER_CAPS.orders);
  return ledger;
}
