import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';
import { browserHarness } from './browser-harness.ts';
import { loadSuite } from '../editing/fixture-loader.ts';
const corpus=loadSuite();
const registration=JSON.parse(await readFile('fixtures/modules/registration.json','utf8'));
const identity=JSON.parse(await readFile('../architecture/evidence/modules-registration/identity.json','utf8'));
const bytes=[...await readFile('../architecture/evidence/modules-registration/custom-checkpoint.bin')];
const marked=registration.runs.map(r=>r.text).join('');
const atomIdentity=JSON.parse(await readFile('fixtures/browser-presenters/atom-only/identity.json','utf8'));
const atomBytes=[...await readFile('fixtures/browser-presenters/atom-only/checkpoint.bin')];
const {probe:rawProbe,facts}=browserHarness('editing-presenters','fixtures/browser-presenters',{autoMount:false,sourcePaths:[
 'fixtures/browser-presenters/session.mjs','fixtures/browser-presenters/index.html','fixtures/browser-presenters/atom-only/identity.json','fixtures/browser-presenters/atom-only/checkpoint.bin','fixtures/modules/registration.json','tests/editing/fixture-loader.ts',
 ...['errors','dom/render','dom/selection','input/text','input/composition','input/keyboard','clipboard/fragment','modules/runtime','modules/registry','modules/conformance','modules/reorder','storage/index','storage/journal'].flatMap(p=>[`packages/web/src/${p}.ts`,`packages/web/dist/${p}.js`]),
 'packages/core/src/extensions/profiles.ts','packages/core/dist/extensions/profiles.js','crates/editac-core/src/commands/editor.rs','crates/editac-core/src/commands/blocks.rs','crates/editac-core/tests/editing_presenters.rs',
 '../architecture/evidence/modules-registration/identity.json','../architecture/evidence/modules-registration/custom-checkpoint.bin'
]});
facts.binding={gate:'RGS-1.7',cases:['REG-09','REG-10','REG-11','REG-17'],guards:['G12','G13'],fixtureHashes:corpus.hashes,remaining:[],provenance:'packed engine, production DOM/storage/input/module adapters; prepared views and notifications; trusted keyboard actions separately recorded; no OS clipboard/native platform claim'};
const probe=(name,action,config='alpha')=>rawProbe(name,async(page,fact)=>{await page.waitForFunction(()=>!!window.inputFixture);await page.evaluate(config=>{Date.now=()=>42000;return window.inputFixture.mount(config);},config);await action(page,fact);});
const custom=(delayed=false)=>({seed:{identity,bytes},definitions:registration.definitions,delayed});
async function observe(page,fact){const s=await page.evaluate(async()=>{const f=window.inputFixture,s=await f.state(),native=getSelection();const nodes=f.engine.read().visible.filter(n=>n.kind==='block');return {...s,text:nodes.map(n=>n.runs.map(r=>r.text).join('')),nodes,views:f.viewState(),vector:[...f.engine.stateVector()],focus:document.activeElement?.getAttribute('aria-label')??document.activeElement?.id,anchor:native?.anchorNode?f.selection.toModel(native.anchorNode,native.anchorOffset):null,focusPoint:native?.focusNode?f.selection.toModel(native.focusNode,native.focusOffset):null,tags:f.ids.map(id=>f.renderer.getBlock(id)?.tagName)};});fact.snapshots.push(s);assert.deepEqual(s.errors,[]);return s;}
function expected(s,e){assert.equal(s.text[0],e.text);assert.equal(s.tags[0],e.tag);assert.equal(s.patches.filter(p=>p.update&&p.origin.startsWith('editac:local:')).length,e.local);assert.equal(s.journal.length,e.local+(e.remote??0));if(e.caret!==undefined)assert.deepEqual([s.anchor?.node,s.anchor?.offset,s.focusPoint?.node,s.focusPoint?.offset],[s.ids[0],e.caret,s.ids[0],e.caret]);if(e.resources!==undefined)assert.equal(s.views.reduce((n,v)=>n+v.resources,0),e.resources);}
function check(s,e,fact){expected(s,e);fact.checkpoints=(fact.checkpoints??0)+1;for(const mutate of [e=>e.text+='?',e=>e.tag=e.tag==='P'?'H6':'P',e=>e.local++,...(e.caret!==undefined?[e=>e.caret++]:[]),...(e.resources!==undefined?[e=>e.resources++]:[])]){const wrong={...e};mutate(wrong);assert.throws(()=>expected(s,wrong),assert.AssertionError);fact.negativeControls=(fact.negativeControls??0)+1;}}
async function select(page,offset=2){await page.evaluate(offset=>window.inputFixture.select(window.inputFixture.ids[0],offset),offset);}
async function sentinel(page,text='Z'){await page.locator('#projection').press(text);}
for(const direction of ['forward','backward'])test('REG-09 selected tag replacement keeps semantic identity and '+direction+' caret mapping',()=>probe('tag-'+direction,async(page,fact)=>{
 await page.evaluate(direction=>window.inputFixture.select(window.inputFixture.ids[0],direction==='forward'?1:4,direction==='forward'?4:1),direction);
 const before=await observe(page,fact);await page.evaluate(()=>{window.oldBlock=window.inputFixture.renderer.getBlock(window.inputFixture.ids[0]);window.inputFixture.tag(2);});
 const heading=await observe(page,fact);assert.equal(heading.ids[0],before.ids[0]);assert.deepEqual(heading.nodes[0].spans,before.nodes[0].spans);assert.deepEqual([heading.anchor.offset,heading.focusPoint.offset],direction==='forward'?[1,4]:[4,1]);assert.equal(await page.evaluate(()=>window.oldBlock.isConnected),false);
 check(heading,{text:'alpha',tag:'H2',local:1},fact);await sentinel(page);check(await observe(page,fact),{text:'aZa',tag:'H2',local:2,caret:2},fact);fact.provenance='trusted WebDriver keyboard sentinel after prepared production format command';
}));
test('REG-09 composing tag change waits for native ownership then commits exactly once',()=>probe('tag-composition',async(page,fact)=>{
 await select(page);await page.evaluate(()=>{const f=window.inputFixture;window.oldBlock=f.renderer.getBlock(f.ids[0]);f.event('compositionstart');f.mutate('al語pha');f.event('compositionupdate',{data:'語'});f.tag(3);});
 assert.equal(await page.evaluate(()=>window.oldBlock===window.inputFixture.renderer.getBlock(window.inputFixture.ids[0])),true);
 await page.evaluate(()=>window.inputFixture.event('compositionend',{data:'語'}));check(await observe(page,fact),{text:'al語pha',tag:'H3',local:2,caret:3},fact);await sentinel(page);check(await observe(page,fact),{text:'al語Zpha',tag:'H3',local:3,caret:4},fact);
}));
for(const delayed of [false,true])test('REG-09 custom '+(delayed?'delayed':'immediate')+' view replacement disposes once and ignores old callbacks',()=>probe('custom-'+delayed,async(page,fact)=>{
 await select(page,2);const initial=await observe(page,fact);check(initial,{text:marked,tag:'H1',local:0,caret:2,resources:2},fact);
 await page.evaluate(()=>window.inputFixture.tag(2));const changed=await observe(page,fact);assert.deepEqual(changed.nodes[0].spans,initial.nodes[0].spans);assert.equal(changed.ids[0],initial.ids[0]);assert.deepEqual(changed.views.slice(0,2).map(v=>[v.dispose,v.resources,v.connected]),[[1,0,false],[1,0,false]]);assert.equal(changed.views.length,4);
 assert.deepEqual(await page.evaluate(()=>window.inputFixture.releaseViews()),[false,false,true,true]);check(await observe(page,fact),{text:marked,tag:'H2',local:1,caret:2,resources:2},fact);
 await sentinel(page);const s=await observe(page,fact);check(s,{text:marked.slice(0,2)+'Z'+marked.slice(2),tag:'H2',local:2,caret:3,resources:2},fact);
 await page.evaluate(()=>{const f=window.inputFixture;f.protocol.dispose();f.selection.dispose();f.renderer.dispose();f.renderer.dispose();});const disposed=await page.evaluate(()=>window.inputFixture.viewState());assert.ok(disposed.every(v=>v.dispose===1&&v.resources===0));assert.ok((await page.evaluate(()=>window.inputFixture.releaseViews())).every(v=>v===false));fact.teardown={views:disposed.length,resources:0,disposeExactlyOnce:true};
},custom(delayed)));
for(const remote of [false,true])test('REG-10 nested control owns paste/type/cut and secondary insertion '+(remote?'with remote rebasing':'base'),()=>probe('nested-'+remote,async(page,fact)=>{
 await select(page,2);await page.evaluate(()=>{window.outerTarget=window.inputFixture.retain();});const before=await observe(page,fact);
 const input=page.getByRole('textbox',{name:'Nested presenter 0'});await input.focus();await input.press('End');await input.press('x');
 await page.evaluate(()=>{const input=document.querySelector('input[aria-label="Nested presenter 0"]'),d=new DataTransfer();d.setData('text/plain','PASTE');input.dispatchEvent(window.preparedClipboardEvent('paste',d));input.value+='PASTE';input.dispatchEvent(new InputEvent('input',{bubbles:true,inputType:'insertFromPaste',data:'PASTE'}));input.dispatchEvent(new InputEvent('beforeinput',{bubbles:true,cancelable:true,inputType:'insertText',data:'SECONDARY'}));const cut=new DataTransfer();input.dispatchEvent(window.preparedClipboardEvent('cut',cut));input.value=input.value.slice(0,-5);input.dispatchEvent(new InputEvent('input',{bubbles:true,inputType:'deleteByCut'}));});
 const inner=await observe(page,fact);assert.equal(inner.views[0].value,'innerx');assert.equal(inner.focus,'Nested presenter 0');assert.deepEqual(inner.nodes,before.nodes);assert.deepEqual(inner.vector,before.vector);assert.deepEqual(inner.history,before.history);check(inner,{text:marked,tag:'H1',local:0,resources:2},fact);
 if(remote)await page.evaluate(()=>window.inputFixture.remote(0,'!'));
 await page.evaluate(()=>{const f=window.inputFixture;f.restore(window.outerTarget);window.outerTarget.dispose();});await sentinel(page);check(await observe(page,fact),{text:(remote?'!':'')+marked.slice(0,2)+'Z'+marked.slice(2),tag:'H1',local:1,remote:remote?1:0,caret:remote?4:3,resources:2},fact);fact.provenance='trusted native input typing and outer sentinel; prepared paste/cut/secondary notifications, explicit retained production anchor; prepared peer when named';
},custom()));

