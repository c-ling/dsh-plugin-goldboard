import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  REPLAY_BENCHMARK_IDS,
  REPLAY_BOOTSTRAP_VERSION,
  REPLAY_REPORT_SCHEMA_VERSION,
  canonicalSha256,
  computeReplayMetrics,
  evaluateReplayValidationGate,
  movingBlockBootstrapInterval,
  projectReplayBenchmarks,
  projectReplayReport,
  projectReplayReportAsync,
  replayReportFingerprint,
  stableCanonicalJson,
  validateReplayReport,
  wilson95Interval,
} from "../lib/replay-report.js";
import {
  REPLAY_REPORT_INDEX_FILE,
  ReplayReportStore,
} from "../lib/replay-store.js";
import {
  walkForwardFoldId,
  walkForwardFoldResultFingerprint,
} from "../lib/walk-forward.js";

const DAY = 24 * 60 * 60_000;
const START = Date.parse("2025-01-01T00:00:00.000Z");

function frames(count = 80) {
  return Array.from({ length: count }, (_, index) => {
    const price = 100 + index * 0.25 + Math.sin(index / 4) * 2;
    return {
      t: START + index * DAY,
      c: price,
      ask: price + 0.1,
      bid: price - 0.1,
      askO: price + 0.1,
      bidO: price - 0.1,
      askC: price + 0.1,
      bidC: price - 0.1,
      lane: "cmb",
      evidence: "real",
    };
  });
}

