import assert from "node:assert/strict";
import test from "node:test";

import {
  REPLAY_DATASET_VERSION,
  buildReplayDataset,
  buildReplayDatasetFromBars,
  buildReplayDatasetFromStore,
} from "../lib/replay-dataset.js";
import {
  WALK_FORWARD_REGISTRY_VERSION,
  createWalkForwardRegistry,
  frozenParameterFingerprint,
  runWalkForward,
  selectWalkForwardTestFrames,
} from "../lib/walk-forward.js";

const SCHEMA = "goldboard-market-data-v2";
const CALENDAR = "goldboard-cmb-reminder-v2";

function quote(minute, { ask = 100 + minute, bid = 99 + minute, evidence = "real", ingestedAt = null, source = "cmb" } = {}) {
  const sourceTimestamp = new Date(Date.UTC(2026, 0, 2, 0, minute)).toISOString();
  return {
    eventId: `q-${minute}-${evidence}`,
    instrument: "CMB_ACCUMULATED_GOLD",
    source,
    sourceTimestamp,
    receivedAt: sourceTimestamp,
    ingestedAt: ingestedAt ?? sourceTimestamp,
    dataSchemaVersion: SCHEMA,
    evidence,
    customerAsk: ask,
    ...(bid === null ? {} : { customerBid: bid }),
  };
}

function completeSession(tradingDay) {
  return { tradingDay, bars: 1, completeBars: 1, partialBars: 0, executionIncompleteBars: 0, coverageComplete: true };
}

function monthlySessions(months = 8, perMonth = 10) {
  return Array.from({ length: months }, (_, month) =>
    Array.from({ length: perMonth }, (_, day) =>
      completeSession(`2025-${String(month + 1).padStart(2, "0")}-${String(day + 1).padStart(2, "0")}`)))
    .flat();
}

function manifestForRange(from, to, sessions = []) {
  return {
    datasetId: "dataset-fixture",
    contentSha256: "a".repeat(64),
    dateRange: { from, to },
    sessions: {
      total: sessions.length,
      complete: sessions.length,
      partial: 0,
      coverageKnown: true,
      items: sessions,
    },
  };
}

test("buildReplayDataset creates natural 5m and 60m ask/bid OHLC with deterministic manifest", () => {
  const records = Array.from({ length: 60 }, (_, minute) => quote(minute));
  const input = {
    records,
    asOf: "2026-01-02T01:00:00.000Z",
    dataSchemaVersion: SCHEMA,
    calendarVersion: CALENDAR,
    sourceVersion: "cmb-market-center-v1",
    tradingDayForTimestamp: () => "2026-01-02",
  };
  const first = buildReplayDataset(input);
  const second = buildReplayDataset({ ...input, records: [...records].reverse() });

  assert.equal(first.version, REPLAY_DATASET_VERSION);
  assert.equal(first.bars[5].length, 12);
  assert.equal(first.bars[60].length, 1);
  assert.deepEqual(first.bars[5][0], second.bars[5][0]);
  assert.equal(first.bars[5][0].t, Date.parse("2026-01-02T00:00:00.000Z"));
  assert.deepEqual(
    [first.bars[5][0].askO, first.bars[5][0].askH, first.bars[5][0].askL, first.bars[5][0].askC],
    [100, 104, 100, 104],
  );
  assert.deepEqual(
    [first.bars[5][0].bidO, first.bars[5][0].bidH, first.bars[5][0].bidL, first.bars[5][0].bidC],
    [99, 103, 99, 103],
  );
  assert.equal(first.bars[5][0].partial, false);
  assert.equal(first.bars[60][0].sampleCount, 60);
  assert.equal(first.bars[60][0].partial, false);
  assert.equal(first.manifest.dataSchemaVersion, SCHEMA);
  assert.equal(first.manifest.calendarVersion, CALENDAR);
  assert.equal(first.manifest.sourceVersion, "cmb-market-center-v1");
  assert.deepEqual(first.manifest.evidence, { real: 60, synthetic: 0, proxy: 0, unknown: 0 });
  assert.deepEqual(first.manifest.sessions, {
    total: 1,
    complete: 1,
    partial: 0,
    executionComplete: 1,
    executionIncomplete: 0,
    coverageKnown: false,
    items: [{
      tradingDay: "2026-01-02",
      bars: 12,
      completeBars: 12,
      partialBars: 0,
      executionCompleteBars: 12,
      executionIncompleteBars: 0,
      expectedBars: null,
      missingBars: null,
      missingTimestamps: [],
      coverage: null,
      coverageComplete: null,
      firstExpectedAt: null,
      lastExpectedAt: null,
      firstObservedAt: "2026-01-02T00:00:00.000Z",
      lastObservedAt: "2026-01-02T00:55:00.000Z",
    }],
  });
  assert.match(first.manifest.contentSha256, /^[a-f0-9]{64}$/);
  assert.match(first.manifest.inputFingerprint, /^[a-f0-9]{64}$/);
  assert.equal(second.manifest.datasetId, first.manifest.datasetId);
  assert.equal(second.manifest.contentSha256, first.manifest.contentSha256);
  assert.equal(second.manifest.inputFingerprint, first.manifest.inputFingerprint);
});

