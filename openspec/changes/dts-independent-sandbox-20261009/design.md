# 设计

助手客户端 → SSH 本地转发 → 独立 DTS 沙箱内 127.0.0.1:43129/mcp → 既有 DTS REST。

保持适配器、固定 GET、Host/Origin 校验与 Token 鉴权不变。最小包仅含适配器、共享脱敏模块、管理与探针脚本和锁文件。源码位于 /home/sandbox/dts-mcp，服务配置/日志在 /workspace/dts-mcp-service；Linux supervisor 只重启本服务子进程，stop 先验证 /proc PID 身份。Node24 满足适配器 >=22.16 要求，单独服务无 SQLite/Python 依赖。

本阶段不将临时 Pod IP 认定为稳定地址、不把持久工作区配置当作平台重建验收。应用原 PoC 禁止 MCP；独立客户端验证不能代替网页 Agent 验收。

模型出口统一为 /responses，store:false 与reasoning.encrypted_content续传保留。前端不展示无意义的单项协议选择，沿用原表单视觉与键盘顺序，明确固定Responses和API前缀。MODEL_TEMPERATURE=none仅在无保存设置时省略温度；DTS专用启动入口默认4096/none并先检查SSH通道。旧模型设置读取归一、保存新配置只允许responses；不自动改写既有数据。

后续用户明确要求仅SSE，移除完整JSON分支及流式开关。聊天、连接测试与复核均固定stream:true；媒体类型非text/event-stream立即取消并报错，合法response.completed才完成。保留复核发布门禁，不自动重试工具。此前完整JSON成功属于历史证据，供应商SSE仍须独立验收。
