# 设计与实施边界

## 独立测试部署

本次部署不迁移原有本机或生产工作空间。构建输入只取明确列出的源码、依赖锁和前端构建结果，排除 `.data`、`.env`、备份、私有报告、真实凭据和本机依赖目录。公司平台创建新的实例，分配新的持久工作区，使用全新管理员及凭据。测试状态只写入该实例的 `/workspace`。用户后续授权使用本地保存的单个模型，只读导出其最小配置至独立私有文件，不修改原库、不复制原数据库或主密钥。

第一轮保持单副本，可参考现有 Compose 的 2 CPU / 1 GiB 内存，并使用 10 GiB 持久工作区和平台永不过期选项；这些是起始配置，不是实测最低规格或常驻保证。不会沿用现有任务、通知渠道或生产资源。独立入口默认配置同实例 loopback 受控模型，真实模型须通过显式私有配置启用；用户已授权本地保存模型。MCP / DTS 按用户要求排除本轮，不开放接口或后台集成。

## 运行时与启动方式

现有 Dockerfile 构建前端，并在最终镜像提供 Node 22 与锁定 Python 3.12 / AgentScope 2.0.8、tini 和非 root UID/GID 1000。平台通用模板标注 Node 24 / Python 3.14；项目 Worker 严格要求 Python 3.12，本轮 PoC 同时固定 Node 22 系列（至少22.16），不能直接采用默认模板环境。优先复用项目专用镜像；镜像通道不可用时，可在独立工作区 bootstrap 同版本依赖进行 PoC，需单独记录与专用镜像的验证差异。

新实例实测为Linux x86_64、UID1000，默认Node24/Python3.14，持久工作区为JuiceFS。初次Node小文件解压到JuiceFS约5分钟仍未完成，已只终止本轮安装shell并改用本地盘。`install-runtime.sh`要求本轮PoC标志和UID1000，在实例本地 `/home/sandbox/poc-runtime`安装官方Node22.23.1 linux-x64并核对官方SHA256清单、通过pip `--target`安装uv0.11.26、通过uv或固定官方归档安装Python3.12；环境脚本只设置当前进程PATH和私有Python目录，不替换系统运行时。应用构建/运行在 `/home/sandbox/aiagent-poc`，源码归档、数据库和私有模型保持 `/workspace`。本地运行时与依赖已归档为持久区v2单文件，在保留原目录后同Pod真实解压恢复，通过12项受控探针；尚未执行平台Pod重建，不宣称所有运行文件自动持久化。公司Node22.23.1/Python3.12.13/uv0.11.26版本、前端构建和Worker2.0.8 prefork已实测；同Pod JuiceFS合成8项通过，不替代跨Pod持久性验收。

uv最初下载官方Python大文件停滞，固定 `download-python-ranges.py`按128KiB/8并发下载固定Python3.12.13 x86_64归档，核对HTTP206、Content-Range、范围长度/摘要，失败范围拆至16KiB并保留已校验断点；34,159,178字节完整归档匹配固定官方SHA256 `10a452caac7041357805f0c19a60576df53f1ab06d1abfc9200f1f0157cb3bd1`后原子提交。安装器再次核对SHA，在专用临时目录解压再移动到尚不存在的目标；已存在正确版本/精确相同链接可复验，拒绝覆盖不同链接/env或不完整目录。离线fake-curl专项只验证范围与失败恢复逻辑，官方归档联网成功为公司平台独立证据。

最终镜像没有 npm/pip/uv，运行应直接调用 Node。若平台覆盖 entrypoint/cwd，启动参数必须保留进程回收并切到 `/app`，例如：

```json
["/bin/sh", "-c", "cd /app && exec /usr/bin/tini -s -- node deploy/company-sandbox/start.mjs"]
```

此参数仍需核实平台实际 bootstrap 约定。PoC 必须使用独立入口；该入口不加载 `.env`、停用调度/通知后台并阻断 MCP/资源/任务/通知等写接口，不直接启动常规 `server/index.mjs`。应用的 Python stdio 是容器内 Node 子进程管道，不依赖平台远程 exec 的 stdin；应通过真实 Worker 探针确认本地管道、fork 和临时目录可用。

当前 `server/local-services.mjs` 静态导入 `scripts/model-billing.mjs`，根 Dockerfile 尚未复制该新依赖；PoC Dockerfile 与上传包补齐该文件，不修改既有镜像或根 Dockerfile。

## 持久数据与密钥

应用默认 `/app/.data` 不等于平台持久工作区。PoC 必须显式设置新 `DATA_DIR`，且目录与旧数据库无关。开发模式可在该新目录生成全新主密钥；如果采用平台 Secret，则使用新的测试 Secret，重启必须保留数据库对应的同一密钥。正式部署仍需外置 Secret。

