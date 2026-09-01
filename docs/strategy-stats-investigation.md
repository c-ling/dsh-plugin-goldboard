# “策略统计”未获取 2026-08-28 17:15 之后数据：源码调查

> 调查日期：2026-08-31
> 调查范围：仅使用本仓库源码、测试、文档、git 历史和本机可读运行数据。未修改业务源码，未发起外部行情请求，未向运行实例持久化新的统计报告、通知或配置。
> 结论强度：下文“已证实”均有源码/测试/本地文件证据；不能由本机证据证明的内容列为“仍需外部证据”。

## 结论摘要

1. **“2026-08-28 17:15 之后没有产生数据”与本机 `state.json` 不符。** 17:15 北京时间对应 `2026-08-28T09:15:00Z`。本机 CMB 5 分钟序列有 17:20、17:25、…、次日 01:55（北京时间）记录，最后一根覆盖到配置收盘 `02:00`；1 分钟序列也至少到 `2026-08-28T17:59:00Z`。这些记录带有 `c`，17:55 的记录还带有 `askC/bidC`。
2. **当前“策略统计”不是按分钟增量查询，而是按北京交易日生成一次性回放报告。** 默认 `lane=cmb` 只切本机持久化 CMB bars；报告 `window` 只展示交易日 `from/to`，不会展示“17:15 之后”的分钟边界。
3. **当前本机落盘报告确实是旧的一次生成结果，报告窗口到 8 月 28 日，而不是当前 bars 的最新时间。** `replay-stats.json` 的 `generatedAt` 为 `2026-08-31T13:57:47.920Z`，窗口为 `2026-08-03` 至 `2026-08-28`，请求 20 天；`state.json` 的 bars 已到 `2026-08-31T14:00Z`/1 分钟 `14:01Z`。报告不会随 state bars 自动更新，只有 POST `/replay-stats` 才重新计算。
4. **17:15 不是源码中的截断边界。** 默认交易时段为北京时间 09:00–次日 02:00；5 分钟桶按桶起点记录，17:15 桶的结束是 17:20。源码以配置收盘和已收盘 bar 判断完整 session，没有 17:15 的特殊过滤。
5. **不能仅凭本地数据判定为何用户界面当时没看到后续数据。** 可证实的候选是：界面显示的是尚未重新生成的报告、查看了报告的日级窗口而非 bars、或运行实例/存储目录与本机检查的实例不同。最后一项需要用户提供实例日志/请求证据才能确认。
6. **如果用户说的是“成交明细”停在 17:15，根因是连续账户达到仓位上限，不是行情停止。** 当前报告 `maxGrams=100`；8/28 17:15 的最后一笔连续账户成交把持仓从 90g 增到 100g。此后仍有 9 个独立 `buy_setup` 事件（17:25、17:40、18:00、18:15、18:30、18:45、21:05、21:35、21:50），但连续账户的 `replayOrderFromPlan()` 在买入可用量为 0 时返回 `null`，所以明细对话框（只投影 `orders/fills/trades`）不会显示这些事件。
7. **8/28 确实存在一段独立数据缺口，但起点是 19:05 而非 17:15。** CMB 与 XAU 的自建 1m 序列在北京时间 19:07 到 19:56 同时缺 49 分钟，5m 表现为 19:05 到 19:55 缺 50 分钟，之后继续到 01:55；这更像宿主 tick/网络整体暂停，而不是 CMB 单独停止。当前存档没有逐 tick 主机日志，无法进一步判定具体原因。
8. **调查时逐事件结果没有完整持久化。** 原实现的内存 envelope 可以返回 `events`，但 `replay-stats.json` 不含它们；这会使重启后的“明细”进一步显得像在 17:15 截止。本次后续修复已单独持久化连续账户因仓位上限未执行的 `unexecutedSignals`，完整独立双 pass `events` 仍保持仅内存/截断详情。
9. **如果报告是在 8/28 17:15 左右用 v1.10 生成，旧版本本身会把当时的最后观测 bar 当作 session end。** v1.10（commit `800126c`，8/28 02:25 发布）仍纳入当天未收盘 session，并以最后观测 bar 推导结束；v1.11（commit `c7f2ebd`，8/29 01:30 发布）才改为配置收盘、默认排除 partial session。旧报告之后不会被新 tick 自动回算。

