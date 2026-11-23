import { mkdirSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { createBackup } from '../server/backup.mjs';

if (!process.env.BACKUP_DIR || !process.env.BACKUP_KEY_FILE) throw new Error('BACKUP_DIR and BACKUP_KEY_FILE are required');
const root = resolve(process.env.BACKUP_DIR); mkdirSync(root, { recursive: true, mode: 0o700 });
const destination = join(root, new Date().toISOString().replace(/[:.]/g, '-'));
await createBackup(process.env.DATA_DIR || '.data', destination, process.env.BACKUP_KEY_FILE);
console.log(JSON.stringify({ event: 'backup.complete', destination, created: new Date().toISOString() }));
