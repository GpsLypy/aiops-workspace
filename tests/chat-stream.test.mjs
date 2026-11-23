import { test } from 'node:test';
import assert from 'node:assert/strict';
import { runtimeFixture, answer } from './runtime-fixture.mjs';

const frame = value => `data: ${JSON.stringify(value)}\n\n`;
const delta = text => frame({ type: 'response.output_text.delta', delta: text });
const complete = (text, calls = []) => frame({ type: 'response.completed', response: { status: 'completed', output: [...(text ? [{ type: 'message', role: 'assistant', content: [{ type: 'output_text', text }] }] : []), ...calls] } });

for (const workerMode of ['cold', 'prefork']) test(`${workerMode}: live NDJSON text precedes model completion, tools run once, history is authoritative`, async () => {
  const h = await runtimeFixture({ workerMode });
  let release; const held = new Promise(resolve => { release = resolve; });
  try {
    let round = 0;
    h.model(async (req, res) => {
      assert.equal(req.body.stream, true);
      res.type('text/event-stream');
      if (++round === 1) return res.end(delta('工具前的临时内容') + frame({ type: 'response.output_item.added', item: { type: 'function_call' } }) + complete('', [{ type: 'function_call', call_id: 'stream_tool', name: 'mcp_0', arguments: '{"service":"billing"}' }]));
      res.write(delta('第一段中文🙂'));
      await held;
      if (!res.destroyed) res.end(delta('，第二段已完成。') + complete('第一段中文🙂，第二段已完成。'));
    });
    const cookie = (await h.request('/auth/login', { username: 'admin', password: 'runtime-test-password' })).cookie;
    const response = await fetch(h.url + '/api/chat', { method: 'POST', headers: { Cookie: cookie, 'Content-Type': 'application/json', Accept: 'application/x-ndjson' }, body: JSON.stringify({ text: '调用工具并解释', requestKey: `stream-${workerMode}-once` }), signal: AbortSignal.timeout(30000) });
    assert.match(response.headers.get('content-type'), /application\/x-ndjson/);
    const events = []; const reader = response.body.getReader(); const decoder = new TextDecoder(); let buffer = '', observedEarly = false;
    while (true) {
      const { value, done } = await reader.read(); if (done) break;
      buffer += decoder.decode(value, { stream: true }); const lines = buffer.split('\n'); buffer = lines.pop();
      for (const line of lines.filter(Boolean)) {
        const event = JSON.parse(line); events.push(event);
        if (event.type === 'message_delta' && event.text === '第一段中文🙂') {
          assert.ok(!events.some(e => e.type === 'done'));
          const run = h.app.store.get('SELECT status FROM executions WHERE request_key=?', `stream-${workerMode}-once`);
          assert.equal(run.status, 'running'); observedEarly = true; release();
        }
      }
    }
    assert.equal(observedEarly, true);
    const final = events.find(e => e.type === 'done'); assert.ok(final, JSON.stringify(events));
    assert.equal(final.text, '第一段中文🙂，第二段已完成。');
    assert.equal(events.filter(e => e.type === 'message_reset').length, 1);
    assert.equal(h.fixtures.toolCalls.length, 1);
    const saved = (await h.request(`/conversations/${final.conversationId}`)).data;
    assert.equal(saved.messages.filter(m => m.role === 'assistant').length, 1);
    assert.equal(saved.messages.at(-1).content, final.text);
    const again = await h.request('/chat', { text: '调用工具并解释', requestKey: `stream-${workerMode}-once` });
    assert.equal(again.data.text, final.text); assert.equal(round, 2); assert.equal(h.fixtures.toolCalls.length, 1);
  } finally { release(); await h.close(); }
});

test('independent review never emits analyst/reviewer text; block and pass retain their publication gate', async () => {
  const h = await runtimeFixture();
  try {
    for (const verdict of ['block', 'pass']) {
      h.model((req, res) => {
        assert.equal(req.body.stream, true);
        const reviewer = req.body.messages[0].content.startsWith('independent-evidence-review/v1');
        answer(res, undefined, reviewer ? JSON.stringify({ verdict, reasons: verdict === 'pass' ? [] : ['unsupported_claim'] }) : 'PRIVATE_DRAFT_未复核');
      });
      const events = [];
      const result = await h.app.engine.execute(h.user, { text: '知识说明', useKnowledge: false, reviewMode: 'independent' }, e => events.push(e));
      assert.equal(events.some(e => e.type.startsWith('message_')), false);
      assert.ok(!JSON.stringify(events).includes('PRIVATE_DRAFT'));
      assert.equal(result.metadata.agentReview.status, verdict === 'pass' ? 'accepted' : 'blocked');
      assert.equal(result.text.includes('PRIVATE_DRAFT'), verdict === 'pass');
    }
  } finally { await h.close(); }
});

