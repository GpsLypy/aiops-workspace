import { useEffect, useState, type FormEvent } from 'react';
import { api, post, errorText, type User } from '../api';
import { Button } from './ui';
import { createRequestKey } from '../request-id';

type Runbook = { id: string; name: string; owner_id: string; revision: number; publication: string; data: unknown };
export default function Runbooks({ user }: { user: User }) {
  const [items, setItems] = useState<Runbook[]>([]); const [error, setError] = useState(''); const [busy, setBusy] = useState(false);
  const refresh = () => api<Runbook[]>('/runbooks').then(setItems);
  useEffect(() => { void refresh().catch(e => setError(errorText(e))); }, []);
  const action = async (path: string, body: unknown) => { setBusy(true); setError(''); try { await post(path, body); await refresh(); } catch (e) { setError(errorText(e)); } finally { setBusy(false); } };
  const executeRunbook = (item: Runbook) => {
    try { void action(`/runbooks/${item.id}/run`, { requestKey: createRequestKey() }); }
    catch (error) { setError(errorText(error)); }
  };
  const create = (e: FormEvent<HTMLFormElement>) => { e.preventDefault(); const f = new FormData(e.currentTarget); try { void action('/runbooks', { name: f.get('name'), description: f.get('description'), steps: JSON.parse(String(f.get('steps'))) }); } catch { setError('步骤 JSON 无效'); } };
  return <details className="detail-card"><summary>标准 Runbook 与告警自动处置</summary><p>固定工具和参数，另一位管理员审核后可执行。变更工具须明确允许自动处置，并启用部署开关；高风险操作仍需逐次审批。</p>{error && <p className="inline-error" role="alert">{error}</p>}<form onSubmit={create}><label>名称<input name="name" required maxLength={100} /></label><label>用途与适用条件<input name="description" maxLength={2000} /></label><label>固定步骤（JSON 数组，最多 8 步）<textarea name="steps" rows={7} required defaultValue={'[\n  {"resourceId":"填写 MCP 资源 ID", "tool":"service_status", "arguments":{"service":"billing"}, "environment":"test"}\n]'} /></label><Button disabled={busy} type="submit">保存待审核 Runbook</Button></form>{items.map(item => <section key={item.id} className="execution-step"><strong>{item.name} · {item.publication} · v{item.revision}</strong><p className="execution-id">{item.id}</p><details><summary>审阅完整计划</summary><pre>{JSON.stringify(item.data, null, 2)}</pre></details><div className="list-actions">{item.publication === 'draft' && <Button disabled={busy || item.owner_id === user.id} onClick={() => void action(`/runbooks/${item.id}/publish`, { revision: item.revision })}>审核发布</Button>}{item.publication === 'published' && <><Button disabled={busy} onClick={() => executeRunbook(item)}>执行固定流程</Button><Button disabled={busy} onClick={() => void action(`/runbooks/${item.id}/disable`, {})}>撤销流程</Button></>}</div></section>)}</details>;
}
