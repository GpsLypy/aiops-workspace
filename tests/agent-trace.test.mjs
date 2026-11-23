import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createExecutionTrace } from '../server/agent-trace.mjs';
import { runtimeFixture, answer, call } from './runtime-fixture.mjs';

const traceOf = result => result.metadata.executionTrace;
const values = node => Object.fromEntries((node.details || []).map(item => [item.label, item.value]));
function verify(trace, status) {
  assert.equal(trace.version, 1); assert.equal(trace.status, status);
  assert.ok(trace.finishedAt); assert.ok(trace.durationMs >= 0);
  assert.ok(trace.nodes.length <= 200); assert.ok(trace.edges.length <= 400);
  assert.match(trace.traceId, /^[0-9a-f]{32}$/);
  assert.match(trace.spanId, /^[0-9a-f]{16}$/);
  const ids = new Set(trace.nodes.map(node => node.id));
  assert.equal(ids.size, trace.nodes.length);
  const spanIds = new Set([trace.spanId, ...trace.nodes.map(node => node.spanId)]);
  assert.equal(spanIds.size, trace.nodes.length + 1);
  for (const node of trace.nodes) {
    assert.notEqual(node.status, 'running'); assert.ok(node.startedAt); assert.ok(node.finishedAt); assert.ok(node.durationMs >= 0);
    assert.match(node.spanId, /^[0-9a-f]{16}$/);
    assert.ok(spanIds.has(node.parentSpanId));
  }
  for (const edge of trace.edges) { assert.ok(ids.has(edge.from)); assert.ok(ids.has(edge.to)); }
}

test('trace snapshots are bounded, redacted, immutable and ignore late callbacks after finalization', () => {
  const events = []; const trace = createExecutionTrace('run-test', event => events.push(event));
  const node = trace.start({ kind: 'context', label: 'token Bearer private-secret', details: [{ label: 'Name', value: 'api_key=private-key' }] });
  const initial = events[0].trace;
  trace.finish(node, 'completed', 'done');
  for (let i = 0; i < 210; i++) trace.start({ kind: 'tool', label: 'x'.repeat(1000), details: Array.from({ length: 20 }, () => ({ label: 'a', value: 'x'.repeat(1000) })) }, [node]);
  const saved = trace.complete('error'); const count = events.length;
  trace.finish(node, 'error'); trace.start({ kind: 'answer', label: 'late' }); trace.complete('completed');
  assert.deepEqual(trace.snapshot(), saved); assert.equal(events.length, count);
  assert.equal(initial.nodes[0].status, 'running'); assert.ok(!JSON.stringify(saved).includes('private-'));
  assert.equal(saved.nodes[0].parentSpanId, saved.spanId);
  assert.equal(saved.nodes[1].parentSpanId, saved.nodes[0].spanId);
  assert.equal(saved.nodes.length, 200); assert.ok(Buffer.byteLength(JSON.stringify(saved)) < 600000);
  verify(saved, 'error');
});

