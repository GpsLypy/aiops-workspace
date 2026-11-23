import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

// This learning lab deliberately has no configuration/real-provider CLI mode.
if (process.argv.length > 2) {
  console.error('本实验不接受参数；请直接运行 npm run agent:learn:react。--real 和外部配置均不受支持。');
  process.exitCode = 1;
} else {
  await main().catch(error => {
    console.error(`ReAct 学习实验无法完成：${safeError(error)}`);
    process.exitCode = 1;
  });
}

function safeError(error) {
  // Our assertion inputs only contain structural observations. Avoid exporting
  // arbitrary library payloads, paths, headers or exception stacks.
  if (error?.code === 'ERR_ASSERTION') return String(error.message).slice(0, 1800);
  return `阶段失败（${/^[A-Z0-9_]+$/.test(error?.code || '') ? error.code : 'LAB_ERROR'}）；请核对 Node ≥ 22.16、Python 3.12 与已安装的锁定 SDK。`;
}

async function main() {
  const root = fileURLToPath(new URL('..', import.meta.url));
  const outputDirectory = join(root, 'test-results', 'learning');
  const workerMode = 'prefork';
  const startedAt = new Date().toISOString();
  const sourceFiles = [
    'scripts/learn-agent-react.mjs', 'tests/runtime-fixture.mjs', 'tests/fixtures.mjs',
    'server/agent.mjs', 'server/execution.mjs', 'server/governance.mjs', 'server/model.mjs',
    'server/agent-runtime/index.mjs', 'server/agent-runtime/driver.mjs',
    'server/agent-runtime/agentscope.mjs', 'server/agent-runtime/pool.mjs', 'server/agent-runtime/protocol.mjs',
    'agent-worker/worker.py', 'agent-worker/pyproject.toml', 'agent-worker/uv.lock',
  ].sort();
  const fingerprint = () => {
    const files = sourceFiles.map(file => ({ file, sha256: createHash('sha256').update(readFileSync(join(root, file))).digest('hex') }));
    return { algorithm: 'sha256', digest: createHash('sha256').update(files.map(item => `${item.file}\0${item.sha256}\n`).join('')).digest('hex'), files };
  };
  const source = fingerprint();

  // Only this process changes. No .env or application data is opened. In
  // particular, never inherit an external master-key path or provider fallback.
  const fixedEnvironment = {
    NODE_ENV: 'test', AUTH_MODE: 'local', COOKIE_SECURE: 'false', APP_ORIGIN: '', TRUST_PROXY: '',
    MASTER_KEY_FILE: '', ADMIN_USERNAME: '', ADMIN_PASSWORD: '', SETUP_TOKEN: '',
    MODEL_BASE_URL: '', MODEL_NAME: '', MODEL_API_KEY: '', MODEL_API_TYPE: 'responses',
    MODEL_DATA_POLICY: 'redact', MODEL_PRICE_PER_MILLION: '0', DAILY_COST_LIMIT: '0', OUTBOUND_ALLOWED_ORIGINS: '',
    NOTIFICATION_WEBHOOK_URL: '', NOTIFICATION_WEBHOOK_SECRET: '', ENABLE_AUTO_REMEDIATION: 'false',
    AGENT_RUNTIME: 'agentscope', AGENTSCOPE_AGENT_IDS: '', AGENTSCOPE_WORKER_MODE: workerMode,
    RUN_TOKEN_LIMIT: '100000', DAILY_TOKEN_LIMIT: '1000000', WORKSPACE_DAILY_TOKEN_LIMIT: '10000000',
    MODEL_CONTEXT_TOKENS: '32768', MODEL_MAX_TOKENS: '4096', RUN_TIMEOUT_MS: '120000',
  };
  const previousEnvironment = new Map(Object.keys(fixedEnvironment).map(key => [key, process.env[key]]));
  Object.assign(process.env, fixedEnvironment);
  const scenarios = [
    {
      id: 'normal', title: '正常往返', question: '只读查询 billing 服务状态，再根据工具结果回答。',
      expected: { httpStatus: 200, runStatus: 'success', modelRequests: 2, fixtureToolCalls: 1, persistedSteps: 1, tokens: 60,
        existingToolResults: [0, 1], fixtureToolCallsAtRequest: [0, 1], decisions: ['read_tool_request', 'final_answer'] },
      explanation: '第二次模型请求收到第一轮实际工具结果，然后返回最终答案；两次模型请求之间发生一次只读工具执行。',
    },
    {
      id: 'invalid-json', title: '非法 JSON', question: '验证非法工具参数在执行前被拒绝。',
      expected: { httpStatus: 502, runStatus: 'failed', modelRequests: 1, fixtureToolCalls: 0, persistedSteps: 0, tokens: 30,
        existingToolResults: [0], fixtureToolCallsAtRequest: [0], decisions: ['invalid_json_tool_request'] },
      explanation: '受控模型返回带尾随逗号的非法 JSON 参数。Node 在交给 Worker 编排执行之前拒绝，MCP 没有收到工具调用。',
    },
    {
      id: 'call-limit', title: '调用上限', question: '验证持续请求只读工具时的模型调用上限。',
      expected: { httpStatus: 422, runStatus: 'failed', modelRequests: 6, fixtureToolCalls: 6, persistedSteps: 6, tokens: 180,
        existingToolResults: [0, 1, 2, 3, 4, 5], fixtureToolCallsAtRequest: [0, 1, 2, 3, 4, 5], decisions: Array(6).fill('read_tool_request') },
      explanation: '第六次模型请求仍产生并执行一次只读工具调用；随后 Node 阻止第七次模型请求，因此第六个工具结果没有被下一次模型请求消费。',
    },
  ];
  const report = {
    version: 1, command: 'npm run agent:learn:react', mode: 'deterministic-fixture', runtime: 'agentscope', sdkVersion: '2.0.8',
    workerMode, nodeVersion: process.version, startedAt, completedAt: null, source, sourceUnchanged: false,
    isolation: { database: 'one-independent-temporary-database-per-scenario', network: '127.0.0.1-only-model-and-MCP',
      authorizedTools: ['service_status'], modelTools: ['mcp_0'], productionToolsUsed: false, realModelUsed: false },
    limitations: [
      '真实 AgentScope SDK 执行编排；模型决定、回答和用量均由本地 fixture 固定，不衡量真实模型质量、诊断准确率或真实费用。',
      '每个场景使用独立临时数据库与本机 HTTP 服务；资源上的 production 只是本地策略字段，不表示连接生产系统。',
      '进入聊天前将 MCP 允许列表和策略缩小到只读 service_status。底层共享 fixture 的写工具没有向模型授权，也没有被调用。',
      '报告仅记录消息角色、计数、受控决策及持久台账结构；不保存系统提示、消息正文、密钥、工具返回正文或私有推理。',
      '源码摘要仅读取固定的 15 个项目文件，不扫描 .env、.data、任意目录或用户凭据。',
    ], results: [], failures: [], passed: false,
  };
  try {
    const { runtimeFixture, call, answer } = await import('../tests/runtime-fixture.mjs');
    const { defaultPython } = await import('../server/agent-runtime/agentscope.mjs');
    const { runtimeOptions } = await import('../server/agent-runtime/index.mjs');
    const { validateEnvironment } = await import('../server/security.mjs');
    // Validate configuration before runtimeFixture opens its HTTP listeners.
    // Pass every runtime option explicitly: this lab has one fixed setup and
    // does not inherit alternative Python, sizing or enhancement settings.
    const runtime = runtimeOptions({ runtime: 'agentscope', workerMode, python: defaultPython,
      contextMode: 'recent', retrievalMode: 'ranked', evidenceReports: false, contextMaxBytes: 16000,
      poolSize: 1, poolMaxRuns: 100, poolMaxAgeMs: 1800000, startupTimeoutMs: 15000, poolQueueMs: 30000, poolMaxPending: 100 });
    validateEnvironment();
    for (const scenario of scenarios) {
      const result = { id: scenario.id, title: scenario.title, explanation: scenario.explanation, expected: scenario.expected,
        actual: null, rounds: [], passed: false, failures: [] };
      report.results.push(result);
      let h;
      let phase = '初始化本地 fixture';
      try {
        h = await runtimeFixture(runtime);
        phase = '核对本地模型与 MCP 配置';
        const modelStatus = await h.request('/settings/model');
        assert.equal(modelStatus.status, 200, '本地模型配置必须可以读取');
        assert.equal(modelStatus.data.configured, true, '必须成功保存本地模型配置');
        assert.equal(new URL(modelStatus.data.baseUrl).hostname, '127.0.0.1', '模型必须绑定本地 fixture');
        assert.equal(new URL(h.resource.endpoint).hostname, '127.0.0.1', 'MCP 必须绑定本地 fixture');
        phase = '保存只读工具策略';
        const readonly = await h.request(`/resources/${h.resource.id}`, { ...h.resource,
          allowedTools: ['service_status'], toolPolicies: { service_status: h.resource.toolPolicies.service_status } }, 'PUT');
        assert.equal(readonly.status, 200, '只读工具策略必须保存成功');
        assert.deepEqual(readonly.data.allowedTools, ['service_status'], '实验只允许查询工具');
        assert.deepEqual(Object.keys(readonly.data.toolPolicies), ['service_status'], '写入策略必须移除');
        assert.equal(readonly.data.toolPolicies.service_status.risk, 'read', '查询策略必须是只读');
        phase = '预热真实 AgentScope SDK';
        await h.app.engine.warmup();
        assert.equal(h.app.engine.health().mode, workerMode, '使用明确选定的 Worker 模式');

        h.model((req, res) => {
          const messages = req.body.messages || [];
          const aliases = (req.body.tools || []).map(tool => tool.function?.name);
          const round = result.rounds.length + 1;
          const decision = scenario.id === 'invalid-json' ? 'invalid_json_tool_request'
            : scenario.id === 'normal' && round > 1 ? 'final_answer' : 'read_tool_request';
          result.rounds.push({ round, messageRoles: messages.map(message => message.role),
            existingToolResults: messages.filter(message => message.role === 'tool').length,
            fixtureToolCallsAtRequest: h.fixtures.toolCalls.length, authorizedAliases: aliases, decision });
          if (aliases.length !== 1 || aliases[0] !== 'mcp_0') {
            result.failures.push('模型可见工具目录不符合单一只读工具约束，已停止发送工具请求。');
            return answer(res, null, '实验目录校验未通过。');
          }
          const calls = decision === 'final_answer' ? null : [call('fixture-call', 'mcp_0',
            decision === 'invalid_json_tool_request' ? '{"service":"billing",}' : { service: 'billing' })];
          return answer(res, calls, decision === 'final_answer' ? 'billing 状态 healthy（本地合成数据）。' : '');
        });

        phase = '执行场景并核对实际请求与持久台账';
        const response = await h.request('/chat', { text: scenario.question, requestKey: `react-lab-${scenario.id}`, useKnowledge: false, reviewMode: 'off' });
        const run = h.app.store.get('SELECT id,status,tokens,runtime,runtime_version FROM executions WHERE request_key=?', `react-lab-${scenario.id}`);
        const steps = run ? h.app.store.all('SELECT id,tool,status,environment,call_key FROM tool_steps WHERE run_id=? ORDER BY created,rowid', run.id) : [];
        result.actual = {
          httpStatus: response.status, runId: run?.id || null, runStatus: run?.status || null,
          runtime: run?.runtime || null, runtimeVersion: run?.runtime_version || null, workerMode: h.app.engine.health().mode,
          modelRequests: h.requests.length, fixtureToolCalls: h.fixtures.toolCalls.length, persistedSteps: steps.length,
          tokens: run?.tokens ?? null, usageSource: 'executions.tokens',
          toolSteps: steps.map(step => ({ stepId: step.id, tool: step.tool, status: step.status, environment: step.environment, callKey: step.call_key })),
          fixtureTools: h.fixtures.toolCalls.map(tool => tool.name),
        };
        for (const field of ['httpStatus', 'runStatus', 'modelRequests', 'fixtureToolCalls', 'persistedSteps', 'tokens']) {
          assert.equal(result.actual[field], scenario.expected[field], `${scenario.title}：${field} 不符合预期`);
        }
        assert.equal(run?.runtime, 'agentscope', '执行台账必须标记真实 AgentScope 路径');
        assert.equal(run?.runtime_version, workerMode === 'prefork' ? '2.0.8/bridge-v2-prefork' : '2.0.8/bridge-v1', '台账版本与锁定 SDK/Worker 模式一致');
        assert.equal(result.rounds.length, h.requests.length, '每次实际模型请求都有一条观测');
        for (const field of ['existingToolResults', 'fixtureToolCallsAtRequest', 'decision']) {
          assert.deepEqual(result.rounds.map(round => round[field]), scenario.expected[field === 'decision' ? 'decisions' : field], `${scenario.title}：轮次观测 ${field} 不符合预期`);
        }
        for (const round of result.rounds) {
          assert.deepEqual(round.messageRoles, ['system', 'user', ...Array.from({ length: round.round - 1 }, () => ['assistant', 'tool']).flat()], '后续模型请求应包含之前的完整工具往返');
          assert.deepEqual(round.authorizedAliases, ['mcp_0'], '每轮只暴露一个只读工具别名');
        }
        assert.ok(steps.every(step => step.tool === 'service_status' && step.status === 'success'), '持久步骤只能包含成功的只读工具调用');
        assert.ok(h.fixtures.toolCalls.every(tool => tool.name === 'service_status'), '实际 MCP 调用必须全部为只读查询');
        assert.equal(new Set(steps.map(step => step.call_key)).size, steps.length, '跨轮重复 provider ID 必须映射到不同步骤身份');
        result.passed = result.failures.length === 0;
      } catch (error) {
        result.failures.push(`${phase}：${safeError(error)}`);
      } finally {
        if (h) {
          try { await h.close(); }
          catch (error) { result.failures.push(`临时 fixture 清理失败：${safeError(error)}`); result.passed = false; }
        }
      }
    }
    report.sourceUnchanged = source.digest === fingerprint().digest;
    if (!report.sourceUnchanged) report.failures.push('运行期间白名单源码发生变化，请重新执行实验。');
  } catch (error) {
    report.failures.push(safeError(error));
  } finally {
    for (const [key, previous] of previousEnvironment) {
      if (previous === undefined) delete process.env[key]; else process.env[key] = previous;
    }
    report.completedAt = new Date().toISOString();
    report.summary = { passed: report.results.filter(result => result.passed).length, total: scenarios.length };
    report.passed = report.results.length === scenarios.length && report.results.every(result => result.passed) && report.failures.length === 0;
    mkdirSync(outputDirectory, { recursive: true });
    writeFileSync(join(outputDirectory, 'react-lab.json'), JSON.stringify(report, null, 2) + '\n');
    writeFileSync(join(outputDirectory, 'react-lab.md'), markdown(report));
  }
  console.log(`ReAct 学习实验：${report.summary.passed}/${report.summary.total} 场景通过（${workerMode}，AgentScope ${report.sdkVersion}）。`);
  console.log(`报告：${join(outputDirectory, 'react-lab.md')}\n结构化数据：${join(outputDirectory, 'react-lab.json')}`);
  for (const result of report.results) for (const failure of result.failures) console.error(`${result.title}：${failure}`);
  for (const failure of report.failures) console.error(failure);
  if (!report.passed) process.exitCode = 1;
}

