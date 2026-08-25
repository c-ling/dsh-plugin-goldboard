/**
 * /snapshot wire-view builder: quote/bar projections, derived CMB estimates,
 * premium statistics and the full dashboard payload.
 *
 * plan-05: extracted from the old monolithic lib/index.js. Pure with respect
 * to its inputs; the composition root caches the result (2s window).
 */

import { computeMarketState, computeNextMarketOpen, filterBarsToTradingHours } from "./market-time.js";
import { CALCULATION_VERSION, assessMarketQuality, closedBars, isBarClosed, normalizeQuoteRecord } from "./market-quality.js";
import {
  PREMIUM_MIN_DAYS,
  assessSpreadPremium,
  cleanCmbSpreadSamples,
  computePlan,
  dynamicCmbSpread,
  hasCmbFallback,
  xauCnyPerGram,
} from "./plan.js";
import { STALE_QUOTE_MS, isDomesticQuoteFresh } from "./sources.js";
import { round2 } from "./shared.js";
import { DEFAULT_CONFIG, normalizeConfig } from "./config.js";
import { ensureBars } from "./bars.js";
import { resampleBars } from "./indicators.js";

/** GET /snapshot serves the cached snapshot when younger than this. */
export const SNAPSHOT_REBUILD_MIN_MS = 2_000;
// Today-trend points per lane in /snapshot. A single trading session is at
// most 1020 minutes (17h); 1080 leaves headroom while keeping the payload
// well under the ~1MB the old 1440 cap could produce.
export const TREND_POINTS = 1080;

/**
 * Cache decision for GET /snapshot. Pure so tests can inject both clocks:
 * a cached snapshot is served while it is younger than `minMs`.
 */
export function snapshotCacheStale(builtAtMs, nowMs, minMs = SNAPSHOT_REBUILD_MIN_MS) {
  return !(Number.isFinite(builtAtMs) && nowMs - builtAtMs < minMs);
}

function quoteView(quote, now) {
  if (!quote) return null;
  const stale = !Number.isFinite(quote.updatedAt) || now - quote.updatedAt > STALE_QUOTE_MS || !(quote.price > 0) || !isDomesticQuoteFresh(quote, new Date(now));
  return {
    price: quote.price,
    bid: quote.bid,
    ask: quote.ask,
    high: quote.high,
    low: quote.low,
    open: quote.open,
    prevClose: quote.prevClose,
    buyPrice: quote.buyPrice,
    sellPrice: quote.sellPrice,
    average: quote.average ?? (Number.isFinite(Number(quote.buyPrice)) && Number.isFinite(Number(quote.sellPrice))
      ? round2((Number(quote.buyPrice) + Number(quote.sellPrice)) / 2)
      : undefined),
    time: quote.time,
    date: quote.date,
    source: quote.source,
    instrument: quote.instrument,
    market: quote.market,
    currency: quote.currency,
    unit: quote.unit,
    sourceTimestamp: quote.sourceTimestamp,
    receivedAt: quote.receivedAt,
    staleAfterMs: quote.staleAfterMs,
    quality: quote.quality,
    customerBuy: quote.customerBuy ?? quote.buyPrice,
    customerSell: quote.customerSell ?? quote.sellPrice,
    spread: quote.spread,
    stale,
    ...(quote.error === true ? { error: true } : {}),
  };
}


/**
 * Wire view of a bar list.
 *
 * `meta: false` (slim mode, used by the /snapshot trend arrays) emits exactly
 * { t, o, h, l, c }: every bar in a lane carries identical provenance
 * (repeated source/instrument/market/currency/unit is pure waste), and the
 * browser half only reads t/o/h/l/c from trend bars (`complete` is
 * recomputable client-side and unused there). Slimming keeps a typical
 * fully-populated snapshot under the 300KB budget; the /bars detail endpoint
 * keeps full metadata.
 */
