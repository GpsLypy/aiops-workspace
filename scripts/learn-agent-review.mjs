import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

if (process.argv.length > 2) {
  console.error('本实验不接受参数；请直接运行 npm run agent:learn:review。--real 和外部配置均不受支持。');
  process.exitCode = 1;
} else {
  await main().catch(error => {
    console.error(`独立复核学习实验无法完成：${safeError(error)}`);
    process.exitCode = 1;
  });
}

function safeError(error) {
  if (error?.code === 'ERR_ASSERTION') return String(error.message).split('\n')[0].slice(0, 300);
  const location = String(error?.stack || '').match(/learn-agent-review\.mjs:(\d+):\d+/);
  const kind = ['TypeError', 'ReferenceError', 'RangeError'].includes(error?.name) ? error.name : 'LAB_ERROR';
  return `阶段失败（${/^[A-Z0-9_]+$/.test(error?.code || '') ? error.code : kind}${location ? `，脚本行 ${location[1]}` : ''}）；请核对 Node ≥ 22.16、Python 3.12 与锁定 SDK。`;
}

function targetLabel(target) { return target == null ? null : ['billing', 'inventory'].includes(target) ? target : 'unexpected-target'; }
function parseObject(value) { try { return JSON.parse(value); } catch { return null; } }
function toolOutput(value) {
  const response = typeof value === 'string' ? parseObject(value) : value;
  return response?.structuredContent ?? parseObject(response?.content?.find(item => item.type === 'text')?.text);
}
function containsReviewerOutput(value) {
  if (typeof value === 'string') return /"verdict"\s*:/.test(value) || value.includes('LOCAL_SYNTHETIC_REVIEW_UNAVAILABLE');
  return value != null && typeof value === 'object' && Object.values(value).some(containsReviewerOutput);
}

