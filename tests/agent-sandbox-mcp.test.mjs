import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { createSandboxMcpApp } from '../integrations/agent-sandbox/mcp.mjs';
import { digest } from '../integrations/agent-sandbox/policy.mjs';
import { listen } from './fixtures.mjs';

const config = { socketPath: '/not-used-in-mcp-test.sock', brokerToken: 'b'.repeat(40), mcpToken: 'm'.repeat(40) };
async function harness(t, overrides = {}) {
  const jobs = new Map();
  const broker = async (_client, method, path, body) => {
    if (path === '/v1/jobs' && method === 'POST') {
      const job = { ...body, source: undefined, id: randomUUID(), sourceSha256: digest(body.source), status: 'running', cleanupVerified: false, artifacts: [], error: null };
      jobs.set(job.id, job); return structuredClone(job);
    }
    const id = path.split('/')[3];
    if (path.endsWith('/cancel')) { const job = jobs.get(id); job.status = 'cancelled'; job.cleanupVerified = true; return structuredClone(job); }
    const job = jobs.get(id);
    if (!job) throw new Error('Unknown fake job'); return structuredClone(job);
  };
  const app = createSandboxMcpApp({ ...config, ...overrides }, broker); const server = await listen(app);
  const clients = [];
  t.after(async () => { await Promise.allSettled(clients.map(client => client.close())); await app.locals.closeSandboxMcp(); await server.close(); });
  const connect = async () => {
    const client = new Client({ name: 'sandbox-session-test', version: '1' });
    const transport = new StreamableHTTPClientTransport(new URL(server.url + '/mcp'), { requestInit: { headers: { Authorization: `Bearer ${config.mcpToken}` } } });
    clients.push(client); await client.connect(transport); return { client, transport };
  };
  const http = (body, headers = {}, method = 'POST') => fetch(server.url + '/mcp', { method,
    headers: { Authorization: `Bearer ${config.mcpToken}`, 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream', ...headers },
    ...(method === 'POST' ? { body: JSON.stringify(body) } : {}) });
  return { jobs, connect, http, url: server.url };
}
const args = runId => ({ jobId: randomUUID(), runId, stepId: 'step', source: 'import time; time.sleep(30)' });
async function until(action) { for (let i = 0; i < 100; i++) { const value = action(); if (value) return value; await delay(10); } throw new Error('MCP fixture did not converge'); }

test('MCP sessions require valid bearer and cannot use unknown session or browser origin', async t => {
  const h = await harness(t); const { client, transport } = await h.connect();
  assert.match(transport.sessionId, /^[a-f0-9-]{36}$/);
  assert.equal((await h.http({}, { Authorization: `Bearer ${'x'.repeat(40)}`, 'mcp-session-id': transport.sessionId })).status, 401);
  assert.equal((await h.http({}, { Origin: 'http://localhost', 'mcp-session-id': transport.sessionId })).status, 403);
  assert.equal((await h.http({}, { 'mcp-session-id': randomUUID() })).status, 404);
  assert.equal((await h.http({ jsonrpc: '2.0', id: 100, method: 'tools/list' })).status, 400);
  assert.equal((await client.listTools()).tools.length, 2);
});
test('SDK cancellation reaches its original request without cancelling another session', async t => {
  const h = await harness(t); const a = await h.connect(); const b = await h.connect();
  const controller = new AbortController(); const aRun = randomUUID(); const bRun = randomUUID();
  const first = a.client.callTool({ name: 'sandbox_execute_python', arguments: args(aRun) }, undefined, { signal: controller.signal }).catch(error => error);
  const second = b.client.callTool({ name: 'sandbox_execute_python', arguments: args(bRun) });
  const aJob = await until(() => [...h.jobs.values()].find(job => job.runId === aRun));
  const bJob = await until(() => [...h.jobs.values()].find(job => job.runId === bRun));
  controller.abort(); await first;
  await until(() => aJob.status === 'cancelled'); assert.equal(aJob.cleanupVerified, true); assert.equal(bJob.status, 'running');
  bJob.status = 'completed'; bJob.cleanupVerified = true;
  assert.equal((await second).structuredContent.status, 'completed');
});
test('HTTP tool disconnect cancels only its exact submitted broker job', async t => {
  const h = await harness(t); const { transport } = await h.connect(); const runId = randomUUID(); const controller = new AbortController();
  const result = fetch(h.url + '/mcp', { method: 'POST', signal: controller.signal, headers: { Authorization: `Bearer ${config.mcpToken}`,
    'Content-Type': 'application/json', Accept: 'application/json, text/event-stream', 'mcp-session-id': transport.sessionId },
  body: JSON.stringify({ jsonrpc: '2.0', id: 100, method: 'tools/call', params: { name: 'sandbox_execute_python', arguments: args(runId) } }) }).catch(error => error);
  const job = await until(() => [...h.jobs.values()].find(value => value.runId === runId));
  controller.abort(); await result; await until(() => job.status === 'cancelled'); assert.equal(job.cleanupVerified, true);
});
test('cross-method duplicate request IDs cannot overwrite cancellation of active work', async t => {
  const h = await harness(t); const { transport } = await h.connect(); const runId = randomUUID();
  const header = { 'mcp-session-id': transport.sessionId };
  const controller = new AbortController();
  const result = fetch(h.url + '/mcp', { method: 'POST', signal: controller.signal,
    headers: { Authorization: `Bearer ${config.mcpToken}`, 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream', ...header },
    body: JSON.stringify({ jsonrpc: '2.0', id: 100, method: 'tools/call', params: { name: 'sandbox_execute_python', arguments: args(runId) } }) }).catch(error => error);
  const job = await until(() => [...h.jobs.values()].find(value => value.runId === runId));
  for (const method of ['tools/list', 'ping', 'tools/call']) {
    const duplicate = await h.http({ jsonrpc: '2.0', id: 100, method, params: {} }, header); assert.equal(duplicate.status, 409); await duplicate.body.cancel();
  }
  const cancelled = await h.http({ jsonrpc: '2.0', method: 'notifications/cancelled', params: { requestId: 100, reason: 'test cancellation' } }, header);
  assert.equal(cancelled.status, 202); await cancelled.body?.cancel();
  await until(() => job.status === 'cancelled'); assert.equal(job.cleanupVerified, true);
  // MCP cancels intentionally have no response for the cancelled original RPC.
  controller.abort(); await result;
});
test('session count is bounded and DELETE frees a session without retaining protocol state', async t => {
  const h = await harness(t); const ids = [];
  const initialize = () => h.http({ jsonrpc: '2.0', id: 0, method: 'initialize', params: { protocolVersion: '2025-03-26', capabilities: {}, clientInfo: { name: 'bound-test', version: '1' } } });
  for (let i = 0; i < 16; i++) { const response = await initialize(); assert.equal(response.status, 200); ids.push(response.headers.get('mcp-session-id')); await response.body.cancel(); }
  const over = await initialize(); assert.equal(over.status, 503); await over.body.cancel();
  const removed = await h.http(undefined, { 'mcp-session-id': ids[0] }, 'DELETE'); assert.equal(removed.status, 200); await removed.body?.cancel();
  const old = await h.http({}, { 'mcp-session-id': ids[0] }); assert.equal(old.status, 404); await old.body.cancel();
  const next = await initialize(); assert.equal(next.status, 200); await next.body.cancel();
});
test('idle session expiry aborts active work and removes its authenticated session', async t => {
  const h = await harness(t, { sessionTtlMs: 150 }); const { client, transport } = await h.connect(); const runId = randomUUID();
  const result = client.callTool({ name: 'sandbox_execute_python', arguments: args(runId) }).catch(error => error);
  const job = await until(() => [...h.jobs.values()].find(value => value.runId === runId));
  await until(() => job.status === 'cancelled'); assert.equal(job.cleanupVerified, true);
  await client.close(); await result;
  const expired = await h.http({}, { 'mcp-session-id': transport.sessionId }); assert.equal(expired.status, 404); await expired.body.cancel();
});
