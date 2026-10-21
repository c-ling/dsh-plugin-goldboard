# dsh-plugin-goldboard — 设计文档（v1.15.0 当前实现 + 0.2.1 侧边栏页面重构）

> 状态：v1.13.0 是阶段 0 baseline；v1.14.0 完成阶段 1 数据与执行事实层。v1.15.0 已发布阶段 2 风险闸门/订单生命周期、阶段 3 ReplaySimulator/长期验证框架、阶段 4 策略实验层和 0.2.1 侧边栏页面重构：移除浮窗与 Settings 页面，改为 `sidebar.panellist` + `main` 独立页面；Host 路由进入 `/api`，配置回到插件私有 `config.json`。control 策略参数保持不变，真实账户同步和真实成交回填仍未实现。
> 证据定位：report v6 与独立 experiment report v1 均由 Host 根据数据集、OOS、成本、基准、消融和区间事实推导证据状态。当前真实历史、XAU/USDCNY 点时联合数据与费用核验不足，因此仍明确为探索性诊断；候选报告不会修改 live control，也不是实际成交或已验证策略的业绩证明。
> 目标环境：DeepSeek Harness 0.2.1+（Web 与 Desktop）；本地 `link:` 安装到 `web` / `desktop` profile。
> 插件形态：双面 Cordis 包（Node 宿主半 + 手写 factory-CJS 浏览器半），无构建步骤。

---

## 1. 需求访谈结论（已逐项确认）

| 问题 | 确认结果 |
| --- | --- |
| 信号金价标的 | **信号口径优先级：招行积存金实时价 → 国际金价 XAU 按汇率折算 → 上金所 Au99.99**；实际交易标的为**招商银行积存金**：招行实时价不可用时按国际金价按汇率折算 + 固定价差自动估算（默认 +1.72 元/克，买卖价差可分别设置），国际价也不可用时回退 Au99.99 + 价差估算 |
| 实际交易标的 | **招商银行积存金**；插件用 Au99.99（或国际金价折算）做信号，招行价优先通过招行市场中心接口拉取实时客户买卖价，接口不可用时按国际金价按汇率折算 + 固定价差自动估算（默认 +1.72 元/克，买卖价差可分别设置） |
| 成本模型 | 配置默认买入 0 + 卖出 5 元/克；v1.11.0 起该字段明确表示报价外显式费用，真实 bid/ask 内点差与 synthetic fallback 估算点差分开列账，用户需按实际产品协议核对 |
| 持仓周期 | **信号使用 5/10/30/60 分钟数据**；v1.9.0 起不固定倾向于日内了结——收盘前强制平仓提示默认关闭，是否在当天了结由用户按常规信号自行决定（可开启 `strategy.closeBySessionEnd` 恢复） |
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

- 侧边栏入口 + 独立主面板页面（`sidebar.panellist` + `main` key `goldboard`）：
  - 页面用 6 个 Tab：概览、交易、策略与回放、分析、数据、设置；最后访问的 Tab 记入 `sessionStorage`。
  - 页头与 Tab 栏固定，只有 Tab 内容区滚动；每个可配置 Tab 有独立保存按钮，只提交本 Tab 的配置节。
  - 概览：行情卡、今日走势（SVG）、当前建议、持仓/风险、数据质量；点击行情卡切换图表品种。
  - 策略与回放：回放统计、策略实验、信号账本；详情用弹窗。
  - 分析：模型配置、立即分析、查询日志。
  - 数据：数据源健康、历史覆盖、招行积存金分钟补录。
  - 交易：持仓/上限、风险预算、费用/价差、手动昨收、策略参数、交易时段；顶部独立保存条。
  - 设置：系统通知与 Webhook；独立保存条。
  - 每个可配置 Tab 有独立保存按钮，只提交本 Tab 的配置节；保存带 `expectedRevision` 冲突保护；离开页面丢弃未保存草稿（页内提示）。
  - 不注册 `shell.overlay` / `settings.section`；详情弹窗由页面触发。
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
| 路由前缀 | `/api/dsh-plugin-goldboard/*`（`ctx.connection.fetch`） |
| profile loader | bundle：`dsh.bundle.patch` + `cordis.patch.yml`；手动模式才手写 `- insert: { id: dsh-plugin-goldboard, name: 'dsh-plugin-goldboard' }` |
| 宿主依赖 | `inject: ["connection", "llm"]` |
| 浏览器 runtime 依赖 | client exports `inject: ["slots", "locale"]`；`package.json#dsh.client.inject: []` 是“其他 client bundle”图边，不是 runtime service 列表，保持为空 |

---

## 4. 总体架构

