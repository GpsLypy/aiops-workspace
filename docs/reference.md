# API、数据与限额参考

## 通用约定

业务接口以 /api 开头，需要本地 Cookie 或签名身份网关认证。写请求必须是 application/json，整体最多 1 MB；无参数 POST/DELETE 发送 `{}`。返回对象或数组，无统一 data 外壳。错误包含 error，执行错误可能附带 conversationId/runId。

NDJSON 业务错误使用 error 终止事件，HTTP 200 只说明流已经开始。429 表示速率、额度或队列限制；409 表示版本、幂等、审批或状态冲突。完整 JSON Schema 和约束见源码 Zod 定义。

## 身份与资源

| 方法 | 路径 | 权限 / 行为 |
| --- | --- | --- |
| GET | /api/health | 匿名存活检查 |
| GET | /api/auth/status | initialized、authMode、setupTokenRequired |
| POST | /api/auth/setup | 空库创建首个管理员；生产需 setupToken 或环境预置 |
| POST | /api/auth/login | 本地账号登录；gateway 模式禁用 |
| GET | /api/auth/me | 当前用户 |
| POST | /api/auth/logout | 清除本地当前会话，不撤销上游企业会话 |
| POST | /api/auth/password | 本地 currentPassword/password，撤销旧会话 |
| GET | /api/users/directory | 当前启用用户目录 |
| GET / POST | /api/users | 管理员查询 / 创建用户 |
| PATCH | /api/users/:id | 管理员修改 active、role、password |
| GET / POST | /api/resources | 可读资源 / 创建资源；MCP 创建需管理员 |
| PUT / DELETE | /api/resources/:id | 可管理资源；MCP 修改需管理员 |
| GET | /api/resources/:id/versions | 可管理者查询版本元数据 |
| POST | /api/resources/:id/publish | 管理员，必须提交当前 revision |
| POST | /api/resources/:id/rollback | 可管理者提交历史 revision，产生新版本；MCP 不支持 |
| POST | /api/knowledge/:id/sync | 管理员从已保存 sourceUrl 同步纯文本/Markdown |
| POST | /api/skills/inspect | 登录用户提交 filename/base64，校验 ZIP 并返回 name、description、documentVersion、body、files（path/size）；不保存资源 |

用户仍是 admin/member 两种角色。角色与工具 userIds、环境/参数策略共同实现执行范围；没有独立租户模型。资源 canManage 为管理员、所有者或 managerIds；canRead 在此基础上允许 public 或 readerIds。公开是工作空间内公开。

资源字段：kind、name、description、domain、body、status、visibility、readerIds、managerIds、endpoint、token、allowedTools、skillIds、mcpIds、knowledgeIds。新增 service、environment（test/staging/production）、documentVersion、expiresAt（ISO 时间或 null）、sourceUrl、toolPolicies。服务端生成 revision、publication、publishedBy。

PUT 为全量提交；省略字段使用 schema 默认值。建议提交读取到的 revision 来检测并发冲突。token 省略保留，空字符串清除。响应不会返回 tokenEncrypted，返回 hasToken 与 canManage。版本快照排除凭据，版本回滚不恢复旧 ACL。

Skill 可包含 `skillPackage: { filename, base64 }`（原始 ZIP，最多 600,000 字节）。POST/PUT 会重新流式校验包，以包内 SKILL.md 覆盖 body，并从 YAML 提取 documentVersion；name/description 使用表单确认值。ZIP 新建均为草稿，管理员也需发布；原始包保存在资源 JSON 和修订快照中，授权读者可获取和下载，回滚同时恢复包及正文。PUT 省略 skillPackage 会移除包字段，纯文本 API 保持兼容。文件布局、解压限制和运行边界见 [Skill 上传说明](getting-started.md)。当前没有独立测试槽位或同名版本去重。

## 增强配置与执行快照

