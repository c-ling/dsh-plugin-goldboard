# 阶段 1 实施计划：数据与执行事实层

> 状态：已随 v1.14.0 完成实现、自动化测试与发布。基线为 v1.13.0；本阶段未改变默认 RSI、ATR、仓位或提醒策略，也未引入自动交易。

## 1. 当前行为与目标行为差异

| 范围 | 当前行为 | 阶段 1 目标 |
| --- | --- | --- |
| 市场数据契约 | quote 与 bar 只有部分来源、时间和双边字段；replay 单独写死 data schema v1 | 统一 `goldboard-market-data-v2`，记录品种、来源、三类时间、延迟、质量、synthetic 和执行侧证据 |
| XAU 换算 | plan 的质量门检查 XAU/USDCNY，但 fallback、回填和校准只检查数值 | 所有路径调用同一换算质量接口；任一依赖 stale/future 时返回 `null + reasonCodes` |
| 覆盖质量 | 只投影比例；重锚后的短片段可显示 100% | 保留比例兼容字段，并增加有效分钟、最大缺口、距最近缺口、重锚和缺失桶 |
| 自然时间桶 | 10m/30m resample 标记 partial；60m seed 和手工聚合可能把缺子 K 的桶当完整 | 所有聚合路径写 `sampleCount/expectedSamples/partial`；partial 不进入正式指标 |
| 日历 | CMB 配置时段被 AU、XAU、历史和 replay 共用 | CMB、SGE/Au99.99、XAU/USD 使用独立版本化 adapter；CMB 配置只保留提醒语义 |
| 长期历史 | CMB 双边只存在滚动 `state.json` bar 中 | 新增按交易日 append-only `HistoricalStore`，持续保存 point-in-time customer ask/bid 和来源时间 |
| 状态迁移 | JSON 损坏静默回退；仅有 bars seed 迁移 | state schema v2；迁移前备份；损坏文件隔离；提供显式回滚函数；旧数据身份不升级 |
| 源健康 | 只有最近状态、时延和日志数 | 增加成功率、连续失败、P50/P95、可用备用源、最后有效时刻和历史执行证据比例/缺口 |
| 执行账本 | 费用主体已集中，但证据枚举和缺侧原因不完整；proxy 假设散落在 replay | `ExecutionModel` 统一 quote/bar/account/value，稳定输出 real/synthetic/proxy/unknown 和假设来源 |
| 公共接口 | 根入口导出 parser、存储、变异器和全局测试 hook | 根入口只导出插件与稳定领域接口；内部兼容面迁至 `./testing` |

## 2. 受影响文件与稳定接口

主要修改：

- `lib/market-quality.js`：`MARKET_DATA_SCHEMA_VERSION`、quote/bar v2、依赖质量、XAU 换算质量。
- `lib/market-time.js`：`TradingCalendarRegistry`、CMB/SGE/XAU adapter、完整 coverage inspector。
- `lib/bars.js`、`lib/indicators.js`：partial 与执行证据的保守聚合。
- `lib/history.js`、`lib/store.js`：`HistoricalStore`、state v2 迁移/备份/隔离/回滚。
- `lib/sources.js`：滚动健康统计与实际备用源数量。
- `lib/execution.js`：`ExecutionModel` facade、稳定证据枚举、缺侧 reason code。
- `lib/index.js`、`lib/snapshot.js`、`lib/replay-stats.js`：组合根双写与统一版本/质量投影。
- `lib/public-api.js`、新增 `lib/testing.js`、`package.json`：稳定入口与测试入口。

阶段 1 稳定接口：

```js
MarketDataContract.normalizeQuote(key, quote, receivedAt, ingestedAt)
MarketDataContract.normalizeBar(bar, metadata)
inspectXauConversion({ xau, usdcny, asOf })
inspectWindowCoverage(bars, asOf, minutes, calendar)
getTradingCalendar(instrument, config)
HistoricalStore.appendQuote(record)
HistoricalStore.query({ instrument, from, to, asOf })
HistoricalStore.getManifest()
ExecutionModel.quote/accountExecution/valuePosition
```

旧的 parser、bar 变异器、存储原语和 fetch hook 不再属于根入口兼容承诺；仓库测试从 `lib/testing.js` 使用它们。

## 3. Wire / schema 变化

变化采用 additive 优先：

