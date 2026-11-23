# 在公司沙箱运行项目：基础验证完成

> 开源说明：本篇部署地址、内部平台域名及实例标识已替换为示例；历史实验记录不是本版本的验收结果。请使用你有权访问的平台，并参阅[本次验证记录](verification.md)。

## 架构图可视化（2026-10-15）

已在[助手架构图](http://192.0.2.10:3001/architecture.html)发布系统架构与请求流程双视图，文档中心首页及阅读页通过「架构图」新标签页打开。静态图按源码分区，支持搜索、缩放、主题、流向演示和导出；不使用真实会话或运行数据。本次36文件摘要一致，PID10847→11806、ready和DTS健康，业务数据/私有配置及222个非发布文件保持；线上真实HTTP图形浏览器4组检查通过。安全响应头随受控重启生效；备份、发布及验证结果见[验证记录](verification.md)。

第一次部署请先跟着[公司沙箱从零部署教程](company-sandbox-tutorial.md)操作。本文保留本次实施细节、实测证据和未完成的验收边界。

本轮已在公司 Agent 沙箱平台启动全新的测试工作空间，完成真实 AgentScope Worker、首页/API登录、受控模型流式与持久化、SQLite隔离状态和同Pod运行归档恢复。**应用基础运行可行；2026-10-09 修复 HTTP 请求标识后，一次真实模型浏览器普通聊天已完成。**2026-10-08 的三次完整真实对话均超时，最后一次整轮91.260秒，最小直接模型请求曾成功；这些历史失败保留，不能由单次成功推定链路稳定或超时根因已解决。平台实例重建仍待验收。

2026-10-09 用户在 HTTP 沙箱浏览器发送真实模型问题时，出现 `crypto.randomUUID is not a function`。已定位为浏览器发送前生成请求标识的兼容问题：普通 HTTP 内网 IP 不提供 `crypto.randomUUID()`，旧前端因此未能发出聊天请求。当前源码已统一安全随机 UUID v4 入口，优先 `randomUUID`，缺失时使用 `getRandomValues`，无安全随机源则中文报错并停止请求；聊天、固定工具与 Runbook 均复用。仅升级独立测试沙箱前端并强制刷新后，原生 Chrome 中保存模型 `gpt-6-luna` 一次无工具问答成功，页面显示4节点、0工具、已完成8.3秒，无UUID报错；刷新后重新打开原会话，答复与全景仍在，只读SQLite证据同时核对成功执行、匹配消息各1、UUID v4、零工具和fixtureCalls0。专项回归、部署校验及现场证据见[验证记录](verification.md)，刷新与排错步骤见[新手教程](company-sandbox-tutorial.md#点击发送立即报-cryptorandomuuid-is-not-a-function)。真实模型首段增量时点没有测量；该次普通聊天不包含DTS/MCP、真实业务质量或稳定性验收。

用户明确要求不动生产，并随后授权使用本地保存的模型、跳过 MCP。部署使用本轮新实例、新目录和新账号；只读导出获准的单个模型配置供新实例使用，不修改原工作空间、不迁移数据库或主密钥，也不继承 DTS、任务或通知配置。

2026-10-09 后续界面更新已部署至同一测试实例：原创“百”字标志用于标签、登录和聊天界面，输入区聚焦仅保留一条细边框。16文件补丁逐项SHA核对、旧文件备份与入口原子替换完成，PID1575未变、ready=true。原生Chrome直接访问真实沙箱，验证登录、1440px/320px图标与输入区、键盘聚焦及刷新后既有6个会话ID一致，无页面错误；本次没有发起模型聊天。server/Worker、请求标识修复、原模型配置和主密钥摘要保持一致，数据库在补丁应用期间也未改变。详细报告与恢复材料位置见[验证记录](verification.md#公司沙箱更新原创标志与单层输入框2026-10-09)。旧运行归档仍保留为历史版本，未自动包含本次补丁。

真实模型通过独立私有配置显式启用，未提供时以 loopback 受控模型做备用工程验证。内置模型输出不是业务状态或真实模型质量证据；MCP / DTS 按用户要求排除本轮验收。当前结果与未完成项目统一记录在[验证记录](verification.md)，实施规范见[本轮 OpenSpec](../openspec/changes/company-sandbox-poc-20261008/proposal.md)。

当前 Agent 入口已按最新截图反馈改为有框按钮与用途说明菜单，替代此前无框文字；即使只有通用项，也可查看用途，已有会话保持锁定。桌面/320px与键盘专项通过。部署与原会话保护结果见[最新入口验证](verification.md#agent-有框入口与用途菜单2026-10-09)。

## 设置弹窗与最近对话布局修复（2026-10-10）

已在同一[助手沙箱](http://192.0.2.10:3001/#chat)发布设置弹窗固定高度、读取提示、内容独立滚动及Codex参考的会话单行布局；补齐前次清理发布遗漏的聊天CSS。单条删除、本人已加载会话清理及超时配置继续可用。19文件逐项核对，前端静态资源直接替换，PID10847保持，业务数据及私有配置摘要一致。沙箱构建、冻结候选浏览器与实际HTTP资源核对通过；本轮原生Chrome登录态点击复验受锁屏限制，未执行真实删除或模型/DTS调用。详见[验证记录](verification.md)。

## 查询目标与文档中心界面更新（2026-10-10）

本次更新范围为助手前端与配套文档：查询目标表单增加内边距、清楚的展开状态与轻量错误反馈；文档中心以搜索、分类入口与摘要卡片作为首页，阅读页提供精简分类目录、宽屏章节导航与移动目录开关。管理员维护、草稿保护和只读目标核对规则沿用现有流程。部署入口为[助手文档中心](http://192.0.2.10:3001/#documents)，发布结果与备份位置见[验证记录](verification.md)。

两轮更新已发布：24个文件与冻结候选逐项SHA一致，云端专项23/23、候选文档中心12组和目标表单回归、真实HTTP Chrome5组通过。PID5298保持、ready=true；241个受保护文件和本轮基线19会话/52消息/27执行/4资源/5工具步骤/4设置摘要不变，旧assets保留，入口最后原子替换。在线备份 `/workspace/poc-logs/before-ui-docs-20261010-v1`，材料在 `test-results/ui-docs-sandbox-20261010/`。本次未请求真实模型或DTS，不重启后台或操作独立DTS实例与生产。刷新原页面即可加载新版。

## 当前聊天界面发布（2026-10-10）

已按用户要求将 Codex 风格的聊天侧栏、精简标题、用户气泡/助手正文与统一输入区发布到 [助手沙箱](http://192.0.2.10:3001/#chat)，沿用运维百晓生品牌。支持会话查找、返回最新、知识/独立复核键盘开关、Agent与快速/均衡/深度选择；已有历史与查询目标/执行/审批行为保留。原页面刷新即可加载新资源。

本次为前端及文档发布，保留沙箱专用设置限制；云端专项69/69、候选聊天/流式/全景浏览器6/7/10组通过，29个发布文件与候选摘要一致。实际HTTP桌面/320px/短横屏、历史、菜单、焦点、文档与导航5组通过，无页面异常/外部请求，不发送聊天。后台PID5298和ready保持；110个受保护文件及18会话/50消息/26执行/4资源/5工具步骤/4设置摘要不变，在线备份 `/workspace/poc-logs/before-chat-design-20261010`，旧assets保留、HTML入口最后原子替换。详细证据与验收边界见[验证记录](verification.md)。

本次没有调用真实模型或DTS，不操作生产或独立DTS实例。既有模型/DTS链路历史结果与平台重建限制继续分别记录，界面部署不代表这些验收完成。

## 最近对话清理和流式超时同步发布（2026-10-10）

现有[助手聊天沙箱](http://192.0.2.10:3001/#chat)已同时开放最近对话单条删除、批量清理确认和管理员流式超时配置。批量清理仅针对已加载的本人会话，最多 300 条，不受搜索筛选影响；执行中的会话保留，删除确认后不可恢复。首字节默认 90 秒、可设 1–120 秒；流中静默默认 180 秒、可设 0 或 60–600 秒。模型连接字段继续锁定，整轮默认上限仍是 420 秒。

发布前候选在云端专项 31/31、构建及离线文档检查通过；29 个文件按 SHA256 发布，备份在 `/workspace/poc-logs/before-session-timeouts-20261010-v1`。PoC PID 10093→10847，`ready:true`，原业务数据及模型/DTS 私有配置摘要不变，DTS 健康。已登录 Chrome 刷新后实际查看批量/单条删除确认并取消、查看管理员 90/180 秒输入框和模型字段锁定；只读检查仍有 20 会话、54 消息、28 执行，SQLite `quick_check=ok`。初始化测试密码已失效，独立自动化登录未通过，未重置账号；本轮未在真实会话上执行删除或保存设置，也未发起模型请求和 DTS 查询。完整发布及未验收边界见[验证记录](verification.md#最近对话清理与超时配置同步发布到助手沙箱2026-10-10)。

## 平台与项目怎样对应

2026-10-09后续已按用户要求单独创建DTS MCP沙箱，并通过额外私有配置为原助手实例启用限定DTS只读接入。本文下方“无资源/MCP拒绝”仍指默认PoC及历史验收，当前显式DTS模式的配置与证据见[DTS独立沙箱](dts-sandbox.md)和[验证记录](verification.md)。该模式保留原模型、主密钥与会话，不开启任务或外部通知。

公司控制台的业务接入说明提供自定义镜像、CPU/内存、持久工作区、永不过期实例、命令执行和 Preview。参考[平台接入指南](http://sandbox.example.com/control/docs/coding-platform-integration)；这些能力说明不等于本项目已在该平台通过验收。

| 运行项 | 本项目要求 | 本轮处理 |
| --- | --- | --- |
| Node / Python | PoC 固定 Node 22 系列（至少 22.16）、Python 3.12、AgentScope 2.0.8 和锁定依赖 | 专用镜像或专用 bootstrap 环境；平台通用 Node 24 / Python 3.14 不能直接通过该 PoC 的版本检查 |
| 应用与入口 | React 构建结果由同一 Express 进程提供，端口 3001 | 使用专用启动入口，页面和 `/api` 保持同源 |
| 数据保存 | SQLite 数据与对应主密钥，单实例 | 新目录固定 `/workspace/aiops-data`，首次必须为空，后续需本 PoC 标记 |
| 运行账号 | 非 root | UID/GID 1000，实测挂载目录的 owner 与写权限 |
| 资源 | 参考现有Compose的2 CPU/1 GiB作为建议起点 | 本轮实际新实例2 CPU/2 GiB、默认10 GiB工作区；尚未证明最低规格 |
| HTTP Preview | 现有文档为内网 Pod IP，地址可能改变 | 独立 `NODE_ENV=development` PoC；正式 HTTPS、Secure Cookie 与外置 Secret 保持另行验收 |
| 持续运行 | 调度器在主进程中 | 本 PoC 不启动调度器和通知后台；永不过期、暂停和重建语义需要平台实测 |

项目的 Python stdio 是 Node 在应用内部建立的子进程管道，与平台远程 exec 的 stdin 是两条不同路径。平台 exec 不支持 stdin 并不能直接说明 Worker 不可用；需要运行真实 Worker 探针来确认。

## 本轮独立入口限制

[启动入口](../deploy/company-sandbox/start.mjs)要求 `COMPANY_SANDBOX_POC=true`、开发模式、固定测试目录、UID 1000 与锁定 Worker 版本。首次目录必须为空；再次启动核对本轮标记，资源、已保存模型设置、任务、通知渠道/事件/投递及Runbook必须为空。

测试账号、随机密码与 setup token 仅保存在新目录的 `poc-access.json`，权限为 0600。初始化和探针直接在实例内部使用这些值，不将它们写入源码包、镜像或验收报告。开发模式主密钥由项目在全新目录生成，仅适用于本轮测试数据；正式部署仍需外置 Secret。

入口覆盖原有模型与出口环境变量。默认只允许同实例 loopback 受控模型；显式提供私有配置时，仅允许获准模型的单一 origin。PoC 网关仍拒绝页面/API 修改模型、MCP、资源写入、任务、通知、Runbook 和本机部署探针；调度器及通知后台不启动。模型配置只在新实例进程内读取，不写入 SQLite，也不携带 MCP 或其他集成配置。

无工具聊天失败仍可产生项目内部`notifications`执行记录，属于诊断数据而非通知送达。首次真实模型超时后，旧PoC把这类内部记录误当外部通知数据并拒绝重启；现已在PoC层共用[只读状态校验](../deploy/company-sandbox/validate-store.mjs)，保留失败记录，只允许`failed/cancelled/unknown/awaiting_approval`、payload恰含`runId/userId`、匹配实际执行owner/AgentScope runtime/status、零工具步骤且`pending/attempts=0`的内部记录。通知渠道、事件、投递仍必须为0；修复不修改产品server，也不删除或手动改写测试数据库，正常聊天仍持久写入。报告`internalFailureRecords`计数内部记录，`notificationsSent=0`表示未发送；`isolatedIntegrationTaskNotificationState`表示严格隔离状态，不再宣称所有notification记录为空。

实际产品的生产校验没有放宽：`NODE_ENV=production` 仍要求 HTTPS `APP_ORIGIN`、`COOKIE_SECURE=true`、外置 `MASTER_KEY_FILE`、明确 `AUTH_MODE` 和出口允许列表。HTTP 测试入口不能作为生产部署完成的结论。

## 准备部署材料

材料位于 [deploy/company-sandbox](../deploy/company-sandbox/README.md)。优先使用现有[根 Dockerfile](../Dockerfile)构建锁定运行时，再派生本轮 PoC 镜像：

```sh
npm run build
docker build -t aiagent-poc-20261008-base:latest .
docker build -f deploy/company-sandbox/Dockerfile \
  --build-arg AIOPS_IMAGE=aiagent-poc-20261008-base:latest \
  -t aiagent-poc-20261008-app:latest .
```

PoC Dockerfile 会核对基础镜像的 Node / Python / SDK 与 `uv.lock` 摘要，再复制当前 `server/`、`dist/` 和 Worker，并补入 `scripts/model-billing.mjs`：当前 `server/local-services.mjs` 静态依赖该文件，根 Dockerfile 只复制 `scripts/ops.mjs` 和 Worker 检查脚本，缺少这一新依赖。本轮在专用 PoC 镜像和源码包补齐，不改根镜像或已有部署。

根镜像最终运行时没有 npm/pip/uv，启动使用 Node；平台若覆盖 entrypoint，应保留 tini 和正确工作目录。平台要求 amd64 时需构建 amd64 或多架构版本，本机 arm64 验证不替代该项。

源码上传方式用于镜像通道不可用但可以上传文件的全新测试实例：

```sh
node scripts/company-sandbox-package.mjs /absolute/new-path/aiagent-source.tar.gz
```

[打包脚本](../scripts/company-sandbox-package.mjs)只收集明确列出的根构建文件、`server` 的 mjs、`src` 的 ts/tsx/css、三个 Worker 源文件、必要检查/运维脚本与 PoC 目录，创建新归档及 SHA256 清单。排除 `.env`、`.data`、本机依赖、集成配置、测试和内部报告，不覆盖已有输出。该规则是路径白名单，不是通用源码秘密扫描；源码本身应遵循不写入凭据的项目约定。

上传包需解压到本轮测试应用目录。bootstrap 要求可用的 Node 22.16+（22 系列）、Python 3.12 和 uv 0.11.26，以及锁定依赖下载能力。公司新实例目前实际为 Linux x86_64、UID 1000、Node 24 / Python 3.14，`/workspace`挂载为 JuiceFS。首次将Node归档直接解压到JuiceFS时，小文件解压约5分钟仍未完成，已只结束本轮安装shell并将[私有运行时安装脚本](../deploy/company-sandbox/install-runtime.sh)改为实例本地磁盘 `/home/sandbox/poc-runtime`，不替换系统 Node/Python；源码归档、测试数据库和私有模型文件继续保存在 `/workspace`：

```sh
cd /home/sandbox/aiagent-poc
COMPANY_SANDBOX_POC=true sh deploy/company-sandbox/install-runtime.sh
. /home/sandbox/poc-runtime/env.sh
```

脚本下载官方 Node 22.23.1 linux-x64 包并按同版本官方 SHA256 清单核对，以系统 Python 的 pip `--target`安装 uv 0.11.26，再由 uv 在独立目录安装 Python 3.12。`env.sh`只改变当前进程 PATH 与 Python 安装目录，不改平台模板或生产服务。安装及后续依赖下载需网络可用；最终以目标实例实际版本输出、Worker 与应用探针为准。JuiceFS 文件系统名称本身不能证明 SQLite WAL/锁兼容。

平台初次uv下载Python大文件停滞，新增[固定范围下载器](../deploy/company-sandbox/download-python-ranges.py)作为备选：

```sh
COMPANY_SANDBOX_POC=true python3 deploy/company-sandbox/download-python-ranges.py
POC_PYTHON_ARCHIVE=/home/sandbox/poc-runtime/downloads/cpython-linux-x64.tar.gz \
  COMPANY_SANDBOX_POC=true sh deploy/company-sandbox/install-runtime.sh
```

下载器固定官方Python3.12.13 Linux x86_64归档、34,159,178字节与SHA256 `10a452caac7041357805f0c19a60576df53f1ab06d1abfc9200f1f0157cb3bd1`；默认128KiB范围/8并发，检查HTTP206、Content-Range、长度和范围摘要，失败范围拆至最小16KiB，最终全量SHA一致才提交文件。安装器再次核对固定SHA并使用专用临时目录解压。已存在正确版本/相同链接可复验，不覆盖不同链接、环境脚本或不完整安装目录。本轮目标实例已实际通过Node22.23.1、Python3.12.13、uv0.11.26版本及官方Python SHA，随后完成真实SDK2.0.8 prefork探针；这些环境证据与真实模型聊天结果分别记录。

应用构建/运行目录使用本地磁盘 `/home/sandbox/aiagent-poc`，避免把依赖小文件直接安装在JuiceFS。运行时与应用依赖已压缩为持久区 `/workspace/poc-runtime-ready-v2-20261008.tar.gz`（191,910,654字节、SHA`d498e8ff4e5ec16f860ed1c1e444062f38cc1a63f6ee577696d4e6b2614b9fee`）。本轮先将原本地目录重命名保留，再从归档真实解压到相同路径，`--recheck`核对旧会话回读、新受控流式、Worker和SQLite完整性通过。这是同一个Pod内的目录归档恢复，未执行平台Pod重建，不能据此确认平台重建后的卷保留或本地磁盘恢复。

加载新实例私有运行时之后启动：

```sh
cd /home/sandbox/aiagent-poc
COMPANY_SANDBOX_POC=true sh deploy/company-sandbox/bootstrap-source.sh
```

[bootstrap](../deploy/company-sandbox/bootstrap-source.sh)执行 `npm ci`、前端构建、`uv sync --frozen` 和真实 Worker 检查，随后启动独立入口。Python 3.14、Node 24、错误 UID 或已有 `.env` / `.data` 会明确失败；不会退回其他 SDK 或读取现有工作空间。

已完成锁定依赖安装时，可使用[固定启动脚本](../deploy/company-sandbox/run-poc.sh)加载实例本地运行时、固定应用目录和授权私有模型路径；PID写入 `/workspace/poc-logs/poc.pid`，发现原PID仍活跃则拒绝重复启动，不结束其他服务。该脚本存在不表示本轮应用已启动。

源码包还提供离线wheel备选：`prepare-wheels.py`保留全平台冻结requirements，按目标CPython3.12/Linux/glibc2.35选择锁文件内90个官方PyPI wheel（49,864,970字节）；`download-wheels.py`默认只输出计划，显式执行才下载；`install-worker-offline.sh`仅创建新的`.venv-offline`，先验证全部固定hash，再`--offline --require-hashes --no-index --no-build --strict`安装、`pip check`和真实SDK探针。该备选本轮仅准备计划及离线测试，未在公司实例安装，不改正在使用的`.venv`或正常bootstrap。具体命令见[部署包说明](../deploy/company-sandbox/README.md)。

## 在新实例上验收

先创建全新测试实例，使用专用镜像或满足 bootstrap 条件的模板，设置新持久工作区和端口 3001。检查平台分配的 UID、cwd、`/tmp`、`/workspace` 写权限与资源配置；只在这一个实例运行本轮应用。平台 bootstrap、镜像拉取/启动和 PVC 权限属于实际部署前提，不能从模板名称推断成功。

在应用实例内部运行探针：

```sh
node deploy/company-sandbox/probe.mjs
```

[探针](../deploy/company-sandbox/probe.mjs)使用本轮私有测试账号完成初始 setup 与登录，核对首页、readiness、模型聊天的 NDJSON 增量和终态、持久回读、SQLite WAL / `integrity_check`、真实 SDK 的合成模型/工具往返、集成 API 拒绝及严格隔离状态。`realModelUsed`区分真实模型与备用fixture，`internalFailureRecords`与`notificationsSent`分别表示内部记录和实际发送。NDJSON即使HTTP200，出现`error`也先报告聊天失败，不能仅以状态码或已开始流判断成功；聊天后重新验证数据库隔离状态。可通过 `POC_REPORT_FILE` 指定实例内的新报告文件，报告不包含账号、密码、Cookie、模型密钥/endpoint 或主密钥。

然后获取端口 3001 的最新 Preview 并在浏览器直接打开。实际核对首页、登录、首段文字提前出现、完成后会话一致和刷新回读。HTTP Pod IP 必须从用户电脑真实可达，`APP_ORIGIN` 若设置则精确等于最新浏览器 Origin，不含路径。项目 `X-Frame-Options: DENY`，该步骤使用浏览器页面直接访问。

探针逐次读取响应体，`incrementalBeforeCompletion`记录首个正文增量与 done 是否在不同读取批次；fixture 要求该值为 true，真实模型若同批到达则记录 false，不误报提前呈现。实例内探针不能单独证明浏览器入口代理未缓冲；浏览器仍需实际观察首段早于终态。没有真实浏览器访问成功时，报告不能标记浏览器登录或增量呈现通过。

实际结束并重启同一测试应用后，在实例内执行：

```sh
node deploy/company-sandbox/probe.mjs --recheck
```

`--recheck`必须回读重启前的测试 assistant 消息，同时确认 `PRAGMA journal_mode=wal`、`integrity_check=ok`和严格集成隔离状态；符合规则的内部失败记录保留。平台挂载存储的 WAL 事务/锁语义还需实际核对，恢复需保留数据库对应的同一密钥。进程重启只证明进程级恢复；平台暂停/恢复和实例重建/PVC保留必须分开验证。Pod IP 改变时重新获取 Preview，不能继续使用失效地址。

## 使用本地保存模型与正式部署边界

用户已明确授权使用本地保存的模型。[只读导出脚本](../scripts/company-sandbox-export-model.mjs)只取得该单个模型的 `baseUrl`、`apiType`、`model`、`apiKey`，拒绝输出到源数据目录或覆盖已有文件，检查原模型配置和主密钥摘要前后一致，不调用模型：

```sh
SOURCE_DIR=.data node scripts/company-sandbox-export-model.mjs \
  --out /absolute/new-private/model.json
```

将这份私有文件用于本轮新实例，例如 `/workspace/poc-private/model.json`，不复制原数据库、主密钥、资源或其他集成。文件为普通文件，权限 0600、大小不超过 64 KiB，仅包含上述四个模型字段；允许附加 `schemaVersion: 1`，省略时同样视为当前版本。不放入源码包、镜像或公开报告。

启动时设置：

```sh
POC_REAL_MODEL_CONFIG_FILE=/workspace/poc-private/model.json
```

该变量让独立入口使用真实模型；仅传入常规 `MODEL_*` 不会启用。配置拒绝额外字段、未知协议和带用户信息/查询参数/fragment 的 URL，出口仅允许模型 `baseUrl` 的精确单一 origin；HTTP/内网例外也只对该 origin 生效。模型凭据仅进入测试进程，不写入 SQLite。PoC 默认输出上限 512，可用 `POC_MODEL_MAX_TOKENS`或 `MODEL_MAX_TOKENS`在 1–32768 内调整，不修改原模型配置。探针聊天请求等待上限为120秒；失败记录为失败，不能算连通成功。真实模型仍需实际核对网络、首段流式、最终结果和刷新持久回读，fixture 成功不能替代。

MCP / DTS 本轮明确跳过，不迁移连接器、不调用生产或测试 DTS，不产生工具业务验收结论。真实 SDK 探针中的模型/工具往返始终为本机合成协议检查，不能写成真实 MCP 接入成功。

正式部署还需稳定 HTTPS 入口、外置 Secret、代理超时/流式转发、精确出口规则、镜像发布与平台常驻/PVC生命周期验收。平台暂停期间巡检会停止；本 PoC 没有启用巡检或通知，因此不提供连续运行、通知送达或生产容量结论。

## 2026-10-08 基础验证状态

本节保留 2026-10-08 基础验证的完成结果与未通过项目。2026-10-09 已仅向独立测试沙箱更新请求标识修复的四个前端源码与 `dist`，九文件 SHA 核对、服务 PID 未变；旧源码包和运行归档均含修复前前端，需重新归档或恢复后从新源码重建 `dist`。后续详细命令、报告和失败阶段以[验证记录](verification.md)为准；受控模型、真实模型、浏览器与平台生命周期各自独立判断。

| 项目 | 当前状态 |
| --- | --- |
| 独立部署包与 OpenSpec | OpenSpec strict通过；最新PoC状态专项5项＋源码包2项为7/7，最终`npm test`273/273（21.028秒），0失败/跳过，修复后`npm run build`通过 |
| 本机专用镜像工程验收 | arm64 / Node 22.23.3 / UID 1000 / SDK 2.0.8 prefork：12项通过，包含真实 Worker、受控流式提前读取、持久回读、WAL、完整性及集成拒绝；`realModelUsed=false` |
| 本机重启和换容器恢复 | 2026-10-08 本机重启原容器、再用更新镜像新容器挂同一个专用测试卷，旧会话回读通过；不证明公司平台 PVC 或实例重建 |
| 公司平台新实例与最新上传包 | 新项目 `aiagent-poc-20261008`、新实例 `sbx-example`；SSH确认x86_64/UID1000/JuiceFS。PoC失败重启修复后96文件/286,720字节源码包已上传（SHA`0b81c579c79ad2b283af1e50c0b96310857e20c70f2a3a73e221b0f93d221529`），前序91文件包仅对应修复前版本 |
| 公司平台运行时与应用 | 本地盘Node22.23.1/Python3.12.13/uv0.11.26、官方PythonSHA、云端npm安装/前端构建通过；真实SDK2.0.8 prefork探针ready，真实模型模式应用已启动，`/readyz`200，首次新测试账号API登录通过 |
| 最终实例状态 | `http://192.0.2.10:3001/readyz`为`ready:true`；`/poc/status`为`realModel:true`、调度/通知后台false、fixtureCalls0。最后一次失败后内部记录3/实际通知0、严格隔离仍true；云端四校验/入口文件及96文件包SHA一致。readiness不表示真实对话已通过 |
| 公司受控模型工程验收 | 首次fixture探针11个基础检查true，restartPersistence未测；归档恢复后12/12通过，包含终态前增量读取、持久会话、真实SDK合成工具、WAL/完整性、集成拒绝及恢复回读。内部失败记录2，实际通知0；均`realModelUsed=false` |
| 公司JuiceFS合成存储探针 | 同一Pod/文件系统客户端8/8：两进程各40次提交/共80、读123次无部分事务、写锁拒绝、未提交不可见、仅探针自身SIGTERM回滚、新进程完整性、WAL checkpoint通过；使用系统Python3.14/SQLite3.37.2，不是应用数据库或跨Pod持久性验收 |
| 公司浏览器 | 用户Mac锁屏，待解锁后继续实际登录/流式/刷新；不以实例内HTTP探针替代 |
| 同Pod应用重启/运行归档恢复 | 原本地runtime/app目录重命名保留，从持久区v2归档还原相同路径，旧会话/新受控流式/账号/Worker/SQLite完整性通过；不等同平台Pod重建 |
| 平台暂停/重建及 PVC 保留 | 待验收 |
| 真实模型完整对话 | 三次完整应用聊天均超时；首次模型阶段90.009秒，最后一次整轮91.260秒（非模型精确耗时）、execution failed。最小safe-model诊断before_headers/request_timeout/90.083秒，加UA仍约90秒超时。最终内部失败记录3/实际通知0；真实应用模型链路未完成，网络/传输差异待定位，未确定组件归因 |
| 真实模型最小请求 | 直接请求模型第2次HTTP200/completed、9帧、22.455秒，未记录请求/响应正文；只证明这次最小Responses请求，不替代完整Agent/chat、浏览器或稳定性证据 |
| 固定IPv4最小HTTPS诊断 | 两个固定地址均TCP/TLS建立、请求写完、HTTP200，Content-Length存在且非chunked。index0在6.697秒到headers、9帧/completed、15.746秒结束；index1在13.478秒到headers、8帧但无终态，45.010秒AbortError。仅证明这两次最小请求一完成/一未终止，不确定根因，也不改变完整真实应用未通过的结论 |
| MCP / DTS | 按用户要求跳过，不读取/迁移/调用连接器 |
| 正式 HTTPS / Secret / 常驻 / 生产部署 | 本轮未验收，生产配置保持原样 |

## Chat恢复与停止更新（2026-10-10）

已将参考开源Codex的Chat修复发布至 [助手聊天](http://192.0.2.10:3001/#chat)：重试保留已打印正文、显示次数/原因/等待与耗时、可停止生成、受理回包丢失时按本人requestKey只读找回。仍为首次加五次重试、每次独立60秒、默认整轮420秒；不重放已完成工具。原会话、DTS资源和私有模型配置保持；发布备份 `/workspace/poc-logs/before-codex-chat-20261010-v2`，PID3461→4619，ready与独立DTS健康。

本次是现有沙箱源码上的限定发布，不包含本机问答强度菜单/配置。309项候选回归、云端专项/构建及真实HTTP界面/已发布前端受控故障验收通过；没有请求真实供应商或DTS业务工具，不将受控结果当作供应商稳定性/平台重建验收。详见[验证记录](verification.md#codex-聊天恢复更新部署到助手沙箱2026-10-10)。


## 问答强度沙箱补部署（2026-10-10）

本次补齐此前 Chat 发布遗漏的快速 / 均衡 / 深度菜单、默认配置、Responses `reasoning.effort`、执行冻结与历史档位。保留已部署的重试正文和只读恢复逻辑。公司 PoC 仅允许管理员保存默认强度，独立存为 `poc_model_reasoning_effort`；模型地址、名称、密钥与温度由部署配置管理，禁止修改，不将私有模型配置写入 SQLite。设置页相应锁定这些字段，连接测试仍由 PoC 网关禁止。

验证材料：`test-results/reasoning-sandbox-20261010/`。本机与独立发布候选 `npm test` 均 **312/312**；候选及云端 TypeScript/Vite 构建、官网构建/检查通过。候选补齐缺失的测试依赖材料后全量通过，补齐的独立沙箱/观测夹具仅用于验证，未纳入发布。云端串行专项 **69/69**，最终 SSE 定向复验 **10/10**。首次暂存构建发现 Chat 与状态组件版本不配套，补齐配套状态组件后构建通过，失败版本未上线。

助手 PoC `http://192.0.2.10:3001/#chat` 已发布 **41 个源码/构建文件**，PID **4619 → 5298**，ready=true；发布前无活跃执行，SQLite 在线备份及完整性检查通过。备份 `/workspace/poc-logs/before-reasoning-supplement-20261010-v2`。模型/DTS私有 JSON、master.key、锁文件、Worker及原会话/消息/资源/设置摘要核对通过；原 **18 会话、50 消息、26 执行、4 资源、5 工具步骤**保留，任务及外部通知/Runbook均0。旧前端 assets 保留，入口最后原子替换。

真实 HTTP Chrome **5组通过**、0页面异常：1440px/320px三档菜单、键盘/Escape/焦点、受限系统默认保存并刷新保持、当前聊天深度覆盖与恢复系统默认、非法档位400/其他模型配置403；恢复验收前默认值，原会话不变。本轮只新增不含密钥的默认强度 setting，不改原设置。

浏览器加载**沙箱已发布 HTML/assets**，接本机临时数据库与真实 AgentScope SDK / 受控 SSE 模型：问答强度 **6组通过、4次夹具请求**（low、high分析/独立复核、null不发reasoning、历史持久档位）；流式回归 **7组通过、15次夹具请求**（两次重试保留正文、只读恢复/受理丢失查找、不重复POST、停止/倒计时取消、320px）。两者0页面异常。生成状态和输入框停止键配套部署；此前本机界面记录的“未部署”仅指其当轮验收，本节为后续部署证据。

官网与文档中心按管理员 revision 保存并重建，最终结果见 `final-doc-sync.json`。受控模型参数验收不代表真实供应商支持各档位；本轮 **0次真实供应商请求、0次DTS工具查询**。部署仅面向助手 PoC，不更新独立 DTS 沙箱或生产，也不新增平台Pod生命周期或真实模型质量验收。
