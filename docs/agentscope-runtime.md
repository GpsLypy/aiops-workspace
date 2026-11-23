# AgentScope 唯一运行时：安装、增强与恢复

2026-09-29 起，所有聊天和定时任务统一由 AgentScope 2.0.8 编排，旧循环和 legacy 回退已删除。Python 3.12 与锁定 SDK 是必需依赖；默认 prefork，cold 是同一 SDK 的另一个启动模式。权限、模型出口、工具执行、审批、巡检证据、通知与 SQLite 继续由 Node 管理。管理页面仅控制上下文、检索和证据增强。当前测试和既有真实模型质量缺陷见 [验证记录](verification.md)，迁移设计见 [唯一运行时变更](../openspec/changes/agentscope-only-runtime/design.md)。

## 安装与启用

在项目根目录使用 Python 3.12 和 uv 0.11.26（本轮验证版本）。上游支持更广的 Python 版本，本桥接器仅锁定并接受 3.12。

```sh
uv sync --project agent-worker --frozen
npm run agent:check
npm run test:agentscope
```

`uv.lock` 锁定直接和传递依赖；不要将 `.venv` 复制到其他操作系统。`agent:check` 启动真实 AgentScope，使用本地内存模型与外部工具结果完成往返，不打开业务数据库、不访问供应商或 MCP。依赖缺失、版本不符、协议不通均返回非零退出码。`test:agentscope` 先做相同探针，再用临时数据库与 HTTP/MCP fixture 运行全量回归和专用测试，不会静默跳过 Python 测试。

在实例 `.env` 中配置。升级前删除非空旧运行时白名单，将旧 `AGENT_RUNTIME=legacy` 改为 `agentscope` 或移除该变量，然后重新启动 Node：

```dotenv
AGENT_RUNTIME=agentscope
AGENTSCOPE_WORKER_MODE=prefork
AGENTSCOPE_POOL_SIZE=2
# 默认解释器为项目 agent-worker/.venv/bin/python；也可设置绝对路径
# AGENTSCOPE_PYTHON=/srv/aiops/agent-worker/.venv/bin/python
# 所有子领域与通用对话统一使用 AgentScope，无运行时白名单
```

| 配置 | 行为 |
| --- | --- |
| `AGENT_RUNTIME=legacy` 或其他值 | 拒绝启动；旧引擎已移除 |
| `AGENT_RUNTIME=agentscope` 或未配置 | 唯一运行时；Worker 不可用时失败，不重放 |
| `AGENTSCOPE_AGENT_IDS` 非空 | 旧运行时白名单已移除，拒绝启动并提示清理配置 |
| `AGENTSCOPE_AGENT_IDS` 为空或未配置 | 兼容空值，不限制运行时；增强范围由管理员页面管理 |
| `AGENTSCOPE_PYTHON` | 可信部署配置，指定解释器文件；不接受用户请求覆盖 |
| `AGENTSCOPE_WORKER_MODE=prefork` | AgentScope 默认模式；POSIX/macOS/Linux 预加载 SDK，每轮 fork 全新子进程 |
| `AGENTSCOPE_WORKER_MODE=cold` | 首期模式；每轮启动全新解释器，保留回退路径 |

| 进程池配置 | 默认 | 允许范围 / 含义 |
| --- | --- | --- |
| `AGENTSCOPE_POOL_SIZE` | 2 | 1–8 个预加载父进程，每个最多一个活跃子进程 |
| `AGENTSCOPE_POOL_MAX_RUNS` | 100 | 1–10000，父进程累计服务轮数后回收 |
| `AGENTSCOPE_POOL_MAX_AGE_MS` | 1800000 | 1000–86400000，父进程最长存活时间；在空闲时回收，不打断正常运行 |
| `AGENTSCOPE_STARTUP_TIMEOUT_MS` | 15000 | 100–120000，预加载或 cold 探针超时 |
| `AGENTSCOPE_POOL_QUEUE_MS` | 30000 | 1–120000，等待 Worker 的最长时间 |
| `AGENTSCOPE_POOL_MAX_PENDING` | 100 | 1–1000，等待 Worker 的最大请求数 |

现有 execution 并发/队列限制仍先行生效；进程池队列是应用内部第二道上限，等待时间计入本轮执行超时。通常让池大小接近需要的活跃 AgentScope 数量，并结合内存/CPU 实测配置。

`server/index.mjs` 在监听 HTTP 和启动调度前预热选中运行时。prefork 检查 Python/SDK 版本与父进程 ready；cold 执行本地模型/工具探针。初始化失败退出，不能以存活进程冒充就绪。`/readyz` 综合数据库、磁盘、关闭状态和运行时可用性，只返回 `ready`；繁忙 Worker 仍视为可用，有至少一个可用父进程时允许降级服务。独立 `agent:check` 还验证实际 SDK 模型/外部工具往返。以上检查不访问真实供应商或 DTS。定时任务仍只有 Node 一个调度源。

## 容器部署

默认 `docker build .` 和 `compose.yaml` 均包含 Node、Python 3.12 和 frozen uv 依赖，以非 root 用户运行，tini 回收孤儿进程。不再提供 Node-only 镜像或额外的 AgentScope Compose 覆盖文件：

```sh
docker build -t aiops:agentscope-only .
npm run agent:container -- aiops:agentscope-only --enhancements
npm run agent:image:audit -- aiops:agentscope-only
# 配置生产 Origin、出口和外部 master key 后，显式启用该部署：
docker compose up --build -d
```

`compose.yaml` 默认设置 `AGENT_RUNTIME=agentscope` 和池配置，沿用只读根文件系统、`/tmp` 临时盘、能力移除与禁止提权；默认内存 1 GiB、CPU 2、PID 128。旧运行时变量会透传并由启动校验拒绝，不静默扩大原白名单。`AGENTSCOPE_MEMORY_LIMIT` 可调内存上限。使用持久数据卷、审计卷和 Secret 外置密钥；不要复制宿主 `.venv`。镜像支持 `NODE_IMAGE`、`PYTHON_IMAGE`、`UV_IMAGE` 参数，默认 uv 0.11.26。

`agent:container` 使用随机命名的临时容器、一次性密钥与内存数据库，断网、只读、限制资源，验证 SDK 探针、应用就绪、指标和 SIGTERM 正常退出，最后清理自身容器。它不加载 `.env`、不发布端口、不挂载业务数据。报告记录镜像 ID/架构/大小；不等于目标生产环境部署或全镜像 CVE 扫描。

