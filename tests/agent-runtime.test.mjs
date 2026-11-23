import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runAgentScope } from '../server/agent-runtime/agentscope.mjs';
import { runtimeOptions } from '../server/agent-runtime/index.mjs';
import { openStore } from '../server/store.mjs';
import { createBackup, rotateBackup } from '../server/backup.mjs';
import { runtimeFixture } from './runtime-fixture.mjs';

// Executable protocol peer; these failure tests need only Node, not Python.
async function peer(source, overrides = {}, verify = () => {}) {
  const dir = mkdtempSync(join(tmpdir(), 'aiops-fault-peer-')); const python = join(dir, 'peer');
  writeFileSync(python, `#!${process.execPath}\nconst {createInterface}=require('node:readline');
const lines=createInterface({input:process.stdin})[Symbol.asyncIterator]();
const read=async()=>JSON.parse((await lines.next()).value);
const start=await read();
const send=frame=>process.stdout.write(JSON.stringify({version:1,runId:start.runId,...frame})+'\\n');
${source}\n`.replace('const {createInterface}', '(async()=>{ const {createInterface}') + '\n})().catch(()=>process.exit(9));', { mode: 0o700 });
  const controller = new AbortController();
  try {
    const result = await runAgentScope({ runId: 'fixture-run', messages: [{ role: 'system', content: 'fixture' }, { role: 'user', content: 'hello' }], tools: [],
      signal: controller.signal, onFailure: () => controller.abort(), python,
      model: async () => ({ message: { role: 'assistant', content: 'done' } }), tool: async () => ({ content: 'ok' }), ...overrides });
    verify(dir);
    return result;
  } finally { rmSync(dir, { recursive: true, force: true }); }
}

test('runtime selection rejects invalid configuration and missing executable never falls back', async () => {
  assert.equal(runtimeOptions().runtime, 'agentscope');
  assert.equal(runtimeOptions({ agentIds: [] }).agentIds, undefined);
  assert.throws(() => runtimeOptions({ runtime: 'legacy' }), /legacy runtime was removed/);
  assert.throws(() => runtimeOptions({ agentIds: ['existing-agent'] }), /allowlists were removed/);
  const previous = process.env.AGENTSCOPE_AGENT_IDS;
  try {
    process.env.AGENTSCOPE_AGENT_IDS = 'existing-agent';
    assert.throws(() => runtimeOptions({ agentIds: [] }), /allowlists were removed/);
  } finally { if (previous === undefined) delete process.env.AGENTSCOPE_AGENT_IDS; else process.env.AGENTSCOPE_AGENT_IDS = previous; }
  assert.throws(() => runtimeOptions({ runtime: 'typo' }), /AGENT_RUNTIME/);
  await assert.rejects(peer('', { python: '/no/such/aiops-python' }), { status: 503 });
});

test('private Worker pipe excludes parent credentials and replays identical request IDs once', async () => {
  const previous = process.env.AGENT_TEST_SECRET; process.env.AGENT_TEST_SECRET = 'do-not-inherit';
  let models = 0;
  try {
    const result = await peer(`
      if(process.env.AGENT_TEST_SECRET || process.env.HOME || process.env.MODEL_API_KEY) process.exit(7);
      send({type:'model',id:1}); const first=await read();
      send({type:'model',id:1}); const second=await read();
      if(JSON.stringify(first)!==JSON.stringify(second)) process.exit(8);
      send({type:'finish',status:'completed'});
    `, { model: async () => { models++; return { message: { content: 'done' } }; } });
    assert.equal(result.text, 'done'); assert.equal(models, 1);
  } finally { if (previous === undefined) delete process.env.AGENT_TEST_SECRET; else process.env.AGENT_TEST_SECRET = previous; }
});

