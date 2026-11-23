import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { runtimeFixture, answer, call } from '../tests/runtime-fixture.mjs';

// Explicit single-feature controls keep savings/coverage attributable to each switch.
const baseline = { contextMode: 'recent', retrievalMode: 'ranked', evidenceReports: false };
const variants = {
  baseline, context: { ...baseline, contextMode: 'budgeted' }, retrieval: { ...baseline, retrievalMode: 'diverse' },
  report: { ...baseline, evidenceReports: true }, combined: { contextMode: 'budgeted', retrievalMode: 'diverse', evidenceReports: true },
};
const rows = [];
const runtime = 'agentscope';
const workerMode = process.env.AGENTSCOPE_WORKER_MODE || 'prefork';
for (const [variant, options] of Object.entries(variants)) {
  const h = await runtimeFixture({ workerMode, ...options, contextMaxBytes: 16000 });
  try {
    for (const [name, body] of [['billing latency errors', 'billing latency errors '.repeat(240)], ['network', 'billing network evidence'], ['database', 'latency database evidence']]) {
      assert.equal((await h.request('/resources', { kind: 'knowledge', name, body })).status, 201);
    }
    h.model((req, res) => answer(res, req.body.messages.at(-1).role === 'tool' ? null : [call()], 'Fixture answer; not a diagnosis quality assessment.'));
    await h.app.engine.warmup();
    assert.equal(h.app.engine.health().mode, workerMode);
    for (const scenario of ['short', 'moderate-history', 'over-budget-history']) {
      let conversationId;
      if (scenario !== 'short') {
        const cid = crypto.randomUUID(); const created = new Date().toISOString();
        h.app.store.run('INSERT INTO conversations(id,user_id,title,created,updated) VALUES(?,?,?,?,?)', cid, h.user.id, '评测历史', created, created);
        for (let i = 0; i < 14; i++) for (const role of ['user', 'assistant']) h.app.store.run('INSERT INTO messages(conversation_id,role,content,metadata,created) VALUES(?,?,?,?,?)', cid, role, `${role}/${i} ` + 'history '.repeat(scenario === 'moderate-history' ? 80 : 220), '{}', created);
        conversationId = cid;
      }
      const start = performance.now(), beforeRequests = h.requests.length, beforeTools = h.fixtures.toolCalls.length;
      const reply = await h.request('/chat', { text: 'billing latency errors，查询本轮状态', ...(conversationId ? { conversationId } : {}) });
      assert.equal(h.app.store.get('SELECT runtime FROM executions WHERE id=?', reply.data.runId)?.runtime, runtime);
      const calls = h.requests.slice(beforeRequests);
      const expectedStatus = scenario === 'over-budget-history' && options.contextMode === 'recent' ? 422 : 200;
      assert.equal(reply.status, expectedStatus, `${runtime}/${variant}/${scenario}: ${JSON.stringify(reply.data)}`);
      if (reply.status === 200) {
        assert.equal(calls.length, 2); assert.equal(h.fixtures.toolCalls.length - beforeTools, 1);
        const documents = new Set(reply.data.metadata.sources.map(s => s.resourceId)).size;
        assert.equal(documents, options.retrievalMode === 'diverse' ? 3 : 1);
        assert.equal(!!reply.data.metadata.evidenceReport, options.evidenceReports);
        if (options.contextMode === 'budgeted') assert.ok(reply.data.metadata.context.afterBytes <= 16000);
        if (options.evidenceReports) assert.equal(reply.data.metadata.evidenceReport.businessStatus, 'not_assessed');
      } else { assert.equal(calls.length, 0); assert.equal(h.fixtures.toolCalls.length - beforeTools, 0); }
      rows.push({ runtime, workerMode, variant, scenario, passed: true, status: reply.status, modelCalls: calls.length,
        toolCalls: h.fixtures.toolCalls.length - beforeTools, firstRequestBytes: calls.length ? Buffer.byteLength(JSON.stringify(calls[0])) : null,
        totalRequestBytes: calls.reduce((n, body) => n + Buffer.byteLength(JSON.stringify(body)), 0),
        tokens: reply.data.metadata?.usage?.total_tokens ?? 0, sourceDocuments: new Set(reply.data.metadata?.sources?.map(s => s.resourceId)).size,
        context: reply.data.metadata?.context, elapsedMs: Math.round(performance.now() - start) });
    }
  } finally { await h.close(); }
}
const comparisons = [runtime].map(runtime => {
  const baselineRow = rows.find(r => r.runtime === runtime && r.variant === 'baseline' && r.scenario === 'moderate-history');
  const trimmed = rows.find(r => r.runtime === runtime && r.variant === 'context' && r.scenario === 'moderate-history');
  return { runtime, baselineRequestBytes: baselineRow.firstRequestBytes, budgetedRequestBytes: trimmed.firstRequestBytes,
    savedRatio: Number((1 - trimmed.firstRequestBytes / baselineRow.firstRequestBytes).toFixed(4)),
    modelCallsUnchanged: baselineRow.modelCalls === trimmed.modelCalls };
});
const report = { version: 2, runtime, workerMode, sdkVersion: '2.0.8', measuredAt: new Date().toISOString(), mode: 'local-deterministic-fixture', passed: rows.every(r => r.passed),
  total: rows.length, comparisons, rows, productionQualityAccepted: false,
  limitations: 'Measures request bytes, distinct source coverage and actual model/tool calls; fixture token counts are fixed. No real diagnosis quality, token savings, production latency or multi-agent benefit claim.' };
const output = resolve('test-results/agentscope'); mkdirSync(output, { recursive: true });
writeFileSync(resolve(output, 'enhancement-evaluation.json'), JSON.stringify(report, null, 2) + '\n');
console.log(JSON.stringify({ ...report, rows: undefined }, null, 2));
