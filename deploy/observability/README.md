# Collector、链路存储、多工作空间统计与模型账单对账

这套配置把现有脱敏 OTLP 出口接到真正的 OpenTelemetry Collector，再存入 Tempo；Prometheus 抓取多个**独立数据库**工作空间的现有 `/metrics`，保留 `instance`、`workspace` 标签并生成汇总规则。它不会把本项目的单实例 SQLite 变成可横向扩容的共享数据库。不要给同一数据库启动多个应用再重复计数。

应用未设置 `OTEL_EXPORTER_OTLP_TRACES_ENDPOINT` 时仍默认不导出。这套独立观测 Compose 不覆盖应用配置，不打开代码工具，不请求真实模型，不读取 `.data` 或模型密钥。

## 本机部署

要求 Docker Compose，镜像固定为 Collector 0.136.0、Prometheus v3.5.0 和 Tempo 2.8.2，并指定实际验收的镜像摘要。当前是在 Docker Desktop arm64 验证；部署另一架构时先核对该摘要在目标平台的可用性。

1. 将 `targets.example.json` 复制到受保护的部署配置目录，填入每个独立应用实际可到达的地址。每行恰好一个 `host:port`，两个标签都必须唯一；不要使用任务、用户、资源名或凭据作标签。Docker Desktop 上宿主应用可用 `host.docker.internal:PORT`。Linux 上必须验证网关能到达应用监听地址，不能把宿主 127.0.0.1 当作容器 localhost。
2. 在一个权限 `0700` 的专用目录放置 metrics-token 文件。文件本身需对容器 Prometheus UID 可读；本机验收采用专用目录 `0700`、单文件 `0644`、只挂载该文件，宿主其他用户无法进入目录。正式编排使用等效 secret 注入，勿将真实 token 放在仓库、targets 文件或命令行。所有被监控实例需有相同 `METRICS_TOKEN`；这不是模型或管理员令牌。
3. 先检查 targets，然后启动观测栈。环境变量仅指向既有文件；以下路径为占位示例：

```sh
node scripts/check-observability-targets.mjs --targets /absolute/deployment/targets.json
METRICS_TOKEN_FILE=/absolute/private/metrics-token OBSERVABILITY_TARGETS_FILE=/absolute/deployment/targets.json docker compose -f deploy/observability/compose.yaml config --quiet
METRICS_TOKEN_FILE=/absolute/private/metrics-token OBSERVABILITY_TARGETS_FILE=/absolute/deployment/targets.json docker compose -f deploy/observability/compose.yaml up -d
```

应用部署显式设置 `OTEL_EXPORTER_OTLP_TRACES_ENDPOINT=http://127.0.0.1:4318/v1/traces` 才会导出。应用在另一容器时需加入共享私有网络并使用实际 Collector 地址；不能使用容器自身的 127.0.0.1。生产目的地必须加入应用已有 `OUTBOUND_ALLOWED_ORIGINS`，内部 HTTP 还需相应 `OUTBOUND_PRIVATE_ORIGINS` / `OUTBOUND_HTTP_ORIGINS`。`OTEL_PROPAGATE=true` 可单独启用现有 `traceparent` 传播。配置和网络授权由部署者明确提供。

默认入口均只绑定宿主 loopback：Collector `4318`、Tempo `3200`、Prometheus `9090`。它们没有公网认证入口。跨主机正式部署需要相应 TLS/认证和网络控制，不能直接公开这三个端口。端口可用 `OTLP_HTTP_PORT`、`TEMPO_HTTP_PORT`、`PROMETHEUS_HTTP_PORT` 调整。Collector 内存限额、有限队列/重试和 batch 防止持续堆积；没有 debug exporter，不打印原 trace 内容。

