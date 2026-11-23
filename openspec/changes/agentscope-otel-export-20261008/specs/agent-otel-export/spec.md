# Agent 链路导出需求

## ADDED Requirements

### Requirement: 默认关闭与部署配置

系统 MUST 默认不发送 OTLP 记录或出站 `traceparent`，且 MUST 只允许可信部署配置启用出口、采样与传播。

#### Scenario: 未配置 Collector

- WHEN 用户完成一轮 Agent 问答且部署没有配置 OTLP endpoint 或传播开关
- THEN 本地全景照常保存，但没有外部导出或新出站追踪头

### Requirement: 有界脱敏的标准 OTLP 树

导出 MUST 复用已完成全景的 trace/span ID，仅发送固定阶段、固定结果、时间和固定服务属性；MUST NOT 发送用户问题、回答、用户/运行 ID、模型/工具/资源名、参数/返回、凭据、summary/details 或私有推理。OTLP/HTTP JSON trace/span ID MUST 为目标 traces 接收器接受的十六进制形式，并使每个非根导出 span 的父 ID 在同一导出树内存在。

#### Scenario: 本地父节点未导出

- WHEN 一个模型或工具节点的原父节点是只存本地的上下文节点
- THEN 出口将该子节点连到最近已导出的祖先，Collector 可解析完整树且不收到上下文详情

### Requirement: 可选出站上下文

启用传播时，Agent 的实际模型和 MCP 发现/工具请求 MUST 使用相应本地节点的 W3C `traceparent`；未配置该开关的请求 MUST NOT 自动附加该头。系统 MUST NOT 从用户请求继承未验证的入站父上下文。

#### Scenario: 同轮模型与 MCP 调用

- WHEN 部署开启传播且 Agent 先发模型请求再执行已授权只读工具
- THEN 两个出站请求使用同一 trace ID 和各自节点的 span ID，采样标志与本轮判断一致

### Requirement: 采样与失败隔离

采样 MUST 以同一 trace ID 对整轮做稳定判断；无外部发送的轮次仍保留本地全景与指标。Collector 超时、拒绝、队列满或关闭 MUST NOT 改变业务结果、readiness、工具重放与权限门禁。出口 MUST 使用既有目的地限制、有界等待和内存队列；发送、失败、丢弃、采样跳过计数 MUST 为固定低基数指标。

#### Scenario: Collector 失败或积压

- WHEN Collector 返回 503、挂起或队列超过上限
- THEN Agent 结果和持久步骤照常完成，出口只累积固定失败或丢弃计数，不重试业务调用
