import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

if (process.argv.length > 2) {
  console.error('本实验不接受参数；请直接运行 npm run agent:learn:unknown。--real 和外部配置均不受支持。');
  process.exitCode = 1;
} else {
  await main().catch(error => {
    console.error(`写入结果未知实验无法完成：${safeError(error)}`);
    process.exitCode = 1;
  });
}

function safeError(error) {
  if (error?.code === 'ERR_ASSERTION') return String(error.message).split('\n')[0].slice(0, 300);
  return `阶段失败（${/^[A-Z0-9_]+$/.test(error?.code || '') ? error.code : 'LAB_ERROR'}）；请核对本地实验环境。`;
}

function bounded(promise, milliseconds = 10000) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(Object.assign(new Error('本地实验等待超时'), { code: 'LAB_TIMEOUT' })), milliseconds);
    Promise.resolve(promise).then(value => { clearTimeout(timer); resolve(value); }, error => { clearTimeout(timer); reject(error); });
  });
}

// One proxy serves all four fault modes. It counts every incoming write before
// the upstream fixture's idempotency handling can hide a repeated request.
async function createProxy(h, express, listen) {
  let mode = 'pass', closing = false, triggered = false, enter, release;
  const reached = new Promise(resolve => { enter = resolve; });
  const held = new Promise(resolve => { release = resolve; });
  const controller = new AbortController();
  const counts = { writeRequests: 0, forwardedWriteRequests: 0, readRequests: 0, forwardedReadRequests: 0,
    upstreamWriteResponses: 0, droppedWriteResponses: 0, deliveredWriteResponses: 0, proxyFailures: 0 };
  const observedWriteKeys = [];
  const app = express(); app.use(express.json());
  app.post('/mcp', async (req, res) => {
    const write = req.body.method === 'tools/call' && req.body.params?.name === 'set_service_state';
    const read = req.body.method === 'tools/call' && req.body.params?.name === 'service_status';
    if (write) { counts.writeRequests++; observedWriteKeys.push(req.body.params.arguments?.idempotencyKey); }
    if (read) counts.readRequests++;
    try {
      if (!triggered && mode === 'hold-discovery' && req.body.method === 'tools/list') {
        triggered = true; enter(); await held;
      }
      if (closing || res.destroyed) return;
      if (write) counts.forwardedWriteRequests++;
      if (read) counts.forwardedReadRequests++;
      const upstream = await fetch(h.fixtures.url + '/mcp', { method: 'POST', headers: {
        'Content-Type': 'application/json', Accept: 'application/json, text/event-stream', Authorization: 'Bearer fixture-mcp-secret',
      }, body: JSON.stringify(req.body), signal: AbortSignal.any([controller.signal, AbortSignal.timeout(5000)]) });
      const body = await upstream.text();
      if (write) counts.upstreamWriteResponses++;
      if (!triggered && write && ['drop-write-response', 'hold-write-response'].includes(mode)) {
        triggered = true;
        // The complete upstream response has already arrived. This is a real
        // transport interruption, not the fixture's isError response mode.
        if (mode === 'drop-write-response') {
          counts.droppedWriteResponses++; enter(); res.destroy(); return;
        }
        enter(); await held;
      }
      if (closing || res.destroyed) return;
      if (write) counts.deliveredWriteResponses++;
      res.status(upstream.status).type(upstream.headers.get('content-type') || 'application/json').send(body);
    } catch {
      if (!closing && !res.destroyed) {
        counts.proxyFailures++;
        res.status(502).json({ error: '本地实验代理未能完成转发' });
      }
    }
  });
  app.get('/mcp', (req, res) => res.sendStatus(405));
  app.delete('/mcp', (req, res) => res.sendStatus(405));
  const server = await listen(app);
  return { url: server.url, counts, observedWriteKeys,
    arm: next => { assert.equal(mode, 'pass', '每个独立场景只能启用一次故障屏障'); mode = next; },
    wait: () => bounded(reached, 5000),
    close: async () => { closing = true; controller.abort(); release(); await server.close(); },
  };
}

