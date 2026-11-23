import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { assessAcceptance, reviewTemplate, reviewPacket, resultKey } from '../scripts/agent-acceptance.mjs';
import { corpusDigest, sha256, candidateDigest } from '../scripts/agent-candidate.mjs';
import { dtsEvaluationCases } from './dts-evaluation-cases.mjs';

const sourceDigest = 'a'.repeat(64), reportSha256 = 'b'.repeat(64), time = Date.parse('2026-09-28T10:00:00.000Z');
const options = { sourceDigest, reportSha256, time };
function observations(scenario) {
  const inspectedAt = '2026-09-28T08:30:00.000Z', queriedAt = '2026-09-28T08:29:59.000Z';
  const reportedAt = scenario.id === 'missing-time' ? null : new Date(Date.parse(queriedAt) - (scenario.ageSeconds ?? 2) * 1000).toISOString();
  const base = { statuses: [200], upstreamCalls: 0, steps: [], assessment: 'unknown',
    inspection: { runId: 'run-final', inspectedAt, maxAgeSeconds: 60, expectedAssessment: 'unknown', querySnapshots: [] } };
  if (scenario.noTool) return base;
  if (scenario.guard && scenario.id !== 'numeric-id') {
    base.statuses = [scenario.id === 'overflow-id' ? 502 : 403];
    if (scenario.id === 'overflow-id') base.steps.push({ tool: 'dts_get_job_status', status: 'failed' });
    return base;
  }
  if (scenario.fault) { base.statuses = [502]; base.upstreamCalls = 1; base.steps.push({ tool: 'dts_get_job_status', status: 'failed' }); return base; }
  const count = scenario.followup ? 2 : 1;
  base.statuses = Array(count).fill(200); base.upstreamCalls = count;
  base.steps = Array.from({ length: count }, () => ({ tool: 'dts_get_job_status', status: 'success' }));
  base.assessment = ['stale', 'future', 'missing-time'].includes(scenario.id) ? 'unknown' : scenario.assessment;
  base.inspection.expectedAssessment = base.assessment;
  base.inspection.querySnapshots = Array.from({ length: count }, (_, index) => ({ stepId: `step-${index}`, runId: index === count - 1 ? 'run-final' : 'run-first',
    state: scenario.state, freshness: scenario.freshness, reportedAt, queriedAt,
    ageAtQuerySeconds: reportedAt === null ? null : (Date.parse(queriedAt) - Date.parse(reportedAt)) / 1000,
    ageAtInspectionSeconds: reportedAt === null ? null : (Date.parse(inspectedAt) - Date.parse(reportedAt)) / 1000 }));
  return base;
}
function fixture() {
  return { version: 3, comparison: { kind: 'agentscope-worker-mode', baselineWorkerMode: 'cold', candidateWorkerMode: 'prefork' }, startedAt: '2026-09-28T08:00:00.000Z', measuredAt: '2026-09-28T09:00:00.000Z', mode: 'real-model-local-dts-fixture', repeats: 3, corpusCases: 30,
    candidate: { sourceDigest, fileCount: 1, corpusDigest: corpusDigest(), sdkVersion: '2.0.8', node: 'v22', platform: 'test', architecture: 'test', model: { name: 'synthetic-unit-test-only', apiType: 'responses', endpointDigest: 'c'.repeat(64) },
      configuration: { poolSize: 2, poolMaxRuns: 100, poolMaxAgeMs: 1800000, startupTimeoutMs: 15000, poolQueueMs: 30000, poolMaxPending: 100, workerModes: ['cold', 'prefork'], contextMode: 'recent', contextMaxBytes: 16000, retrievalMode: 'ranked', evidenceReports: false, modelContextTokens: 32768, modelMaxTokens: 4096, runTokenLimit: 100000 } },
    productionToolsUsed: false, productionQualityAccepted: false,
    results: ['cold', 'prefork'].flatMap(workerMode => dtsEvaluationCases.flatMap(c => [1, 2, 3].map(iteration => ({ runtime: 'agentscope', workerMode, caseId: c.id, iteration, passed: true, tokens: 30, elapsedMs: workerMode === 'cold' ? 100 : 110, answer: 'synthetic unit test', ...observations(c), humanReview: { status: 'pending', rubric: c.rubric } })))) };
}
const approved = (report, reviewerKind = 'human') => {
  const template = reviewTemplate(report, reportSha256, new Date('2026-09-28T09:15:00.000Z'));
  return { ...template, entries: template.entries.map(entry => ({ ...entry, status: 'approved', reviewerKind,
    reviewer: 'Unit test reviewer (not a real review)', reviewedAt: '2026-09-28T09:30:00.000Z', notes: 'Only tests classified gate logic', evidenceRef: `unit-test/report.json#${entry.key}`,
    findings: entry.findings.map(finding => ({ ...finding, status: 'pass', notes: 'Unit test assertion only; no genuine review' })) })) };
};

