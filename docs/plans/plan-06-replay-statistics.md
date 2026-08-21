# 计划 06：批量回放统计（规则命中率报表）

> 对应调研批次：④ 第三项（对应调研 S-8）。规模：M（1–2 会话）。依赖：计划 05
> （computePlan/indicators 已是可独立调用的纯模块、集成测试设施就绪）。
> 定位：只读分析功能，不发提醒、不调模型、不改任何策略行为。DESIGN 明确 v1 不做全自动回测寻优，
> 本计划是通往 v2 的低成本过渡：让 §7.3 手调默认值第一次有数据依据。

## 背景与目标

现有 `POST /replay` 只能对单一固定 fixture 做确定性重建，无法回答「RSI35 入场条件过去两周
触发几次、事后 60 分钟内打到止盈价的比例是多少」。本计划新增批量统计端点：

```
POST /dsh-plugin-goldboard/replay-stats   { days?: number, lane?: "auto" }
GET  /dsh-plugin-goldboard/replay-stats   → 最近一次报告
```

输出 JSON 报告（同时落盘 `storages/dsh-plugin-goldboard/replay-stats.json`），设置页提供
「生成统计」按钮 + 结果表（i18n 双语）。

## 数据深度现实约束（先读再设计）

- 1m bar 为合成数据，保留约 1 天；统计主力是 **5m K 线**（东财 lmt 上限约 500 根 ≈ 10+ 个交易日）
  与 60m K 线（趋势上下文）；
- 默认窗口 `days = 10`，上限 30（受源历史深度限制；超出部分在报告 `caveats` 里如实说明）；
- XAU 合成道采样偏差（每 bar ≤2 样本）必须写入 caveats，避免用户拿低保真道的统计当结论。

## 算法

对窗口内每个交易日（按北京交易日历，复用 market-time 模块）：

1. 拉取当日 5m + 60m K 线（每自然日仅拉一次，进程内按日缓存）；
2. 以 5m 收盘 bar 为步进时间轴，滚动重建该日的 bars 窗口（ensureBars 语义），调用
   indicators + computePlan **纯路径**（每日重置 signalState；alert 状态机不参与——统计的是
   规则本身而非告警去重；但 confirmBars 策略照常生效，因为它是信号语义的一部分）；
3. 记录事件 `{ day, t, action, instrument, signalLane, price, confidenceScore }`；
4. 事件后向追踪（forward outcomes，按 5m bar 序列）：
   - buy_setup：窗口内 maxHigh 是否触达 targetPrice、minLow 是否触达 stopPrice/breakeven、
     MFE/MAE（+30m/+60m）、持有至时段结束的净盈亏（扣 fee + 价差估算）；
   - sell_* 家族对称；
5. 聚合：per-action `{ count, targetHitRate, stopHitRate, avgMfe30m, avgMae30m, sessionEndAvgNet,
   perLaneSplit }`；另报 `coverageBlockedRatio`（data_incomplete 占比）、置信分与命中率的分箱相关性。

## 工程约束

- 单飞行（inflight 去重，复用 sixtySecondsInflight 同款模式或 AnalysisModule.running 模式）；
- 请求断开（req close）→ AbortController 取消；逐日 await 让出事件循环，绝不阻塞 tick；
- 中途源失败 → 已完成天数的**部分报告** + failures 列表（不整体失败）；
- 结果缓存：同窗口参数 1 小时内直接返回缓存报告；
- 报告体积有界（聚合层，不含逐事件明细；明细可选 `detail=true` 时截断至最近 200 条）。

## UI（设置页，最小可用）

- 「模型与分析」区旁新增「策略统计」卡片：天数选择（10/20/30）、生成按钮、进度文案、
  结果表（action × 命中率/均益/样本数）、caveats 展示；全部走 t()，双语词典同步。

## 测试要求

1. 确定性 fixture：2 个合成交易日的 5m/60m 序列 → 断言各 action 计数、命中率精确值；
2. 每日 K 线只拉一次（fetchImpl 调用计数）；
3. 中途失败 → 部分报告结构 + failures；
4. 取消：abort 后不再推进且可再次发起；
5. 报告落盘 + GET 幂等读取。

## 验证清单

- [ ] 上述用例全绿；`node --check` + `node --test` 全绿
- [ ] 真机对最近 10 天生成一次报告：总评估步数、各 action 触发次数合理（buy_setup 不应为 0
      也不应每天几十次——若数量级异常，回到 plan-01/03 检查确认与粘滞逻辑）
- [ ] 生成期间看板轮询无卡顿；tick 循环不受影响
- [ ] 设置页中英切换正常；暗色主题表格样式走 token
- [ ] DESIGN 新增 §8.x 路由契约 + §7.6「统计口径与局限」；README 功能列表补一条

## 完成定义

- [ ] 全部勾选；版本 `v1.7.0` 发布；Release notes 附示例统计截图/样例 JSON
- [ ] 遗留记录：v2 方向（参数网格寻优、更多标的、账户同步）写入 DESIGN §12 风险表之后的新小节
