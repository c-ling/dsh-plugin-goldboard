import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  DEFAULT_CONFIG,
  __setFetchImpl,
  apply,
  applySignalPolicy,
  assessSpreadPremium,
  buildLaneSwitchMessage,
  buildSnapshot,
  buildSpreadAlertMessage,
  computePlan,
  defaultSignalState,
  dispatchAlert,
  dynamicCmbSpread,
  isBearishWeaknessBar,
  laneAvailability,
  median,
  mergeConfigPatch,
  normalizeConfig,
  resolveSignalLane,
  updatePremiumHistory,
} from "../lib/testing.js";

const NOW = Date.parse("2026-08-14T02:00:00Z"); // Beijing Friday 10:00, session open
const LANE_PRIORITY = ["CMB", "XAU", "AU9999"];

function oneMinBars(now, minutes = 90, price = 950) {
  const end = Math.floor(new Date(now).getTime() / 60_000) * 60_000;
  const out = [];
  for (let i = 0; i < minutes; i += 1) {
    out.push({ t: end - i * 60_000, o: price, h: price, l: price, c: price });
  }
  return out;
}

/** `count` closed 5m buckets in chronological order; price(i) shapes bar i. */
function fiveMinBars(now, count, price) {
  const end = Math.floor(new Date(now).getTime() / (5 * 60_000)) * (5 * 60_000);
  const out = [];
  for (let i = 0; i < count; i += 1) {
    const t = end - (count - i) * 5 * 60_000; // strictly closed buckets
    out.push({ t, ...price(i) });
  }
  return out;
}

function hourlyBars(now, count, price = 950) {
  const end = Math.floor(new Date(now).getTime() / (60 * 60_000)) * (60 * 60_000);
  const out = [];
  for (let i = 0; i < count; i += 1) {
    out.push({ t: end - (i + 1) * 60 * 60_000, o: price, h: price, l: price, c: price });
  }
  return out;
}

// ── 03.1 signal-lane stickiness ─────────────────────────────────────────────

const AVAIL = {
  cmbDown: { CMB: { available: false }, XAU: { available: true }, AU9999: { available: true } },
  allUp: { CMB: { available: true }, XAU: { available: true }, AU9999: { available: true } },
};

test("resolveSignalLane resolves directly when no lane memory exists (replay/fresh boot)", () => {
  const empty = { lane: null, pendingLane: null, pendingTicks: 0 };
  const direct = resolveSignalLane(empty, AVAIL.cmbDown);
  assert.equal(direct.lane, "XAU", "highest-priority available lane wins immediately");
  assert.equal(direct.pendingTicks, 0);
  assert.equal(resolveSignalLane(empty, AVAIL.allUp).lane, "CMB");
  assert.equal(
    resolveSignalLane(empty, { CMB: { available: false }, XAU: { available: false }, AU9999: { available: false } }).lane,
    null,
  );
});

test("lane downgrade waits 3 consecutive unavailable evaluations before switching", () => {
  let laneState = { lane: "CMB", pendingLane: null, pendingTicks: 0 };
  const first = resolveSignalLane(laneState, AVAIL.cmbDown);
  assert.equal(first.lane, "CMB", "tick 1: stay on the degraded lane");
  assert.equal(first.pendingLane, "XAU");
  assert.equal(first.pendingTicks, 1);

  laneState = first;
  const second = resolveSignalLane(laneState, AVAIL.cmbDown);
  assert.equal(second.lane, "CMB", "tick 2: still waiting");
  assert.equal(second.pendingTicks, 2);

  laneState = second;
  const third = resolveSignalLane(laneState, AVAIL.cmbDown);
  assert.equal(third.lane, "XAU", "tick 3: switch confirmed");
  assert.equal(third.switchedTo, "XAU", "edge emitted exactly on the switch tick");
  assert.equal(third.pendingLane, null);
  assert.equal(third.pendingTicks, 0);
});

