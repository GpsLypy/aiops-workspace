import { createHash } from 'node:crypto';
import Ajv from 'ajv';
import { z } from 'zod';
import { id, now, httpError, getResource } from './store.mjs';
import { authorizeTool } from './governance.mjs';
import { connectMcp, discover } from './mcp.mjs';
import { positive, redact } from './security.mjs';
import { admin } from './auth.mjs';
import { assertTargetBinding } from './target-binding.mjs';
import { runTimeoutMs } from './request-policy.mjs';

const terminal = new Set(['success', 'failed', 'interrupted', 'cancelled', 'unknown']);
const hash = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const ajv = new Ajv({ strict: false, allErrors: true });
export function validateArguments(schema, args) {
  let validate; try { validate = ajv.compile(schema); } catch { throw httpError(502, '工具参数规范无法验证'); }
  if (!validate(args)) throw httpError(400, '工具参数不符合已发现的 JSON Schema');
}
function outputValue(response) {
  if (response.structuredContent !== undefined) return response.structuredContent;
  const text = response.content?.find(c => c.type === 'text')?.text;
  try { return JSON.parse(text); } catch { return { text }; }
}
function atPath(value, path) {
  return path.split('.').reduce((v, key) => v && Object.hasOwn(v, key) ? v[key] : undefined, value);
}
function notify(store, kind, payload) {
  store.run('INSERT INTO notifications(id,kind,payload,created) VALUES(?,?,?,?)', id(), kind, JSON.stringify(redact(payload)), now());
}
export function createExecutionService(store) {
  const active = new Map(); const waiting = new Set(); const connectorActive = new Map(); let stopped = false;
  // Never replay a possibly side-effecting request after process failure.
  store.run("UPDATE tool_steps SET status='unknown',error='进程中断，需核对远程结果',updated=? WHERE status='executing'", now());
  store.run("UPDATE executions SET status=CASE WHEN EXISTS(SELECT 1 FROM tool_steps s WHERE s.run_id=executions.id AND s.status='unknown') THEN 'unknown' ELSE 'interrupted' END,error='进程重启，未自动重放',updated=? WHERE status IN ('running','queued')", now());
  store.run("UPDATE agent_delegations SET status='interrupted',error_code='process_interrupted',updated=?,finished=? WHERE status IN ('queued','running')", now(), now());
  function currentUser(user) {
    const latest = store.get('SELECT * FROM users WHERE id=? AND active=1', user.id);
    if (!latest) throw httpError(403, '用户已停用');
    return latest;
  }
  async function connectorSlot(resourceId, signal) {
    const started = Date.now();
    while ((connectorActive.get(resourceId) || 0) >= positive('MAX_MCP_CALLS', 4)) {
      if (signal?.aborted || Date.now() - started > positive('QUEUE_TIMEOUT_MS', 30000)) throw httpError(429, '工具服务并发等待超时或执行已取消');
      await new Promise(resolve => setTimeout(resolve, 25));
    }
    if (signal?.aborted) throw httpError(409, '执行已取消');
    connectorActive.set(resourceId, (connectorActive.get(resourceId) || 0) + 1);
    return () => { const remaining = (connectorActive.get(resourceId) || 1) - 1; if (remaining) connectorActive.set(resourceId, remaining); else connectorActive.delete(resourceId); };
  }
  function available(user) { return active.size < positive('MAX_ACTIVE_RUNS', 8) && [...active.values()].filter(v => v.userId === user.id).length < positive('MAX_USER_RUNS', 2); }
  async function acquire(user, runId) {
    if (active.has(runId) || waiting.has(runId)) throw httpError(409, '此执行正在处理中');
    if (waiting.size >= positive('MAX_PENDING_RUNS', 100)) throw httpError(429, '执行队列已满');
    const controller = new AbortController(); const started = Date.now(); waiting.add(runId);
    try {
      while (!available(user)) {
        if (stopped || store.get('SELECT status FROM executions WHERE id=?', runId)?.status === 'cancelled') throw httpError(409, '执行已取消');
        if (Date.now() - started > positive('QUEUE_TIMEOUT_MS', 30000)) throw httpError(429, '排队超时，请稍后再试');
        await new Promise(resolve => setTimeout(resolve, 25));
      }
      if (stopped || store.get('SELECT status FROM executions WHERE id=?', runId)?.status === 'cancelled') throw httpError(409, '执行已取消');
      currentUser(user); active.set(runId, { userId: user.id, controller }); return controller;
    } finally { waiting.delete(runId); }
  }
  function checkBudget(user, reserved) {
    const since = new Date().toISOString().slice(0, 10);
    const rows = store.all('SELECT user_id,status,tokens,reserved_tokens,cost FROM executions WHERE created>=?', since);
    const userRows = rows.filter(r => r.user_id === user.id);
    const charged = r => terminal.has(r.status) ? r.tokens : Math.max(r.tokens, r.reserved_tokens);
    const total = list => list.reduce((n, r) => n + charged(r), 0);
    if (userRows.length >= positive('DAILY_RUN_LIMIT', 200) || total(userRows) + reserved > positive('DAILY_TOKEN_LIMIT', 1000000) || total(rows) + reserved > positive('WORKSPACE_DAILY_TOKEN_LIMIT', 10000000)) throw httpError(429, '今日执行或 token 预算已用尽');
    const price = Number(process.env.MODEL_PRICE_PER_MILLION || 0);
    const costLimit = Number(process.env.DAILY_COST_LIMIT || 0);
    if (price < 0 || !Number.isFinite(price) || costLimit < 0 || !Number.isFinite(costLimit)) throw httpError(503, '费用配置无效');
    if (costLimit && !price) throw httpError(503, '费用限额需要配置 token 单价');
    if (costLimit && (total(rows) + reserved) * price / 1000000 > costLimit) throw httpError(429, '工作空间费用预算已用尽');
    if (store.get('SELECT count(*) AS n FROM executions WHERE user_id=? AND created>?', user.id, new Date(Date.now() - 60000).toISOString()).n >= positive('RUNS_PER_MINUTE', 20)) throw httpError(429, '提交执行过于频繁');
  }
  async function run(user, input, worker, onAccepted = () => {}) {
    currentUser(user);
    const { requestKey = id(), ...body } = input;
    const digest = hash(body);
    const existing = store.get('SELECT * FROM executions WHERE user_id=? AND request_key=?', user.id, requestKey);
    if (existing) {
      if (existing.input_hash !== digest) throw httpError(409, '幂等键已经用于不同的请求');
      if (existing.result) return JSON.parse(existing.result);
      throw Object.assign(httpError(409, '此请求已受理，请在执行中心查询原执行'), { runId: existing.id });
    }
    const rid = id(); const direct = body.kind === 'tool'; const reserve = direct ? 0 : positive('RUN_TOKEN_LIMIT', 100000);
    store.transaction(() => {
      checkBudget(user, reserve);
      const queued = store.get("SELECT count(*) AS n FROM executions WHERE status IN ('queued','awaiting_approval')").n;
      if (queued >= positive('MAX_PENDING_RUNS', 100)) throw httpError(429, '等待执行或审批的任务已达上限');
      store.run('INSERT INTO executions(id,user_id,request_key,input_hash,input,status,created,updated,reserved_tokens,runtime,runtime_version) VALUES(?,?,?,?,?,?,?,?,?,?,?)', rid, user.id, requestKey, digest, store.encrypt(JSON.stringify(body)), 'queued', now(), now(), reserve, direct ? 'direct' : 'agentscope', direct ? '1' : 'pending');
      store.audit(user, 'execution.create', rid, { kind: body.kind || 'chat' });
    });
    let timer;
    try {
      onAccepted(rid);
      const controller = await acquire(user, rid);
      timer = setTimeout(() => controller.abort(), runTimeoutMs());
      store.run("UPDATE executions SET status='running',updated=? WHERE id=?", now(), rid);
      let reservedModelTokens = 0;
      const context = {
        runId: rid, signal: controller.signal,
        bindConversation: cid => store.run('UPDATE executions SET conversation_id=? WHERE id=?', cid, rid),
        beforeModel: messages => {
          const estimate = Buffer.byteLength(JSON.stringify(messages)) + positive('MODEL_MAX_TOKENS', 4096);
          const spent = store.get('SELECT tokens FROM executions WHERE id=?', rid).tokens;
          if (estimate > positive('MODEL_CONTEXT_TOKENS', 32768) || estimate + spent + reservedModelTokens > reserve) throw httpError(422, '上下文或本轮 token 预算不足，请缩小指令和历史范围');
          reservedModelTokens += estimate;
          return estimate;
        },
        releaseModel: estimate => { reservedModelTokens = Math.max(0, reservedModelTokens - estimate); },
        charge: (usage, estimate) => {
          const reported = Number(usage?.total_tokens);
          const used = Number.isFinite(reported) && reported >= 0 ? Math.ceil(reported) : estimate;
          reservedModelTokens = Math.max(0, reservedModelTokens - estimate);
          store.run('UPDATE executions SET tokens=tokens+?,cost=cost+? WHERE id=?', used, used * Number(process.env.MODEL_PRICE_PER_MILLION || 0) / 1000000, rid);
        },
      };
      const result = { ...await worker(context), runId: rid };
      if (controller.signal.aborted) throw httpError(409, '执行已取消或超时，请检查执行记录');
      const status = result.status || 'success';
      if (!['success', 'awaiting_approval', 'failed', 'unknown'].includes(status)) throw httpError(500, '执行结果状态无效');
      store.run('UPDATE executions SET status=?,result=?,updated=?,reserved_tokens=0 WHERE id=?', status, JSON.stringify(result), now(), rid);
      store.audit(user, 'execution.finish', rid, { status });
      if (status !== 'success') notify(store, status, { runId: rid, userId: user.id });
      return result;
    } catch (error) {
      const unknown = store.get("SELECT id FROM tool_steps WHERE run_id=? AND status='unknown'", rid);
      const cancelled = store.get('SELECT status FROM executions WHERE id=?', rid)?.status === 'cancelled';
      const status = unknown ? 'unknown' : cancelled ? 'cancelled' : 'failed';
      store.run('UPDATE executions SET status=?,error=?,updated=?,reserved_tokens=0 WHERE id=?', status, error.status ? error.message : '执行失败', now(), rid);
      notify(store, status, { runId: rid, userId: user.id });
      throw Object.assign(error, { runId: rid });
    } finally { clearTimeout(timer); active.delete(rid); }
  }
  async function callStep(user, context, resource, tool, args, schema, environment = resource.environment || 'test', automation = null, identity = null) {
    user = currentUser(user); resource = getResource(store, user, resource.id);
    if (store.setting('emergencyStop')?.enabled) throw httpError(503, '紧急停止已启用');
    if (resource.status !== '已启用') throw httpError(403, '工具服务已停用');
    const policy = authorizeTool(user, resource, tool, args, { environment, automated: !!automation });
    if (context.agentCall) assertTargetBinding(context.targetBinding, resource, tool, environment, args, policy);
    if (automation && policy.risk !== 'read' && process.env.ENABLE_AUTO_REMEDIATION !== 'true') throw httpError(403, '自动处置开关未启用');
    let callKey = null, callHash = null;
    if (identity) {
      if (![identity.replyId, identity.callId].every(value => typeof value === 'string' && value.length > 0 && value.length <= 200)) throw httpError(400, '工具调用标识无效');
      const run = store.get('SELECT * FROM executions WHERE id=? AND user_id=?', context.runId, user.id);
      if (!run) throw httpError(403, '执行不存在或不属于当前用户');
      callKey = JSON.stringify([identity.replyId, identity.callId]);
      callHash = hash({ resourceId: resource.id, revision: resource.revision, tool, args, schema, environment, automation });
      const previous = store.get('SELECT * FROM tool_steps WHERE run_id=? AND call_key=?', context.runId, callKey);
      if (previous) {
        if (previous.call_hash !== callHash) throw httpError(409, '工具调用标识已经用于不同的参数或版本');
        if (previous.status === 'awaiting_approval') return { pending: true, stepId: previous.id, recovery: policy.recovery };
        if (previous.status === 'success' && previous.response_encrypted) return { stepId: previous.id, response: JSON.parse(store.decrypt(previous.response_encrypted)) };
        throw httpError(409, '工具请求已经受理，请核对原步骤；不会自动重放');
      }
      if (run.status !== 'running' || context.signal?.aborted) throw httpError(409, '执行已停止');
    }
    const sid = id(); const actualArgs = { ...args };
    if (policy.risk !== 'read') actualArgs[policy.idempotencyArgument] = sid;
    validateArguments(schema, actualArgs);
    const status = policy.risk === 'read' ? 'ready' : automation ? 'approved' : 'awaiting_approval';
    store.run('INSERT INTO tool_steps(id,run_id,resource_id,resource_revision,tool,arguments_encrypted,environment,policy,status,created,updated,expires,call_key,call_hash) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?)', sid, context.runId, resource.id, resource.revision, tool, store.encrypt(JSON.stringify(actualArgs)), environment, JSON.stringify({ ...policy, schemaHash: hash(schema), automation }), status, now(), now(), Date.now() + positive('APPROVAL_TTL_MS', 900000), callKey, callHash);
    store.audit(user, 'tool.plan', context.runId, { stepId: sid, resourceId: resource.id, tool, environment, arguments: actualArgs, risk: policy.risk });
    if (automation) { store.run('UPDATE tool_steps SET approved_by=? WHERE id=?', automation.reviewerId, sid); store.audit(user, 'tool.runbook-authorized', context.runId, { stepId: sid, runbookId: automation.runbookId, reviewerId: automation.reviewerId }); }
    if (status === 'awaiting_approval') return { pending: true, stepId: sid, recovery: policy.recovery };
    return executeStep(sid, user, context.signal, context.traceparent);
  }
  async function executeStep(sid, user, signal, traceparent = null) {
    const step = store.get('SELECT * FROM tool_steps WHERE id=?', sid);
    let connection; let releaseConnector; let sent = false; const policy = JSON.parse(step.policy);
    try {
      user = currentUser(user); const resource = getResource(store, user, step.resource_id);
      if (store.setting('emergencyStop')?.enabled || signal?.aborted) throw httpError(409, '执行已停止');
      if (resource.revision !== step.resource_revision || resource.status !== '已启用' || step.expires < Date.now()) throw httpError(409, '审批已过期或工具配置已改变，请重新制定计划');
      if (policy.risk !== 'read') {
        const approver = store.get('SELECT * FROM users WHERE id=? AND active=1 AND role=?', step.approved_by, 'admin');
        if (!approver) throw httpError(403, '审批人权限已撤销');
      }
      const args = JSON.parse(store.decrypt(step.arguments_encrypted));
      authorizeTool(user, resource, step.tool, args, { environment: step.environment });
      if (!store.run("UPDATE tool_steps SET status='executing',updated=? WHERE id=? AND status IN ('ready','approved')", now(), sid).changes) throw httpError(409, '此步骤已执行或不在可执行状态');
      releaseConnector = await connectorSlot(resource.id, signal);
      connection = await connectMcp(store, resource, signal, traceparent);
      const tools = await discover(connection.client, signal); const tool = tools.find(t => t.name === step.tool);
      if (!tool || hash(tool.inputSchema) !== policy.schemaHash) throw httpError(409, '远程工具规范已改变，请重新审批');
      validateArguments(tool.inputSchema, args);
      // Recheck after network awaits, immediately before the side effect.
      const latest = getResource(store, currentUser(user), resource.id);
      if (latest.revision !== step.resource_revision || latest.status !== '已启用' || store.setting('emergencyStop')?.enabled || signal?.aborted || store.get('SELECT status FROM tool_steps WHERE id=?', sid).status !== 'executing') throw httpError(409, '执行授权已变化');
      if (policy.risk !== 'read' && !store.get("SELECT id FROM users WHERE id=? AND active=1 AND role='admin'", step.approved_by)) throw httpError(403, '审批人权限已撤销');
      if (step.expires < Date.now()) throw httpError(409, '执行授权已过期');
      authorizeTool(currentUser(user), latest, step.tool, args, { environment: step.environment, automated: !!policy.automation });
      if (policy.automation && policy.risk !== 'read' && process.env.ENABLE_AUTO_REMEDIATION !== 'true') throw httpError(403, '自动处置开关已关闭');
      if (policy.automation) {
        const runbook = store.get("SELECT * FROM runbooks WHERE id=? AND publication='published'", policy.automation.runbookId);
        if (!runbook || runbook.revision !== policy.automation.revision || !store.get("SELECT id FROM users WHERE id=? AND active=1 AND role='admin'", runbook.reviewer_id) || !store.get("SELECT id FROM users WHERE id=? AND active=1 AND role='admin'", runbook.owner_id)) throw httpError(403, 'Runbook 授权已撤销');
      }
      sent = true;
      const response = await connection.client.callTool({ name: step.tool, arguments: args }, undefined, { signal, timeout: 30000 });
      if (response.isError) {
        // A failed write can later become reconciled success; it must never
        // acquire a replayable original reply through that status transition.
        store.run('UPDATE tool_steps SET result=?,response_encrypted=? WHERE id=?', JSON.stringify(redact(outputValue(response))), step.call_key && policy.risk === 'read' ? store.encrypt(JSON.stringify(response)) : null, sid);
        throw httpError(502, '工具返回失败，需要检查实际结果');
      }
      if (policy.risk !== 'read') {
        const check = policy.verification;
        const readPolicy = authorizeTool(currentUser(user), getResource(store, user, resource.id), check.tool, check.arguments, { environment: step.environment });
        if (readPolicy.risk !== 'read') throw httpError(403, '核验工具必须是只读工具');
        const verifyTool = tools.find(t => t.name === check.tool);
        if (!verifyTool) throw httpError(400, '核验工具不存在');
        validateArguments(verifyTool.inputSchema, check.arguments);
        const verified = await connection.client.callTool({ name: check.tool, arguments: check.arguments }, undefined, { signal, timeout: 30000 });
        const matches = !verified.isError && JSON.stringify(atPath(outputValue(verified), check.path)) === JSON.stringify(check.equals);
        store.run('UPDATE tool_steps SET verification=? WHERE id=?', JSON.stringify({ matches, result: redact(outputValue(verified)) }), sid);
        if (!matches) throw httpError(502, '变更结果未通过确定性核验，请人工检查');
      }
      if (signal?.aborted) throw httpError(409, '执行已取消');
      const result = redact(outputValue(response));
      store.run("UPDATE tool_steps SET status='success',result=?,response_encrypted=?,updated=? WHERE id=?", JSON.stringify(result), step.call_key ? store.encrypt(JSON.stringify(response)) : null, now(), sid);
      store.audit(user, 'tool.finish', step.run_id, { stepId: sid, tool: step.tool, status: 'success', result });
      return { stepId: sid, response };
    } catch (error) {
      const cancelled = signal?.aborted && store.get('SELECT status FROM executions WHERE id=?', step.run_id)?.status === 'cancelled';
      const status = sent && policy.risk !== 'read' ? 'unknown' : cancelled && !sent ? 'cancelled' : 'failed';
      if (cancelled) error = httpError(409, status === 'unknown' ? '执行已取消，变更结果待确认，请只读核验' : '执行已取消');
      // A second caller must not overwrite an already completed step.
      store.run("UPDATE tool_steps SET status=?,error=?,updated=? WHERE id=? AND status IN ('ready','approved','executing')", status, error.status ? error.message : '工具执行失败', now(), sid);
      store.audit(user, 'tool.error', step.run_id, { stepId: sid, status });
      throw Object.assign(error, { stepId: sid });
    } finally { await connection?.close(); releaseConnector?.(); }
  }
  function view(user, rid) {
    const row = store.get('SELECT * FROM executions WHERE id=?', rid);
    if (!row || row.user_id !== user.id && user.role !== 'admin') throw httpError(404, '执行不存在或无权访问');
    const { input, input_hash, request_key, ...safe } = row;
    return { ...safe, result: row.result ? JSON.parse(row.result) : null,
      delegations: store.all('SELECT id,parent_agent_run_id,agent_id,agent_name,depth,status,node_id,error_code,created,updated,finished,model_calls,tokens,tool_steps,source_count FROM agent_delegations WHERE run_id=? ORDER BY created,rowid', rid),
      steps: store.all('SELECT * FROM tool_steps WHERE run_id=? ORDER BY created', rid).map(s => {
      const { arguments_encrypted, response_encrypted, call_hash, ...rest } = s;
      return { ...rest, arguments: redact(JSON.parse(store.decrypt(arguments_encrypted))), policy: JSON.parse(s.policy), result: s.result ? JSON.parse(s.result) : null, verification: s.verification ? JSON.parse(s.verification) : null };
    }) };
  }
  async function approve(approver, sid) {
    currentUser(approver);
    if (store.get('SELECT role FROM users WHERE id=?', approver.id)?.role !== 'admin') throw httpError(403, '需要管理员审批');
    const step = store.get('SELECT * FROM tool_steps WHERE id=?', sid);
    if (!step || step.status !== 'awaiting_approval') throw httpError(409, '步骤不在等待审批状态');
    const run = store.get('SELECT * FROM executions WHERE id=?', step.run_id);
    if (run.status !== 'awaiting_approval') throw httpError(409, '执行已结束或尚未进入审批状态');
    const policy = JSON.parse(step.policy);
    if ((step.environment === 'production' || policy.risk === 'high') && run.user_id === approver.id) throw httpError(403, '生产或高风险变更需要另一位管理员审批');
    const user = currentUser({ id: run.user_id });
    const controller = await acquire(user, run.id); let timer;
    try {
      timer = setTimeout(() => controller.abort(), runTimeoutMs());
      if (!store.run("UPDATE tool_steps SET status='approved',approved_by=?,updated=? WHERE id=? AND status='awaiting_approval'", approver.id, now(), sid).changes) throw httpError(409, '步骤已被审批');
      store.run("UPDATE executions SET status='running',result=NULL,updated=? WHERE id=?", now(), run.id);
      store.audit(approver, 'tool.approve', run.id, { stepId: sid });
      const result = await executeStep(sid, user, controller.signal);
      const output = { runId: run.id, status: 'success', text: '已执行并通过结果核验', stepId: result.stepId };
      store.run("UPDATE executions SET status='success',result=?,updated=? WHERE id=?", JSON.stringify(output), now(), run.id);
      notify(store, 'change.success', { runId: run.id }); return view(approver, run.id);
    } catch (error) {
      const state = store.get('SELECT status FROM tool_steps WHERE id=?', sid)?.status;
      const cancelled = controller.signal.aborted && store.get('SELECT status FROM executions WHERE id=?', run.id)?.status === 'cancelled';
      const status = state === 'unknown' ? 'unknown' : cancelled ? 'cancelled' : 'failed';
      if (cancelled) error = httpError(409, status === 'unknown' ? '执行已取消，变更结果待确认，请只读核验' : '执行已取消');
      if (state !== 'awaiting_approval') store.run('UPDATE executions SET status=?,error=?,updated=? WHERE id=?', status, error.status ? error.message : '变更执行失败', now(), run.id);
      notify(store, 'change.failed', { runId: run.id, state }); throw error;
    } finally { clearTimeout(timer); active.delete(run.id); }
  }
  async function reconcile(user, sid) {
    const step = store.get("SELECT * FROM tool_steps WHERE id=? AND status='unknown'", sid);
    if (!step) throw httpError(409, '仅结果待确认的步骤可以核验');
    const run = store.get('SELECT * FROM executions WHERE id=?', step.run_id);
    const check = JSON.parse(step.policy).verification;
    function authorizeReconciliation() {
      const actor = currentUser(user);
      if (actor.role !== 'admin') throw httpError(403, '需要管理员权限');
      const owner = currentUser({ id: run.user_id }); const resource = getResource(store, owner, step.resource_id);
      if (resource.revision !== step.resource_revision || resource.status !== '已启用') throw httpError(409, '配置已变更，请人工核对远程系统');
      if (!check || authorizeTool(owner, resource, check.tool, check.arguments, { environment: step.environment }).risk !== 'read') throw httpError(403, '没有有效的只读核验策略');
      return { owner, resource };
    }
    const { owner, resource } = authorizeReconciliation();
    const controller = await acquire(owner, run.id);
    let connection;
    try {
      connection = await connectMcp(store, resource, controller.signal);
      const tool = (await discover(connection.client, controller.signal)).find(t => t.name === check.tool);
      if (!tool) throw httpError(404, '核验工具不存在');
      validateArguments(tool.inputSchema, check.arguments);
      // Network waits may outlive either identity or the frozen resource authorization.
      authorizeReconciliation();
      const result = await connection.client.callTool({ name: check.tool, arguments: check.arguments }, undefined, { signal: controller.signal, timeout: 30000 });
      authorizeReconciliation();
      const matches = !result.isError && JSON.stringify(atPath(outputValue(result), check.path)) === JSON.stringify(check.equals);
      store.run('UPDATE tool_steps SET verification=?,updated=? WHERE id=?', JSON.stringify({ matches, result: redact(outputValue(result)) }), now(), sid);
      if (matches) {
        store.run("UPDATE tool_steps SET status='success',error=NULL WHERE id=? AND status='unknown'", sid);
        const runbook = JSON.parse(store.decrypt(run.input)).runbookId;
        const status = runbook ? 'interrupted' : 'success';
        store.run('UPDATE executions SET status=?,result=?,error=NULL,updated=? WHERE id=?', status, JSON.stringify({ status, runId: run.id, text: runbook ? '此步骤已核验；Runbook 后续步骤未重放，请人工接管' : '只读核验确认目标状态，无重放写操作' }), now(), run.id);
      }
      store.audit(user, 'tool.reconcile', run.id, { stepId: sid, matches }); return view(user, run.id);
    } finally { await connection?.close(); active.delete(run.id); }
  }
  function cancel(user, rid) {
    const run = view(user, rid);
    if (terminal.has(run.status)) throw httpError(409, '执行已结束');
    active.get(rid)?.controller.abort();
    store.run("UPDATE tool_steps SET status='cancelled',updated=? WHERE run_id=? AND status IN ('ready','awaiting_approval','approved')", now(), rid);
    store.run("UPDATE executions SET status='cancelled',result=NULL,reserved_tokens=0,updated=? WHERE id=?", now(), rid);
    store.audit(user, 'execution.cancel', rid);
  }
  function expire() {
    const pending = store.all("SELECT id,run_id FROM tool_steps WHERE status='awaiting_approval' AND expires<?", Date.now());
    for (const step of pending) { store.run("UPDATE tool_steps SET status='expired',updated=? WHERE id=?", now(), step.id); store.run("UPDATE executions SET status='failed',result=NULL,error='审批已过期',updated=? WHERE id=? AND status='awaiting_approval'", now(), step.run_id); }
  }
  return { run, callStep, approve, reconcile, view, cancel, expire, stats: () => ({ active: active.size, queued: waiting.size }), stop: () => { stopped = true; for (const { controller } of active.values()) controller.abort(); }, idle: async () => { while (active.size || waiting.size) await new Promise(resolve => setTimeout(resolve, 20)); } };
}

