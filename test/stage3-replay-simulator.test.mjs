import assert from "node:assert/strict";
import test from "node:test";

import {
  REPLAY_AMBIGUITY_POLICIES,
  REPLAY_FILL_POLICIES,
  REPLAY_SIMULATOR_VERSION,
  ReplaySimulator,
  createReplaySimulator,
  run,
} from "../lib/replay-simulator.js";

const T0 = Date.parse("2026-08-14T01:00:00.000Z");
const iso = (minutes) => new Date(T0 + minutes * 60_000).toISOString();

function frame(minutes, patch = {}) {
  const close = Number(patch.close ?? 100);
  return {
    timestamp: iso(minutes),
    complete: true,
    close,
    execution: {
      ask: { open: close, high: close + 1, low: close - 1, close },
      bid: { open: close - 1, high: close, low: close - 2, close: close - 1 },
    },
    ...patch,
  };
}

function executionAdapter() {
  return {
    path(current) {
      return current.execution ?? null;
    },
    accountExecution({ side, grams, fillPrice }) {
      const grossCny = grams * fillPrice;
      return {
        ok: true,
        side,
        grams,
        fillPrice,
        cashFlowCny: side === "buy" ? -grossCny : grossCny,
        grossCny,
        feeCny: 0,
        slippageCny: 0,
      };
    },
  };
}

function scriptedStrategy(decisions) {
  return {
    evaluate(input) {
      const order = decisions[input.marketFrame.timestamp] ?? null;
      const decision = order === null ? null : { action: order.action, suggestedOrder: order };
      return { decision, nextState: { seen: (input.previousState?.seen ?? 0) + 1 } };
    },
  };
}

function order(side, price, grams = 1, patch = {}) {
  return { action: side, side, limitPrice: price, grams, ...patch };
}

test("exports the generic simulator interface and policy identities", () => {
  assert.equal(typeof REPLAY_SIMULATOR_VERSION, "string");
  assert.deepEqual(REPLAY_FILL_POLICIES, ["next-bar-limit", "next-open", "signal-close", "delay-30s", "delay-60s", "delay-120s"]);
  assert.deepEqual(REPLAY_AMBIGUITY_POLICIES, ["unknown", "conservative-stop"]);
  assert.equal(typeof ReplaySimulator, "function");
  assert.equal(typeof createReplaySimulator, "function");
  assert.equal(typeof run, "function");
});

test("next-bar processing prevents lookahead and ignores incomplete, duplicate, and future frames", () => {
  const strategy = scriptedStrategy({
    [iso(0)]: order("buy", 99),
  });
  const frames = [
    frame(5, { execution: { ask: { open: 101, high: 102, low: 98, close: 100 }, bid: { open: 100, high: 101, low: 97, close: 99 } } }),
    frame(0, { execution: { ask: { open: 100, high: 101, low: 90, close: 99 }, bid: { open: 99, high: 100, low: 89, close: 98 } } }),
    frame(5, { execution: { ask: { open: 101, high: 102, low: 98, close: 100 }, bid: { open: 100, high: 101, low: 97, close: 99 } } }),
    frame(10, { complete: false }),
    frame(15),
  ];

  const result = run({
    frames,
    strategy,
    execution: executionAdapter(),
    initialPortfolio: { grams: 0, cashCny: 0, maxGrams: 10 },
    asOf: iso(10),
  });

  assert.equal(result.framesProcessed, 2);
  assert.equal(result.orders.length, 1);
  assert.equal(result.fills.length, 1);
  assert.equal(result.fills[0].fillAt, iso(5));
  assert.notEqual(result.fills[0].fillAt, iso(0), "the signal frame cannot fill its own order");
  assert.equal(result.portfolio.grams, 1);
  assert.equal(result.diagnostics.duplicatesDropped, 1);
  assert.equal(result.diagnostics.incompleteFramesIgnored, 1);
  assert.equal(result.diagnostics.futureFramesIgnored, 1);
});

test("simulator quarantines a hidden order under a non-executable action", () => {
  const strategy = {
    evaluate({ marketFrame }) {
      return marketFrame.timestamp === iso(0) ? {
        decision: {
          action: "wait",
          suggestedOrder: { side: "buy", limitPrice: 101, grams: 1 },
        },
      } : { decision: null };
    },
  };
  const result = run({
    frames: [frame(0), frame(5)], strategy, execution: executionAdapter(),
    initialPortfolio: { grams: 0, cashCny: 1_000, maxGrams: 10 }, asOf: iso(5),
  });
  assert.equal(result.orders.length, 0);
  assert.equal(result.fills.length, 0);
  assert.equal(result.diagnostics.invalidDecisions, 1);
  assert.equal(result.unexecutedSignals[0].reasonCode, "invalid_order_action");
});

