import { useState } from 'react';
import type { Resource } from '../api';
import { Badge, Button, Empty, Modal } from './ui';

export default function ToolCatalog({ resources, close, manage }: { resources: Resource[]; close: () => void; manage: (resource: Resource) => void }) {
  const [query, setQuery] = useState('');
  const [service, setService] = useState('');
  const services = resources.filter(r => r.kind === 'mcp');
  const tools = services.flatMap(resource => [...new Set(resource.allowedTools)].map(name => {
    const value = resource.toolPolicies[name];
    const policy = value && typeof value === 'object' ? value as Record<string, unknown> : {};
    const risk = typeof policy.risk === 'string' ? policy.risk : '';
    const requiresTarget = risk === 'read' && Array.isArray(policy.requiredTargetFields) && policy.requiredTargetFields.length > 0;
    return { resource, name, risk, requiresTarget };
  }));
  const filtered = tools.filter(t => (!service || t.resource.id === service) && `${t.name} ${t.resource.name}`.toLowerCase().includes(query.trim().toLowerCase()));
  return <Modal drawer title="MCP 工具清单" onClose={close}>
    <div className="modal-content tool-catalog">
      <div className="catalog-heading"><div><h3>了解工具，再开始行动</h3><p>{services.length} 个可见服务 · {tools.length} 个允许列表条目</p></div><Badge tone="blue">配置目录</Badge></div>
      <div className="info-strip">这里展示已保存的工具配置，不代表远程在线或当前调用已获授权。实际执行还会检查身份、环境、参数范围与审批。</div>
      <div className="catalog-filters"><input aria-label="搜索工具" placeholder="搜索工具名或服务名" value={query} onChange={e => setQuery(e.target.value)} /><select aria-label="筛选 MCP 服务" value={service} onChange={e => setService(e.target.value)}><option value="">全部服务</option>{services.map(r => <option key={r.id} value={r.id}>{r.name}</option>)}</select></div>
      <p role="status">找到 {filtered.length} 个工具条目</p>
      <div className="catalog-list">{filtered.map(({ resource, name, risk, requiresTarget }) => <article className="catalog-card" key={`${resource.id}:${name}`}>
        <div className="catalog-card-heading"><h3>{name}</h3><Badge tone={resource.status === '已启用' && risk ? 'green' : ''}>{resource.status === '已停用' ? '服务已停用' : risk ? '已配置策略' : '待配置策略'}</Badge></div>
        <p>{resource.name} · {resource.environment} · {resource.service || '未标记业务服务'}</p>
        <div className="catalog-tags"><Badge tone={risk === 'read' ? 'green' : 'orange'}>{risk === 'read' ? '只读查询' : risk === 'write' ? '可执行变更' : risk === 'high' ? '高风险变更' : '未分类'}</Badge>{requiresTarget && <Badge tone="blue">需确认目标</Badge>}<Badge>{risk === 'read' ? '交互执行无需写入审批' : risk ? '交互执行需审批与核验' : '暂不可执行'}</Badge></div>
        <Button onClick={() => manage(resource)}>查看服务配置</Button>
      </article>)}</div>
      {!filtered.length && <Empty text={tools.length ? '没有匹配的工具，请调整搜索或服务筛选' : '暂无授权工具，请在 MCP 服务详情中配置允许列表与策略'} />}
    </div>
  </Modal>;
}