```
┌──────────── 浏览器半（lib/client.js 单文件，0.2.1 侧边栏页面）────────────────┐
│                                                                              │
│  sidebar.panellist（list / root scope）                                      │
│    GoldBoardIcon：内联 SVG，id "goldboard"，order 20                          │
│                                                                              │
│  main（keyed / root scope，key "goldboard"）                                  │
│    GoldBoardPage：页头 / 5 Tab / 全局保存条 / 错误边界                         │
│      overview：行情卡、今日走势、当前建议、持仓/风险、数据质量                  │
│      strategy：replay-stats、策略实验、信号账本 + 详情弹窗                     │
│      analysis：模型配置、立即分析、查询日志                                    │
│      data：数据源健康、历史覆盖、手动 CMB 补录                                 │
│      trading：持仓/风险/费用/价差/策略/时段；settings：侧边栏金价/通知/Webhook │
│                                                                              │
│  GET /api/dsh-plugin-goldboard/snapshot（10s；隐藏 60s）                      │
│  /config（revision）、/ledger、/models、/analysis、/analysis-logs、/data-sources│
│  语言切换：locale.register(NS, { zh, en })，所有可见文案走 t()                  │
└──────────────────────────────────┬───────────────────────────────────────────┘
                                   │ HTTP（/api，connection 认证桥）
┌──────────────────────────────────▼───────────────────────────────────────────┐
│                     宿主半（plan-05 模块拆分，index.js 为组合根）                │
│                                                                              │
│  lib/index.js（组合根）：apply() 接线 runtime/settings 缝/tick 循环/路由与双写  │
│  lib/public-api.js 仅导出稳定领域接口；测试兼容面位于 lib/testing.js              │
│                                                                              │
│  lib/sources.js  SourceRegistry 实例（每 apply 一个，消灭模块级单例）：          │
│                  传输 fetch 注入点、报价链预算、熔断、60s 去重、api-log 流       │
│  lib/parsers.js  各免费源纯解析器（新浪/腾讯/东财/SGE/60s/gold-api/Yahoo/CMB）   │
│    Au99.99 报价：新浪 gds_AU9999 / 东财 118.AU9999                             │
│    XAU 现货：  腾讯/新浪 hf_XAU；USDCNY：腾讯 whUSDCNY                          │
│  lib/market-time.js  CMB/SGE/XAU 独立日历、交易时段、完整覆盖事实                │
│  lib/indicators.js   SMA/EMA、Wilder RSI/ATR、MACD、布林带、5m→10/30m 重采样；    │
│                      只用收盘 K 线，输出 calculationVersion/warmupReady         │
│  lib/bars.js         bar 生命周期：recordTick/merge/aggregate/种子迁移/手工 CMB  │
│  lib/sizing.js       仓位分档、建议单工厂（三处字面量合一）、确认/冷却策略        │
│  lib/risk.js         RiskPolicy：每克风险事实、预算 sizing、只阻断新增买入的闸门  │
│  lib/signal-ledger.js setup/decision/order/adjustment 幂等 reducer 与只读投影     │
│  lib/spread-stats.js 动态招行价差样本 + 内外盘溢价 σ 统计                        │
│  lib/plan.js         computePlan 四阶段流水线（选道→指标→持仓分支→空仓分支）；      │
│                      5/10 分钟覆盖率 >80%、30/60 分钟 >60% 才出建议              │
│  lib/history.js      K 线种子与缺口回填作业                                     │
│  lib/historical-store.js  按交易日 append-only CMB 双边 point-in-time 历史       │
│  lib/alerts.js       消息模板、系统通知（osascript/notify-send/PowerShell）、     │
│                      Webhook 渠道、dispatchAlert、告警边沿评估                   │
│  lib/snapshot.js     /snapshot 视图 + /replay 确定性回放（黄金快照回归锚点）       │
│  lib/routes.js       route() 助手（方法分发/405/413/错误信封）+ 全部路径表        │
│  lib/store.js        原子写队列、分区脏标记 StatePersister、ApiLogStore           │
│  lib/config.js       默认值/归一化/密钥脱敏/补丁合并 + plan-04 设置 schema        │
│  lib/strategy*.js    策略契约/注册表/control adapter/ORB 状态机与隔离实验 runner │
│  lib/factor-contract.js / market-regime.js  点时因子契约与可解释市场状态         │
│                                                                              │
│  持久化：$DSH_HOME/storages/dsh-plugin-goldboard/{config,state}.json           │
│            + history/*.jsonl（CMB 双边）+ api-log/alerts/analysis logs           │
│            + replay-reports/ + strategy-experiment.json                        │
│            + state migration backup / SHA-256 manifest                         │
│                                                                              │
│  路由（每个路径注册一次，内部按 method 分发）：                                  │
│    GET/POST /api/dsh-plugin-goldboard/config                                      │
│    GET      /api/dsh-plugin-goldboard/models                                      │
│    GET/POST /api/dsh-plugin-goldboard/analysis                                    │
│    GET      /api/dsh-plugin-goldboard/analysis-logs                               │
│    GET      /api/dsh-plugin-goldboard/snapshot                                    │
│    GET      /api/dsh-plugin-goldboard/bars?instrument=&interval=&limit=            │
│    POST     /api/dsh-plugin-goldboard/replay                                      │
│    GET/POST /api/dsh-plugin-goldboard/replay-stats                                │
│    GET      /api/dsh-plugin-goldboard/replay-reports                              │
│    GET      /api/dsh-plugin-goldboard/strategies                                  │
│    GET/POST /api/dsh-plugin-goldboard/strategy-experiments                        │
│    GET      /api/dsh-plugin-goldboard/manual-cmb-missing                          │
│    POST     /api/dsh-plugin-goldboard/manual-cmb-bars                             │
│    POST     /api/dsh-plugin-goldboard/test-notify                                 │
│    POST     /api/dsh-plugin-goldboard/system-settings                             │
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

- `MarketDataContract` / `normalizeQuoteRecord()`：输出 `goldboard-market-data-v2`，统一 instrument/market/currency/unit、source/sourceTimestamp/receivedAt/ingestedAt、sourceDelay/futureSkew、quality/synthetic 和 customer ask/bid 独立来源；legacy/manual/proxy 不因字段完整而升级为 real。
- `normalizeBarRecord()` / `closedBars()`：拒绝无效 OHLC，保留 real/synthetic/proxy/unknown 执行证据；缺子 K 或包含 partial 子 K 的自然桶保持 partial，正式指标默认排除。
- `inspectWindowCoverage()` / `assessMarketQuality()`：同时输出比例、有效样本分钟、最大缺口、距最近缺口、重锚与 missing buckets，并集中检查 stale/future、OHLC、warm-up、品种和依赖质量。
- `inspectXauConversion()`：XAU 与 USDCNY 两腿共用同一 as-of 质量判断；任一 stale 或未来时间戳都返回 `null + reasonCodes`。
- `replayMarketPlan()`：用固定 `asOf`、报价和 bars 重建指标与规则 plan，不发起网络请求或模型调用。

指标计算版本为 `goldboard-indicators-v3`，EMA 使用 SMA seed，RSI/ATR 使用 Wilder 平滑。XAU 指标保持 USD/盎司原生口径，只在 XAU 与 USDCNY 两腿都通过 point-in-time 质量检查后做 CNY/克换算。

### 5.2 Harness 分析接口

`lib/analysis.js` 只依赖宿主提供的 `ctx.llm`：

1. `listProviders()`、`listModels()`、`resolveModelInfo()` 合并成 `/models` 只读投影；单个 provider 失败进入 `failures`。
2. `prepareCall({ provider, model, reasoningEffort, temperature, maxTokens })` 固定一次调用，再通过准备好的 handle `stream()`。
3. 输入只包含宿主快照、已收盘 bars、指标、质量和规则 plan；系统约束 `noPriceFabrication`、`noOrderExecution`，模型动作不含 buy/sell。
4. 独立 AbortSignal/超时、input hash 缓存、running 去重和 `force` 缓存绕过不影响行情 tick。
5. text blocks 严格 JSON parse 和结构校验；provider、超时、取消、空输出、JSON/schema 失败分别进入稳定状态。

`lib/analysis-log.js` 将一次调用的 `started`/`finished` 事件写入 JSONL，合并成可分页摘要；详情默认脱敏，进程重启时遗留 `running` 会标记为 `aborted`。

### 5.3 客户端设置

客户端使用侧边栏 `sidebar.panellist` 入口与 `main` 独立页面；模型选择保存在插件配置中，不读写 Harness 全局会话模型。查询日志、回放详情、信号账本仍使用独立对话框，支持筛选/分页/复制、Escape 关闭和中英文即时切换。

### 5.4 阶段 1 事实层接口

- `getTradingCalendar()` 分别提供 CMB reminder v2、SGE day/night v1 和 XAU 24x5 v1；CMB 用户配置不再过滤 SGE/XAU 历史。snapshot 和 replay 保存实际 lane 的 `calendarVersion`。
- `HistoricalStore` 按 CMB 交易日追加 JSONL，稳定 event ID 去重、跨实例锁定、as-of 查询；尾部撕裂截断后继续写，中部损坏只隔离对应分区。热 bars 仍双写 `state.json`，便于旧版本回滚。
- state schema v3 首次迁移前保存 v1/v2 原字节备份和 SHA-256 manifest；内容不同的二次迁移生成独立备份，`rollbackStateMigration()` 恢复 manifest 指向的确切文件。
- `ExecutionModel` v2 是 quote/bar/account/value 的成本 seam。部分 live quote 返回 ask/bid 缺侧 reason code；历史 proxy 只有调用方显式 `allowProxy` 才可投影，且 assumptions 随结果和 report 输出。
- 根入口不再暴露 parser、可变 bar helper、存储原语或全局 fetch hook；稳定子入口为 `./market-data`、`./execution`、`./history`、`./replay`，内部测试面为 `./testing`。

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
  **镜像回退（v1.8.0）**：主源被反爬限流（连续 Empty reply / 连接中断，实测存在）时自动改用
  `push2delay.eastmoney.com` 延迟镜像——对已收盘历史 bar 两者数据完全一致（15 分钟延迟无影响）；
  镜像拥有独立熔断记账（`<sourceId>-delayed`），主源熔断保护实盘轮询的同时镜像仍可兜底，
  数据源状态页新增 `eastmoney-kline-delayed` 行。
  历史兜底：上金所 `POST https://www.sge.com.cn/graph/Dailyhq`（`instid=Au99.99`，行格式 `[日期, 开, 收, 低, 高]`）。
- XAU/USD 现货 K 线：东财 `122.XAU` 为现货主源；源不可用时质量状态明确降级，不把其他品种改名为现货。
- `GC=F` 期货日线诊断：Yahoo Finance
  `query1.finance.yahoo.com/v8/finance/chart/GC=F?interval=1d&range=5y`，独立保存到 `GCF` lane，不参与 XAU/USD 现货指标。
- XAU 分钟线：免费源不稳定。宿主以 30s 现货报价自建 1m/5m/15m/60m bars（`open,high,low,close,ts`），标记 `synthetic=true`；正式指标排除当前未收盘桶，冷启动时标注 warm-up 未完成。
- **60 分钟桶的冷启动聚合（v1.3.1）**：由 5 分钟 K 线构建 60 分钟桶时执行真聚合（`o = 首根子bar.o`、`h = max(h)`、`l = min(l)`、`c = 末根子bar.c`），只聚合已完整结束的小时桶，进行中的小时交给报价路径维护；东财专用 60 分钟 K 线拉取保留为更长历史的补充。元数据继承首根子 bar，`synthetic: false`。

### 6.3 采集规则

- 报价轮询 30s（可配置 10–300s）；K 线增量每 5 分钟补齐一次。
- **链路预算（v1.4.0）**：每条 fallback 链（国内 / XAU / USDCNY / CMB 三传输）共享一个
  `QUOTE_CHAIN_BUDGET_MS = 12s` 的总预算；链内单源超时 = `clamp(剩余预算 ÷ 剩余源数, 3.5s, 6s)`，
  预算耗尽即跳过余下源；任一源成功或整链穷尽时 abort 该链全部在途请求（`AbortController` 贯穿
  header + body 全程）。此前各源独立叠加 6s 超时，最坏可阻塞一个 tick 约 24–42s。
- 每源熔断：连续 3 次失败停用 10 分钟。不做指数退避重试——故障隔离由熔断承担，失败直接落到下一源。
- 单源失败用上一快照 + `stale: true` + 来源标记，不中断看板；国内源报价时间戳超过
  `STALE_QUOTE_MS = 15min` 视为 stale，不再接受为有效 tick。
- **api-log 轮转与尾读（v1.4.0）**：`api-log.jsonl` 超过 `API_LOG_MAX_BYTES = 2MB` 时轮转为
  `.1`（仅保留一代）；读取（含启动加载）只读文件末尾 256KB 并丢弃撕裂的首行，取末 500 条。
- **bars 种子版本失效机制（v1.3.1）**：`state.json` 记录 `barsSeedVersion`（当前 `BARS_SEED_VERSION = 2`）。加载时若字段缺失或 ≠ 当前值，丢弃 AU9999 / XAU 两道的 `bars[5]` 与 `bars[60]`（其余周期与 lane 保留），下一次 tick 由修复后的种子逻辑重建，并回写新版本号——用于旧版本污染数据（v1.2.x 曾用末根子 bar 整体覆盖 60 分钟桶）的一次性清理。
- 不做高频轮询，遵守免费源非官方接口的容忍度；接口变更时必须降级而不是崩溃。

### 6.4 交易时段与市场状态

- 交易时段按**招商银行积存金**（北京时间，可在交易 Tab 编辑）：
  - 每周一至周五 09:00–次日 02:00 为可交易时段（周五 09:00 开启的时段延续到周六 02:00 结束）。
  - 周六、周日不开启新时段；法定节假日休市（交易 Tab 提供节假日表编辑，v1 默认空表，后续可内置中国法定节假日）。
  - 实际执行以招行 App 交易规则为准；插件时段表只是提醒开关，不代替银行规则。
