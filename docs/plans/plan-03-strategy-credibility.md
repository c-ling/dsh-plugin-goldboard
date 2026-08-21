# 计划 03：策略可信度与健壮性

> 对应调研批次：③（中期）。规模：L（建议两个会话：策略项 03.1–03.3；健壮性项 03.4–03.6）。
> 依赖：计划 01（confirmBars 的 bar 时钟与重置钩子）。
> 本计划含【策略】级行为变化，Release notes 必须逐条说明。

## 背景与目标

修复三类影响信号可信度的问题：信号道抖动（S-1）、出场保护缺位（S-3，README 宣传了但未实现）、
CMB 兜底价静态失真（S-4）；同时补齐宿主对外契约的三处破洞（GET 错误信封、配置浅合并、
提醒日志 sentTo 恒空）。

---

## 变更清单

### 03.1【策略】信号道粘滞（对应 S-1）

**证据锚点**：`lib/index.js` `computePlan` 道选择（2495-2572）：`liveCmb` / `useXauSignal` /
`useDomesticSignal` 每 tick 按可用性即时决定，无迟滞。各道 bars 独立（指标不混序列，保持）。

**问题**：CMB 接口间歇失败几个 tick → 道切到 XAU（价格水平系统性低 ~1.72+，指标历史不同）→
趋势/入场判定可能在翻转处变化 → 触发 cancel_order/order_updated 告警 → CMB 恢复又切回，
来回抖动误导用户。

**设计**：
- `runtime.laneState = { lane: "CMB"|"XAU"|"AU9999", pendingLane, pendingTicks }`；
- **降级切换**：当前道不可用连续 ≥ `LANE_SWITCH_TICKS = 3`（≈90s @30s poll）才切到下一优先可用道；
- **回升切换**：更高优先道恢复连续 ≥ `LANE_RECOVER_TICKS = 3` 才切回；
- 切换瞬间：一次性 `lane_switched` 提醒（边沿触发，加入 labels/alertable 集），plan 附
  `reasonCodes: signal_lane_degraded`（等待切换期间）；plan 新增字段 `signalLane`；
- 道变更时调用计划 01 建立的 streak 重置钩子；
- computePlan 内所有 `liveCmb ? … : useXauSignal ? …` 三元链改为统一读取 laneState 决议结果
  （覆盖率门控、指标、建议价同源）。

**边界**：休市期间不做切换评估；手动 replay 不受影响（replay 输入固定 quotes，按输入直接决议）。

### 03.2【策略】补全 sell_weakness 与 spread_alert（对应 S-3）

**证据锚点**：两 action 目前仅存在于标签表/告警白名单（≈96/98/116/118、2432、3219-3226、
3707-3718），无任何产生路径。DESIGN §7.3 定义了触发条件。建议委托单构造参考现有三处
suggestedOrder 字面量（2812-2825 / 2841-2853 / 2885-2897——本计划不合并，留给计划 05）。

**sell_weakness（持仓减仓参考）**：
- 条件（全部基于已收盘 5m bar）：有持仓 且 `rsi14(5m) > cfg.strategy.weaknessRsi`（新增配置，
  默认 75）且（最后一根收盘 bar 为阴线吞没 或 上影线长度 > `atr14 × weaknessShadowAtrMult`
  （新增，默认 1.0））；
- 输出 `sell_weakness` + 减仓克数：沿用目标仓位区间（轻仓/标准/重仓）的减仓逻辑并保留最小底仓
  （定位既有 add/reduce band sizing 函数复用）；
- 走既有边沿告警状态机；i18n 补 action 文案与 evidenceForCode 条目（zh/en 同步）。

**spread_alert（内外盘异常提示，仅提示不开仓）**：
- state 新增 `premiumHistory`: 每日一条 `{ date, premiumPerGram }`（取当日
  domesticPremiumPerGram 的收盘前中位数；上限 60 条滚动）;
- 样本 ≥20 天时计算 mean/σ（population，与布林口径一致），|当日值 − mean| > 2σ → 边沿告警
  `spread_alert`，次日自动重新武装；样本不足时仅在 snapshot quality.warnings 提示样本积累中。

**测试**：吞没形态 fixture（已知四根 bar）、上影 fixture、premium 序列 σ 突破 fixture、
边沿不重复触发 fixture。

### 03.3【策略】CMB 价差动态校准（对应 S-4）

**证据锚点**：兜底估算 `cmbBuy/cmbSell = cmbBase + cfg.cmb.{buy,sell}SpreadPerGram`
（2571-2572 区）；liveCmb 报价含 zBuyPrc/zSelPrc。

