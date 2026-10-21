import { createHash } from "node:crypto";

import { REPLAY_DATASET_VERSION } from "./replay-dataset.js";
import {
  WALK_FORWARD_DEFAULTS,
  WALK_FORWARD_REGISTRY_VERSION,
  walkForwardFoldId,
  walkForwardFoldResultFingerprint,
} from "./walk-forward.js";

export const REPLAY_REPORT_SCHEMA_VERSION = 6;
export const REPLAY_REPORT_VERSION = 6;
export const REPLAY_REPORT_SCHEMA = "goldboard-replay-report-v6";
export const REPLAY_REPORT_CALCULATION_VERSION = "goldboard-replay-report-v1";
export const REPLAY_BENCHMARK_VERSION = "goldboard-replay-benchmarks-v2";
export const REPLAY_BOOTSTRAP_VERSION = "seeded-moving-block-bootstrap-v1";
export const REPLAY_EVIDENCE_STATUSES = Object.freeze({ EXPLORATORY: "exploratory", VALIDATED: "validated" });
export const REPLAY_BENCHMARK_IDS = Object.freeze([
  "no_trade",
  "buy_and_hold",
  "fixed_interval_dca",
  "simple_moving_average",
]);
export const REPLAY_VALIDATION_REQUIREMENTS = Object.freeze({
  minimumHistoryMonths: 12,
  minimumOosFolds: 2,
  minimumSessionsPerMonth: WALK_FORWARD_DEFAULTS.minimumSessionsPerMonth,
  requireVersionedDatasetManifest: true,
  requireBoundOosRegistryFingerprint: true,
  requireFrozenOosParameters: true,
  requireRealBidAskEvidence: true,
  requireVerifiedCostSemantics: true,
  requireBenchmarkComparison: true,
  requireUncertaintyIntervals: true,
});

const YEAR_MS = 365.25 * 24 * 60 * 60_000;
const DAY_MS = 24 * 60 * 60_000;
const OMIT_FROM_REPORT_FINGERPRINT = new Set(["generatedAt", "reportId", "reportFingerprint"]);

