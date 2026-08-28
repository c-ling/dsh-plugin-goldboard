import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { redactSecrets } from "@deepseek-ai/dsh-settings";

import {
  DEFAULT_CONFIG,
  SETTINGS_NAMESPACE,
  SETTINGS_SCHEMA,
  apply,
  normalizeConfig,
  redactConfig,
  sectionForSettingsStore,
} from "../lib/index.js";

// ── fakes ────────────────────────────────────────────────────────────────────

/** Deep merge used by the fake scope resolution (tests only need plain data). */
function deepMerge(base, over) {
  const out = Array.isArray(base) ? [...base] : { ...(base ?? {}) };
  for (const [key, value] of Object.entries(over ?? {})) {
    if (value !== null && typeof value === "object" && !Array.isArray(value)
      && out[key] !== null && typeof out[key] === "object" && !Array.isArray(out[key])) {
      out[key] = deepMerge(out[key], value);
    } else {
      out[key] = value;
    }
  }
  return out;
}

/**
 * Minimal SettingsProvider stand-in: register/update/replace/mutate/get/
 * describe plus per-namespace watcher fan-out, mirroring the containment
 * semantics installSettingsSection relies on (async, one at a time).
 */
function createFakeSettings({ writable = true, seedUser = {} } = {}) {
  const namespaces = new Map();
  let writeLog = [];

  function stateOf(ns) {
    if (!namespaces.has(ns)) {
      namespaces.set(ns, { schema: null, options: {}, user: seedUser[ns], watchers: [] });
    }
    return namespaces.get(ns);
  }

  async function emit(ns) {
    const state = stateOf(ns);
    const next = readScope(ns).get();
    for (const watcher of [...state.watchers]) {
      await Promise.resolve().then(() => watcher(next, next));
    }
  }

  function readScope(ns) {
    const state = stateOf(ns);
    return {
      get() {
        const base = state.schema ? state.schema(state.options.base ?? {}) : (state.options.base ?? {});
        return state.user === undefined ? base : deepMerge(base, state.user);
      },
      watch(callback) {
        state.watchers.push(callback);
        return () => {
          const index = state.watchers.indexOf(callback);
          if (index >= 0) state.watchers.splice(index, 1);
        };
      },
      async update(patch) {
        writeLog.push({ kind: "update", ns, patch });
        state.user = deepMerge(state.user ?? {}, patch);
        await emit(ns);
      },
      async replace(section) {
        writeLog.push({ kind: "replace", ns, section });
        state.user = section;
        await emit(ns);
      },
    };
  }

  return {
    writable,
    writes: writeLog,
    register(ns, schema, options = {}) {
      if (namespaces.has(ns) && namespaces.get(ns).schema) {
        throw new Error(`duplicate namespace: ${ns}`);
      }
      const state = stateOf(ns);
      state.schema = schema;
      state.options = options;
      return readScope(ns);
    },
    scopeOf(ns) {
      return readScope(ns);
    },
    get(ns) {
      return namespaces.has(ns) ? readScope(ns).get() : undefined;
    },
    describe() {
      return [...namespaces.entries()].map(([ns, state]) => ({
        ns,
        value: readScope(ns).get(),
        ...(state.user === undefined ? {} : { user: state.user }),
        revision: 1,
        applies: "live",
      }));
    },
    async update(ns, patch) {
      return readScope(ns).update(patch);
    },
    async replace(ns, section) {
      if (!writable) throw new Error("settings provider is read-only");
      return readScope(ns).replace(section);
    },
    async mutate(ns, ops) {
      let section = deepMerge(namespaces.get(ns)?.user ?? {}, {});
      for (const op of ops) {
        if (op.op === "set") {
          const [head, ...rest] = op.path;
          if (rest.length === 0) section[head] = op.value;
          else {
            section[head] = section[head] ?? {};
            section[head][rest[0]] = op.value;
          }
        } else if (op.op === "unset") {
          const [head] = op.path;
          delete section[head];
        }
      }
      return readScope(ns).replace(section);
    },
  };
}

/**
 * Fake plugin context. `inject` mimics cordis fibers: the callback runs on a
 * microtask ONLY when every requested service exists (no settings service →
 * the callback never fires, exercising the classic fallback).
 */
function makeCtx({ settings } = {}) {
  const effects = [];
  const routes = [];
  const warnings = [];
  const infos = [];
  const ctx = {
    logger: {
      warn: (line) => warnings.push(line),
      info: (line) => infos.push(line),
    },
    // dsh-settings' watch callbacks probe fiber state (isUnloading); any
    // non-teardown state keeps them live.
    fiber: { state: 2 },
    effect: (fn, label) => {
      const dispose = fn();
      effects.push({ label, dispose });
      return () => typeof dispose === "function" && dispose();
    },
    webServer: {
      register: (route) => routes.push(route),
    },
    inject(deps, callback) {
      if (deps.includes("settings") && !settings) return { dispose: () => {} };
      // The scoped context carries the service plus the effect surface
      // installSettingsSection registers its cleanup on.
      Promise.resolve().then(() => callback({ settings, effect: ctx.effect }));
      return { dispose: () => {} };
    },
  };
  return { ctx, effects, routes, warnings, infos };
}

