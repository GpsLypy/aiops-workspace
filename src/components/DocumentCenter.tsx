import { useCallback, useEffect, useRef, useState, type MouseEvent } from 'react';
import { ArrowLeft, ArrowUpRight, BookOpen, ChevronRight, Download, FileText, List, Network, Pencil, RotateCw, Save, Search, X } from 'lucide-react';
import { api, put, dateText, errorText, type ProjectDocument, type DocumentCatalog } from '../api';
import { Button, Empty, Markdown } from './ui';
import '../document-center.css';

const routeFile = () => new URLSearchParams(location.hash.split('?')[1] || '').get('file') || '';
type Guard = { dirty: boolean; busy: boolean; path?: string };
const groupDescriptions: Record<string, string> = {
  '入门与使用': '安装、首次对话与日常使用。',
  '代码库与开发': '目录职责、源码入口与开发维护。',
  '运行原理': '消息、模型、上下文与工具执行。',
  '部署与运维': '运行环境、系统接入、排错与治理。',
  '学习与面试': '源码学习、实验与项目复盘。',
  '历史与验证': '实测证据、历史调研与验收边界。',
  '教学附件': '配套示例与练习材料。',
};
const moduleEntries = [
  { path: 'src/codemap.md', directory: 'src/', label: '前端', description: '页面、交互与样式' },
  { path: 'server/codemap.md', directory: 'server/', label: '后端', description: '接口、权限与数据' },
  { path: 'agent-worker/codemap.md', directory: 'agent-worker/', label: 'Python Worker', description: 'AgentScope 编排' },
];
function excerpt(content: string) {
  const paragraph = content.split(/\n\s*\n/).find(part => !/^\s*(#|```|~~~|\||<|!\[|[-*] |\d+\.)/.test(part) && part.trim().length > 12);
  return (paragraph || '打开文档，查看完整说明与操作步骤。')
    .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1').replace(/[*_`]/g, '').replace(/\s+/g, ' ').trim().slice(0, 140);
}

export default function DocumentCenter({ onGuard }: { onGuard: (guard: Guard) => void }) {
  const [catalog, setCatalog] = useState<DocumentCatalog | null>(null);
  const [selected, setSelected] = useState(routeFile);
  const [document, setDocument] = useState<ProjectDocument | null>(null);
  const [draft, setDraft] = useState('');
  const [editing, setEditing] = useState(false);
  const [view, setView] = useState<'source' | 'split' | 'preview'>('split');
  const [search, setSearch] = useState(''); const [group, setGroup] = useState('全部文档');
  const [loading, setLoading] = useState(true); const [saving, setSaving] = useState(false);
  const [error, setError] = useState(''); const [notice, setNotice] = useState('');
  const [reload, setReload] = useState(0);
  const [directoryOpen, setDirectoryOpen] = useState(false);
  const [outline, setOutline] = useState<{ id: string; title: string; level: number }[]>([]);
  const dirty = !!document && draft !== document.content;
  const guard = useRef({ dirty, busy: saving }); guard.current = { dirty, busy: saving };
  const mounted = useRef(true); const reader = useRef<HTMLDivElement>(null); const homeHeading = useRef<HTMLHeadingElement>(null); const center = useRef<HTMLElement>(null);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; onGuard({ dirty: false, busy: false }); }; }, [onGuard]);
  useEffect(() => { onGuard({ dirty, busy: saving, path: selected }); }, [dirty, saving, selected, onGuard]);
  useEffect(() => {
    const beforeUnload = (event: BeforeUnloadEvent) => { if (guard.current.dirty || guard.current.busy) { event.preventDefault(); event.returnValue = ''; } };
    window.addEventListener('beforeunload', beforeUnload);
    return () => window.removeEventListener('beforeunload', beforeUnload);
  }, []);
  const loadCatalog = useCallback(async (signal?: AbortSignal) => {
    const result = await api<DocumentCatalog>('/documents', { signal });
    if (mounted.current) setCatalog(result);
  }, []);
  useEffect(() => {
    const controller = new AbortController();
    void loadCatalog(controller.signal).catch(e => { if (!controller.signal.aborted) { setError(errorText(e)); setLoading(false); } });
    return () => controller.abort();
  }, [loadCatalog, reload]);
  useEffect(() => {
    const controller = new AbortController(); setLoading(true); setError(''); setNotice(''); setDocument(null); setEditing(false);
    setDirectoryOpen(false); setOutline([]);
    if (!selected) { setDraft(''); setLoading(false); return () => controller.abort(); }
    void api<ProjectDocument>(`/documents/content?path=${encodeURIComponent(selected)}`, { signal: controller.signal }).then(result => {
      if (controller.signal.aborted) return;
      setDocument(result); setDraft(result.content);
    }).catch(e => { if (!controller.signal.aborted) setError(errorText(e)); }).finally(() => { if (!controller.signal.aborted) setLoading(false); });
    return () => controller.abort();
  }, [selected, reload]);
  useEffect(() => {
    const change = () => {
      if (location.hash.split('?')[0] !== '#documents') return;
      const next = routeFile();
      if (next === selected) return;
      if (guard.current.busy || (guard.current.dirty && !window.confirm('当前文档尚未保存，放弃修改并切换文档？'))) {
        history.replaceState(null, '', selected ? `#documents?file=${encodeURIComponent(selected)}` : '#documents'); return;
      }
      setSelected(next);
    };
    window.addEventListener('hashchange', change); return () => window.removeEventListener('hashchange', change);
  }, [selected]);
  // Provide heading anchors for same-document links after sanitized Markdown rendering.
  useEffect(() => {
    const headings: typeof outline = []; const ids = new Map<string, number>();
    reader.current?.querySelectorAll('h1,h2,h3,h4,h5,h6').forEach(heading => {
      const title = (heading.textContent || '').trim();
      const base = title.toLowerCase().replace(/[^\p{L}\p{N}\s_-]/gu, '').replace(/\s+/g, '-') || 'section';
      const count = ids.get(base) || 0; ids.set(base, count + 1);
      heading.id = count ? `${base}-${count}` : base;
      if (heading.tagName === 'H2' || heading.tagName === 'H3') headings.push({ id: heading.id, title, level: Number(heading.tagName.slice(1)) });
    });
    setOutline(headings);
  }, [draft, editing, view, document]);
  useEffect(() => {
    if (loading) return;
    center.current?.scrollIntoView({ block: 'start' });
    if (document?.path === selected) {
      reader.current?.focus({ preventScroll: true });
    } else if (!selected) homeHeading.current?.focus({ preventScroll: true });
  }, [selected, loading]);
  const mayDiscard = () => !guard.current.busy && (!guard.current.dirty || window.confirm('当前文档尚未保存，放弃修改？'));
  const select = (path: string) => {
    if (path === selected || !mayDiscard()) return;
    setSelected(path); setNotice('');
    history.pushState(null, '', path ? `#documents?file=${encodeURIComponent(path)}` : '#documents');
  };
  const refresh = () => { if (mayDiscard()) setReload(v => v + 1); };
  const download = () => {
    if (!document) return;
    const url = URL.createObjectURL(new Blob([draft], { type: 'text/markdown;charset=utf-8' }));
    const link = window.document.createElement('a'); link.href = url; link.download = selected.split('/').at(-1) || 'document.md'; link.click(); URL.revokeObjectURL(url);
  };
  const save = async () => {
    if (!document || saving || !dirty) return;
    setSaving(true); onGuard({ dirty: true, busy: true }); setError(''); setNotice('');
    try {
      const result = await put<{ document: ProjectDocument; siteRebuilt: boolean }>('/documents/content', { path: selected, content: draft, revision: document.revision });
      if (!mounted.current) return;
      setDocument(result.document); setDraft(result.document.content);
      setCatalog(old => old ? { ...old, documents: old.documents.map(d => d.path === selected ? result.document : d) } : old);
      setNotice('已保存，离线文档网站已同步更新。');
    } catch (e) { if (mounted.current) setError(errorText(e)); }
    finally { if (mounted.current) setSaving(false); }
  };
  const followLink = (event: MouseEvent<HTMLDivElement>) => {
    const link = (event.target as HTMLElement).closest('a'); if (!link) return;
    const href = link.getAttribute('href') || '';
    if (/^(https?:|mailto:)/i.test(href)) { link.target = '_blank'; link.rel = 'noopener noreferrer'; return; }
    const url = new URL(href, `https://documents.invalid/${selected}`);
    const path = decodeURIComponent(url.pathname.slice(1));
    if (path === 'docs/site/architecture.html' || path === 'architecture.html') {
      link.href = `/architecture.html${url.hash}`; link.target = '_blank'; link.rel = 'noopener noreferrer'; return;
    }
    event.preventDefault();
    if (path === selected && url.hash) {
      const target = Array.from(reader.current?.querySelectorAll('[id]') || []).find(el => el.id === decodeURIComponent(url.hash.slice(1)));
      if (target) target.scrollIntoView({ block: 'start' }); else setNotice('该章节锚点未找到，请在文档内查找对应标题。');
    } else if (catalog?.documents.some(d => d.path === path)) select(path);
    else setNotice(`此链接指向配套源码或离线资源：${path}。可在项目目录中查看。`);
  };
  const groupOrder = ['入门与使用', '代码库与开发', '运行原理', '部署与运维', '学习与面试', '历史与验证', '教学附件'];
  const groups = [...new Set(catalog?.documents.map(d => d.group))].sort((a, b) => (groupOrder.includes(a) ? groupOrder.indexOf(a) : 99) - (groupOrder.includes(b) ? groupOrder.indexOf(b) : 99));
  const term = search.trim().toLowerCase();
  const visible = catalog?.documents.filter(d => (group === '全部文档' || d.group === group) && `${d.title}\n${d.path}\n${d.content}`.toLowerCase().includes(term)) || [];
  const matchingGroups = groups.filter(g => visible.some(d => d.group === g));
  const searchControl = <label className="documents-search"><Search size={17} aria-hidden="true" /><input aria-label="搜索项目文档" value={search} onChange={e => setSearch(e.target.value)} placeholder="搜索标题、路径或正文" />{search && <button type="button" aria-label="清空文档搜索" onClick={() => setSearch('')}><X size={14} /></button>}</label>;
  const categoryControl = <select aria-label="文档分类" value={group} onChange={e => setGroup(e.target.value)}><option>全部文档</option>{groups.map(g => <option key={g}>{g}</option>)}</select>;
  const account = catalog?.canEdit ? '管理员可编辑原文' : '当前账号可阅读和下载';
  const architectureLink = <a className="documents-architecture" href="/architecture.html" target="_blank" rel="noopener noreferrer" aria-label="打开架构图（新标签页）"><Network size={16} aria-hidden="true" />架构图<ArrowUpRight size={14} aria-hidden="true" /></a>;
  return <section ref={center} className="document-center" aria-label="项目文档中心">
    {!selected ? <>
      <header className="documents-hero"><div className="documents-hero-top"><span className="documents-eyebrow"><BookOpen size={16} aria-hidden="true" />运维百晓生 · 项目手册</span><div className="documents-hero-actions">{architectureLink}<button className="documents-hero-refresh" aria-label="重新加载文档" onClick={refresh}><RotateCw size={14} />刷新目录</button></div></div><h1 ref={homeHeading} tabIndex={-1}>文档中心</h1><p>使用指南、代码库说明与部署手册，按需要阅读。</p>{searchControl}<div className="documents-hero-meta"><span>{catalog?.documents.length ?? '—'} 篇文档 · {groups.length} 个分类</span><span>{account}</span></div></header>
      {error && <div className="inline-error documents-feedback" role="alert">{error}</div>}
      {!term && group === '全部文档' && <nav className="documents-starts" aria-label="文档阅读入口">{['入门与使用', '代码库与开发', '部署与运维'].filter(g => groups.includes(g)).map(g => <button key={g} onClick={() => setGroup(g)}><span><BookOpen size={17} aria-hidden="true" /><ChevronRight size={16} aria-hidden="true" /></span><strong>{g}</strong><p>{groupDescriptions[g]}</p><small>{catalog?.documents.filter(d => d.group === g).length} 篇文档</small></button>)}</nav>}
      {!term && group === '全部文档' && catalog?.documents.some(d => d.path === 'docs/repository-guide.md') && <section className="documents-modules" aria-label="代码库速览"><div className="documents-modules-heading"><h2>代码库速览</h2><button onClick={() => select('docs/repository-guide.md')}>查看全部目录<ArrowUpRight size={14} aria-hidden="true" /></button></div><nav aria-label="代码模块">{moduleEntries.filter(entry => catalog.documents.some(d => d.path === entry.path)).map(entry => <button key={entry.path} onClick={() => select(entry.path)}><code>{entry.directory}</code><strong>{entry.label}</strong><span>{entry.description}</span><ChevronRight size={15} aria-hidden="true" /></button>)}</nav></section>}
      <div className="documents-catalog-bar"><h2>{term ? '搜索结果' : group === '全部文档' ? '全部文档' : group}<span role="status">{visible.length} 篇{term && '匹配搜索'}</span></h2><div>{(term || group !== '全部文档') && <button className="documents-reset" onClick={() => { setSearch(''); setGroup('全部文档'); }}>查看全部</button>}{categoryControl}</div></div>
      {!catalog && !error && <div className="documents-empty" role="status">正在读取文档目录…</div>}
      <div className="documents-catalog">{matchingGroups.map(g => <section className="documents-category" key={g} aria-label={g}><div className="documents-category-heading"><h2>{g}</h2><span>{visible.filter(d => d.group === g).length} 篇</span></div><div className="documents-card-grid">{visible.filter(d => d.group === g).map(d => <button className="document-card" key={d.path} onClick={() => select(d.path)}><span className="document-card-icon"><FileText size={18} aria-hidden="true" /><ArrowUpRight size={15} aria-hidden="true" /></span><h3>{d.title}</h3><p>{excerpt(d.content)}</p><small title={d.path}>{d.path}</small></button>)}</div></section>)}</div>
      {catalog && !visible.length && <Empty text="没有匹配的文档，请调整关键词或分类" />}
    </> : <>
    <div className="documents-reading-heading"><button className="documents-back" disabled={saving} onClick={() => select('')}><ArrowLeft size={15} />全部文档</button><span>{document?.group || '文档阅读'}</span>{architectureLink}<button className="documents-directory-toggle" aria-expanded={directoryOpen} aria-controls="documents-directory" onClick={() => setDirectoryOpen(v => !v)}><List size={15} />文档目录</button></div>
    <div className="documents-layout">
      <aside id="documents-directory" className={`documents-directory ${directoryOpen ? 'is-open' : ''}`} aria-label="文档目录">
        {searchControl}{categoryControl}
        <div className="documents-count" role="status">{visible.length} 篇文档{term && '匹配搜索'}</div>
        <nav className="documents-list" aria-label="用户文档列表">{matchingGroups.map(g => <details key={g} open={!!term || g === document?.group}><summary>{g}<span>{visible.filter(d => d.group === g).length}</span><ChevronRight size={12} aria-hidden="true" /></summary>{visible.filter(d => d.group === g).map(d => <button key={d.path} title={d.path} disabled={saving} aria-current={d.path === selected ? 'page' : undefined} onClick={() => select(d.path)}><span>{d.title}</span></button>)}</details>)}{catalog && !visible.length && <Empty text="没有匹配的文档，请调整关键词或分类" />}</nav>
      </aside>
      <div className="documents-workbench" aria-busy={loading || saving}>
        <div className="documents-toolbar"><div><span className="documents-state">{saving ? '正在保存并同步网站…' : dirty ? '有未保存修改' : editing ? '编辑 Markdown' : '阅读文档'}</span><div className="documents-path">{selected}</div></div><div className="documents-actions"><Button disabled={saving} onClick={refresh} aria-label="重新加载文档"><RotateCw size={14} />刷新</Button><Button disabled={!document} onClick={download}><Download size={14} />{dirty ? '下载草稿' : '下载文档'}</Button>{catalog?.canEdit && (editing ? <><Button disabled={saving} onClick={() => { if (mayDiscard()) { setDraft(document?.content || ''); setEditing(false); setError(''); } }}>退出编辑</Button><Button primary disabled={saving || !dirty} onClick={() => void save()}><Save size={14} />{saving ? '保存中…' : '保存修改'}</Button></> : <Button primary disabled={!document || loading} onClick={() => { setEditing(true); setError(''); setNotice(''); }}><Pencil size={14} />编辑文档</Button>)}</div></div>
        {error && <div className="inline-error documents-feedback" role="alert">{error}</div>}
        {notice && <div className="documents-feedback documents-notice" role="status">{notice}</div>}
        {loading ? <div className="documents-empty" role="status">正在读取文档…</div> : document ? <>
          <div className="documents-meta"><span>更新于 {dateText(document.updatedAt)}</span><span>{(document.size / 1024).toFixed(1)} KiB</span><span>{account}</span></div>
          {editing && <div className="documents-editor-bar"><div role="group" aria-label="编辑视图">{([['source', '原稿'], ['split', '原稿与预览'], ['preview', '预览']] as const).map(([mode, label]) => <button key={mode} aria-pressed={view === mode} onClick={() => setView(mode)}>{label}</button>)}</div><span>保存到项目原文件，并同步离线网站</span></div>}
          <div className={`documents-content ${editing ? `is-editing view-${view}` : ''}`} ref={reader} tabIndex={-1} aria-label={document.title} onClick={followLink}>
            {editing && view !== 'preview' && <textarea aria-label="文档 Markdown 原稿" spellCheck={false} readOnly={saving} value={draft} onChange={e => { setDraft(e.target.value); setNotice(''); }} />}
            {(!editing || view !== 'source') && <Markdown text={draft} />}
          </div>
        </> : <div className="documents-empty">请选择目录中的文档，或点击刷新重试。</div>}
      </div>
      {!editing && outline.length > 0 && <aside className="documents-outline" aria-label="本页目录"><h2>本页目录</h2><nav>{outline.map(item => <button key={item.id} className={item.level === 3 ? 'is-subheading' : undefined} onClick={() => { const heading = Array.from(reader.current?.querySelectorAll<HTMLElement>('[id]') || []).find(element => element.id === item.id); heading?.scrollIntoView({ block: 'start' }); heading?.setAttribute('tabindex', '-1'); heading?.focus({ preventScroll: true }); }}>{item.title}</button>)}</nav></aside>}
    </div>
    </>}
    {catalog && !catalog.documents.length && <p className="documents-feedback" role="status">当前部署没有用户文档源文件。请在包含项目手册的源码工作空间打开文档中心。</p>}
  </section>;
}
