# DTS MCP 独立公司沙箱部署

> 开源说明：本篇部署地址、内部平台域名及实例标识已替换为示例；历史实验记录不是本版本的验收结果。请使用你有权访问的平台，并参阅[本次验证记录](verification.md)。

用户于2026-10-09要求将DTS MCP独立部署。当前部署仅提供 `dts_get_job_status`，业务域 `general`、区域 `cn_east`，任务ID为正int64十进制字符串；不提供暂停、重启、枚举或其他区域工具。Mac既有服务和资源不迁移。

## 当前部署

| 项目 | 当前实例 |
| --- | --- |
| DTS项目 | `dts-mcp-sandbox-20261009` |
| 持久DTS实例 | `sbx-example`，SSH `sandbox@192.0.2.20:22`，永不过期，1CPU/1Gi内存/10Gi工作区 |
| 实际运行环境 | Linux x86_64、UID1000、Node24.16.0；仅Node适配器，无Python/SQLite依赖 |
| MCP进程 | `/home/sandbox/dts-mcp`，只监听 `127.0.0.1:43129/mcp` |
| 私有配置/日志 | `/workspace/dts-mcp-service/dts.env`（0600）、`service.log`、`service.pid` |
| 助手实例 | 原 `sbx-example`，SSH `sandbox@192.0.2.10:22` |
| 助手页面 | `http://192.0.2.10:3001/#chat`，原测试管理员、原保存模型和6个既有会话保留 |
| 客户端MCP地址 | 助手容器内 `http://127.0.0.1:43130/mcp`，通过SSH转发到独立DTS沙箱 |

以上IP是本轮现场值，不是永久服务名。平台重建、IP变化、跨Pod持久化、长期可用性和生产部署均需另行验证。

2026-10-09收尾时，快速入口误建的空临时实例已由用户删除；控制台项目列表仅保留上述正式DTS实例，独立服务healthy与助手ready均复核通过。

## 为什么用SSH转发

调用链为：浏览器 → 助手后端 → 本容器43130端口 → SSH加密通道 → DTS沙箱回环43129端口 → 公司DTS REST。

原适配器的loopback监听、Bearer Token、Host/Origin保护和固定上游请求保持原实现。无需对外开放携带MCP Token的HTTP端口。独立服务生成新的MCP Token，助手数据库按原机制加密保存；不复制Mac应用数据库/主密钥。

转发专用SSH key与平台管理员SSH key分开。服务端公钥使用 `restrict,port-forwarding,permitopen="127.0.0.1:43129",permitlisten="127.0.0.1:1",command="/bin/false"`：Shell请求拒绝，只允许指定本地转发目标，业务端口的远程转发拒绝。OpenSSH公钥 `permitlisten="none"` 在本模板中不接受，实际使用上述受限配置并单独验收；不把平台管理员私钥上传到助手容器。公钥持久化到平台重新生成的home目录仍待平台重建验收。

## 从头部署

1. **公司控制台：**新建独立项目，在沙箱列表选择模板的“基于模板创建”，指定项目、1CPU/1Gi、持久工作区和永不过期。不要直接使用快速“启动”：本轮快速入口产生的是空临时实例，不可将其当作持久服务。
2. **本机终端：**保存平台SSH私钥至Git忽略的私有目录，权限0600；确认SSH主机、用户和项目ID。执行 `node scripts/dts-sandbox-package.mjs /absolute/new-source.tar.gz`，输出归档SHA256与文件数。
3. **沙箱终端：**在 `/workspace` 保存源码归档，先核对SHA256；首次在空的 `/home/sandbox/dts-mcp` 解压。不要在JuiceFS上安装大量小文件依赖。
4. **沙箱终端：**建立0700目录 `/workspace/dts-mcp-service`，把独立配置保存为 `dts.env`、权限0600。固定原上游路径，设置 `DTS_BUSINESS_DOMAIN=general`、`DTS_AREA_NAME=cn_east`、`DTS_JOB_SCOPE=region`、空 `DTS_ALLOWED_JOB_IDS`、`DTS_MCP_PORT=43129` 和新随机Token。HTTP上游仍需显式 `DTS_ALLOW_HTTP=true`。
5. **沙箱终端：**进入源码目录，`npm ci --ignore-scripts --no-audit --no-fund`，再 `node deploy/dts-sandbox/service.mjs start`。随后 `status` 应显示 `running:true`、`healthy:true`。第一次启动返回starting不代表就绪，必须读回状态。
6. **本机或助手容器：**创建转发专用key；在DTS实例新增上文受限公钥，保留原管理员公钥且确保换行分隔。固定known_hosts，使用 `ssh -NT -i KEY -o UserKnownHostsFile=KNOWN_HOSTS -o StrictHostKeyChecking=yes -o ExitOnForwardFailure=yes -L 127.0.0.1:43130:127.0.0.1:43129 sandbox@DTS_HOST`。实际目的地址替换为本次实例SSH主机。
7. **客户端终端：**创建0600的探针JSON，字段为endpoint/token/jobid，其中endpoint为客户端自己的43130地址。执行 `node deploy/dts-sandbox/probe.mjs PRIVATE_JSON NEW_REPORT`，必须9项true。真实任务要用当前获准ID，不能把历史任务状态当作本次结果。

