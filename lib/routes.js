/**
 * HTTP surface: one registration per path, method-dispatched through a
 * shared `route()` helper (405 envelope, payload cap, error envelopes, outer
 * 500 safety net) plus the full goldboard path table.
 *
 * plan-05: extracted from the old monolithic lib/index.js. Handlers receive
 * everything they need through the explicit `deps` object — no module state.
 */

import { filterBarsToTradingHours } from "./market-time.js";
import { BAR_INTERVALS, applyManualCmbMinuteBars, listMissingCmbMinuteSlots, parseManualCmbMinuteEntries } from "./bars.js";
import { barsView, replayMarketPlan, snapshotCacheStale } from "./snapshot.js";
import {
  buildAlertMessage,
  mergeTestConfig,
  renderWebhookTemplate,
  sendDingtalk,
  sendFeishu,
  sendGeneric,
  sendWecom,
  systemNotify,
} from "./alerts.js";
import {
  mergeConfigPatch,
  mergeSecrets,
  normalizeConfig,
  redactConfig,
  str,
} from "./config.js";
import { computePlan } from "./plan.js";

/** Request-body byte cap for JSON routes. */
export const MAX_CONFIG_BYTES = 256 * 1024;
/** /replay accepts full bar histories; cap is higher but still bounded. */
export const MAX_REPLAY_BYTES = 2 * 1024 * 1024;

function sendJson(res, status, value) {
  const body = JSON.stringify(value);
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store",
    "content-length": Buffer.byteLength(body),
  });
  res.end(body);
}

