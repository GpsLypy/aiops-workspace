import { useEffect, useId, useRef, useState } from 'react';
import { Check, ChevronDown, X } from 'lucide-react';
import type { Resource, TargetBinding, User } from '../api';

type Scalar = TargetBinding['arguments'][string];
type Policy = { risk?: string; roles?: string[]; userIds?: string[]; environments?: string[]; requiredTargetFields?: string[]; constraints?: Record<string, (Scalar | null)[]> };
type Option = { key: string; resource: Resource; tool: string; policy: Policy };

const fieldNames: Record<string, string> = { jobid: '任务 ID', business_domain: '业务域', area_name: '区域', service: '服务' };
const fieldName = (field: string) => fieldNames[field] || field;
const showValue = (value: Scalar) => String(value);
const optionKey = (resourceId: string, tool: string) => JSON.stringify([resourceId, tool]);

function optionsFor(resources: Resource[], agentId: string, user: User): Option[] {
  const agent = agentId ? resources.find(resource => resource.id === agentId && resource.kind === 'agents' && resource.status === '已启用') : null;
  if (agentId && !agent) return [];
  return resources.flatMap(resource => {
    if (resource.kind !== 'mcp' || resource.status !== '已启用' || agent && !agent.mcpIds.includes(resource.id)) return [];
    return resource.allowedTools.flatMap(tool => {
      const policy = resource.toolPolicies[tool] as Policy | undefined;
      if (policy?.risk !== 'read' || !Array.isArray(policy.requiredTargetFields) || !policy.requiredTargetFields.length ||
          !policy.roles?.includes(user.role) || policy.userIds?.length && !policy.userIds.includes(user.id) ||
          !policy.environments?.includes(resource.environment)) return [];
      return [{ key: optionKey(resource.id, tool), resource, tool, policy }];
    });
  });
}

export default function TargetBindingControl({ resources, agentId, user, value, onChange, disabled = false }: {
  resources: Resource[]; agentId: string; user: User; value: TargetBinding | null;
  onChange: (value: TargetBinding | null) => void; disabled?: boolean;
}) {
  const options = optionsFor(resources, agentId, user);
  const [selectedKey, setSelectedKey] = useState(value ? optionKey(value.resourceId, value.tool) : '');
  const [fields, setFields] = useState<Record<string, Scalar>>(value?.arguments || {});
  const [error, setError] = useState('');
  const [invalidField, setInvalidField] = useState('');
  const errorId = useId();
  const controlRef = useRef<HTMLDetailsElement>(null);
  const key = options.some(option => option.key === selectedKey) ? selectedKey : (options.length === 1 ? options[0].key : '');
  const selected = options.find(option => option.key === key);

  useEffect(() => {
    if (value && !options.some(option => option.key === optionKey(value.resourceId, value.tool) &&
      option.resource.environment === value.environment && option.policy.requiredTargetFields?.every(field => Object.hasOwn(value.arguments, field)))) onChange(null);
  }, [resources, agentId, user.id, user.role, value]);

  if (!options.length) return null;
  const changeField = (field: string, next: Scalar) => { setFields(previous => ({ ...previous, [field]: next })); setError(''); setInvalidField(''); onChange(null); };
  const confirm = () => {
    if (!selected) { setError('请选择查询工具'); return; }
    const args: TargetBinding['arguments'] = {};
    for (const field of selected.policy.requiredTargetFields || []) {
      const allowed = selected.policy.constraints?.[field]?.filter((item): item is Scalar => item !== null);
      const raw = fields[field] ?? (allowed?.length ? allowed[0] : '');
      const resolved = typeof raw === 'string' && !allowed ? raw.trim() : raw;
      if (resolved === '' || resolved === undefined || allowed && !allowed.some(candidate => Object.is(candidate, resolved))) {
        setError(`请填写${fieldName(field)}`);
        setInvalidField(field);
        controlRef.current?.querySelectorAll<HTMLInputElement | HTMLSelectElement>('[data-target-field]').forEach(input => {
          if (input.dataset.targetField === field) input.focus();
        });
        return;
      }
      args[field] = resolved;
    }
    setError('');
    setInvalidField('');
    onChange({ resourceId: selected.resource.id, tool: selected.tool, environment: selected.resource.environment, arguments: args });
  };
  return <details ref={controlRef} className="target-binding-control">
    <summary><span>本轮查询目标</span><span className={value ? 'target-binding-state confirmed' : 'target-binding-state'}>{value && <Check size={12} aria-hidden="true" />}{value ? '已确认' : '未确认'}</span><ChevronDown className="target-binding-chevron" size={14} aria-hidden="true" /></summary>
    <div className="target-binding-body">
      {options.length === 1 ? <p className="target-binding-tool"><span>{selected?.resource.name}</span><code>{selected?.tool}</code></p> : <label>查询工具<select aria-label="目标查询工具" value={key} disabled={disabled} onChange={event => { setSelectedKey(event.target.value); setFields({}); setError(''); setInvalidField(''); onChange(null); }}>
        <option value="">选择工具</option>
        {options.map(option => <option key={option.key} value={option.key}>{option.resource.name} / {option.tool}</option>)}
      </select></label>}
      {selected && <div className="target-binding-fields-scroll"><div className="target-binding-fields">{selected.policy.requiredTargetFields?.map(field => {
        const allowed = selected.policy.constraints?.[field]?.filter((item): item is Scalar => item !== null);
        const current = fields[field] ?? (allowed?.length ? allowed[0] : '');
        const accessibility = { 'data-target-field': field, 'aria-invalid': invalidField === field || undefined, 'aria-describedby': invalidField === field ? errorId : undefined };
        return <label key={field} className={field === 'jobid' ? 'target-binding-job' : undefined}>{fieldName(field)}{allowed?.length ? <select {...accessibility} aria-label={fieldName(field)} value={Math.max(0, allowed.findIndex(item => Object.is(item, current)))} disabled={disabled} onChange={event => changeField(field, allowed[Number(event.target.value)])}>
          {allowed.map((item, index) => <option key={index} value={index}>{showValue(item)}</option>)}
        </select> : <input {...accessibility} aria-label={fieldName(field)} placeholder={field === 'jobid' ? '输入任务 ID' : `填写${fieldName(field)}`} value={showValue(current)} disabled={disabled} maxLength={500} onChange={event => changeField(field, event.target.value)} />}</label>;
      })}</div></div>}
      <div className="target-binding-footer">
        <div className="target-binding-feedback">
          {error && <p id={errorId} className="target-binding-error" role="alert">{error}</p>}
          {value && <p className="target-binding-summary">{Object.entries(value.arguments).map(([field, selectedValue]) => `${fieldName(field)} ${showValue(selectedValue)}`).join(' · ')}</p>}
        </div>
        <div className="target-binding-actions"><button type="button" className="target-binding-confirm" disabled={disabled || !selected} onClick={confirm}><Check size={14} aria-hidden="true" />确认目标</button>
          {value && <button type="button" className="target-binding-clear" aria-label="清除已确认目标" title="清除已确认目标" disabled={disabled} onClick={() => { onChange(null); setError(''); setInvalidField(''); }}><X size={15} aria-hidden="true" /></button>}
        </div>
      </div>
    </div>
  </details>;
}
