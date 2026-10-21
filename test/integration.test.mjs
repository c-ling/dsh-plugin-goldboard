/**
 * plan-05 integration suite: drives the real apply() composition root with a
 * fake harness ctx (captured effects + collected routes), an injectable fetch
 * transport and a scripted LLM stub, then exercises the full host surface —
 * init/state restore, snapshot caching, config CRUD in both settings modes,
 * circuit-breaker degradation, alert edges, analysis runs, manual CMB bars,
 * the golden replay fixture and the awaited dispose flush.
 */

import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  BARS_SEED_VERSION,
  CALENDAR_VERSIONS,
  EXECUTION_MODEL_VERSION,
  MARKET_DATA_SCHEMA_VERSION,
  RISK_CONFIG_VERSION,
  SIGNAL_LEDGER_VERSION,
  STATE_SCHEMA_VERSION,
  __setFetchImpl,
  apply,
} from "../lib/testing.js";
import { buildGoldenConfig, buildGoldenInput } from "../tools/capture-golden-snapshot.mjs";

// ── harness ─────────────────────────────────────────────────────────────────

/** Sina domestic quote line stamped inside a frozen Friday session. */
const SESSION_DAY = "2026-08-14"; // Beijing Friday
function sinaLine(price) {
  return `var hq_str_gds_AU9999="${price},0,${price - 2},${price + 0.5},${price + 3},${price - 5},12:00:00,940.72,${price - 2},2282,301.00,1.00,${SESSION_DAY},沪金99";`;
}

async function drain(ms = 30) {
  for (let i = 0; i < 25; i += 1) await new Promise((resolve) => setImmediate(resolve));
  if (ms > 0) await new Promise((resolve) => setTimeout(resolve, ms));
}

async function rmRetry(path) {
  for (let attempt = 0; attempt < 5; attempt += 1) {
    try {
      await rm(path, { recursive: true, force: true });
      return;
    } catch (error) {
      if (error?.code !== "ENOTEMPTY" || attempt === 4) throw error;
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
  }
}

/** Freeze Date (+ optionally setInterval) at Beijing Friday 12:00, session open. */
function freezeSession(t, { intervals = false } = {}) {
  const clock = t.mock.timers;
  clock.enable({ apis: intervals ? ["Date", "setInterval"] : ["Date"], now: Date.parse(`${SESSION_DAY}T04:00:00Z`) });
  t.after(() => clock.reset());
  return clock;
}

/** Minimal SettingsProvider stand-in (same shape as the plan-04 suite fake). */
/**
 * Boot one plugin instance against a temp dir. Returns the runtime, collected
 * Fetch routes and an awaited dispose.
 */
async function boot(options = {}) {
  const dir = options.dir ?? await mkdtemp(join(tmpdir(), "goldboard-int-"));
  if (typeof options.prestore === "function") await options.prestore(dir);
  const routes = new Map();
  const disposers = [];
  const warnings = [];

  const ctx = {
    logger: { warn: (line) => warnings.push(line), info: () => {} },
    llm: options.llm ?? undefined,
    effect: (fn) => {
      const dispose = fn();
      disposers.push(typeof dispose === "function" ? dispose : () => {});
      return () => typeof dispose === "function" && dispose();
    },
    connection: {
      fetch: {
        register(route) {
          routes.set(route.path, route);
          return async () => {};
        },
      },
    },
  };

  const entryConfig = { directory: dir, pollMs: 600_000, ...(options.config ?? {}) };
  const runtime = apply(ctx, entryConfig);
  await drain(80); // let init() + first tick settle

  async function call(path, method, reqOptions = {}) {
    const fullPath = path.startsWith("/api/") ? path : "/api" + path;
    const route = routes.get(fullPath);
    if (!route) throw new Error(`no route registered: ${fullPath}`);
    const rawUrl = reqOptions.url ?? fullPath;
    const url = new URL("http://local" + (rawUrl.startsWith("/api/") ? rawUrl : "/api" + rawUrl));
    const headers = { ...(reqOptions.headers ?? {}) };
    const init = { method, headers };
    if (reqOptions.body !== null && reqOptions.body !== undefined) {
      init.body = typeof reqOptions.body === "string" ? reqOptions.body : JSON.stringify(reqOptions.body);
      if (!headers["content-type"]) headers["content-type"] = "application/json";
    }
    const response = await route.fetch(new Request(url, init));
    const text = await response.text();
    let body = null;
    if (text !== "") {
      try { body = JSON.parse(text); } catch { body = text; }
    }
    return { status: response.status, body, headers: response.headers };
  }

  const dispose = async () => {
    while (disposers.length) await disposers.shift()();
  };

  return { dir, ctx, runtime, routes, warnings, call, dispose };
}

/** A scripted llm stub covering the AnalysisModule call surface. */
function llmStub(scriptedText) {
  return {
    listProviders: () => [{ id: "stub", name: "Stub", source: { kind: "builtin" } }],
    listModels: async () => [{ id: "stub-model", name: "Stub Model" }],
    resolveModelInfo: async (provider, model) => ({ id: model, reasoning: { efforts: [{ id: "low" }] } }),
    async prepareCall(proposal) {
      return {
        config: {},
        stream: async function* () {
          yield { type: "text-delta", index: 0, text: typeof scriptedText === "function" ? scriptedText(proposal) : scriptedText };
          yield { type: "finish", reason: { kind: "stop" } };
        },
      };
    },
  };
}

const VALID_ANALYSIS_JSON = JSON.stringify({
  status: "insufficient_data",
  bias: "neutral",
  horizon: "intraday",
  action: "wait",
  confidence: "low",
  summary: "数据仍在积累，暂时观望。",
  evidence: ["覆盖率不足"],
  support: [950],
  resistance: [960],
  reassessWhen: ["覆盖率达到门槛"],
  invalidations: ["价格跌破支撑"],
  dataWarnings: ["5m 覆盖率不足"],
  suggestedOrder: null,
  riskDisclosure: "技术面参考，非投资建议。",
});

// ── 1. cold start init: seed aggregation + barsSeedVersion round-trip ───────

test("integration: cold start seeds lanes with true OHLC aggregation and persists barsSeedVersion=2", async (t) => {
  freezeSession(t);
  const previousFetch = __setFetchImpl(async (url) => {
    if (String(url).includes("kline")) {
      // Eastmoney kline CSV rows: date,open,close,high,low,volume — two full
      // hours of 5m bars ending well before now.
      const asOf = Date.now();
      const rows = [];
      for (let i = 24; i >= 1; i -= 1) {
        const t5 = asOf - i * 5 * 60_000;
        const base = 950;
        rows.push([
          new Date(t5).toLocaleString("sv-SE", { timeZone: "Asia/Shanghai" }).slice(0, 16),
          base, base + 0.08, base + 0.12, base - 0.05, 1,
        ].join(","));
      }
      return { ok: true, text: async () => JSON.stringify({ data: { klines: rows } }) };
    }
    if (String(url).includes("hq.sinajs.cn")) {
      const line = sinaLine("951.50");
      return { ok: true, arrayBuffer: async () => Buffer.from(line, "utf8"), text: async () => line };
    }
    throw new Error("source unavailable in test");
  });
  t.after(() => __setFetchImpl(previousFetch));

  const h = await boot({ config: {} });
  t.after(() => h.dispose());
  await h.dispose(); // awaited final flush → state.json written
  const state = JSON.parse(await readFile(join(h.dir, "state.json"), "utf8"));
  assert.equal(state.barsSeedVersion, BARS_SEED_VERSION, "seed version round-trips");
  const bars5 = state.bars.AU9999[5];
  assert.ok(bars5.length >= 18, `SGE-session 5m lane seeded (${bars5.length})`);
  assert.equal(bars5[0].synthetic, false, "seeded bars are real klines");
  // True OHLC aggregation over the 60m buckets built by aggregateSubBars.
  const bars60 = state.bars.AU9999[60];
  assert.ok(bars60.length >= 2, `60m lane aggregated (${bars60.length})`);
  for (const bucket of bars60) {
    const members = bars5.filter((bar) => bar.t >= bucket.t && bar.t < bucket.t + 3_600_000);
    assert.ok(members.length > 0, "bucket has sub-bars");
    assert.equal(bucket.o, members[0].o, "open = first sub-bar open");
    assert.equal(bucket.h, Math.max(...members.map((bar) => bar.h)), "high = max high");
    assert.equal(bucket.l, Math.min(...members.map((bar) => bar.l)), "low = min low");
    assert.equal(bucket.c, members[members.length - 1].c, "close = last sub-bar close");
  }
});

// ── 2. legacy state boot: seed-version invalidation ─────────────────────────

test("integration: legacy state without barsSeedVersion drops the corrupt intraday lanes on boot", async (t) => {
  freezeSession(t);
  const corrupt60m = [{ t: Date.parse(`${SESSION_DAY}T03:00:00Z`), o: 1, h: 1, l: 1, c: 1 }];
  const good5m = [{ t: Date.parse(`${SESSION_DAY}T03:00:00Z`), o: 950, h: 951, l: 949, c: 950.5 }];
  const dir = await mkdtemp(join(tmpdir(), "goldboard-int-legacy-"));
  await writeFile(join(dir, "state.json"), JSON.stringify({
    quotes: {},
    bars: { AU9999: { 5: good5m, 60: corrupt60m }, XAU: {}, GCF: {}, CMB: {} },
    // no barsSeedVersion → pre-plan-01 format
    alertState: {},
  }), "utf8");
  const previousFetch = __setFetchImpl(async () => { throw new Error("no network in test"); });
  t.after(() => __setFetchImpl(previousFetch));

  const h = await boot({ config: { directory: dir } });
  t.after(async () => {
    await h.dispose();
    await rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 });
  });
  const snap = await h.call("/dsh-plugin-goldboard/snapshot", "GET");
  assert.equal(snap.status, 200);
  assert.equal(snap.body.ok, true);
  // Both seeded series of the affected lanes are discarded so the fixed
  // seedBars rebuilds them on the next tick with network access.
  assert.equal(h.runtime.bars.AU9999[60].length, 0, "stale-format 60m buckets discarded");
  assert.equal(h.runtime.bars.AU9999[5].length, 0, "stale-format 5m lane discarded for rebuild");
});

