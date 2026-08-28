import { createHash, randomUUID } from "node:crypto";

import { sanitizeAnalysisError, sanitizeAnalysisLogValue } from "./analysis-log.js";

const OUTPUT_STATUS = new Set(["analysis_ready", "insufficient_data", "stale", "invalid"]);
const OUTPUT_BIAS = new Set(["bullish", "bearish", "neutral", "unknown"]);
const OUTPUT_HORIZON = new Set(["intraday", "swing"]);
const OUTPUT_ACTION = new Set(["wait", "observe", "risk_reduce", "manual_review"]);
const OUTPUT_CONFIDENCE = new Set(["low", "medium", "high"]);
const MAX_MODEL_TEXT = 64 * 1024;

export function sanitizeModelOutput(text) {
  const source = String(text ?? "");
  try {
    return JSON.stringify(sanitizeAnalysisLogValue(JSON.parse(source)));
  } catch {
    return sanitizeAnalysisLogValue(source);
  }
}

function plainError(code, details) {
  return { ok: false, status: "error", error: { code, ...(details === undefined ? {} : { details }) } };
}

function errorWithCode(code, message, cause) {
  const error = new Error(message);
  error.code = code;
  if (cause !== undefined) error.cause = cause;
  return error;
}

function stringValue(value, field, limit = 2_000) {
  if (typeof value !== "string" || value === "" || value.length > limit) throw errorWithCode("INVALID_SCHEMA", `${field} must be a non-empty string within ${limit} characters`);
  return value;
}

function enumValue(value, allowed, field) {
  if (!allowed.has(value)) throw errorWithCode("INVALID_SCHEMA", `${field} has an unsupported value`);
  return value;
}

function stringList(value, field, limit = 32) {
  if (!Array.isArray(value) || value.length > limit) throw errorWithCode("INVALID_SCHEMA", `${field} must be an array of at most ${limit} values`);
  return value.map((entry, index) => stringValue(entry, `${field}[${index}]`, 1_000));
}

function numberList(value, field, limit = 32) {
  if (!Array.isArray(value) || value.length > limit) throw errorWithCode("INVALID_SCHEMA", `${field} must be an array of at most ${limit} values`);
  return value.map((entry, index) => {
    if (typeof entry !== "number" || !Number.isFinite(entry)) throw errorWithCode("INVALID_SCHEMA", `${field}[${index}] must be a finite number`);
    return entry;
  });
}

function stableValue(value) {
  if (Array.isArray(value)) return value.map(stableValue);
  if (!value || typeof value !== "object") return value;
  const out = {};
  for (const key of Object.keys(value).sort()) out[key] = stableValue(value[key]);
  return out;
}

export function stableJson(value) {
  return JSON.stringify(stableValue(value));
}

export function analysisInputHash(value) {
  return `sha256:${createHash("sha256").update(stableJson(value)).digest("hex")}`;
}

function errorMessage(error) {
  return error instanceof Error ? error.message : String(error);
}

