import { test } from 'node:test';
import assert from 'node:assert/strict';
import { runtimeFixture, answer, call } from './runtime-fixture.mjs';

const binding = (resourceId, service = 'billing') => ({ resourceId, tool: 'service_status', environment: 'production', arguments: { service } });

async function finishedRun(h, taskId) {
  const started = await h.request(`/tasks/${taskId}/run`, {});
  assert.equal(started.status, 202, JSON.stringify(started.data));
  const deadline = Date.now() + 15000;
  while (Date.now() < deadline) {
    const response = await h.request(`/tasks/${taskId}/runs`);
    assert.equal(response.status, 200);
    const run = response.data.find(item => item.id === started.data.runId);
    if (run && run.status !== 'running') return run;
    await new Promise(resolve => setTimeout(resolve, 30));
  }
  throw new Error('定时任务未在 15 秒内结束');
}

test('scheduled Agent runs use an explicitly saved target, while legacy and substituted targets fail closed', async () => {
  const h = await runtimeFixture();
  try {
    const updated = await h.request(`/resources/${h.resource.id}`, {
      ...h.resource,
      toolPolicies: { ...h.resource.toolPolicies, service_status: { ...h.resource.toolPolicies.service_status,
        constraints: { service: ['billing', 'inventory'] }, requiredTargetFields: ['service'] } },
    }, 'PUT');
    assert.equal(updated.status, 200, JSON.stringify(updated.data));
    h.model((req, res) => {
      const last = req.body.messages.at(-1);
      if (last.role === 'tool') return answer(res, undefined, '状态已读取');
      const question = req.body.messages.filter(item => item.role === 'user').at(-1)?.content || '';
      answer(res, [call('scheduled-status', 'mcp_0', { service: question.includes('换错') ? 'inventory' : 'billing' })]);
    });
    const base = { scheduleType: 'once', runAt: new Date(Date.now() + 60000).toISOString() };
    const invalid = await h.request('/tasks', { ...base, name: '错误环境', prompt: '查询 billing', targetBinding: { ...binding(h.resource.id), environment: 'staging' } });
    assert.equal(invalid.status, 400);
    const created = await h.request('/tasks', { ...base, name: '已确认目标', prompt: '查询 billing', targetBinding: binding(h.resource.id) });
    assert.equal(created.status, 201, JSON.stringify(created.data));
    assert.deepEqual(created.data.targetBinding, binding(h.resource.id));
    assert.equal((await finishedRun(h, created.data.id)).status, 'success');
    assert.deepEqual(h.fixtures.toolCalls.map(item => item.service), ['billing']);

    const legacy = await h.request('/tasks', { ...base, name: '旧任务', prompt: '查询 billing' });
    assert.equal(legacy.status, 201, JSON.stringify(legacy.data));
    assert.equal(legacy.data.targetBinding, null);
    const blocked = await finishedRun(h, legacy.data.id);
    assert.equal(blocked.status, 'failed');
    assert.match(blocked.error, /确认本轮查询目标/);
    assert.equal(h.fixtures.toolCalls.length, 1);

    const latest = (await h.request('/tasks')).data.find(item => item.id === legacy.data.id);
    const stale = await h.request(`/tasks/${legacy.data.id}/target-binding`, { targetBinding: binding(h.resource.id), updated: 'stale' }, 'PATCH');
    assert.equal(stale.status, 409);
    const repaired = await h.request(`/tasks/${legacy.data.id}/target-binding`, { targetBinding: binding(h.resource.id), updated: latest.updated }, 'PATCH');
    assert.equal(repaired.status, 200, JSON.stringify(repaired.data));
    assert.deepEqual(repaired.data.targetBinding, binding(h.resource.id));
    assert.equal((await finishedRun(h, legacy.data.id)).status, 'success');
    assert.deepEqual(h.fixtures.toolCalls.map(item => item.service), ['billing', 'billing']);

    const substituted = await h.request('/tasks', { ...base, name: '授权内换错', prompt: '换错目标', targetBinding: binding(h.resource.id) });
    assert.equal(substituted.status, 201, JSON.stringify(substituted.data));
    const mismatch = await finishedRun(h, substituted.data.id);
    assert.equal(mismatch.status, 'failed');
    assert.match(mismatch.error, /目标不一致/);
    assert.equal(h.fixtures.toolCalls.length, 2);
    assert.equal(h.app.store.get('SELECT count(*) AS n FROM tool_steps WHERE run_id=?', mismatch.execution_id).n, 0);
  } finally { await h.close(); }
});
