/**
 * Alert engine: message builders, host system notifications, webhook
 * channel senders and the multi-channel dispatcher.
 *
 * plan-05: extracted from the old monolithic lib/index.js. Pure builders stay
 * free functions; every sender threads an injectable `post` transport so the
 * composition root can bind its own SourceRegistry (tests override
 * `__setFetchImpl`, which also re-points the default transport).
 */

import { createHmac } from "node:crypto";
import { execFile } from "node:child_process";
import { platform } from "node:os";

import { round2 } from "./shared.js";
import { normalizeConfig, str } from "./config.js";
import { USER_AGENT, getDefaultSourceRegistry } from "./sources.js";
import { SIGNAL_LANES } from "./plan.js";
import { beijingDateForNow } from "./market-time.js";

/** Rolling cap of the in-memory + on-disk alerts log. */
export const ALERT_LOG_CAP = 200;

export const ACTION_LABELS_ZH = Object.freeze({
  buy_setup: "出现买入机会啦，可以考虑入手～",
  add_position: "金价回调企稳，可以考虑补一点仓～",
  reduce_position: "金价冲高回落，可以考虑先减点仓～",
  sell_take_profit: "当前金价已经达到盈利目标啦，可以考虑卖出哦～",
  sell_trailing: "金价短线走弱啦，记得保护好利润～",
  sell_stop: "金价跌到止损位啦，注意控制风险～",
  sell_weakness: "盘面有点走弱，可以考虑减仓避险～",
  close_by_session_end: "快到收盘时间啦，注意日内了结～",
  spread_alert: "内外盘价差有点异常，多留意一下～",
  lane_switched: "信号数据源切换啦，看板指标口径已更新～",
  data_stale: "行情数据好像过期了，稍后再看～",
  data_incomplete: "当前数据有缺失，暂不给出建议～",
  wait: "暂时没有合适机会，再等等看～",
  market_closed: "现在是休市时间哦～",
  no_data: "还在等行情数据～",
  no_budget: "已经达到投入上限啦，先不加仓～",
  cancel_order: "原挂单建议已失效，请撤销未成交挂单～",
  order_updated: "挂单建议已更新，请按新建议处理～",
});

export const ACTION_LABELS_EN = Object.freeze({
  buy_setup: "Buy opportunity spotted!",
  add_position: "Time to add a bit?",
  reduce_position: "Consider trimming some",
  sell_take_profit: "Target reached — consider selling!",
  sell_trailing: "Pullback detected — protect your profit",
  sell_stop: "Stop hit — manage risk",
  sell_weakness: "Momentum fading — consider reducing",
  close_by_session_end: "Session ending soon — consider closing",
  spread_alert: "Spread looks unusual",
  lane_switched: "Signal data source switched",
  data_stale: "Market data may be stale",
  data_incomplete: "Data incomplete — no suggestion for now",
  wait: "No opportunity yet",
  market_closed: "Market is closed",
  no_data: "Waiting for quotes",
  no_budget: "Position limit reached",
  cancel_order: "Previous order suggestion is no longer valid — cancel any unfilled order",
  order_updated: "Order suggestion updated — follow the new suggestion",
});

function templateReplace(text, params) {
  return String(text).replace(/\{\{(\w+)\}\}/g, (_, key) => params[key] ?? "");
}

export function sameSuggestedOrder(a, b) {
  if (!a || !b) return false;
  return a.side === b.side
    && a.action === b.action
    && a.instrument === b.instrument
    && Number(a.cmbEstimatedPrice) === Number(b.cmbEstimatedPrice)
    && Number(a.grams) === Number(b.grams);
}

