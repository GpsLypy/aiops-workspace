import { test } from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import { completion } from '../server/model.mjs';
import { runRuntime } from '../server/agent-runtime/index.mjs';
import { listen } from './fixtures.mjs';
const frame = value => `data: ${JSON.stringify(value)}\n\n`;
const answer = text => ({ status: 'completed', output: [{ type: 'message', role: 'assistant', content: [{ type: 'output_text', text }] }], usage: { total_tokens: 7 } });
async function fixture(reply) {
  const app = express(); app.use(express.json()); const requests = [];
  app.post('/v1/responses', (req, res) => { requests.push(req.body); reply(req, res, requests.length); });
  const http = await listen(app);
  return { requests, http, store: { setting: () => ({ baseUrl: http.url + '/v1', model: 'retry-fixture', apiType: 'responses' }), decrypt: () => '' } };
}
test('Responses EOF and socket reset retry only the same frozen request; reset signal precedes replacement deltas', async () => {
  for (const kind of ['eof', 'socket']) {
    const f = await fixture((req, res, n) => {
      res.type('text/event-stream');
      if (n === 1) { res.write(frame({ type: 'response.output_text.delta', delta: 'discarded' })); if (kind === 'socket') setTimeout(() => res.destroy(), 20); else res.end(); }
      else res.end(frame({ type: 'response.output_text.delta', delta: 'recovered' }) + frame({ type: 'response.completed', response: answer('recovered') }));
    });
    try {
      const events = []; const result = await completion(f.store, [{ role: 'user', content: 'same-input' }], [], undefined, e => events.push(e), undefined, undefined, undefined, { model_reasoning_effort: 'high' });
      assert.equal(result.message.content, 'recovered'); assert.equal(f.requests.length, 2); assert.deepEqual(f.requests[0], f.requests[1]); assert.deepEqual(f.requests[1].reasoning, { effort: 'high' });
      assert.deepEqual(events.map(e => e.type), ['delta', 'retry', 'retry_ready', 'delta']); assert.equal(events[1].attempt, 2);
      assert.ok(events[1].delayMs >= 360 && events[1].delayMs <= 440); assert.equal(events[1].reason, 'connection');
    } finally { await f.http.close(); }
  }
});
test('bounded transient HTTP retries respect Retry-After, while authentication, JSON, bad SSE and provider incomplete fail once', async () => {
  for (const mode of ['503', '429', '401', 'json', 'bad', 'incomplete', 'failed', 'long-backoff']) {
    const f = await fixture((req, res) => {
      if (mode === '503') return res.status(503).end();
      if (mode === '429') return res.status(429).set('Retry-After', '0').end();
      if (mode === 'long-backoff') return res.status(429).set('Retry-After', '60').end();
      if (mode === '401') return res.status(401).end();
      if (mode === 'json') return res.json(answer('no fallback'));
      res.type('text/event-stream').end(mode === 'bad' ? 'data: nope\n\n' : frame({ type: `response.${mode}` }));
    });
    try { await assert.rejects(completion(f.store, [{ role: 'user', content: 'test' }]), { status: 502 }); assert.equal(f.requests.length, ['503','429'].includes(mode) ? 6 : 1, mode); }
    finally { await f.http.close(); }
  }
});
test('cancel during retry backoff prevents another request', async () => {
  const abort = new AbortController();
  const f = await fixture((req, res) => { res.type('text/event-stream').end(); setTimeout(() => abort.abort(), 50); });
  try { await assert.rejects(completion(f.store, [{ role:'user', content:'test' }], [], abort.signal), /取消/); assert.equal(f.requests.length, 1); }
  finally { await f.http.close(); }
});
test('retry notification is delivered before backoff and can cancel the pending attempt', async () => {
  const controller = new AbortController(), events = [];
  const f = await fixture((req, res) => res.status(503).end());
  try {
    await assert.rejects(completion(f.store, [{ role: 'user', content: 'test' }], [], controller.signal, e => {
      events.push(e); if (e.type === 'retry') controller.abort();
    }), /取消/);
    assert.equal(f.requests.length, 1); assert.equal(events.length, 1); assert.equal(events[0].reason, 'service_unavailable');
  } finally { await f.http.close(); }
});
test('HTTP429 hard quota failures never retry or expose upstream details', async () => {
  for (const code of ['insufficient_quota', 'credit_balance_exhausted', 'organization_spend_limit_exceeded', 'project_spend_limit_exceeded']) {
    const f = await fixture((req, res) => res.status(429).set('Retry-After', '0').json({ error: { code, message: 'PRIVATE_PROVIDER_SECRET' } }));
    try {
      await assert.rejects(completion(f.store, [{ role: 'user', content: 'test' }]), error => /额度已用尽/.test(error.message) && !error.message.includes('PRIVATE_PROVIDER_SECRET'));
      assert.equal(f.requests.length, 1);
    } finally { await f.http.close(); }
  }
});
test('only explicit transient provider failure codes recover; quota and unknown codes fail once without leaking details', async () => {
  for (const code of ['server_error','service_unavailable','rate_limit_exceeded','insufficient_quota','invalid_prompt','unknown','flat_error']) {
    const transient=['server_error','service_unavailable','rate_limit_exceeded','flat_error'].includes(code);
    const f=await fixture((req,res,n)=>res.type('text/event-stream').end(n===1?frame(code==='flat_error'?{type:'error',code:'server_error',message:'private-provider-detail'}:{type:'response.failed',response:{status:'failed',error:{code,message:'private-provider-detail'}}}):frame({type:'response.completed',response:answer('recovered')})));
    try {if(transient)assert.equal((await completion(f.store,[{role:'user',content:'test'}])).message.content,'recovered');else await assert.rejects(completion(f.store,[{role:'user',content:'test'}]),e=>e.status===502&&!e.message.includes('private-provider-detail'));assert.equal(f.requests.length,transient?2:1);}
    finally {await f.http.close();}
  }
});
test('model retry after a completed tool reuses its result once, marks draft recovery, counts attempts and charges failed estimate', async () => {
  const f = await fixture((req, res, n) => {
    res.type('text/event-stream');
    if (n === 1) return res.end(frame({ type: 'response.completed', response: { status:'completed', output:[{type:'function_call',call_id:'one',name:'mcp_0',arguments:'{}'}], usage:{total_tokens:5} } }));
    if (n === 2) return res.end(frame({ type:'response.output_text.delta',delta:'discarded draft' }));
    res.end(frame({type:'response.output_text.delta',delta:'saved answer'})+frame({type:'response.completed',response:answer('saved answer')}));
  });
  try {
    let tools = 0, checks = 0; const charges = [], events = [], stats = { modelCalls:0,tokens:0 };
    const result = await runRuntime({store:f.store, context:{runId:'run', beforeModel:()=>10, charge:(usage,estimate)=>charges.push(usage?.total_tokens??estimate)}, messages:[{role:'user',content:'test'}], tools:[], signal:new AbortController().signal, event:e=>events.push(e), streamText:true, stats, beforeModel:()=>checks++, validateCall:()=>{}, executeCall:async()=>{tools++;return {content:'tool result'};}, driver:{run:async({model,tool})=>{const proposed=await model();const call=proposed.message.tool_calls[0];await tool(call);return {text:(await model()).message.content};}}});
    assert.equal(result.text,'saved answer');assert.equal(tools,1);assert.equal(checks,3);assert.equal(stats.modelCalls,3);assert.deepEqual(charges,[5,10,7]);assert.deepEqual(f.requests[1],f.requests[2]);
    assert.ok(events.some(e=>e.type==='progress'&&/重新连接 1\/5/.test(e.text)));
    const resetIndex=events.findIndex(e=>e.type==='message_reset'&&e.reason==='retry');
    assert.ok(resetIndex>=0);assert.equal(events[resetIndex+1].type,'model_retry');assert.equal(events[resetIndex+1].phase,'waiting');
    const restarted=events.find(e=>e.type==='message_start'&&e.reason==='retry');assert.ok(restarted);
    assert.notEqual(restarted.streamId,events[resetIndex].streamId);assert.ok(restarted.streamId.endsWith(':2'));
    assert.ok(events.some(e=>e.type==='message_reset'&&!e.reason),'tool transitions must still discard their draft');
  } finally {await f.http.close();}
});
test('retry budget and access gate can refuse an additional network request',async()=>{
  for(const gate of ['budget','access']){
    const f=await fixture((req,res)=>res.type('text/event-stream').end());let estimates=0,access=0;
    try {await assert.rejects(runRuntime({store:f.store,context:{runId:'run',beforeModel:()=>{if(++estimates>1&&gate==='budget')throw Object.assign(Error('budget'),{status:422});return 10;},charge:()=>{}},messages:[],tools:[],signal:new AbortController().signal,event:()=>{},beforeModel:()=>{if(++access>1&&gate==='access')throw Object.assign(Error('access'),{status:403});},maxModelCalls:6,validateCall:()=>{},executeCall:()=>{},driver:{run:async({model})=>model()}}),{status:gate==='access'?403:422});assert.equal(f.requests.length,1,gate);}
    finally{await f.http.close();}
  }
});

