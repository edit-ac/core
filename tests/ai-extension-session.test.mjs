import assert from 'node:assert/strict';
import { test, before } from 'node:test';
import { readFile } from 'node:fs/promises';
import { init } from '@edit-ac/core';
import { AiHost, AiSession, captureAiTarget } from '@edit-ac/core/extensions';
let runtime, serial = 0;
before(async () => { runtime = await init('data:application/wasm;base64,' + (await readFile(new URL('../packages/core/dist/wasm/editac_wasm_bg.wasm', import.meta.url))).toString('base64')); });
const request = (id = 'proposal', operation = 'rewrite') => ({ version: 1, requestId: id, operation, scope: 'selection', instruction: 'Rewrite prepared content', context: 'base', format: 'plain-text', outputBytes: 100 });
const delta = (r, text = 'שלום 🧪', sequence = 0) => ({ version: 1, requestId: r.requestId, sequence, type: 'delta', text });
const finish = (r, sequence = 1) => ({ version: 1, requestId: r.requestId, sequence, type: 'finish', usage: null });
const release = (e, r) => { if (r?.caret) e.releaseAnchor(r.caret); if (r?.selection) { e.releaseAnchor(r.selection.anchor); e.releaseAnchor(r.selection.focus); } };
const texts = e => e.read().visible.map(n => n.runs.map(r => r.text).join(''));
function fixture(transport, timeoutMs = 1000) {
  const engine = runtime.createEngine({ profile: 'v5', documentId: `a1220000-0000-4000-8000-${String(++serial).padStart(12, '0')}`, epoch: 'a1220000-0000-4000-8000-000000000001', nodes: [{ text: 'base' }, { text: 'context' }, { text: 'unrelated' }] });
  let writable = true, calls = 0, aborted = 0, disposed = 0;
  const host = new AiHost({ version: 1, enabled: true, capabilities: ['ask','fill','continue','rewrite','completion'], limits: { requests: 5, instructionBytes: 100, contextBytes: 100, outputBytes: 100, timeoutMs } }, { send(r, signal) { calls++; signal.addEventListener('abort', () => aborted++, { once: true }); return transport(r, signal); } }, () => ({ allowRemote: true, protectedDocument: false }), () => true);
  const session = new AiSession(host), range = { anchor: engine.anchor(engine.read().visible[0].id, 0, 'right'), focus: engine.anchor(engine.read().visible[0].id, 4, 'left') };
  const capture = (context = true) => { const t = captureAiTarget(engine, range, context ? [engine.read().visible[1].id] : [], () => writable); return { ...t, dispose() { disposed++; t.dispose(); } }; };
  const edit = (index, text) => { const owner = engine.read().visible[index].id; release(engine, engine.commit(engine.prepare({ kind: 'editor', origin: 'fixture:edit', commands: [{ type: 'replaceAt', owner, from: 0, to: 0, text }] }))); };
  const sentinel = () => ({ bytes: engine.checkpoint().bytes, history: engine.history({ type: 'state' }), snapshot: (() => { const { changedNodes, touchedRanges, ...state } = engine.read(); return state; })() });
  return { engine, host, session, range, capture, edit, sentinel, setWritable: v => writable = v, counts: () => ({ calls, aborted, disposed }), cleanup() { session.dispose(); release(engine, { selection: range }); engine.dispose(); } };
}
async function* good(r) { yield delta(r); yield finish(r); }
test('real WASM proposal is ephemeral then accepts once with one undo group, origin and redo', async () => {
  const f = fixture(good); try {
    const before = f.sentinel(); await f.session.start(request(), f.capture());
    assert.equal(f.session.state.status, 'review'); assert.deepEqual(f.sentinel(), before);
    const accepted=f.session.accept();assert.ok(accepted.selection);assert.deepEqual([f.engine.resolve(accepted.selection.anchor).offset,f.engine.resolve(accepted.selection.focus).offset],[7,7]);release(f.engine,accepted); assert.equal(f.session.state.status, 'accepted'); assert.equal(f.session.accept(), undefined);
    assert.deepEqual(texts(f.engine), ['שלום 🧪','context','unrelated']); assert.equal(f.engine.history({ type: 'state' }).undoGroups, 1);
    const undone=f.engine.history({type:'undo'});assert.deepEqual([f.engine.resolve(undone.selection.anchor).offset,f.engine.resolve(undone.selection.focus).offset],[0,4]);release(f.engine,undone);assert.equal(texts(f.engine)[0],'base');
    const redone=f.engine.history({type:'redo'});assert.deepEqual([f.engine.resolve(redone.selection.anchor).offset,f.engine.resolve(redone.selection.focus).offset],[7,7]);release(f.engine,redone);assert.equal(texts(f.engine)[0],'שלום 🧪');
    assert.deepEqual(f.counts(), { calls: 1, aborted: 1, disposed: 1 });
  } finally { f.cleanup(); }
});
for (const kind of ['duplicate','out-of-order','wrong-id','oversized','empty','unterminated','error','malformed','throw']) test(`prepared ${kind} retains document/history and releases capture`, async () => {
  async function* bad(r) {
    if (kind === 'throw') throw new Error('prepared disconnect');
    if (kind === 'empty') { yield finish(r, 0); return; }
    if (kind === 'malformed') { yield { ...delta(r), html: '<script>' }; return; }
    yield delta(r, kind === 'oversized' ? 'é'.repeat(51) : 'part');
    if (kind === 'duplicate') yield delta(r, 'again');
    if (kind === 'out-of-order') yield finish(r, 3);
    if (kind === 'wrong-id') yield { ...finish(r), requestId: 'other' };
    if (kind === 'error') yield { version: 1, requestId: r.requestId, sequence: 1, type: 'error', code: 'transport' };
  }
  const f = fixture(bad); try { const before = f.sentinel(); await f.session.start(request(), f.capture()); assert.equal(f.session.state.status, 'failed'); assert.equal(f.session.accept(), undefined); assert.deepEqual(f.sentinel(), before); assert.equal(f.counts().disposed, 1); assert.equal(f.counts().aborted, 1); assert.ok(new TextEncoder().encode(f.session.recoveryCopy()).length <= 100); } finally { f.cleanup(); }
});
for (const kind of ['target-edit','context-edit','permission','dispose','switch','reject','cancel']) test(`review invalidation: ${kind}`, async () => {
  const f = fixture(good); try {
    await f.session.start(request(), f.capture());
    if (kind === 'target-edit') f.edit(0, 'changed');
    if (kind === 'context-edit') f.edit(1, 'changed');
    if (kind === 'permission') f.setWritable(false);
    if (kind === 'dispose') f.session.dispose();
    if (kind === 'switch') f.session.invalidate();
    if (kind === 'reject') f.session.reject();
    if (kind === 'cancel') f.session.cancel();
    const before = f.sentinel(); assert.equal(f.session.accept(), undefined); assert.deepEqual(f.sentinel(), before); assert.equal(f.counts().disposed, 1);
  } finally { f.cleanup(); }
});
test('answer remains copy-only even when supplied an editing target', async () => { const f = fixture(good); try { const before = f.sentinel(); await f.session.start(request('answer','ask'), f.capture()); assert.equal(f.session.state.status,'review'); assert.equal(f.session.accept(),undefined); assert.equal(f.session.recoveryCopy(),'שלום 🧪'); assert.deepEqual(f.sentinel(),before); } finally { f.cleanup(); } });
test('unrelated remote edit rebases anchored target and survives accept undo', async () => {
  const f = fixture(good); let peer; try {
    await f.session.start(request(),f.capture()); const cp=f.engine.checkpoint(); peer=runtime.restoreEngine(cp.identity,cp);
    const owner=peer.read().visible[2].id; release(peer,peer.commit(peer.prepare({kind:'editor',origin:'remote',commands:[{type:'replaceAt',owner,from:0,to:0,text:'REMOTE '}]})));
    f.engine.applyUpdate(peer.encodeUpdate(f.engine.stateVector()));
    release(f.engine,f.session.accept()); assert.equal(f.session.state.status,'accepted'); release(f.engine,f.engine.history({type:'undo'})); assert.deepEqual(texts(f.engine),['base','context','REMOTE unrelated']);
  } finally { peer?.dispose(); f.cleanup(); }
});
test('timeout aborts stalled host without waiting for iterator cleanup', async () => {
  const f=fixture(() => ({[Symbol.asyncIterator](){return {next:()=>new Promise(()=>{}),return:()=>new Promise(()=>{})};}}),10);
  try { const before=f.sentinel(); await f.session.start(request(),f.capture()); assert.equal(f.session.state.error,'timeout'); assert.deepEqual(f.sentinel(),before); assert.equal(f.counts().aborted,1); assert.equal(f.counts().disposed,1); } finally {f.cleanup();}
});
test('superseding operation cancels old generation; late delivery cannot replace new review', async () => {
  let late; const f=fixture((r) => r.requestId==='old' ? ({[Symbol.asyncIterator](){return {next:()=>new Promise(resolve=>late=resolve),return:async()=>({done:true})};}}) : good(r));
  try {const old=f.session.start(request('old'),f.capture()); await new Promise(r=>setImmediate(r)); await f.session.start(request('new'),f.capture()); late({done:false,value:delta(request('old'),'WRONG')}); await old; assert.equal(f.session.state.text,'שלום 🧪'); release(f.engine,f.session.accept()); assert.equal(texts(f.engine)[0],'שלום 🧪'); assert.equal(f.counts().calls,2); assert.equal(f.counts().disposed,2);} finally {f.cleanup();}
});
test('cancel pending stream releases once and ignores late result',async()=>{let late; const f=fixture(()=>({[Symbol.asyncIterator](){return {next:()=>new Promise(resolve=>late=resolve),return:async()=>({done:true})};}}));try{const before=f.sentinel(), run=f.session.start(request(),f.capture());await new Promise(r=>setImmediate(r));f.session.cancel();late({done:false,value:delta(request(),'WRONG')});await run;assert.equal(f.session.state.status,'canceled');assert.deepEqual(f.sentinel(),before);assert.equal(f.counts().disposed,1);}finally{f.cleanup();}});
for (const kind of ['insert','delete']) test(`real remote target ${kind} cannot redirect proposal`,async()=>{const f=fixture(good);let peer;try{await f.session.start(request(),f.capture());const cp=f.engine.checkpoint();peer=runtime.restoreEngine(cp.identity,cp);const owner=peer.read().visible[0].id;release(peer,peer.commit(peer.prepare({kind:'editor',origin:'remote',commands:[{type:'replaceAt',owner,from:0,to:kind==='delete'?4:0,text:kind==='delete'?'':'REMOTE'}]})));f.engine.applyUpdate(peer.encodeUpdate(f.engine.stateVector()));const before=f.sentinel();assert.equal(f.session.accept(),undefined);assert.equal(f.session.state.status,'stale');assert.deepEqual(f.sentinel(),before);}finally{peer?.dispose();f.cleanup();}});
test('captured range survives focus/selection changes and emits reviewed origin',async()=>{const f=fixture(good),origins=[];const sub=f.engine.subscribe({type:'all'},p=>origins.push(p.origin));try{const owner=f.engine.read().visible[2].id;release(f.engine,f.engine.commit(f.engine.prepare({kind:'editor',origin:'focus',commands:[{type:'selectionAt',anchor:{owner,offset:1,bias:'right'},focus:{owner,offset:1,bias:'left'}}]})));await f.session.start(request(),f.capture());release(f.engine,f.session.accept());assert.equal(texts(f.engine)[0],'שלום 🧪');await new Promise(r=>setImmediate(r));assert.ok(origins.includes('editac:local:ai:reviewed'));}finally{sub.dispose();f.cleanup();}});
test('engine disposal invalidates acceptance and permits repeated adapter teardown',async()=>{const f=fixture(good);await f.session.start(request(),f.capture());f.engine.dispose();assert.equal(f.session.accept(),undefined);assert.equal(f.session.state.status,'stale');f.session.dispose();f.session.dispose();assert.equal(f.counts().disposed,1);});
test('relevant edit followed by undo still invalidates captured context revision',async()=>{const f=fixture(good);try{await f.session.start(request(),f.capture());f.edit(1,'changed');release(f.engine,f.engine.history({type:'undo'}));assert.deepEqual(texts(f.engine),['base','context','unrelated']);const before=f.sentinel();assert.equal(f.session.accept(),undefined);assert.equal(f.session.state.status,'stale');assert.deepEqual(f.sentinel(),before);}finally{f.cleanup();}});
test('capture owns exactly two anchors and one subscription; disposal preserves caller range',()=>{const f=fixture(good);try{let imports=0,releases=0,subscription;const tracked={...f.engine,importAnchor(a){imports++;return f.engine.importAnchor(a);},releaseAnchor(a){releases++;f.engine.releaseAnchor(a);},subscribe(scope,callback){return subscription=f.engine.subscribe(scope,callback);}};const target=captureAiTarget(tracked,f.range,[],()=>true);assert.equal(target.valid(),true);assert.equal(imports,2);target.dispose();target.dispose();assert.equal(releases,2);assert.equal(subscription.active,false);assert.equal(f.engine.resolve(f.range.anchor).type,'position');assert.equal(f.engine.resolve(f.range.focus).type,'position');}finally{f.cleanup();}});
test('post-commit observer teardown preserves accepted outcome',async()=>{const f=fixture(good);try{await f.session.start(request(),f.capture());f.engine.subscribe({type:'updates'},p=>{if(p.origin==='editac:local:ai:reviewed')f.engine.dispose();});const result=f.session.accept();assert.ok(result);assert.equal(f.session.state.status,'accepted');assert.equal(f.session.accept(),undefined);assert.equal(f.counts().disposed,1);}finally{f.session.dispose();f.engine.dispose();}});