先检查平台运行 UID、持久区 owner 和写权限，再核对 SQLite `journal_mode=WAL`、事务、锁及 `integrity_check`。单实例写入是现有架构边界，多副本或不支持文件锁的共享存储不在本轮范围。仅创建测试会话/账号来验证恢复，不复制旧任务或数据库。

## 浏览器入口与出口

现有平台文档描述的 Preview 为内网 HTTP Pod IP，且可能随生命周期改变。HTTP PoC 显式使用 `NODE_ENV=development`、测试账号和不含真实数据的独立库；`APP_ORIGIN` 必须与浏览器实际 Origin 一致，IP 改变后需重新取得 Preview 并修正测试启动配置。不能修改 `server/security.mjs` 的生产 HTTPS/主密钥/出口要求来绕过检查。

直接打开根路径测试，避免 iframe；项目设置 `X-Frame-Options: DENY`。浏览器需实际能够到达 Pod IP，并核对 Cookie、同源 `/api`、首段提前到达的 NDJSON、最终答复及刷新回读。生产入口的稳定 HTTPS、代理流式缓冲、身份与 Secret 注入单独待验收。

沙箱内 `127.0.0.1` 只表示该沙箱；不把本机模型/MCP 地址当作可达地址。同实例受控服务用于备用工程验证，不把它当作真实模型质量或 DTS 当前状态证据。真实模型使用用户授权的本地保存配置，必须在目标沙箱实际核对网络和协议，不修改原模型。MCP / DTS 本轮跳过，不访问生产 DTS、不发送通知。

真实模型文件通过 `POC_REAL_MODEL_CONFIG_FILE` 显式指定，必须为私有普通 JSON 文件、权限0600、大小不超过64KiB，精确字段为 `baseUrl`、`apiType`、`model`、`apiKey`，可附加 `schemaVersion:1`。`company-sandbox-export-model.mjs`只读导出四字段，拒绝写入源目录/覆盖输出，前后核对原模型配置与主密钥摘要，不请求模型。只允许 `chat_completions` 或 `responses`；拒绝带用户信息、查询参数或fragment的URL。文件与模型凭据不写入SQLite，不进入源码包/镜像/报告。环境出口只允许 `baseUrl` 的单一origin，HTTP/内网例外也只对该origin生效。

公司实际Worker2.0.8 prefork和真实模式应用已ready，首个完整模型聊天90.009秒超时，最小raw Responses重试HTTP200/completed/9帧22.455秒。后者不是完整Agent/chat成功。首轮失败留下内部notifications，旧PoC“notifications全空”校验拒重启；专用启动/探针改用共同只读`validate-store.mjs`，渠道/事件/投递等仍严格空，仅允许恰好runId/userId、匹配owner/runtime/status、无工具步骤且pending/attempts0的failed/cancelled/unknown/awaiting_approval内部记录，不删失败现场或改server。报告分别使用`isolatedIntegrationTaskNotificationState`、`internalFailureRecords`和`notificationsSent=0`；聊天事件先拒error再要求done，聊天后再次核对隔离状态。

修复后第2次完整chat仍超时，最后第3次完整复验execution failed/requestTimedOut true、整轮91.260秒（非模型精确耗时）。safe-model最小completion before_headers/request_timeout/90.083秒，补UA仍约90秒超时，raw完整payload曾ETIMEDOUT。真实应用模型链路未完成，最小直接请求曾成功；固定双IPv4最小HTTPS请求一完成一无终态，网络/传输差异待定位，现有证据不足以归因特定组件。公司fixture首次11项true/restart未测，同Pod归档恢复后12/12true，彼时内部失败记录2，最终第3次超时后为3，实际通知始终0。浏览器和平台Pod生命周期仍待用户解锁后验收。

离线wheel方案仅备用材料：冻结全平台requirements且不改uv.lock，再按目标CPython3.12/Linux/glibc2.35选择90个官方wheel和固定hash；下载器默认dryrun，离线安装器仅创建新`.venv-offline`且要求所有hash齐全/no-index/offline/no-build/strict、pip check与真实SDK探针。本轮未在公司实例执行离线wheel安装，不把计划或缓存复用当作云部署证据。

## 生命周期与证据

验收分开记录应用进程重启、平台暂停/恢复、实例重建三类操作。本机 arm64 测试已核对容器重启与使用更新镜像换新容器/同一测试卷的恢复，这不证明公司平台 PVC 生命周期。进程重启成功只能证明进程级恢复；持久区和永不过期配置不能自动证明 PVC 重建保留、空闲不回收或连续巡检。调度器在主进程内，实例暂停时不工作，未确认在途操作不得自动重放。

报告只记录测试实例标识、版本、时间、请求状态、脱敏测试标记、Worker 结果及数据库完整性；不写令牌/密码/连接配置。失败保留具体阶段与原因。平台尚未启动、登录尚未成功、流式尚未确认、实际重启尚未完成的项保持未完成。
