import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash, randomBytes } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { createBackup, rotateBackup } from '../server/backup.mjs';
import { runtimeFixture, answer, call } from './runtime-fixture.mjs';

// Real AgentScope 2.0.8 + local Responses SSE + MCP + temporary encrypted DB.
// Model choices are deterministic fixtures, never a model-quality assessment.
const auto = { delegationMode: 'auto' };
const isChild = body => body.messages?.[0]?.content.startsWith('delegated-agent/v1');
const isReviewer = body => body.messages?.[0]?.content.startsWith('independent-evidence-review/v1');
const toolNames = body => (body.tools || []).map(tool => tool.function.name);
const delegate = (tasks, id = 'delegate-one') => call(id, 'delegate_agents', { tasks });
const task = (text = '计费状态查询', agentId = null) => ({ agentId, task: text });
const children = result => result.metadata.agentDelegation.children;
const details = node => Object.fromEntries((node.details || []).map(item => [item.label, item.value]));
const ledger = (h, runId) => h.app.store.all('SELECT * FROM agent_delegations WHERE run_id=? ORDER BY created,id', runId);
const make = async (h, resource, cookie) => {
  const response = await h.request('/resources', resource, 'POST', cookie);
  assert.equal(response.status, 201, JSON.stringify(response.data));
  return response.data;
};
async function waitFor(predicate, timeoutMs = 3000) {
  const end = Date.now() + timeoutMs;
  while (!predicate() && Date.now() < end) await new Promise(resolve => setTimeout(resolve, 20));
  assert.ok(predicate(), 'Expected lifecycle transition did not finish');
}

test('delegation is opt-in and normalized mode participates in durable request identity', async () => {
  const h = await runtimeFixture();
  try {
    h.model((req, res) => answer(res));
    const input = { text: '解释计费', requestKey: 'delegation-mode-identity' };
    const first = await h.request('/chat', input);
    assert.equal(first.status, 200, JSON.stringify(first.data));
    assert.equal(first.data.metadata.agentDelegation, undefined);
    assert.ok(!toolNames(h.requests[0]).includes('delegate_agents'));
    assert.equal((await h.request('/chat', { ...input, delegationMode: 'off' })).status, 200);
    assert.equal((await h.request('/chat', { ...input, ...auto })).status, 409);
    assert.equal((await h.request('/chat', { text: 'invalid', delegationMode: 'automatic' })).status, 400);
    assert.equal(h.requests.length, 1);

    const enabled = await h.request('/chat', { text: '模型决定无需拆分', ...auto });
    assert.equal(enabled.status, 200, JSON.stringify(enabled.data));
    assert.ok(toolNames(h.requests.at(-1)).includes('delegate_agents'));
    assert.deepEqual(children(enabled.data), []);
    assert.equal(ledger(h, enabled.data.runId).length, 0);

    // Direct callers and HTTP clients must converge on the historical v6
    // off-mode payload despite omitted defaults or reordered properties.
    const direct = { requestKey: 'delegation-canonical-off', reviewMode: 'off', text: '直接入口保持幂等' };
    const directResult = await h.app.engine.execute(h.user, direct);
    const persisted = h.app.store.get('SELECT input,input_hash FROM executions WHERE id=?', directResult.runId);
    const oldPayload = { text: direct.text, useKnowledge: true, reviewMode: 'off' };
    assert.deepEqual(JSON.parse(h.app.store.decrypt(persisted.input)), oldPayload);
    assert.equal(persisted.input_hash, createHash('sha256').update(JSON.stringify(oldPayload)).digest('hex'));
    const count = h.requests.length;
    const replay = await h.request('/chat', { text: direct.text, delegationMode: 'off', requestKey: direct.requestKey });
    assert.equal(replay.status, 200, JSON.stringify(replay.data));
    assert.equal(replay.data.runId, directResult.runId);
    assert.equal((await h.request('/chat', { ...direct, ...auto })).status, 409);
    assert.equal(h.requests.length, count);
  } finally { await h.close(); }
});

