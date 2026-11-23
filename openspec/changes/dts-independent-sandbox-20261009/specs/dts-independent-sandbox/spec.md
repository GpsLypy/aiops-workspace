## ADDED Requirements

### Requirement: 独立只读部署与网络保护
系统 SHALL 将DTS服务独立部署于现有助手之外，沿用general/cn_east只读状态工具，保留loopback监听、独立Token和Host/Origin校验；跨实例使用加密SSH转发。

#### Scenario: 助手查询DTS
- **WHEN** 助手经受限SSH连接独立服务
- **THEN** 仅获准区域只读状态查询可执行，未鉴权或越界请求拒绝

### Requirement: 最小部署包和进程归属
系统 SHALL 使用锁定最小依赖，部署包排除凭据、应用数据库/主密钥、本地依赖与内部报告；管理命令核对Linux UID、私有配置权限和PID身份，只控制自身进程。

#### Scenario: 部署和服务管理
- **WHEN** 上传源码包并启动或停止服务
- **THEN** 核对包摘要和配置权限，不包含秘密，身份不匹配时不发送进程信号

### Requirement: 真实验收与恢复边界
系统 SHALL 验证真实SDK握手、工具发现、DTS查询、未鉴权与范围拒绝和退出恢复，记录真实时间及未验收边界。

#### Scenario: 发布验收记录
- **WHEN** 完成独立服务的协议与进程恢复检查
- **THEN** 保存实际结果，不把进程恢复当作平台重建或生产批准
