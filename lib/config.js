/**
 * Config defaults, normalization, secret handling and patch merging.
 *
 * plan-05: extracted verbatim from the old monolithic lib/index.js. Pure
 * functions only — persistence lives in store.js, the settings seam in the
 * composition root.
 */

import { num } from "./shared.js";
// plan-04: user-settings seam. Dependencies are pinned to the running Harness
// line (0.1.1-rc.x).
import { settingsNamespace } from "@deepseek-ai/dsh-settings";
import z from "@deepseek-ai/schemastery";

export const DEFAULT_CONFIG = Object.freeze({
  fee: Object.freeze({ buyPerGram: 0, sellPerGram: 5 }),
  // 2026-08 实测：国际金价折算约 950.00 时招行积存金约 951.72，故默认价差校准为 +1.72。
  cmb: Object.freeze({ buySpreadPerGram: 1.72, sellSpreadPerGram: 1.72 }),
  position: Object.freeze({ grams: 0, avgCostPerGram: 0, lots: Object.freeze([]) }),
  limits: Object.freeze({ maxGrams: 0 }),
  manualPrevClose: Object.freeze({ AU9999: null, XAU: null, CMB: null }),
  strategy: Object.freeze({
    minProfitPerGram: 1,
    maxLossPerGram: 2,
    slippagePerGram: 0.2,
    estimatedSpreadPerGram: 0.2,
    rsiOversold: 35,
    rsiOverbought: 75,
    atrFactor: 0.3,
    nearSupportPct: 0.5,
    minRemainGrams: 0,
    signalCooldownMinutes: 30,
    confirmBars: 2,
    scoreThreshold: 5,
    // sell_weakness (plan-03): RSI threshold + upper-shadow/ATR multiplier on
    // the latest CLOSED 5m bar, both required together with a position.
    weaknessRsi: 75,
    weaknessShadowAtrMult: 1.0,
    // 收盘前强制平仓提示开关：默认关闭——不固定倾向于日内了结，收盘前仍按
    // 止盈/移动止盈/止损/走弱等常规信号判断；需要日内了结纪律的用户可开启。
    closeBySessionEnd: false,
    // 挂单偏离撤单阈值（%）：现价偏离在途挂单建议价超过该百分比时才提示撤单。
    orderRepricePct: 0.5,
  }),
  tradingHours: Object.freeze({
    weekdaysOnly: true,
    open: "09:00",
    close: "26:00",
    holidays: Object.freeze([]),
  }),
  analysis: Object.freeze({
    enabled: false,
    provider: "",
    model: "",
    reasoningEffort: "",
    temperature: 0.1,
    maxTokens: 1600,
    trigger: "manual",
    cooldownMinutes: 5,
    timeoutMs: 60_000,
    maxLogEntries: 500,
    riskDisclosure: "技术面参考，非投资建议。",
  }),
  system: Object.freeze({ enabled: false }),
  webhooks: Object.freeze({
    feishu: Object.freeze({ enabled: false, url: "", secret: "", bodyTemplate: "" }),
    dingtalk: Object.freeze({ enabled: false, url: "", secret: "", bodyTemplate: "" }),
    wecom: Object.freeze({ enabled: false, url: "", bodyTemplate: "" }),
    generic: Object.freeze([]),
  }),
});

function nullableNum(value, max = 1000000) {
  if (value === "" || value === null || value === undefined) return null;
  const n = Number(value);
  if (!Number.isFinite(n) || n <= 0) return null;
  return Math.round(Math.min(max, Math.max(0, n)) * 100) / 100;
}

function bool(value, fallback) {
  return typeof value === "boolean" ? value : fallback;
}

export function str(value, limit = 4096) {
  return typeof value === "string" ? value.slice(0, limit) : "";
}

function cleanHolidays(value) {
  if (!Array.isArray(value)) return [];
  const out = [];
  for (const entry of value) {
    if (typeof entry !== "string") continue;
    const date = entry.slice(0, 10);
    if (/^\d{4}-\d{2}-\d{2}$/.test(date) && !out.includes(date)) out.push(date);
  }
  return out;
}

