import { z } from 'zod';
import { sha256 } from './agent-candidate.mjs';

const digest = z.string().regex(/^[a-f0-9]{64}$/);
const timestamp = z.string().datetime();
const text = max => z.string().trim().min(1).max(max);
export const qualityCaseSchema = z.object({
  id: z.string().regex(/^[a-z0-9][a-z0-9-]{2,63}$/),
  origin: z.enum(['user_report', 'observed_failure', 'historical_candidate', 'synthetic']),
  category: z.enum(['typical', 'failure', 'attack']),
  capturedAt: timestamp,
  sourceRef: z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9._:/#-]{2,199}$/),
  promptSummary: text(1000),
  expected: text(2000),
  rubric: text(2000),
  sanitized: z.literal(true),
  evaluationRef: z.object({ reportSha256: digest,
    key: z.string().regex(/^agentscope\/(cold|prefork)\/[a-z0-9-]+\/[1-9]\d*$/) }).strict().optional(),
}).strict();
const corpusSchema = z.object({ version: z.literal(1), cases: z.array(qualityCaseSchema).max(500) }).strict();
const reviewSchema = z.object({
  version: z.literal(1), sourceDigest: digest, corpusDigest: digest, createdAt: timestamp,
  entries: z.array(z.object({ caseId: z.string(), status: z.enum(['pending', 'approved', 'rejected']),
    reviewerKind: z.enum(['human', 'ai', 'unspecified']).default('unspecified'),
    reviewer: z.string().max(200), reviewedAt: z.string(), notes: z.string().max(4000), evidenceRef: z.string().max(200) }).strict()).max(500),
}).strict();

export function validateCorpus(input) {
  const corpus = corpusSchema.parse(input);
  const ids = new Set();
  for (const item of corpus.cases) {
    if (ids.has(item.id)) throw new Error(`Duplicate case ID: ${item.id}`);
    ids.add(item.id);
  }
  return corpus;
}

export function appendQualityCase(corpusInput, caseInput) {
  const corpus = validateCorpus(corpusInput), item = qualityCaseSchema.parse(caseInput);
  if (corpus.cases.some(entry => entry.id === item.id)) throw new Error(`Duplicate case ID: ${item.id}`);
  return validateCorpus({ version: 1, cases: [...corpus.cases, item] });
}

export function qualityCorpusDigest(corpusInput) {
  return sha256(JSON.stringify(validateCorpus(corpusInput)));
}

export function qualityReviewTemplate(corpusInput, sourceDigest, now = new Date()) {
  const corpus = validateCorpus(corpusInput);
  digest.parse(sourceDigest);
  return { version: 1, sourceDigest, corpusDigest: qualityCorpusDigest(corpus), createdAt: now.toISOString(),
    entries: corpus.cases.map(item => ({ caseId: item.id, status: 'pending', reviewerKind: 'unspecified', reviewer: '', reviewedAt: '', notes: '', evidenceRef: '' })) };
}

export function assessQualityReview(corpusInput, reviewInput, sourceDigest, now = new Date()) {
  const corpus = validateCorpus(corpusInput), review = reviewSchema.parse(reviewInput), checks = [];
  digest.parse(sourceDigest);
  const realProblems = corpus.cases.filter(item => item.origin === 'user_report');
  const observedFailures = corpus.cases.filter(item => item.category === 'failure' &&
    (item.origin === 'user_report' || item.origin === 'observed_failure'));
  const historicalCandidates = corpus.cases.filter(item => item.origin === 'historical_candidate');
  const add = (id, passed, detail) => checks.push({ id, status: passed ? 'passed' : 'blocked', detail });
  add('current_source', review.sourceDigest === sourceDigest, '复核源码摘要须与当前候选一致');
  add('current_corpus', review.corpusDigest === qualityCorpusDigest(corpus), '复核语料摘要须与当前案例一致');
  add('real_problem', realProblems.length > 0, '至少一条已核实来源的脱敏真实用户问题；历史候选不计入');
  add('failure_sample', observedFailures.length > 0, '至少一条真实观察到的失败样本；历史候选不计入');
  const remaining = new Set(corpus.cases.map(item => item.id));
  let approved = 0, rejected = 0, pending = 0;
  const completedByReviewerKind = { human: 0, ai: 0, unspecified: 0 };
  for (const entry of review.entries) {
    if (!remaining.delete(entry.caseId)) throw new Error(`Unexpected or duplicate review: ${entry.caseId}`);
    if (entry.status === 'pending') { pending++; continue; }
    const reviewed = timestamp.safeParse(entry.reviewedAt).success ? Date.parse(entry.reviewedAt) : NaN;
    if (!entry.reviewer.trim() || !entry.notes.trim() || !/^[a-zA-Z0-9][a-zA-Z0-9._:/#-]{2,199}$/.test(entry.evidenceRef) ||
      !Number.isFinite(reviewed) || reviewed < Date.parse(review.createdAt) || reviewed > now.getTime()) {
      throw new Error(`Reviewer, notes, evidence reference and valid review time required: ${entry.caseId}`);
    }
    completedByReviewerKind[entry.reviewerKind]++;
    if (entry.status === 'approved') approved++; else rejected++;
  }
  pending += remaining.size;
  add('corpus_review', corpus.cases.length > 0 && approved === corpus.cases.length && rejected === 0 && pending === 0,
    `通过 ${approved}，拒绝 ${rejected}，待复核 ${pending}`);
  return { version: 1, generatedAt: now.toISOString(), sourceDigest, corpusDigest: qualityCorpusDigest(corpus),
    reviewReady: checks.every(item => item.status === 'passed'), reviewComplete: pending === 0,
    humanReviewComplete: corpus.cases.length > 0 && approved === corpus.cases.length && completedByReviewerKind.human === corpus.cases.length,
    productionAccepted: false,
    counts: { total: corpus.cases.length, realProblems: realProblems.length,
      observedFailures: observedFailures.length, historicalCandidates: historicalCandidates.length,
      approved, rejected, pending, completedByReviewerKind }, checks,
    limitations: ['来源和脱敏由提交者声明，CLI 不验证外部事件真实性或自动检测所有敏感信息。',
      'AI 工程复核可完成案例审核，但不计为人工复核；类型及身份均由审核者声明。',
      '案例批准只表示来源与脱敏摘要复核完成；此台账不运行模型，也不构成生产发布批准。'] };
}
