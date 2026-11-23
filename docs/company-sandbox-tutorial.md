# 公司沙箱从零部署教程

> 开源说明：本篇部署地址、内部平台域名及实例标识已替换为示例；历史实验记录不是本版本的验收结果。请使用你有权访问的平台，并参阅[本次验证记录](verification.md)。

本教程默认验证无MCP的隔离PoC。2026-10-09新增的DTS独立沙箱与助手显式接入，请另读[DTS MCP独立沙箱](dts-sandbox.md)；启用后不能沿用本教程“资源为空/MCP全部拒绝”的探针结论。

这套流程把运维百晓生的整个应用部署到公司 Agent 沙箱：浏览器页面、Node 后端、Python AgentScope Worker 和测试数据库一起运行。按照顺序完成后，你应能打开页面、登录新测试账号、发送一条受控测试消息，再验证应用重启后会话仍然存在。

本教程采用本次实际使用的**通用模板加源码上传**方式，本机不用安装 Docker。先用内置的受控模型验证安装，再按需使用本地保存的真实模型。受控模型会返回固定测试文本，用来确认程序链路，不会查询 DTS。本流程使用全新项目、全新沙箱和全新测试数据，任务与通知后台关闭。

2026 年 10 月 8 日的实测结论是：基础运行及同实例运行归档恢复通过，恢复探针 12 项通过；完整真实模型聊天三次超时，最后一轮耗时 91.260 秒。浏览器验收和平台实例重建仍待完成。**照着部署成功，不等于真实模型联调已经成功。**详细历史结果见[公司沙箱实测说明](company-sandbox.md)和[验证记录](verification.md)。

## 先看懂在哪里执行命令

全程会使用两个终端环境。每个命令块上方都会写明执行位置，复制时不要连同说明文字一起复制。

| 位置 | 怎样打开 | 主要用途 |
| --- | --- | --- |
| 本机终端 | Mac 的终端，尚未执行 SSH 登录 | 打包源码、上传文件、取回测试账号 |
| 沙箱终端 | 在本机执行 SSH 后进入的远端终端 | 解压、安装、启动、检查和重启应用 |
| 本机浏览器 | 能访问公司内网的浏览器 | 创建沙箱、打开应用、检查页面 |

SSH 是远程登录工具；SCP 是通过 SSH 上传或下载文件的工具。输入 `exit` 可以退出沙箱，回到本机终端；它不会关闭按下面方法启动的后台应用。

| 目录 | 保存什么 | 为什么这样放 |
| --- | --- | --- |
| `/home/sandbox/aiagent-poc` | 源码、前端构建结果、Node 依赖、Python 虚拟环境 | 使用实例本地盘，避免在 JuiceFS 上展开大量小文件 |
| `/home/sandbox/poc-runtime` | 本项目专用 Node、Python 和 uv | 不替换平台的系统版本 |
| `/workspace/aiops-data` | 新测试数据库、对应主密钥和测试账号文件 | 放在平台持久工作区；首次启动必须为空 |
| `/workspace/poc-private` | 可选的真实模型私有 JSON | 与源码、数据库及公开报告分开保存 |
| `/workspace/poc-logs` | 安装日志、应用 PID、验收报告 | 便于重新连接后排查问题 |
| `/workspace/*.tar.gz` | 上传的源码包及后续运行归档 | 本地盘丢失后，作为恢复材料 |

`/home` 在平台实例重建后可能消失；`/workspace` 是否随重建保留，要按公司的平台规则确认。这次完成了同一实例的目录恢复，尚未验证平台重建。

## 第一步 准备本机和项目pwd

取得完整项目源码，并放在本机一个确定的目录。下方示例使用 `~/aiops-workspace`；如果你放在别处，修改 `cd` 后的路径。源码可从 <https://github.com/GpsLypy/aiops-workspace> 获取。

在**本机终端**执行：

```sh
cd "$HOME/aiops-workspace"
node --version
ssh -V
tar --version
```

