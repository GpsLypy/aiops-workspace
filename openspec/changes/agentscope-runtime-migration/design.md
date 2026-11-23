# 运行时边界与迁移设计

> 历史阶段记录：其中双引擎/legacy 路由已由 2026-09-29 的 [AgentScope 唯一运行时变更](../agentscope-only-runtime/design.md) 取代；旧测试结果仅代表当时版本。

本文件描述首期兼容、第二期预加载/部署准备与 2026-09-27 第三期本地治理验证；生产部署与真实灰度仍待验收。详细映射与来源以 [调研报告](../../../docs/agentscope-assessment.md) 为准，安装和协议边界见 [运行指南](../../../docs/agentscope-runtime.md)。

## 架构决定

1. Node 是业务状态、身份、资源与执行治理的唯一权威；Python Worker 只承担推理编排。
2. 从 `server/agent.mjs` 中分离会话/API 外壳与 AgentRuntime。LegacyRuntime 与 AgentScopeRuntime 接收同一份经授权准备的上下文。
3. 首期使用 AgentScope SDK，部署独立 Worker；不直接替换为官方 Agent Service。完整服务的认证、数据模型、SSE 和调度行为与本项目不同。
4. 所有真实工具经 `execution.callStep`。用 `is_external_tool=True`、`RequireExternalExecutionEvent` 与 `ExternalExecutionResultEvent` 完成外部执行闭环。
5. Python 端权限仅允许对本 run 目录发出请求；业务授权仍由 Node 当前状态决定。不给模型授权更改权限规则的能力，不使用全局 BYPASS。
6. 自定义 ChatModelBase 桥接现有模型模块，保留出口与密钥管理。Node 保留唯一原始消息列表及 Responses reasoning；Worker 只请求下一次模型调用，不覆盖消息。已完成 fixture 往返验证。

## 运行协议

首期为每 run 一个 Python 子进程与私有 stdio，无内部 HTTP 端口。start/model/tool/finish 携带 version、runId、请求序号，工具请求另有 replyId/callId。上下文、工具目录由 Node 生成；Worker 不传任意 URL/Key，不自行指定业务资源或用户。可信父进程管道替代网络凭证；截止时间在 Node 强制执行并终止进程。未来独立远端 Worker 必须增加服务认证与短期 run 凭证。

工具参数必须保留原始文本并由 Node 严格 JSON/Schema 校验。模型工具名仅是 Node 冻结目录的别名，不能从 Worker 接受新的工具授权。结果由 Node 保存后回填，Worker 不能写 tool_steps 或伪造巡检证据。

schema v5 在 tool_steps 增加 call_key/call_hash/response_encrypted，以 `(run_id,call_key)` 唯一索引实现 `(runId, replyId, callId)` 映射；身份与步骤同一 INSERT 写入。同标识同参数返回原待审批状态或加密保存的成功响应；执行中/失败/unknown 不重放；参数或版本不同拒绝。模型 call ID 加轮次前缀，避免供应商跨轮重复 ID 冲突。新增密文纳入备份/轮换。

## 状态与限制

每个 run 重新装配近 30 条历史。首期不做跨轮 AgentState 迁移或长期记忆，关闭压缩/压缩工具/状态注入/重试。Node 持有会话租约与执行状态；Worker state 仅维持当前运行。

每次实际模型调用由 Node 统一检查/记账，包括框架重试、到上限总结、结构化额外迭代和压缩。保留总调用上限及 120 秒执行预算，不能只设置 max_iters。工具按原有顺序执行，单批次最多 12 个。

待审批即持久化并结束本次聊天；Worker 停止，不执行后续工具。现有审批 API 完成独立执行与核验，首期不自动续聊。None 终态代表等待；error/interrupted/exceed_max_iters 不映射为成功。

## 失败与回滚

Node/Worker 断开、取消或重启后，不自动重播可能产生副作用的请求。远端调用已发出但结果不确定时沿用 unknown 与只读对账。不得用另一运行时重新执行在途 run。

新增持久数据通过显式 schema v5 迁移；Python 不直接写 SQLite。新版本同时包含旧引擎路径，灰度按子领域选择，run 开始后固定运行时。旧二进制可能拒绝新 schema，回滚须选择兼容构建或事先演练的数据库恢复流程，不能只切换环境变量。

## 数据与部署

