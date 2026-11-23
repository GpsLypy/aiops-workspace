# DTS 本机只读 MCP

继续扩展 DTS 接入前，先读 [跨会话交接与后续 MCP 接入流程](HANDOFF.md)。

Linux公司沙箱独立部署见[DTS MCP独立沙箱](../../docs/dts-sandbox.md)。服务仍只监听loopback，使用受限SSH转发跨实例调用；最小锁定依赖及进程管理位于 `deploy/dts-sandbox`。Linux模板缺少zip时可向管理员初始化函数传入经过正式ZIP检查的 `skillPackagePath`；本机默认打包方式保持原入口。

把现有 DTS `GET /proxy/v1/jobns/getstatus` 包装为 Streamable HTTP 工具 `dts_get_job_status`。本机只监听 `127.0.0.1:43129`，独立 Bearer Token 鉴权。支持原始 `/v1/jobns/getstatus` 路径。没有暂停、恢复、重启、配置修改或任意 HTTP 请求工具。

## 本机部署

需要 Node.js ≥22.16、已安装本仓库依赖、macOS 登录会话和可访问 DTS 的内网连接。在仓库根目录运行（把域名和任务列表替换为已授权目标）：

```sh
npm run dts:local -- install \
  --url 'https://dts.internal.example/proxy/v1/jobns/getstatus' \
  --jobs '12345678901234567'
npm run dts:local -- status
npm run dts:local -- provision --owner admin
```

若已确认上游只能使用 HTTP，安装时显式添加 `--allow-http`；本机此次 DTS 联调已使用这个开关，没有关闭 TLS 验证。固定 URL 不含 jobid、operator、Token 或其他查询参数。

首次安装生成根目录 `.env.dts-mcp`（权限 0600，Git 忽略）及随机 MCP Token，写入用户 `~/Library/LaunchAgents/com.aiops.dts-readonly-mcp.plist`。launchd 在登录时启动并在进程退出后恢复，命令结束不影响服务。Mac 睡眠、关机或退出用户会话期间不提供服务。日志在 `test-results/dts-local-service/`；日志只含查询目标、摘要状态、时间与稳定错误码，需要长期运行时由本机维护者定期归档。

`provision --owner` 是拥有工作空间目录写权限的本机管理员命令：复用该管理员的现有账号，事务创建四个私有资源，使用应用现有加密、知识索引、版本与审计函数；不创建登录会话、不改密码、不读取模型凭据、不改其他资源。Skill 源文件先打 ZIP 并通过正式包校验，已审阅的 Skill 与子领域直接发布。新建工具策略要求每轮绑定 `jobid`、`business_domain`、`area_name`。已有完整同名配置时不重复创建；旧策略缺少目标绑定时明确提示先核对并运行 `sync-policy`，不会由 `provision` 隐式覆盖。资源创建过程通过 CLI 完成，网页用于发现、调用及回看验收。

资源名称：`DTS cn_east 状态说明`、`DTS cn_east 只读查询`、`DTS cn_east MCP`、`DTS cn_east 运维`。工具策略限制 `production`、指定所有者管理员及 `general/cn_east`。首次部署采用单任务允许列表；用户确认拥有该区域全部任务查看权后，当前本机已切换为显式 `region` 模式，仍按每次请求的 jobid 查询一个任务。

```sh
npm run dts:local -- restart
npm run dts:local -- stop
# stop 后重新启动，复用已有本地配置：
npm run dts:local -- install
# 不使用 launchd 的前台启动方式（不要与守护进程同时占用端口）：
npm run dts:mcp
```

配置样例见 [.env.example](.env.example)。`DTS_JOB_SCOPE` 支持 `allowlist`（默认）和 `region`。allowlist 模式的 `DTS_ALLOWED_JOB_IDS` 必填，逗号分隔，最多 100 个正 int64 十进制 ID；region 模式必须清空列表。漏填任务列表不会自动开放整个区域，`*` 也不表示通配。`install` 不覆盖已有配置，也不轮换 Token。

