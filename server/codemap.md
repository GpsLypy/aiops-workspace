# server/ · 后端代码地图

## 职责

一个 Express 应用共享 SQLite Store，负责认证、治理、知识、Agent、持久执行、审批、Runbook、调度与运维。createApplication 支持临时 dataDir 和关闭定时器，供协议/恢复测试使用。

## 模块

| 文件 | 主要入口与责任 |
| --- | --- |
| [index.mjs](index.mjs) | 运行时预热后监听/启动调度，SIGINT/SIGTERM 与十秒退出上限 |
| [app.mjs](app.mjs) | validateEnvironment、索引补建、装配路由、关闭服务 |
| [security.mjs](security.mjs) | 出口策略、固定 DNS safeFetch、响应上限、redact/protectMessages、gatewayIdentity |
| [auth.mjs](auth.mjs) | createUser、authRoutes、admin，本地会话与网关身份 |
| [store.mjs](store.mjs) | openStore、顺序迁移至 v6、事务、加密、ACL、审计链 |
| [resources.mjs](resources.mjs) | 资源/用户 API、指令发布、版本回滚、来源同步 |
| [skill-package.mjs](skill-package.mjs) | ZIP 有界流式检查、CRC/路径/入口验证、SKILL.md 与 YAML 元数据解析；不解压落盘或执行 |
| [governance.mjs](governance.mjs) | executableResource、authorizeTool、saveRevision、indexKnowledge |
| [retrieval.mjs](retrieval.mjs) | terms、FTS5 候选与 retrieve 评分，可选不同文档/非重叠片段选择，有效期与版本引用 |
| [agent-context.mjs](agent-context.mjs) | 初始文本历史按完整 user 轮次裁剪、UTF-8 JSON 预算与省略统计；不改当轮工具/reasoning |
| [evidence-report.mjs](evidence-report.mjs) | 从本轮持久步骤/来源构造消息时点证据快照，不推断业务健康、不导出参数/返回正文 |
| [model-retry.mjs](model-retry.mjs) | 指数退避/抖动、Retry-After解析、固定供应商错误分类与硬配额码 |
| [model-stream.mjs](model-stream.mjs) | Responses SSE 有界解码、完整终态、正文增量与私有事件隔离 |
| [model.mjs](model.mjs) | 固定 Responses SSE、completion、当前未完成请求有限恢复（首字节默认90秒/流中静默默认180秒/最多五次重试/冻结输入/错误分类/退避）、工具/推理状态续传、用量归一化、出口脱敏与非模型资源的有界读取；可选固定字段请求阶段诊断，默认关闭 |
| [mcp.mjs](mcp.mjs) | connectMcp、discover、连接熔断、目录缓存、受控只读测试 |
| [agent-rollout.mjs](agent-rollout.mjs) | settings 中的版本化增强草稿/生效作用域、独立探针、CAS/权限复核、启用/暂停和每轮快照 |
| [agent.mjs](agent.mjs) | createEngine、上下文、最多六次模型调用、进度/会话、MCP 发现失败的模型提示/持久证据与取消收尾 |
| [agent-review.mjs](agent-review.mjs) | 可选固定双 Agent 的独立无工具复核、嵌套 JSON 出口保护、完整证据预算、严格结果门禁与阶段用量 |
| [agent-trace.mjs](agent-trace.mjs) | 有界脱敏全景、每轮及节点关联 ID、实际完成图谱的进程级阶段指标 |
| [otel-export.mjs](otel-export.mjs) | 可选 OTLP/HTTP JSON 导出、确定性整轮采样、固定字段与有界失败隔离队列 |
| [target-binding.mjs](target-binding.mjs) | 显式本轮目标契约与只读工具调用前的资源/工具/环境/字段精确比较 |
| [agent-runtime/](agent-runtime/codemap.md) | Node 原始消息/预算与工具回调、唯一 AgentScope 冷启动或 prefork 池、探针与生命周期 |
| [execution.mjs](execution.mjs) | createExecutionService、run（持久受理回调在并发等待前）、callStep、approve、reconcile、cancel、本人requestKey只读查找、额度与恢复 |
| [runbooks.mjs](runbooks.mjs) | 固定步骤草稿/发布、单次运行、签名告警 |
| [scheduler.mjs](scheduler.mjs) | nextRun、claim、perform、tick、任务记录 |
| [inspection.mjs](inspection.mjs) | 正常条件 Schema、资源权限、实际工具证据和新鲜度判定 |
| [notifications.mjs](notifications.mjs) | 通知渠道与 ACL、任务事件、异常抑制/恢复、企业微信/Webhook 投递和重发 API |
| [operations.mjs](operations.mjs) | 请求日志、ready/metrics、审计导出、通知重试、紧急停止 |
| [local-services.mjs](local-services.mjs) | 管理员固定本机服务健康探针、历史验收白名单摘要与仅内存 CSV/JSON 账单导入对账；生产默认不探针 |
| [backup.mjs](backup.mjs) | createBackup、restoreBackup、rotateBackup；新目录恢复和轮换 |

