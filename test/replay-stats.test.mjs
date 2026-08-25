/**
 * plan-06 suite: batch replay statistics.
 *
 * Covers the five required behaviours plus the pure layers:
 *   1. deterministic fixture → exact action counts / hit rates;
 *   2. daily klines fetched exactly once per (day, interval);
 *   3. mid-window source failure → partial report + failures list;
 *   4. cancellation: abort stops the run and the engine can run again;
 *   5. report persisted to replay-stats.json and read back idempotently.
 */

import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  REPLAY_CACHE_TTL_MS,
  REPLAY_DAYS_MAX,
  aggregateReplayReport,
  computeForwardOutcome,
  createReplayStats,
  expandBarsToMinuteBars,
  listReplayTradingDays,
  replayTradingDay,
  sessionDateForTimestamp,
} from "../lib/replay-stats.js";
import { SourceRegistry, __setFetchImpl } from "../lib/sources.js";
import { makeWriteQueue } from "../lib/store.js";

// ── fixture builders ───────────────────────────────────────────────────────

const SESSION_MINUTES = 17 * 60; // 09:00 → next-day 02:00
const BARS_PER_DAY = SESSION_MINUTES / 5; // 204 closed 5m bars per session

/** Deterministic price path: gentle rise with a small sine ripple. */
function priceAt(index) {
  return 950 + index * 0.02 + Math.sin(index / 8) * 0.4;
}

function buildBars(dayList, { strideMinutes = 5 } = {}) {
  const stepMs = strideMinutes * 60_000;
  const bars = [];
  let index = 0;
  for (const day of dayList) {
    const startMs = Date.parse(`${day}T09:00:00+08:00`);
    for (let i = 0; i < SESSION_MINUTES / strideMinutes; i += 1) {
      const t = startMs + i * stepMs;
      const base = priceAt(index);
      bars.push({
        t,
        o: base,
        h: base + 0.3,
        l: base - 0.3,
        c: base + 0.05,
        source: "eastmoney",
        instrument: "Au99.99",
        market: "sge",
        currency: "CNY",
        unit: "gram",
      });
      index += 1 / (strideMinutes / 5);
    }
  }
  return bars;
}

const TWO_DAYS = ["2026-08-13", "2026-08-14"]; // Thu + Fri, Beijing
/** Frozen "now": Beijing Friday 2026-08-14 12:00 (session open). */
const FRIDAY_NOON = new Date(Date.parse("2026-08-14T04:00:00Z"));

// ── 1. trading-day enumeration (calendar-aware) ─────────────────────────────

test("listReplayTradingDays skips weekends/holidays and orders oldest-first", () => {
  // Beijing Sunday 2026-08-16 12:00 → the 5 tradeable days end on Friday 14th.
  const sunday = new Date(Date.parse("2026-08-16T04:00:00Z"));
  const config = { tradingHours: { holidays: ["2026-08-11"] } }; // Tuesday holiday
  const days = listReplayTradingDays(config, 5, sunday);
  assert.deepEqual(days, ["2026-08-07", "2026-08-10", "2026-08-12", "2026-08-13", "2026-08-14"]);
});

test("listReplayTradingDays caps at REPLAY_DAYS_MAX and honours the overnight session", () => {
  const fridayNoon = new Date(Date.parse("2026-08-14T04:00:00Z"));
  const many = listReplayTradingDays({}, REPLAY_DAYS_MAX, fridayNoon);
  assert.equal(many.length, REPLAY_DAYS_MAX);
  // 01:00 Beijing Saturday (2026-08-15) = 2026-08-14T17:00Z belongs to
  // Friday's overnight session.
  assert.equal(sessionDateForTimestamp(Date.parse("2026-08-14T17:00:00Z"), {}), "2026-08-14");
  const earlySaturday = new Date(Date.parse("2026-08-14T17:00:00Z"));
  const saturdayDays = listReplayTradingDays({}, 3, earlySaturday);
  assert.deepEqual(saturdayDays, ["2026-08-12", "2026-08-13", "2026-08-14"]);
});

