import { DatabaseSync, backup } from 'node:sqlite';
import { createCipheriv, createDecipheriv, randomBytes, createHash } from 'node:crypto';
import { mkdirSync, existsSync, readFileSync, writeFileSync, chmodSync, createReadStream, createWriteStream, rmSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { pipeline } from 'node:stream/promises';
import { openStore } from './store.mjs';

const digest = value => createHash('sha256').update(value).digest('hex');
function loadKey(path) { const value = readFileSync(path); if (value.length !== 32) throw new Error('Backup encryption key must contain 32 bytes'); return value; }
async function cryptFile(source, target, key, metadata) {
  const iv = metadata ? Buffer.from(metadata.iv, 'hex') : randomBytes(12);
  const cipher = metadata ? createDecipheriv('aes-256-gcm', key, iv) : createCipheriv('aes-256-gcm', key, iv);
  if (metadata) cipher.setAuthTag(Buffer.from(metadata.tag, 'hex'));
  await pipeline(createReadStream(source), cipher, createWriteStream(target, { mode: 0o600, flags: 'wx' }));
  return metadata || { iv: iv.toString('hex'), tag: cipher.getAuthTag().toString('hex') };
}
function envelope(value, key) {
  const iv = randomBytes(12); const cipher = createCipheriv('aes-256-gcm', key, iv); const data = Buffer.concat([cipher.update(value), cipher.final()]);
  return { iv: iv.toString('hex'), tag: cipher.getAuthTag().toString('hex'), data: data.toString('base64') };
}
function unseal(value, key) { const decipher = createDecipheriv('aes-256-gcm', key, Buffer.from(value.iv, 'hex')); decipher.setAuthTag(Buffer.from(value.tag, 'hex')); return Buffer.concat([decipher.update(Buffer.from(value.data, 'base64')), decipher.final()]); }

export async function createBackup(source, destination, backupKeyFile) {
  source = resolve(source); destination = resolve(destination);
  if (!existsSync(join(source, 'aiops.sqlite'))) throw new Error('Source database does not exist');
  if (!backupKeyFile) throw new Error('BACKUP_KEY_FILE is required (separate 32-byte recovery key)');
  const backupKey = loadKey(backupKeyFile); mkdirSync(destination, { mode: 0o700 });
  const store = openStore(source); const snapshot = join(destination, 'snapshot.sqlite');
  try {
    await backup(store.db, snapshot); chmodSync(snapshot, 0o600);
    const check = new DatabaseSync(snapshot, { readOnly: true });
    try { if (check.prepare('PRAGMA integrity_check').get().integrity_check !== 'ok') throw new Error('Backup integrity check failed'); } finally { check.close(); }
    const encryption = await cryptFile(snapshot, join(destination, 'database.enc'), backupKey);
    const manifest = { format: 1, created: new Date().toISOString(), schema: store.get('PRAGMA user_version').user_version, database: encryption, masterKey: envelope(readFileSync(store.keyPath), backupKey) };
    writeFileSync(join(destination, 'manifest.json'), JSON.stringify(manifest, null, 2), { mode: 0o600, flag: 'wx' });
    store.setSetting('lastBackup', { created: manifest.created, destination, schema: manifest.schema });
    store.audit(null, 'backup.complete', '', { destination }); return manifest;
  } finally {
    try { store.close(); }
    finally {
      for (const suffix of ['', '-shm', '-wal', '-journal']) rmSync(`${snapshot}${suffix}`, { force: true });
    }
  }
}

export async function restoreBackup(source, destination, backupKeyFile) {
  source = resolve(source); destination = resolve(destination);
  if (existsSync(destination)) throw new Error('Restore destination must not exist; never restore over a running database');
  const key = loadKey(backupKeyFile); const manifest = JSON.parse(readFileSync(join(source, 'manifest.json'), 'utf8'));
  if (manifest.format !== 1) throw new Error('Unsupported backup format');
  const master = unseal(manifest.masterKey, key); if (master.length !== 32) throw new Error('Invalid restored master key');
  mkdirSync(destination, { mode: 0o700 });
  try {
    await cryptFile(join(source, 'database.enc'), join(destination, 'aiops.sqlite'), key, manifest.database);
    writeFileSync(join(destination, 'master.key'), master, { mode: 0o600, flag: 'wx' });
    const db = new DatabaseSync(join(destination, 'aiops.sqlite'));
    try { if (db.prepare('PRAGMA integrity_check').get().integrity_check !== 'ok' || db.prepare('PRAGMA user_version').get().user_version !== manifest.schema) throw new Error('Restored database verification failed'); }
    finally { db.close(); }
    return { destination, created: manifest.created, schema: manifest.schema };
  } catch (error) { rmSync(destination, { recursive: true, force: true }); throw error; }
}

// Only rotates a new offline restore: original database and key remain available for rollback.
export async function rotateBackup(source, destination, backupKeyFile) {
  if (process.env.MASTER_KEY_FILE) throw new Error('Run rotation without MASTER_KEY_FILE; publish the new key to your secret manager after verification');
  await restoreBackup(source, destination, backupKeyFile);
  const store = openStore(destination); const next = randomBytes(32);
  const encrypt = value => { if (!value) return ''; const sealed = envelope(Buffer.from(value), next); return [Buffer.from(sealed.iv, 'hex'), Buffer.from(sealed.tag, 'hex'), Buffer.from(sealed.data, 'base64')].map(b => b.toString('base64')).join('.'); };
  try {
    store.transaction(() => {
      const model = store.setting('model'); if (model) store.setSetting('model', { ...model, apiKeyEncrypted: encrypt(store.decrypt(model.apiKeyEncrypted)) });
      for (const row of store.all('SELECT id,data FROM resources')) { const data = JSON.parse(row.data); if (data.tokenEncrypted) { data.tokenEncrypted = encrypt(store.decrypt(data.tokenEncrypted)); store.run('UPDATE resources SET data=? WHERE id=?', JSON.stringify(data), row.id); } }
      for (const [table, column] of [['executions', 'input'], ['tool_steps', 'arguments_encrypted'], ['tool_steps', 'response_encrypted'], ['runbooks', 'data'], ['notification_channels', 'config_encrypted'], ['agent_delegations', 'task_encrypted'], ['agent_delegations', 'result_encrypted']]) for (const row of store.all(`SELECT id,${column} AS value FROM ${table} WHERE ${column} IS NOT NULL`)) store.run(`UPDATE ${table} SET ${column}=? WHERE id=?`, encrypt(store.decrypt(row.value)), row.id);
      store.audit(null, 'key.rotate', '', { fingerprint: digest(next).slice(0, 12) });
    });
    writeFileSync(join(destination, 'master.key'), next, { mode: 0o600 });
  } finally { store.close(); }
  const check = openStore(destination);
  try { if (check.setting('model')) check.decrypt(check.setting('model').apiKeyEncrypted); } finally { check.close(); }
  return { destination, keyFingerprint: digest(next).slice(0, 12) };
}