加 `--rollout` 时，断网临时容器还验证管理员草稿/本地预检/启用/暂停和暂停后的就绪；所有账号和密钥为一次性 fixture。加 `--enhancements` 时，临时容器同时启用第四期三个开关并验证配置；验收前固定镜像 ID，避免扫描与运行使用不同标签内容。业务闭环仍由宿主集成测试验证。

AgentScope 最终镜像不包含 npm、pip 或 uv，依赖在构建阶段冻结安装。容器中使用 `node scripts/check-agent-worker.mjs` 检查 Worker，使用 `node scripts/ops.mjs ...` 执行运维命令；本文 `npm run ...` 验收命令在安装了开发工具的宿主机或 CI 执行。移除非必需安装工具后重新构建和扫描，避免它们的依赖成为运行镜像漏洞来源。

## 实际运行边界

prefork 复用的父进程只导入固定 SDK，没有 Agent 对象、运行事件循环或业务上下文；每轮都在新 fork 的子进程中创建 Agent。cold 则连解释器一起重新启动。两种模式均使用私有 stdin/stdout 交换版本化 JSON 行，没有内部 HTTP 端口，Worker 不选择用户、模型 URL、真实工具或数据库路径。

prefork 的 v2 生命周期包裹原有 v1 运行协议：

1. 父进程完成导入，发送含 SDK 版本、PID 和资源样本的 `ready`。
2. Node 领取空闲父进程，仅发送 `lease/runId`；不含系统指令、历史或工具目录。
3. 父进程 fork，子进程发 `leased/runId/PID`。Node 校验后才发送 v1 `start` 上下文，之后的模型/工具消息全部由子进程读取。
4. 子进程 `finish` 后退出，父进程 `wait4` 回收它并发送匹配 runId/子 PID 的 `ready`。Node 收到回收确认才完成本轮和复用父进程，5 秒未确认则失败。

不复用用户 Agent、记忆、工具实例或 asyncio 事件循环，也不依赖 reset 清除上一位用户状态。父/子进程使用各自临时目录，Python `TMPDIR` 与 `tempfile` 缓存指向本轮目录，正常或故障收尾后回收；环境中不继承业务密钥。prefork 将常见数学库线程数限制为 1。此边界**不是操作系统沙箱**：SDK 是可信代码，同一系统用户的文件和网络权限仍需部署环境限制。应用容器整体需要访问经批准的模型/MCP 出口，断网仅用于本地探针。

Node 保留唯一的模型原始消息列表、授权工具映射与 Responses opaque reasoning。Worker 的自定义 `ChatModelBase` 仅请求“下一次模型调用”，不提交任意替代消息。真实供应商请求始终经过现有 `completion`、出口策略和脱敏。AgentScope 编排外部工具，Node 先严格校验原始 JSON/Schema/策略，再将调用交给框架；框架发回的工具 ID、名字与原始参数文本必须逐项匹配。

普通聊天在 Node 的模型请求中启用上游 SSE，直接发送 NDJSON 正文增量到页面。Worker 仍接收聚合后的完整模型结果，ModelBridge 的 stream=False 是本地桥接选择；cold/prefork 均支持正文流式显示。工具阶段会清除暂显正文；模型重试或显示断线恢复期间保留已经打印的未完成正文，待新正文追上或完整终态后替换。推理和参数不公开。独立复核模式等复核通过后才展示回答，不提前流出分析草稿；上游仅接受 Responses SSE，完整JSON响应被拒绝；Worker接收的仍是Node聚合的完整结果。每次模型尝试有独立streamId，model_retry区分等待与连接，通知后可取消退避；独立复核也显示固定原因和恢复次数，候选门禁保持。输入区上方固定显示当前动作、耗时与停止按钮，正常输出恢复后撤下重试状态。持久受理在排队前通知；浏览器45秒无数据转只读恢复，缺runId按本人requestKey找回，不重发POST。接口事件和边界见 [API 参考](reference.md)。

排查模型连接和超时时可在测试实例设置 `MODEL_DIAGNOSTICS=true`（默认 false；Compose 显式透传）。每次进入模型请求阶段只向进程日志写一条固定字段 JSON，包括被本地出口策略拒绝而尚未联网的请求：`event=model.request`、`phase`（发请求前/收到响应头/读取 SSE/完成）、`outcome`、`elapsedMs`、`abortSource`（请求超时或整轮取消）、`timeoutKind`（首字节/流中静默）与 `sseTerminalStatus`。不记录提示词、模型名、URL、请求头、响应正文或原始错误；日志仍需按运行环境的权限和保留期管理。默认首字节90秒、流中静默180秒，每次重试重新计时；整轮默认420秒，最多五次重试。诊断本身不改变策略或用户可见错误，也不判断供应商故障根因。

两种模式的 v1 模型/工具协议均禁用 SDK 自动压缩、内置压缩工具、运行态注入和模型重试。默认近 30 条文本历史、Skill 正文、检索来源、当轮工具结果与原有限制一致；第四期增强在 Node 中通过下述开关独立启用。第六期支持显式选择的分析→复核双 Agent；聊天用户显式开启时支持单层只读自主委派，详见[自主委派](agent-delegation.md)；长期记忆、自动 Skill 读取、通用脚本和供应商直连模型仍未启用。

所有实际模型调用受 Node 的六次总上限与 token 预算约束，包括框架尝试在达到迭代上限后总结；每批最多十二个工具，顺序执行。Worker 只返回 `completed` 且最近模型没有待执行工具时才允许普通成功；等待、错误、超限和中断不能因为存在文本而变为成功。

## 管理员增强配置

进入「当前用户 → 工作空间设置 → Agent 增强」。沿用原部署方式且从未启用网页策略时，行为仍完全由环境变量决定；首次保存草稿不改变当前运行。

1. 选择已经启用、已经发布的子领域，按需包含通用 Agent；选择历史裁剪、知识片段和证据报告选项，**保存草稿**。
2. 点击**预检已保存草稿**。系统使用独立的 AgentScope driver 预热后关闭：prefork 检查 Python/SDK 和父进程 ready，cold 还执行本地内存模型/工具往返。完整往返可通过 `npm run agent:check` 验证；这些步骤均不连接供应商、业务 MCP 或生产 DTS。
3. 预检成功后的五分钟内点击**启用增强**。只对范围内下一轮执行生效；范围外仍使用 AgentScope 和 `recent/ranked/false` 增强基线。保存下一份草稿不会改变已启用版本。
4. 点击**暂停增强**，之后所有新一轮使用基线，三个增强关闭。已开始执行的运行保持原快照；暂停不撤销远程操作、不重放工具，也不自动处理待审批或 unknown。

