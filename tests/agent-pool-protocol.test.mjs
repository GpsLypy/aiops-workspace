import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createWorkerPool } from '../server/agent-runtime/pool.mjs';

async function peer(source, check, options = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'aiops-pool-peer-')), python = join(dir, 'peer');
  writeFileSync(python, `#!${process.execPath}
(async()=>{
  const {createInterface}=require('node:readline');
  const lines=createInterface({input:process.stdin})[Symbol.asyncIterator]();
  const read=async()=>JSON.parse((await lines.next()).value);
  const send=f=>process.stdout.write(JSON.stringify(f)+'\\n');
  const ready=extra=>send({version:2,type:'ready',sdk:'2.0.8',pid:process.pid,parentUsage:{maxRssBytes:1,cpuSeconds:0},...extra});
  ${source}
})().catch(()=>process.exit(8));`, { mode: 0o700 });
  const pool = createWorkerPool({ python, poolSize: 1, startupTimeoutMs: 1000, ...options });
  try { await check(pool, dir); } finally { await pool.close(); rmSync(dir, { recursive: true, force: true }); }
}
const args = runId => {
  const controller = new AbortController();
  return { runId, messages: [{ role: 'system', content: 'secret-context' }], tools: [], signal: controller.signal,
    onFailure: () => controller.abort(), model: async () => ({ message: { content: 'done' } }), tool: async () => { assert.fail('No tool expected'); } };
};

test('prefork startup rejects wrong SDK, forged parent identity and unsupported readiness frames', async () => {
  for (const source of [`ready({sdk:'wrong'});`, `ready({pid:process.pid+1});`, `ready({version:1});`, `ready({parentUsage:{maxRssBytes:-1,cpuSeconds:0}});`]) {
    await peer(source, async pool => { await assert.rejects(pool.warmup(), { status: 502 }); assert.equal(pool.health().ready, false); });
  }
});

test('prefork preloader uses a private temporary directory and removes it on close', async () => {
  await peer(`
    const fs=require('node:fs'), os=require('node:os'), path=require('node:path');
    if(fs.realpathSync(process.env.TMPDIR)!==process.cwd() || fs.realpathSync(os.tmpdir())!==process.cwd()) process.exit(7);
    fs.writeFileSync(path.join(os.tmpdir(),'scratch'),'private');
    fs.writeFileSync(path.join(path.dirname(process.argv[1]),'pool-cwd'),process.cwd());
    ready(); await read();
  `, async (pool, dir) => {
    await pool.warmup();
    const directory = readFileSync(join(dir, 'pool-cwd'), 'utf8');
    assert.equal(existsSync(join(directory, 'scratch')), true);
    await pool.close();
    assert.equal(existsSync(directory), false);
  });
});

test('pool lease never carries context; only matching leased child may receive start and finish must precede recycling', async () => {
  await peer(`ready();
    for(let i=0;i<2;i++){
      const lease=await read();
      if(JSON.stringify(Object.keys(lease).sort())!==JSON.stringify(['runId','type','version']))process.exit(3);
      send({version:2,type:'leased',runId:lease.runId,pid:process.pid+10000});
      const start=await read(); if(start.system!=='secret-context')process.exit(4);
      send({version:1,type:'model',runId:lease.runId,id:1}); await read();
      send({version:1,type:'finish',runId:lease.runId,status:'completed'});
      ready({runId:lease.runId,childPid:process.pid+10000,childUsage:{maxRssBytes:1,cpuSeconds:0}});
    }
    await read();`, async pool => {
    await pool.warmup();
    assert.equal((await pool.run(args('first'))).text, 'done');
    assert.equal((await pool.run(args('second'))).text, 'done');
    assert.equal(pool.health().completed, 2); assert.equal(pool.health().spawned, 1);
  });
});

test('pool rejects cross-run child, early readiness and stale cleanup acknowledgement', async () => {
  const cases = [
    `send({version:2,type:'leased',runId:'wrong-run',pid:process.pid+10000});`,
    `ready({runId:lease.runId,childPid:process.pid+10000,childUsage:{maxRssBytes:1,cpuSeconds:0}});`,
    `send({version:2,type:'leased',runId:lease.runId,pid:process.pid+10000}); await read();
     send({version:1,type:'model',runId:lease.runId,id:1}); await read();
     send({version:1,type:'finish',runId:lease.runId,status:'completed'});
     ready({runId:'previous-run',childPid:process.pid+10000,childUsage:{maxRssBytes:1,cpuSeconds:0}});`,
  ];
  for (const source of cases) await peer(`ready(); const lease=await read(); ${source}`, async pool => { await assert.rejects(pool.run(args('current-run')), { status: 502 }); assert.equal(pool.health().completed, 0); });
});

test('pool startup timeout terminates a hung preloader and close prevents background retries', async () => {
  await peer('setInterval(()=>{},1000);', async pool => {
    await assert.rejects(pool.warmup(), { status: 503 });
    await pool.close(); assert.equal(pool.health().workers.length, 0);
  }, { startupTimeoutMs: 100 });
});
