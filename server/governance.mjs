import { z } from 'zod';
import { httpError, now } from './store.mjs';
import { terms } from './retrieval.mjs';

const scalar = z.union([z.string().max(500), z.number().finite(), z.boolean(), z.null()]);
const targetField = z.string().regex(/^[a-zA-Z_][a-zA-Z0-9_]*$/).refine(value => !['__proto__', 'constructor', 'prototype'].includes(value));
export const toolPolicySchema = z.object({
  risk: z.enum(['read', 'write', 'high']),
  environments: z.array(z.string().max(80)).min(1).max(20).default(['test']),
  userIds: z.array(z.string()).max(100).default([]),
  roles: z.array(z.enum(['admin', 'member'])).min(1).default(['admin']),
  constraints: z.record(z.array(scalar).min(1).max(100)).default({}),
  requiredTargetFields: z.array(targetField).max(8).refine(fields => new Set(fields).size === fields.length).default([]),
  maxItems: z.number().int().min(1).max(100).default(1),
  idempotencyArgument: z.string().regex(/^[a-zA-Z_][a-zA-Z0-9_]*$/).optional(),
  window: z.object({ start: z.number().int().min(0).max(23), end: z.number().int().min(1).max(24) }).optional(),
  verification: z.object({ tool: z.string().min(1), arguments: z.record(z.unknown()).default({}), path: z.string().min(1), equals: scalar }).optional(),
  recovery: z.string().max(5000).default(''),
  automatic: z.boolean().default(false),
}).superRefine((policy, ctx) => {
  if (policy.requiredTargetFields.length && policy.risk !== 'read') ctx.addIssue({ code: 'custom', path: ['requiredTargetFields'], message: '本轮目标绑定只支持只读工具' });
});
export const governed = item => ['skills', 'agents'].includes(item.kind);
export const executableResource = item => !governed(item) || item.publication === 'published';
export function revisionFields(user, data, old) {
  return { ...data, revision: (old?.revision || 0) + 1, publication: governed(data) ? (user.role === 'admin' && !old ? 'published' : 'draft') : 'published', publishedBy: user.role === 'admin' && !old ? user.id : null };
}
export function saveRevision(store, item, user, action) {
  const { tokenEncrypted, ...safe } = item;
  store.run('INSERT INTO resource_versions(resource_id,revision,data,actor_id,action,created) VALUES(?,?,?,?,?,?)', item.id, item.revision, JSON.stringify(safe), user.id, action, now());
  indexKnowledge(store, item);
}
export function indexKnowledge(store, item) {
  store.run('DELETE FROM knowledge_chunks WHERE resource_id=?', item.id);
  store.run('DELETE FROM knowledge_search WHERE resource_id=?', item.id);
  if (item.kind !== 'knowledge') return;
  const body = item.body || item.description;
  for (let offset = 0; offset < body.length; offset += 750) {
    const content = body.slice(offset, offset + 1000);
    store.run('INSERT INTO knowledge_chunks(resource_id,revision,offset,content) VALUES(?,?,?,?)', item.id, item.revision || 1, offset, content);
    store.run('INSERT INTO knowledge_search(resource_id,offset,tokens) VALUES(?,?,?)', item.id, offset, terms(`${item.name} ${item.domain} ${item.description} ${content}`, 10000).join(' '));
  }
}
export function authorizeTool(user, resource, tool, args, { environment = 'test', automated = false } = {}) {
  if (!resource.allowedTools.includes(tool)) throw httpError(403, '工具未授权');
  const policy = resource.toolPolicies?.[tool];
  if (!policy) throw httpError(403, '工具尚未配置风险与执行范围策略');
  if (!policy.roles.includes(user.role) || policy.userIds.length && !policy.userIds.includes(user.id) || !policy.environments.includes(environment)) throw httpError(403, '当前身份或环境无权执行工具');
  if (!args || typeof args !== 'object' || Array.isArray(args)) throw httpError(400, '工具参数必须是对象');
  for (const [field, allowed] of Object.entries(policy.constraints)) {
    if (!Object.hasOwn(args, field) || !allowed.some(v => JSON.stringify(v) === JSON.stringify(args[field]))) throw httpError(403, `工具参数 ${field} 超出授权范围`);
  }
  const count = value => Array.isArray(value) ? value.length + value.reduce((n, v) => n + (typeof v === 'object' ? count(v) : 0), 0) : value && typeof value === 'object' ? Object.values(value).reduce((n, v) => n + count(v), 0) : 0;
  if (count(args) > policy.maxItems) throw httpError(403, '工具参数的批量范围超过限制');
  if (policy.risk !== 'read') {
    if (!policy.idempotencyArgument || !policy.verification || !policy.recovery.trim() || !Object.keys(policy.constraints).length) throw httpError(403, '写操作必须配置范围约束、幂等参数、结果核验和恢复手册');
    if (policy.window) { const hour = new Date().getUTCHours(); if (hour < policy.window.start || hour >= policy.window.end) throw httpError(403, '当前不在 UTC 变更窗口内'); }
    if (automated && (!policy.automatic || policy.risk === 'high')) throw httpError(403, '此变更不允许自动处置');
  }
  return policy;
}
