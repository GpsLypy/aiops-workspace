import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { candidateDigest, root, sha256 } from '../scripts/agent-candidate.mjs';
import { qualityCorpusDigest, validateCorpus } from '../scripts/agent-quality-corpus.mjs';
import { assessQualityReplayReview, qualityReplayReviewTemplate,
  validateQualityReplayReport } from '../scripts/quality-replay-review.mjs';
import { qualityReplayCases, replayPromptDigest } from '../scripts/quality-replay-cases.mjs';

const corpus = validateCorpus(JSON.parse(readFileSync(join(root, 'tests/quality-cases.json'), 'utf8')));
const current = () => ({ sourceDigest: candidateDigest().sourceDigest,
  qualityCorpusDigest: qualityCorpusDigest(corpus), replayDigest: sha256(JSON.stringify(qualityReplayCases)) });
const checkedAt = new Date('2026-10-08T10:00:00.000Z');
const reportAt = '2026-10-08T09:00:00.000Z';
const templateAt = new Date('2026-10-08T09:10:00.000Z');

function report(candidate = current(), measuredAt = reportAt) {
  return { version: 1, mode: 'controlled-model-local-dts-replay', startedAt: measuredAt,
    measuredAt, candidate, reconstructedPrompts: true,
    results: qualityReplayCases.map(item => ({ caseId: item.caseId, origin: item.origin,
      reconstructedPromptDigest: replayPromptDigest(item),
      testedStage: item.kind === 'read' ? 'tool_execution' : 'authorization_preflight',
      httpStatus: item.kind === 'read' ? 200 : 403,
      runStatus: item.kind === 'read' ? 'success' : 'failed', tokens: item.kind === 'read' ? 60 : 0,
      modelRequests: item.kind === 'read' ? 2 : 0,
      upstreamCalls: item.kind === 'read' ? 1 : 0,
      toolSteps: item.kind === 'read' ? [{ tool: 'dts_get_job_status', status: 'success' }] : [],
      preflightReasonMatched: item.kind !== 'read', boundaryHeld: true,
      querySnapshot: item.kind === 'read' ? { state: 'running', freshness: 'fresh',
        reportedAt: reportAt, queriedAt: reportAt } : null,
      answer: `脱敏的 ${item.caseId} 答复`,
      humanReview: 'pending', automaticEvidencePassed: true })),
    automaticEvidenceComplete: true, humanReviewComplete: false,
    productionToolsUsed: false, productionAccepted: false };
}

function approve(template, reviewedAt = '2026-10-08T09:30:00.000Z') {
  return { ...template, entries: template.entries.map(entry => ({ ...entry, status: 'approved',
    reviewer: 'unit-test-reviewer', reviewedAt,
    notes: '核对了脱敏答复和工具证据', evidenceRef: 'review:unit-test' })) };
}

test('review binds report, candidate and every answer while separating completion from approval', () => {
  const input = report(), reportSha256 = sha256(JSON.stringify(input));
  const template = qualityReplayReviewTemplate(input, reportSha256, templateAt);
  assert.deepEqual(template.entries.map(item => item.answerSha256), input.results.map(item => sha256(item.answer)));
  assert.deepEqual(template.entries.map(item => item.testedStage), input.results.map(item => item.testedStage));
  assert.deepEqual(template.entries.map(item => item.reviewerKind), ['unspecified', 'unspecified']);
  const args = { reportSha256, ...current(), now: checkedAt };
  const pending = assessQualityReplayReview(input, template, args);
  assert.equal(pending.reviewStatus, 'pending');
  assert.equal(pending.reviewComplete, false);
  assert.equal(pending.reviewReady, false);
  const approved = assessQualityReplayReview(input, approve(template), args);
  assert.equal(approved.reviewStatus, 'approved');
  assert.equal(approved.reviewComplete, true);
  assert.equal(approved.reviewReady, true);
  assert.equal(approved.humanReviewComplete, false);
  assert.equal(approved.productionAccepted, false);
  assert.equal(approved.syntheticTaskIds, true);
  assert.equal(approved.counts.modelAnswerCases, 1);
  assert.equal(approved.counts.preflightDenialCases, 1);
  assert.match(approved.limitations.join(' '), /不评价模型答复/);
  assert.match(approved.limitations.join(' '), /不构成真实用户质量证据/);
  const rejected = approve(template);
  rejected.entries[1].status = 'rejected';
  const blocked = assessQualityReplayReview(input, rejected, args);
  assert.equal(blocked.reviewStatus, 'rejected');
  assert.equal(blocked.reviewComplete, true);
  assert.equal(blocked.reviewReady, false);
  assert.deepEqual(blocked.counts, { total: 2, approved: 1, rejected: 1, pending: 0,
    completedByReviewerKind: { human: 0, ai: 0, unspecified: 2 },
    modelAnswerCases: 1, preflightDenialCases: 1 });
});

