import assert from 'node:assert/strict';
import { readFileSync, writeFileSync } from 'node:fs';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import http from 'node:http';
import https from 'node:https';

const file = process.argv[2];
const output = process.argv[3];
if (!file || !output) throw Error('Usage: node probe.mjs PRIVATE_JSON NEW_REPORT');
const { endpoint, token, jobid } = JSON.parse(readFileSync(file, 'utf8'));
const url = new URL(endpoint);
if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.pathname !== '/mcp' || url.search || url.hash) throw Error('Invalid MCP endpoint');
assert.equal(typeof jobid, 'string');
const request = { jobid, business_domain: 'general', area_name: 'cn_east' };
const client = new Client({ name: 'dts-sandbox-acceptance', version: '1.0.0' });
const transport = new StreamableHTTPClientTransport(url, { requestInit: { headers: { Authorization: `Bearer ${token}` } } });
const report = { schemaVersion: 1, checkedAt: new Date().toISOString(), endpoint: url.href, checks: {}, productionAccepted: false };
try {
  const health = await fetch(new URL('/health', url), { signal: AbortSignal.timeout(3000) });
  assert.equal((await health.json()).service, 'dts-readonly-mcp'); report.checks.health = true;
  const auth = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
  assert.equal(auth.status, 401); report.checks.unauthenticatedDenied = true;
  // Raw HTTP is required: Node fetch can replace a user-supplied Host header.
  const hostStatus = await new Promise((done, reject) => {
    const req = (url.protocol === 'https:' ? https : http).request(url, { method: 'POST', headers: { Host: 'untrusted.example', Authorization: `Bearer ${token}`, 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream' } }, response => { response.resume(); done(response.statusCode); });
    req.on('error', reject); req.setTimeout(3000, () => req.destroy(Error('Host probe timed out'))); req.end('{}');
  });
  assert.equal(hostStatus, 403); report.checks.untrustedHostDenied = true;
  const origin = await fetch(url, { method: 'POST', headers: { Origin: 'https://untrusted.example', Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }, body: '{}' });
  assert.equal(origin.status, 403); report.checks.untrustedOriginDenied = true;
  await client.connect(transport); report.checks.sdkHandshake = true;
  assert.deepEqual((await client.listTools()).tools.map(t => t.name), ['dts_get_job_status']); report.checks.singleReadonlyTool = true;
  const result = await client.callTool({ name: 'dts_get_job_status', arguments: request });
  assert.ok(!result.isError, 'Real DTS status query failed');
  const status = JSON.parse(result.content[0].text);
  assert.equal(status.jobid, jobid); assert.equal(status.fixture, false);
  assert.equal(status.business_domain, 'general'); assert.equal(status.area_name, 'cn_east');
  report.checks.realStatusQuery = true;
  report.status = status;
  const denied = await client.callTool({ name: 'dts_get_job_status', arguments: { ...request, area_name: 'cn_north' } });
  assert.equal(denied.isError, true); assert.equal(JSON.parse(denied.content[0].text).code, 'SCOPE_DENIED'); report.checks.crossRegionDenied = true;
  const invalid = await client.callTool({ name: 'dts_get_job_status', arguments: { ...request, jobid: Number(jobid) } });
  assert.equal(invalid.isError, true); report.checks.numericJobIdDenied = true;
} finally { await client.close(); }
writeFileSync(output, JSON.stringify(report, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
console.log(JSON.stringify({ output, checks: report.checks, state: report.status.state, freshness: report.status.freshness }));
