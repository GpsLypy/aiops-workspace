# Proposal

## Why

当前聊天已修复重试清空，但重试等待没有明确状态、恢复后状态不收敛、停止必须另开执行中心，首个受理回包丢失也无法找回原执行。参考 openai/codex 固定提交 5ef96ab2785f3ecddf279639eff7b1b42c906fa4 的流错误状态、可取消退避和对话生命周期，改善整条聊天链路。

## What Changes

- 区分重试等待与重新请求，脱敏原因/次数/等待时间由服务端结构化发送；指数退避加抖动，保留最多五次重试、每次60秒及整轮预算。
- 正文与状态分离，重试保留已打印内容，正常输出恢复生成状态；每次尝试有独立streamId。
- 聊天页增加停止生成，执行持久受理后即返回runId，包括排队阶段。
- 浏览器丢失受理帧时按requestKey只读找回本人原执行，不自动重发问题；解析/读流/查询/退避可取消并有界。
- HTTP429/SSE配额等硬错误拒绝重试，尊重有限的Retry-After，原治理/工具幂等/独立复核门禁保留。

## Capabilities

### New Capabilities

- `chat-reliability`: 聊天受理、消息尝试身份、结构化恢复状态、可取消等待及停止操作。

### Modified Capabilities

无已归档主规范；本次覆盖现有聊天/模型恢复变更的当前行为。

## Impact

server/model、model-stream、request-policy、execution、agent-runtime、agent routes，src/api/Chat/stream-reveal和聊天状态组件/样式；增加本人requestKey查询路由及model_retry事件。无数据库迁移、生产部署、新依赖或供应商协议切换。