function cleanHeaders(value) {
  const out = {};
  if (typeof value !== "object" || value === null || Array.isArray(value)) return out;
  let count = 0;
  for (const [key, entry] of Object.entries(value)) {
    if (count >= 32) break;
    if (typeof entry !== "string") continue;
    out[key.slice(0, 128)] = entry.slice(0, 4096);
    count += 1;
  }
  return out;
}

function cleanGenericItem(entry, index) {
  const id = str(entry?.id).slice(0, 64) || `wh-${index + 1}`;
  return {
    id,
    name: str(entry?.name).slice(0, 64) || id,
    enabled: bool(entry?.enabled, false),
    url: str(entry?.url),
    headers: cleanHeaders(entry?.headers),
    bodyTemplate: str(entry?.bodyTemplate),
  };
}

function cleanLots(value) {
  if (!Array.isArray(value)) return [];
  const out = [];
  for (const entry of value) {
    if (!entry || typeof entry !== "object") continue;
    const grams = num(entry.grams, 0, 0, 100000);
    const price = Math.round(num(entry.price, 0, 0, 1000000) * 100) / 100;
    if (grams <= 0 || price <= 0) continue;
    out.push({
      id: str(entry.id, 64) || `lot-${out.length + 1}`,
      grams,
      price,
      time: str(entry.time, 64) || new Date().toISOString(),
      status: entry.status === "closed" ? "closed" : "open",
    });
  }
  return out;
}

function positionFromLots(lots) {
  const open = lots.filter((lot) => lot.status !== "closed");
  const grams = open.reduce((sum, lot) => sum + lot.grams, 0);
  const avgCostPerGram = grams > 0 ? open.reduce((sum, lot) => sum + lot.grams * lot.price, 0) / grams : 0;
  return { grams, avgCostPerGram };
}

function normalizePosition(value) {
  const source = value && typeof value === "object" ? value : {};
  const hasLots = Array.isArray(source.lots);
  const lots = cleanLots(source.lots);
  if (lots.length > 0) {
    const derived = positionFromLots(lots);
    return {
      grams: derived.grams,
      avgCostPerGram: derived.avgCostPerGram,
      lots,
    };
  }
  // An explicit empty lots array is the settings UI's clear-position value.
  // Only legacy payloads without lots may fall back to aggregate fields.
  if (hasLots) return { grams: 0, avgCostPerGram: 0, lots: [] };
  const grams = num(source.grams, DEFAULT_CONFIG.position.grams, 0, 100000);
  const avgCostPerGram = num(source.avgCostPerGram, DEFAULT_CONFIG.position.avgCostPerGram, 0, 1000000);
  const fallbackLots = grams > 0 && avgCostPerGram > 0
    ? [{ id: "lot-1", grams, price: avgCostPerGram, time: new Date().toISOString(), status: "open" }]
    : [];
  return {
    grams,
    avgCostPerGram,
    lots: fallbackLots,
  };
}

