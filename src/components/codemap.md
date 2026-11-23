# src/components/ · 页面组件地图

## 组件职责

| 文件 | 组件 / 关键函数 | 输入与输出 |
| --- | --- | --- |
| [Auth.tsx](Auth.tsx) | Auth、load、submit | /auth/status 判断初始化；提交 setup / login，onLogin 回传用户 |
| [BrandMark.tsx](BrandMark.tsx) | BrandMark | 共用原创 SVG，指定尺寸，用于登录、启动、侧栏、欢迎页与助手头像；装饰图不重复朗读旁边名称 |
| [AgentSelector.tsx](AgentSelector.tsx) | AgentSelector、focusOption | 有框入口/用途菜单、可见启用候选、历史锁、键盘焦点与窄屏定位；选择回调由Chat处理 |
| [ChatRunStatus.tsx](ChatRunStatus.tsx) | ChatRunStatus | 回复上方的动作/恢复阶段/倒计时/耗时；单独刷新计时，共用耗时格式，320px换行 |
| [Chat.tsx](Chat.tsx) | Chat、send | 用户 / 资源 / 会话 ID → 问题与附件 → chatStream 增量草稿 → 完成后回读会话 |
| [EvidenceReport.tsx](EvidenceReport.tsx) | EvidenceReport | 版本 1 消息快照 → 原生 details 展开、实际步骤/来源/限制、本地 JSON 导出 |
| [AgentReview.tsx](AgentReview.tsx) | AgentReview | 版本 1 双 Agent 复核记录 → 两阶段用量、中文原因、键盘 details 与原样 JSON 导出 |
| [AgentLearning.tsx](AgentLearning.tsx) | AgentLearning、moveTo、downloadNotes | 静态六主题 → 选课/源码实验/折叠面试答案、当前视图自评笔记、Markdown 导出；不执行命令或调用模型 |
| [ResourceEditor.tsx](ResourceEditor.tsx) | ResourceEditor、submit、discover、binding | 四种资源表单、Skill ZIP 上传/预览/下载、知识 Markdown 导入、授权、MCP 发现与只读目标策略示例、子领域绑定 |
| [ResourceEditor.tsx](ResourceEditor.tsx) | KnowledgeDetail | 正文 / 范围 / 管理人页签、原稿与预览 |
| [RuntimeRollout.tsx](RuntimeRollout.tsx) | RuntimeRollout | 管理员 Agent 增强草稿/生效版本、增强范围与选项、保存/预检/启用/暂停、CAS 冲突刷新 |
| [Settings.tsx](Settings.tsx) | Settings、load、action、saveModel | 固定高度弹窗与读取状态，内容区滚动；固定 Responses API、可留空 Temperature、90秒首字节/180秒静默超时配置及校验；公司PoC只开放强度与两项超时，连接字段锁定；配置测试、成员管理、审计、修改密码 |
| [Tasks.tsx](Tasks.tsx) | Tasks、refresh、action、submit | 任务列表 / 创建 / 查询目标补录 / 通知设置 / 启停 / 试跑 / 删除、判定与推送记录 |
| [Notifications.tsx](Notifications.tsx) | Notifications、ChannelEditor | 渠道权限/配置、测试消息、分页筛选、失败重发、投递详情 |
| [TaskNotificationFields.tsx](TaskNotificationFields.tsx) | TaskNotificationFields | 任务选渠道、推送条件、恢复和正常条件编辑 |
| [Sessions.tsx](Sessions.tsx) | Sessions | 会话摘要按关键词、Agent、日期过滤，open 进入聊天 |
| [ExecutionCenter.tsx](ExecutionCenter.tsx) | ExecutionCenter | 执行状态、固定参数提交、审批/拒绝/核验、取消、紧急停止、运维状态 |
| [Runbooks.tsx](Runbooks.tsx) | Runbooks | 固定步骤草稿、双人发布、执行与撤销 |
| [Guidance.tsx](Guidance.tsx) | Guidance | data.ts 页面引导、能力关系导航与帮助弹窗 |
| [AgentScopeGuide.tsx](AgentScopeGuide.tsx) | AgentScopeGuide | 教学模板、开发边界与目标绑定/质量/观测/沙箱的当前状态及后续门禁 |
| [LocalDeployment.tsx](LocalDeployment.tsx) | LocalDeployment、refresh、selectFile、reconcile | 部署用途/流程、管理员本机状态与历史验收摘要、内存账单上传/演示/对账/结果下载，普通成员只读解释 |
| [ToolCatalog.tsx](ToolCatalog.tsx) | ToolCatalog | 当前可见 MCP 的配置目录：允许列表去重、服务筛选、风险与目标确认标记、审批提示、跳转资源详情 |
| [ui.tsx](ui.tsx) | Button、Badge、Empty、Markdown、Modal | 共享控件，Markdown 清理，弹窗 Escape / 焦点循环 / 恢复；可选弹窗与遮罩类名供设置页稳定布局 |