test("dataset excludes future source and late-ingested records at explicit asOf", () => {
  const records = [
    quote(0),
    quote(1),
    quote(2, { ingestedAt: "2026-01-02T00:10:00.000Z" }),
    quote(4),
    quote(6),
  ];
  const dataset = buildReplayDataset({ records, asOf: "2026-01-02T00:05:00.000Z", dataSchemaVersion: SCHEMA });

  assert.equal(dataset.manifest.records.accepted, 3, "minutes 0, 1 and 4 are point-in-time visible");
  assert.equal(dataset.manifest.records.excludedAsOf, 2, "late ingestion and future source time are excluded");
  assert.equal(dataset.bars[5].length, 1);
  assert.equal(dataset.bars[5][0].sampleCount, 3);
  assert.equal(dataset.bars[5][0].partial, true);
  assert.deepEqual(dataset.bars[5][0].missingBuckets, [
    "2026-01-02T00:02:00.000Z",
    "2026-01-02T00:03:00.000Z",
  ]);
  assert.equal(dataset.bars[5][0].askH, 104);
});

test("record aggregation excludes quotes first ingested after their bar closed", () => {
  const dataset = buildReplayDataset({
    records: [
      quote(0, { ingestedAt: "2026-01-02T00:06:00.000Z" }),
      quote(5),
    ],
    asOf: "2026-01-02T00:10:00.000Z",
  });
  assert.equal(dataset.manifest.records.accepted, 1);
  assert.equal(dataset.manifest.records.excludedAsOf, 1);
  assert.deepEqual(dataset.bars[5].map((bar) => bar.t), [Date.parse("2026-01-02T00:05:00.000Z")]);
});

test("bar projection excludes rolling bars ingested after explicit asOf", () => {
  const asOf = "2026-01-02T00:10:00.000Z";
  const makeBar = (minute, ingestedAt) => ({
    t: Date.parse(`2026-01-02T00:${String(minute).padStart(2, "0")}:00.000Z`),
    o: 100, h: 101, l: 99, c: 100, partial: false, ingestedAt,
  });
  const dataset = buildReplayDatasetFromBars({
    bars5: [
      makeBar(0, "2026-01-03T00:00:00.000Z"),
      makeBar(5, "2026-01-02T00:09:00.000Z"),
    ],
    asOf,
  });
  assert.deepEqual(dataset.bars[5].map((bar) => bar.t), [Date.parse("2026-01-02T00:05:00.000Z")]);
  assert.equal(dataset.manifest.records.excludedLateIngestedBars, 1);
});

