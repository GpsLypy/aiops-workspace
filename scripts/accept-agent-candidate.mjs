import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { candidateDigest, sha256 } from './agent-candidate.mjs';
import { assessAcceptance, reviewTemplate, reviewPacket } from './agent-acceptance.mjs';

try {
  const args = process.argv.slice(2), options = {};
  for (let i = 0; i < args.length; i++) {
    const option = args[i];
    if (options[option]) throw new Error(`Duplicate option: ${option}`);
    if (option === '--engineering') { options[option] = true; continue; }
    if (!['--report', '--review', '--template', '--packet', '--out', '--thresholds'].includes(option) ||
      !args[i + 1] || args[i + 1].startsWith('--')) throw new Error('Use --report FILE [--template NEW_FILE | --packet NEW_FILE | --review FILE] [--engineering] [--thresholds FILE] [--out NEW_FILE]');
    options[option] = resolve(args[++i]);
  }
  const create = options['--template'] || options['--packet'];
  if (!options['--report'] || options['--template'] && options['--packet'] ||
    create && (options['--review'] || options['--out'] || options['--engineering'] || options['--thresholds'])) {
    throw new Error('--report is required; --template and --packet must each be used separately');
  }
  const output = create || options['--out'] || resolve(`test-results/agentscope/acceptance-${new Date().toISOString().replaceAll(':', '-')}.json`);
  if ([options['--report'], options['--review'], options['--thresholds']].includes(output)) throw new Error('Output must not overwrite an input');
  const raw = readFileSync(options['--report']), reportSha256 = sha256(raw), report = JSON.parse(raw);
  const write = value => { mkdirSync(dirname(output), { recursive: true });
    writeFileSync(output, JSON.stringify(value, null, 2) + '\n', { flag: 'wx', mode: 0o600 }); };
  if (options['--template']) {
    write(reviewTemplate(report, reportSha256));
    console.log(JSON.stringify({ template: output, status: 'pending', reportSha256 }, null, 2));
  } else if (options['--packet']) {
    const packet = reviewPacket(report, reportSha256); write(packet);
    console.log(JSON.stringify({ packet: output, mode: packet.mode, summary: packet.summary, productionAccepted: false }, null, 2));
  } else {
    const result = assessAcceptance(report, options['--review'] ? JSON.parse(readFileSync(options['--review'])) : null,
      { reportSha256, ...candidateDigest(), thresholds: options['--thresholds'] ? JSON.parse(readFileSync(options['--thresholds'])) : {} });
    write(result); console.log(JSON.stringify({ ...result, output }, null, 2));
    if (!(options['--engineering'] ? result.engineeringReady : result.evaluationAccepted)) process.exitCode = 2;
  }
} catch (error) {
  // Invalid input must not replace an existing success or create false evidence.
  console.error(`Acceptance rejected: ${error.message}`); process.exitCode = 1;
}
