# dsh-plugin-goldboard 黄金策略深度调研与优化报告（2026-08-28）

> 调研基线：`dsh-plugin-goldboard` v1.10.0，commit `800126c`。  
> 调研范围：策略规则、行情与质量门控、仓位和费用、建议单与提醒、回放统计、模型解释、设置与前端展示。  
> 方法：通读 Host/Web 源码与测试；只读检查运行中的本地接口；用最小合成数据复现关键公式；核对第一方市场资料。运行时观察、端点和复现输入输出见“可复核证据记录”。  
> 边界：本文是工程与研究审计，不构成投资建议，也不根据当前短样本推荐交易参数。

## 结论先行

Goldboard 的工程基础明显强于一般的个人行情脚本：它区分 CMB、XAU/USD 和 Au99.99，正式指标只使用已收盘 K 线，具备数据覆盖率、预热、信号道粘滞、连续确认、冷却、建议单生命周期、多源 fallback、熔断、审计日志和确定性回放。模型分析也被限制为解释规则，不能升级为买卖指令。

但现有“策略统计”还不能证明策略可执行或稳健。审计确认了五类会直接改变统计结果或用户风险认知的问题：

1. 多头“回本触及”使用 `low <= breakeven` 作为 OHLC 代理，价格根本没到回本线也会计为命中；当前报告的 100% 触及率必须在修正口径后重算。
2. 连续回放把建议限价立即当成交价，不验证下一可交易报价、限价触及、有效期或未成交；同一 K 同触止盈/止损时固定判止盈先到。
3. CMB 实时报价、fallback、固定 5 元点差、配置手续费、估算点差和滑点在不同 module 中缺少互斥且可逐项对账的成本定义。
4. fallback 止损公式与“最大可承受亏损”不一致；合成案例中配置最大亏损 2 元/克，实际净亏 12 元/克才触发。
5. 数据质量门控失败时，策略在进入持仓计算前返回，snapshot 随后把本可由实时卖价计算的浮盈亏显示为 0。

因此，优先级不应是继续寻找“最佳 RSI/ATR”，而应是：

```text
统一可执行价格和成本语义
-> 修正回放成交与统计方向
-> 持久化真实双边报价并积累足够历史
-> 做样本外和成本压力验证
-> 最后才比较策略参数与新因子
```

在上述 P0 完成前，UI 中的“期末模拟净收益”“目标命中率”“回本触及率”应视为工程诊断字段，不应视为策略有效性证据。

---

## 1. 当前功能与数据流

### 1.1 总体数据流

```text
免费行情源
  -> SourceRegistry（超时、fallback、熔断、日志）
  -> provider parser
  -> normalizeQuoteRecord / normalizeBarRecord
  -> 1m/5m/60m bars + 历史回填
  -> MarketQuality（stale、覆盖率、预热、OHLC、品种）
  -> indicators（SMA/EMA/RSI/ATR/MACD/Bollinger）
  -> computePlan（信号道、持仓/空仓规则）
  -> applySignalPolicy（确认、冷却）
  -> suggestedOrder
  -> snapshot / overlay / alerts
  -> replay-stats / 模型解释 / 审计日志
```

Host 的组合根是 `lib/index.js:107-514`。行情、指标、规则、存储、路由和告警已拆为独立 module；其中 `SourceRegistry` 以较小 interface 隐藏多源传输、编码、超时、fallback、熔断和来源日志，为行情调用方提供了明显 leverage 与 locality。

### 1.2 信号道与执行标的

信号道优先级定义于 `lib/plan.js:96-105`：

```text
CMB 实时客户报价
-> XAU/USD × USD/CNY / 31.1034768
-> Au99.99
```

XAU 折算公式位于 `lib/sizing.js:31-39`：

```text
xauCnyPerGram = XAU_USD_per_oz * USDCNY / 31.1034768
```

