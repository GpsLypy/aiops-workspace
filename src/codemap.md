# src/ · 前端代码地图

## 职责

React 19 + TypeScript 的单页工作空间。当前用户、可见资源、会话摘要由后端提供，前端负责交互和显示；权限与持久化不依赖本地页面状态。

## 文件职责

| 文件 | 职责 |
| --- | --- |
| [main.tsx](main.tsx) | createRoot + StrictMode，加载基础样式与 backend.css |
| [assets/baixiaosheng.svg](assets/baixiaosheng.svg) / [vite-env.d.ts](vite-env.d.ts) | 原创“百”字品牌矢量图，标签页与界面共用；Vite 静态资源类型声明 |
| [App.tsx](App.tsx) | App 启动检查 /auth/me；Workspace 管理菜单、hash、资源 / 会话 / 模型状态、最近对话单条删除与已加载本人会话清理、编辑弹窗、前台入口 |
| [api.ts](api.ts) | User / Resource / Conversation / Task / TargetBinding / McpFailure / ContextStats / EvidenceReport / RuntimePolicy / AgentRollout 类型（统一 AgentScope，范围仅控制增强）、JSON HTTP、NDJSON、消息证据、日期 / 错误格式 |
| [request-id.ts](request-id.ts) | Chat、固定工具与 Runbook 统一生成安全随机 UUID v4 requestKey；兼容公司 HTTP 沙箱，无安全随机源时中文报错并停止提交 |
| [stream-reveal.ts](stream-reveal.ts) | 真实已收正文按帧显示/积压加速/完成收敛、Unicode代理对和减少动效；重试重置队列且保留已打印内容、新正文追上后替换；离页清理 |
| [data.ts](data.ts) | Page 类型、页面标签、引导文案、明确标记的示例 Markdown；不是业务数据源 |
| [styles.css](styles.css) | 工作空间结构、侧栏、列表、编辑器与通用响应式样式 |
| [backend.css](backend.css) | 真实后端接入页面的登录、设置、聊天、任务等补充样式；在 styles 后加载 |
| [settings.css](settings.css) | 固定高度设置弹窗、内容区独立滚动及模型超时双列/窄屏单列表单 |
| [production.css](production.css) | 执行审批中心、状态卡片、固定流程表单的补充样式 |
| [workspace.css](workspace.css) | 基础工作空间补充样式：导航、对话、MCP 缺口、证据报告/历史省略提示、定制入口与工具抽屉 |
| [chat-design.css](chat-design.css) | workspace.css 后加载的聊天专用视觉：浅灰会话侧栏、紧凑标题、用户气泡/助手正文、统一输入、短屏与320px布局 |
| [notifications.css](notifications.css) | 通知中心、任务通知条件、消息预览与窄屏布局 |
| [agent-learning.ts](agent-learning.ts) | 六主题静态学习数据：原理、真实源码/函数、实验命令、预期观察与面试追问；不发网络请求 |
| [agent-learning.css](agent-learning.css) | 学习课程目录、源码与实验手册、自评/笔记和 320px 布局，沿用引导页视觉 |
| [local-deployment.css](local-deployment.css) | 按需加载的本机部署/历史验收、账单文件与差额表、沙箱流程和窄屏内部滚动 |
| [components/AgentSelector.tsx](components/AgentSelector.tsx) | 输入区有框Agent入口、说明/勾选菜单、键盘焦点、历史锁与窄屏定位 |
| [components/](components/codemap.md) | 各功能组件，详见组件地图 |

## 数据与控制流

App 挂载请求当前用户；失败进入 Auth。登录后 Workspace `refresh()` 并行请求 resources、conversations、model/status。路由用 location.hash 和 React page 状态，没有 React Router。

`go(page)` 更新 hash、重置筛选并关闭详情；hashchange 支持浏览器前进 / 后退页面类别。conversationId 留在内存，新建 / 打开会话通过 chatVersion 让 Chat 重新挂载。

资源列表在浏览器过滤和分页；后端 GET /resources 已做用户可读过滤。Skill / MCP 的“我的”按 canManage 过滤；所有列表都不代表匿名目录。保存后更新 resources 本地数组，删除后移除对应项，刷新再与服务器对齐。

760px 及以下以 Modal 抽屉提供导航与最近会话；go() 关闭导航。Skill/MCP 的工具目录复用当前 resources，在浏览器按允许列表去重、搜索和筛选，不发起工具发现或调用。main.tsx 在基础样式之后加载 workspace.css。

## API 客户端契约

`api<T>()` 访问 `/api${path}`，设 JSON 类型，解析错误；非 auth 普通请求 401 时发 `auth-expired` 事件给 App。`post` / `put` / `patch` / `remove` 统一包装，DELETE body 为 `{}`。

`chatStream()` 使用 fetch、ReadableStream 与 TextDecoder 按换行分帧，处理跨块 UTF-8。execution 事件给出 runId，message_start/delta/reset 管理本次模型正文草稿，done/error 为终止事件；45秒无数据或断线缺终态则只读GET原执行恢复结果（总450秒/单次GET15秒/连续网络错误5次）；未知runId按本人requestKey找回，找不到则提示核对，401通知auth-expired。浏览器不重发POST问题。Chat用同步提交锁防同刻双发，安全随机ID生成成功才清草稿；ChatRunStatus在当前回复上方显示灰色耗时、动作和重试原因/次数/倒计时；Chat在输入框右下角以圆形停止按钮替换发送按钮，原执行受理后可取消。完成耗时从持久executionTrace读取，旧记录不补造。Chat用stream-reveal按帧呈现真实正文，retry/display_disconnect保留已打印草稿并标注重连，终态读回持久消息；组件卸载停止前端连接和队列，已受理后端继续。

