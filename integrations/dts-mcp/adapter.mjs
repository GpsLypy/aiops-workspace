import { createHash, timingSafeEqual } from 'node:crypto';
import { createMcpExpressApp } from '@modelcontextprotocol/sdk/server/express.js';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { z } from 'zod';
import { redactText } from '../../server/security.mjs';

export const TOOL = 'dts_get_job_status';
const MAX_ID = 9223372036854775807n;
const jobId = z.string().regex(/^[1-9][0-9]{0,18}$/).refine(value => /^[1-9][0-9]{0,18}$/.test(value) && BigInt(value) <= MAX_ID, '任务 ID 超出 int64 范围');
const input = z.object({ jobid: jobId, business_domain: z.string().min(1).max(80), area_name: z.string().min(1).max(80) }).strict();
class DtsError extends Error {
  constructor(code, message) { super(message); this.code = code; }
}
const fail = (code, message) => { throw new DtsError(code, message); };
function integer(value, fallback, min, max, name) {
  const parsed = Number(value ?? fallback);
  if (!Number.isSafeInteger(parsed) || parsed < min || parsed > max) throw new Error(`${name} 配置无效`);
  return parsed;
}

export function loadConfig(env = process.env) {
  let endpoint;
  try { endpoint = new URL(env.DTS_STATUS_URL); } catch { throw new Error('请配置 DTS_STATUS_URL'); }
  if (!['https:', 'http:'].includes(endpoint.protocol) || endpoint.username || endpoint.password || endpoint.search || endpoint.hash ||
      !['/proxy/v1/jobns/getstatus', '/v1/jobns/getstatus'].includes(endpoint.pathname)) throw new Error('DTS_STATUS_URL 必须是无查询参数和凭据的固定状态接口');
  if (endpoint.protocol === 'http:' && env.DTS_ALLOW_HTTP !== 'true') throw new Error('上游 HTTP 需要显式配置 DTS_ALLOW_HTTP=true');
  const token = env.DTS_MCP_TOKEN || '';
  if (!/^[A-Za-z0-9_-]{32,256}$/.test(token)) throw new Error('DTS_MCP_TOKEN 需要至少 32 位随机 base64url 字符');
  const businessDomain = env.DTS_BUSINESS_DOMAIN || 'general';
  const areaName = env.DTS_AREA_NAME || 'cn_east';
  for (const value of [businessDomain, areaName]) if (!/^[a-zA-Z0-9_-]{1,80}$/.test(value)) throw new Error('DTS 业务域或区域配置无效');
  const jobScope = env.DTS_JOB_SCOPE ?? 'allowlist';
  if (!['allowlist', 'region'].includes(jobScope)) throw new Error('DTS_JOB_SCOPE 必须是 allowlist 或 region');
  const allowedJobIds = (env.DTS_ALLOWED_JOB_IDS || '').split(',').map(v => v.trim()).filter(Boolean);
  if ((jobScope === 'allowlist' && !allowedJobIds.length) || allowedJobIds.length > 100 || allowedJobIds.some(v => !jobId.safeParse(v).success)) throw new Error('DTS_ALLOWED_JOB_IDS 在 allowlist 模式必须列出 1 至 100 个获准任务 ID，不接受通配符');
  if (jobScope === 'region' && allowedJobIds.length) throw new Error('region 模式请清空 DTS_ALLOWED_JOB_IDS，范围由业务域和区域限定');
  const upstreamToken = env.DTS_READ_TOKEN || '';
  if (/[\r\n]/.test(upstreamToken)) throw new Error('DTS_READ_TOKEN 配置无效');
  return Object.freeze({
    endpoint: endpoint.href, token, upstreamToken, businessDomain, areaName, jobScope, allowedJobIds: Object.freeze(allowedJobIds),
    port: integer(env.DTS_MCP_PORT, 43129, 1, 65535, 'DTS_MCP_PORT'),
    timeoutMs: integer(env.DTS_TIMEOUT_MS, 8000, 100, 15000, 'DTS_TIMEOUT_MS'),
    maxBytes: integer(env.DTS_MAX_RESPONSE_BYTES, 131072, 1024, 1048576, 'DTS_MAX_RESPONSE_BYTES'),
    maxAgeSeconds: integer(env.DTS_MAX_AGE_SECONDS, 60, 1, 3600, 'DTS_MAX_AGE_SECONDS'),
  });
}

