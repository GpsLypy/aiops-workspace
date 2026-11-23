import type { Item } from './data';

export type User = { id: string; username: string; name: string; role: 'admin' | 'member'; active: boolean };
export type Resource = Item & {
  ownerId: string; canManage: boolean; visibility: 'public' | 'private';
  readerIds: string[]; managerIds: string[]; allowedTools: string[];
  skillIds: string[]; mcpIds: string[]; knowledgeIds: string[]; hasToken: boolean;
  revision: number; publication: 'draft' | 'published'; toolPolicies: Record<string, unknown>;
  skillPackage?: { filename: string; base64: string };
  service: string; environment: 'test' | 'staging' | 'production'; documentVersion: string; expiresAt: string | null; sourceUrl: string;
};
export type TargetBinding = { resourceId: string; tool: string; environment: string; arguments: Record<string, string | number | boolean> };
export type Source = { resourceId: string; title: string; score: number; offset: number };
export type McpFailure = { resourceId: string; service: string; phase: 'discovery'; code: 'MCP_UNAVAILABLE'; message: string };
export type ContextStats = { mode: 'budgeted'; consideredMessages: number; retainedMessages: number; omittedMessages: number; beforeBytes: number; afterBytes: number; budgetBytes: number };
export type RolloutDraft = { agentIds: string[]; includeGeneral: boolean; contextMode: 'recent' | 'budgeted'; retrievalMode: 'ranked' | 'diverse'; evidenceReports: boolean };
export type RuntimePolicy = Omit<RolloutDraft, 'agentIds' | 'includeGeneral'> & { version: 1; revision: number; activeRevision: number | null; mode: 'deployment' | 'active' | 'paused'; matched: boolean; runtime: 'agentscope'; contextMaxBytes: number };
// Persisted messages retain the engine identity used before the migration.
export type HistoricalRuntimePolicy = Omit<RuntimePolicy, 'runtime'> & { runtime: 'agentscope' | 'legacy' };
export type AgentRollout = { version: 1; revision: number; draftRevision: number; mode: RuntimePolicy['mode']; activeRevision: number | null; draft: RolloutDraft; active: RolloutDraft | null; runtimeRequired: true; checking: boolean;
  preflight: { checkedAt: string; expiresAt: string; checkedBy: string; draftRevision: number } | null; preflightValid: boolean;
  deployment: { runtime: 'agentscope'; workerMode: string; contextMode: string; contextMaxBytes: number; retrievalMode: string; evidenceReports: boolean };
  agents: { id: string; name: string; eligible: boolean }[]; health?: { mode: string; ready: boolean; worker?: { mode: string; ready: boolean } } };
export type EvidenceReport = { version: 1; runId: string; generatedAt: string; outcome: 'completed' | 'awaiting_approval' | 'error'; businessStatus: 'not_assessed'; runtime: string | null; runtimeVersion: string | null; tokens: number; retrievalMode: string; context: ContextStats | null; gaps: string[];
  toolSteps: { stepId: string; resourceId: string; revision: number; tool: string; environment: string; risk: string; status: string; recordedAt: string }[];
  sources: { resourceId: string; title: string; revision: number; documentVersion: string; offset: number }[]; mcpFailures: McpFailure[] };
export type AgentReview = { version: 1; mode: 'independent'; status: 'accepted' | 'blocked' | 'unavailable' | 'skipped'; reasons: string[];
  stages: { role: 'analyst' | 'reviewer'; modelCalls: number; tokens: number }[] };
export type TraceStatus = 'running' | 'completed' | 'awaiting_approval' | 'error' | 'cancelled' | 'blocked';
export type TraceNode = { id: string; spanId?: string; parentSpanId?: string; agentRunId?: string; parentAgentRunId?: string; parentNodeId?: string; kind: 'request' | 'context' | 'skill' | 'knowledge' | 'mcp' | 'model' | 'tool' | 'review' | 'answer' | 'delegation' | 'subagent' | 'handoff' | 'aggregate' | 'budget'; label: string;
  status: TraceStatus | 'skipped'; startedAt?: string; finishedAt?: string; durationMs?: number; summary: string; details?: { label: string; value: string }[] };
