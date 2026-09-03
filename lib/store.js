/**
 * Persistence primitives: fault-tolerant JSON reads, atomic queued writes,
 * the partitioned-dirty state persister and the api-log store.
 *
 * plan-05: extracted from the old monolithic lib/index.js. Every instance is
 * created per plugin apply() — no module-level mutable state.
 */

import { createHash } from "node:crypto";
import { constants as fsConstants } from "node:fs";
import { appendFile, copyFile, open, readFile, rename, stat, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

import { MARKET_DATA_SCHEMA_VERSION, normalizeBarRecord, normalizeQuoteRecord } from "./market-quality.js";

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

export const STATE_SCHEMA_VERSION = 2;
export const STATE_MIGRATION_VERSION = "goldboard-state-v2";

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

function migrationBackupPath(file) {
  return `${file}.v1.backup`;
}

function migrationManifestPath(file) {
  return `${file}.migration-v2.json`;
}

function timestampForFile(now) {
  const value = typeof now === "function" ? now() : new Date();
  return new Date(value).toISOString().replace(/[:.]/g, "-");
}

async function isolateInvalidState(file, text, reason, now, logger) {
  const stamp = timestampForFile(now);
  const digest = sha256(text).slice(0, 10);
  const corruptPath = `${file}.corrupt-${stamp}-${digest}.bak`;
  try {
    await rename(file, corruptPath);
  } catch (renameError) {
    logger?.warn?.(`dsh-plugin-goldboard: corrupt state isolation failed: ${String(renameError?.message ?? renameError)}`);
  }
  logger?.warn?.(`dsh-plugin-goldboard: invalid state isolated at ${corruptPath}: ${reason}`);
  return corruptPath;
}

async function preserveMigrationBackup(file, text, sourceVersion) {
  const sourceHash = sha256(text);
  let backupPath = migrationBackupPath(file);
  try {
    await copyFile(file, backupPath, fsConstants.COPYFILE_EXCL);
    return { backupPath, backupSha256: sourceHash };
  } catch (error) {
    if (error?.code !== "EEXIST") throw error;
  }
  const existing = await readFile(backupPath);
  if (sha256(existing) === sourceHash) return { backupPath, backupSha256: sourceHash };

  const version = Number.isFinite(Number(sourceVersion)) ? Number(sourceVersion) : 1;
  backupPath = `${file}.v${version}-${sourceHash.slice(0, 12)}.backup`;
  try {
    await copyFile(file, backupPath, fsConstants.COPYFILE_EXCL);
  } catch (error) {
    if (error?.code !== "EEXIST") throw error;
    const hashedExisting = await readFile(backupPath);
    if (sha256(hashedExisting) !== sourceHash) throw new Error(`state backup hash mismatch: ${backupPath}`);
  }
  return { backupPath, backupSha256: sourceHash };
}

const STATE_BAR_METADATA = Object.freeze({
  AU9999: Object.freeze({ instrument: "Au99.99", market: "sge", currency: "CNY", unit: "gram" }),
  XAU: Object.freeze({ instrument: "XAU/USD", market: "spot", currency: "USD", unit: "troy_ounce" }),
  GCF: Object.freeze({ instrument: "GC=F", market: "futures", currency: "USD", unit: "troy_ounce" }),
  CMB: Object.freeze({ instrument: "CMB_ACCUMULATED_GOLD", market: "bank", currency: "CNY", unit: "gram" }),
});

/** Normalize recognized hot-cache records while retaining all unrelated runtime fields. */
export function migratePersistedState(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const quotes = {};
  for (const [key, quote] of Object.entries(value.quotes ?? {})) {
    if (!quote || typeof quote !== "object" || !(Number(quote.price) > 0)) continue;
    const receivedAt = Number.isFinite(Number(quote.updatedAt))
      ? Number(quote.updatedAt)
      : Number.isFinite(Date.parse(quote.receivedAt ?? ""))
        ? Date.parse(quote.receivedAt)
        : 0;
    quotes[key] = receivedAt > 0 && STATE_BAR_METADATA[key]
      ? normalizeQuoteRecord(key, quote, receivedAt, receivedAt)
      : quote;
  }
  const bars = {};
  for (const [lane, intervals] of Object.entries(value.bars ?? {})) {
    const metadata = STATE_BAR_METADATA[lane] ?? {};
    bars[lane] = {};
    for (const [interval, records] of Object.entries(intervals ?? {})) {
      bars[lane][interval] = (Array.isArray(records) ? records : [])
        .map((bar) => {
          const completeCmbSides = lane === "CMB" && bar?.executionSideComplete === true
            && ["askO", "askH", "askL", "askC", "bidO", "bidH", "bidL", "bidC"]
              .every((key) => Number(bar?.[key]) > 0);
          const legacyCmbProxy = lane === "CMB" && !completeCmbSides;
          return normalizeBarRecord(legacyCmbProxy ? {
            ...bar,
            synthetic: true,
            quality: "proxy",
            executionSideComplete: false,
            executionEvidence: {
              mode: "proxy",
              askSource: bar?.source ?? "legacy-state",
              bidSource: null,
            },
          } : bar, metadata);
        })
        .filter(Boolean);
    }
  }
  return {
    ...value,
    quotes,
    bars,
    stateSchemaVersion: STATE_SCHEMA_VERSION,
    dataSchemaVersion: MARKET_DATA_SCHEMA_VERSION,
  };
}

/**
 * Read state.json with observable corruption handling and an atomic v1 -> v2
 * migration. The original bytes are copied once before the migrated document
 * is written, so rollback never depends on reconstructed data.
 */
export async function loadStateWithMigration({ file, writeQueue = makeWriteQueue(), logger = null, now = () => new Date() } = {}) {
  let text;
  try {
    text = await readFile(file, "utf8");
  } catch (error) {
    if (error?.code === "ENOENT") return { state: null, migrated: false, backupPath: null, corruptPath: null };
    logger?.warn?.(`dsh-plugin-goldboard: state read failed: ${String(error?.message ?? error)}`);
    return { state: null, migrated: false, backupPath: null, corruptPath: null };
  }

  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch (error) {
    const corruptPath = await isolateInvalidState(file, text, String(error?.message ?? error), now, logger);
    return { state: null, migrated: false, backupPath: null, corruptPath };
  }

  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    const corruptPath = await isolateInvalidState(file, text, "state root is not an object", now, logger);
    return { state: null, migrated: false, backupPath: null, corruptPath };
  }
  if (Number(parsed.stateSchemaVersion) === STATE_SCHEMA_VERSION) {
    return { state: parsed, migrated: false, backupPath: null, corruptPath: null };
  }

  const sourceVersion = parsed.stateSchemaVersion ?? 1;
  const { backupPath, backupSha256 } = await preserveMigrationBackup(file, text, sourceVersion);
  const migrated = migratePersistedState(parsed);
  const startedAt = new Date(now()).toISOString();
  await writeJsonAtomic(file, migrated, writeQueue);
  const completedAt = new Date(now()).toISOString();
  const manifest = {
    migrationVersion: STATE_MIGRATION_VERSION,
    sourcePath: file,
    backupPath,
    sourceSha256: sha256(text),
    backupSha256,
    targetSha256: sha256(JSON.stringify(migrated, null, 2)),
    sourceStateSchemaVersion: sourceVersion,
    targetStateSchemaVersion: STATE_SCHEMA_VERSION,
    dataSchemaVersion: MARKET_DATA_SCHEMA_VERSION,
    startedAt,
    completedAt,
    rollbackAvailable: true,
  };
  await writeJsonAtomic(migrationManifestPath(file), manifest, writeQueue);
  logger?.info?.(`dsh-plugin-goldboard: state migrated to schema ${STATE_SCHEMA_VERSION}; backup ${backupPath}`);
  return { state: migrated, migrated: true, backupPath, corruptPath: null, manifest };
}

