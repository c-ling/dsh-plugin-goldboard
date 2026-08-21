# dsh-plugin-goldboard 优化调研报告

> 调研基线：v1.2.0 tag + 工作区未提交改动（manual-cmb-bars / 挂单跟踪 / 分析门控放宽，+773 行）。
> 方法：宿主半 `lib/index.js`（4363 行）与客户端半 `lib/client.js`（3380 行）全文逐段深审；
> 策略模块 `analysis.js` / `analysis-log.js` / `market-quality.js` 精读；DESIGN.md 契约对照；
> 关键发现逐条回源码验证；测试基线 `node --test` 75/75 通过。
> 结论先行：**代码质量整体扎实**（安全面干净：execFile 无 shell 注入、secret 全链路脱敏、
> i18n 词典 307/307 键完全对齐、CSS token 使用规范），但存在 **3 个 P0 缺陷、约 13 个 P1
> 性能/正确性问题**，以及若干**策略层设计优化点**。

---

## 一、P0（建议立即修复）

### P0-1 宿主：`seedBars` 用 5 分钟 K 线覆盖式写入 60 分钟桶，破坏 60m 指标并持久化污染

- 位置：`lib/index.js:1710-1713`（seedBars）、`1726-1735`（mergeKlines 覆盖语义）、`3781-3812`
- `seedBars` 把东财 **5 分钟** K 线经 `mergeKlines(bars[60], klines, 60, …)` 合入 60 分钟桶，
  但 `mergeKlines` 对已存在桶是**整体覆盖**（`existing.o = bar.o; …`），从不聚合。~480 根 5m K 线
  使每个小时桶只剩"该小时最后一根 5 分钟子 bar"的 OHLC（仅 close 正确，高低开全丢）。
- 连锁伤害：随后 `bars[60].length < 20` 的判断因长度已 >40 而**永久跳过真正的 60m K 线拉取**；
  `recordTick` 只补当前小时；`init()` 把坏数据写进 `state.json` 跨重启存活。
  `ind60.ema20 向上` 是所有买入信号的硬性趋势过滤条件 → **核心信号引擎被静默劣化**。
- 修复：`seedBars` 内对每小时桶做真聚合（o=首根 o、h=max、l=min、c=末根 c），
  或直接删掉 `bars[60]` 那行、依赖专用 60m K 线拉取。

### P0-2 客户端：每 tick 构造上千个 `Intl.DateTimeFormat`，图表管线主线程卡顿

- 位置：`lib/client.js:915`（formatBeijingTime 每次 new）、调用点 `1002/1011-1012/1033-1035/1060/1094/1502-1515`
- `beijingDateKey`/`beijingMinutes` 每 bar 调一次 `formatBeijingTime`；图表管线
  （filterTodayBars → withChartBaseline → fillMissingChartSlots → hasChartLine → Sparkline 双重 filter + times map）
  对每根 bar 触碰 ~7 次。满一天会话（1000+ 根分钟 bar）时**每个 10s tick 构造 ~7000–10000 个 formatter**，
  低端机上每次轮询数十毫秒主线程 jank，拖拽结束/折叠展开时重复。
- 修复：提升一个模块级 formatter（`formatToParts` 可复用），或按时间戳字符串 memoize 到 Map。
  这是客户端最大的单项性能收益。

### P0-3 客户端：跨零点时段（00:00–02:00）今日走势图被截断成凌晨切片

- 位置：`lib/client.js:1007-1014`（filterTodayBars）vs `957-992`（isTradingMinute/tradingMinuteIndex）
- 默认交易时段 09:00–26:00（close > 1440）。`filterTodayBars` 按"北京日历日 === serverTime 日"过滤，
  00:00 后日期翻转，**前半夜的 bar 全部被丢弃**，"今日走势"只剩 0–2 点切片、now 线贴左边缘——
  而 `isTradingMinute`/`tradingMinuteIndex` 明明专门为"昨晚 + 今晨压缩到一条轴"而写。两套函数自相矛盾。
- 修复：计算"交易日锚点"（若 `beijingMinutes(serverTime) < close − 1440` 则锚定前一日历日），
  按锚点日过滤。

---

## 二、P1 代码层（性能 / 正确性）

### 宿主半（lib/index.js）

