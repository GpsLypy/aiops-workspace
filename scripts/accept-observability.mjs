import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify, parseArgs } from 'node:util';
import { randomBytes } from 'node:crypto';
import { mkdirSync, mkdtempSync, writeFileSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve, join, dirname } from 'node:path';
import { createServer } from 'node:net';
import { fileURLToPath } from 'node:url';
import { runtimeFixture, answer, call } from '../tests/runtime-fixture.mjs';
import { validateObservabilityTargets } from './observability-stack.mjs';

const run = promisify(execFile);
const root = fileURLToPath(new URL('../', import.meta.url));
const pause = milliseconds => new Promise(resolvePause => setTimeout(resolvePause, milliseconds));
async function freePort() {
  const server = createServer();
  await new Promise(resolveListen => server.listen(0, '127.0.0.1', resolveListen));
  const port = server.address().port;
  await new Promise(resolveClose => server.close(resolveClose));
  return port;
}
async function until(check, description, timeoutMs = 45000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try { const value = await check(); if (value) return value; } catch { /* Startup and scrape convergence are expected. */ }
    await pause(500);
  }
  throw new Error(`Timed out: ${description}`);
}
async function json(url) {
  const response = await fetch(url, { signal: AbortSignal.timeout(3000) });
  if (!response.ok) throw new Error('Observation endpoint not ready');
  return response.json();
}
function spansOf(value) {
  const values = [];
  function visit(item) {
    if (!item || typeof item !== 'object') return;
    if (Array.isArray(item.spans)) values.push(...item.spans);
    Object.values(item).forEach(child => { if (Array.isArray(child)) child.forEach(visit); else if (child && typeof child === 'object') visit(child); });
  }
  visit(value); return values;
}

