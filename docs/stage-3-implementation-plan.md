# 阶段 3 实施计划：ReplaySimulator 与长期验证

> 状态：已随 v1.15.0 发布。基线为阶段 2；阶段 0/1 的 v4/v5 历史报告继续只读。阶段 3 已实现可复现模拟、point-in-time 数据集、walk-forward、report v6、不可变查询和双语 UI，并通过 307 项全量测试、全模块语法检查、pack dry-run 与独立复审。只有真实历史满足准入门槛时才可能输出 `validated`；当前本机数据不足不会被补齐、外推或包装成验证结果。

## 1. 当前行为与目标行为差异

| 范围 | 当前行为 | 阶段 3 目标 |
| --- | --- | --- |
| 回放接口 | `replay-stats.js` 同时负责策略推进、订单、成交、账户、聚合、缓存和文件写入 | `ReplaySimulator.run(...)` 只负责时间推进、pending/fill/expiry/replacement、执行账本和 mark；策略与执行均通过 adapter 注入 |
| 时点 | 内部测试可传 `now`，HTTP 不能显式传 `asOf`；缓存使用普通 JSON 字符串 | wire 支持显式 `asOf`；只消费 `asOf` 前已收盘且已摄取的数据；输入和报告使用规范化 SHA-256 fingerprint |
| 成交策略 | 固定 `next-bar-limit` 和保守双触及常量 | 默认仍为 `next-bar-limit`；其他策略仅作为明确标记的敏感性场景；OHLC 无法证明先后或队列时输出 `ambiguous/unknown`，不伪造部分成交 |
| 数据来源 | CMB 主路径使用内存滚动 bars，长期 quote store 只用于采集/状态 | 从 `HistoricalStore` 生成 point-in-time 数据集；每次报告保存分区 hash、时间范围、证据比例、schema 和 dataset fingerprint；滚动 bars 只作为短期 fallback |
| 持久化 | 单个 `replay-stats.json` 保存最近报告；独立事件不会跨重启保留 | versioned `ReplayReportStore` 保存有界报告索引和每份报告的 events/orders/fills/ledger/unexecuted；旧文件只读 fallback，不迁移重写 |
| 长期验证 | validation gate 永久写死为无长期历史、无 OOS、无基准和区间 | 6 个月训练 + 1 个月测试、按月滚动的 fold registry；每月至少 10 个时间/执行侧均完整的 session；测试账户与训练期仓位/订单隔离；每折冻结参数、样本、区间和 result fingerprint；数据不足时明确 `insufficient_data` |
| 指标 | fill/expiry、权益、回撤、turnover、profit factor 等基础值 | 增加暴露时间、资金使用率、回撤持续期、毛/净收益、费用/点差/滑点、Sharpe/Sortino/Calmar、Wilson 区间和确定性 block-bootstrap 区间 |
| 基准 | 无 | 同一数据和执行口径下报告不交易、买入持有、固定节奏定投和简单均线基准，基准结果不进入 control 策略账本 |
| UI | 只认识 report v5，展示短窗口诊断 | v6 展示 dataset/OOS/benchmark/区间和 validation gate；v4/v5 保持 legacy 只读；任何未满足门槛的报告都不能显示“已验证策略” |

## 2. 受影响文件与稳定接口

新增模块：

- `lib/replay-simulator.js`：通用 `ReplaySimulator`、fill policy、确定性事件/订单/成交账本。
- `lib/replay-dataset.js`：历史 quote 到自然时间 OHLC/bid/ask bars、dataset manifest 和 fingerprint。
- `lib/walk-forward.js`：月度 fold 构造、参数冻结和 OOS registry。
- `lib/replay-report.js`：v6 schema 投影、风险调整指标、置信区间、基准和 validation gate。
- `lib/replay-store.js`：有界报告注册表、原子持久化和按 `reportId` 查询。
- `test/stage3-replay-validation.test.mjs`：阶段 3 纯模块、集成和反例测试。