| # | 问题 | 位置 | 要点 |
| --- | --- | --- | --- |
| H-1 | 每 30s tick 全量 JSON.stringify + 重写整个 state.json | 3620-3630, 4352-4354 | MAX_BARS=1440 × 5 周期 × 4 标的 ≈ 1–3 MB/tick（≈4–8 GB/天 SSD 写入）+ 主线程同步序列化停顿。改脏标记 + 防抖（如 5 分钟或桶收盘时落盘），或按标的拆文件/追加式 bar log + 周期 compact |
| H-2 | `GET /snapshot` 缓存条件恒真，每次请求全量重算 plan + ~1MB payload | 4143-4147 | `if (!runtime.lastSnapshot \|\| runtime.ready)` 在 init 后恒 true；客户端 10s 轮询 → 每 client 每分钟重复 6 次 tick 计算 + 4 个 1440 点 trend 数组序列化。直接返回 `runtime.lastSnapshot`（tick 已在刷新）或加几秒节流；顺带评估裁剪默认 trend 窗口 / gzip |
| H-3 | `isOpenMinute` 每次调用都 `normalizeConfig(config)` 深拷贝 | 1993-2050, 3081-3084 | 该函数被 windowCoverage 的 while 循环（长假后可走 14400 分钟）、filterBarsToTradingHours（每 snapshot 5760 bar）、listMissingCmbMinuteSlots 逐分钟调用 → 单次 snapshot 数万次深对象分配。把归一化提升到调用方或按 config 对象身份 memoize |
| H-4 | api-log.jsonl 无限增长，启动时整文件读入内存 | 478-515 | 每 tick 追加 6–14 行（≈3–8 MB/天），无 rotation/compact（对比 analysis-log.jsonl 有 compact）；readApiLogs 启动 readFile 整个可能数月的文件只取最后 500 条。加大小轮转或尾部读取 |
| H-5 | `confirmBars` 按 tick 计数而非 bar，且 streak 不随信号集结束重置 | 2436-2484 | `confirmBars: 2` 实际 ~60 秒即确认（应为一根 5m bar）；plan 变为 wait 等非方向性动作时提前 return 不清零 → 数小时前的 buyStreak 直接满足下一次确认。改为按收盘 5m bar 的 t 判断 + 信号集结束时双清零（**兼策略缺陷，见 S-2**） |
| H-6 | 串行 fallback 链最坏 ~28s 超出 30s 轮询预算；设计承诺的重试/退避不存在 | 1474-1545, 1243-1298; DESIGN §6.3 | fetchDomesticQuote sina(6s)→SGE(6s)→东财(10s)→60s(6s) 串行；源不健康时 tick 被 ticking 守卫跳过，报价节奏退化到 60s+。给链路加总 deadline（AbortSignal）、独立传输并行 race；补实现文档承诺的指数退避或修订文档 |

### 客户端半（lib/client.js）

| # | 问题 | 位置 | 要点 |
| --- | --- | --- | --- |
| C-1 | snapshot fetch 无乱序守卫 / 无 abort / 无去重 | 1439-1484 | 慢宿主（>10s）时请求堆积，后发先至让旧快照覆盖新快照。loadDetail(:2443) 已有 seq 守卫模式，复用即可 |
| C-2 | 轮询无错误退避、恢复可见不立即刷新、无 online 监听 | 1458-1472 | 失败宿主被永远 10s 一顿锤；visibilitychange 只重排程，回 tab 最长等 10s 陈旧数据。加指数退避（10→20→40→60 封顶）+ visible 时立即 load() + online 事件 |
| C-3 | EN 词典残留中文：`analysisProvider: "服务商"`、`analysisModel: "模型"` | 760-761 | 英文用户设置页看到中文标签（双语 UI 是硬性要求）。另 582/636/640 的"积存金"保留是有意产品名还是遗漏，建议明确决策 |
| C-4 | NumberField 每击键 `Number(value)` 强转，破坏配置草稿 | 1615-1629, 3052, 3131-3142, 3223 | 清空字段即写入 0；`"1e999"`→Infinity、乱码→NaN 经 JSON.stringify 变 null 且可被保存。草稿保留原始字符串，blur/save 时再转换校验 |
| C-5 | AnalysisLogsDialog 列表 load 无 seq 守卫 | 2461-2488 | 筛选切换与 Refresh/加载更多可重叠，乱序响应覆盖列表/cursor。同 C-1 模式 |
| C-6 | SettingsSection 八个异步 handler 均不防卸载 | 2701-2903 | runAnalysis 可跑 60s，中途离开设置页 setState 到已卸载组件且结果丢失。mountedRef 或每请求 AbortController |

### 策略模块（我方精读补充）

