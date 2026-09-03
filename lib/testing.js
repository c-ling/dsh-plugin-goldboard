// Internal compatibility surface for repository tests and plugin integrators.
// None of these helpers are part of the stable root API.
export * from "./market-data.js";
export * from "./market-time.js";
export * from "./market-quality.js";
export * from "./config.js";
export * from "./indicators.js";
export * from "./shared.js";
export * from "./sources.js";
export * from "./bars.js";
export * from "./spread-stats.js";
export * from "./sizing.js";
export * from "./plan.js";
export * from "./snapshot.js";
export * from "./routes.js";
export * from "./execution.js";
export * from "./historical-store.js";
export * from "./replay-stats.js";
export { apply, inject, name } from "./index.js";
export {
  ApiLogStore,
  STATE_MIGRATION_VERSION,
  STATE_SCHEMA_VERSION,
  StatePersister,
  dshHome,
  loadStateWithMigration,
  makeWriteQueue,
  migratePersistedState,
  pluginDir,
  readApiLogsFromFile,
  readJson,
  restoreRuntimeState,
  rollbackStateMigration,
  rotateApiLogIfNeeded,
  writeJsonAtomic,
} from "./store.js";
export {
  ACTION_LABELS_EN,
  ACTION_LABELS_ZH,
  ALERT_LOG_CAP,
  ORDER_UPDATE_ESCALATION_DELTA_PER_GRAM,
  ORDER_UPDATE_MIN_DELTA_PER_GRAM,
  ORDER_UPDATE_MIN_INTERVAL_MS,
  SELL_ACTIONS,
  buildAlertMessage,
  buildLaneSwitchMessage,
  buildOrderChangeMessage,
  buildOrderDriftNote,
  buildSpreadAlertMessage,
  classifyOrderTransition,
  dispatchAlert,
  mergeTestConfig,
  renderWebhookTemplate,
  runAlertEvaluation,
  sameSuggestedOrder,
  systemNotify,
} from "./alerts.js";
