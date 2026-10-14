import * as profiles from '@edit-ac/core/extensions';
import { init } from '@edit-ac/core';
import { CheckpointStorage, createEditor, taskPreset } from '@edit-ac/web';
import { ExtensionCommandSession } from '@edit-ac/web/modules';
import { openTutorial } from './tutorial.mjs';
import { assert, environment, runContractChecks } from './profile-conformance.mjs';
const fixture = await (await fetch('/profiles.json')).json();
const definitions = await (await fetch('/definitions.json')).json();
const identity = await (await fetch('/fixtures/identity.json')).json();
const runtime = await init('/engine.wasm');
const databaseName = 'extension-profiles';
const store = await CheckpointStorage.open(indexedDB,databaseName);
try {
  const engine = runtime.restoreEngine(identity,{identity,initialized:true,writerId:11,
    bytes:new Uint8Array(await (await fetch('/fixtures/custom-checkpoint.bin')).arrayBuffer())});
  try { await store.publish(engine.checkpoint(),[]); } finally { engine.dispose(); }
} finally { store.close(); }
const root = document.querySelector('#editor');
const host = {identity,databaseName,assetUrl:'/engine.wasm',indexedDB,locks:navigator.locks,definitions};
let tutorial = await openTutorial(root,{...host,presenters:false});
window.profileEditor = () => tutorial.editor;
window.profileRun = async () => {
  assert(environment.schema===identity.schema,"profile schema must match owning restored identity");
  const cases = await runContractChecks(profiles,fixture);
  const check = async (id,name,run) => { await run(); cases.push({id,name,passed:true}); };
  const release = result => {
    if(result?.caret)tutorial.editor.releaseAnchor(result.caret);
    if(result?.selection){tutorial.editor.releaseAnchor(result.selection.anchor);tutorial.editor.releaseAnchor(result.selection.focus);}
  };
  const projection = () => tutorial.editor.read().visible.find(n=>n.id==='n:11:1').runs;
  const original = projection();
  const other = tutorial.editor.read().visible.find(n=>n.kind==='block'&&n.id!=='n:11:1').id;
  const request = text => ({kind:'editor',origin:'local:profiles',commands:[{type:'replaceAt',owner:other,from:0,to:0,text}]});
  const revision = () => JSON.stringify(tutorial.editor.read().revision);
  await check('FPX-01','actual baseline and every preset retain host input/selection/a11y',async()=>{
    assert(root.getAttribute('role')==='textbox'&&root.getAttribute('aria-label')&&root.contentEditable==='true','baseline a11y/input');
    for(const profile of Object.values(profiles.FIRST_PARTY_PROFILES)) {
      const prepared=profiles.prepareExtensionProfile(profile,profiles.FIRST_PARTY_FEATURES,environment);
      const activation=new profiles.ExtensionProfileActivation(prepared);
      let live=0;
      assert(await activation.activate(Object.fromEntries(prepared.features.map(f=>[f.id,()=>{
        live++;const subscription=tutorial.editor.moduleRuntime.subscribe({kinds:['Editor'],selection:true},()=>{});
        return {dispose(){subscription.dispose();live--;}};
      }]))),'preset activated');
      const result=await tutorial.commands.run(()=>request('preset '));assert(result.status==='committed','preset baseline edit');release(result.result);
      assert(JSON.stringify(projection())===JSON.stringify(original),'preset changed opaque content');
      const after=tutorial.editor.read(),selection=getSelection(),anchorNode=selection.anchorNode,anchorOffset=selection.anchorOffset;
      activation.dispose();activation.dispose();
      assert(JSON.stringify(tutorial.editor.read())===JSON.stringify(after)&&live===0,'disable changed document/selection');
      assert(selection.anchorNode===anchorNode&&selection.anchorOffset===anchorOffset&&root.contains(anchorNode),'selection missing or changed');
    }
  });
  await check('FPX-02','failed admission leaves actual document and callbacks unchanged',()=>{
    const before=tutorial.editor.read();let invoked=0;
    const invalid={...profiles.FIRST_PARTY_PROFILES.core,features:[{id:'editac.slash',version:999}]};
    try{profiles.prepareExtensionProfile(invalid,profiles.FIRST_PARTY_FEATURES,environment);invoked++;}catch(e){assert(e.code==='incompatible-version','admission error');}
    assert(invoked===0&&JSON.stringify(before)===JSON.stringify(tutorial.editor.read()),'admission mutation');
  });
  await check('FPX-05','unload at active selection cancels pending command and preserves anchors/history',async()=>{
    root.focus();const node=root.querySelector('[data-node-id]')??root.firstElementChild;
    const walker=document.createTreeWalker(node,NodeFilter.SHOW_TEXT);const text=walker.nextNode();
    assert(text,'selection text');const selection=getSelection(),range=document.createRange();range.setStart(text,0);range.collapse(true);selection.removeAllRanges();selection.addRange(range);document.dispatchEvent(new Event('selectionchange'));await new Promise(r=>setTimeout(r,0));
    const anchor=tutorial.editor.anchor(other,0,'right');
    const prepared=profiles.prepareExtensionProfile(profiles.FIRST_PARTY_PROFILES['code-tools'],profiles.FIRST_PARTY_FEATURES,environment);
    const activation=new profiles.ExtensionProfileActivation(prepared);let resolve;
    const commands=new ExtensionCommandSession({get active(){return activation.active;},revision,can:r=>tutorial.editor.can(r),commit:r=>tutorial.editor.commit(r)});
    const pending=commands.run(()=>new Promise(done=>resolve=done));
    const before=tutorial.editor.read(), domSelection=getSelection().toString();
    activation.dispose();commands.dispose();resolve(request('late'));assert((await pending).status==='cancelled','late commit');
    assert(JSON.stringify(tutorial.editor.read())===JSON.stringify(before)&&getSelection().toString()===domSelection,'disable altered selection/document');
    // The same stable token still admits an owning prepared edit after disablement.
    const targetText=()=>tutorial.editor.read().visible.find(n=>n.id===other).runs.map(r=>r.text).join('');
    const beforeAnchor=targetText();
    const result=await tutorial.commands.run(()=>({kind:'text',origin:'local:profiles',command:{type:'insert',at:anchor,text:'anchor '}}));
    assert(result.status==='committed','anchor invalidated');release(result.result);tutorial.editor.releaseAnchor(anchor);
    const afterAnchor=targetText();
    root.dispatchEvent(new KeyboardEvent('keydown',{key:'z',metaKey:true,bubbles:true,cancelable:true}));
    assert(targetText()===beforeAnchor,'history undo invalid after unload');
    root.dispatchEvent(new KeyboardEvent('keydown',{key:'z',metaKey:true,shiftKey:true,bubbles:true,cancelable:true}));
    assert(targetText()===afterAnchor,'history redo invalid after unload');
    assert(JSON.stringify(projection())===JSON.stringify(original),'disable dropped module content');
  });
  await check('FPX-06','throw before prepare and postcommit observer failure preserve atomic edits',async()=>{
    const before=tutorial.editor.read();assert((await tutorial.commands.run(()=>{throw Error('prepare');})).status==='failed','prepare throw');
    assert(JSON.stringify(tutorial.editor.read())===JSON.stringify(before),'preparation mutated');
    let observed=0;const sub=tutorial.editor.moduleRuntime.subscribe({kinds:['Editor']},()=>{observed++;throw Error('after commit');});
    const result=await tutorial.commands.run(()=>request('committed '));assert(result.status==='committed'&&observed>0,'postcommit failed');release(result.result);sub.dispose();
    assert(tutorial.editor.read().visible.find(n=>n.id===other).runs.some(r=>r.text.includes('committed')),'commit lost');
    assert(tutorial.editor.moduleRuntime.takeErrors().some(e=>e.phase==='subscription'),'observer diagnostic');
  });
  await check('FPX-07','stalled optional work permits baseline edits and rejects stale result',async()=>{
    const prepared=profiles.prepareExtensionProfile(profiles.FIRST_PARTY_PROFILES.core,profiles.FIRST_PARTY_FEATURES,environment);
    const activation=new profiles.ExtensionProfileActivation(prepared,20);let resolve,aborted=false;
    const pending=activation.work(signal=>new Promise(done=>{resolve=done;signal.addEventListener('abort',()=>aborted=true);}),v=>typeof v==='string',revision);
    const edit=await tutorial.commands.run(()=>request('baseline '));assert(edit.status==='committed','blocked baseline');release(edit.result);
    assert((await pending).status==='timeout'&&aborted,'worker deadline');resolve('late');
    const late=activation.work(()=>new Promise(done=>resolve=done),v=>typeof v==='string',revision);await Promise.resolve();
    const changed=await tutorial.commands.run(()=>request('revision '));release(changed.result);resolve('stale');assert((await late).status==='stale','stale optional work');activation.dispose();
  });
  await check('FPX-07','actual prepared worker termination and malformed result',async()=>{
    const prepared=profiles.prepareExtensionProfile(profiles.FIRST_PARTY_PROFILES.core,profiles.FIRST_PARTY_FEATURES,environment);
    const activation=new profiles.ExtensionProfileActivation(prepared,500);let created=0,terminated=0;
    const workerJob=mode=>signal=>new Promise((resolve,reject)=>{
      const worker=new Worker('/prepared-worker.js');created++;
      let live=true;
      const stop=()=>{if(live){live=false;worker.terminate();terminated++;signal.removeEventListener('abort',abort);}};
      const abort=()=>{stop();reject(Error('worker aborted'));};
      signal.addEventListener('abort',abort,{once:true});
      worker.onmessage=event=>{stop();resolve(event.data);};worker.onerror=()=>{stop();reject(Error('worker error'));};worker.postMessage(mode);
    });
    const stalled=activation.work(workerJob('stall'),v=>typeof v==='string',revision);
    const edit=await tutorial.commands.run(()=>request('worker baseline '));assert(edit.status==='committed','worker blocked baseline');release(edit.result);
    assert((await stalled).status==='timeout'&&created===1&&terminated===1,'worker timeout not terminated');
    assert((await activation.work(workerJob('malformed'),v=>typeof v==='string',revision)).status==='failed','worker malformed accepted');
    activation.dispose();assert(created===2&&terminated===2,'worker resource leak');
  });
  await check('FPX-05','flush/reopen absent presenters and descriptors preserves original opaque content',async()=>{
    const subscription=tutorial.subscription,modules=tutorial.editor.moduleRuntime,commands=tutorial.commands;
    await tutorial.dispose();assert(!subscription.active&&!modules.active&&!commands.active,'host teardown');
    tutorial=await openTutorial(root,{...host,presenters:false,enabled:false});
    assert(tutorial.registry.size===0&&!root.querySelector('[data-module-view]'),'absent fallback');
    assert(JSON.stringify(projection())===JSON.stringify(original),'opaque data lost after reopen');
    assert(original.every(r=>root.textContent.includes(r.text)),'literal fallback missing');
  });
  await check('FPX-06','throwing presenter gets inert fallback without diagnostic recursion',async()=>{
    await tutorial.dispose();let errors=0;
    const registry=new profiles.ModuleRegistry();for(const d of definitions)registry.register(d,{tag:'span'});registry.freeze();
    const editor=createEditor(root,{...taskPreset({plainPasteControl:false}),...host,modules:registry,
      moduleRuntime:{renderers:Object.fromEntries(definitions.map(d=>[d.type,{mount(){throw Error('presenter');}}])),onError(){errors++;throw Error('reporter');}}});
    try {
      await editor.ready;assert(errors===2,'presenter diagnostics recursion');assert(!root.querySelector('[data-module-view]'),'failed decoration remains');
      assert(JSON.stringify(editor.read().visible.find(n=>n.id==='n:11:1').runs)===JSON.stringify(original),'presenter erased source');
      assert(original.every(r=>root.textContent.includes(r.text)),'presenter fallback');
    } finally {await editor.destroy({policy:'flush'});}
    tutorial=await openTutorial(root,{...host,presenters:false});
  });
  await check('FPX-08','repeated real host mount/dispose retains source with resource bounds',async()=>{
    for(let i=0;i<3;i++) {
      await tutorial.dispose();const stats={};tutorial=await openTutorial(root,{...host,presenters:true,stats});
      assert(stats.mounted===2,'missing views');const sub=tutorial.subscription,commands=tutorial.commands,moduleRuntime=tutorial.editor.moduleRuntime;
      await tutorial.dispose();await tutorial.dispose();assert(stats.disposed===2&&!sub.active&&!commands.active&&!moduleRuntime.active,'mount leak');
      tutorial=await openTutorial(root,{...host,presenters:false});assert(JSON.stringify(projection())===JSON.stringify(original),'reload changed source');
    }
  });
  window.profileFinish=async()=>{const sub=tutorial.subscription,modules=tutorial.editor.moduleRuntime;await tutorial.dispose();await tutorial.dispose();return !sub.active&&!modules.active;};
  return cases;
};
