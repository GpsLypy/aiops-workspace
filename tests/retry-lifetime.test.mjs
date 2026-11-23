import {test} from 'node:test';
import assert from 'node:assert/strict';
import {runtimeFixture,answer} from './runtime-fixture.mjs';

test('conversation and scheduled-task leases cover long retries without premature reclamation', async t => {
  const h=await runtimeFixture(),entered=Promise.withResolvers(),release=Promise.withResolvers();
  let runId;
  try {
    h.model(async(req,res)=>{entered.resolve();await release.promise;answer(res,undefined,'已完成');});
    const created=await h.request('/tasks',{name:'long-retry',prompt:'检查等待边界',scheduleType:'cron',cron:'* * * * *'});
    assert.equal(created.status,201);
    const started=await h.request(`/tasks/${created.data.id}/run`,{});assert.equal(started.status,202);runId=started.data.runId;
    await entered.promise;
    const run=h.app.store.get('SELECT * FROM task_runs WHERE id=?',runId);
    const conversation=h.app.store.get('SELECT * FROM conversations WHERE id=?',run.conversation_id);
    assert.ok(conversation.busy_until-Date.parse(run.started)>=450000);
    assert.equal(run.lease_until-Date.parse(run.started),480000);
    const now=Date.now();const clock=t.mock.method(Date,'now',()=>now+200000);
    try{h.app.scheduler.tick();}finally{clock.mock.restore();}
    assert.equal(h.app.store.get('SELECT status FROM task_runs WHERE id=?',runId).status,'running');
    assert.equal(h.app.store.get('SELECT count(*) n FROM task_runs WHERE task_id=?',created.data.id).n,1);
    const overlapping=await h.request('/chat',{text:'不能重入',conversationId:run.conversation_id,requestKey:'overlap-long'});
    assert.equal(overlapping.status,409);
  } finally {
    release.resolve();
    if(runId){for(let i=0;i<100&&h.app.store.get('SELECT status FROM task_runs WHERE id=?',runId)?.status==='running';i++)await new Promise(r=>setTimeout(r,30));}
    await h.close();
  }
});
