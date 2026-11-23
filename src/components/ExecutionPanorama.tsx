import { useEffect, useId, useMemo, useRef, useState, type KeyboardEvent } from 'react';
import { createPortal } from 'react-dom';
import { ArrowDown, ArrowRight, BookOpen, Bot, Check, ChevronRight, Circle, Clock3, Download, FileCheck2, GitBranch, Layers3, List, Maximize2, MessageSquare, Network, ShieldCheck, Wrench, X, ZoomIn, ZoomOut } from 'lucide-react';
import type { ExecutionTrace } from '../api';
import { Modal } from './ui';
import '../panorama.css';

type TraceNode = ExecutionTrace['nodes'][number];
type TraceEdge = ExecutionTrace['edges'][number];
type PositionedNode = { node: TraceNode; x: number; y: number };
type AgentGroup = { id: string; title: string; role: 'root' | 'child'; nodes: TraceNode[]; anchor?: TraceNode };
type AgentLane = { group: AgentGroup; x: number; top: number; width: number; height: number };

const statuses: Record<ExecutionTrace['status'] | TraceNode['status'], string> = {
  running: '处理中', completed: '已完成', awaiting_approval: '待审批', error: '发生错误', cancelled: '已取消', blocked: '已阻止', skipped: '未执行',
};
const kinds = {
  request: { label: '请求', icon: MessageSquare, explanation: '本轮请求与 Agent 入口。' },
  context: { label: '上下文', icon: Layers3, explanation: '对话历史与本轮配置的装配记录。' },
  skill: { label: 'Skill 指引', icon: FileCheck2, explanation: '已加载的流程指引，不表示执行了 Skill 中的脚本。' },
  knowledge: { label: '知识检索', icon: BookOpen, explanation: '检索到的参考材料，不等同于实时查询。' },
  mcp: { label: '工具目录', icon: Network, explanation: '工具服务连接与目录发现，不表示已调用工具。' },
  model: { label: '模型', icon: Bot, explanation: '模型请求及可观测结果，不包含模型内部推理。' },
  tool: { label: '工具处理', icon: Wrench, explanation: '工具处理的实际记录，是否执行以本节点状态为准。' },
  review: { label: '独立复核', icon: ShieldCheck, explanation: '独立复核的处理结果，不代表人工批准或业务健康。' },
  answer: { label: '答复', icon: MessageSquare, explanation: '本轮对用户发布的结果。' },
  delegation: { label: '自主委派', icon: GitBranch, explanation: '主 Agent 实际提出的任务分派；仅向本轮已授权的 Agent 交接。' },
  subagent: { label: '子 Agent', icon: Bot, explanation: '独立子任务的处理记录；子 Agent 使用自己的上下文，当前仅可只读查询，不能继续委派。' },
  handoff: { label: '任务交接', icon: ArrowRight, explanation: '主任务与子任务之间的输入或结果交接；展示处理规模与依赖，不展示原始内容。' },
  aggregate: { label: '结果汇总', icon: Layers3, explanation: '子任务返回后，主 Agent 收集结果继续处理；部分失败会保留实际状态。' },
  budget: { label: '共享预算', icon: Clock3, explanation: '父子任务共用的模型轮次与 token/上下文预算检查，达到上限时停止继续请求模型。' },
};
const completedLabels: Partial<Record<TraceNode['kind'], string>> = {
  request: '已接收', context: '已装配', skill: '已加载', knowledge: '已检索', mcp: '已发现', answer: '已发布',
};
const nodeWidth = 182, nodeHeight = 100, columnGap = 24, rowGap = 52, padding = 24;

function duration(value?: number) {
  if (typeof value !== 'number' || !Number.isFinite(value)) return '—';
  const ms = Math.max(0, value);
  if (ms < 1000) return `${Math.round(ms)} ms`;
  if (ms < 60000) return `${(ms / 1000).toFixed(1)} s`;
  return `${Math.floor(ms / 60000)} min ${Math.floor(ms % 60000 / 1000)} s`;
}

function time(value?: string) {
  if (!value || !Number.isFinite(Date.parse(value))) return '未记录';
  return new Date(value).toLocaleString('zh-CN', { hour12: false });
}