test('cold Worker keeps temporary files under its disposable private directory', async () => {
  const result = await peer(`
    const fs=require('node:fs'), os=require('node:os'), path=require('node:path');
    if(fs.realpathSync(process.env.TMPDIR)!==process.cwd() || fs.realpathSync(os.tmpdir())!==process.cwd()) process.exit(7);
    fs.writeFileSync(path.join(os.tmpdir(),'scratch'),'private');
    fs.writeFileSync(path.join(path.dirname(process.argv[1]),'worker-cwd'),process.cwd());
    send({type:'model',id:1}); await read(); send({type:'finish',status:'completed'});
  `, {}, dir => {
    const directory = readFileSync(join(dir, 'worker-cwd'), 'utf8');
    assert.equal(existsSync(directory), false);
  });
  assert.equal(result.text, 'done');
});

test('Worker pipe rejects cross-run, altered duplicate, invalid sequence, premature terminal and corrupt frames', async () => {
  const cases = [
    [`send({runId:'another-run',type:'model',id:1});`, 502],
    [`send({type:'model',id:2});`, 502],
    [`send({type:'model',id:1}); await read(); send({type:'tool',id:1});`, 409],
    [`send({type:'finish',status:'completed'});`, 502],
    [`send({type:'finish',status:'awaiting_approval'});`, 502],
    [`send({type:'model',id:1}); await read(); send({type:'finish',status:'exceed_max_iters'});`, 502],
    [`process.stdout.write('invalid JSON\\n');`, 502],
    [`process.stdout.write('x'.repeat(2000001));`, 502],
    [`process.stdout.write('{"type":'); process.exit(0);`, 502],
  ];
  for (const [source, status] of cases) await assert.rejects(peer(source), { status });
});

test('Worker death aborts an outstanding broker operation and joins it before returning', async () => {
  const controller = new AbortController(); let completed = false;
  await assert.rejects(peer(`send({type:'model',id:1}); setTimeout(()=>process.exit(2),100);`, {
    signal: controller.signal, onFailure: () => controller.abort(),
    model: async () => { await new Promise(resolve => controller.signal.addEventListener('abort', resolve, { once: true })); completed = true; throw new Error('cancelled'); },
  }), { status: 502 });
  assert.equal(completed, true);
});

test('Worker protocol cancellation kills an unresponsive child and also handles a pre-aborted run', async () => {
  const controller = new AbortController(); const timer = setTimeout(() => controller.abort(), 100);
  try { await assert.rejects(peer(`setInterval(()=>{},1000);`, { signal: controller.signal }), { status: 504 }); }
  finally { clearTimeout(timer); }
  await assert.rejects(peer('', { signal: AbortSignal.abort() }), { status: 504 });
});

test('tool call identities deduplicate concurrent and restarted requests; exact encrypted replies survive backup rotation', async () => {
  const h = await runtimeFixture({ runtime: 'agentscope' });
  const schema = h.schemas.find(t => t.name === 'service_status').inputSchema;
  const identity = { replyId: 'reply-one', callId: 'call-one' }; let context, original;
  const invoke = (ctx = context, args = { service: 'billing' }) => h.app.execution.callStep(h.user, ctx, h.resource, 'service_status', args, schema, 'production', null, identity);
  try {
    await h.app.execution.run(h.user, { kind: 'tool' }, async ctx => {
      context = ctx;
      const first = invoke();
      await assert.rejects(invoke(), { status: 409 });
      original = await first;
      assert.deepEqual(await invoke(), original);
      return { text: 'done' };
    });
    assert.equal(h.fixtures.toolCalls.length, 1);
    const step = h.app.store.get('SELECT * FROM tool_steps');
    assert.ok(step.response_encrypted); assert.ok(!step.response_encrypted.includes('healthy'));
    assert.equal(h.app.execution.view(h.user, context.runId).steps[0].response_encrypted, undefined);
    await h.restart();
    assert.deepEqual(await invoke({ runId: context.runId, signal: new AbortController().signal }), original);
    await assert.rejects(invoke(context, { service: 'billing', extra: true }), { status: 409 });
    const recovery = join(h.dir, 'recovery.key'); writeFileSync(recovery, randomBytes(32));
    await createBackup(h.dir, join(h.dir, 'backup'), recovery);
    await rotateBackup(join(h.dir, 'backup'), join(h.dir, 'rotated'), recovery);
    const rotated = openStore(join(h.dir, 'rotated'));
    try {
      assert.deepEqual(JSON.parse(rotated.decrypt(rotated.get('SELECT response_encrypted FROM tool_steps').response_encrypted)), original.response);
      assert.notDeepEqual(readFileSync(join(h.dir, 'master.key')), readFileSync(join(h.dir, 'rotated/master.key')));
    } finally { rotated.close(); }
    h.app.store.run('UPDATE users SET active=0 WHERE id=?', h.user.id);
    await assert.rejects(invoke(), { status: 403 });
    assert.equal(h.fixtures.toolCalls.length, 1);
  } finally { await h.close(); }
});

