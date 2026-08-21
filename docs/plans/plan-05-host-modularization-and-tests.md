# 计划 05：宿主半模块化拆分 + 集成测试；客户端半文件内重构

> 对应调研批次：④ 第二项。规模：XL（建议 2–3 会话：宿主拆分一个、集成测试一个、客户端重构一个）。
> 依赖：计划 01–04 全部合入。全部为【结构】改动，公开面（name/inject/apply、路由契约、
> snapshot 结构）不变，以黄金主快照做回归等价验证。

## 背景与目标

`lib/index.js` 4363 行单文件已承载 8 个职责（数据源/时间历法/指标/规则/提醒/通知/存储/路由），
模块级可变单例破坏实例隔离，且 apply()/路由/tick 循环/持久化/熔断/告警分发**零测试覆盖**。
本计划完成物理拆分 + 补集成测试；客户端半因浏览器加载机制约束仅做文件内重构（见开放问题）。

---

## 开放问题（第一天裁决，影响客户端部分范围）

**client-modules 是否支持同一包内多个 client bundle（子路径 exports + `dsh.client.inject` 图）？**
调查方法：读 DSH checkout 的 `@deepseek-ai/dsh-client-modules` 扫描/装载实现 +
`dsh --profile web --dump-config` 观察 graph 行构造。
- 若支持：客户端 i18n/pure-helpers 可拆文件 → 在本计划末尾追加执行；
- 若不支持：维持 client.js 单文件，仅做下文「文件内重构」，并把词典 parity 测试从
  plan-01 的括号切法升级为更稳的实现（仍不拆文件）。

---

## A 部分：宿主半拆分

目标文件与迁移内容（行号为 v1.2.0 基线，按符号定位）：

| 新模块 | 迁入内容 | 锚点 |
| --- | --- | --- |
| `lib/sources.js` | 源注册表 + 全部 parser/fetcher + trackedCall/fetchUtf8/fetchGb18030/fetchWithTimeout + 熔断 + api-log 写入 | ≈453-472 注册表、667-1654 parsers/fetchers、478-515 api-log、547 circuitState、1345 sixtySecondsInflight |
| `lib/market-time.js` | beijingParts/alignStart/isOpenMinute/computeMarketState/computeNextMarketOpen/windowCoverage/filterBarsToTradingHours/buildSessionCalendar | ≈733-773、1657-1791、1982-2130、2269-2342 |
| `lib/indicators.js` | computeIndicatorSet 及 SMA/EMA/Wilder RSI/ATR/MACD/布林/支撑阻力/重采样 | 2133-2267 |
| `lib/plan.js` | computePlan 分解 + applySignalPolicy + suggestedOrder 构造去重（三处字面量合一参数化工厂） | 2344-2907 |
| `lib/alerts.js` | 消息模板/系统通知/Webhook 发送/dispatchAlert/evaluateAlerts/logAlert | 3125-3453、3666-3729 |
| `lib/store.js` | 读 JSON 容错/原子写队列/markStateDirty+persistState/api-log 存储类（仿 AnalysisLogStore 形态） | 416-538、3620-3634 |
| `lib/routes.js` | `route({ GET, POST })` 助手（统一方法分发/405/413/错误信封）+ 全部路径定义表 | 4021-4363 |
| `lib/index.js` | 组合根：apply() 接线 services/effects/tick 循环/各模块实例化，目标 ≤500 行 | — |

硬性要求：
1. **消灭模块级单例**：apiLogs/circuitState/sixtySecondsInflight 等全部收进 apply() 闭包内创建的
   SourceRegistry / Store 实例（修 P2#19）；`circuitInfo` 只读不得变异共享态。
2. 函数长度上限 ~120 行；computePlan 拆为 selectSignalInstrument / buildIndicatorSet /
   positionBranch / flatBranch 四个纯函数。
3. 死代码清理：EASTMONEY_KLT(83)、suggestedGrams 未用 price 参数、barComplete 硬编码(2249)、
   1976-1979 空 block。
4. 魔数命名：session-end 30min、validUntil 边距、limit-step 0.1、confidenceMax 8、
   warmup≥60、alert-log cap 200、东财 ×100 缩放、金衡盎司系数 → 具名常量。
5. inject 裁决（P2#24）：llm 若平台必有则保留硬注入并删除 `ctx.llm ?? ctx.get?.("llm")` 双路；
   否则移出 inject——二选一，以 dsh web profile 实测为准。
