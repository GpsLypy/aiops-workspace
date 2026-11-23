# Agent 查询目标绑定需求

## ADDED Requirements

### Requirement: 受保护的只读工具必须核对显式目标

声明必需目标字段的只读工具 MUST 在真实调用前核对本轮用户确认的资源、工具、环境、参数字段集合和每个值。目标 MUST 来自认证用户的结构化确认，MUST NOT 从模型参数、自由文本、检索内容或工具返回自动推断。

#### Scenario: 模型提出不同或不完整的目标

- **WHEN** 模型提出授权内其他目标、越权目标、缺失目标字段、额外参数或跨工具调用
- **THEN** 调用被拒绝，MCP `tools/call` 不会收到请求

#### Scenario: 用户没有确认目标

- **WHEN** 受保护工具缺少本轮结构化目标绑定
- **THEN** 工具调用失败关闭，不从 prompt 推断目标

### Requirement: 绑定必须参与持久执行治理

绑定 MUST 进入持久执行输入和幂等摘要。重放或撤权 MUST NOT 增加工具调用；调用前 MUST 继续执行原权限、Schema、取消、预算和资源版本检查。

#### Scenario: 相同请求重放或资源撤权

- **WHEN** 请求被重放，或确认后资源权限发生变化
- **THEN** 执行器复用原结果或拒绝调用，不能增加 MCP 调用

### Requirement: 定时任务必须保存显式绑定

定时任务 MUST 保存显式绑定。旧任务迁移 MUST 保留空值并允许所有者补配；旧任务 MUST NOT 靠解析 prompt 自动获准查询。

#### Scenario: 旧任务尚未补配目标

- **WHEN** 旧任务尝试调用要求目标绑定的只读工具
- **THEN** 工具调用被拒绝，所有者可显式补配后再运行

### Requirement: DTS 三字段策略必须保留既有授权

DTS 策略 MUST 覆盖 `jobid`、`business_domain` 和 `area_name`，并 MUST 保留既有 `general/cn_east` 区域授权与凭据。部署前 MUST NOT 宣称真实实例已启用新门禁。

#### Scenario: 同区域另一个任务 ID

- **WHEN** 模型提出的任务 ID 与用户确认的 ID 不同，但仍在既有区域授权内
- **THEN** 目标绑定在真实 DTS 查询前拒绝该调用

### Requirement: 文档必须区分能力与验收边界

文档和入门页 MUST 区分本地合成回归、已配置策略的工具及真实业务验收，MUST NOT 宣称已识别自然语言意图或支持一轮多个工具目标。

#### Scenario: 仅有合成回归证据

- **WHEN** 目标绑定仅通过本地受控模型与工具回归
- **THEN** 文档说明该证据范围，不把它记为真实模型或生产质量放行
