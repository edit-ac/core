import assert from 'node:assert/strict';
import { test } from 'node:test';
import { browserHarness } from './browser-harness.ts';
import { loadSuite } from '../editing/fixture-loader.ts';
import { assertCheckpoint } from '../editing/driver.ts';
import { BrowserLifetimeDriver } from '../editing/browser-lifetime-driver.ts';
const corpus=loadSuite(), recipe=corpus.recipes.find(r=>r.id==='SEQ-09');
const {probe:rawProbe,facts}=browserHarness('editing-lifetime','fixtures/browser-input',{autoMount:false,sourcePaths:[
  'fixtures/browser-input/session.mjs','fixtures/browser-input/index.html','tests/editing/browser-lifetime-driver.ts','tests/editing/browser-driver.ts','tests/editing/fixture-loader.ts','tests/editing/driver.ts',
  ...['clipboard/fragment','clipboard/pending','input/text','dom/render','dom/selection','storage/index','storage/journal','storage/writer','entry'].flatMap(p=>[`packages/web/src/${p}.ts`,`packages/web/dist/${p}.js`]),
]});
const probe=(name,action,text='alpha')=>rawProbe(name,async(page,fact)=>{await page.evaluate(()=>{Date.now=()=>42000;});if(name!=='SEQ-09')await page.evaluate(text=>window.inputFixture.mount(text),text);await action(page,fact);},text);
facts.binding={gate:'RGS-1.6',recipes:['SEQ-09'],cases:['REG-12','REG-15'],guards:['G08','G11'],fixtureHashes:corpus.hashes,clock:'Date.now fixed at 42000',scheduler:'bounded production settle/flush, explicit provider resolve and microtask drain',provenance:'real-browser packed production adapters/storage; prepared provider and remote update; no OS clipboard/device claim'};
async function observe(page,fact){const s=await page.evaluate(async()=>{const f=window.inputFixture;const s=await f.state(),selection=getSelection();return {...s,vector:[...f.engine.stateVector()],checkpoint:[...f.engine.checkpoint().bytes],anchor:selection?.anchorNode?f.selection.toModel(selection.anchorNode,selection.anchorOffset):null,focus:selection?.focusNode?f.selection.toModel(selection.focusNode,selection.focusOffset):null};});fact.snapshots.push(s);return s;}
function expected(s,e){assert.deepEqual(s.text,e.text);assert.deepEqual(s.dom,e.text);assert.equal(s.patches.filter(p=>p.update&&p.origin.startsWith('editac:local:')).length,e.local);assert.equal(s.patches.filter(p=>p.update&&!p.origin.startsWith('editac:local:')).length,e.remote??0);assert.equal(s.journal.length,e.local+(e.remote??0));assert.equal(s.history.undoGroups,e.local);assert.deepEqual(s.errors,e.errors??[]);if(e.caret){assert.deepEqual([s.anchor?.node,s.anchor?.offset,s.focus?.node,s.focus?.offset],[s.ids[e.caret[0]],e.caret[1],s.ids[e.caret[0]],e.caret[1]]);} }
function checkpoint(s,e,fact){expected(s,e);fact.checkpoints=(fact.checkpoints??0)+1;for(const corrupt of [x=>x.text[0]+='?',x=>x.local++,x=>x.remote=(x.remote??0)+1,...(e.caret?[x=>x.caret[1]++]:[])]){const wrong=structuredClone(e);corrupt(wrong);assert.throws(()=>expected(s,wrong),assert.AssertionError);fact.negativeControls=(fact.negativeControls??0)+1;}}
async function begin(page,text='X'){await page.evaluate(text=>{Date.now=()=>42000;const f=window.inputFixture;window.retainedTarget=f.selection.retain();window.pendingRead=f.protocol.clipboard.pastePlainText(()=>new Promise(resolve=>window.finishRead=resolve),window.retainedTarget);},text);await page.waitForFunction(()=>typeof window.finishRead==='function');}
async function finish(page,text='X'){await page.evaluate(text=>window.finishRead(text),text);return page.evaluate(()=>window.pendingRead);}
test('SEQ-09 real clipboard retained anchor rejects deleted target without current-caret fallback',()=>probe('SEQ-09',async(page,fact)=>{
  const d=new BrowserLifetimeDriver(page),results=await d.replay(recipe);fact.snapshots.push(...results);fact.recipeCheckpoints=results.length;
  for(const [i,result] of results.entries()) for(const corrupt of [e=>e.state.blocks[0].text+='?',e=>e.state.selection.focus.offset++,e=>e.effects.localCommits++,e=>e.state.blocks[0].id='wrong-owner']) {
    const wrong=structuredClone(recipe.steps[i].expect);corrupt(wrong);assert.throws(()=>assertCheckpoint(result.result,wrong),assert.AssertionError);fact.negativeControls=(fact.negativeControls??0)+1;
  }
  assert.equal(results.length,recipe.steps.length);assert.equal(d.requests.size,0);
  const s=await observe(page,fact);checkpoint(s,{text:recipe.steps.at(-1).expect.state.blocks.map(b=>b.text),local:0,remote:1,caret:[1,0]},fact);
  await assert.rejects(d.step({type:'unknown'},recipe.steps[0].expect),/Unsupported lifetime action/);
  await assert.rejects(d.mount({...recipe,requires:['unsupported-native-profile']}),/Unsupported lifetime capability/);
}));

