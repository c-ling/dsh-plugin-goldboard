import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { normalizeConfig } from "../lib/config.js";
import { computePlan } from "../lib/plan.js";
import {
  STRATEGY_EXPERIMENT_REPORT_SCHEMA,
  createStrategyExperimentEngine,
  expandStrategyExperimentScenarios,
  normalizeStrategyExperimentConfig,
  runStrategyExperiment,
  strategyExperimentFingerprint,
  validateStrategyExperimentReport,
} from "../lib/experiments.js";
import {
  CONTROL_STRATEGY_DESCRIPTOR,
  ORB_STRATEGY_DESCRIPTOR,
  ORB_STRATEGY_STATE_VERSION,
  createOrbTrendPullbackStrategy,
  createStrategyAdapter,
} from "../lib/strategy.js";
import {
  REPLAY_EVALUATION_TRACE_LIMIT,
  ReplaySimulator,
  summarizeReplayRiskLedger,
} from "../lib/replay-simulator.js";
import { canonicalSha256, replayReportFingerprint } from "../lib/replay-report.js";
import { createReplayStats } from "../lib/replay-stats.js";
import { createRiskPolicy } from "../lib/risk.js";
import { makeWriteQueue } from "../lib/store.js";
import { buildExperimentReport } from "./fixtures/replay-report-base.mjs";

const START = Date.parse("2026-08-14T01:00:00.000Z");

function orbFrame(index, close, patch = {}) {
  const timestamp = new Date(START + index * 5 * 60_000).toISOString();
  return {
    timestamp,
    t: START + index * 5 * 60_000,
    barT: START + index * 5 * 60_000 - 5 * 60_000,
    day: "2026-08-14",
    session: { day: "2026-08-14", status: "complete" },
    lane: "cmb",
    instrument: "CMB",
    complete: true,
    partial: false,
    o: close,
    h: close + 0.2,
    l: close - 0.2,
    c: close,
    askC: close + 0.1,
    bidC: close - 0.1,
    execution: {
      askBar: { o: close + 0.1, h: close + 0.3, l: close - 0.1, c: close + 0.1 },
      bidBar: { o: close - 0.1, h: close + 0.1, l: close - 0.3, c: close - 0.1 },
      evidence: "real",
      realBidAsk: true,
    },
    ...patch,
  };
}

function factorRecord(revision, availableAt = "2026-08-13T00:00:00.000Z") {
  return {
    factorId: "dxy",
    instrument: "DXY",
    value: revision === "1" ? 100 : 101,
    unit: "index",
    observationPeriod: { from: "2026-08-12T00:00:00.000Z", to: "2026-08-12T23:00:00.000Z" },
    releaseTimestamp: availableAt,
    firstAvailableTimestamp: availableAt,
    tradableAfter: availableAt,
    ingestedAt: availableAt,
    revision,
    vintage: `2026-08-${revision}`,
    source: "fixture",
  };
}

function evaluateSeries(strategy, frames) {
  let state = null;
  const results = [];
  for (const frame of frames) {
    const result = strategy.evaluate({
      marketFrame: frame,
      portfolio: { grams: 0, maxGrams: 10, cashCny: 100_000 },
      params: {},
      previousState: state,
      asOf: frame.timestamp,
      replay: { fills: [], fillCount: 0, latestFill: null },
    });
    state = result.nextState;
    results.push(result);
  }
  return results;
}

function fakeReport(scenario, context = {}) {
  return buildExperimentReport(scenario, {
    exploratory: true,
    asOf: context.asOf ?? "2026-08-14T04:00:00.000Z",
    generatedAt: context.generatedAt ?? context.asOf ?? "2026-08-14T04:00:00.000Z",
    mode: context.mode,
  });
}

function eligibleReport(scenario, options = {}, context = {}) {
  return buildExperimentReport(scenario, {
    asOf: context.asOf ?? "2026-08-14T04:00:00.000Z",
    generatedAt: context.generatedAt ?? context.asOf ?? "2026-08-14T04:00:00.000Z",
    mode: context.mode,
    oosNetPnlCny: options.oosNetPnlCny,
    oosMaxDrawdownCny: options.oosMaxDrawdownCny ?? 2,
    fullSampleNetPnlCny: options.fullSampleNetPnlCny ?? 100,
    benchmarkNetPnlCny: options.benchmarkNetPnlCny ?? 0,
  });
}

test("experiment config is opt-in and leaves the live control config unchanged", () => {
  const normalized = normalizeConfig({
    strategy: { scoreThreshold: 6 },
    experiments: { enabled: true, enabledStrategyIds: ["orb-trend-pullback"] },
  });
  assert.equal(normalized.strategy.scoreThreshold, 6);
  assert.equal(normalized.experiments.enabled, true);
  assert.deepEqual(normalized.experiments.enabledStrategyIds, ["control", "orb-trend-pullback"]);
  assert.equal(normalizeConfig({}).experiments.enabled, false);
  const futureVersion = normalizeConfig({ experiments: {
    version: "goldboard-strategy-experiment-config-v99",
    enabled: true,
    enabledStrategyIds: ["control", "orb-trend-pullback"],
  } }).experiments;
  assert.equal(futureVersion.enabled, false);
  assert.deepEqual(futureVersion.enabledStrategyIds, ["control"]);
  assert.equal(normalizeConfig({}).strategy.scoreThreshold, 5);
});

test("ORB candidate records observing, armed, triggered and de-duplicates one setup", () => {
  const strategy = createOrbTrendPullbackStrategy({
    parameters: { openingRangeBars: 6, requireTrendRegime: true, orderValidityBars: 2 },
    ablation: "without-regime-filter",
  });
  const frames = [
    ...Array.from({ length: 6 }, (_, index) => orbFrame(index, 100)),
    orbFrame(6, 101, { o: 100.3, l: 100.25, h: 101.2 }),
    orbFrame(7, 100.3, { o: 100.8, l: 100.1, h: 100.9 }),
    orbFrame(8, 100.4, { o: 100.35, l: 100.2, h: 100.6 }),
  ];
  const results = evaluateSeries(strategy, frames);
  assert.equal(results[5].nextState.phase, "observing");
  assert.equal(results[6].nextState.phase, "armed");
  assert.equal(results[7].nextState.phase, "triggered");
  assert.equal(results[7].decision.action, "buy_setup");
  assert.equal(results[7].decision.suggestedOrder.side, "buy");
  assert.match(results[7].nextState.setupId, /^orb-setup-/);
  assert.equal(results[8].decision, null, "triggered setup does not issue a duplicate buy");
});

test("ORB consumes a filled setup after an automatic bracket close", () => {
  const strategy = createOrbTrendPullbackStrategy({
    parameters: { openingRangeBars: 6, requireTrendRegime: false, orderValidityBars: 2 },
  });
  const frames = [
    ...Array.from({ length: 6 }, (_, index) => orbFrame(index, 100)),
    orbFrame(6, 101, { o: 100.3, l: 100.25, h: 101.2 }),
    orbFrame(7, 100.3, { o: 100.8, l: 100.1, h: 100.9 }),
  ];
  const triggered = evaluateSeries(strategy, frames).at(-1);
  assert.equal(triggered.decision.action, "buy_setup");
  const closed = strategy.evaluate({
    marketFrame: orbFrame(8, 100.4),
    portfolio: { grams: 0, maxGrams: 10 },
    params: {},
    previousState: triggered.nextState,
    replay: { fills: [{ fillId: "fill-entry", side: "buy", setupId: triggered.nextState.setupId }] },
  });
  assert.equal(closed.nextState.phase, "expired");
  assert.deepEqual(closed.decision.reasonCodes, ["orb_position_closed"]);
  const later = strategy.evaluate({
    marketFrame: orbFrame(9, 100.5), portfolio: { grams: 0, maxGrams: 10 }, params: {}, previousState: closed.nextState,
  });
  assert.notEqual(later.decision?.action, "buy_setup");
});

