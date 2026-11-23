import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { createWorkerPool } from '../../server/agent-runtime/pool.mjs';
import { defaultPython, workerFile } from '../../server/agent-runtime/agentscope.mjs';
import { runtimeOptions } from '../../server/agent-runtime/index.mjs';
import { runtimeFixture, answer, call } from '../runtime-fixture.mjs';

const alive = pid => { try { process.kill(pid, 0); return true; } catch (error) { if (error.code === 'ESRCH') return false; throw error; } };

test('prefork child resets Python tempfile after preload to its own run directory', () => {
  const directory = mkdtempSync(join(tmpdir(), 'aiops-run-temp-test-'));
  try {
    const code = `import importlib.util, os, pathlib, sys, tempfile
spec = importlib.util.spec_from_file_location('worker', sys.argv[1])
worker = importlib.util.module_from_spec(spec)
spec.loader.exec_module(worker)
tempfile.tempdir = '/tmp'
worker.use_private_tempdir(sys.argv[2])
assert os.environ['TMPDIR'] == sys.argv[2]
assert tempfile.gettempdir() == sys.argv[2]
with tempfile.NamedTemporaryFile() as output:
    assert pathlib.Path(output.name).parent == pathlib.Path(sys.argv[2])`;
    const result = spawnSync(defaultPython, ['-I', '-B', '-c', code, workerFile, directory], { encoding: 'utf8' });
    assert.equal(result.status, 0, result.stderr);
  } finally { rmSync(directory, { recursive: true, force: true }); }
});
async function eventually(check, timeout = 5000) {
  const end = Date.now() + timeout;
  while (!check()) { if (Date.now() > end) assert.fail('State did not converge'); await delay(20); }
}
function input(runId, options = {}) {
  const controller = new AbortController();
  return { runId, messages: [{ role: 'system', content: `private-system-${runId}` }, { role: 'user', content: `private-user-${runId}` }], tools: [],
    signal: controller.signal, onFailure: () => controller.abort(), model: async () => ({ message: { content: `answer-${runId}` } }), tool: async () => { assert.fail('Unexpected tool'); }, ...options };
}

test('prefork reuses only preloader, creates distinct children and resets transcript/sequence for every run', async () => {
  const pool = createWorkerPool({ poolSize: 1 });
  try {
    await pool.warmup(); const parent = pool.health().workers[0].pid; const children = [];
    for (let i = 0; i < 4; i++) {
      const result = await pool.run(input(`isolated-${i}`, { model: async () => {
        const worker = pool.health().workers[0]; assert.equal(worker.pid, parent);
        assert.ok(worker.childPid); children.push(worker.childPid);
        return { message: { content: `answer-${i}` } };
      } }));
      assert.equal(result.text, `answer-${i}`); assert.equal(alive(children.at(-1)), false);
    }
    assert.equal(new Set(children).size, 4);
    const stats = pool.health(); assert.equal(stats.spawned, 1); assert.equal(stats.completed, 4);
    assert.ok(stats.childPeakRssBytes > 0); assert.ok(stats.childCpuSeconds > 0);
    await pool.close(); assert.equal(alive(parent), false); assert.equal(pool.health().workers.length, 0);
  } finally { await pool.close(); }
});

test('pool waiting queue is FIFO, bounded, cancellable and times out without launching cancelled work', async () => {
  const pool = createWorkerPool({ poolSize: 1, poolMaxPending: 2, poolQueueMs: 150 });
  let release; const barrier = new Promise(resolve => { release = resolve; }); const order = [];
  try {
    await pool.warmup();
    const first = pool.run(input('first', { model: async () => { order.push('first'); await barrier; return { message: { content: 'first' } }; } }));
    await eventually(() => order.length === 1);
    const controller = new AbortController();
    const cancelled = assert.rejects(pool.run(input('cancelled', { signal: controller.signal })), { status: 504 });
    const timedOut = assert.rejects(pool.run(input('expired')), { status: 429 });
    await assert.rejects(pool.run(input('overflow')), { status: 429 });
    controller.abort(); await cancelled; await timedOut;
    const second = pool.run(input('second', { model: async () => { order.push('second'); return { message: { content: 'second' } }; } }));
    release(); await first; await second;
    assert.deepEqual(order, ['first', 'second']); assert.equal(pool.health().queued, 0); assert.equal(pool.health().completed, 2);
  } finally { release(); await pool.close(); }
});

