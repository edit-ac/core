import assert from 'node:assert/strict';
import {test} from 'node:test';
import {state} from './format-helpers.ts';

export function registerLargePasteCases(probe) {
async function start(page,raw='**large** '+ 'x'.repeat(102400),target=0){
  await page.evaluate(({raw,target})=>{
    const f=window.inputFixture,n=f.engine.read().visible.filter(n=>n.kind==='block')[target];f.select(n.id,n.runs.map(r=>r.text).join('').length);
    f.protocol.clipboard.plainTextPolicy='markdown';window.pasteReads={};window.pasteRaw=raw;
    window.pasteJob=f.protocol.clipboard.pasteDeferred({getData:m=>{window.pasteReads[m]=(window.pasteReads[m]??0)+1;return m==='text/markdown'?window.pasteRaw:'';}},{schedule:()=>new Promise(resolve=>window.completePaste=resolve)});
  },{raw,target});await page.waitForFunction(()=>typeof window.completePaste==='function');
}
async function finish(page){return page.evaluate(async()=>{window.completePaste();return await window.pasteJob.result;});}
test('100 KiB preparation captures once, preserves later selection and commits once',()=>probe('large',async(page,fact)=>{
  await start(page);assert.equal(await page.getByRole('button',{name:'Cancel paste'}).count(),1);
  await page.evaluate(()=>{const f=window.inputFixture;window.pasteRaw='wrong';f.select(f.ids[1],3);});assert.equal((await finish(page)).disposition,'committed');
  const s=await state(page,fact);assert.equal(s.journal.length,1);assert.equal(s.history.undoGroups,1);assert.ok(s.text[0].startsWith('alphalarge'));assert.equal(s.text[0].length,102411);
  const r=await page.evaluate(()=>{const f=window.inputFixture,c=f.selection.capture();return {timings:window.pasteJob.timings,reads:window.pasteReads,selection:c.type==='captured'?f.engine.resolve(c.selection.range.anchor):c};});fact.measurements=r;assert.ok(Object.values(r.reads).every(n=>n===1));assert.equal(r.selection.node,s.nodes.find(n=>n.runs.some(r=>r.text==='independent')).id);assert.equal(r.selection.offset,3);assert.ok(r.timings.capturedBytes>102400);assert.ok(r.timings.preparationMs>=0);assert.ok(r.timings.applyMs>=0);
  await page.evaluate(()=>{window.completePaste();window.completePaste();});assert.equal((await state(page,fact)).journal.length,1);
  await page.evaluate(()=>window.inputFixture.engine.history({type:'undo'}));assert.deepEqual((await state(page,fact)).text,['alpha','independent']);await page.evaluate(()=>window.inputFixture.engine.history({type:'redo'}));assert.ok((await state(page,fact)).text[0].startsWith('alphalarge'));
}));
test('accessible cancel retains exact source with zero effects and ignores late completion',()=>probe('cancel',async(page,fact)=>{
  const raw='# canceled 😀';await start(page,raw);const before=await page.evaluate(()=>Array.from(window.inputFixture.engine.checkpoint().bytes));await page.getByRole('button',{name:'Cancel paste'}).click();assert.equal((await page.evaluate(()=>window.pasteJob.result)).reason,'clipboard-canceled');await finish(page);const s=await state(page,fact);assert.equal(s.journal.length,0);assert.equal(s.history.undoGroups,0);assert.equal(s.recovery[0].raw,raw);assert.deepEqual(await page.evaluate(()=>Array.from(window.inputFixture.engine.checkpoint().bytes)),before);assert.equal(await page.getByRole('button',{name:'Cancel paste'}).count(),0);
}));
test('deferred paste reads one projection per boundary and preserves rich paste and undo',()=>probe('projection-boundaries',async(page,fact)=>{
  const result=await page.evaluate(async()=>{
    const f=window.inputFixture,{ClipboardInput}=await import('/web/clipboard/fragment.js');
    let reads=0,release;
    const engine={...f.engine,read(){reads++;return f.engine.read();}};
    const clipboard=new ClipboardInput(f.renderer,f.selection,engine,request=>{
      const plan=f.engine.prepare(request);try{return f.engine.commit(plan);}finally{f.engine.releasePlan(plan);}
    },()=>false);
    const before=f.engine.read().visible.map(n=>n.runs.map(r=>r.text).join(''));
    f.select(f.ids[0],5);
    const job=clipboard.pasteDeferred({getData:m=>m==='text/html'?'<b>fresh</b>':m==='text/plain'?'fresh':''},{schedule:()=>new Promise(resolve=>release=resolve)});
    const openingReads=reads;await Promise.resolve();release();const outcome=await job.result;
    const totalReads=reads,after=f.engine.read().visible.map(n=>n.runs.map(r=>r.text).join(''));
    const history=f.engine.history({type:'state'});f.engine.history({type:'undo'});
    const restored=f.engine.read().visible.map(n=>n.runs.map(r=>r.text).join(''));
    clipboard.dispose();return {openingReads,totalReads,outcome,before,after,restored,history};
  });
  fact.projections=result;
  assert.equal(result.openingReads,1);assert.equal(result.totalReads,2);assert.equal(result.outcome.disposition,'committed');assert.deepEqual(result.after,['alphafresh','independent']);assert.deepEqual(result.restored,result.before);assert.equal(result.history.undoGroups,1);
}));
test('deleted target rejects rather than redirecting to an adjacent owner',()=>probe('delete',async(page,fact)=>{
  await start(page,'**recover**',1);await page.evaluate(async()=>{const f=window.inputFixture,{init}=await import('@edit-ac/core'),runtime=await init('/core/wasm/editac_wasm_bg.wasm'),local=f.engine,vector=local.stateVector(),peer=runtime.restoreEngine(local.read().identity,local.checkpoint()),nodes=peer.read().visible.filter(n=>n.kind==='block');try{peer.commit(peer.prepare({kind:'editor',origin:'remote-delete',commands:[{type:'join',first:nodes[0].id,second:nodes[1].id}]}));local.applyUpdate(peer.encodeUpdate(vector));}finally{peer.dispose();}});
  const before=await state(page,fact);assert.equal((await finish(page)).disposition,'rejected');const after=await state(page,fact);assert.deepEqual(after.text,before.text);assert.equal(after.journal.length,before.journal.length);assert.equal(after.history.undoGroups,0);assert.equal(after.recovery[0].raw,'**recover**');
}));
test('remote target move rejects with retained source and no paste update',()=>probe('move',async(page,fact)=>{
  await start(page,'**recover move**');await page.evaluate(async()=>{const f=window.inputFixture,{init}=await import('@edit-ac/core'),runtime=await init('/core/wasm/editac_wasm_bg.wasm'),local=f.engine,vector=local.stateVector(),peer=runtime.restoreEngine(local.read().identity,local.checkpoint()),node=peer.read().visible.find(n=>n.kind==='block');try{peer.commit(peer.prepare({kind:'editor',origin:'remote-move',commands:[{type:'wrap',targets:[node.id],style:{type:'quote'}}]}));local.applyUpdate(peer.encodeUpdate(vector));}finally{peer.dispose();}});
  const before=await state(page,fact);assert.equal((await finish(page)).reason,'clipboard-target-changed');const after=await state(page,fact);assert.deepEqual(after.text,before.text);assert.equal(after.journal.length,before.journal.length);assert.equal(after.history.undoGroups,0);assert.equal(after.recovery[0].raw,'**recover move**');
}));
test('destroy cancels pending work and tears down status and retained target',()=>probe('destroy',async(page,fact)=>{
  await start(page,'recover destroy');await page.evaluate(async()=>{await window.inputFixture.destroy();window.fixtureDisposed=true;});assert.equal((await page.evaluate(()=>window.pasteJob.result)).reason,'clipboard-canceled');await finish(page);assert.equal(await page.getByRole('button',{name:'Cancel paste'}).count(),0);assert.equal(await page.evaluate(()=>window.pasteJob.source['text/markdown']),'recover destroy');
}));
test('prepared second replica text updates revalidate stable offsets',()=>probe('remote-text',async(page,fact)=>{
  await start(page,'**safe**');await page.evaluate(()=>window.inputFixture.remote(0,'remote '));assert.equal((await finish(page)).disposition,'committed');const s=await state(page,fact);assert.equal(s.text[0],'remote alphasafe');assert.equal(s.history.undoGroups,1);
}));

test('cancel from a preparation hook prevents any document or journal mutation',()=>probe('hook-cancel',async(page,fact)=>{
  await start(page,'cancel from hook');
  await page.evaluate(()=>{window.inputFixture.protocol.clipboard.contentCodecs={extensions:[{name:'cancel-hook',prepare:p=>{window.pasteJob.cancel();return [{runs:[{text:p.source,marks:[]}]}];}}]};});
  assert.equal((await finish(page)).reason,'clipboard-canceled');
  const s=await state(page,fact);assert.deepEqual(s.text,['alpha','independent']);assert.equal(s.journal.length,0);assert.equal(s.history.undoGroups,0);assert.equal(await page.evaluate(()=>window.pasteJob.state),'canceled');
}));
test('cancel from publication cannot report an already committed paste as canceled',()=>probe('publication-cancel',async(page,fact)=>{
  await start(page,'**atomic**');
  await page.evaluate(()=>{window.pasteSubscription=window.inputFixture.engine.subscribe({type:'updates'},p=>{if(p.origin?.includes('clipboard'))window.pasteJob.cancel();});});
  assert.equal((await finish(page)).disposition,'committed');
  const s=await state(page,fact);assert.deepEqual(s.text,['alphaatomic','independent']);assert.equal(s.journal.length,1);assert.equal(s.history.undoGroups,1);assert.equal(await page.evaluate(()=>window.pasteJob.state),'committed');
  await page.evaluate(()=>window.pasteJob.cancel());assert.equal(await page.evaluate(()=>window.pasteJob.state),'committed');
}));

}
