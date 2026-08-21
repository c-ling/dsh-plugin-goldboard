# 计划 01：P0 正确性热修复

> 对应调研批次：①（立即）。规模：M（单会话可完成）。依赖：无。
> 四项都是「用户正在被错误信息引导」级缺陷，优先于一切性能/重构工作。

## 背景与目标

修复调研确认的 2 个 P0 + 2 个高影响正确性问题：

| 编号 | 缺陷 | 类型 |
| --- | --- | --- |
| P0-1 | 宿主 `seedBars` 用 5 分钟 K 线覆盖式写 60 分钟桶，破坏 ind60 趋势过滤并持久化污染 | 数据正确性 |
| P0-3 | 客户端跨零点时段（00:00–02:00）今日走势图被截断成凌晨切片 | 展示正确性 |
| C-3 | EN 词典残留中文键值（服务商/模型） | 双语合规 |
| H-5 | `confirmBars` 按 tick 计数而非收盘 bar，且 streak 跨信号集不清零 | 策略正确性 |

前置基线：`node --test` 75/75 通过；工作区已提交干净（见 `docs/plans/README.md` 全局约定）。

---

## 变更清单

### 01.1【策略】修复 seedBars 的 60 分钟桶聚合（宿主）

**证据锚点**：`lib/index.js` — `seedBars`（≈1710-1713，调用点 ≈3781-3793 AU9999 / ≈3801-3812 XAU）、
`mergeKlines`（≈1715-1743，对已存在桶整体覆盖 `existing.o = bar.o …`）、专用 60m K 线拉取的
长度门控 `bars.XXX[60].length < 20`。行号为 v1.2.0 基线，漂移时按符号定位。

**问题**：`mergeKlines(bars[60], fiveMinuteKlines, 60)` 不聚合，每个小时桶只剩该小时最后一根
5 分钟子 bar 的 OHLC；坏数据使桶数 >20 从而**永久跳过真正的 60m K 线拉取**；`init()` 把坏桶
写入 `state.json` 跨重启存活。`ind60.ema20 向上` 是所有买入信号的硬性趋势条件 → 核心信号被静默劣化。

**目标行为**：
- 由 5m K 线构建 60m 桶时执行真聚合：`o = 首根子bar.o`、`h = max(h)`、`l = min(l)`、`c = 末根子bar.c`；
- 只聚合**已完整结束**的小时桶（`alignStart(t,60) + 60min <= now`）；当前进行中的小时交给既有
  `recordTick` 报价路径维护，不由种子逻辑产出半截桶；
- 元数据继承首根子 bar 的 `source/instrument/market/currency/unit`，`synthetic:false`；
- 保留专用 60m K 线拉取作为更长历史的补充；其长度门控在聚合修复后自然恢复有效。

**存量污染清理**：正在运行 v1.2.x 的用户 `state.json` 里已有坏桶（60m MAX_BARS=1440，自然过期需
60 天，不可等待）。引入常量 `BARS_SEED_VERSION = 2`：
- state 持久化新增字段 `barsSeedVersion`；
- 加载时若缺失或 ≠ 2：丢弃 AU9999 / XAU 两道的 `bars[5]` 与 `bars[60]`（其余周期保留），
  下一次 init/tick 由修复后的 seedBars 重建；随后写入新版本号。

**实施步骤**：
1. 在 `mergeKlines` 旁新增 `aggregateSubBars(list, subKlines, intervalMinutes, metadata)`
   （或给 mergeKlines 增加 `aggregate: true` 分支），仅用于 seedBars 的 60m 调用；`bars[5]`
   合路语义不变。
2. seedBars 内改为：5m 直合；60m 先按小时分组聚合再合入。
3. state 读写两处接入 `barsSeedVersion` 判断（读：init 加载路径；写：persistState 序列化处）。

### 01.2【展示】跨零点时段的交易日锚点（客户端）

**证据锚点**：`lib/client.js` — `formatBeijingTime`(911)、`beijingDateKey`(937)、
`beijingMinutes`(≈957 区)、`isTradingMinute` / `tradingMinuteIndex`(957-992)、
`findBarAtMinute`(≈1000)、`filterTodayBars`(1007-1014)、`chartBaselineBar`(1016 起)。

**问题**：默认时段 09:00–26:00（close>1440），但 `filterTodayBars` 按
`beijingDateKey(bar.t) === beijingDateKey(serverTime)` 过滤；00:00 后日期翻转，前半夜 bar 全被丢弃，
图表只剩 0–2 点切片——与专门为「昨晚+今晨压缩一条轴」编写的 `tradingMinuteIndex` 自相矛盾。

**目标行为**：新增纯函数
`tradingDayKey(serverTime, tradingHours)`：若 `beijingMinutes(serverTime) < closeMinutes - 1440`
则返回 serverTime 的**前一**北京日历日键，否则返回当日键；`filterTodayBars` 与 `findBarAtMinute`
改用该锚点比较。`chartBaselineBar` 的涨跌幅基准语义不变（仍以昨收折算/manualPrevClose 为基准），
本计划只修过滤；若联调发现基准点视觉异常，记录到遗留项不在本计划扩权。

