# 阶段 2 实施计划：风险闸门与订单生命周期

> 状态：已随 v1.15.0 发布。基线为 v1.14.0；当前工作树已通过 273 项全量测试、全模块语法检查、pack dry-run、独立复审，以及 Web GUI 的中英文、明暗主题、桌面与 400px 窄屏探针。已安装的 Host 半需在下次 `dsh web` 重启后加载。本阶段不连接真实账户，不自动下单、撤单或修改真实持仓；`referenceEquityCny` 只是用户填写的风险计算基准，不代表真实账户余额。

## 1. 当前行为与目标行为差异

| 范围 | 当前行为 | 阶段 2 目标 |
| --- | --- | --- |
| 仓位模式 | 只按 `limits.maxGrams` 的轻仓/标准/重仓分档给出克数 | 默认保留 `fixed_grams`；可 opt-in `budget`，按每克最坏情景风险与可用预算计算克数 |
| 金额与流动性 | 没有名义金额上限或单笔流动性上限 | 正数配置启用 `maxAmountCny`、`liquidityCapGrams`，0 表示关闭对应约束 |
| 单笔风险 | 建议单不显示止损距离、最坏情景亏损或权益占比 | 每笔买入建议投影克数、名义金额、止损距离、每克风险、最坏情景亏损和参考权益占比 |
| 累计风险 | 没有日/周损失和回撤闸门 | 以本地可审计 ledger 的估算已实现亏损总额加当前浮亏为保守口径，盈利不抵消已消耗损失预算；达到日、周或回撤上限时禁止新增买入 |
| 连续亏损 | 不影响后续建议规模 | 达到配置的连续亏损次数后按确定性系数降档，并在建议中记录约束 |
| setup | 只有确认 streak、lane 和记忆时钟，没有稳定 setup 身份 | 同一方向、品种和连续条件复用稳定 `setupId`；条件结束、换道或换方向后关闭并新建 setup |
| decision | 重复轮询只靠信号 streak/cooldown，无法查询每次主动或受抑制决策 | 按 setup、已收盘信号 K、仓位与结果生成稳定 `decisionId`；重复轮询幂等 |
| 加仓约束 | 仓位上限与建议时冷却可限制部分重复信号 | 增加每 setup、每日最大加仓次数、最小价格改善和成交后 cooldown；状态跨重启恢复 |
| 订单轨迹 | 仅持久化一笔 `lastSuggestedOrder`，历史更新/到期/成交不可查询 | ledger 保存 pending、filled、expired、replaced；受闸门阻断的信号保存为 `not_executed` decision，绝不伪造 order/fill |
| 成交证据 | 持仓朝建议方向变化只用于清除 pending | 只有方向、唯一 pending 与克数精确匹配时才记录 `user_position_confirmation` 推断成交；金额不匹配或没有 pending 的持仓编辑只记 adjustment，不伪造订单 |
| UI | 只显示建议克数和固定风险提示 | 设置页编辑风险策略并显示 ledger 摘要；浮窗显示当前建议的风险拆分和阻断原因 |

## 2. 受影响文件与稳定接口

主要修改：

- `lib/config.js`：版本化 `risk` 配置、默认值、normalize、patch 白名单和 settings schema。
- 新增 `lib/risk.js`：纯 `RiskPolicy`，负责风险事实、闸门与受约束 sizing。
- 新增 `lib/signal-ledger.js`：setup、decision、order 与 position adjustment 的幂等 ledger。
- `lib/sizing.js`、`lib/plan.js`：保留 fixed-grams 兼容路径，将买入候选交给 `RiskPolicy`，投影 active/suppressed signals。
- `lib/alerts.js`、`lib/index.js`：在提醒生命周期旁记录同一订单 transition；配置持仓变化用于人工确认成交与成交后 cooldown。
- `lib/store.js`：state schema v3，迁移并恢复 ledger。
- `lib/snapshot.js`、`lib/routes.js`：风险/ledger 摘要和只读 `/dsh-plugin-goldboard/ledger` 查询。
- `lib/client.js`：双语风险设置、当前风险状态和建议风险明细。
- `lib/public-api.js`、`lib/testing.js`：公开稳定领域接口并暴露测试入口。

