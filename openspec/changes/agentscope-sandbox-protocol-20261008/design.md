# 威胁模型、协议与验收设计

## 信任边界

不可信输入包括用户上传内容、模型提出的代码、输入文件及代码输出。攻击者可能尝试读取应用数据库/密钥、访问模型或 MCP 出口、挂载宿主路径、打开 Docker socket、耗尽 CPU/内存/PID/磁盘、留下跨轮文件、让输出注入后续模型或借产物路径穿越。Docker 容器共享宿主内核；需要抵抗恶意租户代码时，需额外评估 rootless/user namespace、LSM 和 microVM。当前应用容器不能作为沙箱镜像或 broker。

## 计划中的 v1 请求与状态（尚未接入产品）

认证用户显式提交单次转换任务；Node 校验权限并创建持久 `runId/stepId`。请求只含 `version=1`、不可复用的 `jobId`、`runId`、`stepId`、`requestDigest`、`language=python3.12`、源码内容地址、最多 8 个经授权的只读输入句柄及服务器设定的预算。首期上限：源码 64 KiB、每输入 4 MiB、墙钟 10 秒、CPU 2 秒、内存 128 MiB、PID 32、临时盘 16 MiB、stdout 64 KiB、总产物 1 MiB。客户端不得传镜像、挂载、网络、环境变量、运行用户或任意路径。相同 jobId 与摘要只返回原状态；摘要不同返回冲突。broker 无法判明是否运行时标 `unknown`，不自动重试。

broker 通过独立受限本地通道取已授权输入，按内容 hash 校验，创建一次性容器或 microVM。运行环境使用独立镜像 digest、非 root 用户、只读根、空凭据环境、仅只读输入和私有临时盘、禁网、无宿主设备/挂载/Docker socket、cap-drop、no-new-privileges、seccomp/LSM、资源限额和硬超时。Docker 探针额外使用 `--ipc none` 并拒绝 `/dev/shm` 写入，避免该目录绕过 `/work` 的 16 MiB 临时盘上限；生产 broker 仍须核对全部可写挂载与输出配额。应用容器只持有提交权限，不拥有容器管理 socket。取消必须停止整个进程组/cgroup，并确认工作盘回收；退出/超时/宿主故障均要能查询最终状态。状态为 `accepted/queued/running/completed/failed/cancelled/timed_out/unknown`，每次转换带递增版本和时间戳。

stdout/stderr 为有界、脱敏的诊断文本，不自动成为可信指令。broker 对输出文件按类型、大小、hash、路径和恶意内容策略检验，隔离保存并设 TTL；用户可预览，下载或向外部系统发布需明确授权。路径由 broker 生成，不接受代码提供的相对/绝对发布路径。审计只存身份、摘要、状态、限额、产物 hash 和批准动作，不存源码、密钥或完整文件。

## 本轮可运行探针

`npm run agent:sandbox:probe -- LOCAL_IMAGE [--out REPORT.json]` 只使用固定内置代码，要求本地镜像且将 tag 解析为不可变 image ID。探针创建两轮隔离容器，核对 `--ipc none`、应用文件、Secret、Docker socket、根目录和 `/dev/shm` 不可写、独立工作盘、出站连接、敏感环境变量与跨轮残留；第三个容器验证强制删除后不可再查询。每次在 `test-results/agentscope/` 新建独立脱敏 JSON 报告，不连接应用/模型/MCP，也不使用真实输入。现有应用镜像应被拒绝。

探针不覆盖内核逃逸、侧信道、真实资源耗尽、超时自动回收、产物扫描/审批、分布式故障或完整业务权限；这些是启用产品执行入口前的独立阻断验收。
