# AgentScope 唯一运行时

2026-09-29 用户要求彻底移除可替换旧实现，所有 Agent 统一使用 AgentScope。删除旧模型/工具循环、双引擎路由、legacy 部署目标与旧引擎评测基线。Python 3.12 / AgentScope 2.0.8 为必需运行依赖。

保留平台业务职责：权限、发布、模型出口、持久审批、执行幂等、巡检证据、通知、固定 Runbook、SQLite 与历史记录。它们不属于可直接替换的旧 Agent 循环。使用真实 SDK 验证，不引入测试专用旧引擎。

本机未找到 OpenSpec skill，沿用现有目录结构；未声明 OpenSpec CLI 校验。
