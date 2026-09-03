import { parseQuoteTimestamp } from "./parsers.js";

export const MARKET_DATA_SCHEMA_VERSION = "goldboard-market-data-v2";
export const CALCULATION_VERSION = "goldboard-indicators-v3";
export const MAX_QUOTE_FUTURE_SKEW_MS = 60_000;

export const EXECUTION_EVIDENCE_MODES = Object.freeze(["real", "synthetic", "proxy", "unknown"]);

export const INDICATOR_METHODS = Object.freeze({
  ema: "sma-seeded exponential moving average",
  rsi: "Wilder smoothing",
  atr: "Wilder smoothing",
  bollinger: "population standard deviation",
  macd: "EMA(12)-EMA(26), signal EMA(9)",
  supportResistance: "last 20 closed bars, current bar excluded",
});

const QUOTE_META = Object.freeze({
  AU9999: Object.freeze({ instrument: "Au99.99", market: "sge", currency: "CNY", unit: "gram" }),
  XAU: Object.freeze({ instrument: "XAU/USD", market: "spot", currency: "USD", unit: "troy_ounce" }),
  GCF: Object.freeze({ instrument: "GC=F", market: "futures", currency: "USD", unit: "troy_ounce" }),
  USDCNY: Object.freeze({ instrument: "USD/CNY", market: "forex", currency: "CNY", unit: "rate" }),
  CMB: Object.freeze({ instrument: "CMB_ACCUMULATED_GOLD", market: "bank", currency: "CNY", unit: "gram" }),
});

const FALLBACK_SOURCES = new Set(["60s", "gold-api", "goldprice-today", "yahoo", "jdjy", "jijinhao"]);
const QUALITY_VALUES = new Set(["primary", "fallback", "degraded", "synthetic", "proxy", "unknown", "unavailable"]);

function finitePositive(value) {
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? number : null;
}

