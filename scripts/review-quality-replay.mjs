import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { candidateDigest, root, sha256 } from './agent-candidate.mjs';
import { qualityCorpusDigest, validateCorpus } from './agent-quality-corpus.mjs';
import { qualityReplayCases } from './quality-replay-cases.mjs';
import { assessQualityReplayReview, qualityReplayReviewTemplate } from './quality-replay-review.mjs';

const usage = 'Usage: node scripts/review-quality-replay.mjs template --report FILE --out FILE | check --report FILE --review FILE --out FILE';
try {
  const [command, ...args] = process.argv.slice(2), options = {};
  if (!['template', 'check'].includes(command) || args.length % 2) throw new Error(usage);
  for (let i = 0; i < args.length; i += 2) {
    if (!['--report', '--review', '--out'].includes(args[i]) || !args[i + 1] || args[i + 1].startsWith('--') || options[args[i]]) throw new Error(usage);
    options[args[i]] = resolve(args[i + 1]);
  }
  const expected = command === 'template' ? ['--report', '--out'] : ['--report', '--review', '--out'];
  if (Object.keys(options).sort().join() !== expected.sort().join() ||
      [options['--report'], options['--review']].includes(options['--out'])) throw new Error(usage);

  const reportBytes = readFileSync(options['--report']);
  const report = JSON.parse(reportBytes.toString('utf8'));
  const reportSha256 = sha256(reportBytes);
  let output;
  if (command === 'template') output = qualityReplayReviewTemplate(report, reportSha256);
  else {
    const corpus = validateCorpus(JSON.parse(readFileSync(resolve(root, 'tests/quality-cases.json'), 'utf8')));
    output = assessQualityReplayReview(report, JSON.parse(readFileSync(options['--review'], 'utf8')), {
      reportSha256, sourceDigest: candidateDigest().sourceDigest,
      qualityCorpusDigest: qualityCorpusDigest(corpus), replayDigest: sha256(JSON.stringify(qualityReplayCases)),
    });
  }
  mkdirSync(dirname(options['--out']), { recursive: true });
  writeFileSync(options['--out'], JSON.stringify(output, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
  console.log(JSON.stringify({ command, output: options['--out'], reviewStatus: output.reviewStatus || 'pending',
    reviewComplete: output.reviewComplete ?? false, reviewReady: output.reviewReady ?? false,
    humanReviewComplete: output.humanReviewComplete ?? false,
    productionAccepted: false, counts: output.counts }, null, 2));
  if (command === 'check' && !output.reviewReady) process.exitCode = 2;
} catch (error) {
  console.error(`Quality replay review rejected: ${error.message}`);
  process.exitCode = 1;
}
