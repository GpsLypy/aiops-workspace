import { useEffect, useState, type FormEvent } from 'react';
import { Info, Plus, Save, Upload } from 'lucide-react';
import { api, post, put, errorText, type Resource, type Tool, type User } from '../api';
import type { Page } from '../data';
import { Badge, Button, Markdown, Modal } from './ui';

export const createLabels: Partial<Record<Page, string>> = { knowledge: '新建知识库', skills: '上传 Skill', mcp: '添加服务', agents: '创建子领域' };
type Props = { kind: Page; resource?: Resource; resources: Resource[]; user: User; close: () => void; saved: (r: Resource) => void };
export default function ResourceEditor({ kind, resource, resources, user, close, saved }: Props) {
  const [body, setBody] = useState(resource?.body || '');
  const [name, setName] = useState(resource?.name || '');
  const [description, setDescription] = useState(resource?.description || '');
  const [skillPackage, setSkillPackage] = useState(resource?.skillPackage);
  const [packageFiles, setPackageFiles] = useState<{ path: string; size: number }[]>([]);
  const [packageVersion, setPackageVersion] = useState(resource?.documentVersion || '');
  const [tools, setTools] = useState<Tool[]>([]);
  const [allowed, setAllowed] = useState(resource?.allowedTools || []);
  const [error, setError] = useState(''); const [busy, setBusy] = useState(false);
  const [directory, setDirectory] = useState<User[]>([]);
  const [policies, setPolicies] = useState(JSON.stringify(resource?.toolPolicies || {}, null, 2));
  const [versions, setVersions] = useState<{ revision: number; action: string; created: string }[]>([]);
  const writable = !resource || resource.canManage && (kind !== 'mcp' || user.role === 'admin');
  useEffect(() => { api<User[]>('/users/directory').then(setDirectory).catch(e => setError(errorText(e))); }, []);
  useEffect(() => { if (resource?.canManage) api<typeof versions>(`/resources/${resource.id}/versions`).then(setVersions).catch(e => setError(errorText(e))); }, [resource?.id]);
  const discover = async () => {
    if (!resource) return;
    setBusy(true); setError('');
    try { setTools(await post<Tool[]>(`/mcp/${resource.id}/discover`)); } catch (e) { setError(errorText(e)); } finally { setBusy(false); }
  };
  const submit = async (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault(); const f = new FormData(e.currentTarget); setBusy(true); setError('');
    const token = String(f.get('token') || '');
    try {
    if (kind === 'skills' && !resource && !skillPackage) throw new Error('请先选择 ZIP 技能包');
    const data = {
      kind, name: String(f.get('name')).trim(), description: String(f.get('description') || ''), domain: String(f.get('domain') || 'general'), body,
      status: String(f.get('status') || '已启用'), visibility: String(f.get('visibility') || 'private'),
      readerIds: f.getAll('readerIds'), managerIds: f.getAll('managerIds'),
      endpoint: String(f.get('endpoint') || ''), ...(token ? { token } : {}), ...(f.get('clearToken') ? { token: '' } : {}),
      allowedTools: kind === 'mcp' ? allowed : [], skillIds: f.getAll('skillIds'), mcpIds: f.getAll('mcpIds'), knowledgeIds: f.getAll('knowledgeIds'),
      revision: resource?.revision, toolPolicies: kind === 'mcp' ? JSON.parse(policies) : {},
      service: String(f.get('service') || ''), environment: String(f.get('environment') || 'test'), documentVersion: String(f.get('documentVersion') || ''),
      expiresAt: f.get('expiresAt') ? new Date(String(f.get('expiresAt'))).toISOString() : null, sourceUrl: String(f.get('sourceUrl') || ''),
      ...(kind === 'skills' && skillPackage ? { skillPackage } : {}),
    };
    const r = resource ? await put<Resource>(`/resources/${resource.id}`, data) : await post<Resource>('/resources', data); saved(r); }
    catch (e) { setError(errorText(e)); } finally { setBusy(false); }
  };
  const binding = (resourceKind: Page, key: 'knowledgeIds' | 'skillIds' | 'mcpIds', title: string) => <fieldset className="binding"><legend>{title}</legend>{resources.filter(r => r.kind === resourceKind && r.status === '已启用').map(r => <label className="check-row" key={r.id}><input type="checkbox" name={key} value={r.id} defaultChecked={resource?.[key]?.includes(r.id)} />{r.name}</label>)}{!resources.some(r => r.kind === resourceKind) && <p>暂无可绑定资源</p>}</fieldset>;
  return <Modal title={resource ? `${writable ? '编辑' : '查看'} · ${resource.name}` : createLabels[kind] || '创建资源'} onClose={close} wide><form onSubmit={submit} className="resource-form">
    {error && <div className="inline-error" role="alert">{error}</div>}
    {resource && <div className="info-strip">版本 {resource.revision} · {resource.publication === 'published' ? '已发布' : '草稿，尚不会加载到 Agent'}。修改 Skill / 子领域后需要重新发布。</div>}
    {resource?.kind === 'knowledge' && resource.sourceUrl && user.role === 'admin' && <Button type="button" disabled={busy} onClick={async () => { setBusy(true); try { saved(await post<Resource>(`/knowledge/${resource.id}/sync`)); } catch (e) { setError(errorText(e)); } finally { setBusy(false); } }}>从已保存来源同步文档（保留当前权限）</Button>}
    <fieldset disabled={!writable || busy} className="form-fields">
    {kind === 'skills' && <><div className="info-strip">上传包含 SKILL.md 的 ZIP 技能包，可附带 references、scripts 和 assets。保存为草稿，审核发布后指令才会生效；脚本仅随包保存，不会自动执行。</div><label>ZIP 技能包<input aria-label="ZIP 技能包" type="file" accept=".zip,application/zip,application/x-zip-compressed" onChange={async e => {
      const file = e.target.files?.[0]; e.target.value = ''; if (!file) return;
      setError(''); setBusy(true);
      try {
        if (!/\.zip$/i.test(file.name)) throw new Error('请选择 .zip 技能包');
        if (file.size > 600000) throw new Error('ZIP 包不能超过 600 KB');
        const bytes = new Uint8Array(await file.arrayBuffer()); let binary = '';
        for (const byte of bytes) binary += String.fromCharCode(byte);
        const pkg = { filename: file.name, base64: btoa(binary) };
        const result = await post<{ name: string; description: string; documentVersion: string; body: string; files: { path: string; size: number }[] }>('/skills/inspect', pkg);
        setSkillPackage(pkg); setName(result.name); setDescription(result.description); setBody(result.body); setPackageFiles(result.files); setPackageVersion(result.documentVersion);
      } catch (e) { setError(errorText(e)); } finally { setBusy(false); }
    }} /></label><p className="form-note">ZIP 最多 600 KB，解压后最多 5 MB；SKILL.md 最多 200 KB，位于包根目录或单层文件夹内。</p>
    {skillPackage && <div><strong>{skillPackage.filename}</strong><p>包版本：{packageVersion || '未声明'} · SKILL.md 内容预览如下</p>{packageFiles.length > 0 && <details><summary>包内文件（{packageFiles.length}）</summary><ul>{packageFiles.map(f => <li key={f.path}>{f.path} · {f.size} 字节</li>)}</ul></details>}</div>}</>}
    <div className="form-grid"><label>名称 *<input name="name" required maxLength={100} value={name} onChange={e => setName(e.target.value)} /></label><label>状态<select name="status" defaultValue={resource?.status || '已启用'}><option>已启用</option><option>已停用</option></select></label></div>
    <label>描述 / 适用场景<textarea name="description" value={description} onChange={e => setDescription(e.target.value)} maxLength={5000} /></label>
    <div className="form-grid"><label>服务标识<input name="service" defaultValue={resource?.service} maxLength={100} /></label><label>目标环境<select name="environment" defaultValue={resource?.environment || 'test'}><option value="test">测试</option><option value="staging">预发布</option><option value="production">生产</option></select></label></div>
    {kind === 'knowledge' && <><div className="form-grid"><label>文档版本<input name="documentVersion" defaultValue={resource?.documentVersion} /></label><label>有效期至<input name="expiresAt" type="datetime-local" defaultValue={resource?.expiresAt ? new Date(new Date(resource.expiresAt).getTime() - new Date(resource.expiresAt).getTimezoneOffset() * 60000).toISOString().slice(0, 16) : ''} /></label></div><label>来源 URL<input name="sourceUrl" type="url" defaultValue={resource?.sourceUrl} /></label></>}
    <div className="form-grid"><label>领域 / 标识<input name="domain" defaultValue={resource?.domain || 'general'} /></label><label>使用范围<select name="visibility" defaultValue={resource?.visibility || 'private'}><option value="private">私有 · 所有者与指定用户可用</option><option value="public">公开 · 工作空间全员可用</option></select></label></div>
    <details className="permission-details"><summary>指定可用用户与管理人</summary><div className="form-grid"><label>可用用户<select multiple name="readerIds" defaultValue={resource?.readerIds || []}>{directory.map(u => <option value={u.id} key={u.id}>{u.name} ({u.username})</option>)}</select></label><label>管理人<select multiple name="managerIds" defaultValue={resource?.managerIds || []}>{directory.map(u => <option value={u.id} key={u.id}>{u.name} ({u.username})</option>)}</select></label></div><p>按住 Ctrl / Command 可多选。资源所有者与管理员始终有管理权限。</p></details>
    {kind === 'mcp' ? <>
      <label>MCP Streamable HTTP 地址 *<input name="endpoint" type="url" required defaultValue={resource?.endpoint} placeholder="https://your-service.example.com/mcp" /></label>
      <label>Bearer Token<input name="token" type="password" autoComplete="new-password" placeholder={resource?.hasToken ? '已加密保存，留空保持不变' : '服务无需认证时可留空'} /></label>
      {resource?.hasToken && <label className="check-row"><input type="checkbox" name="clearToken" />清除已保存的 Token</label>}
      <div className="tool-permission-note"><Info size={15} /><span>勾选后仍需配置风险与范围策略。只读工具可自动查询，写操作需要审批；公开资源不会绕过工具的角色、环境和参数限制。</span></div>
      <div className="tool-list-heading"><strong>允许 Agent 使用的工具</strong>{resource && <Button type="button" onClick={() => void discover()}>连接并发现工具</Button>}</div>
      {!resource && <p className="form-note">先保存服务，再打开详情连接并选择工具。</p>}
      {[...new Set([...allowed, ...tools.map(t => t.name)])].map(name => <label className="check-row tool-row" key={name}><input type="checkbox" checked={allowed.includes(name)} onChange={e => setAllowed(e.target.checked ? [...allowed, name] : allowed.filter(n => n !== name))} /><span><strong>{name}</strong><small>{tools.find(t => t.name === name)?.description || '已保存的授权工具'}</small></span></label>)}
    </> : <>
    <div className="editor-label"><strong>{kind === 'agents' ? '子领域系统指令' : kind === 'skills' ? 'SKILL.md 指令内容' : 'Markdown 正文'}</strong>{kind !== 'skills' && <label className="file-upload"><Upload size={13} />导入 Markdown<input type="file" accept=".md,.txt,text/plain,text/markdown" onChange={async e => { const file = e.target.files?.[0]; if (!file) return; if (file.size > 200000) { setError('文档不能超过 200 KB'); return; } setBody(await file.text()); }} /></label>}</div>
    <div className="editor"><div className="editor-columns"><textarea aria-label="Markdown 正文" value={body} readOnly={kind === 'skills' && (!!skillPackage || !resource)} onChange={e => setBody(e.target.value)} maxLength={200000} required={kind === 'skills'} placeholder={kind === 'skills' ? '选择 ZIP 包后预览 SKILL.md…' : '# 标题\n\n编写知识或执行步骤…'} /><Markdown text={body} /></div></div>
    {kind === 'agents' && <div className="binding-grid">{binding('knowledge', 'knowledgeIds', '知识库')}{binding('skills', 'skillIds', 'Skill')}{binding('mcp', 'mcpIds', 'MCP 服务')}</div>}
    </>}
    {kind === 'mcp' && <><label>工具风险与范围策略（JSON）<textarea aria-label="工具策略" rows={12} value={policies} onChange={e => setPolicies(e.target.value)} spellCheck={false} /></label><p className="form-note">每个允许工具必须显式配置策略。需确认查询目标时，按工具参数填写 requiredTargetFields。只读示例：{JSON.stringify({ service_status: { risk: 'read', roles: ['admin', 'member'], environments: ['test'], constraints: { service: ['billing'] }, requiredTargetFields: ['service'], maxItems: 1 } })}。写操作还需幂等参数、只读核验与恢复说明；参阅官网生产治理章节。</p><Button type="button" onClick={() => { try { const p = JSON.parse(policies); for (const name of allowed) if (!p[name]) p[name] = { risk: 'read', roles: ['admin'], environments: ['test'], constraints: {}, requiredTargetFields: [], maxItems: 1 }; setPolicies(JSON.stringify(p, null, 2)); } catch { setError('请先修正策略 JSON'); } }}>为已选工具填入待核对的只读策略</Button></>}
    </fieldset>
    {kind === 'skills' && skillPackage && <Button type="button" onClick={() => {
      const bytes = Uint8Array.from(atob(skillPackage.base64), c => c.charCodeAt(0)); const url = URL.createObjectURL(new Blob([bytes], { type: 'application/zip' })); const link = document.createElement('a'); link.href = url; link.download = skillPackage.filename; link.click(); setTimeout(() => URL.revokeObjectURL(url), 1000);
    }}>下载原始 ZIP</Button>}
    {resource?.canManage && <details><summary>版本历史与发布</summary><p>回滚保留当前授权范围，Skill / 子领域回滚后为草稿。发布针对已保存的版本。</p>{user.role === 'admin' && ['skills', 'agents'].includes(kind) && <Button type="button" disabled={busy || body !== resource.body || resource.publication === 'published'} onClick={async () => { setBusy(true); try { saved(await post<Resource>(`/resources/${resource.id}/publish`, { revision: resource.revision })); } catch (e) { setError(errorText(e)); } finally { setBusy(false); } }}>审核并发布已保存版本 {resource.revision}</Button>}<ul>{versions.map(v => <li key={v.revision}>v{v.revision} · {v.action} · {new Date(v.created).toLocaleString()} {kind !== 'mcp' && v.revision !== resource.revision && <Button type="button" disabled={busy} onClick={async () => { setBusy(true); try { saved(await post<Resource>(`/resources/${resource.id}/rollback`, { revision: v.revision })); } catch (e) { setError(errorText(e)); } finally { setBusy(false); } }}>恢复为新版本</Button>}</li>)}</ul></details>}
    <div className="modal-footer"><Button type="button" onClick={close}>{writable ? '取消' : '关闭'}</Button>{writable && <Button primary type="submit" disabled={busy || kind === 'skills' && !resource && !skillPackage}>{resource ? <Save size={13} /> : <Plus size={13} />}{busy ? '处理中…' : kind === 'skills' && !resource ? '提交上传' : '保存'}</Button>}</div>
  </form></Modal>;
}