/** Build the same provider-neutral catalog projection used by Harness settings. */
export async function buildAnalysisModelCatalog(llm, current = {}, signal) {
  if (!llm || typeof llm.listProviders !== "function") {
    return {
      generatedAt: new Date().toISOString(),
      current,
      groups: [],
      failures: [{ id: "llm", name: "LLM", message: "LLM runtime unavailable" }],
    };
  }
  let providers;
  try {
    providers = llm.listProviders();
  } catch (error) {
    return {
      generatedAt: new Date().toISOString(),
      current,
      groups: [],
      failures: [{ id: "llm", name: "LLM", message: errorMessage(error) }],
    };
  }
  const catalog = await Promise.all(providers.map(async (provider) => {
    try {
      const models = await llm.listModels(provider.id);
      const entries = await Promise.all(models.map(async (model) => {
        const resolved = await llm.resolveModelInfo(provider.id, model.id, signal);
        const reasoning = resolved.reasoning === undefined ? undefined : {
          efforts: resolved.reasoning.efforts.map((effort) => ({
            id: String(effort.id),
            name: effort.name,
            ...(effort.description === undefined ? {} : { description: effort.description }),
          })),
          ...(resolved.reasoning.defaultEffort === undefined ? {} : { defaultEffort: String(resolved.reasoning.defaultEffort) }),
        };
        return {
          id: model.id,
          name: model.name,
          ...(model.description === undefined ? {} : { description: model.description }),
          ...(resolved.context?.contextWindow === undefined ? {} : { contextWindow: resolved.context.contextWindow }),
          ...(resolved.defaultMaxTokens === undefined ? {} : { defaultMaxTokens: resolved.defaultMaxTokens }),
          ...(reasoning === undefined ? {} : { reasoning }),
        };
      }));
      return { kind: "group", value: { id: provider.id, name: provider.name, models: entries } };
    } catch (error) {
      return { kind: "failure", value: { id: provider.id, name: provider.name, message: errorMessage(error) } };
    }
  }));
  return {
    generatedAt: new Date().toISOString(),
    current,
    groups: catalog.filter((entry) => entry.kind === "group" && entry.value.models.length > 0).map((entry) => entry.value),
    failures: catalog.filter((entry) => entry.kind === "failure").map((entry) => entry.value),
  };
}

function quoteProjection(quote) {
  if (!quote || typeof quote !== "object") return null;
  return {
    instrument: quote.instrument ?? null,
    market: quote.market ?? null,
    currency: quote.currency ?? null,
    unit: quote.unit ?? null,
    price: Number.isFinite(Number(quote.price)) ? Number(quote.price) : null,
    bid: Number.isFinite(Number(quote.bid)) ? Number(quote.bid) : null,
    ask: Number.isFinite(Number(quote.ask)) ? Number(quote.ask) : null,
    customerBuy: Number.isFinite(Number(quote.customerBuy ?? quote.buyPrice)) ? Number(quote.customerBuy ?? quote.buyPrice) : null,
    customerSell: Number.isFinite(Number(quote.customerSell ?? quote.sellPrice)) ? Number(quote.customerSell ?? quote.sellPrice) : null,
    spread: Number.isFinite(Number(quote.spread)) ? Number(quote.spread) : null,
    source: quote.source ?? null,
    sourceTimestamp: quote.sourceTimestamp ?? quote.time ?? null,
    receivedAt: quote.receivedAt ?? null,
    stale: quote.stale === true,
    quality: quote.quality ?? null,
  };
}

function barsProjection(barsByInstrument) {
  const out = {};
  for (const [instrument, intervals] of Object.entries(barsByInstrument ?? {})) {
    out[instrument] = {};
    for (const [interval, bars] of Object.entries(intervals ?? {})) {
      const list = Array.isArray(bars) ? bars : [];
      out[instrument][interval] = {
        count: list.length,
        synthetic: list.some((bar) => bar?.synthetic === true),
        latest: list.slice(-20).map((bar) => ({
          t: bar.t,
          o: bar.o,
          h: bar.h,
          l: bar.l,
          c: bar.c,
          complete: bar.complete !== false,
          synthetic: bar.synthetic === true,
        })),
      };
    }
  }
  return out;
}