test("ORB expires an unfilled entry exactly at validUntil", () => {
  const strategy = createOrbTrendPullbackStrategy({
    parameters: { openingRangeBars: 6, requireTrendRegime: false, orderValidityBars: 1 },
  });
  const frames = [
    ...Array.from({ length: 6 }, (_, index) => orbFrame(index, 100)),
    orbFrame(6, 101, { o: 100.3, l: 100.25, h: 101.2 }),
    orbFrame(7, 100.3, { o: 100.8, l: 100.1, h: 100.9 }),
  ];
  const triggered = evaluateSeries(strategy, frames).at(-1);
  assert.equal(triggered.decision.action, "buy_setup");
  const pending = strategy.evaluate({
    marketFrame: orbFrame(8, 100.4), portfolio: { grams: 0, maxGrams: 10 }, params: {}, previousState: triggered.nextState,
  });
  assert.equal(pending.nextState.phase, "triggered");
  assert.equal(pending.decision, null);
  const expired = strategy.evaluate({
    marketFrame: orbFrame(9, 100.4), portfolio: { grams: 0, maxGrams: 10 }, params: {}, previousState: pending.nextState,
  });
  assert.equal(expired.nextState.phase, "expired");
  assert.deepEqual(expired.decision.reasonCodes, ["orb_entry_expired"]);
});

test("ORB orderValidityBars=1 allows exactly the next replay bar to fill", () => {
  const strategy = createOrbTrendPullbackStrategy({
    parameters: { openingRangeBars: 6, requireTrendRegime: false, orderValidityBars: 1 },
  });
  const frames = [
    ...Array.from({ length: 6 }, (_, index) => orbFrame(index, 100)),
    orbFrame(6, 101, { o: 100.3, l: 100.25, h: 101.2 }),
    orbFrame(7, 100.3, { o: 100.8, l: 100.1, h: 100.9 }),
    orbFrame(8, 100.4, { execution: {
      askBar: { o: 100.5, h: 100.6, l: 100.2, c: 100.4 },
      bidBar: { o: 100.3, h: 100.4, l: 100.1, c: 100.2 },
      evidence: "real", realBidAsk: true,
    } }),
  ];
  const result = new ReplaySimulator().run({
    frames,
    strategy,
    execution: {
      executionVersion: "fixture-execution-v1",
      path: (frame) => frame.execution,
      accountExecution: ({ side, grams, fillPrice }) => ({
        ok: true, side, grams, fillPrice,
        cashFlowCny: (side === "buy" ? -1 : 1) * grams * fillPrice,
        feeCny: 0, slippageCny: 0,
      }),
    },
    initialPortfolio: { grams: 0, cashCny: 100_000, maxGrams: 10, enforceCash: true },
    asOf: frames.at(-1).timestamp,
  });
  const entry = result.fills.find((fill) => fill.side === "buy");
  assert.equal(entry?.signalAt, orbFrame(7, 0).timestamp);
  assert.equal(entry?.fillAt, orbFrame(8, 0).timestamp);
  assert.equal(result.orders.find((order) => order.side === "buy")?.validUntil, orbFrame(9, 0).timestamp);
});

test("ORB setup expires deterministically when no pullback arrives", () => {
  const create = () => createOrbTrendPullbackStrategy({
    parameters: { openingRangeBars: 2, setupExpiryBars: 2, requireTrendRegime: false },
  });
  const frames = [
    orbFrame(0, 100),
    orbFrame(1, 100),
    orbFrame(2, 101, { l: 100.4 }),
    orbFrame(3, 101.2, { l: 100.8 }),
    orbFrame(4, 101.3, { l: 100.9 }),
    orbFrame(5, 101.4, { l: 101 }),
  ];
  const first = evaluateSeries(create(), frames);
  const second = evaluateSeries(create(), structuredClone(frames));
  assert.equal(first.at(-1).nextState.phase, "expired");
  assert.ok(first.at(-1).suppressedSignals.some((entry) => entry.code === "orb_setup_expired"));
  assert.deepEqual(second, first);
});

test("ORB rejects future bars without erasing setup state", () => {
  const strategy = createOrbTrendPullbackStrategy({ parameters: { openingRangeBars: 2, requireTrendRegime: false } });
  const first = strategy.evaluate({
    marketFrame: orbFrame(0, 100), portfolio: { grams: 0, maxGrams: 10 }, params: {}, previousState: null,
  });
  const future = orbFrame(1, 101, { barT: START + 60 * 60_000 });
  const second = strategy.evaluate({
    marketFrame: future, portfolio: { grams: 0, maxGrams: 10 }, params: {}, previousState: first.nextState,
  });
  assert.equal(second.nextState.bars.length, first.nextState.bars.length);
  assert.equal(second.nextState.openingBars, first.nextState.openingBars);
  assert.deepEqual(second.decision.reasonCodes, ["market_frame_invalid"]);

  const duplicate = strategy.evaluate({
    marketFrame: orbFrame(0, 100), portfolio: { grams: 0, maxGrams: 10 }, params: {}, previousState: first.nextState,
  });
  assert.equal(duplicate.nextState.bars.length, first.nextState.bars.length);
  assert.equal(duplicate.nextState.openingBars, first.nextState.openingBars);
  assert.deepEqual(duplicate.decision.reasonCodes, ["market_frame_duplicate"]);

  const inProgress = strategy.evaluate({
    marketFrame: orbFrame(1, 101, { barT: undefined }),
    portfolio: { grams: 0, maxGrams: 10 }, params: {}, previousState: first.nextState,
  });
  assert.deepEqual(inProgress.decision.reasonCodes, ["market_frame_invalid"]);
  assert.equal(inProgress.nextState.bars.length, first.nextState.bars.length);
});

test("ORB carries regime history into a new session so the default trend filter can trigger", () => {
  const history = Array.from({ length: 80 }, (_, index) => ({
    t: START - (81 - index) * 5 * 60_000,
    o: 95 + index * 0.1,
    h: 95.3 + index * 0.1,
    l: 94.7 + index * 0.1,
    c: 95 + index * 0.1,
    partial: false,
  }));
  const strategy = createOrbTrendPullbackStrategy();
  const seed = strategy.evaluate({
    marketFrame: orbFrame(0, 100), portfolio: { grams: 0, maxGrams: 10 }, params: {}, previousState: null,
  });
  let state = {
    ...seed.nextState,
    session: "2026-08-13",
    phase: "expired",
    bars: history,
  };
  const closes = [103.1, 103.2, 103.3, 103.4, 103.5, 103.6, 104.4, 103.9];
  let result = null;
  for (let index = 0; index < closes.length; index += 1) {
    const patch = index === 7 ? { l: 103.65 } : {};
    result = strategy.evaluate({
      marketFrame: orbFrame(index, closes[index], patch),
      portfolio: { grams: 0, maxGrams: 10 },
      params: {},
      previousState: state,
    });
    state = result.nextState;
  }
  assert.equal(result.decision?.action, "buy_setup");
  assert.equal(result.decision?.marketRegime?.regime, "trend");
  assert.equal(result.decision?.marketRegime?.direction, "up");
});

