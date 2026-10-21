/**
 * dsh-plugin-goldboard host half — composition root.
 *
 * Gold dashboard + intraday decision support for the DeepSeek Harness web GUI.
 * plan-05 split the old 5.7k-line monolith into focused modules (merged import
 * surface lives in public-api.js):
 *
 *   config.js       defaults / normalization / secrets / patch merge
 *   market-time.js  Beijing calendar, sessions, coverage windows
 *   indicators.js   SMA/EMA/RSI/ATR/MACD/Bollinger + resampling
 *   parsers.js      pure wire-format parsers per upstream source
 *   sources.js      SourceRegistry: transport, circuit breaker, api-log feed
 *   store.js        atomic JSON persistence, state persister, ApiLogStore
 *   bars.js         bar lifecycle (record/merge/aggregate/manual CMB ingestion)
 *   sizing.js       legacy position bands, order factory, signal policy
 *   risk.js         versioned risk budget, buy-only gates and constrained sizing
 *   signal-ledger.js durable setup/decision/order/position-adjustment lifecycle
 *   spread-stats.js dynamic CMB spread samples + premium σ statistics
 *   plan.js         lane stickiness + computePlan pipeline (4 stages)
 *   alerts.js       messages, channels, dispatchAlert, alert-edge evaluation
 *   snapshot.js     /snapshot wire view + deterministic replay
 *   routes.js       route() helper + /api path table
 *   connection-routes.js  Fetch <-> node:http adapter for 0.2.1 routes
 *   history.js      kline seeding / backfill jobs
 *   replay-stats.js v5 compatibility diagnostics + v6 orchestration
 *   replay-simulator.js deterministic order/fill/ledger/mark time advancement
 *   replay-dataset.js point-in-time dataset bars + immutable manifest
 *   walk-forward.js monthly frozen-parameter OOS fold registry
 *   replay-report.js v6 metrics, intervals, benchmarks and validation gate
 *   replay-store.js immutable bounded report registry
 *   strategy-*.js   versioned strategy contract/registry, control and ORB adapters
 *   factor-contract.js / market-regime.js point-in-time factors and regimes
 *   strategy-experiments.js / experiment-report.js isolated matrix reports
 *
 * This file only wires them: runtime creation, the 0.2.1 connection routes,
 * the tick loop and route registration. The plugin never places orders;
 * every suggestion is advisory only.
 */

import { chmod, mkdir } from "node:fs/promises";
import { join } from "node:path";

import { AnalysisModule, validateAnalysisConfig } from "./analysis.js";
import { AnalysisLogStore } from "./analysis-log.js";
import { mergeConfigPatch, normalizeConfig } from "./config.js";
import { createFetchRoutes } from "./connection-routes.js";
import { beijingDateForNow, computeMarketState, isInstrumentOpen, tradingDayForTimestamp } from "./market-time.js";
import { cleanCmbSpreadSamples, computePlan, hasCmbFallback } from "./plan.js";
import { PREMIUM_HISTORY_CAP } from "./spread-stats.js";
import { xauCnyPerGram } from "./sizing.js";
import { BARS_SEED_VERSION, ensureBars, recordTick } from "./bars.js";
import { MARKET_DATA_SCHEMA_VERSION, closedBars, isBarClosed, normalizeQuoteRecord } from "./market-quality.js";
import { resampleBars } from "./indicators.js";
import {
  STATE_SCHEMA_VERSION,
  ApiLogStore,
  StatePersister,
  loadStateWithMigration,
  makeWriteQueue,
  pluginDir,
  readJson,
  restoreRuntimeState,
  writeJsonAtomic,
} from "./store.js";
import { SourceRegistry, isDomesticQuoteFresh } from "./sources.js";
import { ALERT_LOG_CAP, classifyOrderTransition, dispatchAlert, runAlertEvaluation } from "./alerts.js";
import { defaultSignalState } from "./sizing.js";
import { inspectRiskGate } from "./risk.js";
import {
  createSignalLedger,
  projectSignalLedger,
  reconcileLedgerPosition,
  recordLedgerDecision,
  summarizeSignalLedger,
} from "./signal-ledger.js";
import { num } from "./shared.js";
import { analysisBarsView, buildSnapshot } from "./snapshot.js";
import { createRoutes } from "./routes.js";
import { createHistoryJobs } from "./history.js";
import { HistoricalStore } from "./historical-store.js";
import { createReplayStats, replayStrategyCatalog } from "./replay-stats.js";
import { ReplayReportStore } from "./replay-store.js";
import { createStrategyExperimentEngine } from "./strategy-experiments.js";