## 证据链

### 1. 数据产生事件与内存记录

- [lib/index.js#L353-375](../lib/index.js#L353) 每次 tick 并行刷新国内、CMB、XAU、USDCNY；CMB 成功后进入 `recordQuote("CMB", cmb.value)`。
- [lib/index.js#L264-279](../lib/index.js#L264) `recordQuote` 调用 `normalizeQuoteRecord`，更新 `runtime.quotes`；若该报价时刻处于交易时段，则调用 `recordTick(runtime.bars[key], normalized, normalized.updatedAt)`。
- [lib/index.js#L411-433](../lib/index.js#L411) tick 顺序是刷新报价、历史维护、计算策略、刷新 snapshot、告警评估、状态持久化检查。
- [lib/bars.js#L70-92](../lib/bars.js#L70) `recordTick` 为 1/5/15/60/1440 分钟桶写入 OHLC；`alignStart` 对 5 分钟桶按 epoch 桶起点对齐。
- [lib/bars.js#L77-88](../lib/bars.js#L77) CMB 双边报价写入 `askO/H/L/C` 与 `bidO/H/L/C`，同时保留普通 `o/h/l/c`。

**本地运行数据：**

- `$DSH_HOME/storages/dsh-plugin-goldboard/state.json` 的 `bars.CMB[5]` 中：
  - `2026-08-28T09:10:00Z`（北京时间 17:10）存在；
  - `2026-08-28T09:15:00Z`（北京时间 17:15）存在；
  - `2026-08-28T09:20:00Z`（北京时间 17:20）存在；
  - `2026-08-28T17:55:00Z`（北京时间 8/29 01:55）存在，下一桶结束于 `2026-08-28T18:00:00Z`（北京时间 02:00）。
- 8/28 CMB 5m 统计：180 根，首桶 `2026-08-28T01:15:00Z`，末桶 `2026-08-28T17:55:00Z`。这与默认 session 的 09:00–26:00 完整边界一致。
- 8/28 CMB 1m 末记录为 `2026-08-28T17:59:00Z`（北京时间 8/29 01:59）。末个 5m 桶 `2026-08-28T17:55:00Z`（北京时间 8/29 01:55）示例：`c=971.65, askC=971.65, bidC=966.65, executionSideComplete=true`。
- `state.json` 当前 CMB 5m 末桶为 `2026-08-31T14:00:00Z`，CMB 1m 末桶为 `2026-08-31T14:01:00Z`。因此本机采集链至少在 8/31 仍产生过后续数据。
- 同一缺口在 `bars.XAU[1]` 也出现（北京时间 19:07–19:56）；因此不能把这段缺口归因于 CMB 市场中心单一接口，而应优先查宿主进程/网络/系统睡眠记录。

### 2. 持久化文件与写入节流

- [lib/replay-stats.js#L1138-1148](../lib/replay-stats.js#L1138) 连续账户创建买单时用 `maxGrams - currentGrams` 计算可用量；达到上限后订单克数为 0，直接返回 `null`。
- [lib/replay-stats.js#L1424-1457](../lib/replay-stats.js#L1424) 只有拿到非空 `replayOrderFromPlan()` 才会进入连续账户的订单/成交生命周期；独立 `replayTradingDay()` 的事件不会自动变成账户明细。
- [lib/index.js#L65-72](../lib/index.js#L65) 定义 `state.json` 与 `replay-stats.json` 文件名。
- [lib/index.js#L107-131](../lib/index.js#L107) 默认目录来自 `pluginDir()`，并用 `StatePersister` 持久化 state。
- [lib/store.js#L13-21](../lib/store.js#L13) 默认路径是 `$DSH_HOME/storages/dsh-plugin-goldboard/`；本机 `DSH_HOME=$DSH_HOME`。
- [lib/index.js#L281-294](../lib/index.js#L281) `serializeState` 保存 quotes、所有 bars、`barsSeedVersion`、告警/信号状态等。
- [lib/store.js#L55-117](../lib/store.js#L55) bars 是分区脏数据，默认至少按 5 分钟节流写入；退出时 `persist()` 强制写入。
- [lib/index.js#L394-408](../lib/index.js#L394) 创建统计引擎时，`getCmbBars` 从当前运行实例的 `runtime.bars.CMB[5]/[60]` 取数据；报告文件为同一 storage 目录下的 `replay-stats.json`。
- [lib/replay-stats.js#L1746-1755](../lib/replay-stats.js#L1746) 只有一次 `run()` 计算结束时才写 `replay-stats.json`；新行情 tick 不会自动重算报告，且落盘对象不包含独立 `events`。
- 调查基线的冷启动 `last(true)` 只从文件恢复 `report/trades/orders/fills/pendingOrders`，不会恢复逐事件 `events`；本机冷读实测 `events` 属性缺失而 `trades=12`、`orders=74`、`fills=12`。后续修复新增 `unexecutedSignals` 的落盘与冷启动恢复，不改变完整独立 `events` 的内存口径。
- Git 对照：v1.10 的 `listReplayTradingDays()` 注释/实现允许当天 partial session（`800126c:lib/replay-stats.js`）；当前 v1.11 的 [lib/replay-stats.js#L165-193](../lib/replay-stats.js#L165) 只有 `includePartial:true` 才纳入未收盘 session，且 [lib/replay-stats.js#L146-162](../lib/replay-stats.js#L146) 用配置 close 判断完整性。

**本机落盘状态：**

- `state.json` 文件系统修改时间：8/31 22:01（本地显示）；文件内 CMB 5m/1m 的最新桶分别支持到 8/31 22:00/22:01 北京时间。
- `replay-stats.json` 文件系统修改时间：8/31 21:57；报告 `generatedAt=2026-08-31T13:57:47.920Z`，约为北京时间 21:57:47。
- 这两个文件的“最新时间”不同是预期的：行情持续写 state，统计仅在显式生成时写 replay report。

### 3. API 路由与查询参数

- [lib/routes.js#L337-347](../lib/routes.js#L337) GET `/dsh-plugin-goldboard/replay-stats` 调 `deps.replayStats.last(detail)`，只返回内存最近报告或落盘 `replay-stats.json`。
- [lib/routes.js#L349-387](../lib/routes.js#L349) POST 接收 `days/lane/force/detail/includePartial/requireExecutableBid`，调用 `replayStats.run()`；请求体中没有 `now` 转发。
- [lib/replay-stats.js#L1565-1584](../lib/replay-stats.js#L1565) `run()` 的 `now` 只有内部调用或测试显式传入时才使用；普通 HTTP POST 未传 `now`，因此使用宿主当前 `new Date()`。
- [lib/replay-stats.js#L1599-1607](../lib/replay-stats.js#L1599) 同窗口、同 lane、同配置的报告 1 小时内命中内存 TTL 缓存。
- [lib/replay-stats.js#L1617-1621](../lib/replay-stats.js#L1617) 运行时以当前 clock 枚举交易日。
- [lib/replay-stats.js#L1788-1809](../lib/replay-stats.js#L1788) cold memory 的 GET 从 `replay-stats.json` 读取，不会从 `state.json` 重新计算。

报告不支持 `from/to` 或“截至 17:15”的查询参数；`days` 是交易日数量，`includePartial` 是是否纳入部分 session，而非分钟截止时间。

### 4. 前端查询与展示

- [lib/client.js#L38](../lib/client.js#L38) 前端使用 `/dsh-plugin-goldboard/replay-stats`。
- [lib/client.js#L2946-2980](../lib/client.js#L2946) “明细”对话框只合并响应中的 `orders`、`pendingOrders`、`fills`，没有渲染独立回放 `events`；因此它展示的是连续账户生命周期，不是每个策略判断时点。
- [lib/client.js#L3804-3811](../lib/client.js#L3804) 设置页生成统计只提交 `{ days, detail: false }`，不提交 `force`、`includePartial` 或分钟级 `asOf`。
- [lib/client.js#L2961-2987](../lib/client.js#L2961) 明细对话框 GET `?detail=true`，只读当前报告保存的订单/成交明细。
- [lib/client.js#L3418-3424](../lib/client.js#L3418) 默认 `statsDays=10`；下拉选项是 10/20/30。
- [lib/client.js#L4364-4374](../lib/client.js#L4364) UI 展示 `report.window.from/to`、日数、步数、事件数等日级摘要，不展示 bars 的最后分钟。
- [lib/client.js#L2964-2980](../lib/client.js#L2964) 明细 GET 还会用 `reportId` 防止报告变化，但它仍然读取“当前最后报告”。
- [lib/client.js#L1347-1367](../lib/client.js#L1347) fetch 使用 `cache: "no-store"`，因此浏览器 HTTP cache 不是源码层面的主要原因；但接口返回的报告本身可能是服务端内存/文件中的旧报告。

### 5. 时间与时区边界

- [lib/market-time.js#L19-30](../lib/market-time.js#L19) `beijingParts` 通过 UTC 加 8 小时计算北京时间；`beijingDateForNow` 返回北京日期。
- [lib/market-time.js#L82-95](../lib/market-time.js#L82) 默认跨午夜 session 的凌晨尾段归属前一交易日。
- [lib/config.js#L46-50](../lib/config.js#L46) 默认交易时段为工作日 `09:00` 至 `26:00`。
- [lib/replay-stats.js#L119-127](../lib/replay-stats.js#L119) `sessionDateForTimestamp` 将 00:00–02:00 归到前一 session 日期。
- [lib/replay-stats.js#L131-143](../lib/replay-stats.js#L131) `replaySessionBounds("2026-08-28")` 的边界为 `2026-08-28T01:00:00Z` 至 `2026-08-28T18:00:00Z`，即北京时间 09:00 至 8/29 02:00。
- [lib/replay-stats.js#L147-162](../lib/replay-stats.js#L147) session 完整性要求当前时间已过配置 close，且最后 bar 的结束时间至少到 close；不是用最后观察 bar 自己的时间作为收盘。
- [lib/replay-stats.js#L184-193](../lib/replay-stats.js#L184) 默认只枚举 close 已经过的交易日；`includePartial:true` 才允许部分 session。
- [lib/replay-stats.js#L976-1025](../lib/replay-stats.js#L976) 每个 5m bar 的策略评估时点是 `bar.t + 5 分钟`；事件 `t` 是闭合 bar 的结束时刻；回放未来 bars 还要求 bar 结束时间不晚于 `asOf`。
- [lib/replay-stats.js#L1311-1318](../lib/replay-stats.js#L1311) 连续账户回放同样只使用 `bar.t + 5m <= asOf` 且 `bar.t < bounds.closeMs` 的 bars。

**17:15 边界换算：**

- 北京时间 8/28 17:15 = UTC 8/28 09:15。
- 5m bar 起点为 17:15 时，策略评估时点是 17:20；bar 覆盖到 17:20。
- 源码没有 `17:15`、`09:15Z` 或类似硬编码边界；本地文件在这一点之后有数据。

### 6. 报告现状与历史变化

- 当前 checkout 是 `v1.11.0`，HEAD `c7f2ebd`，其父版本 `v1.10.0` 为 `800126c`。
- [git commit `9488303`] 引入最初策略统计：只按 Au99.99 交易日逐日拉取 5m/60m，GET/POST 和 `replay-stats.json` 已存在；测试说明统计按交易日、点时回放。
- `git diff 800126c c7f2ebd` 显示 v1.11.0 增加了 `replaySessionStatus`、配置收盘边界、partial/complete/excluded 字段，并把 session end 从“最后观察 bar”改为“配置 close”。这是对日期尾部误标的修复，不是 17:15 截断逻辑。
- 当前落盘报告参数：`lane=cmb`、`days=20`、`includePartial=false`、`requireExecutableBid=false`，窗口 `2026-08-03` 至 `2026-08-28`；报告包含 `completeDays=6`、`partialDays=2`、`excludedDays=2`、`daysSkippedNoData=12`。8/28 在该报告的 `sessionDiagnostics` 中为 `complete`。
- 报告 `trades=12`、`orders=74`、`fills=12`；这是报告生成时的统计结果，不等于 state 当前全部行情，也不携带所有后续 quote bars。

## 已排除的假设

1. **“CMB 生产事件在 17:15 后被交易时段过滤”**：排除。`isOpenMinute` 默认允许至次日 02:00；本机 17:20 至 01:55 有 CMB 5m 数据。
2. **“17:15 是 5m bar 的源码硬编码截断点”**：排除。源码只按 5 分钟桶、配置 close、`asOf` 和 session date 过滤，没有 17:15 常量；17:15 桶本身存在。
3. **“state.json 在 8/28 17:15 后就没有更新”**：排除。当前 state 文件及其 bars 远超该时间，已到 8/31。
4. **“默认 CMB 策略统计会从 Eastmoney 重新拉取 CMB 历史”**：排除。`getCmbBars` 直接读本机 `runtime.bars.CMB`；只有 `lane=au9999` 才调用 Eastmoney fetch adapter。
5. **“GET `/replay-stats` 会实时从 state.json 计算”**：排除。GET 只读内存最近报告或 `replay-stats.json`；重新计算必须 POST。
6. **“浏览器 HTTP cache 直接造成旧数据”**：源码层面排除为主要原因。前端 `fetchJson` 设置 `cache: no-store`；仍不能排除服务端返回的是旧落盘报告。
7. **“v1.11.0 的完整 session 规则把 8/28 17:15 后数据排除了”**：排除。8/28 当前本机 `replaySessionStatus` 为 `complete`，末 5m bar 覆盖到 02:00。
8. **“测试失败导致该问题”**：未发现。执行 `node --test test/replay-stats.test.mjs`，28/28 通过；测试明确覆盖跨午夜、完整 session、CMB 本地 bars、报告持久化和缓存。

## 仍需用户提供的外部证据

以下问题无法仅凭仓库和当前本机文件确定：

1. **用户实际查看的请求响应。** 请提供脱敏的 `/dsh-plugin-goldboard/replay-stats` POST/GET 响应，至少保留 `report.generatedAt`、`report.window`、`report.params`、`sessionDiagnostics`、`daysEvaluated/daysSkippedNoData`；所有 URL 中 token、Authorization、Webhook secret 用 `<REDACTED>` 替换。
2. **用户当时的操作时刻和时区。** 需要确认“17:15”是北京时间还是本地/UTC，以及是点击“生成统计”的时刻、snapshot 图表时刻，还是报告内某个事件时刻。
3. **运行实例对应的 `$DSH_HOME`、插件目录和版本。** 当前本机检查的是 `$DSH_HOME/storages/dsh-plugin-goldboard/`、checkout `v1.11.0`。若 GUI 连接的是另一个 Harness 进程、另一个 `DSH_HOME` 或另一份安装包，本机文件不能代表该实例。
4. **浏览器 Network/Console 记录。** 需要确认页面实际发送的是 POST 还是仅 GET、请求 body 的 `days/lane/includePartial`、响应的 `cached`，以及是否发生请求失败/页面重新挂载。
5. **当时的 Host 日志或 api-log 相关片段。** 当前 `api-log.json` 只保存 source 请求概览，不能证明某一个 CMB tick 在 17:15 后是否成功；需要当时的脱敏 Host 日志或保存的逐 tick 数据。
6. **如果用户指的是“策略事件”而非“行情 bars”**，需要提供事件明细或 `replay-stats?detail=true` 的响应。行情存在不代表 `computePlan` 必须产生方向性事件；策略还受质量门控、指标预热、确认 bars、冷却和规则条件约束。当前证据只能证明 bars 存在，不能证明 17:15 后必然应有策略事件。

## 可复核命令与结果

在 `dsh-plugin-goldboard` 目录执行：

```text
node --test test/replay-stats.test.mjs
结果：28 passed, 0 failed
```

只读检查本机 state/replay 文件得到：

```text
CMB/5m 2026-08-28：180 根
末桶：2026-08-28T17:55:00.000Z（北京时间 8/29 01:55）
末桶结束：2026-08-28T18:00:00.000Z（北京时间 8/29 02:00）
replay report.generatedAt：2026-08-31T13:57:47.920Z
replay report.window：2026-08-03 ~ 2026-08-28
replay report.params.lane：cmb
replay report.params.days：20
断点后 5m bar：96 根；独立策略事件：9 个；连续账户最后成交：2026-08-28T09:15:00Z（北京时间 17:15）
连续账户期末仓位：100g；报告上限：100g
断点后唯一 5m 缺口：北京时间 19:05 ~ 19:55（50 分钟）
```

上述命令和输出未读取或打印凭证。检查 api-log 时仅打印了 source id 和 URL 结构，未打印响应体/请求头；文档不包含任何凭证。

## 建议处理

1. 先在统计卡片核对 `报告生成时间/窗口/缓存`；若需要用最新 bars 重算，通过 `POST /dsh-plugin-goldboard/replay-stats` 传 `force: true`（当前设置页按钮没有传该字段，1 小时内可能返回缓存报告）。
2. 若目标是核对行情连续性，直接读取 `GET /dsh-plugin-goldboard/bars?instrument=CMB&interval=5&limit=1440`；不要用连续账户成交表代替行情序列。
3. 本次后续修复已把“策略确认成立、但达到仓位上限而未创建订单”的账户级信号持久化并展示为独立表格；若目标是查看双 pass 的每个独立策略判断时点，仍需进一步持久化完整 `events`。
4. 对 19:05–19:55 的真实缺口，可用设置页“手工补录 CMB 分钟价格”补齐 CMB；但补录值应来自可靠记录，并在报告中保留 proxy/手工来源标记。宿主整体暂停的根因仍需查系统睡眠、网络和当时 Host 日志。

## 后续修复验证

基于当前 `state.json` 和运行配置重算 20 日 CMB 报告后，8/28 有 8 条 `status:not_executed`、`reasonCode:position_limit` 的账户级信号，北京时间从 17:30 延续至 21:50。它们分别保留正常补仓口径的 `signalPrice/limitPrice`，不进入 `orders.placed/fillRate`，但进入 `report.totals.unexecutedSignals`，并由详情 API/落盘文件的 `unexecutedSignals` 返回。运行实例已生成报告 `replay-1788274768952-1` 并持久化 8 条详情；全量测试结果为 224 passed、0 failed。

## 最终判断

基于现有证据，最准确的判断是：**行情数据并未在 2026-08-28 17:15 后停止产生；“策略统计”看到的内容是按交易日生成并持久化的一份报告，不是对 state bars 的实时分钟查询。若“停止”指连续账户成交明细，17:15 正好是仓位从 90g 达到 `maxGrams=100g` 的最后一笔成交，后续独立策略事件仍存在但不再产生账户订单。当前落盘报告到 8/28 且明确把该日判为完整，不能据此推断 17:15 后没有行情。若用户界面仍显示 17:15 截止，首要核对实际 API 响应的 `generatedAt/window/params`、`cached` 标志和运行实例 storage 路径；本次后续修复已让仓位上限导致的账户级未执行信号跨重启可见；完整独立双 pass 事件时间线仍需持久化 `events` 才能跨重启恢复。`