test("ORB preserves stops across sessions and reissues an expired exit", () => {
  const strategy = createOrbTrendPullbackStrategy();
  const seed = strategy.evaluate({
    marketFrame: orbFrame(0, 101), portfolio: { grams: 0, maxGrams: 10 }, params: {}, previousState: null,
  });
  const previousState = {
    ...seed.nextState,
    session: "2026-08-13",
    phase: "triggered",
    triggeredAt: "2026-08-13T04:00:00.000Z",
    setupId: "setup-held",
    stopPrice: 100,
    targetPrice: 110,
    positionSeen: true,
    bars: Array.from({ length: 60 }, (_, index) => ({
      t: START - (61 - index) * 5 * 60_000, o: 101, h: 101.2, l: 100.8, c: 101, partial: false,
    })),
  };
  const first = strategy.evaluate({
    marketFrame: orbFrame(0, 99, { bidC: 99 }),
    portfolio: { grams: 2, maxGrams: 10 }, params: {}, previousState,
  });
  assert.equal(first.decision?.action, "sell_stop");
  assert.equal(first.nextState.session, "2026-08-14");
  assert.equal(first.nextState.stopPrice, 100);

  const pending = strategy.evaluate({
    marketFrame: orbFrame(1, 99, { bidC: 99 }),
    portfolio: { grams: 2, maxGrams: 10 }, params: {}, previousState: first.nextState,
  });
  assert.equal(pending.decision, null);
  assert.equal(pending.nextState.exitIssued, true);

  const reissued = strategy.evaluate({
    marketFrame: orbFrame(4, 98.5, { bidC: 98.5 }),
    portfolio: { grams: 2, maxGrams: 10 }, params: {}, previousState: pending.nextState,
  });
  assert.equal(reissued.decision?.action, "sell_stop");
  assert.equal(reissued.nextState.exitIssued, true);
});

test("ORB resets persisted setup state when parameters or signal lane change", () => {
  const original = createOrbTrendPullbackStrategy({ parameters: { openingRangeBars: 2 } });
  const initial = original.evaluate({
    marketFrame: orbFrame(0, 100), portfolio: { grams: 0, maxGrams: 10 }, params: {}, previousState: null,
  });
  const persisted = {
    ...initial.nextState,
    phase: "armed",
    setupId: "stale-setup",
    rangeHigh: 101,
    rangeLow: 99,
  };
  const changedParameters = createOrbTrendPullbackStrategy({ parameters: { openingRangeBars: 3 } });
  const parameterResult = changedParameters.evaluate({
    marketFrame: orbFrame(1, 100), portfolio: { grams: 0, maxGrams: 10 }, params: {}, previousState: persisted,
  });
  assert.notEqual(parameterResult.nextState.basisFingerprint, persisted.basisFingerprint);
  assert.equal(parameterResult.nextState.setupId, null);
  assert.equal(parameterResult.nextState.phase, "observing");

  const laneFrame = orbFrame(1, 100, { lane: "au9999" });
  const laneResult = original.evaluate({
    marketFrame: laneFrame, portfolio: { grams: 0, maxGrams: 10 }, params: {}, previousState: persisted,
  });
  assert.equal(laneResult.nextState.signalLane, "au9999");
  assert.equal(laneResult.nextState.setupId, null);
});

test("ORB factory applies a parameter multiplier once and fingerprints factor vintages", () => {
  const first = createOrbTrendPullbackStrategy({
    parameters: { pullbackAtrTolerance: 0.4 }, parameterMultiplier: 2,
    factorRecords: [factorRecord("1")], asOf: "2026-08-14T00:00:00.000Z",
  });
  const changedVintage = createOrbTrendPullbackStrategy({
    parameters: { pullbackAtrTolerance: 0.4 }, parameterMultiplier: 2,
    factorRecords: [factorRecord("2")], asOf: "2026-08-14T00:00:00.000Z",
  });
  const result = first.evaluate({
    marketFrame: orbFrame(0, 100), portfolio: { grams: 0, maxGrams: 10 }, params: {}, previousState: null,
  });
  assert.equal(result.nextState.parameters.pullbackAtrTolerance, 0.8);
  assert.notEqual(first.adapterFingerprint, changedVintage.adapterFingerprint);

  const withFutureRevision = createOrbTrendPullbackStrategy({
    parameters: { pullbackAtrTolerance: 0.4 }, parameterMultiplier: 2,
    factorRecords: [factorRecord("1"), factorRecord("2", "2026-08-15T00:00:00.000Z")],
    asOf: "2026-08-14T00:00:00.000Z",
  });
  assert.equal(withFutureRevision.adapterFingerprint, first.adapterFingerprint,
    "a factor revision unavailable at fixed asOf cannot alter historical identity");
});

test("ReplaySimulator retains normalized valuation and strategy diagnostics", () => {
  const strategy = createOrbTrendPullbackStrategy({ parameters: { openingRangeBars: 2, requireTrendRegime: false } });
  const frames = [orbFrame(0, 100), orbFrame(1, 100), orbFrame(2, 101), orbFrame(3, 100.3, { l: 100.1 })];
  const result = new ReplaySimulator().run({
    frames,
    strategy,
    execution: {
      executionVersion: "fixture-execution-v1",
      path: (frame) => frame.execution,
      accountExecution: ({ side, grams, fillPrice }) => ({
        ok: true,
        side,
        grams,
        fillPrice,
        cashFlowCny: (side === "buy" ? -1 : 1) * grams * fillPrice,
        feeCny: 0,
        slippageCny: 0,
      }),
    },
    initialPortfolio: { grams: 0, cashCny: 100_000, maxGrams: 10, enforceCash: true },
    asOf: frames.at(-1).timestamp,
  });
  assert.equal(result.evaluations.length, frames.length);
  assert.equal(result.evaluations.at(-1).strategyId, "orb-trend-pullback");
  assert.ok(result.evaluations.every((entry) => !Object.hasOwn(entry, "nextState")), "trace never copies rolling state per frame");
  assert.ok(result.evaluations.every((entry) => /^sha256:[a-f0-9]{64}$/.test(entry.nextStateFingerprint)));
  assert.ok(result.evaluations.some((entry) => entry.diagnostics.some((item) => item.type === "setup_lifecycle")));
  assert.match(result.inputFingerprint, /^sha256:[a-f0-9]{64}$/);
});

test("ReplaySimulator preserves an explicit null decision as a no-op", () => {
  const frame = orbFrame(0, 100);
  const strategy = createStrategyAdapter({
    descriptor: ORB_STRATEGY_DESCRIPTOR,
    adapterFingerprint: "null-decision-fixture-v1",
    evaluate: () => ({ decision: null, diagnostics: [{ type: "fixture_noop" }] }),
  });
  const result = new ReplaySimulator().run({
    frames: [frame],
    strategy,
    execution: { executionVersion: "fixture-v1", path: (value) => value.execution },
    initialPortfolio: { grams: 0, cashCny: 1_000 },
    asOf: frame.timestamp,
  });
  assert.equal(result.evaluations[0].decision, null);
  assert.deepEqual(result.decisions, []);
  assert.equal(result.ledger.some((entry) => entry.type === "strategy_decision"), false);
});

test("ReplaySimulator applies one shared risk policy after strategy evaluation", () => {
  const frame = orbFrame(0, 100);
  const strategy = createStrategyAdapter({
    descriptor: ORB_STRATEGY_DESCRIPTOR,
    adapterFingerprint: "shared-risk-fixture-v1",
    evaluate: () => ({
      decision: {
        action: "buy_setup",
        suggestedOrder: {
          action: "buy_setup", instrument: "CMB_ACCUMULATED_GOLD", side: "buy", grams: 2,
          limitPrice: 100.1, validUntil: new Date(Date.parse(frame.timestamp) + 300_000).toISOString(),
        },
      },
    }),
  });
  const result = new ReplaySimulator().run({
    frames: [frame], strategy, fillPolicy: "signal-close", asOf: frame.timestamp,
    riskPolicy: createRiskPolicy({
      limits: { maxGrams: 1 }, risk: { mode: "fixed_grams" },
      strategy: { signalCooldownMinutes: 0, slippagePerGram: 0 }, fee: { buyPerGram: 0, sellPerGram: 0 },
    }),
    execution: {
      executionVersion: "fixture-v1", path: (value) => value.execution,
      accountExecution: ({ side, grams, fillPrice }) => ({ ok: true, side, grams, fillPrice, cashFlowCny: -grams * fillPrice }),
    },
    initialPortfolio: { grams: 0, cashCny: 1_000, maxGrams: 10 },
  });
  assert.equal(result.fills[0].grams, 1);
  assert.equal(result.evaluations[0].diagnostics.some((entry) => entry.type === "risk_policy"), true);
});

