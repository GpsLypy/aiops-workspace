import { createHmac, createHash } from 'node:crypto';
import { z } from 'zod';
import { admin } from './auth.mjs';
import { id, now, httpError } from './store.mjs';
import { safeFetch, outboundTarget, redact } from './security.mjs';

export const notificationSchema = z.object({ channelIds: z.array(z.string().min(1)).max(10).default([]), mode: z.enum(['all', 'issues']).default('all'), recovery: z.boolean().default(true), repeatMinutes: z.number().int().min(1).max(10080).default(60) }).strict().default({});
const channelSchema = z.object({
  name: z.string().trim().min(1).max(100), kind: z.enum(['webhook', 'wecom']), endpoint: z.string().trim().max(2000).optional(),
  secret: z.string().max(500).optional(), token: z.string().max(2000).optional(), clearCredentials: z.boolean().default(false),
  allowedUserIds: z.array(z.string()).max(100).default([]), enabled: z.boolean().default(true), revision: z.number().int().positive().optional(),
}).strict();
const labels = { healthy: '正常', abnormal: '异常', unknown: '无法判断' };
export const canUseChannel = (user, channel) => !!user?.active && (user.role === 'admin' || JSON.parse(channel.allowed_users).includes(user.id));
function channelView(store, user, channel) {
  const config = JSON.parse(store.decrypt(channel.config_encrypted));
  return { id: channel.id, name: channel.name, kind: channel.kind, enabled: !!channel.enabled, revision: channel.revision, created: channel.created, updated: channel.updated,
    ...(user.role === 'admin' ? { endpointOrigin: new URL(config.endpoint).origin, hasEndpoint: true, hasSecret: !!config.secret, hasToken: !!config.token, allowedUserIds: JSON.parse(channel.allowed_users) } : {}) };
}
export function validateNotification(store, user, notification, rules) {
  if (new Set(notification.channelIds).size !== notification.channelIds.length) throw httpError(400, '通知渠道不能重复');
  if (notification.mode === 'issues' && !rules.length) throw httpError(400, '异常时推送需要先配置巡检正常条件');
  for (const channelId of notification.channelIds) {
    const channel = store.get('SELECT * FROM notification_channels WHERE id=?', channelId);
    if (!channel || !channel.enabled || !canUseChannel(user, channel)) throw httpError(403, '通知渠道已停用或没有使用权限');
  }
}
export function taskNotificationView(store, runId) {
  return store.all('SELECT d.id,d.status,d.attempts,d.last_error,d.next_attempt,c.name AS channelName FROM notification_deliveries d JOIN notification_events e ON e.id=d.event_id JOIN notification_channels c ON c.id=d.channel_id WHERE e.task_run_id=? ORDER BY d.created,d.id', runId);
}
export function renderNotification(payload) {
  const zone = payload.timezone || 'Asia/Shanghai';
  const formatTime = value => { try { return new Intl.DateTimeFormat('zh-CN', { timeZone: zone, dateStyle: 'short', timeStyle: 'medium', hour12: false }).format(new Date(value)); } catch { return value; } };
  const lines = [`【${payload.recovered ? '巡检恢复' : payload.kind === 'channel.test' ? '测试消息' : payload.executionStatus !== 'success' ? '巡检未完成' : '巡检报告'}】${payload.title}`, `时间：${formatTime(payload.finishedAt || payload.createdAt)}（${zone}）`, payload.executionStatus ? `执行：${({ success: '成功', failed: '失败', interrupted: '已中断', awaiting_approval: '等待审批', unknown: '结果待确认', cancelled: '已取消' })[payload.executionStatus] || payload.executionStatus}` : '', payload.assessment ? `巡检：${labels[payload.assessment.status]} · ${payload.assessment.reason}` : ''];
  for (const finding of payload.assessment?.findings || []) {
    lines.push(`• ${finding.label}：${labels[finding.status]}`);
    const evidence = finding.evidence?.[0];
    if (evidence) lines.push(`  ${finding.path} = ${String(JSON.stringify(evidence.actual)).slice(0, 120)} · 查询 ${formatTime(evidence.queriedAt)}`);
  }
  if (payload.summary) lines.push('', '摘要：', payload.summary);
  if (payload.detailUrl) lines.push('', `查看详情：${payload.detailUrl}`);
  return lines.filter(line => line !== '').join('\n');
}
function detailUrl(taskId, runId) {
  if (!process.env.APP_ORIGIN) return null;
  return `${process.env.APP_ORIGIN.replace(/\/$/, '')}/#tasks?task=${encodeURIComponent(taskId)}&run=${encodeURIComponent(runId)}`;
}
// Caller holds the transaction that finalizes the task run.
export function enqueueTaskNotification(store, task, run, assessment) {
  const sourceKey = `task:${run.id}`;
  if (store.get('SELECT id FROM notification_events WHERE source_key=?', sourceKey)) return;
  const config = notificationSchema.parse(JSON.parse(task.notification));
  const state = JSON.parse(task.notification_state);
  const status = run.status === 'success' ? assessment.status : 'execution_failed';
  const fingerprint = createHash('sha256').update(JSON.stringify([status, run.status, assessment.findings.map(f => [f.index, f.status])])).digest('hex');
  const recovered = status === 'healthy' && Object.values(state).some(s => s.open);
  const payload = redact({ version: 1, kind: run.status === 'success' ? recovered ? 'task.recovered' : 'task.completed' : 'task.failed', title: task.name, taskId: task.id, taskRunId: run.id, executionId: run.execution_id || null, conversationId: run.conversation_id || null, executionStatus: run.status, timezone: task.timezone, assessment, recovered, createdAt: now(), finishedAt: run.finished, summary: String(run.error || run.result || assessment.reason).slice(0, 2000), detailUrl: detailUrl(task.id, run.id) });
  const eventId = id();
  store.run('INSERT INTO notification_events(id,source_key,kind,user_id,task_id,task_run_id,payload,created) VALUES(?,?,?,?,?,?,?,?)', eventId, sourceKey, payload.kind, task.user_id, task.id, run.id, JSON.stringify(payload), now());
  for (const channelId of config.channelIds) {
    const previous = state[channelId];
    const shouldSend = config.mode === 'all' || (status === 'healthy' ? config.recovery && previous?.open : !previous?.open || previous.fingerprint !== fingerprint || Date.now() - previous.notifiedAt >= config.repeatMinutes * 60000);
    if (shouldSend) {
      const channel = store.get('SELECT * FROM notification_channels WHERE id=?', channelId);
      // Channels are retained when disabled, so history and failed delivery reasons remain readable.
      if (channel) store.run('INSERT INTO notification_deliveries(id,event_id,channel_id,channel_revision,created,updated) VALUES(?,?,?,?,?,?)', id(), eventId, channelId, channel.revision, now(), now());
    }
    state[channelId] = { open: status !== 'healthy', fingerprint, notifiedAt: shouldSend ? Date.now() : previous?.notifiedAt || 0 };
  }
  store.run('UPDATE tasks SET notification_state=? WHERE id=?', JSON.stringify(state), task.id);
}