Tempo 用命名卷保存 WAL 和块，保留 7 天；Prometheus 命名卷保留 15 天。正式环境应单独验收磁盘、留存、访问权限、备份恢复和容量。Collector 重试是遥测重试，不重放业务工具；停 Collector 不阻断问答。停止栈用相同环境变量执行 `docker compose -f deploy/observability/compose.yaml down`；该命令保留数据卷，不应对正式栈使用验收脚本的 `--volumes` 清理选项。

## 查看统计

现在可在「AgentScope 入门 → 部署与验收」看到这三项服务各自用途、当前本机连接检查、已有验收项目与测量时间。统计入口、查询表达式和内存账单导入/演示/对账/结果下载在同一页，不必先手工读JSON报告。Collector入口响应与链路实际验收分开显示。页面上传每文件最多400 KiB，CLI仍为8 MiB；两种入口的JSON金额均必须是十进制字符串，拒绝JSON数值以避免丢失精度。

打开 `http://localhost:9090`，可查询：

| 查询 | 含义 |
| --- | --- |
| `aiops_agent_trace_duration_seconds_count{stage="run"}` | 每个工作空间的实际完成轮次；进程重启清零 |
| `aiops:fleet_stage_completions_total{stage="run"}` | 当前进程生命周期的多工作空间完成轮次和 |
| `aiops:fleet_stage_p95_seconds:rate5m` | 先按阶段合并直方图桶再估计五分钟 P95，不能平均各实例 P95 |
| `aiops:fleet_outcomes:rate5m` | 按固定结果分类的完成率 |
| `aiops:fleet_otlp_exports:rate5m` | 应用出口发送、失败、丢弃和采样跳过率 |
| `aiops:workspace_model_estimated_cost_total` | 保留工作空间维度的配置单价估算，不是供应商账单；没有跨币种费用总和 |

Prometheus 的 `rate` 处理单进程计数器重置；计数器原始值是当前进程状态，不是长期累计总量。独立实例只可使用各自数据库，否则持久 token 总数会重复计算。Tempo 可用 `GET http://localhost:3200/api/traces/TRACE_ID` 查回已知 trace；应用导出只包含固定 service、阶段、结果、时间和关联 ID。

## 可复现验收

```sh
node scripts/accept-observability.mjs --out test-results/observability/new-acceptance.json
node --test tests/observability-stack.test.mjs tests/model-billing.test.mjs
```

验收使用新的临时 Compose 项目和卷、两套隔离临时应用数据库、真实锁定 AgentScope SDK、本机受控模型/MCP。原工作空间不参与。它验证 `/metrics` 的无 token/错 token 401、正确 token 200，3 条实际应用 trace / 15 个脱敏 span 经 Collector 存储到 Tempo，两个实例各完成 1/2 轮、汇总 3 轮和 180 个受控 tokens，幂等无重复请求，Tempo 重启恢复、Collector 停机故障隔离和独立临时资源清理。报告排他写入、权限 `0600`；已有报告不能覆盖。脚本需要三个镜像已在本机，`up --pull never` 不下载或替换镜像。

2026-10-08 的实际报告：[acceptance-20261008-first.json](../../test-results/observability/acceptance-20261008-first.json)，上述检查全部通过。7 项 Node 专项通过。本地合成链路和 Docker 存储验证已经完成；没有提供外部生产采集器或供应商账单，报告保持 `productionAccepted=false`、`realBillingUsed=false`。

## 当前工作空间的本机部署

用户选择本机部署后，已启动持久项目 `aiops-observability-local`，三个容器继续运行：Collector 在 `127.0.0.1:4318`、Tempo 在 `127.0.0.1:3200`、Prometheus 在 `127.0.0.1:9090`。此工作空间通过单独的 `.env.observability.local`（`0600`、Git 忽略）显式启用本机出口和传播；原 `.env`、`.data` 及代码默认出口行为未变。

