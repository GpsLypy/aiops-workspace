# 共享观测与费用对账

## ADDED Requirements

### Requirement: 脱敏链路的独立持久部署

系统 MUST 提供固定官方 Collector、持久 trace 后端和共享指标后端配置；应用出口 MUST 保持默认关闭。部署 MUST 只在 loopback 或明确私有边界暴露，MUST NOT 将原 trace 数据写入 debug 日志。

#### Scenario: 本机显式启用观测

- WHEN 两个临时应用显式配置本机 Collector 并完成受控问答
- THEN 真实 Collector 将固定字段 spans 存入 trace 后端，已知 trace ID 可查询且后端重启可恢复

### Requirement: 独立实例的可比较汇总

共享 Prometheus MUST 给每个独立数据库工作空间保留唯一 instance/workspace 标签，用 Bearer secret 抓取。统计 MUST 先合并直方图桶再估计 P95，MUST NOT 将共享数据库副本重复相加或把无币种的配置费用合成真实账单。

#### Scenario: 两个实例各完成不同轮数

- WHEN 独立实例分别实际完成 1 和 2 轮问答
- THEN 每实例计数可区分且汇总为 3，幂等回读不增加计数或模型调用

### Requirement: 显式费用来源和对账覆盖

账单工具 MUST 只接受有界严格 CSV/JSON 文件，以日/provider/model/currency 聚合；MUST 用精确十进制货币计数，保留估算、用量费用、抵扣、各币种与未匹配记录。缺少实际供应商 token 数或本地 token 来源未核实时 MUST 保持 token 核实未通过。供应商账户真实性及生产批准 MUST NOT 由文件导入推断。

#### Scenario: 有匹配费用但 tokens 为估计

- WHEN 本地估计 tokens 与供应商输入数相等且费用相等
- THEN 报告可显示金额匹配，但 tokensMatch 为 false，保持 needs_review 和生产未批准

#### Scenario: 供应商存在未观测用量

- WHEN 账单日/provider/model/currency 键在本地用量台账不存在
- THEN 保留 invoice_only 记录，不将费用平均分配给其他本地轮次

### Requirement: 隔离验收与追溯

本机验收 MUST 使用唯一临时 Compose 项目和独立临时数据库，MUST 只清理自己的临时资源。报告 MUST 绑定实际镜像与输入摘要，私有排他写入，明确受控模型和真实账单/外部生产验收边界。

#### Scenario: Collector 关闭

- WHEN 本机验收停止 Collector 后继续受控问答
- THEN 问答仍实际完成且出口固定失败计数增加，未重放业务工具
