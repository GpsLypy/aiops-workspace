import { createHmac, timingSafeEqual } from 'node:crypto';
import { lookup } from 'node:dns/promises';
import { isIP } from 'node:net';
import http from 'node:http';
import https from 'node:https';
import { Readable } from 'node:stream';

export const production = () => process.env.NODE_ENV === 'production';
export function fail(status, message) { return Object.assign(new Error(message), { status }); }
export function positive(name, fallback) {
  const value = Number(process.env[name] ?? fallback);
  if (!Number.isSafeInteger(value) || value < 1) throw new Error(`${name} must be a positive integer`);
  return value;
}
export function validateEnvironment() {
  for (const [key, value] of Object.entries({ MAX_ACTIVE_RUNS: 8, MAX_USER_RUNS: 2, MAX_MCP_CALLS: 4, MAX_PENDING_RUNS: 100, QUEUE_TIMEOUT_MS: 30000, RUN_TIMEOUT_MS: 420000, RUNS_PER_MINUTE: 20, DAILY_RUN_LIMIT: 200, RUN_TOKEN_LIMIT: 100000, DAILY_TOKEN_LIMIT: 1000000, WORKSPACE_DAILY_TOKEN_LIMIT: 10000000, MODEL_CONTEXT_TOKENS: 32768, MODEL_MAX_TOKENS: 4096, APPROVAL_TTL_MS: 900000, REMOTE_RESPONSE_LIMIT: 2000000, MIN_FREE_DISK_BYTES: 104857600 })) positive(key, value);
  if (!production()) return;
  if (!process.env.APP_ORIGIN?.startsWith('https://') || process.env.COOKIE_SECURE !== 'true') throw new Error('Production requires HTTPS APP_ORIGIN and COOKIE_SECURE=true');
  if (!process.env.MASTER_KEY_FILE) throw new Error('Production requires an externally mounted MASTER_KEY_FILE');
  if (!process.env.OUTBOUND_ALLOWED_ORIGINS) throw new Error('Production requires OUTBOUND_ALLOWED_ORIGINS');
  if (!['local', 'gateway'].includes(process.env.AUTH_MODE || '')) throw new Error('Production requires explicit AUTH_MODE=local or gateway');
  if (process.env.AUTH_MODE === 'gateway' && (process.env.IDENTITY_GATEWAY_SECRET || '').length < 32) throw new Error('IDENTITY_GATEWAY_SECRET requires at least 32 characters');
  if (process.env.NOTIFICATION_WEBHOOK_URL && (process.env.NOTIFICATION_WEBHOOK_SECRET || '').length < 32) throw new Error('Production notification delivery requires a secret of at least 32 characters');
}

export function redactText(value) {
  return String(value).replace(/-----BEGIN [^-]*PRIVATE KEY-----[\s\S]*?-----END [^-]*PRIVATE KEY-----/g, '[REDACTED KEY]')
    .replace(/\b(?:Bearer\s+)[A-Za-z0-9._~+/=-]+/gi, 'Bearer [REDACTED]')
    .replace(/\b(?:sk-|ghp_|github_pat_)[A-Za-z0-9_-]{12,}/g, '[REDACTED TOKEN]')
    .replace(/(["']?(?:password|api[_-]?key|access[_-]?token|secret)["']?\s*[=:]\s*["']?)[^\s,;"'}]+/gi, '$1[REDACTED]');
}
export function redact(value, depth = 0) {
  if (depth > 12) return '[TRUNCATED]';
  if (typeof value === 'string') return redactText(value).slice(0, 20000);
  if (Array.isArray(value)) return value.slice(0, 100).map(v => redact(v, depth + 1));
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).slice(0, 100).map(([k, v]) => [k, /password|secret|token|authorization|cookie|api.?key/i.test(k) ? '[REDACTED]' : redact(v, depth + 1)]));
  return value;
}
export function protectMessages(messages) {
  const result = messages.map(m => ({ ...m, ...(typeof m.content === 'string' ? { content: redactText(m.content) } : {}) }));
  if (process.env.MODEL_DATA_POLICY === 'block' && JSON.stringify(result) !== JSON.stringify(messages)) throw fail(422, '检测到凭据类内容，数据出口策略已阻止请求');
  return result;
}

