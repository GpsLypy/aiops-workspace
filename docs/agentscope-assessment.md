# AgentScope 重构可行性、成本与实施方案

调研日期：2026-09-24；当前实现更新：2026-09-29。**AgentScope 已成为唯一 Agent 编排运行时，旧循环、双引擎路由和 legacy 回退已移除。** 本报告以下路线比较、工作量与阶段记录保留为历史调研，不作为当前启用说明；其中的 legacy 对照和回退命令不再适用于当前构建。Python 安装、增强配置与恢复以 [运行指南](agentscope-runtime.md) 为准，当前验证及既有真实模型质量缺陷见 [验证记录](verification.md)。

## 1. 建议与决策

**技术上可行，推荐保留现有 React、业务 API、权限与执行治理，用 AgentScope 2.0 替换推理编排内核。先投入 5–8 人日验证，再决定是否迁移。** 如果目标只是继续运行当前 DTS 状态查询、定时巡检与企业微信推送，暂不重写也合理：换框架本身不会提高数据准确性或自动获得高可用。

AgentScope 更有价值的场景是后续持续建设复杂排障、多 Agent 分工、长上下文、结构化输出、更多模型适配和可观测性。当前平台最需要保留的资产是业务语义：谁能使用哪些资源、何时审批、如何判断写入结果、如何依据真实证据判断巡检结论，以及如何可靠推送。

| 路线 | 交付边界 | 估算总工作量 | 参考工期 | 建议 |
| --- | --- | --- | --- | --- |
| 只做 PoC | 独立 Python Worker、模型/工具桥接、本地协议与关键边界验证 | 5–8 人日 | 1 人约 1–2 周 | 先做，作为决策门槛 |
| A：渐进替换内核 | 现有功能基本等价；保留 Node 业务平台、React、SQLite 和 DTS MCP | 30–45 人日，含 PoC | 1 人约 6–9 周；2 名开发加兼职 QA 约 4–6 周 | **推荐** |
| B：重建后端 | 保留现有 React 与 API 契约；Python + AgentScope 承担全部后端，迁移业务数据与治理规则 | 65–95 人日，含 PoC | 2 名开发加兼职 QA 约 8–12 周 | Python 长期技术路线明确时考虑 |
| C：连前端一起重建 | B 加页面重做、交互适配、完整浏览器回归 | 90–130 人日，含 PoC | 2 名开发加兼职 QA 约 10–16 周 | 仅因换框架没有足够理由 |

人日指开发、联调、测试与交付的总有效工作量；多人不能按人数简单等比例压缩关键链路。假定参与者熟悉异步 Python、Node 和本项目，保持单实例，复用当前功能范围；不包含新增 DTS 写接口、企业 SSO 落地、PostgreSQL/高可用改造、新 RAG 平台或正式多 Agent 产品能力。PoC 前的不确定性约 ±30%；Python 不熟悉、需求变化或供应商兼容问题会进一步增加成本。

## 2. 调研基线与可信程度

### 调研时的项目基线（2026-09-24）

- 技术栈：React 19 + TypeScript、Express 5、Node ≥22.16、原生 SQLite、MCP SDK。
- 后端 19 个 `.mjs` 文件，2,079 行、约 164 KB；前端 TS/TSX 17 个文件、675 行、约 119 KB；测试文件 9 个、1,139 行。源码存在大量压缩长行，不能按行数推算工时。
- `agent.mjs` 为 177 行，且包含会话和 HTTP 路由；连同 `model.mjs`、`mcp.mjs`、`retrieval.mjs` 约 385 行。框架最直接替换的部分只是平台的一部分，不能把整个后台视为一个 ReAct 循环。
- 本次实跑：`npm test` **58/58 通过**；`npm run build` 通过。测试使用本地协议 fixture，不代表新框架或真实生产环境验收。
- 工作区文件尚未提交；使用文件路径定位，没有可引用的本项目提交 SHA。没有读取 `.data`、模型密钥或真实 DTS 凭据。

### AgentScope

截至本次查询，GitHub 最新稳定发布为 **v2.0.8，2026-09-08 发布**；tag 对应 commit 为 `c7d8e31bfd0a2f85e67b6235bd44c09fce259106`。本报告研究 Python 主项目，要求 **Python ≥3.11，Apache-2.0**，不是对其他语言实现或整个生态的等价性评估。[S1][S2]

