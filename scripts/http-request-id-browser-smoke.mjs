import { chromium } from 'playwright';
import express from 'express';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createApplication } from '../server/app.mjs';
import { listen } from '../tests/fixtures.mjs';

// Only a disposable database and local Responses fixture are used. No .env,
// saved model configuration, external model or MCP is loaded by this script.
const output = resolve('test-results/http-request-id'); mkdirSync(output, { recursive: true });
const dir = mkdtempSync(join(tmpdir(), 'aiops-http-request-id-'));
const application = createApplication({ dataDir: dir, scheduler: false, agentRuntime: { workerMode: 'prefork', poolSize: 1 } });
const model = express(); model.use(express.json());
const checks = [], errors = [], submitted = [], answers = [];
const uuidV4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const frame = data => `data: ${JSON.stringify(data)}\n\n`;
let release = () => {}, held = Promise.resolve(), modelRequests = 0;
let browser, http, upstream;
model.post('/v1/responses', async (req, res, next) => {
  try {
    assert.equal(req.body.stream, true);
    assert.equal(req.headers.authorization, undefined);
    const round = ++modelRequests;
    const first = `HTTP 第 ${round} 轮第一段：中文🙂 已到达。\n\n`;
    const last = `HTTP 第 ${round} 轮第二段：回答已完成。`;
    answers.push({ first, last, full: first + last });
    res.type('text/event-stream');
    res.write(frame({ type: 'response.output_text.delta', delta: first }));
    await held;
    if (res.destroyed) return;
    res.end(frame({ type: 'response.output_text.delta', delta: last }) + frame({ type: 'response.completed', response: {
      status: 'completed', output: [{ type: 'message', role: 'assistant', content: [{ type: 'output_text', text: first + last }] }],
      usage: { input_tokens: 8, output_tokens: 4, total_tokens: 12 },
    } }));
  } catch (error) { next(error); }
});
const hold = () => { held = new Promise(resolve => { release = resolve; }); };
try {
  http = await listen(application.app); upstream = await listen(model);
  const insecureUrl = http.url.replace('127.0.0.1', 'poc-http.test');
  browser = await chromium.launch({
    headless: process.env.HTTP_REQUEST_ID_BROWSER_VISIBLE !== 'true',
    ...(process.env.PLAYWRIGHT_CHANNEL ? { channel: process.env.PLAYWRIGHT_CHANNEL } : {}),
    args: ['--host-resolver-rules=MAP poc-http.test 127.0.0.1', '--no-proxy-server'],
  });
  const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
  page.setDefaultTimeout(30000);
  page.on('pageerror', error => errors.push(error.message));
  page.on('request', request => { if (request.url() === insecureUrl + '/api/chat') submitted.push(request.postDataJSON()); });
  await page.goto(insecureUrl);
  const context = await page.evaluate(() => ({
    secure: isSecureContext, randomUUID: typeof crypto.randomUUID, getRandomValues: typeof crypto.getRandomValues,
  }));
  assert.deepEqual(context, { secure: false, randomUUID: 'undefined', getRandomValues: 'function' });
  checks.push('real HTTP hostname is an insecure context with randomUUID unavailable and getRandomValues available');
  await page.locator('input[name=username]').fill('http-test-admin');
  await page.locator('input[name=name]').fill('HTTP 请求标识验收');
  await page.locator('input[name=password]').fill('http-browser-fixture-password');
  await page.getByRole('button', { name: '创建管理员并进入' }).click();
  await page.getByRole('button', { name: '执行与审批', exact: true }).waitFor();
  const save = await page.evaluate(async data => {
    const response = await fetch('/api/settings/model', { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(data) });
    return { status: response.status, configured: (await response.json()).configured };
  }, { baseUrl: upstream.url + '/v1', model: 'http-local-responses-fixture', apiType: 'responses', apiKey: '', temperature: null });
  assert.deepEqual(save, { status: 200, configured: true });
  await page.goto(insecureUrl + '/#chat'); await page.reload();
  const questions = ['HTTP 第一轮请求标识验收', 'HTTP 第二轮请求标识验收'];
  const runs = [];
  for (let round = 0; round < questions.length; round++) {
    hold();
    await page.getByRole('textbox', { name: '输入你的问题' }).fill(questions[round]);
    await page.getByRole('button', { name: '发送消息', exact: true }).click();
    const partial = page.locator('.message.streaming').filter({ hasText: `HTTP 第 ${round + 1} 轮第一段` });
    await partial.waitFor();
    assert.equal(submitted.length, round + 1);
    assert.match(submitted[round].requestKey, uuidV4);
    assert.equal(submitted[round].reviewMode, 'off');
    assert.equal(await partial.getAttribute('aria-busy'), 'true');
    assert.equal((await partial.innerText()).includes(answers[round].last), false);
    assert.equal(application.store.get('SELECT status FROM executions WHERE request_key=?', submitted[round].requestKey).status, 'running');
    release();
    await page.waitForFunction(() => !document.querySelector('.chat-progress'));
    const run = application.store.get('SELECT * FROM executions WHERE request_key=?', submitted[round].requestKey);
    assert.equal(run.status, 'success');
    assert.equal(run.runtime, 'agentscope');
    assert.equal(JSON.parse(run.result).text, answers[round].full);
    assert.equal(application.store.get("SELECT content FROM messages WHERE conversation_id=? AND role='assistant' ORDER BY seq DESC LIMIT 1", run.conversation_id).content, answers[round].full);
    assert.equal(await page.locator('.message.streaming').count(), 0);
    assert.equal(await page.locator('.message.assistant').count(), round + 1);
    assert.equal(await page.getByRole('alert').count(), 0);
    runs.push(run);
    checks.push(`round ${round + 1}: browser-generated UUID v4 reaches the real SDK; incremental and final text persist once`);
  }
  assert.notEqual(submitted[0].requestKey, submitted[1].requestKey);
  assert.equal(application.store.get('SELECT count(*) AS n FROM executions').n, 2);
  checks.push('separate browser submissions use separate request keys and produce two executions');
  const request = async data => page.evaluate(async body => {
    const response = await fetch('/api/chat', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    return { status: response.status, data: await response.json() };
  }, data);
  const original = { ...submitted[0] };
  const replay = await request(original);
  assert.equal(replay.status, 200);
  assert.equal(replay.data.runId, runs[0].id);
  assert.equal(replay.data.text, answers[0].full);
  assert.equal(application.store.get('SELECT count(*) AS n FROM executions').n, 2);
  assert.equal(modelRequests, 2);
  checks.push('replaying the same body and key returns the saved execution without another model call');
  const conflict = await request({ ...original, text: '不同正文不能复用原请求标识' });
  assert.equal(conflict.status, 409);
  assert.match(conflict.data.error, /幂等键已经用于不同的请求/);
  assert.equal(application.store.get('SELECT count(*) AS n FROM executions').n, 2);
  assert.equal(modelRequests, 2);
  checks.push('reusing the key with changed text returns 409 without another execution or model call');
  await page.reload();
  await page.getByRole('button', { name: questions[0], exact: true }).click();
  await page.locator('.message.assistant').filter({ hasText: answers[1].last }).waitFor();
  assert.equal(await page.locator('.message.assistant').count(), 2);
  assert.equal(application.store.get("SELECT count(*) AS n FROM messages WHERE conversation_id=? AND role='assistant'", runs[0].conversation_id).n, 2);
  assert.deepEqual(errors, []);
  checks.push('reloaded history contains both completed answers exactly once and no browser runtime errors');
  const unavailableContext = await browser.newContext();
  try {
    await unavailableContext.addInitScript(() => {
      Object.defineProperty(globalThis, 'crypto', { value: undefined, configurable: true });
    });
    const unavailablePage = await unavailableContext.newPage();
    let blockedChatRequests = 0;
    unavailablePage.on('pageerror', error => errors.push(error.message));
    unavailablePage.on('request', request => { if (request.url() === insecureUrl + '/api/chat') blockedChatRequests++; });
    await unavailablePage.goto(insecureUrl + '/#chat');
    assert.equal(await unavailablePage.evaluate(() => typeof globalThis.crypto), 'undefined');
    await unavailablePage.locator('input[name=username]').fill('http-test-admin');
    await unavailablePage.locator('input[name=password]').fill('http-browser-fixture-password');
    await unavailablePage.getByRole('button', { name: '登录', exact: true }).click();
    await unavailablePage.getByRole('textbox', { name: '输入你的问题' }).fill('没有安全随机源时应在浏览器终止发送');
    await unavailablePage.getByRole('button', { name: '发送消息', exact: true }).click();
    assert.equal(await unavailablePage.getByRole('textbox', { name: '输入你的问题' }).inputValue(), '没有安全随机源时应在浏览器终止发送');
    assert.equal(await unavailablePage.locator('.message.user').count(), 0, 'preflight failure must retain the unsent draft without fabricating history');
    await unavailablePage.getByRole('alert').filter({ hasText: '不支持安全生成请求标识' }).waitFor();
    await unavailablePage.waitForFunction(() => !document.querySelector('.chat-progress'));
    assert.equal(blockedChatRequests, 0);
    assert.equal(modelRequests, 2);
    assert.equal(application.store.get('SELECT count(*) AS n FROM executions').n, 2);
    assert.deepEqual(errors, []);
    checks.push('without crypto, a readable Chinese error stops submission before HTTP, execution or model calls');
  } finally { await unavailableContext.close(); }
  await page.screenshot({ path: join(output, 'http-chat-completed.png'), fullPage: true });
  const report = { checkedAt: new Date().toISOString(), mode: 'local-fixture', runtime: 'agentscope', context, checks, modelRequests, executions: 2, errors };
  writeFileSync(join(output, 'browser-report.json'), JSON.stringify(report, null, 2) + '\n');
  console.log(JSON.stringify(report));
} finally {
  release(); await browser?.close(); await http?.close(); await application.close(); await upstream?.close();
  rmSync(dir, { recursive: true, force: true });
}
