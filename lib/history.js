/**
 * Per-tick maintenance jobs: kline seeding on cold start, intraday gap
 * backfill, dynamic-spread sampling and premium statistics accumulation.
 *
 * plan-05: extracted from the composition root to keep apply() lean. All
 * state comes from the injected plugin instance — runtime bars, source
 * registry, state persister — so multiple plugin instances stay isolated.
 */

import {
  beijingDateForNow,
  beijingParts,
  buildSessionCalendar,
  computeMarketState,
  filterBarsToTradingHours,
  isOpenMinute,
} from "./market-time.js";
import {
  CMB_SPREAD_MIN_INTERVAL_MS,
  CMB_SPREAD_SAMPLE_CAPACITY,
  PREMIUM_DAY_SAMPLE_CAP,
  assessSpreadPremium,
  cleanCmbSpreadSamples,
  updatePremiumHistory,
} from "./spread-stats.js";
import { round2 } from "./shared.js";
import { TROY_OUNCE_GRAMS, xauCnyPerGram } from "./sizing.js";
import {
  AU_BAR_META,
  GCF_BAR_META,
  MAX_BARS,
  XAU_BAR_META,
  hasMissingLeadingBars,
  hasMissingRecentBars,
  mergeKlines,
  seedBars,
} from "./bars.js";

/** Minimum spacing of kline backfill attempts per tick loop. */
const BACKFILL_THROTTLE_MS = 60_000;

