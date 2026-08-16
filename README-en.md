[中文](README.md)

# dsh-plugin-goldboard

A real-time gold dashboard plugin for DeepSeek Harness: a draggable top-right floating board (collapsible to a small orb) showing SGE Au99.99, London spot gold XAU and USDCNY, with China Merchants Bank 积存金 prices estimated from a configurable fixed spread. It uses your position/limits and fee model (default buy 0 + sell 5 CNY/g) to produce intraday buy/sell references and a copyable suggested order, and alerts on every threshold crossing via host system notifications and webhooks.

> This plugin provides technical references only. It never places orders and is not investment advice.

## Install

### Local development install

```sh
cd ~/.dsh/profiles/web
corepack pnpm add "link:/absolute/path/to/dsh-plugin-goldboard"
```

Then add this row to `~/.dsh/profiles/web/cordis.patch.yml`:

```yaml
- insert:
    - id: dsh-plugin-goldboard
      name: 'dsh-plugin-goldboard'
```

Restart `dsh web`, then hard-refresh the page.

### GitHub install after release 

```sh
npx @deepseek-ai/dsh plugin --profile web add "github:c-ling/dsh-plugin-goldboard#v1.0.0"
```

Or with an existing `dsh` binary:

```sh
dsh plugin --profile web add "github:c-ling/dsh-plugin-goldboard#v1.0.0"
```

When `pnpm` is not on `PATH`:

```sh
cd ~/.dsh/profiles/web
corepack pnpm add "github:c-ling/dsh-plugin-goldboard#v1.0.0"
```

> `dsh plugin` forwards its arguments to pnpm (pnpm 9+, `git` required). The warning
> `declares no dsh.bundle — installed as a plain dependency` is expected: this plugin is
> not a profile bundle layer; it is activated by the loader row below.

Then add a loader row to `~/.dsh/profiles/web/cordis.patch.yml`:

```yaml
- insert:
    - id: dsh-plugin-goldboard
      name: 'dsh-plugin-goldboard'
```

Restart `dsh web` (client-modules caches package verdicts per process; new packages require a
host restart), then hard-refresh the page. The gold board appears in the top-right corner and
a "Gold Board" section is added to Settings.

## Verify

```sh
curl -s http://127.0.0.1:3080/plugins/dsh-plugin-goldboard/client.js | head -c 60
```

It should print a factory bundle starting with `window.__ModuleLoader__.load({`.

```sh
curl -s http://127.0.0.1:3080/dsh-plugin-goldboard/snapshot
```

It should return `{ ok: true, quotes: { AU9999, XAU, USDCNY }, plan: … }`.

## Update

```sh
dsh plugin --profile web add "github:c-ling/dsh-plugin-goldboard#v1.0.0"
# or: npx @deepseek-ai/dsh plugin --profile web add "github:c-ling/dsh-plugin-goldboard#v1.0.0"
# or: cd ~/.dsh/profiles/web && corepack pnpm add "github:c-ling/dsh-plugin-goldboard#v1.0.0"
```

Re-running the install command with the new `#v<version>` pin upgrades the dependency;
the loader row in `cordis.patch.yml` stays unchanged. Restart `dsh web`, then hard-refresh.

## Uninstall

```sh
cd ~/.dsh/profiles/web
corepack pnpm remove dsh-plugin-goldboard
# or: dsh plugin --profile web remove dsh-plugin-goldboard
```

Also remove the matching `insert` row from `cordis.patch.yml`, then restart `dsh web`.
This plugin keeps state under `$DSH_HOME/storages/dsh-plugin-goldboard/`, which is left for
manual cleanup after uninstall.

## Features

- Top-right floating board (drag from its header or footer; the position is anchored to the viewport edge and re-clamped on resize), collapsible to a small orb; 10s refresh (60s while hidden) and Beijing-time display.
- Au99.99 (CNY/g), XAU (USD/oz), USDCNY, XAU converted to CNY/g and the domestic-vs-international spread.
- CMB 积存金 estimated price: `Au99.99 + configurable spread` (default +1.72 CNY/g, buy/sell separately).
- Intraday signals: trend filter + RSI/support triggers for buys; take-profit, trailing stop, stop-loss, close-before-session-end and weakness alerts for holdings.
- Breakeven and suggested orders: default buy 0 + sell 5 CNY/g, one-click copy to place manually in the CMB app.
- Alerts: host system notifications (macOS/Linux/Windows) + Feishu/DingTalk/WeCom/generic webhooks; no cooldown, no quiet hours — every threshold crossing during trading hours alerts immediately.
- Trading hours: weekdays 09:00–next-day 02:00, editable holidays.
- Bilingual UI that follows Settings → General → Language; dark/light theming via DSW tokens.

## Data sources

Free public, unofficial endpoints; they may rate-limit or change:

- Au99.99: Sina `gds_AU9999` (primary) / Eastmoney `118.AU9999` (fallback)
- XAU spot: Tencent/Sina `hf_XAU`
- USDCNY: Tencent `whUSDCNY`
- Au99.99 klines: Eastmoney `push2his.eastmoney.com`
- XAU minute bars: built by the host from 30-second spot polls

The plugin uses low-frequency polling, multi-source fallback and local caching; stale data is
flagged on the board. Personal reference only; do not redistribute.

## Disclaimer

All output is a technical reference and does not constitute investment advice. Gold prices can
move against you. Make your own decisions and always verify the actual price in the CMB app.
