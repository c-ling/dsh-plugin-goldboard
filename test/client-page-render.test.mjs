import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import { normalizeConfig } from "../lib/config.js";

const SOURCE = readFileSync(new URL("../lib/client.js", import.meta.url), "utf8");

function loadClient() {
  let spec;
  const windowStub = { __ModuleLoader__: { load(value) { spec = value; } } };
  const style = { setAttribute() {}, dataset: {}, textContent: "" };
  const documentStub = {
    querySelector: () => null,
    createElement: () => style,
    head: { appendChild() {} },
    addEventListener() {},
    removeEventListener() {},
    dispatchEvent() {},
  };
  new Function("window", "document", SOURCE)(windowStub, documentStub);
  assert.ok(spec, "client bundle is captured");

  let index = 0;
  let seeds = {};
  const React = {
    Component: class { constructor(props) { this.props = props; this.state = {}; } setState() {} },
    createElement(type, props, ...children) { return { type, props: props || {}, children }; },
    memo: (fn) => fn,
    useState(initial) {
      const at = index++;
      if (Object.prototype.hasOwnProperty.call(seeds, at)) {
        const seeded = seeds[at];
        return [typeof seeded === "function" ? seeded() : seeded, () => {}];
      }
      return [typeof initial === "function" ? initial() : initial, () => {}];
    },
    useCallback: (fn) => fn,
    useEffect: () => {},
    useMemo: (fn) => fn(),
    useRef: (value) => ({ current: value }),
    useSyncExternalStore: () => null,
  };
  const client = spec.factory((id) => {
    if (id === "react") return React;
    throw new Error("unexpected require: " + id);
  });
  return {
    client,
    resetHooks() { index = 0; seeds = {}; },
    render(mode, options = {}) {
      index = 0;
      seeds = {
        0: options.data ?? { ok: true, config: normalizeConfig({}), secretSet: {}, revision: 0 },
        1: options.draft ?? normalizeConfig({}),
      };
      return client.SettingsSection({ t: (key) => key, mode });
    },
  };
}

function findNodes(node, predicate, out = []) {
  if (!node || typeof node !== "object") return out;
  if (Array.isArray(node)) {
    for (const child of node) findNodes(child, predicate, out);
    return out;
  }
  if (predicate(node)) out.push(node);
  findNodes(node.children, predicate, out);
  return out;
}

function sectionNodes(tree) {
  return findNodes(tree, (node) => typeof node.props?.className === "string" && node.props.className.includes("dsh-goldboard-section-"));
}

function classesOf(tree) {
  return sectionNodes(tree).map((node) => node.props.className);
}

test("trading mode renders trading sections", () => {
  const { render } = loadClient();
  const tree = render("trading");
  const classes = classesOf(tree);
  for (const name of ["position", "risk", "fee", "cmb", "manual-prev", "strategy", "trading"]) {
    assert.ok(classes.includes(`dsh-goldboard-section-${name}`), `${name} section rendered`);
  }
  assert.equal(tree.props["data-mode"], "trading");
  assert.ok(SOURCE.includes('data-mode=') && SOURCE.includes('.dsh-goldboard-section-alerts'), "CSS hides alert cards in trading mode");
  assert.equal(findNodes(tree, (node) => node.props?.className === "dsh-goldboard-settings-nav").length, 0, "top anchor nav removed");
  assert.equal(tree.props["data-mode"], "trading");
});

test("settings mode keeps only notification and webhook sections", () => {
  const { render } = loadClient();
  const tree = render("settings");
  const classes = classesOf(tree);
  assert.ok(classes.includes("dsh-goldboard-section-alerts"));
  assert.ok(classes.includes("dsh-goldboard-section-webhooks"));
  assert.ok(SOURCE.includes('data-mode=') && SOURCE.includes('.dsh-goldboard-section-position'), "CSS hides trading cards in settings mode");
  assert.equal(findNodes(tree, (node) => node.props?.className === "dsh-goldboard-settings-nav").length, 0);
});

test("strategy mode exposes replay statistics, experiments and the ledger summary", () => {
  const { client, render } = loadClient();
  const tree = render("strategy");
  const classes = classesOf(tree);
  assert.ok(classes.includes("dsh-goldboard-section-stats"));
  assert.ok(classes.includes("dsh-goldboard-section-ledger"));
  assert.ok(findNodes(tree, (node) => node.type === client.StrategyExperimentPanel).length === 1, "experiment panel mounted");
  assert.equal(findNodes(tree, (node) => node.props?.className === "dsh-goldboard-settings-nav").length, 0);
});

test("data mode exposes sources and manual CMB but no settings cards", () => {
  const { render } = loadClient();
  const tree = render("data");
  const classes = classesOf(tree);
  assert.ok(classes.includes("dsh-goldboard-section-sources"));
  assert.ok(classes.includes("dsh-goldboard-section-manual-cmb"));
  assert.equal(tree.props["data-mode"], "data");
  assert.ok(SOURCE.includes('data-mode=\\"data\\"') && SOURCE.includes('.dsh-goldboard-section-position'), "CSS hides settings cards in data mode");
  assert.ok(SOURCE.includes('data-mode=\\"data\\"') && SOURCE.includes('.dsh-goldboard-section-stats'), "CSS hides replay cards in data mode");
});

