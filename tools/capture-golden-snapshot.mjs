// plan-05 golden fixture: a fixed, deterministic replay input plus the tool
// that captures its snapshot as test/fixtures/golden-snapshot.json.
//
// Usage: node tools/capture-golden-snapshot.mjs [outPath]
//
// The fixture pins a synthetic open-session moment (Beijing Friday 11:30)
// with live CMB quotes, an open position, and full 1m/5m/60m/daily history so
// every branch of computePlan / buildSnapshot is exercised deterministically.
// buildGoldenInput/buildGoldenConfig are exported so the integration suite
// replays the EXACT same fixture through POST /replay.
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { replayMarketPlan } from "../lib/snapshot.js";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");

export const GOLDEN_AS_OF = "2026-03-13T03:30:00.000Z"; // Beijing 11:30 Friday — session open

function beijingMs(dateStr) {
  return Date.parse(`${dateStr}+08:00`);
}

function round2(value) {
  return Math.round(value * 100) / 100;
}

export function buildGoldenInput() {
  const day = "2026-03-13";

  // 1-minute bars from the 09:00 open through 11:30 (151 buckets): the last
  // bucket is the still-open current minute, exactly what the live host always
  // carries when a poll lands on a whole-minute boundary.
  const bars1m = [];
  for (let i = 0; i < 151; i += 1) {
    const minute = 9 * 60 + i;
    const hh = String(Math.floor(minute / 60)).padStart(2, "0");
    const mm = String(minute % 60).padStart(2, "0");
    const t = beijingMs(`${day}T${hh}:${mm}:00`);
    const base = 950 + i * 0.05 - (i === 80 ? 1.2 : 0);
    const o = round2(base - 0.02);
    bars1m.push({ t, o, h: round2(base + 0.06), l: round2(base - 0.08), c: round2(base) });
  }

  // 5-minute klines for the previous sessions (aggregation source).
  const bars5m = [];
  for (let d = 4; d >= 1; d -= 1) {
    const date = `2026-03-${String(13 - d).padStart(2, "0")}`;
    for (let i = 0; i < 48; i += 1) {
      const minute = 9 * 60 + i * 5;
      const hh = String(Math.floor(minute / 60)).padStart(2, "0");
      const mm = String(minute % 60).padStart(2, "0");
      const t = beijingMs(`${date}T${hh}:${mm}:00`);
      const base = 940 + d * 2 + i * 0.04;
      bars5m.push({
        t,
        o: round2(base - 0.1),
        h: round2(base + 0.3),
        l: round2(base - 0.3),
        c: round2(base),
        source: "eastmoney",
        instrument: "Au99.99",
        market: "sge",
        currency: "CNY",
        unit: "gram",
      });
    }
  }

  // Today's 5m buckets derived from the 1m series.
  const today5m = [];
  for (let i = 0; i < bars1m.length; i += 5) {
    const chunk = bars1m.slice(i, i + 5);
    today5m.push({
      t: chunk[0].t,
      o: chunk[0].o,
      h: Math.max(...chunk.map((b) => b.h)),
      l: Math.min(...chunk.map((b) => b.l)),
      c: chunk[chunk.length - 1].c,
      synthetic: true,
      source: "sina",
      instrument: "Au99.99",
      market: "sge",
      currency: "CNY",
      unit: "gram",
    });
  }

  // Daily bars.
  const daily = [];
  for (let d = 10; d >= 1; d -= 1) {
    const date = `2026-03-${String(13 - d).padStart(2, "0")}`;
    const close = 935 + (11 - d) * 1.5;
    daily.push({
      t: beijingMs(`${date}T00:00:00`),
      o: round2(close - 1),
      h: round2(close + 0.8),
      l: round2(close - 1.2),
      c: round2(close),
      source: "eastmoney",
      instrument: "Au99.99",
      market: "sge",
      currency: "CNY",
      unit: "gram",
    });
  }

  // CMB lanes mirror the domestic series shifted by the configured spread: the
  // live-CMB signal lane reads its own bar history, so it must carry data.
  const CMB_SHIFT = 1.72;
  const shiftBars = (bars) =>
    bars.map((bar) => ({
      ...bar,
      o: round2(bar.o + CMB_SHIFT),
      h: round2(bar.h + CMB_SHIFT),
      l: round2(bar.l + CMB_SHIFT),
      c: round2(bar.c + CMB_SHIFT),
      source: "cmb",
      instrument: "CMB_ACCUMULATED_GOLD",
      market: "bank",
      currency: "CNY",
      unit: "gram",
      synthetic: true,
    }));
  const cmb1m = shiftBars(bars1m);
  const cmb5mHistory = shiftBars(bars5m);
  const cmbToday5m = shiftBars(today5m);
  const cmbDaily = [];
  for (let d = 10; d >= 1; d -= 1) {
    const date = `2026-03-${String(13 - d).padStart(2, "0")}`;
    const close = 935 + (11 - d) * 1.5 + CMB_SHIFT;
    cmbDaily.push({
      t: beijingMs(`${date}T00:00:00`),
      o: round2(close - 1),
      h: round2(close + 0.8),
      l: round2(close - 1.2),
      c: round2(close),
      source: "cmb",
      instrument: "CMB_ACCUMULATED_GOLD",
      market: "bank",
      currency: "CNY",
      unit: "gram",
    });
  }
  // Hourly buckets across recent sessions; buckets not fully closed before
  // asOf are skipped (the still-open hour belongs to the tick path). The
  // session runs 09:00→26:00 Beijing, so hours past midnight are built by
  // minute offset — string parsing rejects hour "24"/"25".
  const cmb60m = [];
  for (let d = 4; d >= 0; d -= 1) {
    const date = `2026-03-${String(13 - d).padStart(2, "0")}`;
    const base = 941 + d * 2;
    const dayOpen = beijingMs(`${date}T09:00:00`);
    for (let hour = 0; hour < 17; hour += 1) {
      const startMs = dayOpen + hour * 3_600_000;
      if (startMs + 3_600_000 > Date.parse(GOLDEN_AS_OF)) continue;
      cmb60m.push({
        t: startMs,
        o: round2(base + hour * 0.15 + CMB_SHIFT),
        h: round2(base + hour * 0.15 + 0.4 + CMB_SHIFT),
        l: round2(base + hour * 0.15 - 0.3 + CMB_SHIFT),
        c: round2(base + hour * 0.15 + 0.25 + CMB_SHIFT),
        source: "cmb",
        instrument: "CMB_ACCUMULATED_GOLD",
        market: "bank",
        currency: "CNY",
        unit: "gram",
        synthetic: true,
      });
    }
  }

  return {
    asOf: GOLDEN_AS_OF,
    quotes: {
      AU9999: {
        price: 956.12,
        bid: 956.08,
        ask: 956.16,
        high: 956.8,
        low: 949.9,
        open: 950.1,
        prevClose: 949.5,
        time: "11:30:00",
        date: day,
        name: "Au99.99",
        source: "sina",
      },
      // Internally consistent with Au99.99≈956 CNY/g at 7.2385 USDCNY
      // (955 × 31.1034768 / 7.2385 ≈ 4103.6 USD/oz) so the domestic-premium
      // disagreement gate stays quiet.
      CMB: { price: 957.85, buyPrice: 957.85, sellPrice: 958.42, source: "cmb" },
      XAU: {
        price: 4103.6,
        prevClose: 4098.2,
        time: new Date(Date.parse(GOLDEN_AS_OF) - 60_000).toISOString(),
        source: "tencent",
      },
      USDCNY: { price: 7.2385, name: "USDCNY", time: "11:29:58", source: "tencent" },
      GCF: {
        price: 4109.5,
        time: new Date(Date.parse(GOLDEN_AS_OF) - 120_000).toISOString(),
        source: "yahoo",
      },
    },
    bars: {
      AU9999: { 1: bars1m, 5: [...bars5m, ...today5m], 60: [], 1440: daily },
      XAU: { 1: [], 5: [], 60: [], 1440: [] },
      GCF: { 1: [], 5: [], 60: [], 1440: [] },
      CMB: {
        1: cmb1m,
        5: [...cmb5mHistory, ...cmbToday5m],
        60: cmb60m,
        1440: cmbDaily,
      },
    },
  };
}

