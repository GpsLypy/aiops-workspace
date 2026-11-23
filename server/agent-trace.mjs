import { redactText } from './security.mjs';
import { randomBytes } from 'node:crypto';

const text = (value, limit = 180) => redactText(value ?? '').replace(/[\u0000-\u001f\u007f]/g, ' ').slice(0, limit);
const details = items => (items || []).slice(0, 8).map(item => ({ label: text(item.label, 48), value: text(item.value, 240) }));
const spanId = () => randomBytes(8).toString('hex');
const identity = value => typeof value === 'string' && /^[a-zA-Z0-9][a-zA-Z0-9_.:-]{0,127}$/.test(value) ? value : undefined;
const stages = ['run', 'model', 'tool', 'mcp', 'review', 'delegation', 'subagent', 'handoff', 'aggregate', 'budget'];
const nodeKinds = new Set(['request', 'context', 'skill', 'knowledge', 'answer', ...stages.filter(stage => stage !== 'run')]);
const outcomes = ['completed', 'awaiting_approval', 'blocked', 'error', 'cancelled'];
const buckets = [0.01, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10, 30, 120];

export function createTraceMetrics() {
  const histograms = new Map(stages.map(stage => [stage, { count: 0, sum: 0, buckets: buckets.map(() => 0) }]));
  const outcomeCounts = new Map(outcomes.map(status => [status, 0]));
  const observeDuration = (stage, milliseconds) => {
    if (!histograms.has(stage) || !Number.isFinite(milliseconds) || milliseconds < 0) return;
    const histogram = histograms.get(stage);
    const seconds = milliseconds / 1000;
    histogram.count++;
    histogram.sum += seconds;
    buckets.forEach((limit, index) => { if (seconds <= limit) histogram.buckets[index]++; });
  };
  return {
    observe(trace) {
      if (!trace?.finishedAt) return;
      observeDuration('run', trace.durationMs);
      for (const node of trace.nodes || []) observeDuration(node.kind, node.durationMs);
      if (outcomeCounts.has(trace.status)) outcomeCounts.set(trace.status, outcomeCounts.get(trace.status) + 1);
    },
    lines() {
      return [
        '# TYPE aiops_agent_trace_duration_seconds histogram',
        ...stages.flatMap(stage => {
          const histogram = histograms.get(stage);
          return [
            ...buckets.map((limit, index) => `aiops_agent_trace_duration_seconds_bucket{stage="${stage}",le="${limit}"} ${histogram.buckets[index]}`),
            `aiops_agent_trace_duration_seconds_bucket{stage="${stage}",le="+Inf"} ${histogram.count}`,
            `aiops_agent_trace_duration_seconds_count{stage="${stage}"} ${histogram.count}`,
            `aiops_agent_trace_duration_seconds_sum{stage="${stage}"} ${histogram.sum}`,
          ];
        }),
        '# TYPE aiops_agent_trace_outcomes_total counter',
        ...outcomes.map(status => `aiops_agent_trace_outcomes_total{status="${status}"} ${outcomeCounts.get(status)}`),
      ];
    },
  };
}

// This is an observation ledger, not a transcript. Callers pass only identities,
// counts and controlled summaries, never prompts, reasoning, arguments or outputs.
export function createExecutionTrace(runId, event = () => {}, onComplete = () => {}, telemetry = {}) {
  const began = Date.now();
  const trace = { version: 1, runId, traceId: randomBytes(16).toString('hex'), spanId: spanId(), startedAt: new Date(began).toISOString(), durationMs: 0, status: 'running', nodes: [], edges: [] };
  const flags = telemetry.isSampled?.(trace.traceId) ? '01' : '00';
  const starts = new Map();
  const attemptedEdges = new Set();
  let closed = false;
  const snapshot = () => structuredClone({ ...trace, durationMs: closed ? trace.durationMs : Math.max(0, Date.now() - began) });
  const publish = () => event({ type: 'trace', trace: snapshot() });
  const recordEdge = (from, to, label) => {
    if (closed || !starts.has(from) || !starts.has(to) || from === to) return false;
    const key = `${from}:${to}`;
    if (attemptedEdges.has(key)) return false;
    attemptedEdges.add(key);
    if (trace.edges.length >= 400) { trace.omittedEdges = (trace.omittedEdges || 0) + 1; return true; }
    trace.edges.push({ from, to, ...(label ? { label: text(label, 60) } : {}) });
    return true;
  };
  const link = (from, to, label) => {
    if (recordEdge(from, to, label)) publish();
  };
  const start = ({ kind, label, summary = '', details: items, agentRunId = runId, parentAgentRunId, parentNodeId }, dependencies = []) => {
    if (closed || !nodeKinds.has(kind) || typeof label !== 'string') return null;
    if (trace.nodes.length >= 200) { trace.omittedNodes = (trace.omittedNodes || 0) + 1; publish(); return null; }
    const id = `n${trace.nodes.length + 1}`, time = Date.now();
    const parent = starts.has(parentNodeId) ? parentNodeId : dependencies.map(dependency => typeof dependency === 'string' ? dependency : dependency?.from).find(from => starts.has(from));
    starts.set(id, time);
    trace.nodes.push({ id, spanId: spanId(), parentSpanId: trace.nodes.find(node => node.id === parent)?.spanId || trace.spanId,
      ...(identity(agentRunId) ? { agentRunId: identity(agentRunId) } : {}),
      ...(identity(parentAgentRunId) ? { parentAgentRunId: identity(parentAgentRunId) } : {}),
      ...(starts.has(parentNodeId) && parentNodeId !== id ? { parentNodeId } : {}),
      kind, label: text(label), status: 'running', startedAt: new Date(time).toISOString(), summary: text(summary, 280), ...(items?.length ? { details: details(items) } : {}) });
    for (const dependency of dependencies) {
      const from = typeof dependency === 'string' ? dependency : dependency?.from;
      recordEdge(from, id, dependency?.label);
    }
    publish();
    return id;
  };
  const finish = (id, status = 'completed', summary, items) => {
    const node = trace.nodes.find(item => item.id === id);
    if (closed || !node || node.status !== 'running') return;
    const time = Date.now();
    Object.assign(node, { status, finishedAt: new Date(time).toISOString(), durationMs: Math.max(0, time - starts.get(id)) });
    if (summary !== undefined) node.summary = text(summary, 280);
    if (items?.length) node.details = details(items);
    publish();
  };
  const complete = (status, unfinishedSummary = '本轮在此阶段结束') => {
    if (closed) return snapshot();
    const time = Date.now();
    for (const node of trace.nodes.filter(item => item.status === 'running')) {
      Object.assign(node, { status: status === 'cancelled' ? 'cancelled' : 'error', summary: text(unfinishedSummary, 280),
        finishedAt: new Date(time).toISOString(), durationMs: Math.max(0, time - starts.get(node.id)) });
    }
    Object.assign(trace, { status, finishedAt: new Date(time).toISOString(), durationMs: Math.max(0, time - began) });
    closed = true;
    publish();
    const result = snapshot();
    onComplete(result);
    return result;
  };
  const traceparent = nodeId => {
    if (!telemetry.propagate) return null;
    const id = trace.nodes.find(node => node.id === nodeId)?.spanId || trace.spanId;
    return `00-${trace.traceId}-${id}-${flags}`;
  };
  return { start, finish, link, complete, snapshot, traceparent };
}
