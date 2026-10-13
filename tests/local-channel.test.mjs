import assert from 'node:assert/strict';
import { test, after } from 'node:test';
import { readFile, writeFile, mkdir, mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { chromium } from 'playwright';
import { init } from '../packages/core/dist/index.js';
import { LocalChannel } from '../packages/web/dist/storage/local-channel.js';
const output = process.env.EDITAC_LOCAL_CHANNEL_OUTPUT ?? await mkdtemp(join(tmpdir(), 'editac-local-channel-'));
await mkdir(output, { recursive: true });
const facts = { cases: [], processes: [], scope: 'actual offline BroadcastChannel + IndexedDB + real WASM; prepared hosted peer only' };
function check(name, fn) { test(name, async () => { const c = { name, passed: false }; facts.cases.push(c); await fn(); c.passed = true; }); }
const runtime = await init('data:application/wasm;base64,' + (await readFile(new URL('../packages/core/dist/wasm/editac_wasm_bg.wasm', import.meta.url))).toString('base64'));
const seed = runtime.createEngine({ profile: 'v5', documentId: '45678901-4567-4567-8567-45678901abcd', epoch: '56789012-5678-4678-8678-56789012abcd', nodes: [{ text: '' }] });
const initial = seed.checkpoint(); seed.dispose();

check('prepared hints are bounded metadata, scoped, coalesced and echo suppressed', async () => {
 let listener, committed, calls = 0, posts = 0, closed = 0, removed = 0, unsubscribed = 0;
 const port = { addEventListener: (_, fn) => listener = fn, removeEventListener: (_, fn) => { assert.equal(fn, listener); removed++; }, close: () => closed++, postMessage: () => posts++ };
 const writer = { writerId: 7, engine: { checkpoint: () => initial } };
 const lifecycle = { subscribeCommitted: fn => { committed = fn; return () => unsubscribed++; }, catchUpLocal: async () => { calls++; return 1; } };
 const channel = new LocalChannel(runtime, writer, lifecycle, port);
 for (const data of [null, { type: 'editac-local-v1', scope: 'wrong', writer: 8 }, { type: 'editac-local-v1', scope: JSON.stringify(['v5','editac-blocks-v5',initial.identity.documentId,initial.identity.epoch,1,1,'utf16']), writer: 7 }, { bytes: new Uint8Array(100) }]) listener({ data });
 await Promise.resolve(); assert.equal(calls, 0);
 const { identityKey } = await import('../packages/web/dist/storage/journal.js');
 for (let i=0;i<100;i++) listener({ data: { type: 'editac-local-v1', scope: identityKey(initial.identity), writer: 8 } });
 await channel.catchUp(); assert.equal(calls, 1); assert.equal(posts, 0);
 committed({ writerId: 7 }); assert.equal(posts, 1);
 channel.dispose(); channel.dispose(); assert.equal(closed, 1); assert.equal(removed, 1); assert.equal(unsubscribed, 1);
 await assert.rejects(channel.catchUp(), /closed/);
});
check('prepared publication error retains retryable state and never claims save', async () => {
 let committed;
 const channel = new LocalChannel(runtime, { writerId: 7, engine: { checkpoint: () => initial } },
 { subscribeCommitted: fn => { committed = fn; return () => {}; }, catchUpLocal: async () => 0 },
 { addEventListener() {}, removeEventListener() {}, close() {}, postMessage() { throw Error('queue unavailable'); } });
 committed({ writerId: 7 }); assert.match(channel.error.message, /queue unavailable/);
 assert.throws(() => channel.notify(), /queue unavailable/); channel.dispose();
});
check('prepared disposal cancels an in-flight journal replay and releases observers', async () => {
 let release, started;const begun=new Promise(resolve=>started=resolve);const barrier=new Promise(resolve=>release=resolve);let applied=0;
 const channel=new LocalChannel(runtime,{writerId:7,engine:{checkpoint:()=>initial}},
 {subscribeCommitted:()=>()=>{},catchUpLocal:async(_,active)=>{started();await barrier;if(active())applied++;return applied;}},
 {addEventListener(){},removeEventListener(){},close(){},postMessage(){}});
 const work=channel.catchUp();await begun;channel.dispose();release();assert.equal(await work,0);assert.equal(applied,0);
});
let controller, browser, context, pages;
check('actual offline tabs deliver committed edits, concurrent checkpoints, restart, failed writes and hosted reconnect', async () => {
 controller = await chromium.launchServer({ headless: true }); const child = controller.process();
 facts.processes.push({ pid: child.pid, launcher: child.spawnfile, workspace: process.cwd(), purpose: 'CAP-1.6 actual local channel tabs', port: null, log: 'browser.log' });
 browser = await chromium.connect(controller.wsEndpoint()); facts.browser = { version: browser.version() }; context = await browser.newContext();
 await context.route('https://local-channel.test/**', async route => {
  const path = new URL(route.request().url()).pathname;
  if (path === '/') return route.fulfill({ contentType: 'text/html', body: '<!doctype html><title>Local delivery</title>' });
  if (path.includes('..') || !/^\/(core|web)\//.test(path)) return route.abort();
  const prefix = path.startsWith('/core/') ? '../packages/core/dist/' : '../packages/web/dist/';
  await route.fulfill({ contentType: path.endsWith('.wasm') ? 'application/wasm' : 'text/javascript', body: await readFile(new URL(prefix + path.replace(/^\/(core|web)\//, ''), import.meta.url)) });
 });
 pages = [await context.newPage(), await context.newPage()];
 const point = { ...initial, bytes: Array.from(initial.bytes) };
 async function open(page, index) {
  await page.goto('https://local-channel.test/');
  return page.evaluate(async ({ point, index }) => {
   const { init } = await import('/core/index.js');
   const { StorageWriter } = await import('/web/storage/writer.js');
   const { UpdateJournal } = await import('/web/storage/journal.js');
   const { UpdateOutbox } = await import('/web/storage/outbox.js');
   const { CheckpointStorage } = await import('/web/storage/checkpoint.js');
   const { LocalStorageLifecycle } = await import('/web/storage/index.js');
   const { LocalChannel } = await import('/web/storage/local-channel.js');
   const runtime = await init('/core/wasm/editac_wasm_bg.wasm'); point.bytes = new Uint8Array(point.bytes);
   const journal = await UpdateJournal.open(indexedDB, 'local-channel'), points = await CheckpointStorage.open(indexedDB, 'local-channel'), outbox = await UpdateOutbox.open(indexedDB, 'local-channel');
   if (index === 0) await points.publish(point, []);
   const { recovery: recovered } = await points.restore(point.identity, state => { const candidate=runtime.restoreEngine(point.identity,state.checkpoint,state.tail.map(e=>({identity:e.identity,bytes:e.bytes})));candidate.dispose();return true; });
   const writer = await StorageWriter.restore(runtime, navigator.locks, point.identity, recovered.checkpoint, recovered.tail.map(e=>({identity:e.identity,bytes:e.bytes})));
   const lifecycle = new LocalStorageLifecycle(writer, journal, { afterStorageFailure: 'reject' });
   const port = new BroadcastChannel('editac-local-channel-fixture'); let posted = 0;
   const nativePost = port.postMessage.bind(port); port.postMessage = message => { posted++; nativePost(message); };
   const channel = new LocalChannel(runtime, writer, lifecycle, port);
   window.fixture = { runtime, writer, lifecycle, journal, points, outbox, channel, point, port };
   window.text = () => writer.engine.read().visible[0].runs.map(r => r.text).join('');
   window.posted = () => posted;
   window.edit = async value => { const at = writer.engine.anchor(writer.engine.read().visible[0].id, 0, 'right'); try { lifecycle.commit({ kind: 'text', origin: 'local-channel:human', command: { type: 'insert', at, text: value } }); } finally { writer.engine.releaseAnchor(at); } await lifecycle.flush({ target: 'local' }); };
   await channel.catchUp(); return writer.writerId;
  }, { point, index });
 }
 const writers = [await open(pages[0], 0), await open(pages[1], 1)]; assert.notEqual(...writers);
 await context.setOffline(true);
 await pages[0].evaluate(() => window.edit('A'));
 await pages[1].waitForFunction(() => window.text() === 'A');
 assert.equal(await pages[1].evaluate(() => window.posted()), 0);
 assert.equal(await pages[0].evaluate(() => window.posted()), 1);
 assert.equal(await pages[1].evaluate(() => window.fixture.writer.engine.history({type:'state'}).undoGroups), 0);
 facts.offlineDelivery = { writers, receiverEchoes: 0, text: 'A' };
 // Disconnect local channels while both continue offline. A shared database is not live replay.
 for (const page of pages) await page.evaluate(() => window.fixture.channel.dispose());
 await Promise.all([pages[0].evaluate(() => window.edit('B')), pages[1].evaluate(() => window.edit('C'))]);
 assert.notEqual(await pages[0].evaluate(() => window.text()), await pages[1].evaluate(() => window.text()));
 for (const page of pages) await page.evaluate(async () => { const { LocalChannel } = await import('/web/storage/local-channel.js'); const f=window.fixture; f.channel=new LocalChannel(f.runtime,f.writer,f.lifecycle,new BroadcastChannel('editac-local-channel-fixture')); await f.channel.catchUp(); });
 const expected = await pages[0].evaluate(() => window.text()); assert.equal(await pages[1].evaluate(() => window.text()), expected); assert.equal(expected.length, 3);
 // Force both checkpoint reads to finish before either writer publishes.
 let raced=0,releaseRace; const raceBarrier=new Promise(resolve=>releaseRace=resolve);
 await context.exposeFunction('checkpointRace',async()=>{if(++raced===2)releaseRace();await raceBarrier;});
 for(const page of pages)await page.evaluate(()=>{
  const native=IDBDatabase.prototype.transaction;
  IDBDatabase.prototype.transaction=function(...args){const tx=native.apply(this,args);if(window.racing&&Array.isArray(args[0])&&args[0].includes('checkpoints')&&args[1]==='readonly'){Object.defineProperty(tx,'oncomplete',{set(fn){tx.addEventListener('complete',async()=>{await window.checkpointRace();fn();});}});}return tx;};
  window.racing=true;
 });
 // Concurrent publication: one CAS wins, one fails, explicit retry includes all committed entries.
 const checkpoints = await Promise.all(pages.map(page => page.evaluate(async () => { const f=window.fixture; const entries=await f.journal.read(f.point.identity); try { await f.points.publish(f.writer.engine.checkpoint(), entries.map(e=>e.updateId)); return 'committed'; } catch (e) { if(e.name==='CheckpointConflictError') return 'conflict'; throw e; } })));
 assert.deepEqual([...checkpoints].sort(), ['committed','conflict']);
 for(const page of pages)await page.evaluate(()=>{window.racing=false;});
 for (const page of pages) assert.equal(await page.evaluate(async () => (await window.fixture.outbox.pending(window.fixture.point.identity)).length), 3);
 facts.concurrent = { expected, checkpoints, pending: 3 };
 // A hosted peer remains prepared, using the actual independent Rust engine and replay boundary.
 const peerResult = await pages[0].evaluate(async () => {
  const f=window.fixture;
  // Qualify the complete retained tail together: per-writer journal order is not causal order.
  const entries=await f.journal.read(f.point.identity);
  const peer=f.runtime.restoreEngine(f.point.identity,f.point,entries.map(entry=>({identity:entry.identity,bytes:entry.bytes}))); let incoming;
  const sub=peer.subscribe({type:'updates'},p=>{if(p.update)incoming={identity:p.identity,writerId:p.writerId,sequence:p.sequence,origin:p.origin,bytes:p.update.bytes};});
  const at=peer.anchor(peer.read().visible[0].id,0,'right');const plan=peer.prepare({kind:'text',origin:'local-channel:hosted',command:{type:'insert',at,text:'H'}});peer.commit(plan);peer.releasePlan(plan);peer.releaseAnchor(at);sub.dispose();
  await f.journal.append(incoming);f.channel.notify();await f.channel.catchUp();
  const result=peer.read().visible[0].runs.map(r=>r.text).join('');peer.dispose();return result;
 });
 await pages[1].waitForFunction(expected => window.text() === expected, peerResult);assert.equal(await pages[0].evaluate(()=>window.text()),peerResult); assert.equal(peerResult.length,4);
 facts.reconnect = { expected: peerResult, pending: 4, providerCalls: 0 };
 // Restart a tab while offline using retained initialized state and full journal.
 const oldWriter=writers[1]; await pages[1].close(); pages[1]=await context.newPage();
 await open(pages[1], 1); const newWriter=await pages[1].evaluate(()=>window.fixture.writer.writerId);assert.notEqual(oldWriter,newWriter);assert.equal(await pages[1].evaluate(()=>window.text()),peerResult);
 facts.restart={oldWriter,newWriter,text:peerResult};
 // Failed actual IndexedDB transaction is retained as unsaved recovery, with no peer notification.
 const failure = await pages[0].evaluate(async () => {
  const f=window.fixture;let signals=0;const remove=f.lifecycle.subscribeCommitted(()=>signals++);
  const original=IDBDatabase.prototype.transaction;
  IDBDatabase.prototype.transaction=function(...args){const tx=original.apply(this,args);if(args[1]==='readwrite')queueMicrotask(()=>tx.abort());return tx;};
  try { await window.edit('X'); throw Error('unexpected success'); } catch(error) { return {error:error.name,signals,phase:f.lifecycle.state.phase,unsaved:f.lifecycle.recoveryExport().unsavedUpdates.length}; }
  finally { IDBDatabase.prototype.transaction=original;remove(); }
 });
 assert.equal(failure.signals,0);assert.equal(failure.phase,'error');assert.equal(failure.unsaved,1);
 assert.equal(await pages[1].evaluate(()=>window.text()),peerResult);facts.failedTransaction=failure;
 for(const page of pages)await page.evaluate(async()=>{const f=window.fixture;f.channel.dispose();await f.lifecycle.destroy({policy:'report'});f.points.close();f.outbox.close();});
 assert.equal((await pages[1].evaluate(()=>navigator.locks.query())).held.length,0);
});
after(async () => {
 try { await context?.close(); await browser?.close(); } finally { await controller?.close(); facts.teardown={browserClosed:!browser?.isConnected(),browserProcessExited:!controller||controller.process().exitCode!==null,fixtureServersStarted:0}; await writeFile(join(output,'harness.json'),JSON.stringify(facts,null,2)); }
});
