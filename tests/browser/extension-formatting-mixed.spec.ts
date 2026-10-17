import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {test} from 'node:test';
import {browserHarness} from './browser-harness.ts';
const corpus=JSON.parse(await readFile('fixtures/rich-presenters/formatting/mixed-extensions.json','utf8'));
const mime='application/x-edit-ac-extension+json',fragment='application/x-edit-ac-fragment+json';
const {probe}=browserHarness('extension-formatting-mixed','fixtures/browser-extension-formatting',{markdown:true,assertSourcesUnchanged:true,testFile:'tests/browser/extension-formatting-mixed.spec.ts',sourcePaths:[
 'packages/web/src/modules/transfer.ts','packages/web/src/modules/index.ts','packages/web/src/modules/content.ts','packages/web/src/dom/render.ts','packages/web/src/clipboard/fragment.ts','packages/core/src/extensions/transfer.ts',
 'fixtures/browser-extension-formatting/session.mjs','fixtures/browser-extension-formatting/index.html','fixtures/rich-presenters/formatting/mixed-extensions.json',
],beforeNavigate:async(p,f)=>{await p.route('https://**/*',route=>{f.externalRequests??=[];f.externalRequests.push(route.request().url());return route.abort();});}});
const config={descriptors:corpus.descriptors,unavailable:corpus.unavailable};
async function state(p,f){const s=await p.evaluate(()=>window.inputFixture.state());f.snapshots.push(s);assert.deepEqual(s.errors,[]);return s;}
const blocks=s=>s.nodes.filter(n=>n.kind==='block').map(n=>({attributes:n.blockAttributes,runs:n.runs}));
const semantic=s=>s.nodes.map(n=>({kind:n.kind,attributes:n.blockAttributes,runs:n.runs,container:n.editor?.containerAttributes,checked:n.editor?.checked}));
function unchanged(a,b){assert.deepEqual(b.nodes,a.nodes);assert.deepEqual(b.history,a.history);assert.deepEqual(b.journal,a.journal);assert.equal(b.commands.length,a.commands.length);}
function one(a,b){assert.equal(b.history.undoGroups,a.history.undoGroups+1);assert.equal(b.journal.length,a.journal.length+1);assert.equal(b.commands.length,a.commands.length+1);assert.equal(b.patches.length,a.patches.length+1);}
const offer=e=>({[mime]:JSON.stringify(e),'text/html':'<h1>wrong HTML</h1>','text/markdown':'# wrong Markdown','text/plain':'wrong plain'});
async function select(p,reverse=false,all=false){await p.evaluate(({reverse,all})=>window.inputFixture.select(reverse,all),{reverse,all});}
async function paste(p,data,options={}){return p.evaluate(({data,options})=>window.inputFixture.paste(data,options),{data,options});}
async function restore(p,f,before,after){await p.evaluate(()=>window.inputFixture.engine.history({type:'undo'}));assert.deepEqual((await state(p,f)).nodes,before.nodes);await p.evaluate(()=>window.inputFixture.engine.history({type:'redo'}));assert.deepEqual((await state(p,f)).nodes,after.nodes);await p.evaluate(()=>window.inputFixture.reopen());assert.deepEqual((await state(p,f)).nodes,after.nodes);}
function expected(block){const a=block.attributes;return{attributes:a.type==='content'?a.tuple:a.type==='heading'?['heading',a.level]:a.type==='code'?['code',a.language]:[a.type],runs:block.runs.filter(r=>r.text.length).map(r=>({text:r.text,attributes:Object.fromEntries(r.marks.map(m=>[m.mark,m.mark==='link'?m.href:true]))}))};}
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