export function executionRoutes(app, store, execution) {
  app.get('/api/executions/request/:requestKey', (req, res) => {
    const requestKey = z.string().min(8).max(100).parse(req.params.requestKey);
    const run = store.get('SELECT id FROM executions WHERE user_id=? AND request_key=?', req.user.id, requestKey);
    if (!run) throw httpError(404, '没有找到本人的原执行，请核对会话与执行记录，避免重复提交');
    res.json(execution.view(req.user, run.id));
  });
  app.get('/api/executions', (req, res) => {
    execution.expire();
    const rows = req.user.role === 'admin' ? store.all('SELECT id FROM executions ORDER BY created DESC LIMIT 200') : store.all('SELECT id FROM executions WHERE user_id=? ORDER BY created DESC LIMIT 200', req.user.id);
    res.json(rows.map(r => execution.view(req.user, r.id)));
  });
  app.get('/api/executions/:id', (req, res) => res.json(execution.view(req.user, req.params.id)));
  app.post('/api/executions/:id/cancel', (req, res) => { execution.cancel(req.user, req.params.id); res.json({ ok: true }); });
  app.post('/api/approvals/:id/approve', admin, async (req, res) => res.json(await execution.approve(req.user, req.params.id)));
  app.post('/api/approvals/:id/reconcile', admin, async (req, res) => res.json(await execution.reconcile(req.user, req.params.id)));
  app.post('/api/approvals/:id/reject', admin, (req, res) => {
    const step = store.get("SELECT * FROM tool_steps WHERE id=? AND status='awaiting_approval'", req.params.id);
    if (!step) throw httpError(409, '步骤不在等待审批状态');
    execution.cancel(req.user, step.run_id); store.audit(req.user, 'tool.reject', step.run_id, { stepId: step.id }); res.json({ ok: true });
  });
  app.post('/api/executions/tool', async (req, res) => {
    const input = z.object({ resourceId: z.string(), tool: z.string().min(1).max(150), arguments: z.record(z.unknown()).default({}), environment: z.enum(['test', 'staging', 'production']), requestKey: z.string().min(8).max(100) }).parse(req.body);
    const result = await execution.run(req.user, { ...input, kind: 'tool' }, async context => {
      const resource = getResource(store, req.user, input.resourceId);
      if (resource.kind !== 'mcp') throw httpError(400, '请选择 MCP 服务');
      authorizeTool(req.user, resource, input.tool, input.arguments, { environment: input.environment });
      const connection = await connectMcp(store, resource, context.signal);
      try {
        const tool = (await discover(connection.client, context.signal)).find(t => t.name === input.tool);
        if (!tool) throw httpError(404, '远程工具不存在');
        const output = await execution.callStep(req.user, context, resource, input.tool, input.arguments, tool.inputSchema, input.environment);
        return { status: output.pending ? 'awaiting_approval' : 'success', stepId: output.stepId, text: output.pending ? '变更计划已保存，等待审批' : '工具执行完成' };
      } finally { await connection.close(); }
    });
    res.status(result.status === 'awaiting_approval' ? 202 : 200).json(result);
  });
}
