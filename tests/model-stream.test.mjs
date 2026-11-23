import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readModelStream } from '../server/model-stream.mjs';
import { completion } from '../server/model.mjs';
import { listen } from './fixtures.mjs';
import express from 'express';

const frame = value => `data: ${JSON.stringify(value)}\r\n\r\n`;
const done = 'data: [DONE]\r\n\r\n';
const response = text => new Response(new ReadableStream({ start(c) { for (const byte of Buffer.from(text)) c.enqueue(Uint8Array.of(byte)); c.close(); } }));
const output = text => ({ type: 'message', role: 'assistant', content: [{ type: 'output_text', text }] });

test('completion always requests Responses SSE even without callbacks or with obsolete streaming flags', async () => {
  const app = express(); app.use(express.json()); const requests = [];
  app.post('/v1/responses', (req, res) => {
    assert.equal(req.headers.accept, 'text/event-stream'); requests.push(req.body);
    res.type('text/event-stream').end(frame({ type: 'response.completed', response: { status: 'completed', output: [output('流式答复')] } }));
  });
  const http = await listen(app); const previous = process.env.MODEL_STREAMING;
  const store = { setting: () => ({ baseUrl: http.url + '/v1', model: 'fixture', apiType: 'responses' }), decrypt: () => '' };
  try {
    for (const value of ['false', 'invalid']) {
      process.env.MODEL_STREAMING = value;
      assert.equal((await completion(store, [{ role: 'user', content: 'test' }])).message.content, '流式答复');
      assert.equal(requests.at(-1).stream, true);
    }
  } finally { if (previous === undefined) delete process.env.MODEL_STREAMING; else process.env.MODEL_STREAMING = previous; await http.close(); }
});

test('Responses SSE text arrives before completion across UTF-8, comments and multiline data', async () => {
  let send; const events = [];
  const body = new ReadableStream({ start(c) { send = c; } });
  const pending = readModelStream(new Response(body), { onEvent: e => events.push(e) });
  for (const byte of Buffer.from(': keepalive\r\nevent: message\r\n' + frame({ type: 'response.output_text.delta', delta: '中文🙂' }))) send.enqueue(Uint8Array.of(byte));
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(events, [{ type: 'delta', text: '中文🙂' }]);
  send.enqueue(Buffer.from('data: {"type":"response.refusal.delta",\r\ndata: "delta":"，拒绝"}\r\n\r\n' + frame({ type: 'response.completed', response: { status: 'completed', output: [output('中文🙂，拒绝')], usage: { total_tokens: 17 } } })));
  send.close();
  const result = await pending;
  assert.equal(result.output[0].content[0].text, '中文🙂，拒绝');
  assert.equal(result.usage.total_tokens, 17);
});

test('Responses hides reasoning and tool-stage draft text while preserving authoritative calls', async () => {
  const events = [];
  const result = await readModelStream(response([
    { type: 'response.reasoning_summary_text.delta', delta: 'private-reasoning' },
    { type: 'response.output_text.delta', delta: '先检查' },
    { type: 'response.output_item.added', item: { type: 'function_call' } },
    { type: 'response.function_call_arguments.delta', delta: 'private-arguments' },
    { type: 'response.output_text.delta', delta: 'hidden-after-tool' },
    { type: 'response.completed', response: { status: 'completed', output: [{ type: 'function_call', call_id: 'call_a', name: 'first', arguments: '{}' }] } },
  ].map(frame).join('')), { onEvent: e => events.push(e) });
  assert.equal(result.output[0].call_id, 'call_a');
  assert.deepEqual(events, [{ type: 'delta', text: '先检查' }, { type: 'tool_call' }]);
  assert.ok(!JSON.stringify(result).includes('private-reasoning'));
});

test('Responses streams text/refusal but preserves authoritative output and opaque reasoning for continuation', async () => {
  const reasoning = { type: 'reasoning', id: 'rs_1', encrypted_content: 'private-reasoning', summary: [] };
  const final = { status: 'completed', output: [reasoning, output('中文回复')], usage: { input_tokens: 5, output_tokens: 7, total_tokens: 12 } };
  const events = [];
  const result = await readModelStream(response([
    { type: 'response.reasoning_summary_text.delta', delta: 'never-display' },
    { type: 'response.output_text.delta', delta: '中文' },
    { type: 'response.refusal.delta', delta: '回复' },
    { type: 'response.completed', response: final },
  ].map(frame).join('')), { onEvent: e => events.push(e) });
  assert.deepEqual(result, final);
  assert.deepEqual(events, [{ type: 'delta', text: '中文' }, { type: 'delta', text: '回复' }]);
});

