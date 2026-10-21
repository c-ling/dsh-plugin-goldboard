export const STRATEGY_EXPERIMENT_CONFIG_VERSION = "goldboard-strategy-experiment-config-v1";
export const STRATEGY_EXPERIMENT_LANES = Object.freeze(["cmb", "au9999", "xau"]);
export const STRATEGY_EXPERIMENT_ABLATIONS = Object.freeze(["none", "without-regime-filter"]);

export const DEFAULT_STRATEGY_EXPERIMENT_CONFIG = Object.freeze({
  version: STRATEGY_EXPERIMENT_CONFIG_VERSION,
  enabled: false,
  enabledStrategyIds: Object.freeze(["control"]),
  signalLanes: Object.freeze(["cmb"]),
  costMultipliers: Object.freeze([1, 2]),
  parameterMultipliers: Object.freeze([0.8, 1, 1.2]),
  ablations: Object.freeze(["none", "without-regime-filter"]),
  maxScenarios: 48,
  orb: Object.freeze({
    openingRangeBars: 6,
    breakoutAtrBuffer: 0.1,
    pullbackAtrTolerance: 0.35,
    setupExpiryBars: 12,
    orderValidityBars: 3,
    stopAtrMultiplier: 0.75,
    targetAtrMultiplier: 1.5,
    grams: 1,
    requireTrendRegime: true,
    requiredFactorIds: Object.freeze([]),
    factorMaxAgeMs: 24 * 60 * 60_000,
  }),
});

const KEBAB_ID = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

function bool(value, fallback) {
  return typeof value === "boolean" ? value : fallback;
}

function boundedNumber(value, fallback, min, max) {
  const number = Number(value);
  return Number.isFinite(number) ? Math.min(max, Math.max(min, number)) : fallback;
}

function boundedInteger(value, fallback, min, max) {
  return Math.floor(boundedNumber(value, fallback, min, max));
}

export function normalizeExperimentIdList(value, { allowed = null, fallback = [], maximum = 16 } = {}) {
  if (!Array.isArray(value)) return [...fallback];
  const output = [];
  for (const entry of value) {
    const text = String(entry ?? "");
    if (!KEBAB_ID.test(text)) continue;
    if (allowed && !allowed.includes(text)) continue;
    if (!output.includes(text)) output.push(text);
    if (output.length >= maximum) break;
  }
  return output;
}

function numberList(value, fallback, min, max, maximum = 8) {
  if (!Array.isArray(value)) return [...fallback];
  const output = [];
  for (const entry of value) {
    const number = Number(entry);
    if (!Number.isFinite(number) || number < min || number > max) continue;
    const normalized = Math.round(number * 100) / 100;
    if (!output.includes(normalized)) output.push(normalized);
    if (output.length >= maximum) break;
  }
  return output.sort((left, right) => left - right);
}

function ensureBaseline(values, baseline) {
  return values.includes(baseline) ? values : [baseline, ...values].sort((left, right) => left - right);
}

function factorRequirementStatus(value) {
  if (value === undefined) return { valid: true, ids: [], errors: [] };
  const errors = [];
  if (!Array.isArray(value)) return { valid: false, ids: [], errors: ["required_factor_ids_not_array"] };
  if (value.length > 16) errors.push("required_factor_ids_overflow");
  const ids = [];
  for (const entry of value) {
    if (typeof entry !== "string" || !KEBAB_ID.test(entry)) {
      errors.push("invalid_required_factor_id");
      continue;
    }
    if (ids.includes(entry)) errors.push("duplicate_required_factor_id");
    else ids.push(entry);
  }
  return { valid: errors.length === 0, ids: errors.length === 0 ? ids : [], errors: [...new Set(errors)] };
}

