# 黄金历史数据接口调研

> 结论：国内和国际金价都有可用的历史数据接口，部分可免费/低门槛获取。
> 本文件用于指导 `dsh-plugin-goldboard` 的数据源补充与历史数据兜底。

## 国内金价历史数据

| 方案 | 说明 | 历史能力 |
| --- | --- | --- |
| 上海黄金交易所 SGE 官方 JSON | `POST https://www.sge.com.cn/graph/Dailyhq`，参数 `instid=Au99.99`，返回 `[日期, 开, 收, 低, 高]` | ✅ 本机实测可用，直接返回日线历史 |
| AKShare | `ak.spot_hist_sge(symbol="Au99.99")` 等 | ✅ 封装 SGE 历史数据，Python 量化方便 |
| Tushare Pro | `sge_basic` 等，需要 Token/积分 | ⚠️ 主要是合约基础信息，历史行情可能需单独权限 |
| GitHub 爬虫项目 | `jeckun/SGEGoldenPrice`、`az13js/gold` | ✅ 可参考/自建 SGE 历史数据采集 |

## 国际金价历史数据

| 方案 | 历史接口 | 费用/限制 |
| --- | --- | --- |
| gold-api.com | 实时免费；历史用 `GET /history`、`GET /ohlc/XAU`，需 `x-api-key` | 免费档历史约 10 次/小时 |
| Metals-API | `GET /api/2013-12-24?access_key=...&symbols=XAU`、`/api/timeseries?start_date=...&end_date=...`、`/api/historical-lbma/...` | 需 `access_key`，免费档有限 |
| Yahoo Finance | `GET https://query1.finance.yahoo.com/v8/finance/chart/GC=F?interval=1d&range=1d` | 免费，非官方，国内可能不稳定 |
| freegoldapi.com | `https://freegoldapi.com/data/latest.json` / `.csv` | 免费，超长期历史，但主要是年度数据 |
| QOS 行情 API | `POST /history`，黄金代码 `CM:XAUUSD` | 免费试用 key，可拿历史 K 线 |
| Stooq | 历史 CSV 接口 | 免费，但本机测试时遇到 JS 验证页，可能有反爬 |

## 主要 GitHub 参考来源

- `akfamily/akshare` — 国内金融数据，含 SGE 黄金历史
- `vikiboss/60s` — 聚合国内+国际金价，适合实时展示
- `qos-max/qos-quote-api-stock-api` — 含黄金历史 K 线
- `api-evangelist/metals-api` — Metals-API 第三方资料
- `vraestoren/gold_api.cr` — gold-api.com 客户端示例
- `IOrlandoni/gold-price-today-api` — GoldPrice.Today 免费 JSON
- `jeckun/SGEGoldenPrice` — SGE 每日金价爬虫
- `az13js/gold` — SGE 历史数据爬虫

## 建议

- 国内历史优先用 SGE 官方接口或 AKShare，最直接且免费。
- 国际历史轻量场景：Yahoo Finance 日线 + gold-api.com 免费 key 历史接口。
- 需要长期/稳定/多品种：Metals-API、GoldAPI.io、QOS 这类商业或半商业 API。
- 注意国内常用 元/克，国际常用 美元/盎司，1 金衡盎司 ≈ 31.1035 克。
- 非官方接口（新浪、腾讯、金投网等）适合做备用源，不建议作为生产唯一依赖。