function completeInput(generatedAt = "2026-02-01T00:00:00.000Z") {
  const path = frames(390);
  const datasetId = `dataset-${"d".repeat(64)}`;
  const foldMetrics = {
    returnInterval: {
      version: REPLAY_BOOTSTRAP_VERSION,
      confidence: 0.95,
      sampleSize: 20,
      lower: -0.01,
      upper: 0.02,
    },
    winRateInterval: {
      confidence: 0.95,
      successes: 11,
      trials: 20,
      lower: 0.34,
      upper: 0.74,
    },
  };
  const benchmark = {
    status: "ok",
    diagnostics: [],
    metrics: { netPnlCny: 0, totalReturn: 0, maxDrawdownCny: 0, samples: { returns: 20 } },
  };
  const foldBenchmarks = Object.fromEntries(REPLAY_BENCHMARK_IDS.map((id) => [id, { id, ...structuredClone(benchmark) }]));
  const factorFingerprint = "f".repeat(64);
  const makeFold = (character, trainFrom, trainTo, testTo) => {
    const fold = {
      status: "completed",
      parametersFrozen: true,
      parameterFingerprint: character.repeat(64),
      datasetId,
      datasetContentSha256: "c".repeat(64),
      executionDatasetId: datasetId,
      executionDatasetContentSha256: "c".repeat(64),
      factorFingerprint,
      simulationFingerprint: "4".repeat(64),
      asOf: testTo,
      warmup: {
        policy: "point-in-time-history-only",
        frames: 0,
        from: null,
        to: null,
        stateFingerprint: "5".repeat(64),
      },
      parameterPrecommit: { verified: true, committedAt: trainFrom },
      train: { from: trainFrom, toExclusive: trainTo, months: 6, coveredMonths: 6, qualifyingMonths: 6, minimumSessionsPerMonth: 10, completeSessions: 120 },
      test: { from: trainTo, toExclusive: testTo, months: 1, coveredMonths: 1, qualifyingMonths: 1, minimumSessionsPerMonth: 10, completeSessions: 20 },
      sampleCount: 20,
      metrics: structuredClone(foldMetrics),
      benchmarks: structuredClone(foldBenchmarks),
      diagnostics: [],
    };
    fold.foldId = walkForwardFoldId(fold);
    fold.resultFingerprint = walkForwardFoldResultFingerprint(fold);
    return fold;
  };
  const folds = [
    makeFold("a", "2025-01-01T00:00:00.000Z", "2025-07-01T00:00:00.000Z", "2025-08-01T00:00:00.000Z"),
    makeFold("b", "2025-02-01T00:00:00.000Z", "2025-08-01T00:00:00.000Z", "2025-09-01T00:00:00.000Z"),
  ];
  const oos = {
    version: "goldboard-walk-forward-registry-v1",
    registryId: `walk-forward-${"e".repeat(64)}`,
    datasetId,
    folds,
  };
  oos.resultFingerprint = canonicalSha256({
    registryId: oos.registryId,
    folds: folds.map((fold) => ({
      foldId: fold.foldId,
      status: fold.status,
      resultFingerprint: fold.resultFingerprint,
    })),
  });
  return {
    generatedAt,
    asOf: "2026-01-31T00:00:00.000Z",
    simulation: {
      frames: path,
      initialCapitalCny: 10_000,
      incompleteSessions: 0,
      diagnostics: { conflictingDuplicates: 0, invalidFramesIgnored: 0, futureFramesIgnored: 0 },
      equityCurve: [
        { t: START, equity: 10_000, exposureCny: 0, capitalUsedCny: 0 },
        { t: START + DAY, equity: 10_100, exposureCny: 5_000, capitalUsedCny: 5_000 },
        { t: START + DAY * 2, equity: 10_050, exposureCny: 5_200, capitalUsedCny: 5_000 },
        { t: START + DAY * 3, equity: 10_300, exposureCny: 0, capitalUsedCny: 0 },
      ],
      fills: [
        { side: "buy", price: 100, grams: 50, explicitFeeCny: 5, slippageCny: 2, ask: 100, bid: 99.8 },
        { side: "sell", price: 106, grams: 50, explicitFeeCny: 5, slippageCny: 2, ask: 106.2, bid: 106, realizedPnlCny: 286 },
      ],
      events: [{ id: "strategy-event" }],
      ledger: [{ id: "strategy-ledger", untouched: true }],
    },
    dataset: {
      version: "goldboard-replay-dataset-v1",
      datasetId,
      contentSha256: "c".repeat(64),
      inputFingerprint: "i".repeat(64).replaceAll("i", "1"),
      lane: "cmb",
      pointInTimePolicy: "known-by-bar-close",
      dateRange: { from: "2025-01-01T00:00:00.000Z", to: "2026-02-01T00:00:00.000Z" },
      quarantinedPartitions: 0,
      rejectedRecords: 0,
      records: { missingIngestedAtBars: 0 },
      partitions: [{
        tradingDay: "2025-01-02",
        contentSha256: "2".repeat(64),
        storeContentSha256: "3".repeat(64),
        rejected: 0,
        quarantined: false,
      }],
      sessions: {
        total: 1,
        complete: 1,
        partial: 0,
        coverageKnown: true,
        items: [{ status: "complete", coverageComplete: true }],
      },
    },
    oos,
    provenance: {
      factorFingerprint,
      costVerification: { status: "verified", source: "fixture-product-agreement", version: "fixture-v1" },
    },
  };
}

test("canonical SHA-256 is key-order stable and rejects circular structures", () => {
  assert.equal(stableCanonicalJson({ z: 1, a: { y: 2, x: 3 } }), '{"a":{"x":3,"y":2},"z":1}');
  assert.equal(canonicalSha256({ b: 2, a: 1 }), canonicalSha256({ a: 1, b: 2 }));
  const circular = {};
  circular.self = circular;
  assert.throws(() => canonicalSha256(circular), /circular/);
});