## 装配与调用链

环境检查 → openStore/迁移 → 缺失知识索引补建 → 初始管理员 → HTTP 安全头/请求日志/JSON → 公共认证入口 → /api 身份中间件 → 业务路由。正式入口在运行时预热后监听并启动调度；关闭时等待执行与 Worker 清理。/readyz 与 /metrics 不经过 /api Cookie 门禁，前者综合数据库/磁盘/运行时返回最小状态，后者使用独立 token，包含池与 CPU/RSS 样本；/hooks/runbooks 使用独立 HMAC。

chat/task → execution.run → 幂等和预算预留 → 持久受理回调/发送runId → 并发槽位 → engine.execute → 会话锁/发布与 ACL/检索 → 模型 → execution.callStep。只读立即执行，写操作保存待审批后结束对话。approve → 再授权 → schema 校验 → callTool → 只读核验。

聊天显式开启独立复核时，分析最多五轮，之后以同一 execution 运行一轮无工具复核；每轮最多六次实际网络尝试；复核通过才发布分析文本，其余输出固定说明。复核前/请求前/结束后检查身份与资源版本，故障取消本阶段模型请求，用户取消终止整轮。待审批直接跳过复核。tests/agent-review.test.mjs 和 tests/agent-review-security.test.mjs 覆盖协议、权限、预算、审批、幂等、出口与 Worker 故障。

runbook → 固定参数与冻结资源版本 → execution.run → 每个 callStep → 核验；不使用模型生成的动态参数。生产自动写还需开关与自动策略，高风险拒绝。

## 持久状态与边界

executions 保存幂等键、输入密文、状态、预算、费用与 runtime/version；tool_steps 保存参数密文、策略、schema 哈希、审批和核验。v5 新增每 run 的调用身份唯一约束、摘要与加密原始工具返回，用于 AgentScope 重传去重并纳入备份轮换。v6 为 tasks 增加可空的 target_binding；旧任务不自动从 prompt 推断目标，受保护工具缺失绑定时拒绝。进程启动把旧 queued/running 标 interrupted/unknown，不重放。待审批保持持久化并按有效期处理。

SQLite 同步调用，单实例限制。audit 哈希链在事务内追加，外部导出至少一次、消费者去重。远程幂等需要工具端实现；取消不撤销远程副作用；未知结果只读对账。生产环境配置和完整边界见 [生产治理](../docs/production.md)。

## 验证入口

tests/integration.test.mjs 保留基本业务协议回归；model 测试 Responses 配置/工具往返/推理续传/历史/用量/异常；security 测试治理与出口；execution 测试审批/幂等/恢复；operations 测试备份/轮换/监控；scenarios 测试固定告警 Runbook 与知识索引。scripts/load-test.mjs 只连接本地协议 fixture。

tests/agent-enhancements.test.mjs 覆盖第四期配置、历史预算、来源权限/绑定、多文档非重叠、报告持久/审批快照/失败与 Responses reasoning；同一文件在 AgentScope cold/prefork 矩阵运行。

任务结果/结论与通知事件在同一事务保存；通知后台独立投递。新表与通用接口见[巡检通知](../docs/notifications.md)，原环境变量出口继续兼容。tests/notifications.test.mjs 覆盖协议、权限、抑制、迁移与恢复。

第五期 tests/agent-rollout.test.mjs 覆盖管理权限、CAS、草稿/过期/资源变化、异步撤权、探针清理、作用域外基础配置、重启/幂等/排队快照；tests/agentscope/rollout.test.mjs 使用真实 SDK 验证在途暂停/恢复和无重放。暂停只恢复三项增强的基础配置；所有新轮次和通用/专用 Agent 始终使用 AgentScope，readiness 与 metrics 始终反映真实 Worker 状态。旧执行记录保留原 runtime，不改写历史；新对话显式写入 agentscope，进入 Agent 后记录实际桥接版本。MCP 直接测试、执行中心固定工具与固定 Runbook 标记为 direct / 1，表示只通过 Node 治理执行器，不调用模型或 AgentScope；两类均避免继承旧迁移的 legacy 默认值。

## 问答全景观测

[agent-trace.mjs](agent-trace.mjs) 维护版本化、有界、脱敏的节点/边记录；agent.mjs 在授权上下文、目录、工具、复核与答复阶段记录事实，运行时通过 onModel 回调记录模型实际请求。NDJSON trace 事件用于暂态显示，messages.metadata.executionTrace 用于持久回看；不增加数据库迁移，不改变审批策略。详见 [问答全景](../docs/execution-panorama.md)。

