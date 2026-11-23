import { z } from 'zod';
import { sha256 } from './agent-candidate.mjs';
import { qualityReplayCases, replayPromptDigest } from './quality-replay-cases.mjs';

const digest = z.string().regex(/^[a-f0-9]{64}$/);
const timestamp = z.string().datetime();
const evidenceRef = z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9._:/#-]{2,199}$/);
const reportSchema = z.object({
  version: z.literal(1),
  mode: z.enum(['controlled-model-local-dts-replay', 'real-model-local-dts-replay']),
  startedAt: timestamp,
  measuredAt: timestamp,
  candidate: z.object({ sourceDigest: digest, qualityCorpusDigest: digest, replayDigest: digest }).passthrough(),
  reconstructedPrompts: z.literal(true),
  results: z.array(z.object({
    caseId: z.string().min(1), origin: z.string().min(1), reconstructedPromptDigest: digest,
    testedStage: z.enum(['tool_execution', 'authorization_preflight']).optional(),
    httpStatus: z.number().int().min(100).max(599), runStatus: z.string().nullable(),
    tokens: z.number().int().nonnegative().nullable(), modelRequests: z.number().int().nonnegative().nullable(),
    upstreamCalls: z.number().int().nonnegative(),
    toolSteps: z.array(z.object({ tool: z.string(), status: z.string() }).passthrough()),
    preflightReasonMatched: z.boolean(), boundaryHeld: z.boolean(),
    querySnapshot: z.object({ state: z.string(), freshness: z.string(),
      reportedAt: z.string(), queriedAt: z.string() }).passthrough().nullable(),
    answer: z.string(),
    humanReview: z.literal('pending'), automaticEvidencePassed: z.boolean(),
  }).passthrough()).min(1).max(500),
  automaticEvidenceComplete: z.boolean(),
  humanReviewComplete: z.literal(false),
  productionToolsUsed: z.literal(false),
  productionAccepted: z.literal(false),
}).passthrough();
const reviewSchema = z.object({
  version: z.literal(1), reportSha256: digest, sourceDigest: digest,
  qualityCorpusDigest: digest, replayDigest: digest, createdAt: timestamp,
  entries: z.array(z.object({
    caseId: z.string().min(1), testedStage: z.enum(['tool_execution', 'authorization_preflight']),
    answerSha256: digest,
    status: z.enum(['pending', 'approved', 'rejected']),
    reviewerKind: z.enum(['human', 'ai', 'unspecified']).optional().default('unspecified'),
    reviewer: z.string().max(200), reviewedAt: z.string(), notes: z.string().max(4000),
    evidenceRef: z.string().max(200),
  }).strict()).max(500),
}).strict();

export function validateQualityReplayReport(input) {
  const report = reportSchema.parse(input);
  const ids = new Set();
  const results = report.results.map(item => {
    if (ids.has(item.caseId)) throw new Error(`Duplicate replay case: ${item.caseId}`);
    ids.add(item.caseId);
    if (item.testedStage) return item;
    const known = qualityReplayCases.find(entry => entry.caseId === item.caseId);
    const expectedStatus = known?.kind === 'read' ? 200 : 403;
    if (!known || item.origin !== known.origin || item.reconstructedPromptDigest !== replayPromptDigest(known) ||
        item.httpStatus !== expectedStatus) throw new Error(`Cannot infer legacy replay stage: ${item.caseId}`);
    return { ...item, testedStage: known.kind === 'read' ? 'tool_execution' : 'authorization_preflight' };
  });
  for (const item of results) {
    const modelRequestsMatch = report.mode === 'real-model-local-dts-replay'
      ? item.modelRequests === null
      : item.testedStage === 'authorization_preflight' ? item.modelRequests === 0 : item.modelRequests > 0;
    const snapshot = item.querySnapshot;
    const evidencePassed = item.testedStage === 'authorization_preflight'
      ? item.httpStatus === 403 && item.runStatus === 'failed' && item.tokens === 0 &&
        modelRequestsMatch && item.upstreamCalls === 0 && item.toolSteps.length === 0 &&
        item.boundaryHeld && item.preflightReasonMatched && snapshot === null
      : item.httpStatus === 200 && item.runStatus === 'success' && modelRequestsMatch &&
        item.upstreamCalls === 1 && item.toolSteps.length === 1 &&
        item.toolSteps[0].tool === 'dts_get_job_status' && item.toolSteps[0].status === 'success' &&
        item.boundaryHeld && !item.preflightReasonMatched && snapshot?.state === 'running' &&
        snapshot.freshness === 'fresh' && !!snapshot.reportedAt?.trim() &&
        !!snapshot.queriedAt?.trim() && !!item.answer.trim();
    if (item.automaticEvidencePassed !== !!evidencePassed) {
      throw new Error(`Contradictory or incomplete replay evidence: ${item.caseId}`);
    }
  }
  if (Date.parse(report.startedAt) > Date.parse(report.measuredAt) ||
      report.automaticEvidenceComplete !== results.every(item => item.automaticEvidencePassed)) {
    throw new Error('Inconsistent quality replay report');
  }
  return { ...report, results };
}

export function qualityReplayReviewTemplate(reportInput, reportSha256, now = new Date()) {
  const report = validateQualityReplayReport(reportInput);
  digest.parse(reportSha256);
  if (Date.parse(report.measuredAt) > now.getTime()) throw new Error('Replay report is dated in the future');
  return {
    version: 1, reportSha256,
    sourceDigest: report.candidate.sourceDigest,
    qualityCorpusDigest: report.candidate.qualityCorpusDigest,
    replayDigest: report.candidate.replayDigest,
    createdAt: now.toISOString(),
    entries: report.results.map(item => ({ caseId: item.caseId, testedStage: item.testedStage,
      answerSha256: sha256(item.answer),
      status: 'pending', reviewerKind: 'unspecified', reviewer: '', reviewedAt: '', notes: '', evidenceRef: '' })),
  };
}

