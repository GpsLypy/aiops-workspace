import { z } from 'zod';
import { httpError } from './store.mjs';

const fieldName = /^[a-zA-Z_][a-zA-Z0-9_]*$/;
const forbiddenFields = new Set(['__proto__', 'constructor', 'prototype']);
const bindingValue = z.union([z.string().max(500).refine(value => value.trim().length > 0), z.number().finite(), z.boolean()]);

export const targetBindingSchema = z.object({
  resourceId: z.string().min(1).max(100),
  tool: z.string().min(1).max(150),
  environment: z.enum(['test', 'staging', 'production']),
  arguments: z.record(bindingValue).refine(value => {
    const keys = Object.keys(value);
    return keys.length > 0 && keys.length <= 8 && keys.every(key => fieldName.test(key) && !forbiddenFields.has(key));
  }),
}).strict();

export function assertTargetBinding(binding, resource, tool, environment, args, policy) {
  const fields = policy.requiredTargetFields || [];
  if (!binding) {
    if (fields.length) throw httpError(422, '请先确认本轮查询目标');
    return;
  }
  if (binding.resourceId !== resource.id || binding.tool !== tool || binding.environment !== environment) {
    throw httpError(403, '工具请求与本轮确认的目标不一致');
  }
  if (policy.risk !== 'read' || !fields.length || fields.length !== Object.keys(binding.arguments).length ||
      fields.some(field => !Object.hasOwn(binding.arguments, field))) {
    throw httpError(422, '本轮目标绑定与只读工具策略不匹配');
  }
  if (args && (Object.keys(args).length !== fields.length ||
      fields.some(field => !Object.hasOwn(args, field) || !Object.is(args[field], binding.arguments[field])))) {
    throw httpError(403, '工具参数与本轮确认的目标不一致');
  }
}