修改模块：

- `lib/replay-stats.js`：保留历史 helper/import surface，将连续账户执行和 v6 投影委托给新模块，并接入历史数据与报告存储。
- `lib/replay.js`、`lib/public-api.js`、`lib/testing.js`、`package.json`：导出稳定接口并打包新模块/计划。
- `lib/index.js`、`lib/routes.js`：注入 `HistoricalStore`/`ReplayReportStore`，支持 as-of、报告列表和按 ID 查询。
- `lib/client.js`：双语展示 v6 证据、数据集、OOS、指标、基准与区间。
- `README.md`、`README-en.md`、`DESIGN.md`、`docs/optimization-roadmap.md`：同步当前事实和未满足的数据门槛。

阶段 3 稳定接口：

```js
new ReplaySimulator().run({
  frames,
  strategy,
  execution,
  initialPortfolio,
  fillPolicy,
  ambiguityPolicy,
  asOf,
  params,
})

buildReplayDataset({ records, instrument, lane, asOf, dataSchemaVersion, calendarVersion })
buildWalkForwardFolds({ sessions, trainMonths: 6, testMonths: 1, asOf })
projectReplayReport({ simulation, dataset, oos, benchmarks, provenance, generatedAt })

new ReplayReportStore({ directory }).save(result)
ReplayReportStore.list({ limit })
ReplayReportStore.get(reportId, { detail })
```

`StrategyEngine` adapter 只返回 decision/valuation/nextState/activeSignals/suppressedSignals；`ReplaySimulator` 不复制策略规则。`ExecutionModel` 仍是唯一费用、滑点、bid/ask 和现金流 seam。

## 3. wire/schema 变化

新报告为 v6，additive 保留 v5 的主要摘要字段，并新增：

- `reportSchemaVersion`、`inputFingerprint`、`reportFingerprint`；
- `asOf`、`dataset` manifest、`dataVersion`；
- `simulation` policy/diagnostics；
- `metrics`：收益、风险调整、暴露、资金使用、turnover、成本和不确定性；
- `oos`：registry 版本、状态、窗口设置、folds、参数 fingerprint 和样本数；
- `benchmarks`：`no_trade`、`buy_and_hold`、`fixed_interval_dca`、`simple_moving_average`；
- `groups`：lane、执行标的、完整/部分 session、real/proxy/unknown 执行证据；
- `validationGate.observed`：历史月数、OOS fold 数、真实双边覆盖、成本语义、基准和区间状态。

HTTP 保留 `GET/POST /dsh-plugin-goldboard/replay-stats`：

- POST 新增可选 `asOf`、`mode`、`fillPolicy`、`ambiguityPolicy`；非法或未来 `asOf` 返回稳定错误 code。
- GET 新增 `reportId`；无 ID 时仍返回最近报告。
- 新增 `GET /dsh-plugin-goldboard/replay-reports?limit=` 返回有界索引，不返回大体积明细。

v4/v5 文件和报告不补字段、不重新计算 fingerprint、不投影为 v6，也不覆盖原文件。

## 4. 数据迁移、失败回退与兼容策略

