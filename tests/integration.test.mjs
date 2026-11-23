import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createApplication } from '../server/app.mjs';
import { nextRun } from '../server/scheduler.mjs';
import { listen, startFixtures } from './fixtures.mjs';

let app, running, fixtures, dir, adminCookie, memberCookie, member, knowledge, connector, conversation, taskId;
async function request(path, { cookie = adminCookie, method = 'GET', body, headers = {} } = {}) {
  const response = await fetch(`${running.url}/api${path}`, { method, headers: { 'Content-Type': 'application/json', ...(cookie ? { Cookie: cookie } : {}), ...headers }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  const data = await response.json();
  return { status: response.status, data, cookie: response.headers.get('set-cookie')?.split(';')[0] };
}
async function waitForRun(tid) {
  for (let i = 0; i < 400; i++) {
    const { data } = await request(`/tasks/${tid}/runs`);
    if (data[0] && data[0].status !== 'running') return data[0];
    await new Promise(resolve => setTimeout(resolve, 30));
  }
  throw new Error('Task did not finish');
}

before(async () => {
  delete process.env.ADMIN_USERNAME; delete process.env.ADMIN_PASSWORD;
  dir = mkdtempSync(join(tmpdir(), 'aiops-integration-'));
  fixtures = await startFixtures(); app = createApplication({ dataDir: dir, scheduler: false }); running = await listen(app.app);
});
after(async () => { await running?.close(); await app?.close(); await fixtures?.close(); rmSync(dir, { recursive: true, force: true }); });

test('first-run setup, hashed credentials, authentication and origin checks', async () => {
  assert.equal((await request('/resources', { cookie: '' })).status, 401);
  assert.equal((await request('/auth/status', { cookie: '' })).data.initialized, false);
  const setup = await request('/auth/setup', { method: 'POST', cookie: '', body: { username: 'admin', name: '管理员', password: 'test-admin-password-123' } });
  assert.equal(setup.status, 201); adminCookie = setup.cookie;
  assert.equal(setup.data.role, 'admin'); assert.ok(!('password' in setup.data));
  assert.notEqual(app.store.get('SELECT password FROM users').password, 'test-admin-password-123');
  assert.equal((await request('/auth/setup', { method: 'POST', body: {} })).status, 409);
  assert.equal((await request('/auth/login', { cookie: '', method: 'POST', body: { username: 'admin', password: 'wrong' } })).status, 401);
  assert.equal((await request('/resources', { method: 'POST', body: {}, headers: { Origin: 'https://other.example' } })).status, 403);
});

test('model settings encrypt keys, redact responses, and reach a real HTTP protocol endpoint', async () => {
  const result = await request('/settings/model', { method: 'PUT', body: { baseUrl: `${fixtures.url}/v1`, model: 'fixture-model', apiKey: 'fixture-model-secret' } });
  assert.equal(result.status, 200); assert.equal(result.data.hasApiKey, true);
  assert.ok(!JSON.stringify(result.data).includes('fixture-model-secret'));
  assert.ok(!app.store.get('SELECT value FROM settings WHERE key=?', 'model').value.includes('fixture-model-secret'));
  assert.equal((await request('/settings/model/test', { method: 'POST', body: {} })).status, 200);
  await request('/settings/model', { method: 'PUT', body: { baseUrl: `${fixtures.url}/v1`, model: 'fixture-model' } });
  assert.equal(app.store.decrypt(app.store.setting('model').apiKeyEncrypted), 'fixture-model-secret');
});

test('user roles deny administrator APIs and private-resource access on the server', async () => {
  const created = await request('/users', { method: 'POST', body: { username: 'member', name: '普通成员', password: 'test-member-password-123', role: 'member' } });
  assert.equal(created.status, 201); member = created.data;
  const login = await request('/auth/login', { cookie: '', method: 'POST', body: { username: 'member', password: 'test-member-password-123' } }); memberCookie = login.cookie;
  assert.equal((await request('/settings/model', { cookie: memberCookie })).status, 403);
  assert.equal((await request('/users', { cookie: memberCookie })).status, 403);
  const result = await request('/resources', { method: 'POST', body: { kind: 'knowledge', name: '计费服务接入手册', body: '计费服务超时排查：检查连接池，重试阈值为三次。PRIVATE_SENTINEL', visibility: 'private' } });
  knowledge = result.data; assert.equal(result.status, 201);
  assert.equal((await request('/resources', { cookie: memberCookie })).data.length, 0);
  assert.equal((await request(`/resources/${knowledge.id}`, { cookie: memberCookie, method: 'PUT', body: knowledge })).status, 404);
  assert.equal((await request(`/resources/${knowledge.id}`, { cookie: memberCookie, method: 'DELETE', body: {} })).status, 404);
  assert.equal((await request('/resources', { cookie: memberCookie, method: 'POST', body: { kind: 'mcp', name: 'forbidden', endpoint: `${fixtures.url}/mcp` } })).status, 403);
});

test('Chinese knowledge retrieval and model context respect resource visibility', async () => {
  const matches = await request('/knowledge/search', { method: 'POST', body: { query: '计费服务超时' } });
  assert.equal(matches.data[0].resourceId, knowledge.id);
  const hidden = await request('/knowledge/search', { cookie: memberCookie, method: 'POST', body: { query: '计费服务超时' } }); assert.equal(hidden.data.length, 0);
  const chat = await request('/chat', { cookie: memberCookie, method: 'POST', body: { text: '计费服务超时如何排查？' } });
  assert.equal(chat.status, 200); assert.ok(!JSON.stringify(fixtures.requests.at(-1)).includes('PRIVATE_SENTINEL'));
  const updated = await request(`/resources/${knowledge.id}`, { method: 'PUT', body: { ...knowledge, visibility: 'public' } }); assert.equal(updated.status, 200); knowledge = updated.data;
  const answer = await request('/chat', { cookie: memberCookie, method: 'POST', body: { text: '计费服务超时如何排查？' } });
  assert.equal(answer.status, 200); assert.equal(answer.data.metadata.sources[0].resourceId, knowledge.id);
  assert.ok(JSON.stringify(fixtures.requests.at(-1)).includes('PRIVATE_SENTINEL'));
  conversation = answer.data.conversationId;
});

test('MCP SDK discovers tools, encrypts credentials, and blocks unapproved execution', async () => {
  const created = await request('/resources', { method: 'POST', body: { kind: 'mcp', name: '健康状态工具', endpoint: `${fixtures.url}/mcp`, token: 'fixture-mcp-secret', visibility: 'public' } });
  assert.equal(created.status, 201); connector = created.data;
  assert.ok(!JSON.stringify(connector).includes('fixture-mcp-secret'));
  assert.ok(!app.store.get('SELECT data FROM resources WHERE id=?', connector.id).data.includes('fixture-mcp-secret'));
  const discovery = await request(`/mcp/${connector.id}/discover`, { method: 'POST', body: {} });
  assert.equal(discovery.status, 200); assert.deepEqual(discovery.data.map(t => t.name).sort(), ['dangerous_operation', 'service_status', 'set_service_state']);
  assert.equal((await request(`/mcp/${connector.id}/call`, { method: 'POST', body: { name: 'dangerous_operation' } })).status, 403);
  const updated = await request(`/resources/${connector.id}`, { method: 'PUT', body: { ...connector, allowedTools: ['service_status'], toolPolicies: { service_status: { risk: 'read', roles: ['admin', 'member'], environments: ['test'] } } } }); connector = updated.data;
  const tested = await request(`/mcp/${connector.id}/call`, { method: 'POST', headers: { 'Idempotency-Key': 'direct-mcp-probe' }, body: { name: 'service_status', arguments: { service: 'billing' } } });
  assert.equal(tested.status, 200);
  const direct = app.store.get('SELECT runtime,runtime_version FROM executions WHERE request_key=?', 'direct-mcp-probe');
  assert.equal(direct.runtime, 'direct'); assert.equal(direct.runtime_version, '1');
  assert.equal((await request(`/mcp/${connector.id}/discover`, { cookie: memberCookie, method: 'POST', body: {} })).status, 404);
});

test('Agent runs actual MCP tool calls and rejects hallucinated or unauthorized tool names', async () => {
  const result = await request('/chat', { cookie: memberCookie, method: 'POST', body: { text: '请调用工具检查计费服务' } });
  assert.equal(result.status, 200); assert.ok(result.data.text.includes('healthy')); assert.equal(result.data.metadata.tools[0].tool, 'service_status');
  const execution = app.store.get('SELECT runtime,runtime_version FROM executions WHERE id=?', result.data.runId);
  assert.equal(execution.runtime, 'agentscope'); assert.match(execution.runtime_version, /^2\.0\.8\/bridge-v/);
  assert.ok(fixtures.toolCalls.some(c => c.service === 'billing'));
  const forbidden = await request('/chat', { method: 'POST', body: { text: '未授权工具' } }); assert.equal(forbidden.status, 403);
  assert.ok(!fixtures.toolCalls.some(c => c.name === 'dangerous_operation'));
  const messages = (await request(`/conversations/${forbidden.data.conversationId}`)).data.messages;
  assert.equal(messages.at(-1).role, 'error');
});

test('subdomain bindings load only authorized selected resources', async () => {
  const skill = (await request('/resources', { method: 'POST', body: { kind: 'skills', name: '诊断流程', body: 'SKILL_SENTINEL 按检查、分析、建议输出。', visibility: 'public' } })).data;
  const agent = (await request('/resources', { method: 'POST', body: { kind: 'agents', name: '计费领域', body: 'AGENT_SENTINEL 只处理计费。', visibility: 'public', skillIds: [skill.id], knowledgeIds: [], mcpIds: [] } })).data;
  const answer = await request('/chat', { cookie: memberCookie, method: 'POST', body: { text: '计费服务超时', agentId: agent.id } }); assert.equal(answer.status, 200);
  const input = fixtures.requests.at(-1);
  assert.ok(input.messages[0].content.includes('SKILL_SENTINEL')); assert.ok(input.messages[0].content.includes('AGENT_SENTINEL'));
  assert.ok(!input.messages[0].content.includes('PRIVATE_SENTINEL')); assert.equal(input.tools, undefined);
});

test('conversation authorization, busy locks, NDJSON progress and persisted history', async () => {
  const adminChat = await request('/chat', { method: 'POST', body: { text: '管理员会话' } });
  assert.equal((await request(`/conversations/${adminChat.data.conversationId}`, { cookie: memberCookie })).status, 404);
  assert.equal((await request('/chat', { method: 'POST', body: { text: '接管会话', conversationId: conversation } })).status, 403);
  const response = await fetch(`${running.url}/api/chat`, { method: 'POST', headers: { Cookie: memberCookie, 'Content-Type': 'application/json', Accept: 'application/x-ndjson' }, body: JSON.stringify({ text: '计费服务超时', conversationId: conversation }) });
  const events = (await response.text()).trim().split('\n').map(JSON.parse);
  assert.equal(events[0].type, 'execution'); assert.ok(events.some(e => e.type === 'session')); assert.ok(events.some(e => e.type === 'progress')); assert.equal(events.at(-1).type, 'done');
  const first = request('/chat', { cookie: memberCookie, method: 'POST', body: { text: '慢速回答', conversationId: conversation } });
  await new Promise(resolve => setTimeout(resolve, 30));
  assert.equal((await request('/chat', { cookie: memberCookie, method: 'POST', body: { text: '并发回答', conversationId: conversation } })).status, 409);
  assert.equal((await first).status, 200);
  assert.ok((await request(`/conversations/${conversation}`, { cookie: memberCookie })).data.messages.length >= 6);
});

test('cron timezone validation and task authorization', async () => {
  assert.equal(nextRun({ schedule_type: 'cron', cron: '0 9 * * *', timezone: 'Asia/Shanghai' }, new Date('2026-09-19T00:00:00Z')), '2026-09-19T01:00:00.000Z');
  assert.equal((await request('/tasks', { method: 'POST', body: { name: 'bad', prompt: 'test', scheduleType: 'cron', cron: 'every minute' } })).status, 400);
  assert.equal((await request('/tasks', { method: 'POST', body: { name: 'past', prompt: 'test', scheduleType: 'once', runAt: '2020-01-01T00:00:00Z' } })).status, 400);
  const created = await request('/tasks', { method: 'POST', body: { name: '周期巡检', prompt: '慢速调用工具检查服务', scheduleType: 'cron', cron: '0 9 * * *' } });
  assert.equal(created.status, 201); taskId = created.data.id;
  assert.equal((await request(`/tasks/${taskId}/run`, { cookie: memberCookie, method: 'POST', body: {} })).status, 404);
});

test('task execution is claimed once, records real outcomes, and supports pause/resume', async () => {
  assert.equal((await request(`/tasks/${taskId}/run`, { method: 'POST', body: {} })).status, 202);
  assert.equal((await request(`/tasks/${taskId}/run`, { method: 'POST', body: {} })).status, 409);
  assert.equal((await request(`/tasks/${taskId}`, { method: 'DELETE', body: {} })).status, 409);
  const run = await waitForRun(taskId); assert.equal(run.status, 'success'); assert.ok(run.result.includes('healthy')); assert.ok(run.conversation_id);
  await request(`/tasks/${taskId}`, { method: 'PATCH', body: { enabled: false } });
  assert.equal((await request('/tasks')).data.find(t => t.id === taskId).enabled, 0);
  await request(`/tasks/${taskId}`, { method: 'PATCH', body: { enabled: true } });
  assert.equal((await request('/tasks')).data.find(t => t.id === taskId).enabled, 1);
});

test('scheduler automatically runs due single jobs, persists failure, and marks interrupted leases', async () => {
  const created = await request('/tasks', { method: 'POST', body: { name: '到期单次任务', prompt: '慢速回答', scheduleType: 'once', runAt: new Date(Date.now() + 60000).toISOString() } });
  const tid = created.data.id;
  app.store.run('UPDATE tasks SET next_run=? WHERE id=?', new Date(Date.now() - 1000).toISOString(), tid);
  app.scheduler.tick(); app.scheduler.tick();
  const completed = await waitForRun(tid); assert.equal(completed.status, 'success');
  assert.equal((await request(`/tasks/${tid}/runs`)).data.length, 1);
  assert.equal((await request('/tasks')).data.find(t => t.id === tid).enabled, 0);
  fixtures.failModel(true);
  await request(`/tasks/${tid}/run`, { method: 'POST', body: {} });
  const failed = await waitForRun(tid); assert.equal(failed.status, 'failed'); assert.ok(failed.error.includes('503'));
  fixtures.failModel(false);
  app.store.run("INSERT INTO task_runs(id,task_id,status,started,lease_until) VALUES('crashed',?,'running',?,0)", tid, new Date().toISOString());
  app.scheduler.tick(); assert.equal(app.store.get("SELECT status FROM task_runs WHERE id='crashed'").status, 'interrupted');
});

test('data, credentials, tasks and conversations survive process storage reopen', async () => {
  await running.close(); await app.close();
  app = createApplication({ dataDir: dir, scheduler: false }); running = await listen(app.app);
  assert.equal((await request('/auth/me')).status, 200);
  assert.ok((await request('/resources')).data.some(r => r.id === knowledge.id));
  assert.ok((await request('/tasks')).data.some(t => t.id === taskId));
  assert.ok((await request(`/conversations/${conversation}`)).data.messages.length > 0);
  assert.equal(app.store.decrypt(app.store.setting('model').apiKeyEncrypted), 'fixture-model-secret');
  const audit = await request('/audit'); assert.ok(audit.data.some(a => a.action === 'tool.finish'));
  assert.ok(!JSON.stringify(audit.data).includes('fixture-model-secret'));
});

test('disabled users and logout invalidate existing session cookies', async () => {
  await request(`/users/${member.id}`, { method: 'PATCH', body: { active: false } });
  assert.equal((await request('/resources', { cookie: memberCookie })).status, 401);
  await request('/auth/logout', { method: 'POST', body: {} });
  assert.equal((await request('/resources')).status, 401);
});