test('Responses rejects missing terminal/delimiter, invalid JSON, legacy frames and oversized payloads', async () => {
  for (const wire of [
    frame({ type: 'response.output_text.delta', delta: 'partial' }),
    'data: {"type":"response.completed","response":{"status":"completed"}}\n',
    'data: invalid\n\n',
    frame({ choices: [{ index: 0, delta: { content: 'unsupported' }, finish_reason: 'stop' }] }) + done,
    frame({ type: 'response.output_text.delta', delta: 'partial' }) + done,
  ]) await assert.rejects(readModelStream(response(wire), {}), { status: 502 });
  await assert.rejects(readModelStream(new Response('x'.repeat(2_000_001)), {}), /大小限制/);
});

test('SSE distinguishes provider failure, incomplete output and aborted reads without exposing provider details', async () => {
  for (const wire of [
    frame({ error: { message: 'secret-upstream-error' } }),
    frame({ type: 'response.failed', response: { status: 'failed', error: { code: 'provider_failure', message: 'secret-upstream-error' } } }),
  ]) await assert.rejects(readModelStream(response(wire), {}), error =>
    error.status === 502 && /模型服务报告请求失败/.test(error.message) && !error.message.includes('secret-upstream-error'));
  await assert.rejects(readModelStream(response(frame({ type: 'response.incomplete', response: { status: 'incomplete', error: 'secret-upstream-error' } })), {}), error =>
    error.status === 502 && /模型 Responses 输出未完成/.test(error.message) && !error.message.includes('secret-upstream-error'));
  const controller = new AbortController();
  const body = new ReadableStream({ start(stream) {
    stream.enqueue(Buffer.from(frame({ type: 'response.output_text.delta', delta: 'draft' })));
    controller.abort();
    stream.error(new DOMException('secret-abort-detail', 'AbortError'));
  } });
  await assert.rejects(readModelStream(new Response(body), { signal: controller.signal }), error =>
    error.status === 502 && /模型请求超时或执行已取消/.test(error.message) && !error.message.includes('secret-abort-detail'));
});

test('completion requests upstream streaming, preserves Responses call_id/reasoning/usage, rejects JSON responses and cancels a live read', async () => {
  const app = express(); app.use(express.json());
  let reply; const requests = [];
  app.post('/v1/{*path}', (req, res) => { requests.push(req.body); reply(req, res); });
  const http = await listen(app);
  const apiType = 'responses';
  const store = { setting: () => ({ baseUrl: http.url + '/v1', model: 'fixture', apiType }), decrypt: () => '' };
  try {
    const reasoning = { type: 'reasoning', id: 'rs_1', encrypted_content: 'opaque', summary: [] };
    reply = (req, res) => res.type('text/event-stream').end(frame({ type: 'response.completed', response: { status: 'completed', output: [reasoning, { type: 'function_call', id: 'item_1', call_id: 'call_1', name: 'mcp_0', arguments: '{}' }], usage: { input_tokens: 7, output_tokens: 3, total_tokens: 10 } } }));
    const result = await completion(store, [{ role: 'user', content: 'test' }], [], undefined, () => {});
    assert.equal(requests.at(-1).stream, true); assert.equal(requests.at(-1).stream_options, undefined);
    assert.equal(result.message.tool_calls[0].id, 'call_1'); assert.deepEqual(result.message.responsesReasoning, [reasoning]);
    assert.equal(result.usage.prompt_tokens, 7);
    reply = (req, res) => res.json({ status: 'completed', output: [output('JSON兼容')] });
    await assert.rejects(completion(store, [result.message, { role: 'tool', tool_call_id: 'call_1', content: 'ok' }], [], undefined, () => {}), error => error.status === 502 && /SSE/.test(error.message));
    assert.deepEqual(requests.at(-1).input[0], reasoning);
    const abort = new AbortController();
    reply = (req, res) => { res.type('text/event-stream').write(frame({ type: 'response.output_text.delta', delta: '尚未完成' })); };
    await assert.rejects(completion(store, [{ role: 'user', content: 'test' }], [], abort.signal, () => abort.abort()), error =>
      error.status === 502 && /模型请求超时或执行已取消/.test(error.message));
  } finally { await http.close(); }
});

