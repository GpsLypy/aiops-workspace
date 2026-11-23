# 公司沙箱隔离部署

## ADDED Requirements

### Requirement: PoC 必须使用全新测试实例和工作空间

部署材料 MUST 仅包含受控源码、依赖锁和构建结果，MUST NOT 将现有 `.data`、`.env`、真实凭据、模型设置、DTS 资源、旧任务和通知渠道打入源码包或镜像。目标平台 PoC MUST 创建全新实例、新数据目录和新测试账号，MUST NOT 迁移原数据库或主密钥。按用户明确授权只读取得本地保存的单个模型 MUST 使用独立私有配置文件，MUST NOT 修改原模型或原工作空间。PoC MUST NOT 修改生产实例、访问生产 DTS、启用旧任务或发送生产通知。

#### Scenario: 打包应用部署材料

- **WHEN** 操作者为公司沙箱生成 PoC 包
- **THEN** 包内只出现明确允许的部署文件，现有私有数据和凭据不被读取或打包

#### Scenario: 新实例首次启动

- **WHEN** 测试应用打开全新持久数据目录
- **THEN** 只创建本轮测试工作空间，现有资源、任务与通知配置不被继承

### Requirement: 目标运行时必须满足锁定 Worker 环境

应用 PoC MUST 使用 Node 22 系列（至少22.16）、Python 3.12 和锁定 AgentScope 依赖，并实际验证 Node 子进程 stdio/fork 与 Worker 启动。平台默认 Node 24 / Python 3.14 MUST NOT 被视为已通过本轮锁定环境检查。专用镜像复用或独立 bootstrap 的实际方式 MUST 在验证结果中说明。

#### Scenario: 平台通用模板提供 Python 3.14

- **WHEN** 默认环境与 Worker 的 Python 3.12 要求不同
- **THEN** 部署采用独立 Python 3.12 环境，Worker 探针通过后才标记运行时可用

### Requirement: 模板运行时不匹配时必须使用独立私有版本

Linux x86_64 测试实例的运行时安装脚本 MUST 将版本安装到本轮实例本地 `/home/sandbox/poc-runtime`，安装官方Node22.23.1并核对同版本官方SHA256清单、uv0.11.26和Python3.12，MUST NOT 替换平台系统Node/Python或修改生产服务。源码归档、新数据库和私有模型 MUST 保留在 `/workspace`。本地运行时/依赖 MUST NOT 被宣称自动持久化；实例重建恢复 MUST 在实际归档及恢复验证后才通过。安装脚本存在 MUST NOT 被当作目标实例安装或Worker已成功的证据。

#### Scenario: 新实例默认 Node24 / Python3.14

- **WHEN** 以本轮PoC标志和UID1000执行私有运行时安装
- **THEN** 版本安装到新实例私有目录，并在实际目标版本/Worker探针通过前保持环境验收未完成

### Requirement: Python范围下载必须核对固定官方归档完整性

范围下载器 MUST 固定官方Python3.12.13 Linux x86_64归档、长度与SHA256，核对每个最终HTTP206、Content-Range和实际范围字节数，对断点复算范围摘要。失败范围 MUST 仅重取失效范围或拆为更小范围；完整长度和SHA通过前 MUST NOT 提交最终归档。安装器 MUST 再次核对相同SHA并拒绝覆盖不同链接/环境脚本或不完整安装目录。离线fake-curl测试 MUST NOT 当作真实官方归档下载或Worker安装成功证据。

#### Scenario: 下载响应的范围或完整SHA不一致

- **WHEN** 返回内容与固定范围或官方归档摘要不同
- **THEN** 该范围或归档被拒绝，最终已核对归档不被错误内容替换

### Requirement: 独立入口必须禁止未配置的真实集成与后台任务

本轮 PoC MUST 使用专用启动入口，不加载 `.env`，停用调度器和通知后台，并拒绝页面/API 修改模型、MCP、资源写入、任务、通知和 Runbook 接口。真实模型 MUST 通过显式私有文件启用；无该文件时 MUST 只使用同实例受控模型。常规环境变量携带旧模型、通知或身份设置 MUST NOT 隐式开启已有集成。MCP / DTS MUST 排除本轮，不迁移或调用连接器。

#### Scenario: 请求创建任务或连接 MCP

- **WHEN** 浏览器或 API 客户端在基础 PoC 中提交任务、通知或 MCP 请求
- **THEN** 独立网关拒绝请求，资源和任务数据保持空，未向真实外部服务发送请求

### Requirement: 内部失败执行记录必须保留并与通知发送区分

