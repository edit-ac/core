import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {test} from 'node:test';
import {browserHarness} from './browser-harness.ts';
const corpus=JSON.parse(await readFile('fixtures/rich-presenters/formatting/mixed-extensions.json','utf8'));
const mime='application/x-edit-ac-extension+json',fragment='application/x-edit-ac-fragment+json';
const {probe}=browserHarness('extension-formatting-mixed','fixtures/browser-extension-formatting',{markdown:true,assertSourcesUnchanged:true,testFile:'tests/browser/extension-formatting-mixed.spec.ts',sourcePaths:[
 'packages/web/src/modules/transfer.ts','packages/web/src/modules/index.ts','packages/web/src/modules/content.ts','packages/web/src/dom/render.ts','packages/web/src/clipboard/fragment.ts','packages/core/src/extensions/transfer.ts',
 'fixtures/browser-extension-formatting/session.mjs','fixtures/browser-extension-formatting/index.html','fixtures/rich-presenters/formatting/mixed-extensions.json',
 'packages/web/src/modules/images/presenter.ts','packages/web/src/modules/attachments/presenter.ts','packages/web/src/modules/math.ts','packages/web/src/modules/math-renderer.ts','packages/web/src/dom/marks.ts','packages/web/src/modules/registry.ts',
],beforeNavigate:async(p,f)=>{p.setDefaultTimeout(5000);await p.route('https://**/*',route=>{f.externalRequests??=[];f.externalRequests.push(route.request().url());return route.abort();});}});
const config={descriptors:corpus.descriptors.filter(d=>!['editac.math','editac.inert'].includes(d.type)),unavailable:corpus.unavailable};
async function state(p,f){const s=await p.evaluate(()=>window.inputFixture.state());f.snapshots.push(s);assert.deepEqual(s.errors,[]);assert.deepEqual(s.moduleErrors,[]);return s;}
const blocks=s=>s.nodes.filter(n=>n.kind==='block').map(n=>({attributes:n.blockAttributes,runs:n.runs}));
const semantic=s=>s.nodes.map(n=>({kind:n.kind,attributes:n.blockAttributes,runs:n.runs,container:n.editor?.containerAttributes,checked:n.editor?.checked}));
function unchanged(a,b){assert.deepEqual(b.nodes,a.nodes);assert.deepEqual(b.history,a.history);assert.deepEqual(b.journal,a.journal);assert.equal(b.commands.length,a.commands.length);}
function one(a,b){assert.equal(b.history.undoGroups,a.history.undoGroups+1);assert.equal(b.journal.length,a.journal.length+1);assert.equal(b.commands.length,a.commands.length+1);assert.equal(b.patches.length,a.patches.length+1);}
const offer=e=>({[mime]:JSON.stringify(e),'text/html':'<h1>wrong HTML</h1>','text/markdown':'# wrong Markdown','text/plain':'wrong plain'});
async function select(p,reverse=false,all=false){await p.evaluate(({reverse,all})=>window.inputFixture.select(reverse,all),{reverse,all});}
async function paste(p,data,options={}){return p.evaluate(({data,options})=>window.inputFixture.paste(data,options),{data,options});}
async function restore(p,f,before,after){await p.evaluate(()=>window.inputFixture.engine.history({type:'undo'}));assert.deepEqual((await state(p,f)).nodes,before.nodes);await p.evaluate(()=>window.inputFixture.engine.history({type:'redo'}));assert.deepEqual((await state(p,f)).nodes,after.nodes);await p.evaluate(()=>window.inputFixture.reopen());assert.deepEqual((await state(p,f)).nodes,after.nodes);}
function expected(block){const a=block.attributes;return{attributes:a.type==='content'?a.tuple:a.type==='heading'?['heading',a.level]:a.type==='code'?['code',a.language]:[a.type],runs:block.runs.filter(r=>r.text.length).map(r=>({text:r.text,attributes:{...Object.fromEntries(r.marks.map(m=>[m.mark,m.mark==='link'?m.href:true])),...r.attributes,...Object.fromEntries((r.opaqueMarks??[]).map(m=>[m.key,m.value]))}}))};}
function inserted(payload){const result=payload.map(expected),empty={attributes:['paragraph'],runs:[]};if(payload[0].attributes.type==='content')result.unshift(empty);if(payload.at(-1).attributes.type==='content')result.push(empty);return result;}
for(const [i,c] of corpus.cases.entries())test(`mixed ${c.id}: actual presenter, structured precedence, one history group and reopen`,()=>probe(c.id,async(p,f)=>{
 const before=await state(p,f);await select(p,i%2===1);assert.equal((await paste(p,offer(c.envelope))).disposition,'committed');const after=await state(p,f);one(before,after);
 const expectedBlocks=inserted(c.envelope.payload);assert.deepEqual(blocks(after).slice(1,-1),expectedBlocks);assert.deepEqual(blocks(after)[0],blocks(before)[0]);assert.deepEqual(blocks(after).at(-1),blocks(before).at(-1));
 if(c.tag){const target=c.kind==='text'?p.locator('#projection').locator(c.tag).filter({hasText:c.envelope.payload[0].runs[0].text}):p.locator('#projection').locator(c.tag).filter({hasText:c.envelope.payload[1].runs[0].text});assert.equal(await target.count(),1);}
 if(c.kind==='image'){assert.equal(await p.locator('[data-content-module=image]').count(),1);assert.equal(await p.locator('img[src]').count(),0);}
 if(c.kind==='file')assert.equal(await p.locator('[data-content-module=attachment]').count(),1);
 if(c.id==='registered-quote')assert.equal(await p.locator('blockquote strong').textContent(),'nested 😀');
 if(c.id==='registered-list')assert.equal(await p.locator('li strong').textContent(),'nested 😀');
 assert.equal(await p.locator('#projection script,#projection iframe').count(),0);assert.deepEqual(f.externalRequests??[],[]);
 await select(p,false,true);const recovered=await p.evaluate(()=>window.inputFixture.roundTrip());f.snapshots.push(recovered);assert.ok(recovered.data[fragment]);assert.deepEqual(semantic(recovered),semantic(after));
 await restore(p,f,before,after);
},config));
for(const e of corpus.fallbacks)test(`mixed fallback ${e.type} v${e.dataVersion}: inert source, complete recovery and no activation`,()=>probe(`fallback-${e.type}-${e.dataVersion}`,async(p,f)=>{
 const before=await state(p,f);await select(p,true);assert.equal((await paste(p,offer(e))).disposition,'committed');const after=await state(p,f);one(before,after);assert.deepEqual(blocks(after).slice(1,-1),[{attributes:['paragraph'],runs:[]},{attributes:['module:editac.inert-extension',1,e],runs:[{text:e.source,attributes:{}}]},{attributes:['paragraph'],runs:[]}]);
 assert.equal(await p.getByRole('textbox',{name:'Unsupported extension source',exact:true}).inputValue(),e.source);assert.match(await p.locator('[data-content-module=extension-source]').getByRole('status').textContent(),/unavailable or unsupported.*complete data preserved/);assert.equal(after.codecCalls,0);
 await select(p,false,true);const recovered=await p.evaluate(()=>window.inputFixture.roundTrip());f.snapshots.push(recovered);assert.deepEqual(semantic(recovered),semantic(after));assert.ok(recovered.exported.diagnostics.length);assert.deepEqual(f.externalRequests??[],[]);assert.equal(await p.locator('#projection script,#projection iframe,#projection math').count(),0);await restore(p,f,before,after);
},config));
for(const kind of ['malformed','inaccessible','undeclared','invalid-schema'])test(`mixed ${kind}: reject authoritative extension offer without HTML/plain flattening`,()=>probe(kind,async(p,f)=>{
 const before=await state(p,f);await select(p,true);const e=structuredClone(corpus.cases[0].envelope);let data=offer(e);
 if(kind==='malformed')data[mime]='{';
 if(kind==='undeclared')e.payload[1].runs[0].marks=[{mark:'superscript'}];
 if(kind==='invalid-schema')e.payload[0].attributes.tuple[2].url='javascript:alert(1)';
 if(kind!=='malformed')data=offer(e);assert.equal((await paste(p,data)).disposition,'rejected');const after=await state(p,f);unchanged(before,after);assert.ok(after.recovery.some(r=>r.mime===mime&&r.raw===data[mime]));
},{...config,...(kind==='inaccessible'?{inaccessible:['editac.image']}:{})}));
test('mixed readonly and literal bypass do not run the codec or rich transformations',()=>probe('readonly-literal',async(p,f)=>{
 const before=await state(p,f);await select(p);await p.evaluate(()=>window.inputFixture.surface.setReadOnly(true));assert.equal((await paste(p,offer(corpus.cases[0].envelope))).disposition,'rejected');unchanged(before,await state(p,f));
 await p.evaluate(()=>window.inputFixture.surface.setReadOnly(false));await select(p);assert.equal((await paste(p,{[mime]:'malformed','text/html':'<b>wrong</b>','text/plain':'# **literal** =SUM(A1) 😀'},{literal:true})).disposition,'committed');const after=await state(p,f);one(before,after);assert.equal(after.codecCalls,0);assert.deepEqual(blocks(after)[1],{attributes:['paragraph'],runs:[{text:'# **literal** =SUM(A1) 😀',attributes:{}}]});await restore(p,f,before,after);
},config));
test('mixed native menu paste and beforeinput pair commit once through actual event owners',()=>probe('native-events',async(p,f)=>{
 const before=await state(p,f);await select(p,true);await p.evaluate(data=>{const f=window.inputFixture,dt={getData:m=>data[m]??''};f.root.dispatchEvent(window.preparedClipboardEvent('paste',dt));const e=new InputEvent('beforeinput',{bubbles:true,cancelable:true,inputType:'insertFromPaste'});Object.defineProperty(e,'dataTransfer',{value:dt});f.root.dispatchEvent(e);f.root.dispatchEvent(new InputEvent('input',{bubbles:true,inputType:'insertFromPaste'}));},offer(corpus.cases[1].envelope));const after=await state(p,f);one(before,after);assert.deepEqual(blocks(after).slice(1,-1),inserted(corpus.cases[1].envelope.payload));
},config));
test('mixed deferred preparation captures clipboard and target despite later navigation',()=>probe('delayed-captured',async(p,f)=>{
 const before=await state(p,f);await select(p,true);await p.evaluate(data=>{window.inputFixture.defer(data);data['application/x-edit-ac-extension+json']='corrupted after capture';},offer(corpus.cases[2].envelope));await select(p,false,true);const result=await p.evaluate(async()=>{window.pendingTransfer.release();return window.pendingTransfer.job.result;});assert.equal(result.disposition,'committed');const after=await state(p,f);one(before,after);assert.deepEqual(blocks(after).slice(1,-1),inserted(corpus.cases[2].envelope.payload));await restore(p,f,before,after);
},config));
test('mixed deferred readonly revocation rejects before codec and mutation',()=>probe('delayed-readonly',async(p,f)=>{
 const before=await state(p,f);await select(p);await p.evaluate(data=>window.inputFixture.defer(data),offer(corpus.cases[0].envelope));await p.evaluate(()=>window.inputFixture.surface.setReadOnly(true));const result=await p.evaluate(async()=>{window.pendingTransfer.release();return window.pendingTransfer.job.result;});assert.equal(result.disposition,'rejected');const after=await state(p,f);unchanged(before,after);assert.equal(after.codecCalls,0);
},config));

