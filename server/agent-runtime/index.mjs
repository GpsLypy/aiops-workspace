import { completion } from '../model.mjs';
import { httpError } from '../store.mjs';
import { runAgentScope, defaultPython } from './agentscope.mjs';

export function runtimeOptions(options = {}) {
  const runtime = options.runtime ?? process.env.AGENT_RUNTIME ?? 'agentscope';
  if (runtime !== 'agentscope') throw new Error('AGENT_RUNTIME only supports agentscope; the legacy runtime was removed. Remove AGENT_RUNTIME=legacy and install agent-worker dependencies.');
  const python = options.python ?? process.env.AGENTSCOPE_PYTHON ?? defaultPython;
  if ((options.agentIds !== undefined && (!Array.isArray(options.agentIds) || options.agentIds.length)) || (process.env.AGENTSCOPE_AGENT_IDS || '').split(',').some(v => v.trim())) {
    throw new Error('AGENTSCOPE_AGENT_IDS / agentIds runtime allowlists were removed; all agents use AgentScope. Remove this configuration and use enhancement scopes in agent-rollout instead.');
  }
  const workerMode = options.workerMode ?? process.env.AGENTSCOPE_WORKER_MODE ?? 'prefork';
  if (!['cold', 'prefork'].includes(workerMode)) throw new Error('AGENTSCOPE_WORKER_MODE must be cold or prefork');
  const contextMode = options.contextMode ?? process.env.AGENT_CONTEXT_MODE ?? 'recent';
  if (!['recent', 'budgeted'].includes(contextMode)) throw new Error('AGENT_CONTEXT_MODE must be recent or budgeted');
  const retrievalMode = options.retrievalMode ?? process.env.AGENT_RETRIEVAL_MODE ?? 'ranked';
  if (!['ranked', 'diverse'].includes(retrievalMode)) throw new Error('AGENT_RETRIEVAL_MODE must be ranked or diverse');
  const reportOption = options.evidenceReports ?? process.env.AGENT_EVIDENCE_REPORTS ?? false;
  if (![true, false, 'true', 'false'].includes(reportOption)) throw new Error('AGENT_EVIDENCE_REPORTS must be true or false');
  const integer = (key, name, fallback, min, max) => {
    const value = Number(options[key] ?? process.env[name] ?? fallback);
    if (!Number.isSafeInteger(value) || value < min || value > max) throw new Error(`${name} must be an integer between ${min} and ${max}`);
    return value;
  };
  return { runtime, python, workerMode, contextMode, retrievalMode, evidenceReports: reportOption === true || reportOption === 'true',
    contextMaxBytes: integer('contextMaxBytes', 'AGENT_CONTEXT_MAX_BYTES', 16000, 1000, 128000),
    poolSize: integer('poolSize', 'AGENTSCOPE_POOL_SIZE', 2, 1, 8),
    poolMaxRuns: integer('poolMaxRuns', 'AGENTSCOPE_POOL_MAX_RUNS', 100, 1, 10000),
    poolMaxAgeMs: integer('poolMaxAgeMs', 'AGENTSCOPE_POOL_MAX_AGE_MS', 1800000, 1000, 86400000),
    startupTimeoutMs: integer('startupTimeoutMs', 'AGENTSCOPE_STARTUP_TIMEOUT_MS', 15000, 100, 120000),
    poolQueueMs: integer('poolQueueMs', 'AGENTSCOPE_POOL_QUEUE_MS', 30000, 1, 120000),
    poolMaxPending: integer('poolMaxPending', 'AGENTSCOPE_POOL_MAX_PENDING', 100, 1, 1000),
  };
}

