import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, readdirSync, readFileSync, writeFileSync, chmodSync, symlinkSync, realpathSync, openSync, closeSync, constants } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createApplication } from '../server/app.mjs';
import { createLocalServices, readProtectedLocalReport, probeLocalService } from '../server/local-services.mjs';
import { listen } from './fixtures.mjs';

const measuredAt = '2026-10-08T09:00:00.000Z';
const usage = { date: '2026-10-08', provider: 'example', model: 'example-model', currency: 'USD', tokens: 30, tokenSource: 'reported', estimatedCost: '0.100001' };
const invoice = { date: '2026-10-08', provider: 'example', model: 'example-model', currency: 'USD', tokens: 32, category: 'usage', billedCost: '0.200001' };
const upload = (kind, record) => ({ filename: kind + '.json', content: JSON.stringify({ schemaVersion: 1, kind, records: [record] }) });
function evidence() {
  return { schemaVersion: 1, finishedAt: measuredAt, passed: true, secrets: 'PRIVATE_TOKEN', path: '/PRIVATE_PATH', pid: 1, jobId: 'PRIVATE_JOB',
    checks: { protectedMetrics: [true, true], persistedRedactedTraces: { traces: 3, spans: 15, idempotent: true, prompt: 'PRIVATE_PROMPT' },
      multiInstanceMetrics: { instances: 2, runCounts: [1, 2], fleetRuns: 3, fixtureTokens: 180 }, traceBackendRestartRecovery: true, collectorFailureIsolated: true,
      temporaryStackRemoved: true, 'PRIVATE_ARBITRARY_LABEL': true } };
}
function deployment() {
  return { schemaVersion: 1, project: 'aiops-observability-local', generatedAt: measuredAt, persistent: true,
    services: {
      collector: { url: 'http://127.0.0.1:4318/v1/traces', expectedStatus: 405 },
      tempo: { url: 'http://127.0.0.1:3200/ready', expectedStatus: 200 },
      prometheus: { url: 'http://127.0.0.1:9090/-/ready', expectedStatus: 200 },
    } };
}
async function harness(localServices) {
  const dir = mkdtempSync(join(tmpdir(), 'aiops-local-services-'));
  const app = createApplication({ dataDir: dir, scheduler: false, localServices });
  const http = await listen(app.app);
  const request = async (path, body, cookie, method = body ? 'POST' : 'GET') => {
    const response = await fetch(http.url + '/api' + path, { method, headers: { 'Content-Type': 'application/json', ...(cookie ? { Cookie: cookie } : {}) },
      ...(body ? { body: JSON.stringify(body) } : {}) });
    return { status: response.status, data: await response.json(), cookie: response.headers.get('set-cookie')?.split(';')[0] };
  };
  const admin = (await request('/auth/setup', { username: 'admin', password: 'local-services-admin-password' })).cookie;
  await request('/users', { username: 'member', password: 'local-services-member-password', role: 'member' }, admin);
  const member = (await request('/auth/login', { username: 'member', password: 'local-services-member-password' })).cookie;
  return { app, dir, admin, member, request, close: async () => { await http.close(); await app.close(); rmSync(dir, { recursive: true, force: true }); } };
}

test('local service and billing endpoints require an administrator before any report read or probe', async () => {
  let reads = 0, probes = 0;
  const h = await harness({ enabled: true, readReport: async () => { reads++; return null; }, probe: async () => { probes++; return { status: 200, body: { ok: true } }; } });
  try {
    for (const [cookie, status] of [[undefined, 401], [h.member, 403]]) {
      assert.equal((await h.request('/local-services', undefined, cookie)).status, status);
      assert.equal((await h.request('/local-services/billing', { usage: upload('usage', usage), invoice: upload('invoice', invoice) }, cookie)).status, status);
    }
    assert.equal(reads, 0); assert.equal(probes, 0);
    assert.equal((await h.request('/local-services?url=http://private.example', undefined, h.admin)).status, 400);
    assert.equal((await h.request('/local-services?path=/private/token', undefined, h.admin)).status, 400);
    assert.equal(reads, 0); assert.equal(probes, 0);
  } finally { await h.close(); }
});

