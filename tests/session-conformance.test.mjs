import assert from 'node:assert/strict';
import { test, before, after } from 'node:test';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { chromium } from 'playwright';
import { spawnSync } from 'node:child_process';
const output = process.env.EDITAC_CONFORMANCE_OUTPUT;
if (!output) throw Error('Set task-owned EDITAC_CONFORMANCE_OUTPUT; native outcome traces are required');
await mkdir(output, {recursive:true});
const corpus = await readFile(new URL('../fixtures/client-contracts/conformance.tsv',import.meta.url),'utf8');
const rows = corpus.split('\n').filter(l=>l && !l.startsWith('#')).map(l=>l.split('\t'));
const cases = ['Offline','Recovery','Readonly','Reconnect'];
assert.equal(rows.length,21);
let controller,browser,context;
const facts = { scope:'actual Chromium WASM/editor/IndexedDB + headless fault/SQLite; explicit host recovery, prepared peer delivery', cases:[], processes:[], providerCalls:0 };
before(async()=>{
 controller=await chromium.launchServer({headless:true}); const p=controller.process();
 facts.processes.push({pid:p.pid,launcher:p.spawnfile,workspace:process.cwd(),purpose:'CAP-1.10 conformance',port:null,log:'browser-conformance.log'});
 browser=await chromium.connect(controller.wsEndpoint());facts.browser={version:browser.version()};context=await browser.newContext();
 await context.route('https://session-conformance.test/**',async route=>{
  const path=new URL(route.request().url()).pathname;
  if(path==='/')return route.fulfill({contentType:'text/html',body:'<!doctype html><script type="importmap">{"imports":{"@edit-ac/core":"/core/index.js","@edit-ac/core/extensions":"/core/extensions/index.js"}}</script><main id="editor"></main>'});
  if(!/^\/(core|web)\/[a-zA-Z0-9/_-]+\.(js|wasm)$/.test(path))return route.abort();
  const prefix=path.startsWith('/core/')?'../packages/core/dist/':'../packages/web/dist/';
  return route.fulfill({contentType:path.endsWith('.wasm')?'application/wasm':'text/javascript',body:await readFile(new URL(prefix+path.replace(/^\/(core|web)\//,''),import.meta.url))});
 });
});
for(const [index,name] of cases.entries()) test(`shared ${name}: actual browser agrees with headless and SQLite`,async()=>{
 const page=await context.newPage(); const observations=[];const caseRows=rows.filter(r=>r[0]===name);
 try {
  await page.goto('https://session-conformance.test/');
  await page.evaluate(async({index,name})=>{
   const {init}=await import('/core/index.js');const {mountEditor}=await import('/web/editor.js');
   const {recoverLocalDocument}=await import('/web/entry.js');
   const {CheckpointStorage}=await import('/web/storage/checkpoint.js');const {UpdateJournal}=await import('/web/storage/journal.js');const {UpdateOutbox}=await import('/web/storage/outbox.js');
   const runtime=await init('/core/wasm/editac_wasm_bg.wasm');
   const seed=runtime.createEngine({profile:'v5',documentId:`12345678-1234-4234-8234-${(index+1).toString(16).padStart(12,'0')}`,epoch:'23456789-2345-4345-8345-23456789abcd',nodes:[{text:''}]});
   const point=seed.checkpoint();seed.dispose();const databaseName=`cap-conformance-${name}`;
   const points=await CheckpointStorage.open(indexedDB,databaseName);await points.publish(point,[]);points.close();
   const journal=await UpdateJournal.open(indexedDB,databaseName),outbox=await UpdateOutbox.open(indexedDB,databaseName);
   const f=window.fixture={runtime,point,databaseName,journal,outbox,readonly:false,session:null,editor:null};
   f.open=async()=>{
    f.editor=mountEditor(document.querySelector('#editor'),{assetUrl:'/core/wasm/editac_wasm_bg.wasm',databaseName,identity:point.identity,indexedDB,locks:navigator.locks,readOnly:f.readonly,plainPasteControl:false,
     recover:async options=>{f.session=await recoverLocalDocument(options);return f.session;}});
    await f.editor.ready;
   };
   f.insert=value=>{const at=f.editor.anchor(f.editor.read().visible[0].id,0,'right');try{f.editor.commit({kind:'text',origin:'local:conformance',command:{type:'insert',at,text:value}});}finally{f.editor.releaseAnchor(at);}};
   f.text=()=>f.editor.read().visible[0].runs.map(r=>r.text).join('');
   await f.open();
  },{index,name});
  await context.setOffline(true);
  for(const row of caseRows){
   const observed=await page.evaluate(async row=>{
    const f=window.fixture;const action=row[1];let result='ready';
    if(action==='insert'){
     try{f.insert(row[2]);await f.editor.flush({target:'local'});result='committed';}catch(error){if(!f.readonly)throw error;result='rejected';}
    }else if(action==='undo'||action==='redo'){
     const root=document.querySelector('#editor');root.focus();
     const before=f.editor.read().revision;
     const mac=/Mac|iPhone|iPad/.test(navigator.platform);
     const key={key:'z',metaKey:mac,ctrlKey:!mac,shiftKey:action==='redo',bubbles:true,cancelable:true};
     root.dispatchEvent(new KeyboardEvent('keydown',key));root.dispatchEvent(new KeyboardEvent('keyup',key));
     await f.editor.flush({target:'local'});
     if(f.readonly){if(f.editor.read().revision!==before)throw Error('readonly history mutated');result='rejected';}else {if(f.editor.read().revision===before)throw Error('history shortcut did not execute');result='committed';}
    }else if(action==='readonly'||action==='writable'){f.readonly=action==='readonly';f.editor.setReadOnly(f.readonly);
    }else if(action==='fail-insert'){
     const original=IDBDatabase.prototype.transaction;
     IDBDatabase.prototype.transaction=function(...args){const tx=original.apply(this,args);if(args[1]==='readwrite')queueMicrotask(()=>tx.abort());return tx;};
     try{f.insert(row[2]);await f.editor.flush({target:'local'});throw Error('failed transaction acknowledged');}
     catch(error){if(f.session.storage.state.phase!=='error'||f.editor.recoveryExport().unsavedUpdates.length!==1)throw error;result='recovery-required';}
     finally{IDBDatabase.prototype.transaction=original;}
    }else if(action==='recover'){
     // Host recovery is explicit: retain exact failed envelopes, settle idempotently,
     // then reopen via real engine-qualified checkpoint/journal recovery.
     const report=await f.editor.destroy({policy:'report'});
     if(!report.unsaved||report.recovery.unsavedUpdates.length!==1)throw Error('missing salvage');
     for(const update of report.recovery.unsavedUpdates){await f.journal.append(update);await f.journal.append(update);}
     await f.open();
    }else if(action==='reopen'){
     const old=f.session.writer.writerId;await f.editor.destroy({policy:'flush'});await f.open();
     if(f.session.writer.writerId===old)throw Error('writer identity reused');
    }else if(action==='peer-insert'){
     const peer=f.runtime.restoreEngine(f.point.identity,f.editor.recoveryExport().checkpoint);let update;
     const subscription=peer.subscribe({type:'updates'},p=>{if(p.update)update={identity:p.identity,writerId:p.writerId,sequence:p.sequence,origin:p.origin,bytes:p.update.bytes};});
     const at=peer.anchor(peer.read().visible[0].id,0,'right');const plan=peer.prepare({kind:'text',origin:'local:peer',command:{type:'insert',at,text:row[2]}});
     try{peer.commit(plan);await f.journal.append(update);}finally{peer.releasePlan(plan);peer.releaseAnchor(at);subscription.dispose();peer.dispose();}result='detached';
     }else if(action==='upload'){
     const frames=[];const sync=await f.editor.attachSync({transport:{send:frame=>{frames.push(new Uint8Array(frame));return true;}},authorized:true,peerIdentity:f.point.identity});
     await sync.pump(0);if(frames.length<2||sync.state.phase!=='attached')throw Error('no reconnect frames');sync.detach();result='sent-unknown';
    }else if(action==='catch-up'){await f.session.storage.catchUpLocal(f.runtime);
    }else throw Error(`unknown action ${action}`);
    return [row[0],action,row[2],f.text()||'~',String((await f.outbox.pending(f.point.identity)).length),result];
   },row);
   observations.push(observed.join('\t'));assert.deepEqual(observed,row);
  }
  const trace=observations.join('\n')+'\n';
  await writeFile(join(output,`browser-${name}.tsv`),trace);
  for(const adapter of ['headless','native'])assert.equal(await readFile(join(output,`${adapter}-${name}.tsv`),'utf8'),trace);
  facts.cases.push({name,passed:true,steps:caseRows.length,adapters:['browser','headless','native']});
 }finally{
  await page.evaluate(async()=>{const f=window.fixture;if(f){await f.editor?.destroy({policy:'report'});f.journal.close();f.outbox.close();}}).catch(error=>{facts.cleanupError=String(error);});
  await page.close();await context.setOffline(false);
 }
});
test('minimal semantic core resolved dependencies exclude client presentation/storage/protection stacks',async()=>{
 const r=spawnSync('cargo',['tree','-p','editac-core','--no-default-features','--edges','normal','--prefix','none','--locked','--offline'],{encoding:'utf8',cwd:resolve(new URL('..',import.meta.url).pathname)});
 await writeFile(join(output,'minimal-core-dependencies.txt'),r.stdout+r.stderr);assert.equal(r.status,0);
 const packages=[...new Set(r.stdout.split('\n').filter(Boolean).map(l=>l.split(' ')[0]))];assert.ok(packages.length>1);
 const forbidden=/^(editac-(session|markdown|wasm|cli|tui|mcp|diff|encrypt|protection)|rusqlite|crossterm|ratatui|tauri|winit|egui|rmcp|aes|aes-gcm|chacha20poly1305|argon2|keyring|web-sys|js-sys)$/;
 assert.deepEqual(packages.filter(p=>forbidden.test(p)),[]);facts.minimalCore={packages,forbiddenMatches:0};
});
after(async()=>{
 try{await context?.close();await browser?.close();}finally{await controller?.close();facts.teardown={browserClosed:!browser?.isConnected(),browserProcessExited:!controller||controller.process().exitCode!==null,serversStarted:0};await writeFile(join(output,'harness.json'),JSON.stringify(facts,null,2));}
});