// ── 2. minute-coverage expansion ─────────────────────────────────────────────

test("expandBarsToMinuteBars yields five slots per bar plus the forming-minute marker", () => {
  const t0 = Date.parse("2026-08-13T01:00:00Z"); // 09:00 Beijing
  const bar = (t) => ({ t, o: 950, h: 951, l: 949, c: 950.5 });
  const expanded = expandBarsToMinuteBars([bar(t0), bar(t0 + 300_000)]);
  // Bar 1: five slots + forming-minute marker (a following bar exists);
  // bar 2: five slots, no marker (no third bar) → 11 minute rows.
  assert.equal(expanded.length, 11);
  assert.ok(expanded.every((minute) => minute.synthetic === true));
  const times = expanded.map((minute) => minute.t);
  assert.ok(times.includes(t0 + 300_000), "forming-minute marker at the closing instant");
  assert.ok(times.includes(t0 + 540_000), "next bar's own slots continue the timeline");
});

// ── 3. forward outcomes + aggregation: exact counts and rates ────────────────

test("computeForwardOutcome traces target/stop/MFE/MAE/session-end P&L exactly", () => {
  const config = {
    fee: { buyPerGram: 1, sellPerGram: 2 },
    strategy: { estimatedSpreadPerGram: 0.5, slippagePerGram: 0.5 },
  };
  const t0 = Date.parse("2026-08-13T01:00:00Z");
  const event = {
    day: "2026-08-13",
    t: new Date(t0).toISOString(),
    tMs: t0,
    action: "buy_setup",
    price: 100,
    targetPrice: 110,
    stopPrice: 90,
    breakeven: 104,
  };
  // Future bars: rise to 112 (target touched at +10m), dip to 95 after the
  // +30m window, settle at 105; the last bar lies past the session end.
  const future = [
    { t: t0 + 300_000, o: 101, h: 108, l: 100.5, c: 107 },
    { t: t0 + 600_000, o: 107, h: 112, l: 106, c: 111 },
    { t: t0 + 2100_000, o: 111, h: 111, l: 95, c: 96 },
    { t: t0 + 2400_000, o: 96, h: 105, l: 94, c: 105 },
    // Beyond session end (t0 + 2h): ignored.
    { t: t0 + 3600_000 * 4, o: 105, h: 130, l: 80, c: 90 },
  ];
  const outcome = computeForwardOutcome(event, future, config, t0 + 3600_000 * 2);
  assert.equal(outcome.targetHit, true);
  assert.equal(outcome.stopHit, false);
  assert.equal(outcome.breakevenTouched, true);
  assert.equal(outcome.firstTouch, "target");
  assert.equal(outcome.mfe30m, 12); // max high 112 − entry 100
  assert.equal(outcome.mae30m, 0); // lows stay above entry within +30m (clamped)
  assert.equal(outcome.mfe60m, 12);
  assert.equal(outcome.mae60m, 6); // 100 − min low 94 within +60m
  assert.equal(outcome.sessionEndPrice, 105);
  assert.equal(outcome.sessionEndNet, 105 - 100 - 4); // fees 3 + spread 0.5 + slip 0.5
  assert.equal(outcome.horizonBars, 4);
});

test("computeForwardOutcome reports post-exit drift for sell-family events", () => {
  const config = {};
  const t0 = Date.parse("2026-08-13T01:00:00Z");
  const event = {
    day: "2026-08-13",
    t: new Date(t0).toISOString(),
    tMs: t0,
    action: "sell_weakness",
    price: 100,
    targetPrice: 110,
    stopPrice: 90,
  };
  const future = [
    { t: t0 + 300_000, o: 99, h: 99.5, l: 98, c: 98.5 },
    { t: t0 + 600_000, o: 98.5, h: 99, l: 97.5, c: 98 },
  ];
  const outcome = computeForwardOutcome(event, future, config, t0 + 3600_000 * 2);
  // Sell family: no target/stop columns; drift negative = exit beat holding.
  assert.equal(outcome.targetHit, null);
  assert.equal(outcome.stopHit, null);
  assert.equal(outcome.postExitDrift60m, -2); // close 98 − entry 100
  assert.equal(outcome.sessionEndNet, -3.4); // 100 − 98 − default costs 5.4
});