| # | 问题 | 位置 | 要点 |
| --- | --- | --- | --- |
| A-1 | `AnalysisModule.cache` Map 无界增长 | analysis.js:354, 539 | inputHash 含最新价 → 每 tick 都是新 key，条目永不驱逐（只查 cooldown 不删除）。长驻宿主缓慢泄漏。加 LRU 上限或过期清理 |

---

## 三、P2 精选（完整清单见附录两份子报告要点）

**宿主半值得优先处理的：**
- 提醒日志 `sentTo` 恒为 `[null]`（dispatchAlert 丢弃 allSettled 结果，3438-3453）——DESIGN §10 承诺记录渠道结果
- fetchWithTimeout 只管响应头，body 下载不受配置超时约束（644-659）
- GET 路由体无 try/catch，异常变成宿主裸 400 无错误信封（违反自家 DESIGN §8/§10 契约，已在 dsh-host-webserver 源码核实）
- `POST /config` 浅合并：部分 payload 会整段抹掉兄弟配置节（4033-4034）
- 东财报价时间戳（epoch 秒字符串）从未被解析 → 其新鲜度检查恒通过（729, 760-773）
- locale 翻转导致 GET /snapshot 写盘：两个不同语言客户端会对拍 persistState（4138-4142）
- 死代码：`EASTMONEY_KLT` 未用；`sell_weakness`/`spread_alert` 在标签/告警集中注册但**无任何代码产生它们**（见 S-3）
- 模块级可变单例（apiLogs/circuitState/sixtySecondsInflight）破坏实例隔离与可测性
- 安全面结论：命令注入**安全**（execFile 参数数组 + AppleScript/PowerShell 正确转义）；generic webhook 为本地单用户工具可接受的 SSRF-by-design，建议至少限制 http(s) scheme 并文档化

**客户端半值得优先处理的：**
- `useState(readCollapsed())` 非惰性初始化，每次 render 读 localStorage（1963）
- resize handler 在 setPos updater 里写 localStorage + 无防抖（1991-2003）
- `.dsh-goldboard-plan-action` 的 `rgba(109,141,255,.12)` 是唯一不随暗色主题翻转的硬编码色（111）
- clipboard execCommand 回退忽略返回值恒报成功；onCopy 无 .catch（1682-1693 等）
- snapshot fetch 是唯一没带 `cache:"no-store"` 的；全部 fetch 裸 `res.json()` 不查 res.ok → 500 HTML 页面在 UI 报 "Unexpected token <"；建议抽共享 `fetchJson`（顺带去重 12+ 处雷同 fetch 块）
- 加载更多在 cursor 为 null 时重拉第一页并 concat → 可能重复条目（2464-2466）
- 外点收起注册 pointerdown+mousedown+click 三重捕获监听，mousedown 冗余且 pointerdown 会在框选文字时误收起（2103-2105）
- 拖拽缺 `isPrimary` 守卫（第二根手指竞争拖拽）；其余拖拽实现质量好（pointer capture + DOM 直改 style + 单次落盘）
- Switch aria-label 仅 1/5 调用点传入（1602-1613）
- DataSourceLogsDialog 缺 Escape/焦点陷阱/portal（与 AnalysisLogsDialog 不一致，抽公共 Dialog）
- 测试渠道发送 draft 中 `secret:""`——若宿主不回填已存 secret，已配置渠道测试永远失败（2831-2841，需核实宿主合并行为）
- 全文件零 React.memo/useMemo；修完 P0-2 后 `memo(Sparkline)` + chartBars 管线 useMemo 是廉价收益
- 与 DESIGN §9 的偏差（信息项）：折叠态是 280px 三报价胶囊而非规格的 ~36px 小圆球；卡片 400px vs ~320；settings order 72 vs 文档 65

---

## 四、策略层面发现（本次调研重点补充）

### S-1 信号标的逐 tick 即时切换，无粘滞 —— 指标基准漂移与告警抖动

`computePlan` 每次评估按可用性即时选道：`liveCmb ? CMB : useXauSignal ? XAU : Au99.99`
（index.js:2500-2513），无迟滞/最小保持时间。各道 bars 独立（指标不会混序列，这点是对的），
但三道价格水平系统性不同（CMB ≈ XAU折算+1.72 ≈ Au99.99+溢价±），EMA20/支撑位在道间不可比：

- CMB 接口间歇失败几个 tick → plan 切到 XAU 道 → 趋势/入场判定可能在道翻转处改变 →
  触发 `cancel_order`/`order_updated` 告警 → CMB 恢复又切回 → **告警抖动 + 用户被来回误导**。
