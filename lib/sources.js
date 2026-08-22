/**
 * Quote/data sources: transport, circuit breaker, api-log feed and the
 * SourceRegistry that owns all of it per plugin instance.
 *
 * plan-05: extracted from the old monolith AND de-singletoned (P2#19):
 * circuit map / inflight dedup / fetch impl / chain timing / api-log ring are
 * all instance state on SourceRegistry — one registry per apply(). A lazy
 * default instance backs the legacy free-function wrappers for the existing
 * unit suites; production always uses an explicit instance. Pure wire-format
 * parsers live in parsers.js.
 */

import { open, appendFile, rename, stat } from "node:fs/promises";

import {
  STALE_QUOTE_MS,
  isDomesticQuoteFresh,
  parseCmbMarketCenterQuote,
  parseEastmoneyDomesticQuote,
  parseEastmoneyKlines,
  parseGoldApiQuote,
  parseGoldPriceTodayQuote,
  parseJdGoldQuote,
  parseJijinhaoQuote,
  parseSgeDailyBars,
  parseSgeQuote,
  parseSinaDomesticQuote,
  parseSixtySecondsGoldPrice,
  parseTencentForexQuote,
  parseTencentXauQuote,
  parseYahooFinanceKlines,
  parseYahooFinanceQuote,
} from "./parsers.js";

// Re-export the whole parser surface so existing importers keep one module.
export * from "./parsers.js";

// ── constants ──────────────────────────────────────────────────────────────

export const QUOTE_TIMEOUT_MS = 6_000;
export const FETCH_TIMEOUT_MS = 10_000;
export const CIRCUIT_FAIL_THRESHOLD = 3;
export const CIRCUIT_OPEN_MS = 10 * 60 * 1000;
export const USER_AGENT = "dsh-plugin-goldboard/0.1 (+DeepSeek Harness plugin)";

export const SGE_QUOTATIONS_URL = "https://www.sge.com.cn/graph/quotations";
export const SGE_DAILY_URL = "https://www.sge.com.cn/graph/Dailyhq";
export const SIXTY_SECONDS_URL = "https://60s.viki.moe/v2/gold-price";
export const GOLD_API_URL = "https://api.gold-api.com/price/XAU";
export const GOLD_PRICE_TODAY_URL = "https://goldprice.today/api.php?data=live";
export const YAHOO_XAU_URL = "https://query1.finance.yahoo.com/v8/finance/chart/GC=F?interval=1d&range=1d";
export const YAHOO_XAU_HISTORY_URL = "https://query1.finance.yahoo.com/v8/finance/chart/GC=F?interval=1d&range=5y";
export const JIJINHAO_URL = "https://api.jijinhao.com/quoteCenter/realTime.htm?codes=JO_42660,JO_42657,JO_42653,JO_42625,JO_42646,JO_42634,JO_42632,JO_52678,JO_52670,JO_52674,JO_42638";
export const JD_GOLD_URL = "https://api.jdjygold.com/gw2/generic/jrm/h5/m/stdLatestPrice?productSku=1961543816";
export const CMB_API_URL = "https://mbmodule-openapi.paas.cmbchina.com/product/v1/func/market-center";
const CMB_API_PARAMS = JSON.stringify([{ prdType: "H", prdCode: "" }]);
export const EASTMONEY_KLINE_URL = (secid, klt, limit) =>
  `https://push2his.eastmoney.com/api/qt/stock/kline/get?secid=${secid}&klt=${klt}&fqt=1&lmt=${limit}` +
  "&end=20500101&iscca=1&fields1=f1,f2,f3,f4,f5,f6,f7,f8&fields2=f51,f52,f53,f54,f55,f56,f57,f58";

// One shared deadline per fallback chain (see quoteChain). Previously each
// source stacked its own full 6s timeout, so a dead domestic chain could block
// a tick for ~24s (XAU chain: ~42s). Now a source's timeout is its share of
// the remaining budget, clamped to [3.5s, 6s] and never above the remaining
// budget; once the budget is gone the rest of the chain is skipped. The
// chain's AbortController is aborted when the chain settles (first success or
// exhaustion), so no request or half-read body outlives it.
export const QUOTE_CHAIN_BUDGET_MS = 12_000;
export const QUOTE_MIN_SOURCE_TIMEOUT_MS = 3_500;