/** Build the only model-facing market document; credentials never enter it. */
export function buildAnalysisInput(context, selection, config) {
  const snapshot = context?.snapshot;
  if (!snapshot || snapshot.ok !== true) throw errorWithCode("SNAPSHOT_UNAVAILABLE", "market snapshot unavailable");
  const riskDisclosure = typeof config?.riskDisclosure === "string" && config.riskDisclosure !== ""
    ? config.riskDisclosure
    : "技术面参考，非投资建议。";
  return {
    schemaVersion: 1,
    asOf: snapshot.serverTime,
    timezone: "Asia/Shanghai",
    observedAt: snapshot.serverTime,
    selection: {
      provider: selection.provider,
      model: selection.model,
      ...(selection.reasoningEffort ? { reasoningEffort: selection.reasoningEffort } : {}),
    },
    instruments: {
      au9999: quoteProjection(snapshot.quotes?.AU9999),
      xauSpot: quoteProjection(snapshot.quotes?.XAU),
      goldFutures: quoteProjection(snapshot.quotes?.GCF),
      usdcny: quoteProjection(snapshot.quotes?.USDCNY),
      cmb: quoteProjection(snapshot.quotes?.CMB),
    },
    derived: snapshot.derived ?? {},
    closedBars: barsProjection(context?.bars),
    indicators: snapshot.indicators ?? {},
    quality: snapshot.quality ?? {},
    market: snapshot.market ?? { state: snapshot.marketState },
    position: {
      grams: snapshot.position?.grams ?? 0,
      avgCostPerGram: snapshot.position?.avgCostPerGram ?? 0,
      feeAdjustedPnl: snapshot.position?.feeAdjustedPnl ?? null,
      valuationReasonCode: snapshot.position?.valuationReasonCode ?? null,
    },
    plan: {
      action: snapshot.plan?.action ?? "no_data",
      reasonCodes: snapshot.plan?.reasonCodes ?? [],
      dataCoverage: snapshot.plan?.dataCoverage ?? {},
      ruleScore: snapshot.plan?.ruleScore ?? snapshot.plan?.confidenceScore,
      ruleScoreMax: snapshot.plan?.ruleScoreMax ?? snapshot.plan?.confidenceMax,
      cooldown: snapshot.plan?.reasonCodes?.includes("cooldown_active") === true,
      suggestedOrder: snapshot.plan?.suggestedOrder ?? null,
    },
    constraints: {
      noPriceFabrication: true,
      noOrderExecution: true,
      noExternalNews: true,
      modelActions: ["wait", "observe", "risk_reduce", "manual_review"],
    },
    riskDisclosure,
  };
}

function auditInput(input) {
  return {
    schemaVersion: input.schemaVersion,
    asOf: input.asOf,
    selection: input.selection,
    instruments: input.instruments,
    derived: input.derived,
    quality: input.quality,
    market: input.market,
    position: { configured: Number(input.position?.grams) > 0 },
    plan: input.plan,
    constraints: input.constraints,
    riskDisclosure: input.riskDisclosure,
  };
}

export function validateAnalysisOutput(value, context) {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw errorWithCode("INVALID_SCHEMA", "analysis output must be an object");
  const allowedKeys = new Set(["status", "bias", "horizon", "action", "confidence", "evidence", "support", "resistance", "reassessWhen", "invalidations", "dataWarnings", "suggestedOrder", "riskDisclosure", "summary"]);
  for (const key of Object.keys(value)) {
    if (!allowedKeys.has(key)) throw errorWithCode("INVALID_SCHEMA", `analysis output has unknown field ${key}`);
  }
  if (value.suggestedOrder !== null) throw errorWithCode("INVALID_SCHEMA", "suggestedOrder must be null");
  const result = {
    status: enumValue(value.status, OUTPUT_STATUS, "status"),
    asOf: context.asOf,
    provider: context.provider,
    model: context.model,
    bias: enumValue(value.bias, OUTPUT_BIAS, "bias"),
    horizon: enumValue(value.horizon, OUTPUT_HORIZON, "horizon"),
    action: enumValue(value.action, OUTPUT_ACTION, "action"),
    confidence: enumValue(value.confidence, OUTPUT_CONFIDENCE, "confidence"),
    ...(value.summary === undefined ? {} : { summary: stringValue(value.summary, "summary", 2_000) }),
    evidence: stringList(value.evidence, "evidence"),
    support: numberList(value.support, "support"),
    resistance: numberList(value.resistance, "resistance"),
    reassessWhen: stringList(value.reassessWhen, "reassessWhen"),
    invalidations: stringList(value.invalidations, "invalidations"),
    dataWarnings: stringList(value.dataWarnings, "dataWarnings"),
    suggestedOrder: null,
    riskDisclosure: context.riskDisclosure,
  };
  if (context.quality?.ready !== true && result.status === "analysis_ready") {
    throw errorWithCode("INVALID_SCHEMA", "analysis_ready is forbidden while market quality is blocked");
  }
  return result;
}

