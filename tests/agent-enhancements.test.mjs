import { sendResponsesSse } from './responses-fixture.mjs';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import { runtimeOptions } from '../server/agent-runtime/index.mjs';
import { prepareContext, contextBytes } from '../server/agent-context.mjs';
import { retrieve } from '../server/retrieval.mjs';
import { runtimeFixture, answer, call } from './runtime-fixture.mjs';
import { listen } from './fixtures.mjs';

const enabled = { contextMode: 'budgeted', contextMaxBytes: 12000, retrievalMode: 'diverse', evidenceReports: true };
function seedHistory(h, cid, count = 14) {
  for (let i = 0; i < count; i++) for (const role of ['user', 'assistant']) h.app.store.run('INSERT INTO messages(conversation_id,role,content,metadata,created) VALUES(?,?,?,?,?)', cid, role, `${role}-${i}:` + '旧上下文'.repeat(250), '{}', new Date().toISOString());
}

test('enhancement switches are independent and reject invalid trusted configuration', () => {
  const config = runtimeOptions({ contextMode: 'recent', retrievalMode: 'ranked', evidenceReports: false });
  assert.equal(config.evidenceReports, false); assert.equal(config.contextMode, 'recent');
  assert.equal(runtimeOptions({ evidenceReports: 'true' }).evidenceReports, true);
  for (const options of [{ evidenceReports: 'yes' }, { contextMode: 'summarize' }, { retrievalMode: 'vector' }, { contextMaxBytes: 999 }, { contextMaxBytes: Infinity }]) assert.throws(() => runtimeOptions(options));
});

test('budgeted context drops entire old turns, accounts for UTF-8 JSON and preserves mandatory input', () => {
  const tools = [{ description: '限定工具', schema: { jobid: 'string' } }];
  const history = [{ role: 'assistant', content: '窗口起点孤立回答' }];
  for (let i = 0; i < 8; i++) history.push({ role: 'user', content: `u${i}` + '中文"\\'.repeat(100) }, { role: 'assistant', content: `a${i}` + '回答'.repeat(100) });
  history.push({ role: 'user', content: '最新对象 9223372036854775807 不可截断' });
  const before = structuredClone(history);
  const result = prepareContext('不可删除的系统规则', history, tools, { ...enabled, contextMaxBytes: 2200 });
  assert.deepEqual(history, before);
  assert.deepEqual(result.messages.at(-1), history.at(-1));
  assert.equal(result.messages[1].role, 'user');
  for (let i = 1; i < result.messages.length - 1; i += 2) {
    assert.equal(result.messages[i].role, 'user'); assert.equal(result.messages[i + 1].role, 'assistant');
    assert.equal(result.messages[i].content[1], result.messages[i + 1].content[1]);
  }
  assert.match(result.messages[0].content, /不可删除.*省略/s);
  assert.ok(result.stats.omittedMessages > 0); assert.ok(result.stats.afterBytes <= 2200);
  assert.equal(result.stats.afterBytes, contextBytes(result.messages, tools));
  assert.equal(prepareContext('system', history, tools, { contextMode: 'recent' }).messages.length, history.length + 1);
  for (const [system, current, schema] of [['规则'.repeat(1000), '提问', tools], ['规则', '问题'.repeat(1000), tools], ['规则', '问题', [{ schema: 'x'.repeat(3000) }]]]) {
    assert.throws(() => prepareContext(system, [{ role: 'user', content: current }], schema, { ...enabled, contextMaxBytes: 1000 }), { status: 422 });
  }
});

test('diverse retrieval gives separate documents slots and excludes overlap/expired chunks', () => {
  const make = (id, body, extra = {}) => ({ id, name: id === 'long' ? 'billing latency errors' : id, domain: '', description: '', body, revision: 7, documentVersion: 'v7', ...extra });
  const docs = [make('long', 'billing latency errors '.repeat(300)), make('second', 'billing network'), make('third', 'latency database'), make('expired', 'billing latency errors', { expiresAt: '2000-01-01' })];
  const ranked = retrieve(docs, 'billing latency errors', 5);
  const diverse = retrieve(docs, 'billing latency errors', 5, undefined, 'diverse');
  assert.equal(new Set(ranked.map(s => s.resourceId)).size, 1);
  assert.equal(new Set(diverse.map(s => s.resourceId)).size, 3);
  assert.ok(!diverse.some(s => s.resourceId === 'expired'));
  for (const chunk of diverse) {
    assert.equal(chunk.revision, 7); assert.equal(chunk.documentVersion, 'v7');
    const same = diverse.filter(s => s.resourceId === chunk.resourceId); assert.ok(same.length <= 2);
    for (const other of same.filter(s => s !== chunk)) assert.ok(chunk.offset + chunk.content.length <= other.offset || other.offset + other.content.length <= chunk.offset);
  }
});

