import { createDecipheriv, createHash } from 'node:crypto';
import { spawn } from 'node:child_process';
import { DatabaseSync } from 'node:sqlite';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { completion } from '../server/model.mjs';

// Credentials stay in process memory/child environment; never print configuration.
function savedModel() {
  const dir = resolve(process.env.SOURCE_DIR || '.data');
  const db = new DatabaseSync(resolve(dir, 'aiops.sqlite'), { readOnly: true });
  let bytes;
  try { bytes = db.prepare('SELECT value FROM settings WHERE key=?').get('model')?.value; }
  finally { db.close(); }
  const config = JSON.parse(bytes || 'null');
  if (!config?.baseUrl || !config?.model || !config?.apiKeyEncrypted) throw new Error('Saved model configuration is incomplete');
  const key = readFileSync(resolve(dir, 'master.key'));
  try {
    const [iv, tag, ciphertext] = config.apiKeyEncrypted.split('.').map(part => Buffer.from(part, 'base64'));
    const decipher = createDecipheriv('aes-256-gcm', key, iv); decipher.setAuthTag(tag);
    return { config, apiKey: Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString('utf8'),
      configurationDigest: createHash('sha256').update(bytes).digest('hex') };
  } finally { key.fill(0); }
}

try {
  const [mode, ...args] = process.argv.slice(2), options = {};
  if (!['probe', 'quality', 'dts'].includes(mode) || args.length % 2) throw new Error('Usage: node scripts/evaluate-saved-model.mjs probe|quality|dts --out NEW_FILE [--repeat 3]');
  for (let i = 0; i < args.length; i += 2) {
    if (!['--out', '--repeat'].includes(args[i]) || options[args[i]] || !args[i + 1] || args[i + 1].startsWith('--')) throw new Error('Invalid or duplicate option');
    options[args[i]] = args[i + 1];
  }
  const output = options['--out'] && resolve(options['--out']);
  if (!output || existsSync(output)) throw new Error('A new output report path is required');
  if (mode !== 'dts' && options['--repeat']) throw new Error('--repeat is only supported for dts');
  const saved = savedModel();
  if (mode === 'probe') {
    const startedAt = new Date().toISOString(), diagnostics = [];
    let response, error;
    try {
      response = await completion({ setting: name => name === 'model' ? saved.config : null, decrypt: () => saved.apiKey },
        [{ role: 'user', content: '请只回复：连接成功' }], [], undefined, () => {}, undefined, item => diagnostics.push(item));
    } catch (failure) { error = failure.message; }
    const unchanged = savedModel().configurationDigest === saved.configurationDigest;
    const report = { version: 1, startedAt, measuredAt: new Date().toISOString(), model: saved.config.model,
      apiType: 'responses', stream: true, configurationUnchanged: unchanged,
      passed: !!response?.message?.content?.trim() && unchanged, diagnostics,
      usage: response?.usage ? Object.fromEntries(['total_tokens', 'prompt_tokens', 'completion_tokens'].map(name => [name, Number.isSafeInteger(response.usage[name]) && response.usage[name] >= 0 ? response.usage[name] : null])) : null,
      answerSha256: response?.message?.content ? createHash('sha256').update(response.message.content).digest('hex') : null,
      error: error || null, productionAccepted: false };
    mkdirSync(dirname(output), { recursive: true });
    writeFileSync(output, JSON.stringify(report, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
    console.log(JSON.stringify({ report: output, passed: report.passed, diagnostics }));
    process.exitCode = report.passed ? 0 : 1;
  } else {
    const script = mode === 'quality' ? 'scripts/evaluate-quality-replay.mjs' : 'scripts/evaluate-dts-runtime.mjs';
    const argv = [script, '--real', '--out', output, ...(mode === 'dts' ? ['--repeat', options['--repeat'] || '3'] : [])];
    const child = spawn(process.execPath, argv, { stdio: 'inherit', env: { ...process.env,
      EVAL_MODEL_BASE_URL: saved.config.baseUrl, EVAL_MODEL_NAME: saved.config.model,
      EVAL_MODEL_API_TYPE: 'responses', EVAL_MODEL_API_KEY: saved.apiKey } });
    for (const signal of ['SIGINT', 'SIGTERM']) process.once(signal, () => child.kill(signal));
    const code = await new Promise((resolveCode, reject) => { child.once('error', reject); child.once('exit', value => resolveCode(value ?? 1)); });
    if (savedModel().configurationDigest !== saved.configurationDigest) throw new Error('Saved configuration changed during evaluation');
    process.exitCode = code;
  }
} catch (error) { console.error(`Saved-model evaluation failed: ${error.message}`); process.exitCode = 1; }
