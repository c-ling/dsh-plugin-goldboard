import { createHash } from "node:crypto";
import { appendFile, mkdir, open, readdir, readFile, rename, stat, truncate, unlink } from "node:fs/promises";
import { join } from "node:path";

const EVIDENCE = new Set(["real", "synthetic", "proxy", "unknown"]);
const PARTITION_SUFFIX = ".jsonl";
const LOCK_FILE = ".append.lock";
const LOCK_STALE_MS = 30_000;
const LOCK_RETRY_MS = 5;
const LOCK_RETRIES = 2_000;

function encodePart(value) {
  return Buffer.from(value, "utf8").toString("base64url");
}

function decodePart(value) {
  return Buffer.from(value, "base64url").toString("utf8");
}

function partitionKey(instrument, tradingDay) {
  return `${instrument}\u0000${tradingDay}`;
}

function fileNameFor(instrument, tradingDay) {
  return `${encodePart(instrument)}--${encodePart(tradingDay)}${PARTITION_SUFFIX}`;
}

function partitionFromFileName(fileName) {
  if (!fileName.endsWith(PARTITION_SUFFIX)) return null;
  const stem = fileName.slice(0, -PARTITION_SUFFIX.length);
  const separator = stem.lastIndexOf("--");
  if (separator <= 0) return null;
  try {
    return {
      instrument: decodePart(stem.slice(0, separator)),
      tradingDay: decodePart(stem.slice(separator + 2)),
    };
  } catch {
    return null;
  }
}

function timestampMs(value) {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value !== "string" || value.length === 0) return null;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function compareRecords(left, right) {
  return left.timestampMs - right.timestampMs || left.eventId.localeCompare(right.eventId);
}

function cloneRecord(record) {
  const copy = { ...record };
  delete copy.timestampMs;
  return copy;
}

