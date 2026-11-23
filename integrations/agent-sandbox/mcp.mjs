import { createHash, randomUUID, timingSafeEqual } from 'node:crypto';
import { lstatSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import { createMcpExpressApp } from '@modelcontextprotocol/sdk/server/express.js';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { z } from 'zod';
import { brokerRequest } from './client.mjs';
import { digest, limits } from './policy.mjs';

const terminal = new Set(['completed', 'failed', 'cancelled', 'timed_out', 'unknown', 'expired', 'deleted']);
const identifier = z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,63}$/);
export async function cancelSandboxSubmission(client, args, job, requestBroker = brokerRequest) {
  const candidate = job || await requestBroker(client, 'GET', `/v1/jobs/by-step/${args.runId}/${args.stepId}`);
  // A cancelled request can have conflicted with a prior job under these labels.
  // Never cancel that prior job while recovering an ambiguous submit response.
  if (candidate.jobId !== args.jobId || candidate.runId !== args.runId || candidate.stepId !== args.stepId
    || candidate.sourceSha256 !== digest(args.source)) return false;
  await requestBroker(client, 'POST', `/v1/jobs/${candidate.id}/cancel`);
  return true;
}
export function createSandboxMcpApp(config, requestBroker = brokerRequest) {
  const sessionTtlMs = config.sessionTtlMs ?? 60000;
  if (!config.socketPath || !/^[a-zA-Z0-9_-]{32,128}$/.test(config.brokerToken || '')
    || !/^[a-zA-Z0-9_-]{32,128}$/.test(config.mcpToken || '') || config.brokerToken === config.mcpToken
    || !Number.isSafeInteger(sessionTtlMs) || sessionTtlMs < 100 || sessionTtlMs > 60000) throw new Error('Invalid sandbox MCP configuration');
  const app = createMcpExpressApp({ host: '127.0.0.1' }); app.disable('x-powered-by');
  const expected = createHash('sha256').update(config.mcpToken).digest();
  const client = { socketPath: config.socketPath, token: config.brokerToken };
  app.get('/health', (_req, res) => res.json({ ok: true, service: 'sandbox-mcp', productionSecurityAccepted: false }));
  app.use('/mcp', (req, res, next) => {
    if (req.headers.origin !== undefined) return res.status(403).json({ error: 'browser_origin_denied' });
    const match = /^Bearer ([a-zA-Z0-9_-]{32,128})$/.exec(req.headers.authorization || '');
    if (!match || !timingSafeEqual(createHash('sha256').update(match[1]).digest(), expected)) return res.status(401).json({ error: 'unauthorized' });
    next();
  });
  let active = 0;
  const sessions = new Map(); const allocated = new Set();
  async function createSession() {
    if (allocated.size >= 16) throw new Error('Session quota');
    const entry = { requests: new Map(), id: null, timer: null }; allocated.add(entry);
    const server = new McpServer({ name: 'sandbox-python-mcp', version: '1.0.0' });
    entry.server = server;
    server.registerTool('sandbox_execute_python', {
      description: '在本机独立 Docker 沙箱执行 Python 3.12 源码（64KiB、禁网、只读根、10秒）。有副作用，应用必须配置risk=write、runId/stepId精确范围、jobId幂等参数与按相同标签只读核验，并审批固定源码。仅返回状态和隔离产物描述；产物需独立broker管理员批准后才能下载。关联标签不证明业务身份。Python将文件写到/work/output，仅允许txt/json/csv。',
      inputSchema: { jobId: identifier, runId: identifier, stepId: identifier, source: z.string().min(1).max(limits.sourceBytes) },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    }, async (args, extra) => {
      if (active >= 4 || Buffer.byteLength(args.source) > limits.sourceBytes) return { isError: true, content: [{ type: 'text', text: 'sandbox_busy_or_source_quota' }] };
      active++;
      const cancelled = AbortSignal.any([extra.signal, entry.requests.get(extra.requestId)?.signal || new AbortController().signal]);
      let job;
      try {
        cancelled.throwIfAborted();
        job = await requestBroker(client, 'POST', '/v1/jobs', { version: 1, ...args, language: 'python3.12' });
        const deadline = Date.now() + 12000;
        while (!terminal.has(job.status) && Date.now() < deadline) {
          await delay(100, undefined, { signal: cancelled });
          job = await requestBroker(client, 'GET', `/v1/jobs/${job.id}`);
        }
        cancelled.throwIfAborted();
        const result = { untrustedExecutionResult: true, job: job.id, status: job.status, cleanupVerified: job.cleanupVerified,
          sourceSha256: job.sourceSha256, artifacts: job.artifacts, error: job.error,
          diagnostics: job.diagnostics || null, productionSecurityAccepted: false };
        return { ...(job.status !== 'completed' && terminal.has(job.status) ? { isError: true } : {}),
          structuredContent: result, content: [{ type: 'text', text: JSON.stringify(result) }] };
      } catch (error) {
        if (cancelled.aborted) {
          // A submit may have reached the broker before a response was lost.
          // Resolve the immutable step identity, never replay the source.
          try {
            await cancelSandboxSubmission(client, args, job, requestBroker);
          } catch { /* broker still applies its independent execution timeout */ }
        }
        return { isError: true, content: [{ type: 'text', text: cancelled.aborted ? 'sandbox_cancel_requested' : `sandbox_unavailable${error.status ? `_http_${error.status}` : ''}` }] };
      }
      finally { active--; }
    });
    server.registerTool('sandbox_get_job', {
      description: '只读查询当前连接器身份拥有的沙箱任务状态及产物审批状态；不返回产物内容。',
      inputSchema: { id: z.string().uuid().optional(), runId: identifier.optional(), stepId: identifier.optional() },
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    }, async ({ id, runId, stepId }) => {
      try {
        if (!((id && !runId && !stepId) || (!id && runId && stepId))) throw new Error('Exactly one lookup required');
        const job = await requestBroker(client, 'GET', id ? `/v1/jobs/${id}` : `/v1/jobs/by-step/${runId}/${stepId}`);
        return { structuredContent: job, content: [{ type: 'text', text: JSON.stringify(job) }] };
      } catch { return { isError: true, content: [{ type: 'text', text: 'sandbox_job_unavailable' }] }; }
    });
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: () => randomUUID(), enableJsonResponse: true,
      onsessioninitialized: id => { entry.id = id; sessions.set(id, entry); } });
    entry.transport = transport;
    transport.onclose = () => {
      clearTimeout(entry.timer); allocated.delete(entry); if (entry.id) sessions.delete(entry.id);
      for (const controller of entry.requests.values()) controller.abort(); entry.requests.clear();
    };
    entry.touch = () => { clearTimeout(entry.timer); entry.timer = setTimeout(() => { void server.close().catch(() => {}); }, sessionTtlMs).unref(); };
    entry.touch();
    try { await server.connect(transport); } catch (error) { await server.close(); throw error; }
    return entry;
  }
  app.post('/mcp', async (req, res) => {
    const sessionId = req.headers['mcp-session-id']; let entry;
    try {
      if (sessionId !== undefined) {
        if (typeof sessionId !== 'string' || !sessions.has(sessionId)) return res.status(404).json({ error: 'session_not_found' });
        entry = sessions.get(sessionId);
      } else {
        if (req.body?.method !== 'initialize') return res.status(400).json({ error: 'session_initialization_required' });
        if (allocated.size >= 16) return res.status(503).json({ error: 'session_quota' });
        entry = await createSession();
      }
      entry.touch();
      // Protect the Protocol's request-controller map against any method
      // reusing an active tools/call ID, including tools/list and ping.
      if (req.body?.id !== undefined && entry.requests.has(req.body.id)) return res.status(409).json({ error: 'request_identity_conflict' });
      if (req.body?.method === 'tools/call' && req.body.id !== undefined) {
        const requestId = req.body.id;
        const disconnected = new AbortController(); entry.requests.set(requestId, disconnected);
        res.on('close', () => { disconnected.abort(); if (entry.requests.get(requestId) === disconnected) entry.requests.delete(requestId); });
      }
      await entry.transport.handleRequest(req, res, req.body);
      if (!entry.id) await entry.server.close();
    } catch {
      if (entry && !entry.id) await entry.server.close().catch(() => {});
      if (!res.headersSent) res.status(500).json({ error: 'sandbox_mcp_request_failed' });
    }
  });
  // JSON responses do not need a persistent SSE stream. Session IDs keep SDK
  // cancel notifications on the original Protocol instance instead of a new one.
  app.get('/mcp', (_req, res) => res.sendStatus(405));
  app.delete('/mcp', async (req, res) => {
    const entry = sessions.get(req.headers['mcp-session-id']);
    if (!entry) return res.status(404).json({ error: 'session_not_found' });
    try { await entry.transport.handleRequest(req, res); } catch { if (!res.headersSent) res.sendStatus(500); }
  });
  app.locals.closeSandboxMcp = async () => { await Promise.allSettled([...allocated].map(entry => entry.server.close())); };
  return app;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const [path, ...extra] = process.argv.slice(2);
  if (!path || extra.length) throw new Error('Usage: node integrations/agent-sandbox/mcp.mjs PRIVATE_CONFIG.json');
  const file = lstatSync(path);
  if (!file.isFile() || file.isSymbolicLink() || (file.mode & 0o077)) throw new Error('MCP config must be private (0600)');
  const config = JSON.parse(readFileSync(path, 'utf8'));
  if (!Number.isSafeInteger(config.port) || config.port < 1024 || config.port > 65535) throw new Error('Invalid MCP port');
  const app = createSandboxMcpApp(config);
  const listener = app.listen(config.port, '127.0.0.1', () => console.log(JSON.stringify({ event: 'sandbox.mcp.started', port: config.port })));
  for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, async () => { listener.close(); listener.closeAllConnections(); await app.locals.closeSandboxMcp(); });
}