`createRequestKey()` 优先使用浏览器 `crypto.randomUUID()`；公司内网普通 HTTP 地址不是安全上下文，该方法不可用时改用 `crypto.getRandomValues()` 生成符合版本/变体位的 UUID v4。两种路径均依赖安全随机源，不使用时间戳或 `Math.random()`；完全缺少安全随机源时显示中文错误并在发请求前中止。请求幂等契约、后端权限和持久化行为不变。

api.ts 的 AgentReview 类型描述 version=1 的独立复核结果和两阶段用量。Chat 每轮发送 reviewMode，默认 off；开启时还在 UI 拒绝暂显增量，最终以持久消息收敛。AgentReview 负责折叠详情和 JSON 导出，沿用会话可见权限。

2026-10-08 续轮：Chat 和 Tasks 复用 TargetBindingControl，从当前用户可见且可用的只读工具策略读取 requiredTargetFields；用户点击确认后才构造 targetBinding。Chat 每轮发送后清空确认，Tasks 保存或重配结构化目标；页面只是输入来源，服务端独立复查权限与参数。旧任务为空时列表提示补配。

## 状态边界

2026-10-10：聊天侧栏增加本人会话摘要的本地查找和资源/文档/入门直接入口，标题显示当前对话；不新增API或持久字段。Chat将知识与独立复核开关放进统一输入，草稿自动伸展且有上限，阅读旧消息时提供返回最新消息。新样式限定聊天范围；后台仍沿用原页面样式。见[聊天流程](../docs/conversation.md)。

草稿、附件、搜索、弹窗、当前会话 ID 是内存状态；后端数据库保存资源与会话。localStorage 没有生产业务数据迁移逻辑。渲染 Markdown 走 ui.Markdown 的 DOMPurify。

改变表单字段需同步 API 类型、后端 Zod schema 和资源默认值。改变聊天呈现需理解增量草稿与 done 后持久会话回读的关系，见 [组件地图](components/codemap.md)。

通知中心与任务同级；hash 支持 #notifications?delivery=... 与 #tasks?task=...&run=...，互链仍经后端所有者权限校验。

2026-10-03：新增 #guide「AgentScope 入门」，由 AgentScopeGuide 提供模板和学习路径；AgentScopeGuide/ExecutionPanorama 各自导入 agentscope-guide.css/panorama.css。api.ts 增加 ExecutionTrace/TraceNode 与 trace 流事件；Chat 展示实时记录和持久消息图谱，不为旧消息补造记录。

2026-10-08：Guide新增「部署与验收」，`#guide?tab=deployment`直达并保持刷新，默认开始页也有入口。LocalDeployment按需加载，解释观测/账单/沙箱用途；管理员读取固定本机状态和历史摘要，上传两文本在服务器内存对账，结果在本地下载，普通成员仅阅读用途与流程。

2026-10-08：入门页按已实现、本轮切片、后续门禁更新目标绑定/质量/观测/沙箱边界。api.ts 的 traceId/spanId/parentSpanId 为可选字段，兼容新记录与没有关联 ID 的旧消息。

同日新增引导页「学习与面试」视图，由 AgentLearning 使用静态课程数据渲染；不新增 Page/API 或数据库字段。笔记与自评仅当前组件内存保存，切课保留，切上方视图、离页/刷新清空；本地导出 Markdown，不将自评当作实测。

2026-10-09：Page 新增 documents，同级菜单位于 guide 正下方；DocumentCenter.tsx 与 document-center.css 提供目录分类/正文搜索、清理后 Markdown、相对文档链接、Markdown 编辑/预览/保存/下载，#documents?file=... 保留选择。api.ts 增加 ProjectDocument/DocumentCatalog；App 与组件共享 dirty/busy 导航门禁，取消离页保留草稿，保存中拒绝离页，读取响应通过 AbortController 防串稿。2026-10-10：#documents 无file参数显示分类卡片首页；阅读页目录按组折叠，宽屏显示正文章节导航，移动目录按需展开。选择通过pushState建立历史，hashchange处理前进/后退；返回首页复用草稿/保存保护。详见[文档中心](../docs/document-center.md)。

2026-10-10：模型设置保存问答强度及流式首字节/静默超时；首字节默认90秒，静默默认180秒且可填0禁用。api.ts 的 ModelConfig/ModelRetry 描述配置与实际超时种类，ChatRunStatus显示生效阈值；旧配置与旧客户端省略字段兼容。

2026-10-10：Workspace 最近对话提供单条删除与本人已加载会话批量清理，复用 DELETE /conversations/:id；确认、部分失败重试与当前会话重置均在前端，移动导航同样支持。

2026-10-10：Chat默认关闭的允许委派开关发送delegationMode，历史显示实际子任务数与未完成数；api.ts追加agentDelegation摘要和TraceNode可选父子运行身份。ExecutionPanorama依赖图/列表按主子Agent分组，状态/跳转/导出兼容旧图。

文档中心按使用、代码库、原理、运维、学习和历史验证组织；代码库速览直达前端、后端与Worker地图。公开源码地图由 docs/web/content.mjs 明确登记，server/documents.mjs 仅放行登记路径，继续拒绝隐藏、越界和符号链接。目录总览见 [代码库说明](../docs/repository-guide.md)。

2026-10-15：DocumentCenter 首页与阅读页提供新标签页架构图入口，将正文的固定架构图相对链接映射到 `/architecture.html`。Vite打包 docs/web/architecture-viewer.html 与两份经校验的独立图；图形交互不调用API、不使用真实会话数据，编辑草稿不受新标签页影响。