export function assessQualityReplayReview(reportInput, reviewInput, {
  reportSha256, sourceDigest, qualityCorpusDigest, replayDigest, now = new Date(),
}) {
  const report = validateQualityReplayReport(reportInput);
  const review = reviewSchema.parse(reviewInput);
  for (const value of [reportSha256, sourceDigest, qualityCorpusDigest, replayDigest]) digest.parse(value);
  if (review.reportSha256 !== reportSha256 ||
      review.sourceDigest !== report.candidate.sourceDigest ||
      review.qualityCorpusDigest !== report.candidate.qualityCorpusDigest ||
      review.replayDigest !== report.candidate.replayDigest) {
    throw new Error('Review is bound to a different report or candidate');
  }
  if (Date.parse(review.createdAt) < Date.parse(report.measuredAt) || Date.parse(review.createdAt) > now.getTime()) {
    throw new Error('Invalid review template time');
  }
  const remaining = new Map(report.results.map(item => [item.caseId,
    { testedStage: item.testedStage, answerSha256: sha256(item.answer) }]));
  let approved = 0, rejected = 0, pending = 0;
  const completedByReviewerKind = { human: 0, ai: 0, unspecified: 0 };
  for (const entry of review.entries) {
    const expectedAnswer = remaining.get(entry.caseId);
    if (!expectedAnswer || entry.answerSha256 !== expectedAnswer.answerSha256 ||
        entry.testedStage !== expectedAnswer.testedStage) {
      throw new Error(`Unexpected, duplicate or changed replay answer/stage: ${entry.caseId}`);
    }
    remaining.delete(entry.caseId);
    if (entry.status === 'pending') { pending++; continue; }
    const reviewedAt = timestamp.safeParse(entry.reviewedAt).success ? Date.parse(entry.reviewedAt) : NaN;
    if (!entry.reviewer.trim() || !entry.notes.trim() || !evidenceRef.safeParse(entry.evidenceRef).success ||
        !Number.isFinite(reviewedAt) || reviewedAt < Date.parse(review.createdAt) || reviewedAt > now.getTime()) {
      throw new Error(`Reviewer, notes, evidence reference and valid review time required: ${entry.caseId}`);
    }
    completedByReviewerKind[entry.reviewerKind]++;
    if (entry.status === 'approved') approved++; else rejected++;
  }
  if (remaining.size) throw new Error(`Missing replay reviews: ${[...remaining.keys()].join(', ')}`);

  const expectedCases = new Map(qualityReplayCases.map(item => [item.caseId,
    { origin: item.origin, promptDigest: replayPromptDigest(item),
      testedStage: item.kind === 'read' ? 'tool_execution' : 'authorization_preflight' }]));
  const currentCases = report.results.length === expectedCases.size && report.results.every(item => {
    const expected = expectedCases.get(item.caseId);
    return expected && item.origin === expected.origin && item.reconstructedPromptDigest === expected.promptDigest &&
      item.testedStage === expected.testedStage;
  });
  const checks = [];
  const add = (id, passed, detail) => checks.push({ id, status: passed ? 'passed' : 'blocked', detail });
  add('current_source', report.candidate.sourceDigest === sourceDigest, '报告源码摘要须与当前候选一致');
  add('current_corpus', report.candidate.qualityCorpusDigest === qualityCorpusDigest, '报告质量语料摘要须与当前案例一致');
  add('current_replay', report.candidate.replayDigest === replayDigest && currentCases, '报告重构问题及案例须与当前版本一致');
  add('automatic_evidence', report.automaticEvidenceComplete, '所有本机自动证据须通过');
  add('replay_review', approved === report.results.length, `通过 ${approved}，拒绝 ${rejected}，待复核 ${pending}`);
  const reviewStatus = rejected ? 'rejected' : pending ? 'pending' : 'approved';
  const humanReviewComplete = approved === report.results.length && completedByReviewerKind.human === report.results.length;
  return {
    version: 1, generatedAt: now.toISOString(), reportSha256,
    candidate: { sourceDigest: report.candidate.sourceDigest,
      qualityCorpusDigest: report.candidate.qualityCorpusDigest, replayDigest: report.candidate.replayDigest },
    mode: report.mode, reconstructedPrompts: true, syntheticTaskIds: true,
    reviewStatus, reviewComplete: pending === 0, reviewReady: checks.every(item => item.status === 'passed'), humanReviewComplete,
    productionAccepted: false, counts: { total: report.results.length, approved, rejected, pending,
      completedByReviewerKind,
      modelAnswerCases: report.results.filter(item => item.testedStage === 'tool_execution').length,
      preflightDenialCases: report.results.filter(item => item.testedStage === 'authorization_preflight').length }, checks,
    limitations: ['重构问题和任务 ID 是合成数据；逐条通过仅审查本报告答复，不构成真实用户质量证据。',
      'authorization_preflight 案例在模型前拒绝；其审查只评价前置拒绝和执行证据，不评价模型答复。',
      'AI 或未声明类型的工程复核可完成回放审查，但不能计为人工复核；人工类型也是声明，不核实身份。',
      '摘要绑定报告和答复字节，不证明外部事件真实性或复核人身份，也不批准生产发布。'],
  };
}
