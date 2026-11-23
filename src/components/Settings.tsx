import { useEffect, useState, type FormEvent } from 'react';
import { api, post, put, patch, errorText, dateText, type User, type ModelConfig } from '../api';
import { Badge, Button, Modal } from './ui';
import RuntimeRollout from './RuntimeRollout';

export default function Settings({ user, close, changed, logout }: { user: User; close: () => void; changed: () => void; logout: () => void }) {
  const [tab, setTab] = useState(user.role === 'admin' ? 'model' : 'account');
  const [model, setModel] = useState<ModelConfig | null>(null);
  const [users, setUsers] = useState<User[]>([]);
  const [audit, setAudit] = useState<{ seq: number; user_name: string; action: string; target: string; created: string; detail: unknown }[]>([]);
  const [message, setMessage] = useState(''); const [error, setError] = useState(''); const [busy, setBusy] = useState(false);
  const [loading, setLoading] = useState(user.role === 'admin');
  const load = async () => {
    setLoading(user.role === 'admin' && ['model', 'users', 'audit'].includes(tab));
    try {
      if (user.role === 'admin') {
        if (tab === 'model') setModel(await api<ModelConfig>('/settings/model'));
        if (tab === 'users') setUsers(await api<User[]>('/users'));
        if (tab === 'audit') setAudit(await api('/audit'));
      }
    } catch (e) { setError(errorText(e)); }
    finally { setLoading(false); }
  };
  useEffect(() => { setError(''); setMessage(''); void load(); }, [tab]);
  const action = async (fn: () => Promise<unknown>, success: string) => { setBusy(true); setError(''); setMessage(''); try { await fn(); setMessage(success); changed(); await load(); } catch (e) { setError(errorText(e)); } finally { setBusy(false); } };
  const saveModel = (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault(); const data = Object.fromEntries(new FormData(e.currentTarget));
    const idleTimeout = Number(data.streamIdleTimeoutSeconds);
    if ((!model?.reasoningEffortOnly || model.timeoutSettingsEnabled) && (!Number.isSafeInteger(idleTimeout) || (idleTimeout !== 0 && (idleTimeout < 60 || idleTimeout > 600)))) {
      setError('流式静默超时请输入 0，或 60 至 600 之间的整数');
      return;
    }
    void action(() => put('/settings/model', model?.reasoningEffortOnly ? { model_reasoning_effort: data.model_reasoning_effort || null,
      ...(model.timeoutSettingsEnabled ? { firstByteTimeoutSeconds: Number(data.firstByteTimeoutSeconds), streamIdleTimeoutSeconds: idleTimeout } : {}) } : { baseUrl: data.baseUrl, model: data.model, apiType: 'responses', model_reasoning_effort: data.model_reasoning_effort || null, temperature: data.temperature === '' ? null : Number(data.temperature), firstByteTimeoutSeconds: Number(data.firstByteTimeoutSeconds), streamIdleTimeoutSeconds: idleTimeout, ...(data.apiKey ? { apiKey: data.apiKey } : {}), ...(data.clearKey ? { apiKey: '' } : {}) }), '模型配置已保存');
  };
  const createUser = (e: FormEvent<HTMLFormElement>) => { e.preventDefault(); const form = e.currentTarget; const data = Object.fromEntries(new FormData(form)); void action(async () => { await post('/users', data); form.reset(); }, '用户已创建'); };
  const password = (e: FormEvent<HTMLFormElement>) => { e.preventDefault(); const form = e.currentTarget; const data = Object.fromEntries(new FormData(form)); void action(async () => { await post('/auth/password', data); form.reset(); }, '密码已修改，其他登录会话已失效'); };
  return <Modal title="工作空间设置" onClose={close} wide className="settings-modal" overlayClassName="settings-overlay"><div className="settings-tabs tabs">{(user.role === 'admin' ? [['model', '模型服务'], ['rollout', 'Agent 增强'], ['users', '用户管理'], ['audit', '审计日志'], ['account', '我的账号']] : [['account', '我的账号']]).map(([id, text]) => <button className={tab === id ? 'active' : ''} key={id} onClick={() => setTab(id)}>{text}</button>)}</div><div className="settings-content">{loading && <p className="settings-loading" role="status">正在加载设置…</p>}{error && <div className="inline-error" role="alert">{error}</div>}{message && <div className="inline-success" role="status">{message}</div>}
  {tab === 'model' && model && <form onSubmit={saveModel}>
    {model.reasoningEffortOnly && <p className="form-note">本沙箱可保存默认问答强度{model.timeoutSettingsEnabled ? '和流式超时' : ''}；模型连接由部署配置管理。</p>}
    <p className="form-note">使用 Responses API。地址填到 /v1 等 API 前缀，系统追加 /responses。请先保存，再测试连接。</p>
    <label>API Base URL<input name="baseUrl" readOnly={model.reasoningEffortOnly} type="url" required defaultValue={model.baseUrl} placeholder="https://your-provider.example.com/v1" /></label>
    <label>模型名称<input name="model" readOnly={model.reasoningEffortOnly} required defaultValue={model.model} placeholder="服务商提供的准确模型 ID" /></label>
    <label>API Key<input name="apiKey" disabled={model.reasoningEffortOnly} type="password" autoComplete="new-password" placeholder={model.hasApiKey ? '已加密保存，留空保持不变' : '本地无认证服务可留空'} /></label>
    {model.hasApiKey && !model.reasoningEffortOnly && <label className="check-row"><input type="checkbox" name="clearKey" />清除已有 API Key</label>}
    <label>默认问答强度<select name="model_reasoning_effort" defaultValue={model.model_reasoning_effort ?? ''}><option value="">服务商默认（不发送强度参数）</option><option value="low">快速 · 优先响应速度</option><option value="medium">均衡 · 平衡速度和回答质量</option><option value="high">深度 · 优先分析质量</option></select></label>
    <p className="form-note">聊天可单独选择强度；定时任务与连接测试使用这里的默认值。模型不支持推理强度时请选择服务商默认。</p>
    <label>Temperature（留空使用服务商默认值）<input name="temperature" readOnly={model.reasoningEffortOnly} type="number" min="0" max="2" step="0.1" defaultValue={model.temperature ?? ''} /></label>
    <p className="form-note">模型不支持 temperature 参数时请留空。</p>
    <section className="timeout-settings" aria-labelledby="timeout-settings-title"><h3 id="timeout-settings-title">超时配置</h3><div className="timeout-settings-grid">
      <label>流式首字节超时<input name="firstByteTimeoutSeconds" type="number" min="1" max="120" step="1" required readOnly={model.reasoningEffortOnly && !model.timeoutSettingsEnabled} defaultValue={model.firstByteTimeoutSeconds} /><span>等待首个数据块的最长时间，范围 1–120 秒，默认 90 秒。</span></label>
      <label>流式静默超时<input name="streamIdleTimeoutSeconds" type="number" min="0" max="600" step="1" required readOnly={model.reasoningEffortOnly && !model.timeoutSettingsEnabled} defaultValue={model.streamIdleTimeoutSeconds} /><span>收到数据后允许的最大间隔，范围 60–600 秒；填 0 禁用。</span></label>
    </div></section>
    <div className="modal-footer"><Button type="button" disabled={busy || !model.configured || model.reasoningEffortOnly} onClick={() => void action(async () => { const r = await post<{ text: string; elapsedMs: number }>('/settings/model/test'); setMessage(`连接成功 (${r.elapsedMs} ms)：${r.text}`); }, '模型连接测试成功')}>测试已保存配置</Button><Button primary disabled={busy} type="submit">{busy ? '处理中…' : '保存模型配置'}</Button></div>
  </form>}
  {tab === 'rollout' && user.role === 'admin' && <RuntimeRollout />}
  {tab === 'users' && <><div className="settings-user-list">{users.map(u => <div className="user-row" key={u.id}><div><strong>{u.name}</strong><small>{u.username}</small></div><Badge tone={u.role === 'admin' ? 'blue' : ''}>{u.role === 'admin' ? '管理员' : '成员'}</Badge><Badge tone={u.active ? 'green' : ''}>{u.active ? '已启用' : '已停用'}</Badge>{u.id !== user.id && <><Button disabled={busy} onClick={() => void action(() => patch(`/users/${u.id}`, { active: !u.active }), '用户状态已更新')}>{u.active ? '停用' : '启用'}</Button><Button disabled={busy} onClick={() => void action(() => patch(`/users/${u.id}`, { role: u.role === 'admin' ? 'member' : 'admin' }), '角色已更新')}>{u.role === 'admin' ? '设为成员' : '设为管理员'}</Button></>}</div>)}</div><h3>创建用户</h3><form onSubmit={createUser}><div className="form-grid"><label>用户名<input name="username" required pattern="[a-zA-Z0-9_.\-]{3,40}" /></label><label>显示名称<input name="name" required /></label></div><div className="form-grid"><label>初始密码<input type="password" name="password" required minLength={12} /></label><label>角色<select name="role"><option value="member">成员</option><option value="admin">管理员</option></select></label></div><div className="modal-footer"><Button primary disabled={busy}>创建用户</Button></div></form></>}
  {tab === 'audit' && <div className="audit-list"><p className="form-note">最近 200 条事件。密钥、密码和工具参数不会写入审计日志。</p>{audit.map(a => <div className="audit-row" key={a.seq}><strong>{a.action}</strong><span>{a.user_name || '系统'}</span><small>{dateText(a.created)}</small><code>{a.target}</code></div>)}</div>}
  {tab === 'account' && <><div className="profile"><span className="avatar">{user.name.slice(0, 1)}</span><div><h2>{user.name}</h2><p>{user.username} · {user.role === 'admin' ? '管理员' : '成员'}</p></div><Button onClick={logout}>退出登录</Button></div><form onSubmit={password}><h3>修改密码</h3><label>当前密码<input name="currentPassword" type="password" required autoComplete="current-password" /></label><label>新密码<input name="password" type="password" minLength={12} required autoComplete="new-password" /></label><div className="modal-footer"><Button primary disabled={busy}>修改密码</Button></div></form></>}
  </div></Modal>;
}
