import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

const execute = promisify(execFile);
const image = process.argv[2];
if (!image || image.startsWith('-')) throw new Error('Usage: npm run agent:image:audit -- image-tag');
const output = resolve('test-results/agentscope'); mkdirSync(output, { recursive: true });
const scanner = process.env.TRIVY_BIN || 'trivy';
const run = async (file, args) => (await execute(file, args, { timeout: 720000, maxBuffer: 4_000_000 })).stdout;
const reportPath = join(output, 'image-vulnerabilities.json');
const summaryPath = join(output, 'image-audit-summary.json');
try {
  const info = JSON.parse(await run('docker', ['image', 'inspect', '--format', '{{json .}}', image]));
  const version = (await run(scanner, ['--version'])).split('\n')[0];
  // Resolve the mutable tag once. All subsequent checks target this local image ID.
  await run(scanner, ['image', '--image-src', 'docker', '--scanners', 'vuln', '--pkg-types', 'os,library',
    '--format', 'json', '--list-all-pkgs', '--output', reportPath, '--timeout', '10m', info.Id]);
  await run(scanner, ['convert', '--format', 'cyclonedx', '--output', join(output, 'image-sbom.cdx.json'), reportPath]);
  const report = JSON.parse(readFileSync(reportPath, 'utf8'));
  const packages = (report.Results || []).flatMap(r => r.Packages || []);
  const coverage = { os: report.Results?.some(r => r.Class === 'os-pkgs' && r.Packages?.length),
    python: packages.some(p => p.Name === 'agentscope'), node: packages.some(p => p.Name === 'express') };
  const findings = (report.Results || []).flatMap(r => (r.Vulnerabilities || []).map(v => ({ target: r.Target, package: v.PkgName,
    id: v.VulnerabilityID, severity: v.Severity, installed: v.InstalledVersion, fixed: v.FixedVersion || null })));
  const blockers = findings.filter(v => ['HIGH', 'CRITICAL'].includes(v.severity) && v.fixed);
  const passed = Object.values(coverage).every(Boolean) && blockers.length === 0;
  const unresolvedHighCritical = findings.filter(v => ['HIGH', 'CRITICAL'].includes(v.severity) && !v.fixed);
  const bySeverity = findings.reduce((counts, v) => ({ ...counts, [v.severity]: (counts[v.severity] || 0) + 1 }), {});
  const summary = { measuredAt: new Date().toISOString(), scanner: version, image, imageId: info.Id, architecture: info.Architecture,
    passed, productionSecurityAccepted: false, coverage, packages: packages.length, vulnerabilities: findings.length, bySeverity,
    fixableHighCritical: blockers.length, blockers, unresolvedHighCritical: unresolvedHighCritical.length,
    policy: 'Require OS, AgentScope Python and Express Node coverage; block fixable HIGH/CRITICAL. Full report retains unfixed and lower severity findings.' };
  writeFileSync(summaryPath, JSON.stringify(summary, null, 2) + '\n'); console.log(JSON.stringify(summary, null, 2));
  if (!passed) process.exitCode = 1;
} catch (error) {
  writeFileSync(summaryPath, JSON.stringify({ measuredAt: new Date().toISOString(), image, passed: false, error: 'Image scan did not complete; inspect scanner/network availability.' }, null, 2) + '\n');
  console.error(error.message); process.exitCode = 1;
}