增强作用域只决定三项可选能力，不控制使用哪个引擎。所有已授权且可执行的子领域与通用 Agent 都使用 AgentScope；未发布、停用或无权限资源仍被执行门禁拒绝。旧 active 策略继续控制原范围的增强，旧 paused 策略关闭增强，二者均不能恢复旧引擎。

“草稿版本”只在保存时变更，“生效版本”对应启用时的修订；全局配置修订在保存、预检、启用和暂停时递增。所有写接口要求最新 revision，冲突返回 409，需刷新后重新编辑。预检前后均核对管理员角色/启用状态、修订与资源版本；启用时再次校验。草稿/资源/部署变化、过期或新的失败预检会使原预检失效。探针仅证明本地协议可运行，不是业务验收门禁；网页启用不自动读取或批准下方的评测结果。

每轮在获得执行槽位、完成会话/子领域校验后，固定 `metadata.runtimePolicy`；排队请求使用真正开始执行时的版本。在途运行即使遇到模型错误仍保存原快照，幂等请求继续返回原结果。快照有运行时、策略模式/修订、生效修订、是否命中范围、增强模式和字节上限，不包含解释器路径或凭据。`agent.runtime` 与 `agent.rollout.*` 审计可定位变更和使用情况；保存/启用审计保留当时范围与增强配置。

增强策略保存于既有 `settings` 的 `agent:rollout`，自身没有新增数据表；当前数据库为 schema v7，备份和 API 路径保持兼容。没有网页“恢复跟随部署”的操作；暂停后需要显式重新预检、启用。历史消息的原运行时/策略快照不改写。恢复旧二进制属于独立部署回退，不能在本构建中通过 legacy 开关完成。

暂停增强不关闭主进程池；所有请求和 readiness 仍依赖 Worker，重启后也始终预热。`/api/operations.runtime` 和 `/metrics` 保留实际池状态与计数。Python 不可用时就绪失败，不能用增强暂停掩盖故障。需要立即中止执行时使用执行中心紧急停止/取消能力。

## 评测与人工验收闭环

`agent:eval:dts` 生成 version=3 报告，绑定源码内容 SHA256、DTS 语料 SHA256、模型名/API 协议、端点摘要、SDK/Node/架构与运行配置。源码摘要覆盖 server/src、Worker/锁文件、评测/验收脚本、DTS 和独立沙箱服务、观测栈配置、质量样本及来源确认、依赖清单、容器配置及 fixture；不读取 `.env`、`.data` 或私有部署文件，不依赖虚构 Git 提交。运行前后摘要不同则拒绝产出。该摘要标识源码候选，**不是容器镜像 ID，也不是已部署业务配置的证明**。

先运行本地回归和生成待复核清单：

```sh
npm run agent:eval:dts -- --repeat 3 --out test-results/agentscope/dts-controlled-new.json
npm run agent:acceptance -- --report test-results/agentscope/dts-controlled-new.json --template test-results/agentscope/review-pending-new.json
npm run agent:acceptance -- --report test-results/agentscope/dts-controlled-new.json --packet test-results/agentscope/review-packet-new.json
npm run agent:acceptance -- --report test-results/agentscope/dts-controlled-new.json --review test-results/agentscope/review-pending-new.json
```

最后一条应退出 **2**，因为固定模型与待审记录不能通过真实评测验收。报告、模板、复核包与结果均权限 `0600`、排他写入，已有文件不会被覆盖；评测与验收默认文件名带时间戳，也可用 `--out NEW_FILE`。复核包包含每条答复、评分要求和实际快照，便于逐条检查；原报告不改写，始终 `productionAccepted=false`。

真实模型评测需要显式设置 `EVAL_MODEL_BASE_URL`、`EVAL_MODEL_NAME`，可设 `EVAL_MODEL_API_TYPE=responses`、`EVAL_MODEL_API_KEY`；然后执行：

```sh
npm run agent:eval:dts -- --real --repeat 3 --out test-results/agentscope/dts-evaluation-real.json
npm run agent:acceptance -- --report test-results/agentscope/dts-evaluation-real.json --template test-results/agentscope/review-real.json
# 人工对照报告每条 answer、工具步骤和 rubric 填写 review-real.json 后：
npm run agent:acceptance -- --report test-results/agentscope/dts-evaluation-real.json --review test-results/agentscope/review-real.json --out test-results/agentscope/acceptance-real.json
```

真实模式只替换模型，DTS 工具仍是本地 fixture，不访问生产 DTS。逐条审查后填写 `status=approved|rejected`、`reviewerKind=human|ai|unspecified`、`reviewer`、ISO UTC `reviewedAt`、具体 `notes`，以及 `evidence_consistency`、`rubric_compliance`、`boundary_compliance` 三项发现；保留条目键、报告/源码/答复/证据摘要。复核必须晚于报告完成、不得在未来；pending、缺失或拒绝不能通过。不得未经审查批量批准。审核类型和身份由填写者声明，不是外部身份认证。

真实 DTS 目标的单次验收使用独立入口，要求已同步三字段策略、当前获准的任务 ID 和可访问内网。完整模式默认使用保存的真实模型，也可用 `--model` 在隔离工作空间临时覆盖模型名，不修改源库模型配置：

```sh
SOURCE_DIR=.data npm run test:target:real -- --real --job AUTHORIZED_ID
# 临时核对同一保存连接配置下的另一模型：
MODEL_MAX_TOKENS=256 SOURCE_DIR=.data npm run test:target:real -- --real --job AUTHORIZED_ID --model MODEL_NAME
# 保存模型不可用时，单独核对真实 DTS SDK 读取和受控负例：
SOURCE_DIR=.data npm run test:target:real -- --direct-only --job AUTHORIZED_ID
```

