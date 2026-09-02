# dsh-plugin-goldboard

[中文](README.md)

A real-time gold dashboard plugin for DeepSeek Harness: a draggable top-right floating board (collapsible to a small orb) showing SGE Au99.99, London spot gold XAU and USDCNY, with China Merchants Bank 积存金 prices fetched from the CMB market-center API when available (falling back to the international gold price converted at the exchange rate plus a configurable spread). It uses your position/limits and fee model (default buy 0 + sell 5 CNY/g) to produce intraday buy/sell references and a copyable suggested order, and alerts on every threshold crossing via host system notifications and webhooks.

[![dsh-plugin topic](https://img.shields.io/badge/topic-dsh--plugin-blue)](https://github.com/topics/dsh-plugin)
[![license](https://img.shields.io/badge/license-MIT-green)](LICENSE)

> This plugin provides technical references only. It never places orders and is not investment advice.
>
> See the [v1.11.0 strategy optimization notes](docs/v1.11.0-strategy-optimization.md) for the execution/valuation/replay-v5 scope and deferred work.
> v1.12.0 keeps confirmed signals blocked by position limits visible in replay details and preserves them across restarts.
> v1.13.0 completes Stage 0 evidence and semantics freezing. Replay reports are explicitly labeled as exploratory diagnostics: 5-minute simulation, real/proxy/unknown bid-ask coverage, complete/partial sessions, cost assumptions, and the control strategy version are included in every new report. No report is a validated strategy result or actual performance record.

## Install

Install into the web profile from GitHub (requires `pnpm` on `PATH`; otherwise use the corepack fallback below):

```sh
npx @deepseek-ai/dsh plugin --profile web add "github:c-ling/dsh-plugin-goldboard#v1.13.0"
```

Or with an existing `dsh` binary:

```sh
dsh plugin --profile web add "github:c-ling/dsh-plugin-goldboard#v1.13.0"
```

When `pnpm` is not on `PATH`:

```sh
cd ~/.dsh/profiles/web
corepack pnpm add "github:c-ling/dsh-plugin-goldboard#v1.13.0"
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

It should return `{ ok: true, quotes: { AU9999, XAU, USDCNY, CMB }, quality: …, plan: … }`; when present, `quotes.GCF` is a separately identified COMEX futures diagnostic quote. New `/replay-stats` reports also include `strategyVersion`, `calculationVersion`, `dataSchemaVersion`, `executionVersion`, `calendarVersion`, `evidenceStatus: "exploratory"`, `costAssumptions`, and real/proxy/unknown `executionCoverage`.

```sh
curl -s http://127.0.0.1:3080/dsh-plugin-goldboard/models
curl -s 'http://127.0.0.1:3080/dsh-plugin-goldboard/analysis-logs?limit=30'
```

The model catalog comes from currently registered Harness providers. Log queries return redacted structured summaries; no model call is made without a selected model. When the market-quality gate fails, manual analysis can still be invoked; the model must report insufficient/stale/invalid status and cannot issue trading instructions.

## Update

```sh
dsh plugin --profile web add "github:c-ling/dsh-plugin-goldboard#v1.13.0"
# or: npx @deepseek-ai/dsh plugin --profile web add "github:c-ling/dsh-plugin-goldboard#v1.13.0"
# or: cd ~/.dsh/profiles/web && corepack pnpm add "github:c-ling/dsh-plugin-goldboard#v1.13.0"
```

Re-running the install command with the new `#v1.13.0` pin upgrades the dependency; the loader row in `cordis.patch.yml` stays unchanged. Restart `dsh web`, then hard-refresh.

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
- CMB 积存金 price: fetched from the CMB market-center API (`zBuyPrc` / `zSelPrc`; customer buy = ask, customer sell = bid) when available, falling back to the international gold price converted at the exchange rate plus separate buy/sell offsets. Live sampling now records `customerBuy-reference` and `customerSell-reference` independently and calibrates their medians; v1.10 mid-only samples remain readable but are marked legacy. Newly collected CMB bars persist real ask/bid OHLC, while old one-sided history is never relabeled as real bid/ask. The chart, previous-close fallback, and manual minute backfill remain available.
- The suggestion area prefers live CMB data with lane stickiness: a data source must stay unavailable for ~90 seconds before the signal degrades to the next priority lane (international spot converted → Au99.99), and ~90 seconds of recovery before switching back, so a flaky endpoint cannot flip the indicator history back and forth; while waiting the board shows “signal source degraded”, and one alert fires when the downgrade is confirmed.
- Intraday signals: buy signals reference **5/10/30/60-minute data** — a multi-timeframe trend filter requiring EMA20 rising on 10/30/60m bars (10m/30m resampled from the 5m bars), with 5m RSI/support providing entry timing; **a suggestion is only produced when the 5/10-minute windows have >80% and the 30/60-minute windows have >60% valid per-minute data**, otherwise the board says "Data incomplete — no suggestion for now" and shows per-window coverage. **During the first hour after the session opens only the 5/10-minute windows are validated** (the 30/60-minute windows are naturally thin right after the open); **the same relaxed 5/10-minute check applies during the daily 00:00-01:00 Beijing window**. Take-profit, trailing stop, stop-loss and weakness alerts for holdings; **the forced close-before-session-end nudge is off by default (v1.9.0 — no fixed intraday-close bias)**: holdings keep following the regular signals near the close, and the "Force close before session end" switch restores the old behavior for traders who want it. The strategy sizes add/reduce orders against target position bands (light/standard/heavy), with same-direction cooldown, consecutive confirmation, and a signal-strength readout; position changes reset confirmation streaks but no longer erase the same-side cooldown clock. The floating “Current suggestion” panel also shows the 5/10/30/60-minute EMA20/RSI/SMA/Bollinger/ATR/MACD values and the reasons behind the signal; hovering the ? next to each indicator name explains its meaning and formula.
- Multi-lot positions: record each buy with grams/price, total grams and average cost are derived automatically; add-position suggestions appear on pullback stabilization, and reduce-position suggestions appear on overbought weakness / pullback from highs. Add/reduce suggestions are sized against target position bands and keep a minimum base position, avoiding repeated small-position liquidation.
- Unified execution ledger: `ask + explicit buy fee + buy slippage` is the entry cost, while `bid - explicit sell fee - sell slippage` is the exit proceeds. Real CMB bid/ask never receives an extra estimated spread; estimated spread applies only to a synthetic fallback. Breakeven, targets, stops, valuation, replay, and final marking share this module. The default remains buy 0 + sell 5 CNY/g; this field now explicitly means a charge outside the quoted bid/ask and should be checked against the product agreement.
- Pending-order tracking (v1.9.0 lifecycle semantics): the plugin remembers the most recently alerted suggested order and keeps it in a "standing" state — a post-suggestion cooldown flip to wait, an in-progress confirmation or a brief data gap only means keep waiting for the fill; **it no longer repeatedly prompts you to cancel**. Tracking is updated or withdrawn only on material changes: an opposite-direction signal, the price drifting beyond the threshold from the limit ("Order drift cancel threshold", default 0.5%, configurable), order expiry or market close clearing, and detected fills (position moved in the order's direction — cleared silently). A real change in price/grams (≥0.5 CNY/g) sends an "order updated" alert; near-identical re-quotes only refresh validity silently. Same-shape repricing of one standing order is rate-limited by a 10-minute quiet window (only a cumulative drift ≥3 CNY/g from the last notified price escalates immediately), so live-quote jitter can no longer flood the channels.
- Alerts: host system notifications (macOS/Linux/Windows) + Feishu/DingTalk/WeCom/generic webhooks; no cooldown or quiet hours. Generic Host-side requests require credential-free HTTPS public targets and reject loopback, private, link-local, metadata addresses, unsafe headers, and redirects. `sell_weakness` and `spread_alert` remain informational/protective signals, and the alert log records per-channel delivery results.
- Trading hours: weekdays 09:00–next-day 02:00, editable holidays.
- Settings storage (v1.6.0): configuration moves to the Harness-wide settings document (the `dsh-plugin-goldboard` namespace in `$DSH_HOME/settings.yaml`); saved changes apply immediately and survive refreshes and restarts. A legacy `config.json` is migrated automatically on the first start after upgrading and kept as `config.json.migrated`; hosts without a settings provider fall back to the classic storage with no feature loss. Webhook signing secrets are write-only and never echoed — the page only shows a "Configured" badge.
- Bilingual UI that follows Settings → General → Language; dark/light theming via DSW tokens.
- Auditable market semantics: quotes expose `sourceTimestamp/receivedAt` plus instrument, market, currency, unit, and quality metadata. Compact Beijing timestamps, epoch seconds/milliseconds, and ISO timestamps normalize consistently; future timestamps block strategy output. 10m/30m bars use natural clock buckets, and partial buckets with missing children cannot enter formal indicators. XAU spot and `GC=F` futures remain separate. The score-threshold schema/UI maximum now matches the real maximum of 8.
- Manual model analysis: choose a provider, model and reasoning effort from the current Harness catalog without changing the active conversation model. The model explains host-computed indicators and the rule plan only; it cannot invent prices or issue trading instructions. When data-quality gates fail, manual analysis can still be invoked and the model must report the data limitations. Settings → Gold Board adds model selection, Analyze now and a separate Query logs panel.
- Query audit logs: every real model call gets a `queryId` and started/finished lifecycle record with model, market snapshot, quality state, input hash, structured result, usage and errors. Logs are stored at `$DSH_HOME/storages/dsh-plugin-goldboard/analysis-log.jsonl`, with redacted details, filters, cursor pagination and orphaned-running recovery.
- Replay diagnostics (v1.13.0, building on v1.11.0 / report v5): complete sessions are selected by default. A signal close creates a pending limit order; ask/bid touch is evaluated no earlier than the next complete 5-minute bar, and an untouched order expires at `validUntil`. A bar touching both target and stop is marked `ambiguousBar`; the default long-side result assumes the stop first and reports best/worst bounds. Reports add order counts, fill/expiry rates, average delay, ambiguity count, real/proxy/unknown bid/ask coverage, cost assumptions and cost breakdown, equity curve, and maximum drawdown, while freezing the `control` strategy, indicator, data-contract, execution-ledger, configured-session, and report versions. Each new report carries `evidenceStatus: "exploratory"` plus the admission requirements for long-term history, OOS, real bid/ask evidence, verified cost semantics, benchmarks, and uncertainty intervals; it is not called a validation result until those requirements are met. Orders, fills, and trade-compatible details persist together. When a confirmed strategy signal cannot create an order because the continuous account has reached its maximum grams, it is persisted separately as an unexecuted signal with its time, price, position/limit, and reason; it does not count toward fill rate, cash flow, or P&L. Independent signal tables also run the same next-bar fill/expiry check: unfilled suggestions count only as decisions/expiries and cannot enter target, breakeven, or session-net outcomes. v4 and pre-baseline v5 reports remain read-only with their existing version/window/parameters/caveats; they are not backfilled, recomputed, or compared with the new semantics. These are still exploratory 5-minute simulation diagnostics, not actual fills or out-of-sample performance evidence.

## Data sources

Free public, unofficial endpoints; they may rate-limit or change:

- Au99.99: Sina `gds_AU9999` (primary) → SGE `graph/quotations` → Eastmoney `118.AU9999` → 60s API (fallbacks)
- XAU spot: Tencent/Sina `hf_XAU` → gold-api.com → 60s API → GoldPrice.Today; Yahoo `GC=F` is a separately marked futures diagnostic source and never substitutes for spot
- USDCNY: Tencent `whUSDCNY`
- CMB 积存金: `https://mbmodule-openapi.paas.cmbchina.com/product/v1/func/market-center` (POST `params=[{"prdType":"H","prdCode":""}]`)
- Brand / accumulated gold (status page): Jinjinhao `api.jijinhao.com`, JD Finance `api.jdjygold.com`
- Au99.99 klines: Eastmoney `push2his.eastmoney.com` (falls back to the `push2delay.eastmoney.com` mirror when rate-limited; closed-history data only), with SGE `graph/Dailyhq` history as a fallback
- XAU/USD spot klines: Eastmoney `push2his.eastmoney.com`; if unavailable, the plugin marks data as insufficient instead of renaming Yahoo futures as spot
- GC=F futures diagnostic daily bars: Yahoo Finance `query1.finance.yahoo.com/v8/finance/chart/GC=F?interval=1d`
- XAU / CMB minute bars: built by the host from polling quotes

The plugin uses low-frequency polling, multi-source fallback and local caching; stale data is flagged on the board. Personal reference only; do not redistribute.

## Disclaimer

All output is a technical reference and does not constitute investment advice. Gold prices can move against you. Make your own decisions and always verify the actual price in the CMB app.

## License

[MIT](LICENSE)
