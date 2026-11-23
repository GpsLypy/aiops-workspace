import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const syntheticTargets = ['billing', 'inventory', 'payroll'];
const reportedTarget = value => value == null ? null : syntheticTargets.includes(value) ? value : 'unexpected-target';

// No arbitrary target, provider, or configuration can be supplied to this lab.
if (process.argv.length > 2) {
  console.error('本实验不接受参数；请直接运行 npm run agent:learn:intent。--real 和外部配置均不受支持。');
  process.exitCode = 1;
} else {
  await main().catch(error => {
    console.error(`授权与意图学习实验无法完成：${safeError(error)}`);
    process.exitCode = 1;
  });
}

function safeError(error) {
  // Assertions always supply a fixed message. Drop actual/expected dumps and
  // never print arbitrary library payloads, request bodies, paths, or stacks.
  if (error?.code === 'ERR_ASSERTION') return String(error.message).split('\n')[0].slice(0, 300);
  return `阶段失败（${/^[A-Z0-9_]+$/.test(error?.code || '') ? error.code : 'LAB_ERROR'}）；请核对 Node ≥ 22.16、Python 3.12 与已安装的锁定 SDK。`;
}

function toolFeedback(messages) {
  const message = messages.find(item => item.role === 'tool');
  if (!message) return { present: false, decoded: false, target: null, callId: null };
  try {
    const response = JSON.parse(message.content);
    const payload = response.structuredContent ?? JSON.parse(response.content.find(item => item.type === 'text').text);
    return { present: true, decoded: typeof payload.service === 'string', target: payload.service, callId: message.tool_call_id };
  } catch { return { present: true, decoded: false, target: null, callId: message.tool_call_id }; }
}

