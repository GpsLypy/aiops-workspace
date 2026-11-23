# Python Worker 地图

Python Worker 是所有 Agent 对话与定时任务的必需编排路径，增强暂停也不能绕过它。

`pyproject.toml` 固定 Python 3.12 与 AgentScope 2.0.8；`uv.lock` 锁定传递依赖。`.venv` 是本机安装结果，不提交。

`worker.py` 有 cold 与 `--pool` 两种入口。cold 每进程只服务一个 run；prefork 父进程仅导入 SDK、接收不含业务内容的 lease 并 fork，子进程发送 leased 后才读取 start；父进程 wait4 回收子进程后返回 ready 与 CPU/RSS 样本。每轮 Agent 和事件循环都创建于独立子进程，不跨用户复用对象或状态。

运行子进程读取 start → 构造 Agent、ModelBridge 与外部工具 → reply_stream → 通过管道请求 Node 模型/工具 → ExternalExecutionResultEvent 回填 → finish 或 fatal。stdout 专用于协议，库的 stdout 转到 stderr，Node 不向客户端展示原始库输出。prefork 仅支持 POSIX，检查父进程单 Python 线程；清理目录与进程组由父进程/Node 协作负责。

ModelBridge 不直接联网，不持有供应商真实凭据；不使用框架生成的新上下文覆盖 Node 原始消息。NoCompression 中间件与配置禁用首期不需要的压缩/注入/重试。外部工具的 ALLOW 仅允许向 Node 提交请求，Node 校验与审批决定实际执行。

正文流式输出由 Node 模型适配层直接转发到浏览器，ModelBridge 仍接收完整结果并保持 stream=False；不将浏览器文本增量送回 Python，也不改变外部工具请求协议。独立复核模式的文本发布继续由 Node 门禁控制。

安装与本地探针见 [运行指南](../docs/agentscope-runtime.md)。本目录不实现 HTTP 服务、业务数据库、定时器、跨 run AgentState、操作系统沙箱或通用代码执行器。

2026-10-08：prefork 子进程开始每轮前将 TMPDIR 和 Python tempfile 缓存重置为本轮私有目录，避免预加载父进程的缓存把临时文件写到共享目录；该措施不是租户级文件隔离。