async function drain(rounds = 30) {
  for (let i = 0; i < rounds; i += 1) await new Promise((resolve) => setImmediate(resolve));
  await new Promise((resolve) => setTimeout(resolve, 10));
}

/** Remove a temp dir, tolerating late async writes landing mid-unlink. */
async function rmRetry(dir, attempts = 4) {
  for (let i = 0; i < attempts; i += 1) {
    try {
      await rm(dir, { recursive: true, force: true });
      return;
    } catch (error) {
      if (i === attempts - 1) throw error;
      await new Promise((resolve) => setTimeout(resolve, 50 * (i + 1)));
    }
  }
}

function bufferReq(method, payload) {
  const chunks = payload === undefined ? [] : [Buffer.from(JSON.stringify(payload))];
  return {
    method,
    headers: {},
    async *[Symbol.asyncIterator]() {
      yield* chunks;
    },
  };
}

function resCapture() {
  return {
    status: 0,
    body: null,
    writeHead(status) {
      this.status = status;
    },
    end(body) {
      this.body = body;
    },
  };
}

async function withPlugin(options, run) {
  const dir = await mkdtemp(join(tmpdir(), "goldboard-plan04-"));
  const made = makeCtx(options);
  let runtime;
  try {
    runtime = apply(made.ctx, { directory: dir, pollMs: 600_000, ...options.config });
    await drain();
    return await run({ dir, runtime, ...made });
  } finally {
    // Dispose every effect (market loop interval, routes, …) so the test
    // process does not linger on the polling timer.
    for (const effect of made.effects.reverse()) {
      try {
        await effect.dispose?.();
      } catch {
        // Disposal failures must not mask the test outcome.
      }
    }
    await drain(5);
    await rmRetry(dir);
  }
}

// ── 04.1 schema & registration ──────────────────────────────────────────────

test("schema resolution mirrors DEFAULT_CONFIG through normalizeConfig", () => {
  const resolved = SETTINGS_SCHEMA({});
  assert.deepEqual(
    normalizeConfig(resolved),
    normalizeConfig(DEFAULT_CONFIG),
    "schema defaults resolve to the canonical normalized shape",
  );
});

test("schema rejects a signal score threshold above the real maximum", () => {
  assert.throws(
    () => SETTINGS_SCHEMA({ strategy: { scoreThreshold: 9 } }),
    /scoreThreshold|8|greater/i,
  );
});

test("schema marks webhook secrets and redactSecrets strips exactly those paths", () => {
  const value = SETTINGS_SCHEMA({
    webhooks: {
      feishu: { enabled: true, url: "https://feishu.example/hook", secret: "s3cret" },
      dingtalk: { secret: "ding-secret" },
      wecom: { url: "https://wecom.example/hook" },
    },
  });
  const redacted = redactSecrets(SETTINGS_SCHEMA, value);
  assert.equal(redacted.value.webhooks.feishu.secret, undefined, "feishu secret removed");
  assert.equal(redacted.value.webhooks.dingtalk.secret, undefined, "dingtalk secret removed");
  assert.equal(redacted.value.webhooks.feishu.url, "https://feishu.example/hook", "non-secret fields survive");
  const paths = redacted.secrets.map((secret) => secret.path.join(".")).sort();
  assert.deepEqual(paths, ["webhooks.dingtalk.secret", "webhooks.feishu.secret"]);
  assert.deepEqual(redacted.secrets.map((secret) => secret.set).sort(), [true, true]);
});

test("an unset secret resolves absent so wire redaction reports set:false", () => {
  // No materialized default on role('secret') fields: resolution must omit
  // them until a value is stored, or every field would look configured.
  const resolved = SETTINGS_SCHEMA({ webhooks: { feishu: { enabled: true, url: "https://x" } } });
  assert.equal(resolved.webhooks.feishu.secret, undefined);
  const redacted = redactSecrets(SETTINGS_SCHEMA, resolved);
  const byPath = new Map(redacted.secrets.map((secret) => [secret.path.join("."), secret.set]));
  assert.equal(byPath.get("webhooks.feishu.secret"), false);
  assert.equal(byPath.get("webhooks.dingtalk.secret"), false);

  const withSecret = SETTINGS_SCHEMA({ webhooks: { feishu: { secret: "abc" } } });
  const redactedSet = redactSecrets(SETTINGS_SCHEMA, withSecret);
  const setMap = new Map(redactedSet.secrets.map((secret) => [secret.path.join("."), secret.set]));
  assert.equal(setMap.get("webhooks.feishu.secret"), true);
});