test('run cancellation destroys its process group; a later run uses replacement without replay', async () => {
  const pool = createWorkerPool({ poolSize: 1 }); const controller = new AbortController(); let calls = 0, cleaned = false;
  try {
    await pool.warmup();
    const running = pool.run(input('cancel-run', { signal: controller.signal, model: async () => {
      calls++;
      await new Promise(resolve => controller.signal.addEventListener('abort', resolve, { once: true }));
      cleaned = true; throw new Error('aborted');
    } }));
    const assertion = assert.rejects(running, { status: 504 });
    await eventually(() => calls === 1); const { pid, childPid } = pool.health().workers[0];
    controller.abort(); await assertion;
    assert.equal(cleaned, true); await eventually(() => !alive(pid) && !alive(childPid));
    assert.equal((await pool.run(input('after-cancel'))).text, 'answer-after-cancel');
    assert.equal(calls, 1); assert.equal(pool.health().cancelled, 1);
    assert.notEqual(pool.health().workers[0].pid, pid);
  } finally { await pool.close(); }
});

test('preloader crash kills orphan child and aborts active Node callback; idle crash recovers safely', async () => {
  const pool = createWorkerPool({ poolSize: 1 }); const controller = new AbortController(); let started = false;
  try {
    await pool.warmup();
    const running = pool.run(input('crash-run', { signal: controller.signal, onFailure: () => controller.abort(), model: async () => {
      started = true; await new Promise(resolve => controller.signal.addEventListener('abort', resolve, { once: true }));
      throw new Error('aborted');
    } }));
    const assertion = assert.rejects(running, { status: 502 });
    await eventually(() => started); const worker = pool.health().workers[0];
    process.kill(worker.pid, 'SIGKILL'); await assertion;
    await eventually(() => !alive(worker.pid) && !alive(worker.childPid));
    assert.equal((await pool.run(input('after-crash'))).text, 'answer-after-crash');
    const idle = pool.health().workers[0].pid; process.kill(idle, 'SIGKILL');
    await eventually(() => !pool.health().workers.some(w => w.pid === idle));
    assert.equal((await pool.run(input('after-idle-crash'))).text, 'answer-after-idle-crash');
  } finally { await pool.close(); }
});

test('pool recycles preloaders after configured uses and closes active and queued runs without process leaks', async () => {
  const pool = createWorkerPool({ poolSize: 1, poolMaxRuns: 2 });
  const controller = new AbortController(); let started = false;
  try {
    await pool.warmup(); const initial = pool.health().workers[0].pid;
    await pool.run(input('one')); await pool.run(input('two'));
    await pool.run(input('three'));
    const replacement = pool.health().workers[0].pid;
    assert.notEqual(initial, replacement); assert.equal(alive(initial), false); assert.equal(pool.health().recycled, 1);
    const running = pool.run(input('closing', { signal: controller.signal, onFailure: () => controller.abort(), model: async () => {
      started = true; await new Promise(resolve => controller.signal.addEventListener('abort', resolve, { once: true })); throw new Error('aborted');
    } }));
    const activeAssertion = assert.rejects(running, { status: 503 });
    await eventually(() => started); const child = pool.health().workers[0].childPid;
    const queuedAssertion = assert.rejects(pool.run(input('never-launched')), { status: 503 });
    await pool.close(); await activeAssertion; await queuedAssertion;
    await eventually(() => !alive(replacement) && !alive(child));
    assert.equal(pool.health().workers.length, 0); assert.equal(pool.health().queued, 0);
    await assert.rejects(pool.run(input('after-close')), { status: 503 });
  } finally { await pool.close(); }
});