test("control planning defers replay buy sizing so the shared risk policy applies once", () => {
  const now = new Date("2026-08-14T02:00:00.000Z");
  const makeBars = (start, end, base, rise) => {
    const bars = [];
    let price = base - 210 * rise;
    for (let t = start - 210 * 5 * 60_000; t <= end; t += 5 * 60_000) {
      const open = price;
      const close = price + rise;
      price = close;
      bars.push({ t, o: open, h: close + 0.5, l: open - 0.5, c: close });
    }
    return bars;
  };
  const oneMinuteBars = Array.from({ length: 60 }, (_, index) => {
    const t = Math.floor(now.getTime() / 60_000) * 60_000 - index * 60_000;
    return { t, o: 4_375, h: 4_375, l: 4_375, c: 4_375 };
  });
  const runtime = {
    quotes: {
      AU9999: { price: 951, bid: 950.8, ask: 951.2, source: "fixture", updatedAt: now.getTime() },
      XAU: { price: 4_375, source: "fixture", updatedAt: now.getTime() },
      USDCNY: { price: 6.74, source: "fixture", updatedAt: now.getTime() },
    },
    bars: {
      AU9999: { 1: [], 5: [], 60: [] },
      XAU: {
        1: oneMinuteBars,
        5: makeBars(now.getTime() - 150 * 5 * 60_000, now.getTime(), 4_315, 0.4),
        60: makeBars(now.getTime() - 120 * 60 * 60_000, now.getTime(), 4_315, 0.5),
      },
      CMB: { 1: [], 5: [], 60: [] },
    },
    riskSummary: { consecutiveLosses: 1 },
  };
  const config = normalizeConfig({
    limits: { maxGrams: 50 },
    risk: { mode: "fixed_grams", consecutiveLossDeRisk: 1 },
    strategy: { signalCooldownMinutes: 0, slippagePerGram: 0 },
    fee: { buyPerGram: 0, sellPerGram: 0 },
  });
  const sizedInPlan = computePlan(runtime, config, now);
  const nominalPlan = computePlan({ ...runtime, deferBuyRiskToExecution: true }, config, now);
  assert.equal(sizedInPlan.action, "buy_setup");
  assert.equal(sizedInPlan.suggestedOrder.grams, 2.5);
  assert.equal(nominalPlan.suggestedOrder.grams, 5);

  const limit = nominalPlan.suggestedOrder.cmbEstimatedPrice;
  const replayFrames = [0, 5].map((minutes) => ({
    timestamp: new Date(now.getTime() + minutes * 60_000).toISOString(),
    complete: true,
    c: limit,
    execution: {
      askBar: { o: limit + 0.1, h: limit + 0.2, l: limit - 0.1, c: limit },
      bidBar: { o: limit - 0.1, h: limit, l: limit - 0.2, c: limit - 0.1 },
      evidence: "real", realBidAsk: true,
    },
  }));
  const sharedPolicy = createRiskPolicy(config);
  const result = new ReplaySimulator().run({
    frames: replayFrames,
    strategy: {
      evaluate(input) {
        return input.previousState ? { decision: null, nextState: input.previousState }
          : { decision: nominalPlan, nextState: { emitted: true } };
      },
    },
    execution: {
      executionVersion: "fixture-v1", path: (frame) => frame.execution,
      accountExecution: ({ side, grams, fillPrice }) => ({
        ok: true, side, grams, fillPrice,
        cashFlowCny: (side === "buy" ? -1 : 1) * grams * fillPrice,
        feeCny: 0, slippageCny: 0,
      }),
    },
    riskPolicy: {
      riskPolicyVersion: sharedPolicy.riskPolicyVersion,
      evaluate: (input) => sharedPolicy.evaluate({ ...input, ledgerSummary: { consecutiveLosses: 1 } }),
    },
    initialPortfolio: { grams: 0, cashCny: 100_000, maxGrams: 50 },
    asOf: replayFrames.at(-1).timestamp,
  });
  assert.equal(result.fills[0].grams, 2.5);
  const riskDiagnostic = result.evaluations[0].diagnostics.find((entry) => entry.type === "risk_policy");
  assert.equal(riskDiagnostic.value.deRiskFactor, 0.5);
});

test("ReplaySimulator carries a realized loss streak through a new buy and add", () => {
  const frames = [orbFrame(0, 100), orbFrame(1, 90), orbFrame(2, 90), orbFrame(3, 89)];
  const strategy = createStrategyAdapter({
    descriptor: ORB_STRATEGY_DESCRIPTOR,
    adapterFingerprint: "risk-ledger-sequence-fixture-v1",
    evaluate: (input) => {
      const index = Math.round((Date.parse(input.marketFrame.timestamp) - START) / (5 * 60_000));
      const actions = ["buy_setup", "sell_stop", "buy_setup", "add_position"];
      const side = index === 1 ? "sell" : "buy";
      const setupId = index < 2 ? "setup-loss" : "setup-new";
      return { decision: {
        action: actions[index],
        suggestedOrder: {
          action: actions[index], setupId, instrument: "CMB_ACCUMULATED_GOLD", side, grams: 2,
          limitPrice: Number(input.marketFrame.c), atrPerGram: 5,
          validUntil: new Date(Date.parse(input.marketFrame.timestamp) + 300_000).toISOString(),
        },
      } };
    },
  });
  const result = new ReplaySimulator().run({
    frames, strategy, fillPolicy: "signal-close", asOf: frames.at(-1).timestamp,
    riskPolicy: createRiskPolicy({
      limits: { maxGrams: 10 },
      risk: {
        mode: "fixed_grams", consecutiveLossDeRisk: 1,
        maxDailyLossCny: 1_000, maxWeeklyLossCny: 1_000, maxDrawdownCny: 1_000,
        maxAddsPerSetup: 3, maxAddsPerDay: 3, minAddPriceImprovementPerGram: 0,
      },
      strategy: { signalCooldownMinutes: 0, slippagePerGram: 0 },
      fee: { buyPerGram: 0, sellPerGram: 0 },
    }),
    execution: {
      executionVersion: "fixture-v1", path: (frame) => frame.execution,
      accountExecution: ({ side, grams, fillPrice }) => ({
        ok: true, side, grams, fillPrice,
        cashFlowCny: (side === "buy" ? -1 : 1) * grams * fillPrice,
        feeCny: 0, slippageCny: 0,
      }),
    },
    initialPortfolio: { grams: 0, cashCny: 1_000, maxGrams: 10 },
  });
  assert.deepEqual(result.fills.map((fill) => [fill.action, fill.grams]), [
    ["buy_setup", 2], ["sell_stop", 2], ["buy_setup", 1], ["add_position", 1],
  ]);
  const riskSummary = summarizeReplayRiskLedger(result.fills, result.portfolio, frames.at(-1).timestamp, 89);
  assert.equal(riskSummary.consecutiveLosses, 1);
  assert.equal(riskSummary.addsToday, 1);
});