test("sectionForSettingsStore drops only empty secret leaves", () => {
  const section = sectionForSettingsStore(normalizeConfig({
    webhooks: {
      feishu: { url: "https://feishu.example/hook", secret: "" },
      dingtalk: { secret: "keep-me" },
    },
  }));
  assert.equal("secret" in section.webhooks.feishu, false, "empty secret stripped from the store view");
  assert.equal(section.webhooks.dingtalk.secret, "keep-me", "configured secret kept");
  assert.equal(section.webhooks.feishu.url, "https://feishu.example/hook", "siblings untouched");
});

test("apply registers the goldboard namespace once and adopts the resolved value", async () => {
  const settings = createFakeSettings({
    seedUser: { [SETTINGS_NAMESPACE]: { fee: { buyPerGram: 9 } } },
  });
  await withPlugin({ settings }, async ({ runtime }) => {
    assert.equal(runtime.config.fee.buyPerGram, 9, "seeded user layer wins over entry base");
    assert.equal(runtime.config.fee.sellPerGram, DEFAULT_CONFIG.fee.sellPerGram, "schema default fills siblings");
  });
});

test("a committed settings change re-judges the runtime config via onChange", async () => {
  const settings = createFakeSettings();
  await withPlugin({ settings }, async ({ runtime }) => {
    assert.equal(runtime.config.cmb.buySpreadPerGram, DEFAULT_CONFIG.cmb.buySpreadPerGram);
    // An external writer commits through the provider; the scope watcher must
    // fan out into onChange → adoptConfigSource.
    await settings.scopeOf(SETTINGS_NAMESPACE).update({
      cmb: { buySpreadPerGram: 2.04, sellSpreadPerGram: 2.04 },
    });
    assert.equal(runtime.config.cmb.buySpreadPerGram, 2.04, "commit adopted by the runtime");
    assert.equal(runtime.config.fee.sellPerGram, DEFAULT_CONFIG.fee.sellPerGram, "untouched fields keep their resolution");
  });
});

// ── 04.2 legacy migration ───────────────────────────────────────────────────

/** Boot the plugin against an explicit dir + settings service; returns a disposer. */
function bootWithSettings(dir, settings, config = {}) {
  const made = makeCtx({});
  made.ctx.inject = (deps, callback) => {
    if (deps.includes("settings") && settings) {
      Promise.resolve().then(() => callback({ settings, effect: made.ctx.effect }));
    }
    return { dispose: () => {} };
  };
  const runtime = apply(made.ctx, { directory: dir, pollMs: 600_000, ...config });
  const dispose = async () => {
    for (const effect of made.effects.reverse()) {
      try {
        await effect.dispose?.();
      } catch {
        // Ignore disposal failures in tests.
      }
    }
    await drain(5);
  };
  return { runtime, routes: made.routes, warnings: made.warnings, infos: made.infos, dispose };
}

test("first boot migrates legacy config.json into the namespace and archives it", async () => {
  const legacy = {
    fee: { buyPerGram: 2.5, sellPerGram: 6 },
    strategy: { confirmBars: 4 },
    webhooks: { feishu: { secret: "" } },
  };
  const dir = await mkdtemp(join(tmpdir(), "goldboard-plan04-"));
  const settings = createFakeSettings();
  let booted;
  try {
    await writeFile(join(dir, "config.json"), JSON.stringify(legacy), "utf8");
    booted = bootWithSettings(dir, settings);
    await drain();

    const replaceWrite = settings.writes.find((write) => write.kind === "replace" && write.ns === SETTINGS_NAMESPACE);
    assert.ok(replaceWrite, "namespace seeded via wholesale replace");
    assert.equal(replaceWrite.section.fee.buyPerGram, 2.5, "legacy fee survives normalization");
    assert.equal(replaceWrite.section.strategy.confirmBars, 4, "legacy strategy survives normalization");
    assert.equal("secret" in replaceWrite.section.webhooks.feishu, false, "empty secret not stored as configured");
    assert.equal(existsSync(join(dir, "config.json")), false, "classic file retired…");
    const archived = JSON.parse(await readFile(join(dir, "config.json.migrated"), "utf8"));
    assert.deepEqual(archived, legacy, "…and archived untouched for rollback");
    assert.equal(booted.runtime.config.fee.buyPerGram, 2.5, "runtime adopted the migrated values");
  } finally {
    if (booted) await booted.dispose();
    await rmRetry(dir);
  }
});