该脚本将当前资源只读复制进隔离临时工作空间；完整模式还复制保存的模型连接配置，浏览器显式确认目标后，以真实模型和 DTS MCP 做正确目标查询。流式响应以持久执行终态、页面完成和持久答复核对，不依赖可能一直等待的 Playwright `response.finished()`。正例要求一条成功的持久工具步骤、精确三字段与非 fixture 返回，还要求非空持久答复标识该任务且刷新后网页一致。两种模式均用本机受控模型提出授权内错误 ID、缺字段和额外字段；每个负例必须精确返回 HTTP 403，响应和持久运行错误同为“工具参数与本轮确认的目标不一致”，工具步骤与 MCP `callTool` 均为零。`--direct-only` 另用真实 MCP SDK 查询一次，但不调用模型、不产生持久工具步骤；证据完整时也按设计退出 **2**。`--model` 的真实正例和负例完整时同样退出 **2**，报告 `alternateModelEvidenceComplete=true`，但 `savedModelPositiveVerified=false`、`passed=false`、`productionApproved=false`；只有未覆盖的保存模型及其他断言全部通过才退出 0。报告不保存可能暴露业务 ID 的浏览器截图，并分别标明正例类型与受控负例；这些结果不等于上述 30 场景真实模型评测或人工质量评分。执行前先核对当前资源修订和任务授权，实际通过与否以 [验证记录](verification.md) 为准。

汇总重新计算 cold/prefork 各自条数、台账 token 与 P95，并从实际步骤/巡检重算证据，不信任输入通过标记。DTS 报告 version=3 固定 `runtime=agentscope`，每条含 `workerMode`；对照是同一 SDK 的 prefork/cold。门槛默认完整 30 场景 × 两种启动模式 × 至少 3 次、全部自动证据、真实模型、当前源码、全部人工批准、prefork/cold P95 ≤ 1.2、token 总量比 ≤ 1.1。复核和汇总为 version=3，条目键为 `agentscope/{workerMode}/{caseId}/{iteration}`；旧 v2 复核可读取，但未声明审核类型不能满足分类门槛。旧 version=1/2 评测明确拒绝。可用 `--thresholds FILE` 提供 `{ "minRepeats": 3, "maxP95Ratio": 1.2, "maxTokenRatio": 1.1 }`，无分母不通过。测量应串行、独占稳定资源。

AI 工程复核可以完成 `engineeringReady`；显式 `--engineering` 按这个门槛给出退出码。`realModelQualityReady` 还要求真实模型，正式 `evaluationAccepted` 仍要求完整人工批准；`humanReviewComplete` 单独报告。AI 工程就绪不自动放行正式评测或生产。

退出码 **0** 表示所选正式或工程门槛通过，**2** 表示待验收或门槛未达标，**1** 表示输入不合法/执行失败。输入校验失败不创建新成功证据、不覆盖旧结论，输出禁止覆盖输入或已有文件。结果不自动启用增强，也不代表真实费用、生产容量、生产数据质量、安全接受或恢复指标。

### 保存模型连接与真实复验

`agent:eval:saved` 只读加载本机保存模型，在进程内解密并传给评测子进程；不打印连接地址、凭据或原始答复，并核对运行后配置摘要未改变。`SOURCE_DIR` 默认 `.data`。以下路径必须尚不存在：

```sh
npm run agent:eval:saved -- probe --out test-results/quality/saved-probe-new.json
MODEL_MAX_TOKENS=4096 npm run agent:eval:saved -- probe --out test-results/quality/saved-sse-new.json
npm run agent:eval:saved -- quality --out test-results/quality/saved-quality-new.json
```

probe 仅发送固定连接问题，报告存固定诊断字段、数值用量和答复摘要；quality 在合成 DTS 工具上测保存的真实模型。`dts --repeat 3` 可生成完整真实模型评测，但应先确认连接可用，避免在持续超时的端点盲目重复。2026-10-08 streaming 在 `before_headers`、非流式在 `reading_json` 达到 90 秒超时，保存配置均未改变；最新后续实测见[验证记录](verification.md)。这种模型故障不能由受控模型通过替代。

### 脱敏质量样本台账

`scripts/agent-quality.mjs` 保存真实问题和观察失败的最小脱敏摘要，并将复核模板绑定当前源码和语料摘要。`tests/quality-cases.json` 含一条历史真实模型评测中观察到的**合成越权场景失败**，以及一条 DTS 状态复查。用户于 2026-10-08 明确确认“是，属于我的真实运维需求”，后者现为 `origin=user_report`；确认日期、原证据 SHA256 和消息序号存于 `tests/quality-provenance.json`，不保存原任务 ID、原提示或答复。这完成需求来源确认，不代表模型答复质量通过。新增案例需 JSON 字段 `id`、`origin`（`user_report` / `observed_failure` / `historical_candidate` / `synthetic`）、`category`（`typical` / `failure` / `attack`）、ISO `capturedAt`、不含隐私的 `sourceRef`、`promptSummary`、`expected`、`rubric` 和 `sanitized:true`；可选 `evaluationRef` 绑定 v3 报告摘要及条目键。

```sh
node scripts/agent-quality.mjs init --out test-results/quality/new-corpus.json
node scripts/agent-quality.mjs add --corpus test-results/quality/new-corpus.json --case path/to/sanitized-case.json --out test-results/quality/corpus-v2.json
node scripts/agent-quality.mjs template --corpus tests/quality-cases.json --out test-results/quality/review-pending.json
node scripts/agent-quality.mjs check --corpus tests/quality-cases.json --review test-results/quality/review-pending.json --out test-results/quality/check.json
```

所有输出只新建文件。逐条填写 `status`、`reviewerKind`、`reviewer`、晚于模板生成且不在未来的 `reviewedAt`、具体 `notes` 和 `evidenceRef`；缺失、拒绝或过期摘要时 `check` 退出 2，非法输入/已有输出退出 1。当前台账为真实用户问题 1、观察失败 1、历史候选 0。`corpus_review` 接受明确的 AI 工程复核，`reviewComplete` 与 `humanReviewComplete` 分开；只有全部人工批准才有完整人工审核。具体完成记录见[验证记录](verification.md)。来源和脱敏由提交者声明，CLI 不运行模型或认证外部身份，`productionAccepted=false`；固定模型的工程通过不能替代真实模型质量。

`agent:eval:quality` 将台账中两条摘要重构为**新的合成问题**，使用专用合成任务 ID、临时数据库、本机 DTS MCP/上游和 prefork Worker 验证目标与实际只读步骤。默认使用受控模型；只有显式 `--real` 且提供 `EVAL_MODEL_BASE_URL`、`EVAL_MODEL_NAME`（可选 `EVAL_MODEL_API_TYPE`、`EVAL_MODEL_API_KEY`）才请求外部模型。每次运行指定尚不存在的私有报告路径：

