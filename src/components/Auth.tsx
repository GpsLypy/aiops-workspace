import { useEffect, useState, type FormEvent } from 'react';
import { ArrowRight, ShieldCheck } from 'lucide-react';
import { api, post, errorText, type User } from '../api';
import { Button } from './ui';
import BrandMark from './BrandMark';

export default function Auth({ onLogin }: { onLogin: (user: User) => void }) {
  const [status, setStatus] = useState<{ initialized: boolean; authMode: string; setupTokenRequired: boolean } | null>(null);
  const [error, setError] = useState(''); const [busy, setBusy] = useState(false);
  const load = () => api<NonNullable<typeof status>>('/auth/status').then(s => { setStatus(s); setError(''); }).catch(e => setError(errorText(e)));
  useEffect(() => { void load(); }, []);
  const submit = async (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault(); setBusy(true); setError('');
    try { onLogin(await post<User>(status?.initialized ? '/auth/login' : '/auth/setup', Object.fromEntries(new FormData(e.currentTarget)))); }
    catch (e) { setError(errorText(e)); } finally { setBusy(false); }
  };
  return <div className="auth-page"><div className="auth-intro"><div className="auth-logo"><BrandMark size={36} />运维百晓生</div><div className="eyebrow">YOUR AIOPS WORKSPACE</div><h1>从知识到行动，<br />让运维协作更简单。</h1><p>连接知识、技能与远程工具，<br />在一个工作空间管理你的智能运维助手。</p><div className="auth-capabilities"><span>知识管理</span><span>Agent 对话</span><span>受控执行</span><span>审批核验</span></div></div>
    <section className="auth-card"><ShieldCheck size={26} color="#265dff" /><h2>{status?.initialized === false ? '初始化工作空间' : '登录工作空间'}</h2>{error && <div className="inline-error" role="alert">{error}</div>}
      {!status ? <Button onClick={() => void load()}>重新连接服务</Button> : status.initialized && status.authMode === 'gateway' ? <><p>请通过企业身份网关访问，并完成多因素认证。账号还需由工作空间管理员授权。</p><Button onClick={() => api<User>('/auth/me').then(onLogin).catch(e => setError(errorText(e)))}>重新检查企业身份</Button></> : <form onSubmit={submit}>
        <label>用户名<input name="username" required pattern="[a-zA-Z0-9_.\-]{3,40}" autoComplete="username" placeholder="3–40 位字母、数字或 . _ -" /></label>
        {!status.initialized && <label>显示名称<input name="name" required maxLength={60} placeholder="你的名字" /></label>}
        {!status.initialized && status.setupTokenRequired && <label>初始化凭证<input name="setupToken" type="password" required autoComplete="off" placeholder="由部署管理员提供" /></label>}
        <label>密码<input type="password" name="password" required minLength={status.initialized ? 1 : 12} maxLength={200} autoComplete={status.initialized ? 'current-password' : 'new-password'} placeholder={status.initialized ? '输入密码' : '至少 12 个字符'} /></label>
        <Button primary disabled={busy} type="submit">{busy ? '正在处理…' : status.initialized ? '登录' : '创建管理员并进入'}<ArrowRight size={15} /></Button>
      </form>}
    </section></div>;
}