export function KnowledgeDetail({ resource, edit, back }: { resource: Resource; edit: () => void; back: () => void }) {
  const [tab, setTab] = useState(0);
  return <div className="detail-page"><div className="detail-top"><button className="text-button" onClick={back}>返回知识库列表</button>{resource.canManage && <Button primary onClick={edit}>编辑知识库</Button>}</div><div className="detail-summary"><div><h1>{resource.name}</h1><p>{resource.visibility === 'public' ? '已开放给所有人' : '仅所有者和指定用户可用'}</p></div><Badge tone={resource.status === '已启用' ? 'green' : ''}>{resource.status}</Badge><Badge>{resource.canManage ? '可管理' : '仅查看'}</Badge></div><div className="tabs detail-tabs">{['内容', '使用范围', '管理人'].map((t, i) => <button className={tab === i ? 'active' : ''} key={t} onClick={() => setTab(i)}>{t}</button>)}</div>{tab === 0 ? <><section className="detail-card"><div className="info-strip"><Info size={13} />领域、标题和正文参与知识检索，Agent 仅检索当前用户有权限的内容。</div><div className="detail-form"><label className="span-two">标题<input readOnly value={resource.name} /></label><label>状态<input readOnly value={resource.status} /></label><label>领域<input readOnly value={resource.domain} /></label><label className="span-two">检索摘要<input readOnly value={resource.description} /></label></div></section><section className="detail-card markdown-card"><h2>Markdown 正文</h2><p>左侧为已保存原稿，右侧为渲染预览。</p><div className="editor"><div className="editor-columns"><textarea aria-label="Markdown 原稿" readOnly value={resource.body} /><Markdown text={resource.body} /></div></div></section></> : <section className="detail-card"><h2>{tab === 1 ? '使用范围' : '管理人'}</h2><p>{tab === 1 ? `${resource.visibility === 'public' ? '工作空间全员可用' : '私有资源'}，另有 ${resource.readerIds.length} 个指定可用用户。` : `所有者：${resource.owner}；另有 ${resource.managerIds.length} 个指定管理人。`}</p></section>}</div>;
}
