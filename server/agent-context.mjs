import { httpError } from './store.mjs';
import { positive } from './security.mjs';

export const contextBytes = (messages, tools) => Buffer.byteLength(JSON.stringify([...messages, { tools }]));

// Initial text history only. The current tool/reasoning transcript is never shortened.
export function prepareContext(system, history, tools, config) {
  const original = history.map(m => ({ role: m.role, content: m.content.slice(0, 20000) }));
  const beforeBytes = contextBytes([{ role: 'system', content: system }, ...original], tools);
  if (config.contextMode !== 'budgeted') return { messages: [{ role: 'system', content: system }, ...original] };
  const budgetBytes = Math.min(config.contextMaxBytes, positive('MODEL_CONTEXT_TOKENS', 32768) - positive('MODEL_MAX_TOKENS', 4096));
  const turns = [];
  for (const message of original) {
    if (message.role === 'user') turns.push([message]);
    else if (turns.length) turns.at(-1).push(message);
  }
  const build = () => {
    const retained = turns.flat();
    const omitted = original.length - retained.length;
    const notice = omitted ? `\n\n本轮因上下文预算省略了 ${omitted} 条较早历史消息。历史不完整；若当前问题依赖已省略的对象、范围或事实，先请求用户补充，不得猜测。` : '';
    return { messages: [{ role: 'system', content: system + notice }, ...retained], omitted };
  };
  let selected = build();
  while (turns.length > 1 && contextBytes(selected.messages, tools) > budgetBytes) { turns.shift(); selected = build(); }
  if (!turns.length || contextBytes(selected.messages, tools) > budgetBytes) throw httpError(422, '系统指令、知识、工具和当前问题超出上下文预算，请缩小本轮输入或资源范围');
  return { messages: selected.messages, stats: { mode: 'budgeted', consideredMessages: original.length,
    retainedMessages: original.length - selected.omitted, omittedMessages: selected.omitted,
    beforeBytes, afterBytes: contextBytes(selected.messages, tools), budgetBytes } };
}
