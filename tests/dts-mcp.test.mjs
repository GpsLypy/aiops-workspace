import { responsesFixture } from './responses-fixture.mjs';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { loadConfig, createStatusQuery, normalizeStatus, createDtsMcpApp, TOOL } from '../integrations/dts-mcp/adapter.mjs';
import { listen } from './fixtures.mjs';
import { createApplication } from '../server/app.mjs';
import { provisionDts, syncDtsPolicy } from '../integrations/dts-mcp/provision.mjs';

const args = { jobid: '12470571244390405', business_domain: 'general', area_name: 'cn_east' };
const regionJob = '13619800264280069';
const clock = 1800000000000;
const env = { DTS_STATUS_URL: 'https://dts.example/proxy/v1/jobns/getstatus', DTS_MCP_TOKEN: 'test_dts_token_0123456789012345678901234567', DTS_ALLOWED_JOB_IDS: args.jobid };
const config = loadConfig(env);
const status = overrides => ({ jobID: args.jobid, time: clock / 1000 - 2, health: 1, paused: false, 'manual-stopped': false, finished: false, 'worker-delay-seconds': 0, ...overrides });
const body = overrides => ({ code: 0, data: { status: JSON.stringify(status(overrides)) } });
const json = value => new Response(JSON.stringify(value), { headers: { 'Content-Type': 'application/json; charset=utf-8' } });

test('DTS startup requires explicit endpoint, strong token, bounded configuration and task allowlist', () => {
  for (const changes of [
    { DTS_STATUS_URL: 'https://dts.example/config/set' }, { DTS_STATUS_URL: 'https://a:b@dts.example/v1/jobns/getstatus' },
    { DTS_STATUS_URL: `${env.DTS_STATUS_URL}?jobid=1` }, { DTS_STATUS_URL: 'http://dts.example/v1/jobns/getstatus' },
    { DTS_MCP_TOKEN: '' }, { DTS_ALLOWED_JOB_IDS: '*' }, { DTS_ALLOWED_JOB_IDS: '' }, { DTS_ALLOWED_JOB_IDS: '9223372036854775808' },
    { DTS_TIMEOUT_MS: 'Infinity' }, { DTS_MCP_PORT: '0' }, { DTS_READ_TOKEN: 'x\r\ny' },
    { DTS_JOB_SCOPE: '*' }, { DTS_JOB_SCOPE: '' }, { DTS_JOB_SCOPE: 'region' },
  ]) assert.throws(() => loadConfig({ ...env, ...changes }));
  assert.equal(loadConfig({ ...env, DTS_STATUS_URL: 'http://dts.example/v1/jobns/getstatus', DTS_ALLOW_HTTP: 'true' }).areaName, 'cn_east');
});

test('DTS explicit region scope accepts any valid ID but retains domain, region and ID validation', async () => {
  const region = loadConfig({ ...env, DTS_JOB_SCOPE: 'region', DTS_ALLOWED_JOB_IDS: '' });
  assert.equal(config.jobScope, 'allowlist');
  assert.equal(region.jobScope, 'region'); assert.deepEqual(region.allowedJobIds, []);
  assert.throws(() => loadConfig({ ...env, DTS_JOB_SCOPE: 'region', DTS_ALLOWED_JOB_IDS: '*' }));
  let calls = 0;
  const query = createStatusQuery(region, { now: () => clock, fetchImpl: async url => { calls++; return json(body({ jobID: url.searchParams.get('jobid') })); } });
  for (const jobid of [regionJob, '1', '9223372036854775807']) assert.equal((await query({ ...args, jobid })).jobid, jobid);
  for (const changes of [{ jobid: Number(regionJob) }, { jobid: '*' }, { jobid: '' }, { jobid: '0' }, { jobid: '01' }, { jobid: '9223372036854775808' }, { jobid: '../status' }, { area_name: 'cn_north' }, { business_domain: 'other' }]) {
    await assert.rejects(query({ ...args, ...changes }), e => ['INVALID_ARGUMENTS', 'SCOPE_DENIED'].includes(e.code));
  }
  assert.equal(calls, 3);
});