test("ReplaySimulator resolves protective brackets from bid OHLC and ambiguity policy", () => {
  const frames = [orbFrame(0, 100), orbFrame(1, 100, {
    execution: {
      askBar: { o: 100, h: 100.2, l: 99.8, c: 100 },
      bidBar: { o: 100, h: 102, l: 98, c: 100 },
      evidence: "real",
      realBidAsk: true,
    },
  })];
  const create = () => createStrategyAdapter({
    descriptor: ORB_STRATEGY_DESCRIPTOR,
    adapterFingerprint: "protective-bracket-fixture-v1",
    evaluate: (input) => input.previousState ? { decision: null, nextState: input.previousState } : {
      decision: {
        action: "buy_setup",
        suggestedOrder: {
          action: "buy_setup", instrument: "CMB_ACCUMULATED_GOLD", side: "buy", grams: 1,
          limitPrice: 100, stopPrice: 99, targetPrice: 101,
          validUntil: new Date(Date.parse(input.marketFrame.timestamp) + 300_000).toISOString(),
        },
      },
      nextState: { entered: true },
    },
  });
  const execution = {
    executionVersion: "fixture-v1",
    path: (frame) => frame.execution,
    accountExecution: ({ side, grams, fillPrice }) => ({
      ok: true, side, grams, fillPrice, cashFlowCny: (side === "buy" ? -1 : 1) * grams * fillPrice,
      feeCny: 0, slippageCny: 0,
    }),
  };
  const conservative = new ReplaySimulator().run({
    frames, strategy: create(), execution, fillPolicy: "signal-close", ambiguityPolicy: "conservative-stop",
    initialPortfolio: { grams: 0, cashCny: 1_000 }, asOf: frames.at(-1).timestamp,
  });
  assert.deepEqual(conservative.fills.map((fill) => [fill.side, fill.action, fill.fillPrice]), [
    ["buy", "buy_setup", 100.1], ["sell", "stop_loss", 99],
  ]);
  assert.equal(conservative.protectiveBrackets[0].status, "closed");

  const unknown = new ReplaySimulator().run({
    frames, strategy: create(), execution, fillPolicy: "signal-close", ambiguityPolicy: "unknown",
    initialPortfolio: { grams: 0, cashCny: 1_000 }, asOf: frames.at(-1).timestamp,
  });
  assert.equal(unknown.fills.length, 1);
  assert.equal(unknown.protectiveBrackets[0].status, "unresolved");
  assert.equal(unknown.diagnostics.unknownExecutionPaths, 1);
});

test("ReplaySimulator gaps through and independently links multiple protective brackets", () => {
  const frames = [
    orbFrame(0, 100),
    orbFrame(1, 100),
    orbFrame(2, 98, { execution: {
      askBar: { o: 98.2, h: 98.4, l: 97.8, c: 98.1 },
      bidBar: { o: 98, h: 98.2, l: 97.5, c: 97.9 }, evidence: "real", realBidAsk: true,
    } }),
  ];
  const strategy = createStrategyAdapter({
    descriptor: ORB_STRATEGY_DESCRIPTOR,
    adapterFingerprint: "multi-protective-fixture-v1",
    evaluate: (input) => {
      const index = Math.round((Date.parse(input.marketFrame.timestamp) - START) / (5 * 60_000));
      if (index > 1) return { decision: null };
      return { decision: {
        action: index === 0 ? "buy_setup" : "add_position",
        suggestedOrder: {
          action: index === 0 ? "buy_setup" : "add_position",
          setupId: `setup-${index}`,
          instrument: "CMB_ACCUMULATED_GOLD", side: "buy", grams: 1,
          limitPrice: 100.1, stopPrice: index === 0 ? 99 : 98.5, targetPrice: 105,
          validUntil: new Date(Date.parse(input.marketFrame.timestamp) + 300_000).toISOString(),
        },
      } };
    },
  });
  const result = new ReplaySimulator().run({
    frames, strategy, fillPolicy: "signal-close", ambiguityPolicy: "conservative-stop",
    execution: {
      executionVersion: "fixture-v1", path: (frame) => frame.execution,
      accountExecution: ({ side, grams, fillPrice }) => ({
        ok: true, side, grams, fillPrice,
        cashFlowCny: (side === "buy" ? -1 : 1) * grams * fillPrice,
        feeCny: 0, slippageCny: 0,
      }),
    },
    initialPortfolio: { grams: 0, cashCny: 1_000, maxGrams: 10 }, asOf: frames.at(-1).timestamp,
  });
  assert.equal(result.protectiveBrackets.length, 2);
  assert.ok(result.protectiveBrackets.every((entry) => entry.status === "closed"));
  const exits = result.fills.filter((fill) => fill.side === "sell");
  assert.equal(exits.length, 2);
  assert.ok(exits.every((fill) => fill.fillPrice === 98), "gap-open stop exits use executable bid open");
  assert.equal(new Set(exits.map((fill) => fill.protectiveBracketId)).size, 2);
  assert.deepEqual(new Set(exits.map((fill) => fill.setupId)), new Set(["setup-0", "setup-1"]));
});

test("ReplaySimulator bounds traces while retaining complete strategy facts", () => {
  const frameCount = REPLAY_EVALUATION_TRACE_LIMIT + 5;
  const frames = Array.from({ length: frameCount }, (_, index) => orbFrame(index, 100));
  const strategy = createStrategyAdapter({
    descriptor: ORB_STRATEGY_DESCRIPTOR,
    adapterFingerprint: "bounded-trace-fixture-v1",
    evaluate: () => ({
      diagnostics: [{ type: "setup_lifecycle", value: { phase: "observing" } }],
      suppressedSignals: [{ code: "fixture_suppressed" }],
    }),
  });
  const result = new ReplaySimulator().run({
    frames,
    strategy,
    execution: { executionVersion: "fixture-v1", path: (frame) => frame.execution },
    initialPortfolio: { grams: 0, cashCny: 1_000 },
    asOf: frames.at(-1).timestamp,
  });
  assert.equal(result.evaluations.length, REPLAY_EVALUATION_TRACE_LIMIT);
  assert.equal(result.diagnostics.evaluationTracesDropped, 5);
  assert.equal(result.strategyFacts.setupLifecycle.observing, frameCount);
  assert.equal(result.strategyFacts.suppressedReasons.fixture_suppressed, frameCount);
  assert.equal(result.evaluations[0].at, frames[5].timestamp);
});

test("ReplaySimulator cooperative mode yields and observes cancellation", async () => {
  const controller = new AbortController();
  const frames = Array.from({ length: 500 }, (_, index) => orbFrame(index, 100));
  const strategy = createStrategyAdapter({
    descriptor: ORB_STRATEGY_DESCRIPTOR,
    adapterFingerprint: "cancellation-fixture-v1",
    evaluate: () => ({}),
  });
  const task = new ReplaySimulator().runCooperative({
    frames,
    strategy,
    execution: { executionVersion: "fixture-v1", path: (frame) => frame.execution },
    initialPortfolio: { grams: 0, cashCny: 1_000 },
    asOf: frames.at(-1).timestamp,
    signal: controller.signal,
    yieldEvery: 1,
  });
  setImmediate(() => controller.abort(new Error("test cancellation")));
  await assert.rejects(task, (error) => error.name === "AbortError" && /test cancellation/.test(error.message));
});

test("experiment matrix expands control and candidate without sharing scenario identity", () => {
  const config = normalizeStrategyExperimentConfig({
    enabled: true,
    enabledStrategyIds: ["control", "orb-trend-pullback"],
    signalLanes: ["cmb"],
    costMultipliers: [1, 2],
    parameterMultipliers: [1],
    ablations: ["none", "without-regime-filter"],
  });
  const scenarios = expandStrategyExperimentScenarios(config, [CONTROL_STRATEGY_DESCRIPTOR, ORB_STRATEGY_DESCRIPTOR]);
  assert.equal(scenarios.filter((entry) => entry.strategyId === "control").length, 2);
  assert.equal(scenarios.filter((entry) => entry.strategyId === "orb-trend-pullback").length, 4);
  assert.equal(new Set(scenarios.map((entry) => entry.scenarioId)).size, scenarios.length);
  assert.ok(scenarios.every((entry) => entry.executionInstrument === "CMB_ACCUMULATED_GOLD"));
});

