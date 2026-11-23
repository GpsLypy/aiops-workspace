# 唯一运行时边界与升级

## 编排与治理

所有新聊天、通用 Agent、子领域及定时任务调用同一 AgentScope SDK。删除 legacy.mjs、runtime 分支与无 Python driver。cold/prefork 只改变进程生命周期；模型与工具仍通过 Node 权限、预算、出口、Schema、持久执行和审批回调。失败、取消与 unknown 不重放。

固定工具调用、审批后的执行和 Runbook 没有模型编排，继续直接调用治理执行器；新固定工具执行标记为 direct/1，不能冒称经过 SDK。新聊天执行为 agentscope，运行时版本在实际执行时保存；历史 legacy 记录、审计及 v5 迁移中的历史默认值保留，不伪造历史。

## 配置与增强

省略 AGENT_RUNTIME 等价于 agentscope。显式 legacy 或其他运行时值拒绝启动，非空 AGENTSCOPE_AGENT_IDS/内部旧 agentIds 配置拒绝并提示迁移。Compose 将显式旧值传给校验，不能静默丢弃白名单后扩大运行范围。

settings.agent:rollout/API 路径保留，草稿 agentIds/includeGeneral 只控制三项增强；deployment 不再返回运行时白名单。active 的范围外与 paused 均为 AgentScope + recent/ranked/false。旧 active/paused 持久策略读入后也遵循此语义，历史消息不改写。CAS、独立 SDK 预检、有效期、资源发布校验、异步撤权和每轮策略快照保留。预热与 readiness 始终依赖 Worker，暂停增强不能掩盖故障。

## 部署、评测和验证

默认 Docker/Compose 包含 Node、Python 和冻结 SDK，删除可选覆盖文件与 Node-only 最终镜像。npm test 先做真实 SDK 探针，再运行完整 tests 和 tests/agentscope；缺依赖失败而非跳过。CI 对 cold/prefork 分别验证。

DTS 报告 version=3，每条固定 runtime=agentscope 并显式记录 workerMode，比较同 SDK prefork/cold；复核/汇总 version=2，key=agentscope/{workerMode}/{caseId}/{iteration}。旧评测报告拒绝作为当前验收，真实模型、证据与人工复核门槛不放宽。增强评测为一个 AS Worker 模式下的 15 组，不伪造 legacy 基线。

源码安装需 uv sync --project agent-worker --frozen。升级前清理旧运行时配置；不修改业务凭据或授权资源。既有真实模型目标替换/时间边界缺陷不因替换运行时自动解决，详见 docs/verification.md。