本机 Node 需要 22.16 或更新版本，尤其后面导出保存模型时会用到 Node 内置 SQLite。若提示 `node: command not found`，先从 [Node 官方下载页面](https://nodejs.org/en/download)安装 Node 22 系列，再打开新的终端检查。Mac 通常自带 SSH、SCP、tar 和 `shasum`。本机可以是 Apple Silicon；要求 x86_64 的是沙箱实例。本机无需提前安装 Python 3.12，Python 会在沙箱内安装。

确认当前目录里能看到 `package.json`、`server/`、`src/`、`agent-worker/` 和 `deploy/company-sandbox/`。如果 `cd` 报“目录不存在”，先找到源码实际位置，再继续。

公司网络需要允许本机访问沙箱 SSH 和应用端口。沙箱安装期间需要下载 Node、uv、Python、npm 和 PyPI 锁定依赖，相关来源包括 `nodejs.org`、npm registry、PyPI、`files.pythonhosted.org` 和 Astral 的 Python 发布地址。下载受阻时，后面的排错章节提供 Python 断点下载备选。

## 第二步 创建独立沙箱并取得连接资料

在**本机浏览器**打开[公司沙箱控制台](http://sandbox.example.com/control/ui/)。先准备一个专门用于本次测试的项目标识，例如 `aiagent-poc-你的日期`，再通过左侧“创建沙箱”创建实例。若你的账号无法管理项目，让平台管理员提供一个独立测试项目；不要选择原有 `dts` 或生产项目。

创建表单可以按下表填写。字段单位和名称以当前平台页面为准。

| 配置 | 本教程使用的值 | 说明 |
| --- | --- | --- |
| 模板 | `agent-runtime-modern` 通用模板 | 本次模板自带 Node 24、Python 3.14，后面会安装项目专用版本 |
| 自定义镜像 | 留空 | 本教程走上传源码的路线；填写镜像可能覆盖模板选择 |
| CPU | 2 CPU | 本次实际实例规格，不代表最低需求 |
| 内存 | 2 GiB | 本次实际实例规格 |
| 持久工作区 | 开启，默认 10 GiB | 应挂载到 `/workspace` |
| 超时或过期 | 验证期间选择足够长的时间，或平台支持的永不过期选项 | 永不过期不等于应用进程永远不会退出 |
| 初始化脚本 | 先留空 | 后面通过 SSH 执行，便于看清失败位置 |
| 运行用户 | 使用平台提供的 `sandbox` 用户 | 后面检查实际 UID 必须是 1000；不使用 root |

等待实例可用，在“沙箱”页面查看这个**新实例**的访问资料，记录沙箱 ID、SSH 主机、SSH 端口、用户名及平台提供的私钥文件。SSH 资料的具体展示位置可能随平台更新变化；需要时查看[平台接入指南](http://sandbox.example.com/control/docs/coding-platform-integration)或“文档中心”。

在**本机终端**定义下面的变量。先替换两处中文占位文字，再执行整块命令。

```sh
cd "$HOME/aiops-workspace"
SANDBOX_HOST='替换为你的新沙箱IP'
SANDBOX_PORT='22'
SANDBOX_USER='sandbox'
SANDBOX_KEY="$HOME/Downloads/替换为平台提供的私钥文件名.pem"
LOCAL_POC_DIR="$PWD/test-results/company-sandbox/my-deployment"
umask 077
mkdir -p "$LOCAL_POC_DIR"
chmod 600 "$SANDBOX_KEY"
```

主机、端口和用户名都应来自你自己的实例。若端口不是 22 或用户名不同，同样修改变量。`chmod 600` 表示只有当前用户能读写私钥。若文件不存在，修正路径后再继续。

这些变量只在当前本机终端有效。以后新开一个本机终端，先重新执行这块变量定义，不要以为另一个窗口会自动继承。`my-deployment` 是本次部署的本机目录名；另做一次独立部署时换一个新名称，同一次部署的所有窗口保持一致。

## 第三步 首次 SSH 登录并检查实例

在**本机终端**执行：

```sh
ssh -i "$SANDBOX_KEY" -p "$SANDBOX_PORT" \
  -o UserKnownHostsFile="$LOCAL_POC_DIR/known_hosts" \
  "$SANDBOX_USER@$SANDBOX_HOST"
```

首次连接会询问是否信任主机密钥。核对它是你新建的实例，按平台或管理员提供的主机指纹确认后再接受。后续命令会使用这次保存的 `known_hosts`。如果提示主机密钥变化，应先核对实例是否重建或 IP 是否变更，不要关闭主机校验来绕过提示。

成功后，你已进入**沙箱终端**。执行：

```sh
id -u
uname -s
uname -m
df -h /workspace
test -w /workspace && echo 'workspace writable'
node --version
python3 --version
```

前面三项必须分别是 `1000`、`Linux`、`x86_64`，工作区应可写。本次模板显示 Node 24、Python 3.14，这是平台系统版本；项目的专用安装器要求 Linux x86_64，不适用于 ARM 实例。

若 UID 不是 1000、架构不同或工作区不可写，先调整新测试实例的模板或权限，不要继续安装。还应确认这不是已有部署。在**沙箱终端**执行：

```sh
if test -e /home/sandbox/aiagent-poc || test -e /home/sandbox/poc-runtime || \
   test -e /workspace/aiops-data || test -e /workspace/aiagent-source.tar.gz; then
  echo '发现已有部署文件，停止从零部署，请核对新实例'
  exit 1
fi
```

发现已有文件时会退出 SSH，不继续本次流程。检查通过后输入：

```sh
exit
```

你现在回到了本机终端，第二步定义的变量仍在这个窗口内。

## 第四步 打包并上传源码

在**本机终端**执行：

```sh
POC_SOURCE_ARCHIVE="$LOCAL_POC_DIR/source-$(date +%Y%m%d-%H%M%S).tar.gz"
node scripts/company-sandbox-package.mjs "$POC_SOURCE_ARCHIVE"
shasum -a 256 "$POC_SOURCE_ARCHIVE"
```

打包脚本输出一个 JSON，包含归档路径、文件数量、字节数和 `sha256`，并生成旁边的 `.manifest.json` 清单。它按白名单取源码，不打包原有 `.data`、`.env`、本机依赖、原账号、私有模型和集成目录。输出文件必须是新文件；不要反复覆盖同一个归档。

在同一个**本机终端**上传：

```sh
ssh -i "$SANDBOX_KEY" -p "$SANDBOX_PORT" \
  -o UserKnownHostsFile="$LOCAL_POC_DIR/known_hosts" \
  -o StrictHostKeyChecking=yes \
  "$SANDBOX_USER@$SANDBOX_HOST" \
  'test ! -e /workspace/aiagent-source.tar.gz && test ! -e /home/sandbox/aiagent-poc && test ! -e /workspace/aiops-data && test ! -e /home/sandbox/poc-runtime' && \
scp -i "$SANDBOX_KEY" -P "$SANDBOX_PORT" \
  -o UserKnownHostsFile="$LOCAL_POC_DIR/known_hosts" \
  -o StrictHostKeyChecking=yes \
  "$POC_SOURCE_ARCHIVE" \
  "$SANDBOX_USER@$SANDBOX_HOST:/workspace/aiagent-source.tar.gz"

ssh -i "$SANDBOX_KEY" -p "$SANDBOX_PORT" \
  -o UserKnownHostsFile="$LOCAL_POC_DIR/known_hosts" \
  -o StrictHostKeyChecking=yes \
  "$SANDBOX_USER@$SANDBOX_HOST"
```

这里 SCP 的端口参数是大写 `-P`，SSH 的端口参数是小写 `-p`。上传前的远端检查失败时，`&&` 后的 SCP 不会执行；先检查原因，不继续后面的步骤。上传目标是本轮全新实例，已有部署不要覆盖旧包。

进入**沙箱终端**后执行：

```sh
sha256sum /workspace/aiagent-source.tar.gz
```

比较它与本机刚才输出的 SHA256，必须完整一致。若不一致，停止解压，重新检查上传文件。本次历史包的 SHA 只适用于那个旧包；你重新打包后应使用自己的 SHA。

确认 `/home/sandbox/aiagent-poc` 还不存在，再执行：

```sh
if test -e /home/sandbox/aiagent-poc; then
  echo '应用目录已存在，停止本次首次解压，请检查是否选错实例'
  exit 1
else
  umask 077
  mkdir -p /home/sandbox/aiagent-poc
  tar -xzf /workspace/aiagent-source.tar.gz -C /home/sandbox/aiagent-poc
fi
cd /home/sandbox/aiagent-poc
ls package.json agent-worker/uv.lock deploy/company-sandbox/start.mjs
```

源码包没有额外的顶层应用目录，所以要解压到 `/home/sandbox/aiagent-poc`。不要把源码和依赖展开到 `/workspace`，本次在 JuiceFS 上解压大量小文件明显缓慢。

包内文件权限是 0600，Shell 脚本没有可执行位。下面统一使用 `sh 脚本路径`，无需执行 `chmod +x`。

## 第五步 安装项目专用运行环境

在**沙箱终端**执行：

```sh
cd /home/sandbox/aiagent-poc
COMPANY_SANDBOX_POC=true sh deploy/company-sandbox/install-runtime.sh
. /home/sandbox/poc-runtime/env.sh
node --version
python3.12 --version
uv --version
```

`COMPANY_SANDBOX_POC=true` 是专用测试入口的开关。安装器只向 `/home/sandbox/poc-runtime` 写入文件，并核对下载哈希，不替换系统 Node 或 Python。成功后应看到：

```text
v22.23.1
Python 3.12.x
uv 0.11.26
```

普通安装分支选择 Python 3.12 系列，补丁版本可能随官方发布变化。本次使用下载备选后固定为 Python 3.12.13。开头的点号 `. /home/sandbox/poc-runtime/env.sh` 是把项目专用工具加入**当前终端**的 PATH；每次重新 SSH 都要执行。

### Python 下载受阻时的备选

如果安装器在 Python 下载处超时或退出，确认原安装命令已经结束，再在同一个**沙箱终端**执行：

```sh
cd /home/sandbox/aiagent-poc
COMPANY_SANDBOX_POC=true python3 deploy/company-sandbox/download-python-ranges.py
POC_PYTHON_ARCHIVE=/home/sandbox/poc-runtime/downloads/cpython-linux-x64.tar.gz \
  COMPANY_SANDBOX_POC=true sh deploy/company-sandbox/install-runtime.sh
. /home/sandbox/poc-runtime/env.sh
python3.12 --version
```

下载器使用平台已有的 Python，只下载固定的官方 Python 3.12.13 Linux x86_64 归档。它分段下载、保留断点、核对每段响应及最终 SHA256；失败后可重新执行同一下载命令。最终应为 34,159,178 字节，SHA256 为：

```text
10a452caac7041357805f0c19a60576df53f1ab06d1abfc9200f1f0157cb3bd1
```

安装器可以核对已完整安装的同版本目录。若提示已有目录不完整或链接不同，先保留现场并查看错误，不要删除整个运行目录来“重试”。

## 第六步 安装依赖并启动受控模型

在**沙箱终端**确认这是首次启动：`/workspace/aiops-data` 尚不存在或是空目录，端口 3001 没有本次应用正在运行。若已有非空目录或活跃应用，先查清来源，不要重新初始化。

执行：

```sh
. /home/sandbox/poc-runtime/env.sh
cd /home/sandbox/aiagent-poc
umask 077
mkdir -p /workspace/poc-logs
unset POC_REAL_MODEL_CONFIG_FILE
nohup env COMPANY_SANDBOX_POC=true sh deploy/company-sandbox/bootstrap-source.sh \
  > /workspace/poc-logs/bootstrap.log 2>&1 < /dev/null &
printf '%s\n' "$!" > /workspace/poc-logs/poc.pid
```

`nohup` 让 SSH 断开后程序仍可继续运行，`&` 表示放到后台，`$!` 是刚启动的进程号。安装日志写到 `bootstrap.log`，PID 写到 `poc.pid`。这只是测试启动方式；应用异常退出后不会自动重启。

bootstrap 会依次执行 `npm ci` 按锁文件安装 Node 依赖，构建前端，`uv sync --frozen` 安装 Python 锁定依赖，检查真实 AgentScope Worker，最后启动应用。安装阶段的 PID 属于 bootstrap Shell，启动完成后由同一个 PID 的 Node 进程接替。因此，**应用 ready 之前不能把这个 PID 当成已经启动的 Node 应用来停止**。

查看进度：

```sh
tail -n 50 /workspace/poc-logs/bootstrap.log
```

等待日志出现 `company-sandbox-poc.ready` 后执行：

```sh
curl -fsS --max-time 5 http://127.0.0.1:3001/readyz
curl -fsS --max-time 5 http://127.0.0.1:3001/poc/status
```

第一条应返回 `{"ready":true}`。第二条的关键字段应为：

```json
{"realModel":false,"schedulerStarted":false,"notificationStarted":false}
```

实际响应还包含其他字段。`realModel:false` 表示当前使用内置受控模型。首次安装可能需要数分钟，取决于下载速度；还没 ready 时不要重复执行 bootstrap，否则会出现并行安装或端口占用。

本步骤不要用 `run-poc.sh`。仓库中的该脚本固定读取 `/workspace/poc-private/model.json`，用于后面的真实模型启动。

## 第七步 运行完整基础探针

在**沙箱终端**执行下面完整命令块。即使刚重新 SSH 登录，也能通过这块命令恢复所需环境。

```sh
. /home/sandbox/poc-runtime/env.sh
cd /home/sandbox/aiagent-poc
export AGENT_RUNTIME=agentscope
export AGENTSCOPE_PYTHON=/home/sandbox/aiagent-poc/agent-worker/.venv/bin/python
export AGENTSCOPE_WORKER_MODE=prefork AGENTSCOPE_POOL_SIZE=1
POC_REPORT_FILE="/workspace/poc-logs/fixture-first-$(date -u +%Y%m%dT%H%M%SZ).json" \
  node deploy/company-sandbox/probe.mjs
```

探针自动读取新生成的测试账号，完成首次初始化和 API 登录，再发送受控聊天。无需先在页面手工注册账号。它还核对首页、Worker 合成模型与工具往返、流式增量、会话持久化、SQLite WAL 与完整性，以及集成接口拒绝。

成功时最后一行输出报告，关键内容是 `realModelUsed:false`、`realDtsUsed:false`、`notificationsSent:0`。首次运行应有 11 个检查项为 `true`，`restartPersistence:null`，因为还没重启；这个 `null` 不能算通过。报告文件名使用时间戳，因为探针拒绝覆盖已有报告。

若出现 NDJSON `error`、缺少 `done` 或 AssertionError，探针没有通过。HTTP 200 只是接口开始返回流，不意味着这轮聊天成功。

`/readyz` 检查程序是否准备好，完整探针检查实际功能；两者需要分别通过。

## 第八步 打开页面并登录

在平台查看新实例端口 **3001** 的最新 Preview 或访问地址，在**本机浏览器的新标签页**直接打开。本次获得的是 HTTP 内网 Pod IP，形式类似 `http://你的沙箱IP:3001`，只适用于公司内网测试；实例重建后地址可能变化。

应用设置了 `X-Frame-Options: DENY`，如果平台 Preview 是嵌入页面，改为直接打开其地址。页面和 `/api` 由同一个端口提供，不需要再启动 Vite 或另外开放 5173。

账号由入口自动生成，用户名是 `poc-admin`，密码在 `/workspace/aiops-data/poc-access.json`。要在本机查看它，可以先执行 `exit` 回到原来的**本机终端**，再下载私有账号文件：

```sh
scp -i "$SANDBOX_KEY" -P "$SANDBOX_PORT" \
  -o UserKnownHostsFile="$LOCAL_POC_DIR/known_hosts" \
  -o StrictHostKeyChecking=yes \
  "$SANDBOX_USER@$SANDBOX_HOST:/workspace/aiops-data/poc-access.json" \
  "$LOCAL_POC_DIR/poc-access.json"
chmod 600 "$LOCAL_POC_DIR/poc-access.json"
```

用本机文本编辑器私下查看 `username` 和 `password`，在登录页填写。文件中的 `setupToken` 只用于初始化，正常登录不用它；不要把整个文件放进截图或共享文档。

登录后发送“仅验证公司沙箱隔离 PoC 流式链路”。答案应明确写着“本机受控模型”，同时检查文字分段出现、结束后会话能回读、刷新页面后历史仍在。修改模型、MCP、任务和通知等操作会被这个专用 PoC 拒绝，这是预期隔离行为。

若实例内部探针通过，但本机页面打不开，先用**本机终端**确认网络：

```sh
curl -fsS --max-time 5 "http://$SANDBOX_HOST:3001/readyz"
```

应返回 `{"ready":true}`。若你使用平台代理 Preview 而非直接 IP，改成平台给出的地址。内部通而本机不通，优先检查公司 VPN、路由和平台端口访问规则；不需要为了页面访问重新安装依赖。

## 第九步 精确停止并验证重启

使用第四步的 SSH 连接命令，重新进入同一个测试沙箱。先确认第七步已经通过，在**沙箱终端**查看本次应用进程：

```sh
poc_pid=$(cat /workspace/poc-logs/poc.pid)
ps -p "$poc_pid" -o pid=,user=,args=
readlink "/proc/$poc_pid/cwd"
```

应显示 `sandbox` 用户、命令 `node deploy/company-sandbox/start.mjs`，工作目录 `/home/sandbox/aiagent-poc`。下面只在命令和目录都匹配时发送 SIGTERM，让应用正常退出：

```sh
poc_pid=$(cat /workspace/poc-logs/poc.pid)
poc_command=$(ps -p "$poc_pid" -o args= 2>/dev/null || true)
poc_directory=$(readlink "/proc/$poc_pid/cwd" 2>/dev/null || true)
if test "$poc_command" = 'node deploy/company-sandbox/start.mjs' && \
   test "$poc_directory" = /home/sandbox/aiagent-poc; then
  kill -TERM "$poc_pid"
else
  echo '进程与本次应用不匹配，未发送停止信号，请先检查'
fi
```

几秒后执行 `ps -p "$poc_pid" -o pid=,args=`，应没有该应用。若仍存在，等待正常退出并检查日志；不要执行 `pkill node` 或结束整个实例里的所有进程。

确认应用已经退出后，在同一个**沙箱终端**启动已安装好的受控模式，避免重复安装：

```sh
. /home/sandbox/poc-runtime/env.sh
cd /home/sandbox/aiagent-poc
export COMPANY_SANDBOX_POC=true NODE_ENV=development
export HOST=0.0.0.0 PORT=3001 DATA_DIR=/workspace/aiops-data
export AGENT_RUNTIME=agentscope
export AGENTSCOPE_PYTHON=/home/sandbox/aiagent-poc/agent-worker/.venv/bin/python
export AGENTSCOPE_WORKER_MODE=prefork AGENTSCOPE_POOL_SIZE=1
unset POC_REAL_MODEL_CONFIG_FILE
umask 077
nohup node deploy/company-sandbox/start.mjs \
  > "/workspace/poc-logs/fixture-restart-$(date -u +%Y%m%dT%H%M%SZ).log" \
  2>&1 < /dev/null &
printf '%s\n' "$!" > /workspace/poc-logs/poc.pid
```

等 `/readyz` 再次返回 `ready:true`，再执行：

```sh
POC_REPORT_FILE="/workspace/poc-logs/fixture-restart-$(date -u +%Y%m%dT%H%M%SZ).json" \
  node deploy/company-sandbox/probe.mjs --recheck
```

此时应有 12 个检查项为 `true`，包括 `restartPersistence:true`。它会读取上次保存的 assistant 消息并核对内容，再做新聊天。不要删除测试数据库来获得“干净的通过”，否则无法验证旧会话是否保留。

## 第十步 按需接入本地保存模型

基础链路通过后，再使用已经获准的本地模型配置。没有本地保存模型时，可以先停留在受控模式；不需要为了部署测试接入 MCP 或 DTS。

如果还在第九步的沙箱终端，先执行 `exit` 回到本机；如果换了一个本机窗口，先重新定义第二步的本机变量。接着在**本机终端**的项目根目录执行。`SOURCE_DIR=.data` 指原工作空间数据目录；导出目标位于另外的私有测试目录。

```sh
cd "$HOME/aiops-workspace"
MODEL_EXPORT_FILE="$LOCAL_POC_DIR/model-$(date +%Y%m%d-%H%M%S).json"
SOURCE_DIR=.data node scripts/company-sandbox-export-model.mjs \
  --out "$MODEL_EXPORT_FILE"
```

该脚本以只读方式打开原数据库，导出 `baseUrl`、`apiType`、`model`、`apiKey` 四个字段，并核对原模型配置及主密钥摘要没有变化。成功输出应包括 `sourceConfigurationUnchanged:true` 和 `sourceMasterKeyUnchanged:true`。原数据库、主密钥、账号、任务和 MCP 都不上传。

原本地工作空间必须已保存可用模型，且 `.data/master.key` 能解密该配置。导出失败时先检查来源路径和配置完整性，不要为了导出修改原账号或原模型设置。真实 API Key 会保存在导出的 0600 文件里，不要把它加入源码包、Git、聊天消息或公开报告。

检查导出结果中的 `loopback`。若为 `true`，说明原模型地址使用 `localhost` 或 `127.0.0.1`；放到沙箱后，它指向沙箱自己，无法直接访问 Mac 上的模型服务。此时保持受控模式，先取得维护者提供的、从沙箱可达的已批准模型接口配置。`loopback:false` 也只说明不是回环地址，仍需要通过完整真实聊天确认网络可用。

在**本机终端**准备沙箱私有目录：

```sh
ssh -i "$SANDBOX_KEY" -p "$SANDBOX_PORT" \
  -o UserKnownHostsFile="$LOCAL_POC_DIR/known_hosts" \
  -o StrictHostKeyChecking=yes \
  "$SANDBOX_USER@$SANDBOX_HOST" \
  'umask 077; mkdir -p /workspace/poc-private; chmod 700 /workspace/poc-private; test ! -e /workspace/poc-private/model.json'
```

最后的检查只有在 `model.json` 不存在时成功。若退出码非 0，先检查是否已有配置或连接失败，停止上传，不覆盖已有私有文件。检查成功后执行：

```sh
scp -i "$SANDBOX_KEY" -P "$SANDBOX_PORT" \
  -o UserKnownHostsFile="$LOCAL_POC_DIR/known_hosts" \
  -o StrictHostKeyChecking=yes \
  "$MODEL_EXPORT_FILE" \
  "$SANDBOX_USER@$SANDBOX_HOST:/workspace/poc-private/model.json"
```

然后重新 SSH，在**沙箱终端**执行 `chmod 600 /workspace/poc-private/model.json`。按第九步的方法精确停止当前受控应用；确认退出后，用仓库的真实模型启动脚本：

```sh
cd /home/sandbox/aiagent-poc
umask 077
nohup env COMPANY_SANDBOX_POC=true sh deploy/company-sandbox/run-poc.sh \
  > "/workspace/poc-logs/real-model-$(date -u +%Y%m%dT%H%M%SZ).log" \
  2>&1 < /dev/null &
```

`run-poc.sh` 自己写入 `poc.pid`，并固定读取 `/workspace/poc-private/model.json`，不需要另外手动保存 `$!`。活跃 PID 存在时它会拒绝重复启动。只设置普通 `MODEL_*` 环境变量并不会让默认入口启用真实模式；专用入口依赖 `POC_REAL_MODEL_CONFIG_FILE`，该脚本已设置它。

检查 `/readyz` 和 `/poc/status`，后者应为 `realModel:true`，调度和通知后台仍为 `false`。模型配置仅注入新测试进程，不保存到测试 SQLite；出口仅允许该模型配置对应的单一 origin。

在**沙箱终端**重新加载探针环境，并验证一次完整真实聊天：

```sh
. /home/sandbox/poc-runtime/env.sh
cd /home/sandbox/aiagent-poc
export AGENT_RUNTIME=agentscope
export AGENTSCOPE_PYTHON=/home/sandbox/aiagent-poc/agent-worker/.venv/bin/python
export AGENTSCOPE_WORKER_MODE=prefork AGENTSCOPE_POOL_SIZE=1
POC_REPORT_FILE="/workspace/poc-logs/real-model-$(date -u +%Y%m%dT%H%M%SZ).json" \
  node deploy/company-sandbox/probe.mjs --recheck
```

成功报告应明确 `realModelUsed:true`，并有完整回答和持久化结果。`incrementalBeforeCompletion` 如果为 `false`，说明这个探针未观察到首段提前到达，不能宣称浏览器流式体验已经验证。

本次使用本地保存模型时，应用模型请求三次超时；最小模型请求有成功也有未结束的情况，尚未确定根因。这是2026-10-08旧版本的90秒模型/120秒聊天探针记录；当前模型默认等待首字节90秒、流中静默180秒、最多重试五次，整轮默认420秒，使用旧探针时须相应提高等待上限。PoC 默认输出上限是 512，增加上限或改超时不能作为已经修复的证据。若出现失败，保留日志和测试执行记录；恢复受控模式可以按第九步启动，它不会修改原模型配置。

失败聊天可能产生内部 `notifications` 执行记录，报告中的 `internalFailureRecords` 不是实际通知发送数。专用校验只接受匹配无工具 AgentScope 失败执行的记录，通知渠道、事件和投递仍为空，后台也未启动。

## 第十一步 保存运行归档并做目录恢复演练

这一步适合已完成基础部署、希望保留安装成果的人。**先按第九步精确停下本次应用并确认退出**，再创建一个新的运行归档。下面的归档结构由这条命令明确确定，与源码包不同。

在**沙箱终端**执行：

```sh
runtime_archive="/workspace/poc-runtime-ready-$(date -u +%Y%m%dT%H%M%SZ).tar.gz"
tar -czf "$runtime_archive" -C /home/sandbox poc-runtime aiagent-poc
sha256sum "$runtime_archive" > "$runtime_archive.sha256"
cat "$runtime_archive.sha256"
tar -tzf "$runtime_archive" | head -n 20
printf '%s\n' "$runtime_archive" > /workspace/poc-logs/latest-runtime-archive.txt
```

记录归档文件名和 SHA256。它含专用运行时、源码和已安装依赖，顶层是 `poc-runtime/`、`aiagent-poc/`；可能需要数分钟才能打包完成。它不含 `/workspace/aiops-data`、`/workspace/poc-private` 或原生产数据。测试数据库及其主密钥仍需一起保留在原持久工作区。

在同一个实例做恢复演练时，先把原目录改名保留，再解压，不覆盖原目录。确认应用和其他本次安装命令都已经退出，在**沙箱终端**执行：

```sh
cd /workspace
runtime_archive=$(cat /workspace/poc-logs/latest-runtime-archive.txt)
sha256sum -c "$runtime_archive.sha256"
```

必须先看到 `OK`，再进行目录改名。哈希校验失败时停止恢复。检查通过后执行：

```sh
backup_suffix=$(date -u +%Y%m%dT%H%M%SZ)
if test -e "/home/sandbox/poc-runtime-before-restore-$backup_suffix" || \
   test -e "/home/sandbox/aiagent-poc-before-restore-$backup_suffix"; then
  echo '保留目录名已存在，停止恢复'
else
  mv /home/sandbox/poc-runtime "/home/sandbox/poc-runtime-before-restore-$backup_suffix" && \
  mv /home/sandbox/aiagent-poc "/home/sandbox/aiagent-poc-before-restore-$backup_suffix" && \
  tar -xzf "$runtime_archive" -C /home/sandbox
fi
```

只对刚才创建、核对过 SHA 的自己的运行归档执行恢复。恢复目标必须保持原绝对路径 `/home/sandbox/poc-runtime` 和 `/home/sandbox/aiagent-poc`，因为 Python 虚拟环境和链接中包含绝对路径。目标模板也须保持 Linux x86_64 和兼容的系统库。

按照第九步的**受控模式启动命令块**恢复应用，再运行 `probe.mjs --recheck`。本次同实例演练通过了 12 项检查，原测试数据库、账号和主密钥没有替换。

如果未来要做平台暂停、重建或更换实例，需要先确认原持久工作区及数据库对应密钥确实被保留，再验证新访问地址、恢复和会话。平台生命周期操作不属于上述目录演练；不要根据一次目录恢复成功就认定平台重建安全。

## 常见问题和处理顺序

| 现象 | 先检查什么 | 接下来怎么做 |
| --- | --- | --- |
| SSH 报私钥权限过宽 | 私钥路径和权限 | 在本机执行 `chmod 600 "$SANDBOX_KEY"` |
| SSH 连接超时 | 是否在公司网络、自己的主机与端口 | 核对 VPN、平台实例状态和连接资料 |
| 安装器立即退出 | UID、系统、架构、PoC 开关 | 第三步必须是 UID1000/Linux/x86_64，命令带 `COMPANY_SANDBOX_POC=true` |
| `Permission denied`，无法执行 `.sh` | 是否直接执行了脚本 | 使用 `sh deploy/company-sandbox/脚本名.sh` |
| Node 还是 24 或找不到 uv | 当前终端没有加载专用 PATH | 执行 `. /home/sandbox/poc-runtime/env.sh` |
| 找不到 `/app/agent-worker/.venv/bin/python` | 源码部署用了镜像默认路径 | 按第七步设置 `AGENTSCOPE_PYTHON`，每个新 SSH 窗口都需要 |
| Python 大文件下载停滞 | 原命令是否已退出 | 用第五步的范围下载备选，再核对版本和 SHA |
| `uv sync` 下载慢 | bootstrap 日志是否仍在推进 | 保留锁文件；不要同时启动第二个安装进程 |
| 首次启动要求空目录 | 是否误用了旧数据或旧实例 | 停止初始化，核对实例；不要删除旧数据库解决 |
| `PoC PID is still alive` 或 3001 占用 | 已有应用 PID、命令和目录 | 第九步只停止匹配本次应用的进程，再启动 |
| 报告文件已存在 | `POC_REPORT_FILE` 是否复用 | 使用新的时间戳文件名，不覆盖前序报告 |
| 实例内 ready，本机页面打不开 | Preview、Pod IP、VPN和端口路由 | 第八步分别测实例内和本机访问，直接新标签页打开 |
| 点击发送立即报 `crypto.randomUUID is not a function` | 是否使用 HTTP 内网 IP、前端是否是 2026-10-09 修复前的旧包 | 升级本次独立沙箱的前端 `dist`，再强制刷新页面；详细原因见下文，不需要改模型 Key |
| 模型 JSON 不存在或权限不合法 | 路径、普通文件、0600 权限 | 检查 `/workspace/poc-private/model.json`；不把 Key 贴到日志 |
| 页面返回 403，不能改模型或建任务 | 是否使用专用 PoC 入口 | 这是预期隔离；本教程不开放这些功能 |
| ready 通过，但聊天超时 | 完整 probe 是否有 error、应用日志 | 区分程序健康和模型成功，保留失败现场，回到受控模式确认基础链路 |
| 重启后记录不见 | 是否复用原 `/workspace/aiops-data` 与对应主密钥 | 不复制一份空数据库替代；核对工作区挂载和旧会话 |

### 点击发送立即报 `crypto.randomUUID is not a function`

2026 年 10 月 9 日在本次 HTTP 沙箱页面发现此问题。浏览器发送前需要创建唯一的请求标识，旧前端直接调用了仅在安全上下文中提供的 `crypto.randomUUID()`。普通 `http://内网IP:3001` 不属于安全上下文；即使首页和登录正常，点击发送也会在浏览器里立即失败，聊天请求还没有到达服务端。它与前一日模型请求等待约 90 秒后超时是两个不同阶段的故障。

修复后的前端在该方法不可用时使用浏览器安全随机函数 `crypto.getRandomValues()` 生成 UUID v4，聊天、固定工具和 Runbook 共用此逻辑。不要为了消除这个错误修改 API 协议、模型名称、Base URL 或密钥。

处理顺序：先确认访问的是自己的独立测试实例；把已包含 [request-id.ts](../src/request-id.ts) 修复的源码重新构建，并仅更新该实例 `/home/sandbox/aiagent-poc/dist` 内的前端文件。替换文件前保留旧 `dist` 以便回退，不上传或覆盖 `/workspace/aiops-data`、私有模型文件及运行密钥。随后在浏览器按 `Command + Shift + R`（macOS）或 `Ctrl + Shift + R`（Windows/Linux）强制刷新，重新发送一条测试消息。

判断修复是否生效时，先确认不再出现该即时错误，再检查请求是否实际进入执行记录、是否有首段文字、完整终态和刷新后的持久答复。请求能发出不代表真实模型已经成功；如果随后出现模型超时，按表中“ready 通过，但聊天超时”继续排查。若仍是同一即时错误，核对当前访问地址和已加载的前端版本，避免打开旧 Preview。正式 HTTPS 的配置、代理流式和生产部署仍需单独验收。

本次 2026-10-08 的源码归档和运行归档都含旧前端，不能直接恢复它们再认为已有此修复。更新后应按第十一步重新保存带新日期的运行归档并核对 SHA；若已恢复旧归档，先应用修复源码并重新构建 `dist`，再验收浏览器。旧归档仍保留为历史恢复证据。

本次修复后已在原生 Chrome 完成一轮 `gpt-6-luna` 普通无工具真实问答，随后刷新、重开会话，答复与执行全景仍在；只读数据库核对成功执行和持久消息一致。此轮没有测量真实模型首段增量时点，也未验收 DTS/MCP 或模型稳定性。详细证据见[2026-10-09验证记录](verification.md)。

Python wheel 离线安装是更复杂的备选，见[部署包的冻结 wheel 说明](../deploy/company-sandbox/README.md#冻结-wheel-离线安装备选)。本次公司实例没有执行这个备选，普通锁定安装已经完成。离线安装会创建 `.venv-offline`；若采用它，需要显式设置新的 Worker 路径，不能直接用固定回到原 `.venv` 的 `run-poc.sh`。

## 怎样判断部署完成

按自己的本次结果逐项确认，不直接沿用旧报告的通过数量。

| 检查 | 你应取得的结果 |
| --- | --- |
| 版本和目录 | Node22.23.1、Python3.12、uv0.11.26；源码与依赖在 `/home`，新数据在 `/workspace` |
| Worker 和服务健康 | Worker 探针 ready，`/readyz` 返回 `ready:true` |
| 基础完整链路 | 受控模式首次 11 个 true，API 登录、增量、持久化与隔离都通过 |
| 重启 | 真正重启应用后 `--recheck` 12 个 true，旧会话保留 |
| 浏览器 | 从自己电脑打开当前地址，登录、发消息、观察流式、刷新后历史一致 |
| 真实模型 | 可选，必须另外有 `realModelUsed:true` 的完整成功结果；最小 API 可达不能代替 |
| 平台生命周期 | 若要依赖平台重建，另做持久工作区、密钥、恢复和地址变化验收 |

本教程完成的是内网隔离测试部署。生产部署需要稳定 HTTPS、外置 Secret、流式代理、常驻进程管理和平台存储生命周期验收；这些应走另一个部署流程，不能通过把这个 PoC 的 `NODE_ENV` 改为 production 来完成。

## 本次已有现场的参考信息

以下是 2026 年 10 月 8 日的部署快照，用于定位报告。重新部署时使用自己的实例资料，不把这里的地址写成固定参数。

| 项目 | 本次值 |
| --- | --- |
| 测试项目 | `aiagent-poc-20261008` |
| 沙箱 ID | `sbx-example` |
| SSH | `sandbox@192.0.2.10:22` |
| 应用入口 | `http://192.0.2.10:3001` |
| 模板和系统账号 | Linux x86_64、UID1000，系统 Node24/Python3.14 |
| 实际项目运行时 | Node22.23.1/Python3.12.13/uv0.11.26/AgentScope2.0.8 |
| 源码包 | `source-2026-10-08T14-24-25-502Z.tar.gz`，96文件，286,720字节 |
| 源码 SHA256 | `0b81c579c79ad2b283af1e50c0b96310857e20c70f2a3a73e221b0f93d221529` |
| 基础和恢复 | 首次受控11项通过，同实例运行归档恢复12项通过 |
| 真实模型 | 完整应用聊天三次超时；最终3条内部失败记录，实际通知发送0 |
| 最终现场 | 真实模型模式，ready；调度与通知后台关闭；MCP/DTS跳过 |

汇总保存在项目的 `test-results/company-sandbox/deployment-20261008.json`。SSH 私钥、测试账号和真实模型 JSON 只保存在私有文件中，这份教程不包含它们的内容。

2026-10-09 后续状态：仅更新这个独立实例的前端后，HTTP请求标识错误已修复；原生Chrome一次普通真实模型问答成功，刷新后重新打开会话仍能看到答复和全景。上表仍是10/8历史快照，旧三条失败记录保留，旧归档也没有被自动升级；普通聊天成功不代替MCP、真实模型流式、稳定性或平台重建验收。

同日再次更新已上线原创标志和单层输入框。打开[当前沙箱聊天页](http://192.0.2.10:3001/#chat)，用测试账号登录；若仍显示旧界面，按 `Command + Shift + R` 或 `Ctrl + Shift + R` 强制刷新。应看到标签页的蓝底“百”字，聚焦输入区时只有一条细外边框。真实HTTP浏览器已核对桌面/320px、键盘焦点与刷新回读，服务保持原PID运行；此次没有重新调用真实模型。

本轮补丁、清单、应用脚本及旧文件备份保存在**沙箱**的 `/workspace/poc-logs`，备份目录为 `before-brand-composer-frontend-2026-10-09T04-03-44-213792Z`，不是测试数据库或模型目录。旧10/8源码与运行归档没有被覆盖；恢复旧版本后应按前述HTTP修复流程保留安全请求标识，再使用当前源码构建前端，或按第十一步新建当前版本运行归档。部署摘要与实际验证见[最新验证记录](verification.md#公司沙箱更新原创标志与单层输入框2026-10-09)。

最新入口采用有框按钮与图标/用途/选中勾菜单，覆盖此前无框入口版本；单通用项也可查看用途，历史与生成中锁定。窄屏菜单保持视口内，长列表可滚动。备份与部署结果见[最新Agent入口验证](verification.md#agent-有框入口与用途菜单2026-10-09)，旧前端备份仍保留；旧运行归档不会自动包含最新前端。