function nodeStatus(node: TraceNode) {
  return node.status === 'completed' ? completedLabels[node.kind] || statuses.completed : statuses[node.status];
}

function Status({ status, label }: { status: TraceNode['status']; label?: string }) {
  return <span className={`panorama-status panorama-status-${status}`}>
    {status === 'completed' ? <Check size={11} aria-hidden="true" /> : status === 'error' || status === 'blocked' ? <X size={11} aria-hidden="true" /> : <Circle size={8} aria-hidden="true" />}
    {label || statuses[status]}
  </span>;
}

function agentGroups(trace: ExecutionTrace): AgentGroup[] {
  const groups: AgentGroup[] = [{ id: trace.runId, title: '主 Agent', role: 'root', nodes: [] }];
  for (const node of trace.nodes) {
    const id = node.agentRunId || trace.runId;
    let group = groups.find(item => item.id === id);
    if (!group) { group = { id, title: `子 Agent ${groups.length}`, role: 'child', nodes: [] }; groups.push(group); }
    group.nodes.push(node);
    if (node.kind === 'subagent') group.anchor = node;
  }
  for (const group of groups) if (group.role === 'child' && group.anchor) group.title += ` · ${group.anchor.label}`;
  return groups;
}

function layoutGraph(nodes: TraceNode[], edges: TraceEdge[], groups: AgentGroup[]) {
  const index = new Map(nodes.map((node, i) => [node.id, i]));
  const incoming = new Map(nodes.map(node => [node.id, 0]));
  const children = new Map(nodes.map(node => [node.id, [] as string[]]));
  const depth = new Map(nodes.map(node => [node.id, 0]));
  for (const edge of edges) {
    incoming.set(edge.to, incoming.get(edge.to)! + 1);
    children.get(edge.from)!.push(edge.to);
  }
  const queue = nodes.filter(node => incoming.get(node.id) === 0).map(node => node.id);
  let visited = 0;
  for (let cursor = 0; cursor < queue.length; cursor++) {
    const id = queue[cursor]; visited++;
    for (const child of children.get(id) || []) {
      depth.set(child, Math.max(depth.get(child)!, depth.get(id)! + 1));
      incoming.set(child, incoming.get(child)! - 1);
      if (incoming.get(child) === 0) queue.push(child);
    }
  }
  const isDag = visited === nodes.length;
  // A malformed cycle remains inspectable in the list, without inventing a dependency order.
  if (!isDag) return { positions: [] as PositionedNode[], lanes: [] as AgentLane[], width: 0, height: 0, isDag };
  const levels: TraceNode[][] = [];
  for (const node of nodes) (levels[depth.get(node.id)!] ||= []).push(node);
  for (const level of levels) level?.sort((a, b) => index.get(a.id)! - index.get(b.id)!);
  // Keep the original compact layout for historical traces without child runs.
  if (groups.length > 1) {
    const headerHeight = 42;
    const height = Math.max(180, levels.length * (nodeHeight + rowGap) - rowGap + padding * 2 + headerHeight);
    let nextX = padding;
    const lanes = groups.map(group => {
      const columns = Math.max(1, ...levels.map(level => level.filter(node => group.nodes.includes(node)).length));
      const width = columns * (nodeWidth + columnGap) - columnGap + padding;
      const firstRank = group.role === 'child' ? Math.min(...group.nodes.map(node => depth.get(node.id)!)) : 0;
      const lastRank = group.role === 'child' ? Math.max(...group.nodes.map(node => depth.get(node.id)!)) : levels.length - 1;
      const lane = { group, x: nextX, width, height: (lastRank - firstRank) * (nodeHeight + rowGap) + nodeHeight + headerHeight + padding, top: padding + firstRank * (nodeHeight + rowGap) };
      nextX += width + columnGap;
      return lane;
    });
    const positions = lanes.flatMap(lane => levels.flatMap((level, rank) => {
      const laneNodes = level.filter(node => lane.group.nodes.includes(node));
      return laneNodes.map((node, column) => ({ node,
        x: lane.x + (lane.width - laneNodes.length * (nodeWidth + columnGap) + columnGap) / 2 + column * (nodeWidth + columnGap),
        y: padding + headerHeight + rank * (nodeHeight + rowGap),
      }));
    }));
    return { positions, lanes, width: nextX - columnGap + padding, height, isDag };
  }
  const columns = Math.max(1, ...levels.map(level => level.length));
  const width = Math.max(420, columns * (nodeWidth + columnGap) - columnGap + padding * 2);
  const positions = levels.flatMap((level, rank) => level.map((node, column) => ({
    node,
    x: (width - level.length * (nodeWidth + columnGap) + columnGap) / 2 + column * (nodeWidth + columnGap),
    y: padding + rank * (nodeHeight + rowGap),
  })));
  return { positions, lanes: [] as AgentLane[], width, height: Math.max(180, levels.length * (nodeHeight + rowGap) - rowGap + padding * 2), isDag };
}

