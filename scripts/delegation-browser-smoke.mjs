import { chromium } from 'playwright';
import express from 'express';
import assert from 'node:assert/strict';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { listen } from '../tests/fixtures.mjs';
import { createExecutionTrace } from '../server/agent-trace.mjs';

// Isolated UI/trace fixture: no live models, business services, .env or saved workspace data.
const output = resolve('test-results/delegation-browser'); mkdirSync(output, { recursive: true });
const user = { id: 'delegation-member', username: 'delegation-member', name: '验收成员', role: 'member', active: true };
const resources = [{ id: 'ops', kind: 'agents', name: '运维分析', description: '只读查询并整理授权证据。', status: '已启用', publication: 'published', skillIds: [], mcpIds: [], knowledgeIds: [] }];
const made = '2026-10-10T03:00:00Z';
const legacyTrace = { version: 1, runId: 'legacy-run', startedAt: made, finishedAt: made, durationMs: 900, status: 'completed', nodes: [
  { id: 'old1', kind: 'model', label: '历史模型', summary: '旧版本处理记录。', status: 'completed', durationMs: 800 },
  { id: 'old2', kind: 'answer', label: '历史答复', summary: '旧版本发布记录。', status: 'completed', durationMs: 100 },
], edges: [{ from: 'old1', to: 'old2' }] };
const session = (id, title, trace) => ({ id, title, user_id: user.id, agent_id: null, messages: [
  { seq: 1, role: 'user', content: title, created: made, metadata: {} },
  { seq: 2, role: 'assistant', content: '本地界面验收记录。', created: made, metadata: { executionTrace: trace } },
] });
function boundedTrace() {
  const t = createExecutionTrace('bounded-run');
  const ids = [];
  for (let i = 0; i < 200; i++) { const node = t.start({ kind: 'model', label: `受限节点 ${i + 1}`, summary: '本地受控有界记录。' }, i ? [ids[i - 1]] : []); ids.push(node); t.finish(node); }
  for (let from = 0; from < 4 && t.snapshot().edges.length < 400; from++) for (let to = 10; to < 150 && t.snapshot().edges.length < 400; to++) t.link(ids[from], ids[to]);
  for (let i = 0; i < 3; i++) assert.equal(t.start({ kind: 'tool', label: '超出节点上限的实际处理' }), null);
  assert.equal(t.start({ kind: 'unknown', label: '无效节点' }), null);
  for (let i = 190; i < 195; i++) t.link(ids[4], ids[i]);
  t.link(ids[4], ids[190]); t.link(ids[0], ids[1]); t.link('missing', ids[1]); t.link(ids[0], ids[0]);
  const saved = t.complete('completed');
  assert.equal(saved.nodes.length, 200); assert.equal(saved.edges.length, 400); assert.equal(saved.omittedNodes, 3); assert.equal(saved.omittedEdges, 5);
  t.start({ kind: 'model', label: '迟到节点' }); t.link(ids[4], ids[195]);
  assert.deepEqual(t.snapshot(), saved, 'Late callbacks must not alter omission counters');
  return saved;
}
const cappedTrace = boundedTrace();
const sessions = [session('legacy', '旧版执行记录', legacyTrace), session('cycle', '循环依赖记录', { ...legacyTrace, runId: 'cycle-run', edges: [...legacyTrace.edges, { from: 'old2', to: 'old1' }] }), session('bounded', '全景记录上限验收', cappedTrace)];
const submitted = [], checks = [], errors = [], external = [];
let release = () => {}, expectedTrace;

