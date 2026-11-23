import {test} from 'node:test';import assert from 'node:assert/strict';
import{readFileSync}from'node:fs';import ts from'typescript';
const js=ts.transpileModule(readFileSync(new URL('../src/stream-reveal.ts',import.meta.url),'utf8'),{compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.ES2022}}).outputText;
const {createStreamReveal}=await import('data:text/javascript;base64,'+Buffer.from(js).toString('base64'));
function harness(reducedMotion=false){let id=0;const queued=new Map(),painted=[];const reveal=createStreamReveal(text=>painted.push(text),{reducedMotion,schedule:cb=>{queued.set(++id,cb);return id;},cancel:id=>queued.delete(id)});return{reveal,painted,tick(time){const batch=[...queued.values()];queued.clear();batch.forEach(cb=>cb(time));},queued};}
test('a network burst reveals in bounded frame updates, preserves Unicode and drains to authoritative completion',async()=>{
  const h=harness(),text='中文🙂'.repeat(60);h.reveal.append(text);h.tick(16);
  assert.ok(h.painted[0].length>0&&h.painted[0].length<text.length);
  const done=h.reveal.finish(text+'完整结尾');let finished=false;done.then(()=>finished=true);
  for(let time=32;time<2000;time+=16)h.tick(time);await done;
  assert.equal(finished,true);assert.equal(h.painted.at(-1),text+'完整结尾');assert.ok(h.painted.length>3&&h.painted.length<50);
  for(const part of h.painted){assert.ok((text+'完整结尾').startsWith(part));assert.ok(!/[\uD800-\uDBFF]$/.test(part));}
});
test('tool reset cancels queued old text and never appends it to the new response',async()=>{
  const h=harness();h.reveal.append('旧草稿'.repeat(40));h.tick(16);h.reveal.reset();const start=h.painted.length;
  h.reveal.append('新回复');const done=h.reveal.finish('新回复');for(let time=32;time<1000;time+=16)h.tick(time);await done;
  assert.ok(h.painted.slice(start).every(s=>'新回复'.startsWith(s)));assert.equal(h.queued.size,0);
});
test('repeated retries retain printed text while shorter or empty attempts catch up',async()=>{
  for(const reducedMotion of [false,true]){
    const h=harness(reducedMotion),old='已经打印的长内容中文🙂';
    const initial=h.reveal.finish(old);for(let time=16;time<1000;time+=32)h.tick(time);await initial;
    const printed=[...h.painted];assert.equal(printed.at(-1),old);
    h.reveal.append('尚未打印的积压');h.reveal.restart();h.tick(32);
    assert.deepEqual(h.painted,printed);assert.equal(h.queued.size,0);
    h.reveal.append('短内容');h.tick(64);assert.deepEqual(h.painted,printed);
    h.reveal.restart();h.tick(96);assert.deepEqual(h.painted,printed);
    h.reveal.append(old);h.tick(128);assert.deepEqual(h.painted,printed);
    h.reveal.append('新结尾');h.tick(160);
    assert.ok(h.painted.at(-1).startsWith(old));assert.ok(h.painted.at(-1).length>old.length);
    const done=h.reveal.finish(old+'新结尾');for(let time=192;time<1000;time+=32)h.tick(time);await done;
    assert.equal(h.painted.at(-1),old+'新结尾');assert.equal(h.queued.size,0);
  }
});
test('a shorter divergent completed answer replaces the retained draft without mixing attempts',async()=>{
  const h=harness(true),old='上一轮尚未完成的长草稿🙂';h.reveal.append(old);h.tick(16);
  h.reveal.restart();h.reveal.append('新');h.tick(48);assert.deepEqual(h.painted,[old]);
  const done=h.reveal.finish('新答复');h.tick(80);await done;
  assert.deepEqual(h.painted,[old,'新答复']);
  h.reveal.restart();h.reveal.reset();h.reveal.append('工具之后');h.tick(112);
  assert.equal(h.painted.at(-1),'工具之后');
});
test('reduced motion batches without typewriter pacing and dispose resolves pending finish without stale paint',async()=>{
  const h=harness(true);h.reveal.append('全部内容');h.tick(16);assert.deepEqual(h.painted,['全部内容']);
  const done=h.reveal.finish('追加');h.reveal.dispose();await done;const count=h.painted.length;h.tick(32);assert.equal(h.painted.length,count);
});