export const DATA_SOURCES = Object.freeze([
  Object.freeze({ id: "sina-domestic", nameZh: "新浪财经 Au99.99", nameEn: "Sina Finance Au99.99", source: "sina", kind: "domestic", instrument: "AU9999", url: "https://hq.sinajs.cn/list=gds_AU9999" }),
  Object.freeze({ id: "sge-domestic", nameZh: "上金所 SGE Au99.99", nameEn: "SGE Au99.99", source: "sge", kind: "domestic", instrument: "AU9999", url: "https://www.sge.com.cn/graph/quotations" }),
  Object.freeze({ id: "sge-history", nameZh: "上金所 SGE 历史", nameEn: "SGE History", source: "sge", kind: "history", instrument: null, url: "https://www.sge.com.cn/graph/Dailyhq" }),
  Object.freeze({ id: "eastmoney-domestic", nameZh: "东方财富 Au99.99", nameEn: "Eastmoney Au99.99", source: "eastmoney", kind: "domestic", instrument: "AU9999", url: "https://push2.eastmoney.com/api/qt/stock/get?secid=118.AU9999" }),
  Object.freeze({ id: "sixty-domestic", nameZh: "60s API 国内金价", nameEn: "60s API Domestic", source: "60s", kind: "domestic", instrument: "AU9999", url: "https://60s.viki.moe/v2/gold-price" }),
  Object.freeze({ id: "tencent-xau", nameZh: "腾讯行情 XAU", nameEn: "Tencent XAU", source: "tencent", kind: "xau", instrument: "XAU", url: "https://qt.gtimg.cn/q=hf_XAU" }),
  Object.freeze({ id: "sina-xau", nameZh: "新浪财经 XAU", nameEn: "Sina Finance XAU", source: "sina", kind: "xau", instrument: "XAU", url: "https://hq.sinajs.cn/list=hf_XAU" }),
  Object.freeze({ id: "gold-api-xau", nameZh: "gold-api.com XAU", nameEn: "gold-api.com XAU", source: "gold-api", kind: "xau", instrument: "XAU", url: "https://api.gold-api.com/price/XAU" }),
  Object.freeze({ id: "sixty-xau", nameZh: "60s API 国际金价", nameEn: "60s API International", source: "60s", kind: "xau", instrument: "XAU", url: "https://60s.viki.moe/v2/gold-price" }),
  Object.freeze({ id: "goldprice-today-xau", nameZh: "GoldPrice.Today XAU", nameEn: "GoldPrice.Today XAU", source: "goldprice-today", kind: "xau", instrument: "XAU", url: "https://goldprice.today/api.php?data=live" }),
  Object.freeze({ id: "yahoo-xau", nameZh: "Yahoo Finance COMEX 黄金期货", nameEn: "Yahoo Finance COMEX Gold Futures", source: "yahoo", kind: "futures", instrument: "GC=F", market: "futures", url: "https://query1.finance.yahoo.com/v8/finance/chart/GC=F" }),
  Object.freeze({ id: "yahoo-history-xau", nameZh: "Yahoo Finance COMEX 黄金期货日线", nameEn: "Yahoo Finance COMEX Gold Futures Daily", source: "yahoo", kind: "history", instrument: "GC=F", market: "futures", url: "https://query1.finance.yahoo.com/v8/finance/chart/GC=F?interval=1d&range=5y" }),
  Object.freeze({ id: "tencent-usdcny", nameZh: "腾讯行情 USDCNY", nameEn: "Tencent USDCNY", source: "tencent", kind: "usdcny", instrument: "USDCNY", url: "https://qt.gtimg.cn/q=whUSDCNY" }),
  Object.freeze({ id: "cmb-market-center", nameZh: "招商银行积存金", nameEn: "CMB 积存金", source: "cmb", kind: "cmb", instrument: "CMB", url: "https://mbmodule-openapi.paas.cmbchina.com/product/v1/func/market-center" }),
  Object.freeze({ id: "jijinhao-brand", nameZh: "金投网品牌金价", nameEn: "Jinjinhao Brand Gold", source: "jijinhao", kind: "brand", instrument: null, url: "https://api.jijinhao.com/quoteCenter/realTime.htm" }),
  Object.freeze({ id: "jdjy-gold", nameZh: "京东金融积存金", nameEn: "JD Finance Accumulated Gold", source: "jdjy", kind: "cmb", instrument: null, url: "https://api.jdjygold.com/gw2/generic/jrm/h5/m/stdLatestPrice" }),
  Object.freeze({ id: "eastmoney-kline-au", nameZh: "东方财富 Au99.99 K线", nameEn: "Eastmoney Au99.99 K-line", source: "eastmoney", kind: "history", instrument: null, url: "https://push2his.eastmoney.com/api/qt/stock/kline/get?secid=118.AU9999" }),
  Object.freeze({ id: "eastmoney-kline-xau", nameZh: "东方财富 XAU K线", nameEn: "Eastmoney XAU K-line", source: "eastmoney", kind: "history", instrument: null, url: "https://push2his.eastmoney.com/api/qt/stock/kline/get?secid=122.XAU" }),
]);

const GB18030_DECODER = new TextDecoder("gb18030");

// ── SourceRegistry ──────────────────────────────────────────────────────────

/**
 * One registry per plugin instance. Owns every mutable piece of source
 * plumbing: injected fetch impl, chain timing knobs, the circuit-breaker
 * map, the 60s inflight dedup, and the api-log sink binding.
 */
// Module-level TEST SEAMS (deliberate, plan-02): every registry resolves its
// transport and chain timing through these live bindings so `__setFetchImpl`
// / `__setQuoteChainTiming` affect instances created before OR after the call.
// They carry no plugin behavioural state — circuit map / logs / inflight stay
// per-instance.
const FETCH_DEFAULT = (...args) => fetch(...args);
let moduleFetch = FETCH_DEFAULT;
let moduleChainBudgetMs = QUOTE_CHAIN_BUDGET_MS;
let moduleChainMinSourceTimeoutMs = QUOTE_MIN_SOURCE_TIMEOUT_MS;

