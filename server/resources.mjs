import { z } from 'zod';
import { admin, createUser, hashPassword } from './auth.mjs';
import { id, now, httpError, publicUser, getResource, visibleResources, resourceView } from './store.mjs';
import { toolPolicySchema, revisionFields, saveRevision, governed } from './governance.mjs';
import { safeFetch } from './security.mjs';
import { readBounded } from './model.mjs';
import { inspectSkillPackage } from './skill-package.mjs';

export const httpUrl = z.string().max(2000).url().refine(value => {
  try { const u = new URL(value); return ['http:', 'https:'].includes(u.protocol) && !u.username && !u.password; }
  catch { return false; }
}, '必须是无内嵌账号密码的 HTTP(S) 地址');
const resourceSchema = z.object({
  kind: z.enum(['knowledge', 'skills', 'mcp', 'agents']), name: z.string().trim().min(1).max(100),
  description: z.string().max(5000).default(''), domain: z.string().max(150).default('general'),
  body: z.string().max(200000).default(''), status: z.enum(['已启用', '已停用']).default('已启用'),
  visibility: z.enum(['public', 'private']).default('private'),
  readerIds: z.array(z.string()).max(100).default([]), managerIds: z.array(z.string()).max(100).default([]),
  endpoint: z.union([httpUrl, z.literal('')]).default(''), token: z.string().max(4000).optional(),
  allowedTools: z.array(z.string().max(150)).max(100).default([]),
  skillIds: z.array(z.string()).max(30).default([]), mcpIds: z.array(z.string()).max(20).default([]),
  knowledgeIds: z.array(z.string()).max(100).default([]),
  toolPolicies: z.record(toolPolicySchema).default({}),
  service: z.string().max(100).default(''), environment: z.enum(['test', 'staging', 'production']).default('test'),
  documentVersion: z.string().max(100).default(''), expiresAt: z.string().datetime().nullable().default(null),
  sourceUrl: z.union([httpUrl, z.literal('')]).default(''),
  skillPackage: z.object({ filename: z.string().max(255), base64: z.string().max(800000) }).optional(),
});
async function validatePackage(data) {
  if (!data.skillPackage) return;
  if (data.kind !== 'skills') throw httpError(400, '只有 Skill 可以上传 ZIP 包');
  const inspected = await inspectSkillPackage(data.skillPackage);
  data.body = inspected.body;
  data.documentVersion = inspected.documentVersion;
}
function validateBindings(store, user, data) {
  for (const [key, kind] of [['skillIds', 'skills'], ['mcpIds', 'mcp'], ['knowledgeIds', 'knowledge']]) {
    for (const rid of data[key]) if (getResource(store, user, rid).kind !== kind) throw httpError(400, '绑定资源类型不匹配');
  }
  for (const uid of [...data.managerIds, ...data.readerIds]) if (!store.get('SELECT id FROM users WHERE id=? AND active=1', uid)) throw httpError(400, '授权用户不存在或已停用');
  if (data.kind === 'mcp' && !data.endpoint) throw httpError(400, 'MCP 服务地址不能为空');
}
export function resourceRoutes(app, store) {
  app.post('/api/skills/inspect', async (req, res) => res.json(await inspectSkillPackage(req.body)));
  app.get('/api/resources', (req, res) => res.json(visibleResources(store, req.user).map(r => resourceView(store, req.user, r))));
  app.post('/api/knowledge/:id/sync', admin, async (req, res) => {
    const item = getResource(store, req.user, req.params.id, true);
    if (item.kind !== 'knowledge' || !item.sourceUrl) throw httpError(400, '请配置知识文档的来源 URL');
    const response = await safeFetch(item.sourceUrl, { signal: AbortSignal.timeout(15000) });
    if (!response.ok) { await response.body?.cancel(); throw httpError(502, `知识来源返回 HTTP ${response.status}`); }
    if (!/text\/(plain|markdown)/i.test(response.headers.get('content-type') || '')) { await response.body?.cancel(); throw httpError(415, '来源必须返回纯文本或 Markdown'); }
    const body = await readBounded(response, 200000);
    const latest = getResource(store, req.user, item.id, true);
    if (latest.revision !== item.revision) throw httpError(409, '同步期间文档已更新，请重试');
    const next = { ...item, body, revision: item.revision + 1 };
    store.transaction(() => { store.run('UPDATE resources SET data=?,updated=? WHERE id=?', JSON.stringify(next), now(), item.id); saveRevision(store, next, req.user, 'sync'); store.audit(req.user, 'knowledge.sync', item.id, { revision: next.revision }); });
    res.json(resourceView(store, req.user, getResource(store, req.user, item.id)));
  });
  app.post('/api/resources', async (req, res) => {
    const data = resourceSchema.parse(req.body);
    await validatePackage(data);
    validateBindings(store, req.user, data);
    // Remote connectors configure server-side network access and are administrator controlled.
    if (data.kind === 'mcp' && req.user.role !== 'admin') throw httpError(403, '仅管理员可配置 MCP 远程连接');
    const { token, ...fields } = data;
    const rid = id(); const time = now();
    store.transaction(() => {
      store.run('INSERT INTO resources VALUES(?,?,?,?,?,?)', rid, data.kind, req.user.id, JSON.stringify({ ...revisionFields(req.user, fields), ...(data.skillPackage ? { publication: 'draft', publishedBy: null } : {}), tokenEncrypted: store.encrypt(token) }), time, time);
      saveRevision(store, getResource(store, req.user, rid), req.user, 'create');
      store.audit(req.user, 'resource.create', rid, { kind: data.kind });
    });
    res.status(201).json(resourceView(store, req.user, getResource(store, req.user, rid)));
  });
  app.put('/api/resources/:id', async (req, res) => {
    const old = getResource(store, req.user, req.params.id, true);
    if (req.body.revision !== undefined && req.body.revision !== old.revision) throw httpError(409, '资源已被修改，请刷新后再保存');
    const data = resourceSchema.parse(req.body);
    await validatePackage(data);
    if (getResource(store, req.user, req.params.id, true).revision !== old.revision) throw httpError(409, '资源已被修改，请刷新后再保存');
    if (data.kind !== old.kind) throw httpError(400, '不能更改资源类型');
    if (data.kind === 'mcp' && req.user.role !== 'admin') throw httpError(403, '仅管理员可修改 MCP 配置');
    validateBindings(store, req.user, data);
    const { token, ...fields } = data;
    store.transaction(() => {
      store.run('UPDATE resources SET data=?,updated=? WHERE id=?', JSON.stringify({ ...revisionFields(req.user, fields, old), tokenEncrypted: token === undefined ? old.tokenEncrypted : store.encrypt(token) }), now(), old.id);
      saveRevision(store, getResource(store, req.user, old.id), req.user, 'update');
      store.audit(req.user, 'resource.update', old.id, { kind: data.kind });
    });
    res.json(resourceView(store, req.user, getResource(store, req.user, old.id)));
  });
  app.get('/api/resources/:id/versions', (req, res) => {
    getResource(store, req.user, req.params.id, true);
    res.json(store.all('SELECT revision,actor_id,action,created FROM resource_versions WHERE resource_id=? ORDER BY revision DESC LIMIT 100', req.params.id));
  });
  app.post('/api/resources/:id/publish', admin, (req, res) => {
    const item = getResource(store, req.user, req.params.id, true);
    if (!governed(item)) throw httpError(400, '仅 Skill 和子领域需要发布审核');
    if (req.body.revision !== item.revision) throw httpError(409, '待发布版本已变更，请重新审阅');
    const next = { ...item, publication: 'published', publishedBy: req.user.id, revision: item.revision + 1 };
    store.transaction(() => {
      store.run('UPDATE resources SET data=?,updated=? WHERE id=?', JSON.stringify(next), now(), item.id);
      saveRevision(store, next, req.user, 'publish'); store.audit(req.user, 'resource.publish', item.id, { revision: next.revision });
    });
    res.json(resourceView(store, req.user, getResource(store, req.user, item.id)));
  });
  app.post('/api/resources/:id/rollback', (req, res) => {
    const item = getResource(store, req.user, req.params.id, true);
    if (item.kind === 'mcp') throw httpError(400, 'MCP 凭据与策略需重新配置，不能回滚旧授权');
    const version = store.get('SELECT data FROM resource_versions WHERE resource_id=? AND revision=?', item.id, z.number().int().parse(req.body.revision));
    if (!version) throw httpError(404, '版本不存在');
    const historic = resourceSchema.parse(JSON.parse(version.data));
    const next = { ...item, ...revisionFields(req.user, historic, item), ownerId: item.ownerId, visibility: item.visibility, readerIds: item.readerIds, managerIds: item.managerIds };
    validateBindings(store, req.user, next);
    store.transaction(() => {
      store.run('UPDATE resources SET data=?,updated=? WHERE id=?', JSON.stringify(next), now(), item.id);
      saveRevision(store, next, req.user, 'rollback'); store.audit(req.user, 'resource.rollback', item.id, { from: req.body.revision, revision: next.revision });
    });
    res.json(resourceView(store, req.user, getResource(store, req.user, item.id)));
  });
  app.delete('/api/resources/:id', (req, res) => {
    const old = getResource(store, req.user, req.params.id, true);
    if (old.kind === 'mcp' && req.user.role !== 'admin') throw httpError(403, '仅管理员可删除 MCP 配置');
    store.run('DELETE FROM resources WHERE id=?', old.id);
    store.run('DELETE FROM knowledge_search WHERE resource_id=?', old.id);
    store.audit(req.user, 'resource.delete', old.id);
    res.json({ ok: true });
  });
  app.get('/api/users/directory', (req, res) => res.json(store.all('SELECT id,name,username FROM users WHERE active=1')));
  app.get('/api/users', admin, (req, res) => res.json(store.all('SELECT * FROM users ORDER BY created').map(publicUser)));
  app.post('/api/users', admin, (req, res) => { const role = z.enum(['admin', 'member']).parse(req.body.role || 'member'); const user = createUser(store, req.body, role); store.audit(req.user, 'user.create', user.id); res.status(201).json(user); });
  app.patch('/api/users/:id', admin, (req, res) => {
    const change = z.object({ active: z.boolean().optional(), role: z.enum(['admin', 'member']).optional(), password: z.string().min(12).max(200).optional() }).parse(req.body);
    const user = store.get('SELECT * FROM users WHERE id=?', req.params.id);
    if (!user) throw httpError(404, '用户不存在');
    if (user.id === req.user.id && (change.active === false || change.role === 'member')) throw httpError(400, '不能停用自己或撤销自己的管理员身份');
    store.transaction(() => {
      store.run('UPDATE users SET active=?,role=?,password=? WHERE id=?', change.active === undefined ? user.active : Number(change.active), change.role || user.role, change.password ? hashPassword(change.password) : user.password, user.id);
      if (change.password || change.active === false) store.run('DELETE FROM auth_sessions WHERE user_id=?', user.id);
    });
    store.audit(req.user, 'user.update', user.id, { role: change.role, active: change.active, passwordReset: !!change.password });
    res.json(publicUser(store.get('SELECT * FROM users WHERE id=?', user.id)));
  });
  app.get('/api/audit', admin, (req, res) => res.json(store.all('SELECT a.*,u.name AS user_name FROM audit a LEFT JOIN users u ON a.user_id=u.id ORDER BY seq DESC LIMIT 200').map(r => ({ ...r, detail: JSON.parse(r.detail) }))));
}