采用 `/en/versions/2.0.8/` 文档和 `v2.0.8` 源码。官方 `latest` 当前指向开发文档；2.0 将 `ReActAgent` 改为 `Agent`，调用改为 `reply` / `reply_stream`，hook 改为 middleware，状态改为 `AgentState`。不能复制 1.x 示例后直接视为适配完成。[S3]

原调研证据分为官方能力说明、固定版本源码与项目基线。2026-09-26 已实际安装 AgentScope 2.0.8，完成 SDK 桥接、业务回归、故障测试与本机 fixture 并发对比。第二期新增预加载父进程池、每轮独立子进程、资源指标、依赖审计与容器验收工具。2026-09-27 第三期默认回归 73/73、prefork/cold 各 90/90，DTS 固定语料共 180/180，通过换钥恢复后治理回退演练；尚未完成真实供应商诊断质量、DTS 灰度或生产性能验收。

## 3. 框架到底能替代什么

| 能力 | AgentScope 2.0.8 已有基础 | 本项目处理建议与剩余工作 |
| --- | --- | --- |
| 推理与工具循环 | `Agent`、`Toolkit`、事件流、结构化输出 | 替换循环；适配当前 6 次模型调用、120 秒执行预算、单轮最多 12 个工具等限制 |
| 模型接入 | `OpenAIChatModel`、`OpenAIResponseModel`、自定义 `ChatModelBase` | 两种协议有基础；必须验证自定义 base URL、推理状态、用量、异常、取消和出口脱敏 |
| MCP | `MCPClient`、HTTP/stdio 配置、`MCPTool` | 现有 DTS 服务协议可复用；首期实际调用仍经 Node 执行器，避免绕过治理 |
| 人工介入 | 确认事件、外部执行事件、结果回填、可序列化状态 | 用外部执行事件桥接 `execution.callStep`；持久审批、双人控制、版本冻结、TTL 与写后核验继续由平台负责 |
| 上下文 | 自动压缩、工具结果截断/卸载、`AgentState` | 后续收益较大；首期保持近 30 条历史、原有来源与权限边界，不同时切换记忆策略 |
| Skill | `SKILL.md`、loader、按需读取工具 | 当前是已发布 ZIP 正文注入。首期沿用，不自动改成按需读取或执行包内脚本 |
| 知识检索 | RAG 中间件、解析/向量存储、RAG Service | 首期复用 ACL + FTS5，保留修订/有效期/引用；向量化是独立项目，需评测收益 |
| 多 Agent | Agent Team、Pipeline、A2A | 可支持未来诊断分工；当前“子领域”是配置和资源绑定，不是现成多 Agent 团队 |
| 用户与共享 | Agent Service 的 owner 隔离、资源访问策略扩展点 | 真实认证由应用接入；公开/私有、管理员、管理人、指定使用者、发布/回滚需映射或保留 |
| 服务与存储 | FastAPI、会话 SSE、Redis、SQLAlchemy 存储 | 对完整重建有帮助；数据表不是当前 SQLite 的可替换模型，需独立迁移与密钥方案 |
| 定时任务 | Scheduler、唤醒与后台任务 | 能调度 Agent，不等于本项目的任务租约、一次性停用、确定性巡检判定与通知事务 |
| 通知与渠道 | 飞书、钉钉、Discord、Custom Channel | 官方列出的渠道不直接提供本项目企业微信群机器人投递闭环；保留现有 Webhook/企业微信实现 |
| 生产执行与审计 | 权限引擎、中间件、Tracing 等扩展基础 | 幂等台账、unknown/对账、固定 Runbook、审计哈希链、备份/轮换仍是应用工作 |

能力依据见 [S4]–[S10]。这里的“已有基础”不代表开箱即用满足本项目需求，也不表示框架无法扩展实现。

## 4. 影响成本的关键差异

### 4.1 框架确认与生产审批不同

现有 `execution.callStep` 冻结参数、资源修订与 Schema 哈希；生产写操作需要另一位管理员审批，执行前再次检查权限，执行后做只读核验。网络错误且写入可能已经发出时标记 `unknown`，重启不自动重放。