```sh
npm run agent:eval:quality -- --out test-results/quality/replay-controlled.json
EVAL_MODEL_BASE_URL=... EVAL_MODEL_NAME=... npm run agent:eval:quality -- --real --out test-results/quality/replay-real.json
```

脚本将源码、质量台账和重构问题摘要，以及模型协议/端点摘要、精确工具步骤和上游调用数写入权限 0600 的报告；答复中的长数字和常见密钥会被遮盖。正常自动证据完成仍退出 2，因为人工评分保持 pending；自动断言失败退出 1。跨区域案例在模型调用前由策略拒绝，仅验证前置授权边界，**没有重放历史模型换目标行为**。两条重构问题不等于原消息，不能并入 30 场景 × 双模式 × 三轮的 v3 发布验收；真实模型模式也只连接本地合成 DTS 服务。

如需对重构报告逐条记录工程复核意见，使用独立复核 CLI；它把报告字节摘要、候选摘要、每条输出摘要和测试阶段绑定在模板中，并复算 HTTP、执行状态、模型/上游调用、工具步骤、边界与查询快照。缺少必要观察字段的旧报告、矛盾证据，以及缺失、重复、过期或未填写证据的决定均被拒绝：

```sh
npm run agent:review:quality -- template --report test-results/quality/replay-controlled.json --out test-results/quality/replay-review.json
# 逐条审查并填写 status、reviewerKind、reviewer、reviewedAt、notes、evidenceRef 后：
npm run agent:review:quality -- check --report test-results/quality/replay-controlled.json --review test-results/quality/replay-review.json --out test-results/quality/replay-review-result.json
```

逐条填写结论、审核者类型、姓名、时间、说明和证据引用。`reviewerKind=ai` 用于 Codex 等 AI 工程复核，`human` 用于人工复核；新模板默认 `unspecified`，旧记录缺少类型时也按未声明处理。`counts.completedByReviewerKind` 分别统计已完成的三类记录。`replay_review` 和 `reviewReady` 检查当前报告的工程复核，AI 可以完成；只有全部条目明确为人工且批准，`humanReviewComplete` 才为 true。类型和姓名都是声明，命令不验证外部身份。

待审、拒绝或当前摘要不匹配时 `check` 退出 2；格式非法、证据矛盾或输出已存在时退出 1。原报告保持待人审的运行时快照，事后复核单独保存，不改写原证据。即使两条结果全部通过，`productionAccepted` 仍为 false；跨区域案例只审查前置拒绝和执行证据，不存在可评分的模型答复。命令不核实真人作者、原提示、外部事件，也不替代当前候选的真实模型 DTS v3 发布评测。

2026-10-08 用户授权由 Codex 完成工程复核。首轮缺四字段答复的拒绝结论保留；受控模型脚本现读取实际查询快照并标明合成回放。需求来源已确认，最新逐条工程复核与真实模型结果见[验证记录](verification.md)。正式 DTS 发布人审仍是独立门槛；用户无需为继续开发手工填写 JSON。

### 本机观测与独立执行服务