function markdown(report) {
  const cell = value => String(value ?? '未取得').replaceAll('|', '\\|').replaceAll('\n', ' ');
  const decisionName = { read_tool_request: '请求只读工具', final_answer: '返回最终答案', invalid_json_tool_request: '请求工具，参数为非法 JSON' };
  const rows = [
    '# ReAct 本地学习实验', '',
    `结果：${report.passed ? '通过' : '失败'}；${report.summary.passed}/${report.summary.total} 个场景符合预期。`, '',
    `开始：${report.startedAt}；结束：${report.completedAt}（UTC）。`, '',
    `运行环境：Node ${report.nodeVersion}，AgentScope ${report.sdkVersion}，Worker 模式 ${report.workerMode}。`, '',
    '复现命令：`npm run agent:learn:react`。先完成依赖安装与 `npm run agent:check`。命令不接受参数或真实供应商配置。', '',
    '## 实验边界', '', ...report.limitations.map(item => `- ${item}`), '',
    'token 是 fixture 为每次模型请求固定返回的 30，用于检查执行台账记账；它不是实际模型的 tokenizer 或计费测量。', '',
    '## 预期与实际', '',
    '| 场景 | HTTP 预期 / 实际 | 运行状态预期 / 实际 | 模型请求预期 / 实际 | 工具执行预期 / 实际 | 台账 token 预期 / 实际 | 通过 |',
    '| --- | --- | --- | --- | --- | --- | --- |',
    ...report.results.map(item => `| ${item.title} | ${item.expected.httpStatus} / ${cell(item.actual?.httpStatus)} | ${item.expected.runStatus} / ${cell(item.actual?.runStatus)} | ${item.expected.modelRequests} / ${cell(item.actual?.modelRequests)} | ${item.expected.fixtureToolCalls} / ${cell(item.actual?.fixtureToolCalls)} | ${item.expected.tokens} / ${cell(item.actual?.tokens)} | ${item.passed ? '是' : '否'} |`), '',
  ];
  for (const item of report.results) {
    rows.push(`## ${item.title}`, '', item.explanation, '',
      '下表仅描述实际 HTTP 模型请求边界；“已有工具结果”来自请求中的 tool 角色计数，“已执行工具”来自本地 MCP 实际调用计数。', '',
      '| 模型轮次 | 收到的消息角色顺序 | 已有工具结果 | 此时已执行工具 | 受控模型决策 |',
      '| --- | --- | --- | --- | --- |',
      ...item.rounds.map(round => `| ${round.round} | ${cell(round.messageRoles.join(' → '))} | ${round.existingToolResults} | ${round.fixtureToolCallsAtRequest} | ${decisionName[round.decision]} |`), '',
      `持久运行：${cell(item.actual?.runId)}；运行时版本：${cell(item.actual?.runtimeVersion)}。`, '',
      `持久工具步骤：预期 ${item.expected.persistedSteps}，实际 ${cell(item.actual?.persistedSteps)}。`, '');
    if (item.actual?.toolSteps.length) {
      rows.push('| 步骤 | 工具 | 持久状态 | 本地策略环境 |', '| --- | --- | --- | --- |',
        ...item.actual.toolSteps.map((step, index) => `| ${index + 1} | ${step.tool} | ${step.status} | ${step.environment} |`), '');
    } else rows.push('没有持久工具步骤。', '');
    if (item.failures.length) rows.push('失败原因：', '', ...item.failures.map(failure => `- ${cell(failure)}`), '');
  }
  if (report.failures.length) rows.push('## 报告级失败', '', ...report.failures.map(failure => `- ${cell(failure)}`), '');
  rows.push('## 对应源码', '',
    '- `server/agent.mjs`：`execute` 装配当前授权上下文与工具，`resolveCall` 验证模型工具请求。',
    '- `server/agent-runtime/index.mjs`：`runRuntime` 计数模型请求，校验工具批次，保留 Node 原始消息。',
    '- `agent-worker/worker.py`：`main`、`ModelBridge._call_api` 和外部工具事件组成真实 SDK 循环。',
    '- `server/execution.mjs`：`run` 保存运行状态与用量；`callStep` / `executeStep` 保存实际工具步骤。', '',
    '## 源码 SHA256', '', `合并摘要：\`${report.source.digest}\`。运行期间源码${report.sourceUnchanged ? '未变化' : '未确认一致'}。`, '',
    '| 固定白名单文件 | SHA256 |', '| --- | --- |', ...report.source.files.map(item => `| ${item.file} | ${item.sha256} |`), '');
  return rows.join('\n');
}
