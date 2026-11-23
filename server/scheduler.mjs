import { CronExpressionParser } from 'cron-parser';
import { z } from 'zod';
import { id, now, httpError, getResource } from './store.mjs';
import { authorizeTool, executableResource } from './governance.mjs';
import { targetBindingSchema, assertTargetBinding } from './target-binding.mjs';
import { inspectionRulesSchema, validateInspectionRules, assessInspection } from './inspection.mjs';
import { notificationSchema, validateNotification, enqueueTaskNotification, taskNotificationView } from './notifications.mjs';
import { runTimeoutMs } from './request-policy.mjs';
import { positive } from './security.mjs';

const schema = z.object({
  name: z.string().trim().min(1).max(100), prompt: z.string().trim().min(1).max(20000),
  agentId: z.string().optional().nullable(), scheduleType: z.enum(['once', 'cron']),
  cron: z.string().max(100).optional(), timezone: z.string().max(100).default('Asia/Shanghai'),
  runAt: z.string().optional(), enabled: z.boolean().default(true),
  notification: notificationSchema, inspectionRules: inspectionRulesSchema,
  targetBinding: targetBindingSchema.nullable().default(null),
});
function validateTaskBinding(store, user, binding, agentId) {
  if (!binding) return;
  const resource = getResource(store, user, binding.resourceId);
  if (resource.kind !== 'mcp' || resource.status !== '已启用' || binding.environment !== (resource.environment || 'test')) throw httpError(400, '查询目标的数据服务或环境不可用');
  if (agentId) {
    const agent = getResource(store, user, agentId);
    if (agent.kind !== 'agents' || agent.status !== '已启用' || !executableResource(agent) || !agent.mcpIds.includes(resource.id)) throw httpError(400, '所选 Agent 未绑定查询目标的数据服务');
  }
  const policy = authorizeTool(user, resource, binding.tool, binding.arguments, { environment: binding.environment });
  assertTargetBinding(binding, resource, binding.tool, binding.environment, binding.arguments, policy);
}
export function nextRun(task, date = new Date()) {
  if (task.schedule_type === 'once') return task.run_at;
  try {
    if (task.cron.trim().split(/\s+/).length !== 5) throw new Error('Only five-field cron');
    return CronExpressionParser.parse(task.cron, { currentDate: date, tz: task.timezone }).next().toISOString();
  } catch { throw httpError(400, 'Cron 或时区无效；使用五段表达式，例如 0 9 * * *'); }
}
function getTask(store, user, taskId) {
  const task = store.get('SELECT * FROM tasks WHERE id=?', taskId);
  if (!task || (task.user_id !== user.id && user.role !== 'admin')) throw httpError(404, '任务不存在或无权访问');
  return task;
}
export function createScheduler(store, engine) {
  const active = new Set(); let timer; let stopping = false; let lastTick = null; let lastError = null;
  function finish(task, rid, status, result = null, error = null) {
    return store.transaction(() => {
      if (!store.run('UPDATE task_runs SET status=?,finished=?,result=?,error=? WHERE id=? AND status=?', status, now(), result, error, rid, 'running').changes) return;
      const run = store.get('SELECT * FROM task_runs WHERE id=?', rid);
      const assessment = assessInspection(store, JSON.parse(task.inspection_rules), run.execution_id, status);
      store.run('UPDATE task_runs SET assessment=? WHERE id=?', JSON.stringify(assessment), rid);
      enqueueTaskNotification(store, task, run, assessment);
      store.audit({ id: task.user_id }, 'task.finish', task.id, { runId: rid, status, assessment: assessment.status });
    });
  }
  // This application supports one process per database; old in-flight work is never replayed.
  for (const run of store.all("SELECT * FROM task_runs WHERE status='running'")) {
    const task = store.get('SELECT * FROM tasks WHERE id=?', run.task_id);
    finish(task, run.id, 'interrupted', null, '执行进程中断，请检查执行记录后手动重试');
    store.run('UPDATE tasks SET lease_until=0 WHERE id=?', task.id);
  }
  function claim(taskId, manual) {
    return store.transaction(() => {
      const task = store.get('SELECT * FROM tasks WHERE id=?', taskId);
      const time = now(); const millis = Date.now();
      if (!task || task.lease_until > millis || (!manual && (!task.enabled || !task.next_run || task.next_run > time))) return null;
      const rid = id(); const lease = millis + positive('QUEUE_TIMEOUT_MS', 30000) + runTimeoutMs() + 30000;
      const next = manual ? task.next_run : task.schedule_type === 'cron' ? nextRun(task) : null;
      store.run('UPDATE tasks SET lease_until=?,next_run=?,enabled=?,updated=? WHERE id=?', lease, next, !manual && task.schedule_type === 'once' ? 0 : task.enabled, time, taskId);
      store.run('INSERT INTO task_runs(id,task_id,status,started,lease_until) VALUES(?,?,?,?,?)', rid, taskId, 'running', time, lease);
      return { task, rid, lease };
    });
  }
  async function perform(claimed) {
    const { task, rid, lease } = claimed;
    try {
      const user = store.get('SELECT * FROM users WHERE id=? AND active=1', task.user_id);
      if (!user) throw httpError(403, '任务所有者已被停用');
      const targetBinding = task.target_binding ? targetBindingSchema.parse(JSON.parse(task.target_binding)) : null;
      validateTaskBinding(store, user, targetBinding, task.agent_id);
      const result = await engine.execute(user, { text: task.prompt, agentId: task.agent_id || undefined, useKnowledge: true,
        ...(targetBinding ? { targetBinding } : {}) }, event => {
        if (event.type === 'execution') store.run('UPDATE task_runs SET execution_id=? WHERE id=?', event.runId, rid);
        if (event.type === 'session') store.run('UPDATE task_runs SET conversation_id=? WHERE id=?', event.id, rid);
      });
      if (result.runId) store.run('UPDATE task_runs SET execution_id=? WHERE id=?', result.runId, rid);
      finish(task, rid, result.status || 'success', result.text || '');
    } catch (error) {
      if (error.runId) store.run('UPDATE task_runs SET execution_id=? WHERE id=?', error.runId, rid);
      finish(task, rid, 'failed', null, error.status ? error.message : '任务执行失败');
    } finally {
      store.run('UPDATE tasks SET lease_until=0 WHERE id=? AND lease_until=?', task.id, lease);
    }
  }
  function startRun(taskId, manual = false) {
    if (stopping) throw httpError(503, '服务正在停止');
    if (active.size >= 4) { if (manual) throw httpError(429, '已有 4 个任务正在执行，请稍后重试'); return null; }
    const claimed = claim(taskId, manual);
    if (!claimed) { if (manual) throw httpError(409, '任务正在执行'); return null; }
    const promise = perform(claimed).finally(() => active.delete(promise)); active.add(promise);
    return claimed.rid;
  }
  function tick() {
    if (stopping) return;
    lastTick = now();
    // Never silently retry a possibly side-effecting tool after a worker interruption.
    for (const run of store.all("SELECT * FROM task_runs WHERE status='running' AND lease_until<?", Date.now())) finish(store.get('SELECT * FROM tasks WHERE id=?', run.task_id), run.id, 'interrupted', null, '执行进程中断，请检查工具副作用后手动重试');
    for (const task of store.all('SELECT id FROM tasks WHERE enabled=1 AND next_run<=? AND lease_until<? ORDER BY next_run LIMIT 4', now(), Date.now())) startRun(task.id);
  }
  return {
    start: () => { tick(); timer = setInterval(() => { try { tick(); lastError = null; } catch (error) { lastError = error.message; console.error('Scheduler tick failed:', error.message); } }, 1000); timer.unref(); },
    health: () => ({ active: active.size, running: !!timer && !stopping, lastTick, lastError }),
    tick, startRun,
    stop: async () => { stopping = true; clearInterval(timer); await Promise.allSettled([...active]); },
  };
}
export function taskRoutes(app, store, scheduler) {
  const view = task => { const { notification_state, inspection_rules, notification, target_binding, ...safe } = task; return { ...safe, notification: notificationSchema.parse(JSON.parse(notification)), inspectionRules: JSON.parse(inspection_rules), targetBinding: target_binding ? targetBindingSchema.parse(JSON.parse(target_binding)) : null }; };
  app.get('/api/tasks', (req, res) => {
    const sql = `SELECT t.*,u.name AS owner,(SELECT status FROM task_runs r WHERE r.task_id=t.id ORDER BY r.started DESC LIMIT 1) AS last_status FROM tasks t JOIN users u ON u.id=t.user_id`;
    res.json((req.user.role === 'admin' ? store.all(`${sql} ORDER BY t.created DESC`) : store.all(`${sql} WHERE t.user_id=? ORDER BY t.created DESC`, req.user.id)).map(view));
  });
  app.post('/api/tasks', (req, res) => {
    const data = schema.parse(req.body);
    validateInspectionRules(store, req.user, data.inspectionRules);
    validateNotification(store, req.user, data.notification, data.inspectionRules);
    if (data.agentId) { const agent = getResource(store, req.user, data.agentId); if (agent.kind !== 'agents' || agent.status !== '已启用') throw httpError(400, '子领域不可用'); }
    validateTaskBinding(store, req.user, data.targetBinding, data.agentId);
    const task = { schedule_type: data.scheduleType, cron: data.cron || null, timezone: data.timezone, run_at: data.runAt ? new Date(data.runAt).toISOString() : null };
    if (task.schedule_type === 'once' && (!task.run_at || Date.parse(task.run_at) <= Date.now())) throw httpError(400, '单次任务执行时间必须晚于当前时间');
    const next = nextRun(task); const tid = id(); const time = now();
    store.run('INSERT INTO tasks(id,user_id,name,prompt,agent_id,schedule_type,cron,timezone,run_at,enabled,next_run,created,updated,notification,inspection_rules,target_binding) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)', tid, req.user.id, data.name, data.prompt, data.agentId || null, task.schedule_type, task.cron, task.timezone, task.run_at, Number(data.enabled), next, time, time, JSON.stringify(data.notification), JSON.stringify(data.inspectionRules), data.targetBinding ? JSON.stringify(data.targetBinding) : null);
    store.audit(req.user, 'task.create', tid);
    res.status(201).json(view(getTask(store, req.user, tid)));
  });
  app.patch('/api/tasks/:id', (req, res) => {
    const task = getTask(store, req.user, req.params.id);
    const data = z.object({ enabled: z.boolean() }).parse(req.body);
    if (data.enabled && task.schedule_type === 'once' && Date.parse(task.run_at) <= Date.now()) throw httpError(400, '单次时间已过，请创建新任务或点击立即执行');
    store.run('UPDATE tasks SET enabled=?,next_run=?,updated=? WHERE id=?', Number(data.enabled), data.enabled ? nextRun(task) : task.next_run, now(), task.id);
    store.audit(req.user, 'task.toggle', task.id, data); res.json(view(getTask(store, req.user, task.id)));
  });
  app.patch('/api/tasks/:id/target-binding', (req, res) => {
    const task = getTask(store, req.user, req.params.id);
    if (task.lease_until > Date.now()) throw httpError(409, '任务正在执行，暂时不能修改查询目标');
    const data = z.object({ targetBinding: targetBindingSchema.nullable(), updated: z.string().min(1) }).strict().parse(req.body);
    if (task.updated !== data.updated) throw httpError(409, '任务已被修改，请刷新后重试');
    const owner = store.get('SELECT * FROM users WHERE id=? AND active=1', task.user_id);
    if (!owner) throw httpError(403, '任务所有者已停用');
    validateTaskBinding(store, owner, data.targetBinding, task.agent_id);
    const changed = store.run('UPDATE tasks SET target_binding=?,updated=? WHERE id=? AND updated=? AND lease_until<?', data.targetBinding ? JSON.stringify(data.targetBinding) : null, now(), task.id, data.updated, Date.now());
    if (!changed.changes) throw httpError(409, '任务已开始执行或被修改，请刷新后重试');
    store.audit(req.user, 'task.target-binding.update', task.id, { resourceId: data.targetBinding?.resourceId || null, tool: data.targetBinding?.tool || null });
    res.json(view(getTask(store, req.user, task.id)));
  });
  app.patch('/api/tasks/:id/notification', (req, res) => {
    const task = getTask(store, req.user, req.params.id);
    if (task.lease_until > Date.now()) throw httpError(409, '任务正在执行，请结束后修改通知设置');
    const data = z.object({ notification: notificationSchema, inspectionRules: inspectionRulesSchema }).strict().parse(req.body);
    const owner = store.get('SELECT * FROM users WHERE id=? AND active=1', task.user_id);
    if (!owner) throw httpError(400, '任务所有者已停用');
    validateInspectionRules(store, owner, data.inspectionRules);
    validateNotification(store, owner, data.notification, data.inspectionRules);
    store.transaction(() => {
      store.run("UPDATE tasks SET notification=?,inspection_rules=?,notification_state='{}',updated=? WHERE id=?", JSON.stringify(data.notification), JSON.stringify(data.inspectionRules), now(), task.id);
      store.audit(req.user, 'task.notification.update', task.id);
    });
    res.json(view(getTask(store, req.user, task.id)));
  });
  app.post('/api/tasks/:id/run', (req, res) => { const task = getTask(store, req.user, req.params.id); const runId = scheduler.startRun(task.id, true); store.audit(req.user, 'task.run', task.id); res.status(202).json({ runId }); });
  app.get('/api/tasks/:id/runs', (req, res) => { getTask(store, req.user, req.params.id); res.json(store.all('SELECT * FROM task_runs WHERE task_id=? ORDER BY started DESC LIMIT 100', req.params.id).map(run => ({ ...run, assessment: run.assessment ? JSON.parse(run.assessment) : null, deliveries: taskNotificationView(store, run.id) }))); });
  app.delete('/api/tasks/:id', (req, res) => {
    const task = getTask(store, req.user, req.params.id);
    if (task.lease_until > Date.now()) throw httpError(409, '任务正在执行，暂时不能删除');
    store.run('DELETE FROM tasks WHERE id=?', task.id); store.audit(req.user, 'task.delete', task.id); res.json({ ok: true });
  });
}