## 聊天交互

2026-10-15：DocumentCenter 的首页/阅读页架构图链接打开双视图静态图形查看器；正文仅对固定架构图路径做映射，其他源码链接仍提示路径。查看图形不离开当前文档，不清空编辑草稿。

Chat props 来自 Workspace。conversationId 变化时加载历史，新会话清空；发送期间通过 sendingId 避免 session ID 回传触发重复加载。mounted 与 currentId 防止异步响应更新已卸载组件或错会话。

send 验证非空、本人会话、busy 与 20,000 字符限制，通过同步busyRef阻止同刻双发；先用共享 [createRequestKey](../request-id.ts) 生成requestKey，成功才清空草稿/附件/目标并发送。execution 事件显示受理 ID，session 设置会话 ID，progress 更新状态，model_retry区分等待/连接与原因/次数/延迟，正常增量或执行阶段恢复后清除。ChatRunStatus显示于当前回复上方，未收到正文时位于消息末尾；无背景卡片，灰色耗时配细分隔线。完成消息从持久executionTrace显示耗时，无记录的历史消息不补造。Chat输入框右下角在发送与圆形停止按钮间切换，上滚仍可操作，受理前/取消中禁用，等待退避也可取消；停止成功显示普通结束提示。message_start 建立 streamId（reason=retry时保留已显示正文）；message_delta 按相同 ID 累计当前尝试正文；message_reset 未带reason时在工具阶段撤下草稿，retry/display_disconnect只重置显示队列、保留已打印内容并标注重连，待新正文超过当前显示长度或完整终态后替换。done 使用最终 text/metadata 收敛，finally 回读持久会话避免重复；error/恢复失败清除未完成草稿。只有用户仍在底部时跟随滚动；生成提示使用轻量光标，减少动态效果偏好关闭动画。独立复核不发布候选草稿或复核 JSON。执行中心每五秒刷新，取消不意味着撤销远程副作用。

Chat、ExecutionCenter 固定工具提交与 Runbooks 执行共用同一安全随机 requestKey 入口。HTTPS/localhost 优先 `randomUUID`，普通 HTTP 沙箱用 `getRandomValues` 构造 UUID v4；安全随机源缺失时进入各页面现有中文错误提示并停止提交，不把生成标识失败当模型、工具参数或服务端错误。该兼容调整不改变布局、模型设置、工具权限或审批规则。

消息的 `metadata.mcpFailures` 在工具摘要下单独展示“未取得实时数据”，含服务名与固定检查连接说明；刷新后从已保存消息恢复，旧消息无此字段时不显示。发现失败不算工具调用，不混入实际工具摘要。该历史提示使用具名 aside，不作为每次回读都播报的实时 alert。

