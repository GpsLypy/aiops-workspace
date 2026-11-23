import { responsesFixture } from './responses-fixture.mjs';
import express from 'express';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { z } from 'zod';

export async function listen(app) {
  const server = await new Promise(resolve => { const s = app.listen(0, '127.0.0.1', () => resolve(s)); });
  return { server, url: `http://127.0.0.1:${server.address().port}`, close: () => new Promise(resolve => { server.close(resolve); server.closeAllConnections(); }) };
}

// Deterministic protocol fixtures, never a substitute for a production model/MCP.
export async function startFixtures() {
  const app = express(); app.use(express.json());
  const requests = []; const toolCalls = []; const mcpTraceparents = []; let modelFailure = false; let writeFailure = false; let readFailure = false;
  const states = new Map(); const applied = new Set();
  app.post('/v1/responses', responsesFixture, async (req, res) => {
    requests.push(req.body);
    if (modelFailure) return res.status(503).json({ error: 'controlled failure' });
    const last = req.body.messages.at(-1);
    const question = req.body.messages.filter(m => m.role === 'user').at(-1)?.content || '';
    if (question.includes('Responses')) return res.json({ choices: [{ message: { role: 'assistant', content: `测试 Responses 已回答：${question}` } }], usage: { prompt_tokens: 30, completion_tokens: 20, total_tokens: 50 } });
    if (question.includes('慢速')) await new Promise(resolve => setTimeout(resolve, 150));
    if (question.includes('未授权工具')) return res.json({ choices: [{ message: { role: 'assistant', content: '', tool_calls: [{ id: 'forbidden', type: 'function', function: { name: 'not_allowed', arguments: '{}' } }] } }] });
    if (question.includes('调用工具') && last.role !== 'tool' && req.body.tools?.length) {
      return res.json({ choices: [{ message: { role: 'assistant', content: '', tool_calls: [{ id: 'call_test', type: 'function', function: { name: req.body.tools[0].function.name, arguments: '{"service":"billing"}' } }] } }] });
    }
    const content = last.role === 'tool' ? `工具结果：${last.content}` : `测试模型已回答：${question}\n参考上下文：${req.body.messages[0].content.slice(0, 600)}`;
    res.json({ choices: [{ message: { role: 'assistant', content } }], usage: { prompt_tokens: 30, completion_tokens: 20, total_tokens: 50 } });
  });
  app.post('/mcp', async (req, res) => {
    mcpTraceparents.push(req.headers.traceparent || null);
    if (req.headers.authorization !== 'Bearer fixture-mcp-secret') return res.status(401).json({ error: 'invalid token' });
    const server = new McpServer({ name: 'fixture-tools', version: '1.0.0' });
    server.registerTool('service_status', { description: '查询服务状态', inputSchema: { service: z.string() } }, async ({ service }) => {
      toolCalls.push({ name: 'service_status', service });
      return { ...(readFailure ? { isError: true } : {}), content: [{ type: 'text', text: JSON.stringify(readFailure ? { service, error: 'controlled read failure' } : { service, status: states.get(service) || 'healthy', latency: 12 }) }] };
    });
    server.registerTool('set_service_state', { description: '修改服务状态', inputSchema: { service: z.string(), state: z.enum(['healthy', 'maintenance']), idempotencyKey: z.string() } }, async ({ service, state, idempotencyKey }) => {
      if (!applied.has(idempotencyKey)) { states.set(service, state); applied.add(idempotencyKey); toolCalls.push({ name: 'set_service_state', service, state, idempotencyKey }); }
      return { isError: writeFailure, content: [{ type: 'text', text: JSON.stringify({ service, status: state }) }] };
    });
    server.registerTool('dangerous_operation', { description: '未授权工具', inputSchema: {} }, async () => {
      toolCalls.push({ name: 'dangerous_operation' });
      return { content: [{ type: 'text', text: 'must not execute' }] };
    });
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
    res.on('close', () => { void transport.close(); void server.close(); });
    try { await server.connect(transport); await transport.handleRequest(req, res, req.body); }
    catch { if (!res.headersSent) res.status(500).json({ error: 'fixture MCP error' }); }
  });
  app.get('/mcp', (req, res) => res.sendStatus(405));
  app.delete('/mcp', (req, res) => res.sendStatus(405));
  const running = await listen(app);
  return { ...running, requests, toolCalls, mcpTraceparents, failModel: value => { modelFailure = value; }, failWrites: value => { writeFailure = value; }, failReads: value => { readFailure = value; } };
}
