import { constants, lstatSync, readdirSync, openSync, closeSync, fstatSync, readFileSync, writeFileSync, renameSync, unlinkSync, existsSync } from 'node:fs';
import { dirname, resolve, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash, randomUUID } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { z } from 'zod';
import { admin } from './auth.mjs';
import { httpError } from './store.mjs';

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const limit = 512 * 1024;
const digest = body => createHash('sha256').update(body).digest('hex');
const queues = new Map();
const exec = promisify(execFile);
// Source deployments include the site catalog. Slim deployments may omit docs;
// keep the existing application bootable and expose an empty document catalog.
const { chapters } = await import('../docs/web/content.mjs').catch(error => {
  if (error.code !== 'ERR_MODULE_NOT_FOUND') throw error;
  return { chapters: [] };
});
const input = z.object({ path: z.string().max(300), content: z.string().refine(v => Buffer.byteLength(v) <= limit, '文档最多 512 KiB'), revision: z.string().regex(/^[a-f0-9]{64}$/) }).strict();
const query = z.object({ path: z.string().max(300) }).strict();
const sourceMaps = chapters.filter(chapter => chapter.file === 'codemap.md' || chapter.file.endsWith('/codemap.md')).map(chapter => chapter.file);
const skipped = new Set(['node_modules', 'site', '.venv', '__pycache__', 'dist']);

export async function rebuildDocumentation(root) {
  for (const args of [[], ['--check']]) await exec(process.execPath, [join(root, 'scripts/build-docs.mjs'), ...args], { cwd: root, timeout: 30000, maxBuffer: 256 * 1024 });
}