function validBound(value) {
  if (value === undefined || value === null) return null;
  return timestampMs(value);
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export function historicalQuoteEventId(record = {}) {
  const identity = [
    record.instrument ?? "unknown",
    record.source ?? "unknown",
    record.sourceTimestamp ?? "",
    record.receivedAt ?? "",
    record.customerAsk ?? record.customerBuy ?? record.ask ?? "",
    record.customerBid ?? record.customerSell ?? record.bid ?? "",
  ].join("\u0000");
  return createHash("sha256").update(identity).digest("hex");
}

export class HistoricalStore {
  constructor({ directory, dataSchemaVersion, tradingDayForTimestamp, now = () => new Date(), logger = null } = {}) {
    if (typeof directory !== "string" || directory.length === 0) throw new TypeError("HistoricalStore requires directory");
    if (typeof dataSchemaVersion !== "string" || dataSchemaVersion.length === 0) {
      throw new TypeError("HistoricalStore requires dataSchemaVersion");
    }
    if (typeof tradingDayForTimestamp !== "function") {
      throw new TypeError("HistoricalStore requires tradingDayForTimestamp");
    }
    if (typeof now !== "function") throw new TypeError("HistoricalStore now must be a function");

    this.directory = directory;
    this.dataSchemaVersion = dataSchemaVersion;
    this.tradingDayForTimestamp = tradingDayForTimestamp;
    this.now = now;
    this.logger = logger;
    this.partitions = new Map();
    this.eventIds = new Set();
    this.queue = Promise.resolve();
    this.initialized = false;
    this.closing = false;
    this.closed = false;
  }

  async init() {
    if (this.initialized) return this;
    if (this.closed) throw new Error("HistoricalStore is closed");
    await mkdir(this.directory, { recursive: true });
    const entries = await readdir(this.directory, { withFileTypes: true });
    const files = entries
      .filter((entry) => entry.isFile() && entry.name.endsWith(PARTITION_SUFFIX))
      .map((entry) => entry.name)
      .sort();
    for (const fileName of files) await this.loadPartition(fileName);
    this.initialized = true;
    return this;
  }

  async load() {
    return this.init();
  }

  ensurePartition(instrument, tradingDay, fileName = fileNameFor(instrument, tradingDay)) {
    const key = partitionKey(instrument, tradingDay);
    let partition = this.partitions.get(key);
    if (!partition) {
      partition = {
        instrument,
        tradingDay,
        fileName,
        records: [],
        rejected: [],
        needsLeadingNewline: false,
        corruptBackups: [],
      };
      this.partitions.set(key, partition);
    }
    return partition;
  }

  normalizeStoredRecord(raw, expected) {
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) return { ok: false, reason: "record_invalid" };
    if (raw.kind !== "quote") return { ok: false, reason: "kind_invalid" };
    if (typeof raw.eventId !== "string" || raw.eventId.length === 0) return { ok: false, reason: "event_id_invalid" };
    if (typeof raw.instrument !== "string" || raw.instrument.length === 0) return { ok: false, reason: "instrument_invalid" };
    if (raw.instrument !== expected.instrument) return { ok: false, reason: "instrument_partition_mismatch" };
    if (typeof raw.tradingDay !== "string" || raw.tradingDay !== expected.tradingDay) {
      return { ok: false, reason: "trading_day_partition_mismatch" };
    }
    if (!EVIDENCE.has(raw.evidence)) return { ok: false, reason: "evidence_invalid" };
    if (raw.dataSchemaVersion !== this.dataSchemaVersion) return { ok: false, reason: "schema_version_mismatch" };
    const time = timestampMs(raw.sourceTimestamp ?? raw.receivedAt);
    if (time === null) return { ok: false, reason: "timestamp_invalid" };
    return { ok: true, record: { ...raw, timestampMs: time } };
  }

  async loadPartition(fileName) {
    const identity = partitionFromFileName(fileName);
    if (!identity) return;
    const key = partitionKey(identity.instrument, identity.tradingDay);
    const partition = this.ensurePartition(identity.instrument, identity.tradingDay, fileName);
    const file = join(this.directory, fileName);
    const text = await readFile(file, "utf8");
    const lines = text.split("\n");
    const lastContentIndex = lines.reduce((last, line, index) => line.trim() ? index : last, -1);
    const records = [];
    const localIds = new Set();
    const rejected = [];
    let fatal = false;
    let tornTail = false;

    for (let index = 0; index < lines.length; index += 1) {
      const line = lines[index].trim();
      if (!line) continue;
      let raw;
      try {
        raw = JSON.parse(line);
      } catch {
        const isTornTail = index === lastContentIndex && !text.endsWith("\n");
        rejected.push({ line: index + 1, reason: isTornTail ? "torn_tail" : "invalid_json" });
        if (isTornTail) tornTail = true;
        else fatal = true;
        continue;
      }
      const normalized = this.normalizeStoredRecord(raw, identity);
      if (!normalized.ok) {
        rejected.push({ line: index + 1, reason: normalized.reason });
        fatal = true;
        continue;
      }
      if (localIds.has(normalized.record.eventId) || this.eventIds.has(normalized.record.eventId)) {
        rejected.push({ line: index + 1, reason: "duplicate_event_id", eventId: normalized.record.eventId });
        continue;
      }
      localIds.add(normalized.record.eventId);
      records.push(normalized.record);
    }

    partition.rejected.push(...rejected);
    if (fatal) {
      const nowValue = this.now();
      const instant = timestampMs(nowValue instanceof Date ? nowValue.toISOString() : nowValue) ?? Date.now();
      const stamp = new Date(instant).toISOString().replace(/[:.]/g, "-");
      const digest = createHash("sha256").update(text).digest("hex").slice(0, 10);
      const corruptName = `${fileName}.corrupt-${stamp}-${digest}.bak`;
      try {
        await rename(file, join(this.directory, corruptName));
        partition.corruptBackups.push(corruptName);
      } catch (error) {
        partition.corruptBackups.push(fileName);
        this.logger?.warn?.(`dsh-plugin-goldboard: history partition isolation failed: ${String(error?.message ?? error)}`);
      }
      partition.records = [];
      partition.needsLeadingNewline = false;
      this.partitions.set(key, partition);
      return;
    }

    if (tornTail) {
      const lastNewline = text.lastIndexOf("\n");
      const validPrefix = lastNewline < 0 ? "" : text.slice(0, lastNewline + 1);
      await truncate(file, Buffer.byteLength(validPrefix, "utf8"));
    }
    for (const eventId of localIds) this.eventIds.add(eventId);
    partition.records.push(...records);
    partition.records.sort(compareRecords);
    partition.needsLeadingNewline = !tornTail && text.length > 0 && !text.endsWith("\n");
    this.partitions.set(key, partition);
  }

  normalizeQuote(input) {
    if (!input || typeof input !== "object" || Array.isArray(input)) throw new TypeError("quote must be an object");
    if (typeof input.instrument !== "string" || input.instrument.length === 0) throw new TypeError("quote.instrument is required");
    const evidence = input.evidence ?? input.executionEvidence?.mode ?? "unknown";
    if (!EVIDENCE.has(evidence)) throw new TypeError("quote.evidence must be real, synthetic, proxy, or unknown");
    const time = timestampMs(input.sourceTimestamp ?? input.receivedAt);
    if (time === null) throw new TypeError("quote.sourceTimestamp or quote.receivedAt must be a valid timestamp");
    const tradingDay = this.tradingDayForTimestamp(time, input);
    if (typeof tradingDay !== "string" || tradingDay.length === 0) {
      throw new TypeError("tradingDayForTimestamp must return a non-empty string");
    }
    const ingestedAtValue = input.ingestedAt ?? this.now();
    const ingestedAtMs = timestampMs(ingestedAtValue instanceof Date ? ingestedAtValue.toISOString() : ingestedAtValue);
    if (ingestedAtMs === null) throw new TypeError("ingestedAt/now must be a valid Date or timestamp");
    const eventId = typeof input.eventId === "string" && input.eventId.length > 0
      ? input.eventId
      : historicalQuoteEventId(input);
    return {
      ...input,
      kind: "quote",
      eventId,
      instrument: input.instrument,
      tradingDay,
      evidence,
      dataSchemaVersion: this.dataSchemaVersion,
      ingestedAt: new Date(ingestedAtMs).toISOString(),
      timestampMs: time,
    };
  }

  async acquireAppendLock() {
    const lockPath = join(this.directory, LOCK_FILE);
    for (let attempt = 0; attempt < LOCK_RETRIES; attempt += 1) {
      try {
        const handle = await open(lockPath, "wx");
        return async () => {
          await handle.close();
          await unlink(lockPath).catch((error) => {
            if (error?.code !== "ENOENT") throw error;
          });
        };
      } catch (error) {
        if (error?.code !== "EEXIST") throw error;
        try {
          const info = await stat(lockPath);
          if (Date.now() - info.mtimeMs > LOCK_STALE_MS) await unlink(lockPath);
        } catch (statError) {
          if (statError?.code !== "ENOENT") throw statError;
        }
        await sleep(LOCK_RETRY_MS);
      }
    }
    throw new Error("HistoricalStore append lock timeout");
  }

  async partitionContainsEvent(file, eventId, identity) {
    let text;
    try {
      text = await readFile(file, "utf8");
    } catch (error) {
      if (error?.code === "ENOENT") return { found: false, needsLeadingNewline: false };
      throw error;
    }
    for (const line of text.split("\n")) {
      if (!line.trim()) continue;
      try {
        const raw = JSON.parse(line);
        if (raw.eventId === eventId) {
          const normalized = this.normalizeStoredRecord(raw, identity);
          return {
            found: true,
            record: normalized.ok ? normalized.record : null,
            needsLeadingNewline: !text.endsWith("\n"),
          };
        }
      } catch {
        // A previously accepted torn tail is separated before the next append.
      }
    }
    return { found: false, needsLeadingNewline: text.length > 0 && !text.endsWith("\n") };
  }

  appendQuote(input) {
    if (this.closed || this.closing) return Promise.reject(new Error("HistoricalStore is closed"));
    const operation = async () => {
      if (!this.initialized) await this.init();
      const record = this.normalizeQuote(input);
      if (this.eventIds.has(record.eventId)) return { appended: false, duplicate: true, eventId: record.eventId };
      const partition = this.ensurePartition(record.instrument, record.tradingDay);
      const file = join(this.directory, partition.fileName);
      const release = await this.acquireAppendLock();
      try {
        const disk = await this.partitionContainsEvent(file, record.eventId, {
          instrument: partition.instrument,
          tradingDay: partition.tradingDay,
        });
        if (disk.found) {
          this.eventIds.add(record.eventId);
          if (disk.record && !partition.records.some((entry) => entry.eventId === record.eventId)) {
            partition.records.push(disk.record);
            partition.records.sort(compareRecords);
          }
          return { appended: false, duplicate: true, eventId: record.eventId };
        }
        const prefix = disk.needsLeadingNewline || partition.needsLeadingNewline ? "\n" : "";
        await appendFile(file, `${prefix}${JSON.stringify(cloneRecord(record))}\n`, "utf8");
      } finally {
        await release();
      }
      partition.needsLeadingNewline = false;
      this.eventIds.add(record.eventId);
      partition.records.push(record);
      partition.records.sort(compareRecords);
      return { appended: true, duplicate: false, eventId: record.eventId, tradingDay: record.tradingDay };
    };
    const result = this.queue.then(operation, operation);
    this.queue = result.then(() => undefined, () => undefined);
    return result;
  }

  async query({ instrument, from, to, asOf, evidence } = {}) {
    if (!this.initialized) await this.init();
    if (typeof instrument !== "string" || instrument.length === 0) throw new TypeError("query.instrument is required");
    const fromMs = validBound(from);
    const toMs = validBound(to);
    const asOfMs = validBound(asOf);
    if (from !== undefined && from !== null && fromMs === null) throw new TypeError("query.from is invalid");
    if (to !== undefined && to !== null && toMs === null) throw new TypeError("query.to is invalid");
    if (asOf !== undefined && asOf !== null && asOfMs === null) throw new TypeError("query.asOf is invalid");
    const evidenceSet = evidence === undefined || evidence === null
      ? null
      : new Set(Array.isArray(evidence) ? evidence : [evidence]);
    if (evidenceSet && [...evidenceSet].some((value) => !EVIDENCE.has(value))) {
      throw new TypeError("query.evidence contains an invalid identity");
    }

    const records = [];
    for (const partition of this.partitions.values()) {
      if (partition.instrument !== instrument) continue;
      for (const record of partition.records) {
        if (fromMs !== null && record.timestampMs < fromMs) continue;
        if (toMs !== null && record.timestampMs > toMs) continue;
        const ingestedAtMs = timestampMs(record.ingestedAt);
        if (asOfMs !== null && (record.timestampMs > asOfMs || ingestedAtMs === null || ingestedAtMs > asOfMs)) continue;
        if (evidenceSet && !evidenceSet.has(record.evidence)) continue;
        records.push(record);
      }
    }
    records.sort(compareRecords);
    return records.map(cloneRecord);
  }

  async getManifest({ instrument, tradingDay } = {}) {
    if (!this.initialized) await this.init();
    const manifests = [];
    for (const partition of this.partitions.values()) {
      if (instrument && partition.instrument !== instrument) continue;
      if (tradingDay && partition.tradingDay !== tradingDay) continue;
      const evidence = { real: 0, synthetic: 0, proxy: 0, unknown: 0 };
      for (const record of partition.records) evidence[record.evidence] += 1;
      manifests.push({
        instrument: partition.instrument,
        tradingDay: partition.tradingDay,
        dataSchemaVersion: this.dataSchemaVersion,
        fileName: partition.fileName,
        records: partition.records.length,
        rejected: partition.rejected.length,
        rejectedDetails: partition.rejected.map((entry) => ({ ...entry })),
        quarantined: partition.corruptBackups.length > 0,
        corruptBackups: partition.corruptBackups.slice(),
        firstTimestamp: partition.records.length > 0 ? new Date(partition.records[0].timestampMs).toISOString() : null,
        lastTimestamp: partition.records.length > 0 ? new Date(partition.records[partition.records.length - 1].timestampMs).toISOString() : null,
        contentSha256: createHash("sha256")
          .update(partition.records.map((record) => JSON.stringify(cloneRecord(record))).join("\n"))
          .digest("hex"),
        evidence,
      });
    }
    manifests.sort((left, right) => left.instrument.localeCompare(right.instrument) || left.tradingDay.localeCompare(right.tradingDay));
    if (instrument && tradingDay) return manifests[0] ?? null;
    return manifests;
  }

  async getStatus({ instrument, gapThresholdMs = 90_000 } = {}) {
    if (!this.initialized) await this.init();
    const records = [];
    let rejected = 0;
    let quarantinedPartitions = 0;
    for (const partition of this.partitions.values()) {
      if (instrument && partition.instrument !== instrument) continue;
      records.push(...partition.records);
      rejected += partition.rejected.length;
      if (partition.corruptBackups.length > 0) quarantinedPartitions += 1;
    }
    records.sort(compareRecords);
    const evidence = { real: 0, synthetic: 0, proxy: 0, unknown: 0 };
    for (const record of records) evidence[record.evidence] += 1;
    const gaps = [];
    for (let index = 1; index < records.length; index += 1) {
      const previous = records[index - 1];
      const current = records[index];
      const gapMs = current.timestampMs - previous.timestampMs;
      if (current.tradingDay === previous.tradingDay && gapMs > gapThresholdMs) {
        gaps.push({
          from: new Date(previous.timestampMs).toISOString(),
          to: new Date(current.timestampMs).toISOString(),
          minutes: Math.round(gapMs / 60_000 * 100) / 100,
        });
      }
    }
    const total = records.length;
    const ratio = (count) => total === 0 ? null : Math.round(count / total * 1_000_000) / 1_000_000;
    return {
      dataSchemaVersion: this.dataSchemaVersion,
      instrument: instrument ?? null,
      records: total,
      rejected,
      quarantinedPartitions,
      partitions: (await this.getManifest({ instrument })).length,
      firstValidAt: total > 0 ? new Date(records[0].timestampMs).toISOString() : null,
      lastValidAt: total > 0 ? new Date(records[total - 1].timestampMs).toISOString() : null,
      evidence,
      realRatio: ratio(evidence.real),
      syntheticRatio: ratio(evidence.synthetic),
      proxyRatio: ratio(evidence.proxy),
      unknownRatio: ratio(evidence.unknown),
      gaps: gaps.slice(-200),
    };
  }

  drain() {
    return this.queue;
  }

  async close() {
    if (this.closed) return;
    this.closing = true;
    await this.drain();
    this.closed = true;
  }
}
