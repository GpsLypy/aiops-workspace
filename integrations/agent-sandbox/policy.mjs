import { createHash, timingSafeEqual } from 'node:crypto';

export const limits = Object.freeze({ sourceBytes: 65536, wallMs: 10000, stdoutBytes: 65536,
  artifactBytes: 1048576, artifacts: 8, pendingJobs: 32, jobsPerTenant: 16, retentionMs: 900000 });
export const digest = value => createHash('sha256').update(value).digest('hex');
export class SandboxError extends Error {
  constructor(status, code) { super(code); this.status = status; this.code = code; }
}
const fail = code => { throw new SandboxError(400, code); };
export const identifier = value => typeof value === 'string' && /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,63}$/.test(value);
export function exactKeys(value, keys) {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    && Object.keys(value).length === keys.length && keys.every(key => Object.hasOwn(value, key));
}
export function validateRequest(value) {
  if (!exactKeys(value, ['version', 'jobId', 'runId', 'stepId', 'language', 'source'])
    || value.version !== 1 || value.language !== 'python3.12'
    || !['jobId', 'runId', 'stepId'].every(key => identifier(value[key]))
    || typeof value.source !== 'string' || !value.source.trim() || value.source.includes('\0')
    || Buffer.byteLength(value.source) > limits.sourceBytes) fail('invalid_request');
  const canonical = Object.fromEntries(['version', 'jobId', 'runId', 'stepId', 'language', 'source'].map(key => [key, value[key]]));
  return { ...canonical, requestDigest: digest(JSON.stringify(canonical)), sourceSha256: digest(value.source) };
}
export function validatePrincipals(principals) {
  if (!Array.isArray(principals) || !principals.length || principals.length > 64) throw new Error('Invalid sandbox principals');
  const tokens = new Set();
  for (const p of principals) {
    if (!exactKeys(p, ['token', 'tenantId', 'userId', 'role']) || !identifier(p.tenantId) || !identifier(p.userId)
      || !['submit', 'admin'].includes(p.role) || typeof p.token !== 'string'
      || !/^[a-zA-Z0-9_-]{32,128}$/.test(p.token) || tokens.has(p.token)) throw new Error('Invalid sandbox principal');
    tokens.add(p.token);
  }
  return principals.map(p => ({ ...p }));
}
export function authenticate(principals, authorization) {
  const token = typeof authorization === 'string' && /^Bearer [a-zA-Z0-9_-]{32,128}$/.test(authorization) ? authorization.slice(7) : '';
  const candidate = digest(token);
  const matched = principals.find(p => timingSafeEqual(Buffer.from(digest(p.token)), Buffer.from(candidate)));
  if (!matched) throw new SandboxError(401, 'unauthorized');
  return matched;
}

// Deliberately conservative text-only scanner, not a malware/secret-detection claim.
// Guest envelopes, filenames, bytes and reported exit codes are all untrusted.
export function scanArtifact(name, contentBase64) {
  const reasons = [];
  if (typeof name !== 'string' || !/^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,79}\.(?:txt|json|csv)$/.test(name)) reasons.push('file_type_or_name');
  if (typeof contentBase64 !== 'string' || contentBase64.length > Math.ceil(limits.artifactBytes / 3) * 4
    || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(contentBase64)) {
    return { clean: false, reasons: [...reasons, 'invalid_encoding'], bytes: null, sha256: null, buffer: null };
  }
  const buffer = Buffer.from(contentBase64, 'base64');
  if (buffer.length > limits.artifactBytes) reasons.push('file_size');
  let text;
  try { text = new TextDecoder('utf-8', { fatal: true }).decode(buffer); } catch { reasons.push('invalid_utf8'); }
  if (text !== undefined) {
    if (/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/.test(text)) reasons.push('binary_or_control');
    if (/<\s*(?:script|iframe|object|embed|svg|html)\b|javascript\s*:|\bon(?:load|error)\s*=/i.test(text)) reasons.push('active_content');
    if (/-----BEGIN (?:[A-Z ]*PRIVATE KEY|OPENSSH PRIVATE KEY)-----|\b(?:sk-[A-Za-z0-9]{16,}|AKIA[A-Z0-9]{16})\b/.test(text)) reasons.push('recognized_secret');
    if (name?.endsWith('.json')) { try { JSON.parse(text); } catch { reasons.push('invalid_json'); } }
    if (name?.endsWith('.csv') && text.split(/\r?\n/).some(row => row.split(',').some(cell => /^[\s"']*[=+@-]/.test(cell)))) reasons.push('spreadsheet_formula');
  }
  return { clean: !reasons.length, reasons, bytes: buffer.length, sha256: digest(buffer), buffer };
}
