import { test } from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import { listen } from './fixtures.mjs';
import { runtimeFixture, answer, call } from './runtime-fixture.mjs';

async function unavailable(h, endpoint = h.fixtures.url + '/unavailable') {
  return (await h.request('/resources', { kind: 'mcp', name: '故障数据源', endpoint, token: 'private-discovery-token', allowedTools: ['status'], toolPolicies: { status: { risk: 'read' } } })).data;
}
function checkGaps(message, resource, runId) {
  assert.equal(message.metadata.runId, runId);
  assert.equal(message.metadata.mcpFailures.length, 1);
  assert.equal(message.metadata.mcpFailures[0].resourceId, resource.id);
  assert.equal(message.metadata.mcpFailures[0].code, 'MCP_UNAVAILABLE');
  for (const privateValue of [resource.endpoint, 'private-discovery-token', 'password=private']) assert.ok(!JSON.stringify(message).includes(privateValue));
}

test('MCP discovery failure is persisted separately from actual tool evidence and reaches the model', async () => {
  const h = await runtimeFixture();
  try {
    const resource = await unavailable(h);
    h.model((req, res) => { assert.match(req.body.messages[0].content, /本轮数据源缺口.*故障数据源/s); answer(res, req.body.messages.at(-1).role === 'tool' ? null : [call()]); });
    const result = await h.request('/chat', { text: '检查服务' }); assert.equal(result.status, 200);
    checkGaps(result.data, resource, result.data.runId);
    assert.equal(result.data.metadata.tools.length, 1);
    assert.equal(h.app.store.get('SELECT count(*) AS n FROM tool_steps').n, 1);
    assert.equal(h.app.store.get("SELECT count(*) AS n FROM audit WHERE action='mcp.unavailable'").n, 1);
    await h.restart();
    const history = (await h.request(`/conversations/${result.data.conversationId}`)).data;
    checkGaps(history.messages.at(-1), resource, result.data.runId);
  } finally { await h.close(); }
});

test('MCP evidence gaps survive model failure and pending approval without creating failed discovery steps', async () => {
  const h = await runtimeFixture();
  try {
    const resource = await unavailable(h);
    h.model((req, res) => res.status(503).send('password=private'));
    const failed = await h.request('/chat', { text: '模型失败' }); assert.ok(failed.status >= 400);
    const failedHistory = (await h.request(`/conversations/${failed.data.conversationId}`)).data;
    checkGaps(failedHistory.messages.at(-1), resource, failed.data.runId);
    assert.equal(failedHistory.messages.at(-1).role, 'error');
    h.model((req, res) => answer(res, [call('write', 'mcp_1', { service: 'billing', state: 'maintenance' })]));
    const plan = await h.request('/chat', { text: '维护计划' }); assert.equal(plan.data.status, 'awaiting_approval');
    checkGaps(plan.data, resource, plan.data.runId);
    assert.equal(h.app.store.get('SELECT count(*) AS n FROM tool_steps').n, 1);
    assert.equal(h.fixtures.toolCalls.length, 0);
  } finally { await h.close(); }
});

test('cancellation during MCP discovery does not become an unavailable-service success or call the model', async () => {
  const h = await runtimeFixture(); const peer = express(); let reached;
  const waiting = new Promise(resolve => { reached = resolve; }); peer.post('/mcp', () => reached());
  const endpoint = await listen(peer);
  try {
    await unavailable(h, endpoint.url + '/mcp');
    const running = h.request('/chat', { text: '取消发现', requestKey: 'cancel-mcp-discovery' });
    await waiting;
    const run = h.app.store.get('SELECT id FROM executions WHERE request_key=?', 'cancel-mcp-discovery');
    h.app.execution.cancel(h.user, run.id);
    const result = await running; assert.equal(result.status, 504); assert.equal(h.requests.length, 0);
    const history = (await h.request(`/conversations/${result.data.conversationId}`)).data;
    assert.deepEqual(history.messages.at(-1).metadata.mcpFailures, []);
    assert.equal(h.app.execution.stats().active, 0);
  } finally { await endpoint.close(); await h.close(); }
});