这些能力现在可从「AgentScope 入门 → 部署与验收」直接了解，`#guide?tab=deployment` 可直达。观测分工/实际连通/已有测量记录、沙箱审批/产物流程与接入状态分区展示。管理员还可选择两份标准化账单文本或载入演示，直接查看精确对账结果并下载；页面数据只在本次请求内存计算。使用步骤见[开发指南](agent-development.md#从界面了解本机部署和验收)，API和限制见[接口说明](reference.md#本机部署状态与账单接口)。

用户本轮选择先完成本机部署和工具。Collector、Tempo、Prometheus 的配置、多个独立工作空间汇总及 CSV/JSON 账单导入见[观测部署说明](../deploy/observability/README.md)。私有 `.env.observability.local` 由本机部署生成，使用 `node --env-file=.env.observability.local scripts/dev.mjs` 启动项目；统计入口 `http://localhost:9090`、链路查询 `http://localhost:3200`。金额精确对账仍需用户提供真实账单，不会凭空形成真实费用验收。

独立沙箱的 socket 服务与 MCP、固定源码写审批、文本扫描/独立预览批准下载、超时/取消/回收见[沙箱接入说明](../integrations/agent-sandbox/README.md)。首期仅 Python 3.12 与文本产物，不接受上传输入、自定义挂载或外网；本机部署不自动修改现有 DTS Agent 或激活任务。Docker 共享宿主内核，生产需独立服务身份及目标环境隔离验收。

## 第四期独立增强

以下配置同时适用于AgentScope cold/prefork 及聊天/定时任务，在启动时固定，不允许请求自行覆盖；默认配置维持原行为。源码部署使用环境变量或 `.env`，Compose 沿用 `compose.yaml` 中的变量映射。修改配置后重启选定的测试实例。

| 配置 | 默认 | 行为 |
| --- | --- | --- |
| `AGENT_CONTEXT_MODE` | `recent` | `budgeted` 对最近 30 条文本消息按完整 user 轮次裁剪，保留最新问题 |
| `AGENT_CONTEXT_MAX_BYTES` | `16000` | 1000–128000 的整数，约束初始消息与工具定义的 UTF-8 JSON 字节数；还受模型剩余上下文上限约束 |
| `AGENT_RETRIEVAL_MODE` | `ranked` | `diverse` 优先不同文档，再补非重叠片段，同文档最多两段，总计最多五段 |
| `AGENT_EVIDENCE_REPORTS` | `false` | `true` 将结构化证据快照保存到消息并提供聊天展开/JSON 导出 |

```dotenv
AGENT_CONTEXT_MODE=budgeted
AGENT_CONTEXT_MAX_BYTES=16000
AGENT_RETRIEVAL_MODE=diverse
AGENT_EVIDENCE_REPORTS=true
```

budgeted 先移除窗口起点的孤立回答，再从最早轮次开始移除，省略数量进入系统提示和消息 metadata。系统指令、已选知识/Skill、工具 schema 与当前问题不因预算被截短，仍放不下则返回 422，模型不会收到请求。每条历史原有 20,000 字符上限不变；裁剪范围仅是初始文本历史，当前工具往返和 Responses reasoning 始终完整。原六次调用、累计 token 与费用门禁继续生效，裁剪不会绕过它们；工具结果过大仍可能在后续轮次触发预算拒绝。这不是模型摘要或长期记忆，被省略对象应由用户重新明确。

diverse 只重新选择已通过 ACL、启用、子领域绑定、有效期过滤后的 FTS 候选，不扩展权限或创建 embedding。优先文档覆盖可能减少单文档细节，需用实际问题评估是否合适。独立 `/api/knowledge/search` 仍保留原排序，当前开关只影响 Agent 上下文。

证据报告由 Node 读取本轮持久工具步骤、来源版本、MCP 发现失败和上下文统计生成，包含 runId/stepId，成功、待审批与已保存错误均可回看。报告不包含问题/模型回答正文、参数、原始工具返回、密钥或连接地址；它是生成消息时的快照，审批/核对后的最新状态去执行中心查看。`businessStatus=not_assessed` 明确不以“聊天完成”推断业务健康；实际巡检判定仍由 inspection 负责。下载在浏览器本地生成 JSON，不新增接口或扩大会话权限。

未使用网页增强配置时，回退任一增强只需恢复对应默认值并重启当前兼容构建；网页增强配置生效时应暂停，或保存新的增强配置后重新预检启用；已保存报告仍可回看，没有新表或 schema 迁移。三开关对照、组合及协议/权限测试见 [第四期设计](../openspec/changes/agent-evidence-enhancements/design.md) 和 [清单](../openspec/changes/agent-evidence-enhancements/tasks.md)。第四期不启用多 Agent；第六期独立复核见下文，真实模型质量收益仍待评测。语义摘要/向量检索尚未启用。

## 第六期：独立证据复核

聊天输入区开启“独立复核”后再发送，当前请求按固定的分析 Agent → 复核 Agent 顺序运行。关闭时保持单 Agent 六轮工具往返上限；开启时分析最多五轮、复核最多一轮，每轮最多六次网络尝试。两阶段使用同一已配置模型与锁定 AgentScope SDK，但各自创建独立 Worker 上下文，无跨会话 AgentState。复核默认关闭，会增加一次模型请求及等待时间，不保证质量提升。

开关在当前打开的会话中保留选择，新会话和刷新后恢复关闭，运行中不能切换；历史复核记录始终按消息保存的状态展示。展开“分析 → 复核”可核对调用次数、token 和中文原因，点击“导出复核 JSON”下载同一份元数据。

分析 Agent 继续使用当前授权的子领域、Skill、知识、MCP。复核 Agent 无工具，只接收当前问题、分析实际收到的文本历史、授权知识片段、本轮实际工具参数/输出与持久步骤状态、发现缺口和候选答复；不继承分析系统/Skill 指令、工具定义、Responses opaque reasoning。所有输入均作为待核实数据，历史不能充当实时证据。嵌套 JSON 前先执行出口脱敏/阻断，不把模型凭据或 MCP Token 交给 Worker。

复核专用出口逐层处理 MCP 文本中的 JSON 字符串及转义字段，保留 int64 数字原文；超过 12 层或命中 block 策略时停止复核，不发布草稿。这是复核上下文的补强，通用分析模型出口仍沿用既有文本模式保护，不能声称覆盖所有敏感数据。知识有效期在检索时筛选，复核使用当轮已选快照，不重新检索。

复核前、真正请求模型前和结束后重查用户与所用资源权限/版本。新请求仍经过既有模型模块出口策略及同一个 execution 的预算、计费、并发、超时、取消。复核输入过大、工具输出已经截断或剩余预算不足时不丢弃证据来凑预算，而是停止复核并暂不展示原答复。明确临时模型故障沿用当前请求最多五次重试、首字节默认90秒/流中静默默认180秒及整轮默认420秒限制；未知错误和工具尝试没有自动重放、修复或再次分析。

复核 Worker 崩溃会中止本阶段挂起的模型请求并收尾为 unavailable，用户取消仍终止整个执行；失败请求计调用数，未返回用量时不会虚构供应商实际 token。

复核只能返回严格 JSON：通过时 `{"verdict":"pass","reasons":[]}`，未通过时 `{"verdict":"block","reasons":["target_mismatch"]}`。目标替换、无依据断言、证据缺失、陈旧和冲突是固定原因；未知/重复原因、额外字段、Markdown 包裹、pass 搭配问题均不接受。只在合法通过时展示原分析文本；其他情况返回固定提示，候选草稿和复核原始文本不写入聊天。等待写审批时直接跳过复核，仍由执行中心人工审批与确定性核验。

“分析→复核”消息详情持久保存两阶段实际请求数/token 与结果，可刷新回看、下载 JSON。`accepted` 不表示人工批准或业务健康；`blocked` 与 `unavailable` 不抹除已经执行的工具证据。复核发生在查询之后，不能阻止或撤销此前查询。当前已有独立的结构化只读目标绑定门禁，本机 DTS 资源三字段策略已同步；真实直查与受控拒绝通过，但保存模型完整网页正例仍需稳定性复验。本复核能力只根据证据审查候选答案。真实模型可能误判或受数据指令影响，需要真实质量评测与人工复核。

独立复核交付时没有新增迁移；当前数据库为 schema v7，任务目标绑定增加了新列，v7新增委派生命周期。API/元数据见 [接口参考](reference.md)，实施范围见 [第六期设计](../openspec/changes/independent-agent-review/design.md)。临时 fixture 验证命令：`node --test tests/agent-review.test.mjs`、`npm test`、`AGENTSCOPE_WORKER_MODE=cold npm test`、`PLAYWRIGHT_CHANNEL=chrome npm run test:review:browser`。这些检查不能代替真实 DTS 业务复验。

对照 DTS 当前源码：暂停页区分人工暂停、引擎暂停和 HA 备节点待命，既有状态工具未返回 HA 字段，不能据 paused=true 推断故障或主备角色；worker_delay_seconds=0 只证明该字段为零。暂停页 30 秒与健康汇总 60 秒不是统一 SLA。本地 DTS 评测分别记录查询与最终巡检时点，超过 60 秒后不沿用历史 fresh 判正常，具体源码证据与未验证项见 [接入交接](../integrations/dts-mcp/HANDOFF.md)。

## 工具去重、审批与恢复

连接或工具发现失败时，Node 把资源 ID、服务名、`phase=discovery`、固定 `MCP_UNAVAILABLE` 码和说明保存到 `metadata.mcpFailures`，并以 `mcp.unavailable` 记审计。模型明确收到本轮未取得该服务实时数据的提示，不能用历史结果确认当前状态。最终回答、待审批说明和已保存错误消息均保留这份证据；聊天“未取得实时数据”提示刷新后仍可回看。记录不包含原始异常、服务地址或凭据；发现失败不伪装为工具步骤。发现期间取消/超时直接终止，不继续调用模型。缓存命中后实际调用才失败的情况仍由工具步骤记录。

数据库自动顺序升级到 schema v7。`executions.runtime/runtime_version` 记录所选路径；`tool_steps.call_key/call_hash/response_encrypted` 保存调用身份、参数/资源修订摘要与加密原始返回。`(run_id, call_key)` 唯一约束与步骤在同一条 INSERT 中写入。v7 的 agent_delegations 保存加密任务/结果和父执行关联，备份/轮换覆盖这些字段，重启标记活动子任务中断而不重放。v6 的 tasks.target_binding 保存可空的任务目标；旧步骤、旧任务与审批保持可读，受保护工具缺任务绑定时拒绝调用。

模型的 provider call ID 加上模型调用序号形成内部别名，允许供应商在不同模型轮次重复使用 ID；供应商原始 ID 仍用于 Responses 续传。AgentScope 的 `replyId` 与内部 call ID 组成持久身份。

- 同一事件序号且内容完全相同：管道重发原响应，不重复调用模型或工具；同序号不同内容拒绝。
- 同一步骤身份且参数一致：复核当前授权后返回原待审批状态或已保存的成功返回；参数或资源修订不同则拒绝。
- 正在执行、失败、未知、已取消等状态：拒绝重放；对账确认成功但没有原始返回时也不重放。
- 写计划进入待审批后：停止 Worker，不执行本批后续工具；审批仍走原 API、另一位生产管理员、TTL、版本检查及写后核验，不自动续聊。

取消、超时、Worker 崩溃或协议异常会停止子进程（prefork 销毁整个父子进程组），取消当前模型/MCP 等待，等待回调清理后释放会话锁与执行槽位。不重放本轮，也不改用另一引擎重新执行。prefork 为后续新任务补建父进程；基础设施失败从 250ms 指数退避，最长 30 秒，关闭应用时停止补建。Node 重启沿用 interrupted/unknown 恢复规则；远端副作用不能靠取消回滚。

管道单帧最多 2 MB、输出累计最多 16 MB、最多 256 个事件与 128 个请求序号；写入等待管道背压。异常内容不把库堆栈和原始上下文暴露给浏览器。进程资源仍须由服务管理器/容器限额控制。

## 状态与资源观测

管理员 `/api/operations` 的 `runtime` 包含 mode、ready、父/子 PID、阶段、已服务轮数、排队长度、启动/完成/失败/取消/回收计数、最近固定错误与重试时间。运行记录的版本分别为 `2.0.8/bridge-v2-prefork` 或 `2.0.8/bridge-v1`；本期无需新增数据库迁移。

带独立 Bearer token 的 `/metrics` 增加 `aiops_agent_runtime_ready`、各阶段 `aiops_agent_workers`、`aiops_agent_pool_queued`、生命周期计数及等待/运行秒数。`aiops_agent_child_cpu_seconds_total` 来自成功回收的子进程；`aiops_agent_child_peak_rss_bytes` 是这些子进程的最高峰值，`aiops_agent_preloader_peak_rss_bytes_sum` 是当前父进程各自峰值之和。它们不是实时内存、容器总内存或被取消进程的完整 CPU 成本；fork 的共享页可能被重复计入，不能将父子 RSS 简单相加当作物理内存。目标容量还应结合 cgroup/宿主监控。告警模板覆盖不可用、积压和持续启动失败。

`aiops_agent_trace_duration_seconds_bucket/count/sum` 从已完成全景的实际耗时累积，标签仅有固定 `stage=run|model|tool|mcp|review`；`aiops_agent_trace_outcomes_total` 只有固定结果状态。它们是进程级内存指标，重启清零，幂等回读不再累计。现有 `aiops_model_cost_total` 由配置单价估算，不是供应商账单。

### 可选 OTLP 链路出口

默认不连接外部采集器，也不向模型或 MCP 发送 `traceparent`。仅在可信部署配置中设置：

```dotenv
OTEL_EXPORTER_OTLP_TRACES_ENDPOINT=https://collector.example.com/v1/traces
OTEL_TRACES_SAMPLE_RATE=0.1
OTEL_PROPAGATE=true
OTEL_EXPORT_TIMEOUT_MS=2000
```

`OTEL_EXPORTER_OTLP_TRACES_ENDPOINT` 是完整 OTLP/HTTP JSON traces 接收地址；留空即关闭导出。生产环境需将其 origin 加入既有 `OUTBOUND_ALLOWED_ORIGINS`，私网目标还需 `OUTBOUND_PRIVATE_ORIGINS`，HTTP 例外需 `OUTBOUND_HTTP_ORIGINS`。出口沿用固定 DNS 的 `safeFetch`，不跟随重定向；配置错误启动失败，网络或 Collector 故障不改变 Agent 结果。当前出口只支持无需额外认证的 Collector 地址，应在可信代理内配置采集器认证；不要把 API Key 放在 URL。

`OTEL_TRACES_SAMPLE_RATE` 为 0–1，默认 1；每轮用随机 trace ID 做确定性整轮采样，采样位同时写入传播头。`OTEL_PROPAGATE` 默认 false；启用后仅本轮 Agent 的模型请求、MCP 发现与实际工具请求发送 W3C `traceparent`，不会接受浏览器传入的父 trace，也不改变固定工具/Runbook 的传播。出口与传播可分别开启；远端是否继续该 trace 需在目标服务验收。`OTEL_EXPORT_TIMEOUT_MS` 限定单次发送为 100–10000ms，默认 2000ms。

导出 payload 仅含固定 `service.name/version`、`aiops.stage/outcome`、OTLP traces JSON 使用的十六进制 trace/span/父 ID、固定 span 名和毫秒精度的时间；不发送 run/user ID、问题/答复、模型名、资源名、工具参数/返回、凭据或图谱 summary/details。省略的本地图谱父节点会映射到最近已导出的祖先，保证外部树完整。每实例最多积压 128 个整轮 payload、单路发送、无自动重试；满队列及关闭时尚未发送的项目丢弃，在途发送会取消。单次发送的等待包含 DNS 阶段并受超时限制；底层 DNS 查询可能稍后收尾，但已取消的 HTTP 请求不会继续发送。`/metrics` 固定 `aiops_agent_otlp_exports_total{status="sent|failed|dropped|sampled_out"}` 和队列深度，重启清零，不带用户标签。Collector 不进入 `/readyz`，发送属于尽力而为，进程硬退出会丢弃内存队列；发出记录也可能先于消息持久化，不作为审计或质量放行证明。跨实例汇总由外部 Collector 负责。

## 回滚与排查

只回退池实现时，改为 `AGENTSCOPE_WORKER_MODE=cold` 后重启当前构建；原运行的去重、权限和审批规则相同，但每轮重新导入 SDK 的延迟恢复。

当前构建不支持切换到 legacy。旧配置必须迁移到 AgentScope；SDK 或 Worker 故障需要修复依赖、解释器或资源配置。失败 run 不会自动重放，unknown 先只读核对。可在 cold/prefork 两种模式间调整启动方式，审批、权限与去重规则相同。

schema v7 没有自动降级；旧二进制可能拒绝打开。二进制回退必须使用兼容 schema 的构建，或在新目录恢复对应备份并核对备份后的远程操作，不能只修改 `user_version`。

恢复测试在临时数据库使用 AgentScope 产生 unknown 和独立待审批计划，实际加密备份、换钥后重启；原工具返回可解密，unknown 只读核对，生产待审批仍需另一管理员且只执行一次。旧执行记录保留原引擎标签，迁移后的新聊天必须进入 SDK。测试使用独立假写服务；目标环境的备份保管、RPO/RTO 和旧二进制恢复仍需部署验收。

| 现象 | 排查 |
| --- | --- |
| 503 Worker 无法启动 | 检查解释器绝对路径、执行权限；运行 `npm run agent:check` |
| 429 进程等待超时/队列已满 | 查看池积压和执行耗时；结合内存/CPU 调整池大小与上层并发，不仅延长超时 |
| readyz 503 | 查看管理员运行时状态；检查 Python/SDK、启动退避、数据库、磁盘和关闭状态 |
| 502 初始化或运行失败 | 使用 Python 3.12 重新 frozen sync；核对 agentscope==2.0.8，不改为 latest |
| 502 意外退出/协议错误 | 检查进程管理器退出原因与内存限制；本轮没有自动重放，查看原执行记录 |
| 400/403 工具参数或权限拒绝 | 检查模型原始参数、Schema、参数范围、用户与资源当前授权；不依赖框架 JSON 修复 |
| 422 调用/预算上限 | 缩小问题和指令，检查真实调用次数与累计用量；不要仅调大 AgentScope max_iters |

## 开发与验收入口

```sh
npm test
npm run test:agentscope
AGENTSCOPE_WORKER_MODE=cold npm run test:agentscope
npm run build
npm run agent:benchmark
npm run agent:eval
npm run agent:eval:dts -- --repeat 3
npm run agent:eval:enhancements
npm run test:rollout:browser
npm run agent:audit
# 先构建镜像，并安装 Trivy 0.74.0
npm run agent:image:audit -- aiops:agentscope-only
npm run docs:build
npm run docs:check
```

`agent:benchmark` 按 cold、prefork 顺序运行各 30 个并发 fixture 请求，固定每用户并发 2、池大小 2；预热单独计时。比较同一 AgentScope SDK 的启动模式，输出 P50/P95、资源样本与 prefork/cold 建议门槛。不把一次本机测量当作生产容量承诺。

`agent:eval:enhancements` 对 baseline、仅裁剪、仅多文档、仅报告、全部启用五组配置分别测试短历史、中等历史与超预算历史，当前 AgentScope Worker 模式共 15 组。核对实际模型/工具调用数、请求体字节、来源文档数、报告开关和预期的预算拒绝；本地 fixture token 固定，不冒称真实省费或诊断质量提升。结果保存在 `enhancement-evaluation.json`。

`agent:eval` 在 AgentScope cold/prefork 使用相同四个问题、本地只读 MCP 和临时数据库，检查实际 SDK 路径、工具证据、token 与延迟。显式 `--real` 时要求 `EVAL_MODEL_BASE_URL`、`EVAL_MODEL_NAME`，可配置 `EVAL_MODEL_API_KEY`、`EVAL_MODEL_API_TYPE`；仅替换模型，工具仍为本地 fixture，调用会产生费用。四个固定问题不能自动证明诊断质量或拒绝措辞。

`agent:eval:dts` 使用实际 DTS 适配器、接入知识/Skill 和本地 HTTP/MCP 构造 30 个合成场景，AgentScope cold/prefork 各重复三次共 180 条。覆盖 int64 字符串 ID、跨域/区域拒绝、时间新鲜度、状态缺字段、暂停/结束/异常、错误响应、上游指令注入和多轮查询。断言实际步骤、原始参数、上游请求数、巡检判定与 token，输出逐条答案及人工评分标准。`--repeat` 支持 1–10，默认 1；`--real` 使用上述模型变量，工具仍为本地 fixture。报告始终待人工审阅，`productionQualityAccepted=false`。故障场景含 Worker 重建，不能代替独立稳定负载基准。

`agent:audit` 用 uv 冻结导出当前平台依赖并运行固定 pip-audit 2.9.0；`UV_BIN` 可指定 uv 路径。审计需要网络，报告不包含业务密钥。基准、评测、Python 审计和容器报告位于 Git 忽略的 `test-results/agentscope/`。

`agent:image:audit` 使用 Trivy 扫描本地 Docker 镜像，先固定镜像 ID，再检查 OS、Python 和 Node 包；`TRIVY_BIN` 可指定可执行文件。它同时产出完整漏洞 JSON、CycloneDX SBOM 和摘要。覆盖缺失、扫描失败或存在可修复 HIGH/CRITICAL 会返回非零。未修复和低等级告警完整保留，门禁通过不等于安全验收：本轮 arm64 镜像可修复 HIGH/CRITICAL 为 0，仍有 60 条发行版未给出修复版本的 HIGH/CRITICAL，`productionSecurityAccepted=false`。详见 [验证记录](verification.md)。

`npm test` 与 `npm run test:agentscope` 都先执行真实 SDK 探针，再运行完整业务回归和 SDK 专项；Python/SDK 缺失或错误时明确失败，不能跳过或降级。CI 使用 cold/prefork 矩阵、冻结依赖、DTS 评测、依赖审计、默认镜像构建/断网验收和镜像扫描/SBOM；远程 CI 状态以真实流水线为准。入口见 [运行时地图](../server/agent-runtime/codemap.md) 和 [Worker 地图](../agent-worker/codemap.md)。
