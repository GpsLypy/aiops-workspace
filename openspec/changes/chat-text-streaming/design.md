# 设计

1. 普通运行时请求模型时启用 stream:true；Chat Completions 请求 stream_options.include_usage。Node 有界解析 SSE（跨 UTF-8 块、CRLF、注释、多行 data），只向外发正文/refusal 增量，保留完整消息、工具参数和用量给原运行时。Responses 以 response.completed 的完整输出作为权威结果，保留加密 reasoning 续传。没有有效终态或上游失败时拒绝半截结果。
2. 模型服务明确返回 JSON 时兼容原完整结果，不自动重试请求。非流式模型测试与独立复核继续兼容。Python ModelBridge 仍只接收完整消息；文本事件由 Node 直接转发，不修改 cold/prefork 协议。
3. 每次模型调用的 message_start 带 streamId；message_delta 追加文本；发现工具调用时 message_reset 撤下暂显正文，后续只显示工具进度。工具参数、推理增量和复核 JSON 不公开。done 给出已保存的最终文本/metadata，error 撤下未完成文本。草稿不写数据库、不用于证据判断。
4. 独立复核不发布分析草稿与复核增量；保持 accepted 后才展示的门禁。审批计划通过原 done 发布。
5. React 复用现有消息样式：正文自然随块增长，具名生成状态与轻量光标，减少动态效果偏好关闭光标动画。不增加人工打字延迟；只有用户仍在底部时跟随滚动。完成后回读会话，避免重复消息；中断清理草稿并显示错误，保留执行中心核对入口，不自动重放。

验证用可控 SSE 分段服务器和真实 AgentScope SDK，确认首段在服务端结束前到达；覆盖两个上游协议、工具往返、中文拆包、失败/取消、JSON 回退、复核隔离、刷新和移动布局。另用已授权模型验证实际分段到达。官方文档两个域本次均返回 HTTP 403，协议以明确事件契约与测试校验，不声称覆盖所有兼容网关。