// ── 3. /snapshot: contract, 2s cache hit, locale header not persisted ───────

test("integration: /snapshot serves a cached payload for bursts and never persists localeHint", async (t) => {
  freezeSession(t);
  const previousFetch = __setFetchImpl(async () => { throw new Error("no network in test"); });
  t.after(() => __setFetchImpl(previousFetch));
  const h = await boot({ config: {} });
  t.after(() => h.dispose());

  const first = await h.call("/dsh-plugin-goldboard/snapshot", "GET", { headers: { "x-dsh-locale": "en" } });
  assert.equal(first.status, 200);
  assert.equal(first.body.ok, true);
  for (const key of ["serverTime", "market", "quotes", "trend", "plan", "quality", "derived", "risk", "ledger"]) {
    assert.ok(key in first.body, `snapshot carries ${key}`);
  }
  assert.equal(h.runtime.localeHint, "en");

  const ledgerBeforeRead = JSON.stringify(h.runtime.signalLedger);
  const laneBeforeRead = JSON.stringify(h.runtime.laneState);
  h.runtime.lastSnapshotBuiltAt = 0;
  await h.call("/dsh-plugin-goldboard/snapshot", "GET");
  assert.equal(JSON.stringify(h.runtime.signalLedger), ledgerBeforeRead, "stale snapshot GET does not advance the ledger");
  assert.equal(JSON.stringify(h.runtime.laneState), laneBeforeRead, "stale snapshot GET does not advance lane state");

  const cached = await h.call("/dsh-plugin-goldboard/snapshot", "GET");
  assert.equal(cached.body.serverTime, first.body.serverTime, "2s cache window serves the same snapshot");

  const stateText = existsSync(join(h.dir, "state.json")) ? await readFile(join(h.dir, "state.json"), "utf8") : "";
  assert.equal(stateText.includes("localeHint"), false, "locale hint is session-only memory");
});

// ── 4. POST /config: deep merge + clearSecrets + unknown key 400, both modes ─

test("integration: POST /config deep-merges, honours clearSecrets and rejects unknown keys (classic mode)", async (t) => {
  freezeSession(t);
  const previousFetch = __setFetchImpl(async () => { throw new Error("no network in test"); });
  t.after(() => __setFetchImpl(previousFetch));
  const h = await boot({
    config: {
      webhooks: { feishu: { enabled: true, url: "https://feishu.example/hook", secret: "s3cret" } },
    },
  });
  t.after(() => h.dispose());

  const partial = await h.call("/dsh-plugin-goldboard/config", "POST", {
    body: { config: { fee: { sellPerGram: 7 } } },
  });
  assert.equal(partial.status, 200);
  assert.equal(partial.body.config.fee.sellPerGram, 7);
  assert.equal(partial.body.config.webhooks.feishu.enabled, true, "sibling section survives the partial patch");
  assert.equal(partial.body.config.webhooks.feishu.secret, "", "wire redacts the secret");
  assert.equal(partial.body.secretSet["webhooks.feishu.secret"], true);
  const classic = JSON.parse(await readFile(join(h.dir, "config.json"), "utf8"));
  assert.equal(classic.webhooks.feishu.secret, "s3cret", "classic mode persists the stored secret");

  const cleared = await h.call("/dsh-plugin-goldboard/config", "POST", {
    body: { config: {}, clearSecrets: ["webhooks.feishu.secret"] },
  });
  assert.equal(cleared.status, 200);
  assert.equal(cleared.body.secretSet["webhooks.feishu.secret"], false, "clearSecrets drops the stored secret");

  const unknown = await h.call("/dsh-plugin-goldboard/config", "POST", {
    body: { config: { nope: {} } },
  });
  assert.equal(unknown.status, 400);
  assert.equal(unknown.body.error.code, "UNKNOWN_CONFIG_KEY");
});