test("analysis mode exposes the model analysis section", () => {
  const { render } = loadClient();
  const tree = render("analysis");
  assert.ok(classesOf(tree).includes("dsh-goldboard-section-analysis"));
});

test("save bar exposes discard and save only when the draft is dirty", () => {
  const { render } = loadClient();
  const base = normalizeConfig({ fee: { sellPerGram: 5 } });
  const dirtyDraft = normalizeConfig({ fee: { sellPerGram: 8 } });
  const dirtyTree = render("trading", { data: { ok: true, config: base, secretSet: {}, revision: 2 }, draft: dirtyDraft });
  const dirtyBar = findNodes(dirtyTree, (node) => node.props?.className === "dsh-goldboard-workbench-actions")[0];
  assert.ok(dirtyBar, "save bar rendered");
  const dirtyButtons = findNodes(dirtyBar, (node) => node.props?.className === "dsh-goldboard-primary");
  assert.equal(dirtyButtons[0].props.disabled, false, "save is enabled for a dirty draft");

  const cleanTree = render("trading", { data: { ok: true, config: base, secretSet: {}, revision: 2 }, draft: base });
  const cleanBar = findNodes(cleanTree, (node) => node.props?.className === "dsh-goldboard-workbench-actions")[0];
  const cleanButtons = findNodes(cleanBar, (node) => node.props?.className === "dsh-goldboard-primary");
  assert.equal(cleanButtons[0].props.disabled, true, "save is disabled for a clean draft");
});

test("page shell renders six sidebar-page tabs with the overview selected", () => {
  const { client } = loadClient();
  const tree = client.PageTabs({ t: (key) => key, active: "overview", onChange: () => {} });
  const tabs = tree.children[0].children[0];
  assert.equal(tabs.length, 6);
  assert.equal(tabs[0].props["aria-selected"], true);
  assert.equal(tabs[1].props["aria-selected"], false);
  assert.equal(tabs[0].children[0], "tab_overview");
  assert.equal(tabs[1].children[0], "tab_trading");
  assert.equal(typeof client.GoldBoardPage, "function");
});

test("GoldBoardPage renders without a snapshot and mounts the hidden workbench", () => {
  const { client, resetHooks } = loadClient();
  resetHooks();
  const tree = client.GoldBoardPage({ t: (key) => key });
  assert.ok(tree, "page tree rendered");
  const workbench = findNodes(tree, (node) => node.type === client.SettingsSection);
  assert.equal(workbench.length, 1);
  assert.equal(workbench[0].props.mode, "trading");
  const overview = findNodes(tree, (node) => node.type === client.OverviewTab);
  assert.equal(overview.length, 1);
  const tabs = findNodes(tree, (node) => node.type?.name === "PageTabs");
  assert.equal(tabs.length, 1);
});

test("each tab saves only its own configuration sections", async () => {
  const { render } = loadClient();
  const base = normalizeConfig({ fee: { sellPerGram: 5 }, system: { enabled: false } });
  const draft = normalizeConfig({ fee: { sellPerGram: 8 }, system: { enabled: true } });
  const requests = [];
  const previousFetch = globalThis.fetch;
  globalThis.fetch = async (url, init) => {
    requests.push({ url: String(url), body: JSON.parse(init.body) });
    return {
      ok: true,
      status: 200,
      json: async () => ({ ok: true, config: draft, secretSet: {}, revision: 3 }),
    };
  };
  try {
    const tradingTree = render("trading", { data: { ok: true, config: base, secretSet: {}, revision: 2 }, draft });
    const tradingBar = findNodes(tradingTree, (node) => node.props?.className === "dsh-goldboard-workbench-actions")[0];
    const tradingSave = findNodes(tradingBar, (node) => node.props?.className === "dsh-goldboard-primary")[0];
    await tradingSave.props.onClick();
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(requests.length, 1);
    assert.match(requests[0].url, /\/api\/dsh-plugin-goldboard\/config$/);
    assert.ok("fee" in requests[0].body.config);
    assert.ok("position" in requests[0].body.config);
    assert.equal("system" in requests[0].body.config, false, "trading save does not write alert settings");
    assert.equal("webhooks" in requests[0].body.config, false);

    const settingsTree = render("settings", { data: { ok: true, config: base, secretSet: {}, revision: 2 }, draft });
    const settingsBar = findNodes(settingsTree, (node) => node.props?.className === "dsh-goldboard-workbench-actions")[0];
    const settingsSave = findNodes(settingsBar, (node) => node.props?.className === "dsh-goldboard-primary")[0];
    await settingsSave.props.onClick();
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(requests.length, 2);
    assert.deepEqual(Object.keys(requests[1].body.config).sort(), ["sidebarPrice", "system", "webhooks"]);
  } finally {
    globalThis.fetch = previousFetch;
  }
});
