import assert from 'node:assert/strict';
import express from 'express';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import { runtimeFixture, answer, call } from '../tests/runtime-fixture.mjs';
import { listen } from '../tests/fixtures.mjs';
import { dtsEvaluationCases, dtsInspectionMaxAgeSeconds, expectedDtsAssessmentAt } from '../tests/dts-evaluation-cases.mjs';
import { loadConfig, createStatusQuery, createDtsMcpApp, TOOL } from '../integrations/dts-mcp/adapter.mjs';
import { provisionDts } from '../integrations/dts-mcp/provision.mjs';
import { assessInspection } from '../server/inspection.mjs';
import { candidateDigest, corpusDigest, sha256 } from './agent-candidate.mjs';
import { runtimeOptions } from '../server/agent-runtime/index.mjs';
import { redactText } from '../server/security.mjs';
import { dtsEvaluationInput } from './dts-evaluation-input.mjs';

const real = process.argv.includes('--real');
const repeatIndex = process.argv.indexOf('--repeat');
const repeats = repeatIndex < 0 ? 1 : Number(process.argv[repeatIndex + 1]);
const outputIndex = process.argv.indexOf('--out');
const output = resolve(outputIndex < 0 ? `test-results/agentscope/dts-evaluation-${real ? 'real' : 'fixture'}-${new Date().toISOString().replaceAll(':', '-')}.json` : process.argv[outputIndex + 1] || '');
if (outputIndex >= 0 && (!process.argv[outputIndex + 1] || process.argv[outputIndex + 1].startsWith('--'))) throw new Error('--out requires a new report path');
if (existsSync(output)) throw new Error('Output report already exists');
if (!Number.isSafeInteger(repeats) || repeats < 1 || repeats > 10) throw new Error('--repeat must be 1–10');
if (real && (!process.env.EVAL_MODEL_BASE_URL || !process.env.EVAL_MODEL_NAME)) throw new Error('--real requires EVAL_MODEL_BASE_URL and EVAL_MODEL_NAME');
process.env.RUNS_PER_MINUTE = '1000'; process.env.DAILY_RUN_LIMIT = '2000'; process.env.DAILY_TOKEN_LIMIT = '10000000';
const startedAt = new Date().toISOString();
const source = candidateDigest();
const configuration = runtimeOptions();
const candidate = { ...source, corpusDigest: corpusDigest(), sdkVersion: '2.0.8', node: process.version, platform: process.platform, architecture: process.arch,
  model: { name: real ? process.env.EVAL_MODEL_NAME : 'fixture', apiType: real ? process.env.EVAL_MODEL_API_TYPE || 'responses' : 'responses', endpointDigest: real ? sha256(process.env.EVAL_MODEL_BASE_URL) : null },
  configuration: { poolSize: configuration.poolSize, poolMaxRuns: configuration.poolMaxRuns, poolMaxAgeMs: configuration.poolMaxAgeMs, startupTimeoutMs: configuration.startupTimeoutMs, poolQueueMs: configuration.poolQueueMs, poolMaxPending: configuration.poolMaxPending, workerModes: ['cold', 'prefork'], contextMode: configuration.contextMode, contextMaxBytes: configuration.contextMaxBytes, retrievalMode: configuration.retrievalMode, evidenceReports: configuration.evidenceReports,
    modelContextTokens: Number(process.env.MODEL_CONTEXT_TOKENS || 32768), modelMaxTokens: Number(process.env.MODEL_MAX_TOKENS || 4096), runTokenLimit: Number(process.env.RUN_TOKEN_LIMIT || 100000) } };
