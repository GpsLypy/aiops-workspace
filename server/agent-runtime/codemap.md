# Agent 运行时地图

| 文件 | 职责 |
| --- | --- |
| index.mjs | 运行时与第四期增强配置校验、Node 原始消息、预算/用量、六轮工具往返上限、工具批次/别名与原始参数匹配 |
| protocol.mjs | 两种传输共用 v1 会话校验、响应缓存、请求顺序与权威终态 |
| agentscope.mjs | cold 私有 stdio 子进程、取消/退出/大小与背压限制 |
| pool.mjs | POSIX 预加载父进程池，v2 lease/leased/ready、有界 FIFO、退避/回收、进程组清理与资源计数 |
| driver.mjs | 装配 AgentScope cold/prefork，统一 warmup/run/health/close 与版本 |
| probe.mjs | 真实 SDK 的本地模型/外部工具探针，无数据库与供应商请求 |

`agent.mjs` 准备授权上下文并固定本轮增强配置，所有对话均进入 AgentScope，`index.mjs` 暴露 model/tool 回调。Python 仅编排，通过回调复用 `model.mjs` 和 `execution.callStep`；资源授权在 `agent.mjs` 与 execution 再次校验。真实 Responses reasoning 始终在 Node 原始消息中。

普通聊天启用 streamText：Node 在等待完整模型消息期间直接向聊天连接发送 message_start/delta/reset；工具参数聚合完成后仍按原流程校验、交由 Worker 编排。工具阶段清除暂显正文，模型终态校验通过后才返回完整消息给 Worker。独立复核的分析与 reviewer 均不公开文本增量，保留复核通过后才发布的门禁。cold/prefork 私有协议不变，Worker 的 stream=False 只描述本地桥接返回方式，不代表上游 HTTP 未流式读取。

第四期独立增强在 Node 外壳完成：agent-context 仅裁剪初始历史，retrieval 选择多文档片段，evidence-report 从台账生成证据快照。进入 runRuntime 后不裁剪当轮原始调用、工具输出或 reasoning，也不增加模型调用；三个开关默认基础行为，兼容 cold/prefork 两种 Worker 模式。

工具身份由 AgentScope reply ID 与按模型轮次限定的 call ID 组成；持久唯一约束在 `tool_steps`，不新建第二张映射表。协议规范、部署与状态说明见 [运行指南](../../docs/agentscope-runtime.md)。

第六期复用 runRuntime 的 maxModelCalls、stats 与 beforeModel：分析最多五次、复核一次，使用两个独立 Worker 上下文和同一执行额度。复核传空工具列表并拒绝模型工具尝试；阶段局部 AbortController 在 Worker 故障时终止挂起模型请求。复核流程自身没有第三 Agent 或自主委派；独立的聊天委派通道见下文。

只有 Agent 对话调用本目录运行时；MCP 直接测试、执行中心固定工具和固定 Runbook 使用 Node 持久治理执行器，执行记录为 direct / 1，不把它们标记为使用过 AgentScope。Agent 产生的待审批步骤保持原 agentscope 标记，审批执行固定计划时不重启对话或重放模型。

测试：`tests/agent-runtime.test.mjs` 验证故障管道、去重、迁移和备份；`tests/agent-pool-protocol.test.mjs` 用 Node 协议对端检查 v2 边界，管道故障测试无需 Python，包含真实应用的测试使用已安装 SDK。`tests/agentscope/runtime.test.mjs` 与 `pool.test.mjs` 使用真实锁定 SDK，覆盖隔离、取消、崩溃、回收、队列与运维接口。`npm run test:agentscope` 同时重跑所有原业务测试。

第五期上层 agent-rollout 复用 driver 创建独立预检实例，探针后关闭；主 driver 不随暂停关闭，以保留在途语义。每轮 runtimePolicy 固定增强配置，runtime 永远为 agentscope；暂停或作用域外的新轮次使用基础增强配置。readyz 始终预热并检查主 Worker，SDK 不可用时失败，绝不回退或重放。AGENT_RUNTIME 只接受 agentscope；旧 AGENTSCOPE_AGENT_IDS / 非空 agentIds 配置启动即失败，管理策略中的 agentIds 只限定增强作用域。

2026-10-03：runRuntime 新增可选 onModel 观测回调，围绕实际模型请求报告开始、终态、轮次和用量，供问答全景使用；不向 UI 暴露原始消息/工具参数/模型推理，不改 Python 协议。

2026-10-05：completion以本次配置快照回传最小模型身份，runRuntime在开始/结束/失败观测中复用该名称；等待响应期间设置变化不再改写trace。后续请求仍可使用新配置，未冻结整轮设置或暴露凭据。

2026-10-08：cold/prefork 启动环境将 TMPDIR 设为私有工作目录；prefork 子进程在每轮创建目录后重置 Python tempfile 缓存，结束回收目录。该措施只限制临时文件归属，不隔离同一 UID 的文件或网络权限。

同日续轮：模型回调将全景节点的可选 W3C `traceparent` 传给 Node completion；默认关闭传播，不改变 Python 协议、工具参数或模型正文。

2026-10-10：当前未完成Responses请求最多重试五次；每次尝试默认等待首个数据块90秒，之后允许连续静默180秒，管理员可在模型设置中调整，静默可填0禁用，整轮超时仍独立生效。runRuntime每次恢复重新核对访问、按失败估算计入用量、记录实际网络尝试；工具往返轮数单独计数。旧工具结果留在Node规范上下文，恢复不调用工具；message_reset/start携带reason=retry，每次尝试独立streamId；model_retry区分waiting/connecting、固定原因/次数/延迟，超时还携带first_byte/stream_idle及秒数，等待前通知，正常正文或进度恢复后撤下；前端仅重置队列并保留已打印正文，progress保留兼容提示。独立复核也转发恢复状态，但不发布候选正文；工具阶段仍使用未带reason的reset撤下草稿。独立复核仍限一轮候选判定，但允许这一轮最多五次重试。

2026-10-09：runRuntime 接受可选 model_reasoning_effort 并传给 completion；上层 agent 固定本轮有效值，reviewAnswer 复用同值，Python 桥接协议保持 v1/v2，不向 Worker 传递额外推理内容。

2026-10-10：独立复核之外，显式开启委派时runRuntime支持runtimeRunId、beforeRound和真实预算观测；createDelegationDriver跨父执行有界运行cold子Worker，避免主prefork槽位嵌套死锁。每个子任务3轮，主子共享12轮上限及executiontoken预留。子工具只读交集、目标绑定与持久调用身份继续由Node治理。
