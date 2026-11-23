import { crc32, deflateRawSync } from 'node:zlib';

export function skillZip(entries = [['demo/SKILL.md', '---\nname: zip-demo\ndescription: ZIP 示例\nmetadata:\n  version: "1.0"\n---\n# 排障流程'], ['demo/references/guide.md', '参考文档'], ['demo/scripts/check.sh', 'echo test']]) {
  const parts = []; const directory = []; let offset = 0;
  for (const [path, text] of entries) {
    const name = Buffer.from(path); const content = Buffer.from(text); const compressed = deflateRawSync(content);
    const local = Buffer.alloc(30); local.writeUInt32LE(0x04034b50); local.writeUInt16LE(20, 4); local.writeUInt16LE(0x800, 6); local.writeUInt16LE(8, 8); local.writeUInt32LE(crc32(content), 14); local.writeUInt32LE(compressed.length, 18); local.writeUInt32LE(content.length, 22); local.writeUInt16LE(name.length, 26);
    const central = Buffer.alloc(46); central.writeUInt32LE(0x02014b50); central.writeUInt16LE(20, 4); central.writeUInt16LE(20, 6); local.copy(central, 8, 6, 28); central.writeUInt32LE(offset, 42);
    parts.push(local, name, compressed); directory.push(central, name); offset += local.length + name.length + compressed.length;
  }
  const index = Buffer.concat(directory); const end = Buffer.alloc(22); end.writeUInt32LE(0x06054b50); end.writeUInt16LE(entries.length, 8); end.writeUInt16LE(entries.length, 10); end.writeUInt32LE(index.length, 12); end.writeUInt32LE(offset, 16);
  return Buffer.concat([...parts, index, end]);
}
