import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { ArrowUp, ArrowDown, Square, Bot, Paperclip, X, BookOpen, AlertTriangle, ShieldCheck, Check, ChevronRight, GitBranch } from 'lucide-react';
import { api, post, chatStream, errorText, type AgentDelegation, type ModelRetry, type ReasoningEffort, type ExecutionTrace, type Conversation, type Message, type Resource, type TargetBinding, type User } from '../api';
import { Badge, Button, Markdown } from './ui';
import ReasoningEffortControl, { effortOptions } from './ReasoningEffortControl';
import BrandMark from './BrandMark';
import { createRequestKey } from '../request-id';
import EvidenceReport from './EvidenceReport';
import AgentReview from './AgentReview';
import ExecutionPanorama from './ExecutionPanorama';
import TargetBindingControl from './TargetBindingControl';
import { createStreamReveal } from '../stream-reveal';
import AgentSelector from './AgentSelector';
import ChatRunStatus, { formatRunElapsed, type ChatRetry } from './ChatRunStatus';

function delegationSummary(delegation: AgentDelegation) {
  if (!delegation.children.length) return '已允许委派，本轮未创建子任务。';
  const unfinished = delegation.children.filter(child => child.status !== 'completed').length;
  return `本轮委派 ${delegation.children.length} 个子任务${unfinished ? `，${unfinished} 个未完成` : '，处理已结束'}；结果与缺口见本轮全景。`;
}