- 建议：道选择加粘滞（如 CMB 失败需连续 N 个 tick 才降级；恢复需 M 个 tick 才回升），
  或在 plan 里输出 `signalLane` 并在道切换边沿发一次性提示。

### S-2 信号确认机制与设计意图不符（H-5 的策略面）

`confirmBars` 名义上是"连续 N 根 bar 确认"，实际按评估 tick（30s）计数且跨信号集不清零。
对策略的影响：确认强度形同虚设——瞬时假突破也能在 1 分钟内凑满确认；而陈旧 streak 又让
孤立信号免检通过。这是"信号强度显示"可信度的根基问题，优先级高于调参。

### S-3 出场面比设计薄：`sell_weakness` 与 `spread_alert` 只有注册没有实现

DESIGN §7.3 设计了 RSI>75 + 阴线吞没/上影>ATR 的减仓信号和内外价差异常提示，
README 也向用户宣传了"冲高回落/超买走弱时给出减仓建议"，但代码中无任何路径产生这两个 action
（仅存在于标签表/告警白名单）。当前实际出场只有止盈/移动止盈/止损/时段了结四条。
对一个入场要求深度回调条件的系统，缺走弱减仓意味着利润回吐风险放大。
**要么实现，要么从 UI/文档撤下**——当前状态是最差的（用户以为有保护）。

### S-4 CMB 价差静态估算 vs 动态校准

CMB 接口不可用时兜底价 = XAU 折算 + 固定 1.72。但 CMB 实际买卖价相对国际折算价的偏离
本身随波动变化（且不含国内溢价成分）。建议：CMB 实时可用期间滚动记录
`(CMB中间价 − XAU折算)` 的近期中位数作为"动态价差"，断连时用它替代静态 1.72（保留静态值为
冷启动兜底），可显著降低建议委托价失真。现成的 bars.CMB 历史已支持此计算，无需新数据源。

### S-5 手续费门槛 vs 日内波动预算可视化

双边 5 元/克 ≈ 950 元/克下的 ~0.53%，而日内黄金常态波幅经常不足——多数交易日无信号是
模型正确的表现，但用户只看到"等待"。建议看板增加一行"今日波动预算"：
`近N日同时段平均真实波幅 − 总成本`，让用户理解"不是坏了，是今天不够波动"。纯展示，零策略风险。

### S-6 多周期共识 + 抄底入场的交集可能过稀

60m EMA20 向上（滞后确认）∧ 5m RSI 从 <35 回升（左侧抄底）两者天然难同时成立——
60m 趋势刚翻多时，5m RSI 通常早已离开超卖区。若实测信号频率过低（建议先加统计：
各 reasonCode 的日内触发次数/最终 plan 分布，可挂在现有 replay 通道上），可考虑
把 60m 条件放宽为"不再向下"或给 RSI 条件加"或重新站上 SMA20"的替代路径（后者设计里已有，
注意确认实现里两条路径真的可达）。

### S-7 XAU 合成分钟线的采样偏差应在 UI 如实标注

30s 轮询自建的 XAU 1m bar 每根最多 2 个样本 → OHLC 系统性低估区间，ATR/支撑阻力在该道
偏"窄"。覆盖率门槛管"有没有"不管"代表性"。建议在 XAU 道激活时于指标区标注
"合成低采样bar，波幅指标偏低估"，避免用户拿 XAU 道的 ATR 去套 CMB 实盘。

### S-8 回放通道已有，缺"批量统计"这一步

`POST /replay` 是单 fixture 确定性重建，适合测试不适合调参。DESIGN 明确 v2 才做回测——
同意不做全自动寻优，但一个离线批处理（对缓存 bars 逐日 replay，输出各规则的
触发次数/事后 N 根 bar 收益分布）成本低、价值高，能让 §7.3 所有手调默认值第一次有数据依据。
可作为 v1.3 的过渡功能（不发提醒、纯只读报表）。

### S-9 LLM 分析层小观察

- `resolvedSelection` 已默认选 `low` reasoning effort（analysis.js:339）——符合 rc7+ 规范，👍
- 缓存 key 含 inputHash（含最新价）→ 实际上除"双击去重"外缓存几乎不可能命中，
  真正起作用的是 cooldownMinutes。行为可接受，但值得知晓"缓存命中率≈0"。
- 门控放宽后的新约束（quality blocked 时禁止 analysis_ready）在 prompt 与
  validateAnalysisOutput 两端都有，闭环正确。

---

## 五、平台适配检查（rc7 / rc8 / 0.1.1）

