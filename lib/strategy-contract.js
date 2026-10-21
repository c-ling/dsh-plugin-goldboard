import { createHash } from "node:crypto";

export const STRATEGY_INTERFACE_VERSION = "goldboard-strategy-interface-v1";
export const STRATEGY_ROLES = Object.freeze(["control", "experimental", "benchmark"]);
export const STRATEGY_SIGNAL_SEMANTICS = Object.freeze(["state_condition", "crossing_trigger", "state_machine"]);
export const STRATEGY_LANES = Object.freeze(["cmb", "xau", "au9999"]);

const KEBAB_ID = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const KEBAB_VERSION = /^[a-z0-9]+(?:-[a-z0-9]+)*-v[1-9][0-9]*$/;
const STRATEGY_ADAPTER_BRAND = Symbol("goldboard.strategy-adapter");
const STRATEGY_EVALUATION_KEYS = new Set([
  "decision", "valuation", "nextState", "activeSignals", "suppressedSignals", "diagnostics",
]);

function isPlainRecord(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function deepFreeze(value, seen = new Set()) {
  if (!value || typeof value !== "object" || seen.has(value)) return value;
  seen.add(value);
  for (const entry of Object.values(value)) deepFreeze(entry, seen);
  return Object.freeze(value);
}

function clone(value, name = "value") {
  try {
    return structuredClone(value);
  } catch {
    throw new TypeError(`${name} must be structured-cloneable`);
  }
}

function canonical(value) {
  if (value === null) return "null";
  if (typeof value === "number") return Number.isFinite(value) ? JSON.stringify(Object.is(value, -0) ? 0 : value) : "null";
  if (typeof value === "boolean" || typeof value === "string") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (!value || typeof value !== "object") return "null";
  return `{${Object.keys(value).filter((key) => value[key] !== undefined).sort()
    .map((key) => `${JSON.stringify(key)}:${canonical(value[key])}`).join(",")}}`;
}

function fingerprint(value) {
  return createHash("sha256").update(canonical(value)).digest("hex");
}

function exactEnum(value, allowed, name) {
  if (typeof value !== "string" || value !== value.toLowerCase() || !allowed.includes(value)) {
    throw new TypeError(`${name} must be one of: ${allowed.join(", ")}`);
  }
  return value;
}

function normalizeLanes(value) {
  if (!Array.isArray(value) || value.length === 0) throw new TypeError("lanes must be a non-empty array");
  const lanes = value.map((lane) => exactEnum(lane, STRATEGY_LANES, "lane"));
  if (new Set(lanes).size !== lanes.length) throw new TypeError("lanes must not contain duplicates");
  return lanes;
}

function normalizeIds(value, name) {
  if (value === undefined) return undefined;
  if (!Array.isArray(value)) throw new TypeError(`${name} must be an array`);
  if (value.some((entry) => typeof entry !== "string")) throw new TypeError(`${name} must contain strings`);
  const ids = [...value];
  if (ids.some((entry) => !KEBAB_ID.test(entry))) throw new TypeError(`${name} must contain lowercase kebab ids`);
  if (new Set(ids).size !== ids.length) throw new TypeError(`${name} must not contain duplicates`);
  return ids;
}

export function defineStrategyDescriptor(input = {}) {
  if (!input || typeof input !== "object" || Array.isArray(input)) throw new TypeError("strategy descriptor must be an object");
  const strategyId = String(input.strategyId ?? "");
  const strategyVersion = String(input.strategyVersion ?? "");
  if (!KEBAB_ID.test(strategyId)) throw new TypeError("strategyId must be a lowercase kebab id");
  if (!KEBAB_VERSION.test(strategyVersion)) throw new TypeError("strategyVersion must be a lowercase kebab version ending in -vN");
  const role = exactEnum(input.role, STRATEGY_ROLES, "role");
  const signalSemantics = exactEnum(input.signalSemantics, STRATEGY_SIGNAL_SEMANTICS, "signalSemantics");
  const lanes = normalizeLanes(input.lanes);
  const executionInstrument = typeof input.executionInstrument === "string" ? input.executionInstrument.trim() : "";
  if (!executionInstrument || executionInstrument !== input.executionInstrument) throw new TypeError("executionInstrument is required without surrounding whitespace");
  const requiredFeatures = normalizeIds(input.requiredFeatures, "requiredFeatures");
  const requiredFactors = normalizeIds(input.requiredFactors, "requiredFactors");
  const ablations = normalizeIds(input.ablations, "ablations");
  const parameterSchemaVersion = input.parameterSchemaVersion === undefined ? undefined : String(input.parameterSchemaVersion);
  if (parameterSchemaVersion !== undefined && !KEBAB_VERSION.test(parameterSchemaVersion)) {
    throw new TypeError("parameterSchemaVersion must be a lowercase kebab version ending in -vN");
  }
  const descriptor = {
    interfaceVersion: STRATEGY_INTERFACE_VERSION,
    strategyId,
    strategyVersion,
    role,
    lanes,
    executionInstrument,
    signalSemantics,
    ...(parameterSchemaVersion === undefined ? {} : { parameterSchemaVersion }),
    ...(requiredFeatures === undefined ? {} : { requiredFeatures }),
    ...(requiredFactors === undefined ? {} : { requiredFactors }),
    ...(ablations === undefined ? {} : { ablations }),
  };
  return deepFreeze({ ...descriptor, descriptorFingerprint: fingerprint(descriptor) });
}

function normalizeRecord(value, name) {
  if (value === undefined || value === null) return null;
  if (!isPlainRecord(value)) throw new TypeError(`${name} must be an object or null`);
  return clone(value, name);
}

function normalizeSignals(value, name) {
  if (value === undefined) return [];
  if (!Array.isArray(value)) throw new TypeError(`${name} must be an array`);
  const output = clone(value, name);
  if (output.some((entry) => !isPlainRecord(entry))) throw new TypeError(`${name} must contain objects`);
  return output;
}

function validateOrder(order, descriptor, name) {
  if (order === undefined || order === null) return;
  if (!isPlainRecord(order)) throw new TypeError(`${name} must be an object or null`);
  if (order.side !== "buy" && order.side !== "sell") throw new TypeError(`${name}.side must be buy or sell`);
  const grams = Number(order.grams);
  const limitPrice = Number(order.limitPrice ?? order.cmbEstimatedPrice ?? order.price);
  if (!Number.isFinite(grams) || grams <= 0) throw new TypeError(`${name}.grams must be finite and positive`);
  if (!Number.isFinite(limitPrice) || limitPrice <= 0) throw new TypeError(`${name}.limitPrice must be finite and positive`);
  const instrumentMatches = !descriptor || order.instrument === descriptor.executionInstrument
    || (descriptor.executionInstrument === "CMB_ACCUMULATED_GOLD" && order.instrument === "CMB");
  if (!instrumentMatches) throw new TypeError(`${name}.instrument must match descriptor.executionInstrument`);
  for (const field of ["targetPrice", "stopPrice", "atrPerGram"]) {
    if (order[field] !== undefined && order[field] !== null
      && (!Number.isFinite(Number(order[field])) || Number(order[field]) <= 0)) {
      throw new TypeError(`${name}.${field} must be finite and positive`);
    }
  }
  if (order.validUntil !== undefined && order.validUntil !== null && !Number.isFinite(Date.parse(order.validUntil))) {
    throw new TypeError(`${name}.validUntil must be a valid timestamp`);
  }
}

export function strategyActionSide(action) {
  if (["buy", "buy_setup", "add_position"].includes(action)) return "buy";
  if (["sell", "sell_take_profit", "sell_target_trail", "sell_time_stop", "sell_trailing", "sell_stop", "sell_weakness", "reduce_position",
    "close_by_session_end", "take_profit", "stop_loss"].includes(action)) return "sell";
  return null;
}

function validateDecision(decision, descriptor) {
  if (!decision) return;
  if (descriptor) {
    if (decision.strategyId !== undefined && decision.strategyId !== descriptor.strategyId) {
      throw new TypeError("decision.strategyId must match the strategy descriptor");
    }
    if (decision.strategyVersion !== undefined && decision.strategyVersion !== descriptor.strategyVersion) {
      throw new TypeError("decision.strategyVersion must match the strategy descriptor");
    }
    if (decision.executionInstrument !== undefined && decision.executionInstrument !== descriptor.executionInstrument) {
      throw new TypeError("decision.executionInstrument must match the strategy descriptor");
    }
    if (decision.signalLane !== undefined && decision.signalLane !== null
      && !descriptor.lanes.includes(String(decision.signalLane).toLowerCase())) {
      throw new TypeError("decision.signalLane must be supported by the strategy descriptor");
    }
  }
  if (!Object.hasOwn(decision, "order") && !Object.hasOwn(decision, "suggestedOrder")
    && ["side", "grams", "quantity", "limitPrice", "price", "cmbEstimatedPrice", "instrument"]
      .some((key) => Object.hasOwn(decision, key))) {
    throw new TypeError("executable decision fields must be nested in decision.order or decision.suggestedOrder");
  }
  if (decision.order && decision.suggestedOrder && canonical(decision.order) !== canonical(decision.suggestedOrder)) {
    throw new TypeError("decision.order and decision.suggestedOrder must not conflict");
  }
  for (const [name, order] of [["decision.order", decision.order], ["decision.suggestedOrder", decision.suggestedOrder]]) {
    validateOrder(order, descriptor, name);
    if (!order) continue;
    if (decision.action !== undefined && order.action !== undefined && decision.action !== order.action) {
      throw new TypeError(`${name}.action must match decision.action`);
    }
    const side = strategyActionSide(order.action ?? decision.action);
    if (side === null) throw new TypeError(`${name}.action must resolve to an executable buy or sell action`);
    if (order.side !== side) throw new TypeError(`${name}.side conflicts with its action`);
  }
}

export function normalizeStrategyEvaluation(value = {}, descriptor = null) {
  if (!isPlainRecord(value)) throw new TypeError("strategy evaluation must be an object");
  const unknownKeys = Object.keys(value).filter((key) => !STRATEGY_EVALUATION_KEYS.has(key));
  if (unknownKeys.length > 0) throw new TypeError(`strategy evaluation contains unknown fields: ${unknownKeys.join(", ")}`);
  const decision = normalizeRecord(value.decision, "decision");
  validateDecision(decision, descriptor);
  return deepFreeze({
    decision,
    valuation: normalizeRecord(value.valuation, "valuation"),
    nextState: normalizeRecord(value.nextState, "nextState"),
    activeSignals: normalizeSignals(value.activeSignals, "activeSignals"),
    suppressedSignals: normalizeSignals(value.suppressedSignals, "suppressedSignals"),
    diagnostics: normalizeSignals(value.diagnostics, "diagnostics"),
  });
}

export function strategyIdentity(adapter) {
  if (!adapter || typeof adapter !== "object") throw new TypeError("strategy adapter is required");
  const descriptor = defineStrategyDescriptor(adapter.descriptor ?? adapter);
  const adapterFingerprint = String(adapter.adapterFingerprint ?? "");
  if (!/^[a-z0-9]+(?:[a-z0-9._:-]*[a-z0-9])?$/.test(adapterFingerprint)) {
    throw new TypeError("adapterFingerprint must be an explicit lowercase stable identity");
  }
  return {
    interfaceVersion: STRATEGY_INTERFACE_VERSION,
    strategyId: descriptor.strategyId,
    strategyVersion: descriptor.strategyVersion,
    role: descriptor.role,
    descriptorFingerprint: descriptor.descriptorFingerprint,
    adapterFingerprint,
  };
}

export function isStrategyAdapter(value) {
  return Boolean(value && typeof value === "object" && value[STRATEGY_ADAPTER_BRAND] === true);
}

export function createStrategyAdapter({ descriptor, evaluate, adapterFingerprint } = {}) {
  const normalizedDescriptor = defineStrategyDescriptor(descriptor);
  if (typeof evaluate !== "function") throw new TypeError("evaluate must be a function");
  const identity = strategyIdentity({ descriptor: normalizedDescriptor, adapterFingerprint });
  const adapter = {
    descriptor: normalizedDescriptor,
    strategyId: normalizedDescriptor.strategyId,
    strategyVersion: normalizedDescriptor.strategyVersion,
    adapterFingerprint: identity.adapterFingerprint,
    descriptorFingerprint: normalizedDescriptor.descriptorFingerprint,
    evaluate(input = {}) {
      const safeInput = deepFreeze(clone(input, "strategy input"));
      const result = evaluate(safeInput);
      if (result && typeof result.then === "function") {
        throw new TypeError("strategy evaluate must be synchronous");
      }
      return normalizeStrategyEvaluation(result ?? {}, normalizedDescriptor);
    },
  };
  Object.defineProperty(adapter, STRATEGY_ADAPTER_BRAND, { value: true });
  return Object.freeze(adapter);
}
