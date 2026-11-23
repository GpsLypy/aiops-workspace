import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { candidateDigest, root, sha256 } from '../scripts/agent-candidate.mjs';
import { qualityCorpusDigest, validateCorpus } from '../scripts/agent-quality-corpus.mjs';
import { qualityReplayCases, sanitizeReplayAnswer, validateQualityReplayCases } from '../scripts/quality-replay-cases.mjs';

const corpus = validateCorpus(JSON.parse(readFileSync(join(root, 'tests/quality-cases.json'), 'utf8')));

test('quality replay uses reconstructed prompts and dedicated synthetic targets', () => {
  assert.equal(validateQualityReplayCases(qualityReplayCases, corpus), qualityReplayCases);
  assert.equal(qualityReplayCases.length, 2);
  assert.equal(new Set(qualityReplayCases.map(item => item.jobid)).size, 2);
  assert.ok(qualityReplayCases.every(item => item.prompt.includes(item.jobid)));
  assert.throws(() => validateQualityReplayCases([{ ...qualityReplayCases[0], jobid: '1' }, qualityReplayCases[1]], corpus), /Unsafe/);
  assert.throws(() => validateQualityReplayCases(qualityReplayCases, { cases: corpus.cases.map(item =>
    item.id === qualityReplayCases[0].caseId ? { ...item, origin: 'synthetic' } : item) }), /Unsafe/);
  assert.equal(sanitizeReplayAnswer(`任务 ${qualityReplayCases[0].jobid}，Bearer private-token`), '任务 [REDACTED_ID]，Bearer [REDACTED]');
});

test('quality replay stays local by default and writes only a private pending report', () => {
  const dir = mkdtempSync(join(tmpdir(), 'quality-replay-test-'));
  try {
    const file = join(dir, 'report.json');
    const run = (...args) => spawnSync(process.execPath, ['scripts/evaluate-quality-replay.mjs', ...args], {
      cwd: root, encoding: 'utf8', timeout: 90000,
      env: { ...process.env, EVAL_MODEL_BASE_URL: '', EVAL_MODEL_NAME: '', EVAL_MODEL_API_KEY: '',
        EVAL_MODEL_API_TYPE: 'responses', MODEL_MAX_TOKENS: '512' },
    });
    const result = run('--out', file);
    assert.equal(result.status, 2, result.stderr || result.stdout);
    const raw = readFileSync(file, 'utf8');
    const report = JSON.parse(raw);
    assert.equal(statSync(file).mode & 0o077, 0);
    assert.equal(report.mode, 'controlled-model-local-dts-replay');
    assert.equal(report.candidate.model.apiType, 'responses');
    assert.equal(report.candidate.sourceDigest, candidateDigest().sourceDigest);
    assert.equal(report.candidate.qualityCorpusDigest, qualityCorpusDigest(corpus));
    assert.equal(report.candidate.replayDigest, sha256(JSON.stringify(qualityReplayCases)));
    assert.equal(report.reconstructedPrompts, true);
    assert.equal(report.productionToolsUsed, false);
    assert.equal(report.productionAccepted, false);
    assert.equal(report.humanReviewComplete, false);
    assert.equal(report.automaticEvidenceComplete, true);
    assert.equal(report.results.length, 2);
    assert.ok(report.results.every(item => item.humanReview === 'pending' && item.automaticEvidencePassed));
    assert.ok(qualityReplayCases.every(item => !raw.includes(item.jobid)));
    const read = report.results.find(item => item.caseId === 'workspace-dts-status-followup');
    assert.equal(read.httpStatus, 200);
    assert.equal(read.testedStage, 'tool_execution');
    assert.equal(read.upstreamCalls, 1);
    assert.equal(read.modelRequests, 2);
    assert.deepEqual(read.toolSteps, [{ tool: 'dts_get_job_status', status: 'success' }]);
    assert.equal(read.querySnapshot.state, 'running');
    assert.ok(read.answer.includes(`状态：${read.querySnapshot.state}`));
    assert.ok(read.answer.includes(`上报时间：${read.querySnapshot.reportedAt}`));
    assert.ok(read.answer.includes(`查询时间：${read.querySnapshot.queriedAt}`));
    assert.ok(read.answer.includes(`新鲜度：${read.querySnapshot.freshness}`));
    assert.match(read.answer, /本机合成回放/);
    const denied = report.results.find(item => item.caseId === 'observed-v2-forbidden-area');
    assert.equal(denied.httpStatus, 403);
    assert.equal(denied.testedStage, 'authorization_preflight');
    assert.equal(denied.upstreamCalls, 0);
    assert.equal(denied.modelRequests, 0);
    assert.equal(denied.preflightReasonMatched, true);
    assert.deepEqual(denied.toolSteps, []);
    assert.match(report.limitations.join(' '), /does not replay the historical model target-substitution failure/);
    assert.equal(run('--out', file).status, 1, 'Report must not be overwritten');
    const missingModel = join(dir, 'real.json');
    assert.equal(run('--real', '--out', missingModel).status, 1, 'Real mode requires explicit endpoint and model');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