function instantMs(value) {
  if (value instanceof Date) return Number.isFinite(value.getTime()) ? value.getTime() : null;
  if (typeof value === "number" && Number.isFinite(value)) {
    const normalized = value > 0 && value < 100_000_000_000 ? value * 1000 : value;
    return Number.isFinite(new Date(normalized).getTime()) ? normalized : null;
  }
  if (typeof value === "string" && value.trim() !== "") {
    const trimmed = value.trim();
    if (/^\d{10,13}$/.test(trimmed)) return instantMs(Number(trimmed));
    const parsed = Date.parse(trimmed);
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}

function isoOrNull(value) {
  const timestamp = instantMs(value);
  return timestamp === null ? null : new Date(timestamp).toISOString();
}

function quoteTimestampMs(quote, receivedAtMs) {
  const timestamp = parseQuoteTimestamp({
    date: quote?.date,
    time: quote?.sourceTimestamp ?? quote?.timestamp ?? quote?.time,
  }, new Date(receivedAtMs));
  return Number.isFinite(timestamp) ? timestamp : null;
}

function timingFacts(sourceTimestampMs, receivedAtMs) {
  if (sourceTimestampMs === null || receivedAtMs === null) {
    return { sourceDelayMs: null, futureSkewMs: null };
  }
  return {
    sourceDelayMs: Math.max(0, receivedAtMs - sourceTimestampMs),
    futureSkewMs: Math.max(0, sourceTimestampMs - receivedAtMs),
  };
}

function normalizeQuality(value, fallback) {
  return QUALITY_VALUES.has(value) ? value : fallback;
}

function normalizeEvidenceMode(value, fallback = "unknown") {
  const mode = typeof value === "string" ? value : value?.mode;
  return EXECUTION_EVIDENCE_MODES.includes(mode) ? mode : fallback;
}

/** Attach one stable v2 instrument/market contract to a provider quote. */
export function normalizeQuoteRecord(key, quote, receivedAt = Date.now(), ingestedAt = receivedAt) {
  if (!quote || typeof quote !== "object") return null;
  const base = QUOTE_META[key];
  if (!base) throw new Error(`unknown quote key: ${String(key)}`);
  const source = typeof quote.source === "string" && quote.source !== "" ? quote.source : "unknown";
  const yahooFutures = key === "XAU" && source === "yahoo";
  const receivedAtMs = instantMs(quote.receivedAt) ?? instantMs(receivedAt) ?? Date.now();
  const ingestedAtMs = instantMs(quote.ingestedAt) ?? instantMs(ingestedAt) ?? receivedAtMs;
  const sourceTimestampMs = quoteTimestampMs(quote, receivedAtMs);
  const timing = timingFacts(sourceTimestampMs, receivedAtMs);
  const customerAsk = key === "CMB"
    ? finitePositive(quote.customerAsk ?? quote.customerBuy ?? quote.buyPrice ?? quote.ask ?? quote.price)
    : finitePositive(quote.customerAsk ?? quote.ask);
  const customerBid = key === "CMB"
    ? finitePositive(quote.customerBid ?? quote.customerSell ?? quote.sellPrice ?? quote.bid)
    : finitePositive(quote.customerBid ?? quote.bid);
  const sideComplete = customerAsk !== null && customerBid !== null;
  const proxy = quote.quality === "proxy" || source === "manual" || source === "xau-fx-derived";
  const providedSynthetic = quote.synthetic === true || proxy;
  const evidenceFallback = proxy
    ? "proxy"
    : sideComplete ? (providedSynthetic ? "synthetic" : "real") : "unknown";
  const evidenceMode = normalizeEvidenceMode(quote.executionEvidence, evidenceFallback);
  const synthetic = providedSynthetic || evidenceMode === "proxy" || evidenceMode === "synthetic";
  const askSource = quote.customerAskSource ?? quote.customerBuySource ?? quote.executionEvidence?.askSource
    ?? (customerAsk !== null ? source : null);
  const bidSource = quote.customerBidSource ?? quote.customerSellSource ?? quote.executionEvidence?.bidSource
    ?? (customerBid !== null ? source : null);
  const fallbackQuality = evidenceMode === "proxy" ? "proxy" : synthetic ? "synthetic" : (FALLBACK_SOURCES.has(source) ? "fallback" : "primary");
  const quality = normalizeQuality(quote.quality, fallbackQuality);
  const spread = customerAsk !== null && customerBid !== null ? customerAsk - customerBid : null;

  const normalized = {
    ...quote,
    ...base,
    ...(yahooFutures ? { instrument: "GC=F", market: "futures" } : {}),
    dataSchemaVersion: MARKET_DATA_SCHEMA_VERSION,
    source,
    sourceTimestamp: sourceTimestampMs === null ? null : new Date(sourceTimestampMs).toISOString(),
    receivedAt: new Date(receivedAtMs).toISOString(),
    ingestedAt: new Date(ingestedAtMs).toISOString(),
    sourceDelayMs: timing.sourceDelayMs,
    futureSkewMs: timing.futureSkewMs,
    staleAfterMs: Number.isFinite(Number(quote.staleAfterMs)) ? Number(quote.staleAfterMs) : 15 * 60_000,
    quality,
    synthetic,
    executionSideComplete: sideComplete,
    executionEvidence: {
      mode: evidenceMode,
      askSource: askSource ?? null,
      bidSource: bidSource ?? null,
    },
    customerAsk,
    customerBid,
    customerAskSource: askSource ?? null,
    customerBidSource: bidSource ?? null,
    updatedAt: receivedAtMs,
  };
  if (key === "CMB") {
    normalized.customerBuy = customerAsk;
    normalized.customerSell = customerBid;
    normalized.buyPrice = customerAsk;
    normalized.sellPrice = customerBid;
    normalized.ask = customerAsk;
    normalized.bid = customerBid;
    normalized.spread = spread;
  }
  return normalized;
}

/** Normalize provider bars at the adapter seam without inventing prices or provenance. */
export function normalizeBarRecord(bar, metadata = {}) {
  if (!bar || typeof bar !== "object") return null;
  const t = Number(bar.t);
  const o = Number(bar.o);
  const h = Number(bar.h);
  const l = Number(bar.l);
  const c = Number(bar.c);
  if (![t, o, h, l, c].every(Number.isFinite) || !(o > 0 && h > 0 && l > 0 && c > 0)) return null;

  const providedSynthetic = bar.synthetic === true || metadata.synthetic === true;
  const source = typeof bar.source === "string" ? bar.source : typeof metadata.source === "string" ? metadata.source : "unknown";
  const sourceTimestampMs = instantMs(bar.sourceTimestamp ?? metadata.sourceTimestamp) ?? t;
  const receivedAtMs = instantMs(bar.receivedAt ?? metadata.receivedAt);
  const ingestedAtMs = instantMs(bar.ingestedAt ?? metadata.ingestedAt) ?? receivedAtMs;
  const timing = timingFacts(sourceTimestampMs, receivedAtMs);
  const sideValues = {};
  for (const key of ["askO", "askH", "askL", "askC", "bidO", "bidH", "bidL", "bidC"]) {
    const value = finitePositive(bar[key]);
    if (value !== null) sideValues[key] = value;
  }
  const hasAllSides = ["askO", "askH", "askL", "askC", "bidO", "bidH", "bidL", "bidC"]
    .every((key) => sideValues[key] !== undefined);
  const sideComplete = bar.executionSideComplete === true && hasAllSides;
  const instrument = typeof bar.instrument === "string" ? bar.instrument : typeof metadata.instrument === "string" ? metadata.instrument : null;
  const proxySource = source === "manual" || source === "xau-fx-derived" || bar.quality === "proxy" || metadata.quality === "proxy";
  const evidenceFallback = proxySource ? "proxy" : sideComplete ? "real" : providedSynthetic ? "synthetic" : "unknown";
  const evidenceMode = normalizeEvidenceMode(bar.executionEvidence, evidenceFallback);
  const synthetic = providedSynthetic || proxySource || evidenceMode === "proxy" || evidenceMode === "synthetic";
  const sharedSideSource = typeof bar.executionSideSource === "string" ? bar.executionSideSource : null;
  const askSource = bar.customerAskSource ?? bar.executionEvidence?.askSource ?? (sideComplete ? sharedSideSource ?? source : null);
  const bidSource = bar.customerBidSource ?? bar.executionEvidence?.bidSource ?? (sideComplete ? sharedSideSource ?? source : null);
  const fallbackQuality = evidenceMode === "proxy" ? "proxy" : synthetic ? "synthetic" : "primary";

  return {
    t,
    o,
    h,
    l,
    c,
    dataSchemaVersion: MARKET_DATA_SCHEMA_VERSION,
    source,
    sourceTimestamp: new Date(sourceTimestampMs).toISOString(),
    receivedAt: receivedAtMs === null ? null : new Date(receivedAtMs).toISOString(),
    ingestedAt: ingestedAtMs === null ? null : new Date(ingestedAtMs).toISOString(),
    sourceDelayMs: timing.sourceDelayMs,
    futureSkewMs: timing.futureSkewMs,
    quality: normalizeQuality(bar.quality ?? metadata.quality, fallbackQuality),
    synthetic,
    partial: bar.partial === true,
    executionSideComplete: sideComplete,
    executionEvidence: {
      mode: evidenceMode,
      askSource: askSource ?? null,
      bidSource: bidSource ?? null,
    },
    customerAsk: sideValues.askC ?? null,
    customerBid: sideValues.bidC ?? null,
    customerAskSource: askSource ?? null,
    customerBidSource: bidSource ?? null,
    ...(sideComplete && sharedSideSource ? { executionSideSource: sharedSideSource } : {}),
    ...(Number.isFinite(Number(bar.sampleCount)) ? { sampleCount: Number(bar.sampleCount) } : {}),
    ...(Number.isFinite(Number(bar.expectedSamples)) ? { expectedSamples: Number(bar.expectedSamples) } : {}),
    ...(instrument ? { instrument } : {}),
    ...(typeof bar.market === "string" ? { market: bar.market } : typeof metadata.market === "string" ? { market: metadata.market } : {}),
    ...(typeof bar.currency === "string" ? { currency: bar.currency } : typeof metadata.currency === "string" ? { currency: metadata.currency } : {}),
    ...(typeof bar.unit === "string" ? { unit: bar.unit } : typeof metadata.unit === "string" ? { unit: metadata.unit } : {}),
    ...sideValues,
  };
}

export function isBarClosed(bar, intervalMinutes, now = Date.now()) {
  if (!bar || !Number.isFinite(Number(bar.t)) || !(intervalMinutes > 0)) return false;
  return Number(bar.t) + intervalMinutes * 60_000 <= new Date(now).getTime();
}

/** Return valid, time-ordered, complete bars whose bucket has finished. */
export function closedBars(bars, intervalMinutes, now = Date.now(), options = {}) {
  if (!Array.isArray(bars)) return [];
  return bars
    .map((bar) => normalizeBarRecord(bar))
    .filter((bar) => bar !== null
      && (options.includePartial === true || bar.partial !== true)
      && isBarClosed(bar, intervalMinutes, now))
    .sort((a, b) => a.t - b.t);
}

/** Validate OHLC invariants and timeline integrity for one bar series. */
export function inspectBars(bars) {
  const list = Array.isArray(bars) ? bars : [];
  let invalidOhlc = 0;
  let invalidValues = 0;
  let duplicateBuckets = 0;
  let nonMonotonic = 0;
  let syntheticCount = 0;
  let partialCount = 0;
  const evidenceCounts = { real: 0, synthetic: 0, proxy: 0, unknown: 0 };
  const seen = new Set();
  let previous = -Infinity;
  for (const raw of list) {
    const bar = normalizeBarRecord(raw);
    if (!bar) {
      invalidValues += 1;
      continue;
    }
    if (bar.h < Math.max(bar.o, bar.c) || bar.l > Math.min(bar.o, bar.c) || bar.h < bar.l) invalidOhlc += 1;
    if (seen.has(bar.t)) duplicateBuckets += 1;
    seen.add(bar.t);
    if (bar.t <= previous) nonMonotonic += 1;
    previous = bar.t;
    if (bar.synthetic) syntheticCount += 1;
    if (bar.partial) partialCount += 1;
    evidenceCounts[normalizeEvidenceMode(bar.executionEvidence)] += 1;
  }
  return {
    count: list.length,
    validCount: list.length - invalidValues - invalidOhlc,
    invalidValues,
    invalidOhlc,
    duplicateBuckets,
    nonMonotonic,
    syntheticCount,
    partialCount,
    evidenceCounts,
    synthetic: syntheticCount > 0,
    partial: partialCount > 0,
    ok: invalidValues === 0 && invalidOhlc === 0 && duplicateBuckets === 0 && nonMonotonic === 0,
  };
}

function allWarm(indicators, field) {
  const values = Object.values(indicators ?? {}).filter((entry) => entry && typeof entry === "object" && "count" in entry);
  return values.length > 0 && values.every((entry) => entry[field] === true);
}

export function minimumCoverageForWindow(minutes) {
  return Number(minutes) === 30 || Number(minutes) === 60 ? 0.6 : 0.8;
}

/** Build the same detailed freshness record for a primary quote or dependency. */
export function inspectQuoteDependency(id, quote, now = Date.now()) {
  const nowMs = new Date(now).getTime();
  const updatedAt = instantMs(quote?.receivedAt) ?? instantMs(quote?.updatedAt);
  const sourceTimestampMs = instantMs(quote?.sourceTimestamp);
  const ageMs = updatedAt === null ? null : Math.max(0, nowMs - updatedAt);
  const sourceAgeMs = sourceTimestampMs === null ? null : Math.max(0, nowMs - sourceTimestampMs);
  const sourceDelayMs = sourceTimestampMs === null || updatedAt === null
    ? (Number.isFinite(Number(quote?.sourceDelayMs)) ? Number(quote.sourceDelayMs) : null)
    : Math.max(0, updatedAt - sourceTimestampMs);
  const futureSkewMs = sourceTimestampMs === null
    ? (Number.isFinite(Number(quote?.futureSkewMs)) ? Number(quote.futureSkewMs) : null)
    : Math.max(0, sourceTimestampMs - nowMs);
  const staleAfterMs = Number.isFinite(Number(quote?.staleAfterMs)) ? Number(quote.staleAfterMs) : 15 * 60_000;
  const future = futureSkewMs !== null && futureSkewMs > MAX_QUOTE_FUTURE_SKEW_MS;
  const stale = !quote || !(Number(quote.price) > 0)
    || updatedAt === null || ageMs > staleAfterMs
    || sourceAgeMs !== null && sourceAgeMs > staleAfterMs
    || sourceDelayMs !== null && sourceDelayMs > staleAfterMs
    || quote.stale === true || future;
  return {
    id,
    stale,
    future,
    ageMs,
    sourceAgeMs,
    sourceDelayMs,
    futureSkewMs,
    staleAfterMs,
    source: quote?.source ?? null,
    sourceTimestamp: isoOrNull(quote?.sourceTimestamp),
    receivedAt: isoOrNull(quote?.receivedAt ?? quote?.updatedAt),
    ingestedAt: isoOrNull(quote?.ingestedAt),
    quality: quote?.quality ?? null,
    synthetic: quote?.synthetic === true,
    executionSideComplete: quote?.executionSideComplete === true,
  };
}

/** Collapse quote, bar, coverage, warm-up and rule facts into one auditable result. */
export function assessMarketQuality(input) {
  const now = new Date(input?.now ?? Date.now()).getTime();
  const quote = input?.quote ?? null;
  const bars = input?.bars ?? [];
  const barInspection = inspectBars(bars);
  const coverage = input?.coverage && typeof input.coverage === "object" ? input.coverage : {};
  const coverageDetails = input?.coverageDetails && typeof input.coverageDetails === "object" ? input.coverageDetails : {};
  const requiredCoverage = Array.isArray(input?.requiredCoverage) ? input.requiredCoverage : [5, 10, 30, 60];
  const failingCoverage = requiredCoverage.filter((minutes) => !(Number(coverage[minutes]) > minimumCoverageForWindow(minutes)));
  const primary = inspectQuoteDependency(quote?.instrument ?? "quote", quote, now);
  const planWarmupReady = allWarm(input?.indicators, "planWarmupReady");
  const warmupReady = allWarm(input?.indicators, "warmupReady");
  const dependencies = (Array.isArray(input?.dependencies) ? input.dependencies : []).map((entry, index) => {
    const dependency = entry?.quote ?? entry;
    const id = entry?.id ?? dependency?.instrument ?? `dependency-${index + 1}`;
    return inspectQuoteDependency(id, dependency, now);
  });
  const dependencyStale = dependencies.some((entry) => entry.stale);
  const dependencyFuture = dependencies.some((entry) => entry.future);
  const sourceDisagreementPct = Number(input?.sourceDisagreementPct);
  const sourceDisagreement = Number.isFinite(sourceDisagreementPct) && Math.abs(sourceDisagreementPct) > 3;
  const instrumentMismatch = quote?.market === "futures" && input?.expectedMarket === "spot";
  const spreadAvailable = input?.cmbSpread === undefined || Number.isFinite(Number(input.cmbSpread));
  const spreadInvalid = input?.cmbSpread !== undefined && Number.isFinite(Number(input.cmbSpread)) && Number(input.cmbSpread) < 0;
  const reasonCodes = [];
  const warnings = [];
  if (primary.stale) reasonCodes.push("data_stale");
  if (primary.future) reasonCodes.push("timestamp_future");
  if (dependencyStale) reasonCodes.push("dependency_stale");
  if (dependencyFuture) reasonCodes.push("dependency_future");
  if (!barInspection.ok) reasonCodes.push("bars_invalid");
  for (const minutes of failingCoverage) reasonCodes.push(`data_incomplete_${minutes}m`);
  if (!planWarmupReady) reasonCodes.push("indicator_warmup");
  if (instrumentMismatch) reasonCodes.push("instrument_mismatch");
  if (sourceDisagreement) reasonCodes.push("source_disagreement");
  if (!spreadAvailable) reasonCodes.push("cmb_spread_missing");
  if (spreadInvalid) reasonCodes.push("cmb_spread_invalid");
  if (input?.marketState && input.marketState !== "open") reasonCodes.push("market_closed");
  if (!warmupReady) warnings.push("longest_indicator_warmup");
  if (barInspection.synthetic) warnings.push("synthetic_bars");
  if (barInspection.partial) warnings.push("partial_bars_excluded");
  if (quote?.quality === "fallback") warnings.push("fallback_quote");
  if (Object.values(coverageDetails).some((detail) => detail?.reanchored === true)) warnings.push("coverage_reanchored");
  if (Object.values(coverageDetails).some((detail) => detail?.reanchored === true && Number(detail.effectiveSampleMinutes) < Number(detail.windowMinutes))) {
    warnings.push("coverage_effective_window_short");
  }
  const blocked = reasonCodes.length > 0;
  return {
    status: blocked ? "blocked" : warnings.length > 0 ? "degraded" : "ready",
    ready: !blocked,
    reasonCodes,
    warnings,
    dataSchemaVersion: MARKET_DATA_SCHEMA_VERSION,
    calculationVersion: CALCULATION_VERSION,
    quote: primary,
    coverage,
    coverageDetails,
    requiredCoverage,
    dependencies,
    warmupReady,
    planWarmupReady,
    syntheticBars: barInspection.synthetic,
    sourceDisagreementPct: Number.isFinite(sourceDisagreementPct) ? sourceDisagreementPct : null,
    bars: barInspection,
  };
}

export const MarketDataContract = Object.freeze({
  version: MARKET_DATA_SCHEMA_VERSION,
  normalizeQuote: normalizeQuoteRecord,
  normalizeBar: normalizeBarRecord,
  assessQuality: assessMarketQuality,
});
