import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHmac } from 'node:crypto';
import { createApplication } from '../server/app.mjs';
import { listen, startFixtures } from './fixtures.mjs';

test('reviewed runbook: signed alert, fixed scoped tools, result verification, replay and revocation', async () => {
  const root = mkdtempSync(join(tmpdir(), 'aiops-scenario-')); const previous = { ...process.env };
  process.env.ENABLE_AUTO_REMEDIATION = 'true'; process.env.RUNBOOK_WEBHOOK_SECRET = 'runbook-test-secret-at-least-32-bytes';
  const fixtures = await startFixtures(); const app = createApplication({ dataDir: root, scheduler: false }); const http = await listen(app.app); let cookie = '';
  const call = async (path, body, method = body ? 'POST' : 'GET', who = cookie) => { const r = await fetch(http.url + '/api' + path, { method, headers: { Cookie: who, 'Content-Type': 'application/json' }, ...(body ? { body: JSON.stringify(body) } : {}) }); return { status: r.status, data: await r.json(), cookie: r.headers.get('set-cookie')?.split(';')[0] }; };
  try {
    cookie = (await call('/auth/setup', { username: 'admin', password: 'long-admin-password' })).cookie;
    await call('/users', { username: 'reviewer', password: 'long-review-password', role: 'admin' });
    const reviewer = (await call('/auth/login', { username: 'reviewer', password: 'long-review-password' })).cookie;
    const connector = (await call('/resources', { kind: 'mcp', name: 'runbook-service', endpoint: fixtures.url + '/mcp', token: 'fixture-mcp-secret', allowedTools: ['service_status', 'set_service_state'], toolPolicies: {
      service_status: { risk: 'read', constraints: { service: ['billing'] } },
      set_service_state: { risk: 'write', automatic: true, constraints: { service: ['billing'], state: ['maintenance'] }, idempotencyArgument: 'idempotencyKey', verification: { tool: 'service_status', arguments: { service: 'billing' }, path: 'status', equals: 'maintenance' }, recovery: '人工审核后恢复 healthy' },
    } })).data;
    const runbook = await call('/runbooks', { name: '限定服务的巡检与维护', steps: [
      { resourceId: connector.id, tool: 'service_status', arguments: { service: 'billing' }, environment: 'test' },
      { resourceId: connector.id, tool: 'set_service_state', arguments: { service: 'billing', state: 'maintenance' }, environment: 'test' },
    ] }); assert.equal(runbook.status, 201, JSON.stringify(runbook.data));
    const rid = runbook.data.id;
    assert.equal((await call(`/runbooks/${rid}/publish`, { revision: 1 })).status, 403);
    assert.equal((await call(`/runbooks/${rid}/publish`, { revision: 1 }, 'POST', reviewer)).status, 200);
    const body = JSON.stringify({ eventId: 'alert-event-0001' }); const timestamp = String(Date.now());
    const signature = createHmac('sha256', process.env.RUNBOOK_WEBHOOK_SECRET).update(`${timestamp}.${rid}.${body}`).digest('hex');
    const deliver = () => fetch(http.url + `/hooks/runbooks/${rid}`, { method: 'POST', body, headers: { 'Content-Type': 'application/json', 'X-AIOps-Timestamp': timestamp, 'X-AIOps-Signature': signature } });
    const first = await deliver(); assert.equal(first.status, 200, JSON.stringify(await first.clone().json()));
    const runId = (await first.json()).runId; assert.equal((await (await deliver()).json()).runId, runId);
    const execution = (await call(`/executions/${runId}`)).data;
    assert.equal(execution.runtime, 'direct'); assert.equal(execution.runtime_version, '1');
    assert.equal(fixtures.requests.length, 0);
    assert.equal(fixtures.toolCalls.filter(c => c.name === 'set_service_state').length, 1);
    await call(`/runbooks/${rid}/disable`, {}); assert.equal((await deliver()).status, 404);
  } finally { await http.close(); await app.close(); await fixtures.close(); for (const key of Object.keys(process.env)) if (!(key in previous)) delete process.env[key]; Object.assign(process.env, previous); rmSync(root, { recursive: true, force: true }); }
});

test('persistent Chinese index excludes expired and unauthorized documents and cites revisions', async () => {
  const root = mkdtempSync(join(tmpdir(), 'aiops-knowledge-')); const app = createApplication({ dataDir: root, scheduler: false }); const http = await listen(app.app); let cookie = '';
  const call = async (path, body) => { const r = await fetch(http.url + '/api' + path, { method: 'POST', headers: { Cookie: cookie, 'Content-Type': 'application/json' }, body: JSON.stringify(body) }); return { data: await r.json(), cookie: r.headers.get('set-cookie')?.split(';')[0] }; };
  try {
    cookie = (await call('/auth/setup', { username: 'admin', password: 'long-admin-password' })).cookie;
    const resource = (await call('/resources', { kind: 'knowledge', name: '计费故障手册', body: '连接池耗尽会造成计费服务超时，检查数据库连接数。', documentVersion: '2026.09', visibility: 'public' })).data;
    await call('/resources', { kind: 'knowledge', name: '过期计费手册', body: '计费服务超时旧方案', expiresAt: '2020-01-01T00:00:00.000Z' });
    const matches = (await call('/knowledge/search', { query: '计费服务超时' })).data;
    assert.equal(matches.length, 1); assert.equal(matches[0].resourceId, resource.id); assert.equal(matches[0].documentVersion, '2026.09'); assert.equal(matches[0].revision, 1);
    assert.ok(app.store.get('SELECT count(*) AS n FROM knowledge_search').n > 0);
  } finally { await http.close(); await app.close(); rmSync(root, { recursive: true, force: true }); }
});
