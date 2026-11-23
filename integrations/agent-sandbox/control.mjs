import { randomUUID } from 'node:crypto';
import { lstatSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { brokerRequest } from './client.mjs';
import { limits, validatePrincipals } from './policy.mjs';

export async function sandboxControl(config, action, args) {
  const admin = ['preview', 'approve', 'reject'].includes(action);
  const principal = validatePrincipals(config.principals).find(value => value.role === (admin ? 'admin' : 'submit'));
  if (!principal) throw new Error('Missing required principal in private configuration');
  const client = { socketPath: config.socketPath, token: principal.token };
  const uuid = value => /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(value || '');
  if (action === 'health' && args.length === 0) return brokerRequest(client, 'GET', '/v1/health');
  if (action === 'submit' && [3, 4].includes(args.length)) {
    const [file, runId, stepId, jobId = randomUUID()] = args;
    const info = lstatSync(file);
    if (!file.endsWith('.py') || !info.isFile() || info.isSymbolicLink() || info.size > limits.sourceBytes) throw new Error('Source must be a regular Python file within quota');
    const source = new TextDecoder('utf-8', { fatal: true }).decode(readFileSync(file));
    return brokerRequest(client, 'POST', '/v1/jobs', { version: 1, jobId, runId, stepId, language: 'python3.12', source });
  }
  const [jobId, artifactId] = args;
  if (action === 'status' && args.length === 1 && uuid(jobId)) return brokerRequest(client, 'GET', `/v1/jobs/${jobId}`);
  if (action === 'cancel' && args.length === 1 && uuid(jobId)) return brokerRequest(client, 'POST', `/v1/jobs/${jobId}/cancel`);
  if (action === 'delete' && args.length === 1 && uuid(jobId)) return brokerRequest(client, 'DELETE', `/v1/jobs/${jobId}`);
  if (action === 'preview' && args.length === 2 && uuid(jobId) && uuid(artifactId)) return brokerRequest(client, 'GET', `/v1/jobs/${jobId}/artifacts/${artifactId}/preview`);
  if (['approve', 'reject'].includes(action) && args.length === 4 && uuid(jobId) && uuid(artifactId) && /^[a-f0-9]{64}$/.test(args[2])) {
    return brokerRequest(client, 'POST', `/v1/jobs/${jobId}/artifacts/${artifactId}/decision`, { decision: action === 'approve' ? 'approved' : 'rejected', sha256: args[2], reason: args[3] });
  }
  if (action === 'download' && args.length === 3 && uuid(jobId) && uuid(artifactId)) {
    const buffer = await brokerRequest(client, 'GET', `/v1/jobs/${jobId}/artifacts/${artifactId}/download`);
    writeFileSync(args[2], buffer, { flag: 'wx', mode: 0o600 }); return { downloaded: true, bytes: buffer.length, output: resolve(args[2]) };
  }
  throw new Error('Usage: PRIVATE_CONFIG health | submit FILE.py RUN_ID STEP_ID [JOB_ID] | status/cancel/delete JOB_UUID | preview JOB_UUID ARTIFACT_UUID | approve/reject JOB_UUID ARTIFACT_UUID SHA256 REASON | download JOB_UUID ARTIFACT_UUID NEW_FILE');
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const [path, action, ...args] = process.argv.slice(2);
  const info = path && lstatSync(path);
  if (!info?.isFile() || info.isSymbolicLink() || (info.mode & 0o077)) throw new Error('Config must be private regular file (0600)');
  const result = await sandboxControl(JSON.parse(readFileSync(path, 'utf8')), action, args);
  if (Buffer.isBuffer(result)) process.stdout.write(result);
  else console.log(JSON.stringify(result, null, 2));
}