test("experiment report is deterministic and promotion fails closed without OOS evidence", async () => {
  const input = {
    config: {
      enabled: true,
      enabledStrategyIds: ["control", "orb-trend-pullback"],
      signalLanes: ["cmb"],
      costMultipliers: [1, 2],
      parameterMultipliers: [1],
      ablations: ["none", "without-regime-filter"],
    },
    strategyCatalog: [CONTROL_STRATEGY_DESCRIPTOR, ORB_STRATEGY_DESCRIPTOR],
    asOf: "2026-08-14T04:00:00.000Z",
    executeScenario: async (scenario, context) => ({ ok: true, report: fakeReport(scenario, context) }),
  };
  const first = await runStrategyExperiment({ ...input, generatedAt: "2026-08-14T04:01:00.000Z" });
  const second = await runStrategyExperiment({ ...input, generatedAt: "2026-08-14T05:01:00.000Z" });
  assert.equal(first.schema, STRATEGY_EXPERIMENT_REPORT_SCHEMA);
  assert.equal(first.experimentFingerprint, second.experimentFingerprint);
  assert.equal(strategyExperimentFingerprint(first), first.experimentFingerprint);
  assert.equal(first.scenarios.length, 6);
  assert.equal(first.comparisons.length, 1);
  assert.equal(first.comparisons[0].netPnlDeltaCny, null, "full-sample profit cannot stand in for OOS comparison");
  assert.equal(first.promotion.eligible, false);
  assert.ok(first.promotion.candidates[0].reasonCodes.includes("oos_not_validated"));
  assert.equal(first.promotion.liveStrategyChanged, false);
  assert.ok(first.benchmarkCapabilities.every((entry) => entry.status === "unavailable"));
  assert.ok(first.scenarios.every((scenario) => scenario.status !== "completed" || /^[a-f0-9]{64}$/.test(String(scenario.parameterFingerprint))));
});

test("promotion rejects non-monotonic or missing OOS cost results and unstable parameters", async () => {
  const report = await runStrategyExperiment({
    config: {
      enabled: true,
      enabledStrategyIds: ["control", "orb-trend-pullback"],
      signalLanes: ["cmb", "au9999", "xau"],
      costMultipliers: [1, 2, 3],
      parameterMultipliers: [0.8, 1, 1.2],
      ablations: ["none", "without-regime-filter"],
      maxScenarios: 96,
    },
    strategyCatalog: [CONTROL_STRATEGY_DESCRIPTOR, ORB_STRATEGY_DESCRIPTOR],
    asOf: "2026-08-14T04:00:00.000Z",
    executeScenario: async (scenario, context) => {
      let oosNetPnlCny;
      if (scenario.strategyId === "control") oosNetPnlCny = scenario.costMultiplier === 1 ? 1 : 0.5;
      else if (scenario.costMultiplier === 3) oosNetPnlCny = null;
      else if (scenario.costMultiplier === 2 && scenario.parameterMultiplier === 1 && scenario.ablation === "none") oosNetPnlCny = 20;
      else if (scenario.parameterMultiplier !== 1 && scenario.costMultiplier === 1 && scenario.ablation === "none") oosNetPnlCny = -1;
      else oosNetPnlCny = 10;
      return { ok: true, report: eligibleReport(scenario, { oosNetPnlCny, fullSampleNetPnlCny: 100 }, context) };
    },
  });
  const candidate = report.promotion.candidates[0];
  assert.equal(candidate.eligible, false);
  assert.ok(candidate.reasonCodes.includes("promotion_matrix_not_exact"), "matrix supersets are diagnostic-only and cannot be persisted as eligible");
  assert.ok(candidate.reasonCodes.includes("cost_stress_unstable"), "null OOS cost metrics cannot become zero");
  assert.ok(candidate.reasonCodes.includes("cost_stress_non_monotonic"));
  assert.ok(candidate.reasonCodes.includes("parameter_sensitivity_unstable"));
});

test("promotion can pass only a fully validated monotonic same-basis OOS matrix", async () => {
  const report = await runStrategyExperiment({
    config: {
      enabled: true,
      enabledStrategyIds: ["control", "orb-trend-pullback"],
      signalLanes: ["cmb", "au9999", "xau"],
      costMultipliers: [1, 2],
      parameterMultipliers: [0.8, 1, 1.2],
      ablations: ["none", "without-regime-filter"],
    },
    strategyCatalog: [CONTROL_STRATEGY_DESCRIPTOR, ORB_STRATEGY_DESCRIPTOR],
    asOf: "2026-08-14T04:00:00.000Z",
    mode: "walk-forward",
    executeScenario: async (scenario, context) => {
      let oosNetPnlCny;
      if (scenario.strategyId === "control") oosNetPnlCny = scenario.costMultiplier === 1 ? 1 : 0.5;
      else if (scenario.costMultiplier === 1 && scenario.parameterMultiplier === 1 && scenario.ablation === "none") oosNetPnlCny = 10;
      else if (scenario.costMultiplier === 2 && scenario.parameterMultiplier === 1 && scenario.ablation === "none") oosNetPnlCny = 8;
      else oosNetPnlCny = scenario.costMultiplier === 1 ? 9 : 7;
      return { ok: true, report: eligibleReport(scenario, { oosNetPnlCny, fullSampleNetPnlCny: -100 }, context) };
    },
  });
  assert.equal(report.promotion.candidates[0].eligible, true);
  assert.equal(report.promotion.candidates[0].status, "eligible_to_apply");
  assert.equal(report.promotion.liveStrategyChanged, false);
  assert.ok(report.comparisons.every((entry) => entry.basis === "completed_oos_folds" && entry.netPnlDeltaCny === 9));
});

test("promotion rejects a candidate that underperforms an aligned OOS benchmark", async () => {
  const report = await runStrategyExperiment({
    config: {
      enabled: true,
      enabledStrategyIds: ["control", "orb-trend-pullback"],
      signalLanes: ["cmb", "au9999", "xau"],
      costMultipliers: [1, 2],
      parameterMultipliers: [0.8, 1, 1.2],
      ablations: ["none", "without-regime-filter"],
    },
    strategyCatalog: [CONTROL_STRATEGY_DESCRIPTOR, ORB_STRATEGY_DESCRIPTOR],
    asOf: "2026-08-14T04:00:00.000Z",
    mode: "walk-forward",
    executeScenario: async (scenario, context) => {
      const oosNetPnlCny = scenario.strategyId === "control" ? 1 : 10;
      return { ok: true, report: eligibleReport(scenario, {
        oosNetPnlCny,
        benchmarkNetPnlCny: scenario.strategyId === "control" ? 0 : 6,
      }, context) };
    },
  });
  assert.equal(report.promotion.eligible, false);
  assert.ok(report.promotion.candidates[0].reasonCodes.includes("per_fold_benchmark_not_dominated"));
});

test("cold experiment validation rejects forged benchmark or execution-instrument evidence", async () => {
  const basis = { fixture: "full-strategy-basis" };
  const report = await runStrategyExperiment({
    basis,
    basisFingerprint: canonicalSha256(basis),
    config: {
      enabled: true,
      enabledStrategyIds: ["control", "orb-trend-pullback"],
      signalLanes: ["cmb", "au9999", "xau"], costMultipliers: [1, 2],
      parameterMultipliers: [0.8, 1, 1.2], ablations: ["none", "without-regime-filter"],
      orb: { requireTrendRegime: true },
    },
    strategyCatalog: [CONTROL_STRATEGY_DESCRIPTOR, ORB_STRATEGY_DESCRIPTOR],
    asOf: "2026-08-14T04:00:00.000Z",
    mode: "walk-forward",
    executeScenario: async (scenario, context) => {
      let oosNetPnlCny;
      if (scenario.strategyId === "control") oosNetPnlCny = scenario.costMultiplier === 1 ? 1 : 0.5;
      else if (scenario.parameterMultiplier === 1 && scenario.ablation === "none") {
        oosNetPnlCny = scenario.costMultiplier === 1 ? 10 : 8;
      } else oosNetPnlCny = scenario.costMultiplier === 1 ? 9 : 7;
      return { ok: true, report: eligibleReport(scenario, { oosNetPnlCny }, context) };
    },
  });
  assert.equal(report.promotion.eligible, true);
  assert.equal(validateStrategyExperimentReport(structuredClone(report)).promotion.eligible, true);

  const benchmarkForgery = structuredClone(report);
  const scenario = benchmarkForgery.scenarios.find((entry) => entry.strategyId === "orb-trend-pullback"
    && entry.signalLane === "cmb" && entry.costMultiplier === 1 && entry.parameterMultiplier === 1 && entry.ablation === "none");
  const fold = scenario.oos.folds[0];
  fold.benchmarks.buy_and_hold.metrics.netPnlCny = Number(fold.metrics.netPnlCny) + 1;
  fold.resultFingerprint = canonicalSha256({
    foldId: fold.foldId, parameterFingerprint: fold.parameterFingerprint,
    sampleCount: fold.sampleCount, metrics: fold.metrics, benchmarks: fold.benchmarks,
  });
  scenario.oos.resultFingerprint = canonicalSha256({
    registryId: scenario.oos.registryId,
    folds: scenario.oos.folds.map((entry) => ({ foldId: entry.foldId, status: entry.status, resultFingerprint: entry.resultFingerprint })),
  });
  benchmarkForgery.oos[scenario.scenarioId] = structuredClone(scenario.oos);
  benchmarkForgery.experimentFingerprint = strategyExperimentFingerprint(benchmarkForgery);
  benchmarkForgery.experimentId = `experiment-${benchmarkForgery.experimentFingerprint.slice(0, 24)}`;
  assert.throws(() => validateStrategyExperimentReport(benchmarkForgery), /eligible promotion evidence/);

  const instrumentForgery = structuredClone(report);
  instrumentForgery.scenarios.find((entry) => entry.strategyId === "orb-trend-pullback").executionInstrument = "Au99.99";
  instrumentForgery.experimentFingerprint = strategyExperimentFingerprint(instrumentForgery);
  instrumentForgery.experimentId = `experiment-${instrumentForgery.experimentFingerprint.slice(0, 24)}`;
  assert.throws(() => validateStrategyExperimentReport(instrumentForgery), /eligible promotion evidence/);
});

