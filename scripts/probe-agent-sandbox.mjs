import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { randomUUID } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { assessSandboxContainer, assessSandboxProbe, isMissingDockerContainer, sandboxCreateArgs } from './sandbox-contract.mjs';

const execute = promisify(execFile);
const [image, option, outputName] = process.argv.slice(2);
if (!image || image.startsWith('-') || !/^[\w./:@-]+$/.test(image)
  || (option !== undefined && option !== '--out')
  || (option === undefined && outputName !== undefined)
  || (option === '--out' && (!outputName || !/^[\w.-]+\.json$/.test(outputName) || outputName.startsWith('.')))
  || process.argv.length > 5) {
  throw new Error('Usage: npm run agent:sandbox:probe -- LOCAL_IMAGE [--out REPORT.json]');
}
const docker = async (args, timeout = 30000) => (await execute('docker', args, { timeout, maxBuffer: 65536 })).stdout.trim();
const report = { measuredAt: new Date().toISOString(), image, passed: false, productExecutionEnabled: false, productionSecurityAccepted: false, checks: [], failures: [] };
const output = resolve('test-results/agentscope', outputName || `sandbox-contract-probe-${randomUUID()}.json`);
report.reportFile = output;
const nonce = randomUUID();
const path = `/work/${nonce}`;
const source = previous => `
import json, os, socket, sys
from pathlib import Path
current = Path(${JSON.stringify(path)})
previous = Path(${JSON.stringify(previous || '/work/no-prior-run')})
def writable(target):
    try:
        target.write_text('probe')
        return True
    except OSError:
        return False
network_connected = False
try:
    connection = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
    connection.settimeout(0.3)
    connection.connect(('198.51.100.1', 9))
    network_connected = True
except OSError:
    pass
finally:
    connection.close()
visible = [key for key in os.environ if key.startswith(('MODEL_', 'MASTER_', 'OPENAI_', 'AWS_', 'AZURE_', 'GOOGLE_')) or any(token in key for token in ('SECRET', 'TOKEN', 'PASSWORD', 'CREDENTIAL', 'API_KEY'))]
previous_file_visible = previous.exists()
print(json.dumps({'appVisible': Path('/app').exists(), 'dataVisible': Path('/app/.data').exists(),
    'secretVisible': Path('/run/secrets').exists(), 'dockerSocketVisible': Path('/var/run/docker.sock').exists(),
    'rootWriteSucceeded': writable(Path('/tmp/aiops-sandbox-probe')),
    'shmWriteSucceeded': writable(Path('/dev/shm/aiops-sandbox-probe')),
    'workWriteSucceeded': writable(current), 'previousFileVisible': previous_file_visible,
    'networkConnected': network_connected, 'credentialEnvironmentVisible': bool(visible),
    'networkInterfaces': sorted(os.listdir('/sys/class/net')), 'cwd': os.getcwd()}))
`;

async function create(name, imageId, pythonSource) {
  await docker(sandboxCreateArgs(name, imageId, pythonSource));
  const container = JSON.parse(await docker(['inspect', '--format', '{{json .}}', name]));
  const imageInfo = JSON.parse(await docker(['image', 'inspect', '--format', '{{json .}}', imageId]));
  const failures = assessSandboxContainer(container, imageInfo);
  if (failures.length) throw new Error(`container configuration rejected: ${failures.join(', ')}`);
}

async function removeAndCheck(name) {
  await docker(['rm', '--force', name]).catch(() => {});
  try { await docker(['inspect', name]); return false; }
  catch (error) { return isMissingDockerContainer(error, name); }
}

async function runProbe(imageId, label, previous) {
  const name = `aiops-sandbox-probe-${randomUUID()}`;
  try {
    await create(name, imageId, source(previous));
    const stdout = await docker(['start', '--attach', name]);
    const state = JSON.parse(await docker(['inspect', '--format', '{{json .State}}', name]));
    if (state.ExitCode !== 0 || state.OOMKilled) throw new Error(`${label} exited ${state.ExitCode}`);
    const probe = JSON.parse(stdout);
    const failures = assessSandboxProbe(probe, previous);
    report.checks.push({ label, passed: failures.length === 0, probe, failures });
    report.failures.push(...failures.map(code => `${label}:${code}`));
  } finally {
    if (!await removeAndCheck(name)) {
      report.failures.push(`${label}:container-remains`);
      const check = report.checks.find(entry => entry.label === label);
      if (check) { check.passed = false; check.failures.push('container-remains'); }
    }
  }
}

async function runCancellation(imageId) {
  const name = `aiops-sandbox-probe-${randomUUID()}`;
  try {
    await create(name, imageId, 'import time; time.sleep(30)');
    await docker(['start', name]);
    let running = false;
    for (let attempt = 0; attempt < 5; attempt++) {
      const state = JSON.parse(await docker(['inspect', '--format', '{{json .State}}', name]));
      if (state.Running) { running = true; break; }
      await delay(50);
    }
    if (!running) throw new Error('cancellation probe did not reach running state');
    await delay(100);
    const removed = await removeAndCheck(name);
    report.checks.push({ label: 'forced-cancellation', startedRunning: true, passed: removed, failures: removed ? [] : ['container-remains-or-inspect-failed'] });
    if (!removed) report.failures.push('forced-cancellation:container-remains');
  } finally {
    if (!await removeAndCheck(name)) report.failures.push('forced-cancellation:cleanup-unverified');
  }
}

try {
  report.runtimeSecurityOptions = JSON.parse(await docker(['info', '--format', '{{json .SecurityOptions}}']));
  if (!report.runtimeSecurityOptions.some(option => option.startsWith('name=seccomp,'))) throw new Error('Docker default seccomp profile is unavailable');
  const imageInfo = JSON.parse(await docker(['image', 'inspect', '--format', '{{json .}}', image]));
  report.imageId = imageInfo.Id;
  await runProbe(imageInfo.Id, 'first-run', null);
  await runProbe(imageInfo.Id, 'second-run', path);
  await runCancellation(imageInfo.Id);
  report.passed = report.failures.length === 0 && report.checks.length === 3;
} catch (error) {
  report.failures.push(error.message);
} finally {
  mkdirSync(resolve('test-results/agentscope'), { recursive: true });
  writeFileSync(output, JSON.stringify(report, null, 2) + '\n', { flag: 'wx' });
  console.log(JSON.stringify(report, null, 2));
  if (!report.passed) process.exitCode = 2;
}
