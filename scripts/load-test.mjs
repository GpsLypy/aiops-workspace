import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import assert from 'node:assert/strict';
import { createApplication } from '../server/app.mjs';
import { listen, startFixtures } from '../tests/fixtures.mjs';

// Disposable protocol load drill, never connects to real suppliers or a user's data directory.
const dir = mkdtempSync(join(tmpdir(), 'aiops-load-')); const fixtures = await startFixtures();
process.env.RUNS_PER_MINUTE = '500'; process.env.DAILY_RUN_LIMIT = '500'; process.env.DAILY_TOKEN_LIMIT = '10000000';
const app = createApplication({ dataDir: dir, scheduler: false }); const http = await listen(app.app); let cookie = '';
async function request(path, body, method = 'POST') { const response = await fetch(http.url + '/api' + path, { method, headers: { Cookie: cookie, 'Content-Type': 'application/json' }, body: JSON.stringify(body) }); return { response, data: await response.json() }; }
try {
  const setup = await request('/auth/setup', { username: 'admin', password: 'load-test-password' }); cookie = setup.response.headers.get('set-cookie').split(';')[0];
  await request('/settings/model', { baseUrl: fixtures.url + '/v1', model: 'fixture' }, 'PUT');
  const warmupStarted = performance.now(); await app.engine.warmup(); const warmupMs = Math.round(performance.now() - warmupStarted);
  const durations = []; let maxActive = 0; let maxQueued = 0;
  const timer = setInterval(() => { const s = app.execution.stats(); maxActive = Math.max(maxActive, s.active); maxQueued = Math.max(maxQueued, s.queued); }, 5);
  try { await Promise.all(Array.from({ length: 30 }, async (_, i) => { const started = performance.now(); const r = await request('/chat', { text: `慢速回答 ${i}`, requestKey: `load-request-${i}` }); assert.equal(r.response.status, 200, JSON.stringify(r.data)); durations.push(performance.now() - started); })); }
  finally { clearInterval(timer); }
  assert.deepEqual(app.store.all('SELECT DISTINCT runtime FROM executions').map(row => row.runtime), ['agentscope']);
  durations.sort((a, b) => a - b);
  assert.ok(maxActive <= Number(process.env.MAX_USER_RUNS || 2)); assert.ok(maxQueued > 0);
  console.log(JSON.stringify({ scenario: '30 concurrent HTTP chats / local protocol fixtures', runtime: 'agentscope', mode: app.engine.health().mode, warmupMs, completed: durations.length, errors: 0, maxActive, maxQueued, p50Ms: Math.round(durations[14]), p95Ms: Math.round(durations[28]), worker: app.engine.health(), productionCapacityClaim: false }, null, 2));
} finally { await http.close(); await app.close(); await fixtures.close(); rmSync(dir, { recursive: true, force: true }); }
