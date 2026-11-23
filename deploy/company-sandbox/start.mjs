import express from 'express';
import { createServer } from 'node:http';
import { randomBytes } from 'node:crypto';
import { existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, realpathSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { execFileSync } from 'node:child_process';
import { validatePoCStore } from './validate-store.mjs';
import { readPoCDtsConfig, poCDtsDecrypt } from './dts-config.mjs';

// This entry point is exclusively a disposable integration PoC. It never loads
// .env or starts schedules/notifications. DTS requires a separate explicit private
// configuration and a loopback SSH tunnel; default mode still prohibits MCP.
// A real model requires
// an explicit private configuration file; fixture mode remains the default.
if (process.env.COMPANY_SANDBOX_POC !== 'true') throw new Error('COMPANY_SANDBOX_POC=true is required');
if (process.getuid?.() !== 1000) throw new Error('The company sandbox PoC must run as UID 1000');
if (process.env.NODE_ENV !== 'development') throw new Error('HTTP PoC requires NODE_ENV=development');
const [nodeMajor, nodeMinor] = process.versions.node.split('.').map(Number);
if (nodeMajor !== 22 || nodeMinor < 16) throw new Error('Node 22.16+ is required');
execFileSync(process.env.AGENTSCOPE_PYTHON || '/app/agent-worker/.venv/bin/python', ['-c', "import sys,importlib.metadata; assert sys.version_info[:2]==(3,12); assert importlib.metadata.version('agentscope')=='2.0.8'"], { timeout: 15000, stdio: 'ignore' });
const dataDir = resolve(process.env.DATA_DIR || '/workspace/aiops-data');
const dtsConfig = process.env.POC_DTS_CONFIG_FILE ? await readPoCDtsConfig(process.env.POC_DTS_CONFIG_FILE) : null;
if (dataDir !== '/workspace/aiops-data') throw new Error('PoC DATA_DIR must be /workspace/aiops-data');
mkdirSync(dataDir, { recursive: true, mode: 0o700 });
if (realpathSync(dataDir) !== dataDir) throw new Error('PoC data directory must not be a symbolic link');
const markerPath = join(dataDir, 'company-sandbox-poc.json');
const accessPath = join(dataDir, 'poc-access.json');
const marker = { schemaVersion: 1, kind: 'company-sandbox-isolated-poc', productionAccepted: false };
// Check every entry before reading markers, credentials, keys or the database.
for (const file of readdirSync(dataDir)) if (!lstatSync(join(dataDir, file)).isFile()) throw new Error('PoC data directory only accepts ordinary files');
if (!existsSync(markerPath)) {
  if (readdirSync(dataDir).length) throw new Error('PoC requires an empty new data directory; importing an existing store is prohibited');
  writeFileSync(markerPath, JSON.stringify(marker) + '\n', { mode: 0o600, flag: 'wx' });
} else if (JSON.stringify(JSON.parse(readFileSync(markerPath, 'utf8'))) !== JSON.stringify(marker)) {
  throw new Error('PoC data marker is invalid');
}
if (!existsSync(accessPath)) writeFileSync(accessPath, JSON.stringify({ username: 'poc-admin', password: randomBytes(24).toString('base64url'), setupToken: randomBytes(32).toString('base64url') }) + '\n', { mode: 0o600, flag: 'wx' });
const access = JSON.parse(readFileSync(accessPath, 'utf8'));
if (access.username !== 'poc-admin' || access.password?.length < 24 || access.setupToken?.length < 32) throw new Error('PoC access file is invalid');
if (existsSync(join(dataDir, 'aiops.sqlite'))) {
  const db = new DatabaseSync(join(dataDir, 'aiops.sqlite'), { readOnly: true });
  try {
    validatePoCStore(db, { dtsConfig, decrypt: dtsConfig ? poCDtsDecrypt(dataDir) : undefined });
  } finally { db.close(); }
}

const modelFile = process.env.POC_REAL_MODEL_CONFIG_FILE;
const pocMaxTokens = process.env.POC_MODEL_MAX_TOKENS || process.env.MODEL_MAX_TOKENS || '512';
if (!Number.isSafeInteger(Number(pocMaxTokens)) || Number(pocMaxTokens) < 1 || Number(pocMaxTokens) > 32768) throw new Error('PoC MODEL_MAX_TOKENS must be an integer from 1 to 32768');
const pocTemperature = process.env.POC_MODEL_TEMPERATURE;
if (pocTemperature !== undefined && pocTemperature !== 'none' && (!pocTemperature.trim() || !Number.isFinite(Number(pocTemperature)) || Number(pocTemperature) < 0 || Number(pocTemperature) > 2)) throw new Error('PoC model temperature must be 0..2 or none');
const realModel = !!modelFile;
if (process.argv.includes('--real-model') && !modelFile) throw new Error('--real-model requires POC_REAL_MODEL_CONFIG_FILE');
let realConfig;
if (modelFile) {
  const stat = lstatSync(modelFile);
  if (!stat.isFile() || stat.isSymbolicLink() || (stat.mode & 0o077) !== 0 || stat.size > 65536) throw new Error('PoC model config must be a private ordinary file (0600, <=64KiB)');
  try { realConfig = JSON.parse(readFileSync(modelFile, 'utf8')); } catch { throw new Error('PoC model config is not valid JSON'); }
  const allowedKeys = ['schemaVersion', 'baseUrl', 'apiType', 'model', 'apiKey'];
  if (Object.keys(realConfig).some(key => !allowedKeys.includes(key)) || realConfig.schemaVersion !== undefined && realConfig.schemaVersion !== 1 || !['responses'].includes(realConfig.apiType) || typeof realConfig.apiKey !== 'string' || typeof realConfig.model !== 'string' || !realConfig.model.trim()) throw new Error('PoC model config schema is invalid');
  let base; try { base = new URL(realConfig.baseUrl); } catch { throw new Error('PoC model base URL is invalid'); }
  if (!['http:', 'https:'].includes(base.protocol) || base.username || base.password || base.search || base.hash) throw new Error('PoC model base URL is invalid');
}

const fixtureText = '公司沙箱隔离 PoC：真实 AgentScope Worker 与流式传输已连通。本答复来自本机受控模型，不代表真实模型或 DTS 验收。';
let fixtureCalls = 0;
const fixture = createServer(async (req, res) => {
  if (req.method !== 'POST' || req.url !== '/v1/responses') { res.writeHead(404).end(); return; }
  let body = '';
  for await (const chunk of req) { body += chunk; if (body.length > 1_000_000) { res.writeHead(413).end(); return; } }
  let input; try { input = JSON.parse(body); } catch { res.writeHead(400).end(); return; }
  fixtureCalls++;
  const usage = { input_tokens: 16, output_tokens: 16, total_tokens: 32 };
  const result = { status: 'completed', output: [{ type: 'message', role: 'assistant', content: [{ type: 'output_text', text: fixtureText }] }], usage };
  if (input.stream !== true) { res.writeHead(400).end(); return; }
  res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache' });
  const frame = value => res.write(`data: ${JSON.stringify(value)}\n\n`);
  const split = 26;
  frame({ type: 'response.output_text.delta', delta: fixtureText.slice(0, split) });
  await new Promise(done => setTimeout(done, 120));
  if (res.destroyed) return;
  frame({ type: 'response.output_text.delta', delta: fixtureText.slice(split) });
  frame({ type: 'response.completed', response: result });
  res.end();
});
if (!realModel) await new Promise((done, reject) => { fixture.once('error', reject); fixture.listen(0, '127.0.0.1', done); });
const modelOrigin = realModel ? new URL(realConfig.baseUrl).origin : `http://127.0.0.1:${fixture.address().port}`;
for (const key of Object.keys(process.env)) if (/^(?:MODEL_|OTEL_|NOTIFICATION_|RUNBOOK_|ADMIN_|AUDIT_EXPORT|MASTER_KEY_FILE|IDENTITY_GATEWAY|TRUST_PROXY|AGENTSCOPE_AGENT_IDS)/.test(key)) delete process.env[key];
Object.assign(process.env, {
  DATA_DIR: dataDir, HOST: process.env.HOST || '0.0.0.0', PORT: process.env.PORT || '3001',
  COOKIE_SECURE: 'false', AUTH_MODE: 'local', SETUP_TOKEN: access.setupToken,
  MODEL_API_TYPE: realModel ? realConfig.apiType : 'responses', MODEL_BASE_URL: realModel ? realConfig.baseUrl : modelOrigin + '/v1', MODEL_NAME: realModel ? realConfig.model : 'company-sandbox-poc-fixture', MODEL_API_KEY: realModel ? realConfig.apiKey : '',
  MODEL_MAX_TOKENS: pocMaxTokens,
  ...(pocTemperature !== undefined ? { MODEL_TEMPERATURE: pocTemperature } : {}),
  OUTBOUND_ALLOWED_ORIGINS: [modelOrigin, ...(dtsConfig ? ['http://127.0.0.1:43130'] : [])].join(','),
  OUTBOUND_HTTP_ORIGINS: [modelOrigin, ...(dtsConfig ? ['http://127.0.0.1:43130'] : [])].join(','),
  OUTBOUND_PRIVATE_ORIGINS: [modelOrigin, ...(dtsConfig ? ['http://127.0.0.1:43130'] : [])].join(','),
  ENABLE_AUTO_REMEDIATION: 'false', AGENT_CONTEXT_MODE: 'recent', AGENT_RETRIEVAL_MODE: 'ranked', AGENT_EVIDENCE_REPORTS: 'false',
});
const { createApplication } = await import('../../server/app.mjs');
const application = createApplication({ dataDir, scheduler: false, modelSettings: { reasoningEffortOnly: true, timeoutSettingsEnabled: true } });
let dtsResourceId = null;
if (dtsConfig) {
  try {
    const { provisionDts } = await import('../../integrations/dts-mcp/provision.mjs');
    const { fileURLToPath } = await import('node:url');
    const root = fileURLToPath(new URL('../..', import.meta.url));
    const archive = join(root, 'integrations/dts-mcp/dts-status.zip');
    const result = await provisionDts(dtsConfig, { root, ownerName: 'poc-admin', dataDir, skillPackagePath: existsSync(archive) ? archive : undefined });
    dtsResourceId = result.resources.find(item => item.name === 'DTS cn_east MCP').id;
    validatePoCStore(application.store.db, { dtsConfig, decrypt: application.store.decrypt });
  } catch (error) { await application.close(); if (fixture.listening) fixture.close(); throw error; }
}
const gateway = express();
gateway.get('/poc/status', (req, res) => res.json({ ...marker, realModel, dtsEnabled: !!dtsConfig, dtsResourceId, schedulerStarted: false, notificationStarted: false, fixtureCalls, dataDir }));
gateway.use((req, res, next) => {
  const write = !['GET', 'HEAD', 'OPTIONS'].includes(req.method);
  const dtsRoute = dtsResourceId && [`/api/mcp/${dtsResourceId}/discover`, `/api/mcp/${dtsResourceId}/call`].includes(req.path);
  const blocked = req.path.startsWith('/hooks/') || req.path.startsWith('/api/mcp/') && !dtsRoute || req.path.startsWith('/api/local-services') ||
    write && (/^\/api\/(?:resources|knowledge\/[^/]+\/sync|tasks|notification|runbooks)/.test(req.path) || req.path.startsWith('/api/settings/model') && !(req.method === 'PUT' && req.path === '/api/settings/model'));
  if (blocked) return res.status(403).json({ error: dtsConfig ? '本沙箱仅开放已配置的 DTS 只读查询；资源写入、任务、通知和其他集成仍未开放。' : '公司沙箱隔离 PoC 未开放真实集成、任务与通知；本阶段仅验证受控模型和临时测试数据。' });
  next();
});
gateway.use(application.app);
let server, closing = false;
async function shutdown() {
  if (closing) return; closing = true;
  application.engine.stop(); application.execution.stop();
  setTimeout(() => process.exit(1), 10000).unref();
  await new Promise(done => server ? server.close(done) : done());
  await application.close();
  if (fixture.listening) await new Promise(done => fixture.close(done));
  process.exit(0);
}
process.once('SIGINT', shutdown); process.once('SIGTERM', shutdown);
try {
  await application.engine.warmup();
  server = gateway.listen(Number(process.env.PORT), process.env.HOST, () => console.log(JSON.stringify({ event: 'company-sandbox-poc.ready', port: Number(process.env.PORT), realModel, schedulerStarted: false, notificationStarted: false })));
  server.on('error', async () => { console.error('PoC API listener failed'); await application.close(); fixture.close(); process.exitCode = 1; });
} catch {
  console.error('PoC AgentScope startup failed'); await application.close(); fixture.close(); process.exitCode = 1;
}
