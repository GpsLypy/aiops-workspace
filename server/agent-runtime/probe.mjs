import { randomUUID } from 'node:crypto';

// Real SDK, synthetic model and tool; no business store or network service.
export async function probeRuntime(run, timeoutMs = 15000) {
  let models = 0, calls = 0;
  const controller = new AbortController(), timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const result = await run({ runId: `worker-probe-${randomUUID()}`, signal: controller.signal, onFailure: () => controller.abort(),
      messages: [{ role: 'system', content: 'Local fixture health probe' }, { role: 'user', content: 'probe' }],
      tools: [{ type: 'function', function: { name: 'probe', description: 'Local probe', parameters: { type: 'object', properties: {} } } }],
      model: async () => ({ message: ++models === 1 ? { role: 'assistant', content: '', tool_calls: [{ id: 'probe-call', type: 'function', function: { name: 'probe', arguments: '{}' } }] } : { role: 'assistant', content: 'healthy' } }),
      tool: async (call, identity) => { if (call.id !== 'probe-call' || call.function.name !== 'probe' || call.function.arguments !== '{}' || !identity.replyId) throw new Error('Worker tool protocol mismatch'); calls++; return { content: 'healthy' }; },
    });
    if (result.text !== 'healthy' || models !== 2 || calls !== 1) throw new Error('Worker round trip incomplete');
  } finally { clearTimeout(timer); }
}
