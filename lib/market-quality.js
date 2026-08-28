import { parseQuoteTimestamp } from "./parsers.js";

export const CALCULATION_VERSION = "goldboard-indicators-v3";
export const MAX_QUOTE_FUTURE_SKEW_MS = 60_000;

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

function finitePositive(value) {
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? number : undefined;
}

function quoteTimestampIso(quote, receivedAt) {
  const timestamp = parseQuoteTimestamp({
    date: quote?.date,
    time: quote?.sourceTimestamp ?? quote?.timestamp ?? quote?.time,
  }, new Date(receivedAt));
  return timestamp === null ? undefined : new Date(timestamp).toISOString();
}

/** Attach one stable instrument/market contract to a provider-specific quote. */
export function normalizeQuoteRecord(key, quote, receivedAt = Date.now()) {
  if (!quote || typeof quote !== "object") return null;
  const base = QUOTE_META[key];
  if (!base) throw new Error(`unknown quote key: ${String(key)}`);
  const source = typeof quote.source === "string" && quote.source !== "" ? quote.source : "unknown";
  const yahooFutures = key === "XAU" && source === "yahoo";
  const customerBuy = key === "CMB" ? finitePositive(quote.customerBuy ?? quote.buyPrice ?? quote.price) : undefined;
  const customerSell = key === "CMB" ? finitePositive(quote.customerSell ?? quote.sellPrice) : undefined;
  const spread = customerBuy !== undefined && customerSell !== undefined ? customerBuy - customerSell : undefined;
  const normalized = {
    ...quote,
    ...base,
    ...(yahooFutures ? { instrument: "GC=F", market: "futures" } : {}),
    source,
    sourceTimestamp: quoteTimestampIso(quote, receivedAt),
    receivedAt: new Date(receivedAt).toISOString(),
    staleAfterMs: Number.isFinite(Number(quote.staleAfterMs)) ? Number(quote.staleAfterMs) : 15 * 60_000,
    quality: quote.quality === "primary" || quote.quality === "fallback" || quote.quality === "degraded"
      ? quote.quality
      : (FALLBACK_SOURCES.has(source) ? "fallback" : "primary"),
    updatedAt: receivedAt,
  };
  if (key === "CMB") {
    normalized.customerBuy = customerBuy;
    normalized.customerSell = customerSell;
    normalized.buyPrice = customerBuy;
    normalized.sellPrice = customerSell;
    normalized.spread = spread;
  }
  return normalized;
}

/** Normalize provider bars at the adapter seam without inventing missing prices. */
export function normalizeBarRecord(bar, metadata = {}) {
  if (!bar || typeof bar !== "object") return null;
  const t = Number(bar.t);
  const o = Number(bar.o);
  const h = Number(bar.h);
  const l = Number(bar.l);
  const c = Number(bar.c);
  if (![t, o, h, l, c].every(Number.isFinite) || !(o > 0 && h > 0 && l > 0 && c > 0)) return null;
  const normalized = {
    t,
    o,
    h,
    l,
    c,
    ...(bar.synthetic === true || metadata.synthetic === true ? { synthetic: true } : { synthetic: false }),
    ...(bar.partial === true ? { partial: true } : {}),
    ...(bar.executionSideComplete === true ? { executionSideComplete: true } : bar.executionSideComplete === false ? { executionSideComplete: false } : {}),
    ...(typeof bar.executionSideSource === "string" ? { executionSideSource: bar.executionSideSource } : {}),
    ...(Number.isFinite(Number(bar.sampleCount)) ? { sampleCount: Number(bar.sampleCount) } : {}),
    ...(Number.isFinite(Number(bar.expectedSamples)) ? { expectedSamples: Number(bar.expectedSamples) } : {}),
    ...(typeof bar.source === "string" ? { source: bar.source } : typeof metadata.source === "string" ? { source: metadata.source } : {}),
    ...(typeof bar.instrument === "string" ? { instrument: bar.instrument } : typeof metadata.instrument === "string" ? { instrument: metadata.instrument } : {}),
    ...(typeof bar.market === "string" ? { market: bar.market } : typeof metadata.market === "string" ? { market: metadata.market } : {}),
    ...(typeof bar.currency === "string" ? { currency: bar.currency } : typeof metadata.currency === "string" ? { currency: metadata.currency } : {}),
    ...(typeof bar.unit === "string" ? { unit: bar.unit } : typeof metadata.unit === "string" ? { unit: metadata.unit } : {}),
  };
  // Side-specific CMB OHLC is optional for backward compatibility. New live
  // bars carry all eight fields; old/manual bars remain one-sided and replay
  // must label any derived bid path as synthetic.
  for (const key of ["askO", "askH", "askL", "askC", "bidO", "bidH", "bidL", "bidC"]) {
    const value = Number(bar[key]);
    if (Number.isFinite(value) && value > 0) normalized[key] = value;
  }
  return normalized;
}

