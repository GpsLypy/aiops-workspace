import { spawn } from 'node:child_process';
import { readdirSync } from 'node:fs';
import { checkAgentWorker } from './check-agent-worker.mjs';

try {
  await checkAgentWorker();
  const files = ['tests', 'tests/agentscope'].flatMap(dir => readdirSync(dir).filter(name => name.endsWith('.test.mjs')).sort().map(name => `${dir}/${name}`));
  const child = spawn(process.execPath, ['--test', ...files], { stdio: 'inherit', env: process.env });
  for (const signal of ['SIGINT', 'SIGTERM']) process.once(signal, () => child.kill(signal));
  child.on('error', error => { console.error(error.message); process.exitCode = 1; });
  child.on('exit', code => { process.exitCode = code ?? 1; });
} catch (error) { console.error(`AgentScope preflight failed: ${error.message}`); process.exitCode = 1; }