test("metrics handle drawdown, costs, risk ratios, utilization and profit-factor edges", () => {
  const result = computeReplayMetrics({
    initialCapitalCny: 100,
    equityCurve: [
      { t: START, equity: 100, exposureCny: 0, capitalUsedCny: 0 },
      { t: START + DAY, equity: 120, exposureCny: 60, capitalUsedCny: 50 },
      { t: START + DAY * 2, equity: 90, exposureCny: 45, capitalUsedCny: 40 },
      { t: START + DAY * 3, equity: 130, exposureCny: 0, capitalUsedCny: 0 },
    ],
    fills: [
      { price: 10, grams: 5, explicitFeeCny: 1, slippageCny: 0.5, ask: 10.1, bid: 9.9, realizedPnlCny: 8 },
      { price: 12, grams: 5, explicitFeeCny: 2, slippageCny: 0.25, realizedPnlCny: -4 },
    ],
  }, { bootstrapIterations: 100, seed: "metrics" });
  assert.equal(result.netPnlCny, 30);
  assert.equal(result.costs.explicitFeesCny, 3);
  assert.equal(result.costs.slippageCny, 0.75);
  assert.equal(result.costs.quotedSpreadKnown, false);
  assert.equal(result.costs.quotedSpreadCny, null);
  assert.equal(result.maxDrawdownCny, 30);
  assert.equal(result.maxDrawdownPct, 0.25);
  assert.equal(result.maxDrawdownDurationMs, DAY);
  assert.equal(result.exposureRatio, 0.5);
  assert.equal(result.capitalUtilization, 0.225);
  assert.equal(result.turnoverCny, 110);
  assert.equal(result.turnover, 1.1);
  assert.equal(result.profitFactor, 2);
  assert.ok(Number.isFinite(result.sharpe));
  assert.ok(Number.isFinite(result.sortino));
  assert.ok(Number.isFinite(result.calmar));

  const noLosses = computeReplayMetrics({ initialCapitalCny: 100, fills: [{ realizedPnlCny: 5 }] });
  assert.equal(noLosses.profitFactor, null, "no-loss samples do not claim infinite profit factor");
  assert.equal(noLosses.sharpe, null);
  assert.equal(noLosses.sortino, null);
});

test("Wilson and moving-block intervals cover empty, singleton, and deterministic samples", () => {
  assert.deepEqual(wilson95Interval(0, 0), { confidence: 0.95, successes: 0, trials: 0, estimate: null, lower: null, upper: null });
  const allWins = wilson95Interval(10, 10);
  assert.equal(allWins.estimate, 1);
  assert.ok(allWins.lower > 0 && allWins.upper === 1);
  const empty = movingBlockBootstrapInterval([], { seed: "fixed", iterations: 50 });
  assert.equal(empty.lower, null);
  const singleton = movingBlockBootstrapInterval([0.02], { seed: "fixed", iterations: 50 });
  assert.equal(singleton.lower, 0.02);
  assert.equal(singleton.upper, 0.02);
  const first = movingBlockBootstrapInterval([0.1, -0.04, 0.03, 0.02, -0.01], { seed: "fixed", iterations: 200, blockLength: 2 });
  const second = movingBlockBootstrapInterval([0.1, -0.04, 0.03, 0.02, -0.01], { seed: "fixed", iterations: 200, blockLength: 2 });
  assert.deepEqual(second, first);
});

test("four benchmark projections are independent and do not mutate strategy inputs", () => {
  const path = frames();
  const ledger = [{ id: "strategy-only", nested: { count: 1 } }];
  const beforeFrames = structuredClone(path);
  const beforeLedger = structuredClone(ledger);
  const benchmarks = projectReplayBenchmarks({ frames: path, initialCapitalCny: 10_000, ledger }, { dcaIntervalFrames: 10, smaShortWindow: 3, smaLongWindow: 8 });
  assert.deepEqual(Object.keys(benchmarks), REPLAY_BENCHMARK_IDS);
  assert.deepEqual(path, beforeFrames);
  assert.deepEqual(ledger, beforeLedger);
  assert.equal(benchmarks.no_trade.trades.length, 0);
  assert.equal(benchmarks.buy_and_hold.trades.length, 1);
  assert.ok(benchmarks.fixed_interval_dca.trades.length > 1);
  assert.ok(benchmarks.simple_moving_average.trades.length > 0);
  assert.notStrictEqual(benchmarks.buy_and_hold.trades, benchmarks.fixed_interval_dca.trades);
  assert.ok(Object.values(benchmarks).every((benchmark) => benchmark.status === "ok"));
});

