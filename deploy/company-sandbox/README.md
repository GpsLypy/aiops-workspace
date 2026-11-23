# 公司沙箱隔离 PoC 部署包

新手从头操作请阅读[公司沙箱从零部署教程](../../docs/company-sandbox-tutorial.md)：先创建新测试实例，再按本机与沙箱两类步骤完成上传、安装、启动、登录、验证和恢复。下文是部署脚本及可选路线的参考；本次实测结果见[公司沙箱说明](../../docs/company-sandbox.md)。

本目录验证应用在公司平台的基础运行能力：Node 22.16+、Python 3.12、AgentScope 2.0.8 / `uv.lock`、前端、登录、真实 SDK 流式对话与 SQLite 重启持久化。默认受控模型，也可通过显式私有配置启用用户授权的保存模型；不迁移 MCP，不查询 DTS。

2026-10-09新增显式 `POC_DTS_CONFIG_FILE` 模式，连接另一个独立沙箱的DTS只读MCP。默认隔离行为和源码包仍不包含DTS集成；该模式需单独部署受限SSH通道、额外集成源码/预打包Skill，只允许四个私有DTS资源及单一MCP发现/调用，任务/通知继续关闭。配置、数据库/失败记录校验及真实结果见[DTS独立沙箱](../../docs/dts-sandbox.md)，不能继续对该模式运行默认 `probe.mjs` 并宣称“集成为空”。

## 隔离边界

- 只在新建测试实例运行，UID 1000，`NODE_ENV=development`，HTTP 只用于本阶段的内网隔离测试。
- 数据固定 `/workspace/aiops-data`。首次必须为空，之后必须带本 PoC 标记；不导入 `.data`、数据库、主密钥或生产账号。
- 新测试账号/初始化令牌只保存在 `poc-access.json`，权限 0600；不进入报告、镜像与源码包。主密钥由项目在该全新目录生成，仅用于本 PoC。
- 默认入口使用内置 loopback 受控模型；只允许该地址出网。显式真实模型模式只允许私有配置 `baseUrl` 的唯一 origin，HTTP/内网访问仅对该 origin 开放。管理员可在受限模型设置中修改默认问答强度、首字节和流中静默超时；模型连接字段、MCP、资源写入、任务、通知、Runbook 与本机部署状态探针仍被 PoC 限制。调度器与通知后台不启动。
- 容器不挂载宿主 Docker socket、主应用目录、生产卷或主应用端口。平台 `/workspace` 的持久化语义需实际重启/重建验证。

## 专用镜像

在项目根目录构建前端和当前 root Dockerfile 基础镜像，再派生 PoC：

```sh
npm run build
docker build -t aiagent-poc-20261008-base:latest .
docker build -f deploy/company-sandbox/Dockerfile --build-arg AIOPS_IMAGE=aiagent-poc-20261008-base:latest -t aiagent-poc-20261008-app:latest .
```

复用本地基础镜像必须先验证 Node 22、Python 3.12、SDK 2.0.8 及 `uv.lock` 摘要；本 PoC Dockerfile 会复制当前 `server/`、`dist/` 与 `worker.py`。公司平台如为 amd64，必须构建/推送 amd64 或多架构镜像；本地 arm64 成功不能证明 amd64 已验收。

平台要求：2 CPU、1 GiB 内存作为初始验证资源，工作区至少 10 GiB，端口 3001，`COMPANY_SANDBOX_POC=true`。持续资源、入口 HTTPS 和出口策略未在此模板中宣称通过。默认 root Dockerfile 的 runtime 内不带 npm/pip/uv，因此设置命令为 `node deploy/company-sandbox/start.mjs`。

## 通用模板与文件上传备选

```sh
node scripts/company-sandbox-package.mjs /absolute/new-path/aiagent-source.tar.gz
```

打包只允许构建和运行需要的源码族，输出新文件和 SHA256 清单，不覆盖已有文件。不读取 `.env`、`.data`、本机依赖、测试/内部验收报告、集成目录或完整历史文档。该过滤是路径白名单，不是通用源码秘密扫描；不要手工将凭据写入源码。

