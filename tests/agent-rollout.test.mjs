import test from 'node:test';
import assert from 'node:assert/strict';
import { createRollout } from '../server/agent-rollout.mjs';
import { runtimeOptions } from '../server/agent-runtime/index.mjs';
import { runtimeFixture } from './runtime-fixture.mjs';

const path = '/settings/agent-rollout';
const draft = { agentIds: [], includeGeneral: true, contextMode: 'budgeted', retrievalMode: 'diverse', evidenceReports: true };
async function agent(h) {
  const r = (await h.request('/resources', { kind: 'agents', name: '灰度测试', body: '按事实回答' })).data;
  return (await h.request(`/resources/${r.id}/publish`, { revision: r.revision })).data;
}
const fake = () => ({ warmup: async () => {}, close: async () => {} });

test('enhancement API: admin-only, strict CAS, save is inert, pause keeps AgentScope required across restart and idempotency', async () => {
  const h = await runtimeFixture({ runtime: 'agentscope', evidenceReports: true });
  try {
    let state = (await h.request(path)).data;
    assert.equal(state.mode, 'deployment'); assert.equal(state.revision, 0);
    assert.equal(state.runtimeRequired, true); assert.equal(state.deployment.runtime, 'agentscope');
    assert.equal(state.deployment.agentIds, undefined);
    await h.request('/users', { username: 'member', password: 'member-test-password', role: 'member' });
    const member = (await h.request('/auth/login', { username: 'member', password: 'member-test-password' })).cookie;
    for (const [url, body, method] of [[path, undefined, 'GET'], [path, { revision: 0, draft }, 'PUT'], ...['preflight', 'activate', 'pause'].map(a => [path + '/' + a, { revision: 0 }, 'POST'])]) assert.equal((await h.request(url, body, method, member)).status, 403);
    assert.equal((await h.request(path, { revision: 0, draft: { ...draft, python: 'injection' } }, 'PUT')).status, 400);
    state = (await h.request(path, { revision: 0, draft }, 'PUT')).data;
    assert.equal(state.mode, 'deployment'); assert.equal(state.revision, 1);
    assert.equal((await h.request(path, { revision: 0, draft }, 'PUT')).status, 409);
    assert.equal((await h.request(path + '/activate', { revision: 1 })).status, 409);
    const original = (await h.request('/chat', { text: '原始', requestKey: 'rollout-dedupe-key' })).data;
    assert.equal(original.metadata.runtimePolicy.mode, 'deployment'); assert.ok(original.metadata.evidenceReport);
    state = (await h.request(path + '/pause', { revision: 1 })).data;
    assert.equal(state.mode, 'paused');
    const next = (await h.request('/chat', { text: '暂停后的执行' })).data;
    assert.equal(next.metadata.runtimePolicy.runtime, 'agentscope'); assert.equal(next.metadata.runtimePolicy.evidenceReports, false);
    assert.equal(next.metadata.evidenceReport, undefined);
    assert.equal((await h.request('/chat', { text: '原始', requestKey: 'rollout-dedupe-key' })).data.runId, original.runId);
    assert.equal(h.requests.length, 2);
    await h.restart({ runtime: 'agentscope', python: '/absent/python', evidenceReports: true });
    await assert.rejects(h.app.engine.warmup(), { status: 503 });
    assert.equal(h.app.engine.health().ready, false); assert.ok(['cold', 'prefork'].includes(h.app.engine.health().mode));
    assert.equal((await fetch(h.url + '/readyz')).status, 503);
    assert.equal((await h.request(path)).data.mode, 'paused');
    assert.equal((await h.request(path)).data.runtimeRequired, true);
    const replay = (await h.request('/chat', { text: '原始', requestKey: 'rollout-dedupe-key' })).data;
    assert.deepEqual(replay.metadata.runtimePolicy, original.metadata.runtimePolicy); assert.equal(h.requests.length, 2);
    assert.equal((await h.request('/chat', { text: '暂停增强仍要求 Worker' })).status, 503);
    assert.equal(h.requests.length, 2);
    assert.ok(h.app.store.get("SELECT * FROM audit WHERE action='agent.rollout.pause'"));
  } finally { await h.close(); }
});