React、通知事务、任务调度、审计和 DTS MCP 保留；运行时标识与桥接状态是新增数据。Python 仅从 Node 获得授权上下文，不从环境继承凭据；stdout 是管道协议，stderr 有界丢弃，错误使用固定文本。进程临时目录与清理后的环境不等同系统沙箱，同用户文件和网络权限须由部署环境约束。

依赖固定 Python 3.12、AgentScope 2.0.8 及 uv.lock。agent:check 使用本地 SDK/外部工具探针；进程关闭等待回调清理，异常不自动回退。保持单 Node 调度源；引入完整 Agent Service 时也不能双开定时器。默认镜像为 legacy，第二期新增 opt-in agentscope 目标与 Compose 资源限额。首期每 run 冷启动有明显延迟成本，第二期以预加载优化，平台仍默认 legacy。

## 第二期实施决定（2026-09-26）

用户授权继续第二期直至完成开发。本期将第一期每轮冷启动升级为可配置的预加载进程池：POSIX 父进程仅加载固定 SDK，收到不含业务内容的 lease/runId 后 fork 子进程；Node 在 leased 确认后才向子进程发送上下文。父进程不读取业务消息或结果，子进程结束并被 wait4 回收后才发布 ready，再分配下一轮。保留 cold 模式以回退。本期不把在同一个 Python Agent/事件循环上 reset 当作隔离。

进程池按应用实例持有，数量/等待队列/启动超时/最大使用次数有界；取消或协议错误销毁对应进程组、等待 Node 回调清理，不重放本轮。后续新任务可以使用新建的预加载进程；连续启动失败退避，停止应用时关闭全部子进程与定时器。可观测性暴露预加载/忙碌/排队/完成/故障/回收数与进程资源样本，不记录原始上下文。

API 入口在监听前预热；readiness 纳入选中运行时的可用性，探针验证真实 SDK 工具往返。提供可选 Python+Node 容器构建目标、Compose 配置、依赖审计入口和可复现三模式性能对比。验收包括跨用户/跨 run 状态、队列取消、主动回收、崩溃/关闭进程组、双协议、审批、巡检与通知全链路。

真实供应商质量、真实 DTS 灰度、目标生产切换与远程 CI 仍需对应环境；本期以可重复的本地实现与验收证据交付，不以 fixture 代替外部验收。

## 第三期收敛（2026-09-27）

本期落实 P3 生产治理验收在本仓库可完成的开发部分，并补齐前两期发现的具体缺口：

1. MCP 发现失败由原先仅进度提示改为独立的持久 `metadata.mcpFailures`（资源 ID、服务名称、阶段、固定错误码/说明），写入成功、待审批与错误消息。失败服务也进入本轮模型系统上下文，明确未取得实时证据。它不是一次工具执行，不创建 tool_steps；原始异常、地址与凭据不出现在记录中。聊天展示单独的故障说明，刷新可回看；取消/超时直接终止，不继续模型。
2. 双引擎评测从四个简单工具选择问题扩充到代表性 DTS 只读场景，覆盖长 ID、范围、缺失/陈旧/未来数据、拒绝、工具不可用和多轮。固定输入与本地 HTTP/MCP、持久证据/巡检结论及用量统计用于确定性回归，真实模型模式明确区分人工质量验收，不能仅凭没调用工具判为安全回答。
3. 增加从新目录加密恢复/密钥轮换后，AgentScope 与 legacy 兼容构建读取历史、处理待审批及 unknown 只读对账的演练；检查不重放副作用。
4. AgentScope 镜像纳入 OS/Python/Node 漏洞扫描与 SBOM 产物，先固定本地镜像 ID，检查覆盖并记录架构。扫描失败或存在可修复 HIGH/CRITICAL 阻断；完整报告保留其余告警，生产安全接受状态保持 false。移除运行时不需要的 npm/pip，不改变应用依赖与 SDK 锁；容器入口与维护命令直接使用 Node。剩余基础包未修复漏洞需单独审核，不能把扫描门禁通过当作完整安全验收。

沿用现有 OpenSpec 文件同步需求/清单；本机仍无 OpenSpec skill。默认 legacy 与生产资源保持原配置。开发验收不启动真实任务或发送真实通知；真实模型费用/质量、DTS 现场灰度和目标生产部署保留为独立外部证据，不宣称已完成。
