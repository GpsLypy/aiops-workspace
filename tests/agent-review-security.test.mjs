import { test } from 'node:test';
import assert from 'node:assert/strict';
import { runtimeFixture, answer, call } from './runtime-fixture.mjs';

const isReviewer = req => req.body.messages[0].content.startsWith('independent-evidence-review/v1');
const draft = 'PRIVATE_CANDIDATE_只允许复核后发布';

// The real MCP fixture echoes service inside content[].text JSON. Supplying
// encoded JSON as that value exercises multiple independent serialization
// layers through the actual SDK, execution ledger and review provider request.
async function nestedEvidence(h, service) {
  const changed = await h.request(`/resources/${h.resource.id}`, {
    ...h.resource,
    toolPolicies: { ...h.resource.toolPolicies,
      service_status: { ...h.resource.toolPolicies.service_status, constraints: { service: [service] } },
    },
  }, 'PUT');
  assert.equal(changed.status, 200, JSON.stringify(changed.data));
  let reviewerPayload;
  h.model((req, res) => {
    if (isReviewer(req)) {
      reviewerPayload = JSON.parse(req.body.messages[1].content);
      return answer(res, undefined, '{"verdict":"pass","reasons":[]}');
    }
    answer(res, req.body.messages.at(-1).role === 'tool' ? undefined : [call('nested-evidence', 'mcp_0', { service })], draft);
  });
  return { get reviewerPayload() { return reviewerPayload; } };
}

for (const workerMode of ['cold', 'prefork']) test(`${workerMode}: reviewer redacts nested MCP JSON and preserves int64 evidence`, async () => {
  const previous = process.env.MODEL_DATA_POLICY;
  process.env.MODEL_DATA_POLICY = 'redact';
  const h = await runtimeFixture({ workerMode });
  try {
    const service = '{ "password": "demo-private-password", "api_key": "demo-private-api-key", "jobid": 9223372036854775807, "status": "healthy" }';
    const capture = await nestedEvidence(h, service);
    const result = await h.request('/chat', { text: '查询状态并独立复核', reviewMode: 'independent' });
    assert.equal(result.status, 200, JSON.stringify(result.data));
    assert.equal(result.data.metadata.agentReview.status, 'accepted');
    assert.equal(h.fixtures.toolCalls.length, 1);
    assert.equal(h.requests.length, 3);
    const payload = capture.reviewerPayload;
    assert.ok(payload);
    const wire = JSON.stringify(payload);
    assert.ok(!wire.includes('demo-private-password'));
    assert.ok(!wire.includes('demo-private-api-key'));
    assert.ok(wire.includes('[REDACTED]'));
    const args = JSON.parse(payload.evidence[0].arguments);
    const output = JSON.parse(JSON.parse(payload.evidence[0].output).content[0].text);
    for (const preserved of [args.service, output.service]) {
      assert.ok(preserved.includes('9223372036854775807'));
      assert.ok(preserved.includes('"status": "healthy"'));
      assert.ok(!preserved.includes('9223372036854776000'));
    }
    assert.equal(payload.steps[0].status, 'success');
    assert.deepEqual(result.data.metadata.agentReview.stages.map(s => s.modelCalls), [2, 1]);
  } finally {
    await h.close();
    if (previous === undefined) delete process.env.MODEL_DATA_POLICY; else process.env.MODEL_DATA_POLICY = previous;
  }
});

test('block policy stops nested credentials before the reviewer request and never publishes the candidate', async () => {
  const previous = process.env.MODEL_DATA_POLICY;
  process.env.MODEL_DATA_POLICY = 'block';
  const h = await runtimeFixture();
  try {
    const capture = await nestedEvidence(h, '{"password":"blocked-private-password","api_key":"blocked-private-api-key"}');
    const result = await h.request('/chat', { text: '检查嵌套证据的出口阻断', reviewMode: 'independent' });
    assert.equal(result.status, 200, JSON.stringify(result.data));
    assert.equal(result.data.metadata.agentReview.status, 'unavailable');
    assert.deepEqual(result.data.metadata.agentReview.reasons, ['review_failed']);
    assert.equal(capture.reviewerPayload, undefined);
    assert.equal(h.requests.length, 2);
    assert.equal(h.fixtures.toolCalls.length, 1);
    assert.deepEqual(result.data.metadata.agentReview.stages.map(s => s.modelCalls), [2, 0]);
    const saved = (await h.request(`/conversations/${result.data.conversationId}`)).data;
    const run = h.app.execution.view(h.user, result.data.runId);
    assert.ok(!JSON.stringify(saved).includes(draft));
    assert.ok(!JSON.stringify(run.result).includes(draft));
    assert.equal(run.steps[0].status, 'success');
  } finally {
    await h.close();
    if (previous === undefined) delete process.env.MODEL_DATA_POLICY; else process.env.MODEL_DATA_POLICY = previous;
  }
});

test('reviewer protection handles Unicode-escaped credential names without changing numeric evidence', async () => {
  const h = await runtimeFixture();
  try {
    const capture = await nestedEvidence(h, '{"\\u0070assword":"escaped-private-password","api_\\u006bey":"escaped-private-api-key","id":9223372036854775807}');
    const result = await h.request('/chat', { text: '检查转义凭据字段', reviewMode: 'independent' });
    assert.equal(result.status, 200, JSON.stringify(result.data));
    assert.equal(result.data.metadata.agentReview.status, 'accepted');
    const wire = JSON.stringify(capture.reviewerPayload);
    assert.ok(!wire.includes('escaped-private-password'));
    assert.ok(!wire.includes('escaped-private-api-key'));
    assert.ok(wire.includes('9223372036854775807'));
  } finally { await h.close(); }
});

test('reviewer Worker death cancels its pending provider request and releases the run without publishing a draft', async () => {
  const h = await runtimeFixture({ workerMode: 'prefork', poolSize: 1 });
  let closed;
  const providerClosed = new Promise(resolve => { closed = resolve; });
  try {
    h.model((req, res) => {
      if (!isReviewer(req)) return answer(res, undefined, draft);
      res.on('close', closed);
      const child = h.app.engine.health().workers.find(worker => worker.state === 'busy')?.childPid;
      assert.ok(child, 'The isolated reviewer child must be active');
      process.kill(child, 'SIGKILL');
    });
    const response = await fetch(h.url + '/api/chat', {
      method: 'POST', signal: AbortSignal.timeout(10000),
      headers: { 'Content-Type': 'application/json', Cookie: (await h.request('/auth/login', { username: 'admin', password: 'runtime-test-password' })).cookie },
      body: JSON.stringify({ text: '复核进程故障清理', reviewMode: 'independent' }),
    });
    const result = await response.json();
    assert.equal(response.status, 200, JSON.stringify(result));
    assert.equal(result.metadata.agentReview.status, 'unavailable');
    assert.equal(h.app.execution.stats().active, 0);
    let timer;
    try {
      await Promise.race([providerClosed, new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error('The reviewer provider connection was not cancelled')), 2000);
      })]);
    } finally { clearTimeout(timer); }
    assert.equal(h.app.store.get('SELECT busy_until FROM conversations WHERE id=?', result.conversationId).busy_until, 0);
    const saved = (await h.request(`/conversations/${result.conversationId}`)).data;
    assert.ok(!JSON.stringify(saved).includes(draft));
    assert.equal(h.requests.length, 2);
  } finally { await h.close(); }
});
