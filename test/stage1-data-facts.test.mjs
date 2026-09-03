import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import * as rootApi from "../lib/index.js";
import * as testingApi from "../lib/testing.js";
import {
  CALENDAR_VERSIONS,
  EXECUTION_BID_UNAVAILABLE,
  MARKET_DATA_SCHEMA_VERSION,
  SourceRegistry,
  aggregateSubBars,
  buildSnapshot,
  closedBars,
  computeIndicatorSet,
  computeInstrumentMarketState,
  createExecutionModel,
  executeReplayTrade,
  getTradingCalendar,
  inspectWindowCoverage,
  inspectXauConversion,
  isInstrumentOpen,
  loadStateWithMigration,
  makeWriteQueue,
  normalizeBarRecord,
  normalizeQuoteRecord,
  resolveExecutionBar,
  resolveExecutionQuote,
  rollbackStateMigration,
} from "../lib/testing.js";

const AS_OF = new Date("2026-08-14T02:40:00.000Z");

function oneMinuteBars(now, count) {
  const end = Math.floor(new Date(now).getTime() / 60_000) * 60_000;
  return Array.from({ length: count }, (_, index) => ({
    t: end - index * 60_000,
    o: 950,
    h: 950,
    l: 950,
    c: 950,
  }));
}

test("market data v2 records carry three clocks, delay, quality, and customer-side provenance", () => {
  const quote = normalizeQuoteRecord("CMB", {
    price: 105,
    buyPrice: 105,
    sellPrice: 100,
    source: "cmb",
    sourceTimestamp: "2026-08-14T02:39:50.000Z",
    customerBuySource: "cmb-buy",
    customerSellSource: "cmb-sell",
  }, AS_OF.getTime());

  assert.equal(quote.dataSchemaVersion, MARKET_DATA_SCHEMA_VERSION);
  assert.equal(quote.sourceTimestamp, "2026-08-14T02:39:50.000Z");
  assert.equal(quote.receivedAt, AS_OF.toISOString());
  assert.equal(quote.ingestedAt, AS_OF.toISOString());
  assert.equal(quote.sourceDelayMs, 10_000);
  assert.equal(quote.futureSkewMs, 0);
  assert.equal(quote.synthetic, false);
  assert.equal(quote.executionSideComplete, true);
  assert.deepEqual(quote.executionEvidence, { mode: "real", askSource: "cmb-buy", bidSource: "cmb-sell" });
  assert.equal(quote.customerAsk, 105);
  assert.equal(quote.customerBid, 100);

  const oldManual = normalizeBarRecord({
    t: AS_OF.getTime() - 60_000,
    o: 101,
    h: 101,
    l: 101,
    c: 101,
    source: "manual",
    synthetic: true,
    instrument: "CMB_ACCUMULATED_GOLD",
  });
  assert.equal(oldManual.dataSchemaVersion, MARKET_DATA_SCHEMA_VERSION);
  assert.equal(oldManual.executionSideComplete, false);
  assert.equal(oldManual.executionEvidence.mode, "proxy");
  assert.equal(oldManual.customerBid, null, "v2 normalization never invents a missing historical bid");

  const legacyProxy = normalizeQuoteRecord("CMB", {
    price: 105,
    buyPrice: 105,
    sellPrice: 100,
    source: "manual",
    quality: "proxy",
  }, AS_OF.getTime());
  assert.equal(legacyProxy.executionEvidence.mode, "proxy");
  assert.equal(legacyProxy.synthetic, true, "complete sides cannot upgrade a manual proxy to real");
});

