# dsh-plugin-goldboard — 设计文档（v1.2 实现基线）

> 状态：P0 数据口径、P1 质量/回放和 P2 Harness 多模型分析已实现；本文保留原始产品约束，并记录当前实现接口。
> 目标环境：DeepSeek Harness Web GUI，本地 `link:` 安装到 `web` profile。
> 插件形态：双面 Cordis 包（Node 宿主半 + 手写 factory-CJS 浏览器半），无构建步骤。

---

## 1. 需求访谈结论（已逐项确认）

| 问题 | 确认结果 |
| --- | --- |
| 信号金价标的 | **信号口径优先级：招行积存金实时价 → 国际金价 XAU 按汇率折算 → 上金所 Au99.99**；实际交易标的为**招商银行积存金**：招行实时价不可用时按国际金价按汇率折算 + 固定价差自动估算（默认 +1.72 元/克，买卖价差可分别设置），国际价也不可用时回退 Au99.99 + 价差估算 |
| 实际交易标的 | **招商银行积存金**；插件用 Au99.99（或国际金价折算）做信号，招行价优先通过招行市场中心接口拉取实时客户买卖价，接口不可用时按国际金价按汇率折算 + 固定价差自动估算（默认 +1.72 元/克，买卖价差可分别设置） |
| 手续费模型 | **双边合计 5 元/克，买入 0 + 卖出 5** |
| 持仓周期 | **日内为主，当天了结**，信号以 5/15/60 分钟线为主 |
| 持仓来源 | **v1 手动录入**，不接账户 |
| 交易时段 | 按招行积存金：**工作日 09:00–次日 02:00**，周末和法定节假日休市 |
| 提醒渠道 | **宿主机系统通知 + Webhook**（飞书/钉钉/企业微信/通用 JSON） |
| 提醒频率 | **交易时段内每次阈值穿越都立即提醒**，不设冷却、不设勿扰时段 |
| 数据源预算 | **免费公开源**，低频轮询 + 多源容错 + 本地缓存 |
| 委托执行 | **只生成建议委托单**（方向/建议价/克数，一键复制），不接触银行账户 |

产品核心边界：这是**行情看板 + 技术面参考 + 提醒工具**，不是自动交易系统，也不构成投资建议。

---

## 2. 产品范围

### 2.1 v1 必须做

- 页面内轻量浮窗看板：
  - 默认位置**右上角**，可拖拽并记住位置；可收起为**小圆球**，点击展开。
  - 折叠态：国内金价（Au99.99，元/克）+ 国际金价（XAU，美元/盎司），涨跌与更新时间。
  - 展开态小卡：Au99.99 1 分钟趋势线（SVG）、国际价折算元/克、内外价差、招行积存金实时客户买卖价（接口不可用时为国际金价按汇率折算 + 固定价差估算，点击可看折线图）、当前信号摘要。
  - 不弹窗、不抢焦点；提醒由系统通知/Webhook 负责，不在页面内制造弹层。
- 设置页（`settings.section`）：
  - 持仓：当前克数、平均成本（元/克）。
  - 上限：最大投入克数 / 最大投入金额，二选一约束。
  - 手续费：双边合计默认 5 元/克，买入 0 + 卖出 5（可调，设置页显示总成本与回本线预览）。
  - 招行积存金备用价差：买入价差、卖出价差默认各 +1.72 元/克，可分别调整；仅当招行接口不可用时用于估算。
  - 信号阈值、交易时段（工作日 09:00–次日 02:00，节假日表可编辑）。
  - 系统通知开关、Webhook 渠道配置（密钥只写、读回脱敏）。
- 策略输出：
  - 无持仓时：建议买入价（信号价 + 对应招行估算价）、建议克数、理由标签（技术指标状态）。
  - 持仓时：回本价、建议卖出价、止损参考价、当前浮盈亏（扣费后）。
  - 每项建议附“扣费后需涨到多少”的显式数字；建议委托文本同时给出招行估算价。
- 必要时刻提醒：
  - **交易时段内每次阈值穿越都立即提醒**，不设冷却时间、不设勿扰时段。
  - 宿主机系统通知（macOS / Linux / Windows）+ Webhook。
- 中英文 UI，`Settings → General → Language` 切换即时生效。
- 明暗主题使用 `--dsw-alias-*` token。

### 2.2 v1 明确不做

- 不接券商/银行 API，不自动下单，不自动修改真实持仓。
- 不保证盈利；所有信号标注“技术面参考，非投资建议”。
- 不读取真实账户；持仓数据由用户手动录入并自行保证准确。
- 不发布 GitHub（后续发布时按 `dsh-plugin-publishing` 规范执行 tag + Release）。
- 不做付费行情接入；数据源适配层预留，但不实现。
- 不做复杂回测/参数寻优；v1 只做透明的规则信号。

---

## 3. 包身份与安装形态

| 项 | 值 |
| --- | --- |
| 目录 / 仓库 | `dsh-plugin-goldboard/`（repo root = package root） |
| `package.json#name` | `dsh-plugin-goldboard` |
| client factory `id` | `dsh-plugin-goldboard` |
| host plugin `name` | `dsh-plugin-goldboard` |
| locale namespace | `dsh-plugin-goldboard` |
| storage | `$DSH_HOME/storages/dsh-plugin-goldboard/` |
| 路由前缀 | `/dsh-plugin-goldboard/*` |
| profile loader | `- insert: { id: dsh-plugin-goldboard, name: 'dsh-plugin-goldboard' }` |
| 宿主依赖 | `inject: ["webServer", "llm"]` |
| 浏览器依赖 | `inject: ["slots", "locale"]` |

