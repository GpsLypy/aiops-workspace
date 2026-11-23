import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import express from 'express';
import { createApplication } from '../server/app.mjs';
import { listen, startFixtures } from './fixtures.mjs';

async function harness() {
  const dir = mkdtempSync(join(tmpdir(), 'aiops-execution-')); const fixtures = await startFixtures();
  let app = createApplication({ dataDir: dir, scheduler: false }); let server = await listen(app.app); let cookie = '';
  const request = async (path, body, method = body ? 'POST' : 'GET', who = cookie) => {
    const response = await fetch(server.url + '/api' + path, { method, headers: { 'Content-Type': 'application/json', Cookie: who || '' }, ...(body ? { body: JSON.stringify(body) } : {}) });
    return { status: response.status, data: await response.json(), cookie: response.headers.get('set-cookie')?.split(';')[0] };
  };
  cookie = (await request('/auth/setup', { username: 'admin', password: 'long-admin-password' })).cookie;
  await request('/users', { username: 'reviewer', password: 'long-review-password', role: 'admin' });
  const reviewer = (await request('/auth/login', { username: 'reviewer', password: 'long-review-password' })).cookie;
  const resource = (await request('/resources', { kind: 'mcp', name: 'controlled', environment: 'production', endpoint: fixtures.url + '/mcp', token: 'fixture-mcp-secret', allowedTools: ['service_status', 'set_service_state'], toolPolicies: {
    service_status: { risk: 'read', environments: ['production'], constraints: { service: ['billing'] } },
    set_service_state: { risk: 'write', environments: ['production'], constraints: { service: ['billing'], state: ['maintenance'] }, idempotencyArgument: 'idempotencyKey', verification: { tool: 'service_status', arguments: { service: 'billing' }, path: 'status', equals: 'maintenance' }, recovery: '核对状态后，提交另一项变更恢复 healthy' },
  } })).data;
  return { get app() { return app; }, dir, fixtures, request, reviewer, resource,
    restart: async () => { await server.close(); await app.close(); app = createApplication({ dataDir: dir, scheduler: false }); server = await listen(app.app); },
    close: async () => { await server.close(); await app.close(); await fixtures.close(); rmSync(dir, { recursive: true, force: true }); },
  };
}
const proposal = (h, requestKey) => ({ resourceId: h.resource.id, tool: 'set_service_state', arguments: { service: 'billing', state: 'maintenance' }, environment: 'production', requestKey });

async function mcpBarrier(h, { method, afterResponse = false }) {
  let enabled = false, closing = false, entered, release;
  const reached = new Promise(resolve => { entered = resolve; });
  const held = new Promise(resolve => { release = resolve; });
  const app = express(); app.use(express.json());
  app.post('/mcp', async (req, res) => {
    const pause = enabled && req.body.method === method;
    if (pause && !afterResponse) { entered(); await held; }
    if (closing || res.destroyed) return;
    const response = await fetch(h.fixtures.url + '/mcp', { method: 'POST', headers: {
      'Content-Type': 'application/json', Accept: 'application/json, text/event-stream', Authorization: 'Bearer fixture-mcp-secret',
    }, body: JSON.stringify(req.body) });
    const text = await response.text();
    if (pause && afterResponse) { entered(); await held; }
    if (!res.destroyed) res.status(response.status).type(response.headers.get('content-type') || 'application/json').send(text);
  });
  app.get('/mcp', (req, res) => res.sendStatus(405));
  app.delete('/mcp', (req, res) => res.sendStatus(405));
  const proxy = await listen(app);
  try {
    const updated = await h.request(`/resources/${h.resource.id}`, { ...h.resource, endpoint: proxy.url + '/mcp' }, 'PUT');
    assert.equal(updated.status, 200);
    return {
      resource: updated.data,
      block: () => { enabled = true; },
      release: () => { enabled = false; release(); },
      wait: () => new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error(`MCP barrier not reached: ${method}`)), 5000);
        reached.then(() => { clearTimeout(timer); resolve(); });
      }),
      close: async () => { closing = true; release(); await proxy.close(); },
    };
  } catch (error) { release(); await proxy.close(); throw error; }
}

