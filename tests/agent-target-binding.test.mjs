import { test } from 'node:test';
import assert from 'node:assert/strict';
import { runtimeFixture, call, answer } from './runtime-fixture.mjs';

async function protectedFixture() {
  const h = await runtimeFixture({ runtime: 'agentscope' });
  const updated = await h.request(`/resources/${h.resource.id}`, {
    ...h.resource,
    toolPolicies: {
      ...h.resource.toolPolicies,
      service_status: {
        ...h.resource.toolPolicies.service_status,
        constraints: { service: ['billing', 'inventory'] },
        requiredTargetFields: ['service'],
      },
    },
  }, 'PUT');
  assert.equal(updated.status, 200, JSON.stringify(updated.data));
  return h;
}

const binding = (h, service = 'billing') => ({
  resourceId: h.resource.id,
  tool: 'service_status',
  environment: 'production',
  arguments: { service },
});

test('confirmed target executes once, persists in the run input and is part of request deduplication', async () => {
  const h = await protectedFixture();
  try {
    h.model((req, res) => answer(res, req.body.messages.at(-1).role === 'tool' ? undefined : [call()]));
    const input = { text: '查询服务状态', targetBinding: binding(h), requestKey: 'bound-target-once' };
    const first = await h.request('/chat', input);
    assert.equal(first.status, 200, JSON.stringify(first.data));
    assert.deepEqual(h.fixtures.toolCalls.map(item => item.service), ['billing']);
    assert.match(h.requests[0].messages[0].content, /已确认的结构化查询目标/);
    assert.doesNotMatch(h.requests[0].messages[0].content, /"service":"billing"/);
    assert.match(h.requests[0].messages.at(-1).content, /"service":"billing"/);
    const run = h.app.store.get('SELECT input,status FROM executions WHERE id=?', first.data.runId);
    assert.equal(run.status, 'success');
    assert.deepEqual(JSON.parse(h.app.store.decrypt(run.input)).targetBinding, input.targetBinding);
    const repeated = await h.request('/chat', input);
    assert.equal(repeated.status, 200);
    assert.equal(repeated.data.runId, first.data.runId);
    assert.equal((await h.request('/chat', { ...input, targetBinding: binding(h, 'inventory') })).status, 409);
    assert.equal(h.requests.length, 2);
    assert.equal(h.fixtures.toolCalls.length, 1);
    assert.equal(h.app.store.get('SELECT count(*) AS n FROM tool_steps').n, 1);
  } finally { await h.close(); }
});

test('authorized wrong target and out-of-scope target are both refused before a tool step', async () => {
  const h = await protectedFixture();
  try {
    for (const [target, error] of [['inventory', /本轮确认的目标/], ['payroll', /授权范围/]]) {
      h.model((req, res) => answer(res, [call('proposed', 'mcp_0', { service: target })]));
      const response = await h.request('/chat', { text: '查询 billing', targetBinding: binding(h), requestKey: `bound-target-${target}` });
      assert.equal(response.status, 403, JSON.stringify(response.data));
      assert.match(response.data.error, error);
      assert.doesNotMatch(response.data.error, /billing|inventory|payroll/);
      assert.equal(h.fixtures.toolCalls.length, 0);
      assert.equal(h.app.store.get('SELECT count(*) AS n FROM tool_steps').n, 0);
    }
  } finally { await h.close(); }
});

test('missing target blocks tool use; malformed or stale bindings fail before model and MCP', async () => {
  const h = await protectedFixture();
  try {
    h.model((req, res) => answer(res, [call()]));
    const missing = await h.request('/chat', { text: '查询 billing' });
    assert.equal(missing.status, 422);
    assert.match(missing.data.error, /确认本轮查询目标/);
    const incomplete = await h.request('/chat', { text: '查询 billing', targetBinding: { ...binding(h), arguments: {} } });
    assert.equal(incomplete.status, 400);
    const ambiguous = await h.request('/chat', { text: '查询 billing', targetBinding: { ...binding(h), arguments: { service: 'billing', other: 'inventory' } } });
    assert.equal(ambiguous.status, 422);
    const stale = await h.request('/chat', { text: '查询 billing', targetBinding: { ...binding(h), environment: 'test' } });
    assert.equal(stale.status, 403);
    assert.equal(h.requests.length, 1);
    assert.equal(h.fixtures.toolCalls.length, 0);
    assert.equal(h.app.store.get('SELECT count(*) AS n FROM tool_steps').n, 0);
  } finally { await h.close(); }
});