// The qualified common-owner return is exercised through the same mounted
// clipboard, Session storage and packed runtime as the existing table matrix.
const returnedConfig={...config,descriptors:corpus.descriptors,math:true};
for(const [i,c] of corpus.returnedCases.entries())test(`returned ${c.id}: admitted runs, actual presenter/copy, one group, typed recovery and reopen`,()=>probe(`returned-${c.id}`,async(p,f)=>{
 const before=await state(p,f);await select(p,i%2===1);
 assert.equal((await paste(p,offer(c.envelope))).disposition,'committed');const after=await state(p,f);one(before,after);
 assert.deepEqual(blocks(after).slice(1,-1),inserted(c.envelope.payload));
 assert.deepEqual(blocks(after)[0],blocks(before)[0]);assert.deepEqual(blocks(after).at(-1),blocks(before).at(-1));
 const selector=c.kind==='file'?'[data-attachment-fallback]':c.kind==='image-asset'?'[data-content-module=image] > p:first-of-type':c.kind==='reference'?'[data-block-style="module:editac.reference"]':null;
 if(c.kind==='file'||c.kind==='image-asset'){
  assert.equal(await p.locator(`${selector} ${c.tag}`).textContent(),c.envelope.payload[0].runs[0].text);
  const copied=await p.evaluate(kind=>{const element=document.querySelector(`[data-content-module=${kind==='file'?'attachment':'image'}]`),data=new DataTransfer();const event=window.preparedClipboardEvent('copy',data);element.dispatchEvent(event);return{prevented:event.defaultPrevented,data:Object.fromEntries([...data.types].map(m=>[m,data.getData(m)]))};},c.kind);
  assert(copied.prevented);const native=JSON.parse(copied.data[fragment]);assert.deepEqual(native.blocks,c.envelope.payload);
  assert.equal(await p.locator('img[src]').count(),0);
 }
 if(c.kind==='reference')assert.equal(await p.locator(`#projection ${c.tag}`).filter({hasText:c.envelope.payload[0].runs[0].text}).count(),1);
 if(c.kind==='math'){
  await p.locator('[data-math-state=rendered]').waitFor();
  assert.equal(await p.locator('[data-module-type="editac.math"]').getAttribute('contenteditable'),'false');
  assert.equal(await p.locator('[data-math-preview] math').count(),1);
  if(c.tag)assert.equal(await p.locator(`${c.tag} [data-module-type="editac.math"]`).count(),1);
 }
 if(c.kind==='document'){
  await p.locator('[data-math-state=rendered]').waitFor();assert.equal(await p.locator('[data-content-module=table]').count(),1);
  await p.getByRole('button',{name:'Select cell row 2 column 1',exact:true}).click();await p.getByRole('button',{name:'Bold cells',exact:true}).click();const formatted=await state(p,f);one(after,formatted);
  const other=s=>blocks(s).filter(b=>b.attributes[0]!=='module:editac.table');assert.deepEqual(other(formatted),other(after));
  const original=after.nodes.find(n=>n.blockAttributes?.[0]==='module:editac.table').blockAttributes,changed=structuredClone(original);changed[2].rows[1][0].paragraphs[0].runs[0][1].push(['bold']);
  assert.deepEqual(formatted.nodes.find(n=>n.blockAttributes?.[0]==='module:editac.table').blockAttributes,changed);
  await p.evaluate(()=>window.inputFixture.engine.history({type:'undo'}));assert.deepEqual((await state(p,f)).nodes,after.nodes);
 }
 if(c.kind==='inert')assert.equal(await p.getByRole('textbox',{name:'Unsupported extension source',exact:true}).inputValue(),c.envelope.source);
 assert.equal(await p.locator('#projection script,#projection iframe').count(),0);assert.deepEqual(f.externalRequests??[],[]);
 await select(p,i%2===0,true);const round=await p.evaluate(()=>window.inputFixture.roundTrip());f.snapshots.push(round);
 assert.deepEqual(semantic(round),semantic(after));assert(round.data[fragment]);assert(round.exported.recovery.length);assert(round.exported.diagnostics.length);
 assert(JSON.parse(round.data[fragment]).blocks.some(b=>b.runs.some(r=>r.opaqueMarks?.length)));
 await restore(p,f,before,after);
},returnedConfig));