/** Restore the exact backup recorded by the latest migration manifest. */
export async function rollbackStateMigration({ file, backupPath = null, writeQueue = makeWriteQueue() } = {}) {
  let selectedBackup = backupPath;
  if (!selectedBackup) {
    const manifest = await readJson(migrationManifestPath(file), null);
    selectedBackup = manifest?.backupPath ?? migrationBackupPath(file);
  }
  const source = await readFile(selectedBackup);
  return writeQueue(async () => {
    const tmp = `${file}.rollback.tmp`;
    await writeFile(tmp, source);
    await rename(tmp, file);
    return { restored: true, file, backupPath: selectedBackup, sha256: sha256(source) };
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
  // v1.9.0 fix: serializeState persists runtime.quotes but restore never folded
  // them back — every host restart blanked the board to "—" until EACH source
  // refetched successfully (post-restart rate-limit bursts stretched that to
  // minutes). Restore the last known good quote per lane so prices render
  // immediately; staleness flags display exactly as for a live tick.
  if (savedState.quotes && typeof savedState.quotes === "object") {
    const quotes = { AU9999: null, XAU: null, GCF: null, USDCNY: null, CMB: null };
    for (const key of Object.keys(quotes)) {
      const quote = savedState.quotes[key];
      if (!quote || typeof quote !== "object") continue;
      // Drop error markers written by setQuoteError (price 0) so a failed
      // source at shutdown does not resurrect as a zero price on boot.
      if (!(Number(quote.price) > 0)) continue;
      const receivedAt = Number.isFinite(Number(quote.updatedAt))
        ? Number(quote.updatedAt)
        : Number.isFinite(Date.parse(quote.receivedAt ?? ""))
          ? Date.parse(quote.receivedAt)
          : Date.now();
      quotes[key] = normalizeQuoteRecord(key, quote, receivedAt, receivedAt);
    }
    runtime.quotes = quotes;
  }
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