export function buildOrderChangeMessage(plan, previousOrder, kind, config, localeHint = "zh", note = "") {
  const zh = localeHint !== "en";
  const action = kind === "update" ? "order_updated" : "cancel_order";
  const old = previousOrder || null;
  const current = plan?.suggestedOrder || null;
  const oldSideZh = old?.side === "buy" ? "买入" : old?.side === "sell" ? "卖出" : "";
  const oldGrams = old?.grams ?? "";
  const oldPrice = old?.cmbEstimatedPrice ?? old?.signalPrice ?? "";
  const instrument = old?.instrument ?? plan?.instrument ?? "XAU";
  const instrumentZh = instrument === "CMB" ? "招行积存金" : instrument;
  const instrumentEn = instrument === "CMB" ? "CMB 积存金" : instrument;
  const currentSignalPrice = Number.isFinite(Number(plan?.signalPrice)) && Number(plan.signalPrice) > 0
    ? Number(plan.signalPrice)
    : (Number.isFinite(Number(old?.signalPrice)) && Number(old.signalPrice) > 0 ? Number(old.signalPrice) : (old?.signalPrice ?? plan?.signalPrice ?? ""));
  const title = zh
    ? (kind === "update" ? "黄金看板 · 挂单建议已更新" : "黄金看板 · 请撤销原挂单")
    : (kind === "update" ? "Gold Board · order suggestion updated" : "Gold Board · cancel previous order");
  const parts = [];
  if (kind === "cancel") {
    if (oldSideZh && oldGrams) parts.push(`请撤销原${oldSideZh}挂单 ${oldGrams}克`);
    else if (oldSideZh) parts.push(`请撤销原${oldSideZh}挂单`);
    if (oldPrice) parts.push(`原挂单价 ${oldPrice} 元/克`);
    if (plan?.action && plan.action !== "cancel_order") {
      const currentLabel = zh ? ACTION_LABELS_ZH[plan.action] ?? plan.action : ACTION_LABELS_EN[plan.action] ?? plan.action;
      if (currentLabel) parts.push(`当前建议：${currentLabel}`);
    }
  } else {
    if (oldSideZh && oldGrams) parts.push(`原${oldSideZh}挂单 ${oldGrams}克已更新`);
    else if (oldSideZh) parts.push(`原${oldSideZh}挂单已更新`);
    if (oldPrice) parts.push(`原挂单价 ${oldPrice} 元/克`);
    if (current) {
      const newSideZh = current.side === "buy" ? "买入" : current.side === "sell" ? "卖出" : "";
      const newGrams = current.grams ?? "";
      const newPrice = current.cmbEstimatedPrice ?? current.signalPrice ?? "";
      if (newSideZh && newGrams) parts.push(`新建议：${newSideZh} ${newGrams}克`);
      else if (newSideZh) parts.push(`新建议：${newSideZh}`);
      if (newPrice) parts.push(`新挂单价 ${newPrice} 元/克`);
      if (plan?.targetPrice) parts.push(`卖出目标价 ${plan.targetPrice} 元/克`);
    }
    if (plan?.action && plan.action !== "order_updated") {
      const currentLabel = zh ? ACTION_LABELS_ZH[plan.action] ?? plan.action : ACTION_LABELS_EN[plan.action] ?? plan.action;
      if (currentLabel) parts.push(`当前建议：${currentLabel}`);
    }
  }
  if (note) parts.push(note);
  const body = zh
    ? `${instrumentZh} 现价 ${currentSignalPrice} 元/克\n${title}\n${parts.join(" · ")}`
    : `${instrumentEn} current ${currentSignalPrice} CNY/g\n${title}\n${parts.join(" · ")}`;
  return {
    title,
    body,
    action,
    params: {
      action: title,
      instrument,
      price: currentSignalPrice,
      cmbPrice: oldPrice,
      suggestedPrice: oldPrice,
      target: plan?.targetPrice ?? "",
      grams: oldGrams,
      time: new Date().toISOString(),
    },
  };
}

