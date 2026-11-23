import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

test('frozen wheel plan selects official Linux CPython artifacts and dry-run performs no downloads', () => {
  const temporary = mkdtempSync(join(tmpdir(), 'company-poc-wheel-plan-'));
  try {
    const output = join(temporary, 'plan');
    const before = readFileSync('agent-worker/uv.lock');
    const prepare = spawnSync('python3', ['deploy/company-sandbox/prepare-wheels.py', '--project', 'agent-worker', '--glibc', '2.35', '--out-directory', output], { encoding: 'utf8' });
    assert.equal(prepare.status, 0, prepare.stderr);
    const manifest = JSON.parse(readFileSync(join(output, 'wheel-plan.json'), 'utf8'));
    assert.equal(manifest.lockSha256, createHash('sha256').update(before).digest('hex'));
    assert.deepEqual(readFileSync('agent-worker/uv.lock'), before);
    assert.ok(manifest.wheels.some(wheel => wheel.name === 'agentscope' && wheel.version === '2.0.8'));
    assert.ok(!manifest.wheels.some(wheel => ['pywin32', 'colorama', 'httpx2-jsfetch'].includes(wheel.name)));
    for (const wheel of manifest.wheels) {
      assert.equal(new URL(wheel.url).origin, 'https://files.pythonhosted.org');
      assert.match(wheel.sha256, /^[a-f0-9]{64}$/);
      assert.ok(!/macos|win32|win_amd64|aarch64|musllinux/.test(wheel.filename));
    }
    const wheelDirectory = join(temporary, 'missing-wheels');
    const dryRun = spawnSync('python3', ['deploy/company-sandbox/download-wheels.py', '--manifest', join(output, 'wheel-plan.json'), '--wheel-directory', wheelDirectory], { encoding: 'utf8' });
    assert.equal(dryRun.status, 0, dryRun.stderr); assert.equal(JSON.parse(dryRun.stdout).execute, false);
    assert.equal(existsSync(wheelDirectory), false, 'Dry-run must not create a wheelhouse');
  } finally { rmSync(temporary, { recursive: true, force: true }); }
});

test('wheel verification rejects artifacts outside the lock and incomplete wheelhouses before installation', () => {
  const temporary = mkdtempSync(join(tmpdir(), 'company-poc-wheel-reject-'));
  try {
    const output = join(temporary, 'plan');
    const prepare = spawnSync('python3', ['deploy/company-sandbox/prepare-wheels.py', '--project', 'agent-worker', '--glibc', '2.35', '--out-directory', output], { encoding: 'utf8' }); assert.equal(prepare.status, 0, prepare.stderr);
    const manifestPath = join(output, 'wheel-plan.json'); const wheelDirectory = join(temporary, 'missing-wheels');
    const verify = spawnSync('python3', ['deploy/company-sandbox/download-wheels.py', '--manifest', manifestPath, '--wheel-directory', wheelDirectory, '--verify-complete'], { encoding: 'utf8' });
    assert.notEqual(verify.status, 0); assert.match(verify.stderr, /Complete verified wheelhouse required/); assert.equal(existsSync(wheelDirectory), false);
    const manifest = JSON.parse(readFileSync(manifestPath, 'utf8')); manifest.wheels[0].url = 'https://fixture.invalid/private.whl'; writeFileSync(manifestPath, JSON.stringify(manifest));
    const rejected = spawnSync('python3', ['deploy/company-sandbox/download-wheels.py', '--manifest', manifestPath, '--wheel-directory', wheelDirectory], { encoding: 'utf8' });
    assert.notEqual(rejected.status, 0); assert.match(rejected.stderr, /not present in the frozen official PyPI lock/); assert.equal(existsSync(wheelDirectory), false);
  } finally { rmSync(temporary, { recursive: true, force: true }); }
});