test("strict point-in-time bar projection excludes unknown and post-close ingestion", () => {
  const start = Date.parse("2026-01-02T00:00:00.000Z");
  const makeBar = (offset, ingestedAt) => ({
    t: start + offset,
    o: 100, h: 101, l: 99, c: 100, partial: false,
    ...(ingestedAt ? { ingestedAt } : {}),
  });
  const dataset = buildReplayDatasetFromBars({
    bars5: [
      makeBar(0, null),
      makeBar(300_000, "2026-01-02T00:11:00.000Z"),
      makeBar(600_000, "2026-01-02T00:15:00.000Z"),
    ],
    asOf: "2026-01-02T00:20:00.000Z",
    requirePointInTimeIngestion: true,
  });
  assert.deepEqual(dataset.bars[5].map((bar) => bar.t), [start + 600_000]);
  assert.equal(dataset.manifest.pointInTimePolicy, "known-by-bar-close");
  assert.equal(dataset.manifest.records.excludedMissingIngestedAtBars, 1);
  assert.equal(dataset.manifest.records.excludedLateIngestedBars, 1);
  assert.equal(dataset.manifest.records.missingIngestedAtBars, 0);
});

test("dataset excludes closed-market quotes before bars and manifest coverage", () => {
  const records = [quote(0), quote(1), quote(2), quote(3), quote(4)];
  const dataset = buildReplayDataset({
    records,
    asOf: "2026-01-02T00:05:00.000Z",
    acceptTimestamp: (timestamp) => new Date(timestamp).getUTCMinutes() < 2,
  });
  assert.equal(dataset.manifest.records.accepted, 2);
  assert.equal(dataset.manifest.records.excludedMarketHours, 3);
  assert.equal(dataset.bars[5][0].sampleCount, 2);
  assert.equal(dataset.bars[5][0].partial, true);
});

test("dataset preserves proxy and unknown evidence and never invents missing bid", () => {
  const records = [
    quote(0, { evidence: "real" }),
    quote(1, { evidence: "proxy", bid: null, source: "manual" }),
    quote(2, { evidence: "unknown", bid: null, source: "legacy" }),
    quote(3, { evidence: "real" }),
    quote(4, { evidence: "real" }),
  ];
  const dataset = buildReplayDataset({ records, asOf: "2026-01-02T00:05:00.000Z" });
  const bar = dataset.bars[5][0];

  assert.deepEqual(dataset.manifest.evidence, { real: 3, synthetic: 0, proxy: 1, unknown: 1 });
  assert.equal(bar.evidence, "unknown");
  assert.equal(bar.executionSideComplete, false);
  assert.equal(bar.bidO, 99);
  assert.equal(bar.bidC, 103, "bid OHLC uses only observed bids");
  assert.notEqual(bar.bidC, bar.askC, "missing bids are not copied from asks");
  assert.equal(bar.executionEvidence.bidSource, "mixed");
  assert.equal(dataset.manifest.sessions.complete, 1, "time coverage remains independently complete");
  assert.equal(dataset.manifest.sessions.executionComplete, 0);
  assert.equal(dataset.manifest.sessions.items[0].executionIncompleteBars, 1);
});

test("buildReplayDatasetFromBars fingerprints equivalent bar inputs deterministically", () => {
  const bar = {
    t: Date.parse("2026-01-02T00:00:00.000Z"),
    intervalMinutes: 5,
    o: 100,
    h: 104,
    l: 100,
    c: 104,
    askO: 100,
    askH: 104,
    askL: 100,
    askC: 104,
    source: "cmb",
    evidence: "real",
    partial: false,
  };
  const first = buildReplayDatasetFromBars({ bars5: [bar], asOf: "2026-01-02T00:05:00Z" });
  const second = buildReplayDatasetFromBars({ bars5: [{ ...bar }], asOf: "2026-01-02T00:05:00Z" });
  assert.equal(first.manifest.datasetId, second.manifest.datasetId);
  assert.equal(first.manifest.contentSha256, second.manifest.contentSha256);
  const stillOpen = buildReplayDatasetFromBars({ bars5: [bar], asOf: "2026-01-02T00:04:59.999Z" });
  assert.equal(stillOpen.bars[5].length, 0, "a bar cannot enter the dataset before its close");
});

