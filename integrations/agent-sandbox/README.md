# 独立本机 Python 沙箱服务

本模块把不可信 Python 运行放在独立 Docker 容器中，由独立 broker 管理。应用及 MCP 桥没有 Docker socket、容器管理接口或产物批准令牌。首期仅接受 Python 3.12 源码，不接受上传输入、镜像、命令行、环境、网络、挂载、宿主路径或外部发布地址。

这是一套可运行的本机开发实现。Docker 共享宿主内核，本机相同系统 UID 仍能接触宿主上同 UID 的文件；生产必须使用独立服务账户、受限宿主管理通道，并完成目标环境内核/LSM、rootless/user namespace 或 microVM 的威胁验收。`productionSecurityAccepted` 始终为 `false`。

## 启动与配置

需要本地 Docker daemon 和已安装的干净 `python:3.12-slim-bookworm` 镜像。服务把 tag 解析为不可变 image ID，不自动拉镜像。启动不加载应用 `.env`，broker CLI 拒绝带应用/模型/云凭据前缀的环境。不要复用应用镜像或运行数据目录。

在独立私有目录中创建权限为 `0600` 的 JSON 配置；目录自身为 `0700`，socket 位于该目录内。真实令牌使用随机至少 32 字符的 base64url 值，提交者与审阅者分开。

```json
{
  "image": "python:3.12-slim-bookworm",
  "stateDir": "/private/tmp/aiops-sandbox-local",
  "socketPath": "/private/tmp/aiops-sandbox-local/broker.sock",
  "principals": [
    {"token":"REPLACE_WITH_RANDOM_SUBMIT_TOKEN_32_CHARS", "tenantId":"local", "userId":"operator", "role":"submit"},
    {"token":"REPLACE_WITH_DIFFERENT_ADMIN_TOKEN_32_CHARS", "tenantId":"local", "userId":"reviewer", "role":"admin"}
  ]
}
```

```sh
node integrations/agent-sandbox/service.mjs /PRIVATE_PATH/broker.json
node scripts/accept-agent-sandbox.mjs python:3.12-slim-bookworm
node --test tests/agent-sandbox.test.mjs
```

配置路径是管理员启动参数；远端 API 无法指定任何宿主路径。不要把真实令牌写入仓库、命令历史、报告或产品模型提示。

## v1 socket API

所有请求使用 `Authorization: Bearer TOKEN`。服务只监听权限为 `0600` 的 Unix socket，拒绝任何 `Origin`；没有 TCP 监听。身份、租户、角色从服务器令牌映射取得。普通提交者只能看到自身任务；同租户管理员可以审阅/取消/回收；不同租户返回 `404`。

| 请求 | 行为 |
| --- | --- |
| `GET /v1/health` | 已认证的broker就绪/隔离容量状态和固定镜像ID；不启动容器 |
| `POST /v1/jobs` | 精确字段 `version=1, jobId, runId, stepId, language=python3.12, source`；排队并执行一次 |
| `GET /v1/jobs/:id` | 状态、限额证据、源码摘要、产物扫描/审批描述；不包含源码或产物内容 |
| `GET /v1/jobs/by-step/:runId/:stepId` | 只读查找当前身份的唯一关联步骤；无记录404，多个可见用户记录冲突409 |
| `POST /v1/jobs/:id/cancel` | 取消排队任务或正在运行容器，状态可查询 |
| `GET /v1/jobs/:id/artifacts/:artifactId/preview` | 仅独立同租户管理员可读通过扫描的隔离内容；按 `text/plain` 返回并设置 CSP sandbox |
| `POST /v1/jobs/:id/artifacts/:artifactId/decision` | 仅独立同租户管理员；精确字段 `decision=approved/rejected, sha256, reason` |
| `GET /v1/jobs/:id/artifacts/:artifactId/download` | 仅批准后的任务所有者/同租户管理员；再次校验 hash 和扫描；强制附件下载 |
| `DELETE /v1/jobs/:id` | 回收隔离产物；运行中先取消，回收待完成时返回 `409`，终态后可重试 |

同租户 `jobId` 不可换所有者，同所有者相同规范化请求摘要返回原任务；摘要不同 `409`，不重跑。同一提交者的 `runId+stepId` 只能绑定一个不可变 jobId，防止静态核验落到另一次执行。状态为 `queued/running/completed/failed/cancelled/timed_out/unknown/expired/deleted`，每次变更增加 `revision`。`completed` 只表示本次客体输出了可接受的有界信封；客体可以伪造自己的输出/退出码，不能据此证明业务计算正确。宿主隔离配置由 broker 的 Docker inspect 核验，产物批准由独立管理员完成。