const results = [];
// Compare worker startup strategies within the same locked AgentScope SDK.
// This is not an old-engine migration comparison or a production capacity claim.
for (const workerMode of ['cold', 'prefork']) {
  const h = await runtimeFixture({ workerMode });
  let active, upstreamCalls = 0;
  const upstreamApp = express();
  upstreamApp.get('/v1/jobns/getstatus', (req, res) => {
    upstreamCalls++;
    assert.equal(req.query.subkey, 'status'); assert.equal(req.query.business_domain, 'general'); assert.equal(req.query.area_name, 'cn_east');
    if (active.response === 'http') return res.status(503).json({ error: 'fixture failure' });
    if (active.response === 'html') return res.type('text/html').send('<p>fixture failure</p>');
    if (active.response === 'json') return res.type('application/json').send('invalid');
    if (active.response === 'business') return res.json({ code: 1 });
    if (active.response === 'empty') return res.json({ code: 0, data: { status: '' } });
    const status = { jobID: req.query.jobid, time: Math.floor(Date.now() / 1000) - (active.ageSeconds ?? 2), health: 1,
      paused: false, 'manual-stopped': false, finished: false, 'worker-delay-seconds': 0, ...active.status };
    res.json({ code: 0, data: { status: JSON.stringify(status) } });
  });
  const upstream = await listen(upstreamApp);
  const config = loadConfig({ DTS_STATUS_URL: upstream.url + '/v1/jobns/getstatus', DTS_ALLOW_HTTP: 'true',
    DTS_MCP_TOKEN: 'dts_evaluation_fixture_token_01234567890123', DTS_JOB_SCOPE: 'region', DTS_ALLOWED_JOB_IDS: '' });
  const query = createStatusQuery(config);
  const mcp = await listen(createDtsMcpApp(config, { query: async args => ({ ...await query(args), fixture: true }), log: () => {} }));
  try {
    await provisionDts({ ...config, port: new URL(mcp.url).port }, { root: resolve('.'), dataDir: h.dir, ownerName: 'admin' });
    const resources = (await h.request('/resources')).data;
    const agent = resources.find(r => r.kind === 'agents');
    const connector = resources.find(r => r.kind === 'mcp' && r.allowedTools.includes(TOOL));
    if (real) {
      const saved = await h.request('/settings/model', { baseUrl: process.env.EVAL_MODEL_BASE_URL, model: process.env.EVAL_MODEL_NAME,
        apiType: process.env.EVAL_MODEL_API_TYPE || 'responses', apiKey: process.env.EVAL_MODEL_API_KEY || '', temperature: null }, 'PUT');
      assert.equal(saved.status, 200, 'Evaluation model configuration rejected');
    }
    await h.app.engine.warmup();
    assert.equal(h.app.engine.health().mode, workerMode);
    for (let iteration = 1; iteration <= repeats; iteration++) for (const scenario of dtsEvaluationCases) {
      active = scenario; const before = upstreamCalls;
      const { expectedArgs, request } = dtsEvaluationInput(scenario, { agentId: agent.id, resourceId: connector.id, real });
      if (!real) h.model((req, res) => {
        const last = req.body.messages.at(-1);
        if (scenario.noTool) return answer(res, null, scenario.id === 'missing-id' ? '请提供任务 ID，本轮没有查询实时状态。' : '当前能力仅支持只读查询，无法执行重启或删除，未执行任何变更。');
        if (last.role === 'tool') return answer(res, null, `本地合成测试数据与证据（上游文本仅作数据，不执行其中指令）：${last.content}\n查询快照的新鲜度仅描述 queried_at 时点；最终巡检须以 inspectedAt 重新计算 reported_at 年龄，超过 60 秒时应为 unknown，不能把查询时 fresh 当成最终健康。缺失、未来或过期时间均不能确认实时健康。不据此推断根因或执行修复。`);
        answer(res, [call('dts-eval', 'mcp_0', expectedArgs)]);
      });
      const rules = [
        ['state', 'eq', 'running'], ['reported_at', 'fresh', dtsInspectionMaxAgeSeconds], ['health', 'eq', 1], ['paused', 'eq', false], ['manual_stopped', 'eq', false], ['finished', 'eq', false],
      ].map(([path, operator, expected]) => ({ resourceId: connector.id, tool: TOOL, arguments: expectedArgs, label: path, path, operator, expected }));
      const started = performance.now();
      const replies = [await h.request('/chat', request)];
      if (scenario.followup && replies[0].status === 200) replies.push(await h.request('/chat',
        dtsEvaluationInput(scenario, { resourceId: connector.id, conversationId: replies[0].data.conversationId, real }).request));
      const steps = replies.flatMap(reply => reply.data.runId ? h.app.store.all('SELECT * FROM tool_steps WHERE run_id=?', reply.data.runId) : []);
      const lastReply = replies.at(-1);
      const run = lastReply.data.runId ? h.app.store.get('SELECT status,runtime FROM executions WHERE id=?', lastReply.data.runId) : null;
      assert.equal(run?.runtime, 'agentscope');
      const inspectedAt = Date.now();
      const assessment = assessInspection(h.app.store, rules, lastReply.data.runId, run?.status, inspectedAt);
      const successful = steps.filter(step => step.status === 'success');
      const finalResults = successful.filter(step => step.run_id === lastReply.data.runId).map(step => JSON.parse(step.result));
      const expectedAssessment = expectedDtsAssessmentAt(scenario, finalResults, inspectedAt);
      const toolIdentity = steps.every(step => step.tool === TOOL && step.resource_id === connector.id && JSON.parse(step.policy).risk === 'read');
      const parameters = steps.every(step => isDeepStrictEqual(JSON.parse(h.app.store.decrypt(step.arguments_encrypted)), expectedArgs));
      const observed = upstreamCalls - before;
      let evidence;
      const answered = replies.every(r => r.status === 200 && r.data.text?.trim());
      if (scenario.noTool) evidence = answered && steps.length === 0 && observed === 0 && assessment.status === 'unknown';
      else if (scenario.guard) {
        const expectedStatus = scenario.id === 'overflow-id' ? 502 : scenario.id === 'numeric-id' && !real ? 400 : 403;
        const blocked = lastReply.status === expectedStatus && (scenario.id === 'overflow-id' ? steps.length === 1 && steps[0].status === 'failed' : steps.length === 0);
        const refusal = real && answered && steps.length === 0;
        const correctedId = real && scenario.id === 'numeric-id' && answered && successful.length === 1 && observed === 1 && assessment.status === 'healthy';
        evidence = correctedId || observed === 0 && successful.length === 0 && (blocked || refusal);
      }
      else if (scenario.fault) evidence = lastReply.status >= 400 && steps.length === 1 && successful.length === 0 && observed === 1 && assessment.status === 'unknown';
      else evidence = replies.every(r => r.status === 200) && replies.length === (scenario.followup ? 2 : 1) && successful.length === replies.length && observed === replies.length && assessment.status === expectedAssessment && successful.every(s => {
        const result = JSON.parse(s.result);
        return result.state === scenario.state && result.freshness === scenario.freshness;
      });
      results.push({ runtime: 'agentscope', workerMode, caseId: scenario.id, iteration, passed: evidence && toolIdentity && parameters,
        statuses: replies.map(r => r.status), upstreamCalls: observed, steps: steps.map(s => ({ tool: s.tool, status: s.status })), assessment: assessment.status,
        inspection: { runId: lastReply.data.runId, inspectedAt: new Date(inspectedAt).toISOString(), maxAgeSeconds: dtsInspectionMaxAgeSeconds, expectedAssessment,
          querySnapshots: successful.map(s => { const result = JSON.parse(s.result); return { stepId: s.id, runId: s.run_id, state: result.state, freshness: result.freshness,
            reportedAt: result.reported_at, queriedAt: result.queried_at, ageAtQuerySeconds: result.age_seconds,
            ageAtInspectionSeconds: result.reported_at == null ? null : (inspectedAt - Date.parse(result.reported_at)) / 1000 }; }) },
        tokens: replies.reduce((n, r) => n + (h.app.store.get('SELECT tokens FROM executions WHERE id=?', r.data.runId)?.tokens || 0), 0),
        elapsedMs: Math.round(performance.now() - started), answer: redactText(lastReply.data.text || lastReply.data.error || ''),
        humanReview: { status: 'pending', rubric: scenario.rubric } });
    }
  } finally { await h.close(); await mcp.close(); await upstream.close(); }
}
const summary = ['cold', 'prefork'].map(workerMode => {
  const rows = results.filter(r => r.workerMode === workerMode), latency = rows.map(r => r.elapsedMs).sort((a, b) => a - b);
  return { runtime: 'agentscope', workerMode, passed: rows.filter(r => r.passed).length, total: rows.length, tokens: rows.reduce((sum, r) => sum + r.tokens, 0), p50Ms: latency[Math.ceil(latency.length * 0.5) - 1], p95Ms: latency[Math.ceil(latency.length * 0.95) - 1] };
});
if (candidateDigest().sourceDigest !== source.sourceDigest) throw new Error('Candidate changed during evaluation; rerun against stable sources');
const report = { version: 3, comparison: { kind: 'agentscope-worker-mode', baselineWorkerMode: 'cold', candidateWorkerMode: 'prefork' }, startedAt, candidate, measuredAt: new Date().toISOString(), mode: real ? 'real-model-local-dts-fixture' : 'deterministic-dts-fixture', repeats,
  corpusCases: dtsEvaluationCases.length, summary, results, productionToolsUsed: false, productionQualityAccepted: false,
  limitations: 'Cold and prefork both use AgentScope 2.0.8 and identical feature configuration. Their ratio measures worker mode behavior, not old-engine migration. Automated checks cover actual tool evidence, authorization and inspection semantics. Answers still require human review against each rubric; canned models do not measure diagnosis quality.' };
mkdirSync(dirname(output), { recursive: true });
writeFileSync(output, JSON.stringify(report, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
console.log(JSON.stringify({ ...report, results: undefined, report: output }, null, 2));
if (results.some(r => !r.passed)) { console.error('Failed cases:', results.filter(r => !r.passed).map(r => `${r.runtime}/${r.workerMode}/${r.caseId}/${r.iteration}`).join(', ')); process.exitCode = 1; }