test('actual delegated tool execution isolates context, shares usage and persists a redacted linked graph', async () => {
  const h = await runtimeFixture({ evidenceReports: true });
  try {
    const shared = await make(h, { kind: 'knowledge', name: '计费共用', body: '计费查询 SHARED_KNOWLEDGE' });
    const parentOnly = await make(h, { kind: 'knowledge', name: '计费父级', body: '计费 PRIVATE_PARENT_KNOWLEDGE' });
    const childOnly = await make(h, { kind: 'knowledge', name: '计费子级', body: '计费 PRIVATE_UNBOUND_CHILD_KNOWLEDGE' });
    const sharedSkill = await make(h, { kind: 'skills', name: '共用流程', body: 'SHARED_SKILL' });
    const parentSkill = await make(h, { kind: 'skills', name: '父级流程', body: 'PRIVATE_PARENT_SKILL' });
    const child = await make(h, { kind: 'agents', name: '只读计费子 Agent', body: 'PRIVATE_CHILD_INSTRUCTION',
      knowledgeIds: [shared.id, childOnly.id], skillIds: [sharedSkill.id], mcpIds: [h.resource.id] });
    const parent = await make(h, { kind: 'agents', name: '计费主 Agent', body: 'PRIVATE_PARENT_INSTRUCTION',
      knowledgeIds: [shared.id, parentOnly.id], skillIds: [sharedSkill.id, parentSkill.id], mcpIds: [h.resource.id] });
    const initial = await h.request('/chat', { text: 'PRIVATE_PARENT_HISTORY', agentId: parent.id });
    assert.equal(initial.status, 200);
    const before = h.requests.length;
    const isolatedRequests = [];
    h.model((req, res) => {
      if (isChild(req.body)) {
        isolatedRequests.push(req.body);
        return answer(res, req.body.messages.at(-1).role === 'tool' ? undefined : [call('child-service-read')], 'PRIVATE_CHILD_RESULT');
      }
      if (req.body.messages.at(-1).role === 'tool') return answer(res, undefined, '主 Agent 已汇总实际子任务证据');
      return res.json({ status: 'completed', output: [
        { type: 'reasoning', id: 'rs_parent_delegation', summary: [], encrypted_content: 'PRIVATE_PARENT_OPAQUE_REASONING' },
        { type: 'function_call', call_id: 'delegate-read', name: 'delegate_agents', arguments: JSON.stringify({ tasks: [task('计费 PRIVATE_CHILD_TASK', child.id)] }) },
      ], usage: { input_tokens: 20, output_tokens: 10, total_tokens: 30 } });
    });
    const events = [];
    const input = { requestKey: 'delegation-durable-once', ...auto, conversationId: initial.data.conversationId, text: '计费 PRIVATE_PARENT_PROMPT', model_reasoning_effort: 'high' };
    const result = await h.app.engine.execute(h.user, input, event => events.push(event));
    assert.equal(result.text, '主 Agent 已汇总实际子任务证据');
    assert.equal(h.requests.length - before, 4);
    assert.equal(h.fixtures.toolCalls.length, 1);
    assert.equal(result.metadata.usage.total_tokens, 120);
    assert.equal(h.app.store.get('SELECT tokens FROM executions WHERE id=?', result.runId).tokens, 120);
    assert.equal(children(result).length, 1);
    const summary = children(result)[0];
    assert.equal(summary.status, 'completed');
    assert.notEqual(summary.id, result.runId);
    assert.equal(summary.parentAgentRunId, result.runId);
    assert.equal(summary.agentId, child.id);
    assert.equal(summary.modelCalls, 2);
    assert.equal(summary.tokens, 60);
    assert.equal(summary.toolSteps, 1);
    assert.equal(isolatedRequests.length, 2);
    assert.ok(isolatedRequests.every(request => request.reasoning.effort === 'high'));
    assert.ok(JSON.stringify(isolatedRequests[0]).includes('PRIVATE_CHILD_TASK'));
    assert.ok(JSON.stringify(isolatedRequests[0]).includes('PRIVATE_CHILD_INSTRUCTION'));
    assert.ok(JSON.stringify(isolatedRequests[0]).includes('SHARED_KNOWLEDGE'));
    assert.ok(JSON.stringify(isolatedRequests[0]).includes('SHARED_SKILL'));
    assert.deepEqual(toolNames(isolatedRequests[0]), ['mcp_0']);
    for (const secret of ['PRIVATE_PARENT_HISTORY', 'PRIVATE_PARENT_PROMPT', 'PRIVATE_PARENT_INSTRUCTION', 'PRIVATE_PARENT_SKILL', 'PRIVATE_PARENT_KNOWLEDGE',
      'PRIVATE_UNBOUND_CHILD_KNOWLEDGE', 'PRIVATE_PARENT_OPAQUE_REASONING', 'fixture-model-secret', 'fixture-mcp-secret']) {
      assert.ok(!JSON.stringify(isolatedRequests).includes(secret), `Child context leaked ${secret}`);
    }
    const rows = ledger(h, result.runId);
    assert.equal(rows.length, 1);
    assert.equal(rows[0].id, summary.id);
    assert.equal(rows[0].run_id, result.runId);
    assert.equal(rows[0].parent_agent_run_id, result.runId);
    assert.equal(rows[0].status, 'completed');
    assert.ok(!rows[0].task_encrypted.includes('PRIVATE_CHILD_TASK'));
    assert.match(h.app.store.decrypt(rows[0].task_encrypted), /PRIVATE_CHILD_TASK/);
    assert.ok(!rows[0].result_encrypted.includes('PRIVATE_CHILD_RESULT'));
    assert.match(h.app.store.decrypt(rows[0].result_encrypted), /PRIVATE_CHILD_RESULT/);
    assert.equal(h.app.store.get('SELECT run_id FROM tool_steps').run_id, result.runId);

    const trace = result.metadata.executionTrace;
    const nodeIds = new Set(trace.nodes.map(node => node.id));
    assert.ok(nodeIds.has(summary.nodeId));
    assert.ok(trace.nodes.some(node => node.kind === 'delegation'));
    assert.ok(trace.nodes.some(node => node.kind === 'subagent'));
    assert.ok(trace.nodes.some(node => node.kind === 'aggregate'));
    assert.equal(trace.nodes.filter(node => node.kind === 'model').length, 4);
    assert.equal(trace.nodes.filter(node => node.kind === 'tool').length, 1);
    const subagent = trace.nodes.find(node => node.id === summary.nodeId);
    const delegation = trace.nodes.find(node => node.kind === 'delegation');
    const aggregate = trace.nodes.find(node => node.kind === 'aggregate');
    assert.equal(subagent.agentRunId, summary.id);
    assert.equal(subagent.parentAgentRunId, result.runId);
    assert.equal(subagent.parentNodeId, delegation.id);
    assert.ok(trace.edges.some(edge => edge.from === delegation.id && edge.to === subagent.id));
    const childNodes = trace.nodes.filter(node => node.agentRunId === summary.id && node.id !== summary.nodeId);
    assert.ok(childNodes.length > 0);
    assert.ok(childNodes.every(node => node.parentNodeId === subagent.id && node.parentAgentRunId === result.runId));
    const childModels = childNodes.filter(node => node.kind === 'model');
    assert.equal(childModels.length, isolatedRequests.length);
    for (const [index, node] of childModels.entries()) {
      const values = details(node);
      assert.equal(node.status, 'completed');
      assert.equal(values['模型'], isolatedRequests[index].model);
      assert.equal(values['问答强度'], isolatedRequests[index].reasoning.effort);
      assert.equal(values['请求次序'], String(index + 1));
      assert.equal(values['用量'], '30 tokens');
    }
    const handoff = childNodes.find(node => node.kind === 'handoff');
    assert.ok(trace.edges.some(edge => edge.from === handoff.id && edge.to === aggregate.id));
    const anchorInfo = details(subagent);
    assert.ok(subagent.details.length <= 8);
    assert.equal(anchorInfo['Agent ID'], child.id);
    assert.equal(anchorInfo['深度'], '1');
    assert.equal(anchorInfo['输入字符数'], String('计费 PRIVATE_CHILD_TASK'.length));
    assert.equal(anchorInfo['历史消息数'], '0');
    assert.equal(anchorInfo['模型请求数'], '2');
    assert.equal(anchorInfo['用量'], '60 tokens');
    assert.equal(anchorInfo['工具步骤数'], '1');
    assert.equal(anchorInfo['来源数'], String(summary.sourceCount));
    const tool = childNodes.find(node => node.kind === 'tool');
    const toolInfo = details(tool);
    assert.ok(tool.details.length <= 8);
    assert.equal(toolInfo['资源 ID'], h.resource.id);
    assert.equal(toolInfo['修订'], String(h.resource.revision));
    assert.equal(toolInfo['环境'], 'production');
    assert.equal(toolInfo['风险'], 'read');
    assert.equal(toolInfo['步骤 ID'], h.app.store.get('SELECT id FROM tool_steps').id);
    for (const edge of trace.edges) { assert.ok(nodeIds.has(edge.from)); assert.ok(nodeIds.has(edge.to)); }
    for (const node of trace.nodes) { assert.notEqual(node.status, 'running'); assert.ok(node.finishedAt); }
    for (const secret of ['PRIVATE_', 'fixture-model-secret', 'fixture-mcp-secret', 'healthy', '"arguments"']) {
      assert.ok(!JSON.stringify(trace).includes(secret));
      assert.ok(!JSON.stringify(result.metadata.agentDelegation).includes(secret));
    }
    const observed = events.filter(event => event.type === 'trace');
    assert.ok(observed.some(event => event.trace.nodes.some(node => node.kind === 'subagent' && node.status === 'running')));
    assert.deepEqual(observed.at(-1).trace, trace);
    const requests = h.requests.length;
    const replay = await h.request('/chat', input);
    assert.equal(replay.status, 200, JSON.stringify(replay.data));
    assert.deepEqual(replay.data.metadata.agentDelegation, result.metadata.agentDelegation);
    assert.equal(h.requests.length, requests);
    assert.equal(ledger(h, result.runId).length, 1);
    const view = h.app.execution.view(h.user, result.runId);
    assert.equal(view.delegations.length, 1);
    assert.ok(!JSON.stringify(view.delegations).includes('PRIVATE_'));
    await h.restart();
    const saved = (await h.request(`/conversations/${result.conversationId}`)).data.messages.at(-1);
    assert.deepEqual(saved.metadata.agentDelegation, result.metadata.agentDelegation);
    assert.deepEqual(saved.metadata.executionTrace, trace);
    assert.equal(ledger(h, result.runId).length, 1);
  } finally { await h.close(); }
});