test("integration: POST /config fences revisions and rejects a stale save without writing", async (t) => {
  freezeSession(t);
  const previousFetch = __setFetchImpl(async () => { throw new Error("no network in test"); });
  t.after(() => __setFetchImpl(previousFetch));
  const h = await boot({ config: { fee: { sellPerGram: 4 } } });
  t.after(() => h.dispose());

  const first = await h.call("/dsh-plugin-goldboard/config", "GET");
  assert.equal(first.status, 200);
  assert.equal(first.body.revision, 0);

  const saved = await h.call("/dsh-plugin-goldboard/config", "POST", {
    body: { config: { fee: { sellPerGram: 9 } }, expectedRevision: 0 },
  });
  assert.equal(saved.status, 200);
  assert.equal(saved.body.config.fee.sellPerGram, 9);
  assert.equal(saved.body.revision, 1);

  const stale = await h.call("/dsh-plugin-goldboard/config", "POST", {
    body: { config: { fee: { sellPerGram: 2 } }, expectedRevision: 0 },
  });
  assert.equal(stale.status, 409);
  assert.equal(stale.body.error.code, "STALE_CONFIG");
  assert.equal(stale.body.revision, 1);
  assert.equal(stale.body.config.fee.sellPerGram, 9, "conflict response carries the current document");
  const onDisk = JSON.parse(await readFile(join(h.dir, "config.json"), "utf8"));
  assert.equal(onDisk.fee.sellPerGram, 9, "a stale save never writes");

  const bad = await h.call("/dsh-plugin-goldboard/config", "POST", {
    body: { config: { fee: { sellPerGram: 2 } }, expectedRevision: "zero" },
  });
  assert.equal(bad.status, 400);
  assert.equal(bad.body.error.code, "BAD_REVISION");
});

test("integration: reset clears the local position and risk ledger after confirmation", async (t) => {
  freezeSession(t);
  const previousFetch = __setFetchImpl(async () => { throw new Error("no network in test"); });
  t.after(() => __setFetchImpl(previousFetch));
  const h = await boot({ config: { position: { grams: 10, avgCostPerGram: 900 } } });
  t.after(() => h.dispose());

  const missing = await h.call("/dsh-plugin-goldboard/reset", "POST", { body: {} });
  assert.equal(missing.status, 400);
  assert.equal(missing.body.error.code, "CONFIRM_REQUIRED");

  const reset = await h.call("/dsh-plugin-goldboard/reset", "POST", { body: { confirm: "reset" } });
  assert.equal(reset.status, 200);
  assert.equal(reset.body.ok, true);

  const config = await h.call("/dsh-plugin-goldboard/config", "GET");
  assert.equal(config.body.config.position.grams, 0);
  const ledger = await h.call("/dsh-plugin-goldboard/ledger", "GET");
  assert.equal(ledger.body.orders.length, 0);
  assert.equal(ledger.body.decisions.length, 0);
});

test("integration: sidebar price preference round-trips through /config", async (t) => {
  freezeSession(t);
  const previousFetch = __setFetchImpl(async () => { throw new Error("no network in test"); });
  t.after(() => __setFetchImpl(previousFetch));
  const h = await boot({ config: {} });
  t.after(() => h.dispose());
  const saved = await h.call("/dsh-plugin-goldboard/config", "POST", {
    body: { config: { sidebarPrice: "CMB" } },
  });
  assert.equal(saved.status, 200);
  assert.equal(saved.body.config.sidebarPrice, "CMB");
  const read = await h.call("/dsh-plugin-goldboard/config", "GET");
  assert.equal(read.body.config.sidebarPrice, "CMB");
});

test("integration: boot clears stale manual previous closes from an earlier Beijing day", async (t) => {
  freezeSession(t);
  const previousFetch = __setFetchImpl(async () => { throw new Error("no network in test"); });
  t.after(() => __setFetchImpl(previousFetch));
  const h = await boot({
    prestore: async (dir) => {
      await writeFile(join(dir, "config.json"), JSON.stringify({
        manualPrevClose: { AU9999: 900, XAU: 4100, CMB: 880 },
        manualPrevCloseDate: "2000-01-01",
      }), "utf8");
    },
  });
  t.after(() => h.dispose());
  await drain(80);
  assert.deepEqual(h.runtime.config.manualPrevClose, { AU9999: null, XAU: null, CMB: null });
  assert.equal(h.runtime.config.manualPrevCloseDate, "");
  const onDisk = JSON.parse(await readFile(join(h.dir, "config.json"), "utf8"));
  assert.equal(onDisk.manualPrevCloseDate, "");
  assert.equal(onDisk.manualPrevClose.CMB, null);

  const snapshot = await h.call("/dsh-plugin-goldboard/snapshot", "GET", { headers: { "x-dsh-locale": "en" } });
  assert.deepEqual(snapshot.body.manualPrevClose, {});
});

test("integration: boot imports config.json.migrated once and lets config.json win afterwards", async (t) => {
  freezeSession(t);
  const previousFetch = __setFetchImpl(async () => { throw new Error("no network in test"); });
  t.after(() => __setFetchImpl(previousFetch));
  const h = await boot({
    prestore: async (dir) => {
      await writeFile(join(dir, "config.json.migrated"), JSON.stringify({ fee: { sellPerGram: 6 }, strategy: { confirmBars: 4 } }), "utf8");
    },
  });
  t.after(() => h.dispose());
  await drain(80);

  assert.equal(h.runtime.config.fee.sellPerGram, 6, "migrated document is adopted");
  assert.equal(h.runtime.config.strategy.confirmBars, 4, "migrated sections beyond defaults are retained");
  assert.equal(existsSync(join(h.dir, "config.json")), true, "migrated document becomes the new config.json");
  assert.equal(existsSync(join(h.dir, "config.json.migrated")), true, "legacy backup is kept");

  const saved = await h.call("/dsh-plugin-goldboard/config", "POST", {
    body: { config: { fee: { sellPerGram: 8 } } },
  });
  assert.equal(saved.status, 200);
  await h.dispose();

  const again = await boot({ dir: h.dir, config: { fee: { buyPerGram: 1 } } });
  t.after(() => again.dispose());
  await drain(80);
  assert.equal(again.runtime.config.fee.sellPerGram, 8, "config.json survives a cold read");
  assert.equal(again.runtime.config.fee.buyPerGram, 0, "the persisted document wins over entry config");
});

test("integration: system-settings route calls the fixed host helper and reports unsupported platforms", async (t) => {
  freezeSession(t);
  const previousFetch = __setFetchImpl(async () => { throw new Error("no network in test"); });
  t.after(() => __setFetchImpl(previousFetch));
  let opened = 0;
  const h = await boot({ config: { openSystemSettings: async () => { opened += 1; } } });
  t.after(() => h.dispose());
  const ok = await h.call("/dsh-plugin-goldboard/system-settings", "POST", { body: {} });
  assert.equal(ok.status, 200);
  assert.equal(opened, 1);

  const failed = await boot({
    config: {
      openSystemSettings: async () => {
        throw Object.assign(new Error("unsupported"), { code: "SYSTEM_UNSUPPORTED" });
      },
    },
  });
  t.after(() => failed.dispose());
  const unsupported = await failed.call("/dsh-plugin-goldboard/system-settings", "POST", { body: {} });
  assert.equal(unsupported.status, 501);
  assert.equal(unsupported.body.error.code, "SYSTEM_UNSUPPORTED");
});