export async function acceptObservability(output) {
  if (existsSync(output)) throw Object.assign(new Error('Output already exists'), { code: 'EEXIST' });
  const taskDir = mkdtempSync(join(tmpdir(), 'aiops-observability-'));
  const project = `aiops-observe-${Date.now()}-${randomBytes(3).toString('hex')}`;
  const token = randomBytes(24).toString('hex');
  const ports = { collector: await freePort(), tempo: await freePort(), prometheus: await freePort() };
  const env = { ...process.env, METRICS_TOKEN_FILE: join(taskDir, 'metrics-token'), OBSERVABILITY_TARGETS_FILE: join(taskDir, 'targets.json'),
    OTLP_HTTP_PORT: String(ports.collector), TEMPO_HTTP_PORT: String(ports.tempo), PROMETHEUS_HTTP_PORT: String(ports.prometheus) };
  const compose = async (...args) => run('docker', ['compose', '-p', project, '-f', join(root, 'deploy/observability/compose.yaml'), ...args], { env, cwd: root, timeout: 120000, maxBuffer: 1024 * 1024 });
  const previousToken = process.env.METRICS_TOKEN;
  const report = { schemaVersion: 1, startedAt: new Date().toISOString(), fixture: true, productionAccepted: false,
    realModelUsed: false, realBillingUsed: false, checks: {}, images: [], limitations: ['Acceptance uses temporary independent databases and controlled local model/MCP replies.',
      'Docker Desktop local acceptance does not verify external production networks, authentication, capacity, retention policy, backups or provider account invoices.'] };
  const fixtures = [];
  let stackStarted = false;
  try {
    process.env.METRICS_TOKEN = token;
    // The file is mounted only into Prometheus. Its containing host directory is 0700.
    writeFileSync(env.METRICS_TOKEN_FILE, token + '\n', { mode: 0o644, flag: 'wx' });
    for (let i = 0; i < 2; i++) fixtures.push(await runtimeFixture({ workerMode: 'cold', telemetry: {
      endpoint: `http://127.0.0.1:${ports.collector}/v1/traces`, sampleRate: 1, propagate: true, timeoutMs: 2000,
    } }));
    const targets = validateObservabilityTargets(fixtures.map((fixture, index) => ({
      targets: [`host.docker.internal:${new URL(fixture.url).port}`], labels: { instance: `accept-${index + 1}`, workspace: `accept-${index + 1}` },
    })));
    writeFileSync(env.OBSERVABILITY_TARGETS_FILE, JSON.stringify(targets), { mode: 0o644, flag: 'wx' });
    await compose('config', '--quiet');
    stackStarted = true; await compose('up', '-d', '--pull', 'never');
    const tempoUrl = `http://127.0.0.1:${ports.tempo}`, prometheusUrl = `http://127.0.0.1:${ports.prometheus}`;
    await until(async () => (await fetch(tempoUrl + '/ready')).ok, 'Tempo readiness');
    await until(async () => (await fetch(prometheusUrl + '/-/ready')).ok, 'Prometheus readiness');
    report.checks.protectedMetrics = await Promise.all(fixtures.map(async fixture => {
      assert.equal((await fetch(fixture.url + '/metrics')).status, 401);
      assert.equal((await fetch(fixture.url + '/metrics', { headers: { Authorization: 'Bearer wrong-token' } })).status, 401);
      assert.equal((await fetch(fixture.url + '/metrics', { headers: { Authorization: `Bearer ${token}` } })).status, 200);
      return true;
    }));
    const traces = [];
    for (let i = 0; i < fixtures.length; i++) {
      const fixture = fixtures[i];
      fixture.model((req, res) => answer(res, req.body.messages.at(-1).role === 'tool' ? undefined : [call()], 'PRIVATE_ACCEPTANCE_ANSWER'));
      for (let n = 0; n <= i; n++) {
        const input = { text: 'PRIVATE_ACCEPTANCE_PROMPT billing', requestKey: `observe-${i}-${n}` };
        const response = await fixture.request('/chat', input);
        assert.equal(response.status, 200);
        assert.equal(response.data.metadata.executionTrace.status, 'completed');
        traces.push(response.data.metadata.executionTrace);
        const before = fixture.requests.length;
        assert.equal((await fixture.request('/chat', input)).status, 200);
        assert.equal(fixture.requests.length, before, 'idempotent replay must not generate model calls');
      }
    }
    const traceReplies = [];
    for (const trace of traces) {
      const reply = await until(async () => {
        const value = await json(tempoUrl + '/api/traces/' + trace.traceId);
        return spansOf(value).length >= 5 ? value : null;
      }, 'trace persisted in Tempo');
      const spans = spansOf(reply);
      assert.equal(spans.length, 5);
      assert.deepEqual(spans.map(span => span.name).sort(), ['aiops.agent.mcp', 'aiops.agent.model', 'aiops.agent.model', 'aiops.agent.run', 'aiops.agent.tool']);
      assert.doesNotMatch(JSON.stringify(reply), /PRIVATE_|billing|fixture-model-secret|fixture-mcp-secret|arguments/);
      traceReplies.push(reply);
    }
    report.checks.persistedRedactedTraces = { traces: traces.length, spans: traceReplies.reduce((total, reply) => total + spansOf(reply).length, 0), idempotent: true };
    const query = async expression => (await json(prometheusUrl + '/api/v1/query?' + new URLSearchParams({ query: expression }))).data.result;
    const workspaces = await until(async () => {
      const rows = await query('aiops_agent_trace_duration_seconds_count{job="aiops",stage="run"}');
      return rows.length === 2 && rows.reduce((sum, row) => sum + Number(row.value[1]), 0) === 3 ? rows : null;
    }, 'two separately labelled actual application metrics');
    assert.deepEqual(workspaces.map(row => [row.metric.instance, row.metric.workspace, Number(row.value[1])]).sort(), [['accept-1', 'accept-1', 1], ['accept-2', 'accept-2', 2]]);
    const aggregated = await until(async () => {
      const rows = await query('aiops:fleet_stage_completions_total{stage="run"}');
      return rows.length === 1 && Number(rows[0].value[1]) === 3 ? rows : null;
    }, 'fleet recording rules sum actual completed runs');
    const tokens = await query('aiops:fleet_model_tokens_total');
    assert.equal(Number(tokens[0].value[1]), 180);
    report.checks.multiInstanceMetrics = { instances: workspaces.length, runCounts: workspaces.map(row => Number(row.value[1])).sort(), fleetRuns: Number(aggregated[0].value[1]), fixtureTokens: 180 };
    await compose('restart', 'tempo');
    await until(async () => (await fetch(tempoUrl + '/ready')).ok, 'restarted Tempo readiness');
    for (const trace of traces) await until(async () => spansOf(await json(tempoUrl + '/api/traces/' + trace.traceId)).length === 5, 'trace recovered from Tempo WAL');
    report.checks.traceBackendRestartRecovery = true;
    await compose('stop', 'collector');
    const completed = await fixtures[0].request('/chat', { text: 'PRIVATE_ACCEPTANCE_PROMPT billing', requestKey: 'collector-down' });
    assert.equal(completed.status, 200); assert.equal(completed.data.metadata.executionTrace.status, 'completed');
    await until(() => fixtures[0].app.engine.traceMetrics().includes('aiops_agent_otlp_exports_total{status="failed"} 1'), 'export failure isolated from chat');
    report.checks.collectorFailureIsolated = true;
    const services = JSON.parse((await compose('config', '--format', 'json')).stdout).services;
    for (const service of ['collector', 'tempo', 'prometheus']) {
      const { stdout } = await run('docker', ['image', 'inspect', services[service].image, '--format', '{{.Id}}']);
      report.images.push({ service, pinnedReference: services[service].image, imageId: stdout.trim() });
    }
    report.passed = true;
  } catch (error) {
    report.passed = false;
    // Retain failure stage without container logs, request bodies, credentials or invoice contents.
    report.failure = error.message.includes(token) ? 'Observation acceptance failed' : error.message.slice(0, 500);
  } finally {
    for (const fixture of fixtures) await fixture.close();
    if (stackStarted) {
      try { await compose('down', '--volumes', '--remove-orphans'); report.checks.temporaryStackRemoved = true; }
      catch { report.checks.temporaryStackRemoved = false; report.passed = false; }
    }
    if (previousToken === undefined) delete process.env.METRICS_TOKEN;
    else process.env.METRICS_TOKEN = previousToken;
    rmSync(taskDir, { recursive: true, force: true });
  }
  report.finishedAt = new Date().toISOString();
  writeFileSync(output, JSON.stringify(report, null, 2) + '\n', { mode: 0o600, flag: 'wx' });
  return report;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const { values } = parseArgs({ options: { out: { type: 'string' } }, allowPositionals: false });
    const output = resolve(values.out || `test-results/observability/acceptance-${Date.now()}.json`);
    mkdirSync(dirname(output), { recursive: true, mode: 0o700 });
    const report = await acceptObservability(output);
    console.log(JSON.stringify({ passed: report.passed, checks: report.checks, failure: report.failure, output }));
    process.exitCode = report.passed ? 0 : 1;
  } catch (error) { console.error(error.code === 'EEXIST' ? 'Output already exists; choose a new path' : 'Observability acceptance could not complete'); process.exitCode = 1; }
}
