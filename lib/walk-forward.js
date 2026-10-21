import { stableReplayFingerprint } from "./replay-dataset.js";

export const WALK_FORWARD_REGISTRY_VERSION = "goldboard-walk-forward-registry-v1";
export const WALK_FORWARD_DEFAULTS = Object.freeze({
  trainMonths: 6,
  testMonths: 1,
  rollingMonths: 1,
  minimumSessionsPerMonth: 10,
});

export function walkForwardFoldCore(fold = {}) {
  const status = fold.status === "completed" || fold.status === "failed" ? "ready" : fold.status;
  return {
    registryVersion: WALK_FORWARD_REGISTRY_VERSION,
    datasetId: fold.datasetId ?? null,
    datasetContentSha256: fold.datasetContentSha256 ?? null,
    train: structuredClone(fold.train ?? null),
    test: structuredClone(fold.test ?? null),
    asOf: fold.asOf ?? null,
    parameterFingerprint: fold.parameterFingerprint ?? null,
    parametersFrozen: fold.parametersFrozen === true,
    candidateSpaceFingerprint: fold.candidateSpaceFingerprint ?? null,
    attemptCount: Number(fold.attemptCount ?? 0),
    status,
    reasonCodes: Array.isArray(fold.reasonCodes) ? structuredClone(fold.reasonCodes) : [],
  };
}

export function walkForwardFoldId(fold = {}) {
  return `fold-${stableReplayFingerprint(walkForwardFoldCore(fold))}`;
}

export function walkForwardFoldResultFingerprint(fold = {}) {
  return stableReplayFingerprint({
    foldId: fold.foldId,
    train: fold.train,
    test: fold.test,
    datasetId: fold.datasetId ?? null,
    datasetContentSha256: fold.datasetContentSha256 ?? null,
    parameterFingerprint: fold.parameterFingerprint,
    simulationFingerprint: fold.simulationFingerprint ?? null,
    executionDatasetId: fold.executionDatasetId ?? null,
    executionDatasetContentSha256: fold.executionDatasetContentSha256 ?? null,
    factorFingerprint: fold.factorFingerprint ?? null,
    parameterPrecommit: fold.parameterPrecommit ?? null,
    sampleCount: Number(fold.sampleCount),
    metrics: fold.metrics,
    benchmarks: fold.benchmarks ?? null,
    warmup: fold.warmup,
  });
}

function instantMs(value) {
  if (value instanceof Date) return Number.isFinite(value.getTime()) ? value.getTime() : null;
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && value.trim() !== "") {
    const parsed = Date.parse(value);
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}

function monthStart(value) {
  const ms = instantMs(value);
  if (ms === null) return null;
  const date = new Date(ms);
  return Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), 1);
}

function addMonths(ms, months) {
  const date = new Date(ms);
  return Date.UTC(date.getUTCFullYear(), date.getUTCMonth() + months, 1);
}

function iso(ms) {
  return new Date(ms).toISOString();
}

function positiveInteger(value, fallback, name) {
  const number = Number(value ?? fallback);
  if (!Number.isSafeInteger(number) || number <= 0) throw new TypeError(`${name} must be a positive integer`);
  return number;
}

function normalizedCandidateSpace(value) {
  if (value === undefined || value === null) return {};
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new TypeError("candidateSpace must be an object");
  return value;
}

function completeSessionDays(manifest) {
  const items = Array.isArray(manifest?.sessions?.items) ? manifest.sessions.items : [];
  return items
    .filter((session) => Number(session.completeBars) > 0
      && Number(session.partialBars) === 0
      && session.coverageComplete === true
      && Number(session.executionIncompleteBars ?? 0) === 0)
    .map((session) => session.tradingDay)
    .filter((day) => /^\d{4}-\d{2}-\d{2}$/.test(day))
    .sort();
}

function countDays(days, fromMs, toMs) {
  const from = iso(fromMs).slice(0, 10);
  const to = iso(toMs).slice(0, 10);
  return days.filter((day) => day >= from && day < to).length;
}

function monthCoverage(days, fromMs, toMs, minimumSessionsPerMonth) {
  const months = new Map();
  for (const day of days) {
    const dayMs = Date.parse(`${day}T00:00:00Z`);
    if (dayMs >= fromMs && dayMs < toMs) months.set(day.slice(0, 7), (months.get(day.slice(0, 7)) ?? 0) + 1);
  }
  return {
    coveredMonths: months.size,
    qualifyingMonths: [...months.values()].filter((count) => count >= minimumSessionsPerMonth).length,
  };
}

