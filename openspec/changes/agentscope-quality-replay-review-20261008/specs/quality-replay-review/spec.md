# 质量回放复核需求

## ADDED Requirements

### Requirement: 逐条复核必须绑定不可变的回放证据

回放复核模板 MUST 绑定原始报告 SHA256、候选源码/质量语料/重构问题摘要和每条执行阶段/输出摘要。检查 MUST 拒绝缺失、重复、过期或被篡改的案例与输出，不得修改原始回放报告。

#### Scenario: 答复在模板生成后变化

- **WHEN** 复核模板已生成，原报告中的某条输出或候选摘要随后变化
- **THEN** 检查拒绝复用该模板，不把旧复核结论归给新输出

### Requirement: 工程复核、人工声明与发布状态必须分开

每条已完成复核 MUST 有明确结论、审核人、有效时间、具体说明和证据引用。复核 schema v1 MUST 接受可选 `reviewerKind=human|ai|unspecified`，缺省 MUST 按 `unspecified` 处理，新模板 MUST 显式生成 `unspecified`。工程检查 MUST 使用 `replay_review` 并按已完成条目的类型输出计数，待审条目 MUST NOT 计入完成计数。待审、拒绝或遗漏 MUST 保持工程复核就绪阻断；逐条审阅完成也 MUST 保持 `productionAccepted=false`，因为案例由脱敏摘要重构且使用合成目标。

`reviewComplete` MUST 表示没有待审条目，允许保留拒绝结论；`reviewReady` MUST 要求逐条批准、当前摘要和完整自动证据同时通过，可由 AI 工程复核满足。`humanReviewComplete` MUST 仅在全部条目明确声明为 `human` 且批准时为 true，MUST NOT 将 AI、混合类型、未声明类型、待审或拒绝计为已完成人工复核。CLI MUST 输出该人工声明状态；审核类型和姓名声明 MUST NOT 被描述为已核实身份。

#### Scenario: 两条合成回放都被人工批准

- **WHEN** 当前报告的两条案例具有完整有效的人工批准记录
- **THEN** 工程复核通过且 `humanReviewComplete=true`，同时保持 `productionAccepted=false` 和真实用户来源与正式发布评测尚未验证的边界

#### Scenario: Codex 完成两条 AI 工程复核

- **WHEN** 当前报告的两条案例具有完整有效的批准记录，且 `reviewerKind=ai`
- **THEN** `replay_review` 通过且 `reviewReady=true`，AI 完成计数为 2，`humanReviewComplete=false`，`productionAccepted=false`

#### Scenario: 旧记录没有声明审核类型

- **WHEN** schema v1 的有效已完成记录缺少 `reviewerKind`
- **THEN** 检查按 `unspecified` 计数，允许完成工程复核但不得标记已完成人工复核

#### Scenario: 混合或未批准的人工记录

- **WHEN** 条目混合 AI 和人工类型，或存在待审、拒绝、未声明类型
- **THEN** `humanReviewComplete=false`，待审不计为完成，拒绝可完成审阅但阻断 `reviewReady`

### Requirement: 受控查询答复必须使用本轮实际工具字段

受控模型的成功只读答复 MUST 从本轮成功 DTS 工具结果读取 `state`、`reported_at`、`queried_at`、`freshness` 并报告对应四字段，MUST NOT 使用旧快照或预设静态值替代。工程审查 MUST 核对答复与本轮查询快照一致。修正受控夹具 MUST NOT 被解释为真实模型或生产任务质量已验收。

#### Scenario: 原答复遗漏字段后修正夹具

- **WHEN** 原报告答复只提示查看快照，随后修正夹具输出本轮工具四字段
- **THEN** 保留原报告及其拒绝审查记录，生成新的报告与独立摘要绑定复核；新批准不得覆盖或改写旧拒绝

### Requirement: 自动证据必须与执行阶段相符

检查 MUST 核对 HTTP、执行状态、模型/上游调用、工具步骤、边界和查询快照与案例阶段一致；MUST NOT 仅凭报告中的自动通过标记将矛盾证据判为复核就绪。

#### Scenario: 前置拒绝案例却记录了实际查询

- **WHEN** 案例标为 `authorization_preflight`，但报告显示成功响应、模型请求、上游调用或工具步骤
- **THEN** 检查拒绝这份报告，不能因 `automaticEvidencePassed=true` 放行复核结果

### Requirement: 输出文件只能新建

模板与检查结果 MUST 以权限 0600 只写入尚不存在的私有路径，不得覆盖报告、复核记录或历史结论。

#### Scenario: 输出路径已存在

- **WHEN** 使用已有文件作为模板或检查结果路径
- **THEN** 命令失败且原文件保持不变