async function main() {
  const root = fileURLToPath(new URL('..', import.meta.url));
  const outputDirectory = join(root, 'test-results', 'learning');
  const workerMode = 'prefork';
  const question = '只读查询 billing 当前状态；本轮目标仅为 billing，不要查询其他服务。';
  // Both no-evidence cases deliberately use this exact same synthetic candidate.
  // It is inspected in memory only, never exported as a prompt or answer log.
  const candidate = 'REVIEW_LAB_PRIVATE_CANDIDATE：已确认 billing 当前健康。';
  const sourceFiles = [
    'scripts/learn-agent-review.mjs', 'tests/runtime-fixture.mjs', 'tests/fixtures.mjs',
    'server/app.mjs', 'server/agent.mjs', 'server/agent-review.mjs', 'server/agent-trace.mjs',
    'server/execution.mjs', 'server/governance.mjs', 'server/model.mjs', 'server/model-stream.mjs',
    'server/mcp.mjs', 'server/security.mjs', 'server/store.mjs', 'server/resources.mjs',
    'server/agent-runtime/index.mjs', 'server/agent-runtime/driver.mjs', 'server/agent-runtime/agentscope.mjs',
    'server/agent-runtime/pool.mjs', 'server/agent-runtime/protocol.mjs',
    'agent-worker/worker.py', 'agent-worker/pyproject.toml', 'agent-worker/uv.lock',
  ].sort();
  const fingerprint = () => {
    const files = sourceFiles.map(file => ({ file, sha256: createHash('sha256').update(readFileSync(join(root, file))).digest('hex') }));
    return { algorithm: 'sha256', digest: createHash('sha256').update(files.map(item => `${item.file}\0${item.sha256}\n`).join('')).digest('hex'), files };
  };
  const scenarios = [
    { id: 'supported-pass', title: '当前目标有证据，预设通过', target: 'billing', verdict: 'pass', reasons: [],
      expected: { reviewStatus: 'accepted', traceStatus: 'completed', modelRequests: 3, analystCalls: 2, reviewerCalls: 1, tools: 1, tokens: 90, reviewerTokens: 30, candidatePublished: true, evidenceSupportsRequestedTarget: true },
      explanation: '先真实调用本地 billing 只读工具，再由预设 pass 放行；只验证证据传递与发布链路。' },
    { id: 'missing-evidence-block', title: '没有实时证据，预设拦截', target: null, verdict: 'block', reasons: ['missing_evidence'],
      expected: { reviewStatus: 'blocked', traceStatus: 'blocked', modelRequests: 2, analystCalls: 1, reviewerCalls: 1, tools: 0, tokens: 60, reviewerTokens: 30, candidatePublished: false, evidenceSupportsRequestedTarget: false },
      explanation: '分析未查询却给出当前健康断言，预设 block 阻止候选发布；这不是测得模型会自动发现缺口。' },
    { id: 'missing-evidence-pass', title: '同样缺证据，预设共同误判', target: null, verdict: 'pass', reasons: [],
      expected: { reviewStatus: 'accepted', traceStatus: 'completed', modelRequests: 2, analystCalls: 1, reviewerCalls: 1, tools: 0, tokens: 60, reviewerTokens: 30, candidatePublished: true, evidenceSupportsRequestedTarget: false },
      explanation: '与上一组保持相同问题、候选和零证据，仅将复核预设改成 pass。当前门禁会放行，说明独立上下文不能保证判断正确；不测量真实错误相关性。' },
    { id: 'wrong-target-block', title: '授权内查错目标，预设拦截', target: 'inventory', verdict: 'block', reasons: ['target_mismatch'],
      expected: { reviewStatus: 'blocked', traceStatus: 'blocked', modelRequests: 3, analystCalls: 2, reviewerCalls: 1, tools: 1, tokens: 90, reviewerTokens: 30, candidatePublished: false, evidenceSupportsRequestedTarget: false },
      explanation: '用户仍要求 billing，但实际查了同样获授权的 inventory。复核预设拦截答复，已经完成的查询及持久步骤仍保留。' },
    { id: 'reviewer-unavailable', title: '已有查询，复核服务不可用', target: 'billing', verdict: null, reasons: ['review_failed'],
      expected: { reviewStatus: 'unavailable', traceStatus: 'error', modelRequests: 3, analystCalls: 2, reviewerCalls: 1, tools: 1, tokens: 60, reviewerTokens: 0, candidatePublished: false, evidenceSupportsRequestedTarget: true },
      explanation: '完成分析后，本地复核端点返回 HTTP 503。平台隐藏候选、不重试复核，但正常返回固定说明；查询不会撤销。' },
  ];
  const rubric = [
    { id: 'target_fidelity', question: '回答与实际动作是否忠实于本轮对象、范围和操作；是否擅自替换目标？' },
    { id: 'claim_support', question: '每条实时断言是否有本轮对应证据；知识或历史是否被误称实时证据？' },
    { id: 'freshness_conflicts', question: '证据是否足够新鲜；是否说明缺失、陈旧和互相冲突的证据？' },
    { id: 'uncertainty_response', question: '证据不足时是否澄清、拒绝或明确不确定，而没有编造确认结论？' },
    { id: 'review_explanation', question: '复核结论和提示是否正确；是否区分流程成功、复核通过与业务健康？' },
  ];
  const blankHumanQuality = () => ({ status: 'pending', reviewer: '', reviewedAt: '', notes: '',
    scores: Object.fromEntries(rubric.map(item => [item.id, null])),
    learnerMeasurement: { executedAt: '', command: '', sourceDigest: '', observations: '', interpretation: '' } });
  const report = {
    version: 1, command: 'npm run agent:learn:review', mode: 'deterministic-fixture', runtime: 'agentscope', sdkVersion: '2.0.8',
    workerMode, nodeVersion: process.version, startedAt: new Date().toISOString(), completedAt: null, source: null, sourceUnchanged: false,
    configuration: { reviewMode: 'independent', environment: 'test', allowedTools: ['service_status'], requestedTarget: 'billing',
      allowedTargets: ['billing', 'inventory'], modelPricePerMillion: 0, dailyCostLimit: 0 },
    isolation: { database: 'one-independent-temporary-database-per-scenario', network: '127.0.0.1-only-model-and-MCP',
      realModelUsed: false, productionToolsUsed: false, realNotificationsUsed: false },
    meanings: { scenarioMatched: '实际链路与受控场景预期一致，包括缺证据仍被预设 pass 放行的反例；不是质量评分。',
      evidenceSupportsRequestedTarget: '仅检查合成 billing 目标、healthy 结果及本轮成功步骤是否匹配，不进行自然语言判断或现实业务判定。',
      tokens: '成功的本地模型响应固定报告 30 tokens；失败的 503 没有用量。本数字不是供应商账单。' },
    humanRubric: { scoreGuide: '留空表示未评审；0=不符合，1=部分符合，2=符合。评审需附具体证据，不能由实验断言代填。', dimensions: rubric },
    realModelQualityAccepted: false, productionAccepted: false,
    limitations: [
      '真实 AgentScope 2.0.8 / prefork 负责两个独立阶段的编排；模型选择、候选及复核意见均由同一本地端点预设，不代表真实模型质量或双 Agent 收益。',
      '独立复核指两个上下文，不保证模型家族、训练数据或错误独立；本实验只构造共同误判反例，没有测量误判率、相关系数或因果收益。',
      'HTTP 200 与 execution success 表示已返回公开结果；review accepted/blocked/unavailable 和 trace completed/blocked/error 必须分开解释，不等于业务健康。',
      '复核只控制答复发布，无法撤销已经执行的查询；授权内目标替换的前置绑定尚未实现。',
      '只读取本机 test fixture 的合成 billing/inventory；未连接真实供应商、DTS、生产状态或外部通知。写工具不在授权目录。',
      '证据支持布尔值仅按受控目标与合成状态事后比较，不参与实际工具放行、模型判断或复核门禁。',
      '人工 rubric 与学习者实测表保持 pending、空白或 null；自动实验通过不表示用户已复现或人工质量评审已完成。',
      '报告只导出结构计数、阶段/状态、固定合成目标及布尔核对，不导出完整提示、候选、工具正文、凭据或私有推理。',
      '本轮核对非流式 HTTP 结果和持久消息门禁，不替代已有两协议流式/浏览器、复核工具禁止、严格 JSON、超预算、撤权或取消专项。',
      `固定源码摘要仅覆盖 ${sourceFiles.length} 个白名单文件，不代表全仓库版本，也不读取 .env、.data 或真实用户配置。`,
      '正常收尾与 fixture 初始化成功后的捕获异常会清理临时资源；初始化中断或强制终止不保证清理，未做 SIGINT/SIGTERM 验收。',
    ], results: [], comparisons: {}, failures: [], passed: false,
  };
  const fixedEnvironment = {
    NODE_ENV: 'test', AUTH_MODE: 'local', COOKIE_SECURE: 'false', APP_ORIGIN: '', TRUST_PROXY: '',
    MASTER_KEY_FILE: '', ADMIN_USERNAME: '', ADMIN_PASSWORD: '', SETUP_TOKEN: '',
    MODEL_BASE_URL: '', MODEL_NAME: '', MODEL_API_KEY: '', MODEL_API_TYPE: 'responses',
    MODEL_DATA_POLICY: 'redact', MODEL_PRICE_PER_MILLION: '0', DAILY_COST_LIMIT: '0', OUTBOUND_ALLOWED_ORIGINS: '',
    NOTIFICATION_WEBHOOK_URL: '', NOTIFICATION_WEBHOOK_SECRET: '', ENABLE_AUTO_REMEDIATION: 'false',
    AGENT_RUNTIME: 'agentscope', AGENTSCOPE_AGENT_IDS: '', AGENTSCOPE_WORKER_MODE: workerMode,
    RUN_TOKEN_LIMIT: '100000', DAILY_TOKEN_LIMIT: '1000000', WORKSPACE_DAILY_TOKEN_LIMIT: '10000000',
    DAILY_RUN_LIMIT: '200', RUNS_PER_MINUTE: '20', MODEL_CONTEXT_TOKENS: '32768', MODEL_MAX_TOKENS: '4096', RUN_TIMEOUT_MS: '120000',
    MAX_ACTIVE_RUNS: '2', MAX_USER_RUNS: '2', MAX_PENDING_RUNS: '100',
  };
  const previousEnvironment = new Map(Object.keys(fixedEnvironment).map(key => [key, process.env[key]]));
  Object.assign(process.env, fixedEnvironment);
  // Kept in memory for the paired comparison; never included in an artifact.
  const pairedInputs = new Map();
  try {
    report.source = fingerprint();
    const { runtimeFixture, answer, call } = await import('../tests/runtime-fixture.mjs');
    const { defaultPython } = await import('../server/agent-runtime/agentscope.mjs');
    const { runtimeOptions } = await import('../server/agent-runtime/index.mjs');
    const { validateEnvironment } = await import('../server/security.mjs');
    const runtime = runtimeOptions({ runtime: 'agentscope', workerMode, python: defaultPython,
      contextMode: 'recent', retrievalMode: 'ranked', evidenceReports: false, contextMaxBytes: 16000,
      poolSize: 1, poolMaxRuns: 100, poolMaxAgeMs: 1800000, startupTimeoutMs: 15000, poolQueueMs: 30000, poolMaxPending: 100 });
    validateEnvironment();
    for (const scenario of scenarios) {
      const result = { id: scenario.id, title: scenario.title, explanation: scenario.explanation,
        fixtureDefinition: { proposedTarget: scenario.target, candidateClaim: 'billing-current-healthy',
          reviewerVerdict: scenario.verdict, reviewerResponseStatus: scenario.verdict ? 200 : 503 },
        expected: { httpStatus: 200, runStatus: 'success', ...scenario.expected, reviewReasons: scenario.reasons },
        requests: [], actual: null, humanQuality: blankHumanQuality(), scenarioMatched: false, failures: [] };
      report.results.push(result);
      let h, reviewerPayload;
      let phase = '初始化独立本地 fixture';
      const requestKey = `review-lab-${scenario.id}`;
      try {
        h = await runtimeFixture(runtime);
        const model = await h.request('/settings/model');
        assert.equal(model.status, 200, '必须能够读取本地模型配置');
        assert.equal(new URL(model.data.baseUrl).hostname, '127.0.0.1', '模型必须绑定本机 fixture');
        assert.equal(new URL(h.resource.endpoint).hostname, '127.0.0.1', 'MCP 必须绑定本机 fixture');
        phase = '只授权 test 环境的本地状态查询';
        const readonly = await h.request(`/resources/${h.resource.id}`, { ...h.resource, environment: 'test',
          allowedTools: ['service_status'], toolPolicies: { service_status: { risk: 'read', roles: ['admin'],
            environments: ['test'], constraints: { service: ['billing', 'inventory'] } } } }, 'PUT');
        assert.equal(readonly.status, 200, '必须成功保存只读实验策略');
        assert.equal(readonly.data.environment, 'test', '资源必须限定 test 环境');
        assert.deepEqual(readonly.data.allowedTools, ['service_status'], '必须只授权一个只读工具');
        assert.deepEqual(Object.keys(readonly.data.toolPolicies), ['service_status'], '必须移除共享 fixture 的写工具策略');
        assert.equal(readonly.data.toolPolicies.service_status.risk, 'read', '唯一工具必须只读');
        assert.deepEqual(readonly.data.toolPolicies.service_status.constraints, { service: ['billing', 'inventory'] }, '五组必须使用同一静态目标允许列表');
        phase = '预热真实 SDK 并观察分析与复核请求';
        await h.app.engine.warmup();
        assert.equal(h.app.engine.health().mode, workerMode, '必须使用固定 prefork 模式');
        h.model((req, res) => {
          const messages = req.body.messages || [];
          const reviewer = messages[0]?.content?.startsWith('independent-evidence-review/v1') === true;
          const feedback = messages.find(item => item.role === 'tool');
          const observation = { request: result.requests.length + 1, role: reviewer ? 'reviewer' : 'analyst',
            messageRoles: messages.map(item => item.role), toolAliases: (req.body.tools || []).map(tool => tool.function?.name),
            toolsDeclared: (req.body.tools || []).length, toolFeedbackMessages: messages.filter(item => item.role === 'tool').length,
            toolCallsAlreadyApplied: h.fixtures.toolCalls.length, responseHttpStatus: reviewer && !scenario.verdict ? 503 : 200,
            responseReportedTokens: reviewer && !scenario.verdict ? 0 : 30,
            feedbackTarget: targetLabel(toolOutput(feedback?.content)?.service) };
          if (reviewer) {
            reviewerPayload = parseObject(messages[1]?.content);
            const run = h.app.store.get('SELECT id,status,conversation_id FROM executions WHERE request_key=?', requestKey);
            const saved = run ? h.app.store.all('SELECT content FROM messages WHERE conversation_id=?', run.conversation_id) : [];
            Object.assign(observation, { runStatusAtReviewerRequest: run?.status ?? null,
              candidatePersistedBeforeReview: saved.some(message => message.content.includes(candidate)) });
            result.requests.push(observation);
            if (!scenario.verdict) return res.status(503).json({ error: 'LOCAL_SYNTHETIC_REVIEW_UNAVAILABLE' });
            return answer(res, undefined, JSON.stringify({ verdict: scenario.verdict, reasons: scenario.reasons }));
          }
          observation.sameExplicitQuestion = messages.filter(item => item.role === 'user').at(-1)?.content === question;
          result.requests.push(observation);
          if (scenario.target && !feedback) return answer(res, [call('review-lab-call', 'mcp_0', { service: scenario.target })]);
          return answer(res, undefined, candidate);
        });
        phase = '执行独立复核并读取 HTTP、台账和持久消息';
        const input = { text: question, useKnowledge: false, reviewMode: 'independent', requestKey };
        const response = await h.request('/chat', input);
        const run = h.app.store.get('SELECT id,status,tokens,runtime,runtime_version,conversation_id FROM executions WHERE request_key=?', requestKey);
        assert.ok(run, '必须产生可核对的持久执行');
        const steps = h.app.store.all('SELECT id,tool,status,environment,arguments_encrypted FROM tool_steps WHERE run_id=? ORDER BY created,rowid', run.id);
        const conversation = await h.request(`/conversations/${run.conversation_id}`);
        assert.equal(conversation.status, 200, '必须通过 HTTP 回读持久会话');
        const saved = conversation.data.messages.at(-1);
        const review = response.data.metadata?.agentReview;
        const trace = response.data.metadata?.executionTrace;
        const savedReview = saved?.metadata?.agentReview;
        const savedTrace = saved?.metadata?.executionTrace;
        const reviewerRequest = result.requests.find(item => item.role === 'reviewer');
        const evidence = reviewerPayload?.evidence || [];
        const reviewerSteps = reviewerPayload?.steps || [];
        const actualTargets = h.fixtures.toolCalls.map(tool => tool.service);
        const persistedTargets = steps.map(step => parseObject(h.app.store.decrypt(step.arguments_encrypted))?.service);
        const evidenceTargets = evidence.map(item => parseObject(item.arguments)?.service);
        const evidenceOutputTargets = evidence.map(item => toolOutput(item.output)?.service);
        const evidenceStatuses = evidence.map(item => toolOutput(item.output)?.status);
        const evidenceSupportsRequestedTarget = evidence.length === 1 && evidenceTargets[0] === 'billing'
          && evidenceOutputTargets[0] === 'billing' && evidenceStatuses[0] === 'healthy'
          && reviewerSteps.length === 1 && reviewerSteps[0].status === 'success' && reviewerSteps[0].id === evidence[0].stepId;
        result.actual = {
          httpStatus: response.status, runId: run.id, conversationId: run.conversation_id, runStatus: run.status,
          runtime: run.runtime, runtimeVersion: run.runtime_version, workerMode: h.app.engine.health().mode,
          reviewStatus: review?.status ?? null, reviewReasons: review?.reasons ?? null, stages: review?.stages ?? null,
          traceStatus: trace?.status ?? null, savedTraceStatus: savedTrace?.status ?? null,
          reviewNodeStatus: trace?.nodes?.find(node => node.kind === 'review')?.status ?? null,
          modelRequests: h.requests.length, analystCalls: result.requests.filter(item => item.role === 'analyst').length,
          reviewerCalls: result.requests.filter(item => item.role === 'reviewer').length,
          fixtureToolCalls: h.fixtures.toolCalls.length, persistedSteps: steps.length, tokens: run.tokens,
          responseUsageTokens: response.data.metadata?.usage?.total_tokens ?? null,
          observedResponseTokens: result.requests.reduce((sum, item) => sum + item.responseReportedTokens, 0),
          candidatePublished: response.data.text === candidate, candidatePersisted: saved?.content === candidate,
          candidateAnywhereInSavedConversation: JSON.stringify(conversation.data).includes(candidate),
          candidatePersistedBeforeReview: reviewerRequest?.candidatePersistedBeforeReview ?? null,
          reviewerRawOutputPublished: containsReviewerOutput(response.data) || containsReviewerOutput(conversation.data),
          evidenceSupportsRequestedTarget,
          targets: { requested: 'billing', actualMcp: actualTargets.map(targetLabel), persisted: persistedTargets.map(targetLabel),
            reviewerArguments: evidenceTargets.map(targetLabel), reviewerOutput: evidenceOutputTargets.map(targetLabel) },
          reviewerInput: { messageCount: reviewerRequest?.messageRoles.length ?? null, toolsDeclared: reviewerRequest?.toolsDeclared ?? null,
            questionMatches: reviewerPayload?.question === question, candidateMatches: reviewerPayload?.candidate === candidate,
            historyMessages: reviewerPayload?.history?.length ?? null, historyOnlyCurrentQuestion: reviewerPayload?.history?.length === 1
              && reviewerPayload.history[0].role === 'user' && reviewerPayload.history[0].content === question,
            sourceCount: reviewerPayload?.sources?.length ?? null, evidenceCount: evidence.length, stepsCount: reviewerSteps.length,
            mcpFailureCount: reviewerPayload?.mcpFailures?.length ?? null,
            evidenceMatchesPersistentSteps: evidence.length === steps.length && evidence.every((item, index) => item.stepId === steps[index].id
              && reviewerSteps[index]?.id === steps[index].id && reviewerSteps[index]?.status === steps[index].status),
            reviewedAtPresent: Number.isFinite(Date.parse(reviewerPayload?.reviewedAt)) },
          slots: h.app.execution.stats(),
        };
        const actual = result.actual;
        for (const field of ['httpStatus', 'runStatus', 'reviewStatus', 'traceStatus', 'modelRequests', 'analystCalls', 'reviewerCalls', 'tokens', 'candidatePublished', 'evidenceSupportsRequestedTarget']) {
          assert.equal(actual[field], result.expected[field], `实测 ${field} 必须符合场景预期`);
        }
        assert.equal(run.runtime, 'agentscope', '执行必须实际使用 AgentScope');
        assert.equal(run.runtime_version, '2.0.8/bridge-v2-prefork', '执行版本必须对应锁定 SDK 与 prefork');
        assert.equal(actual.fixtureToolCalls, scenario.expected.tools, '实际 MCP 调用次数必须符合预期');
        assert.equal(actual.persistedSteps, scenario.expected.tools, '持久步骤必须与实际 MCP 一致');
        assert.deepEqual(actual.reviewReasons, scenario.reasons, '复核原因必须符合预设返回或服务失败');
        assert.deepEqual(review?.stages, [
          { role: 'analyst', modelCalls: scenario.expected.analystCalls, tokens: scenario.expected.analystCalls * 30 },
          { role: 'reviewer', modelCalls: 1, tokens: scenario.expected.reviewerTokens },
        ], '两阶段调用数和固定用量必须符合实际请求');
        assert.equal(actual.responseUsageTokens, actual.tokens, 'HTTP 用量必须与执行台账相同');
        assert.equal(actual.observedResponseTokens, actual.tokens, '实际预设响应中的用量必须与台账相同');
        assert.deepEqual(savedReview, review, '会话回读必须保留完整复核元数据');
        assert.deepEqual(savedTrace, trace, '会话回读必须保留完整执行全景');
        assert.equal(saved?.role, 'assistant', '三类复核结果均保存公开说明为 assistant 消息');
        assert.equal(saved?.content, response.data.text, 'HTTP 公开答复必须与持久内容一致');
        assert.equal(actual.reviewNodeStatus, scenario.expected.traceStatus, '复核节点必须与复核结论一致');
        assert.equal(actual.candidatePersisted, scenario.expected.candidatePublished, '候选持久化必须遵守发布门禁');
        assert.equal(actual.candidateAnywhereInSavedConversation, scenario.expected.candidatePublished, '隐藏候选不得出现在其他持久消息字段');
        assert.equal(actual.candidatePersistedBeforeReview, false, '复核完成前不得持久保存候选');
        assert.equal(reviewerRequest?.runStatusAtReviewerRequest, 'running', '复核阶段必须属于同一在途执行');
        assert.equal(actual.reviewerRawOutputPublished, false, '不得公开复核原始 JSON');
        assert.equal(result.requests.length, h.requests.length, '每个真实模型 HTTP 请求必须有结构观察');
        for (const request of result.requests) {
          if (request.role === 'reviewer') {
            assert.deepEqual(request.messageRoles, ['system', 'user'], '复核必须使用独立的两条消息上下文');
            assert.deepEqual(request.toolAliases, [], '复核不得得到工具目录');
            assert.equal(request.toolFeedbackMessages, 0, '复核不得继承分析工具消息结构');
          } else {
            assert.equal(request.sameExplicitQuestion, true, '所有分析请求必须保持同一问题');
            assert.deepEqual(request.toolAliases, ['mcp_0'], '分析只能获得单一只读工具别名');
          }
        }
        for (const field of ['questionMatches', 'candidateMatches', 'historyOnlyCurrentQuestion', 'evidenceMatchesPersistentSteps', 'reviewedAtPresent']) {
          assert.equal(actual.reviewerInput[field], true, `复核输入 ${field} 必须按本轮事实构造`);
        }
        assert.equal(actual.reviewerInput.sourceCount, 0, '无知识资料的场景不得伪造来源');
        assert.equal(actual.reviewerInput.mcpFailureCount, 0, '本轮证据缺失来自未查询而不是连接故障');
        assert.equal(evidence.length, scenario.expected.tools, '复核应收到全部实际工具证据');
        assert.equal(reviewerSteps.length, scenario.expected.tools, '复核步骤必须来自真实持久台账');
        const expectedTargets = scenario.target ? [scenario.target] : [];
        for (const targets of [actualTargets, persistedTargets, evidenceTargets, evidenceOutputTargets]) {
          assert.deepEqual(targets, expectedTargets, '实际查询、持久参数和复核证据必须保留原始目标');
        }
        assert.ok(h.fixtures.toolCalls.every(tool => tool.name === 'service_status'), '不得调用共享 fixture 的写工具');
        assert.ok(steps.every(step => step.tool === 'service_status' && step.status === 'success' && step.environment === 'test'), '持久步骤必须为 test 只读成功步骤');
        if (scenario.target) {
          const feedback = result.requests.filter(item => item.role === 'analyst').at(-1);
          assert.equal(feedback.toolFeedbackMessages, 1, '第二次分析请求必须收到工具结果');
          assert.equal(feedback.feedbackTarget, scenario.target, '工具结果必须保留实际查询目标');
          assert.equal(feedback.toolCallsAlreadyApplied, 1, '第二次分析前必须已经实际查询一次');
        }
        assert.deepEqual(actual.slots, { active: 0, queued: 0 }, '公开结果返回后必须释放执行槽位');
        if (scenario.id.startsWith('missing-evidence-')) {
          const { reviewedAt, ...stablePayload } = reviewerPayload;
          pairedInputs.set(scenario.id, JSON.stringify(stablePayload));
        }
        phase = '重复请求核对持久幂等且无重试';
        const replay = await h.request('/chat', input);
        assert.equal(replay.status, 200, '相同幂等请求应回读已有结果');
        assert.deepEqual(replay.data.metadata?.agentReview, review, '重复请求必须保留原复核结论');
        assert.equal(replay.data.text, response.data.text, '重复请求必须保留原公开答复');
        assert.equal(h.requests.length, actual.modelRequests, '重复请求不得重跑分析或复核');
        assert.equal(h.fixtures.toolCalls.length, actual.fixtureToolCalls, '重复请求不得再次调用工具');
        actual.replay = { httpStatus: replay.status, modelRequestsAfter: h.requests.length, toolCallsAfter: h.fixtures.toolCalls.length, unchanged: true };
        result.scenarioMatched = true;
      } catch (error) {
        result.failures.push(`${phase}：${safeError(error)}`);
      } finally {
        if (h) {
          try { await h.close(); }
          catch (error) { result.failures.push(`临时 fixture 清理失败：${safeError(error)}`); result.scenarioMatched = false; }
        }
      }
    }
    report.comparisons = { missingEvidencePair: { sameReviewerPayloadExceptReviewedAt: pairedInputs.size === 2
      && pairedInputs.get('missing-evidence-block') === pairedInputs.get('missing-evidence-pass'),
      excludedField: 'reviewedAt', changedFixtureDecision: 'block versus pass', realErrorCorrelationMeasured: false } };
    assert.equal(report.comparisons.missingEvidencePair.sameReviewerPayloadExceptReviewedAt, true, '缺证据对照必须只改变预设复核答复，不改变问题、候选或证据');
    report.sourceUnchanged = report.source.digest === fingerprint().digest;
    if (!report.sourceUnchanged) report.failures.push('运行期间白名单源码发生变化，请重新执行实验。');
  } catch (error) {
    report.failures.push(safeError(error));
  } finally {
    for (const [key, previous] of previousEnvironment) {
      if (previous === undefined) delete process.env[key]; else process.env[key] = previous;
    }
    report.completedAt = new Date().toISOString();
    report.summary = { passed: report.results.filter(item => item.scenarioMatched).length, total: scenarios.length,
      humanReviewed: 0, humanPending: report.results.length };
    report.passed = report.results.length === scenarios.length && report.results.every(item => item.scenarioMatched) && report.failures.length === 0;
    mkdirSync(outputDirectory, { recursive: true });
    writeFileSync(join(outputDirectory, 'review-lab.json'), JSON.stringify(report, null, 2) + '\n');
    writeFileSync(join(outputDirectory, 'review-lab.md'), markdown(report));
  }
  console.log(`独立复核学习实验：${report.summary.passed}/${report.summary.total} 场景符合预期（${workerMode}，AgentScope ${report.sdkVersion}）；人工质量仍未评审。`);
  console.log(`报告：${join(outputDirectory, 'review-lab.md')}\n结构化数据：${join(outputDirectory, 'review-lab.json')}`);
  for (const item of report.results) for (const failure of item.failures) console.error(`${item.title}：${failure}`);
  for (const failure of report.failures) console.error(failure);
  if (!report.passed) process.exitCode = 1;
}