代码明确排除 Yahoo `GC=F` 期货作为 XAU 现货替代，这是正确的品种隔离。CME 的[黄金期货合约规格](https://www.cmegroup.com/markets/metals/precious/gold.contractSpecs.html)也说明期货是独立标准化合约，不能改名为现货或银行积存金。

信号道切换需要连续 3 次不可用，恢复也需要连续 3 次可用（`lib/plan.js:157-205`）。切换时确认 streak 会重置，减少价格口径抖动。不过降级等待期间仍使用原道最后数据计算，仅附 `signal_lane_degraded`；保护性卖出与新开仓应考虑采用不同降级政策。

### 1.3 数据时段与质量门控

插件配置日历的默认值是工作日北京时间 09:00 至次日 02:00（`lib/config.js:45-50`），支持手工节假日和跨午夜归属（`lib/market-time.js:74-95`）。源码没有把该默认值绑定为 CMB、Au99.99 或 XAU/USD 的官方交易日历，因此不应把它视为任一产品的正式可交易时段。

上金所官方 Au99.99 页面给出的交易时间是日间 09:00-15:30、夜间 20:00-次日 02:30，并注明交易单位、报价单位和手续费口径，见[上海黄金交易所 Au99.99](https://www.sge.com.cn/h5_cpfw/xhsph_xq?pro_id=793730879941324800&parent_cplx=0&cplx=7)。因此，CMB、Au99.99、XAU/USD 不应共享一个“市场是否开放”的事实；当前单日历设计适合作为提醒开关，不足以证明每条行情都可交易。

覆盖率门槛定义于 `lib/market-quality.js:148-150`：

| 窗口 | 必须满足 |
| --- | ---: |
| 5 分钟 | `> 80%` |
| 10 分钟 | `> 80%` |
| 30 分钟 | `> 60%` |
| 60 分钟 | `> 60%` |

开盘后首小时和北京时间 00:00-01:00，在长窗口尚未满足时只检查 5/10 分钟（`lib/plan.js:419-428`）。质量 module 还检查 stale、OHLC、重复桶、预热、品种错配、源间偏差和 CMB 买卖价差（`lib/market-quality.js:157-218`）。

### 1.4 指标口径

指标实现位于 `lib/indicators.js`：

- SMA5/20/60：普通算术平均，`lib/indicators.js:70-75`。
- EMA：前 N 根 SMA seed，之后 `k=2/(N+1)`，`lib/indicators.js:77-93`。
- RSI14：Wilder 平滑，`lib/indicators.js:95-118`。
- ATR14：Wilder 平滑 true range，`lib/indicators.js:130-144`。
- Bollinger：SMA20 加减 2 倍总体标准差，`lib/indicators.js:120-128`。
- MACD：EMA12-EMA26，DEA 为 DIF 的 EMA9，`lib/indicators.js:146-161`。
- 支撑/压力：最近 20 根已收盘 K 的最低/最高，`lib/indicators.js:163-195`。

正式计划排除未收盘 5m/60m K；10m/30m 从已收盘 5m 重采样后再次过滤（`lib/plan.js:346-367`）。这是防止未完成 K 线泄露的重要正向控制。

---

## 2. 当前策略的精确规则

### 2.1 入场规则

`lib/plan.js:459-480` 的实际逻辑是：

```text
emaRising(period) = EMA20_current > EMA20_previous

trendUp =
  emaRising(10m)
  AND emaRising(30m)
  AND emaRising(60m)

nearSupport =
  (technicalPrice - recentLow20) / technicalPrice * 100
  <= nearSupportPct

nearLowerBand =
  technicalPrice <= BollLower * (1 + nearSupportPct / 100)

rsiRecovering =
  RSI14 > rsiOversold
  AND RSI14 < 50

aboveSma20 = technicalPrice > SMA20

buySetup =
  trendUp
  AND (nearSupport OR nearLowerBand)
  AND (rsiRecovering OR aboveSma20)
```

这里的 `rsiRecovering` 没有比较上一期 RSI，`aboveSma20` 也没有比较上一期价格，因此实现的是“当前位于阈值上方”，不是“从下向上穿越”。

建议买入技术价（`lib/plan.js:667-703`）：

```text
suggestedTechnicalPrice = min(
  technicalPrice + 0.1 / signalFactor,
  recentLow20 + ATR14 * atrFactor
)

suggestedSignalPrice = suggestedTechnicalPrice * signalFactor
suggestedCmbPrice = suggestedSignalPrice + cmbBuySpread
```

这是一张限价建议，不是已成交价格。

### 2.2 规则分数

`confidenceScore` 是 8 个二元条件相加：

1. 10m EMA20 上升；
2. 30m EMA20 上升；
3. 60m EMA20 上升；
4. 接近近 20 根低点；
5. 接近布林下轨；
6. RSI 位于 `(rsiOversold, 50)`；
7. 当前价高于 SMA20；
8. MACD histogram 为正。

默认阈值是 5（`lib/config.js:34`），但 `buySetup` 本身已经强制 3 个趋势分、至少 1 个位置分、至少 1 个触发分，天然至少为 5。因此默认阈值几乎没有额外过滤作用。配置和 UI 又允许阈值到 10，而理论最大值是 8（`lib/config.js:224`、`lib/client.js:4133`）；9/10 会静默关闭全部入场。

这些条件还存在明显相关性：三个 EMA 斜率、支撑与布林下轨、RSI 与 SMA/MACD 不是独立证据。当前分数应称为“规则强度分”，不能称为经历史校准的置信概率。

### 2.3 回本、目标和止损

空仓买入（`lib/plan.js:675-689`）：

```text
entryCost = suggestedCmbPrice + buyFee
breakeven = entryCost + sellFee + estimatedSpread + slippage

target = max(
  breakeven + minProfit,
  recentHigh20 - atrFactor * ATR + cmbSellSpread
)
```

持仓分支（`lib/plan.js:487-524`）：

```text
exitNeeded = avgCost + sellFee + estimatedSpread + slippage
pnl = (cmbSell - pnlSellFee - avgCost) * grams

target = max(
  exitNeeded + minProfit,
  recentHigh20 + cmbSellSpread - atrFactor * ATR
)

stopPrice = avgCost - maxLoss - pnlSellFee
```

当 CMB 为实时双边报价时，代码将客户卖出价视为已可执行价格，`pnlSellFee=0`；但 `exitNeeded` 仍添加 `sellFee + estimatedSpread + slippage`。这造成“当前 PnL”和“回本/目标”使用不同成本语义，需要官方产品协议和用户成本录入语义共同确认。

### 2.4 出场优先级

持仓时的隐式 `if/else` 优先级为：

```text
sell_take_profit
-> sell_stop
-> close_by_session_end
-> reduce_position
-> sell_trailing
-> sell_weakness
-> add_position
-> wait
```

实现位于 `lib/plan.js:526-610`。低优先级条件即使同时为真，也不会进入结果，因而无法统计冲突或被压制信号。

- `sell_take_profit`：可卖价到目标。
- `sell_stop`：可卖价到固定止损。
- `reduce_position`：有浮盈、RSI 超买、最后一根阴线且上影大于 ATR。
- `sell_trailing`：有浮盈且最后一根 5m 收盘低于 5m SMA20。
- `sell_weakness`：RSI 超过 `weaknessRsi`，并出现阴线吞没或上影超过 ATR 倍数；不要求浮盈。
- `close_by_session_end`：显式开启且距收盘不超过 30 分钟；默认关闭。

### 2.5 仓位和信号政策

仓位分档位于 `lib/sizing.js:52-97`：

```text
轻仓上限 = maxGrams * 20%
标准仓上限 = maxGrams * 60%
单次最大补仓 = max(1g, maxGrams * 10%)
```

持续满足条件时，仓位会从 20% 继续向 60% 再向 100% 补，并没有“达到标准仓后自动停止”的风险条件。止损和收盘了结可全平；其他卖出按 60%/20% 档位减仓。

`applySignalPolicy()`（`lib/sizing.js:159-240`）提供连续确认和同向冷却。仓位变化会清除上次动作、方向、时间和 streak；这防止旧信号继续作用于新仓位，也意味着同方向冷却不会跨越用户或模拟成交后的仓位变化延续。只读逐笔明细中，在 15 分钟冷却、2 根 5m 确认的参数下曾出现 10 分钟间隔的连续补仓；该现象与冷却时钟被重置一致，但还应通过显式状态轨迹测试确认完整因果链。

---

## 3. 运行时匿名基线

以下数据来自只读 GET，未触发新回放、通知或配置写入。这里只保留策略聚合，不记录真实持仓批次、成本、lot id 或凭据。

### 3.1 最近一次回放

最近落盘报告为 v4、默认 CMB 道：

| 指标 | 观察值 |
| --- | ---: |
| 请求交易日 | 10 |
| 有效交易日 | 9 |
| 跳过无数据日 | 1 |
| 方向性独立事件 | 120 |
| 连续账户交易 | 82 |
| 买入交易 | 66 |
| 其中补仓 | 63 |
| 卖出交易 | 16 |
| 期末仓位 | 100 克（达到上限） |
| 连续账户净结果 | -1466.90 元 |
| 独立信号质量加总 | -12609.60 元 |
| `buy_setup` 回本触及率 | 100% |

这个窗口不足以评价长期策略，但足以暴露三个工程现象：

- 连续账户在同一入场条件持续成立时会快速补到满仓；
- 独立事件统计与连续账户结果方向和量级差异很大，不能互相替代；
- 100% 回本触及率与代码中的方向错误一致，不是可信的策略优势。

### 3.2 数据质量和源健康

一次实时 snapshot 出现：

```json
{ "coverage": { "5": 1, "10": 0.5, "30": 1, "60": 1 } }
```

这是断点重锚算法的预期产物：长窗口在发现连续缺口后只对恢复段计分，可能比 10 分钟窗口更早显示 100%。这个数字缺少“有效观察分钟数”和“距最近大缺口时长”，容易被误读为真的拥有完整 30/60 分钟连续数据。

同一时点的数据源状态显示，CMB、USDCNY 和腾讯 XAU 可用，但多数 XAU 备用源、SGE/东财实时或 K 线源处于错误状态；国内报价随后由新浪恢复。它说明 fallback 代码存在，不等于运行时具备同等数量的有效冗余。应为每条关键数据依赖定义可用率、连续失败时长和至少两个经过周期性验证的 adapter。

---

## 4. P0：先修正这些问题，再解释回放收益

## P0-1 多头回本触及的 OHLC 代理方向不符合可执行卖价语义

**证据**：`lib/replay-stats.js:476-486`。

当前逻辑：

```js
if (breakeven !== null && bar.l <= breakeven) breakevenTouched = true;
```

若 `breakeven` 表示多头平仓所需的可执行卖价阈值，则该条件会把“未来最低价低于回本线”视作命中，不能证明卖价曾上行达到回本线；如果整根 K 都在回本线下方，也会被计为回本。

最小复现：入场 100、回本 105，未来 K 的最高 102、最低 99，当前结果仍是 `true`。

**影响**：

- 该 OHLC 代理会制造明确的假阳性；
- 当前报告中的 100% 触及率必须在修正口径后重算，不能作为策略优势；
- 用户可能把代理统计理解为真实可执行卖价已经覆盖成本。

**修复原则**：

- 使用该交易道的可执行 bid 路径，而不是买价或未声明方向的 OHLC；
- 只在 `executableBid >= breakeven` 时确定命中；
- 缺少双边路径时标记为 proxy 或 unknown；
- 增加“最高价低于回本线必须 false”“跳空越过回本线”“缺少卖价为 unknown”测试。

## P0-2 建议限价被立即当作成交价

**证据**：

- 信号在 `lib/replay-stats.js:803-823` 以当前 5m 收盘重建；
- `lib/replay-stats.js:824` 立即调用 `executeReplayTrade()`；
- `lib/client.js:544-546` 还把它描述为“K 线收盘后确认并按此时模拟成交”。

建议买价是 `min(current+step, recentLow+ATR*factor)`，可能显著低于当前价格。回放没有检查后续低点是否触及该限价，也没有 pending、expired、cancelled 或 partial fill。结果是“发出一张限价建议单”被等价为“这一刻已成交”。

**影响**：

- 买入可获得不存在的有利成交价；
- 成交率固定为 100%，交易数、成本和仓位路径失真；
- 当前 63 次补仓和期末满仓可能部分来自虚构成交；
- `validUntil` 和挂单生命周期在实盘有意义，在回放中完全失效。

**修复原则**：

```text
signalAt = 触发 K 的收盘
eligibleAt = signalAt + 最小执行延迟
pending order = { limit, side, remaining, validUntil }
fill = eligibleAt 后真实 bid/ask 或更高频路径满足限价
未触及 = pending/expired，不成交
```

默认统计应使用下一条可交易双边报价；`next-open`、30/60/120 秒延迟和信号收盘成交只能作为敏感性场景。

## P0-3 同一 K 同触目标和止损时固定判目标先到

**证据**：`lib/replay-stats.js:476-484` 先检查 target，再检查 stop。

若同一 5m K 满足：

```text
High >= target AND Low <= stop
```

只有 OHLC 无法知道真实先后。当前 `firstTouch` 永远是 `target`，只取决于代码顺序。

**修复原则**：

- 优先使用更高频、方向正确的 bid/ask；
- 无法恢复路径时标记 `ambiguousBar`；
- 默认采用保守路径，另报 best/worst 区间；
- 报告必须显示双触及数量及其对收益、目标率和回撤的影响。

## P0-4 CMB 执行成本语义不统一

相关实现分散在：

- `lib/plan.js:368-378`：live CMB PnL 不再扣卖出费；
- `lib/plan.js:493-524`：回本和目标仍添加卖出费、估算点差和滑点；
- `lib/replay-stats.js:174-181`：CMB 卖价固定为买价减 5；
- `lib/replay-stats.js:334-337`：卖出又扣配置卖出费和滑点；
- `lib/replay-stats.js:379-386`：期末未卖出仓位按末端价格扣卖出费和滑点清算；该扣减对应尚未发生的最终卖出，本身不应单独视为重复计费；
- `lib/replay-stats.js:426-428`：独立事件使用另一套总成本公式。

如果 `customerBuy/customerSell` 被定义为用户在该时点可实际成交的双边报价，则 bid/ask 差已经体现在买卖现金流中；任何额外 `sellFee`、`estimatedSpread`、`slippage` 都必须有明确且彼此不重叠的业务定义。现有 interface 无法区分“银行报价内点差”“报价外显式费用”“fallback 估算点差”和“回放滑点”，因此目前只能确认成本语义跨 module 不透明、难以逐项对账，不能在未核对正式协议前断言每个额外扣项都一定重复。招商银行的[黄金账户产品页](https://www.cmbchina.com/personal/invest/investInfo?guid=4e148bbf-19ff-4662-a923-eaa2030549e4)和[黄金账户协议更新通告](https://www.cmbchina.com/Main/NoticeInfo.aspx?guid=089bc872-faa0-45ec-a692-efbeb9b97d69)应作为最终产品语义核对入口。

**修复原则**：建立唯一执行账本，并为每一项成本声明来源和适用条件：

```text
buyCost = executableAsk + explicitBuyFee + buySlippage
sellProceeds = executableBid - explicitSellFee - sellSlippage
pnl = sellProceeds - buyCost
```

“估算点差”只在缺少真实双边报价时使用，而且必须标记 synthetic。计划、snapshot、连续账户、独立事件和 UI 全部调用同一个 module。

## P0-5 动态 CMB fallback 校准混淆中间价与买卖价

**证据**：

- 采样：`spreadMid=(buy+sell)/2-xauCny`，`lib/history.js:199-213`；
- 估算：该值同时赋给买卖偏移，`lib/plan.js:294-299`；
- clamp 锚只使用 `cfg.cmb.sellSpreadPerGram`，`lib/plan.js:297`；
- 负值被夹到 0，`lib/spread-stats.js:80-88`。

中间价偏移不能直接当客户买价偏移。如果真实报价是 `buy=base+2.5`、`sell=base-2.5`，采样的 mid 偏移接近 0；fallback 随后却生成 `buy=base`、`sell=base`，丢失半边点差。`dynamicCmbSpread()` 又将第三个参数 `staticSpreadPerGram` 作为 clamp 锚，当前生产调用传入 `cfg.cmb.sellSpreadPerGram`；因此当该配置值为 0 时，即使 30 个样本中位数全为正，动态结果仍会被夹到 0。该边界已用最小输入复现。

**修复原则**：至少持久化并估计两个量：

```text
buyOffset = customerBuy - referenceBase
sellOffset = customerSell - referenceBase
```

更完整的模型是 `midBasis + halfSpread`，并按时间段报告 P50/P90。不得把 mid basis 同时当 bid/ask offset。

## P0-6 fallback 止损违反最大亏损语义

**证据**：`lib/plan.js:493-524`。

fallback PnL 定义为：

```text
netPerGram = cmbSell - sellFee - avgCost
```

若要求 `netPerGram <= -maxLoss`，则触发报价阈值应满足：

```text
cmbSell <= avgCost - maxLoss + sellFee
```

当前代码却使用：

```text
stopPrice = avgCost - maxLoss - sellFee
```

手续费符号相反。合成案例：平均成本 100、最大亏损 2、卖出费 5，当前实现到 `cmbSell=93` 才止损；有效退出价为 88，净亏 12。

**修复原则**：止损直接在统一账本的 `effectiveExitPnlPerGram` 上判断，避免手工反推阈值再次出错。live 与 fallback 必须通过同一参数化测试。

## P0-7 数据不完整时持仓浮盈亏被显示为 0

`computePlan()` 在质量门控后才进入持仓分支（`lib/plan.js:777-795`）。一旦返回 `data_incomplete`，没有 `plan.position`；`buildSnapshot()` 的 fallback 则硬编码 `feeAdjustedPnl: 0`（`lib/snapshot.js:262-268`）。

技术指标不足应阻止新建议，但只要有新鲜可执行卖价和用户持仓，当前估值和浮盈亏仍可独立计算。把未知策略状态显示为 0 会把实际亏损误呈现为“不盈不亏”。

**修复原则**：

- 将 `PortfolioValuation` 与 `StrategyDecision` 分离；
- PnL 只依赖持仓、可执行价格和执行成本质量；
- 不可计算时返回 `null + reasonCode`，绝不返回伪造的 0；
- stale/缺少卖价时明确显示“无法估值”。

## P0-8 活跃交易日被当作完整时段末

`listReplayTradingDays()` 明确包含尚未开盘或正在进行的今天（`lib/replay-stats.js:120-153`）。每日回放把当天最后一根现有 K 加 5 分钟定义为 `sessionEndMs`（`lib/replay-stats.js:696-699`），后续 UI 却统一称“持有至时段末”。

这会把完整历史日和当前部分日混在同一统计中，盘中结果被误标为收盘结果。

**修复原则**：默认只统计已完整结束的 session；若选择包含当前日，应使用 `markToAsOf` 字段和独立分组，不能进入 `sessionEnd*` 指标。

---

## 5. P1：策略、数据和统计有效性

## P1-1 文档中的“上穿/回升”并未实现

`DESIGN.md:314` 描述“RSI 从 <35 回升并上穿 35，或重新站上 SMA20”，实际 `lib/plan.js:469-471` 只看当前值。根目录 `eli5-goldboard-strategy.html:154-155` 也延续了“缓过来/重新站上”的表述。

可选方向只有两个：

- 若产品需要 crossing trigger，计算前一期 RSI 和前一期 close/SMA；
- 若产品只需要 state condition，把命名和文案改为“RSI 位于 35-50/价格高于 SMA20”。

同类漂移还包括：

- `DESIGN.md:323` 的目标含布林上轨，当前目标公式不含；
- `DESIGN.md:332` 写 15m EMA20，当前移动止盈使用 5m SMA20；
- `DESIGN.md:39/322` 写最大投入金额，实际配置只有 `maxGrams`；
- `DESIGN.md` 的统计章节仍残留 v3 独立事件总览，而当前为 v4 连续账户。

## P1-2 规则分数没有校准，默认阈值冗余

当前分数最多 8，默认买入硬条件天然至少 5，配置却允许 1-10。当前回放分箱中 6 分和 >=7 分也没有稳定单调优势，且样本很少。

优化方向：

1. 先改名为 `ruleScore`；
2. 按“趋势、位置、触发、动量”四个 feature family 计分，避免同族重复加权；
3. 报告每个分数桶的样本数和置信区间；
4. 只有在独立样本外数据上出现稳定单调关系后，才映射为概率或 `low/medium/high`；
5. schema 最大值收紧到真实 `CONFIDENCE_MAX`。

## P1-3 仓位按克数而非风险预算

当前最大克数在金价变化后代表不同资金暴露，止损又是固定元/克。没有账户权益、最大投入金额、单笔风险、日损失、最大回撤或连续亏损降风险。

建议引入：

```text
stopDistance = max(k * ATR, bidAskBuffer, slippageBuffer)
riskPerGram = stopDistance + executionCosts
suggestedGrams = floor(accountRiskBudget / riskPerGram)
```

再受 `maxGrams/maxAmount/liquidityCap` 约束，并增加：

```text
maxDailyLoss
maxWeeklyLoss
maxPortfolioDrawdown
consecutiveLossDeRisk
volatilityTarget
```

每张建议单应显示“最坏情景亏损金额”和“占风险预算比例”，而不是只显示克数。

## P1-4 持续信号会逐步补到满仓

当前 20%/60% 只是途经档位，不是停止条件；仓位变化还会重置冷却。运行时连续账户的 66 次买入中有 63 次 `add_position`，最终达到 100% 上限。

建议增加：

- 每个 setup 的唯一 id，同一 setup 最多执行 N 次；
- 加仓必须有相对上次成交的最小价格改善或新信息；
- 最大单日加仓次数和总风险增量；
- 不利方向加仓与盈利金字塔分开配置；
- 成交后保留 cooldown，不因持仓更新自动消除。

## P1-5 信号生成和执行标的应解耦实验

CMB、XAU/USD 和 Au99.99 的市场微观结构不同，却共享 RSI、ATR、支撑距离和固定止损参数。CMB 客户价包含银行产品点差且采样历史较短，不一定是最佳技术信号序列；反过来，Au99.99/XAU 信号也不能直接证明 CMB 可执行收益。

建议比较但不预设答案：

| 信号 | 执行 | 目的 |
| --- | --- | --- |
| CMB | CMB bid/ask | 当前口径基线 |
| XAU/USD | CMB bid/ask | 更连续的国际趋势信号 |
| Au99.99 | CMB bid/ask | 国内时段与溢价信号 |
| XAU + 国内溢价 regime | CMB bid/ask | 拆分全球方向与本地基差 |

所有组合必须使用同一 CMB 执行账本，按产品独立报告，不合并成一个“黄金策略”命中率。

## P1-6 时间戳与依赖新鲜度未闭合

腾讯 USDCNY 上游时间采用 `YYYYMMDDhhmmss`。最小复现输入 `20260828200250` 时，`parseQuoteTimestamp()` 得到 `2026-08-28T12:02:50.000Z`；同一数字字符串进入 `normalizeQuoteRecord()` 的 `iso()` 路径后，`Date.parse` 失败并被当作 epoch 毫秒，得到 `2612-01-16T07:50:00.250Z`（`lib/market-quality.js:27-33`）。这证明 compact 数字时间在两条规范化路径中的语义不一致；不是假定所有腾讯记录都会无条件出错。

此外，XAU fallback 的有效性依赖 XAU 和 USDCNY 两条数据：

- `computePlan()` 主要用 `updatedAt` 判断两者 stale（`lib/plan.js:763-770`）；
- `assessMarketQuality()` 只接收 selected XAU quote，不单独检查 FX source timestamp；
- XAU 的 date/time 也未稳定写入统一 `sourceTimestamp`。

建议在 parser adapter seam 一次性产出：

```text
sourceTimestamp
receivedAt
ingestedAt
sourceDelayMs
futureSkewMs
```

复合报价必须汇总每个 dependency 的质量，任何一项 stale/future/invalid 都阻止新开仓。

## P1-7 10m/30m 重采样应按时间桶而非数组起点

`resampleBars()` 在每个连续 run 内按 `slice(index,index+factor)` 分组，并用最后子 K 的时间对齐（`lib/indicators.js:34-42`）。如果 run 因缺口从 10:15 开始，30m 分组可能把 10:15-10:40 合成一个标成 10:30 的桶，跨越自然 30m 桶。

应按 `alignStart(bar.t, intervalMinutes)` 分组，再检查桶内预期子 K 数、跨度和闭合状态。缺子 K 时可生成 `partial` 但不得进入正式趋势指标。

## P1-8 断点重锚缺少有效样本长度

`windowCoverage()` 遇到连续 8 个缺失交易分钟后，删除缺口尾部并停止向前扫描（`lib/market-time.js:117-167`）。这让恢复后的 6 个样本足以使 30/60m 覆盖率显示 100%。

建议质量结果同时返回：

```text
coverageRatio
effectiveSampleMinutes
minutesSinceLastGap
largestGapMinutes
reanchored
```

保护性止损可在恢复后继续，但新开仓至少等待完整 10m trigger，并对长周期趋势标记“跨缺口上下文”。

## P1-9 回放样本太短且没有样本外验证

默认 10 日、最多 30 日（`lib/replay-stats.js:63-67`），CMB 又受本地 1440 根 5m 滚动窗口约束。用户反复调参后重跑同一短窗，会产生数据窥探和选择偏差。

最低验证框架：

```text
数据：至少覆盖 12-24 个月和多种波动/趋势 regime
训练窗：6 个月
测试窗：随后 1 个月
步进：1 个月
参数：测试段冻结
成本：真实 bid/ask + 延迟/滑点压力
```

参数搜索需记录试验次数、候选参数空间、训练/测试划分和所有未被展示的结果，防止只呈现反复尝试后的最佳结果。本文不把短样本回放视为统计显著性或样本外优势的证据。

## P1-10 当前统计缺少风险和不确定性

连续账户只有期末净收益、已实现/未实现、交易数和卖出胜率。至少应补：

- 每步 equity curve、峰值和最大回撤；
- 回撤持续期、暴露时间、资金使用率；
- 毛收益、手续费、点差、滑点分别合计；
- turnover、profit factor、平均持有期；
- 日收益波动、Sharpe、Sortino、Calmar；
- 胜率 Wilson 区间和收益 block bootstrap 区间；
- 与不交易、CMB 买入持有、固定节奏定投、简单单均线基准比较；
- 完整日/部分日、真实双边/合成、各信号道分组。

没有权益曲线时，“期末净收益”不能描述中途风险。

## P1-11 当前日历和 source 冗余需要运营验证

节假日默认空数组，且 CMB、SGE、XAU 共用一个配置日历。建议：

- 每个 adapter 暴露自身 market calendar/quote availability；
- CMB 提醒日历以官方产品规则为准并支持版本化更新；
- 新开仓需要执行标的确认可交易，不能仅凭参考行情活跃；
- 每日低频探测备用 adapter，避免只有主源故障后才发现所有备用源同时失效；
- 给核心 dependency 定义健康 SLO 和“实际冗余数”。

---

## 6. P2：相关功能和维护问题

### 6.1 Generic Webhook 测试分支缺少 sender 导入

`lib/routes.js:13-21` 没有导入 `sendGeneric`，但 `lib/routes.js:450-454` 调用它；调用该分支会先抛出 `ReferenceError`。现有测试覆盖生产 dispatch，没有通过 `/test-notify` route interface 覆盖 generic 测试分支。

短期补 import，并增加 Generic ID 不存在、发送成功和发送失败的 route 集成测试。结构上应让 route 调用统一的 outbound module，而不是自己了解每个 sender。`deps.post` 未注入不是另一项故障：显式传入 `undefined` 时，`postJson(..., post = defaultPost)` 的默认参数会生效。

### 6.2 Webhook 存在 Host 侧 SSRF 面

`/test-notify` 可接受浏览器草稿覆盖 URL/headers，`sendGeneric()` 直接由 Host fetch（`lib/alerts.js:517-521`），没有 scheme、DNS、私网、redirect 或危险 header 策略。若 GUI 可被其他主体访问，可能形成盲 SSRF。

建议一个实例级 `WebhookTransport` interface，集中执行 URL/DNS/redirect 校验、header allowlist、超时、取消、签名和错误脱敏。至少默认只允许 HTTPS，拒绝 loopback、RFC1918、link-local、云 metadata 和重定向到私网。

### 6.3 public interface 过宽

`lib/public-api.js` 将 parser、storage、source registry、route helper 和 `__setFetchImpl` 等测试 hook 都从 package root 暴露。调用者可以绕过原本的 module seam，使实现细节变成兼容承诺。

建议 package root 只保留 Cordis plugin contract 和明确文档化的领域 interface；测试从内部路径导入，必要时提供 `./testing` export。

### 6.4 客户端真实维护 interface 过大

`lib/client.js` 为 4532 行 factory-CJS，包含 CSS、双语词典、请求、图表、浮窗、设置、回放、模型和日志。部分测试通过源码 marker、`new Function` 或 Hook 顺序提取内部逻辑。bundle-global settings binding 还假设同一页面永远只有一个 client instance。

最终仍可打包为一个 factory，但内部应先抽出可直接测试的：

```text
GoldboardApi
SettingsAdapter
SnapshotStore
ChartModel
StatsViewModel
```

### 6.5 独立说明页已经过时

- `eli5-goldboard-strategy-stats.html` 仍以 v1.8 为基线，写“只用 Au99.99”，没有默认 CMB 道和 v4 连续账户。
- `eli5-goldboard-strategy.html` 停在 v1.9，并把 threshold state 描述为 RSI 回升/SMA 重新站上。
- `DESIGN.md` 同时存在 v3 和 v4 统计语义。

应在策略语义确定并修复后统一更新；在此之前，为页面加明确版本和“与当前代码可能不同”的提示。

---

## 7. 建议的 deep module 结构

### 7.1 当前值得保留的深模块

**SourceRegistry**

- Interface：按用途请求报价和历史。
- Implementation：多 provider、编码、fallback、熔断、总预算、日志。
- Depth：查询 interface 隐藏了多 provider 的传输、fallback、熔断和总预算；删除该 module 后，这些复杂度会重新分散到多个 caller，说明它正在产生实际 leverage。

**AnalysisModule**

- Interface：注入 llm/context/config/log，返回受约束结构结果。
- Implementation：模型目录、缓存、单飞、超时、stream、schema、脱敏、审计。
- Depth：较高；且 prompt 明确禁止生成买卖指令（`lib/analysis.js:309-325`）。

**MarketQuality**

- 已集中多数质量事实，是正确 seam；下一步应把复合依赖和 gap 语义继续吸收进去，而不是让 plan 重复判断。

### 7.2 ExecutionModel

建议 interface：

```js
execution.quote({
  lane,
  side,
  referenceQuote,
  cmbQuote,
  asOf,
  costConfig,
}) => {
  executablePrice,
  bid,
  ask,
  explicitFeePerGram,
  slippagePerGram,
  synthetic,
  quality,
  components,
}

execution.valuePosition(portfolio, executableQuote)
execution.stopThreshold(portfolio, maxLoss, executableQuote)
```

实现内部隐藏 live/fallback、双边价、费用、滑点、rounding 和成本基础语义。live CMB 报价路径与 history/replay 价格路径已经表现出真实可变性，因而为 `ExecutionModel` 建立 seam 有现实依据；实现后，它们可以分别成为满足该 interface 的 adapter，而不是继续让 plan、snapshot 和 replay 各自拼接价格与成本。

### 7.3 StrategyEngine

建议将现在“几乎纯但会改 runtime.laneState”的接口改为：

```js
strategy.evaluate({
  marketFrame,
  portfolio,
  params,
  previousState,
  asOf,
}) => {
  decision,
  valuation,
  nextState,
  activeSignals,
  suppressedSignals,
  quality,
}
```

调用者不再传整个 runtime，也不需要知道 lane stickiness 和 signal policy 的内部状态结构。StrategyEngine 的 caller 和针对 StrategyEngine 的测试通过同一 interface 交互；ExecutionModel、ReplaySimulator、MarketQuality 各自也拥有可独立测试的 interface，组合测试再验证它们之间的协作。

### 7.4 ReplaySimulator

```js
replay.run({
  frames,
  strategy,
  execution,
  initialPortfolio,
  fillPolicy,
  ambiguityPolicy,
}) => {
  orders,
  fills,
  ledger,
  equityCurve,
  metrics,
  diagnostics,
}
```

ReplaySimulator 负责时间推进和订单状态，不复制成本公式；StrategyEngine 只生成决策，不假装成交。ReplaySimulator 的测试通过自身 interface 注入 StrategyEngine 和 ExecutionModel 的 adapter，验证 fill、ledger 和 equity 行为。

### 7.5 MarketQuality

```js
quality.assess({
  instrument,
  dependencies,
  bars,
  requiredWindows,
  session,
  asOf,
}) => {
  status,
  reasonCodes,
  warnings,
  coverage,
  effectiveSampleMinutes,
  gap,
  dependencies,
}
```

XAU 折算时 `dependencies` 必须同时包含 XAU 和 USDCNY；CMB fallback 还应包含 calibration quality。

### 7.6 目标数据流

```text
MarketDataGateway
  -> normalized MarketFrame + dependency quality
  -> StrategyEngine -> Decision + Valuation + nextState
  -> OrderTracker（实时建议单）
  -> ReplaySimulator（历史订单/fill/ledger）
  -> ReportProjector / SnapshotProjector
```

这能产生：

- **Leverage**：一套执行账本同时服务实时、回放、UI 和测试；
- **Locality**：费用或 bid/ask 修复只改 ExecutionModel；
- **可测试性**：caller 与测试跨同一 interface；
- **Depth**：调用者只表达意图，不再拼接价格和成本细节。

---

## 8. 拟议 wire/schema 变化

研究阶段不直接修改接口。实现时建议将 replay report 升到 v5，并保留 v4 只读展示：

### 8.1 历史报价

```json
{
  "t": "...",
  "lane": "CMB",
  "bid": 989.96,
  "ask": 994.96,
  "sourceTimestamp": "...",
  "receivedAt": "...",
  "source": "cmb",
  "synthetic": false,
  "quality": "primary"
}
```

### 8.2 决策和订单

```json
{
  "decisionId": "...",
  "signalAt": "...",
  "activeSignals": ["trend_up", "near_support"],
  "suppressedSignals": ["sell_weakness"],
  "selectedAction": "buy_setup",
  "order": {
    "side": "buy",
    "type": "limit",
    "limitPrice": 995.0,
    "validUntil": "..."
  }
}
```

### 8.3 fill 和账本

```json
{
  "orderId": "...",
  "eligibleAt": "...",
  "fillAt": "...",
  "status": "filled",
  "bid": 990.0,
  "ask": 995.0,
  "fillPrice": 995.1,
  "feeCny": 0,
  "slippageCny": 1.0,
  "quoteSource": "cmb",
  "synthetic": false,
  "ambiguousBar": false
}
```

### 8.4 report

新增：

```text
equityCurve
maxDrawdown / drawdownDuration
exposure / turnover / profitFactor
costBreakdown
fillRate / expiryRate / averageDelay
ambiguousBarCount
realBidAskCoverage
completeDays / partialDays
oos flag / fold id
confidence intervals
benchmark results
```

迁移规则：

- v4 报告继续可读，但显示“旧执行口径，不可与 v5 比较”；
- 新配置节使用默认值兼容旧 settings；
- 双边历史与旧单边 bars 分开版本化，不能静默把旧 bars 当真实 bid/ask；
- UI 不把缺失 v5 字段补成 0。

---

## 9. 验证实验

## 实验 A：成交时点和成交率

比较：

```text
信号收盘立即成交（仅上界）
下一 K 开盘
下一可得 bid/ask
延迟 30/60/120 秒 bid/ask
真实限价 pending/expiry
```

输出净收益、回撤、成交率、平均延迟、价格偏离、成本占毛收益比例。策略优势不能只存在于“信号收盘立即成交”。

## 实验 B：成本与 CMB 点差压力

使用真实历史双边报价；缺失时单独测试 3/5/7/10 元点差和 0.5x/1x/2x/3x 滑点。报告实际点差 P50/P90/max、双边缺失率和 break-even 成本。

## 实验 C：OHLC 路径歧义

对同 K 双触及分别计算真实高频、保守、乐观路径，报告事件数和绩效区间。默认使用真实或保守路径。

## 实验 D：Walk-forward 样本外

至少 12-24 个月，6 个月训练、1 个月测试、按月滚动。每折冻结参数，分别覆盖趋势、震荡、高波动、低波动和源故障阶段。

## 实验 E：规则消融与冲突

依次比较：

```text
仅多周期趋势
+ 支撑/布林位置
+ RSI/SMA crossing
+ MACD
+ 每个出场规则
+ 加仓规则
```

记录 active/suppressed 冲突组合和反事实结果，确认复杂规则是否真的增加样本外收益或降低回撤。

## 实验 F：风险仓位

比较固定克数、ATR 风险预算、固定权益比例和波动率目标。输出单笔风险、日损失、最大回撤、资金利用率和尾部损失。

## 实验 G：信号道组合

在同一 CMB 执行账本下，比较 CMB/XAU/Au99.99 信号及国内溢价 regime；报告各自数据完整度、切换次数、OOS 结果，禁止跨产品混合统计。

## 实验 H：未来宏观因子

当前代码没有 CPI、利率、就业、美元指数、ETF 流量或央行购金数据；`lib/analysis.js:316` 还明确禁止模型捏造宏观事实。因此当前策略没有宏观择时能力，也没有已经实现的发布时间泄露。

若未来加入宏观/事件过滤，必须保存：

```text
observationPeriod
releaseTimestampUtc
firstAvailableTimestampUtc
vintageId
revisionTimestampUtc
tradableAfterTimestampUtc
```

ALFRED 官方说明其用途是取回特定历史日期当时可获得的数据版本，见[Archival FRED / ALFRED](https://alfred.stlouisfed.org/)。CPI 和 FOMC 事件时间应分别来自[BLS CPI 发布日历](https://www.bls.gov/schedule/news_release/cpi.htm)与[Federal Reserve FOMC 日历](https://www.federalreserve.gov/monetarypolicy/fomccalendars.htm)。

World Gold Council 的[Gold Return Attribution Model](https://www.gold.org/goldhub/tools/gold-return-attribution-model)可用于提出美元、利率、风险等候选因子，但不能替代本策略自己的点时、样本外和执行验证。

---

## 10. 分阶段优化路线图

| 阶段 | 工作 | 依赖 | 退出标准 |
| --- | --- | --- | --- |
| 0 | 暂停把旧回放当收益证据；UI 标明旧口径 | 无 | 用户不会把 v4 数字理解为可成交业绩 |
| 1 | 修回本方向、fallback 止损、PnL=0、同 K 歧义 | 单元/回归测试 | 所有最小反例通过 |
| 2 | 建立 ExecutionModel，统一 live/fallback/replay 成本 | 官方费用语义 | 同一交易跨模块逐项对账一致 |
| 3 | 持久化真实 CMB bid/ask、修时间戳和质量依赖 | 数据 schema v2 | 可报告真实双边覆盖率和延迟 |
| 4 | ReplaySimulator 加 pending/fill/expiry/equity | 阶段 2/3 | 默认回放只用可执行成交 |
| 5 | 完整日、长历史、walk-forward、风险指标和基准 | 足够历史 | 有冻结参数的 OOS 结果 |
| 6 | 风险预算、加仓约束、规则消融、信号道实验 | 阶段 5 | 优化在多个 OOS fold 稳定 |
| 7 | Webhook、client runtime、文档和发布链路整理 | 可并行 | 外围功能达到同等可靠性 |

建议工作量优先级：

| 优先级 | 项目 | 影响 | 粗略工作量 |
| --- | --- | --- | --- |
| P0 | 回本方向、止损符号、估值 0 | 直接错误 | 小 |
| P0 | 统一执行成本 | 所有 PnL/目标/止损 | 中 |
| P0 | 真实订单成交模拟 | 回放可信度 | 中到大 |
| P0 | 双边历史数据 | CMB 回放基础 | 中 |
| P1 | 完整日和权益曲线 | 风险统计 | 中 |
| P1 | Walk-forward/OOS | 策略有效性 | 大，且需等待数据 |
| P1 | 风险预算和加仓约束 | 实际风险 | 中 |
| P1 | 时间戳、重采样、coverage 语义 | 数据可信度 | 中 |
| P2 | Webhook/client/public interface | 外围可靠性 | 中 |
| P2 | DESIGN/ELI5/README 同步 | 用户理解 | 小 |

---

## 11. 测试现状与应补测试

基线验证：

```text
node --check lib/index.js lib/client.js：通过
node --test：194/194 通过
```

当前环境没有 `pnpm`；`package.json` 的 `test` 脚本实际为 `node --test`，因此不影响上述测试语义。

现有测试覆盖：

- parser、指标和已收盘 K；
- 覆盖率、预热和质量门控；
- 信号道切换；
- 确认与冷却；
- 弱势 K 和价差告警；
- config/settings 迁移；
- 回放确定性、缓存、失败、取消和持久化；
- 连续账户基本加减仓账本；
- 客户端词典、图表和统计投影。

“测试全绿”只说明实现符合当前测试定义，不说明定义本身正确。必须新增的反例：

1. `high < breakeven` 时回本命中必须 false；
2. 限价未触及时不得成交，过期后状态为 expired；
3. 同 K 双触及标记 ambiguous，默认保守；
4. live bid/ask 下费用不重复，fallback 逐项可对账；
5. fallback 最大亏损 2 元时有效 PnL 到 -2 即触发；
6. 数据 incomplete 但卖价新鲜时 PnL 仍正确；
7. 活跃交易日不进入 session-end 指标；
8. 仓位变化后 cooldown 的预期语义明确；
9. compact 数字时间、epoch 毫秒和 ISO 字符串分别规范化为预期日期，不得产生远未来时间戳；
10. XAU stale 或 FX stale 都阻止复合报价新开仓；
11. 10m/30m 在非自然桶起点和缺 K 时不跨桶；
12. `scoreThreshold > 8` 在 schema 层拒绝；
13. `cfg.cmb.sellSpreadPerGram=0` 作为 clamp 锚时，动态校准要么保持可解释结果，要么在配置层明确禁用；
14. `/test-notify` generic 分支通过 route interface；
15. v4 报告不会被 UI 误标成 v5 可成交结果。

---

## 12. 可复核证据记录

### 12.1 只读运行时观察

以下观察均通过 GET 完成，没有触发回放生成、通知或配置写入：

- `GET /dsh-plugin-goldboard/snapshot`：响应 `serverTime=2026-08-28T12:00:45.665Z`；信号道为 CMB，质量状态因 10m 覆盖不足被阻断，覆盖率为 `{5:1,10:0.5,30:1,60:1}`。响应中存在非零持仓和新鲜 CMB 双边价，但 snapshot 的 fallback 持仓估值为 0；本文未保留持仓克数、成本和 lot id。
- `GET /dsh-plugin-goldboard/replay-stats`：报告 `generatedAt=2026-08-28T08:22:47.273Z`、version 4、请求 10 日/有效 9 日/跳过 1 日；连续账户 82 笔、期末 100 克、总结果 -1466.90 元；独立信号 120 条、质量加总 -12609.60 元；`buy_setup.breakevenTouchedRate=1`。
- `GET /dsh-plugin-goldboard/replay-stats?detail=true`：82 笔中 3 笔 `buy_setup`、63 笔 `add_position`、6 笔 `sell_take_profit`、10 笔 `sell_trailing`。在报告参数 `signalCooldownMinutes=15`、`confirmBars=2` 下，明细出现 10 分钟间隔的连续补仓；该观察用于提出状态轨迹测试，不作为唯一因果证明。
- `GET /dsh-plugin-goldboard/data-sources`：观察时 CMB、USDCNY、腾讯 XAU 可用，多个 XAU 备用源和 SGE/东财源报告错误；国内新浪源在后续轮询恢复。该结果是单次运营快照，不代表长期可用率。

### 12.2 最小合成复现

| 问题 | 输入 | 当前输出 |
| --- | --- | --- |
| 回本 OHLC 代理 | entry=100, breakeven=105, future high=102, low=99 | `breakevenTouched=true` |
| 同 K 双触及 | target=110, stop=90, future high=111, low=89 | `targetHit=true`, `stopHit=true`, `firstTouch=target` |
| fallback 止损 | avgCost=100, maxLoss=2, sellFee=5, cmbSell=93 | `sell_stop`，effectiveExit=88，净亏=-12 |
| compact 时间 | `20260828200250` | parser=`2026-08-28T12:02:50Z`，normalize sourceTimestamp=`2612-01-16T07:50:00.250Z` |
| 动态 spread clamp | 30 个 `spreadMid=2.5`，第三参数 `staticSpreadPerGram=0` | `{spread:0,sampleCount:30}` |

这些复现直接调用当前导出的纯函数，没有写文件。对应命令使用 Node ESM import 调用 `computeForwardOutcome`、`computePlan`、`parseTencentForexQuote`、`parseQuoteTimestamp`、`normalizeQuoteRecord` 和 `dynamicCmbSpread`。

### 12.3 基线验证记录

```text
node --check lib/index.js && node --check lib/client.js
结果：通过

node --test
结果：194 passed, 0 failed
耗时：46573 ms
```

完整测试通过与上述反例不矛盾：现有测试断言的是当前定义，没有覆盖这些反例或可执行成交语义。

---

## 13. 最终判断

当前 Goldboard 最合适的定位是：

```text
带行情质量门控、透明技术规则、持仓成本提示、建议单和提醒能力的黄金辅助看板。
```

当前不应定位为：

```text
已经通过可执行成交、长期样本外和风险调整验证的黄金交易系统。
```

它的优化空间不是简单再加几个指标。最高价值方向是把“参考行情、技术信号、银行执行报价、真实费用、订单成交、账户权益”拆成清晰事实，再由少量深 module 统一起来。这样才能先让每个数字可对账，再判断策略是否有样本外优势。

在 P0 修复和足够双边历史积累前，不应依据当前回放调整真实仓位；修复后也应先以 walk-forward、成本压力、基准比较和回撤约束验证，再决定是否保留复杂信号、加仓规则或宏观因子。

## 参考资料

- [招商银行：黄金账户](https://www.cmbchina.com/personal/invest/investInfo?guid=4e148bbf-19ff-4662-a923-eaa2030549e4)
- [招商银行：关于更新黄金账户业务服务协议书的通告](https://www.cmbchina.com/Main/NoticeInfo.aspx?guid=089bc872-faa0-45ec-a692-efbeb9b97d69)
- [上海黄金交易所：Au99.99](https://www.sge.com.cn/h5_cpfw/xhsph_xq?pro_id=793730879941324800&parent_cplx=0&cplx=7)
- [LBMA Gold Price](https://www.lbma.org.uk/prices-and-data/lbma-gold-price/lbma-gold-price)
- [LBMA Precious Metal Benchmarks](https://www.lbma.org.uk/publications/the-otc-guide/precious-metal-benchmarks)
- [CME Gold Futures Contract Specifications](https://www.cmegroup.com/markets/metals/precious/gold.contractSpecs.html)
- [World Gold Council: Gold Return Attribution Model](https://www.gold.org/goldhub/tools/gold-return-attribution-model)
- [BLS Consumer Price Index Release Schedule](https://www.bls.gov/schedule/news_release/cpi.htm)
- [Federal Reserve FOMC Calendars](https://www.federalreserve.gov/monetarypolicy/fomccalendars.htm)
- [Federal Reserve Bank of St. Louis: ALFRED](https://alfred.stlouisfed.org/)
