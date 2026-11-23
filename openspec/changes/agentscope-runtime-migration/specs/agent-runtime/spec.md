# AgentRuntime 兼容需求

状态：2026-09-27 已实现首期兼容、第二期预加载/部署准备和第三期本地治理验证；真实模型、DTS 灰度、残余镜像漏洞及生产容量尚未验收。以下 MUST 为持续兼容要求，证据与未完成项见 tasks.md 和 docs/verification.md。

## ADDED Requirements

### Requirement: 稳定业务契约

系统 MUST 在新旧运行时下保持现有 `/api/chat`、NDJSON、会话权限、来源、工具摘要和任务执行入口。

#### Scenario: 新运行时完成只读对话

- WHEN 同一已授权用户通过现有客户端提出问题
- THEN Node 创建唯一 execution，Worker 请求工具，Node 持久化实际结果与最终会话后发 done
- AND 前端继续通过现有会话接口回读，来源/工具摘要可追踪到本轮证据

### Requirement: 不扩大工具与资源权限

系统 MUST 在实际调用前复核身份、资源权限、发布/启用状态、配置版本、环境、参数和 Schema；Worker 无权决定用户或新增资源授权。

#### Scenario: 运行中撤销权限

- WHEN 工具目录生成后用户或资源权限被撤销
- THEN 后续调用被 Node 拒绝且不产生远端副作用

#### Scenario: 原始参数无效

- WHEN 模型输出错误 JSON、数值类型 DTS jobid 或越界区域
- THEN Node 拒绝原始请求，不能以框架自动修复为理由放行

### Requirement: 工具请求持久去重

系统 MUST 将 run/reply/call 标识与参数摘要、stepId 持久绑定，且不能重复创建或发送同一步骤。

#### Scenario: Worker 重传

- WHEN 相同 callId 和参数在结果丢失后再次到达
- THEN 返回原步骤状态或已保存结果，远端副作用最多执行一次
- AND 同标识不同参数被拒绝

### Requirement: 保留审批和未知结果语义

系统 MUST 在待审批时结束本次对话，由既有审批流程独立执行/核验；不得从 Worker 的确认事件直接放行生产写入。

#### Scenario: 写操作待审批

- WHEN execution.callStep 保存待审批计划
- THEN 聊天返回 awaiting_approval，Worker 停止后续调用
- AND 生产审批仍需要另一位管理员、有效修订与未过期计划

#### Scenario: 已发送写调用后发生中断

- WHEN 远端可能完成写入但响应丢失
- THEN 状态为 unknown，只能按既有只读核验/对账处理
- AND 重启、内部重试或回滚到旧引擎不重放写操作

### Requirement: 统一预算与正确终态

系统 MUST 对所有实际模型请求统一计算次数、token 与费用，控制超时和取消；不能因结果有文本而误报执行成功。

#### Scenario: 框架额外生成总结

- WHEN 到迭代上限、结构化输出补充或压缩将发起额外调用
- THEN 仍受 Node 的总调用数和预算约束，超过现有限额不得发出

#### Scenario: 等待或中断

- WHEN AgentScope 返回 finished_reason=None 或 interrupted/error/exceed_max_iters
- THEN 映射到等待或对应失败/中断处理，而非普通 success

### Requirement: 巡检只基于真实证据

系统 MUST 继续由 inspection 模块读取持久 tool_steps 计算业务结论，并保持任务与通知事件事务一致。

#### Scenario: 模型声称正常但缺少工具证据

- WHEN 模型输出正常，而无匹配对象/新鲜度的成功步骤
- THEN 巡检结论为 unknown，不发出已确认正常的报告

### Requirement: 运行隔离与可回滚

系统 MUST 将上下文、运行凭证、工具请求和结果关联到可信用户及唯一 run；切换运行时不能重跑在途执行。

#### Scenario: 灰度回滚

- WHEN 新运行时被关闭
- THEN 新 run 使用兼容旧运行时，在途 run 被等待或显式中止/对账
- AND 已有会话、审批、审计和通知可读，数据库使用兼容 schema 的构建

### Requirement: 预加载不复用业务状态