test('first-byte and stream-idle timeouts are independent and each retry gets a fresh watchdog', async () => {
  for (const phase of ['headers', 'streaming']) {
    const f = await fixture((req, res, n) => {
      if (n === 1) { if (phase === 'streaming') { res.type('text/event-stream'); res.write(frame({type:'response.output_text.delta',delta:'discard me'})); } return; }
      res.type('text/event-stream').end(frame({type:'response.completed',response:answer('recovered')}));
    });
    try {
      const diagnostics=[], events=[];
      assert.equal((await completion(f.store,[{role:'user',content:'test'}],[],undefined,e=>events.push(e),undefined,d=>diagnostics.push(d),undefined,{timeoutPolicy:{firstByteMs:80,idleMs:80}})).message.content,'recovered');
      assert.equal(f.requests.length,2);
      assert.equal(diagnostics[0].abortSource,'request_timeout');assert.equal(diagnostics[0].timeoutKind,phase==='headers'?'first_byte':'stream_idle');assert.equal(diagnostics[1].outcome,'completed');
      const retry=events.find(e=>e.type==='retry');assert.equal(retry.reason,'timeout');assert.equal(retry.timeoutKind,phase==='headers'?'first_byte':'stream_idle');assert.equal(retry.timeoutSeconds,phase==='headers'?90:180);
    } finally {await f.http.close();}
  }
});

