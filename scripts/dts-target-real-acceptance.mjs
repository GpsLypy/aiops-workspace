import { responsesFixture } from '../tests/responses-fixture.mjs';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { createDecipheriv, createHash, randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import express from 'express';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { chromium, request as playwrightRequest } from 'playwright';
import { createApplication } from '../server/app.mjs';
import { hashPassword } from '../server/auth.mjs';
import { authorizeTool, indexKnowledge } from '../server/governance.mjs';
import { validateArguments } from '../server/execution.mjs';
import { connectMcp, discover } from '../server/mcp.mjs';
import { redactText } from '../server/security.mjs';
import { listen } from '../tests/fixtures.mjs';
import { candidateDigest } from './agent-candidate.mjs';

const TOOL = 'dts_get_job_status';
const FIELDS = ['jobid', 'business_domain', 'area_name'];
const RESOURCE_NAMES = [
  ['knowledge', 'DTS cn_east 状态说明'],
  ['skills', 'DTS cn_east 只读查询'],
  ['mcp', 'DTS cn_east MCP'],
  ['agents', 'DTS cn_east 运维'],
];

export function selectDtsResources(rows, job) {
  const parsed = rows.map(row => ({ row, data: JSON.parse(row.data) }));
  const selected = RESOURCE_NAMES.map(([kind, name]) => {
    const matches = parsed.filter(item => item.row.kind === kind && item.data.name === name);
    assert.equal(matches.length, 1, `Expected one saved ${name} resource`);
    return matches[0];
  });
  const [knowledge, skill, mcp, agent] = selected;
  const owner = mcp.row.owner_id;
  assert.ok(selected.every(item => item.row.owner_id === owner), 'DTS resources must have the same owner');
  assert.deepEqual(agent.data.knowledgeIds, [knowledge.row.id]);
  assert.deepEqual(agent.data.skillIds, [skill.row.id]);
  assert.deepEqual(agent.data.mcpIds, [mcp.row.id]);
  assert.ok(selected.every(item => item.data.status === '已启用'));
  assert.ok(selected.every(item => item.data.visibility === 'private' &&
    Array.isArray(item.data.readerIds) && item.data.readerIds.length === 0 &&
    Array.isArray(item.data.managerIds) && item.data.managerIds.length === 0),
  'DTS acceptance requires four private owner-only resources');
  assert.ok([skill, agent].every(item => item.data.publication === 'published'));
  assert.deepEqual(mcp.data.allowedTools, [TOOL]);
  assert.equal(mcp.data.environment, 'production');
  const endpoint = new URL(mcp.data.endpoint);
  assert.equal(endpoint.protocol, 'http:');
  assert.ok(['127.0.0.1', 'localhost'].includes(endpoint.hostname), 'DTS connector must be local');
  const policy = mcp.data.toolPolicies?.[TOOL];
  assert.equal(policy?.risk, 'read');
  assert.deepEqual(policy.roles, ['admin']);
  assert.deepEqual(policy.userIds, [owner], 'Copied policy must authorize the original owner ID');
  assert.deepEqual(policy.environments, ['production']);
  assert.equal(policy.automatic, false);
  assert.equal(policy.maxItems, 1);
  assert.deepEqual(policy.requiredTargetFields, FIELDS, 'Source DTS policy has not enabled three-field target binding');
  assert.deepEqual(policy.constraints?.business_domain, ['general']);
  assert.deepEqual(policy.constraints?.area_name, ['cn_east']);
  assert.ok(!Object.hasOwn(policy.constraints, 'jobid'), 'Same-area negative requires the existing region-wide job scope');
  assert.match(job, /^[1-9]\d{0,18}$/);
  assert.ok(BigInt(job) <= 9223372036854775807n);
  return { selected, owner, mcp, agent };
}

export function parseArgs(argv) {
  const modelOverride = argv.length === 5 && argv[3] === '--model' ? argv[4] : null;
  assert.ok((argv.length === 3 || modelOverride && argv[0] === '--real') &&
    ['--real', '--direct-only'].includes(argv[0]) && argv[1] === '--job' && argv[2] &&
    (!modelOverride || /^[A-Za-z0-9._-]{1,150}$/.test(modelOverride)),
  'Usage: SOURCE_DIR=.data npm run test:target:real -- --real|--direct-only --job AUTHORIZED_ID [--model MODEL]');
  return { directOnly: argv[0] === '--direct-only', job: argv[2], modelOverride };
}

function sourceSnapshot(sourceDir) {
  const key = readFileSync(join(sourceDir, 'master.key'));
  assert.equal(key.length, 32, 'Source master key must be 32 bytes');
  const db = new DatabaseSync(join(sourceDir, 'aiops.sqlite'), { readOnly: true });
  try {
    const schema = db.prepare('PRAGMA user_version').get().user_version;
    assert.ok(schema >= 6, 'Source workspace must already use schema v6');
    const model = db.prepare('SELECT value FROM settings WHERE key=?').get('model');
    const resources = db.prepare('SELECT * FROM resources ORDER BY id').all();
    const digest = createHash('sha256').update(key).update(JSON.stringify({ schema, model, resources })).digest('hex');
    return { key, schema, model, resources, digest };
  } finally { db.close(); }
}

function decrypt(key, value) {
  if (!value) return '';
  const [iv, tag, data] = value.split('.').map(part => Buffer.from(part, 'base64'));
  const decipher = createDecipheriv('aes-256-gcm', key, iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(data), decipher.final()]).toString('utf8');
}