/** Merge an arbitrary stored/input value over the defaults and sanitize it. */
export function normalizeConfig(value) {
  const source = typeof value === "object" && value !== null ? value : {};
  const fee = typeof source.fee === "object" && source.fee !== null ? source.fee : {};
  const cmb = typeof source.cmb === "object" && source.cmb !== null ? source.cmb : {};
  const position = typeof source.position === "object" && source.position !== null ? source.position : {};
  const limits = typeof source.limits === "object" && source.limits !== null ? source.limits : {};
  const manualPrevClose = typeof source.manualPrevClose === "object" && source.manualPrevClose !== null ? source.manualPrevClose : {};
  const strategy = typeof source.strategy === "object" && source.strategy !== null ? source.strategy : {};
  const tradingHours = typeof source.tradingHours === "object" && source.tradingHours !== null ? source.tradingHours : {};
  const analysis = typeof source.analysis === "object" && source.analysis !== null ? source.analysis : {};
  const system = typeof source.system === "object" && source.system !== null ? source.system : {};
  const webhooks = typeof source.webhooks === "object" && source.webhooks !== null ? source.webhooks : {};
  const feishu = typeof webhooks.feishu === "object" && webhooks.feishu !== null ? webhooks.feishu : {};
  const dingtalk = typeof webhooks.dingtalk === "object" && webhooks.dingtalk !== null ? webhooks.dingtalk : {};
  const wecom = typeof webhooks.wecom === "object" && webhooks.wecom !== null ? webhooks.wecom : {};
  const generic = Array.isArray(webhooks.generic) ? webhooks.generic : [];
  return {
    fee: {
      buyPerGram: num(fee.buyPerGram, DEFAULT_CONFIG.fee.buyPerGram, 0, 100),
      sellPerGram: num(fee.sellPerGram, DEFAULT_CONFIG.fee.sellPerGram, 0, 100),
    },
    cmb: {
      buySpreadPerGram: num(cmb.buySpreadPerGram, DEFAULT_CONFIG.cmb.buySpreadPerGram, -100, 100),
      sellSpreadPerGram: num(cmb.sellSpreadPerGram, DEFAULT_CONFIG.cmb.sellSpreadPerGram, -100, 100),
    },
    limits: {
      maxGrams: num(limits.maxGrams, DEFAULT_CONFIG.limits.maxGrams, 0, 100000),
    },
    manualPrevClose: {
      AU9999: nullableNum(manualPrevClose.AU9999),
      XAU: nullableNum(manualPrevClose.XAU),
      CMB: nullableNum(manualPrevClose.CMB),
    },
    position: normalizePosition(position),
    strategy: {
      minProfitPerGram: num(strategy.minProfitPerGram, DEFAULT_CONFIG.strategy.minProfitPerGram, 0, 100),
      maxLossPerGram: num(strategy.maxLossPerGram, DEFAULT_CONFIG.strategy.maxLossPerGram, 0, 1000),
      slippagePerGram: num(strategy.slippagePerGram, DEFAULT_CONFIG.strategy.slippagePerGram, 0, 50),
      estimatedSpreadPerGram: num(strategy.estimatedSpreadPerGram, DEFAULT_CONFIG.strategy.estimatedSpreadPerGram, 0, 50),
      rsiOversold: num(strategy.rsiOversold, DEFAULT_CONFIG.strategy.rsiOversold, 1, 50),
      rsiOverbought: num(strategy.rsiOverbought, DEFAULT_CONFIG.strategy.rsiOverbought, 50, 99),
      atrFactor: num(strategy.atrFactor, DEFAULT_CONFIG.strategy.atrFactor, 0.05, 2),
      nearSupportPct: num(strategy.nearSupportPct, DEFAULT_CONFIG.strategy.nearSupportPct, 0.05, 10),
      minRemainGrams: num(strategy.minRemainGrams, DEFAULT_CONFIG.strategy.minRemainGrams, 0, 100000),
      signalCooldownMinutes: num(strategy.signalCooldownMinutes, DEFAULT_CONFIG.strategy.signalCooldownMinutes, 0, 1440),
      confirmBars: num(strategy.confirmBars, DEFAULT_CONFIG.strategy.confirmBars, 1, 10),
      scoreThreshold: num(strategy.scoreThreshold, DEFAULT_CONFIG.strategy.scoreThreshold, 1, 10),
      weaknessRsi: num(strategy.weaknessRsi, DEFAULT_CONFIG.strategy.weaknessRsi, 50, 99),
      weaknessShadowAtrMult: num(strategy.weaknessShadowAtrMult, DEFAULT_CONFIG.strategy.weaknessShadowAtrMult, 0, 10),
      closeBySessionEnd: bool(strategy.closeBySessionEnd, DEFAULT_CONFIG.strategy.closeBySessionEnd),
      orderRepricePct: num(strategy.orderRepricePct, DEFAULT_CONFIG.strategy.orderRepricePct, 0.05, 10),
    },
    tradingHours: {
      weekdaysOnly: bool(tradingHours.weekdaysOnly, DEFAULT_CONFIG.tradingHours.weekdaysOnly),
      open: /^\d{2}:\d{2}$/.test(tradingHours.open) ? tradingHours.open : DEFAULT_CONFIG.tradingHours.open,
      close: /^\d{2}:\d{2}$/.test(tradingHours.close) ? tradingHours.close : DEFAULT_CONFIG.tradingHours.close,
      holidays: cleanHolidays(tradingHours.holidays),
    },
    analysis: {
      enabled: bool(analysis.enabled, DEFAULT_CONFIG.analysis.enabled),
      provider: str(analysis.provider, 128),
      model: str(analysis.model, 256),
      reasoningEffort: str(analysis.reasoningEffort, 64),
      temperature: num(analysis.temperature, DEFAULT_CONFIG.analysis.temperature, 0, 2),
      maxTokens: Math.round(num(analysis.maxTokens, DEFAULT_CONFIG.analysis.maxTokens, 128, 32_000)),
      trigger: analysis.trigger === "manual" ? "manual" : DEFAULT_CONFIG.analysis.trigger,
      cooldownMinutes: num(analysis.cooldownMinutes, DEFAULT_CONFIG.analysis.cooldownMinutes, 0, 1_440),
      timeoutMs: Math.round(num(analysis.timeoutMs, DEFAULT_CONFIG.analysis.timeoutMs, 5_000, 180_000)),
      maxLogEntries: Math.round(num(analysis.maxLogEntries, DEFAULT_CONFIG.analysis.maxLogEntries, 10, 5_000)),
      riskDisclosure: str(analysis.riskDisclosure, 512) || DEFAULT_CONFIG.analysis.riskDisclosure,
    },
    system: { enabled: bool(system.enabled, DEFAULT_CONFIG.system.enabled) },
    webhooks: {
      feishu: { enabled: bool(feishu.enabled, false), url: str(feishu.url), secret: str(feishu.secret), bodyTemplate: str(feishu.bodyTemplate) },
      dingtalk: { enabled: bool(dingtalk.enabled, false), url: str(dingtalk.url), secret: str(dingtalk.secret), bodyTemplate: str(dingtalk.bodyTemplate) },
      wecom: { enabled: bool(wecom.enabled, false), url: str(wecom.url), bodyTemplate: str(wecom.bodyTemplate) },
      generic: generic.slice(0, 32).map(cleanGenericItem),
    },
  };
}