- `marketState` 仍代表 CMB 提醒/执行闸门；行情采集和 replay 则按品种日历：SGE/Au99.99 为北京时间 09:00-11:30、13:30-15:30、20:00-次日 02:30，XAU/USD 为独立 UTC 24x5 template。三者版本分别写入 snapshot/report；未知品种使用 closed adapter，不静默套用 CMB。
- `marketState` 写入 snapshot：`open / closed`；`open` 表示招行积存金当前可交易。
- 休市期间：报价看板继续显示最后价，但**抑制所有买入/卖出提醒**；数据过期 > 15 分钟（`STALE_QUOTE_MS`）触发一次 `data_stale` 提醒。
- 招行积存金价格：
  - 优先：`https://mbmodule-openapi.paas.cmbchina.com/product/v1/func/market-center` 返回 `zBuyPrc`（客户买入价）/ `zSelPrc`（客户卖出价）；折线图使用客户买入价绘制，`average = (zBuyPrc + zSelPrc) / 2` 仅作兼容保留。
  - 回退：`ask ≈ reference + buyOffset`、`bid ≈ reference + sellOffset`，并用 `estimatedSpreadPerGram` 保证 synthetic 双边最小距离。offset 来源为 `dynamic-bid-ask`（6h 内至少 30 个双边样本）→ `dynamic-legacy`（仅旧 spreadMid 样本）→ `static`；snapshot 同时披露 sample count、校准起止时间、CMB/XAU/USDCNY 来源集合、legacy、synthetic、quality 和 executionVersion。
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

### 7.2 ExecutionModel、成本与估值

`lib/execution.js` 是 live plan、snapshot 与 replay 共用的内部 module：

```text
buyCost = executableAsk + explicitBuyFee + buySlippage
sellProceeds = executableBid - explicitSellFee - sellSlippage
pnl = sellProceeds - buyCost
```

- 真实 CMB 客户双边报价直接成为 ask/bid；`estimatedSpreadPerGram` 不再叠加到真实双边价。
- 缺少双边价时，reference + `cmb.buy/sellSpreadPerGram` 生成 synthetic ask/bid；估算点差只在该路径建立最小双边距离，并在 `components` 中披露。
- 配置的 `fee.buy/sellPerGram` 明确定义为报价外显式费用，`slippagePerGram` 按买卖各自记账。默认仍为买入 0、卖出 5、滑点 0.2；该业务语义必须由用户按产品协议核对。
- opt-in `cmb.deriveSellFromFee=true`：卖出价改为 `executableAsk − fee.sellPerGram`，实时卖出价只用于偏离提示；execution quote 标记 `feeIncluded` 与 `evidence=proxy`，执行/风控/账本/回放的卖出费因此只记一次。派生卖出价与实时卖出价偏离 ≥0.5 元/克时 plan 附 `configured_spread_drift`，但不阻断交易。默认关闭，保持上一行语义。
- 持仓估值只依赖持仓和新鲜 executable bid，不依赖技术指标门控。不可估值时返回 `feeAdjustedPnl:null + valuationReasonCode`，绝不补 0。
- 止损直接比较 `effectivePnlPerGram <= -maxLossPerGram`；展示阈值由同一 module 推导，避免手续费符号反转。
- 动态 fallback 校准按分钟分别持久化 `buyOffset = customerBuy-reference` 与 `sellOffset = customerSell-reference`；30 个新鲜样本后分别取中位数。v1.10 的 `spreadMid` 样本继续可读，但 `spreadSource=dynamic-legacy`。
- 新采集 CMB bar 保存 ask/bid OHLC；旧单边 bar 继续保留原始身份，replay 只能标记为 proxy，不能视为真实双边历史。

### 7.3 信号规则（默认参数全部可在交易 Tab 调整）

**数据完整性门槛（所有建议共用，v1.1）**

- 信号按标的（**招行实时价 → 国际金价折算 → Au99.99**）选择后，检查该标的 1 分钟 bars：
  最近 **5/10 分钟**窗口的有效数据覆盖率必须 **> 80%**，**30/60 分钟**窗口必须 **> 60%**（每分钟一个价格点，有 1 分钟 bar 且收盘价有效才计入）。
- 任一窗口不达标：`action = data_incomplete`，不输出建议委托单，看板显示「当前数据有缺失，暂不给出建议」，并展示各窗口覆盖率（`plan.dataCoverage`，如 `{ "5": 1, "10": 0.9, "30": 0.97, "60": 0.83 }`）与对应 `reasonCodes`（如 `data_incomplete_60m`）。
- **开盘后 1 小时内与每天 0 点-1 点期间的放宽**：30/60 分钟窗口在开盘初期或跨日 0-1 点时段天然不足（60 分钟窗口约需累积 37 个分钟点才 >60%），因此开盘后 1 小时内、以及每天北京时间 0 点-1 点期间，只校验 **5/10 分钟**窗口；数据参考仍尽量覆盖 5/10/30/60（指标照常按四个周期计算，10/30/60 分钟线有历史预热时趋势过滤不受影响）。`dataCoverage` 仍报告全部四个窗口，仅 `reasonCodes`/拦截按生效窗口输出。
- 门槛不替代过期检查：报价过期仍走 `data_stale`；休市仍走 `market_closed`。
- 覆盖率的其余预期后果：轮询间隔 > 60s 或报价中断会按缺口如实反映（5 分钟窗口缺 1 分钟即 80% 不达标）。
- **中断缝重锚定（v1.9.0）**：向前扫描时遇到连续 ≥ `COVERAGE_REANCHOR_GAP_MINUTES`（8）个缺失交易分钟，视为一次中断缝（主机睡眠/源故障）：缝之前的槽位不再计入分母，窗口改为只度量「恢复后」的分钟段。否则一段长空洞会让 30/60 分钟门闩在数据恢复后再红近一小时（2026-08-25 实测：09:40-10:34 睡眠空洞使 60m 门闩 ~11:35 才放行）。短窗口（< 缝长）扫不到完整缝、保持原滚动行为；持续中断（全缺失）仍为 0。

**信号道粘滞（v1.5.0）**

- 信号道优先级固定为 **招行实时 → 国际金价折算 → Au99.99**；切换不再按单次可用性即时决定：
  - **降级切换**：当前道连续 ≥ `LANE_SWITCH_TICKS = 3`（≈90s @30s 轮询）不可用才切到下一优先可用道；
  - **回升切换**：更高优先道恢复连续 ≥ `LANE_RECOVER_TICKS = 3` 才切回；
  - 等待期间 plan 附 `reasonCodes: signal_lane_degraded`，指标与建议价仍按当前道最后数据计算；
  - 切换瞬间发送一次性 `lane_switched` 提醒（仅降级方向，回升静默，看板 `plan.signalLane` 始终显示当前道）；
  - 道变更时确认 streak（confirmBars 时钟）全部清零重新计数；
  - 休市期间不评估切换；手动 replay 无粘滞状态，按输入直接决议。

**无持仓（日内做多）**

必须同时满足：

1. `marketState` 为 `open`（招行积存金工作时段 09:00–次日 02:00 内）；
2. 数据完整性门槛通过（见上）；
3. **10/30/60 分钟 EMA20 全部向上**（多周期趋势共识：60 分钟线来自东财 K 线/自建，10/30 分钟线由 5 分钟线重采样得到，冷启动即有历史预热）；
4. 5 分钟 RSI14 当前位于 `(rsiOversold, 50)`，或当前技术价高于 5 分钟 SMA20；这是状态条件，不声称发生了上穿；
5. 价格距离近 20 根 bar 低点或布林下轨不超过 0.5%。

输出：

- `action = buy_setup`
- 建议买入价（信号价口径）= `min(现价+0.1, 近20低点 + 0.3×ATR)`
- 建议招行买入价 = 建议买入价 + `cmb.buySpreadPerGram`
- 建议克数按最大克数的轻仓 20% / 标准仓 60% / 上限分档推进，单次最多增加上限的 10%（至少 1 克）
- 目标卖出价（招行口径）= `max(breakevenBid + 最小利润, 近20高点 - atrFactor×ATR + sellOffset)`

**阶段 2 风险预算与买入闸门**

- `risk.mode = fixed_grams` 是兼容默认：先按上述目标仓位分档得出克数，再与所有正数约束取最小值；全部新增约束为 0 时输出与 v1.14 相同。
- `risk.mode = budget` 只在用户显式选择后生效，且至少需要一个现金风险预算。每克最坏风险口径固定为：
  `stopDistance = max(ATR(5m) × volatilityTarget, executableAsk - executableBid, 双边滑点)`；
  `riskPerGram = stopDistance + quotedSpread + 双边显式费用 + 双边滑点`。
- 最终克数向下取整到 0.01 克，并同时满足 `limits.maxGrams`、`maxAmountCny`、`maxRiskPerTradeCny`、日/周损失剩余额度、回撤剩余额度与 `liquidityCapGrams`。ATR、点差、滑点或费用单调上升时，其他输入不变的建议克数不得增加。
- 日/周损失按北京时间切分，累计本地建议单经 `user_position_confirmation` 确认的负 PnL 绝对值并加当前负浮盈亏，后续盈利不恢复已消耗预算；drawdown 由估算累计净损益峰值加当前负浮盈亏计算。该证据固定标记为 `local_advisory_ledger`，不称为账户流水。
- `maxAddsPerSetup`、`maxAddsPerDay`、`minAddPriceImprovementPerGram` 和成交后 cooldown 只限制新增买入。连续亏损达到 `consecutiveLossDeRisk` 时按确定性 1/2 档位缩量。
- 风险策略只裁决 buy candidate；`sell_stop`、`sell_trailing`、`sell_weakness`、止盈和收盘退出等卖出路径不读取 buy gate，始终保留保护性退出能力。
- 闸门触发时保留 `candidateAction`、`activeSignals/suppressedSignals` 与 decision 风险快照，最终 `suggestedOrder = null`；不得创建虚假 order/fill。

**持仓中**

任一条件触发：