export async function collectModelStream(stream) {
  const partials = new Map();
  const blocks = new Map();
  let usage;
  let finish = { kind: "stop" };
  for await (const chunk of stream) {
    if (chunk?.type === "text-delta") partials.set(chunk.index, `${partials.get(chunk.index) ?? ""}${chunk.text ?? ""}`);
    else if (chunk?.type === "block-end") blocks.set(chunk.index, chunk.block);
    else if (chunk?.type === "usage") usage = chunk.usage;
    else if (chunk?.type === "finish") finish = chunk.reason;
  }
  const indexes = Array.from(new Set([...partials.keys(), ...blocks.keys()])).sort((a, b) => a - b);
  const text = indexes.map((index) => {
    const block = blocks.get(index);
    return block?.type === "text" ? block.text : partials.get(index) ?? "";
  }).join("");
  return { text, usage, finish };
}

function finishError(finish) {
  if (!finish || finish.kind === "stop") return null;
  if (finish.kind === "error" || finish.kind === "aborted") {
    const error = errorWithCode(finish.failure?.code ?? (finish.kind === "aborted" ? "ANALYSIS_ABORTED" : "PROVIDER_ERROR"), finish.failure?.message ?? finish.kind);
    error.status = finish.failure?.status;
    error.requestId = finish.failure?.requestId;
    return error;
  }
  if (finish.kind === "max-tokens") return errorWithCode("MAX_TOKENS", "model output reached max tokens");
  if (finish.kind === "tool-calls") return errorWithCode("UNEXPECTED_TOOL_CALL", "analysis model requested a tool");
  return errorWithCode("UNSUPPORTED_FINISH_REASON", `unsupported finish reason: ${String(finish.kind)}`);
}

function promptFor(locale, riskDisclosure) {
  const language = locale === "en" ? "English" : "Simplified Chinese";
  return [
    "You are a technical-analysis explainer inside a gold market dashboard.",
    `Write user-facing strings in ${language}.`,
    "Return exactly one JSON object and no Markdown, prose wrapper, or code fence.",
    "Use only the supplied prices, closed bars, indicators, quality checks, and rule plan.",
    "Never invent missing prices, bars, volume, fees, costs, news, or macro facts.",
    "Never recommend or execute buy, sell, or add_position. Allowed actions: wait, observe, risk_reduce, manual_review.",
    "suggestedOrder must always be null. The host rule plan is authoritative and cannot be upgraded by the model.",
    "Required fields: status, bias, horizon, action, confidence, evidence, support, resistance, reassessWhen, invalidations, dataWarnings, suggestedOrder, riskDisclosure.",
    "Include a concise plain-language summary in the summary field: one or two everyday sentences that explain the overall situation to a non-expert. Do not use raw enum identifiers such as data_incomplete_5m, insufficient_data, wait, or suggestedOrder inside summary, evidence, invalidations, reassessWhen, or dataWarnings; rewrite them as plain human-readable language.",
    "Every list must contain at most 32 items; evidence, reassessWhen, invalidations, and dataWarnings items must be non-empty strings; support and resistance items must be JSON numbers (never quoted strings), finite, and contain no units or commas.",
    "Enums: status=analysis_ready|insufficient_data|stale|invalid; bias=bullish|bearish|neutral|unknown; horizon=intraday|swing; confidence=low|medium|high.",
    "When the supplied market quality is not ready, status must be insufficient_data, stale, or invalid (never analysis_ready), and explain the data limitations in dataWarnings.",
    `riskDisclosure must convey this exact boundary: ${riskDisclosure}`,
  ].join("\n");
}

function queryId(now) {
  return `gold-analysis-${now.toISOString().replace(/[-:.TZ]/g, "").slice(0, 14)}-${randomUUID().slice(0, 8)}`;
}

function cacheKey(inputHash, selection, locale) {
  return [inputHash, selection.provider, selection.model, selection.reasoningEffort ?? "", locale].join("|");
}

// The cache key includes the latest price, so every tick produces a new key;
// without an eviction bound the map grows forever. 32 entries comfortably
// cover the cooldown-window repeats the cache exists for.
const ANALYSIS_CACHE_MAX = 32;