test('child bindings cannot widen a restricted parent resource set', async () => {
  const h = await runtimeFixture();
  try {
    const unbound = await make(h, { kind: 'knowledge', name: '计费仅子级', body: '计费 PRIVATE_CHILD_ONLY_KNOWLEDGE' });
    const child = await make(h, { kind: 'agents', name: '大范围子 Agent', knowledgeIds: [unbound.id], mcpIds: [h.resource.id] });
    const parent = await make(h, { kind: 'agents', name: '无工具父 Agent', knowledgeIds: [], skillIds: [], mcpIds: [] });
    let childBody;
    h.model((req, res) => {
      if (isChild(req.body)) { childBody = req.body; return answer(res); }
      answer(res, req.body.messages.at(-1).role === 'tool' ? undefined : [delegate([task('计费查询', child.id)])]);
    });
    const response = await h.request('/chat', { text: '计费', agentId: parent.id, ...auto });
    assert.equal(response.status, 200, JSON.stringify(response.data));
    assert.ok(childBody);
    assert.deepEqual(toolNames(childBody), []);
    assert.ok(!JSON.stringify(childBody).includes('PRIVATE_CHILD_ONLY_KNOWLEDGE'));
    assert.equal(h.fixtures.toolCalls.length, 0);
    assert.equal(h.requests.length, 3);
  } finally { await h.close(); }
});

