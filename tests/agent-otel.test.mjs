import { test } from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import { createTraceExporter, otlpTracePayload } from '../server/otel-export.mjs';
import { runtimeFixture, answer, call } from './runtime-fixture.mjs';
import { listen } from './fixtures.mjs';

const metric = (exporter, name) => exporter.lines().find(line => line.startsWith(name));
const waitFor = async condition => {
  const until = Date.now() + 3000;
  while (!condition() && Date.now() < until) await new Promise(resolve => setTimeout(resolve, 10));
  assert.ok(condition(), 'timed out waiting for local collector');
};

test('OTLP payload has fixed names and attributes without trace details or tool data', () => {
  const trace = { traceId: 'a'.repeat(32), spanId: 'b'.repeat(16), startedAt: '2026-10-08T00:00:00.000Z', finishedAt: '2026-10-08T00:00:01.000Z',
    status: 'completed', runId: 'PRIVATE_RUN_ID', nodes: [{ kind: 'model', spanId: 'c'.repeat(16), parentSpanId: 'b'.repeat(16),
      startedAt: '2026-10-08T00:00:00.100Z', finishedAt: '2026-10-08T00:00:00.300Z', status: 'completed', label: 'PRIVATE_MODEL',
      summary: 'PRIVATE_PROMPT', details: [{ label: 'PRIVATE_KEY', value: 'PRIVATE_ARGUMENTS' }] },
    { kind: 'skill', spanId: 'd'.repeat(16), parentSpanId: 'b'.repeat(16), startedAt: '2026-10-08T00:00:00.100Z', finishedAt: '2026-10-08T00:00:00.300Z', status: 'completed' }] };
  const payload = otlpTracePayload(trace);
  const spans = payload.resourceSpans[0].scopeSpans[0].spans;
  assert.deepEqual(spans.map(span => span.name), ['aiops.agent.run', 'aiops.agent.model']);
  assert.equal(spans[0].traceId, trace.traceId);
  assert.equal(spans[0].spanId, trace.spanId);
  assert.equal(spans[1].parentSpanId, trace.spanId);
  assert.equal(Buffer.from(spans[0].traceId, 'hex').length, 16);
  assert.equal(Buffer.from(spans[0].spanId, 'hex').length, 8);
  assert.equal(spans[0].endTimeUnixNano, String(BigInt(Date.parse(trace.finishedAt)) * 1000000n));
  for (const secret of ['PRIVATE_', 'api_key', 'arguments', 'billing']) assert.ok(!JSON.stringify(payload).includes(secret));
});

test('OTLP settings reject unsafe or ambiguous configuration and sampling is deterministic', async () => {
  assert.throws(() => createTraceExporter({ endpoint: 'https://user:password@collector.example/v1/traces' }), /ENDPOINT/);
  assert.throws(() => createTraceExporter({ endpoint: 'file:///tmp/traces' }), /ENDPOINT/);
  assert.throws(() => createTraceExporter({ sampleRate: 1.1 }), /SAMPLE_RATE/);
  assert.throws(() => createTraceExporter({ timeoutMs: 50 }), /TIMEOUT_MS/);
  const exporter = createTraceExporter({ endpoint: '', sampleRate: 0.5, propagate: true });
  assert.equal(exporter.isSampled('0'.repeat(32)), true);
  assert.equal(exporter.isSampled('f'.repeat(32)), false);
  await exporter.close();
  const sampledOut = createTraceExporter({ endpoint: 'http://127.0.0.1:1/v1/traces', sampleRate: 0, propagate: true });
  sampledOut.submit({ traceId: '0'.repeat(32), finishedAt: '2026-10-08T00:00:01.000Z' });
  assert.equal(metric(sampledOut, 'aiops_agent_otlp_exports_total{status="sampled_out"}'), 'aiops_agent_otlp_exports_total{status="sampled_out"} 1');
  await sampledOut.close();
});

