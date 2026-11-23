# 用本项目学习 Agent：从源码到可验证实验

这条路线面向想用「运维百晓生」理解 Agent、准备技术面试的开发者。目标是能解释一次请求为什么调用工具、谁批准执行、失败后如何恢复，以及哪些结论还没有证据。先把已有系统讲清楚，再通过小实验积累自己的贡献。

这里的「持续迭代」指学习材料、实验和实现随证据更新，不表示系统会自行训练模型、修改权重或自动改写生产策略。功能现状以 [源码地图](../codemap.md)、[验证记录](verification.md) 为准，面试表达见 [Agent 面试与项目复盘](agent-interview.md)。

## 路线与完成方式

可以用约 2–4 周完成下列 8 个单元，也可以按自己的时间逐项推进。两周安排可每周完成 4 个单元；四周安排可每周完成 2 个单元，并加入复述和复盘。这是学习节奏建议，不是已经替你安排好的日程。

| 单元 | 要能解释的问题 | 本单元产物 |
| --- | --- | --- |
| 1. Agent 与 ReAct | 模型、框架和工具执行器各决定什么？ | 一次请求的调用链与停止条件 |
| 2. 上下文与检索 | 哪些信息会进入模型，超预算怎么办？ | 一份上下文组成表与检索对照 |
| 3. MCP 与治理 | 工具被发现后，为什么仍可能拒绝调用？ | 一张工具执行检查表 |
| 4. 持久执行 | 重复、审批、取消和结果未知如何区分？ | 状态转换与故障复盘 |
| 5. Worker 边界 | 为什么拆进程，为什么这还不是代码沙箱？ | cold/prefork 对照与边界说明 |
| 6. 独立复核 | 第二个 Agent 能阻止什么，不能保证什么？ | 一份复核判断表 |
| 7. 流式与全景 | 如何区分进度、正文、实际工具证据？ | 一次执行的事件时间线 |
| 8. 评测与面试 | 测试通过能支持多强的项目结论？ | 一份实验报告和 90 秒介绍 |

每个单元采用同一顺序：**读概念 → 定位函数 → 跑现有实验 → 核对断言 → 写自己的解释**。先读测试中的输入、fixture 和 `assert`，再运行命令；测试输出通常只显示用例结果，具体观察值在断言里。命令退出 0 不能替代对这些断言的理解。

建议每次留下一份简短记录：日期、代码版本或相关 diff、问题假设、运行命令、实际结果、解释、未验证项。练习产物可放在个人笔记；不要把下面的「预期观察」直接填成自己的实测结果。

工作空间的「AgentScope 入门 → 学习与面试」可按课复制命令和暂存笔记。复制反馈只对应最近一次仍有效的操作：切课、再次复制或导出笔记后，旧复制请求的迟到成功/失败提示不再出现，也不会覆盖导出提示。这只约束页面反馈；浏览器已接受的剪贴板写入不能由页面撤回，运行前仍应核对粘贴内容。当前课复制被拒绝时，可选中命令手动复制。笔记仅在当前学习视图保存，离页或刷新前应导出。

## 实验准备

所有命令均在仓库根目录执行。需要 Node.js ≥22.16、已安装的 npm 依赖，以及 Python 3.12 / 锁定 AgentScope SDK；安装方法见 [运行指南](agentscope-runtime.md)。先检查环境：

```sh
node --version
npm run agent:check
```

`agent:check` 使用真实 SDK 和本地桥接探针，不读取业务数据库或请求供应商。下面的测试默认使用临时数据库、本机随机端口上的模型/MCP fixture；其中的 `production` 是模拟策略字段，不表示连接真实生产服务。fixture 的来源可直接检查 [fixtures.mjs](../tests/fixtures.mjs) 和 [runtime-fixture.mjs](../tests/runtime-fixture.mjs)。测试需要本机端口和子进程权限。

本章命令不带 `--real`、不加载 `.env`，评测生成的报告在 Git 忽略的 `test-results/`。不要为学习实验改动正常 `.data/` 或真实资源。依赖安装可能访问软件包仓库；业务实验本身不需要真实模型 Key、企业 MCP 或 DTS 账号。若 shell 已额外导出特殊生产配置，应先使用普通开发配置再运行。

## 单元 1：把一次 Agent 请求拆开

建议先做[逐步 ReAct 实验](agent-react-lab.md)：`npm run agent:learn:react` 会生成正常往返、非法参数和循环上限三种场景的本次中文/JSON 报告，再回到下面的完整回归阅读更多边界。

