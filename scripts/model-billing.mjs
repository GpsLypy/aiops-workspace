import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { extname } from 'node:path';
import { z } from 'zod';

const identifier = z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9._:/+-]{0,99}$/);
const date = z.string().regex(/^\d{4}-\d{2}-\d{2}$/).refine(value => {
  const time = Date.parse(value + 'T00:00:00Z');
  return Number.isFinite(time) && new Date(time).toISOString().slice(0, 10) === value;
}, 'date must be a real UTC calendar day');
const decimal = z.string()
  .refine(value => /^-?(0|[1-9]\d{0,12})(\.\d{1,6})?$/.test(value), 'cost must be a decimal with at most 6 fractional digits');
const tokens = z.union([z.string().regex(/^(0|[1-9]\d*)$/), z.number()]).transform(value => Number(value))
  .refine(value => Number.isSafeInteger(value) && value >= 0, 'tokens must be a nonnegative safe integer');
const common = { date, provider: identifier, model: identifier, currency: z.string().regex(/^[A-Z]{3}$/) };
const usageSchema = z.object({ ...common, tokens, tokenSource: z.enum(['reported', 'estimated', 'unknown']),
  estimatedCost: decimal.refine(value => !value.startsWith('-'), 'estimatedCost cannot be negative') }).strict();
const invoiceSchema = z.object({ ...common, billedCost: decimal, category: z.enum(['usage', 'credit', 'other']), tokens: tokens.optional() }).strict()
  .refine(row => row.category === 'credit' ? row.billedCost.startsWith('-') : row.category !== 'usage' || !row.billedCost.startsWith('-'),
    'usage charges cannot be negative; credit charges must be negative');

// Costs are integer millionths. Never sum binary floating-point currency values.
export function costMicros(value) {
  const negative = value.startsWith('-');
  const [whole, fractional = ''] = value.replace(/^-/, '').split('.');
  return (BigInt(whole) * 1000000n + BigInt(fractional.padEnd(6, '0'))) * (negative ? -1n : 1n);
}
export function costDecimal(value) {
  const negative = value < 0n, abs = negative ? -value : value;
  return `${negative ? '-' : ''}${abs / 1000000n}.${String(abs % 1000000n).padStart(6, '0')}`;
}

export function parseBillingCsv(source) {
  const rows = [], row = [];
  let field = '', quoted = false, afterQuote = false;
  const finishField = () => { row.push(field); field = ''; afterQuote = false; };
  const finishRow = () => { finishField(); if (row.some(value => value.length)) rows.push([...row]); row.length = 0; };
  source = source.replace(/^\uFEFF/, '');
  for (let i = 0; i < source.length; i++) {
    const char = source[i];
    if (quoted) {
      if (char === '"' && source[i + 1] === '"') { field += '"'; i++; }
      else if (char === '"') { quoted = false; afterQuote = true; }
      else field += char;
    } else if (char === '"' && !field && !afterQuote) quoted = true;
    else if (char === ',') finishField();
    else if (char === '\n' || char === '\r') { if (char === '\r' && source[i + 1] === '\n') i++; finishRow(); }
    else if (afterQuote || char === '"') throw new Error('Invalid CSV quoting');
    else field += char;
  }
  if (quoted) throw new Error('Unterminated CSV quote');
  if (row.length || field || afterQuote) finishRow();
  const headers = rows.shift();
  if (!headers?.length || headers.some(value => !value) || new Set(headers).size !== headers.length) throw new Error('CSV requires unique nonempty column names');
  return rows.map(values => {
    if (values.length !== headers.length) throw new Error('CSV row has a different column count');
    return Object.fromEntries(headers.flatMap((header, index) => values[index] === '' ? [] : [[header, values[index]]]));
  });
}

export function normalizeBillingRecords(records, kind) {
  if (!['usage', 'invoice'].includes(kind) || !Array.isArray(records) || !records.length || records.length > 100000) throw new Error('Supply 1 to 100000 records of the requested kind');
  return records.map((row, index) => {
    const result = (kind === 'usage' ? usageSchema : invoiceSchema).safeParse(row);
    // Print field names and row numbers only, never raw invoice data or secrets.
    if (!result.success) throw new Error(`Invalid ${kind} row ${index + 1}: ${[...new Set(result.error.issues.map(issue => issue.path.join('.') || 'record'))].join(', ')}`);
    return result.data;
  });
}

export function readBillingInput(path, kind) {
  const buffer = readFileSync(path);
  if (buffer.length > 8 * 1024 * 1024) throw new Error('Billing input exceeds 8 MiB');
  let records;
  if (extname(path).toLowerCase() === '.csv') records = parseBillingCsv(buffer.toString('utf8'));
  else if (extname(path).toLowerCase() === '.json') {
    let parsed;
    try { parsed = JSON.parse(buffer.toString('utf8')); } catch { throw new Error('Billing JSON is invalid'); }
    const envelope = z.object({ schemaVersion: z.literal(1), kind: z.literal(kind), records: z.array(z.unknown()) }).strict().safeParse(parsed);
    if (!envelope.success) throw new Error('Billing JSON requires schemaVersion=1, the requested kind, and records');
    records = envelope.data.records;
  } else throw new Error('Billing input must be .csv or .json');
  return { records: normalizeBillingRecords(records, kind), sha256: createHash('sha256').update(buffer).digest('hex') };
}

