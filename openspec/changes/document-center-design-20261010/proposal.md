# Proposal

## Why

文档中心默认打开长文，宽侧栏同时展示长标题、路径、分类和搜索，目录抢占阅读空间。用户提供卡片式文档门户参考，要求改善布局与展示。

## What Changes

- `#documents` 改为文档首页，以深蓝标题/搜索、三类阅读入口和按真实目录分组的文档卡片帮助选择。
- `#documents?file=...` 保留直接阅读与刷新；阅读页提供返回全部文档、精简可折叠目录与宽屏本页章节。
- 搜索仍覆盖标题、路径和正文，分类与搜索共同生效；卡片摘要来自原文，不添加虚构状态标签。
- 浏览器前进/后退恢复首页与阅读选择；移动阅读默认收起目录，保持正文优先。
- 管理员编辑、下载、版本冲突/回退、保存锁和未保存保护沿用既有流程，包括返回首页。

## Capabilities

### New Capabilities

- `document-center-design`: 分类卡片首页与专注阅读布局。

### Modified Capabilities

无归档主规范变更。

## Impact

DocumentCenter.tsx、document-center.css、现有浏览器验收与文档。无新增依赖、API、数据库字段或远程部署。