1. `HistoricalStore.query(..., asOf)` 同时约束 source timestamp 与 `ingestedAt`；dataset builder 只接受该查询结果，再次拒绝未来/无效时间，并在聚合前用当前 instrument calendar 排除休市记录。
2. 自然 5m/60m bucket 只使用当时已知记录；缺 customer bid 的 bucket 保持 proxy/unknown，不补成 real。
3. 报告存储使用新目录和原子 index；损坏 index/报告只隔离或忽略对应项，GET 返回旧 `replay-stats.json` fallback，绝不因统计文件损坏拖垮 Host。
4. fingerprint 使用稳定 key 顺序，排除 `generatedAt`、`reportId` 等非语义字段；相同输入和 as-of 得到相同订单、成交、fold 和报告 fingerprint。
5. 默认行为仍为 `next-bar-limit`；敏感性 policy 必须写入 report，不能与默认结果合并。
6. partial session 只 mark-to-as-of，不产生 session-end return，也不进入 session-end/OOS 指标。
7. walk-forward 测试折只读取训练截止时已冻结的参数；测试月以零仓、无 pending、独立初始资金和新的策略状态开始，指标 context 可读取测试时点以前的已收盘 bars，但训练期成交/现金不带入；没有候选选择器时使用明确的 control 参数快照，不伪造优化过程。
8. 少于 12 个月、少于多个 OOS fold、真实双边不足、费用语义未核实、基准或区间缺失时，`evidenceStatus` 固定为 `exploratory`。
9. 任何单个 fold/benchmark 失败都进入 diagnostics；报告可读，但 validation gate fail-closed。

## 5. 测试

单元测试覆盖：

- `ReplaySimulator` 的 next-bar、未触价、到期、替换、库存上限、无部分成交和缺执行路径。
- 固定 `asOf` 排除未来 frame；相同乱序输入规范化后 fingerprint/订单/成交一致。
- 同 K 目标/止损在 unknown/conservative/best-case policy 下明确分离。
- 历史 quotes 聚合 5m/60m，real/proxy/unknown 身份和 manifest hash 稳定；迟到摄取不进入旧 as-of。
- 6+1 月按月滚动，训练/测试无重叠、测试参数冻结、边界月和不足数据。
- Sharpe/Sortino/Calmar、暴露、资金使用、profit factor、Wilson 和 seeded block-bootstrap 的空样本/单样本/确定性。
- 四个基准独立运行，不污染策略 ledger。
- report fingerprint 排除生成时间但包含数据、参数、policy 和版本。
- `ReplayReportStore` 冷启动查询、上限清理、损坏文件回退和旧报告只读。

集成测试覆盖：

- route 接收显式 as-of，POST/GET/list 和按 report ID 的详情在冷启动后一致。
- CMB 长期历史优先于滚动 fallback；无足够历史时 gate 明确保持 exploratory。
- partial session 只有 mark-to-as-of，不能进入 OOS session-end 样本。
- 固定 fixture 重复运行得到完全相同的 input/report fingerprint。

客户端测试覆盖：

- 中英文 DICT key 1:1；v6 dataset/OOS/benchmark/区间与不足证据提示可渲染。
- v4/v5 仍走 legacy 只读分支，不显示 v6 验证标签。
- 只有 `evidenceStatus=validated && validationGate.eligible=true` 才显示验证结果。
- 新样式只使用 DSW alias token，窄屏不溢出。

## 6. 完成条件

- 固定输入和 as-of 产生相同订单、fills、ledger、fold registry 和 report fingerprint。
- 策略在任一时点只看到已收盘、已摄取且不晚于 as-of 的 frame；未触价限价单不能成交。
- partial session 不进入 session-end/OOS 指标；real/proxy/unknown 分组可对账。
- 每个 OOS fold 显示训练/测试窗口、冻结参数 fingerprint、样本数和不确定性。
- v6 同时提供成本、成交、基准和敏感性事实；数据不足时 UI 不显示“已验证策略”。
- v4/v5 读取不改写，全量测试、全模块语法检查和 pack dry-run 通过。

## 7. 本阶段不纳入

- 不连接银行/券商，不自动下单、撤单、平仓或同步真实成交。
- 不补造缺失的 12-24 个月历史，不把 proxy 当作真实 bid/ask。
- 不调整 control 的 RSI、ATR、阈值、默认仓位或风险配置。
- 不新增阶段 4 候选策略、宏观因子、ML/DRL，也不进行参数挖掘。
- 不启用阶段 5 LLM veto，不在本任务中发布版本、创建 tag 或 GitHub Release。
