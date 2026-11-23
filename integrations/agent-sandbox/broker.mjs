import { randomUUID } from 'node:crypto';
import { closeSync, existsSync, lstatSync, mkdirSync, openSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { exactKeys, limits, SandboxError, scanArtifact, validateRequest } from './policy.mjs';

const terminal = new Set(['completed', 'failed', 'cancelled', 'timed_out', 'unknown', 'expired', 'deleted']);
const uuid = /^[a-f0-9-]{36}$/;
export class SandboxBroker {
  constructor({ stateDir, runtime, now = Date.now, retentionMs = limits.retentionMs }) {
    if (!stateDir || !runtime || !Number.isSafeInteger(retentionMs) || retentionMs < 1000 || retentionMs > limits.retentionMs) throw new Error('Invalid broker configuration');
    this.stateDir = resolve(stateDir);
    this.runtime = runtime;
    this.now = now;
    this.retentionMs = retentionMs;
    this.jobs = new Map();
    this.sources = new Map();
    this.controllers = new Map();
    this.closing = false;
    this.running = false;
  }
  async initialize() {
    mkdirSync(this.stateDir, { recursive: true, mode: 0o700 });
    const info = lstatSync(this.stateDir);
    if (!info.isDirectory() || info.isSymbolicLink() || (info.mode & 0o077)) throw new Error('Sandbox state directory must be private');
    const lock = join(this.stateDir, 'service.lock');
    try { this.lockFd = openSync(lock, 'wx', 0o600); }
    catch (error) {
      if (error.code !== 'EEXIST') throw error;
      const pid = Number(readFileSync(lock, 'utf8'));
      if (!Number.isSafeInteger(pid) || pid < 1) throw new Error('Invalid broker lock');
      try { process.kill(pid, 0); throw new Error('Sandbox broker already running'); }
      catch (probe) { if (probe.code !== 'ESRCH') throw probe; }
      rmSync(lock); this.lockFd = openSync(lock, 'wx', 0o600);
    }
    writeFileSync(this.lockFd, String(process.pid));
    try {
      this.runtimeInfo = await this.runtime.initialize();
      const file = join(this.stateDir, 'jobs.json');
      if (existsSync(file)) {
        const saved = JSON.parse(readFileSync(file, 'utf8'));
        if (saved.version !== 1 || !Array.isArray(saved.jobs) || saved.jobs.length > 2048) throw new Error('Invalid persisted broker state');
        for (const job of saved.jobs) {
          if (!uuid.test(job.id) || job.containerName !== `aiops-sandbox-job-${job.id}` || !Array.isArray(job.artifacts)) throw new Error('Invalid persisted job identity');
          this.jobs.set(job.id, job);
          if (!terminal.has(job.status)) {
            job.status = 'unknown'; job.error = 'broker_restarted'; job.revision++;
            try { job.cleanupVerified = await this.runtime.remove(job.containerName); } catch { job.cleanupVerified = false; }
          }
        }
      }
      this.persist();
      await this.maintain();
      this.sweep = setInterval(() => { void this.maintain().catch(() => {}); }, 1000).unref();
      return this.runtimeInfo;
    } catch (error) { this.releaseLock(); throw error; }
  }
  releaseLock() {
    if (this.lockFd !== undefined) { closeSync(this.lockFd); rmSync(join(this.stateDir, 'service.lock'), { force: true }); this.lockFd = undefined; }
  }
  persist() {
    const file = join(this.stateDir, 'jobs.json');
    const temporary = join(this.stateDir, 'jobs.next.json');
    writeFileSync(temporary, JSON.stringify({ version: 1, jobs: [...this.jobs.values()] }) + '\n', { mode: 0o600 });
    renameSync(temporary, file);
  }
  changed(job) { job.revision++; job.updatedAt = new Date(this.now()).toISOString(); this.persist(); }
  visible(principal, job) {
    return job.tenantId === principal.tenantId && (job.userId === principal.userId || principal.role === 'admin');
  }
  owned(principal, id) {
    const job = this.jobs.get(id);
    if (!job || !this.visible(principal, job)) throw new SandboxError(404, 'job_not_found');
    return job;
  }
  view(job) { return structuredClone(job); }
  get(principal, id) { return this.view(this.owned(principal, id)); }
  hasUnreclaimed() { return [...this.jobs.values()].some(job => job.status === 'unknown' && !job.cleanupVerified); }
  findByStep(principal, runId, stepId) {
    const matches = [...this.jobs.values()].filter(job => this.visible(principal, job) && job.runId === runId && job.stepId === stepId);
    if (!matches.length) throw new SandboxError(404, 'job_not_found');
    if (matches.length !== 1) throw new SandboxError(409, 'step_identity_ambiguous');
    return this.view(matches[0]);
  }
  submit(principal, body) {
    if (this.closing) throw new SandboxError(503, 'broker_closing');
    if (principal.role !== 'submit') throw new SandboxError(403, 'submit_role_required');
    const request = validateRequest(body);
    const existing = [...this.jobs.values()].find(job => job.tenantId === principal.tenantId && job.jobId === request.jobId);
    if (existing) {
      if (existing.userId !== principal.userId) throw new SandboxError(409, 'job_identity_conflict');
      if (existing.requestDigest !== request.requestDigest) throw new SandboxError(409, 'job_digest_conflict');
      return this.view(existing);
    }
    if ([...this.jobs.values()].some(job => job.tenantId === principal.tenantId && job.userId === principal.userId
      && job.runId === request.runId && job.stepId === request.stepId)) throw new SandboxError(409, 'step_identity_conflict');
    if (this.hasUnreclaimed()) throw new SandboxError(503, 'cleanup_quarantine');
    if (this.jobs.size >= 2048 || [...this.jobs.values()].filter(job => !terminal.has(job.status)).length >= limits.pendingJobs
      || [...this.jobs.values()].filter(job => job.tenantId === principal.tenantId && !['expired', 'deleted'].includes(job.status)).length >= limits.jobsPerTenant) {
      throw new SandboxError(429, 'job_quota');
    }
    const id = randomUUID();
    const job = { id, version: 1, revision: 1, tenantId: principal.tenantId, userId: principal.userId,
      jobId: request.jobId, runId: request.runId, stepId: request.stepId,
      requestDigest: request.requestDigest, sourceSha256: request.sourceSha256, language: request.language,
      status: 'queued', containerName: `aiops-sandbox-job-${id}`, cleanupVerified: false,
      imageId: this.runtimeInfo.imageId, createdAt: new Date(this.now()).toISOString(), updatedAt: new Date(this.now()).toISOString(),
      expiresAt: new Date(this.now() + this.retentionMs).toISOString(), artifacts: [], error: null,
      productionSecurityAccepted: false };
    this.jobs.set(id, job);
    this.sources.set(id, request.source);
    this.persist();
    setImmediate(() => { void this.pump(); });
    return this.view(job);
  }
  async pump() {
    if (this.running || this.closing || this.hasUnreclaimed()) return;
    this.running = true;
    try {
      while (!this.closing) {
        // A failed cleanup still occupies global execution capacity. Never
        // dispatch the next container while a previous cgroup might survive.
        if (this.hasUnreclaimed()) break;
        const job = [...this.jobs.values()].find(value => value.status === 'queued');
        if (!job) break;
        const controller = new AbortController();
        this.controllers.set(job.id, controller);
        job.status = 'running'; this.changed(job);
        const source = this.sources.get(job.id); this.sources.delete(job.id);
        try {
          const result = await this.runtime.run({ containerName: job.containerName, source, signal: controller.signal });
          job.status = controller.signal.aborted && result.cleanupVerified ? 'cancelled' : result.status;
          job.cleanupVerified = result.cleanupVerified === true;
          job.error = result.error || result.envelope?.error || null;
          job.configurationChecked = result.configurationChecked === true;
          if (!job.cleanupVerified) { job.status = 'unknown'; job.error = 'cleanup_unverified'; }
          if (job.status === 'completed' && result.envelope) this.quarantine(job, result.envelope);
        } catch {
          job.status = 'unknown'; job.error = 'broker_runtime_failed';
          try { job.cleanupVerified = await this.runtime.remove(job.containerName); } catch { job.cleanupVerified = false; }
        } finally { this.controllers.delete(job.id); this.changed(job); }
      }
    } finally { this.running = false; }
  }
  quarantine(job, envelope) {
    if (!Array.isArray(envelope.artifacts) || envelope.artifacts.length > limits.artifacts) throw new Error('Artifact count quota');
    let total = 0;
    const names = new Set();
    const scanned = envelope.artifacts.map(value => {
      if (!exactKeys(value, ['name', 'contentBase64']) || typeof value.name !== 'string' || value.name.length > 80
        || /[\x00-\x1f]/.test(value.name) || names.has(value.name)) throw new Error('Invalid artifact envelope');
      names.add(value.name);
      const scan = scanArtifact(value.name, value.contentBase64);
      total += scan.bytes || 0;
      if (total > limits.artifactBytes || scan.buffer === null) throw new Error('Artifact bytes quota');
      return { name: value.name, scan };
    });
    const directory = join(this.stateDir, job.id);
    mkdirSync(directory, { mode: 0o700 });
    try {
      for (const { name, scan } of scanned) {
        const id = randomUUID();
        writeFileSync(join(directory, id), scan.buffer, { flag: 'wx', mode: 0o600 });
        job.artifacts.push({ id, name, bytes: scan.bytes, sha256: scan.sha256, scan: { clean: scan.clean, reasons: scan.reasons,
          policy: 'text-only-v1', scannedAt: new Date(this.now()).toISOString() },
        decision: scan.clean ? 'pending' : 'blocked', approvedBy: null, decidedAt: null,
        previewedBy: null, previewedAt: null, previewedSha256: null });
      }
    } catch (error) { rmSync(directory, { recursive: true, force: true }); job.artifacts = []; throw error; }
    // Diagnostics remain data; the broker never interprets them as instructions.
    job.diagnostics = { stdoutBytes: Buffer.byteLength(envelope.stdout || ''), stderrBytes: Buffer.byteLength(envelope.stderr || ''),
      stdoutSha256: scanArtifact('stdout.txt', Buffer.from(envelope.stdout || '').toString('base64')).sha256 };
  }
  async cancel(principal, id) {
    const job = this.owned(principal, id);
    if (['expired', 'deleted'].includes(job.status) || terminal.has(job.status)) return this.view(job);
    if (job.status === 'queued') { this.sources.delete(id); job.status = 'cancelled'; job.cleanupVerified = true; this.changed(job); }
    else { job.cancelRequestedAt = new Date(this.now()).toISOString(); this.controllers.get(id)?.abort(); this.changed(job); }
    return this.view(job);
  }
  decide(principal, id, artifactId, body) {
    const job = this.owned(principal, id);
    if (principal.role !== 'admin' || principal.userId === job.userId) throw new SandboxError(403, 'independent_admin_required');
    if (this.now() >= Date.parse(job.expiresAt) || ['expired', 'deleted'].includes(job.status)) throw new SandboxError(410, 'job_expired');
    if (!exactKeys(body, ['decision', 'sha256', 'reason']) || !['approved', 'rejected'].includes(body.decision)
      || typeof body.reason !== 'string' || body.reason.trim().length < 3 || body.reason.length > 200 || /[\x00-\x1f]/.test(body.reason)) throw new SandboxError(400, 'invalid_decision');
    const artifact = job.artifacts.find(item => item.id === artifactId);
    if (!artifact) throw new SandboxError(404, 'artifact_not_found');
    if (artifact.sha256 !== body.sha256 || artifact.decision !== 'pending' || !artifact.scan.clean) throw new SandboxError(409, 'artifact_not_approvable');
    if (body.decision === 'approved') {
      if (artifact.previewedBy !== principal.userId || artifact.previewedSha256 !== artifact.sha256 || !artifact.previewedAt) throw new SandboxError(409, 'artifact_not_previewed');
      const current = readFileSync(join(this.stateDir, job.id, artifact.id));
      const scanned = scanArtifact(artifact.name, current.toString('base64'));
      if (!scanned.clean || scanned.sha256 !== artifact.sha256) throw new SandboxError(409, 'artifact_integrity_failed');
    }
    artifact.decision = body.decision; artifact.approvedBy = principal.userId;
    artifact.decidedAt = new Date(this.now()).toISOString(); artifact.reason = body.reason;
    this.changed(job);
    return this.view(job);
  }
  download(principal, id, artifactId) {
    const job = this.owned(principal, id);
    if (this.now() >= Date.parse(job.expiresAt) || ['expired', 'deleted'].includes(job.status)) throw new SandboxError(410, 'job_expired');
    const artifact = job.artifacts.find(item => item.id === artifactId);
    if (!artifact) throw new SandboxError(404, 'artifact_not_found');
    if (artifact.decision !== 'approved' || !artifact.scan.clean || !job.cleanupVerified) throw new SandboxError(403, 'artifact_not_approved');
    const buffer = readFileSync(join(this.stateDir, job.id, artifact.id));
    const checked = scanArtifact(artifact.name, buffer.toString('base64'));
    if (!checked.clean || checked.sha256 !== artifact.sha256) throw new SandboxError(409, 'artifact_integrity_failed');
    return { artifact: structuredClone(artifact), buffer };
  }
  preview(principal, id, artifactId) {
    const job = this.owned(principal, id);
    if (principal.role !== 'admin' || principal.userId === job.userId) throw new SandboxError(403, 'independent_admin_required');
    if (this.now() >= Date.parse(job.expiresAt) || ['expired', 'deleted'].includes(job.status)) throw new SandboxError(410, 'job_expired');
    const artifact = job.artifacts.find(item => item.id === artifactId);
    if (!artifact || !artifact.scan.clean || !job.cleanupVerified) throw new SandboxError(403, 'artifact_not_reviewable');
    const buffer = readFileSync(join(this.stateDir, job.id, artifact.id));
    const checked = scanArtifact(artifact.name, buffer.toString('base64'));
    if (!checked.clean || checked.sha256 !== artifact.sha256) throw new SandboxError(409, 'artifact_integrity_failed');
    artifact.previewedBy = principal.userId; artifact.previewedAt = new Date(this.now()).toISOString(); artifact.previewedSha256 = checked.sha256;
    this.changed(job);
    return { artifact: structuredClone(artifact), buffer };
  }
  async purge(principal, id, status = 'deleted') {
    const job = this.owned(principal, id);
    await this.cancel(principal, id);
    if (this.controllers.has(id)) {
      // API callers retry after status reaches a terminal value; never delete under a running producer.
      throw new SandboxError(409, 'job_cancellation_pending');
    }
    if (!job.cleanupVerified) {
      try { job.cleanupVerified = await this.runtime.remove(job.containerName); } catch { job.cleanupVerified = false; }
      if (!job.cleanupVerified) throw new SandboxError(409, 'cleanup_unverified');
    }
    rmSync(join(this.stateDir, job.id), { recursive: true, force: true });
    job.artifacts = []; job.status = status; delete job.diagnostics; this.changed(job);
    return this.view(job);
  }
  async expire() {
    for (const job of this.jobs.values()) {
      if (this.now() < Date.parse(job.expiresAt) || ['expired', 'deleted'].includes(job.status)) continue;
      try { await this.purge({ tenantId: job.tenantId, userId: job.userId, role: 'submit' }, job.id, 'expired'); } catch { /* retry next sweep */ }
    }
  }
  async maintain() {
    if (this.maintenanceRunning || this.closing) return;
    this.maintenanceRunning = true;
    try {
      for (const job of this.jobs.values()) {
        if (job.status !== 'unknown' || job.cleanupVerified) continue;
        try {
          if (await this.runtime.remove(job.containerName)) { job.cleanupVerified = true; this.changed(job); }
        } catch { /* capacity remains quarantined until positively reclaimed */ }
      }
      await this.expire();
    } finally { this.maintenanceRunning = false; }
    if (!this.closing && !this.hasUnreclaimed()) void this.pump();
  }
  async close() {
    this.closing = true; clearInterval(this.sweep);
    for (const job of this.jobs.values()) if (!terminal.has(job.status)) await this.cancel({ tenantId: job.tenantId, userId: job.userId, role: 'submit' }, job.id);
    // Docker create/inspect/cleanup are bounded; do not release the state lock until they finish.
    while (this.running || this.maintenanceRunning) await new Promise(resolve => setTimeout(resolve, 25));
    for (const job of this.jobs.values()) {
      if (job.status !== 'unknown' || job.cleanupVerified) continue;
      try { if (await this.runtime.remove(job.containerName)) { job.cleanupVerified = true; job.cleanupRecoveredAt = new Date(this.now()).toISOString(); this.changed(job); } }
      catch { /* durable unknown remains for the next start; never declare success */ }
    }
    this.sources.clear(); this.persist(); this.releaseLock();
    return { cleanupVerified: !this.hasUnreclaimed() };
  }
}
