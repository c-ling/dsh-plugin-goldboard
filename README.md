# dsh-plugin-goldboard

DeepSeek Harness 黄金实时看板插件：右上角可拖拽浮窗（可收起为小圆球），显示上金所 Au99.99、伦敦现货金 XAU 与 USDCNY，按固定价差估算招商银行积存金价格；结合持仓/上限与手续费（默认买入 0 + 卖出 5 元/克）给出日内买卖参考与建议委托单，并通过宿主机系统通知和 Webhook 在阈值穿越时提醒。

[English](README-en.md)

[![dsh-plugin topic](https://img.shields.io/badge/topic-dsh--plugin-blue)](https://github.com/topics/dsh-plugin)
[![license](https://img.shields.io/badge/license-MIT-green)](LICENSE)

> 本插件只提供技术面参考，不自动下单，不构成投资建议。

## 安装

从 GitHub 安装到 web profile（需要 `pnpm` 在 `PATH` 上；没有则用下面的 corepack 方式）：

```sh
npx @deepseek-ai/dsh plugin --profile web add "github:c-ling/dsh-plugin-goldboard#v1.0.0"
```

或使用已有的 `dsh` 命令：

```sh
dsh plugin --profile web add "github:c-ling/dsh-plugin-goldboard#v1.0.0"
```

pnpm 不在 `PATH` 上时：

```sh
cd ~/.dsh/profiles/web
corepack pnpm add "github:c-ling/dsh-plugin-goldboard#v1.0.0"
```

> `dsh plugin` 把参数原样转发给 pnpm，直接从本仓库拉取包（pnpm 9+，本机需装有 `git`）。
> 安装时若看到 `declares no dsh.bundle — installed as a plain dependency` 的提示属正常现象：
> 本插件不是 profile bundle 层，而是通过下面的 loader 行激活。

然后在 `~/.dsh/profiles/web/cordis.patch.yml` 增加一行插入：

```yaml
- insert:
    - id: dsh-plugin-goldboard
      name: 'dsh-plugin-goldboard'
```

重启 `dsh web`（client-modules 按进程缓存包裁决，新包必须重启宿主），然后硬刷新页面。
右上角会出现黄金看板浮窗；设置页新增“黄金看板”。

## 验证

```sh
curl -s http://127.0.0.1:3080/plugins/dsh-plugin-goldboard/client.js | head -c 60
```

应输出 `window.__ModuleLoader__.load({` 开头的 factory bundle。

```sh
curl -s http://127.0.0.1:3080/dsh-plugin-goldboard/snapshot
```

应返回 `{ ok: true, quotes: { AU9999, XAU, USDCNY }, plan: … }`。

## 更新

```sh
dsh plugin --profile web add "github:c-ling/dsh-plugin-goldboard#v1.0.0"
# 或：npx @deepseek-ai/dsh plugin --profile web add "github:c-ling/dsh-plugin-goldboard#v1.0.0"
# 或：cd ~/.dsh/profiles/web && corepack pnpm add "github:c-ling/dsh-plugin-goldboard#v1.0.0"
```

用新的 `#v1.0.0` 重新执行安装命令即可升级依赖；`cordis.patch.yml` 中的 loader 行保持不变。
重启 `dsh web`，然后硬刷新。

## 卸载

```sh
cd ~/.dsh/profiles/web
corepack pnpm remove dsh-plugin-goldboard
# 或：dsh plugin --profile web remove dsh-plugin-goldboard
```

同时删除 `cordis.patch.yml` 中对应的 `insert` 行，然后重启 `dsh web`。
本插件会保存状态，数据位于 `$DSH_HOME/storages/dsh-plugin-goldboard/`，卸载后需手动清理。

## 功能

- 右上角浮窗（头部/底部均可拖拽，位置锚定窗口边缘并随窗口缩放自动修正），可收起为小圆球；10 秒刷新（页面隐藏时 60 秒），时间按北京时间展示。
- Au99.99（元/克）、XAU（美元/盎司）、USDCNY、国际金价折算元/克与内外价差。
- 招行积存金估算价：`Au99.99 + 可配置价差`（默认 +1.72 元/克，买卖可分别设）。
- 日内信号：趋势过滤 + RSI/支撑触发买入；止盈、移动止盈、止损、日内了结、走弱减仓提醒。
- 回本价与建议委托单：买入 0 + 卖出 5 元/克默认，一键复制手动去招行 App 下单。
- 提醒：宿主机系统通知（macOS/Linux/Windows）+ 飞书/钉钉/企业微信/通用 Webhook；无冷却、无勿扰，交易时段内每次阈值穿越都提醒。
- 交易时段：工作日 09:00–次日 02:00，节假日可编辑。
- 中英文 UI，跟随「设置 → 通用 → 语言」；明暗主题使用 DSW 设计变量。

## 数据源

免费公开源，非官方接口，可能限流或变更：

- Au99.99：新浪 `gds_AU9999`（主）/ 东财 `118.AU9999`（备）
- XAU 现货：腾讯/新浪 `hf_XAU`
- USDCNY：腾讯 `whUSDCNY`
- Au99.99 K 线：东财 `push2his.eastmoney.com`
- XAU 分钟线：宿主以 30 秒现货报价自建

插件使用低频轮询、多源降级、本地缓存；看板标注数据是否过期。仅供个人参考，不用于分发。

## 免责声明

本插件输出均为技术面参考，不构成投资建议。黄金价格波动可能导致亏损，请自行决策并核实招行 App 实际报价。

## License

[MIT](LICENSE)
