import { sendResponsesSse } from './responses-fixture.mjs';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import { runtimeFixture, answer, call } from './runtime-fixture.mjs';
import { listen } from './fixtures.mjs';

const isReviewer = body => body.messages?.[0]?.content.startsWith('independent-evidence-review/v1');
const pass = JSON.stringify({ verdict: 'pass', reasons: [] });
const draft = 'PRIVATE_ANALYST_DRAFT';
const independent = { text: '查询计费当前状态', reviewMode: 'independent' };
const reviewerResult = (req, res) => answer(res, undefined, isReviewer(req.body) ? pass : draft);

test('review is opt-in, rejects invalid modes, and mode is part of durable request identity', async () => {
  const h = await runtimeFixture();
  try {
    h.model(reviewerResult);
    const input = { text: '解释计费知识', requestKey: 'review-mode-identity' };
    const normal = await h.request('/chat', input);
    assert.equal(normal.status, 200); assert.equal(normal.data.metadata.agentReview, undefined);
    assert.equal(h.requests.length, 1);
    assert.equal((await h.request('/chat', { ...input, reviewMode: 'off' })).status, 200);
    assert.equal((await h.request('/chat', { ...input, reviewMode: 'independent' })).status, 409);
    assert.equal((await h.request('/chat', { text: '无效', reviewMode: 'automatic' })).status, 400);
    assert.equal(h.requests.length, 1);
  } finally { await h.close(); }
});

test('isolated reviewer sees authorized history, knowledge and actual steps; totals, replay and restart agree', async () => {
  const h = await runtimeFixture();
  try {
    const knowledge = (await h.request('/resources', { kind: 'knowledge', name: '计费证据', body: '计费当前状态必须查询。AUTHORIZED_KNOWLEDGE' })).data;
    await h.request('/resources', { kind: 'knowledge', name: '计费未绑定', body: '计费 UNBOUND_KNOWLEDGE' });
    const skill = (await h.request('/resources', { kind: 'skills', name: '分析流程', body: 'ANALYST_SKILL_ONLY' })).data;
    const agent = (await h.request('/resources', { kind: 'agents', name: '计费子领域', body: 'ANALYST_SYSTEM_ONLY', skillIds: [skill.id], knowledgeIds: [knowledge.id], mcpIds: [h.resource.id] })).data;
    const initial = await h.request('/chat', { text: 'HISTORY_REFERENCE', agentId: agent.id });
    let payload;
    h.model((req, res) => {
      if (isReviewer(req.body)) {
        assert.equal(req.body.tools, undefined);
        assert.equal(req.body.messages.length, 2);
        payload = JSON.parse(req.body.messages[1].content);
        return answer(res, undefined, pass);
      }
      answer(res, req.body.messages.at(-1).role === 'tool' ? undefined : [call()], draft);
    });
    const input = { ...independent, conversationId: initial.data.conversationId, requestKey: 'review-evidence-once' };
    const result = await h.request('/chat', input); assert.equal(result.status, 200, JSON.stringify(result.data));
    const review = result.data.metadata.agentReview;
    assert.equal(result.data.text, draft); assert.equal(review.status, 'accepted');
    assert.deepEqual(review.stages, [{ role: 'analyst', modelCalls: 2, tokens: 60 }, { role: 'reviewer', modelCalls: 1, tokens: 30 }]);
    assert.equal(result.data.metadata.usage.total_tokens, 90);
    assert.equal(h.app.store.get('SELECT tokens FROM executions WHERE id=?', result.data.runId).tokens, 90);
    assert.equal(payload.question, independent.text); assert.equal(payload.candidate, draft);
    assert.ok(payload.history.some(m => m.content === 'HISTORY_REFERENCE'));
    assert.deepEqual(payload.sources.map(s => s.resourceId), [knowledge.id]);
    assert.equal(payload.evidence.length, 1); assert.equal(payload.steps.length, 1);
    assert.equal(payload.evidence[0].stepId, payload.steps[0].id); assert.equal(payload.steps[0].status, 'success');
    assert.deepEqual(JSON.parse(payload.evidence[0].arguments), { service: 'billing' });
    assert.match(payload.evidence[0].output, /healthy/);
    const reviewerBody = h.requests.at(-1);
    for (const instruction of ['ANALYST_SKILL_ONLY', 'ANALYST_SYSTEM_ONLY', 'UNBOUND_KNOWLEDGE']) assert.ok(!JSON.stringify(reviewerBody).includes(instruction));
    for (const secret of ['fixture-model-secret', 'fixture-mcp-secret']) assert.ok(!JSON.stringify(reviewerBody).includes(secret));
    const count = h.requests.length;
    assert.deepEqual((await h.request('/chat', input)).data.metadata.agentReview, review);
    assert.equal(h.requests.length, count); assert.equal(h.fixtures.toolCalls.length, 1);
    await h.restart();
    assert.deepEqual((await h.request(`/conversations/${result.data.conversationId}`)).data.messages.at(-1).metadata.agentReview, review);
    await h.request('/users', { username: 'outsider', password: 'outside-review-password', role: 'member' });
    const outsider = (await h.request('/auth/login', { username: 'outsider', password: 'outside-review-password' })).cookie;
    assert.equal((await h.request(`/conversations/${result.data.conversationId}`, undefined, 'GET', outsider)).status, 404);
  } finally { await h.close(); }
});