test('zero stream-idle timeout disables only the between-chunk watchdog', async () => {
  const f = await fixture((req,res) => {
    res.type('text/event-stream');res.write(frame({type:'response.output_text.delta',delta:'still working'}));
    setTimeout(()=>res.end(frame({type:'response.completed',response:answer('completed after pause')})),120);
  });
  try {
    const result=await completion(f.store,[{role:'user',content:'test'}],[],undefined,undefined,undefined,undefined,undefined,{timeoutPolicy:{firstByteMs:60,idleMs:0}});
    assert.equal(result.message.content,'completed after pause');assert.equal(f.requests.length,1);
  } finally {await f.http.close();}
});

test('five retries remain available in a one-round stage, while a seventh attempt and another tool round are forbidden', async () => {
  const f=await fixture((req,res,n)=>res.type('text/event-stream').end(n<6?'':frame({type:'response.completed',response:{status:'completed',output:[{type:'function_call',call_id:'one',name:'mcp_0',arguments:'{}'}],usage:{total_tokens:5}}})));
  let tools=0;const stats={modelCalls:0,tokens:0};
  try {
    await assert.rejects(runRuntime({store:f.store,context:{runId:'run',beforeModel:()=>10,charge:()=>{}},messages:[],tools:[],signal:new AbortController().signal,event:()=>{},maxModelCalls:1,stats,validateCall:()=>{},executeCall:async()=>{tools++;return{content:'one result'};},driver:{run:async({model,tool})=>{const p=await model();await tool(p.message.tool_calls[0]);return model();}}}),{status:422});
    assert.equal(f.requests.length,6);assert.equal(stats.modelCalls,6);assert.equal(tools,1);
    assert.deepEqual(f.requests,Array(6).fill(f.requests[0]));
  } finally {await f.http.close();}
});
