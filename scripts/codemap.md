# scripts/ · 开发与文档脚本

## 职责

| 文件 | 用途 | 调用 |
| --- | --- | --- |
| [dev.mjs](dev.mjs) | 同时启动 Node watch API 和 Vite，终止时结束两个子进程 | npm run dev |
| [dts-local.mjs](dts-local.mjs) | macOS launchd 安装/状态/重启/停止，以及显式管理员本机 DTS 资源初始化与 sync-policy 任务范围同步；不输出令牌 | npm run dts:local -- status |
| [dts-sandbox-package.mjs](dts-sandbox-package.mjs) | 独立DTS沙箱最小源码与锁文件归档/SHA清单；排除凭据、应用数据及本地依赖，拒绝覆盖 | node scripts/dts-sandbox-package.mjs NEW_ARCHIVE.tar.gz |
| [build-docs.mjs](build-docs.mjs) | 从 Markdown、官网样式 / JS / 图示生成可离线 HTML；内联共用品牌 SVG 并纳入源码摘要；校验链接和生成一致性 | npm run docs:build / npm run docs:check |
| [build-request-flow.mjs](build-request-flow.mjs) | 从流程JSON与独立模板生成/检查请求图，校对节点及示例引用；由build-docs调用 | npm run docs:build / npm run docs:check |
| [ops.mjs](ops.mjs) | 加密备份、新目录恢复/轮换、审计链检查、留存预览/执行 | npm run ops -- ... |
| [load-test.mjs](load-test.mjs) | 临时目录和本地协议服务，30 个同时到达的 HTTP 请求验证排队/并发 | npm run test:load |
| [check-agent-worker.mjs](check-agent-worker.mjs) | 真实锁定 SDK 的本地模型/外部工具往返探针，不打开业务数据库 | npm run agent:check |
| [learn-agent-react.mjs](learn-agent-react.mjs) | 真实 SDK + 独立本地只读 fixture 的正常往返、非法参数、六次上限实验；对照请求观测与台账，生成中文/JSON 报告，不接受真实模式 | npm run agent:learn:react |
| [learn-agent-context.mjs](learn-agent-context.mjs) | 真实 SDK + 六组临时本地实验：ranked/diverse、历史预算/任务ID可见性、必需输入拒绝；区分请求体/上下文字节，生成中文/JSON报告 | npm run agent:learn:context |
| [learn-agent-intent.mjs](learn-agent-intent.mjs) | 真实 SDK + 三组本地只读目标对照：选对、授权内选错、越权；核对提议/实际/持久/反馈目标，区分实验通过与意图满足 | npm run agent:learn:intent |
| [learn-agent-unknown.mjs](learn-agent-unknown.mjs) | 固定执行器direct的本机写入故障实验：发送前失败/取消、写后丢回包/取消、只读对账；分开请求与应用次数，模型0 | npm run agent:learn:unknown |
| [learn-agent-review.mjs](learn-agent-review.mjs) | 真实SDK五组独立复核实验：pass/block/unavailable、预设错误pass、实际证据和候选发布回读；人工评价保持pending | npm run agent:learn:review |
| [learn-agent-trace.mjs](learn-agent-trace.mjs) | 真实SDK四组本机观测实验：模型/工具等待、工具错误、成功查询业务异常；实际脱敏trace与台账、固定用量和观察器时间分开 | npm run agent:learn:trace |
| [benchmark-agent-runtime.mjs](benchmark-agent-runtime.mjs) | 顺序对比同一锁定 AgentScope SDK 的 cold/prefork，记录预热、并发 P50/P95、资源样本及建议门槛 | npm run agent:benchmark |
| [audit-agent-worker.mjs](audit-agent-worker.mjs) | uv 冻结导出、固定 pip-audit 审计，报告保存到 test-results/agentscope | npm run agent:audit |
| [evaluate-agent-runtime.mjs](evaluate-agent-runtime.mjs) | AgentScope cold/prefork 的工具证据/用量/延迟对比；可显式使用真实模型，工具始终为本地只读 fixture | npm run agent:eval |
| [evaluate-dts-runtime.mjs](evaluate-dts-runtime.mjs) | 30 个 DTS 合成场景 × AgentScope cold/prefork，实际适配器/步骤/巡检断言和待人审答案；语料在 tests/dts-evaluation-cases.mjs | npm run agent:eval:dts -- --repeat 3 |
| [agent-candidate.mjs](agent-candidate.mjs) | 固定根目录的源码/语料 SHA256，不读 .env/.data，不伪造 Git 版本 | 评测/验收共用 |
| [agent-acceptance.mjs](agent-acceptance.mjs) | v3逐条答复/证据/rubric绑定，自动观察复算、AI/人工门槛与token/P95 | CLI 与 tests/agent-acceptance.test.mjs 共用 |
| [agent-quality-corpus.mjs](agent-quality-corpus.mjs) / [agent-quality.mjs](agent-quality.mjs) | 脱敏问题/失败样本、来源确认、候选摘要与分类复核；不运行模型、不批准生产 | node scripts/agent-quality.mjs init/add/template/check |
| [quality-replay-cases.mjs](quality-replay-cases.mjs) / [evaluate-quality-replay.mjs](evaluate-quality-replay.mjs) | 将两条质量摘要重构为合成目标与问题；临时 DTS 链路验证前置授权和精确只读步骤，可显式改用真实模型；私有报告始终待人审 | npm run agent:eval:quality -- --out FILE [--real] |
| [quality-replay-review.mjs](quality-replay-review.mjs) / [review-quality-replay.mjs](review-quality-replay.mjs) | 回放报告 SHA256、候选和逐条阶段/输出摘要绑定的工程复核模板；区分 AI/人工/未声明，复算阶段证据，私有排他输出，不批准生产 | npm run agent:review:quality -- template/check ... |
| [accept-agent-candidate.mjs](accept-agent-candidate.mjs) | 私有排他模板/完整复核包，工程或正式验收和0/2/1退出码，不批准生产 | npm run agent:acceptance -- --report FILE [--packet NEW_FILE] [--engineering] |
| [rollout-browser-smoke.mjs](rollout-browser-smoke.mjs) | 临时真实 SDK 实例的草稿/刷新/键盘启用/暂停/范围/CAS/320px 验证 | npm run test:rollout:browser |
| [evaluate-agent-enhancements.mjs](evaluate-agent-enhancements.mjs) | AgentScope × baseline/三个独立开关/组合 × 三种历史；核对请求字节、来源文档、实际调用与预算拒绝，不评价模型质量 | npm run agent:eval:enhancements |
| [audit-agent-image.mjs](audit-agent-image.mjs) | 固定本地镜像 ID，Trivy 检查 OS/Python/Node 覆盖、完整漏洞 JSON 与 CycloneDX；阻断可修复 HIGH/CRITICAL | npm run agent:image:audit -- image-tag |
| [smoke-agent-container.mjs](smoke-agent-container.mjs) | 固定镜像 ID、临时断网只读容器、SDK 探针/就绪/指标/退出；--enhancements 验证增强配置，--rollout 验证管理员预检/启用/暂停；清理自身资源 | npm run agent:container -- image-tag --enhancements |
| [sandbox-contract.mjs](sandbox-contract.mjs) / [probe-agent-sandbox.mjs](probe-agent-sandbox.mjs) | 独立沙箱协议的本机合成负面探针：检查镜像污染、禁网/只读/限额、跨轮临时盘及强制取消清理；不连接产品或执行用户代码 | npm run agent:sandbox:probe -- LOCAL_IMAGE |
| [workspace-settings-browser-smoke.mjs](workspace-settings-browser-smoke.mjs) | 本机只读夹具核对设置加载前后/切页/读取失败的几何稳定、关闭/焦点/草稿及桌面/短横屏/320px；不调用模型 | npm run test:settings:browser |
| [test-agentscope.mjs](test-agentscope.mjs) | 默认测试入口：先探针，再在 AgentScope 下运行全部回归与 Worker 专项；缺少 Python 明确失败 | npm test / npm run test:agentscope |
| [evaluate.mjs](evaluate.mjs) | 固定用例检查模型工具选择；--real 通过 EVAL_MODEL_API_TYPE 选择协议，仅提出调用不执行工具 | npm run eval |
| [streaming-browser-smoke.mjs](streaming-browser-smoke.mjs) | Chrome七组：SSE首段提前显示、双Enter防重、上滚仍可停止、连续重试正文保留/状态恢复、丢done或受理帧只读找回不重POST、320px/减少动效、键盘停止与Retry-After等待取消 | npm run test:streaming:browser |
| [http-request-id-browser-smoke.mjs](http-request-id-browser-smoke.mjs) | 真实普通 HTTP 主机名的非安全上下文回归：randomUUID 不可用、getRandomValues 可用，两轮聊天 UUID v4/增量/终态/刷新、同键幂等回读与正文冲突409、无安全随机源时保留未发送问题且不出现假消息；独立临时库与本机 Responses fixture，不读取保存模型或调用 MCP | npm run test:http:browser |
| [review-browser-smoke.mjs](review-browser-smoke.mjs) | 临时真实 SDK / 本地模型验证两协议独立复核开关、通过/拦截/不可用、草稿隔离、键盘/刷新/JSON/320px | npm run test:review:browser |
| [browser-smoke.mjs](browser-smoke.mjs) | 临时应用、配置/ZIP/发布/治理/目录、移动对话、MCP 失败、证据报告键盘/刷新/JSON 导出、历史省略和离线官网 | npm run test:browser |
| [agent-selector-browser-smoke.mjs](agent-selector-browser-smoke.mjs) | 只读界面夹具检查有框Agent入口、用途菜单、键盘焦点、历史身份、长列表和1280/320px | npm run test:agent-selector:browser |
| [chat-design-browser-smoke.mjs](chat-design-browser-smoke.mjs) | 只读本地界面夹具验证聊天侧栏查找/草稿保持、消息阅读、统一输入与附件、返回最新、桌面/320px/短横屏/导航/刷新，零写入与外部请求；--preview仅提供样例预览 | npm run test:chat-design:browser |
| [target-binding-browser-smoke.mjs](target-binding-browser-smoke.mjs) | 临时本机模型/MCP 的聊天目标确认、授权内偏移拦截、旧任务补配及桌面/320px 浏览器回归 | npm run test:target:browser |
| [dts-target-real-acceptance.mjs](dts-target-real-acceptance.mjs) | 显式真实目标验收：只读复制四项 DTS 资源到临时库；完整模式用保存模型或临时 `--model` 覆盖的浏览器正例，`--direct-only` 用真实 DTS SDK 直查；两种模式均做本地受控负例，核对实际 MCP 调用及源码/源配置摘要，输出脱敏报告 | SOURCE_DIR=.data npm run test:target:real -- --real\|--direct-only --job ID [--model MODEL] |
| [learning-browser-smoke.mjs](learning-browser-smoke.mjs) | 独立临时工作空间验证六课程、折叠答案、键盘、自评笔记、复制/导出、内存清空边界和 320px；不执行 Agent | npm run test:learning:browser |
| [local-deployment-browser-smoke.mjs](local-deployment-browser-smoke.mjs) | 隔离真实临时API验证部署页签/刷新、live与历史状态、CSV/JSON账单演示/上传/竞态/错误/下载、普通成员和1365/320px；不调用模型/工具 | npm run test:deployment:browser |
| [notification-smoke.mjs](notification-smoke.mjs) | 临时应用、企业微信错误/重发、任务判定/投递、详情互链及 320/390px 布局 | npm run test:notifications:browser |
| [scheduled-backup.mjs](scheduled-backup.mjs) | 供 systemd/企业定时系统调用，创建时间戳目录的加密备份 | deploy/aiops-backup.timer |
| [company-sandbox-package.mjs](company-sandbox-package.mjs) | 公司沙箱 PoC 的源码白名单归档与 SHA256 清单；包含 src 的 SVG 品牌资源，拒绝链接/旧输出，不读取现有 `.data`、`.env`、私有报告或集成配置 | node scripts/company-sandbox-package.mjs NEW_ARCHIVE.tar.gz |
| [company-sandbox-export-model.mjs](company-sandbox-export-model.mjs) | 用户授权后只读导出保存模型4字段至新私有JSON；拒绝源目录/旧输出，核对模型配置及主密钥摘要未变，不请求模型 | SOURCE_DIR=.data node scripts/company-sandbox-export-model.mjs --out NEW_PRIVATE_JSON |