export function buildGoldenConfig() {
  return {
    fee: { buyPerGram: 0, sellPerGram: 5 },
    cmb: { buySpreadPerGram: 1.72, sellSpreadPerGram: 1.72 },
    position: {
      grams: 12.34,
      avgCostPerGram: 951.2,
      lots: [
        { id: "lot-1", grams: 6.17, price: 950.4, time: "2026-03-11T01:30:00.000Z", status: "open" },
        { id: "lot-2", grams: 6.17, price: 952.0, time: "2026-03-12T03:00:00.000Z", status: "open" },
      ],
    },
    limits: { maxGrams: 50 },
    strategy: {
      minProfitPerGram: 1,
      maxLossPerGram: 2,
      slippagePerGram: 0.2,
      estimatedSpreadPerGram: 0.2,
      rsiOversold: 35,
      rsiOverbought: 75,
      atrFactor: 0.3,
      nearSupportPct: 0.5,
      minRemainGrams: 0,
      signalCooldownMinutes: 30,
      confirmBars: 2,
      scoreThreshold: 5,
      weaknessRsi: 75,
      weaknessShadowAtrMult: 1.0,
    },
    tradingHours: { weekdaysOnly: true, open: "09:00", close: "26:00", holidays: [] },
    analysis: { enabled: false, maxLogEntries: 500 },
  };
}

// ── CLI capture ─────────────────────────────────────────────────────────────

const invokedDirectly = process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1];

if (invokedDirectly) {
  const result = replayMarketPlan(buildGoldenInput(), buildGoldenConfig());
  const outPath = process.argv[2] ?? join(root, "test", "fixtures", "golden-snapshot.json");
  mkdirSync(dirname(outPath), { recursive: true });
  writeFileSync(outPath, JSON.stringify(result, null, 2) + "\n", "utf8");
  console.log(`golden snapshot written: ${outPath}`);
  console.log(`plan.action=${result.snapshot.plan.action} signalLane=${result.snapshot.plan.signalLane} quality=${result.snapshot.quality.status}`);
}
