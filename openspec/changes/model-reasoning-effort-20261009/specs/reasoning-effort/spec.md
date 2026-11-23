## ADDED Requirements

### Requirement: 可访问的三档问答强度
系统 SHALL 提供快速 low、均衡 medium、深度 high 的描述菜单，标明选中项和已配置系统默认，支持恢复默认、键盘和320px布局。

#### Scenario: 选择与生成
- **WHEN** 用户选择深度并发问
- **THEN** 入口显示深度，运行时禁用选择，当前轮请求使用 high，刷新后回答仍记录 high

### Requirement: 统一模型请求强度
系统 SHALL 以 model_reasoning_effort 保存模型默认，映射到 Responses reasoning.effort，执行开始固定有效值供本轮所有模型调用复用。

#### Scenario: 工具和独立复核
- **WHEN** high 请求经工具往返或独立复核且管理员中途更改默认
- **THEN** 当轮全部模型请求仍使用 high，下一轮继承新的默认

#### Scenario: 兼容服务商默认
- **WHEN** 旧配置缺失字段或用户显式提交 null
- **THEN** 不发送 reasoning 参数，非法档位返回400；同幂等键改变档位返回409且不重放执行
