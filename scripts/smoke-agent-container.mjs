import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { randomBytes, randomUUID } from 'node:crypto';
import { mkdtempSync, writeFileSync, rmSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';

const execute = promisify(execFile);
const docker = async args => (await execute('docker', args, { timeout: 60000, maxBuffer: 2_000_000 })).stdout.trim();
const image = process.argv[2] || 'aiops:agentscope-candidate';
const enhancements = process.argv.includes('--enhancements');
const rollout = process.argv.includes('--rollout');
const name = `aiops-as-smoke-${randomUUID()}`;
const directory = mkdtempSync(join(tmpdir(), 'aiops-container-smoke-'));
const key = join(directory, 'master-key');
// Disposable test key only. Never load .env or mount a real application store.
writeFileSync(key, randomBytes(32), { mode: 0o444 });
const limits = ['--network', 'none', '--read-only', '--tmpfs', '/tmp', '--memory', '1g', '--cpus', '2', '--pids-limit', '128', '--cap-drop', 'ALL', '--security-opt', 'no-new-privileges:true'];
const started = performance.now();
try {
  const imageInfo = JSON.parse(await docker(['image', 'inspect', '--format', '{{json .}}', image]));
  const probe = JSON.parse(await docker(['run', '--rm', '--name', `${name}-probe`, ...limits, imageInfo.Id, 'node', 'scripts/check-agent-worker.mjs']));
  assert.equal(probe.ready, true);
  assert.equal(probe.mode, 'prefork');
  await docker(['run', '-d', '--name', name, ...limits,
    '--tmpfs', '/app/.data:uid=1000,gid=1000,mode=0700',
    '--mount', `type=bind,source=${key},target=/run/secrets/master-key,readonly`,
    '-e', 'MASTER_KEY_FILE=/run/secrets/master-key', '-e', 'APP_ORIGIN=https://fixture.invalid',
    '-e', 'COOKIE_SECURE=true', '-e', 'AUTH_MODE=local', '-e', 'OUTBOUND_ALLOWED_ORIGINS=https://fixture.invalid',
    '-e', 'METRICS_TOKEN=disposable-container-probe',
    ...(rollout ? ['-e', 'SETUP_TOKEN=disposable-container-setup-token-only'] : []),
    ...(enhancements ? ['-e', 'AGENT_CONTEXT_MODE=budgeted', '-e', 'AGENT_RETRIEVAL_MODE=diverse', '-e', 'AGENT_EVIDENCE_REPORTS=true'] : []), imageInfo.Id]);
  const healthScript = `
    const r = await fetch('http://127.0.0.1:3001/readyz');
    if (!r.ok || !(await r.json()).ready) process.exit(1);
    const m = await fetch('http://127.0.0.1:3001/metrics', {headers:{Authorization:'Bearer disposable-container-probe'}});
    if (!m.ok) process.exit(1);
    const metrics = await m.text();
    console.log(JSON.stringify({ready:true, metrics:metrics.split('\\n').filter(line=>line.startsWith('aiops_agent_'))}));
  `;
  let health;
  for (let attempt = 0; attempt < 40; attempt++) {
    try { health = JSON.parse(await docker(['exec', name, 'node', '--input-type=module', '-e', healthScript])); break; }
    catch (error) { if (attempt === 39) throw error; await delay(250); }
  }
  assert(health.metrics.some(line => /runtime_ready.* 1$/.test(line)), 'Missing runtime readiness metric');
  if (enhancements) {
    const config = JSON.parse(await docker(['exec', name, 'node', '--input-type=module', '-e', "import {runtimeOptions} from './server/agent-runtime/index.mjs'; const c=runtimeOptions(); console.log(JSON.stringify({contextMode:c.contextMode,retrievalMode:c.retrievalMode,evidenceReports:c.evidenceReports}));"]));
    assert.deepEqual(config, { contextMode: 'budgeted', retrievalMode: 'diverse', evidenceReports: true });
  }
  let rolloutResult;
  if (rollout) {
    rolloutResult = JSON.parse(await docker(['exec', name, 'node', '--input-type=module', '-e', `
      import assert from 'node:assert/strict';
      let cookie = '';
      const request = async (path, body, method = body ? 'POST' : 'GET') => {
        const res = await fetch('http://127.0.0.1:3001' + path, { method, headers: { 'Content-Type': 'application/json', Cookie: cookie }, ...(body ? { body: JSON.stringify(body) } : {}) });
        if (res.headers.get('set-cookie')) cookie = res.headers.get('set-cookie').split(';')[0];
        const data = await res.json(); assert.ok(res.ok, JSON.stringify(data)); return data;
      };
      await request('/api/auth/setup', { username: 'container-admin', password: 'disposable-container-password', setupToken: 'disposable-container-setup-token-only' });
      const path = '/api/settings/agent-rollout';
      let state = await request(path);
      state = await request(path, { revision: state.revision, draft: { agentIds: [], includeGeneral: true, contextMode: 'budgeted', retrievalMode: 'diverse', evidenceReports: true } }, 'PUT');
      state = await request(path + '/preflight', { revision: state.revision }); assert.equal(state.preflightValid, true);
      state = await request(path + '/activate', { revision: state.revision }); assert.equal(state.mode, 'active');
      state = await request(path + '/pause', { revision: state.revision }); assert.equal(state.mode, 'paused');
      assert.equal((await request('/readyz')).ready, true);
      const final = await request(path); assert.equal(final.health.mode, 'prefork'); assert.equal(final.health.ready, true);
      console.log(JSON.stringify({ preflight: true, activated: true, paused: true, runtimeAfterPause: 'agentscope', workerModeAfterPause: final.health.mode, readyAfterPause: true, revision: final.revision }));
    `]));
  }
  const shutdownStart = performance.now();
  await docker(['stop', '--time', '15', name]);
  const state = JSON.parse(await docker(['inspect', '--format', '{{json .State}}', name]));
  assert.equal(state.ExitCode, 0);
  assert.equal(state.OOMKilled, false);
  const report = { measuredAt: new Date().toISOString(), image, imageId: imageInfo.Id, architecture: imageInfo.Architecture,
    sizeBytes: imageInfo.Size, probe, health, enhancements, rollout: rolloutResult, network: 'none', readOnly: true, memoryLimitBytes: 1073741824, pidsLimit: 128,
    shutdownMs: Math.round(performance.now() - shutdownStart), exitCode: state.ExitCode, elapsedMs: Math.round(performance.now() - started), productionDataUsed: false };
  const output = resolve('test-results/agentscope'); mkdirSync(output, { recursive: true });
  writeFileSync(join(output, 'container-smoke.json'), JSON.stringify(report, null, 2) + '\n');
  console.log(JSON.stringify(report, null, 2));
} finally {
  await Promise.allSettled([name, `${name}-probe`].map(container => docker(['rm', '-f', container])));
  rmSync(directory, { recursive: true, force: true });
}