export const SECRET_PATHS = Object.freeze([
  ["webhooks", "feishu", "secret"],
  ["webhooks", "dingtalk", "secret"],
]);

function readPath(config, path) {
  let node = config;
  for (const key of path) {
    if (node === null || typeof node !== "object") return undefined;
    node = node[key];
  }
  return node;
}

/** Produce the wire view: secret fields blanked plus a `secretSet` sidecar. */
export function redactConfig(config) {
  const normalized = normalizeConfig(config);
  const value = JSON.parse(JSON.stringify(normalized));
  const secretSet = {};
  for (const path of SECRET_PATHS) {
    const node = path.slice(0, -1).reduce((acc, key) => acc[key], value);
    const leaf = path[path.length - 1];
    secretSet[path.join(".")] = node[leaf] !== "";
    node[leaf] = "";
  }
  return { config: value, secretSet };
}

/** Merge a wire write: keep stored secrets on "", replace on non-empty, clear listed paths. */
export function mergeSecrets(stored, incoming, clearSecrets) {
  const next = JSON.parse(JSON.stringify(incoming === null || typeof incoming !== "object" ? {} : incoming));
  const clears = new Set(Array.isArray(clearSecrets) ? clearSecrets.filter((entry) => typeof entry === "string") : []);
  for (const path of SECRET_PATHS) {
    const key = path.join(".");
    let node = next;
    for (let index = 0; index < path.length - 1; index += 1) {
      if (node[path[index]] === null || typeof node[path[index]] !== "object") node[path[index]] = {};
      node = node[path[index]];
    }
    const leaf = path[path.length - 1];
    const incomingValue = readPath(incoming, path);
    if (clears.has(key)) node[leaf] = "";
    else if (typeof incomingValue === "string" && incomingValue !== "") node[leaf] = incomingValue;
    else node[leaf] = readPath(stored, path) ?? "";
  }
  return next;
}

/**
 * Detach a config for the settings STORE (plan-04): drop empty-string secret
 * leaves so an unset secret stays ABSENT in the stored/base layers. The
 * redaction walker reports `secrets[].set` from key presence — a stored
 * `secret: ""` would make every field look configured. The runtime view keeps
 * materialized "" (normalizeConfig); only persisted sections strip.
 */
export function sectionForSettingsStore(config) {
  const clone = JSON.parse(JSON.stringify(config === null || typeof config !== "object" ? {} : config));
  for (const path of SECRET_PATHS) {
    const node = readPath(clone, path.slice(0, -1));
    if (node && typeof node === "object") {
      const leaf = path[path.length - 1];
      if (node[leaf] === "") delete node[leaf];
    }
  }
  return clone;
}