test("a single flapping CMB failure never flips the lane", () => {
  let laneState = { lane: "CMB", pendingLane: null, pendingTicks: 0 };
  for (let i = 0; i < 10; i += 1) {
    laneState = resolveSignalLane(laneState, i % 2 === 0 ? AVAIL.cmbDown : AVAIL.allUp);
    assert.equal(laneState.lane, "CMB", `tick ${i}: lane unchanged on flapping input`);
    assert.ok(laneState.pendingTicks <= 1, `tick ${i}: counter resets when the lane recovers`);
  }
});

test("lane recovery needs 3 consecutive good evaluations and is a silent upgrade-reversal", () => {
  let laneState = { lane: "XAU", pendingLane: null, pendingTicks: 0 };
  let decision = null;
  for (let tick = 1; tick <= 3; tick += 1) {
    decision = resolveSignalLane(laneState, AVAIL.allUp);
    laneState = decision;
    if (tick < 3) {
      assert.equal(decision.lane, "XAU", `recovery tick ${tick}: not yet`);
      assert.equal(decision.pendingLane, "CMB");
      assert.equal(decision.pendingTicks, tick);
    }
  }
  assert.equal(decision.lane, "CMB", "recovery tick 3: switched back");
  assert.equal(decision.switchedTo, "CMB");
  // evaluateAlerts only notifies downgrades (priority index grows); the
  // recovery edge points at a higher-priority lane and must stay silent.
  const downgradeEdge = resolveSignalLane({ lane: "CMB", pendingLane: "XAU", pendingTicks: 2 }, AVAIL.cmbDown);
  assert.ok(LANE_PRIORITY.indexOf(decision.switchedTo) < LANE_PRIORITY.indexOf("XAU"), "recovery is an upgrade");
  assert.ok(LANE_PRIORITY.indexOf(downgradeEdge.switchedTo) > LANE_PRIORITY.indexOf("CMB"), "degrade is a downgrade");
});

test("closed market freezes lane evaluation (no counting, no switching)", () => {
  const decision = resolveSignalLane(
    { lane: "CMB", pendingLane: "XAU", pendingTicks: 2 },
    AVAIL.cmbDown,
    { marketOpen: false },
  );
  assert.equal(decision.lane, "CMB");
  assert.equal(decision.pendingLane, null, "pending counter cleared while closed");
  assert.equal(decision.pendingTicks, 0);
});

test("computePlan carries signal_lane_degraded through data gates and switches after 3 ticks", () => {
  const now = new Date(NOW);
  const runtime = {
    // Established XAU lane whose quote vanished; Au99.99 still healthy.
    laneState: { lane: "XAU", pendingLane: null, pendingTicks: 0 },
    quotes: {
      AU9999: { price: 950, bid: 949.9, ask: 950.1, source: "sina", updatedAt: NOW },
      XAU: null,
      USDCNY: null,
    },
    bars: {
      AU9999: { 1: oneMinBars(NOW, 90), 5: [], 60: [] },
      XAU: { 1: [], 5: [], 60: [] },
      CMB: { 1: [], 5: [], 60: [] },
    },
    signalState: { ...defaultSignalState(), buyStreak: 2, sellStreak: 1 },
  };
  const first = computePlan(runtime, DEFAULT_CONFIG, now);
  assert.equal(first.signalLane, "XAU", "pending window keeps the established lane");
  assert.ok(first.reasonCodes.includes("signal_lane_degraded"), "degraded marker survives the data gate");

  computePlan(runtime, DEFAULT_CONFIG, now);
  const third = computePlan(runtime, DEFAULT_CONFIG, now);
  assert.equal(third.signalLane, "AU9999", "third consecutive unavailable evaluation switches");
  assert.equal(third.laneSwitchedFrom, "XAU", "switch edge carries the previous lane");
  assert.equal(third.instrument, "Au99.99");
  assert.equal(third.signalState.buyStreak, 0, "streaks are reset after the lane change");
  assert.equal(third.signalState.sellStreak, 0);

  const zh = buildLaneSwitchMessage(third, "zh");
  assert.equal(zh.action, "lane_switched");
  assert.match(zh.body, /Au99\.99/);
  assert.match(buildLaneSwitchMessage(third, "en").body, /switched/);
});

