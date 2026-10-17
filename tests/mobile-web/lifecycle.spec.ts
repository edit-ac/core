import assert from 'node:assert/strict';
import { test } from 'node:test';
import { browserHarness } from '../browser/browser-harness.ts';
import { browserInputSources } from '../editing/browser-driver.ts';
import { installResourceCounters } from './resources.mjs';
const { probe, facts } = browserHarness('mobile-harness', 'fixtures/browser-mobile-web', {
  autoMount: false, markdown: true, testFile: 'tests/mobile-web/lifecycle.spec.ts', assertSourcesUnchanged: true,
  contextOptions: { viewport: { width: 390, height: 740 }, hasTouch: true, isMobile: true },
  beforeNavigate: async page => page.addInitScript(installResourceCounters),
  sourcePaths: [...browserInputSources, ...['editor','surface','lifecycle','input/text','clipboard/fragment','clipboard/pending','platform/viewport','modules/reorder'].flatMap(n => [`packages/web/src/${n}.ts`, `packages/web/dist/${n}.js`]),
    'fixtures/browser-mobile-web/session.mjs', 'fixtures/browser-mobile-web/index.html', 'tests/mobile-web/lifecycle.spec.ts', 'tests/mobile-web/resources.mjs', 'tests/mobile-web/catalog.mjs', 'tests/mobile-web/case-index.json', 'scripts/test-mobile-web.mjs', '../architecture/specs/mobile-web.md', '../architecture/tests/mobile-web-cases.md'],
});
facts.binding = { gate: 'MWF-1.6', originalParent: 'MWB-1.6', ids: Array.from({length:12},(_,i)=>`MBC-${String(i+1).padStart(2,'0')}`),
  provenance: 'prepared clipboard/input/page lifecycle traces; real packed BrowserEditor/recovered Session/Rust-WASM/IndexedDB; actual native menus/IME/OS picker/BFCache/eviction/cross-app/device observations deferred' };
const MIME = 'application/x-edit-ac-fragment+json';
async function mount(page, options:any = {}, a=1, b=4) {
  await page.waitForFunction(()=>!!(window as any).inputFixture);
  const baseline = await page.evaluate(()=>(window as any).mobileResources());
  await page.evaluate(async ({options,a,b})=>{const f=(window as any).inputFixture; await f.mount({text:'alpha',...options}); f.select(f.ids[0],a,b); await f.settle();}, {options,a,b});
  return baseline;
}
async function state(page, fact) { const s=await page.evaluate(()=>(window as any).inputFixture.state()); assert.deepEqual(s.errors,[]); assert.equal(s.storage,'localCommitted'); fact.snapshots.push(s); return s; }
const text = s => s.nodes.filter(n=>n.kind==='block').map(n=>n.runs.map(r=>r.text).join(''));
function unchanged(a,b) { for(const key of ['nodes','history','patches','journal'])assert.deepEqual(b[key],a[key],key); }
function commits(s,n,undo=n) { assert.equal(s.patches.filter(p=>p.update).length,n,'mutation count');assert.equal(s.journal.length,n,'durable journal');assert.equal(s.history.undoGroups,undo,'history boundaries'); }
async function cleanup(page,baseline,fact) {
  await page.evaluate(async()=>{const w=window as any;await w.second?.dispose();await w.inputFixture.destroy();});
  await page.evaluate(()=>new Promise<void>(r=>requestAnimationFrame(()=>r())));
  const after=await page.evaluate(()=>(window as any).mobileResources());fact.resources={baseline,after};assert.deepEqual(after,baseline);
}
async function native(page, flavors, trace='event') {
  return page.evaluate(({flavors,trace})=>{
    const w=window as any,f=w.inputFixture,data=new DataTransfer();for(const [mime,value]of Object.entries(flavors))data.setData(mime,value as string);
    if(trace==='event'||trace==='echo'){f.root.dispatchEvent(w.preparedClipboardEvent('paste',data));}
    if(trace!=='event'){
      const event=new InputEvent('beforeinput',{bubbles:true,cancelable:trace!=='noncancelable',inputType:'insertFromPaste',data:flavors['text/plain']??null});
      Object.defineProperty(event,'dataTransfer',{value:data});f.root.dispatchEvent(event);
      if(trace==='noncancelable')f.mutate('a'+flavors['text/plain']+'a',0,1+flavors['text/plain'].length);
      f.deliver('input',{inputType:'insertFromPaste'});f.deliver('input',{inputType:'insertFromPaste'});
    }
  },{flavors,trace});
}
async function pageEvent(page,type) { await page.evaluate(type=>window.dispatchEvent(new PageTransitionEvent(type,{persisted:true})),type); }
async function pending(page, kind='plain') {
  await page.evaluate(kind=>{const w=window as any,f=w.inputFixture;w.releasePaste=undefined;
    const wait=()=>new Promise<void>(resolve=>w.releasePaste=resolve);
    if(kind==='plain')w.pending=f.surface.pastePlainText(async()=>{await wait();return 'X';});
    else {w.job=f.surface.pasteDeferred({getData:m=>m==='text/plain'?'X':''},{schedule:wait});w.pending=w.job.result;}
  },kind);
  await page.waitForFunction(()=>typeof (window as any).releasePaste==='function');
}
async function release(page) { return page.evaluate(async()=>{const w=window as any;w.releasePaste();return w.pending;}); }

