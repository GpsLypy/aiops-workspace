import { httpError } from './store.mjs';

const transient = new Map([
  ['server_error', 'service_unavailable'], ['service_unavailable', 'service_unavailable'],
  ['server_is_overloaded', 'service_unavailable'], ['rate_limit_exceeded', 'rate_limit'], ['slow_down', 'rate_limit'],
]);
export const quotaCodes = new Set(['insufficient_quota', 'credit_balance_exhausted', 'organization_spend_limit_exceeded', 'project_spend_limit_exceeded']);

// Adopt Codex's exponential backoff and jitter, within this workspace's bounded
// policy. Server advice never enables a retry for an otherwise terminal error.
export function retryDelay(retryNumber, retryAfterMs, random = Math.random) {
  if (retryAfterMs !== undefined) return retryAfterMs;
  return Math.min(5000, Math.round(400 * 2 ** (retryNumber - 1) * (.9 + random() * .2)));
}
export function retryAfter(headers, now = Date.now()) {
  const value = headers?.get('retry-after')?.trim();
  if (!value) return undefined;
  if (!/^\d+(?:\.\d+)?$/.test(value) && !/[a-z]/i.test(value)) return undefined;
  const ms = /^\d+(?:\.\d+)?$/.test(value) ? Number(value) * 1000 : Date.parse(value) - now;
  return Number.isFinite(ms) ? Math.max(0, ms) : undefined;
}
export function providerFailure(detail) {
  const reason = transient.get(detail?.code);
  const delay = retryAfter(new Headers(detail?.headers && typeof detail.headers === 'object'
    ? Object.fromEntries(Object.entries(detail.headers).filter(([key, value]) => key.toLowerCase() === 'retry-after' && typeof value === 'string')) : {}));
  return Object.assign(httpError(502, quotaCodes.has(detail?.code)
    ? '模型服务额度已用尽，请联系管理员检查额度与费用限制'
    : '模型服务报告请求失败，请稍后重试或检查模型状态'), {
    retryable: !!reason && (delay === undefined || delay <= 5000), retryReason: reason, retryAfterMs: delay,
  });
}
