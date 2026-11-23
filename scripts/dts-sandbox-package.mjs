import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { chmodSync, closeSync, constants, copyFileSync, fstatSync, lstatSync, mkdirSync, mkdtempSync, openSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const output = resolve(process.argv[2] || `test-results/dts-sandbox/source-${Date.now()}.tar.gz`);
if (!output.endsWith('.tar.gz')) throw Error('Output must end with .tar.gz');
const files = ['integrations/dts-mcp/adapter.mjs', 'integrations/dts-mcp/index.mjs', 'server/security.mjs',
  'deploy/dts-sandbox/service.mjs', 'deploy/dts-sandbox/probe.mjs', 'deploy/dts-sandbox/tunnel.mjs'];
const staging = mkdtempSync(join(tmpdir(), 'dts-sandbox-'));
const manifest = { schemaVersion: 1, kind: 'dts-sandbox-source', credentialsIncluded: false, files: [] };
try {
  const sources = [...files.map(path => [path, path]), ['deploy/dts-sandbox/package.json', 'package.json'], ['deploy/dts-sandbox/package-lock.json', 'package-lock.json']];
  for (const [source, path] of sources) {
    if (!lstatSync(join(root, source)).isFile() || lstatSync(join(root, source)).isSymbolicLink()) throw Error('Only ordinary source files are allowed');
    const fd = openSync(join(root, source), constants.O_RDONLY | constants.O_NOFOLLOW);
    let bytes;
    try { if (!fstatSync(fd).isFile()) throw Error('Ordinary source required'); bytes = readFileSync(fd); } finally { closeSync(fd); }
    mkdirSync(dirname(join(staging, path)), { recursive: true });
    writeFileSync(join(staging, path), bytes);
    manifest.files.push({ path, sha256: createHash('sha256').update(bytes).digest('hex') });
  }
  const archive = join(staging, 'source.tar.gz');
  const result = spawnSync('tar', ['-C', staging, '-czf', archive, ...manifest.files.map(f => f.path)], { encoding: 'utf8' });
  if (result.status !== 0) throw Error('tar failed');
  manifest.archiveSha256 = createHash('sha256').update(readFileSync(archive)).digest('hex');
  mkdirSync(dirname(output), { recursive: true, mode: 0o700 });
  copyFileSync(archive, output, constants.COPYFILE_EXCL);
  chmodSync(output, 0o600);
  writeFileSync(output + '.manifest.json', JSON.stringify(manifest, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
  console.log(JSON.stringify({ output, sha256: manifest.archiveSha256, files: manifest.files.length, credentialsIncluded: false }));
} finally { rmSync(staging, { recursive: true, force: true }); }