test("XAU conversion rejects either stale or future dependency consistently", () => {
  const xau = normalizeQuoteRecord("XAU", {
    price: 4_375,
    source: "tencent",
    sourceTimestamp: "2026-08-14T02:39:50.000Z",
  }, AS_OF.getTime());
  const staleFx = normalizeQuoteRecord("USDCNY", {
    price: 6.74,
    source: "tencent",
    sourceTimestamp: "2026-08-14T02:10:00.000Z",
  }, AS_OF.getTime());
  const stale = inspectXauConversion({ xau, usdcny: staleFx, asOf: AS_OF });
  assert.equal(stale.ready, false);
  assert.equal(stale.value, null);
  assert.ok(stale.reasonCodes.includes("usdcny_stale"));

  const futureFx = normalizeQuoteRecord("USDCNY", {
    price: 6.74,
    source: "tencent",
    sourceTimestamp: "2026-08-14T02:50:00.000Z",
  }, AS_OF.getTime());
  const future = inspectXauConversion({ xau, usdcny: futureFx, asOf: AS_OF });
  assert.equal(future.ready, false);
  assert.ok(future.reasonCodes.includes("usdcny_future"));

  const slightlyFutureFx = normalizeQuoteRecord("USDCNY", {
    price: 6.74,
    source: "tencent",
    sourceTimestamp: "2026-08-14T02:40:30.000Z",
  }, AS_OF.getTime());
  const slightlyFuture = inspectXauConversion({ xau, usdcny: slightlyFutureFx, asOf: AS_OF });
  assert.equal(slightlyFuture.ready, false, "point-in-time conversion rejects even tolerated live clock skew");
  assert.ok(slightlyFuture.reasonCodes.includes("usdcny_future"));
});

test("coverage facts expose a short re-anchored sample instead of only reporting 100 percent", () => {
  const fresh = oneMinuteBars(AS_OF, 6);
  const first = inspectWindowCoverage(fresh, AS_OF, 60, {});
  const second = inspectWindowCoverage(fresh.slice().reverse(), AS_OF, 60, {});
  assert.deepEqual(first, second, "coverage is deterministic for duplicate ordering");
  assert.equal(first.coverageRatio, 1);
  assert.equal(first.effectiveSampleMinutes, 6);
  assert.equal(first.observedSampleMinutes, 6);
  assert.equal(first.reanchored, true);
  assert.equal(first.complete, false);
  assert.equal(first.minutesSinceLastGap, 6);
  assert.equal(first.largestGapMinutes, 54);
  assert.equal(first.missingBuckets.length, 54);

  const fullWithPartial = oneMinuteBars(AS_OF, 60);
  fullWithPartial[3].partial = true;
  const partial = inspectWindowCoverage(fullWithPartial, AS_OF, 60);
  assert.equal(partial.observedSampleMinutes, 59);
  assert.equal(partial.coverageRatio, 59 / 60);
  assert.equal(partial.complete, false);
});

test("CMB, SGE, and XAU calendars are independent and versioned", () => {
  const beijingNoonFriday = Date.parse("2026-08-14T04:00:00.000Z");
  const config = { tradingHours: { open: "09:00", close: "26:00", weekdaysOnly: true, holidays: [] } };
  assert.equal(isInstrumentOpen("CMB", beijingNoonFriday, config), true);
  assert.equal(isInstrumentOpen("AU9999", beijingNoonFriday, config), false, "SGE is in its midday break");
  assert.equal(isInstrumentOpen("XAU", beijingNoonFriday, config), true);

  const changedCmb = { tradingHours: { open: "14:00", close: "18:00", weekdaysOnly: true, holidays: ["2026-08-14"] } };
  assert.equal(isInstrumentOpen("CMB", beijingNoonFriday, changedCmb), false);
  assert.equal(isInstrumentOpen("XAU", beijingNoonFriday, changedCmb), true, "CMB reminder config cannot alter XAU");
  assert.equal(getTradingCalendar("CMB", config).version, CALENDAR_VERSIONS.CMB);
  assert.equal(getTradingCalendar("AU9999", config).version, CALENDAR_VERSIONS.SGE);
  assert.equal(computeInstrumentMarketState("XAU", config, new Date(beijingNoonFriday)).calendarVersion, CALENDAR_VERSIONS.XAU);
});