test("SMA uses pre-test closes but executes only on the next test frame", () => {
  const warmup = [0, 1, 2].map((index) => ({
    t: START + index * DAY,
    c: 100 + index,
    askO: 100.1 + index,
    ask: 100.2 + index,
    bidO: 99.9 + index,
    bid: 100 + index,
  }));
  const testFrames = [3, 4].map((index) => ({
    t: START + index * DAY,
    c: 100 + index,
    askO: 100.1 + index,
    ask: 100.2 + index,
    bidO: 99.9 + index,
    bid: 100 + index,
  }));
  const warmed = projectReplayBenchmarks({ frames: testFrames, warmupFrames: warmup, initialCapitalCny: 10_000 }, {
    warmupFrames: warmup, smaShortWindow: 2, smaLongWindow: 3,
  });
  const cold = projectReplayBenchmarks({ frames: testFrames, initialCapitalCny: 10_000 }, {
    smaShortWindow: 2, smaLongWindow: 3,
  });
  const trade = warmed.simple_moving_average.trades[0];
  assert.equal(trade.signalAt, new Date(warmup.at(-1).t).toISOString());
  assert.equal(trade.t, new Date(testFrames[0].t).toISOString());
  assert.ok(Date.parse(trade.t) > Date.parse(trade.signalAt));
  assert.equal(trade.executionPoint, "open");
  assert.equal(cold.simple_moving_average.trades.length, 0);
  assert.equal(warmed.simple_moving_average.metrics.samples.returns, testFrames.length - 1);
});

test("benchmarks never manufacture executable ask or bid from a reference close", () => {
  const oneSided = frames(20).map((frame) => ({
    ...frame, ask: null, bid: null, askO: null, bidO: null, askC: null, bidC: null, evidence: "unknown",
  }));
  const benchmarks = projectReplayBenchmarks({ frames: oneSided, initialCapitalCny: 10_000 }, {
    dcaIntervalFrames: 5,
    smaShortWindow: 2,
    smaLongWindow: 4,
  });
  assert.equal(benchmarks.no_trade.status, "ok");
  assert.equal(benchmarks.buy_and_hold.trades.length, 0);
  assert.equal(benchmarks.buy_and_hold.status, "partial");
  assert.equal(benchmarks.fixed_interval_dca.trades.length, 0);
  assert.equal(benchmarks.fixed_interval_dca.status, "partial");
  assert.equal(benchmarks.simple_moving_average.trades.length, 0);
  assert.equal(benchmarks.simple_moving_average.status, "partial");
});

test("validation gate is dynamic and fail-closed for every missing requirement", () => {
  const input = completeInput();
  const valid = projectReplayReport(input);
  assert.equal(valid.validationGate.eligible, true);
  assert.equal(valid.evidenceStatus, "validated");
  assert.equal(valid.reportSchemaVersion, REPLAY_REPORT_SCHEMA_VERSION);
  assert.deepEqual(valid.groups.lane, { cmb: 390, au9999: 0, unknown: 0 });
  assert.deepEqual(valid.groups.sessionCompleteness, { complete: 1, partial: 0, excluded: 0, unknown: 0 });
  assert.deepEqual(valid.groups.executionEvidence, { real: 390, proxy: 0, synthetic: 0, unknown: 0 });

  const tamperedRegistry = completeInput();
  tamperedRegistry.oos.folds.reverse();
  const tampered = projectReplayReport(tamperedRegistry);
  assert.equal(tampered.validationGate.eligible, false);
  assert.ok(tampered.validationGate.unmet.includes("oos_registry"), "registry result fingerprint binds fold order/content");

  const insufficient = completeInput();
  insufficient.dataset.dateRange.to = "2025-11-30T23:59:59.999Z";
  delete insufficient.dataset.records;
  insufficient.simulation.frames[0].evidence = "proxy";
  insufficient.oos.folds = [{ status: "completed", parametersFrozen: false }];
  insufficient.provenance.costVerification = { status: "unverified", source: "fixture", version: "fixture-v1" };
  const gate = evaluateReplayValidationGate({
    dataset: insufficient.dataset,
    oos: insufficient.oos,
    simulation: insufficient.simulation,
    benchmarks: {},
    metrics: computeReplayMetrics({}, { bootstrapIterations: 10 }),
  });
  assert.equal(gate.eligible, false);
  assert.deepEqual(gate.unmet.sort(), [
    "benchmark_comparison",
    "frozen_oos_parameters",
    "historical_parameter_precommit",
    "minimum_history_months",
    "multiple_oos_folds",
    "oos_fold_integrity",
    "oos_registry",
    "point_in_time_ingestion",
    "real_bid_ask_evidence",
    "uncertainty_intervals",
    "verified_cost_semantics",
  ]);
  const report = projectReplayReport(insufficient);
  assert.equal(report.evidenceStatus, "exploratory");
});