## 开发启动流程

`spawn(process.execPath, ...)` 保证使用当前 Node。API 加载可选 .env，Vite host 为 0.0.0.0。任一子进程退出触发 stop，并向另一进程发送 SIGTERM；SIGINT / SIGTERM 也统一收尾。

Vite 的代理地址在根 vite.config.ts，修改 API PORT 需同步代理。脚本不是进程守护器，生产使用 npm start 和部署系统管理生命周期。

默认 AgentScope 镜像以 Node 直接启动，不包含 npm/pip/uv；容器内运维调用 `node scripts/ops.mjs ...`。评测和扫描脚本在开发宿主或 CI 执行，产物写入被 Git 忽略的 test-results/agentscope。

公司沙箱部署材料位于 `deploy/company-sandbox/`，新手按[公司沙箱从零部署教程](../docs/company-sandbox-tutorial.md)逐步操作，脚本职责与本次实测见[公司沙箱独立 PoC](../docs/company-sandbox.md)。`install-runtime.sh`在新实例本地盘 `/home/sandbox/poc-runtime`安装官方Node22.23.1（SHA256核对）、uv0.11.26和Python3.12，不替换系统运行时；`download-python-ranges.py`为固定Python3.12.13归档提供范围/断点/最终SHA下载，`run-poc.sh`只启动固定目录应用并拒绝活跃PID重复启动。源码归档/数据库/私有模型保留 `/workspace`，本地运行时/依赖已从持久归档同Pod还原并通过12项受控探针，平台Pod重建仍未验收。白名单源码包及 PoC 镜像包含 `scripts/model-billing.mjs`，补齐 `server/local-services.mjs` 的静态依赖；当前根 Dockerfile 未包含该新文件，本轮不修改既有镜像。独立探针验证新账号、真实 SDK、模型流式、SQLite WAL/完整性与持久回读，MCP/任务/通知拒绝；真实模型只通过本轮私有配置显式启用，用户授权的原模型配置只读导出，原数据库不迁移。

