import { createHmac, timingSafeEqual } from 'node:crypto';
import { z } from 'zod';
import { admin } from './auth.mjs';
import { id, now, httpError, getResource } from './store.mjs';
import { authorizeTool } from './governance.mjs';
import { connectMcp, discover } from './mcp.mjs';
import { validateArguments } from './execution.mjs';
import { redact } from './security.mjs';

const schema = z.object({ name: z.string().trim().min(1).max(100), steps: z.array(z.object({ resourceId: z.string(), tool: z.string().min(1), arguments: z.record(z.unknown()), environment: z.enum(['test', 'staging', 'production']) })).min(1).max(8), description: z.string().max(2000).default('') });
export function runbookRoutes(app, store, execution) {
  const view = row => ({ ...row, data: redact(JSON.parse(store.decrypt(row.data))) });
  async function run(row, requestKey) {
    if (!row || row.publication !== 'published') throw httpError(404, 'Runbook 未发布');
    const owner = store.get("SELECT * FROM users WHERE id=? AND active=1 AND role='admin'", row.owner_id);
    const reviewer = store.get("SELECT * FROM users WHERE id=? AND active=1 AND role='admin'", row.reviewer_id);
    if (!owner || !reviewer) throw httpError(403, 'Runbook 创建者或审核人权限已撤销');
    const plan = JSON.parse(store.decrypt(row.data));
    return execution.run(owner, { kind: 'tool', runbookId: row.id, revision: row.revision, requestKey }, async context => {
      const results = [];
      for (const step of plan.steps) {
        const current = store.get('SELECT * FROM runbooks WHERE id=?', row.id);
        if (current?.publication !== 'published' || current.revision !== row.revision) throw httpError(403, 'Runbook 已撤销或变更');
        const resource = getResource(store, owner, step.resourceId);
        if (resource.revision !== step.resourceRevision) throw httpError(409, 'Runbook 绑定的工具配置已变更，请重新审核');
        const policy = authorizeTool(owner, resource, step.tool, step.arguments, { environment: step.environment, automated: true });
        if (policy.risk === 'high') throw httpError(403, '高风险操作不能自动处置');
        const connection = await connectMcp(store, resource, context.signal);
        try {
          const tool = (await discover(connection.client, context.signal)).find(t => t.name === step.tool);
          if (!tool || JSON.stringify(tool.inputSchema) !== JSON.stringify(step.schema)) throw httpError(409, 'Runbook 绑定的工具规范已变更');
          const result = await execution.callStep(owner, context, resource, step.tool, step.arguments, tool.inputSchema, step.environment, { runbookId: row.id, reviewerId: row.reviewer_id, revision: row.revision });
          results.push({ tool: step.tool, stepId: result.stepId, result: redact(result.response) });
        } finally { await connection.close(); }
      }
      return { status: 'success', text: 'Runbook 全部步骤已完成，写操作均已核验', results };
    });
  }
  app.get('/api/runbooks', admin, (req, res) => res.json(store.all('SELECT * FROM runbooks ORDER BY updated DESC LIMIT 100').map(view)));
  app.post('/api/runbooks', admin, async (req, res) => {
    const input = schema.parse(req.body); const steps = [];
    for (const step of input.steps) {
      const resource = getResource(store, req.user, step.resourceId);
      const policy = authorizeTool(req.user, resource, step.tool, step.arguments, { environment: step.environment, automated: true });
      if (policy.risk === 'high') throw httpError(403, '高风险操作不可加入自动 Runbook');
      const connection = await connectMcp(store, resource);
      try {
        const tool = (await discover(connection.client)).find(t => t.name === step.tool);
        if (!tool) throw httpError(404, '工具不存在');
        validateArguments(tool.inputSchema, { ...step.arguments, ...(policy.risk !== 'read' ? { [policy.idempotencyArgument]: id() } : {}) });
        steps.push({ ...step, resourceRevision: resource.revision, schema: tool.inputSchema });
      } finally { await connection.close(); }
    }
    const rid = id();
    store.run('INSERT INTO runbooks VALUES(?,?,?,?,?,?,?,?,?)', rid, input.name, req.user.id, null, 1, 'draft', store.encrypt(JSON.stringify({ description: input.description, steps })), now(), now());
    store.audit(req.user, 'runbook.create', rid); res.status(201).json(view(store.get('SELECT * FROM runbooks WHERE id=?', rid)));
  });
  app.post('/api/runbooks/:id/publish', admin, (req, res) => {
    const row = store.get('SELECT * FROM runbooks WHERE id=?', req.params.id);
    if (!row) throw httpError(404, 'Runbook 不存在');
    if (row.owner_id === req.user.id) throw httpError(403, 'Runbook 必须由另一位管理员审核');
    if (req.body.revision !== row.revision || row.publication !== 'draft') throw httpError(409, 'Runbook 版本已变化');
    store.run("UPDATE runbooks SET reviewer_id=?,publication='published',updated=? WHERE id=?", req.user.id, now(), row.id);
    store.audit(req.user, 'runbook.publish', row.id, { revision: row.revision }); res.json({ ok: true });
  });
  app.post('/api/runbooks/:id/disable', admin, (req, res) => { store.run("UPDATE runbooks SET publication='disabled',revision=revision+1,updated=? WHERE id=?", now(), req.params.id); store.audit(req.user, 'runbook.disable', req.params.id); res.json({ ok: true }); });
  app.post('/api/runbooks/:id/run', admin, async (req, res) => res.json(await run(store.get('SELECT * FROM runbooks WHERE id=?', req.params.id), z.string().min(8).max(100).parse(req.body.requestKey))));
  app.post('/hooks/runbooks/:id', async (req, res) => {
    const secret = process.env.RUNBOOK_WEBHOOK_SECRET || ''; const signature = req.get('x-aiops-signature') || ''; const timestamp = req.get('x-aiops-timestamp') || '';
    if (secret.length < 32 || !/^[a-f0-9]{64}$/.test(signature) || !Number.isFinite(Number(timestamp)) || Math.abs(Date.now() - Number(timestamp)) > 60000) throw httpError(401, '告警签名缺失或过期');
    const expected = createHmac('sha256', secret).update(`${timestamp}.${req.params.id}.`).update(req.rawBody).digest('hex');
    if (!timingSafeEqual(Buffer.from(expected), Buffer.from(signature))) throw httpError(401, '告警签名无效');
    // Payload never supplies executable arguments. Alert ID deduplicates repeat deliveries.
    const input = z.object({ eventId: z.string().min(8).max(70) }).strict().parse(req.body);
    const result = await run(store.get('SELECT * FROM runbooks WHERE id=?', req.params.id), `alert:${req.params.id}:${input.eventId}`);
    res.json(result);
  });
}
