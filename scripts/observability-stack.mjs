import { readFileSync } from 'node:fs';
import { z } from 'zod';

const label = z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,63}$/);
const schema = z.array(z.object({
  targets: z.array(z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9_.-]*:[1-9]\d{0,4}$/)
    .refine(value => Number(value.split(':').at(-1)) <= 65535)).length(1),
  labels: z.object({ instance: label, workspace: label }).strict(),
}).strict()).min(1).max(1000);

export function validateObservabilityTargets(input) {
  const result = schema.safeParse(input);
  if (!result.success) throw new Error('Targets require one host:port and bounded instance/workspace labels per independently stored workspace');
  for (const key of ['instance', 'workspace']) {
    if (new Set(result.data.map(row => row.labels[key])).size !== result.data.length) throw new Error(`Each ${key} label must be unique; do not count one database through multiple application replicas`);
  }
  if (new Set(result.data.map(row => row.targets[0])).size !== result.data.length) throw new Error('Targets must not be duplicated');
  return result.data;
}

export function readObservabilityTargets(path) {
  let value;
  try { value = JSON.parse(readFileSync(path, 'utf8')); } catch { throw new Error('Targets must be readable JSON'); }
  return validateObservabilityTargets(value);
}