2026-10-08：新图谱带持久 trace/span 关联 ID，旧图谱保持可读；每个完成图谱只在本进程计入一次固定阶段直方图及结果计数。续轮增加部署显式开启的 OTLP/HTTP JSON 出口与可选模型/MCP 出站 `traceparent`；payload 只含固定字段，失败不影响执行，`/metrics` 保留独立 token 并增加出口计数。默认不导出或传播。

模型节点名称来自completion选用的每次请求配置，不在响应完成后重读设置。普通最终消息metadata.model为最后分析请求的名称，独立复核保留自己的节点；不锁定整轮模型、不改变设置API或schema。

本机观测 Compose 独立位于 deploy/observability，通过现有 OTLP/metrics 接口接入，不新增应用数据库。代码执行另由 integrations/agent-sandbox 的 socket broker 与受治理 MCP 提供，复用固定写审批/幂等/核验/恢复；不把 Docker 权限交给 AgentScope Worker，不自动加入现有 DTS Agent。

`GET /api/local-services` 仅管理员可读；开发环境存在固定合法部署报告才并发探测固定 loopback Collector/Tempo/Prometheus/沙箱健康地址，最长 1.8 秒，不跟随重定向、不接收 URL/路径、不执行代码或模型。生产默认返回 unconfigured。历史报告只映射固定中文检查项、布尔结果与测量时间，不提供文件路径、Token、PID、任务 ID 或报告全文，也不把历史工程检查解释为当前源码或生产批准。`POST /api/local-services/billing` 接收两份每份最多 400 KiB 的 CSV/JSON 文本与无路径文件名，复用严格离线校验及精确货币对账；只返回标准金额/差额结果，不写入文件、SQLite 或供应商账户，未知字段/非法文件返回固定中文错误。专项在 `tests/local-services.test.mjs`。

## 用户文档维护

[documents.mjs](documents.mjs) / createDocuments / documentRoutes：模块位置确定根目录，发现 README.md 与 docs/deploy/integrations 的用户 Markdown，拒绝隐藏/开发地图/非文档/符号链接；每文件最多512KiB，列表带搜索正文。登录可 GET 列表与单文件，仅管理员可 PUT；保存串行、摘要CAS、同目录原子替换、固定文档构建/检查，失败回退源与旧官网，审计只记录路径与摘要。App可注入临时根/rebuild供测试。缺少官网目录的精简包不会阻断应用启动；编辑需要完整可写源码和构建材料。

2026-10-09：model.mjs 导出 reasoningEffortSchema；设置/status 暴露 model_reasoning_effort，缺失旧配置归一为 null。agent.mjs 在执行开始固定有效强度，分析/工具后模型与独立复核共用；completion 映射到 Responses reasoning.effort，重试冻结请求。消息 metadata 与模型节点记录档位，无 schema 迁移。

2026-10-09：request-policy.mjs 统一每次模型60秒、最多六次尝试与整轮默认420秒；Agent会话锁、execution取消及scheduler租约使用同一整轮时限，任务租约另覆盖队列等待。

2026-10-10：公司 PoC 通过 modelSettings.reasoningEffortOnly 仅开放默认问答强度保存，独立 setting 持久；模型连接配置继续禁止修改。

2026-10-10：公司 PoC 在受限模型设置中额外启用 timeoutSettingsEnabled，仅开放首字节和流中静默超时；独立 setting 持久，启动时校验，模型连接字段继续禁止修改。

2026-10-10：agent-delegation.mjs管理delegate_agents严格批次、最多4个单层只读子任务、主子授权交集、共享12轮模型与token预算/时限/取消、实际子证据复核和加密状态；store迁移v7 agent_delegations。execution.beforeModel预留并发在途预算，agent-runtime/driver提供跨父执行有界cold子通道。失败记录与父子全景保持实际状态，备份恢复/轮换覆盖新加密字段。

文档中心按使用、代码库、原理、运维、学习和历史验证组织；代码库速览直达前端、后端与Worker地图。公开源码地图由 docs/web/content.mjs 明确登记，server/documents.mjs 仅放行登记路径，继续拒绝隐藏、越界和符号链接。目录总览见 [代码库说明](../docs/repository-guide.md)。

2026-10-15：diagram-assets.mjs 为三条固定架构静态地址设置同源内嵌与精确脚本摘要CSP；入口仍禁止被内嵌，应用其他地址保留DENY。图表拒绝网络连接，外网字体不可用时回退本机字体。app.mjs通过express.static的setHeaders装配。