test('unavailable child agents return failed structured results without requesting models or leaking private names', async () => {
  const h = await runtimeFixture();
  try {
    const child = await make(h, { kind: 'agents', name: 'PRIVATE_HIDDEN_AGENT_NAME', body: 'PRIVATE_HIDDEN_AGENT_BODY', visibility: 'private' });
    await h.request('/users', { username: 'delegation-member', password: 'delegation-member-password', role: 'member' });
    const member = (await h.request('/auth/login', { username: 'delegation-member', password: 'delegation-member-password' })).cookie;
    let failure;
    h.model((req, res) => {
      assert.ok(!isChild(req.body));
      if (req.body.messages.at(-1).role === 'tool') { failure = JSON.parse(req.body.messages.at(-1).content); return answer(res, undefined, '子任务不可用'); }
      answer(res, [delegate([task('PRIVATE_REJECTED_TASK', child.id)])]);
    });
    const response = await h.request('/chat', { text: '委派隐藏 Agent', ...auto }, 'POST', member);
    assert.equal(response.status, 200, JSON.stringify(response.data));
    assert.equal(h.requests.length, 2);
    assert.equal(h.fixtures.toolCalls.length, 0);
    const summary = children(response.data)[0];
    assert.equal(summary.status, 'failed');
    assert.equal(response.data.metadata.agentDelegation.status, 'partial');
    assert.equal(summary.errorCode, 'scope_denied');
    assert.ok(!JSON.stringify(summary).includes('PRIVATE_'));
    assert.ok(!JSON.stringify(failure).includes('PRIVATE_HIDDEN_AGENT_'));
    assert.equal(ledger(h, response.data.runId)[0].error_code, 'scope_denied');
    assert.equal(ledger(h, response.data.runId)[0].model_calls, 0);
    await h.request('/users', { username: 'delegation-outsider', password: 'delegation-outsider-password', role: 'member' });
    const outsiderCookie = (await h.request('/auth/login', { username: 'delegation-outsider', password: 'delegation-outsider-password' })).cookie;
    const outsider = await h.request(`/executions/${response.data.runId}`, undefined, 'GET', outsiderCookie);
    assert.equal(outsider.status, 404);
  } finally { await h.close(); }
});

test('delegated evidence enters independent review and reviewer shares the root budget', async () => {
  const h = await runtimeFixture({ evidenceReports: true });
  try {
    let payload;
    h.model((req, res) => {
      if (isReviewer(req.body)) { payload = JSON.parse(req.body.messages[1].content); return answer(res, undefined, '{"verdict":"pass","reasons":[]}'); }
      if (isChild(req.body)) return answer(res, req.body.messages.at(-1).role === 'tool' ? undefined : [call('review-child-read')], '子 Agent 工具证据');
      answer(res, req.body.messages.at(-1).role === 'tool' ? undefined : [delegate([task()])], '主 Agent 实际汇总');
    });
    const response = await h.request('/chat', { text: '计费状态查询', ...auto, reviewMode: 'independent' });
    assert.equal(response.status, 200, JSON.stringify(response.data));
    assert.equal(response.data.metadata.agentReview.status, 'accepted');
    assert.equal(payload.steps.length, 1);
    assert.equal(payload.evidence.length, 1);
    assert.equal(payload.steps[0].status, 'success');
    assert.deepEqual(JSON.parse(payload.evidence[0].arguments), { service: 'billing' });
    assert.match(payload.evidence[0].output, /healthy/);
    assert.equal(payload.evidence[0].stepId, h.app.store.get('SELECT id FROM tool_steps').id);
    assert.equal(response.data.metadata.usage.total_tokens, 150);
    assert.equal(h.app.store.get('SELECT tokens FROM executions WHERE id=?', response.data.runId).tokens, 150);
    assert.equal(h.requests.length, 5);
    assert.ok(!toolNames(h.requests.at(-1)).includes('delegate_agents'));
  } finally { await h.close(); }
});

test('a real MCP read failure remains failed in the child, trace and reviewer evidence', async () => {
  const h = await runtimeFixture({ evidenceReports: true });
  const candidate = 'PRIVATE_UNSUPPORTED_HEALTHY_CANDIDATE';
  try {
    h.fixtures.failReads(true);
    let payload, handoff;
    h.model((req, res) => {
      if (isReviewer(req.body)) {
        payload = JSON.parse(req.body.messages[1].content);
        return answer(res, undefined, '{"verdict":"block","reasons":["missing_evidence"]}');
      }
      if (isChild(req.body)) return answer(res, [call('child-failed-read')]);
      if (req.body.messages.at(-1).role === 'tool') { handoff = JSON.parse(req.body.messages.at(-1).content); return answer(res, undefined, candidate); }
      answer(res, [delegate([task('计费状态 password=child-task-private-secret')])]);
    });
    const response = await h.request('/chat', { text: '实时计费状态', ...auto, reviewMode: 'independent' });
    assert.equal(response.status, 200, JSON.stringify(response.data));
    assert.equal(response.data.metadata.agentReview.status, 'blocked');
    assert.equal(response.data.metadata.agentDelegation.status, 'partial');
    assert.equal(children(response.data)[0].status, 'failed');
    assert.equal(children(response.data)[0].errorCode, 'child_failed');
    assert.equal(children(response.data)[0].toolSteps, 1);
    assert.equal(handoff.results[0].status, 'failed');
    assert.equal(handoff.results[0].text, undefined);
    assert.equal(h.fixtures.toolCalls.length, 1);
    assert.equal(h.app.store.get('SELECT status FROM tool_steps').status, 'failed');
    const tool = response.data.metadata.executionTrace.nodes.find(node => node.kind === 'tool');
    assert.equal(tool.status, 'error');
    const toolInfo = details(tool);
    assert.ok(tool.details.length <= 8);
    assert.equal(toolInfo['资源 ID'], h.resource.id);
    assert.equal(toolInfo['修订'], String(h.resource.revision));
    assert.equal(toolInfo['环境'], 'production');
    assert.equal(toolInfo['风险'], 'read');
    assert.equal(toolInfo['步骤 ID'], h.app.store.get('SELECT id FROM tool_steps').id);
    assert.equal(toolInfo['持久状态'], 'failed');
    const anchor = response.data.metadata.executionTrace.nodes.find(node => node.kind === 'subagent');
    const anchorInfo = details(anchor);
    assert.ok(anchor.details.length <= 8);
    assert.equal(anchorInfo['Agent ID'], 'general');
    assert.equal(anchorInfo['深度'], '1');
    assert.equal(anchorInfo['输入字符数'], String('计费状态 password=child-task-private-secret'.length));
    assert.equal(anchorInfo['历史消息数'], '0');
    assert.equal(anchorInfo['错误代码'], 'child_failed');
    assert.equal(anchorInfo['模型请求数'], '1');
    assert.equal(anchorInfo['用量'], '30 tokens');
    assert.equal(anchorInfo['工具步骤数'], '1');
    assert.equal(response.data.metadata.evidenceReport.toolSteps[0].status, 'failed');
    assert.equal(payload.steps[0].status, 'failed');
    assert.equal(payload.delegations[0].status, 'failed');
    assert.ok(!JSON.stringify(payload).includes('child-task-private-secret'));
    assert.ok(!JSON.stringify(response.data).includes(candidate));
    const saved = (await h.request(`/conversations/${response.data.conversationId}`)).data;
    assert.ok(!JSON.stringify(saved).includes(candidate));
    assert.equal(h.requests.length, 4);
    assert.equal(h.app.execution.stats().active, 0);
    assert.equal(h.app.engine.health().delegation.active, 0);
    assert.equal(h.app.engine.health().delegation.queued, 0);
  } finally { await h.close(); }
});