async function resolvedSelection(llm, requested) {
  const info = await llm.resolveModelInfo(requested.provider, requested.model);
  let reasoningEffort = requested.reasoningEffort;
  if (!reasoningEffort && info.reasoning?.efforts?.some((effort) => String(effort.id) === "low")) reasoningEffort = "low";
  return { ...requested, ...(reasoningEffort ? { reasoningEffort } : {}) };
}

export class AnalysisModule {
  constructor(options) {
    this.llm = options.llm;
    this.getContext = options.getContext;
    this.getConfig = options.getConfig;
    this.logStore = options.logStore;
    this.logger = options.logger;
    this.now = typeof options.now === "function" ? options.now : () => new Date();
    this.onResult = typeof options.onResult === "function" ? options.onResult : () => {};
    this.minimumTimeoutMs = Number.isFinite(Number(options.minimumTimeoutMs)) ? Math.max(1, Number(options.minimumTimeoutMs)) : 5_000;
    this.running = new Map();
    this.cache = new Map();
    this.controllers = new Set();
    this.disposed = false;
    this.last = null;
  }

  dispose() {
    this.disposed = true;
    for (const controller of this.controllers) controller.abort(errorWithCode("ANALYSIS_ABORTED", "plugin disposed"));
    this.controllers.clear();
  }

  async models() {
    const cfg = this.getConfig()?.analysis ?? {};
    return buildAnalysisModelCatalog(this.llm, {
      provider: cfg.provider ?? "",
      model: cfg.model ?? "",
      reasoningEffort: cfg.reasoningEffort ?? "",
    });
  }

  status() {
    return {
      running: Array.from(this.running.values()).map((entry) => ({ queryId: entry.queryId, startedAt: entry.startedAt })),
      last: this.last,
      log: this.logStore?.health?.(),
    };
  }

  async run(request = {}) {
    if (this.disposed) return plainError("ANALYSIS_ABORTED");
    const config = this.getConfig()?.analysis ?? {};
    if (config.enabled !== true) return plainError("ANALYSIS_DISABLED");
    if (!this.llm) return plainError("LLM_UNAVAILABLE");
    const provider = typeof request.provider === "string" && request.provider !== "" ? request.provider : config.provider;
    const model = typeof request.model === "string" && request.model !== "" ? request.model : config.model;
    if (!provider || !model) return plainError("MODEL_NOT_SELECTED");
    const requested = {
      provider,
      model,
      reasoningEffort: typeof request.reasoningEffort === "string" && request.reasoningEffort !== ""
        ? request.reasoningEffort
        : config.reasoningEffort || undefined,
      temperature: Number.isFinite(Number(config.temperature)) ? Number(config.temperature) : 0.1,
      maxTokens: Number.isFinite(Number(config.maxTokens)) ? Number(config.maxTokens) : 1_600,
    };
    const context = await this.getContext();
    if (!context?.snapshot) return plainError("SNAPSHOT_UNAVAILABLE");
    let selection;
    try {
      selection = await resolvedSelection(this.llm, requested);
    } catch (error) {
      return plainError("MODEL_UNAVAILABLE", { provider, model, code: error?.code });
    }
    const locale = request.locale === "en" ? "en" : "zh";
    const input = buildAnalysisInput(context, selection, config);
    const inputHash = analysisInputHash(input);
    const key = cacheKey(inputHash, selection, locale);
    const running = this.running.get(key);
    if (running) return { ok: true, queryId: running.queryId, status: "running", reused: true };
    const cooldownMs = Math.max(0, Number(config.cooldownMinutes) || 0) * 60_000;
    const cached = this.cache.get(key);
    if (request.force !== true && cached && this.now().getTime() - cached.finishedAt < cooldownMs) {
      return { ...cached.response, cached: true };
    }
    const startedAt = this.now();
    const id = queryId(startedAt);
    const call = {
      id,
      key,
      selection,
      requested,
      input,
      inputHash,
      locale,
      timeoutMs: Math.max(this.minimumTimeoutMs, Math.min(180_000, Number(config.timeoutMs) || 60_000)),
      signal: request.signal,
      riskDisclosure: input.riskDisclosure,
    };
    // Reserve the key before any async lifecycle work begins, so concurrent
    // requests cannot start an identical provider call between log writes.
    const operation = Promise.resolve().then(() => this.execute(call));
    this.running.set(key, { queryId: id, startedAt: startedAt.toISOString(), operation });
    try {
      return await operation;
    } finally {
      this.running.delete(key);
    }
  }