test('fixed live service status remains separate from historical redacted evidence and does not accept report endpoints', async () => {
  const calls = [];
  const reports = { observabilityDeployment: deployment(), observabilityEvidence: evidence(),
    sandboxDeployment: { measuredAt, configurationPrivate: true, mcp: { endpoint: 'http://127.0.0.1:43130/mcp', healthStatus: 200 } },
    sandboxEvidence: { version: 1, measuredAt, passed: true, cleanupVerified: true, checks: [{ label: 'PRIVATE_JOB_LABEL', passed: true, jobId: 'PRIVATE_JOB' }] } };
  const h = await harness({ readReport: async key => reports[key], probe: async id => { calls.push(id); if (id === 'tempo') throw new Error('PRIVATE_NETWORK_TOKEN');
    return { status: id === 'collector' ? 405 : 200, body: { ok: true, token: 'PRIVATE_HEALTH_TOKEN' } }; } });
  try {
    const response = await h.request('/local-services', undefined, h.admin);
    assert.equal(response.status, 200);
    assert.deepEqual(response.data.services.map(service => [service.id, service.status]), [['collector', 'online'], ['tempo', 'offline'], ['prometheus', 'online'], ['sandbox', 'online']]);
    assert.deepEqual(calls.sort(), ['collector', 'prometheus', 'sandbox', 'tempo']);
    assert.equal(response.data.evidence.observability.measuredAt, measuredAt); assert.equal(response.data.evidence.observability.passed, true);
    assert.equal(response.data.evidence.observability.checks.length, 6);
    assert.equal(response.data.evidence.sandbox.passed, false, 'unknown report labels cannot create a passing summary');
    assert.equal(response.data.evidence.sandbox.checks.length, 11);
    assert.deepEqual(response.data.billing, { available: true, realInvoiceLoaded: false });
    assert.doesNotMatch(JSON.stringify(response.data), /PRIVATE_|\bpid\b|\bjobId\b|\/test-results\/|apiKey/);
    reports.observabilityDeployment.services.collector.url = 'http://169.254.169.254/PRIVATE_PATH';
    calls.length = 0;
    const invalid = await h.request('/local-services', undefined, h.admin);
    assert.ok(invalid.data.services.slice(0, 3).every(service => service.status === 'unconfigured' && service.endpoint === null));
    assert.deepEqual(calls, ['sandbox']);
    reports.observabilityEvidence.checks.traceBackendRestartRecovery = false;
    const contradiction = await h.request('/local-services', undefined, h.admin);
    assert.equal(contradiction.data.evidence.observability.passed, false);
  } finally { await h.close(); }
});

test('production defaults to unconfigured without touching local reports; missing reports do not start probes', async () => {
  let reads = 0, probes = 0;
  const options = { readReport: async () => { reads++; return null; }, probe: async () => { probes++; return { status: 200 }; } };
  const previous = process.env.NODE_ENV;
  try {
    process.env.NODE_ENV = 'production';
    const state = await createLocalServices(options).inspect();
    assert.ok(state.services.every(service => service.status === 'unconfigured' && service.endpoint === null));
    assert.equal(reads, 0); assert.equal(probes, 0);
    process.env.NODE_ENV = 'development';
    const missing = await createLocalServices(options).inspect();
    assert.equal(reads, 4); assert.equal(probes, 0);
    assert.deepEqual(missing.evidence.observability, { measuredAt: null, passed: null, checks: [] });
    assert.deepEqual(missing.evidence.sandbox, { measuredAt: null, passed: null, checks: [] });
  } finally { if (previous === undefined) delete process.env.NODE_ENV; else process.env.NODE_ENV = previous; }
});

