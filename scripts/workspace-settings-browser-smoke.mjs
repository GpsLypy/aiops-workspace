import { chromium } from 'playwright';
import express from 'express';
import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { listen } from '../tests/fixtures.mjs';

const output = resolve('test-results/workspace-settings-20261010');
mkdirSync(output, { recursive: true });
const observe = process.argv.includes('--observe-before');
const user = { id: 'settings-admin', username: 'settings-admin', name: '设置验收', role: 'admin', active: true };
const model = { configured: true, baseUrl: 'https://fixture.invalid/v1', model: 'fixture', hasApiKey: true,
  apiType: 'responses', model_reasoning_effort: 'medium', temperature: null, reasoningEffortOnly: true,
  timeoutSettingsEnabled: true, firstByteTimeoutSeconds: 90, streamIdleTimeoutSeconds: 180 };
let releaseModel, loadingModel, modelFailure = false;
let writes = 0;
function holdModel() { loadingModel = new Promise(resolve => { releaseModel = resolve; }); }
const app = express();
app.get('/api/auth/me', (_req, res) => res.json(user));
app.get('/api/resources', (_req, res) => res.json([]));
app.get('/api/conversations', (_req, res) => res.json(Array.from({ length: 30 }, (_, index) => ({ id: `c-${index}`, user_id: user.id, title: `历史巡检 ${index + 1}` }))));
app.get('/api/model/status', (_req, res) => res.json(model));
app.get('/api/settings/model', async (_req, res) => {
  if (loadingModel) await loadingModel;
  if (modelFailure) return res.status(503).json({ error: '配置读取暂时失败' });
  res.json(model);
});
app.get('/api/users', (_req, res) => res.json([user]));
app.get('/api/audit', (_req, res) => res.json([]));
app.use('/api', (req, res) => { if (req.method !== 'GET') writes++; res.status(400).json({ error: '只读设置夹具' }); });
app.use(express.static(resolve('dist')));
const http = await listen(app);
const browser = await chromium.launch({ headless: true });
const checks = [], measurements = [], errors = [];
try {
  const page = await browser.newPage({ viewport: { width: 1440, height: 960 } });
  page.on('pageerror', error => errors.push(error.message));
  await page.goto(http.url + '/#chat');
  const draft = page.getByRole('textbox', { name: '输入你的问题' });
  await draft.fill('打开设置时保留这个草稿');
  const opener = page.locator('.sidebar').getByRole('button', { name: '工作空间设置', exact: true });
  const dialog = page.getByRole('dialog', { name: '工作空间设置', exact: true });
  const stable = (before, after) => {
    for (const property of ['x', 'y', 'width', 'height']) assert.ok(Math.abs(before[property] - after[property]) <= 1, `${property}: ${before[property]} → ${after[property]}`);
  };
  const fits = async () => {
    const bounds = await dialog.boundingBox();
    assert.ok(bounds && bounds.x >= 0 && bounds.y >= 0 && bounds.x + bounds.width <= page.viewportSize().width && bounds.y + bounds.height <= page.viewportSize().height);
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
  };
  for (const viewport of [{ width: 1440, height: 960 }, { width: 844, height: 390 }, { width: 320, height: 568 }]) {
    await page.setViewportSize(viewport);
    holdModel();
    if (viewport.width <= 760) {
      await page.getByRole('button', { name: '打开导航', exact: true }).click();
      await page.getByRole('dialog', { name: '工作空间导航', exact: true }).getByRole('button', { name: '工作空间设置', exact: true }).click();
    } else await opener.click();
    await dialog.waitFor();
    const before = await dialog.boundingBox();
    if (!observe) await dialog.getByRole('status').filter({ hasText: '正在加载设置' }).waitFor();
    releaseModel(); loadingModel = null;
    await dialog.getByLabel('流式首字节超时', { exact: false }).waitFor();
    const after = await dialog.boundingBox();
    measurements.push({ viewport, before, after, shift: after.y - before.y });
    if (!observe) {
      stable(before, after); await fits();
      for (const name of ['我的账号', '用户管理', '审计日志', '模型服务']) {
        await dialog.getByRole('button', { name, exact: true }).click();
        stable(after, await dialog.boundingBox());
      }
      await dialog.getByLabel('流式静默超时', { exact: false }).waitFor();
      const close = dialog.getByRole('button', { name: '关闭弹窗', exact: true });
      await close.focus(); await page.keyboard.press('Shift+Tab');
      assert.equal(await dialog.getByRole('button', { name: '保存模型配置', exact: true }).evaluate(el => el === document.activeElement), true);
      await page.keyboard.press('Tab');
      assert.equal(await close.evaluate(el => el === document.activeElement), true);
      assert.equal(await close.evaluate(el => el.getBoundingClientRect().top >= 0), true);
      await page.screenshot({ path: join(output, `settings-${viewport.width}.png`) });
      checks.push(`${viewport.width}x${viewport.height}: stable loading/tab layout; visible header and close; keyboard loop; no overflow`);
    }
    await page.keyboard.press('Escape');
    assert.equal(await dialog.count(), 0);
    assert.equal(await draft.inputValue(), '打开设置时保留这个草稿');
    if (viewport.width > 760) assert.equal(await opener.evaluate(el => el === document.activeElement), true);
  }
  if (!observe) {
    await page.setViewportSize({ width: 1440, height: 960 });
    modelFailure = true; holdModel(); await opener.click();
    const before = await dialog.boundingBox(); releaseModel(); loadingModel = null;
    await dialog.getByRole('alert').waitFor(); stable(before, await dialog.boundingBox());
    await dialog.getByRole('button', { name: '关闭弹窗', exact: true }).click();
    modelFailure = false;
    for (let index = 0; index < 3; index++) {
      holdModel(); await opener.click(); await dialog.waitFor();
      await page.keyboard.press('Escape'); releaseModel(); loadingModel = null;
    }
    await opener.click(); await dialog.getByLabel('流式首字节超时', { exact: false }).waitFor();
    assert.equal(await dialog.getByRole('alert').count(), 0);
    await page.keyboard.press('Escape');
    checks.push('failed load retains geometry; closing during fetch and reopening; draft/focus preserved');
  }
  assert.deepEqual(errors, []); assert.equal(writes, 0);
  const report = { mode: observe ? 'before fix' : 'after fix', measurements, checks, errors, writes, modelCalls: 0 };
  writeFileSync(join(output, observe ? 'before.json' : 'report.json'), JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report));
} finally { releaseModel?.(); await browser.close(); await http.close(); }