async function boundedJson(response) {
  if (!response.body) throw httpError(502, '接收端没有返回业务确认');
  const reader = response.body.getReader(); const chunks = []; let size = 0;
  try {
    while (true) { const { done, value } = await reader.read(); if (done) break; size += value.byteLength; if (size > 16384) throw httpError(502, '接收端响应过大'); chunks.push(Buffer.from(value)); }
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } catch (error) { if (error instanceof SyntaxError) throw httpError(502, '接收端业务确认无效'); throw error; }
  finally { await reader.cancel().catch(() => {}); reader.releaseLock(); }
}
const retryDelay = response => {
  const value = response.headers.get('retry-after');
  if (!value) return 0;
  const ms = /^\d+$/.test(value) ? Number(value) * 1000 : Date.parse(value) - Date.now();
  return Number.isFinite(ms) ? Math.min(3600000, Math.max(0, ms)) : 0;
};
function clippedUtf8(text, max) {
  if (Buffer.byteLength(text) <= max) return text;
  const marker = '\n…内容已截断';
  let result = ''; let bytes = 0;
  for (const char of text) { bytes += Buffer.byteLength(char); if (bytes > max - Buffer.byteLength(marker)) return result + marker; result += char; }
  return result;
}

export function createNotifications(store) {
  let pending; let closing = false;
  store.run("UPDATE notification_deliveries SET status='pending' WHERE status='sending'");
  async function deliver(row) {
    const channel = store.get('SELECT * FROM notification_channels WHERE id=?', row.channel_id);
    const event = store.get('SELECT * FROM notification_events WHERE id=?', row.event_id);
    const user = store.get('SELECT * FROM users WHERE id=?', event.user_id);
    let message; let retryable = false; let wait = 0;
    if (!user?.active) message = '消息所有者已停用，发送已停止';
    else if (!channel.enabled) message = '通知渠道已停用，请启用后重新发送';
    else if (!canUseChannel(user, channel)) message = '消息所有者的渠道使用权限已撤销';
    else if (channel.revision !== row.channel_revision) message = '渠道配置已变更，请核对后重新发送';
    if (!store.run("UPDATE notification_deliveries SET status='sending',updated=? WHERE id=? AND status='pending'", now(), row.id).changes) return;
    if (!message) {
      try {
        const config = JSON.parse(store.decrypt(channel.config_encrypted)); const payload = JSON.parse(event.payload);
        const footer = payload.detailUrl && Buffer.byteLength(payload.detailUrl) <= 1024 ? `\n查看详情：${payload.detailUrl}` : '';
        const body = JSON.stringify(channel.kind === 'wecom' ? { msgtype: 'text', text: { content: clippedUtf8(renderNotification({ ...payload, detailUrl: null }), Math.max(256, 2048 - Buffer.byteLength(footer))) + footer } } : { id: event.id, kind: event.kind, created: event.created, payload });
        const headers = { 'Content-Type': 'application/json', 'Idempotency-Key': row.id, 'X-AIOps-Event-Id': event.id };
        if (channel.kind === 'webhook') {
          if (config.token) headers.Authorization = `Bearer ${config.token}`;
          if (config.secret) { const stamp = String(Date.now()); headers['X-AIOps-Timestamp'] = stamp; headers['X-AIOps-Signature'] = createHmac('sha256', config.secret).update(`${stamp}.${body}`).digest('hex'); }
        }
        const response = await safeFetch(config.endpoint, { method: 'POST', headers, body, signal: AbortSignal.timeout(5000) });
        if (!response.ok) {
          retryable = response.status === 408 || response.status === 429 || response.status >= 500;
          wait = retryDelay(response); message = `接收端返回 HTTP ${response.status}`; await response.body?.cancel();
        } else if (channel.kind === 'wecom') {
          const ack = await boundedJson(response);
          if (ack?.errcode !== 0) { message = typeof ack?.errcode === 'number' ? `企业微信拒绝消息，错误码 ${ack.errcode}` : '企业微信响应缺少成功确认'; retryable = ack?.errcode === 45009; }
        } else await response.body?.cancel();
      } catch (error) {
        message = error.status === 403 ? '远程地址被出口策略拒绝，请检查渠道配置' : error.status ? '接收端响应无效或请求被拒绝，请检查渠道配置' : '连接失败或 5 秒内未收到确认';
        retryable = !error.status;
      }
    }
    const attempts = row.attempts + 1;
    const status = !message ? 'delivered' : retryable && attempts < 8 ? 'pending' : 'failed';
    const nextAttempt = status === 'pending' ? Date.now() + Math.max(wait, Math.min(3600000, 5000 * 2 ** (attempts - 1))) : 0;
    store.transaction(() => {
      store.run('UPDATE notification_deliveries SET status=?,attempts=?,next_attempt=?,last_error=?,delivered_at=?,updated=? WHERE id=?', status, attempts, nextAttempt, message || null, status === 'delivered' ? now() : null, now(), row.id);
      store.audit(null, 'notification.delivery', row.id, { status, attempts });
    });
  }
  async function tick() {
    if (closing) return;
    if (pending) return pending;
    pending = (async () => {
      const rows = store.all("SELECT * FROM notification_deliveries WHERE status='pending' AND next_attempt<=? ORDER BY created,id LIMIT 10", Date.now());
      // A bounded batch; each channel's outcome is independent.
      for (let i = 0; i < rows.length; i += 2) await Promise.all(rows.slice(i, i + 2).map(deliver));
    })().finally(() => { pending = null; });
    return pending;
  }
  return { tick, close: async () => { closing = true; await pending; } };
}

