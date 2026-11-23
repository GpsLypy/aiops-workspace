import { open, realpath } from 'node:fs/promises';
import { constants } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { z } from 'zod';
import { admin } from './auth.mjs';
import { production } from './security.mjs';
import { normalizeBillingRecords, parseBillingCsv, reconcileBilling } from '../scripts/model-billing.mjs';

const services = [
  { id: 'collector', label: 'Collector 链路采集器', endpoint: 'http://127.0.0.1:4318/v1/traces', expectedStatus: 405 },
  { id: 'tempo', label: 'Tempo 链路存储', endpoint: 'http://127.0.0.1:3200/ready', expectedStatus: 200 },
  { id: 'prometheus', label: 'Prometheus 指标监控', endpoint: 'http://127.0.0.1:9090/-/ready', expectedStatus: 200 },
  { id: 'sandbox', label: '沙箱 MCP 入口', endpoint: 'http://127.0.0.1:43130/health', expectedStatus: 200 },
];
const reports = Object.freeze({
  observabilityDeployment: fileURLToPath(new URL('../test-results/observability/local/status.json', import.meta.url)),
  observabilityEvidence: fileURLToPath(new URL('../test-results/observability/acceptance-20261008-first.json', import.meta.url)),
  sandboxDeployment: fileURLToPath(new URL('../test-results/agent-sandbox/local/deployment-report.json', import.meta.url)),
  sandboxEvidence: fileURLToPath(new URL('../test-results/agentscope/sandbox-service-acceptance-20261008-v5.json', import.meta.url)),
});
const maxReportBytes = 512 * 1024;
const probeTimeoutMs = 1800;
const emptyEvidence = () => ({ measuredAt: null, passed: null, checks: [] });
const timestamp = value => {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value)) return null;
  const time = Date.parse(value);
  return Number.isFinite(time) && time <= Date.now() && new Date(time).toISOString() === value ? value : null;
};

// Internal reader is exported for filesystem boundary tests; routes never accept a path.
export async function readProtectedLocalReport(path) {
  let file;
  try {
    // Both the filename and its parent chain must resolve to the fixed repository path.
    if (await realpath(path) !== path) return null;
    file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    const stat = await file.stat();
    if (!stat.isFile() || stat.size > maxReportBytes || (stat.mode & 0o022)) return null;
    const buffer = Buffer.alloc(maxReportBytes + 1);
    const { bytesRead } = await file.read(buffer, 0, buffer.length, 0);
    if (bytesRead > maxReportBytes) return null;
    return JSON.parse(buffer.subarray(0, bytesRead).toString('utf8'));
  } catch { return null; }
  finally { await file?.close().catch(() => {}); }
}

async function readReport(key) {
  const path = reports[key];
  return path ? readProtectedLocalReport(path) : null;
}

