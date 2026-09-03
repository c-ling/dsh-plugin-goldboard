# dsh-plugin-goldboard 后续优化路线

> 状态：阶段 0 已于 v1.13.0 完成；阶段 1 数据与执行事实层随 v1.14.0 完成并发布；阶段 2-5 仍为规划概要。
>
> 研究依据：`dsh-other/docs/research/gold-trading-repos.md`《GitHub 黄金交易开源仓库调研：策略方案、自动化手段与量化方法》。当前工作区中该研究文件位于相邻仓库；本文件将其结论映射到 `dsh-plugin-goldboard`。
>
> 实施起点：`dsh-plugin-goldboard` v1.12.0；阶段 0 基线冻结随 v1.13.0 发布。当前实现是“行情看板 + 透明规则建议 + 本地回放诊断 + 手动 LLM 解释”，不是自动交易系统，也不构成投资建议。

## 1. 总目标

把插件逐步提升为：

- 数据来源、时间、品种和质量可追溯；
- 买卖报价、手续费、点差和滑点可逐项对账；
- 建议规模受明确的风险预算约束；
- 回放和实验可复现、无未来函数，并区分真实和代理数据；
- 模型只能解释或否决，不拥有开仓、定价和下单权限；
- 前端、测试、打包和发布链路具备持续验证能力。

不以增加指标数量或追逐某个开源仓库的自述收益为主要目标。研究文档显示，黄金开源项目中真正成熟的部分主要是数据工具、通用回测框架和风控工程，README 中的收益率、胜率和 Sharpe 通常缺少第三方核验。

## 2. 当前已具备能力

v1.12.0 已经实现：

- 新浪、上金所、东方财富、腾讯、60s API、gold-api、Yahoo、招商银行等行情适配和 fallback；
- Au99.99、XAU/USD、CMB 积存金、USDCNY 与 `GC=F` 期货的品种隔离；
- 1m/5m/15m/60m/日线缓存，已收盘 K 线、自然时间桶和 partial 桶处理；
- stale、未来时间戳、OHLC、覆盖率、预热、依赖和源间偏差质量检查；
- 真实 CMB bid/ask 与旧单边 proxy 的区分；
- `ExecutionModel` 统一处理 ask、bid、显式费用和滑点；
- replay report v5，包括 pending limit、fill/expiry、双触及、权益曲线、回撤和未执行信号；
- 信号确认、同向 cooldown、信号道粘滞、仓位上限和告警生命周期；
- 系统通知、Webhook 及通用 Webhook 的 Host 侧 SSRF 防护；
- 手动模型分析、输出 schema 校验、超时、取消、缓存和脱敏审计日志；
- 双语设置页、浮窗和基础统计视图。

这些能力改善了工程可靠性，但不等于已经完成长期样本外验证、真实成交验证或风险调整后的策略验证。

## 3. 阶段依赖

```text
阶段 0  证据与口径冻结
   |
   v
阶段 1  数据与执行事实层
   |
   v
阶段 2  风险闸门与订单生命周期
   |
   v
阶段 3  ReplaySimulator 与长期验证
   |
   v
阶段 4  策略实验层
   |
   v
阶段 5  AI、前端与运维工程化
```

阶段 1 的长期数据采集应尽早启动，但阶段 3 的 OOS（样本外）验证必须等待足够历史和双边覆盖。阶段 5 的 CI、文档和基础浏览器测试可以提前并行建设。

---

## 阶段 0：证据与口径冻结

### 目标

建立不可变的 baseline，先保证用户不会把模拟数字理解成真实业绩或可执行成交结果。

### 主要工作

- 为策略、指标算法、数据 schema、执行账本、交易日历和 replay 报告建立版本字段。
- 统一 `README.md`、`README-en.md`、`DESIGN.md`、策略说明页和设置页中的 v1.12 事实。
- 统一标注“5 分钟模拟诊断”“真实/代理双边覆盖率”“完整/部分交易日”“成本假设”和“非投资建议”。
- 保留 v4/v5 报告只读能力；旧报告不补字段、不重算成新口径、不投影为真实业绩。
- 定义“探索性诊断”和“验证结果”两种状态，以及后续阶段的进入门槛。
- 记录当前策略为 control，不在本阶段修改 RSI、ATR、阈值或默认仓位。