export default function ExecutionPanorama({ trace, live = false, open: controlledOpen, onOpenChange, hideEntry = false }: {
  trace: ExecutionTrace; live?: boolean; open?: boolean; onOpenChange?: (open: boolean) => void; hideEntry?: boolean;
}) {
  const [internalOpen, setInternalOpen] = useState(false);
  const open = controlledOpen ?? internalOpen;
  const setOpen = (next: boolean) => { if (controlledOpen === undefined) setInternalOpen(next); onOpenChange?.(next); };
  const [view, setView] = useState<'graph' | 'list'>(() => typeof window !== 'undefined' && window.matchMedia('(max-width: 640px)').matches ? 'list' : 'graph');
  const [selectedId, setSelectedId] = useState('');
  const [zoom, setZoom] = useState(1);
  const [exportError, setExportError] = useState('');
  const buttons = useRef(new Map<string, HTMLButtonElement>());
  const viewport = useRef<HTMLDivElement>(null);
  const rawId = useId(); const markerId = `panorama-arrow-${rawId.replace(/:/g, '')}`;
  const nodeMap = useMemo(() => new Map(trace.nodes.map(node => [node.id, node])), [trace.nodes]);
  const edges = useMemo(() => trace.edges.filter(edge => edge.from !== edge.to && nodeMap.has(edge.from) && nodeMap.has(edge.to)), [trace.edges, nodeMap]);
  const groups = useMemo(() => agentGroups(trace), [trace.nodes, trace.runId]);
  const hierarchical = groups.length > 1;
  const graph = useMemo(() => layoutGraph(trace.nodes, edges, groups), [trace.nodes, edges, groups]);
  const groupByRun = new Map(groups.map(group => [group.id, group]));
  const orderedNodes = hierarchical ? groups.flatMap(group => group.nodes) : trace.nodes;
  const current = trace.nodes.find(node => node.status === 'running') || trace.nodes.find(node => node.status === 'awaiting_approval') || trace.nodes[0];
  const selected = nodeMap.get(selectedId) || current;
  const upstream = selected ? edges.filter(edge => edge.to === selected.id) : [];
  const downstream = selected ? edges.filter(edge => edge.from === selected.id) : [];
  const selectedPath = useMemo(() => {
    const related = new Set<string>(selected ? [selected.id] : []);
    const pending = selected ? [selected.id] : [];
    while (pending.length) {
      const id = pending.pop()!;
      for (const edge of edges) if (edge.to === id && !related.has(edge.from)) { related.add(edge.from); pending.push(edge.from); }
    }
    return related;
  }, [selected?.id, edges]);
  const positions = new Map(graph.positions.map(position => [position.node.id, position]));
  const modelCount = trace.nodes.filter(node => node.kind === 'model').length;
  const toolCount = trace.nodes.filter(node => node.kind === 'tool').length;
  const sourceCount = trace.nodes.filter(node => ['skill', 'knowledge', 'mcp'].includes(node.kind)).length;
  const omittedNodes = trace.omittedNodes || 0, omittedEdges = trace.omittedEdges || 0;
  const partialRecord = omittedNodes > 0 || omittedEdges > 0;
  const isGraph = view === 'graph' && graph.isDag;

  useEffect(() => { setSelectedId(''); setExportError(''); setZoom(1); }, [trace.runId]);
  useEffect(() => {
    if (!open || !selected) return;
    const node = buttons.current.get(selected.id), container = viewport.current;
    if (!node || !container) return;
    // Move only the graph/list viewport; selecting a node must not scroll the entire dialog.
    const bounds = node.getBoundingClientRect(), visible = container.getBoundingClientRect();
    const top = bounds.top < visible.top ? bounds.top - visible.top - 12 : bounds.bottom > visible.bottom ? bounds.bottom - visible.bottom + 12 : 0;
    const left = bounds.left < visible.left ? bounds.left - visible.left - 12 : bounds.right > visible.right ? bounds.right - visible.right + 12 : 0;
    container.scrollBy({ top, left, behavior: 'instant' });
  }, [open, isGraph, selected?.id, zoom]);

  const select = (id: string, focusNode = false) => {
    setSelectedId(id);
    if (focusNode) requestAnimationFrame(() => {
      const node = buttons.current.get(id);
      node?.focus({ preventScroll: true });
      // On narrow screens the details are below the canvas. Keyboard jumps must
      // reveal the focused destination through both scroll containers.
      node?.scrollIntoView({ block: 'nearest', inline: 'nearest', behavior: 'instant' });
    });
  };
  const fitGraph = () => {
    const container = viewport.current;
    if (container) setZoom(Math.min(1, Math.max(Number.EPSILON, Math.min((container.clientWidth - 24) / graph.width, (container.clientHeight - 24) / graph.height))));
  };
  const onNodeKey = (event: KeyboardEvent<HTMLButtonElement>, id: string) => {
    const visibleOrder = isGraph ? trace.nodes : orderedNodes;
    const index = visibleOrder.findIndex(node => node.id === id);
    const next = event.key === 'ArrowDown' || event.key === 'ArrowRight' ? index + 1 : event.key === 'ArrowUp' || event.key === 'ArrowLeft' ? index - 1 : event.key === 'Home' ? 0 : event.key === 'End' ? visibleOrder.length - 1 : -1;
    if (next >= 0 && next < visibleOrder.length) { event.preventDefault(); select(visibleOrder[next].id, true); }
  };
  const download = () => {
    setExportError('');
    const json = JSON.stringify({
      version: trace.version, runId: trace.runId, traceId: trace.traceId, spanId: trace.spanId, omittedNodes: trace.omittedNodes, omittedEdges: trace.omittedEdges,
      startedAt: trace.startedAt, finishedAt: trace.finishedAt, durationMs: trace.durationMs, status: trace.status,
      nodes: trace.nodes.map(({ id, spanId, parentSpanId, agentRunId, parentAgentRunId, parentNodeId, kind, label, status, startedAt, finishedAt, durationMs, summary, details }) => ({ id, spanId, parentSpanId, agentRunId, parentAgentRunId, parentNodeId, kind, label, status, startedAt, finishedAt, durationMs, summary, details: details?.map(({ label, value }) => ({ label, value })) })),
      edges: trace.edges.map(({ from, to, label }) => ({ from, to, label })),
    }, null, 2) + '\n';
    const blob = new Blob([json], { type: 'application/json' });
    if (blob.size > 2 * 1024 * 1024) { setExportError('记录超过 2 MB，无法在此导出。请在执行中心核对本轮记录。'); return; }
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a'); link.href = url; link.download = `panorama-${trace.runId.replace(/[^a-zA-Z0-9_-]/g, '').slice(0, 80) || 'run'}.json`;
    document.body.appendChild(link); link.click(); link.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  };
  const nodeButton = (node: TraceNode, graphNode = false, position?: PositionedNode) => {
    const Icon = kinds[node.kind].icon;
    const group = groupByRun.get(node.agentRunId || trace.runId);
    return <button type="button" key={node.id} ref={element => { if (element) buttons.current.set(node.id, element); else buttons.current.delete(node.id); }}
      className={`panorama-node ${graphNode ? 'panorama-graph-node' : 'panorama-list-node'} ${selected?.id === node.id ? 'is-selected' : ''} ${selectedPath.has(node.id) ? 'is-path' : ''} panorama-node-${node.status}`}
      style={position ? { left: position.x, top: position.y, width: nodeWidth, height: nodeHeight } : undefined}
      data-agent-run-id={node.agentRunId} aria-pressed={selected?.id === node.id} aria-label={`${node.label}，${nodeStatus(node)}`} onClick={() => select(node.id)} onKeyDown={event => onNodeKey(event, node.id)}>
      <span className="panorama-node-kind"><Icon size={13} aria-hidden="true" />{kinds[node.kind].label}{hierarchical && <span className="panorama-node-agent">{group?.role === 'child' ? group.title.split(' · ')[0] : '主 Agent'}</span>}</span>
      <strong title={node.label}>{node.label}</strong>
      <span className="panorama-node-bottom"><Status status={node.status} label={nodeStatus(node)} /><span className="panorama-duration">{node.status === 'running' ? '进行中' : duration(node.durationMs)}</span></span>
      {!graphNode && <span className="panorama-list-summary">{node.summary}</span>}
    </button>;
  };

  if (!trace.nodes.length) return null;
  return <>
    {!hideEntry && <button type="button" data-run-id={trace.runId} className={`panorama-entry ${live ? 'panorama-entry-live' : ''}`} onClick={() => setOpen(true)} aria-label="打开问答全景" aria-haspopup="dialog">
      <span className="panorama-entry-symbol"><GitBranch size={18} aria-hidden="true" /></span>
      <span className="panorama-entry-main"><strong>本轮全景{partialRecord && ' · 部分记录'}</strong><span>{trace.nodes.length} 个节点 · {hierarchical ? `${groups.length - 1} 个子 Agent · ` : ''}{toolCount} 个工具节点</span></span>
      <span className="panorama-entry-result"><Status status={trace.status} /><span className="panorama-duration">{duration(trace.durationMs)}</span></span>
      <ChevronRight size={15} aria-hidden="true" />
    </button>}
    {open && createPortal(<Modal title="问答全景" wide onClose={() => setOpen(false)}>
      <div className="panorama-explorer">
        <header className="panorama-overview">
          <div className="panorama-overview-title"><span className="panorama-eyebrow">{live ? '实时处理记录' : '本轮历史快照'}</span><div><Status status={trace.status} /><span className="panorama-total-time"><Clock3 size={13} aria-hidden="true" />{duration(trace.durationMs)}</span></div><p>{hierarchical ? `主 Agent 分派 → ${groups.length - 1} 个子 Agent 只读处理 → 主 Agent 汇总` : '沿依赖连线，查看这次问答如何完成。'}</p></div>
          <dl className="panorama-counts"><div><dt>处理节点</dt><dd>{trace.nodes.length}</dd></div><div><dt>模型节点</dt><dd>{modelCount}</dd></div><div><dt>工具节点</dt><dd>{toolCount}</dd></div><div><dt>资源节点</dt><dd>{sourceCount}</dd></div></dl>
        </header>
        {partialRecord && <aside className="panorama-limit-note" aria-label="全景记录省略"><strong>记录达到上限，部分处理节点/连线已省略</strong><p>已省略 {omittedNodes} 个节点、{omittedEdges} 条连线。分组、节点数量与依赖仅涵盖已记录部分，请结合实际答复和执行记录核对。</p></aside>}
        <div className="panorama-toolbar"><div className="panorama-view-switch" role="group" aria-label="全景视图"><button type="button" aria-pressed={isGraph} disabled={!graph.isDag} onClick={() => setView('graph')}><GitBranch size={14} aria-hidden="true" />依赖图</button><button type="button" aria-pressed={!isGraph} onClick={() => setView('list')}><List size={14} aria-hidden="true" />节点列表</button></div><button type="button" className="panorama-export" onClick={download}><Download size={13} aria-hidden="true" />导出 JSON</button></div>
        {hierarchical && <nav className="panorama-agent-nav" aria-label="Agent 执行分组">{groups.map(group => <button type="button" key={group.id} aria-label={`查看${group.title}`} aria-pressed={(selected?.agentRunId || trace.runId) === group.id} onClick={() => select((group.anchor || group.nodes[0]).id, true)}><GitBranch size={12} aria-hidden="true" /><span>{group.title}</span><small>{group.nodes.length} 节点</small><Status status={group.role === 'root' ? trace.status : group.anchor?.status || (group.nodes.some(node => node.status === 'running') ? 'running' : group.nodes.some(node => node.status === 'error') ? 'error' : 'completed')} /></button>)}</nav>}
        {exportError && <p className="panorama-export-error" role="alert">{exportError}</p>}
        <div className="panorama-workbench">
          <section className="panorama-canvas" aria-label={isGraph ? '本轮依赖图' : '本轮节点列表'}>
            <div className="panorama-canvas-caption"><span>{isGraph ? '箭头表示处理依赖' : '按记录顺序查看节点'}</span>{isGraph && <span><span className="panorama-path-key" />所选节点的上游</span>}</div>
            {isGraph && <div className="panorama-zoom" role="group" aria-label="依赖图缩放"><button type="button" aria-label="缩小依赖图" disabled={zoom <= .15} onClick={() => setZoom(value => Math.max(.15, value - .15))}><ZoomOut size={13} aria-hidden="true" /></button><button type="button" aria-label="恢复原始比例" onClick={() => setZoom(1)}>{Math.round(zoom * 100)}%</button><button type="button" aria-label="放大依赖图" disabled={zoom >= 1.25} onClick={() => setZoom(value => Math.min(1.25, value + .15))}><ZoomIn size={13} aria-hidden="true" /></button><button type="button" className="panorama-fit" onClick={fitGraph}><Maximize2 size={12} aria-hidden="true" />查看全图</button></div>}
            {isGraph ? <div ref={viewport} className="panorama-graph-scroll"><div className="panorama-graph" style={{ width: graph.width * zoom, height: graph.height * zoom }}><div className="panorama-graph-content" style={{ width: graph.width, height: graph.height, transform: `scale(${zoom})` }}>
              {graph.lanes.map(lane => <div key={lane.group.id} className={`panorama-agent-lane panorama-agent-lane-${lane.group.role}`} data-agent-run-id={lane.group.id} style={{ left: lane.x, top: lane.top, width: lane.width, height: lane.height }}><strong title={lane.group.title}>{lane.group.title}</strong><span>{lane.group.nodes.length} 个处理节点</span></div>)}
              <svg width={graph.width} height={graph.height} className="panorama-links" aria-hidden="true"><defs><marker id={markerId} viewBox="0 0 10 10" refX="9" refY="5" markerWidth="5" markerHeight="5" orient="auto-start-reverse"><path d="M 0 0 L 10 5 L 0 10 z" fill="context-stroke" /></marker></defs>{edges.map((edge, i) => {
                const from = positions.get(edge.from)!, to = positions.get(edge.to)!;
                const x1 = from.x + nodeWidth / 2, y1 = from.y + nodeHeight, x2 = to.x + nodeWidth / 2, y2 = to.y;
                const middle = y1 + (y2 - y1) / 2;
                const crossesAgent = (from.node.agentRunId || trace.runId) !== (to.node.agentRunId || trace.runId);
                return <g key={`${edge.from}-${edge.to}-${i}`}><path d={`M ${x1} ${y1} C ${x1} ${middle}, ${x2} ${middle}, ${x2} ${y2 - 3}`} className={`${selectedPath.has(edge.from) && selectedPath.has(edge.to) ? 'is-path' : ''}${crossesAgent ? ' is-handoff' : ''}`} markerEnd={`url(#${markerId})`} />{crossesAgent && edge.label && <text x={(x1 + x2) / 2} y={middle - 5} textAnchor="middle">{edge.label}</text>}</g>;
              })}</svg>
              {graph.positions.map(position => nodeButton(position.node, true, position))}
            </div></div></div> : <div ref={viewport} className="panorama-list">{!graph.isDag && <p className="panorama-graph-note">记录含有循环依赖，使用节点列表查看原始记录。</p>}{hierarchical ? groups.map(group => <section key={group.id} className={`panorama-agent-group panorama-agent-group-${group.role}`} aria-label={group.title}><header><strong>{group.title}</strong><span>{group.nodes.length} 个处理节点</span></header>{group.nodes.map(node => nodeButton(node))}</section>) : trace.nodes.map(node => nodeButton(node))}</div>}
            <p className="panorama-keyboard-help">{isGraph && zoom < .6 ? '缩略全图 · 选择节点查看完整工作内容。' : '选择节点查看工作内容；方向键可切换节点。'}</p>
          </section>
          {selected && <aside className="panorama-detail" aria-label="所选节点详情">
            <div className="panorama-detail-heading"><span className="panorama-eyebrow">{kinds[selected.kind].label}</span><h3>{selected.label}</h3><Status status={selected.status} label={nodeStatus(selected)} /></div>
            <p className="panorama-node-explanation">{kinds[selected.kind].explanation}</p>
            {selected.agentRunId && <section className="panorama-detail-section panorama-agent-detail"><h4>所属 Agent</h4><p>{groupByRun.get(selected.agentRunId)?.title || '主 Agent'}</p><code>{selected.agentRunId}</code>{selected.parentAgentRunId && <p>父执行 <code>{selected.parentAgentRunId}</code></p>}{selected.parentNodeId && nodeMap.has(selected.parentNodeId) && <button type="button" onClick={() => select(selected.parentNodeId!, true)}><GitBranch size={12} aria-hidden="true" />查看委派入口<ArrowRight size={12} aria-hidden="true" /></button>}</section>}
            <section className="panorama-detail-section"><h4>做了什么</h4><p className="panorama-summary">{selected.summary || '此节点没有记录处理摘要。'}</p></section>
            {selected.status === 'awaiting_approval' && <p className="panorama-pending-note">等待人工审批，不能视为已执行。后续状态请到执行中心核对。</p>}
            {selected.status === 'skipped' && <p className="panorama-pending-note">该节点未执行，不计作已完成的工作。</p>}
            {!!selected.details?.length && <dl className="panorama-detail-values">{selected.details.map((item, i) => <div key={`${item.label}-${i}`}><dt>{item.label}</dt><dd>{item.value}</dd></div>)}</dl>}
            <dl className="panorama-timing"><div><dt>耗时</dt><dd>{duration(selected.durationMs)}</dd></div><div><dt>开始</dt><dd>{time(selected.startedAt)}</dd></div>{selected.finishedAt && <div><dt>结束</dt><dd>{time(selected.finishedAt)}</dd></div>}</dl>
            <section className="panorama-detail-section panorama-dependencies"><h4><ArrowDown size={12} aria-hidden="true" />依赖上游 <span>{upstream.length}</span></h4>{upstream.length ? upstream.map((edge, i) => <button type="button" key={`${edge.from}-${i}`} onClick={() => select(edge.from, true)}><span>{nodeMap.get(edge.from)!.label}{edge.label && <small>{edge.label}</small>}</span><ArrowRight size={12} aria-hidden="true" /></button>) : <p>本记录中没有上游依赖。</p>}</section>
            <section className="panorama-detail-section panorama-dependencies"><h4><ArrowDown size={12} aria-hidden="true" />交给下游 <span>{downstream.length}</span></h4>{downstream.length ? downstream.map((edge, i) => <button type="button" key={`${edge.to}-${i}`} onClick={() => select(edge.to, true)}><span>{nodeMap.get(edge.to)!.label}{edge.label && <small>{edge.label}</small>}</span><ArrowRight size={12} aria-hidden="true" /></button>) : <p>本记录中没有下游节点。</p>}</section>
          </aside>}
        </div>
        <footer className="panorama-footer"><p>{live ? '运行记录随处理更新；连接中断时请在执行中心核对结果。' : '这是本轮生成时的快照，后续审批和执行结果请在执行中心查看。'}{hierarchical && ' 分组表示独立的 Agent 执行，跨组箭头表示任务或结果交接；仅展示可观测摘要和数量。'}</p><div><span>执行 ID</span><code>{trace.runId}</code></div></footer>
      </div>
    </Modal>, document.body)}
  </>;
}