prefork 模式 MUST 仅在父进程预加载 SDK，每个 run 创建独立子进程、Agent 与事件循环。Node MUST 在匹配 leased 后发送上下文，在父进程回收确认后完成运行和复用父进程。

#### Scenario: 不同用户顺序复用同一父进程

- WHEN 用户 A 完成后用户 B 领取同一预加载槽位
- THEN B 使用新的子进程与自己的授权上下文，不能读取 A 的 Agent、知识或工具授权
- AND 父进程仅接收 lease 标识，没有历史和模型/工具返回

### Requirement: 有界资源与生命周期

系统 MUST 限制池大小、等待队列、启动/排队时间及父进程使用次数/年龄；取消与故障 MUST 清理整个进程组和 Node 回调，不得重放当前 run。

#### Scenario: 预加载父进程在模型等待中崩溃

- WHEN 活跃父进程退出，子进程仍持有管道
- THEN Node 中止回调、终止孤儿子进程，清理后释放执行槽位
- AND 退避后补建仅供后续新请求使用

#### Scenario: 池已满或应用关闭

- WHEN 等待队列超限、超时或被取消
- THEN 请求失败且不能稍后偷偷启动
- WHEN 应用关闭
- THEN 活跃和排队请求收尾，全部父子进程退出，后台不再补建

### Requirement: 可观测就绪与部署

正式入口 MUST 在选中运行时初始化后监听；readiness MUST 反映运行时可用性。管理员状态与受保护指标 MUST 不包含上下文和凭据，CPU/RSS 样本须注明采集边界。

#### Scenario: Python 不存在或版本不符

- WHEN 选中 AgentScope 而 Worker 初始化失败
- THEN 服务不能报告就绪，探针返回非零，运行不回退重放到 legacy

#### Scenario: 可选容器本地验收

- WHEN 在只读、断网、有限内存/PID 的临时容器执行验收
- THEN SDK 本地模型/工具探针、应用 readiness、指标和正常退出可验证
- AND 验收不挂载真实数据库、加载业务 .env 或发布业务端口

### Requirement: 持久记录数据源缺口

系统 MUST 将 MCP 连接/发现失败作为独立消息元数据和本轮模型上下文保存；不得把发现失败记为实际工具执行。消息和审计 MUST 使用固定错误码/说明，不包含原始连接异常、地址或凭据。

#### Scenario: 发现失败后问答、审批或模型报错

- WHEN 某 MCP 连接/发现失败而本轮继续使用其他资料
- THEN 模型明确获知缺少该服务实时证据，不能以历史值确认当前状态
- AND 最终回答、待审批说明或已保存错误消息保留 mcpFailures，刷新可回看

#### Scenario: 发现期间被取消

- WHEN 发现等待因取消或超时结束
- THEN 本轮终止，释放执行槽位，不发起模型请求或把取消当作降级成功

### Requirement: 恢复后的治理连续性

系统 MUST 在加密备份换钥恢复和兼容运行时切换后保留审批、未知结果、工具返回与请求去重语义。

#### Scenario: 恢复 AgentScope 数据后切回 legacy

- WHEN 在新目录换钥恢复包含 unknown 和待审批计划的数据
- THEN 原工具返回可解密，unknown 仅只读核对，生产计划仍需另一管理员且不重复执行
- AND 再次启用 AgentScope 后原请求去重和新对话均可用，不自动续聊或重放写入

### Requirement: 可复现且有边界的验收证据

评测 MUST 区分确定性工具/权限/巡检断言与人工诊断质量。镜像审计 MUST 固定镜像身份、检查 OS/Python/Node 覆盖、保留完整漏洞明细和 SBOM；扫描失败或可修复 HIGH/CRITICAL MUST 阻断。

#### Scenario: 本地 DTS 评测全部通过

- WHEN 30 个合成场景在两个运行时各重复三次通过
- THEN 报告保留逐条证据、用量、耗时和待人工审阅标准
- AND 不据此宣称真实模型诊断质量、费用或生产 DTS 灰度通过

#### Scenario: 镜像只有发行版未提供修复的高危告警

- WHEN 覆盖完整且可修复 HIGH/CRITICAL 为零
- THEN 扫描门禁可以通过，但完整报告保留未修复告警，生产安全接受状态仍为 false