**概念。** Agent 在目标和上下文约束下，让模型产生回答或工具请求，再把工具结果提供给后续模型调用。可以用 ReAct 的「推理—行动—观察」理解循环，但推理文本不需要、也不应该作为可执行授权。模型提出调用，框架推进循环，执行器决定是否允许实际副作用。固定 Runbook 则按已批准的步骤执行，不依赖模型动态规划参数。

**源码入口。** 顺着 [agent.mjs](../server/agent.mjs) 的 `createEngine()` / `execute()`，读 [运行时 index.mjs](../server/agent-runtime/index.mjs) 的 `runRuntime()`，再读 [worker.py](../agent-worker/worker.py) 的 `main()`、`ModelBridge._call_api()` 和 `reply_stream` 事件循环。Node 保存权威消息，Worker 用 RPC 请求模型和外部工具；工具结果回填后才继续。新聊天统一经过 AgentScope，固定工具和 Runbook 使用 `direct` 执行路径。

**本地实验。**

```sh
node --test tests/agentscope/runtime.test.mjs
```

**预期观察。** `ordered batches` 用例中，3 次模型请求产生 4 个真实 fixture 工具步骤，台账记录 90 个 fixture tokens；相同供应商 call ID 在不同模型轮次不会错误合并。持续索要工具的用例在第 6 次实际模型调用后失败，不会无限循环。无效 JSON、未知工具、重复 ID 和超过 12 个工具的批次会在执行前拒绝。这里的 tokens 是固定响应中的用量，不是实际供应商费用。

**练习与产物。** 画出「用户请求 → Node 上下文 → Worker → Node 模型 → Node 工具治理 → MCP → 工具结果 → 模型回答」；在图旁分别列出正常终止、待审批、超限、取消和故障。用自己的话说明：为什么 `ReActConfig(max_iters=6)` 之外，Node 还要独立限制实际模型调用次数？

**自检。** 模型返回工具调用就表示工具执行了吗？一轮模型调用能产生几个工具步骤？达到框架迭代上限后，框架额外总结是否应该绕过预算？

## 单元 2：上下文不是记忆，检索不是答案

先运行[上下文与检索六组实验](agent-context-lab.md)：`npm run agent:learn:context`生成本次来源覆盖、输入字节、完整轮次和任务ID可见性的中文/JSON报告。然后用下面的专项测试阅读更完整的权限与协议边界。

**概念。** 模型只能根据本次请求里实际提供的信息作答。会话保存在数据库，不等于每次都发送全部历史，更不等于长期记忆。检索负责选出相关资料；回答是否忠实、资料是否足以说明实时状态，仍需另行判断。

**源码入口。** [agent.mjs](../server/agent.mjs) 的 `execute()` 先过滤可读、启用和可执行资源，再按子领域绑定选择知识、Skill、MCP，并读取最近 30 条文本消息。[agent-context.mjs](../server/agent-context.mjs) 的 `prepareContext()` 可按完整 user 轮次省略较早历史；[retrieval.mjs](../server/retrieval.mjs) 的 `terms()` / `retrieve()` 与 [governance.mjs](../server/governance.mjs) 的 `indexKnowledge()` 实现知识检索。

当前检索是中文二元词项、SQLite FTS5 候选及字符串评分，没有 embedding 或向量库。默认 `ranked` 取排名靠前的片段；可选 `diverse` 先给不同文档名额，再补非重叠片段，每篇最多两段。历史预算按 UTF-8 JSON 字节计算，是保守的成本控制近似，不是精确 tokenizer。它只处理初始历史，不裁剪当轮工具协议或 Responses reasoning。

**本地实验。**

```sh
node --test tests/agent-enhancements.test.mjs
```

**预期观察。** 预算测试保留系统规则和当前问题，删除完整旧轮次并记录省略数量；必需输入本身过大时返回 422，模型请求数为 0。检索对照中，`ranked` 的 5 个片段来自同一长文档，`diverse` 覆盖 3 篇文档，并排除过期/重叠片段。其他用例验证子领域绑定、成员 ACL、关闭知识检索，以及当轮工具结果保持完整。

**练习与产物。** 列一张「内容 / 来源 / 是否进入本轮 / 是否代表实时事实」表，至少包含系统规则、Skill、历史、知识片段和工具结果。以测试中的长文档与短文档为例，解释多样性为什么可能增加覆盖，也可能让某篇最相关文档少占一个名额；先写预期再做个人副本实验。

**自检。** 裁掉了用户上轮提到的任务 ID，模型应该补猜还是追问？为什么 ACL 要在检索候选前限制？引入向量检索后，哪些权限、版本和有效期检查仍需保留？

## 单元 3：MCP 统一连接，治理决定权限