test('rollout preflight failure leaves deployment untouched and closes its isolated driver', async () => {
  const h = await runtimeFixture({ runtime: 'agentscope', python: '/absent/python', startupTimeoutMs: 1000 });
  try {
    await h.request(path, { revision: 0, draft }, 'PUT');
    assert.equal((await h.request(path + '/preflight', { revision: 1 })).status, 503);
    const state = (await h.request(path)).data;
    assert.equal(state.mode, 'deployment'); assert.equal(state.revision, 1); assert.equal(state.preflight, null); assert.equal(state.checking, false);
    assert.equal((await h.request(path + '/pause', { revision: 1 })).status, 200);
    assert.equal((await fetch(h.url + '/readyz')).status, 503);
  } finally { await h.close(); }
});

test('enhancement activation is bound to draft, published resources and expiry; scope never changes the runtime', async () => {
  const h = await runtimeFixture({ runtime: 'agentscope' });
  try {
    const r = await agent(h), config = runtimeOptions({ runtime: 'agentscope' });
    const rollout = createRollout(h.app.store, config, { makeDriver: fake });
    const scoped = { ...draft, includeGeneral: false, agentIds: [r.id] };
    let state = rollout.save(h.user, { revision: 0, draft: { ...draft, includeGeneral: false } });
    await assert.rejects(rollout.preflight(h.user, { revision: state.revision }), /至少一个/);
    state = rollout.save(h.user, { revision: state.revision, draft: scoped });
    state = await rollout.preflight(h.user, { revision: state.revision });
    assert.equal(state.preflightValid, true);
    const expired = h.app.store.setting('agent:rollout'); expired.preflight.expiresAt = '2000-01-01T00:00:00.000Z'; h.app.store.setSetting('agent:rollout', expired);
    assert.throws(() => rollout.activate(h.user, { revision: state.revision }), /有效预检/);
    state = await rollout.preflight(h.user, { revision: state.revision });
    await h.request(`/resources/${r.id}`, { ...r, name: '已修改' }, 'PUT');
    assert.equal(rollout.view().preflightValid, false);
    assert.throws(() => rollout.activate(h.user, { revision: state.revision }), /已发布/);
    const latest = (await h.request('/resources')).data.find(a => a.id === r.id);
    await h.request(`/resources/${r.id}/publish`, { revision: latest.revision });
    state = await rollout.preflight(h.user, { revision: state.revision });
    state = rollout.activate(h.user, { revision: state.revision });
    assert.equal(rollout.snapshot(r.id).runtime, 'agentscope'); assert.equal(rollout.snapshot().runtime, 'agentscope');
    assert.equal(rollout.snapshot(r.id).matched, true); assert.equal(rollout.snapshot().matched, false);
    assert.equal(rollout.snapshot().contextMode, 'recent'); assert.equal(rollout.snapshot().retrievalMode, 'ranked');
    assert.equal(rollout.snapshot('outside').evidenceReports, false);
    const activeRevision = state.activeRevision;
    state = rollout.save(h.user, { revision: state.revision, draft: { ...scoped, evidenceReports: false } });
    assert.equal(rollout.snapshot(r.id).activeRevision, activeRevision); assert.equal(rollout.snapshot(r.id).evidenceReports, true);
    const current = (await h.request('/resources')).data.find(a => a.id === r.id);
    await h.request(`/resources/${r.id}`, { ...current, status: '已停用' }, 'PUT');
    assert.equal(rollout.view().agents.find(a => a.id === r.id).eligible, false);
    assert.equal(rollout.snapshot(r.id).runtime, 'agentscope'); assert.equal(rollout.snapshot(r.id).evidenceReports, false);
    assert.equal(rollout.required(), true);
    assert.ok(!JSON.stringify(state).includes(config.python));
  } finally { await h.close(); }
});