export class SourceRegistry {
  /**
   * @param options.logStore  ApiLogStore-like sink: `{ append(entry),
   *   load(): Promise<entry[]>, list(sourceId?) }`. Optional — without one
   *   calls are still recorded in-memory via a minimal ring.
   * @param options.fetchImpl optional per-instance transport override;
   *   defaults to the shared module seam (see __setFetchImpl).
   */
  constructor(options = {}) {
    this.logStore = options.logStore ?? null;
    this.fetchImpl = options.fetchImpl ?? null;
    this.circuitState = new Map();
    this.sixtySecondsInflight = null;
    // In-memory fallback ring used when no log store is bound.
    this.memoryLogs = [];
  }

  /** Transport actually used for outbound calls (instance override wins). */
  get transport() {
    return this.fetchImpl ?? moduleFetch;
  }

  get quoteChainBudgetMs() {
    return moduleChainBudgetMs;
  }

  get quoteChainMinSourceTimeoutMs() {
    return moduleChainMinSourceTimeoutMs;
  }

  /** Test-only hook on THIS instance: replace the transport. Returns the previous one. */
  setFetchImpl(impl) {
    const previous = this.transport;
    this.fetchImpl = typeof impl === "function" ? impl : null;
    return previous;
  }

  /** Test-only hook: override chain budget / per-source timeout floor. */
  setQuoteChainTiming(opts = {}) {
    const previous = { budgetMs: moduleChainBudgetMs, minSourceTimeoutMs: moduleChainMinSourceTimeoutMs };
    if (Number.isFinite(opts.budgetMs)) moduleChainBudgetMs = Math.max(1, opts.budgetMs);
    if (Number.isFinite(opts.minSourceTimeoutMs)) moduleChainMinSourceTimeoutMs = Math.max(1, opts.minSourceTimeoutMs);
    return previous;
  }

  // ── circuit breaker ──────────────────────────────────────────────────────
  //
  // A source is opened (skipped) after CIRCUIT_FAIL_THRESHOLD consecutive
  // failures and stays open for CIRCUIT_OPEN_MS. This prevents a broken free
  // API from being hammered on every poll and forces fallback to the next
  // available source sooner.

  /**
   * Read-only view of one source's breaker state. Expired openings are
   * reported as closed without mutating shared state — the mutation happens
   * in markSourceSuccess/markSourceFailure when real traffic arrives.
   */
  circuitInfo(sourceId) {
    const state = this.circuitState.get(sourceId);
    if (!state) return { open: false, failures: 0 };
    if (state.openedAt && Date.now() - state.openedAt >= CIRCUIT_OPEN_MS) {
      return { open: false, failures: 0 };
    }
    return { open: Boolean(state.openedAt), failures: state.failures };
  }

  isCircuitOpen(sourceId) {
    return this.circuitInfo(sourceId).open;
  }

  markSourceSuccess(sourceId) {
    this.circuitState.delete(sourceId);
  }

  markSourceFailure(sourceId) {
    if (this.isCircuitOpen(sourceId)) return;
    const state = this.circuitState.get(sourceId) || { failures: 0, openedAt: null };
    state.failures += 1;
    if (state.failures >= CIRCUIT_FAIL_THRESHOLD) {
      state.openedAt = Date.now();
    }
    this.circuitState.set(sourceId, state);
  }

  async trackedCall(entry, fn) {
    if (this.isCircuitOpen(entry.sourceId)) {
      throw new Error(`source circuit open: ${entry.sourceId}`);
    }
    const startedAt = Date.now();
    try {
      const result = await fn();
      const ok = !!result && (Array.isArray(result) ? result.length > 0 : true);
      if (ok) this.markSourceSuccess(entry.sourceId);
      else this.markSourceFailure(entry.sourceId);
      this.recordApiCall({
        ...entry,
        ok,
        durationMs: Date.now() - startedAt,
        error: ok ? undefined : "empty or parse failed",
      });
      return result;
    } catch (error) {
      this.markSourceFailure(entry.sourceId);
      this.recordApiCall({
        ...entry,
        ok: false,
        durationMs: Date.now() - startedAt,
        error: error?.message ?? String(error ?? "request failed"),
      });
      throw error;
    }
  }

  // ── api call log ─────────────────────────────────────────────────────────

  recordApiCall(entry) {
    const logEntry = {
      id: `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`,
      time: new Date().toISOString(),
      sourceId: entry.sourceId,
      source: entry.source,
      kind: entry.kind,
      url: entry.url,
      ok: entry.ok === true,
      status: entry.status,
      durationMs: entry.durationMs,
      error: entry.error ? String(entry.error).slice(0, 500) : undefined,
    };
    if (this.logStore) {
      this.logStore.append(logEntry);
      return;
    }
    this.memoryLogs.unshift(logEntry);
    if (this.memoryLogs.length > MAX_MEMORY_API_LOGS) this.memoryLogs.length = MAX_MEMORY_API_LOGS;
  }