test('production writes require another approver; durable exact plan executes once and verifies', async () => {
  const h = await harness();
  try {
    const input = proposal(h, 'write-once-key');
    const first = await h.request('/executions/tool', input); assert.equal(first.status, 202); assert.equal(first.data.status, 'awaiting_approval');
    const pending = (await h.request(`/executions/${first.data.runId}`)).data;
    assert.equal(pending.runtime, 'direct'); assert.equal(pending.runtime_version, '1');
    assert.equal(h.fixtures.toolCalls.filter(c => c.name === 'set_service_state').length, 0);
    const repeat = await h.request('/executions/tool', input); assert.equal(repeat.data.runId, first.data.runId);
    assert.equal((await h.request('/executions/tool', { ...input, arguments: { service: 'other', state: 'maintenance' } })).status, 409);
    assert.equal((await h.request(`/approvals/${first.data.stepId}/approve`, {})).status, 403);
    await h.restart();
    const approved = await h.request(`/approvals/${first.data.stepId}/approve`, {}, 'POST', h.reviewer);
    assert.equal(approved.status, 200, JSON.stringify(approved.data)); assert.equal(approved.data.status, 'success');
    assert.equal(approved.data.runtime, 'direct'); assert.equal(approved.data.runtime_version, '1');
    assert.equal(approved.data.steps[0].verification.matches, true);
    assert.equal(h.fixtures.toolCalls.filter(c => c.name === 'set_service_state').length, 1);
    assert.equal((await h.request(`/approvals/${first.data.stepId}/approve`, {}, 'POST', h.reviewer)).status, 409);
    assert.equal((await h.request('/executions/tool', input)).data.status, 'success');
    assert.equal(h.fixtures.toolCalls.filter(c => c.name === 'set_service_state').length, 1);
  } finally { await h.close(); }
});

test('policy changes, expired approvals, scope violations and emergency stop prevent writes', async () => {
  const h = await harness();
  try {
    assert.equal((await h.request('/executions/tool', { ...proposal(h, 'bad-scope-key'), arguments: { service: 'other', state: 'maintenance' } })).status, 403);
    const first = await h.request('/executions/tool', proposal(h, 'stale-policy-key'));
    await h.request(`/resources/${h.resource.id}`, { ...h.resource, description: 'new review required' }, 'PUT');
    assert.equal((await h.request(`/approvals/${first.data.stepId}/approve`, {}, 'POST', h.reviewer)).status, 409);
    const second = await h.request('/executions/tool', proposal(h, 'expired-plan-key'));
    h.app.store.run('UPDATE tool_steps SET expires=0 WHERE id=?', second.data.stepId);
    h.app.execution.expire();
    assert.equal((await h.request(`/approvals/${second.data.stepId}/approve`, {}, 'POST', h.reviewer)).status, 409);
    await h.request('/operations/emergency-stop', { enabled: true, reason: '测试紧急停止' });
    assert.equal((await h.request('/executions/tool', proposal(h, 'stopped-write-key'))).status, 503);
    assert.equal(h.fixtures.toolCalls.filter(c => c.name === 'set_service_state').length, 0);
  } finally { await h.close(); }
});

test('ambiguous write outcome stays unknown and reconciliation queries without replay', async () => {
  const h = await harness();
  try {
    h.fixtures.failWrites(true);
    const first = await h.request('/executions/tool', proposal(h, 'unknown-outcome-key'));
    assert.equal((await h.request(`/approvals/${first.data.stepId}/approve`, {}, 'POST', h.reviewer)).status, 502);
    const state = (await h.request(`/executions/${first.data.runId}`)).data;
    assert.equal(state.status, 'unknown'); assert.equal(state.steps[0].status, 'unknown');
    const reconciled = await h.request(`/approvals/${first.data.stepId}/reconcile`, {}, 'POST', h.reviewer);
    assert.equal(reconciled.data.status, 'success');
    assert.equal(h.fixtures.toolCalls.filter(c => c.name === 'set_service_state').length, 1);
  } finally { await h.close(); }
});