---

## 4. 总体架构

```
┌────────────────────────── 浏览器半（lib/client.js）──────────────────────────┐
│                                                                              │
│  shell.overlay（list / root scope）                                          │
│    GoldBoardOverlay：右上角可拖拽；收起为小圆球 ⇄ 展开浮窗卡                     │
│    - 国内/国际价、涨跌、更新时间、折算价、内外价差、招行积存金估算价               │
│    - SVG 近期走势 sparkline                                                   │
│    - 当前信号：买入建议 / 卖出建议 / 回本价 / 建议委托单 + 一键复制               │
│                                                                              │
│  settings.section                                                             │
│    GoldBoardSettings：持仓、上限、手续费（买0卖5）、招行价差、信号阈值、          │
│    交易时段（工作日 09:00–次日02:00，节假日表）、提醒渠道                       │
│    模型与分析：Harness provider/model/reasoning、立即分析、查询日志             │
│                                                                              │
│  轮询 GET /dsh-plugin-goldboard/snapshot（10s 报价，60s K 线；页面隐藏时降频） │
│  GET /models、POST /analysis、GET /analysis-logs（模型调用与审计日志）          │
│  语言切换：locale.register(NS, { zh, en })，所有可见文案走 t()                  │
└──────────────────────────────────┬───────────────────────────────────────────┘
                                   │ HTTP（webServer，同源）
┌──────────────────────────────────▼───────────────────────────────────────────┐
│                          宿主半（lib/index.js）                                │
│                                                                              │
│  行情采集器（免费源，多源容错）                                                 │
│    Au99.99 报价：新浪 gds_AU9999 / 东财 118.AU9999                             │
│    XAU 现货：  新浪/腾讯 hf_XAU                                                │
│    USDCNY：   腾讯 whUSDCNY                                                   │
│    K 线：     东财 118.AU9999（5/15/60/日线）；XAU 日线（新浪）+ 现货轮询自建分钟线 │
│    - 30s 报价轮询，K 线增量补齐，指数退避，来源熔断，磁盘缓存                      │
│                                                                              │
│  指标引擎：SMA/EMA、Wilder RSI/ATR、MACD、布林带、近期支撑/阻力；只用收盘 K 线 │
│            输出 calculationVersion、warmupReady、synthetic 和口径元数据         │
│  质量/回放：Quote/Bar 规范化、OHLC/重复桶/覆盖率/stale/warm-up 检查、固定回放      │
│  策略引擎：持仓/上限/手续费/招行价差 → 回本价、建议买卖价、建议克数、止损参考     │
│            （5/10 分钟覆盖率 >80%、30/60 分钟 >60% 才出建议）                    │
│  分析引擎：ctx.llm 目录 → prepareCall → stream → JSON/schema → 脱敏 JSONL       │
│  提醒引擎：阈值穿越边沿触发（无冷却、无勿扰）+ 交易时段抑制                     │
│  通知引擎：系统通知（osascript / notify-send / PowerShell）、Webhook            │
│  持久化：$DSH_HOME/storages/dsh-plugin-goldboard/{config,state,cache}.json     │
│            + analysis-log.jsonl（started/finished，保留/分页/脱敏）              │
│                                                                              │
│  路由（每个路径注册一次，内部按 method 分发）：                                  │
│    GET/POST /dsh-plugin-goldboard/config                                      │
│    GET      /dsh-plugin-goldboard/models                                      │
│    GET/POST /dsh-plugin-goldboard/analysis                                    │
│    GET      /dsh-plugin-goldboard/analysis-logs                               │
│    GET      /dsh-plugin-goldboard/snapshot                                    │
│    GET      /dsh-plugin-goldboard/bars?instrument=&interval=&limit=            │
│    POST     /dsh-plugin-goldboard/replay                                      │
│    GET      /dsh-plugin-goldboard/manual-cmb-missing                          │
│    POST     /dsh-plugin-goldboard/manual-cmb-bars                             │
│    POST     /dsh-plugin-goldboard/test-notify                                 │
└──────────────────────────────────────────────────────────────────────────────┘
```

关键判断：

1. **浏览器不直接访问行情源**。免费源有 Referer、编码、CORS 和限流问题，宿主代理 + 缓存是稳定解。
2. **客户端用轮询而不是 SSE**。10s 一次的本地 JSON 足够轻，避免在插件里维护长连接和重连逻辑；宿主仍然持续评估提醒，浏览器关闭也能发系统通知。
3. **建议区域优先以招行积存金实时数据计算**；招行实时价不可用时，**优先国际金价按汇率折算的兜底价**（XAU 折算价），再回退 Au99.99（国内价 + 价差估算）。国际 XAU 同时用于趋势确认、价差显示和波动环境判断。

---

## 5. 已实现的升级模块

### 5.1 数据与质量接口

`lib/market-quality.js` 是行情适配器与规则/分析调用之间的深模块接口：