  async execute(call) {
    const startedAt = this.now();
    await this.logStore?.start?.({
      queryId: call.id,
      requestedAt: startedAt.toISOString(),
      startedAt: startedAt.toISOString(),
      provider: call.selection.provider,
      model: call.selection.model,
      reasoningEffort: call.selection.reasoningEffort,
      snapshotAsOf: call.input.asOf,
      inputHash: call.inputHash,
      ruleAction: call.input.plan.action,
      dataQuality: call.input.quality,
      input: auditInput(call.input),
      sources: call.input.instruments,
      indicators: call.input.indicators,
    });
    const controller = new AbortController();
    this.controllers.add(controller);
    const abortFromCaller = () => controller.abort(call.signal?.reason ?? errorWithCode("ANALYSIS_ABORTED", "analysis aborted"));
    if (call.signal?.aborted) abortFromCaller();
    else call.signal?.addEventListener?.("abort", abortFromCaller, { once: true });
    const timeout = setTimeout(() => controller.abort(errorWithCode("ANALYSIS_TIMEOUT", "analysis timed out")), call.timeoutMs);
    let usage;
    let finish;
    let modelOutput = null;
    try {
      const proposal = {
        provider: call.selection.provider,
        model: call.selection.model,
        ...(call.selection.reasoningEffort ? { reasoningEffort: call.selection.reasoningEffort } : {}),
        temperature: call.requested.temperature,
        maxTokens: call.requested.maxTokens,
      };
      const prepared = await this.llm.prepareCall(proposal, controller.signal);
      const message = {
        id: `gold-analysis-message-${randomUUID()}`,
        role: "user",
        content: [{ type: "text", text: stableJson(call.input) }],
        source: { kind: "plugin", plugin: "dsh-plugin-goldboard" },
      };
      const options = {
        ...prepared.config,
        messages: [message],
        system: promptFor(call.locale, call.riskDisclosure),
        signal: controller.signal,
      };
      const streamPromise = collectModelStream(prepared.stream(options));
      void streamPromise.catch(() => {});
      const abortPromise = new Promise((_, reject) => {
        if (controller.signal.aborted) {
          reject(controller.signal.reason ?? errorWithCode("ANALYSIS_ABORTED", "analysis aborted"));
          return;
        }
        controller.signal.addEventListener("abort", () => {
          reject(controller.signal.reason ?? errorWithCode("ANALYSIS_ABORTED", "analysis aborted"));
        }, { once: true });
      });
      const assembled = await Promise.race([streamPromise, abortPromise]);
      usage = assembled.usage;
      finish = assembled.finish;
      // Preserve text received before provider errors or token-limit finishes so the
      // audit log can explain what the model actually returned.
      const text = assembled.text.trim();
      modelOutput = sanitizeModelOutput(text);
      const terminal = finishError(finish);
      if (terminal) throw terminal;
      if (text === "") throw errorWithCode("EMPTY_MODEL_OUTPUT", "model produced no text");
      if (Buffer.byteLength(text, "utf8") > MAX_MODEL_TEXT) throw errorWithCode("MODEL_OUTPUT_TOO_LARGE", "model output exceeded the analysis limit");
      let parsed;
      try {
        parsed = JSON.parse(text);
      } catch (error) {
        throw errorWithCode("INVALID_JSON", "model output is not strict JSON", error);
      }
      const result = validateAnalysisOutput(parsed, {
        asOf: call.input.asOf,
        provider: call.selection.provider,
        model: call.selection.model,
        quality: call.input.quality,
        riskDisclosure: call.riskDisclosure,
      });
      const finishedAt = this.now();
      const response = { ok: true, queryId: call.id, status: "success", analysis: result };
      await this.logStore?.finish?.(call.id, {
        status: "success",
        finishedAt: finishedAt.toISOString(),
        durationMs: finishedAt.getTime() - startedAt.getTime(),
        usage,
        finishReason: finish?.kind,
        result,
        modelOutput,
        error: null,
      });
      this.last = { queryId: call.id, status: "success", finishedAt: finishedAt.toISOString(), result };
      this.cache.set(call.key, { finishedAt: finishedAt.getTime(), response });
      // Bounded cache: drop the oldest entries (Map insertion order ≈ LRU —
      // hits only happen within a cooldown window of repeated clicks).
      while (this.cache.size > ANALYSIS_CACHE_MAX) {
        const oldest = this.cache.keys().next().value;
        this.cache.delete(oldest);
      }
      this.onResult(this.last);
      return response;
    } catch (error) {
      const finishedAt = this.now();
      const timeoutAbort = controller.signal.aborted && controller.signal.reason?.code === "ANALYSIS_TIMEOUT";
      const code = timeoutAbort ? "ANALYSIS_TIMEOUT" : error?.code ?? (controller.signal.aborted ? "ANALYSIS_ABORTED" : "ANALYSIS_FAILED");
      const invalid = ["MAX_TOKENS", "INVALID_JSON", "INVALID_SCHEMA", "EMPTY_MODEL_OUTPUT", "MODEL_OUTPUT_TOO_LARGE", "UNEXPECTED_TOOL_CALL"].includes(code);
      const aborted = !timeoutAbort && (code === "ANALYSIS_ABORTED" || error?.name === "AbortError");
      const status = invalid ? "invalid" : aborted ? "aborted" : "error";
      const safeError = sanitizeAnalysisError({ ...error, code, message: error?.message ?? code, status: error?.status, requestId: error?.requestId });
      await this.logStore?.finish?.(call.id, {
        status,
        finishedAt: finishedAt.toISOString(),
        durationMs: finishedAt.getTime() - startedAt.getTime(),
        usage,
        finishReason: finish?.kind,
        result: null,
        modelOutput,
        error: safeError,
      });
      const response = { ok: false, queryId: call.id, status, error: { code } };
      this.last = { queryId: call.id, status, finishedAt: finishedAt.toISOString(), error: safeError };
      this.onResult(this.last);
      this.logger?.warn?.(`dsh-plugin-goldboard: analysis ${call.id} failed: ${code}`);
      return response;
    } finally {
      clearTimeout(timeout);
      this.controllers.delete(controller);
      call.signal?.removeEventListener?.("abort", abortFromCaller);
    }
  }
}

