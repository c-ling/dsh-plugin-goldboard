import { walkForwardFoldResultFingerprint } from "./walk-forward.js";
import { canonicalSha256 } from "./replay-report.js";

export const STRATEGY_EXPERIMENT_REPORT_VERSION = 1;
export const STRATEGY_EXPERIMENT_REPORT_SCHEMA = "goldboard-strategy-experiment-v1";
export const STRATEGY_EXPERIMENT_CALCULATION_VERSION = "goldboard-strategy-experiment-report-v1";

const OMITTED_FINGERPRINT_FIELDS = new Set(["generatedAt", "experimentId", "experimentFingerprint"]);

function instant(value, name) {
  const parsed = typeof value === "number" ? value : value instanceof Date ? value.getTime() : Date.parse(value ?? "");
  if (!Number.isFinite(parsed)) throw new TypeError(`${name} must be a valid timestamp`);
  return new Date(parsed).toISOString();
}

function wireValue(value, seen = new Set()) {
  if (value === null || typeof value === "string" || typeof value === "boolean") return value;
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  if (value instanceof Date) return Number.isFinite(value.getTime()) ? value.toISOString() : null;
  if (!value || typeof value !== "object") return null;
  if (seen.has(value)) throw new TypeError("experiment report cannot contain circular values");
  seen.add(value);
  if (Array.isArray(value)) {
    const output = value.map((entry) => wireValue(entry, seen));
    seen.delete(value);
    return output;
  }
  const output = {};
  for (const key of Object.keys(value).sort()) {
    if (value[key] === undefined || typeof value[key] === "function") continue;
    output[key] = wireValue(value[key], seen);
  }
  seen.delete(value);
  return output;
}

function semanticReport(report) {
  const output = {};
  for (const [key, value] of Object.entries(report)) {
    if (!OMITTED_FINGERPRINT_FIELDS.has(key)) output[key] = value;
  }
  return output;
}

function statusFor(scenarios, diagnostics) {
  if (scenarios.length === 0) return "unavailable";
  const completed = scenarios.filter((entry) => entry.status === "completed").length;
  if (completed === scenarios.length && diagnostics.length === 0) return "completed";
  if (completed > 0) return "partial";
  return "unavailable";
}

/** Project one deterministic, language-neutral strategy experiment report. */
export function projectStrategyExperimentReport(input = {}) {
  const generatedAt = instant(input.generatedAt ?? Date.now(), "generatedAt");
  const asOf = instant(input.asOf, "asOf");
  const scenarios = (Array.isArray(input.scenarios) ? input.scenarios : [])
    .map((entry) => wireValue(entry))
    .sort((left, right) => String(left?.scenarioId ?? "").localeCompare(String(right?.scenarioId ?? "")));
  const diagnostics = (Array.isArray(input.diagnostics) ? input.diagnostics : [])
    .map((entry) => wireValue(entry));
  const report = wireValue({
    version: STRATEGY_EXPERIMENT_REPORT_VERSION,
    schema: STRATEGY_EXPERIMENT_REPORT_SCHEMA,
    calculationVersion: STRATEGY_EXPERIMENT_CALCULATION_VERSION,
    generatedAt,
    asOf,
    status: input.status ?? statusFor(scenarios, diagnostics),
    controlStrategyId: input.controlStrategyId ?? "control",
    run: {
      days: Number.isInteger(Number(input.run?.days)) ? Number(input.run.days) : 1,
      mode: input.run?.mode === "walk-forward" ? "walk-forward" : "diagnostic",
    },
    config: input.config ?? {},
    strategyCatalog: input.strategyCatalog ?? [],
    datasetRefs: input.datasetRefs ?? {},
    scenarios,
    comparisons: input.comparisons ?? [],
    ablations: input.ablations ?? [],
    sensitivity: input.sensitivity ?? [],
    oos: input.oos ?? {},
    promotion: input.promotion ?? { status: "not_eligible", eligible: false, candidates: [] },
    benchmarkCapabilities: input.benchmarkCapabilities ?? [],
    provenance: input.provenance ?? {},
    diagnostics,
  });
  report.experimentFingerprint = canonicalSha256(semanticReport(report));
  report.experimentId = input.experimentId ?? `experiment-${report.experimentFingerprint.slice(0, 24)}`;
  return report;
}

export function strategyExperimentFingerprint(report) {
  if (!report || typeof report !== "object") throw new TypeError("report is required");
  return canonicalSha256(semanticReport(wireValue(report)));
}

