import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

// The client half is a browser bundle without module exports. The chart
// helper block (formatBeijingTime … chartRuns) is self-contained pure code, so
// it is sliced out of the source text and evaluated directly.
// Temporary approach: plan-05 splits the client file into modules.
const source = readFileSync(new URL("../lib/client.js", import.meta.url), "utf8");

function loadChartHelpers() {
  // plan-05: the reason labels moved into DICT, so the slice now ends at the
  // locale helper that follows the chart block.
  const startMarker = "// ── Beijing wall-clock formatting (hoisted formatter + bounded memo) ──";
  const endMarker = "function isChineseLocale";
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
      hasChartPoints,
      chartRuns,
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

test("filterTodayBars drops the previous trading day's evening once the morning session opens", () => {
  const serverTime = beijing("2026-08-14", "09:30");
  const bars = [
    ...minuteBars(beijing("2026-08-13", "21:00"), 5, 950),
    ...minuteBars(beijing("2026-08-14", "00:00"), 5, 951),
    ...minuteBars(beijing("2026-08-14", "09:00"), 31, 952),
  ];
  const kept = h.filterTodayBars(bars, serverTime, HOURS);
  // The current calendar day's own 00:00–02:00 tail stays (the
  // compressed axis draws it in the leading slots); only the previous
  // trading day's evening session is dropped.
  assert.equal(kept.length, 31 + 5);
  assert.ok(kept.every((bar) => bar.t >= beijing("2026-08-14", "00:00")), "yesterday's evening is gone");
  assert.equal(kept.filter((bar) => bar.t < beijing("2026-08-14", "09:00")).length, 5, "tail kept");
});

test("filterTodayBars keeps the half-day tail drawn after 02:00 (regression: empty tail region)", () => {
  // Reported symptom: 120 real 1m bars from 00:00–01:59 vanished from the
  // 今日走势 chart once the clock passed 02:00, leaving a straight line drawn
  // by the 昨收 anchor across the whole closed period.
  const serverTime = beijing("2026-10-22", "10:40");
  const tail = minuteBars(beijing("2026-10-22", "00:00"), 120, 891.3); // 00:00–01:59
  const session = [
    ...minuteBars(beijing("2026-10-22", "09:07"), 1, 887.82),
    ...minuteBars(beijing("2026-10-22", "10:36"), 5, 888.5),
  ];
  const previousEvening = minuteBars(beijing("2026-10-21", "21:00"), 30, 890);
  const kept = h.filterTodayBars([...previousEvening, ...tail, ...session], serverTime, HOURS);
  assert.equal(kept.length, tail.length + session.length, "tail + session kept, yesterday evening dropped");
  assert.equal(kept.filter((bar) => h.beijingMinutes(bar.t) < 120).length, 120, "all 120 tail bars survive at 10:40");
  // The tail lands in the leading axis slots, so the chart draws them left of 09:00.
  const tailIndices = tail.map((bar) => h.tradingMinuteIndex(h.beijingMinutes(bar.t), HOURS));
  assert.deepEqual([tailIndices[0], tailIndices[tailIndices.length - 1]], [0, 119]);
});

test("chartRuns never joins the 昨收 anchor across the closed period", () => {
  // Baseline at 00:00 (axis 0) + first real bar at 09:07 (axis 127).
  const points = [{ index: 0, value: 891.37 }, { index: 127, value: 887.82 }];
  const breakMode = h.chartRuns(points, false);
  assert.equal(breakMode.runs.length, 0, "no polyline across the 9h closed gap");
  assert.equal(breakMode.dots.length, 2, "both samples still render as dots");
  // Connect mode is the explicit opt-in and still joins them.
  assert.equal(h.chartRuns(points, true).runs.length, 1);
});

test("chartRuns breaks on gaps >5 slots but keeps a dense run and lone samples", () => {
  const dense = [0, 1, 2, 3].map((index) => ({ index, value: 900 + index }));
  const isolated = [200, 216, 217, 400].map((index) => ({ index, value: 890 }));
  const result = h.chartRuns([...dense, ...isolated], false);
  assert.deepEqual(result.runs.map((run) => run.length), [4, 2]);
  assert.deepEqual(result.dots.map((dot) => dot.index), [200, 400]);
});

test("hasChartPoints accepts sparse days that chartRuns can still draw", () => {
  const bars = [
    { t: beijing("2026-10-22", "09:07"), c: 887.82 },
    { t: beijing("2026-10-22", "09:23"), c: 886.91 },
  ];
  assert.equal(h.hasChartPoints(bars, HOURS), true);
  assert.equal(h.hasChartPoints(bars.slice(0, 1), HOURS), false);
  assert.equal(h.hasChartPoints([...bars, { t: beijing("2026-10-22", "02:30"), c: 887 }], HOURS), true, "closed-minute bar is ignored, not fatal");
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
