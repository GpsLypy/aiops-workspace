import assert from 'node:assert/strict';
import { readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export function buildRequestFlow({ root, check = false }) {
  const spec = JSON.parse(readFileSync(resolve(root, 'docs/diagrams/request-flow.json'), 'utf8'));
  assert.equal(spec.version, 2);
  const template = readFileSync(resolve(root, 'docs/web/request-flow.html'), 'utf8');
  assert.equal(template.split('__FLOW_DATA__').length, 2, 'Exactly one data placeholder');
  const seen = new Set();
  for (const scenario of spec.scenarios) {
    assert.ok(!seen.has(scenario.id)); seen.add(scenario.id);
    assert.ok(scenario.steps.length > 0 && scenario.steps.every(id => spec.nodes[id]), scenario.id);
  }
  const nodeIds = [...template.matchAll(/id="node-([\w-]+)"/g)].map(m => m[1]);
  assert.deepEqual(new Set(nodeIds), new Set(Object.keys(spec.nodes)), 'Every described node appears once in chart');
  assert.equal(nodeIds.length, Object.keys(spec.nodes).length);
  const html = template.replace('__FLOW_DATA__', JSON.stringify(spec).replaceAll('<', '\\u003c'));
  const output = resolve(root, 'docs/site/request-flow.html');
  if (check) assert.equal(readFileSync(output, 'utf8'), html, 'Request flow is stale; run npm run docs:build');
  else writeFileSync(output, html);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  buildRequestFlow({ root: fileURLToPath(new URL('../', import.meta.url)), check: process.argv.includes('--check') });
}