test('model request diagnostics report fixed SSE terminal states without provider data', async t => {
  const app = express(); app.use(express.json());
  let wire;
  app.post('/v1/responses', (req, res) => typeof wire === 'function' ? wire(res) : res.type('text/event-stream').end(wire));
  const http = await listen(app);
  const store = { setting: () => ({ baseUrl: http.url + '/v1', model: 'private-model-name', apiType: 'responses', apiKeyEncrypted: 'private-key' }), decrypt: () => 'private-api-key' };
  const diagnostics = []; const logs = [];
  const previous = process.env.MODEL_DIAGNOSTICS;
  process.env.MODEL_DIAGNOSTICS = 'true';
  t.mock.method(console, 'info', line => logs.push(JSON.parse(line)));
  const invoke = () => completion(store, [{ role: 'user', content: 'private-prompt' }], [], undefined, () => {}, undefined, item => diagnostics.push(item));
  try {
    wire = frame({ type: 'response.completed', response: { status: 'completed', output: [output('private-answer')] } });
    assert.equal((await invoke()).message.content, 'private-answer');
    wire = frame({ type: 'response.failed', response: { status: 'failed', error: { message: 'private-provider-error' } } });
    await assert.rejects(invoke(), { status: 502 });
    wire = frame({ type: 'response.incomplete', response: { status: 'incomplete', error: 'private-provider-error' } });
    await assert.rejects(invoke(), { status: 502 });
    wire = frame({ type: 'response.output_text.delta', delta: 'private-partial' });
    await assert.rejects(invoke(), { status: 502 });
    wire = res => res.json({ status: 'completed', output: [output('private-json-answer')] });
    await assert.rejects(invoke(), { status: 502 });
    wire = res => res.status(503).json({ error: 'private-provider-error' });
    await assert.rejects(invoke(), { status: 502 });
    assert.deepEqual(diagnostics.map(item => [item.phase, item.outcome, item.abortSource, item.sseTerminalStatus]), [
      ['terminal', 'completed', null, 'completed'],
      ['streaming', 'error', null, 'failed'],
      ['streaming', 'error', null, 'incomplete'],
      ...Array.from({ length: 6 }, () => ['streaming', 'error', null, 'not_observed']),
      ['headers', 'error', null, null],
      ...Array.from({ length: 6 }, () => ['headers', 'error', null, null]),
    ]);
    assert.deepEqual(logs, diagnostics);
    for (const item of diagnostics) {
      assert.deepEqual(Object.keys(item), ['event', 'phase', 'outcome', 'elapsedMs', 'abortSource', 'timeoutKind', 'sseTerminalStatus']);
      assert.equal(item.event, 'model.request');
      assert.ok(Number.isSafeInteger(item.elapsedMs) && item.elapsedMs >= 0);
    }
    assert.doesNotMatch(JSON.stringify(logs), /private-(?:model|key|api|prompt|answer|provider|partial)/);
  } finally {
    if (previous === undefined) delete process.env.MODEL_DIAGNOSTICS;
    else process.env.MODEL_DIAGNOSTICS = previous;
    await http.close();
  }
});

test('model request diagnostics distinguish connection failure, execution cancel and request timeout', async t => {
  const app = express();
  let reply, reached;
  app.post('/v1/responses', (req, res) => reply(req, res));
  const http = await listen(app);
  const store = { setting: () => ({ baseUrl: http.url + '/v1', model: 'fixture', apiType: 'responses' }), decrypt: () => '' };
  const diagnostics = [];
  const invoke = (signal, onEvent = () => {}, options) => completion(store, [{ role: 'user', content: 'test' }], [], signal, onEvent, undefined, item => diagnostics.push(item), undefined, options);
  try {
    reply = (req, res) => { res.type('text/event-stream').write(frame({ type: 'response.output_text.delta', delta: 'partial' })); };
    let controller = new AbortController();
    let arrived = new Promise(resolve => { reached = resolve; });
    let pending = invoke(controller.signal, event => { if (event.type === 'delta') reached(); });
    await arrived;
    controller.abort();
    await assert.rejects(pending, { status: 502 });
    assert.deepEqual([diagnostics.at(-1).phase, diagnostics.at(-1).abortSource, diagnostics.at(-1).sseTerminalStatus], ['streaming', 'execution', 'not_observed']);

    reply = () => { reached(); };
    arrived = new Promise(resolve => { reached = resolve; });
    pending = invoke(undefined, undefined, { timeoutPolicy: { firstByteMs: 50, idleMs: 50 } });
    await arrived;
    await assert.rejects(pending, { status: 502 });
    assert.deepEqual([diagnostics.at(-1).phase, diagnostics.at(-1).abortSource, diagnostics.at(-1).sseTerminalStatus], ['before_headers', 'request_timeout', null]);
  } finally { await http.close(); }

  await assert.rejects(invoke(), { status: 502 });
  assert.deepEqual([diagnostics.at(-1).phase, diagnostics.at(-1).abortSource, diagnostics.at(-1).sseTerminalStatus], ['before_headers', null, null]);
});

test('completion rejects every non-SSE response, cancels its body and never retries', async () => {
  const app = express(); app.use(express.json()); let contentType, value, requests = 0;
  app.post('/v1/responses', (req, res) => { requests++; assert.equal(req.body.stream, true); res.setHeader('Content-Type', contentType); res.end(value); });
  const http = await listen(app);
  const store = { setting: () => ({ baseUrl: http.url + '/v1', model: 'fixture', apiType: 'responses' }), decrypt: () => '' };
  try {
    for (const callback of [undefined, () => {}]) for (const type of ['application/json', 'text/plain', 'application/text/event-stream']) {
      contentType = type; value = JSON.stringify({ status: 'completed', output: [output('完整正文也不能回退')] });
      await assert.rejects(completion(store, [{ role: 'user', content: 'test' }], [], undefined, callback), error => error.status === 502 && /SSE/.test(error.message));
    }
    assert.equal(requests, 6);
  } finally { await http.close(); }
});