- `normalizeQuoteRecord(key, quote)`：统一 `instrument`、`market`、`currency`、`unit`、来源质量和时间字段；Yahoo `GC=F` 固定为 `futures/GC=F`。
- `normalizeBarRecord()` / `closedBars()`：拒绝无效 OHLC，保留 `synthetic` 和来源元数据，只把已收盘桶交给正式指标。
- `assessMarketQuality()`：集中检查 stale、OHLC、重复桶、覆盖率、warm-up、品种口径和 CMB 买卖价差，返回稳定 `reasonCodes`。
- `replayMarketPlan()`：用固定 `asOf`、报价和 bars 重建指标与规则 plan，不发起网络请求或模型调用。

指标计算版本为 `goldboard-indicators-v2`，EMA 使用 SMA seed，RSI/ATR 使用 Wilder 平滑。XAU 指标保持 USD/盎司原生口径，只在展示和 CMB 估算价上做当前汇率转换。

### 5.2 Harness 分析接口

`lib/analysis.js` 只依赖宿主提供的 `ctx.llm`：

1. `listProviders()`、`listModels()`、`resolveModelInfo()` 合并成 `/models` 只读投影；单个 provider 失败进入 `failures`。
2. `prepareCall({ provider, model, reasoningEffort, temperature, maxTokens })` 固定一次调用，再通过准备好的 handle `stream()`。
3. 输入只包含宿主快照、已收盘 bars、指标、质量和规则 plan；系统约束 `noPriceFabrication`、`noOrderExecution`，模型动作不含 buy/sell。
4. 独立 AbortSignal/超时、input hash 缓存、running 去重和 `force` 缓存绕过不影响行情 tick。
5. text blocks 严格 JSON parse 和结构校验；provider、超时、取消、空输出、JSON/schema 失败分别进入稳定状态。

`lib/analysis-log.js` 将一次调用的 `started`/`finished` 事件写入 JSONL，合并成可分页摘要；详情默认脱敏，进程重启时遗留 `running` 会标记为 `aborted`。

### 5.3 客户端设置

客户端继续使用独立 `settings.section`，不改为 `settings.plugin.item`。模型选择保存在插件配置中，不读写 Harness 全局会话模型；查询日志使用独立对话框，支持状态/provider/model/时间筛选、游标分页、详情复制、Escape 关闭和中英文即时切换。

---

## 6. 行情数据源契约（免费源，实测可用）

### 6.1 报价源

| 用途 | 主源 | 备用源 | 说明 |
| --- | --- | --- | --- |
| Au99.99 报价 | 新浪 `hq.sinajs.cn/list=gds_AU9999` | 上金所 SGE `www.sge.com.cn/graph/quotations` → 东财 `push2.eastmoney.com/api/qt/stock/get?secid=118.AU9999` → 60s API | 新浪需 `Referer: https://finance.sina.com.cn/`，GBK 解码；东财 JSON，价格字段按 100 倍缩放（实测 `f43=95000` = 950.00）；SGE 用 POST `instid=Au99.99` |
| XAU 伦敦现货 | 新浪/腾讯 `hf_XAU` | gold-api.com → 60s API → GoldPrice.Today | GBK 解码；腾讯需 GBK→UTF-8；gold-api.com 无需 key；Yahoo `GC=F` 单独作为期货诊断，不进入现货 fallback |
| USDCNY | 腾讯 `whUSDCNY` | 配置项手动覆盖 | 解析 `~` 分隔字段；仅用于元/克换算展示 |
| 品牌金价/积存金（状态页） | 金投网 `api.jijinhao.com` | 京东金融 `api.jdjygold.com` | 非主信号源，仅在数据源状态/日志中展示 |

实测样本（本机 2026-08-15 收盘附近）：

- `gds_AU9999`：950.00 元/克
- `hf_XAU`：4375.80 美元/盎司
- `whUSDCNY`：6.7421
- 折算价 = `4375.80 × 6.7421 ÷ 31.1034768 ≈ 948.51 元/克`，国内价溢价约 1.49 元/克（0.16%）

### 6.2 K 线源

- Au99.99：东财
  `push2his.eastmoney.com/api/qt/stock/kline/get?secid=118.AU9999&klt=5|15|30|60|101&fqt=1&lmt=...`
  实测 60 分钟与日线可用；字段 `f51..f58` = `date,open,close,high,low,volume,amount,amplitude`。
  历史兜底：上金所 `POST https://www.sge.com.cn/graph/Dailyhq`（`instid=Au99.99`，行格式 `[日期, 开, 收, 低, 高]`）。
- XAU/USD 现货 K 线：东财 `122.XAU` 为现货主源；源不可用时质量状态明确降级，不把其他品种改名为现货。
- `GC=F` 期货日线诊断：Yahoo Finance
  `query1.finance.yahoo.com/v8/finance/chart/GC=F?interval=1d&range=5y`，独立保存到 `GCF` lane，不参与 XAU/USD 现货指标。
- XAU 分钟线：免费源不稳定。宿主以 30s 现货报价自建 1m/5m/15m/60m bars（`open,high,low,close,ts`），标记 `synthetic=true`；正式指标排除当前未收盘桶，冷启动时标注 warm-up 未完成。
- **60 分钟桶的冷启动聚合（v1.3.1）**：由 5 分钟 K 线构建 60 分钟桶时执行真聚合（`o = 首根子bar.o`、`h = max(h)`、`l = min(l)`、`c = 末根子bar.c`），只聚合已完整结束的小时桶，进行中的小时交给报价路径维护；东财专用 60 分钟 K 线拉取保留为更长历史的补充。元数据继承首根子 bar，`synthetic: false`。

