# 静态官网维护说明

打开本目录的 [index.html](index.html) 即可离线阅读官网与完整手册；[architecture.html](architecture.html) 是可缩放、搜索和导出的独立架构图。静态托管时发布整个 `docs/site/` 目录即可，没有后端要求，也不依赖外网字体或 CDN。

应用构建通过 `vite.config.ts` 打包双视图入口 `/architecture.html`：系统图来自本目录 `architecture.html`，请求流程来自 [request-flow.html](request-flow.html)，分别发布到 `/diagrams/system.html` 与 `/diagrams/request-flow.html`。入口源文件为 [architecture-viewer.html](../web/architecture-viewer.html)，开发服务提供相同路径；入口和图表均为静态公开说明，不包含账号、业务数据或真实执行进度。查看器的外网字体不可用时使用本机字体，阅读和交互可继续使用。

## 内容从哪里来

- `docs/*.md`：入门、接入实操、设计、流程、上下文、参考、生产治理与运维正文。
- `docs/ops-onboarding.md`：根据全流程验收整理的完整课程；配套可运行材料位于 `docs/examples/ops-onboarding/`，不内嵌为官网可下载文件，运行练习需保留仓库。
- 根目录和 `server/`、`src/`、`src/components/`、`scripts/` 的 `codemap.md`：源码阅读地图。
- `docs/verification.md`：本次实际完成的验收及验证边界。
- `docs/web/content.mjs`：目录元数据和教学步骤演示。
- `docs/web/diagrams.mjs`：从文档图源生成离线 SVG 阅读视图。
- `docs/web/site.css`、`docs/web/site.js`：官网布局、搜索、主题、目录与步骤交互。
- `src/assets/baixiaosheng.svg`：与工作空间共用的原创标志，构建时内联用于标题栏与标签图标，并纳入一致性摘要。
- `docs/diagrams/request-flow.json`、`docs/web/request-flow.html`：普通聊天流程的步骤数据和独立SVG/手机列表模板。
- `scripts/build-request-flow.mjs`：从步骤数据与模板确定性生成请求流程HTML，校对节点与示例引用。
- `scripts/build-docs.mjs`：生成/检查请求流程，再编译完整官网HTML，重写章节链接并检查本地链接。

## 更新正文与官网

在项目根目录执行：

```sh
npm run docs:build
npm run docs:check
```

构建内联 CSS、JavaScript、所有正文和图示。首页 `index.html` 本身可单文件分享；点击独立架构图需要同时保留 `architecture.html`。文档中的源代码链接在官网中显示为源码路径，源码阅读需打开原仓库。

关闭 JavaScript 后全文仍按顺序展示；启用后提供章节切换、标题 / 正文搜索、目录、消息旅程、上下文组装演示、主题和代码复制。正文图示可点击“放大阅读”，在弹窗里缩放与滚动。打印当前章节可使用“打印本章”；“打印全部”会展开全文。官网演示不发起真实模型或工具调用。

首页以 14 个教学步骤介绍主要对话链路，完整正文补充幂等、排队、发布、审批和核验分支；生产治理章节列明实际上线门禁。演示不调用真实模型或工具。

## 更新独立架构图

规格在 `docs/diagrams/architecture.json`。当前产物使用本机安装的 Archify skill 生成，普通文档重建不依赖这个本地工具，也不重新生成架构查看器。

请求流程数据为 [request-flow.json](../diagrams/request-flow.json)，模板为 [request-flow.html](../web/request-flow.html)。它是独立的过程视图，不使用Archify组件布局：编号主线、判断、只读回路和独立审批泳道；提供三个示例、上/下一步、可暂停演示、节点说明、主题与完整SVG导出。手机展示相同数据的顺序列表，重复步骤标明返回，审批前标明本轮结束。

`npm run docs:build` 同时生成请求图和离线官网；`npm run docs:check` 校对两者的新鲜度。图源改动后先执行这两条命令，再 `npm run build`，使应用打包相同产物。系统图继续由Archify独立生成；不要把旧请求组件图的visual-check材料当作新版流程图验收。

维护架构图时，使用你安装的 Archify 路径执行 `validate architecture` 与 `deliver architecture`，输入规格、输出本目录 `architecture.html`，质量参数 `--quality showcase --json`；随后执行 `visual-check`。这些工具不包含在本项目 npm 依赖里。

不要手改已交付的架构 HTML 来躲过规格校验。浏览器布局检查证据可保存在本目录 `architecture.visual-check*` 文件中；这些是生成的检验材料，不包含运行数据或凭据。

## 验证边界

`docs:check` 校验源文档本地链接、生成文件一致性、站内重复 ID / 锚点和本地资源。它不声称自动证明每一句解释与代码语义一致；修改业务行为后仍需人工核对相应章节和集成测试。

独立架构查看器在不可信浏览器限制或不支持的导出格式下可能无法完成部分导出，以查看器实际提示为准；正文和图示阅读不依赖导出功能。
