import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { candidateDigest } from '../scripts/agent-candidate.mjs';
import { appendQualityCase, assessQualityReview, qualityCorpusDigest, qualityReviewTemplate, validateCorpus } from '../scripts/agent-quality-corpus.mjs';

const sourceDigest = 'a'.repeat(64);
const at = new Date('2026-10-08T10:00:00.000Z');
const sample = { id: 'user-report-01', origin: 'user_report', category: 'failure',
  capturedAt: '2026-10-08T08:00:00.000Z', sourceRef: 'INC-001',
  promptSummary: '脱敏后的任务状态问题摘要', expected: '只报告实际查询到的状态',
  rubric: '状态、时间和证据必须一致', sanitized: true };
const observed = { ...sample, id: 'observed-01', origin: 'observed_failure', sourceRef: 'eval-001',
  evaluationRef: { reportSha256: 'b'.repeat(64), key: 'agentscope/prefork/fresh-running/1' } };
const historical = { ...sample, id: 'historical-01', origin: 'historical_candidate', sourceRef: 'history-001' };
const approve = review => ({ ...review, entries: review.entries.map(entry => ({ ...entry, status: 'approved',
  reviewer: 'unit-test-reviewer', reviewedAt: '2026-10-08T09:30:00.000Z', notes: '仅校验格式与门禁', evidenceRef: 'evidence:unit-test' })) });

test('quality corpus requires explicit provenance, sanitized content and unique case IDs', () => {
  const empty = { version: 1, cases: [] };
  const corpus = appendQualityCase(appendQualityCase(empty, sample), observed);
  assert.equal(corpus.cases.length, 2);
  assert.match(qualityCorpusDigest(corpus), /^[a-f0-9]{64}$/);
  assert.throws(() => appendQualityCase(corpus, sample), /Duplicate case ID/);
  assert.throws(() => validateCorpus({ version: 1, cases: [sample, sample] }), /Duplicate case ID/);
  for (const invalid of [{ ...sample, sanitized: false }, { ...sample, origin: 'real' },
    { ...sample, evaluationRef: { reportSha256: 'b'.repeat(64), key: 'legacy/fresh-running/1' } },
    { ...sample, unexpected: 'content' }]) assert.throws(() => appendQualityCase(empty, invalid));
});

test('quality review is bound to source and corpus and remains blocked without real failures or complete human review', () => {
  const corpus = { version: 1, cases: [sample, observed] };
  const template = qualityReviewTemplate(corpus, sourceDigest, new Date('2026-10-08T09:00:00.000Z'));
  assert.equal(template.sourceDigest, sourceDigest);
  assert.equal(template.corpusDigest, qualityCorpusDigest(corpus));
  assert.deepEqual(template.entries.map(entry => entry.caseId), [sample.id, observed.id]);
  assert.equal(assessQualityReview(corpus, template, sourceDigest, at).reviewReady, false);
  const completed = approve(template);
  const result = assessQualityReview(corpus, completed, sourceDigest, at);
  assert.equal(result.reviewReady, true);
  assert.equal(result.productionAccepted, false);
  assert.equal(result.counts.approved, 2);
  assert.equal(assessQualityReview(corpus, completed, 'c'.repeat(64), at).reviewReady, false);
  assert.equal(assessQualityReview({ ...corpus, cases: [{ ...sample, rubric: '更新的标准' }, observed] }, completed, sourceDigest, at).reviewReady, false);
  const onlySynthetic = { version: 1, cases: [{ ...sample, origin: 'synthetic' }] };
  assert.equal(assessQualityReview(onlySynthetic, approve(qualityReviewTemplate(onlySynthetic, sourceDigest, new Date('2026-10-08T09:00:00.000Z'))), sourceDigest, at).reviewReady, false);
  const rejected = structuredClone(completed); rejected.entries[0].status = 'rejected';
  assert.equal(assessQualityReview(corpus, rejected, sourceDigest, at).reviewReady, false);
  const partial = structuredClone(completed); partial.entries.pop();
  assert.equal(assessQualityReview(corpus, partial, sourceDigest, at).reviewReady, false);
});

