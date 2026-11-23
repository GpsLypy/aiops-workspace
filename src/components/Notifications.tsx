import { useEffect, useState, type FormEvent } from 'react';
import { Bell, Plus, RotateCw, Send, ArrowUpRight, CheckCircle2, AlertCircle, Clock3 } from 'lucide-react';
import { api, post, put, dateText, errorText, type User, type NotificationChannel, type Delivery } from '../api';
import { Badge, Button, Empty, Modal } from './ui';

export const deliveryLabels: Record<string, string> = { pending: '待发送 / 重试中', sending: '发送中', delivered: '已送达', failed: '发送失败' };
export const assessmentLabels: Record<string, string> = { healthy: '正常', abnormal: '异常', unknown: '无法判断' };
export function DeliveryBadge({ status }: { status: string }) { return <Badge tone={status === 'delivered' ? 'green' : status === 'failed' ? 'orange' : 'blue'}>{deliveryLabels[status] || status}</Badge>; }

function ChannelEditor({ channel, members, close, saved }: { channel: NotificationChannel | null; members: User[]; close: () => void; saved: () => void }) {
  const [kind, setKind] = useState(channel?.kind || 'wecom'); const [allowed, setAllowed] = useState(channel?.allowedUserIds || []);
  const [busy, setBusy] = useState(false); const [error, setError] = useState('');
  async function submit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault(); setBusy(true); setError(''); const form = new FormData(e.currentTarget);
    try {
      const data = { name: form.get('name'), kind, endpoint: form.get('endpoint') || undefined, secret: form.get('secret') || undefined, token: form.get('token') || undefined, clearCredentials: form.get('clearCredentials') === 'on', allowedUserIds: allowed, enabled: form.get('enabled') === 'on', revision: channel?.revision };
      if (channel) await put(`/notification-channels/${channel.id}`, data); else await post('/notification-channels', data);
      saved();
    } catch (e) { setError(errorText(e)); } finally { setBusy(false); }
  }
  return <Modal title={channel ? '编辑通知渠道' : '创建通知渠道'} onClose={close} wide><form className="notification-form" onSubmit={e => void submit(e)}>{error && <p className="inline-error" role="alert">{error}</p>}
    <div className="notification-form-grid"><label>渠道名称<input name="name" required maxLength={100} placeholder="例如：DTS 运维群" defaultValue={channel?.name} /></label><label>渠道类型<select value={kind} onChange={e => setKind(e.target.value as NotificationChannel['kind'])}><option value="wecom">企业微信群机器人</option><option value="webhook">通用 Webhook</option></select></label></div>
    <label>{kind === 'wecom' ? '机器人 Webhook 地址' : '接收地址'}<input name="endpoint" type="url" required={!channel} autoComplete="off" placeholder={channel ? '留空保留已保存地址' : 'https://…'} /></label>
    {channel?.endpointOrigin && <p className="notification-hint">已保存至 {channel.endpointOrigin}，完整地址和密钥不回显。</p>}
    {kind === 'webhook' && <><div className="notification-form-grid"><label>签名密钥（可选）<input type="password" name="secret" autoComplete="new-password" minLength={32} placeholder={channel?.hasSecret ? '已配置，留空保留' : '至少 32 个字符'} /></label><label>Bearer Token（可选）<input type="password" name="token" autoComplete="new-password" placeholder={channel?.hasToken ? '已配置，留空保留' : '接收方要求的令牌'} /></label></div>{channel && <label className="notification-checkbox"><input type="checkbox" name="clearCredentials" />清除已保存的签名密钥和 Token</label>}</>}
    <fieldset className="channel-options"><legend>允许使用的成员</legend><p className="notification-hint">管理员始终可用。指定成员可以将自己的任务结果发送到此渠道，请确认群组适合接收这些信息。</p>{members.filter(u => u.role !== 'admin' && u.active).map(user => <label key={user.id}><input type="checkbox" checked={allowed.includes(user.id)} onChange={e => setAllowed(e.target.checked ? [...allowed, user.id] : allowed.filter(id => id !== user.id))} />{user.name}（{user.username}）</label>)}{!members.some(u => u.role !== 'admin' && u.active) && <p>当前没有可授权的普通成员。</p>}</fieldset>
    <label className="notification-checkbox"><input name="enabled" type="checkbox" defaultChecked={channel?.enabled ?? true} />启用此渠道</label>
    {channel && <p className="notification-hint">保存后，尚未发送的旧消息会停止并提示配置已变更。核对后可在记录中重新发送。</p>}
    <div className="modal-footer"><Button type="button" onClick={close}>取消</Button><Button primary disabled={busy}>{busy ? '保存中…' : '保存渠道'}</Button></div>
  </form></Modal>;
}

