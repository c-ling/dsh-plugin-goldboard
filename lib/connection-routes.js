/**
 * Fetch adapter for the plugin's existing Node-style route handlers.
 *
 * DeepSeek Harness 0.2.1 exposes plugin routes through
 * `ctx.connection.fetch.register({ path, methods, requestBody, fetch })`.
 * The goldboard route table predates that seam and is written against
 * node:http `(req, res)` handlers; rewriting all 17 handlers would be a large
 * behavioural change. This module is the thin, individually tested seam that
 * translates one Fetch `Request` into the minimal Node request surface those
 * handlers use and captures `writeHead`/`end` into a Fetch `Response`.
 *
 * It deliberately supports only the members the route table touches:
 * `req.method`, `req.url`, `req.headers`, async iteration over the body,
 * `res.writeHead`, `res.end`, `res.headersSent`, `res.writableEnded`,
 * `res.writableFinished`, and `res.on`/`off` (client-disconnect signals).
 */

import { EventEmitter } from "node:events";

/** Upper bound for one buffered route body. Replay accepts up to 2 MiB. */
export const MAX_ROUTE_BODY_BYTES = 2 * 1024 * 1024;

const JSON_HEADERS = Object.freeze({
  "content-type": "application/json; charset=utf-8",
  "cache-control": "no-store",
});

function jsonResponse(status, value, headers = {}) {
  return new Response(JSON.stringify(value), {
    status,
    headers: { ...JSON_HEADERS, ...headers },
  });
}

function bodyTooLarge() {
  return jsonResponse(413, {
    ok: false,
    error: { code: "PAYLOAD_TOO_LARGE" },
  });
}

/** Node-like response whose writes become one Fetch `Response`. */
export class FetchRouteResponse extends EventEmitter {
  constructor() {
    super();
    this.status = 200;
    this.headers = {};
    this.chunks = [];
    this.headersSent = false;
    this.writableEnded = false;
    this.writableFinished = false;
  }

  writeHead(status, headers = {}) {
    this.status = Number(status) || 200;
    const next = {};
    for (const [key, value] of Object.entries(headers ?? {})) {
      if (value !== undefined && value !== null) next[key] = String(value);
    }
    this.headers = next;
    this.headersSent = true;
  }

  end(body = null) {
    if (body !== undefined && body !== null) {
      this.chunks.push(Buffer.isBuffer(body) ? body : Buffer.from(String(body)));
    }
    this.writableEnded = true;
    this.writableFinished = true;
  }

  /** Build the Fetch response; content-length is left to the runtime. */
  toResponse() {
    const payload = this.chunks.length === 0 ? null : Buffer.concat(this.chunks);
    const headers = new Headers();
    for (const [key, value] of Object.entries(this.headers)) {
      if (key.toLowerCase() === "content-length") continue;
      headers.set(key, value);
    }
    return new Response(payload, { status: this.status, headers });
  }
}

/** Build the minimal node:http request the existing handlers consume. */
export function createRouteRequest(request, url, body) {
  const headers = {};
  for (const [key, value] of request.headers) headers[key.toLowerCase()] = value;
  return {
    method: String(request.method ?? "GET").toUpperCase(),
    url: `${url.pathname}${url.search}`,
    headers,
    async *[Symbol.asyncIterator]() {
      if (body.length > 0) yield body;
    },
  };
}

/**
 * Wrap one Node-style route handler as an authenticated Fetch handler.
 *
 * @param {(req: object, res: FetchRouteResponse) => Promise<void>|void} handler
 * @param {{ maxBodyBytes?: number }} [options]
 * @returns {(request: Request) => Promise<Response>}
 */
export function toFetchHandler(handler, options = {}) {
  const maxBodyBytes = Number(options.maxBodyBytes) > 0 ? Number(options.maxBodyBytes) : MAX_ROUTE_BODY_BYTES;
  return async function fetchRoute(request) {
    const url = new URL(request.url);
    const declared = Number(request.headers.get("content-length"));
    if (Number.isFinite(declared) && declared > maxBodyBytes) return bodyTooLarge();

    let body = Buffer.alloc(0);
    if (request.method !== "GET" && request.method !== "HEAD") {
      try {
        body = Buffer.from(await request.arrayBuffer());
      } catch {
        return jsonResponse(400, { ok: false, error: { code: "BAD_REQUEST_BODY" } });
      }
      if (body.length > maxBodyBytes) return bodyTooLarge();
    }

    const nodeRequest = createRouteRequest(request, url, body);
    const nodeResponse = new FetchRouteResponse();
    const onAbort = () => {
      if (!nodeResponse.writableFinished) nodeResponse.emit("close");
    };
    request.signal?.addEventListener?.("abort", onAbort);
    try {
      await handler(nodeRequest, nodeResponse);
    } catch (error) {
      if (!nodeResponse.headersSent) {
        return jsonResponse(500, {
          ok: false,
          error: {
            code: "INTERNAL_ERROR",
            message: String(error?.message ?? error).slice(0, 300),
          },
        });
      }
      nodeResponse.end();
    } finally {
      request.signal?.removeEventListener?.("abort", onAbort);
    }
    return nodeResponse.toResponse();
  };
}

/**
 * Project a `createRoutes()` table into `ctx.connection.fetch.register`
 * entries. Every goldboard endpoint is method-dispatched inside its handler,
 * so the route owns both GET and POST.
 *
 * @param {{ path: string, handler: Function }[]} routes
 * @param {{ maxBodyBytes?: number }} [options]
 */
export function createFetchRoutes(routes, options = {}) {
  return routes.map((entry) => ({
    path: entry.path,
    methods: ["GET", "POST"],
    requestBody: "buffered",
    fetch: toFetchHandler(entry.handler, options),
  }));
}
