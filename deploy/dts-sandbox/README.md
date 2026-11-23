# DTS MCP 独立沙箱

新手步骤、现场地址和恢复边界见 [DTS 独立沙箱部署](../../docs/dts-sandbox.md)。只部署现有 Node 只读适配器，不安装 DTS 后端、Python、应用 SQLite 或模型配置。

独立项目 `dts-mcp-sandbox-20261009`，持久实例 `sbx-example`；MCP 固定沙箱内 `127.0.0.1:43129`。跨实例使用 SSH 转发，客户端地址为自己的 `127.0.0.1:43130/mcp`；IP 可能随平台生命周期变化。

最小锁文件由根锁文件已安装版本生成，MCP SDK 1.30.0、Express 5.2.1、Zod 3.25.76。打包脚本只取明确源码，配置/密钥单独以0600保存。

```sh
# 本机项目根目录：输出路径必须不存在
node scripts/dts-sandbox-package.mjs /absolute/new-source.tar.gz
# 独立 DTS 沙箱：源码放在 /home，持久配置放在 /workspace
cd /home/sandbox/dts-mcp
npm ci --ignore-scripts --no-audit --no-fund
node deploy/dts-sandbox/service.mjs start
node deploy/dts-sandbox/service.mjs status
# 确认确实要停止本服务后使用
node deploy/dts-sandbox/service.mjs stop
```

`service.mjs` 校验Linux UID1000、Node>=22.16、私有配置、PID归属；只监督自己的适配器子进程。主supervisor被停止或平台实例重建后仍须显式启动，不宣称平台常驻恢复已验收。

`tunnel.mjs PRIVATE_JSON` 是前台 SSH 监督器，私有JSON只接受host/keyFile/knownHostsFile/localPort，端口43130或43131。服务端使用受限SSH公钥，禁止Shell且只允许转发到127.0.0.1:43129；禁止远程转发到业务端口。必须使用固定known_hosts，不关闭主机校验。Tunnel supervisor退出/平台重建需要重新启动。

`probe.mjs PRIVATE_JSON NEW_REPORT` 通过真实SDK核对健康、鉴权、Host/Origin、唯一工具、DTS实时查询、跨区域与数字ID拒绝。私有JSON仅含endpoint/token/jobid；报告排他写入，不包含Token。Host探针使用原生HTTP，避免Node fetch重写Host产生错误结论。