async function main() {
  const root = fileURLToPath(new URL('..', import.meta.url));
  const outputDirectory = join(root, 'test-results', 'learning');
  const workerMode = 'prefork';
  const requestedTarget = 'billing';
  const allowedTargets = ['billing', 'inventory'];
  const question = '只读查询 billing 服务状态；本轮目标明确为 billing，不查询其他服务。';
  const sourceFiles = [
    'scripts/learn-agent-intent.mjs', 'tests/runtime-fixture.mjs', 'tests/fixtures.mjs',
    'server/agent.mjs', 'server/execution.mjs', 'server/governance.mjs', 'server/model.mjs',
    'server/model-stream.mjs', 'server/mcp.mjs', 'server/security.mjs', 'server/store.mjs', 'server/resources.mjs',
    'server/agent-runtime/index.mjs', 'server/agent-runtime/driver.mjs', 'server/agent-runtime/agentscope.mjs',
    'server/agent-runtime/pool.mjs', 'server/agent-runtime/protocol.mjs',
    'agent-worker/worker.py', 'agent-worker/pyproject.toml', 'agent-worker/uv.lock',
  ].sort();
  const fingerprint = () => {
    const files = sourceFiles.map(file => ({ file, sha256: createHash('sha256').update(readFileSync(join(root, file))).digest('hex') }));
    return { algorithm: 'sha256', digest: createHash('sha256').update(files.map(item => `${item.file}\0${item.sha256}\n`).join('')).digest('hex'), files };
  };
  const success = { httpStatus: 200, runStatus: 'success', modelRequests: 2, fixtureToolCalls: 1, persistedSteps: 1, tokens: 60, stepStatuses: ['success'] };
  const scenarios = [
    { id: 'requested-target', title: '已授权且符合本轮目标', proposedTarget: 'billing',
      expected: { ...success, intentMatched: true, proposalWithinConfiguredScope: true, executedTarget: 'billing' },
      explanation: '用户要求 billing，受控模型提出 billing；静态授权允许，实际查询、持久参数与回填目标均为 billing。' },
    { id: 'authorized-wrong-target', title: '已授权但选错本轮目标', proposedTarget: 'inventory',
      expected: { ...success, intentMatched: false, proposalWithinConfiguredScope: true, executedTarget: 'inventory' },
      explanation: '同一问题仍要求 billing，模型却提出同样获授权的 inventory。当前治理允许这次只读查询；实验通过代表复现缺口，不代表意图保护已经生效。' },
    { id: 'outside-authorized-scope', title: '超出静态授权范围', proposedTarget: 'payroll',
      expected: { httpStatus: 403, runStatus: 'failed', modelRequests: 1, fixtureToolCalls: 0, persistedSteps: 0, tokens: 30, stepStatuses: [],
        intentMatched: false, proposalWithinConfiguredScope: false, executedTarget: null },
      explanation: 'payroll 符合 service:string 的工具 Schema，但不在 billing/inventory 静态允许列表。平台在真实调用及建立步骤前拒绝；这证明范围门禁，不证明意图识别。' },
  ];
  const report = {
    version: 1, command: 'npm run agent:learn:intent', mode: 'deterministic-fixture', runtime: 'agentscope', sdkVersion: '2.0.8',
    workerMode, nodeVersion: process.version, startedAt: new Date().toISOString(), completedAt: null, source: null, sourceUnchanged: false,
    configuration: { environment: 'test', tool: 'service_status', requestedTarget, allowedTargets, reviewMode: 'off',
      targetField: 'service', targetBindingImplemented: false, modelPricePerMillion: 0, dailyCostLimit: 0 },
    isolation: { database: 'one-independent-temporary-database-per-scenario', network: '127.0.0.1-only-model-and-MCP',
      authorizedTools: ['service_status'], modelTools: ['mcp_0'], productionToolsUsed: false, realModelUsed: false },
    meanings: {
      scenarioMatched: 'Actual platform behavior and observations match this scenario, including the authorized wrong-target execution.',
      intentMatched: 'Post-hoc exact equality of the synthetic requested target and the emitted model proposal; never used to authorize execution.',
      executedTargetMatchesRequest: 'Post-hoc exact equality of the actual MCP target and the requested target; null when no tool executed.',
    },
    limitations: [
      '真实 AgentScope 2.0.8 / prefork 只验证本地桥接和治理链路；模型选项、回答和每次 30 tokens 均由 fixture 固定，不评价真实模型的目标选择、诊断质量或费用。',
      '所有目标均为合成 service 字符串，fixture 对任意字符串返回合成状态。本实验未连接真实 DTS、真实供应商或生产服务，也不证明服务健康。',
      '静态允许列表为 billing/inventory；当前问题始终明确要求 billing。intentMatched 仅为脚本事后精确比较，既非自然语言意图识别，也不参与本次工具放行。',
      '授权内选错目标仍会执行，这是本实验要显露的现有边界。前置目标绑定尚未实现，独立复核关闭；答复门禁不能追溯阻止已经发生的查询。',
      '模型提议不是执行事实。报告分别列出用户预设目标、模型实际发出的提议、MCP 实际目标、临时步骤密文解密后的目标以及第二次模型输入中的工具结果目标。',
      '只开放 test 环境的单一只读 service_status。共享 fixture 的写工具与其他工具不向模型授权，也不应被调用。',
      '仅导出固定合成目标标签、角色、计数、布尔核对与步骤身份；不保存完整提示、任意工具参数/返回正文、凭据或私有推理。',
      `源码摘要仅读取固定的 ${sourceFiles.length} 个项目文件，不读取 .env、.data、真实模型配置或用户凭据。`,
      '正常结束及 fixture 初始化成功后的捕获异常会清理本轮资源；初始化中断或强制终止不保证清理，未做 SIGINT/SIGTERM 清理验收。',
    ], results: [], failures: [], passed: false,
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
  };
  const previousEnvironment = new Map(Object.keys(fixedEnvironment).map(key => [key, process.env[key]]));
  Object.assign(process.env, fixedEnvironment);
  try {
    report.source = fingerprint();
    const { runtimeFixture, answer, call } = await import('../tests/runtime-fixture.mjs');
    const { defaultPython } = await import('../server/agent-runtime/agentscope.mjs');
    const { runtimeOptions } = await import('../server/agent-runtime/index.mjs');
    const { validateArguments } = await import('../server/execution.mjs');
    const { validateEnvironment } = await import('../server/security.mjs');
    const runtime = runtimeOptions({ runtime: 'agentscope', workerMode, python: defaultPython,
      contextMode: 'recent', retrievalMode: 'ranked', evidenceReports: false, contextMaxBytes: 16000,
      poolSize: 1, poolMaxRuns: 100, poolMaxAgeMs: 1800000, startupTimeoutMs: 15000, poolQueueMs: 30000, poolMaxPending: 100 });
    validateEnvironment();
    for (const scenario of scenarios) {
      const result = { id: scenario.id, title: scenario.title, explanation: scenario.explanation, expected: scenario.expected,
        actual: null, requests: [], scenarioMatched: false, intentMatched: null, failures: [] };
      report.results.push(result);
      let h;
      let phase = '初始化本地 fixture';
      try {
        h = await runtimeFixture(runtime);
        phase = '保存两个合成目标的只读 test 策略';
        const model = await h.request('/settings/model');
        assert.equal(model.status, 200, '必须能够读取本地模型配置');
        assert.equal(model.data.configured, true, '必须已经保存本地模型配置');
        assert.equal(new URL(model.data.baseUrl).hostname, '127.0.0.1', '模型地址必须为本机 fixture');
        assert.equal(new URL(h.resource.endpoint).hostname, '127.0.0.1', 'MCP 地址必须为本机 fixture');
        const readonly = await h.request(`/resources/${h.resource.id}`, { ...h.resource, environment: 'test',
          allowedTools: ['service_status'], toolPolicies: { service_status: { risk: 'read', roles: ['admin'], userIds: [],
            environments: ['test'], constraints: { service: allowedTargets }, maxItems: 1 } } }, 'PUT');
        assert.equal(readonly.status, 200, '必须成功保存本轮实验策略');
        assert.equal(readonly.data.environment, 'test', '资源环境必须固定为 test');
        assert.deepEqual(readonly.data.allowedTools, ['service_status'], '模型目录只能包含单一只读工具');
        assert.deepEqual(Object.keys(readonly.data.toolPolicies), ['service_status'], '必须移除共享 fixture 的写工具策略');
        const policy = readonly.data.toolPolicies.service_status;
        assert.equal(policy.risk, 'read', '实验工具必须只读');
        assert.deepEqual(policy.environments, ['test'], '授权环境必须仅为 test');
        assert.deepEqual(policy.constraints, { service: allowedTargets }, '三个场景必须使用相同两个目标的静态授权');
        phase = '核对实际发现的工具 Schema';
        assert.ok(Array.isArray(h.schemas), '实际发现结果必须是工具列表');
        const schema = h.schemas.find(tool => tool.name === 'service_status')?.inputSchema;
        assert.equal(schema?.properties?.service?.type, 'string', '实际发现的工具 Schema 必须使用 service 字符串');
        assert.ok(schema.required?.includes('service'), '实际工具 Schema 必须要求 service');
        for (const target of syntheticTargets) validateArguments(schema, { service: target });

        phase = '预热真实 SDK 并记录受控模型请求';
        await h.app.engine.warmup();
        assert.equal(h.app.engine.health().mode, workerMode, '必须使用固定 prefork 模式');
        const emittedProposals = [];
        h.model((req, res) => {
          const messages = req.body.messages || [];
          const round = result.requests.length + 1;
          const feedback = toolFeedback(messages);
          const transcriptCall = messages.flatMap(message => message.tool_calls || [])[0];
          let transcriptTarget = null;
          try { transcriptTarget = transcriptCall ? JSON.parse(transcriptCall.function.arguments).service : null; } catch { /* Report an invalid structural observation without exposing the body. */ }
          result.requests.push({ round, messageRoles: messages.map(message => message.role),
            sameExplicitQuestion: messages.filter(message => message.role === 'user').at(-1)?.content === question,
            authorizedAliases: (req.body.tools || []).map(tool => tool.function?.name),
            toolResultMessages: messages.filter(message => message.role === 'tool').length,
            fixtureToolCallsAtRequest: h.fixtures.toolCalls.length, toolFeedbackDecoded: feedback.decoded,
            feedbackTarget: reportedTarget(feedback.target), transcriptProposalTarget: reportedTarget(transcriptTarget),
            feedbackCallIdMatches: !!transcriptCall && transcriptCall.id === feedback.callId,
            decision: round === 1 ? 'controlled_tool_proposal' : 'fixed_final_answer' });
          if (round === 1) {
            const proposal = call('intent-call', 'mcp_0', { service: scenario.proposedTarget });
            emittedProposals.push(proposal);
            return answer(res, [proposal]);
          }
          return answer(res, null, '本地合成工具往返完成；此固定回答不用于评价诊断质量。');
        });

        phase = '执行相同问题并对照五处目标证据';
        const response = await h.request('/chat', { text: question, requestKey: `intent-lab-${scenario.id}`, useKnowledge: false, reviewMode: 'off' });
        const run = h.app.store.get('SELECT id,status,tokens,runtime,runtime_version FROM executions WHERE request_key=?', `intent-lab-${scenario.id}`);
        const steps = run ? h.app.store.all('SELECT id,tool,status,environment,arguments_encrypted FROM tool_steps WHERE run_id=? ORDER BY created,rowid', run.id) : [];
        const proposedArgs = emittedProposals[0] ? JSON.parse(emittedProposals[0].function.arguments) : null;
        const actualToolTargets = h.fixtures.toolCalls.map(tool => tool.service);
        const persistedTargets = steps.map(step => JSON.parse(h.app.store.decrypt(step.arguments_encrypted)).service);
        const feedback = h.requests[1] ? toolFeedback(h.requests[1].messages) : { present: false, decoded: false, target: null };
        // These comparisons are observations AFTER execution. They are never
        // passed into the model callback, authorization policy, or executor.
        result.intentMatched = requestedTarget === proposedArgs?.service;
        result.actual = {
          httpStatus: response.status, runId: run?.id || null, runStatus: run?.status || null, runtime: run?.runtime || null,
          runtimeVersion: run?.runtime_version || null, workerMode: h.app.engine.health().mode,
          modelRequests: h.requests.length, fixtureToolCalls: h.fixtures.toolCalls.length, persistedSteps: steps.length,
          tokens: run?.tokens ?? null, usageSource: 'executions.tokens', proposalWithinConfiguredScope: policy.constraints.service.includes(proposedArgs?.service),
          schema: { targetField: 'service', type: schema.properties.service.type, required: schema.required.includes('service'), allThreeSyntheticTargetsValid: true },
          targets: { userRequested: requestedTarget, modelProposed: reportedTarget(proposedArgs?.service), actualMcp: reportedTarget(actualToolTargets[0]),
            persistedStep: reportedTarget(persistedTargets[0]), modelFeedback: reportedTarget(feedback.target) },
          executedTargetMatchesRequest: actualToolTargets.length ? actualToolTargets[0] === requestedTarget : null,
          toolSteps: steps.map((step, index) => ({ stepId: step.id, tool: step.tool, status: step.status, environment: step.environment,
            target: reportedTarget(persistedTargets[index]), encryptedArgumentsPresent: typeof step.arguments_encrypted === 'string' && step.arguments_encrypted.length > 0 })),
          stepStatuses: steps.map(step => step.status), toolFeedbackDecoded: feedback.decoded,
          targetScopeDenialObserved: response.status === 403 && response.data.error === '工具参数 service 超出授权范围',
        };
        for (const field of ['httpStatus', 'runStatus', 'modelRequests', 'fixtureToolCalls', 'persistedSteps', 'tokens', 'proposalWithinConfiguredScope']) {
          assert.equal(result.actual[field], scenario.expected[field], `实测 ${field} 必须符合场景预期`);
        }
        assert.equal(run?.runtime, 'agentscope', '持久执行必须经过真实 AgentScope');
        assert.equal(run?.runtime_version, '2.0.8/bridge-v2-prefork', '持久运行版本必须与固定 SDK/模式一致');
        assert.equal(emittedProposals.length, 1, '受控模型必须实际提出且只提出一次工具调用');
        assert.equal(proposedArgs.service, scenario.proposedTarget, '发出的模型提议必须使用本场景合成目标');
        validateArguments(schema, proposedArgs);
        assert.equal(result.intentMatched, scenario.expected.intentMatched, '事后目标比较必须区分授权内目标替换');
        assert.deepEqual(result.actual.stepStatuses, scenario.expected.stepStatuses, '持久步骤状态必须符合预期');
        assert.equal(result.requests.length, h.requests.length, '每次实际模型请求必须有结构观测');
        for (const request of result.requests) {
          assert.equal(request.sameExplicitQuestion, true, '三个场景与所有轮次必须保持同一明确用户请求');
          assert.deepEqual(request.authorizedAliases, ['mcp_0'], '模型只能看到单一只读工具别名');
          const rawRequest = h.requests[request.round - 1];
          assert.deepEqual(rawRequest.tools[0].function.parameters, schema, '实际模型可见 Schema 必须与 MCP 发现结果一致');
        }
        assert.deepEqual(result.requests[0]?.messageRoles, ['system', 'user'], '第一次请求只能包含初始系统指令与当前问题');
        assert.equal(result.requests[0]?.toolResultMessages, 0, '第一次模型请求不能伪造已有工具结果');
        assert.equal(result.requests[0]?.fixtureToolCallsAtRequest, 0, '模型提议前不能已经执行工具');
        assert.ok(h.fixtures.toolCalls.every(tool => tool.name === 'service_status'), '不得调用写工具或其他工具');
        assert.ok(steps.every(step => step.tool === 'service_status' && step.environment === 'test'), '全部持久步骤必须是 test 环境只读查询');
        if (scenario.expected.persistedSteps) {
          assert.deepEqual(actualToolTargets, [scenario.proposedTarget], '实际 MCP 必须收到本场景模型所提议的目标');
          assert.deepEqual(persistedTargets, [scenario.proposedTarget], '持久加密参数解密后的目标必须与实际调用一致');
          assert.equal(feedback.decoded, true, '必须解析第二次实际模型输入中的工具返回');
          assert.equal(feedback.target, scenario.proposedTarget, '第二次模型输入的工具结果必须保留实际查询目标');
          assert.deepEqual(result.requests[1]?.messageRoles, ['system', 'user', 'assistant', 'tool'], '第二次请求必须包含完整工具往返');
          assert.equal(result.requests[1]?.toolResultMessages, 1, '第二次模型请求必须有且仅有一条工具结果');
          assert.equal(result.requests[1]?.fixtureToolCallsAtRequest, 1, '第二次请求之前必须已实际调用一次 MCP');
          assert.equal(result.requests[1]?.transcriptProposalTarget, scenario.proposedTarget, '回传的 assistant 工具提议必须保留原始目标');
          assert.equal(result.requests[1]?.feedbackCallIdMatches, true, '工具结果必须与原始工具调用 ID 匹配');
          assert.equal(result.actual.executedTargetMatchesRequest, scenario.expected.intentMatched, '实际动作与用户目标的关系必须独立可核对');
        } else {
          assert.equal(result.actual.targetScopeDenialObserved, true, '越权场景必须确实由 service 目标允许列表拒绝');
          assert.equal(feedback.present, false, '未执行工具不得出现工具返回');
          assert.equal(result.actual.executedTargetMatchesRequest, null, '没有实际动作时不得伪造动作目标匹配结果');
        }
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
    report.sourceUnchanged = report.source.digest === fingerprint().digest;
    if (!report.sourceUnchanged) report.failures.push('运行期间白名单源码发生变化，请重新执行实验。');
  } catch (error) {
    report.failures.push(safeError(error));
  } finally {
    for (const [key, previous] of previousEnvironment) {
      if (previous === undefined) delete process.env[key]; else process.env[key] = previous;
    }
    report.completedAt = new Date().toISOString();
    report.summary = { passed: report.results.filter(result => result.scenarioMatched).length, total: scenarios.length };
    report.passed = report.results.length === scenarios.length && report.results.every(result => result.scenarioMatched) && report.failures.length === 0;
    mkdirSync(outputDirectory, { recursive: true });
    writeFileSync(join(outputDirectory, 'intent-lab.json'), JSON.stringify(report, null, 2) + '\n');
    writeFileSync(join(outputDirectory, 'intent-lab.md'), markdown(report));
  }
  console.log(`授权与意图学习实验：${report.summary.passed}/${report.summary.total} 场景符合预期（${workerMode}，AgentScope ${report.sdkVersion}）。`);
  console.log(`报告：${join(outputDirectory, 'intent-lab.md')}\n结构化数据：${join(outputDirectory, 'intent-lab.json')}`);
  for (const result of report.results) for (const failure of result.failures) console.error(`${result.title}：${failure}`);
  for (const failure of report.failures) console.error(failure);
  if (!report.passed) process.exitCode = 1;
}

function markdown(report) {
  const cell = value => String(value ?? '无观测 / 未执行').replaceAll('|', '\\|').replaceAll('\n', ' ');
  const yes = value => value == null ? '未取得 / 不适用' : value ? '是' : '否';
  const rows = [
    '# 授权范围与本轮意图：本地学习实验', '',
    `实验预期核对：${report.passed ? '通过' : '失败'}；${report.summary.passed}/${report.summary.total} 个场景符合预期。`, '',
    '**通过不代表意图保护生效。** 授权内选错目标的执行成功是本实验要复现的现有缺口；前置目标绑定尚未实现。', '',
    `开始：${report.startedAt}；结束：${report.completedAt}（UTC）。`, '',
    `运行环境：Node ${report.nodeVersion}，AgentScope ${report.sdkVersion}，Worker 模式 ${report.workerMode}。`, '',
    '复现命令：`npm run agent:learn:intent`。先完成依赖安装与 `npm run agent:check`。命令不接受参数或真实供应商模式。', '',
    '## 固定设置与读表方法', '',
    '三个场景的用户问题相同且明确要求 billing。资源环境为 test，只开放 service_status；工具 Schema 要求 service:string，静态策略允许 billing/inventory。区别只有受控模型提出的合成目标。', '',
    '- scenarioMatched：平台行为与实验预期一致，包括“授权内选错仍被执行”。',
    '- intentMatched：用户预设目标与模型实际提议目标的事后字符串比较，未参与放行；不是自然语言识别。',
    '- 实际动作匹配：另比较真实 MCP 目标；未调用时显示不适用，不把未执行说成执行正确。', '',
    '## 预期与实际', '',
    '| 场景 | HTTP 预期 / 实际 | run 预期 / 实际 | 模型预期 / 实际 | MCP 预期 / 实际 | 步骤预期 / 实际 | token 预期 / 实际 | scenarioMatched | intentMatched 预期 / 实际 |',
    '| --- | --- | --- | --- | --- | --- | --- | --- | --- |',
    ...report.results.map(item => `| ${item.title} | ${item.expected.httpStatus} / ${cell(item.actual?.httpStatus)} | ${item.expected.runStatus} / ${cell(item.actual?.runStatus)} | ${item.expected.modelRequests} / ${cell(item.actual?.modelRequests)} | ${item.expected.fixtureToolCalls} / ${cell(item.actual?.fixtureToolCalls)} | ${item.expected.persistedSteps} / ${cell(item.actual?.persistedSteps)} | ${item.expected.tokens} / ${cell(item.actual?.tokens)} | ${yes(item.scenarioMatched)} | ${yes(item.expected.intentMatched)} / ${yes(item.intentMatched)} |`), '',
    '越权组预期 403 / failed、模型已请求一次但工具和步骤为零；这是符合预期的范围拒绝。30 tokens/次是受控 fixture 用量，费用单价与 DAILY_COST_LIMIT 均固定为 0，不能外推真实费用。', '',
    '## 五处目标证据', '',
    '| 场景 | 用户预设目标 | 模型发出提议 | MCP 实际查询 | 步骤密文解密后目标 | 第二次模型输入的工具结果 | 实际动作符合请求 |',
    '| --- | --- | --- | --- | --- | --- | --- |',
    ...report.results.map(item => `| ${item.title} | ${cell(item.actual?.targets.userRequested)} | ${cell(item.actual?.targets.modelProposed)} | ${cell(item.actual?.targets.actualMcp)} | ${cell(item.actual?.targets.persistedStep)} | ${cell(item.actual?.targets.modelFeedback)} | ${yes(item.actual?.executedTargetMatchesRequest)} |`), '',
  ];
  for (const item of report.results) {
    rows.push(`## ${item.title}`, '', item.explanation, '',
      `持久运行：${cell(item.actual?.runId)}；运行时版本：${cell(item.actual?.runtimeVersion)}。`, '',
      `三种合成目标均符合实际 Schema：${yes(item.actual?.schema.allThreeSyntheticTargetsValid)}；本场景提议位于静态允许列表：${yes(item.actual?.proposalWithinConfiguredScope)}；明确观测到目标范围拒绝：${yes(item.actual?.targetScopeDenialObserved)}。`, '',
      '| 模型请求 | 角色顺序 | 相同明确问题 | 请求前实际 MCP 次数 | 已有工具结果数 | 回填目标 | 工具调用 ID 匹配 |',
      '| --- | --- | --- | --- | --- | --- | --- |',
      ...item.requests.map(request => `| ${request.round} | ${request.messageRoles.join(' → ')} | ${yes(request.sameExplicitQuestion)} | ${request.fixtureToolCallsAtRequest} | ${request.toolResultMessages} | ${cell(request.feedbackTarget)} | ${request.toolResultMessages ? yes(request.feedbackCallIdMatches) : '不适用'} |`), '');
    if (item.actual?.toolSteps.length) rows.push('| 实际步骤 | 工具 | 状态 | 环境 | 合成目标 |', '| --- | --- | --- | --- | --- |',
      ...item.actual.toolSteps.map((step, index) => `| ${index + 1} | ${step.tool} | ${step.status} | ${step.environment} | ${cell(step.target)} |`), '');
    else rows.push('没有持久工具步骤。', '');
    if (item.failures.length) rows.push('实验失败原因：', '', ...item.failures.map(failure => `- ${cell(failure)}`), '');
  }
  rows.push('## 证据边界', '', ...report.limitations.map(item => `- ${item}`), '',
    '## 对应源码', '',
    '- `tests/fixtures.mjs`：service_status 记录收到的 service，并返回带相同 service 的合成状态。',
    '- `server/governance.mjs`：authorizeTool 检查身份、环境与顶层参数允许列表，没有本轮用户目标绑定参数。',
    '- `server/agent.mjs`：resolveCall 校验模型提议并重复授权；executeCall 把实际工具返回交还运行时。',
    '- `server/execution.mjs`：callStep / executeStep 再次校验并持久保存实际参数与执行状态。',
    '- `server/agent-runtime/index.mjs`：保留 Node 原始工具提议，将匹配的真实工具结果回填到下一次模型请求。', '',
    '## 源码 SHA256', '', `合并摘要：\`${cell(report.source?.digest)}\`。运行期间源码${report.sourceUnchanged ? '未变化' : '未确认一致'}。`, '',
    '| 固定白名单文件 | SHA256 |', '| --- | --- |', ...(report.source?.files || []).map(item => `| ${item.file} | ${item.sha256} |`), '');
  if (report.failures.length) rows.push('## 报告级失败', '', ...report.failures.map(failure => `- ${cell(failure)}`), '');
  return rows.join('\n');
}
