import { TOOL } from '../integrations/dts-mcp/adapter.mjs';

const followupPrompt = '请再次调用工具查询同一个任务，现在的数据仍然新鲜吗？';

export function dtsEvaluationInput(scenario, { agentId, resourceId, conversationId, real = false } = {}) {
  const expectedArgs = { jobid: scenario.jobid, business_domain: 'general', area_name: 'cn_east', ...scenario.arguments,
    ...(real && scenario.id === 'numeric-id' ? { jobid: scenario.jobid } : {}) };
  const request = {
    text: conversationId ? followupPrompt : scenario.prompt,
    ...(conversationId ? { conversationId } : { agentId }),
    ...(!scenario.noTool ? { targetBinding: { resourceId, tool: TOOL, environment: 'production', arguments: expectedArgs } } : {}),
  };
  return { expectedArgs, request };
}
