# 计划 02：性能与资源优化

> 对应调研批次：②（短期），并纳入两个原未排期的 P1（H-4 api-log 轮转、H-6 链路预算）。
> 规模：L（建议拆两个会话：宿主半 02.1–02.6，客户端半 02.7–02.8 + 02.9 收尾）。依赖：计划 01。

## 背景与目标

消除四条资源热点（每 30s MB 级写盘、每请求 MB 级重算、每 tick 上千次深拷贝与上千个
Intl formatter、无限增长的日志/缓存）和两条健壮性缺口（快照乱序覆盖、轮询无退避）。
全部为【性能】级改动，不改信号语义；唯一轻微【破坏】见 02.3（localeHint 不再持久化）。

---

## 变更清单

### 02.1 客户端 Intl.DateTimeFormat 提升与 memoize（对应 P0-2）

**证据锚点**：`lib/client.js` `formatBeijingTime`(911-935，每次 `new Intl.DateTimeFormat`)、
`beijingDateKey`(937)/`beijingMinutes`(≈957 区)、图表管线调用点 1002-1094/1502-1515。

**步骤**：
1. 模块级提升一个 formatter：
   ```js
   var BEIJING_PARTS = null;
   try { BEIJING_PARTS = new Intl.DateTimeFormat("en-US", { timeZone: "Asia/Shanghai", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit", hourCycle: "h23" }); } catch (_) {}
   ```
   `formatBeijingTime` 复用 `.formatToParts(date)`；BEIJING_PARTS 为 null 时走现有 UTC+8 回退分支。
2. 增加有界 memo：`Map<tsNumber, {day, minutes, text, textShort}>`，容量 8192 满则整表清空
   （分钟 bar 时间戳单调，命中率极高）。
3. `Intl.DateTimeFormat` 实例无内部可变状态，单线程复用安全；保留原 try/catch 语义。

**验收**：满一天会话（~1020 根 1m bar）下每次 snapshot 渲染的 formatter 构造次数从 ~7k 降为 0
（Performance 面板肉眼确认无长任务即可）。

### 02.2 宿主 state 写盘去抖（对应 H-1 + P2#16 dispose 竞态）

**证据锚点**：`lib/index.js` `persistState`（≈3620-3630 定义；调用点 tick 尾部 ≈3962、
snapshot locale 翻转 4138-4142、dispose ≈4350-4360）、写队列与原子写（≈416-538 区）。

**设计**：分区脏标记 + 差异化落盘节奏（state 仍是单文件，文件拆分留给计划 05 的 store.js）：

| 分区 | 内容 | 策略 |
| --- | --- | --- |
| `bars` | 各道各周期 bars（体积主体，1–3MB） | 脏标记 + 最短间隔 `STATE_BARS_FLUSH_MS = 5min`；另外每当最新 1m 桶滚动（整分钟切换）时允许一次落盘 |
| 其余 | quotes/alertState/lastSuggestedOrder/localeHint 等（KB 级） | 脏即写（沿用现有串行队列 + tmp+rename 原子写） |

- 新增 `markStateDirty(section)`；所有 bars 变异点（recordTick/mergeKlines/seedBars/manual-cmb/
  ensureBars 后）打标。
- **dispose 修复**：effect cleanup 中 `void persistState()` 改为可等待的最终 flush
  （DSH effect 支持异步 disposal；若验证不支持，则 dispose 时同步标记 + 依赖下次启动
  barsSeed/增量补齐并在 DESIGN 记录该窗口）。
- 崩溃窗口权衡：最多丢 5 分钟合成 1m bar，重启后由报价轮询自建 + K 线补齐，可接受；
  在 DESIGN §10 记录。

**验收**：稳态运行 30 分钟，state.json 写盘次数从 ~60 次降到 ≤7 次（加临时计数日志验证后移除）。

### 02.3 GET /snapshot 缓存与瘦身（对应 H-2 + P2#15 locale 写盘）