AgentScope 的 `RequireUserConfirmEvent` 是对话中的确认机制，还可以接受规则以减少后续确认；这不等价于上述持久治理。推荐采用 `RequireExternalExecutionEvent`，把决定权留给平台。[S4]

外部工具事件之前仍会经过框架权限检查。适配器只对 Node 下发的工具目录允许“发出执行请求”，不开放全局 `BYPASS`；该允许不构成业务授权，Node 每次执行仍检查当前用户、资源和参数。[S10]

### 4.2 默认配置会改变行为与费用

固定版本 `ReActConfig.max_iters` 默认是 **50**；到上限时还可能额外调用模型生成总结，结构化输出也有额外迭代。设置 `max_iters=6` **不能单独保证最多调用模型 6 次**。模型适配器也包含重试机制。须在模型出口统一计算每次实际请求，控制重试、总结和压缩，不只在循环层记账。[S5][S11]

当前遇到错误 JSON 参数会拒绝；框架会尝试 Schema 指导的 JSON 修复。桥接方案应保存原始参数文本，由 Node 严格解析和校验，不接受静默修复导致的参数/对象变化；尤其要防止 DTS 大整数 ID 被变成 Number。[S10]

Skill 当前把选中的已发布正文放入 system；框架默认提供技能目录，让模型调用 Skill viewer 按需读取。后者会改变指令必达性、工具次数和成本。迁移阶段继续注入正文，按需加载后续单独评测。[S6]

### 4.3 通用服务不等于业务平台已齐备

官方 Agent Service 使用 `X-User-ID` 占位身份依赖，文档明确要求替换为真实认证。共享策略接口不替应用管理组织、成员关系和发布审批。首期保持现有 Cookie/网关身份和 ACL。[S7][S8]

Agent Service 的 SQL 存储支持多种数据库，但不是现有加密 Store 的直接替换品。固定版本存储路径通过 `_dump_with_secrets` 序列化凭据；不能把 `SecretStr` 的显示遮蔽视为本项目现有的静态加密、主密钥管理和轮换能力。全量重建需要明确设计这些能力。[S12]

官方 2.0.8 服务文档将分布式部署标为 WIP，并要求只有一个进程启用定时器，否则每个副本都会触发 Cron。使用 Redis 或 SQL 后端本身不能替代业务调度唯一性和故障恢复设计。[S7]

## 5. 推荐架构：Node 业务平台 + AgentScope Worker

用户仍访问现有 React 和 Express API。Node 先创建 execution、校验身份与资源、领取会话锁，再把最小运行上下文交给 Python Worker；Worker 使用 AgentScope 生成回答或提出工具请求，Node 执行并回填结果。

| 层 | 首期负责的内容 | 数据/网络权限 |
| --- | --- | --- |
| React | 原有登录、聊天、资源、执行审批、任务和通知页面 | 继续只访问现有 `/api` |
| Node 控制层 | 身份、ACL、发布、检索、预算、执行台账、审批、MCP、调度、巡检、通知、审计 | 唯一业务数据库写入者；持有模型/MCP 凭据 |
| Python Worker | AgentScope `Agent`、上下文、事件转换、外部工具声明 | 只接收经筛选的上下文；不直接打开现有 SQLite，不直连 DTS |
| 现有 DTS MCP | 状态查询、区域与输入校验、归一化 | 继续独立 Node 服务与现有授权范围 |

仅引入 Python SDK Worker 和内部通信，不引入完整 Agent Service、Redis、向量库或通用 Shell 工具。框架及传递依赖通过 uv.lock 锁定；第二期 Python 审计检查当前平台 90 项依赖，未发现已知漏洞，并新增 opt-in 容器。第三期增加 OS/Python/Node 全镜像扫描和 SBOM，移除运行时不需要的 npm/pip，消除 8 条可修复 HIGH；剩余基础包 60 条未修复 HIGH/CRITICAL 需适用性与基础镜像策略审核。依赖审计或可修复漏洞门禁通过均不等于生产安全放行。

### 5.1 先抽出稳定的内核接口

从 `server/agent.mjs` 拆分外壳和内核：外壳保留会话权限/锁、资源准备、消息持久化和原有 API；`AgentRuntime` 接收准备好的上下文。实现 `LegacyRuntime` 和 `AgentScopeRuntime`，聊天和 scheduler 继续进入同一执行入口。

