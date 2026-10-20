import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { corpus, summary } from './corpus.mjs';
import { options } from './run.mjs';
const manifest=JSON.parse(await readFile(new URL('../manifest.json',import.meta.url),'utf8'));
test('Task and Long use exact byte budgets and valid Unicode across block boundaries',()=>{
  for(const [name,count,bytes] of [['task',20,10240],['long',2000,1048576]]) {
    const fixture=corpus(name);
    assert.equal(fixture.blocks.length,count);assert.equal(fixture.textBytes,bytes);
    assert.equal(fixture.sha256,corpus(name).sha256);
    assert.ok(fixture.textUtf16<bytes);
    assert.ok(fixture.blocks.every(b=>b.text.isWellFormed()));
    assert.deepEqual(new Set(fixture.blocks.map(b=>b.type)),new Set(['paragraph','heading','code','list']));
  }
  assert.throws(()=>corpus('missing'));
});
test('sparse or invalid samples cannot produce invented tail percentiles',()=>{
  assert.deepEqual(summary([3,1,2]),{count:3,p50:2,p95:null,p99:null,min:1,max:3,tailStatus:'Inconclusive: insufficient independent samples for tails'});
  for(const values of [[],[NaN],[Infinity],[-1]])assert.throws(()=>summary(values));
});
test('CLI rejects unknown/duplicate cases, empty measurements and ambiguous source inputs',()=>{
  for(const args of [['--profiles','unknown'],['--fixtures','task,task'],['--runs','0'],['--samples','1.5'],['--warmups','-1'],['--unknown'],['--fixtures'],['--skip-build'],['--source','x','--revision','HEAD']])assert.throws(()=>options(args,manifest));
  const opts=options(['--quick','--fixtures','task'],manifest);
  assert.equal(opts.runs,3);assert.equal(opts.warmups,1);assert.equal(opts.samples,5);
  assert.equal(opts.commandRoute,'text');
  assert.equal(options(['--command-route','editor'],manifest).commandRoute,'editor');
  assert.throws(()=>options(['--command-route','unknown'],manifest));
});
test('minimal references remain separate from durability comparisons and every profile has a runnable adapter',async()=>{
  assert.equal(manifest.profiles.find(p=>p.id==='contenteditable-reference').group,'reference');
  assert.equal(manifest.profiles.find(p=>p.id==='editac-task').group,'durable');
  for(const profile of manifest.profiles) {
    await readFile(new URL(`${profile.id}.mjs`,import.meta.url));
    if(profile.group==='minimal')assert.equal(profile.durability,'disabled');
    assert.ok(profile.differences.length);
  }
});
