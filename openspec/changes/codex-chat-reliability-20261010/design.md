# Design

## 源码依据

固定参考：https://github.com/openai/codex/tree/5ef96ab2785f3ecddf279639eff7b1b42c906fa4 。读取 core/src/responses_retry.rs（重试提示在等待前、取消由调用方包裹）、codex-client/src/retry.rs（指数退避/抖动/错误分类）、http-client/src/retry_after.rs（服务端等待建议）、tui/src/chatwidget/streaming.rs 与 protocol.rs（重试状态独立于正文，普通事件恢复状态）。官方开发者/Platform流式文档本次请求均403；协议结论以实际开源读取及本仓库SSE契约为准。

## 决策

模型只有一层重试，防止HTTP重试与流重试乘积；400ms起指数退避、10%抖动、上限5秒。Retry-After有限值优先，超过5秒停止自动恢复；继续本项目六次尝试和单次60秒，整轮默认420秒，取消/预算/权限可提前结束。硬配额错误不重试，未知SSE错误继续严格拒绝；不采用Codex可选无限连接恢复、WebSocket降级或内部推理显示。

model_retry含phase(waiting/connecting)、attempt、maxAttempts、delayMs、固定reason，不携带原始错误。waiting发送前一尝试reset但保留正文；实际重新发请求后创建独立streamId，防旧增量污染；首个正文或工具事件恢复正常状态。重试期间仍是同一逻辑答复，最终以持久完成正文收敛。

执行服务在持久创建后、排队前回调受理ID。只读GET /api/executions/request/:requestKey仅查本人；浏览器断线不POST重放，缺runId时通过该路由找回，再查询原runId。浏览器NDJSON严格UTF8/单帧大小有界，显示连接45秒无数据则只读恢复（后端心跳15秒）；每次查询15秒、总450秒、连续网络错误5次，所有等待响应外部AbortSignal。

界面沿用蓝白运维对话：#315fff连接强调、#202736正文、#69758b状态、#e2e8f2边界、#f6f8fc状态底、#fff页面；沿用现有中文系统字体，工具计时用ui-monospace。状态行在正文下方，左侧当前动作/原因/倒计时，右侧耗时和停止；320px换行且按钮可键盘聚焦。特征是可连续阅读的正文配独立恢复状态，减少动效取消闪烁。发送前完成安全requestKey生成，防双提交与前置失败丢稿。

## 边界

工具提议撤下候选、最终失败/取消不保存半截成功答案；独立复核候选/JSON继续隔离。停止调用既有服务端cancel，不把关闭浏览器当取消，不宣称远程副作用回滚。供应商为重新生成，不是断点续流。失联未知受理/查无原执行给出核对指引，不自动重发。
