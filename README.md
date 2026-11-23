# 运维百晓生 · AI 运维工作空间

[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)

连接知识库、Skill 与 MCP 的开源运维助手。支持对话、定时巡检、审批与执行追踪；采用 React、Node.js、SQLite 和 AgentScope。

[贡献指南](CONTRIBUTING.md) · [安全说明](SECURITY.md) · [开源说明](OPEN_SOURCE.md)

左侧「AgentScope 入门」下方新增独立 [文档中心](docs/document-center.md)：阅读和搜索本项目用户文档，管理员可编辑原文件并同步离线文档网站。直达地址 `#documents`。

React / TypeScript / Vite + Node.js / Express / SQLite 运维工作空间。连接兼容 OpenAI Responses API 的模型和 MCP Streamable HTTP 服务，提供知识检索、已审核指令、对话、定时任务、受控工具执行、审批和结果核验。

所有聊天和定时任务统一使用 AgentScope 2.0.8 / Python 3.12 编排，已移除旧循环和运行时回退。默认预加载进程池，每轮独立子进程；cold 模式同样使用 AgentScope。安装、探针、容器与增强配置见 [AgentScope 运行指南](docs/agentscope-runtime.md)。

阅读入口：[使用手册](docs/README.md) · [代码库与目录说明](docs/repository-guide.md) · [源码总地图](codemap.md) · [文档中心](docs/document-center.md)。实际验收范围见 [验证记录](docs/verification.md)。

## 本地启动

需要 **Node.js >=22.16、Python 3.12 和 uv**（在线备份使用内置 node:sqlite backup）。

```sh
git clone https://github.com/GpsLypy/aiops-workspace.git
cd aiops-workspace
npm ci
uv sync --project agent-worker --frozen
npm run agent:check
npm run dev
```

前端 http://localhost:5173，API http://127.0.0.1:3001。首次创建管理员，没有默认密码。配置参考 `.env.example`；开发默认本地账号，生产采用更严格的启动检查。

## 接通实际服务

1. 工作空间设置中填写模型 Base URL、模型 ID 与 API Key，保存后测试。
2. 添加真实 Markdown 知识，设置版本、来源、有效期与读者权限。
3. 创建 Skill / 子领域；成员创建的是草稿，管理员审核后发布。编辑后重新发布。
4. 管理员配置 MCP 地址与 Token，连接发现工具，选择 allowedTools，并填写每个工具的风险、角色、环境和参数范围策略。
5. 先用只读工具验证问答。模型可生成写操作计划，但需在“执行与审批”中心核对、批准后才能执行。
6. 生产或高风险操作要求另一位管理员审批，远程写工具需支持幂等键和只读结果核验。
7. 按需要创建单次 / Cron 任务或固定 Runbook。自动处置默认关闭，高风险操作不能自动执行。

生产数据来自你配置的服务。示例资料与本地测试模型不会写入正常 `.data/`。

## 能力

| 范围 | 当前实现 |
| --- | --- |
| 身份 | 密码哈希、HttpOnly 会话、登录限流、初始化凭证、签名企业 MFA 网关适配 |
| 治理 | 资源 ACL、指令发布与版本回滚、工具角色/用户/环境/参数约束、JSON Schema 校验 |
| 知识 | Markdown、SQLite FTS5 中文分词索引、权限与有效期过滤、版本引用、文本 URL 同步 |
| Agent | AgentScope 模型工具编排、工具发现缓存、MCP 连接熔断与降级、进度流、历史与引用 |
| 执行 | 持久 run/step、幂等请求、队列、全局/用户并发、token/费用预算 |
| 变更 | 固定参数审批、双人生产审批、有效期、变更窗口、远程幂等键、结果核验与 unknown 对账 |
| 调度 | 单次、Cron、时区、数据库租约、恢复后补一次、暂停与手动执行 |
| Runbook | 最多八个固定步骤、双人发布、签名告警、事件去重、显式开启的低风险自动处置 |
| 运维 | 日志 requestId、ready/metrics、审计哈希链与导出、Webhook 通知、紧急停止 |
| 数据 | 外置主密钥、在线加密备份、新目录恢复、离线副本密钥轮换、受控会话留存清理 |

## 部署

```sh
npm run build
npm start
```

本地同源服务默认在 127.0.0.1:3001。正式部署设置 NODE_ENV=production；必须提供 HTTPS APP_ORIGIN、COOKIE_SECURE=true、AUTH_MODE、MASTER_KEY_FILE、OUTBOUND_ALLOWED_ORIGINS。生产 Compose 同样要求显式提供这些配置和外部 32 字节密钥。

```sh
docker compose up --build -d
```

详细配置、身份网关协议、网络出口、备份恢复、审批、Runbook 与告警格式见 [生产手册](docs/production.md)。[Nginx 示例](deploy/nginx.conf.example) 与 [告警规则](deploy/alerts.yml) 需要按实际环境配置。应用只能运行一个副本，不能共享 SQLite 部署多个 worker。

## 数据与升级

默认数据库为 `.data/aiops.sqlite`；生产密钥由 `MASTER_KEY_FILE` 挂载。数据库按版本顺序迁移，不自动降级；备份、恢复和换钥步骤见 [部署与接手](docs/operations.md)，数据结构见 [接口参考](docs/reference.md)。生产切换前先验证恢复副本；远程调用结果未知时不自动重放。

## 测试、文档与官网

```sh
npm test
npm run build
npm run verify:production
npm run test:load
npm run docs:build
npm run docs:check
```

测试使用临时数据库与真实本地 HTTP/MCP 协议服务。负载演练使用本地模型 fixture，不代表供应商生产容量。持续验证流程见 [.github/workflows/verify.yml](.github/workflows/verify.yml)。

[初学者手册](docs/README.md) · [接入自己的运维系统：完整实操教程](docs/ops-onboarding.md) · [架构](docs/architecture.md) · [源码地图](codemap.md) · [离线官网](docs/site/index.html) · [实际验证记录](docs/verification.md)

已实现接入：[DTS cn_east 本机只读 MCP](integrations/dts-mcp/README.md)，包含 macOS launchd 部署、指定任务列表或区域全部任务模式、状态新鲜度判断及工作空间资源初始化/策略同步。

独立公司沙箱部署见[DTS MCP独立沙箱](docs/dts-sandbox.md)：最小Node包、loopback MCP、受限SSH转发及助手PoC显式只读接入；服务/执行中心与真实模型验收分开记录。

## 更多说明

- [巡检通知](docs/notifications.md)：企业微信、Webhook、任务判定与重试。
- [Agent 开发](docs/agent-development.md)：模板、学习和能力路线。
- [运行时](docs/agentscope-runtime.md)：增强开关、独立复核和进程管理。
- [自主委派](docs/agent-delegation.md)：只读子 Agent 与父子全景。
- [生产治理](docs/production.md)：上线门禁、审批和外部依赖；本项目按单实例部署。

功能说明不代表真实供应商、身份网关或生产基础设施已经验收。各项实测范围与未完成部分统一见 [验证记录](docs/verification.md)。

## 开源许可

本项目原创代码采用 [MIT License](LICENSE)，可用于学习、修改、分发和商业使用。第三方依赖遵循各自许可证，见[开源说明](OPEN_SOURCE.md)。`package.json` 的 `private: true` 仅防止误发布 npm 包，不限制源代码使用。
