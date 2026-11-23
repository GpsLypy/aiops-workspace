# 运维百晓生：从第一次使用到独立接手

运维百晓生是一个 React + Express + SQLite 工作空间：知识库提供资料，Skill 提供工作方法，MCP 提供远程工具，AgentScope 将它们组织成可追踪的对话和定时任务。使用前需要配置兼容 Responses API 的模型；实时查询还需要接通并授权 MCP。

## 按目标开始阅读

| 你的目标 | 先读 | 再读 |
| --- | --- | --- |
| 首次安装和使用 | [从零开始使用](getting-started.md) | [文档中心](document-center.md) |
| 分清前端、后端和每个目录 | [代码库与目录说明](repository-guide.md) | [源码总地图](../codemap.md) |
| 理解问答、模型和工具 | [一条消息的完整旅程](conversation.md) | [上下文与工具](context-and-tools.md)、[问答全景](execution-panorama.md) |
| 开发或调整 Agent | [Agent 使用与开发](agent-development.md) | [架构](architecture.md)、[运行时](agentscope-runtime.md)、[自主委派](agent-delegation.md) |
| 接入自己的运维系统 | [接入实操教程](ops-onboarding.md) | [接口、数据与权限](reference.md)、[生产治理](production.md) |
| 部署、排错或接手 | [部署、排错与接手](operations.md) | [公司沙箱教程](company-sandbox-tutorial.md)、[DTS 独立沙箱](dts-sandbox.md) |
| 学习原理和准备面试 | [源码学习路线](agent-learning.md) | [面试复盘](agent-interview.md)；按需进入配套实验 |
| 核对实际验证结果 | [验收与验证记录](verification.md) | 对应功能的测试命令和报告 |

## 几个关键概念

| 名称 | 在本项目中的含义 |
| --- | --- |
| 前端 / 后端 / Worker | src/ 的页面、server/ 的业务服务、agent-worker/ 的 Python 编排进程 |
| 知识库 | 受权限和有效期控制的 Markdown 资料，按问题检索 |
| Skill | 已发布的工作指令；上传 Skill 不执行本地脚本 |
| MCP | 外部工具发现与调用协议；实际执行由后端校验权限、参数与策略 |
| Agent | 组合指令、资料、模型与工具的执行过程；可选只读子 Agent 委派 |
| 子领域 | 为一类问题限定指令与资源的配置 |
| 上下文 | 本轮模型收到的指令、部分历史、资料与工具结果 |
| 执行记录 | 保存状态、用量和工具步骤；可在问答全景核对处理路径 |

页面按钮不能替代后端权限；写工具需要相应审批，调用结果未知时先核对，不自动重放。外部模型质量、真实工具连通性和生产上线范围以 [验证记录](verification.md) 为准。

## 文档入口与维护

登录后从左侧「文档中心」阅读、搜索和下载；管理员可修改原稿并同步离线官网。分类依次为入门与使用、代码库与开发、运行原理、部署与运维、学习与面试、历史与验证，教学附件按需阅读。

无需启动应用时可打开 [离线官网](site/index.html) 或 [交互架构图](site/architecture.html)。维护方法见 [官网维护说明](site/README.md)。部署手册负责操作步骤，验证记录负责实测范围；源码地图只保留当前模块和调用链，避免重复迭代日志。