test("an existing user section is never clobbered by a stale config.json", async () => {
  const dir = await mkdtemp(join(tmpdir(), "goldboard-plan04-"));
  const settings = createFakeSettings({
    seedUser: { [SETTINGS_NAMESPACE]: { fee: { buyPerGram: 8 } } },
  });
  let booted;
  try {
    await writeFile(join(dir, "config.json"), JSON.stringify({ fee: { buyPerGram: 1 } }), "utf8");
    booted = bootWithSettings(dir, settings);
    await drain();

    assert.equal(settings.writes.length, 0, "no seeding write when the user layer already exists");
    assert.equal(existsSync(join(dir, "config.json")), false, "stale classic file still archived");
    assert.equal(booted.runtime.config.fee.buyPerGram, 8, "newer settings value kept");
  } finally {
    if (booted) await booted.dispose();
    await rmRetry(dir);
  }
});

// ── 04.3 route behaviour in both modes ──────────────────────────────────────

test("fallback mode keeps the classic config.json round-trip", async () => {
  await withPlugin({}, async ({ routes, dir }) => {
    const configRoute = routes.find((route) => route.path === "/dsh-plugin-goldboard/config");
    assert.ok(configRoute, "GET/POST /config registered");

    const postRes = resCapture();
    await configRoute.handler(bufferReq("POST", { config: { fee: { buyPerGram: 3.25 } } }), postRes);
    assert.equal(postRes.status, 200);
    const body = JSON.parse(postRes.body);
    assert.equal(body.ok, true);
    assert.equal(body.config.fee.buyPerGram, 3.25);

    const stored = JSON.parse(await readFile(join(dir, "config.json"), "utf8"));
    assert.equal(stored.fee.buyPerGram, 3.25, "classic persistence intact");

    const getRes = resCapture();
    await configRoute.handler({ method: "GET", headers: {} }, getRes);
    const getBody = JSON.parse(getRes.body);
    assert.equal(getBody.config.fee.buyPerGram, 3.25);
    assert.equal(getBody.config.webhooks.feishu.secret, "", "secrets blanked on the wire");
    assert.equal(getBody.secretSet["webhooks.feishu.secret"], false);
  });
});

test("provider mode writes POST /config through the settings service", async () => {
  const dir = await mkdtemp(join(tmpdir(), "goldboard-plan04-"));
  const settings = createFakeSettings();
  let booted;
  try {
    booted = bootWithSettings(dir, settings);
    await drain();
    const runtime = booted.runtime;
    const configRoute = booted.routes.find((route) => route.path === "/dsh-plugin-goldboard/config");

    const postRes = resCapture();
    await configRoute.handler(bufferReq("POST", { config: { fee: { buyPerGram: 7 } } }), postRes);
    assert.equal(postRes.status, 200);
    const body = JSON.parse(postRes.body);
    assert.equal(body.ok, true);
    assert.equal(body.config.fee.buyPerGram, 7);

    const replaceWrite = settings.writes.find((write) => write.kind === "replace" && write.ns === SETTINGS_NAMESPACE);
    assert.ok(replaceWrite, "write persisted through the namespace");
    assert.equal(replaceWrite.section.fee.buyPerGram, 7);
    assert.equal(existsSync(join(dir, "config.json")), false, "config.json not resurrected in provider mode");
    assert.equal(runtime.config.fee.buyPerGram, 7);
  } finally {
    if (booted) await booted.dispose();
    await rmRetry(dir);
  }
});

test("a read-only provider falls back to classic persistence", async () => {
  const dir = await mkdtemp(join(tmpdir(), "goldboard-plan04-"));
  const settings = createFakeSettings({ writable: false });
  let booted;
  try {
    booted = bootWithSettings(dir, settings);
    await drain();
    const runtime = booted.runtime;
    const configRoute = booted.routes.find((route) => route.path === "/dsh-plugin-goldboard/config");

    const postRes = resCapture();
    await configRoute.handler(bufferReq("POST", { config: { system: { enabled: true } } }), postRes);
    assert.equal(postRes.status, 200);
    assert.equal(JSON.parse(postRes.body).config.system.enabled, true);
    const stored = JSON.parse(await readFile(join(dir, "config.json"), "utf8"));
    assert.equal(stored.system.enabled, true, "classic file carries the write instead");
    assert.equal(settings.writes.length, 0, "read-only provider untouched");
    assert.equal(runtime.config.system.enabled, true);
  } finally {
    if (booted) await booted.dispose();
    await rmRetry(dir);
  }
});

// ── legacy redaction regression ─────────────────────────────────────────────

test("redactConfig keeps blanking secrets and reporting secretSet", () => {
  const view = redactConfig(normalizeConfig({
    webhooks: { feishu: { enabled: true, url: "https://x", secret: "abc" } },
  }));
  assert.equal(view.config.webhooks.feishu.secret, "");
  assert.deepEqual(view.secretSet, {
    "webhooks.feishu.secret": true,
    "webhooks.dingtalk.secret": false,
  });
});
