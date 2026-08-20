import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  AnalysisModule,
  analysisInputHash,
  buildAnalysisInput,
  buildAnalysisModelCatalog,
  collectModelStream,
  stableJson,
  validateAnalysisOutput,
} from "../lib/analysis.js";
import {
  AnalysisLogStore,
  mergeAnalysisLogEvents,
  sanitizeAnalysisError,
  sanitizeAnalysisLogValue,
} from "../lib/analysis-log.js";

function readySnapshot() {
  return {
    ok: true,
    serverTime: "2026-08-14T02:00:00.000Z",
    marketState: "open",
    market: { state: "open", sessionStart: "2026-08-14T01:00:00.000Z", msToClose: 10_000_000 },
    quotes: {
      AU9999: { instrument: "Au99.99", market: "sge", currency: "CNY", unit: "gram", price: 950, source: "sina", stale: false },
      XAU: { instrument: "XAU/USD", market: "spot", currency: "USD", unit: "troy_ounce", price: 4_375, source: "tencent", stale: false },
      GCF: { instrument: "GC=F", market: "futures", currency: "USD", unit: "troy_ounce", price: 4_380, source: "yahoo", stale: false },
      USDCNY: { instrument: "USD/CNY", market: "forex", currency: "CNY", unit: "rate", price: 6.74, source: "tencent", stale: false },
      CMB: { instrument: "CMB_ACCUMULATED_GOLD", market: "bank", currency: "CNY", unit: "gram", price: 951, customerBuy: 953, customerSell: 948, spread: 5, source: "cmb", stale: false },
    },
    derived: { xauCnyPerGram: 948.5 },
    indicators: { calculationVersion: "goldboard-indicators-v2", ind5: { rsi14: 51 } },
    quality: { status: "degraded", ready: true, reasonCodes: [], warnings: ["synthetic_bars"], syntheticBars: true, coverage: { 5: 1, 10: 1, 30: 1, 60: 1 } },
    position: { grams: 10, avgCostPerGram: 945, feeAdjustedPnl: 30 },
    plan: { action: "wait", reasonCodes: [], dataCoverage: { 5: 1, 10: 1, 30: 1, 60: 1 }, suggestedOrder: null },
  };
}

function analysisConfig() {
  return {
    analysis: {
      enabled: true,
      provider: "provider-a",
      model: "model-a",
      reasoningEffort: "low",
      temperature: 0.1,
      maxTokens: 1_600,
      cooldownMinutes: 5,
      timeoutMs: 5_000,
      riskDisclosure: "Technical reference, not investment advice.",
    },
  };
}

function validOutput() {
  return {
    status: "analysis_ready",
    bias: "neutral",
    horizon: "intraday",
    action: "observe",
    confidence: "medium",
    evidence: ["RSI is neutral"],
    support: [948],
    resistance: [952],
    reassessWhen: ["Price leaves the range"],
    invalidations: ["Data becomes stale"],
    dataWarnings: ["Synthetic minute bars"],
    suggestedOrder: null,
    riskDisclosure: "ignored and replaced by host",
  };
}

function fakeLlm(output, options = {}) {
  let calls = 0;
  return {
    get calls() { return calls; },
    listProviders() {
      return [{ id: "provider-a", name: "Provider A" }, { id: "provider-b", name: "Provider B" }];
    },
    async listModels(provider) {
      if (provider === "provider-b") throw new Error("catalog unavailable");
      return [{ provider, id: "model-a", name: "Model A", description: "Test model" }];
    },
    async resolveModelInfo(provider, model) {
      if (provider !== "provider-a" || model !== "model-a") throw Object.assign(new Error("missing"), { code: "NO_ADAPTER" });
      return {
        provider,
        id: model,
        name: "Model A",
        context: { contextWindow: 32_000 },
        defaultMaxTokens: 2_000,
        reasoning: { efforts: [{ id: "low", name: "Low" }, { id: "high", name: "High" }], defaultEffort: "high" },
      };
    },
    async prepareCall(config) {
      await this.resolveModelInfo(config.provider, config.model);
      return {
        config: { ...config },
        context: { contextWindow: 32_000 },
        adapterDefaults: {},
        stream: async function* () {
          calls += 1;
          if (options.finishError && options.finishErrorBeforeText) {
            yield { type: "finish", reason: { kind: "error", failure: { code: "RATE_LIMIT", message: "rate limited", requestId: "req-1" } } };
            return;
          }
          if (options.wait) await options.wait;
          const text = typeof output === "string" ? output : JSON.stringify(output);
          yield { type: "block-start", index: 0, blockType: "text" };
          yield { type: "text-delta", index: 0, text: text.slice(0, Math.ceil(text.length / 2)) };
          yield { type: "text-delta", index: 0, text: text.slice(Math.ceil(text.length / 2)) };
           if (options.finishError) {
             yield { type: "finish", reason: { kind: "error", failure: { code: "RATE_LIMIT", message: "rate limited", requestId: "req-1" } } };
             return;
           }
          yield { type: "usage", usage: { inputTokens: 100, outputTokens: 50 } };
          yield { type: "finish", reason: { kind: "stop" } };
        },
      };
    },
  };
}

