import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { assessSandboxContainer, isMissingDockerContainer, sandboxCreateArgs } from '../../scripts/sandbox-contract.mjs';
import { guestSource } from './guest.mjs';
import { exactKeys, limits } from './policy.mjs';

const execute = promisify(execFile);
const namePattern = /^aiops-sandbox-job-[a-f0-9-]{36}$/;
export class DockerRuntime {
  constructor(image = 'python:3.12-slim-bookworm') {
    if (!/^[\w./:@-]+$/.test(image) || image.startsWith('-')) throw new Error('Invalid local sandbox image');
    this.image = image;
    // The CLI needs local Docker configuration, never application/model credentials.
    this.env = { PATH: process.env.PATH, HOME: process.env.HOME };
  }
  async docker(args, options = {}) {
    return (await execute('docker', args, { timeout: 30000, maxBuffer: 65536, env: this.env, ...options })).stdout.trim();
  }
  async initialize() {
    const options = JSON.parse(await this.docker(['info', '--format', '{{json .SecurityOptions}}']));
    if (!options.some(value => value.startsWith('name=seccomp,'))) throw new Error('Docker default seccomp unavailable');
    this.imageInfo = JSON.parse(await this.docker(['image', 'inspect', '--format', '{{json .}}', this.image]));
    this.imageId = this.imageInfo.Id;
    if (!/^sha256:[a-f0-9]{64}$/.test(this.imageId)) throw new Error('Image must resolve to immutable local ID');
    if ((this.imageInfo.Config.Env || []).some(entry => /^(?:MODEL_|MASTER_|OPENAI_|AWS_|AZURE_|GOOGLE_|.*(?:SECRET|TOKEN|PASSWORD|CREDENTIAL|API_KEY))=/i.test(entry))
      || Object.keys(this.imageInfo.Config.Volumes || {}).length) throw new Error('Unsafe sandbox image configuration');
    return { imageId: this.imageId, securityOptions: options };
  }
  async remove(name) {
    if (!namePattern.test(name)) throw new Error('Invalid sandbox container identity');
    // rm emits different not-found wording across Docker versions. Only the
    // subsequent exact inspect response can establish absence.
    try { await this.docker(['rm', '--force', name]); } catch { /* verify below */ }
    try { await this.docker(['inspect', name]); return false; }
    catch (error) { if (isMissingDockerContainer(error, name)) return true; throw error; }
  }
  async run({ containerName, source, signal }) {
    if (!this.imageId || !namePattern.test(containerName)) throw new Error('Sandbox runtime not initialized');
    let timer;
    let timedOut = false;
    const abort = new AbortController();
    const cancel = () => abort.abort();
    signal.addEventListener('abort', cancel, { once: true });
    let result;
    try {
      if (signal.aborted) throw Object.assign(new Error('cancelled'), { code: 'ABORT_ERR' });
      const args = sandboxCreateArgs(containerName.replace('sandbox-job-', 'sandbox-probe-'), this.imageId, guestSource(source));
      args[args.indexOf('--name') + 1] = containerName;
      args.splice(args.indexOf(this.imageId), 0, '--ulimit', 'cpu=2:2', '--label', 'aiops.sandbox-broker=true', '--log-driver', 'none');
      // The job's name and limits are persisted before create; recovery can remove it.
      await this.docker(args);
      const container = JSON.parse(await this.docker(['inspect', '--format', '{{json .}}', containerName]));
      const failures = assessSandboxContainer(container, this.imageInfo);
      if (failures.length) throw new Error(`Rejected container configuration: ${failures.join(',')}`);
      if (signal.aborted) throw Object.assign(new Error('cancelled'), { code: 'ABORT_ERR' });
      timer = setTimeout(() => { timedOut = true; abort.abort(); }, limits.wallMs);
      const stdout = await this.docker(['start', '--attach', containerName], { signal: abort.signal, maxBuffer: 1572864, timeout: limits.wallMs + 5000 });
      const state = JSON.parse(await this.docker(['inspect', '--format', '{{json .State}}', containerName]));
      if (state.ExitCode !== 0 || state.OOMKilled) throw new Error('Guest supervisor failed');
      const envelope = JSON.parse(stdout);
      if (!exactKeys(envelope, ['version', 'exitCode', 'stdout', 'stderr', 'artifacts', 'error']) || envelope.version !== 1
        || !Number.isSafeInteger(envelope.exitCode) || typeof envelope.stdout !== 'string' || typeof envelope.stderr !== 'string'
        || Buffer.byteLength(envelope.stdout) + Buffer.byteLength(envelope.stderr) > limits.stdoutBytes
        || !Array.isArray(envelope.artifacts) || envelope.artifacts.length > limits.artifacts
        || ![null, 'output_quota', 'artifact_quota', 'unsafe_artifact'].includes(envelope.error)) throw new Error('Invalid untrusted guest envelope');
      result = { status: envelope.exitCode === 0 && envelope.error === null ? 'completed' : 'failed',
        envelope, configurationChecked: true };
    } catch (error) {
      result = { status: timedOut ? 'timed_out' : signal.aborted ? 'cancelled' : 'failed',
        error: timedOut ? 'wall_timeout' : signal.aborted ? 'cancelled' : 'runtime_failed' };
    } finally {
      clearTimeout(timer);
      signal.removeEventListener('abort', cancel);
      try { result.cleanupVerified = await this.remove(containerName); }
      catch { result.cleanupVerified = false; }
      if (!result.cleanupVerified) { result.status = 'unknown'; result.error = 'cleanup_unverified'; }
    }
    return result;
  }
}