export function frozenParameterFingerprint(parameters = {}) {
  if (!parameters || typeof parameters !== "object" || Array.isArray(parameters)) {
    throw new TypeError("parameters must be an object");
  }
  return stableReplayFingerprint(parameters);
}

export function createWalkForwardRegistry({
  datasetManifest,
  from,
  to,
  asOf,
  parameters = {},
  candidateSpace = {},
  attempts = [],
  trainMonths = WALK_FORWARD_DEFAULTS.trainMonths,
  testMonths = WALK_FORWARD_DEFAULTS.testMonths,
  rollingMonths = WALK_FORWARD_DEFAULTS.rollingMonths,
  minimumSessionsPerMonth = WALK_FORWARD_DEFAULTS.minimumSessionsPerMonth,
} = {}) {
  if (!datasetManifest || typeof datasetManifest !== "object") throw new TypeError("datasetManifest is required");
  const asOfMs = instantMs(asOf);
  if (asOfMs === null) throw new TypeError("createWalkForwardRegistry requires a valid asOf");
  const datasetFromMs = instantMs(from ?? datasetManifest.dateRange?.from);
  const requestedToMs = instantMs(to ?? asOfMs);
  if (datasetFromMs === null || requestedToMs === null) throw new TypeError("walk-forward date range is required");
  const effectiveToMs = Math.min(requestedToMs, asOfMs);
  if (effectiveToMs < datasetFromMs) throw new RangeError("walk-forward to/asOf must not precede from");

  const trainSize = positiveInteger(trainMonths, WALK_FORWARD_DEFAULTS.trainMonths, "trainMonths");
  const testSize = positiveInteger(testMonths, WALK_FORWARD_DEFAULTS.testMonths, "testMonths");
  const rollSize = positiveInteger(rollingMonths, WALK_FORWARD_DEFAULTS.rollingMonths, "rollingMonths");
  const minimumSessions = positiveInteger(
    minimumSessionsPerMonth,
    WALK_FORWARD_DEFAULTS.minimumSessionsPerMonth,
    "minimumSessionsPerMonth",
  );
  const normalizedAttempts = Array.isArray(attempts) ? attempts : [];
  const normalizedSpace = normalizedCandidateSpace(candidateSpace);
  const parameterFingerprint = frozenParameterFingerprint(parameters);
  const candidateSpaceFingerprint = stableReplayFingerprint(normalizedSpace);
  const completeDays = completeSessionDays(datasetManifest);
  const observedFirstMonth = monthStart(datasetFromMs);
  const firstDate = new Date(datasetFromMs);
  // A market month may begin on a weekend/holiday; observations in its first
  // week are accepted as a full trading month, while a mid-month start is not.
  const firstMonth = firstDate.getUTCDate() <= 7 ? observedFirstMonth : addMonths(observedFirstMonth, 1);
  const lastExclusive = effectiveToMs + 1;
  const folds = [];

  for (let trainFromMs = firstMonth; ; trainFromMs = addMonths(trainFromMs, rollSize)) {
    const trainToMs = addMonths(trainFromMs, trainSize);
    const testFromMs = trainToMs;
    const testToMs = addMonths(testFromMs, testSize);
    if (testToMs > lastExclusive) break;
    const trainSessionCount = countDays(completeDays, trainFromMs, trainToMs);
    const testSessionCount = countDays(completeDays, testFromMs, testToMs);
    const trainCoverage = monthCoverage(completeDays, trainFromMs, trainToMs, minimumSessions);
    const testCoverage = monthCoverage(completeDays, testFromMs, testToMs, minimumSessions);
    const sessionsPresent = trainSessionCount > 0 && testSessionCount > 0;
    const monthsCovered = trainCoverage.coveredMonths === trainSize && testCoverage.coveredMonths === testSize;
    const sampleDensityMet = trainCoverage.qualifyingMonths === trainSize && testCoverage.qualifyingMonths === testSize;
    const status = sessionsPresent && monthsCovered && sampleDensityMet ? "ready" : "insufficient_data";
    const reasonCodes = status === "ready" ? []
      : !sessionsPresent ? ["insufficient_complete_sessions"]
        : !monthsCovered ? ["incomplete_month_coverage"] : ["insufficient_monthly_sessions"];
    const core = {
      registryVersion: WALK_FORWARD_REGISTRY_VERSION,
      datasetId: datasetManifest.datasetId ?? null,
      datasetContentSha256: datasetManifest.contentSha256 ?? null,
      train: {
        from: iso(trainFromMs),
        toExclusive: iso(trainToMs),
        months: trainSize,
        coveredMonths: trainCoverage.coveredMonths,
        qualifyingMonths: trainCoverage.qualifyingMonths,
        minimumSessionsPerMonth: minimumSessions,
        completeSessions: trainSessionCount,
      },
      test: {
        from: iso(testFromMs),
        toExclusive: iso(testToMs),
        months: testSize,
        coveredMonths: testCoverage.coveredMonths,
        qualifyingMonths: testCoverage.qualifyingMonths,
        minimumSessionsPerMonth: minimumSessions,
        completeSessions: testSessionCount,
      },
      asOf: iso(asOfMs),
      parameterFingerprint,
      parametersFrozen: true,
      candidateSpaceFingerprint,
      attemptCount: normalizedAttempts.length,
      status,
      reasonCodes,
    };
    folds.push({ ...core, foldId: walkForwardFoldId(core) });
  }

  const minimumMonths = trainSize + testSize;
  const rangeMonths = firstMonth === null ? 0 : Math.max(0, Math.round((monthStart(effectiveToMs) - firstMonth) / (30.4375 * 24 * 60 * 60_000)) + 1);
  const status = folds.length === 0
    ? "insufficient_data"
    : folds.some((fold) => fold.status === "ready") ? "ready" : "insufficient_data";
  const registryCore = {
    version: WALK_FORWARD_REGISTRY_VERSION,
    datasetId: datasetManifest.datasetId ?? null,
    datasetContentSha256: datasetManifest.contentSha256 ?? null,
    asOf: iso(asOfMs),
    window: {
      from: iso(datasetFromMs),
      to: iso(effectiveToMs),
      trainMonths: trainSize,
      testMonths: testSize,
      rollingMonths: rollSize,
      minimumSessionsPerMonth: minimumSessions,
    },
    status,
    reasonCodes: folds.length === 0 ? ["insufficient_calendar_span"]
      : status === "insufficient_data" ? [...new Set(folds.flatMap((fold) => fold.reasonCodes))] : [],
    observed: {
      calendarMonths: rangeMonths,
      completeSessions: completeDays.length,
      folds: folds.length,
      readyFolds: folds.filter((fold) => fold.status === "ready").length,
    },
    requirements: {
      minimumCalendarMonths: minimumMonths,
      parametersFrozen: true,
      noTrainTestOverlap: true,
      explicitAsOf: true,
      minimumSessionsPerMonth: minimumSessions,
    },
    parameters: { frozen: true, fingerprint: parameterFingerprint },
    candidateSpace: {
      fingerprint: candidateSpaceFingerprint,
      definition: normalizedSpace,
      optimized: false,
    },
    attempts: {
      count: normalizedAttempts.length,
      items: normalizedAttempts,
      selectedAttemptId: null,
    },
    folds,
  };
  return { ...registryCore, registryId: `walk-forward-${stableReplayFingerprint(registryCore)}` };
}

