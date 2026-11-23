import { useRef } from 'react';
import { Plus, Trash2 } from 'lucide-react';
import type { Resource, NotificationChannel, NotificationConfig, InspectionRule } from '../api';
import { Button } from './ui';

export const defaultNotification: NotificationConfig = { channelIds: [], mode: 'all', recovery: true, repeatMinutes: 60 };
const readTools = (resource?: Resource) => resource?.allowedTools.filter(t => (resource.toolPolicies[t] as { risk?: string } | undefined)?.risk === 'read') || [];

export default function TaskNotificationFields({ channels, resources, value, rules, onChange, onRulesChange }: { channels: NotificationChannel[]; resources: Resource[]; value: NotificationConfig; rules: InspectionRule[]; onChange: (next: NotificationConfig) => void; onRulesChange: (next: InspectionRule[]) => void }) {
  const ruleKeys = useRef(new WeakMap<InspectionRule, number>());
  const nextRuleKey = useRef(0);
  const ruleKey = (rule: InspectionRule) => {
    let key = ruleKeys.current.get(rule);
    if (key === undefined) { key = nextRuleKey.current++; ruleKeys.current.set(rule, key); }
    return key;
  };
  const services = resources.filter(r => r.kind === 'mcp' && readTools(r).length > 0);
  const updateRule = (index: number, next: Partial<InspectionRule>) => onRulesChange(rules.map((rule, i) => {
    if (i !== index) return rule;
    const updated = { ...rule, ...next };
    // Keep this row's draft and native validity when other rows are removed or fields are edited.
    ruleKeys.current.set(updated, ruleKey(rule));
    return updated;
  }));
  return <div className="notification-fields">
    <div className="notification-section-title"><strong>结果通知</strong><span>选择渠道后启用推送</span></div>
    <fieldset className="channel-options"><legend>发送到</legend>{channels.length ? channels.map(c => <label key={c.id}><input type="checkbox" checked={value.channelIds.includes(c.id)} disabled={!c.enabled && !value.channelIds.includes(c.id)} onChange={e => onChange({ ...value, channelIds: e.target.checked ? [...value.channelIds, c.id] : value.channelIds.filter(id => id !== c.id) })} /><span>{c.name}<small>{c.kind === 'wecom' ? '企业微信' : '通用 Webhook'}{!c.enabled && ' · 已停用'}</small></span></label>) : <p>暂无可用渠道。请管理员在通知中心创建渠道并授权。</p>}{value.channelIds.filter(id => !channels.some(c => c.id === id)).map(id => <label key={id}><input type="checkbox" checked onChange={() => onChange({ ...value, channelIds: value.channelIds.filter(x => x !== id) })} />已不可用的渠道（取消选择后可保存）</label>)}</fieldset>
    {!!value.channelIds.length && <div className="notification-form-grid"><label>推送时机<select value={value.mode} onChange={e => onChange({ ...value, mode: e.target.value as NotificationConfig['mode'] })}><option value="all">每次执行结束</option><option value="issues">异常或无法判断时</option></select></label><label>持续异常提醒间隔（分钟）<input type="number" min={1} max={10080} value={value.repeatMinutes} disabled={value.mode === 'all'} onChange={e => onChange({ ...value, repeatMinutes: Number(e.target.value) })} /></label><label className="notification-checkbox"><input type="checkbox" checked={value.recovery} disabled={value.mode === 'all'} onChange={e => onChange({ ...value, recovery: e.target.checked })} />恢复正常时通知</label><p className="notification-hint">执行失败也会通知。相同异常按间隔提醒，检查项状态变化会立即通知。</p></div>}
    <div className="notification-section-title"><strong>巡检正常条件</strong><Button type="button" disabled={rules.length >= 12 || !services.length} onClick={() => { const service = services[0]; onRulesChange([...rules, { label: '', resourceId: service.id, tool: readTools(service)[0], arguments: {}, path: '', operator: 'eq', expected: '' }]); }}><Plus size={13} />添加条件</Button></div>
    <p className="notification-hint">使用实际工具返回的字段判断。全部条件满足才为正常；没有结果、字段缺失或过期时为“无法判断”。普通报告可不配置条件，选择每次推送。</p>
    {value.mode === 'issues' && !rules.length && <p className="inline-error">异常时推送需要至少一个正常条件。</p>}
    {rules.map((rule, i) => <section className="inspection-rule" key={ruleKey(rule)} aria-label={`正常条件 ${i + 1}`}>
      <div className="notification-section-title"><strong>条件 {i + 1}</strong><button type="button" className="text-button danger" aria-label={`移除条件 ${i + 1}`} onClick={() => onRulesChange(rules.filter((_, n) => i !== n))}><Trash2 size={13} />移除</button></div>
      <div className="notification-form-grid">
        <label>条件名称<input required maxLength={100} value={rule.label} placeholder="例如：任务处于运行状态" onChange={e => updateRule(i, { label: e.target.value })} /></label>
        <label>数据服务<select value={rule.resourceId} onChange={e => { const service = services.find(r => r.id === e.target.value); updateRule(i, { resourceId: e.target.value, tool: readTools(service)[0], arguments: {} }); }}>{!services.some(r => r.id === rule.resourceId) && <option value={rule.resourceId}>原服务已不可用</option>}{services.map(r => <option key={r.id} value={r.id}>{r.name}</option>)}</select></label>
        <label>只读查询工具<select value={rule.tool} onChange={e => updateRule(i, { tool: e.target.value })}>{readTools(services.find(r => r.id === rule.resourceId)).map(t => <option key={t}>{t}</option>)}</select></label>
        <label>结果字段<input required value={rule.path} placeholder="例如：status 或 health" pattern="[\w-]+(\.[\w-]+)*" onChange={e => updateRule(i, { path: e.target.value })} /></label>
        <label>正常条件<select value={rule.operator} onChange={e => updateRule(i, { operator: e.target.value as InspectionRule['operator'], expected: ['eq', 'ne'].includes(e.target.value) ? rule.expected : typeof rule.expected === 'number' ? rule.expected : 60 })}><option value="eq">等于</option><option value="ne">不等于</option><option value="gt">大于</option><option value="gte">大于或等于</option><option value="lt">小于</option><option value="lte">小于或等于</option><option value="fresh">数据年龄不超过（秒）</option></select></label>
        <label>值类型<select disabled={!['eq', 'ne'].includes(rule.operator)} value={typeof rule.expected} onChange={e => updateRule(i, { expected: e.target.value === 'number' ? 0 : e.target.value === 'boolean' ? true : '' })}><option value="string">文本</option><option value="number">数字</option><option value="boolean">是 / 否</option></select></label>
        <label>期望值{typeof rule.expected === 'boolean' ? <select value={String(rule.expected)} onChange={e => updateRule(i, { expected: e.target.value === 'true' })}><option value="true">true（是）</option><option value="false">false（否）</option></select> : <input required type={typeof rule.expected === 'number' ? 'number' : 'text'} step="any" value={rule.expected} onChange={e => updateRule(i, { expected: typeof rule.expected === 'number' ? Number(e.target.value) : e.target.value })} />}</label>
      </div>
      {rule.operator === 'fresh' && <p className="notification-hint">时间字段需包含时区，例如 2026-09-21T09:00:00+08:00。过期数据会标为无法判断。</p>}
      <details><summary>限定检查对象（可选）</summary><label>匹配工具参数（JSON 对象）<textarea key={rule.resourceId} aria-label={`条件 ${i + 1} 的对象参数`} defaultValue={JSON.stringify(rule.arguments, null, 2)} onChange={e => { try { const args = JSON.parse(e.target.value); if (!args || Array.isArray(args) || typeof args !== 'object' || Object.values(args).some(v => !['string', 'number', 'boolean'].includes(typeof v))) throw new Error(); e.target.setCustomValidity(''); updateRule(i, { arguments: args }); } catch { e.target.setCustomValidity('请填写合法的 JSON 对象，值为文本、数字或布尔值'); } }} /></label><p className="notification-hint">例如 {`{"jobid":"13619800264280069"}`}。留空对象表示检查该工具本轮所有结果；指定对象未被查询时为无法判断。</p></details>
    </section>)}
  </div>;
}