function outputValue(response) {
  if (response.structuredContent !== undefined) return response.structuredContent;
  const text = response.content?.find(item => item.type === 'text')?.text;
  return text ? JSON.parse(text) : null;
}

export function validateDirectResult(response, job, started, ended) {
  assert.notEqual(response.isError, true, 'Real DTS MCP tool returned an error');
  const value = outputValue(response);
  assert.equal(value?.fixture, false);
  assert.equal(value?.jobid, job);
  assert.equal(value?.business_domain, 'general');
  assert.equal(value?.area_name, 'cn_east');
  const queriedAt = Date.parse(value?.queried_at);
  assert.ok(Number.isFinite(queriedAt), 'No real DTS query time');
  assert.ok(queriedAt >= started - 2000 && queriedAt <= ended + 2000, 'DTS query time is outside this run');
  return { queriedAt: value.queried_at, fixture: false, argumentsExactlyMatched: true };
}

export async function within(phase, timeoutMs, action) {
  let timer;
  try {
    return await Promise.race([
      Promise.resolve().then(action),
      new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(`${phase} exceeded ${timeoutMs} ms`)), timeoutMs); }),
    ]);
  } finally { clearTimeout(timer); }
}

export function failedPositiveSnapshot(store, owner, callToolCount, sanitize = value => value) {
  const run = store.get('SELECT id,status,error FROM executions WHERE user_id=? ORDER BY created DESC LIMIT 1', owner);
  const steps = run ? store.get('SELECT count(*) AS n FROM tool_steps WHERE run_id=?', run.id).n : 0;
  return { kind: 'real-model-real-DTS', passed: false, runId: run?.id || null,
    executionStatus: run?.status || null, persistedToolSteps: steps, mcpCallToolCount: callToolCount,
    executionError: run?.error ? sanitize(run.error) : null };
}

function startProposalModel() {
  const app = express(); app.use(express.json());
  let proposal = null; let proposals = 0;
  app.post('/v1/responses', responsesFixture, (req, res) => {
    const tool = req.body.tools?.[0]?.function?.name;
    if (!tool || !proposal) return res.status(400).json({ error: 'No controlled proposal or selected tool' });
    proposals++;
    return res.json({ choices: [{ message: { role: 'assistant', content: '', tool_calls: [{
      id: `controlled-${proposals}`, type: 'function', function: { name: tool, arguments: JSON.stringify(proposal) },
    }] } }], usage: { prompt_tokens: 20, completion_tokens: 10, total_tokens: 30 } });
  });
  return listen(app).then(server => ({ ...server, propose: args => { proposal = args; proposals = 0; }, count: () => proposals }));
}

