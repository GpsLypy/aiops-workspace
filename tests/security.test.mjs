import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, renameSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHmac, randomBytes } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { createApplication } from '../server/app.mjs';
import { openStore } from '../server/store.mjs';
import { listen } from './fixtures.mjs';
import { authorizeTool, toolPolicySchema, executableResource } from '../server/governance.mjs';
import { gatewayIdentity, outboundTarget, protectMessages, validateEnvironment } from '../server/security.mjs';

test('shared instructions require reviewed versions and edits/rollback invalidate publication', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'aiops-governance-')); const app = createApplication({ dataDir: dir, scheduler: false }); const http = await listen(app.app);
  let cookie = '';
  const call = async (path, method = 'GET', body) => {
    const response = await fetch(http.url + '/api' + path, { method, headers: { 'Content-Type': 'application/json', Cookie: cookie }, ...(body ? { body: JSON.stringify(body) } : {}) });
    return { status: response.status, data: await response.json(), cookie: response.headers.get('set-cookie')?.split(';')[0] };
  };
  try {
    cookie = (await call('/auth/setup', 'POST', { username: 'admin', password: 'admin-password-long' })).cookie; const adminCookie = cookie;
    await call('/users', 'POST', { username: 'member', password: 'member-password-long' });
    cookie = (await call('/auth/login', 'POST', { username: 'member', password: 'member-password-long' })).cookie; const memberCookie = cookie;
    let item = (await call('/resources', 'POST', { kind: 'skills', name: 'shared', body: 'unreviewed', visibility: 'public', publication: 'published' })).data;
    assert.equal(item.publication, 'draft'); assert.equal(executableResource(item), false);
    assert.equal((await call(`/resources/${item.id}/publish`, 'POST', { revision: 1 })).status, 403);
    cookie = adminCookie;
    assert.equal((await call(`/resources/${item.id}/publish`, 'POST', { revision: 999 })).status, 409);
    item = (await call(`/resources/${item.id}/publish`, 'POST', { revision: item.revision })).data;
    assert.equal(executableResource(item), true);
    cookie = memberCookie;
    item = (await call(`/resources/${item.id}`, 'PUT', { ...item, body: 'changed' })).data;
    assert.equal(item.publication, 'draft');
    assert.equal((await call(`/resources/${item.id}`, 'PUT', { ...item, revision: 1 })).status, 409);
    item = (await call(`/resources/${item.id}/rollback`, 'POST', { revision: 1 })).data;
    assert.equal(item.body, 'unreviewed'); assert.equal(item.publication, 'draft');
    assert.equal((await call(`/resources/${item.id}/versions`)).data.length, 4);
    app.store.audit(null, 'test', '', { password: 'NEVER_EXPORT', text: 'Bearer ABCDEFGHIJKL' });
    assert.ok(!app.store.get('SELECT detail FROM audit ORDER BY seq DESC LIMIT 1').detail.includes('NEVER_EXPORT'));
    assert.equal(app.store.get('PRAGMA user_version').user_version, 7);
  } finally { await http.close(); await app.close(); rmSync(dir, { recursive: true, force: true }); }
});

test('tool policies enforce identity, environment, bounded arguments and required write controls', () => {
  const policy = toolPolicySchema.parse({ risk: 'read', roles: ['member'], environments: ['production'], constraints: { namespace: ['billing'] } });
  const resource = { allowedTools: ['status'], toolPolicies: { status: policy } }; const user = { id: 'alice', role: 'member' };
  assert.equal(authorizeTool(user, resource, 'status', { namespace: 'billing' }, { environment: 'production' }).risk, 'read');
  assert.throws(() => authorizeTool(user, resource, 'status', { namespace: 'other' }, { environment: 'production' }), /超出/);
  assert.throws(() => authorizeTool(user, resource, 'status', { namespace: 'billing' }), /环境/);
  assert.throws(() => authorizeTool(user, { ...resource, toolPolicies: {} }, 'status', {}), /策略/);
  resource.toolPolicies.status = { ...policy, risk: 'write' };
  assert.throws(() => authorizeTool(user, resource, 'status', { namespace: 'billing' }, { environment: 'production' }), /幂等/);
});

test('missing key cannot silently replace the key of an existing database', () => {
  const dir = mkdtempSync(join(tmpdir(), 'aiops-key-'));
  try { openStore(dir).close(); renameSync(join(dir, 'master.key'), join(dir, 'saved.key')); assert.throws(() => openStore(dir), /Master key missing/); }
  finally { rmSync(dir, { recursive: true, force: true }); }
});

