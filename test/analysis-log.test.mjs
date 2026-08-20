import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AnalysisLogStore } from "../lib/analysis-log.js";
import { sanitizeModelOutput } from "../lib/analysis.js";

test("analysis log detail preserves redacted model output for schema failures", async () => {
  const directory = await mkdtemp(join(tmpdir(), "goldboard-analysis-log-"));
  const store = new AnalysisLogStore({ file: join(directory, "analysis.jsonl") });
  await store.start({ queryId: "q-1", provider: "bai", model: "deepseek-v4-flash" });
  await store.finish("q-1", {
    status: "invalid",
    result: null,
    modelOutput: sanitizeModelOutput(JSON.stringify({ support: ["970"], apiKey: "should-not-persist" })),
    error: { code: "INVALID_SCHEMA", message: "support[0] must be a finite number" },
  });

  const detail = store.query({ queryId: "q-1", detail: true });
  assert.equal(detail.ok, true);
  assert.equal(detail.logs[0].modelOutput, '{"support":["970"],"apiKey":"[redacted]"}');
  assert.equal(detail.logs[0].error.message, "support[0] must be a finite number");

  const persisted = await readFile(join(directory, "analysis.jsonl"), "utf8");
  assert.match(persisted, /support\[0\] must be a finite number/);
  assert.doesNotMatch(persisted, /should-not-persist/);
});
