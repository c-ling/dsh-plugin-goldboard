/**
 * Executable-price and accounting semantics shared by live plans, snapshots,
 * and replay. Quotes are always expressed from the customer's perspective:
 * ask is the price paid to buy, bid is the price received before explicit
 * fees/slippage when selling.
 */

import { round2 } from "./shared.js";

export const EXECUTION_MODEL_VERSION = "goldboard-execution-v2";
export const EXECUTION_EVIDENCE = Object.freeze({
  REAL: "real",
  SYNTHETIC: "synthetic",
  PROXY: "proxy",
  UNKNOWN: "unknown",
});
export const EXECUTION_QUOTE_UNAVAILABLE = "execution_quote_unavailable";
export const EXECUTION_BID_UNAVAILABLE = "execution_bid_unavailable";
export const EXECUTION_ASK_UNAVAILABLE = "execution_ask_unavailable";
export const EXECUTION_QUOTE_INVERTED = "execution_quote_inverted";

function positive(value) {
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? number : null;
}

function nonNegative(value) {
  const number = Number(value);
  return Number.isFinite(number) && number >= 0 ? number : 0;
}

function sideCosts(config, side) {
  return {
    explicitFeePerGram: nonNegative(side === "buy" ? config?.fee?.buyPerGram : config?.fee?.sellPerGram),
    slippagePerGram: nonNegative(config?.strategy?.slippagePerGram),
  };
}

function unavailable(reasonCode = EXECUTION_QUOTE_UNAVAILABLE) {
  return {
    available: false,
    bid: null,
    ask: null,
    synthetic: true,
    realBidAsk: false,
    evidence: EXECUTION_EVIDENCE.UNKNOWN,
    quality: "unavailable",
    reasonCode,
    components: {},
    assumptions: [],
    executionVersion: EXECUTION_MODEL_VERSION,
  };
}

/**
 * Normalize either a real CMB customer quote or a reference-price fallback.
 * `estimatedSpreadPerGram` is only applied to a synthetic quote, where it
 * establishes a minimum ask/bid distance instead of becoming a second fee.
 */