for(const reverse of [false,true])test('prepared official profile precedence and conflict admission '+(reverse?'reversed':'forward'),()=>probe('profile-'+reverse,async(page,fact)=>{
 const before=await observe(page,fact);
 const result=await page.evaluate(async reverse=>{
  const {prepareExtensionProfile,FIRST_PARTY_FEATURES,FIRST_PARTY_PROFILES}=await import('@edit-ac/core/extensions');
  const {ExtensionCommandSession}=await import('/web/modules/conformance.js');
  const catalog=structuredClone(FIRST_PARTY_FEATURES),profile=structuredClone(FIRST_PARTY_PROFILES['document-tools']);
  const environment={schema:'editac.registry.editor.v5',capabilities:['commands','host-resolver','source-fallback'],allowContractFixtures:true};
  for(const f of catalog)if(['editac.slash','editac.reorder'].includes(f.id))f.bindings.push({kind:'keymap',key:'F2',command:f.id,priority:f.id==='editac.slash'?300:100});
  if(reverse){catalog.reverse();profile.features.reverse();}
  const prepared=prepareExtensionProfile(profile,catalog,environment),winner=prepared.bindings.find(b=>b.kind==='keymap'&&b.key==='F2');
  const f=window.inputFixture,vector=[...f.engine.stateVector()];
  const tied=structuredClone(catalog);for(const feature of tied)for(const b of feature.bindings)if(b.key==='F2')b.priority=300;
  let conflict;try{prepareExtensionProfile(profile,tied,environment);}catch(error){conflict=error.code;}
  const remapped=prepareExtensionProfile(profile,tied,{...environment,remap:{'keymap:F2':'editac.reorder'}});
  const commands=new ExtensionCommandSession({active:true,revision:()=>String(f.engine.read().revision),can:r=>f.engine.can(r),commit:r=>f.commit(r)});
  let pending;const listener=event=>{if(event.key!=='F2'||event.defaultPrevented)return;event.preventDefault();pending=commands.run(()=>({kind:'editor',origin:'prepared-profile:'+winner.feature,commands:[{type:'replaceAt',owner:f.ids[0],from:2,to:2,text:winner.feature==='editac.slash'?'S':'R'},{type:'selectionAt',anchor:{owner:f.ids[0],offset:3,bias:'right'},focus:{owner:f.ids[0],offset:3,bias:'right'}}]}));};
  f.root.addEventListener('keydown',listener,true);
  try{const event=new KeyboardEvent('keydown',{bubbles:true,cancelable:true,key:'F2'});f.root.dispatchEvent(event);const command=await pending;if(command?.status==='committed'){const selection=command.result.selection;if(selection){f.selection.place({...f.engine.resolve(selection.anchor),bias:selection.anchorBias},{...f.engine.resolve(selection.focus),bias:selection.focusBias});f.selection.capture();f.engine.releaseAnchor(selection.anchor);f.engine.releaseAnchor(selection.focus);}if(command.result.caret)f.engine.releaseAnchor(command.result.caret);}return {winner,conflict,remapped:remapped.bindings.find(b=>b.kind==='keymap'&&b.key==='F2'),beforeVector:vector,command:command?.status,prevented:event.defaultPrevented};}
  finally{f.root.removeEventListener('keydown',listener,true);commands.dispose();}
 },reverse);
 assert.deepEqual(result.winner,{kind:'keymap',key:'F2',command:'editac.slash',feature:'editac.slash'});assert.equal(result.conflict,'binding-conflict');assert.equal(result.remapped.feature,'editac.reorder');assert.equal(result.command,'committed');assert.equal(result.prevented,true);assert.deepEqual(result.beforeVector,before.vector);
 check(await observe(page,fact),{text:'alSpha',tag:'P',local:1,caret:3},fact);fact.provenance='prepared official profile contract and host event binding through production ExtensionCommandSession/engine/storage; not actual FPX activation qualification';
}));

