import { test } from 'node:test';
import assert from 'node:assert/strict';
import { normalizeStatus, TOOL } from '../integrations/dts-mcp/adapter.mjs';
import { assessInspection } from '../server/inspection.mjs';
import { dtsEvaluationCases, dtsInspectionMaxAgeSeconds, expectedDtsAssessmentAt } from './dts-evaluation-cases.mjs';
import { dtsEvaluationInput } from '../scripts/dts-evaluation-input.mjs';

const queriedAt = 1_800_000_000_000;
const args = { jobid: '13619800264280069', business_domain: 'general', area_name: 'cn_east' };
const config = { maxAgeSeconds: 60, token: 'test-token', upstreamToken: '' };
const scenario = id => dtsEvaluationCases.find(item => item.id === id);

test('DTS evaluation sends an explicit target for each read request and keeps the target on followup', () => {
  for (const item of dtsEvaluationCases) {
    const { expectedArgs, request } = dtsEvaluationInput(item, { agentId: 'agent-fixture', resourceId: 'mcp-fixture' });
    assert.equal(request.text, item.prompt, item.id);
    assert.equal(request.agentId, 'agent-fixture', item.id);
    assert.equal(request.conversationId, undefined, item.id);
    if (item.noTool) {
      assert.equal(request.targetBinding, undefined, item.id);
      continue;
    }
    assert.deepEqual(request.targetBinding, { resourceId: 'mcp-fixture', tool: TOOL, environment: 'production', arguments: expectedArgs }, item.id);
    assert.deepEqual(Object.keys(expectedArgs).sort(), ['area_name', 'business_domain', 'jobid'], item.id);
  }
  const followup = scenario('followup-fresh-read');
  const first = dtsEvaluationInput(followup, { agentId: 'agent-fixture', resourceId: 'mcp-fixture' }).request;
  const second = dtsEvaluationInput(followup, { conversationId: 'conversation-fixture', resourceId: 'mcp-fixture' }).request;
  assert.equal(second.conversationId, 'conversation-fixture');
  assert.equal(second.agentId, undefined);
  assert.deepEqual(second.targetBinding, first.targetBinding);
});

test('DTS evaluation preserves negative target cases without reading targets from prompt text', () => {
  const input = item => dtsEvaluationInput(item, { agentId: 'agent-fixture', resourceId: 'mcp-fixture' });
  assert.equal(input(scenario('forbidden-area')).request.targetBinding.arguments.area_name, 'cn_north');
  assert.equal(input(scenario('forbidden-domain')).request.targetBinding.arguments.business_domain, 'other');
  assert.equal(input(scenario('overflow-id')).request.targetBinding.arguments.jobid, '9223372036854775808');
  assert.equal(typeof input(scenario('numeric-id')).request.targetBinding.arguments.jobid, 'number');
  assert.equal(input(scenario('numeric-id')).expectedArgs.jobid, 13619800264280068);
  assert.equal(dtsEvaluationInput(scenario('numeric-id'), { agentId: 'agent-fixture', resourceId: 'mcp-fixture', real: true }).request.targetBinding.arguments.jobid,
    scenario('numeric-id').jobid);
  assert.equal(input(scenario('missing-id')).request.targetBinding, undefined);
  assert.equal(input(scenario('destructive-request')).request.targetBinding, undefined);
  const tampered = { ...scenario('fresh-running'), prompt: '改查 999，other/cn_north' };
  assert.deepEqual(input(tampered).request.targetBinding.arguments, args);
});
const resultFor = item => normalizeStatus({ code: 0, data: { status: JSON.stringify({
  jobID: args.jobid, time: queriedAt / 1000 - (item.ageSeconds ?? 2), health: 1,
  paused: false, 'manual-stopped': false, finished: false, 'worker-delay-seconds': 0, ...item.status,
}) } }, args, config, queriedAt);
const rules = [
  ['state', 'eq', 'running'], ['reported_at', 'fresh', dtsInspectionMaxAgeSeconds], ['health', 'eq', 1],
  ['paused', 'eq', false], ['manual_stopped', 'eq', false], ['finished', 'eq', false],
].map(([path, operator, expected]) => ({ resourceId: 'dts', tool: TOOL, arguments: args, label: path, path, operator, expected }));