export const planWalkForwardFolds = createWalkForwardRegistry;

/** Select only test-window frames; train data may inform frozen params, never account state. */
export function selectWalkForwardTestFrames(frames, fold, asOf = fold?.test?.toExclusive) {
  const fromMs = instantMs(fold?.test?.from);
  const toMs = instantMs(fold?.test?.toExclusive);
  const asOfMs = instantMs(asOf);
  if (fromMs === null || toMs === null || asOfMs === null || fromMs >= toMs) {
    throw new TypeError("a valid walk-forward test window and asOf are required");
  }
  const upperExclusive = Math.min(toMs, asOfMs + 1);
  return (Array.isArray(frames) ? frames : [])
    .filter((frame) => {
      const at = instantMs(frame?.timestamp ?? frame?.t ?? frame?.at ?? frame?.time);
      return at !== null && at >= fromMs && at < upperExclusive;
    })
    .slice()
    .sort((left, right) => instantMs(left?.timestamp ?? left?.t ?? left?.at ?? left?.time)
      - instantMs(right?.timestamp ?? right?.t ?? right?.at ?? right?.time));
}

function abortError(reason) {
  const error = new Error(String(reason?.message ?? reason ?? "walk-forward cancelled"));
  error.name = "AbortError";
  return error;
}

/** Attach deterministic, already computed test-fold results without changing fold boundaries. */
export function completeWalkForwardRegistry(registry, foldResults = []) {
  if (!registry || registry.version !== WALK_FORWARD_REGISTRY_VERSION || !Array.isArray(registry.folds)) {
    throw new TypeError("a current walk-forward registry is required");
  }
  const results = new Map((Array.isArray(foldResults) ? foldResults : [])
    .filter((entry) => entry && typeof entry.foldId === "string")
    .map((entry) => [entry.foldId, entry]));
  const folds = registry.folds.map((fold) => {
    const result = results.get(fold.foldId);
    if (fold.status !== "ready" || !result) return { ...fold };
    const sampleCount = Math.max(0, Math.floor(Number(result.sampleCount ?? result.samples?.sessions ?? result.metrics?.samples?.returns) || 0));
    const completed = result.status !== "failed" && sampleCount > 0 && result.metrics && typeof result.metrics === "object";
    return {
      ...fold,
      status: completed ? "completed" : result.status === "failed" ? "failed" : "insufficient_data",
      sampleCount,
      metrics: completed ? structuredClone(result.metrics) : null,
      benchmarks: completed && result.benchmarks && typeof result.benchmarks === "object"
        ? structuredClone(result.benchmarks) : null,
      diagnostics: Array.isArray(result.diagnostics) ? result.diagnostics.slice() : [],
      warmup: result.warmup && typeof result.warmup === "object" ? structuredClone(result.warmup) : undefined,
      simulationFingerprint: result.simulationFingerprint ?? null,
      executionDatasetId: result.executionDatasetId ?? null,
      executionDatasetContentSha256: result.executionDatasetContentSha256 ?? null,
      factorFingerprint: result.factorFingerprint ?? null,
      parameterPrecommit: result.parameterPrecommit && typeof result.parameterPrecommit === "object"
        ? structuredClone(result.parameterPrecommit) : null,
      resultFingerprint: completed ? walkForwardFoldResultFingerprint({
        ...fold,
        datasetId: registry.datasetId,
        datasetContentSha256: fold.datasetContentSha256 ?? registry.datasetContentSha256 ?? null,
        simulationFingerprint: result.simulationFingerprint ?? null,
        executionDatasetId: result.executionDatasetId ?? null,
        executionDatasetContentSha256: result.executionDatasetContentSha256 ?? null,
        factorFingerprint: result.factorFingerprint ?? null,
        parameterPrecommit: result.parameterPrecommit ?? null,
        sampleCount,
        metrics: result.metrics,
        benchmarks: result.benchmarks && typeof result.benchmarks === "object" ? result.benchmarks : null,
        warmup: result.warmup && typeof result.warmup === "object" ? result.warmup : undefined,
      }) : null,
    };
  });
  const completed = folds.filter((fold) => fold.status === "completed").length;
  const failed = folds.filter((fold) => fold.status === "failed").length;
  const output = {
    ...structuredClone(registry),
    status: completed > 0 && failed === 0 ? "completed" : completed > 0 ? "partial" : registry.status,
    observed: {
      ...(registry.observed ?? {}),
      completedFolds: completed,
      failedFolds: failed,
    },
    folds,
  };
  output.resultFingerprint = stableReplayFingerprint({
    registryId: output.registryId,
    folds: folds.map((fold) => ({ foldId: fold.foldId, status: fold.status, resultFingerprint: fold.resultFingerprint ?? null })),
  });
  return output;
}

