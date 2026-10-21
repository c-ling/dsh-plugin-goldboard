import { randomBytes } from "node:crypto";
import { mkdir, readFile, readdir, rename, unlink, writeFile } from "node:fs/promises";
import { basename, join } from "node:path";

import { validateReplayReport } from "./replay-report.js";

export const REPLAY_REPORT_STORE_VERSION = 1;
export const REPLAY_REPORT_INDEX_FILE = "replay-report-index-v1.json";
export const REPLAY_REPORT_DETAIL_PREFIX = "replay-report-v6-";
export const REPLAY_REPORT_STORE_DEFAULT_LIMIT = 50;

function safeId(value) {
  if (typeof value !== "string" || !/^[A-Za-z0-9._-]{1,200}$/.test(value)) throw new TypeError("reportId must contain only letters, numbers, dot, underscore, or dash");
  return value;
}

function detailFileName(reportId) {
  return `${REPLAY_REPORT_DETAIL_PREFIX}${Buffer.from(reportId, "utf8").toString("base64url")}.json`;
}

function timeValue(value) {
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

function sortNewest(left, right) {
  return timeValue(right.generatedAt) - timeValue(left.generatedAt) || String(right.reportId).localeCompare(String(left.reportId));
}

function clone(value) {
  return value === undefined ? undefined : structuredClone(value);
}

function summaryFromEnvelope(envelope, fileName) {
  const report = envelope?.report ?? envelope;
  return {
    reportId: report.reportId,
    generatedAt: report.generatedAt ?? null,
    asOf: report.asOf ?? null,
    version: report.version ?? report.reportSchemaVersion ?? null,
    reportSchemaVersion: report.reportSchemaVersion ?? report.version ?? null,
    inputFingerprint: report.inputFingerprint ?? null,
    reportFingerprint: report.reportFingerprint ?? null,
    evidenceStatus: report.evidenceStatus ?? "exploratory",
    validationEligible: report.validationGate?.eligible === true,
    strategyId: report.strategyId ?? report.provenance?.strategyId ?? null,
    strategyVersion: report.strategyVersion ?? report.provenance?.strategyVersion ?? null,
    parameterFingerprint: report.provenance?.parameterFingerprint ?? null,
    lane: report.dataset?.lane ?? report.lane ?? null,
    datasetId: report.dataset?.datasetId ?? null,
    executionVersion: report.executionVersion ?? report.provenance?.executionVersion ?? null,
    fillPolicy: report.fillPolicy ?? report.simulation?.policy?.fillPolicy ?? null,
    ambiguityPolicy: report.ambiguityPolicy ?? report.simulation?.policy?.ambiguityPolicy ?? null,
    metrics: {
      netPnlCny: report.metrics?.netPnlCny ?? report.overall?.totalNetCny ?? null,
      totalReturn: report.metrics?.totalReturn ?? null,
      maxDrawdownPct: report.metrics?.maxDrawdownPct ?? null,
      sharpe: report.metrics?.sharpe ?? null,
    },
    detailFile: fileName,
  };
}

function withoutDetail(report) {
  if (!report || typeof report !== "object") return report;
  const summary = { ...report };
  delete summary.detail;
  delete summary.events;
  delete summary.orders;
  delete summary.fills;
  delete summary.ledger;
  delete summary.unexecuted;
  delete summary.unexecutedSignals;
  return summary;
}

async function readJson(file, logger = null) {
  try {
    return JSON.parse(await readFile(file, "utf8"));
  } catch (error) {
    logger?.warn?.(`dsh-plugin-goldboard: replay report read ignored: ${String(error?.message ?? error)}`);
    return null;
  }
}

function validatedEnvelope(value, logger = null) {
  if (!value || typeof value !== "object") return null;
  try {
    const report = validateReplayReport(value.report ?? value);
    return value.report ? { ...value, report } : { report };
  } catch (error) {
    logger?.warn?.(`dsh-plugin-goldboard: invalid replay report ignored: ${String(error?.message ?? error)}`);
    return null;
  }
}

async function writeAtomic(file, value) {
  const temporary = `${file}.tmp-${process.pid}-${randomBytes(6).toString("hex")}`;
  try {
    await writeFile(temporary, `${JSON.stringify(value)}\n`, { encoding: "utf8", flag: "wx" });
    await rename(temporary, file);
  } catch (error) {
    await unlink(temporary).catch(() => {});
    throw error;
  }
}

/**
 * Versioned bounded report registry. `save` accepts either a report or an envelope
 * `{ report, events, orders, fills, ledger, unexecuted }`. Existing detail files
 * are immutable: saving an existing reportId returns its previously stored bytes.
 */
export class ReplayReportStore {
  constructor({ directory, limit = REPLAY_REPORT_STORE_DEFAULT_LIMIT, legacyLatestFile = null, logger = null } = {}) {
    if (typeof directory !== "string" || directory.length === 0) throw new TypeError("ReplayReportStore requires directory");
    this.directory = directory;
    this.limit = Math.max(1, Math.floor(Number(limit) || REPLAY_REPORT_STORE_DEFAULT_LIMIT));
    this.legacyLatestFile = typeof legacyLatestFile === "string" && legacyLatestFile.length ? legacyLatestFile : null;
    this.logger = logger;
    this.indexFile = join(directory, REPLAY_REPORT_INDEX_FILE);
    this.queue = Promise.resolve();
    this.indexVerified = false;
  }

  async recoverIndex() {
    let names;
    try {
      names = await readdir(this.directory);
    } catch {
      return { version: REPLAY_REPORT_STORE_VERSION, reports: [] };
    }
    const reports = [];
    for (const fileName of names.filter((name) => name.startsWith(REPLAY_REPORT_DETAIL_PREFIX) && name.endsWith(".json")).sort()) {
      const envelope = validatedEnvelope(await readJson(join(this.directory, fileName), this.logger), this.logger);
      const report = envelope?.report;
      if (!report) continue;
      try { safeId(report.reportId); } catch { continue; }
      reports.push(summaryFromEnvelope(envelope, fileName));
    }
    const sorted = reports.sort(sortNewest);
    const recovered = sorted.slice(0, this.limit);
    try {
      await writeAtomic(this.indexFile, { version: REPLAY_REPORT_STORE_VERSION, reports: recovered });
      const retained = new Set(recovered.map((entry) => entry.detailFile));
      await Promise.allSettled(names.filter((name) => name.startsWith(REPLAY_REPORT_DETAIL_PREFIX)
        && name.endsWith(".json") && !retained.has(name)).map((name) => unlink(join(this.directory, name))));
    } catch (error) {
      this.logger?.warn?.(`dsh-plugin-goldboard: replay report index repair failed: ${String(error?.message ?? error)}`);
    }
    this.indexVerified = true;
    return { version: REPLAY_REPORT_STORE_VERSION, reports: recovered };
  }

  async readIndex() {
    if (!this.indexVerified) return this.recoverIndex();
    const value = await readJson(this.indexFile, this.logger);
    if (!value || value.version !== REPLAY_REPORT_STORE_VERSION || !Array.isArray(value.reports)) {
      return this.recoverIndex();
    }
    const reports = value.reports
      .filter((entry) => entry && typeof entry === "object" && typeof entry.reportId === "string" && typeof entry.detailFile === "string")
      .filter((entry) => basename(entry.detailFile) === entry.detailFile)
      .sort(sortNewest);
    return { version: REPLAY_REPORT_STORE_VERSION, reports };
  }

  async readEntry(entry) {
    const envelope = validatedEnvelope(await readJson(join(this.directory, entry.detailFile), this.logger), this.logger);
    if (!envelope || envelope.report.reportId !== entry.reportId) return null;
    return envelope;
  }

  async legacy(detail = false) {
    if (!this.legacyLatestFile) return null;
    const envelope = await readJson(this.legacyLatestFile, this.logger);
    if (!envelope || typeof envelope !== "object") return null;
    const report = envelope.report ?? envelope;
    if (!report || typeof report !== "object") return null;
    let safeReport;
    if (report.version === 6) {
      const validated = validatedEnvelope({ report }, this.logger);
      if (!validated) return null;
      safeReport = validated.report;
    } else if (report.version === 4 || report.version === 5) {
      safeReport = clone(report);
      delete safeReport.validationGate;
      if (safeReport.evidenceStatus === "validated") safeReport.evidenceStatus = "exploratory";
    } else {
      return null;
    }
    const safeEnvelope = { ...(envelope.report ? envelope : {}), report: safeReport };
    if (detail) return clone(safeEnvelope);
    return { report: clone(withoutDetail(safeReport)), legacy: true };
  }

  async list({ limit = this.limit } = {}) {
    await mkdir(this.directory, { recursive: true });
    const index = await this.readIndex();
    const cap = Math.max(0, Math.min(this.limit, Math.floor(Number(limit) || this.limit)));
    const valid = [];
    for (const entry of index.reports) {
      if (valid.length >= cap) break;
      if (await this.readEntry(entry)) valid.push(clone(entry));
    }
    if (!valid.length) {
      const legacy = await this.legacy(false);
      if (legacy?.report) return [summaryFromEnvelope(legacy.report, basename(this.legacyLatestFile))];
    }
    return valid;
  }

  async get(reportId, { detail = false } = {}) {
    safeId(reportId);
    await mkdir(this.directory, { recursive: true });
    const index = await this.readIndex();
    const entry = index.reports.find((candidate) => candidate.reportId === reportId)
      ?? { reportId, detailFile: detailFileName(reportId) };
    const envelope = await this.readEntry(entry);
    if (!envelope) {
      const legacy = await this.legacy(detail);
      return legacy?.report?.reportId === reportId ? legacy : null;
    }
    if (detail) return clone(envelope);
    return { report: clone(withoutDetail(envelope.report)) };
  }

  async latest({ detail = false } = {}) {
    await mkdir(this.directory, { recursive: true });
    const index = await this.readIndex();
    for (const entry of index.reports) {
      const envelope = await this.readEntry(entry);
      if (!envelope) continue;
      return detail ? clone(envelope) : { report: clone(withoutDetail(envelope.report)) };
    }
    return this.legacy(detail);
  }

  save(value) {
    const operation = async () => {
      await mkdir(this.directory, { recursive: true });
      const source = value?.report && typeof value.report === "object" ? value : { report: value };
      const incoming = validatedEnvelope(source);
      if (!incoming) throw new TypeError("save requires a valid replay report or report envelope");
      const reportId = safeId(incoming.report.reportId);
      const fileName = detailFileName(reportId);
      const file = join(this.directory, fileName);
      const index = await this.readIndex();
      const existing = index.reports.find((entry) => entry.reportId === reportId);
      if (existing) {
        const stored = await this.readEntry(existing);
        if (stored) return clone(stored);
      }
      const unexecuted = clone(incoming.unexecuted ?? incoming.unexecutedSignals ?? incoming.report.detail?.unexecuted ?? []);
      const envelope = {
        version: REPLAY_REPORT_STORE_VERSION,
        report: clone(incoming.report),
        events: clone(incoming.events ?? incoming.report.detail?.events ?? []),
        trades: clone(incoming.trades ?? incoming.report.detail?.trades ?? []),
        orders: clone(incoming.orders ?? incoming.report.detail?.orders ?? []),
        fills: clone(incoming.fills ?? incoming.report.detail?.fills ?? []),
        pendingOrders: clone(incoming.pendingOrders ?? incoming.report.detail?.pendingOrders ?? []),
        ledger: clone(incoming.ledger ?? incoming.report.detail?.ledger ?? []),
        unexecuted,
        unexecutedSignals: clone(unexecuted),
      };
      // wx prevents accidental rewriting of immutable historical report bytes.
      try {
        await writeFile(file, `${JSON.stringify(envelope)}\n`, { encoding: "utf8", flag: "wx" });
      } catch (error) {
        if (error?.code !== "EEXIST") throw error;
        const stored = validatedEnvelope(await readJson(file, this.logger), this.logger);
        if (stored) {
          const repairedEntry = summaryFromEnvelope(stored, fileName);
          const repairedReports = [repairedEntry, ...index.reports.filter((candidate) => candidate.reportId !== reportId)]
            .sort(sortNewest)
            .slice(0, this.limit);
          await writeAtomic(this.indexFile, { version: REPLAY_REPORT_STORE_VERSION, reports: repairedReports });
          const retainedFiles = new Set(repairedReports.map((candidate) => candidate.detailFile));
          await Promise.allSettled(index.reports.filter((candidate) => !retainedFiles.has(candidate.detailFile))
            .map((candidate) => unlink(join(this.directory, candidate.detailFile))));
          return clone(stored);
        }
        throw new Error(`Replay report detail already exists but is corrupt: ${reportId}`);
      }
      const entry = summaryFromEnvelope(envelope, fileName);
      const reports = [entry, ...index.reports.filter((candidate) => candidate.reportId !== reportId)]
        .sort(sortNewest)
        .slice(0, this.limit);
      await writeAtomic(this.indexFile, { version: REPLAY_REPORT_STORE_VERSION, reports });
      const retainedFiles = new Set(reports.map((candidate) => candidate.detailFile));
      await Promise.allSettled(index.reports.filter((candidate) => !retainedFiles.has(candidate.detailFile))
        .map((candidate) => unlink(join(this.directory, candidate.detailFile))));
      this.indexVerified = true;
      return clone(envelope);
    };
    const result = this.queue.then(operation, operation);
    this.queue = result.then(() => undefined, (error) => {
      this.logger?.warn?.(`dsh-plugin-goldboard: replay report save failed: ${String(error?.message ?? error)}`);
    });
    return result;
  }

  drain() {
    return this.queue;
  }
}

export function createReplayReportStore(options) {
  return new ReplayReportStore(options);
}