export function resolveExecutionQuote(input = {}, config = {}) {
  const quote = input.quote && typeof input.quote === "object" ? input.quote : null;
  const liveAsk = positive(quote?.customerBuy ?? quote?.buyPrice ?? quote?.ask);
  const liveBid = positive(quote?.customerSell ?? quote?.sellPrice ?? quote?.bid);
  if (liveAsk !== null && liveBid !== null) {
    if (liveAsk < liveBid) return unavailable(EXECUTION_QUOTE_INVERTED);
    const ask = round2(liveAsk);
    const bid = round2(liveBid);
    const declaredEvidence = Object.values(EXECUTION_EVIDENCE).includes(quote?.executionEvidence?.mode)
      ? quote.executionEvidence.mode
      : null;
    const evidence = declaredEvidence ?? (quote?.synthetic === true ? EXECUTION_EVIDENCE.SYNTHETIC : EXECUTION_EVIDENCE.REAL);
    const synthetic = evidence !== EXECUTION_EVIDENCE.REAL;
    return {
      available: true,
      bid,
      ask,
      spreadPerGram: round2(ask - bid),
      synthetic,
      realBidAsk: evidence === EXECUTION_EVIDENCE.REAL,
      evidence,
      quality: quote?.quality ?? (synthetic ? "synthetic" : "primary"),
      source: quote?.source ?? input.source ?? "cmb",
      asOf: input.asOf ?? quote?.receivedAt ?? null,
      components: {
        pricing: synthetic ? "provided-synthetic-bid-ask" : "live-bid-ask",
        quotedSpreadPerGram: round2(ask - bid),
        estimatedSpreadAppliedPerGram: 0,
      },
      assumptions: Array.isArray(quote?.assumptions)
        ? quote.assumptions.slice()
        : synthetic ? ["provided-synthetic-bid-ask"] : [],
      executionVersion: EXECUTION_MODEL_VERSION,
    };
  }
  if (quote && (liveAsk !== null || liveBid !== null)) {
    return {
      ...unavailable(liveAsk === null ? EXECUTION_ASK_UNAVAILABLE : EXECUTION_BID_UNAVAILABLE),
      ask: liveAsk === null ? null : round2(liveAsk),
      bid: liveBid === null ? null : round2(liveBid),
      source: quote.source ?? input.source ?? "cmb",
      asOf: input.asOf ?? quote.receivedAt ?? null,
    };
  }

  const referencePrice = positive(input.referencePrice);
  if (referencePrice === null) return unavailable();
  const buyOffset = Number.isFinite(Number(input.buyOffset)) ? Number(input.buyOffset) : 0;
  const sellOffset = Number.isFinite(Number(input.sellOffset)) ? Number(input.sellOffset) : 0;
  const estimatedSpread = nonNegative(config?.strategy?.estimatedSpreadPerGram);
  const askRaw = referencePrice + buyOffset;
  const bidBeforeSpread = referencePrice + sellOffset;
  const bidRaw = Math.min(bidBeforeSpread, askRaw - estimatedSpread);
  if (!(askRaw > 0) || !(bidRaw > 0)) return unavailable();
  const ask = round2(askRaw);
  const bid = round2(bidRaw);
  return {
    available: true,
    bid,
    ask,
    spreadPerGram: round2(ask - bid),
    synthetic: true,
    realBidAsk: false,
    evidence: EXECUTION_EVIDENCE.SYNTHETIC,
    quality: "synthetic",
    source: input.source ?? "reference-fallback",
    asOf: input.asOf ?? null,
    components: {
      pricing: "reference-offsets",
      referencePrice: round2(referencePrice),
      buyOffsetPerGram: round2(buyOffset),
      sellOffsetPerGram: round2(sellOffset),
      estimatedSpreadAppliedPerGram: round2(Math.max(0, bidBeforeSpread - bidRaw)),
      quotedSpreadPerGram: round2(ask - bid),
    },
    assumptions: [input.assumptionSource ?? "configured-reference-offsets", "estimated-spread-floor"],
    executionVersion: EXECUTION_MODEL_VERSION,
  };
}

function sideBar(bar, prefix) {
  const result = {
    o: positive(bar?.[`${prefix}O`]),
    h: positive(bar?.[`${prefix}H`]),
    l: positive(bar?.[`${prefix}L`]),
    c: positive(bar?.[`${prefix}C`]),
  };
  return Object.values(result).every((value) => value !== null) ? result : null;
}

function shiftBar(bar, offset) {
  return {
    o: round2(Number(bar.o) + offset),
    h: round2(Number(bar.h) + offset),
    l: round2(Number(bar.l) + offset),
    c: round2(Number(bar.c) + offset),
  };
}

/**
 * Project one historical OHLC bar into executable ask/bid paths. Persisted
 * side-specific OHLC is used when present; old one-sided CMB bars are treated
 * as customer-ask bars and receive an explicitly synthetic fixed bid spread.
 */