// ── 5. circuit breaker: healthy → failing source, stale degradation ─────────

test("integration: repeated source failures degrade the snapshot and stop hammering the source", async (t) => {
  const clock = freezeSession(t, { intervals: true });
  const unhandled = [];
  const onUnhandled = (reason) => unhandled.push(reason);
  process.on("unhandledRejection", onUnhandled);
  t.after(() => process.off("unhandledRejection", onUnhandled));

  let failing = false;
  let calls = 0;
  const previousFetch = __setFetchImpl(async (url) => {
    calls += 1;
    if (failing) throw new Error("source down");
    if (String(url).includes("hq.sinajs.cn")) {
      const line = sinaLine("951.50");
      return { ok: true, arrayBuffer: async () => Buffer.from(line, "utf8"), text: async () => line };
    }
    throw new Error("source unavailable in test");
  });
  t.after(() => __setFetchImpl(previousFetch));

  const h = await boot({ config: { pollMs: 10_000 } });
  t.after(() => h.dispose());
  const snap1 = await h.call("/dsh-plugin-goldboard/snapshot", "GET");
  assert.equal(snap1.body.quotes.AU9999.price, 951.5, "healthy source feeds the board");
  const healthyCalls = calls;

  failing = true;
  for (let round = 0; round < 5; round += 1) {
    clock.tick(10_000); // drive one real tick per poll interval
    await drain(20);
  }
  const failingCalls = calls - healthyCalls;
  assert.ok(failingCalls >= 3, `each failing poll reaches the source until the breaker opens (${failingCalls})`);
  const beforeSteady = calls;
  clock.tick(10_000);
  await drain(20);
  assert.ok(calls - beforeSteady <= 2, `circuit-open ticks stop hammering the source (${calls - beforeSteady})`);

  const snap2 = await h.call("/dsh-plugin-goldboard/snapshot", "GET");
  assert.equal(snap2.body.quotes.AU9999.error, true, "failed domestic chain surfaces as an error quote");
  assert.ok(snap2.body.quotes.AU9999.stale, "degraded quote is flagged stale");
  assert.equal(unhandled.length, 0, "no unhandled rejections from the failing chain");
});

/**
 * Fill one lane with enough closed history for the plan to pass its coverage
 * and indicator-warm-up gates (5m needs ≥120 bars so the resampled 30m set
 * reaches planWarmupReady; 60m needs ≥20 buckets).
 */
function seedLaneHistory(runtime, lane, { price = 950 } = {}) {
  const end = Date.parse(`${SESSION_DAY}T04:00:00Z`); // frozen now
  const b = runtime.bars[lane];
  const bar = (t, p) => ({ t, o: p - 0.05, h: p + 0.1, l: p - 0.1, c: p });
  b[1] = [];
  for (let i = 90; i >= 1; i -= 1) b[1].push(bar(end - i * 60_000, price));
  b[5] = [];
  for (let i = 130; i >= 1; i -= 1) b[5].push(bar(end - i * 5 * 60_000, price));
  b[60] = [];
  for (let i = 22; i >= 1; i -= 1) b[60].push(bar(end - i * 3_600_000, price));
}

// ── 6. alert edges: stub channel receives once per edge, sentTo recorded ────

test("integration: alert edges fire once, record sentTo per channel, and re-fire on order update", async (t) => {
  const clock = freezeSession(t, { intervals: true });
  const feishuCalls = [];
  const previousFetch = __setFetchImpl(async (url) => {
    if (String(url).includes("feishu.example")) {
      feishuCalls.push(String(url));
      return { ok: true, status: 200, text: async () => "{}" };
    }
    if (String(url).includes("hq.sinajs.cn/list=gds_AU9999")) {
      const line = sinaLine("940.00"); // far below cost → sell_stop edge
      return { ok: true, arrayBuffer: async () => Buffer.from(line, "utf8"), text: async () => line };
    }
    throw new Error("source unavailable in test");
  });
  t.after(() => __setFetchImpl(previousFetch));

  const h = await boot({
    config: {
      pollMs: 10_000,
      position: { grams: 10, avgCostPerGram: 951 },
      strategy: { confirmBars: 1 },
      webhooks: { feishu: { enabled: true, url: "https://feishu.example/hook" } },
      system: { enabled: false },
    },
  });
  t.after(() => h.dispose());
  // The quote-only cold board cannot pass the data gates; fill the AU9999
  // lane history first, then drive a real tick at the depressed price.
  seedLaneHistory(h.runtime, "AU9999", { price: 950 });
  h.runtime.lastAlertLog.length = 0;
  clock.tick(10_000);
  await drain(60);

  assert.equal(feishuCalls.length, 1, `first edge delivers exactly one webhook message (${feishuCalls.length})`);
  assert.ok(h.runtime.lastAlertLog.length >= 1, "alert recorded in the log");
  const sentTo = h.runtime.lastAlertLog[0]?.sentTo ?? [];
  assert.deepEqual(sentTo.map((entry) => [entry.channel, entry.ok]), [["feishu", true]]);

  // Same state again → no duplicate edge.
  clock.tick(10_000);
  await drain(40);
  assert.equal(feishuCalls.length, 1, "no duplicate alert while the edge holds");

  // Changing the position changes the suggested order → order-update edge
  // on the NEXT tick (alert evaluation runs inside the tick loop). The lot
  // list is authoritative for the derived position size.
  await h.call("/dsh-plugin-goldboard/config", "POST", {
    body: {
      config: {
        position: {
          grams: 6,
          avgCostPerGram: 951,
          lots: [{ id: "lot-1", grams: 6, price: 951, time: "2026-08-13T02:00:00.000Z", status: "open" }],
        },
      },
    },
  });
  clock.tick(10_000);
  await drain(40);
  assert.ok(feishuCalls.length >= 2, `order update delivers a follow-up notification (${feishuCalls.length})`);
  assert.ok(["order_updated", "cancel_order", "sell_stop"].includes(h.runtime.lastAlertLog[0]?.action), `log head records the edge (${h.runtime.lastAlertLog[0]?.action})`);
});