test("missing point-in-time lane evidence is unavailable instead of a zero-return scenario", async () => {
  let calls = 0;
  const report = await runStrategyExperiment({
    config: {
      enabled: true,
      enabledStrategyIds: ["orb-trend-pullback"],
      signalLanes: ["xau"],
      costMultipliers: [1],
      parameterMultipliers: [1],
      ablations: ["none"],
    },
    strategyCatalog: [CONTROL_STRATEGY_DESCRIPTOR, ORB_STRATEGY_DESCRIPTOR],
    asOf: "2026-08-14T04:00:00.000Z",
    executeScenario: async () => {
      calls += 1;
      return { ok: false, status: "unavailable", reasonCodes: ["xau_usdcny_point_in_time_unavailable"] };
    },
  });
  assert.equal(calls, 2, "control and candidate lanes both fail closed on the missing XAU/USDCNY dataset");
  assert.ok(report.scenarios.every((scenario) => scenario.status === "unavailable"));
  assert.ok(report.scenarios.every((scenario) => scenario.reasonCodes.includes("xau_usdcny_point_in_time_unavailable")));
  assert.ok(report.scenarios.every((scenario) => scenario.metrics === undefined));
});

function replayBars(day, strideMinutes) {
  const start = Date.parse(`${day}T09:00:00+08:00`);
  const count = Math.ceil(17 * 60 / strideMinutes);
  return Array.from({ length: count }, (_, index) => {
    const base = 950 + index * 0.03 + Math.sin(index / 5) * 0.25;
    return {
      t: start + index * strideMinutes * 60_000,
      o: base,
      h: base + 0.35,
      l: base - 0.35,
      c: base + 0.05,
      source: "fixture",
      instrument: "CMB_ACCUMULATED_GOLD",
      market: "bank",
      currency: "CNY",
      unit: "gram",
      executionSideComplete: true,
      executionSideSource: "fixture-bid-ask",
      executionEvidence: { mode: "real", askSource: "fixture", bidSource: "fixture" },
      askO: base + 0.2,
      askH: base + 0.55,
      askL: base - 0.15,
      askC: base + 0.25,
      bidO: base - 0.2,
      bidH: base + 0.15,
      bidL: base - 0.55,
      bidC: base - 0.15,
    };
  });
}

test("replay engine resolves an enabled candidate without replacing latest control report", async () => {
  const bars5 = replayBars("2026-08-14", 5);
  const bars60 = replayBars("2026-08-14", 60);
  const engine = createReplayStats({
    getConfig: () => ({
      limits: { maxGrams: 10 },
      experiments: {
        enabled: true,
        enabledStrategyIds: ["control", "orb-trend-pullback"],
        signalLanes: ["cmb"],
        orb: { openingRangeBars: 2, requireTrendRegime: false, setupExpiryBars: 4 },
      },
    }),
    fetchKlines: async () => [],
    getCmbBars: () => ({ bars5, bars60 }),
    logger: { warn() {} },
  });
  const result = await engine.run({
    days: 1,
    now: new Date("2026-08-14T19:00:00.000Z"),
    strategyId: "orb-trend-pullback",
    ablation: "without-regime-filter",
    persist: false,
    useCache: false,
  });
  assert.equal(result.ok, true);
  assert.equal(result.report.strategyId, "orb-trend-pullback");
  assert.equal(result.report.provenance.experiment.replayOnly, true);
  assert.equal(result.report.provenance.experiment.liveStrategyChanged, false);
  assert.ok(result.report.caveats.includes("experimental-strategy-replay-only"));
  assert.ok(Object.keys(result.experimentFacts.setupLifecycle).length > 0);
  assert.match(result.report.provenance.factorFingerprint, /^[a-f0-9]{64}$/);
  assert.equal((await engine.last()).report, null, "isolated candidate run does not become the latest control report");
  await assert.rejects(
    engine.run({ days: 1, now: new Date("2026-08-14T19:00:00.000Z"), strategyId: "unknown" }),
    (error) => error.code === "UNKNOWN_STRATEGY",
  );
});

test("strict point-in-time replay rejects Au bars without ingestion clocks and preserves exclusions", async () => {
  const bars5 = replayBars("2026-08-14", 5);
  const bars60 = replayBars("2026-08-14", 60);
  const engine = createReplayStats({
    getConfig: () => ({ experiments: { enabled: true, enabledStrategyIds: ["control", "orb-trend-pullback"] } }),
    fetchKlines: async (_secid, klt) => klt === 5 ? bars5 : bars60,
    logger: { warn() {} },
  });
  const result = await engine.run({
    days: 1,
    lane: "au9999",
    now: new Date("2026-08-14T19:00:00.000Z"),
    strategyId: "orb-trend-pullback",
    persist: false,
    useCache: false,
    requirePointInTimeIngestion: true,
  });
  assert.equal(result.ok, false);
  assert.equal(result.status, "unavailable");
  assert.deepEqual(result.reasonCodes, ["point_in_time_ingestion_unavailable"]);
  assert.equal(result.datasetAudit.bars[5].total, 0);
  assert.ok(result.datasetAudit.records.excludedMissingIngestedAtBars > 0);
});

test("strategy experiment runner rejects cancellation raised while a scenario evaluator settles", async () => {
  const controller = new AbortController();
  await assert.rejects(runStrategyExperiment({
    config: {
      enabled: true, enabledStrategyIds: ["control"], signalLanes: ["cmb"],
      costMultipliers: [1], parameterMultipliers: [1], ablations: ["none"],
    },
    strategyCatalog: [CONTROL_STRATEGY_DESCRIPTOR],
    asOf: "2026-08-14T04:00:00.000Z",
    signal: controller.signal,
    executeScenario: async (scenario, context) => {
      controller.abort(new Error("cancel after scenario"));
      return { ok: true, report: fakeReport(scenario) };
    },
  }), (error) => error?.name === "AbortError");
});

test("strategy experiment engine rejects configured IDs missing from the frozen registry", async () => {
  const engine = createStrategyExperimentEngine({
    getConfig: () => ({ experiments: {
      enabled: true, enabledStrategyIds: ["control", "not-registered"], signalLanes: ["cmb"],
      costMultipliers: [1], parameterMultipliers: [1], ablations: ["none"],
    } }),
    listStrategies: () => [CONTROL_STRATEGY_DESCRIPTOR],
    executeScenario: async (scenario, context) => ({ ok: true, report: fakeReport(scenario, context) }),
  });
  await assert.rejects(
    engine.run({ asOf: "2026-08-14T04:00:00.000Z", days: 1, strategyIds: ["not-registered"] }),
    (error) => error?.code === "UNKNOWN_STRATEGY",
  );
});