test('strict verdicts reject malformed, contradictory and extra data without publishing drafts', async () => {
  const h = await runtimeFixture();
  try {
    const invalid = ['not-json', '```json\n' + pass + '\n```', JSON.stringify({ verdict: 'pass', reasons: ['missing_evidence'] }),
      JSON.stringify({ verdict: 'block', reasons: [] }), JSON.stringify({ verdict: 'pass', reasons: [], approved: true }),
      JSON.stringify({ verdict: 'block', reasons: ['unknown_reason'] }), JSON.stringify({ verdict: 'block', reasons: ['stale_evidence', 'stale_evidence'] })];
    for (const text of invalid) {
      h.model((req, res) => answer(res, undefined, isReviewer(req.body) ? text : draft));
      const result = await h.request('/chat', independent);
      assert.equal(result.status, 200); assert.equal(result.data.metadata.agentReview.status, 'unavailable');
      assert.deepEqual(result.data.metadata.agentReview.reasons, ['invalid_review']);
      const saved = (await h.request(`/conversations/${result.data.conversationId}`)).data;
      assert.ok(!JSON.stringify(saved).includes(draft));
      assert.equal(result.data.metadata.agentReview.stages[1].modelCalls, 1);
    }
    assert.equal(h.fixtures.toolCalls.length, 0);
  } finally { await h.close(); }
});

test('target mismatch keeps actual evidence but suppresses draft and reviewer output', async () => {
  const h = await runtimeFixture();
  try {
    h.model((req, res) => {
      if (isReviewer(req.body)) return answer(res, undefined, JSON.stringify({ verdict: 'block', reasons: ['target_mismatch'] }));
      answer(res, req.body.messages.at(-1).role === 'tool' ? undefined : [call()], draft);
    });
    const result = await h.request('/chat', independent);
    assert.equal(result.data.metadata.agentReview.status, 'blocked');
    assert.match(result.data.text, /不会撤销/); assert.ok(!result.data.text.includes(draft));
    assert.equal(h.fixtures.toolCalls.length, 1); assert.equal(result.data.metadata.tools.length, 1);
    const audit = h.app.store.all("SELECT detail FROM audit WHERE action='agent.review'");
    assert.ok(!JSON.stringify(audit).includes(draft));
  } finally { await h.close(); }
});

test('reviewer cannot call tools, and transient provider retries never publish its draft', async () => {
  const h = await runtimeFixture();
  try {
    for (const failure of ['tool', 'provider']) {
      h.model((req, res) => {
        if (!isReviewer(req.body)) return answer(res, undefined, draft);
        if (failure === 'tool') return answer(res, [call('forbidden-review-tool')]);
        res.status(503).send('PRIVATE_REVIEW_PROVIDER_ERROR');
      });
      const count = h.requests.length;
      const result = await h.request('/chat', independent);
      assert.equal(result.status, 200); assert.equal(result.data.metadata.agentReview.status, 'unavailable');
      assert.deepEqual(result.data.metadata.agentReview.reasons, [failure === 'tool' ? 'invalid_review' : 'review_failed']);
      assert.equal(result.data.metadata.agentReview.stages[1].modelCalls, failure === 'provider' ? 6 : 1);
      assert.equal(h.requests.length - count, failure === 'provider' ? 7 : 2); assert.equal(h.fixtures.toolCalls.length, 0);
      assert.ok(!JSON.stringify(result.data).includes('PRIVATE_'));
    }
  } finally { await h.close(); }
});