test('AI, mixed and legacy engineering decisions cannot complete explicit human review', () => {
  const input = report(), reportSha256 = sha256(JSON.stringify(input));
  const template = qualityReplayReviewTemplate(input, reportSha256, templateAt);
  const args = { reportSha256, ...current(), now: checkedAt };
  const ai = approve(template);
  for (const entry of ai.entries) entry.reviewerKind = 'ai';
  const aiResult = assessQualityReplayReview(input, ai, args);
  assert.equal(aiResult.reviewReady, true);
  assert.equal(aiResult.humanReviewComplete, false);
  assert.deepEqual(aiResult.counts.completedByReviewerKind, { human: 0, ai: 2, unspecified: 0 });
  assert.equal(aiResult.checks.find(item => item.id === 'replay_review').status, 'passed');
  assert.equal(aiResult.checks.some(item => item.id === 'human_review'), false);
  assert.equal(aiResult.productionAccepted, false);

  const mixed = structuredClone(ai);
  mixed.entries[0].reviewerKind = 'human';
  const mixedResult = assessQualityReplayReview(input, mixed, args);
  assert.equal(mixedResult.reviewReady, true);
  assert.equal(mixedResult.humanReviewComplete, false);
  assert.deepEqual(mixedResult.counts.completedByReviewerKind, { human: 1, ai: 1, unspecified: 0 });

  const human = structuredClone(mixed);
  human.entries[1].reviewerKind = 'human';
  const humanResult = assessQualityReplayReview(input, human, args);
  assert.equal(humanResult.reviewReady, true);
  assert.equal(humanResult.humanReviewComplete, true);
  assert.equal(humanResult.productionAccepted, false);

  const pending = structuredClone(human);
  pending.entries[1].status = 'pending';
  const pendingResult = assessQualityReplayReview(input, pending, args);
  assert.equal(pendingResult.reviewComplete, false);
  assert.equal(pendingResult.humanReviewComplete, false);
  assert.deepEqual(pendingResult.counts.completedByReviewerKind, { human: 1, ai: 0, unspecified: 0 });

  const rejected = structuredClone(human);
  rejected.entries[1].status = 'rejected';
  const rejectedResult = assessQualityReplayReview(input, rejected, args);
  assert.equal(rejectedResult.reviewComplete, true);
  assert.equal(rejectedResult.reviewReady, false);
  assert.equal(rejectedResult.humanReviewComplete, false);
  assert.deepEqual(rejectedResult.counts.completedByReviewerKind, { human: 2, ai: 0, unspecified: 0 });

  const legacy = approve(template);
  for (const entry of legacy.entries) delete entry.reviewerKind;
  const legacyResult = assessQualityReplayReview(input, legacy, args);
  assert.equal(legacyResult.reviewReady, true);
  assert.equal(legacyResult.humanReviewComplete, false);
  assert.deepEqual(legacyResult.counts.completedByReviewerKind, { human: 0, ai: 0, unspecified: 2 });
});