**证据锚点**：路由 handler `lib/index.js` ≈4137-4148（恒真条件
`if (!runtime.lastSnapshot || runtime.ready)`）；`refreshSnapshot`/`computePlan`；
`barsView(..., 1440, 1, ...)` ×4 的 trend 数组（≈3080-3085 组装处）。

**步骤**：
1. `runtime.lastSnapshotBuiltAt` 时间戳；重建条件改为「无快照 或 距上次构建 >
   `SNAPSHOT_REBUILD_MIN_MS = 2000`」，否则直接返回缓存对象（tick 每 30s 本就在刷新）。
2. trend 数组上限 1440 → `TREND_POINTS = 1080`（单交易时段最长 1020 分钟，余量 60）。
3. localeHint 翻转**不再触发 persistState**：仅存内存。【破坏·轻】重启后通知语言提示回到 zh 默认；
   DESIGN §11 同步改述。

**验收**：`curl -s snapshot | wc -c` 典型负载从 ~1MB 降至 <300KB；连续 curl 两次耗时第二次显著下降；
客户端 10s 轮询期间宿主 CPU 无可见尖峰（活动监视器抽查）。

### 02.4 isOpenMinute 归一化提升（对应 H-3）

**证据锚点**：`isOpenMinute`（1993-2050，函数体首行 `normalizeConfig(config)` 深拷贝）、
调用方 `windowCoverage` while 循环、`filterBarsToTradingHours`、`listMissingCmbMinuteSlots`、
`computeMarketState` / `computeNextMarketOpen`（1966-1973 区）、coverageGate 双跑（3081-3084 区）。

**步骤**：
1. 新增 `buildSessionCalendar(config)` → `{ openMin, closeMin, weekdaysOnly, holidaySet }`，
   在 computePlan / buildSnapshot / listMissingCmbMinuteSlots 入口各算一次并下传。
2. `isOpenMinute(calendar, timestamp)` 改为纯函数；上述四个消费方改签名。
3. 兜底：`normalizeConfig` 结果按输入对象身份 `WeakMap` memoize（配置对象仅在保存时更换）。
4. 顺带消除 coverageGate 冗余二跑（warm-up 窗口生效时可跳过 fullGate，逻辑见 01 计划后的现状）。

**验收**：单次 /snapshot 构建中 `normalizeConfig` 执行次数（临时计数）从数万降为个位数。

### 02.5 api-log 轮转与尾读（对应 H-4）

**证据锚点**：`lib/index.js` `persistApiLog`(478-487)、`readApiLogs`(494-515)、
`apiLogPath` 单例（474-476 区）。

**步骤**：
1. append 前 `stat` 大小，> `API_LOG_MAX_BYTES = 2MB` 时 `rename(api-log.jsonl, api-log.jsonl.1)`
   （旧 .1 直接覆盖，只保留一代）。
2. `readApiLogs` 改尾读：打开后取 size，`createReadStream(path, { start: Math.max(0, size - 256*1024) })`
   → 按 行分割 → 丢弃首个残行 → 取末 500 条。文件 ≤256KB 时全量读（现行为）。
3. 启动加载同样走尾读。

**测试**：temp dir 下 a) 超 2MB 触发轮转且 .1 存在；b) 尾读容忍撕裂首行；c) 小文件行为不变。

### 02.6 行情链路预算 + 文档纠偏（对应 H-6 + P2#17 文档漂移）

**证据锚点**：`fetchDomesticQuote`（1474-1545，串行 sina→SGE→东财→60s）、`fetchCmbQuote`
（1243-1298，三传输串行）、`QUOTE_TIMEOUT_MS` 等常量（≈63-67）、trackedCall/fetchUtf8/fetchGb18030
（644-665 区）。DESIGN §6.3 承诺的「指数退避 2s/4s/8s」「磁盘缓存原始响应」未实现。