test("untouched orders expire and a new same-side decision replaces the prior pending order", () => {
  const strategy = scriptedStrategy({
    [iso(0)]: order("buy", 90, 1, { validUntil: iso(5) }),
    [iso(10)]: order("buy", 80, 1, { validUntil: iso(30) }),
    [iso(15)]: order("buy", 70, 1, { validUntil: iso(30) }),
  });
  const result = createReplaySimulator().run({
    frames: [frame(0), frame(5), frame(10), frame(15)],
    strategy,
    execution: executionAdapter(),
    initialPortfolio: { grams: 0, cashCny: 0, maxGrams: 10 },
    asOf: iso(15),
  });

  assert.deepEqual(result.orders.map((entry) => entry.status), ["expired", "replaced", "pending"]);
  assert.equal(result.pendingOrders.length, 1);
  assert.equal(result.pendingOrders[0].limitPrice, 70);
  assert.ok(result.ledger.some((event) => event.type === "order_expired"));
  assert.ok(result.ledger.some((event) => event.type === "order_replaced"));
});

test("canonical input fingerprint and deterministic IDs are stable across input order and object key order", () => {
  const framesA = [frame(5), frame(0)];
  const framesB = [
    { execution: framesA[1].execution, close: 100, complete: true, timestamp: iso(0) },
    { complete: true, timestamp: iso(5), close: 100, execution: framesA[0].execution },
  ];
  const makeStrategy = () => scriptedStrategy({ [iso(0)]: order("buy", 99) });
  const input = {
    execution: executionAdapter(),
    initialPortfolio: { maxGrams: 10, cashCny: 0, grams: 0 },
    asOf: iso(5),
    params: { z: 2, a: 1 },
  };

  const first = run({ ...input, frames: framesA, strategy: makeStrategy() });
  const second = run({ ...input, frames: framesB, strategy: makeStrategy() });

  assert.match(first.inputFingerprint, /^sha256:[0-9a-f]{64}$/);
  assert.equal(second.inputFingerprint, first.inputFingerprint);
  assert.deepEqual(second.orders, first.orders);
  assert.deepEqual(second.fills, first.fills);
  assert.deepEqual(second.ledger, first.ledger);
  assert.deepEqual(second.equityCurve, first.equityCurve);
});

test("conflicting duplicate timestamps resolve canonically independent of input order", () => {
  const duplicateA = frame(5, { close: 101 });
  const duplicateB = frame(5, { close: 102 });
  const common = {
    strategy: scriptedStrategy({ [iso(0)]: order("buy", 99) }),
    execution: executionAdapter(),
    initialPortfolio: { grams: 0, maxGrams: 10 },
    asOf: iso(5),
  };
  const first = run({ ...common, frames: [frame(0), duplicateA, duplicateB] });
  const second = run({ ...common, frames: [duplicateB, frame(0), duplicateA] });
  assert.equal(first.diagnostics.conflictingDuplicates, 1);
  assert.equal(second.inputFingerprint, first.inputFingerprint);
  assert.deepEqual(second.equityCurve, first.equityCurve);
});

test("simulator fingerprint includes strategy and execution adapter identities", () => {
  const base = {
    frames: [frame(0), frame(5)],
    initialPortfolio: { grams: 0, maxGrams: 10 },
    asOf: iso(5),
  };
  const strategyA = scriptedStrategy({ [iso(0)]: order("buy", 99) });
  strategyA.strategyId = "control";
  strategyA.strategyVersion = "v1";
  const strategyB = scriptedStrategy({ [iso(0)]: order("buy", 99) });
  strategyB.strategyId = "control";
  strategyB.strategyVersion = "v2";
  const executionA = executionAdapter();
  executionA.executionVersion = "execution-v1";
  const executionB = executionAdapter();
  executionB.executionVersion = "execution-v2";
  const first = run({ ...base, strategy: strategyA, execution: executionA });
  const changedStrategy = run({ ...base, strategy: strategyB, execution: executionA });
  const changedExecution = run({ ...base, strategy: strategyA, execution: executionB });
  assert.notEqual(changedStrategy.inputFingerprint, first.inputFingerprint);
  assert.notEqual(changedExecution.inputFingerprint, first.inputFingerprint);
});