test('REG-11 external drop is owned once by actual input/clipboard adapter',()=>probe('external-drop-required',async(page,fact)=>{
 await select(page,2);const before=await observe(page,fact);
 const prevented=await page.evaluate(()=>{const f=window.inputFixture,data=new DataTransfer();data.setData('text/plain','DROP');const event=new DragEvent('drop',{bubbles:true,cancelable:true,dataTransfer:data});f.renderer.getBlock(f.ids[0]).dispatchEvent(event);return event.defaultPrevented;});
 const after=await observe(page,fact);fact.required={ownedDrop:true,text:'alDROPpha',localCommits:1,journal:1};fact.observed={prevented,text:after.text,localCommits:after.patches.filter(p=>p.update&&p.origin.startsWith('editac:local:')).length,journal:after.journal.length};
 assert.equal(prevented,true,'REG-11 requires actual drop ownership before native mutation');check(after,{text:'alDROPpha',tag:'P',local:1,caret:6},fact);
 await page.evaluate(()=>{const f=window.inputFixture;f.event('beforeinput',{inputType:'insertFromDrop',data:'DROP',cancelable:true});f.event('input',{inputType:'insertFromDrop',data:'DROP'});});check(await observe(page,fact),{text:'alDROPpha',tag:'P',local:1,caret:6},fact);assert.equal(before.journal.length,0);
}));

