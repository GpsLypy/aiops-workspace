import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, statSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { normalizeBillingRecords, parseBillingCsv, readBillingInput, reconcileBilling } from '../scripts/model-billing.mjs';

const usage = (extra = {}) => ({ date: '2026-10-08', provider: 'example', model: 'example-model', currency: 'USD', tokens: 30, tokenSource: 'reported', estimatedCost: '0.100001', ...extra });
const invoice = (extra = {}) => ({ date: '2026-10-08', provider: 'example', model: 'example-model', currency: 'USD', tokens: 30, billedCost: '0.100001', category: 'usage', ...extra });

test('billing reconciliation aggregates exact decimals while keeping independent currencies and credits separate', () => {
  const report = reconcileBilling([usage(), usage({ estimatedCost: '0.200002' }), usage({ currency: 'CNY', estimatedCost: '1.000001' })],
    [invoice({ billedCost: '0.300003', tokens: 60 }), invoice({ currency: 'CNY', billedCost: '1.000001' }), invoice({ category: 'credit', billedCost: '-0.010001' })]);
  assert.equal(report.status, 'matched'); assert.equal(report.providerAccountVerified, false); assert.equal(report.productionAccepted, false);
  assert.deepEqual(report.totals, [
    { currency: 'CNY', estimatedCost: '1.000001', billedUsageCost: '1.000001', billedAdjustments: '0.000000', billedNetCost: '1.000001' },
    { currency: 'USD', estimatedCost: '0.300003', billedUsageCost: '0.300003', billedAdjustments: '-0.010001', billedNetCost: '0.290002' },
  ]);
});

test('differences, unobserved invoice usage, and unbilled observed usage remain visible', () => {
  const report = reconcileBilling([usage(), usage({ model: 'unbilled' })], [invoice({ tokens: 32, billedCost: '0.200001' }), invoice({ model: 'unobserved' })]);
  assert.equal(report.coverageComplete, false); assert.equal(report.status, 'needs_review');
  assert.deepEqual(report.counts, { usageRows: 2, invoiceRows: 2, groups: 3, matchedGroups: 1, usageOnly: 1, invoiceOnly: 1, differences: 1 });
  const difference = report.rows.find(row => row.status === 'difference');
  assert.equal(difference.tokenDifference, '2'); assert.equal(difference.costDifference, '0.100000');
});

test('invoice missing token details cannot silently pass token verification', () => {
  const row = invoice(); delete row.tokens;
  const report = reconcileBilling([usage()], [row]);
  assert.equal(report.costsMatch, true); assert.equal(report.tokensMatch, false); assert.equal(report.status, 'needs_review');
  assert.equal(report.rows[0].invoiceTokens, null); assert.equal(report.rows[0].tokenDifference, null);
  const estimated = reconcileBilling([usage({ tokenSource: 'estimated' })], [invoice()]);
  assert.equal(estimated.tokensMatch, false); assert.equal(estimated.status, 'needs_review');
  assert.equal(estimated.rows[0].usageTokensReported, false);
});

test('JSON numeric currency values are rejected before precision loss can produce a false match', () => {
  const rounded = JSON.parse('{"estimatedCost":1000000000000.000001}').estimatedCost;
  assert.equal(rounded, 1000000000000, 'the JSON number has already lost one millionth');
  assert.throws(() => reconcileBilling([usage({ estimatedCost: rounded })], [invoice({ billedCost: '1000000000000.000000' })]), /estimatedCost/);
  assert.throws(() => reconcileBilling([usage()], [invoice({ billedCost: 0.100001 })]), /billedCost/);
  const precise = reconcileBilling([usage({ estimatedCost: '1000000000000.000001' })], [invoice({ billedCost: '1000000000000.000000' })]);
  assert.equal(precise.status, 'needs_review'); assert.equal(precise.costsMatch, false);
  assert.equal(precise.rows[0].costDifference, '-0.000001');
});

test('billing accepts quoted CSV but rejects raw private fields, invalid dates, fractional tokens and imprecise costs', () => {
  const csv = 'date,provider,model,currency,tokens,tokenSource,estimatedCost\r\n"2026-10-08",example,"example-model",USD,30,reported,0.100001\r\n';
  assert.deepEqual(normalizeBillingRecords(parseBillingCsv(csv), 'usage'), [usage()]);
  for (const bad of [usage({ prompt: 'SECRET' }), usage({ date: '2026-02-30' }), usage({ tokens: 1.2 }), usage({ tokens: '' }), usage({ estimatedCost: '0.0000001' }), usage({ estimatedCost: '-1' })]) {
    assert.throws(() => normalizeBillingRecords([bad], 'usage'), error => !error.message.includes('SECRET'));
  }
  assert.throws(() => parseBillingCsv('model,model\na,b'), /unique/);
  assert.throws(() => parseBillingCsv('model\n"broken'), /quote/);
  assert.throws(() => parseBillingCsv('model\n"model"suffix'), /quoting/);
  assert.throws(() => normalizeBillingRecords([invoice({ category: 'usage', billedCost: '-1' })], 'invoice'));
});

test('billing CLI binds raw files, writes private append-only reports and returns 2 for gaps', () => {
  const dir = mkdtempSync(join(tmpdir(), 'aiops-billing-test-'));
  try {
    const usagePath = join(dir, 'usage.json'), invoicePath = join(dir, 'invoice.csv'), output = join(dir, 'report.json');
    writeFileSync(usagePath, JSON.stringify({ schemaVersion: 1, kind: 'usage', records: [usage()] }));
    writeFileSync(invoicePath, 'date,provider,model,currency,tokens,billedCost,category\n2026-10-08,example,example-model,USD,30,0.100001,usage\n');
    const run = out => spawnSync(process.execPath, ['scripts/reconcile-model-billing.mjs', '--usage', usagePath, '--invoice', invoicePath, '--out', out], { encoding: 'utf8' });
    assert.equal(run(output).status, 0);
    assert.equal(statSync(output).mode & 0o777, 0o600);
    const report = JSON.parse(readFileSync(output));
    assert.equal(report.inputProvenance.usageSha256, readBillingInput(usagePath, 'usage').sha256);
    const original = readFileSync(output, 'utf8'); assert.equal(run(output).status, 1); assert.equal(readFileSync(output, 'utf8'), original);
    writeFileSync(invoicePath, 'date,provider,model,currency,tokens,billedCost,category\n2026-10-08,example,other-model,USD,30,0.100001,usage\n');
    assert.equal(run(join(dir, 'gaps.json')).status, 2);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
