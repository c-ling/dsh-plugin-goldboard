# 计划 04：平台迁移 A —— config CRUD → ctx.settings / settingsScope

> 对应调研批次：④ 第一项。规模：M（1–2 会话）。依赖：计划 03（避免 /config 路由冲突区）。
> 项目约定不变：保留 `settings.section` 独立菜单，**不改** `settings.plugin.item`。

## 背景与目标

goldboard 目前自建了整套配置设施：`GET/POST /config` 路由、redactConfig 脱敏、secretSet 语义、
config.json 读写队列、浅合并保存。DeepSeek Harness rc7+ 提供 `ctx.settings` /
`installSettingsSection`（host）/ `settingsScope`（client），带 schema 校验、revision fencing、
secret 自动脱敏、settings.yaml 统一持久化。迁移后整层自建代码及其 bug 面（如 03.5 修的浅合并）
由框架接管。

依据：`dsh-plugin-upgrade` skill §3/§4.1（截至 0.1.1 稳定面确认）。

---

## 决策门（执行第一步，未决不得继续）

1. **确认目标 Harness 版本**：查 web profile 实际安装的 `@deepseek-ai/dsh` 版本
   （`ls ~/.dsh/profiles/web/node_modules/@deepseek-ai/` 或 profile package.json）。
   依赖版本必须同线：0.1.1 → `"@deepseek-ai/dsh-settings": "^0.1.1-rc.1"` +
   `"@deepseek-ai/schemastery": "^3.18.1"`。
2. **阅读 dsh-settings 包导出面**（node_modules 内 README/.d.ts），确认：
   a) `installSettingsSection` 的完整签名与 onChange/setSource 语义；
   b) 无 settings provider 时的 fallback 行为细节；
   c) host `inject` 是否应声明 `"settings"`（skill 示例声明了硬依赖，但又要求无 provider 可工作
   ——以包文档为准裁决；倾向软解析 `ctx.get("settings")` + 分支，避免老宿主激活失败）。
3. **本地 link 开发的依赖可解析**：插件目录 `corepack pnpm install` 或 workspace 安装。

## 变更清单

### 04.1 宿主：schema 与注册

**锚点**：`normalizeConfig` / `DEFAULT_CONFIG`（index.js 前部）、config 读写与 redactConfig/
secretSet 相关代码、`GET/POST /config` 路由（4021-4030 区起）。

- `package.json` 增 dependencies（见决策门 1）；
- `NS = settingsNamespace("dsh-plugin-goldboard")`；
- SCHEMA（schemastery z.object）覆盖全部配置节，secret 字段用 `z.string().role('secret')`：
  - fee{buyPerGram,sellPerGram}、cmb{buySpreadPerGram,sellSpreadPerGram}
  - position{grams,avgCostPerGram,lots[]}、limits{maxGrams,…}
  - tradingHours{weekdaysOnly,open,close,holidays[]}、system{enabled}
  - webhooks{feishu{enabled,url,secret},dingtalk{…},wecom{enabled,url},generic[]}
  - analysis{enabled,provider,model,reasoningEffort,temperature,maxTokens,timeoutMs,
    cooldownMinutes,riskDisclosure,…}
- `installSettingsSection(ctx, NS, SCHEMA, normalizedEntryConfig, { setSource, onChange })`
  放入 labeled `ctx.effect`（每进程恰好一次，重复注册 fail loud）；
  `onChange` 里触发既有副作用（分析模块模型校验等，原 POST /config 里的逻辑迁来）；
- `analysis.enabled=true` 的 provider/model 校验逻辑保留（迁到 onChange/save 路径）。

### 04.2 宿主：存量数据一次性迁移

- apply 时检测 `storages/dsh-plugin-goldboard/config.json`：
  存在 → 读出 → 经 normalize 后写入 settings namespace → 将文件改名为
  `config.json.migrated`（保留不删，便于回滚）；
- 无 settings provider（fallback 模式）时：保留现有 config.json 路径照常工作
  （installSettingsSection 的 entry-config fallback 天然支持；此时 POST /config 是否保留视
  决策门 2-c 结论——fallback 下客户端 settingsScope 不可写，需保留旧写入口）。

### 04.3 宿主：路由收缩

- provider 就绪环境：删除 `POST /config`；`GET /config` 降级为只读投影或直接删除
  （客户端改从 settingsScope 读）；
- fallback 环境：两条路由原样保留（分支实现，勿用运行时探测每次判断——apply 时确定模式）。

### 04.4 客户端：settingsScope 接入

**锚点**：`lib/client.js` — inject 数组（factory 内 apply 前）、draft/Save 流程
（SettingsSection ≈2646-3328）、NumberField/Switch 写入路径、secretSet 处理、URL 常量块（30-37）。

- client `inject` 增加 `"connection"`, `"remote"`, `"settingsScope"`（保留 slots/locale）；
- `var scope = ctx.get("settingsScope").bind({ namespace: "dsh-plugin-goldboard" })`；
- `useConfig()`：`useSyncExternalStore(scope.subscribe, scope.getSnapshot, scope.getSnapshot)`；
  按 `status`（loading/ready/unavailable）渲染加载/正常/降级三态（unavailable 即 fallback 模式，
  回落旧 draft+POST 流程）；
- ready 模式下：字段编辑 → draft → 保存按钮执行批量 `scope.set(key, value)` /
  清除执行 `scope.unset(key)`（revision fencing 由框架处理）；移除对 POST /config 的调用与
  secretSet 特判，secret 字段显示「已配置」徽标 + 「清除」按钮（依据 scope.user 中是否存在该键），
  永不回显明文；
- 文案更新：settingsIntro 改为「修改立即生效」（双语），涉及 key 见 DICT；
- NumberField 的草稿字符串化改造若计划 02 未覆盖则顺带处理（不在本计划强制范围）。

### 04.5 明确不迁移的部分

- `pollMs` 等激活期 entry config 保持走 cordis.patch.yml / entry config，不入 namespace（DESIGN 注明）；
- bars/state/api-log/analysis-log 等非配置数据仍在 storages/（符合「二进制与大状态不进 settings」约定）；
- `settings.section` 槽位、order、UI 结构不动。

---

## 测试要求

- 改造既有 config 路由测试：a) 有 fake `ctx.settings`（实现 register/get/set 最小面）时走
  installSettingsSection 且 onChange 触发；b) 无 settings 服务时 fallback 到 entry config 且
  旧路由可用；c) 迁移用例：temp storages 放 legacy config.json → apply 后 namespace 收到值、
  文件改名 .migrated；
- secret 断言：wire 描述/读取中 secret 键恒为 `[redacted]`/布尔（依包语义）；
- client dict 新键 parity（沿用计划 01 的词典测试）。

## 验证清单（对照 dsh-plugin-upgrade skill §6）

- [ ] `node --check` + `node --test` + `python3 -m json.tool package.json` 全绿
- [ ] Settings → 黄金看板 独立菜单仍在（未被 item 卡片替换）
- [ ] 修改配置后写入 `$DSH_HOME/settings.yaml`（检查文件出现 goldboard namespace）；
      刷新页面配置保留
- [ ] webhook secret 不回传明文，页面只显示是否已配置
- [ ] 旧 config.json 用户升级后配置无损（migration 用例 + 一台真机升级验证）
- [ ] 中英切换设置页实时生效；暗色主题无回归
- [ ] fallback 环境（临时禁用 settings provider 的 profile）功能完整

## 完成定义

- [ ] 全部勾选；版本 `v1.5.0` 发布；Release notes 双语说明配置存储位置变化与自动迁移行为