export default function Notifications({ user }: { user: User }) {
  const [tab, setTab] = useState<'records' | 'channels'>('records'); const [channels, setChannels] = useState<NotificationChannel[]>([]); const [members, setMembers] = useState<User[]>([]);
  const [records, setRecords] = useState<Delivery[]>([]); const [total, setTotal] = useState(0); const [page, setPage] = useState(1); const [filter, setFilter] = useState('all');
  const [editor, setEditor] = useState<NotificationChannel | 'new' | null>(null); const [detailId, setDetailId] = useState<string | null>(new URLSearchParams(location.hash.split('?')[1]).get('delivery')); const [detail, setDetail] = useState<Delivery | null>(null);
  const [error, setError] = useState(''); const [message, setMessage] = useState(''); const [busy, setBusy] = useState(false); const [loading, setLoading] = useState(true);
  async function refresh() {
    try {
      const [c, r] = await Promise.all([api<NotificationChannel[]>('/notification-channels'), api<{ items: Delivery[]; total: number }>(`/notification-deliveries?page=${page}&status=${filter}`)]);
      setChannels(c); setRecords(r.items); setTotal(r.total);
      if (detailId) setDetail(await api<Delivery>(`/notification-deliveries/${detailId}`));
      setError('');
    } catch (e) { setError(errorText(e)); } finally { setLoading(false); }
  }
  useEffect(() => { void refresh(); const timer = setInterval(() => void refresh(), 5000); return () => clearInterval(timer); }, [page, filter, detailId]);
  useEffect(() => { if (user.role === 'admin') void api<User[]>('/users').then(setMembers).catch(e => setError(errorText(e))); }, [user.role]);
  async function action(fn: () => Promise<void>) { setBusy(true); setError(''); setMessage(''); try { await fn(); await refresh(); } catch (e) { setError(errorText(e)); } finally { setBusy(false); } }
  const retry = (id: string) => action(async () => { await post(`/notification-deliveries/${id}/retry`); setMessage('已重新加入发送队列，原巡检不会重新执行。'); });
  return <div className="notification-center">
    <div className="notification-heading"><div className="notification-heading-icon"><Bell size={22} /></div><div><h1>通知中心</h1><p>将巡检结果发送到值班群或业务系统，跟踪每一次送达。</p></div>{user.role === 'admin' && <Button primary onClick={() => setEditor('new')}><Plus size={14} />创建通知渠道</Button>}</div>
    <div className="tabs" role="tablist" aria-label="通知中心视图" onKeyDown={e => { if (["ArrowLeft", "ArrowRight", "Home", "End"].includes(e.key)) { e.preventDefault(); const next = e.key === "Home" ? "records" : e.key === "End" ? "channels" : tab === "records" ? "channels" : "records"; setTab(next); document.getElementById(`notification-tab-${next}`)?.focus(); } }}><button id="notification-tab-records" role="tab" tabIndex={tab === 'records' ? 0 : -1} aria-controls="notification-tabpanel" aria-selected={tab === 'records'} className={tab === 'records' ? 'active' : ''} onClick={() => setTab('records')}>推送记录</button><button id="notification-tab-channels" role="tab" tabIndex={tab === 'channels' ? 0 : -1} aria-controls="notification-tabpanel" aria-selected={tab === 'channels'} className={tab === 'channels' ? 'active' : ''} onClick={() => setTab('channels')}>通知渠道 <span>{channels.length}</span></button></div>
    {error && <p className="inline-error" role="alert">{error}</p>}{message && <p className="inline-success" role="status">{message}</p>}
    <div id="notification-tabpanel" role="tabpanel" aria-labelledby={`notification-tab-${tab}`}>{tab === 'records' ? <><div className="notification-toolbar"><label>投递状态<select aria-label="投递状态" value={filter} onChange={e => { setFilter(e.target.value); setPage(1); }}><option value="all">全部状态</option>{Object.entries(deliveryLabels).map(([key, label]) => <option key={key} value={key}>{label}</option>)}</select></label><span>共 {total} 条 · 每 5 秒刷新</span><Button onClick={() => void refresh()}><RotateCw size={13} />刷新</Button></div>
      <div className="notification-records">{records.map(record => <article className={`notification-record ${record.status}`} key={record.id}><div className="delivery-symbol" aria-hidden="true">{record.status === 'delivered' ? <CheckCircle2 size={19} /> : record.status === 'failed' ? <AlertCircle size={19} /> : <Clock3 size={19} />}</div><div className="notification-record-main"><div className="notification-record-title"><strong>{record.title}</strong><DeliveryBadge status={record.status} /></div><p>{record.channel_name} · {record.channel_kind === 'wecom' ? '企业微信' : 'Webhook'}{record.assessmentStatus && ` · 巡检${assessmentLabels[record.assessmentStatus]}`}</p><small>{dateText(record.created)} · 本轮尝试 {record.attempts} 次</small>{record.last_error && <p className="delivery-error">{record.last_error}{record.status === 'pending' && `，下次重试 ${dateText(new Date(record.next_attempt).toISOString())}`}</p>}</div><div className="row-actions"><button className="text-button" onClick={() => { setDetail(null); setDetailId(record.id); }}>查看详情</button>{record.status === 'failed' && <button className="text-button" disabled={busy} onClick={() => void retry(record.id)}>重新发送</button>}</div></article>)}{!records.length && <Empty text={loading ? '正在加载推送记录…' : filter !== 'all' ? '没有此状态的推送记录' : '暂无推送。创建通知渠道后，在定时任务中选择发送渠道。'} />}</div>
      <div className="pagination"><Button disabled={page <= 1} onClick={() => setPage(page - 1)}>上一页</Button><span>{page} / {Math.max(1, Math.ceil(total / 30))}</span><Button disabled={page * 30 >= total} onClick={() => setPage(page + 1)}>下一页</Button></div>
    </> : <><p className="notification-hint">任务可以发送到多个渠道。成员只看到获准使用的渠道，停用后停止新消息发送。</p><div className="notification-channel-grid">{channels.map(channel => <article className="notification-channel-card" key={channel.id}><div className="notification-record-title"><strong>{channel.name}</strong><Badge tone={channel.enabled ? 'green' : ''}>{channel.enabled ? '已启用' : '已停用'}</Badge></div><p>{channel.kind === 'wecom' ? '企业微信群机器人' : '通用 Webhook'}</p>{channel.endpointOrigin && <code>{channel.endpointOrigin}</code>}<small>{channel.allowedUserIds ? `管理员及 ${channel.allowedUserIds.length} 位指定成员可用` : '已获授权'} · 更新于 {dateText(channel.updated)}</small>{user.role === 'admin' && <div className="row-actions"><Button onClick={() => setEditor(channel)}>编辑渠道</Button><Button disabled={busy || !channel.enabled} onClick={() => void action(async () => { const result = await post<{ deliveryId: string }>(`/notification-channels/${channel.id}/test`); setDetail(null); setDetailId(result.deliveryId); setTab('records'); setMessage('测试消息已加入队列，请查看实际投递状态。'); })}><Send size={12} />发送测试消息</Button></div>}</article>)}</div>{!channels.length && <Empty text={user.role === 'admin' ? '创建第一个通知渠道，连接企业微信群或 Webhook 接收端。' : '暂无可用渠道，请联系管理员授权。'} />}</>}
    </div>
    {editor && <ChannelEditor channel={editor === 'new' ? null : editor} members={members} close={() => setEditor(null)} saved={() => { setEditor(null); setTab('channels'); setMessage('通知渠道已保存，可发送测试消息确认送达。'); void refresh(); }} />}
    {detailId && <Modal title="推送详情" onClose={() => { setDetailId(null); setDetail(null); }} wide><div className="modal-content">{detail ? <><div className="notification-record-title"><strong>{detail.title}</strong><DeliveryBadge status={detail.status} /></div><div className="delivery-facts"><span>渠道：{detail.channel_name}</span><span>本轮尝试：{detail.attempts} 次</span><span>创建：{dateText(detail.created)}</span><span>送达：{dateText(detail.delivered_at)}</span></div>{detail.last_error && <p className="inline-error">{detail.last_error}</p>}{detail.next_attempt > 0 && <p>下次重试：{dateText(new Date(detail.next_attempt).toISOString())}</p>}<p className="notification-hint">已送达表示接收端已确认接收；群机器人不提供成员已读确认。</p><pre className="notification-preview">{detail.preview}</pre><div className="modal-footer">{detail.task_id && <a className="button" href={`#tasks?task=${encodeURIComponent(detail.task_id)}&run=${encodeURIComponent(detail.task_run_id || '')}`}><ArrowUpRight size={13} />查看巡检记录</a>}{detail.status === 'failed' && <Button primary disabled={busy} onClick={() => void retry(detail.id)}>重新发送</Button>}</div></> : <p role="status">{error || '正在加载消息详情…'}</p>}</div></Modal>}
  </div>;
}