test('pending writes skip model review and still require independent human approval', async () => {
  const h = await runtimeFixture();
  try {
    h.model((req, res) => answer(res, [call('write-plan', 'mcp_1', { service: 'billing', state: 'maintenance' })]));
    const result = await h.request('/chat', independent);
    assert.equal(result.status, 200); assert.equal(result.data.status, 'awaiting_approval');
    assert.equal(result.data.metadata.agentReview.status, 'skipped');
    assert.deepEqual(result.data.metadata.agentReview.reasons, ['approval_required']);
    assert.equal(result.data.metadata.agentReview.stages[1].modelCalls, 0);
    assert.equal(h.requests.length, 1); assert.equal(h.fixtures.toolCalls.length, 0);
    assert.equal((await h.request(`/approvals/${result.data.stepId}/approve`, {}, 'POST')).status, 403);
    assert.equal((await h.request(`/approvals/${result.data.stepId}/approve`, {}, 'POST', h.reviewer)).status, 200);
    assert.equal(h.requests.length, 1);
    assert.equal((await h.request(`/conversations/${result.data.conversationId}`)).data.messages.at(-1).metadata.agentReview.status, 'skipped');
  } finally { await h.close(); }
});

test('five analyst calls exhaust the reviewed request without an unbounded sixth analysis', async () => {
  const h = await runtimeFixture();
  try {
    h.model((req, res) => answer(res, [call()]));
    const result = await h.request('/chat', independent);
    assert.equal(result.status, 422); assert.equal(h.requests.length, 5); assert.equal(h.fixtures.toolCalls.length, 5);
    const saved = (await h.request(`/conversations/${result.data.conversationId}`)).data.messages.at(-1);
    assert.equal(saved.role, 'error'); assert.equal(saved.metadata.agentReview.stages[1].modelCalls, 0);
  } finally { await h.close(); }
});

test('insufficient remaining budget blocks review without dropping evidence or publishing draft', async () => {
  const h = await runtimeFixture();
  try {
    h.model((req, res) => {
      h.app.store.run("UPDATE executions SET tokens=99000 WHERE status='running'");
      answer(res, undefined, draft);
    });
    const result = await h.request('/chat', independent);
    assert.equal(result.status, 200); assert.equal(result.data.metadata.agentReview.status, 'unavailable');
    assert.deepEqual(result.data.metadata.agentReview.reasons, ['review_input_too_large']);
    assert.equal(result.data.metadata.agentReview.stages[1].modelCalls, 0); assert.equal(h.requests.length, 1);
    assert.ok(!result.data.text.includes(draft));
  } finally { await h.close(); }
});

test('truncated tool output cannot receive a model pass on incomplete evidence', async () => {
  const h = await runtimeFixture();
  try {
    const execute = h.app.execution.callStep;
    h.app.execution.callStep = async (...args) => {
      const step = await execute(...args);
      return { ...step, response: { content: [{ type: 'text', text: 'large-evidence '.repeat(2000) }] } };
    };
    h.model((req, res) => answer(res, req.body.messages.at(-1).role === 'tool' ? undefined : [call()], draft));
    const result = await h.request('/chat', independent);
    assert.equal(result.status, 200); assert.deepEqual(result.data.metadata.agentReview.reasons, ['review_input_too_large']);
    assert.equal(result.data.metadata.agentReview.stages[1].modelCalls, 0);
    assert.equal(h.requests.length, 2); assert.equal(h.fixtures.toolCalls.length, 1);
    assert.ok(!result.data.text.includes(draft));
  } finally { await h.close(); }
});