### 6.3 采集规则

- 报价轮询 30s（可配置 15–120s）；K 线增量每 5 分钟补齐一次。
- 每源独立超时（5s）、重试（指数退避 2s/4s/8s，最多 3 次）、熔断（连续 3 次失败停用 10 分钟）。
- 单源失败用上一快照 + `stale: true` + 来源标记，不中断看板。
- 磁盘缓存所有原始响应与最近 bars；宿主重启后先读缓存再补增量。
- **bars 种子版本失效机制（v1.3.1）**：`state.json` 记录 `barsSeedVersion`（当前 `BARS_SEED_VERSION = 2`）。加载时若字段缺失或 ≠ 当前值，丢弃 AU9999 / XAU 两道的 `bars[5]` 与 `bars[60]`（其余周期与 lane 保留），下一次 tick 由修复后的种子逻辑重建，并回写新版本号——用于旧版本污染数据（v1.2.x 曾用末根子 bar 整体覆盖 60 分钟桶）的一次性清理。
- 不做高频轮询，遵守免费源非官方接口的容忍度；接口变更时必须降级而不是崩溃。

### 6.4 交易时段与市场状态

- 交易时段按**招商银行积存金**（北京时间，可在设置页编辑）：
  - 每周一至周五 09:00–次日 02:00 为可交易时段（周五 09:00 开启的时段延续到周六 02:00 结束）。
  - 周六、周日不开启新时段；法定节假日休市（设置页提供节假日表编辑，v1 默认空表，后续可内置中国法定节假日）。
  - 实际执行以招行 App 交易规则为准；插件时段表只是提醒开关，不代替银行规则。
- 行情源 Au99.99 与 XAU 的报价仍持续采集，但 `marketState` 决定是否允许开平仓提醒。
- `marketState` 写入 snapshot：`open / closed`；`open` 表示招行积存金当前可交易。
- 休市期间：报价看板继续显示最后价，但**抑制所有买入/卖出提醒**；数据过期 > 10 分钟触发一次 `data_stale` 提醒。
- 招行积存金价格：
  - 优先：`https://mbmodule-openapi.paas.cmbchina.com/product/v1/func/market-center` 返回 `zBuyPrc`（客户买入价）/ `zSelPrc`（客户卖出价）；折线图使用客户买入价绘制，`average = (zBuyPrc + zSelPrc) / 2` 仅作兼容保留。
  - 回退：`cmbBuy ≈ 国际金价按汇率折算 + cmb.buySpreadPerGram`（默认 +1.72），`cmbSell ≈ 国际金价按汇率折算 + cmb.sellSpreadPerGram`（默认 +1.72）。
  - 看板标注“招行价以 App 为准”。
  - 招行“昨收/涨跌幅”优先取当天 00:00 的自身 1 分钟价格；若 00:00 无数据，则降级为国际金价昨收折算人民币 + 当前招行价差估算。

---

## 7. 指标与信号引擎（v1 透明规则）

### 7.1 指标（宿主内纯 JS 计算，不引第三方库）

- 均线：SMA5 / SMA20 / SMA60；EMA12 / EMA26
- MACD：DIF / DEA / 柱
- RSI：14 周期（收盘价）
- 布林带：20 周期，2σ
- ATR：14 周期
- 支撑/阻力：近 20 / 60 根 bar 的最高、最低，以及布林上下轨

计算顺序固定：先补足 bars → 数据覆盖率门槛 → 计算指标 → 快照输出。任何指标因数据不足不输出信号，只显示 `数据积累中`。

### 7.2 手续费与回本线

- 配置默认：`fee.buyPerGram = 0`，`fee.sellPerGram = 5`（双边合计 5，可调，设置页显示总额与回本线预览）。
- 招行价差：`cmb.buySpreadPerGram = 1.72`、`cmb.sellSpreadPerGram = 1.72`（可调，可负）。
- 新开仓回本价（按招行估算价口径）：
  `breakevenCmb = cmbBuyPrice + buyFee + sellFee + estimatedSpread + slippage`
  其中 `estimatedSpread` 用近期买卖价差中位数（Au99.99 盘口，缺失时默认 0.2 元/克），`slippage` 默认 0.2 元/克（可配置）。
- 已持仓回本价：
  `exitNeededCmb = 平均成本 + sellFee + estimatedSpread + slippage`
  （买入手续费为 0 且已沉没，不再重复计入；设置页两个口径都展示）。
- 所有“建议卖出价”必须 ≥ 回本价；否则显示“当前波动不足以覆盖成本”，不输出买入信号。
- 信号价优先级：**招行实时 → 国际金价按汇率折算 → Au99.99**（国际价也不可用时回退 Au99.99 + 价差估算招行价）。展示与委托建议同时给出 `signalPrice` 和 `cmbEstimatedPrice` 两个数字。

### 7.3 信号规则（默认参数全部可在设置页调整）

**数据完整性门槛（所有建议共用，v1.1）**