test('actual model/tool graph is always recorded with authorized identities, replay and restart preserve it', async () => {
  const h = await runtimeFixture({ evidenceReports: false });
  try {
    const knowledge = (await h.request('/resources', { kind: 'knowledge', name: '计费手册', body: '计费查询 PRIVATE_KNOWLEDGE_BODY', documentVersion: 'v1' })).data;
    const skill = (await h.request('/resources', { kind: 'skills', name: '计费 Skill', body: 'PRIVATE_SKILL_BODY' })).data;
    await h.request('/resources', { kind: 'skills', name: 'UNBOUND_SKILL', body: 'UNBOUND_BODY' });
    const agent = (await h.request('/resources', { kind: 'agents', name: '计费领域', knowledgeIds: [knowledge.id], skillIds: [skill.id], mcpIds: [h.resource.id] })).data;
    h.model((req, res) => answer(res, req.body.messages.at(-1).role === 'tool' ? undefined : [call()], 'PRIVATE_ANSWER'));
    const input = { text: '计费 PRIVATE_USER_PROMPT', agentId: agent.id, requestKey: 'trace-durable-once', useKnowledge: true, reviewMode: 'off' };
    const events = [];
    const result = await h.app.engine.execute(h.user, input, event => events.push(event));
    const trace = traceOf(result); verify(trace, 'completed');
    assert.equal(trace.nodes.find(node => node.kind === 'model').parentSpanId, trace.nodes.find(node => node.kind === 'context').spanId);
    assert.equal(result.metadata.evidenceReport, undefined);
    const models = trace.nodes.filter(node => node.kind === 'model');
    assert.equal(models.length, 2); assert.deepEqual(models.map(node => values(node)['用量']), ['30 tokens', '30 tokens']);
    const tool = trace.nodes.find(node => node.kind === 'tool');
    assert.equal(tool.status, 'completed'); assert.ok(values(tool)['步骤 ID']);
    assert.ok(trace.edges.some(edge => edge.from === models[0].id && edge.to === tool.id));
    assert.ok(trace.edges.some(edge => edge.from === tool.id && edge.to === models[1].id));
    assert.equal(values(trace.nodes.find(node => node.kind === 'skill'))['资源 ID'], skill.id);
    assert.equal(values(trace.nodes.find(node => node.kind === 'knowledge'))['资源 ID'], knowledge.id);
    for (const secret of ['PRIVATE_', 'UNBOUND_', 'fixture-model-secret', 'fixture-mcp-secret', 'healthy', '"arguments"']) assert.ok(!JSON.stringify(trace).includes(secret));
    const observations = events.filter(event => event.type === 'trace');
    assert.ok(observations.some(event => event.trace.nodes.some(node => node.kind === 'model' && node.status === 'running')));
    assert.deepEqual(observations.at(-1).trace, trace);
    assert.deepEqual((await h.request('/chat', input)).data.metadata.executionTrace, trace);
    const metric = name => h.app.engine.traceMetrics().find(line => line.startsWith(name));
    assert.equal(metric('aiops_agent_trace_duration_seconds_count{stage="run"}'), 'aiops_agent_trace_duration_seconds_count{stage="run"} 1');
    assert.equal(metric('aiops_agent_trace_duration_seconds_count{stage="model"}'), 'aiops_agent_trace_duration_seconds_count{stage="model"} 2');
    assert.equal(metric('aiops_agent_trace_duration_seconds_count{stage="tool"}'), 'aiops_agent_trace_duration_seconds_count{stage="tool"} 1');
    assert.equal(metric('aiops_agent_trace_outcomes_total{status="completed"}'), 'aiops_agent_trace_outcomes_total{status="completed"} 1');
    assert.equal(h.fixtures.toolCalls.length, 1); assert.equal(h.requests.length, 2);
    const oldMetricsToken = process.env.METRICS_TOKEN;
    try {
      process.env.METRICS_TOKEN = 'trace-metrics-test-token';
      assert.equal((await fetch(h.url + '/metrics')).status, 401);
      const metrics = await fetch(h.url + '/metrics', { headers: { Authorization: 'Bearer trace-metrics-test-token' } });
      const exposition = await metrics.text();
      assert.equal(metrics.status, 200);
      assert.match(exposition, /aiops_agent_trace_duration_seconds_count\{stage="model"\} 2/);
      assert.ok(!exposition.includes(trace.traceId));
      assert.ok(!exposition.includes('PRIVATE_'));
    } finally {
      if (oldMetricsToken === undefined) delete process.env.METRICS_TOKEN;
      else process.env.METRICS_TOKEN = oldMetricsToken;
    }
    await h.restart();
    assert.deepEqual((await h.request(`/conversations/${result.conversationId}`)).data.messages.at(-1).metadata.executionTrace, trace);
    assert.equal(h.app.engine.traceMetrics().find(line => line.startsWith('aiops_agent_trace_duration_seconds_count{stage="run"}')), 'aiops_agent_trace_duration_seconds_count{stage="run"} 0');
    await h.request('/users', { username: 'trace-outsider', password: 'outsider-test-password', role: 'member' });
    const outsider = (await h.request('/auth/login', { username: 'trace-outsider', password: 'outsider-test-password' })).cookie;
    assert.equal((await h.request(`/conversations/${result.conversationId}`, undefined, 'GET', outsider)).status, 404);
  } finally { await h.close(); }
});

