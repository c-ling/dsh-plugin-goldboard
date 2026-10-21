import assert from "node:assert/strict";
import test from "node:test";

import {
  STRATEGY_INTERFACE_VERSION,
  createStrategyAdapter,
  defineStrategyDescriptor,
  normalizeStrategyEvaluation,
  strategyIdentity,
} from "../lib/strategy-contract.js";
import { createStrategyRegistry } from "../lib/strategy-registry.js";
import { CONTROL_STRATEGY_DESCRIPTOR, createControlStrategy } from "../lib/strategy-control.js";
import { MARKET_REGIME_VERSION, classifyMarketRegime } from "../lib/market-regime.js";
import {
  FACTOR_SCHEMA_VERSION,
  evaluateRequiredFactors,
  normalizeFactorRecord,
  selectFactorVintage,
} from "../lib/factor-contract.js";

function descriptor(patch = {}) {
  return {
    strategyId: "pullback-test",
    strategyVersion: "pullback-test-v1",
    role: "experimental",
    lanes: ["cmb"],
    executionInstrument: "CMB_ACCUMULATED_GOLD",
    signalSemantics: "crossing_trigger",
    ...patch,
  };
}

function bars(count, mapper) {
  const start = Date.parse("2026-01-01T00:00:00.000Z");
  return Array.from({ length: count }, (_, index) => {
    const close = mapper(index);
    return {
      t: start + index * 300_000,
      o: close - 0.1,
      h: close + 0.5,
      l: close - 0.5,
      c: close,
      partial: false,
    };
  });
}

function factor(patch = {}) {
  return {
    factorId: "dxy",
    instrument: "DXY",
    value: 101.2,
    unit: "index",
    observationPeriod: { from: "2026-01-01T00:00:00Z", to: "2026-01-01T23:59:59Z" },
    releaseTimestamp: "2026-01-02T00:00:00Z",
    firstAvailableTimestamp: "2026-01-02T00:01:00Z",
    tradableAfter: "2026-01-02T00:02:00Z",
    ingestedAt: "2026-01-02T00:01:30Z",
    revision: "1",
    vintage: "2026-01-02-initial",
    source: "fixture",
    ...patch,
  };
}

test("strategy descriptor validates strict identities and has a deterministic fingerprint", () => {
  const input = descriptor({ requiredFeatures: ["ema20"] });
  const before = structuredClone(input);
  const first = defineStrategyDescriptor(input);
  const second = defineStrategyDescriptor({ ...input });
  assert.equal(first.interfaceVersion, STRATEGY_INTERFACE_VERSION);
  assert.equal(first.descriptorFingerprint, second.descriptorFingerprint);
  assert.deepEqual(input, before);
  assert.equal(Object.isFrozen(first), true);
  assert.equal(Object.isFrozen(first.lanes), true);
  assert.throws(() => first.lanes.push("xau"), TypeError);
  assert.throws(() => defineStrategyDescriptor(descriptor({ strategyId: "Bad_Id" })), /lowercase kebab/);
  assert.throws(() => defineStrategyDescriptor(descriptor({ strategyVersion: "v1" })), /kebab version/);
  assert.throws(() => defineStrategyDescriptor(descriptor({ lanes: ["CMB"] })), /lane/);
  assert.throws(() => defineStrategyDescriptor(descriptor({ requiredFeatures: [42] })), /must contain strings/);
  assert.throws(() => defineStrategyDescriptor(descriptor({ parameterSchemaVersion: "V1" })), /parameterSchemaVersion/);
});