- 信号按标的（**招行实时价 → 国际金价折算 → Au99.99**）选择后，检查该标的 1 分钟 bars：
  最近 **5/10 分钟**窗口的有效数据覆盖率必须 **> 80%**，**30/60 分钟**窗口必须 **> 60%**（每分钟一个价格点，有 1 分钟 bar 且收盘价有效才计入）。
- 任一窗口不达标：`action = data_incomplete`，不输出建议委托单，看板显示「当前数据有缺失，暂不给出建议」，并展示各窗口覆盖率（`plan.dataCoverage`，如 `{ "5": 1, "10": 0.9, "30": 0.97, "60": 0.83 }`）与对应 `reasonCodes`（如 `data_incomplete_60m`）。
- **开盘后 1 小时内与每天 0 点-1 点期间的放宽**：30/60 分钟窗口在开盘初期或跨日 0-1 点时段天然不足（60 分钟窗口约需累积 37 个分钟点才 >60%），因此开盘后 1 小时内、以及每天北京时间 0 点-1 点期间，只校验 **5/10 分钟**窗口；数据参考仍尽量覆盖 5/10/30/60（指标照常按四个周期计算，10/30/60 分钟线有历史预热时趋势过滤不受影响）。`dataCoverage` 仍报告全部四个窗口，仅 `reasonCodes`/拦截按生效窗口输出。
- 门槛不替代过期检查：报价过期仍走 `data_stale`；休市仍走 `market_closed`。
- 覆盖率的其余预期后果：轮询间隔 > 60s 或报价中断会按缺口如实反映（5 分钟窗口缺 1 分钟即 80% 不达标）。

**无持仓（日内做多）**

必须同时满足：

1. `marketState` 为 `open`（招行积存金工作时段 09:00–次日 02:00 内）；
2. 数据完整性门槛通过（见上）；
3. **10/30/60 分钟 EMA20 全部向上**（多周期趋势共识：60 分钟线来自东财 K 线/自建，10/30 分钟线由 5 分钟线重采样得到，冷启动即有历史预热）；
4. 5 分钟 RSI14 从 < 35 回升并上穿 35，或 5 分钟收盘重新站上 SMA20（入场时机仍看 5 分钟）；
5. 价格距离近 20 根 bar 低点或布林下轨不超过 0.5%。

输出：

- `action = buy_setup`
- 建议买入价（信号价口径）= `min(现价+0.1, 近20低点 + 0.3×ATR)`
- 建议招行买入价 = 建议买入价 + `cmb.buySpreadPerGram`
- 建议克数 = `min(最大克数-当前克数, floor(剩余最大金额 / 建议招行买入价))`
- 目标卖出价（招行口径）= `max(breakevenCmb + 最小利润, 近20高点 - 0.3×ATR + cmb.sellSpreadPerGram, 布林上轨 + cmb.sellSpreadPerGram)`

**持仓中**

任一条件触发：

| 触发 | 输出 |
| --- | --- |
| 现价 ≥ 目标卖出价 | `sell_take_profit`：建议委托卖出全部或可配置比例 |
| 5 分钟收盘跌破 15 分钟 EMA20 且已有浮盈 | `sell_trailing`：移动止盈参考价 |
| 现价 ≤ `平均成本 - 最大可承受亏损 - sellFee` | `sell_stop`：止损参考价 |
| 距当日交易时段结束 < 30 分钟仍持仓 | `close_by_session_end`：日内了结提醒（不自动计算价格） |
| RSI14 > 75 且 5 分钟出现阴线吞没/上影 > ATR | `sell_weakness`：减仓参考 |

**国际价确认**

- 当 Au99.99 与 XAU 折算价的价差超过近 20 日价差均值 ± 2σ 时，输出 `spread_alert`，仅提示“内外盘异常”，不直接开仓。

### 7.4 建议委托单（手动执行）

每条交易建议生成：

```json
{
  "action": "buy_setup | sell_take_profit | sell_trailing | sell_stop | ...",
  "instrument": "Au99.99",
  "side": "buy | sell",
  "signalPrice": 948.60,
  "cmbEstimatedPrice": 950.60,
  "grams": 20.00,
  "validUntil": "2026-08-15T01:50:00+08:00",
  "reasonCodes": ["trend_ema20_up", "rsi_rebound", "near_support"],
  "riskNote": "技术面参考，非投资建议"
}
```

- `validUntil` 取当前招行交易时段结束前 10 分钟，超时后建议自动失效。
- 浏览器侧提供“一键复制委托文本”，文本中明确写“招行积存金估算价，以 App 实际报价为准”，不执行任何下单动作。
- 宿主会记住最近一次已提醒的 `suggestedOrder`（持久化到 `state.json`）。当后续 `plan` 不再包含建议、或建议的方向/价格/克数发生变化时，发送 `cancel_order` / `order_updated` 提醒，提示用户撤销或更新未成交挂单，避免按旧建议执行。

### 7.5 提醒边沿触发（无冷却、无勿扰）

