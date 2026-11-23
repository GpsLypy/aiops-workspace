import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, symlinkSync, unlinkSync, cpSync, existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { createDocuments, rebuildDocumentation } from '../server/documents.mjs';
import { createApplication } from '../server/app.mjs';
import { listen } from './fixtures.mjs';

function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'aiops-documents-'));
  for (const path of ['docs/site', 'docs/examples', 'deploy/sample', 'integrations/sample', 'private']) mkdirSync(join(root, path), { recursive: true });
  for (const [path, content] of Object.entries({ 'README.md': '# 项目说明', 'docs/README.md': '# 使用指南\n\n原始内容', 'docs/getting-started.md': '# 从零开始\n\n[指南](README.md)', 'docs/site/README.md': '# 官网维护', 'docs/examples/notes.md': '# 教学附件', 'deploy/sample/README.md': '# 部署文档', 'integrations/sample/README.md': '# 集成文档', 'docs/site/index.html': 'old-site', 'private/secret.md': 'PRIVATE_SECRET', 'docs/codemap.md': '# 开发地图' })) writeFileSync(join(root, path), content);
  return root;
}
async function harness(rebuild = async () => {}) {
  const root = fixture();
  const application = createApplication({ dataDir: join(root, 'data'), scheduler: false, documents: { root, rebuild } });
  const http = await listen(application.app);
  const request = async (path, cookie, body, method = body ? 'PUT' : 'GET', origin) => {
    const response = await fetch(http.url + '/api' + path, { method, headers: { 'Content-Type': 'application/json', ...(cookie ? { Cookie: cookie } : {}), ...(origin ? { Origin: origin } : {}) }, ...(body ? { body: JSON.stringify(body) } : {}) });
    return { status: response.status, data: await response.json(), cookie: response.headers.get('set-cookie')?.split(';')[0] };
  };
  const admin = (await request('/auth/setup', null, { username: 'admin', password: 'document-test-password' }, 'POST')).cookie;
  await request('/users', admin, { username: 'member', password: 'document-test-password', role: 'member' }, 'POST');
  const member = (await request('/auth/login', null, { username: 'member', password: 'document-test-password' }, 'POST')).cookie;
  return { root, application, request, admin, member, close: async () => { await http.close(); await application.close(); rmSync(root, { recursive: true, force: true }); } };
}

test('documents: authenticated catalog covers user guides, integration/deployment and teaching materials; members cannot save', async () => {
  let builds = 0; const h = await harness(async () => { builds++; });
  try {
    assert.equal((await h.request('/documents')).status, 401);
    const catalog = await h.request('/documents', h.member);
    assert.equal(catalog.status, 200); assert.equal(catalog.data.canEdit, false);
    assert.equal(catalog.data.documents.length, 7);
    assert.doesNotMatch(JSON.stringify(catalog.data), /PRIVATE_SECRET|codemap/);
    const document = (await h.request('/documents/content?path=docs%2FREADME.md', h.member)).data;
    assert.equal(document.title, '使用指南'); assert.equal(document.content, '# 使用指南\n\n原始内容');
    assert.equal((await h.request('/documents/content', h.member, { path: document.path, content: 'modified', revision: document.revision })).status, 403);
    assert.equal(builds, 0);
    assert.equal((await h.request('/documents/content', h.admin, { path: document.path, content: 'modified', revision: document.revision }, 'PUT', 'https://foreign.example')).status, 403);
  } finally { await h.close(); }
});