test('legacy schema migration preserves data, freezes unreviewed instructions and rejects future schemas', () => {
  const dir = mkdtempSync(join(tmpdir(), 'aiops-migration-')); writeFileSync(join(dir, 'master.key'), randomBytes(32));
  const old = new DatabaseSync(join(dir, 'aiops.sqlite'));
  old.exec(`
    CREATE TABLE users(id TEXT PRIMARY KEY,username TEXT,name TEXT,password TEXT,role TEXT,active INTEGER,created TEXT);
    CREATE TABLE auth_sessions(token TEXT PRIMARY KEY,user_id TEXT,expires INTEGER);
    CREATE TABLE resources(id TEXT PRIMARY KEY,kind TEXT,owner_id TEXT,data TEXT,created TEXT,updated TEXT);
    CREATE TABLE settings(key TEXT PRIMARY KEY,value TEXT);
    CREATE TABLE conversations(id TEXT PRIMARY KEY,user_id TEXT,title TEXT,agent_id TEXT,created TEXT,updated TEXT,busy_until INTEGER);
    CREATE TABLE messages(seq INTEGER PRIMARY KEY,conversation_id TEXT,role TEXT,content TEXT,metadata TEXT,created TEXT);
    CREATE TABLE tasks(id TEXT PRIMARY KEY,enabled INTEGER,next_run TEXT);
    CREATE TABLE task_runs(id TEXT PRIMARY KEY,task_id TEXT,started TEXT);
    CREATE TABLE audit(seq INTEGER PRIMARY KEY,user_id TEXT,action TEXT,target TEXT,detail TEXT,created TEXT);
    INSERT INTO users VALUES('owner','legacy','Legacy','hash','admin',1,'2020-01-01');
    INSERT INTO auth_sessions VALUES('token-hash','owner',9999999999999);
    INSERT INTO conversations VALUES('conversation','owner','preserved',NULL,'2020-01-01','2020-01-01',0);
    PRAGMA user_version=1;
  `);
  old.prepare('INSERT INTO resources VALUES(?,?,?,?,?,?)').run('skill', 'skills', 'owner', JSON.stringify({ name: 'legacy instruction', body: 'preserve me', visibility: 'public' }), '2020-01-01', '2020-01-01'); old.close();
  try {
    const migrated = openStore(dir);
    assert.equal(migrated.get('PRAGMA user_version').user_version, 7);
    assert.equal(migrated.get('SELECT title FROM conversations').title, 'preserved');
    assert.equal(migrated.get('SELECT token FROM auth_sessions').token, 'token-hash');
    assert.equal(migrated.resource(migrated.get('SELECT * FROM resources')).publication, 'draft');
    assert.equal(JSON.parse(migrated.get('SELECT data FROM resource_versions').data).body, 'preserve me');
    migrated.db.exec('PRAGMA user_version=999'); migrated.close();
    assert.throws(() => openStore(dir), /newer/);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('production configuration, metadata egress, redaction and signed enterprise identity fail closed', async () => {
  const previous = { ...process.env };
  try {
    await assert.rejects(outboundTarget('http://169.254.169.254/latest/meta-data'), /元数据/);
    process.env.OUTBOUND_ALLOWED_ORIGINS = 'https://approved.example';
    await assert.rejects(outboundTarget('https://unapproved.example'), /出口/);
    process.env.MODEL_DATA_POLICY = 'block';
    assert.throws(() => protectMessages([{ content: 'password=super-secret' }]), /阻止/);
    assert.throws(() => protectMessages([{ content: '{"password": "json-secret"}' }]), /阻止/);
    process.env.NODE_ENV = 'production'; delete process.env.APP_ORIGIN;
    assert.throws(validateEnvironment, /HTTPS/);
    process.env.AUTH_MODE = 'gateway'; process.env.APP_ORIGIN = 'https://aiops.example'; process.env.IDENTITY_GATEWAY_SECRET = 'long-identity-secret-12345678901234567890';
    const identity = Buffer.from(JSON.stringify({ username: 'alice', mfa: true, exp: Math.floor(Date.now() / 1000) + 60, aud: process.env.APP_ORIGIN })).toString('base64url');
    const signature = createHmac('sha256', process.env.IDENTITY_GATEWAY_SECRET).update(identity).digest('hex');
    assert.equal(gatewayIdentity({ get: name => name === 'x-aiops-identity' ? identity : signature }).username, 'alice');
    assert.throws(() => gatewayIdentity({ get: name => name === 'x-aiops-identity' ? identity : '0'.repeat(64) }), /签名/);
  } finally { for (const key of Object.keys(process.env)) if (!(key in previous)) delete process.env[key]; Object.assign(process.env, previous); }
});
