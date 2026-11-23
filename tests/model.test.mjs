import { sendResponsesSse } from './responses-fixture.mjs';
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createApplication } from '../server/app.mjs';
import { completion, modelConfig } from '../server/model.mjs';
import { listen, startFixtures } from './fixtures.mjs';

let application, http, model, mcp, dir, cookie;
const requests = [];
const reasoning = { type: 'reasoning', id: 'rs_fixture', summary: [], encrypted_content: 'opaque-fixture-reasoning' };
let reply;
const textOutput = text => ({ type: 'message', role: 'assistant', content: [{ type: 'output_text', text }] });
async function request(path, method = 'GET', body) {
  const response = await fetch(http.url + '/api' + path, { method, headers: { Cookie: cookie || '', 'Content-Type': 'application/json' }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  return { status: response.status, data: await response.json(), cookie: response.headers.get('set-cookie')?.split(';')[0] };
}
before(async () => {
  delete process.env.ADMIN_USERNAME; delete process.env.ADMIN_PASSWORD;
  const endpoint = express(); endpoint.use(express.json());
  endpoint.post('/v1/responses', (req, res) => { requests.push(req.body); reply(req, res); });
  model = await listen(endpoint); mcp = await startFixtures();
  dir = mkdtempSync(join(tmpdir(), 'aiops-responses-'));
  application = createApplication({ dataDir: dir, scheduler: false }); http = await listen(application.app);
  cookie = (await request('/auth/setup', 'POST', { username: 'responses-admin', name: '管理员', password: 'responses-test-password' })).cookie;
});
after(async () => { await http?.close(); await application?.close(); await model?.close(); await mcp?.close(); if (dir) rmSync(dir, { recursive: true, force: true }); });

test('Responses is the only protocol, legacy saved settings normalize without mutation and obsolete environment selection fails', () => {
  const previous = process.env.MODEL_API_TYPE;
  try {
    process.env.MODEL_API_TYPE = 'responses';
    assert.equal(modelConfig({ setting: () => null }).apiType, 'responses');
    assert.equal(modelConfig({ setting: () => ({ model: 'legacy' }), decrypt: () => '' }).apiType, 'responses');
    const saved = { model: 'legacy', apiType: 'chat_completions' };
    assert.equal(modelConfig({ setting: () => saved, decrypt: () => '' }).apiType, 'responses');
    assert.equal(saved.apiType, 'chat_completions');
    process.env.MODEL_API_TYPE = 'chat_completions';
    assert.throws(() => modelConfig({ setting: () => null }), { status: 422 });
    process.env.MODEL_API_TYPE = 'typo';
    assert.throws(() => modelConfig({ setting: () => null }), { status: 422 });
    delete process.env.MODEL_API_TYPE;
    assert.equal(modelConfig({ setting: () => null }).apiType, 'responses');
  } finally { if (previous === undefined) delete process.env.MODEL_API_TYPE; else process.env.MODEL_API_TYPE = previous; }
});

test('Responses settings persist protocol and nullable temperature, preserve encrypted key and test saved endpoint', async () => {
  const config = { baseUrl: model.url + '/v1/', model: 'responses-fixture', apiType: 'responses', temperature: null, apiKey: 'fixture-model-key' };
  const saved = await request('/settings/model', 'PUT', config);
  assert.equal(saved.status, 200); assert.equal(saved.data.apiType, 'responses'); assert.equal(saved.data.temperature, null);
  assert.equal(saved.data.firstByteTimeoutSeconds, 90); assert.equal(saved.data.streamIdleTimeoutSeconds, 180);
  assert.ok(!JSON.stringify(saved.data).includes(config.apiKey));
  assert.ok(!JSON.stringify(application.store.setting('model')).includes(config.apiKey));
  const { apiKey, ...withoutKey } = config;
  await request('/settings/model', 'PUT', withoutKey);
  assert.equal(application.store.decrypt(application.store.setting('model').apiKeyEncrypted), apiKey);
  assert.equal((await request('/settings/model')).data.apiType, 'responses');
  assert.equal((await request('/settings/model', 'PUT', { ...withoutKey, apiType: 'invalid' })).status, 400);
  assert.equal((await request('/settings/model', 'PUT', { ...withoutKey, apiType: 'chat_completions' })).status, 400);
  reply = (req, res) => {
    assert.equal(req.headers.authorization, 'Bearer fixture-model-key'); assert.equal(req.headers.accept, 'text/event-stream');
    sendResponsesSse(res, { status: 'completed', output: [textOutput('连接成功')] });
  };
  const tested = await request('/settings/model/test', 'POST', {});
  assert.equal(tested.status, 200); assert.equal(tested.data.text, '连接成功');
  const sent = requests.at(-1);
  assert.equal(sent.stream, true); assert.equal(sent.store, false); assert.deepEqual(sent.include, ['reasoning.encrypted_content']);
  assert.equal(sent.max_output_tokens, 4096); assert.equal(sent.temperature, undefined); assert.equal(sent.messages, undefined); assert.equal(sent.max_tokens, undefined);
  assert.deepEqual(sent.input, [{ role: 'user', content: '请只回复：连接成功' }]);
});

test('stream timeout settings persist, validate disjoint ranges and survive old clients', async () => {
  const settings = (await request('/settings/model')).data;
  const saved = await request('/settings/model', 'PUT', { ...settings, firstByteTimeoutSeconds: 120, streamIdleTimeoutSeconds: 0 });
  assert.equal(saved.status, 200); assert.equal(saved.data.firstByteTimeoutSeconds, 120); assert.equal(saved.data.streamIdleTimeoutSeconds, 0);
  const { firstByteTimeoutSeconds, streamIdleTimeoutSeconds, ...oldClientSettings } = settings;
  await request('/settings/model', 'PUT', oldClientSettings);
  const preserved = (await request('/settings/model')).data;
  assert.equal(preserved.firstByteTimeoutSeconds, 120); assert.equal(preserved.streamIdleTimeoutSeconds, 0);
  for (const value of [0, 121, 1.5]) assert.equal((await request('/settings/model', 'PUT', { ...preserved, firstByteTimeoutSeconds: value })).status, 400);
  for (const value of [1, 59, 601, 60.5]) assert.equal((await request('/settings/model', 'PUT', { ...preserved, streamIdleTimeoutSeconds: value })).status, 400);
  await request('/settings/model', 'PUT', { ...preserved, firstByteTimeoutSeconds: 90, streamIdleTimeoutSeconds: 180 });
});

test('reasoning effort persists defaults, maps to Responses and overrides both independent stages without changing settings', async () => {
  const settings = (await request('/settings/model')).data;
  assert.equal(settings.model_reasoning_effort, null);
  assert.equal(requests.at(-1).reasoning, undefined);
  for (const invalid of ['ultra', 'none', '', 1, {}]) {
    assert.equal((await request('/settings/model', 'PUT', { ...settings, model_reasoning_effort: invalid })).status, 400);
    assert.equal((await request('/chat', 'POST', { text: '非法强度', model_reasoning_effort: invalid })).status, 400);
  }
  const saved = await request('/settings/model', 'PUT', { ...settings, model_reasoning_effort: 'medium' });
  assert.equal(saved.data.model_reasoning_effort, 'medium');
  assert.equal(application.store.setting('model').model_reasoning_effort, 'medium');
  assert.equal((await request('/model/status')).data.model_reasoning_effort, 'medium');
  // Old clients omitting the field preserve an already configured default.
  const { model_reasoning_effort: ignoredEffort, ...oldClientSettings } = settings;
  await request('/settings/model', 'PUT', oldClientSettings);
  assert.equal((await request('/settings/model')).data.model_reasoning_effort, 'medium');
  reply = (req, res) => sendResponsesSse(res, { status: 'completed', output: [textOutput('连接成功')] });
  await request('/settings/model/test', 'POST', {});
  assert.deepEqual(requests.at(-1).reasoning, { effort: 'medium' });
  for (const effort of [undefined, 'low', 'medium', 'high', null]) {
    const before = requests.length;
    reply = (req, res) => sendResponsesSse(res, { status: 'completed', output: [textOutput(req.body.input[0].content.startsWith('independent-evidence-review') ? '{"verdict":"pass","reasons":[]}' : '这是一条普通知识建议')] });
    const chat = await request('/chat', 'POST', { text: '给我一条普通知识建议', reviewMode: 'independent', useKnowledge: false, model_reasoning_effort: effort });
    assert.equal(chat.status, 200, JSON.stringify(chat.data));
    assert.equal(chat.data.metadata.agentReview.status, 'accepted');
    const effective = effort === undefined ? 'medium' : effort;
    assert.equal(chat.data.metadata.model_reasoning_effort, effective);
    assert.equal(requests.length - before, 2);
    for (const body of requests.slice(before)) {
      assert.deepEqual(body.reasoning, effective === null ? undefined : { effort: effective });
      assert.equal(body.model_reasoning_effort, undefined, 'local configuration name must not leak into wire API');
    }
    const history = await request(`/conversations/${chat.data.conversationId}`);
    assert.equal(history.data.messages.at(-1).metadata.model_reasoning_effort, effective);
    assert.equal((await request('/settings/model')).data.model_reasoning_effort, 'medium');
  }
  let attempts = 0;
  reply = (req, res) => { attempts++; sendResponsesSse(res, { status: 'completed', output: [textOutput('一次回答')] }); };
  const data = { text: '幂等强度', useKnowledge: false, requestKey: 'effort-idempotency-key', model_reasoning_effort: 'low' };
  assert.equal((await request('/chat', 'POST', data)).status, 200);
  assert.equal((await request('/chat', 'POST', data)).status, 200);
  assert.equal((await request('/chat', 'POST', { ...data, model_reasoning_effort: 'high' })).status, 409);
  assert.equal(attempts, 1);
  await request('/settings/model', 'PUT', { ...settings, model_reasoning_effort: null });
});

test('environment reasoning effort validates values and legacy saved configuration keeps provider defaults', () => {
  const old = process.env.MODEL_REASONING_EFFORT;
  try {
    for (const effort of ['low', 'medium', 'high', 'none']) {
      process.env.MODEL_REASONING_EFFORT = effort;
      assert.equal(modelConfig({ setting: () => null }).model_reasoning_effort, effort === 'none' ? null : effort);
      assert.equal(modelConfig({ setting: () => ({ model: 'legacy' }), decrypt: () => '' }).model_reasoning_effort, null);
    }
    process.env.MODEL_REASONING_EFFORT = 'invalid';
    assert.throws(() => modelConfig({ setting: () => null }), { status: 422 });
  } finally { if (old === undefined) delete process.env.MODEL_REASONING_EFFORT; else process.env.MODEL_REASONING_EFFORT = old; }
});

test('environment stream timeout defaults validate both ranges', () => {
  const previousFirst = process.env.MODEL_FIRST_BYTE_TIMEOUT_SECONDS;
  const previousIdle = process.env.MODEL_STREAM_IDLE_TIMEOUT_SECONDS;
  try {
    process.env.MODEL_FIRST_BYTE_TIMEOUT_SECONDS = '120'; process.env.MODEL_STREAM_IDLE_TIMEOUT_SECONDS = '0';
    assert.equal(modelConfig({ setting: () => null }).firstByteTimeoutSeconds, 120);
    assert.equal(modelConfig({ setting: () => null }).streamIdleTimeoutSeconds, 0);
    process.env.MODEL_FIRST_BYTE_TIMEOUT_SECONDS = '121';
    assert.throws(() => modelConfig({ setting: () => null }), { status: 422 });
    process.env.MODEL_FIRST_BYTE_TIMEOUT_SECONDS = '90'; process.env.MODEL_STREAM_IDLE_TIMEOUT_SECONDS = '59';
    assert.throws(() => modelConfig({ setting: () => null }), { status: 422 });
  } finally {
    if (previousFirst === undefined) delete process.env.MODEL_FIRST_BYTE_TIMEOUT_SECONDS; else process.env.MODEL_FIRST_BYTE_TIMEOUT_SECONDS = previousFirst;
    if (previousIdle === undefined) delete process.env.MODEL_STREAM_IDLE_TIMEOUT_SECONDS; else process.env.MODEL_STREAM_IDLE_TIMEOUT_SECONDS = previousIdle;
  }
});

test('Responses executes MCP round trip with call_id, reasoning replay, usage and subsequent conversation history', async () => {
  const resource = await request('/resources', 'POST', { kind: 'mcp', name: 'Responses MCP', endpoint: mcp.url + '/mcp', token: 'fixture-mcp-secret', allowedTools: ['service_status'], toolPolicies: { service_status: { risk: 'read', roles: ['admin'], environments: ['test'] } } });
  assert.equal(resource.status, 201);
  application.store.setSetting('model', { ...application.store.setting('model'), model_reasoning_effort: 'high' });
  let round = 0;
  reply = (req, res) => {
    round++;
    const body = req.body;
    assert.deepEqual(body.reasoning, { effort: 'high' });
    assert.equal(body.tools[0].name, 'mcp_0'); assert.equal(body.tools[0].strict, false); assert.equal(body.tools[0].function, undefined);
    assert.equal(body.tools[0].parameters.type, 'object');
    if (round === 1) {
      application.store.setSetting('model', { ...application.store.setting('model'), model_reasoning_effort: 'low' });
      assert.equal(body.input[0].role, 'system');
      return sendResponsesSse(res, { status: 'completed', output: [reasoning, { type: 'function_call', id: 'fc_distinct_item_id', call_id: 'call_mcp', name: 'mcp_0', arguments: '{"service":"billing"}' }], usage: { input_tokens: 40, output_tokens: 10, total_tokens: 50 } });
    }
    assert.deepEqual(body.input.find(i => i.type === 'reasoning'), reasoning);
    assert.deepEqual(body.input.find(i => i.type === 'function_call'), { type: 'function_call', call_id: 'call_mcp', name: 'mcp_0', arguments: '{"service":"billing"}' });
    const output = body.input.find(i => i.type === 'function_call_output');
    assert.equal(output.call_id, 'call_mcp'); assert.match(output.output, /healthy/);
    sendResponsesSse(res, { status: 'completed', output: [reasoning, textOutput('计费服务'), textOutput('健康')], usage: { input_tokens: 70, output_tokens: 20, total_tokens: 90 } });
  };
  const chat = await request('/chat', 'POST', { text: '检查计费服务', requestKey: 'responses-mcp-roundtrip' });
  assert.equal(chat.status, 200, JSON.stringify(chat.data)); assert.equal(chat.data.text, '计费服务健康');
  assert.equal(round, 2); assert.equal(chat.data.metadata.model_reasoning_effort, 'high'); assert.equal(chat.data.metadata.usage.total_tokens, 140);
  assert.equal(chat.data.metadata.tools[0].tool, 'service_status'); assert.equal(mcp.toolCalls.length, 1);
  const execution = application.store.get('SELECT tokens FROM executions WHERE request_key=?', 'responses-mcp-roundtrip');
  assert.equal(execution.tokens, 140);
  reply = (req, res) => {
    assert.ok(req.body.input.some(i => i.role === 'assistant' && i.content === '计费服务健康'));
    sendResponsesSse(res, { status: 'completed', output: [textOutput('已确认')] });
  };
  const followup = await request('/chat', 'POST', { text: '再确认', conversationId: chat.data.conversationId });
  assert.equal(followup.status, 200); assert.equal(followup.data.text, '已确认');
});

test('Responses handles refusal and rejects failed, incomplete, malformed and HTTP error responses', async () => {
  reply = (req, res) => sendResponsesSse(res, { status: 'completed', output: [{ type: 'message', role: 'assistant', content: [{ type: 'refusal', refusal: '无法执行' }] }], usage: { input_tokens: 3, output_tokens: 2, total_tokens: 5 } });
  const refused = await completion(application.store, [{ role: 'user', content: 'hello' }]);
  assert.equal(refused.message.content, '无法执行'); assert.equal(refused.usage.prompt_tokens, 3); assert.equal(refused.usage.completion_tokens, 2);
  for (const result of [null, {}, { status: 'failed', error: { message: 'sensitive-upstream-detail' } }, { status: 'incomplete', output: [textOutput('partial')] }, { status: 'completed', output: [reasoning] }, { output: [{ type: 'function_call', id: 'wrong-id', name: 'mcp_0', arguments: '{}' }] }]) {
    reply = (req, res) => sendResponsesSse(res, result);
    await assert.rejects(completion(application.store, [{ role: 'user', content: 'hello' }]), { status: 502 });
  }
  reply = (req, res) => res.status(503).json({ error: 'sensitive-upstream-detail' });
  await assert.rejects(completion(application.store, [{ role: 'user', content: 'hello' }]), error => error.status === 502 && /HTTP 503/.test(error.message) && !error.message.includes('sensitive-upstream-detail'));
  reply = (req, res) => res.send('not JSON');
  await assert.rejects(completion(application.store, [{ role: 'user', content: 'hello' }]), { status: 502 });
});

test('Responses preserves outbound redaction/block policy and cancellation', async () => {
  reply = (req, res) => sendResponsesSse(res, { status: 'completed', output: [textOutput('ok')] });
  const messages = [{ role: 'system', content: 'api_key=top-secret-value' }, { role: 'assistant', content: '', tool_calls: [{ id: 'call_a', type: 'function', function: { name: 'mcp_0', arguments: '{}' } }] }, { role: 'tool', tool_call_id: 'call_a', content: 'Bearer abcdefghijklmnop' }];
  await completion(application.store, messages);
  assert.match(requests.at(-1).input[0].content, /REDACTED/);
  assert.equal(requests.at(-1).input.at(-1).output, 'Bearer [REDACTED]');
  const previous = process.env.MODEL_DATA_POLICY; const count = requests.length;
  try {
    process.env.MODEL_DATA_POLICY = 'block';
    await assert.rejects(completion(application.store, messages), { status: 422 });
    assert.equal(requests.length, count);
  } finally { if (previous === undefined) delete process.env.MODEL_DATA_POLICY; else process.env.MODEL_DATA_POLICY = previous; }
  await assert.rejects(completion(application.store, [{ role: 'user', content: 'hello' }], [], AbortSignal.abort()), { status: 502 });
});