test('rollout rechecks CAS, resource revision and administrator after async preflight; shutdown cleans probe', async () => {
  const h = await runtimeFixture({ runtime: 'agentscope' });
  try {
    const r = await agent(h); let release, closes = 0;
    const rollout = createRollout(h.app.store, runtimeOptions({ runtime: 'agentscope' }), { makeDriver: () => ({ warmup: () => new Promise(resolve => { release = resolve; }), close: async () => { closes++; release?.(); } }) });
    let state = rollout.save(h.user, { revision: 0, draft: { ...draft, includeGeneral: false, agentIds: [r.id] } });
    let checking = rollout.preflight(h.user, { revision: state.revision });
    await assert.rejects(rollout.preflight(h.user, { revision: state.revision }), /正在执行/);
    state = rollout.pause(h.user, { revision: state.revision }); release();
    await assert.rejects(checking, /已被修改/); assert.equal(rollout.view().mode, 'paused');
    checking = rollout.preflight(h.user, { revision: state.revision });
    const item = h.app.store.resource(h.app.store.get('SELECT * FROM resources WHERE id=?', r.id));
    h.app.store.run('UPDATE resources SET updated=? WHERE id=?', 'changed-during-probe', item.id);
    release(); await assert.rejects(checking, /已变更/);
    checking = rollout.preflight(h.user, { revision: state.revision });
    h.app.store.run("UPDATE users SET role='member' WHERE id=?", h.user.id); release();
    await assert.rejects(checking, /管理员权限/);
    h.app.store.run("UPDATE users SET role='admin' WHERE id=?", h.user.id);
    checking = rollout.preflight(h.user, { revision: state.revision });
    const rejected = assert.rejects(checking, /本地预检失败/);
    await rollout.close(); await rejected;
    assert.ok(closes >= 4); assert.equal(rollout.view().preflight, null);
  } finally { await h.close(); }
});

test('a new failed preflight revokes previous proof and activation cannot race an ongoing probe', async () => {
  const h = await runtimeFixture({ runtime: 'agentscope' });
  let release, fail = false;
  try {
    const rollout = createRollout(h.app.store, runtimeOptions({ runtime: 'agentscope' }), { makeDriver: () => ({ warmup: async () => { if (fail) await new Promise((resolve, reject) => { release = () => reject(new Error('broken SDK')); }); }, close: async () => {} }) });
    let state = rollout.save(h.user, { revision: 0, draft });
    state = await rollout.preflight(h.user, { revision: state.revision });
    fail = true;
    const promise = rollout.preflight(h.user, { revision: state.revision });
    assert.throws(() => rollout.activate(h.user, { revision: state.revision }), /正在执行/);
    release(); await assert.rejects(promise, /预检失败/);
    const next = rollout.view(); assert.equal(next.preflight, null); assert.equal(next.revision, state.revision + 1);
    assert.throws(() => rollout.activate(h.user, { revision: next.revision }), /有效预检/);
  } finally { release?.(); await h.close(); }
});

test('queued requests use the policy when execution starts; in-flight errors retain their snapshot', async () => {
  const old = process.env.MAX_USER_RUNS; process.env.MAX_USER_RUNS = '1';
  const h = await runtimeFixture({ runtime: 'agentscope', evidenceReports: true });
  let release;
  try {
    let started;
    const waiting = new Promise(resolve => { started = resolve; });
    let calls = 0;
    h.model(async (req, res) => { calls++; if (calls === 1) { await new Promise(resolve => { release = resolve; started(); }); res.status(401).json({ error: 'fixture authentication failure' }); } else res.json({ choices: [{ message: { role: 'assistant', content: 'done' } }] }); });
    const first = h.request('/chat', { text: '在途失败' }); await waiting;
    const queued = h.request('/chat', { text: '排队后使用基础增强配置' });
    const deadline = Date.now() + 5000;
    while (!h.app.store.get("SELECT id FROM executions WHERE status='queued'")) {
      assert.ok(Date.now() < deadline); await new Promise(resolve => setTimeout(resolve, 10));
    }
    await h.request(path + '/pause', { revision: 0 }); release();
    const failed = await first; assert.equal(failed.status, 502);
    const error = (await h.request(`/conversations/${failed.data.conversationId}`)).data.messages.at(-1);
    assert.equal(error.metadata.runtimePolicy.mode, 'deployment'); assert.ok(error.metadata.evidenceReport);
    const after = await queued; assert.equal(after.status, 200); assert.equal(after.data.metadata.runtimePolicy.mode, 'paused');
    assert.equal(after.data.metadata.runtimePolicy.runtime, 'agentscope');
    assert.equal(after.data.metadata.evidenceReport, undefined);
  } finally { release?.(); await h.close(); if (old === undefined) delete process.env.MAX_USER_RUNS; else process.env.MAX_USER_RUNS = old; }
});
