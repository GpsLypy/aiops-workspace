import { lstatSync, readFileSync } from 'node:fs';
import { createDecipheriv } from 'node:crypto';
import { join } from 'node:path';

export function poCDtsDecrypt(dataDir) {
  const key = readFileSync(join(dataDir, 'master.key'));
  if (key.length !== 32) throw Error('Invalid PoC master key');
  return value => {
    const [iv, tag, bytes] = value.split('.').map(item => Buffer.from(item, 'base64'));
    const cipher = createDecipheriv('aes-256-gcm', key, iv); cipher.setAuthTag(tag);
    return Buffer.concat([cipher.update(bytes), cipher.final()]).toString('utf8');
  };
}

export async function readPoCDtsConfig(path) {
  const stat = lstatSync(path);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.mode & 0o077 || stat.size > 65536) throw Error('PoC DTS config must be an ordinary private file (0600)');
  const input = JSON.parse(readFileSync(path, 'utf8'));
  if (Object.keys(input).sort().join(',') !== 'endpoint,statusUrl,token' || input.endpoint !== 'http://127.0.0.1:43130/mcp') throw Error('PoC DTS requires the fixed loopback SSH tunnel endpoint');
  const { loadConfig } = await import('../../integrations/dts-mcp/adapter.mjs');
  return loadConfig({ DTS_STATUS_URL: input.statusUrl, DTS_ALLOW_HTTP: 'true', DTS_MCP_PORT: '43130', DTS_MCP_TOKEN: input.token,
    DTS_BUSINESS_DOMAIN: 'general', DTS_AREA_NAME: 'cn_east', DTS_JOB_SCOPE: 'region', DTS_ALLOWED_JOB_IDS: '' });
}

export function validatePoCDtsResources(db, config) {
  const rows = db.prepare('SELECT id,kind,owner_id,data FROM resources').all();
  if (rows.length === 0) return;
  const names = { knowledge: 'DTS cn_east 状态说明', skills: 'DTS cn_east 只读查询', mcp: 'DTS cn_east MCP', agents: 'DTS cn_east 运维' };
  if (rows.length !== 4 || rows.map(r => r.kind).sort().join(',') !== Object.keys(names).sort().join(',') || new Set(rows.map(r => r.owner_id)).size !== 1) throw Error('DTS PoC requires exactly four private DTS resources');
  const ids = Object.fromEntries(rows.map(r => [r.kind, r.id]));
  const owner = db.prepare("SELECT role,active,username FROM users WHERE id=?").get(rows[0].owner_id);
  if (owner?.role !== 'admin' || owner.active !== 1 || owner.username !== 'poc-admin') throw Error('DTS PoC requires the existing test administrator');
  const equal = (a, b) => JSON.stringify(a) === JSON.stringify(b);
  for (const row of rows) {
    const value = JSON.parse(row.data);
    if (value.name !== names[row.kind] || value.visibility !== 'private' || !equal(value.readerIds, []) || !equal(value.managerIds, []) ||
      value.status !== '已启用' || value.environment !== 'production') throw Error('DTS PoC resource isolation mismatch');
    if (['skills', 'agents'].includes(row.kind) && value.publication !== 'published') throw Error('DTS PoC instructions must be published');
    if (row.kind === 'agents' && (!equal(value.knowledgeIds, [ids.knowledge]) || !equal(value.skillIds, [ids.skills]) || !equal(value.mcpIds, [ids.mcp]))) throw Error('DTS PoC Agent bindings mismatch');
    if (row.kind === 'mcp') {
      const p = value.toolPolicies?.dts_get_job_status;
      if (value.endpoint !== `http://127.0.0.1:${config.port}/mcp` || !equal(value.allowedTools, ['dts_get_job_status']) ||
        Object.keys(value.toolPolicies || {}).length !== 1 || p?.risk !== 'read' || !equal(p.roles, ['admin']) || !equal(p.userIds, [row.owner_id]) ||
        !equal(p.environments, ['production']) || p.automatic !== false || p.maxItems !== 1 ||
        !equal(p.requiredTargetFields, ['jobid', 'business_domain', 'area_name']) ||
        Object.keys(p.constraints || {}).sort().join(',') !== 'area_name,business_domain' ||
        !equal(p.constraints.business_domain, ['general']) || !equal(p.constraints.area_name, ['cn_east'])) throw Error('DTS PoC read-only scope mismatch');
    }
  }
}
