import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

// The client half is a browser bundle without module exports. The chart
// helper block (formatBeijingTime … hasChartLine) is self-contained pure
// code, so it is sliced out of the source text and evaluated directly.
// Temporary approach: plan-05 splits the client file into modules.
const source = readFileSync(new URL("../lib/client.js", import.meta.url), "utf8");

function loadChartHelpers() {
  const startMarker = "/** Format an ISO timestamp as Beijing wall-clock time (Asia/Shanghai). */";
  const endMarker = "var REASON_LABELS";
  const start = source.indexOf(startMarker);
  const end = source.indexOf(endMarker);
  assert.ok(start > 0 && end > start, "chart helper block found in lib/client.js");
  const block = source.slice(start, end);
  return new Function(`
    "use strict";
    ${block}
    return {
      beijingDateKey,
      beijingMinutes,
      parseTime,
      isTradingMinute,
      tradingMinuteIndex,
      tradingDayKey,
      findBarAtBeijingMinute,
      filterTodayBars,
      chartBaselineBar,
      withChartBaseline,
      fillMissingChartSlots,
      hasChartLine,
    };
  `)();
}

const h = loadChartHelpers();
// Default trading hours: 09:00 – next-day 02:00 Beijing ("26:00").
const HOURS = { open: "09:00", close: "26:00" };

const beijing = (date, time) => Date.parse(`${date}T${time}:00+08:00`);

/** Minute bars covering [startMs, startMs + count * step) at `price`. */
function minuteBars(startMs, count, price, stepMs = 60_000) {
  const bars = [];
  for (let i = 0; i < count; i += 1) {
    const t = startMs + i * stepMs;
    bars.push({ t, o: price, h: price, l: price, c: price });
  }
  return bars;
}

test("tradingDayKey anchors the early-morning tail to the previous calendar day", () => {
  // 00:30 Beijing belongs to the session opened the previous day.
  assert.equal(h.tradingDayKey(beijing("2026-08-14", "00:30"), HOURS), "2026-08-13");
  assert.equal(h.tradingDayKey(beijing("2026-08-14", "01:59"), HOURS), "2026-08-13");
  // From close−1440 (=02:00) on, timestamps anchor to their own date.
  assert.equal(h.tradingDayKey(beijing("2026-08-14", "02:00"), HOURS), "2026-08-14");
  assert.equal(h.tradingDayKey(beijing("2026-08-14", "09:30"), HOURS), "2026-08-14");
  assert.equal(h.tradingDayKey(beijing("2026-08-14", "23:00"), HOURS), "2026-08-14");
});

test("tradingDayKey parses '26:00'-style closes and same-day-only sessions", () => {
  assert.equal(h.tradingDayKey(beijing("2026-08-14", "00:30"), { open: "09:00", close: "26:00" }), "2026-08-13");
  // Sessions that end within the same day never cross midnight.
  const shortHours = { open: "09:00", close: "15:00" };
  assert.equal(h.tradingDayKey(beijing("2026-08-14", "08:59"), shortHours), "2026-08-14");
  assert.equal(h.tradingDayKey(beijing("2026-08-14", "14:59"), shortHours), "2026-08-14");
});

test("filterTodayBars keeps yesterday-evening plus early-morning bars after midnight", () => {
  const serverTime = beijing("2026-08-14", "00:30");
  const bars = [
    ...minuteBars(beijing("2026-08-13", "20:00"), 2, 949),
    ...minuteBars(beijing("2026-08-13", "21:00"), 3, 950),
    ...minuteBars(beijing("2026-08-14", "00:00"), 31, 951),
    ...minuteBars(beijing("2026-08-12", "10:00"), 5, 940),
  ];
  const kept = h.filterTodayBars(bars, serverTime, HOURS);
  // Everything from the previous evening session (after its 09:00 open) plus
  // the fresh 00:00–00:30 slice; two days ago stays out.
  assert.equal(kept.length, 5 + 31);
  for (const bar of kept) {
    const isPrevEvening = bar.t >= beijing("2026-08-13", "09:00") && bar.t < beijing("2026-08-14", "00:00");
    const isEarlyMorning = bar.t >= beijing("2026-08-14", "00:00") && bar.t <= serverTime;
    assert.ok(isPrevEvening || isEarlyMorning, `unexpected bar at ${new Date(bar.t).toISOString()}`);
  }
});

test("filterTodayBars drops the previous trading day once the morning session opens", () => {
  const serverTime = beijing("2026-08-14", "09:30");
  const bars = [
    ...minuteBars(beijing("2026-08-13", "21:00"), 5, 950),
    ...minuteBars(beijing("2026-08-14", "00:00"), 5, 951),
    ...minuteBars(beijing("2026-08-14", "09:00"), 31, 952),
  ];
  const kept = h.filterTodayBars(bars, serverTime, HOURS);
  assert.equal(kept.length, 31);
  assert.ok(kept.every((bar) => bar.t >= beijing("2026-08-14", "09:00")));
});

test("fillMissingChartSlots keeps both sides of midnight on one axis", () => {
  const serverTime = beijing("2026-08-14", "00:30");
  const evening = minuteBars(beijing("2026-08-13", "21:00"), 180, 950); // 21:00–23:59
  const morning = minuteBars(beijing("2026-08-14", "00:00"), 31, 951); // 00:00–00:30
  const filled = h.fillMissingChartSlots([...evening, ...morning], serverTime, null, HOURS);
  const real = filled.filter(Boolean);
  assert.equal(real.length, evening.length + morning.length, "no bar dropped across midnight");
  // Axis order: early-morning tail first (indices 0–119), then the session.
  const indices = real.map((bar) => h.tradingMinuteIndex(h.beijingMinutes(bar.t), HOURS));
  assert.ok(indices[0] <= 30, "morning slice comes first on the axis");
  assert.ok(indices[real.length - 1] >= 700, "previous evening sits in the session segment");
  for (let i = 1; i < indices.length; i += 1) {
    assert.ok(indices[i] >= indices[i - 1], "axis indices are non-decreasing");
  }
});

test("fillMissingChartSlots preserves the baseline and daytime behaviour", () => {
  // Daytime: session bars only, slots run from the first bar up to now.
  const serverTime = beijing("2026-08-14", "10:00");
  const session = minuteBars(beijing("2026-08-14", "09:00"), 60, 950);
  const filled = h.fillMissingChartSlots([...session], serverTime, null, HOURS);
  const real = filled.filter(Boolean);
  assert.equal(real.length, session.length);

  // A synthetic baseline before the first real bar survives slot filling.
  const baseline = h.chartBaselineBar(serverTime, 940);
  const sessionNoMidnight = minuteBars(beijing("2026-08-14", "09:00"), 10, 950);
  const withBaseline = h.withChartBaseline(sessionNoMidnight, 940, serverTime);
  assert.equal(withBaseline.length, sessionNoMidnight.length + 1);
  assert.deepEqual(withBaseline[0], baseline);
});