## 允许区域内全部任务

拥有整个区域查看权限时，需要同时调整适配器和工作空间策略。编辑根目录 `.env.dts-mcp` 的以下配置，保留原 URL、Token 等其他项：

```dotenv
DTS_BUSINESS_DOMAIN=general
DTS_AREA_NAME=cn_east
DTS_JOB_SCOPE=region
DTS_ALLOWED_JOB_IDS=
```

随后运行：

```sh
npm run dts:local -- sync-policy --owner admin
npm run dts:local -- restart
npm run dts:local -- status
```

`sync-policy` 仅同步当前所有者的 `DTS cn_east MCP` 中 `dts_get_job_status` 的 jobid 约束和固定三项目标绑定字段；验证原连接地址、Token、业务域、区域及只读策略匹配，保留账号、环境、其他工具与限制。变更事务保存新修订和审计，重复执行不产生重复修订。它不修改区域；若区域或已有绑定字段与工具契约不匹配会拒绝覆盖。升级已有本机资源需要管理员明确执行此命令；仅更新源码不会修改工作空间策略。

本机工作空间已于 2026-10-08 在加密备份和隔离恢复演练后显式同步：DTS MCP 资源修订 2 → 3，三项目标字段已生效，重复运行返回 `already_synced`。这只描述当前本机；其他工作空间仍需分别核对资源和运行该命令。实际目标验收证据见[验证记录](../../docs/verification.md)。

在后台“工具授权策略 JSON”中，对应的 `constraints` 应为：

```json
{
  "business_domain": ["general"],
  "area_name": ["cn_east"]
}
```

即删除 `constraints.jobid`，保留其他策略字段，并要求 `"requiredTargetFields":["jobid","business_domain","area_name"]`；不能填 `"jobid":["*"]` 或空数组。工作空间 constraints 按值精确匹配，通配符不会放行。区域授权允许任意有效 jobid，但 Agent 对话还需由用户显式确认本轮目标，工具参数不一致时查询前拒绝。DTS 仍负责验证任务实际所属业务域和区域。jobid 仍为必填字符串，不提供任务枚举、跨区域查询或写操作。

首次部署就使用区域模式，可把安装命令的 `--jobs ...` 换成 `--job-scope region`。恢复指定任务列表时，改为 `DTS_JOB_SCOPE=allowlist` 并填入 `DTS_ALLOWED_JOB_IDS`，再执行同一组同步、重启命令。

## 在助手中使用

1. 刷新工作空间，打开 `DTS cn_east MCP` 详情，点击“连接并发现工具”，应只发现 `dts_get_job_status`，已有 Token 显示已加密保存。
2. 返回前台，新对话的 Agent 选择 `DTS cn_east 运维`，在“本轮查询目标”中选择该只读工具，填写任务 ID、业务域和区域并点击确认；保留知识检索开启。任务 ID 应以原始十进制字符串填写，不转换为数字。
3. 提问：`查询 DTS 任务 12345678901234567 的当前状态，业务域 general，区域 cn_east，报告上报时间和数据新鲜度。` 问题与已确认目标应一致。新一轮更换任务 ID 时重新确认目标；仅在问题正文或附件中写 ID 不构成目标绑定。
4. 核对回答下方工具成功摘要与知识来源，在“执行与审批”查看工具参数、生产环境及真实返回；刷新后从会话管理回看。

确定参数测试：执行中心选择 DTS MCP、`dts_get_job_status`、生产，提交：

```json
{"jobid":"12345678901234567","business_domain":"general","area_name":"cn_east"}
```

把 `area_name` 改为 `cn_north` 应在应用策略层被拒绝，适配器成功查询日志不增加；直接调用 MCP 也会被适配器拒绝。MCP 没有授权其他工具。