| 触发 | 输出 |
| --- | --- |
| 现价 ≥ 目标卖出价 | `sell_take_profit`：建议委托卖出全部或可配置比例 |
| 最后一根 5 分钟收盘低于 5 分钟 SMA20 且有效浮盈 > 0 | `sell_trailing`：移动止盈参考价 |
| 统一账本的 `effectivePnlPerGram <= -maxLossPerGram` | `sell_stop`：止损参考价 |
| 距当日交易时段结束 < 30 分钟仍持仓 **且 `strategy.closeBySessionEnd` 开启** | `close_by_session_end`：日内了结提醒（不自动计算价格）。**v1.9.0 起默认关闭**——不固定倾向于日内了结，关闭时最后半小时继续走止盈/移动止盈/止损/走弱的常规信号链 |
| RSI14 > 75 且 5 分钟出现阴线吞没/上影 > ATR | `sell_weakness`：减仓参考 |
| 持仓满 `maxBarsBeforeTarget` 根 5m 仍未触目标（opt-in） | `sell_time_stop`：武装前时间止损，清仓 |

**目标回撤止盈与 60 分钟趋势闸门（当前工作树，opt-in，默认关闭）**

- `strategy.targetTrailPerGram = 0` 保持旧行为：`bid ≥ target` 立即 `sell_take_profit`。
- 开启后（>0），触达目标只把持仓置为 armed 并记录 `peakBid`，不卖出；卖出线 = `max(targetBid, peakBid) − targetTrailPerGram`。`bid ≤ 卖出线` 输出 `sell_target_trail`（清仓）；`targetPartialRatio > 0` 时首触目标先卖该比例，剩余继续跟踪；`targetTrailBars > 0` 时，连续 N 根已收盘 5 分钟 K 线未创新高也输出 `sell_target_trail`。
- 状态持久化在 `signalState.targetTrail`，以 `instrument|avgCost` 为签名：加仓改变成本即重置，清仓清除；仅部分卖出不会重置。
- `sell_target_trail` 属于 emergency：绕过同向冷却与 confirmBars。同时开启回撤止盈时，`reduce_position` / `sell_trailing` / `sell_weakness` 三条自由裁量退出被跳过，退出策略收敛为「止损 / 收盘 / 目标回撤」，避免它们在目标前把仓位卖掉。
- `strategy.requirePriceAboveEma60 = true` 时，`trendUp` 额外要求 `technicalPrice > ind60.ema20`；默认关闭，只影响 buy_setup/add_position，不影响任何卖出路径。
- `strategy.requireDailyUptrend = true` 时，`trendUp` 还要求最近一根**已收盘**日线的收盘价高于日线 EMA20、且该 EMA20 上行；日线不足时 fail closed。当前未收盘日线被排除，禁止用当日不完整收盘判定。
- `strategy.maxBarsBeforeTarget > 0` 时启用**武装前时间止损**：以最早未平仓 lot 的 `time` 起算，持仓满 N 根已收盘 5m K 线仍未触及目标（且未被回撤止盈武装）则输出 `sell_time_stop` 清仓。它与 `targetTrailBars` 的“武装后超时”是两套规则；lot 时间缺失时该规则不生效。`sell_time_stop` 属于 emergency。

**sell_weakness（v1.5.0 实现，持仓减仓参考，不要求浮盈）**

全部条件基于**已收盘的 5 分钟 bar**：

1. 有持仓；
2. `rsi14(5m) > strategy.weaknessRsi`（新增配置，默认 75）；
3. 最后一根收盘 bar 为**阴线吞没**（实体完全覆盖前一根阳线实体），或**上影线长度 > `atr14 × strategy.weaknessShadowAtrMult`**（新增配置，默认 1.0）。

输出：`action = sell_weakness` + 减仓克数沿用目标仓位区间逐级减仓并保留最小底仓
（与 `reduce_position` / `sell_trailing` 同一 sizing）；reasonCodes 附
`weakness_rsi_overbought` 与 `bearish_engulfing` / `long_upper_shadow`；走既有边沿告警状态机。

**国际价确认 / spread_alert（v1.5.0 实现）**

- state 维护 `premiumHistory`：每日一条 `{ date, premiumPerGram }`（当日 domesticPremiumPerGram
  开盘期间样本的滚动中位数；上限 60 条滚动持久化）。
- 已完成日样本 ≥20 天时计算 population mean/σ（与布林口径一致）：|当日值 − mean| > 2σ →
  边沿告警 `spread_alert`（仅提示“内外盘异常”，不直接开仓、不改 plan.action）；按北京日期
  抑制，次日自动重新武装。
- 样本不足时不下发告警，仅在 snapshot `quality.warnings` 提示 `premium_history_accumulating`，
  并在 `derived.premium` 透出 `{ today, sampleDays, minDays, mean?, sigma?, deviationSigma? }`。

### 7.4 建议委托单（手动执行）

每条交易建议生成：

```json
{
  "action": "buy_setup | sell_take_profit | sell_trailing | sell_stop | ...",
  "instrument": "Au99.99",
  "side": "buy | sell",
  "setupId": "setup-…",
  "decisionId": "decision-…",
  "orderId": "order-…",
  "signalPrice": 948.60,
  "cmbEstimatedPrice": 950.60,
  "grams": 20.00,
  "nominalAmountCny": 19012.00,
  "stopDistancePerGram": 5.00,
  "riskPerGram": 10.40,
  "worstCaseLossCny": 208.00,
  "riskBudgetRatio": 0.0104,
  "validUntil": "2026-08-15T01:50:00+08:00",
  "reasonCodes": ["trend_ema20_up", "rsi_rebound", "near_support"],
  "riskNote": "技术面参考，非投资建议"
}
```

- `validUntil` 取当前招行交易时段结束前 10 分钟，超时后建议自动失效。
- 浏览器侧提供“一键复制委托文本”，文本中明确写“招行积存金估算价，以 App 实际报价为准”，不执行任何下单动作。
- 宿主会记住最近一次已提醒的 `suggestedOrder`（持久化到 `state.json`，含 `issuedAt` / `issuedPositionGrams` 出厂戳）。阶段 2 同时在 `signalLedger` 保留有界历史，并将同一 transition 写为 pending/filled/expired/replaced；受阻断 candidate 只产生 `not_executed` decision。**v1.9.0 生命周期语义（`classifyOrderTransition`）**：建议后的同方向冷却转观望、连续确认中或数据类状态只代表「挂单监控中」，不再触发撤单提醒；仅当出现实质性变化才升级——方向相反的新信号或同向替代建议（`cancel_order`）、现价偏离原挂单价 ≥ `strategy.orderRepricePct`%（默认 0.5，设为 0 关闭）（`cancel_order` + 偏离附注）、价格/克数实质变化 ≥ 0.5 元/克（`order_updated`，微小重报静默刷新有效期）；仓位朝建议方向变化视为已成交、到期与休市则静默清除跟踪。**同形改价风暴降噪（v1.9.0）**：价格/克数不变、仅建议价漂移 ≥0.5 元/克的同形更新，在距上次提醒不足 `ORDER_UPDATE_MIN_INTERVAL_MS`（10 分钟）内静默刷新（保留 `updatedAt`/`alertedPrice` 戳）；只有相对「最近一次已通知价」累计漂移 ≥ `ORDER_UPDATE_ESCALATION_DELTA_PER_GRAM`（3 元/克）才立即穿透提醒。实测背景：2026-08-25 01:44-02:00 招行卖价每 tick 抖动越阶，16 分钟连发 ~35 条 `order_updated`。无戳的旧版存量订单行为不变（照常提醒），首次盖章后生效。

**阶段 2 setup/signal/order ledger**

- 连续满足同方向、同 instrument 条件时复用一个 `setupId`；条件结束、lane/方向改变时关闭旧 setup。价格漂移和重复轮询不会创建新 setup。
- `decisionId` 的幂等 fingerprint 包含 setup、已收盘信号 K、candidate/final action、仓位和阻断原因；同一 K 的重复 poll 不增长 decision/order 数组。
- decision 保存 active/suppressed signals、当时仓位、建议规模、名义金额、可用风险预算和阻断原因。闸门触发时 status 为 `not_executed` 且 `orderId = null`。
- order 保存 pending → filled/expired/replaced 轨迹。持仓变化只在方向与唯一 pending 建议匹配且覆盖建议克数时标记 `filled`，证据为 `user_position_confirmation`；部分/不唯一/无 pending 的变化只写 `manual_position_adjustment`，不伪造银行成交。
- 用户确认的卖出可按建议价、出厂成本、费用与滑点计算 `realizedPnlCny` 估算；缺事实返回 null，不补零。ledger 数组有界，策略与回放 Tab 和 `GET /ledger` 提供只读查询。

### 7.5 提醒边沿触发（无冷却、无勿扰）

- 每个 `action` 维护 `idle → armed → fired` 状态机，只在条件从 false→true 的**边沿**触发，避免同一个 tick 内重复发送。
- **不设时间冷却、不设勿扰时段**：交易时段内价格重新穿越阈值就再次立即提醒。
- 休市期间条件不进入 `armed`；开盘后按开盘价重新评估。
- 同一评估周期多条提醒合并为一条摘要（系统通知 + Webhook 各发一份），避免一个 tick 内轰炸。
- 除常规买卖信号外，还额外跟踪最近一次委托建议；按 §7.4 的 v1.9.0 生命周期语义，仅在冲突/漂移/实质更新时以 `cancel_order` / `order_updated` 边沿提醒，观望与数据缺口保持静默监控。
- **连续确认与冷却语义**：`strategy.confirmBars = N` 表示方向条件需在连续 N 根已收盘 5 分钟 bar 上成立；同一 bar 的重复轮询不重复计数。动作离开方向集、信号道切换、休市或仓位变化会清空 streak。v1.11.0 起仓位变化不再清空 `lastSide/lastAt`，同一 setup 成交后仍受同向冷却约束。

### 7.6 历史回放兼容口径（v1.14.0，report v5）

以下是仍受支持的 v5 只读口径，不发提醒、不调模型、不修改真实持仓。v5 首次把策略决策与订单成交分开：