test('resource changes before review and user revocation during review fail the execution', async () => {
  const h = await runtimeFixture();
  try {
    h.model((req, res) => {
      h.app.store.run('UPDATE resources SET updated=? WHERE id=?', '2100-01-01T00:00:00.000Z', h.resource.id);
      answer(res, undefined, draft);
    });
    const changed = await h.request('/chat', independent);
    assert.equal(changed.status, 403); assert.equal(h.requests.length, 1);
    h.model((req, res) => {
      if (isReviewer(req.body)) h.app.store.run('UPDATE users SET active=0 WHERE id=?', h.user.id);
      answer(res, undefined, isReviewer(req.body) ? pass : draft);
    });
    const userId = h.user.id;
    const revoked = await h.request('/chat', independent);
    assert.equal(revoked.status, 403);
    h.app.store.run('UPDATE users SET active=1 WHERE id=?', userId);
    const message = (await h.request(`/conversations/${revoked.data.conversationId}`)).data.messages.at(-1);
    assert.equal(message.role, 'error'); assert.equal(message.metadata.agentReview.status, 'unavailable');
    assert.ok(!JSON.stringify(message).includes(draft));
  } finally { await h.close(); }
});

test('cancellation during review aborts the shared run and never publishes a candidate', async () => {
  const h = await runtimeFixture();
  let entered; const reviewing = new Promise(resolve => { entered = resolve; });
  try {
    h.model((req, res) => { if (isReviewer(req.body)) entered(); else answer(res, undefined, draft); });
    const running = h.request('/chat', { ...independent, requestKey: 'cancel-during-review' });
    await reviewing;
    const run = h.app.store.get('SELECT * FROM executions WHERE request_key=?', 'cancel-during-review');
    assert.equal((await h.request(`/executions/${run.id}/cancel`, {})).status, 200);
    const result = await running; assert.equal(result.status, 504);
    assert.equal(h.app.store.get('SELECT status FROM executions WHERE id=?', run.id).status, 'cancelled');
    const saved = (await h.request(`/conversations/${run.conversation_id}`)).data;
    assert.ok(!JSON.stringify(saved).includes(draft)); assert.equal(saved.messages.at(-1).role, 'error');
    assert.equal(h.requests.length, 2);
  } finally { await h.close(); }
});

test('Responses review has its own transcript and excludes opaque analyst reasoning', async () => {
  const h = await runtimeFixture(); const endpoint = express(); endpoint.use(express.json());
  const requests = []; const opaque = { type: 'reasoning', id: 'rs_review', summary: [], encrypted_content: 'PRIVATE_OPAQUE_REASONING' };
  endpoint.post('/v1/responses', (req, res) => {
    requests.push(req.body);
    const reviewer = req.body.input[0]?.content?.startsWith('independent-evidence-review/v1');
    let output;
    if (reviewer) output = [{ type: 'message', role: 'assistant', content: [{ type: 'output_text', text: pass }] }];
    else if (!req.body.input.some(i => i.type === 'function_call_output')) output = [opaque, { type: 'function_call', call_id: 'responses-review', name: 'mcp_0', arguments: '{"service":"billing"}' }];
    else output = [{ type: 'message', role: 'assistant', content: [{ type: 'output_text', text: draft }] }];
    sendResponsesSse(res, { status: 'completed', output, usage: { input_tokens: 30, output_tokens: 10, total_tokens: 40 } });
  });
  const provider = await listen(endpoint);
  try {
    await h.request('/settings/model', { baseUrl: provider.url + '/v1', model: 'responses-review', apiType: 'responses' }, 'PUT');
    const result = await h.request('/chat', independent);
    assert.equal(result.status, 200); assert.equal(result.data.metadata.agentReview.status, 'accepted');
    assert.equal(requests.length, 3); assert.deepEqual(requests[1].input.find(i => i.type === 'reasoning'), opaque);
    assert.equal(requests[2].tools, undefined); assert.equal(requests[2].input.length, 2);
    assert.ok(!JSON.stringify(requests[2]).includes('PRIVATE_OPAQUE_REASONING'));
    assert.equal(result.data.metadata.usage.total_tokens, 120); assert.equal(h.fixtures.toolCalls.length, 1);
  } finally { await provider.close(); await h.close(); }
});