### 涉及范围

`README.md`、`README-en.md`、`DESIGN.md`、`docs/v1.11.0-strategy-optimization.md`、`lib/client.js`、`lib/replay-stats.js`、`package.json`。

### 产出

- baseline 说明；
- 版本字段和报告标记约定；
- 统计免责声明和验证准入规则；
- 文档/前端口径差异清单。

### 完成标准

- 每份报告显示生成时间、数据窗口、lane、执行口径、成本假设和 caveat；
- UI、README 和导出内容不把 v4/v5 或短样本数字称为真实业绩；
- 固定 fixture 重复运行结果一致；
- 当前测试和语法检查继续通过。

### 不做

不增加新数据源、不增加新指标、不调整默认策略、不引入自动交易。

---

## 阶段 1：数据与执行事实层

### 目标

让 live、snapshot、replay 和 UI 对同一份行情与成本事实使用相同定义，且每个数字都能追溯来源。

### 主要工作

#### 1.1 版本化市场数据契约

在 `lib/parsers.js`、`lib/market-quality.js` 和 `lib/bars.js` 统一 quote/bar 结构，至少包含：

- `instrument`、`market`、`currency`、`unit`；
- `source`、`sourceTimestamp`、`receivedAt`、`ingestedAt`；
- `sourceDelayMs`、`futureSkewMs`；
- `quality`、`synthetic`、`executionSideComplete`；
- customer bid/ask 及其来源。

XAU 换算必须同时检查 XAU 和 USDCNY。CMB fallback 必须携带校准样本数、时间范围和校准来源。

#### 1.2 完整质量事实

把现有 coverage 比例扩展为：

- `coverageRatio`；
- `effectiveSampleMinutes`；
- `largestGapMinutes`；
- `minutesSinceLastGap`；
- `reanchored`；
- `missingBuckets`；
- 每个依赖的 stale/future/quality 详情。

重锚后的短片段不能只显示为“100% 完整”。自然时间桶缺子 K 时标记 `partial`，不得进入正式指标和完整时段统计。

#### 1.3 独立交易日历

为 CMB、SGE/Au99.99 和 XAU/USD 分别建立 calendar adapter。当前工作日 09:00 至次日 02:00 的配置只作为 CMB 提醒规则，不能作为所有品种的正式交易事实。报告保存 `calendarVersion`。

#### 1.4 长期双边历史

保留 `state.json` 的滚动运行缓存，并增加 `HistoricalStore` seam。默认实现按交易日追加保存 CMB customer bid/ask、来源、采集时间和延迟。旧单边 CMB bar、手工补录和固定 spread 代理始终保持 `proxy` 身份。

数据源状态增加：

- 成功率和连续失败时长；
- P50/P95 延迟；
- 实际可用备用源数量；
- 真实双边、synthetic 和 proxy 比例；
- 最后有效时刻和缺口列表。

#### 1.5 唯一执行账本

继续以 `lib/execution.js` 作为唯一成本 seam：

```text
buyCost      = executableAsk + explicitBuyFee + buySlippage
sellProceeds = executableBid - explicitSellFee - sellSlippage
pnl          = sellProceeds - buyCost
```

先用招商银行正式产品协议确认：

- 报价内 bid/ask 点差；
- 报价外显式费用；
- fallback 估算点差；
- 回放滑点。

在语义未确认前，报告必须显示假设来源。真实双边不重复加估算 spread；缺 bid/ask 返回 `null + reasonCode`，绝不补零。

#### 1.6 收紧公共接口

`lib/public-api.js` 根入口只保留稳定的领域接口。测试 hook（例如 fetch 替换）移动到 `./testing` 或内部测试入口，避免把实现细节变成长期兼容承诺。

### 涉及范围

`lib/parsers.js`、`lib/market-quality.js`、`lib/market-time.js`、`lib/bars.js`、`lib/history.js`、`lib/store.js`、`lib/sources.js`、`lib/execution.js`、`lib/public-api.js`。

