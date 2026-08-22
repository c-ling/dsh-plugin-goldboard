import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

// The client half is a browser bundle without module exports, so the DICT
// object is extracted from the source text by bracket balancing and evaluated
// with `new Function`. Temporary approach: plan-05 extracts the dictionaries
// into a real module, after which this file can import them directly.
const source = readFileSync(new URL("../lib/client.js", import.meta.url), "utf8");

/** Return the end index (exclusive) of the balanced `{...}` block opening at `start`. */
function balancedBraces(text, start) {
  let depth = 0;
  let inString = null;
  for (let i = start; i < text.length; i += 1) {
    const ch = text[i];
    const next = text[i + 1];
    if (inString) {
      if (ch === "\\") {
        i += 1;
      } else if (ch === inString) {
        inString = null;
      }
      continue;
    }
    if (ch === '"' || ch === "'" || ch === "`") {
      inString = ch;
      continue;
    }
    if (ch === "/" && next === "/") {
      while (i < text.length && text[i] !== "\n") i += 1;
      continue;
    }
    if (ch === "/" && next === "*") {
      i = text.indexOf("*/", i + 2) + 1;
      continue;
    }
    if (ch === "{") depth += 1;
    if (ch === "}") {
      depth -= 1;
      if (depth === 0) return i + 1;
    }
  }
  throw new Error("unbalanced braces");
}

function loadDict() {
  const marker = "var DICT = ";
  const markerIndex = source.indexOf(marker);
  assert.ok(markerIndex > 0, "DICT declaration found in lib/client.js");
  const braceStart = source.indexOf("{", markerIndex);
  const literal = source.slice(braceStart, balancedBraces(source, braceStart));
  return new Function(`return (${literal});`)();
}

test("DICT.zh and DICT.en expose exactly the same key set", () => {
  const dict = loadDict();
  assert.ok(Object.keys(dict.zh).length > 100, "zh dictionary is populated");
  assert.deepEqual(Object.keys(dict.en).sort(), Object.keys(dict.zh).sort());
});

test("EN dictionary values contain no Chinese characters", () => {
  const dict = loadDict();
  // Product names kept deliberately in English would be whitelisted here;
  // after plan-01 §01.3 nothing remains, so the whitelist starts empty.
  const whitelist = new Set([]);
  const han = /\p{Script=Han}/u;
  const residues = Object.entries(dict.en)
    .filter(([, value]) => typeof value === "string" && han.test(value) && !whitelist.has(value))
    .map(([key, value]) => `${key}: ${value}`);
  assert.deepEqual(residues, []);
});

// ── plan-05 upgrades ─────────────────────────────────────────────────────────

test("reason/hint/evidence families are complete, bilingual and non-empty", () => {
  const dict = loadDict();
  for (const prefix of ["reason_", "hint_", "evidence_"]) {
    const zhKeys = Object.keys(dict.zh).filter((key) => key.startsWith(prefix)).sort();
    const enKeys = Object.keys(dict.en).filter((key) => key.startsWith(prefix)).sort();
    assert.deepEqual(enKeys, zhKeys, `${prefix}* keys match 1:1`);
    assert.ok(zhKeys.length > 0, `${prefix}* family is populated (${zhKeys.length})`);
    for (const key of zhKeys) {
      assert.equal(typeof dict.zh[key], "string");
      assert.ok(dict.zh[key].length > 0, `${key} zh value non-empty`);
      assert.equal(typeof dict.en[key], "string");
      assert.ok(dict.en[key].length > 0, `${key} en value non-empty`);
      assert.ok(!/\p{Script=Han}/u.test(dict.en[key]), `${key} en value has no Chinese`);
    }
  }
});

test("standalone label maps are derived views, not duplicated sources", () => {
  // plan-05 B.6: REASON_LABELS / ANALYSIS_ENUM_HINTS must be derived from
  // DICT (single source of truth) — the old literal blocks are gone.
  assert.equal(/var REASON_LABELS = \{\s*zh: \{/.test(source), false, "REASON_LABELS is no longer a literal map");
  assert.equal(/var ANALYSIS_ENUM_HINTS = \{\s*zh: \{/.test(source), false, "ANALYSIS_ENUM_HINTS is no longer a literal map");
  assert.ok(/dictPrefixedView\(DICT\.zh, "reason_"\)/.test(source), "REASON_LABELS derives from DICT");
});