export function isBarClosed(bar, intervalMinutes, now = Date.now()) {
  if (!bar || !Number.isFinite(Number(bar.t)) || !(intervalMinutes > 0)) return false;
  return Number(bar.t) + intervalMinutes * 60_000 <= new Date(now).getTime();
}

/** Return valid, time-ordered bars whose bucket has finished. */
export function closedBars(bars, intervalMinutes, now = Date.now()) {
  if (!Array.isArray(bars)) return [];
  return bars
    .map((bar) => normalizeBarRecord(bar))
    .filter((bar) => bar !== null && isBarClosed(bar, intervalMinutes, now))
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
  }
  return {
    count: list.length,
    validCount: list.length - invalidValues - invalidOhlc,
    invalidValues,
    invalidOhlc,
    duplicateBuckets,
    nonMonotonic,
    syntheticCount,
    synthetic: syntheticCount > 0,
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

/**
 * Collapse quote, bar, coverage, warm-up and rule facts into one auditable
 * quality result. Callers only branch on status/reasonCodes; the detailed
 * checks remain available for logs and replay.
 */
export function assessMarketQuality(input) {
  const now = new Date(input?.now ?? Date.now()).getTime();
  const quote = input?.quote ?? null;
  const bars = input?.bars ?? [];
  const barInspection = inspectBars(bars);
  const coverage = input?.coverage && typeof input.coverage === "object" ? input.coverage : {};
  const requiredCoverage = Array.isArray(input?.requiredCoverage) ? input.requiredCoverage : [5, 10, 30, 60];
  const failingCoverage = requiredCoverage.filter((minutes) => !(Number(coverage[minutes]) > minimumCoverageForWindow(minutes)));
  const quoteAgeMs = quote && Number.isFinite(Number(quote.updatedAt)) ? Math.max(0, now - Number(quote.updatedAt)) : null;
  const sourceTimestampMs = Number.isFinite(Date.parse(quote?.sourceTimestamp ?? "")) ? Date.parse(quote.sourceTimestamp) : null;
  const receivedAtMs = Number.isFinite(Date.parse(quote?.receivedAt ?? "")) ? Date.parse(quote.receivedAt) : quote?.updatedAt;
  const futureSkewMs = sourceTimestampMs === null ? null : Math.max(0, sourceTimestampMs - now);
  const sourceAgeMs = sourceTimestampMs === null ? null : Math.max(0, now - sourceTimestampMs);
  const sourceDelayMs = sourceTimestampMs === null || !Number.isFinite(Number(receivedAtMs)) ? null : Math.abs(Number(receivedAtMs) - sourceTimestampMs);
  const staleAfterMs = quote && Number.isFinite(Number(quote.staleAfterMs)) ? Number(quote.staleAfterMs) : 15 * 60_000;
  const futureTimestamp = futureSkewMs !== null && futureSkewMs > MAX_QUOTE_FUTURE_SKEW_MS;
  const stale = !quote || !(Number(quote.price) > 0) || quoteAgeMs === null || quoteAgeMs > staleAfterMs || sourceAgeMs !== null && sourceAgeMs > staleAfterMs || sourceDelayMs !== null && sourceDelayMs > staleAfterMs || futureTimestamp || quote.stale === true;
  const planWarmupReady = allWarm(input?.indicators, "planWarmupReady");
  const warmupReady = allWarm(input?.indicators, "warmupReady");
  const dependencies = (Array.isArray(input?.dependencies) ? input.dependencies : []).map((entry, index) => {
    const dependency = entry?.quote ?? entry;
    const id = entry?.id ?? dependency?.instrument ?? `dependency-${index + 1}`;
    const updatedAt = Number(dependency?.updatedAt);
    const ageMs = Number.isFinite(updatedAt) ? Math.max(0, now - updatedAt) : null;
    const timestampMs = Number.isFinite(Date.parse(dependency?.sourceTimestamp ?? ""))
      ? Date.parse(dependency.sourceTimestamp)
      : null;
    const dependencySourceAgeMs = timestampMs === null ? null : Math.max(0, now - timestampMs);
    const dependencyFutureSkewMs = timestampMs === null ? null : Math.max(0, timestampMs - now);
    const dependencyStaleAfterMs = Number.isFinite(Number(dependency?.staleAfterMs))
      ? Number(dependency.staleAfterMs)
      : 15 * 60_000;
    const future = dependencyFutureSkewMs !== null && dependencyFutureSkewMs > MAX_QUOTE_FUTURE_SKEW_MS;
    const staleDependency = !dependency || !(Number(dependency.price) > 0)
      || ageMs === null || ageMs > dependencyStaleAfterMs
      || dependencySourceAgeMs !== null && dependencySourceAgeMs > dependencyStaleAfterMs
      || dependency.stale === true || future;
    return {
      id,
      stale: staleDependency,
      future,
      ageMs,
      sourceAgeMs: dependencySourceAgeMs,
      futureSkewMs: dependencyFutureSkewMs,
      source: dependency?.source ?? null,
    };
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
  if (stale) reasonCodes.push("data_stale");
  if (futureTimestamp) reasonCodes.push("timestamp_future");
  if (dependencyStale) reasonCodes.push("dependency_stale");
  if (dependencyFuture) reasonCodes.push("dependency_future");
  if (!barInspection.ok) reasonCodes.push("bars_invalid");
  for (const minutes of failingCoverage) reasonCodes.push(`data_incomplete_${minutes}m`);
  // The plan only consumes its documented indicator subset. A longer
  // calculation window can still be warming up without making that subset
  // unusable, so only the plan-specific readiness is a blocking condition.
  if (!planWarmupReady) reasonCodes.push("indicator_warmup");
  if (instrumentMismatch) reasonCodes.push("instrument_mismatch");
  if (sourceDisagreement) reasonCodes.push("source_disagreement");
  if (!spreadAvailable) reasonCodes.push("cmb_spread_missing");
  if (spreadInvalid) reasonCodes.push("cmb_spread_invalid");
  if (input?.marketState && input.marketState !== "open") reasonCodes.push("market_closed");
  if (!warmupReady) warnings.push("longest_indicator_warmup");
  if (barInspection.synthetic) warnings.push("synthetic_bars");
  if (quote?.quality === "fallback") warnings.push("fallback_quote");
  const blocked = reasonCodes.length > 0;
  return {
    status: blocked ? "blocked" : warnings.length > 0 ? "degraded" : "ready",
    ready: !blocked,
    reasonCodes,
    warnings,
    calculationVersion: CALCULATION_VERSION,
    quote: {
      stale,
      ageMs: quoteAgeMs,
      sourceAgeMs,
      sourceDelayMs,
      futureSkewMs,
      source: quote?.source ?? null,
      instrument: quote?.instrument ?? null,
      market: quote?.market ?? null,
      quality: quote?.quality ?? null,
    },
    coverage,
    requiredCoverage,
    dependencies,
    warmupReady,
    planWarmupReady,
    syntheticBars: barInspection.synthetic,
    sourceDisagreementPct: Number.isFinite(sourceDisagreementPct) ? sourceDisagreementPct : null,
    bars: barInspection,
  };
}
