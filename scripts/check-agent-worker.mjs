import { pathToFileURL } from 'node:url';
import { runtimeOptions } from '../server/agent-runtime/index.mjs';
import { createRuntimeDriver } from '../server/agent-runtime/driver.mjs';
import { probeRuntime } from '../server/agent-runtime/probe.mjs';

export async function checkAgentWorker() {
  const driver = createRuntimeDriver(runtimeOptions());
  try {
    await driver.warmup();
    await probeRuntime(driver.run);
    return { version: driver.version, ...driver.health() };
  } finally { await driver.close(); }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try { const health = await checkAgentWorker(); console.log(JSON.stringify({ version: health.version, mode: health.mode, ready: health.ready, probe: 'model + external tool passed' })); }
  catch (error) { console.error(error.message); process.exitCode = 1; }
}