test('acceptance recomputes metrics and requires real mode, complete human review and current source', () => {
  const report = fixture(); report.summary = [{ runtime: 'agentscope', passed: 999, tokens: 0, p95Ms: 0 }];
  const result = assessAcceptance(report, approved(report), options);
  assert.equal(result.evaluationAccepted, true); assert.equal(result.productionAccepted, false); assert.equal(result.metrics[1].total, 90); assert.equal(result.metrics[1].p95Ms, 110);
  assert.equal(result.version, 3); assert.equal(result.metrics[0].runtime, 'agentscope'); assert.equal(result.metrics[0].workerMode, 'cold');
  assert.equal(result.metrics[1].workerMode, 'prefork'); assert.equal(result.comparison.kind, 'agentscope-worker-mode'); assert.equal(result.p95Ratio, 1.1);
  assert.equal(assessAcceptance(report, null, options).evaluationAccepted, false);
  assert.equal(assessAcceptance(report, approved(report), { ...options, sourceDigest: 'd'.repeat(64) }).evaluationAccepted, false);
  report.mode = 'deterministic-dts-fixture';
  assert.equal(assessAcceptance(report, approved(report), options).evaluationAccepted, false);
  assert.ok(reviewTemplate(report, reportSha256).entries.every(e => e.status === 'pending' && !e.reviewer));
});

test('acceptance rejects missing/duplicate/unknown rows, invalid values, corpus and report tampering', () => {
  for (const mutate of [r => r.results.pop(), r => r.results.push(r.results[0]), r => { r.results[0].caseId = 'unknown'; }, r => { r.results[0].elapsedMs = Infinity; }, r => { r.results[0].tokens = -1; }, r => { r.results[0].passed = 'true'; }, r => { r.candidate.corpusDigest = 'f'.repeat(64); }, r => { r.version = 1; }, r => { r.version = 2; }, r => { r.results[0].runtime = 'legacy'; }, r => { r.results[0].workerMode = 'legacy'; }, r => { r.comparison.baselineWorkerMode = 'prefork'; }, r => { r.candidate.configuration.workerModes = ['prefork', 'cold']; }, r => { r.results[0].humanReview.rubric = 'forged'; }]) {
    const report = fixture(); mutate(report); assert.throws(() => assessAcceptance(report, null, options));
  }
  const report = fixture();
  for (const version of [1, 2]) assert.throws(() => reviewTemplate({ ...report, version }, reportSha256), /Historical evaluation schema.*cannot approve/);
  for (const mutate of [r => { r.version = 1; }, r => { r.reportSha256 = 'd'.repeat(64); }, r => { r.sourceDigest = 'd'.repeat(64); }, r => r.entries.push(r.entries[0]), r => { r.entries[0].reviewer = ''; }, r => { r.entries[0].notes = ''; }, r => { r.entries[0].reviewedAt = '2027-01-01T00:00:00.000Z'; }, r => { r.entries[0].reviewedAt = '2026-01-01T00:00:00.000Z'; }]) {
    const review = approved(report); mutate(review); assert.throws(() => assessAcceptance(report, review, options));
  }
  const partial = approved(report); partial.entries.pop(); assert.equal(assessAcceptance(report, partial, options).evaluationAccepted, false);
  const rejected = approved(report); rejected.entries[0].status = 'rejected'; rejected.entries[0].findings[0].status = 'fail'; assert.equal(assessAcceptance(report, rejected, options).evaluationAccepted, false);
});

test('acceptance blocks failed evidence, zero denominators, latency/token regressions and lowered repeat requirement', () => {
  for (const mutate of [r => { r.results[0].passed = false; }, r => { r.results.filter(v => v.workerMode === 'cold').forEach(v => { v.tokens = 0; }); }, r => { r.results.filter(v => v.workerMode === 'cold').forEach(v => { v.elapsedMs = 0; }); }, r => { r.results.filter(v => v.workerMode === 'prefork').forEach(v => { v.elapsedMs = 1000; }); }, r => { r.results.filter(v => v.workerMode === 'prefork').forEach(v => { v.tokens = 1000; }); }]) {
    const report = fixture(); mutate(report); assert.equal(assessAcceptance(report, approved(report), options).evaluationAccepted, false);
  }
  const report = fixture(); report.repeats = 1; report.results = report.results.filter(v => v.iteration === 1);
  assert.equal(assessAcceptance(report, approved(report), options).evaluationAccepted, false);
  assert.throws(() => assessAcceptance(report, null, { ...options, thresholds: { minRepeats: 1 } }));
});