const list = name => (process.env[name] || '').split(',').map(s => s.trim()).filter(Boolean);
function privateAddress(address) {
  if (address.includes(':')) return !/^2[0-9a-f]{3}:/i.test(address) || /^2001:(?:db8|0):/i.test(address);
  const [a, b] = address.split('.').map(Number);
  return a === 0 || a === 10 || a === 127 || a === 169 && b === 254 || a === 172 && b >= 16 && b <= 31 || a === 192 && b === 168 || a === 100 && b >= 64 && b <= 127 || a >= 224;
}
export async function outboundTarget(input) {
  const url = new URL(input);
  if (!['https:', 'http:'].includes(url.protocol) || url.username || url.password) throw fail(403, '不允许的远程地址');
  const host = url.hostname.replace(/^\[|\]$/g, '');
  if (/^(?:metadata\.google\.internal|169\.254\.169\.254|169\.254\.170\.2)$/i.test(host)) throw fail(403, '禁止访问云元数据');
  const allowed = list('OUTBOUND_ALLOWED_ORIGINS');
  if ((production() || allowed.length) && !allowed.includes(url.origin)) throw fail(403, '远程地址不在允许的出口列表中');
  if (production() && url.protocol !== 'https:' && !list('OUTBOUND_HTTP_ORIGINS').includes(url.origin)) throw fail(403, '远程服务必须使用 HTTPS');
  const addresses = isIP(host) ? [{ address: host, family: isIP(host) }] : await lookup(host, { all: true });
  if (!addresses.length) throw fail(502, '远程地址无法解析');
  for (const { address } of addresses) {
    if (/^169\.254\./.test(address) || /^::ffff:169\.254\./i.test(address)) throw fail(403, '禁止访问链路本地地址');
    if (production() && privateAddress(address) && !list('OUTBOUND_PRIVATE_ORIGINS').includes(url.origin)) throw fail(403, '内部地址需要明确授权');
  }
  return { url, address: addresses[0] };
}

// Resolve once and pin the socket lookup: validation and connection cannot resolve different DNS answers.
export async function safeFetch(input, init = {}) {
  const request = input instanceof Request ? input : null;
  const { url, address } = await outboundTarget(request ? request.url : String(input));
  const signal = init.signal || request?.signal;
  const headers = new Headers(request?.headers); new Headers(init.headers).forEach((v, k) => headers.set(k, v));
  headers.delete('host');
  const body = init.body ?? (request && !['GET', 'HEAD'].includes(request.method) ? Buffer.from(await request.arrayBuffer()) : undefined);
  if (body !== undefined && typeof body !== 'string' && !Buffer.isBuffer(body) && !(body instanceof Uint8Array)) throw fail(400, '不支持的远程请求正文');
  return new Promise((resolve, reject) => {
    const req = (url.protocol === 'https:' ? https : http).request(url, {
      method: init.method || request?.method || 'GET', headers: Object.fromEntries(headers), signal,
      lookup: (_host, options, cb) => options.all ? cb(null, [address]) : cb(null, address.address, address.family),
    }, incoming => {
      if (incoming.statusCode >= 300 && incoming.statusCode < 400) { incoming.destroy(); reject(fail(502, '远程重定向已阻止')); return; }
      const responseHeaders = new Headers();
      for (const [k, v] of Object.entries(incoming.headers)) if (v !== undefined) responseHeaders.set(k, Array.isArray(v) ? v.join(', ') : v);
      let received = 0;
      const stream = [204, 205, 304].includes(incoming.statusCode) || req.method === 'HEAD' ? null : Readable.toWeb(incoming).pipeThrough(new TransformStream({ transform(chunk, controller) { received += chunk.byteLength; if (received > positive('REMOTE_RESPONSE_LIMIT', 2000000)) throw fail(502, '远程响应超过大小限制'); controller.enqueue(chunk); } }));
      if (!stream) incoming.resume();
      resolve(new Response(stream, { status: incoming.statusCode, headers: responseHeaders }));
    });
    req.on('error', reject); req.end(body);
  });
}

export function gatewayIdentity(req) {
  if (process.env.AUTH_MODE !== 'gateway') return null;
  const encoded = req.get('x-aiops-identity') || '';
  const signature = req.get('x-aiops-signature') || '';
  const secret = process.env.IDENTITY_GATEWAY_SECRET || '';
  if (secret.length < 32 || encoded.length > 4096 || !/^[a-f0-9]{64}$/.test(signature)) throw fail(401, '企业身份网关认证缺失');
  const expected = createHmac('sha256', secret).update(encoded).digest('hex');
  if (!timingSafeEqual(Buffer.from(expected), Buffer.from(signature))) throw fail(401, '企业身份签名无效');
  let claims; try { claims = JSON.parse(Buffer.from(encoded, 'base64url').toString()); } catch { throw fail(401, '企业身份格式无效'); }
  if (claims.aud !== process.env.APP_ORIGIN || !Number.isFinite(claims.exp) || claims.exp <= Date.now() / 1000 || claims.exp > Date.now() / 1000 + 120 || claims.mfa !== true || typeof claims.username !== 'string') throw fail(401, '企业身份已过期或未完成多因素认证');
  return claims;
}
