import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { chromium } from 'playwright';
import { createApplication } from '../server/app.mjs';
import { listen } from '../tests/fixtures.mjs';

// Run after npm run build. This is a separate temporary workspace: no .env,
// production database, saved model, MCP connection or actual Agent execution.
const output = resolve('test-results/learning');
mkdirSync(output, { recursive: true });
assert.ok(existsSync(resolve('dist/index.html')), 'Run npm run build before the learning browser smoke test.');
const root = mkdtempSync(join(tmpdir(), 'aiops-learning-browser-'));
const checks = [], errors = [], consoleErrors = [], requests = [], externalRequests = [];
const lessonTitles = [
  '从一次问答理解 Agent', '给模型什么，不给什么', '把工具接入与权限分开',
  '失败之后，敢不敢重试', '让第二个 Agent 做独立复核', '用证据讲清 Agent 做得怎样',
];
const expectedCommands = [
  'node --test tests/agentscope/runtime.test.mjs',
  'node --test tests/agent-enhancements.test.mjs',
  'node --test tests/security.test.mjs tests/agentscope/runtime.test.mjs',
  'node --test tests/execution.test.mjs',
  'node --test tests/agent-review.test.mjs tests/chat-stream.test.mjs',
  'node --test tests/agent-trace.test.mjs\nnpm run agent:eval',
];
let app, http, browser, page, failure;
try {
  app = createApplication({ dataDir: root, scheduler: false });
  http = await listen(app.app);
  browser = await chromium.launch({ headless: true, ...(process.env.PLAYWRIGHT_CHANNEL ? { channel: process.env.PLAYWRIGHT_CHANNEL } : {}) });
  const context = await browser.newContext({ viewport: { width: 1365, height: 1000 }, permissions: ['clipboard-read', 'clipboard-write'] });
  page = await context.newPage();
  page.setDefaultTimeout(15000);
  page.on('pageerror', error => errors.push(error.message));
  page.on('console', message => { if (message.type() === 'error') consoleErrors.push(message.text()); });
  page.on('request', request => {
    const url = new URL(request.url());
    if (url.origin === http.url && url.pathname.startsWith('/api')) requests.push({ method: request.method(), path: url.pathname });
    else if (/^https?:$/.test(url.protocol) && url.origin !== http.url) externalRequests.push(request.url());
  });
  const setup = await page.request.post(http.url + '/api/auth/setup', { data: { username: 'learning-admin', password: 'learning-browser-fixture-only' } });
  assert.equal(setup.ok(), true, await setup.text());
  await page.goto(http.url + '/#guide');
  const guide = page.getByRole('region', { name: 'AgentScope 使用与开发引导' });
  await guide.waitFor();
  const entry = guide.getByRole('button', { name: '学习与面试', exact: true });
  await entry.focus();
  await page.keyboard.press('Enter');
  const courses = page.getByRole('navigation', { name: '课程目录' });
  const courseButtons = courses.getByRole('button');
  const title = page.locator('#learning-title');
  const notes = page.getByRole('textbox', { name: '记录你实际运行的结果、还解释不清的地方，以及面试时会用的例子。', exact: true });
  const assessment = page.getByRole('combobox', { name: '本课自评', exact: true });
  const details = page.locator('.learning-interview details');
  const command = page.getByLabel('本课实验命令', { exact: true });
  const status = page.locator('.learning-feedback');
  await courses.waitFor();
  assert.equal(await courseButtons.count(), 6);
  assert.equal(await entry.getAttribute('aria-pressed'), 'true');
  assert.equal(await page.getByRole('button', { name: '上一课', exact: true }).isDisabled(), true);
  assert.match(await page.getByRole('complementary', { name: '学习路径' }).innerText(), /切换上方视图、离开页面或刷新后会丢失/);
  checks.push('Guide learning entry is keyboard reachable and presents six courses with the temporary-notes boundary.');

  const selectCourse = async index => {
    await courseButtons.nth(index).focus();
    await page.keyboard.press('Enter');
    await page.waitForFunction(expected => document.querySelector('#learning-title')?.textContent === expected && document.activeElement?.id === 'learning-title', lessonTitles[index]);
    assert.equal(await courseButtons.nth(index).getAttribute('aria-pressed'), 'true');
    assert.equal(await courses.locator('button[aria-pressed="true"]').count(), 1);
  };
  const noOverflow = async label => {
    const dimensions = await page.evaluate(() => ({ scroll: document.documentElement.scrollWidth, viewport: innerWidth }));
    assert.ok(dimensions.scroll <= dimensions.viewport, `${label}: ${dimensions.scroll}px exceeds ${dimensions.viewport}px`);
  };
  const saveViewport = async filename => {
    await page.evaluate(() => window.scrollTo(0, 0));
    await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
    await page.screenshot({ path: join(output, filename), fullPage: false });
  };

  for (let index = 0; index < lessonTitles.length; index++) {
    if (index) await selectCourse(index);
    assert.equal(await title.innerText(), lessonTitles[index]);
    assert.equal(await command.innerText(), expectedCommands[index]);
    assert.equal(await details.getAttribute('open'), null, `Course ${index + 1} answer must initially be closed`);
    assert.equal(await details.locator('ol').isVisible(), false);
    for (const source of await page.locator('.learning-sources dt code').allTextContents()) {
      assert.ok(existsSync(resolve(source)), `Referenced source exists: ${source}`);
    }
    await details.locator('summary').focus();
    await page.keyboard.press('Enter');
    assert.equal(await details.locator('ol').isVisible(), true);
    assert.ok((await details.locator('li').count()) >= 2);
    await page.setViewportSize({ width: 320, height: 568 });
    await noOverflow(`Course ${index + 1}, expanded answer at 320px`);
    await page.setViewportSize({ width: 1365, height: 1000 });
  }
  assert.equal(await page.getByRole('button', { name: '下一课', exact: true }).isDisabled(), true);
  await selectCourse(0);
  assert.equal(await details.getAttribute('open'), null, 'Returning to a course resets its reference answer');
  checks.push('All six source paths and experiment commands exist; answers open by keyboard, reset on course changes, and fit at 320px.');

  const firstNotes = '我的解释：AgentScope 负责编排，Node 负责执行治理。\n实验观察：尚未运行，不把自评当测试通过。';
  const secondNotes = '待复习：FTS5 候选、中文二元词与完整轮次裁剪。\n边界：字节不等于精确 token。';
  await notes.fill(firstNotes);
  await assessment.selectOption('能讲清原理');
  await page.getByRole('button', { name: '下一课', exact: true }).focus();
  await page.keyboard.press('Enter');
  await page.waitForFunction(() => document.activeElement?.id === 'learning-title');
  assert.equal(await title.innerText(), lessonTitles[1]);
  assert.equal(await notes.inputValue(), '');
  assert.equal(await assessment.inputValue(), '未自评');
  await notes.fill(secondNotes);
  await assessment.selectOption('需要提示');
  assert.equal(await assessment.inputValue(), '需要提示');
  await page.getByRole('button', { name: '上一课', exact: true }).click();
  assert.equal(await notes.inputValue(), firstNotes);
  assert.equal(await assessment.inputValue(), '能讲清原理');
  assert.match(await page.locator('.learning-notebook').innerText(), /2 \/ 6/);
  checks.push('Next/previous navigation keeps independent notes and self-assessments per course, with focus moved to the lesson heading.');

  for (const index of [0, 5]) {
    await selectCourse(index);
    await page.getByRole('button', { name: '复制命令', exact: true }).click();
    await status.filter({ hasText: '已复制实验命令' }).waitFor();
    assert.equal(await page.evaluate(() => navigator.clipboard.readText()), expectedCommands[index]);
  }
  const downloadEvent = page.waitForEvent('download');
  await page.getByRole('button', { name: '导出学习笔记', exact: true }).click();
  const download = await downloadEvent;
  assert.equal(download.suggestedFilename(), 'agent-learning-notes.md');
  const notesPath = join(output, download.suggestedFilename());
  await download.saveAs(notesPath);
  const exported = readFileSync(notesPath, 'utf8');
  assert.match(exported, /^# Agent 学习与面试笔记\n/);
  assert.equal((exported.match(/^## \d\. /gm) || []).length, 6);
  assert.ok(exported.includes(firstNotes) && exported.includes(secondNotes));
  for (const item of expectedCommands) assert.ok(exported.includes(item));
  assert.equal((exported.match(/^自评：能讲清原理$/gm) || []).length, 1);
  assert.equal((exported.match(/^自评：需要提示$/gm) || []).length, 1);
  assert.equal((exported.match(/^自评：未自评$/gm) || []).length, 4);
  assert.match(exported, /不代表测试已执行或技能已通过评测/);
  checks.push('Single/multiline command clipboard contents match exactly; Markdown export includes six courses and exact separate notes and assessments.');

  // Hold clipboard completion to reproduce permission prompts and out-of-order results.
  await page.evaluate(() => {
    const fixture = { original: navigator.clipboard.writeText, pending: [] };
    window.learningClipboardFixture = fixture;
    navigator.clipboard.writeText = text => new Promise((resolve, reject) => fixture.pending.push({ text, resolve, reject }));
  });
  const beginCopy = async () => {
    const index = await page.evaluate(() => window.learningClipboardFixture.pending.length);
    await page.getByRole('button', { name: '复制命令', exact: true }).focus();
    await page.keyboard.press('Enter');
    await page.waitForFunction(expected => window.learningClipboardFixture.pending.length === expected, index + 1);
    assert.equal(await page.evaluate(index => window.learningClipboardFixture.pending[index].text, index), await command.innerText());
    return index;
  };
  const settleCopy = async (index, outcome) => {
    await page.evaluate(async ({ index, outcome }) => {
      const pending = window.learningClipboardFixture.pending[index];
      if (outcome === 'success') pending.resolve();
      else pending.reject(new DOMException('Clipboard permission denied for browser fixture', 'NotAllowedError'));
      await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
    }, { index, outcome });
  };

  for (const outcome of ['success', 'failure']) {
    await selectCourse(0);
    const pending = await beginCopy();
    await selectCourse(1);
    await settleCopy(pending, outcome);
    assert.equal(await status.textContent(), '', `A previous course's delayed ${outcome} must not appear in the selected course`);
    assert.equal(await title.innerText(), lessonTitles[1]);
    assert.equal(await title.evaluate(element => document.activeElement === element), true);
  }
  const rejected = await beginCopy();
  await settleCopy(rejected, 'failure');
  assert.equal(await status.textContent(), '浏览器未允许复制，请选中命令后手动复制。');
  const accepted = await beginCopy();
  await settleCopy(accepted, 'success');
  assert.equal(await status.textContent(), '已复制实验命令；请在仓库根目录手动运行。');

  const superseded = await beginCopy();
  const current = await beginCopy();
  await settleCopy(current, 'success');
  await settleCopy(superseded, 'failure');
  assert.equal(await status.textContent(), '已复制实验命令；请在仓库根目录手动运行。', 'An older copy must not replace a newer copy result');
  for (const outcome of ['success', 'failure']) {
    const pending = await beginCopy();
    const exportedAgain = page.waitForEvent('download');
    await page.getByRole('button', { name: '导出学习笔记', exact: true }).click();
    await exportedAgain;
    await settleCopy(pending, outcome);
    assert.equal(await status.textContent(), '已导出 6 课的自评、笔记与复现命令。', `An earlier copy's ${outcome} must not replace the newer export feedback`);
  }
  checks.push('Delayed copy success/failure cannot cross courses or replace a newer copy/export; current-course success and permission-denied feedback remain available, with keyboard focus preserved.');

  await selectCourse(0);
  await saveViewport('learning-desktop.png');
  await page.setViewportSize({ width: 320, height: 568 });
  await noOverflow('Learning course index at 320px');
  await saveViewport('learning-mobile-index.png');
  await title.scrollIntoViewIfNeeded();
  await page.screenshot({ path: join(output, 'learning-mobile-lesson.png'), fullPage: false });
  await notes.scrollIntoViewIfNeeded();
  await noOverflow('Learning reflection at 320px');
  await page.screenshot({ path: join(output, 'learning-mobile-notes.png'), fullPage: false });
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await selectCourse(5);
  await noOverflow('Reduced motion at 320px');
  await page.setViewportSize({ width: 1365, height: 1000 });
  checks.push('Desktop and 320px screenshots saved; course index, lesson and reflection fit the viewport, including reduced-motion navigation.');

  const unmountedCopy = await beginCopy();
  await page.getByRole('button', { name: '开发与边界', exact: true }).click();
  await entry.click();
  await settleCopy(unmountedCopy, 'success');
  assert.equal(await status.textContent(), '', 'A copy from an unmounted learning view must not reach the new view');
  await page.evaluate(() => {
    navigator.clipboard.writeText = window.learningClipboardFixture.original;
    delete window.learningClipboardFixture;
  });
  assert.equal(await notes.inputValue(), '');
  assert.equal(await assessment.inputValue(), '未自评');
  await notes.fill('视图是暂存状态；刷新应清除。');
  await page.reload();
  await entry.click();
  assert.equal(await notes.inputValue(), '');
  assert.equal(await assessment.inputValue(), '未自评');
  await notes.fill('离开引导前需要导出。');
  await page.goto(http.url + '/#chat');
  await page.getByRole('textbox', { name: '输入你的问题', exact: true }).waitFor();
  await page.goto(http.url + '/#guide');
  await entry.click();
  assert.equal(await notes.inputValue(), '');
  checks.push('Top-view switch, reload and leaving the page clear temporary notes as the UI states; notes are never presented as durable storage.');

  assert.equal(app.store.get('SELECT COUNT(*) AS count FROM executions').count, 0);
  assert.equal(app.store.get('SELECT COUNT(*) AS count FROM tool_steps').count, 0);
  assert.deepEqual(requests.filter(request => request.method !== 'GET'), []);
  assert.deepEqual(externalRequests, []);
  assert.deepEqual(errors, []);
  assert.deepEqual(consoleErrors, []);
  checks.push('No Agent run, tool step, browser API mutation, external request, page error or console error during learning.');
} catch (error) {
  failure = error;
  try { await page?.screenshot({ path: join(output, 'failure.png'), fullPage: false }); } catch {}
} finally {
  writeFileSync(join(output, 'browser-report.json'), JSON.stringify({
    checkedAt: new Date().toISOString(), mode: 'temporary-app-no-provider', status: failure ? 'failed' : 'passed',
    checks, errors, consoleErrors, externalRequests, ...(failure ? { failure: String(failure.stack || failure) } : {}),
  }, null, 2) + '\n');
  await browser?.close();
  await http?.close();
  await app?.close();
  rmSync(root, { recursive: true, force: true });
}
if (failure) throw failure;
console.log(JSON.stringify({ checks, errors, consoleErrors, output }, null, 2));
