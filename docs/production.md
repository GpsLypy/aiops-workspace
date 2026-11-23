# 生产治理、受控执行与上线门禁

本章描述当前代码已经实现的生产治理能力。交付目标是单实例、可审计、受控的运维助手。真实模型、企业身份网关、生产 MCP、监控通知及部署基础设施需要环境验收；本地协议测试通过不等于已经上线。完整证据见 [验证记录](verification.md)。

## 从只读到变更

1. 先接入只读 MCP，核实其远程账号确实没有写权限；`risk=read` 是管理员配置的策略，不会自动证明远程实现只读。
2. 在执行与审批中心提交固定的工具操作，查看环境、参数、恢复说明和核验规则。
3. 写操作保存为 `awaiting_approval`。生产或高风险变更必须由另一位管理员批准。
4. 后端重新核对发起者、审批人、资源权限、资源 revision、工具 schema、变更窗口和审批有效期。任何变化都可能要求重新提交。
5. 写操作注入步骤 UUID 作为远程幂等参数。远程工具必须真正实现幂等；仅接收该字段不能保证去重。
6. 后端用指定只读工具验证实际目标状态；通过后才显示变更成功。
7. 调用已经发出后发生错误，步骤记为 `unknown`。先在执行中心“只读核验实际结果”，不会自动重放写操作。

审批后的步骤独立执行，不恢复原模型循环。原对话保留待审批说明，执行中心保存最新结果。取消和紧急停止只能阻止后续动作、取消本地等待，不能撤销远程已经发生的副作用。

审批执行期间若用户取消：写请求尚未发出时，执行和步骤保留 `cancelled`；写请求已经发出时，最终状态优先为 `unknown`，只能先做只读核验。挂起的审批请求返回 409 和对应说明，不将明确取消误报为服务器内部错误。超时、权限变化或真实工具失败不会仅因中止信号而冒充用户取消。

unknown的只读核验也会重新检查在途授权：发现目录后、读取结果后都重查核验请求者的管理员身份、执行所有者的只读权限和原资源修订/启用状态。等待期间撤权或配置变化时拒绝确认，保持unknown及原证据。读请求前发现变化不会查询；读取已发出则不能撤回，但返回不能在过期授权下写成success。资源变更返回409，身份/权限撤销返回403。

## 指令发布与知识治理

Skill 与子领域使用 `draft / published` 状态。ZIP Skill 上传始终为草稿，包括管理员上传；管理员首次创建子领域或通过 API 创建不带 ZIP 的文本 Skill 时视为发布，成员创建则为草稿。之后任何人的编辑都回到草稿。管理员通过 `POST /api/resources/:id/publish` 提交当前 revision 审核发布。回滚创建一个新版本，并保留当前读者、管理人和所有者，不恢复旧权限。MCP 不支持恢复旧凭据或旧授权版本。

升级前已有的 Skill / 子领域自动转为草稿，已有 MCP 允许列表仍保留，但没有显式工具策略的工具不再执行。升级前做备份，升级后逐一审核发布与配置工具策略。

知识新增 `service`、`environment`、`documentVersion`、`expiresAt`、`sourceUrl`。保存时建立 SQLite FTS5 中文二元词 / 英文词索引；查询先限制可见且未过期文档，从候选中按现有评分选择最多五片。引用携带资源 revision、文档版本、更新时间与来源 URL。过期资料不参与新检索。

管理员可从已保存来源 URL 同步纯文本或 Markdown，保留本地 ACL；出口规则同样适用。这里没有自动继承外部 Wiki 的 ACL、OAuth 抓取、PDF/OCR 或 embedding。连接企业知识源时应通过内部导出服务提供经授权文本，并维护本地用户授权。历史回答仍可能包含以前引用的文字，撤销资源权限不会追溯删除已交付内容。

## 工具策略示例

资源的 `allowedTools` 与 `toolPolicies` 同时生效。未分类的工具拒绝执行。环境来自服务配置或执行中心的固定计划；真实环境、集群、命名空间等需要在 arguments 中明确，并配置 constraints。不要让远程工具使用不受约束的默认目标。