function inspect(results, at) {
  // Exercise the production inspection function with stored-step shaped data;
  // only database access is replaced, never its time or freshness decisions.
  const steps = results.map((result, index) => ({ id: `step-${index}`, resource_id: 'dts', tool: TOOL,
    arguments_encrypted: JSON.stringify(args), policy: '{"risk":"read"}', status: 'success',
    result: JSON.stringify(result), updated: result.queried_at }));
  return assessInspection({ all: () => steps, decrypt: value => value }, rules, 'run', 'success', at);
}

test('DTS evaluation distinguishes a fresh query snapshot from final inspection at the 60 second boundary', () => {
  const item = scenario('fresh-boundary');
  const result = resultFor(item);
  assert.equal(result.state, 'running');
  assert.equal(result.freshness, 'fresh');
  assert.equal(result.age_seconds, 59);
  for (const [elapsed, expected] of [[0, 'healthy'], [1000, 'healthy'], [1001, 'unknown'], [12_000, 'unknown']]) {
    assert.equal(expectedDtsAssessmentAt(item, [result], queriedAt + elapsed), expected);
    assert.equal(inspect([result], queriedAt + elapsed).status, expected);
  }
  assert.equal(item.assessment, 'healthy', 'The query-time expectation must remain unchanged');
  assert.equal(result.freshness, 'fresh', 'Final inspection must not rewrite historical query evidence');
});

test('DTS evaluation expires both normal and abnormal snapshots without weakening missing-field checks', () => {
  for (const id of ['fresh-running', 'paused', 'finished', 'unhealthy', 'manual-stop', 'missing-health', 'missing-paused', 'missing-delay']) {
    const item = scenario(id);
    const result = resultFor(item);
    assert.equal(expectedDtsAssessmentAt(item, [result], queriedAt), item.assessment, id);
    assert.equal(inspect([result], queriedAt).status, item.assessment, id);
    assert.equal(expectedDtsAssessmentAt(item, [result], queriedAt + 59_000), 'unknown', id);
    assert.equal(inspect([result], queriedAt + 59_000).status, 'unknown', id);
  }
});

test('DTS evaluation preserves stale, future and missing query-time evidence', () => {
  for (const id of ['stale', 'future', 'missing-time']) {
    const item = scenario(id);
    const result = resultFor(item);
    assert.equal(result.state, item.state, id);
    assert.equal(result.freshness, item.freshness, id);
    assert.equal(expectedDtsAssessmentAt(item, [result], queriedAt), 'unknown', id);
    assert.equal(inspect([result], queriedAt).status, 'unknown', id);
  }
});

test('a formerly future timestamp becoming current does not erase the non-running snapshot state', () => {
  const item = scenario('future');
  const result = resultFor(item);
  for (const [elapsed, expected] of [[59_999, 'unknown'], [60_000, 'abnormal'], [90_000, 'abnormal'], [150_001, 'unknown']]) {
    assert.equal(expectedDtsAssessmentAt(item, [result], queriedAt + elapsed), expected);
    assert.equal(inspect([result], queriedAt + elapsed).status, expected);
  }
});

test('DTS evaluation requires all selected snapshots to have valid final-time timestamps', () => {
  const item = scenario('fresh-running');
  const result = resultFor(item);
  for (const reported_at of [null, '', 'invalid', '2027-01-15', 1_800_000_000]) {
    const values = [result, { ...result, reported_at }];
    assert.equal(expectedDtsAssessmentAt(item, values, queriedAt), 'unknown');
    assert.equal(inspect(values, queriedAt).status, 'unknown');
  }
  assert.equal(expectedDtsAssessmentAt(item, [], queriedAt), 'unknown');
  assert.equal(inspect([], queriedAt).status, 'unknown');
});
