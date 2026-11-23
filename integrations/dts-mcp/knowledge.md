# DTS 任务状态查询说明

本说明只描述字段与查询流程，实时任务状态必须调用 dts_get_job_status 获取。业务域 general，区域 cn_east，实际获准任务以 MCP 服务和工具策略为准。

- jobid 是十进制字符串，不能转为 JavaScript Number；校验返回 ID 必须与查询目标一致。
- reported_at 来自 DTS status.time，单位原为 Unix 秒；queried_at 是适配器查询时间，两者不能互相替代。
- freshness=fresh 表示未超过适配器配置的新鲜度阈值（默认 60 秒）；stale 表示过期；future 表示上报时间超前超过 30 秒；unknown 表示缺失时间。这不是业务 SLA。
- health=1 对应当前 DTS 运行时健康约定，但必须结合新鲜度、paused、manual_stopped、finished 分析；health 缺失不能视为正常。
- paused=true 仅说明暂停，可能与主备角色有关，不能仅凭它判断故障；manual_stopped 表示运行时记录的手动停止标记；需要更多主备或操作证据才能解释原因。
- finished=true 仅表示运行时完成，不证明数据一致性验证通过；增量同步持续运行时 finished=false 本身不是故障。
- worker_delay_seconds 为 DTS 上报的 worker 延迟秒数；0 不代表整个链路绝对无延迟，null 表示缺失，不能猜为 0。当前没有已确认的业务告警阈值。
- state 为适配器摘要：running/paused/finished/unhealthy/stale/unknown。必须同时呈现关键原始标记，不能只用一句“正常”掩盖未知数据。
- 查询失败、目标不匹配、状态缺失或过期时，明确说明缺口，不自动执行暂停、恢复、重启或修改配置。

依据：DBRTools 的 GetJobStatusHandler（apiserver/internal/service/job/job.go）、runtime health 约定（internal/service/highavailability/hagroup.go）及本仓库 integrations/dts-mcp/adapter.mjs。接口 operator/工号信息不是认证凭据。MCP 不将原始 inbound/outbound/config 输出给模型。
