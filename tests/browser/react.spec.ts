import assert from 'node:assert/strict';
import { test } from 'node:test';
import { build } from 'esbuild';
import { mkdir, copyFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { browserHarness } from './browser-harness.ts';
const {probe} = browserHarness('react', 'fixtures/browser-react', {
  autoMount:false, packages:['core','web','react'],
  async prepareConsumer(consumer) {
    const fixture = join(consumer, 'fixture'); await mkdir(fixture);
    await copyFile('fixtures/browser-react/index.html', join(fixture, 'index.html'));
    await build({entryPoints:['fixtures/browser-react/client.mjs'], outfile:join(fixture,'client.js'), bundle:true, format:'esm', platform:'browser',
      alias:{'@edit-ac/react':join(consumer,'react/package/dist/index.js')},
      nodePaths:[resolve('node_modules')], external:['@edit-ac/core','@edit-ac/web','/web/*'],
      define:{'process.env.NODE_ENV':'"development"'}, sourcemap:false});
    return fixture;
  },
});
async function ready(page, count=1) { await page.waitForFunction(count=>window.reactFixture?.facts.ready>=count, count); }
async function disposed(page, count=1) { await page.waitForFunction(count=>window.reactFixture.facts.disposed>=count, count); }
async function state(page) { return page.evaluate(()=>({...window.reactFixture.facts, text:window.reactFixture.text(), phase:window.reactFixture.editor.state.phase})); }

test('StrictMode mounts one real replica; typing and selection stay outside React document rendering',()=>probe('react-input',async(page,fact)=>{
  await ready(page);
  const before=await page.evaluate(()=>{const f=window.reactFixture; window.originalBlock=f.editor.root.firstChild; f.select(5); return {...f.facts,revision:f.editor.read().revision};});
  await page.keyboard.type('!');
  await page.evaluate(async()=>{const f=window.reactFixture; f.select(1,4); await f.editor.flush({target:'local'});});
  const after=await page.evaluate(()=>{const f=window.reactFixture;return {...f.facts,text:f.text(),revision:f.editor.read().revision, sameBlock:window.originalBlock===f.editor.root.firstChild,selection:document.getSelection().toString()};});
  assert.deepEqual(after.text,['alpha!']); assert.equal(after.revision,before.revision+1);
  assert.equal(after.renders,before.renders); assert.equal(after.sameBlock,true); assert.equal(after.selection,'lph');
  assert.equal(after.recoveries,1); assert.equal(after.live,1); assert.equal(after.peak,1); assert.ok(after.statusRenders>=before.statusRenders);
  fact.snapshots.push({before,after});
}));

test('unmount flushes then remounts a new host without duplicate handles or content loss',()=>probe('react-remount',async(page,fact)=>{
  await ready(page); await page.evaluate(()=>window.reactFixture.select(5)); await page.keyboard.type(' saved');
  await page.evaluate(()=>{window.reactFixture.slowSave(); window.reactFixture.unmount(); window.reactFixture.render();});
  await page.waitForFunction(()=>window.reactFixture.editor.state.phase==='closing');
  const pending=await page.evaluate(()=>({...window.reactFixture.facts})); assert.equal(pending.recoveries,1); assert.equal(pending.live,1);
  await page.evaluate(()=>window.reactFixture.releaseSave()); await ready(page,2);
  const after=await state(page); assert.deepEqual(after.text,['alpha saved']); assert.equal(after.disposed,1); assert.equal(after.live,1); assert.equal(after.peak,1); assert.equal(after.recoveries,2);
  assert.equal(await page.locator('[role="status"]').count(),1); assert.deepEqual(after.errors,[]);
  await page.evaluate(()=>window.reactFixture.select(11)); await page.keyboard.type('!');
  assert.deepEqual((await state(page)).text,['alpha saved!']); fact.snapshots.push({pending,after});
}));

test('explicit options replacement waits for disposal and changes only the selected document',()=>probe('react-options',async(page,fact)=>{
  await ready(page); await page.evaluate(()=>{window.reactFixture.slowSave();window.reactFixture.render(1);});
  await page.waitForFunction(()=>window.reactFixture.editor.state.phase==='closing');
  assert.equal(await page.evaluate(()=>window.reactFixture.facts.recoveries),1);
  await page.evaluate(()=>window.reactFixture.releaseSave()); await ready(page,2);
  const after=await state(page); assert.deepEqual(after.text,['beta']); assert.equal(after.live,1); assert.equal(after.peak,1);
  await page.evaluate(()=>window.reactFixture.render(0)); await ready(page,3); assert.deepEqual((await state(page)).text,['alpha']);
  fact.snapshots.push(after);
}));

test('read-only prop changes input authority without recreating the document',()=>probe('react-read-only',async(page,fact)=>{
  await ready(page); await page.evaluate(()=>{window.sameEngine=window.reactFixture.editor;window.reactFixture.render(0,{readOnly:true});});
  await page.waitForFunction(()=>window.reactFixture.editor.state.readOnly);
  assert.equal(await page.locator('[data-host]').getAttribute('contenteditable'),'false');
  await page.evaluate(()=>window.reactFixture.render(0,{readOnly:false})); await page.waitForFunction(()=>!window.reactFixture.editor.state.readOnly);
  const result=await page.evaluate(()=>({same:window.sameEngine===window.reactFixture.editor,...window.reactFixture.facts}));
  assert.equal(result.same,true); assert.equal(result.recoveries,1); assert.equal(result.disposed,0); fact.snapshots.push(result);
}));

test('initialization failure remains read-only and observable; the host can dispose and recover',()=>probe('react-load-failure',async(page,fact)=>{
  await ready(page); await page.evaluate(()=>window.reactFixture.render(0,{failInit:true}));
  await page.waitForFunction(()=>window.reactFixture.facts.errors.includes('prepared recovery failure'));
  assert.equal(await page.locator('[data-host]').getAttribute('contenteditable'),'false');
  assert.match(await page.locator('[role="alert"]').textContent(),/Unable|failed|recover/i);
  await page.evaluate(()=>window.reactFixture.render()); await ready(page,2);
  const after=await state(page); assert.deepEqual(after.text,['alpha']); assert.equal(after.live,1); fact.snapshots.push(after);
}));

test('unmount during asynchronous recovery cancels attachment and releases the late replica',()=>probe('react-cancel-loading',async(page,fact)=>{
  await ready(page); await page.evaluate(()=>window.reactFixture.unmount()); await disposed(page);
  await page.evaluate(()=>{window.reactFixture.slowRecovery();window.reactFixture.render(0,{hook:true});});
  await page.waitForFunction(()=>window.reactFixture.facts.recoveries===2);
  await page.evaluate(()=>window.reactFixture.unmount());
  await page.evaluate(()=>window.reactFixture.releaseRecovery()); await disposed(page,2);
  const result=await page.evaluate(()=>({...window.reactFixture.facts,hosts:document.querySelectorAll('[data-host]').length}));
  assert.equal(result.live,0); assert.equal(result.hosts,0); assert.equal(result.ready,1); assert.deepEqual(result.errors,[]);
  await page.evaluate(()=>window.reactFixture.render(0,{hook:true})); await ready(page,2);
  assert.deepEqual((await state(page)).text,['alpha']); fact.snapshots.push(result);
}));

test('cleanup save failure reports the error and explicit recovery outcome and still releases the replica',()=>probe('react-save-failure',async(page,fact)=>{
  await ready(page); await page.evaluate(()=>{window.reactFixture.failSave();window.reactFixture.unmount();}); await disposed(page);
  await page.waitForFunction(()=>window.reactFixture.facts.reports.length===1);
  const result=await page.evaluate(()=>({...window.reactFixture.facts}));
  assert.deepEqual(result.errors,['prepared local save failure']); assert.equal(result.live,0); assert.equal(result.reports.length,1); assert.equal(typeof result.reports[0].unsaved,'boolean');
  fact.snapshots.push(result);
}));
