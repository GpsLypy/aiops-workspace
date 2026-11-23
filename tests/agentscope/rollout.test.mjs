import test from 'node:test';
import assert from 'node:assert/strict';
import { runtimeFixture, answer, call } from '../runtime-fixture.mjs';

const endpoint = '/settings/agent-rollout';
const draft = { agentIds: [], includeGeneral: true, contextMode: 'budgeted', retrievalMode: 'diverse', evidenceReports: true };
test('real SDK preflight, in-flight policy freeze, pause and resume preserve tool and request identities', async () => {
  const oldMetrics = process.env.METRICS_TOKEN; process.env.METRICS_TOKEN = 'rollout-test-metrics';
  const h = await runtimeFixture({ runtime: 'agentscope' });
  let release;
  try {
    let state = (await h.request(endpoint, { revision: 0, draft }, 'PUT')).data;
    state = (await h.request(endpoint + '/preflight', { revision: state.revision })).data;
    assert.equal(state.preflightValid, true); assert.equal(h.requests.length, 0); assert.equal(h.fixtures.toolCalls.length, 0);
    state = (await h.request(endpoint + '/activate', { revision: state.revision })).data;
    assert.equal(state.mode, 'active'); const activeRevision = state.activeRevision;
    let started;
    const waiting = new Promise(resolve => { started = resolve; });
    h.model(async (req, res) => {
      if (req.body.messages.at(-1).role === 'tool') return answer(res, null, '已完成');
      await new Promise(resolve => { release = resolve; started(); });
      answer(res, [call()]);
    });
    const input = { text: '检查计费服务', requestKey: 'rollout-in-flight-dedupe' };
    const running = h.request('/chat', input);
    await waiting;
    state = (await h.request(endpoint + '/pause', { revision: state.revision })).data;
    assert.equal(state.mode, 'paused'); assert.equal((await fetch(h.url + '/readyz')).status, 200);
    release();
    const result = await running;
    assert.equal(result.status, 200); assert.equal(result.data.metadata.runtimePolicy.runtime, 'agentscope');
    assert.equal(result.data.metadata.runtimePolicy.activeRevision, activeRevision); assert.ok(result.data.metadata.evidenceReport);
    assert.equal(h.fixtures.toolCalls.length, 1);
    const metrics = await (await fetch(h.url + '/metrics', { headers: { Authorization: 'Bearer rollout-test-metrics' } })).text();
    assert.match(metrics, /aiops_agent_runtime_ready\{mode="(?:cold|prefork)"\} 1/);
    assert.match(metrics, /aiops_agent_completed_total [1-9]/);
    const duplicate = await h.request('/chat', input);
    assert.equal(duplicate.data.runId, result.data.runId); assert.equal(h.fixtures.toolCalls.length, 1);
    h.model((req, res) => answer(res));
    const next = await h.request('/chat', { text: '继续', conversationId: result.data.conversationId });
    assert.equal(next.status, 200); assert.equal(next.data.metadata.runtimePolicy.runtime, 'agentscope');
    assert.equal(next.data.metadata.evidenceReport, undefined);
    await h.restart();
    assert.ok(['cold', 'prefork'].includes(h.app.engine.health().mode));
    assert.equal((await fetch(h.url + '/readyz')).status, 200);
    const saved = (await h.request(`/conversations/${result.data.conversationId}`)).data.messages.find(m => m.metadata?.runId === result.data.runId);
    assert.deepEqual(saved.metadata.runtimePolicy, result.data.metadata.runtimePolicy);
    state = (await h.request(endpoint + '/preflight', { revision: state.revision })).data;
    state = (await h.request(endpoint + '/activate', { revision: state.revision })).data;
    assert.equal(state.mode, 'active');
    assert.equal((await h.request('/chat', { text: '恢复灰度' })).data.metadata.runtimePolicy.runtime, 'agentscope');
    assert.equal(h.fixtures.toolCalls.length, 1);
  } finally { release?.(); await h.close(); if (oldMetrics === undefined) delete process.env.METRICS_TOKEN; else process.env.METRICS_TOKEN = oldMetrics; }
});
