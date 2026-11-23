# 部署、排错、验证与接手

## 启动与发布

开发：Node.js >=22.16、Python 3.12 和 uv；npm ci、uv sync --project agent-worker --frozen 后 npm run dev，浏览器访问 localhost:5173。生产构建 npm run build，npm start 同源提供 dist 与 API。正式环境设置 NODE_ENV=production 并按 [生产治理](production.md) 配置必需项；Dockerfile 已设置生产模式。

2026-10-08 本机观测环境使用 `node --env-file=.env.observability.local scripts/dev.mjs` 启动；私有环境文件被 Git 忽略。Prometheus 页面为 `http://localhost:9090`，Collector/Tempo/Prometheus 恢复和保留卷停止命令见[观测部署说明](../deploy/observability/README.md)。独立代码服务的健康、提交、独立预览/批准、下载和删除使用 `npm run sandbox:control -- ...`；已部署配置位置与命令见[沙箱接入说明](../integrations/agent-sandbox/README.md)。不要将提交配置或审阅配置内容复制到模型提示中。

compose.yaml 使用一个非 root 容器、只读根文件系统、数据与审计卷、外部 master-key Secret。准备 APP_ORIGIN、OUTBOUND_ALLOWED_ORIGINS、MASTER_KEY_FILE 等后执行 docker compose up --build -d。应用端口仅映射到本机，前方部署 TLS 代理；/api/chat 关闭代理缓冲，读取超时覆盖执行预算。

模型、MCP 与身份配置不能从示例域名推断为可用。APP_ORIGIN 应精确匹配浏览器 Origin，不附路径。TRUST_PROXY 只信任实际代理网段。网关身份模式必须清除外部身份头并由网关签名。

AgentScope 是唯一 Python 编排运行时，默认采用预加载池与每轮独立子进程。默认 Docker/Compose 包含 Python 和锁定 SDK，无需覆盖文件。正式入口先预热再监听，`/readyz` 始终检查 Worker；`npm run agent:check` 验证 SDK 工具往返。配置、容器验收、资源指标与故障恢复见 [AgentScope 运行指南](agentscope-runtime.md)。

AgentScope 最终镜像已移除 npm/pip/uv。容器内使用 `node scripts/check-agent-worker.mjs` 与 `node scripts/ops.mjs ...`；下面的 `npm run ops -- ...` 示例用于源码宿主环境，容器中将该前缀替换为 `node scripts/ops.mjs`，并使用已挂载的数据、密钥和备份目录。

## 定时与重启语义

调度器每秒查询到期任务，在短 SQLite 事务中领取覆盖排队时限、整轮执行时限及30秒清理余量的租约（默认480秒）并写 task_runs。执行采用任务创建者的当前身份，调用与聊天相同的 execution / Agent。任务并发最多四个，同时受全局/用户执行限额约束。

| 场景 | 当前行为 |
| --- | --- |
| 停机错过多个 Cron 周期 | 恢复后补一次，再计算未来时间 |
| 原执行中断 | task_runs 启动恢复或租约过期标 interrupted 并入队通知；execution 启动时标 interrupted/unknown，不自动重放 |
| 暂停任务 | 停止未来领取，已开始的继续；可在执行中心另行取消 |
| 手动执行 | 可运行暂停任务，不改 next_run |
| 写操作计划 | 调度结果为 awaiting_approval，最新状态看执行中心 |
| 所有者停用 / 子领域未发布 | 执行失败，不以管理员身份代跑 |
| 某 MCP 不可用 | Agent 将发现失败存入消息并明确告知模型/用户缺少实时证据，继续其他资料；取消不继续模型，固定 Runbook 失败则停止 |

任务与远程系统之间没有分布式事务。不能把租约当成 exactly-once，也不能因为超时就假定远程没有执行。

## 服务关闭

SIGINT/SIGTERM 先中止 Agent 与 execution，停止接入新 HTTP；应用 close 停止运维定时器和 scheduler，等待活跃执行清理后关闭 SQLite。入口另有十秒强制退出上限。远程已发生操作不会回滚；重启之后核对 unknown。

## 数据与备份

开发数据目录含 aiops.sqlite、WAL/SHM 和 master.key；生产 key 位于外部挂载路径。丢失密钥时应用拒绝为已有数据库生成替代密钥。数据库与密钥必须配对恢复。

使用独立 BACKUP_KEY_FILE 的在线加密备份工具，无需复制正在运行的主 SQLite 文件。正常完成或可捕获异常时，在线快照加密后清理临时 SQLite 主文件及 `-wal`、`-shm`、`-journal` sidecar；最终备份目录应仅有 `database.enc`、`manifest.json`。进程硬退出时清理无法运行，权限受限目录仍可能留有明文快照；恢复或重试前检查目录内容。恢复与轮换只写入新目录，不覆盖正常运行的数据。

```sh
npm run ops -- backup .data /secure/backups/new-backup
npm run ops -- restore /secure/backups/new-backup /secure/new-restore
npm run ops -- rotate /secure/backups/new-backup /secure/new-key-restore
npm run ops -- audit-check .data
npm run ops -- retention .data
```

retention 默认预览，至少保留 30 天；加 --apply 才删除已闲置的旧会话，要求 24 小时内成功备份。执行与审计证据不自动删除。企业定时系统负责调度备份、异机复制、备份超龄告警和恢复演练。详细流程与回退边界见 [生产治理](production.md)。

## 按现象排错