test("strategy experiment engine rejects concurrent requests instead of joining another request", async () => {
  let release;
  const barrier = new Promise((resolve) => { release = resolve; });
  const engine = createStrategyExperimentEngine({
    getConfig: () => ({ experiments: {
      enabled: true,
      enabledStrategyIds: ["control"],
      signalLanes: ["cmb"],
      costMultipliers: [1],
      parameterMultipliers: [1],
      ablations: ["none"],
    } }),
    listStrategies: () => [CONTROL_STRATEGY_DESCRIPTOR],
    executeScenario: async (scenario, context) => {
      await barrier;
      return { ok: true, report: fakeReport(scenario) };
    },
  });
  const first = engine.run({ asOf: "2026-08-14T04:00:00.000Z", days: 1 });
  await Promise.resolve();
  await assert.rejects(
    engine.run({ asOf: "2026-08-14T04:00:00.000Z", days: 1 }),
    (error) => error.code === "EXPERIMENT_ALREADY_RUNNING",
  );
  release();
  assert.equal((await first).ok, true);
});

test("strategy experiment engine aborts and drains an active run on dispose", async () => {
  const engine = createStrategyExperimentEngine({
    getConfig: () => ({ experiments: {
      enabled: true,
      enabledStrategyIds: ["control"],
      signalLanes: ["cmb"],
      costMultipliers: [1],
      parameterMultipliers: [1],
      ablations: ["none"],
    } }),
    listStrategies: () => [CONTROL_STRATEGY_DESCRIPTOR],
    executeScenario: (_scenario, context) => new Promise((_resolve, reject) => {
      context.signal.addEventListener("abort", () => {
        const error = new Error("scenario cancelled");
        error.name = "AbortError";
        reject(error);
      }, { once: true });
    }),
  });
  const task = engine.run({ asOf: "2026-08-14T04:00:00.000Z", days: 1 });
  const rejected = assert.rejects(task, (error) => error.name === "AbortError");
  await engine.dispose();
  await rejected;
  await assert.rejects(
    engine.run({ asOf: "2026-08-14T04:00:00.000Z", days: 1 }),
    (error) => error.code === "STRATEGY_EXPERIMENTS_UNAVAILABLE",
  );
});

test("strategy experiment engine reports persistence failures without hiding the completed result", async () => {
  const engine = createStrategyExperimentEngine({
    getConfig: () => ({ experiments: {
      enabled: true, enabledStrategyIds: ["control"], signalLanes: ["cmb"],
      costMultipliers: [1], parameterMultipliers: [1], ablations: ["none"],
    } }),
    listStrategies: () => [CONTROL_STRATEGY_DESCRIPTOR],
    executeScenario: async (scenario, context) => ({ ok: true, report: fakeReport(scenario, context) }),
    file: "/unwritten/strategy-experiment.json",
    writeQueue: async () => {
      const error = new Error("fixture persist denied");
      error.code = "EACCES";
      throw error;
    },
    logger: { warn() {} },
  });
  const result = await engine.run({ asOf: "2026-08-14T04:00:00.000Z", days: 1 });
  assert.equal(result.ok, true);
  assert.equal(result.persisted, false);
  assert.deepEqual(result.persistenceError, { code: "EACCES", message: "fixture persist denied" });
  const latest = await engine.last();
  assert.equal(latest.report.experimentId, result.report.experimentId);
  assert.equal(latest.persisted, false);
  assert.deepEqual(latest.persistenceError, result.persistenceError);
});

test("strategy experiment engine drains and publishes an atomic write once commit starts", async () => {
  const directory = await mkdtemp(join(tmpdir(), "goldboard-experiment-dispose-write-"));
  let releaseWrite;
  let writeStarted;
  const started = new Promise((resolve) => { writeStarted = resolve; });
  const release = new Promise((resolve) => { releaseWrite = resolve; });
  const engine = createStrategyExperimentEngine({
    getConfig: () => ({ experiments: {
      enabled: true, enabledStrategyIds: ["control"], signalLanes: ["cmb"],
      costMultipliers: [1], parameterMultipliers: [1], ablations: ["none"],
    } }),
    listStrategies: () => [CONTROL_STRATEGY_DESCRIPTOR],
    executeScenario: async (scenario, context) => ({ ok: true, report: fakeReport(scenario, context) }),
    file: join(directory, "latest.json"),
    writeQueue: async (write) => {
      writeStarted();
      await release;
      return write();
    },
    logger: { warn() {} },
  });
  try {
    const running = engine.run({ asOf: "2026-08-14T04:00:00.000Z", days: 1 });
    await started;
    const disposing = engine.dispose();
    releaseWrite();
    const committed = await running;
    assert.equal(committed.ok, true);
    assert.equal(committed.persisted, true);
    await disposing;
    const saved = JSON.parse(await readFile(join(directory, "latest.json"), "utf8"));
    assert.equal(saved.report.experimentId, committed.report.experimentId);
  } finally {
    releaseWrite?.();
    await rm(directory, { recursive: true, force: true });
  }
});

test("strategy experiment engine persists and restores the latest isolated report", async () => {
  const directory = await mkdtemp(join(tmpdir(), "goldboard-experiment-"));
  const file = join(directory, "latest.json");
  const config = {
    experiments: {
      enabled: true,
      enabledStrategyIds: ["control"],
      signalLanes: ["cmb"],
      costMultipliers: [1],
      parameterMultipliers: [1],
      ablations: ["none"],
    },
  };
  const options = {
    getConfig: () => config,
    listStrategies: () => [CONTROL_STRATEGY_DESCRIPTOR, ORB_STRATEGY_DESCRIPTOR],
    executeScenario: async (scenario, context) => ({ ok: true, report: fakeReport(scenario, context) }),
    file,
    writeQueue: makeWriteQueue(),
    logger: { warn() {} },
  };
  try {
    const firstEngine = createStrategyExperimentEngine(options);
    const created = await firstEngine.run({ asOf: "2026-08-14T04:00:00.000Z", days: 1 });
    assert.equal(created.ok, true);
    assert.equal(created.report.scenarios.length, 1);

    const coldEngine = createStrategyExperimentEngine(options);
    const restored = await coldEngine.last();
    assert.deepEqual(restored.report, created.report);
    assert.deepEqual(restored.report.run, { days: 1, mode: "diagnostic" });
    assert.ok(restored.report.datasetRefs.cmb);

    await assert.rejects(
      coldEngine.run({ asOf: "2026-08-14T04:00:00.000Z", days: "1" }),
      (error) => error.code === "BAD_EXPERIMENT_DAYS",
    );
    await assert.rejects(
      coldEngine.run({ asOf: "2026-08-14T04:00:00.000Z", strategyIds: [42] }),
      (error) => error.code === "BAD_EXPERIMENT_STRATEGY_IDS",
    );
    await assert.rejects(
      coldEngine.run({ asOf: "2026-08-14T04:00:00.000Z", signalLanes: ["cmb", "cmb"] }),
      (error) => error.code === "BAD_EXPERIMENT_SIGNAL_LANES",
    );
    await assert.rejects(
      coldEngine.run({ asOf: "2026-08-14T04:00:00.000Z", signalLanes: [] }),
      (error) => error.code === "BAD_EXPERIMENT_SIGNAL_LANES",
    );

    const tampered = JSON.parse(await readFile(file, "utf8"));
    tampered.report.promotion.liveStrategyChanged = true;
    await writeFile(file, JSON.stringify(tampered), "utf8");
    assert.equal((await createStrategyExperimentEngine(options).last()).report, null);

    config.experiments.enabled = false;
    await assert.rejects(
      coldEngine.run({ asOf: "2026-08-14T04:00:00.000Z" }),
      (error) => error.code === "EXPERIMENTS_DISABLED",
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
