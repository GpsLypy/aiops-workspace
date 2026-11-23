import { chromium } from 'playwright';
import express from 'express';
import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { listen } from '../tests/fixtures.mjs';

const output = resolve('test-results/chat-design-20261010');
mkdirSync(output, { recursive: true });
const user = { id: 'design-member', username: 'design-member', name: '运维同学', role: 'member', active: true };
const resources = [{ id: 'ops', kind: 'agents', name: '运维分析', description: '整理已获授权的运维知识与排障思路。', status: '已启用', skillIds: [], mcpIds: [], knowledgeIds: [] }];
const answer = '## 先确认影响范围\n\n把现象、开始时间和最近变更放在一起看。先确认是单个任务变慢，还是整个服务的延迟同时上升。\n\n- 对比最近一次正常运行的状态。\n- 记录错误码和时间，不把重试次数当作原因。\n- 核对数据来源，再决定下一步。\n\n```text\n检查连接 → 确认范围 → 读取状态 → 对照证据\n```\n\n这些是排查建议；当前示例没有查询实时服务。';
const history = { id: 'history', user_id: user.id, title: '数据传输延迟的排查思路', agent_id: 'ops', messages: [
  { seq: 1, role: 'user', content: '数据传输任务的延迟突然升高，我应该从哪里开始排查？', metadata: {}, created: '2026-10-10T02:00:00Z' },
  { seq: 2, role: 'assistant', content: answer, metadata: { model: '界面预览', model_reasoning_effort: 'medium', sources: [{ title: '排障手册（示例）' }] }, created: '2026-10-10T02:00:01Z' },
] };
const long = { ...history, id: 'long', title: '多轮排障记录', messages: Array.from({ length: 12 }, (_, i) => ({ ...history.messages[i % 2], seq: i + 1 })) };
const conversations = [history, long, ...Array.from({ length: 32 }, (_, i) => ({ id: `c-${i}`, user_id: user.id, title: `历史巡检记录 ${i + 1}`, agent_id: '' })), { id: 'other', user_id: 'someone-else', title: '其他用户的私有记录' }];
const previewDocument = { path: 'docs/README.md', title: '界面预览说明', group: '开始使用', content: '# 界面预览\n\n这里使用只读样例展示聊天界面。可以查看会话、选择问答选项和编辑草稿；真实问答请在工作空间中进行。', revision: 'preview', updatedAt: '2026-10-10T02:00:00Z', size: 200 };
const app = express(); let mutations = 0;
app.use('/api', (req, res) => {
  if (req.method !== 'GET') { mutations++; return res.status(400).json({ error: '当前为只读界面预览，请在工作空间内发送消息' }); }
  if (req.path === '/auth/me') return res.json(user);
  if (req.path === '/resources') return res.json(resources);
  if (req.path === '/conversations') return res.json(conversations);
  if (req.path === '/conversations/history') return res.json(history);
  if (req.path === '/conversations/long') return res.json(long);
  if (req.path === '/documents') return res.json({ documents: [previewDocument], canEdit: false });
  if (req.path === '/documents/content') return res.json(previewDocument);
  if (req.path === '/model/status') return res.json({ configured: true, model: '界面预览', model_reasoning_effort: 'medium' });
  return res.json({});
});
app.use(express.static(resolve('dist')));
const previewPort = process.argv.includes('--preview') ? Number(process.env.CHAT_DESIGN_PREVIEW_PORT || 0) : 0;
assert.ok(Number.isInteger(previewPort) && previewPort >= 0 && previewPort <= 65535);
const http = previewPort ? await new Promise((resolve, reject) => {
  const server = app.listen(previewPort, '127.0.0.1', () => resolve({ url: `http://127.0.0.1:${previewPort}` }));
  server.once('error', reject);
}) : await listen(app);
if (process.argv.includes('--preview')) {
  console.log(`Chat design preview: ${http.url}/#chat (read-only sample conversations)`);
  await new Promise(() => {});
}
const browser = await chromium.launch({ headless: true, ...(process.env.PLAYWRIGHT_CHANNEL ? { channel: process.env.PLAYWRIGHT_CHANNEL } : {}) });
const checks = [], errors = [], external = [];
try {
  const page = await browser.newPage({ viewport: { width: 1440, height: 960 } });
  page.on('pageerror', error => errors.push(error.message));
  page.on('request', request => { if (!request.url().startsWith(http.url)) external.push(request.url()); });
  const input = () => page.getByRole('textbox', { name: '输入你的问题' });
  const screenshot = name => page.screenshot({ path: join(output, name + '.png'), fullPage: true });
  const fits = async () => {
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
    for (const locator of [input(), page.getByRole('button', { name: '发送消息', exact: true })]) {
      const rect = await locator.boundingBox();
      assert.ok(rect && rect.x >= 0 && rect.y >= 0 && rect.x + rect.width <= page.viewportSize().width && rect.y + rect.height <= page.viewportSize().height);
    }
  };
  await page.goto(http.url + '/#chat'); await input().waitFor();
  await page.getByRole('button', { name: history.title, exact: true }).waitFor();
  assert.equal(await page.locator('.window-bar').count(), 0);
  assert.equal(await page.locator('.customize-card').count(), 0);
  assert.equal(await page.getByRole('button', { name: '其他用户的私有记录', exact: true }).count(), 0);
  await fits(); await screenshot('desktop-welcome');
  await page.getByRole('button', { name: '帮我梳理排障思路', exact: true }).click();
  assert.equal(await input().inputValue(), '帮我梳理排障思路');
  assert.equal(await input().evaluate(el => document.activeElement === el), true);
  checks.push('compact branded welcome; prompt fills and focuses draft; own recent summaries only');

  await page.getByRole('button', { name: '查找对话', exact: true }).click();
  const search = page.getByRole('textbox', { name: '查找最近对话' });
  assert.equal(await search.evaluate(el => document.activeElement === el), true);
  await search.fill('数据传输'); assert.equal(await page.locator('.recent-chat').count(), 1);
  await search.fill('不存在'); await page.getByText('没有匹配的对话', { exact: true }).waitFor();
  await page.keyboard.press('Escape'); assert.equal(await search.count(), 0);
  assert.equal(await page.getByRole('button', { name: '查找对话', exact: true }).evaluate(el => document.activeElement === el), true);
  assert.equal(await input().inputValue(), '帮我梳理排障思路');
  await page.getByRole('button', { name: '收起侧边栏', exact: true }).click();
  await fits(); await page.getByRole('button', { name: '展开侧边栏', exact: true }).click();
  assert.equal(await input().inputValue(), '帮我梳理排障思路');
  checks.push('conversation search/empty result/Escape; sidebar collapse and expand retain draft');

  await input().fill('第一行'); await input().press('Shift+Enter');
  assert.equal(await input().inputValue(), '第一行\n');
  await input().fill('多行草稿\n'.repeat(25));
  const height = await input().evaluate(el => ({ height: el.clientHeight, scroll: el.scrollHeight }));
  assert.ok(height.height <= 160 && height.scroll > height.height);
  const knowledge = page.getByRole('switch', { name: '启用知识检索' });
  await knowledge.click(); assert.equal(await knowledge.getAttribute('aria-checked'), 'false');
  await knowledge.press('Space'); assert.equal(await knowledge.getAttribute('aria-checked'), 'true');
  const review = page.getByRole('switch', { name: '独立复核', exact: true });
  await review.press('Space'); assert.equal(await review.getAttribute('aria-checked'), 'true');
  assert.match(await review.getAttribute('aria-describedby'), /independent-review-help/);
  await page.locator('input[type=file]').setInputFiles({ name: 'incident.txt', mimeType: 'text/plain', buffer: Buffer.from('测试附件，没有实时数据。') });
  await page.locator('.attachment').filter({ hasText: 'incident.txt' }).waitFor();
  await page.getByRole('button', { name: '移除附件', exact: true }).click();
  assert.equal(await page.locator('.attachment').count(), 0);
  checks.push('bounded multiline draft/Shift+Enter; keyboard switches; attachment add/remove without submission');

  await page.getByRole('button', { name: history.title, exact: true }).click();
  await page.locator('.message.assistant').waitFor();
  assert.equal(await page.locator('.header-title strong').innerText(), history.title);
  assert.equal(await page.getByRole('button', { name: 'Agent', exact: true }).isDisabled(), true);
  assert.equal(await page.locator('.message.user .message-avatar').isVisible(), false);
  assert.equal(await page.locator('.message.assistant .markdown-preview').evaluate(el => getComputedStyle(el).fontSize), '15px');
  await screenshot('desktop-conversation');
  await page.getByRole('button', { name: long.title, exact: true }).click();
  await page.waitForFunction(() => document.querySelectorAll('.message').length === 12);
  await page.locator('.messages').evaluate(box => { box.scrollTop = 0; box.dispatchEvent(new Event('scroll')); });
  await page.getByRole('button', { name: '返回最新消息', exact: true }).focus();
  await page.keyboard.press('Enter');
  assert.equal(await page.locator('.messages').evaluate(box => box === document.activeElement), true);
  assert.equal(await page.locator('.messages').evaluate(box => box.scrollHeight - box.clientHeight - box.scrollTop < 2), true);
  assert.equal(await page.getByRole('button', { name: '返回最新消息', exact: true }).count(), 0);
  checks.push('right aligned question/unboxed answer; selected title and Agent lock; return latest restores scroll');

  for (const viewport of [{ width: 320, height: 568 }, { width: 390, height: 844 }, { width: 844, height: 390 }]) {
    await page.setViewportSize(viewport);
    if (viewport.width <= 760) {
      await page.getByRole('button', { name: '打开导航', exact: true }).click();
      const dialog = page.getByRole('dialog');
      await dialog.getByRole('button', { name: '新建对话', exact: true }).click();
    } else await page.getByRole('button', { name: '新建对话', exact: true }).click();
    await input().fill('窄屏草稿'); await fits();
    await screenshot(`welcome-${viewport.width}x${viewport.height}`);
    await page.getByRole('button', { name: 'Agent', exact: true }).click();
    const menu = page.getByRole('listbox', { name: '选择 Agent' });
    const rect = await menu.boundingBox();
    assert.ok(rect && rect.x >= 0 && rect.y >= 0 && rect.x + rect.width <= viewport.width && rect.y + rect.height <= viewport.height);
    await page.keyboard.press('Escape');
    if (viewport.width <= 760) {
      await page.getByRole('button', { name: '打开导航', exact: true }).click();
      await page.keyboard.press('Escape');
      assert.equal(await input().inputValue(), '窄屏草稿');
      assert.equal(await page.getByRole('button', { name: '打开导航', exact: true }).evaluate(el => document.activeElement === el), true);
      await page.getByRole('button', { name: '打开导航', exact: true }).click();
      await page.getByRole('dialog').getByRole('button', { name: history.title, exact: true }).click();
    } else await page.getByRole('button', { name: history.title, exact: true }).click();
    await page.locator('.message.assistant').waitFor(); await fits(); await screenshot(`conversation-${viewport.width}x${viewport.height}`);
  }
  checks.push('320x568, 390x844 and short landscape; menus within viewport; mobile drawer preserves draft/focus');

  await page.emulateMedia({ reducedMotion: 'reduce' });
  await page.setViewportSize({ width: 1440, height: 960 });
  await page.getByRole('button', { name: '项目文档', exact: true }).click();
  await page.getByRole('region', { name: '项目文档中心', exact: true }).waitFor();
  await page.locator('.document-card').filter({ hasText: '界面预览说明' }).click();
  await page.getByRole('heading', { name: '界面预览', exact: true }).waitFor();
  await page.getByRole('button', { name: '返回前台', exact: true }).click();
  await page.getByRole('navigation', { name: '对话导航', exact: true }).getByRole('button', { name: 'AgentScope 入门', exact: true }).click();
  await page.getByRole('region', { name: 'AgentScope 使用与开发引导', exact: true }).waitFor();
  await page.getByRole('button', { name: '返回前台', exact: true }).click();
  await page.getByRole('button', { name: '进入后台', exact: true }).click();
  await page.waitForFunction(() => location.hash === '#knowledge');
  assert.equal(await page.locator('.chat-workspace').count(), 0);
  assert.equal(await page.locator('.window-bar').isVisible(), true);
  await page.getByRole('button', { name: '返回前台', exact: true }).click();
  await page.reload(); await input().waitFor();
  await page.getByRole('button', { name: history.title, exact: true }).click();
  await page.locator('.message.assistant').waitFor();
  assert.deepEqual(errors, []); assert.deepEqual(external, []); assert.equal(mutations, 0);
  checks.push('management navigation/history reload/reduced motion; zero mutations, external requests or page errors');
  writeFileSync(join(output, 'report.json'), JSON.stringify({ checkedAt: new Date().toISOString(), mode: 'read-only local interface fixture', checks, errors, mutations, externalRequests: external }, null, 2));
  console.log(JSON.stringify({ checks, errors, mutations, externalRequests: external }));
} finally { await browser.close(); await http.close(); }