test('REG-17 explicit atom node selection deletes only the selected atom',()=>probe('atom-node-delete-required',async(page,fact)=>{
 const before=await observe(page,fact);const atom=await page.evaluate(()=>window.inputFixture.selectAtom());assert.ok(before.nodes.some(n=>n.id===atom.id));
 await page.locator('#projection').press('Delete');const after=await observe(page,fact);fact.required={selectedAtomRemoved:true,adjacentText:['alpha','independent'],localCommits:1};fact.observed={selectedAtomPresent:after.nodes.some(n=>n.id===atom.id),text:after.text,localCommits:after.patches.filter(p=>p.update&&p.origin.startsWith('editac:local:')).length};
 assert.equal(after.nodes.some(n=>n.id===atom.id),false,'REG-17 explicit node action must remove the atom');assert.deepEqual(after.text,['alpha','independent']);assert.deepEqual(after.nodes.map(n=>n.id),before.nodes.filter(n=>n.id!==atom.id).map(n=>n.id));assert.equal(after.journal.length,1);
}, {separator:true}));

test('REG-17 deleting the final atom creates a native caret for the next sentinel',()=>probe('atom-only-delete',async(page,fact)=>{
 const before=await observe(page,fact);const atom=await page.evaluate(()=>window.inputFixture.selectAtom());await page.locator('#projection').press('Delete');
 const after=await observe(page,fact);assert.equal(after.nodes.length,1);assert.notEqual(after.nodes[0].id,atom.id);assert.deepEqual(after.text,['']);assert.equal(after.journal.length,1);assert.deepEqual([after.anchor.node,after.anchor.offset,after.focusPoint.node,after.focusPoint.offset],[after.nodes[0].id,0,after.nodes[0].id,0]);assert.equal(before.nodes.length,1);
 await sentinel(page);const typed=await observe(page,fact);assert.deepEqual(typed.text,['Z']);assert.equal(typed.journal.length,2);assert.deepEqual([typed.anchor.node,typed.anchor.offset],[after.nodes[0].id,1]);
 fact.provenance='trusted node deletion and sentinel through production adapter with native prepared paragraph/caret result';
}, {separatorOnly:true,seed:{identity:atomIdentity,bytes:atomBytes}}));

