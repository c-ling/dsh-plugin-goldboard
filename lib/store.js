/**
 * Persistence primitives: fault-tolerant JSON reads, atomic queued writes,
 * the partitioned-dirty state persister and the api-log store.
 *
 * plan-05: extracted from the old monolithic lib/index.js. Every instance is
 * created per plugin apply() — no module-level mutable state.
 */

import { appendFile, open, readFile, rename, stat, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

/** Root state directory of the running Harness ($DSH_HOME ?? ~/.dsh). */
export function dshHome() {
  return process.env.DSH_HOME ?? join(homedir(), ".dsh");
}

/** This plugin's storage directory under the Harness home. */
export function pluginDir() {
  return join(dshHome(), "storages", "dsh-plugin-goldboard");
}

/**
 * Read a JSON file, returning `fallback` on any read/parse failure (corrupt
 * state files must never crash the host).
 */
export async function readJson(file, fallback) {
  try {
    const text = await readFile(file, "utf8");
    return JSON.parse(text);
  } catch {
    return fallback;
  }
}

/** Serialize writers through one promise chain (no interleaved tmp renames). */
export function makeWriteQueue() {
  let chain = Promise.resolve();
  return function enqueue(fn) {
    chain = chain.then(fn, fn);
    return chain;
  };
}

/** Atomic write: tmp file + rename, ordered by the given queue. */
export function writeJsonAtomic(file, value, queue) {
  return queue(async () => {
    const tmp = `${file}.tmp`;
    await writeFile(tmp, JSON.stringify(value, null, 2), "utf8");
    await rename(tmp, file);
  });
}

/**
 * Partitioned-dirty state.json writer.
 *
 * `bars` (the MB-level bulk) is written at most once per barsFlushMs,
 * anchored to a whole-minute boundary so the write lands right after the
 * latest 1m bucket rolls over. Everything else (quotes / alertState /
 * signalState / lastSuggestedOrder / lastAlertLog, KB-level) writes
 * immediately when marked. state.json remains a single file; only the write
 * rhythm differs by section.
 */
export class StatePersister {
  /**
   * @param options.file          state.json path
   * @param options.writeQueue    makeWriteQueue() enqueue fn
   * @param options.serialize     () => plain-object snapshot of the runtime
   * @param options.logger        host logger (optional)
   * @param options.barsFlushMs   minimum interval between bar-only flushes
   */
  constructor({ file, writeQueue, serialize, logger = null, barsFlushMs = 5 * 60_000 }) {
    this.file = file;
    this.enqueue = writeQueue;
    this.serialize = serialize;
    this.logger = logger;
    this.barsFlushMs = barsFlushMs;
    this.dirty = { bars: false, other: false };
    this.lastFlushAt = 0;
    this.lastFlushMinuteBucket = -1;
  }

  markDirty(section) {
    if (section === "bars") this.dirty.bars = true;
    else this.dirty.other = true;
  }

  /** Write now (dispose / user-triggered mutations), ignoring the rhythm. */
  persist() {
    return this.flush(Date.now());
  }

  async flush(nowMs = Date.now()) {
    const hadBars = this.dirty.bars;
    const hadOther = this.dirty.other;
    this.dirty.bars = false;
    this.dirty.other = false;
    this.lastFlushAt = nowMs;
    this.lastFlushMinuteBucket = Math.floor(nowMs / 60_000);
    try {
      await writeJsonAtomic(this.file, this.serialize(), this.enqueue);
    } catch (error) {
      // Restore the flags so the next due tick retries the write.
      this.dirty.bars ||= hadBars;
      this.dirty.other ||= hadOther;
      this.logger?.warn?.(`dsh-plugin-goldboard: persist state failed: ${String(error?.message ?? error)}`);
    }
  }

  /** Tick-loop entry: honour the bars flush rhythm, others immediately. */
  maybeFlush(nowMs = Date.now()) {
    if (this.dirty.other) return this.flush(nowMs);
    if (!this.dirty.bars) return undefined;
    const minuteBucket = Math.floor(nowMs / 60_000);
    const due = nowMs - this.lastFlushAt >= this.barsFlushMs && minuteBucket !== this.lastFlushMinuteBucket;
    return due ? this.flush(nowMs) : undefined;
  }
}

const API_LOG_MAX_BYTES_DEFAULT = 2 * 1024 * 1024;
const API_LOG_TAIL_BYTES_DEFAULT = 256 * 1024;
const API_LOG_MAX_ENTRIES_DEFAULT = 500;

/**
 * Rotate the JSONL log when it exceeds maxBytes: the current file becomes
 * `<name>.1` (previous `.1` is overwritten, single generation kept).
 */
export async function rotateApiLogIfNeeded(path, maxBytes = API_LOG_MAX_BYTES_DEFAULT) {
  let size = 0;
  try {
    const info = await stat(path);
    size = info.size;
  } catch (error) {
    if (error?.code === "ENOENT") return false;
    throw error;
  }
  if (size <= maxBytes) return false;
  await rename(path, `${path}.1`);
  return true;
}

/**
 * Read at most the last tailBytes of a JSONL log and parse the last
 * maxEntries entries (newest first). Files smaller than the tail window are
 * read whole (previous behaviour). A torn first line — inevitable when the
 * window starts mid-JSON — is dropped instead of failing the read.
 */
export async function readApiLogsFromFile(path, tailBytes = API_LOG_TAIL_BYTES_DEFAULT, maxEntries = API_LOG_MAX_ENTRIES_DEFAULT) {
  let handle;
  try {
    handle = await open(path, "r");
  } catch (error) {
    if (error?.code === "ENOENT") return [];
    throw error;
  }
  try {
    const info = await handle.stat();
    const start = Math.max(0, info.size - tailBytes);
    const length = info.size - start;
    const buffer = Buffer.alloc(length);
    await handle.read(buffer, 0, length, start);
    const lines = buffer.toString("utf8").split("\n");
    // Drop the torn head line unless the window covers the file from byte 0.
    if (start > 0) lines.shift();
    const out = [];
    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      try {
        out.push(JSON.parse(trimmed));
      } catch {
        // Skip malformed lines.
      }
    }
    return out.slice(-maxEntries).reverse();
  } finally {
    await handle.close();
  }
}