test('invalid pool configuration rejects early and repeated startup failures back off', async () => {
  for (const options of [{ poolSize: 0 }, { poolSize: 9 }, { poolMaxRuns: 0 }, { poolQueueMs: -1 }, { workerMode: 'invalid' }]) assert.throws(() => runtimeOptions(options));
  const pool = createWorkerPool({ python: '/no/such/python', poolSize: 1 });
  try {
    await assert.rejects(pool.run(input('unavailable')), { status: 503 });
    assert.ok(pool.health().retryAfterMs > 0);
    assert.equal(pool.health().startupFailures, 1);
    await pool.close(); await delay(300); assert.equal(pool.health().spawned, 1);
  } finally { await pool.close(); }
});

test('one warm pool preserves private knowledge and tool boundaries across users', async () => {
  const h = await runtimeFixture({ runtime: 'agentscope', workerMode: 'prefork', poolSize: 1 });
  try {
    await h.app.engine.warmup(); const pid = h.app.engine.health().workers[0].pid;
    await h.request('/resources', { kind: 'knowledge', name: '私有计费手册', body: '计费状态 PRIVATE_POOL_SENTINEL', visibility: 'private' });
    await h.request('/users', { username: 'member', password: 'member-test-password', role: 'member' });
    const member = (await h.request('/auth/login', { username: 'member', password: 'member-test-password' })).cookie;
    h.model((req, res) => answer(res, req.body.messages.at(-1).role === 'tool' ? null : [call()]));
    assert.equal((await h.request('/chat', { text: '计费状态' })).status, 200);
    assert.ok(JSON.stringify(h.requests[0]).includes('PRIVATE_POOL_SENTINEL'));
    h.model((req, res) => { assert.ok(!JSON.stringify(req.body).includes('PRIVATE_POOL_SENTINEL')); assert.equal(req.body.tools, undefined); answer(res); });
    assert.equal((await h.request('/chat', { text: '计费状态' }, 'POST', member)).status, 200);
    assert.equal(h.fixtures.toolCalls.length, 1);
    assert.equal(h.app.engine.health().workers[0].pid, pid); assert.equal(h.app.engine.health().completed, 2);
  } finally { await h.close(); }
});

test('readiness and admin telemetry reflect selected runtime health without exposing context', async () => {
  const h = await runtimeFixture({ runtime: 'agentscope', workerMode: 'prefork', poolSize: 1 });
  const before = process.env.METRICS_TOKEN; process.env.METRICS_TOKEN = 'pool-metrics-only';
  try {
    assert.equal(h.app.operations.health().ready, false);
    assert.equal((await fetch(h.url + '/readyz')).status, 200);
    const response = await h.request('/chat', { text: 'PRIVATE_REQUEST_CONTENT' }); assert.equal(response.status, 200);
    const status = (await h.request('/operations')).data;
    assert.equal(status.ready, true); assert.equal(status.runtime.mode, 'prefork'); assert.equal(status.runtime.completed, 1);
    assert.ok(!JSON.stringify(status.runtime).includes('PRIVATE_REQUEST_CONTENT'));
    assert.equal((await fetch(h.url + '/metrics')).status, 401);
    const metrics = await (await fetch(h.url + '/metrics', { headers: { Authorization: 'Bearer pool-metrics-only' } })).text();
    assert.match(metrics, /aiops_agent_runtime_ready\{mode="prefork"\} 1/);
    assert.match(metrics, /aiops_agent_completed_total 1/);
    assert.ok(!metrics.includes('PRIVATE_REQUEST_CONTENT'));
    await h.restart({ runtime: 'agentscope', workerMode: 'prefork', python: '/missing/python', poolSize: 1 });
    assert.equal((await fetch(h.url + '/readyz')).status, 503);
    assert.equal(h.app.operations.health().ready, false);
    assert.equal((await h.request('/operations')).data.runtime.startupFailures, 1);
  } finally { if (before === undefined) delete process.env.METRICS_TOKEN; else process.env.METRICS_TOKEN = before; await h.close(); }
});
