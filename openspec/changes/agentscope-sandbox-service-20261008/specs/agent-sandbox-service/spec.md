# 独立本机沙箱服务

## ADDED Requirements

### Requirement: 不可信 Python 执行必须离开应用环境

本机执行服务 MUST 将 Python 源码放入固定镜像的一次性禁网、只读根、无应用凭据/宿主挂载/管理 socket 的限额容器；客户端 MUST NOT 指定隔离配置。Docker 管理通道 MUST 仅由独立 broker 使用。

#### Scenario: 源码请求携带挂载或网络字段

- **WHEN** 请求包含源码协议以外字段
- **THEN** broker 返回400且不创建容器

#### Scenario: 代码尝试读取应用文件或建立外网连接

- **WHEN** 本机验收代码访问应用目录、凭据、socket及外网
- **THEN** 实际客体无法取得这些路径或连接，并由宿主核对容器配置

### Requirement: 任务身份与幂等必须来自服务器

服务 MUST 通过独立 Bearer 令牌映射租户/用户/角色，拒绝跨用户及跨租户访问。相同 jobId 和规范化摘要 MUST 返回原任务，改变摘要 MUST 拒绝；重启不确定任务 MUST 标记 unknown，禁止自动重放。

#### Scenario: 同租户其他用户查询任务

- **WHEN** 非所有者、非同租户管理员请求任务
- **THEN** 返回404且不泄露产物

#### Scenario: broker 重启遇到 running 记录

- **WHEN** 持久任务没有确认终态
- **THEN** 标记unknown并核验容器回收，不再运行源码

### Requirement: 产物必须隔离、扫描并由独立管理员明确批准

服务 MUST 对不可信产物检查路径、普通文件/无链接、编码、类型、字节限额、内容策略及 hash。通过扫描 MUST 先隔离为 pending；只有不同于提交者的同租户管理员对当前摘要明确批准后，所有者才可下载。预览 MUST 仅提供给独立管理员并按纯文本返回；被阻断或拒绝的产物 MUST NOT 下载。

#### Scenario: 输出包含活动HTML或路径穿越

- **WHEN** 客体提供违反白名单的产物
- **THEN** 产物保持blocked，管理员也不能批准

#### Scenario: 批准后隔离字节被改动

- **WHEN** 下载时扫描或hash与批准摘要不一致
- **THEN** 服务拒绝下载并返回完整性错误

### Requirement: 取消、超时与生命周期必须确认回收

服务 MUST 对运行中取消或超时停止整个容器，并独立确认不存在；无法确认 MUST 保持unknown且禁止下载。TTL及显式删除 MUST 在执行清理后删除隔离字节，保留有界幂等状态。

#### Scenario: 容器运行超出墙钟限额

- **WHEN** Python任务执行超过10秒
- **THEN** 服务停止容器，确认回收并保存timed_out状态

### Requirement: MCP桥必须保留产品审批与生产边界

MCP 执行工具 MUST 声明有副作用，部署说明 MUST 要求实际risk=write产品策略、精确关联步骤约束、jobId幂等参数、唯一关联步骤只读核验及恢复手册；桥 MUST NOT 持有产物管理员令牌或提供下载/批准工具。本机验收 MUST NOT 等同生产内核/身份/共享连接器隔离或业务质量放行。

#### Scenario: MCP 工具清单

- **WHEN** 真实SDK读取工具并执行固定源码
- **THEN** 仅出现write源码执行和read状态，返回产物描述但不返回文件内容
