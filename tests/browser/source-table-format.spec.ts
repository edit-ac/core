import assert from 'node:assert/strict';
import {test} from 'node:test';
import {mkdir,copyFile,symlink,writeFile} from 'node:fs/promises';
import {join,resolve} from 'node:path';
import {browserHarness} from './browser-harness.ts';
const {probe} = browserHarness('source-table-format', 'fixtures/browser-input', {
  markdown:true, assertSourcesUnchanged:true, serverOptions:{recordRequests:true},
  async prepareConsumer(consumer,{facts,run}) {
    await mkdir(join(consumer,'node_modules/@edit-ac'),{recursive:true});
    for(const name of ['core','web','markdown'])await symlink(join(consumer,name,'package'),join(consumer,'node_modules/@edit-ac',name));
    await writeFile(join(consumer,'package.json'),JSON.stringify({private:true,type:'module'}));
    const input=join(consumer,'public-types.ts');await copyFile('tests/consumers/source-table-format/public-types.ts',input);
    await run(process.execPath,[resolve('node_modules/typescript/bin/tsc'),'--noEmit','--strict','--skipLibCheck','--module','nodenext','--moduleResolution','nodenext','--target','es2022','--lib','es2022,dom,dom.iterable',input],'public-types.log');
    facts.publicTypes={passed:true,source:'tests/consumers/source-table-format/public-types.ts',invalidExamples:3};
    return 'fixtures/browser-input';
  },
  sourcePaths:['tests/consumers/source-table-format/public-types.ts','crates/editac-core/src/projection.rs','crates/editac-markdown/src/reconcile.rs','crates/editac-markdown/src/table_format.rs','crates/editac-markdown-wasm/src/lib.rs','crates/editac-wasm/src/engine.rs','packages/markdown/src/index.ts','packages/core/src/index.ts','packages/web/src/storage/index.ts','packages/web/src/editor.ts'],
});
const source = 'Before  **unchanged** 😀\r\n\r\n| a | bb |\r\n| :- | -: |\r\n| `x\\|y` | é |\r\n\r\nBetween   unchanged\n\n| c | dd |\n| - | - |\n| x | y |\n\nAfter\tunchanged';
async function setup(page, raw = source) {
  return page.evaluate(async raw => {
    const f=window.inputFixture, e=f.engine;
    const nodes=e.read().visible.filter(n=>n.kind==='block');
    const a=e.anchor(nodes[0].id,0,'right'), b=e.anchor(nodes.at(-1).id,nodes.at(-1).runs.map(r=>r.text).join('').length,'left');
    const parsed=e.importMarkdown(raw,{tables:true});
    try { f.commit({kind:'fragment',origin:'source-fixture',range:{anchor:a,focus:b},blocks:parsed.blocks}); }
    finally {e.releaseAnchor(a);e.releaseAnchor(b);}
    await f.storage.flush({target:'local'}); e.history({type:'clear'});
    const represented=e.read().visible.filter(n=>n.kind==='block');
    // Fragment admission provides empty editable cuts around edge atoms. Those
    // cuts have no source range and must not become source-baseline bindings.
    const empty=n=>n.blockAttributes?.[0]==='paragraph'&&n.runs.every(r=>r.text==='');
    while(represented.length>parsed.blocks.length&&empty(represented[0]))represented.shift();
    while(represented.length>parsed.blocks.length&&empty(represented.at(-1)))represented.pop();
    if(represented.length!==parsed.blocks.length)throw Error('fixture source binding count');
    const owners=represented.map(n=>n.id);
    window.tableFixture={source:raw,owners,opening:e.checkpoint(),base:e.captureSourceBaseline(raw,owners,{tables:true}),tables:e.read().visible.filter(n=>n.blockAttributes?.[0]==='module:editac.table').map(n=>n.id)};
    return {owners,tables:window.tableFixture.tables};
  }, raw);
}
for (const selected of [0,1]) test(`selected table ${selected+1} preserves exact adjacent bytes, anchors, history and storage recovery`,()=>probe(`selected-${selected}`,async(page,fact)=>{
  await setup(page);
  const r=await page.evaluate(async selected=>{
    const f=window.inputFixture,e=f.engine,t=window.tableFixture, owner=t.tables[selected];
    const before=e.read().visible, anchor=e.anchor(t.owners[0],2,'right'), position=e.resolve(anchor), events=[];
    const subscription=e.subscribe({type:'all'},p=>events.push(p));
    const bytes=Array.from(e.checkpoint().bytes), prepared=t.base.prepareTableFormat(owner,'local:table-source');
    const unmutated=JSON.stringify(bytes)===JSON.stringify(Array.from(e.checkpoint().bytes));
    f.storage.commitPrepared(prepared.plan);e.releasePlan(prepared.plan);
    await f.storage.flush({target:'local'});
    const after=e.read().visible, history=e.history({type:'state'}), formatted=t.base.sourceWithCurrentTable(owner), resolved=e.resolve(anchor);
    const committedEvents=events.slice();
    e.history({type:'undo'});const undone=t.base.sourceWithCurrentTable(owner);
    e.history({type:'redo'});const redone=t.base.sourceWithCurrentTable(owner);
    await f.storage.flush({target:'local'}); const journal=(await f.state()).journal;
    subscription.dispose();e.releaseAnchor(anchor);
    await f.reopen();
    const recovered=f.engine.captureSourceBaseline(t.source,t.owners,{tables:true},t.opening);
    const reopened=recovered.sourceWithCurrentTable(owner);recovered.dispose();
    return {before,after,owner,position,resolved,unmutated,prepared:{source:prepared.source,changed:prepared.changed},formatted,undone,redone,reopened,events:committedEvents,history,journal};
  },selected);
  fact.snapshots.push(r);
  assert.equal(r.unmutated,true);assert.equal(r.prepared.changed,true);
  assert.equal(r.formatted,r.prepared.source);assert.equal(r.undone,source);assert.equal(r.redone,r.formatted);assert.equal(r.reopened,r.formatted);
  assert.deepEqual(r.position,r.resolved);assert.equal(r.history.undoGroups,1);
  const old=r.before.find(n=>n.id===r.owner), fresh=r.after.find(n=>n.id===r.owner), oldSource=old.blockAttributes[2].source, newSource=fresh.blockAttributes[2].source;
  const start=source.indexOf(oldSource);assert(start>=0);
  assert.equal(r.formatted,source.slice(0,start)+newSource+source.slice(start+oldSource.length));
  assert.notEqual(newSource,oldSource);
  for(const node of r.before) {
    const next=r.after.find(n=>n.id===node.id);
    if(node.id!==r.owner)assert.deepEqual(next,node);
    else assert.deepEqual({...next,blockAttributes:null},{...node,blockAttributes:null});
  }
  assert.equal(r.events.length,1);assert.deepEqual(r.events[0].changedNodes,[r.owner]);assert.deepEqual(r.events[0].changedSources,[...new Set(old.spans.map(s=>s.source))].sort());assert.deepEqual(r.events[0].touchedRanges,[]);
  assert.equal(r.journal.filter(j=>j.origin==='editac:local:local:table-source').length,1);
  assert.equal(r.journal.filter(j=>j.origin==='history:undo').length,1);assert.equal(r.journal.filter(j=>j.origin==='history:redo').length,1);
}));

