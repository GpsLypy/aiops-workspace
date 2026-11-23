import { httpError } from '../store.mjs';

// One fresh session per run, shared by cold and prefork transports.
export function bridgeSession({ runId, model, tool }) {
  let sequence = 0, pending, lastMessage, finished = false;
  const responses = new Map();
  return async frame => {
    if (frame?.version === 1 && frame.type === 'fatal') throw httpError(502, 'AgentScope Worker 初始化或运行失败，请检查已锁定的依赖');
    if (frame?.version !== 1 || frame.runId !== runId || finished) throw httpError(502, 'AgentScope Worker 协议或运行标识不匹配');
    if (frame.type === 'finish') {
      finished = true;
      if (frame.status === 'awaiting_approval' && pending) return { done: true, result: pending };
      if (frame.status !== 'completed' || !lastMessage || lastMessage.tool_calls?.length || pending) throw httpError(502, 'AgentScope 未完整完成本轮执行');
      return { done: true, result: { text: lastMessage.content } };
    }
    if (!Number.isSafeInteger(frame.id) || frame.id < 1 || !['model', 'tool'].includes(frame.type)) throw httpError(502, 'AgentScope Worker 请求格式无效');
    const digest = JSON.stringify(frame), cached = responses.get(frame.id);
    if (cached) {
      if (cached.digest !== digest) throw httpError(409, 'Worker 请求标识已用于不同参数');
      return { response: cached.response };
    }
    if (frame.id !== sequence + 1 || frame.id > 128) throw httpError(502, 'AgentScope Worker 请求顺序无效');
    sequence = frame.id;
    let result;
    if (frame.type === 'model') { result = await model(); lastMessage = result.message; }
    else {
      result = await tool({ id: frame.callId, function: { name: frame.name, arguments: frame.arguments } }, { replyId: frame.replyId, callId: frame.callId });
      if (result.pending) pending = result;
    }
    const response = { version: 1, runId, id: frame.id, ok: true, result };
    responses.set(frame.id, { digest, response });
    return { response };
  };
}