test("strategy adapter isolates immutable input/output and uses explicit semantic identities", () => {
  const original = { marketFrame: { price: 100 }, previousState: { count: 1 } };
  const adapter = createStrategyAdapter({
    descriptor: descriptor(),
    adapterFingerprint: "pullback-engine-v1:ruleset-a",
    evaluate(input) {
      assert.equal(Object.isFrozen(input), true);
      assert.equal(Object.isFrozen(input.marketFrame), true);
      return { decision: { action: "wait" }, nextState: { count: input.previousState.count + 1 } };
    },
  });
  const result = adapter.evaluate(original);
  assert.equal(Object.isFrozen(result), true);
  assert.equal(Object.isFrozen(result.decision), true);
  assert.throws(() => { result.decision.action = "changed"; }, TypeError);
  const repeated = adapter.evaluate(original);
  assert.equal(original.marketFrame.price, 100);
  assert.equal(repeated.decision.action, "wait");
  assert.deepEqual(strategyIdentity(adapter), {
    interfaceVersion: STRATEGY_INTERFACE_VERSION,
    strategyId: "pullback-test",
    strategyVersion: "pullback-test-v1",
    role: "experimental",
    descriptorFingerprint: adapter.descriptorFingerprint,
    adapterFingerprint: "pullback-engine-v1:ruleset-a",
  });
  assert.deepEqual(normalizeStrategyEvaluation({}), {
    decision: null, valuation: null, nextState: null, activeSignals: [], suppressedSignals: [], diagnostics: [],
  });
  assert.throws(() => normalizeStrategyEvaluation({ decision: 42 }), /decision must be an object or null/);
  assert.throws(() => normalizeStrategyEvaluation({ valuation: [] }), /valuation must be an object or null/);
  assert.throws(() => normalizeStrategyEvaluation({ nextState: 7 }), /nextState must be an object or null/);
  assert.throws(() => normalizeStrategyEvaluation({ activeSignals: [null] }), /must contain objects/);
  assert.throws(() => normalizeStrategyEvaluation({ confidence: 1 }), /unknown fields/);
  const asyncAdapter = createStrategyAdapter({
    descriptor: descriptor(), adapterFingerprint: "async-v1", evaluate: async () => ({}),
  });
  assert.throws(() => asyncAdapter.evaluate({}), /must be synchronous/);
  const wrongInstrument = createStrategyAdapter({
    descriptor: descriptor(),
    adapterFingerprint: "wrong-instrument-v1",
    evaluate: () => ({ decision: { suggestedOrder: { side: "buy", grams: 1, limitPrice: 100, instrument: "BTC" } } }),
  });
  assert.throws(() => wrongInstrument.evaluate({}), /instrument must match/);
});

test("strategy contract rejects conflicting order fields and action-side contradictions", () => {
  const adapter = createStrategyAdapter({
    descriptor: descriptor(), adapterFingerprint: "contradictory-order-test-v1",
    evaluate: () => ({ decision: {
      action: "buy_setup",
      order: { action: "buy_setup", side: "buy", grams: 1, limitPrice: 100, instrument: "CMB_ACCUMULATED_GOLD" },
      suggestedOrder: { action: "sell_stop", side: "sell", grams: 1, limitPrice: 99, instrument: "CMB_ACCUMULATED_GOLD" },
    } }),
  });
  assert.throws(() => adapter.evaluate({}), /must not conflict/);

  const wrongSide = createStrategyAdapter({
    descriptor: descriptor(), adapterFingerprint: "wrong-side-test-v1",
    evaluate: () => ({ decision: {
      action: "buy_setup",
      suggestedOrder: { action: "buy_setup", side: "sell", grams: 1, limitPrice: 100, instrument: "CMB_ACCUMULATED_GOLD" },
    } }),
  });
  assert.throws(() => wrongSide.evaluate({}), /side conflicts/);

  const wrongAction = createStrategyAdapter({
    descriptor: descriptor(), adapterFingerprint: "wrong-action-test-v1",
    evaluate: () => ({ decision: {
      action: "buy_setup",
      suggestedOrder: { action: "add_position", side: "buy", grams: 1, limitPrice: 100, instrument: "CMB_ACCUMULATED_GOLD" },
    } }),
  });
  assert.throws(() => wrongAction.evaluate({}), /action must match/);

  for (const decision of [
    { action: "wait", suggestedOrder: { side: "buy", grams: 1, limitPrice: 100, instrument: "CMB_ACCUMULATED_GOLD" } },
    { suggestedOrder: { side: "buy", grams: 1, limitPrice: 100, instrument: "CMB_ACCUMULATED_GOLD" } },
    { action: "wait", suggestedOrder: { action: "wait", side: "buy", grams: 1, limitPrice: 100, instrument: "CMB_ACCUMULATED_GOLD" } },
  ]) {
    const hiddenOrder = createStrategyAdapter({
      descriptor: descriptor(), adapterFingerprint: "hidden-order-test-v1", evaluate: () => ({ decision }),
    });
    assert.throws(() => hiddenOrder.evaluate({}), /action must resolve to an executable/);
  }

  const bareOrder = createStrategyAdapter({
    descriptor: descriptor(), adapterFingerprint: "bare-order-test-v1",
    evaluate: () => ({ decision: {
      action: "buy_setup", side: "sell", grams: 1, limitPrice: 100, instrument: "BTC",
    } }),
  });
  assert.throws(() => bareOrder.evaluate({}), /must be nested/);
});

