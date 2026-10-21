/** Stable host-side domain API. Test hooks and implementation helpers live in ./testing. */

export {
  CALCULATION_VERSION,
  EXECUTION_EVIDENCE_MODES,
  MARKET_DATA_SCHEMA_VERSION,
  MarketDataContract,
  assessMarketQuality,
  closedBars,
  inspectBars,
  inspectQuoteDependency,
  isBarClosed,
  normalizeBarRecord,
  normalizeQuoteRecord,
} from "./market-quality.js";

export {
  CALENDAR_VERSIONS,
  calendarVersionForInstrument,
  computeInstrumentMarketState,
  filterBarsToMarketHours,
  getTradingCalendar,
  inspectWindowCoverage,
  isInstrumentOpen,
  tradingDayForTimestamp,
} from "./market-time.js";

export {
  TROY_OUNCE_GRAMS,
  hasCmbFallback,
  inspectXauConversion,
  xauCnyPerGram,
} from "./sizing.js";

export {
  EXECUTION_ASK_UNAVAILABLE,
  EXECUTION_BID_UNAVAILABLE,
  EXECUTION_EVIDENCE,
  EXECUTION_MODEL_VERSION,
  EXECUTION_QUOTE_INVERTED,
  EXECUTION_QUOTE_UNAVAILABLE,
  ExecutionModel,
  accountExecution,
  createExecutionModel,
  resolveExecutionBar,
  resolveExecutionQuote,
  valuePosition,
} from "./execution.js";

export { HistoricalStore, historicalQuoteEventId } from "./historical-store.js";
export {
  RISK_CONFIG_VERSION,
  RISK_POLICY_VERSION,
  RiskPolicy,
  createRiskPolicy,
  evaluateBuyRisk,
  inspectRiskGate,
} from "./risk.js";
export {
  TARGET_TRAIL_EVENTS,
  TARGET_TRAIL_VERSION,
  advanceTargetTrail,
  normalizeTargetTrail,
} from "./target-trail.js";
export {
  SIGNAL_LEDGER_SCHEMA_VERSION,
  SIGNAL_LEDGER_VERSION,
  createSignalLedger,
  normalizeSignalLedger,
  projectSignalLedger,
  reconcileLedgerPosition,
  recordLedgerDecision,
  summarizeSignalLedger,
} from "./signal-ledger.js";
export { DEFAULT_CONFIG, normalizeConfig } from "./config.js";
export { replayMarketPlan } from "./snapshot.js";
export {
  REPLAY_AMBIGUITY_POLICIES,
  REPLAY_BENCHMARK_IDS,
  REPLAY_DATASET_VERSION,
  REPLAY_FILL_POLICIES,
  REPLAY_EVALUATION_TRACE_LIMIT,
  REPLAY_REPORT_SCHEMA,
  REPLAY_REPORT_SCHEMA_VERSION,
  REPLAY_SIMULATOR_VERSION,
  WALK_FORWARD_REGISTRY_VERSION,
  ReplayReportStore,
  ReplaySimulator,
  buildReplayDataset,
  buildReplayDatasetFromBars,
  buildReplayDatasetFromStore,
  completeWalkForwardRegistry,
  computeReplayMetrics,
  createReplayReportStore,
  createReplaySimulator,
  createWalkForwardRegistry,
  evaluateReplayValidationGate,
  projectReplayBenchmarks,
  projectReplayReport,
  runWalkForward,
  selectWalkForwardTestFrames,
} from "./replay.js";

export {
  STRATEGY_INTERFACE_VERSION,
  STRATEGY_REGISTRY_VERSION,
  CONTROL_STRATEGY_DESCRIPTOR,
  ORB_STRATEGY_DESCRIPTOR,
  StrategyRegistry,
  createBuiltinStrategyRegistry,
  createControlStrategy,
  createOrbTrendPullbackStrategy,
  createStrategyAdapter,
  createStrategyRegistry,
  defineStrategyDescriptor,
  isStrategyAdapter,
  normalizeStrategyEvaluation,
  strategyIdentity,
} from "./strategy.js";

export {
  STRATEGY_EXPERIMENT_CONFIG_VERSION,
  STRATEGY_EXPERIMENT_REPORT_SCHEMA,
  STRATEGY_EXPERIMENT_REPORT_VERSION,
  STRATEGY_EXPERIMENT_RUNNER_VERSION,
  STRATEGY_PROMOTION_POLICY_VERSION,
  createStrategyExperimentEngine,
  expandStrategyExperimentScenarios,
  normalizeStrategyExperimentConfig,
  projectStrategyExperimentReport,
  runStrategyExperiment,
  validateStrategyExperimentReport,
} from "./experiments.js";

export {
  FACTOR_SCHEMA_VERSION,
  MARKET_REGIME_VERSION,
  classifyMarketRegime,
  evaluateRequiredFactors,
  normalizeFactorRecord,
  selectFactorVintage,
} from "./factors.js";
