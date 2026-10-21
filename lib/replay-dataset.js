import { createHash } from "node:crypto";

export const REPLAY_DATASET_VERSION = "goldboard-replay-dataset-v1";
export const REPLAY_DATASET_INSTRUMENT = "CMB_ACCUMULATED_GOLD";
export const REPLAY_DATASET_INTERVALS = Object.freeze([5, 60]);
export const REPLAY_DATASET_EVIDENCE = Object.freeze(["real", "synthetic", "proxy", "unknown"]);

const MINUTE_MS = 60_000;

function instantMs(value) {
  if (value instanceof Date) return Number.isFinite(value.getTime()) ? value.getTime() : null;
  if (typeof value === "number" && Number.isFinite(value)) {
    const normalized = value > 0 && value < 100_000_000_000 ? value * 1000 : value;
    return Number.isFinite(new Date(normalized).getTime()) ? normalized : null;
  }
  if (typeof value === "string" && value.trim() !== "") {
    const parsed = Date.parse(value);
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}

function finitePositive(value) {
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? number : null;
}

function canonicalize(value) {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (!value || typeof value !== "object") return value;
  const out = {};
  for (const key of Object.keys(value).sort()) {
    if (value[key] !== undefined) out[key] = canonicalize(value[key]);
  }
  return out;
}

export function stableReplayFingerprint(value) {
  return createHash("sha256").update(JSON.stringify(canonicalize(value))).digest("hex");
}

function normalizeEvidence(value) {
  const candidate = typeof value === "string" ? value : value?.mode;
  return REPLAY_DATASET_EVIDENCE.includes(candidate) ? candidate : "unknown";
}

function sourceTime(record) {
  return instantMs(record?.sourceTimestamp ?? record?.timestamp ?? record?.t);
}

function normalizedQuote(record, index) {
  if (!record || typeof record !== "object" || Array.isArray(record)) return null;
  const sourceTimestampMs = sourceTime(record);
  const ingestedAtMs = instantMs(record.ingestedAt);
  if (sourceTimestampMs === null || ingestedAtMs === null) return null;
  const ask = finitePositive(record.customerAsk ?? record.customerBuy ?? record.buyPrice ?? record.ask);
  const bid = finitePositive(record.customerBid ?? record.customerSell ?? record.sellPrice ?? record.bid);
  if (ask === null && bid === null) return null;
  return {
    sourceTimestampMs,
    ingestedAtMs,
    eventId: typeof record.eventId === "string" ? record.eventId : `record-${index}`,
    source: typeof record.source === "string" && record.source ? record.source : "unknown",
    dataSchemaVersion: typeof record.dataSchemaVersion === "string" ? record.dataSchemaVersion : null,
    evidence: normalizeEvidence(record.evidence ?? record.executionEvidence),
    ask,
    bid,
  };
}

function evidenceCounts(items) {
  const counts = { real: 0, synthetic: 0, proxy: 0, unknown: 0 };
  for (const item of items) counts[normalizeEvidence(item.evidence)] += 1;
  return counts;
}

function evidenceMode(items) {
  const modes = new Set(items.map((item) => normalizeEvidence(item.evidence)));
  if (modes.size === 1) return [...modes][0];
  if (modes.has("unknown")) return "unknown";
  if (modes.has("proxy")) return "proxy";
  if (modes.has("synthetic")) return "synthetic";
  return "real";
}

function sideOhlc(items, side) {
  const values = items.map((item) => item[side]).filter((value) => value !== null);
  if (values.length === 0) return null;
  return {
    o: values[0],
    h: Math.max(...values),
    l: Math.min(...values),
    c: values[values.length - 1],
  };
}

function aggregateQuotes(records, intervalMinutes, asOfMs, identity) {
  const spanMs = intervalMinutes * MINUTE_MS;
  const buckets = new Map();
  for (const record of records) {
    const bucketStart = Math.floor(record.sourceTimestampMs / spanMs) * spanMs;
    if (!buckets.has(bucketStart)) buckets.set(bucketStart, []);
    buckets.get(bucketStart).push(record);
  }

  return [...buckets.entries()].sort((left, right) => left[0] - right[0]).map(([t, items]) => {
    items.sort((left, right) => left.sourceTimestampMs - right.sourceTimestampMs || left.eventId.localeCompare(right.eventId));
    const expectedSamples = intervalMinutes;
    const observedMinutes = new Set(items.map((item) => Math.floor(item.sourceTimestampMs / MINUTE_MS) * MINUTE_MS));
    const missingBuckets = [];
    for (let offset = 0; offset < intervalMinutes; offset += 1) {
      const minute = t + offset * MINUTE_MS;
      if (!observedMinutes.has(minute)) missingBuckets.push(new Date(minute).toISOString());
    }
    const ask = sideOhlc(items, "ask");
    const bid = sideOhlc(items, "bid");
    const bucketClosed = t + spanMs <= asOfMs;
    const partial = !bucketClosed || missingBuckets.length > 0;
    const evidence = evidenceMode(items);
    const sources = [...new Set(items.map((item) => item.source))].sort();
    const bar = {
      t,
      intervalMinutes,
      instrument: identity.instrument,
      market: identity.market,
      currency: identity.currency,
      unit: identity.unit,
      source: sources.length === 1 ? sources[0] : "mixed",
      sources,
      sourceTimestamp: new Date(items.at(-1).sourceTimestampMs).toISOString(),
      ingestedAt: new Date(Math.max(...items.map((item) => item.ingestedAtMs))).toISOString(),
      evidence,
      evidenceCounts: evidenceCounts(items),
      sampleCount: observedMinutes.size,
      expectedSamples,
      missingBuckets,
      partial,
      complete: !partial,
      executionSideComplete: ask !== null && bid !== null && items.every((item) => item.ask !== null && item.bid !== null),
      executionEvidence: {
        mode: evidence,
        askSource: ask ? (sources.length === 1 ? sources[0] : "mixed") : null,
        bidSource: bid ? (sources.length === 1 ? sources[0] : "mixed") : null,
      },
      customerAsk: ask?.c ?? null,
      customerBid: bid?.c ?? null,
    };
    if (ask) Object.assign(bar, { o: ask.o, h: ask.h, l: ask.l, c: ask.c, askO: ask.o, askH: ask.h, askL: ask.l, askC: ask.c });
    else if (bid) Object.assign(bar, { o: bid.o, h: bid.h, l: bid.l, c: bid.c });
    if (bid) Object.assign(bar, { bidO: bid.o, bidH: bid.h, bidL: bid.l, bidC: bid.c });
    return bar;
  });
}

function sessionSummary(bars, tradingDayForTimestamp, expectedTimestampsForTradingDay) {
  const sessions = new Map();
  for (const bar of bars) {
    const day = typeof tradingDayForTimestamp === "function"
      ? tradingDayForTimestamp(bar.t)
      : new Date(bar.t).toISOString().slice(0, 10);
    const current = sessions.get(day) ?? {
      tradingDay: day,
      bars: 0,
      completeBars: 0,
      partialBars: 0,
      executionCompleteBars: 0,
      executionIncompleteBars: 0,
      timestamps: [],
    };
    current.bars += 1;
    current.timestamps.push(Number(bar.t));
    if (bar.partial) current.partialBars += 1;
    else current.completeBars += 1;
    if (bar.executionSideComplete === true) current.executionCompleteBars += 1;
    else current.executionIncompleteBars += 1;
    sessions.set(day, current);
  }
  const list = [...sessions.values()].map((session) => {
    const observed = new Set(session.timestamps);
    const { timestamps: _timestamps, ...sessionFacts } = session;
    const expected = typeof expectedTimestampsForTradingDay === "function"
      ? [...new Set((expectedTimestampsForTradingDay(session.tradingDay) ?? [])
        .map(Number).filter(Number.isFinite))].sort((left, right) => left - right)
      : [];
    const missing = expected.filter((timestamp) => !observed.has(timestamp));
    const coverageKnown = typeof expectedTimestampsForTradingDay === "function";
    const coverageComplete = coverageKnown && expected.length > 0 && missing.length === 0;
    return {
      ...sessionFacts,
      expectedBars: coverageKnown ? expected.length : null,
      missingBars: coverageKnown ? missing.length : null,
      missingTimestamps: missing.slice(0, 24).map((timestamp) => new Date(timestamp).toISOString()),
      coverage: coverageKnown && expected.length > 0 ? session.bars / expected.length : null,
      coverageComplete: coverageKnown ? coverageComplete : null,
      firstExpectedAt: expected.length > 0 ? new Date(expected[0]).toISOString() : null,
      lastExpectedAt: expected.length > 0 ? new Date(expected.at(-1)).toISOString() : null,
      firstObservedAt: observed.size > 0 ? new Date(Math.min(...observed)).toISOString() : null,
      lastObservedAt: observed.size > 0 ? new Date(Math.max(...observed)).toISOString() : null,
    };
  }).sort((left, right) => left.tradingDay.localeCompare(right.tradingDay));
  const isComplete = (session) => session.partialBars === 0 && session.completeBars > 0
    && session.coverageComplete !== false;
  return {
    total: list.length,
    complete: list.filter(isComplete).length,
    partial: list.filter((session) => !isComplete(session)).length,
    executionComplete: list.filter((session) => isComplete(session) && session.executionIncompleteBars === 0).length,
    executionIncomplete: list.filter((session) => !isComplete(session) || session.executionIncompleteBars > 0).length,
    coverageKnown: typeof expectedTimestampsForTradingDay === "function",
    items: list,
  };
}

function barProjection(bar) {
  return canonicalize(bar);
}

export function buildReplayDatasetFromBars({
  bars5 = [],
  bars60 = [],
  asOf,
  instrument = REPLAY_DATASET_INSTRUMENT,
  lane = "cmb",
  market = "bank",
  currency = "CNY",
  unit = "gram",
  dataSchemaVersion = null,
  calendarVersion = null,
  sourceVersion = null,
  inputFingerprint = null,
  recordEvidence = null,
  recordsAccepted = null,
  recordsExcludedAsOf = 0,
  recordsExcludedMarketHours = 0,
  partitions = [],
  acceptTimestamp = null,
  tradingDayForTimestamp = null,
  expectedTimestampsForTradingDay = null,
  requirePointInTimeIngestion = false,
} = {}) {
  const asOfMs = instantMs(asOf);
  if (asOfMs === null) throw new TypeError("buildReplayDatasetFromBars requires a valid asOf");
  const identity = { instrument, lane, market, currency, unit };
  const barKnownAt = (bar, intervalMinutes) => {
    const raw = bar?.ingestedAt ?? bar?.receivedAt;
    if (raw === null || raw === undefined || raw === "") return requirePointInTimeIngestion !== true;
    const knownAtMs = instantMs(raw);
    const knowledgeCutoff = requirePointInTimeIngestion === true
      ? Math.min(asOfMs, Number(bar?.t) + intervalMinutes * MINUTE_MS)
      : asOfMs;
    return knownAtMs !== null && knownAtMs <= knowledgeCutoff;
  };
  const normalizedBars = (values, intervalMinutes) => [...values]
    .filter((bar) => bar && Number.isFinite(Number(bar.t))
      && Number(bar.t) + intervalMinutes * MINUTE_MS <= asOfMs
      && barKnownAt(bar, intervalMinutes)
      && (typeof acceptTimestamp !== "function" || acceptTimestamp(Number(bar.t)) === true))
    .map((bar) => ({ ...bar, intervalMinutes, instrument: bar.instrument ?? instrument, market: bar.market ?? market, currency: bar.currency ?? currency, unit: bar.unit ?? unit }))
    .sort((left, right) => Number(left.t) - Number(right.t));
  const sourceBars = [
    ...bars5.map((bar) => ({ bar, intervalMinutes: 5 })),
    ...bars60.map((bar) => ({ bar, intervalMinutes: 60 })),
  ];
  const lateIngestedBarsExcluded = sourceBars.filter(({ bar, intervalMinutes }) => {
    const raw = bar?.ingestedAt ?? bar?.receivedAt;
    if (raw === null || raw === undefined || raw === "") return false;
    const knownAtMs = instantMs(raw);
    const knowledgeCutoff = requirePointInTimeIngestion === true
      ? Math.min(asOfMs, Number(bar?.t) + intervalMinutes * MINUTE_MS)
      : asOfMs;
    return knownAtMs === null || knownAtMs > knowledgeCutoff;
  }).length;
  const sourceBarsMissingIngestedAt = sourceBars.filter(({ bar }) => {
    const raw = bar?.ingestedAt ?? bar?.receivedAt;
    return raw === null || raw === undefined || raw === "";
  }).length;
  const normalized5 = normalizedBars(bars5, 5);
  const normalized60 = normalizedBars(bars60, 60);
  const barsMissingIngestedAt = [...normalized5, ...normalized60].filter((bar) => {
    const raw = bar?.ingestedAt ?? bar?.receivedAt;
    return raw === null || raw === undefined || raw === "";
  }).length;
  const allBars = [...normalized5, ...normalized60];
  const sourceSet = [...new Set(allBars.flatMap((bar) => Array.isArray(bar.sources) ? bar.sources : [bar.source]).filter(Boolean))].sort();
  const evidence = recordEvidence ?? evidenceCounts(normalized5);
  const rangeBars = normalized5.length > 0 ? normalized5 : normalized60;
  const sessions = sessionSummary(normalized5, tradingDayForTimestamp, expectedTimestampsForTradingDay);
  const content = {
    bars: {
      5: normalized5.map(barProjection),
      60: normalized60.map(barProjection),
    },
  };
  const contentSha256 = stableReplayFingerprint(content);
  const derivedInputFingerprint = inputFingerprint ?? stableReplayFingerprint({
    asOf: new Date(asOfMs).toISOString(),
    dataSchemaVersion,
    calendarVersion,
    sourceVersion,
    contentSha256,
  });
  const realBidAskBars = normalized5.filter((bar) => bar.executionSideComplete === true
    && normalizeEvidence(bar.evidence ?? bar.executionEvidence) === "real").length;
  const executableBars = normalized5.filter((bar) => bar.executionSideComplete === true).length;
  const partitionList = (Array.isArray(partitions) ? partitions : [])
    .filter((entry) => entry && typeof entry === "object")
    .map((entry) => ({
      instrument: entry.instrument ?? instrument,
      tradingDay: entry.tradingDay ?? null,
      records: Number(entry.records) || 0,
      selectedRecords: Number(entry.selectedRecords ?? entry.records) || 0,
      contentSha256: entry.selectedContentSha256 ?? entry.contentSha256 ?? null,
      storeContentSha256: entry.storeContentSha256 ?? null,
      dataSchemaVersion: entry.dataSchemaVersion ?? dataSchemaVersion,
      rejected: Number(entry.rejected) || 0,
      quarantined: entry.quarantined === true,
    }))
    .sort((left, right) => String(left.tradingDay).localeCompare(String(right.tradingDay)));
  const fromMs = rangeBars.length > 0 ? Number(rangeBars[0].t) : null;
  const toMs = rangeBars.length > 0 ? Number(rangeBars.at(-1).t) : null;
  const manifestCore = {
    version: REPLAY_DATASET_VERSION,
    instrument,
    lane,
    market,
    currency,
    unit,
    intervals: [...REPLAY_DATASET_INTERVALS],
    asOf: new Date(asOfMs).toISOString(),
    dataSchemaVersion,
    calendarVersion,
    sourceVersion,
    sources: sourceSet,
    evidence,
    records: {
      accepted: recordsAccepted ?? null,
      excludedAsOf: recordsExcludedAsOf,
      excludedMarketHours: recordsExcludedMarketHours,
      excludedLateIngestedBars: lateIngestedBarsExcluded,
      excludedMissingIngestedAtBars: requirePointInTimeIngestion === true ? sourceBarsMissingIngestedAt : 0,
      missingIngestedAtBars: barsMissingIngestedAt,
    },
    pointInTimePolicy: requirePointInTimeIngestion === true ? "known-by-bar-close" : "known-by-as-of-compatible",
    bars: {
      5: { total: normalized5.length, complete: normalized5.filter((bar) => !bar.partial).length, partial: normalized5.filter((bar) => bar.partial).length },
      60: { total: normalized60.length, complete: normalized60.filter((bar) => !bar.partial).length, partial: normalized60.filter((bar) => bar.partial).length },
    },
    sessions,
    executionCoverage: {
      bars: normalized5.length,
      executableBars,
      realBidAskBars,
      realBidAskCoverage: normalized5.length > 0 ? realBidAskBars / normalized5.length : null,
    },
    realBidAskCoverage: normalized5.length > 0 ? realBidAskBars / normalized5.length : null,
    partitions: partitionList,
    quarantinedPartitions: partitionList.filter((entry) => entry.quarantined).length,
    rejectedRecords: partitionList.reduce((sum, entry) => sum + entry.rejected, 0),
    dateRange: {
      from: fromMs === null ? null : new Date(fromMs).toISOString(),
      to: toMs === null ? null : new Date(toMs).toISOString(),
    },
    historyMonths: fromMs !== null && toMs !== null && toMs >= fromMs
      ? (toMs - fromMs) / (365.25 * 24 * 60 * 60_000 / 12)
      : 0,
    contentSha256,
    inputFingerprint: derivedInputFingerprint,
  };
  const identityCore = {
    ...manifestCore,
    records: {
      accepted: manifestCore.records.accepted,
      missingIngestedAtBars: manifestCore.records.missingIngestedAtBars,
    },
    partitions: partitionList.map((entry) => ({
      instrument: entry.instrument,
      tradingDay: entry.tradingDay,
      dataSchemaVersion: entry.dataSchemaVersion,
      quarantined: entry.quarantined,
    })),
    rejectedRecords: undefined,
  };
  return {
    version: REPLAY_DATASET_VERSION,
    bars: { 5: normalized5, 60: normalized60 },
    manifest: { ...manifestCore, datasetId: `dataset-${stableReplayFingerprint(identityCore)}` },
  };
}

export function buildReplayDataset({
  records = [],
  asOf,
  instrument = REPLAY_DATASET_INSTRUMENT,
  lane = "cmb",
  market = "bank",
  currency = "CNY",
  unit = "gram",
  dataSchemaVersion = null,
  calendarVersion = null,
  sourceVersion = null,
  partitions = [],
  acceptTimestamp = null,
  tradingDayForTimestamp = null,
  expectedTimestampsForTradingDay = null,
  requirePointInTimeIngestion = true,
} = {}) {
  const asOfMs = instantMs(asOf);
  if (asOfMs === null) throw new TypeError("buildReplayDataset requires a valid asOf");
  const normalized = records.map(normalizedQuote).filter(Boolean);
  const pointInTime = normalized.filter((record) => {
    const barCloseMs = Math.floor(record.sourceTimestampMs / (5 * MINUTE_MS)) * 5 * MINUTE_MS + 5 * MINUTE_MS;
    return record.sourceTimestampMs <= asOfMs
      && record.ingestedAtMs <= Math.min(asOfMs, barCloseMs);
  });
  const accepted = pointInTime.filter((record) => typeof acceptTimestamp !== "function" || acceptTimestamp(record.sourceTimestampMs) === true);
  accepted.sort((left, right) => left.sourceTimestampMs - right.sourceTimestampMs || left.eventId.localeCompare(right.eventId));
  const excludedAsOf = normalized.length - pointInTime.length;
  const excludedMarketHours = pointInTime.length - accepted.length;
  const inputFingerprint = stableReplayFingerprint(accepted.map((record) => ({
    eventId: record.eventId,
    sourceTimestamp: new Date(record.sourceTimestampMs).toISOString(),
    ingestedAt: new Date(record.ingestedAtMs).toISOString(),
    source: record.source,
    evidence: record.evidence,
    ask: record.ask,
    bid: record.bid,
  })));
  const schemaVersions = [...new Set(accepted.map((record) => record.dataSchemaVersion).filter(Boolean))].sort();
  const identity = { instrument, lane, market, currency, unit };
  return buildReplayDatasetFromBars({
    bars5: aggregateQuotes(accepted, 5, asOfMs, identity),
    bars60: aggregateQuotes(accepted, 60, asOfMs, identity),
    asOf: asOfMs,
    ...identity,
    dataSchemaVersion: dataSchemaVersion ?? (schemaVersions.length === 1 ? schemaVersions[0] : schemaVersions.length > 1 ? "mixed" : null),
    calendarVersion,
    sourceVersion,
    partitions,
    inputFingerprint,
    recordEvidence: evidenceCounts(accepted),
    recordsAccepted: accepted.length,
    recordsExcludedAsOf: excludedAsOf,
    recordsExcludedMarketHours: excludedMarketHours,
    acceptTimestamp,
    tradingDayForTimestamp,
    expectedTimestampsForTradingDay,
    requirePointInTimeIngestion,
  });
}

export async function buildReplayDatasetFromStore(store, options = {}) {
  if (!store || typeof store.query !== "function") throw new TypeError("store.query is required");
  const instrument = options.instrument ?? REPLAY_DATASET_INSTRUMENT;
  const records = await store.query({
    instrument,
    from: options.from,
    to: options.to,
    asOf: options.asOf,
    evidence: options.evidence,
  });
  const grouped = new Map();
  for (const record of records) {
    const tradingDay = typeof record.tradingDay === "string" ? record.tradingDay : null;
    if (!grouped.has(tradingDay)) grouped.set(tradingDay, []);
    grouped.get(tradingDay).push(record);
  }
  for (const items of grouped.values()) {
    items.sort((left, right) => {
      const leftAt = sourceTime(left) ?? 0;
      const rightAt = sourceTime(right) ?? 0;
      return leftAt - rightAt || String(left.eventId ?? "").localeCompare(String(right.eventId ?? ""));
    });
  }
  let storeManifests = [];
  if (typeof store.getManifest === "function") {
    try {
      const value = await store.getManifest({ instrument });
      storeManifests = Array.isArray(value) ? value : value ? [value] : [];
    } catch {
      storeManifests = [];
    }
  }
  const fromDay = options.from ? new Date(options.from).toISOString().slice(0, 10) : null;
  const upperBound = options.to ?? options.asOf;
  const toDay = upperBound ? new Date(upperBound).toISOString().slice(0, 10) : null;
  const manifestByDay = new Map(storeManifests
    .filter((entry) => (!fromDay || entry.tradingDay >= fromDay) && (!toDay || entry.tradingDay <= toDay))
    .map((entry) => [entry.tradingDay, entry]));
  const days = [...new Set([...grouped.keys(), ...manifestByDay.keys()])].sort((left, right) => String(left).localeCompare(String(right)));
  const partitions = days.map((tradingDay) => {
    const items = grouped.get(tradingDay) ?? [];
    const stored = manifestByDay.get(tradingDay) ?? {};
    const selectedProjection = items.map((record) => ({
      eventId: record.eventId ?? null,
      sourceTimestamp: record.sourceTimestamp ?? null,
      ingestedAt: record.ingestedAt ?? null,
      evidence: record.evidence ?? null,
      customerAsk: record.customerAsk ?? null,
      customerBid: record.customerBid ?? null,
    }));
    return {
      instrument,
      tradingDay,
      records: Number(stored.records) || items.length,
      selectedRecords: items.length,
      selectedContentSha256: stableReplayFingerprint(selectedProjection),
      storeContentSha256: stored.contentSha256 ?? null,
      dataSchemaVersion: stored.dataSchemaVersion ?? options.dataSchemaVersion ?? null,
      rejected: Number(stored.rejected) || 0,
      quarantined: stored.quarantined === true,
    };
  });
  return buildReplayDataset({ ...options, instrument, records, partitions });
}
