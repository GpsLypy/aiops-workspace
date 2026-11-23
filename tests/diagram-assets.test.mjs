import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { diagramAssetHeaders } from '../server/diagram-assets.mjs';

test('diagram assets: only fixed public diagrams allow same-origin frames and exact inline script hashes', () => {
  const root = mkdtempSync(join(tmpdir(), 'diagram-headers-'));
  try {
    mkdirSync(join(root, 'diagrams'));
    const code = '\nwindow.diagram = true;\n';
    for (const path of ['architecture.html', 'diagrams/system.html', 'diagrams/request-flow.html']) writeFileSync(join(root, path), `<script>${code}</script>`);
    const headers = {};
    const res = { setHeader: (key, value) => { headers[key] = value; } };
    const apply = diagramAssetHeaders(root);
    apply(res, join(root, 'index.html')); assert.deepEqual(headers, {});
    apply(res, join(root, 'diagrams/unknown.html')); assert.deepEqual(headers, {});
    apply(res, join(root, 'diagrams/system.html'));
    assert.equal(headers['X-Frame-Options'], 'SAMEORIGIN');
    const policy = headers['Content-Security-Policy'];
    assert.ok(policy.includes(`'sha256-${createHash('sha256').update(code).digest('base64')}'`));
    assert.match(policy, /frame-ancestors 'self'/); assert.match(policy, /connect-src 'none'/);
    assert.doesNotMatch(policy.split(';').find(part => part.trim().startsWith('script-src')), /unsafe-inline|unsafe-eval/);
    apply(res, join(root, 'architecture.html'));
    assert.equal(headers['X-Frame-Options'], 'DENY'); assert.match(headers['Content-Security-Policy'], /frame-ancestors 'none'/);
  } finally { rmSync(root, { recursive: true, force: true }); }
});