function validateInput(args, config) {
  const parsed = input.safeParse(args);
  if (!parsed.success) fail('INVALID_ARGUMENTS', '任务 ID 必须是正十进制字符串，并提供业务域和区域');
  if (args.business_domain !== config.businessDomain || args.area_name !== config.areaName || (config.jobScope !== 'region' && !config.allowedJobIds.includes(args.jobid))) {
    fail('SCOPE_DENIED', '目标任务、业务域或区域超出 DTS 授权范围');
  }
  return parsed.data;
}

async function readJson(response, maxBytes) {
  if (!/\bapplication\/(?:[a-z0-9.+-]*\+)?json\b/i.test(response.headers.get('content-type') || '')) {
    await response.body?.cancel(); fail('INVALID_RESPONSE', 'DTS 未返回 JSON 状态数据');
  }
  const reader = response.body?.getReader();
  if (!reader) fail('INVALID_RESPONSE', 'DTS 返回了空响应');
  const chunks = []; let bytes = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      bytes += value.byteLength;
      if (bytes > maxBytes) { await reader.cancel(); fail('RESPONSE_TOO_LARGE', 'DTS 状态响应超过大小限制'); }
      chunks.push(Buffer.from(value));
    }
  } finally { reader.releaseLock(); }
  try { return JSON.parse(Buffer.concat(chunks).toString('utf8')); }
  catch { fail('INVALID_RESPONSE', 'DTS 状态响应不是有效 JSON'); }
}

const runtime = z.object({
  jobID: jobId,
  time: z.number().int().positive().max(253402300799).nullish(),
  health: z.number().int().min(0).max(100).nullish(),
  paused: z.boolean().nullish(), 'manual-stopped': z.boolean().nullish(), finished: z.boolean().nullish(),
  'worker-delay-seconds': z.number().finite().nonnegative().nullish(),
  message: z.string().nullish(), tool: z.number().int().nullish(),
});

export function normalizeStatus(body, args, config, now = Date.now()) {
  if (!body || body.code !== 0) fail('DTS_BUSINESS_ERROR', 'DTS 查询未成功，未取得有效状态');
  if (typeof body.data?.status !== 'string' || !body.data.status.trim()) fail('STATUS_MISSING', 'DTS 未返回任务状态');
  let decoded;
  try { decoded = JSON.parse(body.data.status); } catch { fail('INVALID_STATUS', 'DTS 任务状态不是有效 JSON'); }
  const parsed = runtime.safeParse(decoded);
  if (!parsed.success) fail('INVALID_STATUS', 'DTS 任务状态字段不符合约定');
  const status = parsed.data;
  if (status.jobID !== args.jobid) fail('JOB_MISMATCH', 'DTS 返回的任务 ID 与查询目标不一致');
  const age = status.time == null ? null : Math.floor(now / 1000) - status.time;
  const freshness = age == null ? 'unknown' : age < -30 ? 'future' : age > config.maxAgeSeconds ? 'stale' : 'fresh';
  const complete = [status.health, status.paused, status['manual-stopped'], status.finished].every(v => v != null);
  let state = 'unknown';
  if (freshness === 'stale') state = 'stale';
  else if (freshness === 'fresh' && complete) {
    state = status.health !== 1 ? 'unhealthy' : status.finished ? 'finished' :
      status['manual-stopped'] && !status.paused ? 'unknown' : status.paused ? 'paused' : 'running';
  }
  let message = redactText(status.message || '');
  for (const secret of [config.token, config.upstreamToken].filter(Boolean)) message = message.replaceAll(secret, '[REDACTED]');
  message = message.slice(0, 1000);
  return {
    fixture: false, source: 'dts-jobns-getstatus', jobid: args.jobid,
    business_domain: args.business_domain, area_name: args.area_name,
    state, health: status.health ?? null, paused: status.paused ?? null,
    manual_stopped: status['manual-stopped'] ?? null, finished: status.finished ?? null,
    worker_delay_seconds: status['worker-delay-seconds'] ?? null, message,
    reported_at: status.time == null ? null : new Date(status.time * 1000).toISOString(),
    queried_at: new Date(now).toISOString(), freshness, age_seconds: age,
    max_age_seconds: config.maxAgeSeconds,
  };
}

