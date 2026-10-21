# 阶段 4 实施计划：策略实验层

> 状态：已随 v1.15.0 发布。基线为阶段 2 风险闸门/订单生命周期与阶段 3 ReplaySimulator/长期验证框架。阶段 4 只增加隔离的实验能力；live 默认策略继续固定为 `control`，候选策略、实验开关和任何晋级结论都不能隐式替换默认信号。

## 1. 当前行为与目标行为差异

| 范围 | 当前行为 | 阶段 4 目标 |
| --- | --- | --- |
| 策略接口 | live 直接调用 `computePlan(runtime, config, now)`；replay 使用私有 control adapter 回调 `computePlan` | 正式定义并校验 `strategy.evaluate({ marketFrame, portfolio, params, previousState })`；策略身份、状态、主动/压制信号和估值均可审计 |
| 策略选择 | 只有 control；`strategyId` 仅出现在 replay 报告 | 建立只读策略注册表；control 永久作为 live 默认，实验配置只决定哪些策略进入隔离回放 |
| 候选策略 | 无 | 增加 `orb-trend-pullback` 状态机，显式记录 `observing/armed/triggered/expired` 与压制原因，不采信外部项目收益自述 |
| 市场状态 | 无统一标签 | 用确定性规则标注 `trend/range/high_volatility/unknown`，保存版本和证据；HMM 仅保留为未运行的离线 benchmark 描述 |
| 因子 | 无 point-in-time 因子契约 | 规范化 observation period、release、first available、revision/vintage、tradable-after 和 expiry；缺失、过期或时间不明统一 `unknown` |
| 实验 | report v6 只运行单一 control | 展开策略、信号 lane、消融、参数敏感性和成本压力场景；场景账户、策略状态、订单和账本彼此隔离 |
| OOS 与晋级 | walk-forward 冻结当前 control 参数，但没有候选比较或晋级规则 | 报告所有尝试和未入选结果；只有完整 OOS、成本、lane、消融和基准矩阵均满足规则时才可标记 `eligible_to_apply`，且该标记仍不修改 live 配置 |
| UI | 只展示单策略 replay report v6 | 展示策略目录、实验开关、矩阵摘要、候选对 control 比较、失败场景和晋级阻断原因；所有文案双语并使用 DSW alias token |

## 2. 受影响文件与稳定接口

新增模块：

- `lib/strategy-contract.js`：策略 descriptor/evaluation 规范化、稳定身份和 fail-closed 校验。
- `lib/strategy-registry.js`：内建策略注册表、独立启停和 adapter 创建。
- `lib/strategy-control.js`：将现有 control 计划引擎适配到统一策略接口，保持 live/replay 规则口径一致。
- `lib/strategy-orb.js`：ORB/趋势回调实验状态机。
- `lib/market-regime.js`：趋势、震荡、高波动和 unknown 的可解释规则标签。
- `lib/factor-contract.js`：point-in-time 因子记录、vintage 选择和可交易时点校验。
- `lib/experiment-config.js`：无依赖的实验配置默认值、约束和规范化，避免 config/replay 初始化环。
- `lib/strategy-experiments.js`：场景展开、隔离执行、比较、消融、OOS 汇总、晋级判断和 Host engine。
- `lib/experiment-report.js`：独立 `goldboard-strategy-experiment-v1` wire 投影与 fingerprint。
- `lib/strategy.js`、`lib/experiments.js`、`lib/factors.js`：稳定领域子路径 facade。
- `test/stage4-strategy-foundations.test.mjs`、`test/stage4-strategy-experiments.test.mjs`：阶段 4 纯模块、反例、确定性、持久化和 replay 接线测试。
- `test/client-experiment-render.test.mjs`：真实 client factory 中实验面板的无 DOM 渲染测试。

修改模块：

