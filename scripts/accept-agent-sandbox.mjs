import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { startSandboxService } from '../integrations/agent-sandbox/service.mjs';
import { createSandboxMcpApp } from '../integrations/agent-sandbox/mcp.mjs';
import { brokerRequest } from '../integrations/agent-sandbox/client.mjs';
import { createApplication } from '../server/app.mjs';
import { listen } from '../tests/fixtures.mjs';

const [image = 'python:3.12-slim-bookworm', option, name] = process.argv.slice(2);
if (process.argv.length > 5 || (option !== undefined && option !== '--out') || (option === '--out' && (!name || !/^[\w-]+\.json$/.test(name)))) throw new Error('Usage: node scripts/accept-agent-sandbox.mjs [LOCAL_IMAGE] [--out REPORT.json]');
const output = resolve('test-results/agentscope', name || `sandbox-service-${randomUUID()}.json`);
const directory = mkdtempSync(join(tmpdir(), 'aiops-sandbox-real-'));
const token = () => randomBytes(32).toString('base64url');
const owner = { token: token(), tenantId: 'acceptance', userId: 'owner', role: 'submit' };
const other = { token: token(), tenantId: 'acceptance', userId: 'other', role: 'submit' };
const reviewer = { token: token(), tenantId: 'acceptance', userId: 'reviewer', role: 'admin' };
const foreign = { token: token(), tenantId: 'foreign', userId: 'reviewer', role: 'admin' };
const socketPath = join(directory, 'broker.sock');
const request = (principal, method, route, body) => brokerRequest({ socketPath, token: principal.token }, method, route, body);
const report = { version: 1, measuredAt: new Date().toISOString(), image, checks: [], passed: false,
  productExecutionEnabled: false, productionSecurityAccepted: false };
