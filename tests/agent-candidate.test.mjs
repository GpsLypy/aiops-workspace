import test from 'node:test';
import assert from 'node:assert/strict';
import { candidateDigest, candidateManifest, sha256 } from '../scripts/agent-candidate.mjs';

test('candidate binds independent execution, observability configuration and sample provenance without runtime secrets', () => {
  const manifest = candidateManifest(), paths = new Set(manifest.map(item => item.path));
  for (const path of ['integrations/agent-sandbox/broker.mjs', 'integrations/agent-sandbox/mcp.mjs',
    'integrations/agent-sandbox/docker-runtime.mjs', 'deploy/observability/compose.yaml',
    'deploy/observability/collector.yaml', 'deploy/observability/prometheus.yaml',
    'tests/quality-cases.json', 'tests/quality-provenance.json']) assert.ok(paths.has(path), path);
  assert.equal(manifest.length, paths.size);
  assert.ok(manifest.every(item => /^[a-f0-9]{64}$/.test(item.sha256)));
  assert.ok(manifest.every(item => !/(^|\/)(\.env[^/]*|\.data|test-results|\.local-services)(\/|$)/.test(item.path)));
  assert.deepEqual(candidateDigest(), { sourceDigest: sha256(JSON.stringify(manifest)), fileCount: manifest.length });
});