async function main() {
  const root = fileURLToPath(new URL('..', import.meta.url));
  const outputDirectory = join(root, 'test-results', 'learning');
  const sourceFiles = [
    'scripts/learn-agent-unknown.mjs', 'tests/runtime-fixture.mjs', 'tests/fixtures.mjs',
    'server/app.mjs', 'server/auth.mjs', 'server/execution.mjs', 'server/governance.mjs',
    'server/mcp.mjs', 'server/resources.mjs', 'server/security.mjs', 'server/store.mjs',
    'server/notifications.mjs', 'server/agent-runtime/index.mjs',
  ].sort();
  const fingerprint = () => {
    const files = sourceFiles.map(file => ({ file, sha256: createHash('sha256').update(readFileSync(join(root, file))).digest('hex') }));
    return { algorithm: 'sha256', digest: createHash('sha256').update(files.map(item => `${item.file}\0${item.sha256}\n`).join('')).digest('hex'), files };
  };
  const scenarios = [
    { id: 'failure-before-send', title: '发送前失败', mode: 'pass',
      expected: { approvalHttpStatus: 409, runStatus: 'failed', stepStatus: 'failed', writeRequests: 0, appliedWrites: 0, readRequests: 0 },
      explanation: '固定计划保存后修改资源修订；审批执行前的版本复查拒绝旧计划，未发送写请求。' },
    { id: 'lost-write-response', title: '写入后丢失回包，再只读对账', mode: 'drop-write-response',
      expected: { approvalHttpStatus: 500, runStatus: 'unknown', stepStatus: 'unknown', writeRequests: 1, appliedWrites: 1, readRequests: 0,
        reconciledHttpStatus: 200, reconciledRunStatus: 'success', reconciledStepStatus: 'success', reconciledReadRequests: 1 },
      explanation: '本地代理取得已应用写入的完整回包后切断返回连接。平台收尾为 unknown；随后只读核验确认目标状态，写请求与应用次数保持一次。' },
    { id: 'cancel-before-send', title: '发送前取消', mode: 'hold-discovery',
      expected: { approvalHttpStatus: 409, runStatus: 'cancelled', stepStatus: 'cancelled', writeRequests: 0, appliedWrites: 0, readRequests: 0 },
      explanation: '审批停在 tools/list 的响应前，尚未发出写请求；接受取消并等待审批收尾后，run 与 step 都为 cancelled。' },
    { id: 'cancel-after-send', title: '写入后取消', mode: 'hold-write-response',
      expected: { approvalHttpStatus: 409, runStatus: 'unknown', stepStatus: 'unknown', writeRequests: 1, appliedWrites: 1, readRequests: 0 },
      explanation: 'fixture 已应用写入并回包，但代理暂不交给执行器；取消只结束等待，不能撤回已发生的变更，收尾仍为 unknown。' },
  ];
  const report = {
    version: 1, command: 'npm run agent:learn:unknown', mode: 'local-deterministic-fault-injection', runtime: 'direct', runtimeVersion: '1',
    nodeVersion: process.version, startedAt: new Date().toISOString(), completedAt: null, source: null, sourceUnchanged: false,
    isolation: { database: 'one-independent-temporary-database-per-scenario', network: '127.0.0.1-only-proxy-and-MCP', environment: 'test',
      allowedTools: ['service_status', 'set_service_state'], target: 'billing', writtenState: 'maintenance', productionToolsUsed: false,
      realModelUsed: false, agentScopeInvoked: false, automaticRemediation: false, modelPricePerMillion: 0, dailyCostLimit: 0 },
    limitations: [
      '所有请求通过固定工具、审批、取消和核验 HTTP API；持久运行必须为 direct/1，模型请求与 tokens 为零。不预热或调用 AgentScope，不能称为真实 SDK 编排实验。',
      '写操作只改变本机 fixture 内存中的合成 billing 状态；test 策略只允许写 maintenance 及对应只读核验，没有真实 DTS、生产调用、外部通知渠道或供应商请求。',
      'writeRequests 统计代理实际收到的写 tools/call，appliedWrites 统计 fixture 在幂等去重后应用的次数；两者分开，避免把工具端去重误称为平台没有重发。',
      '丢回包场景先取得真实上游响应再破坏回传，没有用 isError 回包代替网络故障。观察器据计数知道已写，平台未收到该响应，因此 unknown 合理。',
      'unknown 通常表示结果需要确认，不能普遍推断已经写入或完全失败。本实验的已写事实来自受控观察器，不是从 unknown 状态推测。',
      '取消 API 返回 200 只表示接受取消。必须等待挂起审批收尾，再读取最终状态；取消不能回滚已经发生的远程副作用。',
      '只读对账确认当前状态符合预设条件，不会重放写操作，也不证明跨网络 exactly-once 或现实业务由哪次请求改变。Runbook 后续步骤恢复不在本实验范围。',
      '在途核验的撤权复查由执行回归单独覆盖，本实验不模拟该并发场景；也未验证真实网络、生产恢复时间或性能。',
      '只导出受控检查点、状态、计数、布尔核对及运行/步骤身份，不保存凭据、完整参数、工具返回正文、提示或私有推理。',
      `源码摘要仅读取固定的 ${sourceFiles.length} 个项目文件，不读取 .env、.data、真实模型配置或用户凭据。`,
      '屏障最多等待五秒，审批/收尾等待有上限。正常结束及初始化成功后的捕获异常会释放屏障、关闭本轮资源；初始化中断和强制终止不保证清理，未做 SIGINT/SIGTERM 验收。',
    ], results: [], failures: [], passed: false,
  };
  const fixedEnvironment = {
    NODE_ENV: 'test', AUTH_MODE: 'local', COOKIE_SECURE: 'false', APP_ORIGIN: '', TRUST_PROXY: '',
    MASTER_KEY_FILE: '', ADMIN_USERNAME: '', ADMIN_PASSWORD: '', SETUP_TOKEN: '',
    MODEL_BASE_URL: '', MODEL_NAME: '', MODEL_API_KEY: '', MODEL_API_TYPE: 'responses',
    MODEL_DATA_POLICY: 'redact', MODEL_PRICE_PER_MILLION: '0', DAILY_COST_LIMIT: '0', OUTBOUND_ALLOWED_ORIGINS: '',
    NOTIFICATION_WEBHOOK_URL: '', NOTIFICATION_WEBHOOK_SECRET: '', ENABLE_AUTO_REMEDIATION: 'false',
    AGENT_RUNTIME: 'agentscope', AGENTSCOPE_AGENT_IDS: '', AGENTSCOPE_WORKER_MODE: 'prefork',
    RUN_TOKEN_LIMIT: '100000', DAILY_TOKEN_LIMIT: '1000000', WORKSPACE_DAILY_TOKEN_LIMIT: '10000000',
    DAILY_RUN_LIMIT: '200', RUNS_PER_MINUTE: '20', MODEL_CONTEXT_TOKENS: '32768', MODEL_MAX_TOKENS: '4096', RUN_TIMEOUT_MS: '15000',
    MAX_ACTIVE_RUNS: '2', MAX_USER_RUNS: '2', MAX_PENDING_RUNS: '100', APPROVAL_TTL_MS: '900000',
  };
  const previousEnvironment = new Map(Object.keys(fixedEnvironment).map(key => [key, process.env[key]]));
  Object.assign(process.env, fixedEnvironment);
  try {
    report.source = fingerprint();
    const { default: express } = await import('express');
    const { runtimeFixture } = await import('../tests/runtime-fixture.mjs');
    const { listen } = await import('../tests/fixtures.mjs');
    const { defaultPython } = await import('../server/agent-runtime/agentscope.mjs');
    const { runtimeOptions } = await import('../server/agent-runtime/index.mjs');
    const { validateEnvironment } = await import('../server/security.mjs');
    // This config only initializes the shared application. No warmup/chat is
    // called; all measured executions use the direct fixed-tool HTTP entry.
    const runtime = runtimeOptions({ runtime: 'agentscope', workerMode: 'prefork', python: defaultPython,
      contextMode: 'recent', retrievalMode: 'ranked', evidenceReports: false, contextMaxBytes: 16000,
      poolSize: 1, poolMaxRuns: 100, poolMaxAgeMs: 1800000, startupTimeoutMs: 15000, poolQueueMs: 30000, poolMaxPending: 100 });
    validateEnvironment();
    for (const scenario of scenarios) {
      const result = { id: scenario.id, title: scenario.title, explanation: scenario.explanation, expected: scenario.expected,
        checkpoints: [], events: [], actual: null, passed: false, failures: [] };
      report.results.push(result);
      let h, proxy, pendingApproval, runId, stepId;
      let phase = '初始化独立本地工作空间';
      try {
        h = await runtimeFixture(runtime);
        assert.equal(new URL(h.fixtures.url).hostname, '127.0.0.1', '上游 MCP 必须绑定本机');
        proxy = await createProxy(h, express, listen);
        phase = '配置 test 环境固定读写工具';
        const updated = await h.request(`/resources/${h.resource.id}`, { ...h.resource, endpoint: proxy.url + '/mcp', environment: 'test',
          allowedTools: ['service_status', 'set_service_state'], toolPolicies: {
            service_status: { risk: 'read', roles: ['admin'], environments: ['test'], constraints: { service: ['billing'] } },
            set_service_state: { risk: 'write', roles: ['admin'], environments: ['test'], constraints: { service: ['billing'], state: ['maintenance'] },
              idempotencyArgument: 'idempotencyKey', verification: { tool: 'service_status', arguments: { service: 'billing' }, path: 'status', equals: 'maintenance' },
              recovery: '仅本地教学数据；真实处置应另行制定并审批恢复计划' },
          } }, 'PUT');
        assert.equal(updated.status, 200, '必须成功保存临时工具策略');
        const resource = updated.data;
        assert.equal(resource.environment, 'test', '资源必须限定 test 环境');
        assert.equal(new URL(resource.endpoint).hostname, '127.0.0.1', '资源必须指向本机代理');
        assert.deepEqual(resource.allowedTools, ['service_status', 'set_service_state'], '只允许固定查询与合成写工具');
        assert.deepEqual(resource.toolPolicies.set_service_state.constraints, { service: ['billing'], state: ['maintenance'] }, '合成写目标必须固定');
        assert.equal(resource.toolPolicies.set_service_state.automatic, false, '不得启用自动处置');
        const snapshot = async (stage, httpStatus) => {
          const response = await h.request(`/executions/${runId}`);
          assert.equal(response.status, 200, '必须可通过 HTTP 回读实际执行台账');
          const view = response.data;
          assert.equal(view.steps.length, 1, '每组只有一个固定写步骤，对账不得新增写步骤');
          const step = view.steps[0];
          const counts = { ...proxy.counts };
          const point = { stage, observedAt: new Date().toISOString(), httpStatus, runId, stepId,
            runtime: view.runtime, runtimeVersion: view.runtime_version, runStatus: view.status, stepStatus: step.status,
            environment: step.environment, tokens: view.tokens, modelRequests: h.requests.length + h.fixtures.requests.length,
            persistedSteps: view.steps.length, ...counts,
            appliedWrites: h.fixtures.toolCalls.filter(tool => tool.name === 'set_service_state').length,
            appliedReads: h.fixtures.toolCalls.filter(tool => tool.name === 'service_status').length,
            verificationMatches: step.verification?.matches ?? null, resultPresent: view.result != null,
            fixedTargetPreserved: step.arguments?.service === 'billing' && step.arguments?.state === 'maintenance',
            idempotencyMatchesStepId: step.arguments?.idempotencyKey === stepId && proxy.observedWriteKeys.every(key => key === stepId),
            slots: h.app.execution.stats() };
          result.checkpoints.push(point);
          assert.equal(point.runtime, 'direct', '固定工具执行必须如实标记 direct');
          assert.equal(point.runtimeVersion, '1', '固定执行器版本必须为 1');
          assert.equal(point.environment, 'test', '所有写步骤必须位于 test 环境');
          assert.equal(point.tokens, 0, '固定执行器不得产生模型用量');
          assert.equal(point.modelRequests, 0, '所有模型 HTTP 端点必须保持零请求');
          assert.equal(point.fixedTargetPreserved, true, '实际持久计划必须保留固定合成目标');
          assert.equal(point.idempotencyMatchesStepId, true, '实际写请求必须使用步骤 ID 作为固定幂等键');
          assert.equal(point.proxyFailures, 0, '不能把意外代理错误当作预设故障');
          assert.ok(h.fixtures.toolCalls.every(tool => ['service_status', 'set_service_state'].includes(tool.name) && tool.service === 'billing'), '所有实际调用必须限定本地合成 billing');
          return point;
        };
        phase = '通过固定工具 HTTP 入口保存待审批计划';
        const proposal = { resourceId: resource.id, tool: 'set_service_state', arguments: { service: 'billing', state: 'maintenance' },
          environment: 'test', requestKey: `unknown-lab-${scenario.id}` };
        const planned = await h.request('/executions/tool', proposal);
        assert.equal(planned.status, 202, '写操作必须先返回待审批计划');
        runId = planned.data.runId; stepId = planned.data.stepId;
        const initial = await snapshot('plan_saved', planned.status);
        assert.equal(initial.runStatus, 'awaiting_approval', '初始 run 必须等待审批');
        assert.equal(initial.stepStatus, 'awaiting_approval', '初始 step 必须等待审批');
        assert.equal(initial.writeRequests, 0, '审批前不得发送写请求');
        assert.equal(initial.appliedWrites, 0, '审批前不得应用写入');
        assert.equal(initial.readRequests, 0, '保存计划只发现目录，不读取业务状态');

        phase = '触发受控故障并等待审批收尾';
        if (scenario.id === 'failure-before-send') {
          const changed = await h.request(`/resources/${resource.id}`, { ...resource, description: '合成资源修订已变化，旧计划需重新制定' }, 'PUT');
          assert.equal(changed.status, 200, '必须成功制造计划后的资源修订变化');
          assert.ok(changed.data.revision > resource.revision, '资源修订必须实际变化');
        } else proxy.arm(scenario.mode);
        pendingApproval = h.request(`/approvals/${stepId}/approve`, {}, 'POST', h.reviewer);
        pendingApproval.catch(() => {}); // Cleanup also joins this promise if a later assertion fails.
        if (scenario.id.startsWith('cancel-')) {
          await proxy.wait();
          const held = await snapshot('approval_held_at_barrier', null);
          assert.equal(held.runStatus, 'running', '屏障处执行必须仍在 running');
          assert.equal(held.stepStatus, 'executing', '屏障处步骤必须仍在 executing');
          assert.equal(held.writeRequests, scenario.expected.writeRequests, '取消位置的写请求次数必须符合发送边界');
          assert.equal(held.appliedWrites, scenario.expected.appliedWrites, '取消位置必须核对 fixture 实际应用次数');
          if (scenario.id === 'cancel-after-send') assert.equal(held.upstreamWriteResponses, 1, '取消前观察器必须已收到上游写响应');
          const cancelled = await h.request(`/executions/${runId}/cancel`, {});
          assert.equal(cancelled.status, 200, '取消 API 必须接受当前请求');
          result.events.push({ event: 'cancel_accepted', at: new Date().toISOString(), httpStatus: cancelled.status, finalStateConfirmed: false });
        } else if (scenario.id === 'lost-write-response') await proxy.wait();
        const approved = await bounded(pendingApproval);
        pendingApproval = null;
        const settled = await snapshot('approval_settled', approved.status);
        result.actual = { approvalHttpStatus: approved.status, runStatus: settled.runStatus, stepStatus: settled.stepStatus,
          writeRequests: settled.writeRequests, appliedWrites: settled.appliedWrites, readRequests: settled.readRequests,
          modelRequests: settled.modelRequests, tokens: settled.tokens, runtime: settled.runtime, runtimeVersion: settled.runtimeVersion,
          resultPresent: settled.resultPresent, cancellationExplained: scenario.id.startsWith('cancel-') ? /取消/.test(approved.data.error || '') : null };
        for (const field of ['approvalHttpStatus', 'runStatus', 'stepStatus', 'writeRequests', 'appliedWrites', 'readRequests']) {
          assert.equal(result.actual[field], scenario.expected[field], `审批收尾 ${field} 必须符合场景预期`);
        }
        assert.equal(settled.resultPresent, false, '失败、取消和 unknown 收尾不得保留成功结果');
        assert.equal(settled.forwardedWriteRequests, settled.writeRequests, '本实验写请求计数必须与真实上游转发一致');
        assert.equal(settled.deliveredWriteResponses, 0, '这些故障场景不能把正常写响应交给执行器');
        assert.deepEqual(settled.slots, { active: 0, queued: 0 }, '挂起审批收尾后必须释放槽位');
        if (scenario.id.startsWith('cancel-')) assert.equal(result.actual.cancellationExplained, true, '挂起审批必须明确说明取消');
        if (scenario.id === 'lost-write-response') {
          assert.equal(settled.upstreamWriteResponses, 1, '丢回包前必须实际收到上游完整写响应');
          assert.equal(settled.droppedWriteResponses, 1, '必须真实丢弃一次写响应');
          phase = '只读核验 unknown，核对没有重放';
          const reconciled = await bounded(h.request(`/approvals/${stepId}/reconcile`, {}, 'POST', h.reviewer));
          const verified = await snapshot('reconciled_without_write_replay', reconciled.status);
          Object.assign(result.actual, { reconciledHttpStatus: reconciled.status, reconciledRunStatus: verified.runStatus,
            reconciledStepStatus: verified.stepStatus, reconciledReadRequests: verified.readRequests, verificationMatches: verified.verificationMatches });
          for (const field of ['reconciledHttpStatus', 'reconciledRunStatus', 'reconciledStepStatus', 'reconciledReadRequests']) {
            assert.equal(result.actual[field], scenario.expected[field], `只读核验 ${field} 必须符合预期`);
          }
          assert.equal(verified.verificationMatches, true, '只读核验必须确认实际目标状态');
          assert.equal(verified.appliedReads, 1, '必须实际执行一次只读核验');
          assert.equal(verified.writeRequests, settled.writeRequests, '核验不得重新提交写请求');
          assert.equal(verified.appliedWrites, settled.appliedWrites, '核验不得再次应用写入');
          assert.deepEqual(verified.slots, { active: 0, queued: 0 }, '核验结束后必须释放槽位');
        }
        phase = '核对重复审批拒绝且不重发';
        const repeated = await h.request(`/approvals/${stepId}/approve`, {}, 'POST', h.reviewer);
        assert.equal(repeated.status, 409, '已收尾步骤必须拒绝重复审批');
        const final = await snapshot('repeat_approval_rejected', repeated.status);
        assert.equal(final.writeRequests, scenario.expected.writeRequests, '重复审批不得再次发送写请求');
        assert.equal(final.appliedWrites, scenario.expected.appliedWrites, '重复审批不得再次应用写入');
        assert.deepEqual(final.slots, { active: 0, queued: 0 }, '最终槽位必须清空');
        result.actual.repeatApprovalHttpStatus = repeated.status;
        result.passed = true;
      } catch (error) {
        result.failures.push(`${phase}：${safeError(error)}`);
      } finally {
        // Abort execution BEFORE releasing a barrier, so cleanup cannot release
        // a blocked write into the upstream service after an assertion fails.
        h?.app.execution.stop();
        try { await proxy?.close(); }
        catch (error) { result.failures.push(`代理清理失败：${safeError(error)}`); result.passed = false; }
        if (pendingApproval) {
          try { await bounded(pendingApproval.catch(() => {}), 5000); }
          catch (error) { result.failures.push(`挂起审批未完成收尾：${safeError(error)}`); result.passed = false; }
        }
        if (h) {
          try { await h.close(); }
          catch (error) { result.failures.push(`临时工作空间清理失败：${safeError(error)}`); result.passed = false; }
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
    report.summary = { passed: report.results.filter(result => result.passed).length, total: scenarios.length };
    report.passed = report.results.length === scenarios.length && report.results.every(result => result.passed) && report.failures.length === 0;
    mkdirSync(outputDirectory, { recursive: true });
    writeFileSync(join(outputDirectory, 'unknown-lab.json'), JSON.stringify(report, null, 2) + '\n');
    writeFileSync(join(outputDirectory, 'unknown-lab.md'), markdown(report));
  }
  console.log(`写入结果未知实验：${report.summary.passed}/${report.summary.total} 场景符合预期（direct 固定执行器）。`);
  console.log(`报告：${join(outputDirectory, 'unknown-lab.md')}\n结构化数据：${join(outputDirectory, 'unknown-lab.json')}`);
  for (const result of report.results) for (const failure of result.failures) console.error(`${result.title}：${failure}`);
  for (const failure of report.failures) console.error(failure);
  if (!report.passed) process.exitCode = 1;
}

function markdown(report) {
  const cell = value => String(value ?? '未取得 / 不适用').replaceAll('|', '\\|').replaceAll('\n', ' ');
  const yes = value => value == null ? '不适用' : value ? '是' : '否';
  const stages = { plan_saved: '计划已保存', approval_held_at_barrier: '取消前屏障处', approval_settled: '审批已收尾',
    reconciled_without_write_replay: '只读对账已收尾', repeat_approval_rejected: '重复审批已拒绝' };
  const rows = [
    '# 写入后的 unknown：本地故障实验', '',
    `结果：${report.passed ? '通过' : '失败'}；${report.summary.passed}/${report.summary.total} 个场景符合预期。`, '',
    `开始：${report.startedAt}；结束：${report.completedAt}（UTC）。`, '',
    `运行环境：Node ${report.nodeVersion}，持久执行器 ${report.runtime}/${report.runtimeVersion}；模型和 AgentScope 不参与这些固定计划。`, '',
    '复现命令：`npm run agent:learn:unknown`。命令不接受参数或真实模式；只写本机 test fixture 的内存合成状态。', '',
    '## 审批收尾：预期与实际', '',
    '| 场景 | HTTP 预期 / 实际 | run 预期 / 实际 | step 预期 / 实际 | 写请求预期 / 实际 | 应用次数预期 / 实际 | 通过 |',
    '| --- | --- | --- | --- | --- | --- | --- |',
    ...report.results.map(item => `| ${item.title} | ${item.expected.approvalHttpStatus} / ${cell(item.actual?.approvalHttpStatus)} | ${item.expected.runStatus} / ${cell(item.actual?.runStatus)} | ${item.expected.stepStatus} / ${cell(item.actual?.stepStatus)} | ${item.expected.writeRequests} / ${cell(item.actual?.writeRequests)} | ${item.expected.appliedWrites} / ${cell(item.actual?.appliedWrites)} | ${yes(item.passed)} |`), '',
    '表中 HTTP 是挂起审批结束的返回码，不是工具端状态。预期失败、取消和 unknown 均可构成通过的实验；丢回包组随后另做只读对账，不能只看一条 HTTP 错误就推断写入未发生。', '',
    '## 计数口径', '',
    '- 写请求：代理实际收到的 write tools/call 次数，每个请求都计数。',
    '- 应用次数：fixture 经幂等去重后真正修改合成内存状态的次数。',
    '- 读请求 / 读取次数：代理收到的 service_status 请求 / fixture 真正执行读取的次数。',
    '- 对账复用原执行与原写步骤，更新核验字段；一次只读核验不会新增一个持久写步骤。', '',
  ];
  for (const item of report.results) {
    rows.push(`## ${item.title}`, '', item.explanation, '',
      '| 检查点 | HTTP | run / step | 写请求 / 应用 | 读请求 / 读取 | 模型 / token | 核验匹配 | 活跃 / 排队 |',
      '| --- | --- | --- | --- | --- | --- | --- | --- |',
      ...item.checkpoints.map(point => `| ${stages[point.stage]} | ${cell(point.httpStatus)} | ${point.runStatus} / ${point.stepStatus} | ${point.writeRequests} / ${point.appliedWrites} | ${point.readRequests} / ${point.appliedReads} | ${point.modelRequests} / ${point.tokens} | ${yes(point.verificationMatches)} | ${point.slots.active} / ${point.slots.queued} |`), '');
    if (item.events.length) rows.push('取消 API 已返回 200；这仅记录接受请求。上表“审批已收尾”是在挂起审批返回后重新 GET 台账取得，才用于核对最终状态。', '');
    const settled = item.checkpoints.find(point => point.stage === 'approval_settled');
    if (settled) rows.push(`观察器计数：上游完整写响应 ${settled.upstreamWriteResponses}，丢弃写响应 ${settled.droppedWriteResponses}，交回执行器的写响应 ${settled.deliveredWriteResponses}。固定目标和幂等键与持久步骤匹配：${yes(settled.fixedTargetPreserved && settled.idempotencyMatchesStepId)}。`, '',
      `持久运行：${settled.runId}；步骤：${settled.stepId}；环境 ${settled.environment}；运行时 ${settled.runtime}/${settled.runtimeVersion}。`, '');
    if (item.failures.length) rows.push('实验失败原因：', '', ...item.failures.map(failure => `- ${cell(failure)}`), '');
  }
  rows.push('## 如何复盘', '',
    '先分开说明观察器和平台知道的事实：观察器看到一次上游写入和回包，平台却没拿到它；unknown 表示平台需要补证据。然后描述只读对账后的状态匹配，以及写请求和应用次数都没有增加。不要把取消、HTTP 失败、远端去重或目标状态匹配单独当作跨网络只执行一次的证明。', '',
    '本报告是当前本地合成实验，不是生产事故记录，也不代表学习者本人已经复现。真实事故还需确认受影响目标、请求/业务幂等协议、审计与时间线、当前授权，以及经审核的恢复措施。', '',
    '## 证据边界', '', ...report.limitations.map(item => `- ${item}`), '',
    '## 对应源码', '',
    '- `server/execution.mjs`：run / callStep 创建固定计划；executeStep 区分发送边界；approve 收尾；cancel 终止等待；reconcile 只读对账。',
    '- `tests/execution.test.mjs`：既有审批、unknown、取消与代理屏障回归；本脚本复用其思路，没有把 isError 故障伪称为丢回包。',
    '- `tests/runtime-fixture.mjs` / `tests/fixtures.mjs`：临时应用和合成 MCP；本实验不调用其模型接口或 SDK 预热。', '',
    '## 源码 SHA256', '', `合并摘要：\`${cell(report.source?.digest)}\`。运行期间源码${report.sourceUnchanged ? '未变化' : '未确认一致'}。`, '',
    '| 固定白名单文件 | SHA256 |', '| --- | --- |', ...(report.source?.files || []).map(item => `| ${item.file} | ${item.sha256} |`), '');
  if (report.failures.length) rows.push('## 报告级失败', '', ...report.failures.map(failure => `- ${cell(failure)}`), '');
  return rows.join('\n');
}
