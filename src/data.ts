export type Page = 'knowledge' | 'skills' | 'mcp' | 'agents' | 'tasks' | 'notifications' | 'sessions' | 'chat' | 'guide' | 'documents';
export type Item = { id: string; kind: Page; name: string; description: string; domain: string; status: string; owner: string; updated: string; body: string; endpoint?: string };
export const labels: Record<Page, string> = { knowledge: '知识库管理', skills: 'Skill技能', mcp: 'MCP服务', agents: '子领域Agent', tasks: '定时任务', notifications: '通知中心', sessions: '会话管理', chat: 'New Chat', guide: 'AgentScope 入门', documents: '文档中心' };
export const initialMarkdown = `# 如何接入 Heimdallr

> 说明：因为限流逻辑的设计原因，对于快速失败和线程数限流，在少数高负载场景下可能会出现限流放过量略微偏大的情况，因此不建议在成单、配额、库存等对数量控制有严格要求的场景使用。

## 1.介绍

Heimdallr 名字来源于北欧神话，他是光之神，破晓之神，中文名：海姆达尔。

Heimdallr 是一个集**熔断降级**、**分布式限流**于一身的组件，支持 .NET、JAVA 应用接入，也支持通过网关接入。不限语言，规则实时生效，自由灵活管控，带有详细的监控功能。

## 2.接入流程

1. 在平台申请应用并获取接入配置。
2. 添加对应语言的 SDK 依赖。
3. 配置服务地址及应用标识。
4. 验证限流规则并观察监控指标。

\`\`\`yaml
heimdallr:
  enabled: true
  application: your-service
\`\`\`

## 3.使用建议

从小流量验证开始，逐步调整阈值，确保服务稳定运行。`;
export const initialItems: Item[] = [{ id: 'heimdallr', kind: 'knowledge', name: 'Heimdallr接入手册', description: 'Heimdallr如何接入、公司熔断限流产品、如何接入熔断限流服务', domain: 'middleware/heimdallr', status: '已启用', owner: '程露', updated: '2026-08-06 11:51:00', body: initialMarkdown }];
export const guides = {
  knowledge: { eyebrow: 'KNOWLEDGE MAP', title: '知识库只沉淀静态知识', description: '知识库只承载静态知识；元信息、状态、归属等可变数据应从源系统实时获取。', rule: '静态知识写文档，可变数据优先由 Skill 对接', steps: [['先确认是静态知识', '只沉淀长期稳定、可以通过文档维护的事实和经验'], ['可变数据从源系统获取', '元信息、归属、状态和实时数据优先由 Skill 对接系统查询'], ['避免复制已有知识', '官方文档已有结论时直接引用，只补充未覆盖的稳定经验']] },
  skills: { eyebrow: 'SKILL DEVELOPMENT', title: '用 Skill 定义可复用的工作流程', description: 'Skill 以 Markdown 指令说明处理步骤和输出要求，可指导模型使用已授权的 MCP 工具。', rule: '指令定义方法，远程工具执行操作', steps: [['阅读规范并定义边界', '用 SKILL.md 写清什么时候用、怎么做以及不负责什么'], ['编写指令并说明工具用途', '当前支持提示词与 MCP 编排，不执行上传的 Shell 或 Python 脚本'], ['保存后在真实会话中验证', '设置使用范围与管理人，再检查实际回答和工具调用']] },
  mcp: { eyebrow: 'REMOTE TOOLS', title: 'MCP 提供可复用的远程工具', description: '连接 Streamable HTTP 服务，发现工具并维护允许自动执行的清单。只显示你有权使用的服务。', rule: '管理员维护连接，允许列表限定执行', steps: [['先看已有服务', '“我的 MCP”显示可管理的服务，“全部可用 MCP”显示有权读取的服务'], ['发现并授权工具', '先保存服务，再连接并发现工具，勾选允许自动执行的工具后保存'], ['由管理员维护配置', '管理员维护地址、令牌、工具允许列表、使用范围和管理人']] },
  agents: { eyebrow: 'CAPABILITY ORCHESTRATION', title: '子领域只解决明确的场景干扰', description: '默认不拆分子领域；只有不同问题场景产生明确干扰，需要隔离指令或能力时才按需创建。', rule: '按需创建，有明确干扰时才分流', steps: [['先确认存在明确干扰', '只有指令冲突、能力误选或不同场景相互影响时才需要拆分'], ['再定义问题边界', '写清负责和不负责哪些请求，不要只按部门、项目或主题拆分'], ['小范围验证隔离效果', '以 Skill 为核心组合能力，确认分流能真正消除干扰后再扩大']] },
  tasks: { eyebrow: 'SCHEDULED AGENT RUN', title: '让完整 Agent 指令按时间自动执行', description: '用单次时间或五段 Cron 启动独立 Agent 会话，保存执行记录，并将结果推送到企业微信或 Webhook。', rule: '调度只决定何时执行，任务指令必须完整自包含', steps: [['在本页创建任务', '填写完整指令，选择处理 Agent、单次时间或 Cron 与时区'], ['配置巡检与通知', '选择通知渠道和推送时机，用实际工具返回的字段配置正常条件'], ['先试跑再长期启用', '点击立即执行，分别核对执行结果、巡检结论和消息投递状态']] },
};
