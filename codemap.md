# 运维百晓生 · 源码地图

本仓库是 React + Express + SQLite 单实例运维工作空间，连接外部 Responses SSE 模型和 Streamable HTTP MCP 服务。先读 [初学者文档](docs/README.md)，再按本地图定位代码。

## 入口与根文件

| 文件 | 职责 |
| --- | --- |
| `package.json` / `package-lock.json` | 依赖、Node >=22.16、启动 / 测试 / 构建 / 运维命令与锁定版本 |
| `index.html` | 业务工作空间 HTML 入口，加载 src/main.tsx，声明共用原创 SVG 标签页图标 |
| `vite.config.ts` | React 插件、开发 /api 代理；双视图架构图入口及固定图形资源的开发路由/构建打包 |
| `tsconfig.json` | 前端严格 TypeScript 检查，noEmit |
| `.env.example` | 监听、数据、Origin、Cookie、初始管理员、模型配置说明 |
| `.gitignore` / `.dockerignore` | 排除依赖、构建和本地数据等 |
| `Dockerfile` | 前端构建、默认 Node + Python / AgentScope 镜像，非 root 用户 |
| `compose.yaml` | 单实例环境/持久卷；Python 进程池与内存/PID 限额 |
| `deploy/` / `.github/workflows/` | TLS 代理、告警模板、测试/构建/扫描/SBOM 流水线 |
| `README.md` | 项目启动入口和能力范围 |
| `AGENTS.md` | 后续代码工作发现本地图的入口 |

## 目录职责与详细地图

| 目录 | 职责 | 地图 |
| --- | --- | --- |
| server/ | 认证、资源、模型、MCP、Agent、数据库与任务调度 | [后端地图](server/codemap.md) |
| server/agent-runtime/ | 共享模型/工具桥接、AgentScope 唯一编排与私有进程客户端 | [运行时地图](server/agent-runtime/codemap.md) |
| agent-worker/ | 必需的 Python 3.12 / AgentScope 2.0.8 编排与依赖锁 | [Worker 地图](agent-worker/codemap.md) |
| integrations/dts-mcp/ | 独立本机 DTS 只读 MCP、状态映射、鉴权及接入资源 | [DTS 接入说明](integrations/dts-mcp/README.md)、[跨会话交接](integrations/dts-mcp/HANDOFF.md) |
| integrations/agent-sandbox/ | 独立代码服务、容器生命周期、产物扫描/审批和受治理 MCP | [沙箱地图](integrations/agent-sandbox/codemap.md)、[接入说明](integrations/agent-sandbox/README.md) |
| deploy/observability/ | Collector、Tempo、Prometheus 与多工作空间汇总规则 | [部署与账单说明](deploy/observability/README.md) |
| deploy/company-sandbox/ | 公司沙箱独立PoC镜像、私有运行时/Python范围下载、离线wheel备选、启动/严格状态与聊天校验；不迁移资源/任务/通知 | [新手部署教程](docs/company-sandbox-tutorial.md)、[部署包](deploy/company-sandbox/README.md)、[实测说明](docs/company-sandbox.md) |
| deploy/dts-sandbox/ | 最小Node锁定包、Linux服务/SSH监督器、真实SDK只读探针；助手PoC须显式配置DTS接入 | [独立部署](docs/dts-sandbox.md)、[脚本说明](deploy/dts-sandbox/README.md) |
| src/ | React 应用装配、API 客户端、界面文案、样式 | [前端地图](src/codemap.md) |
| src/components/ | 登录、聊天、编辑器、设置、任务与会话组件 | [组件地图](src/components/codemap.md) |
| scripts/ | 开发启动、文档构建、运行时评测、依赖/镜像审计与容器验收 | [脚本地图](scripts/codemap.md) |
| tests/ | Node 集成测试与受控模型 / MCP HTTP fixture | [验证说明](docs/operations.md) |
| docs/ | 面向初学者的完整架构、流程、操作、参考与交接文档 | [阅读入口](docs/README.md) |
| docs/examples/ops-onboarding/ | 独立教学手册、ZIP Skill 源文件、工具策略、附件与本机只读 MCP 示例 | [接入实操教程](docs/ops-onboarding.md) |
| docs/site/ | 可直接打开和部署的静态官网、独立交互架构图 | [官网](docs/site/index.html) |
| docs/web/ | 官网 CSS、浏览器 JS、图示与交互教学数据源 | [官网维护说明](docs/site/README.md) |
| docs/diagrams/ | 系统架构规格与请求流程步骤/示例JSON；请求图由docs/web模板确定性生成 | [架构规格](docs/diagrams/architecture.json) |
| .data/ | 本地运行数据与密钥，Git 忽略 | 不读取或提交真实凭据 |
| dist/、node_modules/ | 构建输出、安装依赖 | 非源码 |
| .slim/ | codemap 与本地实施进度 | 非产品运行数据 |

## 主调用链

```text
src/main.tsx → App → Workspace → Chat.send
  → api.chatStream → POST /api/chat
  → app 中间件 → auth 用户校验 → agentRoutes
  → execution.run（持久幂等、额度、先发送受理runId再排队）→ engine.execute
      → store 权限与会话锁
      → agent-rollout 固定本轮增强策略（作用范围 / 生效版本）
      → retrieval.retrieve
      → mcp.connectMcp / discover
      → agent-context（可选完整轮次预算裁剪）
      → agent-runtime（AgentScope Python stdio Worker）→ model.completion
      → execution.callStep → 策略/Schema/审批 → SDK callTool → 核验
      → evidence-report（可选实际步骤/来源快照）→ store 消息与审计 → NDJSON done
  → Chat 增量渲染正文/回复上方ChatRunStatus/输入框内停止 → done后回读GET /conversations/:id
  → 显示断线或45秒无数据：按runId（缺失则本人requestKey）只读找回原执行，不重POST

scheduler.tick / POST /tasks/:id/run
  → claim 事务 → perform → 同一 engine.execute
  → task_runs 结果与会话关联 → inspection 实际工具证据判定
  → 同一事务 notification_events / notification_deliveries
operations.tick → notifications.tick → Webhook / 企业微信确认与重试
```

## 阅读和改动原则

首次接手先读 [代码库与目录说明](docs/repository-guide.md)，再按上表进入模块地图。权限、模型出口、工具审批与持久化由后端控制；前端负责交互和显示。Python Worker 是必需的 AgentScope 编排进程，独立服务在 integrations/，部署材料在 deploy/。

修改接口同时核对 src/api.ts 与使用组件；修改数据库需显式迁移。功能与文档同步遵循 [agent.md](agent.md)，验证执行 npm test、npm run build、npm run docs:build、npm run docs:check。

当前功能见 [架构](docs/architecture.md)、[运行指南](docs/agentscope-runtime.md)、[自主委派](docs/agent-delegation.md)。历次实测、发布与未验证边界集中在 [验证记录](docs/verification.md)，学习过程见 [学习迭代台账](docs/learning-evolution.md)，变更方案见 openspec/changes/。
