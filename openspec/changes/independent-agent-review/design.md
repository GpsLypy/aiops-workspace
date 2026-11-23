# 固定双 Agent 流程

1. `POST /api/chat` 接收 `reviewMode=off|independent`，默认 off；字段纳入既有执行输入摘要与幂等冲突判断。仅当前请求生效，不隐式更改子领域、定时任务或增强灰度。
2. 分析 Agent 复用现有授权、Skill、知识、工具、审批、持久调用身份和 AgentScope Worker。off 最多六次模型请求；independent 最多五次，给复核保留一次。
3. Node 构造新复核上下文：原问题、分析实际收到的文本历史、引用资料、本轮工具原始调用与模型实际见到的输出、持久步骤状态、发现缺口和候选答复。历史仅作背景，不能当本轮证据；不复制分析系统指令、Skill 指令、工具定义和 Responses reasoning。全部内容视为待核实数据，仍经既有出口脱敏/阻断策略。输入不能完整装入预算则不裁剪证据，不调用复核，不发布候选答复。
4. 复核前再次检查用户、子领域与已选资源权限/版本。新 Worker 无工具，独立消息列表，通过同一模型模块与 execution token 台账计费，共用本轮超时/取消。调用失败不重试模型/工具，不返回未复核候选答复。
5. 复核 JSON 仅允许 `verdict=pass|block` 与枚举 `reasons`，拒绝额外字段、Markdown 包裹、矛盾 verdict、未知/重复原因。pass 空原因才接受；block 必须非空。无效输出/工具调用/模型故障返回 unavailable。取消与权限撤销保留现有失败语义。
6. `metadata.agentReview.version=1` 保存 mode、status、reasons 和 analyst/reviewer 的 modelCalls/tokens。审批为 skipped，复核拒绝为 blocked，异常为 unavailable，通过为 accepted。仅 accepted 发布分析文本；其余固定文案，候选答复与复核原始输出不持久化到聊天。阶段记录和审计不包含原始证据正文。
7. 前端默认关闭开关；显示额外调用/耗时提示和两个阶段的实际统计；原生 details 支持键盘、刷新回看、JSON 导出。复核不标为业务健康或人工批准。

两次 Worker 调用属于同一个持久 run，没有新表/迁移。单实例已有 Worker 池顺序调度两个阶段；不并行扩大并发槽位、不跨会话存 Agent 状态。当前模型供应商配置不提供不同 reviewer 模型，独立指上下文/权限而非模型家族。

复核出口逐层检查内嵌 JSON 字符串，保留未修改证据和 int64 数字字面量，超过 12 层停止复核；block 策略阻断时不请求 reviewer。此保护不改变通用分析模型的历史出口实现。复核 Worker 故障通过阶段局部 AbortController 取消挂起模型请求，避免占用整轮超时；用户取消仍作用于整个 run。UI 在当前挂载会话保留开关选择，新会话/刷新复位，持久结果不随开关变化。

DTS 源码核对沿用单任务 getstatus，不新增上游工具或权限。新鲜度评测将查询 state/freshness 与最终巡检 inspectedAt/expectedAssessment 分开记录；最终预期由最后 run 的持久 reported_at 独立计算，60.000 秒仍可新鲜、60.001 秒为 unknown，不修改实际 inspection 阈值。暂停和 worker 延迟不等同故障/全链路延迟，缺少 HA 字段时保留未知。

验证：本地模型/MCP fixture + 真实锁定 SDK；cold/prefork 全量、Chat Completions/Responses、取消/失败/幂等/审批/预算/隔离、浏览器桌面与320px。DTS 时间边界须区分查询时与最终巡检时点。真实模型质量收益与生产业务复验单独列为待验收。