```json
{
  "service_status": {
    "risk": "read",
    "roles": ["admin", "member"],
    "userIds": [],
    "environments": ["production"],
    "constraints": {"service": ["billing"], "namespace": ["payments"]},
    "requiredTargetFields": ["service", "namespace"],
    "maxItems": 1
  },
  "restart_service": {
    "risk": "write",
    "roles": ["admin"],
    "environments": ["production"],
    "constraints": {"service": ["billing"], "namespace": ["payments"], "replicas": [1]},
    "maxItems": 1,
    "idempotencyArgument": "idempotencyKey",
    "window": {"start": 1, "end": 3},
    "verification": {
      "tool": "service_status",
      "arguments": {"service": "billing", "namespace": "payments"},
      "path": "status",
      "equals": "healthy"
    },
    "recovery": "核对实例状态和错误率，由值班负责人按已审核回退流程处置。",
    "automatic": false
  }
}
```

以上是配置结构示例，工具及参数必须和实际 MCP schema 一致。constraints 对指定顶层参数做精确值允许列表检查；maxItems 限制嵌套数组元素总量，**不能代替副本数、SQL 类型、路径等业务参数约束**。只读工具可声明 `requiredTargetFields`，要求本轮聊天/任务由用户显式确认相同字段；启用后该工具调用只接受这些字段，额外字段也拒绝。管理员必须把所有决定查询对象的字段纳入列表，并对生产业务资源单独同步策略；未配置的工具继续沿用范围授权。服务端使用 AJV 校验完整 JSON Schema。window 是 UTC 小时、左闭右开，不支持跨午夜区间。核验优先读取 `structuredContent`，否则解析第一个文本结果为 JSON，再比较指定路径和值。

`roles` 与可选 `userIds` 共同限定执行者；资源可读不再自动意味着可执行全部工具。团队可以由企业目录管理成员，再维护明确的 userIds 与每个应用的 MCP 授权。当前没有独立租户数据库，也没有动态团队组同步。

## 身份与入口

开发默认使用本地账号。生产必须明确 `AUTH_MODE=local` 或 `gateway`。生产初始化需要预置管理员，或有效 `SETUP_TOKEN`；初始化完成后原入口无法再次创建首个管理员。

`AUTH_MODE=gateway` 禁用本地密码登录。企业网关在完成 SSO/MFA 后为每个请求添加：

- `X-AIOps-Identity`：JSON 的 base64url 编码，字段为 `username`、`mfa:true`、`aud`（精确 APP_ORIGIN）、`exp`（Unix 秒，最多未来 120 秒）。
- `X-AIOps-Signature`：用至少 32 字符的 `IDENTITY_GATEWAY_SECRET` 对编码后的字符串计算 HMAC-SHA256，输出十六进制。

账号必须事先由工作空间管理员建立且启用。网关只能声明用户名与 MFA，不决定工作空间管理员角色。应用直接校验签名，不信任普通 `X-User` 头。网关应清除客户端提交的身份头，只添加自己的签名；使用 TLS 与网络隔离，防止旁路访问。用户退出企业会话需在身份提供方处理，本地退出不能撤销上游 SSO 会话。

此能力是签名身份网关适配，当前未内置 OIDC/SAML 登录重定向、IdP 元数据发现或 SCIM。企业 IdP 真实连通、离职撤权、MFA、网关密钥轮换属于部署验收。

## 网络与数据出口

生产启动必须提供 HTTPS APP_ORIGIN、Secure Cookie、外置 MASTER_KEY_FILE、明确 AUTH_MODE 和 OUTBOUND_ALLOWED_ORIGINS。配置不完整时拒绝启动。可选 TRUST_PROXY 只设置已知代理 IP/网段，不能无条件信任任意转发头。

模型、MCP、知识同步和通知使用同一出口客户端：精确 origin 允许列表、拒绝重定向、DNS 校验后固定连接地址、2 MB 默认远程响应上限。内部地址还需 OUTBOUND_PRIVATE_ORIGINS，明文 HTTP 还需 OUTBOUND_HTTP_ORIGINS。云元数据 / 链路本地地址受阻。应同时在网络层设置出站规则。

