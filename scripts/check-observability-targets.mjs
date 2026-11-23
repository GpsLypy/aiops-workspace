import { parseArgs } from 'node:util';
import { readObservabilityTargets } from './observability-stack.mjs';
try {
  const { values } = parseArgs({ options: { targets: { type: 'string' } }, allowPositionals: false });
  if (!values.targets) throw new Error('Usage: node scripts/check-observability-targets.mjs --targets TARGETS.json');
  const targets = readObservabilityTargets(values.targets);
  console.log(JSON.stringify({ valid: true, instances: targets.length }));
} catch (error) { console.error(error.message); process.exitCode = 1; }