test("applySignalPolicy resets streaks when the plan instrument changes lanes", () => {
  const armed = { ...defaultSignalState(), instrument: "CMB", buyStreak: 3, sellStreak: 0 };
  const plan = { action: "wait", instrument: "XAU", marketState: "open", reasonCodes: [] };
  const { signalState } = applySignalPolicy(plan, armed, normalizeConfig({}), new Date(NOW));
  assert.equal(signalState.buyStreak, 0, "counts from the previous lane never carry over");
});

// ── 03.2 sell_weakness & spread_alert ───────────────────────────────────────

test("isBearishWeaknessBar detects bearish engulfing on a known bar sequence", () => {
  const prev = { o: 970.5, h: 971.2, l: 970, c: 971 }; // bullish
  const engulfing = { o: 971.4, h: 971.8, l: 969.8, c: 970 }; // bearish engulfing
  const detected = isBearishWeaknessBar(engulfing, prev, 1.0, { shadowAtrMult: 1.0 });
  assert.equal(detected.engulfing, true);
  assert.equal(detected.weakness, true);

  const neutral = isBearishWeaknessBar({ o: 970.2, h: 970.6, l: 969.9, c: 970.4 }, engulfing, 1.0, { shadowAtrMult: 1.0 });
  assert.equal(neutral.engulfing, false, "a bullish bar never engulfs");

  // Body edges touching exactly still count (classic relaxed engulfing).
  const touching = isBearishWeaknessBar({ o: 971, h: 971.5, l: 969.5, c: 969.5 }, prev, 1.0, { shadowAtrMult: 1.0 });
  assert.equal(touching.engulfing, true);

  assert.deepEqual(isBearishWeaknessBar(null, prev, 1), { engulfing: false, longUpperShadow: false, weakness: false });
});

test("isBearishWeaknessBar flags an upper shadow beyond atr × multiplier only", () => {
  const last = { o: 970, h: 973.5, l: 969.8, c: 969.9 }; // upper shadow 3.5
  const strong = isBearishWeaknessBar(last, null, 1.0, { shadowAtrMult: 1.0 });
  assert.equal(strong.longUpperShadow, true);
  assert.equal(strong.engulfing, false);
  assert.equal(strong.weakness, true);

  const weakAtr = isBearishWeaknessBar(last, null, 4.0, { shadowAtrMult: 1.0 }); // 3.5 ≤ atr 4
  assert.equal(weakAtr.longUpperShadow, false);
  assert.equal(weakAtr.weakness, false, "neither condition → no weakness");

  const bigMultiplier = isBearishWeaknessBar(last, null, 2.0, { shadowAtrMult: 2.0 }); // needs > 4
  assert.equal(bigMultiplier.longUpperShadow, false);
});

