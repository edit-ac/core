import assert from 'node:assert/strict';
import { test, before, after, afterEach } from 'node:test';
import { readFile, writeFile, mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createServer } from 'node:http';
import { spawnSync } from 'node:child_process';
import { chromium } from 'playwright';
import * as Y from 'yjs';
import { init, EngineError } from '../packages/core/dist/index.js';
const root = fileURLToPath(new URL('../', import.meta.url));
const explicit = process.env.EDITAC_WASM_UPDATE_OUTPUT;
const evidence = explicit ?? await mkdtemp(join(tmpdir(), 'editac-wasm-updates-'));
let runtime, native, server, base, browser, controller;
const engines = new Set();
const facts = { cases: [], processes: [] };
async function runRust(args, extra, log) {
  const r = spawnSync('cargo', args, {cwd:root, encoding:'utf8', timeout:120_000, env:{...process.env, EDITAC_WASM_UPDATE_OUTPUT:evidence, ...extra}});
  await writeFile(join(evidence, log), `${r.stdout ?? ''}${r.stderr ?? ''}`);
  assert.equal(r.error, undefined, `Rust setup error: ${log}`); assert.equal(r.status, 0, `Rust check failed: ${log}`);
  const counts = [...r.stdout.matchAll(/test result: ok\. (\d+) passed; (\d+) failed; (\d+) ignored;.*? (\d+) filtered out/g)].map(m=>({passed:+m[1],failed:+m[2],skipped:+m[3],filtered:+m[4]}));
  assert.ok(counts.some(c=>c.passed>0)); assert.ok(counts.every(c=>c.failed===0&&c.skipped===0));
  return {command:['cargo',...args],log,counts};
}
before(async () => {
  assert.equal(process.versions.node,'24.19.0');
  assert.equal(JSON.parse(await readFile(join(root,'node_modules/yjs/package.json'))).version,'13.6.33');
  await mkdir(evidence,{recursive:true});
  facts.native = await runRust(['test','-p','editac-wasm','--lib','updates::','--locked','--offline'],{},'native-updates.log');
  native = JSON.parse(await readFile(join(evidence,'native-fixture.json'),'utf8'));
  server = createServer(async(req,res)=>{
    try {
      const url=new URL(req.url,'http://local');
      if(url.pathname==='/') {res.setHeader('Content-Type','text/html');res.end('<!doctype html><title>WASM updates qualification</title>');return;}
      if(!url.pathname.startsWith('/core/')||url.pathname.includes('..')) throw Error('not found');
      res.setHeader('Content-Type',url.pathname.endsWith('.wasm')?'application/wasm':'text/javascript');
      res.end(await readFile(join(root,'packages/core/dist',url.pathname.slice(6))));
    }catch{res.writeHead(404);res.end();}
  });
  await new Promise((resolve,reject)=>{server.once('error',reject);server.listen(0,'127.0.0.1',resolve);});
  base=`http://127.0.0.1:${server.address().port}`;
  facts.processes.push({pid:process.pid,launcher:'node --test tests/wasm-updates.test.mjs',workspace:root,port:server.address().port,purpose:'qualification assets',log:'wasm-updates.log'});
  runtime=await init(`${base}/core/wasm/editac_wasm_bg.wasm`);
});
afterEach(()=>{for(const e of engines)e.dispose();engines.clear();});
after(async()=>{
  try {if(browser)await browser.close();} finally {
    if(controller)await controller.close();
    if(server){server.closeAllConnections();await new Promise(resolve=>server.close(resolve));}
    facts.teardown={serverClosed:!server?.listening,browserClosed:!browser?.isConnected(),browserProcessExited:!controller||controller.process().exitCode!==null};
    await writeFile(join(evidence,'harness.json'),JSON.stringify(facts,null,2));
    if(!explicit&&facts.cases.every(c=>c.passed))await rm(evidence,{recursive:true,force:true});
    else if(!explicit)console.log(`Preserved qualification evidence: ${evidence}`);
  }
});
function check(name, body){test(name,async()=>{const c={name,passed:false};facts.cases.push(c);await body();c.passed=true;});}
function cp(c=native.checkpoint){return {...structuredClone(c),bytes:Uint8Array.from(c.bytes)};}
function upd(u){return {...structuredClone(u),bytes:Uint8Array.from(u.bytes)};}
function own(e){engines.add(e);return e;}
function restore(c=cp(),journal=[]){return own(runtime.restoreEngine(cp().identity,c,journal));}
function semantic(s){const {revision,changedNodes,touchedRanges,...content}=s;return content;}
function first(e){return e.read().visible[0].id;}
function text(e,id=first(e)){return e.read().visible.find(n=>n.id===id).runs.map(r=>r.text).join('');}
function insert(e,value,offset=1){const at=e.anchor(first(e),offset,'right');try{return e.commit(e.prepare({kind:'text',origin:'sync:explicit',command:{type:'insert',at,text:value}}));}finally{try{e.releaseAnchor(at);}catch(error){if(!(error instanceof EngineError&&error.code==='Disposed'))throw error;}}}
function rejectAtomic(e,fn,code){e.read();const s=e.read(),c=e.checkpoint(),v=e.stateVector(),h=e.history({type:'state'});assert.throws(fn,err=>err instanceof EngineError&&(!code||err.code===code));assert.deepEqual(e.read(),s);assert.deepEqual(e.checkpoint(),c);assert.deepEqual(e.stateVector(),v);assert.deepEqual(e.history({type:'state'}),h);}
check('native Rust checkpoint restores in compiled WASM without defaults or writer reuse',()=>{
  const e=restore();assert.deepEqual(semantic(e.read()),semantic(native.initial));assert.equal(text(e),'a😀b');assert.notEqual(e.checkpoint().writerId,native.checkpoint.writerId);assert.equal(e.history({type:'state'}).undoGroups,0);
  const other=restore();assert.notEqual(e.checkpoint().writerId,other.checkpoint().writerId);
});
check('settled packed reads stay detached and refresh before reentrant local, history and remote observers',()=>{
  const e=restore(), peer=restore();
  const snapshot=e.read(), original=structuredClone(snapshot);
  snapshot.visible[0].runs[0].text='caller mutation';snapshot.identity.schema='caller mutation';snapshot.changedNodes.push('caller mutation');
  assert.deepEqual(semantic(e.read()),semantic(original));
  assert.deepEqual(e.read().changedNodes,[]);assert.deepEqual(e.read().touchedRanges,[]);
  const seen=[];e.subscribe({type:'all'},()=>{seen.push(text(e));assert.deepEqual(semantic(e.read()),semantic(restore(e.checkpoint()).read()));});
  insert(e,'Q');assert.equal(text(e),'aQ😀b');
  e.history({type:'undo'});assert.equal(text(e),'a😀b');
  e.history({type:'redo'});assert.equal(text(e),'aQ😀b');
  const vector=e.stateVector();peer.applyUpdate(e.encodeUpdate());insert(peer,'R');e.applyUpdate(peer.encodeUpdate(vector));
  assert.equal(text(e),'aRQ😀b');assert.deepEqual(seen,['aQ😀b','a😀b','aQ😀b','aRQ😀b']);
  rejectAtomic(e,()=>e.applyUpdate({identity:e.checkpoint().identity,bytes:Uint8Array.of(255)}));
  e.dispose();assert.throws(()=>e.read(),x=>x instanceof EngineError&&x.code==='Disposed');
});
check('native journal replay, duplicates and dependent reordered restore match Rust snapshot',()=>{
  const e=restore(cp(),[upd(native.journal[1]),upd(native.journal[0]),upd(native.journal[0])]);assert.deepEqual(semantic(e.read()),semantic(native.snapshot));assert.equal(text(e),'a😀XYb');assert.equal(e.history({type:'state'}).undoGroups,0);
});
check('state-vector differential exchange and duplicate remote updates have exact patches',()=>{
  const a=restore(),b=restore();const vector=b.stateVector();const events=[];b.subscribe({type:'updates'},p=>events.push(p));insert(a,'Z');const u=a.encodeUpdate(vector);assert.ok(u.bytes.length>2);b.applyUpdate(u);assert.equal(text(b),'aZ😀b');assert.deepEqual(semantic(a.read()),semantic(b.read()));assert.equal(events.length,1);assert.equal(events[0].operation,'Remote');assert.equal(events[0].origin,'remote');assert.deepEqual(events[0].update,u);const before=b.read();b.applyUpdate(u);assert.deepEqual(b.read(),before);assert.equal(events.length,1);assert.equal(b.history({type:'state'}).undoGroups,0);
});
check('three disconnected compiled replicas converge across all six duplicate delivery permutations',()=>{
  const replicas=[restore(),restore(),restore()];const vector=replicas[0].stateVector();const us=replicas.map((e,i)=>{insert(e,String.fromCharCode(65+i));return e.encodeUpdate(vector);});let agreed;
  for(const order of [[0,1,2],[0,2,1],[1,0,2],[1,2,0],[2,0,1],[2,1,0]]){
    const e=restore();for(const i of order){e.applyUpdate(us[i]);e.applyUpdate(us[i]);}const s=semantic(e.read());if(agreed)assert.deepEqual(s,agreed);else agreed=s;
    const actual=text(e);assert.equal(actual.replace(/[ABC]/g,''),'a😀b');for(const x of 'ABC')assert.equal(actual.split(x).length-1,1);
    assert.deepEqual(semantic(restore(e.checkpoint()).read()),s);
  }
});
check('pinned Yjs reads production WASM bytes and edits original rich text for WASM replay',()=>{
  const e=restore();insert(e,'W');const doc=new Y.Doc();try{
    Y.applyUpdate(doc,e.encodeUpdate().bytes);const vector=e.stateVector();const source=e.read().visible[0].spans[0].source;
    const rich=doc.getMap('registry-texts').get(source);assert.equal(rich.toString(),'aW😀b');assert.ok(rich instanceof Y.XmlText);
    rich.insert(2,'J');const u={identity:e.checkpoint().identity,bytes:Y.encodeStateAsUpdate(doc,vector)};e.applyUpdate(u);assert.equal(text(e),'aWJ😀b');assert.equal(e.history({type:'state'}).undoGroups,1);
    assert.deepEqual(Y.decodeStateVector(e.stateVector()),Y.decodeStateVector(Y.encodeStateVector(doc)));
  }finally{doc.destroy();}
});
check('delete-set replay works even when clocks did not change',()=>{
  const a=restore(),b=restore();const id=first(a);const anchor=a.anchor(id,1,'left'),focus=a.anchor(id,3,'right');const vector=b.stateVector();a.commit(a.prepare({kind:'text',origin:'delete',command:{type:'delete',range:{anchor,focus}}}));assert.deepEqual(a.stateVector(),vector);b.applyUpdate(a.encodeUpdate(vector));assert.equal(text(b),'ab');assert.deepEqual(semantic(a.read()),semantic(b.read()));
});
check('remote replay preserves local history and undo/redo produces usable sync bytes',()=>{
  const a=restore(),b=restore();insert(a,'L');insert(b,'R',4);a.applyUpdate(b.encodeUpdate());b.applyUpdate(a.encodeUpdate());assert.equal(text(a),'aL😀bR');const events=[];a.subscribe({type:'updates'},p=>events.push(p));a.history({type:'undo'});assert.equal(text(a),'a😀bR');assert.equal(events[0].operation,'Undo');b.applyUpdate(events[0].update);assert.equal(text(b),'a😀bR');a.history({type:'redo'});b.applyUpdate(events[1].update);assert.equal(events[1].operation,'Redo');assert.equal(text(b),'aL😀bR');
});
for(const [label,change]of [['epoch',i=>({...i,epoch:'34567890-3456-4456-8456-34567890abcd'})],['document',i=>({...i,documentId:'34567890-3456-4456-8456-34567890abcd'})],['profile',i=>({...i,profile:'editac.yrs-yjs.editor.v4'})],['schema',i=>({...i,schema:'unsupported'})],['encoding',i=>({...i,updateEncoding:2})]]){
  check(`wrong ${label} update rejects before content, history or patch mutation`,()=>{const e=restore();let called=0;e.subscribe({type:'all'},()=>called++);const u=e.encodeUpdate();rejectAtomic(e,()=>e.applyUpdate({...u,identity:change(u.identity)}),'EngineRejected');assert.equal(called,0);assert.throws(()=>runtime.restoreEngine(e.checkpoint().identity,{...e.checkpoint(),identity:change(u.identity)}),EngineError);});
}
check('malformed update and state-vector bytes reject atomically',()=>{
  const e=restore();for(const b of [[],[255],[0,0,0]])rejectAtomic(e,()=>e.applyUpdate({identity:e.checkpoint().identity,bytes:Uint8Array.from(b)}),'EngineRejected');
  for(const b of [[],[0,0],[255,255,255,255,15],[1,0]])rejectAtomic(e,()=>e.encodeUpdate(Uint8Array.from(b)),'EngineRejected');
});
check('invalid root and mutated immutable rows reject through real staged admission',()=>{
  const e=restore();const d=new Y.Doc();try{Y.applyUpdate(d,e.encodeUpdate().bytes);const v=e.stateVector();d.getMap('unknown-root').set('attack',true);rejectAtomic(e,()=>e.applyUpdate({identity:e.checkpoint().identity,bytes:Y.encodeStateAsUpdate(d,v)}),'EngineRejected');}finally{d.destroy();}
  const d2=new Y.Doc();try{Y.applyUpdate(d2,e.encodeUpdate().bytes);const v=e.stateVector();d2.getMap('registry-parents').set(first(e),['block','@root',99]);rejectAtomic(e,()=>e.applyUpdate({identity:e.checkpoint().identity,bytes:Y.encodeStateAsUpdate(d2,v)}),'EngineRejected');}finally{d2.destroy();}
});
check('restore rejects missing initialization, wrong journal identity and malformed tails',()=>{
  const c=cp();assert.throws(()=>runtime.restoreEngine(c.identity,{...c,initialized:false}),EngineError);assert.throws(()=>runtime.restoreEngine(c.identity,{...c,bytes:new Uint8Array()}),EngineError);
  const wrong=upd(native.journal[0]);wrong.identity.epoch='34567890-3456-4456-8456-34567890abcd';assert.throws(()=>runtime.restoreEngine(c.identity,c,[wrong]),EngineError);
  assert.throws(()=>runtime.restoreEngine(c.identity,c,[{identity:c.identity,bytes:Uint8Array.of(255)}]),EngineError);assert.equal(text(restore(c)),'a😀b');
});
check('byte inputs enforce types, data envelopes and resource limits without getter execution',()=>{
  const e=restore();for(const b of [[0],new Uint16Array([0]),null,new Uint8Array(16*1024*1024+1)])rejectAtomic(e,()=>e.applyUpdate({identity:e.checkpoint().identity,bytes:b}));
  let reads=0;const hostile={identity:e.checkpoint().identity,get bytes(){reads++;return new Uint8Array();}};rejectAtomic(e,()=>e.applyUpdate(hostile),'InvalidInput');assert.equal(reads,0);assert.throws(()=>runtime.restoreEngine(cp().identity,hostile),EngineError);
  const c=cp();Object.defineProperty(c,'bytes',{get(){reads++;return new Uint8Array();},enumerable:true});assert.throws(()=>runtime.restoreEngine(cp().identity,c),EngineError);assert.equal(reads,0);
});
check('checkpoint, vector, update and event bytes remain owned after mutation and disposal',()=>{
  const e=restore();const c=e.checkpoint(),vector=e.stateVector(),u=e.encodeUpdate();const saved=Uint8Array.from(c.bytes);c.bytes.fill(0);u.bytes.fill(0);vector.fill(0);assert.deepEqual(e.checkpoint().bytes,saved);
  let event;e.subscribe({type:'all'},p=>event=p);insert(e,'K');const eventCopy=Uint8Array.from(event.update.bytes);e.dispose();assert.deepEqual(event.update.bytes,eventCopy);assert.equal(text(restore({...c,bytes:saved})),'a😀b');
});
check('scoped batches report exact changed node/range and ignore unrelated listeners',()=>{
  const e=restore();const id=first(e),source=e.read().visible[0].spans[0].source;const seen=[];let irrelevant=0;
  e.subscribe({type:'nodes',ids:[id]},p=>seen.push(p));e.subscribe({type:'sources',ids:[source]},p=>seen.push(p));e.subscribe({type:'nodes',ids:['missing']},()=>irrelevant++);e.subscribe({type:'selection'},()=>irrelevant++);
  insert(e,'😀');assert.equal(seen.length,2);const p=seen[0];assert.equal(p.version,1);assert.equal(p.sequence,1);assert.equal(p.operation,'Text');assert.equal(p.origin,'editac:local:sync:explicit');assert.deepEqual(p.changedNodes,[id]);assert.deepEqual(p.changedSources,[source]);assert.equal(p.nodes[0].node.runs.map(r=>r.text).join(''),'a😀😀b');assert.deepEqual(p.touchedRanges,[{source,start:1,newStart:1,oldEnd:1,newEnd:3}]);assert.equal(irrelevant,0);
});
check('post-transaction reentrant commit dispatches FIFO and subscriptions start with future batches',()=>{
  const e=restore(),order=[];let nested=false;let future;
  e.subscribe({type:'all'},p=>{order.push(`A${p.sequence}`);assert.equal(e.read().revision,p.revision);e.checkpoint();if(!nested){nested=true;future=e.subscribe({type:'all'},p=>order.push(`C${p.sequence}`));insert(e,'N',4);}});
  e.subscribe({type:'all'},p=>order.push(`B${p.sequence}`));insert(e,'T');assert.deepEqual(order,['A1','B1','A2','B2','C2']);assert.equal(future.active,true);assert.equal(text(e),'aT😀Nb');
});
check('observer throws and mutations cannot corrupt commits or other observers',()=>{
  const e=restore();e.subscribe({type:'all'},p=>{p.update.bytes.fill(0);p.nodes[0].node.runs[0].text='corrupt';throw new Error('observer failure');});let event;e.subscribe({type:'all'},p=>event=p);insert(e,'Q');assert.equal(text(e),'aQ😀b');assert.equal(event.nodes[0].node.runs[0].text,'aQ😀b');const other=restore();other.applyUpdate(event.update);assert.equal(text(other),'aQ😀b');assert.deepEqual(e.takeObserverErrors().map(x=>x.message),['observer failure']);assert.deepEqual(e.takeObserverErrors(),[]);
});
check('unsubscribe/dispose are idempotent and pending callbacks are removed',()=>{
  const e=restore();let second=0;let s2;const s1=e.subscribe({type:'all'},()=>s2.dispose());s2=e.subscribe({type:'all'},()=>second++);insert(e,'D');assert.equal(second,0);assert.equal(s2.active,false);s1.dispose();s1.dispose();e.dispose();e.dispose();assert.equal(s1.active,false);
  for(const fn of [()=>e.read(),()=>e.checkpoint(),()=>e.stateVector(),()=>e.encodeUpdate(),()=>e.applyUpdate(upd(native.journal[0])),()=>e.subscribe({type:'all'},()=>{}),()=>e.takeObserverErrors()])assert.throws(fn,x=>x instanceof EngineError&&x.code==='Disposed');
  const other=restore();let late=0;const early=other.subscribe({type:'all'},()=>other.dispose());other.subscribe({type:'all'},()=>late++);insert(other,'E');assert.equal(late,0);assert.equal(early.active,false);
});
check('subscription validation and bounded table preserve normal operations',()=>{
  const e=restore();for(const scope of [null,{type:'bad'},{type:'all',ids:[]},{type:'nodes',ids:[3]}])assert.throws(()=>e.subscribe(scope,()=>{}),EngineError);assert.throws(()=>e.subscribe({type:'all'},null),EngineError);
  const subs=Array.from({length:1024},()=>e.subscribe({type:'all'},()=>{}));assert.throws(()=>e.subscribe({type:'all'},()=>{}),x=>x.code==='ResourceLimit');subs[0].dispose();const fresh=e.subscribe({type:'all'},()=>{});assert.equal(fresh.active,true);subs.forEach(s=>s.dispose());fresh.dispose();insert(e,'B');assert.equal(text(e),'aB😀b');
});
check('built WASM structural/format/history checkpoint and update replay agrees with native Rust',async()=>{
  const e=restore();const original=e.checkpoint();const a=e.anchor(first(e),1,'right');insert(e,'W');
  e.commit(e.prepare({kind:'format',origin:'format',marks:[{range:{anchor:a,focus:e.anchor(first(e),4,'left')},mark:'bold',action:'apply'}],blocks:[]}));
  const split=e.anchor(first(e),4,'right');e.commit(e.prepare({kind:'editor',origin:'split',commands:[{type:'split',owner:first(e),at:split}]}));
  e.history({type:'undo'});e.history({type:'redo'});
  assert.equal(e.read().visible.length,3);assert.deepEqual(e.read().visible.map(n=>n.runs.map(r=>r.text).join('')),['aW😀','b','é👩‍💻אב']);assert.ok(e.read().visible[0].runs.some(r=>r.attributes.bold===true));
  const update=e.encodeUpdate();const snapshot=e.read();
  const file=join(evidence,'wasm-replay-input.json');await writeFile(file,JSON.stringify({checkpoint:{...original,bytes:Array.from(original.bytes)},update:{...update,bytes:Array.from(update.bytes)},snapshot},null,2));
  facts.reverse=await runRust(['test','-p','editac-wasm','--lib','updates::native_updates_reverse_replay','--locked','--offline'],{EDITAC_WASM_REPLAY_INPUT:file},'reverse-native.log');
  const result=JSON.parse(await readFile(join(evidence,'built-wasm-replay.json'),'utf8'));assert.deepEqual(semantic(result),semantic(snapshot));
});
check('actual Chromium IndexedDB checkpoint/tail restore and peer sync use owned production bytes',async()=>{
  controller=await chromium.launchServer({headless:true});const child=controller.process();facts.processes.push({pid:child.pid,launcher:child.spawnfile,workspace:root,purpose:'IndexedDB and peer-byte WASM qualification',log:'wasm-updates.log'});
  browser=await chromium.connect(controller.wsEndpoint());facts.browser={version:browser.version(),playwright:JSON.parse(await readFile(join(root,'node_modules/playwright/package.json'))).version};
  const page=await browser.newPage();try{
    await page.goto(base);const result=await page.evaluate(async()=>{
      const {init}=await import('/core/index.js');const r=await init(`${location.origin}/core/wasm/editac_wasm_bg.wasm`);const a=r.createEngine({profile:'v5',documentId:'45678901-4567-4567-8567-45678901abcd',epoch:'56789012-5678-4678-8678-56789012abcd',nodes:[{text:'a😀b'}]});let b,c;let db;
      try{
        const cp=a.checkpoint();const id=a.read().visible[0].id;const at=a.anchor(id,3,'right');a.commit(a.prepare({kind:'text',origin:'browser:edit',command:{type:'insert',at,text:'B'}}));const tail=a.encodeUpdate();
        db=await new Promise((resolve,reject)=>{const req=indexedDB.open('editac-wasm-update-proof',1);req.onupgradeneeded=()=>req.result.createObjectStore('data');req.onsuccess=()=>resolve(req.result);req.onerror=()=>reject(req.error);});
        await new Promise((resolve,reject)=>{const tx=db.transaction('data','readwrite');tx.objectStore('data').put({cp,tail},'saved');tx.oncomplete=resolve;tx.onerror=()=>reject(tx.error);tx.onabort=()=>reject(tx.error);});
        const persisted=await new Promise((resolve,reject)=>{const tx=db.transaction('data','readonly');const req=tx.objectStore('data').get('saved');req.onsuccess=()=>resolve(req.result);req.onerror=()=>reject(req.error);});
        b=r.restoreEngine(cp.identity,persisted.cp,[persisted.tail]);c=r.restoreEngine(cp.identity,persisted.cp,[persisted.tail]);let events=0;const sub=b.subscribe({type:'updates'},p=>{events++;c.applyUpdate(p.update);});const anchor=b.anchor(id,4,'right');b.commit(b.prepare({kind:'text',origin:'browser:peer',command:{type:'insert',at:anchor,text:'C'}}));
        const result={storedTypes:[persisted.cp.bytes instanceof Uint8Array,persisted.tail.bytes instanceof Uint8Array],restored:b.read().visible[0].runs.map(r=>r.text).join(''),peer:c.read().visible[0].runs.map(r=>r.text).join(''),events,distinctWriters:a.checkpoint().writerId!==b.checkpoint().writerId};
        sub.dispose();b.dispose();result.inactive=!sub.active;return result;
      }finally{a.dispose();b?.dispose();c?.dispose();db?.close();await new Promise((resolve,reject)=>{const req=indexedDB.deleteDatabase('editac-wasm-update-proof');req.onsuccess=resolve;req.onerror=()=>reject(req.error);});}
    });assert.deepEqual(result,{storedTypes:[true,true],restored:'a😀BCb',peer:'a😀BCb',events:1,distinctWriters:true,inactive:true});facts.storage=result;
  }finally{await page.close();}
});
