import { useEffect, useState } from 'react';
import { api, put, post, errorText, dateText, type AgentRollout, type RolloutDraft } from '../api';
import { Button } from './ui';

const endpoint = '/settings/agent-rollout';
const features = (v: { contextMode: string; retrievalMode: string; evidenceReports: boolean }) => `${v.contextMode === 'budgeted' ? '预算裁剪' : '最近历史'} · ${v.retrievalMode === 'diverse' ? '多文档检索' : '相关性检索'} · 证据报告${v.evidenceReports ? '开' : '关'}`;
export default function RuntimeRollout() {
  const [state, setState] = useState<AgentRollout | null>(null), [draft, setDraft] = useState<RolloutDraft | null>(null);
  const [busy, setBusy] = useState(false), [error, setError] = useState(''), [message, setMessage] = useState('');
  const [clock, setClock] = useState(Date.now());
  const apply = (next: AgentRollout) => { setState(next); setDraft(next.draft); };
  useEffect(() => {
    let mounted = true;
    void api<AgentRollout>(endpoint).then(next => { if (mounted) apply(next); }, e => { if (mounted) setError(errorText(e)); });
    const timer = setInterval(() => setClock(Date.now()), 10000);
    return () => { mounted = false; clearInterval(timer); };
  }, []);
  const action = async (kind: 'save' | 'preflight' | 'activate' | 'pause' | 'refresh') => {
    setBusy(true); setError(''); setMessage('');
    try {
      if (kind === 'refresh') apply(await api<AgentRollout>(endpoint));
      else apply(kind === 'save' ? await put<AgentRollout>(endpoint, { revision: state?.revision, draft }) : await post<AgentRollout>(`${endpoint}/${kind}`, { revision: state?.revision }));
      setMessage({ save: '草稿已保存，当前生效配置未改变', preflight: '本地 SDK 预检通过，可启用已保存草稿', activate: '增强已启用，下一轮开始执行时生效', pause: '增强已暂停，后续对话继续使用 AgentScope 基础配置', refresh: '已重新读取服务器配置' }[kind]);
    } catch (e) { setError(errorText(e)); } finally { setBusy(false); }
  };
  const dirty = !!state && JSON.stringify(draft) !== JSON.stringify(state.draft);
  const change = (fields: Partial<RolloutDraft>) => setDraft(current => current ? { ...current, ...fields } : current);
  const scope = (v: RolloutDraft) => [v.includeGeneral ? '通用 Agent' : '', ...v.agentIds.map(id => state?.agents.find(a => a.id === id)?.name || `${id}（已不可用）`)].filter(Boolean).join('、') || '尚未选择';
  return <section className="runtime-rollout" aria-label="Agent 增强配置">
    {error && <div className="inline-error" role="alert">{error} <Button disabled={busy} onClick={() => void action('refresh')}>重新读取配置</Button></div>}
    {message && <div className="inline-success" role="status">{message}</div>}
    {!state || !draft ? <p className="form-note">正在读取增强配置…</p> : <>
      <div className="rollout-summary">
        <div><small>当前生效</small><strong>{state.mode === 'deployment' ? '使用部署增强配置' : state.mode === 'paused' ? '增强已暂停 · AgentScope 基础配置' : `增强版本 ${state.activeRevision}`}</strong>
          <p>{state.mode === 'active' && state.active ? scope(state.active) : '所有子领域与通用 Agent'}</p>
          <p>{state.mode === 'active' && state.active ? features(state.active) : state.mode === 'paused' ? '最近历史 · 相关性检索 · 证据报告关' : features(state.deployment)}</p>
        </div>
        <div><small>编辑草稿</small><strong>版本 {state.draftRevision}{dirty ? ' · 未保存' : ' · 已保存'}</strong><p>保存草稿后，先预检，再启用。</p><p>配置修订 <code>{state.revision}</code></p></div>
      </div>
      <p className="form-note">所有对话统一使用 AgentScope。此处仅配置历史上下文、知识检索和证据报告，以及应用这些增强的范围。</p>
      <form onSubmit={e => { e.preventDefault(); void action('save'); }}>
        <fieldset disabled={busy} className="rollout-scope"><legend>增强范围</legend>
          <label className="check-row"><input type="checkbox" checked={draft.includeGeneral} onChange={e => change({ includeGeneral: e.target.checked })} />通用 Agent（未选择子领域的对话）</label>
          {state.agents.map(agent => <label className="check-row" key={agent.id}><input type="checkbox" checked={draft.agentIds.includes(agent.id)} disabled={!agent.eligible && !draft.agentIds.includes(agent.id)} onChange={e => change({ agentIds: e.target.checked ? [...draft.agentIds, agent.id].sort() : draft.agentIds.filter(id => id !== agent.id) })} />{agent.name}{!agent.eligible && <small>不可启用增强：请先发布并启用子领域</small>}</label>)}
          {draft.agentIds.filter(id => !state.agents.some(agent => agent.id === id)).map(id => <label className="check-row" key={id}><input type="checkbox" checked onChange={() => change({ agentIds: draft.agentIds.filter(value => value !== id) })} />{id}（已删除，请取消选择）</label>)}
          {!state.agents.length && <p className="form-note">尚无子领域，可先创建并发布。</p>}
        </fieldset>
        <fieldset disabled={busy} className="rollout-scope"><legend>增强选项</legend><div className="form-grid">
          <label>历史上下文<select aria-label="历史上下文" value={draft.contextMode} onChange={e => change({ contextMode: e.target.value as RolloutDraft['contextMode'] })}><option value="recent">最近历史</option><option value="budgeted">按预算保留完整轮次</option></select></label>
          <label>知识片段<select aria-label="知识片段" value={draft.retrievalMode} onChange={e => change({ retrievalMode: e.target.value as RolloutDraft['retrievalMode'] })}><option value="ranked">按相关性排序</option><option value="diverse">优先覆盖不同文档</option></select></label>
        </div><label className="check-row"><input type="checkbox" checked={draft.evidenceReports} onChange={e => change({ evidenceReports: e.target.checked })} />生成本轮证据报告</label></fieldset>
        <p className="form-note">范围外或暂停增强后，AgentScope 使用最近历史、相关性检索并关闭证据报告。修改仅影响后续运行，已开始的运行继续使用原配置。</p>
        <div className="rollout-actions"><Button type="submit" disabled={busy || !dirty}>保存草稿</Button><Button type="button" disabled={busy || dirty || !state.draftRevision} onClick={() => void action('preflight')}>{busy ? '处理中…' : '预检已保存草稿'}</Button><Button primary type="button" disabled={busy || dirty || !state.preflightValid || !state.preflight || Date.parse(state.preflight.expiresAt) <= clock} onClick={() => void action('activate')}>启用增强</Button></div>
      </form>
      <p className="form-note">{state.preflight && state.preflightValid && Date.parse(state.preflight.expiresAt) > clock ? `预检有效至 ${dateText(state.preflight.expiresAt)}` : '当前草稿需要预检。'} 预检仅验证本地 SDK，不代表模型、MCP 或生产验收通过。</p>
      <div className="rollout-footer"><Button disabled={busy || state.mode === 'paused'} onClick={() => void action('pause')}>暂停增强</Button><Button disabled={busy} onClick={() => void action('refresh')}>刷新配置</Button></div>
    </>}
  </section>;
}