- **统计宇宙**：`lane:"cmb"` 默认使用本机持久化 CMB 序列，`lane:"au9999"` 使用东财历史。新 CMB bar 有真实 ask/bid OHLC 时直接使用；旧单边 bar 只可按固定 5 元/克差生成 proxy bid，`realBidAskCoverage` 不计为真实。
- **完整时段**：默认枚举最近 N 个已过配置收盘时点的交易日；数据没有到达配置时段尾部则标记 partial 并排除。只有显式 `includePartial:true` 才按截至时点单列，不进入 `sessionEnd*` 指标。
- **决策与订单**：信号在已收盘 K 线结束时产生 pending limit order，`eligibleAt = signalAt + 5m`。最早从下一根完整 5 分钟 K 线判断：买单 ask low ≤ limit、卖单 bid high ≥ limit 才模拟成交；未触及或超过 `validUntil` 记 expired。没有 5 分钟内部分成交/队列假设。
- **资金约束**：连续账户从 0 克开始，pending 买单会占用剩余克数预算；同向替代建议先把旧单记为 replaced，避免并发挂单超配。策略条件通过确认/冷却、但账户已达到 `maxGrams` 时记录 `unexecutedSignals[]`（`status:not_executed`、`reasonCode:position_limit`、与正常补仓共用计算的 `signalPrice/limitPrice`），不创建订单，也不进入成交率、现金流或盈亏。
- **OHLC 歧义**：同一 bar 同触 target/stop 时 `firstTouch:"ambiguous"`，默认 `conservativeTouch:"stop"`，并输出 `bestCaseNet/worstCaseNet/ambiguityImpactCny`。回本只在 executable/proxy bid high ≥ breakeven 时命中；要求真实双边但缺失时为 unknown。
- **统一账本**：fill、已实现盈亏、期末估值和成本拆分调用 `ExecutionModel`；report 新增订单/成交/过期数、成交率、平均延迟、真实双边覆盖率、equity curve、最大回撤、turnover、profit factor 与费用/滑点拆分。
- **独立信号诊断**：空仓/持仓双 pass 仍用于 `perAction` 和规则分箱，但每个 decision 也必须先通过同一 next-bar limit fill/expiry；未成交 decision 保留 `fillStatus`，不产生 target/breakeven/MFE/MAE/session-net outcome，且不与顶部连续账户相加。
- **兼容**：v4 落盘报告继续原样读取，但客户端显示“旧执行假设，不可与 v5 比较”，且不把 v4 overall/命中率投影成 v5 卡片。
- **缓存**：键包含窗口、车道、策略/费用、execution/fill/ambiguity policy、partial 与 executable-bid 开关；同键缓存 1 小时。

**已知局限（报告 `caveats` 数组如实携带，策略与回放 Tab 展示）**

| caveat | 说明 |
| --- | --- |
| `lane-cmb-persisted-bars` | 默认积存金道；旧单边历史按固定 5 元/克生成 proxy bid，新双边历史才计真实覆盖 |
| `lane-au9999-only` | Au99.99 参考道；不能直接套用于 CMB 执行 |
| `minute-coverage-from-5m` | 分钟覆盖由 5m K 拆分，无法观察 5 分钟内缺口 |
| `synthetic-lane-sampling` | synthetic/proxy 路径保真度低于真实双边轮询 |
| `history-depth-limited` | 免费历史和本地滚动窗口限制样本长度 |
| `next-bar-limit-fills` | 下一根 K 才可成交，未触及/过期不成交 |
| `conservative-ambiguous-bars` | 同 K 双触及默认保守止损路径 |
| `complete-session-only` | 默认只统计数据尾部完整的已结束时段 |
| `two-simulated-passes` | 独立信号表的空仓/持仓诊断不属于连续账户 |
| `past-performance-advisory` | 工程诊断不是未来表现或样本外证据 |

**工程约束**：单飞行去重；客户端断开按交易日边界取消；逐日让出事件循环；中途源失败产出部分报告。`replay-stats.json` 持久化 report、orders、fills、pendingOrders、trade-compatible 明细与最近 200 条 `unexecutedSignals`；report 摘要保留窗口内未执行信号总数。`detail=true` 返回相同生命周期数据，独立 events 仍截断最近 200 条。

### 7.7 阶段 0 baseline 与证据状态

阶段 0 只冻结口径，不把当前短窗口 replay 提升为业绩验证。新生成 report 的 provenance 字段如下：

| 字段 | 当前值 / 语义 |
| --- | --- |
| `version` | `5`，replay wire schema 版本 |
| `strategyId` / `strategyVersion` | `control` / `goldboard-control-v1`，当前趋势回调规则身份 |
| `calculationVersion` | `goldboard-indicators-v3`，指标算法版本 |
| `dataSchemaVersion` | 新报告为 `goldboard-market-data-v2`；阶段 0 已落盘报告保留原 `goldboard-market-data-v1` |
| `executionVersion` | 新报告为 `goldboard-execution-v2`，partial side 与 proxy opt-in 语义固定；旧报告保留 v1 |
| `calendarVersion` | 按 lane 为 `goldboard-cmb-reminder-v2` 或 `goldboard-sge-calendar-v1`；旧报告保留 `goldboard-configured-session-v1` |
| `evidenceStatus` | 当前固定为 `exploratory`（探索性诊断）；`validated` 只能由未来独立验证流程显式产生 |

`validationGate` 保存机器可读的 `eligible`、`unmet` 和门槛快照。晋级为 `validated` 至少需要 12 个月历史（目标 24 个月）、6 个月训练/1 个月测试的按月滚动 OOS、测试参数冻结、多折 OOS、真实双边证据、已核实的产品费用语义、基准比较和不确定性区间。当前 replay 只有短窗口诊断，因此 `eligible:false`，不能由成交率、净结果、命中率或回撤推导验证结论。

`costAssumptions` 与 `executionCoverage` 是报告级事实说明：前者列出报价外显式费用、滑点、fallback/proxy spread 及其来源和未核实标记；后者分别列出 real bid/ask、proxy 和 unknown 的 bar 数及比例。真实 bid/ask 的报价内点差不再重复加估算 spread。无样本或旧报告缺字段时显示 unknown，不补当前默认值。

阶段 0 的兼容规则是 additive：v4 和阶段 0 之前生成的 v5 文件经 `GET /replay-stats` 原样只读返回，不迁移、不补字段、不重算；客户端只显示它们已有的安全元数据和 legacy/不可用提示，不把缺失字段补成阶段 0 基线，也不把结果提升为真实业绩。`past-performance-advisory` 与 `two-simulated-passes` caveat 必须随新 report 保留。

**阶段 0 文档/前端口径差异清单**：历史 v4/v5 文件没有新增 provenance 时只显示旧执行/元数据不可用；新 v5 report 显示完整 provenance、探索性状态、成本假设和 real/proxy/unknown 覆盖；README 与页面均将这些数值称为 5 分钟模拟诊断，而不是实际业绩；v1.11.0 说明页保留历史实现并链接当前基线。

### 7.8 阶段 3 ReplaySimulator 与 report v6

阶段 3 把现有回放拆成五个可独立测试的深模块：

- `replay-simulator.js`：`ReplaySimulator.run({ frames, strategy, execution, initialPortfolio, fillPolicy, ambiguityPolicy, asOf, params })`。模拟器按时间排序/去重完整 frame，先处理旧 pending，再调用 `strategy.evaluate`；它独占 fill、expiry、replacement、ledger 和 mark，不复制策略或成本公式。
- `replay-dataset.js`：把 `HistoricalStore.query(..., asOf)` 的 CMB quote 聚合为自然 5m/60m ask/bid OHLC；source timestamp 与 `ingestedAt` 必须同时不晚于 as-of，并在聚合前用同一 calendar adapter 排除休市记录。manifest 同时保存 durable partition hash 与 selected-subset hash、schema/calendar/source 版本、证据计数、时间完整/执行侧完整 bars/session、排除计数、历史跨度和 dataset fingerprint。
- `walk-forward.js`：按 UTC 月边界注册 6 个月训练 + 1 个月测试、逐月滚动的 fold；train/test 使用半开区间且不重叠，每个月至少 10 个时间/执行侧均完整的 session 才为 ready。测试月账户以零仓、无 pending、独立初始资金和新策略状态开始，训练期只提供冻结参数选择，指标 context 仍可读取测试时点以前的已收盘 bars。每折保存参数、候选空间、尝试数、样本数、区间和 result fingerprint，registry result fingerprint 绑定完整 fold 顺序/结果；control 参数不在本阶段寻优。
- `replay-report.js`：唯一 report v6 projector，生成 input/report SHA-256、暴露时间、资金使用率、turnover、profit factor、Sharpe/Sortino/Calmar、Wilson 95% 胜率区间和 seeded moving-block bootstrap 收益区间；四个基准通过同一 execution adapter 使用可执行 ask/bid、显式费与滑点。
- `replay-store.js`：`replay-reports/` 下的不可变报告文件与原子有界索引。summary 与 events/orders/fills/ledger/unexecuted 分离，可跨重启按 `reportId` 查询；`replay-stats.json` 只是最近报告兼容投影，v4/v5 原始文件不迁移、不重写。

默认 fill policy 仍是 `next-bar-limit`。`next-open`、`signal-close`、`delay-30s/60s/120s` 只作为显式敏感性场景；5 分钟 frame 没有明确 `delayedPrices` 证据时，秒级延迟返回 `second_level_execution_path_unavailable`，不会拿下一根开盘伪装成 30/60/120 秒成交，也不声称队列位置或部分成交。同 K 同触 target/stop 可选择 `unknown` 或 `conservative-stop`，entry fill 歧义与后续 outcome 分开，policy 必须进入 fingerprint 和 report。

