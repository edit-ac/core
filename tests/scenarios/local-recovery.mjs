import assert from 'node:assert/strict';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { chromium } from 'playwright';
import { requireTestNode } from '../../scripts/test-toolchain.mjs';
import { startFixtureServer } from '../browser/fixture-server.mjs';
import { loadScenario, validateScenario, root } from './run.mjs';
import { prepareProductHarness, sha } from './harness.mjs';
await requireTestNode();
const { manifest, scenario } = await loadScenario('web-local-recovery');
const output = resolve(root, '../architecture/evidence/browser-product-workflows-20261018/pwe-1.4', new Date().toISOString().replace(/[:.]/g, '-'));
await mkdir(output, { recursive: true });
const facts = { parent: scenario.parent, scenario: 'web-local-recovery', command: ['node', 'tests/scenarios/run.mjs', 'web-local-recovery'], output, profile: manifest.profile, commands: [], cases: [], processes: [], teardown: [], scope: manifest.scope };
let server, controller, browser, activePage;
async function teardown() {
  for (const [name, resource] of [['browser connection', browser], ['Chromium controller', controller], ['fixture listener', server]]) {
    if (!resource) continue;
    try { await resource.close(); facts.teardown.push(name + ' closed'); }
    catch (error) { facts.teardown.push(name + ': ' + error.message); process.exitCode = 1; }
  }
  browser = controller = server = undefined;
}
for (const signal of ['SIGINT', 'SIGTERM']) process.once(signal, () => {
  void teardown().finally(() => process.exit(signal === 'SIGINT' ? 130 : 143));
});
async function check(id, run) {
  try { await run(); facts.cases.push({ id, status: 'passed' }); }
  catch (error) { facts.cases.push({ id, status: 'failed', error: error.stack }); throw error; }
}
const text = (page, name='task') => page.evaluate(async name => {
  const slot = (await import('/fixture/editor.mjs'))[name];
  return slot.editor.read().visible.flatMap(n=>n.runs?.map(r=>r.text)??[]).join('');
}, name);
try {
  await check('dispatcher-rejects-invalid-inputs', async()=>{
    assert.throws(()=>validateScenario(manifest,'unknown-task'), /Unknown scenario/);
    for(const patch of [{command:[]},{cases:[]},{fixtures:[]}]) assert.throws(()=>validateScenario({scenarios:{broken:{...scenario,...patch}}},'broken'));
    const file=join(output,'missing-fixture.json');
    await writeFile(file,JSON.stringify({scenarios:{broken:{...scenario,fixtures:['fixtures/product-scenarios/web/absent.json']}}}));
    await assert.rejects(loadScenario('broken',file),/ENOENT/);
    await writeFile(file,JSON.stringify({scenarios:{broken:{...scenario,command:['node','tests/scenarios/absent.mjs']}}}));
    await assert.rejects(loadScenario('broken',file),/ENOENT/);
  });
  const {site}=await prepareProductHarness(output,facts,scenario);
  server=await startFixtureServer({fixtureDirectory:join(site,'fixture'),coreDirectory:join(site,'core'),webDirectory:join(site,'web'),recordRequests:true});
  facts.processes.push({pid:process.pid,launcher:process.execPath,workspace:root,port:server.port,purpose:'PWE-1.4 installed SDK fixture',log:join(output,'receipt.json')});
  controller=await chromium.launchServer({headless:true});
  facts.processes.push({pid:controller.process().pid,launcher:controller.process().spawnfile,workspace:root,purpose:'PWE-1.4 Chromium',log:join(output,'receipt.json')});
  browser=await chromium.connect(controller.wsEndpoint());facts.browserVersion=browser.version();
  const page=activePage=await browser.newPage(), errors=[];page.setDefaultTimeout(8000);page.on('pageerror',e=>errors.push(e.message));
  const ready=async(target=page,suffix='')=>{await target.goto(server.url+suffix);await target.evaluate(async()=>{await (await import('/fixture/editor.mjs')).ready;});};
  const select=async(selector,all=false)=>{await page.locator(selector+' [data-node-id]').first().click();await page.keyboard.press(all?'Meta+a':'End');};
  const settle=async()=>page.evaluate(async()=>{const m=await import('/fixture/editor.mjs');await Promise.all([m.task.editor.settle(),m.comment.editor.settle()]);});
  await ready(page,'/fixture/index.html');
  const snapshot=async(name='task',target=page)=>target.evaluate(async name=>{
    const m=await import('/fixture/editor.mjs'),slot=m[name];
    return {identity:slot.options.identity,text:slot.editor.read().visible.flatMap(n=>n.runs?.map(r=>r.text)??[]).join(''),events:slot.events,state:slot.editor.state};
  },name);
  const append=async(name,value)=>{await select(name==='task'?'#editor':'#comment');await page.keyboard.type(value);await settle();};
  const moduleCall=async(method,...args)=>page.evaluate(async({method,args})=>(await import('/fixture/editor.mjs'))[method](...args),{method,args});
  await check('independent-local-commits',async()=>{
    await append('task',' task local');await append('comment',' comment local');
    await page.locator('#save').click();await page.locator('#comment-save').click();
    await page.waitForFunction(async()=>{const m=await import('/fixture/editor.mjs');return m.task.events.save.length&&m.comment.events.save.length;});
    const task=await snapshot(),comment=await snapshot('comment');
    assert.notEqual(task.identity.documentId,comment.identity.documentId);
    assert.equal(task.events.error.length,0);assert.equal(comment.events.error.length,0);
    const counts=await page.evaluate(async()=>{const {inspectDatabase}=await import('/fixture/local-faults.mjs');return Promise.all(['standalone-task','example-comment'].map(inspectDatabase));});
    assert.ok(counts.every(c=>c.checkpoints===1&&c.updates>0));facts.storeCounts=counts;
    await moduleCall('close');await ready(page,'/fixture/index.html');
    assert.equal(await text(page),task.text);assert.equal(await text(page,'comment'),comment.text);
    assert.deepEqual((await snapshot()).identity,task.identity);assert.deepEqual((await snapshot('comment')).identity,comment.identity);
  });
  await check('offline-shell-reload-reopen',async()=>{
    await page.locator('#prepare-offline').click();
    await page.waitForFunction(()=>document.querySelector('#offline-message').dataset.state==='ready');
    await page.waitForFunction(()=>!!navigator.serviceWorker.controller);
    const before=[await text(page),await text(page,'comment')];
    const requestCount=server.requests.length;
    await page.context().setOffline(true);
    await moduleCall('close');await page.reload();await page.evaluate(async()=>{await(await import('/fixture/editor.mjs')).ready;});
    assert.equal(await page.evaluate(()=>navigator.onLine),false);
    assert.deepEqual([await text(page),await text(page,'comment')],before);
    await append('task',' offline task');await append('comment',' offline comment');
    await moduleCall('saveLocally');await page.evaluate(async()=>(await import('/fixture/editor.mjs')).comment.save());
    const offline=[await text(page),await text(page,'comment')];
    await moduleCall('reopenOffline');await moduleCall('reopenOffline','comment');
    assert.deepEqual([await text(page),await text(page,'comment')],offline);
    await moduleCall('close');await page.reload();await page.evaluate(async()=>{await(await import('/fixture/editor.mjs')).ready;});
    assert.deepEqual([await text(page),await text(page,'comment')],offline);
    await page.screenshot({path:join(output,'offline-reopened.png'),fullPage:true});
    assert.equal(server.requests.length,requestCount,'Offline workflow reached HTTP listener');
    facts.offline={navigatorOnline:false,serverRequestsBefore:requestCount,serverRequestsAfter:server.requests.length,restoredDocuments:2};
    await page.context().setOffline(false);
  });
  await check('pending-and-local-status',async()=>{
    await page.evaluate(()=>{
      window.statusChanges=[];
      window.statusObserver=new MutationObserver(records=>{for(const record of records)if(record.type==='attributes')window.statusChanges.push(record.oldValue);window.statusChanges.push(document.querySelector('#message').dataset.state);});
      window.statusObserver.observe(document.querySelector('#message'),{attributes:true,attributeOldValue:true,attributeFilter:['data-state']});
    });
    await append('task',' pending proof');await moduleCall('saveLocally');
    const transitions=await page.evaluate(()=>{window.statusObserver.disconnect();return window.statusChanges;});
    assert.ok(transitions.includes('pending'));assert.equal(await page.locator('#message').getAttribute('data-state'),'local');
    assert.match(await page.locator('#message').textContent(),/Saved locally.*Remote durability is not confirmed/);facts.statusTransitions=transitions;
  });
  await check('readonly-revocation-preserves-content',async()=>{
    const before=await text(page);await select('#editor');
    const result=await page.evaluate(async()=>{const {task}=await import('/fixture/editor.mjs');const target=task.editor.captureCommand('replace');(await import('/fixture/editor.mjs')).revokeEditing('task');const result=target?.execute('DENIED');target?.dispose();return result;});
    assert.equal(result.disposition,'rejected');await page.keyboard.type('DENIED');assert.equal(await text(page),before);
    await moduleCall('saveLocally');await moduleCall('reopenOffline');assert.equal(await text(page),before);assert.equal((await snapshot()).state.readOnly,true);await page.keyboard.type('STILL-DENIED');assert.equal(await text(page),before);
    const readonly=await browser.newPage();await ready(readonly,'/fixture/index.html?readonly');
    assert.equal(await readonly.locator('[contenteditable="true"]').count(),0);
    assert.ok((await readonly.evaluate(async()=>{const m=await import('/fixture/editor.mjs');return [m.task.editor.state,m.comment.editor.state];})).every(s=>s.readOnly));
    await readonly.evaluate(async()=>(await import('/fixture/editor.mjs')).close());await readonly.close();
    await moduleCall('close');await ready(page,'/fixture/index.html');
  });
  let unsavedTask,siblingText,failedSaveCount,downloads=0;
  page.on('download',()=>downloads++);
  await check('append-failure-keeps-live-replica',async()=>{
    failedSaveCount=(await snapshot()).events.save.length;
    await page.evaluate(async()=>{const {installFault}=await import('/fixture/local-faults.mjs');window.removeFault=installFault({databaseName:'standalone-task'});});
    await append('task',' UNSAVED-TASK-ONLY');unsavedTask=await text(page);
    await page.waitForFunction(()=>document.querySelector('#message').dataset.state==='error');
    const result=await page.evaluate(async()=>{const m=await import('/fixture/editor.mjs');const original=m.editor;let saveFailed=false,reopenFailed=false;try{await m.saveLocally();}catch{saveFailed=true;}try{await m.reopenOffline();}catch{reopenFailed=true;}return{saveFailed,reopenFailed,sameEditor:original===m.editor,recovery:m.editor.recoveryExport().unsavedUpdates.length};});
    assert.equal(result.saveFailed,true);assert.equal(result.reopenFailed,true);assert.equal(result.sameEditor,true);assert.ok(result.recovery>0);
    assert.equal((await snapshot()).events.save.length,failedSaveCount);assert.equal(await text(page),unsavedTask);
    assert.match(await page.locator('#message').textContent(),/error:.*Export recovery/);
    await append('comment',' SIBLING-PRIVATE');await page.evaluate(async()=>(await import('/fixture/editor.mjs')).comment.save());siblingText=await text(page,'comment');
    assert.equal((await snapshot('comment')).events.error.length,0);assert.equal(downloads,0);
    await page.screenshot({path:join(output,'failed-local-save.png'),fullPage:true});
  });
  const recoveryDownload=async(selector,label)=>{
    const waiting=page.waitForEvent('download');await page.locator(selector).click();const download=await waiting;
    const path=join(output,label+'.json');await download.saveAs(path);const bytes=await readFile(path);
    facts.recoveryDownloads??=[];facts.recoveryDownloads.push({path:label+'.json',sha256:sha(bytes),bytes:bytes.length});
    return bytes.toString();
  };
  const decodeRecovery=async json=>page.evaluate(async json=>{
    const records=JSON.parse(json,(_key,value)=>value?.encoding==='bytes'?Uint8Array.from(value.data):value);
    const {init}=await import('@edit-ac/core'),runtime=await init('/core/wasm/editac_wasm_bg.wasm');
    return records.map(record=>{const recovery=record.recovery??record;const engine=runtime.restoreEngine(recovery.checkpoint.identity,recovery.checkpoint,[]);try{return{identity:engine.read().identity,text:engine.read().visible.flatMap(n=>n.runs?.map(r=>r.text)??[]).join(''),unsavedUpdates:recovery.unsavedUpdates.length};}finally{engine.dispose();}});
  },json);
  await check('deliberate-isolated-recovery-export',async()=>{
    const task=await decodeRecovery(await recoveryDownload('#export-recovery','task-live-recovery'));
    assert.ok(task.length>0);const taskId=(await snapshot()).identity.documentId;assert.ok(task.every(r=>r.identity.documentId===taskId));
    assert.ok(task.some(r=>r.text===unsavedTask&&r.unsavedUpdates>0));assert.ok(task.every(r=>!r.text.includes('SIBLING-PRIVATE')));
    const comment=await decodeRecovery(await recoveryDownload('#comment-export-recovery','comment-live-recovery'));
    assert.ok(comment.every(r=>r.text===siblingText&&!r.text.includes('UNSAVED-TASK-ONLY')));assert.equal(downloads,2);
  });
  await check('close-retains-unsaved-recovery',async()=>{
    await page.locator('#dispose-task').click();await page.waitForFunction(async()=>(await import('/fixture/editor.mjs')).task.editor.state.phase==='destroyed');
    assert.equal(downloads,2);assert.equal(await text(page,'comment'),siblingText);
    const records=await decodeRecovery(await recoveryDownload('#export-recovery','task-closed-recovery'));
    assert.ok(records.some(r=>r.text===unsavedTask&&r.unsavedUpdates>0));assert.ok(records.every(r=>!r.text.includes('SIBLING-PRIVATE')));
    await page.evaluate(()=>window.removeFault());await moduleCall('reopenOffline');
    assert.notEqual(await text(page),unsavedTask);assert.equal(await text(page,'comment'),siblingText);
    const retained=await decodeRecovery(await recoveryDownload('#export-recovery','task-reopened-retained-recovery'));
    assert.ok(retained.some(r=>r.text===unsavedTask));
  });
  await check('creation-denial-never-reseeds',async()=>{
    const context=await browser.newContext(),denied=await context.newPage();
    await denied.addInitScript(()=>{const original=IDBFactory.prototype.open;IDBFactory.prototype.open=function(name,...args){if(window.denyCreation!==false&&name==='standalone-task')throw new DOMException('Prepared initial storage denial','SecurityError');return original.call(this,name,...args);};});
    await denied.goto(server.url+'/fixture/index.html');
    await denied.evaluate(async()=>{try{await(await import('/fixture/editor.mjs')).ready;}catch{}});
    const identity=await denied.evaluate(()=>JSON.parse(localStorage.getItem('standalone-task-identity')));assert.ok(identity.documentId);
    assert.doesNotMatch(await denied.locator('#message').textContent(),/Saved locally/);
    assert.equal(await denied.evaluate(async()=>(await import('/fixture/editor.mjs')).comment.editor.state.ready),true);
    await denied.evaluate(()=>{window.denyCreation=false;});
    const outcome=await denied.evaluate(async()=>{const {localOptions}=await import('/fixture/document.mjs'),{createEditor}=await import('@edit-ac/web');const root=document.createElement('div');document.body.append(root);const editor=createEditor(root,await localOptions('task',undefined,{databaseName:'standalone-task',key:'standalone-task-identity',text:'REPLACEMENT'}));let message;try{await editor.ready;}catch(error){message=error.message;}await editor.destroy({policy:'report'});return{message,identity:JSON.parse(localStorage.getItem('standalone-task-identity')),text:root.textContent};});
    assert.match(outcome.message,/missing checkpoint/);assert.deepEqual(outcome.identity,identity);assert.doesNotMatch(outcome.text,/REPLACEMENT/);
    await denied.evaluate(async()=>(await import('/fixture/editor.mjs')).close());await context.close();
  });
  await check('existing-open-denial-preserves-content',async()=>{
    const before=await snapshot();await moduleCall('close');
    await page.evaluate(async()=>{const {installFault}=await import('/fixture/local-faults.mjs');window.removeFault=installFault({databaseName:'standalone-task',operation:'open'});});
    const failed=await page.evaluate(async()=>{try{await(await import('/fixture/editor.mjs')).reopenOffline();return false;}catch{return true;}});assert.equal(failed,true);
    assert.equal((await snapshot('comment').catch(()=>null)),null); // sibling was explicitly closed, never erased
    await page.evaluate(()=>window.removeFault());await moduleCall('reopenOffline');await moduleCall('reopenOffline','comment');
    assert.equal(await text(page),before.text);assert.deepEqual((await snapshot()).identity,before.identity);assert.equal(await text(page,'comment'),siblingText);
  });
  for(const kind of ['missing','corrupt'])await check(kind+'-checkpoint-never-reseeds',async()=>{
    const context=await browser.newContext(),damaged=await context.newPage();await ready(damaged,'/fixture/index.html');
    const identity=await damaged.evaluate(async kind=>{const m=await import('/fixture/editor.mjs');const identity=m.task.options.identity;await m.close();await(await import('/fixture/local-faults.mjs')).damageCheckpoint('standalone-task',kind);return identity;},kind);
    await damaged.reload();await damaged.evaluate(async()=>{try{await(await import('/fixture/editor.mjs')).ready;}catch{}});
    assert.match(await damaged.locator('#message').textContent(),kind==='missing'?/missing checkpoint/:/No valid recovery checkpoint/);
    assert.doesNotMatch(await damaged.locator('#message').textContent(),/Saved locally/);
    assert.deepEqual(await damaged.evaluate(()=>JSON.parse(localStorage.getItem('standalone-task-identity'))),identity);
    assert.equal(await damaged.evaluate(async()=>(await import('/fixture/editor.mjs')).comment.editor.state.ready),true);
    const counts=await damaged.evaluate(async()=>(await import('/fixture/local-faults.mjs')).inspectDatabase('standalone-task'));assert.equal(counts.checkpoints,kind==='missing'?0:1);assert.equal(counts.updates,0);
    await damaged.screenshot({path:join(output,kind+'-checkpoint.png'),fullPage:true});await damaged.evaluate(async()=>(await import('/fixture/editor.mjs')).close());await context.close();
  });
  assert.deepEqual(errors,[]);assert.deepEqual(new Set(facts.cases.map(c=>c.id)),new Set(scenario.cases));
} catch (error) {
  facts.failure = error.stack; process.exitCode = 1;
  if (activePage) {
    try { facts.failureState = await activePage.evaluate(async () => ({ message: document.querySelector('#message')?.textContent, state: (await import('/fixture/editor.mjs')).editor?.state })); await activePage.screenshot({ path: join(output, 'failure.png'), fullPage: true }); }
    catch (diagnostic) { facts.diagnosticError = diagnostic.message; }
  }
}
finally {
  if (server) facts.requests = server.requests;
  await teardown();
  facts.counts = { executed: facts.cases.length, passed: facts.cases.filter(c => c.status === 'passed').length, failed: facts.cases.filter(c => c.status === 'failed').length, skipped: Math.max(0, scenario.cases.length - facts.cases.length), required: scenario.cases.length };
  if (facts.failure && facts.counts.failed === 0) facts.setupFailure = true;
  if (facts.counts.executed !== facts.counts.required) process.exitCode = 1;
  facts.exit = process.exitCode ?? 0;
  await writeFile(join(output, 'manifest.json'), JSON.stringify({ ...manifest, resolved: { sourceRevision: facts.sourceRevision, sourceTree: facts.sourceTree, sources: facts.sources, packs: facts.packs, browserVersion: facts.browserVersion, artifacts: facts.artifacts } }, null, 2));
  facts.manifestSha256 = sha(await readFile(join(output, 'manifest.json')));
  await writeFile(join(output, 'receipt.json'), JSON.stringify(facts, null, 2));
  console.log(JSON.stringify({ output, counts: facts.counts, exit: facts.exit, failure: facts.failure?.split('\n').slice(0,3) }));
}
