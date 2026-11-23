import { spawn } from 'node:child_process';
import { existsSync, lstatSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

// Foreground supervisor for a single SSH local-forward. The private key must be
// constrained server-side to the one MCP destination; it is not an admin key.
const configFile = resolve(process.argv[2] || '');
function privateFile(path) {
  const stat = lstatSync(path);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.mode & 0o077 || stat.size > 65536) throw Error('Private ordinary file required');
}
privateFile(configFile);
const config = JSON.parse(readFileSync(configFile, 'utf8'));
if (Object.keys(config).sort().join(',') !== 'host,keyFile,knownHostsFile,localPort' ||
    !/^10\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(config.host) || config.host.split('.').some(n => Number(n) > 255) ||
    ![43130, 43131].includes(config.localPort)) throw Error('Invalid DTS SSH tunnel configuration');
for (const path of [config.keyFile, config.knownHostsFile]) { if (!path.startsWith('/')) throw Error('Absolute private file paths required'); privateFile(path); }
const pidFile = join(dirname(configFile), 'tunnel.pid');
if (existsSync(pidFile)) {
  const pid = Number(readFileSync(pidFile, 'utf8'));
  if (!Number.isSafeInteger(pid) || pid < 2) throw Error('Invalid tunnel PID file');
  try { process.kill(pid, 0); throw Error('Tunnel PID is alive; inspect ownership before restarting'); }
  catch (error) { if (error.code !== 'ESRCH') throw error; }
  unlinkSync(pidFile);
}
writeFileSync(pidFile, String(process.pid), { mode: 0o600, flag: 'wx' });
let child, closing = false, timer;
function launch() {
  child = spawn('/usr/bin/ssh', ['-NT', '-i', config.keyFile, '-o', `UserKnownHostsFile=${config.knownHostsFile}`, '-o', 'StrictHostKeyChecking=yes',
    '-o', 'BatchMode=yes', '-o', 'ExitOnForwardFailure=yes', '-o', 'ServerAliveInterval=15', '-o', 'ServerAliveCountMax=3',
    '-L', `127.0.0.1:${config.localPort}:127.0.0.1:43129`, `sandbox@${config.host}`], { stdio: ['ignore', 'ignore', 'pipe'] });
  child.stderr.on('data', () => {}); // Avoid leaking host/key paths into application logs.
  child.on('error', () => console.error(JSON.stringify({ event: 'dts.tunnel_start_failed' })));
  child.on('exit', (code, signal) => {
    if (closing) { unlinkSync(pidFile); process.exit(0); }
    console.error(JSON.stringify({ event: 'dts.tunnel_exited', code, signal })); timer = setTimeout(launch, 3000);
  });
}
function stop() {
  closing = true; clearTimeout(timer);
  if (child?.exitCode === null && child?.pid) { child.kill('SIGTERM'); setTimeout(() => child.kill('SIGKILL'), 5000).unref(); }
  else { unlinkSync(pidFile); process.exit(0); }
}
process.once('SIGTERM', stop); process.once('SIGINT', stop);
console.log(JSON.stringify({ event: 'dts.tunnel_supervisor_started', pid: process.pid, localEndpoint: `http://127.0.0.1:${config.localPort}/mcp` }));
launch();
