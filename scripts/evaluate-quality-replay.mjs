import assert from 'node:assert/strict';
import express from 'express';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import { runtimeFixture, answer, call } from '../tests/runtime-fixture.mjs';
import { listen } from '../tests/fixtures.mjs';
import { loadConfig, createStatusQuery, createDtsMcpApp, TOOL } from '../integrations/dts-mcp/adapter.mjs';
import { provisionDts } from '../integrations/dts-mcp/provision.mjs';
import { candidateDigest, root, sha256 } from './agent-candidate.mjs';
import { qualityCorpusDigest, validateCorpus } from './agent-quality-corpus.mjs';
import { qualityReplayCases, replayPromptDigest, sanitizeReplayAnswer, validateQualityReplayCases } from './quality-replay-cases.mjs';

const usage = 'Usage: node scripts/evaluate-quality-replay.mjs --out FILE [--real]';
const argv = process.argv.slice(2);
let real = false, output;
for (let i = 0; i < argv.length; i++) {
  if (argv[i] === '--real' && !real) real = true;
  else if (argv[i] === '--out' && !output && argv[i + 1] && !argv[i + 1].startsWith('--')) output = resolve(argv[++i]);
  else throw new Error(usage);
}
if (!output) throw new Error(usage);
if (existsSync(output)) throw new Error('Output report already exists');
if (real && (!process.env.EVAL_MODEL_BASE_URL || !process.env.EVAL_MODEL_NAME)) throw new Error('--real requires EVAL_MODEL_BASE_URL and EVAL_MODEL_NAME');
const apiType = real ? process.env.EVAL_MODEL_API_TYPE || 'responses' : 'responses';
if (!['responses'].includes(apiType)) throw new Error('Unsupported EVAL_MODEL_API_TYPE');
const maxTokens = Number(process.env.MODEL_MAX_TOKENS || 512);
if (!Number.isSafeInteger(maxTokens) || maxTokens < 1 || maxTokens > 512) throw new Error('MODEL_MAX_TOKENS must be 1–512 for this replay');
process.env.MODEL_MAX_TOKENS = String(maxTokens);
process.env.MAX_MCP_CALLS = '1';

const source = candidateDigest();
const corpus = validateCorpus(JSON.parse(readFileSync(resolve(root, 'tests/quality-cases.json'), 'utf8')));
validateQualityReplayCases(qualityReplayCases, corpus);
const corpusHash = qualityCorpusDigest(corpus);
const replayHash = sha256(JSON.stringify(qualityReplayCases));
const startedAt = new Date().toISOString();
const model = { name: real ? process.env.EVAL_MODEL_NAME : 'controlled-fixture', apiType,
  endpointDigest: real ? sha256(process.env.EVAL_MODEL_BASE_URL) : null };
const results = [];