function delegationTrace() {
  const t = createExecutionTrace('delegated-run');
  const start = (kind, label, dependencies = [], fields = {}) => t.start({ kind, label, summary: '本地受控验收的可观测处理记录。', ...fields }, dependencies);
  const req = start('request', '本轮请求'); t.finish(req);
  const ctx = start('context', '主任务上下文', [req]); t.finish(ctx);
  const budget = start('budget', '共享执行预算', [ctx], { details: [{ label: '模型轮次上限', value: '12' }, { label: '子任务上限', value: '4' }] }); t.finish(budget);
  const mainModel = start('model', '主 Agent 分析', [budget]); t.finish(mainModel);
  const delegation = start('delegation', '分派只读任务', [mainModel]); t.finish(delegation);
  const field = (agentRunId, parentNodeId) => ({ agentRunId, parentAgentRunId: 'delegated-run', parentNodeId });
  const child1 = start('subagent', '运维分析', [{ from: delegation, label: '任务分派' }], field('child-one', delegation));
  const handoff1 = start('handoff', '接收子任务输入', [child1], { ...field('child-one', child1), details: [{ label: '输入来源', value: '主 Agent 委派' }, { label: '输入字符数', value: '120' }, { label: '授权工具数', value: '1' }] }); t.finish(handoff1);
  const childContext = start('context', '子任务上下文', [handoff1], field('child-one', child1)); t.finish(childContext);
  const childModel = start('model', '子任务模型请求', [childContext], field('child-one', child1));
  const child2 = start('subagent', '通用 Agent', [{ from: delegation, label: '任务分派' }], field('child-two', delegation));
  const failedModel = start('model', '子任务请求失败', [child2], field('child-two', child2));
  const live = t.snapshot();
  t.finish(childModel, 'completed', '收到可观测结果。', [{ label: '返回字符数', value: '80' }, { label: '用量', value: '140 tokens' }]);
  const tool = start('tool', '只读查询步骤', [childModel], { ...field('child-one', child1), details: [{ label: '来源数', value: '1' }, { label: '处理方向', value: '查询结果 → 子 Agent' }] }); t.finish(tool);
  t.finish(child1, 'completed', '子任务完成；结果交回主 Agent。');
  t.finish(failedModel, 'error', '子任务请求失败。', [{ label: '错误代码', value: 'MODEL_UNAVAILABLE' }]); t.finish(child2, 'error', '子任务未取得结果。');
  const aggregate = start('aggregate', '主 Agent 汇总结果', [{ from: tool, label: '返回只读结果' }, { from: failedModel, label: '返回失败状态' }], { details: [{ label: '完成子任务', value: '1' }, { label: '失败子任务', value: '1' }, { label: '结果去向', value: '主 Agent 下一轮模型上下文' }] }); t.finish(aggregate);
  const finalModel = start('model', '主 Agent 最终回答', [aggregate]); t.finish(finalModel);
  const answer = start('answer', '发布本轮答复', [finalModel]); t.finish(answer);
  return { live, saved: t.complete('completed') };
}