`metadata.context.omittedMessages` 展示较早历史省略提示。可选 `metadata.evidenceReport.version=1` 显示折叠证据面板，键盘可展开；报告标注消息生成时点、不等同业务健康或后续审批状态。JSON 下载由 Blob 本地生成并释放 URL，不新增接口；旧消息/关闭开关时不显示，不尝试从模型文字补造报告。

知识开关仅影响本次 useKnowledge，Agent 选择在已有会话时禁用。附件先在浏览器 `file.text()`，最多 60,000 字节，合并消息后仍受 20,000 字符限制。不会创建独立文件资源。受理后可点击停止生成，调用原执行cancel接口；卸载仅停止前端读取/恢复等待，不等于撤销服务端执行。

独立复核开关初始关闭，在当前挂载会话中保留选择，新会话/刷新后关闭；每次提交显式发送 reviewMode，运行中禁止切换。说明增加一次模型调用和等待时间，开启后不渲染候选增量。消息 metadata.agentReview 独立于开关持久展示 accepted/blocked/unavailable/skipped；导出只包含复核元数据，不包含候选答复或原始证据。320px 阶段信息换行，开关、details 和导出按钮支持键盘。

欢迎页以品牌、简短标题和问题示例构成；示例只填入并聚焦草稿，customize文字入口打开Skill页面。用户问题右对齐灰色气泡，助手回答无卡片且沿用全部实际证据组件。欢迎页/消息区占据可滚动剩余高度，composer不缩小；上滚停止跟随后出现「返回最新消息」，点击恢复跟随。知识/独立复核开关在输入框内部，保留switch可访问语义与生成中禁用；textarea用layout effect按草稿/窗口高度伸展到有界高度，长草稿内部滚动。执行入口位于聊天顶部，窄屏不覆盖输入。导航抽屉开关保持Chat挂载；页面切换仍卸载Chat，未发送草稿不持久化。

主输入区聚焦由 `.composer:focus-within` 的单条外边框表示，无外围光晕；仅直接子 textarea 覆盖通用 `:focus-visible` 内框，附件/Agent/发送等控件仍保持各自键盘焦点标记。

[AgentSelector.tsx](AgentSelector.tsx) 提供有边框的 Agent 入口与 portal 菜单，展示图标、用途说明和选中勾；即使仅通用也有菜单。候选来自当前可见且启用的 resources；历史/生成中锁定，停用/不可见身份保留。方向键/Home/End/Enter/Escape/Tab与外点关闭、焦点恢复；上下定位、窄屏边界和滚动。Chat 的选择回调仍清空 targetBinding，不改变服务端权限。

## 编辑器行为

writable 由 canManage 决定，MCP 还要求当前用户 admin。submit 从 FormData 构造完整资源；未填 Token 省略该字段、清除勾选发空串。PUT 全量表单和后端默认值一起决定最终数据。

MCP 先创建再 discover；工具勾选及策略 JSON 保存后生效。每工具必须显式分类与限定范围。资源带 revision，Skill/子领域编辑后为草稿；版本历史区域审核发布或回滚。知识可设版本/有效期/来源，管理员可同步文本。Markdown 导入限制 200,000 字节，正文输入限制 200,000 字符，预览不执行脚本。

新建 Skill 使用 ZIP（最多 600,000 字节），调用 /skills/inspect 解析名称、描述、版本、SKILL.md 正文与文件列表，然后将原始 base64 包随资源保存。服务端保存时重新校验，以包内正文为准；包括管理员上传在内均创建草稿。包内正文只读，更新需重新上传；历史纯文本 Skill 可继续编辑。资源详情支持下载原包；附件保存但不加入模型上下文、不执行脚本。

## 任务与会话

Tasks 五秒轮询，打开运行记录时同时读取 runs。单次时间用浏览器本地 datetime-local 转 ISO；Cron 带显式时区。立即执行返回后查看记录，不等待聊天响应。删除任务说明会删除记录而保留历史会话。

Tasks在creating变为true时用layout effect重置共享的通知/条件/错误草稿，确保新建弹窗首次可交互前不含旧设置；关闭后再创建同样重置。编辑保存仍只更新对应任务通知，未保存草稿不会修改原任务。