test("a closed aggregate missing one child remains partial and cannot enter formal indicators", () => {
  const hour = Date.parse("2026-08-14T01:00:00.000Z");
  const children = Array.from({ length: 12 }, (_, index) => ({
    t: hour + index * 5 * 60_000,
    o: 100 + index,
    h: 101 + index,
    l: 99 + index,
    c: 100.5 + index,
  })).filter((_, index) => index !== 4);
  const target = [];
  aggregateSubBars(target, children, 60, { source: "fixture", instrument: "Au99.99" }, new Date(hour + 2 * 60 * 60_000));
  assert.equal(target.length, 1);
  assert.equal(target[0].partial, true);
  assert.equal(target[0].sampleCount, 11);
  assert.equal(target[0].expectedSamples, 12);
  assert.equal(closedBars(target, 60, hour + 2 * 60 * 60_000).length, 0);
  assert.equal(computeIndicatorSet(target).count, 0);

  const completeSlotsWithPartialChild = Array.from({ length: 12 }, (_, index) => ({
    t: hour + index * 5 * 60_000,
    o: 100,
    h: 101,
    l: 99,
    c: 100,
    partial: index === 4,
  }));
  const inherited = [];
  aggregateSubBars(inherited, completeSlotsWithPartialChild, 60, { source: "fixture" }, new Date(hour + 2 * 60 * 60_000));
  assert.equal(inherited[0].sampleCount, 12);
  assert.equal(inherited[0].partial, true, "a parent inherits partial even when every child timestamp exists");
});

test("execution requires complete live sides and only creates a proxy when explicitly requested", () => {
  const config = { fee: { buyPerGram: 1, sellPerGram: 2 }, strategy: { slippagePerGram: 0.5, estimatedSpreadPerGram: 0.2 } };
  const incomplete = resolveExecutionQuote({
    quote: { customerBuy: 105, source: "cmb" },
    referencePrice: 100,
    buyOffset: 2,
    sellOffset: -2,
  }, config);
  assert.equal(incomplete.available, false);
  assert.equal(incomplete.reasonCode, EXECUTION_BID_UNAVAILABLE);
  assert.equal(incomplete.bid, null);
  assert.equal(incomplete.ask, 105);

  const fallback = resolveExecutionQuote({ referencePrice: 100, buyOffset: 2, sellOffset: -2, assumptionSource: "configured-test" }, config);
  assert.equal(fallback.available, true);
  assert.equal(fallback.evidence, "synthetic");
  assert.ok(fallback.assumptions.includes("configured-test"));

  const proxyBar = {
    o: 105, h: 106, l: 104, c: 105,
    source: "manual",
    quality: "proxy",
    executionSideComplete: true,
    executionEvidence: { mode: "proxy" },
    askO: 105, askH: 106, askL: 104, askC: 105,
    bidO: 100, bidH: 101, bidL: 99, bidC: 100,
  };
  const strictProxy = resolveExecutionBar({ lane: "cmb", bar: proxyBar }, config);
  assert.equal(strictProxy.available, false);
  assert.equal(strictProxy.evidence, "proxy");
  const allowedProxy = resolveExecutionBar({ lane: "cmb", bar: proxyBar, allowProxy: true }, config);
  assert.equal(allowedProxy.available, true);
  assert.equal(allowedProxy.realBidAsk, false);
  assert.equal(allowedProxy.evidence, "proxy");
});