test("registry hides factories, requires control, rejects duplicates, and gates candidates", () => {
  const controlEntry = {
    descriptor: CONTROL_STRATEGY_DESCRIPTOR,
    factory: () => createControlStrategy({ evaluate: () => ({ decision: null }), adapterFingerprint: "control-wrapper-v1" }),
  };
  const candidateDescriptor = defineStrategyDescriptor(descriptor());
  const candidateEntry = {
    descriptor: candidateDescriptor,
    factory: () => createStrategyAdapter({ descriptor: candidateDescriptor, evaluate: () => ({}), adapterFingerprint: "candidate-v1" }),
  };
  const registry = createStrategyRegistry([candidateEntry]);
  assert.throws(() => registry.create("pullback-test", { enabledStrategyIds: ["pullback-test"] }), (error) => error.code === "CONTROL_STRATEGY_REQUIRED");
  registry.register(controlEntry.descriptor, controlEntry.factory);
  assert.equal(typeof registry.list()[0].factory, "undefined");
  assert.equal(registry.get("pullback-test").strategyId, "pullback-test");
  assert.throws(() => registry.register(candidateEntry.descriptor, candidateEntry.factory), (error) => error.code === "STRATEGY_DUPLICATE");
  assert.throws(() => registry.create("pullback-test"), (error) => error.code === "STRATEGY_DISABLED");
  assert.equal(registry.create("pullback-test", { enabledStrategyIds: ["pullback-test"] }).strategyId, "pullback-test");
  assert.equal(registry.create("control").strategyId, "control");

  const rawRegistry = createStrategyRegistry([controlEntry]);
  rawRegistry.register(candidateDescriptor, () => ({
    strategyId: candidateDescriptor.strategyId,
    strategyVersion: candidateDescriptor.strategyVersion,
    descriptorFingerprint: candidateDescriptor.descriptorFingerprint,
    evaluate: () => ({}),
  }));
  assert.throws(
    () => rawRegistry.create("pullback-test", { enabledStrategyIds: ["pullback-test"] }),
    (error) => error.code === "STRATEGY_FACTORY_INVALID",
  );
});

test("control descriptor and adapter wrap callbacks without strategy rules", () => {
  assert.deepEqual(CONTROL_STRATEGY_DESCRIPTOR.lanes, ["cmb", "xau", "au9999"]);
  assert.equal(CONTROL_STRATEGY_DESCRIPTOR.role, "control");
  assert.equal(CONTROL_STRATEGY_DESCRIPTOR.signalSemantics, "state_condition");
  const adapter = createControlStrategy({
    adapterFingerprint: "legacy-compute-plan-v1",
    evaluate: ({ previousState }) => ({ decision: { action: "wait" }, nextState: { count: (previousState?.count ?? 0) + 1 } }),
  });
  assert.deepEqual(adapter.evaluate({ previousState: { count: 2 } }).nextState, { count: 3 });
});

test("market regime is deterministic and partial-only or cold input is unknown", () => {
  const observedAt = "2026-02-01T00:00:00Z";
  const rising = bars(80, (index) => 100 + index * 0.5);
  const first = classifyMarketRegime({ bars: rising, observedAt, thresholds: { highVolatilityAtrPct: 99, trendDistanceAtr: 0.5, trendSlopeAtr: 0.01 } });
  const second = classifyMarketRegime({ bars: structuredClone(rising).reverse(), observedAt, thresholds: { highVolatilityAtrPct: 99, trendDistanceAtr: 0.5, trendSlopeAtr: 0.01 } });
  assert.equal(first.version, MARKET_REGIME_VERSION);
  assert.equal(first.regime, "trend");
  assert.equal(first.direction, "up");
  assert.deepEqual(second, first);
  assert.equal(classifyMarketRegime({ bars: rising.slice(0, 10), observedAt }).regime, "unknown");
  assert.equal(classifyMarketRegime({ bars: Array(60).fill(rising[0]), observedAt }).metrics.sampleCount, 1);
  assert.deepEqual(classifyMarketRegime({
    bars: [rising[0], { ...rising[0], c: rising[0].c + 1 }], observedAt,
  }).reasonCodes, ["conflicting_duplicate_bars"]);
  assert.deepEqual(classifyMarketRegime({ bars: rising.slice(0, 2).map((bar) => ({ ...bar, partial: true })), observedAt }).reasonCodes, ["partial_bars_only"]);
});