Sessions 只过滤后端最多 300 条摘要，没有服务端分页与删除按钮。管理员查看他人会话后 Chat 以 owner 判断为只读。

## 共享渲染与交互

Markdown = marked.parse → DOMPurify.sanitize → React HTML。Modal 记录旧焦点，挂载时聚焦可用控件，Tab 在弹窗内循环，Escape 关闭，卸载恢复焦点。焦点候选随每次按键按当前可见状态重取，包含原生 summary 和可Tab的显式 tabindex；禁用、隐藏及折叠 details 内部的控件不参与循环，展开后才进入键盘顺序。

Modal 的 drawer 参数使用同一键盘与关闭逻辑，桌面靠右、窄屏占满窗口；用于工具清单与移动导航。

这些组件不持有模型 API Key 的已存值；设置和资源 API 只返回 hasApiKey / hasToken。业务权限最终仍由服务器验证。

任务通知配置与正常条件由受控表单提交；配置规则使用实际工具字段和可选参数匹配，页面不根据模型文字猜测健康。通知中心五秒刷新，状态筛选与服务端分页，地址/凭据不回显；失败消息重发沿用快照。

TaskNotificationFields通过组件内WeakMap维护条件行身份，更新同一规则时继承身份，删除时其余规则不复用被删行的JSON输入或原生校验状态；身份不写入API。对象参数保留本行未完成的JSON草稿，数据服务变化时仅重建该输入框并同步空对象；普通字段编辑不重建输入，保持焦点和光标。

Agent 增强位于设置页管理员专属页签，所有对话统一使用 AgentScope；选择范围只控制上下文、检索和证据报告三项增强。当前生效与编辑草稿分开显示；启用依赖有效预检且无未保存改动。范围外和暂停后继续使用 AgentScope 基础配置，不提供引擎切换。暂停不提交脏草稿，重新读取会丢弃本地编辑；服务端负责真实权限/版本门禁。320px 堆叠摘要/按钮，保留 Modal 键盘流程。

## 问答全景与入门工作台

[ExecutionPanorama.tsx](ExecutionPanorama.tsx) 接收版本 1 ExecutionTrace，提供紧凑入口、实际依赖 DAG、上游高亮、节点详情、缩放/全图、键盘列表和本地 JSON 下载；新图谱的 trace/span 关联 ID 一同导出，旧消息缺少 ID 时保持兼容。Modal 经 portal 放在 body，沿用焦点管理。历史快照不随审批更新；旧消息没有数据时不显示。

[AgentScopeGuide.tsx](AgentScopeGuide.tsx) 由 #guide 和聊天欢迎页进入，以当前用户可见 resources/model 状态提供配置说明，含三种可编辑 Skill 模板、示例问题与下载；离开页面不保存编辑，不自动创建资源或执行样例。本轮进展区说明用户确认的真实需求、逐条工程复核、本机观测/账单工具与独立 Python 沙箱/产物审批，保存模型最新结果引用验证记录；明确 AI/真实模型/生产边界。入口沿用现有权限，页面状态不代表网络预检通过。

引导页模板、问题和开发命令的复制共用操作代次；切场景/视图、编辑、新复制、下载及卸载使旧反馈失效，防止迟到提示串到新内容。只约束提示，不撤销已接受的剪贴板写入。

「部署与验收」按需加载 LocalDeployment 与专用样式，`#guide?tab=deployment` 可直达/刷新。开始页提供显眼入口。管理员读取 `/api/local-services` 的固定本机检查与安全历史摘要，collector/sandbox仅标入口可达；不把已保存验收当当前源码通过。两账单文件分别持有读取代次，对账请求可取消，换文件/载入演示/卸载后旧响应不能回写；上传不创建执行/工具/账单持久记录。结果以React文本渲染，表格在窄屏内部滚动，下载在浏览器生成JSON。