test("live, snapshot, and replay share one execution cash-flow breakdown", () => {
  const config = {
    fee: { buyPerGram: 1, sellPerGram: 2 },
    limits: { maxGrams: 100 },
    strategy: { slippagePerGram: 0.5, estimatedSpreadPerGram: 0.2 },
  };
  const execution = createExecutionModel(config);
  const quote = execution.quote({ quote: { customerBuy: 105, customerSell: 100, source: "cmb" } });
  const direct = execution.accountExecution({ side: "buy", grams: 10, quote });
  const replay = executeReplayTrade(
    { grams: 0, costBasisCny: 0, cashFlowCny: 0, realizedPnlCny: 0 },
    { action: "buy_setup", suggestedOrder: { side: "buy", price: quote.ask, grams: 10 } },
    config,
  );
  assert.equal(replay.trade.cashFlowCny, direct.cashFlowCny);
  assert.equal(replay.trade.explicitFeeCny, direct.feeCny);
  assert.equal(replay.trade.slippageCny, direct.slippageCny);
  assert.equal(replay.trade.executionVersion, direct.executionVersion);

  const runtime = {
    quotes: { CMB: normalizeQuoteRecord("CMB", { price: 105, buyPrice: 105, sellPrice: 100, source: "cmb" }, AS_OF.getTime()), AU9999: null, XAU: null, GCF: null, USDCNY: null },
    bars: { CMB: { 1: [], 5: [], 60: [] }, AU9999: { 1: [] }, XAU: { 1: [] }, GCF: { 1: [] } },
    plan: { action: "wait", marketState: "open", instrument: "CMB", reasonCodes: [], dataCoverage: {}, dataCoverageDetails: {} },
  };
  const snapshot = buildSnapshot(runtime, config, AS_OF);
  assert.equal(snapshot.derived.cmb.costComponents.explicitFeePerGram, 2);
  assert.equal(snapshot.derived.cmb.costComponents.slippagePerGram, 0.5);
  assert.equal(snapshot.derived.cmb.costComponents.quotedSpreadPerGram, 5);
});

test("state v2 migration backs up bytes, emits a manifest, rolls back, and isolates corruption", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "goldboard-stage1-state-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const file = join(directory, "state.json");
  const original = JSON.stringify({
    quotes: {
      CMB: { price: 105, buyPrice: 105, sellPrice: 100, source: "manual", quality: "proxy", updatedAt: AS_OF.getTime() },
    },
    bars: {
      CMB: { 1: [{ t: AS_OF.getTime() - 60_000, o: 105, h: 105, l: 105, c: 105, source: "cmb", synthetic: true }] },
    },
    marker: "v1",
  }, null, 2);
  await writeFile(file, original, "utf8");
  const loaded = await loadStateWithMigration({
    file,
    writeQueue: makeWriteQueue(),
    now: () => new Date("2026-08-14T03:00:00.000Z"),
  });
  assert.equal(loaded.migrated, true);
  assert.equal(loaded.state.stateSchemaVersion, 2);
  assert.equal(loaded.state.quotes.CMB.dataSchemaVersion, MARKET_DATA_SCHEMA_VERSION);
  assert.equal(loaded.state.quotes.CMB.executionEvidence.mode, "proxy");
  assert.equal(loaded.state.bars.CMB[1][0].dataSchemaVersion, MARKET_DATA_SCHEMA_VERSION);
  assert.equal(loaded.state.bars.CMB[1][0].executionEvidence.mode, "proxy");
  assert.equal(await readFile(loaded.backupPath, "utf8"), original);
  assert.equal(existsSync(`${file}.migration-v2.json`), true);

  await writeFile(file, "changed", "utf8");
  await rollbackStateMigration({ file, backupPath: loaded.backupPath, writeQueue: makeWriteQueue() });
  assert.equal(await readFile(file, "utf8"), original);

  const secondOriginal = JSON.stringify({ quotes: {}, bars: {}, marker: "different-v1" }, null, 2);
  await writeFile(file, secondOriginal, "utf8");
  const secondMigration = await loadStateWithMigration({ file, writeQueue: makeWriteQueue() });
  assert.notEqual(secondMigration.backupPath, loaded.backupPath, "a stale fixed backup is never reused for different bytes");
  assert.equal(await readFile(secondMigration.backupPath, "utf8"), secondOriginal);

  await writeFile(file, "{broken", "utf8");
  const corrupt = await loadStateWithMigration({
    file,
    now: () => new Date("2026-08-14T03:01:00.000Z"),
  });
  assert.equal(corrupt.state, null);
  assert.equal(existsSync(corrupt.corruptPath), true);
  assert.equal(existsSync(file), false);

  await writeFile(file, "[]", "utf8");
  const nonObject = await loadStateWithMigration({ file });
  assert.equal(nonObject.state, null);
  assert.equal(existsSync(nonObject.corruptPath), true);
});

