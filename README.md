# dsh-plugin-goldboard

[English](README-en.md)

DeepSeek Harness 黄金实时看板与策略诊断插件：Au99.99/XAU/CMB 行情、独立交易日历、招行双边历史、持仓建议与探索性回放。右上角可拖拽浮窗（可收起为小圆球），优先通过招商银行公开接口拉取积存金客户买卖价，接口不可用时回退为国际金价按汇率折算 + 固定价差估算；结合持仓/上限与手续费（默认买入 0 + 卖出 5 元/克）给出日内参考，并通过宿主机系统通知和 Webhook 在阈值穿越时提醒。

[![dsh-plugin topic](https://img.shields.io/badge/topic-dsh--plugin-blue)](https://github.com/topics/dsh-plugin)
[![license](https://img.shields.io/badge/license-MIT-green)](LICENSE)

> 本插件只提供技术面参考，不自动下单，不构成投资建议。
>
> v1.11.0 执行、估值与回放 v5 的完成项/延期项见 [策略优化说明](docs/v1.11.0-strategy-optimization.md)。
> v1.12.0 在策略统计明细中保留达到仓位上限等原因导致的未执行信号，并支持跨重启查看。
> v1.13.0 完成阶段 0 证据与口径冻结：回放报告统一标记为“探索性诊断”，5 分钟模拟、真实/代理/未知双边覆盖、完整/部分交易日、成本假设和 control 版本均会随报告输出；当前没有已验证策略或真实业绩结论。
> v1.14.0 完成[阶段 1 数据与执行事实层](docs/stage-1-implementation-plan.md)：新增 market data v2、独立品种日历、长期 CMB 双边 point-in-time 历史、state v2 迁移/回滚、完整覆盖质量、统一执行证据和收紧后的公共接口；默认 RSI、ATR、仓位与提醒策略保持不变。

## 安装

从 GitHub 安装到 web profile（需要 `pnpm` 在 `PATH` 上；没有则用下面的 corepack 方式）：

```sh
npx @deepseek-ai/dsh plugin --profile web add "github:c-ling/dsh-plugin-goldboard#v1.14.0"
```

或使用已有的 `dsh` 命令：

```sh
dsh plugin --profile web add "github:c-ling/dsh-plugin-goldboard#v1.14.0"
```

pnpm 不在 `PATH` 上时：

```sh
cd ~/.dsh/profiles/web
corepack pnpm add "github:c-ling/dsh-plugin-goldboard#v1.14.0"
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

应返回 `{ ok: true, quotes: { AU9999, XAU, USDCNY, CMB }, quality: …, plan: … }`；`quotes.GCF` 若存在表示独立的 COMEX 期货诊断口径。`/replay-stats` 新报告会额外返回 `strategyVersion`、`calculationVersion`、`dataSchemaVersion`、`executionVersion`、`calendarVersion`、`evidenceStatus: "exploratory"`、`costAssumptions` 和 real/proxy/unknown `executionCoverage`。

```sh
curl -s http://127.0.0.1:3080/dsh-plugin-goldboard/models
curl -s 'http://127.0.0.1:3080/dsh-plugin-goldboard/analysis-logs?limit=30'
```

模型目录来自 Harness 当前已注册 provider，日志查询只返回脱敏的结构化摘要；没有选定模型时不会发起模型调用。数据质量门控未通过时仍可手动调用模型，模型会以数据不足/过期/无效等状态说明限制。

## 更新

```sh
dsh plugin --profile web add "github:c-ling/dsh-plugin-goldboard#v1.14.0"
# 或：npx @deepseek-ai/dsh plugin --profile web add "github:c-ling/dsh-plugin-goldboard#v1.14.0"
# 或：cd ~/.dsh/profiles/web && corepack pnpm add "github:c-ling/dsh-plugin-goldboard#v1.14.0"
```

用新的 `#v1.14.0` 重新执行安装命令即可升级依赖；`cordis.patch.yml` 中的 loader 行保持不变。
重启 `dsh web`，然后硬刷新。

## 卸载

```sh
cd ~/.dsh/profiles/web
corepack pnpm remove dsh-plugin-goldboard
# 或：dsh plugin --profile web remove dsh-plugin-goldboard
```

同时删除 `cordis.patch.yml` 中对应的 `insert` 行，然后重启 `dsh web`。
本插件会保存状态，热缓存位于 `$DSH_HOME/storages/dsh-plugin-goldboard/state.json`，长期 CMB 双边历史按交易日追加到 `history/*.jsonl`；卸载后需手动清理整个目录。

## 功能

- 右上角浮窗（头部/底部均可拖拽，位置锚定窗口边缘并随窗口缩放自动修正），可收起为小圆球；10 秒刷新（页面隐藏时 60 秒），时间按北京时间展示。
- Au99.99（元/克）、XAU（美元/盎司）、USDCNY、国际金价折算元/克与内外价差。
- 招行积存金价格：优先通过招行 `mbmodule-openapi.paas.cmbchina.com` 市场中心接口拉取实时客户买卖价（`zBuyPrc` / `zSelPrc`，客户买入=ask、客户卖出=bid）；接口不可用时回退为 `国际金价按汇率折算 + 买/卖偏移`。实时报价有效期间会分别采样 `customerBuy-reference` 与 `customerSell-reference`，样本充足时按双边中位数动态校准；v1.10 的单一中间价样本仍可读取，但明确标记为 legacy。新采集的 CMB K 线会同时持久化真实 ask/bid OHLC，旧单边历史不会伪装成真实双边数据。点击招行区域可查看自建折线图；昨收和手动补录行为保持不变。
- 建议区域优先以招行积存金实时数据为准；信号道切换带粘滞保护——当前数据源需连续约 90 秒不可用才降级到下一优先道（国际金价折算 → Au99.99），恢复约 90 秒后才自动切回，避免接口抖动导致指标口径来回翻转；等待期间看板标注「信号源降级观察中」，确认降级时发送一次提醒。
- 日内信号：买入信号参考 **5/10/30/60 分钟数据**——10/30/60 分钟 EMA20 一致向上做趋势过滤（10/30 分钟线由 5 分钟线重采样），5 分钟 RSI/支撑做入场时机；**5/10 分钟窗口每分钟有效数据覆盖率必须 >80%，30/60 分钟窗口必须 >60% 才给出建议**，任一时段数据有缺失时看板提示「当前数据有缺失，暂不给出建议」。覆盖投影同时记录有效样本分钟、最大缺口、距最近缺口、重锚状态和缺失桶；重锚后的短片段即使比例为 100%，UI 也会显示例如“有效 6/60 分钟”，不会冒充完整窗口。**开盘后 1 小时内只校验 5/10 分钟窗口**（30/60 分钟窗口开盘初期天然不足）；**每天北京时间 0 点-1 点期间也同样只校验 5/10 分钟窗口**。止盈、移动止盈、止损、走弱减仓提醒；**收盘前强制平仓提示默认关闭（v1.9.0 起不固定倾向于日内了结）**，持仓在临近收盘时段继续按常规信号判断，需要收盘了结纪律时可在设置中开启「收盘前强制平仓提示」。策略按目标仓位区间（轻仓/标准/重仓）计算加减仓量，并加入同方向冷却、连续确认和信号强度显示；仓位变化只重置确认 streak，不再清空同向冷却时钟。浮窗「当前建议」模块会展示 5/10/30/60 分钟 EMA20/RSI/SMA/布林/ATR/MACD 数值及判定依据；指标名称旁的 ? 悬浮可查看含义与计算公式。
- 多笔持仓：可按每次买入的克数/价格分批记录，自动汇总总克数与平均成本；回调企稳时给出补仓建议，冲高回落/超买走弱时给出减仓建议；补仓/减仓按目标仓位区间计算，并保留最小底仓，避免小仓位被反复清仓。
- 统一执行账本：`ask + 显式买入费 + 买入滑点` 形成买入成本，`bid - 显式卖出费 - 卖出滑点` 形成卖出净额；真实 CMB 双边报价不再重复叠加估算点差，估算点差只用于缺少双边价的 synthetic fallback。回本、目标、止损、浮盈亏、回放和期末估值共享同一 module。默认配置仍为买入 0 + 卖出 5 元/克；该字段现在明确表示报价外显式费用，请按实际产品协议核对。
- 挂单跟踪（v1.9.0 生命周期语义）：插件会记住最近一次已提醒的委托建议并进入「监控中」状态——建议后的同方向冷却转观望、连续确认中或数据短暂缺失，都只是继续等待成交，**不会再反复提示撤单**。只有出现实质性变化才会更新或撤销跟踪：方向相反的新信号、现价偏离原挂单价超过阈值（「挂单偏离撤单阈值」，默认 0.5%，可调）、挂单到期或休市清空，以及检测到仓位已朝建议方向变化（视为已成交，静默清除）。委托价格/克数发生实质变化（≥0.5 元/克）时发送“挂单已更新”提醒，微小重报只静默刷新有效期。同一挂单的同形改价有 **10 分钟静默期**（期间仅当相对上次通知价累计漂移 ≥3 元/克才立即再提醒），不会再被实时报价抖动刷屏。
- 提醒：宿主机系统通知（macOS/Linux/Windows）+ 飞书/钉钉/企业微信/通用 Webhook；无冷却、无勿扰，交易时段内每次阈值穿越都提醒。通用 Webhook 的 Host 请求仅允许无凭据 HTTPS 公网目标，拒绝 loopback、私网、link-local、metadata 地址、危险 header 与重定向。另含 `sell_weakness` 和 `spread_alert` 两类保护性提示；提醒日志记录每个渠道的实际送达结果。
- 交易时段：可编辑的工作日 09:00–次日 02:00 仅作为 CMB 提醒/执行规则；Au99.99 使用 SGE 日盘+夜盘 adapter，XAU/USD 使用独立 24x5 adapter。snapshot 与新 replay 报告保存实际 `calendarVersion`。
- 配置存储（v1.6.0）：配置迁移到 Harness 统一设置（`$DSH_HOME/settings.yaml` 的 `dsh-plugin-goldboard` namespace），保存后立即生效、刷新与重启均保留；旧版 `config.json` 在升级后首次启动自动迁移并保留为 `config.json.migrated` 备份；无 settings 服务的环境自动回落原存储，功能不变。Webhook 签名密钥只写不回显，页面仅显示「已配置」徽标。
- 中英文 UI，跟随「设置 → 通用 → 语言」；明暗主题使用 DSW 设计变量。
- 技术口径审计：quote/bar 使用 `goldboard-market-data-v2`，带 `sourceTimestamp/receivedAt/ingestedAt`、source delay/future skew、品种、市场、货币、单位、质量和 real/synthetic/proxy/unknown 执行证据；compact 北京时间、epoch 秒/毫秒和 ISO 时间统一规范化。XAU 与 USDCNY 任一 stale 或 point-in-time future 都禁止 fallback 新开仓和历史污染。所有自然时间聚合缺子 K 或包含 partial 子 K 时，父桶保持 partial 并排除在正式指标之外；XAU 现货与 `GC=F` 期货严格分开。
- 长期事实存储与源健康：`HistoricalStore` 按 CMB 交易日 append-only 保存 customer ask/bid、各侧来源和三类时间，稳定 event ID 去重并支持 as-of 查询；旧单边、手工和派生记录永久保留 proxy 身份。状态页显示源成功率、连续失败时长、P50/P95、可用备用源、执行证据比例、最后有效时刻和缺口。旧 state 首次升级前原字节备份并生成 hash manifest；损坏 state/历史分区隔离，支持显式回滚。
- 公共接口：根入口只导出插件生命周期和稳定领域接口；`./market-data`、`./execution`、`./history`、`./replay` 提供领域入口，parser、bar 变异器、存储原语和 fetch 替换 hook 仅位于 `./testing`。
- 模型分析（手动触发）：从 Harness 当前可用的 provider/model 目录选择模型和 reasoning effort，不改变当前会话模型；模型只解释宿主指标和规则 plan，不能补造价格或生成买卖指令。即使数据质量门控未通过也可手动调用，模型需以数据不足/过期/无效等状态说明限制。设置页的「模型与分析」区域提供目录选择、「立即分析」和独立「查询日志」面板。
- 分析查询日志：每次真实模型调用生成 `queryId`，记录 started/finished 生命周期、模型、行情快照、质量状态、输入 hash、结构化结果、usage 和错误；日志写入 `$DSH_HOME/storages/dsh-plugin-goldboard/analysis-log.jsonl`，支持脱敏详情、筛选、游标分页和孤儿 running 查询恢复。
- 回放诊断（v1.14.0，基于 v1.13.0 阶段 0 / report v5）：默认只选已到配置收盘时点且数据到达时段尾部的完整交易日。策略在信号 K 收盘后只创建限价 pending order，最早从下一根完整 5 分钟 K 线判断 ask/bid 是否触及；未触及或超过 `validUntil` 记为 expired，不成交。同一 K 同触目标和止损时标记 `ambiguousBar`，默认按多头止损先到的保守路径，并报告最佳/最差区间。报告新增订单数、成交率、过期率、平均延迟、双触及数、真实/代理/未知 bid/ask 覆盖、成本假设与成本拆分、权益曲线和最大回撤，并冻结 `control` 策略、指标、market data v2、execution v2、所选 lane 的独立日历和 report 版本。报告明确 `evidenceStatus: "exploratory"`，并携带长期历史、OOS、真实双边、费用语义、基准和不确定性区间等验证准入门槛；这些门槛未满足前不称为验证结果。订单、fills 和兼容 trade 明细一并持久化。策略条件已确认但因连续账户达到最大克数而没有创建订单时，会另存为“未执行策略信号”，显示信号时间、价格、当时仓位/上限和原因，且不计入成交率、现金流或收益。独立信号表也先走同一 next-bar fill/expiry 判断，未成交建议只计决策/过期数，不进入目标、回本或时段净结果。v4 和阶段 0 之前的 v5 报告只读显示已有版本、窗口、参数和 caveat，不补字段、不重算、不与新口径比较。所有数字仍是 5 分钟数据上的探索性模拟诊断，不是实际成交或样本外业绩证据。

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
