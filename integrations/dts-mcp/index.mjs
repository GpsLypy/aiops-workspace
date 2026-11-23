import { createDtsMcpApp, loadConfig } from './adapter.mjs';

const config = loadConfig();
const listener = createDtsMcpApp(config).listen(config.port, '127.0.0.1', () => {
  console.log(JSON.stringify({ event: 'dts.mcp.started', endpoint: `http://127.0.0.1:${config.port}/mcp`, business_domain: config.businessDomain, area_name: config.areaName, job_scope: config.jobScope, allowed_jobs: config.jobScope === 'region' ? null : config.allowedJobIds.length }));
});
listener.on('error', error => { console.error(JSON.stringify({ event: 'dts.mcp.start_failed', code: error.code || 'UNKNOWN' })); process.exitCode = 1; });
for (const signal of ['SIGTERM', 'SIGINT']) process.on(signal, () => {
  listener.close(() => process.exit(0));
  setTimeout(() => { listener.closeAllConnections(); process.exit(0); }, 10000).unref();
});