export function buildAlertMessage(plan, config, localeHint = "zh") {
  const action = plan?.action ?? "no_data";
  const order = plan?.suggestedOrder;
  const zh = localeHint !== "en";
  const label = zh ? ACTION_LABELS_ZH[action] ?? action : ACTION_LABELS_EN[action] ?? action;
  const cfg = normalizeConfig(config);
  // For the message header, show the current market price rather than the
  // suggested order price. A buy suggestion may be a limit order below the
  // current CMB price; using order.signalPrice here made the alert claim that
  // the limit price was the live "现价".
  const currentSignalPrice = Number.isFinite(Number(plan?.signalPrice)) && Number(plan.signalPrice) > 0
    ? Number(plan.signalPrice)
    : (Number.isFinite(Number(order?.signalPrice)) && Number(order.signalPrice) > 0 ? Number(order.signalPrice) : (order?.signalPrice ?? plan?.signalPrice ?? ""));
  const signalPrice = currentSignalPrice;
  const rawCmbPrice = order?.cmbEstimatedPrice ?? plan?.cmbEstimatedPrice;
  const liveCmb = plan?.cmbLive === true || order?.cmbLive === true;
  const sellFee = liveCmb ? 0 : cfg.fee.sellPerGram;
  const instrument = order?.instrument ?? plan?.instrument ?? "XAU";
  const isSell = SELL_ACTIONS.includes(action);
  const isBuy = !isSell && (order?.side === "buy" || action === "buy_setup" || action === "add_position");
  const sideZh = isSell ? "卖出" : isBuy ? "买入" : "";
  const sideEn = isSell ? "sell" : isBuy ? "buy" : "";
  const instrumentZh = instrument === "CMB" ? "招行积存金" : instrument;
  const instrumentEn = instrument === "CMB" ? "CMB 积存金" : instrument;
  let cmbPrice = rawCmbPrice ?? "";
  if (isBuy) {
    // Header "招行买入价" should be the current CMB customer buy price, not the
    // suggested limit order price stored in order.cmbEstimatedPrice.
    const buyBase = Number.isFinite(Number(plan?.signalPrice)) && Number(plan.signalPrice) > 0
      ? Number(plan.signalPrice)
      : (Number.isFinite(Number(plan?.xauCnyPerGram)) && Number(plan.xauCnyPerGram) > 0 ? Number(plan.xauCnyPerGram) : NaN);
    if (Number.isFinite(buyBase)) {
      cmbPrice = liveCmb ? round2(buyBase) : round2(buyBase + cfg.cmb.buySpreadPerGram);
    } else if (Number.isFinite(Number(rawCmbPrice)) && Number(rawCmbPrice) > 0) {
      cmbPrice = rawCmbPrice;
    } else {
      cmbPrice = "";
    }
  } else if (Number.isFinite(Number(rawCmbPrice)) && Number(rawCmbPrice) > 0) {
    if (isSell) {
      const sellAfterFee = round2(Number(rawCmbPrice) - sellFee);
      if (Number.isFinite(sellAfterFee)) cmbPrice = sellAfterFee;
    } else {
      cmbPrice = rawCmbPrice;
    }
  } else if (Number.isFinite(Number(plan?.xauCnyPerGram)) && Number(plan.xauCnyPerGram) > 0) {
    // Fallback to the international-converted price + configured spread when
    // the plan did not carry a live CMB price.
    const fallbackBase = Number(plan.xauCnyPerGram);
    if (isSell) {
      const sellAfterFee = round2(fallbackBase + cfg.cmb.sellSpreadPerGram - sellFee);
      if (Number.isFinite(sellAfterFee)) cmbPrice = sellAfterFee;
    } else {
      const buyEstimate = round2(fallbackBase + cfg.cmb.buySpreadPerGram);
      if (Number.isFinite(buyEstimate)) cmbPrice = buyEstimate;
    }
  }
  const suggestedCmbPrice = order?.cmbEstimatedPrice ?? order?.signalPrice ?? "";
  const params = {
    action: label,
    instrument,
    price: signalPrice ?? "",
    cmbPrice,
    suggestedPrice: suggestedCmbPrice,
    target: plan?.targetPrice ?? "",
    grams: order?.grams ?? plan?.grams ?? "",
    time: new Date().toISOString(),
  };
  const title = zh ? `黄金看板 · ${label}` : `Gold Board · ${label}`;
  const zhOrderParts = [];
  if (isBuy && params.grams) zhOrderParts.push(`建议挂单买入 ${params.grams}克`);
  else if (isSell && params.grams && Number.isFinite(Number(params.cmbPrice)) && Number(params.cmbPrice) > 0) zhOrderParts.push(`建议按招行卖出价 ${params.cmbPrice} 卖出 ${params.grams}克`);
  else if (sideZh && params.grams) zhOrderParts.push(`建议${sideZh} ${params.grams}克`);
  else if (sideZh) zhOrderParts.push(`建议${sideZh}`);
  else if (params.grams) zhOrderParts.push(`${params.grams}克`);
  if (isBuy && Number.isFinite(Number(params.suggestedPrice)) && Number(params.suggestedPrice) > 0) {
    zhOrderParts.push(`挂单价 ${params.suggestedPrice} 元/克`);
  }
  if (params.target) zhOrderParts.push(`${isBuy || isSell ? "卖出目标价" : "目标价"} ${params.target} 元/克`);
  const enOrderParts = [];
  if (isBuy && params.grams) enOrderParts.push(`Suggested limit buy ${params.grams}g`);
  else if (isSell && params.grams && Number.isFinite(Number(params.cmbPrice)) && Number(params.cmbPrice) > 0) enOrderParts.push(`Suggested sell at CMB sell price ${params.cmbPrice} ${params.grams}g`);
  else if (sideEn && params.grams) enOrderParts.push(`Suggested ${sideEn} ${params.grams}g`);
  else if (sideEn) enOrderParts.push(`Suggested ${sideEn}`);
  else if (params.grams) enOrderParts.push(`${params.grams}g`);
  if (isBuy && Number.isFinite(Number(params.suggestedPrice)) && Number(params.suggestedPrice) > 0) {
    enOrderParts.push(`Limit price ${params.suggestedPrice} CNY/g`);
  }
  if (params.target) enOrderParts.push(`${isBuy || isSell ? "sell target" : "target"} ${params.target} CNY/g`);
  const body = zh
    ? `${instrumentZh} ${isSell || isBuy ? "现价" : "参考价"} ${params.price} 元/克 · ${isSell ? "招行卖出价" : isBuy ? "招行买入价" : "招行参考价"} ${params.cmbPrice} 元/克\n${params.action}\n${zhOrderParts.join(" · ")}`
    : `${instrumentEn} ${isSell || isBuy ? "current" : "reference"} ${params.price} CNY/g · CMB ${isSell ? "sell" : isBuy ? "buy" : "reference"} price ${params.cmbPrice} CNY/g\n${params.action}\n${enOrderParts.join(" · ")}`;
  return { title, body, action, params };
}

/** Actions that exit/reduce a position (drive the sell message wording). */
export const SELL_ACTIONS = Object.freeze([
  "sell_take_profit",
  "sell_trailing",
  "sell_stop",
  "sell_weakness",
  "reduce_position",
  "close_by_session_end",
]);

// ── suggested-order lifecycle (v1.9.0) ──────────────────────────────────────
//
// A suggested limit order is not invalidated just because the next evaluation
// flips to 观望 (cooldown / confirmation / a brief data gap): the user's real
// order at the bank keeps working until it fills, expires or is cancelled.
// classifyOrderTransition therefore only escalates to "cancel"/"update" on
// MATERIAL changes and stays silent ("hold") through benign non-directional
// evaluations.

