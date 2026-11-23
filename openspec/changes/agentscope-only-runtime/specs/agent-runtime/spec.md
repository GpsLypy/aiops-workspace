# AgentScope 唯一运行时规格

## Requirement: 所有 Agent 使用真实 SDK

- GIVEN 合法聊天、通用 Agent、子领域或定时任务
- WHEN 执行开始，无论增强策略为 deployment/active/paused
- THEN 由 AgentScope 2.0.8 编排，保存 agentscope 和 SDK bridge 版本
- AND 不存在旧循环、静默回退或失败后重放

## Requirement: 配置失败显式

- WHEN 显式配置 legacy、未知运行时或非空旧运行时白名单
- THEN 在打开业务数据库前失败并提示清理配置
- WHEN Python/SDK 不可用
- THEN 启动/就绪/默认测试失败，增强暂停不绕过 Worker

## Requirement: 持久业务证据不伪造

- GIVEN 升级前的 legacy 记录、审批计划和 unknown
- THEN 历史标签保持原值，审批和只读对账继续可用且不重放
- AND 新固定工具/Runbook 标记 direct，聊天标记 agentscope

## Requirement: 增强独立于运行时

- WHEN 管理员保存/预检/启用/暂停增强
- THEN 保留修订、权限、资源和有效期门禁；新轮次固定策略
- AND 作用范围只改变上下文、检索和报告，范围外仍使用 SDK

## Requirement: 评测不冒用旧基线

- THEN 新报告显式标记同 SDK cold/prefork、版本升级、摘要绑定
- AND 拒绝旧版评测用于当前验收，fixture 与 pending 人工记录不通过