增强 `draft` 必须完整提交：`agentIds`（最多 200 个唯一子领域 ID）、`includeGeneral`、`contextMode=recent|budgeted`、`retrievalMode=ranked|diverse`、`evidenceReports`。不接受未知字段。revision 冲突 409；作用域资源不允许 422；SDK 探针不可用 503；非管理员 403。保存草稿不影响生效增强；预检/启用检查 SDK 可用性、子领域发布状态和修订。所有新快照 runtime 固定 agentscope，runtimeRequired 始终为 true，deployment 不再包含运行时白名单 agentIds。预检和启用间资源修订变化需重新预检。

settings 状态 version=1，mode 为 deployment/active/paused；全局 revision、draftRevision 与 activeRevision 分别代表配置变更、草稿保存、生效策略。新失败探针撤销旧成功证明时也递增全局修订。`metadata.runtimePolicy` 在运行开始后保存 version/revision/activeRevision/mode/matched/runtime/contextMode/contextMaxBytes/retrievalMode/evidenceReports；成功、待审批和执行错误均沿用该轮快照，校验之前拒绝的请求可能无快照。旧消息缺失该字段时不补写。详细流程和回退边界见 [增强运行指南](agentscope-runtime.md)。

## 模型、知识、MCP 与对话

| 方法 | 路径 | 行为 |
| --- | --- | --- |
| GET | /api/model/status | configured、model、model_reasoning_effort，登录可用 |
| GET / PUT | /api/settings/model | 管理员配置 baseUrl、model、apiType、apiKey、temperature、model_reasoning_effort、firstByteTimeoutSeconds、streamIdleTimeoutSeconds |
| GET | /api/settings/agent-rollout | 管理员；增强草稿/生效版本、部署默认值、可选子领域、预检有效性和当前 health |
| PUT | /api/settings/agent-rollout | 管理员；`{revision,draft}` 保存草稿，不改变当前生效策略 |
| POST | /api/settings/agent-rollout/preflight | 管理员；`{revision}`，独立本地 SDK 探针，五分钟有效 |
| POST | /api/settings/agent-rollout/activate | 管理员；`{revision}`，校验当前草稿预检后启用 |
| POST | /api/settings/agent-rollout/pause | 管理员；`{revision}`，后续轮次关闭三项增强，仍使用 AgentScope，不中断在途 |
| POST | /api/settings/model/test | 管理员测试已保存模型 |
| POST | /api/knowledge/search | query，返回授权未过期知识的前五片段与版本 |
| POST | /api/mcp/:id/discover | 可管理者发现工具，缓存目录五分钟 |
| POST | /api/mcp/:id/call | 可管理者直接测试，只允许策略认定的只读工具；接受 Idempotency-Key |
| POST | /api/chat | text、conversationId、agentId、useKnowledge、reviewMode、可选 model_reasoning_effort、可选 targetBinding、requestKey |
| GET | /api/conversations | 当前可见的最近 300 个会话 |
| GET / DELETE | /api/conversations/:id | 本人或管理员查看 / 删除；在途会话不能删除 |

模型 `apiType` 仅为 `responses`（省略时默认）。设置页固定协议，新 PUT 的旧协议值返回400；旧保存配置在内存按 Responses 读取，不自动改写原数据库或密钥。`MODEL_API_TYPE` 只能为 `responses` 或未设置，其他值返回422。`temperature` 为0–2，省略默认0.3，显式 `null` 省略上游参数；无保存配置时 `MODEL_TEMPERATURE=none` 达到同样效果。`firstByteTimeoutSeconds` 为1–120的整数、默认90；`streamIdleTimeoutSeconds` 为60–600的整数、默认180，或0表示禁用流中静默计时。旧配置或旧客户端省略这两个字段时分别采用默认值或保留现值；无保存配置时可用 `MODEL_FIRST_BYTE_TIMEOUT_SECONDS` / `MODEL_STREAM_IDLE_TIMEOUT_SECONDS` 覆盖。保存模型设置整体优先于环境变量。PUT 为全量配置，apiKey省略保留、空串清除；GET不返回密钥。