dataset/report fingerprint 绑定 selected content，不绑定同一分区在 as-of 之后变化的 `storeContentSha256` 或 rejected-line 运维计数；后两者仍展示用于存储诊断，但不能改写过去报告的语义身份。

v6 `validationGate` 完全由 Host 投影，客户端不能提交 `validated`。至少需要 12 个月实际数据、两个已完成且参数冻结的 OOS folds、100% real bid/ask 验证路径、完整 session、已核实费用语义、四个可用基准，以及总体和每折不确定性区间；任一事实缺失都 fail-closed 为 `evidenceStatus:"exploratory"`。本机采集尚未证明这些条件，因此阶段 3 完成表示验证框架可运行，不表示 control 策略已通过长期验证。

### 7.9 阶段 4 策略实验层

阶段 4 在现有 `ReplaySimulator` seam 上增加隔离实验，不改变 live 组合路径：

- `strategy-contract.js` 定义 `goldboard-strategy-interface-v1`，统一同步 `evaluate({ marketFrame, portfolio, params, previousState })` 的 decision、valuation、nextState、active/suppressed signals 与 diagnostics；descriptor fingerprint 和显式 adapter fingerprint 进入 simulator input fingerprint，函数源码 hash 不再是唯一策略身份。
- `strategy-registry.js` 是策略目录的唯一 module。内建 `control` 与 `orb-trend-pullback`；factory 不出现在 wire。control 始终可用且是唯一 live 策略，候选只有出现在 `experiments.enabledStrategyIds` 时才能创建。
- `strategy-control.js` 只把现有 `computePlan` 适配到统一 interface，不复制 EMA/RSI/支撑/布林/ATR 规则；live snapshot、setup、decision 和 order 增加 `strategyId:"control"` 与 `signalSemantics:"state_condition"`。
- `strategy-orb.js` 提供 replay-only ORB/趋势回调候选。每个 session 从 `observing` 构建 opening range，突破 crossing 后进入 `armed`，回调收复后 `triggered`，超时进入 `expired`；同一 setup 不重复发买单，状态、regime 与压制原因都进入 evaluation 轨迹。
- `market-regime.js` 用版本化 EMA 距离/斜率和 ATR 比例给出 `trend/range/high_volatility/unknown`；预热不足和 partial-only 输入保持 unknown。`factor-contract.js` 保存 observation period、release、first available、revision/vintage、tradable-after 与 ingested-at，并在 as-of 选择时拒绝未来 revision；必需因子缺失或 stale 时只返回 hold/unknown。
- `experiment-config.js` 是无依赖的设置规范化 seam，避免 config/replay 的 ESM 初始化环。实验默认 `enabled:false`，control 自动保留；live `strategy` 平面不读取实验配置。
- `strategy-experiments.js` 展开 strategy × signal lane × cost × parameter × ablation 场景。每个场景调用同一 replay/execution module，但使用独立 portfolio、strategy state、orders 和 ledger；候选运行使用 `persist:false`，不会覆盖最近的 control report。
- `experiment-report.js` 投影独立 `goldboard-strategy-experiment-v1`，包含场景、control 差值、消融、敏感性、OOS、未运行 benchmark capability 和 promotion gate。只有矩阵完整、多个 OOS fold、成本压力与 control/benchmark 比较均通过时才可能是 `eligible_to_apply`；该状态仍固定 `liveStrategyChanged:false`，不是推荐或自动切换。

CMB 与 Au99.99 signal lane 可按当前数据能力独立运行并继续以 CMB accumulated-gold 执行口径结算。XAU 已进入策略 lane 契约，但 Host 在 XAU 与 USDCNY 不能共同提供 point-in-time 历史时返回 `xau_usdcny_point_in_time_unavailable`，不以当前汇率回填。ARIMA/SARIMA/GARCH、LSTM/Transformer/XGBoost 和 DRL 只作为 `unavailable` capability 登记；缺少训练 artifact 和统一 point-in-time features 时不生成分数或收益。

---

## 8. 宿主路由契约

统一响应信封：`{ ok: true, ... }` 或 `{ ok: false, error: { code, message?, details? } }`。
每个路径只注册一次，内部按 `req.method` 分发；Fetch adapter 统一缓冲上限 2 MiB（413），config/analysis 等 JSON 路由再施加 256 KiB 语义上限。
所有 handler 外层统一包一层安全网（v1.5.0）：异常逃逸内部错误映射时回
`500 { ok:false, error:{ code:"INTERNAL_ERROR", message: 脱敏摘要 } }`（不带堆栈），
保证任何失败路径都有 JSON 信封而非宿主的裸 400。

### 8.1 `GET /api/dsh-plugin-goldboard/config`

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
  "secretSet": { "webhooks.feishu.secret": false, "webhooks.dingtalk.secret": false },
  "revision": 0
}
```

### 8.2 `POST /api/dsh-plugin-goldboard/config`

请求：

```json
{
  "config": { "...": "..." },
  "expectedRevision": 0,
  "clearSecrets": ["webhooks.feishu.secret"]
}
```

规则：

- **深合并（v1.5.0 起，破坏·轻）**：payload 按顶层节白名单（fee / cmb / position / limits /
  manualPrevClose / strategy / tradingHours / analysis / system / webhooks）做字段级递归合并——
  只改 payload 携带的节与字段，未携带的节保持原值（如只传 `webhooks.feishu` 不再重置
  dingtalk/wecom/generic）；`position.lots`、`webhooks.generic`、`tradingHours.holidays`
  等数组整体替换；未知顶层键返回 `400 UNKNOWN_CONFIG_KEY`。此前「传部分顶层节会重置其余节」
  的行为被修正，依赖旧行为的外部脚本需注意。
- 空字符串 secret = 保留旧值；非空 = 替换；`clearSecrets` 列出的 = 清空（语义不变）。
- 校验：手续费默认 `buyPerGram=0, sellPerGram=5`（总额 5，允许用户改，但交易 Tab 给出成本影响提示）；招行价差允许负值；克数与金额非负、上限 ≤ 100000 克、成本价 > 0；
  策略参数新增 `strategy.weaknessRsi`（默认 75）与 `strategy.weaknessShadowAtrMult`（默认 1.0）。
- 响应返回脱敏后的完整配置和新的 `revision`。`expectedRevision` 不匹配时返回
  `409 { ok:false, error:{ code:"STALE_CONFIG" }, config, secretSet, revision }` 且不写盘；
  非整数 revision 返回 `400 BAD_REVISION`。
- `analysis.enabled=true` 时，保存前用 `ctx.llm.prepareCall()` 校验 provider/model/reasoning；不可用时返回稳定错误码，不静默替换模型。
- **持久化（0.2.1）**：POST 写入 `$DSH_HOME/storages/dsh-plugin-goldboard/config.json`，
  原子写、文件权限 `0600`；GET 返回 `runtime.config` 的只读脱敏投影 + `revision`。
  保存带 `expectedRevision`，不匹配返回 409 `STALE_CONFIG` 且不写盘。

### 8.3 `GET /api/dsh-plugin-goldboard/models`

返回当前 `ctx.llm` 的 provider/model/reasoning 目录；单个 provider 失败进入 `failures`，空目录不回退到硬编码模型。

### 8.4 `GET/POST /api/dsh-plugin-goldboard/analysis`

- `GET` 返回当前 running 查询、最近结果和日志健康状态。
- `POST` 读取宿主最新快照，执行缓存/running 去重和 provider-neutral 模型调用；质量门控未通过时仍可调用，但模型不得返回 `analysis_ready`。
- 每个真实调用返回 `queryId`；`force=true` 只绕过缓存，不绕过模型输出状态约束。

### 8.5 `GET /api/dsh-plugin-goldboard/analysis-logs`

支持 `limit`、`cursor`、`queryId`、`status`、`provider`、`model`、`from`、`to` 和 `detail=true`。默认列表只返回摘要，详情也不返回凭据、Authorization、Webhook secret 或原始 prompt。

### 8.6 `POST /api/dsh-plugin-goldboard/replay`

接收固定 `asOf`、quotes 和 bars，纯函数重建质量、指标、plan 与 snapshot；不请求行情源、不发提醒、不调用模型。

### 8.7 `POST /api/dsh-plugin-goldboard/manual-cmb-bars`

接收「数据」Tab 手动录入的今日招行积存金分钟价（文本或 `entries` 数组），仅补充缺失的 1 分钟 bar，并从 1 分钟数据重建缺失的 5/15/60/1440 分钟桶；不会覆盖已有 bar。「数据」Tab 通过 `GET /api/dsh-plugin-goldboard/manual-cmb-missing` 获取今日缺失分钟列表，便于直接填写价格。成功响应包含 `added`、`skipped` 和最新 `snapshot`。

### 8.8 `GET /api/dsh-plugin-goldboard/snapshot`

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
  "plan": { "action": "sell_take_profit", "dataCoverage": { "5": 1, "10": 1, "30": 1, "60": 0.98 }, "suggestedOrder": { "...": "..." } }
}
```

- snapshot 不落任何 secret。
- `plan.action = data_incomplete` 时 `suggestedOrder = null`，`dataCoverage` 给出 5/10/30/60 分钟各窗口的每分钟数据覆盖率（信号标的口径）。
- **缓存与瘦身（v1.4.0）**：距上次构建 < `SNAPSHOT_REBUILD_MIN_MS = 2s` 的重复 GET 直接返回缓存对象
  （tick 每 30s 本就在重建）；`trend.*_1m` 每条上限 `TREND_POINTS = 1080` 根（单交易时段最长 1020 分钟 + 余量），
  且只保留 `{ t, o, h, l, c }`（逐 bar 的 source/instrument 等元数据在单道内恒同，属纯重复；
  完整元数据仍可经 `/bars` 获取）。典型负载（AU9999/XAU/CMB 三道满载）≈240KB。
