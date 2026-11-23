import { z } from 'zod';
import { getResource, httpError } from './store.mjs';
import { redact } from './security.mjs';

const scalar = z.union([z.string().max(500), z.number().finite(), z.boolean()]);
const safePath = z.string().min(1).max(200).regex(/^[\w-]+(?:\.[\w-]+)*$/).refine(value => !value.split('.').some(p => ['__proto__', 'constructor', 'prototype'].includes(p)), '字段路径无效');
export const inspectionRulesSchema = z.array(z.object({
  label: z.string().trim().min(1).max(100), resourceId: z.string().min(1), tool: z.string().min(1).max(200),
  arguments: z.record(scalar).default({}), path: safePath,
  operator: z.enum(['eq', 'ne', 'gt', 'gte', 'lt', 'lte', 'fresh']), expected: scalar,
}).strict().superRefine((rule, context) => {
  if (!['eq', 'ne'].includes(rule.operator) && typeof rule.expected !== 'number') context.addIssue({ code: 'custom', message: '数值比较和新鲜度必须填写数字' });
  if (rule.operator === 'fresh' && !(rule.expected > 0 && rule.expected <= 604800)) context.addIssue({ code: 'custom', message: '新鲜度秒数应在 1 到 604800 之间' });
})).max(12).default([]);

export function validateInspectionRules(store, user, rules) {
  for (const rule of rules) {
    const resource = getResource(store, user, rule.resourceId);
    const policy = resource.toolPolicies?.[rule.tool];
    if (resource.kind !== 'mcp' || resource.status !== '已启用' || !resource.allowedTools.includes(rule.tool) || policy?.risk !== 'read' || !policy.roles.includes(user.role) || policy.userIds.length && !policy.userIds.includes(user.id) || !policy.environments.includes(resource.environment || 'test')) throw httpError(400, '巡检条件必须引用当前有权使用的只读工具');
  }
}
const atPath = (value, path) => path.split('.').reduce((v, key) => v != null && typeof v === 'object' && Object.hasOwn(v, key) ? v[key] : undefined, value);
const uncertain = value => value == null || typeof value === 'string' && /\[REDACTED|\[TRUNCATED/.test(value);

// Only persisted tool evidence is evaluated. Model prose is never a health signal.
export function assessInspection(store, rules, executionId, executionStatus, time = Date.now()) {
  if (executionStatus !== 'success') return { status: 'unknown', reason: '本次执行未完整完成', findings: [] };
  if (!rules.length) return { status: 'unknown', reason: '未配置巡检判定条件', findings: [] };
  const steps = executionId ? store.all('SELECT * FROM tool_steps WHERE run_id=? ORDER BY created,id', executionId) : [];
  const findings = rules.map((rule, index) => {
    const matching = steps.filter(step => {
      if (step.resource_id !== rule.resourceId || step.tool !== rule.tool) return false;
      const args = JSON.parse(store.decrypt(step.arguments_encrypted));
      return Object.entries(rule.arguments).every(([key, value]) => Object.hasOwn(args, key) && args[key] === value);
    });
    const base = { index, label: rule.label, path: rule.path, operator: rule.operator, expected: rule.expected };
    if (!matching.length) return { ...base, status: 'unknown', reason: '未取得匹配对象的工具结果', evidence: [] };
    const evidence = matching.map(step => {
      const actual = step.result ? atPath(JSON.parse(step.result), rule.path) : undefined;
      const entry = { stepId: step.id, queriedAt: step.updated, actual: actual === undefined ? null : redact(actual) };
      if (step.status !== 'success' || JSON.parse(step.policy).risk !== 'read' || uncertain(actual) || !['string', 'number', 'boolean'].includes(typeof actual)) return { ...entry, status: 'unknown', reason: '工具失败、字段缺失或字段不可用于判定' };
      if (rule.operator === 'fresh') {
        const stamp = typeof actual === 'string' && /^\d{4}-\d{2}-\d{2}T.*(?:Z|[+-]\d{2}:\d{2})$/.test(actual) ? Date.parse(actual) : NaN;
        const age = (time - stamp) / 1000;
        return { ...entry, status: Number.isFinite(age) && age >= -30 && age <= rule.expected ? 'healthy' : 'unknown', reason: Number.isFinite(age) && age >= -30 && age <= rule.expected ? '数据在有效时间内' : '时间缺失、无效、超前或数据已过期' };
      }
      if (typeof actual !== typeof rule.expected || !['eq', 'ne'].includes(rule.operator) && typeof actual !== 'number') return { ...entry, status: 'unknown', reason: '字段类型与条件不一致' };
      const matches = { eq: () => actual === rule.expected, ne: () => actual !== rule.expected, gt: () => actual > rule.expected, gte: () => actual >= rule.expected, lt: () => actual < rule.expected, lte: () => actual <= rule.expected }[rule.operator]();
      return { ...entry, status: matches ? 'healthy' : 'abnormal', reason: matches ? '满足正常条件' : '不满足正常条件' };
    });
    const status = evidence.some(e => e.status === 'abnormal') ? 'abnormal' : evidence.some(e => e.status === 'unknown') ? 'unknown' : 'healthy';
    return { ...base, status, evidence };
  });
  // Stale or missing evidence must never be presented as a confirmed abnormal/healthy reading.
  const status = findings.some(f => f.status === 'unknown') ? 'unknown' : findings.some(f => f.status === 'abnormal') ? 'abnormal' : 'healthy';
  return { status, reason: status === 'healthy' ? '全部正常条件满足' : status === 'abnormal' ? '存在不满足正常条件的检查项' : '部分检查缺少有效证据，请查看检查项', findings };
}