- 每个 `action` 维护 `idle → armed → fired` 状态机，只在条件从 false→true 的**边沿**触发，避免同一个 tick 内重复发送。
- **不设时间冷却、不设勿扰时段**：交易时段内价格重新穿越阈值就再次立即提醒。
- 休市期间条件不进入 `armed`；开盘后按开盘价重新评估。
- 同一评估周期多条提醒合并为一条摘要（系统通知 + Webhook 各发一份），避免一个 tick 内轰炸。
- 除常规买卖信号外，还额外跟踪最近一次委托建议；原建议失效或参数变化时，以 `cancel_order` / `order_updated` 边沿提醒。
- **连续确认语义（v1.3.1）**：`strategy.confirmBars = N` 表示「方向条件在**连续 N 根已收盘的 5 分钟 bar** 上成立」才发出建议——计数以信号道最新已收盘 5m bar 的 `t` 为时钟，同一根 bar 内的多次轮询评估不重复计数。动作脱离方向集（wait / 数据类状态）、信号道品种切换、或 `marketState` 转为 `closed` 时，买卖两条 streak 全部清零重新计数；陈旧的 streak 不会让下一次孤立信号免检通过。

---

## 8. 宿主路由契约

统一响应信封：`{ ok: true, ... }` 或 `{ ok: false, error: { code, message?, details? } }`。
每个路径只注册一次，内部按 `req.method` 分发；请求体读入设 256 KiB 上限（413）。

### 8.1 `GET /dsh-plugin-goldboard/config`

返回脱敏配置 + `secretSet`（对齐 `dsh-plugin-notify` 写法）：

```json
{
  "ok": true,
  "config": {
    "fee": { "buyPerGram": 0, "sellPerGram": 5 },
    "cmb": { "buySpreadPerGram": 1.72, "sellSpreadPerGram": 1.72 },
    "position": { "grams": 0, "avgCostPerGram": 0, "lots": [] },
    "limits": { "maxGrams": 0 },
    "tradingHours": { "weekdaysOnly": true, "open": "09:00", "close": "26:00", "holidays": ["2026-10-01"] },
    "system": { "enabled": false },
    "webhooks": {
      "feishu": { "enabled": false, "url": "", "secret": "" },
      "dingtalk": { "enabled": false, "url": "", "secret": "" },
      "wecom": { "enabled": false, "url": "" },
      "generic": []
    }
  },
  "secretSet": { "webhooks.feishu.secret": false, "webhooks.dingtalk.secret": false }
}
```

### 8.2 `POST /dsh-plugin-goldboard/config`

请求：

```json
{
  "config": { "...": "..." },
  "clearSecrets": ["webhooks.feishu.secret"]
}
```

规则：

- 空字符串 secret = 保留旧值；非空 = 替换；`clearSecrets` 列出的 = 清空。
- 校验：手续费默认 `buyPerGram=0, sellPerGram=5`（总额 5，允许用户改，但设置页给出成本影响提示）；招行价差允许负值；克数与金额非负、上限 ≤ 100000 克、成本价 > 0。
- 响应返回脱敏后的完整配置。
- `analysis.enabled=true` 时，保存前用 `ctx.llm.prepareCall()` 校验 provider/model/reasoning；不可用时返回稳定错误码，不静默替换模型。

### 8.3 `GET /dsh-plugin-goldboard/models`

返回当前 `ctx.llm` 的 provider/model/reasoning 目录；单个 provider 失败进入 `failures`，空目录不回退到硬编码模型。

### 8.4 `GET/POST /dsh-plugin-goldboard/analysis`

- `GET` 返回当前 running 查询、最近结果和日志健康状态。
- `POST` 读取宿主最新快照，执行缓存/running 去重和 provider-neutral 模型调用；质量门控未通过时仍可调用，但模型不得返回 `analysis_ready`。
- 每个真实调用返回 `queryId`；`force=true` 只绕过缓存，不绕过模型输出状态约束。

### 8.5 `GET /dsh-plugin-goldboard/analysis-logs`

支持 `limit`、`cursor`、`queryId`、`status`、`provider`、`model`、`from`、`to` 和 `detail=true`。默认列表只返回摘要，详情也不返回凭据、Authorization、Webhook secret 或原始 prompt。

### 8.6 `POST /dsh-plugin-goldboard/replay`

接收固定 `asOf`、quotes 和 bars，纯函数重建质量、指标、plan 与 snapshot；不请求行情源、不发提醒、不调用模型。

### 8.7 `POST /dsh-plugin-goldboard/manual-cmb-bars`

接收设置页手动录入的今日招行积存金分钟价（文本或 `entries` 数组），仅补充缺失的 1 分钟 bar，并从 1 分钟数据重建缺失的 5/15/60/1440 分钟桶；不会覆盖已有 bar。设置页通过 `GET /dsh-plugin-goldboard/manual-cmb-missing` 获取今日缺失分钟列表，便于直接填写价格。成功响应包含 `added`、`skipped` 和最新 `snapshot`。

### 8.8 `GET /dsh-plugin-goldboard/snapshot`