/** Cold-start / thin-history seeding for one instrument's intraday lanes. */
export function createHistoryJobs({ runtime, registry, statePersister, logger }) {

  /** Seed/backfill one instrument's intraday lanes from Eastmoney klines. */
  async function seedInstrumentIntraday(lane, secid, meta, label) {
    if ((runtime.bars[lane][5]?.length ?? 0) < 60) {
      try {
        const klines = await registry.fetchEastmoneyBars(secid, 5, 480);
        if (klines.length > 0) {
          seedBars(runtime.bars[lane], filterBarsToTradingHours(klines, runtime.config), meta);
          statePersister.markDirty("bars");
        }
      } catch (error) {
        logger?.warn?.(`dsh-plugin-goldboard: seed ${label} klines failed: ${String(error?.message ?? error)}`);
      }
    }
    if ((runtime.bars[lane][60]?.length ?? 0) < 20) {
      try {
        const klines = await registry.fetchEastmoneyBars(secid, 60, 240);
        if (klines.length > 0) {
          mergeKlines(runtime.bars[lane][60], filterBarsToTradingHours(klines, runtime.config), 60, meta);
          statePersister.markDirty("bars");
        }
      } catch (error) {
        logger?.warn?.(`dsh-plugin-goldboard: seed ${label} 60m failed: ${String(error?.message ?? error)}`);
      }
    }
  }

  /** Daily history: Eastmoney primary, SGE documented fallback for Au99.99. */
  async function seedDaily(lane, secid, meta, label) {
    const daily = runtime.bars[lane][1440] ?? (runtime.bars[lane][1440] = []);
    if (daily.length >= 20) return;
    try {
      const klines = await registry.fetchEastmoneyBars(secid, 101, 500);
      if (klines.length > 0) {
        mergeKlines(runtime.bars[lane][1440], klines, 1440, meta);
        statePersister.markDirty("bars");
      }
    } catch (error) {
      logger?.warn?.(`dsh-plugin-goldboard: seed ${label} daily failed: ${String(error?.message ?? error)}`);
    }
    if (lane === "AU9999" && (runtime.bars[lane][1440]?.length ?? 0) < 20) {
      try {
        const sgeDaily = await registry.fetchSgeDailyBars();
        if (sgeDaily.length > 0) {
          mergeKlines(runtime.bars[lane][1440], sgeDaily, 1440, { ...meta, source: "sge" });
          statePersister.markDirty("bars");
        }
      } catch (sgeError) {
        logger?.warn?.(`dsh-plugin-goldboard: seed ${label} SGE daily failed: ${String(sgeError?.message ?? sgeError)}`);
      }
    }
  }

  async function seedHistory() {
    await seedInstrumentIntraday("AU9999", "118.AU9999", AU_BAR_META, "AU9999");
    await seedInstrumentIntraday("XAU", "122.XAU", XAU_BAR_META, "XAU");
    await seedDaily("AU9999", "118.AU9999", AU_BAR_META, "AU9999");
    await seedDaily("XAU", "122.XAU", XAU_BAR_META, "XAU");
    // Yahoo exposes COMEX GC=F futures, not XAU/USD spot. Preserve it as a
    // separate diagnostic series instead of silently backfilling spot history.
    const gcfDaily = runtime.bars.GCF[1440] ?? (runtime.bars.GCF[1440] = []);
    if (gcfDaily.length >= 20) return;
    try {
      const yahooDaily = await registry.fetchYahooXauDailyBars();
      if (yahooDaily.length > 0) {
        mergeKlines(runtime.bars.GCF[1440], yahooDaily, 1440, GCF_BAR_META);
        statePersister.markDirty("bars");
      }
    } catch (yahooError) {
      logger?.warn?.(`dsh-plugin-goldboard: seed GC=F Yahoo daily failed: ${String(yahooError?.message ?? yahooError)}`);
    }
  }

  /** Missing-intraday predicate for one lane at one interval. */
  function laneMissing(lane, interval, nowMs) {
    return hasMissingRecentBars(runtime.bars[lane][interval], new Date(nowMs), interval)
      || hasMissingLeadingBars(runtime.bars[lane][interval], new Date(nowMs), interval);
  }

  async function backfillLane(lane, secid, meta) {
    try {
      const klines = await registry.fetchEastmoneyBars(secid, 5, 480);
      if (klines.length > 0) mergeKlines(runtime.bars[lane][5], filterBarsToTradingHours(klines, runtime.config), 5, meta);
    } catch (error) {
      logger?.warn?.(`dsh-plugin-goldboard: backfill ${lane} 5m failed: ${String(error?.message ?? error)}`);
    }
  }

  /** Backfill missing CMB minute buckets from XAU×FX with the calibrated spread. */
  function backfillCmbFromInternational() {
    const basePrice = xauCnyPerGram(runtime.quotes.XAU, runtime.quotes.USDCNY);
    if (basePrice === null) return;
    const cmbQuote = runtime.quotes.CMB;
    let spread = null;
    if (cmbQuote && Number.isFinite(Number(cmbQuote.buyPrice)) && Number(cmbQuote.buyPrice) > 0) {
      spread = Number(cmbQuote.buyPrice) - basePrice;
    } else {
      spread = runtime.config.cmb.buySpreadPerGram;
    }
    if (!Number.isFinite(spread)) return;
    const now = new Date();
    const today = beijingDateForNow(now);
    const factor = Number(runtime.quotes.USDCNY.price) / TROY_OUNCE_GRAMS;
    const calendar = buildSessionCalendar(runtime.config);
    for (const interval of [1, 5]) {
      const xauBars = runtime.bars.XAU[interval];
      const cmbBars = runtime.bars.CMB[interval];
      if (!Array.isArray(xauBars) || xauBars.length === 0 || !Array.isArray(cmbBars)) continue;
      const byTime = new Map(cmbBars.map((bar) => [bar.t, bar]));
      let changed = false;
      for (const bar of xauBars) {
        if (!bar) continue;
        if (beijingDateForNow(new Date(bar.t)) !== today) continue;
        if (!isOpenMinute(calendar, bar.t)) continue;
        if (byTime.has(bar.t)) continue;
        byTime.set(bar.t, {
          t: bar.t,
          o: round2(bar.o * factor + spread),
          h: round2(bar.h * factor + spread),
          l: round2(bar.l * factor + spread),
          c: round2(bar.c * factor + spread),
          synthetic: true,
          source: "xau-fx-derived",
          instrument: "CMB_ACCUMULATED_GOLD",
          market: "bank",
          currency: "CNY",
          unit: "gram",
        });
        changed = true;
      }
      if (!changed) continue;
      const merged = Array.from(byTime.values()).sort((a, b) => a.t - b.t);
      cmbBars.length = 0;
      cmbBars.push(...merged.slice(-MAX_BARS));
      statePersister.markDirty("bars");
    }
  }

  async function backfillTrend() {
    const now = Date.now();
    if (now - (runtime.lastBackfillAt || 0) < BACKFILL_THROTTLE_MS) return;
    const auMissing = laneMissing("AU9999", 5, now);
    const xauMissing = laneMissing("XAU", 5, now);
    const cmbMissing = [1, 5].some((interval) =>
      runtime.bars.CMB[interval].length === 0
      || hasMissingRecentBars(runtime.bars.CMB[interval], new Date(now), interval)
      || hasMissingLeadingBars(runtime.bars.CMB[interval], new Date(now), interval)
    );
    if (!auMissing && !xauMissing && !cmbMissing) return;
    runtime.lastBackfillAt = now;
    if (auMissing) await backfillLane("AU9999", "118.AU9999", AU_BAR_META);
    if (xauMissing) await backfillLane("XAU", "122.XAU", XAU_BAR_META);
    if (cmbMissing) backfillCmbFromInternational();
  }

  /** Sample the live CMB mid-spread over xauCny for the dynamic fallback (plan-03 03.3). */
  function sampleCmbSpread(now = new Date()) {
    const base = xauCnyPerGram(runtime.quotes.XAU, runtime.quotes.USDCNY);
    if (base === null) return;
    if (runtime.laneHealth?.CMB?.ok === false) return; // healthy live ticks only
    const cmb = runtime.quotes.CMB;
    const buy = Number(cmb?.buyPrice);
    const sell = Number(cmb?.sellPrice);
    if (!Number.isFinite(buy) || !Number.isFinite(sell) || buy <= 0 || sell <= 0) return;
    const nowMs = now.getTime();
    const samples = cleanCmbSpreadSamples(runtime.cmbSpreadSamples, nowMs);
    const last = samples[samples.length - 1];
    if (last && nowMs - last.t < CMB_SPREAD_MIN_INTERVAL_MS) return;
    samples.push({ t: nowMs, spreadMid: round2((buy + sell) / 2 - base) });
    runtime.cmbSpreadSamples = samples.slice(-CMB_SPREAD_SAMPLE_CAPACITY);
    statePersister.markDirty("other");
  }

  /**
   * Fold this tick's domestic premium into today's running-median record and
   * refresh the spread_alert statistics (plan-03 03.2). Sampling only happens
   * while the market is open, so overnight gaps contribute nothing.
   */
  function recordPremiumSample(now = new Date()) {
    const derived = runtime.lastSnapshot?.derived;
    const value = Number(derived?.domesticPremiumPerGram);
    const parts = beijingParts(now);
    const open = computeMarketState(runtime.config, now).state === "open";
    if (runtime.premiumDaySamples?.date !== parts.date) {
      runtime.premiumDaySamples = { date: parts.date, values: [] };
    }
    if (open && Number.isFinite(value)) {
      const values = runtime.premiumDaySamples.values;
      if (values.length < PREMIUM_DAY_SAMPLE_CAP) values.push(value);
      runtime.premiumHistory = updatePremiumHistory(runtime.premiumHistory, parts.date, values);
      statePersister.markDirty("other");
    }
    const completed = (Array.isArray(runtime.premiumHistory) ? runtime.premiumHistory : [])
      .filter((entry) => entry && entry.date !== parts.date);
    const stats = assessSpreadPremium(completed, value);
    runtime.spreadCheck = { ...stats, ...(Number.isFinite(value) ? { today: value } : {}) };
  }

  return { seedHistory, backfillTrend, sampleCmbSpread, recordPremiumSample };
}
