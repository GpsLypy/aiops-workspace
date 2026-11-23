import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

// Deliberately no real-provider, arbitrary input, or configuration CLI mode.
if (process.argv.length > 2) {
  console.error('本实验不接受参数；请直接运行 npm run agent:learn:context。--real 和外部配置均不受支持。');
  process.exitCode = 1;
} else {
  await main().catch(error => {
    console.error(`上下文学习实验无法完成：${safeError(error)}`);
    process.exitCode = 1;
  });
}

function safeError(error) {
  // Every assertion below has a fixed message. Do not export its actual/expected
  // rendering, library errors, request bodies, headers, paths, or stacks.
  if (error?.code === 'ERR_ASSERTION') return String(error.message).split('\n')[0].slice(0, 300);
  return `阶段失败（${/^[A-Z0-9_]+$/.test(error?.code || '') ? error.code : 'LAB_ERROR'}）；请核对 Node ≥ 22.16、Python 3.12 与已安装的锁定 SDK。`;
}

async function main() {
  const root = fileURLToPath(new URL('..', import.meta.url));
  const outputDirectory = join(root, 'test-results', 'learning');
  const workerMode = 'prefork';
  const taskId = 'LAB-JOB-001';
  const sourceFiles = [
    'scripts/learn-agent-context.mjs', 'tests/runtime-fixture.mjs', 'tests/fixtures.mjs',
    'server/agent.mjs', 'server/agent-context.mjs', 'server/retrieval.mjs', 'server/governance.mjs',
    'server/execution.mjs', 'server/model.mjs', 'server/agent-runtime/index.mjs',
    'server/agent-runtime/driver.mjs', 'server/agent-runtime/agentscope.mjs',
    'server/agent-runtime/pool.mjs', 'server/agent-runtime/protocol.mjs',
    'agent-worker/worker.py', 'agent-worker/pyproject.toml', 'agent-worker/uv.lock',
  ].sort();
  const fingerprint = () => {
    const files = sourceFiles.map(file => ({ file, sha256: createHash('sha256').update(readFileSync(join(root, file))).digest('hex') }));
    return { algorithm: 'sha256', digest: createHash('sha256').update(files.map(item => `${item.file}\0${item.sha256}\n`).join('')).digest('hex'), files };
  };
  const successful = { httpStatus: 200, runStatus: 'success', modelRequests: 1, fixtureToolCalls: 0, persistedSteps: 0, tokens: 30 };
  const scenarios = [
    { id: 'retrieval-ranked', title: 'ranked 检索', contextMode: 'recent', retrievalMode: 'ranked', knowledge: true,
      question: 'billing latency errors', expected: { ...successful, sourceDocuments: 1, sourceSegments: 5, expiredExcluded: true },
      explanation: '同一高分长文档的五个片段占据名额；片段多不等于来源多。' },
    { id: 'retrieval-diverse', title: 'diverse 检索', contextMode: 'recent', retrievalMode: 'diverse', knowledge: true,
      question: 'billing latency errors', expected: { ...successful, sourceDocuments: 3, sourceSegmentsMaximum: 5, perDocumentMaximum: 2, nonOverlapping: true, expiredExcluded: true },
      explanation: '先给不同文档名额，再补同文档非重叠片段；最多五段并不要求填满五段。覆盖增加不代表答案更准确。' },
    { id: 'history-recent', title: 'recent 保留历史', contextMode: 'recent', retrievalMode: 'ranked', history: true,
      question: '继续检查刚才任务。', expected: { ...successful, candidateMessages: 29, databaseTaskIdPresent: true, requestTaskIdPresent: true, retainedTurns: 14, completeTurns: true, currentQuestionWhole: true },
      explanation: '任务 ID 只在最早历史轮次出现。当前 29 条候选消息仍在最近 30 条窗口内，所以 recent 会把它送入模型请求。' },
    { id: 'history-budgeted', title: 'budgeted 省略旧 ID', contextMode: 'budgeted', retrievalMode: 'ranked', history: true,
      question: '继续检查刚才任务。', expected: { ...successful, candidateMessages: 29, databaseTaskIdPresent: true, requestTaskIdPresent: false, historyOmitted: true, completeTurns: true, currentQuestionWhole: true, omissionNoticePresent: true, budgetBytes: 8000 },
      explanation: '8000 字节预算移除包含任务 ID 的完整旧轮次。数据库仍保留 ID，模型这次输入却不再包含它；省略提醒不是自动恢复记忆。' },
    { id: 'history-current-id', title: '当前问题补回 ID', contextMode: 'budgeted', retrievalMode: 'ranked', history: true,
      question: `继续检查任务 ${taskId}。`, expected: { ...successful, candidateMessages: 29, databaseTaskIdPresent: true, requestTaskIdPresent: true, historyOmitted: true, completeTurns: true, currentQuestionWhole: true, omissionNoticePresent: true, budgetBytes: 8000 },
      explanation: '只改变当前问题，明确补回合成任务 ID。旧轮次仍被省略，但当前问题完整保留，使该事实重新进入请求。' },
    { id: 'mandatory-over-budget', title: '必需输入超限', contextMode: 'budgeted', retrievalMode: 'ranked',
      question: '不可截断'.repeat(1000), expected: { httpStatus: 422, runStatus: 'failed', modelRequests: 0, fixtureToolCalls: 0, persistedSteps: 0, tokens: 0, currentQuestionBytes: 12000 },
      explanation: '当前问题本身已有 12000 UTF-8 字节，超过 8000 字节上下文预算。系统在模型请求前拒绝；这个预期拒绝属于实验通过。' },
  ];
  const report = {
    version: 1, command: 'npm run agent:learn:context', mode: 'deterministic-fixture', runtime: 'agentscope', sdkVersion: '2.0.8',
    workerMode, nodeVersion: process.version, startedAt: new Date().toISOString(), completedAt: null, source: null, sourceUnchanged: false,
    isolation: { database: 'one-independent-temporary-database-per-scenario', network: '127.0.0.1-only-model-and-MCP',
      authorizedTools: ['service_status'], modelTools: ['mcp_0'], productionToolsUsed: false, realModelUsed: false },
    measurement: {
      requestBytes: 'UTF-8 bytes of JSON.stringify(actual parsed HTTP model request body); includes model/max_tokens and other request fields',
      contextBytes: 'contextBytes(messages, tools): UTF-8 bytes of JSON.stringify([...messages, { tools }]); distinct from requestBytes',
      sourceOffsets: 'JavaScript string offsets and lengths in the indexed synthetic document; not UTF-8 byte offsets',
      tokens: '30 fixed fixture tokens per model request, persisted in executions.tokens; zero when no model request occurs',
    },
    limitations: [
      '真实 AgentScope 2.0.8 / prefork 只证明本地编排和输入装配；模型答案由 fixture 固定，不评价真实诊断质量、是否主动追问、引用准确率或生产收益。',
      '检索使用合成知识与当前 SQLite FTS5/字符串评分；不同来源覆盖增加不表示相关性或质量提升，没有向量库、语义重写或外部 reranker。',
      '历史先取最近 30 条 user/assistant，再在这个窗口内按完整 user 轮次裁剪。本实验历史候选为 29 条，不测窗口之外的丢失；省略统计也不包含窗口外消息。',
      '预算裁剪不总结旧事实，不裁剪系统指令、已选知识、工具定义或当前问题。当前轮工具/Responses reasoning 的完整性由其他既有测试覆盖，本实验不调用工具。',
      '每场景独立临时数据库和本机服务；production 只是共享 fixture 的本地策略标签。只授权 service_status schema，实际 MCP 调用和持久工具步骤必须均为零。',
      '只保存计数、角色/合成轮次标记、ID 是否可见、知识片段位置和摘要，不保存提示正文、消息正文、工具正文、密钥或私有推理。',
      `源码摘要仅读取固定的 ${sourceFiles.length} 个项目文件，不读取 .env、.data、真实供应商配置或用户凭据。请求字节变化不是 token 省费测量。`,
    ], results: [], comparisons: null, failures: [], passed: false,
  };
  // Set every relevant provider, governance, and worker option before importing
  // the fixture. A temporary dataDir is supplied by runtimeFixture itself.
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
  try {
    report.source = fingerprint();
    const { runtimeFixture, answer } = await import('../tests/runtime-fixture.mjs');
    const { defaultPython } = await import('../server/agent-runtime/agentscope.mjs');
    const { runtimeOptions } = await import('../server/agent-runtime/index.mjs');
    const { contextBytes } = await import('../server/agent-context.mjs');
    const { validateEnvironment } = await import('../server/security.mjs');
    validateEnvironment();
    for (const scenario of scenarios) {
      const runtime = runtimeOptions({ runtime: 'agentscope', workerMode, python: defaultPython,
        contextMode: scenario.contextMode, retrievalMode: scenario.retrievalMode, evidenceReports: false, contextMaxBytes: 8000,
        poolSize: 1, poolMaxRuns: 100, poolMaxAgeMs: 1800000, startupTimeoutMs: 15000, poolQueueMs: 30000, poolMaxPending: 100 });
      const result = { id: scenario.id, title: scenario.title, explanation: scenario.explanation,
        configuration: { contextMode: scenario.contextMode, retrievalMode: scenario.retrievalMode, contextMaxBytes: 8000, useKnowledge: !!scenario.knowledge },
        expected: scenario.expected, actual: null, requests: [], passed: false, failures: [] };
      report.results.push(result);
      let h;
      let phase = '初始化本地 fixture';
      try {
        h = await runtimeFixture(runtime);
        phase = '核对本地配置并收紧只读工具目录';
        const model = await h.request('/settings/model');
        assert.equal(model.status, 200, '必须能够读取本地模型配置');
        assert.equal(model.data.configured, true, '必须已保存本地模型配置');
        assert.equal(new URL(model.data.baseUrl).hostname, '127.0.0.1', '模型地址必须是本机 fixture');
        assert.equal(new URL(h.resource.endpoint).hostname, '127.0.0.1', 'MCP 地址必须是本机 fixture');
        const readonly = await h.request(`/resources/${h.resource.id}`, { ...h.resource,
          allowedTools: ['service_status'], toolPolicies: { service_status: h.resource.toolPolicies.service_status } }, 'PUT');
        assert.equal(readonly.status, 200, '必须成功保存只读工具目录');
        assert.deepEqual(readonly.data.allowedTools, ['service_status'], '只允许单一只读工具');
        assert.deepEqual(Object.keys(readonly.data.toolPolicies), ['service_status'], '必须移除写工具策略');
        assert.equal(readonly.data.toolPolicies.service_status.risk, 'read', '必须使用只读策略');

        phase = '准备合成知识或历史';
        const documents = new Map();
        if (scenario.knowledge) {
          for (const [label, name, body, extra] of [
            ['long', 'billing latency errors', 'billing latency errors '.repeat(240), {}],
            ['network', 'network', 'billing network evidence', {}],
            ['database', 'database', 'latency database evidence', {}],
            ['expired', 'billing latency errors expired', 'billing latency errors expired evidence', { expiresAt: '2000-01-01T00:00:00Z' }],
          ]) {
            const resource = await h.request('/resources', { kind: 'knowledge', name, body, documentVersion: 'context-lab-v1', ...extra });
            assert.equal(resource.status, 201, '合成知识必须成功创建并建立索引');
            documents.set(resource.data.id, label);
          }
        }
        const seededHistory = [];
        let conversationId;
        if (scenario.history) {
          conversationId = randomUUID();
          const created = new Date().toISOString();
          h.app.store.run('INSERT INTO conversations(id,user_id,title,created,updated) VALUES(?,?,?,?,?)', conversationId, h.user.id, '上下文学习实验', created, created);
          for (let turn = 0; turn < 14; turn++) for (const role of ['user', 'assistant']) {
            const content = `[LAB_TURN_${String(turn).padStart(2, '0')}_${role.toUpperCase()}] `
              + (turn === 0 && role === 'user' ? `合成任务 ${taskId}。 ` : '') + 'history '.repeat(80);
            seededHistory.push({ role, content });
            h.app.store.run('INSERT INTO messages(conversation_id,role,content,metadata,created) VALUES(?,?,?,?,?)', conversationId, role, content, '{}', created);
          }
        }
        phase = '预热真实 AgentScope SDK';
        await h.app.engine.warmup();
        assert.equal(h.app.engine.health().mode, workerMode, '必须使用固定 prefork 模式');
        h.model((req, res) => {
          const messages = req.body.messages || [];
          const tools = req.body.tools || [];
          const prior = messages.slice(1, -1);
          const markers = prior.map(message => {
            const match = /^\[LAB_TURN_(\d{2})_(USER|ASSISTANT)\]/.exec(message.content || '');
            return { role: message.role, turn: match ? Number(match[1]) : null, markerRoleMatches: !!match && match[2].toLowerCase() === message.role };
          });
          const candidateHistory = scenario.history ? h.app.store.all("SELECT role,content FROM messages WHERE conversation_id=? AND role IN ('user','assistant') ORDER BY seq DESC LIMIT 30", conversationId).reverse() : null;
          result.requests.push({ request: result.requests.length + 1, messageRoles: messages.map(message => message.role),
            authorizedAliases: tools.map(tool => tool.function?.name), requestBytes: Buffer.byteLength(JSON.stringify(req.body)),
            contextBytes: contextBytes(messages, tools), requestTaskIdPresent: messages.some(message => typeof message.content === 'string' && message.content.includes(taskId)),
            currentQuestionWhole: messages.at(-1)?.role === 'user' && messages.at(-1)?.content === scenario.question,
            omissionNoticePresent: /本轮因上下文预算省略了 \d+ 条较早历史消息/.test(messages[0]?.content || ''),
            historyMarkers: markers, retainedMessagesWhole: prior.every(message => seededHistory.some(original => original.role === message.role && original.content === message.content)),
            candidateMessages: candidateHistory?.length ?? null, candidateTaskIdPresent: candidateHistory?.some(message => message.content.includes(taskId)) ?? null,
            decision: 'fixed_final_answer_no_tool_request' });
          return answer(res, null, '本地受控输入观测已完成；此回答不评估真实模型质量。');
        });

        phase = '执行场景并核对请求、来源与持久台账';
        const response = await h.request('/chat', { text: scenario.question, requestKey: `context-lab-${scenario.id}`,
          useKnowledge: !!scenario.knowledge, reviewMode: 'off', ...(conversationId ? { conversationId } : {}) });
        const run = h.app.store.get('SELECT id,status,tokens,runtime,runtime_version FROM executions WHERE request_key=?', `context-lab-${scenario.id}`);
        const persistedSteps = run ? h.app.store.get('SELECT COUNT(*) AS count FROM tool_steps WHERE run_id=?', run.id).count : 0;
        const first = result.requests[0];
        const sources = (response.data.metadata?.sources || []).map(source => {
          const chunk = h.app.store.get('SELECT content FROM knowledge_chunks WHERE resource_id=? AND offset=?', source.resourceId, source.offset);
          return { resourceId: source.resourceId, document: documents.get(source.resourceId) || 'unknown', offset: source.offset,
            length: chunk?.content.length ?? null, score: source.score, documentVersion: source.documentVersion,
            presentInSystemInput: !!chunk && h.requests[0]?.messages[0]?.content.includes(chunk.content) === true };
        });
        const context = response.data.metadata?.context || null;
        const priorMarkers = first?.historyMarkers || [];
        const completeTurns = priorMarkers.length % 2 === 0 && priorMarkers.every((marker, index) => marker.markerRoleMatches && marker.turn !== null
          && marker.role === (index % 2 ? 'assistant' : 'user') && (index % 2 === 0 || marker.turn === priorMarkers[index - 1].turn));
        const databaseSeeded = scenario.history ? h.app.store.all('SELECT role,content FROM messages WHERE conversation_id=? ORDER BY seq', conversationId)
          .filter(message => /^\[LAB_TURN_\d{2}_(USER|ASSISTANT)\]/.test(message.content)) : [];
        result.actual = {
          httpStatus: response.status, runId: run?.id || null, runStatus: run?.status || null, runtime: run?.runtime || null,
          runtimeVersion: run?.runtime_version || null, workerMode: h.app.engine.health().mode,
          modelRequests: h.requests.length, fixtureToolCalls: h.fixtures.toolCalls.length, persistedSteps, tokens: run?.tokens ?? null, usageSource: 'executions.tokens',
          currentQuestionBytes: Buffer.byteLength(scenario.question), firstRequestBytes: first?.requestBytes ?? null,
          firstContextBytes: first?.contextBytes ?? null, context, sourceSegments: sources.length,
          sourceDocuments: new Set(sources.map(source => source.resourceId)).size, sources,
          expiredExcluded: sources.every(source => source.document !== 'expired'),
          nonOverlapping: sources.every(source => sources.filter(other => other !== source && other.resourceId === source.resourceId)
            .every(other => source.offset + source.length <= other.offset || other.offset + other.length <= source.offset)),
          history: scenario.history ? { databaseSeededMessages: databaseSeeded.length, databaseTaskIdPresent: databaseSeeded.some(message => message.content.includes(taskId)),
            candidateMessages: first?.candidateMessages ?? null, candidateTaskIdPresent: first?.candidateTaskIdPresent ?? null,
            requestTaskIdPresent: first?.requestTaskIdPresent ?? null, retainedTurns: priorMarkers.length / 2,
            historyOmitted: priorMarkers.length < seededHistory.length, completeTurns, retainedMessagesWhole: first?.retainedMessagesWhole ?? null,
            currentQuestionWhole: first?.currentQuestionWhole ?? null, omissionNoticePresent: first?.omissionNoticePresent ?? null } : null,
        };
        for (const field of ['httpStatus', 'runStatus', 'modelRequests', 'fixtureToolCalls', 'persistedSteps', 'tokens']) {
          assert.equal(result.actual[field], scenario.expected[field], `实测 ${field} 必须符合场景预期`);
        }
        assert.equal(run?.runtime, 'agentscope', '执行台账必须使用真实 AgentScope 路径');
        assert.equal(run?.runtime_version, '2.0.8/bridge-v2-prefork', '执行台账版本必须与固定 SDK 和模式一致');
        assert.equal(result.requests.length, h.requests.length, '每个实际模型请求必须有一条结构观测');
        for (const request of result.requests) {
          assert.deepEqual(request.authorizedAliases, ['mcp_0'], '每个模型请求只允许单一只读工具别名');
          assert.equal(request.currentQuestionWhole, true, '当前问题必须完整保留');
          assert.equal(request.messageRoles[0], 'system', '初始消息必须以系统指令开始');
          assert.ok(!request.messageRoles.includes('tool'), '本实验不能包含实际工具结果');
        }
        if (scenario.knowledge) {
          assert.equal(result.actual.sourceDocuments, scenario.expected.sourceDocuments, '检索文档覆盖必须符合独立模式预期');
          assert.equal(result.actual.expiredExcluded, true, '过期知识必须被排除');
          assert.ok(sources.every(source => source.document !== 'unknown' && Number.isInteger(source.length) && source.length > 0 && source.presentInSystemInput), '来源片段必须来自合成索引并实际进入系统输入');
          assert.ok(sources.every(source => source.documentVersion === 'context-lab-v1'), '来源必须保留文档版本');
          if (scenario.retrievalMode === 'ranked') assert.equal(sources.length, 5, 'ranked 场景必须选中五个片段');
          else {
            assert.ok(sources.length <= 5, 'diverse 不得超过五个片段');
            assert.equal(result.actual.nonOverlapping, true, 'diverse 同文档片段不得重叠');
            assert.ok(sources.every(source => sources.filter(other => other.resourceId === source.resourceId).length <= 2), 'diverse 每文档最多两个片段');
          }
        } else assert.equal(sources.length, 0, '关闭知识的场景不能包含检索来源');
        if (scenario.history) {
          const history = result.actual.history;
          for (const field of ['candidateMessages', 'databaseTaskIdPresent', 'requestTaskIdPresent', 'completeTurns', 'currentQuestionWhole']) {
            assert.equal(history[field], scenario.expected[field], `历史观测 ${field} 必须符合预期`);
          }
          assert.equal(history.databaseSeededMessages, 28, '全部原始合成历史仍须保存在临时数据库');
          assert.equal(history.candidateTaskIdPresent, true, '任务 ID 必须在最近三十条候选窗口内，避免与窗口丢失混淆');
          assert.equal(history.retainedMessagesWhole, true, '保留的历史消息不能被截断或改写');
          const retainedIds = priorMarkers.filter(marker => marker.role === 'user').map(marker => marker.turn);
          assert.deepEqual(retainedIds, Array.from({ length: retainedIds.length }, (_, index) => 14 - retainedIds.length + index), '保留历史必须是原始轮次的连续后缀');
          if (scenario.contextMode === 'recent') {
            assert.equal(history.retainedTurns, 14, 'recent 必须保留全部十四轮候选历史');
            assert.equal(context, null, 'recent 不产生预算裁剪统计');
            assert.equal(history.omissionNoticePresent, false, '未裁剪场景不能声称省略历史');
          } else {
            assert.equal(history.historyOmitted, true, '预算必须实际省略旧轮次');
            assert.equal(history.omissionNoticePresent, true, '省略旧历史必须明确告知模型');
            assert.ok(!retainedIds.includes(0), '包含旧任务 ID 的第一轮必须已被省略');
            assert.equal(context?.consideredMessages, 29, '预算统计必须限定为二十九条候选消息');
            assert.equal(context?.budgetBytes, 8000, '本实验历史预算固定为八千字节');
            assert.equal(context?.retainedMessages, priorMarkers.length + 1, '统计保留消息数必须与实际模型输入一致');
            assert.equal(context?.omittedMessages, 28 - priorMarkers.length, '省略统计必须与完整旧轮次一致');
            assert.equal(context?.afterBytes, first.contextBytes, '预算字节必须与实际上下文口径一致');
            assert.ok(context.afterBytes <= 8000 && context.beforeBytes > context.afterBytes, '预算必须下降并满足上限');
          }
        }
        if (scenario.id === 'mandatory-over-budget') {
          assert.equal(result.actual.currentQuestionBytes, 12000, '拒绝场景的当前输入固定为一万二千字节');
          assert.equal(first, undefined, '必需输入超限不得发送模型请求');
        }
        result.passed = true;
      } catch (error) {
        result.failures.push(`${phase}：${safeError(error)}`);
      } finally {
        if (h) {
          try { await h.close(); }
          catch (error) { result.failures.push(`临时 fixture 清理失败：${safeError(error)}`); result.passed = false; }
        }
      }
    }
    const recent = report.results.find(result => result.id === 'history-recent');
    const budgeted = report.results.find(result => result.id === 'history-budgeted');
    if (recent?.passed && budgeted?.passed) {
      assert.ok(budgeted.actual.firstRequestBytes < recent.actual.firstRequestBytes, '相同历史输入的预算场景必须减少实际请求体字节');
      report.comparisons = { recentRequestBytes: recent.actual.firstRequestBytes, budgetedRequestBytes: budgeted.actual.firstRequestBytes,
        requestBytesSaved: recent.actual.firstRequestBytes - budgeted.actual.firstRequestBytes,
        savedRatio: Number((1 - budgeted.actual.firstRequestBytes / recent.actual.firstRequestBytes).toFixed(4)),
        recentContextBytes: recent.actual.firstContextBytes, budgetedContextBytes: budgeted.actual.firstContextBytes,
        modelRequestsUnchanged: recent.actual.modelRequests === budgeted.actual.modelRequests,
        realTokenSavingsMeasured: false };
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
    report.summary = { passed: report.results.filter(result => result.passed).length, total: scenarios.length };
    report.passed = report.results.length === scenarios.length && report.results.every(result => result.passed) && report.failures.length === 0;
    mkdirSync(outputDirectory, { recursive: true });
    writeFileSync(join(outputDirectory, 'context-lab.json'), JSON.stringify(report, null, 2) + '\n');
    writeFileSync(join(outputDirectory, 'context-lab.md'), markdown(report));
  }
  console.log(`上下文学习实验：${report.summary.passed}/${report.summary.total} 场景通过（${workerMode}，AgentScope ${report.sdkVersion}）。`);
  console.log(`报告：${join(outputDirectory, 'context-lab.md')}\n结构化数据：${join(outputDirectory, 'context-lab.json')}`);
  for (const result of report.results) for (const failure of result.failures) console.error(`${result.title}：${failure}`);
  for (const failure of report.failures) console.error(failure);
  if (!report.passed) process.exitCode = 1;
}

function markdown(report) {
  const cell = value => String(value ?? '未取得').replaceAll('|', '\\|').replaceAll('\n', ' ');
  const yes = value => value == null ? '未取得' : value ? '是' : '否';
  const rows = [
    '# 上下文与检索本地学习实验', '',
    `结果：${report.passed ? '通过' : '失败'}；${report.summary.passed}/${report.summary.total} 个场景符合预期。`, '',
    `开始：${report.startedAt}；结束：${report.completedAt}（UTC）。`, '',
    `运行环境：Node ${report.nodeVersion}，AgentScope ${report.sdkVersion}，Worker 模式 ${report.workerMode}。`, '',
    '复现命令：`npm run agent:learn:context`。先完成依赖安装与 `npm run agent:check`。命令不接受参数或真实供应商配置。', '',
    '## 实验边界', '', ...report.limitations.map(item => `- ${item}`), '',
    '## 预期与实际', '',
    '| 场景 | HTTP 预期 / 实际 | run 预期 / 实际 | 模型请求预期 / 实际 | MCP / 持久步骤（预期均 0） | token 预期 / 实际 | 通过 |',
    '| --- | --- | --- | --- | --- | --- | --- |',
    ...report.results.map(item => `| ${item.title} | ${item.expected.httpStatus} / ${cell(item.actual?.httpStatus)} | ${item.expected.runStatus} / ${cell(item.actual?.runStatus)} | ${item.expected.modelRequests} / ${cell(item.actual?.modelRequests)} | ${cell(item.actual?.fixtureToolCalls)} / ${cell(item.actual?.persistedSteps)} | ${item.expected.tokens} / ${cell(item.actual?.tokens)} | ${yes(item.passed)} |`), '',
    '必需输入超限预期为 422 / failed，模型请求为零；是否通过按实测是否符合预期判断。每次模型请求的 30 tokens 是 fixture 固定值，不是 tokenizer 或真实计费测量。', '',
    '## 两种字节口径', '',
    '“请求体字节”来自实际模型 HTTP 请求 JSON，包含 model、max_tokens 等字段。“上下文字节”来自 contextBytes(messages, tools)，只按消息与工具的特定 JSON 结构计算；二者不得混作同一数值。知识 offset/长度使用 JavaScript 字符串位置，不是 UTF-8 字节位置。', '',
    '| 场景 | 首次请求体字节 | 首次上下文字节 | 预算 before / after / 上限 |',
    '| --- | --- | --- | --- |',
    ...report.results.map(item => `| ${item.title} | ${cell(item.actual?.firstRequestBytes)} | ${cell(item.actual?.firstContextBytes)} | ${item.actual?.context ? `${item.actual.context.beforeBytes} / ${item.actual.context.afterBytes} / ${item.actual.context.budgetBytes}` : '无预算统计'} |`), '',
  ];
  if (report.comparisons) rows.push(`同一历史与当前问题的请求体从 ${report.comparisons.recentRequestBytes} 变为 ${report.comparisons.budgetedRequestBytes} 字节，减少 ${report.comparisons.requestBytesSaved} 字节（${(report.comparisons.savedRatio * 100).toFixed(2)}%）。两者模型请求数不变：${yes(report.comparisons.modelRequestsUnchanged)}；没有测量真实 token 节约。`, '');
  for (const item of report.results) {
    rows.push(`## ${item.title}`, '', item.explanation, '',
      `配置：contextMode=${item.configuration.contextMode}；retrievalMode=${item.configuration.retrievalMode}；contextMaxBytes=${item.configuration.contextMaxBytes}；useKnowledge=${item.configuration.useKnowledge}。`, '',
      `持久运行：${cell(item.actual?.runId)}；运行时版本：${cell(item.actual?.runtimeVersion)}。`, '');
    if (item.configuration.useKnowledge) rows.push(
      `来源文档：预期 ${item.expected.sourceDocuments}，实际 ${cell(item.actual?.sourceDocuments)}；片段：预期 ${item.expected.sourceSegments ?? `最多 ${item.expected.sourceSegmentsMaximum}`}，实际 ${cell(item.actual?.sourceSegments)}；过期文档已排除：${yes(item.actual?.expiredExcluded)}；同文档片段不重叠：${yes(item.actual?.nonOverlapping)}。`, '',
      '| 合成文档 | offset | 长度 | 字符串评分 | 文档版本 | 已进入 system 输入 |',
      '| --- | --- | --- | --- | --- | --- |',
      ...(item.actual?.sources || []).map(source => `| ${source.document} | ${source.offset} | ${cell(source.length)} | ${source.score} | ${source.documentVersion} | ${yes(source.presentInSystemInput)} |`), '');
    if (item.actual?.history) {
      const history = item.actual.history;
      rows.push('| 历史观测 | 实际 |', '| --- | --- |',
        `| 数据库原始历史消息 | ${history.databaseSeededMessages} |`,
        `| 最近 30 条窗口内候选消息 | ${history.candidateMessages} |`,
        `| 数据库仍有旧任务 ID | ${yes(history.databaseTaskIdPresent)} |`,
        `| 窗口候选中仍有任务 ID | ${yes(history.candidateTaskIdPresent)} |`,
        `| 实际模型请求可见任务 ID（预期 ${yes(item.expected.requestTaskIdPresent)}） | ${yes(history.requestTaskIdPresent)} |`,
        `| 保留历史轮次 | ${history.retainedTurns} |`,
        `| 旧轮次成对保留 / 消息未改写 | ${yes(history.completeTurns)} / ${yes(history.retainedMessagesWhole)} |`,
        `| 当前问题完整 / 省略提醒进入 system | ${yes(history.currentQuestionWhole)} / ${yes(history.omissionNoticePresent)} |`, '');
    }
    if (item.requests.length) rows.push('| 模型请求 | 角色顺序 | 保留的合成轮次标记 | 受控回答 |', '| --- | --- | --- | --- |',
      ...item.requests.map(request => `| ${request.request} | ${request.messageRoles.join(' → ')} | ${request.historyMarkers.length ? request.historyMarkers.map(marker => `${marker.role}/${cell(marker.turn)}`).join(' → ') : '无旧历史'} | 固定终态，不请求工具 |`), '');
    else rows.push('没有观测到实际模型请求。', '');
    if (item.failures.length) rows.push('失败原因：', '', ...item.failures.map(failure => `- ${cell(failure)}`), '');
  }
  if (report.failures.length) rows.push('## 报告级失败', '', ...report.failures.map(failure => `- ${cell(failure)}`), '');
  rows.push('## 对应源码', '',
    '- `server/agent.mjs`：过滤授权资源、装配知识，先读取最近 30 条消息，再调用 prepareContext。',
    '- `server/agent-context.mjs`：按完整 user 轮次与 UTF-8 JSON 预算裁剪，保留当前问题，必需输入超限时拒绝。',
    '- `server/retrieval.mjs` / `server/governance.mjs`：FTS5 候选、字符串评分、不同文档/非重叠片段与知识索引。',
    '- `tests/runtime-fixture.mjs`：独立临时工作空间和本机模型/MCP；`scripts/evaluate-agent-enhancements.mjs` 保留更完整的增强矩阵。', '',
    '## 源码 SHA256', '', `合并摘要：\`${cell(report.source?.digest)}\`。运行期间源码${report.sourceUnchanged ? '未变化' : '未确认一致'}。`, '',
    '| 固定白名单文件 | SHA256 |', '| --- | --- |', ...(report.source?.files || []).map(item => `| ${item.file} | ${item.sha256} |`), '');
  return rows.join('\n');
}