// Tests may inject an HTTP transport, while the destination remains fixed by service id.
export async function probeLocalService(id, signal, request = fetch) {
  const service = services.find(value => value.id === id);
  if (!service) throw new Error('Unknown local service');
  const response = await request(service.endpoint, { method: 'GET', redirect: 'error', signal });
  try {
    if (id !== 'sandbox' || response.status !== 200) return { status: response.status };
    const reader = response.body?.getReader();
    if (!reader) return { status: response.status, body: null };
    const chunks = []; let length = 0;
    try {
      while (true) {
        const result = await reader.read();
        if (result.done) break;
        length += result.value.length;
        if (length > 2048) return { status: response.status, body: null };
        chunks.push(result.value);
      }
    } finally { await reader.cancel().catch(() => {}); }
    let body;
    try { body = JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { body = null; }
    return { status: response.status, body };
  } finally { await response.body?.cancel().catch(() => {}); }
}

function observabilityConfigured(report) {
  return report?.schemaVersion === 1 && report.project === 'aiops-observability-local' && report.persistent === true &&
    !!timestamp(report.generatedAt) && services.filter(service => service.id !== 'sandbox').every(service =>
      report.services?.[service.id]?.url === service.endpoint && report.services[service.id].expectedStatus === service.expectedStatus);
}
function sandboxConfigured(report) {
  return !!timestamp(report?.measuredAt) && report.configurationPrivate === true && report.mcp?.endpoint === 'http://127.0.0.1:43130/mcp' &&
    typeof report.mcp.healthStatus === 'number';
}

function observabilityEvidence(report) {
  if (report?.schemaVersion !== 1 || !timestamp(report.finishedAt) || typeof report.passed !== 'boolean' || !report.checks || typeof report.checks !== 'object') return emptyEvidence();
  const checks = report.checks;
  const results = [
    { label: '指标访问需要授权', passed: Array.isArray(checks.protectedMetrics) && checks.protectedMetrics.length === 2 && checks.protectedMetrics.every(value => value === true) },
    { label: '链路经 Collector 存入 Tempo', passed: checks.persistedRedactedTraces?.traces === 3 && checks.persistedRedactedTraces.spans === 15 && checks.persistedRedactedTraces.idempotent === true },
    { label: '两个独立实例正确汇总', passed: checks.multiInstanceMetrics?.instances === 2 && Array.isArray(checks.multiInstanceMetrics.runCounts) &&
      checks.multiInstanceMetrics.runCounts.length === 2 && checks.multiInstanceMetrics.runCounts.includes(1) && checks.multiInstanceMetrics.runCounts.includes(2) && checks.multiInstanceMetrics.fleetRuns === 3 && checks.multiInstanceMetrics.fixtureTokens === 180 },
    { label: '链路存储重启后恢复', passed: checks.traceBackendRestartRecovery === true },
    { label: '采集器故障不阻断问答', passed: checks.collectorFailureIsolated === true },
    { label: '临时验收资源已回收', passed: checks.temporaryStackRemoved === true },
  ];
  return { measuredAt: report.finishedAt, passed: report.passed && results.every(check => check.passed), checks: results };
}

const sandboxChecks = [
  ['authentication-and-fixed-request-policy', '身份校验与固定执行策略', row => row.unauthorized === 401 && row.isolationOverride === 400],
  ['real-isolation-quarantine-ownership-and-admin-approval', '文件、网络隔离与独立产物审批', row => row.cleanupVerified === true && row.deniedUntilApproved === true &&
    ['appVisible', 'dataVisible', 'secretVisible', 'dockerSocketVisible', 'rootWritable', 'shmWritable', 'network', 'residueVisible'].every(key => row.snapshot?.[key] === false) && row.snapshot?.workWritable === true],
  ['new-job-has-no-prior-work-disk', '每次任务使用独立临时盘', row => row.residueVisible === false && row.cleanupVerified === true],
  ['active-content-stays-blocked', '主动内容保持阻断', row => row.blocked === true && row.cleanupVerified === true],
  ['stdout-quota', '标准输出配额', row => row.status === 'failed' && row.error === 'output_quota' && row.cleanupVerified === true],
  ['artifact-quota', '产物配额', row => row.status === 'failed' && row.error === 'unsafe_artifact' && row.cleanupVerified === true],
  ['symbolic-artifact', '符号链接产物拒绝', row => row.status === 'failed' && row.error === 'unsafe_artifact' && row.cleanupVerified === true],
  ['running-cancellation-kills-container', '取消任务并回收容器', row => row.startedRunning === true && row.status === 'cancelled' && row.cleanupVerified === true],
  ['wall-timeout-kills-container', '超时任务并回收容器', row => row.status === 'timed_out' && row.cleanupVerified === true],
  ['real-mcp-sdk-only-exposes-write-execute-and-read-state', '代码执行受固定写审批治理', row => row.toolCount === 2 && row.executeRequiresWriteGovernance === true && row.artifactContentAbsent === true &&
    row.sdkCancellation === 'cancelled' && row.productApprovalVerified === true && row.noJobBeforeApproval === true && row.fixedSourceTamperDenied === 409 && row.independentApprover === true && row.persistedWriteVerification === true && row.artifactDecisionAfterProductApproval === 'pending'],
  ['explicit-delete-recycles-quarantined-bytes', '删除后回收隔离产物', row => row.status === 'deleted' && row.artifactsRemaining === 0],
];
function sandboxEvidence(report) {
  if (report?.version !== 1 || !timestamp(report.measuredAt) || typeof report.passed !== 'boolean' || !Array.isArray(report.checks)) return emptyEvidence();
  const results = sandboxChecks.map(([id, label, validate]) => {
    const matches = report.checks.filter(row => row?.label === id);
    return { label, passed: matches.length === 1 && matches[0].passed === true && validate(matches[0]) };
  });
  return { measuredAt: report.measuredAt, passed: report.passed && report.cleanupVerified === true && results.every(check => check.passed), checks: results };
}

export function createLocalServices(options = {}) {
  const load = options.readReport ?? readReport;
  const check = options.probe ?? ((id, signal) => probeLocalService(id, signal));
  async function inspect() {
    const baseline = { checkedAt: new Date().toISOString(), services: [], evidence: { observability: emptyEvidence(), sandbox: emptyEvidence() }, billing: { available: true, realInvoiceLoaded: false } };
    const permitted = options.enabled === true || options.enabled !== false && !production();
    if (!permitted) {
      baseline.services = services.map(service => ({ id: service.id, label: service.label, status: 'unconfigured', message: '未启用本机部署检查', endpoint: null }));
      return baseline;
    }
    const values = await Promise.all(Object.keys(reports).map(async key => { try { return await load(key); } catch { return null; } }));
    const loaded = Object.fromEntries(Object.keys(reports).map((key, index) => [key, values[index]]));
    baseline.evidence = { observability: observabilityEvidence(loaded.observabilityEvidence), sandbox: sandboxEvidence(loaded.sandboxEvidence) };
    const configured = { observability: options.enabled === true || observabilityConfigured(loaded.observabilityDeployment), sandbox: options.enabled === true || sandboxConfigured(loaded.sandboxDeployment) };
    baseline.services = await Promise.all(services.map(async service => {
      if (!configured[service.id === 'sandbox' ? 'sandbox' : 'observability']) return { id: service.id, label: service.label, status: 'unconfigured', message: '未发现已配置的本机部署', endpoint: null };
      const controller = new AbortController();
      let timeout;
      const expired = new Promise((_, reject) => { timeout = setTimeout(() => { controller.abort(); reject(new Error('Local health check timed out')); }, probeTimeoutMs); });
      let online = false;
      try {
        const response = await Promise.race([Promise.resolve().then(() => check(service.id, controller.signal)), expired]);
        online = response?.status === service.expectedStatus && (service.id !== 'sandbox' || response.body?.ok === true);
      } catch { /* Private details from filesystem, network or response body never reach the API. */ }
      finally { clearTimeout(timeout); controller.abort(); }
      return { id: service.id, label: service.label, status: online ? 'online' : 'offline',
        message: online ? service.id === 'sandbox' ? 'MCP 入口可达，执行后端未在此检查' : '本机服务可达' : '本机服务暂不可达，请检查是否已启动', endpoint: service.endpoint };
    }));
    baseline.checkedAt = new Date().toISOString();
    return baseline;
  }
  return { inspect };
}

const uploaded = z.object({ filename: z.string().regex(/^[^/\\:\u0000-\u001f\u007f]{1,120}\.(csv|json)$/i), content: z.string().refine(value => Buffer.byteLength(value, 'utf8') <= 400 * 1024) }).strict();
const billingUpload = z.object({ usage: uploaded, invoice: uploaded }).strict();
function parseUpload(input, kind) {
  let records;
  if (input.filename.toLowerCase().endsWith('.csv')) records = parseBillingCsv(input.content);
  else {
    const envelope = z.object({ schemaVersion: z.literal(1), kind: z.literal(kind), records: z.array(z.unknown()) }).strict().parse(JSON.parse(input.content));
    records = envelope.records;
  }
  return { records: normalizeBillingRecords(records, kind), sha256: createHash('sha256').update(input.content).digest('hex') };
}

export function localServicesRoutes(app, options = {}) {
  const service = createLocalServices(options);
  app.get('/api/local-services', admin, async (req, res) => {
    if (Object.keys(req.query).length || req.body && Object.keys(req.body).length) return res.status(400).json({ error: '本机状态检查不接受地址或文件参数' });
    res.json(await service.inspect());
  });
  app.post('/api/local-services/billing', admin, (req, res) => {
    try {
      if (Object.keys(req.query).length) throw new Error('Unexpected input');
      const input = billingUpload.parse(req.body);
      const usage = parseUpload(input.usage, 'usage'), invoice = parseUpload(input.invoice, 'invoice');
      res.json(reconcileBilling(usage.records, invoice.records, { usageSha256: usage.sha256, invoiceSha256: invoice.sha256 }));
    } catch { res.status(400).json({ error: '账单文件格式或字段无效：请选择不超过 400 KiB 的 CSV/JSON，并按示例填写用量与账单字段' }); }
  });
}