将源码包上传到全新实例后，把源码和依赖放在实例本地磁盘 `/home/sandbox/aiagent-poc`，运行时放在 `/home/sandbox/poc-runtime`；持久归档、测试数据库与私有模型仍放在 `/workspace`。本轮 `/workspace` 为 JuiceFS，小文件解压和依赖安装明显缓慢，因此不在该挂载点展开运行时。实例重建后 `/home` 是否保留不能假设，需要从工作区归档恢复再验收。

模板必须具有 Node 22.16+、Python 3.12 与 uv 0.11.26，并允许锁定依赖下载。仅有 Python 3.14 的模板不满足项目约束，脚本会明确失败，不降级为其他 SDK。全新测试实例可使用 `install-runtime.sh` 在 `/home/sandbox/poc-runtime` 中安装官方 Node22/Python3.12/uv，不替换系统运行时：

```sh
cd /home/sandbox/aiagent-poc
COMPANY_SANDBOX_POC=true sh deploy/company-sandbox/install-runtime.sh
. /home/sandbox/poc-runtime/env.sh
```

平台下载 Python 大文件受阻时，可使用固定官方 Python 3.12.13 Linux x86_64 归档的范围下载备选：

```sh
COMPANY_SANDBOX_POC=true python3 deploy/company-sandbox/download-python-ranges.py
POC_PYTHON_ARCHIVE=/home/sandbox/poc-runtime/downloads/cpython-linux-x64.tar.gz COMPANY_SANDBOX_POC=true sh deploy/company-sandbox/install-runtime.sh
```

下载器默认128KiB范围、8并发，核对最终响应 HTTP206、Content-Range 和实际字节数；断点文件记录范围和SHA256。失败范围会拆至更小范围（最小16KiB），再次执行只重取失败或校验不一致的部分。完整归档必须匹配固定官方SHA256 `10a452caac7041357805f0c19a60576df53f1ab06d1abfc9200f1f0157cb3bd1` 后才成为最终输出，安装器的 `POC_PYTHON_ARCHIVE` 分支再次强制同一SHA核对。脚本不执行安装或操作正在运行的进程。安装器可重复验证已有指定版本的Node/uv/Python和完全相同的私有链接；新归档先在专用临时目录解压、核对后移动到尚不存在的目标。不覆盖已有不同链接、环境脚本或不完整安装目录，不清理其他目录；这些异常需先检查再显式处理。

```sh
cd /home/sandbox/aiagent-poc
COMPANY_SANDBOX_POC=true sh deploy/company-sandbox/bootstrap-source.sh
```

bootstrap 采用 `npm ci`、前端构建、`uv sync --frozen`、真实 Worker 探针后启动独立入口。`AGENTSCOPE_PYTHON` 指向上传目录内部的 Python 3.12 venv；不操作现有生产服务。

已完成依赖安装后，`run-poc.sh` 从固定 `/home` 目录启动应用，使用 `/workspace/poc-private/model.json` 的授权模型配置，在 `/workspace/poc-logs/poc.pid` 记录本PoC PID；已有活跃PID时拒绝重复启动，不结束其他服务。

## 冻结 wheel 离线安装备选

当 `uv sync --frozen` 的大文件下载持续停滞，可先准备完全离线的 wheel 计划；本备选保留 `uv.lock`，不调整依赖版本，不修改正常 bootstrap。准备脚本使用 uv 0.11.26 的 `export --offline --frozen --no-dev --no-emit-project` 导出全部版本和哈希，再按 CPython3.12/Linux x86_64 的 marker 和 wheel tag 选择锁文件内的官方 PyPI 文件。

```sh
python3 deploy/company-sandbox/prepare-wheels.py --project agent-worker --glibc 2.35 --out-directory /workspace/poc-wheel-plan
```