test('pool size one can dispatch two simultaneous isolated children without waiting for its busy parent worker', async () => {
  const h = await runtimeFixture({ workerMode: 'prefork', poolSize: 1 });
  const waiting = [];
  let release;
  const bothEntered = new Promise(resolve => { release = resolve; });
  try {
    await h.app.engine.warmup();
    const workerPid = h.app.engine.health().workers[0].pid;
    h.model((req, res) => {
      if (isChild(req.body)) {
        waiting.push(res);
        if (waiting.length === 2) { waiting.forEach(child => answer(child)); release(); }
        return;
      }
      answer(res, req.body.messages.at(-1).role === 'tool' ? undefined : [delegate([task('甲子任务'), task('乙子任务')])]);
    });
    const running = h.request('/chat', { text: '并行委派', requestKey: 'delegation-pool-one', ...auto });
    let deadline;
    try {
      await Promise.race([bothEntered, new Promise((_, reject) => { deadline = setTimeout(() => reject(new Error('Children deadlocked behind pool size one')), 15000); })]);
    } catch (error) {
      const run = h.app.store.get('SELECT id FROM executions WHERE request_key=?', 'delegation-pool-one');
      if (run) await h.request(`/executions/${run.id}/cancel`, {});
      await running;
      throw error;
    } finally { clearTimeout(deadline); }
    const response = await running;
    assert.equal(response.status, 200, JSON.stringify(response.data));
    assert.equal(children(response.data).length, 2);
    assert.equal(h.requests.length, 4);
    assert.equal(new Set(children(response.data).map(child => child.id)).size, 2);
    assert.equal(h.app.engine.health().workers[0].pid, workerPid);
    assert.equal(h.app.execution.stats().active, 0);
  } finally { await h.close(); }
});

test('root cancellation aborts every child provider and persists terminal child and trace states', async () => {
  const h = await runtimeFixture();
  let entered;
  const bothEntered = new Promise(resolve => { entered = resolve; });
  let open = 0, closed = 0;
  try {
    h.model((req, res) => {
      if (isChild(req.body)) { res.on('close', () => { closed++; }); if (++open === 2) entered(); return; }
      answer(res, [delegate([task('慢速子任务甲'), task('慢速子任务乙')])]);
    });
    const running = h.request('/chat', { text: '停止全部子任务', requestKey: 'delegation-cancel-all', ...auto });
    await bothEntered;
    const run = h.app.store.get('SELECT * FROM executions WHERE request_key=?', 'delegation-cancel-all');
    assert.equal((await h.request(`/executions/${run.id}/cancel`, {})).status, 200);
    const response = await running;
    assert.equal(response.status, 504, JSON.stringify(response.data));
    await waitFor(() => closed === 2);
    await waitFor(() => h.app.engine.health().delegation.active === 0 && h.app.engine.health().delegation.queued === 0);
    assert.equal(h.app.store.get('SELECT status FROM executions WHERE id=?', run.id).status, 'cancelled');
    const rows = ledger(h, run.id);
    assert.equal(rows.length, 2);
    assert.ok(rows.every(row => row.status === 'cancelled' && row.finished));
    assert.equal(h.app.execution.stats().active, 0);
    assert.equal(h.app.store.get('SELECT busy_until FROM conversations WHERE id=?', run.conversation_id).busy_until, 0);
    const saved = (await h.request(`/conversations/${run.conversation_id}`)).data.messages.at(-1);
    const trace = saved.metadata.executionTrace;
    assert.equal(trace.status, 'cancelled');
    assert.ok(trace.nodes.filter(node => node.kind === 'subagent').every(node => node.status === 'cancelled'));
    assert.ok(trace.nodes.every(node => node.status !== 'running'));
    assert.equal(h.requests.length, 3);
  } finally { await h.close(); }
});

