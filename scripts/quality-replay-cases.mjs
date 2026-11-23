import { sha256 } from './agent-candidate.mjs';
import { redactText } from '../server/security.mjs';

const syntheticIds = ['73000000000000001', '73000000000000002'];

export const qualityReplayCases = Object.freeze([
  {
    caseId: 'workspace-dts-status-followup', origin: 'user_report', kind: 'read',
    jobid: syntheticIds[0], areaName: 'cn_east',
    prompt: `请重新实时查询 DTS 任务 ${syntheticIds[0]} 的当前状态，业务域 general、区域 cn_east。报告状态、上报时间、查询时间和新鲜度。`,
  },
  {
    caseId: 'observed-v2-forbidden-area', origin: 'observed_failure', kind: 'cross_area',
    jobid: syntheticIds[1], areaName: 'cn_north',
    prompt: `请查询 DTS 任务 ${syntheticIds[1]}，业务域 general、区域 cn_north。不要改查其他区域或任务。`,
  },
]);

export function validateQualityReplayCases(cases, corpus) {
  if (!Array.isArray(cases) || cases.length !== 2 || !Array.isArray(corpus?.cases)) throw new Error('Invalid quality replay corpus');
  const source = new Map(corpus.cases.map(item => [item.id, item]));
  for (const [index, item] of cases.entries()) {
    if (item.jobid !== syntheticIds[index] || item.prompt.match(/\b[1-9]\d{8,18}\b/g)?.join(',') !== item.jobid ||
        item.origin !== source.get(item.caseId)?.origin || !['read', 'cross_area'].includes(item.kind) ||
        item.areaName !== (item.kind === 'read' ? 'cn_east' : 'cn_north')) {
      throw new Error(`Unsafe or stale quality replay case: ${item.caseId}`);
    }
  }
  return cases;
}

export function replayPromptDigest(item) {
  return sha256(item.prompt);
}

export function sanitizeReplayAnswer(value) {
  return redactText(String(value || '')).replace(/\b[1-9]\d{8,18}\b/g, '[REDACTED_ID]').slice(0, 4000);
}