test('acceptance CLI: pending exit 2, invalid exit 1, exclusive review template and no input overwrite', () => {
  const dir = mkdtempSync(join(tmpdir(), 'agent-acceptance-'));
  try {
    const report = fixture(); report.mode = 'deterministic-dts-fixture'; report.candidate.sourceDigest = candidateDigest().sourceDigest;
    for (const row of report.results.filter(row => row.caseId === 'numeric-id')) Object.assign(row, { ...row, statuses: [400], upstreamCalls: 0, steps: [], assessment: 'unknown', inspection: { ...row.inspection, expectedAssessment: 'unknown', querySnapshots: [] } });
    const file = join(dir, 'report.json'), review = join(dir, 'review.json'), output = join(dir, 'acceptance.json');
    const raw = JSON.stringify(report); writeFileSync(file, raw);
    const run = (...args) => spawnSync(process.execPath, ['scripts/accept-agent-candidate.mjs', '--report', file, ...args], { encoding: 'utf8' });
    assert.equal(run('--template', review).status, 0); assert.equal(run('--template', review).status, 1);
    assert.equal(JSON.parse(readFileSync(review)).reportSha256, sha256(raw));
    assert.equal(run('--review', review, '--out', output).status, 2);
    assert.equal(JSON.parse(readFileSync(output)).productionAccepted, false);
    assert.equal(statSync(output).mode & 0o777, 0o600);
    const pendingOutput = readFileSync(output, 'utf8');
    assert.equal(run('--review', review, '--out', output).status, 1);
    assert.equal(readFileSync(output, 'utf8'), pendingOutput);
    assert.equal(run('--out', file).status, 1); assert.equal(readFileSync(file, 'utf8'), raw);
    const real = fixture(); real.candidate.sourceDigest = candidateDigest().sourceDigest;
    const realRaw = JSON.stringify(real); writeFileSync(file, realRaw);
    const completed = approved(real); completed.reportSha256 = sha256(realRaw); writeFileSync(review, JSON.stringify(completed));
    const realOutput = join(dir, 'accepted.json');
    assert.equal(run('--review', review, '--out', realOutput).status, 0);
    assert.equal(JSON.parse(readFileSync(realOutput)).evaluationAccepted, true);
    writeFileSync(file, '{}'); assert.equal(run('--out', realOutput).status, 1);
    assert.equal(JSON.parse(readFileSync(realOutput)).evaluationAccepted, true);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('classified AI engineering review cannot satisfy formal human or production acceptance', () => {
  const report = fixture(), review = approved(report, 'ai');
  const result = assessAcceptance(report, review, options);
  assert.equal(result.engineeringReady, true); assert.equal(result.realModelQualityReady, true);
  assert.equal(result.humanReviewComplete, false); assert.equal(result.evaluationAccepted, false); assert.equal(result.productionAccepted, false);
  assert.deepEqual(result.reviewCounts.completedByReviewerKind, { ai: 180, human: 0, unspecified: 0 });
  review.entries[0].reviewerKind = 'human'; assert.equal(assessAcceptance(report, review, options).humanReviewComplete, false);
  review.entries[0].reviewerKind = 'unspecified'; assert.equal(assessAcceptance(report, review, options).engineeringReady, false);
  const legacy = { version: 2, reportSha256, sourceDigest, entries: review.entries.map(({ key, status, reviewer, reviewedAt, notes }) => ({ key, status, reviewer, reviewedAt, notes })) };
  const old = assessAcceptance(report, legacy, options);
  assert.equal(old.reviewComplete, true); assert.equal(old.engineeringReady, false); assert.equal(old.humanReviewComplete, false);
  assert.equal(old.reviewCounts.completedByReviewerKind.unspecified, 180);
  report.mode = 'deterministic-dts-fixture';
  for (const row of report.results.filter(row => row.caseId === 'numeric-id')) Object.assign(row, { statuses: [400], upstreamCalls: 0, steps: [], assessment: 'unknown',
    inspection: { ...row.inspection, expectedAssessment: 'unknown', querySnapshots: [] } });
  const controlled = assessAcceptance(report, approved(report, 'ai'), options);
  assert.equal(controlled.engineeringReady, true); assert.equal(controlled.realModelQualityReady, false);
  assert.equal(controlled.evaluationAccepted, false); assert.equal(controlled.productionAccepted, false);
});

test('review findings and answer/evidence/rubric digests reject contradictory approval and tampering', () => {
  const report = fixture();
  for (const mutate of [review => { review.entries[0].answerSha256 = 'd'.repeat(64); }, review => { review.entries[0].evidenceSha256 = 'd'.repeat(64); },
    review => { review.entries[0].rubric = 'forged'; }, review => { review.entries[0].reviewerKind = 'human-ai'; }, review => { review.createdAt = '2026-09-28T08:00:00.000Z'; },
    review => { review.entries[0].findings.pop(); }, review => { review.entries[0].findings[0].status = 'fail'; },
    review => { review.entries[0].findings[0].status = 'pending'; }, review => { review.entries[0].findings[0].notes = 'pass'; },
    review => { review.entries[0].findings[1] = review.entries[0].findings[0]; }, review => { review.entries[0].evidenceRef = ''; },
    review => { review.entries[0].status = 'rejected'; }]) {
    const review = approved(report, 'ai'); mutate(review); assert.throws(() => assessAcceptance(report, review, options));
  }
  for (const mutate of [row => { row.upstreamCalls = 0; }, row => { row.steps[0].tool = 'other_tool'; },
    row => { row.inspection.querySnapshots[0].state = 'paused'; }, row => { row.inspection.querySnapshots[0].ageAtInspectionSeconds = 0; },
    row => { delete row.inspection; }, row => { row.assessment = 'abnormal'; }, row => { row.answer = ''; }]) {
    const altered = fixture(); mutate(altered.results[0]);
    assert.equal(assessAcceptance(altered, approved(altered, 'ai'), options).engineeringReady, false);
  }
});

test('review packet retains every answer and snapshot, origins and failed observations without approval', () => {
  const report = fixture(), packet = reviewPacket(report, reportSha256, new Date(time));
  assert.equal(packet.entries.length, 180); assert.equal(packet.summary.observedEvidencePassed, 180);
  assert.equal(packet.summary.cases.length, 30); assert.equal(packet.entries[0].answer, report.results[0].answer);
  assert.equal(packet.entries[0].caseOrigin, 'synthetic'); assert.equal(packet.entries[0].outputOrigin, 'real_model');
  assert.equal(packet.entries.find(row => row.caseId === 'forbidden-area').outputOrigin, 'execution_error_or_refusal');
  assert.ok(packet.entries.every(entry => !('status' in entry))); assert.equal(packet.productionAccepted, false);
  report.results[0].passed = false;
  assert.deepEqual(reviewPacket(report, reportSha256).summary.cases[0].failedEvidenceKeys, [resultKey(report.results[0])]);
});

test('acceptance CLI engineering selection preserves formal blockers and private exclusive packet files', () => {
  const dir = mkdtempSync(join(tmpdir(), 'agent-engineering-review-'));
  try {
    const report = fixture(); report.candidate.sourceDigest = candidateDigest().sourceDigest;
    const file = join(dir, 'report.json'), reviewFile = join(dir, 'review.json'), packetFile = join(dir, 'packet.json');
    const raw = JSON.stringify(report), review = approved(report, 'ai'); review.reportSha256 = sha256(raw);
    writeFileSync(file, raw); writeFileSync(reviewFile, JSON.stringify(review));
    const run = (...args) => spawnSync(process.execPath, ['scripts/accept-agent-candidate.mjs', '--report', file, ...args], { encoding: 'utf8' });
    assert.equal(run('--packet', packetFile).status, 0); assert.equal(run('--packet', packetFile).status, 1);
    assert.equal(statSync(packetFile).mode & 0o777, 0o600); assert.equal(JSON.parse(readFileSync(packetFile)).entries.length, 180);
    const output = join(dir, 'engineering.json');
    assert.equal(run('--review', reviewFile, '--engineering', '--out', output).status, 0);
    const result = JSON.parse(readFileSync(output)); assert.equal(result.engineeringReady, true); assert.equal(result.evaluationAccepted, false);
    assert.equal(run('--review', reviewFile, '--out', join(dir, 'formal.json')).status, 2);
    assert.equal(run('--packet', file).status, 1); assert.equal(readFileSync(file, 'utf8'), raw);
    assert.equal(run('--packet', packetFile, '--engineering').status, 1);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
