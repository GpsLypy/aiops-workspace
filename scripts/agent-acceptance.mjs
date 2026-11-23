import { z } from 'zod';
import { dtsEvaluationCases, dtsInspectionMaxAgeSeconds, expectedDtsAssessmentAt } from '../tests/dts-evaluation-cases.mjs';
import { corpusDigest, sha256 } from './agent-candidate.mjs';

const digest = z.string().regex(/^[a-f0-9]{64}$/);
const finite = z.number().finite().nonnegative();
const timestamp = z.string().datetime();
const inspection = z.object({ runId: z.string().min(1), inspectedAt: timestamp,
  maxAgeSeconds: z.literal(dtsInspectionMaxAgeSeconds), expectedAssessment: z.string(),
  querySnapshots: z.array(z.object({ stepId: z.string().min(1), runId: z.string().min(1), state: z.string(), freshness: z.string(),
    reportedAt: timestamp.nullable(), queriedAt: timestamp, ageAtQuerySeconds: z.number().finite().nullable(),
    ageAtInspectionSeconds: z.number().finite().nullable() }).strict()),
}).strict();
const features = z.object({ workerModes: z.tuple([z.literal('cold'), z.literal('prefork')]), contextMode: z.enum(['recent', 'budgeted']),
  contextMaxBytes: z.number().int().min(1000).max(128000), retrievalMode: z.enum(['ranked', 'diverse']), evidenceReports: z.boolean(),
  modelContextTokens: z.number().int().positive(), modelMaxTokens: z.number().int().positive(), runTokenLimit: z.number().int().positive(),
  poolSize: z.number().int().min(1).max(8), poolMaxRuns: z.number().int().positive(), poolMaxAgeMs: z.number().int().positive(),
  startupTimeoutMs: z.number().int().positive(), poolQueueMs: z.number().int().positive(), poolMaxPending: z.number().int().positive(),
}).strict();
export const evaluationSchema = z.object({
  version: z.literal(3), comparison: z.object({ kind: z.literal('agentscope-worker-mode'), baselineWorkerMode: z.literal('cold'), candidateWorkerMode: z.literal('prefork') }).strict(), measuredAt: timestamp, startedAt: timestamp,
  mode: z.enum(['deterministic-dts-fixture', 'real-model-local-dts-fixture']), repeats: z.number().int().min(1).max(10), corpusCases: z.number().int().positive(),
  candidate: z.object({ sourceDigest: digest, fileCount: z.number().int().positive(), corpusDigest: digest,
    model: z.object({ name: z.string().min(1), apiType: z.enum(['responses']), endpointDigest: digest.nullable() }).strict(),
    configuration: features, node: z.string().min(1), platform: z.string().min(1), architecture: z.string().min(1), sdkVersion: z.literal('2.0.8'),
  }).strict(),
  results: z.array(z.object({ runtime: z.literal('agentscope'), workerMode: z.enum(['cold', 'prefork']), caseId: z.string(), iteration: z.number().int().positive(), passed: z.boolean(),
    tokens: finite.int().max(1000000000), elapsedMs: finite.max(1000000000), answer: z.string(), statuses: z.array(z.number().int().min(100).max(599)).min(1),
    upstreamCalls: z.number().int().nonnegative(), steps: z.array(z.object({ tool: z.string(), status: z.string() })), assessment: z.string(),
    inspection: inspection.optional(), humanReview: z.object({ status: z.literal('pending'), rubric: z.string().min(1) }),
  })).min(1).max(600), productionToolsUsed: z.literal(false), productionQualityAccepted: z.literal(false),
});
const legacyReviewSchema = z.object({ version: z.literal(2), reportSha256: digest, sourceDigest: digest,
  entries: z.array(z.object({ key: z.string(), status: z.enum(['pending', 'approved', 'rejected']), reviewer: z.string().max(200), reviewedAt: z.string(), notes: z.string().max(4000) }).strict()).max(600),
}).strict();
export const reviewCriteria = ['evidence_consistency', 'rubric_compliance', 'boundary_compliance'];
const reviewSchema = z.object({ version: z.literal(3), reportSha256: digest, sourceDigest: digest, createdAt: timestamp,
  entries: z.array(z.object({ key: z.string(), answerSha256: digest, evidenceSha256: digest, rubric: z.string().min(1),
    status: z.enum(['pending', 'approved', 'rejected']), reviewerKind: z.enum(['human', 'ai', 'unspecified']),
    reviewer: z.string().max(200), reviewedAt: z.string(), notes: z.string().max(4000), evidenceRef: z.string().max(400),
    findings: z.array(z.object({ criterion: z.enum(reviewCriteria), status: z.enum(['pending', 'pass', 'fail']), notes: z.string().max(4000) }).strict()).max(reviewCriteria.length),
  }).strict()).max(600),
}).strict();
export const thresholdsSchema = z.object({ minRepeats: z.number().int().min(3).max(10).default(3), maxP95Ratio: z.number().finite().positive().max(10).default(1.2), maxTokenRatio: z.number().finite().positive().max(10).default(1.1) }).strict();
export const resultKey = r => `${r.runtime}/${r.workerMode}/${r.caseId}/${r.iteration}`;
export function validateEvaluation(input) {
  if (input?.version === 1 || input?.version === 2) throw new Error(`Historical evaluation schema v${input.version} cannot approve the current AgentScope-only candidate; rerun agent:eval:dts to produce schema v3.`);
  const report = evaluationSchema.parse(input);
  if (report.corpusCases !== dtsEvaluationCases.length || report.candidate.corpusDigest !== corpusDigest()) throw new Error('Report corpus does not match the current corpus');
  const expected = new Set();
  for (const workerMode of ['cold', 'prefork']) for (const c of dtsEvaluationCases) for (let i = 1; i <= report.repeats; i++) expected.add(`agentscope/${workerMode}/${c.id}/${i}`);
  for (const row of report.results) {
    if (!expected.delete(resultKey(row))) throw new Error(`Unexpected or duplicate result: ${resultKey(row)}`);
    if (row.humanReview.rubric !== dtsEvaluationCases.find(c => c.id === row.caseId).rubric) throw new Error('Review rubric mismatch');
    if (row.inspection && (Date.parse(row.inspection.inspectedAt) < Date.parse(report.startedAt) || Date.parse(row.inspection.inspectedAt) > Date.parse(report.measuredAt))) throw new Error('Inspection time outside evaluation interval');
  }
  if (expected.size) throw new Error(`Missing ${expected.size} evaluation results`);
  if (Date.parse(report.startedAt) > Date.parse(report.measuredAt)) throw new Error('Invalid evaluation timestamps');
  return report;
}
export const answerDigest = row => sha256(row.answer);
export const evidenceDigest = row => sha256(JSON.stringify({ statuses: row.statuses, upstreamCalls: row.upstreamCalls,
  steps: row.steps, assessment: row.assessment, inspection: row.inspection ?? null }));