Responses 请求自动追加 `/responses`，发送 `input`、`max_output_tokens`、`store:false` 和 `include:["reasoning.encrypted_content"]`；函数工具使用平铺定义及 `strict:false` 兼容 MCP Schema。工具结果通过 `function_call_output.call_id` 关联，请求内工具循环续传 reasoning 项（含加密状态），新一轮用户对话仍从本地文本历史构造上下文。文本与 refusal 转为回答，function_call 转为现有受控执行器工具请求，usage 的 input/output token 映射为统一用量。failed/incomplete 等未完成状态和无有效消息返回 502。保持原有超时、取消、出口脱敏、响应大小限制和权限/审批流程。暂不接入图片/音频、供应商内置工具或后台 Responses 任务。普通聊天上游使用 SSE，前端通过 NDJSON 接收正文增量。

chat 的 requestKey 可选，浏览器默认生成 UUID；自行重试应重用原键。结果包含 runId、conversationId、text、metadata，等待审批还包含 status=awaiting_approval 与 stepId。来源包含 revision/documentVersion，usage 为本轮累计值。

`targetBinding` 为 `{resourceId,tool,environment,arguments}`，arguments 是 1–8 个非空文本、有限数字或布尔值组成的对象，字段名须为安全标识符；不接受 null。它来自用户显式确认并进入本轮执行输入/幂等摘要，不能由模型工具参数代填。只读工具策略声明 `requiredTargetFields` 后，绑定必须恰好包含这些字段，实际调用的参数键和值与之逐一相同；绑定轮次仅提供对应的一个工具。同一个 requestKey 换绑定返回 409。缺绑定的受保护工具在调用前返回 422，目标偏移返回 403。未声明该策略的工具保持原行为；固定工具/Runbook/MCP 直接测试不使用此聊天字段。

浏览器发送 `Accept: application/x-ndjson`，响应为逐行 JSON。普通聊天在原进度事件之外提供以下正文事件；未协商 NDJSON 的客户端仍接收完整 JSON 结果。

| 事件 | 字段与处理 |
| --- | --- |
| execution | `runId` 为已持久受理的执行 ID，在等待并发槽位前发送；不表示模型已开始 |
| model_retry | `phase=waiting/connecting`、`attempt/maxAttempts`（首次为1，最多6）、`delayMs`（毫秒）、固定 `reason=connection/timeout/rate_limit/service_unavailable`；超时时附 `timeoutKind=first_byte/stream_idle` 与 `timeoutSeconds`；先通知再等待，正常正文/进度恢复后撤下重试状态 |
| message_start | `streamId` 标识本次模型网络尝试（每次重试使用新 ID），清除上一阶段暂显正文；`reason=retry` 时沿用重连期间保留的正文 |
| message_delta | 相同 `streamId` 的 `text` 追加到当前草稿；只包含输出正文/refusal |
| message_reset | 相同 `streamId`：未带 reason 时撤下工具阶段草稿；`reason=retry` 或浏览器本地产生的 `reason=display_disconnect` 时仅重置队列、保留已显示正文，不向浏览器发送工具参数 |
| done | 完整 `text`、`metadata`、`conversationId` 为持久结果；前端替换草稿并回读会话 |
| error | 清除未完成草稿，显示 `error`，按 runId/会话核对执行结果，不自动重放 |