test("input and report fingerprints are deterministic and exclude generated identity", () => {
  const first = projectReplayReport(completeInput("2026-02-01T00:00:00.000Z"));
  const second = projectReplayReport(completeInput("2026-03-01T00:00:00.000Z"));
  second.reportId = "external-id";
  assert.equal(first.inputFingerprint, second.inputFingerprint);
  assert.equal(first.reportFingerprint, second.reportFingerprint);
  assert.equal(replayReportFingerprint(second), first.reportFingerprint);

  const operational = completeInput();
  operational.dataset.partitions[0].storeContentSha256 = "4".repeat(64);
  operational.dataset.partitions[0].rejected = 3;
  operational.dataset.rejectedRecords = 3;
  const operationalReport = projectReplayReport(operational);
  assert.equal(operationalReport.inputFingerprint, first.inputFingerprint, "post-asOf store diagnostics do not change semantic input identity");
  assert.equal(operationalReport.reportFingerprint, first.reportFingerprint);

  const traced = completeInput();
  traced.simulation.evaluations = [{
    at: "2026-01-01T00:00:00.000Z",
    nextStateFingerprint: "sha256:" + "9".repeat(64),
    diagnostics: [{ type: "setup_lifecycle", value: { phase: "armed" } }],
  }];
  const tracedReport = projectReplayReport(traced);
  assert.equal(tracedReport.inputFingerprint, first.inputFingerprint, "operational evaluation traces do not inflate semantic identity");
  assert.equal(tracedReport.reportFingerprint, first.reportFingerprint);

  const changed = completeInput();
  changed.simulation.policy = { ambiguity: "best-case" };
  const third = projectReplayReport(changed);
  assert.notEqual(third.inputFingerprint, first.inputFingerprint);
  assert.notEqual(third.reportFingerprint, first.reportFingerprint);
});

test("cooperative report projection matches synchronous output and aborts during bootstrap", async () => {
  const deterministic = completeInput();
  deterministic.intervalOptions = { bootstrapIterations: 64 };
  deterministic.benchmarkOptions = { initialCapitalCny: 10_000, bootstrapIterations: 32 };
  assert.deepEqual(await projectReplayReportAsync(deterministic), projectReplayReport(deterministic));

  const controller = new AbortController();
  const long = completeInput();
  long.intervalOptions = { bootstrapIterations: 100_000, chunkSize: 1 };
  const running = projectReplayReportAsync(long, { signal: controller.signal });
  setImmediate(() => controller.abort(new Error("cancel-statistics")));
  await assert.rejects(running, (error) => error?.name === "AbortError");
});