let service, listener, client, application, applicationServer;
const allJobs = [];
const doneStates = new Set(['completed', 'failed', 'cancelled', 'timed_out', 'unknown']);
async function check(label, action) { const evidence = await action(); report.checks.push({ label, passed: true, ...evidence }); }
async function submit(source, id = randomUUID()) {
  const body = { version: 1, jobId: id, runId: id, stepId: 'acceptance-step', language: 'python3.12', source };
  const job = await request(owner, 'POST', '/v1/jobs', body); allJobs.push(job.id); return { job, body };
}
async function finished(id) {
  const deadline = Date.now() + 45000;
  while (Date.now() < deadline) { const job = await request(owner, 'GET', `/v1/jobs/${id}`); if (doneStates.has(job.status)) return job; await delay(50); }
  throw new Error('Sandbox failed to reach terminal state');
}
const probe = `
import json, os, socket
from pathlib import Path
def writable(path):
    try: Path(path).write_text('probe'); return True
    except OSError: return False
network=False
try:
    s=socket.socket(); s.settimeout(0.1); s.connect(('198.51.100.1',9)); network=True
except OSError: pass
finally: s.close()
result={'appVisible':Path('/app').exists(),'dataVisible':Path('/app/.data').exists(),'secretVisible':Path('/run/secrets').exists(),'dockerSocketVisible':Path('/var/run/docker.sock').exists(),'rootWritable':writable('/tmp/probe'),'shmWritable':writable('/dev/shm/probe'),'network':network,'residueVisible':Path('/work/residue').exists(),'interfaces':sorted(os.listdir('/sys/class/net')),'routes':Path('/proc/net/route').read_text().strip().splitlines()[1:],'cwd':os.getcwd(),'workWritable':writable('/work/residue')}
Path('/work/output/probe.json').write_text(json.dumps(result))
`;
try {
  service = await startSandboxService({ image, stateDir: directory, socketPath, principals: [owner, other, reviewer, foreign] });
  report.runtime = service.broker.runtimeInfo;
  await check('authentication-and-fixed-request-policy', async () => {
    await assert.rejects(() => request({ token: token() }, 'POST', '/v1/jobs', {}), error => error.status === 401);
    await assert.rejects(() => request(owner, 'POST', '/v1/jobs', { version: 1, jobId: 'bad', runId: 'run', stepId: 'step', language: 'python3.12', source: 'print(1)', mounts: ['/app'] }), error => error.status === 400);
    return { unauthorized: 401, isolationOverride: 400 };
  });
  let first;
  await check('real-isolation-quarantine-ownership-and-admin-approval', async () => {
    const submitted = await submit(probe); first = await finished(submitted.job.id);
    assert.equal(first.status, 'completed'); assert.equal(first.configurationChecked, true); assert.equal(first.cleanupVerified, true);
    const repeated = await request(owner, 'POST', '/v1/jobs', submitted.body); assert.equal(repeated.id, first.id);
    await assert.rejects(() => request(owner, 'POST', '/v1/jobs', { ...submitted.body, source: 'print(2)' }), error => error.status === 409);
    const artifact = first.artifacts[0]; assert.equal(artifact.scan.clean, true); assert.equal(artifact.decision, 'pending');
    await assert.rejects(() => request(owner, 'GET', `/v1/jobs/${first.id}/artifacts/${artifact.id}/download`), error => error.status === 403);
    await assert.rejects(() => request(owner, 'GET', `/v1/jobs/${first.id}/artifacts/${artifact.id}/preview`), error => error.status === 403);
    await assert.rejects(() => request(other, 'GET', `/v1/jobs/${first.id}`), error => error.status === 404);
    await assert.rejects(() => request(foreign, 'GET', `/v1/jobs/${first.id}`), error => error.status === 404);
    const snapshot = JSON.parse((await request(reviewer, 'GET', `/v1/jobs/${first.id}/artifacts/${artifact.id}/preview`)).toString());
    for (const key of ['appVisible', 'dataVisible', 'secretVisible', 'dockerSocketVisible', 'rootWritable', 'shmWritable', 'network', 'residueVisible']) assert.equal(snapshot[key], false, key);
    assert.equal(snapshot.interfaces.some(name => /^(?:eth|veth|wlan|en\d)/.test(name)), false); assert.deepEqual(snapshot.routes, []);
    assert.equal(snapshot.cwd, '/work'); assert.equal(snapshot.workWritable, true);
    const decision = { decision: 'approved', sha256: artifact.sha256, reason: 'Inspected fixed isolation probe JSON' };
    await assert.rejects(() => request(owner, 'POST', `/v1/jobs/${first.id}/artifacts/${artifact.id}/decision`, decision), error => error.status === 403);
    await request(reviewer, 'POST', `/v1/jobs/${first.id}/artifacts/${artifact.id}/decision`, decision);
    assert.deepEqual(JSON.parse((await request(owner, 'GET', `/v1/jobs/${first.id}/artifacts/${artifact.id}/download`)).toString()), snapshot);
    return { jobId: first.id, snapshot, cleanupVerified: true, duplicateReused: true, deniedUntilApproved: true };
  });
  await check('new-job-has-no-prior-work-disk', async () => {
    const { job } = await submit(probe); const completed = await finished(job.id); assert.equal(completed.status, 'completed');
    const artifact = completed.artifacts[0];
    const snapshot = JSON.parse((await request(reviewer, 'GET', `/v1/jobs/${job.id}/artifacts/${artifact.id}/preview`)).toString());
    assert.equal(snapshot.residueVisible, false); return { jobId: job.id, residueVisible: false, cleanupVerified: completed.cleanupVerified };
  });
  await check('active-content-stays-blocked', async () => {
    const { job } = await submit("from pathlib import Path; Path('/work/output/bad.txt').write_text('<script>alert(1)</script>')");
    const completed = await finished(job.id); assert.equal(completed.status, 'completed');
    const artifact = completed.artifacts[0]; assert.equal(artifact.decision, 'blocked');
    await assert.rejects(() => request(reviewer, 'POST', `/v1/jobs/${job.id}/artifacts/${artifact.id}/decision`, { decision: 'approved', sha256: artifact.sha256, reason: 'Must fail closed' }), error => error.status === 409);
    return { blocked: true, reasons: artifact.scan.reasons, cleanupVerified: completed.cleanupVerified };
  });
  for (const [label, source, expected] of [
    ['stdout-quota', "print('x'*70000)", 'output_quota'],
    ['artifact-quota', "from pathlib import Path; Path('/work/output/large.txt').write_text('x'*1048577)", 'unsafe_artifact'],
    ['symbolic-artifact', "import os; os.symlink('/etc/passwd','/work/output/escape.txt')", 'unsafe_artifact'],
  ]) await check(label, async () => {
    const { job } = await submit(source); const completed = await finished(job.id);
    assert.equal(completed.status, 'failed'); assert.equal(completed.error, expected); assert.equal(completed.artifacts.length, 0); assert.equal(completed.cleanupVerified, true);
    return { status: completed.status, error: completed.error, cleanupVerified: true };
  });
  await check('running-cancellation-kills-container', async () => {
    const { job } = await submit('import time; time.sleep(30)'); let running = false;
    for (let attempt = 0; attempt < 100; attempt++) {
      try { running = JSON.parse(await service.broker.runtime.docker(['inspect', '--format', '{{json .State.Running}}', job.containerName])); } catch { /* create pending */ }
      if (running) break; await delay(50);
    }
    assert.equal(running, true); await request(owner, 'POST', `/v1/jobs/${job.id}/cancel`);
    const completed = await finished(job.id); assert.equal(completed.status, 'cancelled'); assert.equal(completed.cleanupVerified, true);
    return { startedRunning: true, status: 'cancelled', cleanupVerified: true };
  });
  await check('wall-timeout-kills-container', async () => {
    const { job } = await submit('import time; time.sleep(30)'); const completed = await finished(job.id);
    assert.equal(completed.status, 'timed_out'); assert.equal(completed.cleanupVerified, true); return { status: 'timed_out', cleanupVerified: true };
  });
  await check('real-mcp-sdk-only-exposes-write-execute-and-read-state', async () => {
    const mcpToken = token();
    const app = createSandboxMcpApp({ socketPath, brokerToken: owner.token, mcpToken });
    listener = await new Promise(resolveListen => { const result = app.listen(0, '127.0.0.1', () => resolveListen(result)); });
    client = new Client({ name: 'sandbox-acceptance', version: '1.0.0' });
    await client.connect(new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${listener.address().port}/mcp`), { requestInit: { headers: { Authorization: `Bearer ${mcpToken}` } } }));
    const tools = (await client.listTools()).tools;
    assert.equal(tools.length, 2); assert.equal(tools.find(tool => tool.name === 'sandbox_execute_python').annotations.readOnlyHint, false);
    assert.equal(tools.find(tool => tool.name === 'sandbox_get_job').annotations.readOnlyHint, true);
    const result = await client.callTool({ name: 'sandbox_execute_python', arguments: { jobId: randomUUID(), runId: 'sdk-run', stepId: 'sdk-step', source: "from pathlib import Path; Path('/work/output/result.txt').write_text('safe SDK result')" } });
    const value = result.structuredContent || JSON.parse(result.content[0].text); allJobs.push(value.job);
    assert.equal(result.isError, undefined); assert.equal(value.status, 'completed'); assert.equal(value.artifacts[0].decision, 'pending');
    assert.equal(JSON.stringify(result).includes('safe SDK result'), false);
    const status = await client.callTool({ name: 'sandbox_get_job', arguments: { id: value.job } }); assert.equal(status.isError, undefined);
    // SDK cancellation must stop the broker job rather than only closing HTTP.
    const cancelledRunTag = randomUUID(); const controller = new AbortController();
    const cancelledCall = client.callTool({ name: 'sandbox_execute_python', arguments: { jobId: randomUUID(), runId: cancelledRunTag, stepId: 'cancel-sdk', source: 'import time; time.sleep(30)' } }, undefined, { signal: controller.signal, timeout: 30000 }).catch(error => error);
    let cancelledJob; let sdkStartedRunning = false;
    for (let attempt = 0; attempt < 100; attempt++) {
      cancelledJob = [...service.broker.jobs.values()].find(job => job.runId === cancelledRunTag);
      if (cancelledJob) {
        try { if (JSON.parse(await service.broker.runtime.docker(['inspect', '--format', '{{json .State.Running}}', cancelledJob.containerName]))) { sdkStartedRunning = true; break; } } catch { /* create pending */ }
      }
      await delay(50);
    }
    assert(cancelledJob); assert.equal(sdkStartedRunning, true); controller.abort(); await cancelledCall; allJobs.push(cancelledJob.id);
    const stoppedSdkJob = await finished(cancelledJob.id); assert.equal(stoppedSdkJob.status, 'cancelled'); assert.equal(stoppedSdkJob.cleanupVerified, true);
    await client.close(); client = null;
    // Actual application governance, isolated SQLite, no model or live business resources.
    application = createApplication({ dataDir: join(directory, 'application'), scheduler: false });
    applicationServer = await listen(application.app);
    let cookie = '';
    const api = async (path, body, method = body === undefined ? 'GET' : 'POST', who = cookie) => {
      const response = await fetch(applicationServer.url + '/api' + path, { method, headers: { 'Content-Type': 'application/json', Cookie: who }, ...(body !== undefined ? { body: JSON.stringify(body) } : {}) });
      return { status: response.status, data: await response.json(), cookie: response.headers.get('set-cookie')?.split(';')[0] };
    };
    cookie = (await api('/auth/setup', { username: 'owner', password: 'sandbox-owner-long-password' })).cookie;
    assert.equal((await api('/users', { username: 'reviewer', password: 'sandbox-reviewer-long-password', role: 'admin' })).status, 201);
    const reviewCookie = (await api('/auth/login', { username: 'reviewer', password: 'sandbox-reviewer-long-password' })).cookie;
    const runTag = randomUUID(); const stepTag = 'fixed-python';
    const resources = await api('/resources', { kind: 'mcp', name: 'local sandbox acceptance', environment: 'production', endpoint: `http://127.0.0.1:${listener.address().port}/mcp`, token: mcpToken,
      allowedTools: ['sandbox_execute_python', 'sandbox_get_job'], toolPolicies: {
        sandbox_execute_python: { risk: 'write', environments: ['production'], constraints: { runId: [runTag], stepId: [stepTag] }, idempotencyArgument: 'jobId',
          verification: { tool: 'sandbox_get_job', arguments: { runId: runTag, stepId: stepTag }, path: 'status', equals: 'completed' }, recovery: 'Cancel broker task then confirm cleanup and remove quarantined bytes; never replay unknown jobs' },
        sandbox_get_job: { risk: 'read', environments: ['production'], constraints: { runId: [runTag], stepId: [stepTag] } },
      } });
    assert.equal(resources.status, 201, JSON.stringify(resources.data));
    const source = "from pathlib import Path; Path('/work/output/approved.txt').write_text('approved fixed application source')";
    const plan = { resourceId: resources.data.id, tool: 'sandbox_execute_python', environment: 'production', requestKey: 'sandbox-governance-once', arguments: { runId: runTag, stepId: stepTag, jobId: 'placeholder', source } };
    const before = service.broker.jobs.size;
    const pending = await api('/executions/tool', plan); assert.equal(pending.status, 202); assert.equal(pending.data.status, 'awaiting_approval');
    assert.equal(service.broker.jobs.size, before);
    assert.equal((await api('/executions/tool', { ...plan, arguments: { ...plan.arguments, source: 'print("changed")' } })).status, 409);
    assert.equal((await api(`/approvals/${pending.data.stepId}/approve`, {})).status, 403);
    const approved = await api(`/approvals/${pending.data.stepId}/approve`, {}, 'POST', reviewCookie);
    assert.equal(approved.status, 200, JSON.stringify(approved.data)); assert.equal(approved.data.status, 'success');
    assert.equal(approved.data.steps[0].verification.matches, true);
    assert.equal(service.broker.jobs.size, before + 1);
    const governedJob = [...service.broker.jobs.values()].find(job => job.jobId === pending.data.stepId);
    assert(governedJob); assert.equal(governedJob.status, 'completed'); assert.equal(governedJob.artifacts[0].decision, 'pending'); allJobs.push(governedJob.id);
    assert.equal((await api('/executions/tool', plan)).data.status, 'success'); assert.equal(service.broker.jobs.size, before + 1);
    await applicationServer.close(); applicationServer = null; await application.close(); application = null;
    return { toolCount: 2, executeRequiresWriteGovernance: true, artifactContentAbsent: true, status: value.status,
      sdkCancellation: stoppedSdkJob.status, productApprovalVerified: true, noJobBeforeApproval: true, fixedSourceTamperDenied: 409,
      independentApprover: true, persistedWriteVerification: true, artifactDecisionAfterProductApproval: 'pending' };
  });
  await check('explicit-delete-recycles-quarantined-bytes', async () => {
    const deleted = await request(owner, 'DELETE', `/v1/jobs/${first.id}`); assert.equal(deleted.status, 'deleted'); assert.equal(deleted.artifacts.length, 0);
    return { status: 'deleted', artifactsRemaining: 0 };
  });
  report.passed = report.checks.length === 11;
} catch (error) { report.failure = { name: error.name, message: error.message }; }
finally {
  await client?.close().catch(() => {});
  await applicationServer?.close().catch(() => {}); await application?.close().catch(() => {});
  if (listener) await new Promise(resolveClose => { listener.close(resolveClose); listener.closeAllConnections(); });
  if (service) {
    await service.close();
    const runtime = service.broker.runtime;
    report.cleanupVerified = true;
    for (const id of allJobs) { try { if (!await runtime.remove(`aiops-sandbox-job-${id}`)) report.cleanupVerified = false; } catch { report.cleanupVerified = false; } }
  } else report.cleanupVerified = false;
  rmSync(directory, { recursive: true, force: true });
  if (!report.cleanupVerified) report.passed = false;
  mkdirSync(resolve('test-results/agentscope'), { recursive: true });
  writeFileSync(output, JSON.stringify(report, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
  console.log(JSON.stringify({ reportFile: output, passed: report.passed, checks: report.checks.length, cleanupVerified: report.cleanupVerified,
    failure: report.failure, productionSecurityAccepted: false }));
  if (!report.passed) process.exitCode = 2;
}
