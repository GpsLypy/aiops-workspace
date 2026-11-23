import { chromium } from 'playwright';
import assert from 'node:assert/strict';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { runtimeFixture, answer, call } from '../tests/runtime-fixture.mjs';

// Complete UI -> API -> actual SDK -> local SSE/MCP -> persisted readback.
// Uses temporary encrypted data and deterministic providers, never saved secrets.
const output = resolve('test-results/delegation-runtime-browser'); mkdirSync(output, { recursive: true });
const h = await runtimeFixture({ poolSize: 1 });
const errors = [], external = [], posts = [];
let browser;
try {
  h.model((req, res) => {
    if (req.body.messages[0].content.startsWith('delegated-agent/v1')) {
      if (req.body.messages.at(-1).role !== 'tool') return answer(res, [call('child-status')], '');
      return setTimeout(() => answer(res, undefined, '子任务取得本轮 billing 查询证据。'), 120);
    }
    if (req.body.messages.at(-1).role !== 'tool') return answer(res, [call('root-delegate', 'delegate_agents', { tasks: [{ agentId: null, task: '查询计费服务状态' }, { agentId: null, task: '独立查询并核对计费服务状态' }] })], '');
    const returned = JSON.parse(req.body.messages.at(-1).content);
    assert.equal(returned.results.length, 2); assert.equal(returned.status, 'completed');
    return answer(res, undefined, '主任务汇总：两个只读子任务均取得了本轮 billing 查询证据。');
  });
  const login = await h.request('/auth/login', { username: 'admin', password: 'runtime-test-password' }); assert.equal(login.status, 200);
  browser = await chromium.launch({ headless: true, ...(process.env.PLAYWRIGHT_CHANNEL ? { channel: process.env.PLAYWRIGHT_CHANNEL } : {}) });
  const context = await browser.newContext({ viewport: { width: 1440, height: 960 }, acceptDownloads: true });
  const split = login.cookie.indexOf('=');
  await context.addCookies([{ name: login.cookie.slice(0, split), value: login.cookie.slice(split + 1), url: h.url }]);
  const page = await context.newPage(); page.on('pageerror', e => errors.push(e.message));
  page.on('request', r => { if (!r.url().startsWith(h.url)) external.push(r.url()); if (r.method() === 'POST' && r.url().endsWith('/api/chat')) posts.push(r.postDataJSON()); });
  await page.goto(h.url + '/#chat');
  await page.getByRole('switch', { name: '允许委派', exact: true }).click();
  await page.getByRole('textbox', { name: '输入你的问题' }).fill('把计费状态查询拆成两个独立只读子任务并汇总证据。');
  await page.getByRole('button', { name: '发送消息', exact: true }).click();
  await page.getByText('主任务汇总：两个只读子任务均取得了本轮 billing 查询证据。', { exact: true }).waitFor({ timeout: 30000 });
  await page.locator('.delegation-summary').filter({ hasText: '2' }).waitFor();
  assert.equal(posts.length, 1); assert.equal(posts[0].delegationMode, 'auto');
  await page.getByRole('button', { name: '打开问答全景', exact: true }).click();
  await page.getByRole('dialog', { name: '问答全景', exact: true }).waitFor();
  await page.getByRole('navigation', { name: 'Agent 执行分组' }).waitFor();
  await page.getByRole('button', { name: '查看全图', exact: true }).click();
  await page.screenshot({ path: join(output, 'desktop-live-result.png'), fullPage: true });
  await page.getByRole('button', { name: '恢复原始比例', exact: true }).click();
  await page.getByRole('button', { name: /查看子 Agent 1/ }).click();
  await page.screenshot({ path: join(output, 'desktop-child-branch.png'), fullPage: true });
  const own = (await h.request('/conversations')).data; assert.equal(own.length, 1);
  const conversation = (await h.request('/conversations/' + own[0].id)).data;
  const metadata = conversation.messages.at(-1).metadata; const trace = metadata.executionTrace;
  assert.equal(metadata.agentDelegation.children.length, 2); assert.ok(metadata.agentDelegation.children.every(c => c.status === 'completed'));
  assert.equal(trace.nodes.filter(n => n.kind === 'subagent').length, 2);
  assert.equal(trace.nodes.filter(n => n.kind === 'tool').length, 2);
  assert.equal(trace.nodes.filter(n => n.kind === 'model').length, 6);
  assert.ok(trace.nodes.some(n => n.kind === 'handoff')); assert.ok(trace.nodes.some(n => n.kind === 'aggregate'));
  const rootExecution = h.app.store.get('SELECT * FROM executions WHERE id=?', metadata.runId);
  assert.equal(rootExecution.tokens, 180);
  const persisted = h.app.store.all('SELECT status,task_encrypted,result_encrypted FROM agent_delegations WHERE run_id=?', metadata.runId);
  assert.equal(persisted.length, 2); assert.ok(persisted.every(c => c.status === 'completed' && c.task_encrypted && c.result_encrypted));
  const details = node => Object.fromEntries((node.details || []).map(item => [item.label, item.value]));
  for (const child of metadata.agentDelegation.children) {
    const anchor = trace.nodes.find(n => n.id === child.nodeId);
    const task = h.app.store.get('SELECT task_encrypted FROM agent_delegations WHERE id=?', child.id);
    assert.equal(details(anchor)['Agent ID'], 'general');
    assert.equal(details(anchor)['深度'], '1');
    assert.equal(details(anchor)['输入字符数'], String(h.app.store.decrypt(task.task_encrypted).length));
    assert.equal(details(anchor)['历史消息数'], '0');
    assert.equal(details(anchor)['工具步骤数'], '1');
    const models = trace.nodes.filter(n => n.agentRunId === child.id && n.kind === 'model');
    assert.deepEqual(models.map(n => details(n)['请求次序']), ['1', '2']);
    assert.ok(models.every(n => details(n)['模型'] === 'fixture' && details(n)['问答强度'] === '服务商默认' && details(n)['用量'] === '30 tokens'));
    const tool = trace.nodes.find(n => n.agentRunId === child.id && n.kind === 'tool');
    assert.equal(details(tool)['资源 ID'], h.resource.id);
    assert.equal(details(tool)['修订'], String(h.app.store.get('SELECT resource_revision FROM tool_steps WHERE id=?', details(tool)['步骤 ID']).resource_revision));
    assert.equal(details(tool)['环境'], h.resource.environment);
    assert.equal(details(tool)['风险'], 'read');
    assert.ok(details(tool)['步骤 ID']);
  }
  const download = page.waitForEvent('download'); await page.getByRole('button', { name: '导出 JSON', exact: true }).click();
  const artifact = await download; await artifact.saveAs(join(output, 'panorama.json'));
  assert.deepEqual(JSON.parse(readFileSync(join(output, 'panorama.json'), 'utf8')), trace);
  await page.keyboard.press('Escape'); await page.reload();
  await page.getByRole('button', { name: own[0].title, exact: true }).click();
  await page.locator('.delegation-summary').filter({ hasText: '2' }).waitFor();
  await page.getByRole('button', { name: '打开问答全景', exact: true }).click();
  await page.getByRole('button', { name: '节点列表', exact: true }).click();
  await page.setViewportSize({ width: 320, height: 700 });
  await page.locator('.panorama-agent-group-child').last().getByRole('button').first().click();
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
  await page.screenshot({ path: join(output, 'mobile-persisted-list.png'), fullPage: true });
  assert.equal(h.requests.length, 6); assert.equal(posts.length, 1); assert.deepEqual(errors, []); assert.deepEqual(external, []);
  writeFileSync(join(output, 'report.json'), JSON.stringify({ passed: true, actualSdk: '2.0.8', modelFixtureRequests: h.requests.length, children: 2, readSteps: 2, tokens: rootExecution.tokens, poolSize: 1, browser: process.env.PLAYWRIGHT_CHANNEL || 'chromium', pageErrors: errors, externalRequests: external, checks: ['UI opt-in/send', 'real SDK parallel child tools', 'root aggregation', 'encrypted persistence', 'retained safe node details', 'actual hierarchy/export', 'reload/no replay', '320px grouped list'] }, null, 2));
  console.log('PASS: real SDK full browser delegation, 2 children/2 read steps/6 fixture model calls, persistence/export/reload/320px, 0 page errors or external browser requests.');
} finally { await browser?.close(); await h.close(); }