- `lib/plan.js`：补齐 control 的 `strategyId`、信号语义 metadata 和稳定输出；不改变默认阈值。
- `lib/replay-simulator.js`：保存每次 evaluation 的 valuation/strategy state 事实，并让显式 adapter fingerprint 进入输入 fingerprint。
- `lib/replay-stats.js`：通过注册表创建 control/candidate adapter；提供实验运行所需的同源 frames、执行 adapter 和 OOS folds，不改变默认 `/replay-stats` 行为。
- `lib/config.js`：新增独立 `experiments` 配置段；旧 `strategy` 平面继续只属于 control。
- `lib/routes.js`、`lib/index.js`：新增只读目录与隔离实验 route；不增加下单入口。
- `lib/public-api.js`、`lib/testing.js`、`package.json`：增加 `./strategy`、`./experiments`、`./factors` 稳定子路径和打包清单。
- `lib/client.js`：设置页增加实验配置与报告比较；live 浮窗继续显示 control。
- `README.md`、`README-en.md`、`DESIGN.md`、`docs/optimization-roadmap.md`：同步阶段 4 的能力与限制。

稳定接口：

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

const registry = new StrategyRegistry()
registry.register(descriptor, factory)
registry.list({ enabledStrategyIds })
registry.create(strategyId, { enabledStrategyIds, createOptions })

normalizeFactorRecord(record)
selectFactorVintage(records, { factorId, asOf, maxAgeMs })
evaluateRequiredFactors({ requiredFactorIds, records, asOf, maxAgeMs })

runStrategyExperiment({
  config,
  strategyCatalog,
  executeScenario,
  asOf,
  days,
  mode,
  signal,
})