test('DTS query preserves long IDs, fixed GET scope and separate upstream token', async () => {
  let observed;
  const query = createStatusQuery({ ...config, upstreamToken: 'upstream-only' }, { now: () => clock, fetchImpl: async (url, init) => { observed = { url, init }; return json(body()); } });
  const result = await query(args);
  assert.equal(observed.url.searchParams.get('jobid'), args.jobid);
  assert.equal(observed.url.searchParams.get('subkey'), 'status');
  assert.equal(observed.url.searchParams.get('business_domain'), 'general');
  assert.equal(observed.url.searchParams.get('area_name'), 'cn_east');
  assert.equal(observed.url.searchParams.has('operator'), false);
  assert.equal(observed.init.method, 'GET'); assert.equal(observed.init.redirect, 'error');
  assert.equal(observed.init.headers.Authorization, 'Bearer upstream-only');
  assert.ok(observed.init.signal instanceof AbortSignal);
  assert.equal(result.jobid, args.jobid); assert.equal(result.state, 'running'); assert.equal(result.fixture, false);
});

test('DTS invalid and out-of-scope inputs never reach the upstream', async () => {
  let calls = 0;
  const query = createStatusQuery(config, { fetchImpl: () => { calls++; throw Error('must not call'); } });
  for (const changes of [{ jobid: Number(args.jobid) }, { jobid: '1' }, { jobid: '../status' }, { jobid: '01' }, { area_name: 'cn_north' }, { business_domain: 'other' }, { url: 'http://localhost' }]) {
    await assert.rejects(query({ ...args, ...changes }), e => ['INVALID_ARGUMENTS', 'SCOPE_DENIED'].includes(e.code));
  }
  assert.equal(calls, 0);
});

test('DTS response normalizes freshness without inventing defaults or a business diagnosis', () => {
  assert.equal(normalizeStatus(body({ time: clock / 1000 - 61 }), args, config, clock).state, 'stale');
  assert.equal(normalizeStatus(body({ time: clock / 1000 + 31 }), args, config, clock).freshness, 'future');
  const unknown = normalizeStatus(body({ time: undefined, paused: undefined, 'worker-delay-seconds': undefined }), args, config, clock);
  assert.equal(unknown.state, 'unknown'); assert.equal(unknown.reported_at, null); assert.equal(unknown.paused, null); assert.equal(unknown.worker_delay_seconds, null);
  assert.equal(normalizeStatus(body({ paused: true }), args, config, clock).state, 'paused');
  assert.equal(normalizeStatus(body({ 'manual-stopped': true }), args, config, clock).state, 'unknown');
  assert.equal(normalizeStatus(body({ finished: true }), args, config, clock).state, 'finished');
  assert.equal(normalizeStatus(body({ health: 0 }), args, config, clock).state, 'unhealthy');
});

test('DTS rejects missing, malformed, wrong-task and incorrectly typed status', () => {
  for (const value of [{ code: 3 }, { code: 0 }, { code: 0, data: { status: '{}' } }, { code: 0, data: { status: 'invalid' } }, body({ jobID: '123' }), body({ jobID: Number(args.jobid) }), body({ health: '1' }), body({ time: -1 }), body({ paused: 'false' }), body({ 'worker-delay-seconds': -1 })]) {
    assert.throws(() => normalizeStatus(value, args, config, clock));
  }
});

test('DTS excludes nested internals and redacts credential-like error details', () => {
  const result = normalizeStatus(body({ inbound: [{ password: 'leak' }], outbound: { endpoint: 'private' }, statistics: ['raw'], message: `password=hidden Bearer abcdef ${config.token}` }), args, config, clock);
  const text = JSON.stringify(result);
  for (const value of ['inbound', 'outbound', 'statistics', 'hidden', 'abcdef', config.token]) assert.ok(!text.includes(value));
  assert.ok(result.message.includes('[REDACTED]'));
  const boundary = normalizeStatus(body({ message: 'x'.repeat(990) + config.token }), args, config, clock);
  assert.ok(!boundary.message.includes(config.token.slice(0, 8)));
});

test('DTS bounds body size, rejects HTML, HTTP errors and corrupted envelopes without leaking raw errors', async () => {
  const cases = [
    [() => new Response('password=private', { status: 503 }), 'DTS_HTTP_ERROR'],
    [() => new Response('<html>login</html>', { headers: { 'Content-Type': 'text/html' } }), 'INVALID_RESPONSE'],
    [() => new Response('not json', { headers: { 'Content-Type': 'application/json' } }), 'INVALID_RESPONSE'],
    [() => json({ huge: 'a'.repeat(config.maxBytes) }), 'RESPONSE_TOO_LARGE'],
    [() => json({ code: 3, message: 'secret=private' }), 'DTS_BUSINESS_ERROR'],
    [() => { throw Error('private credential'); }, 'DTS_UNAVAILABLE'],
  ];
  for (const [fetchImpl, code] of cases) await assert.rejects(createStatusQuery(config, { fetchImpl })(args), e => e.code === code && !e.message.includes('private'));
});

