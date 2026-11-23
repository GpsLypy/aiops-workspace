// Local filesystem administrator utility. Never prints tokens or model settings.
import { readFileSync, writeFileSync, mkdirSync, existsSync, chmodSync } from 'node:fs';
import { resolve, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { homedir } from 'node:os';
import { randomBytes } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { parseEnv } from 'node:util';
import { loadConfig } from '../integrations/dts-mcp/adapter.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const configPath = join(root, '.env.dts-mcp');
const label = 'com.aiops.dts-readonly-mcp';
const target = `gui/${process.getuid()}/${label}`;
const plist = join(homedir(), 'Library/LaunchAgents', `${label}.plist`);
const logDir = join(root, 'test-results/dts-local-service');
const action = process.argv[2];
const option = name => { const i = process.argv.indexOf(`--${name}`); return i < 0 ? undefined : process.argv[i + 1]; };
const xml = value => String(value).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&apos;' }[c]));
const run = args => spawnSync('/bin/launchctl', args, { encoding: 'utf8' });
function configuration() {
  if (!existsSync(configPath)) throw new Error('请先运行 install 配置本机 DTS 服务');
  return loadConfig(parseEnv(readFileSync(configPath, 'utf8')));
}
async function readHealth(config) {
  try {
    const response = await fetch(`http://127.0.0.1:${config.port}/health`, { signal: AbortSignal.timeout(1000) });
    const health = await response.json();
    return response.ok && health.service === 'dts-readonly-mcp' && health.ok === true ? health : { ok: false };
  } catch { return { ok: false }; }
}
async function waitForHealth(config) {
  const deadline = Date.now() + 6000;
  while (Date.now() < deadline) {
    if ((await readHealth(config)).ok) return;
    await new Promise(resolve => setTimeout(resolve, 150));
  }
  throw new Error('DTS 本机服务尚未就绪，请检查 test-results/dts-local-service/stderr.log');
}


try {
  if (action === 'install') {
    if (process.platform !== 'darwin') throw new Error('本机守护服务安装仅支持 macOS；其他系统使用 npm run dts:mcp');
    if (!existsSync(configPath)) {
      const endpoint = option('url'); const jobs = option('jobs') || ''; const jobScope = option('job-scope') || 'allowlist';
      if (!endpoint || /[\r\n]/.test(endpoint + jobs)) throw new Error('首次 install 必须提供 --url，allowlist 模式还需 --jobs');
      const env = { DTS_STATUS_URL: endpoint, DTS_JOB_SCOPE: jobScope, DTS_ALLOWED_JOB_IDS: jobs, DTS_MCP_TOKEN: randomBytes(32).toString('base64url'), DTS_ALLOW_HTTP: process.argv.includes('--allow-http') ? 'true' : 'false', DTS_BUSINESS_DOMAIN: 'general', DTS_AREA_NAME: 'cn_east' };
      loadConfig(env);
      writeFileSync(configPath, Object.entries(env).map(([k, v]) => `${k}=${JSON.stringify(v)}`).join('\n') + '\n', { mode: 0o600, flag: 'wx' });
    }
    const config = configuration(); chmodSync(configPath, 0o600);
    mkdirSync(dirname(plist), { recursive: true }); mkdirSync(logDir, { recursive: true, mode: 0o700 });
    if (run(['print', target]).status === 0) { console.log(JSON.stringify({ action: 'already_running', endpoint: `http://127.0.0.1:${config.port}/mcp` })); }
    else {
      const argv = [process.execPath, `--env-file=${configPath}`, join(root, 'integrations/dts-mcp/index.mjs')];
      writeFileSync(plist, `<?xml version="1.0" encoding="UTF-8"?><!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd"><plist version="1.0"><dict><key>Label</key><string>${label}</string><key>ProgramArguments</key><array>${argv.map(a => `<string>${xml(a)}</string>`).join('')}</array><key>WorkingDirectory</key><string>${xml(root)}</string><key>RunAtLoad</key><true/><key>KeepAlive</key><true/><key>ThrottleInterval</key><integer>5</integer><key>StandardOutPath</key><string>${xml(join(logDir, 'stdout.log'))}</string><key>StandardErrorPath</key><string>${xml(join(logDir, 'stderr.log'))}</string></dict></plist>`, { mode: 0o600 });
      const result = run(['bootstrap', `gui/${process.getuid()}`, plist]); if (result.status) throw new Error('launchd 安装失败，请用 launchctl 检查服务');
      await waitForHealth(config);
      console.log(JSON.stringify({ action: 'installed', endpoint: `http://127.0.0.1:${config.port}/mcp`, plist, logDir }));
    }
  } else if (action === 'status') {
    const config = configuration(); const result = run(['print', target]);
    const health = await readHealth(config);
    console.log(JSON.stringify({ loaded: result.status === 0, health, configuredScope: { jobScope: config.jobScope, businessDomain: config.businessDomain, areaName: config.areaName, allowedJobIds: config.allowedJobIds }, process: result.stdout?.split('\n').filter(line => /^\s*(state|pid|last exit code) =/.test(line)).map(s => s.trim()) }));
    if (result.status || !health.ok) process.exitCode = 1;
  } else if (action === 'restart') {
    const result = run(['kickstart', '-k', target]); if (result.status) throw new Error('服务重启失败');
    await waitForHealth(configuration()); console.log('DTS 本机服务已重启并就绪');
  } else if (action === 'stop') {
    const result = run(['bootout', target]); if (result.status) throw new Error('服务停止失败或尚未加载'); console.log('DTS 本机服务已停止，配置已保留');
  } else if (action === 'provision') {
    const { provisionDts } = await import('../integrations/dts-mcp/provision.mjs');
    console.log(JSON.stringify(await provisionDts(configuration(), { root, ownerName: option('owner'), dataDir: resolve(root, option('data-dir') || '.data') })));
  } else if (action === 'sync-policy') {
    const { syncDtsPolicy } = await import('../integrations/dts-mcp/provision.mjs');
    console.log(JSON.stringify(await syncDtsPolicy(configuration(), { ownerName: option('owner'), dataDir: resolve(root, option('data-dir') || '.data') })));
  }
  else throw new Error('用法：dts-local.mjs install --url URL (--jobs ID[,ID] | --job-scope region) [--allow-http] | status | restart | stop | provision --owner USERNAME | sync-policy --owner USERNAME');
} catch (error) { console.error(error.message); process.exitCode = 1; }
