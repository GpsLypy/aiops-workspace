import { test } from 'node:test';
import assert from 'node:assert/strict';
import { retryDelay, retryAfter, providerFailure } from '../server/model-retry.mjs';

test('exponential jitter is bounded and server advice takes precedence', () => {
  assert.deepEqual([1, 2, 3, 4, 5].map(n => retryDelay(n, undefined, () => .5)), [400, 800, 1600, 3200, 5000]);
  assert.equal(retryDelay(1, undefined, () => 0), 360);
  assert.equal(retryDelay(1, undefined, () => 1), 440);
  assert.equal(retryDelay(5, 0), 0);
  assert.equal(retryDelay(1, 1700), 1700);
  assert.equal(retryAfter(new Headers({ 'Retry-After': '.2' })), undefined);
  assert.equal(retryAfter(new Headers({ 'Retry-After': '0.2' })), 200);
  assert.equal(retryAfter(new Headers({ 'Retry-After': 'invalid' })), undefined);
  assert.equal(retryAfter(new Headers({ 'Retry-After': new Date(4000).toUTCString() }), 1000), 3000);
});
test('provider retry advice cannot turn quota and unknown errors into retries or leak text', () => {
  for (const code of ['insufficient_quota', 'credit_balance_exhausted', 'invalid_prompt', 'unknown']) {
    const error = providerFailure({ code, message: 'PRIVATE_SECRET', headers: { 'Retry-After': '0' } });
    assert.equal(error.retryable, false); assert.doesNotMatch(error.message, /PRIVATE_SECRET/);
  }
  for (const code of ['rate_limit_exceeded', 'slow_down', 'server_is_overloaded']) {
    const error = providerFailure({ code, headers: { 'retry-after': '0.2' } });
    assert.equal(error.retryable, true); assert.equal(error.retryAfterMs, 200);
    assert.equal(providerFailure({ code, headers: { 'retry-after': '6' } }).retryable, false);
  }
});