test("walk-forward registry creates exact rolling 6 month train and 1 month test folds", () => {
  const sessions = monthlySessions();
  const manifest = manifestForRange(
    "2025-01-01T00:00:00.000Z",
    "2025-08-31T23:59:59.999Z",
    sessions,
  );
  const options = {
    datasetManifest: manifest,
    asOf: "2025-09-01T00:00:00.000Z",
    parameters: { rsi: 30, atr: 2 },
    candidateSpace: { rsi: [25, 30, 35] },
    attempts: [{ attemptId: "attempt-1", status: "recorded" }],
  };
  const first = createWalkForwardRegistry(options);
  const second = createWalkForwardRegistry({ ...options, parameters: { atr: 2, rsi: 30 } });

  assert.equal(first.version, WALK_FORWARD_REGISTRY_VERSION);
  assert.equal(first.status, "ready");
  assert.equal(first.folds.length, 2);
  assert.deepEqual(first.folds.map((fold) => ({ train: fold.train, test: fold.test })), [
    {
      train: { from: "2025-01-01T00:00:00.000Z", toExclusive: "2025-07-01T00:00:00.000Z", months: 6, coveredMonths: 6, qualifyingMonths: 6, minimumSessionsPerMonth: 10, completeSessions: 60 },
      test: { from: "2025-07-01T00:00:00.000Z", toExclusive: "2025-08-01T00:00:00.000Z", months: 1, coveredMonths: 1, qualifyingMonths: 1, minimumSessionsPerMonth: 10, completeSessions: 10 },
    },
    {
      train: { from: "2025-02-01T00:00:00.000Z", toExclusive: "2025-08-01T00:00:00.000Z", months: 6, coveredMonths: 6, qualifyingMonths: 6, minimumSessionsPerMonth: 10, completeSessions: 60 },
      test: { from: "2025-08-01T00:00:00.000Z", toExclusive: "2025-09-01T00:00:00.000Z", months: 1, coveredMonths: 1, qualifyingMonths: 1, minimumSessionsPerMonth: 10, completeSessions: 10 },
    },
  ]);
  for (const fold of first.folds) {
    assert.equal(fold.train.toExclusive, fold.test.from, "train and test touch but never overlap");
    assert.equal(fold.parametersFrozen, true);
    assert.equal(fold.parameterFingerprint, frozenParameterFingerprint({ atr: 2, rsi: 30 }));
    assert.match(fold.foldId, /^fold-[a-f0-9]{64}$/);
  }
  assert.equal(first.attempts.count, 1);
  assert.equal(first.attempts.selectedAttemptId, null);
  assert.equal(first.candidateSpace.optimized, false);
  assert.equal(second.registryId, first.registryId);
  assert.deepEqual(second.folds.map((fold) => fold.foldId), first.folds.map((fold) => fold.foldId));
});

test("walk-forward test-frame selection excludes every training-period account frame", () => {
  const fold = {
    test: {
      from: "2025-07-01T00:00:00.000Z",
      toExclusive: "2025-08-01T00:00:00.000Z",
    },
  };
  const selected = selectWalkForwardTestFrames([
    { t: "2025-06-30T23:59:59.999Z", id: "train" },
    { t: "2025-07-01T00:00:00.000Z", id: "test-first" },
    { t: "2025-07-15T00:00:00.000Z", id: "test-middle" },
    { t: "2025-08-01T00:00:00.000Z", id: "next-fold" },
  ], fold, "2025-08-01T00:00:00.000Z");
  assert.deepEqual(selected.map((frame) => frame.id), ["test-first", "test-middle"]);
});

test("walk-forward registry reports insufficient calendar span and honors asOf", () => {
  const manifest = manifestForRange(
    "2025-01-01T00:00:00.000Z",
    "2025-12-31T23:59:59.999Z",
    [completeSession("2025-01-15"), completeSession("2025-06-15"), completeSession("2025-07-15")],
  );
  const registry = createWalkForwardRegistry({
    datasetManifest: manifest,
    from: "2025-01-01T00:00:00.000Z",
    to: "2025-12-31T23:59:59.999Z",
    asOf: "2025-06-30T23:59:59.999Z",
    parameters: {},
  });

  assert.equal(registry.asOf, "2025-06-30T23:59:59.999Z");
  assert.equal(registry.window.to, registry.asOf, "future dataset range is clipped at asOf");
  assert.equal(registry.status, "insufficient_data");
  assert.deepEqual(registry.reasonCodes, ["insufficient_calendar_span"]);
  assert.equal(registry.folds.length, 0);
});