async function main() {
  const { directOnly, job, modelOverride } = parseArgs(process.argv.slice(2));
  assert.ok(!process.env.MASTER_KEY_FILE, 'Unset MASTER_KEY_FILE so the temporary workspace creates its own key');
  assert.ok(!process.env.ADMIN_USERNAME && !process.env.ADMIN_PASSWORD,
    'Unset ADMIN_USERNAME and ADMIN_PASSWORD so the temporary workspace has only the copied policy owner');
  const sourceDir = resolve(process.env.SOURCE_DIR || '.data');
  const stamp = new Date().toISOString().replace(/[-:]/g, '').replace('T', '-').slice(0, 15);
  let output = resolve(`test-results/dts-target-real-${stamp}`);
  if (existsSync(output)) output += `-${randomUUID().slice(0, 8)}`;
  mkdirSync(output, { recursive: true, mode: 0o700 });
  const secrets = [job];
  const report = { version: 1, startedAt: new Date().toISOString(),
    mode: directOnly ? 'real-DTS-direct-SDK-and-local-model-negative' : 'real-model-browser-positive-and-local-model-negative',
    schedulerEnabled: false, externalNotificationsEnabled: false, productionApproved: false,
    realModelPositiveVerified: false, savedModelPositiveVerified: false,
    candidateBefore: candidateDigest(), sourceConfigurationHashBefore: null,
    resourceRevisions: [], positive: null, direct: null, negatives: [], failures: [], stages: [] };
  let source, selection, application, http, apiClient, browserServer, browser, page, modelServer, temporaryDir, originalCallTool;
  let callToolCount = 0;
  let phase = 'preflight';
  const mark = name => { phase = name; report.stages.push({ phase: name, at: new Date().toISOString() }); };
  function safe(value) {
    if (typeof value === 'string') {
      let text = redactText(value);
      for (const secret of secrets.filter(Boolean)) text = text.replaceAll(secret, '[REDACTED]');
      return text.replace(/https?:\/\/[^\s\]\)"'<>]+/g, '[REDACTED_URL]');
    }
    if (Array.isArray(value)) return value.map(safe);
    if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, safe(item)]));
    return value;
  }
  const errorText = error => safe(error?.message || String(error)).slice(0, 1200);
  function writeReport() {
    const json = JSON.stringify(safe(report), null, 2) + '\n';
    for (const secret of secrets.filter(secret => secret?.length >= 8)) assert.ok(!json.includes(secret), 'Secret leaked to report');
    writeFileSync(join(output, 'report.json'), json, { mode: 0o600 });
  }
  const binding = (mcpId, id) => ({ resourceId: mcpId, tool: TOOL, environment: 'production',
    arguments: { jobid: id, business_domain: 'general', area_name: 'cn_east' } });
  try {
    mark('source-snapshot');
    source = sourceSnapshot(sourceDir);
    report.sourceConfigurationHashBefore = source.digest;
    selection = selectDtsResources(source.resources, job);
    let saved, providerKey;
    if (!directOnly) {
      saved = JSON.parse(source.model?.value || 'null');
      assert.ok(saved?.baseUrl && saved?.model && saved?.apiKeyEncrypted, 'Saved real model is incomplete');
      report.savedModel = saved.model;
      report.modelUsed = modelOverride || saved.model;
      report.modelOverride = !!modelOverride;
      if (modelOverride) saved = { ...saved, model: modelOverride };
      providerKey = decrypt(source.key, saved.apiKeyEncrypted);
      secrets.push(providerKey, saved.baseUrl, saved.apiKeyEncrypted);
    }
    secrets.push(selection.mcp.data.endpoint);
    mark('temporary-workspace');
    temporaryDir = mkdtempSync(join(tmpdir(), 'aiops-dts-target-real-'));
    application = createApplication({ dataDir: temporaryDir, scheduler: false });
    const password = randomUUID() + randomUUID(); secrets.push(password);
    const username = `dts-target-${randomUUID().slice(0, 8)}`;
    application.store.run('INSERT INTO users VALUES(?,?,?,?,?,?,?)', selection.owner, username, 'DTS target acceptance', hashPassword(password), 'admin', 1, new Date().toISOString());
    application.store.transaction(() => {
      for (const { row, data: original } of selection.selected) {
        const data = structuredClone(original);
        const token = decrypt(source.key, data.tokenEncrypted); if (token) secrets.push(token);
        data.tokenEncrypted = application.store.encrypt(token);
        application.store.run('INSERT INTO resources VALUES(?,?,?,?,?,?)', row.id, row.kind, row.owner_id, JSON.stringify(data), row.created, row.updated);
        if (row.kind === 'knowledge') indexKnowledge(application.store, application.store.resource(row));
        report.resourceRevisions.push({ kind: row.kind, id: row.id, revision: data.revision });
      }
    });
    if (!directOnly) application.store.setSetting('model', { ...saved, apiKeyEncrypted: application.store.encrypt(providerKey) });
    http = await listen(application.app);
    apiClient = await playwrightRequest.newContext({ baseURL: http.url });
    const apiLogin = await apiClient.post('/api/auth/login', { data: { username, password } });
    assert.equal(apiLogin.status(), 200, 'Independent negative-test login failed');
    mark('worker-warmup');
    await application.engine.warmup();
    originalCallTool = Client.prototype.callTool;
    Client.prototype.callTool = function (...args) { callToolCount++; return originalCallTool.apply(this, args); };
    if (directOnly) {
      mark('direct-mcp');
      let connection;
      const started = Date.now();
      const callsBefore = callToolCount;
      try {
        const resource = application.store.resource(application.store.get('SELECT * FROM resources WHERE id=?', selection.mcp.row.id));
        const args = binding(selection.mcp.row.id, job).arguments;
        assert.equal(authorizeTool({ id: selection.owner, role: 'admin' }, resource, TOOL, args, { environment: 'production' }).risk, 'read');
        connection = await connectMcp(application.store, resource);
        const tool = (await discover(connection.client)).find(item => item.name === TOOL);
        assert.ok(tool, 'Real DTS tool was not discovered');
        validateArguments(tool.inputSchema, args);
        const response = await connection.client.callTool({ name: TOOL, arguments: args }, undefined, { timeout: 30000 });
        const ended = Date.now();
        const result = validateDirectResult(response, job, started, ended);
        assert.equal(callToolCount - callsBefore, 1, 'Direct DTS round must call the tool exactly once');
        report.direct = { kind: 'real-DTS-direct-SDK', passed: true, ...result, mcpCallToolCount: 1,
          persistedToolSteps: 0, modelCalls: 0, durationMs: ended - started };
      } catch (error) {
        report.failures.push({ phase, error: errorText(error) });
        report.direct = { kind: 'real-DTS-direct-SDK', passed: false, mcpCallToolCount: callToolCount - callsBefore,
          persistedToolSteps: 0, modelCalls: 0, durationMs: Date.now() - started };
      } finally {
        if (connection) try { await within('direct-mcp-close', 5000, () => connection.close()); }
        catch (error) { report.failures.push({ phase: 'direct-mcp-close', error: errorText(error) }); }
      }
    } else {
    try {
    mark('browser-launch');
    browserServer = await chromium.launchServer({ channel: process.env.PLAYWRIGHT_CHANNEL || 'chrome', headless: false });
    browser = await within('browser-connect', 15000, () => chromium.connect(browserServer.wsEndpoint()));
    page = await browser.newPage({ viewport: { width: 1360, height: 900 } });
    page.setDefaultTimeout(30000);
    const pageErrors = []; page.on('pageerror', error => pageErrors.push(errorText(error)));
    const login = await page.request.post(`${http.url}/api/auth/login`, { data: { username, password } });
    assert.equal(login.status(), 200, 'Temporary acceptance login failed');
    await page.goto(`${http.url}/#chat`);
    await page.getByRole('button', { name: '新建对话', exact: true }).click();
    await page.getByRole('button', { name: 'Agent', exact: true }).click();
    await page.locator(`.agent-menu [role=option][data-agent-id="${selection.agent.row.id}"]`).click();
    const control = page.locator('.chat-page .target-binding-control');
    await control.locator('summary').click();
    await control.getByLabel('任务 ID').fill(job);
    await control.getByRole('button', { name: '确认目标' }).click();
    await control.getByText('已确认').waitFor();
    mark('browser-target-confirmed');
    const request = page.waitForRequest(item => item.url() === `${http.url}/api/chat` && item.method() === 'POST');
    const stream = page.waitForResponse(item => item.url() === `${http.url}/api/chat` && item.request().method() === 'POST');
    const before = Date.now();
    await page.getByRole('textbox', { name: '输入你的问题' }).fill(`只读查询 DTS 任务 ${job}，business_domain=general，area_name=cn_east；报告当前状态及查询时间。`);
    await page.getByRole('button', { name: '发送消息' }).click();
    mark('browser-response');
    assert.deepEqual((await request).postDataJSON().targetBinding, binding(selection.mcp.row.id, job));
    const browserResponse = await stream;
    assert.equal(browserResponse.status(), 200, 'Browser chat stream did not start');
    await within('positive-execution', 120000, async () => {
      while (true) {
        const run = application.store.get('SELECT status FROM executions WHERE user_id=? ORDER BY created DESC LIMIT 1', selection.owner);
        if (run && ['success', 'failed', 'interrupted', 'cancelled', 'unknown'].includes(run.status)) return;
        await new Promise(resolve => setTimeout(resolve, 100));
      }
    });
    mark('browser-settled');
    await page.waitForFunction(() => !document.querySelector('.chat-progress'), null, { timeout: 15000 });
    const ended = Date.now();
    const positiveRun = application.store.get("SELECT * FROM executions WHERE user_id=? ORDER BY created DESC LIMIT 1", selection.owner);
    assert.ok(positiveRun, 'No persisted real-model execution');
    const steps = application.store.all('SELECT * FROM tool_steps WHERE run_id=?', positiveRun.id);
    report.positive = { ...failedPositiveSnapshot(application.store, selection.owner, callToolCount, safe),
      conversationId: positiveRun.conversation_id, durationMs: ended - before, pageErrors };
    assert.equal(positiveRun.status, 'success', 'Real-model execution did not succeed');
    assert.equal(steps.length, 1, 'Real-model round must persist exactly one DTS query');
    assert.equal(callToolCount, 1, 'Real-model round must call the real DTS tool exactly once');
    const step = steps[0];
    const argumentsUsed = JSON.parse(application.store.decrypt(step.arguments_encrypted));
    assert.deepEqual(argumentsUsed, binding(selection.mcp.row.id, job).arguments);
    assert.equal(step.resource_id, selection.mcp.row.id);
    assert.equal(step.resource_revision, selection.mcp.data.revision);
    assert.equal(step.tool, TOOL);
    assert.equal(step.environment, 'production');
    assert.equal(step.status, 'success');
    assert.ok(step.response_encrypted, 'No encrypted raw MCP response was persisted');
    const raw = outputValue(JSON.parse(application.store.decrypt(step.response_encrypted)));
    const persisted = JSON.parse(step.result);
    assert.deepEqual(raw, persisted, 'Raw MCP output differs from the persisted bounded result');
    for (const value of [raw, persisted]) {
      assert.equal(value.fixture, false);
      assert.equal(value.jobid, job);
      assert.equal(value.business_domain, 'general');
      assert.equal(value.area_name, 'cn_east');
      assert.ok(Number.isFinite(Date.parse(value.queried_at)), 'No real DTS query time');
      assert.ok(Date.parse(value.queried_at) >= before - 2000 && Date.parse(value.queried_at) <= ended + 2000, 'DTS query time is outside this run');
    }
    const storedReply = application.store.get("SELECT content FROM messages WHERE conversation_id=? AND role='assistant' ORDER BY seq DESC LIMIT 1", positiveRun.conversation_id);
    assert.ok(storedReply?.content?.trim(), 'No nonempty persisted assistant answer');
    assert.ok(storedReply.content.includes(job), 'Persisted answer does not identify the confirmed task');
    const visibleBefore = await page.locator('.message.assistant .message-body').last().innerText();
    assert.ok(visibleBefore.includes(job), 'Browser answer does not identify the confirmed task');
    mark('browser-refresh');
    await page.reload();
    await page.locator('.recent-chat').first().click();
    const visibleAfter = await page.locator('.message.assistant .message-body').last().innerText();
    assert.equal(visibleAfter, visibleBefore, 'Refreshed browser answer differs from the original view');
    report.positive = { kind: 'real-model-real-DTS', passed: true, runId: positiveRun.id, conversationId: positiveRun.conversation_id,
      resourceId: step.resource_id, revision: step.resource_revision, persistedStepId: step.id, stepStatus: step.status,
      argumentsExactlyMatched: true, fixture: false, queriedAt: persisted.queried_at, durationMs: ended - before,
      persistedAnswerNonempty: true, browserRefreshConsistent: true,
      mcpCallToolCount: callToolCount, pageErrors };
    assert.deepEqual(pageErrors, []);
    } catch (error) {
      report.failures.push({ phase, error: errorText(error) });
      try {
        const latest = application.store.get('SELECT id,status FROM executions WHERE user_id=? ORDER BY created DESC LIMIT 1', selection.owner);
        if (latest && !['success', 'failed', 'interrupted', 'cancelled', 'unknown'].includes(latest.status)) {
          mark('positive-cancel');
          try { application.execution.cancel({ id: selection.owner, role: 'admin' }, latest.id); }
          catch (cancelError) {
            const current = application.store.get('SELECT status FROM executions WHERE id=?', latest.id);
            if (!['success', 'failed', 'interrupted', 'cancelled', 'unknown'].includes(current?.status)) throw cancelError;
          }
          await within('positive-run-idle', 10000, () => application.execution.idle());
        }
      } catch (snapshotError) {
        report.failures.push({ phase: 'positive-settlement', error: errorText(snapshotError) });
      }
      try { report.positive = { ...failedPositiveSnapshot(application.store, selection.owner, callToolCount, errorText),
        ...(report.positive?.durationMs ? { durationMs: report.positive.durationMs } : {}) }; }
      catch (snapshotError) { report.failures.push({ phase: 'positive-snapshot', error: errorText(snapshotError) }); }
      if (application.execution.stats().active || application.execution.stats().queued) throw new Error('Positive execution remained active; controlled negatives were not started');
    }
    }

    mark('controlled-negatives');
    modelServer = await startProposalModel();
    application.store.setSetting('model', { baseUrl: `${modelServer.url}/v1`, model: 'controlled-target-proposal', apiType: 'responses', temperature: null });
    const wrongJob = job === '1' ? '2' : '1';
    for (const [name, proposed] of [
      ['same-area-wrong-job', binding(selection.mcp.row.id, wrongJob).arguments],
      ['missing-job', { business_domain: 'general', area_name: 'cn_east' }],
      ['extra-argument', { ...binding(selection.mcp.row.id, job).arguments, unexpected: 'value' }],
    ]) {
      modelServer.propose(proposed);
      const callsBefore = callToolCount;
      const requestKey = randomUUID();
      let response, body, run;
      try {
        mark(`controlled-${name}`);
        response = await apiClient.post('/api/chat', { data: {
          text: `受控负例 ${name}`, agentId: selection.agent.row.id, targetBinding: binding(selection.mcp.row.id, job),
          useKnowledge: false, reviewMode: 'off', requestKey,
        } });
        body = await response.json();
        run = body.runId && application.store.get('SELECT * FROM executions WHERE id=?', body.runId);
      } catch (error) { report.failures.push({ phase, error: errorText(error) }); }
      run ||= application.store.get('SELECT * FROM executions WHERE request_key=?', requestKey);
      const stepCount = run ? application.store.get('SELECT count(*) AS n FROM tool_steps WHERE run_id=?', run.id).n : 0;
      const actualCalls = callToolCount - callsBefore;
      const targetRejected = body?.error === '工具参数与本轮确认的目标不一致' && run?.error === body.error;
      const passed = modelServer.count() > 0 && response?.status() === 403 && targetRejected &&
        run?.status === 'failed' && stepCount === 0 && actualCalls === 0;
      report.negatives.push({ kind: 'controlled-local-model-proposal', name, passed: !!passed, modelProposals: modelServer.count(),
        executionStatus: run?.status || null, targetBindingRejected: targetRejected,
        persistedToolSteps: stepCount, mcpCallToolCount: actualCalls,
        httpStatus: response?.status() || null });
      if (!passed) report.failures.push({ phase, error: `Controlled ${name} did not fail before MCP call` });
    }
  } catch (error) {
    report.failures.push({ phase, error: errorText(error) });
    if (!report.positive && application?.store && selection?.owner) {
      try { report.positive = failedPositiveSnapshot(application.store, selection.owner, callToolCount, safe); }
      catch (snapshotError) { report.failures.push({ phase: 'positive-snapshot', error: errorText(snapshotError) }); }
    }
  }
  finally {
    if (originalCallTool) Client.prototype.callTool = originalCallTool;
    const workerPids = application?.engine.health()?.workers?.map(worker => worker.pid).filter(Number.isSafeInteger) || [];
    async function close(name, action, timeoutMs = 15000, fallback) {
      mark(`cleanup-${name}`);
      try { await within(`cleanup-${name}`, timeoutMs, action); }
      catch (error) {
        report.failures.push({ phase: `cleanup-${name}`, error: errorText(error) });
        if (fallback) try { await within(`cleanup-${name}-fallback`, 5000, fallback); }
        catch (fallbackError) { report.failures.push({ phase: `cleanup-${name}-fallback`, error: errorText(fallbackError) }); }
      }
    }
    await close('browser', () => browser?.close(), 10000, () => browserServer?.kill());
    await close('browser-process', () => browserServer?.close(), 10000, () => browserServer?.kill());
    await close('negative-client', () => apiClient?.dispose());
    await close('local-model', () => modelServer?.close());
    await close('http', () => http?.close(), 10000, () => http?.server.closeAllConnections());
    await close('application', () => application?.close(), 15000, () => {
      application?.engine.stop();
      for (const pid of workerPids) try { process.kill(-pid, 'SIGKILL'); } catch (error) { if (error.code !== 'ESRCH') throw error; }
    });
    if (temporaryDir) { try { rmSync(temporaryDir, { recursive: true, force: true }); } catch (error) { report.failures.push({ phase: 'temporary-cleanup', error: errorText(error) }); } }
    source?.key.fill(0);
    report.candidateAfter = candidateDigest();
    report.candidateUnchanged = report.candidateBefore.sourceDigest === report.candidateAfter.sourceDigest;
    try {
      const after = sourceSnapshot(sourceDir);
      report.sourceConfigurationHashAfter = after.digest;
      report.sourceConfigurationUnchanged = report.sourceConfigurationHashBefore === report.sourceConfigurationHashAfter;
      after.key.fill(0);
    }
    catch (error) { report.failures.push({ phase: 'source-readback', error: errorText(error) }); }
    report.finishedAt = new Date().toISOString();
    const evidenceComplete = !!report.positive?.passed && report.negatives.length === 3 && report.negatives.every(item => item.passed) &&
      !report.failures.length && report.candidateUnchanged && report.sourceConfigurationUnchanged;
    report.passed = !directOnly && !modelOverride && evidenceComplete;
    report.realModelPositiveVerified = !directOnly && !!report.positive?.passed;
    report.savedModelPositiveVerified = !directOnly && !modelOverride && !!report.positive?.passed;
    report.alternateModelEvidenceComplete = !directOnly && !!modelOverride && evidenceComplete;
    report.directOnlyEvidenceComplete = directOnly && !!report.direct?.passed && report.negatives.length === 3 &&
      report.negatives.every(item => item.passed) && !report.failures.length && report.candidateUnchanged && report.sourceConfigurationUnchanged;
    writeReport();
    console.log(JSON.stringify({ passed: report.passed, alternateModelEvidenceComplete: report.alternateModelEvidenceComplete,
      directOnlyEvidenceComplete: report.directOnlyEvidenceComplete,
      report: join(output, 'report.json'), positive: !!report.positive?.passed, direct: !!report.direct?.passed,
      negatives: report.negatives.filter(item => item.passed).length, sourceConfigurationUnchanged: report.sourceConfigurationUnchanged }));
    process.exitCode = report.passed ? 0 : report.directOnlyEvidenceComplete || report.alternateModelEvidenceComplete ? 2 : 1;
    // A timed-out Playwright operation can retain an unresolved transport promise.
    setTimeout(() => process.exit(process.exitCode), 1000).unref();
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) await main();