模型 messages 中的常见 Key、Bearer、password/secret 赋值、私钥块会脱敏；`MODEL_DATA_POLICY=block` 会拒绝检测到凭据的请求。正则检测不是完整 DLP：用户业务数据、未识别凭据和自定义格式仍需数据分类、供应商协议及企业网关控制。设置允许的模型出口并不等于获得向其发送所有数据的授权。

凭据以 AES-GCM 加密；执行输入、固定计划参数、Runbook 定义也加密。聊天与知识正文仍是数据库普通字段。MASTER_KEY_FILE 可由 KMS/Vault/容器 Secret 挂载；应用没有直接调用云 KMS API。远程执行凭据的最小权限及短期令牌签发由 MCP/身份基础设施负责。

## 并发与预算

| 配置 | 默认值 | 用途 |
| --- | --- | --- |
| MAX_ACTIVE_RUNS / MAX_USER_RUNS | 8 / 2 | 同进程全局与每用户活跃执行 |
| MAX_MCP_CALLS | 4 | 每个 MCP 资源实际步骤执行的并发上限 |
| MAX_PENDING_RUNS | 100 | 排队与待审批数量限制 |
| QUEUE_TIMEOUT_MS | 30000 | 等待空闲执行槽位的上限 |
| RUNS_PER_MINUTE / DAILY_RUN_LIMIT | 20 / 200 | 每用户新执行限额 |
| RUN_TOKEN_LIMIT | 100000 | 单次聊天预留 token 预算 |
| DAILY_TOKEN_LIMIT | 1000000 | 每用户每日预算 |
| WORKSPACE_DAILY_TOKEN_LIMIT | 10000000 | 全工作空间每日预算 |
| MODEL_CONTEXT_TOKENS / MODEL_MAX_TOKENS | 32768 / 4096 | 保守输入估算限制与请求 max_tokens |
| MODEL_PRICE_PER_MILLION / DAILY_COST_LIMIT | 0 / 0 | 统一单价费用估算；0 表示未启用费用门禁 |
| RUN_TIMEOUT_MS | 420000 | 整轮执行时限；模型首字节默认90秒、流中静默默认180秒，最多重试五次；预算与取消可提前停止 |
| APPROVAL_TTL_MS | 900000 | 审批有效期 |

每日以 UTC 日期计。调用前按 UTF-8 字节数量保守估算并预留输出，结束后累计每轮供应商 usage；缺失 usage 时采用估算值。费用使用管理员配置的统一单价，不是厂商最终账单。启用费用限制时必须填写保守单价，供应商本身也应设置硬额度。

执行队列持久化状态，但等待者在当前进程内唤醒。重启后未完成 queued/running 标为 interrupted 或 unknown，不自动重放。MCP 工具目录缓存五分钟，实际调用前重新发现并核对 schema；连接连续三次失败会熔断 30 秒。某个 MCP 发现失败时基础问答可继续，模型收到明确的实时证据缺失提示，成功/待审批/已保存错误消息保留独立的数据源失败信息，刷新可回看。取消/超时不进入降级问答，也不伪造发现失败工具步骤。

## 固定 Runbook 与告警入口

管理员在执行中心提交最多八个固定步骤的 Runbook；另一位管理员审核后发布。模板冻结资源 revision、工具 schema、参数和目标环境。修改资源策略后旧模板不能继续执行，需新建并审核新模板。

只读流程可以直接运行。低风险写步骤还需 `automatic=true` 与部署 `ENABLE_AUTO_REMEDIATION=true`；高风险工具禁止加入自动流程。每个写步骤仍使用幂等参数与结果核验。任一步失败立即停止，不自动回滚或重放后续步骤；通过人工审核的恢复 Runbook 处理补偿。

告警系统可调用 `POST /hooks/runbooks/:id`，正文只能是 `{"eventId":"稳定且唯一的告警事件ID"}`。不得传入工具名或参数。

- X-AIOps-Timestamp 为当前 Unix 毫秒，允许误差一分钟。
- X-AIOps-Signature 是 `HMAC-SHA256(RUNBOOK_WEBHOOK_SECRET, timestamp + "." + runbookId + "." + 原始正文)`。
- 重复 eventId 返回原运行结果，执行中返回冲突；失败不会悄悄重新执行。

