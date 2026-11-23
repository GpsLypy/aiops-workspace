import { test } from 'node:test';
import assert from 'node:assert/strict';
import { runtimeFixture } from './runtime-fixture.mjs';

test('queued chat acknowledges its durable ID and can be stopped before a model request; request lookup is owner-only', async t => {
  const old = process.env.MAX_ACTIVE_RUNS; process.env.MAX_ACTIVE_RUNS = '1';
  t.after(() => { if (old === undefined) delete process.env.MAX_ACTIVE_RUNS; else process.env.MAX_ACTIVE_RUNS = old; });
  const h = await runtimeFixture();
  let release, entered;
  const gate = new Promise(resolve => { release = resolve; }), reached = new Promise(resolve => { entered = resolve; });
  h.model(async (req, res) => { entered(); await gate; res.json({ choices: [{ message: { role: 'assistant', content: 'first completed' } }] }); });
  let first, second;
  try {
    first = h.app.engine.execute(h.user, { text: 'first', requestKey: 'first-held-chat' });
    await reached;
    const events = [];
    second = h.app.engine.execute(h.user, { text: 'second', requestKey: 'second-queued-chat' }, e => events.push(e));
    const stopped = assert.rejects(second, /取消/);
    const id = events.find(e => e.type === 'execution')?.runId; assert.ok(id);
    assert.equal(h.app.store.get('SELECT status FROM executions WHERE id=?', id).status, 'queued');
    const lookup = await h.request('/executions/request/second-queued-chat');
    assert.equal(lookup.status, 200); assert.equal(lookup.data.id, id);
    assert.equal((await h.request('/executions/request/second-queued-chat', undefined, 'GET', h.reviewer)).status, 404);
    assert.equal((await h.request(`/executions/${id}/cancel`, {})).status, 200);
    await stopped;
    release(); await first;
    assert.equal(h.requests.length, 1); assert.equal(h.app.store.get('SELECT status FROM executions WHERE id=?', id).status, 'cancelled');
    assert.equal(events.some(e => e.type === 'session'), false);
  } finally { release(); await Promise.allSettled([first, second]); await h.close(); }
});
