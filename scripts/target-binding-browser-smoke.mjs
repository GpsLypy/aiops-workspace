import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { chromium } from 'playwright';
import { createApplication } from '../server/app.mjs';
import { listen, startFixtures } from '../tests/fixtures.mjs';

const dataDir = mkdtempSync(join(tmpdir(), 'aiops-target-browser-'));
const outputDir = resolve('test-results/target-binding');
mkdirSync(outputDir, { recursive: true });
const fixture = await startFixtures();
const application = createApplication({ dataDir, scheduler: false });
const http = await listen(application.app);
const browser = await chromium.launch({ headless: true, ...(process.env.PLAYWRIGHT_CHANNEL ? { channel: process.env.PLAYWRIGHT_CHANNEL } : {}) });
const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
const errors = [];
page.on('pageerror', error => errors.push(error.message));

try {
  await page.goto(http.url);
  await page.locator('input[name=username]').fill('target-admin');
  await page.locator('input[name=name]').fill('目标验收管理员');
  await page.locator('input[name=password]').fill('target-browser-test-only');
  await page.getByRole('button', { name: '创建管理员并进入' }).click();
  await page.getByRole('button', { name: '执行与审批', exact: true }).waitFor();
  const model = await page.request.put(`${http.url}/api/settings/model`, { data: {
    baseUrl: `${fixture.url}/v1`, model: 'target-browser-fixture', apiType: 'responses', temperature: null,
  } });
  assert.equal(model.status(), 200, await model.text());
  const createdResource = await page.request.post(`${http.url}/api/resources`, { data: {
    kind: 'mcp', name: '目标验收服务', endpoint: `${fixture.url}/mcp`, token: 'fixture-mcp-secret', environment: 'production',
    allowedTools: ['service_status'], toolPolicies: { service_status: {
      risk: 'read', roles: ['admin'], environments: ['production'], constraints: { service: ['billing', 'inventory'] },
      requiredTargetFields: ['service'], maxItems: 1,
    } },
  } });
  assert.equal(createdResource.status(), 201, await createdResource.text());
  const resource = await createdResource.json();
  const createdAgent = await page.request.post(`${http.url}/api/resources`, { data: {
    kind: 'agents', name: '目标验收 Agent', body: '仅查询已确认服务的当前状态。', mcpIds: [resource.id],
  } });
  assert.equal(createdAgent.status(), 201, await createdAgent.text());
  const agent = await createdAgent.json();

  await page.goto(`${http.url}/#chat`);
  await page.reload();
  const binding = page.locator('.chat-page .target-binding-control');
  await binding.locator('summary').waitFor();
  await binding.locator('summary').click();
  await binding.getByLabel('服务').selectOption('0');
  await binding.getByRole('button', { name: '确认目标' }).click();
  await binding.getByText('已确认').waitFor();
  await page.getByRole('button', { name: 'Agent', exact: true }).click();
    await page.locator(`.agent-menu [role=option][data-agent-id="${agent.id}"]`).click();
  await binding.getByText('未确认').waitFor();
  await binding.locator('summary').click();
  await binding.getByLabel('服务').selectOption('1');
  await binding.getByRole('button', { name: '确认目标' }).click();
  await page.screenshot({ path: join(outputDir, 'chat-confirmed-desktop.png') });

  await page.setViewportSize({ width: 320, height: 568 });
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
  const composer = await page.locator('.composer').boundingBox();
  assert.ok(composer && composer.y >= 79 && composer.y + composer.height <= 568, 'expanded target keeps composer visible at 320px');
  const confirmButton = await binding.getByRole('button', { name: '确认目标', exact: true }).boundingBox();
  assert.ok(confirmButton && confirmButton.y + confirmButton.height <= composer.y, 'target confirmation remains visible above composer');
  await page.screenshot({ path: join(outputDir, 'chat-confirmed-320.png') });
  await page.getByRole('textbox', { name: '输入你的问题' }).fill('调用工具');
  await page.getByRole('button', { name: '发送消息' }).click();
  await page.locator('.composer-wrap .inline-error').filter({ hasText: '目标不一致' }).waitFor();
  assert.equal(fixture.toolCalls.length, 0, 'authorized but unconfirmed model target must not reach MCP');

  if (!(await binding.evaluate(element => element.open))) await binding.locator('summary').click();
  await binding.getByLabel('服务').selectOption('0');
  await binding.getByRole('button', { name: '确认目标' }).click();
  await page.getByRole('textbox', { name: '输入你的问题' }).fill('调用工具');
  await page.getByRole('button', { name: '发送消息' }).click();
  await page.getByText('工具结果：', { exact: false }).waitFor();
  assert.deepEqual(fixture.toolCalls.map(call => call.service), ['billing']);

  const dtsResponse = await page.request.post(`${http.url}/api/resources`, { data: {
    kind: 'mcp', name: 'DTS 目标验收服务', endpoint: `${fixture.url}/mcp`, token: 'fixture-mcp-secret', environment: 'production',
    allowedTools: ['dts_get_job_status'], toolPolicies: { dts_get_job_status: {
      risk: 'read', roles: ['admin'], environments: ['production'],
      constraints: { business_domain: ['general'], area_name: ['cn_east'] },
      requiredTargetFields: ['jobid', 'business_domain', 'area_name'], maxItems: 1,
    } },
  } });
  assert.equal(dtsResponse.status(), 201, await dtsResponse.text());
  const dtsResource = await dtsResponse.json();

  // Reproduce the three-field chat panel with a single DTS tool, including empty confirmation.
  const dtsAgentResponse = await page.request.post(`${http.url}/api/resources`, { data: {
    kind: 'agents', name: 'DTS 表单验收 Agent', body: '仅查询已确认任务。', mcpIds: [dtsResource.id],
  } });
  assert.equal(dtsAgentResponse.status(), 201, await dtsAgentResponse.text());
  const dtsAgent = await dtsAgentResponse.json();
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.reload();
  await page.getByRole('button', { name: 'Agent', exact: true }).click();
  await page.locator(`.agent-menu [role=option][data-agent-id="${dtsAgent.id}"]`).click();
  await binding.locator('summary').focus();
  await page.keyboard.press('Enter');
  assert.equal(await binding.evaluate(element => element.open), true, 'keyboard opens target panel');
  await binding.getByRole('button', { name: '确认目标', exact: true }).click();
  await binding.getByRole('alert').filter({ hasText: '请填写任务 ID' }).waitFor();
  const jobInput = binding.getByLabel('任务 ID');
  assert.equal(await jobInput.getAttribute('aria-invalid'), 'true');
  assert.equal(await jobInput.evaluate(element => element === document.activeElement), true, 'missing field receives focus');
  await page.screenshot({ path: join(outputDir, 'chat-dts-error-desktop.png') });
  await binding.screenshot({ path: join(outputDir, 'chat-dts-panel-desktop.png') });
  await jobInput.fill('9007199254740993');
  assert.equal(await binding.getByRole('alert').count(), 0);
  await binding.getByRole('button', { name: '确认目标', exact: true }).click();
  await binding.getByText('已确认', { exact: true }).waitFor();
  await page.screenshot({ path: join(outputDir, 'chat-dts-confirmed-desktop.png') });
  await binding.screenshot({ path: join(outputDir, 'chat-dts-panel-confirmed-desktop.png') });
  await page.setViewportSize({ width: 320, height: 568 });
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
  const dtsComposer = await page.locator('.composer').boundingBox();
  const dtsConfirm = await binding.getByRole('button', { name: '确认目标', exact: true }).boundingBox();
  assert.ok(dtsComposer && dtsComposer.y + dtsComposer.height <= 568, 'DTS form keeps composer visible');
  assert.ok(dtsConfirm && dtsConfirm.y + dtsConfirm.height <= dtsComposer.y, 'DTS confirmation remains above composer');
  await page.screenshot({ path: join(outputDir, 'chat-dts-confirmed-320.png') });
  await binding.getByRole('button', { name: '清除已确认目标' }).click();
  await binding.getByText('未确认', { exact: true }).waitFor();
  await jobInput.fill('');
  await binding.getByRole('button', { name: '确认目标', exact: true }).click();
  await binding.getByRole('alert').waitFor();
  await page.screenshot({ path: join(outputDir, 'chat-dts-error-320.png') });

  const legacyTask = await page.request.post(`${http.url}/api/tasks`, { data: {
    name: '待补配目标任务', prompt: '查询 billing', scheduleType: 'once', runAt: new Date(Date.now() + 60000).toISOString(),
  } });
  assert.equal(legacyTask.status(), 201, await legacyTask.text());
  const task = await legacyTask.json();
  assert.equal(task.targetBinding, null);
  await page.goto(`${http.url}/#tasks`);
  await page.reload();
  const row = page.getByRole('row').filter({ hasText: '待补配目标任务' });
  await row.getByText('未确认目标', { exact: false }).waitFor();
  await row.getByRole('button', { name: '查询目标' }).click();
  const dialog = page.getByRole('dialog', { name: /查询目标 · 待补配目标任务/ });
  const taskBinding = dialog.locator('.target-binding-control');
  await taskBinding.locator('summary').click();
  await taskBinding.getByLabel('目标查询工具').selectOption(JSON.stringify([resource.id, 'service_status']));
  await taskBinding.getByLabel('服务').selectOption('0');
  await taskBinding.getByRole('button', { name: '确认目标' }).click();
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
  await page.screenshot({ path: join(outputDir, 'task-target-320.png') });
  await dialog.getByRole('button', { name: '保存查询目标' }).click();
  await dialog.waitFor({ state: 'hidden' });
  const storedTask = (await (await page.request.get(`${http.url}/api/tasks`)).json()).find(item => item.id === task.id);
  assert.deepEqual(storedTask.targetBinding, { resourceId: resource.id, tool: 'service_status', environment: 'production', arguments: { service: 'billing' } });

  await page.locator('.list-heading').getByRole('button', { name: '创建定时任务' }).click();
  const createDialog = page.getByRole('dialog', { name: '创建定时任务' });
  await createDialog.locator('input[name=name]').fill('DTS 三字段目标任务');
  await createDialog.locator('textarea[name=prompt]').fill('查询已确认的 DTS 任务');
  const createBinding = createDialog.locator('.target-binding-control');
  await createBinding.locator('summary').click();
  await createBinding.getByLabel('目标查询工具').selectOption(JSON.stringify([dtsResource.id, 'dts_get_job_status']));
  await createBinding.getByLabel('任务 ID').fill('9007199254740993');
  await createBinding.getByRole('button', { name: '确认目标', exact: true }).click();
  await page.screenshot({ path: join(outputDir, 'task-create-dts-320.png') });
  await createDialog.getByRole('button', { name: '创建任务' }).click();
  await createDialog.waitFor({ state: 'hidden' });
  const dtsTask = (await (await page.request.get(`${http.url}/api/tasks`)).json()).find(item => item.name === 'DTS 三字段目标任务');
  assert.deepEqual(dtsTask.targetBinding, { resourceId: dtsResource.id, tool: 'dts_get_job_status', environment: 'production',
    arguments: { jobid: '9007199254740993', business_domain: 'general', area_name: 'cn_east' } });
  assert.deepEqual(errors, []);
  console.log('Target binding browser checks passed: explicit chat confirmation, Agent switch reset, authorized wrong target blocked, correct target queried, legacy task reconfigured, DTS triple target created, keyboard expansion, missing-field focus and recovery, clear confirmation, DTS desktop/320px layout.');
} finally {
  await browser.close();
  await http.close();
  await application.close();
  await fixture.close();
  rmSync(dataDir, { recursive: true, force: true });
}
