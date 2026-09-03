/**
 * dsh-plugin-goldboard host half — composition root.
 *
 * Gold dashboard + intraday decision support for the DeepSeek Harness web GUI.
 * plan-05 split the old 5.7k-line monolith into focused modules (merged import
 * surface lives in public-api.js):
 *
 *   config.js       defaults / normalization / secrets / patch merge + settings schema
 *   market-time.js  Beijing calendar, sessions, coverage windows
 *   indicators.js   SMA/EMA/RSI/ATR/MACD/Bollinger + resampling
 *   parsers.js      pure wire-format parsers per upstream source
 *   sources.js      SourceRegistry: transport, circuit breaker, api-log feed
 *   store.js        atomic JSON persistence, state persister, ApiLogStore
 *   bars.js         bar lifecycle (record/merge/aggregate/manual CMB ingestion)
 *   sizing.js       position sizing, order factory, signal policy
 *   spread-stats.js dynamic CMB spread samples + premium σ statistics
 *   plan.js         lane stickiness + computePlan pipeline (4 stages)
 *   alerts.js       messages, channels, dispatchAlert, alert-edge evaluation
 *   snapshot.js     /snapshot wire view + deterministic replay
 *   routes.js       route() helper + path table
 *   history.js      kline seeding / backfill jobs
 *   replay-stats.js plan-06 batch rule hit-rate statistics (read-only)
 *
 * This file only wires them: runtime creation, the plan-04 settings seam,
 * the tick loop and route registration. The plugin never places orders;
 * every suggestion is advisory only.
 */

import { mkdir, rename } from "node:fs/promises";
import { join } from "node:path";

import { installSettingsSection } from "@deepseek-ai/dsh-settings";

import { AnalysisModule, validateAnalysisConfig } from "./analysis.js";
import { AnalysisLogStore } from "./analysis-log.js";
import {
  DEFAULT_CONFIG,
  SETTINGS_NAMESPACE,
  SETTINGS_SCHEMA,
  normalizeConfig,
  sectionForSettingsStore,
} from "./config.js";
import { computeMarketState, isInstrumentOpen, tradingDayForTimestamp } from "./market-time.js";
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
import { ALERT_LOG_CAP, dispatchAlert, runAlertEvaluation } from "./alerts.js";
import { defaultSignalState } from "./sizing.js";
import { num } from "./shared.js";
import { analysisBarsView, buildSnapshot } from "./snapshot.js";
import { createRoutes } from "./routes.js";
import { createHistoryJobs } from "./history.js";
import { HistoricalStore } from "./historical-store.js";
import { createReplayStats } from "./replay-stats.js";

export * from "./public-api.js";

export const name = "dsh-plugin-goldboard";
export const inject = ["webServer", "llm"];

// ── file names / wiring constants ───────────────────────────────────────────