test("sell_weakness fires on RSI overbought + engulfing bar and sizes a band reduce", () => {
  const now = new Date(NOW);
  // Rising series keeps RSI14 high; the last two closed bars form a bearish
  // engulfing pair with only a small close-delta loss so RSI stays above the
  // default weaknessRsi=75. The position is underwater, so the profit-gated
  // exits upstream (take-profit / reduce_position / sell_trailing) cannot
  // preempt the protective trim. 130 bars keep the resampled 30m set warm.
  const climb = fiveMinBars(NOW, 130, (i) => {
    const base = 930 + i * 0.4;
    return { o: base, h: base + 0.3, l: base - 0.2, c: base + 0.2 };
  });
  const pb = 930 + (climb.length - 2) * 0.4;
  climb[climb.length - 2] = { t: climb[climb.length - 2].t, o: pb, h: pb + 0.4, l: pb - 0.2, c: pb + 0.4 };
  climb[climb.length - 1] = { t: climb[climb.length - 1].t, o: pb + 0.5, h: pb + 0.8, l: pb - 0.6, c: pb };
  const lastClose = climb[climb.length - 1].c;

  const runtime = {
    quotes: {
      AU9999: { price: lastClose, bid: lastClose - 0.1, ask: lastClose + 0.1, source: "sina", updatedAt: NOW },
      XAU: null,
      USDCNY: null,
    },
    bars: {
      AU9999: { 1: oneMinBars(NOW, 90, lastClose), 5: climb, 60: hourlyBars(NOW, 80, lastClose - 5) },
      XAU: { 1: [], 5: [], 60: [] },
      CMB: { 1: [], 5: [], 60: [] },
    },
  };
  const config = normalizeConfig({
    position: { grams: 10, avgCostPerGram: 990 },
    fee: { sellPerGram: 0 },
    strategy: { confirmBars: 1, maxLossPerGram: 100 },
  });
  const plan = computePlan(runtime, config, now);
  assert.equal(plan.action, "sell_weakness", `expected weakness exit, got ${plan.action}: ${plan.reasonCodes.join(",")}`);
  assert.ok(plan.reasonCodes.includes("weakness_rsi_overbought"));
  assert.ok(plan.reasonCodes.includes("bearish_engulfing"));
  assert.equal(plan.suggestedOrder.side, "sell");
  assert.equal(plan.suggestedOrder.action, "sell_weakness");
  assert.ok(plan.suggestedOrder.grams > 0 && plan.suggestedOrder.grams < 10, "band reduce keeps a base position");

  // Below the RSI threshold the same bar pattern stays silent.
  const calmConfig = normalizeConfig({
    position: { grams: 10, avgCostPerGram: 990 },
    fee: { sellPerGram: 0 },
    strategy: { confirmBars: 1, weaknessRsi: 99, maxLossPerGram: 100 },
  });
  const calmPlan = computePlan(runtime, calmConfig, now);
  assert.notEqual(calmPlan.action, "sell_weakness");
});

test("assessSpreadPremium flags a >2σ day, stays quiet inside the band, and needs 20 days", () => {
  const history = [];
  for (let day = 1; day <= 25; day += 1) {
    history.push({ date: `2026-07-${String(day).padStart(2, "0")}`, premiumPerGram: day % 2 === 0 ? 12 : 8 }); // mean 10, σ 2
  }
  const quiet = assessSpreadPremium(history, 10.5);
  assert.equal(quiet.ready, true);
  assert.equal(quiet.anomaly, false);
  assert.equal(quiet.mean, 9.92); // 13×8 + 12×12 over 25 days
  assert.equal(quiet.sigma, 2);

  const breakout = assessSpreadPremium(history, 15.5); // |15.5 − 9.92| ≈ 2.79σ
  assert.equal(breakout.anomaly, true);
  assert.ok(breakout.deviationSigma > 2);

  const short = assessSpreadPremium(history.slice(0, 19), 15.5);
  assert.equal(short.ready, false, "below 20 completed days only warns");
  assert.equal(short.anomaly, false);

  const message = buildSpreadAlertMessage({ derivedPremiumToday: 15.5 }, breakout, "zh");
  assert.equal(message.action, "spread_alert");
  assert.match(message.body, /15\.5/);
  assert.match(buildSpreadAlertMessage({ derivedPremiumToday: 15.5 }, breakout, "en").body, /deviates/);
});