- 新增 `dataSchemaVersion: "goldboard-market-data-v2"`。
- quote/bar 新增 `ingestedAt`、`sourceDelayMs`、`futureSkewMs`、`synthetic`、`executionSideComplete`、`executionEvidence`。
- CMB 新增 canonical `customerAsk/customerBid` 及各自 source；保留 `customerBuy/customerSell`、`buyPrice/sellPrice`。
- `coverage` 的数字 map 保留；新增 `coverageDetails`。
- snapshot 新增顶层版本与 `calendars`、长期历史状态。
- 新 replay report 使用 schema v2 和实际 lane 对应 calendar version；落盘旧 v4/v5 不补字段、不重算。
- 执行结果新增 `evidence: real | synthetic | proxy | unknown` 与 `assumptions`；现有字段保留。

## 4. 数据迁移、失败回退与兼容策略

1. `state.json` 继续保存热缓存，保证旧二进制可回滚；新增 `stateSchemaVersion: 2`，不删除旧字段。
2. 首次读取旧 schema 时，在同目录生成只读备份与 migration manifest；迁移失败不覆盖源文件。
3. JSON 损坏时原文件重命名为 `.corrupt-<timestamp>.bak` 并告警，运行时回退空状态。
4. `rollbackStateMigration()` 可从备份恢复；历史目录不随回滚删除。
5. `HistoricalStore` 与热缓存双写。按稳定 `eventId` 去重，查询按 source time 排序，并用 `ingestedAt <= asOf` 保证 point-in-time。
6. 旧单边、手工和 XAU+FX 派生记录始终为 proxy/synthetic；不补造历史 bid，不升级为 real。
7. 单个损坏历史分区被隔离，其他交易日仍可查询；JSONL 撕裂尾行跳过并写入健康状态。
8. v4/v5 replay 文件保持 byte-for-byte 只读；新执行语义只作用于新生成报告。

## 5. 测试

单元测试覆盖：

- compact、epoch 秒/毫秒、ISO、future 时间戳的 v2 一致性。
- XAU 或 USDCNY stale/future 时所有换算入口一致拒绝。
- coverage 全部事实、重锚短片段、重复/乱序、缺失桶。
- SGE 午休、XAU 24x5、CMB 跨午夜和独立版本。
- 缺子 K 的 60m/手工桶为 partial，且不进入正式指标。
- real/synthetic/proxy/unknown 证据与缺 ask/bid reason code。
- HistoricalStore 跨日、跨午夜、幂等、并发、as-of、损坏尾行和 manifest。
- state 迁移备份、损坏隔离和回滚。
- 源成功率、连续失败、P50/P95、备用源和覆盖分类。
- 根入口白名单与 `./testing` hook 隔离。

集成测试覆盖：

- apply 冷启动迁移、长期双写、dispose drain。
- snapshot/replay schema 与 calendar 版本。
- live/fallback/replay 对同一输入的成本组件一致。
- 固定 fixture 重复运行结果一致。

浏览器验证：

- 现有 GUI 载入 factory bundle，无 runtime exception。
- 浮窗、设置页、统计页仍能打开；中英文切换和明暗主题不回归。
- 本阶段不新增下单入口或新的营销说明 UI。

## 6. 完成条件

- live、snapshot、fallback、replay 使用同一 quote/bar、换算和执行定义。
- 旧单边数据在新记录和新报告中明确为 proxy；缺侧不补零。
- XAU/USDCNY 任一关键依赖 stale/future 时禁止新增买入与 fallback 历史污染。
- 三类 calendar adapter 独立且报告保存实际版本。
- 损坏/旧 state 有备份、隔离、迁移和回滚路径。
- 长期 CMB 双边 point-in-time 分区持续产生，状态页可审计覆盖与缺口。
- 当前测试、语法检查、pack dry-run 和 Web GUI 探针通过。

## 7. 本阶段不纳入

- 不连接银行或券商，不自动下单、撤单或修改持仓。
- 不调整默认策略参数、信号门槛和仓位规则。
- 不把 proxy replay 改称真实成交或已验证业绩。
- 不实现阶段 2 风险预算和 setup ledger。
- 不实现阶段 3 ReplaySimulator、OOS/walk-forward 或长期绩效结论。
- 不实现阶段 4 新策略、宏观因子、ML/DRL。
- 不发布版本、创建 tag 或 GitHub Release。
