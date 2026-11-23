# DTS 评测工程复核与正式人审分离

现有 30 场景、cold/prefork、三次重复产生 180 条合成案例评测，复核 v2 只有审核人姓名，无法区分 Codex AI 工程复核和人工声明。用户已授权 Codex 继续页面工作计划，需要可据实完成的工程检查，同时保留真实模型、真实用户来源和发布人审的边界。

本次保留评测报告 schema v3，新增复核 schema v3 与可逐条阅读的证据包。复核绑定原报告 SHA256、源码、每条答复和保存的执行观察及 rubric，明确声明 `reviewerKind`，逐条记录证据一致、rubric 合规和判断边界三项结论及具体理由。模板保持 pending，不根据工具自动标记批准。

验收结果区分 `engineeringReady`、`realModelQualityReady`、`humanReviewComplete` 和 `evaluationAccepted`。AI 工程复核可以完成前两项的复核部分，只有明确 human 的全部批准才能满足正式人审。真实模型门槛继续独立；`productionAccepted` 始终 false。旧 v2 记录仍可读取，其类型按 unspecified 统计，不自动升级为人工或已分类工程复核。

范围限于本地评测与复核 CLI，不修改原库模型、真实 DTS 资源、语料来源、运行时决策或产品 API。
