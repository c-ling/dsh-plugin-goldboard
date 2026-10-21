# dsh-plugin-goldboard

[English](README-en.md)

DeepSeek Harness 黄金实时看板与策略诊断插件（Web 与 Desktop）：侧边栏「黄金看板」入口打开独立主面板页面，用「概览 / 交易 / 策略与回放 / 分析 / 数据 / 设置」六个 Tab 承载 Au99.99/XAU/CMB 行情、独立交易日历、招行双边历史、风险约束的持仓建议，以及带数据集/OOS 准入门槛的可复现回放。优先通过招商银行公开接口拉取积存金客户买卖价，接口不可用时回退为国际金价按汇率折算 + 固定价差估算；结合持仓/上限与手续费（默认买入 0 + 卖出 5 元/克）给出日内参考，并通过宿主机系统通知和 Webhook 在阈值穿越时提醒。

[![dsh-plugin topic](https://img.shields.io/badge/topic-dsh--plugin-blue)](https://github.com/topics/dsh-plugin)
[![license](https://img.shields.io/badge/license-MIT-green)](LICENSE)

> 本插件只提供技术面参考，不自动下单，不构成投资建议。
>
> v1.11.0 执行、估值与回放 v5 的完成项/延期项见 [策略优化说明](docs/v1.11.0-strategy-optimization.md)。
> v1.12.0 在策略统计明细中保留达到仓位上限等原因导致的未执行信号，并支持跨重启查看。
> v1.13.0 完成阶段 0 证据与口径冻结：回放报告统一标记为“探索性诊断”，5 分钟模拟、真实/代理/未知双边覆盖、完整/部分交易日、成本假设和 control 版本均会随报告输出；当前没有已验证策略或真实业绩结论。
> v1.14.0 完成[阶段 1 数据与执行事实层](docs/stage-1-implementation-plan.md)：新增 market data v2、独立品种日历、长期 CMB 双边 point-in-time 历史、state v2 迁移/回滚、完整覆盖质量、统一执行证据和收紧后的公共接口；默认 RSI、ATR、仓位与提醒策略保持不变。
> v1.15.0 发布阶段 2/3/4、0.2.1 侧边栏页面重构，以及目标回撤止盈、日线 EMA20 趋势闸门、武装前时间止损、按卖出价推导手续费和持仓重置/信号账本弹窗等交易能力；默认仍为固定克数与 control。
> v1.15.0 包含[阶段 2 风险闸门与订单生命周期](docs/stage-2-implementation-plan.md)：默认仍为 `fixed_grams`；可选 `budget` 模式、日/周/回撤与加仓闸门、stable setup/decision/order ID、state v3 和只读信号账本已实现。参考权益与 ledger 损益都只是本地风险估算，不是真实账户余额或流水。
> v1.15.0 包含[阶段 3 ReplaySimulator 与长期验证框架](docs/stage-3-implementation-plan.md)：report v6 固定 as-of、dataset/input/report fingerprint，按月生成 6+1 walk-forward folds，并报告风险调整指标、Wilson/block-bootstrap 区间和四类同口径基准。实际历史不足 12 个月、真实双边覆盖不足或费用语义未核实时，Host 会强制保留 `exploratory`，不显示“已验证策略”。
> v1.15.0 包含[阶段 4 策略实验层](docs/stage-4-implementation-plan.md)：正式策略契约/注册表、control adapter、ORB 趋势回调状态机、趋势/震荡/高波动标签、point-in-time 因子契约、隔离的策略/lane/消融/参数/成本矩阵和 fail-closed 晋级报告。实验默认关闭，live 始终固定 `control`；缺少 XAU+USDCNY 点时联合数据的场景明确为 unavailable，统计/ML/DRL 只登记未运行能力，不伪造训练结果。
> v1.15.0 同时完成 **0.2.1 侧边栏页面重构**：移除右上角浮窗与 Settings 页面，改为 `sidebar.panellist` 入口 + `main` 独立页面；Host 路由迁移到 `/api/dsh-plugin-goldboard/...`，配置回到插件私有 `config.json`。安装命令统一 pin 到 `#v1.15.0`；`v1.14.0` 仅用于回退旧浮窗版本。

## 安装

目标运行时 **DeepSeek Harness 0.2.1+**（Web 与 Desktop）。本包声明 `dsh.bundle`，推荐按 bundle 安装。

> **版本提示**：从 v1.15.0 起，GitHub 安装即得到侧边栏页面 + bundle 形态（无需手写 loader 行）；`v1.14.0` 仍是旧浮窗版本，仅用于回退。

### Web（bundle，推荐）

```sh
dsh plugin --profile web add "github:c-ling/dsh-plugin-goldboard#v1.15.0"
# 或
npx @deepseek-ai/dsh plugin --profile web add "github:c-ling/dsh-plugin-goldboard#v1.15.0"
```

`dsh plugin` 会把包加入 profile 的 `dsh.profile.bundles`，`cordis.patch.yml` 负责插入 loader 行；**不要再手写同一条 loader 行**。

### Desktop（bundle）

使用 Desktop 自带 CLI（`--profile desktop` 由 Desktop App 管理，`npx @deepseek-ai/dsh` 会拒绝）：

```sh
"/Applications/DeepSeek Harness.app/Contents/Resources/runtime/cli/bin/dsh" \
  plugin --profile desktop add "github:c-ling/dsh-plugin-goldboard#v1.15.0"
```

也可以退出 App 后，在 Plugins 页面安装本地路径或 GitHub tag。

### 手动模式（plain dependency）

```sh
cd ~/.dsh/profiles/web
corepack pnpm add "github:c-ling/dsh-plugin-goldboard#v1.15.0"
```

然后在 `~/.dsh/profiles/web/cordis.patch.yml` 增加：

```yaml
- insert:
    - id: dsh-plugin-goldboard
      name: 'dsh-plugin-goldboard'
```

手动模式不要再把包加入 `dsh.profile.bundles`，否则会重复激活。
本地开发验证也可以直接安装绝对路径（Web）：

```sh
dsh plugin --profile web add "link:/absolute/path/to/dsh-plugin-goldboard"
```

Desktop 使用同一 `link:` 形式调用自带 CLI，或从 Plugins 页面选择本地目录。

### 重启与入口

安装/更新后重启宿主（Web 重启 `dsh web`；Desktop 退出并重新打开 App），然后硬刷新页面。`client-modules` 按进程缓存包裁决，新 bundle 不重启不会生效。

侧边栏会出现「黄金看板 / Gold Board」入口；点击后在主内容区打开独立页面，包含：

- **概览**：行情卡、今日走势、当前建议、持仓/风险摘要、数据质量；
- **交易**：持仓与上限、风险预算、费用/招行价差、手动昨收（仅当日有效，北京时间 0 点自动清空）、策略参数、交易时段；独立保存；
- **策略与回放**：回放统计、策略实验、信号账本；
- **分析**：模型配置、立即分析、查询日志；
- **数据**：数据源健康、历史覆盖、招行积存金分钟补录；
- **设置**：系统通知与 Webhook 渠道，独立保存。

每个可配置 Tab 有独立的保存按钮，只提交本 Tab 的配置节；未保存的修改在 Tab 间保留。页面只滚动 Tab 内容区，页头与 Tab 栏固定。旧的「右上角浮窗」和 Settings 中的「黄金看板」页面已移除。

## 验证

```sh
curl -s -o /dev/null -w '%{http_code}\n' http://127.0.0.1:<port>/api/dsh-plugin-goldboard/snapshot
# 401 = 请求已到达 /api 认证桥；不能据此证明路由存在，需在已认证 GUI 中验证
curl -s -o /dev/null -w '%{http_code}\n' http://127.0.0.1:<port>/dsh-plugin-goldboard/snapshot
# 404 = 旧的匿名 webServer 路由已移除
```

在已登录 GUI 打开侧边栏「黄金看板」，确认：

- 页面能加载行情与建议，Tab 可切换；
- 设置保存后重启仍保留；
- 浏览器控制台无 `slot entry crashed`；
- Web 与 Desktop 都能看到入口和页面。

主要端点（均需认证，路径包含 `/api`）：

```sh
curl -s 'http://127.0.0.1:<port>/api/dsh-plugin-goldboard/snapshot'
curl -s 'http://127.0.0.1:<port>/api/dsh-plugin-goldboard/ledger?limit=20'
curl -s 'http://127.0.0.1:<port>/api/dsh-plugin-goldboard/strategies'
curl -s 'http://127.0.0.1:<port>/api/dsh-plugin-goldboard/replay-reports'
```

`/snapshot` 返回 `{ ok: true, quotes: { AU9999, XAU, USDCNY, CMB }, quality, risk, ledger, plan }`；`/replay-stats` 的 report v6 返回 `asOf`、`dataset`、`inputFingerprint`、`reportFingerprint`、`metrics`、`oos`、`benchmarks`、real/proxy/unknown `groups` 和 Host 派生的 `validationGate`。`GET /replay-stats?reportId=…&detail=true` 可按 ID 跨重启查询不可变报告明细。

`GET/POST /api/dsh-plugin-goldboard/strategy-experiments` 读取或显式运行隔离实验矩阵；POST 只有先在「策略与回放」保存实验配置后才接受，报告始终包含 `promotion.liveStrategyChanged:false`。

`GET /api/dsh-plugin-goldboard/analysis` 返回最近分析状态，`GET /api/dsh-plugin-goldboard/analysis-logs?limit=30` 返回脱敏日志；模型目录来自 Harness 当前注册的 provider，没有选定模型时不会发起模型调用。

## 更新

bundle 模式重新执行安装命令即可：

```sh
dsh plugin --profile web add "github:c-ling/dsh-plugin-goldboard#v1.15.0"
# 或 Desktop：
"/Applications/DeepSeek Harness.app/Contents/Resources/runtime/cli/bin/dsh" \
  plugin --profile desktop add "github:c-ling/dsh-plugin-goldboard#v1.15.0"
```

更新后重启宿主并硬刷新。手动模式需要重新 `corepack pnpm add`，loader 行保持不变。

当前 pin 指向 `v1.15.0`；如需回退旧浮窗版本，可显式使用 `v1.14.0`。

## 卸载

```sh
dsh plugin --profile web remove dsh-plugin-goldboard
# Desktop：
"/Applications/DeepSeek Harness.app/Contents/Resources/runtime/cli/bin/dsh" \
  plugin --profile desktop remove dsh-plugin-goldboard
```

bundle 模式会同时从 `dsh.profile.bundles` 和 patch 层移除，不需要手动删 loader 行。状态和配置位于 `$DSH_HOME/storages/dsh-plugin-goldboard/`（`config.json`、`state.json`、`history/*.jsonl`、`replay-reports/` 等）；卸载后如需彻底清理，请手动删除该目录。

## 功能

- 侧边栏「黄金看板」入口 + 独立主面板页面；概览/交易/策略与回放/分析/数据/设置六个 Tab；10 秒刷新（页面隐藏时 60 秒），时间按北京时间展示。入口右侧可显示实时金价（国内 Au99.99 / 国际 XAU / 招行积存金，可在「设置」Tab 选择）。
- Au99.99（元/克）、XAU（美元/盎司）、USDCNY、国际金价折算元/克与内外价差。
- 招行积存金价格：优先通过招行 `mbmodule-openapi.paas.cmbchina.com` 市场中心接口拉取实时客户买卖价（`zBuyPrc` / `zSelPrc`，客户买入=ask、客户卖出=bid）；接口不可用时回退为 `国际金价按汇率折算 + 买/卖偏移`。实时报价有效期间会分别采样 `customerBuy-reference` 与 `customerSell-reference`，样本充足时按双边中位数动态校准；v1.10 的单一中间价样本仍可读取，但明确标记为 legacy。新采集的 CMB K 线会同时持久化真实 ask/bid OHLC，旧单边历史不会伪装成真实双边数据。点击招行卡片可切换到自建折线图；昨收和手动补录行为保持不变。
- 建议区域优先以招行积存金实时数据为准；信号道切换带粘滞保护——当前数据源需连续约 90 秒不可用才降级到下一优先道（国际金价折算 → Au99.99），恢复约 90 秒后才自动切回，避免接口抖动导致指标口径来回翻转；等待期间看板标注「信号源降级观察中」，确认降级时发送一次提醒。
- 日内信号：买入信号参考 **5/10/30/60 分钟数据**——10/30/60 分钟 EMA20 一致向上做趋势过滤（10/30 分钟线由 5 分钟线重采样），5 分钟 RSI/支撑做入场时机；**5/10 分钟窗口每分钟有效数据覆盖率必须 >80%，30/60 分钟窗口必须 >60% 才给出建议**，任一时段数据有缺失时看板提示「当前数据有缺失，暂不给出建议」。覆盖投影同时记录有效样本分钟、最大缺口、距最近缺口、重锚状态和缺失桶；重锚后的短片段即使比例为 100%，UI 也会显示例如“有效 6/60 分钟”，不会冒充完整窗口。**开盘后 1 小时内只校验 5/10 分钟窗口**（30/60 分钟窗口开盘初期天然不足）；**每天北京时间 0 点-1 点期间也同样只校验 5/10 分钟窗口**。止盈、移动止盈、止损、走弱减仓提醒；**收盘前强制平仓提示默认关闭（v1.9.0 起不固定倾向于日内了结）**，持仓在临近收盘时段继续按常规信号判断，需要收盘了结纪律时可在「交易」Tab 中开启「收盘前强制平仓提示」。策略按目标仓位区间（轻仓/标准/重仓）计算加减仓量，并加入同方向冷却、连续确认和信号强度显示；仓位变化只重置确认 streak，不再清空同向冷却时钟。概览「当前建议」模块会展示 5/10/30/60 分钟 EMA20/RSI/SMA/布林/ATR/MACD 数值及判定依据；指标名称旁的 ? 悬浮可查看含义与计算公式。
- 多笔持仓：可按每次买入的克数/价格分批记录，自动汇总总克数与平均成本；回调企稳时给出补仓建议，冲高回落/超买走弱时给出减仓建议；补仓/减仓按目标仓位区间计算，并保留最小底仓，避免小仓位被反复清仓。
- 目标回撤止盈与趋势闸门（opt-in，默认关闭）：`strategy.targetTrailPerGram > 0` 时，触达目标只「武装」不卖出，价格从峰值回撤该元/克才输出 `sell_target_trail`；`targetPartialRatio` 可选首触目标先卖一部分，`targetTrailBars` 控制未创新高时的最长观察 K 线数。`strategy.requirePriceAboveEma60` 开启后，买点还额外要求现价高于 60 分钟 EMA20；`strategy.requireDailyUptrend` 再要求最近一根已收盘日线收盘价高于日线 EMA20 且 EMA20 上行，用于过滤下跌趋势中的逆势做多。`strategy.maxBarsBeforeTarget > 0` 时，持仓满 N 根已收盘 5m K 线仍未触目标会输出 `sell_time_stop`（武装前时间止损）；它和 `targetTrailBars` 的武装后超时是两套规则。这些开关都只影响买入/持仓退出，不影响止损与收盘保护。
- 风险预算与买入闸门（阶段 2）：默认 `fixed_grams` 保留原分档克数；opt-in `budget` 以 `max(ATR×倍数, bid/ask 缓冲, 滑点缓冲) + 执行成本` 计算每克最坏风险，再与最大克数、名义金额、单笔风险、日/周损失、回撤、流动性和 add 次数取最小约束。所有新增数值闸门为 0 时关闭；闸门只阻止新增买入，观察状态和保护性卖出仍可用。建议单显示名义金额、止损距离、每克风险、最坏情景亏损与参考权益占比；`referenceEquityCny` 不代表账户余额。
- setup/signal/order ledger（阶段 2）：同一连续 setup 与已收盘信号 K 使用稳定 `setupId`/`decisionId`，重复轮询幂等；订单保留 pending/filled/expired/replaced 轨迹，受阻断信号保存为 `not_executed` decision 且不创建 order/fill。用户持仓变化与唯一 pending 建议的方向及克数精确匹配时，才以 `user_position_confirmation` 记录推断成交；partial、超额或无法归因的编辑只记 adjustment。「策略与回放」Tab 可查看有界明细，state v3 恢复 add 计数、损失、cooldown 与 pending 轨迹。
- 统一执行账本：`ask + 显式买入费 + 买入滑点` 形成买入成本，`bid - 显式卖出费 - 卖出滑点` 形成卖出净额；真实 CMB 双边报价不再重复叠加估算点差，估算点差只用于缺少双边价的 synthetic fallback。回本、目标、止损、浮盈亏、回放和期末估值共享同一 module。默认配置仍为买入 0 + 卖出 5 元/克；该字段现在明确表示报价外显式费用，请按实际产品协议核对。若产品的卖出价已含手续费、且希望由配置费决定价差，可开启 `cmb.deriveSellFromFee`：卖出价 = 实时买入价 − 配置卖出费，执行/风控/账本/回放只计一次；派生价与实时卖出价偏离 ≥0.5 元/克时给出 `configured_spread_drift` 提示。默认关闭。
- 挂单跟踪（v1.9.0 生命周期语义）：插件会记住最近一次已提醒的委托建议并进入「监控中」状态——建议后的同方向冷却转观望、连续确认中或数据短暂缺失，都只是继续等待成交，**不会再反复提示撤单**。只有出现实质性变化才会更新或撤销跟踪：方向相反的新信号、现价偏离原挂单价超过阈值（「挂单偏离撤单阈值」，默认 0.5%，设为 0 可关闭）、挂单到期或休市清空，以及检测到仓位已朝建议方向变化（视为已成交，静默清除）。委托价格/克数发生实质变化（≥0.5 元/克）时发送“挂单已更新”提醒，微小重报只静默刷新有效期。同一挂单的同形改价有 **10 分钟静默期**（期间仅当相对上次通知价累计漂移 ≥3 元/克才立即再提醒），不会再被实时报价抖动刷屏。
- 提醒：宿主机系统通知（macOS/Linux/Windows）+ 飞书/钉钉/企业微信/通用 Webhook；无冷却、无勿扰，交易时段内每次阈值穿越都提醒。通用 Webhook 的 Host 请求仅允许无凭据 HTTPS 公网目标，拒绝 loopback、私网、link-local、metadata 地址、危险 header 与重定向。另含 `sell_weakness` 和 `spread_alert` 两类保护性提示；提醒日志记录每个渠道的实际送达结果。
- 交易时段：可编辑的工作日 09:00–次日 02:00 仅作为 CMB 提醒/执行规则；Au99.99 使用 SGE 日盘+夜盘 adapter，XAU/USD 使用独立 24x5 adapter。snapshot 与新 replay 报告保存实际 `calendarVersion`。
- 配置存储（0.2.1）：`$DSH_HOME/storages/dsh-plugin-goldboard/config.json`；页面保存使用 `revision` / `expectedRevision` 冲突保护，文件权限 `0600`。旧版 `config.json.migrated` 在首次启动时导入为新的 `config.json`（保留备份）；已有 `config.json` 永远优先。Webhook 签名密钥只写不回显，页面仅显示「已配置」徽标。
- 中英文 UI，跟随「设置 → 通用 → 语言」；明暗主题使用 DSW 设计变量。
- 技术口径审计：quote/bar 使用 `goldboard-market-data-v2`，带 `sourceTimestamp/receivedAt/ingestedAt`、source delay/future skew、品种、市场、货币、单位、质量和 real/synthetic/proxy/unknown 执行证据；compact 北京时间、epoch 秒/毫秒和 ISO 时间统一规范化。XAU 与 USDCNY 任一 stale 或 point-in-time future 都禁止 fallback 新开仓和历史污染。所有自然时间聚合缺子 K 或包含 partial 子 K 时，父桶保持 partial 并排除在正式指标之外；XAU 现货与 `GC=F` 期货严格分开。
- 长期事实存储与源健康：`HistoricalStore` 按 CMB 交易日 append-only 保存 customer ask/bid、各侧来源和三类时间，稳定 event ID 去重并支持 as-of 查询；旧单边、手工和派生记录永久保留 proxy 身份。「数据」Tab 显示源成功率、连续失败时长、P50/P95、可用备用源、执行证据比例、最后有效时刻和缺口。旧 state 首次升级前原字节备份并生成 hash manifest；损坏 state/历史分区隔离，支持显式回滚。
- 公共接口：根入口只导出插件生命周期和稳定领域接口；`./market-data`、`./execution`、`./risk`、`./ledger`、`./history`、`./replay`、`./strategy`、`./experiments`、`./factors` 提供领域入口，parser、bar 变异器、存储原语和 fetch 替换 hook 仅位于 `./testing`。
- 模型分析（手动触发）：从 Harness 当前可用的 provider/model 目录选择模型和 reasoning effort，不改变当前会话模型；模型只解释宿主指标和规则 plan，不能补造价格或生成买卖指令。即使数据质量门控未通过也可手动调用，模型需以数据不足/过期/无效等状态说明限制。「分析」Tab 提供目录选择、「立即分析」和独立「查询日志」面板。
- 分析查询日志：每次真实模型调用生成 `queryId`，记录 started/finished 生命周期、模型、行情快照、质量状态、输入 hash、结构化结果、usage 和错误；日志写入 `$DSH_HOME/storages/dsh-plugin-goldboard/analysis-log.jsonl`，支持脱敏详情、筛选、游标分页和孤儿 running 查询恢复。
- ReplaySimulator 与长期验证（阶段 3 / report v6）：策略 adapter 只产生 decision，模拟器独立推进 pending/fill/expiry/replacement、执行账本和 mark；默认 `next-bar-limit` 不允许信号 K 自成交，未触价不成交，同 K 双触及按策略保留 `ambiguous/unknown` 或保守路径。显式 `asOf` 同时约束已收盘 frame 与历史记录的 source/ingested 时间；每份报告保存 dataset、input 和 report SHA-256 fingerprint。CMB 优先读取 `HistoricalStore` point-in-time 记录并保留 real/proxy/unknown 身份，滚动 bars 只是短窗 fallback。长期模式按月建立 6 个月训练 + 1 个月测试 folds，测试参数冻结，并按 fold 保存样本数与区间；报告同时列出暴露、资金使用率、turnover、profit factor、Sharpe/Sortino/Calmar、Wilson 胜率区间、seeded moving-block bootstrap 收益区间，以及不交易、买入持有、固定节奏定投、简单均线四类同执行口径基准。报告与 events/orders/fills/ledger/unexecuted 明细进入不可变有界 registry，可按 ID 跨重启查询；`replay-stats.json` 继续作为最近报告兼容投影。v4/v5 原样只读，不补字段、不重算。少于 12 个月、多折 OOS 未完成、存在 proxy/unknown、费用未核实、基准/区间不完整或 session 不完整时，Host 强制 `evidenceStatus:"exploratory"`；当前没有可据此调整真实仓位的验证结论。
- 策略实验层（阶段 4）：`StrategyRegistry` 注册固定 control 与 replay-only `orb-trend-pullback`；统一 evaluate interface 和显式 descriptor/adapter fingerprint 进入模拟输入。ORB 用 observing/armed/triggered/expired 状态机并记录 setup、regime 和压制原因；因子契约按 observation/release/first-available/vintage/tradable-after/ingested-at 做 point-in-time 选择，缺失或过期时统一 hold。独立实验报告展开 signal lane、成本倍率、参数倍率和消融场景，比较 control 并由 OOS/成本/基准证据 fail-closed 判定晋级；任何报告都不会修改 live control。XAU lane 在 XAU 与 USDCNY 历史不能共同证明时只返回 unavailable。

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
