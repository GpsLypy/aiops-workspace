import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync, rmSync, existsSync, readdirSync } from 'node:fs';
import { randomBytes, createHash, createHmac } from 'node:crypto';
import express from 'express';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openStore } from '../server/store.mjs';
import { createUser } from '../server/auth.mjs';
import { createBackup, restoreBackup, rotateBackup } from '../server/backup.mjs';
import { createApplication } from '../server/app.mjs';
import { listen } from './fixtures.mjs';

test('online encrypted backup restores WAL data and rotates credentials into a new directory', async () => {
  const root = mkdtempSync(join(tmpdir(), 'aiops-backup-')); const source = join(root, 'source'); const store = openStore(source); const recovery = join(root, 'recovery.key'); writeFileSync(recovery, randomBytes(32));
  try {
    store.setSetting('model', { apiKeyEncrypted: store.encrypt('backup-secret-value') });
    store.run('INSERT INTO notification_channels(id,name,kind,config_encrypted,created,updated) VALUES(?,?,?,?,?,?)', 'rotation-channel', '轮换渠道', 'webhook', store.encrypt(JSON.stringify({ endpoint: 'https://example.com/hook?key=rotation-secret', secret: 'rotation-signing-secret' })), new Date().toISOString(), new Date().toISOString());
    const owner = createUser(store, { username: 'backup-owner', password: 'backup-owner-password' }, 'admin');
    const targetBinding = { resourceId: 'backup-resource', tool: 'status', environment: 'production', arguments: { jobid: '9223372036854775807' } };
    store.run('INSERT INTO tasks(id,user_id,name,prompt,schedule_type,timezone,enabled,created,updated,target_binding) VALUES(?,?,?,?,?,?,?,?,?,?)', 'bound-task', owner.id, '目标绑定任务', '查询确认的任务', 'cron', 'Asia/Shanghai', 0, new Date().toISOString(), new Date().toISOString(), JSON.stringify(targetBinding));
    store.audit(null, 'before.backup');
    await createBackup(source, join(root, 'backup'), recovery);
    assert.ok(!readFileSync(join(root, 'backup', 'database.enc')).includes(Buffer.from('backup-secret-value')));
    assert.deepEqual(readdirSync(join(root, 'backup')).sort(), ['database.enc', 'manifest.json']);
    await restoreBackup(join(root, 'backup'), join(root, 'restored'), recovery);
    const restored = openStore(join(root, 'restored'));
    assert.equal(restored.decrypt(restored.setting('model').apiKeyEncrypted), 'backup-secret-value');
    assert.equal(restored.get('PRAGMA user_version').user_version, 7);
    assert.deepEqual(JSON.parse(restored.get('SELECT target_binding FROM tasks WHERE id=?', 'bound-task').target_binding), targetBinding);
    restored.close();
    await assert.rejects(restoreBackup(join(root, 'backup'), source, recovery), /must not exist/);
    await rotateBackup(join(root, 'backup'), join(root, 'rotated'), recovery);
    assert.notDeepEqual(readFileSync(join(root, 'rotated', 'master.key')), readFileSync(join(source, 'master.key')));
    const rotated = openStore(join(root, 'rotated')); assert.equal(rotated.decrypt(rotated.setting('model').apiKeyEncrypted), 'backup-secret-value');
    assert.deepEqual(JSON.parse(rotated.get('SELECT target_binding FROM tasks WHERE id=?', 'bound-task').target_binding), targetBinding);
    assert.equal(JSON.parse(rotated.decrypt(rotated.get('SELECT config_encrypted FROM notification_channels').config_encrypted)).secret, 'rotation-signing-secret'); rotated.close();
    const bytes = readFileSync(join(root, 'backup', 'database.enc')); bytes[100] ^= 1; writeFileSync(join(root, 'backup', 'database.enc'), bytes);
    await assert.rejects(restoreBackup(join(root, 'backup'), join(root, 'corrupt'), recovery)); assert.equal(existsSync(join(root, 'corrupt')), false);
  } finally { store.close(); rmSync(root, { recursive: true, force: true }); }
});

test('readiness, authenticated metrics, audit export and tamper evidence are observable', async () => {
  const root = mkdtempSync(join(tmpdir(), 'aiops-observe-')); const previous = { ...process.env };
  process.env.METRICS_TOKEN = 'metrics-test-token'; process.env.AUDIT_EXPORT_FILE = join(root, 'audit.jsonl');
  const app = createApplication({ dataDir: join(root, 'data'), scheduler: false }); const http = await listen(app.app);
  try {
    assert.equal(app.operations.health().ready, false);
    assert.equal((await fetch(http.url + '/readyz')).status, 200);
    assert.equal((await fetch(http.url + '/metrics')).status, 401);
    const metrics = await fetch(http.url + '/metrics', { headers: { Authorization: 'Bearer metrics-test-token' } }); assert.match(await metrics.text(), /aiops_ready 1/);
    app.store.audit(null, 'export.test', '', { token: 'secret-value' }); await app.operations.tick();
    const lines = readFileSync(process.env.AUDIT_EXPORT_FILE, 'utf8').trim().split('\n').map(JSON.parse);
    assert.equal(lines.length, 1); assert.ok(!JSON.stringify(lines).includes('secret-value'));
    const row = lines[0]; const expected = createHash('sha256').update(JSON.stringify([row.previous_hash, row.user_id, row.action, row.target, row.detail, row.created])).digest('hex'); assert.equal(row.hash, expected);
    await app.operations.tick(); assert.equal(readFileSync(process.env.AUDIT_EXPORT_FILE, 'utf8').trim().split('\n').length, 1);
  } finally { await http.close(); await app.close(); for (const key of Object.keys(process.env)) if (!(key in previous)) delete process.env[key]; Object.assign(process.env, previous); rmSync(root, { recursive: true, force: true }); }
});

test('notification outbox retries with the same signed event identity and records successful delivery', async () => {
  const root = mkdtempSync(join(tmpdir(), 'aiops-notification-')); const previous = { ...process.env }; const received = [];
  const receiver = express(); receiver.use(express.text({ type: 'application/json' }));
  receiver.post('/notify', (req, res) => { received.push({ body: req.body, signature: req.get('x-aiops-signature'), key: req.get('idempotency-key') }); res.sendStatus(received.length === 1 ? 503 : 200); });
  const endpoint = await listen(receiver); process.env.NOTIFICATION_WEBHOOK_URL = endpoint.url + '/notify'; process.env.NOTIFICATION_WEBHOOK_SECRET = 'notification-test-secret';
  const app = createApplication({ dataDir: root, scheduler: false });
  try {
    app.store.run('INSERT INTO notifications(id,kind,payload,created) VALUES(?,?,?,?)', 'event-one', 'test', '{"runId":"safe-run"}', new Date().toISOString());
    await app.operations.tick(); assert.equal(app.store.get('SELECT status FROM notifications').status, 'pending');
    app.store.run('UPDATE notifications SET next_attempt=0'); await app.operations.tick();
    assert.equal(app.store.get('SELECT status FROM notifications').status, 'delivered'); assert.equal(received.length, 2); assert.equal(received[0].key, received[1].key);
    assert.equal(received[0].signature, createHmac('sha256', process.env.NOTIFICATION_WEBHOOK_SECRET).update(received[0].body).digest('hex'));
  } finally { await app.close(); await endpoint.close(); for (const key of Object.keys(process.env)) if (!(key in previous)) delete process.env[key]; Object.assign(process.env, previous); rmSync(root, { recursive: true, force: true }); }
});