/** Same-shape re-suggestions closer than this (CNY/g) are reaffirmations, not updates. */
export const ORDER_UPDATE_MIN_DELTA_PER_GRAM = 0.5;

/**
 * Quiet window between order_updated notices for the same outstanding
 * suggestion. Same-shape repricing inside the window is adopted silently
 * (refresh). Observed 2026-08-25 01:44–02:00: a live sell-side suggestion
 * re-alerted ~35 times in 16 minutes because every CMB tick moved the
 * suggested limit ≥ ORDER_UPDATE_MIN_DELTA_PER_GRAM.
 */
export const ORDER_UPDATE_MIN_INTERVAL_MS = 10 * 60_000;

/**
 * Cumulative drift (CNY/g) from the LAST NOTIFIED order price that escalates
 * through the quiet window immediately — a fast market must still reach the
 * user; it just may not be spammed on the way there.
 */
export const ORDER_UPDATE_ESCALATION_DELTA_PER_GRAM = 3;

/**
 * True when a same-shape repricing should stay silent: within
 * ORDER_UPDATE_MIN_INTERVAL_MS of the last stamp AND closer than the
 * escalation drift to the price the user was actually told about
 * (`alertedPrice`). Legacy orders without stamps always notify.
 */
function isDampedOrderUpdate(previousOrder, currentOrder, now) {
  const lastStampMs = Date.parse(previousOrder.updatedAt ?? "");
  if (!Number.isFinite(lastStampMs)) return false;
  if (now.getTime() - lastStampMs >= ORDER_UPDATE_MIN_INTERVAL_MS) return false;
  const notified = Number(previousOrder.alertedPrice);
  const candidate = Number(currentOrder.cmbEstimatedPrice);
  if (!Number.isFinite(notified) || !Number.isFinite(candidate)) return false;
  return Math.abs(candidate - notified) < ORDER_UPDATE_ESCALATION_DELTA_PER_GRAM;
}

function orderSideOf(action) {
  if (action === "buy_setup" || action === "add_position") return "buy";
  if (SELL_ACTIONS.includes(action)) return "sell";
  return null;
}

/**
 * Decide what happens to `previousOrder` given the fresh plan evaluation.
 *
 * Events:
 *   record / null     — no outstanding order; caller falls through to the
 *                       normal ALERTABLE_ACTIONS edge flow (record carries a
 *                       brand-new order).
 *   refresh           — same idea re-armed: silently refresh validity.
 *   update            — materially different order → order_updated alert.
 *   hold              — benign wait/data tick while the order stands → keep,
 *                       no alert, no cancel prompt.
 *   cancel            — superseded/conflicting direction → cancel alert.
 *   cancel_drift      — market moved ≥ orderRepricePct away from the limit.
 *   clear_fill        — position moved in the order's direction (filled).
 *   clear_expired     — validUntil passed.
 *   clear_closed      — market closed; orders do not survive the session.
 *
 * Pure; `now` injectable for tests. `positionGrams`/`repricePct` come from the
 * live config by the caller (null positionGrams disables fill detection).
 */
export function classifyOrderTransition({ previousOrder, currentOrder, plan, positionGrams = null, repricePct, now = new Date() }) {
  if (!previousOrder) return { event: currentOrder ? "record" : null };
  const planSide = plan?.marketState === "closed" ? null : orderSideOf(plan?.action);
  if (currentOrder) {
    if (sameSuggestedOrder(previousOrder, currentOrder)) return { event: "refresh" };
    const sameShape = previousOrder.side === currentOrder.side
      && previousOrder.action === currentOrder.action
      && Number(previousOrder.grams) === Number(currentOrder.grams);
    const delta = Math.abs(Number(previousOrder.cmbEstimatedPrice) - Number(currentOrder.cmbEstimatedPrice));
    // Same-shape micro drift (< one threshold step) is the engine re-arming the
    // same idea on a fresh tick — refresh validity instead of spamming updates.
    if (sameShape && Number.isFinite(delta) && delta < ORDER_UPDATE_MIN_DELTA_PER_GRAM) return { event: "refresh" };
    // Same-shape repricing storm damping: inside the quiet window (and short of
    // the escalation drift from the last notified price) the new suggestion is
    // adopted silently, capping order_updated notices at one per quiet window.
    if (sameShape && isDampedOrderUpdate(previousOrder, currentOrder, now)) return { event: "refresh" };
    // A genuinely different order (price/grams/side) replaces the old one; the
    // order_updated message carries both the old and the new suggestion.
    return { event: "update" };
  }
  // No new order this tick — decide between silent clears, cancel and hold.
  const issuedGrams = Number(previousOrder.issuedPositionGrams);
  const gramsNow = Number(positionGrams);
  if (previousOrder.side === "buy" && Number.isFinite(issuedGrams) && Number.isFinite(gramsNow) && gramsNow > issuedGrams + 0.001) {
    return { event: "clear_fill" };
  }
  if (previousOrder.side === "sell" && Number.isFinite(issuedGrams) && Number.isFinite(gramsNow) && gramsNow < issuedGrams - 0.001) {
    return { event: "clear_fill" };
  }
  if (plan?.marketState === "closed") return { event: "clear_closed" };
  const validUntil = Date.parse(previousOrder.validUntil ?? "");
  if (Number.isFinite(validUntil) && now.getTime() >= validUntil) return { event: "clear_expired" };
  if (planSide !== null) {
    return { event: "cancel", cause: planSide === previousOrder.side ? "superseded" : "conflict" };
  }
  // Non-directional evaluation (wait / data gates): hold unless the market has
  // drifted so far from the limit price that filling became implausible.
  const pct = Number.isFinite(Number(repricePct)) && Number(repricePct) > 0 ? Number(repricePct) : 0.5;
  const anchor = Number.isFinite(Number(previousOrder.signalPrice)) && Number(previousOrder.signalPrice) > 0
    ? Number(previousOrder.signalPrice)
    : Number(previousOrder.cmbEstimatedPrice);
  const live = Number(plan?.signalPrice);
  if (Number.isFinite(anchor) && anchor > 0 && Number.isFinite(live) && Math.abs(live - anchor) >= anchor * pct / 100) {
    return { event: "cancel_drift" };
  }
  return { event: "hold" };
}