// ── plan-03 config deep merge (POST /config) ───────────────────────────────

// Every top-level section normalizeConfig understands. POSTing an unknown
// top-level key is a client error (400 UNKNOWN_CONFIG_KEY) instead of being
// silently dropped.
const CONFIG_SECTION_KEYS = Object.freeze([
  "fee",
  "cmb",
  "position",
  "limits",
  "manualPrevClose",
  "strategy",
  "tradingHours",
  "analysis",
  "system",
  "webhooks",
]);
const WEBHOOK_CHANNEL_KEYS = Object.freeze(["feishu", "dingtalk", "wecom"]);

function isPlainObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

/** Field-level merge of one section: patch fields win, absent fields keep stored. */
export function mergeConfigSection(base, patch) {
  const out = { ...(isPlainObject(base) ? base : {}) };
  if (isPlainObject(patch)) {
    for (const [key, value] of Object.entries(patch)) out[key] = value;
  }
  return out;
}

/**
 * Deep-merge semantics for POST /config (plan-03 03.5): a partial payload only
 * touches the sections/fields it carries, so `{webhooks:{feishu:{...}}}` no
 * longer resets dingtalk/wecom/generic. Arrays (`position.lots`,
 * `webhooks.generic`, `tradingHours.holidays`) are replaced wholesale.
 * Unknown top-level keys throw UNKNOWN_CONFIG_KEY. Secret blank/clear
 * semantics stay upstream in mergeSecrets.
 */
export function mergeConfigPatch(stored, patch) {
  if (!isPlainObject(patch)) return isPlainObject(stored) ? stored : {};
  for (const key of Object.keys(patch)) {
    if (!CONFIG_SECTION_KEYS.includes(key)) {
      const error = new Error(`unknown config key: ${key}`);
      error.code = "UNKNOWN_CONFIG_KEY";
      throw error;
    }
  }
  const next = {};
  for (const key of CONFIG_SECTION_KEYS) {
    const baseValue = isPlainObject(stored) ? stored[key] : undefined;
    const patchValue = patch[key];
    if (patchValue === undefined) {
      next[key] = baseValue;
      continue;
    }
    if (key === "webhooks") {
      const mergedWebhooks = {};
      for (const channel of WEBHOOK_CHANNEL_KEYS) {
        mergedWebhooks[channel] = patchValue[channel] === undefined
          ? baseValue?.[channel]
          : mergeConfigSection(baseValue?.[channel], patchValue[channel]);
      }
      mergedWebhooks.generic = patchValue.generic !== undefined ? patchValue.generic : baseValue?.generic;
      next[key] = mergedWebhooks;
      continue;
    }
    if (isPlainObject(patchValue)) {
      next[key] = mergeConfigSection(baseValue, patchValue);
      continue;
    }
    next[key] = patchValue;
  }
  return next;
}

// ── plan-04: settings namespace schema ─────────────────────────────────────

/** The plugin's user-settings namespace (lowercase kebab-case, as the short name). */
export const SETTINGS_NAMESPACE = settingsNamespace("dsh-plugin-goldboard");

/**
 * Schemastery schema for the settings namespace. Resolution layers schema
 * defaults → composition base (entry config) → user document, so every default
 * here mirrors DEFAULT_CONFIG and every bound mirrors normalizeConfig's
 * clamps: out-of-range writes REJECT at write time instead of being silently
 * clamped like the classic POST /config path. Secret fields carry
 * `role('secret')` so wire surfaces redact them and report them through the
 * descriptor's `secrets` sidecar (`{ path, set }`) — the plaintext never
 * crosses a wire. Nullable numbers (manualPrevClose) cannot express a
 * materialized `null` default in schemastery (`default(null)` is treated as
 * "no default"), so an absent key simply means null; normalizeConfig fills it
 * on adoption.
 */
