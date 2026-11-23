# DTS 状态查询能力

## ADDED Requirements

### Requirement: 限定只读任务状态查询
系统 SHALL 通过 Streamable HTTP 提供唯一工具 dts_get_job_status；只允许固定上游、配置范围和通过校验的任务 ID。任何参数越界 SHALL 在请求上游前拒绝。

### Requirement: 显式区域任务范围
系统 SHALL 默认使用任务允许列表。用户显式配置 region 且清空列表后，SHALL 接受配置业务域和区域内任意有效正 int64 字符串 ID；省略列表、通配符、未知模式 SHALL NOT 自动扩大授权。区域模式仍 SHALL 拒绝其他区域/业务域和数字类型 ID。任务实际归属由固定 DTS 接口校验。

### Requirement: 可审计的范围同步
本机管理员 SHALL 能仅同步既有 DTS 工具的 jobid 约束，保留连接、凭据、账号、环境和其他策略。同步 SHALL 校验既有业务域/区域和只读模式，事务保存修订与审计，重复执行 SHALL 无新增变更；SHALL 支持恢复任务允许列表。

### Requirement: 正确报告真实状态
系统 SHALL 校验 HTTP 和业务 code、解析 data.status、核对任务 ID、保留上报时间，区分新鲜、过期、未知和查询错误。不得把旧状态当作当前正常，也不得把缺失布尔/数值当作 false/0。

### Requirement: 本机鉴权与凭据隔离
系统 SHALL 仅监听 loopback，MCP 调用需要独立 Bearer Token，拒绝不可信 Origin。模型参数、工具返回及日志 SHALL 不包含凭据；现有 DTS operator 元数据不得用作授权依据。

### Requirement: 可复现验收
系统 SHALL 提供离线模拟测试、本机启动/状态命令和实际环境验收记录。模拟数据不得作为真实 DTS 查询证据；真实模型回答必须能关联成功工具步骤。
