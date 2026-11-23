import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { inspectSkillPackage } from '../server/skill-package.mjs';
import { createApplication } from '../server/app.mjs';
import { listen } from './fixtures.mjs';
import { skillZip } from './skill-zip-fixture.mjs';

const pkg = entries => ({ filename: 'demo.zip', base64: skillZip(entries).toString('base64') });
test('ZIP Skill supports root/folder layouts, YAML metadata and bundled files', async () => {
  const result = await inspectSkillPackage(pkg());
  assert.equal(result.name, 'zip-demo'); assert.equal(result.documentVersion, '1.0'); assert.equal(result.files.length, 3);
  assert.match(result.body, /排障流程/);
  assert.equal((await inspectSkillPackage(pkg([['SKILL.md', '# Plain Skill']]))).name, 'demo');
});
test('ZIP Skill rejects malformed archives, ambiguous entrypoints, traversal and oversized expansion', async () => {
  for (const entries of [ [['readme.md', 'missing']], [['a/SKILL.md', 'a'], ['b/SKILL.md', 'b']], [['a/b/SKILL.md', 'deep']], [['SKILL.md', '']], [['SKILL.md', 'a'], ['../escape', 'bad']], [['SKILL.md', 'a'], ['SKILL.md', 'b']], [['SKILL.md', 'a'], ['big.txt', 'a'.repeat(2000001)]], [['SKILL.md', '---\nname: [bad\n---\nbody']], [['SKILL.md', 'a'.repeat(200001)]] ]) {
    await assert.rejects(inspectSkillPackage(pkg(entries)), error => error.status === 400);
  }
  await assert.rejects(inspectSkillPackage({ filename: 'x.md', base64: 'dGVzdA==' }));
  await assert.rejects(inspectSkillPackage({ filename: 'x.zip', base64: 'dGVzdA==' }));
  await assert.rejects(inspectSkillPackage({ filename: 'x.zip', base64: Buffer.alloc(600001).toString('base64') }));
  const corrupt = skillZip(); const central = corrupt.indexOf(Buffer.from([0x50, 0x4b, 0x01, 0x02])); corrupt.writeUInt32LE(0, central + 16);
  await assert.rejects(inspectSkillPackage({ filename: 'x.zip', base64: corrupt.toString('base64') }), /校验失败/);
  await assert.rejects(inspectSkillPackage(pkg([['SKILL.md', 'ok'], ...Array.from({ length: 200 }, (_, i) => [`files/${i}`, 'file'])])), /200/);
  await assert.rejects(inspectSkillPackage(pkg([['SKILL.md', 'ok'], ...Array.from({ length: 3 }, (_, i) => [`files/${i}`, 'a'.repeat(1800000)])])), /5 MB/);
});
test('ZIP upload validates on save, preserves original files and revision history under existing ACL', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'skill-zip-')); const app = createApplication({ dataDir: dir, scheduler: false }); const http = await listen(app.app); let cookie = '';
  const call = async (path, method = 'GET', data) => {
    const response = await fetch(http.url + '/api' + path, { method, headers: { 'Content-Type': 'application/json', Cookie: cookie }, ...(data ? { body: JSON.stringify(data) } : {}) });
    return { status: response.status, data: await response.json(), cookie: response.headers.get('set-cookie')?.split(';')[0] };
  };
  try {
    assert.equal((await call('/skills/inspect', 'POST', pkg())).status, 401);
    cookie = (await call('/auth/setup', 'POST', { username: 'admin', password: 'admin-password-long' })).cookie; const adminCookie = cookie;
    assert.equal((await call('/skills/inspect', 'POST', pkg())).data.files.length, 3);
    let item = (await call('/resources', 'POST', { kind: 'skills', name: 'zip-demo', skillPackage: pkg(), body: 'forged' })).data;
    assert.equal(item.publication, 'draft'); assert.match(item.body, /排障流程/); assert.deepEqual(item.skillPackage, pkg());
    const original = item;
    item = (await call(`/resources/${item.id}/publish`, 'POST', { revision: item.revision })).data;
    const bad = await call(`/resources/${item.id}`, 'PUT', { ...item, skillPackage: pkg([['README.md', 'bad']]) }); assert.equal(bad.status, 400);
    assert.equal((await call('/resources')).data[0].publication, 'published');
    item = (await call(`/resources/${item.id}`, 'PUT', { ...item, skillPackage: pkg([['SKILL.md', 'changed']]) })).data;
    assert.equal(item.body, 'changed'); assert.equal(item.publication, 'draft');
    item = (await call(`/resources/${item.id}/rollback`, 'POST', { revision: 1 })).data;
    assert.deepEqual(item.skillPackage, original.skillPackage); assert.equal(item.body, original.body);
    await call('/users', 'POST', { username: 'member', password: 'member-password-long' });
    cookie = (await call('/auth/login', 'POST', { username: 'member', password: 'member-password-long' })).cookie;
    assert.deepEqual((await call('/resources')).data, []);
    assert.ok([403, 404].includes((await call(`/resources/${item.id}`, 'PUT', item)).status));
    cookie = adminCookie; assert.deepEqual((await call('/resources')).data[0].skillPackage, original.skillPackage);
  } finally { await http.close(); await app.close(); rmSync(dir, { recursive: true, force: true }); }
});