test('stale preparation, delayed commit and consumed handles reject without extra mutation',()=>probe('stale',async(page,fact)=>{
  await setup(page);
  const r=await page.evaluate(()=>{
    const f=window.inputFixture,e=f.engine,t=window.tableFixture;
    const p=t.base.prepareTableFormat(t.tables[0],'local:table-source');
    const at=e.anchor(t.owners[0],0,'right');f.commit({kind:'text',origin:'local:other',command:{type:'insert',at,text:'remote '}});e.releaseAnchor(at);
    const before=Array.from(e.checkpoint().bytes),errors=[];
    for(const action of [()=>t.base.prepareTableFormat(t.tables[0],'local:table-source'),()=>f.storage.commitPrepared(p.plan),()=>f.storage.commitPrepared(p.plan),()=>t.base.sourceWithCurrentTable(t.tables[0])])try{action();}catch(e){errors.push(e.message);}
    return {before,after:Array.from(e.checkpoint().bytes),errors};
  });
  assert.deepEqual(r.before,r.after);assert.equal(r.errors.length,4);assert.match(r.errors[0],/StalePlan/);assert.match(r.errors[1],/StalePlan/);assert.match(r.errors[2],/consumed/);assert.match(r.errors[3],/Overlap/);fact.snapshots.push(r);
}));

