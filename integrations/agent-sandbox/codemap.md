# integrations/agent-sandbox/ · 独立 Python 沙箱

| 文件 | 职责 |
| --- | --- |
| [policy.mjs](policy.mjs) | 固定限额、精确请求/身份格式、Bearer 映射、规范化摘要、保守 UTF-8 文本产物扫描 |
| [guest.mjs](guest.mjs) | 固定客体收集器，子进程输出限额、普通文件/无链接产物收集；整个客体信封仍不可信 |
| [docker-runtime.mjs](docker-runtime.mjs) | 本地镜像固定 ID、最小容器创建/inspect、执行超时和整个容器取消/删除核验 |
| [broker.mjs](broker.mjs) | 私有状态/独占锁、按身份排队与幂等、重启 unknown、隔离产物/显式管理员审批、完整性回读、TTL 和回收 |
| [service.mjs](service.mjs) | socket-only 有界 JSON API、认证/Origin 拒绝、管理员纯文本预览与已批准附件下载、独立 CLI 启动 |
| [client.mjs](client.mjs) | 固定 Unix socket API 路由与有界响应客户端 |
| [control.mjs](control.mjs) | 从私有配置取身份的本机CLI，health/源码提交/状态/取消/管理员预览审批/已批准下载/回收；不在命令行暴露令牌 |
| [mcp.mjs](mcp.mjs) | 可选本机 Streamable HTTP MCP 桥，write 源码执行与 read 状态工具；有界认证会话、SDK取消/断连；不批准或下载文件 |
| [README.md](README.md) | 启动、权限、API、MCP 策略要求与生产边界 |

相关验证：[单元测试](../../tests/agent-sandbox.test.mjs)、[MCP会话与取消](../../tests/agent-sandbox-mcp.test.mjs)、[真实本机验收](../../scripts/accept-agent-sandbox.mjs)。模块不导入应用数据库、模型、AgentScope 或业务 MCP，不读取 `.data` 或 `.env`。
