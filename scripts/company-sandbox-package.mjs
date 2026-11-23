import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { closeSync, constants, fstatSync, lstatSync, mkdirSync, mkdtempSync, openSync, readFileSync, readdirSync, rmSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const output = resolve(process.argv[2] || join(root, 'test-results/company-sandbox', `source-${new Date().toISOString().replace(/[:.]/g, '-')}.tar.gz`));
if (!output.endsWith('.tar.gz')) throw new Error('Output must end with .tar.gz');
const files = ['Dockerfile', '.dockerignore', 'package.json', 'package-lock.json', 'index.html', 'tsconfig.json', 'vite.config.ts',
  'agent-worker/worker.py', 'agent-worker/pyproject.toml', 'agent-worker/uv.lock', 'scripts/ops.mjs', 'scripts/check-agent-worker.mjs', 'scripts/model-billing.mjs'];
function addTree(directory, permitted) {
  for (const name of readdirSync(join(root, directory)).sort()) {
    const path = `${directory}/${name}`;
    if (/^(?:private|secrets?|credentials|node_modules|test-results)$/i.test(name)) continue;
    const stat = lstatSync(join(root, path));
    if (stat.isSymbolicLink()) throw new Error(`Symbolic links are prohibited in source bundle: ${path}`);
    if (stat.isDirectory()) { if (!name.startsWith('.')) addTree(path, permitted); }
    else if (stat.isFile() && permitted.test(path) && !/(?:^|\/)(?:\.env[^/]*|\.data|node_modules|test-results|private|credentials|secrets?)(?:\/|$)/i.test(path)) files.push(path);
  }
}
// Explicit source families only: no tests, reports, docs, integrations, hidden
// workspaces, dependency installs, binaries, environment files or credentials.
addTree('server', /\.mjs$/);
addTree('src', /\.(?:ts|tsx|css|svg)$/);
addTree('deploy/company-sandbox', /\.(?:mjs|sh|md|py)$|\/Dockerfile(?:\.dockerignore)?$/);
for (const file of files) if (!lstatSync(join(root, file)).isFile()) throw new Error(`Ordinary source file required: ${file}`);
const manifest = { schemaVersion: 1, createdAt: new Date().toISOString(), kind: 'company-sandbox-filtered-source', productionDataIncluded: false, files: [] };
mkdirSync(dirname(output), { recursive: true, mode: 0o700 });
const temporary = mkdtempSync(join(tmpdir(), 'company-sandbox-package-'));
let descriptor, ownedOutput = false;
try {
  // Freeze validated bytes in a private staging tree so a concurrent edit or
  // symlink replacement cannot make tar differ from the reviewed manifest.
  const staging = join(temporary, 'source'); mkdirSync(staging, { mode: 0o700 });
  for (const path of [...new Set(files)].sort()) {
    const input = openSync(join(root, path), constants.O_RDONLY | constants.O_NOFOLLOW);
    let bytes;
    try { if (!fstatSync(input).isFile()) throw new Error(`Ordinary source file required: ${path}`); bytes = readFileSync(input); }
    finally { closeSync(input); }
    const destination = join(staging, path); mkdirSync(dirname(destination), { recursive: true, mode: 0o700 });
    writeFileSync(destination, bytes, { mode: 0o600, flag: 'wx' });
    manifest.files.push({ path, sha256: createHash('sha256').update(bytes).digest('hex') });
  }
  const listPath = join(temporary, 'files'); writeFileSync(listPath, manifest.files.map(file => file.path).join('\0') + '\0');
  descriptor = openSync(output, 'wx', 0o600); ownedOutput = true;
  const result = spawnSync('tar', ['-C', staging, '-czf', '-', '--null', '-T', listPath], { stdio: ['ignore', descriptor, 'pipe'], encoding: 'utf8' });
  closeSync(descriptor); descriptor = undefined;
  if (result.error || result.status !== 0) throw result.error || new Error(`tar failed: ${result.stderr}`);
  const archive = readFileSync(output); manifest.archiveSha256 = createHash('sha256').update(archive).digest('hex'); manifest.archiveBytes = archive.length;
  writeFileSync(output + '.manifest.json', JSON.stringify(manifest, null, 2) + '\n', { mode: 0o600, flag: 'wx' });
  console.log(JSON.stringify({ output, manifest: output + '.manifest.json', files: manifest.files.length, bytes: manifest.archiveBytes, sha256: manifest.archiveSha256, productionDataIncluded: false }));
} catch (error) {
  if (descriptor !== undefined) closeSync(descriptor);
  if (ownedOutput) unlinkSync(output);
  throw error;
} finally { rmSync(temporary, { recursive: true, force: true }); }