/** Human-readable reason appended to drift-cancel notices. */
export function buildOrderDriftNote(previousOrder, plan, localeHint = "zh") {
  const zh = localeHint !== "en";
  const anchor = Number.isFinite(Number(previousOrder?.signalPrice)) && Number(previousOrder.signalPrice) > 0
    ? Number(previousOrder.signalPrice)
    : previousOrder?.cmbEstimatedPrice;
  const live = Number(plan?.signalPrice);
  if (!Number.isFinite(anchor) || !Number.isFinite(live)) return "";
  return zh
    ? `现价 ${live} 元/克已偏离原挂单价 ${anchor} 元/克，原挂单较难成交`
    : `Current ${live} CNY/g has drifted from the limit ${anchor} CNY/g`;
}

// ── system notifications ────────────────────────────────────────────────────

function appleScriptString(value) {
  return `"${String(value).replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
}

function psString(value) {
  return `"${String(value).replace(/`/g, "``").replace(/\$/g, "`$").replace(/"/g, '`"')}"`;
}

function execFileAsync(file, args) {
  return new Promise((resolve, reject) => {
    execFile(file, args, { timeout: 10_000 }, (error, stdout, stderr) => {
      if (error) reject(error);
      else resolve({ stdout, stderr });
    });
  });
}

export async function systemNotify(title, body) {
  const current = platform();
  if (current === "darwin") {
    await execFileAsync("osascript", ["-e", `display notification ${appleScriptString(body)} with title ${appleScriptString(title)}`]);
    return;
  }
  if (current === "linux") {
    await execFileAsync("notify-send", [title, body]);
    return;
  }
  if (current === "win32") {
    const script = [
      "[Windows.UI.Notifications.ToastNotificationManager, Windows.UI.Notifications, ContentType = WindowsRuntime] | Out-Null",
      "[Windows.Data.Xml.Dom.XmlDocument, Windows.Data.Xml.Dom.XmlDocument, ContentType = WindowsRuntime] | Out-Null",
      "$xml = [Windows.UI.Notifications.ToastNotificationManager]::GetTemplateContent([Windows.UI.Notifications.ToastTemplateType]::ToastText02)",
      "$texts = $xml.GetElementsByTagName('text')",
      `$texts.Item(0).AppendChild($xml.CreateTextNode(${psString(title)})) | Out-Null`,
      `$texts.Item(1).AppendChild($xml.CreateTextNode(${psString(body)})) | Out-Null`,
      "$toast = [Windows.UI.Notifications.ToastNotification]::new($xml)",
      '[Windows.UI.Notifications.ToastNotificationManager]::CreateToastNotifier("{1AC14E77-02E7-4E5D-B744-2EB1AE5198B7}\\WindowsPowerShell\\v1.0\\powershell.exe").Show($toast)',
    ].join("; ");
    await execFileAsync("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", script]);
    return;
  }
  throw new Error(`当前平台（${current}）不支持系统通知`);
}

// ── webhook channels ────────────────────────────────────────────────────────

export function renderWebhookTemplate(template, message) {
  if (typeof template !== "string" || template.trim() === "") return message.body;
  return templateReplace(template, message.params);
}

/** Merge an unsaved settings-page draft over the saved channel for a test send. */
export function mergeTestConfig(saved, draft) {
  if (draft === null || typeof draft !== "object") return saved ?? {};
  const next = { ...(saved ?? {}), ...draft };
  if (Object.prototype.hasOwnProperty.call(next, "secret")) {
    next.secret = typeof draft.secret === "string" && draft.secret !== "" ? draft.secret : (saved?.secret ?? "");
  }
  if (draft.headers !== null && typeof draft.headers === "object" && saved?.headers !== null && typeof saved?.headers === "object") {
    next.headers = { ...saved.headers, ...draft.headers };
  }
  return next;
}

/**
 * POST one JSON payload. The default transport routes through the shared
 * source registry's timeout fetch so tests' `__setFetchImpl` covers webhook
 * posts too; callers may inject their own `post(url, value, headers)`.
 */
function defaultPost(url, value, headers = {}) {
  return getDefaultSourceRegistry().fetchWithTimeout(url, {
    method: "POST",
    headers: { "content-type": "application/json; charset=utf-8", ...headers },
    body: JSON.stringify(value),
  });
}

async function postJson(url, value, post = defaultPost, headers = {}) {
  const response = await post(url, value, headers);
  const text = await response.text();
  let data = null;
  if (text !== "") {
    try { data = JSON.parse(text); } catch { /* some gateways return non-JSON success */ }
  }
  return { response, data };
}

function webhookConfigError(message) {
  return Object.assign(new Error(message), { statusCode: 400, code: "WEBHOOK_NOT_CONFIGURED" });
}

export async function sendFeishu(cfg, text, post) {
  if (!cfg?.enabled) throw webhookConfigError("飞书 webhook 未启用");
  if (!cfg.url) throw webhookConfigError("飞书 webhook 地址未配置");
  const secret = cfg.secret;
  const timestamp = Math.floor(Date.now() / 1000);
  const payload = { msg_type: "text", content: { text } };
  if (secret) {
    const stringToSign = `${timestamp}\n${secret}`;
    const sign = createHmac("sha256", stringToSign).update("").digest("base64");
    payload.timestamp = timestamp;
    payload.sign = sign;
  }
  const { data } = await postJson(cfg.url, payload, post);
  if (data !== null && typeof data.code === "number" && data.code !== 0) {
    throw new Error(`飞书 webhook 失败：${data.msg ?? data.code}`);
  }
}

export async function sendDingtalk(cfg, text, post) {
  if (!cfg?.enabled) throw webhookConfigError("钉钉 webhook 未启用");
  if (!cfg.url) throw webhookConfigError("钉钉 webhook 地址未配置");
  const secret = cfg.secret;
  const timestamp = Date.now();
  let url = cfg.url;
  if (secret) {
    const stringToSign = `${timestamp}\n${secret}`;
    const sign = encodeURIComponent(createHmac("sha256", secret).update(stringToSign).digest("base64"));
    url += (url.includes("?") ? "&" : "?") + `timestamp=${timestamp}&sign=${sign}`;
  }
  const { data } = await postJson(url, { msgtype: "text", text: { content: text } }, post);
  if (data !== null && typeof data.errcode === "number" && data.errcode !== 0) {
    throw new Error(`钉钉 webhook 失败：${data.errmsg ?? data.errcode}`);
  }
}

export async function sendWecom(cfg, text, post) {
  if (!cfg?.enabled) throw webhookConfigError("企业微信 webhook 未启用");
  if (!cfg.url) throw webhookConfigError("企业微信 webhook 地址未配置");
  const { data } = await postJson(cfg.url, { msgtype: "text", text: { content: text } }, post);
  if (data !== null && typeof data.errcode === "number" && data.errcode !== 0) {
    throw new Error(`企业微信 webhook 失败：${data.errmsg ?? data.errcode}`);
  }
}

export async function sendGeneric(cfg, text, post) {
  if (!cfg?.enabled) throw webhookConfigError("通用 webhook 未启用");
  if (!cfg.url) throw webhookConfigError("通用 webhook 地址未配置");
  const headers = { "user-agent": USER_AGENT, ...cfg.headers };
  await postJson(cfg.url, { text }, post, headers);
}

/** Channel-name normalizer for generic webhook ids. */
function genericChannelName(generic, index) {
  return generic.id ? `generic:${generic.id}` : `generic:${index + 1}`;
}

/**
 * Deliver one alert over every enabled channel (plan-03 03.6).
 *
 * Returns the per-channel outcome `[{ channel, ok, error? }]` so the alerts
 * log can record where a notification actually went — the old version
 * swallowed results and callers logged `sentTo: [null]`. Failures are also
 * logged here as warnings, keeping the previous behaviour.
 *
 * @param options.post  optional transport `(url, value, headers) => Promise<response>`
 */
export async function dispatchAlert(config, message, logger, options = {}) {
  const post = options.post ?? defaultPost;
  const jobs = [];
  if (config.system.enabled) {
    jobs.push(["system", () => systemNotify(message.title, message.body)]);
  }
  const wh = config.webhooks;
  if (wh.feishu.enabled) jobs.push(["feishu", () => sendFeishu(wh.feishu, renderWebhookTemplate(wh.feishu.bodyTemplate, message), post)]);
  if (wh.dingtalk.enabled) jobs.push(["dingtalk", () => sendDingtalk(wh.dingtalk, renderWebhookTemplate(wh.dingtalk.bodyTemplate, message), post)]);
  if (wh.wecom.enabled) jobs.push(["wecom", () => sendWecom(wh.wecom, renderWebhookTemplate(wh.wecom.bodyTemplate, message), post)]);
  wh.generic.forEach((generic, index) => {
    if (generic.enabled) {
      jobs.push([genericChannelName(generic, index), () => sendGeneric(generic, renderWebhookTemplate(generic.bodyTemplate, message), post)]);
    }
  });
  const settled = await Promise.allSettled(jobs.map(([, run]) => run()));
  return settled.map((result, index) => {
    const channel = jobs[index][0];
    if (result.status === "fulfilled") return { channel, ok: true };
    logger?.warn?.(`dsh-plugin-goldboard: ${channel} notify failed: ${String(result.reason?.message ?? result.reason)}`);
    return { channel, ok: false, error: String(result.reason?.message ?? result.reason).slice(0, 200) };
  });
}

/** One-shot notice fired on the tick a signal-lane downgrade is confirmed. */
export function buildLaneSwitchMessage(plan, localeHint = "zh") {
  const zh = localeHint !== "en";
  const from = plan?.laneSwitchedFrom ?? null;
  const to = plan?.signalLane ?? plan?.instrument ?? null;
  const label = (lane) => {
    if (lane === "CMB") return zh ? "招行积存金实时价" : "live CMB accumulated gold";
    if (lane === "XAU") return zh ? "国际金价折算" : "converted international spot gold";
    return zh ? "Au99.99 国内金价" : "SGE Au99.99";
  };
  const title = zh ? "黄金看板 · 信号数据源已切换" : "Gold Board · signal data source switched";
  const body = zh
    ? `${label(from)} 暂不可用，信号已切换为${label(to)}口径；恢复后将自动切回。看板指标与建议已按新数据源重新计算。`
    : `${from ? label(from)[0].toUpperCase() + label(from).slice(1) : "The previous source"} is unavailable; the signal switched to ${label(to)}. It switches back automatically after recovery, and indicators were recomputed on the new source.`;
  return {
    title,
    body,
    action: "lane_switched",
    params: {
      action: title,
      instrument: to ?? "",
      price: Number.isFinite(Number(plan?.signalPrice)) ? plan.signalPrice : "",
      from: from ?? "",
      to: to ?? "",
      time: new Date().toISOString(),
    },
  };
}

/** Tip-only alert when today's domestic premium breaks ±2σ of recent days. */
export function buildSpreadAlertMessage(plan, premiumStats, localeHint = "zh") {
  const zh = localeHint !== "en";
  const title = zh ? "黄金看板 · 内外盘价差异常" : "Gold Board · unusual domestic premium";
  const deviation = premiumStats?.deviationSigma;
  const deviationText = Number.isFinite(Number(deviation)) ? `${Number(deviation).toFixed(1)}σ` : "";
  const today = plan?.derivedPremiumToday ?? premiumStats?.today ?? "";
  const meanText = premiumStats?.mean != null && Number.isFinite(Number(premiumStats.mean)) ? Number(premiumStats.mean) : "";
  const body = zh
    ? `今日内外盘价差 ${today} 元/克，偏离近 ${premiumStats?.sampleCount ?? ""} 日均值${meanText !== "" ? ` ${meanText}` : ""} 达 ${deviationText}。仅提示关注，不构成操作建议。`
    : `Today's domestic premium ${today} CNY/g deviates ${deviationText} from the ${premiumStats?.sampleCount ?? ""}-day mean${meanText !== "" ? ` of ${meanText}` : ""}. Informational only.`;
  return {
    title,
    body,
    action: "spread_alert",
    params: {
      action: title,
      instrument: "AU9999",
      price: today,
      premiumMean: meanText,
      deviationSigma: deviationText,
      sampleDays: premiumStats?.sampleDays ?? "",
      time: new Date().toISOString(),
    },
  };
}

