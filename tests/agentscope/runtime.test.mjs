import { test } from 'node:test';
import assert from 'node:assert/strict';
import { runtimeFixture, call, answer } from '../runtime-fixture.mjs';

const setup = () => runtimeFixture({ runtime: 'agentscope' });

test('AgentScope handles ordered batches, repeated provider IDs across turns, and records runtime and exact usage', async () => {
  const h = await setup();
  try {
    h.model((req, res) => answer(res, h.requests.length < 3 ? [call('same', 'mcp_0', '{\n  "service": "billing"\n}'), call('second')] : null));
    const response = await h.request('/chat', { text: '检查状态' });
    assert.equal(response.status, 200, JSON.stringify(response.data));
    assert.equal(response.data.metadata.tools.length, 4); assert.equal(response.data.metadata.usage.total_tokens, 90);
    assert.equal(h.fixtures.toolCalls.length, 4);
    const row = h.app.store.get('SELECT * FROM executions WHERE id=?', response.data.runId);
    assert.equal(row.runtime, 'agentscope'); assert.equal(row.runtime_version, h.app.engine.health().mode === 'prefork' ? '2.0.8/bridge-v2-prefork' : '2.0.8/bridge-v1'); assert.equal(row.tokens, 90);
    assert.equal(h.requests[2].messages.filter(m => m.role === 'tool').length, 4);
    const steps = h.app.store.all('SELECT call_key FROM tool_steps');
    assert.equal(new Set(steps.map(s => s.call_key)).size, 4);
  } finally { await h.close(); }
});

test('AgentScope refuses repaired JSON, invalid schema, unauthorized tools, duplicate IDs and oversized batches before any tool executes', async () => {
  const h = await setup();
  try {
    const cases = [
      [[call('invalid', 'mcp_0', '{"service":"billing",}')], 502],
      [[call('empty', 'mcp_0', '')], 502],
      [[call('type', 'mcp_0', { service: 12 })], 403],
      [[call('type', 'mcp_0', { service: 'billing', extra: 12 })], 400],
      [[call('forbidden', 'not_allowed')], 403],
      [[call('duplicate'), call('duplicate')], 502],
      [Array.from({ length: 13 }, (_, i) => call(String(i))), 502],
    ];
    for (const [calls, status] of cases) {
      h.model((req, res) => answer(res, calls));
      const response = await h.request('/chat', { text: '拒绝无效调用' });
      assert.equal(response.status, status, JSON.stringify(response.data));
      assert.equal(h.fixtures.toolCalls.length, 0);
      assert.equal(h.app.store.get('SELECT busy_until FROM conversations WHERE id=?', response.data.conversationId).busy_until, 0);
    }
  } finally { await h.close(); }
});

test('Node enforces six actual model calls including AgentScope finalization and rejects further tool execution', async () => {
  const h = await setup();
  try {
    h.model((req, res) => answer(res, [call()]));
    const response = await h.request('/chat', { text: '循环工具' });
    assert.equal(response.status, 422, JSON.stringify(response.data));
    assert.equal(h.requests.length, 6); assert.equal(h.fixtures.toolCalls.length, 6);
    const row = h.app.store.get('SELECT tokens,status FROM executions WHERE id=?', response.data.runId);
    assert.equal(row.tokens, 180); assert.equal(row.status, 'failed');
  } finally { await h.close(); }
});

test('AgentScope stops batch on pending write; restart with an unavailable Worker preserves approval and never falls back', async () => {
  const h = await setup();
  try {
    h.model((req, res) => answer(res, [call('write', 'mcp_1', { service: 'billing', state: 'maintenance' }), call('later')]));
    const response = await h.request('/chat', { text: '提交维护计划', requestKey: 'agentscope-write-plan' });
    assert.equal(response.status, 200, JSON.stringify(response.data)); assert.equal(response.data.status, 'awaiting_approval');
    assert.equal(h.fixtures.toolCalls.length, 0); assert.equal(h.requests.length, 1);
    assert.equal(h.app.store.get('SELECT count(*) AS n FROM tool_steps').n, 1);
    assert.equal((await h.request(`/approvals/${response.data.stepId}/approve`, {})).status, 403);
    await h.restart({ runtime: 'agentscope', python: '/missing/python' });
    const approved = await h.request(`/approvals/${response.data.stepId}/approve`, {}, 'POST', h.reviewer);
    assert.equal(approved.status, 200); assert.equal(approved.data.steps[0].verification.matches, true);
    assert.equal(approved.data.runtime, 'agentscope'); assert.match(approved.data.runtime_version, /^2\.0\.8\/bridge-v/);
    assert.equal(h.fixtures.toolCalls.filter(c => c.name === 'set_service_state').length, 1);
    assert.equal(h.requests.length, 1); // approval never resumes the model
    assert.equal((await h.request('/chat', { text: '提交维护计划', requestKey: 'agentscope-write-plan' })).data.status, 'success');
    h.model((req, res) => answer(res));
    const failed = await h.request('/chat', { text: 'Worker 不可用的新对话' }); assert.equal(failed.status, 503);
    assert.equal(h.requests.length, 1);
    assert.equal(h.app.store.get('SELECT runtime FROM executions WHERE id=?', failed.data.runId).runtime, 'agentscope');
    await h.restart();
    const resumed = await h.request('/chat', { text: '恢复 Worker 后的新对话' }); assert.equal(resumed.status, 200);
    assert.equal(h.app.store.get('SELECT runtime FROM executions WHERE id=?', resumed.data.runId).runtime, 'agentscope');
  } finally { await h.close(); }
});

