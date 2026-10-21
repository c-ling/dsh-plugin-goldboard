export {
  STRATEGY_INTERFACE_VERSION,
  STRATEGY_LANES,
  STRATEGY_ROLES,
  STRATEGY_SIGNAL_SEMANTICS,
  createStrategyAdapter,
  defineStrategyDescriptor,
  isStrategyAdapter,
  normalizeStrategyEvaluation,
  strategyIdentity,
} from "./strategy-contract.js";

export {
  STRATEGY_REGISTRY_VERSION,
  StrategyRegistry,
  createStrategyRegistry,
} from "./strategy-registry.js";

export {
  CONTROL_STRATEGY_DESCRIPTOR,
  createControlStrategy,
} from "./strategy-control.js";

export {
  DEFAULT_ORB_STRATEGY_PARAMETERS,
  ORB_STRATEGY_DESCRIPTOR,
  ORB_STRATEGY_PARAMETER_VERSION,
  ORB_STRATEGY_STATE_VERSION,
  createOrbTrendPullbackStrategy,
  normalizeOrbStrategyParameters,
} from "./strategy-orb.js";

import { CONTROL_STRATEGY_DESCRIPTOR, createControlStrategy } from "./strategy-control.js";
import { ORB_STRATEGY_DESCRIPTOR, createOrbTrendPullbackStrategy } from "./strategy-orb.js";
import { createStrategyRegistry } from "./strategy-registry.js";

/** Built-in registry; factories remain private and receive per-run createOptions. */
export function createBuiltinStrategyRegistry() {
  return createStrategyRegistry([
    {
      descriptor: CONTROL_STRATEGY_DESCRIPTOR,
      factory: (options) => createControlStrategy(options),
    },
    {
      descriptor: ORB_STRATEGY_DESCRIPTOR,
      factory: (options) => createOrbTrendPullbackStrategy(options),
    },
  ]);
}