PoC入口和探针共享 `validate-store.mjs`：资源/任务/通知渠道/事件/投递/Runbook为空，匹配无工具AgentScope执行且pending/attempts0的内部失败notifications保留，不算通知发送。`validate-chat.mjs`在NDJSON中先拒error再要求有效done，聊天后再查隔离状态。`prepare-wheels.py`/`download-wheels.py`/`install-worker-offline.sh`提供保留锁文件、固定官方wheel哈希和新`.venv-offline`的备用安装路径；本轮只准备清单，未在云端启用。

沙箱合约探针同样在开发宿主执行，需可用 Docker daemon 与本地 Python 3.12 镜像；它将 tag 固定为当前 image ID，每次新建 `test-results/agentscope/sandbox-contract-probe-*.json`，也可用 `--out REPORT.json` 指定该目录内的新文件。应用镜像含 `/app`，必须被该探针拒绝。探针只验证开发机容器配置和固定合成行为，不开放代码执行 API，也不替代目标环境的内核、rootless/user namespace、产物审批及攻击验收。

## 当前评测与验收格式

DTS 评测报告 schema v3 固定 `runtime=agentscope`，每行含 `workerMode=cold|prefork`；共同配置中的 `workerModes` 为 `cold,prefork`，`comparison` 明确同 SDK 的 Worker 模式对照。两种模式分别运行完整语料，`--repeat 3` 产生 180 行。`AGENTSCOPE_WORKER_MODE` 不会把该对照缩成单一模式。增强评测则固定当前 Worker 模式，比较 baseline、三个单独开关及组合，共 15 行。