const CONFIG_FILE = "config.json";
const STATE_FILE = "state.json";
const ALERTS_LOG_FILE = "alerts-log.json";
const API_LOG_FILE = "api-log.json";
const ANALYSIS_LOG_FILE = "analysis-log.jsonl";
const REPLAY_STATS_FILE = "replay-stats.json";
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
  const webServer = ctx.webServer;
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

  // ── plan-04: user-settings seam ──────────────────────────────────────────
  // installSettingsSection layers schema defaults → entry config → user doc
  // while a provider is mounted; our ctx.inject(["settings"]) capture gives
  // the migration + POST /config write-through the service reference (cordis
  // only lets declaring fibers read service properties). usingSettings is set
  // once at mount; route handlers branch on it.
  let settingsRef = null;
  let usingSettings = false;
  let settingsWritable = false;
  if (typeof ctx.inject === "function") {
    ctx.effect(() => {
      const disposer = ctx.inject(["settings"], (sctx) => {
        settingsRef = sctx?.settings ?? null;
        usingSettings = settingsRef !== null;
        settingsWritable = settingsRef !== null && settingsRef.writable !== false;
      });
      return () => {
        settingsRef = null;
        usingSettings = false;
        settingsWritable = false;
        if (typeof disposer === "function") disposer();
      };
    }, "dsh-plugin-goldboard: settings capture");
  }

  // Authoritative config source: the resolved settings scope while attached,
  // the composition entry otherwise (installSettingsSection swaps the thunk).
  let configSource = () => runtime.config;
  let migrationPromise = null;

  /** Re-judge everything derived from the config source after a change. */
  function adoptConfigSource() {
    try {
      runtime.config = normalizeConfig(configSource());
    } catch (error) {
      logger?.warn?.(`dsh-plugin-goldboard: config adoption failed: ${String(error?.message ?? error)}`);
      return;
    }
    runtime.plan = computePlan(runtime, runtime.config);
    if (runtime.plan.signalState) runtime.signalState = runtime.plan.signalState;
    refreshSnapshot();
    void analysisLogStore.setMaxEntries(runtime.config.analysis.maxLogEntries).catch(() => {});
    void migrateLegacyConfig();
  }

  // One-time legacy migration (plan-04 04.2): a pre-upgrade config.json is
  // normalized and stored as the namespace's user section, then the file is
  // renamed to config.json.migrated (kept for rollback, never deleted). When
  // the user section already exists (post-migration edits), the file is only
  // archived so newer settings.yaml values are never clobbered. Single-flight:
  // triggered from init() and from the first onChange after mount.
  function migrateLegacyConfig() {
    if (!usingSettings || !settingsRef || typeof settingsRef.replace !== "function") return Promise.resolve();
    if (migrationPromise) return migrationPromise;
    migrationPromise = (async () => {
      let legacy = await readJson(configPath, null);
      if (!legacy || typeof legacy !== "object") return;
      let hasUserSection = true;
      try {
        const descriptor = (settingsRef.describe() ?? []).find((entry) => entry.ns === SETTINGS_NAMESPACE);
        hasUserSection = Boolean(descriptor && descriptor.user !== undefined);
      } catch {
        hasUserSection = true; // Undeterminable: archive without overwriting.
      }
      if (!hasUserSection) {
        await settingsRef.replace(SETTINGS_NAMESPACE, sectionForSettingsStore(normalizeConfig({ ...DEFAULT_CONFIG, ...legacy })));
        logger?.info?.("dsh-plugin-goldboard: legacy config.json migrated into the settings namespace");
      }
      await rename(configPath, `${configPath}.migrated`);
    })().catch((error) => {
      migrationPromise = null; // Retry on the next trigger; the file stays put.
      logger?.warn?.(`dsh-plugin-goldboard: legacy config migration failed: ${String(error?.message ?? error)}`);
    });
    return migrationPromise;
  }

  // Entry-config subset for the namespace (composition base layer). pollMs /
  // directory stay activation-only entry config and are deliberately NOT part
  // of the namespace (plan-04 04.5). Empty secrets are stripped so an unset
  // secret stays absent through resolution (see sectionForSettingsStore).
  const entrySections = sectionForSettingsStore(normalizeConfig(config));

  if (typeof ctx.inject === "function") {
    ctx.effect(() => {
      installSettingsSection(ctx, SETTINGS_NAMESPACE, SETTINGS_SCHEMA, entrySections, {
        setSource: (thunk) => {
          configSource = thunk;
        },
        onChange: adoptConfigSource,
      });
    }, "dsh-plugin-goldboard: settings section");
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
    const snapshot = buildSnapshot(runtime, runtime.config, now);
    snapshot.analysis = analysisModule.status();
    runtime.lastSnapshot = snapshot;
    runtime.lastSnapshotBuiltAt = Date.now();
    return snapshot;
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
      lastAlertLog: runtime.lastAlertLog,
      laneState: runtime.laneState,
      cmbSpreadSamples: cleanCmbSpreadSamples(runtime.cmbSpreadSamples, Date.now()),
      premiumHistory: Array.isArray(runtime.premiumHistory) ? runtime.premiumHistory.slice(-PREMIUM_HISTORY_CAP) : [],
      premiumDaySamples: runtime.premiumDaySamples && typeof runtime.premiumDaySamples === "object" ? runtime.premiumDaySamples : { date: "", values: [] },
    };
  }

  /** Classic-path persistence only: retired once a writable settings provider owns the namespace (plan-04). */
  function persistConfig() {
    if (usingSettings && settingsWritable) return Promise.resolve();
    return writeJsonAtomic(configPath, runtime.config, writeQueue).catch((error) => logger?.warn?.(`dsh-plugin-goldboard: persist config failed: ${String(error?.message ?? error)}`));
  }

  /** POST /config adoption: persist through the active branch and recompute. */
  async function applyNextConfig(nextConfig) {
    if (usingSettings && settingsRef && settingsWritable) {
      // plan-04 04.3: provider environments persist through the settings
      // service (settings.yaml); config.json is retired. The route stays as
      // the write path for clients without a writable settingsScope (remote
      // browsers — the settings RPCs are loopback-only).
      await settingsRef.replace(SETTINGS_NAMESPACE, sectionForSettingsStore(nextConfig));
      // Adopt immediately: the commit's watch → onChange lands asynchronously
      // and would reconcile to the same value.
      runtime.config = nextConfig;
    } else {
      runtime.config = nextConfig;
      await persistConfig();
    }
    await analysisLogStore.setMaxEntries(runtime.config.analysis.maxLogEntries);
    runtime.plan = computePlan(runtime, runtime.config);
    if (runtime.plan.signalState) runtime.signalState = runtime.plan.signalState;
    refreshSnapshot();
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
    file: join(stateDir, REPLAY_STATS_FILE),
    writeQueue,
    logger,
  });

  async function tick() {
    if (runtime.ticking) return;
    runtime.ticking = true;
    try {
      await refreshQuotes();
      historyJobs.sampleCmbSpread();
      await historyJobs.seedHistory();
      await historyJobs.backfillTrend();
      runtime.plan = computePlan(runtime, runtime.config);
      if (runtime.plan.signalState) runtime.signalState = runtime.plan.signalState;
      const cmbQuote = runtime.quotes.CMB;
      const cmbLive = cmbQuote && Number.isFinite(Number(cmbQuote.buyPrice)) && Number.isFinite(Number(cmbQuote.sellPrice))
        && Number(cmbQuote.buyPrice) > 0 && Number(cmbQuote.sellPrice) > 0
        && Number(cmbQuote.buyPrice) >= Number(cmbQuote.sellPrice);
      const fallbackMissing = !cmbLive && !hasCmbFallback(runtime.quotes.XAU, runtime.quotes.USDCNY, new Date());
      if (runtime.plan.action === "no_data" && fallbackMissing) {
        runtime.plan.action = "data_stale";
        runtime.plan.reasonCodes = ["quote_missing"];
      }
      refreshSnapshot();
      historyJobs.recordPremiumSample();
      await runAlertEvaluation(runtime, alertIo);
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

  async function init() {
    try {
      await mkdir(stateDir, { recursive: true });
      // plan-04 04.2: seed the settings namespace from a pre-upgrade
      // config.json once, then archive the file. When the provider has not
      // mounted (yet), this is a no-op and the classic load below applies.
      await migrateLegacyConfig();
      if (!usingSettings) {
        try {
          const saved = await readJson(configPath, null);
          if (saved && typeof saved === "object") runtime.config = normalizeConfig({ ...runtime.config, ...saved });
        } catch (error) {
          logger?.warn?.(`dsh-plugin-goldboard: config load failed: ${String(error?.message ?? error)}`);
        }
      }
      await analysisLogStore.setMaxEntries(runtime.config.analysis.maxLogEntries);
      await analysisLogStore.init();
      try {
        const loadedState = await loadStateWithMigration({ file: statePath, writeQueue, logger });
        restoreRuntimeState(runtime, loadedState.state);
      } catch (error) {
        logger?.warn?.(`dsh-plugin-goldboard: state load failed: ${String(error?.message ?? error)}`);
      }
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

  if (webServer) {
    const routes = createRoutes({
      runtime,
      analysisModule,
      analysisLogStore,
      registry,
      applyNextConfig,
      validateAnalysisConfig: (next) => validateAnalysisConfig(ctx.llm, next),
      persistState: () => statePersister.persist(),
      refreshSnapshot: (now) => refreshSnapshot(now),
      replayStats,
      // Test/embedding seams receive an already validated and DNS-pinned target.
      genericLookup: typeof config.genericLookup === "function" ? config.genericLookup : undefined,
      genericTransport: typeof config.genericTransport === "function" ? config.genericTransport : undefined,
    });
    for (const entry of routes) {
      ctx.effect(
        () => webServer.register({ kind: "exact", path: entry.path, handler: entry.handler }),
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
      await statePersister.persist();
      await historicalStore.close();
    };
  }, "dsh-plugin-goldboard: market loop");

  return runtime;
}
