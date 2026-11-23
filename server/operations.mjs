import { appendFileSync, mkdirSync, statfsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { createHmac, timingSafeEqual } from 'node:crypto';
import { z } from 'zod';
import { admin } from './auth.mjs';
import { safeFetch, redact, positive } from './security.mjs';
import { now } from './store.mjs';

export function requestLogging(app) {
  const stats = { count: 0, seconds: 0, errors: 0, buckets: [0.1, 0.5, 1, 5, 30, 120].map(le => ({ le, count: 0 })) };
  app.locals.httpStats = stats;
  app.use((req, res, next) => {
    const requestId = crypto.randomUUID(); const started = performance.now(); req.requestId = requestId;
    res.set('X-Request-Id', requestId);
    res.on('finish', () => {
      const seconds = (performance.now() - started) / 1000; stats.count++; stats.seconds += seconds;
      if (res.statusCode >= 500) stats.errors++;
      for (const bucket of stats.buckets) if (seconds <= bucket.le) bucket.count++;
      if (process.env.HTTP_LOG === 'true') console.log(JSON.stringify({ time: now(), requestId, method: req.method, path: req.path, status: res.statusCode, elapsedMs: Math.round(seconds * 1000), userId: req.user?.id }));
    });
    next();
  });
}
export function createOperations(store, execution, scheduler, notifications, engine) {
  let timer; let pending; let closing = false; let lastError = null; let lastTick = null;
  function health() {
    let database = false; let freeBytes = 0;
    try { database = store.get('SELECT 1 AS ok').ok === 1; const stat = statfsSync(store.dir); freeBytes = Number(stat.bavail) * Number(stat.bsize); } catch {}
    const runtime = engine?.health() || { enabled: true, mode: 'unavailable', ready: false };
    return { ready: database && freeBytes > positive('MIN_FREE_DISK_BYTES', 104857600) && runtime.ready && !closing, runtime, database, freeBytes, execution: execution.stats(), scheduler: scheduler.health(), emergencyStop: !!store.setting('emergencyStop')?.enabled, delivery: { lastTick, lastError }, lastBackup: store.setting('lastBackup')?.created || null, pendingNotifications: store.get("SELECT count(*) AS n FROM notifications WHERE status='pending'").n + store.get("SELECT count(*) AS n FROM notification_deliveries WHERE status IN ('pending','sending')").n, failedNotifications: store.get("SELECT count(*) AS n FROM notification_deliveries WHERE status='failed'").n };
  }
  async function tick() {
    if (closing || pending) return;
    pending = (async () => {
      execution.expire();
      if (process.env.AUDIT_EXPORT_FILE) {
        const path = resolve(process.env.AUDIT_EXPORT_FILE); mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
        const cursor = store.setting(`auditExport:${path}`)?.seq || 0;
        const rows = store.all('SELECT * FROM audit WHERE seq>? ORDER BY seq LIMIT 500', cursor);
        if (rows.length) { appendFileSync(path, rows.map(r => JSON.stringify(r)).join('\n') + '\n', { mode: 0o600, flush: true }); store.setSetting(`auditExport:${path}`, { seq: rows.at(-1).seq }); }
      }
      if (process.env.NOTIFICATION_WEBHOOK_URL) {
        for (const row of store.all("SELECT * FROM notifications WHERE status='pending' AND next_attempt<=? ORDER BY created LIMIT 10", Date.now())) {
          try {
            const body = JSON.stringify({ id: row.id, kind: row.kind, created: row.created, payload: JSON.parse(row.payload) });
            const signature = createHmac('sha256', process.env.NOTIFICATION_WEBHOOK_SECRET || '').update(body).digest('hex');
            const result = await safeFetch(process.env.NOTIFICATION_WEBHOOK_URL, { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-AIOps-Signature': signature, 'Idempotency-Key': row.id }, body, signal: AbortSignal.timeout(5000) });
            await result.body?.cancel(); if (!result.ok) throw new Error(`Webhook HTTP ${result.status}`);
            store.run("UPDATE notifications SET status='delivered',attempts=attempts+1 WHERE id=?", row.id);
          } catch {
            store.run('UPDATE notifications SET status=?,attempts=attempts+1,next_attempt=? WHERE id=?', row.attempts >= 7 ? 'failed' : 'pending', Date.now() + Math.min(3600000, 1000 * 2 ** row.attempts), row.id);
          }
        }
      }
      await notifications?.tick();
      lastError = null; lastTick = now();
    })().catch(error => { lastError = '运维后台任务失败，请检查审计出口与存储'; console.error(JSON.stringify({ event: 'operations.error', message: redact(error.message) })); }).finally(() => { pending = null; });
    await pending;
  }
  return { health, tick, traceMetrics: () => engine?.traceMetrics() || [], warmup: () => engine?.warmup(), start: () => { timer = setInterval(() => void tick(), 5000); timer.unref(); }, close: async () => { closing = true; clearInterval(timer); await pending; } };
}
export function operationsRoutes(app, store, execution, operations) {
  app.get('/readyz', async (req, res) => { try { await operations.warmup(); } catch { /* health reports the failure without private details */ } const status = operations.health(); res.status(status.ready ? 200 : 503).json({ ready: status.ready }); });
  app.get('/metrics', (req, res) => {
    const expected = Buffer.from(process.env.METRICS_TOKEN || ''); const actual = Buffer.from((req.get('authorization') || '').replace(/^Bearer /, ''));
    if (!expected.length || actual.length !== expected.length || !timingSafeEqual(actual, expected)) return res.sendStatus(401);
    const health = operations.health(); const states = store.all('SELECT status,count(*) AS n FROM executions GROUP BY status');
    const worker = health.runtime.worker || health.runtime;
    const http = app.locals.httpStats;
    const total = store.get('SELECT coalesce(sum(tokens),0) AS tokens,coalesce(sum(cost),0) AS cost FROM executions');
    res.type('text/plain').send([
      `aiops_ready ${Number(health.ready)}`, `aiops_active_runs ${health.execution.active}`, `aiops_queued_runs ${health.execution.queued}`, `aiops_disk_free_bytes ${health.freeBytes}`,
      `aiops_model_tokens_total ${total.tokens}`, `aiops_model_cost_total ${total.cost}`, `aiops_notifications_pending ${health.pendingNotifications}`, `aiops_notifications_failed ${health.failedNotifications}`,
      `aiops_agent_runtime_ready{mode="${health.runtime.mode}"} ${Number(health.runtime.ready)}`,
      ...['starting', 'idle', 'reserved', 'leasing', 'busy', 'finishing', 'stopping'].map(state => `aiops_agent_workers{state="${state}"} ${worker.workers?.filter(w => w.state === state).length || 0}`),
      `aiops_agent_pool_queued ${worker.queued || 0}`,
      ...['spawned', 'completed', 'failed', 'cancelled', 'recycled', 'startupFailures'].map(key => `aiops_agent_${key.replace(/[A-Z]/g, c => '_' + c.toLowerCase())}_total ${worker[key] || 0}`),
      `aiops_agent_queue_wait_seconds_total ${worker.queueWaitSeconds || 0}`,
      `aiops_agent_run_seconds_total ${worker.runSeconds || 0}`,
      `aiops_agent_child_cpu_seconds_total ${worker.childCpuSeconds || 0}`,
      `aiops_agent_child_peak_rss_bytes ${worker.childPeakRssBytes || 0}`,
      `aiops_agent_preloader_peak_rss_bytes_sum ${worker.workers?.reduce((n, w) => n + w.parentPeakRssBytes, 0) || 0}`,
      `aiops_backup_age_seconds ${health.lastBackup ? Math.floor((Date.now() - Date.parse(health.lastBackup)) / 1000) : -1}`,
      `aiops_http_requests_total ${http.count}`, `aiops_http_errors_total ${http.errors}`,
      `aiops_http_duration_seconds_count ${http.count}`, `aiops_http_duration_seconds_sum ${http.seconds}`,
      ...http.buckets.map(b => `aiops_http_duration_seconds_bucket{le="${b.le}"} ${b.count}`), `aiops_http_duration_seconds_bucket{le="+Inf"} ${http.count}`,
      ...operations.traceMetrics(),
      ...states.map(s => `aiops_executions{status="${s.status}"} ${s.n}`), '',
    ].join('\n'));
  });
  app.get('/api/operations', admin, (req, res) => res.json({ ...operations.health(), notifications: store.all('SELECT id,kind,status,attempts,created FROM notifications ORDER BY created DESC LIMIT 50'), circuits: store.all("SELECT key,value FROM settings WHERE key LIKE 'circuit:%'").map(r => ({ resourceId: r.key.slice(8), ...JSON.parse(r.value) })) }));
  app.post('/api/operations/emergency-stop', admin, (req, res) => {
    const { enabled, reason } = z.object({ enabled: z.boolean(), reason: z.string().trim().min(3).max(500) }).parse(req.body);
    store.setSetting('emergencyStop', { enabled, reason, userId: req.user.id, created: now() });
    if (enabled) for (const run of store.all("SELECT id FROM executions WHERE status IN ('running','queued','awaiting_approval')")) execution.cancel(req.user, run.id);
    store.audit(req.user, 'emergency.toggle', '', { enabled, reason }); res.json({ ok: true });
  });
  app.get('/api/audit/export', admin, (req, res) => {
    const after = z.coerce.number().int().min(0).default(0).parse(req.query.after);
    const rows = store.all('SELECT * FROM audit WHERE seq>? ORDER BY seq LIMIT 1000', after);
    res.json({ rows, next: rows.at(-1)?.seq || after });
  });
}