test("integration: generic test-notify route handles missing, success and failure", async (t) => {
  freezeSession(t);
  const sent = [];
  let failPost = false;
  const genericLookup = async () => [{ address: "93.184.216.34", family: 4 }];
  const genericTransport = async (validated, value, headers) => {
    if (failPost) throw new Error("generic transport failed");
    sent.push({ validated, value, headers });
    return { ok: true, status: 200, text: async () => "" };
  };
  const previousFetch = __setFetchImpl(async () => { throw new Error("no market network in test"); });
  t.after(() => __setFetchImpl(previousFetch));
  const h = await boot({
    config: {
      genericLookup,
      genericTransport,
      webhooks: {
        generic: [{
          id: "generic-1",
          name: "Audit hook",
          enabled: true,
          url: "https://hooks.example.com/gold",
          headers: { "X-Signature": "abc" },
          bodyTemplate: "",
        }],
      },
    },
  });
  t.after(() => h.dispose());

  const missing = await h.call("/dsh-plugin-goldboard/test-notify", "POST", {
    body: { channel: "generic", genericId: "missing" },
  });
  assert.equal(missing.status, 400);
  assert.equal(missing.body.error.code, "GENERIC_NOT_FOUND");

  const success = await h.call("/dsh-plugin-goldboard/test-notify", "POST", {
    body: { channel: "generic", genericId: "generic-1" },
  });
  assert.equal(success.status, 200);
  assert.equal(success.body.ok, true);
  assert.equal(sent.length, 1);
  assert.equal(sent[0].validated.url, "https://hooks.example.com/gold");
  assert.equal(sent[0].validated.address, "93.184.216.34");
  assert.equal(sent[0].headers["x-signature"], "abc");
  assert.equal(typeof sent[0].value.text, "string");

  failPost = true;
  const failed = await h.call("/dsh-plugin-goldboard/test-notify", "POST", {
    body: { channel: "generic", genericId: "generic-1" },
  });
  assert.equal(failed.status, 500);
  assert.equal(failed.body.error.code, "NOTIFY_FAILED");
});

// ── 7. analysis run: scripted success and INVALID_JSON both hit the log ─────

test("integration: analysis run records success and invalid outcomes in the analysis log", async (t) => {
  freezeSession(t);
  const previousFetch = __setFetchImpl(async () => { throw new Error("no network in test"); });
  t.after(() => __setFetchImpl(previousFetch));
  const h = await boot({
    llm: llmStub(VALID_ANALYSIS_JSON),
    config: { analysis: { enabled: true, provider: "stub", model: "stub-model" } },
  });
  t.after(() => h.dispose());

  const run = await h.call("/dsh-plugin-goldboard/analysis", "POST", { body: {} });
  assert.equal(run.status, 200, `expected success, got ${run.status}: ${JSON.stringify(run.body)}`);
  assert.equal(run.body.ok, true);
  assert.equal(run.body.status, "success");

  const logs = await h.call("/dsh-plugin-goldboard/analysis-logs", "GET");
  assert.equal(logs.body.logs?.[0]?.status, "success");

  // Now a garbage stream → INVALID_JSON surfaces and lands in the log.
  h.runtime.analysis.llm = llmStub("this is not json");
  h.runtime.analysis.cache.clear();
  const bad = await h.call("/dsh-plugin-goldboard/analysis", "POST", { body: { force: true } });
  assert.equal(bad.status, 400);
  assert.equal(bad.body.error?.code, "INVALID_JSON");
  const logs2 = await h.call("/dsh-plugin-goldboard/analysis-logs", "GET");
  const statuses = (logs2.body.logs ?? []).map((entry) => entry.status);
  assert.ok(statuses.includes("invalid"), `invalid run recorded (got: ${statuses.join(",")})`);
});

// ── 8. /manual-cmb-bars: added/skipped semantics, no overwrite ──────────────

test("integration: manual CMB bars add missing minutes, skip existing/future ones and rebuild higher intervals", async (t) => {
  freezeSession(t);
  const previousFetch = __setFetchImpl(async () => { throw new Error("no network in test"); });
  t.after(() => __setFetchImpl(previousFetch));
  const h = await boot({ config: {} });
  t.after(() => h.dispose());

  const post = (text) => h.call("/dsh-plugin-goldboard/manual-cmb-bars", "POST", { body: { text } });
  const first = await post("11:55 950.00\n11:56 950.10\n11:57 950.20");
  assert.equal(first.status, 200);
  assert.deepEqual([first.body.added, first.body.skipped], [3, 0], "all open-session minutes accepted");

  // Same minutes again → all skipped, existing buckets untouched.
  const again = await post("11:55 999.00\n11:56 999.00");
  assert.deepEqual([again.body.added, again.body.skipped], [0, 2]);
  const kept = h.runtime.bars.CMB[1].find((bar) => bar.c === 950);
  assert.ok(kept, "existing bucket not overwritten");

  // Future minute beyond the frozen now (12:00) is skipped.
  const future = await post("12:30 951.00");
  assert.deepEqual([future.body.added, future.body.skipped], [0, 1], "future minute rejected");

  // Higher interval rebuilt from the 1m series.
  assert.ok(h.runtime.bars.CMB[5].length >= 1, "5m bucket rebuilt from minute bars");
});

// ── 9. /replay golden fixture determinism ───────────────────────────────────

test("integration: POST /replay reproduces the golden snapshot exactly", async (t) => {
  freezeSession(t);
  const previousFetch = __setFetchImpl(async () => { throw new Error("no network in test"); });
  t.after(() => __setFetchImpl(previousFetch));
  const h = await boot({ config: buildGoldenConfig() });
  t.after(() => h.dispose());

  const golden = JSON.parse(await readFile(new URL("./fixtures/golden-snapshot.json", import.meta.url), "utf8"));
  const replayed = await h.call("/dsh-plugin-goldboard/replay", "POST", { body: buildGoldenInput() });
  assert.equal(replayed.status, 200);
  assert.deepEqual(replayed.body, golden, "replay output equals the committed golden snapshot");
});

// ── 9b. plan-06: batch replay statistics over the live route surface ────────

/** Deterministic klines for the trading days the frozen clock selects. */
function replayKlineStub(callLog) {
  const sessionMinutes = 17.5 * 60;
  const buildBars = (dayList, strideMinutes) => {
    const bars = [];
    let index = 0;
    for (const day of dayList) {
      const startMs = Date.parse(`${day}T09:00:00+08:00`);
      for (let i = 0; i < sessionMinutes / strideMinutes; i += 1) {
        const barT = startMs + i * strideMinutes * 60_000;
        const base = 950 + index * 0.02 + Math.sin(index / 8) * 0.4;
        bars.push({ t: barT, o: base, h: base + 0.3, l: base - 0.3, c: base + 0.05 });
        index += strideMinutes / 5;
      }
    }
    return bars;
  };
  return async (url) => {
    const text = String(url);
    if (text.includes("kline")) {
      const secid = text.match(/secid=([^&]+)/)[1];
      const klt = Number(text.match(/klt=(\d+)/)[1]);
      const endDay = text.match(/end=(\d{8})/)[1];
      callLog.push(`${secid}|${klt}|${endDay}`);
      // Point-in-time replay pulls use end=YYYYMMDD; the boot-tick seeding
      // keeps its sentinel end=20500101 and gets today's session (real bars,
      // so the source circuit breaker stays closed for the engine).
      const sessions = /^2026\d{4}$/.test(endDay)
        ? [`${endDay.slice(0, 4)}-${endDay.slice(4, 6)}-${endDay.slice(6, 8)}`]
        : ["2026-08-14"];
      const bars = buildBars(sessions, klt === 5 ? 5 : 60);
      const rows = bars.map((bar) => {
        const beijing = new Date(bar.t + 8 * 3600_000).toISOString().replace("T", " ").slice(0, 16);
        return [beijing, bar.o, bar.c, bar.h, bar.l, 1].join(",");
      });
      return { ok: true, text: async () => JSON.stringify({ data: { klines: rows } }) };
    }
    throw new Error("source unavailable in test");
  };
}