test('AgentScope cancellations abort outstanding model calls, release slots and conversation locks without fallback', async () => {
  const h = await setup();
  try {
    let started; const reachedModel = new Promise(resolve => { started = resolve; });
    h.model(() => started());
    const running = h.request('/chat', { text: '等待取消', requestKey: 'cancel-agentscope' });
    await reachedModel;
    const row = h.app.store.get('SELECT * FROM executions WHERE request_key=?', 'cancel-agentscope');
    h.app.execution.cancel(h.user, row.id);
    const response = await running; assert.ok(response.status >= 400);
    assert.equal(h.app.execution.stats().active, 0);
    assert.equal(h.app.store.get('SELECT busy_until FROM conversations WHERE id=?', row.conversation_id).busy_until, 0);
    assert.equal(h.requests.length, 1);
    h.model((req, res) => answer(res));
    assert.equal((await h.request('/chat', { text: '继续', conversationId: row.conversation_id })).status, 200);
  } finally { await h.close(); }
});

test('AgentScope concurrent runs keep model histories and tool results isolated', async () => {
  const h = await setup();
  try {
    h.model((req, res) => answer(res, null, req.body.messages.find(m => m.role === 'user').content));
    const results = await Promise.all(['run-alpha', 'run-beta'].map(text => h.request('/chat', { text })));
    assert.deepEqual(results.map(r => r.data.text), ['run-alpha', 'run-beta']);
    assert.notEqual(results[0].data.runId, results[1].data.runId);
    for (const request of h.requests) assert.equal(request.messages.filter(m => m.role === 'user').length, 1);
  } finally { await h.close(); }
});

test('general conversations and every published agent always use AgentScope', async () => {
  const h = await setup();
  try {
    const agent = (await h.request('/resources', { kind: 'agents', name: '增强作用域', body: '只读检查', mcpIds: [] })).data;
    await h.request(`/resources/${agent.id}/publish`, { revision: agent.revision });
    const general = await h.request('/chat', { text: 'general' });
    const selected = await h.request('/chat', { text: 'selected', agentId: agent.id });
    assert.equal(general.status, 200); assert.equal(selected.status, 200, JSON.stringify(selected.data));
    assert.equal(h.app.store.get('SELECT runtime FROM executions WHERE id=?', general.data.runId).runtime, 'agentscope');
    assert.equal(h.app.store.get('SELECT runtime FROM executions WHERE id=?', selected.data.runId).runtime, 'agentscope');
  } finally { await h.close(); }
});

test('AgentScope enforces Node budget before contacting the provider and rechecks revoked user permissions', async () => {
  const h = await setup(); const previous = process.env.RUN_TOKEN_LIMIT;
  try {
    process.env.RUN_TOKEN_LIMIT = '1';
    const blocked = await h.request('/chat', { text: '预算拦截' });
    assert.equal(blocked.status, 422); assert.equal(h.requests.length, 0);
    if (previous === undefined) delete process.env.RUN_TOKEN_LIMIT; else process.env.RUN_TOKEN_LIMIT = previous;
    h.model((req, res) => {
      h.app.store.run('UPDATE users SET active=0 WHERE id=?', h.user.id);
      answer(res, [call()]);
    });
    const revoked = await h.request('/chat', { text: '调用前撤权' });
    assert.equal(revoked.status, 403); assert.equal(h.fixtures.toolCalls.length, 0);
    assert.equal(h.app.execution.stats().active, 0);
  } finally { if (previous === undefined) delete process.env.RUN_TOKEN_LIMIT; else process.env.RUN_TOKEN_LIMIT = previous; await h.close(); }
});