test('a truncated stream fails the execution and never persists a partial assistant answer', async () => {
  const h = await runtimeFixture();
  try {
    h.model((req, res) => res.type('text/event-stream').end(delta('不能保存的半截回答')));
    const events = [];
    await assert.rejects(h.app.engine.execute(h.user, { text: '中断测试', requestKey: 'stream-truncated-test' }, e => events.push(e)), { status: 502 });
    assert.ok(events.some(e => e.type === 'message_delta'));
    const cid = events.find(e => e.type === 'session').id;
    const saved = (await h.request(`/conversations/${cid}`)).data;
    assert.equal(saved.messages.some(m => m.role === 'assistant'), false);
    assert.equal(saved.messages.at(-1).role, 'error');
    assert.ok(!JSON.stringify(saved).includes('不能保存的半截回答'));
  } finally { await h.close(); }
});

test('Responses SSE with an incomplete status fails without publishing or persisting an assistant answer', async () => {
  const h = await runtimeFixture();
  try {
    for (const status of ['incomplete', 'failed']) {
      h.model((req, res) => {
        assert.equal(req.body.stream, true);
        res.json({ status, output: [{ type: 'message', role: 'assistant', content: [{ type: 'output_text', text: '不能保存的半截SSE回答' }] }] });
      });
      const events = []; const requestKey = `json-incomplete-${status}`;
      await assert.rejects(h.app.engine.execute(h.user, { text: '截断SSE测试', requestKey }, e => events.push(e)), { status: 502 });
      const cid = events.find(e => e.type === 'session').id;
      const saved = (await h.request(`/conversations/${cid}`)).data;
      assert.equal(saved.messages.some(m => m.role === 'assistant'), false);
      assert.equal(saved.messages.at(-1).role, 'error');
      assert.ok(!JSON.stringify(saved).includes('不能保存的半截SSE回答'));
      assert.equal(events.some(e => e.type === 'message_delta'), false);
      assert.equal(h.app.store.get('SELECT status FROM executions WHERE request_key=?', requestKey).status, 'failed');
    }
    assert.equal(h.fixtures.toolCalls.length, 0);
  } finally { await h.close(); }
});

test('Responses SSE refusals persist as complete answers while independent review keeps its publication gate', async () => {
  const h = await runtimeFixture();
  const refusal = '无法帮助执行此请求。';
  try {
    for (const reviewMode of ['off', 'independent']) for (const content of [null, '']) {
      h.model((req, res) => {
        assert.equal(req.body.stream, true);
        const reviewer = req.body.messages[0].content.startsWith('independent-evidence-review/v1');
        res.json({ status: 'completed', output: [{ type: 'message', role: 'assistant', content: reviewer
          ? [{ type: 'output_text', text: JSON.stringify({ verdict: 'pass', reasons: [] }) }]
          : [...(content ? [{ type: 'output_text', text: content }] : []), { type: 'refusal', refusal }] }], usage: { total_tokens: 7 } });
      });
      const requestKey = `refusal-${reviewMode}-${content === null ? 'null' : 'empty'}`;
      const response = await h.request('/chat', { text: '拒绝消息协议验证', reviewMode, requestKey });
      assert.equal(response.status, 200, JSON.stringify(response.data));
      assert.equal(response.data.text, refusal);
      const saved = (await h.request(`/conversations/${response.data.conversationId}`)).data;
      assert.deepEqual(saved.messages.filter(m => m.role === 'assistant').map(m => m.content), [refusal]);
      assert.equal(saved.messages.some(m => m.role === 'error'), false);
      const run = h.app.store.get('SELECT status,tokens FROM executions WHERE request_key=?', requestKey);
      assert.equal(run.status, 'success');
      assert.equal(run.tokens, reviewMode === 'off' ? 7 : 14);
      if (reviewMode === 'independent') assert.equal(response.data.metadata.agentReview.status, 'accepted');
    }
    assert.equal(h.fixtures.toolCalls.length, 0);
  } finally { await h.close(); }
});


test('complete JSON is rejected even with completed status; no answer, tool call or retry is persisted', async () => {
  const h = await runtimeFixture();
  try {
    let modelCalls = 0;
    h.model((req, res) => {
      modelCalls++; assert.equal(req.body.stream, true);
      res.setHeader('Content-Type', 'application/json');
      res.end(JSON.stringify({ status: 'completed', output: [{ type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'JSON_PRIVATE_禁止保存' }] }] }));
    });
    for (const reviewMode of ['off', 'independent']) {
      const events = []; const requestKey = `sse-only-json-${reviewMode}`;
      await assert.rejects(h.app.engine.execute(h.user, { text: '只接受SSE', reviewMode, requestKey }, e => events.push(e)), error => error.status === 502 && /SSE/.test(error.message));
      const cid = events.find(e => e.type === 'session').id;
      const saved = (await h.request(`/conversations/${cid}`)).data;
      assert.equal(saved.messages.some(m => m.role === 'assistant'), false);
      assert.doesNotMatch(JSON.stringify(saved), /JSON_PRIVATE/);
      assert.equal(events.some(e => e.type === 'message_delta'), false);
      assert.equal(h.app.store.get('SELECT status FROM executions WHERE request_key=?', requestKey).status, 'failed');
    }
    assert.equal(modelCalls, 2); assert.equal(h.fixtures.toolCalls.length, 0);
  } finally { await h.close(); }
});
