import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { assessSandboxContainer, assessSandboxProbe, isMissingDockerContainer, sandboxCreateArgs } from '../scripts/sandbox-contract.mjs';

const imageId = `sha256:${'a'.repeat(64)}`;

test('sandbox probe creates only an isolated, bounded container request', () => {
  const args = sandboxCreateArgs('aiops-sandbox-probe-1234', imageId, 'print(1)');
  for (const option of ['--network', '--ipc', '--read-only', '--cap-drop', '--security-opt', '--memory', '--pids-limit', '--tmpfs', '--user', '--entrypoint']) {
    assert(args.includes(option), `${option} absent`);
  }
  assert.equal(args[args.indexOf('--ipc') + 1], 'none');
  assert.equal(args[args.length - 1], 'print(1)');
  assert.throws(() => sandboxCreateArgs('outside', imageId, 'print(1)'));
  assert.throws(() => sandboxCreateArgs('aiops-sandbox-probe-1234', 'latest', 'print(1)'));
});

test('sandbox contract rejects mounts, outbound access, credentials and missing resource limits', () => {
  const clean = { HostConfig: { NetworkMode: 'none', ReadonlyRootfs: true, Privileged: false,
    CapDrop: ['ALL'], SecurityOpt: ['no-new-privileges:true'], Memory: 134217728, MemorySwap: 134217728,
    NanoCpus: 500000000, PidsLimit: 32, Tmpfs: { '/work': 'rw,nosuid,nodev,noexec,size=16777216,uid=65534,gid=65534' },
    Binds: null, Mounts: [], Devices: [], DeviceRequests: null, PidMode: '', IpcMode: 'none' },
  Config: { User: '65534:65534', WorkingDir: '/work' }, Mounts: [] };
  const image = { Config: { Env: ['PATH=/usr/local/bin'], Volumes: null } };
  assert.deepEqual(assessSandboxContainer(clean, image), []);
  assert(assessSandboxContainer({ ...clean, HostConfig: { ...clean.HostConfig, NetworkMode: 'bridge', Binds: ['/private:/work'], Memory: 0 } }, image).includes('network'));
  assert(assessSandboxContainer({ ...clean, HostConfig: { ...clean.HostConfig, Binds: ['/private:/work'] } }, image).includes('host-mount'));
  assert(assessSandboxContainer({ ...clean, HostConfig: { ...clean.HostConfig, Tmpfs: { '/work': 'rw,size=16777216,uid=65534,gid=65534' } } }, image).includes('temporary-disk'));
  assert(assessSandboxContainer({ ...clean, HostConfig: { ...clean.HostConfig, IpcMode: 'private' } }, image).includes('ipc-namespace'));
  assert(assessSandboxContainer(clean, { Config: { Env: ['MODEL_API_KEY=should-never-appear'] } }).includes('image-credential-environment'));
});

test('sandbox probe fails closed on observable isolation leaks and cross-run residue', () => {
  const clean = { appVisible: false, dataVisible: false, secretVisible: false, dockerSocketVisible: false,
    rootWriteSucceeded: false, shmWriteSucceeded: false, workWriteSucceeded: true, previousFileVisible: false, networkConnected: false,
    credentialEnvironmentVisible: false, networkInterfaces: ['lo'], cwd: '/work' };
  assert.deepEqual(assessSandboxProbe(clean, '/work/previous'), []);
  assert(assessSandboxProbe({ ...clean, appVisible: true, networkConnected: true, previousFileVisible: true }, '/work/previous').includes('cross-run-residue'));
  assert(assessSandboxProbe({ ...clean, shmWriteSucceeded: true }, null).includes('shmWriteSucceeded'));
  assert(assessSandboxProbe({ ...clean, networkInterfaces: ['eth0', 'lo'] }, null).includes('networkInterfaces'));
  assert(assessSandboxProbe({}, null).length > 0);
});

test('sandbox probe rejects report paths outside its result directory before starting Docker', () => {
  const result = spawnSync(process.execPath, ['scripts/probe-agent-sandbox.mjs', 'python:3.12-slim-bookworm', '--out', '../escape.json'], { encoding: 'utf8' });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /Usage: npm run agent:sandbox:probe/);
});

test('container absence requires an exact Docker not-found response', () => {
  const name = 'aiops-sandbox-probe-1234';
  assert.equal(isMissingDockerContainer({ code: 1, stderr: `error: no such object: ${name}\n` }, name), true);
  assert.equal(isMissingDockerContainer({ code: 1, stderr: `error: no such container: ${name}\n` }, name), true);
  assert.equal(isMissingDockerContainer({ code: 1, stderr: 'Cannot connect to the Docker daemon' }, name), false);
  assert.equal(isMissingDockerContainer({ code: 1, stderr: `error: no such object: ${name}-other` }, name), false);
});