test('pending call identity preserves one approval and unknown/reconciled outcomes never replay a write', async () => {
  const h = await runtimeFixture({ runtime: 'agentscope' });
  const schema = h.schemas.find(t => t.name === 'set_service_state').inputSchema;
  let context;
  const invoke = () => h.app.execution.callStep(h.user, context, h.resource, 'set_service_state', { service: 'billing', state: 'maintenance' }, schema, 'production', null, { replyId: 'write-reply', callId: 'write-call' });
  try {
    const run = await h.app.execution.run(h.user, { kind: 'tool' }, async ctx => {
      context = ctx; const pending = await invoke(); assert.deepEqual(await invoke(), pending);
      return { ...pending, status: 'awaiting_approval' };
    });
    assert.equal(h.app.store.get('SELECT count(*) AS n FROM tool_steps').n, 1);
    h.fixtures.failWrites(true);
    assert.equal((await h.request(`/approvals/${run.stepId}/approve`, {}, 'POST', h.reviewer)).status, 502);
    await assert.rejects(invoke(), { status: 409 });
    await h.restart();
    await assert.rejects(invoke(), { status: 409 });
    assert.equal((await h.request(`/approvals/${run.stepId}/reconcile`, {}, 'POST', h.reviewer)).data.status, 'success');
    await assert.rejects(invoke(), { status: 409 }); // no original response to replay
    assert.equal(h.fixtures.toolCalls.filter(c => c.name === 'set_service_state').length, 1);
  } finally { await h.close(); }
});

test('schema v4 upgrades once to v7 preserving prior execution and pending plan', async () => {
  const h = await runtimeFixture({ runtime: 'agentscope' });
  try {
    const proposed = await h.request('/executions/tool', { resourceId: h.resource.id, tool: 'set_service_state', arguments: { service: 'billing', state: 'maintenance' }, environment: 'production', requestKey: 'migrate-v4-plan' });
    assert.equal(proposed.status, 202);
    h.app.store.db.exec(`DROP TABLE agent_delegations; DROP INDEX tool_steps_call_key; ALTER TABLE tool_steps DROP COLUMN call_key; ALTER TABLE tool_steps DROP COLUMN call_hash; ALTER TABLE tool_steps DROP COLUMN response_encrypted; ALTER TABLE executions DROP COLUMN runtime; ALTER TABLE executions DROP COLUMN runtime_version; ALTER TABLE tasks DROP COLUMN target_binding; PRAGMA user_version=4;`);
    await h.restart();
    assert.equal(h.app.store.get('PRAGMA user_version').user_version, 7);
    const run = h.app.execution.view(h.user, proposed.data.runId);
    assert.equal(run.runtime, 'legacy'); assert.equal(run.status, 'awaiting_approval');
    assert.equal(run.steps[0].arguments.service, 'billing'); assert.equal(run.steps[0].call_key, null);
    await h.restart();
    assert.equal((await h.request(`/approvals/${proposed.data.stepId}/approve`, {}, 'POST', h.reviewer)).status, 200);
    const fresh = await h.request('/chat', { text: '迁移后的新对话' });
    assert.equal(fresh.status, 200);
    assert.equal(h.app.execution.view(h.user, fresh.data.runId).runtime, 'agentscope');
    assert.equal(h.app.execution.view(h.user, proposed.data.runId).runtime, 'legacy');
  } finally { await h.close(); }
});
