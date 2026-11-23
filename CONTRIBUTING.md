# 贡献指南

欢迎通过 Issue 说明问题或提出 Pull Request。请提供复现步骤、预期与实际结果、Node/Python 版本及脱敏日志。

## 开发

需要 Node.js >=22.16、Python 3.12 和 uv。先读 `codemap.md`、相关目录地图与 `agent.md`。

```sh
npm ci
uv sync --project agent-worker --frozen
npm run agent:check
npm run dev
```

行为调整需同步测试、相关文档与 `docs/verification.md`，并运行：

```sh
npm test
npm run build
npm run docs:build
npm run docs:check
```

测试只使用受控夹具与临时数据；未经授权不要连接真实模型、运维平台或发送通知。不要提交 `.env`、Token、私钥、数据库、原始会话或真实平台地址。提交代码表示你有权以项目 MIT License 提供该贡献。

发布前可运行 `gitleaks git . --redact` 扫描已提交历史；`.gitleaks.toml` 仅豁免两个经过复核的示例值，不豁免真实凭据。依赖审计运行 `npm audit`；已有告警与验证范围见 `docs/verification.md`。
