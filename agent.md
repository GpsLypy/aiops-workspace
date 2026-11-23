# 功能与文档同步规则

本文件适用于仓库内所有功能开发、行为调整、缺陷修复和破坏性变更。开始工作前先阅读根目录 `codemap.md`、相关目录的 `codemap.md`，以及官网验证章节的源文件 `docs/verification.md`。

## 必须同步的内容

- 新增功能时，同步更新描述该能力、流程、接口、配置、权限、数据结构、限制和验证方式的 Markdown 文档。
- 调整或删除现有功能时，先对照 `docs/site/index.html#verification` 和 `docs/verification.md` 中已有的验证结论，再修改实现；同步修正所有失效的说明、示例、测试数量、验证结果和限制。
- 缺陷修复改变外部可观察行为时，按功能调整处理，不能只修改代码或测试。
- 修改架构、目录职责、入口或调用链时，同步更新根目录或相应目录的 `codemap.md`。
- 不直接手工维护 `docs/site/index.html`。它是生成物，应修改 `docs/*.md`、各级 `codemap.md` 或 `docs/web/` 中的源文件后重新生成。

## 每次变更的完成标准

1. 根据改动范围运行相应测试；功能或共享行为变更默认至少运行 `npm test` 和 `npm run build`。
2. 在 `docs/verification.md` 更新本次变更对应的验证范围、可复现命令、实际结果和未验证边界，不保留已经失真的历史结论。
3. 运行 `npm run docs:build`，将文档源文件同步到 `docs/site/index.html`。
4. 运行 `npm run docs:check`，确认生成结果、链接、锚点和本地资源一致。
5. 若命令因环境或外部依赖无法执行，在 `docs/verification.md` 和最终交付说明中明确记录未验证项及原因。

代码、测试、Markdown 源文件和生成后的离线官网必须描述同一套当前行为。上述同步或验证未完成时，不得将变更标记为完成。
