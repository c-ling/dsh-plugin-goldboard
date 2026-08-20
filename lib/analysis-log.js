import { createReadStream } from "node:fs";
import { appendFile, mkdir, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { createInterface } from "node:readline";

const SENSITIVE_KEY = /(?:authorization|proxy-authorization|api[-_]?key|secret|password|cookie|set-cookie|credential|access[-_]?token|refresh[-_]?token|headers?)/i;
const MAX_LOG_STRING = 8_192;
const VALID_STATUSES = new Set(["running", "success", "error", "aborted", "invalid"]);

function boundedString(value, limit = MAX_LOG_STRING) {
  const text = String(value ?? "");
  return text.length <= limit ? text : `${text.slice(0, Math.max(0, limit - 1))}…`;
}

function redactUrl(raw) {
  try {
    const url = new URL(raw);
    for (const key of url.searchParams.keys()) {
      if (SENSITIVE_KEY.test(key) || /(?:key|secret|token|auth|signature)/i.test(key)) url.searchParams.set(key, "[redacted]");
    }
    return url.toString();
  } catch {
    return raw;
  }
}

export function sanitizeAnalysisError(error) {
  if (error === null || error === undefined) return null;
  const source = error instanceof Error
    ? { code: error.code, message: error.message, status: error.status ?? error.statusCode, requestId: error.requestId }
    : typeof error === "object"
      ? error
      : { message: String(error) };
  let message = boundedString(source.message ?? source.code ?? "analysis failed", 2_048)
    .replace(/(authorization\s*[:=]\s*)([^\s,;]+)/ig, "$1[redacted]")
    .replace(/https?:\/\/[^\s"'<>]+/g, (match) => redactUrl(match));
  for (const marker of ["api_key", "apikey", "access_token", "refresh_token", "secret"]) {
    const expression = new RegExp(`(${marker}\\s*[:=]\\s*)([^\\s,;]+)`, "ig");
    message = message.replace(expression, "$1[redacted]");
  }
  return {
    code: boundedString(source.code ?? "ANALYSIS_FAILED", 128),
    message,
    ...(Number.isFinite(Number(source.status)) ? { status: Number(source.status) } : {}),
    ...(typeof source.requestId === "string" && source.requestId !== "" ? { requestId: boundedString(source.requestId, 256) } : {}),
  };
}

/** Produce a bounded JSON value while removing credential-shaped fields. */
export function sanitizeAnalysisLogValue(value, depth = 0, seen = new WeakSet()) {
  if (value === null || value === undefined) return value ?? null;
  if (typeof value === "string") {
    return boundedString(value).replace(/https?:\/\/[^\s"'<>]+/g, (match) => redactUrl(match));
  }
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  if (typeof value === "boolean") return value;
  if (typeof value !== "object") return boundedString(value);
  if (depth >= 8) return "[depth-limited]";
  if (seen.has(value)) return "[circular]";
  seen.add(value);
  if (Array.isArray(value)) {
    const out = value.slice(0, 200).map((entry) => sanitizeAnalysisLogValue(entry, depth + 1, seen));
    seen.delete(value);
    return out;
  }
  const out = {};
  let count = 0;
  for (const [key, entry] of Object.entries(value)) {
    if (count >= 200) break;
    count += 1;
    if (SENSITIVE_KEY.test(key)) {
      out[key] = "[redacted]";
      continue;
    }
    out[key] = sanitizeAnalysisLogValue(entry, depth + 1, seen);
  }
  seen.delete(value);
  return out;
}

function mergeEvent(record, event) {
  const merged = { ...(record ?? {}), ...event };
  delete merged.event;
  if (event.event === "started") merged.status = "running";
  return merged;
}

/** Merge JSONL lifecycle events into one record per query id. */
export function mergeAnalysisLogEvents(events) {
  const records = new Map();
  for (const event of Array.isArray(events) ? events : []) {
    if (!event || typeof event !== "object" || typeof event.queryId !== "string" || event.queryId === "") continue;
    records.set(event.queryId, mergeEvent(records.get(event.queryId), event));
  }
  return Array.from(records.values()).sort((a, b) => Date.parse(b.requestedAt ?? b.startedAt ?? 0) - Date.parse(a.requestedAt ?? a.startedAt ?? 0));
}

function cursorFor(queryId) {
  return Buffer.from(String(queryId), "utf8").toString("base64url");
}

function queryIdFromCursor(cursor) {
  if (typeof cursor !== "string" || cursor === "") return { kind: "absent" };
  try {
    const queryId = Buffer.from(cursor, "base64url").toString("utf8");
    return queryId === "" ? { kind: "invalid" } : { kind: "value", queryId };
  } catch {
    return { kind: "invalid" };
  }
}

function parseFilterTime(value) {
  if (typeof value !== "string" || value === "") return NaN;
  // Browser datetime-local has no offset. The Gold Board labels all market and
  // log timestamps in Beijing time, so interpret a bare value as Asia/Shanghai.
  const zoned = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2})?$/.test(value) ? `${value}+08:00` : value;
  return Date.parse(zoned);
}

function listView(record, detail) {
  const common = {
    schemaVersion: record.schemaVersion ?? 1,
    queryId: record.queryId,
    status: record.status,
    requestedAt: record.requestedAt,
    startedAt: record.startedAt,
    finishedAt: record.finishedAt,
    provider: record.provider,
    model: record.model,
    reasoningEffort: record.reasoningEffort,
    snapshotAsOf: record.snapshotAsOf,
    inputHash: record.inputHash,
    ruleAction: record.ruleAction,
    durationMs: record.durationMs,
    usage: record.usage,
    finishReason: record.finishReason,
    dataQuality: record.dataQuality,
    result: record.result,
    error: record.error,
    cached: record.cached === true,
  };
  if (!detail) {
    return {
      ...common,
      result: record.result ? {
        status: record.result.status,
        action: record.result.action,
        bias: record.result.bias,
        confidence: record.result.confidence,
      } : null,
      error: record.error ? { code: record.error.code, message: boundedString(record.error.message, 512) } : null,
    };
  }
  return {
    ...common,
    input: record.input,
    sources: record.sources,
    indicators: record.indicators,
    modelOutput: record.modelOutput,
  };
}

export class AnalysisLogStore {
  constructor(options) {
    if (!options || typeof options.file !== "string" || options.file === "") throw new TypeError("analysis log file is required");
    this.file = options.file;
    this.maxEntries = Math.min(5_000, Math.max(10, Number(options.maxEntries) || 500));
    this.logger = options.logger;
    this.now = typeof options.now === "function" ? options.now : () => new Date();
    this.records = new Map();
    this.tail = Promise.resolve();
    this.available = true;
    this.lastError = null;
  }

  async init() {
    const events = [];
    try {
      await mkdir(dirname(this.file), { recursive: true });
      const stream = createReadStream(this.file, { encoding: "utf8" });
      const lines = createInterface({ input: stream, crlfDelay: Infinity });
      for await (const line of lines) {
        if (line.trim() === "") continue;
        try {
          events.push(JSON.parse(line));
        } catch {
          // A torn final line must not make all prior audit records unreadable.
        }
      }
    } catch (error) {
      if (error?.code !== "ENOENT") this.fail(error);
    }
    for (const record of mergeAnalysisLogEvents(events)) this.records.set(record.queryId, record);
    this.prune();
    const orphans = Array.from(this.records.values()).filter((record) => record.status === "running");
    for (const record of orphans) {
      await this.finish(record.queryId, {
        status: "aborted",
        finishedAt: this.now().toISOString(),
        error: { code: "ABORTED_OR_UNKNOWN", message: "Host stopped before the analysis lifecycle completed" },
      });
    }
    return this;
  }

  health() {
    return {
      available: this.available,
      lastError: this.lastError,
      records: this.records.size,
      maxEntries: this.maxEntries,
    };
  }

  async start(fields) {
    const now = this.now().toISOString();
    const event = sanitizeAnalysisLogValue({
      schemaVersion: 1,
      event: "started",
      kind: "analysis",
      status: "running",
      requestedAt: fields.requestedAt ?? now,
      startedAt: fields.startedAt ?? now,
      ...fields,
    });
    if (typeof event.queryId !== "string" || event.queryId === "") throw new TypeError("analysis queryId is required");
    this.records.set(event.queryId, mergeEvent(this.records.get(event.queryId), event));
    this.prune();
    await this.append(event);
    return this.records.get(event.queryId);
  }

  async finish(queryId, fields) {
    const current = this.records.get(queryId) ?? { schemaVersion: 1, queryId, requestedAt: this.now().toISOString() };
    const status = VALID_STATUSES.has(fields?.status) && fields.status !== "running" ? fields.status : "error";
    const event = sanitizeAnalysisLogValue({
      schemaVersion: 1,
      event: "finished",
      kind: "analysis",
      queryId,
      status,
      finishedAt: fields?.finishedAt ?? this.now().toISOString(),
      ...fields,
      error: fields?.error === undefined ? current.error ?? null : sanitizeAnalysisError(fields.error),
    });
    this.records.set(queryId, mergeEvent(current, event));
    this.prune();
    await this.append(event, true);
    return this.records.get(queryId);
  }

  query(options = {}) {
    const limit = Math.min(100, Math.max(1, Number(options.limit) || 30));
    const detail = options.detail === true;
    const parsedFrom = parseFilterTime(options.from);
    const parsedTo = parseFilterTime(options.to);
    const from = Number.isFinite(parsedFrom) ? parsedFrom : -Infinity;
    const to = Number.isFinite(parsedTo) ? parsedTo : Infinity;
    let records = Array.from(this.records.values()).sort((a, b) => Date.parse(b.requestedAt ?? b.startedAt ?? 0) - Date.parse(a.requestedAt ?? a.startedAt ?? 0));
    if (typeof options.queryId === "string" && options.queryId !== "") records = records.filter((record) => record.queryId === options.queryId);
    if (typeof options.status === "string" && options.status !== "") records = records.filter((record) => record.status === options.status);
    if (typeof options.provider === "string" && options.provider !== "") records = records.filter((record) => record.provider === options.provider);
    if (typeof options.model === "string" && options.model !== "") records = records.filter((record) => record.model === options.model);
    records = records.filter((record) => {
      const timestamp = Date.parse(record.requestedAt ?? record.startedAt ?? "");
      return Number.isFinite(timestamp) && timestamp >= from && timestamp <= to;
    });
    const cursor = queryIdFromCursor(options.cursor);
    if (cursor.kind === "invalid") return { ok: false, error: { code: "BAD_CURSOR" }, logs: [], nextCursor: null, hasMore: false, health: this.health() };
    let start = 0;
    if (cursor.kind === "value") {
      const found = records.findIndex((record) => record.queryId === cursor.queryId);
      if (found < 0) return { ok: false, error: { code: "CURSOR_NOT_FOUND" }, logs: [], nextCursor: null, hasMore: false, health: this.health() };
      start = found + 1;
    }
    const page = records.slice(start, start + limit);
    const hasMore = start + page.length < records.length;
    return {
      ok: true,
      logs: page.map((record) => listView(record, detail)),
      nextCursor: hasMore && page.length > 0 ? cursorFor(page[page.length - 1].queryId) : null,
      hasMore,
      health: this.health(),
    };
  }

  prune() {
    const ordered = Array.from(this.records.values()).sort((a, b) => Date.parse(b.requestedAt ?? b.startedAt ?? 0) - Date.parse(a.requestedAt ?? a.startedAt ?? 0));
    for (const record of ordered.slice(this.maxEntries)) this.records.delete(record.queryId);
  }

  async setMaxEntries(value) {
    this.maxEntries = Math.min(5_000, Math.max(10, Number(value) || 500));
    const before = this.records.size;
    this.prune();
    if (this.records.size !== before) await this.compact().catch((error) => this.fail(error));
  }

  append(event, compact = false) {
    this.tail = this.tail.then(async () => {
      try {
        await mkdir(dirname(this.file), { recursive: true });
        await appendFile(this.file, `${JSON.stringify(event)}\n`, "utf8");
        if (compact && this.records.size >= this.maxEntries) await this.compact();
        this.available = true;
        this.lastError = null;
      } catch (error) {
        this.fail(error);
      }
    }, async () => {
      try {
        await appendFile(this.file, `${JSON.stringify(event)}\n`, "utf8");
      } catch (error) {
        this.fail(error);
      }
    });
    return this.tail;
  }

  async compact() {
    const records = Array.from(this.records.values()).sort((a, b) => Date.parse(a.requestedAt ?? a.startedAt ?? 0) - Date.parse(b.requestedAt ?? b.startedAt ?? 0));
    const body = records.map((record) => JSON.stringify({ ...record, event: "compacted" })).join("\n");
    const tmp = `${this.file}.tmp`;
    await writeFile(tmp, body === "" ? "" : `${body}\n`, "utf8");
    await rename(tmp, this.file);
  }

  fail(error) {
    this.available = false;
    this.lastError = boundedString(error?.message ?? error, 512);
    this.logger?.warn?.(`dsh-plugin-goldboard: analysis log unavailable: ${this.lastError}`);
  }
}