当前实际目录：

```text
server/agent-runtime/       Node 原始消息/预算、旧循环、私有 stdio 客户端
agent-worker/              Python 3.12、agentscope==2.0.8、依赖锁与外部工具桥接
tests/agent-runtime.test.mjs  管道故障、持久去重、迁移和备份
tests/agentscope/          真实 SDK 专项，另在新运行时重跑原业务回归
```

### 5.2 内部契约与授权边界

首期采用每 run 冷启动 Python 与私有 stdin/stdout；第二期默认采用 POSIX prefork：父进程仅导入 SDK，收到 lease 后 fork，Node 等子进程 leased 再发送业务上下文，父进程 wait4 回收确认后复用。保留 cold 回退模式。管道由 Node 建立并绑定可信 execution，不增加内部 HTTP 服务、不下发真实凭据。每轮 Agent/事件循环独立；这里的进程隔离不是操作系统权限沙箱。

| 操作 | 主要字段 | Node 保证的规则 |
| --- | --- | --- |
| `start` | version=1、runId、system、history、tools | Node 准备授权上下文、工具映射并控制截止时间 |
| `model` | runId、请求序号 id | Node 持有唯一原始消息与工具目录；Worker 不能覆盖消息、URL、Key；计次、记账、出口脱敏 |
| `tool` | runId、id、replyId、callId、name、原始 arguments | 匹配已校验模型调用的顺序与原文，再进入现有权限/Schema/审批与执行层 |
| 回复 | runId、id、ok、result | 重复序号内容一致时返回缓存；不一致拒绝；真实工具结果先持久化 |
| `finish` / `fatal` | runId、status 或固定错误码 | 校验最终状态；取消/退出停止子进程与回调，业务持久化后才向前端发 done |

上表是两种模式共用的 v1 运行协议，prefork 另有 v2 lease/leased/ready 生命周期与 PID/资源样本。单帧/总输出/事件/请求均有上限，写入等待背压。运行配置与管道在整个 run 中固定，Python 不选择用户或资源；Node 负责超时和进程组终止。没有网络端点或独立 run token：私有管道和闭包执行上下文是本实现的信任边界，若未来换成远端 Worker，必须另加服务认证和 run 范围凭证。

schema v5 已补持久去重：`callStep` 接受 replyId/callId，将 `(run_id,call_key)` 唯一键、请求摘要与步骤在同一 INSERT 写入。重复请求返回原待审批状态或加密保存的原成功响应；参数/版本不一致拒绝，执行中/失败/unknown 不重放。供应商 ID 加模型轮次前缀，原 provider ID 留在 Node 协议消息中。

### 5.3 工具闭环与审批

1. Worker 将经授权目录声明为 `is_external_tool=True`，不在 Python 内直接创建真实 MCP 执行连接。
2. 收到 `RequireExternalExecutionEvent` 后，将工具请求交给 Node；Node 顺序处理，继续走 `authorizeTool`、Schema、执行台账与 `execution.callStep`。
3. 只读成功：Node 保存证据，再将结果转换为 `ToolResultBlock`，通过 `ExternalExecutionResultEvent` 让 Worker 继续推理。
4. 待审批：Node 保存步骤并按当前行为结束本次聊天，返回 `awaiting_approval`；中断/释放 Worker 的暂停运行，后续批次工具不执行。批准后继续由现有审批接口独立执行、核验，不自动恢复原 Agent 对话。
5. 只有未来明确需要“批准后继续推理”时，才增加持久 AgentState、待处理调用列表与恢复合同。官方指出部分回填不会重新发送剩余待处理事件，必须自行维护完整待处理集合。[S4]

Worker 失联时由 Node 收尾；若工具已经发出，仍使用现有 `unknown` / 只读对账语义。禁止自动切换旧引擎重跑同一执行。`finished_reason=None` 是等待，`interrupted/error/exceed_max_iters` 不能因为有文本就映射成成功。[S5]

### 5.4 模型、预算与前端事件

首期已实现自定义 `ChatModelBase`，通过私有管道复用 Node 的 `completion`、`safeFetch`、凭据解密、脱敏、`beforeModel/charge`。Node 保留原始消息和 Responses reasoning，Python 只转换统一响应与外部工具事件。两协议、call ID、reasoning 续传和用量已由本地 fixture 验证。官方自定义模型接口见 [S9]。

