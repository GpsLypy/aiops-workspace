# 实现设计

应用固定脱敏 OTLP/HTTP JSON 经 Collector 的 memory_limiter/batch 到 Tempo；Collector 不配置 debug exporter。Tempo WAL/块与 Prometheus TSDB 各持久到自己的卷。共享 Prometheus 用 Bearer token secret 抓取独立工作空间。固定标签只用于部署身份；targets 校验拒绝重复目标、重复标签、凭据地址或任意附加标签。

指标保留进程计数器语义，跨实例率先 `rate` 再聚合；P95 合并桶而不平均分位数。原模型费用没有币种元数据，因此仅生成 workspace 估算费记录，不制作跨币种总费用。

账单工具完全离线。严格字段、真实日期与有界输入通过后，以日/供应商/模型/币种聚合。最多六位小数金额转换为 BigInt 百万分货币；各币种与用量费/调整分开。tokenSource 标为 estimated/unknown 或账单缺 token 细节时，不把 token 数相等解释为核实。原输入字节 SHA256 进入报告，输出 `wx/0600`；不复制原 invoice 敏感列，也不验证账户权限或签名。

本地验收启动唯一 Compose 项目和两套临时数据库。实际 AgentScope 调用本机受控模型/MCP；请求幂等、Tempo 已知 trace ID 回读、Prometheus 每实例和 recording rule 总计、Tempo 重启、Collector 停机不阻断问答全部显式断言。finally 只删除本次项目的卷和临时文件，不触碰既有应用或容器。报告始终标注 fixture 与外部验收限制。