export function analysisLogSafeView(value) {
  return sanitizeAnalysisLogValue(value);
}

/**
 * Validate the analysis section of a POST /config payload before adoption
 * (plan-05: moved out of the composition root). Throws coded errors the
 * route maps to 400s; a no-op while analysis stays disabled.
 */
export async function validateAnalysisConfig(llm, nextConfig) {
  const analysis = nextConfig.analysis;
  if (analysis.enabled !== true) return;
  if (!analysis.provider || !analysis.model) {
    const error = new Error("analysis provider and model are required");
    error.code = "MODEL_NOT_SELECTED";
    throw error;
  }
  // plan-05 P2#24 adjudication: llm is a hard inject — the web profile
  // always provides it, so there is no fallback probe.
  if (!llm || typeof llm.prepareCall !== "function") {
    const error = new Error("LLM runtime unavailable");
    error.code = "LLM_UNAVAILABLE";
    throw error;
  }
  try {
    await llm.prepareCall({
      provider: analysis.provider,
      model: analysis.model,
      ...(analysis.reasoningEffort ? { reasoningEffort: analysis.reasoningEffort } : {}),
      temperature: analysis.temperature,
      maxTokens: analysis.maxTokens,
    });
  } catch (cause) {
    const error = new Error("selected analysis model is unavailable");
    error.code = "MODEL_UNAVAILABLE";
    error.cause = cause;
    throw error;
  }
}