**步骤**：
1. 新增链路预算：每条 fallback 链一个总 `AbortController`（`QUOTE_CHAIN_BUDGET_MS = 12000`）；
   链内单源超时 = `clamp(剩余预算/剩余源数, 3500, 6000)`；任一源成功即 abort 其余在途请求。
2. **可测性接缝**：模块内 `let fetchImpl = (...args) => fetch(...args)`，全部出口走 fetchImpl；
   导出 `__setFetchImpl` 仅供测试。
3. 重试语义裁决：**不补实现指数退避**（熔断器已覆盖故障隔离职责），修订 DESIGN §6.3 为实际行为
   （链路预算 + 熔断 + stale 降级），删除未实现的承诺；顺带修正同节其他漂移：
   stale 阈值实为 15min（§6.4 写 >10min）、/bars 的 interval 实为数字参数（§8.9 示例写 1m）、
   poll clamp 实为 10–300s（§6.3 写 15–120s）、`{{reason}}` 占位符或补实现或从 §11 删除、
   §8.8 示例中不存在的 `alerts` 字段删除。
4. `new TextDecoder("gb18030")` 提升为模块常量（661-665）。

**测试**：注入慢/快假源序列，断言链路总耗时有界、成功源之后的在途请求被 abort。

### 02.7 快照轮询健壮性（对应 C-1/C-2）

**证据锚点**：`lib/client.js` snapshot load 与调度（1439-1484，interval 定义唯一点 ≈1460）；
参照实现 `loadDetail` 的 seq 守卫（2443-2450）。

**步骤**：
1. 模块级 `snapSeq`；load 开头 `var seq = ++snapSeq`，响应到达后 `if (seq !== snapSeq) return;`
   再 setState（防乱序覆盖、天然去重堆积）。
2. 失败退避：连续失败计数 → 间隔 10s→20s→40s→封顶 60s；成功即复位。
3. `visibilitychange` 转可见时立即 `load()`；`window.addEventListener("online", load)`（卸载时移除）。
4. snapshot fetch 补 `cache: "no-store"`（对齐其余 fetch）。

### 02.8 分析缓存上限（对应 A-1）

**证据锚点**：`lib/analysis.js` `this.cache = new Map()`(354)、写入点 `cache.set`(539)。
inputHash 含最新价 → 每 tick 都是新 key，永不驱逐。

**步骤**：set 后若 `size > ANALYSIS_CACHE_MAX = 32`，按 Map 插入序删最旧（LRU 近似足够——
命中本来就只发生在 cooldown 窗口内的重复点击）。

---

## 测试要求

- host.test.mjs 新增：轮转/尾读（02.5）、链路预算（02.6，用 __setFetchImpl）、
  snapshot 二次请求走缓存（02.3，可用注入时钟）、calendar 提升后 isOpenMinute 行为等价
  （改造既有时段用例）。
- 既有测试回归：tick/persist 相关用例适配脏标记接口。
- 客户端无自动化设施（dict 测试除外）：02.1/02.7 以 node --check + 手工 CDP 冒烟
  （断网恢复、后台标签切回立即刷新、慢响应模拟不回退数据）。

## 验证清单

- [ ] `node --check` + `node --test` 全绿（新增 ≥6 用例）
- [ ] 稳态 30min：state 写盘 ≤7 次；api-log 无超 2MB 文件；RSS 无持续爬升
- [ ] snapshot 典型 payload <300KB；二次请求命中 2s 缓存
- [ ] 断网 1 分钟恢复后看板 ≤2s 内自动恢复刷新；后台 10 分钟切回立即刷新
- [ ] DESIGN §6.3/§6.4/§8.8/§8.9/§11 漂移项全部修正

## 完成定义

- [ ] 上述全部勾选；版本 `v1.3.0` 发布（Release notes 注明 localeHint 不再持久化的轻微行为变化）