**概念。** MCP 提供工具发现与调用的协议接口；工具 Schema 说明参数结构，业务策略说明谁能在什么环境、什么范围执行。协议连通、参数合法和业务授权是不同条件。Skill 在本项目中提供已发布的文本指令，不直接执行包内脚本。

**源码入口。** [mcp.mjs](../server/mcp.mjs) 的 `connectMcp()` / `discover()` 负责连接与目录；[agent.mjs](../server/agent.mjs) 的 `resolveCall()` 将模型别名对应到实际授权工具；[governance.mjs](../server/governance.mjs) 的 `authorizeTool()` 校验身份、环境、范围和风险；[execution.mjs](../server/execution.mjs) 的 `validateArguments()` / `callStep()` / `executeStep()` 把校验落实到真实调用前。

**本地实验。**

```sh
node --test tests/security.test.mjs tests/mcp-evidence.test.mjs
npm run agent:learn:intent
```

**预期观察。** 工具在允许列表中但缺少策略仍会拒绝；参数超出范围、身份或环境不符不会获得执行授权。未发布或已编辑的共享指令不能继续作为可执行发布版使用。MCP 发现失败会留下数据缺口提示与持久摘要；目录缓存只缓存可用工具定义，不是实时业务结果缓存。

[授权与意图实验](agent-intent-lab.md)另用两个获授权目标作对照：同一billing请求下，选inventory仍执行成功，选越权payroll则在调用前拒绝。逐项比对用户要求、模型提议、实际MCP、持久步骤和工具反馈。该历史实验故意不配置 `requiredTargetFields`，通过表示成功暴露旧边界；新结构化目标门禁另由 `tests/agent-target-binding.test.mjs` 验证。

**练习与产物。** 对 `service_status` 写一张检查表：资源可见性、工具允许列表、策略、参数 Schema、服务范围、运行时撤权。在每项后标出负责函数。再写一个反例：「Schema 接受任意字符串 service，但策略只允许 billing」；说明 Schema 合法为什么仍可能返回 403。

**自检。** 为什么不能仅靠 system prompt 要求模型遵守权限？发现目录成功能否推断服务健康？已授权范围能否替代用户本轮真正要求查询的对象？

## 单元 4：把执行看成持久状态机

**概念。** HTTP 重试、Worker 重传和远程工具重试发生在不同边界。必须先确定是哪一层在去重，再谈「只执行一次」。写请求已经发出但响应丢失时，平台无法据此断言操作失败；`unknown` 表示需要确认，而不是应该立即重试。

**源码入口。** [execution.mjs](../server/execution.mjs) 的 `createExecutionService()` 内包含 `run()`、`callStep()`、`executeStep()`、`approve()`、`reconcile()` 和 `cancel()`。`run()` 用用户与 `requestKey`、输入摘要判断重复；`callStep()` 用本轮调用身份及参数/版本摘要识别重传；写步骤以持久步骤 ID 注入业务幂等参数。审批执行固定计划并重新授权，不重新启动模型生成另一份计划。

**本地实验。**

```sh
node --test tests/execution.test.mjs tests/agent-runtime.test.mjs
npm run agent:learn:unknown
```

**预期观察。** 相同请求返回原执行，同键不同输入返回 409。模拟生产写操作审批前工具写调用为 0，另一个管理员审批后为 1；重启不丢失待审批计划，重复批准也不会再次写入。`ambiguous write outcome` 用例先实际修改 fixture 内存状态再返回错误，台账保持 `unknown`；随后只读对账确认目标状态，写调用仍只有一次。取消与恢复用例检查槽位释放和中断状态。

[写入结果未知实验](agent-unknown-lab.md)进一步用本地代理真实丢弃已收到的写回包，分别统计写请求和实际应用次数；发送前后取消分别观察cancelled与unknown，丢回包后只读对账不重放。这条固定计划路径标记direct/1，模型0、tokens0，不冒称SDK编排实验。

**练习与产物。** 写出正常路径 `queued → running → success`、审批路径和 `unknown → 只读对账` 路径；分别记录 execution 与 tool step 的状态，不把它们混成一张状态表。针对「远端写入成功，回包之前断网」写故障复盘：知道什么、不知道什么、哪些动作允许、为什么不能盲目重放。

**自检。** 取消请求为什么不能回滚已发生的远程副作用？平台有唯一索引是否就实现跨网络 exactly-once？审批期间策略或远程 Schema 变了，原批准是否仍然有效？

## 单元 5：理解 Worker 的责任与隔离边界