test('a reviewed historical candidate does not satisfy real problem or observed failure gates', () => {
  const corpus = { version: 1, cases: [historical, { ...observed, category: 'typical' }] };
  const reviewed = approve(qualityReviewTemplate(corpus, sourceDigest, new Date('2026-10-08T09:00:00.000Z')));
  const result = assessQualityReview(corpus, reviewed, sourceDigest, at);
  assert.equal(result.reviewReady, false);
  assert.equal(result.counts.historicalCandidates, 1);
  assert.equal(result.counts.realProblems, 0);
  assert.equal(result.counts.observedFailures, 0);
  assert.equal(result.checks.find(item => item.id === 'real_problem').status, 'blocked');
  assert.equal(result.checks.find(item => item.id === 'failure_sample').status, 'blocked');
  assert.equal(result.checks.find(item => item.id === 'corpus_review').status, 'passed');
  const verified = { version: 1, cases: [{ ...historical, origin: 'user_report' }, observed] };
  assert.notEqual(qualityCorpusDigest(verified), reviewed.corpusDigest);
  assert.equal(assessQualityReview(verified, reviewed, sourceDigest, at).reviewReady, false);
});

test('classified AI source review does not count as explicit human approval', () => {
  const corpus = { version: 1, cases: [sample, observed] };
  const review = approve(qualityReviewTemplate(corpus, sourceDigest, new Date('2026-10-08T09:00:00.000Z')));
  for (const entry of review.entries) entry.reviewerKind = 'ai';
  const ai = assessQualityReview(corpus, review, sourceDigest, at);
  assert.equal(ai.reviewReady, true);
  assert.equal(ai.humanReviewComplete, false);
  assert.deepEqual(ai.counts.completedByReviewerKind, { human: 0, ai: 2, unspecified: 0 });
  review.entries[0].reviewerKind = 'human';
  assert.equal(assessQualityReview(corpus, review, sourceDigest, at).humanReviewComplete, false);
  review.entries[1].reviewerKind = 'human';
  assert.equal(assessQualityReview(corpus, review, sourceDigest, at).humanReviewComplete, true);
});

test('quality review rejects duplicate, unsupported and unevidenced decisions', () => {
  const corpus = { version: 1, cases: [sample] };
  const template = qualityReviewTemplate(corpus, sourceDigest, new Date('2026-10-08T09:00:00.000Z'));
  for (const change of [r => r.entries.push(r.entries[0]), r => { r.entries[0].caseId = 'unknown'; },
    r => { r.entries[0].reviewer = ''; }, r => { r.entries[0].notes = ''; },
    r => { r.entries[0].evidenceRef = ''; }, r => { r.entries[0].reviewedAt = '2026-10-08T08:59:00.000Z'; },
    r => { r.entries[0].reviewedAt = '2026-10-08T10:01:00.000Z'; }]) {
    const review = approve(template); change(review);
    assert.throws(() => assessQualityReview(corpus, review, sourceDigest, at));
  }
});

test('quality CLI creates private append-only outputs and exits 2 for an incomplete review', () => {
  const dir = mkdtempSync(join(tmpdir(), 'agent-quality-'));
  try {
    const empty = join(dir, 'empty.json'), caseFile = join(dir, 'case.json'), corpus = join(dir, 'corpus.json');
    const review = join(dir, 'review.json'), result = join(dir, 'result.json');
    const run = (...args) => spawnSync(process.execPath, ['scripts/agent-quality.mjs', ...args], { encoding: 'utf8' });
    assert.equal(run('init', '--out', empty).status, 0);
    writeFileSync(caseFile, JSON.stringify(sample));
    assert.equal(run('add', '--corpus', empty, '--case', caseFile, '--out', corpus).status, 0);
    assert.equal(run('template', '--corpus', corpus, '--out', review).status, 0);
    assert.equal(JSON.parse(readFileSync(review)).sourceDigest, candidateDigest().sourceDigest);
    assert.equal(run('check', '--corpus', corpus, '--review', review, '--out', result).status, 2);
    assert.equal(JSON.parse(readFileSync(result)).productionAccepted, false);
    assert.equal(run('check', '--corpus', corpus, '--review', review, '--out', result).status, 1);
    assert.equal(run('add', '--corpus', empty, '--case', caseFile, '--out', empty).status, 1);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
