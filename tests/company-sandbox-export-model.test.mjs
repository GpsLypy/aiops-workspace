import test from 'node:test';
import assert from 'node:assert/strict';
import { createCipheriv, createHash, randomBytes } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, symlinkSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { exportCompanySandboxModel } from '../scripts/company-sandbox-export-model.mjs';

function fixture() {
  const directory = mkdtempSync(join(tmpdir(), 'company-poc-model-export-')); const source = join(directory, 'source'); mkdirSync(source);
  const key = randomBytes(32), iv = randomBytes(12); const apiKey = 'PRIVATE_SYNTHETIC_MODEL_EXPORT_KEY';
  const cipher = createCipheriv('aes-256-gcm', key, iv); const ciphertext = Buffer.concat([cipher.update(apiKey), cipher.final()]);
  const config = { baseUrl: 'http://127.0.0.1:9876/private/v1', model: 'private-synthetic-model', apiType: 'responses', temperature: 0.3, apiKeyEncrypted: [iv, cipher.getAuthTag(), ciphertext].map(value => value.toString('base64')).join('.') };
  writeFileSync(join(source, 'master.key'), key, { mode: 0o600 });
  const db = new DatabaseSync(join(source, 'aiops.sqlite')); db.exec('CREATE TABLE settings(key TEXT PRIMARY KEY,value TEXT NOT NULL)'); db.prepare('INSERT INTO settings VALUES(?,?)').run('model', JSON.stringify(config)); db.close();
  return { directory, source, config, apiKey, close: () => rmSync(directory, { recursive: true, force: true }) };
}
const hash = file => createHash('sha256').update(readFileSync(file)).digest('hex');

test('PoC export decrypts only saved model fields into an exclusive 0600 file without mutating source', () => {
  const h = fixture();
  try {
    const database = join(h.source, 'aiops.sqlite'), key = join(h.source, 'master.key'); const before = [hash(database), hash(key)];
    const output = join(h.directory, 'private/model.json');
    const run = spawnSync(process.execPath, ['scripts/company-sandbox-export-model.mjs', '--out', output], { env: { ...process.env, SOURCE_DIR: h.source }, encoding: 'utf8' });
    assert.equal(run.status, 0, run.stderr);
    const saved = JSON.parse(readFileSync(output, 'utf8'));
    assert.deepEqual(saved, { baseUrl: h.config.baseUrl, apiType: 'responses', model: h.config.model, apiKey: h.apiKey });
    assert.equal(statSync(output).mode & 0o777, 0o600); assert.equal(statSync(join(h.directory, 'private')).mode & 0o777, 0o700);
    assert.deepEqual([hash(database), hash(key)], before);
    const summary = JSON.parse(run.stdout); assert.equal(summary.sourceConfigurationUnchanged, true); assert.equal(summary.sourceMasterKeyUnchanged, true); assert.equal(summary.loopback, true); assert.equal(summary.modelOrigin, 'http://127.0.0.1:9876');
    for (const secret of [h.apiKey, h.config.apiKeyEncrypted, 'private-synthetic-model', '/private/v1']) assert.ok(!run.stdout.includes(secret) && !run.stderr.includes(secret));
    assert.throws(() => exportCompanySandboxModel({ sourceDir: h.source, output }), /new private output/);
    assert.deepEqual(JSON.parse(readFileSync(output, 'utf8')), saved);
  } finally { h.close(); }
});

test('PoC export rejects direct and symlinked destinations within the saved data source', () => {
  const h = fixture();
  try {
    const before = hash(join(h.source, 'aiops.sqlite'));
    assert.throws(() => exportCompanySandboxModel({ sourceDir: h.source, output: join(h.source, 'new-private/model.json') }), /outside the source/);
    const alias = join(h.directory, 'alias'); symlinkSync(h.source, alias);
    assert.throws(() => exportCompanySandboxModel({ sourceDir: h.source, output: join(alias, 'new-private/model.json') }), /outside the source/);
    assert.equal(hash(join(h.source, 'aiops.sqlite')), before);
  } finally { h.close(); }
});

test('PoC export refuses a symlinked source key and never reveals decryption failures', () => {
  const h = fixture();
  try {
    const key = join(h.source, 'master.key'); const bytes = readFileSync(key); unlinkSync(key); writeFileSync(join(h.directory, 'other-key'), bytes); symlinkSync(join(h.directory, 'other-key'), key);
    const output = join(h.directory, 'private/model.json');
    const run = spawnSync(process.execPath, ['scripts/company-sandbox-export-model.mjs', '--out', output], { env: { ...process.env, SOURCE_DIR: h.source }, encoding: 'utf8' });
    assert.equal(run.status, 1); assert.equal(run.stdout, ''); assert.match(run.stderr, /PoC saved-model export failed/);
    assert.ok(!run.stderr.includes(h.apiKey) && !run.stderr.includes(h.config.apiKeyEncrypted));
  } finally { h.close(); }
});
