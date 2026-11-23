## ADDED Requirements

### Requirement: 重试状态与正文隔离

系统 SHALL 在可恢复失败后、退避前发送结构化恢复事件，包含固定原因、次数与等待时间，保留已显示正文；每个实际模型尝试 SHALL 使用独立streamId，正常输出恢复生成状态；最终正文 SHALL 不拼接不同尝试。

#### Scenario: 连续断流并恢复

- **WHEN** 原请求已打印正文，连续两次缺少completed终态
- **THEN** 等待期间正文不消失，界面显示次数与等待，恢复后显示正常生成，最终仅保存完整答复一次

### Requirement: 有限且可取消的模型恢复

模型 SHALL 使用有界指数退避/抖动，保留六次网络尝试、每次60秒、整轮预算及权限门禁；硬额度/认证/协议错误 SHALL 不恢复，合法短Retry-After SHALL 被尊重，取消 SHALL 终止等待和后续尝试。

#### Scenario: 服务商配额错误

- **WHEN** HTTP429或SSE错误明确报告insufficient_quota
- **THEN** 仅一次请求，显示固定可读错误，不泄露供应商原始文本

#### Scenario: 等待中停止

- **WHEN** 用户在退避期间停止生成
- **THEN** 不发出下一次请求，原执行保留cancelled，不保存半截成功答复

### Requirement: 受理与显示恢复只读

系统 SHALL 在持久创建执行后且排队前发受理ID；浏览器丢失ID时 SHALL 用requestKey只读查找本人原执行，随后按runId恢复，SHALL NOT 自动重发POST；NDJSON读流、查询与等待 SHALL 有界且响应取消。

#### Scenario: 首个受理回包丢失

- **WHEN** 服务端已创建执行但浏览器没有收到execution帧
- **THEN** 浏览器用原requestKey找回原runId，最终显示同一答复，模型/工具不重复执行

#### Scenario: 查询他人的幂等键

- **WHEN** 当前用户按他人requestKey查询
- **THEN** 返回404，不暴露他人的runId或结果

### Requirement: 可访问的聊天停止与前置失败

聊天 SHALL 提供键盘可用的停止生成及可读阶段状态，320px无溢出；安全requestKey前置校验失败 SHALL 保留问题与附件，快速重复发送 SHALL 只提交一次。

#### Scenario: 排队时停止

- **WHEN** 当前问题已持久排队且用户点击停止生成
- **THEN** 取消原执行而无需打开执行中心，不启动模型请求
