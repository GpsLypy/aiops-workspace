# 设计与边界

主链路：专属产品 MCP write 策略固定源码审批 → 独立 MCP 桥 → 认证 Unix socket broker → 无网络/无宿主挂载一次性 Docker Python 客体 → 不可信有界信封 → broker 白名单扫描/隔离 → 独立管理员预览与显式摘要批准 → 所有者下载 → TTL/删除。

镜像、资源限额和 Docker 参数固定于 broker；客体、应用及桥均无 Docker 管理凭据。身份从服务端随机 Bearer 映射取得，请求只含版本、不可复用 jobId、关联 runId/stepId、语言和源码；额外字段拒绝。请求摘要按固定键序列计算。同身份关联步骤只能绑定一个 jobId，按该唯一标签只读查询可配合现有静态write结果核验。产品write策略注入真实tool_step ID作为jobId，关联runId/stepId标签尚非可信产品执行身份；每次新操作需新标签与资源修订。专属private连接器使用一个submit身份，不宣称共享连接器内用户隔离。

broker 以独占私有状态目录运行，启动前持久化容器名，源代码仅在待执行内存。未完成的重启记录标 unknown、不重跑，按记录名清理容器。执行结束必须确认 Docker inspect 为精确 not-found 才声明 cleanupVerified；无法核实保持 unknown，禁止下载。TTL 删除字节、保留幂等 tombstone，并以2048条总记录上限防止元数据无限增长。

未知且未确认回收的任务继续占用全局容量，调度和新提交冻结，串行维护清理核实后再放下一任务。关闭也重试这类任务，service.close与CLI明确输出cleanupVerified。MCP取消/断连通过精确身份+源码摘要恢复原提交并取消，不取消冲突历史步骤；broker不可达时保持尽力语义，独立执行超时继续生效。

同一客体可以伪造自身输出及 exitCode，因此客体 envelope 不能作为宿主安全证据或业务正确性证明。Docker inspect 独立核对隔离参数；产物按不可信输入重新解码、限额、检查安全名字/类型/内容并 hash，使用 broker UUID 保存。管理员仅能批准当前 pending+clean 摘要，并须为不同于提交者的同租户 admin 身份。下载与管理员预览都复算扫描/hash，浏览器 API 被 Origin 拒绝，preview 强制纯文本，下载强制附件。

Docker 共享内核；本机同 UID 文件访问、内核逃逸、LSM、外部恶意扫描、可靠磁盘持久性、多实例和宿主停机清理仍不证明生产隔离。当前 `productionSecurityAccepted=false` 不随本机验收改变。