function reportError(message) {
  const error = new TypeError(`invalid strategy experiment report: ${message}`);
  error.code = "INVALID_STRATEGY_EXPERIMENT_REPORT";
  return error;
}

function finiteMetric(value) {
  if (value === null || value === undefined || value === "") return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function completeIntervalEvidence(intervals) {
  const returns = intervals?.returnInterval;
  const wins = intervals?.winRateInterval;
  return returns?.confidence === 0.95 && Number(returns.sampleSize) >= 2
    && finiteMetric(returns.lower) !== null && finiteMetric(returns.upper) !== null
    && Number(returns.lower) <= Number(returns.upper)
    && wins?.confidence === 0.95 && Number(wins.trials) > 0
    && Number(wins.successes) >= 0 && Number(wins.successes) <= Number(wins.trials)
    && finiteMetric(wins.lower) !== null && finiteMetric(wins.upper) !== null
    && Number(wins.lower) <= Number(wins.upper);
}

function completeBenchmarkEvidence(benchmarks) {
  return ["no_trade", "buy_and_hold", "fixed_interval_dca", "simple_moving_average"].every((id) => {
    const benchmark = benchmarks?.[id];
    return benchmark?.status === "ok" && Array.isArray(benchmark.diagnostics) && benchmark.diagnostics.length === 0
      && finiteMetric(benchmark.metrics?.netPnlCny) !== null
      && finiteMetric(benchmark.metrics?.totalReturn) !== null
      && finiteMetric(benchmark.metrics?.maxDrawdownCny) !== null
      && Number(benchmark.metrics?.samples?.returns) > 0;
  });
}

function completeFoldEvidence(fold) {
  const parameterFingerprint = fold?.parameterFingerprint;
  const trainFrom = Date.parse(fold?.train?.from ?? "");
  const trainTo = Date.parse(fold?.train?.toExclusive ?? "");
  const testFrom = Date.parse(fold?.test?.from ?? "");
  const testTo = Date.parse(fold?.test?.toExclusive ?? "");
  return fold?.status === "completed" && /^fold-[a-f0-9]{64}$/.test(String(fold.foldId ?? ""))
    && /^[a-f0-9]{64}$/.test(String(parameterFingerprint ?? ""))
    && fold.resultFingerprint === walkForwardFoldResultFingerprint(fold)
    && fold.parametersFrozen === true && Number(fold.sampleCount) > 0
    && Number.isFinite(trainFrom) && Number.isFinite(trainTo) && Number.isFinite(testFrom) && Number.isFinite(testTo)
    && trainFrom < trainTo && trainTo === testFrom && testFrom < testTo
    && Number(fold.train?.months) === 6 && Number(fold.test?.months) === 1
    && Number(fold.train?.coveredMonths) === 6 && Number(fold.test?.coveredMonths) === 1
    && Number(fold.train?.qualifyingMonths) === 6 && Number(fold.test?.qualifyingMonths) === 1
    && Number(fold.train?.minimumSessionsPerMonth) >= 10 && Number(fold.test?.minimumSessionsPerMonth) >= 10
    && Array.isArray(fold.diagnostics) && fold.diagnostics.length === 0
    && completeBenchmarkEvidence(fold.benchmarks)
    && finiteMetric(fold.metrics?.netPnlCny) !== null && finiteMetric(fold.metrics?.maxDrawdownCny) !== null
    && completeIntervalEvidence({ returnInterval: fold.metrics?.returnInterval, winRateInterval: fold.metrics?.winRateInterval });
}

function completeScenarioEvidence(scenario) {
  const gate = scenario?.validationGate;
  const observed = gate?.observed;
  const folds = Array.isArray(scenario?.oos?.folds) ? scenario.oos.folds : [];
  const netPnlCny = folds.reduce((sum, fold) => sum + Number(fold.metrics?.netPnlCny), 0);
  const maxDrawdownCny = folds.length > 0 ? Math.max(...folds.map((fold) => Number(fold.metrics?.maxDrawdownCny))) : null;
  const expectedOosFingerprint = canonicalSha256({
    registryId: scenario?.oos?.registryId,
    folds: folds.map((fold) => ({ foldId: fold.foldId, status: fold.status, resultFingerprint: fold.resultFingerprint ?? null })),
  });
  return scenario?.status === "completed" && scenario?.executionInstrument === "CMB_ACCUMULATED_GOLD"
    && scenario?.evidenceStatus === "validated"
    && scenario?.validationEligible === true
    && scenario?.validationEvidence?.replayReportFingerprintValid === true
    && gate?.status === "eligible" && gate?.eligible === true
    && Array.isArray(gate.unmet) && gate.unmet.length === 0
    && observed?.datasetValid === true && observed?.executionDatasetValid === true
    && observed?.datasetIntegrity === true && observed?.executionAlignmentComplete === true
    && observed?.sessionCoverageComplete === true && observed?.pointInTimeIngestion === true
    && observed?.registryValid === true && observed?.parameterPrecommitVerified === true
    && Number(observed.oosFolds) >= 2
    && Number(observed.frozenOosFolds) === Number(observed.oosFolds)
    && Number(observed.oosFoldsWithIntervals) === Number(observed.oosFolds)
    && Number(observed.realBidAskCoverage) === 1 && Number(observed.incompleteSessions) === 0
    && observed.valuationComplete === true && observed.simulationDiagnosticsClean === true && observed.costsVerified === true
    && observed.benchmarksComplete === true && observed.intervalsComplete === true
    && completeIntervalEvidence(scenario.validationEvidence?.uncertainty)
    && completeBenchmarkEvidence(scenario.validationEvidence?.benchmarks)
    && scenario?.oos?.status === "completed" && scenario.oos.registeredFolds === folds.length
    && scenario.oos.completedFolds === folds.length && folds.length >= 2 && folds.every(completeFoldEvidence)
    && scenario.oos.resultFingerprint === expectedOosFingerprint
    && finiteMetric(scenario.oos.metrics?.netPnlCny) === netPnlCny
    && finiteMetric(scenario.oos.metrics?.maxDrawdownCny) === maxDrawdownCny;
}

function exactValues(actual, expected) {
  return Array.isArray(actual) && actual.length === expected.length
    && [...actual].sort().every((value, index) => value === [...expected].sort()[index]);
}

function scenarioAt(scenarios, strategyId, lane, cost = 1, parameter = 1, ablation = "none") {
  return scenarios.find((scenario) => scenario.strategyId === strategyId && scenario.signalLane === lane
    && Number(scenario.costMultiplier) === cost && Number(scenario.parameterMultiplier) === parameter
    && scenario.ablation === ablation) ?? null;
}

function foldDominates(candidate, control) {
  const candidateFolds = Array.isArray(candidate?.oos?.folds) ? candidate.oos.folds : [];
  const controls = new Map((Array.isArray(control?.oos?.folds) ? control.oos.folds : [])
    .map((fold) => [`${fold.test?.from}|${fold.test?.toExclusive}`, fold]));
  return candidateFolds.length >= 2 && controls.size === candidateFolds.length && candidateFolds.every((fold) => {
    const matched = controls.get(`${fold.test?.from}|${fold.test?.toExclusive}`);
    const candidateNet = finiteMetric(fold.metrics?.netPnlCny);
    const controlNet = finiteMetric(matched?.metrics?.netPnlCny);
    const candidateDrawdown = finiteMetric(fold.metrics?.maxDrawdownCny);
    const controlDrawdown = finiteMetric(matched?.metrics?.maxDrawdownCny);
    return candidateNet !== null && controlNet !== null && candidateNet >= controlNet
      && candidateDrawdown !== null && controlDrawdown !== null && candidateDrawdown <= controlDrawdown;
  });
}

function foldsNonLosing(scenario) {
  const folds = Array.isArray(scenario?.oos?.folds) ? scenario.oos.folds : [];
  return folds.length >= 2 && folds.every((fold) => finiteMetric(fold.metrics?.netPnlCny) >= 0);
}

function foldsDominateBenchmarks(scenario) {
  const folds = Array.isArray(scenario?.oos?.folds) ? scenario.oos.folds : [];
  return folds.length >= 2 && folds.every((fold) => {
    const candidateNet = finiteMetric(fold.metrics?.netPnlCny);
    return candidateNet !== null && completeBenchmarkEvidence(fold.benchmarks)
      && Object.values(fold.benchmarks).every((benchmark) => {
        const benchmarkNet = finiteMetric(benchmark?.metrics?.netPnlCny);
        return benchmarkNet !== null && candidateNet >= benchmarkNet;
      });
  });
}

function sameBasis(left, right) {
  return left?.datasetId && left.datasetId === right?.datasetId
    && left.executionInstrument === "CMB_ACCUMULATED_GOLD"
    && right?.executionInstrument === "CMB_ACCUMULATED_GOLD"
    && left.fillPolicy === right?.fillPolicy && left.ambiguityPolicy === right?.ambiguityPolicy
    && left.executionVersion === right?.executionVersion;
}

function eligiblePromotionSemantics(report) {
  if (report.run?.mode !== "walk-forward" || report.scenarios.length === 0) return false;
  const basis = report.provenance?.basis;
  if (!basis || report.provenance?.basisFingerprint !== canonicalSha256(basis)) return false;
  const config = report.config;
  if (!exactValues(config.signalLanes, ["cmb", "au9999", "xau"])
    || !exactValues(config.costMultipliers, [1, 2])
    || !exactValues(config.parameterMultipliers, [0.8, 1, 1.2])
    || !exactValues(config.ablations, ["none", "without-regime-filter"])
    || config.orb?.requireTrendRegime !== true
    || !config.enabledStrategyIds?.includes("control")) return false;
  const candidates = report.promotion.candidates;
  const candidateIds = candidates.map((candidate) => candidate.strategyId);
  if (candidateIds.some((id) => id === "control" || !config.enabledStrategyIds.includes(id))) return false;
  const controlScenarios = report.scenarios.filter((scenario) => scenario.strategyId === "control");
  if (controlScenarios.length !== 6 || !controlScenarios.every(completeScenarioEvidence)) return false;
  if (report.comparisons.length !== candidateIds.length * 3) return false;
  return candidates.every((candidate) => {
    if (candidate.policyVersion !== "goldboard-strategy-promotion-v1"
      || candidate.requirements?.walkForwardOnly !== true
      || candidate.requirements?.perFoldControlDominance !== true
      || candidate.requirements?.perFoldBenchmarkDominance !== true) return false;
    const scenarios = report.scenarios.filter((scenario) => scenario?.strategyId === candidate.strategyId);
    if (scenarios.length !== 36 || !scenarios.every(completeScenarioEvidence)
      || !scenarios.every(foldsDominateBenchmarks)) return false;
    const keys = new Set(scenarios.map((scenario) => [scenario.signalLane, scenario.costMultiplier,
      scenario.parameterMultiplier, scenario.ablation].join("|")));
    const expectedKeys = new Set();
    for (const lane of ["cmb", "au9999", "xau"]) {
      for (const cost of [1, 2]) {
        for (const parameter of [0.8, 1, 1.2]) {
          for (const ablation of ["none", "without-regime-filter"]) {
            expectedKeys.add([lane, cost, parameter, ablation].join("|"));
          }
        }
      }
    }
    if (keys.size !== expectedKeys.size || [...expectedKeys].some((key) => !keys.has(key))
      || scenarios.some((scenario) => !report.oos?.[scenario.scenarioId]
      || canonicalSha256(report.oos[scenario.scenarioId]) !== canonicalSha256(scenario.oos))) return false;
    const factorFingerprints = new Set(scenarios.map((scenario) => scenario.factorFingerprint));
    if (factorFingerprints.size !== 1 || factorFingerprints.has(null) || factorFingerprints.has("unknown")) return false;
    for (const lane of ["cmb", "au9999", "xau"]) {
      const baseline = scenarioAt(scenarios, candidate.strategyId, lane);
      const control = scenarioAt(controlScenarios, "control", lane);
      if (!baseline || !control || !sameBasis(baseline, control)
        || finiteMetric(baseline.oos?.metrics?.netPnlCny) <= finiteMetric(control.oos?.metrics?.netPnlCny)
        || !foldDominates(baseline, control)) return false;
      const stressed = scenarioAt(scenarios, candidate.strategyId, lane, 2);
      const stressedControl = scenarioAt(controlScenarios, "control", lane, 2);
      if (!stressed || !stressedControl || !sameBasis(stressed, stressedControl) || !foldsNonLosing(stressed)
        || finiteMetric(stressed.oos?.metrics?.netPnlCny) > finiteMetric(baseline.oos?.metrics?.netPnlCny)
        || finiteMetric(stressed.oos?.metrics?.netPnlCny) <= finiteMetric(stressedControl.oos?.metrics?.netPnlCny)
        || !foldDominates(stressed, stressedControl)) return false;
      for (const multiplier of [0.8, 1.2]) {
        const sensitivity = scenarioAt(scenarios, candidate.strategyId, lane, 1, multiplier);
        if (!sensitivity || !foldsNonLosing(sensitivity)
          || finiteMetric(sensitivity.oos?.metrics?.maxDrawdownCny)
            > Math.max(1, finiteMetric(baseline.oos?.metrics?.maxDrawdownCny) * 2)) return false;
      }
      const ablation = scenarioAt(scenarios, candidate.strategyId, lane, 1, 1, "without-regime-filter");
      if (!ablation || !foldDominates(baseline, ablation)) return false;
      const sameNet = Math.abs(finiteMetric(baseline.oos?.metrics?.netPnlCny)
        - finiteMetric(ablation.oos?.metrics?.netPnlCny)) <= 1e-8;
      const sameDrawdown = Math.abs(finiteMetric(baseline.oos?.metrics?.maxDrawdownCny)
        - finiteMetric(ablation.oos?.metrics?.maxDrawdownCny)) <= 1e-8;
      if (sameNet && sameDrawdown) return false;
    }
    return true;
  });
}

/** Validate untrusted persisted or wire report bytes before the UI can consume them. */
export function validateStrategyExperimentReport(input) {
  if (!input || typeof input !== "object" || Array.isArray(input)) throw reportError("report must be an object");
  const report = wireValue(input);
  if (report.version !== STRATEGY_EXPERIMENT_REPORT_VERSION) throw reportError("version mismatch");
  if (report.schema !== STRATEGY_EXPERIMENT_REPORT_SCHEMA) throw reportError("schema mismatch");
  if (report.calculationVersion !== STRATEGY_EXPERIMENT_CALCULATION_VERSION) throw reportError("calculation version mismatch");
  instant(report.generatedAt, "generatedAt");
  instant(report.asOf, "asOf");
  if (!report.run || !Number.isInteger(report.run.days) || report.run.days < 1 || report.run.days > 30
    || !["diagnostic", "walk-forward"].includes(report.run.mode)) {
    throw reportError("run specification is missing or invalid");
  }
  if (!report.config || report.config.version !== "goldboard-strategy-experiment-config-v1") throw reportError("config is invalid");
  for (const field of ["strategyCatalog", "scenarios", "comparisons", "ablations", "sensitivity", "benchmarkCapabilities", "diagnostics"]) {
    if (!Array.isArray(report[field])) throw reportError(`${field} must be an array`);
  }
  if (!report.datasetRefs || typeof report.datasetRefs !== "object" || Array.isArray(report.datasetRefs)) throw reportError("datasetRefs must be an object");
  if (!report.oos || typeof report.oos !== "object" || Array.isArray(report.oos)) throw reportError("oos must be an object");
  if (!["completed", "partial", "unavailable"].includes(report.status)
    || report.status !== statusFor(report.scenarios, report.diagnostics)) throw reportError("status is invalid");
  const scenarioIds = report.scenarios.map((entry) => entry?.scenarioId);
  if (scenarioIds.some((id) => typeof id !== "string" || !id) || new Set(scenarioIds).size !== scenarioIds.length
    || report.scenarios.some((entry) => !["completed", "failed", "unavailable"].includes(entry?.status))) {
    throw reportError("scenario identities or statuses are invalid");
  }
  if (!report.promotion || typeof report.promotion !== "object" || report.promotion.liveStrategyChanged !== false
    || typeof report.promotion.eligible !== "boolean" || !Array.isArray(report.promotion.candidates)) {
    throw reportError("promotion block is invalid");
  }
  const candidateIds = report.promotion.candidates.map((entry) => entry?.strategyId);
  if (candidateIds.some((id) => typeof id !== "string" || !id) || new Set(candidateIds).size !== candidateIds.length
    || report.promotion.candidates.some((entry) => typeof entry?.eligible !== "boolean"
      || !Array.isArray(entry?.reasonCodes)
      || entry.status !== (entry.eligible ? "eligible_to_apply" : "not_eligible")
      || entry.eligible !== (entry.reasonCodes.length === 0))) {
    throw reportError("promotion candidates are inconsistent");
  }
  const allCandidatesEligible = report.promotion.candidates.length > 0
    && report.promotion.candidates.every((entry) => entry.eligible === true);
  if (report.promotion.eligible !== allCandidatesEligible
    || report.promotion.status !== (allCandidatesEligible ? "eligible_to_apply" : "not_eligible")) {
    throw reportError("promotion status is inconsistent");
  }
  if (report.promotion.eligible && !eligiblePromotionSemantics(report)) {
    throw reportError("eligible promotion evidence is incomplete or inconsistent");
  }
  if (!/^[a-f0-9]{64}$/.test(String(report.experimentFingerprint ?? ""))
    || report.experimentFingerprint !== strategyExperimentFingerprint(report)) {
    throw reportError("fingerprint mismatch");
  }
  if (report.experimentId !== `experiment-${report.experimentFingerprint.slice(0, 24)}`) {
    throw reportError("experimentId is invalid");
  }
  return report;
}