所有模型调用（聊天、任务、连接测试和独立复核）固定 `stream:true`，仅调用 `/responses`，请求 Accept 为 `text/event-stream`。仅接收相同媒体类型（允许charset参数）的 SSE，完整 JSON 或其他媒体类型立即取消响应体并返回502，不重试、不回退。消费正文/refusal delta，以 `response.completed` 的完整 output/usage 为权威结果，并保留工具往返的加密 reasoning。响应上限2,000,000字节；传输断流、临时连接故障与HTTP408/429/500/502/503/504，以及failed明确标记server_error/service_unavailable/server_is_overloaded/rate_limit_exceeded/slow_down时可重试当前请求最多五次（共六次）。每次尝试从发起请求到首个响应数据块默认最多90秒；收到任一数据块后，默认允许连续180秒没有新数据，值为0时仅关闭此流中静默计时。两类超时均可重试，且仍受整轮默认420秒与预算/权限约束；400毫秒起指数退避、上下10%抖动、5秒上限，优先有效短Retry-After；硬配额码即使HTTP429也不自动重试；详见[恢复与显示节奏](conversation.md#资源检索与模型)。重试保留已显示的未完成草稿，待新正文追上或完整终态后替换，复用已完成工具结果，失败尝试保守估算用量。格式错误、恢复耗尽、未知/非临时failed、incomplete、取消/整轮超时均失败，不保存半截答案。流式开关已移除。连接测试及独立复核通过SSE接收，但复核草稿和判定内容不向用户发布增量，复核仅一轮候选判定，同样可最多重试五次。慢客户端积压超过2,000,000字节时断开；网页45秒无数据或缺终止帧时只读查询既有执行；缺runId按本人requestKey找回，总450秒、单次GET15秒、连续网络故障最多5次，不重发POST问题。恢复等待响应取消信号；显示读取严格UTF-8，帧缓冲上限2,000,000字符。

Responses 输出中的 `output_text.text` 和 `refusal.refusal` 归一化为正文；函数结果按 `function_call_output/call_id` 续传，不将推理或工具参数作为可见增量。

`model_reasoning_effort` 接受 `low`、`medium`、`high` 或 `null`，非法值返回400。模型设置 GET/PUT 与 `/model/status` 返回此字段；设置 PUT 省略时保留当前默认，显式 null 改为服务商默认。聊天省略时继承系统默认，显式 null 不发送参数；前端提交当前选中/继承的值，以固定本轮输入。Responses 请求映射为 `reasoning: {effort: ...}`，不发送同名顶层配置字段。执行开始固定当轮强度，工具往返、恢复、独立复核共享；任务继承执行开始时默认。消息 metadata 保存有效值（null 表示未指定），旧消息不回填；字段参与请求幂等摘要，同键修改档位返回409。配置保存不探测模型能力；不支持时保留上游失败并提示改用服务商默认，无静默降档。

`reviewMode` 为 `off`（默认）或 `independent`，非法值返回 400。仅聊天当前请求开启独立复核，不改变增强配置、子领域或定时任务。开启后分析最多五次模型调用，复核最多一次，两阶段共用当前 runId 的 token/费用/超时。该字段参与幂等摘要；同一键改模式返回 409。同模式重试不重放模型或工具。

网页在当前挂载会话保留开关选择并逐次发送，新会话/刷新初始为 off；运行时禁用切换。已保存的 agentReview 与当前开关无关，可独立展开和导出。

开启时消息增加 `metadata.agentReview={version:1,mode:"independent",status,reasons,stages}`。status 为 `accepted`（通过并展示分析文本）、`blocked`（未通过、固定提示）、`unavailable`（复核未完成、固定提示）或 `skipped`（待人工审批）。stages 为 analyst/reviewer 两条 `{role,modelCalls,tokens}`；modelCalls 是实际开始的模型请求数，失败请求也计次，tokens 沿用供应商用量或已有估算规则。成功完成复核流程时 usage 为两阶段记账总和；复核中的明确临时模型故障沿用每轮最多五次恢复；耗尽或不可恢复时不发布候选草稿。execution 的 success 仅表示流程正常结束，应另看 agentReview，不能解释为复核通过或业务健康。

复核原因枚举：`target_mismatch`、`unsupported_claim`、`missing_evidence`、`stale_evidence`、`conflicting_evidence`；流程原因：`invalid_review`、`review_failed`、`review_input_too_large`、`approval_required`。复核原始输出/候选草稿不保存在消息或审计，阶段统计沿用会话 ACL。JSON 导出仅含这份元数据。取消、超时、权限变更沿用失败/error 语义；审批 skipped 不请求复核模型。运行机制和限制见 [独立复核](agentscope-runtime.md#第六期独立证据复核)。

消息 `metadata` 增加可选 `runId` 与 `mcpFailures` 数组，元素为 `{resourceId, service, phase:"discovery", code:"MCP_UNAVAILABLE", message}`。message 为固定的连接/发现失败说明，无原始异常、地址或凭据；普通成功、待审批与已保存错误消息均保留该字段，历史消息缺失时按空数组展示。待审批响应也返回 metadata。发现失败另记 `mcp.unavailable` 审计（runId/resourceId/phase/code），不创建 tool_steps；真正调用后的失败继续使用原步骤/错误语义。

第四期增加可选 `metadata.context`：`mode=budgeted`、consideredMessages/retainedMessages/omittedMessages、beforeBytes/afterBytes/budgetBytes。数量范围是近 30 条窗口，字节是 Node 初始消息连同 tools 的 JSON，不是供应商 tokenizer 的 token。预算拒绝前未成功构造上下文时此字段可缺失。

启用报告后，`metadata.evidenceReport` 为版本 1 快照：runId、generatedAt、outcome（completed/awaiting_approval/error）、固定 `businessStatus=not_assessed`、runtime/runtimeVersion、已记账 tokens、retrievalMode、context、gaps、sources、mcpFailures、toolSteps。sources 保留资源 ID、标题、修订、文档版本和偏移；toolSteps 保留 stepId/resourceId/revision/tool/environment/risk/status/recordedAt，不含参数/返回密文或正文。outcome 是消息生成阶段，不冒充最终 execution 状态；后续审批不改写快照。沿用会话 API 与 ACL，本地导出无新端点。开关由部署配置或管理员已启用增强策略决定，聊天参数不能覆盖。

MCP 参数必须同时通过远程 JSON Schema 和本地策略。工具名称未分类即拒绝执行；不能通过旧 /mcp/:id/call 接口绕过写审批。

## 执行与审批

| 方法 | 路径 | 行为 |
| --- | --- | --- |
| GET | /api/executions | 成员本人 / 管理员全部，最近 200 条含步骤 |
| GET | /api/executions/request/:requestKey | 按8–100字符的键查询本人原执行；管理员也不能用此接口查他人键，未找到返回404；用于丢失受理回包后的只读找回 |
| GET | /api/executions/:id | 执行详情；不返回加密输入与请求幂等键 |
| POST | /api/executions/tool | resourceId、tool、arguments、environment、requestKey；写计划返回 202 |
| POST | /api/executions/:id/cancel | 本人或管理员取消后续动作 |
| POST | /api/approvals/:id/approve | 管理员批准并执行，id 是步骤 ID |
| POST | /api/approvals/:id/reject | 管理员拒绝，取消等待中的执行 |
| POST | /api/approvals/:id/reconcile | 管理员只读核验 unknown 步骤，不重放写操作 |

execution 状态包含 queued、running、awaiting_approval、success、failed、unknown、interrupted、cancelled。步骤另包含 ready、approved、executing、expired。unknown 不能等同失败未执行。生产或 high 风险不能由发起者本人审批。

`cancel` 返回200表示已接受停止后续动作；审批执行的异步清理结束后仍需回读最新状态。明确用户取消时，挂起的 `approve` 返回409：写请求尚未发出则 run/step 为 `cancelled`，已发出则为 `unknown` 并提示只读核验。取消不自动重放或撤销写入，重复审批已取消或未知步骤继续返回409。

`reconcile`在入口、发现工具之后发出只读查询之前、读取结果之后保存核验结论之前，重新检查请求者仍启用且为管理员、执行所有者仍启用并有只读权限，以及资源仍启用且修订与步骤一致。身份/授权撤销返回403，资源修订或状态变化返回409，保留unknown与此前核验/结果。读取已经发出后发生变化，无法撤销这次只读请求，但不会把该返回写成成功结论。

执行详情包含 `runtime`（新聊天为 agentscope，固定工具/Runbook 为 direct；旧记录可能为 legacy）、`runtime_version`；步骤可能包含 `call_key`，这是服务端内部关联标识。API 不返回 `call_hash` 或 `response_encrypted`，客户端不能通过聊天参数选择运行时或覆盖工具调用身份。运行边界见 [运行指南](agentscope-runtime.md)。

## Runbook、运维与公开集成入口

| 方法 | 路径 | 权限 / 行为 |
| --- | --- | --- |
| GET / POST | /api/runbooks | 管理员列表 / 创建固定步骤草稿 |
| POST | /api/runbooks/:id/publish | 另一位管理员审核当前 revision |
| POST | /api/runbooks/:id/disable | 管理员撤销，revision 增加 |
| POST | /api/runbooks/:id/run | 管理员提交 requestKey 执行固定流程 |
| POST | /hooks/runbooks/:id | 不走用户 Cookie，单独验证 HMAC 与时间戳；只接受 eventId |
| GET | /readyz | 匿名检查数据库/磁盘/选中运行时，仅返回 ready；不可用为 503 |
| GET | /metrics | METRICS_TOKEN Bearer 认证，Prometheus 文本 |
| GET | /api/operations | 管理员查看数据库、磁盘、执行、调度、通知、熔断 |
| POST | /api/operations/emergency-stop | 管理员，enabled 与至少三字符 reason |
| GET | /api/audit | 管理员最近 200 条 |
| GET | /api/audit/export?after=0 | 管理员按 seq 分页导出，最多 1,000 条及 next 游标 |

Runbook 创建输入为 name、description、steps。每个步骤含 resourceId、tool、arguments、environment。服务端冻结 resourceRevision 与工具 schema，不允许告警覆盖参数。签名格式及示例见 [生产治理](production.md)。

## 本机部署状态与账单接口

`GET /api/local-services` 仅管理员可用，不接受查询参数、URL或文件路径。返回本次 `checkedAt`、四项固定本机 `services`（online/offline/unconfigured）、两个已保存服务验收的 `evidence`（测量时间、固定中文检查项及复算通过标记）和账单工具可用标识。无凭据/配置内容/原始报告/私有路径。四探针并发，各1.8秒上限且禁止重定向；Collector405仅入口响应，沙箱健康仅MCP入口响应。缺合法部署报告或默认生产环境显示未配置，不擅自读取生产Collector配置。

`POST /api/local-services/billing` 仅管理员可用，精确JSON输入为 `{"usage":{"filename":"usage.csv","content":"..."},"invoice":{"filename":"invoice.csv","content":"..."}}`。文件名必须是无路径的CSV/JSON，两文本各最多400 KiB；拒绝额外字段、未知列与不符信封。金额仅十进制字符串，JSON数字金额拒绝。响应沿用对账报告schemaVersion1：分日期/供应商/模型/币种的rows、分币种totals、counts、金额/tokens匹配与差额、输入摘要和来源未验证标记。只在内存计算，不保存文件或数据库、调用模型或执行代码；固定中文错误不回显上传内容。

## 定时任务

GET/POST /api/tasks；PATCH /api/tasks/:id 只接受 enabled；PATCH /api/tasks/:id/target-binding 更新结构化查询目标，运行中拒绝；POST /api/tasks/:id/run 返回 202 与任务运行记录 ID；GET /api/tasks/:id/runs 最多 100 条；DELETE 删除任务与 task_runs，保留会话、execution 和通知快照；已入队投递继续。

创建字段为 name、prompt、agentId、scheduleType（once/cron）、cron、timezone（默认 Asia/Shanghai）、runAt、enabled、可选 targetBinding。五段 Cron；单次时间须在未来。按任务所有者身份执行，最多同时四个定时任务，且受 execution 的全局/用户限额限制。任务绑定先校验所有者、资源、已启用状态、只读策略和环境；旧任务迁移后目标为 null，不解析 prompt 推断。任务运行前沿用当前资源/策略校验，缺绑定时受保护工具调用拒绝；在任务列表「查询目标」补配后下一次运行生效。

POST /api/tasks 新增 notification 与 inspectionRules；PATCH /api/tasks/:id/notification 专门修改这两项，运行中拒绝。notification 包含 channelIds（最多 10 个）、mode（all/issues）、recovery、repeatMinutes（1–10080）；inspectionRules 最多 12 条，字段为 label/resourceId/tool/arguments/path/operator/expected，见[判定规则说明](notifications.md)。GET /tasks 和创建/修改响应返回解析后的通知配置，GET /runs 返回 assessment、execution_id 和 deliveries。

task_runs 可为 running/success/failed/interrupted/awaiting_approval；它记录调度阶段结果，审批后的最新变更状态应查看执行中心。暂停不取消已开始任务；手动执行不修改下次自动计划。

## 通知中心接口

| 方法 | 路径 | 权限与行为 |
| --- | --- | --- |
| GET | /api/notification-channels | 管理员全部、成员授权渠道；地址密钥不回显 |
| POST / PUT | /api/notification-channels、/api/notification-channels/:id | 管理员；PUT 必须传当前 revision |
| POST | /api/notification-channels/:id/test | 管理员；已保存且启用的渠道，202 返回 deliveryId；同渠道测试间隔至少 10 秒 |
| GET | /api/notification-deliveries | 本人或管理员全部；page、status（all/pending/sending/delivered/failed）、可选 taskRunId；每页 30 条 |
| GET | /api/notification-deliveries/:id | 本人或管理员；消息快照与文本预览 |
| POST | /api/notification-deliveries/:id/retry | 本人或管理员；仅失败消息，所有者仍需渠道使用权限；202，不重新执行任务 |

渠道字段为 name、kind（webhook/wecom）、endpoint、secret、token、clearCredentials、allowedUserIds、enabled。创建需地址；编辑省略或空白保留地址/凭据，clearCredentials 显式清除两种凭据。管理员响应有 endpointOrigin/hasEndpoint/hasSecret/hasToken，成员响应不含地址与成员列表。状态和重发审计、签名与企业微信业务确认见[通知文档](notifications.md)。

## 数据表与迁移

user_version 当前为 7。v1 是原九表；v2 增加治理/执行/通知表及审计链；v3 增加 FTS5 与 Runbook；v4 增加通知渠道/事件/投递、任务通知与判定规则、运行结论和 execution_id；v5 给 executions 增加 runtime/runtime_version，给 tool_steps 增加 call_key/call_hash/response_encrypted 及 `(run_id,call_key)` 条件唯一索引。v5 迁移为旧数据标记 legacy，新插入聊天显式写入 agentscope，直接执行工具写入 direct，旧步骤关联字段为空。v6 给 tasks 增加 nullable target_binding，旧任务保持 null，需显式补配才可调用受保护工具。v7 新增 agent_delegations，保存同父执行的子任务身份、父运行关联、状态、加密任务/结果、时间、模型/工具用量和全景节点 ID；启动时活动记录标记 interrupted，不重放。FTS5 内部影子表由 SQLite 管理，不作为业务表直接操作。

| 表 | 用途 |
| --- | --- |
| users / auth_sessions | 用户与本地会话 Token 摘要 |
| resources / resource_versions | 当前资源 JSON 与无凭据版本快照 |
| settings | 模型、agent:rollout 增强策略（version 1）、目录缓存、熔断、紧急停止、审计游标、备份记录 |
| conversations / messages | 会话、消息、引用、工具摘要和 usage |
| tasks / task_runs | 定时计划、租约、调度运行记录 |
| audit | 脱敏事件、previous_hash、hash |
| knowledge_chunks / knowledge_search | 固定分块与 FTS5 检索索引 |
| executions | 幂等键唯一约束、输入密文、状态、预算、token、cost |
| agent_delegations | 委派子任务的同父执行关联、加密任务/返回、状态、统计和全景节点身份 |
| tool_steps | 固定参数密文、工具配置版本、策略、审批、核验与结果 |
| notifications | 原环境变量出口的事件与投递状态，兼容保留 |
| notification_channels | 加密地址/凭据、渠道类型、指定使用成员、启停与配置修订 |
| notification_events | 唯一 source_key、消息快照、所有者、任务/运行关联 |
| notification_deliveries | 事件/渠道唯一、投递幂等 ID、状态、次数、下次重试、错误和送达时间 |
| runbooks | 固定流程密文、版本、创建者与审核人 |

不是所有逻辑 ID 都有数据库外键；部分证据有意在业务对象删除后保留。不要手工删除 pending/unknown 步骤。备份恢复和保留期工具见 [运维指南](operations.md)。

## 默认限制

请求 1 MB；问题 20,000 字符；文档 200,000 字符；10 个 MCP 服务；100 个模型工具；最多六轮模型/工具往返（独立复核为分析五轮与复核一轮），每轮最多六次网络尝试；每批十二次工具调用；模型首字节默认90秒、流中静默默认180秒（可禁用）、工具调用30秒、底层 MCP HTTP 20秒；整轮执行默认420秒（RUN_TIMEOUT_MS可覆盖），会话租约为整轮时限加30秒，定时任务租约为排队时限加整轮时限加30秒；网页只读恢复既有执行最多450秒。

全局并发、排队、请求速率、token/费用、审批有效期等可配置项见 [生产治理](production.md)。这些限制不等于生产性能指标，需按实际供应商和数据量验证。

## 问答全景元数据（version 1）

POST /api/chat 的 NDJSON 新增 trace 事件，结构为 type=trace 与 trace=ExecutionTrace。消息 metadata.executionTrace 持久保存同版快照，字段为 runId、traceId、spanId、startedAt/finishedAt、durationMs、status、nodes、edges；新节点增加 spanId、parentSpanId，旧消息允许缺少这些 ID。节点 kind、status、时间、summary 与 label/value details 均有界，边用 from/to 关联节点 ID。默认开启且独立于 evidenceReports，无新请求开关或 API。权限与会话保持一致，数据库 schema 为 v7；不导出问题、工具参数/原文或私有推理。带 METRICS_TOKEN 的 GET /metrics 提供固定 stage 的 Agent 耗时直方图、结果计数和可选 OTLP 出口的发送/失败/丢弃计数，进程重启清零。具体状态和采集边界见 [问答全景](execution-panorama.md)及[AgentScope 运行指南](agentscope-runtime.md)。

## 项目文档 API

文档中心管理部署目录的用户 Markdown，不是知识资源。登录可 `GET /api/documents`，返回 `{documents,canEdit}`；每篇含 path/title/group/content/revision/updatedAt/size，正文供搜索。`GET /api/documents/content?path=docs%2FREADME.md` 返回单篇最新原文。仅管理员 `PUT /api/documents/content`，JSON为 `{path,content,revision}`；成功返回 `{document,siteRebuilt:true}`。仅允许已收录文件，每篇512KiB；不支持新增/删除/任意根目录或额外字段。过期revision返回409，构建/写入失败回退返回422，权限不足403，匿名401。固定构建检查全部完成才表示成功；读取接口 no-store，沿用Origin/JSON门禁。审计 documents.save 只记录路径和前后摘要。详见 [文档中心](document-center.md)。

公司隔离 PoC 的模型配置响应含 `reasoningEffortOnly: true` 和 `timeoutSettingsEnabled: true`：PUT `/api/settings/model` 只接受可选的 `model_reasoning_effort`、`firstByteTimeoutSeconds`、`streamIdleTimeoutSeconds`，至少提供一项。强度为 `low` / `medium` / `high` / `null`；首字节为1–120秒，静默为0或60–600秒。独立 setting `poc_model_reasoning_effort` 与 `poc_model_timeouts` 仅保存这些值，重启后读取；模型地址、名称、密钥、协议和温度仍由部署配置管理，额外字段返回403，非法值返回400。不配置 `timeoutSettingsEnabled` 的旧 PoC 保持仅允许强度的行为。

## 自主委派接口

POST /api/chat 接受 `delegationMode: "off" | "auto"`，默认 off，默认值在持久请求摘要中保持旧请求兼容。开启后模型可调用内部 `delegate_agents`，严格参数 `{tasks:[{agentId:null或已发布AgentID,task:字符串}]}`；每批1至3个、整轮最多4个、深度1，子任务只读。内部工具复用原模型/Worker调用匹配，不是额外公共HTTP端点。完整限制和目标/权限/预算语义见[自主委派](agent-delegation.md)。

`metadata.agentDelegation` 为 version=1，包含 mode、status、固定限制和 children。子记录只含id、parentAgentRunId、agentId/agentName、status、nodeId、开始/结束/耗时、modelCalls/tokens/toolSteps/sourceCount及固定errorCode，不包含任务原文或结果正文。执行详情同样提供 `delegations` 摘要数组，访问沿用原本人/管理员权限；失败执行仍保持原错误回读语义。全景追加delegation/subagent/handoff/aggregate/budget种类及可选agentRunId/parentAgentRunId/parentNodeId，以及有上限时的省略计数omittedNodes/omittedEdges，version仍为1，旧记录缺字段保持兼容。