export function barsView(bars, limit = 288, intervalMinutes = 1, now = Date.now(), meta = true) {
  if (!Array.isArray(bars)) return [];
  return bars.slice(-limit).map((bar) => (
    meta ? {
      t: new Date(bar.t).toISOString(),
      o: round2(bar.o),
      h: round2(bar.h),
      l: round2(bar.l),
      c: round2(bar.c),
      complete: isBarClosed(bar, intervalMinutes, now),
      ...(bar.synthetic === true ? { synthetic: true } : {}),
      ...(bar.source !== undefined ? { source: bar.source } : {}),
      ...(bar.instrument !== undefined ? { instrument: bar.instrument } : {}),
      ...(bar.market !== undefined ? { market: bar.market } : {}),
      ...(bar.currency !== undefined ? { currency: bar.currency } : {}),
      ...(bar.unit !== undefined ? { unit: bar.unit } : {}),
    } : {
      t: new Date(bar.t).toISOString(),
      o: round2(bar.o),
      h: round2(bar.h),
      l: round2(bar.l),
      c: round2(bar.c),
    }
  ));
}

export function buildSnapshot(runtime, config, now = new Date()) {
  const cfg = normalizeConfig(config);
  const domestic = runtime.quotes?.AU9999;
  const xau = runtime.quotes?.XAU;
  const usdcny = runtime.quotes?.USDCNY;
  const basePlan = runtime.plan ?? computePlan(runtime, cfg, now);
  const xauIsSpot = !!xau
    && xau.market !== "futures"
    && xau.instrument !== "GC=F"
    && xau.source !== "yahoo";
  const xauCny = xauIsSpot ? xauCnyPerGram(xau, usdcny) : null;
  const hasXauFallback = xauIsSpot && hasCmbFallback(xau, usdcny);
  const hasDomestic = !!domestic && Number.isFinite(domestic.price) && domestic.price > 0;
  const cmbQuote = runtime.quotes?.CMB;
  const liveCmb = cmbQuote && Number.isFinite(Number(cmbQuote.buyPrice)) && Number.isFinite(Number(cmbQuote.sellPrice))
    && Number(cmbQuote.buyPrice) > 0 && Number(cmbQuote.sellPrice) > 0;
  const fallbackMissing = !liveCmb && !hasXauFallback;
  const plan = basePlan.action === "no_data" && fallbackMissing
    ? { ...basePlan, action: "data_stale", reasonCodes: ["quote_missing"] }
    : basePlan;
  const derived = {};
  if (xauCny !== null) {
    derived.xauCnyPerGram = xauCny;
  }
  if (Number.isFinite(domestic?.price) && domestic.price > 0 && xauCny !== null) {
    derived.domesticPremiumPerGram = round2(domestic.price - xauCny);
    derived.domesticPremiumRatio = Math.round((derived.domesticPremiumPerGram / xauCny) * 1_000_000) / 1_000_000;
    derived.domesticPremiumPct = round2(derived.domesticPremiumRatio * 100);
  }
  if (liveCmb || hasXauFallback || hasDomestic) {
    const cmbBase = xauCny ?? (hasDomestic ? domestic.price : undefined);
    // Dynamic CMB spread calibration (plan-03 03.3): report which source the
    // fallback estimate used so the settings page can display it.
    const dynamicSpreadView = dynamicCmbSpread(runtime.cmbSpreadSamples, now.getTime(), cfg.cmb.sellSpreadPerGram);
    const buyOffsetView = dynamicSpreadView ? dynamicSpreadView.spread : cfg.cmb.buySpreadPerGram;
    const sellOffsetView = dynamicSpreadView ? dynamicSpreadView.spread : cfg.cmb.sellSpreadPerGram;
    const cmbBuy = liveCmb ? round2(Number(cmbQuote.buyPrice)) : round2(cmbBase + buyOffsetView);
    const cmbSell = liveCmb ? round2(Number(cmbQuote.sellPrice)) : round2(cmbBase + sellOffsetView);
    const cmbSellAfterFee = liveCmb ? cmbSell : round2(cmbSell - cfg.fee.sellPerGram);
    derived.cmb = {
      buyPrice: cmbBuy,
      sellPrice: cmbSell,
      customerBuy: cmbBuy,
      customerSell: cmbSell,
      spread: round2(cmbBuy - cmbSell),
      effectiveExitPrice: cmbSellAfterFee,
      average: round2((cmbBuy + cmbSell) / 2),
      sellPriceAfterFee: cmbSellAfterFee,
      live: Boolean(liveCmb),
      spreadSource: liveCmb ? "live" : (dynamicSpreadView ? "dynamic-estimate" : "static"),
      spreadSampleCount: liveCmb ? undefined : (dynamicSpreadView?.sampleCount ?? cleanCmbSpreadSamples(runtime.cmbSpreadSamples, now.getTime()).length),
      ...(!liveCmb ? { basePrice: cmbBase } : {}),
      sourceNote: liveCmb
        ? "招行接口实时价"
        : (xauCny !== null
          ? `国际金价按汇率折算 ${xauCny} + ${buyOffsetView}/${sellOffsetView} 元/克估算${dynamicSpreadView ? "（动态校准）" : ""}，卖出已扣 ${cfg.fee.sellPerGram} 元/克手续费`
          : `Au99.99 ${domestic.price} + ${buyOffsetView}/${sellOffsetView} 元/克估算${dynamicSpreadView ? "（动态校准）" : ""}，卖出已扣 ${cfg.fee.sellPerGram} 元/克手续费`),
    };
  }
  // spread_alert statistics window (plan-03 03.2): today's running median vs
  // the population σ of completed days; below PREMIUM_MIN_DAYS only a warning.
  const premiumStats = assessSpreadPremium(runtime.premiumHistory, derived.domesticPremiumPerGram);
  if (Number.isFinite(derived.domesticPremiumPerGram)) {
    derived.premium = {
      today: derived.domesticPremiumPerGram,
      ready: premiumStats.ready,
      sampleDays: premiumStats.sampleCount,
      minDays: PREMIUM_MIN_DAYS,
      ...(premiumStats.ready ? { mean: premiumStats.mean, sigma: premiumStats.sigma, deviationSigma: premiumStats.deviationSigma, anomaly: premiumStats.anomaly } : {}),
    };
  }
  const market = computeMarketState(cfg, now);
  market.nextOpen = computeNextMarketOpen(cfg, now);
  const auView = quoteView(domestic, now.getTime());
  const xauView = quoteView(xau, now.getTime());
  const cmbView = quoteView(runtime.quotes?.CMB, now.getTime());
  if (auView && cfg.manualPrevClose.AU9999) auView.prevClose = cfg.manualPrevClose.AU9999;
  if (xauView && cfg.manualPrevClose.XAU) xauView.prevClose = cfg.manualPrevClose.XAU;
  if (cmbView && cfg.manualPrevClose.CMB) cmbView.prevClose = cfg.manualPrevClose.CMB;
  if (cmbView) {
    cmbView.customerBuy = cmbView.customerBuy ?? cmbView.buyPrice;
    cmbView.customerSell = cmbView.customerSell ?? cmbView.sellPrice;
    cmbView.spread = Number.isFinite(Number(cmbView.customerBuy)) && Number.isFinite(Number(cmbView.customerSell))
      ? round2(Number(cmbView.customerBuy) - Number(cmbView.customerSell))
      : undefined;
    cmbView.effectiveExitPrice = cmbView.customerSell;
  }
  const auQuote = auView && Number(auView.price) > 0
    ? auView
    : { price: 0, source: "error", updatedAt: 0, stale: true, error: true };
  const qualityInstrument = plan.instrument === "CMB" ? "CMB" : plan.instrument === "XAU" ? "XAU" : "AU9999";
  const qualityQuote = runtime.quotes?.[qualityInstrument];
  const qualityBars = runtime.bars?.[qualityInstrument]?.[5] ?? [];
  const quality = plan.dataQuality ?? assessMarketQuality({
    now,
    quote: qualityQuote,
    bars: closedBars(qualityBars, 5, now),
    coverage: plan.dataCoverage ?? {},
    indicators: plan.indicators ? {
      ind5: plan.indicators.ind5,
      ind10: plan.indicators.ind10,
      ind30: plan.indicators.ind30,
      ind60: plan.indicators.ind60,
    } : {},
    marketState: plan.marketState ?? market.state,
    expectedMarket: qualityInstrument === "XAU" ? "spot" : undefined,
    sourceDisagreementPct: derived.domesticPremiumPct,
    cmbSpread: derived.cmb?.spread,
  });
  // Sample-accumulation notice (plan-03 03.2): until PREMIUM_MIN_DAYS of
  // premium history exist, spread_alert stays disarmed and the quality block
  // only says statistics are still building up.
  const qualityOut = !premiumStats.ready && Number.isFinite(derived.domesticPremiumPerGram)
    ? { ...quality, warnings: [...(quality.warnings ?? []), "premium_history_accumulating"] }
    : quality;
  return {
    ok: true,
    serverTime: now.toISOString(),
    marketState: plan.marketState ?? market.state,
    market: {
      state: plan.marketState ?? market.state,
      sessionStart: plan.sessionStart ?? market.sessionStart,
      msToClose: plan.msToClose ?? market.msToClose,
      nextOpen: market.nextOpen,
      open: cfg.tradingHours.open,
      close: cfg.tradingHours.close,
    },
    quotes: {
      AU9999: auQuote,
      XAU: xauView,
      GCF: quoteView(runtime.quotes?.GCF, now.getTime()),
      USDCNY: quoteView(usdcny, now.getTime()),
      CMB: cmbView,
    },
    manualPrevClose: {
      AU9999: cfg.manualPrevClose.AU9999 ?? undefined,
      XAU: cfg.manualPrevClose.XAU ?? undefined,
      CMB: cfg.manualPrevClose.CMB ?? undefined,
    },
    derived,
    quality: qualityOut,
    trend: {
      AU9999_1m: barsView(filterBarsToTradingHours(runtime.bars?.AU9999?.[1], cfg), TREND_POINTS, 1, now, false),
      XAU_1m: barsView(filterBarsToTradingHours(runtime.bars?.XAU?.[1], cfg), TREND_POINTS, 1, now, false),
      GCF_1m: barsView(filterBarsToTradingHours(runtime.bars?.GCF?.[1], cfg), TREND_POINTS, 1, now, false),
      CMB_1m: barsView(filterBarsToTradingHours(runtime.bars?.CMB?.[1], cfg), TREND_POINTS, 1, now, false),
    },
    indicators: plan.indicators ?? {},
    position: plan.position ?? {
      grams: cfg.position.grams,
      avgCostPerGram: cfg.position.avgCostPerGram,
      cmbNow: derived.cmb?.sellPrice,
      feeAdjustedPnl: 0,
      exitNeeded: round2(cfg.position.avgCostPerGram + cfg.fee.sellPerGram + cfg.strategy.estimatedSpreadPerGram + cfg.strategy.slippagePerGram),
      lots: cfg.position.lots ?? [],
    },
    plan: {
      action: plan.action,
      instrument: plan.instrument,
      signalLane: plan.signalLane,
      signalPrice: plan.signalPrice,
      cmbEstimatedPrice: plan.cmbEstimatedPrice,
      cmbLive: plan.cmbLive,
      reasonCodes: plan.reasonCodes ?? [],
      dataCoverage: plan.dataCoverage,
      dataQuality: plan.dataQuality ?? quality,
      confidenceScore: plan.confidenceScore,
      confidenceMax: plan.confidenceMax,
      signalState: plan.signalState,
      breakeven: plan.breakeven,
      targetPrice: plan.targetPrice,
      stopPrice: plan.stopPrice,
      suggestedOrder: plan.suggestedOrder,
    },
    pendingOrder: runtime.lastSuggestedOrder ? {
      action: runtime.lastSuggestedOrder.action,
      instrument: runtime.lastSuggestedOrder.instrument,
      side: runtime.lastSuggestedOrder.side,
      signalPrice: runtime.lastSuggestedOrder.signalPrice,
      cmbEstimatedPrice: runtime.lastSuggestedOrder.cmbEstimatedPrice,
      grams: runtime.lastSuggestedOrder.grams,
      validUntil: runtime.lastSuggestedOrder.validUntil,
      ...(runtime.lastSuggestedOrder.issuedAt ? { issuedAt: runtime.lastSuggestedOrder.issuedAt } : {}),
      reasonCodes: runtime.lastSuggestedOrder.reasonCodes ?? [],
    } : null,
  };
}