test("integration: POST/GET /replay-stats serve a cached report with fetch-once days", async (t) => {
  freezeSession(t); // Beijing Friday 2026-08-14 12:00 → window [08-13, 08-14]
  const calls = [];
  const previousFetch = __setFetchImpl(replayKlineStub(calls));
  t.after(() => __setFetchImpl(previousFetch));

  const h = await boot({ config: {} });
  t.after(() => h.dispose());

  const future = await h.call("/dsh-plugin-goldboard/replay-stats", "POST", {
    body: { days: 2, lane: "au9999", asOf: "2026-08-15T04:00:02.000Z" },
  });
  assert.equal(future.status, 400);
  assert.equal(future.body.error.code, "REPLAY_AS_OF_IN_FUTURE");

  const started = await h.call("/dsh-plugin-goldboard/replay-stats", "POST", {
    body: { days: 2, lane: "au9999", asOf: "2026-08-14T04:00:00.000Z" },
  });
  assert.equal(started.status, 200);
  assert.equal(started.body.ok, true);
  assert.equal(started.body.cached, false);
  const report = started.body.report;
  assert.equal(report.version, 6);
  assert.equal(report.reportSchema, "goldboard-replay-report-v6");
  assert.equal(report.reportSchemaVersion, 6);
  assert.match(report.inputFingerprint, /^[a-f0-9]{64}$/);
  assert.match(report.reportFingerprint, /^[a-f0-9]{64}$/);
  assert.match(report.reportId, /^replay-/);
  assert.equal(report.asOf, "2026-08-14T04:00:00.000Z");
  assert.match(report.generatedAt, /^\d{4}-\d{2}-\d{2}T/);
  assert.equal(report.strategyId, "control");
  assert.equal(report.strategyVersion, "goldboard-control-v1");
  assert.equal(report.calculationVersion, "goldboard-indicators-v3");
  assert.equal(report.dataSchemaVersion, MARKET_DATA_SCHEMA_VERSION);
  assert.equal(report.executionVersion, EXECUTION_MODEL_VERSION);
  assert.equal(report.calendarVersion, CALENDAR_VERSIONS.SGE);
  assert.equal(report.evidenceStatus, "exploratory");
  assert.equal(report.validationGate.eligible, false);
  assert.ok(report.validationGate.unmet.includes("multiple_oos_folds"));
  assert.ok(report.validationGate.unmet.includes("verified_cost_semantics"));
  assert.equal(report.dataset.lane, "au9999");
  assert.match(report.dataset.datasetId, /^dataset-[a-f0-9]{64}$/);
  assert.equal(report.simulation.simulatorVersion, "goldboard-replay-simulator-v1");
  assert.equal(typeof report.metrics, "object");
  assert.equal(typeof report.oos, "object");
  assert.deepEqual(Object.keys(report.benchmarks), ["no_trade", "buy_and_hold", "fixed_interval_dca", "simple_moving_average"]);
  assert.equal(typeof report.groups.executionEvidence, "object");
  assert.equal(report.lane, "au9999");
  assert.equal(report.fillPolicy, "next-bar-limit");
  assert.equal(report.ambiguityPolicy, "conservative-stop");
  assert.equal(report.costAssumptions.explicitFeePerGram.buy, 0);
  assert.equal(report.costAssumptions.explicitFeePerGram.sell, 5);
  assert.equal(report.costAssumptions.productAgreementVerified, false);
  assert.ok(report.executionCoverage && typeof report.executionCoverage === "object");
  assert.ok(report.caveats.includes("two-simulated-passes"));
  assert.equal(report.params.days, 2);
  assert.equal(report.params.lane, "au9999");
  assert.equal(report.daysRequested, 2);
  assert.equal(report.daysEvaluated, 2);
  assert.deepEqual(report.window, { from: "2026-08-12", to: "2026-08-13" });
  assert.equal(report.completeDays, 2);
  assert.equal(report.partialDays, 0);
  assert.ok(report.totals.steps >= 2 * 132 * 2 * 0.9, `steps cover SGE day and night session passes (${report.totals.steps})`);
  assert.ok(Array.isArray(report.perAction));
  assert.equal(report.failures.length, 0);

  // Point-in-time pulls: exactly one 5m + one 60m request per day.
  const dayPulls = calls.filter((call) => call.endsWith("20260812") || call.endsWith("20260813"));
  assert.equal(dayPulls.length, 4);

  // Same-window repeat → TTL cache; GET serves the same report idempotently.
  const again = await h.call("/dsh-plugin-goldboard/replay-stats", "POST", { body: { days: 2, lane: "au9999", asOf: "2026-08-14T04:00:00.000Z" } });
  assert.equal(again.body.cached, true);
  assert.deepEqual(again.body.report, report);
  const fetched = await h.call("/dsh-plugin-goldboard/replay-stats", "GET", { url: "/dsh-plugin-goldboard/replay-stats?detail=true" });
  assert.equal(fetched.status, 200);
  assert.equal(fetched.body.ok, true);
  assert.deepEqual(fetched.body.report, report);
  assert.ok(Array.isArray(fetched.body.trades), "detail response includes simulated fills as trade-compatible rows");
  assert.ok(Array.isArray(fetched.body.orders), "detail response includes order lifecycle rows");
  assert.ok(Array.isArray(fetched.body.fills), "detail response includes simulated fills");
  assert.ok(Array.isArray(fetched.body.ledger), "detail response includes the simulator ledger");
  assert.ok(Array.isArray(fetched.body.unexecutedSignals), "detail response includes unexecuted strategy signals");

  const listed = await h.call("/dsh-plugin-goldboard/replay-reports", "GET", {
    url: "/dsh-plugin-goldboard/replay-reports?limit=10",
  });
  assert.equal(listed.status, 200);
  assert.equal(listed.body.ok, true);
  assert.equal(listed.body.reports[0].reportId, report.reportId);
  const byId = await h.call("/dsh-plugin-goldboard/replay-stats", "GET", {
    url: `/dsh-plugin-goldboard/replay-stats?detail=true&reportId=${encodeURIComponent(report.reportId)}`,
  });
  assert.deepEqual(byId.body.report, report);
  assert.deepEqual(byId.body.ledger, fetched.body.ledger);

  // Compatibility report persisted next to state.json; immutable v6 details
  // also live under replay-reports/ and are addressable by reportId.
  const persisted = JSON.parse(await readFile(join(h.dir, "replay-stats.json"), "utf8"));
  assert.equal(persisted.report.version, 6);
  assert.ok(Array.isArray(persisted.trades), "continuous fill-compatible details persist");
  assert.ok(Array.isArray(persisted.orders));
  assert.ok(Array.isArray(persisted.fills));
  assert.ok(Array.isArray(persisted.events));
  assert.ok(Array.isArray(persisted.ledger));
  assert.ok(Array.isArray(persisted.unexecutedSignals));
});