本地场景测试覆盖“签名告警 → 只读巡检 → 固定变更 → 只读核验”。企业日志、指标、发布记录和工单工具需要真实 MCP；动态分析建议由对话 Agent 提供，自动流程只接受已审核的固定参数。

## 审计、指标与通知

执行中心展示 runId、步骤、参数（脱敏）、目标环境、审批、核验、错误与用量。`HTTP_LOG=true` 输出 JSON 请求日志与 requestId。审计保存前后哈希，可通过 `npm run ops -- audit-check <data-dir>` 检查链；旧版无哈希行单独计为 legacy。

AUDIT_EXPORT_FILE 按游标追加 JSONL，可接入独立日志收集器。进程在写文件后、保存游标前退出时可能重复导出，消费者按 seq/hash 去重。数据库或本机文件中的哈希链不等同不可篡改存储，应将导出发送至独立权限控制的存储并保存末端哈希。

`/api/health` 为存活检查，`/readyz` 检查数据库、可用磁盘与选中运行时，`/api/operations` 为管理员详细状态。AgentScope 预热成功后正式入口才开始监听；繁忙或部分 Worker 可用时仍可就绪。`/metrics` 需要 METRICS_TOKEN Bearer，提供就绪、并发、队列、磁盘、结果状态、token、配置单价估算费用、待投递通知、Worker 阶段/故障/回收/CPU/RSS 样本，以及完成图谱的 run/model/tool/mcp/review 耗时直方图、固定状态和可选 OTLP 出口计数。新图谱指标在进程内存中聚合，重启清零；`aiops_model_cost_total` 不等于供应商账单。可选 Collector 的故障不改变 readiness 或执行结果；其配置、脱敏和采样边界见 [AgentScope 运行指南](agentscope-runtime.md)。资源样本语义与可选容器限额见同一指南，告警参考 [告警规则](../deploy/alerts.yml)。外部模型健康与额度需真实探测，不纳入 readiness 的硬依赖。

NOTIFICATION_WEBHOOK_URL 接收持久化事件，包含稳定 id、kind、payload。X-AIOps-Signature 为正文 HMAC，Idempotency-Key 为事件 ID。失败指数退避，最多八次尝试，最终 failed 可在执行中心看到。这是兼容的旧出口，消费者自行映射消息；接收方必须去重。

通知中心另外提供数据库管理的企业微信/通用 Webhook 渠道，用于任务结果。配置与凭据加密、指定成员 ACL、发送前实时授权、配置修订检查、按渠道重试和手动重发。新通用签名覆盖 timestamp + 点号 + 正文，与旧协议不同。企业微信验证 errcode=0；至少一次语义可能重复群消息。指标新增 aiops_notifications_failed，pending 指标包含两类出口。详见[通知中心](notifications.md)。

## 备份、恢复、轮换和留存

准备独立的 32 字节 BACKUP_KEY_FILE，存放在受控 Secret 管理系统，不与备份介质一起丢失。目录参数必须是实际路径，目标目录不能已存在。

```sh
npm run ops -- backup .data /secure/backups/aiops-20260919
npm run ops -- restore /secure/backups/aiops-20260919 /secure/restored-aiops
npm run ops -- rotate /secure/backups/aiops-20260919 /secure/rotated-aiops
npm run ops -- audit-check .data
npm run ops -- retention .data
```

backup 使用 SQLite 在线一致性备份，再流式 AES-GCM 加密数据库和对应主密钥，检查 integrity_check；正常完成或可捕获异常收尾会清理临时明文快照及 SQLite sidecar，备份目录仅应保留加密库和清单。进程硬退出时清理不执行，私有备份目录可能留下明文快照，恢复或重试前应检查目录并清理残留。restore 验证认证标签与数据库完整性，只恢复到新目录。rotate 对新恢复目录重新加密所有凭据、执行输入、步骤参数和 Runbook，原库可用于回退；运行 rotate 时不设置 MASTER_KEY_FILE，验证后再把新密钥交给 Secret 管理系统。

retention 默认仅预览。管理员确认后带 `--apply` 清理至少 30 天前的已闲置会话，要求 24 小时内成功备份；待确认执行关联的会话保留。执行证据和审计不自动删除。应按组织政策归档至外部存储，制定后续留存策略，定期检查磁盘。

