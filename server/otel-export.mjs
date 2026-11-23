import { safeFetch } from './security.mjs';

const stages = new Set(['model', 'tool', 'mcp', 'review', 'delegation', 'subagent', 'handoff', 'aggregate', 'budget']);
const outcomes = new Set(['completed', 'awaiting_approval', 'blocked', 'error', 'cancelled', 'skipped']);
const maxQueue = 128;
const serviceName = 'aiops-workspace';

function setting(options, key, fallback) {
  return options[key] ?? fallback;
}

function config(options) {
  const endpoint = setting(options, 'endpoint', process.env.OTEL_EXPORTER_OTLP_TRACES_ENDPOINT || '');
  const sampleRate = Number(setting(options, 'sampleRate', process.env.OTEL_TRACES_SAMPLE_RATE ?? 1));
  const propagate = setting(options, 'propagate', process.env.OTEL_PROPAGATE ?? 'false');
  const timeoutMs = Number(setting(options, 'timeoutMs', process.env.OTEL_EXPORT_TIMEOUT_MS ?? 2000));
  if (endpoint) {
    let url;
    try { url = new URL(endpoint); } catch { throw new Error('OTEL_EXPORTER_OTLP_TRACES_ENDPOINT must be an absolute HTTP(S) URL'); }
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.hash) throw new Error('OTEL_EXPORTER_OTLP_TRACES_ENDPOINT must be an absolute HTTP(S) URL without credentials or fragment');
  }
  if (!Number.isFinite(sampleRate) || sampleRate < 0 || sampleRate > 1) throw new Error('OTEL_TRACES_SAMPLE_RATE must be between 0 and 1');
  if (![true, false, 'true', 'false'].includes(propagate)) throw new Error('OTEL_PROPAGATE must be true or false');
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 100 || timeoutMs > 10000) throw new Error('OTEL_EXPORT_TIMEOUT_MS must be an integer between 100 and 10000');
  return { endpoint, sampleRate, propagate: propagate === true || propagate === 'true', timeoutMs };
}

const attribute = (key, value) => ({ key, value: { stringValue: value } });
const unixNano = value => String(BigInt(Date.parse(value)) * 1000000n);

function span(trace, item, stage, parentSpanId = item.parentSpanId) {
  const outcome = outcomes.has(item.status) ? item.status : 'error';
  return {
    traceId: trace.traceId,
    spanId: item.spanId,
    ...(parentSpanId ? { parentSpanId } : {}),
    name: `aiops.agent.${stage}`,
    kind: 1,
    startTimeUnixNano: unixNano(item.startedAt),
    endTimeUnixNano: unixNano(item.finishedAt),
    attributes: [attribute('aiops.stage', stage), attribute('aiops.outcome', outcome)],
    status: { code: ['completed', 'awaiting_approval', 'skipped'].includes(outcome) ? 1 : 2 },
  };
}

export function otlpTracePayload(trace) {
  const root = span(trace, trace, 'run');
  const selected = (trace.nodes || []).filter(node => stages.has(node.kind) && node.startedAt && node.finishedAt);
  const allNodes = new Map((trace.nodes || []).map(node => [node.spanId, node]));
  const selectedIds = new Set(selected.map(node => node.spanId));
  const parentOf = node => {
    let parent = node.parentSpanId;
    const seen = new Set();
    while (parent !== trace.spanId && !selectedIds.has(parent) && !seen.has(parent)) {
      seen.add(parent);
      parent = allNodes.get(parent)?.parentSpanId || trace.spanId;
    }
    return parent === trace.spanId || selectedIds.has(parent) ? parent : trace.spanId;
  };
  const children = selected.map(node => span(trace, node, node.kind, parentOf(node)));
  return { resourceSpans: [{
    resource: { attributes: [attribute('service.name', serviceName), attribute('service.version', '1.0.0')] },
    scopeSpans: [{ scope: { name: 'aiops.agent.trace', version: '1' }, spans: [root, ...children] }],
  }] };
}

export function createTraceExporter(options = {}) {
  const { endpoint, sampleRate, propagate, timeoutMs } = config(options);
  const counts = { sent: 0, failed: 0, dropped: 0, sampled_out: 0 };
  const queue = [];
  let running = null;
  let inFlight = null;
  let closed = false;
  const isSampled = traceId => parseInt(traceId.slice(0, 8), 16) / 0x100000000 < sampleRate;

  async function drain() {
    while (!closed && queue.length) {
      const body = queue.shift();
      const controller = new AbortController();
      inFlight = controller;
      const signal = AbortSignal.any([controller.signal, AbortSignal.timeout(timeoutMs)]);
      let onAbort;
      const abort = new Promise((_, reject) => {
        onAbort = () => reject(new Error('Collector send cancelled'));
        if (signal.aborted) onAbort();
        else signal.addEventListener('abort', onAbort, { once: true });
      });
      try {
        await Promise.race([(async () => {
          const response = await safeFetch(endpoint, { method: 'POST', redirect: 'error',
            headers: { 'Content-Type': 'application/json' }, body, signal });
          const result = await response.text();
          if (!response.ok) throw new Error('Collector rejected the trace');
          if (result) {
            let parsed;
            try { parsed = JSON.parse(result); } catch { throw new Error('Collector returned invalid JSON'); }
            if (Number(parsed?.partialSuccess?.rejectedSpans) > 0) throw new Error('Collector rejected spans');
          }
        })(), abort]);
        counts.sent++;
      } catch { counts.failed++; }
      finally { signal.removeEventListener('abort', onAbort); inFlight = null; }
    }
    running = null;
  }

  return {
    propagate,
    isSampled,
    submit(trace) {
      if (!endpoint || closed || !trace?.finishedAt) return;
      if (!isSampled(trace.traceId)) { counts.sampled_out++; return; }
      if (queue.length >= maxQueue) { counts.dropped++; return; }
      try { queue.push(JSON.stringify(otlpTracePayload(trace))); }
      catch { counts.failed++; return; }
      if (!running) running = drain();
    },
    lines() {
      return ['# TYPE aiops_agent_otlp_exports_total counter',
        ...Object.entries(counts).map(([status, count]) => `aiops_agent_otlp_exports_total{status="${status}"} ${count}`),
        '# TYPE aiops_agent_otlp_queue_depth gauge', `aiops_agent_otlp_queue_depth ${queue.length}`];
    },
    async close() {
      closed = true;
      counts.dropped += queue.length;
      queue.length = 0;
      inFlight?.abort();
      await running;
    },
  };
}