test('G11 retained paste follows remote anchor rebase and preserves later navigation',()=>probe('rebase',async(page,fact)=>{await page.evaluate(()=>window.inputFixture.select(window.inputFixture.ids[0],2));await begin(page);await page.evaluate(async()=>{const f=window.inputFixture;await f.remote(0,'!');f.select(f.ids[1],2);});assert.equal((await finish(page)).disposition,'committed');checkpoint(await observe(page,fact),{text:['!alXpha','independent'],local:1,remote:1,caret:[1,2]},fact);}));
for(const mode of ['cancel','readonly'])test('G11 '+mode+' cancels pending provider before late completion',()=>probe(mode,async(page,fact)=>{await begin(page);const before=await observe(page,fact);await page.evaluate(mode=>{const f=window.inputFixture;if(mode==='cancel')f.protocol.clipboard.cancel();else f.protocol.setReadOnly(true);},mode);assert.equal((await page.evaluate(()=>window.pendingRead)).disposition,'rejected');await finish(page,'lost');const s=await observe(page,fact);checkpoint(s,{text:['alpha','independent'],local:0,caret:[0,5]},fact);assert.deepEqual(s.vector,before.vector);assert.deepEqual(s.checkpoint,before.checkpoint);assert.equal(await page.locator('body > [role=status]:not(#status)').count(),0);}));

test('REG-12 subscriber exception preserves real commit DOM journal and next edit',()=>probe('subscriber-throw',async(page,fact)=>{await page.evaluate(()=>{const f=window.inputFixture;window.throwing=f.engine.subscribe({type:'updates'},()=>{f.engine.read();f.engine.checkpoint();throw Error('intentional observer failure');});f.event('beforeinput',{inputType:'insertText',data:'X',cancelable:true});});const s=await observe(page,fact);checkpoint(s,{text:['alphaX','independent'],local:1,caret:[0,6],errors:[{subscriptionId:s.errors[0]?.subscriptionId,message:'intentional observer failure'}]},fact);assert.equal(s.errors.length,1);await page.evaluate(()=>{window.throwing.dispose();window.inputFixture.event('beforeinput',{inputType:'insertText',data:'Y',cancelable:true});});checkpoint(await observe(page,fact),{text:['alphaXY','independent'],local:2,caret:[0,7]},fact);}));

for(const mode of ['disposed-adapters','new-session'])test('REG-15 '+mode+' invalidates queued observer renderer and provider ownership',()=>probe(mode,async(page,fact)=>{
  await begin(page);const result=await page.evaluate(async mode=>{const f=window.inputFixture;const root=f.root,oldBlock=f.renderer.getBlock(f.ids[0]),oldEngine=f.engine,oldProtocol=f.protocol,oldSelection=f.selection,oldRenderer=f.renderer;
    // Native work is queued but has not been observed/committed yet.
    f.mutate('alphaQUEUED');oldProtocol.dispose();oldSelection.dispose();oldRenderer.dispose();
    const baseline=oldBlock.textContent;let writes=0,focus=0;const observer=new MutationObserver(records=>writes+=records.length);observer.observe(oldBlock,{subtree:true,childList:true,characterData:true,attributes:true});const focused=()=>focus++;root.addEventListener('focus',focused,true);
    const oldIdentity=oldEngine.read().identity;const oldResult=await window.pendingRead;
    if(mode==='new-session'){await f.destroy();await f.mount('fresh','new');f.select(f.ids[1],1);}else{await f.remote(0,'R');}
    // Drain the previously scheduled microtasks, then resolve the old provider.
    const beforeFocus=focus;window.finishRead('LATE');await window.pendingRead;await Promise.resolve();await Promise.resolve();
    const result={oldIdentity,currentIdentity:f.engine.read().identity,outcome:oldResult,baseline,after:oldBlock.textContent,writes,focus,staleFocus:focus-beforeFocus,retainedActive:window.retainedTarget.active,protocolTrace:oldProtocol.trace};observer.disconnect();root.removeEventListener('focus',focused,true);return result;
  },mode);fact.lifetime=result;assert.equal(result.outcome.disposition,'rejected');assert.equal(result.after,result.baseline);assert.equal(result.writes,0);assert.equal(result.staleFocus,0);assert.equal(result.retainedActive,false);for(const key of ['writes','staleFocus','retainedActive']){const expected={writes:0,staleFocus:0,retainedActive:false},wrong={...expected,[key]:key==='retainedActive'?true:1};assert.throws(()=>assert.deepEqual({writes:result.writes,staleFocus:result.staleFocus,retainedActive:result.retainedActive},wrong),assert.AssertionError);fact.negativeControls=(fact.negativeControls??0)+1;}
  if(mode==='new-session'){assert.notEqual(result.currentIdentity.epoch,result.oldIdentity.epoch);assert.equal(result.currentIdentity.documentId,result.oldIdentity.documentId);checkpoint(await observe(page,fact),{text:['fresh','new'],local:0,caret:[1,1]},fact); // explicit mount/select can focus; stale completion cannot
    const before=await observe(page,fact);await finish(page,'AGAIN');const after=await observe(page,fact);assert.deepEqual(after.vector,before.vector);assert.deepEqual(after.checkpoint,before.checkpoint);
  }else{assert.equal(result.focus,0);const s=await page.evaluate(async()=>{const f=window.inputFixture;await f.engine.read();return{text:f.engine.read().visible.map(n=>n.runs.map(r=>r.text).join('')),updates:f.engine.takeObserverErrors(),history:f.engine.history({type:'state'})};});assert.deepEqual(s.text,['Ralpha','independent']);assert.equal(s.history.undoGroups,0);assert.deepEqual(s.updates,[]);}
  assert.equal(await page.locator('body > [role=status]:not(#status)').count(),0);
}));
