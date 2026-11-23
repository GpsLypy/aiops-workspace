import { z } from 'zod';
import { admin } from './auth.mjs';
import { httpUrl } from './resources.mjs';
import { httpError } from './store.mjs';
import { safeFetch, protectMessages, positive } from './security.mjs';
import { readModelStream } from './model-stream.mjs';
import { setTimeout as delay } from 'node:timers/promises';
import { DEFAULT_MODEL_FIRST_BYTE_TIMEOUT_SECONDS, DEFAULT_MODEL_STREAM_IDLE_TIMEOUT_SECONDS, MODEL_MAX_ATTEMPTS, runTimeoutMs } from './request-policy.mjs';
import { retryDelay, retryAfter, quotaCodes } from './model-retry.mjs';

export const reasoningEffortSchema = z.enum(['low', 'medium', 'high']).nullable();
const firstByteTimeoutSchema = z.number().int().min(1).max(120);
const streamIdleTimeoutSchema = z.number().int().refine(value => value === 0 || (value >= 60 && value <= 600), '流式静默超时必须为 0，或 60 至 600 秒');

function configuredTimeout(value, fallback, schema, label) {
  const result = schema.safeParse(value ?? fallback);
  if (!result.success) throw httpError(422, `${label}配置无效`);
  return result.data;
}

export function modelConfig(store) {
  const saved = store.setting('model');
  if (saved?.apiType && !['responses', 'chat_completions'].includes(saved.apiType)) throw httpError(422, '模型 API 仅支持 Responses，请重新保存模型配置');
  const config = saved ? { ...saved, apiType: 'responses', apiKey: store.decrypt(saved.apiKeyEncrypted) } : {
    apiType: process.env.MODEL_API_TYPE || 'responses',
    baseUrl: process.env.MODEL_BASE_URL || '', model: process.env.MODEL_NAME || '', apiKey: process.env.MODEL_API_KEY || '',
    temperature: process.env.MODEL_TEMPERATURE === 'none' ? null : process.env.MODEL_TEMPERATURE === undefined ? 0.3 : Number(process.env.MODEL_TEMPERATURE),
    model_reasoning_effort: process.env.MODEL_REASONING_EFFORT === 'none' ? null : process.env.MODEL_REASONING_EFFORT ?? null,
    firstByteTimeoutSeconds: process.env.MODEL_FIRST_BYTE_TIMEOUT_SECONDS === undefined ? DEFAULT_MODEL_FIRST_BYTE_TIMEOUT_SECONDS : Number(process.env.MODEL_FIRST_BYTE_TIMEOUT_SECONDS),
    streamIdleTimeoutSeconds: process.env.MODEL_STREAM_IDLE_TIMEOUT_SECONDS === undefined ? DEFAULT_MODEL_STREAM_IDLE_TIMEOUT_SECONDS : Number(process.env.MODEL_STREAM_IDLE_TIMEOUT_SECONDS),
  };
  if (config.apiType !== 'responses') throw httpError(422, '模型 API 仅支持 Responses，请将 MODEL_API_TYPE 设置为 responses');
  if (config.temperature != null && (typeof config.temperature !== 'number' || !Number.isFinite(config.temperature) || config.temperature < 0 || config.temperature > 2)) throw httpError(422, 'MODEL_TEMPERATURE 必须为 0 至 2 的数字或 none');
  config.model_reasoning_effort ??= null;
  config.firstByteTimeoutSeconds = configuredTimeout(config.firstByteTimeoutSeconds, DEFAULT_MODEL_FIRST_BYTE_TIMEOUT_SECONDS, firstByteTimeoutSchema, '流式首字节超时');
  config.streamIdleTimeoutSeconds = configuredTimeout(config.streamIdleTimeoutSeconds, DEFAULT_MODEL_STREAM_IDLE_TIMEOUT_SECONDS, streamIdleTimeoutSchema, '流式静默超时');
  if (store.reasoningEffortOnly) {
    const override = store.setting('poc_model_reasoning_effort');
    if (override !== null && override !== undefined) config.model_reasoning_effort = reasoningEffortSchema.parse(override.effort);
    if (store.timeoutSettingsEnabled) {
      const timeouts = store.setting('poc_model_timeouts');
      if (timeouts !== null && timeouts !== undefined) {
        config.firstByteTimeoutSeconds = configuredTimeout(timeouts.firstByteTimeoutSeconds, DEFAULT_MODEL_FIRST_BYTE_TIMEOUT_SECONDS, firstByteTimeoutSchema, '流式首字节超时');
        config.streamIdleTimeoutSeconds = configuredTimeout(timeouts.streamIdleTimeoutSeconds, DEFAULT_MODEL_STREAM_IDLE_TIMEOUT_SECONDS, streamIdleTimeoutSchema, '流式静默超时');
      }
    }
  }
  if (!reasoningEffortSchema.safeParse(config.model_reasoning_effort).success) throw httpError(422, '模型推理强度必须为 low、medium、high 或 none（服务商默认）');
  return config;
}
export function publicModel(store) {
  const c = modelConfig(store);
  return { baseUrl: c.baseUrl, model: c.model, apiType: c.apiType, temperature: c.temperature, model_reasoning_effort: c.model_reasoning_effort,
    firstByteTimeoutSeconds: c.firstByteTimeoutSeconds, streamIdleTimeoutSeconds: c.streamIdleTimeoutSeconds,
    hasApiKey: !!c.apiKey, configured: !!(c.baseUrl && c.model), ...(store.reasoningEffortOnly ? { reasoningEffortOnly: true, timeoutSettingsEnabled: store.timeoutSettingsEnabled } : {}) };
}