### 产出

- data schema v2；
- 长期历史存储和迁移策略；
- 完整质量投影；
- 独立日历版本；
- 统一成本组件；
- 真实双边覆盖报告。

### 完成标准

- live/fallback/replay/snapshot 对同一输入产生一致的现金流和成本拆分；
- 旧单边数据在所有报告中明确为 proxy；
- compact、epoch 秒/毫秒、ISO、future 时间戳均有一致结果；
- XAU 或 USDCNY 任一关键依赖 stale 时禁止新开仓；
- 损坏旧状态可读取、迁移、备份和回滚；
- 长期采集开始持续产生可复用的 point-in-time 数据。

### 依赖与风险

依赖招商银行协议确认和持续采样。免费源没有稳定 SLA，任何源成功都不能替代质量记录。

---

## 阶段 2：风险闸门与订单生命周期

### 目标

在不连接真实账户的前提下，让建议规模反映风险，并阻止重复信号导致无界加仓。

### 主要工作

#### 2.1 可选风险预算

在 `lib/config.js` 和 settings schema 增加版本化 `risk` 配置。为保持升级兼容：

- 默认 `mode: "fixed_grams"`；
- `mode: "budget"` 初期 opt-in；
- 数值为 0 表示对应闸门关闭；
- 不把用户手工填写的参考权益称为真实账户余额。

建议字段：

- `referenceEquityCny`；
- `maxAmountCny`；
- `maxRiskPerTradeCny`；
- `maxDailyLossCny`；
- `maxWeeklyLossCny`；
- `maxDrawdownCny`；
- `volatilityTarget`；
- `liquidityCapGrams`；
- `maxAddsPerSetup`；
- `maxAddsPerDay`；
- `consecutiveLossDeRisk`。

预算模式计算：

```text
stopDistance       = max(ATR × k, bidAskBuffer, slippageBuffer)
riskPerGram        = stopDistance + executionCosts
suggestedGrams     = floor(availableRiskBudget / riskPerGram)
```

建议单显示克数、名义金额、止损距离、最坏情景亏损和风险预算占比。克数、金额、仓位和风险预算取最小约束。

#### 2.2 风险闸门行为

当日、当周或回撤闸门触发时：

- 禁止新增买入；
- 仍允许展示观察状态；
- 仍允许生成保护性退出参考；
- 不创建虚假 order/fill。

#### 2.3 setup 和 signal ledger

为每个 setup/decision 生成稳定的 `setupId`/`decisionId`，记录：

- active signals；
- suppressed signals；
- 阻断原因；
- 当时仓位、金额和风险预算；
- pending、filled、expired、replaced、not-executed 状态。

同一 setup 的最大加仓次数、单日加仓次数、最小价格改善和成交后 cooldown 都必须可审计，并在重启后恢复。

### 涉及范围

`lib/config.js`、`lib/sizing.js`、`lib/plan.js`、`lib/alerts.js`、`lib/store.js`、设置页客户端。

### 产出

- `RiskPolicy`；
- 风险配置 schema；
- setup/signals ledger；
- 受约束的 sizing；
- 完整订单状态轨迹。

### 完成标准

- ATR、点差或滑点上升时，预算模式建议克数不会增加；
- 任意建议不超过最大克数、金额、单笔风险和累计损失预算；
- 达到仓位或风险上限的信号仍可查询，但不会生成虚假订单；
- 保护性卖出不被买入闸门阻塞；
- 相同 setup 不会因轮询重复创建无界加仓；
- 冷启动后 ledger 与内存状态一致。

### 不做

不自动平仓、不同步银行成交、不自动修改真实持仓、不引入网格或马丁。

---

## 阶段 3：ReplaySimulator 与长期验证

### 目标

将 replay 从短窗口诊断升级为可复现、无未来函数、能表达成交不确定性的验证框架。

### 主要工作

#### 3.1 抽离回放接口

从 `lib/replay-stats.js` 抽出时间推进、订单状态、账本和报告投影。建议接口：