test("aggregateReplayReport produces exact per-action counts, rates and buckets", () => {
  const mkEvent = (action, score, outcome) => ({ action, signalLane: "AU9999", confidenceScore: score, outcome });
  const events = [
    mkEvent("buy_setup", 5, { targetHit: true, stopHit: false, breakevenTouched: true, mfe30m: 2, mae30m: 1, mfe60m: 3, mae60m: 2, sessionEndNet: 1.5 }),
    mkEvent("buy_setup", 7, { targetHit: false, stopHit: true, breakevenTouched: true, mfe30m: 0.5, mae30m: 2, mfe60m: 1, mae60m: 4, sessionEndNet: -3 }),
    mkEvent("buy_setup", 7, { targetHit: false, stopHit: false, breakevenTouched: false, mfe30m: 1, mae30m: 1, mfe60m: 2, mae60m: 2, sessionEndNet: 0.5 }),
    mkEvent("add_position", 6, { targetHit: true, stopHit: false, breakevenTouched: false, mfe30m: 4, mae30m: 1, mfe60m: 5, mae60m: 1, sessionEndNet: 2 }),
    mkEvent("sell_weakness", 6, { targetHit: null, stopHit: null, breakevenTouched: null, postExitDrift60m: -1.5, sessionEndNet: 0.8 }),
  ];
  const report = aggregateReplayReport({
    events,
    steps: 100,
    blockedSteps: 25,
    daysRequested: 2,
    daysEvaluated: 2,
    daysFailed: 0,
    failures: [],
    params: { days: 2 },
    generatedAt: Date.parse("2026-08-14T04:00:00Z"),
    window: { from: "2026-08-13", to: "2026-08-14" },
  });
  assert.equal(report.perAction.length, 3);
  const buySetup = report.perAction.find((row) => row.action === "buy_setup");
  assert.equal(buySetup.count, 3);
  assert.equal(buySetup.targetHitRate, Math.round((1 / 3) * 10_000) / 10_000);
  assert.equal(buySetup.stopHitRate, Math.round((1 / 3) * 10_000) / 10_000);
  assert.equal(buySetup.breakevenTouchedRate, Math.round((2 / 3) * 10_000) / 10_000);
  assert.equal(buySetup.avgMfe30m, Math.round(((2 + 0.5 + 1) / 3) * 100) / 100);
  assert.equal(buySetup.sessionEndAvgNet, Math.round(((1.5 - 3 + 0.5) / 3) * 100) / 100);
  const weakness = report.perAction.find((row) => row.action === "sell_weakness");
  assert.equal(weakness.count, 1);
  assert.equal(weakness.targetHitRate, null);
  assert.equal(weakness.avgPostExitDrift60m, -1.5);
  assert.equal(report.totals.steps, 100);
  assert.equal(report.totals.directionalEvents, 5);
  assert.equal(report.totals.coverageBlockedRatio, 0.25);
  const bucket7 = report.confidenceBuckets.find((bucket) => bucket.bucket === "≥7");
  assert.equal(bucket7.events, 2);
  assert.equal(bucket7.targetHitRate, 0);
  assert.equal(report.caveats.length, 6);
  assert.deepEqual(report.failures, []);
});

