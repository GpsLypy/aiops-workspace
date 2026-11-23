// Local teaching fixture only. Does not connect to production or run commands.
// Start from the repository root: node docs/examples/ops-onboarding/mcp-demo.mjs
import { createMcpExpressApp } from '@modelcontextprotocol/sdk/server/express.js';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { z } from 'zod';

const port = Number(process.env.TUTORIAL_MCP_PORT || 43128);
if (!Number.isInteger(port) || port < 0 || port > 65535) throw new Error('Invalid TUTORIAL_MCP_PORT');
const app = createMcpExpressApp({ host: '127.0.0.1' });

// To connect your own system, replace this function with an authenticated,
// bounded read-only API request. See docs/ops-onboarding.md, lesson 10.
async function queryStatus({ service, environment }) {
  return {
    fixture: true, service, environment, status: 'degraded',
    p95_ms: 1260, connection_pool_waiting: 37,
    sample_code: 'MCP-MAPLE-8192',
    sampled_at: new Date().toISOString(), window_minutes: 5,
    source: 'local-teaching-fixture',
  };
}

app.get('/health', (_req, res) => res.json({ ok: true, fixture: true }));
app.post('/mcp', async (req, res) => {
  const server = new McpServer({ name: 'ops-onboarding-readonly', version: '1.0.0' });
  server.registerTool('service_status', {
    description: '只读查询 billing-lab/test 状态，返回固定教学指标、采样时间和窗口，fixture=true。',
    inputSchema: {
      service: z.string().describe('服务标识，本教学服务仅允许 billing-lab'),
      environment: z.enum(['test']).describe('目标环境'),
    },
    annotations: { readOnlyHint: true, destructiveHint: false },
  }, async args => {
    // The adapter must enforce its own scope even when called outside this app.
    if (args.service !== 'billing-lab' || args.environment !== 'test') {
      return { isError: true, content: [{ type: 'text', text: '目标超出教学服务允许范围' }] };
    }
    try {
      const result = await queryStatus(args);
      console.log(JSON.stringify({ event: 'tool.call', tool: 'service_status', arguments: args, result }));
      return { content: [{ type: 'text', text: JSON.stringify(result) }], structuredContent: result };
    } catch {
      // Never return upstream credentials, full error objects or raw responses.
      return { isError: true, content: [{ type: 'text', text: '状态查询失败，未取得有效数据；请检查 MCP 服务端记录' }] };
    }
  });
  server.registerTool('unapproved_probe', {
    description: '教学授权检查用工具，请勿加入允许列表；仅返回固定文本，无外部操作。',
    inputSchema: {},
    annotations: { readOnlyHint: true },
  }, async () => {
    console.log(JSON.stringify({ event: 'tool.call', tool: 'unapproved_probe' }));
    return { content: [{ type: 'text', text: 'UNAPPROVED_PROBE_CALLED' }] };
  });
  const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
  res.on('close', () => {
    void transport.close().catch(() => {});
    void server.close().catch(() => {});
  });
  try {
    await server.connect(transport);
    await transport.handleRequest(req, res, req.body);
  } catch {
    if (!res.headersSent) res.status(500).json({ jsonrpc: '2.0', error: { code: -32603, message: 'MCP request failed' }, id: null });
  }
});
// Stateless request/response mode does not provide a standalone SSE stream.
app.get('/mcp', (_req, res) => res.sendStatus(405));
app.delete('/mcp', (_req, res) => res.sendStatus(405));
const listener = app.listen(port, '127.0.0.1', () => {
  console.log(`Teaching MCP: http://127.0.0.1:${listener.address().port}/mcp (fixture=true)`);
});
listener.on('error', error => { console.error(error.message); process.exitCode = 1; });