调度备份由企业定时系统调用命令，必须把命令失败和备份超龄接入告警。至少一次在不同目录或主机恢复，验证账号、会话、权限、凭据解密、审批和不重放语义，测量实际 RPO/RTO。生产的备份位置、保留期和恢复目标需要业务方确定。

仓库提供 [systemd service](../deploy/aiops-backup.service) 与 [timer](../deploy/aiops-backup.timer) 示例，每十五分钟运行 scripts/scheduled-backup.mjs。部署时调整 aiops 用户、安装路径和 ReadWritePaths，并在受控 /etc/aiops/backup.env 配置 DATA_DIR、MASTER_KEY_FILE、BACKUP_KEY_FILE、BACKUP_DIR。Mac 本地验证没有运行 systemd；模板频率不构成已经达到十五分钟 RPO 的证明。

## 发布与回退

CI 配置见 [.github/workflows/verify.yml](../.github/workflows/verify.yml)：测试、构建、官网检查、本地负载演练、依赖审计、容器构建、镜像扫描与 SBOM。它没有自动推送镜像或部署生产。环境未运行 CI 前不能称其已通过。

AgentScope 作业另有 cold/prefork 全量回归、30 场景 DTS 三轮评测和 `agent:image:audit`。扫描先固定本地镜像 ID，覆盖 OS、Python 与 Node 包，保留完整漏洞 JSON、CycloneDX SBOM 与摘要；缺失覆盖或可修复 HIGH/CRITICAL 会阻断。第三期 arm64 镜像去掉非运行必需的 npm/pip 后，可修复 HIGH/CRITICAL 为 0，仍有 60 条发行版未给出修复版本的 HIGH/CRITICAL。发布前应审阅实际适用性、基础镜像升级方案及处置决定；门禁通过不等于生产安全批准。这些是历史镜像扫描结果；当前默认 AgentScope 镜像仍需按实际镜像 ID 扫描，远程 CI/amd64 以本次验证记录为准。

AgentScope 容器不提供 npm/pip/uv；容器内检查运行 `node scripts/check-agent-worker.mjs`，备份/恢复等运行 `node scripts/ops.mjs ...`。构建与审计命令在宿主或 CI 执行。

三个增强开关在 AgentScope cold/prefork 均默认为原行为，开启前用实际问题确认历史裁剪和多文档选择是否适合。证据报告仅保存消息时点的步骤/来源索引，不作为巡检判定、审批执行或通知投递的新真值；后续状态以各自台账为准。单独关闭增强不需要数据库回退。第四期镜像重新扫描仍保留上述 60 条残余告警，增强开发完成不代表上线门禁已通过。

生产 Compose 使用非 root、只读根文件系统、独立数据 / 审计卷、外部 Secret、内存/CPU 限额和优雅退出。只有一个应用副本；当前不支持多副本共享 SQLite。代理示例见 [Nginx](../deploy/nginx.conf.example)。

Dockerfile 默认基础镜像 node:22-bookworm-slim。受限网络可用 `--build-arg NODE_IMAGE=你的已批准镜像地址或digest` 指定组织镜像源；不要跳过 TLS 或凭据校验解决拉取问题。镜像替换后重新执行扫描与容器验收。

发布前保存旧镜像及一致性备份，在测试恢复目录验证迁移再切流。数据库 schema 由 user_version 1 → 2 → 3 → 4 → 5 → 6 顺序升级；不做自动向下迁移。v5 包含运行时标识、调用去重与加密工具返回；v6 为任务增加可空的结构化查询目标，旧任务不自动推断。备份轮换覆盖新增密文。当前构建已移除 legacy；需要回退旧二进制时使用兼容版本的数据备份，并人工核对备份之后的远程操作，避免再次执行。

## 交付清单与外部放行条件

