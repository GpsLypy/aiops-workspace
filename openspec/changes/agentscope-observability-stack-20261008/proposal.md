# 补齐 Collector、跨独立工作空间统计与账单对账工具

## Why

入门页当前计划已有本机 OTLP 接收验证，但缺真实标准 Collector 到持久 trace 存储、多个独立实例的共享统计与用户提供供应商账单的工程对账入口。单进程指标和配置单价不能充作生产链路或供应商实收费。

## What Changes

- 提供固定官方镜像摘要的 Collector、Tempo、Prometheus 独立部署配置，loopback 入口、受保护 metrics 凭据、持久卷、有限队列与留存。
- 按独立 instance/workspace 标签抓取，先合并阶段直方图桶再计算 P95，保留工作空间估算费用维度。
- 增加隔离的本机 Docker 真实组件验收：两个临时应用使用真实 SDK/受控模型产生实际 traces 与指标，核对存储、重启、故障隔离和清理。
- 新增用户供应 CSV/JSON 账单标准化校验与对账，区分费用估算、供应商申报费用、token 来源和未匹配用量；文件摘要绑定、私有排他输出。

## Impact

- 新模块仅在 `deploy/observability/`、独立 scripts/tests 和对应规范；不改业务 schema、用户/API 流程或默认出口开关。
- 不改变单实例 SQLite 架构；汇总只能用于独立数据库工作空间，不能把共享数据库副本相加。
- 需要 Docker 和固定镜像才能运行集成验收；未配置外部生产目标或真实账单不构成外部验收通过。