async function tempStore(t) {
  const directory = await mkdtemp(join(tmpdir(), "goldboard-analysis-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const store = new AnalysisLogStore({ file: join(directory, "analysis-log.jsonl"), maxEntries: 50 });
  await store.init();
  return { directory, store };
}

test("model catalog preserves healthy providers when another provider fails", async () => {
  const catalog = await buildAnalysisModelCatalog(fakeLlm(validOutput()), { provider: "provider-a", model: "model-a", reasoningEffort: "low" });
  assert.equal(catalog.groups.length, 1);
  assert.equal(catalog.groups[0].models[0].reasoning.efforts[0].id, "low");
  assert.equal(catalog.groups[0].models[0].contextWindow, 32_000);
  assert.equal(catalog.failures.length, 1);
  assert.equal(catalog.failures[0].id, "provider-b");
});

test("analysis input is deterministic and omits provider credentials", () => {
  const snapshot = readySnapshot();
  const config = analysisConfig().analysis;
  const context = { snapshot, bars: { XAU: { "5m": [] } } };
  const selection = { provider: "provider-a", model: "model-a", reasoningEffort: "low" };
  const first = buildAnalysisInput(context, selection, config);
  const second = buildAnalysisInput(context, selection, config);
  assert.equal(stableJson(first), stableJson(second));
  assert.equal(analysisInputHash(first), analysisInputHash(second));
  assert.equal(first.instruments.xauSpot.market, "spot");
  assert.equal(first.instruments.goldFutures.market, "futures");
  assert.equal(first.instruments.cmb.customerBuy, 953);
  assert.equal(first.constraints.noOrderExecution, true);
  assert.doesNotMatch(stableJson(first), /apiKey|Authorization|baseURL/);
});

test("output validation pins host identity and rejects executable actions", () => {
  const output = validateAnalysisOutput(validOutput(), {
    asOf: "2026-08-14T02:00:00.000Z",
    provider: "provider-a",
    model: "model-a",
    quality: { ready: true },
    riskDisclosure: "Host disclosure",
  });
  assert.equal(output.provider, "provider-a");
  assert.equal(output.model, "model-a");
  assert.equal(output.riskDisclosure, "Host disclosure");
  assert.equal(output.suggestedOrder, null);
  assert.throws(() => validateAnalysisOutput({ ...validOutput(), action: "buy" }, {
    asOf: "x", provider: "p", model: "m", quality: { ready: true }, riskDisclosure: "risk",
  }), /unsupported value/);
  assert.throws(() => validateAnalysisOutput({ ...validOutput(), suggestedOrder: { side: "buy" } }, {
    asOf: "x", provider: "p", model: "m", quality: { ready: true }, riskDisclosure: "risk",
  }), /must be null/);
});

test("stream collector joins text chunks and records usage and finish", async () => {
  async function* stream() {
    yield { type: "text-delta", index: 0, text: "{\"ok\":" };
    yield { type: "text-delta", index: 0, text: "true}" };
    yield { type: "usage", usage: { inputTokens: 1, outputTokens: 2 } };
    yield { type: "finish", reason: { kind: "stop" } };
  }
  const assembled = await collectModelStream(stream());
  assert.equal(assembled.text, '{"ok":true}');
  assert.deepEqual(assembled.usage, { inputTokens: 1, outputTokens: 2 });
  assert.equal(assembled.finish.kind, "stop");
});

test("analysis log keeps partial model output when the provider finishes with an error", async (t) => {
  const { store } = await tempStore(t);
  const llm = fakeLlm(validOutput(), { finishError: true });
  const module = new AnalysisModule({
    llm,
    getContext: async () => ({ snapshot: readySnapshot(), bars: {} }),
    getConfig: analysisConfig,
    logStore: store,
  });

  const response = await module.run({ force: true });
  assert.equal(response.ok, false);
  assert.equal(response.error.code, "RATE_LIMIT");
  const logs = store.query({ detail: true });
  assert.equal(logs.logs.length, 1);
  assert.equal(logs.logs[0].status, "error");
  assert.equal(logs.logs[0].modelOutput, JSON.stringify(validOutput()));
});

test("analysis module records success and reuses a cooldown cache", async (t) => {
  const { store } = await tempStore(t);
  const llm = fakeLlm(validOutput());
  const context = { snapshot: readySnapshot(), bars: { XAU: { "5m": [] } } };
  const module = new AnalysisModule({
    llm,
    getContext: async () => context,
    getConfig: analysisConfig,
    logStore: store,
  });

  const first = await module.run({ locale: "en" });
  const second = await module.run({ locale: "en" });
  assert.equal(first.ok, true);
  assert.equal(first.status, "success");
  assert.equal(second.cached, true);
  assert.equal(second.queryId, first.queryId);
  assert.equal(llm.calls, 1);

  const logs = store.query({ detail: true });
  assert.equal(logs.logs.length, 1);
  assert.equal(logs.logs[0].status, "success");
  assert.deepEqual(logs.logs[0].usage, { inputTokens: 100, outputTokens: 50 });
  assert.equal(logs.logs[0].result.action, "observe");
  assert.equal(logs.logs[0].input.position.configured, true);
});

test("analysis module deduplicates a running query and force bypasses completed cache", async (t) => {
  const { store } = await tempStore(t);
  let release;
  const wait = new Promise((resolve) => { release = resolve; });
  const llm = fakeLlm(validOutput(), { wait });
  const module = new AnalysisModule({
    llm,
    getContext: async () => ({ snapshot: readySnapshot(), bars: {} }),
    getConfig: analysisConfig,
    logStore: store,
  });

  const firstPromise = module.run();
  while (llm.calls === 0) await new Promise((resolve) => setImmediate(resolve));
  const duplicate = await module.run();
  assert.equal(duplicate.status, "running");
  assert.equal(duplicate.reused, true);
  assert.equal(llm.calls, 1);
  release();
  const first = await firstPromise;
  assert.equal(first.ok, true);
  assert.equal(duplicate.queryId, first.queryId);

  const forced = await module.run({ force: true });
  assert.equal(forced.ok, true);
  assert.notEqual(forced.queryId, first.queryId);
  assert.equal(llm.calls, 2);
  assert.equal(store.query().logs.length, 2);
});

test("analysis timeout aborts a non-terminating stream and records the lifecycle", async (t) => {
  const { store } = await tempStore(t);
  const llm = fakeLlm(validOutput(), { wait: new Promise(() => {}) });
  const config = analysisConfig();
  config.analysis.timeoutMs = 10;
  const module = new AnalysisModule({
    llm,
    getContext: async () => ({ snapshot: readySnapshot(), bars: {} }),
    getConfig: () => config,
    logStore: store,
    minimumTimeoutMs: 5,
  });
  const result = await module.run();
  assert.equal(result.ok, false);
  assert.equal(result.status, "error");
  assert.equal(result.error.code, "ANALYSIS_TIMEOUT");
  const log = store.query({ detail: true }).logs[0];
  assert.equal(log.status, "error");
  assert.equal(log.error.code, "ANALYSIS_TIMEOUT");
});

test("analysis module blocks model I/O when the host quality gate fails", async (t) => {
  const { store } = await tempStore(t);
  const llm = fakeLlm(validOutput());
  const snapshot = readySnapshot();
  snapshot.quality = { ready: false, reasonCodes: ["data_stale"] };
  const module = new AnalysisModule({
    llm,
    getContext: async () => ({ snapshot, bars: {} }),
    getConfig: analysisConfig,
    logStore: store,
  });
  const result = await module.run();
  assert.equal(result.ok, false);
  assert.equal(result.status, "blocked");
  assert.equal(result.error.code, "DATA_STALE");
  assert.equal(llm.calls, 0);
  assert.equal(store.query().logs.length, 0);
});

test("invalid model JSON is an auditable invalid lifecycle", async (t) => {
  const { store } = await tempStore(t);
  const module = new AnalysisModule({
    llm: fakeLlm("```json\n{}\n```"),
    getContext: async () => ({ snapshot: readySnapshot(), bars: {} }),
    getConfig: analysisConfig,
    logStore: store,
  });
  const result = await module.run({ force: true });
  assert.equal(result.ok, false);
  assert.equal(result.status, "invalid");
  assert.equal(result.error.code, "INVALID_JSON");
  const log = store.query({ detail: true }).logs[0];
  assert.equal(log.status, "invalid");
  assert.equal(log.error.code, "INVALID_JSON");
});

test("analysis log merges lifecycle events, filters and paginates", async (t) => {
  const { store } = await tempStore(t);
  await store.start({ queryId: "q-1", requestedAt: "2026-08-14T01:00:00.000Z", provider: "p1", model: "m1" });
  await store.finish("q-1", { status: "success", finishedAt: "2026-08-14T01:00:01.000Z", result: validOutput() });
  await store.start({ queryId: "q-2", requestedAt: "2026-08-14T02:00:00.000Z", provider: "p2", model: "m2" });
  await store.finish("q-2", { status: "error", finishedAt: "2026-08-14T02:00:01.000Z", error: { code: "ERR", message: "failed" } });

  const page = store.query({ limit: 1 });
  assert.equal(page.logs.length, 1);
  assert.equal(page.logs[0].queryId, "q-2");
  assert.equal(page.hasMore, true);
  const next = store.query({ limit: 1, cursor: page.nextCursor });
  assert.equal(next.logs[0].queryId, "q-1");
  assert.equal(next.hasMore, false);
  assert.equal(store.query({ status: "success" }).logs[0].queryId, "q-1");
  assert.equal(store.query({ provider: "p2", detail: true }).logs[0].error.code, "ERR");

  const merged = mergeAnalysisLogEvents([
    { event: "started", queryId: "q", status: "running" },
    { event: "finished", queryId: "q", status: "success", result: { action: "wait" } },
  ]);
  assert.equal(merged.length, 1);
  assert.equal(merged[0].status, "success");
});

test("orphaned running log is marked aborted on restart", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "goldboard-analysis-orphan-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const file = join(directory, "analysis-log.jsonl");
  await writeFile(file, `${JSON.stringify({ schemaVersion: 1, event: "started", queryId: "orphan", status: "running", requestedAt: "2026-08-14T01:00:00.000Z" })}\n`, "utf8");
  const store = new AnalysisLogStore({ file });
  await store.init();
  const record = store.query({ queryId: "orphan", detail: true }).logs[0];
  assert.equal(record.status, "aborted");
  assert.equal(record.error.code, "ABORTED_OR_UNKNOWN");
  const persisted = await readFile(file, "utf8");
  assert.match(persisted, /ABORTED_OR_UNKNOWN/);
});

test("analysis log sanitization removes secrets and URL query credentials", () => {
  const value = sanitizeAnalysisLogValue({
    apiKey: "sk-secret",
    nested: { Authorization: "Bearer secret", safe: "ok" },
    url: "https://example.test/path?token=secret&x=1",
  });
  assert.equal(value.apiKey, "[redacted]");
  assert.equal(value.nested.Authorization, "[redacted]");
  assert.equal(value.nested.safe, "ok");
  const error = sanitizeAnalysisError(new Error("failed at https://example.test/path?api_key=secret&x=1 Authorization:BearerSecret"));
  assert.doesNotMatch(error.message, /secret|BearerSecret/);
  assert.match(error.message, /\[redacted\]/);
});