export default function Chat({ user, resources, conversationId, selectConversation, refresh, settings, customize, guide, model, configured, model_reasoning_effort }: { user: User; resources: Resource[]; conversationId: string | null; selectConversation: (id: string) => void; refresh: () => void; settings: () => void; customize: () => void; guide: () => void; model: string; configured: boolean; model_reasoning_effort: ReasoningEffort | null }) {
  const [messages, setMessages] = useState<(Message & { streaming?: boolean; recovering?: boolean })[]>([]); const [draft, setDraft] = useState('');
  const [agentId, setAgentId] = useState(''); const [useKnowledge, setUseKnowledge] = useState(true);
  const [effort, setEffort] = useState<ReasoningEffort | null | undefined>(undefined);
  const [independentReview, setIndependentReview] = useState(false);
  const [allowDelegation, setAllowDelegation] = useState(false);
  const [targetBinding, setTargetBinding] = useState<TargetBinding | null>(null);
  const [liveTrace, setLiveTrace] = useState<ExecutionTrace | null>(null);
  const [panoramaRunId, setPanoramaRunId] = useState<string | null>(null);
  const [busy, setBusy] = useState(false); const [progress, setProgress] = useState(''); const [error, setError] = useState('');
  const [notice, setNotice] = useState(''); const [startedAt, setStartedAt] = useState(0);
  const [retry, setRetry] = useState<ChatRetry | null>(null); const [runId, setRunId] = useState('');
  const [stopping, setStopping] = useState(false);
  const [showLatest, setShowLatest] = useState(false);
  const busyRef = useRef(false); const acceptedRun = useRef(''); const cancelRequested = useRef(false);
  const [owner, setOwner] = useState(user.id); const [attachment, setAttachment] = useState<{ name: string; text: string } | null>(null);
  const page = useRef<HTMLDivElement>(null); const file = useRef<HTMLInputElement>(null); const end = useRef<HTMLDivElement>(null); const sendingId = useRef<string | null>(null);
  const mounted = useRef(true); const currentId = useRef(conversationId); currentId.current = conversationId;
  const follow = useRef(true);
  const input = useRef<HTMLTextAreaElement>(null);
  const revealRef = useRef<ReturnType<typeof createStreamReveal> | null>(null);
  const displayConnection = useRef<AbortController | null>(null);
  const selectedTrace = liveTrace?.runId === panoramaRunId ? liveTrace : messages.find(message => message.metadata.executionTrace?.runId === panoramaRunId)?.metadata.executionTrace;
  const closePanorama = () => {
    const runId = panoramaRunId;
    setPanoramaRunId(null);
    requestAnimationFrame(() => {
      if (!mounted.current) return;
      const entry = Array.from(page.current?.querySelectorAll<HTMLButtonElement>('.panorama-entry[data-run-id]') || []).find(button => button.dataset.runId === runId);
      (entry || page.current?.querySelector<HTMLTextAreaElement>('.composer textarea'))?.focus();
    });
  };
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; revealRef.current?.dispose(); displayConnection.current?.abort(); }; }, []);
  useEffect(() => { if (panoramaRunId && !selectedTrace) closePanorama(); }, [panoramaRunId, selectedTrace]);
  useEffect(() => {
    if (sendingId.current && sendingId.current === conversationId) return;
    setTargetBinding(null);
    setLiveTrace(null); setPanoramaRunId(null);
    if (!conversationId) { setMessages([]); setOwner(user.id); setAgentId(''); setError(''); return; }
    let cancelled = false;
    api<Conversation>(`/conversations/${conversationId}`).then(c => { if (!cancelled) { setMessages(c.messages || []); setOwner(c.user_id); setAgentId(c.agent_id || ''); } }).catch(e => { if (!cancelled) setError(errorText(e)); });
    return () => { cancelled = true; };
  }, [conversationId]);
  useEffect(() => {
    const box = end.current?.parentElement;
    if (follow.current && box) box.scrollTop = box.scrollHeight;
  }, [messages, progress]);
  useLayoutEffect(() => {
    const resize = () => {
      if (!input.current) return;
      input.current.style.height = '0px';
      input.current.style.height = `${Math.min(input.current.scrollHeight, Math.max(64, Math.min(160, window.innerHeight * .24)))}px`;
    };
    resize();
    window.addEventListener('resize', resize);
    return () => window.removeEventListener('resize', resize);
  }, [draft, owner]);
  const latest = () => {
    const box = end.current?.parentElement;
    follow.current = true; setShowLatest(false);
    if (box) { box.scrollTop = box.scrollHeight; box.focus({ preventScroll: true }); }
  };
  const stop = async () => {
    const id = acceptedRun.current;
    if (!id || !busyRef.current || stopping || cancelRequested.current) return;
    cancelRequested.current = true; setStopping(true);
    try { await post(`/executions/${encodeURIComponent(id)}/cancel`, {}); }
    catch (e) {
      if (mounted.current && acceptedRun.current === id && busyRef.current) {
        cancelRequested.current = false; setStopping(false);
        if (errorText(e) !== '执行已结束') setError(errorText(e));
      }
    }
  };
  const send = async () => {
    if (!draft.trim() || busyRef.current || owner !== user.id) return;
    const text = attachment ? `${draft.trim()}\n\n附加文档「${attachment.name}」：\n${attachment.text}` : draft.trim();
    if (text.length > 20000) { setError('问题与附件合计不能超过 20,000 个字符'); return; }
    let requestKey: string;
    try { requestKey = createRequestKey(); } catch (e) { setError(errorText(e)); return; }
    busyRef.current = true; acceptedRun.current = ''; cancelRequested.current = false;
    setError(''); setNotice(''); setRetry(null); setRunId(''); setStopping(false); setStartedAt(Date.now());
    setLiveTrace(null); setBusy(true); setProgress('正在准备会话…'); setDraft(''); setAttachment(null); setTargetBinding(null);
    follow.current = true;
    setMessages(old => [...old, { seq: Date.now(), role: 'user', content: text, metadata: {}, created: new Date().toISOString() }]);
    let cid = conversationId;
    const replySeq = -Date.now(); let streamId = '', activeProgress = '正在生成回复…'; let pendingRetry: ModelRetry | null = null;
    const resumed = () => { if (pendingRetry) { pendingRetry = null; setRetry(null); setProgress(activeProgress); } };
    const clearDraft = () => { revealRef.current?.reset(); setMessages(old => old.filter(m => m.seq !== replySeq)); };
    const reply = (content: string, metadata: Message['metadata'] = {}, streaming = false): Message & { streaming?: boolean } => ({ seq: replySeq, role: 'assistant', content, metadata, streaming, created: new Date().toISOString() });
    const reveal = createStreamReveal(content => {
      if (!mounted.current || (cid && currentId.current && currentId.current !== cid)) return;
      setMessages(old => old.some(m => m.seq === replySeq) ? old.map(m => m.seq === replySeq ? reply(content, {}, true) : m) : [...old, reply(content, {}, true)]);
    }, { reducedMotion: window.matchMedia('(prefers-reduced-motion: reduce)').matches });
    revealRef.current = reveal;
    const displayController = new AbortController(); displayConnection.current = displayController;
    let finishReveal: Promise<void> = Promise.resolve();
    try {
      await chatStream({ text, conversationId: conversationId || undefined, agentId: agentId || undefined, useKnowledge, model_reasoning_effort: effort === undefined ? model_reasoning_effort : effort, reviewMode: independentReview ? 'independent' : 'off', delegationMode: allowDelegation ? 'auto' : 'off', targetBinding: targetBinding || undefined, requestKey }, event => {
        if (!mounted.current) return;
        if (event.type === 'execution' && event.runId) { acceptedRun.current = event.runId; setRunId(event.runId); setProgress('问题已受理，正在处理…'); }
        if (event.type === 'session' && event.id) { cid = event.id; sendingId.current = cid; selectConversation(cid); }
        if (cid && currentId.current && currentId.current !== cid) return;
        if (event.type === 'progress') {
          if (!event.text?.includes('重新连接')) { resumed(); activeProgress = event.text || '正在处理…'; }
          setProgress(event.text || '');
        }
        if (event.type === 'model_retry' && event.phase && event.attempt && event.maxAttempts && event.reason && ['connection', 'timeout', 'rate_limit', 'service_unavailable'].includes(event.reason)) {
          pendingRetry = { phase: event.phase, attempt: event.attempt, maxAttempts: event.maxAttempts, delayMs: event.delayMs || 0, reason: event.reason as ModelRetry['reason'], timeoutKind: event.timeoutKind, timeoutSeconds: event.timeoutSeconds };
          setRetry({ ...pendingRetry, receivedAt: Date.now() });
        }
        if (event.type === 'trace' && event.trace?.version === 1) setLiveTrace(event.trace);
        if (!independentReview && event.type === 'message_start' && event.streamId) { streamId = event.streamId; if (event.reason !== 'retry') clearDraft(); }
        if (event.type === 'message_reset' && event.streamId === streamId) {
          streamId = '';
          if (event.reason === 'retry' || event.reason === 'display_disconnect') {
            reveal.restart();
            setMessages(old => old.map(m => m.seq === replySeq ? { ...m, recovering: true } : m));
          } else { resumed(); clearDraft(); }
        }
        if (!independentReview && event.type === 'message_delta' && streamId && event.streamId === streamId && event.text) {
          resumed();
          reveal.append(event.text);
        }
        if (event.type === 'done' && typeof event.text === 'string') {
          streamId = ''; pendingRetry = null; setRetry(null);
          if (!cid && event.conversationId) { cid = event.conversationId; sendingId.current = cid; selectConversation(cid); }
          const publish = () => {
            if (mounted.current && (!cid || !currentId.current || currentId.current === cid)) {
              setMessages(old => [...old.filter(m => m.seq !== replySeq), reply(event.text!, event.metadata)]);
              // Replace the live trace in the same render as the final message.
              setLiveTrace(null);
            }
          };
          if (independentReview) publish();
          else finishReveal = reveal.finish(event.text).then(publish);
        }
        if (event.type === 'error') {
          streamId = ''; pendingRetry = null; setRetry(null); clearDraft();
          if (cancelRequested.current && /取消/.test(event.error || '')) setNotice('已停止生成，可继续提问');
          else setError(event.error || '执行失败');
        }
      }, displayController.signal);
      await finishReveal;
    } catch (e) { if (mounted.current) { clearDraft(); setError(errorText(e)); } }
    finally {
      reveal.dispose();
      if (mounted.current) {
        if (cid && (!currentId.current || currentId.current === cid)) {
          try { const c = await api<Conversation>(`/conversations/${cid}`); if (mounted.current && (!currentId.current || currentId.current === cid)) { setMessages(c.messages || []); setLiveTrace(null); } } catch (e) { if (mounted.current) setError(errorText(e)); }
        }
        // A disconnected stream is only a transient observation, not a saved history snapshot.
        busyRef.current = false; acceptedRun.current = ''; setRunId(''); setRetry(null); setStopping(false);
        setLiveTrace(null); setBusy(false); setProgress(''); sendingId.current = null; refresh();
      }
    }
  };
  const runStatus = busy ? <ChatRunStatus text={progress || '正在处理…'} startedAt={startedAt} retry={retry} stopping={stopping} /> : null;
  return <div ref={page} className={`chat-page${messages.length === 0 ? ' is-empty' : ''}`}>{messages.length === 0 ? <div className="chat-welcome"><div className="welcome-intro"><BrandMark size={40} /><p className="welcome-name">运维百晓生</p><h1>今天想解决什么问题？</h1><p>从排障思路到巡检报告，一起理清下一步。</p>{!configured && <Button onClick={settings}>{user.role === 'admin' ? '配置模型后开始对话' : '请联系管理员配置模型'}</Button>}</div><div className="prompt-starters" aria-label="问题示例">{['帮我梳理排障思路', '查找相关运维知识', '整理巡检报告提纲'].map((text, index) => { const Icon = [AlertTriangle, BookOpen, ShieldCheck][index]; return <button key={text} onClick={() => { setDraft(text); input.current?.focus(); }}><Icon size={16} aria-hidden="true" /><span>{text}</span><ChevronRight size={14} aria-hidden="true" /></button>; })}</div><div className="welcome-links"><button onClick={customize}>定制运维 Skill<ChevronRight size={12} /></button><button onClick={guide}>AgentScope 入门<ChevronRight size={12} /></button></div></div> : <div className="messages-area"><div className="messages" role="region" tabIndex={-1} aria-label="对话消息" onScroll={e => { const box = e.currentTarget; follow.current = box.scrollHeight - box.scrollTop - box.clientHeight < 80; setShowLatest(!follow.current); }}>{messages.map(m => <div key={m.seq} className={`message ${m.role}${m.streaming ? ' streaming' : ''}`} aria-busy={m.streaming || undefined}><div className="message-avatar">{m.role === 'user' ? user.name.slice(0, 1) : <BrandMark />}</div><div className="message-body">{m.streaming && runStatus}{!m.streaming && m.metadata.executionTrace?.finishedAt && <div className="chat-run-completed">已处理 {formatRunElapsed(m.metadata.executionTrace.durationMs)}</div>}{m.role === 'assistant' && <strong>运维百晓生 <Badge>{m.metadata.model || model}</Badge>{m.metadata.model_reasoning_effort && <Badge>{effortOptions.find(option => option.value === m.metadata.model_reasoning_effort)?.label}</Badge>}</strong>}{m.role === 'error' ? <p className="inline-error">{m.content}</p> : <Markdown text={m.content} />}{m.streaming && <span className="streaming-label"><span className="streaming-cursor" aria-hidden="true" />{m.recovering ? (retry ? '已保留生成内容，正在重新连接…' : '已保留生成内容，连接已恢复，正在恢复完整答复…') : '正在生成，内容尚未完成'}</span>}{!!m.metadata.sources?.length && <div className="message-sources"><BookOpen size={12} />{[...new Set(m.metadata.sources.map(s => s.title))].map(t => <Badge tone="blue" key={t}>{t}</Badge>)}</div>}{m.metadata.tools?.map((t, i) => <div className="tool-trace" key={i}>{t.isError ? '⚠' : '✓'} {t.service} / {t.tool}</div>)}{!!m.metadata.mcpFailures?.length && <aside className="mcp-failures" aria-label="本轮数据源缺口"><div className="mcp-failures-title"><AlertTriangle size={15} aria-hidden="true" /><strong>未取得实时数据</strong></div><ul>{m.metadata.mcpFailures.map(f => <li key={f.resourceId}><strong>{f.service}</strong><p>{f.message}</p></li>)}</ul></aside>}{!!m.metadata.context?.omittedMessages && <p className="context-omission">本轮省略了 {m.metadata.context.omittedMessages} 条较早消息；关键对象和范围请在当前问题中补全。</p>}{m.metadata.agentDelegation?.version === 1 && m.metadata.agentDelegation.mode === 'auto' && <p className="context-omission delegation-summary">{delegationSummary(m.metadata.agentDelegation)}</p>}{m.metadata.executionTrace?.version === 1 && <ExecutionPanorama trace={m.metadata.executionTrace} open={false} onOpenChange={() => setPanoramaRunId(m.metadata.executionTrace!.runId)} />}{m.metadata.agentReview?.version === 1 && <AgentReview review={m.metadata.agentReview} runId={m.metadata.runId || String(m.seq)} />}{m.metadata.evidenceReport?.version === 1 && <EvidenceReport report={m.metadata.evidenceReport} />}</div></div>)}{busy && !messages.some(m => m.streaming) && <div className="chat-run-pending">{runStatus}</div>}{liveTrace && <ExecutionPanorama trace={liveTrace} live={busy} open={false} onOpenChange={() => setPanoramaRunId(liveTrace.runId)} />}<div ref={end} /></div>{showLatest && <button type="button" className="jump-latest" onClick={latest}><ArrowDown size={14} aria-hidden="true" />返回最新消息</button>}</div>}
  <div className="composer-wrap">{notice && <div className="chat-notice" role="status">{notice}</div>}{error && <div className="inline-error" role="alert">{error}</div>}{owner !== user.id ? <div className="info-strip">当前是其他用户的会话，仅供管理查看。</div> : <><TargetBindingControl key={agentId} resources={resources} agentId={agentId} user={user} value={targetBinding} onChange={setTargetBinding} disabled={busy} /><div className="composer"><div className="composer-features"><button type="button" role="switch" aria-label="启用知识检索" aria-checked={useKnowledge} disabled={busy} className={`composer-toggle${useKnowledge ? ' enabled' : ''}`} title="仅检索你已获授权的知识内容" onClick={() => setUseKnowledge(!useKnowledge)}><BookOpen size={13} aria-hidden="true" /><span>知识检索</span>{useKnowledge && <Check size={12} aria-hidden="true" />}</button><button type="button" role="switch" aria-label="独立复核" aria-describedby="independent-review-help" aria-checked={independentReview} disabled={busy} className={`composer-toggle${independentReview ? ' enabled' : ''}`} title="开启后，本轮增加一次模型调用和等待时间" onClick={() => setIndependentReview(!independentReview)}><ShieldCheck size={13} aria-hidden="true" /><span>独立复核</span>{independentReview && <Check size={12} aria-hidden="true" />}</button><span id="independent-review-help" className="agent-picker-hint">开启后，本轮增加一次模型调用和等待时间</span><button type="button" role="switch" aria-label="允许委派" aria-describedby="delegation-help" aria-checked={allowDelegation} disabled={busy} className={`composer-toggle${allowDelegation ? ' enabled' : ''}`} title="允许主 Agent 按需委派给已授权 Agent；子任务仅能只读查询，会增加模型调用" onClick={() => setAllowDelegation(!allowDelegation)}><GitBranch size={13} aria-hidden="true" /><span>允许委派</span>{allowDelegation && <Check size={12} aria-hidden="true" />}</button><span id="delegation-help" className="agent-picker-hint">允许主 Agent 按需委派给已授权 Agent；子任务仅能只读查询，会增加模型调用。可在本轮全景查看父子节点和处理依赖。</span></div>{attachment && <div className="attachment"><Paperclip size={12} />{attachment.name}<button aria-label="移除附件" onClick={() => setAttachment(null)}><X size={12} /></button></div>}<textarea ref={input} rows={2} aria-label="输入你的问题" placeholder={configured ? '描述问题，或补充你想了解的细节…' : '请先配置模型服务…'} value={draft} onChange={e => setDraft(e.target.value)} onKeyDown={e => { if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) { e.preventDefault(); if (configured) void send(); } }} /><div className="composer-bottom"><button className="icon-button" aria-label="添加文本附件" onClick={() => file.current?.click()}><Paperclip size={16} /></button><input hidden ref={file} type="file" accept=".txt,.md,.json,.log,.yaml,.yml" onChange={async e => { const f = e.target.files?.[0]; if (!f) return; if (f.size > 60000) { setError('文本附件不能超过 60 KB'); return; } setAttachment({ name: f.name, text: await f.text() }); e.target.value = ''; }} /><div className="chat-options"><AgentSelector resources={resources} value={agentId} onChange={id => { setAgentId(id); setTargetBinding(null); }} locked={!!conversationId} busy={busy} /><ReasoningEffortControl value={effort} defaultEffort={model_reasoning_effort} onChange={setEffort} disabled={busy} /><span className="model-choice"><Bot size={13} /><span className="model-label" title={model}>{model || '尚未配置模型'}</span></span></div>{busy ? <button type="button" className="composer-action chat-stop" aria-label={stopping ? '正在停止生成' : '停止生成'} title={stopping ? '正在停止生成' : runId ? '停止生成' : '等待问题受理后可停止'} disabled={!runId || stopping} onClick={() => void stop()}><Square size={13} fill="currentColor" aria-hidden="true" /></button> : <button type="button" className="composer-action send" aria-label="发送消息" title="发送消息" disabled={!draft.trim() || !configured} onClick={() => void send()}><ArrowUp size={20} aria-hidden="true" /></button>}</div></div><div className="composer-tip">{busy ? (independentReview ? '复核完成后显示答复，可先编辑下一条问题' : '生成期间可先编辑下一条问题') : 'Enter 发送，Shift + Enter 换行 · 文本附件会作为消息内容发送给模型'}</div></>}</div>{selectedTrace && <ExecutionPanorama trace={selectedTrace} live={busy && liveTrace?.runId === selectedTrace.runId} open hideEntry onOpenChange={next => { if (!next) closePanorama(); }} />}</div>;
}
