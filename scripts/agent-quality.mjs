import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { candidateDigest } from './agent-candidate.mjs';
import { appendQualityCase, assessQualityReview, qualityReviewTemplate, validateCorpus } from './agent-quality-corpus.mjs';

const usage = 'Usage: node scripts/agent-quality.mjs init --out FILE | add --corpus FILE --case FILE --out NEW_FILE | template --corpus FILE --out FILE | check --corpus FILE --review FILE --out FILE';
try {
  const [command, ...args] = process.argv.slice(2), options = {};
  if (!['init', 'add', 'template', 'check'].includes(command) || args.length % 2) throw new Error(usage);
  for (let i = 0; i < args.length; i += 2) {
    if (!['--corpus', '--case', '--review', '--out'].includes(args[i]) || !args[i + 1] || args[i + 1].startsWith('--') || options[args[i]]) throw new Error(usage);
    options[args[i]] = resolve(args[i + 1]);
  }
  const expected = { init: ['--out'], add: ['--corpus', '--case', '--out'], template: ['--corpus', '--out'], check: ['--corpus', '--review', '--out'] }[command];
  if (Object.keys(options).sort().join() !== expected.sort().join() ||
      (command !== 'init' && [options['--corpus'], options['--case'], options['--review']].includes(options['--out']))) throw new Error(usage);
  const read = path => JSON.parse(readFileSync(path, 'utf8'));
  let output;
  if (command === 'init') output = { version: 1, cases: [] };
  else if (command === 'add') output = appendQualityCase(read(options['--corpus']), read(options['--case']));
  else if (command === 'template') output = qualityReviewTemplate(read(options['--corpus']), candidateDigest().sourceDigest);
  else output = assessQualityReview(read(options['--corpus']), read(options['--review']), candidateDigest().sourceDigest);
  if (command === 'init') validateCorpus(output);
  mkdirSync(dirname(options['--out']), { recursive: true });
  writeFileSync(options['--out'], JSON.stringify(output, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
  console.log(JSON.stringify({ command, output: options['--out'], reviewReady: output.reviewReady ?? false, counts: output.counts }, null, 2));
  if (command === 'check' && !output.reviewReady) process.exitCode = 2;
} catch (error) {
  console.error(`Quality corpus rejected: ${error.message}`);
  process.exitCode = 1;
}