```json
{
  "ok": true,
  "serverTime": "2026-08-15T16:00:00+08:00",
  "marketState": "open",
  "quotes": {
    "AU9999": { "price": 950.0, "high": 954.5, "low": 946.0, "open": 946.0, "prevClose": 940.72, "time": "2026-08-15T15:30:00+08:00", "source": "sina", "stale": false },
    "XAU":    { "price": 4375.8, "high": 4396.82, "low": 4311.03, "time": "...", "source": "tencent", "stale": false },
    "USDCNY": { "price": 6.7421, "source": "tencent", "stale": false }
  },
  "derived": {
    "xauCnyPerGram": 948.51,
    "domesticPremiumPerGram": 1.49,
    "domesticPremiumRatio": 0.0016,
    "domesticPremiumPct": 0.16,
    "cmb": { "buyPrice": 950.23, "sellPrice": 950.23, "sourceNote": "国际金价按汇率折算 948.51 + 1.72 元/克估算" }
  },
  "trend": {
    "AU9999_1m": [ { "t": "...", "o": 950.0, "h": 951.0, "l": 949.2, "c": 950.4 } ],
    "XAU_1m": [ "...自建 bars..." ]
  },
  "indicators": { "AU9999_5m": { "rsi14": 46.2, "ema20": 949.8, "upper": 953.1, "lower": 946.6 } },
  "position": { "grams": 20, "avgCostPerGram": 945.0, "marketValue": 19000, "feeAdjustedPnl": 87.0, "lots": [{ "id": "lot-1", "grams": 20, "price": 945.0 }] },
  "plan": { "action": "sell_take_profit", "dataCoverage": { "5": 1, "10": 1, "30": 1, "60": 0.98 }, "suggestedOrder": { "...": "..." } },
  "alerts": { "lastFiredAt": { "sell_take_profit": "..." } }
}
```

- snapshot 不落任何 secret。
- `plan.action = data_incomplete` 时 `suggestedOrder = null`，`dataCoverage` 给出 5/10/30/60 分钟各窗口的每分钟数据覆盖率（信号标的口径）。
- 客户端只消费此结构，具体指标增减在实现阶段冻结。

### 8.9 `GET /dsh-plugin-goldboard/bars?instrument=AU9999&interval=1m&limit=120`

- 参数白名单校验；返回该标的最近 bars，供展开浮窗时补充历史。

### 8.10 `POST /dsh-plugin-goldboard/test-notify`

- 对指定渠道发送测试消息（系统 / 飞书 / 钉钉 / 企业微信 / 通用），用于设置页验证。

---

## 9. 浏览器半设计

### 9.1 浮窗看板（`shell.overlay`）

- 插槽：`slots.inject("shell.overlay", () => slots.register({ name: "shell.overlay", id: "dsh-plugin-goldboard-board", order: 200, locale: NS }, GoldBoardOverlay))`
- 浮层根节点：
  - `position: absolute`，默认**右上角**（首次启动），可拖拽（pointer capture，复用 `dsh-plugin-pet` 的拖拽模式），拖拽后位置存入 localStorage 键 `dsh-plugin-goldboard:position`。
  - 收起态：**小圆球**（约 36×36，显示涨跌色圆点，hover 显示价格摘要）。
  - 根节点只占圆球/卡片实际尺寸，保留 `shell.overlay` 的点击穿透行为。
- 展开态小卡（约 320×220）：
  - 头部：`Au99.99 元/克`、`XAU 美元/盎司`、更新时间、市场状态；
  - 次行：国际金价折算元/克、内外价差、招行积存金估算价（标注“以 App 为准”）；
  - 中部：Au99.99 1 分钟 sparkline（手写 SVG，不引图表库）；
  - 底部：当前信号或建议委托价 + “复制委托”按钮；
  - 关闭/拖拽手柄明确，不遮挡对话输入区。
- 数据流：`useSyncExternalStore` 或 `useEffect + setInterval` 订阅宿主 snapshot；页面 `visibilitychange` 隐藏时轮询降到 60s，显示时恢复 10s。
- **今日走势的交易日锚点（v1.3.1）**：交易时段可跨零点（09:00–次日 02:00）。过滤「今天」的 bars 按**交易日**而非日历日：北京时间 00:00 至 `close − 1440`（默认 02:00）之间的时间点归属前一北京日历日开启的交易时段（`tradingDayKey`），因此凌晨时段图表渲染「昨晚 + 今晨」完整折线，而不是被截断成 0–2 点切片；x 轴沿用 `tradingMinuteIndex` 的压缩轴（早尾段在前、开盘后时段在后，中间休市时段被压缩）。涨跌幅基准不受此锚点影响（仍以昨收折算 / 手动昨收为基准；招行昨收优先取**日历日** 00:00 的自身价格，该查询刻意不跟随交易日锚点）。
- 语言：所有文本经 `t()`；`locale: NS` 保证切换即时重渲染。

### 9.2 设置页（`settings.section`）

- 插槽：`id: "dsh-plugin-goldboard"`，`order: 65`，`locale: NS`。
- 分区：
  1. 持仓与上限（克数 / 金额 / 平均成本）
  2. 手续费（买入 0 / 卖出 5，显示总成本与回本线预览）
  3. 招行积存金价差（买入/卖出各 +1.72 元/克，可负）
  4. 信号阈值（最小利润、最大亏损、ATR 系数、RSI 阈值）
  5. 交易时段（工作日 09:00–次日 02:00，节假日表）
  6. 提醒（系统通知开关、Webhook；无冷却/勿扰选项）
  7. 数据源状态（来源、最后更新时间、stale 标记）
