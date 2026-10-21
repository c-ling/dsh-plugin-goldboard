import assert from "node:assert/strict";
import test from "node:test";

import { MAX_ROUTE_BODY_BYTES, createFetchRoutes, toFetchHandler } from "../lib/connection-routes.js";
import { route } from "../lib/routes.js";

function jsonRead(res, status, value) {
  const body = JSON.stringify(value);
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store",
    "content-length": Buffer.byteLength(body),
  });
  res.end(body);
}

test("fetch adapter preserves method URL query headers status and JSON envelope", async () => {
  const handler = async (req, res) => {
    jsonRead(res, 201, {
      method: req.method,
      url: req.url,
      locale: req.headers["x-dsh-locale"] ?? null,
      host: req.headers.host ?? null,
    });
  };
  const routeHandler = toFetchHandler(handler);
  const response = await routeHandler(new Request("http://127.0.0.1:1234/api/plugin/snapshot?x=1", {
    method: "GET",
    headers: { "x-dsh-locale": "en", host: "127.0.0.1:1234" },
  }));
  assert.equal(response.status, 201);
  assert.equal(response.headers.get("content-type"), "application/json; charset=utf-8");
  assert.equal(response.headers.get("cache-control"), "no-store");
  assert.deepEqual(await response.json(), {
    method: "GET",
    url: "/api/plugin/snapshot?x=1",
    locale: "en",
    host: "127.0.0.1:1234",
  });
});

test("fetch adapter delivers a buffered POST body through async iteration", async () => {
  const handler = async (req, res) => {
    let body = "";
    for await (const chunk of req) body += chunk.toString("utf8");
    jsonRead(res, 200, { ok: true, body, contentType: req.headers["content-type"] });
  };
  const response = await toFetchHandler(handler)(new Request("http://local/api/plugin/config", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ hello: "世界" }),
  }));
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), {
    ok: true,
    body: JSON.stringify({ hello: "世界" }),
    contentType: "application/json",
  });
});

test("fetch adapter rejects oversized bodies before the handler runs", async () => {
  let called = false;
  const response = await toFetchHandler(async (_req, res) => {
    called = true;
    jsonRead(res, 200, { ok: true });
  }, { maxBodyBytes: 8 })(new Request("http://local/api/plugin/config", {
    method: "POST",
    body: "123456789",
  }));
  assert.equal(called, false);
  assert.equal(response.status, 413);
  assert.equal((await response.json()).error.code, "PAYLOAD_TOO_LARGE");
});

test("fetch adapter returns the 405 envelope for a method the route does not own", async () => {
  const handler = route({
    GET: async (_req, res) => jsonRead(res, 200, { ok: true }),
  });
  const response = await toFetchHandler(handler)(new Request("http://local/api/plugin/snapshot", { method: "POST" }));
  assert.equal(response.status, 405);
  assert.equal((await response.json()).error.code, "METHOD_NOT_ALLOWED");
});

test("fetch adapter turns an unwritten handler crash into a 500 JSON envelope", async () => {
  const response = await toFetchHandler(async () => {
    throw new Error("boom");
  })(new Request("http://local/api/plugin/snapshot"));
  assert.equal(response.status, 500);
  const body = await response.json();
  assert.equal(body.ok, false);
  assert.equal(body.error.code, "INTERNAL_ERROR");
  assert.match(body.error.message, /boom/);
});

test("fetch adapter forwards a client abort as res close without finishing the response", async () => {
  let upstreamAborted = false;
  let started;
  const startedPromise = new Promise((resolve) => { started = resolve; });
  const handler = async (_req, res) => {
    await new Promise((resolve) => {
      res.on("close", () => {
        upstreamAborted = res.writableFinished !== true;
        resolve();
      });
      started();
    });
    if (!res.headersSent) jsonRead(res, 200, { ok: false, status: "cancelled" });
  };
  const controller = new AbortController();
  const pending = toFetchHandler(handler)(new Request("http://local/api/plugin/replay-stats", {
    method: "POST",
    signal: controller.signal,
    body: "{}",
  }));
  await startedPromise;
  controller.abort();
  const response = await pending;
  assert.equal(upstreamAborted, true);
  assert.equal(response.status, 200);
  assert.equal((await response.json()).status, "cancelled");
});

test("createFetchRoutes exposes authenticated /api paths with GET+POST", () => {
  const entries = createFetchRoutes([
    { path: "/api/dsh-plugin-goldboard/config", handler: async () => {} },
  ]);
  assert.equal(entries.length, 1);
  assert.equal(entries[0].path, "/api/dsh-plugin-goldboard/config");
  assert.equal(entries[0].path.startsWith("/api/"), true);
  assert.deepEqual(entries[0].methods, ["GET", "POST"]);
  assert.equal(entries[0].requestBody, "buffered");
  assert.equal(typeof entries[0].fetch, "function");
  assert.equal(MAX_ROUTE_BODY_BYTES, 2 * 1024 * 1024);
});