test('MCP traces distinguish actual discovery, cached catalog and partial failure without inventing tool work', async () => {
  const h = await runtimeFixture();
  try {
    h.app.store.setSetting(`catalog:${h.resource.id}`, null);
    const discovered = traceOf((await h.request('/chat', { text: '解释知识' })).data);
    assert.equal(values(discovered.nodes.find(node => node.kind === 'mcp'))['目录来源'], '本轮发现');
    const failed = (await h.request('/resources', { kind: 'mcp', name: '暂不可用', endpoint: h.fixtures.url + '/missing', allowedTools: ['service_status'], toolPolicies: { service_status: { risk: 'read' } } })).data;
    const next = traceOf((await h.request('/chat', { text: '解释知识' })).data);
    verify(next, 'completed');
    assert.equal(values(next.nodes.find(node => node.kind === 'mcp' && values(node)['资源 ID'] === h.resource.id))['目录来源'], '有效缓存');
    assert.equal(next.nodes.find(node => node.kind === 'mcp' && values(node)['资源 ID'] === failed.id).status, 'error');
    assert.equal(next.nodes.filter(node => node.kind === 'tool').length, 0); assert.equal(h.fixtures.toolCalls.length, 0);
  } finally { await h.close(); }
});

test('write plan is awaiting approval, skipped review is explicit, and later approval does not rewrite history', async () => {
  const h = await runtimeFixture();
  try {
    h.model((req, res) => answer(res, [call('write', 'mcp_1', { service: 'billing', state: 'maintenance' })]));
    const result = (await h.request('/chat', { text: '保存变更计划', reviewMode: 'independent' })).data;
    const trace = traceOf(result); verify(trace, 'awaiting_approval');
    assert.equal(trace.nodes.find(node => node.kind === 'tool').status, 'awaiting_approval');
    assert.match(trace.nodes.find(node => node.kind === 'tool').summary, /未执行/);
    assert.equal(trace.nodes.find(node => node.kind === 'review').status, 'skipped');
    assert.equal(trace.nodes.filter(node => node.kind === 'model').length, 1); assert.equal(h.fixtures.toolCalls.length, 0);
    assert.equal((await h.request(`/approvals/${result.stepId}/approve`, {}, 'POST', h.reviewer)).status, 200);
    assert.deepEqual((await h.request(`/conversations/${result.conversationId}`)).data.messages.at(-1).metadata.executionTrace, trace);
  } finally { await h.close(); }
});

test('blocked and unavailable review keep actual model stages without disclosing draft or review output', async () => {
  const h = await runtimeFixture();
  try {
    for (const failure of ['block', 'provider']) {
      h.model((req, res) => {
        if (!req.body.messages[0].content.startsWith('independent-evidence-review/v1')) return answer(res, undefined, 'PRIVATE_DRAFT');
        if (failure === 'provider') return res.status(503).send('PRIVATE_PROVIDER_ERROR');
        answer(res, undefined, JSON.stringify({ verdict: 'block', reasons: ['unsupported_claim'] }));
      });
      const events = [];
      const result = await h.app.engine.execute(h.user, { text: '解释情况', reviewMode: 'independent' }, event => events.push(event));
      const trace = traceOf(result); verify(trace, failure === 'block' ? 'blocked' : 'error');
      assert.equal(trace.nodes.filter(node => node.kind === 'model').length, failure === 'provider' ? 7 : 2);
      assert.equal(trace.nodes.find(node => node.kind === 'review').status, failure === 'block' ? 'blocked' : 'error');
      assert.ok(!JSON.stringify(events).includes('PRIVATE_')); assert.ok(!JSON.stringify(trace).includes('"verdict"'));
    }
  } finally { await h.close(); }
});

test('model failure and unauthorized tool response persist completed error traces with no fictitious tool nodes', async () => {
  const h = await runtimeFixture();
  try {
    for (const failure of ['provider', 'unauthorized']) {
      h.model((req, res) => failure === 'provider' ? res.status(503).send('PRIVATE_ERROR') : answer(res, [call('bad', 'not_allowed')], 'PRIVATE_DRAFT'));
      const result = await h.request('/chat', { text: '请处理' });
      assert.ok(result.status >= 400);
      const saved = (await h.request(`/conversations/${result.data.conversationId}`)).data.messages.at(-1);
      const trace = saved.metadata.executionTrace; verify(trace, 'error');
      assert.equal(trace.nodes.filter(node => node.kind === 'tool').length, 0); assert.equal(h.fixtures.toolCalls.length, 0);
      assert.equal(trace.nodes.find(node => node.kind === 'model').status, 'error');
      assert.ok(!JSON.stringify(trace).includes('PRIVATE_'));
    }
  } finally { await h.close(); }
});

