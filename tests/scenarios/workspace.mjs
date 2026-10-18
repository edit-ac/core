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
const { manifest, scenario } = await loadScenario('web-task-workspace');
const output = resolve(root, '../architecture/evidence/browser-product-workflows-20261018/pwe-1.2', new Date().toISOString().replace(/[:.]/g, '-'));
await mkdir(output, { recursive: true });
const facts = { parent: scenario.parent, scenario: 'web-task-workspace', command: ['node', 'tests/scenarios/run.mjs', 'web-task-workspace'], output, profile: manifest.profile, commands: [], cases: [], processes: [], teardown: [], scope: manifest.scope };
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
  facts.processes.push({pid:process.pid,launcher:process.execPath,workspace:root,port:server.port,purpose:'PWE-1.2 installed SDK fixture',log:join(output,'receipt.json')});
  controller=await chromium.launchServer({headless:true});
  facts.processes.push({pid:controller.process().pid,launcher:controller.process().spawnfile,workspace:root,purpose:'PWE-1.2 Chromium',log:join(output,'receipt.json')});
  browser=await chromium.connect(controller.wsEndpoint());facts.browserVersion=browser.version();
  const page=activePage=await browser.newPage(), errors=[];page.setDefaultTimeout(8000);page.on('pageerror',e=>errors.push(e.message));
  const ready=async(target=page,suffix='')=>{await target.goto(server.url+suffix);await target.evaluate(async()=>{await (await import('/fixture/editor.mjs')).ready;});};
  const select=async(selector,all=false)=>{await page.locator(selector+' [data-node-id]').first().click();await page.keyboard.press(all?'Meta+a':'End');};
  const settle=async()=>page.evaluate(async()=>{const m=await import('/fixture/editor.mjs');await Promise.all([m.task.editor.settle(),m.comment.editor.settle()]);});
  await ready();
  await check('distinct-documents-stores-callbacks',async()=>{
    assert.equal(await page.locator('[contenteditable="true"]').count(),2);
    assert.equal(await text(page),'Plan the task');assert.equal(await text(page,'comment'),'Add a comment');
    const result=await page.evaluate(async()=>{const {task,comment}=await import('/fixture/editor.mjs');await task.save();await comment.save();return {ids:[task.options.identity.documentId,comment.options.identity.documentId],stores:[task.options.databaseName,comment.options.databaseName],events:[task.events,comment.events],permissions:[task.permission,comment.permission],wasm:performance.getEntriesByType('resource').filter(e=>e.name.endsWith('.wasm')).length};});
    assert.notEqual(...result.ids);assert.notEqual(...result.stores);assert.ok(result.wasm>0);
    result.events.forEach((e,i)=>{assert.equal(e.save.length,1);assert.equal(e.save[0].documentId,result.ids[i]);assert.equal(e.error.length,0);});
    assert.equal(result.permissions[0].rich,true);assert.equal(result.permissions[1].rich,false);
  });
  await check('focus-edit-undo-isolation',async()=>{
    const originalTask=await text(page),originalComment=await text(page,'comment');
    await select('#editor');await page.keyboard.type('T');await settle();const changedTask=await text(page);assert.notEqual(changedTask,originalTask);assert.equal(await text(page,'comment'),originalComment);
    await select('#comment');await page.keyboard.type('C');await settle();assert.equal(await text(page),changedTask);
    await page.keyboard.press('Meta+z');await settle();assert.equal(await text(page,'comment'),originalComment);assert.equal(await text(page),changedTask);
    await select('#editor');await page.keyboard.press('Meta+z');await settle();assert.equal(await text(page),originalTask);assert.equal(await text(page,'comment'),originalComment);
    const events=await page.evaluate(async()=>{const m=await import('/fixture/editor.mjs');return [m.task.events.history,m.comment.events.history];});assert.deepEqual(events,[['undo'],['undo']]);
  });
  await check('task-rich-presenters',async()=>{
    const siblingBefore=await page.evaluate(async()=>(await import('/fixture/editor.mjs')).comment.editor.read());
    // Actual SDK controls retain the target while focus moves into their menus.
    await select('#editor',true);await page.locator('#task-panel [data-command="bold"]').click();await settle();
    assert.ok(await page.evaluate(async()=>(await import('/fixture/editor.mjs')).editor.read().visible.some(n=>n.runs?.some(r=>r.attributes.bold===true))));
    await select('#editor',true);await page.locator('#task-panel [data-command="link"]').click();
    const href=page.getByRole('textbox',{name:/URL|Link address/i});await href.fill('https://example.test/task');
    await page.getByRole('button',{name:/Apply link|Save link/i}).click();await settle();
    assert.ok(await page.evaluate(async()=>(await import('/fixture/editor.mjs')).editor.read().visible.some(n=>n.runs?.some(r=>r.attributes.link==='https://example.test/task'))));
    await select('#editor');await page.keyboard.press('Meta+z');await settle(); // leave link context before slash insertion
    for(const label of ['Text paragraph','Bullet list','Numbered list','Checklist','Task table','Local image']){
      await select('#editor');await page.locator('#task-panel').getByRole('button',{name:'Slash commands',exact:true}).click();
      await page.getByRole('menuitem',{name:label,exact:true}).click();await settle();
      if(label==='Bullet list')assert.ok(await page.locator('#editor ul').count());
      if(label==='Numbered list')assert.ok(await page.locator('#editor ol').count());
      if(label==='Checklist'){
        assert.ok(await page.locator('#editor [data-check-marker]').count());
        await page.locator('#editor li').last().click();await page.keyboard.press('End');await page.getByRole('button',{name:'Slash commands',exact:true}).click();
        await page.getByRole('menuitem',{name:'Check item',exact:true}).click();await settle();
        assert.equal(await page.locator('#editor [data-check-marker]').getAttribute('aria-label'),'Checked');
        await select('#editor');await page.keyboard.press('Meta+z');await settle();
      }
      if(label==='Task table'){
        assert.ok(await page.locator('#editor [data-content-module="table"]').count());
        const cell=page.getByRole('textbox',{name:'Table row 2 column 1',exact:true});await cell.fill('Edited detail');await select('#editor');await settle();
        assert.ok(await page.evaluate(async()=>JSON.stringify((await import('/fixture/editor.mjs')).editor.read()).includes('Edited detail')));
        await select('#editor');await page.keyboard.press('Meta+z');await settle();
      }
      if(label==='Local image')await page.locator('#editor [data-image-state="ready"]').waitFor();
      await page.screenshot({path:join(output,label.toLowerCase().replaceAll(' ','-')+'.png'),fullPage:true});
      // Undo the insertion through the same owning history before the next case.
      await select('#editor');await page.keyboard.press('Meta+z');await settle();
    }
    await select('#editor');await page.locator('#task-panel').getByRole('button',{name:/reference/i,exact:false}).click();
    await page.getByRole('searchbox',{name:'Search references'}).fill('Prepared');
    await page.getByRole('menuitem',{name:'Prepared local task',exact:true}).click();await settle();
    assert.ok(await page.evaluate(async()=>(await import('/fixture/editor.mjs')).editor.read().visible.some(n=>n.blockAttributes?.[0]==='module:editac.reference')));
    assert.deepEqual(await page.evaluate(async()=>(await import('/fixture/editor.mjs')).comment.editor.read()),siblingBefore);
    assert.equal(await text(page,'comment'),'Add a comment');await page.screenshot({path:join(output,'workspace-rich.png'),fullPage:true});
  });
  await check('comment-capability-denial',async()=>{
    assert.equal(await page.locator('#comment-panel [data-command], #comment-panel [role="menu"]').count(),0);
    await select('#comment',true);await page.keyboard.press('Meta+b');await page.keyboard.type('/ literal');await settle();
    const result=await page.evaluate(async()=>{const {comment}=await import('/fixture/editor.mjs');const target=comment.editor.captureCommand('bold');const outcome=target?.execute();target?.dispose();return {snapshot:comment.editor.read(),slash:!!comment.editor.slash,references:!!comment.editor.references,outcome};});
    assert.equal(result.slash,false);assert.equal(result.references,false);
    assert.ok(!result.snapshot.visible.some(n=>n.runs?.some(r=>r.attributes.bold===true)));
    assert.equal(await page.locator('#comment-panel [role="menu"]').count(),0);
  });
  await check('readonly-admission-and-revocation',async()=>{
    const before=await text(page,'comment');
    await select('#comment');
    await page.evaluate(async()=>{const {comment}=await import('/fixture/editor.mjs');window.deniedTarget=comment.editor.captureCommand('replace');comment.editor.setReadOnly(true);});
    const denied=await page.evaluate(()=>{const result=window.deniedTarget?.execute('DENIED');window.deniedTarget?.dispose();return result;});
    assert.equal(denied?.disposition,'rejected');await page.keyboard.type('DENIED');assert.equal(await text(page,'comment'),before);
    await page.evaluate(async()=>(await import('/fixture/editor.mjs')).comment.editor.setReadOnly(false));
    const readonly=await browser.newPage();await ready(readonly,'?readonly');
    const states=await readonly.evaluate(async()=>{const m=await import('/fixture/editor.mjs');return [m.task.editor.state,m.comment.editor.state];});assert.ok(states.every(s=>s.ready&&s.readOnly));assert.equal(await readonly.locator('[contenteditable="true"]').count(),0);await readonly.close();
  });
  await check('sibling-survives-disposal',async()=>{
    await page.locator('#dispose-task').click();await page.waitForFunction(async()=>(await import('/fixture/editor.mjs')).task.editor.state.phase==='destroyed');
    await select('#comment');await page.keyboard.type(' still usable');await page.evaluate(async()=>(await import('/fixture/editor.mjs')).comment.save());assert.match(await text(page,'comment'),/still usable/);
    assert.equal(await page.evaluate(async()=>(await import('/fixture/editor.mjs')).comment.editor.state.ready),true);
  });
  await check('isolated-error-callback',async()=>{
    // Missing checkpoint is a real storage recovery failure, scoped to a third host mount.
    const result=await page.evaluate(async()=>{
      const {mountWorkspaceEditor}=await import('/fixture/workspace.mjs'),m=await import('/fixture/editor.mjs');
      const root=document.createElement('div'),status=document.createElement('p');document.body.append(root,status);
      localStorage.setItem('editac-example-missing-comment',JSON.stringify({...m.comment.options.identity,documentId:crypto.randomUUID(),epoch:crypto.randomUUID()}));
      let errors=0,failed=false;
      try{await mountWorkspaceEditor('comment',{root,status,creation:{databaseName:'missing-comment',key:'editac-example-missing-comment'},onError(){errors++;}});}catch{failed=true;}
      return {failed,errors,message:status.textContent,siblingErrors:m.comment.events.error.length,siblingReady:m.comment.editor.state.ready,siblingText:m.comment.editor.read().visible.flatMap(n=>n.runs?.map(r=>r.text)??[]).join('')};
    });assert.equal(result.failed,true);assert.ok(result.errors>0);assert.equal(result.siblingErrors,0);assert.equal(result.siblingReady,true);assert.match(result.siblingText,/still usable/);assert.match(result.message,/error/i);
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