test('invalid binding is rejected before connecting to a configured MCP endpoint', async () => {
  const h = await protectedFixture();
  try {
    const current = (await h.request('/resources')).data.find(resource => resource.id === h.resource.id);
    const changed = await h.request(`/resources/${h.resource.id}`, { ...current, endpoint: h.fixtures.url + '/missing',
      toolPolicies: { ...current.toolPolicies, service_status: { ...current.toolPolicies.service_status,
        constraints: { service: ['billing', 'inventory'] }, requiredTargetFields: ['service'] } } }, 'PUT');
    assert.equal(changed.status, 200);
    const response = await h.request('/chat', { text: '查询 billing', targetBinding: { ...binding(h), environment: 'test' } });
    assert.equal(response.status, 403);
    assert.equal(h.app.store.get("SELECT count(*) AS n FROM audit WHERE action='mcp.unavailable'").n, 0);
    assert.equal(h.requests.length, 0);
  } finally { await h.close(); }
});

test('extra model arguments are rejected even when confirmed target fields match', async () => {
  const h = await protectedFixture();
  try {
    h.model((req, res) => answer(res, [call('extra', 'mcp_0', { service: 'billing', other: 'inventory' })]));
    const response = await h.request('/chat', { text: '查询 billing', targetBinding: binding(h) });
    assert.equal(response.status, 403, JSON.stringify(response.data));
    assert.equal(h.fixtures.toolCalls.length, 0);
    assert.equal(h.app.store.get('SELECT count(*) AS n FROM tool_steps').n, 0);
  } finally { await h.close(); }
});

test('all proposals in one batch are checked before the first tool executes', async () => {
  const h = await protectedFixture();
  try {
    h.model((req, res) => answer(res, [call('correct', 'mcp_0', { service: 'billing' }), call('wrong', 'mcp_0', { service: 'inventory' })]));
    const response = await h.request('/chat', { text: '查询 billing', targetBinding: binding(h) });
    assert.equal(response.status, 403, JSON.stringify(response.data));
    assert.equal(h.requests.length, 1);
    assert.equal(h.fixtures.toolCalls.length, 0);
    assert.equal(h.app.store.get('SELECT count(*) AS n FROM tool_steps').n, 0);
  } finally { await h.close(); }
});

test('a confirmed read target cannot be used to plan a different tool', async () => {
  const h = await protectedFixture();
  try {
    h.model((req, res) => answer(res, [call('write', 'mcp_1', { service: 'billing', state: 'maintenance' })]));
    const response = await h.request('/chat', { text: '查询 billing', targetBinding: binding(h) });
    assert.equal(response.status, 403, JSON.stringify(response.data));
    assert.equal(h.fixtures.toolCalls.length, 0);
    assert.equal(h.app.store.get('SELECT count(*) AS n FROM tool_steps').n, 0);
  } finally { await h.close(); }
});

test('a second model round cannot switch target after receiving tool output', async () => {
  const h = await protectedFixture();
  try {
    h.model((req, res) => answer(res, [call(`call-${h.requests.length}`, 'mcp_0', { service: h.requests.length === 1 ? 'billing' : 'inventory' })]));
    const response = await h.request('/chat', { text: '查询 billing', targetBinding: binding(h), requestKey: 'bound-target-after-output' });
    assert.equal(response.status, 403, JSON.stringify(response.data));
    assert.equal(h.requests.length, 2);
    assert.deepEqual(h.fixtures.toolCalls.map(item => item.service), ['billing']);
    assert.deepEqual(h.app.store.all('SELECT status FROM tool_steps').map(step => step.status), ['success']);
    assert.equal((await h.request('/chat', { text: '查询 billing', targetBinding: binding(h), requestKey: 'bound-target-after-output' })).status, 409);
    assert.equal(h.fixtures.toolCalls.length, 1);
  } finally { await h.close(); }
});

test('policy changes during model processing still block the bound call', async () => {
  const h = await protectedFixture();
  try {
    h.model((req, res) => {
      h.app.store.run('UPDATE resources SET updated=? WHERE id=?', new Date(Date.now() + 1000).toISOString(), h.resource.id);
      answer(res, [call()]);
    });
    const response = await h.request('/chat', { text: '查询 billing', targetBinding: binding(h) });
    assert.equal(response.status, 403, JSON.stringify(response.data));
    assert.equal(h.fixtures.toolCalls.length, 0);
    assert.equal(h.app.store.get('SELECT count(*) AS n FROM tool_steps').n, 0);
  } finally { await h.close(); }
});