- Webhook secret 与 notify 插件一致：只写、读回空白 + `secretSet`。
- 按钮使用 `--dsw-alias-button-primary-fill / hover`；卡片透明 + `border-l2`；开关用 `state-business-primary`；不得硬编码颜色。
- 双语字典 `DICT.zh` / `DICT.en` 必须 1:1 键集合，测试断言。

### 9.3 文案与免责

- 看板常驻一行小字：`技术面参考，非投资建议`。
- 每个建议委托弹层/卡片包含 `风险提示` 与 `扣费后回本价`。
- 提示文案不出现“保证盈利”“必涨”“精准买卖点”等表述。

---

## 10. 持久化与状态

| 文件 | 内容 |
| --- | --- |
| `config.json` | 脱敏前配置；原子写（tmp + rename），并发写串行化 |
| `state.json` | 行情缓存、bars 缓存、指标状态、提醒状态机、来源熔断状态 |
| `alerts-log.json` | 最近 200 条已发提醒（时间、action、价格、渠道、结果） |

- 读取损坏时 log warning 并回退默认值，GET 不抛错。
- Webhook secret 永不进入 snapshot、bars、日志。
- 宿主退出后缓存保留；重启先读 `state.json` 再补增量。

---

## 11. 通知引擎

- 系统通知：
  - macOS `osascript display notification`
  - Linux `notify-send`
  - Windows PowerShell WinRT toast
  - 失败不影响行情主循环，仅 log。
- Webhook：
  - 飞书/钉钉签名逻辑复用 `dsh-plugin-notify` 已验证实现；
  - 企业微信自定义机器人；
  - 通用 JSON webhook（Slack / ntfy / Bark / Server酱等）。
- 消息模板占位符：`{{action}} {{instrument}} {{price}} {{target}} {{grams}} {{time}} {{reason}}`。
- 模板默认中文（用户可改）；客户端会把当前 UI locale 作为 `X-DSH-Locale` 附加到 snapshot 请求，宿主记录为通知文案语言提示，不另设语言偏好设置项。

---

## 12. 关键风险与缓解

| 风险 | 影响 | 缓解 |
| --- | --- | --- |
| 免费源限流/失效（实测东财连续请求已出现 Empty reply） | 行情中断 | 三源容错、30s 低频、指数退避、熔断、磁盘缓存、stale 标记 |
| 免费源字段/缩放变化 | 价格错误 | 解析器带字段版本 + 单位测试样本；异常值校验（与前值偏差 > 3% 丢弃） |
| 免费源无官方授权 | 合规风险 | 仅个人看板使用；不对外分发；后续可替换为付费源 |
| 手续费 5 元/克双边合计（买 0 卖 5）下，短线波动不足以覆盖成本 | 用户亏损 | 只输出“建议”，始终显示回本价；波动不足时不发开仓信号 |
| 技术指标规则失效 | 用户亏损 | 规则透明、可关、可调；界面免责；v2 才谈回测 |
| 招行价差估算偏离实际 | 建议委托价失真 | 默认 +1.72 元/克可调；看板常驻“招行价以 App 为准”；偏离提示阈值可设 |
| 节假日/时段配错 | 休市时发错误信号 | 交易时段状态机（工作日 09:00–次日 02:00 + 节假日表）；休市抑制开平仓提醒 |
| 手动持仓与真实账户漂移 | 建议失真 | 设置页显示“最后同步时间”；用户手动更新；v2 预留账户同步 |
| 宿主不运行时无提醒 | 漏提醒 | 设置页明示“提醒依赖 DSH 宿主运行”；浏览器半只负责看板 |
| 浮窗遮挡 UI | 打扰 | 折叠优先、根节点尺寸限定、可拖拽、可关闭、不抢焦点 |

---

## 13. 验证计划

- 离线：
  - `node --check lib/index.js lib/client.js`
  - `node --test`：配置归一化、报价解析器（用本机实测样本做 fixture）、K 线解析、指标计算、回本价公式、提醒状态机。
  - 断言 `Object.keys(DICT.zh).sort()` 与 `DICT.en` 一致。
- 宿主：
  - `curl -s http://127.0.0.1:3080/plugins/dsh-plugin-goldboard/client.js | head -c 60` 输出 factory bundle；
  - `curl` 验证 config / snapshot / bars / test-notify 路由。
- 浏览器：
  - Chrome headless + CDP 验证浮窗 DOM 出现、设置页保存、语言中英切换即时生效；
  - 明暗主题下 `getComputedStyle` 检查浮窗与设置页颜色跟随 `--dsw-alias-*`。
- 行情：
  - 用真实接口做 10 分钟烟雾测试，确认报价新鲜度、来源切换、休市状态正确。

---

## 14. 评审问题确认结果（已逐项 ask-question 确认）

1. 手续费拆分：**买入 0 + 卖出 5**（双边合计 5）。
2. 交易标的：实际交易**招行积存金**；插件信号用 Au99.99（缺失时用国际金价折算），招行价兜底按国际金价按汇率折算 + 固定价差估算（默认 +1.72 元/克，买卖可分别调）。
3. 交易时段：**工作日 09:00–次日 02:00**，周末和法定节假日休市。
4. 提醒：**无冷却、无勿扰**，交易时段内每次阈值穿越都立即提醒。
5. 浮窗：**右上角，可拖拽，可收起为小圆球**。
6. 国际金价展示：**美元/盎司 + 折算元/克 + 内外价差**都显示。