export function resolveExecutionBar(input = {}, config = {}) {
  const bar = input.bar;
  if (!bar || ![bar.o, bar.h, bar.l, bar.c].every((value) => positive(value) !== null)) {
    return { ...unavailable(), realBidAsk: false, askBar: null, bidBar: null };
  }
  const providedAsk = sideBar(bar, "ask");
  const providedBid = sideBar(bar, "bid");
  if (bar.executionSideComplete === true && providedAsk && providedBid) {
    const declaredEvidence = Object.values(EXECUTION_EVIDENCE).includes(bar.executionEvidence?.mode)
      ? bar.executionEvidence.mode
      : null;
    const proxy = declaredEvidence === EXECUTION_EVIDENCE.PROXY
      || bar.quality === "proxy"
      || bar.source === "manual"
      || bar.source === "xau-fx-derived";
    if (proxy && input.allowProxy !== true) {
      return {
        ...unavailable(EXECUTION_QUOTE_UNAVAILABLE),
        askBar: providedAsk,
        bidBar: providedBid,
        evidence: EXECUTION_EVIDENCE.PROXY,
        quality: "proxy",
        source: bar.source ?? input.source ?? "persisted-proxy-bid-ask",
      };
    }
    const evidence = proxy ? EXECUTION_EVIDENCE.PROXY : declaredEvidence ?? EXECUTION_EVIDENCE.REAL;
    const realBidAsk = evidence === EXECUTION_EVIDENCE.REAL;
    return {
      available: true,
      askBar: providedAsk,
      bidBar: providedBid,
      synthetic: !realBidAsk,
      realBidAsk,
      evidence,
      quality: realBidAsk ? (bar.quality ?? "primary") : (bar.quality ?? evidence),
      source: bar.source ?? input.source ?? "persisted-bid-ask",
      components: { pricing: realBidAsk ? "persisted-bid-ask" : "persisted-proxy-bid-ask" },
      assumptions: realBidAsk ? [] : [input.assumptionSource ?? "persisted-proxy-bid-ask"],
      executionVersion: EXECUTION_MODEL_VERSION,
    };
  }

  if (String(input.lane ?? "").toLowerCase() === "cmb" && input.allowProxy === true) {
    const askBar = providedAsk ?? shiftBar(bar, 0);
    const fixedSpread = nonNegative(input.cmbSpreadPerGram);
    const spread = fixedSpread > 0 ? fixedSpread : 5;
    const bidBar = {
      o: round2(askBar.o - spread),
      h: round2(askBar.h - spread),
      l: round2(askBar.l - spread),
      c: round2(askBar.c - spread),
    };
    if (Object.values(bidBar).some((value) => !(value > 0))) {
      return { ...unavailable(EXECUTION_BID_UNAVAILABLE), realBidAsk: false, askBar, bidBar: null };
    }
    return {
      available: true,
      askBar,
      bidBar,
      synthetic: true,
      realBidAsk: false,
      evidence: EXECUTION_EVIDENCE.PROXY,
      quality: "proxy",
      source: bar.source ?? input.source ?? "cmb-one-sided-bar",
      components: { pricing: "cmb-ask-minus-fixed-spread", fixedSpreadPerGram: round2(spread) },
      assumptions: [input.assumptionSource ?? "historical-cmb-fixed-spread-proxy"],
      executionVersion: EXECUTION_MODEL_VERSION,
    };
  }

  if (String(input.lane ?? "").toLowerCase() === "cmb") {
    return {
      ...unavailable(providedAsk ? EXECUTION_BID_UNAVAILABLE : providedBid ? EXECUTION_ASK_UNAVAILABLE : EXECUTION_QUOTE_UNAVAILABLE),
      askBar: providedAsk,
      bidBar: providedBid,
      source: bar.source ?? input.source ?? "cmb-one-sided-bar",
    };
  }

  const buyOffset = Number.isFinite(Number(input.buyOffset)) ? Number(input.buyOffset) : 0;
  const sellOffset = Number.isFinite(Number(input.sellOffset)) ? Number(input.sellOffset) : 0;
  const estimatedSpread = nonNegative(config?.strategy?.estimatedSpreadPerGram);
  const askBar = shiftBar(bar, buyOffset);
  const bidBefore = shiftBar(bar, sellOffset);
  const bidBar = {
    o: round2(Math.min(bidBefore.o, askBar.o - estimatedSpread)),
    h: round2(Math.min(bidBefore.h, askBar.h - estimatedSpread)),
    l: round2(Math.min(bidBefore.l, askBar.l - estimatedSpread)),
    c: round2(Math.min(bidBefore.c, askBar.c - estimatedSpread)),
  };
  return {
    available: true,
    askBar,
    bidBar,
    synthetic: true,
    realBidAsk: false,
    evidence: EXECUTION_EVIDENCE.PROXY,
    quality: "proxy",
    source: bar.source ?? input.source ?? "reference-bar",
    components: {
      pricing: "reference-bar-offsets",
      buyOffsetPerGram: round2(buyOffset),
      sellOffsetPerGram: round2(sellOffset),
      estimatedSpreadPerGram: round2(estimatedSpread),
    },
    assumptions: [input.assumptionSource ?? "reference-bar-offset-proxy"],
    executionVersion: EXECUTION_MODEL_VERSION,
  };
}