test("execution accounting is injected and inventory limits reject rather than partially fill", () => {
  const calls = [];
  const execution = executionAdapter();
  execution.accountExecution = (input) => {
    calls.push(input);
    return { ok: true, ...input, cashFlowCny: input.side === "buy" ? -input.grams * input.fillPrice : input.grams * input.fillPrice };
  };
  const result = run({
    frames: [frame(0), frame(5), frame(10), frame(15)],
    strategy: scriptedStrategy({
      [iso(0)]: order("buy", 100, 2),
      [iso(5)]: order("buy", 100, 2),
      [iso(10)]: order("sell", 99, 5),
    }),
    execution,
    initialPortfolio: { grams: 0, maxGrams: 3 },
    asOf: iso(15),
  });

  assert.equal(calls.length, 3, "execution adapter evaluates every touched order before portfolio invariants");
  assert.equal(result.fills.length, 1);
  assert.equal(result.fills[0].grams, 2);
  assert.deepEqual(result.orders.map((entry) => entry.status), ["filled", "rejected", "rejected"]);
  assert.deepEqual(result.orders.slice(1).map((entry) => entry.reasonCode), ["max_grams_exceeded", "inventory_insufficient"]);
  assert.equal(result.portfolio.grams, 2);
  assert.equal(result.diagnostics.executionRejected, 2);
});

test("invalid accounting and enforced cash budgets fail closed before portfolio mutation", () => {
  const wrongSign = executionAdapter();
  wrongSign.accountExecution = (input) => ({ ok: true, ...input, cashFlowCny: input.grams * input.fillPrice });
  const invalid = run({
    frames: [frame(0), frame(5)],
    strategy: scriptedStrategy({ [iso(0)]: order("buy", 100) }),
    execution: wrongSign,
    initialPortfolio: { grams: 0, cashCny: 1000, enforceCash: true, maxGrams: 10 },
    asOf: iso(5),
  });
  assert.equal(invalid.orders[0].reasonCode, "execution_cash_flow_sign_invalid");
  assert.equal(invalid.portfolio.grams, 0);

  const insufficient = run({
    frames: [frame(0), frame(5)],
    strategy: scriptedStrategy({ [iso(0)]: order("buy", 100) }),
    execution: executionAdapter(),
    initialPortfolio: { grams: 0, cashCny: 50, enforceCash: true, maxGrams: 10 },
    asOf: iso(5),
  });
  assert.equal(insufficient.orders[0].reasonCode, "cash_insufficient");
  assert.equal(insufficient.portfolio.cashCny, 50);
});

test("missing execution paths remain unknown and explicit entry-path ambiguity is policy-controlled", () => {
  const missing = run({
    frames: [frame(0), frame(5, { execution: null })],
    strategy: scriptedStrategy({ [iso(0)]: order("buy", 100) }),
    execution: executionAdapter(),
    initialPortfolio: { grams: 0, maxGrams: 10 },
    asOf: iso(5),
  });
  assert.equal(missing.fills.length, 0);
  assert.equal(missing.pendingOrders.length, 1);
  assert.equal(missing.diagnostics.unknownExecutionPaths, 1);
  assert.ok(missing.ledger.some((event) => event.type === "execution_unknown"));

  const ambiguousFrame = frame(5, {
    execution: {
      fillAmbiguous: true,
      conservativeFillPrice: 100,
      ask: { open: 100, high: 111, low: 89, close: 100 },
      bid: { open: 99, high: 110, low: 88, close: 99 },
    },
  });
  const decision = order("buy", 100, 1, { targetPrice: 110, stopPrice: 90 });
  const unknown = run({
    frames: [frame(0), ambiguousFrame],
    strategy: scriptedStrategy({ [iso(0)]: decision }),
    execution: executionAdapter(),
    initialPortfolio: { grams: 0, maxGrams: 10 },
    ambiguityPolicy: "unknown",
    asOf: iso(5),
  });
  assert.equal(unknown.fills.length, 0);
  assert.equal(unknown.orders[0].status, "ambiguous");
  assert.equal(unknown.diagnostics.ambiguousFills, 1);

  const conservative = run({
    frames: [frame(0), ambiguousFrame],
    strategy: scriptedStrategy({ [iso(0)]: decision }),
    execution: executionAdapter(),
    initialPortfolio: { grams: 0, maxGrams: 10 },
    ambiguityPolicy: "conservative-stop",
    asOf: iso(5),
  });
  assert.equal(conservative.fills.length, 2);
  assert.equal(conservative.fills[0].ambiguous, true);
  assert.equal(conservative.fills[0].ambiguityResolution, "conservative_fill");
  assert.equal(conservative.fills[1].action, "stop_loss");
  assert.equal(conservative.portfolio.grams, 0, "entry-bar path ambiguity resolves to the protective stop under conservative policy");

  const reactiveExit = {
    evaluate({ marketFrame, portfolio }) {
      if (marketFrame.timestamp === iso(0)) return { decision: { action: "buy", suggestedOrder: decision } };
      if (portfolio.grams > 0) return {
        decision: { action: "sell_stop", suggestedOrder: order("sell", 99, portfolio.grams, { action: "sell_stop" }) },
      };
      return { decision: null };
    },
  };
  const noDuplicateExit = run({
    frames: [frame(0), ambiguousFrame, frame(10)], strategy: reactiveExit,
    execution: executionAdapter(), initialPortfolio: { grams: 0, maxGrams: 10 },
    ambiguityPolicy: "conservative-stop", asOf: iso(10),
  });
  assert.equal(noDuplicateExit.orders.length, 2, "strategy sees the entry-bar protective close before reevaluation");
  assert.equal(noDuplicateExit.diagnostics.executionRejected, 0);
  assert.equal(noDuplicateExit.pendingOrders.length, 0);

  const outcomeLevelsOnly = run({
    frames: [frame(0), frame(5, { execution: {
      ask: { open: 100, high: 111, low: 89, close: 100 },
      bid: { open: 99, high: 110, low: 88, close: 99 },
    } })],
    strategy: scriptedStrategy({ [iso(0)]: decision }),
    execution: executionAdapter(),
    initialPortfolio: { grams: 0, maxGrams: 10 },
    ambiguityPolicy: "unknown",
    asOf: iso(5),
  });
  assert.equal(outcomeLevelsOnly.fills.length, 1, "target/stop outcome levels do not alter the entry fill transition");
  assert.equal(outcomeLevelsOnly.fills[0].ambiguous, false);
});