for(const side of ['before','after'])test('REG-17 '+side+' atom insertion creates adjacent text and keeps the atom',()=>probe('atom-insert-'+side,async(page,fact)=>{
 const before=await observe(page,fact),atom=before.nodes.find(n=>n.blockAttributes?.[0]==='separator');
 await page.evaluate(side=>window.inputFixture.insertBeside(side),side);let after=await observe(page,fact);const added=after.nodes.find(n=>!before.nodes.some(b=>b.id===n.id));assert.ok(added);assert.equal(added.runs.map(r=>r.text).join(''),'X');assert.equal(after.nodes.findIndex(n=>n.id===added.id)-after.nodes.findIndex(n=>n.id===atom.id),side==='before'?-1:1);assert.deepEqual({...after.nodes.find(n=>n.id===atom.id),order:atom.order,editor:atom.editor},atom);assert.equal(after.nodes.find(n=>n.id===atom.id).editor.enabled,atom.editor.enabled);assert.deepEqual([after.anchor.node,after.anchor.offset,after.focusPoint.node,after.focusPoint.offset],[added.id,1,added.id,1]);
 await sentinel(page);after=await observe(page,fact);assert.equal(after.nodes.find(n=>n.id===added.id).runs.map(r=>r.text).join(''),'XZ');await page.locator('#projection').press('Backspace');after=await observe(page,fact);assert.equal(after.nodes.find(n=>n.id===added.id).runs.map(r=>r.text).join(''),'X');
 await page.evaluate(id=>window.inputFixture.select(id,0,1),added.id);await page.locator('#projection').press('ControlOrMeta+b');after=await observe(page,fact);assert.deepEqual(after.nodes.find(n=>n.id===added.id).runs,[{text:'X',attributes:{bold:true}}]);assert.deepEqual({...after.nodes.find(n=>n.id===atom.id),order:atom.order,editor:atom.editor},atom);assert.equal(after.nodes.find(n=>n.id===atom.id).editor.enabled,atom.editor.enabled);assert.deepEqual(after.nodes.filter(n=>n.id!==added.id).map(n=>({...n,order:before.nodes.find(b=>b.id===n.id).order,editor:before.nodes.find(b=>b.id===n.id).editor})),before.nodes);assert.equal(after.journal.length,4);fact.provenance='prepared production insertParagraph followed by trusted typing/deletion/formatting and mapped caret';
}, {separator:true}));
test('REG-17 explicit atom rejects textual typing and formatting without neighbor overwrite',()=>probe('atom-text-rejection',async(page,fact)=>{
 const before=await observe(page,fact);await page.evaluate(()=>window.inputFixture.selectAtom());await sentinel(page);await page.locator('#projection').press('ControlOrMeta+b');const after=await observe(page,fact);assert.deepEqual(after.nodes,before.nodes);assert.deepEqual(after.vector,before.vector);assert.deepEqual(after.history,before.history);assert.equal(after.journal.length,0);assert.equal(after.patches.filter(p=>p.update).length,0);
}, {separator:true}));
for(const mode of ['move','copy'])test('REG-11 internal '+mode+' through nested duplicate listeners commits once',()=>probe('internal-drop-'+mode,async(page,fact)=>{
 await page.evaluate(mode=>{const f=window.inputFixture;f.select(f.ids[mode==='move'?1:0],2);},mode);const before=await observe(page,fact);
 const outcome=await page.evaluate(mode=>{const f=window.inputFixture,source=f.renderer.getBlock(f.ids[mode==='move'?1:0]),destination=f.renderer.getBlock(f.ids[mode==='move'?0:1]),data=new DataTransfer();source.draggable=true;source.dispatchEvent(new DragEvent('dragstart',{bubbles:true,cancelable:true,dataTransfer:data}));const token=data.getData('application/x-editac-block'),drop=new DragEvent('drop',{bubbles:true,cancelable:true,dataTransfer:data,ctrlKey:mode==='copy'});const nested=document.createElement('span');destination.append(nested);nested.dispatchEvent(drop);destination.dispatchEvent(drop);f.root.dispatchEvent(drop);nested.remove();return {token,prevented:drop.defaultPrevented};},mode);
 assert.ok(outcome.token);assert.equal(outcome.prevented,true);const after=await observe(page,fact);
 if(mode==='move'){assert.deepEqual(after.nodes.map(n=>n.id),[before.ids[1],before.ids[0]]);assert.deepEqual(after.text,['independent','alpha']);for(const n of before.nodes){assert.deepEqual(after.nodes.find(a=>a.id===n.id).spans,n.spans);assert.deepEqual(after.nodes.find(a=>a.id===n.id).runs,n.runs);}assert.deepEqual([after.anchor.node,after.anchor.offset],[before.ids[1],2]);}
 else {assert.deepEqual(after.text,['alpha','alphaindependent']);assert.deepEqual(after.nodes[0],before.nodes[0]);}
 assert.equal(after.journal.length,1);assert.equal(after.patches.filter(p=>p.update&&p.origin.startsWith('editac:local:')).length,1);
 await page.evaluate(()=>{const f=window.inputFixture;f.event('beforeinput',{inputType:'insertFromDrop',data:'alpha',cancelable:true});f.event('input',{inputType:'insertFromDrop',data:'alpha'});});const echo=await observe(page,fact);assert.deepEqual(echo.nodes,after.nodes);assert.equal(echo.journal.length,1);fact.provenance='prepared internal DataTransfer/duplicate nested drops through production optional reorder/clipboard; no native gesture or rich block-copy claim';
}, {reorder:true}));
for(const mode of ['canceled','readonly','invalid'])test('REG-11 '+mode+' drop has zero semantic effects',()=>probe('drop-rejected-'+mode,async(page,fact)=>{
 await select(page,2);const before=await observe(page,fact);await page.evaluate(mode=>{const f=window.inputFixture,data=new DataTransfer();data.setData('text/plain','DROP');if(mode==='readonly')f.protocol.setReadOnly(true);const event=new DragEvent('drop',{bubbles:true,cancelable:true,dataTransfer:mode==='invalid'?null:data});if(mode==='canceled')event.preventDefault();f.renderer.getBlock(f.ids[0]).dispatchEvent(event);},mode);const after=await observe(page,fact);assert.deepEqual(after.nodes,before.nodes);assert.deepEqual(after.vector,before.vector);assert.deepEqual(after.history,before.history);assert.equal(after.journal.length,0);
}));

