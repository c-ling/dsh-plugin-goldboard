import { canonicalSha256, replayReportFingerprint, validateReplayReport } from "./replay-report.js";
import { projectStrategyExperimentReport, validateStrategyExperimentReport } from "./experiment-report.js";
import { canonicalFactorRecordsAsOf } from "./factor-contract.js";
import { normalizeConfig } from "./config.js";
import { walkForwardFoldId, walkForwardFoldResultFingerprint } from "./walk-forward.js";
import { readJson, writeJsonAtomic } from "./store.js";

import {
  STRATEGY_EXPERIMENT_LANES,
  normalizeStrategyExperimentConfig,
} from "./experiment-config.js";

export {
  DEFAULT_STRATEGY_EXPERIMENT_CONFIG,
  STRATEGY_EXPERIMENT_ABLATIONS,
  STRATEGY_EXPERIMENT_CONFIG_VERSION,
  STRATEGY_EXPERIMENT_LANES,
  normalizeStrategyExperimentConfig,
} from "./experiment-config.js";

export const STRATEGY_EXPERIMENT_RUNNER_VERSION = "goldboard-strategy-experiment-runner-v1";
export const STRATEGY_PROMOTION_POLICY_VERSION = "goldboard-strategy-promotion-v1";
export const STRATEGY_PROMOTION_REQUIRED_MATRIX = Object.freeze({
  signalLanes: Object.freeze(["cmb", "au9999", "xau"]),
  costMultipliers: Object.freeze([1, 2]),
  parameterMultipliers: Object.freeze([0.8, 1, 1.2]),
  ablations: Object.freeze(["none", "without-regime-filter"]),
});

export const STRATEGY_BENCHMARK_CAPABILITIES = Object.freeze([
  Object.freeze({ id: "arima", family: "statistical", status: "unavailable", reasonCode: "training_artifact_missing" }),
  Object.freeze({ id: "sarima", family: "statistical", status: "unavailable", reasonCode: "training_artifact_missing" }),
  Object.freeze({ id: "garch", family: "statistical", status: "unavailable", reasonCode: "training_artifact_missing" }),
  Object.freeze({ id: "hmm", family: "statistical", status: "unavailable", reasonCode: "training_artifact_missing" }),
  Object.freeze({ id: "lstm", family: "ml", status: "unavailable", reasonCode: "point_in_time_features_missing" }),
  Object.freeze({ id: "transformer", family: "ml", status: "unavailable", reasonCode: "point_in_time_features_missing" }),
  Object.freeze({ id: "xgboost", family: "ml", status: "unavailable", reasonCode: "point_in_time_features_missing" }),
  Object.freeze({ id: "drl", family: "drl", status: "unavailable", reasonCode: "training_artifact_missing" }),
]);

function strategyExperimentBasis(config, catalog) {
  const strategyDescriptors = (Array.isArray(catalog) ? catalog : []).map((entry) => ({
    strategyId: entry.strategyId ?? null,
    strategyVersion: entry.strategyVersion ?? null,
    descriptorFingerprint: entry.descriptorFingerprint ?? null,
    adapterFingerprint: entry.adapterFingerprint ?? null,
    executionInstrument: entry.executionInstrument ?? null,
    lanes: Array.isArray(entry.lanes) ? [...entry.lanes].sort() : [],
  })).sort((left, right) => String(left.strategyId).localeCompare(String(right.strategyId)));
  const experiments = normalizeStrategyExperimentConfig(config?.experiments);
  experiments.enabledStrategyIds = [...experiments.enabledStrategyIds].sort();
  experiments.signalLanes = [...experiments.signalLanes].sort();
  experiments.costMultipliers = [...experiments.costMultipliers].sort((left, right) => left - right);
  experiments.parameterMultipliers = [...experiments.parameterMultipliers].sort((left, right) => left - right);
  experiments.ablations = [...experiments.ablations].sort();
  experiments.orb.requiredFactorIds = [...experiments.orb.requiredFactorIds].sort();
  const basis = {
    experiments,
    fee: config?.fee ?? {},
    cmb: config?.cmb ?? {},
    limits: { maxGrams: config?.limits?.maxGrams ?? null },
    risk: config?.risk ?? {},
    controlStrategy: config?.strategy ?? {},
    tradingHours: config?.tradingHours ?? {},
    manualPrevClose: config?.manualPrevClose ?? {},
    strategyDescriptors,
  };
  return { basis: structuredClone(basis), basisFingerprint: canonicalSha256(basis) };
}

function freezeTree(value, seen = new Set()) {
  if (!value || typeof value !== "object" || seen.has(value)) return value;
  seen.add(value);
  for (const entry of Object.values(value)) freezeTree(entry, seen);
  return Object.freeze(value);
}

function requestList(value, { field, code, allowed = null, maximum }) {
  if (!Array.isArray(value) || value.length === 0 || value.length > maximum) {
    const error = new TypeError(`${field} must be a non-empty array with at most ${maximum} entries`);
    error.code = code;
    throw error;
  }
  const output = [];
  for (const item of value) {
    if (typeof item !== "string" || !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(item)
      || (allowed && !allowed.includes(item))) {
      const error = new TypeError(`${field} contains an unsupported value`);
      error.code = code;
      throw error;
    }
    if (output.includes(item)) {
      const error = new TypeError(`${field} must not contain duplicate values`);
      error.code = code;
      throw error;
    }
    output.push(item);
  }
  return output;
}

function abortError(reason) {
  const error = new Error(String(reason?.message ?? reason ?? "strategy experiment cancelled"));
  error.name = "AbortError";
  return error;
}

function metricValue(report, key) {
  const raw = report?.metrics?.[key];
  if (raw !== null && raw !== undefined && raw !== "") {
    const direct = Number(raw);
    if (Number.isFinite(direct)) return direct;
  }
  if (key === "netPnlCny") {
    const compatibleRaw = report?.overall?.totalNetCny;
    if (compatibleRaw === null || compatibleRaw === undefined || compatibleRaw === "") return null;
    const compatible = Number(compatibleRaw);
    return Number.isFinite(compatible) ? compatible : null;
  }
  return null;
}

function descriptorFor(catalog, strategyId) {
  return catalog.find((entry) => entry?.strategyId === strategyId) ?? null;
}

export function expandStrategyExperimentScenarios(configValue, strategyCatalog = []) {
  const config = normalizeStrategyExperimentConfig(configValue);
  const catalog = Array.isArray(strategyCatalog) ? strategyCatalog : [];
  const scenarios = [];
  for (const strategyId of config.enabledStrategyIds) {
    const descriptor = descriptorFor(catalog, strategyId);
    const supported = Array.isArray(descriptor?.lanes) ? descriptor.lanes : [];
    for (const signalLane of config.signalLanes) {
      const laneSupported = supported.includes(signalLane);
      const candidate = descriptor?.role !== "control";
      const costs = config.costMultipliers;
      const parameters = candidate ? config.parameterMultipliers : [1];
      const ablations = candidate && Array.isArray(descriptor?.ablations)
        ? config.ablations.filter((entry) => entry === "none" || descriptor.ablations.includes(entry))
        : ["none"];
      for (const costMultiplier of costs) {
        for (const parameterMultiplier of parameters) {
          for (const ablation of ablations.length > 0 ? ablations : ["none"]) {
            const core = {
              runnerVersion: STRATEGY_EXPERIMENT_RUNNER_VERSION,
              strategyId,
              strategyVersion: descriptor?.strategyVersion ?? null,
              strategyDescriptorFingerprint: descriptor?.descriptorFingerprint ?? null,
              signalLane,
              executionInstrument: "CMB_ACCUMULATED_GOLD",
              costMultiplier,
              parameterMultiplier,
              ablation,
            };
            scenarios.push({
              ...core,
              scenarioId: `scenario-${canonicalSha256(core).slice(0, 24)}`,
              preflightStatus: descriptor === null ? "unknown_strategy" : laneSupported ? "ready" : "unsupported_lane",
            });
          }
        }
      }
    }
  }
  if (scenarios.length > config.maxScenarios) {
    const error = new RangeError(`strategy experiment expands to ${scenarios.length} scenarios (max ${config.maxScenarios})`);
    error.code = "EXPERIMENT_TOO_LARGE";
    throw error;
  }
  return scenarios.sort((left, right) => left.scenarioId.localeCompare(right.scenarioId));
}

