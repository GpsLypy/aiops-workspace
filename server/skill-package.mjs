import yauzl from 'yauzl';
import { crc32 } from 'node:zlib';
import { parseDocument } from 'yaml';
import { httpError } from './store.mjs';

export async function inspectSkillPackage(pkg) {
  if (!pkg || !/\.zip$/i.test(pkg.filename || '') || typeof pkg.base64 !== 'string' || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(pkg.base64)) throw httpError(400, '请选择有效的 ZIP 技能包');
  const buffer = Buffer.from(pkg.base64, 'base64');
  if (!buffer.length || buffer.length > 600000) throw httpError(400, 'ZIP 包不能超过 600 KB');
  try {
    const files = await new Promise((resolve, reject) => {
      yauzl.fromBuffer(buffer, { lazyEntries: true, strictFileNames: true }, (error, zip) => {
        if (error) return reject(error);
        const files = []; const paths = new Set(); let total = 0; let count = 0;
        const fail = error => { zip.close(); reject(error); };
        zip.on('error', fail);
        zip.on('end', () => resolve(files));
        zip.on('entry', entry => {
          const path = entry.fileName;
          if (++count > 200 || paths.has(path) || path.split('/').some(p => p === '.' || p === '..') || /[\x00-\x1f]/.test(path) || (entry.externalFileAttributes >>> 16 & 0xf000) === 0xa000 || entry.generalPurposeBitFlag & 1) return fail(new Error('不支持重复路径、链接、加密文件或超过 200 个条目的 ZIP'));
          paths.add(path);
          if (path.endsWith('/')) return zip.readEntry();
          if (entry.uncompressedSize > 2000000 || total + entry.uncompressedSize > 5000000) return fail(new Error('解压后单文件不能超过 2 MB，总大小不能超过 5 MB'));
          zip.openReadStream(entry, (error, stream) => {
            if (error) return fail(error);
            const chunks = []; let size = 0; let checksum = 0;
            stream.on('error', fail);
            stream.on('data', chunk => {
              size += chunk.length; total += chunk.length;
              checksum = crc32(chunk, checksum);
              if (size > 2000000 || total > 5000000) { stream.destroy(); return fail(new Error('ZIP 解压内容超过大小限制')); }
              if (/(^|\/)SKILL\.md$/.test(path)) chunks.push(chunk);
            });
            stream.on('end', () => {
              if (checksum !== entry.crc32) return fail(new Error('ZIP 文件校验失败，内容已损坏'));
              files.push({ path, size, ...(chunks.length ? { content: Buffer.concat(chunks) } : {}) }); zip.readEntry();
            });
          });
        });
        zip.readEntry();
      });
    });
    const meaningful = files.filter(f => !f.path.startsWith('__MACOSX/') && !/(^|\/)\.DS_Store$/.test(f.path));
    const entries = meaningful.filter(f => /(^|\/)SKILL\.md$/.test(f.path));
    if (entries.length !== 1 || entries[0].path.split('/').length > 2) throw new Error('ZIP 根目录或单层文件夹内必须有且仅有一个 SKILL.md');
    const entry = entries[0]; const prefix = entry.path.slice(0, -'SKILL.md'.length);
    if (prefix && meaningful.some(f => !f.path.startsWith(prefix))) throw new Error('所有技能文件必须位于同一个 Skill 文件夹内');
    if (!entry.content || entry.size > 200000) throw new Error('SKILL.md 不能为空或超过 200 KB');
    const body = new TextDecoder('utf-8', { fatal: true }).decode(entry.content);
    if (!body.trim()) throw new Error('SKILL.md 不能为空');
    let metadata = {};
    if (/^---\r?\n/.test(body)) {
      const match = body.match(/^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/);
      if (!match) throw new Error('SKILL.md front matter 缺少结束分隔符');
      const doc = parseDocument(match[1]);
      if (doc.errors.length) throw new Error('SKILL.md front matter YAML 无效');
      metadata = doc.toJS({ maxAliasCount: 20 });
      if (!metadata || typeof metadata !== 'object' || Array.isArray(metadata)) throw new Error('SKILL.md front matter 必须是字段对象');
    }
    const name = metadata.name ?? (prefix ? prefix.slice(0, -1) : pkg.filename.replace(/\.zip$/i, ''));
    const description = metadata.description ?? '';
    const version = metadata.version ?? metadata.metadata?.version ?? '';
    if (typeof name !== 'string' || !name.trim() || name.length > 100 || typeof description !== 'string' || description.length > 5000 || !['string', 'number'].includes(typeof version) || String(version).length > 100) throw new Error('Skill 名称、描述或版本格式无效');
    return { name: name.trim(), description, documentVersion: String(version), body, files: meaningful.map(({ path, size }) => ({ path, size })) };
  } catch (error) { throw httpError(400, `ZIP 技能包无效：${error.message}`); }
}