test("walk-forward folds remain registered but ineligible when train or test sessions are incomplete", () => {
  const manifest = manifestForRange("2025-01-01T00:00:00Z", "2025-07-31T23:59:59.999Z", []);
  const registry = createWalkForwardRegistry({
    datasetManifest: manifest,
    asOf: "2025-08-01T00:00:00Z",
    parameters: { control: true },
  });
  assert.equal(registry.folds.length, 1);
  assert.equal(registry.status, "insufficient_data");
  assert.equal(registry.folds[0].status, "insufficient_data");
  assert.deepEqual(registry.folds[0].reasonCodes, ["insufficient_complete_sessions"]);
});

test("walk-forward excludes a partial first month and rejects sparse month coverage", () => {
  const sessions = monthlySessions();
  const partialStart = createWalkForwardRegistry({
    datasetManifest: manifestForRange("2025-01-15T00:00:00Z", "2025-08-31T23:59:59.999Z", sessions),
    asOf: "2025-09-01T00:00:00Z",
    parameters: {},
  });
  assert.equal(partialStart.folds.length, 1);
  assert.equal(partialStart.folds[0].train.from, "2025-02-01T00:00:00.000Z");

  const sparse = createWalkForwardRegistry({
    datasetManifest: manifestForRange("2025-01-01T00:00:00Z", "2025-07-31T23:59:59.999Z", [
      completeSession("2025-01-15"),
      completeSession("2025-06-15"),
      completeSession("2025-07-15"),
    ]),
    asOf: "2025-08-01T00:00:00Z",
    parameters: {},
  });
  assert.equal(sparse.folds[0].status, "insufficient_data");
  assert.deepEqual(sparse.folds[0].reasonCodes, ["incomplete_month_coverage"]);

  const thin = createWalkForwardRegistry({
    datasetManifest: manifestForRange("2025-01-01T00:00:00Z", "2025-07-31T23:59:59.999Z", monthlySessions(7, 1)),
    asOf: "2025-08-01T00:00:00Z",
    parameters: {},
  });
  assert.deepEqual(thin.folds[0].reasonCodes, ["insufficient_monthly_sessions"]);
});

test("HistoricalStore adapter forwards point-in-time bounds and fingerprints selected partitions", async () => {
  const calls = [];
  const records = Array.from({ length: 5 }, (_, minute) => ({
    ...quote(minute),
    tradingDay: "2026-01-02",
  }));
  const store = {
    async query(options) {
      calls.push(options);
      return records;
    },
    async getManifest() {
      return [{
        instrument: "CMB_ACCUMULATED_GOLD",
        tradingDay: "2026-01-02",
        records: 5,
        rejected: 0,
        quarantined: false,
        contentSha256: "c".repeat(64),
        dataSchemaVersion: SCHEMA,
      }];
    },
  };
  const dataset = await buildReplayDatasetFromStore(store, {
    instrument: "CMB_ACCUMULATED_GOLD",
    asOf: "2026-01-02T00:05:00.000Z",
    from: "2026-01-02T00:00:00.000Z",
    to: "2026-01-02T00:05:00.000Z",
  });
  assert.deepEqual(calls, [{
    instrument: "CMB_ACCUMULATED_GOLD",
    from: "2026-01-02T00:00:00.000Z",
    to: "2026-01-02T00:05:00.000Z",
    asOf: "2026-01-02T00:05:00.000Z",
    evidence: undefined,
  }]);
  assert.equal(dataset.manifest.partitions.length, 1);
  assert.equal(dataset.manifest.partitions[0].tradingDay, "2026-01-02");
  assert.match(dataset.manifest.partitions[0].contentSha256, /^[a-f0-9]{64}$/);
  assert.equal(dataset.manifest.partitions[0].storeContentSha256, "c".repeat(64));
  assert.equal(dataset.manifest.partitions[0].quarantined, false);
  assert.equal(dataset.manifest.realBidAskCoverage, 1);

  const reversed = await buildReplayDatasetFromStore({
    ...store,
    async query() { return [...records].reverse(); },
  }, {
    instrument: "CMB_ACCUMULATED_GOLD",
    asOf: "2026-01-02T00:05:00.000Z",
  });
  assert.equal(reversed.manifest.datasetId, dataset.manifest.datasetId, "query order does not alter partition or dataset identity");
});