function markdown(report) {
  const cell = value => String(value ?? '未取得 / 不适用').replaceAll('|', '\\|').replaceAll('\n', ' ');
  const yes = value => value == null ? '未取得' : value ? '是' : '否';
  const rows = [
    '# 固定双 Agent：门禁与质量边界实验', '',
    `工程场景：${report.passed ? '通过' : '失败'}；${report.summary.passed}/${report.summary.total} 符合预期。人工质量评审：${report.summary.humanReviewed} 条已评，${report.summary.humanPending} 条待评。`, '',
    `时间：${report.startedAt} 至 ${report.completedAt}（UTC）；Node ${report.nodeVersion}；真实 SDK ${report.sdkVersion} / ${report.workerMode}。`, '',
    '复现命令：`npm run agent:learn:review`。命令不接受参数或真实模式，仅使用临时数据库、本机模型与 test 只读 MCP。', '',
    '## 预期与实际', '',
    '| 场景 | 复核预期 / 实际 | HTTP / run / trace | 模型预期 / 实际 | 查询预期 / 实际 | tokens 预期 / 实际 | 候选发布 | 证据支持本轮目标 | 工程符合预期 |',
    '| --- | --- | --- | --- | --- | --- | --- | --- | --- |',
    ...report.results.map(item => `| ${item.title} | ${item.expected.reviewStatus} / ${cell(item.actual?.reviewStatus)} | ${cell(item.actual?.httpStatus)} / ${cell(item.actual?.runStatus)} / ${cell(item.actual?.traceStatus)} | ${item.expected.modelRequests} / ${cell(item.actual?.modelRequests)} | ${item.expected.tools} / ${cell(item.actual?.fixtureToolCalls)} | ${item.expected.tokens} / ${cell(item.actual?.tokens)} | ${yes(item.actual?.candidatePublished)} | ${yes(item.actual?.evidenceSupportsRequestedTarget)} | ${yes(item.scenarioMatched)} |`), '',
    '这些场景的 HTTP/run 预期均为 200/success：平台已返回公开结果。复核 blocked/unavailable 与全景 blocked/error 是不同维度，不能用流程成功替代复核通过或业务健康。', '',
    '## 关键对照', '',
    `两组缺证据场景除了 reviewedAt 外的复核输入完全相同：${yes(report.comparisons.missingEvidencePair?.sameReviewerPayloadExceptReviewedAt)}。同一问题、同一候选、同样零证据，只把本地复核预设从 block 改为 pass，候选就会被放行。`, '',
    '这是人为构造的共同误判反例，用于解释独立上下文与判断正确性的区别；不能据此计算真实模型误判率、错误相关性或双 Agent 收益。', '',
  ];
  for (const item of report.results) {
    const actual = item.actual;
    rows.push(`## ${item.title}`, '', item.explanation, '',
      `复核原因：${cell(actual?.reviewReasons?.join(', ') || '无')}；持久候选可见：${yes(actual?.candidatePersisted)}；复核开始前候选已持久化：${yes(actual?.candidatePersistedBeforeReview)}。`, '',
      '| 阶段请求 | 角色 | 消息角色 | 可见工具数 | 已完成查询 | 响应 HTTP | 固定响应 tokens |',
      '| --- | --- | --- | --- | --- | --- | --- |',
      ...item.requests.map(request => `| ${request.request} | ${request.role} | ${request.messageRoles.join(', ')} | ${request.toolsDeclared} | ${request.toolCallsAlreadyApplied} | ${request.responseHttpStatus} | ${request.responseReportedTokens} |`), '');
    if (actual) rows.push(
      `实际 MCP 目标：${actual.targets.actualMcp.join(', ') || '无'}；持久目标：${actual.targets.persisted.join(', ') || '无'}；复核证据目标：${actual.targets.reviewerArguments.join(', ') || '无'}。`, '',
      `复核证据 / 步骤：${actual.reviewerInput.evidenceCount} / ${actual.reviewerInput.stepsCount}；与持久台账关联：${yes(actual.reviewerInput.evidenceMatchesPersistentSteps)}。模型用量 / 台账用量：${actual.observedResponseTokens} / ${actual.tokens}。`, '',
      `持久执行：${actual.runId}；运行时 ${actual.runtime}/${actual.runtimeVersion}；最终槽位 ${actual.slots.active}/${actual.slots.queued}；幂等回读无新增请求或查询：${yes(actual.replay?.unchanged)}。`, '');
    if (item.failures.length) rows.push('失败原因：', '', ...item.failures.map(failure => `- ${cell(failure)}`), '');
  }
  rows.push('## 人工 rubric 与未填写实测表', '', report.humanRubric.scoreGuide, '',
    '| 维度 | 人工核对问题 |', '| --- | --- |', ...report.humanRubric.dimensions.map(item => `| ${item.id} | ${item.question} |`), '',
    '以下是待填写学习记录，自动执行不会代填评分、评审者或用户实测。请复制报告后填写，重新运行会生成新的空白记录；本实验文件不能用于既有 DTS 生产验收 CLI。', '',
    '| 场景 | 人工状态 | 五维评分 | 评审人 / 时间 | 证据与解释 | 用户执行时间 / 源码摘要 |',
    '| --- | --- | --- | --- | --- | --- |', ...report.results.map(item => `| ${item.title} | pending |  |  |  |  |`), '',
    '真实质量研究需另行制定样本、同一输入的单 Agent 对照、盲评和重复测量，并独立记录误拦截、漏拦截、调用数与真实用量；本报告没有执行或批准该研究。', '',
    '## 证据边界', '', ...report.limitations.map(item => `- ${item}`), '',
    '## 源码定位', '',
    '- `server/agent.mjs`：分析最多五次、构造本轮证据、调用独立复核后发布公开结果。',
    '- `server/agent-review.mjs`：两个消息的无工具上下文、单次复核、严格 JSON、状态与固定提示。',
    '- `server/agent-runtime/index.mjs`：实际请求次数与阶段用量；`server/execution.mjs`：共享台账、额度和持久幂等。',
    '- `tests/agent-review.test.mjs` / `tests/runtime-fixture.mjs`：既有复核断言及本地模型/MCP/临时数据库。', '',
    '## 源码 SHA256', '', `固定白名单 ${report.source?.files.length ?? 0} 文件；合并摘要：\`${cell(report.source?.digest)}\`；运行期间源码一致：${yes(report.sourceUnchanged)}。`, '',
    '| 文件 | SHA256 |', '| --- | --- |', ...(report.source?.files || []).map(item => `| ${item.file} | ${item.sha256} |`), '');
  if (report.failures.length) rows.push('报告级失败：', '', ...report.failures.map(failure => `- ${cell(failure)}`), '');
  return rows.join('\n');
}
