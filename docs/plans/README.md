# dsh-plugin-goldboard 优化执行计划（索引）

> 来源：`docs/research/plugin-optimization-review.md`（2026-02 深度调研）。
> 本目录把调研结论拆成 6 份可独立执行的计划文档，按编号顺序逐份执行。
> 行号均基于 **v1.2.0 + 当前工作区未提交改动** 的基线；执行时若行号漂移，请按文档中的
> **符号名锚点**（函数名/常量名）定位。

## 文档列表与建议顺序

| 序号 | 文档 | 主题 | 规模 | 依赖 |
| --- | --- | --- | --- | --- |
| 01 | [plan-01-p0-correctness-hotfixes.md](plan-01-p0-correctness-hotfixes.md) | P0 正确性热修复（seedBars / 跨零点图 / EN 中文键 / confirmBars） | M | 无 |
| 02 | [plan-02-performance-and-resource.md](plan-02-performance-and-resource.md) | 性能与资源（Intl / state 写盘 / snapshot 缓存 / 归一化提升 / api-log 轮转 / 链路预算 / 轮询健壮性 / 分析缓存上限） | L | 01 |
| 03 | [plan-03-strategy-credibility.md](plan-03-strategy-credibility.md) | 策略可信度（信号道粘滞 / 出场信号补全 / 动态价差 / GET 错误信封 / 配置深合并 / sentTo） | L | 01 |
| 04 | [plan-04-settings-migration.md](plan-04-settings-migration.md) | 平台迁移 A：config CRUD → ctx.settings/settingsScope | M | 03（避免路由冲突） |
| 05 | [plan-05-host-modularization-and-tests.md](plan-05-host-modularization-and-tests.md) | 宿主半模块化拆分 + 集成测试；客户端半文件内重构 | XL | 01–04 全部合入后 |
| 06 | [plan-06-replay-statistics.md](plan-06-replay-statistics.md) | 批量回放统计（规则命中率报表，只读功能） | M | 05（复用拆分后的模块与测试设施） |

## 全局约定

### 执行前置（每份计划开始前）

1. **工作区必须干净**：当前未提交的 manual-cmb-bars / 挂单跟踪 / 分析门控放宽改动
   （+773 行）必须先提交并发布（见下条），再开始 plan-01。
2. 基线命令全绿：
   ```sh
   cd dsh-plugin-goldboard
   node --check lib/index.js lib/client.js lib/analysis.js lib/analysis-log.js lib/market-quality.js
   node --test          # 75+ 通过
   python3 -m json.tool package.json
   ```
3. 阅读该计划的「背景」节；执行中先读目标符号周边代码再动手（本目录行号仅供参考）。

### 版本与发布

- 每完成一份计划 = 一次版本发布（遵循 `dsh-plugin-publishing` skill 强制规则：
  **每次版本必须同时有 git tag 和 GitHub Release**）。
- 建议：plan-01 → `v1.2.1`（patch）；plan-02 → `v1.3.0`；plan-03 → `v1.4.0`；
  plan-04 → `v1.5.0`（含 config.json 一次性迁移）；plan-05 → `v1.6.0`；plan-06 → `v1.7.0`。
- **实际发布记录**（与上方建议有偏移，以 tag 为准）：plan-01 → `v1.3.1`；
  plan-02 → `v1.4.0`；plan-03 → `v1.5.0`；后续 plan-04 → `v1.6.0`、plan-05 → `v1.7.0`、
  plan-06 → `v1.8.0` 顺延（执行时以 `git tag` 实际最大版本 +1 为准）。
- 同一提交内同步：bump `package.json#version` + 两份 README 的 `#v<pin>` + DESIGN.md 受影响章节。
- 发布前必跑：`grep -rn "v<旧版本>" README*` 确认无残留旧 pin。

### 文档内通用标记

- 【破坏】用户可见行为变化；【性能】资源/延迟优化；【策略】信号/建议逻辑变化；
  【结构】纯代码组织变化。【策略】类改动必须附 fixture 测试并在 Release notes 中说明。

## 未排期的遗留项（执行完 01–06 后再评估）

- 客户端 P2 清单：clipboard 回退返回值、Switch aria-label 全量补齐、外点收起监听精简、
  DataSourceLogsDialog Escape/焦点陷阱（抽公共 Dialog）、加载更多 cursor 守卫、
  InfoTip 滚动跟随、data-sources 失败态区分。
- DESIGN §9 偏差决策：折叠态规格（280px 胶囊 vs 36px 圆球）、卡片尺寸、settings order。
- generic webhook SSRF posture 文档化 + scheme 白名单。
- 客户端多文件拆分：待验证 client-modules 是否支持包内子路径 bundle（见 plan-05 开放问题）。