test("updatePremiumHistory keeps one running-median entry per day and rolls at 60", () => {
  let history = [];
  history = updatePremiumHistory(history, "2026-08-13", [10, 14]);
  assert.equal(history.length, 1);
  assert.equal(history[0].premiumPerGram, 12, "median of the day's samples");
  history = updatePremiumHistory(history, "2026-08-13", [10, 14, 100]);
  assert.equal(history[0].premiumPerGram, 14, "running median updates within the day");
  history = updatePremiumHistory(history, "2026-08-14", [8]);
  assert.equal(history.length, 2);
  history = updatePremiumHistory(history, "2026-08-14", []);
  assert.equal(history.length, 1, "an empty sample list drops today's provisional entry");

  const baseMs = Date.parse("2026-08-14T00:00:00Z");
  for (let offset = 0; offset < 65; offset += 1) {
    const date = new Date(baseMs + offset * 86_400_000).toISOString().slice(0, 10);
    history = updatePremiumHistory(history, date, [offset + 1]);
  }
  assert.equal(history.length, 60, "rolling cap of 60 daily entries");
  assert.equal(history[0].date, "2026-08-19", "oldest entries dropped first");
});

// ── 03.3 dynamic CMB spread ─────────────────────────────────────────────────

test("dynamicCmbSpread needs 30 fresh samples and preserves buy/sell offsets", () => {
  const now = Date.now();
  const freshSample = (spreadMid) => ({ t: now - 60_000, spreadMid });
  assert.equal(dynamicCmbSpread([freshSample(1), freshSample(1.1)], now, 1.72), null, "below 30 samples → static");

  const legacy = Array.from({ length: 30 }, (_, i) => ({ t: now - (i + 1) * 60_000, spreadMid: i < 15 ? 1.0 : 1.2 }));
  const active = dynamicCmbSpread(legacy, now, 1.72);
  assert.equal(active.spread, 1.1, "legacy median remains readable");
  assert.equal(active.buyOffset, 1.1);
  assert.equal(active.sellOffset, 1.1);
  assert.equal(active.legacy, true);
  assert.equal(active.sampleCount, 30);

  const sides = Array.from({ length: 30 }, (_, index) => ({
    t: now - (index + 1) * 60_000,
    buyOffset: 2.5,
    sellOffset: -2.5,
    spreadMid: 0,
    sources: { cmb: "cmb", xau: index % 2 ? "tencent" : "sina", usdcny: "tencent" },
  }));
  const sideResult = dynamicCmbSpread(sides, now, { buyOffset: 1.72, sellOffset: 1.72 });
  assert.equal(sideResult.buyOffset, 2.5);
  assert.equal(sideResult.sellOffset, -2.5);
  assert.equal(sideResult.legacy, false);
  assert.equal(sideResult.calibration.sampleCount, 30);
  assert.equal(sideResult.calibration.from, new Date(now - 30 * 60_000).toISOString());
  assert.equal(sideResult.calibration.to, new Date(now - 60_000).toISOString());
  assert.deepEqual(sideResult.calibration.sources, {
    cmb: ["cmb"],
    xau: ["sina", "tencent"],
    usdcny: ["tencent"],
  });

  const zeroAnchor = dynamicCmbSpread(
    Array.from({ length: 30 }, () => ({ t: now - 60_000, buyOffset: 2.5, sellOffset: -2.5 })),
    now,
    { buyOffset: 0, sellOffset: 0 },
  );
  assert.equal(zeroAnchor.buyOffset, 2.5, "zero static offset does not erase calibration");
  assert.equal(zeroAnchor.sellOffset, -2.5);

  const huge = dynamicCmbSpread(Array.from({ length: 30 }, () => freshSample(99)), now, 1.72);
  assert.equal(huge.spread, 5.16, "pathological legacy median stays bounded");
});