function summarizeOosReport(report) {
  const folds = Array.isArray(report?.oos?.folds) ? report.oos.folds : [];
  const completed = folds.filter((fold) => fold?.status === "completed");
  const netValues = completed.map((fold) => finiteMetric(fold?.metrics?.netPnlCny));
  const drawdownValues = completed.map((fold) => finiteMetric(fold?.metrics?.maxDrawdownCny));
  const sharpeValues = completed.map((fold) => finiteMetric(fold?.metrics?.sharpe)).filter((value) => value !== null);
  const completeNet = completed.length > 0 && netValues.every((value) => value !== null);
  const completeDrawdown = completed.length > 0 && drawdownValues.every((value) => value !== null);
  return {
    version: report?.oos?.version ?? null,
    registryId: report?.oos?.registryId ?? null,
    datasetId: report?.oos?.datasetId ?? null,
    status: report?.oos?.status ?? "insufficient_data",
    registeredFolds: folds.length,
    completedFolds: completed.length,
    resultFingerprint: report?.oos?.resultFingerprint ?? null,
    metrics: {
      netPnlCny: completeNet ? netValues.reduce((sum, value) => sum + value, 0) : null,
      maxDrawdownCny: completeDrawdown ? Math.max(...drawdownValues) : null,
      meanSharpe: sharpeValues.length === completed.length && completed.length > 0
        ? sharpeValues.reduce((sum, value) => sum + value, 0) / sharpeValues.length : null,
    },
    folds: folds.map((fold) => ({
      foldId: fold?.foldId ?? null,
      status: fold?.status ?? "unknown",
      resultFingerprint: fold?.resultFingerprint ?? null,
      parameterFingerprint: fold?.parameterFingerprint ?? fold?.paramsFingerprint ?? null,
      parametersFrozen: fold?.parametersFrozen === true,
      sampleCount: Number.isFinite(Number(fold?.sampleCount)) ? Number(fold.sampleCount) : null,
      // Fold-basis evidence must survive summarization: the promotion policy
      // re-checks dataset/factor/precommit identity on the scenario copy.
      datasetId: fold?.datasetId ?? null,
      datasetContentSha256: fold?.datasetContentSha256 ?? null,
      executionDatasetId: fold?.executionDatasetId ?? null,
      executionDatasetContentSha256: fold?.executionDatasetContentSha256 ?? null,
      factorFingerprint: fold?.factorFingerprint ?? null,
      simulationFingerprint: fold?.simulationFingerprint ?? null,
      parameterPrecommit: fold?.parameterPrecommit ? structuredClone(fold.parameterPrecommit) : null,
      asOf: fold?.asOf ?? null,
      train: fold?.train ? structuredClone(fold.train) : null,
      test: fold?.test ? structuredClone(fold.test) : null,
      warmup: fold?.warmup ? structuredClone(fold.warmup) : null,
      metrics: fold?.metrics ? structuredClone(fold.metrics) : null,
      benchmarks: fold?.benchmarks && typeof fold.benchmarks === "object" ? structuredClone(fold.benchmarks) : null,
      diagnostics: Array.isArray(fold?.diagnostics) ? structuredClone(fold.diagnostics) : [],
    })),
  };
}

function scenarioAttestationErrors(scenario, report, expected = {}) {
  const provenance = report?.provenance ?? {};
  const experiment = provenance.experiment ?? {};
  const params = report?.params ?? {};
  const errors = [];
  const expect = (condition, code) => { if (!condition) errors.push(code); };
  expect(provenance.strategyId === scenario.strategyId && params.strategyId === scenario.strategyId, "strategy_id");
  expect(provenance.strategyVersion === scenario.strategyVersion && params.strategyVersion === scenario.strategyVersion, "strategy_version");
  expect(provenance.strategyDescriptorFingerprint === scenario.strategyDescriptorFingerprint, "strategy_descriptor");
  expect(expected.asOf === undefined || report.asOf === new Date(expected.asOf).toISOString(), "as_of");
  expect(report.dataset?.asOf === report.asOf, "signal_dataset_as_of");
  expect(provenance.executionDataset?.asOf === report.asOf, "execution_dataset_as_of");
  expect(expected.mode === undefined || params.mode === expected.mode, "mode");
  expect(expected.days === undefined || expected.mode === "walk-forward"
    || Number(params.days) === Number(expected.days), "days");
  expect(report.lane === scenario.signalLane && params.lane === scenario.signalLane, "signal_lane");
  expect(experiment.replayOnly === (scenario.strategyId !== "control"), "replay_only");
  expect(experiment.liveStrategyChanged === false, "live_strategy_changed");
  expect(Number(experiment.costMultiplier) === Number(scenario.costMultiplier)
    && Number(params.costMultiplier) === Number(scenario.costMultiplier), "cost_multiplier");
  expect(Number(experiment.parameterMultiplier) === Number(scenario.parameterMultiplier)
    && Number(params.parameterMultiplier) === Number(scenario.parameterMultiplier), "parameter_multiplier");
  expect(experiment.ablation === scenario.ablation && params.ablation === scenario.ablation, "ablation");
  expect(provenance.executionInstrument === scenario.executionInstrument, "execution_instrument");
  expect(provenance.executionLane === "cmb" && params.executionLane === "cmb", "execution_lane");
  const expectedParameterFingerprint = canonicalSha256({
    parameters: params.strategyParameters,
    parameterMultiplier: scenario.parameterMultiplier,
    ablation: scenario.ablation,
  });
  expect(provenance.parameterFingerprint === expectedParameterFingerprint, "parameter_fingerprint");
  if (expected.fullConfig) {
    const configuredParameters = scenario.strategyId === "control"
      ? expected.fullConfig.strategy : expected.fullConfig.experiments?.orb;
    expect(canonicalSha256(params.strategyParameters) === canonicalSha256(configuredParameters), "configured_parameters");
    const multiplier = Number(scenario.costMultiplier);
    const expectedScenarioConfig = normalizeConfig({
      ...expected.fullConfig,
      fee: {
        buyPerGram: Number(expected.fullConfig.fee?.buyPerGram) * multiplier,
        sellPerGram: Number(expected.fullConfig.fee?.sellPerGram) * multiplier,
      },
      strategy: {
        ...expected.fullConfig.strategy,
        slippagePerGram: Number(expected.fullConfig.strategy?.slippagePerGram) * multiplier,
        estimatedSpreadPerGram: Number(expected.fullConfig.strategy?.estimatedSpreadPerGram) * multiplier,
      },
    });
    const replayBasis = (value) => ({
      fee: value?.fee,
      cmb: value?.cmb,
      limits: value?.limits,
      risk: value?.risk,
      strategy: value?.strategy,
      tradingHours: value?.tradingHours,
    });
    expect(canonicalSha256(replayBasis(params)) === canonicalSha256(replayBasis(expectedScenarioConfig)), "config_basis");
  }
  const factorVintages = Array.isArray(provenance.factorVintages) ? provenance.factorVintages : [];
  const requiredFactorIds = Array.isArray(params.strategyParameters?.requiredFactorIds)
    ? [...params.strategyParameters.requiredFactorIds].sort() : [];
  const expectedFactorFingerprint = canonicalSha256({
    requiredFactorIds,
    factorRecords: canonicalFactorRecordsAsOf(factorVintages, { asOf: report.asOf }),
  });
  expect(/^[a-f0-9]{64}$/.test(String(provenance.factorFingerprint ?? ""))
    && provenance.factorFingerprint === expectedFactorFingerprint, "factor_fingerprint");
  return errors;
}