## 助手沙箱的显式接入

原PoC默认仍禁止所有MCP。DTS模式要求额外上传 `integrations/dts-mcp/{adapter,provision}.mjs`、knowledge.md、dts-status/SKILL.md及独立部署辅助脚本；默认公司沙箱源码包仍排除integrations。

本机先将Skill目录打ZIP，再传入助手容器 `integrations/dts-mcp/dts-status.zip`；平台模板没有 `/usr/bin/zip`，不能直接沿用Mac现场打包方式。`provisionDts` 的 `skillPackagePath` 仍经正式Skill ZIP检查，不执行包内脚本。

私有 `/workspace/poc-private/dts.json` 仅含 `endpoint`、`statusUrl`、`token`；endpoint必须精确为 `http://127.0.0.1:43130/mcp`。先启动SSH监督器，再在无活跃执行时精确停止原应用PID。用 `COMPANY_SANDBOX_POC=true sh deploy/company-sandbox/run-dts-poc.sh` 启动；后台方式按现有教程使用nohup。专用入口先验证SSH通道健康，固定Responses，默认4096输出预算、POC_MODEL_TEMPERATURE=none，模型出口固定SSE；已保存模型文件与密钥不改写。

启动会复用已初始化的 `poc-admin`，创建并发布四个私有DTS资源，策略限定当前管理员、production环境、general/cn_east，并要求每轮jobid/business_domain/area_name目标绑定。首次接入应已有测试管理员；不会导入生产账户或重置账号。已有资源必须匹配配置，缺少部分/改变Token或策略时拒绝覆盖。

只开放该MCP ID的discover/call，资源写入、其他MCP、任务、通知和Runbook继续禁止。数据库校验只允许四个精确私有DTS资源；默认模式仍要求资源为空。显式DTS模式可保留该工具相关的内部执行失败记录，外部通知渠道/事件/投递仍必须为0。

页面操作：打开助手入口，新对话选择 `DTS cn_east 运维`，展开“本轮查询目标”，填写任务ID并确认，再发送同一目标的问题。后台MCP详情的“连接并发现工具”应只有 `dts_get_job_status`。确定参数查询还可使用“执行与审批”的固定工具入口，它不依赖模型。

## 本轮证据与恢复

实际结果以[验证记录](verification.md)为准。Mac与助手容器均已完成真实SDK/DTS查询；应用执行中心、网页模型对话及恢复演练分别记录，不用SDK成功替代模型质量验收。

接入前加密备份、隔离恢复演练及旧入口位于助手容器 `/workspace/poc-logs/before-dts-integration-20261009`；独立恢复key在 `/workspace/poc-private/dts-before-backup.key`。原模型配置和主密钥摘要核对，不输出内容。

恢复原PoC需要先停止当前入口，恢复旧start/validate-store源码，并将加密备份恢复到一个新目录；核对完整性、原会话和密钥后再切换。**不能只去掉DTS配置直接启动已经有DTS资源的数据库**，默认隔离检查会拒绝；也不能覆盖正在运行的数据库或删除失败记录。本轮未进行覆盖原库回滚。

独立MCP子进程退出后supervisor恢复已实测；supervisor自身退出、平台暂停/重建和所有长驻初始化尚不属于本次恢复证明。代码在home，配置在持久workspace，重建时必须核对地址/密钥/源码并重装启动。


## Responses 传输边界

2026-10-09后续按用户要求移除完整响应模式：整个项目只请求 Responses SSE，固定stream:true；DTS入口不再提供关闭流式的配置，JSON响应即使status=completed也被拒绝。不改变只读权限或目标绑定。此前完整JSON模式的成功仅是历史证据，不能用于当前SSE部署验收。供应商流式缺少终态的失败记录保留；真实工具已执行的失败也不能把临时正文当作成功，不自动重跑工具。当前SSE真实往返已成功一轮：1真实DTS步骤、103正文增量、合法终态和持久回读一致。该结果不代表连续稳定性已通过，详见[最新验证记录](verification.md)。