test("spread samples expire after the TTL and fall back to the static estimate", () => {
  const now = Date.now();
  const stale = Array.from({ length: 40 }, (_, i) => ({
    t: now - 7 * 60 * 60 * 1000 - i * 60_000,
    spreadMid: 1.0,
  }));
  assert.equal(dynamicCmbSpread(stale, now, 1.72), null, "all samples older than 6h → null");

  const mixed = [
    ...stale,
    ...Array.from({ length: 31 }, (_, i) => ({ t: now - i * 60_000, spreadMid: 1.4 })),
  ];
  assert.equal(dynamicCmbSpread(mixed, now, 1.72).spread, 1.4, "only the fresh window drives the estimate");
});

function cmbFallbackRuntime(samples) {
  return {
    quotes: {
      AU9999: null,
      CMB: null,
      XAU: { price: 4375.8, source: "test", updatedAt: NOW },
      USDCNY: { price: 6.7421, source: "test", updatedAt: NOW },
    },
    bars: { AU9999: { 1: [], 5: [], 60: [] }, XAU: { 1: oneMinBars(NOW, 90), 5: [], 60: [] }, CMB: { 1: [], 5: [], 60: [] } },
    cmbSpreadSamples: samples,
  };
}

test("snapshot reports spreadSource/spreadSampleCount for dynamic and static fallback plus live", () => {
  const now = new Date(NOW);
  const xauCny = 948.51; // matches the calibrated fixture used across tests

  const staticSnap = buildSnapshot(cmbFallbackRuntime([]), DEFAULT_CONFIG, now);
  assert.equal(staticSnap.derived.cmb.spreadSource, "static");
  assert.equal(staticSnap.derived.cmb.spreadSampleCount, 0);
  assert.equal(staticSnap.derived.cmb.buyPrice, roundPrice(xauCny + 1.72));
  assert.equal(staticSnap.derived.cmb.sourceNote, "cmb-synthetic-bid-ask");
  assert.equal(staticSnap.derived.cmb.calibration.method, "static-config");
  assert.equal(staticSnap.derived.cmb.calibration.sampleCount, 0);

  const samples = Array.from({ length: 31 }, (_, i) => ({ t: NOW - (i + 1) * 60_000, spreadMid: 1.0 }));
  const dynamicSnap = buildSnapshot(cmbFallbackRuntime(samples), DEFAULT_CONFIG, now);
  assert.equal(dynamicSnap.derived.cmb.spreadSource, "dynamic-legacy");
  assert.equal(dynamicSnap.derived.cmb.spreadSampleCount, 31);
  assert.equal(dynamicSnap.derived.cmb.buyPrice, roundPrice(xauCny + 1.0));
  assert.equal(dynamicSnap.derived.cmb.sourceNote, "cmb-synthetic-bid-ask");
  assert.equal(dynamicSnap.derived.cmb.calibration.method, "median-legacy-mid-offset");
  assert.equal(dynamicSnap.derived.cmb.calibration.sampleCount, 31);

  const liveRuntime = cmbFallbackRuntime([]);
  liveRuntime.quotes.XAU = null;
  liveRuntime.quotes.USDCNY = null;
  liveRuntime.quotes.CMB = { price: 952, buyPrice: 952, sellPrice: 950, source: "cmb", updatedAt: NOW };
  const liveSnap = buildSnapshot(liveRuntime, DEFAULT_CONFIG, now);
  assert.equal(liveSnap.derived.cmb.spreadSource, "live");
  assert.equal(liveSnap.derived.cmb.sourceNote, "cmb-live-bid-ask");
  assert.equal(liveSnap.plan.signalLane, "CMB", "snapshot exposes the resolved signal lane");
});

function roundPrice(value) {
  return Math.round(value * 100) / 100;
}

// ── 03.4 route error envelope ───────────────────────────────────────────────

function bufferReq(method, payload) {
  const chunks = payload === undefined ? [] : [Buffer.from(JSON.stringify(payload))];
  return {
    method,
    headers: {},
    async *[Symbol.asyncIterator]() {
      yield* chunks;
    },
  };
}

