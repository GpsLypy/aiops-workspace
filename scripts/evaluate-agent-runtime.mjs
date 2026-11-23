import assert from 'node:assert/strict';
import { readFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import { runtimeFixture, answer, call } from '../tests/runtime-fixture.mjs';
import { redactText } from '../server/security.mjs';

// Both AgentScope worker modes use a temporary store and the local read-only MCP. --real changes
// only the provider; it never selects the user's database or production tools.
const real = process.argv.includes('--real');
if (real && (!process.env.EVAL_MODEL_BASE_URL || !process.env.EVAL_MODEL_NAME)) throw new Error('--real requires EVAL_MODEL_BASE_URL and EVAL_MODEL_NAME');
const cases = JSON.parse(readFileSync(new URL('../tests/evaluation-cases.json', import.meta.url), 'utf8'));
const results = [];
for (const workerMode of ['cold', 'prefork']) {
  const h = await runtimeFixture({ workerMode });
  try {
    await h.request(`/resources/${h.resource.id}`, { ...h.resource, allowedTools: ['service_status'], toolPolicies: { service_status: h.resource.toolPolicies.service_status } }, 'PUT');
    if (real) {
      const saved = await h.request('/settings/model', { baseUrl: process.env.EVAL_MODEL_BASE_URL, model: process.env.EVAL_MODEL_NAME,
        apiType: process.env.EVAL_MODEL_API_TYPE || 'responses', apiKey: process.env.EVAL_MODEL_API_KEY || '', temperature: null }, 'PUT');
      if (saved.status !== 200) throw new Error('Evaluation model configuration rejected');
    }
    await h.app.engine.warmup();
    assert.equal(h.app.engine.health().mode, workerMode);
    for (const item of cases) {
      if (!real) h.model((req, res) => answer(res, item.expectedTool && req.body.messages.at(-1).role !== 'tool' ? [call('fixture-call', item.expectedTool, item.expectedArguments)] : null, item.expectedTool ? 'billing 状态 healthy（本地测试数据）' : '拒绝执行未授权或破坏性操作。'));
      const started = performance.now();
      const response = await h.request('/chat', { text: item.prompt });
      assert.equal(h.app.store.get('SELECT runtime FROM executions WHERE id=?', response.data.runId)?.runtime, 'agentscope');
      const steps = response.data.runId ? h.app.store.all('SELECT tool,status,arguments_encrypted FROM tool_steps WHERE run_id=?', response.data.runId) : [];
      // The one exposed tool is mcp_0 in model requests, service_status in the ledger.
      const validEvidence = item.expectedTool ? steps.length === 1 && steps[0].tool === 'service_status' && steps[0].status === 'success' && isDeepStrictEqual(JSON.parse(h.app.store.decrypt(steps[0].arguments_encrypted)), item.expectedArguments) : steps.length === 0;
      results.push({ runtime: 'agentscope', workerMode, caseId: item.id, passed: response.status === 200 && validEvidence, status: response.status, actualSteps: steps.map(s => ({ tool: s.tool, status: s.status })),
        tokens: response.data.metadata?.usage?.total_tokens ?? null, elapsedMs: Math.round(performance.now() - started), answer: redactText(response.data.text || response.data.error || '') });
    }
  } finally { await h.close(); }
}
const report = { version: 2, runtime: 'agentscope', sdkVersion: '2.0.8', comparison: 'cold-versus-prefork', measuredAt: new Date().toISOString(), mode: real ? 'real-model-local-readonly-mcp' : 'deterministic-fixture', results,
  passed: results.filter(r => r.passed).length, total: results.length, productionToolsUsed: false,
  limitations: 'Checks execution evidence, limits and compatibility. Diagnosis quality and refusal wording need human review with representative incidents; four canned cases are not a production quality claim.' };
const output = resolve(`test-results/agentscope/runtime-evaluation-${real ? 'real' : 'fixture'}.json`); mkdirSync(dirname(output), { recursive: true });
writeFileSync(output, JSON.stringify(report, null, 2) + '\n');
console.log(JSON.stringify(report, null, 2));
if (results.some(r => !r.passed)) process.exitCode = 1;