test('REG-11 noncancelable drop native mutation is rejected and repaired without a commit',()=>probe('drop-noncancelable',async(page,fact)=>{
 await select(page,2);const before=await observe(page,fact);await page.evaluate(async()=>{const f=window.inputFixture,data=new DataTransfer();data.setData('text/plain','DROP');f.renderer.getBlock(f.ids[0]).dispatchEvent(new DragEvent('drop',{bubbles:true,cancelable:false,dataTransfer:data}));f.mutate('alDROPpha');await Promise.resolve();f.event('input',{inputType:'insertFromDrop',data:'DROP'});});const after=await observe(page,fact);assert.deepEqual(after.nodes,before.nodes);assert.deepEqual(after.vector,before.vector);assert.deepEqual(after.dom,before.dom);assert.equal(after.journal.length,0);
}));
test('REG-11 unrelated real peer text rebases retained move selection',()=>probe('drop-remote',async(page,fact)=>{
 await page.evaluate(()=>{const f=window.inputFixture;f.select(f.ids[1],2);window.dragData=new DataTransfer();f.renderer.getBlock(f.ids[1]).dispatchEvent(new DragEvent('dragstart',{bubbles:true,cancelable:true,dataTransfer:window.dragData}));});const before=await observe(page,fact);await page.evaluate(()=>window.inputFixture.remote(0,'!',window.inputFixture.ids[1]));await page.evaluate(()=>{const f=window.inputFixture;f.renderer.getBlock(f.ids[0]).dispatchEvent(new DragEvent('drop',{bubbles:true,cancelable:true,dataTransfer:window.dragData}));});const moved=await observe(page,fact);assert.deepEqual(moved.text,['!independent','alpha']);assert.deepEqual(moved.nodes.map(n=>n.id),[before.ids[1],before.ids[0]]);assert.deepEqual([moved.anchor.node,moved.anchor.offset],[before.ids[1],3]);assert.equal(moved.journal.length,2);assert.equal(moved.patches.filter(p=>p.update&&p.origin.startsWith('editac:local:')).length,1);await sentinel(page);const after=await observe(page,fact);assert.deepEqual(after.text,['!inZdependent','alpha']);assert.equal(after.journal.length,3);
}, {reorder:true}));
test('G12 ordinary embedded controls never become reorder sources',()=>probe('unowned-drag',async(page,fact)=>{
 await select(page,2);const before=await observe(page,fact);
 const offers=await page.evaluate(()=>{const f=window.inputFixture,grip=f.root.querySelector('[data-editac-reorder-handle]'),input=f.root.querySelector('input');const offers=[];
  for(const mode of ['no-opt-in','not-draggable','inner-input']){const target=mode==='inner-input'?input:grip;target.draggable=mode!=='not-draggable';if(mode==='no-opt-in')target.removeAttribute('data-editac-reorder-handle');else target.setAttribute('data-editac-reorder-handle','');const data=new DataTransfer();target.dispatchEvent(new DragEvent('dragstart',{bubbles:true,cancelable:true,dataTransfer:data}));offers.push(data.getData('application/x-editac-block'));target.dispatchEvent(new DragEvent('dragend',{bubbles:true,dataTransfer:data}));}return offers;});
 assert.deepEqual(offers,['','','']);const after=await observe(page,fact);assert.deepEqual(after.nodes,before.nodes);assert.deepEqual(after.vector,before.vector);assert.equal(after.journal.length,0);check(after,{text:marked,tag:'H1',local:0,caret:2,resources:2},fact);
 await sentinel(page);check(await observe(page,fact),{text:marked.slice(0,2)+'Z'+marked.slice(2),tag:'H1',local:1,caret:3,resources:2},fact);
 fact.provenance='prepared drag notifications in real registered custom-view controls, followed by trusted outer sentinel';
}, {...custom(),reorder:true}));
test('REG-11 trusted WebDriver drag uses production block move transport',()=>probe('trusted-drag',async(page,fact)=>{
 await page.evaluate(()=>{const f=window.inputFixture;f.select(f.ids[0],2);window.dropObservations=[];for(const type of ['pointerdown','dragstart','dragover','drop','dragend'])f.root.addEventListener(type,event=>{if(window.dropObservations.length<16)window.dropObservations.push({type,trusted:event.isTrusted,prevented:event.defaultPrevented,target:event.target.nodeName,types:[...(event.dataTransfer?.types??[])],effect:event.dataTransfer?.dropEffect,allowed:event.dataTransfer?.effectAllowed,active:document.activeElement?.nodeName});},true);});
 const before=await observe(page,fact);
 // Browsers may dispatch dragover only after a second pointer movement at
 // the destination. Drive that real sequence explicitly, without injecting
 // DragEvents or replacing the browser's DataTransfer.
 const source=await page.locator('[data-node-id="'+before.ids[0]+'"] [data-editac-reorder-handle]').first().boundingBox();
 const destination=await page.locator('[data-node-id="'+before.ids[2]+'"]').boundingBox();
 assert.ok(source&&destination,'mapped source and destination geometry required');
 await page.mouse.move(source.x+source.width/2,source.y+source.height/2);await page.mouse.down();
 await page.mouse.move(destination.x+destination.width/2,destination.y+destination.height/2,{steps:5});
 await page.mouse.move(destination.x+destination.width/2+1,destination.y+destination.height/2,{steps:2});await page.mouse.up();
 const after=await observe(page,fact);fact.nativeDrag=await page.evaluate(()=>window.dropObservations);
 assert.ok(fact.nativeDrag.some(e=>e.type==='dragstart'&&e.trusted),'trusted dragstart required');assert.ok(fact.nativeDrag.some(e=>e.type==='drop'&&e.trusted),'trusted drop required');
 assert.deepEqual(after.text,['cאבd',marked,'éZ','']);assert.deepEqual(after.nodes.map(n=>n.id),[before.ids[1],before.ids[0],before.ids[2],before.ids[3]]);assert.equal(after.journal.length,1);
 assert.deepEqual([after.anchor.node,after.anchor.offset,after.focusPoint.node,after.focusPoint.offset],[before.ids[0],2,before.ids[0],2]);
 await sentinel(page);const typed=await observe(page,fact);assert.deepEqual(typed.text,['cאבd',marked.slice(0,2)+'Z'+marked.slice(2),'éZ','']);assert.equal(typed.journal.length,2);assert.deepEqual([typed.anchor.node,typed.anchor.offset,typed.focusPoint.node,typed.focusPoint.offset],[before.ids[0],3,before.ids[0],3]);
 fact.provenance='trusted Playwright pointer/HTML drag from a real custom-view grip in the recorded browser on macOS host; no physical pointing-device or cross-OS qualification';
}, {...custom(),reorder:true}));