/** Create one auditable buy/sell ledger entry without mutating a portfolio. */
export function accountExecution(input = {}, config = {}) {
  const side = input.side === "sell" ? "sell" : input.side === "buy" ? "buy" : null;
  const grams = Number(input.grams);
  if (side === null || !Number.isFinite(grams) || grams <= 0) {
    return { ok: false, reasonCode: "execution_order_invalid", executionVersion: EXECUTION_MODEL_VERSION };
  }
  const defaultPrice = side === "buy" ? input.quote?.ask : input.quote?.bid;
  const fillPrice = positive(input.fillPrice ?? defaultPrice);
  if (fillPrice === null) {
    return {
      ok: false,
      reasonCode: side === "buy" ? EXECUTION_ASK_UNAVAILABLE : EXECUTION_BID_UNAVAILABLE,
      executionVersion: EXECUTION_MODEL_VERSION,
    };
  }
  const costs = sideCosts(config, side);
  const grossCny = round2(fillPrice * grams);
  const feeCny = round2(costs.explicitFeePerGram * grams);
  const slippageCny = round2(costs.slippagePerGram * grams);
  const cashFlowCny = side === "buy"
    ? -round2(grossCny + feeCny + slippageCny)
    : round2(grossCny - feeCny - slippageCny);
  const effectivePrice = side === "buy"
    ? round2(fillPrice + costs.explicitFeePerGram + costs.slippagePerGram)
    : round2(fillPrice - costs.explicitFeePerGram - costs.slippagePerGram);
  const sellCosts = sideCosts(config, "sell");
  return {
    ok: true,
    side,
    grams: round2(grams),
    fillPrice: round2(fillPrice),
    effectivePrice,
    grossCny,
    feeCny,
    slippageCny,
    cashFlowCny,
    breakEvenBid: side === "buy"
      ? round2(effectivePrice + sellCosts.explicitFeePerGram + sellCosts.slippagePerGram)
      : null,
    synthetic: input.quote?.synthetic === true,
    evidence: input.quote?.evidence ?? (input.quote?.synthetic === true ? EXECUTION_EVIDENCE.SYNTHETIC : EXECUTION_EVIDENCE.UNKNOWN),
    quality: input.quote?.quality ?? null,
    assumptions: Array.isArray(input.quote?.assumptions) ? input.quote.assumptions.slice() : [],
    components: {
      explicitFeePerGram: round2(costs.explicitFeePerGram),
      slippagePerGram: round2(costs.slippagePerGram),
      quotedSpreadPerGram: Number.isFinite(Number(input.quote?.spreadPerGram))
        ? round2(Number(input.quote.spreadPerGram))
        : null,
    },
    costBreakdown: {
      grossCny,
      explicitFeeCny: feeCny,
      slippageCny,
      quotedSpreadPerGram: Number.isFinite(Number(input.quote?.spreadPerGram))
        ? round2(Number(input.quote.spreadPerGram))
        : null,
    },
    executionVersion: EXECUTION_MODEL_VERSION,
  };
}

