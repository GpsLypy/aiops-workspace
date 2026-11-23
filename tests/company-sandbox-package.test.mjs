import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

test('company sandbox package contains only approved source bytes and matches every manifest hash', () => {
  const temporary = mkdtempSync(join(tmpdir(), 'company-poc-package-test-'));
  try {
    const output = join(temporary, 'source.tar.gz');
    const run = spawnSync(process.execPath, ['scripts/company-sandbox-package.mjs', output], { encoding: 'utf8' });
    assert.equal(run.status, 0, run.stderr);
    const manifest = JSON.parse(readFileSync(output + '.manifest.json', 'utf8'));
    const listing = spawnSync('tar', ['-tzf', output], { encoding: 'utf8' }); assert.equal(listing.status, 0, listing.stderr);
    assert.deepEqual(listing.stdout.trim().split('\n').sort(), manifest.files.map(file => file.path).sort());
    assert.equal(manifest.productionDataIncluded, false);
    assert.equal(statSync(output).mode & 0o777, 0o600);
    assert.ok(manifest.files.some(file => file.path === 'scripts/model-billing.mjs'), 'Missing server imported runtime dependency');
    for (const path of ['deploy/company-sandbox/install-runtime.sh', 'deploy/company-sandbox/run-poc.sh', 'deploy/company-sandbox/download-python-ranges.py']) assert.ok(manifest.files.some(file => file.path === path), `Missing deployment helper: ${path}`);
    for (const { path, sha256 } of manifest.files) {
      assert.ok(!/(?:^|\/)(?:\.env[^/]*|\.data|private|credentials|secrets?|tests|test-results|node_modules|integrations|docs|\.git|\.venv)(?:\/|$)/.test(path), path);
      assert.ok(!path.startsWith('/') && !path.split('/').includes('..'), path);
      const item = spawnSync('tar', ['-xOf', output, path]); assert.equal(item.status, 0);
      assert.equal(createHash('sha256').update(item.stdout).digest('hex'), sha256, path);
    }
  } finally { rmSync(temporary, { recursive: true, force: true }); }
});

test('company sandbox package refuses to replace existing output', () => {
  const temporary = mkdtempSync(join(tmpdir(), 'company-poc-package-exclusive-'));
  try {
    const output = join(temporary, 'source.tar.gz'); writeFileSync(output, 'existing-evidence', { mode: 0o600 });
    const run = spawnSync(process.execPath, ['scripts/company-sandbox-package.mjs', output], { encoding: 'utf8' });
    assert.notEqual(run.status, 0);
    assert.equal(readFileSync(output, 'utf8'), 'existing-evidence');
  } finally { rmSync(temporary, { recursive: true, force: true }); }
});
