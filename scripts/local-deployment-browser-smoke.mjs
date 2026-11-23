import assert from 'node:assert/strict';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { randomUUID, createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { chromium } from 'playwright';
import { createApplication } from '../server/app.mjs';
import { listen } from '../tests/fixtures.mjs';

// Uses the current dist with a new, disposable database, synthetic local health
// transports and input files. Never reads .env, .data or deployment reports,
// connects to the user's browser, calls a model, or executes a sandbox tool.
assert.ok(existsSync(resolve('dist/index.html')), 'Run npm run build before the local deployment browser smoke test.');
const runId = new Date().toISOString().replace(/[:.]/g, '-') + '-' + randomUUID();
const output = resolve('test-results/local-deployment-ui', runId);
mkdirSync(output, { recursive: true, mode: 0o700 });
const temporary = mkdtempSync(join(tmpdir(), 'aiops-deployment-ui-'));
const checks = [], pageErrors = [], consoleErrors = [], requests = [], externalRequests = [], httpErrors = [], screenshots = [];
const environmentKeys = ['NODE_ENV', 'ADMIN_USERNAME', 'ADMIN_PASSWORD', 'APP_ORIGIN', 'SETUP_TOKEN', 'AUTH_MODE'];
const previousEnvironment = Object.fromEntries(environmentKeys.map(key => [key, process.env[key]]));
for (const key of environmentKeys) delete process.env[key];
process.env.NODE_ENV = 'test';
let app, http, browser, page, failure, releaseProbes;
let expectedConsoleHttpDiagnostics = [], unexpectedConsoleErrors = [];
const health = { reportsPresent: true, offline: new Set(['tempo']), calls: [], barrier: null };
const measuredAt = new Date(Date.now() - 60000).toISOString();
const reports = {
  observabilityDeployment: { schemaVersion: 1, project: 'aiops-observability-local', generatedAt: measuredAt, persistent: true,
    services: {
      collector: { url: 'http://127.0.0.1:4318/v1/traces', expectedStatus: 405 },
      tempo: { url: 'http://127.0.0.1:3200/ready', expectedStatus: 200 },
      prometheus: { url: 'http://127.0.0.1:9090/-/ready', expectedStatus: 200 },
    } },
  observabilityEvidence: { schemaVersion: 1, finishedAt: measuredAt, passed: true,
    checks: { protectedMetrics: [true, true], persistedRedactedTraces: { traces: 3, spans: 15, idempotent: true },
      multiInstanceMetrics: { instances: 2, runCounts: [1, 2], fleetRuns: 3, fixtureTokens: 180 }, traceBackendRestartRecovery: true,
      collectorFailureIsolated: true, temporaryStackRemoved: true } },
  sandboxDeployment: { measuredAt, configurationPrivate: true, mcp: { endpoint: 'http://127.0.0.1:43130/mcp', healthStatus: 200 } },
  // Deliberately incomplete evidence exercises the UI's failed historical result.
  sandboxEvidence: { version: 1, measuredAt, passed: false, cleanupVerified: true,
    checks: [{ label: 'authentication-and-fixed-request-policy', passed: true, unauthorized: 401, isolationOverride: 400 }] },
};
const usageContent = 'date,provider,model,currency,tokens,tokenSource,estimatedCost\n2026-10-08,fixture,fixture-model,USD,1000,reported,0.100001\n';
const invoiceContent = JSON.stringify({ schemaVersion: 1, kind: 'invoice', records: [
  { date: '2026-10-08', provider: 'fixture', model: 'fixture-model', currency: 'USD', tokens: 1000, category: 'usage', billedCost: '0.100001' },
] });
const usagePath = join(temporary, 'fixture-usage.csv'), invoicePath = join(temporary, 'fixture-invoice.json');
writeFileSync(usagePath, usageContent, { mode: 0o600, flag: 'wx' });
writeFileSync(invoicePath, invoiceContent, { mode: 0o600, flag: 'wx' });

const waitUntil = async (check, label) => {
  const deadline = Date.now() + 15000;
  while (!await check()) {
    assert.ok(Date.now() < deadline, label);
    await new Promise(resolve => setTimeout(resolve, 40));
  }
};
const see = async text => page.getByText(text, { exact: true }).first().waitFor({ state: 'visible' });
const noOverflow = async label => {
  const dimensions = await page.evaluate(() => ({ viewport: innerWidth, document: document.documentElement.scrollWidth, body: document.body.scrollWidth }));
  assert.ok(dimensions.document <= dimensions.viewport + 1 && dimensions.body <= dimensions.viewport + 1, `${label}: ${JSON.stringify(dimensions)}`);
  return dimensions;
};
const screenshot = async (name, locator) => {
  if (locator) await locator.scrollIntoViewIfNeeded();
  const path = join(output, name + '.png');
  assert.equal(existsSync(path), false);
  await page.screenshot({ path, fullPage: false });
  chmodSync(path, 0o600); screenshots.push(path);
};
const activate = async locator => { await locator.focus(); await page.keyboard.press('Enter'); };
const responseFor = (path, method = 'GET') => page.waitForResponse(response => new URL(response.url()).pathname === path && response.request().method() === method);
const refresh = async () => {
  const pending = responseFor('/api/local-services');
  await page.getByRole('button', { name: '刷新本机状态', exact: true }).click();
  const response = await pending;
  assert.equal(response.status(), 200);
  await page.getByRole('button', { name: '刷新本机状态', exact: true }).waitFor();
  return response.json();
};
const reconcile = async () => {
  const pending = responseFor('/api/local-services/billing', 'POST');
  await page.getByRole('button', { name: '开始对账', exact: true }).click();
  return pending;
};
const uploadFixtures = async () => {
  await page.locator('.local-billing-files input[type=file]').nth(0).setInputFiles(usagePath);
  await page.locator('.local-billing-files input[type=file]').nth(1).setInputFiles(invoicePath);
  await see('fixture-usage.csv'); await see('fixture-invoice.json');
  await waitUntil(() => page.getByRole('button', { name: '开始对账', exact: true }).isEnabled(), 'Both uploaded files finish reading');
};

try {
  app = createApplication({ dataDir: join(temporary, 'data'), scheduler: false, localServices: {
    readReport: async key => health.reportsPresent ? reports[key] : null,
    probe: async id => {
      health.calls.push(id);
      if (health.barrier) await health.barrier;
      return { status: health.offline.has(id) ? 503 : id === 'collector' ? 405 : 200, body: { ok: true } };
    },
  } });
  http = await listen(app.app);
  browser = await chromium.launch({ headless: true, channel: process.env.PLAYWRIGHT_CHANNEL || 'chrome' });
  const context = await browser.newContext({ viewport: { width: 1365, height: 1000 }, acceptDownloads: true });
  const watch = currentPage => {
    currentPage.setDefaultTimeout(15000);
    currentPage.on('pageerror', error => pageErrors.push(error.message));
    currentPage.on('console', message => { if (message.type() === 'error') consoleErrors.push({ text: message.text(), location: message.location() }); });
    currentPage.on('request', request => {
      const url = new URL(request.url());
      if (url.origin === http.url && url.pathname.startsWith('/api')) requests.push({ method: request.method(), path: url.pathname });
      else if (/^https?:$/.test(url.protocol) && url.origin !== http.url) externalRequests.push(request.url());
    });
    currentPage.on('response', response => { if (response.status() >= 400) httpErrors.push({ status: response.status(), url: response.url() }); });
  };
  let failStatus = false, heldBilling = null;
  const preventExternal = async route => {
    const request = route.request(), url = new URL(request.url());
    if (/^https?:$/.test(url.protocol) && url.origin !== http.url) { await route.abort(); return; }
    if (url.pathname === '/api/local-services' && failStatus) {
      failStatus = false;
      await route.fulfill({ status: 503, contentType: 'application/json', body: JSON.stringify({ error: '验收注入：本机状态服务暂不可用' }) });
      return;
    }
    if (url.pathname === '/api/local-services/billing' && heldBilling) {
      const held = heldBilling; heldBilling = null;
      const response = await route.fetch();
      held.received(response);
      await held.release;
      await route.fulfill({ response }).catch(() => {});
      held.finished(); return;
    }
    await route.continue();
  };
  await context.route('**/*', preventExternal);
  page = await context.newPage(); watch(page);
  const setup = await context.request.post(http.url + '/api/auth/setup', { data: { username: 'deployment-admin', password: 'deployment-browser-fixture-only' } });
  assert.equal(setup.status(), 201, await setup.text());
  const created = await context.request.post(http.url + '/api/users', { data: { username: 'deployment-member', password: 'deployment-member-fixture-only', role: 'member' } });
  assert.equal(created.status(), 201, await created.text());
  await page.goto(http.url + '/#guide');
  const guide = page.getByRole('region', { name: 'AgentScope 使用与开发引导' });
  await guide.waitFor();
  const entry = guide.getByRole('button', { name: '了解部署与验收', exact: true });
  await entry.waitFor();
  assert.equal(requests.filter(request => request.path === '/api/local-services').length, 0, 'Default Guide does not probe services');
  const entryPosition = await entry.boundingBox();
  assert.ok(entryPosition && entryPosition.y < 1000, 'Deployment entry is visible without scrolling on desktop');
  await noOverflow('Default Guide at 1365px'); await screenshot('guide-entry-desktop');

  health.barrier = new Promise(resolve => { releaseProbes = resolve; });
  const initialStatus = responseFor('/api/local-services');
  await activate(entry);
  await page.locator('.local-state').filter({ hasText: '正在检查' }).first().waitFor();
  assert.equal(await page.locator('.local-state').filter({ hasText: '正在检查' }).count(), 4);
  assert.equal(await page.getByRole('button', { name: '正在检查', exact: true }).isDisabled(), true);
  await waitUntil(() => health.calls.length === 4, 'All four injected probes are reached');
  releaseProbes(); health.barrier = null;
  const first = await initialStatus; assert.equal(first.status(), 200);
  await see('接收入口可达'); await see('本机暂不可连接'); await see('就绪检查通过'); await see('MCP 入口可达');
  assert.deepEqual((await first.json()).services.map(service => [service.id, service.status]), [
    ['collector', 'online'], ['tempo', 'offline'], ['prometheus', 'online'], ['sandbox', 'online'],
  ]);
  const deploymentTab = guide.getByRole('button', { name: '部署与验收', exact: true });
  assert.equal(await deploymentTab.getAttribute('aria-pressed'), 'true');
  assert.equal(new URL(page.url()).hash, '#guide?tab=deployment');
  checks.push('Default Guide exposes a keyboard-accessible deployment entry; all four checks have pending state and service-specific reachability labels, including an offline service.');

  const observabilityProof = page.locator('.local-proof').nth(0), sandboxProof = page.locator('.local-proof').nth(1);
  await activate(observabilityProof.locator('summary'));
  assert.equal(await observabilityProof.getAttribute('open'), '');
  await observabilityProof.getByText(/该次验收通过/).waitFor(); assert.equal(await observabilityProof.locator('li').count(), 6);
  await activate(sandboxProof.locator('summary'));
  await sandboxProof.getByText(/该次验收有未通过项/).waitFor(); assert.equal(await sandboxProof.locator('li').count(), 11);
  assert.ok(await sandboxProof.locator('li').filter({ hasText: '未通过' }).count() > 0);
  await see('这是已保存的服务验收记录；上方状态是本次连通检查。它们不表示当前生产环境已通过验收。');
  await screenshot('deployment-evidence-desktop', observabilityProof);
  health.reportsPresent = false; const callsBeforeMissing = health.calls.length;
  const missing = await refresh();
  assert.ok(missing.services.every(service => service.status === 'unconfigured'));
  assert.equal(health.calls.length, callsBeforeMissing, 'Missing deployment evidence does not probe any real service');
  assert.equal(await page.locator('.local-state').filter({ hasText: '未配置本机部署' }).count(), 4);
  await observabilityProof.getByText('尚未找到可展示的验收记录。服务连通状态可单独检查。', { exact: true }).waitFor();
  await sandboxProof.getByText('尚未找到可展示的验收记录。服务连通状态可单独检查。', { exact: true }).waitFor();
  checks.push('Keyboard details expose passing and failing synthetic historical evidence; absent reports explain the gap and leave all four services unconfigured without probing.');
  health.reportsPresent = true; health.offline.clear(); await refresh();
  await see('MCP 入口可达');

  await activate(guide.getByRole('button', { name: '开始使用', exact: true }));
  assert.equal(new URL(page.url()).hash, '#guide');
  const tabPosition = await guide.getByRole('button', { name: '开始使用', exact: true }).evaluate(element => document.activeElement === element);
  assert.equal(tabPosition, true); await page.keyboard.press('Tab'); await page.keyboard.press('Enter');
  await page.locator('.local-deployment').waitFor();
  assert.equal(await deploymentTab.getAttribute('aria-pressed'), 'true');
  await page.goto(http.url + '/#guide?tab=deployment'); await page.reload();
  await see('接收入口可达');
  assert.equal(await deploymentTab.getAttribute('aria-pressed'), 'true');
  assert.equal(new URL(page.url()).hash, '#guide?tab=deployment');
  checks.push('Tab traversal and Enter activate deployment; direct hash navigation and a full reload retain it, and leaving the tab clears the query.');

  const billResult = page.locator('.local-billing-result');
  const billingPostsBefore = requests.filter(request => request.path === '/api/local-services/billing').length;
  await page.getByRole('button', { name: '载入演示数据', exact: true }).click();
  await see('演示数据：估算 0.10 USD，账单 0.12 USD；预期差额 0.02 USD。');
  assert.equal(await billResult.count(), 0);
  assert.equal(requests.filter(request => request.path === '/api/local-services/billing').length, billingPostsBefore, 'Loading examples does not issue a POST');
  const demoResponse = await reconcile(); assert.equal(demoResponse.status(), 200);
  const demo = await demoResponse.json();
  assert.equal(demo.rows[0].costDifference, '0.020000'); assert.equal(demo.status, 'needs_review');
  assert.equal(demo.productionAccepted, false); assert.equal(demo.providerAccountVerified, false);
  assert.equal(demo.inputProvenance.invoiceSource, 'user_supplied_unverified');
  await billResult.getByRole('cell', { name: /0\.020000 USD/ }).waitFor();
  await billResult.getByText('演示结果', { exact: true }).waitFor();
  await billResult.getByText(/来源未验证或缺少 tokens 时仍需复核/).waitFor();
  await page.getByText(/尚未保存真实供应商账单/).waitFor();
  const downloadPending = page.waitForEvent('download');
  await page.getByRole('button', { name: '下载对账结果', exact: true }).click();
  const download = await downloadPending; assert.equal(download.suggestedFilename(), 'billing-reconciliation.json');
  const downloadPath = join(output, 'billing-reconciliation.json'); await download.saveAs(downloadPath); chmodSync(downloadPath, 0o600);
  assert.deepEqual(JSON.parse(readFileSync(downloadPath, 'utf8')), demo, 'Downloaded JSON retains the actual API response, including provenance and approval boundaries');
  checks.push('Example loading is local until explicit billing POST; exact 0.020000 USD and unverified-source/real-invoice boundaries render, and downloaded JSON equals the actual API response.');
  await noOverflow('Deployment bill at 1365px'); await screenshot('billing-desktop', billResult);
  await page.setViewportSize({ width: 320, height: 568 });
  await noOverflow('Deployment bill at 320px');
  const table = page.getByRole('region', { name: '费用差额明细' });
  const scroll = await table.evaluate(element => ({ client: element.clientWidth, total: element.scrollWidth, overflow: getComputedStyle(element).overflowX }));
  assert.ok(scroll.total > scroll.client && scroll.overflow === 'auto', 'Billing table scrolls inside its own region at 320px');
  await table.focus(); await page.keyboard.press('ArrowRight');
  await waitUntil(() => table.evaluate(element => element.scrollLeft > 0), 'Keyboard scrolls the narrow billing region');
  await screenshot('billing-mobile', billResult);
  await screenshot('deployment-mobile', page.locator('.local-intro'));
  await page.setViewportSize({ width: 1365, height: 1000 });
  checks.push('1365px and 320px layouts fit the page; narrow billing detail scrolls internally with a keyboard-accessible region.');

  await uploadFixtures();
  assert.equal(await billResult.count(), 0, 'Replacing demo files clears the old verdict');
  const matchedResponse = await reconcile(); assert.equal(matchedResponse.status(), 200);
  const matched = await matchedResponse.json();
  assert.equal(matched.status, 'matched'); assert.equal(matched.costsMatch, true); assert.equal(matched.tokensMatch, true);
  assert.equal(matched.rows[0].costDifference, '0.000000'); assert.equal(matched.rows[0].tokenDifference, '0');
  assert.equal(matched.inputProvenance.usageSha256, createHash('sha256').update(usageContent).digest('hex'));
  assert.equal(matched.inputProvenance.invoiceSha256, createHash('sha256').update(invoiceContent).digest('hex'));
  await billResult.getByRole('heading', { name: '金额与用量一致', exact: true }).waitFor();
  assert.equal(await billResult.getByText('演示结果', { exact: true }).count(), 0);
  await page.locator('.local-billing-files input[type=file]').nth(0).setInputFiles({ name: 'malformed.csv', mimeType: 'text/csv', buffer: Buffer.from('date,provider\nnot-a-date,fixture\n') });
  assert.equal(await billResult.count(), 0, 'Selecting malformed input immediately clears a previously passing result');
  await see('malformed.csv');
  const malformed = await reconcile(); assert.equal(malformed.status(), 400);
  await page.getByRole('alert').filter({ hasText: '账单文件格式或字段无效' }).waitFor();
  assert.equal(await billResult.count(), 0);
  await page.locator('.local-billing-files input[type=file]').nth(0).setInputFiles(usagePath);
  await see('fixture-usage.csv');
  assert.equal(await page.getByRole('alert').count(), 0, 'Replacing a file clears stale validation failure');
  checks.push('Real file inputs read a temporary CSV and JSON, verify both content hashes and matching cost/tokens; malformed CSV has a readable HTTP 400 error, and replacing files clears old result/error.');

  // Hold an actual API response to verify that replacing input wins over a
  // late response. This is a request race, rather than a synthetic verdict.
  let receivedResponse, releaseBilling, billingFinished;
  const received = new Promise(resolve => { receivedResponse = resolve; });
  const release = new Promise(resolve => { releaseBilling = resolve; });
  const finished = new Promise(resolve => { billingFinished = resolve; });
  heldBilling = { received: receivedResponse, release, finished: billingFinished };
  await page.getByRole('button', { name: '开始对账', exact: true }).click();
  const heldResponse = await received; assert.equal(heldResponse.status(), 200);
  await page.getByRole('button', { name: '正在对账', exact: true }).waitFor();
  await page.locator('.local-billing-files input[type=file]').nth(1).setInputFiles({ name: 'replacement.csv', mimeType: 'text/csv', buffer: Buffer.from('date,provider,model,currency,tokens,billedCost,category\n2026-10-08,fixture,fixture-model,USD,1000,0.200001,usage\n') });
  await see('replacement.csv'); releaseBilling(); await finished;
  await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
  assert.equal(await billResult.count(), 0, 'Aborted response must not republish an old verdict');
  const replacementResponse = await reconcile(); assert.equal(replacementResponse.status(), 200);
  assert.equal((await replacementResponse.json()).rows[0].costDifference, '0.100000');
  await billResult.getByRole('cell', { name: /0\.100000 USD/ }).waitFor();
  checks.push('A held real billing response cannot publish an old passing verdict after a file replacement; the next explicit POST uses the replacement data.');

  failStatus = true; const failedStatus = responseFor('/api/local-services');
  await page.getByRole('button', { name: '刷新本机状态', exact: true }).click();
  assert.equal((await failedStatus).status(), 503);
  await page.getByRole('alert').filter({ hasText: '无法取得本机状态：验收注入：本机状态服务暂不可用' }).waitFor();
  assert.equal(await page.locator('.local-state').filter({ hasText: '尚未检查' }).count(), 4, 'Failed request must not leave prior online labels');
  await refresh(); await see('MCP 入口可达');
  assert.equal(await page.getByRole('alert').count(), 0);
  checks.push('Injected HTTP 503 shows a Chinese status error, clears stale online labels, and refresh recovers through a new health request.');

  const memberContext = await browser.newContext({ viewport: { width: 320, height: 568 } });
  await memberContext.route('**/*', preventExternal);
  const memberPage = await memberContext.newPage(); watch(memberPage);
  const memberLogin = await memberContext.request.post(http.url + '/api/auth/login', { data: { username: 'deployment-member', password: 'deployment-member-fixture-only' } });
  assert.equal(memberLogin.status(), 200, await memberLogin.text());
  const memberRequestStart = requests.length, probeStart = health.calls.length;
  await memberPage.goto(http.url + '/#guide?tab=deployment');
  await memberPage.getByText('服务状态与账单导入由管理员查看。', { exact: true }).waitFor();
  await memberPage.getByText('请联系管理员导入用量与账单，查看实际对账结果。', { exact: true }).waitFor();
  assert.equal(await memberPage.getByRole('button', { name: /刷新本机状态|载入演示数据|开始对账|下载对账结果/ }).count(), 0);
  assert.equal(await memberPage.locator('input[type=file]').count(), 0);
  await memberPage.getByText(/源码最多 64 KiB/).waitFor();
  await memberPage.getByText(/Docker 与宿主共享内核/).waitFor();
  await memberPage.reload();
  await memberPage.getByText('服务状态与账单导入由管理员查看。', { exact: true }).waitFor();
  await memberPage.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
  assert.equal(health.calls.length, probeStart);
  assert.equal(requests.slice(memberRequestStart).filter(request => request.path.startsWith('/api/local-services')).length, 0);
  const adminPage = page; page = memberPage;
  await noOverflow('Member deployment at 320px'); await screenshot('member-mobile', page.locator('.local-intro')); page = adminPage;
  await memberContext.close();
  checks.push('Member directly opens and refreshes the explanatory page with readable boundaries at 320px, no administrator controls, health probes or billing requests.');

  unexpectedConsoleErrors = consoleErrors.filter(error => {
    const status = error.text.match(/^Failed to load resource: the server responded with a status of (400|503)\b/)?.[1];
    return !status || !httpErrors.some(response => response.status === Number(status) && response.url === error.location.url &&
      new URL(response.url).origin === http.url && ['/api/local-services', '/api/local-services/billing'].includes(new URL(response.url).pathname));
  });
  expectedConsoleHttpDiagnostics = consoleErrors.filter(error => !unexpectedConsoleErrors.includes(error));
  assert.deepEqual(unexpectedConsoleErrors, []);
  assert.deepEqual(pageErrors, []); assert.deepEqual(externalRequests, []);
  assert.deepEqual(httpErrors.map(error => [new URL(error.url).pathname, error.status]).sort(), [
    ['/api/local-services', 503], ['/api/local-services/billing', 400],
  ].sort());
  assert.equal(app.store.get('SELECT COUNT(*) AS count FROM executions').count, 0);
  assert.equal(app.store.get('SELECT COUNT(*) AS count FROM tool_steps').count, 0);
  assert.equal(app.store.get('SELECT COUNT(*) AS count FROM messages').count, 0);
  assert.deepEqual(requests.filter(request => request.method !== 'GET' && request.path !== '/api/local-services/billing'), []);
  checks.push('Zero Agent runs, tool steps, messages, model requests, external browser requests, page errors or unexpected console errors; only the intended billing POSTs and exact HTTP 400/503 diagnostics occur.');
} catch (error) {
  failure = error;
  try { if (page && !page.isClosed()) await screenshot('failure'); } catch {}
} finally {
  releaseProbes?.();
  await browser?.close().catch(() => {});
  await http?.close().catch(() => {});
  await app?.close().catch(() => {});
  rmSync(temporary, { recursive: true, force: true });
  for (const key of environmentKeys) {
    if (previousEnvironment[key] === undefined) delete process.env[key]; else process.env[key] = previousEnvironment[key];
  }
  writeFileSync(join(output, 'browser-report.json'), JSON.stringify({ schemaVersion: 1, measuredAt: new Date().toISOString(),
    mode: 'temporary-application-synthetic-health-real-billing', passed: !failure,
    productionAccepted: false, realDeploymentAccepted: false, originalDataDirectoryRead: false, checks, screenshots, requests,
    pageErrors, consoleErrors, expectedConsoleHttpDiagnostics, unexpectedConsoleErrors, httpErrors, externalRequests,
    ...(failure ? { failure: String(failure.stack || failure) } : {}),
  }, null, 2) + '\n', { mode: 0o600, flag: 'wx' });
}
console.log(JSON.stringify({ passed: !failure, checks: checks.length, output, ...(failure ? { error: failure.message } : {}) }, null, 2));
if (failure) throw failure;