如果桥接复杂度超标，再选择 Python 原生 `OpenAIChatModel/OpenAIResponseModel`，前提是等价实现出口允许列表、DNS 固定、超时、正文大小、密钥和预算规则；这不是简单换一个 SDK 构造器。不要同时保留两处独立预算真值或叠加两层无界重试。

所有模型调用共享 Node 的单 run 计数与额度，包括框架的总结、重试、压缩；首期关闭按需技能/长期记忆等会改变调用路径的附加能力，并对压缩中间件配置明确策略，不能仅靠默认值。原有错误和上限行为先保持兼容。

原迁移阶段将框架事件适配为 `execution/session/progress/done/error/heartbeat` NDJSON。2026-10-02 正文流式功能在 Node 模型层追加 `message_start/message_delta/message_reset`，前端渐进显示并在 done 后回读会话。内部推理、工具参数和复核草稿不直接展示；原知识来源、工具摘要与 runId 继续保存。

### 5.5 状态、数据与回滚

首期每个 run 由 Node 读取近 30 条历史后重新构建 Worker 状态；本轮 state 留在 Worker 内，仅用于当前工具闭环，不成为跨会话长期记忆。由 Node 持有会话锁、用户资源快照和唯一 execution。

已显式增加 schema v4 → v5 迁移，保存 runtime、AgentScope/桥接版本与持久调用身份，原始工具返回加密存储并纳入备份轮换。Python 不直接读写业务表，避免两处状态真值。

当前按子领域资源 ID 开启新运行时；未配置列表时全量选择，通用对话在非空列表下保持 legacy；每个 run 启动时固定 runtime。旧引擎保留至少一个发布周期。回滚先停止分配新 run，再等待/取消在途执行、对账 unknown，最后切回兼容版本。新增 schema 必须同时保留旧运行时路径：旧二进制会拒绝未来 schema，不能认为改回环境变量就能回滚数据库。

### 5.6 如果坚持重新实现一个完整后端

采用独立项目/数据目录搭建 Python 后端，复用现有 React；FastAPI 业务 API 与 AgentScope Agent Service 组合，前端仍通过兼容 `/api` 层访问。Agent Service 提供会话/状态/模型等基础，以下业务模块作为独立应用层实现，不能直接用框架资源 CRUD 替换：

| 新后端模块 | 迁移职责 |
| --- | --- |
| identity / resources | 本地账号或可信网关、Cookie/Origin、角色与资源 ACL、版本、发布、ZIP Skill；替换默认 X-User-ID 依赖 |
| execution / governance | 请求/步骤幂等、预算、队列、固定审批计划、Schema/修订、双人审批、unknown/核验、Runbook |
| tasks / inspection / notifications | 唯一调度源、租约、证据规则、业务结论、事务 outbox、企业微信/Webhook 重试和抑制 |
| persistence / operations | 业务表与框架表边界、密文和密钥、审计链、备份/恢复、指标、限流与受控出口 |

首版仍可使用 SQLite；若同时采用完整 Agent Service，其消息总线等依赖按官方服务要求单独配置，不能套用 SDK Worker 路线“不需 Redis”的结论。PostgreSQL、多副本和向量检索应另行拆项目。

迁移顺序为：以相同 API/状态机重建 → 临时库导入演练与对账 → 只读试点 → 暂停旧调度和新写入 → 最终增量导入 → 新服务接管。保留用户/资源/会话/步骤 ID 或显式建立映射；在受控进程内转换密文，不通过明文文件搬运凭据。历史审计链原样归档并记录新链起点，不能改写后冒称链连续；待审批计划需保持冻结数据与审批人，否则在切换前作废并重新制定。

迁移窗口内只允许一个任务调度与通知投递所有者。对账至少包括实体数量、引用关系、密文可解密、任务下次触发、未决审批、未完成投递与审计完整性。先做可恢复快照；新后端产生新数据后的回滚需要回传数据或保留新库只读查询，不能仅切回旧备份造成已执行动作遗失。上述差异是路线 B 成本明显增加的原因。

## 6. 成本拆分与运行成本

