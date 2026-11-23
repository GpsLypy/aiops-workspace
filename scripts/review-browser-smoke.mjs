import { sendResponsesSse } from '../tests/responses-fixture.mjs';
import { chromium } from 'playwright';
import express from 'express';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createApplication } from '../server/app.mjs';
import { listen } from '../tests/fixtures.mjs';

// No .env or workspace database is loaded. Only the local fixture receives requests.
const output = resolve('test-results/review'); mkdirSync(output, { recursive: true });
const dir = mkdtempSync(join(tmpdir(), 'aiops-review-browser-'));
const application = createApplication({ dataDir: dir, scheduler: false });
const model = express(); model.use(express.json());
const checks = [], errors = [], requests = [], sent = [];
let scenario = 'off', release = () => {}, held = Promise.resolve(), started = Promise.withResolvers();
let browser, http, upstream;
const candidate = mode => `候选正文标记_${mode}：这是本地模型的知识说明。`;
const reviewerText = mode => mode === 'accepted' ? '{"verdict":"pass","reasons":[]}'
  : mode === 'blocked' ? '{"verdict":"block","reasons":["target_mismatch","missing_evidence"]}' : 'INVALID_REVIEW_PRIVATE_TEXT';
model.post('/v1/{*path}', async (req, res, next) => {
  try {
    const messages = req.body.input;
    const reviewer = JSON.stringify(messages[0]).includes('independent-evidence-review/v1');
    const currentScenario = scenario;
    requests.push({ apiType: 'responses', scenario: currentScenario, role: reviewer ? 'reviewer' : 'analyst' });
    assert.equal(req.body.stream, true);
    if (reviewer) {
      assert.equal(req.body.tools?.length || 0, 0);
      assert.equal(messages.length, 2);
      started.resolve();
      await held;
    }
    if (res.destroyed) return;
    const text = reviewer ? reviewerText(currentScenario) : candidate(currentScenario);
    const usage = { total_tokens: reviewer ? 7 : 13 };
    sendResponsesSse(res, { status: 'completed', output: [{ type: 'message', role: 'assistant', content: [{ type: 'output_text', text }] }], usage });
  } catch (error) { next(error); }
});
const hold = () => { started = Promise.withResolvers(); held = new Promise(resolve => { release = resolve; }); };
const untilReviewer = async () => {
  let timer;
  try { await Promise.race([started.promise, new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('Review model was not called within 30 seconds')), 30000); })]); }
  finally { clearTimeout(timer); }
};
try {
  http = await listen(application.app); upstream = await listen(model);
  browser = await chromium.launch({ headless: process.env.REVIEW_BROWSER_VISIBLE !== 'true', ...(process.env.PLAYWRIGHT_CHANNEL ? { channel: process.env.PLAYWRIGHT_CHANNEL } : {}) });
  const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
  page.setDefaultTimeout(30000);
  page.on('pageerror', error => errors.push(error.message));
  page.on('request', request => { if (request.url() === http.url + '/api/chat') sent.push(request.postDataJSON()); });
  await page.goto(http.url);
  await page.locator('input[name=username]').fill('review-admin');
  await page.locator('input[name=name]').fill('复核验收');
  await page.locator('input[name=password]').fill('review-browser-test-password');
  await page.getByRole('button', { name: '创建管理员并进入' }).click();
  await page.getByRole('button', { name: '执行与审批', exact: true }).waitFor();
  const toggle = page.getByRole('switch', { name: '独立复核', exact: true });
  const send = async text => {
    await page.getByRole('textbox', { name: '输入你的问题' }).fill(text);
    await page.getByRole('button', { name: '发送消息', exact: true }).click();
  };
  const latest = () => {
    const run = application.store.get('SELECT * FROM executions ORDER BY created DESC,rowid DESC LIMIT 1');
    const messages = application.store.all('SELECT * FROM messages WHERE conversation_id=? ORDER BY seq', run.conversation_id);
    return { run, messages, message: messages.at(-1) };
  };
  for (const apiType of ['responses']) {
    assert.equal((await page.request.put(http.url + '/api/settings/model', { data: { baseUrl: upstream.url + '/v1', model: 'review-fixture', apiType } })).ok(), true);
    await page.goto(http.url + '/#chat'); await page.reload();
    assert.equal(await toggle.getAttribute('aria-checked'), 'false');
    scenario = 'off';
    await send(`${apiType} 关闭复核验收`);
    await page.locator('.message.assistant').filter({ hasText: candidate('off') }).waitFor();
    await page.waitForFunction(() => !document.querySelector('.chat-progress'));
    assert.equal(sent.at(-1).reviewMode, 'off');
    assert.equal(await page.locator('.agent-review').count(), 0);
    assert.equal(JSON.parse(latest().message.metadata).agentReview, undefined);
    assert.equal(requests.filter(r => r.apiType === apiType && r.scenario === 'off').length, 1);
    checks.push(`${apiType}: default off sends one model request and no review panel`);
    console.log(checks.at(-1));

    for (const status of ['accepted', 'blocked', 'unavailable']) {
      await page.setViewportSize({ width: 1280, height: 900 });
      await page.getByRole('button', { name: '新建对话', exact: true }).click();
      assert.equal(await toggle.getAttribute('aria-checked'), 'false');
      await toggle.focus(); await page.keyboard.press('Space');
      assert.equal(await toggle.getAttribute('aria-checked'), 'true');
      assert.match(await page.locator('#independent-review-help').innerText(), /增加一次模型调用和等待时间/);
      scenario = status; hold();
      const title = `${apiType} ${status} 独立复核验收`;
      await send(title);
      await untilReviewer();
      await page.getByRole('status').filter({ hasText: '正在独立复核' }).waitFor();
      assert.equal(await toggle.isDisabled(), true);
      assert.equal(await page.locator('.message.streaming').count(), 0);
      assert.equal((await page.locator('body').innerText()).includes(candidate(status)), false);
      const during = latest();
      assert.equal(during.run.status, 'running');
      assert.equal(JSON.stringify(during.messages).includes(candidate(status)), false);
      if (apiType === 'responses' && status === 'accepted') await page.screenshot({ path: join(output, 'review-waiting-desktop.png'), fullPage: true });
      release();
      const panel = page.locator(`.agent-review-${status}`);
      await panel.waitFor();
      await page.waitForFunction(() => !document.querySelector('.chat-progress'));
      assert.equal((await page.locator('body').innerText()).includes('INVALID_REVIEW_PRIVATE_TEXT'), false);
      assert.equal(sent.at(-1).reviewMode, 'independent');
      const saved = latest(); const review = JSON.parse(saved.message.metadata).agentReview;
      assert.equal(review.status, status);
      assert.equal(saved.run.runtime, 'agentscope');
      assert.deepEqual(review.stages, [{ role: 'analyst', modelCalls: 1, tokens: 13 }, { role: 'reviewer', modelCalls: 1, tokens: 7 }]);
      assert.equal(saved.run.tokens, 20);
      assert.equal(await page.locator('.message.assistant').count(), 1);
      assert.equal(saved.message.content.includes(candidate(status)), status === 'accepted');
      if (status !== 'accepted') {
        assert.equal((await page.locator('body').innerText()).includes(candidate(status)), false);
        assert.equal(JSON.stringify(saved.messages).includes(candidate(status)), false);
      }
      await panel.locator('summary').focus(); await page.keyboard.press('Enter');
      assert.equal(await panel.getAttribute('open'), '');
      assert.match(await panel.innerText(), /分析 Agent[\s\S]*复核 Agent/);
      if (status === 'blocked') assert.match(await panel.innerText(), /对象或范围与请求不一致[\s\S]*本轮证据不足/);
      if (status === 'unavailable') assert.match(await panel.innerText(), /复核结果格式不符合要求/);
      const downloadPromise = page.waitForEvent('download');
      await panel.getByRole('button', { name: '导出复核 JSON' }).click();
      const download = await downloadPromise;
      assert.equal(download.suggestedFilename(), `agent-review-${saved.run.id}.json`);
      const artifact = join(output, `${apiType}-${status}.json`); await download.saveAs(artifact);
      assert.deepEqual(JSON.parse(readFileSync(artifact, 'utf8')), review);
      assert.equal(readFileSync(artifact, 'utf8').includes('候选正文标记'), false);
      if (apiType === 'responses') await page.screenshot({ path: join(output, `review-${status}-desktop.png`), fullPage: true });

      await page.reload();
      assert.equal(await toggle.getAttribute('aria-checked'), 'false');
      await page.getByRole('button', { name: title, exact: true }).click();
      await panel.waitFor();
      await panel.locator('summary').focus(); await page.keyboard.press('Space');
      assert.equal(await panel.getAttribute('open'), '');
      assert.match(await panel.innerText(), /13 tokens[\s\S]*7 tokens/);
      await page.setViewportSize({ width: 320, height: 568 });
      assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
      await panel.getByRole('button', { name: '导出复核 JSON' }).scrollIntoViewIfNeeded();
      const composer = await page.locator('.composer').boundingBox();
      assert.ok(composer && composer.y >= 0 && composer.y + composer.height <= 568);
      if (apiType === 'responses') {
        await page.screenshot({ path: join(output, `review-${status}-mobile-320.png`), fullPage: true });
        await panel.locator('summary').scrollIntoViewIfNeeded();
        await page.screenshot({ path: join(output, `review-${status}-mobile-320-stages.png`), fullPage: true });
      }
      checks.push(`${apiType}/${status}: draft gate, actual two-stage usage, keyboard, persisted reload, exact JSON download and 320px`);
      console.log(checks.at(-1));
    }
    await page.setViewportSize({ width: 1280, height: 900 });
  }
  assert.deepEqual(errors, []);
  writeFileSync(join(output, 'browser-report.json'), JSON.stringify({ checkedAt: new Date().toISOString(), mode: 'fixture', runtime: 'agentscope', checks, requests, errors }, null, 2) + '\n');
  console.log(JSON.stringify({ checks, requests: requests.length, errors }));
} finally {
  release(); await browser?.close(); await http?.close(); await application.close(); await upstream?.close(); rmSync(dir, { recursive: true, force: true });
}