const families=corpus.returnedCases.filter(c=>c.id.endsWith('-bold'));
for(const c of families)for(const mode of ['unavailable','inaccessible','readonly','literal','cancel','stale','delayed','revoked','native-events'])test(`returned ${c.kind} ${mode}: captured target and policy, no silent flattening`,()=>probe(`returned-${c.kind}-${mode}`,async(p,f)=>{
 await select(p,true);
 if(mode==='readonly')await p.evaluate(()=>window.inputFixture.surface.setReadOnly(true));
 const before=await state(p,f);
 if(['cancel','stale','delayed','revoked'].includes(mode)){
  await p.evaluate(data=>window.inputFixture.defer(data),offer(c.envelope));
  if(mode==='cancel')await p.evaluate(()=>window.pendingTransfer.job.cancel());
  if(mode==='revoked')await p.evaluate(()=>window.inputFixture.surface.setReadOnly(true));
  if(mode==='stale')await p.evaluate(()=>{const e=window.inputFixture.engine,n=e.read().visible[1];e.commit(e.prepare({kind:'editor',origin:'other',commands:[{type:'wrap',targets:[n.id],style:{type:'quote'}}]}));});
  if(mode==='delayed')await select(p,false,true);
  const stable=await state(p,f);const result=await p.evaluate(async()=>{window.pendingTransfer.release();return window.pendingTransfer.job.result;});const after=await state(p,f);
  if(mode==='delayed'){assert.equal(result.disposition,'committed');one(before,after);assert.deepEqual(blocks(after).slice(1,-1),inserted(c.envelope.payload));await restore(p,f,before,after);}
  else{assert.equal(result.disposition,'rejected');unchanged(stable,after);assert.deepEqual(after.selection,stable.selection);assert.equal(after.focused,stable.focused);}
 }else{
  const data=mode==='literal'?{...offer(c.envelope),'text/plain':c.envelope.source}:offer(c.envelope);
  let result;
  if(mode==='native-events'){
   await p.evaluate(data=>{const f=window.inputFixture,dt={getData:m=>data[m]??''};f.root.dispatchEvent(window.preparedClipboardEvent('paste',dt));const event=new InputEvent('beforeinput',{bubbles:true,cancelable:true,inputType:'insertFromPaste'});Object.defineProperty(event,'dataTransfer',{value:dt});f.root.dispatchEvent(event);f.root.dispatchEvent(new InputEvent('input',{bubbles:true,inputType:'insertFromPaste'}));},data);result=(await state(p,f)).result;
  }else result=await paste(p,data,{literal:mode==='literal'});
  const after=await state(p,f);
  if(mode==='unavailable'){
   assert.equal(result.disposition,'committed');one(before,after);assert.equal(after.codecCalls,0);
   const n=after.nodes.find(n=>n.blockAttributes?.[0]==='module:editac.inert-extension');assert.deepEqual(n.blockAttributes,['module:editac.inert-extension',1,c.envelope]);assert.deepEqual(n.runs,[{text:c.envelope.source,attributes:{}}]);
   await select(p,false,true);assert.deepEqual(semantic(await p.evaluate(()=>window.inputFixture.roundTrip())),semantic(after));await restore(p,f,before,after);
  }else if(mode==='native-events'){assert.equal(result.disposition,'committed');one(before,after);assert.deepEqual(blocks(after).slice(1,-1),inserted(c.envelope.payload));await restore(p,f,before,after);
  }else if(mode==='literal'){
   assert.equal(result.disposition,'committed');one(before,after);assert.equal(after.codecCalls,0);assert.deepEqual(blocks(after)[1],{attributes:['paragraph'],runs:[{text:c.envelope.source,attributes:{}}]});await restore(p,f,before,after);
  }else{assert.equal(result.disposition,'rejected');unchanged(before,after);assert.deepEqual(after.selection,before.selection);assert.equal(after.focused,before.focused);if(mode==='readonly')assert.equal(after.codecCalls,0);}
 }
 assert.deepEqual(f.externalRequests??[],[]);
},{...returnedConfig,...(mode==='unavailable'?{unavailable:[c.envelope.type]}:{}),...(mode==='inaccessible'?{inaccessible:[c.envelope.type]}:{})}));