function summarizeScenario(scenario, result, expected = {}) {
  if (result?.ok === true && result.report) {
    try {
      const report = validateReplayReport(result.report);
      const attestationErrors = scenarioAttestationErrors(scenario, report, expected);
      result = attestationErrors.length === 0
        ? { ...result, report }
        : {
            ok: false,
            status: "failed",
            reasonCodes: ["scenario_attestation_mismatch"],
            diagnostics: [{ code: "scenario_attestation_mismatch", fields: attestationErrors }],
          };
    } catch (error) {
      result = {
        ok: false,
        status: "failed",
        reasonCodes: ["invalid_replay_report"],
        diagnostics: [{ code: "invalid_replay_report", message: String(error?.message ?? error).slice(0, 300) }],
      };
    }
  }
  if (!result || result.ok !== true || !result.report) {
    const reasonCodes = Array.isArray(result?.reasonCodes) && result.reasonCodes.length > 0
      ? result.reasonCodes.map(String) : ["scenario_failed"];
    const resultDiagnostics = Array.isArray(result?.diagnostics) && result.diagnostics.length > 0
      ? structuredClone(result.diagnostics)
      : reasonCodes.map((code) => ({ code }));
    return {
      ...scenario,
      status: result?.status === "unavailable" ? "unavailable" : "failed",
      reasonCodes,
      reportId: result?.reportId ?? null,
      reportFingerprint: result?.reportFingerprint ?? null,
      reportInputFingerprint: result?.reportInputFingerprint ?? null,
      simulationFingerprint: result?.simulationFingerprint ?? null,
      parameterFingerprint: result?.parameterFingerprint ?? null,
      datasetId: result?.datasetId ?? result?.datasetAudit?.datasetId ?? null,
      datasetFingerprint: result?.datasetFingerprint ?? result?.datasetAudit?.contentSha256 ?? null,
      fillPolicy: result?.fillPolicy ?? null,
      ambiguityPolicy: result?.ambiguityPolicy ?? null,
      executionVersion: result?.executionVersion ?? null,
      factorFingerprint: result?.factorFingerprint ?? null,
      factorVintages: Array.isArray(result?.factorVintages) ? structuredClone(result.factorVintages) : [],
      scenarioAttestation: null,
      evidenceStatus: result?.evidenceStatus ?? "unavailable",
      validationEligible: false,
      validationGate: result?.validationGate ? structuredClone(result.validationGate) : null,
      validationEvidence: null,
      datasetAudit: result?.datasetAudit && typeof result.datasetAudit === "object"
        ? structuredClone(result.datasetAudit) : null,
      executionDatasetAudit: result?.executionDatasetAudit && typeof result.executionDatasetAudit === "object"
        ? structuredClone(result.executionDatasetAudit) : null,
      costVerification: result?.costVerification ? structuredClone(result.costVerification) : null,
      regimes: result?.regimes && typeof result.regimes === "object" ? structuredClone(result.regimes) : {},
      setupLifecycle: result?.setupLifecycle && typeof result.setupLifecycle === "object"
        ? structuredClone(result.setupLifecycle) : {},
      activeSignals: Array.isArray(result?.activeSignals) ? structuredClone(result.activeSignals) : [],
      suppressedReasons: result?.suppressedReasons && typeof result.suppressedReasons === "object"
        ? structuredClone(result.suppressedReasons) : {},
      diagnostics: resultDiagnostics,
    };
  }
  const report = result.report;
  return {
    ...scenario,
    status: "completed",
    reasonCodes: [],
    reportId: report.reportId ?? null,
    reportFingerprint: report.reportFingerprint ?? null,
    reportInputFingerprint: report.inputFingerprint ?? null,
    simulationFingerprint: report.simulation?.inputFingerprint ?? null,
    parameterFingerprint: report.provenance?.parameterFingerprint ?? null,
    datasetId: report.dataset?.datasetId ?? null,
    datasetFingerprint: report.dataset?.contentSha256 ?? null,
    fillPolicy: report.fillPolicy ?? report.simulation?.policy?.fillPolicy ?? null,
    ambiguityPolicy: report.ambiguityPolicy ?? report.simulation?.policy?.ambiguityPolicy ?? null,
    executionVersion: report.executionVersion ?? report.provenance?.executionVersion ?? null,
    executionInstrument: report.provenance?.executionInstrument ?? report.executionInstrument ?? null,
    factorFingerprint: report.provenance?.factorFingerprint ?? null,
    factorVintages: Array.isArray(report.provenance?.factorVintages)
      ? structuredClone(report.provenance.factorVintages) : [],
    scenarioAttestation: {
      strategyId: report.provenance.strategyId,
      strategyVersion: report.provenance.strategyVersion,
      strategyDescriptorFingerprint: report.provenance.strategyDescriptorFingerprint,
      asOf: report.asOf,
      mode: report.params.mode,
      signalLane: report.lane,
      executionLane: report.provenance.executionLane,
      executionInstrument: report.provenance.executionInstrument,
      costMultiplier: report.provenance.experiment.costMultiplier,
      parameterMultiplier: report.provenance.experiment.parameterMultiplier,
      ablation: report.provenance.experiment.ablation,
      replayOnly: report.provenance.experiment.replayOnly,
      liveStrategyChanged: report.provenance.experiment.liveStrategyChanged,
      parameterFingerprint: report.provenance.parameterFingerprint,
      factorFingerprint: report.provenance.factorFingerprint,
      reportInputFingerprint: report.inputFingerprint,
      simulationFingerprint: report.simulation.inputFingerprint,
      datasetId: report.dataset.datasetId,
      executionDatasetId: report.provenance.executionDataset?.datasetId ?? null,
    },
    evidenceStatus: report.evidenceStatus ?? "exploratory",
    validationEligible: report.validationGate?.eligible === true,
    validationGate: report.validationGate ? structuredClone(report.validationGate) : null,
    validationEvidence: {
      replayReportFingerprintValid: typeof report.reportFingerprint === "string"
        && replayReportFingerprint(report) === report.reportFingerprint,
      uncertainty: {
        returnInterval: report.metrics?.returnInterval ? structuredClone(report.metrics.returnInterval) : null,
        winRateInterval: report.metrics?.winRateInterval ? structuredClone(report.metrics.winRateInterval) : null,
      },
      benchmarks: report.benchmarks && typeof report.benchmarks === "object"
        ? structuredClone(report.benchmarks) : {},
    },
    datasetAudit: {
      version: report.dataset?.version ?? null,
      asOf: report.dataset?.asOf ?? null,
      inputFingerprint: report.dataset?.inputFingerprint ?? null,
      dateRange: report.dataset?.dateRange ? structuredClone(report.dataset.dateRange) : null,
      records: report.dataset?.records ? structuredClone(report.dataset.records) : null,
      evidence: report.dataset?.evidence ? structuredClone(report.dataset.evidence) : null,
      executionCoverage: report.dataset?.executionCoverage ? structuredClone(report.dataset.executionCoverage) : null,
      sourceVersion: report.dataset?.sourceVersion ?? null,
      dataSchemaVersion: report.dataset?.dataSchemaVersion ?? null,
      calendarVersion: report.dataset?.calendarVersion ?? null,
    },
    executionDatasetAudit: report.provenance?.executionDataset
      ? structuredClone(report.provenance.executionDataset) : null,
    costVerification: report.provenance?.costVerification
      ? structuredClone(report.provenance.costVerification) : null,
    metrics: {
      netPnlCny: metricValue(report, "netPnlCny"),
      totalReturn: metricValue(report, "totalReturn"),
      maxDrawdownCny: metricValue(report, "maxDrawdownCny"),
      maxDrawdownPct: metricValue(report, "maxDrawdownPct"),
      sharpe: metricValue(report, "sharpe"),
      sortino: metricValue(report, "sortino"),
      calmar: metricValue(report, "calmar"),
      turnoverCny: metricValue(report, "turnoverCny"),
      profitFactor: metricValue(report, "profitFactor"),
      fills: Number(report?.simulation?.counts?.fills ?? report?.orders?.filled ?? 0),
    },
    oos: summarizeOosReport(report),
    regimes: report.simulation?.strategyFacts?.regimes ?? {},
    setupLifecycle: report.simulation?.strategyFacts?.setupLifecycle ?? {},
    activeSignals: Object.entries(report.simulation?.strategyFacts?.activeSignalCounts ?? {})
      .map(([code, count]) => ({ code, count: Number(count) || 0 })),
    suppressedReasons: report.simulation?.strategyFacts?.suppressedReasons ?? {},
    diagnostics: [
      ...(Array.isArray(result.diagnostics) ? structuredClone(result.diagnostics) : []),
      ...(report.simulation?.diagnostics && typeof report.simulation.diagnostics === "object"
        ? [{ type: "replay_simulator", value: structuredClone(report.simulation.diagnostics) }] : []),
    ],
  };
}