test("replayTradingDay is deterministic: identical fixtures produce identical reports", () => {
  const bars5 = buildBars(TWO_DAYS);
  const bars60 = buildBars(TWO_DAYS, { strideMinutes: 60 });
  // v1.9.0: the forced session-end close is gated by strategy.closeBySessionEnd
  // (default off) — enable it here so this fixture keeps covering the mechanism.
  const config = { strategy: { closeBySessionEnd: true } };
  const first = replayTradingDay("2026-08-14", bars5, bars60, config);
  const second = replayTradingDay("2026-08-14", bars5, bars60, config);
  assert.deepEqual(second, first);
  // Structural facts: every in-session 5m bar evaluated once per pass.
  assert.equal(first.steps, BARS_PER_DAY * 2);
  const byAction = {};
  for (const event of first.events) byAction[event.action] = (byAction[event.action] ?? 0) + 1;
  assert.ok(byAction.close_by_session_end > 0, "hold pass nudges session-end exits");
  // Session-end exits fire exactly on the closes inside the final 30 minutes
  // (the 26:00 close itself is already market_closed and never nudges).
  const sessionEndSteps = [...Array(BARS_PER_DAY).keys()]
    .filter((i) => {
      const msToClose = (SESSION_MINUTES - (i + 1) * 5) * 60_000;
      return msToClose > 0 && msToClose <= 30 * 60_000;
    }).length;
  assert.equal(byAction.close_by_session_end, sessionEndSteps);
  // Every event carries a complete outcome envelope.
  for (const event of first.events) {
    assert.equal(typeof event.outcome.entry, "number");
    assert.equal(event.outcome.costPerGram, 5.4); // 0 + 5 fee + 0.2 spread + 0.2 slip (defaults)
    assert.ok(event.day === "2026-08-14");
  }
});

test("session-end forced close is disabled by default (no intraday-close bias)", () => {
  const bars5 = buildBars(TWO_DAYS);
  const bars60 = buildBars(TWO_DAYS, { strideMinutes: 60 });
  const first = replayTradingDay("2026-08-14", bars5, bars60, {});
  assert.equal(first.steps, BARS_PER_DAY * 2);
  const byAction = {};
  for (const event of first.events) byAction[event.action] = (byAction[event.action] ?? 0) + 1;
  assert.equal(byAction.close_by_session_end ?? 0, 0, "default config never nudges session-end exits");
  // The rest of the engine still evaluates every step.
  assert.ok(first.events.length > 0, "other tracked actions still fire under the default config");
});

// ── 4. engine: fetch-once, cache, failure, cancel, persistence ──────────────

async function createTempEngineHarness({ failingDay = null } = {}) {
  const dir = await mkdtemp(join(tmpdir(), "goldboard-replaystats-"));
  const file = join(dir, "replay-stats.json");
  const queue = makeWriteQueue();
  const calls = [];
  const pendingHangs = [];
  // Hangs must be ARMED per run: an always-hanging stub would wedge the
  // post-abort retry too (its day fetches hit the same stub).
  const hang = { enabled: false };
  const all5 = buildBars(["2026-08-10", "2026-08-11", "2026-08-12", "2026-08-13", "2026-08-14"]);
  const all60 = buildBars(["2026-08-10", "2026-08-11", "2026-08-12", "2026-08-13", "2026-08-14"], { strideMinutes: 60 });
  const engine = createReplayStats({
    getConfig: () => ({}),
    fetchKlines: async (secid, klt, limit, endDay) => {
      calls.push(`${secid}|${klt}|${endDay}`);
      const day = `${endDay.slice(0, 4)}-${endDay.slice(4, 6)}-${endDay.slice(6, 8)}`;
      if (hang.enabled && day === "2026-08-14") {
        // Both the 5m and the 60m request can hang; track them so
        // releaseHang only returns once every wedged transport settled.
        await new Promise((resolve) => pendingHangs.push(resolve));
      }
      if (failingDay !== null && day === failingDay) throw new Error("source exploded");
      return klt === 5 ? all5 : all60;
    },
    file,
    writeQueue: queue,
    logger: { warn: () => {} },
  });
  return {
    dir, file, engine, calls, hang,
    get pendingHangs() { return pendingHangs.length; },
    releaseHang: () => { while (pendingHangs.length) pendingHangs.shift()(); },
    cleanup: () => rm(dir, { recursive: true, force: true }),
  };
}

