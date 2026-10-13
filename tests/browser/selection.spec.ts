import assert from 'node:assert/strict';
import { test, before, after } from 'node:test';
import { spawnSync } from 'node:child_process';
import { mkdtemp, mkdir, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { createConnection } from 'node:net';
import { chromium, firefox, webkit } from 'playwright';
const engineName = process.env.EDITAC_SELECTION_BROWSER ?? 'chromium';
const browserType = { chromium, firefox, webkit }[engineName];
if (!browserType) throw new Error(`Unknown selection browser: ${engineName}`);
import * as Y from 'yjs';
import { startFixtureServer } from './fixture-server.mjs';

const output = process.env.EDITAC_SELECTION_OUTPUT ?? await mkdtemp(join(tmpdir(), 'editac-selection-evidence-'));
await mkdir(output, { recursive: true });
const facts = { cases: [], processes: [], packed: {}, browser: {}, server: {}, cleanup: {} };
let consumer, server, browser, controller;
async function run(command, args, cwd, log) {
  const result = spawnSync(command, args, { cwd, encoding: 'utf8', timeout: 120000 });
  await writeFile(join(output, log), `${result.stdout ?? ''}\n${result.stderr ?? ''}`);
  assert.equal(result.error, undefined, `${command}: see ${log}`);
  assert.equal(result.status, 0, `${command}: see ${log}`);
  return result.stdout;
}
before(async () => {
  consumer = await mkdtemp(join(tmpdir(), 'editac-selection-consumer-'));
  const packed = JSON.parse(await run('npm', ['pack', '--workspace', '@edit-ac/core', '--json', '--pack-destination', consumer],
    process.cwd(), 'pack.log'))[0];
  const tarball = await readFile(join(consumer, packed.filename));
  await writeFile(join(output, packed.filename), tarball);
  facts.packed = { filename: packed.filename, bytes: tarball.length,
    sha256: createHash('sha256').update(tarball).digest('hex'), consumer,
    includesWasm: packed.files.some(file => file.path === 'dist/wasm/editac_wasm_bg.wasm') };
  assert.equal(facts.packed.includesWasm, true);
  await run('tar', ['-xzf', join(consumer, packed.filename), '-C', consumer], process.cwd(), 'unpack.log');
  server = await startFixtureServer({ fixtureDirectory: 'fixtures/browser-selection', coreDirectory: join(consumer, 'package/dist') });
  facts.server = { ...server, close: undefined, launcher: 'node --test tests/browser/selection.spec.ts',
    purpose: 'WEB-1.3 packed-core canonical entry', log: 'selection.log' };
  controller = await browserType.launchServer({ headless: true });
  const child = controller.process();
  facts.processes.push({ pid: child.pid, launcher: child.spawnfile, workspace: process.cwd(),
    port: null, purpose: 'WEB-1.3 pinned Chromium', log: 'selection.log' });
  browser = await browserType.connect(controller.wsEndpoint());
  facts.browser = { engine: engineName, version: browser.version(), playwright: '1.64.0',
    node: process.version, platform: process.platform, arch: process.arch };
});
after(async () => {
  try { if (browser) await browser.close(); }
  finally {
    try {
      if (controller) {
        await controller.close();
        facts.cleanup.browserExited = controller.process().exitCode !== null || controller.process().signalCode !== null;
        assert.equal(facts.cleanup.browserExited, true);
      }
    } finally {
      try {
        if (server) {
          await server.close();
          facts.cleanup.listenerRemoved = await new Promise(resolve => {
            const socket = createConnection(server.port, '127.0.0.1');
            socket.once('connect', () => { socket.destroy(); resolve(false); });
            socket.once('error', error => resolve(error.code === 'ECONNREFUSED'));
          });
          assert.equal(facts.cleanup.listenerRemoved, true);
        }
      } finally {
        if (consumer) await rm(consumer, { recursive: true, force: true });
        facts.cleanup.consumerRemoved = true;
        await writeFile(join(output, 'facts.json'), JSON.stringify(facts, null, 2));
      }
    }
  }
});
async function open(context) {
  const page = await context.newPage();
  await page.goto(server.url);
  await page.waitForFunction(() => !!window.selectionFixture);
  return page;
}
async function withContext(name, action) {
  const context = await browser.newContext();
  const fact = { name, passed: false }; facts.cases.push(fact);
  try { await action(context, fact); fact.passed = true; }
  finally { await context.close(); }
}



test('forward and backward cross-block selections retain UTF-16 emoji endpoints',async()=>withContext('direction',async context=>{
  const page=await open(context);const {ids}=await page.evaluate(()=>window.selectionFixture.mount());
  const result=await page.evaluate(async()=>{
    const f=window.selectionFixture;
    const beforeBytes=[...f.engine.checkpoint().bytes],beforeHistory=f.engine.history({type:'state'});
    f.select(f.ids[0],2,f.ids[1],4);const forward=f.view();
    f.select(f.ids[1],4,f.ids[0],7);const backward=f.view();
    const selectionBytes=[...f.engine.checkpoint().bytes],selectionHistory=f.engine.history({type:'state'});
    const before=f.engine.read().revision;const history=f.engine.history({type:'state'});
    await f.edit(f.ids[10],0,'unrelated');
    return {beforeBytes,selectionBytes,beforeHistory,selectionHistory,forward,backward,after:f.view(),revision:before,history,afterHistory:f.engine.history({type:'state'})};
  });
  for(const [view,a,ao,b,bo] of [[result.forward,ids[0],2,ids[1],4],[result.backward,ids[1],4,ids[0],7],[result.after,ids[1],4,ids[0],7]]){
    assert.equal(view.anchor.node,a);assert.equal(view.anchor.offset,ao);assert.equal(view.focus.node,b);assert.equal(view.focus.offset,bo);assert.deepEqual(view.errors,[]);
  }
  assert.deepEqual(result.beforeBytes,result.selectionBytes);assert.deepEqual(result.beforeHistory,result.selectionHistory);
  assert.match(result.forward.text,/pha😀/);assert.equal(result.after.result.type,'restored');
  assert.equal(result.afterHistory.undoGroups,result.history.undoGroups+1);
}));

test('left and right caret affinity survives real local and peer insertions',async()=>withContext('affinity',async context=>{
  const page=await open(context);await page.evaluate(()=>window.selectionFixture.mount());
  const result=await page.evaluate(async()=>{
    const f=window.selectionFixture,id=f.ids[1],views=[];
    f.select(id,2,id,2,{anchor:'left',focus:'left'});await f.edit(id,2,'L');views.push(f.view());
    f.select(id,2,id,2,{anchor:'right',focus:'right'});await f.edit(id,2,'R');views.push(f.view());
    f.select(id,3,id,3,{anchor:'left',focus:'left'});await f.remote(id,3,'P');views.push(f.view());
    f.select(id,3,id,3,{anchor:'right',focus:'right'});await f.remote(id,3,'Q');views.push(f.view());
    return {views,model:f.engine.read().visible.find(n=>n.id===id).runs.map(r=>r.text).join('')};
  });
  assert.deepEqual(result.views.map(v=>v.anchor.offset),[2,3,3,4]);
  assert.deepEqual(result.views.map(v=>v.focus.offset),[2,3,3,4]);
  assert.ok(result.views.every(v=>v.result.type==='restored'&&v.errors.length===0));assert.equal(result.model,'HeRQPLading');
}));

test('empty blocks hard breaks code newlines and mark boundaries map exactly',async()=>withContext('maps',async context=>{
  const page=await open(context);await page.evaluate(()=>window.selectionFixture.mount());
  const result=await page.evaluate(async()=>{
    const f=window.selectionFixture,s=f.selection,r=f.renderer,rows=[];
    await f.edit(f.ids[8],6,'😀');await f.edit(f.ids[7],4,'\n');
    for(const [id,offsets] of [[f.ids[0],[0,2,5,7]],[f.ids[8],[0,5,6,8]],[f.ids[7],[0,4,5,11]],[f.ids[9],[0]]]){
      for(const offset of offsets)for(const bias of ['left','right']) {const dom=s.toDOM({node:id,offset,bias});rows.push({id,offset,bias,model:dom?s.toModel(dom.node,dom.offset,bias):null});}
    }
    const br=r.positions(f.ids[8]).find(p=>p.node.nodeName==='BR').node,parent=br.parentNode,index=[...parent.childNodes].indexOf(br);
    const breaks=[s.toModel(parent,index),s.toModel(parent,index+1),s.toModel(br,0)];
    f.select(f.ids[9],0);await f.remote(f.ids[9],0,'😀');
    return {rows,breaks,empty:f.view()};
  });
  for(const row of result.rows)assert.deepEqual(row.model,{node:row.id,offset:row.offset,bias:row.bias});
  assert.deepEqual(result.breaks.map(p=>p.offset),[5,6,5]);assert.equal(result.empty.anchor.offset,2);assert.equal(result.empty.focus.offset,2);
}));

test('list and root boundaries exclude checklist markers and separator atoms',async()=>withContext('atoms',async context=>{
  const page=await open(context);await page.evaluate(()=>window.selectionFixture.mount());
  const result=await page.evaluate(()=>{
    const f=window.selectionFixture,s=f.selection,r=f.renderer,root=r.root;
    f.select(f.ids[4],2,f.ids[5],3);const list=f.view();
    const marker=root.querySelector('[data-check-marker]'),separator=root.querySelector('hr');
    const invalid=[s.toModel(marker.firstChild,0),s.toModel(separator,0),s.toModel(document.body,0),s.toDOM({node:f.ids[0],offset:8,bias:'right'})].map(value=>value??null);
    const end=s.toModel(root,root.childNodes.length,'left'),start=s.toModel(root,0,'right');
    document.getSelection().setBaseAndExtent(marker.firstChild,0,marker.firstChild,1);const rejected=s.capture();
    return {list,invalid,start,end,rejected:rejected.type,current:s.current??null,ids:f.ids};
  });
  assert.equal(result.list.anchor.node,result.ids[4]);assert.equal(result.list.focus.node,result.ids[5]);assert.deepEqual(result.invalid,[null,null,null,null]);
  assert.equal(result.start.node,result.ids[0]);assert.equal(result.start.offset,0);assert.equal(result.end.node,result.ids[10]);assert.equal(result.end.offset,28);
  assert.equal(result.rejected,'unsupported');assert.equal(result.current,null);
}));

test('structural local and remote patches restore backward selection across replaced DOM',async()=>withContext('structure',async context=>{
  const page=await open(context);await page.evaluate(()=>window.selectionFixture.mount());
  const result=await page.evaluate(async()=>{
    const f=window.selectionFixture,r=f.renderer,old=r.getBlock(f.ids[1]),unrelated=r.getBlock(f.ids[10]);
    f.select(f.ids[1],6,f.ids[0],2);await f.format(f.ids[1],3);const heading=f.view();
    await f.remote(f.ids[0],0,'😀');const peer=f.view();
    await f.remoteCommand([{type:'outdent',owner:f.ids[4]},{type:'setParagraph',owner:f.ids[1]}]);
    return {heading,peer,after:f.view(),tag:r.getBlock(f.ids[1]).tagName,replaced:old!==r.getBlock(f.ids[1]),unrelated:unrelated===r.getBlock(f.ids[10])};
  });
  assert.equal(result.tag,'P');assert.equal(result.replaced,true);assert.equal(result.unrelated,true);
  assert.equal(result.heading.anchor.offset,6);assert.equal(result.heading.focus.offset,2);
  assert.equal(result.peer.anchor.offset,6);assert.equal(result.peer.focus.offset,4);assert.deepEqual(result.after.anchor,result.peer.anchor);assert.deepEqual(result.after.focus,result.peer.focus);
  assert.ok([result.heading,result.peer,result.after].every(v=>v.result.type==='restored'&&v.errors.length===0));
}));

test('remote deleted owner returns explicit stale endpoint without redirecting selection',async()=>withContext('deleted-owner',async context=>{
  const page=await open(context);await page.evaluate(()=>window.selectionFixture.mount());
  const state=await page.evaluate(()=>{
    const f=window.selectionFixture;f.select(f.ids[1],3,f.ids[2],2);
    window.deletedDOM=f.renderer.getBlock(f.ids[1]).firstChild;
    return {bytes:[...f.engine.encodeUpdate().bytes],vector:[...f.engine.stateVector()],id:f.ids[1]};
  });
  const peer=new Y.Doc();peer.clientID=1901;
  let update;
  try {Y.applyUpdate(peer,new Uint8Array(state.bytes));peer.getMap('delete-probe-tombstones').set(state.id,true);update=[...Y.encodeStateAsUpdate(peer,new Uint8Array(state.vector))];}finally{peer.destroy();}
  const result=await page.evaluate(async bytes=>{
    const f=window.selectionFixture;await f.apply(bytes);
    return {view:f.view(),old:f.selection.toModel(window.deletedDOM,0)??null,current:f.selection.current??null,exists:f.renderer.getBlock(f.ids[1])!==undefined};
  },update);
  assert.equal(result.view.result.type,'stale');assert.equal(result.view.result.anchor.type,'deleted');assert.equal(result.view.result.focus.type,'position');
  assert.equal(result.view.ranges,0);assert.equal(result.old,null);assert.equal(result.current,null);assert.equal(result.exists,false);assert.deepEqual(result.view.errors,[]);
}));

test('deleting selected characters collapses anchors to a surviving empty boundary',async()=>withContext('deleted-text',async context=>{
  const page=await open(context);await page.evaluate(()=>window.selectionFixture.mount());
  const result=await page.evaluate(async()=>{
    const f=window.selectionFixture,id=f.ids[1];f.select(id,6,id,1,{anchor:'right',focus:'left'});
    const a=f.engine.anchor(id,0,'left'),b=f.engine.anchor(id,7,'right');
    try{await f.command([{type:'delete',range:{anchor:a,focus:b}}]);}finally{f.engine.releaseAnchor(a);f.engine.releaseAnchor(b);}
    return {view:f.view(),text:f.renderer.getBlock(id).textContent};
  });
  assert.equal(result.text,'');assert.equal(result.view.anchor.offset,0);assert.equal(result.view.focus.offset,0);assert.equal(result.view.result.type,'restored');assert.deepEqual(result.view.errors,[]);
}));

test('split and join resolve stable anchors to derived and surviving owners',async()=>withContext('split-join',async context=>{
  const page=await open(context);await page.evaluate(()=>window.selectionFixture.mount());
  const result=await page.evaluate(async()=>{
    const f=window.selectionFixture,id=f.ids[1];f.select(id,6,id,2);
    const at=f.engine.anchor(id,3,'right');try{await f.command([{type:'split',owner:id,at}]);}finally{f.engine.releaseAnchor(at);}
    const split=f.view(),derived=split.anchor.node;
    await f.command([{type:'join',first:id,second:derived}]);return {split,joined:f.view(),id};
  });
  assert.notEqual(result.split.anchor.node,result.id);assert.equal(result.split.anchor.offset,3);assert.equal(result.split.focus.node,result.id);assert.equal(result.split.focus.offset,2);
  assert.equal(result.joined.anchor.node,result.id);assert.equal(result.joined.anchor.offset,6);assert.equal(result.joined.focus.offset,2);assert.deepEqual(result.joined.errors,[]);
}));

test('native keyboard selectionchange captures navigation without mutating the replica',async()=>withContext('native-navigation',async context=>{
  const page=await open(context);await page.evaluate(()=>window.selectionFixture.mount());
  const before=await page.evaluate(()=>window.selectionFixture.engine.read().revision);
  await page.locator('#projection h2').click();await page.keyboard.press('ArrowLeft');await page.keyboard.press('Shift+ArrowLeft');
  await page.waitForFunction(()=>{
    const f=window.selectionFixture,s=document.getSelection(),current=f.selection.current;
    if(!current||s.toString().length!==1)return false;
    const a=f.selection.toModel(s.anchorNode,s.anchorOffset),b=f.selection.toModel(s.focusNode,s.focusOffset);
    const anchor=f.engine.resolve(current.range.anchor),focus=f.engine.resolve(current.range.focus);
    return a&&b&&anchor.type==='position'&&focus.type==='position'&&a.node===anchor.node&&a.offset===anchor.offset&&b.node===focus.node&&b.offset===focus.offset;
  });
  const result=await page.evaluate(()=>({view:window.selectionFixture.view(),revision:window.selectionFixture.engine.read().revision}));
  assert.equal(result.revision,before);assert.equal(result.view.text.length,1);assert.deepEqual(result.view.errors,[]);
}));

test('outside selection is preserved and dispose releases anchors and subscription',async()=>withContext('ownership',async context=>{
  const page=await open(context);await page.evaluate(()=>window.selectionFixture.mount());
  const result=await page.evaluate(async()=>{
    const f=window.selectionFixture,s=f.selection;f.select(f.ids[1],2);const tokens=s.current.range;
    const outside=document.querySelector('#status').firstChild;document.getSelection().setBaseAndExtent(outside,0,outside,4);
    await f.remote(f.ids[1],0,'!');const view={text:document.getSelection().toString(),result:s.lastResult,current:s.current??null};
    let released=false;try{f.engine.resolve(tokens.anchor);}catch{released=true;}
    f.select(f.ids[1],2);const final=s.current.range;s.dispose();s.dispose();
    let disposed=false;try{f.engine.resolve(final.focus);}catch{disposed=true;}
    const old=s.lastResult;await f.edit(f.ids[1],0,'?');return {view,released,disposed,unchanged:old===s.lastResult,capture:s.capture().type,errors:f.engine.takeObserverErrors()};
  });
  assert.equal(result.view.text,'Proj');assert.equal(result.view.current,null);assert.equal(result.view.result.type,'outside');assert.equal(result.released,true);assert.equal(result.disposed,true);assert.equal(result.unchanged,true);assert.equal(result.capture,'unsupported');assert.deepEqual(result.errors,[]);
}));

test('surrogate-interior capture fails explicitly and releases the previous selection',async()=>withContext('invalid-unicode',async context=>{
  const page=await open(context);await page.evaluate(()=>window.selectionFixture.mount());
  const result=await page.evaluate(()=>{
    const f=window.selectionFixture;f.select(f.ids[0],5);const text=f.renderer.positions(f.ids[0]).at(-1).node;
    document.getSelection().setBaseAndExtent(text,1,text,1);
    const before=f.engine.read().revision;const captured=f.selection.capture();return {type:captured.type,reason:captured.reason,current:f.selection.current??null,revision:f.engine.read().revision,before};
  });
  assert.equal(result.type,'unsupported');assert.equal(result.current,null);assert.equal(result.revision,result.before);assert.ok(result.reason.length>0);
}));


test('retained async range survives peer edits and subsequent user selection changes',async()=>withContext('async-target',async context=>{
  const page=await open(context);await page.evaluate(()=>window.selectionFixture.mount());
  const result=await page.evaluate(async()=>{
    const f=window.selectionFixture,id=f.ids[1];f.select(id,2,id,4);
    const retained=f.selection.retain();
    await f.remote(id,0,'😀');f.select(f.ids[10],0);
    const before={anchor:f.engine.resolve(retained.range.anchor),focus:f.engine.resolve(retained.range.focus)};
    await f.command([{type:'replace',range:retained.range,text:'X'}]);
    const text=f.renderer.getBlock(id).textContent,current=f.view();
    retained.dispose();retained.dispose();let released=false;try{f.engine.resolve(retained.range.anchor);}catch{released=true;}
    const last=f.selection.retain();f.selection.dispose();
    return {before,text,current,id,outside:f.ids[10],released,active:retained.active,disposedActive:last.active};
  });
  assert.equal(result.before.anchor.node,result.id);assert.equal(result.before.anchor.offset,4);assert.equal(result.before.focus.offset,6);
  assert.equal(result.text,'😀HeXing');assert.equal(result.current.anchor.node,result.outside);assert.equal(result.current.anchor.offset,0);assert.deepEqual(result.current.errors,[]);
  assert.equal(result.released,true);assert.equal(result.active,false);assert.equal(result.disposedActive,false);
}));
