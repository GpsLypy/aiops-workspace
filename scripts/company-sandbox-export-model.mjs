import { createDecipheriv, createHash } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { closeSync, constants, existsSync, fstatSync, lstatSync, mkdirSync, openSync, readFileSync, realpathSync, unlinkSync, writeFileSync } from 'node:fs';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { pathToFileURL } from 'node:url';

const digest = bytes => createHash('sha256').update(bytes).digest('hex');
function privateFile(path, maximum) {
  const descriptor = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const stat = fstatSync(descriptor);
    if (!stat.isFile() || stat.size > maximum) throw new Error('Saved model source must use ordinary bounded files');
    return readFileSync(descriptor);
  } finally { closeSync(descriptor); }
}
function readSavedModel(sourceDir) {
  const database = join(sourceDir, 'aiops.sqlite');
  if (!lstatSync(database).isFile()) throw new Error('Saved model database must be an ordinary file');
  const db = new DatabaseSync(database, { readOnly: true });
  let value;
  try { value = db.prepare('SELECT value FROM settings WHERE key=?').get('model')?.value; }
  finally { db.close(); }
  if (typeof value !== 'string' || value.length > 65536) throw new Error('Saved model configuration is missing or oversized');
  let config; try { config = JSON.parse(value); } catch { throw new Error('Saved model configuration is invalid'); }
  if (typeof config?.baseUrl !== 'string' || typeof config.model !== 'string' || !config.model.trim() || typeof config.apiKeyEncrypted !== 'string' || !config.apiKeyEncrypted) throw new Error('Saved model configuration is incomplete');
  const apiType = 'responses';
  if (config.apiType && !['responses', 'chat_completions'].includes(config.apiType)) throw new Error('Saved model protocol is invalid');
  let url; try { url = new URL(config.baseUrl); } catch { throw new Error('Saved model endpoint is invalid'); }
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash) throw new Error('Saved model endpoint is invalid');
  const key = privateFile(join(sourceDir, 'master.key'), 32);
  let plaintext;
  try {
    if (key.length !== 32) throw new Error('Saved model key is invalid');
    const parts = config.apiKeyEncrypted.split('.');
    if (parts.length !== 3) throw new Error('Saved model ciphertext is invalid');
    const [iv, tag, ciphertext] = parts.map(part => Buffer.from(part, 'base64'));
    if (iv.length !== 12 || tag.length !== 16) throw new Error('Saved model ciphertext is invalid');
    const decipher = createDecipheriv('aes-256-gcm', key, iv); decipher.setAuthTag(tag);
    plaintext = Buffer.concat([decipher.update(ciphertext), decipher.final()]);
    return { model: { baseUrl: config.baseUrl, apiType, model: config.model, apiKey: plaintext.toString('utf8') }, configurationDigest: digest(value), keyDigest: digest(key), origin: url.origin, loopback: /^(?:localhost|127(?:\.\d{1,3}){3}|\[::1\])$/i.test(url.hostname) };
  } finally { key.fill(0); plaintext?.fill(0); }
}
function canonicalNewPath(output) {
  let ancestor = dirname(output); const suffix = [output.slice(dirname(output).length + 1)];
  while (!existsSync(ancestor)) { suffix.unshift(ancestor.slice(dirname(ancestor).length + 1)); ancestor = dirname(ancestor); }
  return join(realpathSync(ancestor), ...suffix);
}
export function exportCompanySandboxModel({ sourceDir = '.data', output }) {
  if (!output) throw new Error('A new private output file is required');
  const source = realpathSync(resolve(sourceDir)); const destination = resolve(output);
  const canonical = canonicalNewPath(destination); const distance = relative(source, canonical);
  if (!distance || !distance.startsWith('..' + sep) && distance !== '..' && !distance.startsWith(sep)) throw new Error('PoC model export must be outside the source data directory');
  if (existsSync(destination)) throw new Error('A new private output file is required');
  const before = readSavedModel(source);
  mkdirSync(dirname(destination), { recursive: true, mode: 0o700 });
  let owned = false;
  try {
    writeFileSync(destination, JSON.stringify(before.model) + '\n', { mode: 0o600, flag: 'wx' }); owned = true;
    const after = readSavedModel(source);
    if (before.configurationDigest !== after.configurationDigest || before.keyDigest !== after.keyDigest) throw new Error('Saved model source changed while exporting; exported file discarded');
    return { output: destination, loopback: before.loopback, modelOrigin: before.origin, sourceConfigurationUnchanged: true, sourceMasterKeyUnchanged: true };
  } catch (error) { if (owned) unlinkSync(destination); throw error; }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    const args = process.argv.slice(2);
    if (args.length !== 2 || args[0] !== '--out') throw new Error('Usage: SOURCE_DIR=.data node scripts/company-sandbox-export-model.mjs --out NEW_PRIVATE_JSON');
    console.log(JSON.stringify(exportCompanySandboxModel({ sourceDir: process.env.SOURCE_DIR || '.data', output: args[1] })));
  } catch { console.error('PoC saved-model export failed; check the source and use a new private output path'); process.exitCode = 1; }
}
