# dsh-plugin-goldboard

A real-time gold dashboard plugin for DeepSeek Harness: a draggable top-right floating board (collapsible to a small orb) showing SGE Au99.99, London spot gold XAU and USDCNY, with China Merchants Bank 积存金 prices fetched from the CMB market-center API when available (falling back to the international gold price converted at the exchange rate plus a configurable spread). It uses your position/limits and fee model (default buy 0 + sell 5 CNY/g) to produce intraday buy/sell references and a copyable suggested order, and alerts on every threshold crossing via host system notifications and webhooks.

[中文](README.md)

[![dsh-plugin topic](https://img.shields.io/badge/topic-dsh--plugin-blue)](https://github.com/topics/dsh-plugin)
[![license](https://img.shields.io/badge/license-MIT-green)](LICENSE)

> This plugin provides technical references only. It never places orders and is not investment advice.

## Install

Install into the web profile from GitHub (requires `pnpm` on `PATH`; otherwise use the corepack fallback below):

```sh
npx @deepseek-ai/dsh plugin --profile web add "github:c-ling/dsh-plugin-goldboard#v1.2.0"
```

Or with an existing `dsh` binary:

```sh
dsh plugin --profile web add "github:c-ling/dsh-plugin-goldboard#v1.2.0"
```

When `pnpm` is not on `PATH`:

```sh
cd ~/.dsh/profiles/web
corepack pnpm add "github:c-ling/dsh-plugin-goldboard#v1.2.0"
```

> `dsh plugin` forwards its arguments to pnpm and fetches the package from this repo (pnpm 9+, `git` required). The warning `declares no dsh.bundle — installed as a plain dependency` is expected: this plugin is not a profile bundle layer; it is activated by the loader row below.

Then add a loader row to `~/.dsh/profiles/web/cordis.patch.yml`:

```yaml
- insert:
    - id: dsh-plugin-goldboard
      name: 'dsh-plugin-goldboard'
```

Restart `dsh web` (client-modules caches package verdicts per process; new packages require a host restart), then hard-refresh the page. The gold board appears in the top-right corner and a "Gold Board" section is added to Settings.

## Verify

```sh
curl -s http://127.0.0.1:3080/plugins/dsh-plugin-goldboard/client.js | head -c 60
```

It should print a factory bundle starting with `window.__ModuleLoader__.load({`.

```sh
curl -s http://127.0.0.1:3080/dsh-plugin-goldboard/snapshot
```

It should return `{ ok: true, quotes: { AU9999, XAU, USDCNY, CMB }, quality: …, plan: … }`; when present, `quotes.GCF` is a separately identified COMEX futures diagnostic quote.

```sh
curl -s http://127.0.0.1:3080/dsh-plugin-goldboard/models
curl -s 'http://127.0.0.1:3080/dsh-plugin-goldboard/analysis-logs?limit=30'
```

The model catalog comes from currently registered Harness providers. Log queries return redacted structured summaries; no model call is made without a selected model. When the market-quality gate fails, manual analysis can still be invoked; the model must report insufficient/stale/invalid status and cannot issue trading instructions.

## Update

```sh
dsh plugin --profile web add "github:c-ling/dsh-plugin-goldboard#v1.2.0"
# or: npx @deepseek-ai/dsh plugin --profile web add "github:c-ling/dsh-plugin-goldboard#v1.2.0"
# or: cd ~/.dsh/profiles/web && corepack pnpm add "github:c-ling/dsh-plugin-goldboard#v1.2.0"
```

Re-running the install command with the new `#v1.2.0` pin upgrades the dependency; the loader row in `cordis.patch.yml` stays unchanged. Restart `dsh web`, then hard-refresh.

## Uninstall

```sh
cd ~/.dsh/profiles/web
corepack pnpm remove dsh-plugin-goldboard
# or: dsh plugin --profile web remove dsh-plugin-goldboard
```

Also remove the matching `insert` row from `cordis.patch.yml`, then restart `dsh web`.
This plugin keeps state under `$DSH_HOME/storages/dsh-plugin-goldboard/`, which is left for manual cleanup after uninstall.

## Features

- Top-right floating board (drag from its header or footer; the position is anchored to the viewport edge and re-clamped on resize), collapsible to a small orb; 10s refresh (60s while hidden) and Beijing-time display.
- Au99.99 (CNY/g), XAU (USD/oz), USDCNY, XAU converted to CNY/g and the domestic-vs-international spread.
- CMB 积存金 price: fetched from the CMB market-center API (`zBuyPrc` / `zSelPrc`) when available, falling back to the international gold price converted at the exchange rate plus a configurable spread (default +1.72 CNY/g, buy/sell separately). Click the CMB card to view a self-built CMB line chart. The CMB “prev close / change” first uses the CMB’s own price at 00:00 Beijing time; if no 00:00 data is available, it falls back to the international gold prev close converted to CNY plus the current CMB spread. In Settings → Gold Board today’s missing CMB 1-minute times are listed so you can quickly enter prices; existing bars are never overwritten.
- The suggestion area prefers live CMB data; when live CMB is unavailable it prefers the international gold price converted at the exchange rate, falling back to Au99.99 (domestic price + spread estimate) only when the conversion is unavailable — suggestions do not silently become invalid.
- Intraday signals: buy signals reference **5/10/30/60-minute data** — a multi-timeframe trend filter requiring EMA20 rising on 10/30/60m bars (10m/30m resampled from the 5m bars), with 5m RSI/support providing entry timing; **a suggestion is only produced when the 5/10-minute windows have >80% and the 30/60-minute windows have >60% valid per-minute data**, otherwise the board says "Data incomplete — no suggestion for now" and shows per-window coverage. **During the first hour after the session opens only the 5/10-minute windows are validated** (the 30/60-minute windows are naturally thin right after the open); **the same relaxed 5/10-minute check applies during the daily 00:00-01:00 Beijing window**. Take-profit, trailing stop, stop-loss, close-before-session-end and weakness alerts for holdings. The strategy sizes add/reduce orders against target position bands (light/standard/heavy), with same-direction cooldown, consecutive confirmation, and a signal-strength readout. The floating “Current suggestion” panel also shows the 5/10/30/60-minute EMA20/RSI/SMA/Bollinger/ATR/MACD values and the reasons behind the signal; hovering the ? next to each indicator name explains its meaning and formula.
- Multi-lot positions: record each buy with grams/price, total grams and average cost are derived automatically; add-position suggestions appear on pullback stabilization, and reduce-position suggestions appear on overbought weakness / pullback from highs. Add/reduce suggestions are sized against target position bands and keep a minimum base position, avoiding repeated small-position liquidation.
- Breakeven and suggested orders: default buy 0 + sell 5 CNY/g; even when live CMB prices are available, the breakeven still includes buy/sell fees. View the suggestion and place it manually in the CMB app.
- Pending-order tracking: the plugin remembers the most recently alerted suggested order. If a later signal change invalidates the previous suggestion (wait / market closed / incomplete data / stop, etc.) or changes its direction, price or grams, it sends an extra “cancel previous order / order updated” alert so you do not keep acting on a stale order.
- Alerts: host system notifications (macOS/Linux/Windows) + Feishu/DingTalk/WeCom/generic webhooks; no cooldown, no quiet hours — every threshold crossing during trading hours alerts immediately.
- Trading hours: weekdays 09:00–next-day 02:00, editable holidays.
- Bilingual UI that follows Settings → General → Language; dark/light theming via DSW tokens.
- Auditable market semantics: quotes expose `instrument`, `market`, `currency`, `unit` and source-quality metadata; XAU/USD spot and Yahoo `GC=F` futures stay in separate lanes. Polling and FX-derived bars are explicitly marked `synthetic`; formal indicators use closed bars only and expose `calculationVersion`, `warmupReady` and fixed Wilder smoothing methods. Fixed-fixture replay is available at `POST /dsh-plugin-goldboard/replay`.
- Manual model analysis: choose a provider, model and reasoning effort from the current Harness catalog without changing the active conversation model. The model explains host-computed indicators and the rule plan only; it cannot invent prices or issue trading instructions. When data-quality gates fail, manual analysis can still be invoked and the model must report the data limitations. Settings → Gold Board adds model selection, Analyze now and a separate Query logs panel.
- Query audit logs: every real model call gets a `queryId` and started/finished lifecycle record with model, market snapshot, quality state, input hash, structured result, usage and errors. Logs are stored at `$DSH_HOME/storages/dsh-plugin-goldboard/analysis-log.jsonl`, with redacted details, filters, cursor pagination and orphaned-running recovery.

## Data sources

Free public, unofficial endpoints; they may rate-limit or change:

- Au99.99: Sina `gds_AU9999` (primary) → SGE `graph/quotations` → Eastmoney `118.AU9999` → 60s API (fallbacks)
- XAU spot: Tencent/Sina `hf_XAU` → gold-api.com → 60s API → GoldPrice.Today; Yahoo `GC=F` is a separately marked futures diagnostic source and never substitutes for spot
- USDCNY: Tencent `whUSDCNY`
- CMB 积存金: `https://mbmodule-openapi.paas.cmbchina.com/product/v1/func/market-center` (POST `params=[{"prdType":"H","prdCode":""}]`)
- Brand / accumulated gold (status page): Jinjinhao `api.jijinhao.com`, JD Finance `api.jdjygold.com`
- Au99.99 klines: Eastmoney `push2his.eastmoney.com`, with SGE `graph/Dailyhq` history as a fallback
- XAU/USD spot klines: Eastmoney `push2his.eastmoney.com`; if unavailable, the plugin marks data as insufficient instead of renaming Yahoo futures as spot
- GC=F futures diagnostic daily bars: Yahoo Finance `query1.finance.yahoo.com/v8/finance/chart/GC=F?interval=1d`
- XAU / CMB minute bars: built by the host from polling quotes

The plugin uses low-frequency polling, multi-source fallback and local caching; stale data is flagged on the board. Personal reference only; do not redistribute.

## Disclaimer

All output is a technical reference and does not constitute investment advice. Gold prices can move against you. Make your own decisions and always verify the actual price in the CMB app.

## License

[MIT](LICENSE)