阶段 2 稳定接口：

```js
new RiskPolicy(config).evaluateBuy({
  action,
  fixedGrams,
  currentGrams,
  executableAsk,
  executableBid,
  atrPerGram,
  ledgerSummary,
  unrealizedPnlCny,
  suggestedPrice,
  asOf,
})

createSignalLedger()
normalizeSignalLedger(value)
reconcileLedgerPosition(ledger, { previousPosition, nextPosition, pendingOrder, config, asOf })
recordLedgerDecision(ledger, { plan, config, transition, asOf })
summarizeSignalLedger(ledger, { asOf, unrealizedPnlCny })
projectSignalLedger(ledger, { asOf, limit })
```

`RiskPolicy` 和 ledger 只计算本地建议与审计事实，不提供下单或账户同步接口。

## 3. 风险计算与 wire/schema 变化

风险配置版本为 `goldboard-risk-config-v1`，默认：

```js
risk: {
  version: "goldboard-risk-config-v1",
  mode: "fixed_grams",
  referenceEquityCny: 0,
  maxAmountCny: 0,
  maxRiskPerTradeCny: 0,
  maxDailyLossCny: 0,
  maxWeeklyLossCny: 0,
  maxDrawdownCny: 0,
  volatilityTarget: 0,
  liquidityCapGrams: 0,
  maxAddsPerSetup: 0,
  maxAddsPerDay: 0,
  minAddPriceImprovementPerGram: 0,
  consecutiveLossDeRisk: 0,
}
```

除 `version`、`mode` 外，0 表示关闭对应约束。`fixed_grams` 先产生与 v1.14 相同的分档克数，再取所有已启用约束的最小值；`budget` 需要至少一个可用的现金风险预算，并直接按风险预算计算上限。

预算事实采用保守、可审计口径：

```text
atrBuffer          = ATR(5m) × volatilityTarget
bidAskBuffer       = executableAsk - executableBid
slippageBuffer     = buySlippage + sellSlippage
stopDistance       = max(atrBuffer, bidAskBuffer, slippageBuffer)
executionCosts     = quotedSpread + buyFee + sellFee + buySlippage + sellSlippage
riskPerGram        = stopDistance + executionCosts
suggestedGrams     = floor_0.01(min(enabled gram/amount/risk/loss/liquidity constraints))
worstCaseLossCny   = suggestedGrams × riskPerGram
```

真实 bid/ask 的 quoted spread 只取自统一 `ExecutionModel`；风险计算中的 spread 是最坏情景预算项，不会改写执行现金流或重复加入成交价。

Additive wire 字段：

- snapshot 顶层新增 `riskConfigVersion`、`risk`、`ledger` 摘要。
- `plan` 新增 `setupId`、`decisionId`、`candidateAction`、`activeSignals`、`suppressedSignals`、`risk`。
- `suggestedOrder` 新增 `orderId`、`setupId`、`decisionId`、`nominalAmountCny`、`stopDistancePerGram`、`riskPerGram`、`worstCaseLossCny`、`riskBudgetRatio`、`riskPolicyVersion` 和约束列表。
- `/ledger` 返回版本、摘要及有界的 setups/decisions/orders/adjustments；受阻断信号只存在于 decisions，`orderId` 为 null。
- 现有 `lastSuggestedOrder` 和 snapshot `pendingOrder` 字段保留，并 additive 增加 ID 与风险字段。

## 4. 数据迁移、失败回退与兼容策略