test('cancellation finalizes the running model and persists cancelled trace', async () => {
  const h = await runtimeFixture();
  let entered; const started = new Promise(resolve => { entered = resolve; });
  try {
    h.model(() => entered());
    const request = h.request('/chat', { text: '慢速查询', requestKey: 'trace-cancellation' });
    await started;
    const run = h.app.store.get('SELECT * FROM executions WHERE request_key=?', 'trace-cancellation');
    assert.equal((await h.request(`/executions/${run.id}/cancel`, {})).status, 200);
    assert.equal((await request).status, 504);
    const trace = (await h.request(`/conversations/${run.conversation_id}`)).data.messages.at(-1).metadata.executionTrace;
    verify(trace, 'cancelled');
    assert.equal(trace.nodes.find(node => node.kind === 'model').status, 'cancelled');
  } finally { await h.close(); }
});

for (const failure of [false, true]) test(`in-flight model settings do not relabel ${failure ? 'failed' : 'completed'} requests`, async () => {
  const h = await runtimeFixture();
  const entered = Promise.withResolvers();
  const release = Promise.withResolvers();
  let pending;
  try {
    const config = (await h.request('/settings/model')).data;
    h.model(async (req, res) => {
      entered.resolve(); await release.promise;
      if (failure) res.status(503).json({ error: 'LOCAL_FAILURE' });
      else answer(res, undefined, '完成');
    });
    const input = { text: '核对请求身份', requestKey: `model-snapshot-${failure}` };
    pending = h.request('/chat', input);
    await entered.promise;
    assert.equal((await h.request('/settings/model', { ...config, model: 'replacement-model' }, 'PUT')).status, 200);
    release.resolve();
    const response = await pending;
    assert.equal(response.status, failure ? 502 : 200);
    const saved = (await h.request(`/conversations/${response.data.conversationId}`)).data.messages.at(-1);
    const trace = saved.metadata.executionTrace;
    assert.deepEqual(trace.nodes.filter(n => n.kind === 'model').map(n => values(n)['模型']), h.requests.map(r => r.model));
    assert.deepEqual(h.requests.map(r => r.model), Array(failure ? 6 : 1).fill('fixture'));
    if (failure) assert.ok(trace.nodes.filter(n => n.kind === 'model').every(n => n.status === 'error'));
    if (!failure) {
      assert.equal(response.data.metadata.model, 'fixture');
      assert.equal(saved.metadata.model, 'fixture');
      assert.deepEqual((await h.request('/chat', input)).data.metadata, response.data.metadata);
      assert.equal(h.requests.length, 1);
    }
    assert.ok(!JSON.stringify(trace).includes('fixture-model-secret'));
  } finally { release.resolve(); await pending?.catch(() => {}); await h.close(); }
});

test('each tool round and reviewer retain their own request model while answer names the final analyst', async () => {
  const h = await runtimeFixture();
  const entered = Array.from({ length: 3 }, () => Promise.withResolvers());
  const releases = Array.from({ length: 3 }, () => Promise.withResolvers());
  let pending, round = 0;
  try {
    const config = (await h.request('/settings/model')).data;
    h.model(async (req, res) => {
      const index = round++;
      entered[index].resolve(); await releases[index].promise;
      if (index === 0) return answer(res, [call()]);
      return answer(res, undefined, index === 1 ? '完成候选' : JSON.stringify({ verdict: 'pass', reasons: [] }));
    });
    const input = { text: '只读查询billing', requestKey: 'models-per-phase', reviewMode: 'independent' };
    pending = h.request('/chat', input);
    for (let i = 0; i < 3; i++) {
      await entered[i].promise;
      assert.equal((await h.request('/settings/model', { ...config, model: ['final-analyst', 'review-model', 'future-model'][i] }, 'PUT')).status, 200);
      releases[i].resolve();
    }
    const response = await pending;
    assert.equal(response.status, 200); assert.equal(response.data.metadata.agentReview.status, 'accepted');
    const expected = ['fixture', 'final-analyst', 'review-model'];
    assert.deepEqual(h.requests.map(r => r.model), expected);
    assert.deepEqual(traceOf(response.data).nodes.filter(n => n.kind === 'model').map(n => values(n)['模型']), expected);
    assert.equal(response.data.metadata.model, 'final-analyst');
    assert.equal(h.fixtures.toolCalls.length, 1);
    await h.restart();
    const saved = (await h.request(`/conversations/${response.data.conversationId}`)).data.messages.at(-1);
    assert.deepEqual(saved.metadata, response.data.metadata);
  } finally { releases.forEach(r => r.resolve()); await pending?.catch(() => {}); await h.close(); }
});
