import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import test from "node:test";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { DEFAULT_CONFIG, mergeConfigPatch, normalizeConfig } from "../lib/config.js";
import { makeWriteQueue, readJson, writeJsonAtomic } from "../lib/store.js";

test("partial experiment ORB patches retain sibling parameters", () => {
  const stored = normalizeConfig({
    experiments: { orb: { openingRangeBars: 9, setupExpiryBars: 20, grams: 1 } },
  });
  const merged = normalizeConfig(mergeConfigPatch(stored, { experiments: { orb: { grams: 2 } } }));
  assert.equal(merged.experiments.orb.grams, 2);
  assert.equal(merged.experiments.orb.openingRangeBars, 9);
  assert.equal(merged.experiments.orb.setupExpiryBars, 20);
});

test("config normalization mirrors the defaults and clamps unsafe write values", () => {
  assert.deepEqual(normalizeConfig(DEFAULT_CONFIG), normalizeConfig({}));
  const clamped = normalizeConfig({
    fee: { buyPerGram: -1, sellPerGram: 999 },
    strategy: { scoreThreshold: 99, rsiOversold: 90 },
  });
  assert.equal(clamped.fee.buyPerGram, 0);
  assert.equal(clamped.fee.sellPerGram, 100);
  assert.equal(clamped.strategy.scoreThreshold, 8);
  assert.equal(clamped.strategy.rsiOversold, 50);
});

test("atomic config writes are owner-only and readable through readJson", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "goldboard-config-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const file = join(dir, "config.json");
  const queue = makeWriteQueue();
  await writeJsonAtomic(file, { fee: { sellPerGram: 7 } }, queue);
  const parsed = await readJson(file, null);
  assert.deepEqual(parsed, { fee: { sellPerGram: 7 } });
  if (process.platform !== "win32") {
    const info = await stat(file);
    assert.equal(info.mode & 0o777, 0o600);
  }
});

test("corrupt config reads fall back without throwing", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "goldboard-config-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const file = join(dir, "config.json");
  await writeFile(file, "{ not json", "utf8");
  assert.equal(await readJson(file, null), null);
  assert.equal(await readFile(file, "utf8"), "{ not json", "readJson never rewrites the corrupt bytes");
});


test("sidebar price preference is normalized and accepted by the partial patch merge", () => {
  assert.equal(normalizeConfig({ sidebarPrice: "XAU" }).sidebarPrice, "XAU");
  assert.equal(normalizeConfig({ sidebarPrice: "CMB" }).sidebarPrice, "CMB");
  assert.equal(normalizeConfig({ sidebarPrice: "bogus" }).sidebarPrice, "AU9999");
  assert.equal(normalizeConfig({ manualPrevCloseDate: "2026-10-20" }).manualPrevCloseDate, "2026-10-20");
  assert.equal(normalizeConfig({ manualPrevCloseDate: "not-a-date" }).manualPrevCloseDate, "");
  const merged = mergeConfigPatch(normalizeConfig({}), { sidebarPrice: "CMB" });
  assert.equal(merged.sidebarPrice, "CMB");
});