test('documents: blocks traversal, unknown fields, secrets, symlink files/directories and oversized Markdown', async () => {
  const h = await harness();
  try {
    symlinkSync(join(h.root, 'private/secret.md'), join(h.root, 'docs/linked.md'));
    symlinkSync(join(h.root, 'private'), join(h.root, 'docs/linked-dir'));
    for (const path of ['../README.md', '/etc/passwd', 'docs/../private/secret.md', 'private/secret.md', 'docs/linked.md', 'docs/linked-dir/secret.md', 'docs/codemap.md', 'docs/site/index.html']) assert.equal((await h.request('/documents/content?path=' + encodeURIComponent(path), h.admin)).status, 404, path);
    assert.equal((await h.request('/documents?path=private', h.admin)).status, 400);
    assert.equal((await h.request('/documents/content?path=docs%2FREADME.md&other=1', h.admin)).status, 400);
    const document = (await h.request('/documents/content?path=docs%2FREADME.md', h.admin)).data;
    assert.equal((await h.request('/documents/content', h.admin, { path: document.path, content: '文'.repeat(180000), revision: document.revision })).status, 400);
    assert.equal((await h.request('/documents/content', h.admin, { path: document.path, content: 'hello', revision: document.revision, root: '/etc' })).status, 400);
    assert.doesNotMatch(JSON.stringify((await h.request('/documents', h.admin)).data), /PRIVATE_SECRET|linked/);
  } finally { await h.close(); }
});

test('documents: saves original file, rebuilds site, persists on application restart and audits only hashes', async () => {
  const h = await harness(async root => writeFileSync(join(root, 'docs/site/index.html'), 'rebuilt-site'));
  try {
    const document = (await h.request('/documents/content?path=docs%2FREADME.md', h.admin)).data;
    const saved = await h.request('/documents/content', h.admin, { path: document.path, content: '# 新指南\n\n保存后的正文', revision: document.revision });
    assert.equal(saved.status, 200); assert.equal(saved.data.siteRebuilt, true);
    assert.equal(readFileSync(join(h.root, document.path), 'utf8'), saved.data.document.content);
    assert.equal(readFileSync(join(h.root, 'docs/site/index.html'), 'utf8'), 'rebuilt-site');
    const reread = await h.request('/documents/content?path=docs%2FREADME.md', h.admin);
    assert.equal(reread.data.revision, saved.data.document.revision);
    assert.equal(createDocuments({ root: h.root }).get(document.path).content, saved.data.document.content);
    const audit = h.application.store.get("SELECT * FROM audit WHERE action='documents.save'");
    assert.ok(audit); assert.doesNotMatch(JSON.stringify(audit), /保存后的正文/);
  } finally { await h.close(); }
});

test('documents: simultaneous saves from two editors serialize and stale revision cannot overwrite the winner', async () => {
  let entered, release; const barrier = new Promise(r => { release = r; }); const ready = new Promise(r => { entered = r; });
  const h = await harness(async () => { entered(); await barrier; });
  try {
    const doc = (await h.request('/documents/content?path=docs%2FREADME.md', h.admin)).data;
    const first = h.request('/documents/content', h.admin, { path: doc.path, content: 'first', revision: doc.revision });
    await ready;
    const second = h.request('/documents/content', h.admin, { path: doc.path, content: 'second', revision: doc.revision });
    release();
    assert.equal((await first).status, 200); assert.equal((await second).status, 409);
    assert.equal(readFileSync(join(h.root, doc.path), 'utf8'), 'first');
  } finally { release(); await h.close(); }
});

test('documents: build failure rolls source and generated site back, releases queue and retains current revision', async () => {
  let fail = true;
  const h = await harness(async root => { writeFileSync(join(root, 'docs/site/index.html'), 'partial-site'); if (fail) throw new Error('PRIVATE_BUILD_LOG'); });
  try {
    const doc = (await h.request('/documents/content?path=docs%2FREADME.md', h.admin)).data;
    const result = await h.request('/documents/content', h.admin, { path: doc.path, content: 'broken', revision: doc.revision });
    assert.equal(result.status, 422); assert.doesNotMatch(JSON.stringify(result.data), /PRIVATE_BUILD_LOG/);
    assert.equal(readFileSync(join(h.root, doc.path), 'utf8'), doc.content);
    assert.equal(readFileSync(join(h.root, 'docs/site/index.html'), 'utf8'), 'old-site');
    fail = false;
    assert.equal((await h.request('/documents/content', h.admin, { path: doc.path, content: 'fixed', revision: doc.revision })).status, 200);
  } finally { await h.close(); }
});