该命令不下载。当前锁文件对已确认 glibc2.35 的目标选出90个wheel，总49,864,970字节；NumPy/grpcio/cryptography是主要大文件。计划保留源码锁文件和冻结requirements摘要，每个wheel固定官方URL、字节数和SHA256。已有展开目录不能伪造为wheel或改写metadata；只有完整文件匹配发布哈希才能复用。

```sh
python3 deploy/company-sandbox/download-wheels.py --manifest /workspace/poc-wheel-plan/wheel-plan.json --wheel-directory /home/sandbox/poc-runtime/wheels
```

下载器默认只检查缺失列表；显式添加 `--execute` 且满足PoC UID/环境才会下载。它逐artifact复用小范围续传逻辑，下载只接受当前 `uv.lock` 内的官方 `files.pythonhosted.org` 文件，整wheel通过SHA后才提交。

依赖全部可用后，可显式启用独立安装备选：

```sh
COMPANY_SANDBOX_POC=true POC_OFFLINE_INSTALL=true POC_WHEEL_PLAN_DIRECTORY=/workspace/poc-wheel-plan POC_WHEEL_DIRECTORY=/home/sandbox/poc-runtime/wheels sh deploy/company-sandbox/install-worker-offline.sh
```

安装器先核对所有wheel及requirements摘要，再新建 `/home/sandbox/aiagent-poc/agent-worker/.venv-offline`，执行 `uv pip install --offline --require-hashes --no-index --no-build --find-links ... --strict`、`uv pip check` 与真实SDK合成探针。它不覆盖仍在安装的 `.venv`，已有 `.venv-offline` 时拒绝修改。该备选尚须实际下载/安装验收；准备清单和离线模拟不代表云Worker已完成。启用它运行应用时需显式把 `AGENTSCOPE_PYTHON` 指向新虚拟环境，原 `run-poc.sh` 的默认路径保持不变。

## 容器或平台内验收

用户已授权使用本地保存模型时，由操作者只读导出到隔离实例的私有普通文件（0600，最多64KiB），字段固定为：

```json
{"schemaVersion":1,"baseUrl":"https://MODEL-ENDPOINT/v1","apiType":"responses","model":"MODEL-NAME","apiKey":"PRIVATE-KEY"}
```

`apiType` 固定为 `responses`，`schemaVersion` 可省略。只读导出保存模型可运行 `SOURCE_DIR=.data node scripts/company-sandbox-export-model.mjs --out /absolute/new-private/model.json`；导出只含 `baseUrl/apiType/model/apiKey`，不导出账号、MCP、任务、通知或其他设置，拒绝写入源数据目录、符号链接密钥及覆盖已有输出，核对原配置和密钥摘要未变。该命令不调用模型，不导入业务 store，也不改变原服务。

不要把此文件放入 `server/`、`src/` 或部署源码目录，不要在报告中记录它的内容。启动设置 `POC_REAL_MODEL_CONFIG_FILE=/workspace/poc-private/model.json` 即开启真实模型模式；文件直接进入当前进程环境，不保存到 SQLite，也不进入源码包。没有该变量始终使用受控模型。真实模型可能产生供应商用量；失败按失败记录。bootstrap 也透传此变量。PoC 输出上限默认 512，可通过 `POC_MODEL_MAX_TOKENS` 或 `MODEL_MAX_TOKENS` 显式调整到 1–32768；只影响本 PoC，不改保存配置。

在应用容器/实例内部执行（不要向外暴露测试凭据）：

```sh
node deploy/company-sandbox/probe.mjs
```

重启同一个 PoC 后：

```sh
node deploy/company-sandbox/probe.mjs --recheck
```

探针验证首页、readiness、新账号初始化/登录、当前模式的流式帧、持久会话、独立 Worker 的真实 SDK 模型/工具合成往返及禁止集成 API。真实模型模式报告 `realModelUsed=true`，默认为 false；即使真实聊天通过，独立 Worker 健康探针仍是合成模型/工具。流式 probe 核对增量帧及顺序；浏览器的首段提前到达另行实测。`--recheck` 必须读回重启前持久的 assistant 消息。可设置 `POC_REPORT_FILE` 为实例内一个新路径，报告不含账号密码、Cookie、主密钥或模型请求正文。稳定 HTTPS 入口、工作区重建恢复、平台暂停/回收语义仍属于后续验收。