  getApiLogs(sourceId) {
    const logs = this.logStore ? this.logStore.list() : this.memoryLogs;
    if (!sourceId) return logs.slice();
    return logs.filter((entry) => entry.sourceId === sourceId);
  }

  /** Wire view of the source catalog enriched with per-source health. */
  dataSourceView(runtime, { staleQuoteMs = STALE_QUOTE_MS } = {}) {
    const now = Date.now();
    return DATA_SOURCES.map((source) => {
      const logs = this.getApiLogs(source.id);
      const last = logs[0] || null;
      const quoteKey = source.instrument === "GC=F" ? "GCF" : source.instrument;
      const quote = quoteKey ? runtime.quotes?.[quoteKey] : null;
      const current = quote && quote.source === source.source
        ? {
            price: quote.price,
            updatedAt: quote.updatedAt,
            stale: !Number.isFinite(quote.updatedAt) || now - quote.updatedAt > staleQuoteMs || !isDomesticQuoteFresh(quote, new Date(now)),
            instrument: quote.instrument,
            market: quote.market,
            quality: quote.quality,
          }
        : null;
      return {
        id: source.id,
        nameZh: source.nameZh,
        nameEn: source.nameEn,
        source: source.source,
        kind: source.kind,
        instrument: source.instrument,
        url: source.url,
        status: last ? (last.ok ? "ok" : "error") : "unknown",
        lastTime: last?.time,
        lastOk: last?.ok,
        lastError: last?.error,
        lastDurationMs: last?.durationMs,
        current,
        logCount: logs.length,
      };
    });
  }

  // ── HTTP helpers ─────────────────────────────────────────────────────────

  /**
   * Fetch a URL with a hard timeout that covers headers AND body, linked to an
   * optional chain-level abort signal. The old helper stopped its timer once
   * headers arrived, so a stalled body could hang a quote chain indefinitely;
   * here the whole exchange is bounded.
   */
  async fetchBody(url, options, timeoutMs, chainSignal, decode) {
    const controller = new AbortController();
    const onChainAbort = () => controller.abort(chainSignal.reason);
    if (chainSignal) {
      if (chainSignal.aborted) controller.abort(chainSignal.reason);
      else chainSignal.addEventListener("abort", onChainAbort, { once: true });
    }
    const timer = setTimeout(() => controller.abort(new Error(`timeout after ${timeoutMs}ms`)), timeoutMs);
    try {
      const response = await this.transport(url, { ...options, signal: controller.signal });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      return await decode(response);
    } finally {
      clearTimeout(timer);
      if (chainSignal) chainSignal.removeEventListener("abort", onChainAbort);
    }
  }

  async fetchWithTimeout(url, options = {}, timeoutMs = FETCH_TIMEOUT_MS) {
    return this.fetchBody(url, options, timeoutMs, null, (response) => response);
  }

  async fetchUtf8(url, options = {}, timeoutMs = FETCH_TIMEOUT_MS, chainSignal = null) {
    return this.fetchBody(url, options, timeoutMs, chainSignal, (response) => response.text());
  }

  async fetchGb18030(url, options = {}, timeoutMs = QUOTE_TIMEOUT_MS, chainSignal = null) {
    return this.fetchBody(url, options, timeoutMs, chainSignal, async (response) => GB18030_DECODER.decode(await response.arrayBuffer()));
  }

  // ── individual sources ───────────────────────────────────────────────────

  async fetchCmbQuote() {
    const chain = this.quoteChain();
    return this.trackedCall({
      sourceId: "cmb-market-center",
      source: "cmb",
      kind: "cmb",
      url: CMB_API_URL,
    }, async () => {
      let lastError = null;
      // The upstream koishi plugin uses a form-encoded POST; also keep a JSON
      // POST and a GET fallback in case the endpoint only accepts those. The
      // three transports share one 12s chain budget instead of stacking 3×6s.
      const transports = [
        (timeoutMs) => this.fetchUtf8(CMB_API_URL, {
          method: "POST",
          headers: {
            "content-type": "application/x-www-form-urlencoded; charset=UTF-8",
            "user-agent": USER_AGENT,
            "referer": "https://mbmodule-openapi.paas.cmbchina.com/",
          },
          body: `params=${encodeURIComponent(CMB_API_PARAMS)}`,
        }, timeoutMs, chain.signal),
        (timeoutMs) => this.fetchUtf8(CMB_API_URL, {
          method: "POST",
          headers: {
            "content-type": "application/json; charset=UTF-8",
            "user-agent": USER_AGENT,
            "referer": "https://mbmodule-openapi.paas.cmbchina.com/",
          },
          body: JSON.stringify({ params: CMB_API_PARAMS }),
        }, timeoutMs, chain.signal),
        (timeoutMs) => this.fetchUtf8(`${CMB_API_URL}?params=${encodeURIComponent(CMB_API_PARAMS)}`, {
          headers: { "user-agent": USER_AGENT, "referer": "https://mbmodule-openapi.paas.cmbchina.com/" },
        }, timeoutMs, chain.signal),
      ];
      try {
        for (let index = 0; index < transports.length; index += 1) {
          const timeoutMs = chain.sourceTimeoutMs(transports.length - index);
          if (timeoutMs <= 0) break; // chain budget exhausted
          try {
            const text = await transports[index](timeoutMs);
            const parsed = parseCmbMarketCenterQuote(JSON.parse(text));
            if (parsed) return { ...parsed, source: "cmb" };
            lastError = new Error("CMB market center response did not contain zBuyPrc/zSelPrc");
          } catch (error) {
            lastError = error;
          }
        }
      } finally {
        chain.settle();
      }
      throw lastError ?? new Error("CMB quote fetch failed");
    });
  }

