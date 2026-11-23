import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { z } from 'zod';
import { getResource, httpError } from './store.mjs';
import { safeFetch } from './security.mjs';
import { authorizeTool } from './governance.mjs';

export async function connectMcp(store, resource, signal, traceparent = null) {
  const circuit = store.setting(`circuit:${resource.id}`);
  if (circuit?.revision === resource.revision && circuit.until > Date.now()) throw httpError(503, `MCP「${resource.name}」暂时熔断，请稍后重试`);
  const client = new Client({ name: 'aiops-workspace', version: '1.0.0' });
  const token = store.decrypt(resource.tokenEncrypted);
  const transport = new StreamableHTTPClientTransport(new URL(resource.endpoint), {
    requestInit: { headers: token ? { Authorization: `Bearer ${token}` } : {} },
    fetch: (url, init) => {
      const headers = new Headers(init?.headers);
      const parent = typeof traceparent === 'function' ? traceparent() : traceparent;
      if (typeof parent === 'string' && /^00-[0-9a-f]{32}-[0-9a-f]{16}-0[01]$/.test(parent)) headers.set('traceparent', parent);
      return safeFetch(url, { ...init, headers, redirect: 'error', signal: AbortSignal.any([...(signal ? [signal] : []), ...(init?.signal ? [init.signal] : []), AbortSignal.timeout(20000)]) });
    },
    reconnectionOptions: { maxRetries: 0, initialReconnectionDelay: 1000, maxReconnectionDelay: 1000, reconnectionDelayGrowFactor: 1 },
  });
  try { await client.connect(transport, { timeout: 20000 }); store.setSetting(`circuit:${resource.id}`, { revision: resource.revision, failures: 0, until: 0 }); }
  catch {
    const failures = (circuit?.revision === resource.revision ? circuit.failures || 0 : 0) + 1;
    store.setSetting(`circuit:${resource.id}`, { revision: resource.revision, failures, until: failures >= 3 ? Date.now() + 30000 : 0 });
    await client.close().catch(() => {}); throw httpError(502, `无法连接 MCP 服务「${resource.name}」，请检查地址、令牌和 Streamable HTTP 协议支持`);
  }
  return { client, close: async () => { await client.close().catch(() => {}); } };
}
export async function discover(client, signal) {
  const tools = []; let cursor;
  for (let page = 0; page < 10; page++) {
    const result = await client.listTools(cursor ? { cursor } : {}, { signal, timeout: 20000 });
    tools.push(...result.tools);
    if (!result.nextCursor) return tools.slice(0, 200);
    cursor = result.nextCursor;
  }
  throw httpError(502, 'MCP 工具列表分页过多');
}
export function mcpRoutes(app, store, execution) {
  app.post('/api/mcp/:id/discover', async (req, res) => {
    const resource = getResource(store, req.user, req.params.id, true);
    if (resource.kind !== 'mcp') throw httpError(400, '资源不是 MCP 服务');
    const connection = await connectMcp(store, resource);
    try { const tools = await discover(connection.client); store.setSetting(`catalog:${resource.id}`, { revision: resource.revision, expires: Date.now() + 300000, tools }); store.audit(req.user, 'mcp.discover', resource.id, { count: tools.length }); res.json(tools); }
    finally { await connection.close(); }
  });
  app.post('/api/mcp/:id/call', async (req, res) => {
    const resource = getResource(store, req.user, req.params.id, true);
    if (resource.kind !== 'mcp' || resource.status !== '已启用') throw httpError(400, 'MCP 服务未启用');
    const data = z.object({ name: z.string().max(150), arguments: z.record(z.unknown()).default({}) }).parse(req.body);
    if (!resource.allowedTools.includes(data.name)) throw httpError(403, '此工具尚未加入允许执行列表');
    const policy = authorizeTool(req.user, resource, data.name, data.arguments, { environment: resource.environment });
    if (policy.risk !== 'read') throw httpError(403, '写操作请通过执行中心提交审批');
    const output = await execution.run(req.user, { kind: 'tool', resourceId: resource.id, ...data, requestKey: req.get('idempotency-key') || undefined }, async context => {
      const connection = await connectMcp(store, resource, context.signal);
      try {
        const tool = (await discover(connection.client, context.signal)).find(t => t.name === data.name);
        if (!tool) throw httpError(404, '工具不存在');
        const step = await execution.callStep(req.user, context, resource, data.name, data.arguments, tool.inputSchema);
        return { response: step.response };
      } finally { await connection.close(); }
    });
    res.json(output.response);
  });
}