test("store growth after a fixed asOf cannot rewrite dataset identity", async () => {
  const accepted = { ...quote(0), tradingDay: "2026-01-02" };
  const future = { ...quote(10), tradingDay: "2026-01-02" };
  const lateBackfill = {
    ...quote(1, { ingestedAt: "2026-01-02T00:06:00.000Z" }),
    tradingDay: "2026-01-02",
  };
  let records = [accepted];
  let manifestRecords = 1;
  const store = {
    async query() { return structuredClone(records); },
    async getManifest() {
      return [{ instrument: "CMB_ACCUMULATED_GOLD", tradingDay: "2026-01-02", records: manifestRecords,
        contentSha256: String(manifestRecords).repeat(64).slice(0, 64), dataSchemaVersion: SCHEMA }];
    },
  };
  const options = { instrument: "CMB_ACCUMULATED_GOLD", asOf: "2026-01-02T00:05:00.000Z" };
  const before = await buildReplayDatasetFromStore(store, options);
  records = [accepted, future, lateBackfill];
  manifestRecords = 3;
  const after = await buildReplayDatasetFromStore(store, options);
  assert.equal(after.manifest.datasetId, before.manifest.datasetId);
  assert.equal(after.manifest.contentSha256, before.manifest.contentSha256);
  assert.equal(after.manifest.inputFingerprint, before.manifest.inputFingerprint);
});

test("runWalkForward executes only ready folds with frozen parameters and records results", async () => {
  const sessions = monthlySessions();
  const parameters = { strategy: { score: 5 } };
  const registry = createWalkForwardRegistry({
    datasetManifest: manifestForRange("2025-01-01T00:00:00Z", "2025-08-31T23:59:59.999Z", sessions),
    asOf: "2025-09-01T00:00:00Z",
    parameters,
  });
  const visited = [];
  const completed = await runWalkForward({
    registry,
    parameters,
    evaluateFold: ({ fold, parameters: frozen }) => {
      visited.push(fold.foldId);
      assert.deepEqual(frozen, parameters);
      return {
        status: "completed",
        sampleCount: fold.test.completeSessions,
        metrics: {
          returnInterval: { lower: -0.01, upper: 0.02 },
          winRateInterval: { lower: 0.3, upper: 0.7 },
        },
      };
    },
  });
  assert.equal(visited.length, 2);
  assert.equal(completed.status, "completed");
  assert.equal(completed.observed.completedFolds, 2);
  assert.ok(completed.folds.every((fold) => fold.status === "completed" && fold.resultFingerprint));
  assert.match(completed.resultFingerprint, /^[a-f0-9]{64}$/);
});

test("runWalkForward rejects cancellation raised while a fold evaluator settles", async () => {
  const sessions = monthlySessions();
  const parameters = { strategy: { score: 5 } };
  const registry = createWalkForwardRegistry({
    datasetManifest: manifestForRange("2025-01-01T00:00:00Z", "2025-08-31T23:59:59.999Z", sessions),
    asOf: "2025-09-01T00:00:00Z",
    parameters,
  });
  const controller = new AbortController();
  await assert.rejects(runWalkForward({
    registry,
    parameters,
    signal: controller.signal,
    evaluateFold: async () => {
      controller.abort(new Error("cancel after evaluator"));
      return { status: "completed", sampleCount: 1, metrics: {} };
    },
  }), (error) => error?.name === "AbortError");
});