test('review rejects missing, duplicate, changed and unevidenced decisions', () => {
  const input = report(), reportSha256 = sha256(JSON.stringify(input));
  const template = qualityReplayReviewTemplate(input, reportSha256, templateAt);
  const args = { reportSha256, ...current(), now: checkedAt };
  const cases = [
    review => review.entries.pop(),
    review => review.entries.push({ ...review.entries[0] }),
    review => { review.entries[0].answerSha256 = 'f'.repeat(64); },
    review => { review.entries[0].testedStage = 'authorization_preflight'; },
    review => { review.reportSha256 = 'f'.repeat(64); },
    review => { review.sourceDigest = 'f'.repeat(64); },
    review => { review.qualityCorpusDigest = 'f'.repeat(64); },
    review => { review.replayDigest = 'f'.repeat(64); },
    review => { review.entries[0].reviewer = ''; },
    review => { review.entries[0].reviewerKind = 'automated-human'; },
    review => { review.entries[0].notes = ''; },
    review => { review.entries[0].evidenceRef = ''; },
    review => { review.entries[0].reviewedAt = '2026-10-08T09:09:59.000Z'; },
    review => { review.entries[0].reviewedAt = '2026-10-08T10:00:01.000Z'; },
  ];
  for (const change of cases) {
    const review = approve(template);
    change(review);
    assert.throws(() => assessQualityReplayReview(input, review, args));
  }
  const changedAnswer = structuredClone(input);
  changedAnswer.results[0].answer += '变更';
  assert.throws(() => assessQualityReplayReview(changedAnswer, approve(template),
    { ...args, reportSha256: sha256(JSON.stringify(changedAnswer)) }), /different report or candidate/);
  assert.throws(() => validateQualityReplayReport({ ...input, results: [...input.results, input.results[0]] }),
    /Duplicate replay case/);
  assert.throws(() => qualityReplayReviewTemplate({ ...input, productionAccepted: true }, reportSha256, templateAt));
});

test('stage evidence cannot be replaced by a true automatic flag', () => {
  const mutations = [
    item => { item.httpStatus = 200; },
    item => { item.runStatus = 'success'; },
    item => { item.tokens = 1; },
    item => { item.modelRequests = 1; },
    item => { item.upstreamCalls = 1; },
    item => { item.toolSteps = [{ tool: 'dts_get_job_status', status: 'success' }]; },
    item => { item.preflightReasonMatched = false; },
    item => { item.boundaryHeld = false; },
    item => { item.querySnapshot = { state: 'running', freshness: 'fresh',
      reportedAt: reportAt, queriedAt: reportAt }; },
  ];
  for (const mutate of mutations) {
    const input = report();
    mutate(input.results[1]);
    assert.throws(() => validateQualityReplayReport(input), /Contradictory or incomplete replay evidence/);
  }
  const readMutations = [
    item => { item.httpStatus = 403; },
    item => { item.runStatus = 'failed'; },
    item => { item.modelRequests = 0; },
    item => { item.upstreamCalls = 0; },
    item => { item.toolSteps = []; },
    item => { item.toolSteps[0].status = 'failed'; },
    item => { item.querySnapshot = null; },
    item => { item.querySnapshot.reportedAt = ''; },
    item => { item.boundaryHeld = false; },
  ];
  for (const mutate of readMutations) {
    const input = report();
    mutate(input.results[0]);
    assert.throws(() => validateQualityReplayReport(input), /Contradictory or incomplete replay evidence/);
  }
  for (const field of ['modelRequests', 'preflightReasonMatched', 'toolSteps', 'querySnapshot']) {
    const input = report();
    delete input.results[1][field];
    assert.throws(() => qualityReplayReviewTemplate(input, sha256(JSON.stringify(input)), templateAt));
  }
});

test('real-model reports use null request counts but still require zero-token preflight denial', () => {
  const input = report();
  input.mode = 'real-model-local-dts-replay';
  for (const item of input.results) item.modelRequests = null;
  const reportSha256 = sha256(JSON.stringify(input));
  const review = approve(qualityReplayReviewTemplate(input, reportSha256, templateAt));
  assert.equal(assessQualityReplayReview(input, review,
    { reportSha256, ...current(), now: checkedAt }).reviewReady, true);
  input.results[1].tokens = 1;
  assert.throws(() => validateQualityReplayReport(input), /Contradictory or incomplete replay evidence/);
});

