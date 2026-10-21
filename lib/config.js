/**
 * Config defaults, normalization, secret handling and patch merging.
 *
 * plan-05: extracted verbatim from the old monolithic lib/index.js. Pure
 * functions only — persistence lives in store.js and the composition root.
 */

import { CONFIDENCE_MAX, num } from "./shared.js";
import { RISK_CONFIG_VERSION } from "./risk.js";
import {
  DEFAULT_STRATEGY_EXPERIMENT_CONFIG,
  normalizeStrategyExperimentConfig,
} from "./experiment-config.js";

export const DEFAULT_CONFIG = Object.freeze({
  fee: Object.freeze({ buyPerGram: 0, sellPerGram: 5 }),
  // 2026-08 实测：国际金价折算约 950.00 时招行积存金约 951.72，故默认价差校准为 +1.72。
  // deriveSellFromFee: 开启后卖出价 = 实时买入价 − fee.sellPerGram，实时卖出价只做
  // 漂移提示；手续费由用户配置，执行/风控/账本不再重复扣费。
  cmb: Object.freeze({ buySpreadPerGram: 1.72, sellSpreadPerGram: 1.72, deriveSellFromFee: false }),
  position: Object.freeze({ grams: 0, avgCostPerGram: 0, lots: Object.freeze([]) }),
  limits: Object.freeze({ maxGrams: 0 }),
  sidebarPrice: "AU9999",
  risk: Object.freeze({
    version: RISK_CONFIG_VERSION,
    mode: "fixed_grams",
    referenceEquityCny: 0,
    maxAmountCny: 0,
    maxRiskPerTradeCny: 0,
    maxDailyLossCny: 0,
    maxWeeklyLossCny: 0,
    maxDrawdownCny: 0,
    volatilityTarget: 0,
    liquidityCapGrams: 0,
    maxAddsPerSetup: 0,
    maxAddsPerDay: 0,
    minAddPriceImprovementPerGram: 0,
    consecutiveLossDeRisk: 0,
  }),
  manualPrevClose: Object.freeze({ AU9999: null, XAU: null, CMB: null }),
  manualPrevCloseDate: "",
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
    // 目标回撤止盈（opt-in）：0 = 关闭，保留"到目标即卖"的旧行为。
    // 开启后触达目标只武装，回撤 trail 元/克才卖；partial 比例可选首触减仓。
    targetTrailPerGram: 0,
    targetPartialRatio: 0,
    targetTrailBars: 24,
    // 趋势闸门：开启后 5 分钟买点还必须满足现价高于 60 分钟 EMA20。
    requirePriceAboveEma60: false,
    // 日线闸门：再要求「日线收盘 > 日线 EMA20 且 EMA20 上行」；日线不足时 fail closed。
    requireDailyUptrend: false,
    // 武装前时间止损：持仓满 N 根已收盘 5m K 线仍未触目标则退出；0 = 关闭。
    maxBarsBeforeTarget: 0,
  }),
  // Stage 4 experiments are replay-only and opt-in. They never select the
  // live strategy; `strategy` above remains the control configuration.
  experiments: DEFAULT_STRATEGY_EXPERIMENT_CONFIG,
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
    name: str(entry?.name).slice(0, 64),
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
  // An explicit empty lots array is the page's clear-position value.
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
  const risk = typeof source.risk === "object" && source.risk !== null ? source.risk : {};
  const manualPrevClose = typeof source.manualPrevClose === "object" && source.manualPrevClose !== null ? source.manualPrevClose : {};
  const strategy = typeof source.strategy === "object" && source.strategy !== null ? source.strategy : {};
  const experiments = typeof source.experiments === "object" && source.experiments !== null ? source.experiments : {};
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
      deriveSellFromFee: bool(cmb.deriveSellFromFee, DEFAULT_CONFIG.cmb.deriveSellFromFee),
    },
    limits: {
      maxGrams: num(limits.maxGrams, DEFAULT_CONFIG.limits.maxGrams, 0, 100000),
    },
    sidebarPrice: ["AU9999", "XAU", "CMB"].includes(source.sidebarPrice)
      ? source.sidebarPrice
      : DEFAULT_CONFIG.sidebarPrice,
    risk: {
      version: RISK_CONFIG_VERSION,
      mode: risk.mode === "budget" ? "budget" : DEFAULT_CONFIG.risk.mode,
      referenceEquityCny: num(risk.referenceEquityCny, DEFAULT_CONFIG.risk.referenceEquityCny, 0, 1_000_000_000),
      maxAmountCny: num(risk.maxAmountCny, DEFAULT_CONFIG.risk.maxAmountCny, 0, 1_000_000_000),
      maxRiskPerTradeCny: num(risk.maxRiskPerTradeCny, DEFAULT_CONFIG.risk.maxRiskPerTradeCny, 0, 100_000_000),
      maxDailyLossCny: num(risk.maxDailyLossCny, DEFAULT_CONFIG.risk.maxDailyLossCny, 0, 100_000_000),
      maxWeeklyLossCny: num(risk.maxWeeklyLossCny, DEFAULT_CONFIG.risk.maxWeeklyLossCny, 0, 100_000_000),
      maxDrawdownCny: num(risk.maxDrawdownCny, DEFAULT_CONFIG.risk.maxDrawdownCny, 0, 100_000_000),
      volatilityTarget: num(risk.volatilityTarget, DEFAULT_CONFIG.risk.volatilityTarget, 0, 10),
      liquidityCapGrams: num(risk.liquidityCapGrams, DEFAULT_CONFIG.risk.liquidityCapGrams, 0, 100_000),
      maxAddsPerSetup: Math.floor(num(risk.maxAddsPerSetup, DEFAULT_CONFIG.risk.maxAddsPerSetup, 0, 10_000)),
      maxAddsPerDay: Math.floor(num(risk.maxAddsPerDay, DEFAULT_CONFIG.risk.maxAddsPerDay, 0, 10_000)),
      minAddPriceImprovementPerGram: num(risk.minAddPriceImprovementPerGram, DEFAULT_CONFIG.risk.minAddPriceImprovementPerGram, 0, 1_000),
      consecutiveLossDeRisk: Math.floor(num(risk.consecutiveLossDeRisk, DEFAULT_CONFIG.risk.consecutiveLossDeRisk, 0, 1_000)),
    },
    manualPrevClose: {
      AU9999: nullableNum(manualPrevClose.AU9999),
      XAU: nullableNum(manualPrevClose.XAU),
      CMB: nullableNum(manualPrevClose.CMB),
    },
    manualPrevCloseDate: typeof source.manualPrevCloseDate === "string" && /^\d{4}-\d{2}-\d{2}$/.test(source.manualPrevCloseDate)
      ? source.manualPrevCloseDate
      : "",
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
      scoreThreshold: num(strategy.scoreThreshold, DEFAULT_CONFIG.strategy.scoreThreshold, 1, CONFIDENCE_MAX),
      weaknessRsi: num(strategy.weaknessRsi, DEFAULT_CONFIG.strategy.weaknessRsi, 50, 99),
      weaknessShadowAtrMult: num(strategy.weaknessShadowAtrMult, DEFAULT_CONFIG.strategy.weaknessShadowAtrMult, 0, 10),
      closeBySessionEnd: bool(strategy.closeBySessionEnd, DEFAULT_CONFIG.strategy.closeBySessionEnd),
      orderRepricePct: num(strategy.orderRepricePct, DEFAULT_CONFIG.strategy.orderRepricePct, 0, 10),
      targetTrailPerGram: num(strategy.targetTrailPerGram, DEFAULT_CONFIG.strategy.targetTrailPerGram, 0, 100),
      targetPartialRatio: num(strategy.targetPartialRatio, DEFAULT_CONFIG.strategy.targetPartialRatio, 0, 0.9),
      targetTrailBars: Math.floor(num(strategy.targetTrailBars, DEFAULT_CONFIG.strategy.targetTrailBars, 0, 288)),
      requirePriceAboveEma60: bool(strategy.requirePriceAboveEma60, DEFAULT_CONFIG.strategy.requirePriceAboveEma60),
      requireDailyUptrend: bool(strategy.requireDailyUptrend, DEFAULT_CONFIG.strategy.requireDailyUptrend),
      maxBarsBeforeTarget: Math.floor(num(strategy.maxBarsBeforeTarget, DEFAULT_CONFIG.strategy.maxBarsBeforeTarget, 0, 10_000)),
    },
    experiments: normalizeStrategyExperimentConfig(experiments),
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

// ── plan-03 config deep merge (POST /config) ───────────────────────────────

// Every top-level section normalizeConfig understands. POSTing an unknown
// top-level key is a client error (400 UNKNOWN_CONFIG_KEY) instead of being
// silently dropped.
const CONFIG_SECTION_KEYS = Object.freeze([
  "fee",
  "cmb",
  "position",
  "limits",
  "sidebarPrice",
  "risk",
  "manualPrevClose",
  "manualPrevCloseDate",
  "strategy",
  "experiments",
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
    if (key === "experiments" && isPlainObject(patchValue)) {
      const mergedExperiments = mergeConfigSection(baseValue, patchValue);
      mergedExperiments.orb = patchValue.orb === undefined
        ? baseValue?.orb
        : mergeConfigSection(baseValue?.orb, patchValue.orb);
      next[key] = mergedExperiments;
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