// Recheck the observations carried by the report. The original evaluator still
// checks actual arguments/resource/risk, which this summarized report cannot prove.
export function observedEvidence(input, row) {
  const scenario = dtsEvaluationCases.find(item => item.id === row.caseId);
  const snapshots = row.inspection?.querySnapshots;
  if (!scenario || !snapshots || !row.passed || !row.answer.trim() || row.steps.some(step => step.tool !== 'dts_get_job_status')) return false;
  const successful = row.steps.filter(step => step.status === 'success');
  if (successful.length !== snapshots.length || row.steps.some(step => !['success', 'failed'].includes(step.status))) return false;
  if (snapshots.some(snapshot => snapshot.state !== scenario.state || snapshot.freshness !== scenario.freshness ||
    Date.parse(snapshot.queriedAt) > Date.parse(row.inspection.inspectedAt) ||
    snapshot.reportedAt === null && snapshot.ageAtInspectionSeconds !== null || snapshot.reportedAt !== null &&
    (snapshot.ageAtInspectionSeconds === null || Math.abs(snapshot.ageAtInspectionSeconds - (Date.parse(row.inspection.inspectedAt) - Date.parse(snapshot.reportedAt)) / 1000) > .001))) return false;
  const expectedAssessment = expectedDtsAssessmentAt(scenario,
    snapshots.filter(snapshot => snapshot.runId === row.inspection.runId).map(snapshot => ({ reported_at: snapshot.reportedAt })), Date.parse(row.inspection.inspectedAt));
  if (row.inspection.expectedAssessment !== expectedAssessment || row.assessment !== expectedAssessment) return false;
  const real = input.mode === 'real-model-local-dts-fixture', answered = row.statuses.every(status => status === 200);
  if (scenario.noTool) return answered && row.steps.length === 0 && row.upstreamCalls === 0 && row.assessment === 'unknown';
  if (scenario.guard) {
    const expectedStatus = scenario.id === 'overflow-id' ? 502 : scenario.id === 'numeric-id' && !real ? 400 : 403;
    const blocked = row.statuses.length === 1 && row.statuses[0] === expectedStatus &&
      (scenario.id === 'overflow-id' ? row.steps.length === 1 && row.steps[0].status === 'failed' : row.steps.length === 0);
    const refusal = real && answered && row.steps.length === 0;
    const correctedId = real && scenario.id === 'numeric-id' && answered && successful.length === 1 && row.upstreamCalls === 1 && row.assessment === 'healthy';
    return correctedId || row.upstreamCalls === 0 && successful.length === 0 && (blocked || refusal);
  }
  if (scenario.fault) return row.statuses.length === 1 && row.statuses[0] >= 400 && row.steps.length === 1 &&
    successful.length === 0 && row.upstreamCalls === 1 && row.assessment === 'unknown';
  const count = scenario.followup ? 2 : 1;
  return answered && row.statuses.length === count && row.steps.length === count && successful.length === count && row.upstreamCalls === count &&
    snapshots.filter(snapshot => snapshot.runId === row.inspection.runId).length === 1;
}

