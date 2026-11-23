import { test } from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHmac } from 'node:crypto';
import { createApplication } from '../server/app.mjs';
import { openStore, id, now } from '../server/store.mjs';
import { createUser } from '../server/auth.mjs';
import { createScheduler } from '../server/scheduler.mjs';
import { assessInspection, inspectionRulesSchema } from '../server/inspection.mjs';
import { enqueueTaskNotification } from '../server/notifications.mjs';
import { listen, startFixtures } from './fixtures.mjs';

async function setup() {
  const root = mkdtempSync(join(tmpdir(), 'aiops-notifications-'));
  const received = []; let responseStatus = 200; let ack = { errcode: 0 }; let retryAfter = null;
  const receiver = express(); receiver.use(express.text({ type: 'application/json' }));
  receiver.post('/hook', (req, res) => { received.push({ body: req.body, headers: req.headers }); if (retryAfter) res.set('Retry-After', retryAfter); res.status(responseStatus).json(ack); });
  receiver.post('/slow-body', (req, res) => { res.status(200).type('json').flushHeaders(); const timer = setTimeout(() => res.end('{"errcode":0}'), 6000); res.on('close', () => clearTimeout(timer)); });
  receiver.post('/redirect', (req, res) => res.redirect(307, '/hook'));
  const endpoint = await listen(receiver); const app = createApplication({ dataDir: root, scheduler: false }); const http = await listen(app.app);
  const admin = createUser(app.store, { username: 'admin', password: 'notification-test-password' }, 'admin');
  const member = createUser(app.store, { username: 'member', password: 'notification-test-password' });
  async function request(path, method = 'GET', body, cookie = adminCookie) {
    const response = await fetch(http.url + '/api' + path, { method, headers: { 'Content-Type': 'application/json', Cookie: cookie || '' }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    return { status: response.status, data: await response.json(), cookie: response.headers.get('set-cookie')?.split(';')[0] };
  }
  let adminCookie = ''; adminCookie = (await request('/auth/login', 'POST', { username: 'admin', password: 'notification-test-password' })).cookie;
  const memberCookie = (await request('/auth/login', 'POST', { username: 'member', password: 'notification-test-password' }, '')).cookie;
  const channel = async (extra = {}) => { const result = await request('/notification-channels', 'POST', { name: '值班群', kind: 'webhook', endpoint: endpoint.url + '/hook', ...extra }); assert.equal(result.status, 201, JSON.stringify(result.data)); return result.data; };
  const testMessage = async cid => { const result = await request(`/notification-channels/${cid}/test`, 'POST', {}); assert.equal(result.status, 202); return result.data.deliveryId; };
  return { root, app, request, admin, member, memberCookie, endpoint, received, channel, testMessage, respond: (status, body = { errcode: 0 }, retry = null) => { responseStatus = status; ack = body; retryAfter = retry; }, close: async () => { await http.close(); await app.close(); await endpoint.close(); rmSync(root, { recursive: true, force: true }); } };
}
function seedRun(store, userId, rules = [], notification = {}) {
  const tid = id(); const rid = id();
  store.run('INSERT INTO tasks(id,user_id,name,prompt,schedule_type,timezone,enabled,created,updated,notification,inspection_rules) VALUES(?,?,?,?,?,?,?,?,?,?,?)', tid, userId, '巡检 A', '查询明确对象', 'cron', 'Asia/Shanghai', 0, now(), now(), JSON.stringify(notification), JSON.stringify(rules));
  store.run('INSERT INTO task_runs(id,task_id,status,started,finished,lease_until) VALUES(?,?,?,?,?,?)', rid, tid, 'success', now(), now(), 0);
  return { task: store.get('SELECT * FROM tasks WHERE id=?', tid), run: store.get('SELECT * FROM task_runs WHERE id=?', rid) };
}
const assessment = status => ({ status, reason: status, findings: [{ index: 0, label: '服务状态', status, evidence: [] }] });
const enqueue = (store, task, run, value) => store.transaction(() => enqueueTaskNotification(store, task, run, value));

test('channel credentials are encrypted, members are scoped, and edits use revision checks', async () => {
  const t = await setup();
  try {
    const secret = 'hmac-secret-for-notification-testing'; const c = await t.channel({ endpoint: t.endpoint.url + '/hook?key=private-robot-key', secret, token: 'private-bearer-token' });
    assert.ok(!JSON.stringify(c).includes(secret)); assert.ok(!JSON.stringify(c).includes('private-robot-key'));
    assert.ok(!t.app.store.get('SELECT config_encrypted FROM notification_channels').config_encrypted.includes(secret));
    assert.deepEqual((await t.request('/notification-channels', 'GET', undefined, t.memberCookie)).data, []);
    assert.equal((await t.request('/notification-channels', 'POST', { name: 'bad' }, t.memberCookie)).status, 403);
    assert.equal((await t.request('/tasks', 'POST', { name: 'private', prompt: 'check', scheduleType: 'cron', cron: '0 9 * * *', notification: { channelIds: [c.id] } }, t.memberCookie)).status, 403);
    const updated = await t.request(`/notification-channels/${c.id}`, 'PUT', { name: c.name, kind: c.kind, allowedUserIds: [t.member.id], revision: c.revision }); assert.equal(updated.status, 200);
    const publicView = (await t.request('/notification-channels', 'GET', undefined, t.memberCookie)).data[0]; assert.equal(publicView.name, c.name); assert.equal(publicView.endpointOrigin, undefined);
    assert.equal((await t.request(`/notification-channels/${c.id}`, 'PUT', { name: 'stale', kind: c.kind, revision: c.revision })).status, 409);
    assert.equal(JSON.parse(t.app.store.decrypt(t.app.store.get('SELECT config_encrypted FROM notification_channels').config_encrypted)).secret, secret);
    const did = await t.testMessage(c.id);
    assert.equal((await t.request(`/notification-deliveries/${did}`, 'GET', undefined, t.memberCookie)).status, 404);
    assert.equal((await t.request('/notification-deliveries', 'GET', undefined, t.memberCookie)).data.total, 0);
  } finally { await t.close(); }
});

test('webhook retry keeps the payload and delivery key, signs timestamp/body, and honours Retry-After', async () => {
  const t = await setup();
  try {
    const secret = 'hmac-secret-for-notification-testing'; const c = await t.channel({ secret }); const did = await t.testMessage(c.id);
    t.respond(429, {}, '60'); await t.app.notifications.tick();
    let row = t.app.store.get('SELECT * FROM notification_deliveries WHERE id=?', did); assert.equal(row.status, 'pending'); assert.ok(row.next_attempt >= Date.now() + 59000);
    assert.equal(t.received[0].headers['x-aiops-signature'], createHmac('sha256', secret).update(`${t.received[0].headers['x-aiops-timestamp']}.${t.received[0].body}`).digest('hex'));
    t.respond(200); t.app.store.run('UPDATE notification_deliveries SET next_attempt=0 WHERE id=?', did); await Promise.all([t.app.notifications.tick(), t.app.notifications.tick()]);
    row = t.app.store.get('SELECT * FROM notification_deliveries WHERE id=?', did); assert.equal(row.status, 'delivered'); assert.equal(row.attempts, 2);
    assert.equal(t.received.length, 2); assert.equal(t.received[0].body, t.received[1].body); assert.equal(t.received[0].headers['idempotency-key'], t.received[1].headers['idempotency-key']);
    assert.equal((await t.request(`/notification-deliveries/${did}/retry`, 'POST', {})).status, 409);
  } finally { await t.close(); }
});

test('WeCom requires business acknowledgement and manual resend reuses the saved message without rerunning a task', async () => {
  const t = await setup();
  try {
    const c = await t.channel({ kind: 'wecom' }); const did = await t.testMessage(c.id);
    t.respond(200, { errcode: 93000, errmsg: 'private-token-must-not-leak' }); await t.app.notifications.tick();
    let row = t.app.store.get('SELECT * FROM notification_deliveries WHERE id=?', did); assert.equal(row.status, 'failed'); assert.match(row.last_error, /93000/); assert.ok(!row.last_error.includes('private-token'));
    const sent = JSON.parse(t.received[0].body); assert.equal(sent.msgtype, 'text'); assert.match(sent.text.content, /测试消息/);
    assert.equal((await t.request(`/notification-deliveries/${did}/retry`, 'POST', {})).status, 202);
    t.respond(200); await t.app.notifications.tick(); row = t.app.store.get('SELECT * FROM notification_deliveries WHERE id=?', did); assert.equal(row.status, 'delivered');
    assert.equal(t.received[0].headers['idempotency-key'], t.received[1].headers['idempotency-key']); assert.equal(t.app.store.get('SELECT count(*) AS n FROM task_runs').n, 0);
  } finally { await t.close(); }
});

test('permanent errors, redirect, maximum retries, channel changes and permission revocation are observable', async () => {
  const t = await setup();
  try {
    const c = await t.channel(); const did = await t.testMessage(c.id); t.respond(400); await t.app.notifications.tick();
    assert.equal(t.app.store.get('SELECT status FROM notification_deliveries WHERE id=?', did).status, 'failed');
    await t.request(`/notification-deliveries/${did}/retry`, 'POST', {}); t.respond(503); t.app.store.run('UPDATE notification_deliveries SET attempts=7 WHERE id=?', did); await t.app.notifications.tick();
    assert.equal(t.app.store.get('SELECT status,attempts FROM notification_deliveries WHERE id=?', did).attempts, 8);
    assert.equal(t.app.store.get('SELECT status FROM notification_deliveries WHERE id=?', did).status, 'failed');
    await t.request(`/notification-deliveries/${did}/retry`, 'POST', {});
    await t.request(`/notification-channels/${c.id}`, 'PUT', { name: c.name, kind: c.kind, revision: c.revision }); const sent = t.received.length; await t.app.notifications.tick();
    assert.match(t.app.store.get('SELECT last_error FROM notification_deliveries WHERE id=?', did).last_error, /配置已变更/); assert.equal(t.received.length, sent);
    const redirect = await t.channel({ endpoint: t.endpoint.url + '/redirect' }); const redirectId = await t.testMessage(redirect.id); await t.app.notifications.tick(); assert.equal(t.app.store.get('SELECT status FROM notification_deliveries WHERE id=?', redirectId).status, 'failed'); assert.equal(t.received.length, sent);
    const memberChannel = await t.channel({ allowedUserIds: [t.member.id] }); const seeded = seedRun(t.app.store, t.member.id, [], { channelIds: [memberChannel.id] }); enqueue(t.app.store, seeded.task, seeded.run, assessment('unknown'));
    t.app.store.run("UPDATE notification_channels SET allowed_users='[]' WHERE id=?", memberChannel.id); await t.app.notifications.tick();
    assert.match(t.app.store.get('SELECT last_error FROM notification_deliveries WHERE channel_id=?', memberChannel.id).last_error, /权限已撤销/);
  } finally { await t.close(); }
});

test('actual evidence enforces object matching, scalar types, all conditions and freshness without trusting prose', async () => {
  const t = await setup();
  try {
    const store = t.app.store; const rid = id(); const sid = id(); const resourceId = id();
    store.run('INSERT INTO executions(id,user_id,request_key,input_hash,input,status,created,updated) VALUES(?,?,?,?,?,?,?,?)', rid, t.admin.id, id(), 'hash', store.encrypt('{}'), 'success', now(), now());
    store.run('INSERT INTO tool_steps(id,run_id,resource_id,resource_revision,tool,arguments_encrypted,environment,policy,status,created,updated,expires,result) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)', sid, rid, resourceId, 1, 'status', store.encrypt('{"jobid":"123"}'), 'test', '{"risk":"read"}', 'success', now(), now(), Date.now() + 1000, JSON.stringify({ health: 1, reported_at: now(), credential: '[REDACTED]' }));
    const rule = { label: '健康', resourceId, tool: 'status', arguments: { jobid: '123' }, path: 'health', operator: 'eq', expected: 1 };
    assert.equal(assessInspection(store, [rule], rid, 'success').status, 'healthy');
    assert.equal(assessInspection(store, [{ ...rule, expected: 2 }], rid, 'success').status, 'abnormal');
    for (const change of [{ expected: '1' }, { path: 'absent' }, { arguments: { jobid: '456' } }, { path: 'credential' }]) assert.equal(assessInspection(store, [{ ...rule, ...change }], rid, 'success').status, 'unknown');
    const fresh = { ...rule, path: 'reported_at', operator: 'fresh', expected: 60 };
    assert.equal(assessInspection(store, [rule, fresh], rid, 'success').status, 'healthy');
    assert.equal(assessInspection(store, [rule, fresh], rid, 'success', Date.now() + 61000).status, 'unknown');
    assert.equal(assessInspection(store, [rule], rid, 'failed').status, 'unknown'); assert.equal(assessInspection(store, [rule], null, 'success').status, 'unknown');
    assert.equal(assessInspection(store, [], rid, 'success').status, 'unknown'); assert.equal(inspectionRulesSchema.safeParse([{ ...rule, path: '__proto__.health' }]).success, false);
  } finally { await t.close(); }
});

test('event insertion is atomic and idempotent, duplicates are suppressed per channel, and recovery is delivered once', async () => {
  const t = await setup();
  try {
    const c = await t.channel(); const store = t.app.store; const first = seedRun(store, t.admin.id, [], { channelIds: [c.id], mode: 'issues', repeatMinutes: 60, recovery: true });
    assert.throws(() => store.transaction(() => { enqueueTaskNotification(store, first.task, first.run, assessment('abnormal')); throw new Error('rollback'); }));
    assert.equal(store.get('SELECT count(*) AS n FROM notification_events').n, 0);
    enqueue(store, first.task, first.run, assessment('abnormal')); enqueue(store, first.task, first.run, assessment('abnormal')); assert.equal(store.get('SELECT count(*) AS n FROM notification_deliveries').n, 1);
    const emit = value => { const run = { ...first.run, id: id() }; enqueue(store, store.get('SELECT * FROM tasks WHERE id=?', first.task.id), run, assessment(value)); };
    emit('abnormal'); assert.equal(store.get('SELECT count(*) AS n FROM notification_deliveries').n, 1);
    emit('healthy'); assert.equal(store.get('SELECT count(*) AS n FROM notification_deliveries').n, 2);
    emit('healthy'); assert.equal(store.get('SELECT count(*) AS n FROM notification_deliveries').n, 2);
    emit('abnormal'); assert.equal(store.get('SELECT count(*) AS n FROM notification_deliveries').n, 3);
    const state = JSON.parse(store.get('SELECT notification_state FROM tasks WHERE id=?', first.task.id).notification_state); state[c.id].notifiedAt = Date.now() - 3600001; store.run('UPDATE tasks SET notification_state=? WHERE id=?', JSON.stringify(state), first.task.id);
    emit('abnormal'); assert.equal(store.get('SELECT count(*) AS n FROM notification_deliveries').n, 4);
  } finally { await t.close(); }
});

test('real scheduler/model/MCP flow saves assessment and delivery, settings validate rules, and notifications do not affect execution', async () => {
  const t = await setup(); const fixtures = await startFixtures();
  try {
    await t.request('/settings/model', 'PUT', { baseUrl: fixtures.url + '/v1', model: 'fixture' });
    const resource = (await t.request('/resources', 'POST', { kind: 'mcp', name: '状态', endpoint: fixtures.url + '/mcp', token: 'fixture-mcp-secret', allowedTools: ['service_status'], toolPolicies: { service_status: { risk: 'read', roles: ['admin'], environments: ['test'] } } })).data;
    const c = await t.channel(); const rule = { label: '状态健康', resourceId: resource.id, tool: 'service_status', path: 'status', operator: 'eq', expected: 'healthy', arguments: { service: 'billing' } };
    const invalid = await t.request('/tasks', 'POST', { name: 'bad', prompt: 'test', scheduleType: 'cron', cron: '0 9 * * *', notification: { channelIds: [c.id], mode: 'issues' } }); assert.equal(invalid.status, 400);
    const created = await t.request('/tasks', 'POST', { name: '巡检', prompt: '调用工具检查 billing', scheduleType: 'cron', cron: '0 9 * * *', inspectionRules: [rule], notification: { channelIds: [c.id] } }); assert.equal(created.status, 201, JSON.stringify(created.data));
    const task = created.data; await t.request(`/tasks/${task.id}/run`, 'POST', {});
    let run; for (let n = 0; n < 200; n++) { run = (await t.request(`/tasks/${task.id}/runs`)).data[0]; if (run?.status !== 'running') break; await new Promise(resolve => setTimeout(resolve, 20)); }
    assert.equal(run.status, 'success'); assert.equal(run.assessment.status, 'healthy'); assert.equal(run.deliveries.length, 1); assert.ok(run.execution_id); assert.ok(run.conversation_id);
    t.respond(403); await t.app.notifications.tick(); assert.equal((await t.request(`/tasks/${task.id}/runs`)).data[0].status, 'success');
    assert.equal((await t.request(`/tasks/${task.id}/runs`)).data[0].deliveries[0].status, 'failed');
    const updated = await t.request(`/tasks/${task.id}/notification`, 'PATCH', { notification: { channelIds: [c.id], mode: 'issues' }, inspectionRules: [rule] }); assert.equal(updated.status, 200);
    assert.equal((await t.request(`/tasks/${task.id}/notification`, 'PATCH', { notification: { channelIds: [c.id] } }, t.memberCookie)).status, 404);
  } finally { await fixtures.close(); await t.close(); }
});

test('process restart marks old task work interrupted and enqueues only once, while pending deliveries survive', async () => {
  const t = await setup();
  try {
    const c = await t.channel(); const { task, run } = seedRun(t.app.store, t.admin.id, [], { channelIds: [c.id] });
    t.app.store.run("UPDATE task_runs SET status='running',finished=NULL,lease_until=? WHERE id=?", Date.now() + 180000, run.id);
    const scheduler = createScheduler(t.app.store, { execute: () => { throw new Error('must not run'); } });
    assert.equal(t.app.store.get('SELECT status FROM task_runs WHERE id=?', run.id).status, 'interrupted');
    scheduler.tick(); assert.equal(t.app.store.get('SELECT count(*) AS n FROM notification_events WHERE task_id=?', task.id).n, 1);
    await scheduler.stop(); await t.app.notifications.tick(); assert.equal(t.app.store.get('SELECT status FROM notification_deliveries').status, 'delivered');
  } finally { await t.close(); }
});

test('v3 databases migrate without losing tasks or legacy notifications and can reopen v6', () => {
  const root = mkdtempSync(join(tmpdir(), 'aiops-notification-migration-')); let store = openStore(root);
  try {
    const user = createUser(store, { username: 'migration', password: 'migration-test-password' }, 'admin'); const seeded = seedRun(store, user.id);
    store.run('INSERT INTO notifications(id,kind,payload,created) VALUES(?,?,?,?)', 'legacy', 'test', '{}', now());
    store.db.exec('DROP TABLE agent_delegations; DROP INDEX tool_steps_call_key; ALTER TABLE tool_steps DROP COLUMN call_key; ALTER TABLE tool_steps DROP COLUMN call_hash; ALTER TABLE tool_steps DROP COLUMN response_encrypted; ALTER TABLE executions DROP COLUMN runtime; ALTER TABLE executions DROP COLUMN runtime_version; DROP TABLE notification_deliveries; DROP TABLE notification_events; DROP TABLE notification_channels; ALTER TABLE tasks DROP COLUMN target_binding; ALTER TABLE tasks DROP COLUMN notification; ALTER TABLE tasks DROP COLUMN inspection_rules; ALTER TABLE tasks DROP COLUMN notification_state; ALTER TABLE task_runs DROP COLUMN execution_id; ALTER TABLE task_runs DROP COLUMN assessment; PRAGMA user_version=3;');
    store.close(); store = openStore(root); assert.equal(store.get('PRAGMA user_version').user_version, 7); assert.equal(store.get('SELECT name FROM tasks WHERE id=?', seeded.task.id).name, '巡检 A'); assert.equal(store.get('SELECT target_binding FROM tasks WHERE id=?', seeded.task.id).target_binding, null); assert.equal(store.get('SELECT id FROM notifications').id, 'legacy');
    store.close(); store = openStore(root); assert.equal(store.get('PRAGMA user_version').user_version, 7);
  } finally { store.close(); rmSync(root, { recursive: true, force: true }); }
});

test('pending and in-flight delivery identity survive a real store reopen without losing the snapshot', async () => {
  const root = mkdtempSync(join(tmpdir(), 'aiops-outbox-restart-')); const received = [];
  const receiver = express(); receiver.use(express.json()); receiver.post('/hook', (req, res) => { received.push({ key: req.get('idempotency-key'), event: req.body.id }); res.sendStatus(204); }); const endpoint = await listen(receiver);
  let store = openStore(root); let notifications;
  try {
    const user = createUser(store, { username: 'restart', password: 'restart-test-password' }, 'admin'); const cid = id();
    store.run('INSERT INTO notification_channels(id,name,kind,config_encrypted,created,updated) VALUES(?,?,?,?,?,?)', cid, '恢复', 'webhook', store.encrypt(JSON.stringify({ endpoint: endpoint.url + '/hook' })), now(), now());
    const seeded = seedRun(store, user.id, [], { channelIds: [cid] }); enqueue(store, seeded.task, seeded.run, assessment('unknown'));
    const delivery = store.get('SELECT * FROM notification_deliveries'); store.run("UPDATE notification_deliveries SET status='sending' WHERE id=?", delivery.id);
    store.close(); store = openStore(root);
    const { createNotifications } = await import('../server/notifications.mjs'); notifications = createNotifications(store);
    await notifications.tick(); assert.deepEqual(received, [{ key: delivery.id, event: delivery.event_id }]); assert.equal(store.get('SELECT status FROM notification_deliveries').status, 'delivered');
    assert.equal(store.get('SELECT count(*) AS n FROM notification_events').n, 1);
  } finally { await notifications?.close(); store.close(); await endpoint.close(); rmSync(root, { recursive: true, force: true }); }
});

test('WeCom text is UTF-8 bounded and preserves its configured detail link, and missing acknowledgement fails', async () => {
  const t = await setup(); const previousOrigin = process.env.APP_ORIGIN;
  try {
    process.env.APP_ORIGIN = 'https://workspace.example.com';
    const c = await t.channel({ kind: 'wecom' }); const seeded = seedRun(t.app.store, t.admin.id, [], { channelIds: [c.id] });
    seeded.run.result = '中文巡检摘要与证据。'.repeat(500);
    enqueue(t.app.store, seeded.task, seeded.run, assessment('unknown')); t.respond(200, {}); await t.app.notifications.tick();
    const text = JSON.parse(t.received[0].body).text.content;
    assert.ok(Buffer.byteLength(text) <= 2048, Buffer.byteLength(text)); assert.match(text, /查看详情：https:\/\/workspace.example.com\/#tasks\?/); assert.match(text, /Asia\/Shanghai/);
    assert.equal(t.app.store.get('SELECT status FROM notification_deliveries').status, 'failed');
    assert.match(t.app.store.get('SELECT last_error FROM notification_deliveries').last_error, /缺少成功确认/);
    const did = t.app.store.get('SELECT id FROM notification_deliveries').id; await t.request(`/notification-deliveries/${did}/retry`, 'POST', {}); t.respond(200, null); await t.app.notifications.tick();
    assert.equal(t.app.store.get('SELECT status FROM notification_deliveries').status, 'failed');
    assert.match(t.app.store.get('SELECT last_error FROM notification_deliveries').last_error, /缺少成功确认/);
  } finally { if (previousOrigin === undefined) delete process.env.APP_ORIGIN; else process.env.APP_ORIGIN = previousOrigin; await t.close(); }
});


test('a response body timeout remains retryable after receiving HTTP headers', async () => {
  const t = await setup();
  try {
    const c = await t.channel({ kind: 'wecom', endpoint: t.endpoint.url + '/slow-body' }); const did = await t.testMessage(c.id);
    await t.app.notifications.tick(); const row = t.app.store.get('SELECT * FROM notification_deliveries WHERE id=?', did);
    assert.equal(row.status, 'pending'); assert.equal(row.attempts, 1); assert.match(row.last_error, /连接失败或/);
  } finally { await t.close(); }
});