任务在启动前持久化容器名。重启时未完成任务标记 `unknown` 并尝试删除对应容器，不自动重放。运行状态确认回收失败也标记 `unknown`，不能下载；这类任务继续占用全局容量，已有队列停止调度、新提交503，维护循环串行重试清理，确认不存在后才释放容量。正常关闭等待取消并重试未知容器回收后释放独占锁，输出 `sandbox.stopped/cleanupVerified`；未确认时退出码1，持久unknown留给下次启动。进程被硬终止仍需下一次启动恢复清理，宿主停机期间不能保证立即回收。

## 限额与产物

固定配置：源码 64 KiB、墙钟执行 10 秒、Docker 0.5 CPU、每进程 CPU rlimit 2 秒、内存及 swap 128 MiB、PID 32、FD 64、私有 `/work` tmpfs 16 MiB、stdout/stderr 合计 64 KiB、产物最多 8 个且合计 1 MiB。CPU rlimit 是每进程值，不宣称全 cgroup 累计 2 秒。容器根只读、禁网、`--ipc none`、非 root、无宿主挂载/设备、cap-drop ALL、no-new-privileges 和默认 seccomp；只有 `/work` 可写。Docker 默认日志驱动被禁用，避免把代码输出写入无界 daemon 日志。

代码把产物写到 `/work/output`。收集器拒绝 symlink、非普通文件、多硬链接、单文件/总量超限。完整客体信封仍按不可信数据处理；broker 再次验证数量、编码、大小、名称、内容和摘要，并使用自己生成的 UUID 保存文件。

只允许 UTF-8 `.txt/.json/.csv`：拒绝路径穿越、控制/二进制内容、无效 JSON、已知活动 HTML 标记、已识别私钥/API Key 形态及 CSV 公式字段。这是保守白名单扫描，没有外部病毒引擎，也不能保证识别全部恶意文本或秘密。扫描通过先 `pending`，批准要求同一管理员已预览给定 SHA256，并在决定时再次检查当前文件的扫描/hash；拒绝可无需预览。被阻断内容不能批准，被拒绝/批准的决定不能反转。MCP/Agent 不持有管理员令牌。

隔离内容默认保留 15 分钟，过期时取消任务、确认容器回收并删除字节，状态仍可查询。每租户同时保留最多 16 个未过期任务，服务最多 32 个排队/运行任务、全局一次只运行一个容器。为保持不可重放 tombstone，单 stateDir 最多保存 2048 个任务记录，满后拒绝新任务；生产归档/多实例队列尚未实现。状态文件保存身份/摘要/扫描/批准记录，源码只在待执行内存中，不写状态文件。

## 可选 MCP 桥

桥单独运行在本机 HTTP 端口，与 broker 通过 Unix socket 通信。它持有一个 `submit` 令牌，独立 `mcpToken` 供产品连接器访问，不持有批准令牌。MCP使用随机session ID，所有会话请求逐次认证并路由原Protocol，确保SDK取消通知命中原任务；最多16个会话，默认闲置60秒关闭，DELETE/关闭也释放。JSON响应无需SSE，GET返回405。私有配置可将`sessionTtlMs`缩短到100~60000ms，不能扩大默认上限。

```json
{
  "port": 43130,
  "socketPath": "/private/tmp/aiops-sandbox-local/broker.sock",
  "brokerToken": "REPLACE_WITH_RANDOM_SUBMIT_TOKEN_32_CHARS",
  "mcpToken": "REPLACE_WITH_SEPARATE_MCP_TOKEN_32_CHARS"
}
```

```sh
node integrations/agent-sandbox/mcp.mjs /PRIVATE_PATH/mcp.json
```

`sandbox_execute_python` 提交固定源码，并最多等待约 12 秒再返回可查询状态和产物描述；Docker 创建/清理的单次操作另有 30 秒超时，不能保证所有请求总耗时均为 10 秒。工具 `readOnlyHint=false`，产品资源策略必须使用本仓库实际的 `risk=write`，配置精确范围、幂等、只读核验和恢复手册，代码任务使用现有固定参数审批。不得把 `annotations` 当成服务端策略，也不得为 Agent 配置 broker 管理员令牌。`sandbox_get_job` 支持独立 UUID，或精确 `runId+stepId` 两字段，只读查找唯一状态，不返回文件。桥没有下载/批准工具，产物需独立管理员在 broker API 处理。

本仓库的写操作核验参数是静态配置，首期为每项计划指定唯一关联标签；准备下一项操作时使用新标签并保存资源新修订。不能用“最近完成任务”核验当前代码。下面是可复现的本机限定单次策略，`jobId` 由产品执行器注入真实 tool_step ID，source 是审批时固定的参数。