  async fetchSgeQuote(opts = {}) {
    return this.trackedCall({
      sourceId: "sge-domestic",
      source: "sge",
      kind: "domestic",
      instrument: "AU9999",
      url: SGE_QUOTATIONS_URL,
    }, async () => {
      const text = await this.fetchUtf8(SGE_QUOTATIONS_URL, {
        method: "POST",
        headers: {
          "content-type": "application/x-www-form-urlencoded; charset=UTF-8",
          "referer": "https://www.sge.com.cn/sjzx/mrhq",
          "user-agent": USER_AGENT,
        },
        body: "instid=Au99.99",
      }, opts.timeoutMs ?? QUOTE_TIMEOUT_MS, opts.signal ?? null);
      const parsed = parseSgeQuote(JSON.parse(text));
      return parsed ? { ...parsed, source: "sge" } : null;
    });
  }

  async fetchSgeDailyBars() {
    return this.trackedCall({
      sourceId: "sge-history",
      source: "sge",
      kind: "history",
      instrument: null,
      url: SGE_DAILY_URL,
    }, async () => {
      const text = await this.fetchUtf8(SGE_DAILY_URL, {
        method: "POST",
        headers: {
          "content-type": "application/x-www-form-urlencoded; charset=UTF-8",
          "referer": "https://www.sge.com.cn/sjzx/mrhq",
          "user-agent": USER_AGENT,
        },
        body: "instid=Au99.99",
      }, QUOTE_TIMEOUT_MS);
      return parseSgeDailyBars(JSON.parse(text));
    });
  }

  async fetchSixtySecondsRaw(opts = {}) {
    if (!this.sixtySecondsInflight) {
      this.sixtySecondsInflight = (async () => {
        const text = await this.fetchUtf8(SIXTY_SECONDS_URL, {
          headers: { "user-agent": USER_AGENT },
        }, opts.timeoutMs ?? QUOTE_TIMEOUT_MS, opts.signal ?? null);
        return parseSixtySecondsGoldPrice(JSON.parse(text));
      })().finally(() => {
        this.sixtySecondsInflight = null;
      });
    }
    return this.sixtySecondsInflight;
  }

  async fetchSixtySecondsQuote(sourceId = "sixty-domestic", kind = "domestic", instrument = "AU9999", opts = {}) {
    return this.trackedCall({
      sourceId,
      source: "60s",
      kind,
      instrument,
      url: SIXTY_SECONDS_URL,
    }, async () => {
      const parsed = await this.fetchSixtySecondsRaw(opts);
      return parsed ? { ...parsed, source: "60s" } : null;
    });
  }

  async fetchGoldApiQuote(opts = {}) {
    return this.trackedCall({
      sourceId: "gold-api-xau",
      source: "gold-api",
      kind: "xau",
      instrument: "XAU",
      url: GOLD_API_URL,
    }, async () => {
      const text = await this.fetchUtf8(GOLD_API_URL, {
        headers: { "user-agent": USER_AGENT },
      }, opts.timeoutMs ?? QUOTE_TIMEOUT_MS, opts.signal ?? null);
      const parsed = parseGoldApiQuote(JSON.parse(text));
      return parsed ? { ...parsed, source: "gold-api" } : null;
    });
  }

  async fetchGoldPriceTodayQuote(opts = {}) {
    return this.trackedCall({
      sourceId: "goldprice-today-xau",
      source: "goldprice-today",
      kind: "xau",
      instrument: "XAU",
      url: GOLD_PRICE_TODAY_URL,
    }, async () => {
      const text = await this.fetchUtf8(GOLD_PRICE_TODAY_URL, {
        headers: { "user-agent": USER_AGENT },
      }, opts.timeoutMs ?? QUOTE_TIMEOUT_MS, opts.signal ?? null);
      const parsed = parseGoldPriceTodayQuote(JSON.parse(text));
      return parsed ? { ...parsed, source: "goldprice-today" } : null;
    });
  }

  async fetchYahooXauQuote(opts = {}) {
    return this.trackedCall({
      sourceId: "yahoo-xau",
      source: "yahoo",
      kind: "xau",
      instrument: "XAU",
      url: YAHOO_XAU_URL,
    }, async () => {
      const text = await this.fetchUtf8(YAHOO_XAU_URL, {
        headers: { "user-agent": USER_AGENT, "accept": "application/json" },
      }, opts.timeoutMs ?? QUOTE_TIMEOUT_MS, opts.signal ?? null);
      const parsed = parseYahooFinanceQuote(JSON.parse(text));
      return parsed ? { ...parsed, source: "yahoo" } : null;
    });
  }

