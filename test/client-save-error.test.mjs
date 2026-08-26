import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

// The client half is a browser bundle without module exports. The settings-
// document failure classifier (v1.9.1) is self-contained pure code, so it is
// sliced out of the source text and evaluated directly — same approach as
// client-chart.test.mjs.
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

function loadClassifier() {
  const marker = "function settingsDocFailure(rawError)";
  const start = source.indexOf(marker);
  assert.ok(start > 0, "settingsDocFailure found in lib/client.js");
  const braceStart = source.indexOf("{", start);
  const block = source.slice(start, balancedBraces(source, braceStart));
  return new Function(`"use strict"; ${block}; return settingsDocFailure;`)();
}

const classify = loadClassifier();

test("classifies a corrupt shared settings document and extracts its path", () => {
  // Real-world shape from dsh-settings-file (FileSettingsProvider.parse).
  const raw = "settings-file: invalid document at /Users/x/.dsh/settings.yaml: BAD_INDENT at line 25, column 1; UNEXPECTED_TOKEN at line 26, column 17";
  assert.deepEqual(classify(raw), { path: "/Users/x/.dsh/settings.yaml" });
});

test("classification tolerates case and missing path detail", () => {
  assert.deepEqual(classify("Settings-File: Invalid Document at custom.yaml: BAD_INDENT"), { path: "custom.yaml" });
  assert.deepEqual(classify("settings-file: invalid document"), { path: "~/.dsh/settings.yaml" });
});

test("ordinary save failures are not misclassified", () => {
  assert.equal(classify("settings write failed"), null);
  assert.equal(classify("HTTP 500 INTERNAL_ERROR"), null);
  assert.equal(classify("revision conflict: expected 7, got 8"), null);
  assert.equal(classify(""), null);
  assert.equal(classify(null), null);
  assert.equal(classify(undefined), null);
  assert.equal(classify(42), null);
});

test("both save paths funnel failures through reportSaveFailure", () => {
  // Every raw `setStatus(format(t, "saveError"...))` call must live INSIDE
  // the reporting funnel — the save flows themselves never format saveError.
  const funnelStart = source.indexOf("var reportSaveFailure = function");
  assert.ok(funnelStart > 0, "reporting funnel exists");
  const braceAt = source.indexOf("{", funnelStart);
  const funnelEnd = balancedBraces(source, braceAt);
  const sites = [...source.matchAll(/setStatus\(format\(t, "saveError"/g)].map((m) => m.index);
  assert.ok(sites.length > 0, "funnel formats saveError exactly through setStatus");
  for (const at of sites) {
    assert.ok(at > funnelStart && at < funnelEnd, `inline saveError at offset ${at} escaped the funnel`);
  }
});