// str() is re-exported for route handlers that sanitize request bodies.
export { str };

// ── alert-edge evaluation (composition-root glue, plan-05) ──────────────────

/** Plan actions that fire an edge alert the first time they appear. */
export const ALERTABLE_ACTIONS = new Set([
  "buy_setup",
  "add_position",
  "reduce_position",
  "sell_take_profit",
  "sell_trailing",
  "sell_stop",
  "sell_weakness",
  "close_by_session_end",
  "spread_alert",
  "data_stale",
]);

/**
 * One alert pass over the current plan (runs once per tick).
 *
 * Ported verbatim from the pre-split composition root. `io` carries the two
 * side-effecting operations:
 *
 *   - `io.dispatchAlert(message)` → per-channel results (bound dispatchAlert)
 *   - `io.logAlert(message, channelResults)` → alerts log append + persist
 */
export async function runAlertEvaluation(runtime, io) {
  const plan = runtime.plan;
  if (!plan) return;

  // Signal-lane downgrade notice (plan-03 03.1): one-shot on the tick the
  // switch is confirmed. Recovery switches back silently — the dashboard's
  // signalLane field shows the current source either way.
  if (plan.laneSwitchedFrom && plan.signalLane && plan.signalLane !== plan.laneSwitchedFrom) {
    const priorityFrom = SIGNAL_LANES.indexOf(plan.laneSwitchedFrom);
    const priorityTo = SIGNAL_LANES.indexOf(plan.signalLane);
    if (priorityTo > priorityFrom) {
      const message = buildLaneSwitchMessage(plan, runtime.localeHint);
      await io.logAlert(message, await io.dispatchAlert(message));
      return;
    }
  }

  // spread_alert (plan-03 03.2): tip-only edge alert. Suppression is keyed
  // by Beijing date (not the generic alertState map) so unrelated resets
  // never re-fire it mid-day; a new day re-arms automatically.
  const spreadCheck = runtime.spreadCheck;
  if (spreadCheck?.ready && spreadCheck.anomaly === true) {
    const today = beijingDateForNow(new Date());
    if (today && runtime.spreadAlertDate !== today) {
      runtime.spreadAlertDate = today;
      const message = buildSpreadAlertMessage({ derivedPremiumToday: spreadCheck.today }, spreadCheck, runtime.localeHint);
      await io.logAlert(message, await io.dispatchAlert(message));
      return;
    }
  }

  const action = plan.action;
  const currentOrder = plan.suggestedOrder || null;
  const previousOrder = runtime.lastSuggestedOrder || null;
  // v1.9.0 order lifecycle: classify the transition instead of treating every
  // wait-shaped tick as "cancel your order". Benign cooldown/confirmation/data
  // gaps HOLD the outstanding suggestion silently; only material changes
  // (update / conflict / drift) alert, and fills/expiry/close clear quietly.
  const transition = previousOrder || currentOrder
    ? classifyOrderTransition({
      previousOrder,
      currentOrder,
      plan,
      positionGrams: Number(runtime.config?.position?.grams),
      repricePct: runtime.config?.strategy?.orderRepricePct,
    })
    : { event: null };

  if (transition.event === "hold") {
    return; // Order stands; no repeated cancel prompts while waiting to fill.
  }

  if (transition.event === "clear_fill" || transition.event === "clear_expired" || transition.event === "clear_closed") {
    runtime.lastSuggestedOrder = null;
    runtime.alertState = {};
    return;
  }

  if (transition.event === "refresh") {
    // Same idea re-armed: refresh validity, keep the original issuance stamps.
    // Damped repricing also lands here — the new price is adopted but the
    // quiet-window origin (`updatedAt`) and the last NOTIFIED price
    // (`alertedPrice`) must survive, or chained drift would escape escalation.
    runtime.lastSuggestedOrder = {
      ...currentOrder,
      issuedAt: previousOrder.issuedAt ?? new Date().toISOString(),
      ...(Number.isFinite(Date.parse(previousOrder.updatedAt ?? "")) ? { updatedAt: previousOrder.updatedAt } : {}),
      ...(previousOrder.alertedPrice === undefined ? {} : { alertedPrice: previousOrder.alertedPrice }),
      issuedPositionGrams: Number.isFinite(Number(previousOrder.issuedPositionGrams))
        ? Number(previousOrder.issuedPositionGrams)
        : Number(runtime.config?.position?.grams),
    };
  }

  if (transition.event === "update") {
    runtime.lastSuggestedOrder = stampOrder(currentOrder, runtime);
    const message = buildOrderChangeMessage(plan, previousOrder, "update", runtime.config, runtime.localeHint);
    await io.logAlert(message, await io.dispatchAlert(message));
    if (currentOrder?.action) runtime.alertState[currentOrder.action] = "fired";
    return;
  }

  if (transition.event === "cancel") {
    runtime.lastSuggestedOrder = null;
    const message = buildOrderChangeMessage(plan, previousOrder, "cancel", runtime.config, runtime.localeHint);
    await io.logAlert(message, await io.dispatchAlert(message));
    runtime.alertState = {};
    return;
  }

  if (transition.event === "cancel_drift") {
    runtime.lastSuggestedOrder = null;
    const note = buildOrderDriftNote(previousOrder, plan, runtime.localeHint);
    const message = buildOrderChangeMessage(plan, previousOrder, "cancel", runtime.config, runtime.localeHint, note);
    await io.logAlert(message, await io.dispatchAlert(message));
    runtime.alertState = {};
    return;
  }

  if (!ALERTABLE_ACTIONS.has(action)) {
    runtime.alertState = {};
    return;
  }
  if (runtime.alertState[action] === "fired") return;
  runtime.alertState[action] = "fired";
  if (currentOrder) runtime.lastSuggestedOrder = stampOrder(currentOrder, runtime);
  const message = buildAlertMessage(plan, runtime.config, runtime.localeHint);
  await io.logAlert(message, await io.dispatchAlert(message));
}

/** Record issuance metadata used by fill detection and update damping. */
function stampOrder(order, runtime) {
  const now = new Date().toISOString();
  return {
    ...order,
    issuedAt: now,
    // updatedAt anchors the order_updated quiet window; alertedPrice pins the
    // last NOTIFIED limit so cumulative drift can escalate through silence.
    updatedAt: now,
    alertedPrice: order.cmbEstimatedPrice,
    issuedPositionGrams: Number(runtime.config?.position?.grams),
  };
}