function finite(value) {
  if (value === null || value === undefined || value === "" || (typeof value === "string" && value.trim() === "")) return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function isoTimestamp(value) {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  const parsed = typeof value === "string" || value instanceof Date ? Date.parse(value) : NaN;
  return Number.isFinite(parsed) ? parsed : null;
}

function round(value, digits = 8) {
  if (!Number.isFinite(value)) return null;
  const scale = 10 ** digits;
  return Math.round((value + Number.EPSILON) * scale) / scale;
}

function mean(values) {
  return values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : null;
}

function sampleDeviation(values) {
  if (values.length < 2) return null;
  const average = mean(values);
  return Math.sqrt(values.reduce((sum, value) => sum + (value - average) ** 2, 0) / (values.length - 1));
}

function quantile(sorted, probability) {
  if (!sorted.length) return null;
  if (sorted.length === 1) return sorted[0];
  const position = (sorted.length - 1) * probability;
  const lower = Math.floor(position);
  const fraction = position - lower;
  return sorted[lower] + (sorted[lower + 1] - sorted[lower]) * fraction;
}

function canonicalize(value, seen = new Set(), keyFilter = null) {
  if (value === null) return "null";
  if (typeof value === "number") return Number.isFinite(value) ? JSON.stringify(Object.is(value, -0) ? 0 : value) : "null";
  if (typeof value === "boolean" || typeof value === "string") return JSON.stringify(value);
  if (typeof value === "bigint") return JSON.stringify(value.toString());
  if (value instanceof Date) return JSON.stringify(value.toISOString());
  if (Buffer.isBuffer(value) || ArrayBuffer.isView(value)) return JSON.stringify(Buffer.from(value.buffer, value.byteOffset, value.byteLength).toString("base64"));
  if (Array.isArray(value)) return `[${value.map((entry) => entry === undefined ? "null" : canonicalize(entry, seen, keyFilter)).join(",")}]`;
  if (typeof value !== "object") return "null";
  if (seen.has(value)) throw new TypeError("canonical JSON does not support circular values");
  seen.add(value);
  const keys = Object.keys(value)
    .filter((key) => value[key] !== undefined && (!keyFilter || keyFilter(key, value[key], value)))
    .sort();
  const result = `{${keys.map((key) => `${JSON.stringify(key)}:${canonicalize(value[key], seen, keyFilter)}`).join(",")}}`;
  seen.delete(value);
  return result;
}

/** Stable JSON uses sorted object keys, preserves array order, and maps non-finite numbers to null. */
export function stableCanonicalJson(value) {
  return canonicalize(value);
}

export function canonicalSha256(value) {
  return createHash("sha256").update(stableCanonicalJson(value)).digest("hex");
}

export const stableSha256 = canonicalSha256;

function semanticDataset(dataset) {
  if (!dataset || typeof dataset !== "object") return {};
  const value = structuredClone(dataset);
  delete value.rejectedRecords;
  if (Array.isArray(value.partitions)) {
    value.partitions = value.partitions.map((partition) => {
      const selected = { ...partition };
      delete selected.storeContentSha256;
      delete selected.rejected;
      delete selected.records;
      delete selected.selectedRecords;
      delete selected.contentSha256;
      return selected;
    });
  }
  return value;
}

export function wilsonInterval(successes, trials, confidence = 0.95) {
  const n = Math.max(0, Math.floor(Number(trials) || 0));
  const k = Math.min(n, Math.max(0, Math.floor(Number(successes) || 0)));
  if (n === 0) return { confidence, successes: k, trials: n, estimate: null, lower: null, upper: null };
  // This primitive is intentionally fixed to the required 95% interval.
  const z = confidence === 0.95 ? 1.959963984540054 : 1.959963984540054;
  const p = k / n;
  const denominator = 1 + z ** 2 / n;
  const center = (p + z ** 2 / (2 * n)) / denominator;
  const margin = z * Math.sqrt((p * (1 - p) + z ** 2 / (4 * n)) / n) / denominator;
  return {
    confidence,
    successes: k,
    trials: n,
    estimate: round(p),
    lower: round(Math.max(0, center - margin)),
    upper: round(Math.min(1, center + margin)),
  };
}

export const wilson95Interval = (successes, trials) => wilsonInterval(successes, trials, 0.95);

function seedToUint32(seed) {
  const digest = createHash("sha256").update(String(seed ?? "goldboard-replay")).digest();
  return digest.readUInt32LE(0) || 0x9e3779b9;
}

function seededRandom(seed) {
  let state = seedToUint32(seed);
  return () => {
    state += 0x6d2b79f5;
    let value = state;
    value = Math.imul(value ^ value >>> 15, value | 1);
    value ^= value + Math.imul(value ^ value >>> 7, value | 61);
    return ((value ^ value >>> 14) >>> 0) / 4_294_967_296;
  };
}

/** Deterministic circular moving-block bootstrap for the arithmetic mean return. */
export function movingBlockBootstrapInterval(values, options = {}) {
  const samples = (Array.isArray(values) ? values : []).map(finite).filter((value) => value !== null);
  const confidence = finite(options.confidence) ?? 0.95;
  const iterations = Math.max(1, Math.floor(finite(options.iterations) ?? 2_000));
  const blockLength = Math.min(samples.length || 1, Math.max(1, Math.floor(finite(options.blockLength) ?? Math.sqrt(samples.length || 1))));
  const seed = options.seed ?? "goldboard-replay-bootstrap";
  if (!samples.length) return { version: REPLAY_BOOTSTRAP_VERSION, confidence, iterations, blockLength: null, seed: String(seed), sampleSize: 0, estimate: null, lower: null, upper: null };
  if (samples.length === 1) return { version: REPLAY_BOOTSTRAP_VERSION, confidence, iterations, blockLength: 1, seed: String(seed), sampleSize: 1, estimate: round(samples[0]), lower: round(samples[0]), upper: round(samples[0]) };
  const random = seededRandom(seed);
  const estimates = [];
  for (let iteration = 0; iteration < iterations; iteration += 1) {
    let total = 0;
    let count = 0;
    while (count < samples.length) {
      const start = Math.floor(random() * samples.length);
      for (let offset = 0; offset < blockLength && count < samples.length; offset += 1) {
        total += samples[(start + offset) % samples.length];
        count += 1;
      }
    }
    estimates.push(total / samples.length);
  }
  estimates.sort((left, right) => left - right);
  const tail = (1 - confidence) / 2;
  return {
    version: REPLAY_BOOTSTRAP_VERSION,
    confidence,
    iterations,
    blockLength,
    seed: String(seed),
    sampleSize: samples.length,
    estimate: round(mean(samples)),
    lower: round(quantile(estimates, tail)),
    upper: round(quantile(estimates, 1 - tail)),
  };
}

export const bootstrapReturnInterval = movingBlockBootstrapInterval;

function replayAbortError(reason) {
  const error = new Error(String(reason?.message ?? reason ?? "replay statistics cancelled"));
  error.name = "AbortError";
  return error;
}

function throwIfAborted(signal) {
  if (signal?.aborted) throw replayAbortError(signal.reason);
}

function yieldToEventLoop() {
  return new Promise((resolve) => setImmediate(resolve));
}

/** Cooperative equivalent of movingBlockBootstrapInterval with identical deterministic output. */
export async function movingBlockBootstrapIntervalAsync(values, options = {}) {
  const samples = (Array.isArray(values) ? values : []).map(finite).filter((value) => value !== null);
  const confidence = finite(options.confidence) ?? 0.95;
  const iterations = Math.max(1, Math.floor(finite(options.iterations) ?? 2_000));
  const blockLength = Math.min(samples.length || 1, Math.max(1, Math.floor(finite(options.blockLength) ?? Math.sqrt(samples.length || 1))));
  const seed = options.seed ?? "goldboard-replay-bootstrap";
  throwIfAborted(options.signal);
  if (samples.length < 2) return movingBlockBootstrapInterval(samples, { confidence, iterations, blockLength, seed });
  const random = seededRandom(seed);
  const estimates = [];
  const chunkSize = Math.max(1, Math.floor(finite(options.chunkSize) ?? 32));
  for (let iteration = 0; iteration < iterations; iteration += 1) {
    let total = 0;
    let count = 0;
    while (count < samples.length) {
      const start = Math.floor(random() * samples.length);
      for (let offset = 0; offset < blockLength && count < samples.length; offset += 1) {
        total += samples[(start + offset) % samples.length];
        count += 1;
      }
    }
    estimates.push(total / samples.length);
    if ((iteration + 1) % chunkSize === 0) {
      await yieldToEventLoop();
      throwIfAborted(options.signal);
    }
  }
  estimates.sort((left, right) => left - right);
  throwIfAborted(options.signal);
  const tail = (1 - confidence) / 2;
  return {
    version: REPLAY_BOOTSTRAP_VERSION,
    confidence,
    iterations,
    blockLength,
    seed: String(seed),
    sampleSize: samples.length,
    estimate: round(mean(samples)),
    lower: round(quantile(estimates, tail)),
    upper: round(quantile(estimates, 1 - tail)),
  };
}

function normalizeEquity(simulation) {
  const source = simulation?.equityCurve ?? simulation?.equity ?? simulation?.ledger?.equityCurve ?? [];
  return (Array.isArray(source) ? source : [])
    .map((point, index) => {
      if (typeof point === "number") return { t: index, equity: finite(point), exposureCny: null, capitalUsedCny: null };
      return {
        t: isoTimestamp(point?.t ?? point?.at ?? point?.time ?? point?.timestamp) ?? index,
        equity: finite(point?.equity ?? point?.value ?? point?.netLiquidationValueCny),
        exposureCny: finite(point?.exposureCny ?? point?.marketValueCny ?? point?.positionValueCny),
        capitalUsedCny: finite(point?.capitalUsedCny ?? point?.costBasisCny ?? point?.usedCapitalCny),
      };
    })
    .filter((point) => point.equity !== null)
    .sort((left, right) => left.t - right.t);
}

function equityReturns(equity) {
  const values = [];
  for (let index = 1; index < equity.length; index += 1) {
    const previous = equity[index - 1].equity;
    const current = equity[index].equity;
    if (previous !== 0) values.push(current / previous - 1);
  }
  return values;
}

function inferPeriodsPerYear(equity, fallback = 252) {
  if (equity.length < 2 || !Number.isFinite(equity[0].t) || !Number.isFinite(equity.at(-1).t)) return fallback;
  const span = equity.at(-1).t - equity[0].t;
  return span > 0 ? Math.max(1, (equity.length - 1) * YEAR_MS / span) : fallback;
}

function drawdownStats(equity) {
  if (!equity.length) return { maxDrawdownCny: null, maxDrawdownPct: null, maxDrawdownDurationMs: null };
  let peak = equity[0].equity;
  let peakAt = equity[0].t;
  let maxCny = 0;
  let maxPct = 0;
  let maxDuration = 0;
  for (const point of equity) {
    if (point.equity >= peak) {
      peak = point.equity;
      peakAt = point.t;
      continue;
    }
    const amount = peak - point.equity;
    const ratio = peak > 0 ? amount / peak : 0;
    if (amount > maxCny) maxCny = amount;
    if (ratio > maxPct) maxPct = ratio;
    if (Number.isFinite(point.t) && Number.isFinite(peakAt)) maxDuration = Math.max(maxDuration, point.t - peakAt);
  }
  return { maxDrawdownCny: round(maxCny), maxDrawdownPct: round(maxPct), maxDrawdownDurationMs: maxDuration };
}

function fillNotional(fill) {
  const explicit = finite(fill?.grossCny ?? fill?.notionalCny);
  if (explicit !== null) return Math.abs(explicit);
  const price = finite(fill?.fillPrice ?? fill?.price);
  const quantity = finite(fill?.grams ?? fill?.quantity ?? fill?.size);
  return price !== null && quantity !== null ? Math.abs(price * quantity) : 0;
}

function fillFee(fill) {
  return finite(fill?.explicitFeeCny ?? fill?.feeCny ?? fill?.feesCny ?? fill?.costs?.feeCny
    ?? fill?.accounting?.explicitFeeCny ?? fill?.accounting?.feeCny) ?? 0;
}

function fillSlippage(fill) {
  const explicit = finite(fill?.slippageCny ?? fill?.costs?.slippageCny ?? fill?.accounting?.slippageCny);
  if (explicit !== null) return Math.abs(explicit);
  const price = finite(fill?.fillPrice ?? fill?.price);
  const reference = finite(fill?.referencePrice ?? fill?.decisionPrice ?? fill?.limitPrice);
  const quantity = finite(fill?.grams ?? fill?.quantity ?? fill?.size);
  return price !== null && reference !== null && quantity !== null ? Math.abs(price - reference) * Math.abs(quantity) : 0;
}

function fillSpread(fill) {
  const explicit = finite(fill?.quotedSpreadCny ?? fill?.costs?.quotedSpreadCny ?? fill?.accounting?.quotedSpreadCny);
  if (explicit !== null) return Math.abs(explicit);
  const ask = finite(fill?.ask ?? fill?.quote?.ask ?? fill?.accounting?.quote?.ask);
  const bid = finite(fill?.bid ?? fill?.quote?.bid ?? fill?.accounting?.quote?.bid);
  const perGram = finite(fill?.quotedSpreadPerGram ?? fill?.accounting?.components?.quotedSpreadPerGram);
  const quantity = finite(fill?.grams ?? fill?.quantity ?? fill?.size);
  if (perGram !== null && quantity !== null) return Math.max(0, perGram) * Math.abs(quantity);
  return ask !== null && bid !== null && quantity !== null ? Math.max(0, ask - bid) * Math.abs(quantity) : null;
}

function realizedPnl(fill) {
  return finite(fill?.realizedPnlCny ?? fill?.netPnlCny ?? fill?.pnlCny);
}

function grossPnl(simulation, net, fees, slippage, spread) {
  const direct = finite(simulation?.grossPnlCny ?? simulation?.summary?.grossPnlCny);
  if (direct !== null) return direct;
  return net === null ? null : net + fees + slippage + (spread ?? 0);
}

function netPnl(simulation, equity) {
  if (Object.hasOwn(simulation ?? {}, "netPnlCny")) return finite(simulation.netPnlCny);
  const direct = finite(simulation?.totalNetCny ?? simulation?.summary?.netPnlCny ?? simulation?.portfolio?.totalNetCny);
  if (direct !== null) return direct;
  return equity.length > 1 ? equity.at(-1).equity - equity[0].equity : 0;
}

/**
 * Supported input: simulation may expose frames, fills, ledger/trades, equity/equityCurve,
 * initialCapitalCny, activeExposureMs/totalDurationMs, and cost verification metadata.
 */
export function computeReplayMetrics(simulation = {}, options = {}) {
  const fills = Array.isArray(simulation.fills) ? simulation.fills : Array.isArray(simulation.trades) ? simulation.trades : [];
  const equity = normalizeEquity(simulation);
  const valuationComplete = simulation?.valuationComplete !== false;
  const metricEquity = valuationComplete ? equity : [];
  const returns = valuationComplete
    ? Array.isArray(simulation.returns)
      ? simulation.returns.map(finite).filter((value) => value !== null)
      : equityReturns(equity)
    : [];
  const explicitFeesCny = fills.reduce((sum, fill) => sum + fillFee(fill), 0);
  const slippageCny = fills.reduce((sum, fill) => sum + fillSlippage(fill), 0);
  const spreads = fills.map(fillSpread);
  const knownSpreads = spreads.filter((value) => value !== null);
  const quotedSpreadCny = knownSpreads.length === fills.length ? knownSpreads.reduce((sum, value) => sum + value, 0) : null;
  const net = netPnl(simulation, equity);
  const gross = grossPnl(simulation, net, explicitFeesCny, slippageCny, quotedSpreadCny);
  const initialCapital = finite(simulation.initialCapitalCny ?? simulation.initialCapital ?? equity[0]?.equity);
  const endingCapital = !valuationComplete ? null
    : Object.hasOwn(simulation, "endingCapitalCny")
      ? finite(simulation.endingCapitalCny)
      : finite(equity.at(-1)?.equity);
  const totalReturn = initialCapital !== null && initialCapital !== 0 && endingCapital !== null
    ? endingCapital / initialCapital - 1
    : initialCapital !== null && initialCapital !== 0 && net !== null ? net / initialCapital : null;
  const periodsPerYear = finite(options.periodsPerYear ?? simulation.periodsPerYear) ?? inferPeriodsPerYear(metricEquity);
  const averageReturn = mean(returns);
  const deviation = sampleDeviation(returns);
  const downside = returns.filter((value) => value < 0);
  const downsideDeviation = downside.length ? Math.sqrt(downside.reduce((sum, value) => sum + value ** 2, 0) / downside.length) : null;
  const sharpe = deviation && deviation > 0 ? averageReturn / deviation * Math.sqrt(periodsPerYear) : null;
  const sortino = downsideDeviation && downsideDeviation > 0 ? averageReturn / downsideDeviation * Math.sqrt(periodsPerYear) : null;
  const drawdown = drawdownStats(metricEquity);
  const elapsedMs = metricEquity.length > 1
    ? metricEquity.at(-1).t - metricEquity[0].t
    : valuationComplete ? finite(simulation.totalDurationMs) : null;
  let annualizedReturn = null;
  if (totalReturn !== null && totalReturn > -1 && elapsedMs > 0) annualizedReturn = (1 + totalReturn) ** (YEAR_MS / elapsedMs) - 1;
  const calmar = annualizedReturn !== null && drawdown.maxDrawdownPct > 0 ? annualizedReturn / drawdown.maxDrawdownPct : null;
  const totalDurationMs = finite(simulation.totalDurationMs) ?? (elapsedMs > 0 ? elapsedMs : null);
  const activeExposureMs = finite(simulation.activeExposureMs ?? simulation.exposureDurationMs);
  const exposureFromCurve = metricEquity.length
    ? metricEquity.filter((point) => (point.exposureCny ?? 0) !== 0).length / metricEquity.length : null;
  const exposureRatio = totalDurationMs > 0 && activeExposureMs !== null ? activeExposureMs / totalDurationMs : exposureFromCurve;
  const utilizationValues = metricEquity
    .map((point) => point.capitalUsedCny ?? point.exposureCny)
    .filter((value) => value !== null && initialCapital > 0)
    .map((value) => Math.abs(value) / initialCapital);
  const capitalUtilization = finite(simulation.capitalUtilization) ?? mean(utilizationValues);
  const turnoverCny = fills.reduce((sum, fill) => sum + fillNotional(fill), 0);
  const turnover = initialCapital > 0 ? turnoverCny / initialCapital : null;
  const pnl = fills.map(realizedPnl).filter((value) => value !== null);
  const gains = pnl.filter((value) => value > 0).reduce((sum, value) => sum + value, 0);
  const losses = pnl.filter((value) => value < 0).reduce((sum, value) => sum + Math.abs(value), 0);
  const profitFactor = losses > 0 ? gains / losses : gains > 0 ? null : null;
  const wins = pnl.filter((value) => value > 0).length;
  const intervalSeed = options.seed ?? simulation.inputFingerprint ?? canonicalSha256({ returns, fills: fills.length });
  return {
    grossPnlCny: round(gross),
    netPnlCny: round(net),
    totalReturn: round(totalReturn),
    annualizedReturn: round(annualizedReturn),
    costs: {
      explicitFeesCny: round(explicitFeesCny),
      quotedSpreadCny: round(quotedSpreadCny),
      quotedSpreadKnown: fills.length > 0 && knownSpreads.length === fills.length,
      slippageCny: round(slippageCny),
      totalKnownCostsCny: round(explicitFeesCny + slippageCny + knownSpreads.reduce((sum, value) => sum + value, 0)),
    },
    maxDrawdownCny: drawdown.maxDrawdownCny,
    maxDrawdownPct: drawdown.maxDrawdownPct,
    maxDrawdownDurationMs: drawdown.maxDrawdownDurationMs,
    exposureRatio: round(exposureRatio),
    capitalUtilization: round(capitalUtilization),
    turnoverCny: round(turnoverCny),
    turnover: round(turnover),
    profitFactor: round(profitFactor),
    sharpe: round(sharpe),
    sortino: round(sortino),
    calmar: round(calmar),
    periodsPerYear: round(periodsPerYear),
    samples: { returns: returns.length, realizedTrades: pnl.length, fills: fills.length },
    winRate: pnl.length ? round(wins / pnl.length) : null,
    winRateInterval: wilson95Interval(wins, pnl.length),
    returnInterval: movingBlockBootstrapInterval(returns, {
      seed: intervalSeed,
      iterations: options.bootstrapIterations,
      blockLength: options.blockLength,
    }),
  };
}

export async function computeReplayMetricsAsync(simulation = {}, options = {}) {
  throwIfAborted(options.signal);
  const metrics = computeReplayMetrics(simulation, { ...options, bootstrapIterations: 1 });
  const equity = normalizeEquity(simulation);
  const returns = Array.isArray(simulation.returns)
    ? simulation.returns.map(finite).filter((value) => value !== null)
    : equityReturns(equity);
  const intervalSeed = options.seed ?? simulation.inputFingerprint
    ?? canonicalSha256({ returns, fills: Array.isArray(simulation.fills) ? simulation.fills.length : 0 });
  metrics.returnInterval = await movingBlockBootstrapIntervalAsync(returns, {
    seed: intervalSeed,
    iterations: options.bootstrapIterations,
    blockLength: options.blockLength,
    chunkSize: options.chunkSize,
    signal: options.signal,
  });
  throwIfAborted(options.signal);
  return metrics;
}

function priceOf(frame, side = "mark", point = "close") {
  if (!frame || typeof frame !== "object") return null;
  const askPath = frame.execution?.ask ?? frame.execution?.askBar ?? frame.executionPath?.ask ?? frame.executionPath?.askBar;
  const bidPath = frame.execution?.bid ?? frame.execution?.bidBar ?? frame.executionPath?.bid ?? frame.executionPath?.bidBar;
  const open = point === "open";
  const candidates = side === "buy"
    ? open
      ? [frame.askO, askPath?.o, askPath?.open]
      : [frame.askC, frame.ask, frame.customerAsk, frame.customerBuy, askPath?.c, askPath?.close]
    : side === "sell"
      ? open
        ? [frame.bidO, bidPath?.o, bidPath?.open]
        : [frame.bidC, frame.bid, frame.customerBid, frame.customerSell, bidPath?.c, bidPath?.close]
      : [frame.c, frame.close, frame.price, frame.bidC, frame.bid, bidPath?.c, bidPath?.close, frame.askC, frame.ask, askPath?.c, askPath?.close];
  for (const value of candidates) {
    const number = finite(value);
    if (number !== null && number > 0) return number;
  }
  return null;
}

function normalizeFrames(input) {
  return (Array.isArray(input) ? input : [])
    .map((frame, index) => ({ ...frame, __t: isoTimestamp(frame?.t ?? frame?.time ?? frame?.timestamp) ?? index }))
    .filter((frame) => priceOf(frame) !== null)
    .sort((left, right) => left.__t - right.__t);
}

function benchmarkResult(id, frames, equity, trades, initialCapitalCny, diagnostics = [], options = {}) {
  const endingEquity = finite(equity.at(-1)?.equity);
  // Benchmark returns are measured across the supplied test frames only. The
  // initial capital remains the total-return baseline; adding a synthetic
  // pre-frame point would fabricate an extra return sample.
  const metricEquity = equity;
  const simulation = {
    equityCurve: metricEquity,
    fills: trades,
    initialCapitalCny,
    netPnlCny: endingEquity === null ? null : endingEquity - initialCapitalCny,
    valuationComplete: endingEquity !== null,
  };
  const metrics = computeReplayMetrics(simulation, {
    seed: `benchmark:${id}`,
    bootstrapIterations: options.bootstrapIterations ?? 500,
  });
  return {
    id,
    version: REPLAY_BENCHMARK_VERSION,
    status: diagnostics.length ? "partial" : "ok",
    metrics,
    trades,
    diagnostics,
    ...(options.includeComputationInputs === true ? { __simulation: simulation } : {}),
  };
}

function frameWithResolvedExecution(frame, execution) {
  if (!execution || typeof execution.path !== "function") return frame;
  const path = execution.path(frame, { benchmark: true });
  if (!path || typeof path !== "object" || typeof path.then === "function") {
    return { ...frame, execution: { available: false, askBar: null, bidBar: null }, askO: null, askC: null, bidO: null, bidC: null };
  }
  return {
    ...frame,
    execution: path,
    askO: path.askBar?.o ?? path.ask?.o ?? path.ask?.open ?? null,
    askC: path.askBar?.c ?? path.ask?.c ?? path.ask?.close ?? null,
    bidO: path.bidBar?.o ?? path.bid?.o ?? path.bid?.open ?? null,
    bidC: path.bidBar?.c ?? path.bid?.c ?? path.bid?.close ?? null,
    synthetic: path.synthetic === true,
    evidence: path.evidence ?? (path.realBidAsk === true ? "real" : "unknown"),
    quality: path.quality ?? null,
  };
}

function benchmarkQuote(frame, point = "close") {
  const ask = priceOf(frame, "buy", point);
  const bid = priceOf(frame, "sell", point);
  return {
    ask,
    bid,
    spreadPerGram: ask !== null && bid !== null ? Math.max(0, ask - bid) : null,
    synthetic: frame?.synthetic === true,
    evidence: frame?.evidence ?? frame?.executionEvidence?.mode ?? "unknown",
    quality: frame?.quality ?? null,
  };
}

function benchmarkAccount(execution, side, frame, quantity, options = {}) {
  const executionPoint = options.executionPoint === "open" ? "open" : "close";
  const quote = benchmarkQuote(frame, executionPoint);
  const price = side === "buy" ? quote.ask : quote.bid;
  if (!(price > 0) || !(quantity > 0)) return null;
  const request = { side, grams: quantity, fillPrice: price, quote };
  const accounted = execution && typeof execution.accountExecution === "function"
    ? execution.accountExecution(request)
    : {
        ok: true,
        ...request,
        grossCny: quantity * price,
        feeCny: 0,
        slippageCny: 0,
        cashFlowCny: side === "buy" ? -quantity * price : quantity * price,
      };
  if (!accounted || accounted.ok === false || !Number.isFinite(Number(accounted.cashFlowCny))) return null;
  return {
    side,
    t: new Date(frame.__t).toISOString(),
    quantity: round(quantity),
    grams: round(quantity),
    fillPrice: round(accounted.fillPrice ?? price),
    grossCny: round(accounted.grossCny ?? quantity * price),
    explicitFeeCny: round(accounted.feeCny ?? accounted.explicitFeeCny ?? 0),
    slippageCny: round(accounted.slippageCny ?? 0),
    quotedSpreadPerGram: round(quote.spreadPerGram),
    quotedSpreadCny: quote.spreadPerGram === null ? null : round(quote.spreadPerGram * quantity),
    cashFlowCny: round(Number(accounted.cashFlowCny)),
    accounting: structuredClone(accounted),
    benchmark: true,
    executionPoint,
    signalAt: options.signalAt === null || options.signalAt === undefined
      ? null : new Date(options.signalAt).toISOString(),
  };
}

function benchmarkLiquidation(execution, frame, quantity) {
  if (!(quantity > 0)) return 0;
  return benchmarkAccount(execution, "sell", frame, quantity)?.cashFlowCny ?? null;
}

function affordableQuantity(execution, frame, cash, options = {}) {
  const unit = benchmarkAccount(execution, "buy", frame, 1, options);
  const unitCost = unit ? Math.abs(unit.cashFlowCny) : null;
  return unitCost > 0 ? cash / unitCost : 0;
}

/** Four benchmarks execute on cloned frame paths and never receive or mutate the strategy ledger. */
export function projectReplayBenchmarks(input = {}, options = {}) {
  const sourceFrames = Array.isArray(input) ? input : input.frames;
  const execution = options.execution ?? input.execution ?? null;
  const frames = normalizeFrames(sourceFrames).map((frame) => frameWithResolvedExecution({ ...frame }, execution));
  const firstFrameAt = frames[0]?.__t ?? Number.POSITIVE_INFINITY;
  const warmupFrames = normalizeFrames(options.warmupFrames ?? input.warmupFrames ?? [])
    .filter((frame) => frame.__t < firstFrameAt).map((frame) => ({ ...frame }));
  const initialCapitalCny = finite(options.initialCapitalCny ?? input.initialCapitalCny) ?? 100_000;
  const interval = Math.max(1, Math.floor(finite(options.dcaIntervalFrames ?? input.dcaIntervalFrames) ?? 20));
  const contribution = Math.max(0, finite(options.dcaContributionCny ?? input.dcaContributionCny) ?? initialCapitalCny / Math.max(1, Math.ceil(frames.length / interval)));
  const shortWindow = Math.max(1, Math.floor(finite(options.smaShortWindow ?? input.smaShortWindow) ?? 20));
  const longWindow = Math.max(shortWindow + 1, Math.floor(finite(options.smaLongWindow ?? input.smaLongWindow) ?? 50));
  if (!frames.length) return Object.fromEntries(REPLAY_BENCHMARK_IDS.map((id) => [id, { id, version: REPLAY_BENCHMARK_VERSION, status: "unavailable", metrics: null, trades: [], diagnostics: ["no_executable_frames"] }]));

  const noTradeEquity = frames.map((frame) => ({ t: frame.__t, equity: initialCapitalCny, exposureCny: 0, capitalUsedCny: 0 }));
  const metricOptions = {
    bootstrapIterations: options.bootstrapIterations,
    includeComputationInputs: options.includeComputationInputs === true,
  };
  const noTrade = benchmarkResult("no_trade", frames, noTradeEquity, [], initialCapitalCny, [], metricOptions);

  const buyQuantity = affordableQuantity(execution, frames[0], initialCapitalCny, { executionPoint: "open" });
  const buyTrade = benchmarkAccount(execution, "buy", frames[0], buyQuantity, { executionPoint: "open" });
  const buyTrades = buyTrade ? [buyTrade] : [];
  const buyCash = buyTrade ? initialCapitalCny + buyTrade.cashFlowCny : initialCapitalCny;
  const buyDiagnostics = buyTrade ? [] : ["buy_execution_unavailable"];
  const buyEquity = frames.map((frame, index) => {
    const liquidation = benchmarkLiquidation(execution, frame, buyQuantity);
    if (buyTrade && liquidation === null) buyDiagnostics.push(`sell_mark_unavailable:${index}`);
    return {
      t: frame.__t,
      equity: liquidation === null ? null : buyCash + liquidation,
      exposureCny: liquidation,
      capitalUsedCny: buyTrade ? Math.abs(buyTrade.cashFlowCny) : 0,
    };
  });
  const buyHold = benchmarkResult("buy_and_hold", frames, buyEquity, buyTrades, initialCapitalCny, buyDiagnostics, metricOptions);

  let dcaCash = initialCapitalCny;
  let dcaQuantity = 0;
  let dcaUsed = 0;
  const dcaTrades = [];
  const dcaEquity = [];
  const dcaDiagnostics = [];
  for (let index = 0; index < frames.length; index += 1) {
    const frame = frames[index];
    if (index % interval === 0 && dcaCash > 0) {
      const amount = Math.min(contribution, dcaCash);
      const quantity = affordableQuantity(execution, frame, amount, { executionPoint: "open" });
      const executed = benchmarkAccount(execution, "buy", frame, quantity, { executionPoint: "open" });
      if (executed) {
        dcaCash += executed.cashFlowCny;
        dcaQuantity += quantity;
        dcaUsed += Math.abs(executed.cashFlowCny);
        dcaTrades.push(executed);
      } else {
        dcaDiagnostics.push(`buy_execution_unavailable:${index}`);
      }
    }
    const liquidation = benchmarkLiquidation(execution, frame, dcaQuantity);
    if (dcaQuantity > 0 && liquidation === null) dcaDiagnostics.push(`sell_mark_unavailable:${index}`);
    dcaEquity.push({
      t: frame.__t,
      equity: liquidation === null ? null : dcaCash + liquidation,
      exposureCny: liquidation,
      capitalUsedCny: dcaUsed,
    });
  }
  const dca = benchmarkResult("fixed_interval_dca", frames, dcaEquity, dcaTrades, initialCapitalCny, dcaDiagnostics, metricOptions);

  let smaCash = initialCapitalCny;
  let smaQuantity = 0;
  let smaCapitalUsed = 0;
  const smaTrades = [];
  const smaEquity = [];
  const smaDiagnostics = [];
  const closes = warmupFrames.map((frame) => priceOf(frame));
  let signalAt = warmupFrames.at(-1)?.__t ?? null;
  for (const [index, frame] of frames.entries()) {
    const short = closes.length >= shortWindow ? mean(closes.slice(-shortWindow)) : null;
    const long = closes.length >= longWindow ? mean(closes.slice(-longWindow)) : null;
    const shouldOwn = short !== null && long !== null && short > long;
    const executionOptions = { executionPoint: "open", signalAt };
    if (shouldOwn && smaQuantity === 0) {
      const quantity = affordableQuantity(execution, frame, smaCash, executionOptions);
      const executed = benchmarkAccount(execution, "buy", frame, quantity, executionOptions);
      if (executed) {
        smaCash += executed.cashFlowCny;
        smaQuantity = quantity;
        smaCapitalUsed = Math.abs(executed.cashFlowCny);
        smaTrades.push(executed);
      } else {
        smaDiagnostics.push(`buy_execution_unavailable:${index}`);
      }
    } else if (!shouldOwn && smaQuantity > 0) {
      const executed = benchmarkAccount(execution, "sell", frame, smaQuantity, executionOptions);
      if (executed) {
        smaCash += executed.cashFlowCny;
        smaTrades.push(executed);
        smaQuantity = 0;
        smaCapitalUsed = 0;
      } else {
        smaDiagnostics.push(`sell_execution_unavailable:${index}`);
      }
    }
    const liquidation = benchmarkLiquidation(execution, frame, smaQuantity);
    if (smaQuantity > 0 && liquidation === null) smaDiagnostics.push(`sell_mark_unavailable:${index}`);
    smaEquity.push({
      t: frame.__t,
      equity: liquidation === null ? null : smaCash + liquidation,
      exposureCny: liquidation,
      capitalUsedCny: smaCapitalUsed,
    });
    closes.push(priceOf(frame));
    if (closes.length > longWindow) closes.splice(0, closes.length - longWindow);
    signalAt = frame.__t;
  }
  const sma = benchmarkResult("simple_moving_average", frames, smaEquity, smaTrades, initialCapitalCny, smaDiagnostics, metricOptions);
  return { no_trade: noTrade, buy_and_hold: buyHold, fixed_interval_dca: dca, simple_moving_average: sma };
}

export async function projectReplayBenchmarksAsync(input = {}, options = {}) {
  throwIfAborted(options.signal);
  const projected = projectReplayBenchmarks(input, {
    ...options,
    bootstrapIterations: 1,
    includeComputationInputs: true,
  });
  for (const id of REPLAY_BENCHMARK_IDS) {
    throwIfAborted(options.signal);
    const benchmark = projected[id];
    if (!benchmark?.__simulation) continue;
    benchmark.metrics = await computeReplayMetricsAsync(benchmark.__simulation, {
      seed: `benchmark:${id}`,
      bootstrapIterations: options.bootstrapIterations ?? 500,
      chunkSize: options.chunkSize,
      signal: options.signal,
    });
    delete benchmark.__simulation;
  }
  throwIfAborted(options.signal);
  return projected;
}

export const runReplayBenchmarks = projectReplayBenchmarks;

function countBy(items, resolver, known = []) {
  const result = Object.fromEntries(known.map((key) => [key, 0]));
  for (const item of items) {
    const key = resolver(item) || "unknown";
    result[key] = (result[key] ?? 0) + 1;
  }
  return result;
}

export function groupReplayEvidence({ simulation = {}, dataset = {} } = {}) {
  const frames = Array.isArray(simulation.frames) ? simulation.frames : Array.isArray(dataset.frames) ? dataset.frames : [];
  const sessions = Array.isArray(simulation.sessions) ? simulation.sessions
    : Array.isArray(dataset.sessions) ? dataset.sessions
      : Array.isArray(dataset.sessions?.items) ? dataset.sessions.items : [];
  const fills = Array.isArray(simulation.fills) ? simulation.fills : [];
  const evidenceItems = frames.length ? frames : fills;
  return {
    lane: countBy(frames, (frame) => frame.lane ?? dataset.lane ?? simulation.lane, ["cmb", "au9999", "unknown"]),
    sessionCompleteness: countBy(sessions, (session) => session.status
      ?? (Number(session.partialBars) > 0 ? "partial"
        : Number(session.completeBars) > 0 ? "complete"
          : session.complete === true ? "complete" : session.complete === false ? "partial" : "unknown"), ["complete", "partial", "excluded", "unknown"]),
    executionEvidence: countBy(evidenceItems, (item) => item.evidence ?? item.executionEvidence?.mode ?? item.executionQuality ?? (item.realBidAsk === true ? "real" : item.synthetic === true ? "proxy" : "unknown"), ["real", "proxy", "synthetic", "unknown"]),
  };
}

function historyMonths(dataset) {
  const from = isoTimestamp(dataset?.from ?? dataset?.firstTimestamp ?? dataset?.window?.from ?? dataset?.dateRange?.from);
  const to = isoTimestamp(dataset?.to ?? dataset?.lastTimestamp ?? dataset?.window?.to ?? dataset?.dateRange?.to);
  return from !== null && to !== null && to >= from ? (to - from) / (YEAR_MS / 12) : 0;
}

function benchmarkComplete(benchmarks) {
  return REPLAY_BENCHMARK_IDS.every((id) => {
    const benchmark = benchmarks?.[id];
    const metrics = benchmark?.metrics;
    return benchmark?.status === "ok"
      && Array.isArray(benchmark.diagnostics) && benchmark.diagnostics.length === 0
      && metrics && typeof metrics === "object"
      && finite(metrics.netPnlCny) !== null
      && finite(metrics.totalReturn) !== null
      && finite(metrics.maxDrawdownCny) !== null
      && Number(metrics.samples?.returns) > 0;
  });
}

function intervalsComplete(metrics) {
  const returns = metrics?.returnInterval;
  const wins = metrics?.winRateInterval;
  return returns?.version === REPLAY_BOOTSTRAP_VERSION
    && returns?.confidence === 0.95
    && Number(returns?.sampleSize) >= 2
    && finite(returns?.lower) !== null && finite(returns?.upper) !== null
    && Number(returns.lower) <= Number(returns.upper)
    && wins?.confidence === 0.95
    && Number(wins?.trials) > 0
    && Number(wins?.successes) >= 0 && Number(wins.successes) <= Number(wins.trials)
    && finite(wins?.lower) !== null && finite(wins?.upper) !== null
    && Number(wins.lower) <= Number(wins.upper);
}

function monthDistance(fromMs, toMs) {
  const from = new Date(fromMs);
  const to = new Date(toMs);
  return (to.getUTCFullYear() - from.getUTCFullYear()) * 12 + to.getUTCMonth() - from.getUTCMonth();
}

function validFold(fold) {
  const parameterFingerprint = fold?.parameterFingerprint ?? fold?.paramsFingerprint;
  const trainFrom = isoTimestamp(fold?.train?.from);
  const trainTo = isoTimestamp(fold?.train?.toExclusive);
  const testFrom = isoTimestamp(fold?.test?.from);
  const testTo = isoTimestamp(fold?.test?.toExclusive);
  const warmup = fold?.warmup;
  const warmupFrames = Number(warmup?.frames);
  const warmupFrom = isoTimestamp(warmup?.from);
  const warmupTo = isoTimestamp(warmup?.to);
  const warmupValid = warmup?.policy === "point-in-time-history-only"
    && Number.isInteger(warmupFrames) && warmupFrames >= 0
    && /^[a-f0-9]{64}$/.test(String(warmup?.stateFingerprint ?? ""))
    && (warmupFrames === 0
      ? warmup?.from === null && warmup?.to === null
      : warmupFrom !== null && warmupTo !== null && warmupFrom <= warmupTo && warmupTo < testFrom);
  const monthStart = (value) => value !== null && new Date(value).toISOString().endsWith("-01T00:00:00.000Z");
  return fold?.status === "completed"
    && /^fold-[a-f0-9]{64}$/.test(String(fold?.foldId ?? ""))
    && fold.foldId === walkForwardFoldId(fold)
    && /^[a-f0-9]{64}$/.test(String(parameterFingerprint ?? ""))
    && /^[a-f0-9]{64}$/.test(String(fold?.simulationFingerprint ?? ""))
    && /^dataset-[a-f0-9]{64}$/.test(String(fold?.executionDatasetId ?? ""))
    && /^[a-f0-9]{64}$/.test(String(fold?.executionDatasetContentSha256 ?? ""))
    && /^[a-f0-9]{64}$/.test(String(fold?.factorFingerprint ?? ""))
    && /^[a-f0-9]{64}$/.test(String(fold?.resultFingerprint ?? ""))
    && fold.resultFingerprint === walkForwardFoldResultFingerprint(fold)
    && fold.parametersFrozen === true
    && Number(fold.sampleCount) >= WALK_FORWARD_DEFAULTS.minimumSessionsPerMonth
    && Number(fold.sampleCount) === Number(fold.test?.completeSessions)
    && warmupValid
    && trainFrom !== null && trainTo !== null && testFrom !== null && testTo !== null
    && trainTo === testFrom && trainFrom < trainTo && testFrom < testTo
    && monthStart(trainFrom) && monthStart(trainTo) && monthStart(testTo)
    && Number(fold.train?.months) === WALK_FORWARD_DEFAULTS.trainMonths
    && Number(fold.test?.months) === WALK_FORWARD_DEFAULTS.testMonths
    && Number(fold.train?.coveredMonths) === WALK_FORWARD_DEFAULTS.trainMonths
    && Number(fold.test?.coveredMonths) === WALK_FORWARD_DEFAULTS.testMonths
    && Number(fold.train?.qualifyingMonths) === WALK_FORWARD_DEFAULTS.trainMonths
    && Number(fold.test?.qualifyingMonths) === WALK_FORWARD_DEFAULTS.testMonths
    && Number(fold.train?.minimumSessionsPerMonth) >= WALK_FORWARD_DEFAULTS.minimumSessionsPerMonth
    && Number(fold.test?.minimumSessionsPerMonth) >= WALK_FORWARD_DEFAULTS.minimumSessionsPerMonth
    && monthDistance(trainFrom, trainTo) === WALK_FORWARD_DEFAULTS.trainMonths
    && monthDistance(testFrom, testTo) === WALK_FORWARD_DEFAULTS.testMonths
    && Array.isArray(fold.diagnostics) && fold.diagnostics.length === 0
    && benchmarkComplete(fold.benchmarks)
    && intervalsComplete(fold.metrics);
}

export function evaluateReplayValidationGate({ dataset = {}, oos = {}, simulation = {}, benchmarks = {}, metrics = null, groups = null, provenance = {} } = {}) {
  const registeredFolds = Array.isArray(oos.folds) ? oos.folds : [];
  const completedFolds = registeredFolds.filter((fold) => fold?.status === "completed");
  const frozenDeclaredFolds = completedFolds.filter((fold) => fold?.parametersFrozen === true
    && /^[a-f0-9]{64}$/.test(String(fold?.parameterFingerprint ?? fold?.paramsFingerprint ?? "")));
  const folds = registeredFolds.filter(validFold);
  const validDatasetManifest = (manifest) => manifest?.version === REPLAY_DATASET_VERSION
    && /^dataset-[a-f0-9]{64}$/.test(String(manifest?.datasetId ?? ""))
    && /^[a-f0-9]{64}$/.test(String(manifest?.contentSha256 ?? ""))
    && /^[a-f0-9]{64}$/.test(String(manifest?.inputFingerprint ?? ""));
  const datasetValid = validDatasetManifest(dataset);
  const executionDataset = provenance.executionDataset ?? dataset;
  const executionDatasetValid = validDatasetManifest(executionDataset);
  const grouped = groups ?? groupReplayEvidence({ simulation, dataset });
  const executionCounts = grouped.executionEvidence ?? {};
  const realCount = Number(executionCounts.real ?? 0);
  const totalEvidence = Object.values(executionCounts).reduce((sum, value) => sum + (Number(value) || 0), 0);
  const manifestCoverage = finite(executionDataset?.realBidAskCoverage
    ?? executionDataset?.executionCoverage?.realBidAskCoverage);
  const alignedCoverage = finite(executionDataset?.alignment?.coverage);
  const realBidAskCoverage = executionDatasetValid && manifestCoverage !== null
    ? manifestCoverage
    : totalEvidence > 0 ? realCount / totalEvidence : 0;
  const costVerification = provenance.costVerification ?? simulation.costVerification;
  const costsVerified = costVerification?.status === "verified"
    && typeof costVerification.source === "string" && costVerification.source.length > 0
    && typeof costVerification.version === "string" && costVerification.version.length > 0;
  const incompleteSessions = Math.max(0, Number(simulation.incompleteSessions) || 0);
  // Rejected raw lines are operational diagnostics and may be discovered after
  // a historical as-of. Quarantined selected partitions affect usable content;
  // rejected lines outside the selected dataset do not rewrite past evidence.
  const datasetIntegrity = Number(dataset?.quarantinedPartitions ?? 0) === 0
    && Number(executionDataset?.quarantinedPartitions ?? 0) === 0;
  const completeSessions = (manifest) => manifest?.sessions?.coverageKnown === true
    && Number(manifest.sessions.total) > 0
    && Number(manifest.sessions.complete) === Number(manifest.sessions.total);
  const sessionCoverageComplete = completeSessions(dataset) && completeSessions(executionDataset);
  const pointInTimeManifest = (manifest) => manifest?.pointInTimePolicy === "known-by-bar-close"
    && Number.isInteger(manifest?.records?.missingIngestedAtBars)
    && manifest.records.missingIngestedAtBars === 0;
  const pointInTimeIngestion = pointInTimeManifest(dataset) && pointInTimeManifest(executionDataset);
  const executionAlignmentComplete = alignedCoverage === null
    ? provenance.executionDataset === undefined
    : alignedCoverage === 1;
  const expectedRegistryResultFingerprint = canonicalSha256({
    registryId: oos?.registryId ?? null,
    folds: registeredFolds.map((fold) => ({
      foldId: fold?.foldId ?? null,
      status: fold?.status ?? null,
      resultFingerprint: fold?.resultFingerprint ?? null,
    })),
  });
  const completedByWindow = completedFolds.slice().sort((left, right) =>
    isoTimestamp(left?.test?.from) - isoTimestamp(right?.test?.from));
  const foldIdsUnique = new Set(completedFolds.map((fold) => fold?.foldId)).size === completedFolds.length;
  const foldWindowsUnique = new Set(completedFolds.map((fold) =>
    `${fold?.test?.from ?? ""}|${fold?.test?.toExclusive ?? ""}`)).size === completedFolds.length;
  const foldCadenceValid = completedByWindow.every((fold, index) => index === 0
    || monthDistance(isoTimestamp(completedByWindow[index - 1].test.from), isoTimestamp(fold.test.from)) === 1);
  const foldBasisValid = completedFolds.every((fold) => fold?.datasetId === dataset?.datasetId
    && fold?.datasetContentSha256 === dataset?.contentSha256
    && fold?.executionDatasetId === executionDataset?.datasetId
    && fold?.executionDatasetContentSha256 === executionDataset?.contentSha256
    && fold?.factorFingerprint === provenance?.factorFingerprint);
  const parameterPrecommitVerified = completedFolds.length > 0
    && completedFolds.every((fold) => fold?.parameterPrecommit?.verified === true
      && isoTimestamp(fold.parameterPrecommit.committedAt) !== null
      && isoTimestamp(fold.parameterPrecommit.committedAt) <= isoTimestamp(fold.test?.from));
  const registryValid = oos?.version === WALK_FORWARD_REGISTRY_VERSION
    && /^walk-forward-[a-f0-9]{64}$/.test(String(oos?.registryId ?? ""))
    && oos?.datasetId === dataset?.datasetId
    && foldIdsUnique && foldWindowsUnique && foldCadenceValid && foldBasisValid
    && oos?.resultFingerprint === expectedRegistryResultFingerprint;
  const simulatorDiagnostics = simulation?.diagnostics ?? {};
  const simulationDiagnosticsClean = Number(simulatorDiagnostics.conflictingDuplicates ?? 0) === 0
    && Number(simulatorDiagnostics.invalidFramesIgnored ?? 0) === 0
    && Number(simulatorDiagnostics.futureFramesIgnored ?? 0) === 0
    && Number(simulatorDiagnostics.unknownExecutionPaths ?? 0) === 0
    && Number(simulatorDiagnostics.executionRejected ?? 0) === 0
    && Number(simulatorDiagnostics.invalidDecisions ?? 0) === 0
    && Number(simulatorDiagnostics.unresolvedProtectiveBrackets ?? 0) === 0
    && Number(simulatorDiagnostics.unresolvedEntryAmbiguities ?? 0) === 0
    && Number(simulatorDiagnostics.replayDayFailures ?? 0) === 0
    && Number(simulatorDiagnostics.daysSkippedNoData ?? 0) === 0;
  const observed = {
    historyMonths: round(historyMonths(dataset)),
    datasetValid,
    executionDatasetValid,
    datasetIntegrity,
    sessionCoverageComplete,
    pointInTimeIngestion,
    executionAlignmentComplete,
    registryValid,
    parameterPrecommitVerified,
    registeredOosFolds: registeredFolds.length,
    oosFolds: folds.length,
    frozenOosFolds: frozenDeclaredFolds.length,
    oosFoldsWithIntervals: folds.length,
    realBidAskCoverage: round(realBidAskCoverage),
    incompleteSessions,
    valuationComplete: simulation?.valuationComplete !== false,
    simulationDiagnosticsClean,
    costsVerified,
    benchmarksComplete: benchmarkComplete(benchmarks),
    intervalsComplete: intervalsComplete(metrics)
      && folds.length >= REPLAY_VALIDATION_REQUIREMENTS.minimumOosFolds,
  };
  const unmet = [];
  if (!observed.datasetValid || !observed.executionDatasetValid) unmet.push("dataset_manifest");
  if (!observed.datasetIntegrity) unmet.push("dataset_integrity");
  if (!observed.executionAlignmentComplete) unmet.push("execution_alignment");
  if (!observed.sessionCoverageComplete) unmet.push("session_coverage");
  if (!observed.pointInTimeIngestion) unmet.push("point_in_time_ingestion");
  if (observed.historyMonths < REPLAY_VALIDATION_REQUIREMENTS.minimumHistoryMonths) unmet.push("minimum_history_months");
  if (!observed.registryValid) unmet.push("oos_registry");
  if (!observed.parameterPrecommitVerified) unmet.push("historical_parameter_precommit");
  if (observed.oosFolds < REPLAY_VALIDATION_REQUIREMENTS.minimumOosFolds) unmet.push("multiple_oos_folds");
  if (frozenDeclaredFolds.length !== completedFolds.length) unmet.push("frozen_oos_parameters");
  if (observed.oosFolds !== completedFolds.length) unmet.push("oos_fold_integrity");
  if (observed.realBidAskCoverage !== 1) unmet.push("real_bid_ask_evidence");
  if (observed.incompleteSessions > 0) unmet.push("incomplete_sessions");
  if (!observed.valuationComplete) unmet.push("valuation_incomplete");
  if (!observed.simulationDiagnosticsClean) unmet.push("simulation_diagnostics");
  if (!observed.costsVerified) unmet.push("verified_cost_semantics");
  if (!observed.benchmarksComplete) unmet.push("benchmark_comparison");
  if (!observed.intervalsComplete) unmet.push("uncertainty_intervals");
  return {
    status: unmet.length ? "not_eligible" : "eligible",
    eligible: unmet.length === 0,
    unmet,
    requirements: { ...REPLAY_VALIDATION_REQUIREMENTS },
    observed,
  };
}

function reportFingerprint(report) {
  return createHash("sha256")
    .update(canonicalize(report, new Set(), (key, _entry, parent) => {
      if (OMIT_FROM_REPORT_FINGERPRINT.has(key)) return false;
      if (key === "storeContentSha256") return false;
      if (key === "rejectedRecords" && parent?.version === REPLAY_DATASET_VERSION) return false;
      if (key === "rejected" && parent?.tradingDay !== undefined && parent?.contentSha256 !== undefined) return false;
      return true;
    }))
    .digest("hex");
}

function replayProjectionContext(input) {
  const simulation = input.simulation && typeof input.simulation === "object" ? input.simulation : {};
  const dataset = input.dataset && typeof input.dataset === "object" ? input.dataset : {};
  const oos = input.oos && typeof input.oos === "object" ? input.oos : { folds: [] };
  const provenance = input.provenance && typeof input.provenance === "object" ? input.provenance : {};
  const compatibility = input.compatibility && typeof input.compatibility === "object" ? input.compatibility : {};
  const frames = simulation.frames ?? dataset.frames ?? [];
  // Per-frame traces are operational detail; orders/fills/state identities bind semantics.
  const { evaluations: _evaluations, ...semanticSimulation } = simulation;
  const semanticInput = {
    simulation: semanticSimulation,
    dataset: semanticDataset(dataset),
    oos,
    provenance,
    benchmarkOptions: input.benchmarkOptions ?? null,
    benchmarkExecution: {
      version: input.execution?.executionVersion ?? null,
      accountExecution: typeof input.execution?.accountExecution === "function"
        ? canonicalSha256(Function.prototype.toString.call(input.execution.accountExecution))
        : null,
    },
  };
  return { simulation, dataset, oos, provenance, compatibility, frames, inputFingerprint: canonicalSha256(semanticInput) };
}

/**
 * Project a v6 report. Large detail arrays remain under `detail`; stores may persist
 * that object separately while list views use the rest of the report as summary.
 */
export function projectReplayReport(input = {}, computed = {}) {
  const { simulation, dataset, oos, provenance, compatibility, frames, inputFingerprint } = replayProjectionContext(input);
  const metrics = computed.metrics ?? computeReplayMetrics(simulation, { seed: inputFingerprint, ...(input.intervalOptions ?? {}) });
  // Benchmarks are always projected from the same frames/execution adapter.
  // Caller-supplied summaries cannot promote the validation gate.
  const benchmarks = computed.benchmarks ?? projectReplayBenchmarks(
    { frames, initialCapitalCny: simulation.initialCapitalCny, execution: input.execution },
    { ...(input.benchmarkOptions ?? {}), execution: input.execution },
  );
  const groups = groupReplayEvidence({ simulation, dataset });
  const validationGate = evaluateReplayValidationGate({ dataset, oos, simulation, benchmarks, metrics, groups, provenance });
  const generatedAtMs = isoTimestamp(input.generatedAt ?? Date.now());
  if (generatedAtMs === null) throw new TypeError("generatedAt must be a valid timestamp");
  const asOfValue = input.asOf ?? dataset.asOf ?? simulation.asOf ?? null;
  const asOfMs = isoTimestamp(asOfValue);
  const report = {
    ...structuredClone(compatibility),
    version: REPLAY_REPORT_VERSION,
    reportSchemaVersion: REPLAY_REPORT_SCHEMA_VERSION,
    reportSchema: REPLAY_REPORT_SCHEMA,
    reportCalculationVersion: REPLAY_REPORT_CALCULATION_VERSION,
    calculationVersion: compatibility.calculationVersion ?? provenance.calculationVersion ?? null,
    generatedAt: new Date(generatedAtMs).toISOString(),
    reportId: input.reportId ?? null,
    asOf: asOfMs === null ? null : new Date(asOfMs).toISOString(),
    inputFingerprint,
    evidenceStatus: validationGate.eligible ? REPLAY_EVIDENCE_STATUSES.VALIDATED : REPLAY_EVIDENCE_STATUSES.EXPLORATORY,
    dataset: structuredClone(dataset),
    dataVersion: dataset.datasetFingerprint ?? dataset.fingerprint ?? dataset.dataVersion
      ?? dataset.inputFingerprint ?? dataset.contentSha256 ?? null,
    simulation: {
      simulatorVersion: simulation.simulatorVersion ?? null,
      inputFingerprint: simulation.inputFingerprint ?? null,
      policy: structuredClone(simulation.policy ?? {}),
      diagnostics: structuredClone(simulation.diagnostics ?? {}),
      strategyFacts: structuredClone(simulation.strategyFacts ?? {}),
      evaluationAudit: structuredClone(Array.isArray(simulation.evaluationAudit) ? simulation.evaluationAudit : []),
      evaluationTracesDropped: Math.max(0,
        Number(simulation.evaluationTracesDropped ?? simulation.diagnostics?.evaluationTracesDropped) || 0),
      incompleteSessions: Math.max(0, Number(simulation.incompleteSessions) || 0),
      valuationComplete: simulation.valuationComplete !== false,
      costsVerified: simulation.costsVerified === true,
      costSemanticsVerified: simulation.costSemanticsVerified === true,
      counts: {
        frames: Array.isArray(frames) ? frames.length : 0,
        events: Array.isArray(simulation.events) ? simulation.events.length : 0,
        orders: Array.isArray(simulation.orders) ? simulation.orders.length : 0,
        fills: Array.isArray(simulation.fills) ? simulation.fills.length : 0,
        ledger: Array.isArray(simulation.ledger) ? simulation.ledger.length : 0,
        unexecuted: Array.isArray(simulation.unexecuted ?? simulation.unexecutedSignals)
          ? (simulation.unexecuted ?? simulation.unexecutedSignals).length
          : 0,
      },
    },
    metrics,
    oos: structuredClone(oos),
    benchmarks,
    groups,
    validationGate,
    provenance: structuredClone(provenance),
  };
  if (input.includeDetail === true) {
    report.detail = structuredClone(input.detail ?? {
      events: simulation.events ?? [],
      orders: simulation.orders ?? [],
      fills: simulation.fills ?? [],
      ledger: simulation.ledger ?? [],
      unexecuted: simulation.unexecuted ?? simulation.unexecutedSignals ?? [],
    });
  }
  report.reportFingerprint = reportFingerprint(report);
  if (!report.reportId) report.reportId = `replay-${report.reportFingerprint.slice(0, 24)}`;
  return report;
}

/** Cooperative report projection used by long-running replay/experiment routes. */
export async function projectReplayReportAsync(input = {}, options = {}) {
  const signal = options.signal ?? null;
  const context = replayProjectionContext(input);
  throwIfAborted(signal);
  const metrics = await computeReplayMetricsAsync(context.simulation, {
    seed: context.inputFingerprint,
    ...(input.intervalOptions ?? {}),
    signal,
  });
  const benchmarkKey = options.benchmarkCacheKey ?? canonicalSha256({
    frames: context.frames,
    initialCapitalCny: context.simulation.initialCapitalCny ?? null,
    benchmarkOptions: input.benchmarkOptions ?? null,
    executionVersion: input.execution?.executionVersion ?? null,
    accountExecution: typeof input.execution?.accountExecution === "function"
      ? Function.prototype.toString.call(input.execution.accountExecution) : null,
  });
  let benchmarks = options.benchmarkCache instanceof Map ? options.benchmarkCache.get(benchmarkKey) : null;
  if (benchmarks) {
    benchmarks = structuredClone(benchmarks);
  } else {
    benchmarks = await projectReplayBenchmarksAsync(
      { frames: context.frames, initialCapitalCny: context.simulation.initialCapitalCny, execution: input.execution },
      { ...(input.benchmarkOptions ?? {}), execution: input.execution, signal },
    );
    if (options.benchmarkCache instanceof Map) options.benchmarkCache.set(benchmarkKey, structuredClone(benchmarks));
  }
  throwIfAborted(signal);
  return projectReplayReport(input, { metrics, benchmarks });
}

export function replayReportFingerprint(report) {
  return reportFingerprint(report);
}

/** Validate one cold/wire v6 report before it may be indexed or rendered. */
export function validateReplayReport(input) {
  if (!input || typeof input !== "object" || Array.isArray(input)) throw new TypeError("invalid replay report: object required");
  const report = structuredClone(input);
  if (report.version !== REPLAY_REPORT_VERSION || report.reportSchemaVersion !== REPLAY_REPORT_SCHEMA_VERSION
    || report.reportSchema !== REPLAY_REPORT_SCHEMA || report.reportCalculationVersion !== REPLAY_REPORT_CALCULATION_VERSION) {
    throw new TypeError("invalid replay report: schema/version mismatch");
  }
  if (isoTimestamp(report.generatedAt) === null || isoTimestamp(report.asOf) === null) {
    throw new TypeError("invalid replay report: timestamps are invalid");
  }
  if (!/^[a-f0-9]{64}$/.test(String(report.inputFingerprint ?? ""))
    || !/^[a-f0-9]{64}$/.test(String(report.reportFingerprint ?? ""))
    || report.reportFingerprint !== reportFingerprint(report)
    || report.reportId !== `replay-${report.reportFingerprint.slice(0, 24)}`) {
    throw new TypeError("invalid replay report: fingerprint or id mismatch");
  }
  if (!report.dataset || !report.oos || !report.simulation || !report.metrics || !report.benchmarks
    || !report.groups || !report.validationGate || !report.provenance) {
    throw new TypeError("invalid replay report: evidence sections are missing");
  }
  const expectedGate = evaluateReplayValidationGate({
    dataset: report.dataset,
    oos: report.oos,
    simulation: report.simulation,
    benchmarks: report.benchmarks,
    metrics: report.metrics,
    groups: report.groups,
    provenance: report.provenance,
  });
  if (canonicalSha256(expectedGate) !== canonicalSha256(report.validationGate)
    || report.evidenceStatus !== (expectedGate.eligible ? REPLAY_EVIDENCE_STATUSES.VALIDATED : REPLAY_EVIDENCE_STATUSES.EXPLORATORY)) {
    throw new TypeError("invalid replay report: validation gate mismatch");
  }
  return report;
}
