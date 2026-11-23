import { httpError } from './store.mjs';
import { providerFailure } from './model-retry.mjs';

const invalid = () => httpError(502, '模型流式响应无效或未完整结束，请重新查询');
const upstreamFailed = providerFailure;
const upstreamIncomplete = () => httpError(502, '模型 Responses 输出未完成，请检查输出上限或模型服务状态');
const aborted = () => httpError(502, '模型请求超时或执行已取消');
const disconnected = () => Object.assign(httpError(502, '模型连接在完成前中断，请稍后重试'), { code: 'MODEL_STREAM_DISCONNECTED' });

// SSE is an upstream transport only. Never forward raw provider frames, which
// can contain reasoning, function arguments, or private error details.
export async function readModelStream(response, { onEvent = () => {}, onChunk = () => {}, signal }) {
  if (!response.body) throw invalid();
  const reader = response.body.getReader();
  const decoder = new TextDecoder('utf-8', { fatal: true });
  let buffer = '', data = [], bytes = 0, terminal = false, result;
  let toolSeen = false;
  const tool = () => { if (!toolSeen) { toolSeen = true; onEvent({ type: 'tool_call' }); } };
  const text = value => {
    if (typeof value !== 'string') throw invalid();
    if (value && !toolSeen) onEvent({ type: 'delta', text: value });
  };
  const dispatch = () => {
    if (!data.length || terminal) { data = []; return; }
    const raw = data.join('\n'); data = [];
    let frame;
    try { frame = JSON.parse(raw); } catch { throw invalid(); }
    if (!frame) throw invalid();
    if (frame.error || frame.type === 'error') throw upstreamFailed(frame.error || frame);
    if (frame.type === 'response.failed') throw upstreamFailed(frame.response?.error);
    if (frame.type === 'response.incomplete') throw upstreamIncomplete();
    if (frame.type === 'response.output_item.added' && frame.item?.type === 'function_call') tool();
    if (frame.type === 'response.function_call_arguments.delta') tool();
    if (['response.output_text.delta', 'response.refusal.delta'].includes(frame.type)) text(frame.delta);
    if (frame.type === 'response.completed') {
      if (frame.response?.status === 'failed') throw upstreamFailed(frame.response.error);
      if (frame.response?.status === 'incomplete') throw upstreamIncomplete();
      if (frame.response?.status !== 'completed') throw invalid();
      result = frame.response; terminal = true;
    }

  };
  const line = value => {
    if (!value) return dispatch();
    if (value.startsWith('data:')) data.push(value.slice(5).replace(/^ /, ''));
  };
  try {
    while (!terminal) {
      const { value, done } = await reader.read();
      if (done) break;
      if (value.byteLength) onChunk();
      bytes += value.byteLength;
      if (bytes > 2_000_000) throw httpError(502, '远程响应超过大小限制');
      buffer += decoder.decode(value, { stream: true });
      // Accept LF, CRLF, and CR, including a CRLF split across network reads.
      let match;
      while (!terminal && (match = /\r\n|\r|\n/.exec(buffer))) {
        if (match[0] === '\r' && match.index === buffer.length - 1) break;
        line(buffer.slice(0, match.index)); buffer = buffer.slice(match.index + match[0].length);
      }
    }
    if (!terminal) {
      buffer += decoder.decode();
      let match;
      while (!terminal && (match = /\r\n|\r|\n/.exec(buffer))) {
        line(buffer.slice(0, match.index)); buffer = buffer.slice(match.index + match[0].length);
      }
      // A frame without its blank-line delimiter is incomplete, even if its
      // JSON happens to parse. EOF must never turn a draft into a success.
    }
    if (!terminal) throw signal?.aborted ? aborted() : disconnected();
    return result;
  } catch (error) {
    if (error.status) throw error;
    if (signal?.aborted || error.name === 'TimeoutError' || error.name === 'AbortError') throw aborted();
    if (['ECONNRESET', 'EPIPE', 'ERR_STREAM_PREMATURE_CLOSE'].includes(error.code)) throw disconnected();
    throw invalid();
  } finally { await reader.cancel().catch(() => {}); reader.releaseLock(); }
}