**概念。** 进程边界有助于生命周期控制、状态隔离和故障清理。它不是任意不可信代码执行的安全保证。业务权限依然需要 Node 校验，操作系统文件/网络访问能力依然取决于部署约束。

**源码入口。** [driver.mjs](../server/agent-runtime/driver.mjs) 的 `createRuntimeDriver()` 选择启动方式；[agentscope.mjs](../server/agent-runtime/agentscope.mjs) 的 `runAgentScope()` 管理 cold 子进程；[pool.mjs](../server/agent-runtime/pool.mjs) 的 `createWorkerPool()` 管理 prefork；[protocol.mjs](../server/agent-runtime/protocol.mjs) 的 `bridgeSession()` 检查 run ID、序号、重复请求和终态；[worker.py](../agent-worker/worker.py) 的 `pool_main()` / `main()` 实现父子进程协议。

prefork 父进程预加载固定 SDK，每轮 fork 新子进程创建 Agent 和事件循环；cold 每轮重新启动解释器。Worker 不持有模型供应商真实凭据，`ModelBridge` 不直接请求供应商。不同请求不会共享 Agent 对象，但同一系统用户的操作系统权限不会因为 fork 自动消失。

**本地实验。**

```sh
node --test tests/agent-pool-protocol.test.mjs tests/agentscope/pool.test.mjs
```

**预期观察。** 协议 fixture 覆盖 lease/leased/ready 边界；真实 SDK 测试覆盖进程回收、故障、取消、队列和资源观测。跨 run 或不符合生命周期的帧不会被接受。Worker 故障不能回退到另一套循环重放已发生的工具调用。

**练习与产物。** 对照写出 cold 与 prefork 的启动成本、平台限制、状态隔离方式和清理复杂度。再写「如果将来允许执行用户上传 Python，必须新增什么」：至少考虑文件系统、网络出口、CPU/内存/PID、凭据、超时与审计，并明确这些是待设计项。

**自检。** 为什么只给空闲父进程发送不含业务内容的 lease？为什么确认子进程已回收后才能复用父进程？移除真实 Key 能否阻止 Worker 读取所有宿主文件？

## 单元 6：固定双 Agent 复核的收益与代价

**概念。** 本项目的复核是固定「分析 → 独立复核」流程，两个独立上下文使用同一共享配置中的模型（配置未在请求间变更时名称相同）。它不是自主组队、并发辩论或动态委派。独立上下文可减少直接沿用分析过程，但同一模型仍可能产生相关错误，不能把复核通过当成真实性证明。

**源码入口。** [agent.mjs](../server/agent.mjs) 在 `reviewMode=independent` 时分配最多 5 次分析请求；[agent-review.mjs](../server/agent-review.mjs) 的 `reviewAnswer()` 最多请求一次无工具 reviewer，`reviewText()` 决定是否发布候选。reviewer 输入包含用户问题、选中历史、资料、本轮实际证据和步骤；不接收分析阶段的 opaque reasoning。两阶段共享 execution 和预算。

**本地实验。**

```sh
node --test tests/agent-review.test.mjs tests/agent-review-security.test.mjs
```

**预期观察。** 严格 JSON 的 pass/block、额外字段、矛盾原因和非法工具尝试均有断言；blocked/unavailable 不发布候选答复。截断证据或剩余预算不足时，不靠删证据凑一次复核。待审批写计划跳过模型复核，继续交人工审批。取消、撤权和 Worker 故障会收尾挂起请求，不额外重试。

**练习与产物。** 写四行判断表：有新鲜证据的回答、没有工具却声称当前健康、查询对象与请求不符、工具证据截断。每行列出应检查的事实、可能的 verdict 和仍未消除的风险；不要把 fixture 预设 verdict 当成真实模型正确判断。

[独立复核实验](agent-review-lab.md)提供五组一键对照，额外放入“同样缺证据却预设pass”的反例及reviewer503；分别核对候选发布、持久步骤、review/trace/execution状态和阶段用量。实验通过只代表行为符合预期，报告中的人工评价保持空白，真实模型质量尚未验收。

**自检。** 复核 block 能撤销分析阶段已经发出的查询吗？reviewer pass 能代替人工批准写操作吗？同模型复核应如何测量错误放行率、误拦截率、延迟和成本？

## 单元 7：观察执行事实，而不是暴露推理

**概念。** 「正在生成」是进度事件，正文增量是内容事件，trace 是执行观测记录，三者不能互相冒充。一次流程完成也不等于业务健康；工具成功只证明拿到了调用结果，业务判断仍需检查对象、时间、状态含义和证据充分性。