export const SETTINGS_SCHEMA = z.object({
  fee: z.object({
    buyPerGram: z.number().min(0).max(100).default(DEFAULT_CONFIG.fee.buyPerGram),
    sellPerGram: z.number().min(0).max(100).default(DEFAULT_CONFIG.fee.sellPerGram),
  }).default({}),
  cmb: z.object({
    buySpreadPerGram: z.number().min(-100).max(100).default(DEFAULT_CONFIG.cmb.buySpreadPerGram),
    sellSpreadPerGram: z.number().min(-100).max(100).default(DEFAULT_CONFIG.cmb.sellSpreadPerGram),
  }).default({}),
  position: z.object({
    grams: z.number().min(0).max(100000).default(0),
    avgCostPerGram: z.number().min(0).max(1000000).default(0),
    lots: z.array(z.object({
      id: z.string().default(""),
      grams: z.number().min(0).max(100000).default(0),
      price: z.number().min(0).max(1000000).default(0),
      time: z.string().default(""),
      status: z.string().default("open"),
    })).default([]),
  }).default({}),
  limits: z.object({
    maxGrams: z.number().min(0).max(100000).default(0),
  }).default({}),
  manualPrevClose: z.object({
    AU9999: z.union([z.number(), z.const(null)]),
    XAU: z.union([z.number(), z.const(null)]),
    CMB: z.union([z.number(), z.const(null)]),
  }).default({}),
  strategy: z.object({
    minProfitPerGram: z.number().min(0).max(100).default(1),
    maxLossPerGram: z.number().min(0).max(1000).default(2),
    slippagePerGram: z.number().min(0).max(50).default(0.2),
    estimatedSpreadPerGram: z.number().min(0).max(50).default(0.2),
    rsiOversold: z.number().min(1).max(50).default(35),
    rsiOverbought: z.number().min(50).max(99).default(75),
    atrFactor: z.number().min(0.05).max(2).default(0.3),
    nearSupportPct: z.number().min(0.05).max(10).default(0.5),
    minRemainGrams: z.number().min(0).max(100000).default(0),
    signalCooldownMinutes: z.number().min(0).max(1440).default(30),
    confirmBars: z.number().min(1).max(10).default(2),
    scoreThreshold: z.number().min(1).max(10).default(5),
    weaknessRsi: z.number().min(50).max(99).default(75),
    weaknessShadowAtrMult: z.number().min(0).max(10).default(1.0),
    closeBySessionEnd: z.boolean().default(false),
    orderRepricePct: z.number().min(0.05).max(10).default(0.5),
  }).default({}),
  tradingHours: z.object({
    weekdaysOnly: z.boolean().default(true),
    open: z.string().pattern(/^\d{2}:\d{2}$/).default("09:00"),
    close: z.string().pattern(/^\d{2}:\d{2}$/).default("26:00"),
    holidays: z.array(z.string()).default([]),
  }).default({}),
  analysis: z.object({
    enabled: z.boolean().default(false),
    provider: z.string().default(""),
    model: z.string().default(""),
    reasoningEffort: z.string().default(""),
    temperature: z.number().min(0).max(2).default(0.1),
    maxTokens: z.number().min(128).max(32000).default(1600),
    trigger: z.string().default("manual"),
    cooldownMinutes: z.number().min(0).max(1440).default(5),
    timeoutMs: z.number().min(5000).max(180000).default(60000),
    maxLogEntries: z.number().min(10).max(5000).default(500),
    riskDisclosure: z.string().default("技术面参考，非投资建议。"),
  }).default({}),
  system: z.object({
    enabled: z.boolean().default(false),
  }).default({}),
  webhooks: z.object({
    feishu: z.object({
      enabled: z.boolean().default(false),
      url: z.string().default(""),
      // No .default(): an absent secret must resolve ABSENT so wire redaction
      // reports `secrets[].set = false` (the configured-badge signal); a
      // materialized default would make the field look configured forever.
      secret: z.string().role("secret"),
      bodyTemplate: z.string().default(""),
    }).default({}),
    dingtalk: z.object({
      enabled: z.boolean().default(false),
      url: z.string().default(""),
      secret: z.string().role("secret"),
      bodyTemplate: z.string().default(""),
    }).default({}),
    wecom: z.object({
      enabled: z.boolean().default(false),
      url: z.string().default(""),
      bodyTemplate: z.string().default(""),
    }).default({}),
    generic: z.array(z.object({
      id: z.string().default(""),
      name: z.string().default(""),
      enabled: z.boolean().default(false),
      url: z.string().default(""),
      headers: z.dict(z.string()).default({}),
      bodyTemplate: z.string().default(""),
    })).default([]),
  }).default({}),
});