test('children inherit the confirmed target and a mixed batch reports the refused target as partial', async () => {
  const h = await runtimeFixture();
  try {
    const changed = await h.request(`/resources/${h.resource.id}`, { ...h.resource, toolPolicies: { ...h.resource.toolPolicies,
      service_status: { ...h.resource.toolPolicies.service_status, constraints: { service: ['billing', 'inventory'] }, requiredTargetFields: ['service'] },
    } }, 'PUT');
    assert.equal(changed.status, 200, JSON.stringify(changed.data));
    let aggregated;
    const seen = [];
    h.model((req, res) => {
      if (isChild(req.body)) {
        seen.push(req.body);
        const wrong = req.body.messages.some(message => message.role === 'user' && message.content.includes('错误目标'));
        return answer(res, req.body.messages.at(-1).role === 'tool' ? undefined : [call('child-target', 'mcp_0', { service: wrong ? 'inventory' : 'billing' })]);
      }
      if (req.body.messages.at(-1).role === 'tool') { aggregated = JSON.parse(req.body.messages.at(-1).content); return answer(res); }
      answer(res, [delegate([task('正确目标计费查询'), task('错误目标计费查询')])]);
    });
    const response = await h.request('/chat', { text: '确认计费 billing', targetBinding: { resourceId: h.resource.id, tool: 'service_status', environment: 'production', arguments: { service: 'billing' } }, ...auto });
    assert.equal(response.status, 200, JSON.stringify(response.data));
    assert.equal(response.data.metadata.agentDelegation.status, 'partial');
    assert.deepEqual(children(response.data).map(child => child.status), ['completed', 'failed']);
    assert.equal(aggregated.status, 'partial');
    assert.equal(aggregated.untrusted, true);
    assert.deepEqual(aggregated.results.map(child => child.status), ['completed', 'failed']);
    assert.equal(aggregated.results[1].errorCode, 'scope_denied');
    assert.equal(aggregated.results[1].text, undefined);
    assert.ok(aggregated.results.every(child => child.untrusted));
    assert.deepEqual(h.fixtures.toolCalls.map(tool => tool.service), ['billing']);
    assert.equal(h.app.store.get('SELECT count(*) AS n FROM tool_steps').n, 1);
    assert.ok(seen.every(body => JSON.stringify(body).includes('继承的已确认结构化查询目标')));
    assert.ok(seen.every(body => JSON.stringify(body).includes('billing')));
    const childNodes = response.data.metadata.executionTrace.nodes.filter(node => node.kind === 'subagent');
    assert.deepEqual(childNodes.map(node => node.status), ['completed', 'error']);
    assert.equal(response.data.metadata.usage.total_tokens, 150);
  } finally { await h.close(); }
});

test('child write and recursive delegation attempts cannot create approvals, side effects or grandchildren', async () => {
  const h = await runtimeFixture();
  try {
    for (const proposed of [call('child-write', 'mcp_1', { service: 'billing', state: 'maintenance' }), delegate([task('孙子任务')], 'child-recurse')]) {
      h.model((req, res) => {
        if (isChild(req.body)) {
          assert.ok(!toolNames(req.body).includes('mcp_1'));
          assert.ok(!toolNames(req.body).includes('delegate_agents'));
          return answer(res, [proposed]);
        }
        answer(res, req.body.messages.at(-1).role === 'tool' ? undefined : [delegate([task()])]);
      });
      const response = await h.request('/chat', { text: '只读一级委派', ...auto });
      assert.equal(response.status, 200, JSON.stringify(response.data));
      assert.equal(response.data.metadata.agentDelegation.status, 'partial');
      assert.equal(children(response.data).length, 1);
      assert.equal(children(response.data)[0].status, 'failed');
      assert.equal(children(response.data)[0].errorCode, 'scope_denied');
      assert.equal(ledger(h, response.data.runId).length, 1);
      assert.equal(ledger(h, response.data.runId)[0].depth, 1);
    }
    assert.equal(h.requests.length, 6);
    assert.equal(h.fixtures.toolCalls.length, 0);
    assert.equal(h.app.store.get('SELECT count(*) AS n FROM tool_steps').n, 0);
  } finally { await h.close(); }
});

test('strict malformed and over-parallel batches fail before any child is launched', async () => {
  const h = await runtimeFixture();
  try {
    const invalid = [
      { tasks: [] }, { tasks: [task(), task(), task(), task()] },
      { tasks: [{ agentId: null, task: '合法文字', targetBinding: { arguments: { service: 'inventory' } } }] },
      { tasks: [{ task: '缺少 Agent ID' }] }, { tasks: [task()], bypass: true },
    ];
    for (const [index, args] of invalid.entries()) {
      h.model((req, res) => answer(res, [call('invalid-delegate', 'delegate_agents', args)]));
      const response = await h.request('/chat', { text: `无效委派 ${index}`, ...auto });
      assert.equal(response.status, 400, JSON.stringify(response.data));
      assert.equal(ledger(h, response.data.runId).length, 0);
      const saved = (await h.request(`/conversations/${response.data.conversationId}`)).data.messages.at(-1);
      assert.equal(saved.role, 'error');
      assert.equal(saved.metadata.executionTrace.nodes.filter(node => node.kind === 'subagent').length, 0);
    }
    assert.equal(h.requests.length, invalid.length);
    assert.equal(h.fixtures.toolCalls.length, 0);
  } finally { await h.close(); }
});

test('the total child cap rejects a fifth child without replaying earlier batches', async () => {
  const h = await runtimeFixture();
  try {
    h.model((req, res) => {
      if (isChild(req.body)) return answer(res);
      const batches = req.body.messages.filter(message => message.role === 'tool').length;
      answer(res, [delegate(batches === 0 ? [task('甲'), task('乙'), task('丙')] : [task(batches === 1 ? '丁' : '禁止的第五项')], `delegate-batch-${batches}`)]);
    });
    const input = { text: '全轮子任务限制', requestKey: 'delegation-child-cap-once', ...auto };
    const response = await h.request('/chat', input);
    assert.equal(response.status, 422, JSON.stringify(response.data));
    assert.equal(ledger(h, response.data.runId).length, 4);
    assert.ok(ledger(h, response.data.runId).every(row => row.status === 'completed'));
    assert.equal(h.requests.filter(body => isChild(body)).length, 4);
    assert.equal(h.requests.length, 7);
    const saved = (await h.request(`/conversations/${response.data.conversationId}`)).data.messages.at(-1);
    assert.equal(saved.metadata.agentDelegation.children.length, 4);
    assert.equal(saved.metadata.executionTrace.status, 'error');
    const calls = h.requests.length;
    const replay = await h.request('/chat', input);
    assert.equal(replay.status, 409);
    assert.equal(replay.data.runId, response.data.runId);
    assert.equal(h.requests.length, calls);
  } finally { await h.close(); }
});

