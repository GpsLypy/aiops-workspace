import { useCallback, useEffect, useRef, useState } from 'react';
import { Trash2, Bell, BookOpen, Grid2X2, Zap, Layers, Clock3, MessageCircle, PanelLeftClose, PanelLeftOpen, Plus, RotateCw, Search, Maximize, X, Check, Settings as SettingsIcon, LogOut, SquarePen, ShieldCheck } from 'lucide-react';
import { api, post, remove, errorText, dateText, type ModelConfig, type User, type Resource, type Conversation } from './api';
import { labels, initialMarkdown, type Page } from './data';
import { Badge, Button, Empty, Modal } from './components/ui';
import Auth from './components/Auth';
import BrandMark from './components/BrandMark';
import Guidance from './components/Guidance';
import ResourceEditor, { createLabels, KnowledgeDetail } from './components/ResourceEditor';
import Settings from './components/Settings';
import Tasks from './components/Tasks';
import Notifications from './components/Notifications';
import './notifications.css';
import Sessions from './components/Sessions';
import Chat from './components/Chat';
import ExecutionCenter from './components/ExecutionCenter';
import ToolCatalog from './components/ToolCatalog';
import AgentScopeGuide from './components/AgentScopeGuide';
import DocumentCenter from './components/DocumentCenter';
import './production.css';

const icons = { guide: BookOpen, documents: BookOpen, knowledge: BookOpen, skills: Grid2X2, mcp: Zap, agents: Layers, tasks: Clock3, notifications: Bell, sessions: MessageCircle, chat: MessageCircle };
const nav: Page[] = ['guide', 'documents', 'knowledge', 'skills', 'mcp', 'agents', 'tasks', 'notifications', 'sessions'];
function initialPage() { const p = location.hash.slice(1).split('?')[0] as Page; return Object.hasOwn(labels, p) ? p : 'knowledge'; }

export default function App() {
  const [user, setUser] = useState<User | null>(null); const [loading, setLoading] = useState(true);
  useEffect(() => {
    api<User>('/auth/me').then(setUser).catch(() => {}).finally(() => setLoading(false));
    const expired = () => setUser(null); window.addEventListener('auth-expired', expired);
    return () => window.removeEventListener('auth-expired', expired);
  }, []);
  if (loading) return <div className="loading-screen"><BotMark />正在连接工作空间…</div>;
  if (!user) return <Auth onLogin={setUser} />;
  return <Workspace user={user} onLogout={() => setUser(null)} />;
}
function BotMark() { return <BrandMark className="brand-mark" />; }

