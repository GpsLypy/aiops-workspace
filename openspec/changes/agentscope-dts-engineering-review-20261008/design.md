# 证据、审核类型与门槛

## 复核 v3

模板保存 `createdAt`，时间不得早于评测结束或晚于当前时间。每行保存 `key`、`answerSha256`、`evidenceSha256`、原 rubric、status、reviewerKind、reviewer、reviewedAt、notes、evidenceRef 和 findings。答复摘要直接绑定输出字节；证据摘要绑定报告保存的 HTTP 状态、上游调用、步骤、最终巡检与查询快照。

findings 必须唯一且完整覆盖 `evidence_consistency`、`rubric_compliance`、`boundary_compliance`。批准时三项都为 pass；拒绝时至少一项为 fail。完成记录与每项理由须含至少 12 个非首尾空白字符；这只是最低完整度校验，不能验证结论是否正确，不能代替审阅输出。模板不给出批准结论。

旧 v2 记录保留已完成/待审统计，但 reviewerKind 为 unspecified，缺少新输出绑定与分项结论，不能自动满足 v3 工程或人工门槛。

## 观察复算

汇总继续要求原始 `passed`，并根据已保存观察重新检查成功、拒绝、工具错误、无工具答复和后续重新查询的 HTTP、调用数、步骤身份、查询快照、状态、新鲜度、最终巡检时间与 assessment。缺少 inspection 的旧证据不能通过该门槛。不能只因 passed=true 忽略矛盾观察。

报告没有逐条实际工具参数、资源或风险字段；这些仍依赖原评测器对实际台账的断言。报告复算明确声明这一限制，不宣称重建未保存的数据或核实外部事件真实性。

## 可读证据包

`--packet NEW_FILE` 导出全部输出与快照，按场景汇总行数、答复变体数及观察失败键。合成问题标记 `caseOrigin=synthetic`；输出区分 controlled_model、real_model 与 execution_error_or_refusal，避免把后端 403 或执行器错误当成模型拒绝能力。真实模型只说明模型由真实服务生成，工具与问题仍为本地合成。

## 三层结果

engineeringReady 要求当前摘要、三轮重复、自动观察、有效时间、性能/台账比例和全部已分类批准。realModelQualityReady 额外要求真实模型模式与 endpoint 摘要。evaluationAccepted 额外要求全部明确 human 批准。人工类型和姓名仍是未认证声明。全部结果保留 productionAccepted=false，真实用户来源不因工程复核改变。

CLI 默认以 evaluationAccepted 判定 0/2；显式 `--engineering` 以 engineeringReady 判定 0/2，输出完整正式门槛。模板/证据包新建成功为 0；无效输入或已有输出路径为 1。所有输出为 0600 排他新建，错误不覆盖先前成功证据。