  async fetchYahooXauDailyBars() {
    return this.trackedCall({
      sourceId: "yahoo-history-xau",
      source: "yahoo",
      kind: "history",
      instrument: null,
      url: YAHOO_XAU_HISTORY_URL,
    }, async () => {
      const text = await this.fetchUtf8(YAHOO_XAU_HISTORY_URL, {
        headers: { "user-agent": USER_AGENT, "accept": "application/json" },
      }, FETCH_TIMEOUT_MS);
      return parseYahooFinanceKlines(JSON.parse(text));
    });
  }

  async fetchJijinhaoQuote() {
    return this.trackedCall({
      sourceId: "jijinhao-brand",
      source: "jijinhao",
      kind: "brand",
      instrument: null,
      url: JIJINHAO_URL,
    }, async () => {
      const text = await this.fetchUtf8(JIJINHAO_URL, {
        headers: {
          "referer": "https://quote.cngold.org/",
          "user-agent": USER_AGENT,
        },
      }, QUOTE_TIMEOUT_MS);
      const parsed = parseJijinhaoQuote(text);
      return parsed ? { ...parsed, source: "jijinhao" } : null;
    });
  }

  async fetchJdGoldQuote() {
    return this.trackedCall({
      sourceId: "jdjy-gold",
      source: "jdjy",
      kind: "cmb",
      instrument: null,
      url: JD_GOLD_URL,
    }, async () => {
      const text = await this.fetchUtf8(JD_GOLD_URL, {
        headers: { "user-agent": USER_AGENT },
      }, QUOTE_TIMEOUT_MS);
      const parsed = parseJdGoldQuote(JSON.parse(text));
      return parsed ? { ...parsed, source: "jdjy" } : null;
    });
  }

  quoteChain(totalMs = this.quoteChainBudgetMs) {
    const controller = new AbortController();
    const deadline = Date.now() + totalMs;
    return {
      signal: controller.signal,
      remainingMs() {
        return deadline - Date.now();
      },
      /** Per-source timeout for an attempt with `sourcesLeft` sources remaining. */
      sourceTimeoutMs(sourcesLeft) {
        const remaining = this.remainingMs();
        if (remaining <= this.owner.quoteChainMinSourceTimeoutMs) return 0;
        const share = Math.ceil(remaining / Math.max(1, sourcesLeft));
        return Math.min(Math.max(share, this.owner.quoteChainMinSourceTimeoutMs), QUOTE_TIMEOUT_MS, remaining);
      },
      /** Abort everything still attached to this chain (idempotent). */
      settle() {
        controller.abort(new Error("quote chain settled"));
      },
      owner: this,
    };
  }

  async runChain(attempts, totalMs = this.quoteChainBudgetMs) {
    const chain = this.quoteChain(totalMs);
    try {
      for (let index = 0; index < attempts.length; index += 1) {
        const timeoutMs = chain.sourceTimeoutMs(attempts.length - index);
        if (timeoutMs <= 0) break; // chain budget exhausted
        try {
          const quote = await attempts[index](timeoutMs, chain);
          if (quote) return quote;
        } catch {
          // fall through to the next source
        }
      }
      return null;
    } finally {
      // First success or full exhaustion: nothing of this chain may outlive it.
      chain.settle();
    }
  }

  /** sina → SGE → eastmoney → 60s, sharing one 12s budget. */
  async fetchDomesticQuote(now = new Date()) {
    const attempts = [
      // 1: sina (stale check inside the tracked call)
      async (timeoutMs, chain) => this.trackedCall({
        sourceId: "sina-domestic",
        source: "sina",
        kind: "domestic",
        url: "https://hq.sinajs.cn/list=gds_AU9999",
      }, async () => {
        const text = await this.fetchGb18030("https://hq.sinajs.cn/list=gds_AU9999", {
          headers: { Referer: "https://finance.sina.com.cn/", "User-Agent": USER_AGENT },
        }, timeoutMs, chain.signal);
        const parsed = parseSinaDomesticQuote(text);
        if (parsed && !isDomesticQuoteFresh(parsed, now)) {
          const error = new Error(`stale domestic quote: ${parsed.date} ${parsed.time}`);
          error.code = "STALE_QUOTE";
          throw error;
        }
        return parsed ? { ...parsed, source: "sina" } : null;
      }),
      // 2: SGE (stale check after the tracked call)
      async (timeoutMs, chain) => {
        const quote = await this.fetchSgeQuote({ timeoutMs, signal: chain.signal });
        if (quote && !isDomesticQuoteFresh(quote, now)) {
          const error = new Error(`stale SGE domestic quote: ${quote.time ?? quote.date ?? ""}`);
          error.code = "STALE_QUOTE";
          throw error;
        }
        return quote;
      },
      // 3: eastmoney (stale check inside the tracked call)
      async (timeoutMs, chain) => this.trackedCall({
        sourceId: "eastmoney-domestic",
        source: "eastmoney",
        kind: "domestic",
        url: "https://push2.eastmoney.com/api/qt/stock/get?secid=118.AU9999",
      }, async () => {
        const text = await this.fetchUtf8(
          "https://push2.eastmoney.com/api/qt/stock/get?secid=118.AU9999&fields=f43,f44,f45,f46,f60,f86,f170",
          { headers: { Referer: "https://quote.eastmoney.com/", "User-Agent": USER_AGENT } },
          timeoutMs,
          chain.signal,
        );
        const parsed = parseEastmoneyDomesticQuote(JSON.parse(text));
        if (parsed && !isDomesticQuoteFresh(parsed, now)) {
          const error = new Error(`stale domestic quote: ${parsed.time}`);
          error.code = "STALE_QUOTE";
          throw error;
        }
        return parsed ? { ...parsed, source: "eastmoney" } : null;
      }),
      // 4: 60s aggregate
      async (timeoutMs, chain) => {
        const aggregate = await this.fetchSixtySecondsQuote("sixty-domestic", "domestic", "AU9999", { timeoutMs, signal: chain.signal });
        const domestic = aggregate?.domestic;
        if (domestic && Number.isFinite(domestic.price) && domestic.price > 0) {
          return {
            ...domestic,
            source: "60s",
            time: aggregate.updatedAt || undefined,
          };
        }
        return null;
      },
    ];
    return this.runChain(attempts);
  }