test('AgentScope propagates node context and exports a bounded redacted trace to local OTLP collector', async () => {
  const received = [];
  let collectorUnavailable = false;
  let collectorPartiallyRejected = false;
  const app = express(); app.use(express.json({ limit: '1mb' }));
  app.post('/v1/traces', (req, res) => { received.push(req.body); res.status(collectorUnavailable ? 503 : 200).json(collectorPartiallyRejected ? { partialSuccess: { rejectedSpans: 1 } } : {}); });
  const collector = await listen(app);
  const h = await runtimeFixture({ telemetry: { endpoint: collector.url + '/v1/traces', sampleRate: 1, propagate: true, timeoutMs: 500 } });
  try {
    h.app.store.setSetting(`catalog:${h.resource.id}`, null);
    h.model((req, res) => answer(res, req.body.messages.at(-1).role === 'tool' ? undefined : [call()], 'PRIVATE_ANSWER'));
    const result = (await h.request('/chat', { text: 'PRIVATE_USER_PROMPT billing', requestKey: 'otel-fixture-run' })).data;
    const trace = result.metadata.executionTrace;
    await waitFor(() => received.length === 1 || h.app.engine.traceMetrics().includes('aiops_agent_otlp_exports_total{status="failed"} 1'));
    assert.equal(received.length, 1, h.app.engine.traceMetrics().slice(-6).join('\n'));
    const payload = received[0];
    const serialized = JSON.stringify(payload);
    const spans = payload.resourceSpans[0].scopeSpans[0].spans;
    const exportedIds = new Set(spans.map(span => span.spanId));
    for (const exported of spans.slice(1)) assert.ok(exportedIds.has(exported.parentSpanId), `${exported.name} has an exported parent`);
    assert.equal(spans[0].traceId, trace.traceId);
    assert.equal(spans[0].spanId, trace.spanId);
    assert.deepEqual(spans.map(span => span.name).filter(name => name === 'aiops.agent.model').length, 2);
    for (let i = 0; i < h.modelTraceparents.length; i++) {
      const node = trace.nodes.filter(node => node.kind === 'model')[i];
      assert.equal(h.modelTraceparents[i], `00-${trace.traceId}-${node.spanId}-01`);
    }
    const mcp = trace.nodes.find(node => node.kind === 'mcp');
    const tool = trace.nodes.find(node => node.kind === 'tool');
    assert.ok(h.fixtures.mcpTraceparents.includes(`00-${trace.traceId}-${mcp.spanId}-01`));
    assert.ok(h.fixtures.mcpTraceparents.includes(`00-${trace.traceId}-${tool.spanId}-01`));
    for (const secret of ['PRIVATE_', 'billing', 'runtime-mcp', 'fixture-model-secret', 'fixture-mcp-secret', 'arguments']) assert.ok(!serialized.includes(secret));
    await waitFor(() => h.app.engine.traceMetrics().includes('aiops_agent_otlp_exports_total{status="sent"} 1'));
    assert.equal(h.app.engine.traceMetrics().find(line => line.startsWith('aiops_agent_otlp_exports_total{status="sent"}')), 'aiops_agent_otlp_exports_total{status="sent"} 1');
    assert.deepEqual((await h.request('/chat', { text: 'PRIVATE_USER_PROMPT billing', requestKey: 'otel-fixture-run' })).data.metadata.executionTrace, trace);
    assert.equal(received.length, 1);
    collectorUnavailable = true;
    const afterFailure = await h.request('/chat', { text: 'PRIVATE_USER_PROMPT billing', requestKey: 'otel-collector-failed' });
    assert.equal(afterFailure.status, 200);
    assert.equal(afterFailure.data.metadata.executionTrace.status, 'completed');
    await waitFor(() => h.app.engine.traceMetrics().includes('aiops_agent_otlp_exports_total{status="failed"} 1'));
    assert.equal(received.length, 2);
    collectorUnavailable = false;
    collectorPartiallyRejected = true;
    assert.equal((await h.request('/chat', { text: 'PRIVATE_USER_PROMPT billing', requestKey: 'otel-collector-partial' })).status, 200);
    await waitFor(() => h.app.engine.traceMetrics().includes('aiops_agent_otlp_exports_total{status="failed"} 2'));
    assert.equal(received.length, 3);
  } finally { await h.close(); await collector.close(); }
});

test('collector failure and full queue are fail-open and counted without sensitive labels', async () => {
  const app = express();
  app.post('/v1/traces', (req, res) => { /* Hold one send to exercise the bounded queue. */ });
  const collector = await listen(app);
  const exporter = createTraceExporter({ endpoint: collector.url + '/v1/traces', sampleRate: 1, timeoutMs: 100 });
  const trace = { traceId: '0'.repeat(32), spanId: '1'.repeat(16), startedAt: '2026-10-08T00:00:00.000Z', finishedAt: '2026-10-08T00:00:01.000Z', status: 'completed', nodes: [] };
  try {
    for (let i = 0; i < 140; i++) exporter.submit(trace);
    assert.equal(metric(exporter, 'aiops_agent_otlp_queue_depth'), 'aiops_agent_otlp_queue_depth 128');
    assert.equal(metric(exporter, 'aiops_agent_otlp_exports_total{status="dropped"}'), 'aiops_agent_otlp_exports_total{status="dropped"} 11');
    await waitFor(() => metric(exporter, 'aiops_agent_otlp_exports_total{status="failed"}') !== 'aiops_agent_otlp_exports_total{status="failed"} 0');
    assert.ok(!exporter.lines().join('\n').includes(trace.traceId));
  } finally { await exporter.close(); await collector.close(); }
});

test('closing the application cancels an in-flight collector send without waiting for the HTTP timeout', async () => {
  const entered = Promise.withResolvers();
  const app = express();
  app.post('/v1/traces', (req, res) => entered.resolve());
  const collector = await listen(app);
  const exporter = createTraceExporter({ endpoint: collector.url + '/v1/traces', sampleRate: 1, timeoutMs: 10000 });
  try {
    exporter.submit({ traceId: '0'.repeat(32), spanId: '1'.repeat(16), startedAt: '2026-10-08T00:00:00.000Z', finishedAt: '2026-10-08T00:00:01.000Z', status: 'completed', nodes: [] });
    await entered.promise;
    const started = Date.now();
    await exporter.close();
    assert.ok(Date.now() - started < 500);
    assert.equal(metric(exporter, 'aiops_agent_otlp_exports_total{status="failed"}'), 'aiops_agent_otlp_exports_total{status="failed"} 1');
  } finally { await exporter.close(); await collector.close(); }
});