```js
replay.run({
  frames,
  strategy,
  execution,
  initialPortfolio,
  fillPolicy,
  ambiguityPolicy,
}) => {
  orders,
  fills,
  ledger,
  equityCurve,
  metrics,
  diagnostics,
}
```

`StrategyEngine` 只产生决策；`ReplaySimulator` 负责 pending、fill、expiry、replacement、ledger 和 mark。

#### 3.2 成交与时点策略

- 默认继续使用 `next-bar-limit`；
- `next-open`、30/60/120 秒延迟和信号收盘成交只作为敏感性场景；
- 无 1m/tick 证据时不伪造队列位置、先后顺序或部分成交；
- 5m OHLC 同时触及目标/止损时标记 `ambiguous/unknown`；
- 支持显式 `asOf`；部分日只能 mark-to-as-of，不进入 session-end 指标；
- 独立事件、订单、fills、未执行信号、输入 fingerprint 和数据版本全部可跨重启查询。

#### 3.3 长期 walk-forward

数据准备至少覆盖 12 个月，目标 24 个月。采用：

- 6 个月训练窗口；
- 随后 1 个月测试窗口；
- 按月滚动；
- 测试折参数冻结；
- 记录候选参数空间、试验次数、数据版本和未入选结果。

#### 3.4 报告指标

按 OOS fold、lane、执行标的、完整/部分日、真实/代理双边路径分组报告：

- fill、expiry、replace、ambiguous；
- 平均延迟和双边覆盖率；
- equity curve、最大回撤及持续期；
- 暴露时间、资金使用率、turnover、profit factor；
- 毛收益、显式费用、报价点差和滑点；
- Sharpe、Sortino、Calmar；
- 胜率 Wilson 区间和收益 block-bootstrap 区间；
- 不交易、买入持有、固定节奏定投和简单均线基准。

`ruleScore` 只表示规则强度，不表示概率。数据不足、代理比例过高或样本外条件不满足时，只显示探索性诊断。

### 涉及范围

`lib/replay-stats.js`、新增 replay/report 模块、`lib/routes.js`、`lib/client.js`、长期历史存储模块。

### 产出

- `ReplaySimulator` interface；
- 数据集 manifest；
- OOS fold registry；
- 报告 schema；
- 成本、成交和基准敏感性报告。

### 完成标准

- 固定输入和 as-of 可得到相同订单、成交和报告 fingerprint；
- 不存在 lookahead；未触价限价单不能成交；partial session 不进入 session-end；
- real bid/ask、proxy 和 unknown 分开统计；
- 每个 OOS fold 参数冻结且显示样本数与不确定性；
- 没有足够证据时 UI 不显示“已验证策略”。

### 依赖与风险

依赖阶段 1 的长期采集和双边覆盖。短期内可能只有诊断结果，不应据此调整真实仓位。

---

## 阶段 4：策略实验层

### 目标

在统一执行账本和统一验证框架下比较候选策略，不把未经验证的开源范式直接变成默认信号。

### 主要工作

#### 4.1 统一策略 interface

```js
strategy.evaluate({
  marketFrame,
  portfolio,
  params,
  previousState,
}) => ({
  decision,
  valuation,
  nextState,
  activeSignals,
  suppressedSignals,
})
```

所有策略都使用同一 CMB bid/ask 执行账本；信号源和执行标的分开报告。

#### 4.2 实验顺序

1. **当前趋势回调作为 control**：保留现有 EMA、RSI、支撑/布林、ATR 规则；明确“状态条件”还是“crossing trigger”，统一使用 `ruleScore`。
2. **ORB/趋势回调状态机**：借鉴 `GOLD_ORB` 和 Backtrader pullback 的状态机结构，设置独立 `strategyId`、armed/triggered/expired 状态，不采信其自述收益。
3. **可解释市场状态**：先做趋势、震荡、高波动三态规则标签；HMM 只作离线对照。
4. **跨市场因子**：按数据可得性研究 XAU、USDCNY、国内 premium、金银比、DXY、TIPS/实际利率、VIX/GVZ、ETF 流量和期货期限结构/carry。
5. **ML/DRL benchmark**：先建立 ARIMA/SARIMA/GARCH 统计基线，再与 LSTM、Transformer、XGBoost、DRL 在相同 walk-forward 和成本模型下比较。