export type ExecutionTrace = { version: 1; runId: string; traceId?: string; spanId?: string; startedAt: string; finishedAt?: string; durationMs: number; status: TraceStatus; omittedNodes?: number; omittedEdges?: number;
  nodes: TraceNode[]; edges: { from: string; to: string; label?: string }[] };
export type AgentDelegation = { version: 1; mode: 'auto' | 'off'; maxDepth: number; maxChildren: number; maxParallel: number; childModelRounds: number; modelRoundLimit: number;
  status: 'idle' | 'running' | 'completed' | 'partial' | 'cancelled' | 'error'; children: { id: string; parentAgentRunId: string; agentId: string | null; agentName: string;
    status: 'queued' | 'running' | 'completed' | 'failed' | 'cancelled' | 'interrupted'; nodeId: string | null; startedAt: string; finishedAt?: string; durationMs: number;
    modelCalls: number; tokens: number; toolSteps: number; sourceCount: number; errorCode?: string }[] };
export type Message = { seq: number; role: string; content: string; created: string; metadata: { runId?: string; sources?: Source[]; tools?: { service: string; tool: string; isError: boolean }[]; mcpFailures?: McpFailure[]; context?: ContextStats; evidenceReport?: EvidenceReport; executionTrace?: ExecutionTrace; agentReview?: AgentReview; agentDelegation?: AgentDelegation; runtimePolicy?: HistoricalRuntimePolicy; model?: string; model_reasoning_effort?: ReasoningEffort | null } };
export type Conversation = { id: string; user_id: string; title: string; owner: string; agent_id: string | null; created: string; updated: string; message_count: number; busy_until: number; messages?: Message[] };
export type Task = { id: string; name: string; prompt: string; user_id: string; owner: string; agent_id: string | null; schedule_type: 'once' | 'cron'; cron: string; timezone: string; run_at: string; enabled: number; next_run: string | null; last_status: string | null; lease_until: number; updated: string; targetBinding: TargetBinding | null; notification: NotificationConfig; inspectionRules: InspectionRule[] };
export type TaskRun = { id: string; status: string; started: string; finished: string | null; result: string | null; error: string | null; conversation_id: string | null; assessment: Assessment | null; deliveries: { id: string; status: string; channelName: string; last_error: string | null; attempts: number; next_attempt: number }[] };
export type Tool = { name: string; description?: string; inputSchema: unknown };
export type ReasoningEffort = 'low' | 'medium' | 'high';
export type ModelConfig = { baseUrl: string; model: string; apiType: 'responses'; temperature: number | null; model_reasoning_effort: ReasoningEffort | null; firstByteTimeoutSeconds: number; streamIdleTimeoutSeconds: number; hasApiKey: boolean; configured: boolean; reasoningEffortOnly?: boolean; timeoutSettingsEnabled?: boolean };

export async function api<T>(path: string, options: RequestInit = {}): Promise<T> {
  const response = await fetch(`/api${path}`, { ...options, headers: { 'Content-Type': 'application/json', ...options.headers } });
  let result;
  try { result = await response.json(); } catch { throw new Error('后端服务不可用，请确认 API 服务已启动'); }
  if (!response.ok) {
    if (response.status === 401 && !path.startsWith('/auth/')) window.dispatchEvent(new Event('auth-expired'));
    throw new Error(result.error || `请求失败 (${response.status})`);
  }
  return result as T;
}
export const post = <T,>(path: string, data: unknown = {}) => api<T>(path, { method: 'POST', body: JSON.stringify(data) });
export const put = <T,>(path: string, data: unknown) => api<T>(path, { method: 'PUT', body: JSON.stringify(data) });
export const patch = <T,>(path: string, data: unknown) => api<T>(path, { method: 'PATCH', body: JSON.stringify(data) });
export const remove = (path: string) => api(path, { method: 'DELETE', body: '{}' });
export type ProjectDocument = { path: string; title: string; group: string; content: string; revision: string; updatedAt: string; size: number };
export type DocumentCatalog = { documents: ProjectDocument[]; canEdit: boolean };
export const errorText = (e: unknown) => e instanceof Error ? e.message : '操作失败';
export const dateText = (date?: string | null) => date ? new Date(date).toLocaleString('zh-CN', { hour12: false }) : '—';

