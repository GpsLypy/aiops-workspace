import { useEffect, useState } from 'react';
import type { ModelRetry } from '../api';

export type ChatRetry = ModelRetry & { receivedAt: number };
const reasons = { connection: '连接暂时中断', rate_limit: '模型服务暂时限流', service_unavailable: '模型服务暂时不可用' };
const retryReason = (retry: ChatRetry) => retry.reason === 'timeout'
  ? retry.timeoutKind === 'stream_idle'
    ? `流式响应已静默 ${retry.timeoutSeconds ?? 180} 秒`
    : `等待首个数据块超过 ${retry.timeoutSeconds ?? 90} 秒`
  : reasons[retry.reason];

export function formatRunElapsed(durationMs: number) {
  const seconds = Math.max(0, Math.floor(durationMs / 1000));
  return seconds < 60 ? `${seconds}秒` : `${Math.floor(seconds / 60)}分${seconds % 60}秒`;
}

export default function ChatRunStatus({ text, startedAt, retry, stopping }: {
  text: string; startedAt: number; retry: ChatRetry | null; stopping: boolean;
}) {
  const [now, setNow] = useState(Date.now());
  useEffect(() => { const timer = window.setInterval(() => setNow(Date.now()), 250); return () => window.clearInterval(timer); }, []);
  const elapsed = formatRunElapsed(now - startedAt);
  const remaining = retry ? Math.max(0, Math.ceil((retry.receivedAt + retry.delayMs - Math.max(now, retry.receivedAt)) / 1000)) : 0;
  return <div className="chat-progress chat-run-status">
    <span className="chat-run-time" aria-live="off">已处理 {elapsed}</span>
    <div className="chat-run-copy" role="status" aria-live="polite">
      <p>{stopping ? '正在停止生成…' : retry ? `正在重新连接 ${retry.attempt - 1}/${retry.maxAttempts - 1}…` : text}</p>
      {retry && !stopping && <small>{retryReason(retry)} · {retry.phase === 'waiting' && remaining > 0
        ? <span aria-hidden="true">等待 {remaining} 秒后重试</span> : '正在建立连接'}</small>}
    </div>
  </div>;
}
