import { spawn } from 'node:child_process';
import { existsSync, lstatSync, mkdirSync, openSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadConfig } from '../../integrations/dts-mcp/adapter.mjs';

const root = resolve(fileURLToPath(new URL('../..', import.meta.url)));
const directory = resolve(process.env.DTS_SERVICE_DIR || '/workspace/dts-mcp-service');
const envFile = join(directory, 'dts.env');
const pidFile = join(directory, 'service.pid');
const action = process.argv[2] || 'status';
if (process.platform !== 'linux' || process.getuid?.() !== 1000) throw Error('DTS sandbox service requires Linux UID 1000');
const [major, minor] = process.versions.node.split('.').map(Number);
if (major < 22 || major === 22 && minor < 16) throw Error('Node >=22.16 required');
mkdirSync(directory, { recursive: true, mode: 0o700 });
if (lstatSync(directory).isSymbolicLink()) throw Error('Service directory must not be a symlink');
function ownedPid() {
  if (!existsSync(pidFile)) return null;
  if (!lstatSync(pidFile).isFile() || lstatSync(pidFile).isSymbolicLink()) throw Error('Invalid PID file');
  const pid = Number(readFileSync(pidFile, 'utf8'));
  if (!Number.isSafeInteger(pid) || pid < 2) throw Error('Invalid service PID');
  if (!existsSync(`/proc/${pid}`)) { unlinkSync(pidFile); return null; }
  if (/^State:\s+Z/m.test(readFileSync(`/proc/${pid}/status`, 'utf8'))) { unlinkSync(pidFile); return null; }
  const argv = readFileSync(`/proc/${pid}/cmdline`, 'utf8').split('\0');
  const owner = readFileSync(`/proc/${pid}/status`, 'utf8').match(/^Uid:\s+(\d+)/m)?.[1];
  if (owner !== '1000' || argv[1] !== fileURLToPath(import.meta.url) || argv[2] !== 'supervise') throw Error('PID does not belong to this DTS supervisor; no signal sent');
  return pid;
}
function config() {
  const stat = lstatSync(envFile);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.mode & 0o077 || stat.size > 65536) throw Error('DTS config must be an ordinary private file (0600)');
  process.loadEnvFile(envFile);
  const value = loadConfig();
  if (value.businessDomain !== 'general' || value.areaName !== 'cn_east') throw Error('This sandbox deployment is restricted to general/cn_east');
  return value;
}
if (action === 'status') {
  const pid = ownedPid(); const cfg = config();
  let healthy = false;
  try { const r = await fetch(`http://127.0.0.1:${cfg.port}/health`, { signal: AbortSignal.timeout(1500) }); healthy = r.ok && (await r.json()).service === 'dts-readonly-mcp'; } catch {}
  console.log(JSON.stringify({ running: !!pid, pid, healthy, endpoint: `http://127.0.0.1:${cfg.port}/mcp`, scope: 'general/cn_east' }));
} else if (action === 'stop') {
  const pid = ownedPid(); if (pid) process.kill(pid, 'SIGTERM');
  console.log(JSON.stringify({ action: pid ? 'stop_requested' : 'already_stopped', pid }));
} else if (action === 'start') {
  config();
  const pid = ownedPid();
  if (pid) console.log(JSON.stringify({ action: 'already_running', pid }));
  else {
    const log = openSync(join(directory, 'service.log'), 'a', 0o600);
    const child = spawn(process.execPath, [fileURLToPath(import.meta.url), 'supervise'], { cwd: root, env: process.env, detached: true, stdio: ['ignore', log, log] });
    child.unref();
    console.log(JSON.stringify({ action: 'starting', pid: child.pid }));
  }
} else if (action === 'supervise') {
  config();
  // Exclusive creation prevents competing supervisors; stale PIDs are cleared by start.
  writeFileSync(pidFile, String(process.pid), { mode: 0o600, flag: 'wx' });
  let child, closing = false, timer;
  const launch = () => {
    child = spawn(process.execPath, ['--env-file=' + envFile, join(root, 'integrations/dts-mcp/index.mjs')], { cwd: root, stdio: ['ignore', 'inherit', 'inherit'] });
    child.on('error', () => console.error(JSON.stringify({ event: 'dts.child_start_failed' })));
    child.on('exit', (code, signal) => {
      if (closing) { if (existsSync(pidFile)) unlinkSync(pidFile); process.exit(0); }
      console.error(JSON.stringify({ event: 'dts.child_exited', code, signal }));
      timer = setTimeout(launch, 2000);
    });
  };
  const stop = () => {
    closing = true; clearTimeout(timer);
    if (child?.exitCode === null && child?.pid) {
      child.kill('SIGTERM'); setTimeout(() => child.kill('SIGKILL'), 12000).unref();
    } else { unlinkSync(pidFile); process.exit(0); }
  };
  process.once('SIGTERM', stop); process.once('SIGINT', stop);
  launch();
} else throw Error('Use start|status|stop|supervise');
