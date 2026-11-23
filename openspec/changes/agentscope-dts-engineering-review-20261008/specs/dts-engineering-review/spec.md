# DTS 工程复核要求

## ADDED Requirements

### Requirement: 复核必须绑定输出和保存观察并显式分类

系统 MUST 生成 schema v3 待审模板，绑定原报告 SHA256、源码摘要、逐条 key、答复摘要、保存证据摘要及 rubric。完成记录 MUST 声明 human、ai 或 unspecified 类型、审核人、有效时间、具体理由及证据引用，并完整记录三项分项结论。旧 v2 记录 MUST 按 unspecified 统计，MUST NOT 自动继承人工或分类工程批准。

#### Scenario: 答复或证据在复核后改变

- **WHEN** 某行输出、观察或 rubric 与复核摘要不一致
- **THEN** 检查拒绝该输入，不沿用旧批准

#### Scenario: 用工具通过标记替代分项审查

- **WHEN** 批准记录缺少完整分项理由或包含 fail/pending
- **THEN** 检查拒绝该矛盾批准，不自动填写结论

### Requirement: 工程和正式人工验收必须独立

系统 MUST 区分 engineeringReady、realModelQualityReady、humanReviewComplete 和 evaluationAccepted。明确 AI 可满足工程复核，MUST NOT 被当作 human。真实模型质量 MUST 额外要求真实模型模式。evaluationAccepted MUST 要求全部明确 human 批准。productionAccepted MUST 始终为 false。

#### Scenario: Codex 批准全部受控模型输出

- **WHEN** 当前候选观察、重复、比例及全部 AI 分项复核通过，但报告为固定模型模式
- **THEN** engineeringReady=true，realModelQualityReady=false，humanReviewComplete=false，evaluationAccepted=false，productionAccepted=false

### Requirement: 保存观察必须复算

系统 MUST 重新核对报告保存的 HTTP、步骤、上游调用、查询时间和新鲜度及最终巡检结论，MUST NOT 只信任 passed 标记。缺失必要观察 MUST 阻断工程状态。系统 MUST 明确报告不能验证被省略的实际参数、资源或风险字段。

#### Scenario: 成功标记与实际上游调用数矛盾

- **WHEN** 成功只读行标为 passed，但观察显示零次查询或错误工具
- **THEN** automatic_evidence 被阻断，即使全部复核记录批准也不能 engineeringReady

### Requirement: 证据包不得批准或混淆来源

系统 MUST 导出全部逐条输出和快照，并按场景显示变体与失败键；业务案例 MUST 标为 synthetic。系统 MUST 区分受控模型、真实模型和执行器拒绝/错误，MUST NOT 将后端拒绝当作模型答复质量证据。

#### Scenario: 越权输入在模型之前被拒绝

- **WHEN** 评测行返回非 200 的前置授权错误
- **THEN** 证据包标记 execution_error_or_refusal，保留输出供工程审阅，不声称模型拒绝能力通过

### Requirement: 输出必须私有且只能新建

模板、证据包和汇总 MUST 以 0600 排他新建；无效输入或已存在输出 MUST 退出 1 并保留历史文件。默认检查 MUST 以 evaluationAccepted 判定 0/2；显式 engineering 模式 MUST 以 engineeringReady 判定 0/2 且保留完整正式门槛。

#### Scenario: 重复写入已经通过的验收文件

- **WHEN** 调用者指定已有输出路径，无论新输入是否有效
- **THEN** 命令退出 1，原通过文件保持不变
