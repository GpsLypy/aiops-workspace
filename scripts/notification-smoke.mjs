import { chromium } from 'playwright';
import express from 'express';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createApplication } from '../server/app.mjs';
import { listen, startFixtures } from '../tests/fixtures.mjs';

const root = mkdtempSync(join(tmpdir(), 'aiops-notification-browser-'));
const output = resolve('test-results/notifications'); mkdirSync(output, { recursive: true });
const app = createApplication({ dataDir: root, scheduler: false }); const http = await listen(app.app); const fixture = await startFixtures();
let reject = true; const messages = [];
const receiver = express(); receiver.use(express.json()); receiver.post('/wecom', (req, res) => { messages.push(req.body); res.json(reject ? { errcode: 93000 } : { errcode: 0 }); }); const endpoint = await listen(receiver);
const browser = await chromium.launch({ headless: true, ...(process.env.PLAYWRIGHT_CHANNEL ? { channel: process.env.PLAYWRIGHT_CHANNEL } : {}) });
const errors = []; const results = []; const reopenChecks = [];
try {
  const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } }); page.on('pageerror', e => errors.push(e.message));
  await page.goto(http.url); await page.locator('input[name=username]').fill('notify-admin'); await page.locator('input[name=name]').fill('通知验收管理员'); await page.locator('input[name=password]').fill('notification-browser-password'); await page.getByRole('button', { name: '创建管理员并进入' }).click();
  await page.getByRole('button', { name: '通知中心', exact: true }).click(); await page.getByRole('button', { name: '创建通知渠道', exact: true }).click();
  let dialog = page.getByRole('dialog', { name: '创建通知渠道', exact: true }); await dialog.getByLabel('渠道名称').fill('DTS 值班群 · 验收'); await dialog.getByLabel('机器人 Webhook 地址').fill(endpoint.url + '/wecom'); await dialog.getByRole('button', { name: '保存渠道', exact: true }).click(); await dialog.waitFor({ state: 'hidden' });
  await page.getByText('DTS 值班群 · 验收', { exact: true }).waitFor();
  await page.getByRole('button', { name: '发送测试消息', exact: true }).click(); dialog = page.getByRole('dialog', { name: '推送详情', exact: true }); await dialog.waitFor();
  await app.notifications.tick(); await dialog.getByText('企业微信拒绝消息，错误码 93000').waitFor(); await page.screenshot({ path: join(output, 'wecom-failure-desktop.png'), fullPage: true });
  reject = false; await dialog.getByRole('button', { name: '重新发送', exact: true }).click(); await app.notifications.tick(); await dialog.getByText('已送达', { exact: true }).waitFor();
  assert.equal(messages.length, 2); assert.equal(messages[0].msgtype, 'text'); await page.keyboard.press('Escape'); results.push('UI creates WeCom channel, queues test message, displays business error, resends saved message and confirms delivery');
  await page.getByRole('tab', { name: /通知渠道/ }).click(); await page.getByRole('button', { name: '编辑渠道', exact: true }).click(); dialog = page.getByRole('dialog', { name: '编辑通知渠道', exact: true });
  assert.equal(await dialog.getByLabel('机器人 Webhook 地址').inputValue(), ''); await page.keyboard.press('Escape'); results.push('Saved endpoint never echoed into editor');
  await page.request.put(http.url + '/api/settings/model', { data: { baseUrl: fixture.url + '/v1', model: 'notification-browser-fixture' } });
  const resourceResponse = await page.request.post(http.url + '/api/resources', { data: { kind: 'mcp', name: '验收状态服务', endpoint: fixture.url + '/mcp', token: 'fixture-mcp-secret', allowedTools: ['service_status'], toolPolicies: { service_status: { risk: 'read', roles: ['admin'], environments: ['test'] } } } }); assert.equal(resourceResponse.ok(), true);
  const formResource = await resourceResponse.json();
  const alternateResponse = await page.request.post(http.url + '/api/resources', { data: { kind: 'mcp', name: '参数切换验收服务', endpoint: fixture.url + '/mcp', token: 'fixture-mcp-secret', allowedTools: ['service_status'], toolPolicies: { service_status: { risk: 'read', roles: ['admin'], environments: ['test'] } } } });
  assert.equal(alternateResponse.ok(), true); const alternateResource = await alternateResponse.json();
  await page.goto(http.url + '/#tasks'); await page.reload();
  const createRule = async (label, rawArguments) => {
    await dialog.getByRole('button', { name: '添加条件', exact: true }).focus(); await page.keyboard.press('Enter');
    const condition = dialog.locator('.inspection-rule').last();
    await condition.getByLabel('条件名称', { exact: true }).fill(label);
    await condition.getByRole('combobox').first().selectOption(formResource.id);
    await condition.getByLabel('结果字段', { exact: true }).fill('status');
    await condition.getByLabel('期望值', { exact: true }).fill('healthy');
    await condition.locator('summary').focus(); await page.keyboard.press('Enter');
    await condition.getByRole('textbox', { name: /的对象参数$/ }).fill(rawArguments);
  };
  const saveAndReloadRule = async (name, expected) => {
    const args = dialog.getByRole('textbox', { name: '条件 1 的对象参数', exact: true });
    await args.focus(); await page.keyboard.press('Tab');
    assert.equal(await dialog.getByRole('button', { name: '取消', exact: true }).evaluate(element => document.activeElement === element), true);
    await page.keyboard.press('Tab');
    assert.equal(await dialog.getByRole('button', { name: '创建任务', exact: true }).evaluate(element => document.activeElement === element), true);
    const responsePending = page.waitForResponse(response => response.url().endsWith('/api/tasks') && response.request().method() === 'POST');
    await page.keyboard.press('Enter');
    const response = await responsePending; assert.equal(response.status(), 201);
    assert.deepEqual(response.request().postDataJSON().inspectionRules, [expected], 'Only the inspection rule contract is submitted, without UI identity fields');
    const saved = await response.json(); assert.deepEqual(saved.inspectionRules, [expected]);
    await dialog.waitFor({ state: 'hidden' }); await page.reload();
    const savedTask = (await (await page.request.get(http.url + '/api/tasks')).json()).find(task => task.id === saved.id);
    assert.deepEqual(savedTask.inspectionRules, [expected]);
    await page.getByRole('row').filter({ hasText: name }).getByRole('button', { name: '通知设置', exact: true }).click();
    dialog = page.getByRole('dialog', { name: `通知设置 · ${name}`, exact: true });
    await dialog.locator('.inspection-rule summary').focus(); await page.keyboard.press('Enter');
    const reloaded = dialog.getByRole('textbox', { name: '条件 1 的对象参数', exact: true });
    assert.deepEqual(JSON.parse(await reloaded.inputValue()), expected.arguments);
    assert.equal(await reloaded.evaluate(element => element.validity.valid), true);
    await page.keyboard.press('Escape'); await dialog.waitFor({ state: 'hidden' });
    assert.equal((await page.request.delete(http.url + `/api/tasks/${saved.id}`, { data: {} })).ok(), true);
    await page.reload();
  };
  for (const operation of ['delete-first', 'switch-service']) {
    for (const invalid of [false, true]) {
      await page.setViewportSize({ width: invalid ? 320 : 1440, height: invalid ? 844 : 1000 });
      await page.getByRole('button', { name: '创建定时任务', exact: true }).last().focus(); await page.keyboard.press('Enter');
      dialog = page.getByRole('dialog', { name: '创建定时任务', exact: true });
      const name = `条件归属验收 ${operation} ${invalid ? 'invalid' : 'valid'}`;
      await dialog.getByLabel('任务名称', { exact: true }).fill(name);
      await dialog.getByLabel('完整任务指令').fill('只检查表单保存，不执行此临时任务');
      assert.equal(await dialog.locator('.inspection-rule').count(), 0, 'Each independent form case starts with no conditions');
      const label = operation === 'delete-first' ? '保留 beta 条件' : '服务切换条件';
      if (operation === 'delete-first') {
        await createRule('待删除 alpha 条件', invalid ? '{' : '{"service":"alpha"}');
        await createRule(label, '{"service":"beta"}');
        await dialog.getByRole('button', { name: '移除条件 1', exact: true }).focus(); await page.keyboard.press('Enter');
      } else {
        await createRule(label, invalid ? '{' : '{"service":"alpha"}');
        await dialog.locator('.inspection-rule').getByRole('combobox').first().selectOption(alternateResource.id);
      }
      assert.equal(await dialog.locator('.inspection-rule').count(), 1);
      const args = dialog.getByRole('textbox', { name: '条件 1 的对象参数', exact: true });
      assert.equal(await args.inputValue(), operation === 'delete-first' ? '{"service":"beta"}' : '{}', `${operation}: displayed arguments must follow the surviving rule or explicit service reset`);
      assert.equal(await args.evaluate(element => element.validity.valid && element.form.checkValidity()), true, `${operation}: a removed or reset JSON draft must not leave a validation error`);
      if (operation === 'delete-first' && invalid) {
        // Keep raw invalid drafts, focus and caret while valid edits update the parent rule object.
        await args.fill('');
        let typed = '';
        for (const key of ['{', '}', 'ArrowLeft', ...'"service":"beta"']) {
          if (key === 'ArrowLeft') await page.keyboard.press(key);
          else {
            await page.keyboard.insertText(key);
            typed = typed === '{}' || typed.endsWith('}') ? typed.slice(0, -1) + key + '}' : typed + key;
          }
          const expectedCaret = key === 'ArrowLeft' || typed.length > 2 ? typed.length - 1 : typed.length;
          assert.deepEqual(await args.evaluate(element => ({ value: element.value, focused: document.activeElement === element, start: element.selectionStart, end: element.selectionEnd })), { value: typed, focused: true, start: expectedCaret, end: expectedCaret });
        }
        assert.equal(await args.evaluate(element => element.validity.valid), true);
      }
      await args.focus(); await args.scrollIntoViewIfNeeded();
      assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
      await page.screenshot({ path: join(output, `day04-rule-${operation}-${invalid ? 320 : 1440}.png`), fullPage: false });
      await saveAndReloadRule(name, { label, resourceId: operation === 'delete-first' ? formResource.id : alternateResource.id, tool: 'service_status', arguments: operation === 'delete-first' ? { service: 'beta' } : {}, path: 'status', operator: 'eq', expected: 'healthy' });
    }
    results.push(operation === 'delete-first' ? 'Deleting valid/invalid leading conditions preserves the surviving JSON and validity; partial typing retains focus/caret, keyboard save and reload match exactly at 320px.' : 'Changing a condition service clears valid/invalid old JSON and validity; submitted and reloaded rules contain the explicit empty object without UI identity fields.');
  }
  assert.equal(app.store.get('SELECT COUNT(*) AS count FROM executions').count, 0);
  assert.equal(app.store.get('SELECT COUNT(*) AS count FROM tool_steps').count, 0);
  assert.equal(messages.length, 2, 'Form checks do not execute tasks or send additional notifications');
  assert.equal((await page.request.delete(http.url + `/api/resources/${alternateResource.id}`, { data: {} })).ok(), true);
  await page.setViewportSize({ width: 1440, height: 1000 }); await page.reload();
  await page.getByRole('button', { name: '定时任务', exact: true }).click(); await page.getByRole('button', { name: '创建定时任务', exact: true }).last().click(); dialog = page.getByRole('dialog', { name: '创建定时任务', exact: true });
  await dialog.getByLabel('任务名称', { exact: true }).fill('每日服务健康巡检'); await dialog.getByLabel('完整任务指令').fill('调用工具检查 billing 服务的状态并生成摘要');
  await dialog.getByRole('checkbox', { name: /DTS 值班群/ }).check(); await dialog.getByRole('button', { name: '添加条件', exact: true }).click();
  await dialog.getByLabel('条件名称', { exact: true }).fill('billing 处于健康状态'); await dialog.getByLabel('结果字段', { exact: true }).fill('status'); await dialog.getByLabel('期望值', { exact: true }).fill('healthy');
  await dialog.getByText('消息内容预览', { exact: true }).click(); await dialog.getByText('以上为格式预览；实际结论与时间以本次执行证据为准。', { exact: true }).waitFor();
  await page.screenshot({ path: join(output, 'task-config-desktop.png'), fullPage: true });
  await page.setViewportSize({ width: 390, height: 844 }); assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true); await page.screenshot({ path: join(output, 'task-config-mobile.png'), fullPage: true });
  await dialog.getByRole('button', { name: '创建任务', exact: true }).click(); await dialog.waitFor({ state: 'hidden' });
  await page.setViewportSize({ width: 1440, height: 1000 }); const row = page.getByRole('row').filter({ hasText: '每日服务健康巡检' }); await row.getByRole('button', { name: '立即执行', exact: true }).click();
  dialog = page.getByRole('dialog', { name: '执行记录 · 每日服务健康巡检', exact: true }); await dialog.getByText('全部正常条件满足', { exact: true }).waitFor(); await app.notifications.tick(); await dialog.getByText('已送达', { exact: true }).waitFor();
  await page.screenshot({ path: join(output, 'task-result-desktop.png'), fullPage: true });
  assert.ok((await dialog.innerText()).includes('status = "healthy"')); assert.ok((await dialog.innerText()).includes('查询'));
  const tasks = await (await page.request.get(http.url + '/api/tasks')).json(); const run = (await (await page.request.get(http.url + `/api/tasks/${tasks[0].id}/runs`)).json())[0];
  assert.equal(run.status, 'success'); assert.equal(run.assessment.status, 'healthy'); assert.equal(run.deliveries[0].status, 'delivered');
  await dialog.getByRole('link', { name: '查看推送详情', exact: true }).click(); await page.getByRole('heading', { name: '通知中心', exact: true }).waitFor();
  dialog = page.getByRole('dialog', { name: '推送详情', exact: true }); await dialog.getByText('已送达', { exact: true }).waitFor(); await dialog.getByRole('link', { name: '查看巡检记录', exact: true }).click(); await page.getByRole('dialog', { name: '执行记录 · 每日服务健康巡检', exact: true }).waitFor();
  results.push('UI creates task with structured condition and preview; actual model/MCP run yields healthy assessment and independent delivery; detail links round-trip');
  await page.keyboard.press('Escape'); await row.getByRole('button', { name: '通知设置', exact: true }).click(); dialog = page.getByRole('dialog', { name: '通知设置 · 每日服务健康巡检', exact: true }); await dialog.getByLabel('推送时机').selectOption('issues'); await dialog.getByLabel('持续异常提醒间隔（分钟）').fill('30'); await dialog.getByRole('checkbox', { name: '恢复正常时通知', exact: true }).uncheck(); await dialog.getByRole('button', { name: '保存通知设置', exact: true }).click(); await dialog.waitFor({ state: 'hidden' });
  await page.reload(); assert.equal((await (await page.request.get(http.url + `/api/tasks`)).json())[0].notification.mode, 'issues'); results.push('Existing task notification settings persist after reload');
  // Reloading the retained detail URL restores its run dialog; close it before the form checks.
  await page.getByRole('dialog', { name: '执行记录 · 每日服务健康巡检', exact: true }).getByRole('button', { name: '关闭弹窗', exact: true }).click();
  // Keep the saved task and exercise real close/reopen transitions without reload or API cleanup.
  const tasksBeforeReopen = await (await page.request.get(http.url + '/api/tasks')).json();
  const savedBeforeReopen = tasksBeforeReopen.find(task => task.name === '每日服务健康巡检');
  const sideEffectsBeforeReopen = { executions: app.store.get('SELECT COUNT(*) AS count FROM executions').count, toolSteps: app.store.get('SELECT COUNT(*) AS count FROM tool_steps').count, messages: messages.length };
  const reopenRequests = [];
  const recordReopenRequest = request => { if (request.isNavigationRequest() || request.url().includes('/api/tasks') && request.method() !== 'GET') reopenRequests.push({ method: request.method(), url: request.url() }); };
  page.on('request', recordReopenRequest);
  const createButton = page.getByRole('button', { name: '创建定时任务', exact: true }).last();
  const editButton = row.getByRole('button', { name: '通知设置', exact: true });
  const watchFirstDraft = () => page.evaluate(() => {
    window.__taskDraftProbe = { first: null, observer: null };
    window.__taskDraftProbe.observer = new MutationObserver(() => {
      const draft = document.querySelector('[role="dialog"][aria-label="创建定时任务"] .notification-fields');
      if (!draft || window.__taskDraftProbe.first) return;
      window.__taskDraftProbe.first = {
        rules: draft.querySelectorAll('.inspection-rule').length,
        checkedChannels: draft.querySelectorAll('.channel-options input:checked').length,
        notificationOptions: !!draft.querySelector(':scope > .notification-form-grid'),
      };
    });
    window.__taskDraftProbe.observer.observe(document.body, { childList: true, subtree: true });
  });
  const closeDraft = async (mode, trigger) => {
    if (mode === 'Escape') await page.keyboard.press('Escape');
    else await dialog.getByRole('button', { name: mode, exact: true }).click();
    assert.equal(await trigger.evaluate(element => document.activeElement === element), true, `${mode} restores focus to the original trigger`);
  };
  for (const width of [1440, 320]) {
    await page.setViewportSize({ width, height: width === 320 ? 844 : 1000 });
    for (const closeMode of ['Escape', '取消', '关闭弹窗']) {
      await editButton.click(); dialog = page.getByRole('dialog', { name: '通知设置 · 每日服务健康巡检', exact: true });
      assert.equal(await dialog.locator('.inspection-rule').count(), 1);
      assert.equal(await dialog.getByRole('checkbox', { name: /DTS 值班群/ }).isChecked(), true);
      assert.equal(await dialog.getByLabel('推送时机').inputValue(), 'issues');
      assert.equal(await dialog.getByLabel('持续异常提醒间隔（分钟）').inputValue(), '30');
      assert.equal(await dialog.getByRole('checkbox', { name: '恢复正常时通知', exact: true }).isChecked(), false);
      for (const from of ['saved-settings', 'unsaved-create']) {
        await watchFirstDraft();
        await closeDraft(closeMode, from === 'saved-settings' ? editButton : createButton);
        if (width === 320) { await createButton.focus(); await page.keyboard.press('Enter'); }
        else await createButton.click();
        dialog = page.getByRole('dialog', { name: '创建定时任务', exact: true });
        const name = `复开草稿 ${width} ${closeMode} ${from}`;
        const prompt = '只检查连续复开，不执行、不保存这个草稿';
        await dialog.getByLabel('任务名称', { exact: true }).fill(name);
        await dialog.getByLabel('完整任务指令').fill(prompt);
        await createRule('唯一的新条件', '{"service":"new-draft"}');
        const first = await page.evaluate(() => { const probe = window.__taskDraftProbe; probe.observer.disconnect(); delete window.__taskDraftProbe; return probe.first; });
        reopenChecks.push({ width, closeMode, from, first });
        writeFileSync(join(output, 'day05-task-reopen-probe.json'), JSON.stringify(reopenChecks, null, 2));
        assert.deepEqual(first, { rules: 0, checkedChannels: 0, notificationOptions: false }, 'The first observable creation DOM contains no old rules or notification configuration');
        assert.equal(await dialog.locator('.inspection-rule').count(), 1, 'One add action creates exactly one new condition');
        assert.equal(await dialog.getByLabel('任务名称', { exact: true }).inputValue(), name);
        assert.equal(await dialog.getByLabel('完整任务指令').inputValue(), prompt);
        await dialog.getByRole('checkbox', { name: /DTS 值班群/ }).check();
        assert.equal(await dialog.getByLabel('推送时机').inputValue(), 'all');
        assert.equal(await dialog.getByLabel('持续异常提醒间隔（分钟）').inputValue(), '60');
        assert.equal(await dialog.getByRole('checkbox', { name: '恢复正常时通知', exact: true }).isChecked(), true);
        // Leave a distinct unsaved configuration for the following create-to-create transition.
        await dialog.getByLabel('推送时机').selectOption('issues');
        await dialog.getByLabel('持续异常提醒间隔（分钟）').fill('45');
        await dialog.getByRole('checkbox', { name: '恢复正常时通知', exact: true }).uncheck();
        if (closeMode === 'Escape' && from === 'unsaved-create') {
          await dialog.getByRole('textbox', { name: '条件 1 的对象参数', exact: true }).scrollIntoViewIfNeeded();
          assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
          await page.screenshot({ path: join(output, `day05-task-reopen-${width}.png`), fullPage: false });
        }
      }
      await closeDraft(closeMode, createButton);
    }
  }
  page.off('request', recordReopenRequest);
  assert.deepEqual(reopenRequests, [], 'Reopening neither reloads the page nor mutates or deletes tasks');
  const tasksAfterReopen = await (await page.request.get(http.url + '/api/tasks')).json();
  assert.equal(tasksAfterReopen.length, tasksBeforeReopen.length);
  const savedAfterReopen = tasksAfterReopen.find(task => task.id === savedBeforeReopen.id);
  assert.deepEqual(savedAfterReopen.notification, savedBeforeReopen.notification);
  assert.deepEqual(savedAfterReopen.inspectionRules, savedBeforeReopen.inspectionRules);
  assert.deepEqual({ executions: app.store.get('SELECT COUNT(*) AS count FROM executions').count, toolSteps: app.store.get('SELECT COUNT(*) AS count FROM tool_steps').count, messages: messages.length }, sideEffectsBeforeReopen);
  results.push('At 1440/320px, saved-settings and unsaved-create reopens expose an empty draft in the first DOM observation; one addition, typed fields, notification defaults and Escape/cancel/close focus restoration remain correct without reload, deletion or changes to the retained task.');
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.goto(http.url + '/#notifications'); await page.reload(); await page.getByText('每日服务健康巡检', { exact: true }).waitFor(); await page.screenshot({ path: join(output, 'notifications-desktop.png'), fullPage: true });
  for (const width of [390, 320]) { await page.setViewportSize({ width, height: 844 }); assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true); await page.screenshot({ path: join(output, `notifications-${width}.png`), fullPage: true }); }
  await page.getByLabel('投递状态', { exact: true }).selectOption('failed'); await page.getByText('没有此状态的推送记录', { exact: true }).waitFor(); results.push('Record filter empty state and 320/390px layouts without horizontal page overflow');
  assert.deepEqual(errors, []);
  const report = { results, reopenChecks, pageErrors: errors, receivedMessages: messages.length, realExternalServices: false, screenshots: output }; writeFileSync(join(output, 'browser-report.json'), JSON.stringify(report, null, 2)); console.log(JSON.stringify(report, null, 2));
} catch (error) { const pages = browser.contexts()[0]?.pages(); if (pages?.[0]) await pages[0].screenshot({ path: join(output, 'failure.png'), fullPage: true }); throw error; }
finally { await browser.close(); await http.close(); await app.close(); await fixture.close(); await endpoint.close(); rmSync(root, { recursive: true, force: true }); }