test("engine: deterministic report, per-day fetch memo and TTL cache", async () => {
  const h = await createTempEngineHarness();
  try {
    const first = await h.engine.run({ days: 2, lane: "au9999", now: FRIDAY_NOON });
    assert.equal(first.ok, true);
    assert.equal(first.cached, false);
    // Exactly one 5m + one 60m request per day — point-in-time, no lookahead.
    assert.equal(h.calls.length, 4);
    assert.deepEqual([...new Set(h.calls.map((call) => call.split("|")[2]))].sort(),
      ["20260813", "20260814"]);
    assert.equal(first.report.daysEvaluated, 2);
    assert.equal(first.report.daysRequested, 2);
    assert.equal(first.report.window.from, "2026-08-13");

    // Same params inside the TTL → cached envelope, zero extra requests.
    const cached = await h.engine.run({ days: 2, lane: "au9999", now: FRIDAY_NOON });
    assert.equal(cached.cached, true);
    assert.deepEqual(cached.report, first.report);
    assert.equal(h.calls.length, 4);

    // force=true recomputes but the process-lifetime day memo still serves
    // already-fetched days without touching the source again.
    const forced = await h.engine.run({ days: 2, lane: "au9999", force: true, now: FRIDAY_NOON });
    assert.equal(forced.cached, false);
    assert.equal(h.calls.length, 4);
    delete forced.report.generatedAt;
    delete first.report.generatedAt;
    assert.deepEqual(forced.report, first.report);

    // Different params miss the cache and reuse the memo (still no fetches).
    const wider = await h.engine.run({ days: 3, lane: "au9999", now: FRIDAY_NOON });
    assert.equal(wider.cached, false);
    assert.equal(wider.report.daysEvaluated, 3);
    assert.equal(h.calls.length, 6); // only the newly added day hits the source
  } finally {
    await h.cleanup();
  }
});

test("engine: mid-window source failure yields a partial report with failures", async () => {
  const h = await createTempEngineHarness({ failingDay: "2026-08-14" });
  try {
    const result = await h.engine.run({ days: 2, lane: "au9999", now: FRIDAY_NOON });
    assert.equal(result.ok, true);
    assert.equal(result.report.daysEvaluated, 1);
    assert.equal(result.report.daysFailed, 1);
    assert.deepEqual(result.report.failures, [{ day: "2026-08-14", error: "source exploded" }]);
    assert.ok(result.report.daysEvaluated + result.report.daysFailed === result.report.daysRequested);
    // Completed days are still aggregated.
    assert.ok(result.report.totals.steps >= BARS_PER_DAY * 2);
  } finally {
    await h.cleanup();
  }
});

test("engine: abort stops the run between days and the engine can run again", async () => {
  const h = await createTempEngineHarness();
  try {
    const controller = new AbortController();
    h.hang.enabled = true; // wedge the day-2 transports for THIS run only
    const pending = h.engine.run({ days: 2, lane: "au9999", force: true, now: FRIDAY_NOON, signal: controller.signal });
    // First day completes, second day hangs on its fetch → abort mid-flight.
    await new Promise((resolve) => setTimeout(resolve, 50));
    controller.abort(new Error("client gone"));
    h.hang.enabled = false; // the retry below must run to completion
    h.releaseHang(); // let any wedged transport settle
    await assert.rejects(pending, (error) => error?.name === "AbortError");
    // Drain stragglers created between abort and disarm (none expected).
    h.releaseHang();
    // Single-flight cleared: a fresh run succeeds and produces a full report.
    const retry = await h.engine.run({ days: 2, lane: "au9999", force: true, now: FRIDAY_NOON });
    assert.equal(retry.ok, true);
    assert.equal(retry.report.daysEvaluated, 2);
    assert.equal(retry.report.daysFailed, 0);
    // Every wedged transport resolved; nothing is left dangling on the loop.
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(h.pendingHangs, 0);
  } finally {
    await h.cleanup();
  }
});