/**
 * api-log persistence in the AnalysisLogStore mould: an append-only JSONL
 * file with size rotation, a tail-read loader, and an in-memory ring that
 * answers /api-logs queries. Appends are best-effort — a logging failure must
 * never break quote collection.
 */
export class ApiLogStore {
  constructor({ file = null, maxEntries = API_LOG_MAX_ENTRIES_DEFAULT, maxBytes = API_LOG_MAX_BYTES_DEFAULT, tailBytes = API_LOG_TAIL_BYTES_DEFAULT } = {}) {
    this.file = file;
    this.maxEntries = maxEntries;
    this.maxBytes = maxBytes;
    this.tailBytes = tailBytes;
    this.queue = makeWriteQueue();
    this.entries = [];
  }

  setFile(path) {
    this.file = path;
  }

  /** Load persisted entries (newest first) into the ring; best-effort. */
  async load() {
    if (!this.file) return [];
    try {
      const logs = await readApiLogsFromFile(this.file, this.tailBytes, this.maxEntries);
      this.entries = logs.slice(0, this.maxEntries);
      return this.entries.slice();
    } catch {
      // Ignore read failures; logs are best-effort.
      return [];
    }
  }

  /** Append one entry to the ring and schedule the JSONL write. */
  append(entry) {
    this.entries.unshift(entry);
    if (this.entries.length > this.maxEntries) this.entries.length = this.maxEntries;
    if (!this.file) return;
    void this.queue(async () => {
      try {
        await rotateApiLogIfNeeded(this.file, this.maxBytes);
        await appendFile(this.file, JSON.stringify(entry) + "\n", "utf8");
      } catch {
        // best-effort
      }
    });
  }

