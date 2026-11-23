import assert from 'node:assert/strict';

export function validatePoCChatEvents(events, { realModel = false } = {}) {
  // HTTP 200 can carry a failed NDJSON chat. Check errors before completion or
  // answer chunks, and keep model responses and private details out of logs.
  assert.ok(!events.some(event => event.type === 'error'), 'PoC chat returned an error event; inspect the private PoC execution record');
  const done = events.find(event => event.type === 'done');
  assert.ok(done, 'Missing completed chat');
  assert.ok(events.filter(event => event.type === 'message_delta').length >= (realModel ? 1 : 2), 'Missing streamed answer chunks');
  assert.ok(events.findIndex(event => event.type === 'message_delta') < events.findIndex(event => event.type === 'done'), 'Answer chunks did not precede completion');
  if (!realModel) assert.match(done.text, /本机受控模型/);
  else assert.ok(typeof done.text === 'string' && done.text.trim(), 'Real model returned an empty answer');
  return done;
}
