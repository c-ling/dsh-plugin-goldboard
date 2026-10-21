# dsh-plugin-goldboard

[中文](README.md)

A real-time gold dashboard and strategy-diagnostics plugin for DeepSeek Harness (Web and Desktop): a sidebar Gold Board entry opens a standalone main-panel page with Overview / Trading / Strategy & replay / Analysis / Data / Settings tabs for Au99.99/XAU/CMB quotes, independent calendars, durable CMB bid/ask history, risk-constrained position suggestions, and reproducible replay with dataset/OOS admission gates. It fetches CMB accumulated-gold prices when available and falls back to XAU converted through USDCNY plus calibrated spreads; host notifications and webhooks report threshold crossings without placing orders.

[![dsh-plugin topic](https://img.shields.io/badge/topic-dsh--plugin-blue)](https://github.com/topics/dsh-plugin)
[![license](https://img.shields.io/badge/license-MIT-green)](LICENSE)

> This plugin provides technical references only. It never places orders and is not investment advice.
>
> See the [v1.11.0 strategy optimization notes](docs/v1.11.0-strategy-optimization.md) for the execution/valuation/replay-v5 scope and deferred work.
> v1.12.0 keeps confirmed signals blocked by position limits visible in replay details and preserves them across restarts.
> v1.13.0 completes Stage 0 evidence and semantics freezing. Replay reports are explicitly labeled as exploratory diagnostics: 5-minute simulation, real/proxy/unknown bid-ask coverage, complete/partial sessions, cost assumptions, and the control strategy version are included in every new report. No report is a validated strategy result or actual performance record.
> v1.14.0 completes the [Stage 1 data and execution fact layer](docs/stage-1-implementation-plan.md): market data v2, independent instrument calendars, durable CMB bid/ask point-in-time history, state-v2 migration/rollback, complete coverage facts, unified execution evidence, and a reduced public API. Default RSI, ATR, position, and alert strategy settings remain unchanged.
> v1.15.0 releases Stage 2/3/4, the 0.2.1 sidebar-page refactor, and trading features including target-retrace exits, a daily EMA20 trend gate, a pre-arm time stop, sell-price-derived fees, and position reset / signal-ledger dialogs. Defaults remain fixed-grams and control.
> v1.15.0 includes [Stage 2 risk gates and order lifecycle](docs/stage-2-implementation-plan.md): the default remains `fixed_grams`; opt-in `budget` sizing, daily/weekly/drawdown and add gates, stable setup/decision/order IDs, state v3, and a read-only signal ledger are implemented. Reference equity and ledger P&L are local risk estimates, not a real account balance or statement.
> v1.15.0 includes the [Stage 3 ReplaySimulator and long-term validation framework](docs/stage-3-implementation-plan.md): report v6 pins as-of and dataset/input/report fingerprints, builds monthly 6+1 walk-forward folds, and reports risk-adjusted metrics, Wilson/block-bootstrap intervals, and four same-basis benchmarks. The Host forces `exploratory` until at least 12 months of history, adequate real bid/ask coverage, verified cost semantics, and every OOS gate are actually present.
> v1.15.0 includes the [Stage 4 strategy experiment layer](docs/stage-4-implementation-plan.md): a formal strategy contract/registry, a control adapter, an ORB trend-pullback state machine, trend/range/high-volatility labels, a point-in-time factor contract, isolated strategy/lane/ablation/parameter/cost matrices, and fail-closed promotion reports. Experiments are off by default and live remains fixed to `control`; XAU scenarios are unavailable without joint point-in-time XAU+USDCNY evidence, while statistical/ML/DRL capabilities remain explicitly unrun rather than fabricated results.
> v1.15.0 also completes the **0.2.1 sidebar-page refactor**: the top-right floating board and Settings section are gone, replaced by a `sidebar.panellist` entry plus a `main` page. Host routes move to `/api/dsh-plugin-goldboard/...` and configuration returns to the plugin-private `config.json`. Install pins now point at `#v1.15.0`; `v1.14.0` is the old floating-window version for rollback only.

## Install

Target runtime: **DeepSeek Harness 0.2.1+** (Web and Desktop). The package declares `dsh.bundle`, so bundle mode is recommended.

> **Version note:** from v1.15.0 the GitHub install ships the sidebar-page bundle (no manual loader row); `v1.14.0` remains the old floating-window version for rollback only.

### Web (bundle)

```sh
dsh plugin --profile web add "github:c-ling/dsh-plugin-goldboard#v1.15.0"
# or
npx @deepseek-ai/dsh plugin --profile web add "github:c-ling/dsh-plugin-goldboard#v1.15.0"
```

`dsh plugin` adds the package to the profile's `dsh.profile.bundles`; `cordis.patch.yml` contributes the loader row. Do not also hand-write the same row.

### Desktop (bundle)

Use the Desktop-bundled CLI (`--profile desktop` is managed by the Desktop app; `npx @deepseek-ai/dsh` refuses it):

```sh
"/Applications/DeepSeek Harness.app/Contents/Resources/runtime/cli/bin/dsh" \
  plugin --profile desktop add "github:c-ling/dsh-plugin-goldboard#v1.15.0"
```

You can also quit the app and install a local path or GitHub tag from the Plugins page.

### Manual mode (plain dependency)

```sh
cd ~/.dsh/profiles/web
corepack pnpm add "github:c-ling/dsh-plugin-goldboard#v1.15.0"
```

Then add to `~/.dsh/profiles/web/cordis.patch.yml`:

```yaml
- insert:
    - id: dsh-plugin-goldboard
      name: 'dsh-plugin-goldboard'
```

Do not also add the package to `dsh.profile.bundles`; that double-activates it.
For local development, install an absolute path instead (Web):

```sh
dsh plugin --profile web add "link:/absolute/path/to/dsh-plugin-goldboard"
```

Use the same `link:` form with the Desktop-bundled CLI, or pick the local directory from the Plugins page.

### Restart and entry point

Restart the host after installing or updating (Web: restart `dsh web`; Desktop: quit and reopen the app), then hard-refresh. `client-modules` caches package verdicts per process, so a new bundle requires a restart.

The sidebar shows a **Gold Board** entry. Clicking it opens a standalone page with:

- **Overview** — quote cards, today's trend, current suggestion, position/risk summary, data quality;
- **Trading** — position/limits, risk budget, fees/CMB spreads, manual previous close (today only; clears at Beijing midnight), strategy parameters, trading hours; its own top-right save;
- **Strategy & replay** — replay statistics, strategy experiments, signal ledger;
- **Analysis** — model configuration, Analyze now, query logs;
- **Data** — source health, historical coverage, manual CMB minute backfill;
- **Settings** — system notifications and webhook channels, with its own save.

Each configurable tab has its own save action and submits only that tab's sections; unsaved edits survive tab switches. Only the tab content scrolls; the page header and tab strip stay fixed. The old top-right floating board and the Settings → Gold Board section are removed.

## Verify

```sh
curl -s -o /dev/null -w '%{http_code}\n' http://127.0.0.1:<port>/api/dsh-plugin-goldboard/snapshot
# 401 = the request reached the /api auth bridge; this does not prove the route exists
curl -s -o /dev/null -w '%{http_code}\n' http://127.0.0.1:<port>/dsh-plugin-goldboard/snapshot
# 404 = the old anonymous webServer route is gone
```

In the authenticated GUI open the sidebar **Gold Board** entry and confirm:

- quotes and suggestions load and all tabs switch;
- saved settings survive a restart;
- the console has no `slot entry crashed`;
- Web and Desktop both show the entry and page.

Main endpoints (authenticated, `/api` prefix):

```sh
curl -s 'http://127.0.0.1:<port>/api/dsh-plugin-goldboard/snapshot'
curl -s 'http://127.0.0.1:<port>/api/dsh-plugin-goldboard/ledger?limit=20'
curl -s 'http://127.0.0.1:<port>/api/dsh-plugin-goldboard/strategies'
curl -s 'http://127.0.0.1:<port>/api/dsh-plugin-goldboard/replay-reports'
```

`/snapshot` returns `{ ok: true, quotes: { AU9999, XAU, USDCNY, CMB }, quality, risk, ledger, plan }`. `/replay-stats` report v6 returns `asOf`, `dataset`, `inputFingerprint`, `reportFingerprint`, `metrics`, `oos`, `benchmarks`, real/proxy/unknown `groups`, and the Host-derived `validationGate`. `GET /replay-stats?reportId=…&detail=true` retrieves immutable report details across restarts.

`GET/POST /api/dsh-plugin-goldboard/strategy-experiments` reads or explicitly runs the isolated matrix; POST is accepted only after the experiment configuration has been saved from Strategy & replay. Every report keeps `promotion.liveStrategyChanged:false`.

`GET /api/dsh-plugin-goldboard/analysis` returns the latest analysis status, and `GET /api/dsh-plugin-goldboard/analysis-logs?limit=30` returns redacted logs. The model catalog comes from the currently registered Harness providers; no model call is made without a selected model.

## Update

Bundle mode: re-run the install command with the new pin.

```sh
dsh plugin --profile web add "github:c-ling/dsh-plugin-goldboard#v1.15.0"
# Desktop:
"/Applications/DeepSeek Harness.app/Contents/Resources/runtime/cli/bin/dsh" \
  plugin --profile desktop add "github:c-ling/dsh-plugin-goldboard#v1.15.0"
```

Restart the host and hard-refresh. Manual mode requires re-running `corepack pnpm add`; the loader row stays unchanged.

The pin now points at `v1.15.0`; use `v1.14.0` explicitly only for the old floating-window rollback.

## Uninstall

```sh
dsh plugin --profile web remove dsh-plugin-goldboard
# Desktop:
"/Applications/DeepSeek Harness.app/Contents/Resources/runtime/cli/bin/dsh" \
  plugin --profile desktop remove dsh-plugin-goldboard
```

Bundle mode removes the package from `dsh.profile.bundles` and the patch layer; no manual loader-row edit is needed. State and configuration live under `$DSH_HOME/storages/dsh-plugin-goldboard/` (`config.json`, `state.json`, `history/*.jsonl`, `replay-reports/`, …). Delete that directory manually for a full cleanup.

## Features

- Sidebar **Gold Board** entry plus a standalone page with Overview / Trading / Strategy & replay / Analysis / Data / Settings; 10s refresh (60s while hidden) and Beijing-time display. The entry can show a live price (domestic Au99.99, international XAU, or CMB accumulated gold) selected in Settings.
- Au99.99 (CNY/g), XAU (USD/oz), USDCNY, XAU converted to CNY/g and the domestic-vs-international spread.
- CMB 积存金 price: fetched from the CMB market-center API (`zBuyPrc` / `zSelPrc`; customer buy = ask, customer sell = bid) when available, falling back to the international gold price converted at the exchange rate plus separate buy/sell offsets. Live sampling now records `customerBuy-reference` and `customerSell-reference` independently and calibrates their medians; v1.10 mid-only samples remain readable but are marked legacy. Newly collected CMB bars persist real ask/bid OHLC, while old one-sided history is never relabeled as real bid/ask. The chart, previous-close fallback, and manual minute backfill remain available.
- The suggestion area prefers live CMB data with lane stickiness: a data source must stay unavailable for ~90 seconds before the signal degrades to the next priority lane (international spot converted → Au99.99), and ~90 seconds of recovery before switching back, so a flaky endpoint cannot flip the indicator history back and forth; while waiting the board shows “signal source degraded”, and one alert fires when the downgrade is confirmed.
- Intraday signals: buy signals reference **5/10/30/60-minute data** — a multi-timeframe trend filter requiring EMA20 rising on 10/30/60m bars (10m/30m resampled from the 5m bars), with 5m RSI/support providing entry timing; **a suggestion is only produced when the 5/10-minute windows have >80% and the 30/60-minute windows have >60% valid per-minute data**, otherwise the board says "Data incomplete — no suggestion for now" and shows per-window coverage. Coverage facts also carry effective sample minutes, the largest gap, minutes since the latest gap, re-anchoring, and missing buckets; a short re-anchored fragment is shown as, for example, "Effective 6/60 minutes" even when its local ratio is 100%. **During the first hour after the session opens only the 5/10-minute windows are validated** (the 30/60-minute windows are naturally thin right after the open); **the same relaxed 5/10-minute check applies during the daily 00:00-01:00 Beijing window**. Take-profit, trailing stop, stop-loss and weakness alerts for holdings; **the forced close-before-session-end nudge is off by default (v1.9.0 — no fixed intraday-close bias)**: holdings keep following the regular signals near the close, and the "Force close before session end" switch restores the old behavior for traders who want it. The strategy sizes add/reduce orders against target position bands (light/standard/heavy), with same-direction cooldown, consecutive confirmation, and a signal-strength readout; position changes reset confirmation streaks but no longer erase the same-side cooldown clock. The Overview “Current suggestion” panel also shows the 5/10/30/60-minute EMA20/RSI/SMA/Bollinger/ATR/MACD values and the reasons behind the signal; hovering the ? next to each indicator name explains its meaning and formula.
- Multi-lot positions: record each buy with grams/price, total grams and average cost are derived automatically; add-position suggestions appear on pullback stabilization, and reduce-position suggestions appear on overbought weakness / pullback from highs. Add/reduce suggestions are sized against target position bands and keep a minimum base position, avoiding repeated small-position liquidation.
- Target-retrace exit and trend gate (opt-in, off by default): with `strategy.targetTrailPerGram > 0`, reaching the target only arms the position — `sell_target_trail` is emitted once price gives back that many CNY/g from the peak. `targetPartialRatio` optionally sells a share at the target, and `targetTrailBars` bounds how many closed 5m bars may pass without a new high. `strategy.requirePriceAboveEma60` additionally requires the current price above the 60m EMA20, and `strategy.requireDailyUptrend` requires the last completed daily bar to close above a rising daily EMA20. `strategy.maxBarsBeforeTarget > 0` emits `sell_time_stop` when a position has not reached its target after N closed 5m bars (a pre-arm time stop, distinct from the post-arm `targetTrailBars` timeout). These switches only affect entries and holding exits; the protective stop and session-close paths are never blocked.
- Risk budget and buy gates (Stage 2): `fixed_grams` remains the default staged size. Opt-in `budget` computes worst-case risk per gram from `max(ATR × multiplier, bid/ask buffer, slippage buffer) + execution costs`, then takes the minimum enabled gram, nominal-amount, per-trade risk, daily/weekly loss, drawdown, liquidity, and add-count constraint. A zero value disables each new numeric gate. Gates block new buys only; observation and protective sells remain available. Suggestions show nominal amount, stop distance, risk per gram, worst-case loss, and the ratio to reference equity; `referenceEquityCny` is not an account balance.
- Setup/signal/order ledger (Stage 2): one continuous setup and closed signal bar reuse stable `setupId`/`decisionId` values, so repeated polling is idempotent. Orders retain pending/filled/expired/replaced history; a blocked signal is a `not_executed` decision and creates no order/fill. A position change is marked `user_position_confirmation` only when its direction and grams exactly match one unique pending suggestion; partial, oversized, or unattributed edits remain adjustments. Strategy & replay exposes bounded details, and state v3 restores add counts, losses, cooldown, and pending lifecycle facts.
- Unified execution ledger: `ask + explicit buy fee + buy slippage` is the entry cost, while `bid - explicit sell fee - sell slippage` is the exit proceeds. Real CMB bid/ask never receives an extra estimated spread; estimated spread applies only to a synthetic fallback. Breakeven, targets, stops, valuation, replay, and final marking share this module. The default remains buy 0 + sell 5 CNY/g; this field now explicitly means a charge outside the quoted bid/ask and should be checked against the product agreement. When the product's quoted sell price already contains the fee and you want the configured fee to define the spread, enable `cmb.deriveSellFromFee`: sell price = live buy price − configured sell fee, charged once across execution, risk, ledger and replay; a ≥0.5 CNY/g drift from the live bid adds a `configured_spread_drift` note. Off by default.
- Pending-order tracking (v1.9.0 lifecycle semantics): the plugin remembers the most recently alerted suggested order and keeps it in a "standing" state — a post-suggestion cooldown flip to wait, an in-progress confirmation or a brief data gap only means keep waiting for the fill; **it no longer repeatedly prompts you to cancel**. Tracking is updated or withdrawn only on material changes: an opposite-direction signal, the price drifting beyond the threshold from the limit ("Order drift cancel threshold", default 0.5%; set it to 0 to disable), order expiry or market close clearing, and detected fills (position moved in the order's direction — cleared silently). A real change in price/grams (≥0.5 CNY/g) sends an "order updated" alert; near-identical re-quotes only refresh validity silently. Same-shape repricing of one standing order is rate-limited by a 10-minute quiet window (only a cumulative drift ≥3 CNY/g from the last notified price escalates immediately), so live-quote jitter can no longer flood the channels.
- Alerts: host system notifications (macOS/Linux/Windows) + Feishu/DingTalk/WeCom/generic webhooks; no cooldown or quiet hours. Generic Host-side requests require credential-free HTTPS public targets and reject loopback, private, link-local, metadata addresses, unsafe headers, and redirects. `sell_weakness` and `spread_alert` remain informational/protective signals, and the alert log records per-channel delivery results.
- Calendars: the editable weekday 09:00-next-day 02:00 window is only the CMB reminder/execution policy. Au99.99 uses a separate SGE day-and-night adapter, while XAU/USD uses an independent 24x5 adapter. Snapshots and new replay reports preserve the actual `calendarVersion`.
- Configuration storage (0.2.1): `$DSH_HOME/storages/dsh-plugin-goldboard/config.json`; page saves use `revision` / `expectedRevision` conflict fencing and the file is written with mode `0600`. A legacy `config.json.migrated` is imported to the new `config.json` on first start (kept as a backup); an existing `config.json` always wins. Webhook signing secrets are write-only and never echoed — the page only shows a "Configured" badge.
- Bilingual UI that follows Settings → General → Language; dark/light theming via DSW tokens.
- Auditable market semantics: quote/bar records use `goldboard-market-data-v2` with `sourceTimestamp/receivedAt/ingestedAt`, source delay/future skew, instrument, market, currency, unit, quality, and real/synthetic/proxy/unknown execution evidence. Compact Beijing, epoch seconds/milliseconds, and ISO timestamps normalize consistently. A stale or point-in-time-future XAU or USDCNY leg blocks fallback entries and historical contamination. Any natural-time aggregate with a missing or partial child remains partial and cannot enter formal indicators; XAU spot and `GC=F` futures remain separate.
- Durable facts and source health: `HistoricalStore` append-only partitions CMB customer ask/bid, per-side provenance, and all three clocks by trading day, deduplicates stable event IDs, and supports as-of queries. Old one-sided, manual, and derived records remain proxy forever. The Data tab exposes success rate, continuous-failure duration, P50/P95 latency, usable fallback count, evidence ratios, last-valid time, and gaps. State migration keeps an exact hash-manifested backup, isolates corrupt state/history partitions, and supports explicit rollback.
- Public API: the root exposes only plugin lifecycle and stable domain interfaces. `./market-data`, `./execution`, `./risk`, `./ledger`, `./history`, `./replay`, `./strategy`, `./experiments`, and `./factors` are domain entries; parsers, mutable bar helpers, storage primitives, and fetch replacement hooks are available only through `./testing`.
- Manual model analysis: choose a provider, model and reasoning effort from the current Harness catalog without changing the active conversation model. The model explains host-computed indicators and the rule plan only; it cannot invent prices or issue trading instructions. When data-quality gates fail, manual analysis can still be invoked and the model must report the data limitations. The Analysis tab adds model selection, Analyze now and a separate Query logs panel.
- Query audit logs: every real model call gets a `queryId` and started/finished lifecycle record with model, market snapshot, quality state, input hash, structured result, usage and errors. Logs are stored at `$DSH_HOME/storages/dsh-plugin-goldboard/analysis-log.jsonl`, with redacted details, filters, cursor pagination and orphaned-running recovery.
- ReplaySimulator and long-term validation (Stage 3 / report v6): the strategy adapter emits decisions only; the simulator independently advances pending/fill/expiry/replacement, execution-ledger events, and marks. Default `next-bar-limit` forbids signal-bar fills and never fills an untouched limit; same-bar target/stop ambiguity remains `ambiguous/unknown` or follows the explicit conservative policy. Explicit `asOf` bounds both closed frames and historical source/ingestion time, and every report stores dataset, input, and report SHA-256 fingerprints. CMB replay prefers point-in-time `HistoricalStore` records and keeps real/proxy/unknown identities; rolling bars are only a short-window fallback. Long-term mode builds monthly six-month-train/one-month-test folds with frozen test parameters and fold-level sample/interval facts. Reports add exposure, capital utilization, turnover, profit factor, Sharpe/Sortino/Calmar, Wilson win-rate intervals, seeded moving-block bootstrap return intervals, and no-trade, buy-and-hold, fixed-interval DCA, and simple-moving-average benchmarks under the same execution basis. Immutable bounded storage keeps reports plus events/orders/fills/ledger/unexecuted details addressable by ID across restarts, while `replay-stats.json` remains the latest-report compatibility projection. v4/v5 remain byte-preserving read-only reports. The Host forces `evidenceStatus:"exploratory"` whenever history is under 12 months, multiple OOS folds are incomplete, proxy/unknown execution remains, costs are unverified, benchmarks/intervals are incomplete, or sessions are incomplete; there is currently no validated conclusion for changing real positions.
- Strategy experiment layer (Stage 4): `StrategyRegistry` registers the fixed control and replay-only `orb-trend-pullback`; the shared evaluate interface and explicit descriptor/adapter fingerprints enter simulation identity. ORB uses an observing/armed/triggered/expired state machine and records setup, regime, and suppression reasons. The factor contract selects point-in-time records by observation/release/first-available/vintage/tradable-after/ingested-at and holds on missing or stale inputs. Isolated reports expand signal-lane, cost, parameter, and ablation scenarios, compare control, and apply a fail-closed OOS/cost/benchmark promotion gate without mutating live control. XAU remains unavailable unless XAU and USDCNY history can be proven jointly point-in-time.

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
