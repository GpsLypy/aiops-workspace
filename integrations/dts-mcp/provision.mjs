import { readFileSync, existsSync, lstatSync } from 'node:fs';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { isDeepStrictEqual } from 'node:util';
import { TOOL } from './adapter.mjs';

const regionConstraints = config => ({ business_domain: [config.businessDomain], area_name: [config.areaName] });
const constraintsFor = config => ({ ...(config.jobScope === 'region' ? {} : { jobid: config.allowedJobIds }), ...regionConstraints(config) });
const targetFields = ['jobid', 'business_domain', 'area_name'];

// Explicit local filesystem administration; no login/session or model configuration is changed.
export async function provisionDts(config, { root, ownerName, dataDir, skillPackagePath }) {
  if (!ownerName) throw new Error('provision 必须用 --owner 指定现有管理员账号');
  const { openStore, id, now, publicUser } = await import('../../server/store.mjs');
  const { revisionFields, saveRevision } = await import('../../server/governance.mjs');
  if (!existsSync(join(dataDir, 'aiops.sqlite'))) throw new Error('目标工作空间数据库不存在');
  const store = openStore(dataDir);
  try {
    const owner = store.get('SELECT id,username,name,role,active FROM users WHERE username=? AND active=1 AND role=?', ownerName, 'admin');
    if (!owner) throw new Error('指定的现有管理员不存在或未启用');
    const user = publicUser(owner);
    const names = ['DTS cn_east 状态说明', 'DTS cn_east 只读查询', 'DTS cn_east MCP', 'DTS cn_east 运维'];
    const existing = store.all('SELECT id,data FROM resources WHERE owner_id=?', user.id).filter(r => names.includes(JSON.parse(r.data).name));
    if (existing.length) {
      if (existing.length !== 4) throw new Error('存在部分同名 DTS 资源，请在页面核对，未覆盖任何资源');
      const saved = JSON.parse(existing.find(r => JSON.parse(r.data).name === names[2]).data);
      if (saved.endpoint !== `http://127.0.0.1:${config.port}/mcp` || store.decrypt(saved.tokenEncrypted) !== config.token || !isDeepStrictEqual(saved.toolPolicies?.[TOOL]?.constraints, constraintsFor(config))) throw new Error('已有 DTS 资源与本机配置不一致，请在页面核对，未覆盖配置');
      if (!isDeepStrictEqual(saved.toolPolicies?.[TOOL]?.requiredTargetFields, targetFields)) throw new Error('已有 DTS 资源尚未启用目标绑定，请核对后运行 sync-policy；provision 不覆盖现有策略');
      return { action: 'already_provisioned', resources: existing.map(r => ({ id: r.id, name: JSON.parse(r.data).name })) };
    }
    let archive;
    if (skillPackagePath) {
      const stat = lstatSync(skillPackagePath);
      if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 600000) throw new Error('DTS Skill 预打包文件必须为有界普通文件');
      archive = readFileSync(skillPackagePath);
    } else {
      const zipped = spawnSync('/usr/bin/zip', ['-q', '-r', '-', 'dts-status'], { cwd: join(root, 'integrations/dts-mcp'), maxBuffer: 600000 });
      if (zipped.status !== 0) throw new Error('DTS Skill 打包失败');
      archive = zipped.stdout;
    }
    const skillPackage = { filename: 'dts-status-readonly.zip', base64: archive.toString('base64') };
    const { inspectSkillPackage } = await import('../../server/skill-package.mjs');
    const inspected = await inspectSkillPackage(skillPackage);
    const created = [];
    store.transaction(() => {
      function create(kind, name, fields = {}) {
        const rid = id(); const time = now();
        const data = revisionFields(user, {
          kind, name, description: 'DTS general/cn_east 只读任务状态接入', domain: 'dts', service: 'dts-cn-east', environment: 'production',
          body: '', status: '已启用', visibility: 'private', readerIds: [], managerIds: [], endpoint: '',
          allowedTools: [], toolPolicies: {}, skillIds: [], knowledgeIds: [], mcpIds: [], documentVersion: '1.0.0', expiresAt: null, sourceUrl: '',
          ...fields,
        });
        store.run('INSERT INTO resources VALUES(?,?,?,?,?,?)', rid, kind, user.id, JSON.stringify(data), time, time);
        saveRevision(store, { ...data, id: rid, ownerId: user.id }, user, 'create');
        store.audit(user, 'resource.create', rid, { kind, source: 'dts-local-provision' });
        created.push({ id: rid, name, kind }); return rid;
      }
      const knowledgeId = create('knowledge', names[0], { body: readFileSync(join(root, 'integrations/dts-mcp/knowledge.md'), 'utf8') });
      const skillId = create('skills', names[1], { body: inspected.body, skillPackage, documentVersion: inspected.documentVersion });
      const mcpId = create('mcp', names[2], {
        endpoint: `http://127.0.0.1:${config.port}/mcp`, tokenEncrypted: store.encrypt(config.token), allowedTools: [TOOL],
        toolPolicies: { [TOOL]: { risk: 'read', roles: ['admin'], userIds: [user.id], environments: ['production'], constraints: constraintsFor(config), requiredTargetFields: targetFields, maxItems: 1, automatic: false, recovery: '' } },
      });
      create('agents', names[3], { body: '负责 DTS general/cn_east 获准任务的只读状态查询。优先按绑定 Skill 调用 dts_get_job_status 获取当前状态，参考绑定知识解释字段。必须报告任务 ID、上报时间、新鲜度及缺失证据，不猜测状态或执行写操作。', knowledgeIds: [knowledgeId], skillIds: [skillId], mcpIds: [mcpId] });
    });
    return { action: 'provisioned', resources: created };
  } finally { store.close(); }
}