test('documents: rechecks write authorization after waiting for another save', async () => {
  let release; const barrier = new Promise(r => { release = r; });
  let started; const entered = new Promise(r => { started = r; });
  const root = fixture();
  const docs = createDocuments({ root, rebuild: async () => { started(); await barrier; } });
  try {
    const doc = docs.get('docs/README.md');
    const first = docs.save({ path: doc.path, content: 'first', revision: doc.revision }, () => {});
    await entered;
    let authorized = true;
    const second = docs.save({ path: 'docs/getting-started.md', content: 'second', revision: docs.get('docs/getting-started.md').revision }, () => { if (!authorized) throw Object.assign(new Error('需要管理员权限'), { status: 403 }); });
    authorized = false;
    const rejected = assert.rejects(second, error => error.status === 403);
    release(); await first;
    await rejected;
    assert.notEqual(docs.get('docs/getting-started.md').content, 'second');
  } finally { release(); rmSync(root, { recursive: true, force: true }); }
});

test('documents: real repository catalog includes every supported user document and actual site rebuild validates and rolls back bad links', async () => {
  const root = mkdtempSync(join(tmpdir(), 'aiops-documents-real-'));
  try {
    for (const path of ['docs', 'src', 'server', 'scripts', 'tests', 'integrations', 'deploy', 'agent-worker', 'openspec', 'README.md', 'LICENSE', 'CONTRIBUTING.md', 'SECURITY.md', 'OPEN_SOURCE.md', 'codemap.md', 'agent.md', 'AGENTS.md', 'Dockerfile', 'compose.yaml', 'package.json', '.env.example', '.github']) {
      if (existsSync(resolve(path))) cpSync(resolve(path), join(root, path), { recursive: true, filter: source => !source.split('/').some(part => ['.venv', '__pycache__', '.data', 'node_modules', 'test-results'].includes(part)) });
    }
    symlinkSync(resolve('node_modules'), join(root, 'node_modules'));
    const docs = createDocuments({ root }); const catalog = docs.list();
    assert.ok(catalog.length >= 38);
    for (const path of ['docs/repository-guide.md', 'codemap.md', 'src/codemap.md', 'server/codemap.md', 'agent-worker/codemap.md']) assert.ok(catalog.some(doc => doc.path === path), path);
    assert.equal(docs.get('src/codemap.md').group, '代码库与开发'); assert.ok(catalog.some(doc => doc.path === 'integrations/dts-mcp/HANDOFF.md'));
    const doc = docs.get('docs/getting-started.md');
    const changed = doc.content + '\n\n文档中心真实保存验收标记。\n';
    const result = await docs.save({ path: doc.path, content: changed, revision: doc.revision }, () => {});
    assert.ok(result.siteRebuilt); assert.match(readFileSync(join(root, 'docs/site/index.html'), 'utf8'), /文档中心真实保存验收标记/);
    await rebuildDocumentation(root);
    const beforeSite = readFileSync(join(root, 'docs/site/index.html'), 'utf8');
    await assert.rejects(docs.save({ path: doc.path, content: changed + '\n[坏链接](not-a-real-document.md)\n', revision: result.document.revision }, () => {}), error => error.status === 422);
    assert.equal(docs.get(doc.path).content, changed);
    assert.equal(readFileSync(join(root, 'docs/site/index.html'), 'utf8'), beforeSite);
  } finally { rmSync(root, { recursive: true, force: true }); }
});


test('documents: registered source maps use containment and exclude arbitrary source files', () => {
  const root = fixture();
  try {
    mkdirSync(join(root, 'src'));
    writeFileSync(join(root, 'src/codemap.md'), '# Frontend map');
    writeFileSync(join(root, 'src/private.md'), 'not public');
    const docs = createDocuments({ root, rebuild: async () => {} });
    assert.equal(docs.get('src/codemap.md').group, '代码库与开发');
    assert.throws(() => docs.get('src/private.md'), error => error.status === 404);
    unlinkSync(join(root, 'src/codemap.md'));
    symlinkSync(join(root, 'private/secret.md'), join(root, 'src/codemap.md'));
    assert.ok(!docs.list().some(doc => doc.path === 'src/codemap.md'));
    assert.throws(() => docs.get('src/codemap.md'), error => error.status === 404);
  } finally { rmSync(root, { recursive: true, force: true }); }
});