export async function runRuntime({ runtime = 'agentscope', python, driver, store, context, runtimeRunId = context.runId, messages, tools, signal, event, validateCall, executeCall, onFailure, maxModelCalls = 6, stats = { modelCalls: 0, tokens: 0 }, beforeRound, beforeModel, onModel, streamText = false, model_reasoning_effort }) {
  if (runtime !== 'agentscope') throw httpError(422, '旧 Agent 运行时已移除，必须使用 AgentScope');
  if (!Number.isSafeInteger(maxModelCalls) || maxModelCalls < 1 || maxModelCalls > 6) throw httpError(422, '模型调用上限无效');
  const pendingCalls = [];
  const completedCalls = new Map();
  let calls = 0, rounds = 0, finished = false, awaitingApproval = false;
  const usage = { total_tokens: 0 };
  const model = async () => {
    if (signal.aborted) throw httpError(504, '执行超时或已取消');
    if (pendingCalls.length || finished || awaitingApproval) throw httpError(409, '本轮工具尚未完成或执行已经结束');
    if (rounds >= maxModelCalls) throw httpError(422, `已达到 ${maxModelCalls} 轮工具调用上限，请缩小问题范围`);
    beforeModel?.();
    beforeRound?.();
    event({ type: 'progress', text: calls ? '正在分析工具结果…' : '正在生成回复…' });
    let estimate = context.beforeModel([...messages, { tools }]);
    rounds++; calls++;
    stats.modelCalls++;
    let modelName;
    const observe = observation => onModel?.({ ...observation, model: modelName });
    let used = 0, requestOpen = false, reservationOpen = true;
    try {
      const streamBase = `${runtimeRunId}:${calls}`;
      let streamId = `${streamBase}:1`;
      if (streamText) event({ type: 'message_start', streamId });
      let hasTools = false;
      const result = await completion(store, messages, tools, signal, chunk => {
        if (signal.aborted) throw httpError(504, '执行超时或已取消');
        if (chunk.type === 'retry') {
          hasTools = false;
          if (streamText) event({ type: 'message_reset', streamId, reason: 'retry' });
          event({ type: 'model_retry', streamId, phase: 'waiting', attempt: chunk.attempt, maxAttempts: chunk.maxAttempts, delayMs: chunk.delayMs, reason: chunk.reason, timeoutKind: chunk.timeoutKind, timeoutSeconds: chunk.timeoutSeconds });
          event({ type: 'progress', text: `模型连接中断，正在重新连接 ${chunk.attempt - 1}/${chunk.maxAttempts - 1}…` });
        } else if (chunk.type === 'retry_ready') {
          streamId = `${streamBase}:${chunk.attempt}`;
          if (streamText) event({ type: 'message_start', streamId, reason: 'retry' });
          event({ type: 'model_retry', streamId, phase: 'connecting', attempt: chunk.attempt, maxAttempts: chunk.maxAttempts, delayMs: 0, reason: chunk.reason, timeoutKind: chunk.timeoutKind, timeoutSeconds: chunk.timeoutSeconds });
        } else if (chunk.type === 'tool_call') {
          hasTools = true;
          if (streamText) event({ type: 'message_reset', streamId });
        } else if (streamText && !hasTools) event({ type: 'message_delta', streamId, text: chunk.text });
      }, identity => {
        modelName = identity.model;
        requestOpen = true;
        return observe({ phase: 'start', round: calls });
      }, undefined, () => {
        // Failed attempts may have incurred provider usage. Reserve the full
        // estimate before retrying. Retries consume usage, not another tool round.
        context.charge(null, estimate);
        reservationOpen = false;
        usage.total_tokens += estimate; stats.tokens += estimate;
        observe({ phase: 'end', round: calls, status: 'error', tokens: estimate });
        requestOpen = false;
        beforeModel?.();
        estimate = context.beforeModel([...messages, { tools }]);
        reservationOpen = true;
        calls++; stats.modelCalls++;
      }, { model_reasoning_effort });
      if (streamText && result.message.tool_calls?.length && !hasTools) event({ type: 'message_reset', streamId });
      context.charge(result.usage, estimate);
      reservationOpen = false;
      const reported = Number(result.usage?.total_tokens);
      used = Number.isFinite(reported) && reported >= 0 ? Math.ceil(reported) : estimate;
      usage.total_tokens += used;
      stats.tokens += used;
      const message = result.message;
      if (!message.tool_calls?.length) {
        finished = true;
        observe({ phase: 'end', round: calls, status: 'completed', tokens: used, toolCalls: 0 });
        return result;
      }
      if (message.tool_calls.length > 12) throw httpError(502, '单次模型请求的工具数量超过限制');
      messages.push(message);
      const ids = new Set();
      const workerCalls = message.tool_calls.map(call => {
        if (typeof call.id !== 'string' || !call.id || call.id.length > 150 || ids.has(call.id)) throw httpError(502, '模型返回了无效或重复的工具调用标识');
        ids.add(call.id);
        validateCall(call); // Reject before AgentScope can repair malformed arguments.
        const alias = `${calls}:${call.id}`;
        pendingCalls.push({ alias, call });
        return { ...call, id: alias };
      });
      observe({ phase: 'end', round: calls, status: 'completed', tokens: used, toolCalls: workerCalls.length });
      // Opaque provider reasoning stays exclusively in Node's canonical transcript.
      return { message: { ...message, responsesReasoning: undefined, tool_calls: workerCalls }, usage: result.usage };
    } catch (error) {
      if (reservationOpen) {
        if (requestOpen) {
          context.charge(null, estimate);
          usage.total_tokens += estimate; stats.tokens += estimate; used = estimate;
        } else context.releaseModel?.(estimate);
      }
      if (requestOpen) observe({ phase: 'end', round: calls, status: signal.aborted ? 'cancelled' : 'error', tokens: used });
      throw error;
    }
  };
  const tool = async (incoming, identity = null) => {
    if (signal.aborted) throw httpError(504, '执行超时或已取消');
    const fingerprint = JSON.stringify({ incoming, identity });
    const cached = completedCalls.get(incoming.id);
    if (cached) {
      if (cached.fingerprint !== fingerprint) throw httpError(409, '工具调用标识已经用于不同的参数');
      return cached.result;
    }
    const next = pendingCalls[0];
    if (awaitingApproval || !next || incoming.id !== next.alias || incoming.function?.name !== next.call.function?.name || incoming.function?.arguments !== next.call.function?.arguments) throw httpError(403, 'Worker 工具请求与模型原始调用不匹配');
    const result = await executeCall(next.call, identity);
    pendingCalls.shift();
    if (result.pending) awaitingApproval = true;
    else messages.push({ role: 'tool', tool_call_id: next.call.id, content: result.content });
    completedCalls.set(incoming.id, { fingerprint, result });
    return result;
  };
  const run = driver?.run ?? runAgentScope;
  const result = await run({ runId: runtimeRunId, messages, tools, signal, event, python, model, tool, onFailure });
  return { ...result, usage, modelCalls: calls };
}