async function readBody(req, limit = MAX_CONFIG_BYTES) {
  let size = 0;
  const chunks = [];
  for await (const chunk of req) {
    size += chunk.length;
    if (size > limit) {
      const error = new Error("body too large");
      error.code = "PAYLOAD_TOO_LARGE";
      throw error;
    }
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}

/**
 * Method-dispatching route wrapper.
 *
 * - Unknown method → 405 METHOD_NOT_ALLOWED envelope.
 * - Handler exceptions keep their own inner mapping (409/413/422/…); anything
 *   that escapes gets a well-formed 500 envelope instead of the harness's
 *   bare 400 (plan-03 03.4). The message is a sanitized summary.
 *
 * @param {{ GET?, POST? }} handlers per-method async `(req, res)` handlers
 */
export function route(handlers) {
  return async (req, res) => {
    const handler = handlers[req.method];
    if (!handler) {
      sendJson(res, 405, { ok: false, error: { code: "METHOD_NOT_ALLOWED" } });
      return;
    }
    try {
      await handler(req, res);
    } catch (error) {
      if (res.headersSent !== true) {
        try {
          sendJson(res, 500, {
            ok: false,
            error: { code: "INTERNAL_ERROR", message: String(error?.message ?? error).slice(0, 300) },
          });
        } catch {
          // Socket already gone while reporting the failure — nothing to do.
        }
        return;
      }
      try { res.end(); } catch { /* response already terminated */ }
    }
  };
}

/**
 * Build the goldboard route table.
 *
 * @param deps actions bound to the live plugin instance:
 *   - runtime               mutable runtime (quotes/bars/config/localeHint/lastSnapshot)
 *   - analysisModule        AnalysisModule instance
 *   - analysisLogStore      AnalysisLogStore instance
 *   - registry              SourceRegistry instance (data-sources / api-logs)
 *   - applyNextConfig(next) persist + adopt a validated config (settings branch included)
 *   - validateAnalysisConfig(next) throw on unusable analysis settings
 *   - persistState()        force a state.json flush
 *   - refreshSnapshot(now?) rebuild + cache the dashboard snapshot
 *   - replayStats           createReplayStats() engine (POST/GET /replay-stats)
 */
export function createRoutes(deps) {
  const {
    runtime,
    analysisModule,
    analysisLogStore,
    registry,
    applyNextConfig,
    validateAnalysisConfig,
    persistState,
    refreshSnapshot,
  } = deps;

  return [
    {
      path: "/dsh-plugin-goldboard/config",
      handler: route({
        GET: async (req, res) => {
          sendJson(res, 200, { ok: true, ...redactConfig(runtime.config) });
        },
        POST: async (req, res) => {
          try {
            const body = JSON.parse((await readBody(req)).toString("utf8"));
            const merged = mergeSecrets(runtime.config, body?.config, body?.clearSecrets);
            // plan-03 03.5: deep-merge the patch over the stored config so a
            // partial payload no longer resets untouched sections; unknown
            // top-level keys are rejected with UNKNOWN_CONFIG_KEY.
            const nextConfig = normalizeConfig(mergeConfigPatch(runtime.config, merged));
            await validateAnalysisConfig(nextConfig);
            await applyNextConfig(nextConfig);
            sendJson(res, 200, { ok: true, ...redactConfig(runtime.config) });
          } catch (error) {
            sendJson(res, error?.code === "PAYLOAD_TOO_LARGE" ? 413 : 400, {
              ok: false,
              error: { code: error?.code ?? "BAD_CONFIG", message: String(error?.message ?? error) },
            });
          }
        },
      }),
    },
    {
      path: "/dsh-plugin-goldboard/models",
      handler: route({
        GET: async (req, res) => {
          try {
            sendJson(res, 200, { ok: true, ...(await analysisModule.models()) });
          } catch (error) {
            sendJson(res, 503, { ok: false, error: { code: "MODEL_CATALOG_UNAVAILABLE" } });
          }
        },
      }),
    },
    {
      path: "/dsh-plugin-goldboard/analysis",
      handler: route({
        GET: async (req, res) => {
          sendJson(res, 200, { ok: true, ...analysisModule.status() });
        },
        POST: async (req, res) => {
          try {
            const body = JSON.parse((await readBody(req)).toString("utf8"));
            const currentAsOf = runtime.lastSnapshot?.serverTime;
            if (body?.snapshotAsOf && currentAsOf && body.snapshotAsOf !== currentAsOf) {
              sendJson(res, 409, {
                ok: false,
                status: "stale_snapshot",
                error: { code: "SNAPSHOT_CHANGED" },
                snapshotAsOf: currentAsOf,
              });
              return;
            }
            const result = await analysisModule.run({
              force: body?.force === true,
              provider: str(body?.provider, 128),
              model: str(body?.model, 256),
              reasoningEffort: str(body?.reasoningEffort, 64),
              locale: body?.locale === "en" ? "en" : "zh",
            });
            refreshSnapshot();
            const status = result.ok ? 200 : result.status === "blocked" ? 422 : result.error?.code === "ANALYSIS_DISABLED" ? 409 : 400;
            sendJson(res, status, result);
          } catch (error) {
            sendJson(res, error?.code === "PAYLOAD_TOO_LARGE" ? 413 : 400, {
              ok: false,
              status: "error",
              error: { code: error?.code ?? "BAD_ANALYSIS_REQUEST" },
            });
          }
        },
      }),
    },
    {
      path: "/dsh-plugin-goldboard/analysis-logs",
      handler: route({
        GET: async (req, res) => {
          const url = new URL(req.url ?? "/", "http://x");
          sendJson(res, 200, analysisLogStore.query({
            limit: url.searchParams.get("limit"),
            cursor: url.searchParams.get("cursor"),
            queryId: url.searchParams.get("queryId"),
            status: url.searchParams.get("status"),
            provider: url.searchParams.get("provider"),
            model: url.searchParams.get("model"),
            from: url.searchParams.get("from"),
            to: url.searchParams.get("to"),
            detail: url.searchParams.get("detail") === "true",
          }));
        },
      }),
    },
    {
      path: "/dsh-plugin-goldboard/snapshot",
      handler: route({
        GET: async (req, res) => {
          const localeHint = String(req.headers["x-dsh-locale"] ?? "").toLowerCase() === "en" ? "en" : "zh";
          // Notification-language hint is session-only memory (v1.4.0): the
          // flip used to force a full state.json write per locale change.
          if (localeHint !== runtime.localeHint) runtime.localeHint = localeHint;
          // Serve the cached snapshot for repeated requests (poll bursts,
          // parallel tabs); ticks already rebuild it every poll cycle.
          if (!runtime.lastSnapshot || snapshotCacheStale(runtime.lastSnapshotBuiltAt, Date.now())) {
            runtime.plan = computePlan(runtime, runtime.config);
            refreshSnapshot();
          }
          sendJson(res, 200, runtime.lastSnapshot);
        },
      }),
    },
    {
      path: "/dsh-plugin-goldboard/bars",
      handler: route({
        GET: async (req, res) => {
          const url = new URL(req.url ?? "/", "http://x");
          const instrument = String(url.searchParams.get("instrument") ?? "AU9999");
          const interval = Number(url.searchParams.get("interval") ?? 5);
          const limit = Math.min(1440, Math.max(1, Number(url.searchParams.get("limit") ?? 288)));
          if (instrument !== "AU9999" && instrument !== "XAU" && instrument !== "GCF" && instrument !== "CMB") {
            sendJson(res, 400, { ok: false, error: { code: "BAD_INSTRUMENT" } });
            return;
          }
          if (!BAR_INTERVALS.includes(interval)) {
            sendJson(res, 400, { ok: false, error: { code: "BAD_INTERVAL" } });
            return;
          }
          const rawBars = runtime.bars[instrument]?.[interval] ?? [];
          const filteredBars = interval === 1440 ? rawBars : filterBarsToTradingHours(rawBars, runtime.config);
          sendJson(res, 200, {
            ok: true,
            instrument,
            interval,
            bars: barsView(filteredBars, limit, interval),
          });
        },
      }),
    },
    {
      path: "/dsh-plugin-goldboard/manual-cmb-missing",
      handler: route({
        GET: async (req, res) => {
          const now = new Date();
          const result = listMissingCmbMinuteSlots(runtime, runtime.config, now);
          sendJson(res, 200, {
            ok: true,
            date: result.date,
            serverTime: now.toISOString(),
            slots: result.slots,
          });
        },
      }),
    },
    {
      path: "/dsh-plugin-goldboard/manual-cmb-bars",
      handler: route({
        POST: async (req, res) => {
          try {
            const body = JSON.parse((await readBody(req)).toString("utf8"));
            const input = body?.text ?? body?.entries ?? body?.prices ?? body?.minutes;
            const now = new Date();
            const parsed = parseManualCmbMinuteEntries(input, now);
            if (parsed.entries.length === 0) {
              sendJson(res, 400, {
                ok: false,
                error: {
                  code: "BAD_MANUAL_CMB_ENTRIES",
                  message: parsed.errors.join("; ") || "没有可用的分钟价格",
                },
              });
              return;
            }
            const result = applyManualCmbMinuteBars(runtime, parsed.entries, runtime.config, now);
            await persistState();
            runtime.plan = computePlan(runtime, runtime.config);
            refreshSnapshot(now);
            sendJson(res, 200, {
              ok: true,
              added: result.added,
              skipped: result.skipped,
              errors: parsed.errors,
              snapshot: runtime.lastSnapshot,
            });
          } catch (error) {
            sendJson(res, error?.code === "PAYLOAD_TOO_LARGE" ? 413 : 400, {
              ok: false,
              error: { code: error?.code ?? "BAD_MANUAL_CMB_BARS", message: String(error?.message ?? error) },
            });
          }
        },
      }),
    },
    {
      path: "/dsh-plugin-goldboard/replay",
      handler: route({
        POST: async (req, res) => {
          try {
            const body = JSON.parse((await readBody(req, MAX_REPLAY_BYTES)).toString("utf8"));
            sendJson(res, 200, replayMarketPlan(body, runtime.config));
          } catch (error) {
            sendJson(res, error?.code === "PAYLOAD_TOO_LARGE" ? 413 : 400, {
              ok: false,
              error: { code: error?.code ?? "BAD_REPLAY_INPUT" },
            });
          }
        },
      }),
    },
    {
      // plan-06 batch replay statistics. POST { days?, lane?, force?, detail? }
      // starts (or joins) a run — client disconnect aborts between days;
      // GET serves the most recent report (memory → replay-stats.json).
      // lane defaults to "cmb": replay on the persisted 招行积存金 series
      // (no network); "au9999" keeps the Eastmoney kline universe.
      path: "/dsh-plugin-goldboard/replay-stats",
      handler: route({
        GET: async (req, res) => {
          const url = new URL(req.url ?? "/", "http://x");
          const result = await deps.replayStats.last(url.searchParams.get("detail") === "true");
          sendJson(res, 200, result);
        },
        POST: async (req, res) => {
          try {
            const body = JSON.parse((await readBody(req)).toString("utf8"));
            const controller = new AbortController();
            const onRequestGone = () => {
              // res 'close' also fires after a NORMAL completion — an
              // unfinished response is what actually means the client
              // disconnected (req 'close', by contrast, fires as soon as the
              // body stream ends, which would cancel every run instantly).
              if (res.writableFinished !== true) controller.abort(new Error("client disconnected"));
            };
            // Stream methods are guarded: bare request doubles in tests and
            // exotic hosts may not implement the full EventEmitter surface.
            if (typeof res.on === "function") res.on("close", onRequestGone);
            try {
              const result = await deps.replayStats.run({
                days: Number(body?.days),
                lane: typeof body?.lane === "string" ? body.lane : undefined,
                force: body?.force === true,
                detail: body?.detail === true,
                includePartial: body?.includePartial === true,
                requireExecutableBid: body?.requireExecutableBid === true,
                signal: controller.signal,
              });
              sendJson(res, 200, result);
            } catch (error) {
              if (error?.name === "AbortError" && res.writableEnded !== true) {
                sendJson(res, 200, { ok: false, status: "cancelled", error: { code: "REPLAY_STATS_CANCELLED" } });
                return;
              }
              throw error;
            } finally {
              if (typeof res.off === "function") res.off("close", onRequestGone);
            }
          } catch (error) {
            sendJson(res, error?.code === "PAYLOAD_TOO_LARGE" ? 413 : 400, {
              ok: false,
              error: { code: error?.code ?? "BAD_REPLAY_STATS_INPUT", message: String(error?.message ?? error).slice(0, 300) },
            });
          }
        },
      }),
    },
    {
      path: "/dsh-plugin-goldboard/data-sources",
      handler: route({
        GET: async (req, res) => {
          sendJson(res, 200, {
            ok: true,
            sources: registry.dataSourceView(runtime),
            historical: runtime.historicalStatus ?? null,
          });
        },
      }),
    },
    {
      path: "/dsh-plugin-goldboard/api-logs",
      handler: route({
        GET: async (req, res) => {
          const url = new URL(req.url ?? "/", "http://x");
          const sourceId = String(url.searchParams.get("source") ?? "");
          sendJson(res, 200, { ok: true, sourceId, logs: registry.getApiLogs(sourceId || undefined) });
        },
      }),
    },
    {
      path: "/dsh-plugin-goldboard/test-notify",
      handler: route({
        POST: async (req, res) => {
          const fail = (status, code, message) => {
            const error = new Error(message);
            error.statusCode = status;
            error.code = code;
            throw error;
          };
          try {
            const body = JSON.parse((await readBody(req)).toString("utf8"));
            const channel = String(body?.channel ?? "system");
            const draftConfig = body?.config !== null && typeof body?.config === "object" ? body.config : {};
            const zh = runtime.localeHint !== "en";
            const testMessage = buildAlertMessage(
              { action: "buy_setup", suggestedOrder: { instrument: "Au99.99", signalPrice: 950, cmbEstimatedPrice: 951.72, grams: 1 }, targetPrice: 958, grams: 1 },
              runtime.config,
              runtime.localeHint,
            );
            testMessage.title = zh ? "黄金看板 · 测试" : "Gold Board · Test";
            testMessage.body = zh
              ? "这是一条来自 DeepSeek Harness 黄金看板插件的测试消息。"
              : "This is a test message from the DeepSeek Harness Gold Board plugin.";
            testMessage.params.action = zh ? "测试消息" : "Test message";

            if (channel === "system") {
              const systemConfig = draftConfig.system !== null && typeof draftConfig.system === "object"
                ? { ...runtime.config.system, ...draftConfig.system }
                : typeof draftConfig.enabled === "boolean"
                  ? { ...runtime.config.system, enabled: draftConfig.enabled }
                  : runtime.config.system;
              if (!systemConfig.enabled) fail(400, "SYSTEM_DISABLED", "SYSTEM_DISABLED");
              await systemNotify(testMessage.title, testMessage.body);
            } else if (channel === "feishu") {
              const testConfig = mergeTestConfig(runtime.config.webhooks.feishu, draftConfig);
              await sendFeishu(testConfig, renderWebhookTemplate(testConfig.bodyTemplate, testMessage), deps.post);
            } else if (channel === "dingtalk") {
              const testConfig = mergeTestConfig(runtime.config.webhooks.dingtalk, draftConfig);
              await sendDingtalk(testConfig, renderWebhookTemplate(testConfig.bodyTemplate, testMessage), deps.post);
            } else if (channel === "wecom") {
              const testConfig = mergeTestConfig(runtime.config.webhooks.wecom, draftConfig);
              await sendWecom(testConfig, renderWebhookTemplate(testConfig.bodyTemplate, testMessage), deps.post);
            } else if (channel === "generic") {
              const generic = runtime.config.webhooks.generic.find((entry) => entry.id === String(body?.genericId ?? ""));
              if (!generic) fail(400, "GENERIC_NOT_FOUND", "GENERIC_NOT_FOUND");
              const testConfig = mergeTestConfig(generic, draftConfig);
              await sendGeneric(testConfig, renderWebhookTemplate(testConfig.bodyTemplate, testMessage), {
                lookup: deps.genericLookup,
                transport: deps.genericTransport,
              });
            } else {
              fail(400, "BAD_CHANNEL", "BAD_CHANNEL");
            }
            sendJson(res, 200, { ok: true });
          } catch (error) {
            const status = typeof error?.statusCode === "number" ? error.statusCode : 500;
            sendJson(res, status, {
              ok: false,
              error: { code: error?.code ?? "NOTIFY_FAILED", message: String(error?.message ?? error) },
            });
          }
        },
      }),
    },
  ];
}