test("engine: report persists to replay-stats.json and last() reads it back idempotently", async () => {
  const h = await createTempEngineHarness();
  try {
    await h.engine.run({ days: 2, lane: "au9999", now: FRIDAY_NOON });
    const saved = JSON.parse(await readFile(h.file, "utf8"));
    assert.equal(saved.report.version, 2);
    assert.equal(saved.report.params.days, 2);

    const fromMemory = await h.engine.last();
    const fromDisk = await (() => {
      // A fresh engine instance (cold memory) reads the persisted report.
      const cold = createReplayStats({
        getConfig: () => ({}),
        fetchKlines: async () => [],
        file: h.file,
        writeQueue: makeWriteQueue(),
      });
      return cold.last();
    })();
    assert.deepEqual(fromDisk.report, fromMemory.report);
    // Repeated reads are idempotent.
    const again = await (() => {
      const cold = createReplayStats({
        getConfig: () => ({}),
        fetchKlines: async () => [],
        file: h.file,
        writeQueue: makeWriteQueue(),
      });
      return cold.last();
    })();
    assert.deepEqual(again, fromDisk);
    // Empty storage → explicit null report, never a throw.
    const coldEmpty = createReplayStats({ getConfig: () => ({}), fetchKlines: async () => [] });
    assert.deepEqual(await coldEmpty.last(), { ok: true, report: null });
    await new Promise((resolve) => setImmediate(resolve));
  } finally {
    await h.cleanup();
  }
});

// ── 5. eastmoney mirror fallback (added for the stats path in production) ────

test("fetchEastmoneyBars falls back to the delayed mirror when the primary is blocked", async () => {
  const registry = new SourceRegistry();
  const hosts = [];
  const previousFetch = __setFetchImpl(async (url) => {
    const text = String(url);
    if (!text.includes("kline")) throw new Error("unexpected url: " + text);
    if (text.includes("push2his.eastmoney.com")) {
      hosts.push("primary");
      throw new Error("fetch failed");
    }
    if (text.includes("push2delay.eastmoney.com")) {
      hosts.push("mirror");
      return { ok: true, text: async () => JSON.stringify({ data: { klines: ["2026-08-14 15:55,950.0,950.1,950.2,949.9,1"] } }) };
    }
    throw new Error("unexpected host");
  });
  try {
    const bars = await registry.fetchEastmoneyBars("118.AU9999", 5, 10, "20260814");
    assert.equal(bars.length, 1);
    assert.deepEqual(hosts, ["primary", "mirror"]);
  } finally {
    __setFetchImpl(previousFetch);
  }
});

test("a blocked primary cannot lock out the mirror, and mirror health is tracked separately", async () => {
  const registry = new SourceRegistry();
  // Open the PRIMARY breaker with three consecutive failures.
  for (let i = 0; i < 3; i += 1) registry.markSourceFailure("eastmoney-kline-au");
  assert.equal(registry.isCircuitOpen("eastmoney-kline-au"), true);

  const previousFetch = __setFetchImpl(async (url) => {
    const text = String(url);
    if (text.includes("push2his.eastmoney.com")) throw new Error("should be short-circuited without transport");
    if (text.includes("push2delay.eastmoney.com")) {
      return { ok: true, text: async () => JSON.stringify({ data: { klines: ["2026-08-13 15:55,950.0,950.1,950.2,949.9,1"] } }) };
    }
    throw new Error("unexpected host");
  });
  try {
    const bars = await registry.fetchEastmoneyBars("118.AU9999", 5, 10, "20260813");
    assert.equal(bars.length, 1, "mirror served despite open primary breaker");
    // Separate bookkeeping: the primary stays open (live polling protected),
    // the mirror's own breaker closed after its success.
    assert.equal(registry.isCircuitOpen("eastmoney-kline-au"), true);
    assert.equal(registry.isCircuitOpen("eastmoney-kline-au-delayed"), false);
  } finally {
    __setFetchImpl(previousFetch);
  }
});

// ── 6. CMB signal lane: replay on the persisted accumulated-gold series ─────

