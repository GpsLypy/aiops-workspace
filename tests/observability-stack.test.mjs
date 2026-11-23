import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { readObservabilityTargets, validateObservabilityTargets } from '../scripts/observability-stack.mjs';

test('shared metrics identify distinct workspaces and refuse duplicate or credential-bearing scrape targets', () => {
  const targets = readObservabilityTargets('deploy/observability/targets.example.json');
  assert.equal(targets.length, 2);
  for (const bad of [
    [targets[0], targets[0]],
    [targets[0], { ...targets[1], labels: { ...targets[1].labels, workspace: targets[0].labels.workspace } }],
    [{ ...targets[0], targets: ['user:secret@host:3001'] }],
    [{ ...targets[0], targets: ['host:65536'] }],
    [{ ...targets[0], labels: { ...targets[0].labels, apiKey: 'secret' } }],
  ]) assert.throws(() => validateObservabilityTargets(bad));
});

test('deployment uses protected metrics credentials, persistent stores and fleet histograms without raw trace logging', () => {
  const collector = readFileSync('deploy/observability/collector.yaml', 'utf8');
  const prometheus = readFileSync('deploy/observability/prometheus.yaml', 'utf8');
  const rules = readFileSync('deploy/observability/rules.yaml', 'utf8');
  assert.doesNotMatch(collector, /debug:/);
  assert.match(collector, /memory_limiter/); assert.match(collector, /otlphttp\/tempo/);
  assert.match(prometheus, /credentials_file: \/run\/secrets\/metrics-token/);
  assert.match(rules, /sum by \(stage, le\) \(rate\(aiops_agent_trace_duration_seconds_bucket/);
  assert.match(rules, /workspace_model_estimated_cost_total/);
  assert.doesNotMatch(rules, /billed.*cost|real.*cost|fleet_model_cost_total/);
});
