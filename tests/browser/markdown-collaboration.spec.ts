import assert from 'node:assert/strict';
import {test} from 'node:test';
import {createHash} from 'node:crypto';
import {browserHarness} from './browser-harness.ts';
import {state} from './format-helpers.ts';
import {fixedPaste,seed,summary} from '../../benchmarks/paste/fixtures.mjs';
const {probe}=browserHarness('markdown-collaboration');
for(const bytes of [10240,102400])test(`${bytes} byte paste preparation, application and formatted-frame budget`,()=>probe(`cost-${bytes}`,async(page,fact)=>{
  const raw=fixedPaste(bytes);assert.equal(Buffer.byteLength(raw),bytes);fact.fixture={seed,bytes,sha256:createHash('sha256').update(raw).digest('hex'),warmup:2,samples:30};
  const samples=[];
  for(let i=0;i<32;i++){
    if(i){await page.evaluate(async()=>{await window.inputFixture.destroy();window.fixtureDisposed=true;await new Promise((resolve,reject)=>{const request=indexedDB.deleteDatabase('browser-input');request.onsuccess=resolve;request.onerror=()=>reject(request.error);request.onblocked=()=>reject(Error('fixture-database-blocked'));});});await page.reload();await page.waitForFunction(()=>!!window.inputFixture);await page.evaluate(async()=>{window.fixtureDisposed=true;await window.inputFixture.mount();window.fixtureDisposed=false;});}
    const record=await page.evaluate(async raw=>{
      const f=window.inputFixture;f.protocol.clipboard.plainTextPolicy='markdown';f.select(f.ids[0],0,5);
      const arrival=performance.now(),prepStart=performance.now(),p=f.engine.importMarkdown(raw),preparationMs=performance.now()-prepStart;
      const transferStart=performance.now(),encoded=JSON.stringify({version:1,schema:f.engine.read().identity.schema,blocks:p.blocks}),transferMs=performance.now()-transferStart;
      const applyStart=performance.now(),result=f.protocol.clipboard.paste({getData:m=>m==='application/x-edit-ac-fragment+json'?encoded:''}),applyMs=performance.now()-applyStart;
      if(result.disposition!=='committed')throw Error(JSON.stringify({result,diagnostics:f.protocol.clipboard.diagnostics}));
      const node=f.engine.read().visible.find(n=>n.id===f.ids[0]);if(!node.runs.some(r=>r.attributes.bold===true)||f.root.textContent.includes('**fixed**'))throw Error('raw-intermediate-frame');
      await new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)));const formattedFrameMs=performance.now()-arrival;
      const normalStart=performance.now();f.engine.history({type:'undo'});const undoMs=performance.now()-normalStart;
      const redoStart=performance.now();f.engine.history({type:'redo'});const redoMs=performance.now()-redoStart;f.engine.history({type:'undo'});
      return {preparationMs,transferMs,encodedBytes:new TextEncoder().encode(encoded).length,applyMs,formattedFrameMs,undoMs,redoMs};
    },raw);if(i>=2)samples.push(record);
  }
  fact.samples=samples;fact.summary=Object.fromEntries(['preparationMs','transferMs','applyMs','formattedFrameMs','undoMs','redoMs'].map(k=>[k,summary(samples.map(s=>s[k]))]));
  fact.targetMs=bytes===10240?50:150;fact.observedWithinTarget=fact.summary.formattedFrameMs.p95<=fact.targetMs;fact.scope='fresh-session controlled desktop packed browser; physical phone, retained-history stress and peak memory not qualified';
  assert.equal(samples.length,30);assert.ok(samples.every(s=>s.encodedBytes>=bytes));fact.budgetStatus=fact.observedWithinTarget?'met':'missed; release qualification required';assert.deepEqual((await state(page,fact)).text,['alpha','independent']);
}));
test('concurrent second replica paste exchange preserves independent edits and selective history',()=>probe('replica',async(page,fact)=>{
  const result=await page.evaluate(async()=>{
    const f=window.inputFixture,{init}=await import('@edit-ac/core'),runtime=await init('/core/wasm/editac_wasm_bg.wasm'),local=f.engine,vector=local.stateVector(),peer=runtime.restoreEngine(local.read().identity,local.checkpoint());
    try{
      f.select(f.ids[0],0,5);f.protocol.clipboard.plainTextPolicy='markdown';const outcome=f.protocol.clipboard.paste({getData:m=>m==='text/markdown'?'# **é😀**\n\n[ref][id]\n\n[id]: https://example.com/a':''});
      const at=peer.anchor(f.ids[1],0,'right');try{peer.commit(peer.prepare({kind:'text',origin:'prepared-peer',command:{type:'insert',at,text:'remote '}}));}finally{peer.releaseAnchor(at);}
      const remoteUpdate=peer.encodeUpdate(vector),pasteUpdate=local.encodeUpdate(vector);local.applyUpdate(remoteUpdate);peer.applyUpdate(pasteUpdate);
      const semantic=e=>e.read().visible.map(n=>({id:n.id,parent:n.parent,kind:n.kind,attributes:n.blockAttributes,runs:n.runs,editor:n.editor}));
      const merged=semantic(local),other=semantic(peer);local.history({type:'undo'});const undone=semantic(local);local.history({type:'redo'});const redone=semantic(local);
      return {outcome,merged,other,undone,redone,remoteBytes:remoteUpdate.bytes.length,pasteBytes:pasteUpdate.bytes.length};
    }finally{peer.dispose();}
  });fact.snapshots.push(result);assert.equal(result.outcome.disposition,'committed');assert.deepEqual(result.merged,result.other);assert.deepEqual(result.redone,result.merged);
  assert.ok(result.undone.some(n=>n.runs.map(r=>r.text).join('')==='remote independent'));assert.ok(result.undone.some(n=>n.runs.map(r=>r.text).join('')==='alpha'));assert.ok(result.remoteBytes>0);assert.ok(result.pasteBytes>0);assert.equal((await state(page,fact)).history.undoGroups,1);
}));