DTS 每行 inspection 记录最终 inspectedAt、expectedAssessment 与各查询快照的 reportedAt/queriedAt/两个时点年龄。语料的 expectedDtsAssessmentAt 按最后 run 的持久时间独立计算预期，查询 state/freshness 仍单独断言；查询时 fresh、最终超过 60 秒应为 unknown。tests/dts-evaluation.test.mjs 以固定时间验证边界，未放宽业务新鲜度阈值。

逐条复核与汇总使用 schema v3，键为 `agentscope/{workerMode}/{caseId}/{iteration}`，同时绑定答复/证据摘要与 rubric；`--packet` 输出审阅包，`--engineering` 选择 AI 可完成的工程门槛。旧 v1/v2 DTS 评测拒绝用于当前验收，旧 v2 复核不满足分类门槛。正式验收要求当前源码、真实模型、至少三轮和完整人工批准，`productionAccepted=false`。输出均0600排他写入，默认评测和结果名带时间戳；非法输入不覆盖旧结论。

2026-10-08 质量台账含观察失败和用户确认的真实 DTS 需求各1条，来源确认在 tests/quality-provenance.json。AI 可完成 `corpus_review`，人工完成单独报告。重构回放使用合成 ID/临时 DTS 链路；跨区域在模型前拒绝，不复现历史换目标失败。`evaluate-saved-model.mjs` 只读加载保存模型，不输出凭据或端点，支持固定Responses SSE连接诊断与真实回放，不提供--stream或完整JSON选择；失败不能改标成功。