function baselineScenario(scenarios, strategyId, lane) {
  return scenarios.find((entry) => entry.strategyId === strategyId
    && entry.signalLane === lane
    && entry.costMultiplier === 1
    && entry.parameterMultiplier === 1
    && entry.ablation === "none"
    && entry.status === "completed") ?? null;
}

function executionDatasetIdentity(scenario) {
  const audit = scenario?.executionDatasetAudit;
  if (!audit || typeof audit !== "object") return null;
  return canonicalSha256({
    datasetId: audit.datasetId ?? null,
    contentSha256: audit.contentSha256 ?? null,
    inputFingerprint: audit.inputFingerprint ?? null,
    pointInTimePolicy: audit.pointInTimePolicy ?? null,
    alignment: audit.alignment ?? null,
  });
}

function buildComparisons(scenarios, controlStrategyId) {
  const output = [];
  for (const candidate of scenarios) {
    if (candidate.strategyId === controlStrategyId || candidate.status !== "completed") continue;
    if (candidate.costMultiplier !== 1 || candidate.parameterMultiplier !== 1 || candidate.ablation !== "none") continue;
    const control = baselineScenario(scenarios, controlStrategyId, candidate.signalLane);
    if (!control) continue;
    const candidateNet = finiteMetric(candidate.oos?.metrics?.netPnlCny);
    const controlNet = finiteMetric(control.oos?.metrics?.netPnlCny);
    const candidateDrawdown = finiteMetric(candidate.oos?.metrics?.maxDrawdownCny);
    const controlDrawdown = finiteMetric(control.oos?.metrics?.maxDrawdownCny);
    output.push({
      strategyId: candidate.strategyId,
      signalLane: candidate.signalLane,
      basis: "completed_oos_folds",
      candidateScenarioId: candidate.scenarioId,
      controlScenarioId: control.scenarioId,
      datasetMatches: candidate.datasetId !== null && candidate.datasetId === control.datasetId,
      executionDatasetMatches: executionDatasetIdentity(candidate) !== null
        && executionDatasetIdentity(candidate) === executionDatasetIdentity(control),
      candidateExecutionInstrument: candidate.executionInstrument,
      controlExecutionInstrument: control.executionInstrument,
      executionBasisMatches: candidate.executionInstrument === "CMB_ACCUMULATED_GOLD"
        && control.executionInstrument === "CMB_ACCUMULATED_GOLD"
        && candidate.fillPolicy === control.fillPolicy
        && candidate.ambiguityPolicy === control.ambiguityPolicy
        && candidate.executionVersion === control.executionVersion
        && executionDatasetIdentity(candidate) !== null
        && executionDatasetIdentity(candidate) === executionDatasetIdentity(control),
      netPnlDeltaCny: candidateNet !== null && controlNet !== null ? candidateNet - controlNet : null,
      maxDrawdownDeltaCny: candidateDrawdown !== null && controlDrawdown !== null ? candidateDrawdown - controlDrawdown : null,
      candidateValidated: candidate.validationEligible === true,
      controlValidated: control.validationEligible === true,
    });
  }
  return output;
}

function buildAblations(scenarios) {
  const output = [];
  for (const scenario of scenarios) {
    if (scenario.ablation !== "none" || scenario.status !== "completed") continue;
    const variants = scenarios.filter((entry) => entry.strategyId === scenario.strategyId
      && entry.signalLane === scenario.signalLane
      && entry.costMultiplier === scenario.costMultiplier
      && entry.parameterMultiplier === scenario.parameterMultiplier
      && entry.ablation !== "none");
    for (const variant of variants) {
      const baselineNet = finiteMetric(scenario.oos?.metrics?.netPnlCny);
      const variantNet = finiteMetric(variant.oos?.metrics?.netPnlCny);
      output.push({
        strategyId: scenario.strategyId,
        signalLane: scenario.signalLane,
        ablation: variant.ablation,
        basis: "completed_oos_folds",
        baselineScenarioId: scenario.scenarioId,
        variantScenarioId: variant.scenarioId,
        status: variant.status,
        netPnlDeltaCny: baselineNet !== null && variantNet !== null ? variantNet - baselineNet : null,
      });
    }
  }
  return output;
}

function buildSensitivity(scenarios) {
  const output = [];
  const keys = new Set(scenarios.map((entry) => `${entry.strategyId}|${entry.signalLane}|${entry.ablation}`));
  for (const key of keys) {
    const [strategyId, signalLane, ablation] = key.split("|");
    const items = scenarios.filter((entry) => entry.strategyId === strategyId
      && entry.signalLane === signalLane
      && entry.ablation === ablation)
      .map((entry) => ({
        scenarioId: entry.scenarioId,
        costMultiplier: entry.costMultiplier,
        parameterMultiplier: entry.parameterMultiplier,
        status: entry.status,
        fullSample: {
          netPnlCny: entry.metrics?.netPnlCny ?? null,
          maxDrawdownCny: entry.metrics?.maxDrawdownCny ?? null,
        },
        oos: {
          netPnlCny: entry.oos?.metrics?.netPnlCny ?? null,
          maxDrawdownCny: entry.oos?.metrics?.maxDrawdownCny ?? null,
        },
      }));
    output.push({ strategyId, signalLane, ablation, items });
  }
  return output;
}