test('formatter no-op is byte/history/storage silent and delayed no-op remains revision checked',()=>probe('noop',async(page,fact)=>{
  await setup(page);
  const r=await page.evaluate(async()=>{
    const f=window.inputFixture,e=f.engine,t=window.tableFixture,owner=t.tables[0];
    const first=t.base.prepareTableFormat(owner,'local:table-source');f.storage.commitPrepared(first.plan);await f.storage.flush({target:'local'});
    const base=e.captureSourceBaseline(first.source,t.owners,{tables:true}), plan=base.prepareTableFormat(owner,'local:table-source');
    const before=Array.from(e.checkpoint().bytes),history=e.history({type:'state'}),journal=(await f.state()).journal;
    f.storage.commitPrepared(plan.plan);await f.storage.flush({target:'local'});
    const after=Array.from(e.checkpoint().bytes),afterHistory=e.history({type:'state'}),afterJournal=(await f.state()).journal;
    const stale=base.prepareTableFormat(owner,'local:table-source');
    const at=e.anchor(t.owners[0],0,'right');f.commit({kind:'text',origin:'local:other',command:{type:'insert',at,text:'x'}});e.releaseAnchor(at);
    let error;try{f.storage.commitPrepared(stale.plan);}catch(e){error=e.message;}
    return {changed:plan.changed,before,after,history,afterHistory,journal,afterJournal,error};
  });assert.equal(r.changed,false);assert.deepEqual(r.before,r.after);assert.deepEqual(r.history,r.afterHistory);assert.deepEqual(r.journal,r.afterJournal);assert.match(r.error,/StalePlan/);fact.snapshots.push(r);
}));

test('invalid targets, ambiguous bindings, disabled codec and resource limits reject with zero mutation',()=>probe('invalid',async(page,fact)=>{
  await setup(page);
  const r=await page.evaluate(()=>{
    const f=window.inputFixture,e=f.engine,t=window.tableFixture,before=Array.from(e.checkpoint().bytes),errors=[];
    for(const action of [()=>t.base.prepareTableFormat(t.owners[0],'local:table-source'),()=>t.base.prepareTableFormat('missing','local:table-source'),()=>e.captureSourceBaseline(t.source,t.owners.map(()=>t.owners[0]),{tables:true}),()=>e.captureSourceBaseline(t.source,t.owners,{tables:false}).prepareTableFormat(t.tables[0],'local:table-source'),()=>e.captureSourceBaseline('x'.repeat(1048577),t.owners,{tables:true})])try{action();}catch(e){errors.push(e.message);}
    return {before,after:Array.from(e.checkpoint().bytes),errors,history:e.history({type:'state'})};
  });assert.deepEqual(r.before,r.after);assert.equal(r.errors.length,5);assert.equal(r.history.undoGroups,0);fact.snapshots.push({errors:r.errors,history:r.history});
}));