引导第三视图「学习与面试」渲染 [AgentLearning.tsx](AgentLearning.tsx)，课程来自 [agent-learning.ts](../agent-learning.ts)。主题切换聚焦标题并重置折叠参考答案，但保留各课本次笔记/自评；切出学习视图或离页/刷新会卸载并清空。Markdown 导出含各课真实路径、命令及本人笔记/自评，不写入数据库或 localStorage。选择、自评、复制和导出不执行实验，不发模型/MCP/资源写请求。

复制反馈使用操作代次限定归属：切课、新复制、导出和卸载使旧请求失效，迟到的剪贴板成功或失败不能更新当前提示。只控制界面反馈，不撤销浏览器已经接受的剪贴板操作。

Chat按runId持有单个受控全景查看器，实时→完成→持久回读保持弹窗与选中节点；done不提前清空实时图谱，而是在最终答复发布的同一渲染中替换为消息快照，避免逐字显示收敛期间关闭弹窗。关闭后聚焦当前同runId入口。断流且回读失败清除暂态图谱，不把内存快照伪称历史。

全景依赖按钮和方向键/Home/End导航同时选择、聚焦并最小滚动显示目标；窄屏详情下方跳回画布时会滚动外层弹窗，避免焦点停在屏幕外。普通鼠标选择仍只调整画布内部可见区域。

## 项目文档中心

[DocumentCenter.tsx](DocumentCenter.tsx) 通过 /documents 与 /documents/content 获取当前部署用户文档，按官网分类并包含部署/集成与教学材料；成员可读下载、管理员编辑。保存原稿带 revision，成功才更新页面与目录；冲突/回退保持草稿。保存中禁止编辑和切换，换文档/离页/退出登录/浏览器刷新保护未保存内容。相对 Markdown 链接跳到已收录文档，源码和图示链接仅提示路径；渲染沿用清理后的 Markdown，不执行代码块。

2026-10-10：空selected对应#documents分类卡片首页，非空selected对应file参数的阅读页。首页从原文提取纯文本摘要，分类入口/全文搜索只过滤已加载目录；阅读目录按组折叠，宽屏章节从清理后的DOM提取h2/h3与唯一锚点。移动阅读默认收起目录。打开卡片/相对链接/返回首页使用pushState，hashchange恢复浏览器历史并执行未保存门禁；只在阅读状态请求单篇原稿。规范见[文档中心设计](../../openspec/changes/document-center-design-20261010/proposal.md)。

2026-10-09：Chat用stream-reveal按帧显示真实正文、恢复时清理旧队列并保留已显示正文、取消/离页清理草稿；Markdown用memo避免未变化历史重解析，自动跟随只滚动消息容器。chatStream断线有runId时只读恢复既有执行，绝不重发问题；减少动效时批量显示。

2026-10-09：ReasoningEffortControl.tsx 提供输入框旁三档描述菜单：快速/均衡/深度、默认徽标、选中勾、恢复系统默认/服务商默认。portal 固定定位避免窄屏裁切，方向键/Home/End、Escape/焦点恢复/外点关闭；生成中禁用。Chat 仅当前挂载保留覆盖选择，消息徽标展示持久当轮档位。Settings 管理默认，不支持参数可保存 null。

2026-10-10：Chat显式允许委派、历史实际数量提示；ExecutionPanorama以agentRunId/parentAgentRunId/parentNodeId区分父子处理链，加入委派/子Agent/预算/回传/汇总节点、Agent分组定位和父入口跳转。AgentScopeGuide同步首版单层只读能力。

文档中心按使用、代码库、原理、运维、学习和历史验证组织；代码库速览直达前端、后端与Worker地图。公开源码地图由 docs/web/content.mjs 明确登记，server/documents.mjs 仅放行登记路径，继续拒绝隐藏、越界和符号链接。目录总览见 [代码库说明](../../docs/repository-guide.md)。