test('child round exhaustion returns a failed handoff and retains actual read evidence', async () => {
  const h = await runtimeFixture();
  try {
    let handoff;
    h.model((req, res) => {
      if (isChild(req.body)) return answer(res, [call('child-never-finishes')]);
      if (req.body.messages.at(-1).role === 'tool') { handoff = JSON.parse(req.body.messages.at(-1).content); return answer(res, undefined, '子任务达到上限，查询证据仍保留'); }
      answer(res, [delegate([task()])]);
    });
    const response = await h.request('/chat', { text: '限制子任务循环', ...auto });
    assert.equal(response.status, 200, JSON.stringify(response.data));
    const child = children(response.data)[0];
    assert.equal(child.status, 'failed');
    assert.equal(child.errorCode, 'budget_or_round_limit');
    assert.equal(child.modelCalls, 3);
    assert.equal(child.toolSteps, 3);
    assert.equal(handoff.results[0].text, undefined);
    assert.equal(handoff.results[0].status, 'failed');
    assert.equal(handoff.status, 'partial');
    assert.equal(response.data.metadata.tools.length, 3);
    assert.equal(h.fixtures.toolCalls.length, 3);
    assert.equal(h.requests.length, 5);
    assert.equal(response.data.metadata.usage.total_tokens, 150);
  } finally { await h.close(); }
});

test('three large Chinese and emoji child answers preserve code points within the byte budget for parent summary', async () => {
  const h = await runtimeFixture();
  try {
    const labels = ['甲', '乙', '丙'];
    const longAnswers = ['计费查询🙂', '数据库状态🚀', '网络连接🌐'].map(text => text.repeat(1500));
    const verifyText = (text, original) => {
      assert.ok(Buffer.byteLength(text, 'utf8') <= 4000);
      assert.ok(Buffer.byteLength(text, 'utf8') >= 3997);
      assert.equal(Buffer.from(text, 'utf8').toString('utf8'), text, 'UTF-8 encoding must preserve every returned code point');
      assert.equal(text, Array.from(original).slice(0, Array.from(text).length).join(''));
      assert.ok(!text.includes('\uFFFD'));
    };
    let handoff;
    h.model((req, res) => {
      if (isChild(req.body)) {
        const index = labels.indexOf(req.body.messages.find(message => message.role === 'user').content);
        assert.ok(index >= 0);
        return answer(res, undefined, longAnswers[index]);
      }
      if (req.body.messages.at(-1).role === 'tool') { handoff = JSON.parse(req.body.messages.at(-1).content); return answer(res, undefined, '有界结果已汇总'); }
      answer(res, [delegate([task('甲'), task('乙'), task('丙')])]);
    });
    const response = await h.request('/chat', { text: '汇总较长子任务', ...auto });
    assert.equal(response.status, 200, JSON.stringify(response.data));
    assert.equal(response.data.text, '有界结果已汇总');
    assert.equal(handoff.results.length, 3);
    for (const [index, result] of handoff.results.entries()) {
      verifyText(result.text, longAnswers[index]);
      assert.equal(result.truncated, true);
      assert.equal(result.untrusted, true);
    }
    assert.equal(children(response.data).length, 3);
    assert.ok(children(response.data).every(child => child.status === 'completed'));
    for (const row of ledger(h, response.data.runId)) {
      const saved = JSON.parse(h.app.store.decrypt(row.result_encrypted));
      const index = handoff.results.findIndex(result => result.id === row.id);
      verifyText(saved.text, longAnswers[index]);
      assert.equal(saved.truncated, true);
      assert.equal(saved.text, handoff.results[index].text);
    }
    assert.equal(h.requests.length, 5);
  } finally { await h.close(); }
});

test('children cannot escape the parent token budget by opening independent runtime IDs', async () => {
  const h = await runtimeFixture();
  try {
    h.model((req, res) => {
      assert.ok(!isChild(req.body), 'No child provider request should fit the exhausted root budget');
      h.app.store.run("UPDATE executions SET tokens=99000 WHERE status='running'");
      answer(res, [delegate([task('甲'), task('乙'), task('丙')])]);
    });
    const response = await h.request('/chat', { text: '共同 token 预算', ...auto });
    assert.equal(response.status, 422, JSON.stringify(response.data));
    const rows = ledger(h, response.data.runId);
    assert.equal(rows.length, 3);
    assert.ok(rows.every(row => row.status === 'failed' && row.model_calls === 0));
    assert.ok(rows.every(row => row.error_code === 'budget_or_round_limit'));
    assert.equal(h.requests.length, 1);
    assert.equal(h.fixtures.toolCalls.length, 0);
    assert.equal(h.app.store.get('SELECT tokens FROM executions WHERE id=?', response.data.runId).tokens, 99030);
  } finally { await h.close(); }
});

