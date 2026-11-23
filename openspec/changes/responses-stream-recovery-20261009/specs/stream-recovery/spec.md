## ADDED Requirements

### Requirement: 有界模型恢复
系统 SHALL 对缺失完成终态的传输断流、临时连接错误和 HTTP 408/429/500/502/503/504 及明确临时failed错误码server_error/service_unavailable/rate_limit_exceeded最多重试两次当前模型请求，共享原90秒请求及整轮超时，不重放工具。

#### Scenario: 工具完成后的汇报断流
- **WHEN** 工具已完成且下一模型请求断流
- **THEN** 复用已得到的工具结果、清除旧草稿并重新请求模型，工具调用仍仅一次；每次尝试计入原模型次数和预算限制

#### Scenario: 拒绝不适合重试的错误
- **WHEN** 用户取消、身份撤销、预算不足、超过次数、非SSE、协议无效或供应商未知/非临时failed以及incomplete
- **THEN** 停止恢复并保留失败，未完成正文不保存为成功

### Requirement: 显示连接恢复
系统 SHALL 在网页流连接中断且已取得runId时，只读查询原执行最多120秒；不重新提交问题。

#### Scenario: 丢失完成帧
- **WHEN** 后端已保存成功答复而浏览器没收到done
- **THEN** 查询原执行并展示持久答复，模型和工具不新增调用

### Requirement: 平滑真实正文
系统 SHALL 按浏览器帧率有界展示已收到文字，不生成虚假增量，不拆分UTF16代理对，完成时与权威正文一致。

#### Scenario: 突发和取消
- **WHEN** 一次收到大块正文、重试清除草稿或用户离开页面
- **THEN** 突发文字分帧展示，旧队列停止；减少动效时直接批量显示，历史Markdown不重复解析