test('old report shape remains reviewable but stale candidates and changed cases stay blocked', () => {
  const stale = report({ ...current(), sourceDigest: 'f'.repeat(64) });
  for (const item of stale.results) delete item.testedStage;
  const staleSha = sha256(JSON.stringify(stale));
  const staleReview = approve(qualityReplayReviewTemplate(stale, staleSha, templateAt));
  assert.deepEqual(staleReview.entries.map(item => item.testedStage),
    ['tool_execution', 'authorization_preflight']);
  const result = assessQualityReplayReview(stale, staleReview, { reportSha256: staleSha, ...current(), now: checkedAt });
  assert.equal(result.reviewStatus, 'approved');
  assert.equal(result.reviewReady, false);
  assert.equal(result.checks.find(item => item.id === 'current_source').status, 'blocked');
  const changedCase = report();
  changedCase.results[0].reconstructedPromptDigest = 'f'.repeat(64);
  const changedSha = sha256(JSON.stringify(changedCase));
  const changedReview = approve(qualityReplayReviewTemplate(changedCase, changedSha, templateAt));
  const changed = assessQualityReplayReview(changedCase, changedReview,
    { reportSha256: changedSha, ...current(), now: checkedAt });
  assert.equal(changed.checks.find(item => item.id === 'current_replay').status, 'blocked');
  const failed = report();
  failed.results[0].automaticEvidencePassed = false;
  failed.automaticEvidenceComplete = false;
  failed.results[0].toolSteps = [];
  const failedSha = sha256(JSON.stringify(failed));
  const failedReview = approve(qualityReplayReviewTemplate(failed, failedSha, templateAt));
  assert.equal(assessQualityReplayReview(failed, failedReview,
    { reportSha256: failedSha, ...current(), now: checkedAt }).reviewReady, false);
});

test('CLI creates private append-only template and check reports for v1 replay output', () => {
  const dir = mkdtempSync(join(tmpdir(), 'quality-replay-review-'));
  try {
    const input = report(current(), new Date(Date.now() - 60_000).toISOString());
    for (const item of input.results) delete item.testedStage;
    const reportFile = join(dir, 'report.json');
    const templateFile = join(dir, 'review.json'), pendingFile = join(dir, 'pending.json');
    const completedFile = join(dir, 'completed-review.json'), resultFile = join(dir, 'result.json');
    writeFileSync(reportFile, JSON.stringify(input, null, 2) + '\n');
    const run = (...args) => spawnSync(process.execPath, ['scripts/review-quality-replay.mjs', ...args],
      { cwd: root, encoding: 'utf8' });
    assert.equal(run('template', '--report', reportFile, '--out', templateFile).status, 0);
    assert.equal(statSync(templateFile).mode & 0o077, 0);
    assert.equal(JSON.parse(readFileSync(templateFile)).reportSha256, sha256(readFileSync(reportFile)));
    assert.deepEqual(JSON.parse(readFileSync(templateFile)).entries.map(item => item.testedStage),
      ['tool_execution', 'authorization_preflight']);
    assert.equal(run('check', '--report', reportFile, '--review', templateFile, '--out', pendingFile).status, 2);
    assert.equal(JSON.parse(readFileSync(pendingFile)).reviewStatus, 'pending');
    assert.equal(statSync(pendingFile).mode & 0o077, 0);
    writeFileSync(completedFile, JSON.stringify(approve(JSON.parse(readFileSync(templateFile)),
      new Date().toISOString()), null, 2));
    const complete = run('check', '--report', reportFile, '--review', completedFile, '--out', resultFile);
    assert.equal(complete.status, 0, complete.stderr || complete.stdout);
    assert.equal(JSON.parse(complete.stdout).humanReviewComplete, false);
    assert.equal(JSON.parse(readFileSync(resultFile)).humanReviewComplete, false);
    assert.equal(JSON.parse(readFileSync(resultFile)).productionAccepted, false);
    assert.equal(run('template', '--report', reportFile, '--out', templateFile).status, 1);
    assert.equal(run('check', '--report', reportFile, '--review', completedFile, '--out', resultFile).status, 1);
    const altered = structuredClone(input);
    altered.results[0].answer += 'changed';
    writeFileSync(reportFile, JSON.stringify(altered, null, 2) + '\n');
    assert.equal(run('check', '--report', reportFile, '--review', completedFile, '--out', join(dir, 'tampered.json')).status, 1);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
