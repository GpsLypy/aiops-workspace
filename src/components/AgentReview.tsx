import { Download } from 'lucide-react';
import { type AgentReview as Review } from '../api';

const statuses = { accepted: '复核通过', blocked: '未通过复核', unavailable: '复核未完成', skipped: '等待人工审批' };
const reasons: Record<string, string> = {
  target_mismatch: '分析的对象或范围与请求不一致。请明确任务、业务域和区域后重新提问。',
  unsupported_claim: '答复包含缺少依据的断言。请补充支持该结论的证据。',
  missing_evidence: '本轮证据不足。请补充实时数据或缩小问题范围。',
  stale_evidence: '证据已过时。请取得最新数据后重新提问。',
  conflicting_evidence: '证据之间存在冲突。请核对数据来源后重新提问。',
  review_input_too_large: '完整证据超出复核输入或剩余预算，或工具结果已截断。请缩小问题范围后重新提问。',
  invalid_review: '复核结果格式不符合要求，无法确认答复。请检查模型服务后重试。',
  review_failed: '复核未能完成。请核对执行记录，检查模型服务后重试。',
  approval_required: '本轮已产生待审批计划。请在执行中心完成审批及执行核验。',
};

export default function AgentReview({ review, runId }: { review: Review; runId: string }) {
  const download = () => {
    const url = URL.createObjectURL(new Blob([JSON.stringify(review, null, 2) + '\n'], { type: 'application/json' }));
    const link = document.createElement('a'); link.href = url; link.download = `agent-review-${runId}.json`;
    link.click(); setTimeout(() => URL.revokeObjectURL(url), 1000);
  };
  return <details className={`agent-review agent-review-${review.status}`}>
    <summary>分析 → 复核 <span>{statuses[review.status]}</span></summary>
    <div className="agent-review-body">
      <ol className="agent-review-stages" aria-label="本轮 Agent 阶段用量">{review.stages.map(stage => <li key={stage.role}>
        <strong>{stage.role === 'analyst' ? '分析 Agent' : '复核 Agent'}</strong>
        <span><b>{stage.modelCalls}</b> 次模型调用</span><span><b>{stage.tokens.toLocaleString('zh-CN')}</b> tokens</span>
      </li>)}</ol>
      {!!review.reasons.length && <ul className="agent-review-reasons" aria-label="复核原因">{review.reasons.map(reason => <li key={reason}>{reasons[reason] || '复核未确认答复，请查看执行记录。'}</li>)}</ul>}
      <p className="agent-review-note">这是本轮独立复核记录，不代表人工批准或业务健康。复核不会撤销已发生的工具调用；最新状态请查看执行中心。</p>
      <button type="button" className="agent-review-export" onClick={download}><Download size={14} aria-hidden="true" />导出复核 JSON</button>
    </div>
  </details>;
}