启动与探针使用相同的只读数据库校验：资源、任务、通知渠道、通知事件、通知投递与 Runbook 必须为空，也禁止保存模型设置。无工具 AgentScope 聊天失败可以留下 `notifications` 内部执行记录，仅接受 `failed/cancelled/unknown/awaiting_approval`、恰好含 `runId/userId` 的 payload、匹配执行 owner/runtime/status、零工具步骤及 `pending/attempts=0`，不会删除错误记录或发送通知。报告以 `isolatedIntegrationTaskNotificationState` 表示隔离状态，`internalFailureRecords` 计数这些内部记录。HTTP 200 的 NDJSON 若带 `error`，探针先报告聊天失败，再检查完成帧；失败后可保留现场重启并重试。


## 独立 DTS 模式

默认PoC仍禁止MCP；已部署DTS模式使用 `COMPANY_SANDBOX_POC=true sh deploy/company-sandbox/run-dts-poc.sh`，它先校验私有DTS配置及SSH通道健康，再启动既有入口。输出上限默认4096，POC_MODEL_TEMPERATURE默认none；所有模型调用只使用Responses SSE，stream:true固定，JSON响应拒绝，没有完整响应回退或流式开关。供应商终态仍须真实验收。原模型JSON不改写。SSH监督器先启动，四个私有资源和只读目标约束见 [独立DTS部署](../../docs/dts-sandbox.md)。原无集成probe不适用于DTS模式。

## 文档中心同步部署

2026-10-09 助手实例已补齐 [文档中心](../../docs/document-center.md)，入口为 [沙箱文档中心](http://192.0.2.10:3001/#documents)。默认精简源码包仍不包含全部用户文档及官网材料，单独运行原打包命令不能复制这次完整目录。更新时须包含 `server/documents.mjs`、注册该模块的 `server/app.mjs`、当前 `dist/`、项目 README 和 docs/deploy/integrations 用户 Markdown、固定官网构建脚本、docs/web、架构 JSON、品牌 SVG 与本地链接目标。排除凭据、数据库和私有测试产物。

本次补丁及逐文件 SHA 清单位于助手 `/workspace/poc-logs/document-center-app-20261009.tar.gz`，旧文件与基线在 `/workspace/poc-logs/before-document-center-20261009/`。部署前核对现有源码摘要、无活跃执行和 PID 身份，先在暂存目录检查文档，再优雅重启原应用。沙箱执行 `node scripts/build-docs.mjs` / `node scripts/build-docs.mjs --check` 后，登录核对全部目录、最新 SSE 说明与管理员保存。收尾通过文档 API 同步部署记录并重建网站，详见 [验证记录](../../docs/verification.md)。重新打包前先收回沙箱中的文档修改；平台重建后的自动恢复尚未验收。

2026-10-10 最近对话及设置补丁已发布：前端更新清单必须同时包含使用组件与对应CSS（本次补齐 `src/chat-design.css`），设置需同步 `src/components/ui.tsx`、`src/components/Settings.tsx` 和 `src/settings.css`；冻结远端构建结果后用本地夹具复验，再核对实际HTTP资源摘要，避免源码按钮已更新但样式遗漏。前端/文档补丁可在入口最后原子替换，保留旧资源用于已打开页面，不必重启PoC。实际发布结果及锁屏复验边界见[验证记录](../../docs/verification.md)。

2026-10-15 架构图发布须包含 `server/diagram-assets.mjs` 与 app 静态服务装配、Vite 配置、文档入口和图形规格/HTML。`npm run build` 会生成双视图入口和两份固定图形资源；这些文件与dist一起发布。仅两份固定图形允许同源内嵌，脚本按内容SHA256放行，其他应用路径保留DENY。该批次需受控重启，不属于免重启的纯前端补丁。图形动效为源码流程演示，调度器等通用能力不表示PoC启用了相应后台。