// Sync the task-ID constraint and the fixed DTS target fields. Endpoint, token,
// region/domain and unrelated policies remain unchanged.
export async function syncDtsPolicy(config, { ownerName, dataDir }) {
  if (!ownerName) throw new Error('sync-policy 必须用 --owner 指定现有管理员账号');
  const { openStore, now, publicUser } = await import('../../server/store.mjs');
  const { revisionFields, saveRevision } = await import('../../server/governance.mjs');
  if (!existsSync(join(dataDir, 'aiops.sqlite'))) throw new Error('目标工作空间数据库不存在');
  const store = openStore(dataDir);
  try {
    return store.transaction(() => {
      const owner = store.get('SELECT id,username,name,role,active FROM users WHERE username=? AND active=1 AND role=?', ownerName, 'admin');
      if (!owner) throw new Error('指定的现有管理员不存在或未启用');
      const user = publicUser(owner);
      const matches = store.all('SELECT * FROM resources WHERE owner_id=? AND kind=?', user.id, 'mcp').map(store.resource).filter(r => r.name === 'DTS cn_east MCP');
      if (matches.length !== 1) throw new Error('必须存在唯一的 DTS cn_east MCP 资源，请先核对或 provision');
      const item = matches[0]; const policy = item.toolPolicies?.[TOOL];
      if (item.endpoint !== `http://127.0.0.1:${config.port}/mcp` || store.decrypt(item.tokenEncrypted) !== config.token || !item.allowedTools?.includes(TOOL) || policy?.risk !== 'read') throw new Error('已有 DTS 连接或只读策略与本机配置不一致，未覆盖配置');
      for (const [field, values] of Object.entries(regionConstraints(config))) {
        if (!isDeepStrictEqual(policy.constraints?.[field], values)) throw new Error('已有 DTS 业务域或区域与本机配置不一致，未扩大区域');
      }
      if (policy.requiredTargetFields?.length && !isDeepStrictEqual(policy.requiredTargetFields, targetFields)) throw new Error('已有 DTS 目标绑定字段与工具契约不一致，未覆盖配置');
      const constraints = { ...policy.constraints };
      if (config.jobScope === 'region') delete constraints.jobid;
      else constraints.jobid = [...config.allowedJobIds];
      const result = { resourceId: item.id, jobScope: config.jobScope, constraints, requiredTargetFields: targetFields };
      if (isDeepStrictEqual(constraints, policy.constraints) && isDeepStrictEqual(policy.requiredTargetFields, targetFields)) return { action: 'already_synced', revision: item.revision, ...result };
      const next = revisionFields(user, { ...item, toolPolicies: { ...item.toolPolicies, [TOOL]: { ...policy, constraints, requiredTargetFields: targetFields } } }, item);
      store.run('UPDATE resources SET data=?,updated=? WHERE id=?', JSON.stringify(next), now(), item.id);
      saveRevision(store, next, user, 'update');
      store.audit(user, 'resource.update', item.id, { kind: 'mcp', source: 'dts-local-sync-policy', jobScope: config.jobScope, constraints, requiredTargetFields: targetFields, revision: next.revision });
      return { action: 'policy_synced', revision: next.revision, ...result };
    });
  } finally { store.close(); }
}