for (const boundary of [
  { name: 'after discovery', method: 'tools/list', afterResponse: false, reads: 0 },
  { name: 'after the read response', method: 'tools/call', afterResponse: true, reads: 1 },
]) {
  for (const change of [
    { name: 'resource disablement', resource: { status: '已停用' }, status: 409 },
    { name: 'resource revision change', resource: { description: 'new revision during reconciliation' }, status: 409 },
    { name: 'owner disablement', owner: { active: false }, status: 403 },
    { name: 'owner role revocation', owner: { role: 'member' }, status: 403 },
    { name: 'requester disablement', actor: { active: false }, status: 403 },
    { name: 'requester role revocation', actor: { role: 'member' }, status: 403 },
  ]) {
    test(`reconciliation rejects ${change.name} ${boundary.name} and preserves unknown evidence`, async () => {
      const h = await harness(); let barrier, reconciling;
      try {
        barrier = await mcpBarrier(h, boundary);
        const updated = await h.request(`/resources/${h.resource.id}`, { ...barrier.resource, toolPolicies: {
          ...barrier.resource.toolPolicies,
          service_status: { ...barrier.resource.toolPolicies.service_status, roles: ['admin'] },
        } }, 'PUT');
        assert.equal(updated.status, 200);
        const resource = updated.data;
        h.fixtures.failWrites(true);
        const planned = await h.request('/executions/tool', proposal(h, 'reconcile-revocation-key'));
        assert.equal(planned.status, 202);
        assert.equal((await h.request(`/approvals/${planned.data.stepId}/approve`, {}, 'POST', h.reviewer)).status, 502);
        const before = (await h.request(`/executions/${planned.data.runId}`, undefined, 'GET', h.reviewer)).data;
        assert.equal(before.status, 'unknown'); assert.equal(before.steps[0].status, 'unknown');
        barrier.block();
        reconciling = h.request(`/approvals/${planned.data.stepId}/reconcile`, {}, 'POST', h.reviewer);
        reconciling.catch(() => {});
        await barrier.wait();
        assert.equal(h.fixtures.toolCalls.filter(c => c.name === 'service_status').length, boundary.reads);
        if (change.resource) {
          const changed = await h.request(`/resources/${resource.id}`, { ...resource, ...change.resource }, 'PUT');
          assert.equal(changed.status, 200);
          assert.ok(changed.data.revision > resource.revision);
        } else if (change.owner) {
          assert.equal((await h.request(`/users/${before.user_id}`, change.owner, 'PATCH', h.reviewer)).status, 200);
        } else {
          const actor = h.app.store.get("SELECT id FROM users WHERE username='reviewer'");
          assert.equal((await h.request(`/users/${actor.id}`, change.actor, 'PATCH')).status, 200);
        }
        barrier.release();
        const response = await reconciling;
        assert.equal(response.status, change.status, JSON.stringify(response.data));
        const after = (await h.request(`/executions/${planned.data.runId}`, undefined, 'GET', change.owner ? h.reviewer : undefined)).data;
        assert.equal(after.status, 'unknown'); assert.equal(after.steps[0].status, 'unknown');
        assert.deepEqual(after.result, before.result);
        assert.deepEqual(after.steps[0].verification, before.steps[0].verification);
        assert.deepEqual(after.steps[0].result, before.steps[0].result);
        assert.equal(after.error, before.error); assert.equal(after.steps[0].error, before.steps[0].error);
        assert.equal(h.fixtures.toolCalls.filter(c => c.name === 'service_status').length, boundary.reads);
        assert.equal(h.fixtures.toolCalls.filter(c => c.name === 'set_service_state').length, 1);
        assert.deepEqual(h.app.execution.stats(), { active: 0, queued: 0 });
      } finally {
        h.app.execution.stop();
        await barrier?.close();
        await reconciling?.catch(() => {});
        await h.close();
      }
    });
  }
}