function finiteMetric(value) {
  if (value === null || value === undefined || value === "") return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function intervalEvidenceComplete(intervals) {
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

function benchmarkEvidenceComplete(benchmarks) {
  return ["no_trade", "buy_and_hold", "fixed_interval_dca", "simple_moving_average"].every((id) => {
    const benchmark = benchmarks?.[id];
    return benchmark?.status === "ok"
      && Array.isArray(benchmark.diagnostics) && benchmark.diagnostics.length === 0
      && finiteMetric(benchmark.metrics?.netPnlCny) !== null
      && finiteMetric(benchmark.metrics?.totalReturn) !== null
      && finiteMetric(benchmark.metrics?.maxDrawdownCny) !== null
      && Number(benchmark.metrics?.samples?.returns) > 0;
  });
}

function foldEvidenceComplete(fold) {
  const parameterFingerprint = fold?.parameterFingerprint;
  const trainFrom = Date.parse(fold?.train?.from ?? "");
  const trainTo = Date.parse(fold?.train?.toExclusive ?? "");
  const testFrom = Date.parse(fold?.test?.from ?? "");
  const testTo = Date.parse(fold?.test?.toExclusive ?? "");
  const warmupFrames = Number(fold?.warmup?.frames);
  const warmupFrom = Date.parse(fold?.warmup?.from ?? "");
  const warmupTo = Date.parse(fold?.warmup?.to ?? "");
  const warmupValid = fold?.warmup?.policy === "point-in-time-history-only"
    && Number.isInteger(warmupFrames) && warmupFrames >= 0
    && /^[a-f0-9]{64}$/.test(String(fold?.warmup?.stateFingerprint ?? ""))
    && (warmupFrames === 0
      ? fold.warmup.from === null && fold.warmup.to === null
      : Number.isFinite(warmupFrom) && Number.isFinite(warmupTo) && warmupFrom <= warmupTo && warmupTo < testFrom);
  const isMonthStart = (value) => Number.isFinite(value)
    && new Date(value).toISOString().endsWith("-01T00:00:00.000Z");
  return fold?.status === "completed" && /^fold-[a-f0-9]{64}$/.test(String(fold.foldId ?? ""))
    && fold.foldId === walkForwardFoldId(fold)
    && /^[a-f0-9]{64}$/.test(String(parameterFingerprint ?? ""))
    && /^[a-f0-9]{64}$/.test(String(fold?.simulationFingerprint ?? ""))
    && /^dataset-[a-f0-9]{64}$/.test(String(fold?.executionDatasetId ?? ""))
    && /^[a-f0-9]{64}$/.test(String(fold?.executionDatasetContentSha256 ?? ""))
    && /^[a-f0-9]{64}$/.test(String(fold?.factorFingerprint ?? ""))
    && fold.resultFingerprint === walkForwardFoldResultFingerprint(fold)
    && fold.parametersFrozen === true && Number(fold.sampleCount) >= 10
    && Number(fold.sampleCount) === Number(fold.test?.completeSessions)
    && fold.parameterPrecommit?.verified === true
    && Date.parse(fold.parameterPrecommit?.committedAt ?? "") <= testFrom
    && warmupValid
    && Number.isFinite(trainFrom) && Number.isFinite(trainTo) && Number.isFinite(testFrom) && Number.isFinite(testTo)
    && trainFrom < trainTo && trainTo === testFrom && testFrom < testTo
    && isMonthStart(trainFrom) && isMonthStart(trainTo) && isMonthStart(testTo)
    && Number(fold.train?.months) === 6 && Number(fold.test?.months) === 1
    && Number(fold.train?.coveredMonths) === 6 && Number(fold.test?.coveredMonths) === 1
    && Number(fold.train?.qualifyingMonths) === 6 && Number(fold.test?.qualifyingMonths) === 1
    && Number(fold.train?.minimumSessionsPerMonth) >= 10 && Number(fold.test?.minimumSessionsPerMonth) >= 10
    && Array.isArray(fold.diagnostics) && fold.diagnostics.length === 0
    && benchmarkEvidenceComplete(fold.benchmarks)
    && finiteMetric(fold.metrics?.netPnlCny) !== null && finiteMetric(fold.metrics?.maxDrawdownCny) !== null
    && intervalEvidenceComplete({
      returnInterval: fold.metrics?.returnInterval,
      winRateInterval: fold.metrics?.winRateInterval,
    });
}

function scenarioValidationEvidenceComplete(scenario) {
  const gate = scenario?.validationGate;
  const observed = gate?.observed;
  const folds = Array.isArray(scenario?.oos?.folds) ? scenario.oos.folds : [];
  const expectedOosFingerprint = canonicalSha256({
    registryId: scenario?.oos?.registryId,
    folds: folds.map((fold) => ({ foldId: fold.foldId, status: fold.status, resultFingerprint: fold.resultFingerprint ?? null })),
  });
  const expectedNet = folds.reduce((sum, fold) => sum + Number(fold.metrics?.netPnlCny), 0);
  const expectedDrawdown = folds.length > 0 ? Math.max(...folds.map((fold) => Number(fold.metrics?.maxDrawdownCny))) : null;
  return scenario?.executionInstrument === "CMB_ACCUMULATED_GOLD"
    && scenario?.evidenceStatus === "validated"
    && scenario?.validationEvidence?.replayReportFingerprintValid === true
    && gate?.status === "eligible" && gate?.eligible === true
    && Array.isArray(gate.unmet) && gate.unmet.length === 0
    && observed?.datasetValid === true && observed?.executionDatasetValid === true
    && observed?.datasetIntegrity === true && observed?.executionAlignmentComplete === true
    && observed?.sessionCoverageComplete === true && observed?.pointInTimeIngestion === true && observed?.registryValid === true
    && observed?.parameterPrecommitVerified === true
    && Number(observed?.oosFolds) >= 2 && Number(observed?.frozenOosFolds) === Number(observed.oosFolds)
    && Number(observed?.oosFoldsWithIntervals) === Number(observed.oosFolds)
    && Number(observed?.realBidAskCoverage) === 1 && Number(observed?.incompleteSessions) === 0
    && observed?.valuationComplete === true && observed?.simulationDiagnosticsClean === true && observed?.costsVerified === true
    && observed?.benchmarksComplete === true && observed?.intervalsComplete === true
    && intervalEvidenceComplete(scenario.validationEvidence.uncertainty)
    && benchmarkEvidenceComplete(scenario.validationEvidence.benchmarks)
    && scenario?.oos?.status === "completed" && scenario.oos.registeredFolds === folds.length
    && scenario.oos.completedFolds === folds.length && folds.length >= 2 && folds.every(foldEvidenceComplete)
    && scenario.oos.resultFingerprint === expectedOosFingerprint
    && finiteMetric(scenario.oos.metrics?.netPnlCny) === expectedNet
    && finiteMetric(scenario.oos.metrics?.maxDrawdownCny) === expectedDrawdown;
}

function foldWindowKey(fold) {
  const from = fold?.test?.from;
  const to = fold?.test?.toExclusive;
  return typeof from === "string" && typeof to === "string" ? `${from}|${to}` : null;
}

function foldComparison(candidate, control) {
  const candidateFolds = Array.isArray(candidate?.oos?.folds) ? candidate.oos.folds : [];
  const controlByWindow = new Map((Array.isArray(control?.oos?.folds) ? control.oos.folds : [])
    .map((fold) => [foldWindowKey(fold), fold]).filter(([key]) => key));
  const aligned = candidateFolds.length >= 2 && candidateFolds.every((fold) => controlByWindow.has(foldWindowKey(fold)))
    && controlByWindow.size === candidateFolds.length;
  if (!aligned) return { aligned: false, dominates: false };
  const dominates = candidateFolds.every((fold) => {
    const controlFold = controlByWindow.get(foldWindowKey(fold));
    const candidateNet = finiteMetric(fold.metrics?.netPnlCny);
    const controlNet = finiteMetric(controlFold?.metrics?.netPnlCny);
    const candidateDrawdown = finiteMetric(fold.metrics?.maxDrawdownCny);
    const controlDrawdown = finiteMetric(controlFold?.metrics?.maxDrawdownCny);
    return candidateNet !== null && controlNet !== null && candidateNet >= controlNet
      && candidateDrawdown !== null && controlDrawdown !== null && candidateDrawdown <= controlDrawdown;
  });
  return { aligned, dominates };
}

function everyFoldNonLosing(scenario) {
  const folds = Array.isArray(scenario?.oos?.folds) ? scenario.oos.folds : [];
  return folds.length >= 2 && folds.every((fold) => finiteMetric(fold.metrics?.netPnlCny) >= 0);
}

function everyFoldDominatesBenchmarks(scenario) {
  const folds = Array.isArray(scenario?.oos?.folds) ? scenario.oos.folds : [];
  return folds.length >= 2 && folds.every((fold) => {
    const candidateNet = finiteMetric(fold.metrics?.netPnlCny);
    if (candidateNet === null || !benchmarkEvidenceComplete(fold.benchmarks)) return false;
    return Object.values(fold.benchmarks).every((benchmark) => {
      const benchmarkNet = finiteMetric(benchmark?.metrics?.netPnlCny);
      return benchmarkNet !== null && candidateNet >= benchmarkNet;
    });
  });
}

function exactMatrixValues(actual, expected) {
  return Array.isArray(actual) && actual.length === expected.length
    && [...actual].sort().every((value, index) => value === [...expected].sort()[index]);
}

function candidatePromotion(strategyId, config, scenarios, comparisons, runMode) {
  const reasonCodes = [];
  if (runMode !== "walk-forward") reasonCodes.push("walk_forward_required");
  if (!exactMatrixValues(config.signalLanes, STRATEGY_PROMOTION_REQUIRED_MATRIX.signalLanes)
    || !exactMatrixValues(config.costMultipliers, STRATEGY_PROMOTION_REQUIRED_MATRIX.costMultipliers)
    || !exactMatrixValues(config.parameterMultipliers, STRATEGY_PROMOTION_REQUIRED_MATRIX.parameterMultipliers)
    || !exactMatrixValues(config.ablations, STRATEGY_PROMOTION_REQUIRED_MATRIX.ablations)) {
    reasonCodes.push("promotion_matrix_not_exact");
  }
  const candidateScenarios = scenarios.filter((entry) => entry.strategyId === strategyId);
  if (STRATEGY_PROMOTION_REQUIRED_MATRIX.signalLanes.some((value) => !config.signalLanes.includes(value))) {
    reasonCodes.push("signal_lane_matrix_incomplete");
  }
  if (STRATEGY_PROMOTION_REQUIRED_MATRIX.costMultipliers.some((value) => !config.costMultipliers.includes(value))) {
    reasonCodes.push("cost_stress_matrix_incomplete");
  }
  if (STRATEGY_PROMOTION_REQUIRED_MATRIX.parameterMultipliers.some((value) => !config.parameterMultipliers.includes(value))) {
    reasonCodes.push("parameter_sensitivity_incomplete");
  }
  if (STRATEGY_PROMOTION_REQUIRED_MATRIX.ablations.some((value) => !config.ablations.includes(value))) {
    reasonCodes.push("ablation_matrix_incomplete");
  }
  const expected = config.signalLanes.length * config.costMultipliers.length
    * config.parameterMultipliers.length * config.ablations.length;
  if (candidateScenarios.length < expected || candidateScenarios.some((entry) => entry.status !== "completed")) {
    reasonCodes.push("scenario_matrix_incomplete");
  }
  for (const lane of config.signalLanes) {
    const laneScenarios = candidateScenarios.filter((entry) => entry.signalLane === lane && entry.status === "completed");
    const datasetIds = new Set(laneScenarios.map((entry) => entry.datasetId).filter((value) => typeof value === "string" && value));
    if (laneScenarios.some((entry) => !entry.datasetId) || datasetIds.size !== 1) reasonCodes.push("dataset_basis_mismatch");
    const executionBases = new Set(laneScenarios.map((entry) => `${entry.fillPolicy}|${entry.ambiguityPolicy}|${entry.executionVersion}`));
    if (laneScenarios.some((entry) => !entry.fillPolicy || !entry.ambiguityPolicy || !entry.executionVersion)
      || executionBases.size !== 1) reasonCodes.push("execution_basis_mismatch");
  }
  const baselines = config.signalLanes.map((lane) => baselineScenario(scenarios, strategyId, lane));
  if (baselines.some((entry) => entry === null)) reasonCodes.push("lane_baseline_missing");
  if (baselines.some((entry) => entry && !scenarioValidationEvidenceComplete(entry))) reasonCodes.push("oos_not_validated");
  if (candidateScenarios.some((entry) => entry.status === "completed" && !scenarioValidationEvidenceComplete(entry))) {
    reasonCodes.push("scenario_validation_incomplete");
  }
  if (candidateScenarios.some((entry) => entry.status === "completed" && !everyFoldDominatesBenchmarks(entry))) {
    reasonCodes.push("per_fold_benchmark_not_dominated");
  }
  if (comparisons.filter((entry) => entry.strategyId === strategyId).length !== config.signalLanes.length) {
    reasonCodes.push("control_comparison_missing");
  } else {
    const candidateComparisons = comparisons.filter((entry) => entry.strategyId === strategyId);
    if (candidateComparisons.some((entry) => {
      const control = baselineScenario(scenarios, "control", entry.signalLane);
      return entry.controlValidated !== true || !scenarioValidationEvidenceComplete(control);
    })) {
      reasonCodes.push("control_oos_not_validated");
    }
    for (const entry of candidateComparisons) {
      const candidate = baselineScenario(scenarios, strategyId, entry.signalLane);
      const control = baselineScenario(scenarios, "control", entry.signalLane);
      const foldEvidence = foldComparison(candidate, control);
      if (!foldEvidence.aligned) reasonCodes.push("fold_windows_misaligned");
      else if (!foldEvidence.dominates) reasonCodes.push("per_fold_control_not_dominated");
    }
    if (candidateComparisons.some((entry) => entry.datasetMatches !== true)) {
      reasonCodes.push("dataset_basis_mismatch");
    }
    if (candidateComparisons.some((entry) => entry.executionBasisMatches !== true)) {
      reasonCodes.push("execution_basis_mismatch");
    }
    if (candidateComparisons.some((entry) => {
      const delta = finiteMetric(entry.netPnlDeltaCny);
      return delta === null || delta <= 0;
    })) {
      reasonCodes.push("candidate_not_better_than_control");
    }
  }
  const costStress = candidateScenarios.filter((entry) => entry.costMultiplier > 1
    && entry.parameterMultiplier === 1 && entry.ablation === "none");
  if (costStress.length !== config.signalLanes.length * Math.max(0, config.costMultipliers.length - 1)
      || costStress.some((entry) => {
        const net = finiteMetric(entry.oos?.metrics?.netPnlCny);
        return entry.status !== "completed" || net === null || net < 0 || !everyFoldNonLosing(entry);
      })) {
    reasonCodes.push("cost_stress_unstable");
  }
  for (const lane of config.signalLanes) {
    const candidateCosts = candidateScenarios.filter((entry) => entry.signalLane === lane
      && entry.parameterMultiplier === 1 && entry.ablation === "none" && entry.status === "completed")
      .sort((left, right) => left.costMultiplier - right.costMultiplier);
    let previousNet = null;
    for (const scenario of candidateCosts) {
      const net = finiteMetric(scenario.oos?.metrics?.netPnlCny);
      if (net !== null && previousNet !== null && net > previousNet + 1e-8) {
        reasonCodes.push("cost_stress_non_monotonic");
      }
      if (net !== null) previousNet = net;
      if (scenario.costMultiplier <= 1) continue;
      const control = scenarios.find((entry) => entry.strategyId === "control"
        && entry.signalLane === lane && entry.costMultiplier === scenario.costMultiplier
        && entry.parameterMultiplier === 1 && entry.ablation === "none" && entry.status === "completed");
      const controlNet = finiteMetric(control?.oos?.metrics?.netPnlCny);
      if (!control || controlNet === null) reasonCodes.push("cost_stress_control_missing");
      else if (!scenarioValidationEvidenceComplete(control)) reasonCodes.push("cost_stress_control_not_validated");
      else if (scenario.datasetId === null || scenario.datasetId !== control.datasetId) reasonCodes.push("dataset_basis_mismatch");
      else if (scenario.fillPolicy !== control.fillPolicy || scenario.ambiguityPolicy !== control.ambiguityPolicy
        || scenario.executionVersion !== control.executionVersion) reasonCodes.push("execution_basis_mismatch");
      else if (!foldComparison(scenario, control).aligned) reasonCodes.push("fold_windows_misaligned");
      else if (!foldComparison(scenario, control).dominates) reasonCodes.push("per_fold_cost_stress_failed");
      else if (net === null || net <= controlNet) reasonCodes.push("cost_stress_not_better_than_control");
    }
  }
  const ablations = candidateScenarios.filter((entry) => entry.ablation !== "none"
    && entry.costMultiplier === 1 && entry.parameterMultiplier === 1);
  if (config.ablations.includes("without-regime-filter") && config.orb?.requireTrendRegime !== true) {
    reasonCodes.push("ablation_not_applicable");
  }
  if (config.ablations.length > 1 && ablations.length !== config.signalLanes.length * (config.ablations.length - 1)) {
    reasonCodes.push("ablation_matrix_incomplete");
  }
  for (const scenario of ablations) {
    const baseline = baselineScenario(scenarios, strategyId, scenario.signalLane);
    const baselineNet = finiteMetric(baseline?.oos?.metrics?.netPnlCny);
    const variantNet = finiteMetric(scenario.oos?.metrics?.netPnlCny);
    const baselineDrawdown = finiteMetric(baseline?.oos?.metrics?.maxDrawdownCny);
    const variantDrawdown = finiteMetric(scenario.oos?.metrics?.maxDrawdownCny);
    if (scenario.status !== "completed" || !scenarioValidationEvidenceComplete(scenario)
      || baselineNet === null || variantNet === null || baselineDrawdown === null || variantDrawdown === null) {
      reasonCodes.push("ablation_oos_not_validated");
    } else if (!foldComparison(baseline, scenario).aligned) {
      reasonCodes.push("fold_windows_misaligned");
    } else if (!foldComparison(baseline, scenario).dominates
      || baselineNet + 1e-8 < variantNet || baselineDrawdown > variantDrawdown + 1e-8) {
      reasonCodes.push("ablation_not_supportive");
    } else if (Math.abs(baselineNet - variantNet) <= 1e-8
      && Math.abs(baselineDrawdown - variantDrawdown) <= 1e-8) {
      reasonCodes.push("ablation_no_observed_contribution");
    }
  }
  const sensitivity = candidateScenarios.filter((entry) => entry.parameterMultiplier !== 1
    && entry.costMultiplier === 1 && entry.ablation === "none");
  if (config.parameterMultipliers.length > 1
      && (sensitivity.length !== config.signalLanes.length * (config.parameterMultipliers.length - 1)
        || sensitivity.some((entry) => entry.status !== "completed"))) {
    reasonCodes.push("parameter_sensitivity_incomplete");
  }
  for (const scenario of sensitivity) {
    const baseline = baselineScenario(scenarios, strategyId, scenario.signalLane);
    const net = finiteMetric(scenario.oos?.metrics?.netPnlCny);
    const drawdown = finiteMetric(scenario.oos?.metrics?.maxDrawdownCny);
    const baselineDrawdown = finiteMetric(baseline?.oos?.metrics?.maxDrawdownCny);
    if (net === null || net < 0 || !everyFoldNonLosing(scenario)
      || drawdown === null || baselineDrawdown === null
      || drawdown > Math.max(1, baselineDrawdown * 2)) {
      reasonCodes.push("parameter_sensitivity_unstable");
    }
  }
  const factorFingerprints = new Set(candidateScenarios
    .map((entry) => entry.factorFingerprint)
    .filter((value) => typeof value === "string" && value && value !== "unknown"));
  if (candidateScenarios.some((entry) => entry.factorFingerprint === "unknown") || factorFingerprints.size > 1) {
    reasonCodes.push("factor_evidence_missing");
  }
  const unique = [...new Set(reasonCodes)];
  return {
    strategyId,
    status: unique.length === 0 ? "eligible_to_apply" : "not_eligible",
    eligible: unique.length === 0,
    reasonCodes: unique,
    policyVersion: STRATEGY_PROMOTION_POLICY_VERSION,
    requirements: {
      requiredMatrix: structuredClone(STRATEGY_PROMOTION_REQUIRED_MATRIX),
      comparisonBasis: "aligned_completed_oos_folds",
      walkForwardOnly: true,
      everyScenarioValidated: true,
      perFoldControlDominance: true,
      perFoldBenchmarkDominance: true,
      perFoldStressNonNegative: true,
      costNetNonNegative: true,
      costNetNonIncreasing: true,
      costCandidateBeatsControl: true,
      parameterNetNonNegative: true,
      parameterDrawdownMaxBaselineMultiple: 2,
      ablationFullModelOosDominates: true,
      pointInTimeFactorBasisRequired: true,
    },
  };
}

export async function runStrategyExperiment(input = {}) {
  if (typeof input.executeScenario !== "function") throw new TypeError("executeScenario is required");
  const config = normalizeStrategyExperimentConfig(input.config);
  const catalog = Array.isArray(input.strategyCatalog) ? structuredClone(input.strategyCatalog) : [];
  const scenarios = expandStrategyExperimentScenarios(config, catalog);
  const results = [];
  const diagnostics = [];
  for (const scenario of scenarios) {
    if (input.signal?.aborted) throw abortError(input.signal.reason);
    if (scenario.preflightStatus !== "ready") {
      results.push(summarizeScenario(scenario, {
        ok: false,
        status: "unavailable",
        reasonCodes: [scenario.preflightStatus],
        diagnostics: [{ code: scenario.preflightStatus }],
      }));
      continue;
    }
    try {
      const result = await input.executeScenario(structuredClone(scenario), {
        config: structuredClone(config),
        asOf: input.asOf,
        days: input.days,
        mode: input.mode,
        signal: input.signal,
        runContext: input.runContext,
      });
      if (input.signal?.aborted) throw abortError(input.signal.reason);
      const summary = summarizeScenario(scenario, result, {
        asOf: input.asOf,
        mode: input.mode,
        days: input.days,
        fullConfig: input.runContext?.fullConfig,
      });
      results.push(summary);
      if (summary.status === "failed") {
        diagnostics.push({
          scenarioId: scenario.scenarioId,
          code: summary.reasonCodes?.[0] ?? "scenario_failed",
          details: structuredClone(summary.diagnostics ?? []),
        });
      }
    } catch (error) {
      if (error?.name === "AbortError") throw error;
      const machineCode = String(error?.code ?? "scenario_failed");
      const summary = summarizeScenario(scenario, {
        ok: false,
        status: "failed",
        reasonCodes: ["scenario_failed"],
        diagnostics: [{ code: machineCode, message: String(error?.message ?? error).slice(0, 300) }],
      });
      results.push(summary);
      diagnostics.push({ scenarioId: scenario.scenarioId, code: machineCode });
    }
  }
  if (input.signal?.aborted) throw abortError(input.signal.reason);
  const controlStrategyId = input.controlStrategyId ?? "control";
  const comparisons = buildComparisons(results, controlStrategyId);
  const datasetRefs = Object.fromEntries(config.signalLanes.map((lane) => {
    const laneScenarios = results.filter((entry) => entry.signalLane === lane && entry.status === "completed");
    return [lane, {
      datasetIds: [...new Set(laneScenarios.map((entry) => entry.datasetId).filter(Boolean))].sort(),
      contentFingerprints: [...new Set(laneScenarios.map((entry) => entry.datasetFingerprint).filter(Boolean))].sort(),
      inputFingerprints: [...new Set(laneScenarios.map((entry) => entry.datasetAudit?.inputFingerprint).filter(Boolean))].sort(),
      sourceVersions: [...new Set(laneScenarios.map((entry) => entry.datasetAudit?.sourceVersion).filter(Boolean))].sort(),
      dataSchemaVersions: [...new Set(laneScenarios.map((entry) => entry.datasetAudit?.dataSchemaVersion).filter(Boolean))].sort(),
      calendarVersions: [...new Set(laneScenarios.map((entry) => entry.datasetAudit?.calendarVersion).filter(Boolean))].sort(),
    }];
  }));
  const candidateIds = config.enabledStrategyIds.filter((strategyId) => strategyId !== controlStrategyId);
  const promotionCandidates = candidateIds.map((strategyId) => candidatePromotion(
    strategyId, config, results, comparisons, input.mode,
  ));
  return projectStrategyExperimentReport({
    generatedAt: input.generatedAt ?? Date.now(),
    asOf: input.asOf,
    controlStrategyId,
    run: {
      days: Math.min(30, Math.max(1, Math.floor(Number(input.days) || 1))),
      mode: input.mode === "walk-forward" ? "walk-forward" : "diagnostic",
    },
    config,
    strategyCatalog: catalog,
    datasetRefs: input.datasetRefs ?? datasetRefs,
    scenarios: results,
    comparisons,
    ablations: buildAblations(results),
    sensitivity: buildSensitivity(results),
    oos: Object.fromEntries(results.filter((entry) => entry.status === "completed")
      .map((entry) => [entry.scenarioId, entry.oos])),
    promotion: {
      version: STRATEGY_PROMOTION_POLICY_VERSION,
      status: promotionCandidates.length > 0 && promotionCandidates.every((entry) => entry.eligible)
        ? "eligible_to_apply" : "not_eligible",
      eligible: promotionCandidates.length > 0 && promotionCandidates.every((entry) => entry.eligible),
      candidates: promotionCandidates,
      liveStrategyChanged: false,
    },
    benchmarkCapabilities: STRATEGY_BENCHMARK_CAPABILITIES,
    provenance: {
      runnerVersion: STRATEGY_EXPERIMENT_RUNNER_VERSION,
      strategyInterfaceVersion: input.strategyInterfaceVersion ?? null,
      executionInstrument: "CMB_ACCUMULATED_GOLD",
      basisFingerprint: input.basisFingerprint ?? null,
      basis: input.basis ?? null,
      requestFingerprint: canonicalSha256({
        asOf: input.asOf,
        days: Math.min(30, Math.max(1, Math.floor(Number(input.days) || 1))),
        mode: input.mode === "walk-forward" ? "walk-forward" : "diagnostic",
        config,
      }),
    },
    diagnostics,
  });
}

/** Stateful host adapter around the pure experiment runner and one latest-report file. */
export function createStrategyExperimentEngine({
  getConfig,
  listStrategies,
  executeScenario,
  file = null,
  writeQueue = null,
  logger = null,
} = {}) {
  if (typeof getConfig !== "function") throw new TypeError("getConfig is required");
  if (typeof listStrategies !== "function") throw new TypeError("listStrategies is required");
  if (typeof executeScenario !== "function") throw new TypeError("executeScenario is required");
  let latest = null;
  let latestPersistence = null;
  let running = null;
  let currentController = null;
  let currentBasisCache = null;
  let disposed = false;

  async function run(request = {}) {
    if (disposed) {
      const error = new Error("strategy experiment engine is disposed");
      error.code = "STRATEGY_EXPERIMENTS_UNAVAILABLE";
      throw error;
    }
    const fullConfig = freezeTree(structuredClone(getConfig()));
    const storedConfig = normalizeStrategyExperimentConfig(fullConfig?.experiments);
    const strategyCatalog = freezeTree(structuredClone(listStrategies({
      enabledStrategyIds: storedConfig.enabledStrategyIds,
    })));
    const registeredStrategyIds = new Set(strategyCatalog.map((entry) => entry?.strategyId));
    if (storedConfig.enabled !== true) {
      const error = new Error("strategy experiments are disabled");
      error.code = "EXPERIMENTS_DISABLED";
      throw error;
    }
    const requestedStrategies = request.strategyIds === undefined
      ? storedConfig.enabledStrategyIds
      : requestList(request.strategyIds, {
        field: "strategyIds",
        code: "BAD_EXPERIMENT_STRATEGY_IDS",
        maximum: 8,
      });
    const requestedLanes = request.signalLanes === undefined
      ? storedConfig.signalLanes
      : requestList(request.signalLanes, {
        field: "signalLanes",
        code: "BAD_EXPERIMENT_SIGNAL_LANES",
        allowed: STRATEGY_EXPERIMENT_LANES,
        maximum: 3,
      });
    if (request.strategyIds !== undefined && requestedStrategies.length === 0) {
      const error = new RangeError("strategyIds must not be empty");
      error.code = "BAD_EXPERIMENT_STRATEGY_IDS";
      throw error;
    }
    if (request.signalLanes !== undefined && requestedLanes.length === 0) {
      const error = new RangeError("signalLanes must not be empty");
      error.code = "BAD_EXPERIMENT_SIGNAL_LANES";
      throw error;
    }
    if (requestedStrategies.some((id) => !registeredStrategyIds.has(id))) {
      const error = new Error("requested strategy is not registered");
      error.code = "UNKNOWN_STRATEGY";
      throw error;
    }
    if (requestedStrategies.some((id) => !storedConfig.enabledStrategyIds.includes(id))) {
      const error = new Error("requested strategy is not enabled");
      error.code = "STRATEGY_DISABLED";
      throw error;
    }
    if (requestedLanes.some((lane) => !storedConfig.signalLanes.includes(lane))) {
      const error = new Error("requested signal lane is not enabled");
      error.code = "EXPERIMENT_LANE_DISABLED";
      throw error;
    }
    const effectiveConfig = {
      ...storedConfig,
      enabledStrategyIds: requestedStrategies,
      signalLanes: requestedLanes,
    };
    const requestedMode = request.mode === undefined ? "diagnostic" : request.mode;
    if (requestedMode !== "diagnostic" && requestedMode !== "walk-forward") {
      const error = new RangeError(`unsupported experiment mode: ${String(request.mode)}`);
      error.code = "BAD_EXPERIMENT_MODE";
      throw error;
    }
    const requestedDays = request.days === undefined ? 1 : request.days;
    if (typeof requestedDays !== "number" || !Number.isInteger(requestedDays) || requestedDays < 1 || requestedDays > 30) {
      const error = new RangeError("experiment days must be an integer between 1 and 30");
      error.code = "BAD_EXPERIMENT_DAYS";
      throw error;
    }
    const canonicalAsOf = typeof request.asOf === "string"
      && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(request.asOf);
    const parsedAsOf = canonicalAsOf ? Date.parse(request.asOf) : NaN;
    const asOfMs = request.asOf === undefined
      ? Date.now()
      : Number.isFinite(parsedAsOf) && new Date(parsedAsOf).toISOString() === request.asOf ? parsedAsOf : NaN;
    if (!Number.isFinite(asOfMs) || asOfMs > Date.now() + 1000) {
      const error = new RangeError("experiment asOf must be a valid non-future timestamp");
      error.code = "BAD_EXPERIMENT_AS_OF";
      throw error;
    }
    if (running) {
      const error = new Error("a strategy experiment is already running");
      error.code = "EXPERIMENT_ALREADY_RUNNING";
      throw error;
    }
    const controller = new AbortController();
    const onExternalAbort = () => controller.abort(request.signal?.reason);
    if (request.signal?.aborted) onExternalAbort();
    else request.signal?.addEventListener?.("abort", onExternalAbort, { once: true });
    currentController = controller;
    const basisCache = new Map();
    currentBasisCache = basisCache;
    const basisSnapshot = strategyExperimentBasis(fullConfig, strategyCatalog);
    const task = runStrategyExperiment({
      config: effectiveConfig,
      strategyCatalog,
      basisFingerprint: basisSnapshot.basisFingerprint,
      basis: basisSnapshot.basis,
      executeScenario,
      asOf: new Date(asOfMs).toISOString(),
      days: requestedDays,
      mode: requestedMode,
      signal: controller.signal,
      runContext: {
        fullConfig,
        basisCache,
      },
    }).then(async (report) => {
      if (controller.signal.aborted) throw abortError(controller.signal.reason);
      const validatedReport = validateStrategyExperimentReport(report);
      let persisted = false;
      let persistenceError = null;
      if (file) {
        try {
          await writeJsonAtomic(file, { report: validatedReport }, writeQueue);
          persisted = true;
        } catch (error) {
          persistenceError = { code: error?.code ?? "EXPERIMENT_PERSIST_FAILED", message: String(error?.message ?? error) };
          logger?.warn?.(`dsh-plugin-goldboard: strategy experiment persist failed: ${persistenceError.message}`);
        }
      }
      if (controller.signal.aborted && persisted !== true) throw abortError(controller.signal.reason);
      latest = validatedReport;
      latestPersistence = { persisted, persistenceError };
      return { ok: true, report: validatedReport, persisted, persistenceError };
    }).finally(() => {
      request.signal?.removeEventListener?.("abort", onExternalAbort);
      if (running === task) running = null;
      if (currentController === controller) currentController = null;
      if (currentBasisCache === basisCache) currentBasisCache = null;
    });
    running = task;
    return task;
  }

  async function last() {
    if (latest) return {
      ok: true,
      report: structuredClone(latest),
      persisted: latestPersistence?.persisted === true,
      persistenceError: latestPersistence?.persistenceError ? structuredClone(latestPersistence.persistenceError) : null,
    };
    if (!file) return { ok: true, report: null };
    const saved = await readJson(file, null);
    if (!saved?.report) return { ok: true, report: null };
    try {
      latest = validateStrategyExperimentReport(saved.report);
      latestPersistence = { persisted: true, persistenceError: null };
      return { ok: true, report: structuredClone(latest), persisted: true, persistenceError: null };
    } catch (error) {
      logger?.warn?.(`dsh-plugin-goldboard: invalid persisted strategy experiment ignored: ${String(error?.message ?? error)}`);
      return { ok: true, report: null };
    }
  }

  function catalog() {
    const fullConfig = getConfig();
    const config = normalizeStrategyExperimentConfig(fullConfig?.experiments);
    const strategies = listStrategies({ enabledStrategyIds: config.enabledStrategyIds });
    return { ok: true, config, strategies, ...strategyExperimentBasis(fullConfig, strategies) };
  }

  async function dispose() {
    if (disposed) return;
    disposed = true;
    const basisCache = currentBasisCache;
    currentController?.abort(new Error("strategy experiment engine disposed"));
    if (running) await running.catch(() => {});
    const pendingBasisTasks = basisCache instanceof Map ? [...basisCache.values()] : [];
    if (pendingBasisTasks.length > 0) await Promise.allSettled(pendingBasisTasks);
  }

  return { run, last, catalog, dispose };
}