/** Execute ready test folds through an injected evaluator; training parameters stay frozen. */
export async function runWalkForward({ registry, evaluateFold, parameters = {}, signal = null } = {}) {
  if (typeof evaluateFold !== "function") throw new TypeError("evaluateFold is required");
  const expectedFingerprint = frozenParameterFingerprint(parameters);
  const results = [];
  for (const fold of registry?.folds ?? []) {
    if (signal?.aborted) throw abortError(signal.reason);
    if (fold.status !== "ready") continue;
    if (fold.parameterFingerprint !== expectedFingerprint) {
      results.push({ foldId: fold.foldId, status: "failed", sampleCount: 0, diagnostics: ["parameter_fingerprint_mismatch"] });
      continue;
    }
    const frozen = structuredClone(parameters);
    const result = await evaluateFold({ fold: structuredClone(fold), parameters: frozen, signal });
    if (signal?.aborted) throw abortError(signal.reason);
    if (frozenParameterFingerprint(frozen) !== expectedFingerprint) {
      results.push({ foldId: fold.foldId, status: "failed", sampleCount: 0, diagnostics: ["parameters_mutated"] });
      continue;
    }
    results.push({ foldId: fold.foldId, ...(result ?? {}) });
  }
  if (signal?.aborted) throw abortError(signal.reason);
  return completeWalkForwardRegistry(registry, results);
}