test('excess ignored cells reject losslessly; CRLF, Unicode and EOF source policies remain intact',()=>probe('limits',async(page,fact)=>{
  const raw='| a |\n| - |\n| b | discarded |';await setup(page,raw);
  const r=await page.evaluate(()=>{const f=window.inputFixture,t=window.tableFixture,before=Array.from(f.engine.checkpoint().bytes);let error;try{t.base.prepareTableFormat(t.tables[0],'local:table-source');}catch(e){error=e.message;}return {before,after:Array.from(f.engine.checkpoint().bytes),error,original:t.base.originalSource};});
  assert.match(r.error,/UnsupportedContent/);assert.deepEqual(r.before,r.after);assert.equal(r.original,raw);fact.snapshots.push({error:r.error,source:r.original});
}));

test('baseline, codec and Session teardown release authority and reject late source actions',()=>probe('dispose',async(page,fact)=>{
  await setup(page);
  const r=await page.evaluate(async()=>{
    const f=window.inputFixture,e=f.engine,t=window.tableFixture,errors=[];
    const released=e.captureSourceBaseline(t.source,t.owners,{tables:true});released.dispose();released.dispose();
    try{released.prepareTableFormat(t.tables[0],'local:table-source');}catch(e){errors.push(e.code);}
    f.disableMarkdown();try{t.base.prepareTableFormat(t.tables[0],'local:table-source');}catch(e){errors.push(e.code);}
    await f.destroy();window.fixtureDisposed=true;try{t.base.sourceWithCurrentTable(t.tables[0]);}catch(e){errors.push(e.code);}
    return errors;
  });assert.deepEqual(r,['Disposed','CapabilityUnavailable','Disposed']);fact.snapshots.push(r);
}));


test('public BrowserEditor admits prepared source through current readonly policy and durable reopen',()=>probe('public-editor',async(page,fact)=>{
  await setup(page);
  const r=await page.evaluate(async()=>{
    const f=window.inputFixture,t=window.tableFixture, identity=f.engine.read().identity;
    await f.destroy();window.fixtureDisposed=true;
    const {mountEditor}=await import('/web/index.js');
    const {initMarkdown}=await import('/markdown/index.js');const {markdownExtension}=await import('/markdown/web.js');
    const markdown=markdownExtension(await initMarkdown('/markdown/wasm/editac_markdown_wasm_bg.wasm'));
    const options={assetUrl:'/core/wasm/editac_wasm_bg.wasm',databaseName:'browser-input',identity,indexedDB,locks:navigator.locks,markdown,preset:'minimal',commandControls:false};
    const editor=mountEditor(f.root,options);window.activeEditor=editor;await editor.ready;
    const base=editor.captureSourceBaseline(t.source,t.owners,{tables:true}),p=base.prepareTableFormat(t.tables[1],'local:public-source');
    const before=editor.read();editor.setReadOnly(true);let denied;
    try{editor.commitPrepared(p.plan);}catch(e){denied=e.message;}
    const afterDenied=editor.read();editor.setReadOnly(false);
    try{editor.commitPrepared(p.plan);}finally{editor.releasePlan(p.plan);}
    await editor.flush({target:'local'});const formatted=base.sourceWithCurrentTable(t.tables[1]);
    await editor.destroy({policy:'flush'});
    const reopened=mountEditor(f.root,options);window.activeEditor=reopened;await reopened.ready;
    const recovered=reopened.captureSourceBaseline(t.source,t.owners,{tables:true},t.opening);
    const restored=recovered.sourceWithCurrentTable(t.tables[1]);recovered.dispose();base.dispose();
    return {before,afterDenied,denied,formatted,restored,expected:p.source,state:reopened.state};
  });assert.match(r.denied,/read-only/);assert.deepEqual(r.before,r.afterDenied);assert.equal(r.formatted,r.expected);assert.equal(r.restored,r.expected);
  assert(fact.requests.some(u=>u.endsWith('/web/index.js')));assert(fact.requests.some(u=>u.endsWith('/core/index.js')));fact.snapshots.push(r);
}));
