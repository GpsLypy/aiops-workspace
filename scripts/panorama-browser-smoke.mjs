import { chromium } from 'playwright';
import assert from 'node:assert/strict';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { runtimeFixture, answer, call } from '../tests/runtime-fixture.mjs';

// Temporary database, actual SDK and local HTTP fixtures only. No .env or live business data.
const output = resolve('test-results/panorama'); mkdirSync(output, { recursive: true });
const h = await runtimeFixture();
let browser, page, release = () => {};
const errors = [], checks = [];
try {
  let scenario = 'success', first = true;
  const began = Promise.withResolvers();
  const held = new Promise(resolve => { release = resolve; });
  h.model(async (req, res) => {
    if (first) { first = false; began.resolve(); await held; }
    if (scenario === 'error') return res.status(503).json({ error: 'PRIVATE_PROVIDER_FAILURE' });
    if (req.body.messages[0].content.startsWith('independent-evidence-review/v1')) return answer(res, undefined, '{"verdict":"block","reasons":["missing_evidence"]}');
    const tool = req.body.messages.at(-1).role === 'tool';
    if (scenario === 'pending') return answer(res, [call('pending-change', 'mcp_1', { service: 'billing', state: 'maintenance' })]);
    answer(res, tool ? undefined : [call()], tool ? '已取得本轮计费状态；这是本地受控验收。' : '');
  });
  await h.request('/resources', { kind: 'knowledge', name: '计费状态手册', body: '计费状态需要只读查询，不能用历史状态推断当前服务健康。' });
  await h.request('/resources', { kind: 'skills', name: '巡检说明', body: '先确认目标，再用只读工具查询计费状态。' });
  browser = await chromium.launch({ headless: true, ...(process.env.PLAYWRIGHT_CHANNEL ? { channel: process.env.PLAYWRIGHT_CHANNEL } : {}) });
  page = await browser.newPage({ viewport: { width: 1280, height: 900 }, permissions: ['clipboard-read', 'clipboard-write'] });
  page.setDefaultTimeout(30000);
  page.on('pageerror', error => errors.push(error.message));
  await page.request.post(h.url + '/api/auth/login', { data: { username: 'admin', password: 'runtime-test-password' } });
  await page.goto(h.url + '/#guide');
  const guide = page.getByRole('region', { name: 'AgentScope 使用与开发引导' });
  await guide.waitFor();
  await page.getByRole('button', { name: /^知识问答/ }).click();
  const template = page.getByLabel('SKILL.md 模板');
  await template.fill((await template.inputValue()) + '\n验收修改');
  const downloadEvent = page.waitForEvent('download');
  await page.getByRole('button', { name: '下载 SKILL.md', exact: true }).click();
  const skillDownload = await downloadEvent; await skillDownload.saveAs(join(output, 'SKILL.md'));
  assert.equal(readFileSync(join(output, 'SKILL.md'), 'utf8'), await template.inputValue());

  const guideStatus = guide.locator('.as-guide-feedback');
  const question = page.getByLabel('示例问题', { exact: true });
  const pressButton = async name => {
    const button = guide.getByRole('button', { name, exact: typeof name === 'string' });
    await button.focus();
    await page.keyboard.press('Enter');
    return button;
  };
  // Permission prompts can resolve after the user has changed the active content.
  await page.evaluate(() => {
    const fixture = { original: navigator.clipboard.writeText, pending: [] };
    window.guideClipboardFixture = fixture;
    navigator.clipboard.writeText = text => new Promise((resolve, reject) => fixture.pending.push({ text, resolve, reject }));
  });
  const beginCopy = async name => {
    const index = await page.evaluate(() => window.guideClipboardFixture.pending.length);
    const text = name === '复制模板' ? await template.inputValue() : name === '复制问题' ? await question.inputValue() : await guide.locator('.as-guide-dev-card pre').innerText();
    await pressButton(name);
    await page.waitForFunction(expected => window.guideClipboardFixture.pending.length === expected, index + 1);
    assert.equal(await page.evaluate(index => window.guideClipboardFixture.pending[index].text, index), text);
    return index;
  };
  const settleCopy = async (index, outcome) => {
    await page.evaluate(async ({ index, outcome }) => {
      const pending = window.guideClipboardFixture.pending[index];
      if (outcome === 'success') pending.resolve();
      else pending.reject(new DOMException('Clipboard permission denied for browser fixture', 'NotAllowedError'));
      await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
    }, { index, outcome });
  };
  for (const outcome of ['success', 'failure']) {
    await pressButton(/^知识问答/);
    const pending = await beginCopy('复制模板');
    const scenarioButton = await pressButton(/^只读巡检/);
    await settleCopy(pending, outcome);
    assert.equal(await guideStatus.textContent(), '', `A previous scenario's delayed ${outcome} must remain silent`);
    assert.equal(await scenarioButton.evaluate(element => document.activeElement === element), true);
  }
  for (const [from, to, copyName] of [
    ['开始使用', '开发与边界', '复制模板'], ['开始使用', '学习与面试', '复制问题'],
    ['开发与边界', '开始使用', '复制命令'], ['开发与边界', '学习与面试', '复制命令'],
  ]) {
    for (const outcome of ['success', 'failure']) {
      await pressButton(from);
      const pending = await beginCopy(copyName);
      const viewButton = await pressButton(to);
      await settleCopy(pending, outcome);
      assert.equal(await guideStatus.textContent(), '', `${from} to ${to}: delayed ${outcome} must remain silent`);
      assert.equal(await viewButton.evaluate(element => document.activeElement === element), true);
    }
  }
  checks.push('Guide delayed clipboard success/failure stays within its scenario and view; keyboard view/scenario focus is preserved.');

  await pressButton('开始使用');
  for (const [field, copyName] of [[template, '复制模板'], [question, '复制问题']]) {
    for (const outcome of ['success', 'failure']) {
      const pending = await beginCopy(copyName);
      const edited = (await field.inputValue()) + `\n编辑后 ${outcome}`;
      await field.fill(edited);
      await settleCopy(pending, outcome);
      assert.equal(await guideStatus.textContent(), '', `${copyName}: editing must invalidate a pending ${outcome}`);
      assert.equal(await field.inputValue(), edited);
      assert.equal(await field.evaluate(element => document.activeElement === element), true);
    }
    const accepted = await beginCopy(copyName);
    await settleCopy(accepted, 'success');
    assert.match(await guideStatus.textContent(), /^已复制/);
    await field.fill((await field.inputValue()) + '\n清除已显示提示');
    assert.equal(await guideStatus.textContent(), '', 'Editing must also clear an already displayed copy result');
  }
  const rejected = await beginCopy('复制问题');
  await settleCopy(rejected, 'failure');
  assert.equal(await guideStatus.textContent(), '浏览器未允许复制，请选中文本手动复制。');
  for (const outcome of ['success', 'failure']) {
    const older = await beginCopy('复制模板');
    const newer = await beginCopy('复制问题');
    await settleCopy(newer, 'success');
    await settleCopy(older, outcome);
    assert.equal(await guideStatus.textContent(), '已复制示例问题', `An older ${outcome} must not replace a newer copy result`);

    const pending = await beginCopy('复制模板');
    const exportedAgain = page.waitForEvent('download');
    await pressButton('下载 SKILL.md');
    const downloaded = await exportedAgain;
    assert.equal(downloaded.suggestedFilename(), 'SKILL.md');
    const file = join(output, `day02-guide-race-${outcome}.md`);
    await downloaded.saveAs(file);
    assert.equal(readFileSync(file, 'utf8'), await template.inputValue());
    await settleCopy(pending, outcome);
    assert.equal(await guideStatus.textContent(), '已生成 SKILL.md 下载；修改并压缩为 ZIP 后，可到 Skill 页面上传。', `An older ${outcome} must not replace download feedback`);
  }
  checks.push('Template/question edits clear and invalidate copy feedback; current failure is reported and newer copy/download results win with exact exported text.');

  const unmounted = await beginCopy('复制模板');
  await pressButton('去新建对话');
  await page.getByRole('textbox', { name: '输入你的问题', exact: true }).waitFor();
  await page.goto(h.url + '/#guide');
  await guide.waitFor();
  await settleCopy(unmounted, 'success');
  assert.equal(await guideStatus.textContent(), '', 'An unmounted guide copy must not reach a new guide view');
  await page.evaluate(() => {
    navigator.clipboard.writeText = window.guideClipboardFixture.original;
    delete window.guideClipboardFixture;
  });
  for (const [view, copyName, field] of [
    ['开始使用', '复制模板', template], ['开始使用', '复制问题', question],
    ['开发与边界', '复制命令', guide.locator('.as-guide-dev-card pre')],
  ]) {
    await pressButton(view);
    const expected = copyName === '复制命令' ? await field.innerText() : await field.inputValue();
    await pressButton(copyName);
    await guideStatus.filter({ hasText: '已复制' }).waitFor();
    assert.equal(await page.evaluate(() => navigator.clipboard.readText()), expected);
  }
  checks.push('Guide unmount isolates pending results; all three keyboard copy controls write the current content to the real clipboard.');
  await pressButton('开始使用');
  await page.evaluate(() => window.scrollTo(0, 0));
  await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
  await page.screenshot({ path: join(output, 'guide-desktop.png'), fullPage: false });
  await page.getByRole('button', { name: '开发与边界', exact: true }).click();
  assert.match(await guide.locator('.as-guide-next').innerText(), /本轮进展与下一步/);
  assert.match(await guide.locator('.as-guide-next').innerText(), /查询前目标绑定/);
  assert.match(await guide.locator('.as-guide-next').innerText(), /真实模型失败、AI 工程复核和生产验收分别记录/);
  assert.match(await guide.locator('.as-guide-next').innerText(), /不会用模拟通过替代真实结果/);
  await guide.locator('.as-guide-next').scrollIntoViewIfNeeded();
  await page.screenshot({ path: join(output, 'guide-roadmap-desktop.png'), fullPage: false });
  await page.setViewportSize({ width: 320, height: 568 });
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
  await page.getByRole('button', { name: '开发与边界', exact: true }).click();
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
  await page.screenshot({ path: join(output, 'guide-mobile.png'), fullPage: false });
  await guide.locator('.as-guide-next').scrollIntoViewIfNeeded();
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
  await page.screenshot({ path: join(output, 'guide-roadmap-mobile.png'), fullPage: false });
  checks.push('Integrated guide route, exact template download and verified rollout boundaries at desktop/320px');

  await page.setViewportSize({ width: 1280, height: 900 });
  await page.goto(h.url + '/#chat');
  const send = async text => {
    await page.getByRole('textbox', { name: '输入你的问题' }).fill(text);
    await page.getByRole('button', { name: '发送消息', exact: true }).click();
  };
  const latest = () => {
    const row = h.app.store.get('SELECT * FROM messages WHERE role IN (?,?) ORDER BY seq DESC LIMIT 1', 'assistant', 'error');
    return { ...row, metadata: JSON.parse(row.metadata) };
  };
  await send('查询计费状态并参考手册');
  let timer;
  try { await Promise.race([began.promise, new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('No live model request')), 30000); })]); }
  finally { clearTimeout(timer); }
  await page.getByRole('button', { name: '打开问答全景', exact: true }).click();
  await page.getByRole('dialog', { name: '问答全景', exact: true }).waitFor();
  assert.match(await page.locator('.panorama-explorer').innerText(), /实时处理记录/);
  assert.equal(await page.locator('.message.assistant').count(), 0);
  await page.screenshot({ path: join(output, 'panorama-live.png'), fullPage: false });
  release();
  await page.locator('.message.assistant').filter({ hasText: '已取得本轮计费状态' }).waitFor();
  await page.waitForFunction(() => !document.querySelector('.chat-progress'));
  await page.getByRole('dialog', { name: '问答全景', exact: true }).waitFor();
  assert.match(await page.locator('.panorama-explorer').innerText(), /本轮历史快照/);
  await page.keyboard.press('Escape');
  await page.waitForFunction(() => document.activeElement?.matches('.panorama-entry'));
  assert.equal(await page.getByRole('button', { name: '打开问答全景', exact: true }).evaluate(button => button === document.activeElement), true);
  const saved = latest(), trace = saved.metadata.executionTrace;
  assert.equal(trace.status, 'completed');
  assert.match(trace.traceId, /^[a-f0-9]{32}$/);
  assert.match(trace.spanId, /^[a-f0-9]{16}$/);
  assert.ok(trace.nodes.every(node => /^[a-f0-9]{16}$/.test(node.spanId) && /^[a-f0-9]{16}$/.test(node.parentSpanId)));
  assert.equal(trace.nodes.filter(n => n.kind === 'model').length, 2);
  assert.equal(trace.nodes.filter(n => n.kind === 'tool').length, 1);
  assert.equal(await page.getByRole('button', { name: '打开问答全景', exact: true }).count(), 1);
  await page.getByRole('button', { name: '打开问答全景', exact: true }).focus(); await page.keyboard.press('Enter');
  await page.getByRole('button', { name: '查看全图', exact: true }).click();
  await page.screenshot({ path: join(output, 'panorama-desktop.png'), fullPage: false });
  const traceDownloadEvent = page.waitForEvent('download');
  await page.getByRole('button', { name: '导出 JSON', exact: true }).click();
  const traceDownload = await traceDownloadEvent; await traceDownload.saveAs(join(output, 'trace.json'));
  assert.deepEqual(JSON.parse(readFileSync(join(output, 'trace.json'), 'utf8')), trace);
  await page.getByRole('button', { name: '节点列表', exact: true }).click();
  await page.locator('.panorama-list .panorama-node').first().focus(); await page.keyboard.press('End');
  assert.equal(await page.locator('.panorama-list .panorama-node').last().getAttribute('aria-pressed'), 'true');
  await page.setViewportSize({ width: 320, height: 568 });
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
  const focusChecks = [];
  const callsBeforeNavigation = { model: h.requests.length, tool: h.fixtures.toolCalls.length };
  const assertFocusedVisible = async context => {
    await page.waitForFunction(() => document.activeElement?.matches('.panorama-node[aria-pressed="true"]'));
    await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
    const geometry = await page.evaluate(() => {
      const node = document.activeElement, dialog = node.closest('[role="dialog"]'), canvas = node.closest('.panorama-list,.panorama-graph-scroll');
      const bounds = node.getBoundingClientRect(), outer = dialog.getBoundingClientRect(), inner = canvas.getBoundingClientRect();
      return { label: node.getAttribute('aria-label'), top: bounds.top, bottom: bounds.bottom,
        left: bounds.left, right: bounds.right,
        visibleTop: Math.max(0, outer.top, inner.top), visibleBottom: Math.min(innerHeight, outer.bottom, inner.bottom),
        visibleLeft: Math.max(0, outer.left, inner.left), visibleRight: Math.min(innerWidth, outer.right, inner.right),
        dialogScrollTop: dialog.scrollTop, canvasScrollTop: canvas.scrollTop };
    });
    focusChecks.push({ context, ...geometry });
    writeFileSync(join(output, 'dependency-focus.json'), JSON.stringify(focusChecks, null, 2) + '\n');
    assert.ok(geometry.top >= geometry.visibleTop - 1 && geometry.bottom <= geometry.visibleBottom + 1
      && geometry.left >= geometry.visibleLeft - 1 && geometry.right <= geometry.visibleRight + 1,
      `${context}: Focus must be visible within the dialog: ${JSON.stringify(geometry)}`);
  };
  for (const width of [1280, 320]) {
    await page.setViewportSize({ width, height: width === 320 ? 568 : 900 });
    await page.emulateMedia({ reducedMotion: 'reduce' });
    for (const view of ['节点列表', '依赖图']) {
      await page.getByRole('button', { name: view, exact: true }).click();
      if (view === '依赖图') await page.getByRole('button', { name: '恢复原始比例' }).click();
      const nodes = page.locator('.panorama-node');
      await nodes.first().focus(); await page.keyboard.press('End');
      await assertFocusedVisible(`${width}/${view}/End`);
      const dependency = page.locator('.panorama-dependencies').first().getByRole('button').first();
      await dependency.focus(); await page.keyboard.press('Enter');
      await assertFocusedVisible(`${width}/${view}/upstream`);
      assert.match(await page.locator('.panorama-detail h3').textContent(), /第 2 轮分析模型/);
      const downstream = page.locator('.panorama-dependencies').last().getByRole('button').first();
      await downstream.focus(); await page.keyboard.press('Enter');
      await assertFocusedVisible(`${width}/${view}/downstream`);
      assert.equal(await page.locator('.panorama-detail h3').textContent(), '最终答复');
      await page.keyboard.press('Home');
      await assertFocusedVisible(`${width}/${view}/Home`);
      await page.keyboard.press('ArrowDown');
      await assertFocusedVisible(`${width}/${view}/ArrowDown`);
      assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
      await page.screenshot({ path: join(output, `day06-focus-${width}-${view === '依赖图' ? 'graph' : 'list'}.png`), fullPage: false });
    }
  }
  assert.deepEqual({ model: h.requests.length, tool: h.fixtures.toolCalls.length }, callsBeforeNavigation);
  await page.getByRole('button', { name: '节点列表', exact: true }).click();
  checks.push('Desktop/320px graph and list dependency jumps, Home/End/arrows reveal focus and selection with reduced motion; no new model/tool calls.');
  await page.screenshot({ path: join(output, 'panorama-mobile.png'), fullPage: false });
  await page.keyboard.press('Escape');
  checks.push('Actual SDK live trace, two model calls and one tool, graph/list/keyboard, exact JSON and 320px');

  await page.setViewportSize({ width: 1280, height: 900 });
  await page.reload();
  await page.getByRole('button', { name: '查询计费状态并参考手册', exact: true }).click();
  await page.getByRole('button', { name: '打开问答全景', exact: true }).waitFor();
  assert.deepEqual(latest().metadata.executionTrace, trace);
  checks.push('Persisted history survives reload without replay');

  for (const mode of ['pending', 'blocked', 'error']) {
    scenario = mode;
    await page.getByRole('button', { name: '新建对话', exact: true }).click();
    if (mode === 'blocked') await page.getByRole('switch', { name: '独立复核', exact: true }).click();
    await send(`全景验收 ${mode}`);
    await page.waitForFunction(() => !document.querySelector('.chat-progress'));
    await page.getByRole('button', { name: '打开问答全景', exact: true }).waitFor();
    const snapshot = latest().metadata.executionTrace;
    assert.equal(snapshot.status, mode === 'pending' ? 'awaiting_approval' : mode);
    assert.ok(!JSON.stringify(snapshot).includes('PRIVATE_PROVIDER_FAILURE'));
    await page.getByRole('button', { name: '打开问答全景', exact: true }).click();
    if (mode === 'pending') assert.match(await page.locator('.panorama-detail').innerText(), /等待人工审批/);
    await page.screenshot({ path: join(output, `panorama-${mode}.png`), fullPage: false });
    await page.keyboard.press('Escape');
    checks.push(`${mode}: actual durable outcome shown without false completion`);
  }
  assert.deepEqual(errors, []);
  writeFileSync(join(output, 'browser-report.json'), JSON.stringify({ checkedAt: new Date().toISOString(), mode: 'local-fixture', checks, errors }, null, 2) + '\n');
  console.log(JSON.stringify({ checks, errors }));
} catch (error) {
  await page?.screenshot({ path: join(output, 'failure.png'), fullPage: false }).catch(() => {});
  throw error;
} finally { release(); await browser?.close(); await h.close(); }
