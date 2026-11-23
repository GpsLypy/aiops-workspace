import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import ts from 'typescript';
const js = ts.transpileModule(readFileSync(new URL('../src/api.ts', import.meta.url), 'utf8'), { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ES2022 } }).outputText;
const { chatStream } = await import('data:text/javascript;base64,' + Buffer.from(js).toString('base64'));
const wire = events => new Response(events.map(event => JSON.stringify(event) + '\n').join(''));
const complete = { id: 'run-original', status: 'success', conversation_id: 'conversation', result: { text: '完整中文🙂', conversationId: 'conversation', metadata: {} } };
const input = { text: 'test', requestKey: 'same-request-key' };

test('lost acceptance recovers by requestKey and original execution with exactly one POST', async t => {
  for (const lost of ['headers', 'frames']) {
    const calls = [], events = [];
    t.mock.method(globalThis, 'fetch', async (url, init) => {
      calls.push([url, init?.method || 'GET']);
      if (url === '/api/chat') { if (lost === 'headers') throw new TypeError('connection lost'); return wire([]); }
      return Response.json(complete);
    });
    await chatStream(input, event => events.push(event));
    assert.deepEqual(calls, [['/api/chat', 'POST'], ['/api/executions/request/same-request-key', 'GET'], ['/api/executions/run-original', 'GET']]);
    assert.equal(events.find(e => e.type === 'execution').runId, 'run-original');
    assert.equal(events.at(-1).text, '完整中文🙂');
    assert.equal(events.find(e => e.type === 'message_reset').reason, 'display_disconnect');
    t.mock.restoreAll();
  }
});
test('recovery waiting aborts promptly and never issues another read or POST', async t => {
  const controller = new AbortController(), calls = [];
  let reached;
  const observed = new Promise(resolve => { reached = resolve; });
  t.mock.method(globalThis, 'fetch', async url => {
    calls.push(url);
    if (url === '/api/chat') return wire([{ type: 'execution', runId: 'run-original' }]);
    reached(); return Response.json({ status: 'running' });
  });
  const pending = chatStream(input, () => {}, controller.signal);
  await observed; controller.abort();
  await assert.rejects(pending, error => error.name === 'AbortError');
  assert.deepEqual(calls, ['/api/chat', '/api/executions/run-original']);
});
test('unknown acceptance fails read-only without resending a question', async t => {
  const calls = [];
  t.mock.method(globalThis, 'fetch', async url => { calls.push(url); return url === '/api/chat' ? wire([]) : Response.json({ error: 'missing' }, { status: 404 }); });
  await assert.rejects(chatStream(input, () => {}), /没有找到本人的原执行/);
  assert.equal(calls.filter(url => url === '/api/chat').length, 1);
});
test('NDJSON split UTF8 converges once; oversized frames fail without replay', async t => {
  const encoder = new TextEncoder(), content = encoder.encode(JSON.stringify({ type: 'done', text: '中文🙂完整' }) + '\n');
  const events = [];
  t.mock.method(globalThis, 'fetch', async () => new Response(new ReadableStream({ start(controller) {
    for (const byte of content) controller.enqueue(new Uint8Array([byte])); controller.close();
  } })));
  await chatStream(input, e => events.push(e)); assert.deepEqual(events, [{ type: 'done', text: '中文🙂完整' }]);
  let requests = 0;
  t.mock.method(globalThis, 'fetch', async () => { requests++; return new Response('x'.repeat(2_000_001)); });
  await assert.rejects(chatStream(input, () => {}), /大小限制/); assert.equal(requests, 1);
});
test('a stalled display with known runId recovers read-only after 45 seconds', async t => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'] });
  let accepted; const acknowledged = new Promise(resolve => { accepted = resolve; });
  const calls = [], events = [];
  t.mock.method(globalThis, 'fetch', async (url, init) => {
    calls.push(url);
    if (url !== '/api/chat') return Response.json(complete);
    return new Response(new ReadableStream({ start(controller) {
      controller.enqueue(new TextEncoder().encode(JSON.stringify({ type: 'execution', runId: 'run-original' }) + '\n'));
      init.signal.addEventListener('abort', () => controller.error(new DOMException('display idle', 'AbortError')), { once: true });
    } }));
  });
  const pending = chatStream(input, e => { events.push(e); if (e.type === 'execution') accepted(); });
  await acknowledged; t.mock.timers.tick(45000); await pending;
  assert.deepEqual(calls, ['/api/chat', '/api/executions/run-original']); assert.equal(events.at(-1).text, '完整中文🙂');
});