**注意**：grep 全部 `beijingDateKey(` 比较 `=== day` 的调用点逐一过一遍（预计 2–3 处），
不得遗漏第二处同型过滤。

### 01.3【合规】EN 词典中文残留（客户端）

**证据锚点**：`lib/client.js` en 字典块内 ≈760-761 `analysisProvider: "服务商"`、`analysisModel: "模型"`；
另 ≈582/636/640 三条 EN 文案含「积存金」。

**目标行为**：
- `analysisProvider → "Provider"`、`analysisModel → "Model"`；
- 「积存金」三条统一为 `CMB Accumulated Gold` 表述（zh 侧不动）；
- 执行时 grep en 块内全部 CJK 字符做一次兜底扫查（`\p{Script=Han}` regex），逐条判断是产品名保留还是遗漏。

### 01.4【策略】confirmBars 改为按收盘 bar 计数 + 信号集结束重置（宿主）

**证据锚点**：`lib/index.js` — `applySignalPolicy`（≈2436-2484）、`runtime.signalState` /
`defaultSignalState()`、streak 键（buyStreak/sellStreak 类命名，以代码为准）。

**问题**：① streak 在每次评估（30s tick）递增，`confirmBars: 2` 约 60 秒即确认，与设计意图
「连续 N 根 5 分钟 bar」不符；② plan 进入非方向性动作（wait/data_incomplete/no_data 等）时提前
return **不清零**，数小时前的陈旧 streak 让下一次孤立信号免检通过。

**目标语义**：
- 确认计数以**信号道最新已收盘 5m bar 的 `t`** 为时钟：同一根 bar 的多次评估不重复计数；
- 以下任一情况双 streak 清零：动作脱离方向集、信号道 instrument 变更、marketState 转 closed；
- `confirmBars` 配置语义更新为「连续 N 根收盘 5m bar 条件成立」。

**实施步骤**：signalState 增加 `lastBarT: { buy, sell }` 与 `instrument` 记忆；在
applySignalPolicy 入口先做重置判定，再按 bar 推进计数。**依赖关系**：道切换重置在本计划先按
「instrument 字段变化」实现最小版；完整粘滞机制见计划 03（S-1），届时复用此处钩子。

---

## 测试要求（test/host.test.mjs 及新文件）

1. `aggregateSubBars`/seedBars：构造 3 个完整小时 × 12 根 5m bar 的已知 OHLC fixture +
   1 个未完成小时 → 断言聚合桶 o/h/l/c 正确、半截桶被排除、元数据/synthetic 正确。
2. 存量污染：伪造含坏 60m 桶且无 `barsSeedVersion` 的 state JSON → 断言加载后 [5]/[60] 被丢弃
   且版本号回写为 2；版本匹配时保留。
3. `tradingDayKey`：serverTime=00:30（close=26:00）→ 返回前一日键；serverTime=09:30 → 当日键；
   close 可解析 "26:00" 形态。
4. applySignalPolicy：a) 同一根收盘 bar 内两次评估只计 1 次；b) wait 一段时间后 streak=0；
   c) instrument 切换后 streak=0；d) confirmBars=2 时第二个不同 bar 才 fired。
5. 新增 `test/client-dict.test.mjs`：从 `lib/client.js` 文本中以括号配平法切出 DICT 的 zh/en
   两个对象字面量，`new Function('return (...)')` 求值后断言 `Object.keys(zh).sort()` 与 en 完全相等
   （临时性方案，计划 05 抽模块后改为直接 import）。同时用 `\p{Script=Han}` 断言 en 值无 CJK
   （白名单允许「积存金」若最终决定保留——执行时按 01.3 决策填白名单）。

## 验证清单

```sh
node --check lib/index.js lib/client.js && node --test
```

- [ ] 上述测试全绿（原 75 + 新增 ≥10）
- [ ] 手工冒烟（Chrome headless + CDP，方法见 dsh-plugin-development skill §6）：
      打开浮窗展开卡，确认「今日走势」在交易时段内渲染完整（重点：把系统时间不可改，则用
      devtools 将 snapshot mock 的 serverTime 设为 00:30、bars 含前一日 21:00 起数据，观察折线）
- [ ] 设置页切到 English：Provider/Model 标签为英文，全页无中文残留
- [ ] `/snapshot` 返回的 plan 中确认相关指标数值合理（60m EMA20 与东财 60m K 线肉眼对齐）

## 文档同步（同一提交内）

- DESIGN.md §7.5 补一句确认语义（按收盘 5m bar 计数、信号集结束清零）；
  §6.2/§6.3 补 60m 桶由 5m 聚合 + `barsSeedVersion` 失效机制说明；§9.1 补交易日锚点口径。
- README.md / README-en.md 功能段无需改（「连续确认」表述修复后反而变准确）。

## 完成定义

- [ ] 四项缺陷全部修复且有对应测试
- [ ] 基线命令全绿；手工验证三项勾选
- [ ] 版本 `v1.2.1`：bump version + README 双语 pin + tag + GitHub Release（双语 notes，
      注明 confirmBars 行为变化属 bug fix）