let h, upstream, mcp, active, workError;
const upstreamRequests = [];
try {
  h = await runtimeFixture({ workerMode: 'prefork' });
  const upstreamApp = express();
  upstreamApp.get('/v1/jobns/getstatus', (req, res) => {
    const args = { jobid: String(req.query.jobid || ''), business_domain: String(req.query.business_domain || ''),
      area_name: String(req.query.area_name || ''), subkey: String(req.query.subkey || '') };
    upstreamRequests.push(args);
    if (!active || args.subkey !== 'status') return res.status(400).json({ code: 1 });
    res.json({ code: 0, data: { status: JSON.stringify({ jobID: args.jobid, time: Math.floor(Date.now() / 1000) - 2,
      health: 1, paused: false, 'manual-stopped': false, finished: false, 'worker-delay-seconds': 0 }) } });
  });
  upstream = await listen(upstreamApp);
  const config = loadConfig({ DTS_STATUS_URL: upstream.url + '/v1/jobns/getstatus', DTS_ALLOW_HTTP: 'true',
    DTS_MCP_TOKEN: 'quality_replay_fixture_token_01234567890123', DTS_JOB_SCOPE: 'allowlist',
    DTS_ALLOWED_JOB_IDS: qualityReplayCases.map(item => item.jobid).join(',') });
  const query = createStatusQuery(config);
  mcp = await listen(createDtsMcpApp(config, { query: async args => ({ ...await query(args), fixture: true }), log: () => {} }));
  await provisionDts({ ...config, port: new URL(mcp.url).port }, { root, dataDir: h.dir, ownerName: 'admin' });
  const resources = (await h.request('/resources')).data;
  const agent = resources.find(item => item.kind === 'agents' && item.name === 'DTS cn_east 运维');
  const connector = resources.find(item => item.kind === 'mcp' && item.allowedTools.includes(TOOL));
  assert.ok(agent && connector, 'Temporary DTS resources missing');
  if (real) {
    const saved = await h.request('/settings/model', { baseUrl: process.env.EVAL_MODEL_BASE_URL,
      model: process.env.EVAL_MODEL_NAME, apiType, apiKey: process.env.EVAL_MODEL_API_KEY || '', temperature: null }, 'PUT');
    assert.equal(saved.status, 200, 'Evaluation model configuration rejected');
  }
  await h.app.engine.warmup();
  assert.equal(h.app.engine.health().mode, 'prefork');

  for (const item of qualityReplayCases) {
    active = item;
    const before = upstreamRequests.length;
    const modelBefore = h.requests.length;
    const expectedArgs = { jobid: item.jobid, business_domain: 'general', area_name: item.areaName };
    if (!real) h.model((req, res) => {
      if (item.kind === 'cross_area') return answer(res, null, '目标区域不在授权范围内，本轮没有查询实时状态。');
      const last = req.body.messages.at(-1);
      if (last?.role === 'tool') {
        const result = JSON.parse(last.content).structuredContent;
        assert.ok(result?.fixture === true && result.jobid === item.jobid && result.reported_at && result.queried_at,
          'Controlled answer requires this round\'s successful DTS result');
        return answer(res, null, `本机合成回放：已查询确认的任务 ${result.jobid}（general / cn_east）。状态：${result.state}；上报时间：${result.reported_at}；查询时间：${result.queried_at}；新鲜度：${result.freshness}。本轮只读数据不用于判断生产状态或故障根因。`);
      }
      return answer(res, [call(`quality-replay-${item.kind}`, 'mcp_0', expectedArgs)]);
    });
    const started = performance.now();
    const response = await h.request('/chat', { text: item.prompt, agentId: agent.id,
      targetBinding: { resourceId: connector.id, tool: TOOL, environment: 'production', arguments: expectedArgs } });
    const run = response.data?.runId ? h.app.store.get('SELECT status,runtime,tokens FROM executions WHERE id=?', response.data.runId) : null;
    const steps = response.data?.runId ? h.app.store.all('SELECT * FROM tool_steps WHERE run_id=?', response.data.runId) : [];
    const calls = upstreamRequests.slice(before);
    const modelRequests = real ? null : h.requests.length - modelBefore;
    let actualArgs = null, snapshot = null;
    if (steps.length === 1 && steps[0].status === 'success') {
      actualArgs = JSON.parse(h.app.store.decrypt(steps[0].arguments_encrypted));
      snapshot = JSON.parse(steps[0].result);
    }
    const exactStep = steps.length === 1 && steps[0].tool === TOOL && steps[0].resource_id === connector.id &&
      JSON.parse(steps[0].policy).risk === 'read' && isDeepStrictEqual(actualArgs, expectedArgs);
    const exactUpstream = calls.length === 1 && isDeepStrictEqual(calls[0], { ...expectedArgs, subkey: 'status' });
    const preflightReasonMatched = item.kind === 'cross_area' && response.data?.error === '工具参数 area_name 超出授权范围';
    const boundaryHeld = item.kind === 'read' ? exactStep && exactUpstream :
      preflightReasonMatched && calls.length === 0 && steps.length === 0 && run?.tokens === 0 &&
      (real || modelRequests === 0);
    const answerText = response.data?.text || '';
    const automaticEvidencePassed = item.kind === 'read'
      ? response.status === 200 && run?.status === 'success' && run.runtime === 'agentscope' && boundaryHeld &&
        snapshot?.fixture === true && snapshot.jobid === item.jobid && snapshot.state === 'running' &&
        snapshot.freshness === 'fresh' && !!snapshot.reported_at && !!snapshot.queried_at && !!answerText.trim()
      : response.status === 403 && run?.status === 'failed' && run.runtime === 'agentscope' && boundaryHeld;
    results.push({ caseId: item.caseId, origin: item.origin, reconstructedPromptDigest: replayPromptDigest(item),
      testedStage: item.kind === 'cross_area' ? 'authorization_preflight' : 'tool_execution',
      httpStatus: response.status, runStatus: run?.status || null, elapsedMs: Math.round(performance.now() - started),
      tokens: run?.tokens ?? null, modelRequests, upstreamCalls: calls.length,
      toolSteps: steps.map(step => ({ tool: step.tool, status: step.status })),
      preflightReasonMatched, boundaryHeld, automaticEvidencePassed,
      querySnapshot: snapshot ? { state: snapshot.state, freshness: snapshot.freshness,
        reportedAt: snapshot.reported_at, queriedAt: snapshot.queried_at } : null,
      answer: sanitizeReplayAnswer(answerText || response.data?.error), humanReview: 'pending' });
  }
} catch (error) {
  workError = error;
} finally {
  const cleanup = await Promise.allSettled([h?.close(), mcp?.close(), upstream?.close()]);
  if (workError) throw workError;
  const failures = cleanup.filter(item => item.status === 'rejected');
  if (failures.length) throw new AggregateError(failures.map(item => item.reason), 'Quality replay cleanup failed');
}

if (candidateDigest().sourceDigest !== source.sourceDigest ||
    qualityCorpusDigest(validateCorpus(JSON.parse(readFileSync(resolve(root, 'tests/quality-cases.json'), 'utf8')))) !== corpusHash ||
    sha256(JSON.stringify(qualityReplayCases)) !== replayHash) throw new Error('Candidate or replay corpus changed during evaluation');
const report = { version: 1, mode: real ? 'real-model-local-dts-replay' : 'controlled-model-local-dts-replay',
  startedAt, measuredAt: new Date().toISOString(), candidate: { ...source, qualityCorpusDigest: corpusHash, replayDigest: replayHash,
    model, workerMode: 'prefork', modelMaxTokens: maxTokens }, reconstructedPrompts: true,
  results, automaticEvidenceComplete: results.every(item => item.automaticEvidencePassed), humanReviewComplete: false,
  productionToolsUsed: false, productionAccepted: false,
  limitations: ['Both prompts are reconstructed from sanitized summaries and use synthetic task IDs; they are not the original user messages.',
    'Only the model can be external. The temporary DTS MCP, upstream and database contain no production task data.',
    'The cross-area case is denied before model invocation; it does not replay the historical model target-substitution failure.',
    'Automated tool evidence does not grade answer quality; human review remains pending and this report is not the 30-case acceptance gate.'] };
mkdirSync(dirname(output), { recursive: true });
writeFileSync(output, JSON.stringify(report, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
console.log(JSON.stringify({ report: output, mode: report.mode, passed: results.filter(item => item.automaticEvidencePassed).length,
  total: results.length, humanReviewComplete: false, productionAccepted: false }, null, 2));
process.exitCode = report.automaticEvidenceComplete ? 2 : 1;
