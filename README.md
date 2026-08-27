# dsh-plugin-goldboard

[English](README-en.md)

DeepSeek Harness 黄金实时看板插件：右上角可拖拽浮窗（可收起为小圆球），显示上金所 Au99.99、伦敦现货金 XAU 与 USDCNY，优先通过招商银行公开接口拉取积存金客户买卖价（接口不可用时回退为国际金价按汇率折算 + 固定价差估算）；结合持仓/上限与手续费（默认买入 0 + 卖出 5 元/克）给出日内买卖参考与建议委托单，并通过宿主机系统通知和 Webhook 在阈值穿越时提醒。

[![dsh-plugin topic](https://img.shields.io/badge/topic-dsh--plugin-blue)](https://github.com/topics/dsh-plugin)
[![license](https://img.shields.io/badge/license-MIT-green)](LICENSE)

> 本插件只提供技术面参考，不自动下单，不构成投资建议。

## 安装

从 GitHub 安装到 web profile（需要 `pnpm` 在 `PATH` 上；没有则用下面的 corepack 方式）：

```sh
npx @deepseek-ai/dsh plugin --profile web add "github:c-ling/dsh-plugin-goldboard#v1.10.0"
```

或使用已有的 `dsh` 命令：

```sh
dsh plugin --profile web add "github:c-ling/dsh-plugin-goldboard#v1.10.0"
```

pnpm 不在 `PATH` 上时：

```sh
cd ~/.dsh/profiles/web
corepack pnpm add "github:c-ling/dsh-plugin-goldboard#v1.10.0"
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

应返回 `{ ok: true, quotes: { AU9999, XAU, USDCNY, CMB }, quality: …, plan: … }`；`quotes.GCF` 若存在表示独立的 COMEX 期货诊断口径。

```sh
curl -s http://127.0.0.1:3080/dsh-plugin-goldboard/models
curl -s 'http://127.0.0.1:3080/dsh-plugin-goldboard/analysis-logs?limit=30'
```

模型目录来自 Harness 当前已注册 provider，日志查询只返回脱敏的结构化摘要；没有选定模型时不会发起模型调用。数据质量门控未通过时仍可手动调用模型，模型会以数据不足/过期/无效等状态说明限制。

## 更新

```sh
dsh plugin --profile web add "github:c-ling/dsh-plugin-goldboard#v1.10.0"
# 或：npx @deepseek-ai/dsh plugin --profile web add "github:c-ling/dsh-plugin-goldboard#v1.10.0"
# 或：cd ~/.dsh/profiles/web && corepack pnpm add "github:c-ling/dsh-plugin-goldboard#v1.10.0"
```

用新的 `#v1.10.0` 重新执行安装命令即可升级依赖；`cordis.patch.yml` 中的 loader 行保持不变。
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
- 招行积存金价格：优先通过招行 `mbmodule-openapi.paas.cmbchina.com` 市场中心接口拉取实时客户买卖价（`zBuyPrc` / `zSelPrc`）；接口不可用时回退为 `国际金价按汇率折算 + 价差偏移`——实时报价有效期间会按分钟采样中间价差，样本充足时用其动态中位数校准兜底估算（来源与样本数在设置页招行卡片展示），否则用静态配置价差（默认 +1.72 元/克，买卖可分别设）。点击招行区域可查看自建的积存金折线图。招行积存金的“昨收/涨跌幅”优先取当天 00:00 的自身价格；若 00:00 无数据，则降级为国际金价昨收折算 + 当前价差估算。设置页会列出今日缺失的招行积存金 1 分钟时间点，直接填写价格即可快速补充，不会覆盖已有数据。
- 建议区域优先以招行积存金实时数据为准；信号道切换带粘滞保护——当前数据源需连续约 90 秒不可用才降级到下一优先道（国际金价折算 → Au99.99），恢复约 90 秒后才自动切回，避免接口抖动导致指标口径来回翻转；等待期间看板标注「信号源降级观察中」，确认降级时发送一次提醒。
- 日内信号：买入信号参考 **5/10/30/60 分钟数据**——10/30/60 分钟 EMA20 一致向上做趋势过滤（10/30 分钟线由 5 分钟线重采样），5 分钟 RSI/支撑做入场时机；**5/10 分钟窗口每分钟有效数据覆盖率必须 >80%，30/60 分钟窗口必须 >60% 才给出建议**，任一时段数据有缺失时看板提示「当前数据有缺失，暂不给出建议」并展示各窗口覆盖率。**开盘后 1 小时内只校验 5/10 分钟窗口**（30/60 分钟窗口开盘初期天然不足）；**每天北京时间 0 点-1 点期间也同样只校验 5/10 分钟窗口**。止盈、移动止盈、止损、走弱减仓提醒；**收盘前强制平仓提示默认关闭（v1.9.0 起不固定倾向于日内了结）**，持仓在临近收盘时段继续按常规信号判断，需要收盘了结纪律时可在设置中开启「收盘前强制平仓提示」。策略按目标仓位区间（轻仓/标准/重仓）计算加减仓量，并加入同方向冷却、连续确认和信号强度显示。浮窗「当前建议」模块会展示 5/10/30/60 分钟 EMA20/RSI/SMA/布林/ATR/MACD 数值及判定依据；指标名称旁的 ? 悬浮可查看含义与计算公式。
- 多笔持仓：可按每次买入的克数/价格分批记录，自动汇总总克数与平均成本；回调企稳时给出补仓建议，冲高回落/超买走弱时给出减仓建议；补仓/减仓按目标仓位区间计算，并保留最小底仓，避免小仓位被反复清仓。
- 回本价与建议委托单：买入 0 + 卖出 5 元/克默认；即使使用招行实时价，回本价仍会加上买入/卖出手续费，可直接查看建议去招行 App 下单。
- 挂单跟踪（v1.9.0 生命周期语义）：插件会记住最近一次已提醒的委托建议并进入「监控中」状态——建议后的同方向冷却转观望、连续确认中或数据短暂缺失，都只是继续等待成交，**不会再反复提示撤单**。只有出现实质性变化才会更新或撤销跟踪：方向相反的新信号、现价偏离原挂单价超过阈值（「挂单偏离撤单阈值」，默认 0.5%，可调）、挂单到期或休市清空，以及检测到仓位已朝建议方向变化（视为已成交，静默清除）。委托价格/克数发生实质变化（≥0.5 元/克）时发送“挂单已更新”提醒，微小重报只静默刷新有效期。同一挂单的同形改价有 **10 分钟静默期**（期间仅当相对上次通知价累计漂移 ≥3 元/克才立即再提醒），不会再被实时报价抖动刷屏。
- 提醒：宿主机系统通知（macOS/Linux/Windows）+ 飞书/钉钉/企业微信/通用 Webhook；无冷却、无勿扰，交易时段内每次阈值穿越都提醒。另含两类保护性提示：持仓且 5 分钟 RSI 超买（默认 >75）并伴随阴线吞没或长上影线时的走弱减仓提醒（`sell_weakness`，参数可调），以及内外盘价差偏离近 60 日均值 ±2σ（样本 ≥20 天，population σ）时的异常提示（`spread_alert`，仅提示不开仓）。提醒日志记录每个渠道的实际送达结果。
- 交易时段：工作日 09:00–次日 02:00，节假日可编辑。
- 配置存储（v1.6.0）：配置迁移到 Harness 统一设置（`$DSH_HOME/settings.yaml` 的 `dsh-plugin-goldboard` namespace），保存后立即生效、刷新与重启均保留；旧版 `config.json` 在升级后首次启动自动迁移并保留为 `config.json.migrated` 备份；无 settings 服务的环境自动回落原存储，功能不变。Webhook 签名密钥只写不回显，页面仅显示「已配置」徽标。
- 中英文 UI，跟随「设置 → 通用 → 语言」；明暗主题使用 DSW 设计变量。
- 技术口径审计：报价带 `instrument`、`market`、`currency`、`unit` 和来源质量元数据；XAU/USD 现货与 Yahoo `GC=F` 黄金期货分开，轮询和汇率推导 K 线明确标记 `synthetic`；正式指标只使用已收盘 K 线，并输出 `calculationVersion`、`warmupReady` 与固定的 Wilder 平滑方法。提供固定行情回放接口：`POST /dsh-plugin-goldboard/replay`。
- 模型分析（手动触发）：从 Harness 当前可用的 provider/model 目录选择模型和 reasoning effort，不改变当前会话模型；模型只解释宿主指标和规则 plan，不能补造价格或生成买卖指令。即使数据质量门控未通过也可手动调用，模型需以数据不足/过期/无效等状态说明限制。设置页的「模型与分析」区域提供目录选择、「立即分析」和独立「查询日志」面板。
- 分析查询日志：每次真实模型调用生成 `queryId`，记录 started/finished 生命周期、模型、行情快照、质量状态、输入 hash、结构化结果、usage 和错误；日志写入 `$DSH_HOME/storages/dsh-plugin-goldboard/analysis-log.jsonl`，支持脱敏详情、筛选、游标分页和孤儿 running 查询恢复。
- 策略统计（v1.10.0，默认积存金道，只读分析）：对最近 10/20/30 个交易日按当前策略参数做批量回放。默认 `lane=cmb`：以**招行积存金信号道**、本机持久化的积存金分钟序列逐日点时切片回放（零网络、不泄露未来数据），指标与规则逐 5 分钟重建（confirmBars/冷却照常生效）；可选 `lane=au9999` 走东财 Au99.99 K 线。顶部连续账户固定从 **0 克** 开始，按时间顺序执行策略建议，使用当前最大克数、手续费和滑点，期末未卖出仓位按最后可卖价扣除退出成本估值；逐笔成交明细列出成交价、克数、费用、成交前后持仓、现金流和已实现收益，并和报告一同落盘到 `storages/dsh-plugin-goldboard/replay-stats.json`。下方动作表仍提供目标命中率、止损触发率、MFE/MAE 和时段末表现等**独立信号质量**指标，不能相加为连续账户收益。报告会附口径局限说明，同一 (窗口,车道,参数) 缓存 1 小时，中途失败仍输出部分报告。

## 数据源

免费公开源，非官方接口，可能限流或变更：

- Au99.99：新浪 `gds_AU9999`（主）→ 上金所 SGE `graph/quotations` → 东财 `118.AU9999` → 60s API（备）
- XAU 现货：腾讯/新浪 `hf_XAU` → gold-api.com → 60s API → GoldPrice.Today；Yahoo `GC=F` 仅作为单独标记的黄金期货诊断源，不替代现货
- USDCNY：腾讯 `whUSDCNY`
- 招行积存金：`https://mbmodule-openapi.paas.cmbchina.com/product/v1/func/market-center`（POST `params=[{"prdType":"H","prdCode":""}]`）
- 品牌金价/积存金（状态页展示）：金投网 `api.jijinhao.com`、京东金融 `api.jdjygold.com`
- Au99.99 K 线：东财 `push2his.eastmoney.com`（被限流时自动切换 `push2delay.eastmoney.com` 延迟镜像，仅取已收盘历史数据），历史可用上金所 `graph/Dailyhq` 兜底
- XAU/USD 现货 K 线：东财 `push2his.eastmoney.com`；若源不可用则标记为数据不足，不把 Yahoo `GC=F` 期货历史改名为现货
- GC=F 期货日线诊断：Yahoo Finance `query1.finance.yahoo.com/v8/finance/chart/GC=F?interval=1d`
- XAU / 招行积存金分钟线：宿主以轮询报价自建

插件使用低频轮询、多源降级、本地缓存；看板标注数据是否过期。仅供个人参考，不用于分发。

## 免责声明

本插件输出均为技术面参考，不构成投资建议。黄金价格波动可能导致亏损，请自行决策并核实招行 App 实际报价。

## License

[MIT](LICENSE)