**源码入口。** [model-stream.mjs](../server/model-stream.mjs) 的 `readModelStream()` 处理供应商 SSE；[运行时 index.mjs](../server/agent-runtime/index.mjs) 的 `runRuntime()` 转发正文增量并聚合工具消息；[agent.mjs](../server/agent.mjs) 的 `agentRoutes()` 传送 NDJSON；[agent-trace.mjs](../server/agent-trace.mjs) 的 `createExecutionTrace()` 维护节点、依赖和消息时点快照。界面解释见 [问答全景](execution-panorama.md)。

**本地实验。**

```sh
node --test tests/model-stream.test.mjs tests/chat-stream.test.mjs tests/agent-trace.test.mjs
```

**预期观察。** 普通聊天的首段文本可以先于上游终态到达；工具阶段会撤下暂显文本；截断流不会保存成完整 assistant 答案。独立复核不提前发送分析/reviewer 正文。全景区分发现与目录缓存，重启和幂等回看保持同一快照；晚到回调不能改写已完成记录。审批之后的最新状态去执行中心看，历史图不重写。

**练习与产物。** 列出一次含工具请求的时间线：模型开始、暂显正文撤回、工具步骤、第二次模型、最终保存、历史回读。再解释为何 trace 只保留受控摘要、身份、耗时和用量，不保存提示原文、完整参数/返回正文或私有推理。需要诊断具体参数时，应查看有权限的执行证据，而不是把更多敏感数据塞进图谱。

**自检。** HTTP 200 与 trace completed 分别证明什么？浏览器断流时为什么需要回读持久结果？全景是否覆盖排队前、人工审批后的全部生命周期？

## 单元 8：用评测证据约束面试表达

**概念。** 测试有不同证明范围：单元测试检验局部规则，协议 fixture 检验固定输入下的工程行为，真实 SDK 测试检验框架集成，真实模型评测才涉及模型选择与生成表现。即便使用真实模型，本机只读 MCP 也不能代表真实企业数据或生产容量。

**源码入口。** [evaluate-agent-runtime.mjs](../scripts/evaluate-agent-runtime.mjs) 对照同一 SDK 的 cold/prefork；[evaluation-cases.json](../tests/evaluation-cases.json) 定义当前工具选择小语料；[agent-acceptance.mjs](../scripts/agent-acceptance.mjs) 的 `validateEvaluation()` / `assessAcceptance()` 检查 DTS 评测报告、源码身份、覆盖和人工复核。两个评测报告 schema 不同，不能把通用工具小报告直接交给 DTS 验收器。

**本地实验。**

```sh
npm run agent:eval
node --test tests/agent-acceptance.test.mjs
```

**预期观察。** 当前通用工具 fixture 语料在 cold/prefork 各运行 4 例，报告写到 `test-results/agentscope/runtime-evaluation-fixture.json`，`mode` 为 `deterministic-fixture`，`productionToolsUsed` 为 false。验收器单测拒绝缺行、重复、旧报告、源码不匹配与缺失人工复核；测试中的合成 approved 数据只是在测试门禁，不是真实人工验收。

**练习与产物。** 报告中分开写「证明了什么」和「尚未证明什么」。针对真实模型提出一个待执行评测设计：固定数据集与版本，对比单分析/独立复核，统计目标一致性、证据充分性、错误放行、误拦截、P95 与用量，并由人检查失败样本。没有运行之前只称评测设计。

最后按 [面试章节](agent-interview.md) 录一段 90 秒介绍，挑两个取舍案例各讲 3 分钟。能从结论追到函数和测试，能主动说出局限，才算本单元完成。

**自检。** fixture 全绿能否证明模型拒绝越权提示？P95 下降能否直接写成生产提速？报告对应旧源码时，为什么不能用它批准新候选？

## 完成后的下一轮迭代

先从自己说不清的一处边界选题。例如：理解未知结果后补充故障解释；掌握检索后设计带预期引用的语料；读完复核后设计目标意图绑定实验。一次只选择一个可验证问题，先写触发条件、预期行为和失败样本，再决定是否需要改代码。

涉及较大功能时沿用仓库现有 OpenSpec 流程；行为变化必须遵守 [agent.md](../agent.md)，同步相应文档、[验证记录](verification.md) 和离线官网。学习进度、生产放行和模型能力提升是不同结论，应分别记录。

## 观测主题的一键实验

[可观测性实验](agent-trace-lab.md)提供四组真实SDK/本机对照：模型等待、工具等待、工具错误、查询成功但合成业务异常。报告保存实际脱敏trace与台账，并把本地观察器的业务快照时间单独标明；没有的观测不补造，固定tokens不换算真实费用。
