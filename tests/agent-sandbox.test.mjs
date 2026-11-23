import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { SandboxBroker } from '../integrations/agent-sandbox/broker.mjs';
import { authenticate, digest, limits, scanArtifact, validatePrincipals, validateRequest } from '../integrations/agent-sandbox/policy.mjs';
import { cancelSandboxSubmission } from '../integrations/agent-sandbox/mcp.mjs';

const user = { tenantId: 'alpha', userId: 'alice', role: 'submit' };
const other = { tenantId: 'alpha', userId: 'bob', role: 'submit' };
const admin = { tenantId: 'alpha', userId: 'reviewer', role: 'admin' };
const alien = { tenantId: 'beta', userId: 'reviewer', role: 'admin' };
const request = (jobId = 'demo') => ({ version: 1, jobId, runId: `run-${jobId}`, stepId: 'step1', language: 'python3.12', source: 'print("safe")' });
const envelope = (name = 'result.txt', text = 'safe output') => ({ version: 1, exitCode: 0, stdout: 'done', stderr: '', error: null,
  artifacts: [{ name, contentBase64: Buffer.from(text).toString('base64') }] });
class FakeRuntime {
  constructor(result = envelope()) { this.envelope = result; this.starts = 0; this.removals = 0; }
  async initialize() { return { imageId: `sha256:${'a'.repeat(64)}` }; }
  async remove() { this.removals++; return true; }
  async run({ signal }) {
    this.starts++;
    if (this.hold) { while (!signal.aborted) await delay(5); return { status: 'cancelled', cleanupVerified: true }; }
    return { status: 'completed', cleanupVerified: true, envelope: this.envelope, configurationChecked: true };
  }
}
async function fixture(t, runtime = new FakeRuntime(), options = {}) {
  const stateDir = mkdtempSync(join(tmpdir(), 'aiops-sandbox-unit-'));
  const broker = new SandboxBroker({ stateDir, runtime, ...options }); await broker.initialize();
  t.after(async () => { await broker.close(); rmSync(stateDir, { recursive: true, force: true }); });
  return { broker, runtime, stateDir };
}
async function finished(broker, id) {
  for (let i = 0; i < 100; i++) { const job = broker.get(user, id); if (['completed', 'cancelled', 'unknown', 'failed'].includes(job.status)) return job; await delay(5); }
  throw new Error('Fixture job did not finish');
}