### 路线 A 的 30–45 人日

| 工作包 | 人日 | 验收产物 |
| --- | --- | --- |
| PoC 与版本锁定 | 5–8 | 固定版本、外部工具暂停/回填、两种模型协议、审批/取消/拒绝样例 |
| 外壳/内核拆分 | 4–6 | LegacyRuntime 保持行为，聊天/任务共享契约 |
| 模型与事件桥接 | 5–7 | reasoning、用量、脱敏、NDJSON、终态映射 |
| 工具治理与桥接持久状态 | 7–10 | callId 去重、审批、版本检查、故障/重传/超时、预算 |
| 兼容回归与质量评测 | 5–8 | 旧测试与新引擎契约、代表性问题对比、浏览器回归 |
| 部署、灰度、回滚与文档 | 4–6 | 双进程部署、健康检查、恢复演练、交接 |
| **合计** | **30–45** | 当前能力等价，不包含新增产品功能 |

路线 B 另需迁移身份与资源管理、Store/加密/备份、调度与 Runbook、通知事务/重试和全部接口行为，预计总计 65–95 人日。路线 C 再增加约 25–35 人日前端重做与验收。不是按 AgentScope 示例代码量计价。

如内部综合人日成本为 `D` 元：路线 A 人力约 `30D–45D`，B 为 `65D–95D`，C 为 `90D–130D`。例如 **假设** D=2,000 元，则分别约 6–9 万、13–19 万、18–26 万元；这是换算示例，不是外包报价。

运行成本变化：

- 框架采用 Apache-2.0，自托管框架本身无按调用授权费；模型、机器、数据库和观测服务另计。
- A 首期每 run 冷启动的历史 fixture 基线：30 个同时到达请求、最多 2 个活跃，legacy P95 2477ms，AgentScope cold P95 11065ms，均 30/30 成功，约 4.5 倍排队端到端延迟。第二期增加有界预加载池，每个父进程最多服务一个独立子进程，摊薄 SDK 导入成本；CPU/RSS、镜像大小和新的三模式基准见 [验证记录](verification.md)。不要求 Redis 或向量库，也没有宣称独立 RPC 延迟或真实供应商容量已测定。
- 同模型、同上下文和同调用次数时，换框架不会天然降低 token 成本。模型成本按输入/输出 token 单价分别计算，再叠加重试、摘要/压缩、Embedding 与多 Agent 的调用。
- 多 Agent 可提高分工能力，也会增加调用与协调成本，不能预设诊断质量更高。先改善确定性数据获取、证据和评测，再按收益引入。
- 需要长期维护 Node/Python 两套依赖与桥接协议；若团队坚持单语言后端，应把这一维护成本与路线 B 的一次性重写成本一起比较。

## 7. 分阶段计划与放行条件

| 阶段 | 工作 | 完成门槛 |
| --- | --- | --- |
| P0：PoC | Python 隔离环境固定 `agentscope==2.0.8`；本地模型/MCP fixture；模型出口与外部工具事件 | 两种协议往返；六次硬上限；只读闭环；越权拒绝；待审批立即结束；取消、重复事件、Worker 中断正确收尾 |
| P1：兼容内核 | 拆出 LegacyRuntime，接入新 Worker，统一事件、用量、来源与持久去重 | 现有 58 项回归仍通过；相关契约对两个运行时分别覆盖；调度/Runbook/通知未绕过原执行层 |
| 第二期部署准备（新增） | 针对 P1 冷启动成本实现 prefork，补齐生命周期、就绪/资源指标、容器、审计和评测工具 | 跨用户隔离与故障/取消不重放；有界资源、两种 Worker 模式回归；部署与性能证据可复现 |
| 第三期本地治理（新增） | MCP 失败持久提示、30 场景 DTS 双引擎评测、换钥后审批/unknown/回退、镜像扫描与 SBOM | 本地确定性断言和容器门禁已过；真实质量、人审、残余漏洞处置与目标部署单列验收 |
| P2：只读灰度 | 优先现有 DTS 状态查询子领域；保持 general/cn_east 授权，任务 ID 仍为字符串 | 新引擎真实协议、模型回答、tool_steps、来源、巡检判定和通知内容一致；没有扩大 DTS 范围 |
| P3：生产治理验证 | 对 fixture 演练审批、写后未知、核验、重启、撤权、预算与回滚 | 越权/重复写/无证据判正常均为 0；未知结果不重放；审批由另一管理员完成 |
| P4：独立增强 | 按需评估上下文压缩、RAG、结构化报告、多 Agent | 每项独立基准和开关，不与首次迁移捆绑 |

