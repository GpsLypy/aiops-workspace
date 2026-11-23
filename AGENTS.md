## Repository Map

A full codemap is available at `codemap.md` in the project root.

Before working on the repository, read it for architecture, entry points, directory responsibilities, data flow, and module integration. Read the relevant directory's `codemap.md` for deeper work.

The mandatory feature and documentation synchronization workflow is defined in `agent.md`. Read and follow it before changing behavior. A feature addition, behavior adjustment, bug fix with observable behavior changes, or breaking change is not complete until the relevant documentation and `docs/verification.md` are updated and the offline documentation site is rebuilt and checked.

Beginner documentation lives in `docs/README.md`. The offline documentation website is `docs/site/index.html`, generated from Markdown and `docs/web/` by `npm run docs:build`. After changing documentation, run `npm run docs:check` to verify freshness and links. The standalone architecture viewer has its own source at `docs/diagrams/architecture.json`.

## DTS 运维系统接入

当设计或实现 DTS 运维系统接入时，必须先读取 [integrations/dts-mcp/HANDOFF.md](integrations/dts-mcp/HANDOFF.md)，按交接流程开展后续 MCP 设计和实现。