6. **行为等价回归（黄金主快照）**：拆分前用 `POST /replay` 固定 fixture 抓取基线 JSON 存入
   `test/fixtures/golden-snapshot.json`；拆分后逐字段 deep-equal。

### 集成测试（新 test/integration.test.mjs，node --test）

设施：
- fake ctx：`{ logger, effect(label, fn){…捕获}, webServer: { register(route){…收集} } }`；
  llm stub（listProviders/listModels/resolveModelInfo/prepareCall→scripted stream）；
  store 根目录可注入（store.js 构造参数优先于 env.DSH_HOME ?? homedir）；
- fetchImpl 注入点（计划 02 已建 `__setFetchImpl`）驱动假行情源。

最小用例集（≥10）：
1. 冷启动 init：空 state → seedBars 聚合正确、barsSeedVersion=2 回写；
2. 带 legacy state 启动：版本失效逻辑触发（衔接计划 01）；
3. `/snapshot`：结构契约 + 2s 缓存命中 + locale 头不落盘；
4. `/config` POST：深合并表 + clearSecrets + 未知键 400（衔接计划 03；计划 04 合入后改为
   settings 分支双路径用例）;
5. tick 两连跑：正常源→失败源，断言熔断 open、stale 降级、无未处理 rejection；
6. 告警边沿：脚本价格穿越阈值 → stub 渠道收到一次消息、sentTo 落 log、二次穿越再发；
7. analysis run：scripted 成功流 → success 落 log；INVALID_JSON 流 → invalid 状态；
8. `/manual-cmb-bars`：added/skipped 语义 + 不覆盖已有桶；
9. `/replay` 黄金 fixture 确定性（复用 6 的 golden 文件）;
10. dispose：最终 flush 被等待（衔接计划 02.2）。

## B 部分：客户端半文件内重构

1. **共享 fetchJson 助手**：替换 ≥12 处雷同 fetch 块（锚点行号清单见调研报告 C-14：
   1444/2354/2448/2471/2703/2723/2743/2757/2782/2818/2843/2881）；统一 res.ok + content-type
   守卫 + body.ok 检查 + no-store；DataSourceLogsDialog 失败态与空态区分（C-20）。
2. **共享 Dialog 包装器**（overlay + Escape + 焦点陷阱 + portal + 焦点恢复）：AnalysisLogsDialog
   与 DataSourceLogsDialog 共用（C-19）。
3. QuoteItem/CmbQuoteItem 参数化合并（~90% 相同，1822-1931）；channelCard 与通用 webhook 卡合并。
4. memo 化：`React.memo(Sparkline)` + chartBars 管线 `useMemo`(2149-2164)；options 数组与回调
   稳定化（2434-2441、2940-2952）。
5. 微修：useState 惰性初始化(1963)、resize 防抖 + updater 外写 localStorage(1991-2003)、
   drag isPrimary 守卫(2005-2065)、外点监听三并二(2103-2105)、clipboard 回退返回值/.catch/
   统一 reset(1682-1693 等)、Switch aria-label 补全(1602-1613 各调用点)、Load-more cursor 守卫
   (2464-2466)、死代码 pad2/domestic prop/trigger-only-manual、URL 常量收编(2353/2756)。
6. i18n 收编：REASON_LABELS/ANALYSIS_ENUM_HINTS 经 locale.register 注册、evidenceForCode 内联
   三元迁入词典（C-12）、isChineseLocale 改查 locale 服务、全角括号 EN 侧改半角。

---

## 测试要求与验证清单

- [ ] 既有单测全部迁移通过（import 路径更新到新模块）
- [ ] 集成用例 ≥10 全绿；golden-snapshot deep-equal 通过
- [ ] index.js ≤500 行；每个新模块 ≤900 行；无模块级可变单例（grep 复查）
- [ ] 宿主真实冒烟：`dsh web` 重启后 curl snapshot/models/bars/replay/manual-cmb-* 全通
- [ ] 浏览器冒烟：浮窗拖拽/折叠/图表、设置页保存、双语切换、明暗主题、两个对话框 Escape
- [ ] DESIGN §4 架构图更新为新模块图

## 完成定义

- [ ] 全部勾选；版本 `v1.6.0` 发布（Release notes 注明纯重构、无行为变化、golden 快照等价）