定时巡检的创建页面也需确认结构化查询目标。旧任务迁移后目标为空，可在任务列表的“查询目标”中补录；未补录时如模型尝试调用受保护 DTS 工具，执行失败且不会向 MCP 发出查询。任务指令和巡检条件中的 ID 不会自动转为绑定。存量真实任务需逐条核对对象、当前资源权限及运行结果，不能凭旧指令批量推断目标。

## 返回与错误语义

输入 jobid 必须为字符串；超过 JavaScript 安全整数的 ID 不能转 Number。适配器发送固定 GET，`subkey=status` 固定，保留业务域和区域校验。HTTP 成功后还需检查 `code=0`，再次解析 `data.status` 并核对返回 ID。

返回有限字段：`jobid`、`business_domain`、`area_name`、`state`、`health`、`paused`、`manual_stopped`、`finished`、`worker_delay_seconds`、脱敏后的 `message`、`reported_at`、`queried_at`、`freshness`、`age_seconds`、`max_age_seconds`、`source`、`fixture=false`。不会返回原始 inbound/outbound/config/statistics。

- `reported_at` 来自 DTS 的 Unix 秒上报时间；`queried_at` 是查询时间，均使用 ISO UTC，不伪造采样时间。
- 默认超过 60 秒标记 stale；超过未来 30 秒标记 future；缺失时间或状态字段显示 unknown/null。阈值属于适配器数据新鲜度标准，不是 DTS 告警 SLA。
- `running` 要求新鲜、关键字段完整、health=1 且未暂停/手动停止/完成。paused 不等同故障，finished 不等同数据一致性通过，worker 延迟 0 不能推断全链路无延迟。
- HTTP/业务失败、无效 JSON、响应过大、任务 ID 不一致、超时等返回 MCP `isError=true`，包含固定错误码和中文说明，不回传上游错误正文或令牌。
- HTTP 超时默认 8 秒，正文上限 128 KiB；禁止重定向，最多四个并发上游查询。不自动重试或执行修复。

当前 DTS 路由支持无登录 Token 查询，operator/工号只是元数据，不作为身份凭据。MCP Token 和可选的 `DTS_READ_TOKEN` 是不同凭据。工作空间仅通过本机 MCP 获取有限状态；MCP 自身负责到内网 DTS 的访问。助手后端将来以生产模式运行时，需要将本机 MCP origin 精确加入 `OUTBOUND_ALLOWED_ORIGINS`、`OUTBOUND_PRIVATE_ORIGINS` 和 `OUTBOUND_HTTP_ORIGINS`。

## 文件与验证

| 文件 | 职责 |
| --- | --- |
| [adapter.mjs](adapter.mjs) | 配置、固定 HTTP 查询、状态映射、MCP 鉴权及工具 |
| [index.mjs](index.mjs) | loopback 监听与退出收尾 |
| [provision.mjs](provision.mjs) | 显式管理员本机初始化及任务范围策略同步，复用加密、版本、索引和审计 |
| [knowledge.md](knowledge.md) | 稳定字段说明，不存实时状态 |
| [dts-status/SKILL.md](dts-status/SKILL.md) | 查询流程与结论边界 |
| [本机管理命令](../../scripts/dts-local.mjs) | 安装、状态、重启、停止、资源初始化及 sync-policy |
| [测试](../../tests/dts-mcp.test.mjs) | 模拟异常、真实 HTTP/MCP 协议、临时工作空间模型循环 |

```sh
node --test tests/dts-mcp.test.mjs
npm test
npm run build
npm run docs:build
npm run docs:check
```

上述自动测试不连接企业 DTS，使用临时数据库和本机 fixture。显式真实目标验收另用 `SOURCE_DIR=.data npm run test:target:real -- --real --job AUTHORIZED_ID`；`--model MODEL_NAME` 仅临时覆盖隔离工作空间里的模型名，源库配置不变；仅核对真实 DTS 直接 SDK 查询与本机受控拒绝场景时用 `--direct-only`。直查及替代模型证据完整时仍按设计退出 2，不代表保存模型或质量门禁通过。当前实测结果见[验证记录](../../docs/verification.md)。