| 现象 | 检查 |
| --- | --- |
| 生产进程拒绝启动 | HTTPS Origin、Secure Cookie、AUTH_MODE、外置 32 字节 key、出口列表 |
| 登录后仍要求登录 | 浏览器主机名、Cookie Secure、企业签名的 aud/exp/MFA 与账号启用状态 |
| 上传 Skill 提示“接口不存在” | 检查 3001 是否为升级前启动的旧后端；非 watch 进程不会因前端刷新而更新。正常停止旧进程后从当前目录重启，重新选择 ZIP |
| 网页启动在 5174、接口行为仍旧 | Vite 遇到 5173 占用会换端口，但 API 代理仍指向 3001；核对前后端进程的启动时间和工作目录，避免混用版本 |
| 旧 Skill 不生效 | 升级后为草稿；管理员核对当前版本再发布 |
| Skill 列表“已启用”但新对话不使用 | 启用与发布是两个状态，进入详情顶部确认已发布；发布按钮在“版本历史与发布”折叠区域 |
| 工具已勾选仍不能执行 | toolPolicies、角色/userIds、环境、参数范围、JSON Schema、发布/配置版本 |
| 只读查询提示确认目标或目标不一致 | 核对工具策略 requiredTargetFields、聊天本轮/定时任务已确认的资源、工具、环境和全部字段；旧任务在「查询目标」补配，不从正文猜测 |
| 模型无法连接 | 供应商地址/Key/额度、出口允许 origin、内网放行、HTTP 明文例外 |
| 429 | 用户速率、全局/用户并发、队列容量、UTC 日额度与预留预算 |
| 422 上下文预算不足 | 减少 Skill、附件和历史；核对模型上下文与输出限制 |
| 审批 403/409 | 是否另一位管理员、是否过期、发起者/审批人是否被停用、资源/schema 是否变化 |
| unknown | 先只读核验或人工检查远程系统，不重复提交写操作 |
| Runbook 拒绝执行 | 是否双人发布、模板资源版本、自动开关、工具 automatic、reviewer 是否仍有效 |
| 备份失败 | BACKUP_KEY_FILE、目标新目录、读写权限、空间、数据库完整性 |
| 无通知 | 通知中心查看任务是否选择渠道、判定条件与抑制规则、投递失败原因/重试时间；旧出口查看 notifications，详见[通知手册](notifications.md) |
| readyz 503 | 数据库可读性、磁盘阈值、关闭状态或选中运行时不可用；查看管理员 runtime 状态并运行 agent:check |

## 验证路径

```sh
npm test
npm run build
npm run verify:production
npm run test:load
npm run docs:build
npm run docs:check
```

集成测试在临时目录启动真实 Express 和本地模型/MCP fixture。生产验证覆盖发布、策略、审批、幂等、未知结果、恢复、备份与场景。负载脚本发起 30 个同时到达的 HTTP 对话并检查实际并发/排队，不访问真实供应商。实际结果与未验证项必须更新 [验证记录](verification.md)。

AgentScope 专项入口包括 `npm run agent:eval:dts -- --repeat 3`（30 场景，cold/prefork 各三次，共 180 条），以及构建后执行 `npm run agent:image:audit -- image-tag`（Trivy OS/Python/Node 扫描与 SBOM）。本地恢复测试覆盖换钥后 unknown 核对、双人审批与 AgentScope 重启；不代表生产 RPO/RTO。

第四期通过 `AGENT_CONTEXT_MODE=budgeted`、`AGENT_RETRIEVAL_MODE=diverse`、`AGENT_EVIDENCE_REPORTS=true` 分别开启历史预算、多文档选择和证据报告，默认均保留原行为。独立及组合对照用 `npm run agent:eval:enhancements`；容器启动验收用 `npm run agent:container -- image-tag --enhancements`。将对应配置恢复 recent/ranked/false 并重启当前构建可回退，历史报告仍可读取，无数据库迁移。详细预算与数据边界见 [运行指南](agentscope-runtime.md)。

CI 已同步这些命令；未实际运行的 CI 不视为已通过。镜像门禁只阻断可修复 HIGH/CRITICAL，残余漏洞须另外审核。外部模型质量、真实负载、SSO、生产恢复目标需用真实环境单独验收。

## 接手与改动

先读 [源码地图](../codemap.md)。权限与范围改动查 governance/security；审批与状态查 execution；Agent 上下文查 agent/model；知识查 retrieval；告警与固定流程查 runbooks；备份和可观测查 backup/operations。

每次可观察行为变化同步 API 类型、必要界面、测试与 Markdown，更新 verification，再构建并检查离线官网。官网生成物不可直接修改。交接资料至少包括实际工具策略、角色授权、已验证供应商版本、备份/密钥恢复流程、告警负责人、发布/回退版本，以及尚未通过的门禁。

## 增强配置与候选验收

管理员网页仅配置增强作用域。`settings.agent:rollout` 随既有 SQLite 备份保存，无新增 schema 迁移。启用/暂停有 revision 和审计，运行消息有固定策略快照；旧 active/paused 策略分别保留增强作用域/关闭增强语义，运行时统一 AgentScope。升级时移除旧运行时白名单并设置或省略 `AGENT_RUNTIME=agentscope`；显式 legacy 或非空旧白名单会阻止启动。

暂停增强只改变后续轮次的增强设置，预热主池继续服务所有请求；底层状态在 `/api/operations.runtime`，metrics 计实际池资源。暂停后重启仍预热 Worker，Python 故障仍会阻止就绪。需要取消业务时使用执行中心，取消不撤销远程副作用。

`npm run test:rollout:browser` 验证临时实例的增强 UI，要求锁定 Python 环境及 Playwright。`npm run agent:container -- image-tag --enhancements --rollout` 在断网容器内验证本地探针、增强管理和退出。`agent:acceptance` 汇总 version=3 DTS 报告与人工复核文件：0 为评测门槛通过，2 为待验收/门槛未通过，1 为输入无效/执行失败；任何情况下都不是生产批准。参数和模板流程见 [运行指南](agentscope-runtime.md)。