/** Mark a long position to executable bid, including entry and exit costs. */
export function valuePosition(position = {}, quote, config = {}, options = {}) {
  const grams = Math.max(0, Number(position?.grams) || 0);
  const avgCostPerGram = Math.max(0, Number(position?.avgCostPerGram) || 0);
  if (grams === 0) {
    return {
      available: true,
      grams: 0,
      avgCostPerGram: round2(avgCostPerGram),
      bid: positive(quote?.bid),
      effectiveExitPrice: positive(quote?.bid),
      liquidationValueCny: 0,
      pnlCny: 0,
      effectivePnlPerGram: 0,
      breakEvenBid: null,
      stopBid: null,
      stopTriggered: false,
      reasonCode: null,
      executionVersion: EXECUTION_MODEL_VERSION,
    };
  }
  if (positive(quote?.bid) === null) {
    return {
      available: false,
      grams: round2(grams),
      avgCostPerGram: round2(avgCostPerGram),
      bid: null,
      effectiveExitPrice: null,
      liquidationValueCny: null,
      pnlCny: null,
      effectivePnlPerGram: null,
      breakEvenBid: null,
      stopBid: null,
      stopTriggered: false,
      reasonCode: EXECUTION_BID_UNAVAILABLE,
      executionVersion: EXECUTION_MODEL_VERSION,
    };
  }
  const sale = accountExecution({ side: "sell", grams, quote }, config);
  if (!sale.ok) return { ...unavailable(sale.reasonCode), pnlCny: null, effectivePnlPerGram: null };
  const buyCosts = sideCosts(config, "buy");
  const sellCosts = sideCosts(config, "sell");
  const entryCostsIncluded = options.entryCostsIncluded === true;
  const effectiveEntryPrice = entryCostsIncluded
    ? round2(avgCostPerGram)
    : round2(avgCostPerGram + buyCosts.explicitFeePerGram + buyCosts.slippagePerGram);
  const maxLossPerGram = nonNegative(config?.strategy?.maxLossPerGram);
  const effectivePnlPerGram = round2(sale.effectivePrice - effectiveEntryPrice);
  const breakEvenBid = round2(effectiveEntryPrice + sellCosts.explicitFeePerGram + sellCosts.slippagePerGram);
  const stopBid = round2(effectiveEntryPrice - maxLossPerGram + sellCosts.explicitFeePerGram + sellCosts.slippagePerGram);
  return {
    available: true,
    grams: round2(grams),
    avgCostPerGram: round2(avgCostPerGram),
    effectiveEntryPrice,
    entryCostsIncluded,
    bid: sale.fillPrice,
    effectiveExitPrice: sale.effectivePrice,
    liquidationValueCny: sale.cashFlowCny,
    pnlCny: round2(sale.cashFlowCny - effectiveEntryPrice * grams),
    effectivePnlPerGram,
    breakEvenBid,
    stopBid,
    stopTriggered: effectivePnlPerGram <= -maxLossPerGram,
    reasonCode: null,
    costs: {
      ...sale.components,
      entryExplicitFeePerGram: entryCostsIncluded ? 0 : round2(buyCosts.explicitFeePerGram),
      entrySlippagePerGram: entryCostsIncluded ? 0 : round2(buyCosts.slippagePerGram),
    },
    synthetic: quote?.synthetic === true,
    evidence: quote?.evidence ?? (quote?.synthetic === true ? EXECUTION_EVIDENCE.SYNTHETIC : EXECUTION_EVIDENCE.UNKNOWN),
    quality: quote?.quality ?? null,
    assumptions: Array.isArray(quote?.assumptions) ? quote.assumptions.slice() : [],
    executionVersion: EXECUTION_MODEL_VERSION,
  };
}

/** Stable object facade used by live, snapshot and replay callers. */
export class ExecutionModel {
  constructor(config = {}) {
    this.config = config;
    this.executionVersion = EXECUTION_MODEL_VERSION;
  }

  quote(input = {}) {
    return resolveExecutionQuote(input, this.config);
  }

  quoteBar(input = {}) {
    return resolveExecutionBar(input, this.config);
  }

  accountExecution(input = {}) {
    return accountExecution(input, this.config);
  }

  valuePosition(position = {}, quote, options = {}) {
    return valuePosition(position, quote, this.config, options);
  }
}

export function createExecutionModel(config = {}) {
  return new ExecutionModel(config);
}
