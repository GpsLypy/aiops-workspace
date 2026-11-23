## ADDED Requirements

### Requirement: 所有模型调用仅使用Responses SSE
系统 SHALL 对聊天、任务、连接测试及独立复核固定请求 `/responses`、`stream:true` 和 `Accept:text/event-stream`，不提供完整响应模式、JSON回退或非流式开关。

#### Scenario: 内部连接测试和复核
- **WHEN** 内部模型调用没有公开增量回调
- **THEN** 仍通过SSE接收；复核通过前不发布候选正文或复核增量

### Requirement: 拒绝非SSE并核验完整终态
系统 SHALL 仅接收text/event-stream媒体类型（可带charset参数），非SSE取消响应体并报错；合法response.completed、status=completed及有效output才认定成功。

#### Scenario: 完整JSON或断流
- **WHEN** 供应商返回带completed的JSON，或SSE缺少终态/取消/failed/incomplete
- **THEN** 执行失败，不重试或降级、不持久化草稿、不自动重放已执行工具

### Requirement: 当前真实验收与历史证据分开
系统 SHALL 单独记录当前源码、真实SSE工具步骤、终态与持久回读，不用历史完整JSON成功替代当前SSE验收。

#### Scenario: 发布验证结果
- **WHEN** 当前部署完成真实SSE模型与DTS往返
- **THEN** 保留该轮真实步骤/增量/完成/回读证据，并明确单次成功不代表连续稳定性通过
