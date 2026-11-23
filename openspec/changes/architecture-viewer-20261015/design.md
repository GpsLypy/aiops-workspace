# Design

采用深色工作台、青绿流向、语义分区和细边框节点。外层仅提供系统/流程切换，独立SVG查看器拥有节点、连线、搜索、缩放和导出，避免维护第二套拓扑。用户可切换浅色主题。

两份JSON是图形事实来源，HTML由Archify校验交付；不手改已生成HTML。系统图按进程和受控出口分区。请求流程按当前源码描述受理、上下文、AgentScope和工具回传；等待审批不会被画成当前对话自动继续，委派/独立复核说明为可选省略项。

Vite仅映射三个固定HTML路径，dist静态服务复用现有Express。图中只有项目公共架构说明，不写入账号、配置或执行数据。新标签页通过noopener noreferrer隔离，不改变文档编辑守卫。动效是演示，可暂停，尊重减少动效偏好。

发布从线上基线冻结候选，备份旧文件与SQLite，逐文件校验摘要，dist入口最后原子切换，保留旧资源，核对PID/readiness和受保护数据。

浏览器验收发现全局X-Frame-Options: DENY会阻止固定图表内嵌。新增diagram-assets.mjs，仅对两份固定图形允许SAMEORIGIN；入口仍为DENY，图表CSP仅允许已交付HTML内脚本的SHA256摘要，拒绝connect，不开放unsafe-inline脚本。发布包含后端模块及受控重启。