test("replayTradingDay lane=cmb evaluates on the CMB lane with a synthesized spread", () => {
  const bars5 = buildBars(TWO_DAYS);
  const bars60 = buildBars(TWO_DAYS, { strideMinutes: 60 });
  const cmbDay = replayTradingDay("2026-08-14", bars5, bars60, {}, { lane: "cmb" });
  const auDay = replayTradingDay("2026-08-14", bars5, bars60, {});
  // Same machinery, same step count — only the signal lane differs.
  assert.equal(cmbDay.steps, BARS_PER_DAY * 2);
  assert.equal(cmbDay.steps, auDay.steps);
  assert.ok(cmbDay.events.length > 0, "tracked actions still fire on the CMB lane");
  for (const event of cmbDay.events) {
    assert.equal(event.signalLane, "CMB");
    assert.equal(event.instrument, "CMB");
    assert.notEqual(event.action, undefined);
  }
  for (const event of auDay.events) {
    assert.equal(event.signalLane, "AU9999");
    assert.equal(event.instrument, "Au99.99");
  }
  // Deterministic per lane.
  assert.deepEqual(replayTradingDay("2026-08-14", bars5, bars60, {}, { lane: "cmb" }), cmbDay);
});

test("engine: default lane is cmb — local persisted bars replay without any kline fetches", async () => {
  const dir = await mkdtemp(join(tmpdir(), "goldboard-replaystats-cmb-"));
  try {
    const calls = [];
    const local5 = buildBars(["2026-08-12", "2026-08-13", "2026-08-14"]);
    const local60 = buildBars(["2026-08-12", "2026-08-13", "2026-08-14"], { strideMinutes: 60 });
    const engine = createReplayStats({
      getConfig: () => ({}),
      fetchKlines: async (...args) => { calls.push(args.join("|")); return []; },
      getCmbBars: () => ({ bars5: local5, bars60: local60 }),
      logger: { warn: () => {} },
    });
    const result = await engine.run({ days: 3, now: FRIDAY_NOON });
    assert.equal(result.ok, true);
    assert.equal(calls.length, 0, "CMB lane never touches the kline source");
    assert.equal(result.report.daysEvaluated, 3);
    assert.equal(result.report.daysSkippedNoData, 0);
    assert.equal(result.report.params.lane, "cmb");
    assert.ok(result.report.caveats.includes("lane-cmb-persisted-bars"), "caveat names the cmb universe");
    assert.ok(!result.report.caveats.includes("lane-au9999-only"));
    // TTL cache still applies per lane.
    const cached = await engine.run({ days: 3, now: FRIDAY_NOON });
    assert.equal(cached.cached, true);
    // Switching lanes misses the cache and falls back to the kline path.
    const auResult = await engine.run({ days: 2, lane: "au9999", now: FRIDAY_NOON });
    assert.equal(auResult.cached, false);
    assert.equal(auResult.report.params.lane, "au9999");
    assert.ok(auResult.report.caveats.includes("lane-au9999-only"));
    assert.ok(calls.length > 0, "au9999 lane uses the fetch adapter");
    // detail=true carries CMB-lane events.
    const detail = await engine.run({ days: 3, force: true, detail: true, now: FRIDAY_NOON });
    assert.ok((detail.events ?? []).length > 0);
    for (const event of detail.events) assert.equal(event.signalLane, "CMB");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("engine: CMB days beyond the persisted history are reported as skipped", async () => {
  const dir = await mkdtemp(join(tmpdir(), "goldboard-replaystats-depth-"));
  try {
    // Local history only covers the newest day; older requested days have no data.
    const local5 = buildBars(["2026-08-14"]);
    const local60 = buildBars(["2026-08-14"], { strideMinutes: 60 });
    const engine = createReplayStats({
      getConfig: () => ({}),
      fetchKlines: async () => [],
      getCmbBars: async () => ({ bars5: local5, bars60: local60 }),
      logger: { warn: () => {} },
    });
    const result = await engine.run({ days: 3, now: FRIDAY_NOON });
    assert.equal(result.report.daysRequested, 3);
    assert.equal(result.report.daysEvaluated, 1);
    assert.equal(result.report.daysSkippedNoData, 2);
    assert.ok(result.report.totals.directionalEvents >= 0);
    assert.deepEqual(result.report.failures, []);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