  /** Newest-first copy, optionally filtered by source id. */
  list(sourceId) {
    if (!sourceId) return this.entries.slice();
    return this.entries.filter((entry) => entry.sourceId === sourceId);
  }
}

// ── persisted-state restore ──────────────────────────────────────────────────

import { ensureBars, migrateBarsSeedVersion } from "./bars.js";
import { PREMIUM_DAY_SAMPLE_CAP, PREMIUM_HISTORY_CAP, cleanCmbSpreadSamples } from "./spread-stats.js";
import { defaultSignalState } from "./sizing.js";
import { SIGNAL_LANES } from "./plan.js";
import { ALERT_LOG_CAP } from "./alerts.js";

/**
 * Fold a persisted state.json (already validated as an object) into the
 * runtime — exactly what the composition root's inline loader did before
 * plan-05. Mutates runtime fields; tolerant of every missing field.
 */
export function restoreRuntimeState(runtime, savedState) {
  if (!savedState || typeof savedState !== "object") return;
  if (savedState.bars) {
    const bars = {
      AU9999: ensureBars(savedState.bars.AU9999),
      XAU: ensureBars(savedState.bars.XAU),
      GCF: ensureBars(savedState.bars.GCF),
      CMB: ensureBars(savedState.bars.CMB),
    };
    // State from an older seeding format carries corrupt 60m buckets;
    // drop the affected series so seedBars rebuilds them (see
    // migrateBarsSeedVersion / BARS_SEED_VERSION).
    migrateBarsSeedVersion(bars, savedState.barsSeedVersion);
    runtime.bars = bars;
  }
  runtime.alertState = typeof savedState.alertState === "object" && savedState.alertState !== null ? savedState.alertState : {};
  if (savedState.signalState && typeof savedState.signalState === "object" && savedState.signalState !== null) {
    runtime.signalState = { ...defaultSignalState(), ...savedState.signalState };
  }
  if (savedState.lastSuggestedOrder && typeof savedState.lastSuggestedOrder === "object" && savedState.lastSuggestedOrder !== null) {
    runtime.lastSuggestedOrder = savedState.lastSuggestedOrder;
  }
  // localeHint is intentionally not restored: the notification-language
  // hint is session-only since v1.4.0 and defaults to "zh".
  if (Array.isArray(savedState.lastAlertLog)) runtime.lastAlertLog = savedState.lastAlertLog.slice(0, ALERT_LOG_CAP);
  // plan-03 state restore: lane memory survives restarts so an
  // in-flight degradation counter (and the lane itself) persists.
  if (savedState.laneState && typeof savedState.laneState === "object") {
    runtime.laneState = {
      lane: SIGNAL_LANES.includes(savedState.laneState.lane) ? savedState.laneState.lane : null,
      pendingLane: SIGNAL_LANES.includes(savedState.laneState.pendingLane) ? savedState.laneState.pendingLane : null,
      pendingTicks: Number.isFinite(Number(savedState.laneState.pendingTicks))
        ? Math.max(0, Math.floor(Number(savedState.laneState.pendingTicks)))
        : 0,
    };
  }
  if (Array.isArray(savedState.cmbSpreadSamples)) {
    runtime.cmbSpreadSamples = cleanCmbSpreadSamples(savedState.cmbSpreadSamples, Date.now());
  }
  if (Array.isArray(savedState.premiumHistory)) {
    runtime.premiumHistory = savedState.premiumHistory
      .filter((entry) => entry && typeof entry === "object" && typeof entry.date === "string" && Number.isFinite(Number(entry.premiumPerGram)))
      .slice(-PREMIUM_HISTORY_CAP);
  }
  if (savedState.premiumDaySamples && typeof savedState.premiumDaySamples === "object" && Array.isArray(savedState.premiumDaySamples.values)) {
    runtime.premiumDaySamples = {
      date: typeof savedState.premiumDaySamples.date === "string" ? savedState.premiumDaySamples.date : "",
      values: savedState.premiumDaySamples.values.map((value) => Number(value)).filter((value) => Number.isFinite(value)).slice(-PREMIUM_DAY_SAMPLE_CAP),
    };
  }
}
