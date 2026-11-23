import { spawn } from 'node:child_process';
import { mkdirSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { runtimeOptions } from '../server/agent-runtime/index.mjs';

const uv = process.env.UV_BIN || 'uv';
const output = resolve('test-results/agentscope'); mkdirSync(output, { recursive: true });
const requirements = join(output, 'requirements.txt');
function execute(args) {
  return new Promise((resolveRun, reject) => {
    const child = spawn(uv, args, { stdio: 'inherit' });
    child.once('error', reject); child.once('close', code => code === 0 ? resolveRun() : reject(new Error(`uv command exited ${code}; inspect test-results/agentscope/python-audit.json`)));
  });
}
try {
  await execute(['export', '--project', 'agent-worker', '--frozen', '--format', 'requirements-txt', '--no-dev', '--output-file', requirements, '--quiet']);
  await execute(['tool', 'run', '--python', runtimeOptions().python, '--from', 'pip-audit==2.9.0', 'pip-audit', '-r', requirements, '--no-deps', '--disable-pip', '--format', 'json', '--output', join(output, 'python-audit.json')]);
} catch (error) { console.error(error.message); process.exitCode = 1; }