PoC启动与探针 MUST 使用同一只读数据库隔离校验，资源、任务、通知渠道/事件/投递、Runbook与已保存模型设置 MUST 为空。`notifications` MUST 仅允许failed/cancelled/unknown/awaiting_approval内部记录，payload恰含runId/userId、匹配无工具AgentScope执行owner/runtime/status且pending/attempts0；其他记录 MUST 拒绝。校验 MUST NOT 删除失败现场或改写业务server。报告 MUST 分开记录 `isolatedIntegrationTaskNotificationState`、`internalFailureRecords`与`notificationsSent`，MUST NOT 把内部执行记录数量当作通知发送次数。

#### Scenario: 模型超时后保留失败记录并重启

- **WHEN** 失败聊天留下满足内部记录约束的notifications和错误消息
- **THEN** PoC保留该现场并允许重启，渠道/事件/投递仍为空，实际通知发送为0

#### Scenario: 通知记录含外部payload或工具执行

- **WHEN** 记录不满足精确内部执行匹配条件
- **THEN** 启动或探针拒绝该数据库，不为通过校验而删除记录

### Requirement: 获准保存模型必须通过独立私有配置显式启用

真实模型配置 MUST 通过 `POC_REAL_MODEL_CONFIG_FILE` 指定私有普通文件，权限0600、大小不超过64KiB，固定字段 `baseUrl`、`apiType`、`model`、`apiKey`，可附加 `schemaVersion:1`。只读导出 MUST 拒绝写入原源目录、覆盖输出或复制原数据库/主密钥，并核对原模型配置与主密钥摘要前后一致；导出 MUST NOT 请求模型。配置 MUST 拒绝额外字段、未知协议及含用户信息/查询参数/fragment的URL，只允许模型baseUrl的精确单一origin，且 MUST NOT 将凭据写入SQLite、源码包、镜像或报告。

#### Scenario: 使用用户授权的本地保存模型

- **WHEN** 新实例收到合法私有模型文件并显式设置该变量
- **THEN** 测试进程使用该模型，原模型设置保持不变，出口仅允许该模型origin

#### Scenario: 仅传入旧的 MODEL_BASE_URL 或模型文件带额外字段

- **WHEN** 启动未提供显式私有配置，或配置不符合精确Schema
- **THEN** 不隐式使用旧模型，分别使用受控模型或拒绝非法配置

### Requirement: 数据与对应密钥必须在独立持久区恢复

PoC MUST 将新 DATA_DIR 指向本轮实例持久工作区，确认目录可写和 SQLite WAL/锁语义，并在实际重启后核对数据库完整性、账号和测试会话。恢复 MUST 使用该测试数据库对应的同一主密钥。应用进程重启与实例重建的证据 MUST 分别记录。

#### Scenario: 测试会话写入后应用进程重启

- **WHEN** 实际结束并重新启动测试应用进程
- **THEN** 账号与测试会话可以回读，SQLite 完整性检查通过，且报告只声明进程级恢复范围

#### Scenario: 仅进程重启已通过

- **WHEN** 平台暂停或实例重建尚未执行
- **THEN** PVC 重建保留及平台常驻结论保持未验证

### Requirement: HTTP Preview 不得改变生产安全要求

HTTP Pod Preview MUST 只用于独立 `NODE_ENV=development` PoC，浏览器 Origin 和启动配置 MUST 一致。实现 MUST 保留生产模式的 HTTPS APP_ORIGIN、Secure Cookie、外置 MASTER_KEY_FILE、AUTH_MODE 与出口规则要求，不得通过修改校验让 HTTP Preview 冒充生产入口。

#### Scenario: 浏览器访问 HTTP Pod Preview

- **WHEN** 测试实例仅提供 HTTP 地址
- **THEN** 仅启动独立开发模式测试库，并记录正式 HTTPS 入口仍未验收

### Requirement: 浏览器流式与外部集成必须按实际范围验收

平台验收 MUST 实际核对首页、登录、同源 API、首段提前到达的流式答复、完成结果和刷新回读。受控模型/合成工具 fixture MUST 明确标识，MUST NOT 当作真实模型质量或 DTS 联调通过。真实模型 MUST 使用用户授权的保存模型独立私有配置，并实际记录请求及持久结果；MCP / DTS MUST 标记本轮跳过。实例内探针 MUST 记录实际逐批读取的 `incrementalBeforeCompletion`，MUST NOT 把同批到达写成提前呈现。

NDJSON聊天 MUST 先检查error事件，再要求有效done/非空答复及持久回读；HTTP200或直接模型raw请求成功 MUST NOT 替代完整聊天验收。聊天后 MUST 再次核对数据库隔离状态。

#### Scenario: 同实例受控模型完成流式对话

- **WHEN** 真实浏览器通过本轮测试服务收到增量与最终答复
- **THEN** 可以标记目标平台流式机制通过，但真实模型项仍保持独立状态，MCP / DTS 仍按本轮范围跳过

#### Scenario: 用户允许跳过 MCP

- **WHEN** 本轮验证无需工具接入
- **THEN** 不读取或调用现有 MCP/DTS 配置，报告明确记录本轮未测，不宣称业务只读查询通过