test('sandbox policy rejects caller-controlled isolation and binds canonical source content', () => {
  const accepted = validateRequest(request());
  assert.equal(accepted.requestDigest, validateRequest(Object.fromEntries(Object.entries(request()).reverse())).requestDigest);
  for (const changes of [{ image: 'unsafe' }, { env: {} }, { mount: '/app' }, { network: 'host' }, { inputs: [] },
    { source: 'x'.repeat(limits.sourceBytes + 1) }, { jobId: '../app' }, { language: 'shell' }]) {
    assert.throws(() => validateRequest({ ...request(), ...changes }));
  }
  assert.notEqual(accepted.sourceSha256, validateRequest({ ...request(), source: 'print("changed")' }).sourceSha256);
});
test('sandbox bearer identities cannot supply tenant or privilege fields', () => {
  const token = 'a'.repeat(40);
  const principals = validatePrincipals([{ ...user, token }, { ...admin, token: 'b'.repeat(40) }]);
  assert.equal(authenticate(principals, `Bearer ${token}`).userId, 'alice');
  assert.throws(() => authenticate(principals, `Bearer ${'c'.repeat(40)}`), /unauthorized/);
  assert.throws(() => authenticate(principals, token), /unauthorized/);
  assert.throws(() => validatePrincipals([{ ...user, token, roles: ['admin'] }]));
});
test('artifact scanner blocks traversal, active files, binary, secrets, formula and malformed data', () => {
  const check = (name, text) => scanArtifact(name, Buffer.from(text).toString('base64'));
  assert.equal(check('result.json', '{"ok":true}').clean, true);
  for (const [name, text] of [['../outside.txt', 'safe'], ['result.html', 'safe'], ['result.txt', '<script>alert(1)</script>'],
    ['result.csv', 'label,=HYPERLINK("evil")'], ['result.txt', '\0binary'], ['result.json', '{broken'],
    ['result.txt', '-----BEGIN PRIVATE KEY-----']]) assert.equal(check(name, text).clean, false, name);
  assert.equal(scanArtifact('result.txt', 'not base64').clean, false);
});
test('broker deduplicates identity and source while denying cross-user and cross-tenant access', async t => {
  const { broker, runtime } = await fixture(t);
  const first = broker.submit(user, request());
  assert.equal(broker.submit(user, request()).id, first.id);
  assert.throws(() => broker.submit(user, { ...request(), source: 'print(2)' }), /job_digest_conflict/);
  assert.throws(() => broker.submit(other, request()), /job_identity_conflict/);
  assert.throws(() => broker.submit(user, { ...request(), jobId: 'different-job' }), /step_identity_conflict/);
  assert.throws(() => broker.submit(admin, request()), /submit_role_required/);
  await finished(broker, first.id); assert.equal(runtime.starts, 1);
  assert.throws(() => broker.get(other, first.id), /job_not_found/);
  assert.throws(() => broker.get(alien, first.id), /job_not_found/);
  assert.equal(broker.get(admin, first.id).userId, 'alice');
  assert.equal(broker.findByStep(user, 'run-demo', 'step1').id, first.id);
  assert.throws(() => broker.findByStep(other, 'run-demo', 'step1'), /job_not_found/);
});
test('quarantine requires independent explicit admin decision, digest integrity and owner ACL', async t => {
  const { broker, stateDir } = await fixture(t);
  const first = broker.submit(user, request()); const job = await finished(broker, first.id);
  const artifact = job.artifacts[0]; assert.equal(artifact.decision, 'pending');
  assert.throws(() => broker.download(user, job.id, artifact.id), /artifact_not_approved/);
  assert.throws(() => broker.preview(user, job.id, artifact.id), /independent_admin_required/);
  assert.equal(broker.preview(admin, job.id, artifact.id).buffer.toString(), 'safe output');
  const decision = { decision: 'approved', sha256: artifact.sha256, reason: 'Reviewed safe text' };
  assert.throws(() => broker.decide(user, job.id, artifact.id, decision), /independent_admin_required/);
  assert.throws(() => broker.decide(admin, job.id, artifact.id, { ...decision, sha256: 'wrong' }), /artifact_not_approvable/);
  broker.decide(admin, job.id, artifact.id, decision);
  assert.equal(broker.download(user, job.id, artifact.id).buffer.toString(), 'safe output');
  assert.throws(() => broker.download(other, job.id, artifact.id), /job_not_found/);
  writeFileSync(join(stateDir, job.id, artifact.id), 'tampered');
  assert.throws(() => broker.download(user, job.id, artifact.id), /artifact_integrity_failed/);
  assert.throws(() => broker.preview(admin, job.id, artifact.id), /artifact_integrity_failed/);
  assert.throws(() => broker.decide(admin, job.id, artifact.id, decision), /artifact_not_approvable/);
  assert.equal(JSON.parse(readFileSync(join(stateDir, 'jobs.json'))).jobs[0].artifacts[0].approvedBy, 'reviewer');
});
test('blocked content cannot be approved and rejection cannot be reversed', async t => {
  const { broker, runtime } = await fixture(t, new FakeRuntime(envelope('result.txt', '<script>bad</script>')));
  const blocked = await finished(broker, broker.submit(user, request()).id);
  const artifact = blocked.artifacts[0]; assert.equal(artifact.decision, 'blocked');
  assert.throws(() => broker.decide(admin, blocked.id, artifact.id, { decision: 'approved', sha256: artifact.sha256, reason: 'please approve' }), /artifact_not_approvable/);
  runtime.envelope = envelope();
  const rejected = await finished(broker, broker.submit(user, request('second')).id);
  const clean = rejected.artifacts[0];
  broker.decide(admin, rejected.id, clean.id, { decision: 'rejected', sha256: clean.sha256, reason: 'Do not export' });
  assert.throws(() => broker.download(user, rejected.id, clean.id), /artifact_not_approved/);
  assert.throws(() => broker.decide(admin, rejected.id, clean.id, { decision: 'approved', sha256: clean.sha256, reason: 'Changed mind' }), /artifact_not_approvable/);
});
test('running cancellation and TTL remove resources and retain bounded status tombstones', async t => {
  let measured = Date.now(); const runtime = new FakeRuntime(); runtime.hold = true;
  const { broker, stateDir } = await fixture(t, runtime, { now: () => measured, retentionMs: 1000 });
  const submitted = broker.submit(user, request());
  while (broker.get(user, submitted.id).status !== 'running') await delay(5);
  await broker.cancel(user, submitted.id);
  assert.equal((await finished(broker, submitted.id)).status, 'cancelled');
  assert.equal(broker.get(user, submitted.id).cleanupVerified, true);
  runtime.hold = false;
  const completed = await finished(broker, broker.submit(user, request('exports')).id);
  measured += 1001; await broker.expire();
  const expired = broker.get(user, completed.id); assert.equal(expired.status, 'expired'); assert.equal(expired.artifacts.length, 0);
  assert.throws(() => broker.download(user, completed.id, completed.artifacts[0].id), /job_expired/);
  assert.equal(broker.submit(user, request('exports')).id, completed.id);
  assert.equal(readFileSync(join(stateDir, 'jobs.json'), 'utf8').includes('print('), false);
});
test('restart never reruns an uncertain job and independently verifies container cleanup', async t => {
  const stateDir = mkdtempSync(join(tmpdir(), 'aiops-sandbox-restart-'));
  const id = 'a'.repeat(8) + '-aaaa-aaaa-aaaa-' + 'a'.repeat(12);
  writeFileSync(join(stateDir, 'jobs.json'), JSON.stringify({ version: 1, jobs: [{ id, revision: 1, containerName: `aiops-sandbox-job-${id}`,
    status: 'running', artifacts: [], tenantId: 'alpha', userId: 'alice', expiresAt: new Date(Date.now() + 60000).toISOString() }] }));
  const runtime = new FakeRuntime(); const broker = new SandboxBroker({ stateDir, runtime }); await broker.initialize();
  t.after(async () => { await broker.close(); rmSync(stateDir, { recursive: true, force: true }); });
  const job = broker.get(user, id); assert.equal(job.status, 'unknown'); assert.equal(job.error, 'broker_restarted');
  assert.equal(job.cleanupVerified, true); assert.equal(runtime.starts, 0); assert.equal(runtime.removals, 1);
});
test('unconfirmed cleanup quarantines capacity until independent removal succeeds', async t => {
  const runtime = new FakeRuntime(); let reclaimed = false;
  runtime.remove = async () => reclaimed;
  runtime.run = async () => { runtime.starts++; return runtime.starts === 1 ? { status: 'unknown', cleanupVerified: false, error: 'cleanup_unverified' }
    : { status: 'completed', cleanupVerified: true, envelope: envelope(), configurationChecked: true }; };
  const { broker } = await fixture(t, runtime);
  const first = broker.submit(user, request('uncertain')); const second = broker.submit(user, request('queued'));
  assert.equal((await finished(broker, first.id)).cleanupVerified, false);
  await broker.maintain(); await delay(10);
  assert.equal(runtime.starts, 1); assert.equal(broker.get(user, second.id).status, 'queued');
  assert.throws(() => broker.submit(user, request('new-job')), /cleanup_quarantine/);
  reclaimed = true; await broker.maintain();
  assert.equal((await finished(broker, second.id)).status, 'completed');
  assert.equal(runtime.starts, 2); assert.equal(broker.get(user, first.id).status, 'unknown');
  assert.equal(broker.get(user, first.id).cleanupVerified, true);
});
test('shutdown retries unknown resources and reports failed reclamation honestly', async t => {
  const runtime = new FakeRuntime(); runtime.remove = async () => false;
  runtime.run = async () => ({ status: 'unknown', cleanupVerified: false });
  const { broker } = await fixture(t, runtime);
  const job = broker.submit(user, request('shutdown-unknown')); await finished(broker, job.id);
  assert.deepEqual(await broker.close(), { cleanupVerified: false });
  assert.equal(broker.get(user, job.id).status, 'unknown'); assert.equal(broker.get(user, job.id).cleanupVerified, false);
});
test('cancel recovery cannot cancel a conflicting historical step identity', async () => {
  const args = { jobId: 'current-job', runId: 'same-run', stepId: 'same-step', source: 'print("current")' };
  let posts = 0;
  const existing = { id: 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', jobId: args.jobId, runId: args.runId, stepId: args.stepId, sourceSha256: digest(args.source) };
  const requestBroker = async (_client, method) => { if (method === 'POST') posts++; return existing; };
  assert.equal(await cancelSandboxSubmission({}, args, { ...existing, jobId: 'historical-job' }, requestBroker), false);
  assert.equal(await cancelSandboxSubmission({}, args, { ...existing, sourceSha256: digest('other source') }, requestBroker), false);
  assert.equal(await cancelSandboxSubmission({}, args, { ...existing, runId: 'other-run' }, requestBroker), false);
  assert.equal(posts, 0);
  assert.equal(await cancelSandboxSubmission({}, args, undefined, requestBroker), true); assert.equal(posts, 1);
});
test('approval requires the same administrator preview and rechecks current quarantined bytes', async t => {
  const { broker, stateDir } = await fixture(t);
  const job = await finished(broker, broker.submit(user, request('preview-bound')).id);
  const artifact = job.artifacts[0]; const decision = { decision: 'approved', sha256: artifact.sha256, reason: 'Reviewed local output' };
  assert.throws(() => broker.decide(admin, job.id, artifact.id, decision), /artifact_not_previewed/);
  broker.preview({ ...admin, userId: 'different-reviewer' }, job.id, artifact.id);
  assert.throws(() => broker.decide(admin, job.id, artifact.id, decision), /artifact_not_previewed/);
  broker.preview(admin, job.id, artifact.id);
  writeFileSync(join(stateDir, job.id, artifact.id), 'changed after preview');
  assert.throws(() => broker.decide(admin, job.id, artifact.id, decision), /artifact_integrity_failed/);
  assert.equal(broker.get(user, job.id).artifacts[0].decision, 'pending');
});
