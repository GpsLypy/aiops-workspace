import { createBackup, restoreBackup, rotateBackup } from '../server/backup.mjs';
import { openStore } from '../server/store.mjs';
import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { join } from 'node:path';

const [command, source, destination] = process.argv.slice(2);
if (!command || !source) throw new Error('Usage: npm run ops -- backup|restore|rotate <source> <new-destination> OR audit-check|retention <data-dir>');
if (['backup', 'restore', 'rotate'].includes(command)) {
  if (!destination) throw new Error('A new destination directory is required');
  const fn = { backup: createBackup, restore: restoreBackup, rotate: rotateBackup }[command];
  const result = await fn(source, destination, process.env.BACKUP_KEY_FILE);
  console.log(JSON.stringify({ ok: true, command, destination, schema: result.schema }, null, 2));
} else {
  if (!existsSync(join(source, 'aiops.sqlite'))) throw new Error('Source database does not exist');
  const store = openStore(source);
  try {
    if (command === 'audit-check') {
      let previous = ''; let verified = 0; let legacy = 0;
      for (const row of store.all('SELECT * FROM audit ORDER BY seq')) {
        if (!row.hash) { legacy++; previous = ''; continue; }
        const expected = createHash('sha256').update(JSON.stringify([previous, row.user_id, row.action, row.target, row.detail, row.created])).digest('hex');
        if (row.previous_hash !== previous || row.hash !== expected) throw new Error(`Audit chain mismatch at seq ${row.seq}`);
        previous = row.hash; verified++;
      }
      console.log(JSON.stringify({ verified, legacy, latestHash: previous }));
    } else if (command === 'retention') {
      const days = Number(process.env.RETENTION_DAYS || 90);
      if (!Number.isInteger(days) || days < 30) throw new Error('RETENTION_DAYS must be at least 30');
      const cutoff = new Date(Date.now() - days * 86400000).toISOString();
      const sql = "FROM conversations WHERE updated<? AND busy_until<? AND id NOT IN (SELECT conversation_id FROM executions WHERE status NOT IN ('success','failed','cancelled','interrupted') AND conversation_id IS NOT NULL)";
      const count = store.get(`SELECT count(*) AS n ${sql}`, cutoff, Date.now()).n;
      if (!process.argv.includes('--apply')) console.log(JSON.stringify({ dryRun: true, conversations: count, cutoff }));
      else {
        const backup = store.setting('lastBackup');
        if (!backup || Date.now() - Date.parse(backup.created) > 86400000) throw new Error('A successful backup within 24 hours is required');
        store.transaction(() => { store.run(`DELETE ${sql}`, cutoff, Date.now()); store.run('DELETE FROM auth_sessions WHERE expires<?', Date.now()); store.audit(null, 'retention.apply', '', { cutoff, conversations: count }); });
        console.log(JSON.stringify({ deletedConversations: count, auditAndExecutionsRetained: true }));
      }
    } else throw new Error('Unknown operational command');
  } finally { store.close(); }
}