export type ModelRetry = { phase: 'waiting' | 'connecting'; attempt: number; maxAttempts: number; delayMs: number; reason: 'connection' | 'timeout' | 'rate_limit' | 'service_unavailable'; timeoutKind?: 'first_byte' | 'stream_idle'; timeoutSeconds?: number };
export type ChatEvent = { type: string; reason?: ModelRetry['reason'] | 'retry' | 'display_disconnect'; phase?: ModelRetry['phase']; attempt?: number; maxAttempts?: number; delayMs?: number; timeoutKind?: ModelRetry['timeoutKind']; timeoutSeconds?: number; trace?: ExecutionTrace; id?: string; text?: string; error?: string; conversationId?: string; runId?: string; streamId?: string; metadata?: Message['metadata'] };

function chatWait(ms: number, signal: AbortSignal) {
  return new Promise<void>((resolve, reject) => {
    signal.throwIfAborted();
    const stop = () => { clearTimeout(timer); signal.removeEventListener('abort', stop); reject(signal.reason); };
    const timer = setTimeout(() => { signal.removeEventListener('abort', stop); resolve(); }, ms);
    signal.addEventListener('abort', stop, { once: true });
  });
}
export async function chatStream(data: unknown, onEvent: (event: ChatEvent) => void, signal?: AbortSignal) {
  signal?.throwIfAborted();
  let runId = '', streamId = '', terminal = false;
  const requestKey = data && typeof data === 'object' && 'requestKey' in data && typeof data.requestKey === 'string' ? data.requestKey : '';
  const display = new AbortController();
  const displaySignal = signal ? AbortSignal.any([signal, display.signal]) : display.signal;
  let idleTimer: ReturnType<typeof setTimeout>;
  const keepAlive = () => { clearTimeout(idleTimer); idleTimer = setTimeout(() => display.abort(), 45000); };
  let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
  const consume = (line: string) => {
    if (!line.trim() || terminal) return;
    let event: ChatEvent;
    try { event = JSON.parse(line) as ChatEvent; } catch { throw new Error('显示消息格式无效，请核对原执行结果，避免重复提交'); }
    if (!event || typeof event.type !== 'string') throw new Error('显示消息格式无效，请核对原执行结果，避免重复提交');
    if (event.type === 'execution' && event.runId) runId = event.runId;
    if (event.type === 'message_start' && event.streamId) streamId = event.streamId;
    if (event.type === 'done' || event.type === 'error') terminal = true;
    onEvent(event);
  };
  keepAlive();
  try {
    const response = await fetch('/api/chat', { method: 'POST', headers: { 'Content-Type': 'application/json', Accept: 'application/x-ndjson' }, body: JSON.stringify(data), signal: displaySignal });
    if (!response.ok) {
      if (response.status === 401) window.dispatchEvent(new Event('auth-expired'));
      const result = await response.json();
      throw new Error(result.error || '对话请求失败');
    }
    if (!response.body) throw new Error('服务器返回空响应');
    reader = response.body.getReader();
    const decoder = new TextDecoder('utf-8', { fatal: true });
    let buffer = '';
    while (!terminal) {
      const { done, value } = await reader.read();
      if (done) { buffer += decoder.decode(); break; }
      keepAlive();
      buffer += decoder.decode(value, { stream: true });
      if (buffer.length > 2_000_000) throw new Error('显示消息超过大小限制，请核对原执行结果');
      const lines = buffer.split('\n'); buffer = lines.pop() || '';
      lines.forEach(consume);
    }
    consume(buffer);
  } catch (error) {
    if (signal?.aborted) throw signal.reason;
    if (!display.signal.aborted && !(error instanceof TypeError)) throw error;
    // A lost response does not prove that the server failed to accept the POST.
  } finally {
    clearTimeout(idleTimer!);
    if (reader) { await reader.cancel().catch(() => {}); reader.releaseLock(); }
  }
  if (terminal) return;
  const until = Date.now() + 450000;
  const recoverySignal = signal ? AbortSignal.any([signal, AbortSignal.timeout(450000)]) : AbortSignal.timeout(450000);
  const read = async (path: string) => {
    const res = await fetch(path, { signal: AbortSignal.any([recoverySignal, AbortSignal.timeout(15000)]) });
    if (res.status === 401) window.dispatchEvent(new Event('auth-expired'));
    if (!res.ok) throw new Error(res.status === 404 ? '没有找到本人的原执行，请核对会话与执行记录，避免重复提交' : '无法恢复显示连接，请在执行中心查看结果');
    return await res.json() as { id?: string; status: string; error?: string; conversation_id?: string; result?: { text?: string; conversationId?: string; metadata?: Message['metadata'] } };
  };
  // Recover the accepted execution by its key if its first acknowledgement was lost.
  if (!runId && requestKey) {
    onEvent({ type: 'progress', text: '显示连接中断，正在核对原问题是否已受理…' });
    let failures = 0;
    while (!runId) {
      try { runId = (await read(`/api/executions/request/${encodeURIComponent(requestKey)}`)).id || ''; }
      catch (error) {
        if (recoverySignal.aborted || !(error instanceof TypeError || (error instanceof DOMException && error.name === 'TimeoutError')) || ++failures >= 5) throw error;
        await chatWait(1000, recoverySignal); continue;
      }
      if (!runId) throw new Error('无法确认原执行，请核对会话与执行记录，避免重复提交');
    }
    onEvent({ type: 'execution', runId });
  }
  if (!runId) throw new Error('连接中断，请重新打开会话检查执行结果，避免重复提交');
  onEvent({ type: 'message_reset', streamId, reason: 'display_disconnect' });
  onEvent({ type: 'progress', text: '显示连接中断，正在重新连接已有执行…' });
  let failures = 0;
  while (Date.now() < until && !recoverySignal.aborted) {
    let run;
    try { run = await read(`/api/executions/${encodeURIComponent(runId)}`); }
    catch (error) {
      if (recoverySignal.aborted || !(error instanceof TypeError || (error instanceof DOMException && error.name === 'TimeoutError')) || ++failures >= 5) throw error;
      await chatWait(1000, recoverySignal); continue;
    }
    failures = 0;
    if (run.conversation_id) onEvent({ type: 'session', id: run.conversation_id });
    if (!['queued', 'running'].includes(run.status)) {
      if (['success', 'awaiting_approval'].includes(run.status) && typeof run.result?.text === 'string') onEvent({ type: 'done', ...run.result, runId });
      else onEvent({ type: 'error', error: run.error || '执行已结束但未生成完成答复，请在执行中心查看结果', runId, conversationId: run.conversation_id });
      return;
    }
    await chatWait(1000, recoverySignal);
  }
  recoverySignal.throwIfAborted();
  throw new Error('恢复显示连接超时，请在执行中心查看结果，避免重复提交');
}

