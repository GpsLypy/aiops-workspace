const imageIdPattern = /^sha256:[a-f0-9]{64}$/;
const containerNamePattern = /^aiops-sandbox-probe-[a-f0-9-]+$/;

export const sandboxLimits = Object.freeze({ memoryBytes: 134217728, workBytes: 16777216, pids: 32, cpus: 0.5 });

export function sandboxCreateArgs(name, imageId, source) {
  if (!containerNamePattern.test(name) || !imageIdPattern.test(imageId) || typeof source !== 'string' || !source) {
    throw new Error('Invalid sandbox probe identity or source');
  }
  return ['create', '--name', name, '--network', 'none', '--ipc', 'none', '--read-only', '--init',
    '--user', '65534:65534', '--workdir', '/work', '--entrypoint', 'python',
    '--cap-drop', 'ALL', '--security-opt', 'no-new-privileges:true',
    '--memory', String(sandboxLimits.memoryBytes), '--memory-swap', String(sandboxLimits.memoryBytes),
    '--cpus', String(sandboxLimits.cpus), '--pids-limit', String(sandboxLimits.pids),
    '--ulimit', 'nofile=64:64', '--ulimit', 'core=0:0',
    '--tmpfs', `/work:rw,nosuid,nodev,noexec,size=${sandboxLimits.workBytes},uid=65534,gid=65534`,
    '--label', 'aiops.sandbox-contract-probe=true', imageId, '-I', '-B', '-c', source];
}

export function assessSandboxContainer(container, image) {
  const host = container?.HostConfig || {};
  const config = container?.Config || {};
  const failures = [];
  const requireValue = (condition, code) => { if (!condition) failures.push(code); };
  requireValue(host.NetworkMode === 'none' && !Object.keys(host.PortBindings || {}).length, 'network');
  requireValue(host.ReadonlyRootfs === true, 'readonly-root');
  requireValue(host.Privileged === false, 'privileged');
  requireValue((host.CapDrop || []).some(value => value.toUpperCase() === 'ALL'), 'capabilities');
  requireValue((host.SecurityOpt || []).includes('no-new-privileges:true'), 'new-privileges');
  requireValue(config.User === '65534:65534', 'nonroot-user');
  requireValue(config.WorkingDir === '/work', 'workdir');
  requireValue(host.Memory === sandboxLimits.memoryBytes && host.MemorySwap === sandboxLimits.memoryBytes, 'memory');
  requireValue(host.NanoCpus === sandboxLimits.cpus * 1e9, 'cpu');
  requireValue(host.PidsLimit === sandboxLimits.pids, 'pids');
  const temporaryDisk = new Set((host.Tmpfs?.['/work'] || '').split(','));
  requireValue(['rw', 'nosuid', 'nodev', 'noexec', `size=${sandboxLimits.workBytes}`, 'uid=65534', 'gid=65534'].every(option => temporaryDisk.has(option)), 'temporary-disk');
  requireValue(!host.Binds?.length && !host.Mounts?.length && !(container.Mounts || []).some(mount => mount.Type !== 'tmpfs'), 'host-mount');
  requireValue(!host.Devices?.length && !host.DeviceRequests?.length && !host.PidMode, 'host-device-namespace');
  requireValue(host.IpcMode === 'none', 'ipc-namespace');
  requireValue(!Object.keys(image?.Config?.Volumes || {}).length, 'image-volume');
  requireValue(!(image?.Config?.Env || []).some(entry => /^(?:MODEL_|MASTER_|OPENAI_|AWS_|AZURE_|GOOGLE_|.*(?:SECRET|TOKEN|PASSWORD|CREDENTIAL|API_KEY))=/i.test(entry)), 'image-credential-environment');
  return failures;
}

export function assessSandboxProbe(probe, previousNonce) {
  const failures = [];
  for (const key of ['appVisible', 'dataVisible', 'secretVisible', 'dockerSocketVisible', 'rootWriteSucceeded', 'shmWriteSucceeded', 'networkConnected', 'credentialEnvironmentVisible']) {
    if (probe?.[key] !== false) failures.push(key);
  }
  if (probe?.workWriteSucceeded !== true) failures.push('workWriteSucceeded');
  if (probe?.cwd !== '/work') failures.push('cwd');
  if (!Array.isArray(probe?.networkInterfaces) || probe.networkInterfaces.some(name => /^(?:eth|veth|wlan|en\d)/.test(name))) failures.push('networkInterfaces');
  if (previousNonce && probe?.previousFileVisible !== false) failures.push('cross-run-residue');
  return failures;
}

export function isMissingDockerContainer(error, name) {
  const message = error?.stderr?.trim()?.toLowerCase();
  return error?.code === 1 && (message === `error: no such object: ${name}` || message === `error: no such container: ${name}`);
}