test("market regime separates high volatility and range with injectable thresholds", () => {
  const observedAt = "2026-02-01T00:00:00Z";
  const volatile = bars(80, (index) => 100 + (index % 2 === 0 ? 10 : -10));
  const high = classifyMarketRegime({ bars: volatile, observedAt, thresholds: { highVolatilityAtrPct: 1 } });
  assert.equal(high.regime, "high_volatility");
  const flat = bars(80, () => 100);
  const ranged = classifyMarketRegime({ bars: flat, observedAt, thresholds: { highVolatilityAtrPct: 99 } });
  assert.equal(ranged.regime, "range");
});

test("factor normalization fails closed without throwing and preserves input", () => {
  const input = factor();
  const before = structuredClone(input);
  const normalized = normalizeFactorRecord(input);
  assert.equal(normalized.schemaVersion, FACTOR_SCHEMA_VERSION);
  assert.equal(normalized.status, "available");
  assert.deepEqual(input, before);
  const invalid = normalizeFactorRecord(factor({ firstAvailableTimestamp: "2025-12-31T00:00:00Z", source: "" }));
  assert.equal(invalid.status, "unknown");
  assert.ok(invalid.reasonCodes.includes("first_available_before_release"));
  assert.ok(invalid.reasonCodes.includes("source_missing"));
  const futureObservation = normalizeFactorRecord(factor({
    observationPeriod: { from: "2026-01-01T00:00:00Z", to: "2026-01-04T00:00:00Z" },
  }));
  assert.equal(futureObservation.status, "unknown");
  assert.ok(futureObservation.reasonCodes.includes("observation_after_release"));
  assert.ok(normalizeFactorRecord(factor({ factorId: "DXY" })).reasonCodes.includes("factor_id_invalid"));
  assert.ok(normalizeFactorRecord(factor({ value: Number.NaN })).reasonCodes.includes("value_invalid"));
});

test("factor vintage selection blocks future revisions and marks old observations stale", () => {
  const initial = factor();
  const revision = factor({
    value: 102.5,
    revision: "2",
    vintage: "2026-01-05-revised",
    releaseTimestamp: "2026-01-05T00:00:00Z",
    firstAvailableTimestamp: "2026-01-05T00:01:00Z",
    tradableAfter: "2026-01-05T00:02:00Z",
    ingestedAt: "2026-01-05T00:01:30Z",
  });
  const records = [revision, initial];
  const before = structuredClone(records);
  const oldAsOf = selectFactorVintage(records, { factorId: "dxy", asOf: "2026-01-03T00:00:00Z" });
  const newAsOf = selectFactorVintage(records, { factorId: "dxy", asOf: "2026-01-06T00:00:00Z" });
  assert.equal(oldAsOf.revision, "1");
  assert.equal(newAsOf.revision, "2");
  assert.equal(selectFactorVintage([
    factor({
      observationPeriod: { from: "2026-01-01T00:00:00Z", to: "2026-01-04T00:00:00Z" },
    }),
  ], { factorId: "dxy", asOf: "2026-01-03T00:00:00Z" }).status, "unknown");
  assert.equal(selectFactorVintage(records, { factorId: "dxy", asOf: "2026-01-10T00:00:00Z", maxAgeMs: 24 * 60 * 60_000 }).status, "stale");
  assert.deepEqual(records, before);
});

test("factor vintage selection rejects conflicting equal-key records independent of input order", () => {
  const first = factor({ value: 1 });
  const second = factor({ value: 2 });
  const options = { factorId: first.factorId, asOf: "2026-01-03T00:00:00Z" };
  for (const records of [[first, second], [second, first]]) {
    const selected = selectFactorVintage(records, options);
    assert.equal(selected.status, "unknown");
    assert.deepEqual(selected.reasonCodes, ["conflicting_factor_vintage"]);
  }
});

test("required-factor declarations fail closed when malformed", () => {
  assert.deepEqual(evaluateRequiredFactors({ requiredFactorIds: ["DXY"], records: [], asOf: "2026-01-03T00:00:00Z" }), {
    decision: "hold",
    status: "unknown",
    factors: {},
    unavailableFactorIds: [],
    reasonCodes: ["required_factor_ids_invalid"],
  });
});

test("required factors hold when any factor is unavailable and repeat deterministically", () => {
  const input = {
    requiredFactorIds: ["dxy", "tips"],
    records: [factor()],
    asOf: "2026-01-03T00:00:00Z",
  };
  const first = evaluateRequiredFactors(input);
  const second = evaluateRequiredFactors(structuredClone(input));
  assert.equal(first.decision, "hold");
  assert.equal(first.status, "unknown");
  assert.deepEqual(first.unavailableFactorIds, ["tips"]);
  assert.deepEqual(second, first);
});