export type NotificationConfig = { channelIds: string[]; mode: 'all' | 'issues'; recovery: boolean; repeatMinutes: number };
export type InspectionRule = { label: string; resourceId: string; tool: string; arguments: Record<string, string | number | boolean>; path: string; operator: 'eq' | 'ne' | 'gt' | 'gte' | 'lt' | 'lte' | 'fresh'; expected: string | number | boolean };
export type Assessment = { status: 'healthy' | 'abnormal' | 'unknown'; reason: string; findings: { index: number; label: string; path: string; status: string; reason?: string; evidence: { stepId: string; actual: unknown; queriedAt: string; reason: string; status: string }[] }[] };
export type NotificationChannel = { id: string; name: string; kind: 'webhook' | 'wecom'; enabled: boolean; revision: number; updated: string; endpointOrigin?: string; allowedUserIds?: string[]; hasEndpoint?: boolean; hasSecret?: boolean; hasToken?: boolean };
export type Delivery = { id: string; status: string; title: string; channel_name: string; channel_kind: string; executionStatus?: string; assessmentStatus?: string; task_id?: string; task_run_id?: string; attempts: number; next_attempt: number; last_error: string | null; created: string; delivered_at: string | null; preview?: string; payload?: { assessment?: Assessment; conversationId?: string } };