test('DTS real HTTP transport enforces timeout and refuses redirects', async t => {
  const app = express(); let mode = 'redirect'; let redirected = 0;
  app.get('/v1/jobns/getstatus', (_req, res) => {
    if (mode === 'redirect') return res.redirect('/elsewhere');
    const timer = setTimeout(() => res.json(body()), 500); res.on('close', () => clearTimeout(timer));
  });
  app.get('/elsewhere', (_req, res) => { redirected++; res.json(body()); });
  const running = await listen(app); t.after(() => running.close());
  // Redirect refusal is independent of the deliberately short timeout below.
  const query = createStatusQuery({ ...config, endpoint: `${running.url}/v1/jobns/getstatus`, timeoutMs: 2000 });
  await assert.rejects(query(args), e => e.code === 'DTS_UNAVAILABLE'); assert.equal(redirected, 0);
  mode = 'timeout';
  const shortQuery = createStatusQuery({ ...config, endpoint: `${running.url}/v1/jobns/getstatus`, timeoutMs: 100 });
  await assert.rejects(shortQuery(args), e => e.code === 'DTS_TIMEOUT');
});

test('DTS MCP wire protocol authenticates, discovers only read tool and enforces scope independently', async t => {
  let calls = 0; const logs = [];
  const running = await listen(createDtsMcpApp(config, { query: async input => { calls++; return normalizeStatus(body(), input, config, clock); }, log: e => logs.push(e) }));
  t.after(() => running.close());
  const endpoint = `${running.url}/mcp`;
  assert.equal((await fetch(endpoint, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' })).status, 401);
  assert.equal((await fetch(endpoint, { method: 'POST', headers: { Authorization: `Bearer ${config.token}`, Origin: 'https://evil.example', 'Content-Type': 'application/json' }, body: '{}' })).status, 403);
  const client = new Client({ name: 'dts-test', version: '1' }); t.after(() => client.close());
  await client.connect(new StreamableHTTPClientTransport(new URL(endpoint), { requestInit: { headers: { Authorization: `Bearer ${config.token}` } } }));
  const tools = (await client.listTools()).tools;
  assert.deepEqual(tools.map(t => t.name), [TOOL]); assert.equal(tools[0].inputSchema.properties.jobid.type, 'string');
  assert.equal(tools[0].annotations.readOnlyHint, true);
  const success = await client.callTool({ name: TOOL, arguments: args }); assert.equal(success.structuredContent.jobid, args.jobid);
  const denied = await client.callTool({ name: TOOL, arguments: { ...args, area_name: 'cn_north' } }); assert.equal(denied.isError, true);
  const invalid = await client.callTool({ name: TOOL, arguments: { ...args, jobid: Number(args.jobid) } }); assert.equal(invalid.isError, true);
  assert.equal(calls, 1); assert.equal(logs.length, 1); assert.ok(!JSON.stringify(logs).includes(config.token));
});

test('DTS local provisioning and workspace model/tool loop preserve bindings, audit, history and policy denial', async t => {
  const dir = mkdtempSync(join(tmpdir(), 'aiops-dts-')); let calls = 0;
  const fixture = express(); fixture.use(express.json());
  fixture.post('/v1/responses', responsesFixture, (req, res) => {
    const last = req.body.messages.at(-1);
    const question = req.body.messages.filter(m => m.role === 'user').at(-1).content;
    const message = last.role === 'tool' ? { role: 'assistant', content: `DTS 结果 ${last.content}` } : {
      role: 'assistant', content: '', tool_calls: [{ id: 'dts-test-call', type: 'function', function: {
        name: req.body.tools[0].function.name, arguments: JSON.stringify({ ...args, ...(question.includes('越界') ? { area_name: 'cn_north' } : {}), ...(question.includes('区域任务') ? { jobid: regionJob } : {}) }),
      } }],
    };
    res.json({ choices: [{ message }], usage: { prompt_tokens: 20, completion_tokens: 10, total_tokens: 30 } });
  });
  const model = await listen(fixture);
  const regionConfig = loadConfig({ ...env, DTS_JOB_SCOPE: 'region', DTS_ALLOWED_JOB_IDS: '' });
  const mcp = await listen(createDtsMcpApp(regionConfig, { query: async input => { calls++; return normalizeStatus(body({ jobID: input.jobid }), input, regionConfig, clock); }, log: () => {} }));
  const app = createApplication({ dataDir: dir, scheduler: false }); const running = await listen(app.app);
  t.after(async () => { await running.close(); await app.close(); await mcp.close(); await model.close(); rmSync(dir, { recursive: true, force: true }); });
  let cookie = '';
  async function request(path, payload, method = 'POST') {
    const res = await fetch(`${running.url}/api${path}`, { method, headers: { 'Content-Type': 'application/json', Cookie: cookie }, ...(payload === undefined ? {} : { body: JSON.stringify(payload) }) });
    if (res.headers.has('set-cookie')) cookie = res.headers.get('set-cookie').split(';')[0];
    return { status: res.status, data: await res.json() };
  }
  assert.equal((await request('/auth/setup', { username: 'dts-admin', name: 'DTS 测试管理员', password: 'test-dts-password-123' })).status, 201);
  const cfg = { ...config, port: Number(new URL(mcp.url).port) };
  const options = { root: resolve('.'), ownerName: 'dts-admin', dataDir: dir };
  const created = await provisionDts(cfg, options); assert.equal(created.resources.length, 4);
  assert.equal((await provisionDts(cfg, options)).action, 'already_provisioned');
  await assert.rejects(provisionDts({ ...cfg, token: 'changed_token_012345678901234567890' }, options), /不一致/);
  await assert.rejects(provisionDts(cfg, { ...options, ownerName: 'missing' }), /不存在/);
  const resources = (await request('/resources', undefined, 'GET')).data;
  assert.equal(resources.length, 4); assert.ok(resources.every(r => r.visibility === 'private'));
  const agent = resources.find(r => r.kind === 'agents'); const connector = resources.find(r => r.kind === 'mcp');
  const binding = target => ({ resourceId: connector.id, tool: TOOL, environment: 'production', arguments: { ...args, jobid: target } });
  assert.equal(agent.publication, 'published'); assert.equal(agent.skillIds.length, 1); assert.equal(agent.knowledgeIds.length, 1);
  assert.deepEqual(connector.toolPolicies[TOOL].requiredTargetFields, ['jobid', 'business_domain', 'area_name']);
  assert.ok(resources.find(r => r.kind === 'skills').skillPackage.base64);
  assert.ok(!JSON.stringify(resources).includes(config.token));
  assert.equal((await request('/settings/model', { baseUrl: `${model.url}/v1`, model: 'fixture-dts', apiKey: 'fixture-only' }, 'PUT')).status, 200);
  assert.deepEqual((await request(`/mcp/${connector.id}/discover`, {})).data.map(t => t.name), [TOOL]);
  const missingTarget = await request('/chat', { text: '请查询 DTS 当前状态', agentId: agent.id });
  assert.equal(missingTarget.status, 422); assert.equal(calls, 0);
  const chat = await request('/chat', { text: '请查询 DTS 当前状态', agentId: agent.id, targetBinding: binding(args.jobid) });
  assert.equal(chat.status, 200); assert.ok(chat.data.text.includes(args.jobid)); assert.equal(chat.data.metadata.tools[0].tool, TOOL);
  assert.equal(calls, 1);
  const history = await request(`/conversations/${chat.data.conversationId}`, undefined, 'GET');
  assert.ok(history.data.messages.some(m => m.role === 'assistant' && m.content.includes(args.jobid)));
  const denied = await request(`/mcp/${connector.id}/call`, { name: TOOL, arguments: { ...args, area_name: 'cn_north' } });
  assert.equal(denied.status, 403); assert.equal(calls, 1);
  assert.equal(app.store.get('SELECT status FROM tool_steps WHERE tool=? ORDER BY created DESC LIMIT 1', TOOL).status, 'success');
  assert.ok(app.store.get("SELECT seq FROM audit WHERE action='resource.create' AND target=?", connector.id));
  // The workspace initially still restricts IDs even though the MCP supports region scope.
  assert.equal((await request(`/mcp/${connector.id}/call`, { name: TOOL, arguments: { ...args, jobid: regionJob } })).status, 403);
  assert.equal(calls, 1);
  const regionCfg = { ...regionConfig, port: cfg.port };
  const saved = () => JSON.parse(app.store.get('SELECT data FROM resources WHERE id=?', connector.id).data);
  const legacy = saved(); delete legacy.toolPolicies[TOOL].requiredTargetFields;
  const legacySaved = await request(`/resources/${connector.id}`, legacy, 'PUT');
  assert.equal(legacySaved.status, 200, JSON.stringify(legacySaved.data));
  await assert.rejects(provisionDts(cfg, options), /目标绑定/);
  const before = saved();
  await assert.rejects(syncDtsPolicy(regionCfg, { ...options, ownerName: 'missing' }), /不存在/);
  await assert.rejects(syncDtsPolicy({ ...regionCfg, areaName: 'cn_north' }, options), /未扩大区域/);
  await assert.rejects(syncDtsPolicy({ ...regionCfg, token: 'changed_token_012345678901234567890' }, options), /不一致/);
  assert.deepEqual(saved(), before);
  const synced = await syncDtsPolicy(regionCfg, options);
  assert.equal(synced.action, 'policy_synced'); assert.equal(synced.revision, before.revision + 1);
  assert.deepEqual(synced.constraints, { business_domain: ['general'], area_name: ['cn_east'] });
  assert.deepEqual(synced.requiredTargetFields, ['jobid', 'business_domain', 'area_name']);
  assert.equal((await syncDtsPolicy(regionCfg, options)).action, 'already_synced');
  const after = saved();
  for (const key of ['endpoint', 'tokenEncrypted', 'visibility', 'readerIds', 'managerIds', 'allowedTools']) assert.deepEqual(after[key], before[key]);
  const { constraints: oldConstraints, requiredTargetFields: oldFields, ...oldPolicy } = before.toolPolicies[TOOL];
  const { constraints: newConstraints, requiredTargetFields: newFields, ...newPolicy } = after.toolPolicies[TOOL];
  assert.deepEqual(newFields, ['jobid', 'business_domain', 'area_name']);
  assert.deepEqual(newPolicy, oldPolicy);
  assert.ok(app.store.get("SELECT seq FROM audit WHERE action='resource.update' AND target=?", connector.id));
  assert.ok(!app.store.get('SELECT data FROM resource_versions WHERE resource_id=? AND revision=?', connector.id, after.revision).data.includes('tokenEncrypted'));
  const wrongTarget = await request('/chat', { text: '查询区域任务的当前状态', agentId: agent.id, targetBinding: binding(args.jobid) });
  assert.equal(wrongTarget.status, 403); assert.equal(calls, 1);
  const regionChat = await request('/chat', { text: '查询区域任务的当前状态', agentId: agent.id, targetBinding: binding(regionJob) });
  assert.equal(regionChat.status, 200); assert.ok(regionChat.data.text.includes(regionJob)); assert.equal(calls, 2);
  for (const changes of [{ area_name: 'cn_north' }, { business_domain: 'other' }]) assert.equal((await request(`/mcp/${connector.id}/call`, { name: TOOL, arguments: { ...args, ...changes } })).status, 403);
  assert.equal(calls, 2);
  // Switching back restores the allowlist; the sync command does not add permissions elsewhere.
  assert.equal((await syncDtsPolicy(cfg, options)).action, 'policy_synced');
  assert.deepEqual(saved().toolPolicies[TOOL].constraints.jobid, [args.jobid]);
  assert.equal((await request(`/mcp/${connector.id}/call`, { name: TOOL, arguments: { ...args, jobid: regionJob } })).status, 403);
  await syncDtsPolicy(regionCfg, options);
  assert.equal((await provisionDts(regionCfg, options)).action, 'already_provisioned');
  assert.equal((await request('/users', { username: 'dts-member', name: '普通成员', password: 'test-dts-member-123', role: 'member' })).status, 201);
  assert.equal((await request('/auth/login', { username: 'dts-member', password: 'test-dts-member-123' })).status, 200);
  assert.deepEqual((await request('/resources', undefined, 'GET')).data, []);
  assert.equal((await request(`/mcp/${connector.id}/call`, { name: TOOL, arguments: args })).status, 404);
  assert.equal(calls, 2);
});