for(const mode of ['absent-presenter','future-version','wrong-inline-owner','malformed-inline','undeclared-mark'])test(`returned math ${mode}: explicit fallback or atomic rejection`,()=>probe(`returned-math-${mode}`,async(p,f)=>{
 const c=structuredClone(families.find(c=>c.kind==='math'));const before=await state(p,f);await select(p);
 if(mode==='future-version')c.envelope.dataVersion=99;
 if(mode==='wrong-inline-owner')c.envelope.payload[0].runs[0].attributes={'module:vendor.other':[1,{latex:'x'}]};
 if(mode==='malformed-inline')c.envelope.payload[0].runs[0].attributes['module:editac.math']=[1,[]];
 if(mode==='undeclared-mark')c.envelope.payload[0].runs[0].marks=[{mark:'superscript'}];
 const result=await paste(p,offer(c.envelope));const after=await state(p,f);
 if(mode==='absent-presenter'||mode==='future-version'){
  assert.equal(result.disposition,'committed');one(before,after);assert.equal(await p.locator('[data-math-module]').count(),0);
  if(mode==='absent-presenter'){assert.deepEqual(blocks(after).slice(1,-1),inserted(c.envelope.payload));assert.equal(await p.locator('[data-module-fallback=text]').textContent(),c.envelope.source);}
  else assert.deepEqual(after.nodes.find(n=>n.blockAttributes?.[0]==='module:editac.inert-extension').blockAttributes,['module:editac.inert-extension',1,c.envelope]);
  await select(p,false,true);assert.deepEqual(semantic(await p.evaluate(()=>window.inputFixture.roundTrip())),semantic(after));await restore(p,f,before,after);
 }else{assert.equal(result.disposition,'rejected');unchanged(before,after);}
 assert.deepEqual(f.externalRequests??[],[]);
},{...returnedConfig,absentMath:mode==='absent-presenter'}));