test("source health projects success, failure duration, percentiles, fallbacks, and execution history", () => {
  const now = Date.now();
  const logs = [
    { sourceId: "tencent-xau", ok: false, time: new Date(now - 1_000).toISOString(), durationMs: 90 },
    { sourceId: "tencent-xau", ok: false, time: new Date(now - 2_000).toISOString(), durationMs: 50 },
    { sourceId: "tencent-xau", ok: true, time: new Date(now - 3_000).toISOString(), durationMs: 10 },
    { sourceId: "sina-xau", ok: true, time: new Date(now - 500).toISOString(), durationMs: 20 },
  ];
  const registry = new SourceRegistry({ logStore: { list: () => logs, append: () => {} } });
  const rows = registry.dataSourceView({
    quotes: {},
    historicalStatus: {
      records: 10,
      realRatio: 0.6,
      syntheticRatio: 0.1,
      proxyRatio: 0.2,
      unknownRatio: 0.1,
      lastValidAt: new Date(now).toISOString(),
      gaps: [],
    },
  });
  const xau = rows.find((row) => row.id === "tencent-xau");
  assert.equal(xau.health.samples, 3);
  assert.equal(xau.health.successRate, 0.333333);
  assert.equal(xau.health.consecutiveFailures, 2);
  assert.equal(xau.health.latencyMs.p50, 50);
  assert.equal(xau.health.latencyMs.p95, 90);
  assert.ok(xau.health.consecutiveFailureDurationMs >= 1_000);
  assert.ok(xau.health.availableFallbackSources.includes("sina-xau"));
  const cmb = rows.find((row) => row.id === "cmb-market-center");
  assert.equal(cmb.health.executionHistory.realRatio, 0.6);
});

test("root API excludes test hooks while the testing entry retains them", async () => {
  assert.equal(typeof rootApi.apply, "function");
  assert.equal(typeof rootApi.MarketDataContract.normalizeQuote, "function");
  assert.equal(typeof rootApi.ExecutionModel, "function");
  assert.equal(typeof rootApi.HistoricalStore, "function");
  assert.equal("__setFetchImpl" in rootApi, false);
  assert.equal("parseSinaDomesticQuote" in rootApi, false);
  assert.equal(typeof testingApi.__setFetchImpl, "function");
  assert.equal(typeof testingApi.parseSinaDomesticQuote, "function");
  const packagedRoot = await import("dsh-plugin-goldboard");
  const packagedTesting = await import("dsh-plugin-goldboard/testing");
  const packagedExecution = await import("dsh-plugin-goldboard/execution");
  assert.equal("__setFetchImpl" in packagedRoot, false);
  assert.equal(typeof packagedTesting.__setFetchImpl, "function");
  assert.equal(typeof packagedExecution.createExecutionModel, "function");
});

test("snapshot publishes schema v2, independent calendar versions, and deterministic coverage details", () => {
  const quoteTime = Date.parse("2026-08-14T02:40:00.000Z");
  const runtime = {
    quotes: {
      AU9999: normalizeQuoteRecord("AU9999", { price: 950, source: "sina" }, quoteTime),
      XAU: null,
      GCF: null,
      USDCNY: null,
      CMB: null,
    },
    bars: { AU9999: { 1: [], 5: [], 60: [] }, XAU: { 1: [] }, GCF: { 1: [] }, CMB: { 1: [] } },
    plan: { action: "wait", marketState: "open", instrument: "Au99.99", reasonCodes: [], dataCoverage: {}, dataCoverageDetails: {}, suggestedOrder: null },
    historicalStatus: { records: 3 },
  };
  const first = buildSnapshot(runtime, {}, AS_OF);
  const second = buildSnapshot(runtime, {}, AS_OF);
  assert.deepEqual(first, second);
  assert.equal(first.dataSchemaVersion, MARKET_DATA_SCHEMA_VERSION);
  assert.equal(first.market.calendarVersion, CALENDAR_VERSIONS.CMB);
  assert.equal(first.calendars.AU9999.calendarVersion, CALENDAR_VERSIONS.SGE);
  assert.equal(first.calendars.XAU.calendarVersion, CALENDAR_VERSIONS.XAU);
  assert.equal(first.historical.records, 3);
});