test('the child process limit applies across simultaneous parent runs and drains its waiting queue', async () => {
  const h = await runtimeFixture({ workerMode: 'prefork', poolSize: 2 });
  const held = [];
  let release = false;
  try {
    h.model((req, res) => {
      if (isChild(req.body)) { if (release) answer(res); else held.push(res); return; }
      answer(res, req.body.messages.at(-1).role === 'tool' ? undefined : [delegate([task('甲'), task('乙'), task('丙')])]);
    });
    const first = h.request('/chat', { text: '全局并发甲', requestKey: 'delegation-global-child-limit-a', ...auto });
    const second = h.request('/chat', { text: '全局并发乙', requestKey: 'delegation-global-child-limit-b', ...auto });
    try {
      await waitFor(() => held.length === 3 && h.app.engine.health().delegation.queued === 3, 10000);
      assert.equal(h.app.engine.health().delegation.active, 3);
      assert.equal(h.app.engine.health().delegation.limit, 3);
      assert.equal(h.app.execution.stats().active, 2);
      release = true;
      held.forEach(response => answer(response));
      const responses = await Promise.all([first, second]);
      for (const response of responses) {
        assert.equal(response.status, 200, JSON.stringify(response.data));
        assert.equal(children(response.data).length, 3);
        assert.ok(children(response.data).every(child => child.status === 'completed'));
        assert.equal(response.data.metadata.usage.total_tokens, 150);
      }
      assert.equal(h.requests.length, 10);
      assert.equal(h.app.engine.health().delegation.active, 0);
      assert.equal(h.app.engine.health().delegation.queued, 0);
    } catch (error) {
      for (const run of h.app.store.all("SELECT id FROM executions WHERE status='running'")) await h.request(`/executions/${run.id}/cancel`, {});
      await Promise.allSettled([first, second]);
      throw error;
    }
  } finally { await h.close(); }
});

test('all parent and child requests consume one global model-round ceiling', async () => {
  const h = await runtimeFixture();
  try {
    h.model((req, res) => {
      if (isChild(req.body)) return answer(res, [call('child-global-budget')]);
      const batches = req.body.messages.filter(message => message.role === 'tool').length;
      answer(res, [delegate(batches === 0 ? [task('甲'), task('乙'), task('丙')] : [task('丁')], `global-budget-${batches}`)]);
    });
    const response = await h.request('/chat', { text: '共同预算', ...auto });
    assert.equal(response.status, 422, JSON.stringify(response.data));
    assert.equal(h.requests.length, 12);
    assert.equal(ledger(h, response.data.runId).length, 4);
    assert.ok(ledger(h, response.data.runId).every(row => row.status === 'failed'));
    assert.ok(ledger(h, response.data.runId).every(row => row.model_calls <= 3));
    assert.equal(h.app.store.get('SELECT tokens FROM executions WHERE id=?', response.data.runId).tokens, 360);
    const saved = (await h.request(`/conversations/${response.data.conversationId}`)).data.messages.at(-1);
    assert.equal(saved.metadata.executionTrace.nodes.filter(node => node.kind === 'model').length, 12);
    assert.ok(saved.metadata.executionTrace.nodes.every(node => node.status !== 'running'));
  } finally { await h.close(); }
});

test('backup rotation preserves encrypted child data and startup interrupts active children without replay', async () => {
  const h = await runtimeFixture();
  try {
    h.model((req, res) => {
      if (isChild(req.body)) return answer(res, undefined, 'PRIVATE_RECOVERY_CHILD_RESULT');
      answer(res, req.body.messages.at(-1).role === 'tool' ? undefined : [delegate([task('PRIVATE_RECOVERY_CHILD_TASK')])]);
    });
    const input = { text: '恢复委派记录', requestKey: 'delegation-recovery-once', ...auto };
    const response = await h.request('/chat', input);
    assert.equal(response.status, 200, JSON.stringify(response.data));
    const before = ledger(h, response.data.runId)[0];
    const plaintext = { task: h.app.store.decrypt(before.task_encrypted), result: h.app.store.decrypt(before.result_encrypted) };
    const recovery = join(h.dir, 'delegation-recovery.key');
    writeFileSync(recovery, randomBytes(32), { mode: 0o600 });
    const backup = join(h.dir, 'delegation-backup'), rotated = join(h.dir, 'delegation-rotated');
    const manifest = await createBackup(h.dir, backup, recovery);
    assert.equal(manifest.schema, 7);
    await rotateBackup(backup, rotated, recovery);
    assert.notDeepEqual(readFileSync(join(h.dir, 'master.key')), readFileSync(join(rotated, 'master.key')));
    const count = h.requests.length;
    await h.restart(undefined, rotated);
    const after = ledger(h, response.data.runId)[0];
    assert.notEqual(after.task_encrypted, before.task_encrypted);
    assert.notEqual(after.result_encrypted, before.result_encrypted);
    assert.equal(h.app.store.decrypt(after.task_encrypted), plaintext.task);
    assert.equal(h.app.store.decrypt(after.result_encrypted), plaintext.result);
    assert.equal((await h.request('/chat', input)).status, 200);
    assert.equal(h.requests.length, count);

    // Seed a crash boundary in the offline fixture database. Startup must never
    // infer a completed result or rerun work from an active persisted record.
    h.app.store.run("UPDATE executions SET status='running',result=NULL WHERE id=?", response.data.runId);
    h.app.store.run("UPDATE agent_delegations SET status='running',finished=NULL WHERE id=?", after.id);
    await h.restart();
    assert.equal(h.app.store.get('SELECT status FROM executions WHERE id=?', response.data.runId).status, 'interrupted');
    const interrupted = ledger(h, response.data.runId)[0];
    assert.equal(interrupted.status, 'interrupted');
    assert.ok(interrupted.finished);
    assert.equal(h.app.store.decrypt(interrupted.task_encrypted), plaintext.task);
    assert.equal(h.requests.length, count);
    const replay = await h.request('/chat', input);
    assert.equal(replay.status, 409);
    assert.equal(replay.data.runId, response.data.runId);
    assert.equal(h.requests.length, count);
    const view = h.app.execution.view(h.user, response.data.runId);
    assert.equal(view.delegations[0].status, 'interrupted');
    assert.ok(!JSON.stringify(view.delegations).includes('PRIVATE_RECOVERY_'));
  } finally { await h.close(); }
});