test("sensitivity fill policies stay explicit and delayed scenarios do not fabricate second-level prices", () => {
  const decisions = { [iso(0)]: order("buy", 50, 1, { validUntil: iso(10) }) };
  const nextOpen = run({
    frames: [frame(0), frame(5, { close: 101 })],
    strategy: scriptedStrategy(decisions),
    execution: executionAdapter(),
    initialPortfolio: { grams: 0, maxGrams: 10 },
    fillPolicy: "next-open",
    asOf: iso(5),
  });
  assert.equal(nextOpen.fills[0].fillPrice, 101, "next-open ignores the untouched diagnostic limit");

  const signalClose = run({
    frames: [frame(0, { close: 103 })],
    strategy: scriptedStrategy(decisions),
    execution: executionAdapter(),
    initialPortfolio: { grams: 0, maxGrams: 10 },
    fillPolicy: "signal-close",
    asOf: iso(0),
  });
  assert.equal(signalClose.fills[0].fillAt, iso(0));
  assert.equal(signalClose.fills[0].fillPrice, 103);

  const delayed = run({
    frames: [frame(0), frame(5, { close: 102 })],
    strategy: scriptedStrategy(decisions),
    execution: executionAdapter(),
    initialPortfolio: { grams: 0, maxGrams: 10 },
    fillPolicy: "delay-60s",
    asOf: iso(5),
  });
  assert.equal(delayed.fills.length, 0);
  assert.equal(delayed.pendingOrders.length, 1);
  assert.ok(delayed.ledger.some((event) => event.reasonCode === "second_level_execution_path_unavailable"));

  const explicitDelayedFrame = frame(5, { close: 102 });
  explicitDelayedFrame.execution.delayedPrices = { "60000": 101.5 };
  const withEvidence = run({
    frames: [frame(0), explicitDelayedFrame],
    strategy: scriptedStrategy(decisions),
    execution: executionAdapter(),
    initialPortfolio: { grams: 0, maxGrams: 10 },
    fillPolicy: "delay-60s",
    asOf: iso(5),
  });
  assert.equal(withEvidence.fills[0].fillPrice, 101.5);
  assert.equal(withEvidence.diagnostics.coarseDelayFills, 0);
});

test("as-of finalization expires untouched orders even without a later frame", () => {
  const result = run({
    frames: [frame(0)],
    strategy: scriptedStrategy({ [iso(0)]: order("buy", 50, 1, { validUntil: iso(5) }) }),
    execution: executionAdapter(),
    initialPortfolio: { grams: 0, maxGrams: 10 },
    asOf: iso(5),
  });
  assert.equal(result.orders[0].status, "expired");
  assert.equal(result.pendingOrders.length, 0);
  assert.ok(result.ledger.some((event) => event.reasonCode === "validity_ended_at_as_of"));
});