- 客户端只消费此结构，具体指标增减在实现阶段冻结。

### 8.9 `GET /api/dsh-plugin-goldboard/bars?instrument=AU9999&interval=1&limit=120`

- 参数白名单校验；`interval` 为**数字分钟数**（1 / 5 / 15 / 60 / 1440），返回该标的最近 bars，供数据页/图表补充历史。

### 8.10 `POST /api/dsh-plugin-goldboard/system-settings`

- 固定命令打开系统通知设置（macOS / Windows / Linux）；不接受调用方提供的 URL 或参数。
- 不支持平台返回 `501 SYSTEM_UNSUPPORTED`；其余失败返回 `SYSTEM_SETTINGS_FAILED`。

### 8.11 `POST /api/dsh-plugin-goldboard/test-notify`

- 对指定渠道发送测试消息（系统 / 飞书 / 钉钉 / 企业微信 / 通用）。通用 Webhook 统一经过 Host outbound 校验：无凭据 HTTPS、公网 DNS/IP、header allowlist、禁止 redirect；loopback/RFC1918/link-local/metadata 目标返回 `WEBHOOK_URL_BLOCKED`。

### 8.12 `GET/POST /api/dsh-plugin-goldboard/replay-stats`（当前工作树，report v6）

`POST` 请求体：

```json
{
  "days": 10,
  "lane": "cmb",
  "mode": "diagnostic",
  "asOf": "2026-08-14T04:00:00.000Z",
  "fillPolicy": "next-bar-limit",
  "ambiguityPolicy": "conservative-stop",
  "force": false,
  "detail": false,
  "includePartial": false,
  "requireExecutableBid": false
}
```

- `mode:"diagnostic"` 将 `days` 夹取 [1,30]；`mode:"walk-forward"` 当前只接受有 point-in-time `HistoricalStore` 数据的 CMB lane，并按实际完整 session 建 folds。
- `asOf` 必须是有效时间；dataset、frame、订单和报告 fingerprint 都绑定该值。`fillPolicy` 接受默认限价和明确的敏感性时点，`ambiguityPolicy` 为 `conservative-stop|unknown`。
- `includePartial:true` 只允许 partial session 做 mark-to-as-of；session-end/OOS 指标仍排除。`requireExecutableBid:true` 在缺真实 bid path 时将 touch 结果设 unknown。
- `detail=true` 返回最近 200 条独立 events、`orders/fills/pendingOrders/trades/ledger` 和最近 200 条 `unexecutedSignals`。GET 可带 `reportId`；不带时读取当前内存、不可变 registry 或旧 `replay-stats.json`。
- report v6 additive 保留 v5 摘要字段，并增加 `reportSchema`、显式 `asOf`、三类 fingerprint、`dataset`、`simulation`、`metrics`、`oos`、`benchmarks`、`groups` 和 Host 派生 `validationGate`。
- 单飞行、1 小时配置/数据感知缓存、断连取消和逐日部分失败信封保持不变。相同语义输入产生相同 report fingerprint 和 content-addressed `reportId`；`generatedAt` 不进入 fingerprint。

### 8.13 `GET /api/dsh-plugin-goldboard/replay-reports?limit=20`

返回最多 50 条不可变 v6 报告摘要，包括 `reportId`、生成/as-of 时间、schema、input/report fingerprint、lane 和验证状态。列表不返回大体积明细；明细通过 8.11 的 `reportId + detail=true` 查询。损坏 index 或单份详情只被忽略并记录警告，不影响 Host 与旧最近报告读取。

客户端对 v5 保留原只读连续账户展示；v6 额外显示 dataset、fingerprint、风险调整指标、OOS folds、置信区间与四类基准。只有 `version===6 && evidenceStatus===validated && validationGate.eligible===true` 才显示“验证结果”，其余状态保持探索性或 legacy。

### 8.14 `GET /api/dsh-plugin-goldboard/strategies`

返回 `goldboard-strategy-registry-v1` 的只读目录投影和规范化实验配置。descriptor 包含 strategy/version/interface、role、lanes、execution instrument、signal semantics、required features/factors、ablations 与 fingerprint；`enabled/live/canDisable` 由 Host 投影。响应不包含 factory、函数、闭包 context 或敏感配置。

### 8.15 `GET/POST /api/dsh-plugin-goldboard/strategy-experiments`

- GET 读取当前进程或 `strategy-experiment.json` 中最近一次 `goldboard-strategy-experiment-v1`；损坏/缺失文件返回 `{ok:true,report:null}`，不影响 live。
- POST 仅在 `experiments.enabled:true` 后接受 `days`、`mode`、已启用 `strategyIds` 和 `signalLanes`。未知/disabled strategy、disabled lane、未来 as-of 或超过矩阵上限均返回稳定错误 envelope。
- runner 为每个场景调用 replay 的同源数据、execution 和 OOS module，但传入 `persist:false/useCache:false`；场景相互隔离且不会覆盖 `/replay-stats` 最近 control 报告。
- 报告保存场景状态、metrics、regime/setup/suppression 分组、control 比较、消融、参数/成本敏感性、OOS 与 promotion 原因。XAU/USDCNY 点时证据缺失和单场景失败为 unavailable/failed，不补成零收益。

---

## 9. 浏览器半设计

### 9.1 注册与页面入口

- `sidebar.panellist`：`id: "goldboard"`、`order: 20`、`locale: NS`、`label: () => t("panel")`，组件为金币图标 + 右侧实时金价；侧边栏收起时只保留图标。
- `main`：`key: "goldboard"`、`locale: NS`，组件为 `GoldBoardPage`；侧边栏点击由 shell 调用 `ctx.layout.selectPanel("goldboard")`。
- 不再注册 `shell.overlay`（浮窗）与 `settings.section`（设置页）。
- 页面入口包 `PageErrorBoundary`；渲染失败显示错误、折叠栈和重试按钮，避免 shell 的空 `data-slot-error` 死格。

### 9.2 页面信息架构

6 个 Tab：概览 / 交易 / 策略与回放 / 分析 / 数据 / 设置；最后访问的 Tab 存 `sessionStorage`。页头与 Tab 栏固定，只有 Tab 内容区滚动。

- **概览**：3 张行情卡（Au99.99、XAU、CMB；点击切换图表品种）、今日走势（SVG，约 960×200）、当前建议（风险闸门、建议委托+复制、回本/目标/止损、理由、指标表）、持仓/风险、数据质量条。
- **策略与回放**：replay-stats（10/20/30 天、诊断/走查、v4/v5/v6 报告、详情弹窗）、策略实验面板（既有组件，页面级草稿）、信号账本摘要+详情弹窗。
- **分析**：模型配置、立即分析、结果、查询日志弹窗。
- **数据**：数据源健康与 API 日志、历史记录、手动 CMB 缺失分钟补录。
- **交易**：持仓/上限、风险预算、费用、招行价差、手动昨收（仅当日有效，北京时间 0 点自动清空）、策略参数、交易时段；顶部独立保存条。
- **设置**：侧边栏金价选择、系统通知与 Webhook；顶部独立保存条。

每个可配置 Tab 共用同一份配置状态但使用独立 `draft` 视图：保存时只提交本 Tab 的配置节（`position/limits/risk/fee/cmb/manualPrevClose/strategy/tradingHours`、`experiments`、`analysis`、`system/webhooks`），未保存的其他 Tab 修改不会被一起提交。`POST /api/dsh-plugin-goldboard/config` 携带 `expectedRevision`；保存成功后只把本 Tab 的节合并回草稿。409 保留草稿并提示，重新保存使用服务端最新 revision。离开页面丢弃未保存草稿（页内提示）。

### 9.3 数据流与交互

- `useSnapshot` 轮询 snapshot：10s；页面隐藏 60s；失败 10s→20s→40s→60s 退避；`visibilitychange`/`online` 立即刷新。
- 配置 GET 返回 `config + secretSet + revision`；保存成功后重置草稿；secret 只写不回显，清理由 `clearSecrets` 显式下发。
- 错误保留最后一次可用数据；401 提示刷新页面；页面错误边界兜底渲染异常。
- Tab 使用 `role=tablist/tab/tabpanel` + 方向键/Home/End；图表有文本摘要；按钮有 `aria-label`。
- 详情弹窗 portal 到 body，带 Escape、焦点陷阱和焦点恢复；切换 Tab 时关闭弹窗。
- **今日走势的交易日锚点（v1.3.1）**：跨零点交易时段按 `tradingDayKey` 归属前一交易日，图表渲染「昨晚+今晨」；x 轴沿用压缩轴；涨跌幅基准仍按昨收/手动昨收。
- 刷新按钮只刷新行情 snapshot；各 Tab 自己保留数据刷新入口。

### 9.4 视觉尺度与双端适配

- 页面标题 20/28 500；正文 14/22；提示 12/18；卡片标题 14/22 500；输入 32px；主/次按钮 36px；卡片 padding 16、gap 12、radius `--dsw-radius-lg`；根节点显式 14/22。
- 颜色只用 `--dsw-alias-*` / `--dsw-radius-*` / `--dsw-focus-ring-*`；涨红跌绿沿用 `state-error-primary` / `state-success-primary`。
- 断点：1000px 以下行情 2 列、dashboard 单列；680px 以下行情单列、Tab 横向滚动、设置导航横排、图表 160px。
- macOS `[data-platform="darwin"]` 页头增加 `--dsh-frame-top-clearance`；Windows 依赖 layout 的 titlebar；Desktop 仅显示平台提示和“打开系统通知设置”按钮。
- `prefers-reduced-motion` 关闭非必要动画。

### 9.5 文案与免责