export function reconcileBilling(usageRecords, invoiceRecords, provenance = {}) {
  const usages = normalizeBillingRecords(usageRecords, 'usage');
  const invoices = normalizeBillingRecords(invoiceRecords, 'invoice');
  const groups = new Map(), currencies = new Map();
  const currency = value => {
    if (!currencies.has(value)) currencies.set(value, { currency: value, estimated: 0n, billedUsage: 0n, adjustments: 0n });
    return currencies.get(value);
  };
  const group = row => {
    const key = JSON.stringify([row.date, row.provider, row.model, row.currency]);
    if (!groups.has(key)) groups.set(key, { date: row.date, provider: row.provider, model: row.model, currency: row.currency,
      usageRows: 0, invoiceRows: 0, usageTokens: 0n, invoiceTokens: 0n, invoiceTokenCoverage: true, usageTokensReported: true, estimated: 0n, billed: 0n });
    return groups.get(key);
  };
  for (const row of usages) {
    const entry = group(row), cost = costMicros(row.estimatedCost);
    entry.usageRows++; entry.usageTokens += BigInt(row.tokens); entry.estimated += cost;
    if (row.tokenSource !== 'reported') entry.usageTokensReported = false;
    currency(row.currency).estimated += cost;
  }
  for (const row of invoices) {
    const cost = costMicros(row.billedCost), total = currency(row.currency);
    if (row.category !== 'usage') { total.adjustments += cost; continue; }
    const entry = group(row);
    entry.invoiceRows++; entry.billed += cost; total.billedUsage += cost;
    if (row.tokens === undefined) entry.invoiceTokenCoverage = false;
    else entry.invoiceTokens += BigInt(row.tokens);
  }
  const rows = [...groups.values()].sort((a, b) => JSON.stringify([a.date, a.provider, a.model, a.currency]).localeCompare(JSON.stringify([b.date, b.provider, b.model, b.currency]))).map(entry => {
    const matched = !!entry.usageRows && !!entry.invoiceRows;
    const tokenDifference = matched && entry.invoiceTokenCoverage ? String(entry.invoiceTokens - entry.usageTokens) : null;
    const costDifference = matched ? costDecimal(entry.billed - entry.estimated) : null;
    return { date: entry.date, provider: entry.provider, model: entry.model, currency: entry.currency,
      status: !entry.usageRows ? 'invoice_only' : !entry.invoiceRows ? 'usage_only' : entry.billed !== entry.estimated || tokenDifference !== null && tokenDifference !== '0' ? 'difference' : 'matched',
      usageRows: entry.usageRows, invoiceRows: entry.invoiceRows, usageTokens: String(entry.usageTokens),
      usageTokensReported: entry.usageTokensReported,
      invoiceTokens: entry.invoiceRows && entry.invoiceTokenCoverage ? String(entry.invoiceTokens) : null,
      estimatedCost: costDecimal(entry.estimated), billedUsageCost: costDecimal(entry.billed), costDifference, tokenDifference };
  });
  const matchedGroups = rows.filter(row => ['matched', 'difference'].includes(row.status)).length;
  const complete = matchedGroups === rows.length;
  const costsMatch = complete && rows.every(row => row.costDifference === '0.000000');
  const tokensMatch = complete && rows.every(row => row.usageTokensReported && row.tokenDifference === '0');
  return { schemaVersion: 1, generatedAt: new Date().toISOString(), inputProvenance: { ...provenance, invoiceSource: 'user_supplied_unverified' },
    status: costsMatch && tokensMatch ? 'matched' : 'needs_review', coverageComplete: complete, costsMatch, tokensMatch,
    counts: { usageRows: usages.length, invoiceRows: invoices.length, groups: rows.length, matchedGroups,
      usageOnly: rows.filter(row => row.status === 'usage_only').length, invoiceOnly: rows.filter(row => row.status === 'invoice_only').length,
      differences: rows.filter(row => row.status === 'difference').length },
    totals: [...currencies.values()].sort((a, b) => a.currency.localeCompare(b.currency)).map(total => ({ currency: total.currency,
      estimatedCost: costDecimal(total.estimated), billedUsageCost: costDecimal(total.billedUsage), billedAdjustments: costDecimal(total.adjustments),
      billedNetCost: costDecimal(total.billedUsage + total.adjustments) })), rows,
    providerAccountVerified: false, productionAccepted: false,
    limitations: ['Imported billing files are user supplied; source authenticity and provider account access are not verified.',
      'Matching is aggregated by UTC date/provider/model/currency. It does not match individual requests, cached-token prices, or taxes.',
      'Usage estimates and invoice charges remain separate. Estimated/unknown usage tokens and missing invoice tokens remain unverified; currencies are never converted or summed together.'] };
}
