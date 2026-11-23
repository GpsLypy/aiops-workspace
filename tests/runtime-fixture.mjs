import { responsesFixture } from './responses-fixture.mjs';
import express from 'express';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createApplication } from '../server/app.mjs';
import { listen, startFixtures } from './fixtures.mjs';

export const call = (id = 'call-one', name = 'mcp_0', args = { service: 'billing' }) => ({ id, type: 'function', function: { name, arguments: typeof args === 'string' ? args : JSON.stringify(args) } });
export const answer = (res, tool_calls, content = '已确认') => res.json({ choices: [{ message: { role: 'assistant', content, ...(tool_calls ? { tool_calls } : {}) } }], usage: { prompt_tokens: 20, completion_tokens: 10, total_tokens: 30 } });

export async function runtimeFixture(agentRuntime = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'aiops-runtime-test-'));
  const fixtures = await startFixtures(); const requests = []; const modelTraceparents = [];
  let reply = (req, res) => answer(res);
  const endpoint = express(); endpoint.use(express.json());
  endpoint.post('/v1/responses', responsesFixture, (req, res) => { requests.push(req.body); modelTraceparents.push(req.headers.traceparent || null); reply(req, res); });
  const model = await listen(endpoint);
  let activeDir = dir;
  let app = createApplication({ dataDir: activeDir, scheduler: false, agentRuntime, agentTelemetry: agentRuntime.telemetry });
  let http = await listen(app.app); let cookie;
  const request = async (path, body, method = body ? 'POST' : 'GET', who = cookie) => {
    const response = await fetch(http.url + '/api' + path, { method, headers: { 'Content-Type': 'application/json', Cookie: who || '' }, ...(body ? { body: JSON.stringify(body) } : {}) });
    return { status: response.status, data: await response.json(), cookie: response.headers.get('set-cookie')?.split(';')[0] };
  };
  cookie = (await request('/auth/setup', { username: 'admin', password: 'runtime-test-password' })).cookie;
  await request('/settings/model', { baseUrl: model.url + '/v1', model: 'fixture', apiKey: 'fixture-model-secret' }, 'PUT');
  await request('/users', { username: 'reviewer', password: 'reviewer-test-password', role: 'admin' });
  const reviewer = (await request('/auth/login', { username: 'reviewer', password: 'reviewer-test-password' })).cookie;
  const resource = (await request('/resources', { kind: 'mcp', name: 'runtime-mcp', environment: 'production', endpoint: fixtures.url + '/mcp', token: 'fixture-mcp-secret', allowedTools: ['service_status', 'set_service_state'], toolPolicies: {
    service_status: { risk: 'read', environments: ['production'], constraints: { service: ['billing'] } },
    set_service_state: { risk: 'write', environments: ['production'], constraints: { service: ['billing'], state: ['maintenance'] }, idempotencyArgument: 'idempotencyKey', verification: { tool: 'service_status', arguments: { service: 'billing' }, path: 'status', equals: 'maintenance' }, recovery: '人工核对后提交恢复计划' },
  } })).data;
  const schemas = (await request(`/mcp/${resource.id}/discover`, {})).data;
  return { dir, requests, modelTraceparents, fixtures, resource, schemas, reviewer, request,
    get app() { return app; }, get url() { return http.url; }, get user() { return app.store.get("SELECT * FROM users WHERE username='admin'"); },
    model: fn => { reply = fn; },
    restart: async (options, dataDir = activeDir) => { await http.close(); await app.close(); activeDir = dataDir; app = createApplication({ dataDir: activeDir, scheduler: false, agentRuntime: options ?? agentRuntime, agentTelemetry: (options ?? agentRuntime).telemetry }); http = await listen(app.app); },
    close: async () => { await http.close(); await app.close(); await model.close(); await fixtures.close(); rmSync(dir, { recursive: true, force: true }); },
  };
}