**设计**：
- liveCmb 有效期间采样 `{ t, spreadMid = (buy+sell)/2 − xauCnyPerGram }` 入
  `state.cmbSpreadSamples`（容量 512、单条 TTL 6h）；
- 兜底估算时：有效样本 ≥30 → `dynamicSpread = median(窗口内样本)`，夹在 `[0, 静态值×3]`；
  否则用静态配置值（冷启动兜底不变）。买卖两侧共用 dynamicSpread（中间价口径的诚实近似）；
- snapshot `derived.cmb` 新增 `spreadSource: "live" | "dynamic-estimate" | "static"` 与
  `spreadSampleCount`；设置页招行卡片 hint 展示来源（i18n 两键）；
- DESIGN §7.2/§6.4 更新公式描述。

**测试**：采样累积→动态生效→样本过期回退静态 的状态迁移用例；median 夹取边界。

### 03.4 GET 路由错误信封（对应 P2#10）

**证据锚点**：12 个路由定义（4021-4363 区）；已核实宿主 webServer 对 handler 抛错只回裸 400
无 JSON 体（dsh-host-webserver lib/index.js:198-206），违反自家 DESIGN §8 信封契约。

**步骤**：
1. 在 sendJson/readBody 旁新增包装器：
   `wrap(handler)` → try/catch → 异常时 `sendJson(res, 500, { ok:false, error:{ code:"INTERNAL_ERROR", message: 安全摘要 }})`
   （message 走既有脱敏习惯，不带堆栈）；
2. 全部路由 handler 包一层（POST 内部既有的错误映射保持不动，包装器是外层安全网）；
   方法分发样板的重构仍留给计划 05 的 routes.js。

**测试**：注入抛错的 runtime 依赖（或临时 monkeypatch 一个内部函数）断言 500 信封而非裸 400。

### 03.5 POST /config 深合并（对应 P2#11）

**证据锚点**：`normalizeConfig({ ...runtime.config, ...merged })`（≈4033）。

**目标语义**：
- 已知顶层键白名单：fee / cmb / position / limits / tradingHours / system / analysis / webhooks；
- 对象节递归合并一层（webhooks.feishu/dingtalk/wecom 各字段级合并；position.lots 与
  webhooks.generic 数组整体替换）；未知顶层键 → `400 UNKNOWN_CONFIG_KEY`；
- secret 语义不变（空串=保留旧值、clearSecrets 清单=清空）；
- 【破坏·轻】以前「传部分顶层节会重置其余节」的行为被修正——若有外部脚本依赖旧行为需注意
  （个人插件，评估为可接受，Release notes 注明）。

**测试**：部分 payload 表格用例（改 feishu.enabled 不丢 dingtalk.url 等）；未知键 400。

### 03.6 提醒日志 sentTo 修复（对应 P2#8）

**证据锚点**：`dispatchAlert`(3438-3453) 对每个渠道任务 `.catch(logger.warn)` 后返回 undefined；
调用方再包 `Promise.allSettled([dispatchAlert(...)])` 并映射 `entry.value` → `sentTo: [null]`。
DESIGN §10 承诺 alerts-log 记录渠道与结果。

**步骤**：
1. dispatchAlert 内部自行 `Promise.allSettled(tasks)`，返回
   `[{ channel, ok, error? }]`；
2. evaluateAlerts/logAlert（3666-3729）去掉二次包装，logAlert 直接写入该数组；
3. alerts-log.json 条目 `sentTo` 变为有意义内容；test-notify 路由若复用同一函数一并受益。

**测试**：双渠道一成一败 fixture → sentTo 断言。

---

## 测试与验证清单

- [ ] 新增用例 ≥12（03.1 序列切换 5 个、03.2 形态/σ/边沿 4 个、03.3 状态迁移 2 个、03.5 表格 ≥2、03.6 1 个）
- [ ] `node --check` + `node --test` 全绿
- [ ] 手工冒烟：拔掉 CMB 源（断网该域名 hosts 或 mock）观察 ≥90s 才切道且发一次 lane_switched；
      恢复 ≥90s 后切回不再发第二次提醒
- [ ] alerts-log 中最近一条提醒的 sentTo 显示真实渠道结果
- [ ] 设置页保存一个仅含 webhook.feishu 的 payload，dingtalk 配置保留
- [ ] DESIGN §7.2/§7.3/§6.4/§10 同步更新（新配置项 weaknessRsi/shadowAtrMult、动态价差公式、
      道粘滞参数、sentTo 结构）

## 完成定义

- [ ] 全部勾选；版本 `v1.4.0` 发布；Release notes 双语列出三项【策略】变化的参数与默认值