| 事项 | 仓库交付 | 仍需环境证据 |
| --- | --- | --- |
| 共享指令治理 | 发布、版本、回滚、冲突检测、旧指令重新审核 | 真实指令审核人和发布制度 |
| 资源与工具权限 | 用户/角色、环境、参数、数量、schema 与实时撤权 | 企业目录映射、远程账号实际权限 |
| 身份 | 本地认证、签名 MFA 身份网关适配、初始化保护 | 企业 SSO/MFA/离职撤权联调 |
| 写操作控制 | 固定计划、双人生产审批、有效期、UTC 窗口、紧急停止 | 实际工具业务约束与恢复演练 |
| 执行可靠性 | 幂等请求、步骤账本、unknown、只读核验、重启不重放 | 远程业务幂等与真实超时行为 |
| 容量与费用 | 队列、并发、token/费用限额、本地负载脚本 | 峰值流量、供应商配额、费用口径 |
| 数据与凭据 | 出口限制、基础脱敏、外置密钥、加密备份与轮换 | 企业 DLP、密钥管理、备份介质 |
| 运维 | ready/metrics、日志、审计导出、Webhook、告警模板 | 集中监控、值班人与通知送达 |
| 知识 | 持久索引、版本、有效期、ACL、文本同步 | 真实文档质量、外部 ACL 同步 |
| 业务流程 | 固定 Runbook、签名告警、受控自动处置 | 真实日志/指标/发布/工单 MCP |
| 评测 | 协议、权限、恢复与确定性场景测试 | 真实故障集、模型误判/拒答评测 |
| 发布 | CI、镜像构建/扫描流程、备份回退说明 | 实际 CI、镜像、预发布与生产部署 |
| 高可用 | 明确单实例部署边界与人工恢复路径 | 若要求多副本，需独立设计数据库/队列/worker 迁移，当前未实现 |

本次交付不能替代真实环境验收。建议先完成生产只读放行，再放行少量标准变更；自动处置仅在其具体场景、幂等、核验、影响范围和人工接管全部通过验收后启用。

## 可重复的模型选择评测

`npm run eval` 使用本地 fixture 检查评测脚本；`npm run eval -- --real` 使用 EVAL_MODEL_BASE_URL、EVAL_MODEL_NAME、EVAL_MODEL_API_KEY 请求真实模型，EVAL_MODEL_API_TYPE 仅接受 `responses`（默认），真实评测省略 temperature 参数以采用模型默认值。仅检查提出的工具选择和参数，**不会执行任何工具**。用例位于 tests/evaluation-cases.json，包括正确目标查询与破坏性/越权请求。出口策略仍生效。

四个基础用例不能证明诊断准确率。部署团队应加入去敏后的真实事故问题、已知原因和正确证据，记录模型/提示词/资料版本，人工核对根因、引用、拒答措辞、漏检与误报；升级模型或 Skill 后重新运行。缺少真实供应商配置时，真实评测仍为待验收。

## 第五期灰度与验收门禁边界

管理员可选择已发布子领域和通用 Agent 保存、预检和启用增强；失败探针、资源变化、并发修订、过期或撤权不能直接启用。暂停把之后开始执行的轮次恢复 recent/ranked/false 增强基线，仍使用 AgentScope，已接受但排队中的轮次也以开始执行时的策略为准；在途和幂等结果不重放。网页启用不等于生产审批，不自动消费离线验收报告。

`agent:acceptance` 绑定源码/语料/报告与每条答复、证据、rubric，重新计算自动观察及 token/P95。`--engineering` 接受 AI 工程审阅，不能计为正式人工审核；`evaluationAccepted=true` 仍要求真实模型与完整人工批准，`productionAccepted=false`。复核类型和身份由记录者声明，不是企业签名认证。真实账单、生产 DTS 准确性、灰度效果、残余漏洞、目标架构容量和恢复仍需独立证据，见[运行指南](agentscope-runtime.md)与[最新验证记录](verification.md)。

本轮用户选择本机部署和工具范围。独立沙箱的开发机 Docker 通过不证明生产隔离；实际接入必须保持每个提交身份独立连接器、源码写审批和另一管理员的产物批准。观测配置默认 loopback，跨机器生产部署需独立提供目标网络、认证、留存和容量；账单工具没有供应商账户验证能力。边界与操作见[沙箱](../integrations/agent-sandbox/README.md)和[观测/账单](../deploy/observability/README.md)说明。