function requestWatchdog(signal, firstByteMs, idleMs) {
  const controller = new AbortController();
  let timer = null, timeoutKind = null;
  const arm = (ms, kind) => {
    if (timer !== null) clearTimeout(timer);
    timer = null;
    if (ms === 0) return;
    timer = setTimeout(() => {
      timeoutKind = kind;
      controller.abort(new DOMException('Model stream timeout', 'TimeoutError'));
    }, ms);
  };
  arm(firstByteMs, 'first_byte');
  return {
    signal: signal ? AbortSignal.any([signal, controller.signal]) : controller.signal,
    onChunk: () => arm(idleMs, 'stream_idle'),
    stop: () => { if (timer !== null) clearTimeout(timer); timer = null; },
    get timeoutKind() { return timeoutKind; },
  };
}

function responsesInput(messages) {
  return messages.flatMap(message => {
    if (message.role === 'tool') return [{ type: 'function_call_output', call_id: message.tool_call_id, output: message.content }];
    const items = [...(message.responsesReasoning || [])];
    if (message.content || !message.tool_calls?.length) items.push({ role: message.role, content: message.content });
    for (const call of message.tool_calls || []) items.push({ type: 'function_call', call_id: call.id, name: call.function.name, arguments: call.function.arguments });
    return items;
  });
}

function responsesResult(result) {
  if (result?.error || result?.status !== 'completed') throw httpError(502, '模型 Responses 请求未完成，请检查输出上限或模型服务状态');
  if (!Array.isArray(result?.output)) throw httpError(502, '模型服务未返回有效消息');
  const content = []; const toolCalls = []; const reasoning = [];
  for (const item of result.output) {
    if (item?.type === 'reasoning') reasoning.push(item);
    else if (item?.type === 'message' && item.role === 'assistant' && Array.isArray(item.content)) {
      for (const part of item.content) {
        if (part?.type === 'output_text' && typeof part.text === 'string') content.push(part.text);
        if (part?.type === 'refusal' && typeof part.refusal === 'string') content.push(part.refusal);
      }
    } else if (item?.type === 'function_call') {
      if (typeof item.call_id !== 'string' || !item.call_id || typeof item.name !== 'string' || !item.name || typeof item.arguments !== 'string') throw httpError(502, '模型服务返回了无效工具调用');
      toolCalls.push({ id: item.call_id, type: 'function', function: { name: item.name, arguments: item.arguments } });
    }
  }
  if (!content.length && !toolCalls.length) throw httpError(502, '模型服务未返回有效消息');
  return {
    message: { role: 'assistant', content: content.join(''), ...(toolCalls.length ? { tool_calls: toolCalls, responsesReasoning: reasoning } : {}) },
    usage: result.usage ? { ...result.usage, prompt_tokens: result.usage.input_tokens, completion_tokens: result.usage.output_tokens } : null,
  };
}