const app = express(); app.use(express.json());
app.use('/api', async (req, res) => {
  if (req.method === 'GET') {
    if (req.path === '/auth/me') return res.json(user);
    if (req.path === '/resources') return res.json(resources);
    if (req.path === '/model/status') return res.json({ configured: true, model: '本地界面夹具', model_reasoning_effort: null });
    if (req.path === '/conversations') return res.json(sessions.map(({ messages, ...record }) => record));
    if (req.path.startsWith('/conversations/')) return res.json(sessions.find(record => record.id === req.path.split('/').at(-1)) || {});
    return res.json({});
  }
  assert.equal(req.path, '/chat'); submitted.push(req.body);
  const delegated = req.body.delegationMode === 'auto';
  const traces = delegated ? delegationTrace() : { live: legacyTrace, saved: legacyTrace };
  if (delegated) expectedTrace = traces.saved;
  const id = delegated ? 'delegated' : 'plain';
  const record = session(id, delegated ? '委派执行验收' : '关闭委派验收', traces.saved);
  if (delegated) record.messages[1].metadata.agentDelegation = { version: 1, mode: 'auto', maxDepth: 1, maxChildren: 4, maxParallel: 3, modelRoundLimit: 12, status: 'partial', children: [
    { id: 'child-one', parentAgentRunId: 'delegated-run', agentId: 'ops', agentName: '运维分析', status: 'completed', modelCalls: 1, tokens: 140, toolSteps: 1, sourceCount: 1 },
    { id: 'child-two', parentAgentRunId: 'delegated-run', agentId: null, agentName: '通用 Agent', status: 'failed', modelCalls: 1, tokens: 0, toolSteps: 0, sourceCount: 0, errorCode: 'MODEL_UNAVAILABLE' },
  ] };
  res.type('application/x-ndjson');
  const send = event => res.write(JSON.stringify(event) + '\n');
  send({ type: 'execution', runId: traces.saved.runId }); send({ type: 'session', id }); send({ type: 'trace', trace: traces.live });
  if (delegated) await new Promise(resolve => { release = resolve; });
  sessions.unshift(record);
  send({ type: 'done', text: record.messages[1].content, conversationId: id, metadata: record.messages[1].metadata }); res.end();
});
app.use(express.static(resolve('dist')));
const http = await listen(app);
const browser = await chromium.launch({ headless: true, ...(process.env.PLAYWRIGHT_CHANNEL ? { channel: process.env.PLAYWRIGHT_CHANNEL } : {}) });
try {
  const page = await browser.newPage({ viewport: { width: 1440, height: 1000 }, reducedMotion: 'reduce' });
  page.on('pageerror', error => errors.push(error.message));
  page.on('request', request => { if (!request.url().startsWith(http.url)) external.push(request.url()); });
  await page.goto(http.url + '/#chat');
  const delegation = page.getByRole('switch', { name: '允许委派', exact: true });
  await delegation.waitFor(); assert.equal(await delegation.getAttribute('aria-checked'), 'false');
  assert.match(await delegation.getAttribute('aria-describedby'), /delegation-help/);
  await delegation.focus(); await page.keyboard.press('Space');
  assert.equal(await delegation.getAttribute('aria-checked'), 'true');
  await page.getByRole('textbox', { name: '输入你的问题' }).fill('请按需委派只读子任务。');
  await page.getByRole('button', { name: '发送消息', exact: true }).click();
  await page.locator('.panorama-entry-live').waitFor();
  assert.equal(submitted[0].delegationMode, 'auto'); assert.equal(await delegation.isDisabled(), true);
  await page.getByRole('button', { name: '打开问答全景', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: '问答全景', exact: true });
  await dialog.waitFor();
  assert.equal(await dialog.locator('.panorama-agent-lane').count(), 3);
  assert.equal(await dialog.locator('.panorama-links .is-handoff').count(), 2);
  assert.equal(await dialog.locator('marker path').evaluate(el => getComputedStyle(el).fill !== 'none'), true);
  await dialog.getByRole('button', { name: '查看子 Agent 2 · 通用 Agent', exact: true }).focus(); await page.keyboard.press('Enter');
  await page.waitForFunction(() => document.activeElement?.getAttribute('aria-label') === '通用 Agent，处理中');
  await dialog.getByRole('button', { name: '查看主 Agent', exact: true }).focus(); await page.keyboard.press('Enter');
  await page.waitForFunction(() => document.activeElement?.getAttribute('aria-label') === '本轮请求，已接收');
  await dialog.getByRole('button', { name: '查看全图', exact: true }).click();
  await page.screenshot({ path: join(output, 'desktop-delegation-live.png'), fullPage: true });
  await dialog.getByRole('button', { name: '节点列表', exact: true }).click();
  assert.equal(await dialog.locator('.panorama-agent-group').count(), 3);
  await dialog.getByRole('button', { name: '接收子任务输入，已完成', exact: true }).click();
  await dialog.locator('.panorama-detail').getByText('主 Agent 委派', { exact: true }).waitFor();
  await dialog.locator('.panorama-detail').getByText('120', { exact: true }).waitFor();
  await dialog.getByRole('button', { name: '子任务模型请求，处理中', exact: true }).click();
  await dialog.getByRole('heading', { name: '子任务模型请求', exact: true }).waitFor();
  await dialog.getByRole('button', { name: '查看委派入口', exact: true }).focus(); await page.keyboard.press('Enter');
  await page.waitForFunction(() => document.activeElement?.getAttribute('aria-label') === '运维分析，处理中');
  checks.push('opt-in default off; keyboard switch submits auto; disabled during run; live root/two-child graph lanes, handoff arrows and parent jump');

  await dialog.getByRole('button', { name: '子任务模型请求，处理中', exact: true }).click();
  release();
  await page.getByRole('button', { name: '发送消息', exact: true }).waitFor();
  await page.locator('.delegation-summary').getByText('本轮委派 2 个子任务，1 个未完成；结果与缺口见本轮全景。', { exact: true }).waitFor();
  await dialog.getByRole('heading', { name: '子任务模型请求', exact: true }).waitFor();
  assert.equal(await dialog.locator('.panorama-detail').getByText('140 tokens', { exact: true }).count(), 1);
  await dialog.getByRole('button', { name: '子任务请求失败，发生错误', exact: true }).click();
  await dialog.locator('.panorama-detail').getByText('MODEL_UNAVAILABLE', { exact: true }).waitFor();
  const downloaded = page.waitForEvent('download');
  await dialog.getByRole('button', { name: '导出 JSON', exact: true }).click();
  const download = await downloaded; await download.saveAs(join(output, 'delegated-trace.json'));
  assert.deepEqual(JSON.parse(readFileSync(join(output, 'delegated-trace.json'), 'utf8')), expectedTrace);
  await page.keyboard.press('Escape');
  await page.waitForFunction(() => document.activeElement?.classList.contains('panorama-entry'));
  checks.push('live→saved keeps dialog and selected child; error/count/return details; exported hierarchy matches trace; Escape restores entry focus');

  await page.reload(); await delegation.waitFor();
  assert.equal(await delegation.getAttribute('aria-checked'), 'false');
  await page.getByRole('button', { name: '委派执行验收', exact: true }).click();
  await page.getByRole('button', { name: '打开问答全景', exact: true }).click();
  await dialog.waitFor(); assert.equal(await dialog.locator('.panorama-agent-lane').count(), 3);
  await dialog.getByRole('button', { name: '节点列表', exact: true }).click();
  const firstChild = dialog.getByRole('button', { name: '运维分析，已完成', exact: true });
  await firstChild.focus(); await page.keyboard.press('End');
  await page.waitForFunction(() => document.activeElement?.getAttribute('aria-label') === '子任务请求失败，发生错误');
  await page.keyboard.press('Home');
  await page.waitForFunction(() => document.activeElement?.getAttribute('aria-label') === '本轮请求，已接收');
  await page.keyboard.press('Escape');
  await page.getByRole('button', { name: '新建对话', exact: true }).click();
  await page.getByRole('textbox', { name: '输入你的问题' }).fill('不委派，只处理当前问题。');
  await page.getByRole('button', { name: '发送消息', exact: true }).click();
  await page.getByRole('button', { name: '打开问答全景', exact: true }).waitFor();
  assert.equal(submitted.at(-1).delegationMode, 'off');
  checks.push('refresh restores persisted child hierarchy; grouped-list Home/End follows visible order; fresh chat resets permission and submits off');

  for (const [title, cycle] of [['旧版执行记录', false], ['循环依赖记录', true]]) {
    await page.getByRole('button', { name: title, exact: true }).click();
    await page.getByRole('button', { name: '打开问答全景', exact: true }).click(); await dialog.waitFor();
    assert.equal(await dialog.getByRole('button', { name: '依赖图', exact: true }).isDisabled(), cycle);
    assert.equal(await dialog.locator('.panorama-agent-lane').count(), 0);
    if (cycle) await dialog.getByText('记录含有循环依赖，使用节点列表查看原始记录。', { exact: true }).waitFor();
    else assert.equal(await dialog.locator('.panorama-graph-node').count(), 2);
    await page.keyboard.press('Escape');
  }
  checks.push('legacy trace v1 retains compact graph; cyclic legacy trace remains inspectable in list');

  await page.getByRole('button', { name: '全景记录上限验收', exact: true }).click();
  await page.getByText('本轮全景 · 部分记录', { exact: true }).waitFor();
  await page.getByRole('button', { name: '打开问答全景', exact: true }).click(); await dialog.waitFor();
  await dialog.getByRole('complementary', { name: '全景记录省略', exact: true }).getByText('记录达到上限，部分处理节点/连线已省略', { exact: true }).waitFor();
  await dialog.getByText('已省略 3 个节点、5 条连线。分组、节点数量与依赖仅涵盖已记录部分，请结合实际答复和执行记录核对。', { exact: true }).waitFor();
  const boundedDownloaded = page.waitForEvent('download'); await dialog.getByRole('button', { name: '导出 JSON', exact: true }).click();
  const boundedDownload = await boundedDownloaded; await boundedDownload.saveAs(join(output, 'bounded-trace.json'));
  assert.deepEqual(JSON.parse(readFileSync(join(output, 'bounded-trace.json'), 'utf8')), cappedTrace);
  await page.keyboard.press('Escape');
  checks.push('200-node/400-edge bound records exact omitted counts; duplicates, invalid links and late calls excluded; visible partial notice and JSON preserve omissions');

  await page.setViewportSize({ width: 320, height: 720 });
  await page.getByRole('button', { name: '打开导航', exact: true }).click();
  await page.getByRole('dialog').getByRole('button', { name: '委派执行验收', exact: true }).click();
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
  const switchBounds = await delegation.boundingBox();
  assert.ok(switchBounds && switchBounds.x >= 0 && switchBounds.x + switchBounds.width <= 320);
  await page.getByRole('button', { name: '打开问答全景', exact: true }).click(); await dialog.waitFor();
  assert.equal(await dialog.locator('.panorama-agent-group').count(), 3);
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
  await dialog.getByRole('button', { name: '子任务模型请求，已完成', exact: true }).click();
  const parent = dialog.getByRole('button', { name: '查看委派入口', exact: true });
  await parent.focus(); await page.keyboard.press('Enter');
  await page.waitForFunction(() => document.activeElement?.getAttribute('aria-label') === '运维分析，已完成');
  const focused = await page.evaluate(() => { const el = document.activeElement, r = el?.getBoundingClientRect(); return { label: el?.getAttribute('aria-label'), top: r?.top, bottom: r?.bottom }; });
  assert.equal(focused.label, '运维分析，已完成'); assert.ok(focused.top >= 0 && focused.bottom <= 720);
  await page.screenshot({ path: join(output, 'mobile-delegation-list.png'), fullPage: true });
  await dialog.getByRole('button', { name: '依赖图', exact: true }).click();
  await dialog.getByRole('button', { name: '查看全图', exact: true }).click();
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
  await page.screenshot({ path: join(output, 'mobile-delegation-graph.png'), fullPage: true });
  checks.push('320px composer and nested list fit; parent keyboard jump reveals focused node; graph scroll/fit remains inside dialog; reduced motion');
  assert.deepEqual(errors, []); assert.deepEqual(external, []); assert.equal(submitted.length, 2);
  writeFileSync(join(output, 'report.json'), JSON.stringify({ checkedAt: new Date().toISOString(), mode: 'isolated HTTP UI and trace fixture', checks, errors, externalRequests: external, submittedModes: submitted.map(input => input.delegationMode) }, null, 2));
  console.log(JSON.stringify({ checks, errors, externalRequests: external, submittedModes: submitted.map(input => input.delegationMode) }));
} finally { release(); await browser.close(); await http.close(); }