test("integration: mid-window source failure surfaces as a partial report on the route", async (t) => {
  freezeSession(t);
  const calls = [];
  const stub = replayKlineStub(calls);
  const previousFetch = __setFetchImpl(async (url) => {
    if (String(url).includes("end=20260813")) throw new Error("day-2 source down");
    return stub(url);
  });
  t.after(() => __setFetchImpl(previousFetch));

  const h = await boot({ config: {} });
  t.after(() => h.dispose());
  const result = await h.call("/dsh-plugin-goldboard/replay-stats", "POST", { body: { days: 2, lane: "au9999", asOf: "2026-08-14T04:00:00.000Z" } });
  assert.equal(result.status, 200);
  assert.equal(result.body.ok, true);
  assert.equal(result.body.report.daysEvaluated, 1);
  assert.equal(result.body.report.daysFailed, 1);
  assert.deepEqual(result.body.report.failures, [{ day: "2026-08-13", error: "day-2 source down" }]);
  assert.equal(result.body.report.evidenceStatus, "exploratory");
  assert.equal(result.body.report.simulation.diagnostics.replayDayFailures, 1);
  assert.ok(result.body.report.validationGate.unmet.includes("incomplete_sessions"), "source failures fail closed instead of disappearing from validation evidence");
});

// ── 10. long-term CMB point-in-time collection ──────────────────────────────

test("integration: a live CMB quote dual-writes state and append-only history", async (t) => {
  freezeSession(t);
  const previousFetch = __setFetchImpl(async (url) => {
    const target = String(url);
    if (target.includes("market-center")) {
      return {
        ok: true,
        text: async () => JSON.stringify({ data: [{ zBuyPrc: 955.5, zSelPrc: 950.5 }] }),
      };
    }
    if (target.includes("hq.sinajs.cn/list=gds_AU9999")) {
      const line = sinaLine("951.50");
      return { ok: true, arrayBuffer: async () => Buffer.from(line, "utf8"), text: async () => line };
    }
    throw new Error("source unavailable in test");
  });
  t.after(() => __setFetchImpl(previousFetch));

  const h = await boot({ config: {} });
  t.after(() => rm(h.dir, { recursive: true, force: true }));
  await h.dispose();
  const historyFiles = (await readdir(join(h.dir, "history"))).filter((name) => name.endsWith(".jsonl"));
  assert.equal(historyFiles.length, 1);
  const records = (await readFile(join(h.dir, "history", historyFiles[0]), "utf8"))
    .trim().split("\n").map((line) => JSON.parse(line));
  assert.equal(records.length, 1);
  assert.equal(records[0].dataSchemaVersion, "goldboard-market-data-v2");
  assert.equal(records[0].evidence, "real");
  assert.equal(records[0].customerAsk, 955.5);
  assert.equal(records[0].customerBid, 950.5);
  const state = JSON.parse(await readFile(join(h.dir, "state.json"), "utf8"));
  assert.equal(state.stateSchemaVersion, STATE_SCHEMA_VERSION);
  assert.equal(state.dataSchemaVersion, "goldboard-market-data-v2");
});

// ── 11. dispose: the final flush is awaited ─────────────────────────────────

test("integration: dispose flushes pending bars state before resolving", async (t) => {
  freezeSession(t);
  const previousFetch = __setFetchImpl(async (url) => {
    if (String(url).includes("hq.sinajs.cn")) {
      const line = sinaLine("951.50");
      return { ok: true, arrayBuffer: async () => Buffer.from(line, "utf8"), text: async () => line };
    }
    throw new Error("source unavailable in test");
  });
  t.after(() => __setFetchImpl(previousFetch));

  const h = await boot({ config: {} });
  // Mark fresh state dirty after the boot tick (the 5-minute throttle keeps
  // it unwritten until the next due boundary or the dispose flush).
  h.runtime.alertState = { probe: "pending" };
  h.runtime.signalState = { ...h.runtime.signalState, lastPrice: 951.5 };
  await h.dispose(); // awaited final flush
  const state = JSON.parse(await readFile(join(h.dir, "state.json"), "utf8"));
  assert.deepEqual(state.alertState, { probe: "pending" }, "dispose persisted the latest state");
  assert.equal(state.quotes.AU9999.price, 951.5, "dispose persisted the pending quote/bars state");
  assert.equal(state.barsSeedVersion, BARS_SEED_VERSION);
});

test("integration: unsupported v3 ledger state is normalized, persisted, and remains fail-closed", async (t) => {
  freezeSession(t);
  const previousFetch = __setFetchImpl(async () => { throw new Error("offline ledger recovery fixture"); });
  t.after(() => __setFetchImpl(previousFetch));
  const h = await boot({
    config: { limits: { maxGrams: 100 } },
    prestore: async (dir) => {
      await writeFile(join(dir, "state.json"), JSON.stringify({
        stateSchemaVersion: STATE_SCHEMA_VERSION,
        quotes: {},
        bars: {},
        signalLedger: {
          version: "future-ledger",
          schemaVersion: 99,
          orders: [{ orderId: "future-order", status: "pending", signalPrice: null, filledAt: null }],
        },
      }), "utf8");
    },
  });
  await h.dispose();
  const state = JSON.parse(await readFile(join(h.dir, "state.json"), "utf8"));
  assert.equal(state.signalLedger.version, SIGNAL_LEDGER_VERSION);
  assert.equal(state.signalLedger.integrity, "unsupported_version");
  assert.equal(state.signalLedger.orders[0].signalPrice, null);
  assert.equal(state.signalLedger.orders[0].filledAt, null);
  assert.ok(h.warnings.some((line) => line.includes("signal ledger normalized")));
  await rmRetry(h.dir);
});

test("integration: risk config, snapshot, ledger route, and state v3 stay aligned", async (t) => {
  freezeSession(t);
  const previousFetch = __setFetchImpl(async () => { throw new Error("offline stage2 fixture"); });
  t.after(() => __setFetchImpl(previousFetch));

  const h = await boot({
    config: {
      limits: { maxGrams: 100 },
      risk: { mode: "fixed_grams", maxAmountCny: 100000, maxDailyLossCny: 500 },
    },
  });
  t.after(async () => {
    await h.dispose();
    await rmRetry(h.dir);
  });

  const saved = await h.call("/dsh-plugin-goldboard/config", "POST", {
    body: { config: { risk: { mode: "budget", maxRiskPerTradeCny: 250 } } },
  });
  assert.equal(saved.status, 200);
  assert.equal(saved.body.config.risk.version, RISK_CONFIG_VERSION);
  assert.equal(saved.body.config.risk.mode, "budget");
  assert.equal(saved.body.config.risk.maxRiskPerTradeCny, 250);
  assert.equal(saved.body.config.risk.maxAmountCny, 100000, "partial risk patch keeps sibling limits");

  const snapshot = await h.call("/dsh-plugin-goldboard/snapshot", "GET", { headers: { "x-dsh-locale": "en" } });
  assert.equal(snapshot.status, 200);
  assert.equal(snapshot.body.riskConfigVersion, RISK_CONFIG_VERSION);
  assert.equal(snapshot.body.risk.mode, "budget");
  assert.equal(snapshot.body.risk.gate.allowProtectiveExit, true);
  assert.equal(snapshot.body.ledger.version, SIGNAL_LEDGER_VERSION);

  const ledger = await h.call("/dsh-plugin-goldboard/ledger", "GET", { url: "/dsh-plugin-goldboard/ledger?limit=10" });
  assert.equal(ledger.status, 200);
  assert.equal(ledger.body.version, SIGNAL_LEDGER_VERSION);
  assert.deepEqual(ledger.body.summary.counts, snapshot.body.ledger.counts);

  await h.dispose();
  const state = JSON.parse(await readFile(join(h.dir, "state.json"), "utf8"));
  assert.equal(state.stateSchemaVersion, STATE_SCHEMA_VERSION);
  assert.equal(state.signalLedger.version, SIGNAL_LEDGER_VERSION);
});