export async function completion(store, messages, tools = [], signal, onEvent, onRequest, onDiagnostic, beforeRetry, options = {}) {
  const config = modelConfig(store);
  const effort = reasoningEffortSchema.parse(options.model_reasoning_effort === undefined ? config.model_reasoning_effort : options.model_reasoning_effort);
  // Report only the selected name from this request's configuration snapshot.
  // Never pass credentials or re-read mutable settings after the network wait.
  if (!config.baseUrl || !config.model) throw httpError(422, '尚未配置模型，请联系管理员在系统设置中配置模型地址、名称与 API Key');
  const url = `${config.baseUrl.replace(/\/+$/, '')}/responses`;
  const protectedMessages = protectMessages(messages);
  const body = { model: config.model, stream: true,
    ...(config.temperature == null ? {} : { temperature: config.temperature }),
    ...(effort == null ? {} : { reasoning: { effort } }),
    input: responsesInput(protectedMessages), max_output_tokens: positive('MODEL_MAX_TOKENS', 4096),
    store: false, include: ['reasoning.encrypted_content'],
    ...(tools.length ? { tools: tools.map(tool => ({ type: 'function', ...tool.function, strict: false })), tool_choice: 'auto' } : {}),
  };
  const wireBody = JSON.stringify(body);
  const timeoutPolicy = options.timeoutPolicy ?? {
    firstByteMs: config.firstByteTimeoutSeconds * 1000,
    idleMs: config.streamIdleTimeoutSeconds * 1000,
  };
  // Retry only this uncompleted model request. Tools run only after a validated
  // terminal result; never replay the Agent execution or a completed tool step.
  for (let attempt = 1; attempt <= MODEL_MAX_ATTEMPTS; attempt++) {
    if (signal?.aborted) throw httpError(502, '模型执行已取消或整轮超时');
    const traceparent = onRequest?.({ model: config.model, model_reasoning_effort: effort });
    const watchdog = requestWatchdog(signal, timeoutPolicy.firstByteMs, timeoutPolicy.idleMs);
    const requestSignal = watchdog.signal;
    const started = performance.now();
    let phase = 'before_headers', outcome = 'error', sseTerminalStatus = null, retryError;
    try {
      let response;
      try {
        response = await safeFetch(url, {
          method: 'POST', redirect: 'error', signal: requestSignal,
          headers: { 'Content-Type': 'application/json', Accept: 'text/event-stream', ...(config.apiKey ? { Authorization: `Bearer ${config.apiKey}` } : {}),
            ...(typeof traceparent === 'string' && /^00-[0-9a-f]{32}-[0-9a-f]{16}-0[01]$/.test(traceparent) ? { traceparent } : {}) },
          body: wireBody,
        });
      } catch (error) {
        const failure = httpError(502, requestSignal.aborted ? '模型请求超时或执行已取消' : '无法连接模型服务，请检查地址和网络');
        failure.retryReason = 'connection';
        if (!error.status && ['ECONNRESET', 'ECONNREFUSED', 'EPIPE', 'ETIMEDOUT', 'EAI_AGAIN'].includes(error.code)) failure.retryable = true;
        throw failure;
      }
      phase = 'headers';
      if (!response.ok) {
        let errorCode;
        if (response.status === 429) {
          try { errorCode = JSON.parse(await readBounded(response, 16000))?.error?.code; }
          catch { /* Only a recognized code changes classification; never publish the body. */ }
        } else await response.body?.cancel();
        const failure = httpError(502, `模型服务返回 HTTP ${response.status}，请检查模型配置、额度与权限${effort && [400, 422].includes(response.status) ? '；若模型不支持所选强度，请改用服务商默认或调整系统默认强度' : ''}`);
        failure.retryable = [408, 429, 500, 502, 503, 504].includes(response.status) && !quotaCodes.has(errorCode);
        if (quotaCodes.has(errorCode)) failure.message = '模型服务额度已用尽，请联系管理员检查额度与费用限制';
        failure.retryReason = response.status === 429 ? 'rate_limit' : response.status === 408 ? 'timeout' : 'service_unavailable';
        failure.retryAfterMs = retryAfter(response.headers);
        if (failure.retryAfterMs > 5000) failure.retryable = false;
        throw failure;
      }
      if (response.headers.get('content-type')?.split(';')[0].trim().toLowerCase() !== 'text/event-stream') {
        await response.body?.cancel();
        throw httpError(502, '模型服务未返回 Responses SSE 流式响应，请检查供应商或网关配置');
      }
      phase = 'streaming'; sseTerminalStatus = 'not_observed';
      const result = await readModelStream(response, { onEvent, onChunk: watchdog.onChunk, signal: requestSignal });
      sseTerminalStatus = 'completed';
      const completionResult = responsesResult(result);
      phase = 'terminal'; outcome = 'completed';
      return completionResult;
    } catch (error) {
      if (phase === 'streaming') {
        if (error?.message === '模型服务报告请求失败，请稍后重试或检查模型状态') sseTerminalStatus = 'failed';
        else if (error?.message === '模型 Responses 输出未完成，请检查输出上限或模型服务状态') sseTerminalStatus = 'incomplete';
      }
      if (watchdog.timeoutKind && !signal?.aborted) {
        const timeoutSeconds = watchdog.timeoutKind === 'first_byte' ? config.firstByteTimeoutSeconds : config.streamIdleTimeoutSeconds;
        const message = watchdog.timeoutKind === 'first_byte'
          ? `模型等待首个数据块超过 ${timeoutSeconds} 秒，请稍后重试`
          : `模型流式响应连续 ${timeoutSeconds} 秒没有数据，请稍后重试`;
        error = Object.assign(httpError(502, message), { retryable: true, retryReason: 'timeout', timeoutKind: watchdog.timeoutKind, timeoutSeconds });
      }
      if (attempt >= MODEL_MAX_ATTEMPTS || signal?.aborted || !(error.retryable || error.code === 'MODEL_STREAM_DISCONNECTED')) throw error;
      retryError = error;
    } finally {
      const diagnostic = Object.freeze({ event: 'model.request', phase, outcome, elapsedMs: Math.max(0, Math.round(performance.now() - started)),
        abortSource: outcome === 'completed' || !requestSignal.aborted ? null : watchdog.timeoutKind ? 'request_timeout' : 'execution',
        timeoutKind: watchdog.timeoutKind, sseTerminalStatus });
      try { onDiagnostic?.(diagnostic); } catch { /* Diagnostics must not change model behavior. */ }
      if (process.env.MODEL_DIAGNOSTICS === 'true') {
        try { console.info(JSON.stringify(diagnostic)); } catch { /* Logging must not change model behavior. */ }
      }
      watchdog.stop();
    }
    const waitMs = retryDelay(attempt, retryError.retryAfterMs);
    const retry = { attempt: attempt + 1, maxAttempts: MODEL_MAX_ATTEMPTS, delayMs: waitMs, reason: retryError.retryReason || 'connection',
      ...(retryError.timeoutKind ? { timeoutKind: retryError.timeoutKind, timeoutSeconds: retryError.timeoutSeconds } : {}) };
    onEvent?.({ type: 'retry', ...retry });
    try { await delay(waitMs, undefined, { signal }); }
    catch { throw httpError(502, '模型请求超时或执行已取消'); }
    // Governance and budget can refuse a retry. Do not hide that refusal.
    beforeRetry?.();
    onEvent?.({ type: 'retry_ready', ...retry });
  }
}
export async function readBounded(response, max) {
  if (!response.body) throw httpError(502, '远程服务返回空响应');
  const reader = response.body.getReader(); const chunks = []; let length = 0;
  try {
    while (true) {
      const { value, done } = await reader.read(); if (done) break;
      length += value.length; if (length > max) throw httpError(502, '远程响应超过大小限制');
      chunks.push(value);
    }
    return Buffer.concat(chunks).toString('utf8');
  } finally { await reader.cancel().catch(() => {}); }
}
export function modelRoutes(app, store, options = {}) {
  store.reasoningEffortOnly = options.reasoningEffortOnly === true;
  store.timeoutSettingsEnabled = store.reasoningEffortOnly && options.timeoutSettingsEnabled === true;
  app.get('/api/model/status', (req, res) => { const c = publicModel(store); res.json({ configured: c.configured, model: c.model, model_reasoning_effort: c.model_reasoning_effort }); });
  app.get('/api/settings/model', admin, (req, res) => res.json(publicModel(store)));
  app.put('/api/settings/model', admin, (req, res) => {
    if (store.reasoningEffortOnly) {
      const allowed = store.timeoutSettingsEnabled ? ['model_reasoning_effort', 'firstByteTimeoutSeconds', 'streamIdleTimeoutSeconds'] : ['model_reasoning_effort'];
      if (Object.keys(req.body ?? {}).some(key => !allowed.includes(key))) throw httpError(403, '本沙箱仅允许修改默认问答强度和流式超时；模型连接由部署配置管理');
      const data = z.object({ model_reasoning_effort: reasoningEffortSchema.optional(),
        ...(store.timeoutSettingsEnabled ? { firstByteTimeoutSeconds: firstByteTimeoutSchema.optional(), streamIdleTimeoutSeconds: streamIdleTimeoutSchema.optional() } : {}) }).strict().refine(value => Object.keys(value).length > 0).parse(req.body);
      if (data.model_reasoning_effort !== undefined) {
        store.setSetting('poc_model_reasoning_effort', { effort: data.model_reasoning_effort });
        store.audit(req.user, 'model.reasoning_effort.configure', 'poc', { effort: data.model_reasoning_effort });
      }
      if (data.firstByteTimeoutSeconds !== undefined || data.streamIdleTimeoutSeconds !== undefined) {
        const current = modelConfig(store);
        const timeouts = { firstByteTimeoutSeconds: data.firstByteTimeoutSeconds ?? current.firstByteTimeoutSeconds,
          streamIdleTimeoutSeconds: data.streamIdleTimeoutSeconds ?? current.streamIdleTimeoutSeconds };
        store.setSetting('poc_model_timeouts', timeouts);
        store.audit(req.user, 'model.timeouts.configure', 'poc', timeouts);
      }
      return res.json(publicModel(store));
    }
    const data = z.object({ baseUrl: httpUrl, model: z.string().trim().min(1).max(150), apiType: z.literal('responses').default('responses'), apiKey: z.string().max(4000).optional(), temperature: z.number().min(0).max(2).nullable().default(0.3), model_reasoning_effort: reasoningEffortSchema.optional(),
      firstByteTimeoutSeconds: firstByteTimeoutSchema.optional(), streamIdleTimeoutSeconds: streamIdleTimeoutSchema.optional() }).parse(req.body);
    const { apiKey, ...fields } = data;
    const current = modelConfig(store);
    store.setSetting('model', { ...fields,
      model_reasoning_effort: fields.model_reasoning_effort === undefined ? current.model_reasoning_effort : fields.model_reasoning_effort,
      firstByteTimeoutSeconds: fields.firstByteTimeoutSeconds ?? current.firstByteTimeoutSeconds,
      streamIdleTimeoutSeconds: fields.streamIdleTimeoutSeconds ?? current.streamIdleTimeoutSeconds,
      apiKeyEncrypted: store.encrypt(apiKey === undefined ? current.apiKey : apiKey) });
    store.audit(req.user, 'model.configure', data.model, { baseUrl: data.baseUrl, apiType: data.apiType,
      firstByteTimeoutSeconds: fields.firstByteTimeoutSeconds ?? current.firstByteTimeoutSeconds,
      streamIdleTimeoutSeconds: fields.streamIdleTimeoutSeconds ?? current.streamIdleTimeoutSeconds });
    res.json(publicModel(store));
  });
  app.post('/api/settings/model/test', admin, async (req, res) => {
    const started = Date.now();
    const result = await completion(store, [{ role: 'user', content: '请只回复：连接成功' }], [], AbortSignal.timeout(runTimeoutMs()));
    res.json({ text: result.message.content, elapsedMs: Date.now() - started });
  });
}