每个宏观或外部因子必须保存：

- observation period；
- release timestamp；
- first available timestamp；
- revision/vintage；
- tradable-after timestamp。

#### 4.3 晋级规则

每个策略必须通过消融、参数敏感性、成本压力、不同 signal lane 和 CMB 执行矩阵。只有跨多个 OOS fold、成本场景和基准比较仍稳定的策略，才允许申请进入默认候选；实验代码不能隐式替换默认策略。

### 涉及范围

`lib/plan.js`、`lib/indicators.js`、新增策略/因子模块、`lib/replay-stats.js`、报告和设置 UI。

### 产出

- 策略注册表；
- 实验配置；
- 因子数据契约；
- 消融和 OOS 报告；
- 默认策略晋级规则。

### 完成标准

- 每个策略可独立重放、关闭和比较；
- 每个 setup 有生命周期和压制原因；
- CMB、XAU、Au99.99 信号在同一执行账本下独立统计；
- 缺失、过期或时间戳不明的因子回退为 `hold/unknown`；
- 未通过 OOS 的策略不影响默认信号。

### 明确排除

网格、马丁、黑盒 EA、只按 RMSE 评价的价格预测，以及没有点时数据的宏观回放。

---

## 阶段 5：AI、前端与运维工程化

### 目标

在核心事实和验证接口稳定后，完善人机协作、可观测性、可维护性和发布可靠性。

### 主要工作

#### 5.1 LLM 解释与否决门

保留 `lib/analysis.js` 当前的约束：模型不能造价、造新闻、造成本、生成买卖指令或创建订单。

可增加 opt-in 的 `analysis.mode: "explain" | "veto"`：

- 量化策略先产生候选；
- LLM 只能返回 `pass/veto/unknown`；
- `unknown`、上下文 stale、宏观数据缺失或模型超时均 fail-closed 为 `hold/manual_review`；
- 模型不能调阈值、改执行账本或改变建议价格/克数；
- 审计记录 prompt/schema/model 版本、因子时间戳、输入 fingerprint 和门控结果。

默认仍使用 `explain`，不把 LLM 变成开仓权威。

#### 5.2 客户端内部拆分

保持最终 factory-CJS 加载契约不变，在源码层抽出：

- `GoldboardApi`：请求、错误信封、取消和重试；
- `SettingsAdapter`：settingsScope 与 `/config` fallback；
- `SnapshotStore`：轮询、可见性、离线和 snapshot 版本；
- `ChartModel`：跨午夜交易日轴、缺口和质量；
- `StatsViewModel`：v4/v5/OOS/成本/风险投影。

UI 清晰区分：

- signal price；
- CMB executable bid/ask；
- 成本后价格；
- data quality；
- risk budget；
- proxy 比例；
- 报告生成时间；
- OOS 和 benchmark 标签。

增加 JSON/CSV 导出、报告对比和数据缺口可视化，但不增加下单入口。

#### 5.3 CI、打包与浏览器验证

补充：

- `node --check`；
- `node --test`；
- `pack --dry-run`；
- 干净环境安装 smoke test；
- snapshot/models/replay-stats/client bundle 探针；
- Chrome CDP 浏览器测试。

浏览器测试覆盖浮窗、设置保存、统计详情、加载/离线/错误态、中文与 English 即时切换、明暗主题、窄屏布局、HMR 和卸载后的 CSS/事件清理。

发布时核对：

- package 版本；
- README 安装 pin；
- 双语 README 和当前策略文档；
- git tag；
- GitHub Release；
- 发布包内容；
- 不包含 `node_modules` 和临时文件。

### 涉及范围

`lib/analysis.js`、`lib/analysis-log.js`、`lib/client.js`、`package.json`、`test/client-*.mjs`、新增 `.github/workflows/`。

### 产出

- 可选 LLM veto gate；
- 可测试的客户端内部模块；
- 数据/报告操作台；
- CI、打包和发布验收链路。

### 完成标准