export function createStatusQuery(config, { fetchImpl = fetch, now = Date.now } = {}) {
  return async args => {
    const safe = validateInput(args, config);
    const url = new URL(config.endpoint);
    for (const [key, value] of Object.entries({ ...safe, subkey: 'status' })) url.searchParams.set(key, value);
    try {
      const response = await fetchImpl(url, {
        method: 'GET', headers: { Accept: 'application/json', ...(config.upstreamToken ? { Authorization: `Bearer ${config.upstreamToken}` } : {}) },
        redirect: 'error', signal: AbortSignal.timeout(config.timeoutMs),
      });
      if (!response.ok) { await response.body?.cancel(); fail('DTS_HTTP_ERROR', `DTS 查询返回 HTTP ${response.status}，未取得有效状态`); }
      return normalizeStatus(await readJson(response, config.maxBytes), safe, config, now());
    } catch (error) {
      if (error instanceof DtsError) throw error;
      fail(error?.name === 'TimeoutError' || error?.name === 'AbortError' ? 'DTS_TIMEOUT' : 'DTS_UNAVAILABLE',
        error?.name === 'TimeoutError' || error?.name === 'AbortError' ? 'DTS 查询超时，当前状态未知' : 'DTS 接口不可达或响应中断，当前状态未知');
    }
  };
}

export function createDtsMcpApp(config, { query = createStatusQuery(config), log = event => console.log(JSON.stringify(event)) } = {}) {
  const app = createMcpExpressApp({ host: '127.0.0.1' });
  const expected = createHash('sha256').update(config.token).digest();
  app.disable('x-powered-by');
  app.get('/health', (_req, res) => res.json({ ok: true, service: 'dts-readonly-mcp', version: '1.0.0' }));
  app.use('/mcp', (req, res, next) => {
    const origin = req.get('origin');
    if (origin) {
      let allowed = false;
      try { const u = new URL(origin); allowed = ['http:', 'https:'].includes(u.protocol) && ['localhost', '127.0.0.1', '[::1]'].includes(u.hostname) && u.origin === origin; } catch { /* deny */ }
      if (!allowed) return res.status(403).json({ error: '不允许的 Origin' });
    }
    const match = /^Bearer ([A-Za-z0-9_-]{32,256})$/.exec(req.get('authorization') || '');
    if (!match || !timingSafeEqual(createHash('sha256').update(match[1]).digest(), expected)) return res.status(401).json({ error: 'MCP 认证失败' });
    next();
  });
  let active = 0;
  app.post('/mcp', async (req, res) => {
    const server = new McpServer({ name: 'dts-readonly-mcp', version: '1.0.0' });
    server.registerTool(TOOL, {
      description: `只读查询 DTS 任务实时状态。业务域仅 ${config.businessDomain}，区域仅 ${config.areaName}。jobid 必须是字符串。返回上报时间、新鲜度及原始状态标记；过期/未知不能视为当前正常。`,
      inputSchema: input,
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    }, async args => {
      try { validateInput(args, config); } catch (error) { return { isError: true, content: [{ type: 'text', text: JSON.stringify({ code: error.code, message: error.message }) }] }; }
      if (active >= 4) return { isError: true, content: [{ type: 'text', text: 'DTS 查询繁忙，请稍后重试' }] };
      active++;
      try {
        const result = await query(args);
        log({ event: 'dts.query', tool: TOOL, ...args, state: result.state, reported_at: result.reported_at, queried_at: result.queried_at });
        return { structuredContent: result, content: [{ type: 'text', text: JSON.stringify(result) }] };
      } catch (error) {
        const failure = { code: error instanceof DtsError ? error.code : 'DTS_UNAVAILABLE', message: error instanceof DtsError ? error.message : 'DTS 查询失败，当前状态未知' };
        log({ event: 'dts.query.failed', tool: TOOL, ...args, code: failure.code, queried_at: new Date().toISOString() });
        return { isError: true, content: [{ type: 'text', text: JSON.stringify(failure) }] };
      } finally { active--; }
    });
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
    res.on('close', () => { void transport.close().catch(() => {}); void server.close().catch(() => {}); });
    try { await server.connect(transport); await transport.handleRequest(req, res, req.body); }
    catch { if (!res.headersSent) res.status(500).json({ jsonrpc: '2.0', error: { code: -32603, message: 'MCP 请求失败' }, id: null }); }
  });
  app.get('/mcp', (_req, res) => res.sendStatus(405));
  app.delete('/mcp', (_req, res) => res.sendStatus(405));
  return app;
}
