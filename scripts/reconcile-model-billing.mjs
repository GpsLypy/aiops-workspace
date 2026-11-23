import { writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { readBillingInput, reconcileBilling } from './model-billing.mjs';

try {
  const { values } = parseArgs({ options: { usage: { type: 'string' }, invoice: { type: 'string' }, out: { type: 'string' } }, allowPositionals: false });
  if (!values.usage || !values.invoice || !values.out) throw new Error('Usage: node scripts/reconcile-model-billing.mjs --usage USAGE.csv|json --invoice BILL.csv|json --out NEW_REPORT.json');
  const usage = readBillingInput(resolve(values.usage), 'usage'), invoice = readBillingInput(resolve(values.invoice), 'invoice');
  const result = reconcileBilling(usage.records, invoice.records, { usageSha256: usage.sha256, invoiceSha256: invoice.sha256 });
  writeFileSync(resolve(values.out), JSON.stringify(result, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
  console.log(JSON.stringify({ status: result.status, coverageComplete: result.coverageComplete, costsMatch: result.costsMatch, tokensMatch: result.tokensMatch, counts: result.counts }));
  process.exitCode = result.status === 'matched' ? 0 : 2;
} catch (error) {
  console.error(error.code === 'EEXIST' ? 'Output already exists; supply a new report path' : error.code === 'ENOENT' ? 'An input file or output directory does not exist' : error.message);
  process.exitCode = 1;
}
