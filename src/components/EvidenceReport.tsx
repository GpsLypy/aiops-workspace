import { Download } from 'lucide-react';
import { dateText, type EvidenceReport as Report } from '../api';

const outcomes = { completed: '回答已生成', awaiting_approval: '等待审批', error: '本轮未完成' };
const states: Record<string, string> = { success: '已完成', failed: '失败', unknown: '结果未知', awaiting_approval: '等待审批', cancelled: '已取消', ready: '等待执行', approved: '已批准', executing: '执行中', expired: '已过期' };
const gaps: Record<string, string> = { no_successful_tool_evidence: '本轮没有成功的工具证据。', mcp_discovery_unavailable: '部分数据源未取得实时数据，见上方提示。', unfinished_or_failed_steps: '存在待审批、未完成或失败的工具步骤。', history_omitted: '较早历史已省略，关键对象和范围请在当前问题中补全。', generation_incomplete: '回答生成未完成，请结合执行记录核对本轮结果。' };

export default function EvidenceReport({ report }: { report: Report }) {
  const download = () => {
    const url = URL.createObjectURL(new Blob([JSON.stringify(report, null, 2) + '\n'], { type: 'application/json' }));
    const link = document.createElement('a'); link.href = url; link.download = `evidence-${report.runId}.json`;
    link.click(); setTimeout(() => URL.revokeObjectURL(url), 1000);
  };
  return <details className="evidence-report">
    <summary>本轮证据 <span>{report.toolSteps.length} 个步骤 · {report.sources.length} 处参考</span></summary>
    <div className="evidence-report-body">
      <div className="evidence-report-header"><strong>{outcomes[report.outcome]}</strong><time dateTime={report.generatedAt}>{dateText(report.generatedAt)}</time></div>
      <p className="evidence-report-note">这是回答生成时的证据快照，不代表业务健康结论。审批和核对后的最新状态请查看执行中心。</p>
      <p className="evidence-report-run">执行编号 <code>{report.runId}</code></p>
      {!!report.gaps.length && <ul className="evidence-report-gaps" aria-label="证据限制">{report.gaps.map(g => <li key={g}>{gaps[g] || g}</li>)}</ul>}
      <section aria-label="实际工具步骤"><h4>实际工具步骤</h4>{report.toolSteps.length ? <ol>{report.toolSteps.map(s => <li key={s.stepId}><div><strong>{s.tool}</strong><span>{states[s.status] || s.status}</span></div><code>{s.stepId}</code><small>{s.environment} · {s.risk === 'read' ? '只读' : '变更'} · 资源修订 {s.revision}</small></li>)}</ol> : <p>本轮没有工具步骤。</p>}</section>
      <section aria-label="参考资料版本"><h4>参考资料</h4>{report.sources.length ? <ul>{report.sources.map(s => <li key={`${s.resourceId}:${s.offset}`}><strong>{s.title}</strong><small>修订 {s.revision}{s.documentVersion ? ` · ${s.documentVersion}` : ''} · 片段位置 {s.offset}</small></li>)}</ul> : <p>本轮未引用检索资料。</p>}</section>
      <button type="button" className="evidence-report-export" onClick={download}><Download size={14} aria-hidden="true" />导出证据 JSON</button>
    </div>
  </details>;
}
