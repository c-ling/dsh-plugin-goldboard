import { createStrategyAdapter, defineStrategyDescriptor } from "./strategy-contract.js";

export const CONTROL_STRATEGY_DESCRIPTOR = defineStrategyDescriptor({
  strategyId: "control",
  strategyVersion: "goldboard-control-v1",
  role: "control",
  lanes: ["cmb", "xau", "au9999"],
  executionInstrument: "CMB_ACCUMULATED_GOLD",
  signalSemantics: "state_condition",
  parameterSchemaVersion: "goldboard-control-params-v1",
  requiredFeatures: ["ema20", "rsi14", "bollinger", "atr14"],
  ablations: [],
});

export function createControlStrategy({ evaluate, adapterFingerprint } = {}) {
  return createStrategyAdapter({
    descriptor: CONTROL_STRATEGY_DESCRIPTOR,
    evaluate,
    adapterFingerprint,
  });
}