P4 本轮落地的是可直接评估的三个子项：确定性的完整轮次预算裁剪（不额外调用模型生成摘要）、授权候选多文档非重叠选择（无向量服务）和基于持久步骤的证据快照（不替代诊断或健康判定）。五组开关对照 × 三类历史 × 两引擎的 30 项断言通过；中等历史样本请求体由 24744 降至 15392 字节，减少 37.8%，调用次数不变；特定多文档语料覆盖由一份提升到三份。固定 fixture 不证明真实 token 节约或答案质量。默认回归 81/81、cold/prefork 各 98/98；详情见 verification。

多 Agent、模型摘要和语义向量检索仍需明确问题集与真实质量收益后再实施，不属于本轮已完成能力。第四期 [方案](../openspec/changes/agent-evidence-enhancements/proposal.md)、[设计](../openspec/changes/agent-evidence-enhancements/design.md) 和 [需求](../openspec/changes/agent-evidence-enhancements/specs/agent-evidence/spec.md) 独立记录，不把第三期外部上线验收自动勾选。

建议 PoC 使用 30 个代表性问题，每个运行时重复 3 次，覆盖中文 DTS 诊断、引用、无知识、缺失/陈旧证据、工具不可用、跨区域、长 ID、长历史与写审批。固定模型、温度、工具数据和权限，记录真实调用链、答案判分、token 与延迟。

建议生产决策阈值（真实环境仍需确认和测量）：所有确定性安全断言通过；任务成功率相对基线下降不超过 5 个百分点；token 中位数与端到端 P95 延迟不超过基线约 1.2 倍，超出则用实际质量收益解释。首期 cold 超过门槛，第二期 `agent:benchmark` 顺序实测 prefork P95 2775ms、legacy 2463ms，为 1.127 倍，本地样本达到建议门槛；cold 同轮为 11021ms，完整边界见 verification。这是第二期历史基准。第三期 `agent:eval:dts -- --repeat 3` 对 30 个合成 DTS 场景完成两引擎各 90/90，覆盖长 ID、范围、数据新鲜度与缺失、错误及多轮；每条均输出待人工审阅标准。该语料含故障和进程重建，不用于稳定负载 1.2 倍门槛。真实模型模式仍需显式运行并人审，尚未评价真实根因诊断、引用准确率、长历史和 token 费用。因此仍交付可选路径，有限样本不构成全量生产放行。

真实环境验收需要后续明确的执行范围与测试资源；本次调研没有查询 DTS、启用任务或向企业微信发送消息。

### 首批必须验证的边界

- 发布状态、资源绑定交集、公开 Agent 引用私有知识、普通成员跨会话访问、执行前撤权。
- Responses 工具往返、encrypted reasoning 续传、异常/截断、用量缺失回退与模型费用记账。
- 原始错误 JSON、大 ID、Schema 变更、工具名映射碰撞；同一个 callId 重传和同 ID 不同参数。
- 实际 HTTP 发送前/后 Worker 崩溃、取消、Node 重启、待审批过期；副作用不因自动重试或回滚重复发生。
- 巡检只读取工具台账；模型声称正常、旧缓存、失败或陈旧数据不能替代本轮证据。
- 任务与通知事件同事务；至少一次投递、重发沿用事件、不重新巡检；双调度器不同时启用。
- Python 日志/trace/状态与模型出口无凭据泄漏；不同用户、会话与运行时之间无状态串用。
- 旧会话可回读、现有 ZIP 包可下载、来源修订与审批台账保留；回滚前后 schema 与引擎版本兼容。

## 8. 什么情况下不应继续

若 PoC 发现模型消息映射必须依赖大面积修改框架私有方法、外部执行无法保留原始参数、调用预算不能覆盖总结/压缩/重试，或必须把生产 MCP 凭据交给无治理的 Worker 才能跑通，应暂停迁移，重新评估接口设计。