test('enhanced chat preserves current tools, source binding, persisted reports and request deduplication', async () => {
  const h = await runtimeFixture(enabled);
  try {
    const create = body => h.request('/resources', { kind: 'knowledge', name: '计费手册', body, documentVersion: '2026.09' });
    const knowledge = (await create('计费请求需要核对实时数据，并检查连接数。')).data;
    await create('计费知识不在绑定中 SECRET_UNBOUND');
    const expired = (await h.request('/resources', { kind: 'knowledge', name: '计费过期', body: 'SECRET_EXPIRED 计费请求', expiresAt: '2000-01-01T00:00:00Z' })).data;
    const agent = (await h.request('/resources', { kind: 'agents', name: '受限计费', knowledgeIds: [knowledge.id, expired.id], mcpIds: [h.resource.id] })).data;
    const initial = await h.request('/chat', { text: '开始', agentId: agent.id });
    seedHistory(h, initial.data.conversationId);
    h.model((req, res) => answer(res, req.body.messages.at(-1).role === 'tool' ? null : [call()], '模型文字声称正常，报告不得据此判健康'));
    const input = { text: '查询计费当前状态', conversationId: initial.data.conversationId, requestKey: 'enhanced-evidence-once' };
    const result = await h.request('/chat', input); assert.equal(result.status, 200, JSON.stringify(result.data));
    const first = h.requests.at(-2), second = h.requests.at(-1);
    assert.ok(!JSON.stringify(first).includes('SECRET_UNBOUND')); assert.ok(!JSON.stringify(first).includes('SECRET_EXPIRED'));
    assert.equal(first.messages.at(-1).content, input.text);
    assert.deepEqual(second.messages.slice(0, first.messages.length), first.messages);
    assert.equal(second.messages.at(-1).tool_call_id, 'call-one'); assert.match(second.messages.at(-1).content, /healthy/);
    const report = result.data.metadata.evidenceReport;
    assert.equal(report.businessStatus, 'not_assessed'); assert.equal(report.outcome, 'completed'); assert.equal(report.tokens, 60);
    assert.equal(report.toolSteps.length, 1); assert.equal(report.toolSteps[0].status, 'success');
    assert.equal(report.toolSteps[0].stepId, h.app.store.get('SELECT id FROM tool_steps WHERE run_id=?', result.data.runId).id);
    assert.deepEqual(report.sources.map(s => s.resourceId), [knowledge.id]); assert.equal(report.sources[0].documentVersion, '2026.09');
    assert.ok(report.context.omittedMessages > 0); assert.ok(report.gaps.includes('history_omitted'));
    for (const secret of ['arguments_encrypted', 'response_encrypted', 'fixture-mcp-secret', 'fixture-model-secret', h.resource.endpoint, input.text, '模型文字声称']) assert.ok(!JSON.stringify(report).includes(secret));
    const calls = h.requests.length;
    assert.deepEqual((await h.request('/chat', input)).data.metadata.evidenceReport, report); assert.equal(h.requests.length, calls);
    await h.restart();
    assert.deepEqual((await h.request(`/conversations/${result.data.conversationId}`)).data.messages.at(-1).metadata.evidenceReport, report);
    await h.request('/users', { username: 'outsider', password: 'outside-user-password', role: 'member' });
    const cookie = (await h.request('/auth/login', { username: 'outsider', password: 'outside-user-password' })).cookie;
    assert.equal((await h.request(`/conversations/${result.data.conversationId}`, undefined, 'GET', cookie)).status, 404);
  } finally { await h.close(); }
});

test('evidence reports distinguish no evidence, discovery gaps, model errors and frozen approval snapshots', async () => {
  const h = await runtimeFixture({ evidenceReports: true });
  try {
    const gap = (await h.request('/resources', { kind: 'mcp', name: '离线服务', endpoint: h.fixtures.url + '/missing', token: 'private-token', allowedTools: ['missing'], toolPolicies: { missing: { risk: 'read' } } })).data;
    const noTool = await h.request('/chat', { text: '没有证据' });
    const report = noTool.data.metadata.evidenceReport;
    assert.equal(report.businessStatus, 'not_assessed'); assert.ok(report.gaps.includes('no_successful_tool_evidence'));
    assert.equal(report.mcpFailures[0].resourceId, gap.id); assert.equal(report.toolSteps.length, 0);
    h.model((req, res) => res.status(503).send('private-model-error'));
    const failed = await h.request('/chat', { text: '模型失败' });
    const saved = (await h.request(`/conversations/${failed.data.conversationId}`)).data.messages.at(-1).metadata.evidenceReport;
    assert.equal(saved.outcome, 'error'); assert.ok(saved.gaps.includes('generation_incomplete'));
    h.model((req, res) => answer(res, [call('plan', 'mcp_1', { service: 'billing', state: 'maintenance' })]));
    const pending = await h.request('/chat', { text: '写计划' });
    assert.equal(pending.data.metadata.evidenceReport.outcome, 'awaiting_approval');
    assert.equal(pending.data.metadata.evidenceReport.toolSteps[0].status, 'awaiting_approval');
    assert.equal(h.fixtures.toolCalls.length, 0);
    assert.equal((await h.request(`/approvals/${pending.data.stepId}/approve`, {}, 'POST', h.reviewer)).status, 200);
    const snapshot = (await h.request(`/conversations/${pending.data.conversationId}`)).data.messages.at(-1).metadata.evidenceReport;
    assert.deepEqual(snapshot, pending.data.metadata.evidenceReport); // Report is explicitly a message-time snapshot.
  } finally { await h.close(); }
});

