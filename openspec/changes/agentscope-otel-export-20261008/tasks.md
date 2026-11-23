# 实施清单

- [x] 复核现有 trace/span、模型和 MCP 出口及权限边界
- [x] 可选 OTLP/HTTP JSON 固定字段映射、整轮采样、有界队列与关闭取消
- [x] Agent 模型和 MCP 请求的可选 `traceparent` 传播
- [x] 本地 Collector fixture 的脱敏、传播、父链、503、队列和关闭专项测试
- [x] 官方 Collector 0.136.0 临时容器接收 exporter 的 2 个 span、ID/父链与脱敏核对；临时容器已清理
- [x] 最终候选全量回归：`706258...` 摘要，`npm test` 205/205、`npm run build` 通过，Chrome 目标绑定浏览器通过
- [x] 运维/架构/验证文档与离线站统一检查：`npm run docs:build`、`npm run docs:check` 通过

真实目标环境的 Collector、跨实例视图和下游传播仍需部署验收。