- LLM 永远不能产生订单、价格或无时间戳约束的宏观事实；
- 客户端测试不再依赖源码字符串截取；
- 真实浏览器验证双语、主题、窄屏和错误态；
- 干净环境可安装并加载 factory bundle；
- tag、Release、package 版本和 README pin 一致。

---

## 4. 目标数据流与公共接口

最终数据流：

```text
Source adapters
  -> MarketDataGateway
  -> normalized MarketFrame + dependency quality
  -> StrategyEngine
  -> Decision + PortfolioValuation + nextState
  -> OrderTracker
  -> ReplaySimulator
  -> ReportProjector / SnapshotProjector / UI
```

建议逐步稳定以下 interface：

- `MarketDataGateway.getFrame({ asOf, instruments })`：返回规范化价格、bars、来源和质量；
- `ExecutionModel.quote/accountExecution/valuePosition`：返回可执行价、成本组件、质量和 reason code；
- `StrategyEngine.evaluate(...)`：纯函数返回决策、估值、下一状态和主动/压制信号；
- `ReplaySimulator.run(...)`：注入 strategy/execution adapter，返回订单、成交、账本和统计；
- `ReportProjector`：将内部结果映射为 versioned wire schema。

wire 变化遵循 additive 优先，考虑新增：

- `dataSchemaVersion`；
- `strategyVersion`；
- `calendarVersion`；
- `dataQuality`；
- `costBreakdown`；
- `risk`；
- `oos`；
- `benchmark`。

v4/v5 报告继续只读；旧 state、旧 settings 和旧单边 bars 迁移必须保留备份和原始身份，不补零、不静默重解释。

## 5. 每个阶段的测试基线

### 数据与时间

覆盖 compact、epoch 秒/毫秒、ISO、未来时间、跨午夜、独立日历、自然桶、partial 桶、重复/乱序、断点重锚和复合依赖 stale。

### 执行与风险

覆盖真实 bid/ask 不重复收费、fallback 非对称 offset、费用逐项相加、缺 bid 返回 null、最大亏损触发、ATR/点差上升时建议规模下降、日/周/回撤闸门和保护性退出例外。

### 策略与生命周期

覆盖状态条件和 crossing trigger 语义、setup 去重、active/suppressed 原因、signal lane 切换、确认状态、cooldown 和成交后的状态恢复。

### Replay 与统计

覆盖未触价不成交、到期/替换/部分成交能力边界、同 K 双触及、完整日/partial 日、固定 as-of 无 lookahead、冷启动与内存详情一致、报告 fingerprint、OOS 参数冻结、基准独立和置信区间。

### 宿主与客户端

覆盖统一错误 envelope、配置迁移、损坏存储、settings 只读、Webhook SSRF、取消、重启恢复、浮窗、设置、统计、双语、主题和窄屏布局。

每个阶段都必须保持当前 224 个测试通过，并为新增行为补充至少一个最小反例 fixture 和一个确定性重复运行测试。

## 6. 明确不做

- 不接银行/券商 API；
- 不自动下单或自动修改真实持仓；
- 不把 LLM 输出变成 buy/sell 权限；
- 不把未带发布时间的数据用于历史回放；
- 不引入网格、马丁或“稳定盈利”模式；
- 不运行来源不明仓库的远程 PowerShell 管道脚本、二进制或黑盒 EA；
- 不在真实双边历史、费用语义和 OOS 框架完成前调整默认 RSI/ATR 或宣称策略有效。

## 7. 逐阶段实施模板

后续开始实现任一阶段时，先单独生成该阶段的实施计划，至少包含：

1. 当前行为与目标行为差异表；
2. 受影响文件和稳定 interface；
3. wire/schema 变化；
4. 数据迁移、失败回退和兼容策略；
5. 单元、集成和浏览器测试；
6. 完成条件；
7. 明确不纳入本阶段的事项。

推荐顺序：阶段 0 → 阶段 1 → 阶段 2 → 阶段 3 → 阶段 4 → 阶段 5。阶段 1 完成后应让历史采集持续运行；在阶段 3 的 OOS 框架和数据门槛完成前，不推进默认策略替换或真实仓位决策。