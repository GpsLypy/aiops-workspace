import { createServer } from 'node:http';
import { chmodSync, existsSync, lstatSync, readFileSync, rmSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { SandboxBroker } from './broker.mjs';
import { DockerRuntime } from './docker-runtime.mjs';
import { authenticate, limits, SandboxError, validatePrincipals } from './policy.mjs';

async function body(req) {
  const parts = []; let bytes = 0;
  for await (const part of req) { bytes += part.length; if (bytes > limits.sourceBytes * 6 + 1024) throw new SandboxError(413, 'request_too_large'); parts.push(part); }
  try { return JSON.parse(Buffer.concat(parts).toString('utf8')); } catch { throw new SandboxError(400, 'invalid_json'); }
}
export function createSandboxServer(broker, principals) {
  const validated = validatePrincipals(principals);
  return createServer(async (req, res) => {
    res.setHeader('Cache-Control', 'no-store'); res.setHeader('X-Content-Type-Options', 'nosniff');
    try {
      // This service is socket-only and never a browser endpoint.
      if (req.headers.origin !== undefined) throw new SandboxError(403, 'browser_origin_denied');
      const principal = authenticate(validated, req.headers.authorization);
      if (req.url === '/v1/health' && req.method === 'GET') {
        res.setHeader('Content-Type', 'application/json'); res.end(JSON.stringify({ ok: !broker.closing && !broker.hasUnreclaimed(),
          imageId: broker.runtimeInfo.imageId, cleanupQuarantine: broker.hasUnreclaimed(), productionSecurityAccepted: false })); return;
      }
      const stepRoute = /^\/v1\/jobs\/by-step\/([a-zA-Z0-9][a-zA-Z0-9_-]{0,63})\/([a-zA-Z0-9][a-zA-Z0-9_-]{0,63})$/.exec(req.url || '');
      if (stepRoute && req.method === 'GET') {
        res.setHeader('Content-Type', 'application/json'); res.end(JSON.stringify(broker.findByStep(principal, stepRoute[1], stepRoute[2]))); return;
      }
      const route = /^\/v1\/jobs(?:\/([a-f0-9-]{36}))?(?:\/(cancel|artifacts\/([a-f0-9-]{36})(?:\/(decision|download|preview))?))?$/.exec(req.url || '');
      if (!route) throw new SandboxError(404, 'route_not_found');
      const [, id, action, artifactId, artifactAction] = route;
      let result;
      if (!id && req.method === 'POST') result = broker.submit(principal, await body(req));
      else if (id && !action && req.method === 'GET') result = broker.get(principal, id);
      else if (id && !action && req.method === 'DELETE') result = await broker.purge(principal, id);
      else if (id && action === 'cancel' && req.method === 'POST') result = await broker.cancel(principal, id);
      else if (artifactAction === 'decision' && req.method === 'POST') result = broker.decide(principal, id, artifactId, await body(req));
      else if (artifactAction === 'preview' && req.method === 'GET') {
        const { buffer } = broker.preview(principal, id, artifactId);
        res.setHeader('Content-Type', 'text/plain; charset=utf-8'); res.setHeader('Content-Security-Policy', "default-src 'none'; sandbox");
        res.end(buffer); return;
      }
      else if (artifactAction === 'download' && req.method === 'GET') {
        const { artifact, buffer } = broker.download(principal, id, artifactId);
        res.setHeader('Content-Type', 'application/octet-stream');
        res.setHeader('Content-Disposition', `attachment; filename="${artifact.name}"`);
        res.setHeader('Content-Length', buffer.length); res.end(buffer); return;
      } else throw new SandboxError(405, 'method_not_allowed');
      res.setHeader('Content-Type', 'application/json'); res.end(JSON.stringify(result));
    } catch (error) {
      if (!res.headersSent) { res.statusCode = error instanceof SandboxError ? error.status : 500; res.setHeader('Content-Type', 'application/json'); }
      res.end(JSON.stringify({ error: error instanceof SandboxError ? error.code : 'broker_internal_error' }));
    }
  });
}

export async function startSandboxService(config, runtime = new DockerRuntime(config.image)) {
  if (!config.socketPath || !config.stateDir || !resolve(config.socketPath).startsWith(resolve(config.stateDir) + '/')) throw new Error('Socket must be in private broker state directory');
  const socket = resolve(config.socketPath);
  const principals = validatePrincipals(config.principals);
  const broker = new SandboxBroker({ stateDir: config.stateDir, runtime });
  await broker.initialize();
  const server = createSandboxServer(broker, principals);
  server.requestTimeout = 15000; server.headersTimeout = 10000; server.maxRequestsPerSocket = 32;
  try {
    if (existsSync(socket)) { if (!lstatSync(socket).isSocket()) throw new Error('Socket path is occupied by a file'); rmSync(socket); }
    await new Promise((resolveStart, reject) => { server.once('error', reject); server.listen(socket, resolveStart); });
    chmodSync(socket, 0o600);
  } catch (error) { await broker.close(); throw error; }
  return { broker, server, socketPath: socket, close: async () => {
    const stopped = new Promise(resolveStop => server.close(resolveStop));
    server.closeAllConnections(); const cleanup = await broker.close(); await stopped;
    rmSync(socket, { force: true });
    return cleanup;
  } };
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const [configPath, ...extra] = process.argv.slice(2);
  if (!configPath || extra.length) throw new Error('Usage: node integrations/agent-sandbox/service.mjs PRIVATE_CONFIG.json');
  const file = lstatSync(configPath);
  if (!file.isFile() || file.isSymbolicLink() || (file.mode & 0o077)) throw new Error('Config must be a private regular file (0600)');
  const polluted = Object.keys(process.env).some(key => /^(?:MODEL_|MASTER_|OPENAI_|AWS_|AZURE_|GOOGLE_)|SECRET|TOKEN|PASSWORD|CREDENTIAL|API_KEY/i.test(key));
  if (polluted) throw new Error('Run sandbox broker without application/model credential environment');
  const service = await startSandboxService(JSON.parse(readFileSync(configPath, 'utf8')));
  console.log(JSON.stringify({ event: 'sandbox.started', socketPath: service.socketPath, imageId: service.broker.runtimeInfo.imageId,
    productionSecurityAccepted: false }));
  let closing = false;
  for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, async () => {
    if (closing) return; closing = true; const cleanup = await service.close();
    console.log(JSON.stringify({ event: 'sandbox.stopped', ...cleanup }));
    if (!cleanup.cleanupVerified) process.exitCode = 1;
  });
}