私有生成文件位于 `test-results/observability/local/`（目录 `0700`），包含 metrics-token、唯一 `local-workspace` targets、Compose 路径配置及恢复命令。真实应用只抓取 `host.docker.internal:3001`；没有把同一 SQLite 工作空间重复启动后统计。应用无/错 token 均为 401，生成 token 为 200，Prometheus `up{job="aiops",instance="local-workspace"}=1`；三个服务实际就绪。此部署核查未发送聊天或模型请求。

[当前状态](../../test-results/observability/local/status.json) 可更新，[启用验收快照](../../test-results/observability/local/activation-20261008.json) 保留当次检查。恢复服务及应用：

```sh
docker compose --env-file test-results/observability/local/compose.env -p aiops-observability-local -f deploy/observability/compose.yaml up -d --pull never
node --env-file=.env.observability.local scripts/dev.mjs
```

停止观测栈且保留现有数据卷：

```sh
docker compose --env-file test-results/observability/local/compose.env -p aiops-observability-local -f deploy/observability/compose.yaml down
```

后续正常完成的问答可存入本机 Tempo。外部生产采集器和真实供应商账单不属于用户选择的当前本机阶段，不作为继续开发的前置条件。

## 供应商账单导入与对账

使用真实供应商账户导出的明细，先在账户侧或受控本地工具中标准化为允许字段；不要把原始发票中的账户、凭据、提示词或其他个人字段直接加进输入。当前 CLI 不连接供应商账户，不自动验证文件来源。没有真实输入时不会生成发票或声称真实费用已验收。

```sh
node scripts/reconcile-model-billing.mjs --usage /private/usage.csv --invoice /private/vendor.csv --out /private/new-reconciliation.json
```

两种文件均接受 CSV 或 JSON。JSON 顶层严格为 `{"schemaVersion":1,"kind":"usage"或"invoice","records":[...]}`。CSV 必须有唯一列名，支持标准引号/双引号转义；文件上限 8 MiB，1 至 100000 条，所有额外字段都拒绝。日期为真实 UTC 日，币种为三位大写代码，金额为最多六位小数的十进制字符串，tokens 为非负安全整数。

| 输入 | 必需列 | 可选列 |
| --- | --- | --- |
| usage | `date,provider,model,currency,tokens,tokenSource,estimatedCost` | 无 |
| invoice | `date,provider,model,currency,billedCost,category` | `tokens` |

`tokenSource` 必须为 `reported`、`estimated` 或 `unknown`，表示本地输入对 tokens 来源的声明；现有 execution 聚合中可能含预算估值，不可未经核实就标为 `reported`。`estimatedCost` 始终表示配置/调用台账的估算。`category` 为 `usage`（非负用量费）、`credit`（负数抵扣）或 `other`（其他有正负的费用/调整）；抵扣和其他费用单独保留，不拿它们去填用量差额。

以下仅是格式示例，不是真实账单：

```csv
date,provider,model,currency,tokens,tokenSource,estimatedCost
2026-10-08,example,example-model,USD,30,reported,0.100001
```

```csv
date,provider,model,currency,tokens,billedCost,category
2026-10-08,example,example-model,USD,30,0.100001,usage
```

对账键为 UTC 日/provider/model/currency，分别聚合输入后报告 `matched`、`difference`、`usage_only`、`invoice_only`，保留供应商费用减估算费用、供应商 tokens 减本地 tokens 的差值。缺少供应商 tokens 或本地为估计/未知 tokens 时，`tokensMatch=false`，不能静默通过。金额用 BigInt 百万分货币累计，无二进制浮点误差；币种不相加、不换汇。输入 SHA256 绑定原文件，输出权限 `0600`、排他写入。退出码：费用/tokens 和覆盖完全匹配为 0，有差额/未匹配/未核实 tokens 为 2，非法输入或已有输出为 1。

这完成账单导入与工程对账能力，不证明供应商文件真实性、具体请求级结算、缓存 token 定价、税费、真实费用预算或生产批准。报告明确 `invoiceSource=user_supplied_unverified`、`providerAccountVerified=false` 和 `productionAccepted=false`。