  /** tencent → sina XAU → gold-api → 60s → goldprice.today → yahoo GC=F. */
  async fetchXauQuote() {
    const attempts = [
      async (timeoutMs, chain) => this.trackedCall({
        sourceId: "tencent-xau",
        source: "tencent",
        kind: "xau",
        url: "https://qt.gtimg.cn/q=hf_XAU",
      }, async () => {
        const text = await this.fetchGb18030("https://qt.gtimg.cn/q=hf_XAU", {
          headers: { "User-Agent": USER_AGENT },
        }, timeoutMs, chain.signal);
        const parsed = parseTencentXauQuote(text);
        return parsed ? { ...parsed, source: "tencent" } : null;
      }),
      async (timeoutMs, chain) => this.trackedCall({
        sourceId: "sina-xau",
        source: "sina",
        kind: "xau",
        url: "https://hq.sinajs.cn/list=hf_XAU",
      }, async () => {
        const text = await this.fetchGb18030("https://hq.sinajs.cn/list=hf_XAU", {
          headers: { Referer: "https://finance.sina.com.cn/", "User-Agent": USER_AGENT },
        }, timeoutMs, chain.signal);
        const parsed = parseTencentXauQuote(text);
        return parsed ? { ...parsed, source: "sina" } : null;
      }),
      async (timeoutMs, chain) => this.fetchGoldApiQuote({ timeoutMs, signal: chain.signal }),
      async (timeoutMs, chain) => {
        const aggregate = await this.fetchSixtySecondsQuote("sixty-xau", "xau", "XAU", { timeoutMs, signal: chain.signal });
        const xau = aggregate?.xau;
        if (xau && Number.isFinite(xau.price) && xau.price > 0) {
          return {
            ...xau,
            source: "60s",
            time: aggregate.updatedAt || undefined,
          };
        }
        return null;
      },
      async (timeoutMs, chain) => this.fetchGoldPriceTodayQuote({ timeoutMs, signal: chain.signal }),
      async (timeoutMs, chain) => this.fetchYahooXauQuote({ timeoutMs, signal: chain.signal }),
    ];
    return this.runChain(attempts);
  }

  async fetchUsdcnyQuote() {
    const chain = this.quoteChain();
    try {
      const timeoutMs = chain.sourceTimeoutMs(1);
      if (timeoutMs <= 0) return null;
      return await this.trackedCall({
        sourceId: "tencent-usdcny",
        source: "tencent",
        kind: "usdcny",
        url: "https://qt.gtimg.cn/q=whUSDCNY",
      }, async () => {
        const text = await this.fetchGb18030("https://qt.gtimg.cn/q=whUSDCNY", {
          headers: { "User-Agent": USER_AGENT },
        }, timeoutMs, chain.signal);
        const parsed = parseTencentForexQuote(text);
        return parsed ? { ...parsed, source: "tencent" } : null;
      });
    } catch {
      return null;
    } finally {
      chain.settle();
    }
  }

  async fetchEastmoneyBars(secid, klt, limit = 120) {
    const sourceId = secid === "118.AU9999" ? "eastmoney-kline-au" : secid === "122.XAU" ? "eastmoney-kline-xau" : "eastmoney-kline-au";
    const url = EASTMONEY_KLINE_URL(secid, klt, limit);
    return this.trackedCall({
      sourceId,
      source: "eastmoney",
      kind: "history",
      url,
    }, async () => {
      const text = await this.fetchUtf8(url, {
        headers: { Referer: "https://quote.eastmoney.com/", "User-Agent": USER_AGENT },
      });
      return parseEastmoneyKlines(JSON.parse(text));
    });
  }
}

// In-memory ring cap when no ApiLogStore is bound (tests, ad-hoc use).
const MAX_MEMORY_API_LOGS = 500;

