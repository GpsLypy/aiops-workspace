// Scenario fixtures retain a normalized message/tool view for their assertions.
// HTTP requests and replies use Responses exclusively; protocol validation is
// covered separately by model.test.mjs and model-stream.test.mjs.
export function sendResponsesSse(res, response) {
  res.type('text/event-stream');
  if (response?.status === 'completed') for (const item of response.output || []) {
    if (item.type === 'function_call') res.write(`data: ${JSON.stringify({ type: 'response.output_item.added', item })}\n\n`);
    if (item.type === 'message') for (const part of item.content || []) {
      if (part.type === 'output_text') res.write(`data: ${JSON.stringify({ type: 'response.output_text.delta', delta: part.text })}\n\n`);
      if (part.type === 'refusal') res.write(`data: ${JSON.stringify({ type: 'response.refusal.delta', delta: part.refusal })}\n\n`);
    }
  }
  const type = response?.status === 'failed' ? 'response.failed' : response?.status === 'incomplete' ? 'response.incomplete' : 'response.completed';
  return res.end(`data: ${JSON.stringify({ type, response })}\n\n`);
}

export function responsesFixture(req, res, next) {
  const body = req.body;
  if (body.stream !== true || !Array.isArray(body.input) || body.messages || body.max_tokens) throw Error('Expected Responses SSE request');
  const messages = [];
  for (const item of body.input) {
    if (item.type === 'function_call_output') messages.push({ role: 'tool', tool_call_id: item.call_id, content: item.output });
    else if (item.type === 'function_call') {
      let message = messages.at(-1);
      if (message?.role !== 'assistant') { message = { role: 'assistant', content: '' }; messages.push(message); }
      (message.tool_calls ||= []).push({ id: item.call_id, type: 'function', function: { name: item.name, arguments: item.arguments } });
    } else if (item.role) messages.push({ role: item.role, content: item.content });
  }
  req.body = { ...body, messages, ...(body.tools ? { tools: body.tools.map(({ type, strict, ...fn }) => ({ type, function: fn })) } : {}) };
  const json = res.json.bind(res);
  res.json = value => {
    if (res.statusCode >= 400) return json(value);
    if (!value?.choices) return value?.status || value?.output ? sendResponsesSse(res, value) : json(value);
    const message = value.choices[0].message;
    const output = [];
    if (message.content) output.push({ type: 'message', role: 'assistant', content: [{ type: 'output_text', text: message.content }] });
    for (const call of message.tool_calls || []) output.push({ type: 'function_call', call_id: call.id, name: call.function.name, arguments: call.function.arguments });
    const usage = value.usage;
    return sendResponsesSse(res, { status: 'completed', output, ...(usage ? { usage: { ...usage, input_tokens: usage.prompt_tokens, output_tokens: usage.completion_tokens } } : {}) });
  };
  next();
}