// Final host admission is distinct from decoding. Recover the exact rich offer,
// including opaque tuples, rather than only its accompanying plain/HTML flavor.
const recoveryFamilies=[...families,corpus.cases.find(c=>c.id==='registered-paragraph'),corpus.returnedCases.find(c=>c.id==='mixed-document')];
for(const c of recoveryFamilies)test(`recovery ${c.id}: rejected final commit preserves original and retry is atomic`,()=>probe(`recovery-${c.id}`,async(p,f)=>{
 await select(p,true);const before=await state(p,f);
 const data={...offer(c.envelope),'text/x-markdown':'alternate Markdown'};
 const result=await paste(p,data);assert.equal(result.disposition,'rejected');assert.match(result.reason,/fixture-final-commit-rejected/);
 const rejected=await state(p,f);unchanged(before,rejected);assert.deepEqual(rejected.selection,before.selection);assert.equal(rejected.focused,before.focused);
 const original=rejected.recovery.find(r=>r.mime===mime);assert(original,'bounded recovery retains authoritative structured source');assert.equal(original.raw,data[mime]);assert(rejected.recovery.length<=4);
 await p.evaluate(()=>window.inputFixture.rejectCommits(false));
 assert.equal((await paste(p,{[mime]:original.raw})).disposition,'committed');const after=await state(p,f);one(before,after);assert.deepEqual(blocks(after).slice(1,-1),inserted(c.envelope.payload));
 await restore(p,f,before,after);
},{...returnedConfig,rejectCommit:true}));
for(const c of recoveryFamilies)test(`recovery ${c.id}: disposal rejects deferred rich transfer and late completion`,()=>probe(`disposed-${c.id}`,async(p,f)=>{
 await select(p);const before=await state(p,f),data=offer(c.envelope);
 await p.evaluate(data=>window.inputFixture.defer(data),data);
 const captured=await p.evaluate(()=>{const job=window.pendingTransfer.job;window.inputFixture.protocol.clipboard.dispose();return{source:job.source,frozen:Object.isFrozen(job.source)};});
 assert.equal(captured.frozen,true);assert.deepEqual(captured.source,data);
 const result=await p.evaluate(async()=>{window.pendingTransfer.release();return window.pendingTransfer.job.result;});assert.equal(result.disposition,'rejected');
 const after=await state(p,f);unchanged(before,after);assert.deepEqual(after.selection,before.selection);assert.equal(after.focused,before.focused);assert.equal(after.codecCalls,0);
 assert.equal(after.recovery.find(r=>r.mime===mime)?.raw,data[mime]);
 await p.evaluate(()=>window.pendingTransfer.release());unchanged(after,await state(p,f));
},returnedConfig));