for(const outcome of ['throw','discard','success'])test(`MBC-01 cut ${outcome} requires verified clipboard write`,()=>probe('MBC-01-'+outcome,async(page,fact)=>{
  const baseline=await mount(page);const before=await state(page,fact);
  const copied=await page.evaluate(outcome=>{const w=window as any,f=w.inputFixture,values={};const data={getData:m=>values[m]??'',setData:(m,v)=>{if(outcome==='throw')throw Error('prepared write denied');if(outcome!=='discard')values[m]=v;}};f.root.dispatchEvent(w.preparedClipboardEvent('cut',data));return values;},outcome);
  const s=await state(page,fact);if(outcome==='success'){assert.equal(copied['text/plain'],'lph');assert.deepEqual(text(s),['aa']);commits(s,1);}else unchanged(before,s);
  await cleanup(page,baseline,fact);
}));
for(const api of ['absent','denied','expired'])test(`MBC-02/10 ${api} scripted clipboard retains native paste without mount requests`,()=>probe('MBC-02-'+api,async(page,fact)=>{
  await page.waitForFunction(()=>!!(window as any).inputFixture);
  await page.evaluate(api=>{const w=window as any;w.reads=0;Object.defineProperty(navigator,'clipboard',{configurable:true,value:api==='absent'?undefined:{readText:async()=>{w.reads++;throw Error(api);}}});},api);
  const baseline=await mount(page);const before=await state(page,fact);assert.equal(await page.evaluate(()=>(window as any).reads),0);
  assert.equal((await page.evaluate(()=>(window as any).inputFixture.surface.pastePlainText())).disposition,'rejected');unchanged(before,await state(page,fact));
  await native(page,{'text/plain':'N'},'echo');const s=await state(page,fact);assert.deepEqual(text(s),['aNa']);commits(s,1);await cleanup(page,baseline,fact);
}));
for(const trace of ['echo','beforeinput','noncancelable'])test(`MBC-08 ${trace} paste has one commit and journal despite duplicate notifications`,()=>probe('MBC-08-'+trace,async(page,fact)=>{
  const baseline=await mount(page);await native(page,{'text/plain':'é😀'},trace);const s=await state(page,fact);assert.deepEqual(text(s),['aé😀a']);commits(s,1);assert.equal(s.selection.anchor.offset,4);assert.equal(s.selection.focus.offset,4);await cleanup(page,baseline,fact);
}));
for(const trace of ['event','beforeinput','noncancelable'])test(`MBC-09 equal ${trace} payloads are distinct paste intents`,()=>probe('MBC-09-'+trace,async(page,fact)=>{
  const baseline=await mount(page);await native(page,{'text/plain':'X'},trace);await state(page,fact);
  await page.evaluate(()=>{const f=(window as any).inputFixture;f.select(f.ids[0],1,2);});await native(page,{'text/plain':'X'},trace);
  const s=await state(page,fact);assert.deepEqual(text(s),['aXa']);commits(s,2);await cleanup(page,baseline,fact);
}));
for(const kind of ['plain','deferred'])test(`MBC-03/11 ${kind} delayed paste retains stable target and later backward selection`,()=>probe('MBC-03-stable-'+kind,async(page,fact)=>{
  const baseline=await mount(page);await pending(page,kind);
  await page.evaluate(async()=>{const f=(window as any).inputFixture;await f.remote(0,0,'R');f.select(f.ids[0],6,5);});
  const before=await state(page,fact);const outcome=await release(page);assert.equal(outcome.disposition,'committed');const s=await state(page,fact);assert.deepEqual(text(s),['RaXa']);commits(s,2,1);assert.deepEqual(s.selection,{anchor:{...before.selection.anchor,offset:4},focus:{...before.selection.focus,offset:3}});await cleanup(page,baseline,fact);
}));
for(const kind of ['plain','deferred'])for(const transition of ['readonly','pagehide','hidden','target-delete','cancel'])test(`MBC-03/11 ${kind} cancels on ${transition}`,()=>probe('MBC-11-'+kind+'-'+transition,async(page,fact)=>{
  const baseline=await mount(page,transition==='target-delete'?{nodes:[{text:'other'},{text:'alpha'}]}:{});if(transition==='target-delete')await page.evaluate(()=>{const f=(window as any).inputFixture;f.select(f.ids[1],1,4);});await pending(page,kind);
  await page.evaluate(transition=>{const w=window as any,f=w.inputFixture;
    if(transition==='readonly')f.surface.setReadOnly(true);
    if(transition==='pagehide')window.dispatchEvent(new PageTransitionEvent('pagehide',{persisted:true}));
    if(transition==='hidden'){Object.defineProperty(document,'visibilityState',{configurable:true,value:'hidden'});document.dispatchEvent(new Event('visibilitychange'));}
    if(transition==='target-delete'){f.surface.commit({kind:'editor',origin:'prepared-delete-target',commands:[{type:'join',first:f.ids[0],second:f.ids[1]}]});}
    if(transition==='cancel'){if(w.job)w.job.cancel();else f.surface.setReadOnly(true);}
  },transition);
  const before=await state(page,fact);const outcome=await release(page);assert.equal(outcome.disposition,'rejected');unchanged(before,await state(page,fact));await cleanup(page,baseline,fact);
}));
for(const kind of ['plain','deferred'])test(`MBC-07/11 ${kind} late result after disposal cannot affect sibling or replacement session`,()=>probe('MBC-07-'+kind,async(page,fact)=>{
  const baseline=await mount(page);await pending(page,kind);await page.evaluate(async()=>{const w=window as any;w.second=await w.inputFixture.sibling();w.second.root.focus();await w.inputFixture.destroy();});
  const before=await page.evaluate(()=>(window as any).second.editor.read());const outcome=await release(page);assert.equal(outcome.disposition,'rejected');assert.deepEqual(await page.evaluate(()=>(window as any).second.editor.read()),before);
  await page.evaluate(async()=>{await (window as any).inputFixture.recover();});const s=await state(page,fact);assert.deepEqual(text(s),['alpha']);commits(s,0);await cleanup(page,baseline,fact);
}));
test('MBC-06 picker/share blur cancellations and repeated return do not refocus or replay',()=>probe('MBC-06-picker-return',async(page,fact)=>{
  const baseline=await mount(page);await pending(page);await page.locator('#host-control').focus();const before=await state(page,fact);
  await pageEvent(page,'pagehide');await pageEvent(page,'pageshow');await pageEvent(page,'pageshow');assert.equal((await release(page)).disposition,'rejected');unchanged(before,await state(page,fact));assert.equal(await page.locator('#host-control').evaluate(el=>document.activeElement===el),true);
  await page.evaluate(()=>{const f=(window as any).inputFixture;f.select(f.ids[0],1,4);});await pending(page);await page.locator('#host-control').focus();assert.equal((await release(page)).disposition,'committed');const s=await state(page,fact);assert.deepEqual(text(s),['aXa']);commits(s,1);assert.equal(s.focus,false);assert.equal((await release(page)).disposition,'committed');unchanged(s,await state(page,fact));await cleanup(page,baseline,fact);
}));
test('MBC-04 page lifecycle finalizes observed composition once and suspends adapters idempotently',()=>probe('MBC-04-composition',async(page,fact)=>{
  const baseline=await mount(page,{},5,5);await page.evaluate(()=>{const f=(window as any).inputFixture;f.deliver('compositionstart');f.mutate('alpha日本');f.deliver('input',{inputType:'insertCompositionText',data:'日本',isComposing:true});});
  await pageEvent(page,'pagehide');const suspended=await state(page,fact);assert.deepEqual(text(suspended),['alpha日本']);commits(suspended,1);
  const counts=await page.evaluate(()=>(window as any).mobileResources());
  for(let i=0;i<8;i++){await pageEvent(page,'pagehide');await pageEvent(page,'pageshow');}
  await page.evaluate(()=>{const f=(window as any).inputFixture;f.deliver('compositionend',{data:'日本'});f.deliver('input',{inputType:'insertCompositionText',data:'日本'});});
  unchanged(suspended,await state(page,fact));assert.equal((await page.evaluate(()=>(window as any).mobileResources())).listeners,counts.listeners);await native(page,{'text/plain':'!'},'echo');const s=await state(page,fact);assert.deepEqual(text(s),['alpha日本!']);commits(s,2);await cleanup(page,baseline,fact);
}));
test('MBC-04 hidden/pagehide interleaving retains host read-only policy without focus theft',()=>probe('MBC-04-hidden',async(page,fact)=>{
  const baseline=await mount(page);const before=await state(page,fact);await page.evaluate(()=>{Object.defineProperty(document,'visibilityState',{configurable:true,value:'hidden'});document.dispatchEvent(new Event('visibilitychange'));});await pageEvent(page,'pagehide');
  await page.evaluate(()=>{const f=(window as any).inputFixture;f.surface.setReadOnly(false);Object.defineProperty(document,'visibilityState',{configurable:true,value:'visible'});document.dispatchEvent(new Event('visibilitychange'));});
  assert.equal(await page.locator('#projection').getAttribute('contenteditable'),'false');await pageEvent(page,'pageshow');assert.equal(await page.locator('#projection').getAttribute('contenteditable'),'true');unchanged(before,await state(page,fact));
  await pageEvent(page,'pagehide');await page.evaluate(()=>(window as any).inputFixture.surface.setReadOnly(true));await pageEvent(page,'pageshow');assert.equal(await page.locator('#projection').getAttribute('contenteditable'),'false');unchanged(before,await state(page,fact));await cleanup(page,baseline,fact);
}));
test('MBC-04/07 suspended viewport leases survive sibling disposal with no idle frames',()=>probe('MBC-04-viewport-leases',async(page,fact)=>{
  const baseline=await mount(page,{viewport:true});await page.evaluate(async()=>{const w=window as any;w.second=await w.inputFixture.sibling();});await pageEvent(page,'pagehide');
  await page.evaluate(async()=>{const w=window as any;await w.second.dispose();w.second=undefined;for(let i=0;i<12;i++)window.dispatchEvent(new Event('resize'));});
  const v=await page.evaluate(()=>(window as any).inputFixture.surface.viewport.state);assert.equal(v.suspended,true);assert.equal(v.pendingFrame,false);const before=await state(page,fact);await pageEvent(page,'pageshow');
  await page.evaluate(()=>new Promise<void>(r=>requestAnimationFrame(()=>r())));assert.equal(await page.evaluate(()=>(window as any).inputFixture.surface.viewport.state.suspended),false);unchanged(before,await state(page,fact));await cleanup(page,baseline,fact);
}));
test('MBC-04 pointer pagehide cancels provisional reorder without a mutation',()=>probe('MBC-04-pointer',async(page,fact)=>{
  const baseline=await mount(page,{nodes:[{text:'alpha'},{text:'beta'},{text:'gamma'}],reorder:true});
  await page.evaluate(()=>{const f=(window as any).inputFixture;f.surface.reorder.controls.style.cssText='position:fixed;bottom:4px;left:4px';});
  const grip=page.getByRole('button',{name:'Drag selected block',exact:true}),box=await grip.boundingBox();assert.ok(box);await page.mouse.move(box.x+10,box.y+10);await page.mouse.down();assert.equal(await page.evaluate(()=>(window as any).inputFixture.pointer.captured),true);
  const before=await state(page,fact);await pageEvent(page,'pagehide');assert.equal(await page.evaluate(()=>(window as any).inputFixture.pointer.captured),false);await page.mouse.up();assert.equal(await page.evaluate(()=>(window as any).inputFixture.pointer.retainedSelection),false);unchanged(before,await state(page,fact));await pageEvent(page,'pageshow');await cleanup(page,baseline,fact);
}));
test('MBC-05 localCommitted survives offline recovery; failed persistence exports unsaved content separately',()=>probe('MBC-05-recovery',async(page,fact)=>{
  const baseline=await mount(page);await native(page,{'text/plain':'saved'},'echo');const saved=await state(page,fact);commits(saved,1);
  const report=await page.evaluate(async()=>{
    const f=(window as any).inputFixture,{UpdateJournal}=await import('/web/storage/journal.js'),append=UpdateJournal.prototype.append;
    UpdateJournal.prototype.append=async()=>{throw Error('prepared transaction failure');};
    try {
      f.select(f.engine.read().visible[0].id,7,7);
      const result=f.surface.paste({getData:m=>m==='text/plain'?'UNSAVED':''},{literal:true});
      let failure;try{await f.surface.flush({target:'local'});}catch(error){failure=error.message;}
      const state=f.surface.state,closed=await f.destroy('report');
      return {result,failure,localCommitted:state.localCommitted,unsaved:closed.unsaved,recoveryUpdates:closed.recovery.unsavedUpdates.map(u=>({origin:u.origin,bytes:u.bytes.length}))};
    }finally{UpdateJournal.prototype.append=append;}
  });fact.durability=report;assert.equal(report.result.disposition,'committed');assert.ok(report.failure);assert.ok(report.localCommitted);assert.equal(report.unsaved,true);assert.equal(report.recoveryUpdates.length,1);assert.ok(report.recoveryUpdates[0].bytes>0);
  await page.route('**/*',route=>route.abort());await page.evaluate(async()=>(window as any).inputFixture.recover());const s=await state(page,fact);assert.deepEqual(text(s),['asaveda']);assert.equal(s.journal.length,1);assert.equal(s.history.undoGroups,0);assert.equal(s.patches.filter(p=>p.update).length,0);await cleanup(page,baseline,fact);
}));
const rich=JSON.stringify({version:1,schema:'editac.registry.editor.v5',blocks:[{attributes:{type:'heading',level:2},runs:[{text:'Internal',marks:[{mark:'bold'}]}]}]});
for(const flavor of ['internal','markdown','html','literal'])test(`MBC-10 ${flavor} precedence uses one bounded import`,()=>probe('MBC-10-'+flavor,async(page,fact)=>{
  const baseline=await mount(page,{palette:true});const flavors={'text/plain':'**plain**','text/html':'<p><em>HTML</em></p>', 'text/markdown':'# Markdown',...(flavor==='internal'?{[MIME]:rich}:{})};
  if(flavor==='html')delete flavors['text/markdown'];
  const r=await page.evaluate(({flavors,literal})=>(window as any).inputFixture.surface.paste({getData:m=>flavors[m]??''},{literal}),{flavors,literal:flavor==='literal'});assert.equal(r.disposition,'committed');const s=await state(page,fact);commits(s,1);
  if(flavor==='internal')assert.ok(s.nodes.some(n=>n.runs.some(r=>r.text.includes('Internal')&&r.attributes.bold)));
  if(flavor==='markdown')assert.ok(s.nodes.some(n=>n.blockAttributes?.[0]==='heading'));
  if(flavor==='html')assert.ok(s.nodes.some(n=>n.runs.some(r=>r.text.includes('HTML')&&r.attributes.italic)));
  if(flavor==='literal'){assert.deepEqual(text(s),['a**plain**a']);assert.ok(s.nodes.every(n=>n.runs.every(r=>Object.keys(r.attributes).length===0)));}
  await cleanup(page,baseline,fact);
}));
const palette='# **é😀**\n\n> - [x] ~~task~~ [link](https://example.com)\n>   - child\n\n```js\n  literal\n```\n\n![caption](https://example.com/image.png)\n\n| A | B |\n|:-|:-:|\n| **cell** | 😀 |\n';
test('MBC-12 registered palette copy/paste round-trips structure and formatting through production owners',()=>probe('MBC-12-palette',async(page,fact)=>{
  const baseline=await mount(page,{palette:true},0,5);await native(page,{'text/markdown':palette,'text/plain':'wrong'},'echo');let s=await state(page,fact);commits(s,1);
  for(const kind of ['module:editac.table','module:editac.image','code'])assert.ok(s.nodes.some(n=>n.blockAttributes?.[0]===kind),kind);
  assert.ok(s.nodes.some(n=>n.editor?.checked===true));assert.ok(s.nodes.some(n=>n.runs.some(r=>r.attributes.link==='https://example.com/')));assert.ok(s.nodes.some(n=>n.runs.some(r=>r.attributes.bold===true)));
  const copied=await page.evaluate(()=>{const w=window as any,f=w.inputFixture,nodes=f.engine.read().visible.filter(n=>n.kind==='block'),last=nodes.at(-1);f.select(nodes[0].id,0,last.runs.map(r=>r.text).join('').length,last.id);const data=new DataTransfer();f.root.dispatchEvent(w.preparedClipboardEvent('copy',data));return Object.fromEntries([...data.types].map(m=>[m,data.getData(m)]));});assert.ok(copied[MIME]);fact.copied=copied;
  const normalize=nodes=>nodes.map(n=>({kind:n.kind,attrs:n.blockAttributes,runs:n.runs,container:n.editor?.containerAttributes,checked:n.editor?.checked}));
  const original=normalize(s.nodes);
  // Shared admission rejects replacement across this mixed structured target.
  // Keep that data-safety negative, then exercise the existing supported transfer
  // destination after undo, as in the canonical full-palette codec suite.
  const transfer=await page.evaluate(copied=>(window as any).inputFixture.surface.paste({getData:m=>copied[m]??''}),copied);fact.mixedTarget=transfer;
  assert.equal(transfer.disposition,'rejected');unchanged(s,await state(page,fact));
  await page.evaluate(()=>{const f=(window as any).inputFixture;f.engine.history({type:'undo'});f.select(f.engine.read().visible[0].id,0,5);});
  await native(page,copied,'echo');s=await state(page,fact);commits(s,3,1);assert.deepEqual(normalize(s.nodes),original);await cleanup(page,baseline,fact);
}));
test('MBC-02/12 unsupported rich codec preserves inert source diagnostics without script execution',()=>probe('MBC-12-inert',async(page,fact)=>{
  const baseline=await mount(page);const raw='<table><tr><td><b>cell</b></td></tr></table>';await native(page,{'text/html':raw,'text/plain':'cell'},'echo');const s=await state(page,fact);assert.deepEqual(text(s),['acella']);commits(s,1);
  const recovery=await page.evaluate(()=>(window as any).inputFixture.surface.clipboardRecovery);assert.ok(recovery.some(r=>r.raw===raw&&r.mime==='text/html'&&r.reason.includes('requires-extension-codec')));await cleanup(page,baseline,fact);
}));
for(const modifier of ['Control','Meta'])test(`MBC-10 prepared ${modifier}+Shift+V retains platform literal paste policy`,()=>probe('MBC-10-shortcut-'+modifier,async(page,fact)=>{
  const baseline=await mount(page,{palette:true});const nativeModifier=await page.evaluate(modifier=>/Mac|iPhone|iPad/.test(navigator.platform)?modifier==='Meta':modifier==='Control',modifier);
  await page.evaluate(modifier=>{const f=(window as any).inputFixture;f.deliver('keydown',{key:'v',shiftKey:true,ctrlKey:modifier==='Control',metaKey:modifier==='Meta'});},modifier);
  await native(page,{'text/plain':'# **literal**','text/markdown':'# Rich'},'echo');const s=await state(page,fact);commits(s,1);fact.shortcut={modifier,nativeModifier};
  if(nativeModifier){assert.deepEqual(text(s),['a# **literal**a']);assert.equal(s.nodes[0].blockAttributes[0],'paragraph');assert.ok(s.nodes[0].runs.every(r=>!r.attributes.bold));}
  else assert.ok(s.nodes.some(n=>n.blockAttributes?.[0]==='heading'));
  await cleanup(page,baseline,fact);
}));
test('MBC-03/11 captured literal control intent is invalid after suspension even when resumed',()=>probe('MBC-11-captured-control',async(page,fact)=>{
  const baseline=await mount(page);await page.evaluate(()=>{const w=window as any;w.intent=w.inputFixture.surface.capturePlainPaste();w.reads=0;});const before=await state(page,fact);
  await pageEvent(page,'pagehide');await pageEvent(page,'pageshow');const r=await page.evaluate(async()=>{const w=window as any;return w.intent.paste(async()=>{w.reads++;return 'stale';});});assert.equal(r.disposition,'rejected');assert.equal(await page.evaluate(()=>(window as any).reads),0);unchanged(before,await state(page,fact));await cleanup(page,baseline,fact);
}));
test('MBC-02 native flavors are captured once and oversized payload leaves semantic state intact',()=>probe('MBC-02-bounds',async(page,fact)=>{
  const baseline=await mount(page);const before=await state(page,fact);
  const observed=await page.evaluate(()=>{const f=(window as any).inputFixture,reads={};const result=f.surface.paste({getData:m=>{reads[m]=(reads[m]??0)+1;return m==='text/plain'?'x'.repeat(1024*1024+1):'';}});return {reads,result};});fact.bounds=observed;assert.equal(observed.result.disposition,'rejected');assert.ok(Object.values(observed.reads).every(n=>n===1));unchanged(before,await state(page,fact));await cleanup(page,baseline,fact);
}));
test('MBC-12 registered attachment identity, caption and inert source survive clipboard round trip',()=>probe('MBC-12-caption',async(page,fact)=>{
  const baseline=await mount(page,{},0,5);
  const descriptor={identity:{host:'prepared',key:'captioned_asset'},kind:'image',metadata:{filename:'image.png',mediaType:'image/png',byteLength:null,sha256:null,width:null,height:null,durationMs:null,alt:'Accessible alt',caption:'Caption é😀'},fallback:'captioned image',source:'prepared inert source'};
  const payload=JSON.stringify({version:1,schema:'editac.registry.editor.v5',blocks:[{attributes:{type:'content',tuple:['module:editac.asset',1,descriptor]},runs:[{text:descriptor.fallback,marks:[]}]}]});
  await native(page,{[MIME]:payload,'text/plain':'wrong'},'echo');let s=await state(page,fact);commits(s,1);assert.deepEqual(s.nodes.find(n=>n.blockAttributes?.[0]==='module:editac.asset').blockAttributes[2],descriptor);
  const copied=await page.evaluate(()=>{const w=window as any,f=w.inputFixture,n=f.engine.read().visible.filter(n=>n.kind==='block');f.select(n[0].id,0,0,n.at(-1).id);const data=new DataTransfer();f.root.dispatchEvent(w.preparedClipboardEvent('copy',data));return Object.fromEntries([...data.types].map(m=>[m,data.getData(m)]));});assert.ok(copied[MIME]);
  await page.evaluate(()=>{const f=(window as any).inputFixture;f.engine.history({type:'undo'});f.select(f.engine.read().visible[0].id,0,5);});await native(page,copied,'echo');s=await state(page,fact);commits(s,3,1);assert.deepEqual(s.nodes.find(n=>n.blockAttributes?.[0]==='module:editac.asset').blockAttributes[2],descriptor);await cleanup(page,baseline,fact);
}));