| 检查项 | 结果 |
| --- | --- |
| rc8 B1：import `dsh-client-ui-attachment` 组件 | ✅ 不涉及（client.js 仅 require react/react-dom，自包含） |
| rc8 B2/B3/B6：web_search queries、'wakeup'、credentials/updated | ✅ 均未使用（grep 核实） |
| rc8 locale 回退 zh→en | ✅ 词典 307/307 完全对齐，无暴露（但 C-3 两键是中文值混进 EN，修掉更稳） |
| reasoningEffort low | ✅ 已是默认 |
| Job Panel | 不需要（定时任务短） |
| **迁移 A：config CRUD → ctx.settings/settingsScope** | ⭐ **推荐纳入下个版本** |

迁移 A 收益量化：goldboard 目前自建了 `GET/POST /config` 路由、redactConfig 脱敏、
secretSet 语义、浅合并保存（正是 P2 shallow-merge bug 的根源）、config.json 读写队列。
换成 `installSettingsSection` + schemastery schema（webhook secret 用 `role('secret')`）+
client `settingsScope.bind({namespace})` 后，这一整层自建代码（含其 bug 面）由框架接管，
获得 revision fencing、统一脱敏、settings.yaml 持久化。保留 `settings.section` 独立菜单不变
（项目约定，勿改 settings.plugin.item）。注意：`@deepseek-ai/dsh-settings` 依赖版本须与目标
Harness 同线（0.1.1 → `^0.1.1-rc.1`）；旧 config.json 需一次性迁移读取。

---

## 六、架构级建议

**宿主半（4363 行 → 5 个自然模块）：**
1. `sources.js`（~453-1654）：表驱动 SourceRegistry（{id,url,headers,decode,parse,lane}），
   通用 runner 统一供 tracking/熔断/超时/api-log，消掉 ~200 行 fetcher 重复与模块级单例
2. `market-time.js`（~733-773, 1657-1791, 1982-2130, 2269-2342）：北京历法/时段/桶数学，
   归一化在接缝处完成（顺带修 H-3）
3. `indicators.js` + `plan.js`（2133-2267, 2344-2907）：computePlan（421 行）拆
   selectSignalInstrument/buildIndicatorSet/positionBranch/flatBranch；applySignalPolicy 换 bar 感知确认计数
4. `alerts.js`（3125-3453 + evaluateAlerts/logAlert）：dispatchAlert 返回逐渠道结果；死 action 接线或删除
5. `store.js` + `routes.js`（416-538, 3620-3634, 3455-3520, 4021-4363）：写队列/原子写/脏标记防抖/
   轮转 api-log + `route({GET,POST})` 助手统一 405/413/错误信封。apply() 收缩为纯接线。
   **拆分后补路由/tick 循环集成测试——目前 apply()、路由、持久化、熔断、告警分发零测试覆盖**

**客户端半（3380 行，无需构建步也可拆）：**
- i18n（DICT/REASON_LABELS/ANALYSIS_ENUM_HINTS ≈1000 行）提为前置 ModuleLoader 模块，奇偶校验测试直测两文件
- 纯函数（formatter/时间/图表数学，876-1106 + 1255-1427）提为 utils——P0-2 修复落在一处且可在 Node 测试
- SettingsSection（2646-3328，~680 行）按卡片拆组件 + 共享 useDraftConfig hook + 共享 fetchJson
- 浮窗（1488-2332）与对话框（2336-2627）各自成区；QuoteItem/CmbQuoteItem（~90% 相同）与两类 webhook 卡片参数化合并
- CSS 字符串（41-247）可移为静态 .css 以 `<link>` 注入

---

## 七、建议路线图

| 批次 | 内容 | 理由 |
| --- | --- | --- |
| ① 立即 | P0-1 seedBars、P0-3 跨零点图、C-3 EN 中文键、H-5 confirmBars | 都是"用户正在被误导"级 |
| ② 短期 | P0-2 Intl、H-1/H-2/H-3 热路径三件套、C-1/C-2 轮询健壮性、A-1 缓存上限 | 性能与资源 |
| ③ 中期 | S-1 道粘滞、S-3 出场信号补全、S-4 动态价差、GET 错误信封、shallow-merge、sentTo | 策略可信度 |
| ④ 版本级 | 迁移 A（ctx.settings）、双半模块化拆分 + 集成测试、批量 replay 统计（S-8） | 结构性收益 |

---

*附：本报告由宿主半/客户端半两份独立深审（各自全文通读 + 平台源码交叉核验）与策略模块精读汇总而成；
关键发现均经二次回源验证。两份原始子报告要点已并入第二、三节。*
