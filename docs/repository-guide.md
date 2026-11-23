# 代码库与目录说明

**改页面看 `src/`，改接口和业务看 `server/`，改 AgentScope 编排看 `agent-worker/`。** 三者属于同一个应用；`deploy/` 是部署材料，`node_modules/` 是安装依赖。

## 前端、后端和 Worker 怎么配合

```text
浏览器里的 React 页面（src/）
  → 同源 /api 请求 → Node.js / Express 后端（server/）
  → 私有进程协议 → Python / AgentScope Worker（agent-worker/）
  → 回到 Node，由 Node 请求外部模型、校验并调用 MCP 工具
  → 后端保存 SQLite 数据，把进度与回答返回页面
```

开发时 Vite 默认提供 5173 页面，将 `/api` 代理到 3001 后端。构建后页面写入 `dist/`，由后端提供静态文件；Worker 没有单独的网页或 HTTP 端口。模型服务和 MCP 服务是外部依赖，不在浏览器中执行。

## 根目录逐项说明

| 目录 | 对应模块或功能 | 什么时候看 |
| --- | --- | --- |
| `src/` | **前端源码**：React、TypeScript、页面、API 客户端、样式 | 改聊天、文档中心、资源、任务、设置和响应式布局 |
| `server/` | **后端源码**：Express、登录授权、业务 API、SQLite、模型/MCP、执行与调度 | 改接口、权限、持久化、工具策略、任务和通知 |
| `agent-worker/` | **Python AgentScope 编排**：Agent 对话、模型/工具桥接、进程池 | 改 Agent 编排和 Worker 协议；Python 3.12、AgentScope 2.0.8 依赖在这里锁定 |
| `integrations/` | 独立接入服务：DTS 只读 MCP、受控代码沙箱 | 接入外部运维系统或运行独立服务 |
| `deploy/` | 部署配置与操作脚本：公司 PoC、DTS 独立沙箱、TLS、观测栈 | 打包、部署、配置代理或观测服务 |
| `scripts/` | 开发启动、文档生成、评测、审计、浏览器验收与部署辅助 | 查 npm 命令真正执行了什么 |
| `tests/` | Node 测试、受控模型/MCP 夹具和验收数据 | 验证业务、安全、协议和恢复行为 |
| `docs/` | 用户手册、教程、接口参考、验证记录和离线文档网站源 | 查功能和操作方法、维护文档 |
| `openspec/` | 变更提案、设计、任务与行为规范 | 理解某次变更的范围和验收要求 |
| `.github/` | CI 工作流：测试、构建、扫描和供应链材料 | 查自动化检查 |
| `.codex/` | 本地 Codex 工作配置 | 查开发工具配置，不属于业务应用 |
| `.slim/` | 辅助源码地图与本地实施进度 | 查开发辅助记录 |
| `.data/` | 本地运行数据，如 SQLite、密钥和备份；可由部署配置改位置 | 排查持久化和恢复，不提交实际数据与凭据 |
| `dist/` | Vite 生成的前端发布文件 | 检查构建产物；页面改动从 src/ 修改再构建 |
| `node_modules/` | npm 安装的第三方依赖 | 排查依赖；版本由 package.json 和锁文件维护 |
| `test-results/` | 浏览器截图、评测报告和验收产物 | 查看一次验证的证据，不属于运行代码 |
| `.git/` | Git 版本管理元数据 | 管理版本，不手动修改内部文件 |

## 常用子目录

| 目录 | 职责 | 详细说明 |
| --- | --- | --- |
| `src/components/` | 聊天、登录、文档中心、资源编辑器、任务等界面组件 | [组件地图](../src/components/codemap.md) |
| `src/assets/` | 共用品牌 SVG 等静态资源 | [前端地图](../src/codemap.md) |
| `server/agent-runtime/` | Node 与 Python Worker 的运行时适配、模型/工具桥接和进程客户端 | [运行时地图](../server/agent-runtime/codemap.md) |
| `integrations/dts-mcp/` | DTS REST 到 Streamable HTTP MCP 的独立只读适配 | [接入说明](../integrations/dts-mcp/README.md) |
| `integrations/agent-sandbox/` | 独立代码服务、容器生命周期与受治理 MCP | [沙箱说明](../integrations/agent-sandbox/README.md) |
| `deploy/company-sandbox/` | 公司助手 PoC 的打包、运行时安装、启动与校验 | [部署教程](company-sandbox-tutorial.md) |
| `deploy/dts-sandbox/` | DTS MCP 独立 Node 服务与 SSH 转发 | [独立部署](dts-sandbox.md) |
| `deploy/observability/` | Collector、Tempo、Prometheus 与汇总规则 | [观测部署](../deploy/observability/README.md) |
| `docs/web/` | 离线官网样式、交互与章节目录源 | [官网维护](site/README.md) |
| `docs/site/` | 生成的离线官网与独立架构查看器 | [离线官网](site/index.html) |
| `docs/diagrams/` | 架构图的可编辑规格 | [架构说明](architecture.md) |
| `docs/examples/` | 教学 Skill、工具策略、附件与 MCP 示例 | [接入实操](ops-onboarding.md) |

DTS 的原业务前端在 `/path/to/dts/application/DRCManagement`，业务后端在 `/path/to/dts`。本仓库的 `integrations/dts-mcp/` 负责接入它们；继续 DTS 接入前先读 [交接说明](../integrations/dts-mcp/HANDOFF.md)。

## 根文件看什么

| 文件 | 用途 |
| --- | --- |
| `package.json` / `package-lock.json` | npm 命令、依赖声明和精确依赖版本 |
| `index.html` / `vite.config.ts` / `tsconfig.json` | 前端入口、开发代理、TypeScript 检查 |
| `Dockerfile` / `compose.yaml` | 应用镜像、Node/Python 环境、卷和运行限额 |
| `.env.example` | 可配置项的示例；实际 .env 文件保存部署配置，不提交凭据 |
| `.gitignore` / `.dockerignore` / `.ignore` | Git、镜像上下文与开发搜索的忽略规则 |
| `README.md` | 快速启动入口 |
| `codemap.md` | 全仓模块、入口和主调用链 |
| `AGENTS.md` / `agent.md` | 开发代理约定、功能与文档同步规则 |

## 按修改目标找入口

| 你要做什么 | 从哪里开始 | 配套阅读 |
| --- | --- | --- |
| 调整页面或样式 | src/App.tsx → src/components/ → 对应 CSS | [前端地图](../src/codemap.md) |
| 新增或调整接口 | server/app.mjs → 对应路由；同步 src/api.ts | [后端地图](../server/codemap.md)、[接口参考](reference.md) |
| 改问答和工具执行 | server/agent.mjs、execution.mjs、agent-runtime/；编排再看 agent-worker/worker.py | [一条消息的旅程](conversation.md)、[Worker 地图](../agent-worker/codemap.md) |
| 改文档中心内容或分类 | docs/*.md、docs/web/content.mjs；页面在 src/components/DocumentCenter.tsx | [文档中心](document-center.md) |
| 改启动、测试或打包 | package.json → scripts/ 或 deploy/ | [脚本地图](../scripts/codemap.md) |

开发启动用 `npm run dev`，前后端由统一脚本管理；功能修改后运行 `npm test`、`npm run build`。文档修改后更新 [验证记录](verification.md)，执行 `npm run docs:build` 和 `npm run docs:check`。不要手工修改生成的 `dist/` 和 `docs/site/index.html`。