test("partial-session reports retain cold validation gate inputs across storage", async () => {
  const directory = await mkdtemp(join(tmpdir(), "goldboard-report-partial-"));
  try {
    const input = completeInput();
    input.simulation.incompleteSessions = 1;
    const report = projectReplayReport(input);
    assert.equal(report.validationGate.eligible, false);
    assert.ok(report.validationGate.unmet.includes("incomplete_sessions"));
    assert.equal(report.simulation.incompleteSessions, 1);
    validateReplayReport(structuredClone(report));
    const store = new ReplayReportStore({ directory });
    await store.save(report);
    const cold = new ReplayReportStore({ directory });
    const restored = (await cold.latest()).report;
    assert.equal(restored.simulation.incompleteSessions, 1);
    assert.deepEqual(restored.validationGate, report.validationGate);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("ReplayReportStore survives cold restart, retains newest reports, and never rewrites old bytes", async () => {
  const directory = await mkdtemp(join(tmpdir(), "goldboard-report-store-"));
  try {
    const store = new ReplayReportStore({ directory, limit: 2 });
    const reports = [0, 1, 2].map((offset) => {
      const input = completeInput(new Date(Date.parse("2026-02-01T00:00:00.000Z") + offset * DAY).toISOString());
      input.asOf = new Date(Date.parse("2026-01-31T00:00:00.000Z") + offset * DAY).toISOString();
      return projectReplayReport(input);
    });
    const reportIds = reports.map((report) => report.reportId);
    await store.save(reports[0]);
    const firstEntry = (await store.list())[0];
    const firstFile = join(directory, firstEntry.detailFile);
    const originalBytes = await readFile(firstFile);
    await store.save(structuredClone(reports[0]));
    assert.deepEqual(await readFile(firstFile), originalBytes);
    await store.save(reports[1]);
    await store.save(reports[2]);
    assert.deepEqual((await store.list()).map((entry) => entry.reportId), [reportIds[2], reportIds[1]]);

    const cold = new ReplayReportStore({ directory, limit: 2 });
    assert.equal((await cold.latest()).report.reportId, reportIds[2]);
    assert.equal((await cold.get(reportIds[1], { detail: true })).report.reportId, reportIds[1]);
    assert.equal(await cold.get(reportIds[0]), null, "evicted report details are pruned with the durable index");
    await assert.rejects(readFile(firstFile), /ENOENT/);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("ReplayReportStore repairs a corrupt index when immutable detail bytes still exist", async () => {
  const directory = await mkdtemp(join(tmpdir(), "goldboard-report-store-repair-"));
  try {
    const report = projectReplayReport(completeInput());
    const first = new ReplayReportStore({ directory });
    await first.save({ report, events: [{ id: "kept" }] });
    await writeFile(join(directory, REPLAY_REPORT_INDEX_FILE), "not-json", "utf8");

    const restarted = new ReplayReportStore({ directory });
    assert.equal((await restarted.list()).length, 1, "cold list rebuilds the missing index from immutable details");
    assert.equal((await restarted.latest({ detail: true })).report.reportId, report.reportId);
    const recovered = await restarted.save({ report, events: [{ id: "replacement-must-not-overwrite" }] });
    assert.deepEqual(recovered.events, [{ id: "kept" }]);
    assert.equal((await restarted.list()).length, 1);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("ReplayReportStore tolerates corrupt index/detail and preserves legacy latest fallback bytes", async () => {
  const directory = await mkdtemp(join(tmpdir(), "goldboard-report-corrupt-"));
  const legacyFile = join(directory, "replay-stats.json");
  const legacy = JSON.stringify({ report: { reportId: "legacy-4", version: 4, generatedAt: "2024-01-01T00:00:00.000Z" }, events: [{ id: 1 }] });
  try {
    await writeFile(legacyFile, legacy, "utf8");
    await writeFile(join(directory, REPLAY_REPORT_INDEX_FILE), "{broken", "utf8");
    const empty = new ReplayReportStore({ directory });
    assert.deepEqual(await empty.list(), []);
    assert.equal(await empty.latest(), null);

    const fallback = new ReplayReportStore({ directory, legacyLatestFile: legacyFile });
    assert.equal((await fallback.latest()).report.reportId, "legacy-4");
    assert.deepEqual((await fallback.latest({ detail: true })).events, [{ id: 1 }]);
    assert.equal(await readFile(legacyFile, "utf8"), legacy);

    const current = projectReplayReport(completeInput());
    await fallback.save(current);
    const [entry] = await fallback.list();
    await writeFile(join(directory, entry.detailFile), "not-json", "utf8");
    assert.equal((await fallback.latest()).report.reportId, "legacy-4", "corrupt current detail falls through to legacy");
    assert.equal(await fallback.get(current.reportId), null);
    assert.equal(await readFile(legacyFile, "utf8"), legacy);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
