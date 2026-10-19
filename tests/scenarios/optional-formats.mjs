import assert from 'node:assert/strict';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { chromium, firefox, webkit } from 'playwright';
const engine = process.env.EDITAC_PRODUCT_BROWSER ?? 'chromium';
const browserType = { chromium, firefox, webkit }[engine];
assert.ok(browserType, 'Unknown browser profile: ' + engine);
import { requireTestNode } from '../../scripts/test-toolchain.mjs';
import { startFixtureServer } from '../browser/fixture-server.mjs';
import { loadScenario, root } from './run.mjs';
import { prepareProductHarness, sha } from './harness.mjs';
await requireTestNode();
const { manifest, scenario } = await loadScenario('web-optional-formats');
const output = process.env.EDITAC_PRODUCT_CASE_OUTPUT ?? resolve(root, '../architecture/evidence/web-feature-first-20261018/wex-3.1/runtime', new Date().toISOString().replace(/[:.]/g, '-'));
await mkdir(output, { recursive: true });
const facts = { parent: scenario.parent, scenario: 'web-optional-formats', command: ['node', 'tests/scenarios/run.mjs', 'web-optional-formats'], output, profile: { ...manifest.profile, engine }, commands: [], cases: [], processes: [], teardown: [], scope: manifest.scope };
let server, controller, browser, activePage;
async function teardown() {
  for (const [name, resource] of [['browser connection', browser], [engine+' controller', controller], ['fixture listener', server]]) {
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
  const {site}=await prepareProductHarness(output,facts,scenario);
  server=await startFixtureServer({fixtureDirectory:join(site,'fixture'),coreDirectory:join(site,'core'),webDirectory:join(site,'web'),markdownDirectory:join(site,'markdown'),recordRequests:true});
  facts.processes.push({pid:process.pid,launcher:process.execPath,workspace:root,port:server.port,purpose:'WEX-3.1 installed optional product',log:join(output,'receipt.json')});
  controller=await browserType.launchServer({headless:true});
  facts.processes.push({pid:controller.process().pid,launcher:controller.process().spawnfile,workspace:root,purpose:'WEX-3.1 '+engine,log:join(output,'receipt.json')});
  browser=await browserType.connect(controller.wsEndpoint());facts.browserVersion=browser.version();
  const page=activePage=await browser.newPage(),errors=[];page.setDefaultTimeout(8000);page.on('pageerror',e=>errors.push(e.message));
  await page.route('**/*',route=>new URL(route.request().url()).origin===server.url ? route.continue() : route.abort('blockedbyclient'));
  const ready=async(query='')=>{await page.goto(server.url+'/fixture/index.html'+query);await page.evaluate(async()=>{await(await import('/fixture/editor.mjs')).ready;});};
  const settle=()=>page.evaluate(async()=>{await(await import('/fixture/editor.mjs')).editor.settle();});
  const select=async()=>{await page.locator('#editor [data-node-id]').first().click();await page.keyboard.press('Meta+a');};
  const ui=()=>page.getByRole('group',{name:'File and sharing controls',exact:true});
  const button=name=>ui().getByRole('button',{name,exact:true});
  const status=()=>ui().getByRole('status');
  const confirmButton=()=>ui().getByRole('button',{name:/^Confirm import/});
  const controls=fn=>page.evaluate(async fn=>{
    const {task}=await import('/fixture/editor.mjs');return Function('c','return ('+fn+')(c)')(task.formats);
  },fn.toString());
  const show=async()=>{
    if(await button('Close file and sharing').count() && await button('Close file and sharing').isVisible())await button('Close file and sharing').click();
    await select();await button('File and sharing').click();
  };
  const preview=async(format,name,bytes,allowReportedLoss=false)=>{
    await show();await ui().getByLabel('Import format',{exact:true}).selectOption(format);
    await ui().getByLabel('Approve reported format loss',{exact:true}).uncheck();
    const before=await page.evaluate(async()=>(await import('/fixture/editor.mjs')).editor.read());
    const file={name,mimeType:format==='text'?'text/plain':'application/octet-stream',buffer:Buffer.from(bytes)};
    const input=ui().getByLabel('Import file (file-input fallback)',{exact:true});
    await input.setInputFiles(file);
    await status().filter({hasText:/Preview ready|Import not prepared/}).waitFor({timeout:30000});
    let message=await status().textContent();
    if(message.includes('LossApprovalRequired')) {
      assert.equal(allowReportedLoss,true,message);
      assert.deepEqual(await page.evaluate(async()=>(await import('/fixture/editor.mjs')).editor.read()),before);
      (facts.lossApprovals??=[]).push({format,filename:name,diagnostic:message});
      await ui().getByLabel('Approve reported format loss',{exact:true}).check();await input.setInputFiles(file);
      await status().filter({hasText:/Preview ready|Import not prepared/}).waitFor({timeout:30000});message=await status().textContent();
    }
    assert.match(message,/^Preview ready/,message);
  };
  const confirm=async()=>{await confirmButton().click();await status().filter({hasText:'Import applied'}).waitFor();await settle();};
  const exportFile=async(format,filename)=>{
    await ui().getByLabel('Export format',{exact:true}).selectOption(format);
    await ui().getByLabel('Output filename',{exact:true}).fill(filename);
    await button('Prepare export').click();await status().filter({hasText:'Prepared revision'}).waitFor({timeout:30000});
    const artifact=await controls(c=>({...c.artifact,bytes:Array.from(c.artifact.bytes)}));
    assert.equal(artifact.format,format);assert.equal(artifact.filename,filename);assert.ok(artifact.bytes.length);
    await writeFile(join(output,filename),Buffer.from(artifact.bytes));return artifact;
  };
  await check('disabled-default',async()=>{
    await ready();assert.equal(await ui().count(),0);
    assert.equal(await page.evaluate(()=>performance.getEntriesByType('resource').some(e=>/installed-formats|modules\/formats/.test(e.name))),false);
  });
  await check('baseline-import-history-and-reopen',async()=>{
    await ready('?formats');assert.equal(await ui().count(),1);assert.equal(await text(page,'comment'),'Add a comment');
    await preview('text','task.txt',Buffer.from('Imported task 😀'));
    assert.equal(await text(page),'Plan the task');await confirm();assert.equal(await text(page),'Imported task 😀');
    await page.locator('#editor [data-node-id]').first().click();await page.keyboard.press('Meta+z');await settle();assert.equal(await text(page),'Plan the task');
    await page.keyboard.press('Meta+Shift+z');await settle();assert.equal(await text(page),'Imported task 😀');
    await page.evaluate(async()=>{const m=await import('/fixture/editor.mjs');await m.saveLocally();await m.reopenOffline();});
    assert.equal(await text(page),'Imported task 😀');assert.equal(await ui().count(),1);assert.equal(await text(page,'comment'),'Add a comment');
    await show();const artifact=await exportFile('text','task.txt');assert.equal(Buffer.from(artifact.bytes).toString(),'Imported task 😀');
  });
  await check('markdown-import-export',async()=>{
    await preview('markdown','task.md',Buffer.from('**Formatted task**'));await confirm();assert.equal(await text(page),'Formatted task');
    assert.equal(await page.evaluate(async()=>(await import('/fixture/editor.mjs')).editor.read().visible.some(n=>n.runs?.some(r=>r.attributes.bold===true))),true);
    await show();const artifact=await exportFile('markdown','task.md');assert.match(Buffer.from(artifact.bytes).toString(),/\*\*Formatted task\*\*/);
  });
  await check('installed-document-import-export',async()=>{
    await button('Show installed format profiles').click();await status().filter({hasText:'Installed profiles listed'}).waitFor();
    const directions=await ui().getByLabel('Import format',{exact:true}).locator('option').evaluateAll(nodes=>nodes.map(n=>n.value));
    assert.deepEqual(directions,['text','markdown','rtf','csv','tsv','docx','odt','epub']);assert.equal(directions.includes('pdf'),false);
    await preview('rtf','task.rtf',Buffer.from('{\\rtf1\\ansi Converted task}'));await confirm();assert.equal(await text(page),'Converted task');
    for(const format of ['rtf','docx','odt','epub','pdf']) {
      await show();const artifact=await exportFile(format,'task.'+format);
      const bytes=Buffer.from(artifact.bytes);
      if(format==='rtf'){assert.match(bytes.toString(),/^\{\\rtf/);assert.match(bytes.toString(),/Converted task/);}
      else if(format==='pdf')assert.equal(bytes.subarray(0,5).toString(),'%PDF-');
      else assert.equal(bytes.subarray(0,2).toString(),'PK');
      if(format!=='rtf') {
        const command=[process.env.EDITAC_PRODUCT_PDF_PYTHON??'python3','tests/scenarios/inspect-product-formats.py',join(output,'task.'+format)];
        const result=spawnSync(command[0],command.slice(1),{encoding:'utf8'});
        const log=join(output,'independent-'+format+'.log');await writeFile(log,(result.stdout??'')+(result.stderr??''));
        facts.commands.push({command,exit:result.status,log});assert.equal(result.status,0,'Independent '+format+' reader: '+log);
      }
      if(['docx','odt','epub'].includes(format)) {await preview(format,'task.'+format,bytes,true);await confirm();assert.equal(await text(page),'Converted task');}
    }
    for(const format of ['csv','tsv']) {
      const delimiter=format==='csv'?',':'\t';
      await preview(format,'table.'+format,Buffer.from('Task'+delimiter+'State\nExample'+delimiter+'Ready\n'));await confirm();
      await show();const tables=ui().getByLabel('Table to export',{exact:true});
      const value=await tables.locator('option').last().getAttribute('value');await tables.selectOption(value);
      const artifact=await exportFile(format,'table.'+format);
      const command=[process.env.EDITAC_PRODUCT_PDF_PYTHON??'python3','tests/scenarios/inspect-product-formats.py',join(output,'table.'+format)];
      const result=spawnSync(command[0],command.slice(1),{encoding:'utf8'}),log=join(output,'independent-'+format+'.log');
      await writeFile(log,(result.stdout??'')+(result.stderr??''));facts.commands.push({command,exit:result.status,log});assert.equal(result.status,0,'Independent '+format+' reader: '+log);
    }
    assert.equal(await text(page,'comment'),'Add a comment');
    await page.evaluate(async()=>{const m=await import('/fixture/editor.mjs');await m.saveLocally();await m.reopenOffline();});
    assert.ok(await page.locator('#editor table').count());
  });
  await check('cancel-and-original-recovery',async()=>{
    const before=await text(page);await preview('text','cancel.txt',Buffer.from('Never committed'));
    await button('Cancel preparation').click();assert.equal(await text(page),before);assert.equal(await confirmButton().isDisabled(),true);
    assert.equal(await ui().getByLabel('Import source preview',{exact:true}).inputValue(),'Never committed');
    const download=page.waitForEvent('download');await button('Download original file').click();const original=await download;
    assert.equal(original.suggestedFilename(),'cancel.txt');await original.saveAs(join(output,'recovered-cancel.txt'));assert.equal(await readFile(join(output,'recovered-cancel.txt'),'utf8'),'Never committed');
    await show();await ui().getByLabel('Import format',{exact:true}).selectOption('text');
    await ui().getByLabel('Import file (file-input fallback)',{exact:true}).setInputFiles({name:'invalid.txt',mimeType:'text/plain',buffer:Buffer.from([0xff,0xfe])});
    await status().filter({hasText:'Import not prepared'}).waitFor();assert.equal(await text(page),before);assert.equal(await confirmButton().isDisabled(),true);
    // Cancel a real converter while its local WASM bootstrap transport is held.
    await ready('?formats');await show();await button('Show installed format profiles').click();await status().filter({hasText:'Installed profiles listed'}).waitFor();
    await ui().getByLabel('Import format',{exact:true}).selectOption('rtf');
    const beforeCancel=await page.evaluate(async()=>(await import('/fixture/editor.mjs')).editor.read());
    const pattern='**/installed-formats/dist/runtime/editac_formats_wasm_bg.wasm';let held;
    await page.route(pattern,route=>{held=route;});const requested=page.waitForRequest(/installed-formats\/dist\/runtime\/editac_formats_wasm_bg.wasm/);
    await ui().getByLabel('Import file (file-input fallback)',{exact:true}).setInputFiles({name:'pending.rtf',mimeType:'application/rtf',buffer:Buffer.from('{\\rtf1 Pending conversion}')});
    await requested;await button('Cancel preparation').click();await held.abort().catch(()=>{});await page.unroute(pattern);
    assert.deepEqual(await page.evaluate(async()=>(await import('/fixture/editor.mjs')).editor.read()),beforeCancel);
    assert.equal(await confirmButton().isDisabled(),true);
    // Local task composition grants no authority to admit embedded originals.
    await show();await ui().getByLabel('Import format',{exact:true}).selectOption('docx');
    const media=await readFile(join(root,'fixtures/formats/docx/probe/tiny.docx'));
    await ui().getByLabel('Import file (file-input fallback)',{exact:true}).setInputFiles({name:'media.docx',mimeType:'application/vnd.openxmlformats-officedocument.wordprocessingml.document',buffer:media});
    await status().filter({hasText:'Import not prepared'}).waitFor({timeout:30000});
    assert.deepEqual(await page.evaluate(async()=>(await import('/fixture/editor.mjs')).editor.read()),beforeCancel);
    assert.equal(await controls(async c=>Array.from(new Uint8Array(await c.recovery.arrayBuffer()))).then(b=>sha(Buffer.from(b))),sha(media));
    assert.equal(await confirmButton().isDisabled(),true);

  });
  await check('readonly-and-disposal',async()=>{
    await preview('text','denied.txt',Buffer.from('Denied task'));const before=await text(page);
    await page.evaluate(async()=>{(await import('/fixture/editor.mjs')).revokeEditing('task');});
    const denied=await page.evaluate(async()=>{const {task}=await import('/fixture/editor.mjs');await task.formats.confirm();await task.editor.settle();return task.editor.read();});
    assert.equal(await text(page),before);assert.ok(denied.visible.length);
    await page.evaluate(async()=>{const m=await import('/fixture/editor.mjs');await m.task.close();});assert.equal(await ui().count(),0);assert.equal(await text(page,'comment'),'Add a comment');
    await ready('?formats&readonly');await show();assert.equal(await confirmButton().isDisabled(),true);
    await page.evaluate(async()=>{const m=await import('/fixture/editor.mjs');await m.task.close();await m.comment.close();});assert.equal(await ui().count(),0);
  });
  assert.deepEqual(errors,[]);assert.deepEqual(facts.cases.map(c=>c.id),scenario.cases);

} catch (error) {
  facts.failure = error.stack; process.exitCode = 1;
  if (activePage) {
    try { facts.failureState = await activePage.evaluate(async () => ({ message: document.querySelector('#message')?.textContent, formatStatus:document.querySelector('[data-format-controls] [role="status"]')?.textContent, state: (await import('/fixture/editor.mjs')).editor?.state })); await activePage.screenshot({ path: join(output, 'failure.png'), fullPage: true }); }
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