test("integration: strategy catalog is read-only and experiments default disabled", async (t) => {
  freezeSession(t);
  const previousFetch = __setFetchImpl(async () => { throw new Error("offline strategy fixture"); });
  t.after(() => __setFetchImpl(previousFetch));

  const h = await boot({ config: {} });
  t.after(async () => {
    await h.dispose();
    await rmRetry(h.dir);
  });

  const catalog = await h.call("/dsh-plugin-goldboard/strategies", "GET");
  assert.equal(catalog.status, 200);
  assert.equal(catalog.body.ok, true);
  assert.equal(catalog.body.config.enabled, false);
  assert.deepEqual(catalog.body.strategies.map((entry) => entry.strategyId), ["control", "orb-trend-pullback"]);
  const control = catalog.body.strategies.find((entry) => entry.strategyId === "control");
  const candidate = catalog.body.strategies.find((entry) => entry.strategyId === "orb-trend-pullback");
  assert.equal(control.live, true);
  assert.equal(control.canDisable, false);
  assert.equal(control.enabled, true);
  assert.equal(candidate.live, false);
  assert.equal(candidate.enabled, false);
  assert.equal(typeof candidate.descriptorFingerprint, "string");
  assert.equal("factory" in candidate, false);

  const snapshot = await h.call("/dsh-plugin-goldboard/snapshot", "GET");
  assert.equal(snapshot.body.plan.strategyId, "control");
  assert.equal(snapshot.body.plan.signalSemantics, "state_condition");

  const disabled = await h.call("/dsh-plugin-goldboard/strategy-experiments", "POST", {
    body: { days: 1, mode: "diagnostic", strategyIds: ["orb-trend-pullback"], signalLanes: ["cmb"] },
  });
  assert.equal(disabled.status, 409);
  assert.equal(disabled.body.error.code, "EXPERIMENTS_DISABLED");

  const latest = await h.call("/dsh-plugin-goldboard/strategy-experiments", "GET");
  assert.equal(latest.status, 200);
  assert.equal(latest.body.report, null);
});

test("integration: enabled strategy experiment remains replay-only and survives a cold read", async (t) => {
  freezeSession(t);
  const previousFetch = __setFetchImpl(async () => { throw new Error("offline experiment fixture"); });
  t.after(() => __setFetchImpl(previousFetch));

  const h = await boot({
    config: {
      experiments: {
        enabled: true,
        enabledStrategyIds: ["control", "orb-trend-pullback"],
        signalLanes: ["cmb"],
        costMultipliers: [1],
        parameterMultipliers: [1],
        ablations: ["none"],
      },
    },
  });
  t.after(async () => {
    await h.dispose();
    await rmRetry(h.dir);
  });

  const before = await h.call("/dsh-plugin-goldboard/snapshot", "GET");
  assert.equal(before.body.plan.strategyId, "control");
  const run = await h.call("/dsh-plugin-goldboard/strategy-experiments", "POST", {
    body: {
      days: 1,
      mode: "diagnostic",
      strategyIds: ["control", "orb-trend-pullback"],
      signalLanes: ["cmb"],
    },
  });
  assert.equal(run.status, 200);
  assert.equal(run.body.ok, true);
  assert.equal(run.body.report.schema, "goldboard-strategy-experiment-v1");
  assert.equal(run.body.report.scenarios.length, 2);
  assert.equal(run.body.report.promotion.liveStrategyChanged, false);
  assert.equal(run.body.report.promotion.eligible, false);
  const candidateScenario = run.body.report.scenarios.find((entry) => entry.strategyId === "orb-trend-pullback");
  assert.match(candidateScenario.factorFingerprint, /^[a-f0-9]{64}$/);

  const latest = await h.call("/dsh-plugin-goldboard/strategy-experiments", "GET");
  assert.deepEqual(latest.body.report, run.body.report);

  for (const [body, code] of [
    [{ days: "1", mode: "diagnostic", strategyIds: ["control"], signalLanes: ["cmb"] }, "BAD_EXPERIMENT_DAYS"],
    [{ days: 1, mode: "diagnostic", strategyIds: "control", signalLanes: ["cmb"] }, "BAD_EXPERIMENT_STRATEGY_IDS"],
    [{ days: 1, mode: "diagnostic", strategyIds: ["control"], signalLanes: ["cmb", 42] }, "BAD_EXPERIMENT_SIGNAL_LANES"],
    [{}, "BAD_STRATEGY_EXPERIMENT_FIELDS"],
    [[], "BAD_STRATEGY_EXPERIMENT_BODY"],
    [1, "BAD_STRATEGY_EXPERIMENT_BODY"],
    [{ days: 1, mode: "diagnostic", strategyIds: ["control"], signalLanes: ["cmb"], extra: true }, "BAD_STRATEGY_EXPERIMENT_FIELDS"],
  ]) {
    const malformed = await h.call("/dsh-plugin-goldboard/strategy-experiments", "POST", { body });
    assert.equal(malformed.status, 400);
    assert.equal(malformed.body.error.code, code);
  }
  const wrongType = await h.call("/dsh-plugin-goldboard/strategy-experiments", "POST", {
    headers: { "content-type": "text/plain" }, body: "{}",
  });
  assert.equal(wrongType.status, 415);
  assert.equal(wrongType.body.error.code, "UNSUPPORTED_MEDIA_TYPE");
  const crossOrigin = await h.call("/dsh-plugin-goldboard/strategy-experiments", "POST", {
    headers: { origin: "https://example.invalid", host: "127.0.0.1:3080" },
    body: { days: 1, mode: "diagnostic", strategyIds: ["control"], signalLanes: ["cmb"] },
  });
  assert.equal(crossOrigin.status, 403);
  assert.equal(crossOrigin.body.error.code, "BAD_REQUEST_ORIGIN");
  const originWithoutHost = await h.call("/dsh-plugin-goldboard/strategy-experiments", "POST", {
    headers: { origin: "http://127.0.0.1:3080" },
    body: { days: 1, mode: "diagnostic", strategyIds: ["control"], signalLanes: ["cmb"] },
  });
  assert.equal(originWithoutHost.status, 403);
  assert.equal(originWithoutHost.body.error.code, "BAD_REQUEST_ORIGIN");

  const after = await h.call("/dsh-plugin-goldboard/snapshot", "GET");
  assert.equal(after.body.plan.strategyId, "control");
  assert.equal(h.runtime.config.experiments.enabled, true);
});