export function notificationRoutes(app, store) {
  app.get('/api/notification-channels', (req, res) => res.json(store.all('SELECT * FROM notification_channels ORDER BY created DESC').filter(c => canUseChannel(req.user, c)).map(c => channelView(store, req.user, c))));
  async function saveChannel(req, res) {
    const input = channelSchema.parse(req.body);
    const existing = req.params.id ? store.get('SELECT * FROM notification_channels WHERE id=?', req.params.id) : null;
    if (req.params.id && !existing) throw httpError(404, '通知渠道不存在');
    if (existing && input.revision !== existing.revision) throw httpError(409, '渠道配置已变更，请刷新后再保存');
    const old = existing ? JSON.parse(store.decrypt(existing.config_encrypted)) : {};
    const config = { endpoint: input.endpoint || old.endpoint, secret: input.clearCredentials ? '' : input.secret || old.secret || '', token: input.clearCredentials ? '' : input.token || old.token || '' };
    if (!config.endpoint) throw httpError(400, '请填写通知地址');
    if (config.secret && config.secret.length < 32) throw httpError(400, '签名密钥至少需要 32 个字符');
    const target = await outboundTarget(config.endpoint).catch(() => { throw httpError(400, '通知地址无效或未通过出口策略检查'); });
    if (target.url.hash) throw httpError(400, '通知地址不能包含片段');
    if (input.kind === 'wecom' && target.url.protocol !== 'https:' && target.url.hostname !== '127.0.0.1') throw httpError(400, '企业微信地址必须使用 HTTPS');
    if (input.kind === 'wecom') { config.secret = ''; config.token = ''; }
    const users = [...new Set(input.allowedUserIds)];
    if (users.some(uid => !store.get('SELECT id FROM users WHERE id=? AND active=1', uid))) throw httpError(400, '指定成员不存在或已停用');
    const cid = existing?.id || id();
    store.transaction(() => {
      if (existing) {
        if (!store.run('UPDATE notification_channels SET name=?,kind=?,config_encrypted=?,allowed_users=?,enabled=?,revision=revision+1,updated=? WHERE id=? AND revision=?', input.name, input.kind, store.encrypt(JSON.stringify(config)), JSON.stringify(users), Number(input.enabled), now(), cid, input.revision).changes) throw httpError(409, '渠道已变更，请刷新');
      } else store.run('INSERT INTO notification_channels(id,name,kind,config_encrypted,allowed_users,enabled,created,updated) VALUES(?,?,?,?,?,?,?,?)', cid, input.name, input.kind, store.encrypt(JSON.stringify(config)), JSON.stringify(users), Number(input.enabled), now(), now());
      store.audit(req.user, existing ? 'notification.channel.update' : 'notification.channel.create', cid);
    });
    res.status(existing ? 200 : 201).json(channelView(store, req.user, store.get('SELECT * FROM notification_channels WHERE id=?', cid)));
  }
  app.post('/api/notification-channels', admin, saveChannel);
  app.put('/api/notification-channels/:id', admin, saveChannel);
  app.post('/api/notification-channels/:id/test', admin, (req, res) => {
    const channel = store.get('SELECT * FROM notification_channels WHERE id=?', req.params.id);
    if (!channel?.enabled) throw httpError(400, '请先保存并启用渠道');
    if (store.get("SELECT d.id FROM notification_deliveries d JOIN notification_events e ON e.id=d.event_id WHERE d.channel_id=? AND e.kind='channel.test' AND e.created>?", channel.id, new Date(Date.now() - 10000).toISOString())) throw httpError(429, '测试消息过于频繁，请稍后再试');
    const eid = id(); const did = id(); const created = now();
    const payload = { version: 1, kind: 'channel.test', title: channel.name, createdAt: created, summary: '这是一条通知渠道测试消息，用于确认消息可以送达。' };
    store.transaction(() => {
      store.run('INSERT INTO notification_events(id,source_key,kind,user_id,payload,created) VALUES(?,?,?,?,?,?)', eid, `test:${eid}`, 'channel.test', req.user.id, JSON.stringify(payload), created);
      store.run('INSERT INTO notification_deliveries(id,event_id,channel_id,channel_revision,created,updated) VALUES(?,?,?,?,?,?)', did, eid, channel.id, channel.revision, created, created);
      store.audit(req.user, 'notification.test', channel.id, { deliveryId: did });
    });
    res.status(202).json({ deliveryId: did });
  });
  const deliveryQuery = 'SELECT d.*,c.name AS channel_name,c.kind AS channel_kind,e.user_id,e.kind,e.task_id,e.task_run_id,e.payload FROM notification_deliveries d JOIN notification_channels c ON c.id=d.channel_id JOIN notification_events e ON e.id=d.event_id';
  const deliveryView = row => { const { payload, ...safe } = row; const parsed = JSON.parse(payload); return { ...safe, title: parsed.title, assessmentStatus: parsed.assessment?.status, executionStatus: parsed.executionStatus }; };
  function getDelivery(user, did) {
    const row = store.get(`${deliveryQuery} WHERE d.id=?`, did);
    if (!row || user.role !== 'admin' && row.user_id !== user.id) throw httpError(404, '推送记录不存在或无权访问');
    return row;
  }
  app.get('/api/notification-deliveries', (req, res) => {
    const input = z.object({ page: z.coerce.number().int().min(1).max(100000).default(1), status: z.enum(['all', 'pending', 'sending', 'delivered', 'failed']).default('all'), taskRunId: z.string().max(100).optional() }).parse(req.query);
    const clauses = []; const values = [];
    if (req.user.role !== 'admin') { clauses.push('e.user_id=?'); values.push(req.user.id); }
    if (input.status !== 'all') { clauses.push('d.status=?'); values.push(input.status); }
    if (input.taskRunId) { clauses.push('e.task_run_id=?'); values.push(input.taskRunId); }
    const where = clauses.length ? ` WHERE ${clauses.join(' AND ')}` : '';
    const total = store.get(`SELECT count(*) AS n FROM notification_deliveries d JOIN notification_events e ON e.id=d.event_id${where}`, ...values).n;
    res.json({ items: store.all(`${deliveryQuery}${where} ORDER BY d.created DESC,d.id DESC LIMIT 30 OFFSET ?`, ...values, (input.page - 1) * 30).map(deliveryView), total, page: input.page, pageSize: 30 });
  });
  app.get('/api/notification-deliveries/:id', (req, res) => {
    const row = getDelivery(req.user, req.params.id); const payload = JSON.parse(row.payload);
    res.json({ ...deliveryView(row), payload, preview: renderNotification(payload) });
  });
  app.post('/api/notification-deliveries/:id/retry', (req, res) => {
    const row = getDelivery(req.user, req.params.id);
    const channel = store.get('SELECT * FROM notification_channels WHERE id=?', row.channel_id);
    const owner = store.get('SELECT * FROM users WHERE id=?', row.user_id);
    if (!channel.enabled || !canUseChannel(owner, channel)) throw httpError(403, '渠道已停用或消息所有者没有使用权限');
    store.transaction(() => {
      if (!store.run("UPDATE notification_deliveries SET status='pending',attempts=0,next_attempt=0,last_error=NULL,channel_revision=?,updated=? WHERE id=? AND status='failed'", channel.revision, now(), row.id).changes) throw httpError(409, '只能重新发送失败的消息');
      store.audit(req.user, 'notification.retry', row.id, { previousAttempts: row.attempts, channelRevision: channel.revision });
    });
    res.status(202).json({ deliveryId: row.id });
  });
}