export * from "./public-api.js";

export const name = "dsh-plugin-goldboard";
export const inject = ["connection", "llm"];

// ── file names / wiring constants ───────────────────────────────────────────

const CONFIG_FILE = "config.json";
const STATE_FILE = "state.json";
const ALERTS_LOG_FILE = "alerts-log.json";
const API_LOG_FILE = "api-log.json";
const ANALYSIS_LOG_FILE = "analysis-log.jsonl";
const REPLAY_STATS_FILE = "replay-stats.json";
const REPLAY_REPORTS_DIR = "replay-reports";
const STRATEGY_EXPERIMENT_FILE = "strategy-experiment.json";
/** Poll cadence default + accepted bounds (10s…5min). */
const DEFAULT_POLL_MS = 30_000;
const MIN_POLL_MS = 10_000;
const MAX_POLL_MS = 300_000;

function createRuntime(config) {
  return {
    config: normalizeConfig(config),
    quotes: { AU9999: null, XAU: null, GCF: null, USDCNY: null, CMB: null },
    bars: { AU9999: ensureBars({}), XAU: ensureBars({}), GCF: ensureBars({}), CMB: ensureBars({}) },
    plan: null,
    alertState: {},
    signalState: defaultSignalState(),
    lastSuggestedOrder: null,
    signalLedger: createSignalLedger(),
    riskSummary: null,
    orderTransition: null,
    stateReady: false,
    // plan-03 state: lane stickiness, per-poll CMB health, dynamic spread
    // samples and the daily premium statistics window.
    laneState: { lane: null, pendingLane: null, pendingTicks: 0 },
    laneHealth: {},
    cmbSpreadSamples: [],
    premiumHistory: [],
    premiumDaySamples: { date: "", values: [] },
    spreadAlertDate: null,
    spreadCheck: null,
    localeHint: "zh",
    lastAlertLog: [],
    lastSnapshot: null,
    lastSnapshotBuiltAt: 0,
    lastAnalysis: null,
    ready: false,
    lastBackfillAt: 0,
    historicalStatus: null,
    lastHistoricalStatusAt: 0,
    ticking: false,
  };
}