test('oversized mandatory input fails before model request and enhancements off preserve baseline metadata', async () => {
  const h = await runtimeFixture({ contextMode: 'budgeted', contextMaxBytes: 1000, evidenceReports: true });
  try {
    const failed = await h.request('/chat', { text: '不可截断'.repeat(1000) }); assert.equal(failed.status, 422);
    assert.equal(h.requests.length, 0); assert.equal(h.fixtures.toolCalls.length, 0);
    const saved = (await h.request(`/conversations/${failed.data.conversationId}`)).data.messages.at(-1);
    assert.equal(saved.metadata.evidenceReport.outcome, 'error');
    await h.restart({ contextMode: 'recent', retrievalMode: 'ranked', evidenceReports: false });
    const normal = await h.request('/chat', { text: '兼容模式' });
    assert.equal(normal.status, 200); assert.equal(normal.data.metadata.evidenceReport, undefined); assert.equal(normal.data.metadata.context, undefined);
  } finally { await h.close(); }
});

test('budgeted Responses keeps current opaque reasoning and complete tool outputs', async () => {
  const h = await runtimeFixture(enabled); const endpoint = express(); endpoint.use(express.json());
  const requests = []; const reasoning = { type: 'reasoning', id: 'rs_fixture', summary: [], encrypted_content: 'opaque-current-reasoning' };
  endpoint.post('/v1/responses', (req, res) => {
    requests.push(req.body);
    if (!req.body.input.some(i => i.type === 'function_call_output')) return sendResponsesSse(res, { status: 'completed', output: [reasoning, { type: 'function_call', call_id: 'responses-call', name: 'mcp_0', arguments: '{"service":"billing"}' }], usage: { input_tokens: 30, output_tokens: 10, total_tokens: 40 } });
    sendResponsesSse(res, { status: 'completed', output: [{ type: 'message', role: 'assistant', content: [{ type: 'output_text', text: '已检查' }] }], usage: { input_tokens: 40, output_tokens: 10, total_tokens: 50 } });
  });
  const provider = await listen(endpoint);
  try {
    const initial = await h.request('/chat', { text: '之前的对话' }); seedHistory(h, initial.data.conversationId);
    await h.request('/settings/model', { baseUrl: provider.url + '/v1', model: 'responses', apiType: 'responses', temperature: null }, 'PUT');
    const result = await h.request('/chat', { text: '重新查询', conversationId: initial.data.conversationId });
    assert.equal(result.status, 200, JSON.stringify(result.data)); assert.equal(requests.length, 2);
    assert.deepEqual(requests[1].input.find(i => i.type === 'reasoning'), reasoning);
    assert.equal(requests[1].input.find(i => i.type === 'function_call_output').call_id, 'responses-call');
    assert.match(requests[1].input.find(i => i.type === 'function_call_output').output, /healthy/);
    assert.equal(result.data.metadata.evidenceReport.tokens, 90);
    assert.ok(!JSON.stringify(result.data.metadata).includes('opaque-current-reasoning'));
  } finally { await provider.close(); await h.close(); }
});

test('diverse retrieval does not widen member ACL and knowledge-off excludes all sources', async () => {
  const h = await runtimeFixture(enabled);
  try {
    const ids = [];
    for (const [name, extra] of [['public', { visibility: 'public' }], ['private', { visibility: 'private' }], ['disabled', { visibility: 'public', status: '已停用' }], ['expired', { visibility: 'public', expiresAt: '2000-01-01T00:00:00Z' }]]) {
      ids.push((await h.request('/resources', { kind: 'knowledge', name, body: `计费检查 MARKER_${name}`, ...extra })).data.id);
    }
    const agent = (await h.request('/resources', { kind: 'agents', name: '公开子领域', visibility: 'public', knowledgeIds: ids })).data;
    await h.request('/users', { username: 'reader', password: 'reader-test-password', role: 'member' });
    const cookie = (await h.request('/auth/login', { username: 'reader', password: 'reader-test-password' })).cookie;
    const result = await h.request('/chat', { text: '计费检查', agentId: agent.id }, 'POST', cookie);
    assert.equal(result.status, 200); assert.deepEqual(result.data.metadata.evidenceReport.sources.map(s => s.resourceId), [ids[0]]);
    for (const excluded of ['private', 'disabled', 'expired']) assert.ok(!JSON.stringify(h.requests.at(-1)).includes(`MARKER_${excluded}`));
    const off = await h.request('/chat', { text: '计费检查', agentId: agent.id, useKnowledge: false }, 'POST', cookie);
    assert.deepEqual(off.data.metadata.evidenceReport.sources, []); assert.ok(!JSON.stringify(h.requests.at(-1)).includes('MARKER_public'));
  } finally { await h.close(); }
});