test('local probes run concurrently, are bounded, and reject invalid sandbox health data', async () => {
  const entered = [], signals = [];
  const began = performance.now();
  const pending = createLocalServices({ enabled: true, readReport: async () => null, probe: async (id, signal) => {
    entered.push(id); signals.push(signal);
    if (id === 'sandbox') return { status: 200, body: { token: 'PRIVATE', ok: false } };
    return new Promise(() => {});
  } }).inspect();
  await new Promise(resolve => setTimeout(resolve, 20));
  assert.equal(entered.length, 4, 'all four checks begin concurrently');
  const result = await pending;
  assert.ok(performance.now() - began < 2400, 'one shared probe round does not take four serial timeouts');
  assert.ok(result.services.every(service => service.status === 'offline'));
  assert.ok(signals.every(signal => signal.aborted));
});

test('report reader rejects FIFO, symlinks, writable or oversized files without reading arbitrary private contents', async () => {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'aiops-local-report-')));
  try {
    const report = join(dir, 'report.json');
    writeFileSync(report, JSON.stringify({ version: 1, measuredAt }), { mode: 0o600 });
    assert.deepEqual(await readProtectedLocalReport(report), { version: 1, measuredAt });
    const linked = join(dir, 'linked.json'); symlinkSync(report, linked);
    assert.equal(await readProtectedLocalReport(linked), null);
    chmodSync(report, 0o620); assert.equal(await readProtectedLocalReport(report), null);
    chmodSync(report, 0o600); writeFileSync(report, 'x'.repeat(512 * 1024 + 1));
    assert.equal(await readProtectedLocalReport(report), null);
    writeFileSync(report, '{PRIVATE_TOKEN'); assert.equal(await readProtectedLocalReport(report), null);
    assert.equal(await readProtectedLocalReport(dir), null);
    const fifo = join(dir, 'fifo.json'); execFileSync('mkfifo', [fifo]);
    const reading = readProtectedLocalReport(fifo);
    let timer;
    const timedOut = Symbol('timed out');
    const result = await Promise.race([reading, new Promise(resolve => { timer = setTimeout(() => resolve(timedOut), 300); })]);
    clearTimeout(timer);
    if (result === timedOut) {
      // Release a regressed blocking reader so a failed regression does not hang the suite.
      closeSync(openSync(fifo, constants.O_WRONLY | constants.O_NONBLOCK));
      await reading;
      assert.fail('FIFO open must be nonblocking');
    }
    assert.equal(result, null);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('native health transport uses only fixed endpoints, disables redirects and bounds sandbox response bytes', async () => {
  const signal = new AbortController().signal, calls = [];
  const request = async (url, options) => { calls.push({ url, options }); return new Response('PRIVATE_BODY', { status: 302, headers: { Location: 'http://169.254.169.254/PRIVATE_TOKEN' } }); };
  const redirect = await probeLocalService('collector', signal, request);
  assert.equal(redirect.status, 302); assert.equal(redirect.body, undefined);
  assert.equal(calls.length, 1); assert.equal(calls[0].url, 'http://127.0.0.1:4318/v1/traces');
  assert.equal(calls[0].options.redirect, 'error'); assert.equal(calls[0].options.signal, signal);
  const oversized = await probeLocalService('sandbox', signal, async () => new Response(JSON.stringify({ ok: true, token: 'PRIVATE_'.repeat(500) }), { status: 200 }));
  assert.equal(oversized.body, null);
  const invalid = await probeLocalService('sandbox', signal, async () => new Response('PRIVATE_INVALID_JSON', { status: 200 }));
  assert.equal(invalid.body, null);
  const health = await probeLocalService('sandbox', signal, async () => new Response('{"ok":true}', { status: 200 }));
  assert.deepEqual(health.body, { ok: true });
  await assert.rejects(probeLocalService('http://169.254.169.254', signal, request), /Unknown/);
  assert.equal(calls.length, 1);
});

test('future or non-date report timestamps cannot become deployment or historical evidence', async () => {
  const future = new Date(Date.now() + 86400000).toISOString();
  for (const time of [future, 'PRIVATE_TIMESTAMP']) {
    const deployed = deployment(); deployed.generatedAt = time;
    const history = evidence(); history.finishedAt = time;
    let calls = 0;
    const result = await createLocalServices({ readReport: async key => key === 'observabilityDeployment' ? deployed : key === 'observabilityEvidence' ? history : null,
      probe: async () => { calls++; return { status: 200 }; } }).inspect();
    assert.equal(calls, 0); assert.ok(result.services.every(service => service.status === 'unconfigured'));
    assert.deepEqual(result.evidence.observability, { measuredAt: null, passed: null, checks: [] });
  }
});

test('billing imports return exact differences in memory without storing input files or database records', async () => {
  const h = await harness({ enabled: false });
  try {
    const files = readdirSync(h.dir).sort();
    const counts = Object.fromEntries(['audit', 'executions', 'tool_steps', 'settings', 'messages'].map(table => [table, h.app.store.get(`SELECT count(*) AS count FROM ${table}`).count]));
    const hashes = Object.fromEntries(files.map(name => [name, createHash('sha256').update(readFileSync(join(h.dir, name))).digest('hex')]));
    const input = { usage: upload('usage', usage), invoice: upload('invoice', invoice) };
    const response = await h.request('/local-services/billing', input, h.admin);
    assert.equal(response.status, 200); assert.equal(response.data.status, 'needs_review');
    assert.equal(response.data.rows[0].costDifference, '0.100000'); assert.equal(response.data.rows[0].tokenDifference, '2');
    assert.equal(response.data.providerAccountVerified, false); assert.equal(response.data.productionAccepted, false);
    assert.equal(response.data.inputProvenance.invoiceSource, 'user_supplied_unverified');
    assert.equal(response.data.inputProvenance.usageSha256, createHash('sha256').update(input.usage.content).digest('hex'));
    assert.deepEqual(readdirSync(h.dir).sort(), files);
    assert.deepEqual(Object.fromEntries(files.map(name => [name, createHash('sha256').update(readFileSync(join(h.dir, name))).digest('hex')])), hashes);
    for (const [table, count] of Object.entries(counts)) assert.equal(h.app.store.get(`SELECT count(*) AS count FROM ${table}`).count, count);
    const csv = { filename: '供应商账单.csv', content: 'date,provider,model,currency,tokens,category,billedCost\n2026-10-08,example,example-model,USD,30,usage,0.100001\n' };
    const matched = await h.request('/local-services/billing', { usage: input.usage, invoice: csv }, h.admin);
    assert.equal(matched.status, 200); assert.equal(matched.data.status, 'matched');
  } finally { await h.close(); }
});

test('billing rejects paths, extra fields, overlong UTF8 data and invalid rows with a fixed Chinese error', async () => {
  const h = await harness({ enabled: false });
  try {
    const good = { usage: upload('usage', usage), invoice: upload('invoice', invoice) };
    const invalid = [
      { ...good, path: '/PRIVATE_PATH' },
      { ...good, usage: { ...good.usage, filename: '/PRIVATE_PATH.csv' } },
      { ...good, usage: { ...good.usage, filename: 'C:\\PRIVATE_PATH.csv' } },
      { ...good, usage: { ...good.usage, path: '/PRIVATE_PATH' } },
      { ...good, usage: { filename: 'usage.json', content: '中'.repeat(140000) } },
      { ...good, invoice: upload('invoice', { ...invoice, apiKey: 'PRIVATE_TOKEN' }) },
      { ...good, usage: upload('usage', { ...usage, estimatedCost: 1000000000000.000001 }) },
      { ...good, invoice: upload('invoice', { ...invoice, billedCost: 0.200001 }) },
      { ...good, invoice: { filename: 'invoice.json', content: '{PRIVATE_TOKEN' } },
      { ...good, invoice: { filename: 'invoice.txt', content: 'PRIVATE_TOKEN' } },
    ];
    for (const input of invalid) {
      const response = await h.request('/local-services/billing', input, h.admin);
      assert.equal(response.status, 400);
      assert.equal(response.data.error, '账单文件格式或字段无效：请选择不超过 400 KiB 的 CSV/JSON，并按示例填写用量与账单字段');
      assert.doesNotMatch(JSON.stringify(response.data), /PRIVATE_/);
    }
    assert.equal((await h.request('/local-services/billing?url=https://example.com', good, h.admin)).status, 400);
  } finally { await h.close(); }
});