// The fallback card owns whole-atom copy; its source textarea owns literal slices.
for(const c of corpus.returnedCases.filter(c=>c.kind==='inert'))test(`returned ${c.id}: fallback card copy preserves exact marks and envelope, source copy stays literal`,()=>probe(`returned-${c.id}-card-copy`,async(p,f)=>{
 const before=await state(p,f);await select(p,true);assert.equal((await paste(p,offer(c.envelope))).disposition,'committed');
 const after=await state(p,f);one(before,after);
 const copied=await p.evaluate(()=>{
  const card=document.querySelector('[data-content-module=extension-source]'),input=card.querySelector('textarea');
  const copy=target=>{const data=new DataTransfer(),event=window.preparedClipboardEvent('copy',data);target.dispatchEvent(event);return{prevented:event.defaultPrevented,data:Object.fromEntries([...data.types].map(m=>[m,data.getData(m)]))};};
  input.focus();input.setSelectionRange(1,5);return{whole:copy(card),slice:copy(input),source:input.value};
 });
 assert.equal(copied.whole.prevented,true);assert.equal(copied.whole.data['text/plain'],copied.source);
 assert.deepEqual(JSON.parse(copied.whole.data[fragment]).blocks,c.envelope.payload);
 assert.equal(copied.slice.prevented,true);assert.deepEqual(copied.slice.data,{'text/plain':copied.source.slice(1,5)});
 unchanged(after,await state(p,f));
 await select(p,true,true);assert.equal((await paste(p,copied.whole.data)).disposition,'committed');const pasted=await state(p,f);one(after,pasted);
 assert.deepEqual(blocks(pasted).filter(b=>b.attributes[0]==='module:editac.inert-extension'),c.envelope.payload.map(expected));
 await restore(p,f,after,pasted);const reopened=await state(p,f);
 const disposed=await p.evaluate(()=>{const card=document.querySelector('[data-content-module=extension-source]');window.inputFixture.disposeSurface();const data=new DataTransfer(),event=window.preparedClipboardEvent('copy',data);card.dispatchEvent(event);return{prevented:event.defaultPrevented,types:[...data.types]};});
 assert.deepEqual(disposed,{prevented:false,types:[]});unchanged(reopened,await state(p,f));
},returnedConfig));

