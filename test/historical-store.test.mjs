import assert from "node:assert/strict";
import { appendFile, mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { HistoricalStore } from "../lib/historical-store.js";

const SCHEMA = "test-market-data-v2";

function tradingDayForTimestamp(timestamp) {
  const date = new Date(timestamp);
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Shanghai",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).formatToParts(date);
  const value = (type) => parts.find((part) => part.type === type)?.value;
  const day = `${value("year")}-${value("month")}-${value("day")}`;
  const minute = Number(value("hour")) * 60 + Number(value("minute"));
  if (minute < 120) {
    const previous = new Date(Date.parse(`${day}T00:00:00Z`) - 86_400_000);
    return previous.toISOString().slice(0, 10);
  }
  return day;
}

async function fixture(t, now = () => new Date("2026-08-15T03:00:00.000Z")) {
  const directory = await mkdtemp(join(tmpdir(), "goldboard-history-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const store = new HistoricalStore({
    directory,
    dataSchemaVersion: SCHEMA,
    tradingDayForTimestamp,
    now,
  });
  await store.init();
  t.after(() => store.close());
  return { directory, store };
}

function quote(eventId, sourceTimestamp, evidence = "real", extra = {}) {
  return {
    eventId,
    instrument: "CMB_ACCUMULATED_GOLD",
    sourceTimestamp,
    receivedAt: sourceTimestamp,
    evidence,
    source: evidence === "real" ? "cmb" : "manual",
    customerAsk: extra.customerAsk,
    customerBid: extra.customerBid,
    ...extra,
  };
}

test("partitions cross-midnight quotes by injected trading day and preserves evidence", async (t) => {
  const { directory, store } = await fixture(t);
  await store.appendQuote(quote("evening", "2026-08-14T16:30:00.000Z", "real", {
    customerAsk: 105,
    customerBid: 100,
  }));
  await store.appendQuote(quote("overnight", "2026-08-14T17:30:00.000Z", "proxy", {
    customerAsk: 106,
  }));
  await store.appendQuote(quote("next-session", "2026-08-15T02:30:00.000Z", "unknown", {
    customerAsk: 107,
  }));

  const files = (await readdir(directory)).filter((name) => name.endsWith(".jsonl"));
  assert.equal(files.length, 2, "Friday evening and Saturday 01:30 share the Friday session partition");
  const manifests = await store.getManifest({ instrument: "CMB_ACCUMULATED_GOLD" });
  assert.deepEqual(manifests.map((entry) => [entry.tradingDay, entry.records]), [
    ["2026-08-14", 2],
    ["2026-08-15", 1],
  ]);
  assert.deepEqual(manifests[0].evidence, { real: 1, synthetic: 0, proxy: 1, unknown: 0 });

  const records = await store.query({ instrument: "CMB_ACCUMULATED_GOLD" });
  const proxy = records.find((record) => record.eventId === "overnight");
  assert.equal(proxy.evidence, "proxy");
  assert.equal(proxy.customerAsk, 106);
  assert.equal(proxy.customerBid, undefined, "missing bid is never inferred");
});

test("deduplicates stable event ids and returns out-of-order appends in timestamp order", async (t) => {
  const { store } = await fixture(t);
  const late = await store.appendQuote(quote("late", "2026-08-15T04:10:00.000Z", "synthetic"));
  const early = await store.appendQuote(quote("early", "2026-08-15T04:00:00.000Z", "real", {
    customerAsk: 101,
    customerBid: 99,
  }));
  const duplicate = await store.appendQuote(quote("early", "2026-08-15T04:20:00.000Z", "proxy"));

  assert.equal(late.appended, true);
  assert.equal(early.appended, true);
  assert.deepEqual(duplicate, { appended: false, duplicate: true, eventId: "early" });
  const records = await store.query({ instrument: "CMB_ACCUMULATED_GOLD" });
  assert.deepEqual(records.map((record) => record.eventId), ["early", "late"]);
  assert.deepEqual((await store.query({
    instrument: "CMB_ACCUMULATED_GOLD",
    evidence: ["synthetic"],
  })).map((record) => record.eventId), ["late"]);
  const manifest = await store.getManifest({ instrument: "CMB_ACCUMULATED_GOLD", tradingDay: "2026-08-15" });
  assert.equal(manifest.records, 2);
  assert.equal(manifest.rejected, 0);
  assert.match(manifest.contentSha256, /^[a-f0-9]{64}$/);
});

test("serializes concurrent appends and applies source, ingest, and as-of bounds", async (t) => {
  const ingestionTimes = [
    "2026-08-15T04:05:00.000Z",
    "2026-08-15T04:20:00.000Z",
    "2026-08-15T04:30:00.000Z",
  ];
  const { store } = await fixture(t, () => new Date(ingestionTimes.shift()));

  const first = store.appendQuote(quote("one", "2026-08-15T04:00:00.000Z", "real", {
    customerAsk: 101,
    customerBid: 99,
  }));
  const second = store.appendQuote(quote("two", "2026-08-15T04:10:00.000Z", "real", {
    customerAsk: 102,
    customerBid: 100,
  }));
  const third = store.appendQuote(quote("three", "2026-08-15T04:20:00.000Z", "proxy", {
    customerAsk: 103,
  }));
  await Promise.all([third, first, second]);
  await store.drain();

  assert.deepEqual((await store.query({
    instrument: "CMB_ACCUMULATED_GOLD",
    from: "2026-08-15T04:05:00.000Z",
    to: "2026-08-15T04:20:00.000Z",
  })).map((record) => record.eventId), ["two", "three"]);
  assert.deepEqual((await store.query({
    instrument: "CMB_ACCUMULATED_GOLD",
    asOf: "2026-08-15T04:15:00.000Z",
  })).map((record) => record.eventId), ["one"], "asOf excludes records not yet ingested and future source timestamps");
});

test("init keeps valid records before a torn tail and reports the tail", async (t) => {
  const { directory, store } = await fixture(t);
  await store.appendQuote(quote("valid", "2026-08-15T04:00:00.000Z", "real", {
    customerAsk: 101,
    customerBid: 99,
  }));
  await store.close();

  const [fileName] = (await readdir(directory)).filter((name) => name.endsWith(".jsonl"));
  await appendFile(join(directory, fileName), '{"kind":"quote","eventId":"torn"', "utf8");
  const cold = new HistoricalStore({
    directory,
    dataSchemaVersion: SCHEMA,
    tradingDayForTimestamp,
    now: () => new Date("2026-08-15T05:00:00.000Z"),
  });
  await cold.load();
  t.after(() => cold.close());

  assert.deepEqual((await cold.query({ instrument: "CMB_ACCUMULATED_GOLD" })).map((record) => record.eventId), ["valid"]);
  await cold.appendQuote(quote("after-recovery", "2026-08-15T04:10:00.000Z", "real", { customerAsk: 102, customerBid: 100 }));
  assert.deepEqual((await cold.query({ instrument: "CMB_ACCUMULATED_GOLD" })).map((record) => record.eventId), ["valid", "after-recovery"]);
  const manifest = await cold.getManifest({ instrument: "CMB_ACCUMULATED_GOLD", tradingDay: "2026-08-15" });
  assert.equal(manifest.records, 2);
  assert.equal(manifest.rejected, 1);
  assert.equal(manifest.rejectedDetails[0].reason, "torn_tail");
  assert.equal(manifest.quarantined, false);
});

test("a corrupt middle record quarantines only its partition", async (t) => {
  const { directory, store } = await fixture(t);
  await store.appendQuote(quote("day-one", "2026-08-15T04:00:00.000Z", "real", { customerAsk: 101, customerBid: 99 }));
  await store.appendQuote(quote("day-two", "2026-08-16T04:00:00.000Z", "real", { customerAsk: 102, customerBid: 100 }));
  const manifests = await store.getManifest({ instrument: "CMB_ACCUMULATED_GOLD" });
  const broken = manifests.find((entry) => entry.tradingDay === "2026-08-15");
  await store.close();

  await appendFile(join(directory, broken.fileName), "{not-json}\n", "utf8");
  const cold = new HistoricalStore({
    directory,
    dataSchemaVersion: SCHEMA,
    tradingDayForTimestamp,
    now: () => new Date("2026-08-16T05:00:00.000Z"),
  });
  await cold.init();
  t.after(() => cold.close());
  assert.deepEqual((await cold.query({ instrument: "CMB_ACCUMULATED_GOLD" })).map((record) => record.eventId), ["day-two"]);
  const quarantined = await cold.getManifest({ instrument: "CMB_ACCUMULATED_GOLD", tradingDay: "2026-08-15" });
  assert.equal(quarantined.records, 0);
  assert.equal(quarantined.quarantined, true);
  assert.equal(quarantined.corruptBackups.length, 1);
  assert.equal((await readdir(directory)).includes(quarantined.corruptBackups[0]), true);
});

test("two store instances serialize the same event id through the directory lock", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "goldboard-history-shared-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const options = { directory, dataSchemaVersion: SCHEMA, tradingDayForTimestamp };
  const first = new HistoricalStore(options);
  const second = new HistoricalStore(options);
  await Promise.all([first.init(), second.init()]);
  t.after(() => Promise.all([first.close(), second.close()]));

  const results = await Promise.all([
    first.appendQuote(quote("shared", "2026-08-15T04:00:00.000Z", "real", { customerAsk: 101, customerBid: 99 })),
    second.appendQuote(quote("shared", "2026-08-15T04:00:00.000Z", "real", { customerAsk: 101, customerBid: 99 })),
  ]);
  assert.equal(results.filter((result) => result.appended).length, 1);
  assert.equal(results.filter((result) => result.duplicate).length, 1);

  const cold = new HistoricalStore(options);
  await cold.init();
  t.after(() => cold.close());
  assert.deepEqual((await cold.query({ instrument: "CMB_ACCUMULATED_GOLD" })).map((record) => record.eventId), ["shared"]);
});
