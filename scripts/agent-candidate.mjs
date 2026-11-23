import { createHash } from 'node:crypto';
import { readFileSync, readdirSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export const root = resolve(fileURLToPath(new URL('..', import.meta.url)));
export const sha256 = value => createHash('sha256').update(value).digest('hex');
export function candidateManifest() {
  const files = ['package.json', 'package-lock.json', 'Dockerfile', 'compose.yaml',
    'tests/dts-evaluation-cases.mjs', 'tests/runtime-fixture.mjs', 'tests/fixtures.mjs', 'tests/responses-fixture.mjs',
    'tests/quality-cases.json', 'tests/quality-provenance.json'];
  function walk(path) {
    for (const entry of readdirSync(path, { withFileTypes: true })) {
      if (entry.name.startsWith('.') || entry.name === '__pycache__') continue;
      const full = join(path, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (/\.(mjs|py|ts|tsx|css|json|toml|lock|md|yaml|yml)$/.test(entry.name) && entry.name !== 'codemap.md' && entry.name !== 'README.md' && entry.name !== 'HANDOFF.md') files.push(relative(root, full));
    }
  }
  for (const dir of ['server', 'src', 'agent-worker', 'scripts', 'integrations/dts-mcp', 'integrations/agent-sandbox', 'deploy/observability']) walk(join(root, dir));
  return [...new Set(files)].sort().map(path => ({ path, sha256: sha256(readFileSync(join(root, path))) }));
}
export function candidateDigest() {
  const manifest = candidateManifest();
  return { sourceDigest: sha256(JSON.stringify(manifest)), fileCount: manifest.length };
}
export const corpusDigest = () => sha256(readFileSync(join(root, 'tests/dts-evaluation-cases.mjs')));