若未来半年仍以少量只读状态工具和固定巡检为主，应以真实诊断评测和可靠证据获取的收益决定是否扩大框架使用。第三期已补齐 MCP 失败持久摘要与本地 DTS 语料；后续仍需真实质量数据。AgentScope 的选型理由应是后续 Agent 能力的持续建设成本，而不只是减少当前循环代码。

候选变更说明、设计约束、需求场景和实施清单见 [OpenSpec proposal](../openspec/changes/agentscope-runtime-migration/proposal.md)、[design](../openspec/changes/agentscope-runtime-migration/design.md)、[spec](../openspec/changes/agentscope-runtime-migration/specs/agent-runtime/spec.md)、[tasks](../openspec/changes/agentscope-runtime-migration/tasks.md)。本机未找到 OpenSpec skill；沿用现有目录惯例，未运行 OpenSpec CLI 验证。

## 9. 可核对来源

所有外部来源访问日期为 2026-09-24；固定版本页面优先于持续变化的首页或开发版说明。

- [S1：官方 v2.0.8 发布记录](https://github.com/agentscope-ai/agentscope/releases/tag/v2.0.8)、[固定提交](https://github.com/agentscope-ai/agentscope/commit/c7d8e31bfd0a2f85e67b6235bd44c09fce259106)。
- [S2：依赖、Python 版本和许可证声明](https://github.com/agentscope-ai/agentscope/blob/v2.0.8/pyproject.toml)。
- [S3：2.0 与 1.0 的接口差异](https://docs.agentscope.io/en/versions/2.0.8/others/change-log)。该页的迁移时期 RAG 展望不作为 2.0.8 缺少 RAG 的证据，以当前版本能力文档/实现为准。
- [S4：HITL 与外部工具执行](https://docs.agentscope.io/en/versions/2.0.8/building-blocks/agent/human-in-the-loop)。
- [S5：运行、终态、额外总结与状态持久化](https://docs.agentscope.io/en/versions/2.0.8/building-blocks/agent/run-agent)。
- [S6：Skill 加载行为](https://docs.agentscope.io/en/versions/2.0.8/building-blocks/tool/skill)、[MCP 接入](https://docs.agentscope.io/en/versions/2.0.8/building-blocks/tool/mcp)。
- [S7：Agent Service，认证、消息总线、定时器所有权与部署限制](https://docs.agentscope.io/en/versions/2.0.8/deploy/agent-service)。
- [S8：资源共享及外部身份模型](https://docs.agentscope.io/en/versions/2.0.8/deploy/sharing)。
- [S9：模型适配与自定义 ChatModelBase](https://docs.agentscope.io/en/versions/2.0.8/building-blocks/model/llm)、[中间件](https://docs.agentscope.io/en/versions/2.0.8/building-blocks/middleware)。
- [S10：Agent 外部调用、参数修复与权限执行源码](https://github.com/agentscope-ai/agentscope/blob/v2.0.8/src/agentscope/agent/_agent.py)、[权限引擎](https://github.com/agentscope-ai/agentscope/blob/v2.0.8/src/agentscope/permission/_engine.py)。
- [S11：Agent 默认配置](https://github.com/agentscope-ai/agentscope/blob/v2.0.8/src/agentscope/agent/_config.py)、[Responses 模型实现](https://github.com/agentscope-ai/agentscope/blob/v2.0.8/src/agentscope/model/_openai_response/_model.py)。
- [S12：SQL 存储与凭据序列化调用路径](https://github.com/agentscope-ai/agentscope/blob/v2.0.8/src/agentscope/app/storage/_sql/_storage.py)。
- [S13：官方 2.0.8 能力总览](https://github.com/agentscope-ai/agentscope/blob/v2.0.8/README.md)、[渠道说明](https://docs.agentscope.io/en/versions/2.0.8/deploy/channel/overview)。

本项目依据：[后端地图](../server/codemap.md)、[Agent](../server/agent.mjs)、[执行治理](../server/execution.mjs)、[模型](../server/model.mjs)、[巡检判定](../server/inspection.mjs)、[调度](../server/scheduler.mjs)、[通知](../server/notifications.mjs)、[DTS 交接](../integrations/dts-mcp/HANDOFF.md)、[本次验证记录](verification.md)。
