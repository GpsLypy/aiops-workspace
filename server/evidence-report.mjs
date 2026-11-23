import { now } from './store.mjs';
import { redactText } from './security.mjs';

// A snapshot of evidence available when the message was saved, never a health verdict.
export function evidenceReport(store, runId, outcome, { sources, mcpFailures, context, retrievalMode }) {
  const run = store.get('SELECT runtime,runtime_version,tokens FROM executions WHERE id=?', runId);
  const steps = store.all('SELECT id,resource_id,resource_revision,tool,environment,policy,status,updated FROM tool_steps WHERE run_id=? ORDER BY created,rowid', runId);
  const toolSteps = steps.map(s => ({ stepId: s.id, resourceId: s.resource_id, revision: s.resource_revision,
    tool: redactText(s.tool), environment: s.environment, risk: JSON.parse(s.policy).risk, status: s.status, recordedAt: s.updated }));
  const gaps = [];
  if (outcome === 'error') gaps.push('generation_incomplete');
  if (!steps.some(s => s.status === 'success')) gaps.push('no_successful_tool_evidence');
  if (mcpFailures.length) gaps.push('mcp_discovery_unavailable');
  if (steps.some(s => s.status !== 'success')) gaps.push('unfinished_or_failed_steps');
  if (context?.omittedMessages) gaps.push('history_omitted');
  return { version: 1, runId, generatedAt: now(), outcome, businessStatus: 'not_assessed',
    runtime: run?.runtime || null, runtimeVersion: run?.runtime_version || null, tokens: run?.tokens || 0,
    retrievalMode, context: context || null, gaps, toolSteps,
    sources: sources.map(s => ({ resourceId: s.resourceId, title: redactText(s.title), revision: s.revision,
      documentVersion: redactText(s.documentVersion || ''), offset: s.offset })),
    mcpFailures: mcpFailures.map(f => ({ resourceId: f.resourceId, service: redactText(f.service), phase: f.phase, code: f.code, message: f.message })) };
}
