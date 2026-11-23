import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';

if (process.argv.length > 2) {
  console.error('本实验不接受参数或真实模式；请直接运行 npm run agent:learn:trace。');
  process.exitCode = 1;
} else {
  await main().catch(() => { console.error('观测实验无法完成，请核对 Node、Python 与锁定 SDK。'); process.exitCode = 1; });
}

async function main() {
  const root = fileURLToPath(new URL('..', import.meta.url));
  const output = join(root, 'test-results/learning');
  const sourceFiles = ['scripts/learn-agent-trace.mjs', 'tests/runtime-fixture.mjs', 'tests/fixtures.mjs',
    'server/app.mjs', 'server/agent.mjs', 'server/agent-trace.mjs', 'server/model.mjs', 'server/model-stream.mjs',
    'server/mcp.mjs', 'server/execution.mjs', 'server/governance.mjs', 'server/security.mjs', 'server/store.mjs', 'server/resources.mjs',
    'server/agent-runtime/index.mjs', 'server/agent-runtime/driver.mjs', 'server/agent-runtime/agentscope.mjs',
    'server/agent-runtime/pool.mjs', 'server/agent-runtime/protocol.mjs', 'agent-worker/worker.py',
    'agent-worker/pyproject.toml', 'agent-worker/uv.lock'].sort();
  const fingerprint = () => {
    const files = sourceFiles.map(file => ({ file, sha256: createHash('sha256').update(readFileSync(join(root, file))).digest('hex') }));
    return { files, digest: createHash('sha256').update(files.map(f => `${f.file}\0${f.sha256}\n`).join('')).digest('hex') };
  };
  const scenarios = [
    { id: 'model-wait', title: '模型端等待', delayedKind: 'model', business: 'healthy', toolError: false },
    { id: 'tool-wait', title: '工具端等待', delayedKind: 'tool', business: 'healthy', toolError: false },
    { id: 'tool-error', title: '只读工具返回错误', delayedKind: null, business: null, toolError: true },
    { id: 'completed-degraded', title: '查询完成但合成业务异常', delayedKind: null, business: 'degraded', toolError: false },
  ];
  const report = { version: 1, command: 'npm run agent:learn:trace', mode: 'deterministic-fixture',
    runtime: 'agentscope', sdkVersion: '2.0.8', workerMode: 'prefork', startedAt: new Date().toISOString(),
    completedAt: null, source: fingerprint(), sourceUnchanged: false, passed: false, results: [], failures: [],
    realModelUsed: false, productionAccepted: false, realModelQualityAccepted: false, realCost: null,
    isolation: '每组独立临时SQLite、127.0.0.1模型/MCP、test环境、仅service_status只读策略、无真实通知',
    limitations: [
      '模型决策和每次成功响应30 tokens均预设；真实SDK证明编排兼容，不证明模型质量。',
      '160ms为本地注入等待，实际耗时受机器调度影响；只断言对应节点覆盖观察器等待，不推导供应商性能或最慢阶段。',
      'fixtureObservation的业务状态和reportedAt来自本地观察器，未从trace推导；trace没有工具正文或业务快照时间。',
      'trace.finishedAt表示处理结束，不能替代业务reportedAt；执行完成不等于业务健康、新鲜或已通过巡检规则。',
      '固定tokens仅核对计数，真实费用null；没有供应商价格、缓存计费或账单证据。',
      '节点耗时有包含与重叠关系，不把全部节点相加当总耗时；本实验不覆盖排队、审批或跨请求指标。',
      '报告保存实际脱敏trace和结构计数，不保存完整提示、候选、工具正文、凭据或私有推理。',
      '正常收尾与初始化成功后捕获异常清理本轮临时资源；初始化中断/强制退出清理未经验证。',
    ] };
  const environment = {
    NODE_ENV: 'test', AUTH_MODE: 'local', COOKIE_SECURE: 'false', APP_ORIGIN: '', TRUST_PROXY: '',
    MASTER_KEY_FILE: '', ADMIN_USERNAME: '', ADMIN_PASSWORD: '', SETUP_TOKEN: '',
    MODEL_BASE_URL: '', MODEL_NAME: '', MODEL_API_KEY: '', MODEL_API_TYPE: 'responses',
    MODEL_DATA_POLICY: 'redact', MODEL_PRICE_PER_MILLION: '0', DAILY_COST_LIMIT: '0', OUTBOUND_ALLOWED_ORIGINS: '',
    NOTIFICATION_WEBHOOK_URL: '', NOTIFICATION_WEBHOOK_SECRET: '', ENABLE_AUTO_REMEDIATION: 'false',
    AGENT_RUNTIME: 'agentscope', AGENTSCOPE_AGENT_IDS: '', AGENTSCOPE_WORKER_MODE: 'prefork',
    RUN_TOKEN_LIMIT: '100000', DAILY_TOKEN_LIMIT: '1000000', WORKSPACE_DAILY_TOKEN_LIMIT: '10000000',
    DAILY_RUN_LIMIT: '200', RUNS_PER_MINUTE: '20', MODEL_CONTEXT_TOKENS: '32768', MODEL_MAX_TOKENS: '4096',
    RUN_TIMEOUT_MS: '120000', MAX_ACTIVE_RUNS: '2', MAX_USER_RUNS: '2', MAX_PENDING_RUNS: '100',
  };
  const previous = new Map(Object.keys(environment).map(key => [key, process.env[key]]));
  Object.assign(process.env, environment);
  try {
    const { default: express } = await import('express');
    const { z } = await import('zod');
    const { McpServer } = await import('@modelcontextprotocol/sdk/server/mcp.js');
    const { StreamableHTTPServerTransport } = await import('@modelcontextprotocol/sdk/server/streamableHttp.js');
    const { runtimeFixture, answer, call } = await import('../tests/runtime-fixture.mjs');
    const { listen } = await import('../tests/fixtures.mjs');
    const { runtimeOptions } = await import('../server/agent-runtime/index.mjs');
    const { defaultPython } = await import('../server/agent-runtime/agentscope.mjs');
    const { validateEnvironment } = await import('../server/security.mjs');
    validateEnvironment();
    const runtime = runtimeOptions({ runtime: 'agentscope', python: defaultPython, workerMode: 'prefork',
      contextMode: 'recent', retrievalMode: 'ranked', evidenceReports: false, contextMaxBytes: 16000,
      poolSize: 1, poolMaxRuns: 100, poolMaxAgeMs: 1800000, startupTimeoutMs: 15000, poolQueueMs: 30000, poolMaxPending: 100 });
    for (const scenario of scenarios) {
      const row = { id: scenario.id, title: scenario.title, scenarioMatched: false, actual: null, failure: null };
      report.results.push(row);
      let h, endpoint, phase = '初始化';
      const observer = { toolCalls: 0, target: null, business: scenario.business,
        reportedAt: new Date(Date.now() - (scenario.business === 'degraded' ? 120000 : 0)).toISOString(),
        toolReturnedAt: null, injectedWait: null };
      const pause = async () => {
        const start = Date.now();
        await new Promise(resolve => setTimeout(resolve, 160));
        observer.injectedWait = { kind: scenario.delayedKind, requestedMs: 160, startedAt: new Date(start).toISOString(),
          finishedAt: new Date().toISOString(), observedMs: Date.now() - start };
      };
      try {
        const app = express(); app.use(express.json());
        app.post('/mcp', async (req, res) => {
          const server = new McpServer({ name: 'trace-learning-fixture', version: '1.0.0' });
          server.registerTool('service_status', { description: '只读查询本地合成状态', inputSchema: { service: z.string() } }, async ({ service }) => {
            observer.toolCalls++; observer.target = service;
            if (scenario.delayedKind === 'tool') await pause();
            observer.toolReturnedAt = new Date().toISOString();
            return { isError: scenario.toolError, content: [{ type: 'text', text: JSON.stringify({
              service, status: scenario.business, reportedAt: observer.reportedAt, marker: 'PRIVATE_TRACE_TOOL_BODY',
            }) }] };
          });
          const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
          res.on('close', () => { void transport.close(); void server.close(); });
          try { await server.connect(transport); await transport.handleRequest(req, res, req.body); }
          catch { if (!res.headersSent) res.sendStatus(500); }
        });
        app.get('/mcp', (req, res) => res.sendStatus(405));
        app.delete('/mcp', (req, res) => res.sendStatus(405));
        endpoint = await listen(app);
        h = await runtimeFixture(runtime);
        const configured = (await h.request('/settings/model')).data;
        assert.equal(new URL(configured.baseUrl).hostname, '127.0.0.1');
        assert.equal(new URL(endpoint.url).hostname, '127.0.0.1');
        phase = '保存只读test策略';
        const resource = await h.request(`/resources/${h.resource.id}`, { ...h.resource, name: 'trace-local-readonly',
          endpoint: endpoint.url + '/mcp', token: '', environment: 'test', allowedTools: ['service_status'],
          toolPolicies: { service_status: { risk: 'read', roles: ['admin'], environments: ['test'], constraints: { service: ['billing'] } } } }, 'PUT');
        assert.equal(resource.status, 200);
        await h.app.engine.warmup();
        let modelRound = 0;
        h.model(async (req, res) => {
          modelRound++;
          if (scenario.delayedKind === 'model' && modelRound === 1) await pause();
          answer(res, modelRound === 1 ? [call('trace-lab-call')] : undefined, modelRound === 1 ? '' : 'PRIVATE_TRACE_CANDIDATE');
        });
        phase = '执行与持久回读';
        const input = { text: 'PRIVATE_TRACE_QUESTION：只读查询billing状态并说明证据边界。', useKnowledge: false, requestKey: `trace-lab-${scenario.id}` };
        const response = await h.request('/chat', input);
        assert.equal(response.status, scenario.toolError ? 502 : 200);
        const run = h.app.store.get('SELECT id,status,tokens,runtime,runtime_version,conversation_id FROM executions WHERE request_key=?', input.requestKey);
        const saved = (await h.request(`/conversations/${run.conversation_id}`)).data.messages.at(-1);
        const trace = saved.metadata.executionTrace;
        const steps = h.app.store.all('SELECT id,tool,status,environment FROM tool_steps WHERE run_id=? ORDER BY created,rowid', run.id);
        const models = trace.nodes.filter(n => n.kind === 'model'), tools = trace.nodes.filter(n => n.kind === 'tool');
        assert.equal(run.runtime, 'agentscope'); assert.equal(run.runtime_version, '2.0.8/bridge-v2-prefork');
        assert.equal(run.status, scenario.toolError ? 'failed' : 'success');
        assert.equal(trace.status, scenario.toolError ? 'error' : 'completed');
        assert.equal(h.requests.length, scenario.toolError ? 1 : 2); assert.equal(modelRound, h.requests.length);
        assert.equal(models.length, h.requests.length); assert.equal(observer.toolCalls, 1); assert.equal(h.fixtures.toolCalls.length, 0);
        assert.equal(steps.length, 1); assert.equal(steps[0].tool, 'service_status'); assert.equal(steps[0].environment, 'test');
        assert.equal(steps[0].status, scenario.toolError ? 'failed' : 'success');
        assert.equal(tools.length, 1); assert.equal(tools[0].status, scenario.toolError ? 'error' : 'completed');
        assert.equal(observer.target, 'billing');
        const details = node => Object.fromEntries((node.details || []).map(d => [d.label, d.value]));
        assert.equal(run.tokens, h.requests.length * 30);
        assert.deepEqual(models.map(n => details(n)['模型']), h.requests.map(r => r.model));
        assert.deepEqual(models.map(n => details(n)['用量']), models.map(() => '30 tokens'));
        const ids = new Set(trace.nodes.map(n => n.id)); assert.equal(ids.size, trace.nodes.length);
        assert.ok(trace.nodes.length <= 200 && trace.edges.length <= 400);
        assert.ok(trace.nodes.every(n => n.status !== 'running' && Number.isFinite(n.durationMs) && n.durationMs >= 0));
        assert.ok(trace.edges.every(e => ids.has(e.from) && ids.has(e.to)));
        assert.ok(trace.edges.some(e => e.from === models[0].id && e.to === tools[0].id));
        if (models[1]) assert.ok(trace.edges.some(e => e.from === tools[0].id && e.to === models[1].id));
        const delayed = scenario.delayedKind === 'model' ? models[0] : scenario.delayedKind === 'tool' ? tools[0] : null;
        if (delayed) assert.ok(delayed.durationMs >= observer.injectedWait.observedMs - 5, '节点耗时必须覆盖实际注入等待');
        const serialized = JSON.stringify(trace);
        for (const forbidden of ['PRIVATE_TRACE_', 'fixture-model-secret', 'fixture-mcp-secret', observer.reportedAt]) assert.ok(!serialized.includes(forbidden));
        if (!scenario.toolError) {
          assert.deepEqual(response.data.metadata.executionTrace, trace);
          const encrypted = h.app.store.get('SELECT response_encrypted FROM tool_steps WHERE id=?', steps[0].id).response_encrypted;
          const stored = JSON.parse(JSON.parse(h.app.store.decrypt(encrypted)).content[0].text);
          const feedback = JSON.parse(JSON.parse(h.requests.at(-1).messages.find(m => m.role === 'tool').content).content[0].text);
          assert.deepEqual(feedback, stored);
          assert.equal(stored.status, observer.business); assert.equal(stored.reportedAt, observer.reportedAt);
          assert.equal(stored.service, observer.target);
        }
        assert.deepEqual(h.app.execution.stats(), { active: 0, queued: 0 });
        const initialRequestCount = h.requests.length;
        const replay = await h.request('/chat', input);
        assert.equal(replay.status, scenario.toolError ? 409 : 200);
        assert.equal(h.requests.length, initialRequestCount); assert.equal(observer.toolCalls, 1);
        assert.deepEqual((await h.request(`/conversations/${run.conversation_id}`)).data.messages.at(-1).metadata.executionTrace, trace);
        row.actual = { httpStatus: response.status, run, steps, modelRequests: modelRound, toolCalls: observer.toolCalls,
          fixedTokens: run.tokens, realCost: null, delayedNodeId: delayed?.id ?? null, delayedNodeMs: delayed?.durationMs ?? null,
          fixtureObservation: observer, traceContainsBusinessSnapshotTime: false, replayHttpStatus: replay.status, replayAddedCalls: false, trace };
        row.scenarioMatched = true;
      } catch (error) {
        const line = String(error?.stack || '').match(/learn-agent-trace\.mjs:(\d+):\d+/)?.[1];
        row.failure = `${phase}：${error?.code === 'ERR_ASSERTION' ? '证据断言不符合预期' : '本地实验未完成'}${line ? `（脚本行${line}）` : ''}`;
      } finally {
        if (h) await h.close().catch(() => { row.scenarioMatched = false; row.failure = '临时工作空间清理失败'; });
        if (endpoint) await endpoint.close().catch(() => { row.scenarioMatched = false; row.failure = '临时MCP清理失败'; });
      }
    }
    report.sourceUnchanged = report.source.digest === fingerprint().digest;
    if (!report.sourceUnchanged) report.failures.push('运行期间源码发生变化，请重新运行。');
  } catch { report.failures.push('实验初始化失败，请核对依赖与环境。'); }
  finally {
    for (const [key, value] of previous) { if (value === undefined) delete process.env[key]; else process.env[key] = value; }
    report.completedAt = new Date().toISOString();
    report.summary = { passed: report.results.filter(r => r.scenarioMatched).length, total: scenarios.length };
    report.passed = report.summary.passed === scenarios.length && !report.failures.length;
    mkdirSync(output, { recursive: true });
    writeFileSync(join(output, 'trace-lab.json'), JSON.stringify(report, null, 2) + '\n');
    const rows = ['# 可观测性本地实验', '', `时间：${report.startedAt} 至 ${report.completedAt}；结果 ${report.summary.passed}/${report.summary.total}。`, '',
      '真实SDK 2.0.8/prefork，模型/工具均为本机预设fixture。复现：`npm run agent:learn:trace`。', '',
      '| 场景 | HTTP / run / step / trace | 模型 / 工具 / 固定tokens | 注入等待 / 对应节点ms | 合成业务状态（观察器） |',
      '| --- | --- | --- | --- | --- |',
      ...report.results.map(r => { const a = r.actual; return `| ${r.title} | ${a ? [a.httpStatus,a.run.status,a.steps[0].status,a.trace.status].join(' / ') : r.failure} | ${a ? [a.modelRequests,a.toolCalls,a.fixedTokens].join(' / ') : '未取得'} | ${a?.fixtureObservation.injectedWait?.observedMs ?? '无'} / ${a?.delayedNodeMs ?? '无'} | ${a?.fixtureObservation.business ?? '无有效业务结果'} |`; }), '',
      '每组实际脱敏节点、边、开始/结束和耗时保存在同目录trace-lab.json的results[].actual.trace。fixtureObservation中的reportedAt来自本机观察器，图谱本身没有该字段；不能用trace.finishedAt替代业务时间。', '',
      '失败请求相同幂等键重放返回409，成功请求回读200，两者都不新增模型或工具。查询成功但返回degraded时，run与trace仍成功。工具失败组已有一次模型请求和30固定tokens；失败不意味着零用量。所有真实费用均为null。', '',
      '## 复盘练习', '', '定位注入等待的节点，再核对工具失败的步骤ID与run。分别解释处理结束时间、工具快照时间和业务状态；不要把全部节点耗时相加，也不要用固定tokens编造账单。', '',
      '## 边界', '', ...report.limitations.map(v => `- ${v}`), '',
      `白名单${report.source.files.length}文件，SHA256：\`${report.source.digest}\`；运行期间一致：${report.sourceUnchanged}。`, ''];
    writeFileSync(join(output, 'trace-lab.md'), rows.join('\n'));
  }
  console.log(`可观测性实验 ${report.summary.passed}/${report.summary.total}；真实费用与模型质量未评估。`);
  for (const row of report.results) if (row.failure) console.error(`${row.id}：${row.failure}`);
  for (const failure of report.failures) console.error(failure);
  if (!report.passed) process.exitCode = 1;
}