// ── backwards-compatibility default instance ────────────────────────────────
//
// Production always constructs an explicit SourceRegistry in the composition
// root (one per plugin apply()). The lazily-created shared instance below
// exists ONLY so the historical free-function entry points — `__setFetchImpl`,
// `markSourceSuccess`, `fetchDomesticQuote`, … — keep working for the existing
// unit suites and any external callers. It carries no plugin state.

let defaultRegistry = null;

/** Lazy shared registry backing the legacy free-function wrappers. */
export function getDefaultSourceRegistry() {
  if (!defaultRegistry) defaultRegistry = new SourceRegistry();
  return defaultRegistry;
}

/** Test-only hook: replace the outbound fetch for ALL registries. Returns the previous one. */
export function __setFetchImpl(impl) {
  const previous = moduleFetch;
  moduleFetch = typeof impl === "function" ? impl : FETCH_DEFAULT;
  return previous;
}

/** Test-only hook: override chain budget / per-source timeout floor globally. */
export function __setQuoteChainTiming(opts = {}) {
  const previous = { budgetMs: moduleChainBudgetMs, minSourceTimeoutMs: moduleChainMinSourceTimeoutMs };
  if (Number.isFinite(opts.budgetMs)) moduleChainBudgetMs = Math.max(1, opts.budgetMs);
  if (Number.isFinite(opts.minSourceTimeoutMs)) moduleChainMinSourceTimeoutMs = Math.max(1, opts.minSourceTimeoutMs);
  return previous;
}

export function isCircuitOpen(sourceId) {
  return getDefaultSourceRegistry().isCircuitOpen(sourceId);
}

export function markSourceSuccess(sourceId) {
  getDefaultSourceRegistry().markSourceSuccess(sourceId);
}

export function markSourceFailure(sourceId) {
  getDefaultSourceRegistry().markSourceFailure(sourceId);
}

export async function trackedCall(entry, fn) {
  return getDefaultSourceRegistry().trackedCall(entry, fn);
}

// Simple method-forwarding wrappers (one line each) keep the historical
// free-function surface alive on the shared default registry.
export const fetchCmbQuote = () => getDefaultSourceRegistry().fetchCmbQuote();
export const fetchSgeQuote = (opts = {}) => getDefaultSourceRegistry().fetchSgeQuote(opts);
export const fetchSgeDailyBars = () => getDefaultSourceRegistry().fetchSgeDailyBars();
export const fetchSixtySecondsQuote = (sourceId, kind, instrument, opts = {}) => getDefaultSourceRegistry().fetchSixtySecondsQuote(sourceId, kind, instrument, opts);
export const fetchGoldApiQuote = (opts = {}) => getDefaultSourceRegistry().fetchGoldApiQuote(opts);
export const fetchGoldPriceTodayQuote = (opts = {}) => getDefaultSourceRegistry().fetchGoldPriceTodayQuote(opts);
export const fetchYahooXauQuote = (opts = {}) => getDefaultSourceRegistry().fetchYahooXauQuote(opts);
export const fetchYahooXauDailyBars = () => getDefaultSourceRegistry().fetchYahooXauDailyBars();
export const fetchJijinhaoQuote = () => getDefaultSourceRegistry().fetchJijinhaoQuote();
export const fetchJdGoldQuote = () => getDefaultSourceRegistry().fetchJdGoldQuote();
export const fetchDomesticQuote = (now = new Date()) => getDefaultSourceRegistry().fetchDomesticQuote(now);
export const fetchEastmoneyBars = (secid, klt, limit = 120) => getDefaultSourceRegistry().fetchEastmoneyBars(secid, klt, limit);

/**
 * Rotate the JSONL log when it exceeds `maxBytes`: the current file becomes
 * `<name>.1` (previous `.1` is overwritten, single generation kept).
 * Exported for tests.
 */
export async function rotateApiLogIfNeeded(path, maxBytes = 2 * 1024 * 1024) {
  let size = 0;
  try {
    const info = await stat(path);
    size = info.size;
  } catch (error) {
    if (error?.code === "ENOENT") return false;
    throw error;
  }
  if (size <= maxBytes) return false;
  await rename(path, `${path}.1`);
  return true;
}

/**
 * Read at most the last `tailBytes` of a JSONL log and parse the last 500
 * entries (newest first). Files smaller than the tail window are read whole
 * (previous behaviour). A torn first line — inevitable when the window starts
 * mid-JSON — is dropped instead of failing the read. Exported for tests.
 */
export async function readApiLogsFromFile(path, tailBytes = 256 * 1024) {
  let handle;
  try {
    handle = await open(path, "r");
  } catch (error) {
    if (error?.code === "ENOENT") return [];
    throw error;
  }
  try {
    const info = await handle.stat();
    const start = Math.max(0, info.size - tailBytes);
    const length = info.size - start;
    const buffer = Buffer.alloc(length);
    await handle.read(buffer, 0, length, start);
    const lines = buffer.toString("utf8").split("\n");
    // Drop the torn head line unless the window covers the file from byte 0.
    if (start > 0) lines.shift();
    const out = [];
    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      try {
        out.push(JSON.parse(trimmed));
      } catch {
        // Skip malformed lines.
      }
    }
    return out.slice(-MAX_MEMORY_API_LOGS).reverse();
  } finally {
    await handle.close();
  }
}