for(const c of families)test(`returned ${c.kind} disposed: late prepared transfer cannot mutate storage or revive presenters`,()=>probe(`returned-${c.kind}-disposed`,async(p,f)=>{
 const before=await state(p,f);await select(p);await p.evaluate(data=>{window.inputFixture.defer(data);window.inputFixture.disposeSurface();},offer(c.envelope));
 const result=await p.evaluate(async()=>{window.pendingTransfer.release();return window.pendingTransfer.job.result;});assert.equal(result.disposition,'rejected');
 const after=await state(p,f);unchanged(before,after);assert.equal(after.codecCalls,0);assert.deepEqual(f.externalRequests??[],[]);
},returnedConfig));

for(const mode of ['unavailable','future-version'])test(`returned fallback ${mode}: whole-card copy retains complete original recovery envelope`,()=>probe(`returned-fallback-${mode}-copy`,async(p,f)=>{
 const c=structuredClone(families.find(c=>c.kind==='math'));if(mode==='future-version')c.envelope.dataVersion=99;
 const before=await state(p,f);await select(p);assert.equal((await paste(p,offer(c.envelope))).disposition,'committed');const after=await state(p,f);one(before,after);
 const data=await p.evaluate(()=>{const card=document.querySelector('[data-content-module=extension-source]'),dt=new DataTransfer();card.dispatchEvent(window.preparedClipboardEvent('copy',dt));return Object.fromEntries([...dt.types].map(m=>[m,dt.getData(m)]));});
 assert.equal(data['text/plain'],c.envelope.source);const native=JSON.parse(data[fragment]);assert.deepEqual(native.blocks[0].attributes,{type:'content',tuple:['module:editac.inert-extension',1,c.envelope]});
 assert.deepEqual(native.blocks[0].runs,[{text:c.envelope.source,marks:[]}]);unchanged(after,await state(p,f));
 await select(p,true,true);assert.equal((await paste(p,data)).disposition,'committed');const copied=await state(p,f);one(after,copied);
 assert.deepEqual(copied.nodes.find(n=>n.blockAttributes?.[0]==='module:editac.inert-extension').blockAttributes,['module:editac.inert-extension',1,c.envelope]);await restore(p,f,after,copied);
},{...returnedConfig,...(mode==='unavailable'?{unavailable:['editac.math']}:{})}));