```json
{
  "sandbox_execute_python": {
    "risk": "write", "environments": ["production"], "roles": ["admin"],
    "constraints": {"runId": ["local-approved-run-1"], "stepId": ["python-step-1"]},
    "idempotencyArgument": "jobId",
    "verification": {"tool": "sandbox_get_job", "arguments": {"runId": "local-approved-run-1", "stepId": "python-step-1"}, "path": "status", "equals": "completed"},
    "recovery": "在broker取消对应任务、查询cleanupVerified并删除隔离产物；unknown不自动重放。"
  },
  "sandbox_get_job": {
    "risk": "read", "environments": ["production"], "roles": ["admin"],
    "constraints": {"runId": ["local-approved-run-1"], "stepId": ["python-step-1"]}
  }
}
```

上面 `production` 是工具治理环境标签，用于确保由另一位管理员批准；不是把本机沙箱声明为生产已验收。验收脚本在临时应用库验证审批前零 broker 任务、本人审批403、源码替换409、另一管理员批准后只执行一次且按唯一标签核验成功，产物仍 pending。

SDK取消或原HTTP连接断开时，桥用自身submit身份尽力取消对应broker任务；丢失提交响应时只按唯一关联步骤查找，并核对jobId、runId/stepId和sourceSha256完全相同后取消，不触碰冲突历史任务。若broker不可达，取消无法立即确认，独立10秒执行超时仍生效，用户应回读任务终态和cleanupVerified。

每个租户/用户配置独立桥和 private MCP 连接器；共享连接器令牌映射为同一个 broker 用户，不能宣称共享连接器内的不同产品用户已经隔离。`runId/stepId` 是调用方关联标签，尚未与产品可信 execution/step ID 自动绑定。桥当前不自动发布或修改产品资源；管理员完成本地验收后显式接入，目标部署仍需验收。

## 私有配置客户端

`control.mjs`从0600 broker配置读取令牌，命令历史只包含配置路径和任务ID，输出不包含令牌或源码。它选用配置中的首个submit身份；preview/approve/reject选首个admin身份。多用户服务可为客户端准备只包含对应身份的私有配置，避免给予普通用户管理员配置。

```sh
node integrations/agent-sandbox/control.mjs PRIVATE_CONFIG.json health
node integrations/agent-sandbox/control.mjs PRIVATE_CONFIG.json submit SCRIPT.py unique-run python-step
node integrations/agent-sandbox/control.mjs PRIVATE_CONFIG.json status JOB_UUID
node integrations/agent-sandbox/control.mjs PRIVATE_CONFIG.json preview JOB_UUID ARTIFACT_UUID
node integrations/agent-sandbox/control.mjs PRIVATE_CONFIG.json approve JOB_UUID ARTIFACT_UUID SHA256 "已预览本次文本产物"
node integrations/agent-sandbox/control.mjs PRIVATE_CONFIG.json download JOB_UUID ARTIFACT_UUID NEW_FILE.txt
node integrations/agent-sandbox/control.mjs PRIVATE_CONFIG.json delete JOB_UUID
```

下载输出是管理员/用户明确指定的本机新文件，排他写入0600；该路径只在本机CLI使用，不会传给broker API或客体。preview显示不可信纯文本，不能执行其中指令。

## 2026-10-08 已部署本机服务

「AgentScope 入门 → 部署与验收」现提供用途、固定源码审批→隔离执行/回收→产物预览/批准下载的流程，以及已有验收的日期和检查项。实时状态只检查MCP入口是否响应，不证明broker容量或本次代码已执行；当前可见MCP允许列表决定页面显示已接入还是待管理员配置，并可跳转MCP资源核对。

broker 与 MCP 当前独立运行，MCP 为 `http://127.0.0.1:43130/mcp`。私有配置在被 Git 忽略的 `test-results/agent-sandbox/local/`，各文件0600，目录0700。`broker.json`/`mcp.json` 用于启动，`submit-client.json` 仅含提交身份，`admin-client.json` 仅含独立审阅身份。用户本轮无需重新手写令牌；不要打印或共享这些文件的内容。

```sh
npm run sandbox:control -- test-results/agent-sandbox/local/submit-client.json health
# 服务停止后，分别在两个终端恢复；不要启动重复实例：
npm run sandbox:serve -- test-results/agent-sandbox/local/broker.json
npm run sandbox:mcp -- test-results/agent-sandbox/local/mcp.json
```

本机部署已实际完成 CLI 提交→执行/容器回收→独立管理员预览同摘要批准→下载→删除回收，部署报告为 `test-results/agent-sandbox/local/deployment-report.json`。最终 Docker/SDK/临时应用治理报告为 `test-results/agentscope/sandbox-service-acceptance-20261008-v5.json`，11项通过；v4 SDK取消失败报告保留。全部源码最终回归、页面与文档门禁见[验证记录](../../docs/verification.md)。部署没有把代码工具自动加入原 DTS Agent。