`accept-agent-sandbox.mjs` 验证真实 Docker、SDK 取消和临时应用写审批；沙箱 `control.mjs` 使用私有配置做健康、提交及产物管理。`accept-observability.mjs` 验证官方 Collector/Tempo、双实例统计与停机隔离，`check-observability-targets.mjs` 检查独立工作空间标签。`model-billing.mjs`/`reconcile-model-billing.mjs` 严格解析 CSV/JSON，用百万分金额对账并保留差额、用量来源和未匹配项。候选摘要覆盖这些源码/观测YAML/来源材料，不包含私有部署或运行输出。

续轮复核命令为质量回放生成独立的工程复核模板和检查结果；原报告保持生成时的待审快照。摘要绑定使修改报告/输出后必须重新审阅，阶段证据复算拒绝矛盾或缺字段的旧报告。reviewerKind 区分 AI/人工/未声明，AI 可完成 replay_review，但不能计为 humanReviewComplete。受控答复从实际工具结果读取状态、上报时间、查询时间和新鲜度；完成合成回放审阅不补齐真实来源或生产放行。

## 文档构建流程

读取 docs/*.md 与根 / 分目录 codemap → marked 转 HTML → 重写仓库文档链接为站内章节 → Mermaid 块附离线 SVG 教学视图 → 内联 CSS、交互数据与 JS → 写 docs/site/index.html。

输出完整 HTML 正文，不在浏览器 fetch Markdown，不依赖 CDN。`--check` 重新计算输出但不写文件，比较已有产物并核对站内锚点和本地资源，防止文档更新后忘记重建。

架构查看器 docs/site/architecture.html 由 Archify 从 docs/diagrams/architecture.json 独立生成，普通官网重建不会覆盖它。详见 [官网维护说明](../docs/site/README.md)。

[architecture-browser-smoke.mjs](architecture-browser-smoke.mjs) 验证架构双视图入口、HTTP摘要、节点搜索/聚焦、缩放、主题、三示例逐步顺序、只读回路、待审批暂停与独立审批、键盘选择、主题、SVG下载、历史恢复与四种桌面尺寸/390px和320px可读步骤。默认测试本机dist；ARCHITECTURE_ORIGIN可只读核对远端静态页面，ARCHITECTURE_OUTPUT指定证据目录，不调用模型或工具。

2026-10-03：新增 [panorama-browser-smoke.mjs](panorama-browser-smoke.mjs)，通过临时数据库、真实 SDK、本地模型/MCP 验证引导入口、实时/持久全景、待审批/复核拦截/错误、键盘/320px 与 JSON。运行 npm run test:panorama:browser，结果在 test-results/panorama。

[panorama-real-acceptance.mjs](panorama-real-acceptance.mjs) 是显式真实验收入口，按 knowledge/dts/all 阶段在临时工作空间使用已保存模型和已授权 DTS 只读 MCP，验证引导包发布与实际模型/工具图谱；配置只读，结果/失败/截图保存在按时间隔离的 test-results/panorama-real-*。此命令会请求真实模型（产生用量），DTS 阶段还会查询真实授权任务；不等于生产放行或完整质量评测。

[documents-browser-smoke.mjs](documents-browser-smoke.mjs) 对当前 dist 启动临时应用/文档/数据库，验证菜单、目录搜索、相对链接、管理员编辑/冲突/回退/草稿保护/下载、成员只读和320px；固定构建夹具不调用模型或工具。实际官网构建与坏链接回退在 tests/documents.test.mjs 的临时完整源码副本核对。运行 npm run test:documents:browser，产物在 test-results/document-center。

2026-10-09：reasoning-effort-browser-smoke.mjs（npm run test:reasoning:browser）在临时数据库/真实 SDK/本地 Responses SSE fixture 验证设置持久化、三档/默认菜单、请求映射、分析与复核、生成禁用、历史/刷新和320px/键盘。

2026-10-10：delegation-browser-smoke.mjs用隔离UI图谱夹具检查委派开关、父子分组/失败/键盘/刷新/JSON/320px/旧图；delegation-runtime-browser-smoke.mjs用临时数据库、真实AgentScope SDK和本地SSE/MCP跑浏览器发送到子工具再持久回读的完整链路，无保存模型或实际DTS。
