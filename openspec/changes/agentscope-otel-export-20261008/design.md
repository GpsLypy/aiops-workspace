# 设计与故障策略

## 导出映射

原 `ExecutionTrace` 仍是持久事实来源。完成回调在本进程最多提交一次 exporter；业务消息和原有 `/metrics` 不依赖发送结果。OTLP/HTTP JSON `ExportTraceServiceRequest` 仅使用固定 `service.name/version`、`aiops.stage/outcome` 属性，固定 span 名、时间及 trace/span/父 ID；trace/span ID 采用 OTLP traces JSON 接收器接受的十六进制形式。阶段只选 run/model/tool/mcp/review，本地图谱未导出的父节点折叠到最近已导出祖先或根 span。原图和 API 快照不改变。

## 配置与传播

`OTEL_EXPORTER_OTLP_TRACES_ENDPOINT` 是可信部署中的完整 HTTP(S) `/v1/traces` 地址，空值关闭导出；沿用 `safeFetch` 的 origin、私网和 TLS 限制。`OTEL_TRACES_SAMPLE_RATE` 为 0–1，默认 1；以 trace ID 前 32 位确定性判定整轮是否采样。`OTEL_PROPAGATE` 默认为 false，可独立开启；出站模型/MCP 的 `traceparent` 使用原 trace ID 和对应本地节点 span ID，标志反映采样结果。直接工具/Runbook、入站 HTTP 和 Python 私有协议不受影响。

## 可靠性与隐私

内存队列最多 128 个待发送 payload，单路发送，无重试。`OTEL_EXPORT_TIMEOUT_MS` 限定每次等待为 100–10000ms，默认 2000ms；发送 Promise 与取消信号竞争，使 DNS 阶段也不阻塞 exporter 收尾。关闭时丢弃队列并取消在途发送。固定 `sent/failed/dropped/sampled_out` 计数与队列深度在受 Bearer 保护的 `/metrics` 暴露，重启清零。发送失败不影响聊天、工具、持久化或 readiness；进程硬退出可能丢弃所有内存数据。Collector payload 不携带原图 summary/details/label、run/user ID、正文、参数或凭据。

## 验收

本地夹具核对实际 HTTP 模型/MCP 请求头与持久节点 ID、OTLP JSON 固定字段及 ID 的 16/8 字节十六进制长度、父链闭合、幂等一次发送、Collector 503 仍业务成功、限流丢弃与停机取消。官方 OpenTelemetry Collector 0.136.0 临时实例接收本项目 exporter 的请求为 HTTP 200、两个 span，日志中的 trace/span/父 ID 与原图一致，敏感测试字段未出现；base64 ID 对照请求被其以 HTTP 400 拒绝。全量测试、构建、文档站检查由最终候选统一运行。
