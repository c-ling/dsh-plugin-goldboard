import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const packageJson = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));
const read = (path) => readFileSync(new URL(`../${path}`, import.meta.url), "utf8");

test("stage-zero documentation stays aligned with the released package version", () => {
  const version = packageJson.version;
  for (const file of ["README.md", "README-en.md"]) {
    const source = read(file);
    const pins = [...source.matchAll(/#v(\d+\.\d+\.\d+)/g)].map((match) => match[1]);
    assert.ok(pins.length > 0, `${file} has install pins`);
    assert.ok(pins.every((pin) => pin === version), `${file} pins match package version`);
  }

  const design = read("DESIGN.md");
  const escapedVersion = version.replaceAll(".", "\\.");
  assert.match(design, new RegExp(`v${escapedVersion} 当前实现`));
  assert.match(design, /阶段 0 baseline 与证据状态/);
  assert.match(design, /evidenceStatus/);
  assert.doesNotMatch(design, /v1\.11\.0 当前实现/);

  const historical = read("docs/v1.11.0-strategy-optimization.md");
  assert.match(historical, /历史版本说明/);
  assert.match(historical, /探索性诊断/);
});

test("baseline and stage-one documents are included in the package manifest", () => {
  assert.ok(packageJson.files.includes("DESIGN.md"));
  assert.ok(packageJson.files.includes("docs/optimization-roadmap.md"));
  assert.ok(packageJson.files.includes("docs/stage-1-implementation-plan.md"));
  assert.ok(packageJson.files.includes("docs/v1.11.0-strategy-optimization.md"));
});

test("stage-one domain and testing subpaths are explicit package exports", () => {
  for (const subpath of ["./market-data", "./execution", "./history", "./replay", "./testing"]) {
    assert.equal(typeof packageJson.exports[subpath]?.default, "string", `${subpath} has a default export target`);
  }
});