/**
 * Re-run the pure quality/indicator/plan projection over one fixed market
 * fixture — the deterministic engine behind POST /replay and the golden
 * snapshot regression.
 */
export function replayMarketPlan(input, config = DEFAULT_CONFIG) {
  if (!input || typeof input !== "object") throw new TypeError("replay input must be an object");
  const asOf = new Date(input.asOf ?? input.serverTime ?? Date.now());
  if (!Number.isFinite(asOf.getTime())) throw new TypeError("replay asOf must be an ISO timestamp");
  const sourceQuotes = input.quotes && typeof input.quotes === "object" ? input.quotes : {};
  const quotes = { AU9999: null, XAU: null, GCF: null, USDCNY: null, CMB: null };
  for (const key of Object.keys(quotes)) {
    const quote = sourceQuotes[key];
    if (!quote || typeof quote !== "object") continue;
    const receivedAt = Number.isFinite(Number(quote.updatedAt))
      ? Number(quote.updatedAt)
      : Number.isFinite(Date.parse(quote.receivedAt ?? ""))
        ? Date.parse(quote.receivedAt)
        : asOf.getTime();
    quotes[key] = normalizeQuoteRecord(key, quote, receivedAt);
  }
  const sourceBars = input.bars && typeof input.bars === "object" ? input.bars : {};
  const runtime = {
    quotes,
    bars: {
      AU9999: ensureBars(sourceBars.AU9999),
      XAU: ensureBars(sourceBars.XAU),
      GCF: ensureBars(sourceBars.GCF),
      CMB: ensureBars(sourceBars.CMB),
    },
  };
  runtime.plan = computePlan(runtime, config, asOf);
  return {
    ok: true,
    replay: {
      asOf: asOf.toISOString(),
      calculationVersion: CALCULATION_VERSION,
      deterministic: true,
    },
    snapshot: buildSnapshot(runtime, config, asOf),
  };
}

/**
 * Multi-timeframe bar projection feeding the analysis module (5/10/30/60m/1d
 * views of one instrument, frozen at the snapshot instant).
 */
export function analysisBarsView(runtime, instrument, now) {
  const bars5 = closedBars(runtime.bars?.[instrument]?.[5] ?? [], 5, now);
  const bars10 = resampleBars(bars5, 2).filter((bar) => isBarClosed(bar, 10, now));
  const bars30 = resampleBars(bars5, 6).filter((bar) => isBarClosed(bar, 30, now));
  const bars60 = closedBars(runtime.bars?.[instrument]?.[60] ?? [], 60, now);
  const bars1d = closedBars(runtime.bars?.[instrument]?.[1440] ?? [], 1440, now);
  return {
    "5m": barsView(bars5, 120, 5, now),
    "10m": barsView(bars10, 120, 10, now),
    "30m": barsView(bars30, 120, 30, now),
    "60m": barsView(bars60, 120, 60, now),
    "1d": barsView(bars1d, 120, 1440, now),
  };
}