export function normalizeStrategyExperimentConfig(value = {}) {
  const input = value && typeof value === "object" && !Array.isArray(value) ? value : {};
  const versionMissing = !Object.hasOwn(input, "version");
  const explicitVersion = versionMissing ? undefined : input.version;
  const source = versionMissing || explicitVersion === STRATEGY_EXPERIMENT_CONFIG_VERSION ? input : {};
  const orb = source.orb && typeof source.orb === "object" && !Array.isArray(source.orb) ? source.orb : {};
  const factorRequirements = factorRequirementStatus(orb.requiredFactorIds);
  const enabledStrategyIds = normalizeExperimentIdList(source.enabledStrategyIds, {
    fallback: DEFAULT_STRATEGY_EXPERIMENT_CONFIG.enabledStrategyIds,
    maximum: 8,
  });
  const signalLanes = normalizeExperimentIdList(source.signalLanes, {
    allowed: STRATEGY_EXPERIMENT_LANES,
    fallback: DEFAULT_STRATEGY_EXPERIMENT_CONFIG.signalLanes,
    maximum: 3,
  });
  const ablations = normalizeExperimentIdList(source.ablations, {
    allowed: STRATEGY_EXPERIMENT_ABLATIONS,
    fallback: DEFAULT_STRATEGY_EXPERIMENT_CONFIG.ablations,
    maximum: 4,
  });
  return {
    version: STRATEGY_EXPERIMENT_CONFIG_VERSION,
    enabled: bool(source.enabled, DEFAULT_STRATEGY_EXPERIMENT_CONFIG.enabled) && factorRequirements.valid,
    enabledStrategyIds: ["control", ...enabledStrategyIds.filter((strategyId) => strategyId !== "control")],
    signalLanes: signalLanes.length > 0 ? signalLanes : ["cmb"],
    costMultipliers: ensureBaseline(numberList(source.costMultipliers, DEFAULT_STRATEGY_EXPERIMENT_CONFIG.costMultipliers, 1, 5, 5), 1),
    parameterMultipliers: ensureBaseline(numberList(source.parameterMultipliers, DEFAULT_STRATEGY_EXPERIMENT_CONFIG.parameterMultipliers, 0.5, 2, 5), 1),
    ablations: ablations.includes("none") ? ablations : ["none", ...ablations],
    maxScenarios: boundedInteger(source.maxScenarios, DEFAULT_STRATEGY_EXPERIMENT_CONFIG.maxScenarios, 1, 96),
    orb: {
      openingRangeBars: boundedInteger(orb.openingRangeBars, DEFAULT_STRATEGY_EXPERIMENT_CONFIG.orb.openingRangeBars, 2, 24),
      breakoutAtrBuffer: boundedNumber(orb.breakoutAtrBuffer, DEFAULT_STRATEGY_EXPERIMENT_CONFIG.orb.breakoutAtrBuffer, 0, 5),
      pullbackAtrTolerance: boundedNumber(orb.pullbackAtrTolerance, DEFAULT_STRATEGY_EXPERIMENT_CONFIG.orb.pullbackAtrTolerance, 0, 5),
      setupExpiryBars: boundedInteger(orb.setupExpiryBars, DEFAULT_STRATEGY_EXPERIMENT_CONFIG.orb.setupExpiryBars, 1, 144),
      orderValidityBars: boundedInteger(orb.orderValidityBars, DEFAULT_STRATEGY_EXPERIMENT_CONFIG.orb.orderValidityBars, 1, 24),
      stopAtrMultiplier: boundedNumber(orb.stopAtrMultiplier, DEFAULT_STRATEGY_EXPERIMENT_CONFIG.orb.stopAtrMultiplier, 0.1, 10),
      targetAtrMultiplier: boundedNumber(orb.targetAtrMultiplier, DEFAULT_STRATEGY_EXPERIMENT_CONFIG.orb.targetAtrMultiplier, 0.1, 20),
      grams: boundedNumber(orb.grams, DEFAULT_STRATEGY_EXPERIMENT_CONFIG.orb.grams, 0.01, 100_000),
      requireTrendRegime: bool(orb.requireTrendRegime, DEFAULT_STRATEGY_EXPERIMENT_CONFIG.orb.requireTrendRegime),
      requiredFactorIds: factorRequirements.ids,
      factorMaxAgeMs: boundedInteger(orb.factorMaxAgeMs, DEFAULT_STRATEGY_EXPERIMENT_CONFIG.orb.factorMaxAgeMs, 1, 365 * 24 * 60 * 60_000),
    },
  };
}
