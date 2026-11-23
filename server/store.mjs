import { DatabaseSync } from 'node:sqlite';
import { mkdirSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { randomBytes, randomUUID, createCipheriv, createDecipheriv, createHash } from 'node:crypto';
import { redact } from './security.mjs';

export function openStore(directory = process.env.DATA_DIR || '.data') {
  const dir = resolve(directory);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const keyPath = resolve(process.env.MASTER_KEY_FILE || join(dir, 'master.key'));
  if (!existsSync(keyPath)) {
    if (existsSync(join(dir, 'aiops.sqlite')) || process.env.MASTER_KEY_FILE) throw new Error('Master key missing; restore the matching key before opening the database');
    writeFileSync(keyPath, randomBytes(32), { mode: 0o600, flag: 'wx' });
  }
  const key = readFileSync(keyPath);
  if (key.length !== 32) throw new Error('Invalid master.key');
  const db = new DatabaseSync(join(dir, 'aiops.sqlite'));
  const version = db.prepare('PRAGMA user_version').get().user_version;
  if (version > 7) { db.close(); throw new Error('Database schema is newer than this application'); }
  db.exec('PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000;');
  if (version === 0) db.exec(`
    PRAGMA journal_mode=WAL;
    PRAGMA foreign_keys=ON;
    PRAGMA busy_timeout=5000;
    CREATE TABLE IF NOT EXISTS users (
      id TEXT PRIMARY KEY, username TEXT UNIQUE NOT NULL, name TEXT NOT NULL,
      password TEXT NOT NULL, role TEXT NOT NULL, active INTEGER NOT NULL DEFAULT 1,
      created TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS auth_sessions (
      token TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      expires INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS resources (
      id TEXT PRIMARY KEY, kind TEXT NOT NULL, owner_id TEXT NOT NULL REFERENCES users(id),
      data TEXT NOT NULL, created TEXT NOT NULL, updated TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS resources_kind ON resources(kind);
    CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS conversations (
      id TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id), title TEXT NOT NULL,
      agent_id TEXT, created TEXT NOT NULL, updated TEXT NOT NULL, busy_until INTEGER NOT NULL DEFAULT 0
    );
    CREATE TABLE IF NOT EXISTS messages (
      seq INTEGER PRIMARY KEY AUTOINCREMENT, conversation_id TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
      role TEXT NOT NULL, content TEXT NOT NULL, metadata TEXT NOT NULL DEFAULT '{}', created TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS tasks (
      id TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id), name TEXT NOT NULL,
      prompt TEXT NOT NULL, agent_id TEXT, schedule_type TEXT NOT NULL,
      cron TEXT, timezone TEXT NOT NULL, run_at TEXT, enabled INTEGER NOT NULL,
      next_run TEXT, lease_until INTEGER NOT NULL DEFAULT 0, created TEXT NOT NULL, updated TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS task_runs (
      id TEXT PRIMARY KEY, task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
      status TEXT NOT NULL, started TEXT NOT NULL, finished TEXT, conversation_id TEXT,
      result TEXT, error TEXT, lease_until INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS audit (
      seq INTEGER PRIMARY KEY AUTOINCREMENT, user_id TEXT, action TEXT NOT NULL,
      target TEXT, detail TEXT NOT NULL, created TEXT NOT NULL
    );
    PRAGMA user_version=1;
  `);
  if (version < 2) {
    db.exec(`BEGIN IMMEDIATE;
      CREATE TABLE resource_versions(resource_id TEXT NOT NULL, revision INTEGER NOT NULL, data TEXT NOT NULL, actor_id TEXT, action TEXT NOT NULL, created TEXT NOT NULL, PRIMARY KEY(resource_id,revision));
      CREATE TABLE knowledge_chunks(resource_id TEXT NOT NULL REFERENCES resources(id) ON DELETE CASCADE, revision INTEGER NOT NULL, offset INTEGER NOT NULL, content TEXT NOT NULL, PRIMARY KEY(resource_id,offset));
      CREATE TABLE executions(id TEXT PRIMARY KEY,user_id TEXT NOT NULL,request_key TEXT NOT NULL,input_hash TEXT NOT NULL,input TEXT NOT NULL,status TEXT NOT NULL,conversation_id TEXT,created TEXT NOT NULL,updated TEXT NOT NULL,result TEXT,error TEXT,reserved_tokens INTEGER NOT NULL DEFAULT 0,tokens INTEGER NOT NULL DEFAULT 0,cost REAL NOT NULL DEFAULT 0,UNIQUE(user_id,request_key));
      CREATE INDEX executions_status ON executions(status,created);
      CREATE TABLE tool_steps(id TEXT PRIMARY KEY,run_id TEXT NOT NULL REFERENCES executions(id),resource_id TEXT NOT NULL,resource_revision INTEGER NOT NULL,tool TEXT NOT NULL,arguments_encrypted TEXT NOT NULL,environment TEXT NOT NULL,policy TEXT NOT NULL,status TEXT NOT NULL,created TEXT NOT NULL,updated TEXT NOT NULL,expires INTEGER NOT NULL,approved_by TEXT,result TEXT,error TEXT,verification TEXT);
      CREATE INDEX tool_steps_status ON tool_steps(status,created);
      CREATE TABLE notifications(id TEXT PRIMARY KEY,kind TEXT NOT NULL,payload TEXT NOT NULL,status TEXT NOT NULL DEFAULT 'pending',attempts INTEGER NOT NULL DEFAULT 0,next_attempt INTEGER NOT NULL DEFAULT 0,created TEXT NOT NULL);
      ALTER TABLE audit ADD COLUMN previous_hash TEXT NOT NULL DEFAULT '';
      ALTER TABLE audit ADD COLUMN hash TEXT NOT NULL DEFAULT '';
      CREATE INDEX messages_conversation ON messages(conversation_id,seq);
      CREATE INDEX task_runs_task ON task_runs(task_id,started);
      CREATE INDEX tasks_due ON tasks(enabled,next_run);
      PRAGMA user_version=2;`);
    // Legacy instructions require review; old MCP allowlists do not establish risk classification.
    for (const row of db.prepare('SELECT * FROM resources').all()) {
      const data = JSON.parse(row.data); data.revision = 1;
      data.publication = ['skills', 'agents'].includes(row.kind) ? 'draft' : 'published';
      data.toolPolicies ||= {};
      db.prepare('UPDATE resources SET data=? WHERE id=?').run(JSON.stringify(data), row.id);
      const { tokenEncrypted, ...safe } = data;
      db.prepare('INSERT INTO resource_versions(resource_id,revision,data,actor_id,action,created) VALUES(?,?,?,?,?,?)').run(row.id, 1, JSON.stringify({ ...safe, id: row.id, kind: row.kind, ownerId: row.owner_id }), null, 'migration', row.updated);
    }
    db.exec('COMMIT');
  }
  if (version < 3) db.exec(`BEGIN IMMEDIATE;
    CREATE VIRTUAL TABLE knowledge_search USING fts5(resource_id UNINDEXED, offset UNINDEXED, tokens);
    CREATE TABLE runbooks(id TEXT PRIMARY KEY,name TEXT NOT NULL,owner_id TEXT NOT NULL,reviewer_id TEXT,revision INTEGER NOT NULL,publication TEXT NOT NULL,data TEXT NOT NULL,created TEXT NOT NULL,updated TEXT NOT NULL);
    PRAGMA user_version=3; COMMIT;`);
  if (version < 4) db.exec(`BEGIN IMMEDIATE;
    ALTER TABLE tasks ADD COLUMN notification TEXT NOT NULL DEFAULT '{}';
    ALTER TABLE tasks ADD COLUMN inspection_rules TEXT NOT NULL DEFAULT '[]';
    ALTER TABLE tasks ADD COLUMN notification_state TEXT NOT NULL DEFAULT '{}';
    ALTER TABLE task_runs ADD COLUMN execution_id TEXT;
    ALTER TABLE task_runs ADD COLUMN assessment TEXT;
    CREATE TABLE notification_channels(id TEXT PRIMARY KEY,name TEXT NOT NULL,kind TEXT NOT NULL,config_encrypted TEXT NOT NULL,allowed_users TEXT NOT NULL DEFAULT '[]',enabled INTEGER NOT NULL DEFAULT 1,revision INTEGER NOT NULL DEFAULT 1,created TEXT NOT NULL,updated TEXT NOT NULL);
    CREATE TABLE notification_events(id TEXT PRIMARY KEY,source_key TEXT NOT NULL UNIQUE,kind TEXT NOT NULL,user_id TEXT NOT NULL,task_id TEXT,task_run_id TEXT,payload TEXT NOT NULL,created TEXT NOT NULL);
    CREATE TABLE notification_deliveries(id TEXT PRIMARY KEY,event_id TEXT NOT NULL REFERENCES notification_events(id),channel_id TEXT NOT NULL REFERENCES notification_channels(id),channel_revision INTEGER NOT NULL,status TEXT NOT NULL DEFAULT 'pending',attempts INTEGER NOT NULL DEFAULT 0,next_attempt INTEGER NOT NULL DEFAULT 0,last_error TEXT,delivered_at TEXT,created TEXT NOT NULL,updated TEXT NOT NULL,UNIQUE(event_id,channel_id));
    CREATE INDEX notification_deliveries_due ON notification_deliveries(status,next_attempt);
    CREATE INDEX notification_events_owner ON notification_events(user_id,created);
    PRAGMA user_version=4; COMMIT;`);
  if (version < 5) db.exec(`BEGIN IMMEDIATE;
    ALTER TABLE executions ADD COLUMN runtime TEXT NOT NULL DEFAULT 'legacy';
    ALTER TABLE executions ADD COLUMN runtime_version TEXT NOT NULL DEFAULT '1';
    ALTER TABLE tool_steps ADD COLUMN call_key TEXT;
    ALTER TABLE tool_steps ADD COLUMN call_hash TEXT;
    ALTER TABLE tool_steps ADD COLUMN response_encrypted TEXT;
    CREATE UNIQUE INDEX tool_steps_call_key ON tool_steps(run_id,call_key) WHERE call_key IS NOT NULL;
    PRAGMA user_version=5; COMMIT;`);
  if (version < 6) db.exec(`BEGIN IMMEDIATE;
    ALTER TABLE tasks ADD COLUMN target_binding TEXT;
    PRAGMA user_version=6; COMMIT;`);
  if (version < 7) db.exec(`BEGIN IMMEDIATE;
    CREATE TABLE IF NOT EXISTS agent_delegations(
      id TEXT PRIMARY KEY,run_id TEXT NOT NULL REFERENCES executions(id) ON DELETE CASCADE,
      user_id TEXT NOT NULL,parent_agent_run_id TEXT NOT NULL,agent_id TEXT,agent_name TEXT NOT NULL,
      depth INTEGER NOT NULL DEFAULT 1,status TEXT NOT NULL,node_id TEXT,
      task_encrypted TEXT NOT NULL,result_encrypted TEXT,error_code TEXT,
      created TEXT NOT NULL,updated TEXT NOT NULL,finished TEXT,
      model_calls INTEGER NOT NULL DEFAULT 0,tokens INTEGER NOT NULL DEFAULT 0,
      tool_steps INTEGER NOT NULL DEFAULT 0,source_count INTEGER NOT NULL DEFAULT 0
    );
    CREATE INDEX IF NOT EXISTS agent_delegations_run ON agent_delegations(run_id,created);
    PRAGMA user_version=7; COMMIT;`);
  const get = (sql, ...params) => db.prepare(sql).get(...params);
  const all = (sql, ...params) => db.prepare(sql).all(...params);
  const run = (sql, ...params) => db.prepare(sql).run(...params);
  let transactionDepth = 0;
  const transaction = fn => {
    db.exec('BEGIN IMMEDIATE');
    transactionDepth++;
    try { const result = fn(); db.exec('COMMIT'); return result; }
    catch (error) { db.exec('ROLLBACK'); throw error; }
    finally { transactionDepth--; }
  };
  const encrypt = value => {
    if (!value) return '';
    const iv = randomBytes(12);
    const cipher = createCipheriv('aes-256-gcm', key, iv);
    const data = Buffer.concat([cipher.update(value, 'utf8'), cipher.final()]);
    return [iv, cipher.getAuthTag(), data].map(b => b.toString('base64')).join('.');
  };
  const decrypt = value => {
    if (!value) return '';
    const [iv, tag, data] = value.split('.').map(b => Buffer.from(b, 'base64'));
    const decipher = createDecipheriv('aes-256-gcm', key, iv);
    decipher.setAuthTag(tag);
    return Buffer.concat([decipher.update(data), decipher.final()]).toString('utf8');
  };
  const audit = (user, action, target = '', detail = {}) => {
    if (!transactionDepth) return transaction(() => audit(user, action, target, detail));
    const created = now(); const safe = JSON.stringify(redact(detail)); const uid = user?.id || null;
    const previous = get('SELECT hash FROM audit ORDER BY seq DESC LIMIT 1')?.hash || '';
    const hash = createHash('sha256').update(JSON.stringify([previous, uid, action, target, safe, created])).digest('hex');
    return run('INSERT INTO audit(user_id,action,target,detail,created,previous_hash,hash) VALUES(?,?,?,?,?,?,?)', uid, action, target, safe, created, previous, hash);
  };
  const setting = key => { const row = get('SELECT value FROM settings WHERE key=?', key); return row ? JSON.parse(row.value) : null; };
  const setSetting = (key, value) => run('INSERT INTO settings VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value', key, JSON.stringify(value));
  const resource = row => row ? { ...JSON.parse(row.data), id: row.id, kind: row.kind, ownerId: row.owner_id, created: row.created, updated: row.updated } : null;
  return { db, dir, keyPath, get, all, run, transaction, encrypt, decrypt, audit, setting, setSetting, resource, close: () => db.close() };
}

export const id = () => randomUUID();
export const now = () => new Date().toISOString();
export function httpError(status, message) { return Object.assign(new Error(message), { status }); }
export function publicUser(user) { return { id: user.id, username: user.username, name: user.name, role: user.role, active: !!user.active }; }
export function canManage(user, resource) { return user.role === 'admin' || resource.ownerId === user.id || resource.managerIds?.includes(user.id); }
export function canRead(user, resource) { return canManage(user, resource) || resource.visibility === 'public' || resource.readerIds?.includes(user.id); }
export function getResource(store, user, resourceId, manage = false) {
  const item = store.resource(store.get('SELECT * FROM resources WHERE id=?', resourceId));
  if (!item || !(manage ? canManage(user, item) : canRead(user, item))) throw httpError(404, '资源不存在或没有访问权限');
  return item;
}
export function visibleResources(store, user) { return store.all('SELECT * FROM resources ORDER BY created DESC').map(store.resource).filter(r => canRead(user, r)); }
export function resourceView(store, user, item) {
  const { tokenEncrypted, ...safe } = item;
  return { ...safe, hasToken: !!tokenEncrypted, canManage: canManage(user, item), owner: store.get('SELECT name FROM users WHERE id=?', item.ownerId)?.name || '未知用户' };
}