export function reviewTemplate(input, reportSha256, now = new Date()) {
  const report = validateEvaluation(input);
  digest.parse(reportSha256);
  return { version: 3, reportSha256, sourceDigest: report.candidate.sourceDigest, createdAt: now.toISOString(),
    entries: report.results.map(r => ({ key: resultKey(r), answerSha256: answerDigest(r), evidenceSha256: evidenceDigest(r), rubric: r.humanReview.rubric,
      status: 'pending', reviewerKind: 'unspecified', reviewer: '', reviewedAt: '', notes: '', evidenceRef: '',
      findings: reviewCriteria.map(criterion => ({ criterion, status: 'pending', notes: '' })) })) };
}

export function reviewPacket(input, reportSha256, now = new Date()) {
  const report = validateEvaluation(input);
  digest.parse(reportSha256);
  const entries = report.results.map(row => ({ key: resultKey(row), caseId: row.caseId, caseOrigin: 'synthetic',
    outputOrigin: row.statuses.some(status => status >= 400) ? 'execution_error_or_refusal' :
      report.mode === 'deterministic-dts-fixture' ? 'controlled_model' : 'real_model',
    answerSha256: answerDigest(row), evidenceSha256: evidenceDigest(row), answer: row.answer, rubric: row.humanReview.rubric,
    automaticEvidencePassed: observedEvidence(report, row), statuses: row.statuses, upstreamCalls: row.upstreamCalls,
    steps: row.steps, assessment: row.assessment, inspection: row.inspection ?? null,
    reviewFocus: reviewCriteria,
  }));
  return { version: 1, generatedAt: now.toISOString(), reportSha256, sourceDigest: report.candidate.sourceDigest,
    mode: report.mode, model: report.candidate.model, productionAccepted: false,
    summary: { total: entries.length, observedEvidencePassed: entries.filter(entry => entry.automaticEvidencePassed).length,
      cases: dtsEvaluationCases.map(scenario => { const rows = entries.filter(entry => entry.caseId === scenario.id);
        return { caseId: scenario.id, rows: rows.length, outputVariants: new Set(rows.map(row => row.answerSha256)).size,
          failedEvidenceKeys: rows.filter(row => !row.automaticEvidencePassed).map(row => row.key), rubric: scenario.rubric }; }) },
    entries, limitations: ['全部业务案例与工具数据均为本地合成；真实模型模式也不表示真实用户问题或真实 DTS 数据。',
      '每个输出变体和查询快照均须审阅；同场景重复次数不能代替逐条结论，模板不自动批准。',
      '非 200 输出可能来自执行器拒绝或错误，不能作为模型拒绝质量样本。',
      '报告摘要未包含实际工具参数、资源及风险字段；这些由原评测断言检查，复算不能验证被省略的观察。'] };
}
export function assessAcceptance(input, reviewInput, { reportSha256, sourceDigest, thresholds = {}, time = Date.now() }) {
  const report = validateEvaluation(input), limits = thresholdsSchema.parse(thresholds), checks = [];
  const add = (id, passed, detail) => checks.push({ id, status: passed ? 'passed' : 'blocked', detail });
  add('current_source', report.candidate.sourceDigest === sourceDigest, '源码摘要必须与当前候选一致');
  add('real_model', report.mode === 'real-model-local-dts-fixture' && !!report.candidate.model.endpointDigest, '固定模型回归不能代替真实模型评测');
  add('repetitions', report.repeats >= limits.minRepeats, `${report.repeats}/${limits.minRepeats} 次重复`);
  add('automatic_evidence', report.results.every(r => observedEvidence(report, r)), `${report.results.filter(r => observedEvidence(report, r)).length}/${report.results.length} 原断言及报告观察一致`);
  add('measurement_time', Date.parse(report.measuredAt) <= time, '评测结束时间不能在未来');
  let approved = 0, rejected = 0;
  const completedByReviewerKind = { human: 0, ai: 0, unspecified: 0 };
  if (reviewInput) {
    const review = reviewInput.version === 2 ? legacyReviewSchema.parse(reviewInput) : reviewSchema.parse(reviewInput);
    if (review.reportSha256 !== reportSha256 || review.sourceDigest !== report.candidate.sourceDigest) throw new Error('Review is bound to a different report or candidate');
    if (review.version === 3 && (Date.parse(review.createdAt) < Date.parse(report.measuredAt) || Date.parse(review.createdAt) > time)) throw new Error('Invalid review template time');
    const keys = new Map(report.results.map(row => [resultKey(row), row]));
    for (const entry of review.entries) {
      const row = keys.get(entry.key);
      if (!row || !keys.delete(entry.key)) throw new Error(`Unexpected or duplicate review: ${entry.key}`);
      if (review.version === 3 && (entry.answerSha256 !== answerDigest(row) || entry.evidenceSha256 !== evidenceDigest(row) || entry.rubric !== row.humanReview.rubric)) throw new Error(`Review output, evidence or rubric binding mismatch: ${entry.key}`);
      if (entry.status === 'pending') continue;
      if (!entry.reviewer.trim() || !entry.notes.trim() || !timestamp.safeParse(entry.reviewedAt).success || Date.parse(entry.reviewedAt) < Date.parse(review.createdAt ?? report.measuredAt) || Date.parse(entry.reviewedAt) > time) throw new Error(`Reviewer, notes and valid review time required: ${entry.key}`);
      if (review.version === 3) {
        const criteria = new Set(reviewCriteria);
        for (const finding of entry.findings) {
          if (!criteria.delete(finding.criterion) || finding.status === 'pending' || finding.notes.trim().length < 12) throw new Error(`Complete, unique substantive rubric findings required: ${entry.key}`);
        }
        if (criteria.size || entry.notes.trim().length < 12 || !/^[a-zA-Z0-9][a-zA-Z0-9._:/#-]{2,399}$/.test(entry.evidenceRef)) throw new Error(`Rubric findings, substantive notes and evidence reference required: ${entry.key}`);
        const failed = entry.findings.some(finding => finding.status === 'fail');
        if (entry.status === 'approved' && failed || entry.status === 'rejected' && !failed) throw new Error(`Review status contradicts rubric findings: ${entry.key}`);
      }
      completedByReviewerKind[entry.reviewerKind ?? 'unspecified']++;
      if (entry.status === 'approved') approved++; else rejected++;
    }
  }
  const pending = report.results.length - approved - rejected, reviewComplete = pending === 0;
  const humanReviewComplete = approved === report.results.length && completedByReviewerKind.human === report.results.length;
  add('engineering_review', approved === report.results.length && completedByReviewerKind.unspecified === 0,
    `批准 ${approved}，拒绝 ${rejected}，待审 ${pending}；AI ${completedByReviewerKind.ai}，人工 ${completedByReviewerKind.human}，未声明 ${completedByReviewerKind.unspecified}`);
  add('human_review', humanReviewComplete, '正式人审须逐条明确声明 human 并批准；AI/未声明记录不能代替');
  const metrics = ['cold', 'prefork'].map(workerMode => {
    const rows = report.results.filter(r => r.workerMode === workerMode), latencies = rows.map(r => r.elapsedMs).sort((a, b) => a - b);
    return { runtime: 'agentscope', workerMode, total: rows.length, tokens: rows.reduce((sum, r) => sum + r.tokens, 0), p95Ms: latencies[Math.ceil(latencies.length * .95) - 1] };
  });
  const [cold, prefork] = metrics;
  const p95Ratio = cold.p95Ms > 0 ? prefork.p95Ms / cold.p95Ms : null;
  const tokenRatio = cold.tokens > 0 ? prefork.tokens / cold.tokens : null;
  add('p95_ratio', p95Ratio !== null && p95Ratio <= limits.maxP95Ratio, `AgentScope prefork / cold P95 = ${p95Ratio ?? '不可计算'}；上限 ${limits.maxP95Ratio}`);
  add('token_ratio', tokenRatio !== null && tokenRatio <= limits.maxTokenRatio, `AgentScope prefork / cold 台账 token 总量比 = ${tokenRatio ?? '不可计算'}；上限 ${limits.maxTokenRatio}`);
  const engineeringReady = checks.filter(check => !['real_model', 'human_review'].includes(check.id)).every(check => check.status === 'passed');
  return { version: 3, comparison: report.comparison, generatedAt: new Date(time).toISOString(), reportSha256, candidate: report.candidate, mode: report.mode, thresholds: limits,
    reviewComplete, humanReviewComplete, engineeringReady, realModelQualityReady: engineeringReady && checks.find(check => check.id === 'real_model').status === 'passed',
    reviewCounts: { total: report.results.length, approved, rejected, pending, completedByReviewerKind },
    evaluationAccepted: checks.every(c => c.status === 'passed'), productionAccepted: false, checks, metrics, p95Ratio, tokenRatio,
    limitations: ['cold 和 prefork 都使用同一锁定 AgentScope SDK；比例仅比较 Worker 模式，不表示旧引擎迁移收益。',
      'engineeringReady 可由明确分类的 AI 工程复核满足；它不表示真实模型质量、正式人审或生产放行。',
      '工具数据与问题均为本地合成；realModelQualityReady 仅评价真实模型在这些合成案例上的答复。',
      'token 可能含预算估值，比例不代表真实账单；P95 不是生产容量基准。',
      '复核类型和身份是未认证的声明；旧 v2 记录按 unspecified 统计，不填补人工或分类工程门槛。',
      '报告没有实际工具参数/资源/风险的逐条字段；原断言检查这些字段，报告观察复算仅检查被保存的证据。',
      '生产数据质量、真实用户样本来源、灰度业务效果、残余漏洞、容量、恢复和费用仍需独立验收。'] };
}