export function apply(ctx, config = {}) {
  const logger = ctx.logger;
  const connection = ctx.connection;
  const writeQueue = makeWriteQueue();
  const stateDir = typeof config.directory === "string" && config.directory !== "" ? config.directory : pluginDir();
  const runtime = createRuntime(config);

  const configPath = join(stateDir, CONFIG_FILE);
  const statePath = join(stateDir, STATE_FILE);
  const alertsPath = join(stateDir, ALERTS_LOG_FILE);
  const analysisLogStore = new AnalysisLogStore({
    file: join(stateDir, ANALYSIS_LOG_FILE),
    maxEntries: runtime.config.analysis.maxLogEntries,
    logger,
  });
  // plan-05 P2#19: one registry/persister/log-store trio per plugin instance —
  // no module-level singletons are shared between applies any more.
  const apiLogStore = new ApiLogStore({ file: join(stateDir, API_LOG_FILE) });
  const registry = new SourceRegistry({ logStore: apiLogStore });
  const statePersister = new StatePersister({
    file: statePath,
    writeQueue,
    serialize: serializeState,
    logger,
  });
  const historicalStore = new HistoricalStore({
    directory: join(stateDir, "history"),
    dataSchemaVersion: MARKET_DATA_SCHEMA_VERSION,
    tradingDayForTimestamp: (timestamp) => tradingDayForTimestamp("CMB", timestamp, runtime.config),
    logger,
  });
  runtime.historicalStore = historicalStore;
  const replayReportStore = new ReplayReportStore({
    directory: join(stateDir, REPLAY_REPORTS_DIR),
    legacyLatestFile: join(stateDir, REPLAY_STATS_FILE),
    logger,
  });
  runtime.replayReportStore = replayReportStore;

  // Config revision: an in-memory fence for the page's single save bar.
  // GET /config returns it, POST /config accepts it as `expectedRevision`.
  let configRevision = 0;

  function getConfigRevision() {
    return configRevision;
  }

  function bumpConfigRevision() {
    configRevision += 1;
    return configRevision;
  }

  // plan-05 P2#24 adjudication: llm is a hard inject (the web profile always
  // provides it), so the old `ctx.llm ?? ctx.get?.("llm")` dual path is gone.
  const analysisModule = new AnalysisModule({
    llm: ctx.llm,
    getConfig: () => runtime.config,
    getContext: async () => {
      // Freeze analysis on the exact snapshot advertised by /snapshot. A later
      // market tick creates a new snapshot rather than silently changing asOf.
      if (!runtime.lastSnapshot) refreshSnapshot(new Date());
      const snapshot = runtime.lastSnapshot;
      const now = new Date(snapshot.serverTime);
      return {
        snapshot,
        bars: {
          AU9999: analysisBarsView(runtime, "AU9999", now),
          XAU: analysisBarsView(runtime, "XAU", now),
          GCF: analysisBarsView(runtime, "GCF", now),
          CMB: analysisBarsView(runtime, "CMB", now),
        },
      };
    },
    logStore: analysisLogStore,
    logger,
    onResult: (result) => {
      runtime.lastAnalysis = result;
    },
  });
  runtime.analysis = analysisModule;
  runtime.analysisLog = analysisLogStore;

  function refreshSnapshot(now = new Date()) {
    const snapshotRuntime = runtime.plan ? runtime : {
      ...runtime,
      laneState: { ...runtime.laneState },
      signalState: { ...runtime.signalState, lastBarT: { ...runtime.signalState.lastBarT } },
    };
    const snapshot = buildSnapshot(snapshotRuntime, runtime.config, now);
    snapshot.analysis = analysisModule.status();
    runtime.lastSnapshot = snapshot;
    runtime.lastSnapshotBuiltAt = Date.now();
    return snapshot;
  }

  function currentUnrealizedPnl() {
    const value = Number(runtime.plan?.position?.feeAdjustedPnl);
    return Number.isFinite(value) ? value : 0;
  }

  function reconcileRuntimePosition(previousPosition, nextPosition, now = new Date(), source = "runtime_observation", reconciliationConfig = runtime.config) {
    const result = reconcileLedgerPosition(runtime.signalLedger, {
      previousPosition,
      nextPosition,
      pendingOrder: runtime.lastSuggestedOrder,
      config: reconciliationConfig,
      asOf: now,
      source,
    });
    runtime.signalLedger = result.ledger;
    if (result.changed) statePersister.markDirty("other");
    const buyFill = result.effects.find((effect) => effect.type === "order_filled" && effect.side === "buy");
    if (buyFill) {
      runtime.signalState = {
        ...runtime.signalState,
        lastSide: "buy",
        lastAt: new Date(now).toISOString(),
        lastPositionGrams: Number(nextPosition?.grams) || 0,
        buyStreak: 0,
        sellStreak: 0,
        lastBarT: { buy: null, sell: null },
      };
    }
    return result;
  }

  function evaluateRuntimePlan(now = new Date(), options = {}) {
    if (options.record !== false) {
      reconcileRuntimePosition(runtime.config.position, runtime.config.position, now);
    }
    runtime.riskSummary = summarizeSignalLedger(runtime.signalLedger, {
      asOf: now,
      unrealizedPnlCny: currentUnrealizedPnl(),
    });
    runtime.plan = computePlan(runtime, runtime.config, now);
    if (runtime.plan.signalState) runtime.signalState = runtime.plan.signalState;
    runtime.riskSummary = summarizeSignalLedger(runtime.signalLedger, {
      asOf: now,
      unrealizedPnlCny: currentUnrealizedPnl(),
    });
    runtime.plan.riskGate = inspectRiskGate(runtime.config, runtime.riskSummary, {
      unrealizedPnlCny: currentUnrealizedPnl(),
    });
    if (options.record === false) return runtime.plan;

    const previousOrder = runtime.lastSuggestedOrder || null;
    const currentOrder = runtime.plan.suggestedOrder || null;
    const transition = previousOrder || currentOrder
      ? classifyOrderTransition({
        previousOrder,
        currentOrder,
        plan: runtime.plan,
        positionGrams: Number(runtime.config?.position?.grams),
        repricePct: runtime.config?.strategy?.orderRepricePct,
        now,
      })
      : { event: null };
    runtime.orderTransition = transition;
    const recorded = recordLedgerDecision(runtime.signalLedger, {
      plan: runtime.plan,
      config: runtime.config,
      previousOrder,
      transition,
      asOf: now,
    });
    runtime.signalLedger = recorded.ledger;
    runtime.plan = recorded.plan;
    runtime.riskSummary = summarizeSignalLedger(runtime.signalLedger, {
      asOf: now,
      unrealizedPnlCny: currentUnrealizedPnl(),
    });
    if (recorded.changed) statePersister.markDirty("other");
    return runtime.plan;
  }

  function recordQuote(key, quote) {
    if (!quote || !(quote.price > 0)) return null;
    // Never let a stale domestic quote masquerade as a fresh tick; doing so
    // would create fake flat bars in the today trend after the source stops
    // updating (e.g. Au99.99 stuck at 952.4 after 16:00).
    if (key === "AU9999" && !isDomesticQuoteFresh(quote, new Date())) return null;
    const normalized = normalizeQuoteRecord(key, quote, Date.now());
    if (!normalized) return null;
    runtime.quotes[key] = normalized;
    // Each lane uses its own calendar. The configurable 09:00-26:00 window is
    // only the CMB reminder/execution policy; it is not an SGE/XAU fact.
    if (runtime.bars[key] && isInstrumentOpen(key, normalized.updatedAt, runtime.config)) {
      recordTick(runtime.bars[key], normalized, normalized.updatedAt);
      statePersister.markDirty("bars");
    }
    return normalized;
  }

  async function refreshHistoricalStatus(force = false) {
    const now = Date.now();
    if (!force && now - runtime.lastHistoricalStatusAt < 60_000) return;
    runtime.historicalStatus = await historicalStore.getStatus({ instrument: "CMB_ACCUMULATED_GOLD" });
    runtime.lastHistoricalStatusAt = now;
  }

  async function appendHistoricalCmbQuote(quote) {
    if (!quote || quote.instrument !== "CMB_ACCUMULATED_GOLD") return;
    try {
      await historicalStore.appendQuote({
        ...quote,
        evidence: quote.executionEvidence?.mode ?? "unknown",
      });
      await refreshHistoricalStatus((runtime.historicalStatus?.records ?? 0) === 0);
    } catch (error) {
      logger?.warn?.(`dsh-plugin-goldboard: append CMB history failed: ${String(error?.message ?? error)}`);
    }
  }

  async function migrateLegacyCmbHistory() {
    const bars = Array.isArray(runtime.bars?.CMB?.[1]) ? runtime.bars.CMB[1] : [];
    for (const bar of bars) {
      const proxyIdentity = bar.executionEvidence?.mode === "proxy"
        || bar.quality === "proxy"
        || bar.source === "manual"
        || bar.source === "xau-fx-derived";
      const sideComplete = !proxyIdentity
        && bar.executionSideComplete === true
        && Number(bar.askC) > 0 && Number(bar.bidC) > 0;
      const sourceTimestamp = bar.sourceTimestamp ?? new Date(Number(bar.t)).toISOString();
      const receivedAt = bar.receivedAt ?? null;
      await historicalStore.appendQuote({
        instrument: "CMB_ACCUMULATED_GOLD",
        market: "bank",
        currency: "CNY",
        unit: "gram",
        source: bar.source ?? "legacy-state",
        sourceTimestamp,
        receivedAt,
        ...(bar.ingestedAt ? { ingestedAt: bar.ingestedAt } : {}),
        sourceDelayMs: Number.isFinite(Number(bar.sourceDelayMs)) ? Number(bar.sourceDelayMs) : null,
        futureSkewMs: Number.isFinite(Number(bar.futureSkewMs)) ? Number(bar.futureSkewMs) : null,
        quality: sideComplete ? "primary" : "proxy",
        synthetic: bar.synthetic === true,
        executionSideComplete: sideComplete,
        executionEvidence: {
          mode: sideComplete ? "real" : "proxy",
          askSource: sideComplete ? bar.customerAskSource ?? bar.executionSideSource ?? bar.source ?? "unknown" : bar.source ?? "legacy-state",
          bidSource: sideComplete ? bar.customerBidSource ?? bar.executionSideSource ?? bar.source ?? "unknown" : null,
        },
        customerAsk: sideComplete ? Number(bar.askC) : Number(bar.c),
        customerBid: sideComplete ? Number(bar.bidC) : undefined,
        evidence: sideComplete ? "real" : "proxy",
        migration: "state-cmb-1m-v1",
      });
    }
    await refreshHistoricalStatus(true);
  }

  function serializeState() {
    return {
      stateSchemaVersion: STATE_SCHEMA_VERSION,
      dataSchemaVersion: MARKET_DATA_SCHEMA_VERSION,
      quotes: runtime.quotes,
      bars: runtime.bars,
      barsSeedVersion: BARS_SEED_VERSION,
      alertState: runtime.alertState,
      signalState: runtime.signalState,
      lastSuggestedOrder: runtime.lastSuggestedOrder,
      signalLedger: runtime.signalLedger,
      lastAlertLog: runtime.lastAlertLog,
      laneState: runtime.laneState,
      cmbSpreadSamples: cleanCmbSpreadSamples(runtime.cmbSpreadSamples, Date.now()),
      premiumHistory: Array.isArray(runtime.premiumHistory) ? runtime.premiumHistory.slice(-PREMIUM_HISTORY_CAP) : [],
      premiumDaySamples: runtime.premiumDaySamples && typeof runtime.premiumDaySamples === "object" ? runtime.premiumDaySamples : { date: "", values: [] },
    };
  }

  /** Persist the authoritative config document. Throws so the route can report storage failures. */
  async function persistConfig() {
    try {
      await writeJsonAtomic(configPath, runtime.config, writeQueue);
    } catch (error) {
      logger?.warn?.(`dsh-plugin-goldboard: persist config failed: ${String(error?.message ?? error)}`);
      throw Object.assign(new Error("config persistence failed"), { code: "STORAGE_FAILED" });
    }
  }

  /** POST /config adoption: persist the document, bump the revision and recompute. */
  async function applyNextConfig(nextConfig) {
    const previousConfig = runtime.config;
    runtime.config = normalizeManualPrevCloseDate(nextConfig, new Date());
    await persistConfig();
    bumpConfigRevision();
    if (runtime.stateReady) {
      reconcileRuntimePosition(previousConfig.position, runtime.config.position, new Date(), "config_route", previousConfig);
      evaluateRuntimePlan(new Date());
      refreshSnapshot();
      await statePersister.persist();
    }
    await analysisLogStore.setMaxEntries(runtime.config.analysis.maxLogEntries);
  }

  async function logAlert(message, channelResults) {
    runtime.lastAlertLog.unshift({
      time: new Date().toISOString(),
      action: message.action,
      price: message.params.price,
      cmbPrice: message.params.cmbPrice,
      grams: message.params.grams,
      // plan-03 03.6: dispatchAlert reports per-channel outcomes, so sentTo
      // records where the notification actually went.
      sentTo: (Array.isArray(channelResults) ? channelResults : []).map((entry) => ({
        channel: entry.channel,
        ok: entry.ok === true,
        ...(entry.ok === true ? {} : { error: entry.error ?? "error" }),
      })),
    });
    runtime.lastAlertLog = runtime.lastAlertLog.slice(0, ALERT_LOG_CAP);
    await writeJsonAtomic(alertsPath, runtime.lastAlertLog, writeQueue).catch(() => {});
  }

  function setQuoteError(key) {
    runtime.quotes[key] = normalizeQuoteRecord(key, {
      price: 0,
      source: "error",
      stale: true,
      error: true,
      quality: "degraded",
    }, Date.now());
  }

  async function refreshQuotes() {
    const results = await Promise.allSettled([
      registry.fetchDomesticQuote(),
      registry.fetchCmbQuote(),
      registry.fetchXauQuote(),
      registry.fetchUsdcnyQuote(),
    ]);
    const [domestic, cmb, xau, usdcny] = results;
    if (domestic.status === "fulfilled" && domestic.value && domestic.value.price > 0) {
      recordQuote("AU9999", domestic.value);
    } else {
      // Do not keep showing a stale last trade when every domestic source
      // has failed; surface the failure as 0 so the user can see it is not
      // a live quote.
      setQuoteError("AU9999");
    }
    if (cmb.status === "fulfilled") {
      const normalizedCmb = recordQuote("CMB", cmb.value);
      await appendHistoricalCmbQuote(normalizedCmb);
    }
    if (xau.status === "fulfilled" && xau.value) {
      // Yahoo GC=F is a futures fallback and must never overwrite the spot XAU
      // series. Keep it in a separate quote/bar lane for diagnostics only.
      recordQuote(xau.value.source === "yahoo" ? "GCF" : "XAU", xau.value);
    }
    if (usdcny.status === "fulfilled") recordQuote("USDCNY", usdcny.value);
    // plan-03 03.1: per-poll CMB lane health. A rejected/invalid CMB fetch
    // marks the lane unavailable immediately so the stickiness counter starts
    // counting within ticks; the last good quote stays on display meanwhile.
    const cmbHealthOk = cmb.status === "fulfilled" && !!cmb.value
      && Number(cmb.value.buyPrice) > 0 && Number(cmb.value.sellPrice) > 0
      && Number(cmb.value.buyPrice) >= Number(cmb.value.sellPrice);
    runtime.laneHealth = { ...runtime.laneHealth, CMB: { ok: cmbHealthOk, at: Date.now() } };
    // Brand / accumulated-gold APIs are auxiliary: poll them in the background
    // so the data-source status page can show their health without delaying
    // the main quote refresh.
    void Promise.allSettled([
      registry.fetchJijinhaoQuote(),
      registry.fetchJdGoldQuote(),
    ]).catch(() => {});
  }

  const historyJobs = createHistoryJobs({ runtime, registry, statePersister, logger });

  // plan-06: batch replay statistics (read-only analysis; one engine per
  // plugin instance, report persisted to storages/<plugin>/replay-stats.json).
  // The default "cmb" universe replays on THIS host's persisted 招行积存金
  // series (live polls + manual minute backfill) so hit rates are quoted in
  // the desk's own terms; "au9999" keeps the Eastmoney kline universe.
  const replayStats = createReplayStats({
    getConfig: () => runtime.config,
    fetchKlines: (secid, klt, limit, endDate) => registry.fetchEastmoneyBars(secid, klt, limit, endDate),
    getCmbBars: () => ({
      bars5: Array.isArray(runtime.bars?.CMB?.[5]) ? runtime.bars.CMB[5] : [],
      bars60: Array.isArray(runtime.bars?.CMB?.[60]) ? runtime.bars.CMB[60] : [],
    }),
    historicalStore,
    reportStore: replayReportStore,
    file: join(stateDir, REPLAY_STATS_FILE),
    writeQueue,
    logger,
  });

  const strategyExperiments = createStrategyExperimentEngine({
    getConfig: () => runtime.config,
    listStrategies: (options) => replayStrategyCatalog(options),
    executeScenario: async (scenario, context) => {
      if (scenario.signalLane === "xau") {
        return {
          ok: false,
          status: "unavailable",
          reasonCodes: ["xau_usdcny_point_in_time_unavailable"],
          diagnostics: [],
        };
      }
      const frozenConfig = context.runContext?.fullConfig ?? runtime.config;
      const strategyParameters = scenario.strategyId === "control"
        ? frozenConfig.strategy
        : frozenConfig.experiments.orb;
      const result = await replayStats.run({
        days: context.days,
        lane: scenario.signalLane,
        executionLane: "cmb",
        mode: context.mode,
        asOf: context.asOf,
        strategyId: scenario.strategyId,
        strategyParameters,
        parameterMultiplier: scenario.parameterMultiplier,
        ablation: scenario.ablation,
        costMultiplier: scenario.costMultiplier,
        factorRecords: [],
        force: true,
        persist: false,
        useCache: false,
        detail: false,
        signal: context.signal,
        configOverride: frozenConfig,
        basisCache: context.runContext?.basisCache,
        requirePointInTimeIngestion: scenario.signalLane === "cmb",
      });
      return {
        ...result,
        regimes: result.experimentFacts?.regimes ?? {},
        setupLifecycle: result.experimentFacts?.setupLifecycle ?? {},
        activeSignals: result.experimentFacts?.activeSignals ?? [],
        suppressedReasons: result.experimentFacts?.suppressedReasons ?? {},
        executionDatasetAudit: result.executionDatasetAudit ?? result.report?.provenance?.executionDataset ?? null,
      };
    },
    file: join(stateDir, STRATEGY_EXPERIMENT_FILE),
    writeQueue,
    logger,
  });
  runtime.strategyExperiments = strategyExperiments;

  async function tick() {
    if (runtime.ticking) return;
    runtime.ticking = true;
    try {
      const tickDay = beijingDateForNow(new Date());
      if (runtime.manualPrevCloseDay !== tickDay) {
        runtime.manualPrevCloseDay = tickDay;
        if (hasManualPrevClose(runtime.config) || runtime.config.manualPrevCloseDate !== "") {
          runtime.config = normalizeConfig({
            ...runtime.config,
            manualPrevClose: { AU9999: null, XAU: null, CMB: null },
            manualPrevCloseDate: "",
          });
          bumpConfigRevision();
          await persistConfig();
        }
      }
      await refreshQuotes();
      historyJobs.sampleCmbSpread();
      await historyJobs.seedHistory();
      await historyJobs.backfillTrend();
      const tickNow = new Date();
      evaluateRuntimePlan(tickNow);
      const cmbQuote = runtime.quotes.CMB;
      const cmbLive = cmbQuote && Number.isFinite(Number(cmbQuote.buyPrice)) && Number.isFinite(Number(cmbQuote.sellPrice))
        && Number(cmbQuote.buyPrice) > 0 && Number(cmbQuote.sellPrice) > 0
        && Number(cmbQuote.buyPrice) >= Number(cmbQuote.sellPrice);
      const fallbackMissing = !cmbLive && !hasCmbFallback(runtime.quotes.XAU, runtime.quotes.USDCNY, new Date());
      if (runtime.plan.action === "no_data" && fallbackMissing) {
        runtime.plan.action = "data_stale";
        runtime.plan.reasonCodes = ["quote_missing"];
      }
      historyJobs.recordPremiumSample();
      const orderBeforeAlert = JSON.stringify(runtime.lastSuggestedOrder);
      await runAlertEvaluation(runtime, alertIo, { orderTransition: runtime.orderTransition });
      runtime.orderTransition = null;
      if (JSON.stringify(runtime.lastSuggestedOrder) !== orderBeforeAlert) statePersister.markDirty("other");
      refreshSnapshot(tickNow);
      await statePersister.maybeFlush();
    } catch (error) {
      logger?.warn?.(`dsh-plugin-goldboard: tick failed: ${String(error?.message ?? error)}`);
    } finally {
      runtime.ticking = false;
    }
  }

  const alertIo = {
    dispatchAlert: (message) => dispatchAlert(runtime.config, message, logger),
    logAlert,
  };

  function hasManualPrevClose(config) {
    const manual = config && config.manualPrevClose;
    return !!manual && ["AU9999", "XAU", "CMB"].some((key) => manual[key] !== null && manual[key] !== undefined && Number.isFinite(Number(manual[key])) && Number(manual[key]) > 0);
  }

  /** Manual previous closes are a same-day override; clear them when the Beijing day rolls. */
  function normalizeManualPrevCloseDate(config, now = new Date()) {
    const today = beijingDateForNow(now);
    if (!hasManualPrevClose(config)) {
      return config.manualPrevCloseDate === "" ? config : normalizeConfig({ ...config, manualPrevCloseDate: "" });
    }
    if (!config.manualPrevCloseDate) {
      return normalizeConfig({ ...config, manualPrevCloseDate: today });
    }
    if (config.manualPrevCloseDate === today) return config;
    return normalizeConfig({
      ...config,
      manualPrevClose: { AU9999: null, XAU: null, CMB: null },
      manualPrevCloseDate: "",
    });
  }

  /** Merge a stored document over a base, tolerating pre-0.2 unknown keys. */
  function mergeStoredConfig(base, patch) {
    try {
      return normalizeConfig(mergeConfigPatch(base, patch));
    } catch (error) {
      logger?.warn?.(`dsh-plugin-goldboard: stored config has unsupported keys; using a top-level merge: ${String(error?.message ?? error)}`);
      return normalizeConfig({ ...base, ...patch });
    }
  }

  async function init() {
    try {
      await mkdir(stateDir, { recursive: true, mode: 0o700 });
      try { await chmod(stateDir, 0o700); } catch { /* existing owner-only dirs are fine */ }
      // 0.2.1 storage: config.json is authoritative. A pre-settings install
      // left its last document at config.json.migrated; import it once, keep
      // the backup, and never overwrite an existing config.json with it.
      const legacyConfigPath = `${configPath}.migrated`;
      try {
        const saved = await readJson(configPath, null);
        if (saved && typeof saved === "object") {
          runtime.config = mergeStoredConfig(runtime.config, saved);
          try { await chmod(configPath, 0o600); } catch { /* best effort */ }
        } else {
          const legacy = await readJson(legacyConfigPath, null);
          if (legacy && typeof legacy === "object") {
            // The archived file is the old full document; explicit entry
            // config (which may carry an imported settings.yaml section) wins
            // for the sections it actually names.
            const ENTRY_SECTION_KEYS = ["fee", "cmb", "position", "limits", "risk", "manualPrevClose", "strategy", "experiments", "tradingHours", "analysis", "system", "webhooks"];
            const entryPatch = {};
            for (const key of ENTRY_SECTION_KEYS) {
              if (config && Object.hasOwn(config, key)) entryPatch[key] = config[key];
            }
            runtime.config = mergeStoredConfig(normalizeConfig(legacy), entryPatch);
            await writeJsonAtomic(configPath, runtime.config, writeQueue);
            try { await chmod(legacyConfigPath, 0o600); } catch { /* best effort */ }
            logger?.info?.("dsh-plugin-goldboard: imported config.json.migrated into config.json");
          }
        }
      } catch (error) {
        logger?.warn?.(`dsh-plugin-goldboard: config load failed: ${String(error?.message ?? error)}`);
      }
      const normalizedManual = normalizeManualPrevCloseDate(runtime.config, new Date());
      if (normalizedManual !== runtime.config) {
        runtime.config = normalizedManual;
        await writeJsonAtomic(configPath, runtime.config, writeQueue).catch((error) => {
          logger?.warn?.(`dsh-plugin-goldboard: manual prev close reset failed: ${String(error?.message ?? error)}`);
        });
      }
      runtime.manualPrevCloseDay = beijingDateForNow(new Date());
      configRevision = 0;
      await analysisLogStore.setMaxEntries(runtime.config.analysis.maxLogEntries);
      await analysisLogStore.init();
      try {
        const loadedState = await loadStateWithMigration({ file: statePath, writeQueue, logger });
        restoreRuntimeState(runtime, loadedState.state);
        if (loadedState.state?.signalLedger
          && JSON.stringify(loadedState.state.signalLedger) !== JSON.stringify(runtime.signalLedger)) {
          logger?.warn?.("dsh-plugin-goldboard: signal ledger normalized during state restore");
          statePersister.markDirty("other");
        }
      } catch (error) {
        logger?.warn?.(`dsh-plugin-goldboard: state load failed: ${String(error?.message ?? error)}`);
      }
      runtime.stateReady = true;
      try {
        await historicalStore.init();
        await migrateLegacyCmbHistory();
      } catch (error) {
        logger?.warn?.(`dsh-plugin-goldboard: historical store init/migration failed: ${String(error?.message ?? error)}`);
      }
      try {
        await apiLogStore.load();
      } catch (error) {
        logger?.warn?.(`dsh-plugin-goldboard: api log load failed: ${String(error?.message ?? error)}`);
      }
      await tick();
      runtime.ready = true;
    } catch (error) {
      logger?.warn?.(`dsh-plugin-goldboard: init failed: ${String(error?.message ?? error)}`);
    }
  }

  if (connection) {
    const routes = createFetchRoutes(createRoutes({
      runtime,
      analysisModule,
      analysisLogStore,
      registry,
      applyNextConfig,
      getConfigRevision,
      validateAnalysisConfig: (next) => validateAnalysisConfig(ctx.llm, next),
      persistState: () => statePersister.persist(),
      evaluatePlan: (now) => evaluateRuntimePlan(now),
      refreshSnapshot: (now) => refreshSnapshot(now),
      projectLedger: (options) => projectSignalLedger(runtime.signalLedger, options),
      replayStats,
      strategyExperiments,
      openSystemSettings: typeof config.openSystemSettings === "function" ? config.openSystemSettings : undefined,
      // Test/embedding seams receive an already validated and DNS-pinned target.
      genericLookup: typeof config.genericLookup === "function" ? config.genericLookup : undefined,
      genericTransport: typeof config.genericTransport === "function" ? config.genericTransport : undefined,
    }));
    for (const entry of routes) {
      ctx.effect(
        () => connection.fetch.register(entry),
        `dsh-plugin-goldboard: route ${entry.path}`,
      );
    }
  }

  ctx.effect(() => {
    void init();
    const timer = setInterval(() => {
      void tick();
    }, num(config.pollMs, DEFAULT_POLL_MS, MIN_POLL_MS, MAX_POLL_MS));
    // Async final flush: cordis awaits async disposers during unload, so the
    // last bars/alert state is persisted before the process exits instead of
    // racing a fire-and-forget write.
    return async () => {
      clearInterval(timer);
      analysisModule.dispose();
      await strategyExperiments.dispose();
      await statePersister.persist();
      await replayReportStore.drain();
      await historicalStore.close();
    };
  }, "dsh-plugin-goldboard: market loop");

  return runtime;
}