1. `state.json` 升级为 schema v3；v1/v2 首次读取时先保存原始字节备份，再原子写入默认或规范化 ledger，并写 migration manifest。
2. v2 没有 ledger，迁移后 `lastObservedPositionGrams` 为 null；首次运行只建立持仓基线，不把旧持仓伪造成新成交。
3. ledger 损坏或字段超界时逐项清洗并截断；整个 state 损坏仍沿用隔离文件、空状态回退和告警策略。
4. setup、decision 和 order ID 由持久状态与确定性 fingerprint 生成；重复轮询同一已收盘 K 不追加记录。
5. pending 建议后的持仓变化只有在方向、唯一订单和克数（0.01 克容差）全部匹配时才把既有 order 标为 `filled`，证据固定为 `user_position_confirmation`；partial、超额、多 pending 或无 pending 的变化只写 adjustment。
6. 估算已实现损益只来自有已知建议价、原持仓成本与人工持仓确认的卖出；缺任一事实则保存 `null`，不补零。
7. 日/周损失按北京时间切分并累计负 PnL 的绝对值，后续盈利不恢复已消耗预算；drawdown 从 ledger 估算累计净损益峰值计算，并保守加入当前负浮盈亏。
8. 任一 ledger/risk 计算异常 fail-closed 为不新增买入；已有持仓估值、观察状态和所有保护性卖出继续可用。
9. `fixed_grams` + 全部新增闸门为 0 时，建议克数与 v1.14 行为一致。

## 5. 测试

单元测试覆盖：

- risk 配置默认、clamp、schema parity、未知字段 patch 与 0=关闭。
- fixed 模式兼容；budget 模式按 0.01 克向下取整。
- ATR、spread 或 slippage 上升时建议克数不增加。
- 最大克数、金额、单笔风险、日损、周损、回撤和流动性约束取最小值。
- 日/周/回撤闸门阻止买入但不阻止 `sell_stop` 等保护性退出。
- 连续亏损降档、每 setup/每日加仓、最小价格改善和成交后 cooldown。
- 相同 setup/decision 重复运行 ID 一致且数组不增长；换 bar、换道、方向结束产生正确状态变化。
- pending → filled/expired/replaced；受阻断 decision 为 not_executed 且没有虚假 order/fill。
- 人工持仓确认、无 pending adjustment、估算 PnL 和北京时间日/周汇总。
- state v2 → v3 备份/迁移、损坏 ledger 清洗、冷启动恢复。

集成测试覆盖：

- settings schema、classic `/config` 与 settings provider 都能保存/恢复 risk。
- plan/snapshot/ledger route 对同一 decision 的 ID、风险拆分和订单状态一致。
- 重启后 active setup、pending order、加仓计数、损失与 cooldown 一致。
- 固定 fixture 重复运行产生相同 decision/order fingerprint。

客户端测试覆盖：

- DICT 中英文 key 1:1，新增文案无硬编码语言残留。
- empty draft、settings diff/save 包含 `risk` section。
- fixed/budget 控件、0=关闭提示、风险摘要和建议风险明细可渲染。
- 中文/English 即时切换继续由 slot 的 `locale: NS` 驱动；新增样式只使用 DSW alias token。

## 6. 完成条件

- ATR、点差或滑点上升时，budget 建议克数不会增加。
- 任意买入建议不超过已启用的最大克数、金额、单笔风险和累计损失预算。
- 达到仓位、日/周损失、回撤或 add 上限时，candidate/decision 可查询，但不生成订单或 fill。
- 保护性卖出不受买入风险闸门阻断。
- 同一 setup 的重复轮询幂等，成交后 add 次数、价格改善和 cooldown 可审计。
- 冷启动恢复后的 ledger、pending order 与内存摘要一致。
- 现有全量测试、语法检查、pack dry-run 和 Web GUI 双语/主题探针通过。

## 7. 本阶段不纳入

- 不连接银行、券商或真实账户余额/成交回报。
- 不自动下单、撤单、止损或修改用户持仓。
- 不把 `referenceEquityCny`、ledger 估算损益或 position confirmation 称为真实账户事实。
- 不引入网格、马丁、自动摊平或新的默认策略参数。
- 不实现阶段 3 ReplaySimulator、OOS/walk-forward、长期绩效结论或基准比较。
- 不实现阶段 4 新策略/因子，也不启用阶段 5 LLM veto。
- 不在本开发任务中发布版本、创建 tag 或 GitHub Release。