export function createDocuments({ root = projectRoot, rebuild = rebuildDocumentation } = {}) {
  root = resolve(root);
  // Check every component as well as the final file. Never follow symlinked directories.
  function safePath(path) {
    const allowed = sourceMaps.includes(path) || (/^(README\.md|(?:docs|deploy|integrations)\/.+\.md)$/u.test(path) && !path.endsWith('/codemap.md'));
    if (!allowed || /[\\\0]/.test(path) || path.split('/').some(p => !p || p === '..' || p === '.' || p.startsWith('.'))) throw httpError(404, '文档不存在或不在用户文档目录中');
    let current = root;
    for (const part of path.split('/')) {
      current = join(current, part);
      const stat = lstatSync(current);
      if (stat.isSymbolicLink()) throw httpError(404, '文档不存在或不在用户文档目录中');
    }
    return current;
  }
  function read(path) {
    const filename = safePath(path);
    const fd = openSync(filename, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    try {
      const stat = fstatSync(fd);
      if (!stat.isFile() || stat.size > limit) throw httpError(413, '仅支持不超过 512 KiB 的 Markdown 文档');
      const content = readFileSync(fd, 'utf8');
      if (Buffer.byteLength(content) > limit) throw httpError(413, '文档最多 512 KiB');
      const chapter = chapters.find(c => c.file === path);
      const group = chapter?.group || (path === 'README.md' ? '入门与使用' : path.startsWith('deploy/') || path.startsWith('integrations/') ? '部署与运维' : path.startsWith('docs/examples/') ? '教学附件' : '其他用户文档');
      return { path, title: /^#\s+(.+)$/m.exec(content)?.[1]?.trim() || path.split('/').at(-1), group, content, revision: digest(content), updatedAt: stat.mtime.toISOString(), size: Buffer.byteLength(content) };
    } finally { closeSync(fd); }
  }
  function paths() {
    const result = [];
    if (existsSync(join(root, 'README.md')) && !lstatSync(join(root, 'README.md')).isSymbolicLink()) result.push('README.md');
    function walk(path) {
      if (!existsSync(join(root, path)) || lstatSync(join(root, path)).isSymbolicLink()) return;
      for (const entry of readdirSync(join(root, path), { withFileTypes: true })) {
        if (entry.name.startsWith('.') || skipped.has(entry.name) || entry.isSymbolicLink()) continue;
        const next = `${path}/${entry.name}`;
        if (entry.isDirectory()) walk(next);
        else if (entry.isFile() && entry.name.endsWith('.md') && entry.name !== 'codemap.md') result.push(next);
      }
    }
    for (const dir of ['docs', 'deploy', 'integrations']) walk(dir);
    // docs/site/README describes maintaining the offline user website; index.html is generated.
    if (existsSync(join(root, 'docs/site/README.md'))) {
      try { safePath('docs/site/README.md'); result.push('docs/site/README.md'); } catch (error) { if (error.status !== 404) throw error; }
    }
    for (const path of sourceMaps) {
      if (!existsSync(join(root, path))) continue;
      try { safePath(path); result.push(path); } catch (error) { if (error.status !== 404) throw error; }
    }
    return result;
  }
  function get(path) {
    if (!paths().includes(path)) throw httpError(404, '文档不存在或不在用户文档目录中');
    return read(path);
  }
  function atomic(path, content, mode) {
    const filename = safePath(path);
    const temporary = join(dirname(filename), `.document-${randomUUID()}.tmp`);
    try {
      writeFileSync(temporary, content, { flag: 'wx', mode });
      // Re-check directory/file containment immediately before replacing the original.
      safePath(path);
      renameSync(temporary, filename);
    } finally { if (existsSync(temporary)) unlinkSync(temporary); }
  }
  async function save(data, beforeWrite) {
    const previous = queues.get(root) || Promise.resolve();
    const operation = previous.catch(() => {}).then(async () => {
      beforeWrite();
      const original = get(data.path);
      if (original.revision !== data.revision) throw httpError(409, '文档已被其他人修改。请先下载草稿，再重新加载最新文档后合并。');
      const mode = lstatSync(safePath(data.path)).mode & 0o777;
      const sitePath = join(root, 'docs/site/index.html');
      for (const path of ['docs', 'docs/site']) if (existsSync(join(root, path)) && lstatSync(join(root, path)).isSymbolicLink()) throw httpError(422, '离线文档目录不允许符号链接，请检查部署目录后重试。');
      if (existsSync(sitePath) && lstatSync(sitePath).isSymbolicLink()) throw httpError(422, '离线文档目录不可写，请检查部署目录后重试。');
      const oldSite = existsSync(sitePath) ? readFileSync(sitePath) : null;
      try {
        if (get(data.path).revision !== data.revision) throw httpError(409, '文档已变化，请下载草稿并重新加载。');
        atomic(data.path, data.content, mode);
        await rebuild(root);
      } catch (error) {
        if (error.status === 409) throw error;
        try {
          // An external editor may have intervened during the build: preserve its source.
          if (get(data.path).revision === digest(data.content)) atomic(data.path, original.content, mode);
          if (oldSite) writeFileSync(sitePath, oldSite);
          else if (existsSync(sitePath)) unlinkSync(sitePath);
        } catch { throw httpError(500, '保存失败且文档回退未完成。草稿仍在页面，请下载草稿并检查服务器文档目录。'); }
        throw httpError(422, '保存未完成：文档目录不可写或离线网站构建检查失败，本次修改已回退。请检查 Markdown 链接和部署目录后重试；可先下载草稿。');
      }
      return { document: get(data.path), siteRebuilt: true };
    });
    queues.set(root, operation);
    try { return await operation; } finally { if (queues.get(root) === operation) queues.delete(root); }
  }
  return { list: () => paths().flatMap(path => { try { return [read(path)]; } catch (error) { if (error.code === 'ENOENT' || error.status === 404) return []; throw error; } }), get, save };
}

export function documentRoutes(app, store, options) {
  const documents = createDocuments(options);
  app.get('/api/documents', (req, res) => {
    if (Object.keys(req.query).length) throw httpError(400, '文档列表不接受路径参数');
    res.json({ documents: documents.list(), canEdit: req.user.role === 'admin' });
  });
  app.get('/api/documents/content', (req, res) => {
    try { res.json(documents.get(query.parse(req.query).path)); }
    catch (error) { if (error.code === 'ENOENT') throw httpError(404, '文档已不存在，请刷新目录'); throw error; }
  });
  app.put('/api/documents/content', admin, async (req, res) => {
    const data = input.parse(req.body);
    const result = await documents.save(data, () => {
      const user = store.get('SELECT role,active FROM users WHERE id=?', req.user.id);
      if (!user?.active || user.role !== 'admin') throw httpError(403, '需要管理员权限');
    });
    store.audit(req.user, 'documents.save', data.path, { before: data.revision, after: result.document.revision });
    res.json(result);
  });
}
