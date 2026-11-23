## ADDED Requirements

### Requirement: 直接浏览所有用户文档
系统 SHALL 在 AgentScope 入门下方展示文档中心同级入口，并按分类提供项目说明、用户手册、部署与集成文档、教学附件的搜索和阅读。

#### Scenario: 直接打开和刷新
- **WHEN** 登录用户打开 #documents?file=docs/README.md
- **THEN** 显示对应原稿的清理后 Markdown，刷新保留选择，文档内部相对链接可跳转已收录文档

### Requirement: 受保护持久编辑
系统 SHALL 只允许管理员编辑已收录 Markdown，保存时检测内容摘要冲突并同步重建检查官网。

#### Scenario: 保存成功
- **WHEN** 管理员提交当前 revision 和修改正文
- **THEN** 原文件更新、官网构建检查通过、界面显示保存完成，回读/刷新保留新内容

#### Scenario: 冲突或构建失败
- **WHEN** 文件被另一编辑者修改或官网无法构建
- **THEN** 不覆盖他人版本或回退本次写入，界面保留草稿并说明重试方法

### Requirement: 文件和交互边界
系统 SHALL 拒绝匿名读取、成员写入、目录穿越、符号链接和非文档访问，不执行 Markdown 脚本，并保护未保存内容。

#### Scenario: 离开草稿
- **WHEN** 管理员编辑后切换文档或离开页面
- **THEN** 要求确认放弃修改，取消后原稿保持；保存期间阻止切换
