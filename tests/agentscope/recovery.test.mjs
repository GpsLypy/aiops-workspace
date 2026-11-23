import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { join } from 'node:path';
import { createBackup, rotateBackup } from '../../server/backup.mjs';
import { runtimeFixture, answer, call } from '../runtime-fixture.mjs';

test('encrypted recovery and key rotation preserve AgentScope pending/unknown plans across restart with an unavailable Worker without replay', async () => {
  const h = await runtimeFixture({ runtime: 'agentscope' });
  try {
    h.model((req, res) => answer(res, req.body.messages.at(-1).role === 'tool' ? null : [call()]));
    const read = await h.request('/chat', { text: '备份前读取证据' }); assert.equal(read.status, 200);
    const original = h.app.store.get('SELECT response_encrypted FROM tool_steps WHERE run_id=?', read.data.runId);
    const responseBefore = h.app.store.decrypt(original.response_encrypted);
    h.model((req, res) => answer(res, [call('write', 'mcp_1', { service: 'billing', state: 'maintenance' })]));
    const unknown = await h.request('/chat', { text: '结果未知的计划', requestKey: 'recovery-unknown-plan' });
    h.fixtures.failWrites(true);
    assert.equal((await h.request(`/approvals/${unknown.data.stepId}/approve`, {}, 'POST', h.reviewer)).status, 502);
    assert.equal(h.app.execution.view(h.user, unknown.data.runId).status, 'unknown');
    const pending = await h.request('/chat', { text: '待审批计划', requestKey: 'recovery-pending-plan' });
    assert.equal(pending.data.status, 'awaiting_approval');
    const modelCalls = h.requests.length;
    const key = join(h.dir, 'recovery.key'); writeFileSync(key, randomBytes(32), { mode: 0o600 });
    const backup = join(h.dir, 'snapshot'), restored = join(h.dir, 'rotated');
    await createBackup(h.dir, backup, key);
    await rotateBackup(backup, restored, key);
    assert.notDeepEqual(readFileSync(join(h.dir, 'master.key')), readFileSync(join(restored, 'master.key')));
    await h.restart({ runtime: 'agentscope', python: '/absent/python' }, restored);
    assert.equal(h.app.execution.view(h.user, read.data.runId).runtime, 'agentscope');
    const after = h.app.store.get('SELECT response_encrypted FROM tool_steps WHERE run_id=?', read.data.runId);
    assert.equal(h.app.store.decrypt(after.response_encrypted), responseBefore);
    assert.equal((await h.request(`/conversations/${read.data.conversationId}`)).data.messages.at(-1).metadata.tools.length, 1);
    assert.equal(h.fixtures.toolCalls.filter(c => c.name === 'set_service_state').length, 1);
    assert.equal((await h.request(`/approvals/${unknown.data.stepId}/approve`, {}, 'POST', h.reviewer)).status, 409);
    assert.equal((await h.request(`/approvals/${unknown.data.stepId}/reconcile`, {}, 'POST', h.reviewer)).data.status, 'success');
    assert.equal((await h.request(`/approvals/${pending.data.stepId}/approve`, {})).status, 403);
    h.fixtures.failWrites(false);
    assert.equal((await h.request(`/approvals/${pending.data.stepId}/approve`, {}, 'POST', h.reviewer)).status, 200);
    assert.equal((await h.request(`/approvals/${pending.data.stepId}/approve`, {}, 'POST', h.reviewer)).status, 409);
    assert.equal(h.fixtures.toolCalls.filter(c => c.name === 'set_service_state').length, 2);
    assert.equal(h.requests.length, modelCalls); // Neither recovery nor approval resumes the model.
    await h.restart({ runtime: 'agentscope' });
    const duplicate = await h.request('/chat', { text: '待审批计划', requestKey: 'recovery-pending-plan' });
    assert.equal(duplicate.data.status, 'success'); assert.equal(h.requests.length, modelCalls);
    h.model((req, res) => answer(res));
    assert.equal((await h.request('/chat', { text: '恢复后新对话' })).status, 200);
    assert.equal(h.fixtures.toolCalls.filter(c => c.name === 'set_service_state').length, 2);
  } finally { await h.close(); }
});