function resCapture() {
  return {
    status: 0,
    headers: null,
    body: null,
    writeHead(status, headers) {
      this.status = status;
      this.headers = headers;
    },
    end(body) {
      this.body = body;
    },
  };
}

async function withPluginRoutes(configOverrides, run) {
  const dir = await mkdtemp(join(tmpdir(), "goldboard-plan03-"));
  try {
    const routes = [];
    const ctx = {
      logger: { warn: () => {} },
      effect: (fn, label) => {
        if (String(label ?? "").includes("route")) fn();
        return () => {};
      },
      webServer: {
        register: (route) => {
          routes.push(route);
        },
      },
    };
    const runtime = apply(ctx, { directory: dir, pollMs: 600_000, ...configOverrides });
    return await run(routes, runtime);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

test("a route handler exception answers with the 500 INTERNAL_ERROR envelope", async () => {
  await withPluginRoutes({}, async (routes, runtime) => {
    const snapshotRoute = routes.find((route) => route.path === "/dsh-plugin-goldboard/snapshot");
    assert.ok(snapshotRoute);
    // Inject a failing dependency: any read of runtime.quotes throws before
    // the snapshot can be built. Without the wrapper the harness would answer
    // a bare 400 with no JSON body; the handler must produce the envelope.
    Object.defineProperty(runtime, "quotes", {
      configurable: true,
      get() {
        throw new Error("boom-injected");
      },
    });
    const res = resCapture();
    await assert.doesNotReject(() => snapshotRoute.handler(
      { method: "GET", url: "/dsh-plugin-goldboard/snapshot", headers: {} },
      res,
    ));
    assert.equal(res.status, 500);
    const body = JSON.parse(res.body);
    assert.equal(body.ok, false);
    assert.equal(body.error.code, "INTERNAL_ERROR");
    assert.match(body.error.message, /boom-injected/);
    assert.doesNotMatch(body.error.message, /\n\s+at /, "no stack trace leaks into the message");
  });
});

// ── 03.5 config deep merge ──────────────────────────────────────────────────

test("mergeConfigPatch merges sections field-level and rejects unknown top-level keys", () => {
  const stored = normalizeConfig({
    webhooks: {
      feishu: { enabled: false, url: "https://feishu.old/hook" },
      dingtalk: { enabled: true, url: "https://ding.example/hook" },
    },
    strategy: { confirmBars: 3, scoreThreshold: 6 },
  });
  const merged = mergeConfigPatch(stored, {
    webhooks: { feishu: { enabled: true } },
    strategy: { confirmBars: 5 },
  });
  assert.equal(merged.webhooks.feishu.enabled, true);
  assert.equal(merged.webhooks.feishu.url, "https://feishu.old/hook", "untouched sibling fields survive");
  assert.equal(merged.webhooks.dingtalk.enabled, true, "absent channel section survives");
  assert.equal(merged.webhooks.dingtalk.url, "https://ding.example/hook");
  assert.equal(merged.strategy.confirmBars, 5);
  assert.equal(merged.strategy.scoreThreshold, 6, "sibling strategy fields survive");
  assert.deepEqual(merged.webhooks.generic, [], "absent array section survives from the stored config");

  assert.throws(
    () => mergeConfigPatch(stored, { bogusSection: {} }),
    (error) => error.code === "UNKNOWN_CONFIG_KEY",
  );

  const withLots = mergeConfigPatch(stored, { position: { lots: [{ grams: 3, price: 950 }] } });
  assert.equal(withLots.position.lots.length, 1, "arrays replace wholesale");
});

test("POST /config keeps sibling channels on a partial payload and 400s on unknown keys", async () => {
  await withPluginRoutes({
    webhooks: { dingtalk: { enabled: true, url: "https://ding.example/hook" } },
  }, async (routes) => {
    const configRoute = routes.find((route) => route.path === "/dsh-plugin-goldboard/config");
    assert.ok(configRoute);

    const partialRes = resCapture();
    await configRoute.handler(bufferReq("POST", { config: { webhooks: { feishu: { enabled: true } } } }), partialRes);
    assert.equal(partialRes.status, 200);
    const partialBody = JSON.parse(partialRes.body);
    assert.equal(partialBody.ok, true);
    assert.equal(partialBody.config.webhooks.feishu.enabled, true);
    assert.equal(partialBody.config.webhooks.dingtalk.enabled, true, "dingtalk survives the partial write");
    assert.equal(partialBody.config.webhooks.dingtalk.url, "https://ding.example/hook");

    const unknownRes = resCapture();
    await configRoute.handler(bufferReq("POST", { config: { notASection: true } }), unknownRes);
    assert.equal(unknownRes.status, 400);
    assert.equal(JSON.parse(unknownRes.body).error.code, "UNKNOWN_CONFIG_KEY");

    const getRes = resCapture();
    await configRoute.handler({ method: "GET", headers: {} }, getRes);
    assert.equal(getRes.status, 200);
    assert.equal(JSON.parse(getRes.body).config.strategy.weaknessRsi, 75, "new strategy defaults exposed");
  });
});

// ── 03.6 dispatchAlert channel results ──────────────────────────────────────

test("dispatchAlert reports one-ok-one-fail channel outcomes for the alerts log", async () => {
  const config = normalizeConfig({
    system: { enabled: false },
    webhooks: {
      feishu: { enabled: true, url: "https://feishu.example/hook" },
      generic: [{ id: "g1", name: "mirror", enabled: true, url: "https://generic.example/hook" }],
    },
  });
  const post = async (url) => {
    if (String(url).includes("feishu.example")) throw new Error("gateway 502");
    return { ok: true, status: 200, text: async () => "{}", arrayBuffer: async () => Buffer.from("{}") };
  };
  const warnings = [];
  const results = await dispatchAlert(
    config,
    { title: "t", body: "b", params: {} },
    { warn: (line) => warnings.push(line) },
    {
      post,
      genericLookup: async () => [{ address: "93.184.216.34", family: 4 }],
      genericTransport: async () => ({ ok: true, status: 200, text: async () => "{}" }),
    },
  );
  assert.deepEqual(results.map((entry) => [entry.channel, entry.ok]), [
    ["feishu", false],
    ["generic:g1", true],
  ]);
  assert.match(results[0].error, /502/);
  assert.equal(results[1].error, undefined);
  assert.equal(warnings.length, 1, "failures still logged as warnings");
});

// ── helpers ─────────────────────────────────────────────────────────────────

test("median helper handles odd/even/invalid input", () => {
  assert.equal(median([3, 1, 2]), 2);
  assert.equal(median([4, 1, 2, 3]), 2.5);
  assert.equal(median([]), null);
  assert.equal(median(["x", null, 5]), 5);
});

test("laneAvailability mirrors quote validity and lane health", () => {
  const healthy = laneAvailability({
    quotes: {
      CMB: { buyPrice: 952, sellPrice: 950, updatedAt: NOW },
      XAU: { price: 4375.8, market: "spot", source: "test", updatedAt: NOW },
      USDCNY: { price: 6.7421, updatedAt: NOW },
      AU9999: { price: 951, updatedAt: NOW },
    },
    laneHealth: { CMB: { ok: true } },
  }, new Date(NOW));
  assert.equal(healthy.CMB.available, true);
  assert.equal(healthy.XAU.available, true);
  assert.equal(healthy.AU9999.available, true);

  const sick = laneAvailability({
    quotes: { CMB: { buyPrice: 952, sellPrice: 950, updatedAt: NOW } },
    laneHealth: { CMB: { ok: false } },
  });
  assert.equal(sick.CMB.available, false, "failed fetch marks the lane unavailable despite a cached quote");
  assert.equal(sick.cmbQuoteValid, true, "cached quote stays valid for the pending window");
});
