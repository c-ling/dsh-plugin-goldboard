import {
  REPLAY_BOOTSTRAP_VERSION,
  REPLAY_BENCHMARK_IDS,
  canonicalSha256,
  evaluateReplayValidationGate,
  projectReplayReport,
  replayReportFingerprint,
} from "../../lib/replay-report.js";
import {
  walkForwardFoldId,
  walkForwardFoldResultFingerprint,
} from "../../lib/walk-forward.js";

const DAY = 24 * 60 * 60_000;
const START = Date.parse("2025-01-01T00:00:00.000Z");

export function replayFrames(count = 80) {
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

export function completeReplayInput(generatedAt = "2026-02-01T00:00:00.000Z") {
  const path = replayFrames(390);
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

const BENCHMARK_IDS = ["no_trade", "buy_and_hold", "fixed_interval_dca", "simple_moving_average"];

function completedFoldNet(fold) {
  return Number(fold?.metrics?.netPnlCny ?? 0);
}

/** Build a schema-valid replay report and attach experiment attestation fields. */
export function buildExperimentReport(scenario, options = {}) {
  const base = completeReplayInput();
  if (options.exploratory === true) {
    base.oos = { ...base.oos, folds: [] };
  }
  const report = projectReplayReport(base);
  const asOf = options.asOf ?? report.asOf;
  report.asOf = new Date(asOf).toISOString();
  report.generatedAt = new Date(options.generatedAt ?? asOf).toISOString();
  report.lane = scenario.signalLane;
  report.dataset.asOf = report.asOf;
  report.fillPolicy = report.fillPolicy ?? "next_bar_touch";
  report.ambiguityPolicy = report.ambiguityPolicy ?? "worst_case";
  report.executionVersion = report.executionVersion ?? "fixture-execution-v1";

  const parameters = scenario.strategyParameters && typeof scenario.strategyParameters === "object"
    ? structuredClone(scenario.strategyParameters) : {};
  const requiredFactorIds = Array.isArray(parameters.requiredFactorIds)
    ? [...parameters.requiredFactorIds].sort() : [];
  const factorVintages = [];
  const parameterFingerprint = canonicalSha256({
    parameters,
    parameterMultiplier: scenario.parameterMultiplier,
    ablation: scenario.ablation,
  });
  const factorFingerprint = canonicalSha256({ requiredFactorIds, factorRecords: [] });

  report.params = {
    mode: scenario.mode ?? "walk-forward",
    strategyId: scenario.strategyId,
    strategyVersion: scenario.strategyVersion,
    strategyParameters: parameters,
    costMultiplier: scenario.costMultiplier,
    parameterMultiplier: scenario.parameterMultiplier,
    ablation: scenario.ablation,
    executionLane: "cmb",
    lane: scenario.signalLane,
  };
  const experiment = {
    replayOnly: scenario.strategyId !== "control",
    liveStrategyChanged: false,
    costMultiplier: scenario.costMultiplier,
    parameterMultiplier: scenario.parameterMultiplier,
    ablation: scenario.ablation,
  };
  report.provenance = {
    ...report.provenance,
    experiment,
    strategyId: scenario.strategyId,
    strategyVersion: scenario.strategyVersion,
    strategyDescriptorFingerprint: scenario.strategyDescriptorFingerprint,
    executionInstrument: "CMB_ACCUMULATED_GOLD",
    executionLane: "cmb",
    parameterFingerprint,
    factorFingerprint,
    factorVintages,
    costVerification: { status: "verified", source: "fixture-product-agreement", version: "fixture-v1" },
    executionDataset: {
      ...structuredClone(report.dataset),
      asOf: report.asOf,
      alignment: { coverage: 1 },
    },
  };
  report.experiment = structuredClone(experiment);

  // The gate binds folds to provenance.factorFingerprint; use the same value
  // the experiment attestation will recompute.
  let folds = Array.isArray(report.oos.folds) ? report.oos.folds : [];
  for (const fold of folds) {
    fold.factorFingerprint = factorFingerprint;
    if (Number.isFinite(Number(options.benchmarkNetPnlCny))) {
      for (const id of BENCHMARK_IDS) {
        if (fold.benchmarks?.[id]?.metrics) {
          fold.benchmarks[id].metrics.netPnlCny = Number(options.benchmarkNetPnlCny);
        }
      }
    }
    if (Number.isFinite(Number(options.oosMaxDrawdownCny))) {
      fold.metrics.maxDrawdownCny = Number(options.oosMaxDrawdownCny);
    }
    fold.resultFingerprint = walkForwardFoldResultFingerprint(fold);
  }
  report.oos.resultFingerprint = canonicalSha256({
    registryId: report.oos.registryId,
    folds: folds.map((fold) => ({ foldId: fold.foldId, status: fold.status, resultFingerprint: fold.resultFingerprint })),
  });
  report.oos.registeredFolds = folds.length;
  report.oos.completedFolds = folds.length;
  report.oos.status = folds.length >= 2 ? "completed" : "insufficient_data";

  if (options.oosNetPnlCny !== undefined) {
    const target = options.oosNetPnlCny;
    if (target === null) {
      for (const fold of folds) fold.metrics = { ...fold.metrics, netPnlCny: null };
    } else if (folds.length > 0) {
      const perFold = target / folds.length;
      for (const fold of folds) fold.metrics = { ...fold.metrics, netPnlCny: perFold };
    }
    for (const fold of folds) fold.resultFingerprint = walkForwardFoldResultFingerprint(fold);
    report.oos.resultFingerprint = canonicalSha256({
      registryId: report.oos.registryId,
      folds: folds.map((fold) => ({ foldId: fold.foldId, status: fold.status, resultFingerprint: fold.resultFingerprint })),
    });
    report.oos.registeredFolds = folds.length;
    report.oos.completedFolds = folds.length;
    report.oos.metrics = {
      netPnlCny: target,
      maxDrawdownCny: folds.length ? Math.max(...folds.map((fold) => Number(fold.metrics?.maxDrawdownCny ?? 0))) : null,
    };
  }

  folds = Array.isArray(report.oos.folds) ? report.oos.folds : [];
  report.oos.metrics = {
    netPnlCny: folds.length > 0 && folds.every((fold) => Number.isFinite(Number(fold.metrics?.netPnlCny)))
      ? folds.reduce((sum, fold) => sum + Number(fold.metrics.netPnlCny), 0) : null,
    maxDrawdownCny: folds.length ? Math.max(...folds.map((fold) => Number(fold.metrics?.maxDrawdownCny ?? 0))) : null,
  };
  if (Number.isFinite(Number(options.fullSampleNetPnlCny))) report.metrics.netPnlCny = Number(options.fullSampleNetPnlCny);
  if (Number.isFinite(Number(options.oosMaxDrawdownCny))) report.metrics.maxDrawdownCny = Number(options.oosMaxDrawdownCny);

  report.validationGate = evaluateReplayValidationGate({
    dataset: report.dataset,
    oos: report.oos,
    simulation: report.simulation,
    benchmarks: report.benchmarks,
    metrics: report.metrics,
    groups: report.groups,
    provenance: report.provenance,
  });
  report.evidenceStatus = report.validationGate.eligible ? "validated" : "exploratory";
  report.reportFingerprint = replayReportFingerprint(report);
  report.reportId = `replay-${report.reportFingerprint.slice(0, 24)}`;
  return report;
}