test('cancelling an approval during discovery preserves cancellation without sending a write', async () => {
  const h = await harness(); let barrier;
  try {
    barrier = await mcpBarrier(h, { method: 'tools/list' });
    const first = await h.request('/executions/tool', proposal(h, 'cancel-before-write-key'));
    assert.equal(first.status, 202);
    barrier.block();
    const approving = h.request(`/approvals/${first.data.stepId}/approve`, {}, 'POST', h.reviewer);
    await barrier.wait();
    assert.equal(h.app.store.get('SELECT status FROM executions WHERE id=?', first.data.runId).status, 'running');
    assert.equal((await h.request(`/executions/${first.data.runId}/cancel`, {})).status, 200);
    const response = await approving;
    assert.equal(response.status, 409, JSON.stringify(response.data));
    assert.match(response.data.error, /取消/);
    const state = (await h.request(`/executions/${first.data.runId}`)).data;
    assert.equal(state.status, 'cancelled'); assert.equal(state.steps[0].status, 'cancelled');
    assert.equal(state.result, null);
    assert.equal(h.fixtures.toolCalls.filter(c => c.name === 'set_service_state').length, 0);
    assert.deepEqual(h.app.execution.stats(), { active: 0, queued: 0 });
    assert.equal((await h.request(`/approvals/${first.data.stepId}/approve`, {}, 'POST', h.reviewer)).status, 409);
    assert.equal(h.fixtures.toolCalls.filter(c => c.name === 'set_service_state').length, 0);
  } finally { await barrier?.close(); await h.close(); }
});

test('cancelling an approval after sending a write preserves unknown and does not replay', async () => {
  const h = await harness(); let barrier;
  try {
    barrier = await mcpBarrier(h, { method: 'tools/call', afterResponse: true });
    const first = await h.request('/executions/tool', proposal(h, 'cancel-after-write-key'));
    assert.equal(first.status, 202);
    barrier.block();
    const approving = h.request(`/approvals/${first.data.stepId}/approve`, {}, 'POST', h.reviewer);
    await barrier.wait();
    assert.equal(h.fixtures.toolCalls.filter(c => c.name === 'set_service_state').length, 1);
    assert.equal((await h.request(`/executions/${first.data.runId}/cancel`, {})).status, 200);
    const response = await approving;
    assert.equal(response.status, 409, JSON.stringify(response.data));
    assert.match(response.data.error, /取消/);
    const state = (await h.request(`/executions/${first.data.runId}`)).data;
    assert.equal(state.status, 'unknown'); assert.equal(state.steps[0].status, 'unknown');
    assert.equal(state.result, null);
    assert.deepEqual(h.app.execution.stats(), { active: 0, queued: 0 });
    assert.equal((await h.request(`/approvals/${first.data.stepId}/approve`, {}, 'POST', h.reviewer)).status, 409);
    assert.equal(h.fixtures.toolCalls.filter(c => c.name === 'set_service_state').length, 1);
  } finally { await barrier?.close(); await h.close(); }
});

test('run service bounds concurrency, queues, cancels, accounts budget and recovers interrupted runs', async () => {
  const h = await harness(); const previous = { ...process.env };
  try {
    process.env.MAX_ACTIVE_RUNS = '1'; process.env.MAX_USER_RUNS = '1';
    const user = h.app.store.get("SELECT * FROM users WHERE username='admin'");
    let release; const blocked = new Promise(resolve => { release = resolve; });
    const first = h.app.execution.run(user, { kind: 'tool', requestKey: 'blocking-first' }, async () => { await blocked; return { text: 'done' }; });
    await new Promise(resolve => setTimeout(resolve, 10));
    const second = h.app.execution.run(user, { kind: 'tool', requestKey: 'blocking-second' }, async () => { throw new Error('cancelled work must not run'); });
    const assertion = assert.rejects(second, /取消/);
    await new Promise(resolve => setTimeout(resolve, 10));
    assert.deepEqual(h.app.execution.stats(), { active: 1, queued: 1 });
    const queued = h.app.store.get("SELECT id FROM executions WHERE request_key='blocking-second'"); h.app.execution.cancel(user, queued.id);
    release(); await first; await assertion;
    process.env.DAILY_RUN_LIMIT = '2';
    await assert.rejects(h.app.execution.run(user, { kind: 'tool', requestKey: 'limit-third' }, async () => ({})), /预算/);
    h.app.store.run("UPDATE executions SET status='running' WHERE request_key='blocking-first'");
    await h.restart();
    assert.equal(h.app.store.get("SELECT status FROM executions WHERE request_key='blocking-first'").status, 'interrupted');
  } finally { for (const key of Object.keys(process.env)) if (!(key in previous)) delete process.env[key]; Object.assign(process.env, previous); await h.close(); }
});
