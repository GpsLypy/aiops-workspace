# 设计

调用链：运维助手 → 带 Bearer Token 的本机 /mcp → 固定 DTS GET 接口 → JSON 外层和 data.status 双重校验 → 字段白名单 → MCP structuredContent/text → 模型回答。

- 独立 Node.js 进程，复用仓库锁定的 SDK/Express/Zod。只监听 127.0.0.1:43129；launchd 保持运行。密钥通过权限 0600 的本地环境文件载入，不放入源码、命令参数或日志。
- URL 必须配置，不接受模型传入；路径仅允许 /proxy/v1/jobns/getstatus 或 /v1/jobns/getstatus。明文上游 HTTP 需显式允许，禁止重定向，超时和正文上限固定有界。
- general/cn_east 由服务端固定并校验。DTS_JOB_SCOPE 默认 allowlist，必须列出 1 至 100 个 ID；显式 region 模式且列表为空时，支持该业务域/区域内任意有效 ID。默认或拼写错误不放宽访问。放宽任务范围需修改本机配置及平台策略，两端独立校验。
- sync-policy 仅修改指定所有者既有 DTS MCP 的 jobid 约束，事务读取最新修订、保存版本与审计；验证连接、凭据、区域/业务域和只读风险等级，保留用户、环境及其他限制。重复同步无变更，支持恢复 allowlist。不增加通用策略通配语义。
- 不伪装成用户姓名/工号。当前上游无 Token 调用，operator 参数不是认证。MCP Token 与未来上游 Token 分离。
- 输入 ID 必须为 int64 范围内正十进制字符串；返回 ID 必须一致。缺失字段保留 null，不把缺失值变成 false/0。time 为 Unix 秒，freshness 阈值默认 60 秒，未来偏差超过 30 秒视为未知；阈值不是 DTS 业务 SLA。
- 仅健康值 1、状态字段完整、新鲜且未暂停/完成才归纳 running。paused 不直接等于故障；finished 只表示运行时完成标记，不证明业务数据完全一致。原始 inbound/outbound/config 不送入模型。
- 错误返回固定中文原因及稳定错误码，不返回上游正文、完整异常或凭据；日志只记目标、结果和查询时间。

不改现有通用工具治理、模型设置或其他资源。真实环境验收新增私有 DTS 资源，实际调用只读。先通过临时数据库测试，再使用现有工作空间验证。
