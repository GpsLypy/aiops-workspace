import { spawn } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';

const cases = [{ runtime: 'agentscope', mode: 'cold' }, { runtime: 'agentscope', mode: 'prefork' }];
const results = [];
for (const entry of cases) {
  console.log(`Measuring ${entry.runtime}/${entry.mode} with local fixtures…`);
  const result = await new Promise((resolveRun, reject) => {
    const child = spawn(process.execPath, ['scripts/load-test.mjs'], { env: { ...process.env, AGENTSCOPE_WORKER_MODE: entry.mode, AGENTSCOPE_POOL_SIZE: '2', MAX_USER_RUNS: '2' }, stdio: ['ignore', 'pipe', 'inherit'] });
    let output = '';
    child.stdout.on('data', chunk => { output += chunk; if (output.length > 1_000_000) { child.kill(); reject(new Error('Benchmark output too large')); } });
    child.once('error', reject);
    child.once('close', code => { if (code !== 0) reject(new Error(`Benchmark exited ${code}`)); else { try { resolveRun(JSON.parse(output)); } catch (error) { reject(error); } } });
  });
  results.push(result);
}
const ratio = results[1].p95Ms / results[0].p95Ms;
const report = { version: 2, runtime: 'agentscope', sdkVersion: '2.0.8', measuredAt: new Date().toISOString(), node: process.version, platform: `${process.platform}/${process.arch}`, results,
  comparison: { kind: 'agentscope-worker-mode', baselineWorkerMode: 'cold', candidateWorkerMode: 'prefork', preforkToColdP95: ratio, suggestedP95Threshold: 1.2, withinSuggestedThreshold: ratio <= 1.2 }, productionCapacityClaim: false };
const output = resolve('test-results/agentscope/runtime-benchmark.json'); mkdirSync(dirname(output), { recursive: true });
writeFileSync(output, JSON.stringify(report, null, 2) + '\n');
console.log(JSON.stringify(report, null, 2));
console.log(`Saved ${output}`);