- 页面底部常驻 `技术面参考，非投资建议` 与公开数据源提示。
- 每个建议委托卡片包含风险提示与扣费后回本价。
- 文案不出现“保证盈利”“必涨”“精准买卖点”等表述。
- `DICT.zh` / `DICT.en` 必须 1:1 键集合，测试断言；en 不含中文。

## 10. 持久化与状态

| 文件 | 内容 |
| --- | --- |
| `config.json` | **0.2.1 起的配置主存储**：`$DSH_HOME/storages/dsh-plugin-goldboard/config.json`；原子写（tmp + rename，权限 `0600`），并发写串行化；GET/POST 带 `revision` / `expectedRevision` 冲突保护；secret 字段只写不回显。旧版 `config.json.migrated` 在无 `config.json` 时一次性导入为新的 `config.json`（保留备份）；已有 `config.json` 永远优先 |
| `state.json` | state schema v3 热缓存：行情、滚动 bars、指标/提醒/信号道状态、CMB 校准样本、溢价史，以及有界 `signalLedger`（setup/decision/order/adjustment、持仓对账锚点） |
| `state.json.v1*.backup` / `state.json.v2*.backup` / `state.json.migration-v3.json` | 首次/重复迁移的原字节备份与 source/backup/target SHA-256、版本、时间和回滚路径；v2 `lastSuggestedOrder` 只投影为 legacy pending，不补 fill/add/PnL；无效 JSON 或非对象根隔离为 `.corrupt-*.bak` |
| `history/*.jsonl` | `HistoricalStore` 按 CMB 交易日 append-only 保存 customer ask/bid、逐侧来源、三类时间、延迟和证据身份；中部损坏分区隔离，尾部撕裂截断恢复 |
| `replay-reports/replay-report-index-v1.json` / `replay-report-v6-*.json` | report v6 不可变详情与原子有界索引；保存 events/orders/fills/pending/trades/ledger/unexecuted，损坏项不影响其他报告或旧兼容文件 |
| `replay-stats.json` | 最近报告兼容投影；v4/v5 读取不迁移、不补字段、不重写原字节 |
| `strategy-experiment.json` | 最近一次隔离策略实验 report v1；原子写、损坏时回退为空，不改变 control report、state 或 live config |
| `alerts-log.json` | 最近 200 条已发提醒（时间、action、价格）；`sentTo` 自 v1.5.0 记录真实渠道结果数组 `[{ channel, ok, error? }]`，替代此前恒为 `[null]` 的占位 |
| `api-log.jsonl` | 最近 API 调用记录（JSONL，超 2MB 轮转为 `.1`，仅保留一代） |

- **0.2.1 边界**：`pollMs`、`directory` 等激活期参数走 cordis.patch.yml / entry config，
  不写入 `config.json`；bars/state/api-log/analysis-log 等非配置数据继续留在
  `storages/dsh-plugin-goldboard/`。配置文件与状态目录均为 owner-only 权限。
- 迁移语义：`.migrated` 导入的是 normalize 后的完整配置（含当时默认值）；此后代码
  默认值变更不影响已导入的 `config.json`。

- `state.json` 损坏或根类型无效时先隔离原件、log warning 再回退；历史 JSONL 仅容忍可恢复的撕裂尾部，中部损坏隔离整个分区，其他交易日继续可读。GET 不抛错。
- Webhook secret 永不进入 snapshot、bars、日志。
- 宿主退出后缓存保留；重启先读 `state.json` 再补增量。
- **分区写盘节奏（v1.4.0）**：state.json 仍是单文件，但按分区脏标记差异化落盘——
  `bars`（体积主体）脏标记后最短间隔 `STATE_BARS_FLUSH_MS = 5min` 才写一次，
  且锚定整分钟边界（最新 1m 桶滚动后）；其余 KB 级字段（quotes / alertState /
  signalState / lastSuggestedOrder / signalLedger / lastAlertLog）脏即写。dispose 时执行可等待的
  最终 flush（cordis 支持异步 disposer）。崩溃窗口最多丢约 5 分钟合成 1m bar，
  重启后由报价轮询自建 + K 线补齐。
- **localeHint 不再持久化（v1.4.0·轻微行为变化）**：通知文案语言提示仅存内存，
  重启后回到 zh 默认；此前每次语言翻转都触发一次全量 state.json 写盘。
- **信号道与统计状态持久化（v1.5.0）**：`laneState`（当前道 / 待切道 / 连续计数）随
  state.json 保留，重启不丢粘滞计数；`cmbSpreadSamples`、`premiumHistory`、
  `premiumDaySamples` 同样落盘，动态价差与 spread_alert 统计跨重启连续。

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
- 消息模板占位符：`{{action}} {{instrument}} {{price}} {{cmbPrice}} {{suggestedPrice}} {{target}} {{grams}} {{time}}`
  （未提供的占位符渲染为空串）。
- 模板默认中文（用户可改）；客户端会把当前 UI locale 作为 `X-DSH-Locale` 附加到 snapshot 请求，宿主记录为通知文案语言提示（仅内存，重启回 zh 默认），不另设语言偏好设置项。

---

## 12. 关键风险与缓解

| 风险 | 影响 | 缓解 |
| --- | --- | --- |
| 免费源限流/失效（实测东财连续请求已出现 Empty reply） | 行情中断 | 多源容错、30s 低频、链路预算（12s/链）、熔断、stale 标记 |
| 免费源字段/缩放变化 | 价格错误 | 解析器带字段版本 + 单位测试样本；异常值校验（与前值偏差 > 3% 丢弃） |
| 免费源无官方授权 | 合规风险 | 仅个人看板使用；不对外分发；后续可替换为付费源 |
| 手续费 5 元/克双边合计（买 0 卖 5）下，短线波动不足以覆盖成本 | 用户亏损 | 只输出“建议”，始终显示回本价；波动不足时不发开仓信号 |
| 技术指标规则失效 | 用户亏损 | 规则透明、可关、可调；界面免责；v2 才谈回测 |
| 招行价差估算偏离实际 | 建议委托价失真 | 默认 +1.72 元/克可调；看板常驻“招行价以 App 为准”；偏离提示阈值可设 |
| 节假日/时段配错 | 休市时发错误信号 | 交易时段状态机（工作日 09:00–次日 02:00 + 节假日表）；休市抑制开平仓提醒 |
| 手动持仓与真实账户漂移 | 建议失真 | 交易 Tab 显示“最后同步时间”；用户手动更新；v2 预留账户同步 |
| 宿主不运行时无提醒 | 漏提醒 | 设置 Tab 明示“提醒依赖 DSH 宿主运行”；浏览器半只负责看板 |
| 页面信息密度高 | 阅读负担 | 6 Tab 分区、顶部保存条、响应式单列、详情弹窗按需打开 |

---

## 12.1 v2 遗留方向（plan-06 收尾记录）

批量回放统计（§7.6 / §8.11）打通了「手调默认值 → 数据依据」的最短路径；以下方向留待 v2：

- **参数网格寻优**：以 replay-stats 引擎为底，对 `strategy.*`（RSI 阈值 / ATR 系数 / scoreThreshold /
  confirmBars）做受控网格扫描与稳健性检验（避免过拟合：留出验证日、交易成本敏感性）。
- **更多标的**：把统计宇宙从 Au99.99 道扩展到 XAU 折算道（需历史汇率序列）与 Ag99.99 等品种；
  招行道若获得历史数据源则优先补齐。
- **账户同步**：以真实成交回填（替代「当日开盘价建仓」的持仓模拟通道），统计实际滑点与手续费
  假设的偏差，反哺 §7.3 默认值。

---

## 13. 验证计划

- 离线：
  - `node --check lib/index.js lib/client.js lib/connection-routes.js lib/routes.js`
  - `node --test`：配置归一化/迁移/权限、路由 adapter、回放/策略域测试、客户端注册/渲染/字典。
  - 断言 `Object.keys(DICT.zh).sort()` 与 `DICT.en` 一致。
- 宿主：
  - 用 `connection.fetch.register` 收集路由，断言 key 为 `/api/dsh-plugin-goldboard/...`。
  - 认证 GUI 内验证 snapshot/config/ledger/analysis/strategy-experiments；未认证 `/api` 只作 401 探针，不证明路由存在。
  - 旧 `/dsh-plugin-goldboard/...` 匿名路径应 404。
- 浏览器：
  - 临时静态 HTML 夹具 + Chrome headless 截图，检查明/暗主题、1440/1000/680 三档密度和断点。
  - 已验证：概览三卡/图表/建议/持仓布局、交易 Tab 字段/顶部保存条、明暗主题与窄屏断点。
  - 实机：侧边栏入口、5 Tab、保存后重启保留、语言切换、弹窗、窄屏。
- 行情：
  - 真实接口烟雾测试，确认报价新鲜度、来源切换、休市状态正确。
## 14. 评审问题确认结果（已逐项 ask-question 确认）

1. 配置默认成本：**买入 0 + 卖出 5**；v1.11.0 起定义为报价外显式费用，需按产品协议核对，真实 bid/ask 点差另列。
2. 交易标的：实际交易**招行积存金**；插件信号用 Au99.99（缺失时用国际金价折算），招行价兜底按国际金价按汇率折算 + 固定价差估算（默认 +1.72 元/克，买卖可分别调）。
3. 交易时段：**工作日 09:00–次日 02:00**，周末和法定节假日休市。
4. 提醒：**无冷却、无勿扰**，交易时段内每次阈值穿越都立即提醒。
5. UI 形态：**侧边栏「黄金看板」入口 + 独立主面板页面**（0.2.1 重构；旧浮窗与 Settings 页面已移除）。
6. 国际金价展示：**美元/盎司 + 折算元/克 + 内外价差**都显示。