createStrategyExperimentEngine({ getConfig, listStrategies, executeScenario, file, writeQueue })
projectStrategyExperimentReport({ config, scenarios, generatedAt, asOf })
```

## 3. Wire/schema 变化

现有 report v4/v5/v6 保持只读兼容；阶段 4 使用独立实验报告，不把多策略语义塞进 v6：

```js
{
  version: 1,
  schema: "goldboard-strategy-experiment-v1",
  experimentId,
  experimentFingerprint,
  generatedAt,
  asOf,
  config,
  strategyCatalog,
  datasetRefs,
  scenarios,
  comparisons,
  ablations,
  sensitivity,
  oos,
  promotion,
  provenance,
}
```

每个 scenario 至少包含：

- `scenarioId`、`strategyId`、`strategyVersion`、`parameterFingerprint`；
- `signalLane` 与固定的 `executionInstrument: "CMB_ACCUMULATED_GOLD"`；
- `datasetId`、factor vintage/fingerprint；
- fill/ambiguity/cost/ablation 参数；
- simulation/report fingerprint、状态、metrics、diagnostics；
- market regime、active/suppressed/setup lifecycle 分组。

新增 route：

- `GET /dsh-plugin-goldboard/strategies`：返回注册表描述和当前实验启用状态。
- `GET /dsh-plugin-goldboard/strategy-experiments`：返回最近一次实验摘要。
- `POST /dsh-plugin-goldboard/strategy-experiments`：显式运行隔离实验；请求只接受已注册、已启用的候选和受限矩阵字段。

默认 `GET/POST /dsh-plugin-goldboard/replay-stats` 仍只运行 control，避免升级后行为变化。

## 4. 数据迁移、失败回退与兼容策略

1. `config.strategy` 保持原结构和默认值；新增 `config.experiments`，缺失时规范化为 disabled/control-only，因此旧 config/settings 无迁移写入也能保持原行为。
2. live `evaluateRuntimePlan()` 继续显式使用 control；实验报告中的 `eligible_to_apply` 只是一项审计结果，不写 config、不改 runtime 策略。
3. 策略状态全部经过 `previousState -> nextState`，每个 scenario 和 OOS fold 都从独立 clone 开始；候选不能共享 control 的 state、portfolio、orders 或 fills。
4. factor 必须满足 `tradableAfter >= firstAvailableTimestamp >= releaseTimestamp`，且 `tradableAfter <= asOf`；时间未知、过期、未来 release 或 revision 泄漏均返回 `unknown`，依赖它的策略只能 hold。
5. XAU lane 只有在 XAU 与 USDCNY 都具备 point-in-time 数据时才可运行；缺任一依赖时场景为 `unavailable`，不得用当前汇率回填历史。
6. strategy descriptor/version、参数、factor vintage、数据集、执行和场景配置全部进入 fingerprint；不依赖闭包函数源码作为唯一身份。
7. 单场景失败进入 diagnostics，不能投影成零收益；矩阵缺项会阻断晋级，但其他场景仍可读取。
8. 最近实验报告独立保存为 `strategy-experiment.json`，不进入 replay v6 registry；损坏或缺失时 GET 回退为空，不影响 snapshot、live control 或旧 replay 报告。

## 5. 测试

单元测试：

- 策略契约拒绝缺 identity、非法 evaluation 和输入 mutation；稳定输入重复运行结果一致。
- 注册表拒绝重复 id，disabled 策略不能由实验 runner 创建，control 默认始终存在。
- control adapter 与现有 `computePlan` 固定 fixture 逐字段一致。
- ORB 状态机覆盖 observing -> armed -> triggered、到期、跨 session 重置、同 setup 去重和重启状态恢复。
- 市场状态覆盖 trend/range/high-volatility/unknown 及阈值边界。
- factor 覆盖 release/firstAvailable/tradableAfter 顺序、vintage 选择、后续修订不泄漏、missing/stale/unknown fail-closed。
- 实验矩阵覆盖策略/lane/消融/参数/成本组合、账户隔离、取消、单场景失败、成本上升净结果不被错误改善。
- 晋级覆盖 OOS folds、基准、成本压力、lane、消融和区间任一缺失时 fail-closed。
- 固定 fixture 重复运行产生相同 scenario、simulation 和 experiment fingerprint。

集成测试：

- `/strategies` 只返回稳定目录，不泄漏函数或内部 state。
- `/strategy-experiments` 校验请求、disabled/unknown strategy、取消和错误 envelope。
- 实验运行不改变 snapshot 的 `plan.strategyId=control`、signal ledger 或配置。
- cold start 可读取最近实验摘要；损坏文件安全回退为空。

客户端测试：

- DICT 中英文 key 1:1；策略目录、场景表、晋级状态和阻断原因可渲染。
- 默认 disabled 明确显示候选不会影响 live；按钮只有显式启用候选后可运行。
- 主题使用 DSW alias，窄屏表格可横向滚动且无文本重叠。
- 中文/English 切换后实验区文本原位更新。

## 6. 完成条件

- control 与 ORB 候选均可在统一接口下独立回放、禁用和比较；live 永远保持 control。
- 每个候选 setup 有稳定生命周期、主动/压制信号和原因；相同输入不重复创建无界订单。
- CMB、Au99.99 以及具备完整 point-in-time XAU+USDCNY 证据的 XAU signal lane 均独立标记，并统一以 CMB 执行口径结算；不可用 lane 明确失败关闭。
- 因子缺失、过期、发布时间不明或未来修订一律 `hold/unknown`。
- 实验报告包含消融、参数敏感性、成本压力、OOS、基准比较和 promotion gate；不完整矩阵不得晋级。
- v4/v5/v6 读取与默认 `/replay-stats` 行为不变；全量测试、全模块语法检查、pack dry-run 和浏览器双语/主题探针通过。

## 7. 本阶段不纳入

- 不连接银行/券商，不自动下单、撤单、平仓或同步真实成交。
- 不根据实验报告自动替换 live 默认策略，也不调整 control 的 RSI、ATR、阈值或默认仓位。
- 不补造 XAU/USDCNY、DXY、TIPS、VIX/GVZ、ETF flow 或 carry 的历史发布时间和 vintage。
- 不把 HMM、ARIMA/SARIMA/GARCH、LSTM、Transformer、XGBoost 或 DRL 的库名当作已运行结果；没有统一 point-in-time 数据和训练 artifact 时仅登记 benchmark capability 为 unavailable。
- 不引入网格、马丁、黑盒 EA 或只按 RMSE 晋级的价格预测。
- 不在本任务中发布版本、创建 git tag 或 GitHub Release。