function Workspace({ user, onLogout }: { user: User; onLogout: () => void }) {
  const [page, setPage] = useState<Page>(initialPage); const [collapsed, setCollapsed] = useState(false);
  const [resources, setResources] = useState<Resource[]>([]); const [conversations, setConversations] = useState<Conversation[]>([]);
  const [model, setModel] = useState<Pick<ModelConfig, 'configured' | 'model' | 'model_reasoning_effort'>>({ configured: false, model: '', model_reasoning_effort: null });
  const [settings, setSettings] = useState(false); const [toast, setToast] = useState(''); const [error, setError] = useState('');
  const [editing, setEditing] = useState<Resource | 'new' | null>(null); const [detailId, setDetailId] = useState<string | null>(null);
  const [deleting, setDeleting] = useState<Resource | null>(null); const [creatingTask, setCreatingTask] = useState(false);
  const [conversationId, setConversationId] = useState<string | null>(null); const [chatVersion, setChatVersion] = useState(0);
  const [query, setQuery] = useState(''); const [applied, setApplied] = useState(''); const [status, setStatus] = useState('全部状态');
  const [domain, setDomain] = useState('全部领域'); const [tab, setTab] = useState(0); const [pageNum, setPageNum] = useState(1); const [pageSize, setPageSize] = useState(20);
  const [busy, setBusy] = useState(false);
  const [executionCenter, setExecutionCenter] = useState(false);
  const [mobileNav, setMobileNav] = useState(false);
  const [catalog, setCatalog] = useState(false);
  const [searchChats, setSearchChats] = useState(false);
  const [chatQuery, setChatQuery] = useState('');
  const [chatDeletion, setChatDeletion] = useState<Conversation[] | null>(null);
  const [cleaningChats, setCleaningChats] = useState(false);
  const [cleanupError, setCleanupError] = useState('');
  const cleanupLock = useRef(false);
  const requestChatDeletion = (rows: Conversation[]) => { setCleanupError(''); setMobileNav(false); setChatDeletion(rows); };
  const deleteChats = async () => {
    if (cleanupLock.current || !chatDeletion?.length) return;
    cleanupLock.current = true; setCleaningChats(true); setCleanupError('');
    const deleted = new Set<string>(); const failed: Conversation[] = []; const reasons: string[] = [];
    try {
      for (const chat of chatDeletion) {
        try { await remove(`/conversations/${encodeURIComponent(chat.id)}`); deleted.add(chat.id); }
        catch (e) { failed.push(chat); reasons.push(errorText(e)); }
      }
      setConversations(old => old.filter(c => !deleted.has(c.id)));
      if (conversationId && deleted.has(conversationId)) { setConversationId(null); setChatVersion(v => v + 1); }
      if (failed.length) { setChatDeletion(failed); setCleanupError(`已删除 ${deleted.size} 条，${failed.length} 条未删除：${[...new Set(reasons)].join('；')}`); }
      else { setChatDeletion(null); notify(`已删除 ${deleted.size} 条对话`); }
    } finally { cleanupLock.current = false; setCleaningChats(false); }
  };
  const documentGuard = useRef({ dirty: false, busy: false, path: 'docs/README.md' });
  const onDocumentGuard = useCallback((guard: { dirty: boolean; busy: boolean; path?: string }) => { documentGuard.current = { ...documentGuard.current, ...guard }; }, []);
  const leaveDocuments = () => {
    if (documentGuard.current.busy) { setToast('文档正在保存，请等待同步完成'); return false; }
    if (documentGuard.current.dirty && !window.confirm('文档尚未保存，放弃修改并离开文档中心？')) return false;
    documentGuard.current.dirty = false; return true;
  };
  const notify = (text: string) => setToast(text);
  const refresh = async () => {
    try {
      const [r, c, m] = await Promise.all([api<Resource[]>('/resources'), api<Conversation[]>('/conversations'), api<Pick<ModelConfig, 'configured' | 'model' | 'model_reasoning_effort'>>('/model/status')]);
      setResources(r); setConversations(c); setModel(m); setError('');
    } catch (e) { setError(errorText(e)); }
  };
  useEffect(() => { void refresh(); }, []);
  useEffect(() => { if (!toast) return; const timer = setTimeout(() => setToast(''), 3500); return () => clearTimeout(timer); }, [toast]);
  const reset = () => { setQuery(''); setApplied(''); setStatus('全部状态'); setDomain('全部领域'); setPageNum(1); };
  const go = (next: Page) => { if (page === 'documents' && next !== page && !leaveDocuments()) return; setPage(next); location.hash = next; setDetailId(null); setTab(0); setMobileNav(false); reset(); };
  useEffect(() => {
    const change = () => {
      const next = initialPage();
      if (page === 'documents' && next !== page && !leaveDocuments()) { history.replaceState(null, '', `#documents?file=${encodeURIComponent(documentGuard.current.path)}`); return; }
      setPage(next); setDetailId(null); setTab(0); reset();
    };
    window.addEventListener('hashchange', change); return () => window.removeEventListener('hashchange', change);
  }, [page]);
  const logout = async () => { if (page === 'documents' && !leaveDocuments()) return; try { await post('/auth/logout'); onLogout(); } catch (e) { setError(errorText(e)); } };
  const openConversation = (id: string) => { setConversationId(id); setChatVersion(v => v + 1); go('chat'); };
  const newChat = () => { setConversationId(null); setChatVersion(v => v + 1); setChatQuery(''); setSearchChats(false); go('chat'); };
  const recentChats = conversations.filter(c => c.user_id === user.id);
  const visibleChats = recentChats.filter(c => c.title.toLocaleLowerCase().includes(chatQuery.trim().toLocaleLowerCase())).slice(0, 30);
  const chatTitle = conversations.find(c => c.id === conversationId)?.title || '新对话';
  const create = () => page === 'tasks' ? setCreatingTask(true) : setEditing('new');
  const filtered = resources.filter(r => r.kind === page && (tab !== 0 || !['skills', 'mcp'].includes(page) || r.canManage) && `${r.name} ${r.description} ${r.domain} ${r.owner}`.toLowerCase().includes(applied.toLowerCase()) && (status === '全部状态' || r.status === status) && (domain === '全部领域' || r.domain === domain));
  const pages = Math.max(1, Math.ceil(filtered.length / pageSize)); const currentPage = Math.min(pageNum, pages);
  const rows = filtered.slice((currentPage - 1) * pageSize, currentPage * pageSize);
  const detail = resources.find(r => r.id === detailId);
  const tabs = page === 'skills' ? ['我的 Skill', '全部可用 Skill'] : page === 'mcp' ? ['我的 MCP', '全部可用 MCP'] : [];
  const allowedCreate = page !== 'mcp' || user.role === 'admin';
  const saved = (r: Resource) => { setResources(old => old.some(x => x.id === r.id) ? old.map(x => x.id === r.id ? r : x) : [r, ...old]); setEditing(null); reset(); setTab(0); notify('资源已保存'); };
  const importSample = async () => { setBusy(true); try { saved(await post<Resource>('/resources', { kind: 'knowledge', name: 'Heimdallr接入手册（示例）', description: '演示用接入文档，请按实际服务更新。', domain: 'middleware/heimdallr', body: initialMarkdown, visibility: 'private' })); } catch (e) { setError(errorText(e)); } finally { setBusy(false); } };
  const resourceTable = <><div className="list-heading"><div><h2>{page === 'knowledge' ? '个人知识库' : ''}</h2><p>管理你有权查看或维护的{page === 'knowledge' ? '知识库' : page === 'skills' ? ' Skill' : page === 'mcp' ? ' MCP 服务' : '子领域'}，共 {filtered.length} 个。</p></div><div className="list-actions">{page === 'knowledge' && !resources.some(r => r.kind === 'knowledge') && <Button disabled={busy} onClick={() => void importSample()}>导入示例文档</Button>}{allowedCreate && page !== 'skills' && <Button primary onClick={create}><Plus size={13} />{createLabels[page]}</Button>}<Button onClick={() => void refresh().then(() => notify('已刷新'))}><RotateCw size={12} />刷新</Button></div></div>
    {tabs.length > 0 && <div className="tabs pill-tabs">{tabs.map((t, i) => <button className={tab === i ? 'active' : ''} key={t} onClick={() => { setTab(i); setPageNum(1); }}>{t}</button>)}</div>}
    <form className="filters" onSubmit={e => { e.preventDefault(); setApplied(query); setPageNum(1); }}><div className="search-input"><input aria-label="搜索" value={query} onChange={e => setQuery(e.target.value)} placeholder="搜索名称、描述、领域、所有者" /><Search size={13} /></div>{page === 'knowledge' && <select aria-label="领域" value={domain} onChange={e => { setDomain(e.target.value); setPageNum(1); }}><option>全部领域</option>{[...new Set(resources.filter(r => r.kind === 'knowledge').map(r => r.domain))].map(d => <option key={d}>{d}</option>)}</select>}<select aria-label="状态" value={status} onChange={e => { setStatus(e.target.value); setPageNum(1); }}><option>全部状态</option><option>已启用</option><option>已停用</option></select><Button primary type="submit">查询</Button><Button type="button" onClick={reset}>重置</Button></form>
    <div className="table-wrap"><table><thead><tr>{[page === 'knowledge' ? '知识库' : page === 'skills' ? 'Skill' : page === 'mcp' ? 'MCP' : '子领域', '状态', page === 'mcp' ? '服务 / 工具' : '领域 / 正文', '使用范围', '所有者', '我的权限', '更新时间', '操作'].map(h => <th key={h}>{h}</th>)}</tr></thead><tbody>{rows.length ? rows.map(r => <tr key={r.id}><td className="name-cell"><strong>{r.name}</strong><span title={r.description}>{r.description}</span></td><td><Badge tone={r.status === '已启用' ? 'green' : ''}>{r.status}</Badge></td><td><Badge>{r.domain}</Badge><small>{r.kind === 'mcp' ? `${r.allowedTools.length} 个授权工具` : r.body ? '已有正文' : '暂无正文'}</small></td><td>{r.visibility === 'public' ? '已开放给所有人' : '仅指定用户'}<small>{r.readerIds.length} 个指定用户</small></td><td><Badge tone="blue">{r.owner}</Badge></td><td><Badge>{r.canManage ? '可管理' : '仅查看'}</Badge></td><td className="date-cell">{dateText(r.updated)}</td><td><div className="row-actions"><button className="text-button" onClick={() => page === 'knowledge' ? setDetailId(r.id) : setEditing(r)}>详情</button>{r.canManage && (r.kind !== 'mcp' || user.role === 'admin') && <button className="text-button danger" onClick={() => setDeleting(r)}>删除</button>}</div></td></tr>) : <tr><td colSpan={8}><Empty text={applied ? '未找到匹配的结果' : '暂无数据，创建后即可在对话中使用'} /></td></tr>}</tbody></table><div className="pagination">共 {filtered.length} 条 <Button disabled={currentPage <= 1} onClick={() => setPageNum(currentPage - 1)}>‹</Button><span>{currentPage} / {pages}</span><Button disabled={currentPage >= pages} onClick={() => setPageNum(currentPage + 1)}>›</Button><select aria-label="每页条数" value={pageSize} onChange={e => { setPageSize(Number(e.target.value)); setPageNum(1); }}><option value={20}>20 条/页</option><option value={50}>50 条/页</option></select></div></div>
  </>;
  return <div className={`app ${collapsed ? 'collapsed' : ''}${page === 'chat' ? ' chat-workspace' : ''}`}>{page !== 'chat' && <div className="window-bar"><span>AI 助手</span><div><button aria-label="全屏" onClick={() => { if (document.fullscreenElement) void document.exitFullscreen(); else void document.documentElement.requestFullscreen().catch(() => notify('当前浏览器不支持全屏')); }}><Maximize size={12} /></button><button aria-label="返回首页" onClick={() => go('chat')}><X size={14} /></button></div></div>}
    <aside className="sidebar" aria-label="工作空间侧栏"><div className="brand"><BotMark /><strong>运维百晓生</strong><button aria-label={collapsed ? '展开侧边栏' : '收起侧边栏'} title={collapsed ? '展开侧边栏' : '收起侧边栏'} onClick={() => setCollapsed(!collapsed)}>{collapsed ? <PanelLeftOpen size={16} /> : <PanelLeftClose size={16} />}</button></div>{page === 'chat' ? <div className="chat-nav">
      <nav className="chat-shortcuts" aria-label="对话导航"><button className="new-chat" aria-label="新建对话" title="新建对话" onClick={newChat}><SquarePen size={17} /><span>新建对话</span></button><button className="chat-search-toggle" title="查找对话" aria-expanded={searchChats && !collapsed} onClick={() => { setCollapsed(false); if (searchChats && !collapsed) setChatQuery(''); setSearchChats(!searchChats || collapsed); }}><Search size={17} /><span>查找对话</span></button>
        <button title="工具与资源" onClick={() => go('knowledge')}><Grid2X2 size={17} /><span>工具与资源</span></button><button title="项目文档" onClick={() => go('documents')}><BookOpen size={17} /><span>项目文档</span></button><button title="AgentScope 入门" onClick={() => go('guide')}><Layers size={17} /><span>AgentScope 入门</span></button></nav>
      {searchChats && !collapsed && <div className="chat-search"><Search size={14} aria-hidden="true" /><input autoFocus aria-label="查找最近对话" placeholder="查找最近对话" value={chatQuery} onChange={event => setChatQuery(event.target.value)} onKeyDown={event => { if (event.key === 'Escape') { setSearchChats(false); setChatQuery(''); document.querySelector<HTMLButtonElement>('.chat-search-toggle')?.focus(); } }} /><button aria-label="清除对话搜索" onClick={() => setChatQuery('')}><X size={13} /></button></div>}
      <div className="recent-toolbar"><p className="recent-heading">最近对话</p><button type="button" className="cleanup-chats" aria-label="清理" title="清理最近对话" disabled={!recentChats.length} onClick={() => requestChatDeletion(recentChats)}><Trash2 size={15} aria-hidden="true" /></button></div><div className="recent-list">{visibleChats.map(c => <div className={`recent-row ${conversationId === c.id ? 'selected' : ''}`} key={c.id}><button className={`recent-chat ${conversationId === c.id ? 'selected' : ''}`} title={c.title} aria-current={conversationId === c.id ? 'page' : undefined} onClick={() => openConversation(c.id)}><span>{c.title}</span></button><button type="button" className="delete-chat" aria-label={`删除对话：${c.title}`} title="删除对话" onClick={() => requestChatDeletion([c])}><Trash2 size={15} aria-hidden="true" /></button></div>)}{!visibleChats.length && <p className="recent-empty">{chatQuery.trim() ? '没有匹配的对话' : '开始提问，对话会保存在这里'}</p>}</div>
    </div> : <nav>{nav.map(p => { const Icon = icons[p]; return <button key={p} title={labels[p]} className={page === p ? 'active' : ''} onClick={() => { go(p); void refresh(); }}><Icon size={13} /><span>{labels[p]}</span></button>; })}</nav>}<div className="sidebar-bottom"><button onClick={() => setSettings(true)} title="工作空间设置"><SettingsIcon size={16} /><span>工作空间设置</span></button><button onClick={() => void logout()} title="退出登录"><LogOut size={16} /><span>退出登录</span></button></div></aside>
    <header className="header"><div className="header-title"><button className="mobile-menu icon-button" aria-label="打开导航" aria-expanded={mobileNav} onClick={() => setMobileNav(true)}><PanelLeftOpen size={18} /></button><strong title={page === 'chat' ? chatTitle : labels[page]}>{page === 'chat' ? chatTitle : labels[page]}</strong></div><div className="header-right">{page === 'chat' ? <><button className="chat-header-action" aria-label="执行与审批" title="执行与审批" onClick={() => setExecutionCenter(true)}><ShieldCheck size={16} /><span>执行与审批</span></button><button className="chat-header-action" aria-label="进入后台" title="进入后台" onClick={() => go('knowledge')}><Grid2X2 size={16} /><span>进入后台</span></button></> : <div className="portal"><div><span>前台对话区</span><small>继续提问、追问和查看会话</small></div><button onClick={() => go('chat')}><MessageCircle size={12} />返回前台</button></div>}<button className="avatar" aria-label="当前用户" onClick={() => setSettings(true)}>{user.name.slice(0, 1)}</button></div></header>
    <main className={page === 'chat' ? 'main chat-main' : 'main'}>{error && <div className="inline-error" role="alert">{error}</div>}{page === 'chat' ? <Chat key={chatVersion} user={user} resources={resources} conversationId={conversationId} selectConversation={setConversationId} refresh={() => void refresh()} settings={() => setSettings(true)} customize={() => go('skills')} guide={() => go('guide')} {...model} /> : page === 'guide' ? <AgentScopeGuide resources={resources} configured={model.configured} user={user} go={go} startChat={() => { setConversationId(null); setChatVersion(v => v + 1); go('chat'); }} /> : page === 'documents' ? <DocumentCenter onGuard={onDocumentGuard} /> : page === 'sessions' ? <Sessions conversations={conversations} resources={resources} refresh={() => void refresh()} open={openConversation} /> : page === 'notifications' ? <Notifications user={user} /> : detail ? <KnowledgeDetail resource={detail} edit={() => setEditing(detail)} back={() => setDetailId(null)} /> : <><Guidance page={page} go={go} create={create} />{['skills', 'mcp'].includes(page) && <div className="capability-shortcut"><div><strong>工具能力，一处查阅</strong><p>查看 MCP 允许列表、风险分类与交互审批要求。</p></div><Button onClick={() => setCatalog(true)}><Zap size={14} />查看工具清单</Button></div>}{page === 'tasks' ? <Tasks user={user} resources={resources} creating={creatingTask} closeCreate={() => setCreatingTask(false)} create={() => setCreatingTask(true)} openConversation={openConversation} /> : resourceTable}</>}</main>
    {mobileNav && <Modal drawer title="工作空间导航" onClose={() => setMobileNav(false)}><div className="mobile-navigation"><Button primary onClick={newChat}><Plus size={16} />新建对话</Button><nav>{nav.map(p => <button key={p} aria-current={page === p ? 'page' : undefined} onClick={() => go(p)}>{labels[p]}</button>)}</nav><div className="recent-toolbar"><h3>最近对话</h3><button type="button" className="cleanup-chats" aria-label="清理" title="清理最近对话" disabled={!recentChats.length} onClick={() => requestChatDeletion(recentChats)}><Trash2 size={15} aria-hidden="true" /></button></div>{recentChats.slice(0, 30).map(c => <div className={`recent-row ${conversationId === c.id ? 'selected' : ''}`} key={c.id}><button className="mobile-recent" title={c.title} aria-current={conversationId === c.id ? 'page' : undefined} onClick={() => openConversation(c.id)}><span>{c.title}</span></button><button type="button" className="delete-chat" title="删除对话" aria-label={`删除对话：${c.title}`} onClick={() => requestChatDeletion([c])}><Trash2 size={15} aria-hidden="true" /></button></div>)}<Button onClick={() => { setMobileNav(false); setSettings(true); }}>工作空间设置</Button><Button onClick={() => void logout()}>退出登录</Button></div></Modal>}
    {chatDeletion && <Modal title={chatDeletion.length === 1 ? '删除对话' : '清理最近对话'} onClose={() => { if (!cleanupLock.current) setChatDeletion(null); }}><div className="modal-content"><p>{chatDeletion.length === 1 ? `确认删除「${chatDeletion[0].title}」？` : `确认删除已加载的 ${chatDeletion.length} 条本人对话？包含当前打开的对话，不受搜索筛选影响。`}</p><p>对话与消息将永久删除，无法恢复。正在执行的会话会保留。列表最多加载最近 300 条会话，更早的记录不在本次清理范围内。</p>{cleanupError && <div className="inline-error" role="alert">{cleanupError}</div>}<div className="modal-footer"><Button disabled={cleaningChats} onClick={() => setChatDeletion(null)}>取消</Button><Button className="danger" disabled={cleaningChats} onClick={() => void deleteChats()}>{cleaningChats ? '正在删除…' : cleanupError ? '重试未删除的对话' : '确认删除'}</Button></div></div></Modal>}
    {catalog && <ToolCatalog resources={resources} close={() => setCatalog(false)} manage={r => { setCatalog(false); setEditing(r); }} />}
    {editing && <ResourceEditor key={editing === 'new' ? page : editing.id} kind={editing === 'new' ? page : editing.kind} resource={editing === 'new' ? undefined : editing} resources={resources} user={user} close={() => setEditing(null)} saved={saved} />}
    {page !== 'chat' && <button className="execution-launch" onClick={() => setExecutionCenter(true)}>执行与审批</button>}
    {executionCenter && <ExecutionCenter user={user} resources={resources} close={() => setExecutionCenter(false)} />}
    {settings && <Settings user={user} close={() => setSettings(false)} changed={() => void refresh()} logout={() => void logout()} />}
    {deleting && <Modal title="删除资源" onClose={() => setDeleting(null)}><div className="modal-content"><p>确认删除「{deleting.name}」？删除后，新对话将不再使用此资源。</p>{error && <div className="inline-error">{error}</div>}<div className="modal-footer"><Button onClick={() => setDeleting(null)}>取消</Button><Button primary disabled={busy} onClick={async () => { setBusy(true); try { await remove(`/resources/${deleting.id}`); setResources(old => old.filter(r => r.id !== deleting.id)); setDeleting(null); notify('资源已删除'); } catch (e) { setError(errorText(e)); } finally { setBusy(false); } }}>确认删除</Button></div></div></Modal>}
    {toast && <div role="status" className="toast"><Check size={16} />{toast}</div>}
  </div>;
}
