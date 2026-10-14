import assert from 'node:assert/strict';
import { before, after, test } from 'node:test';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { createServer } from 'node:http';
import { chromium, firefox, webkit } from 'playwright';
import { buildExtensionConsumers, nativeInventory, loggedRun, sha256 } from '../scripts/extension-bundles.mjs';
import { evaluateBudget, assertBudget } from '../scripts/browser-size-contract.mjs';
const output = resolve(process.env.EDITAC_EXTENSION_BUNDLES_OUTPUT ?? '../architecture/evidence/extension-bundles/current');
const config = JSON.parse(await readFile(new URL('../fixtures/extensions/consumers/profiles.json', import.meta.url)));
const corpusPath = resolve('fixtures/extensions/conformance.json');
const corpus = JSON.parse(await readFile(corpusPath));
const upstream = resolve('../architecture/evidence/extension-contract');
const requiredCases = config.fallbackCells.map(id => {
  const cell = corpus.cases.find(c => c.id === id);
  assert(cell && ['known', 'opaque', 'preserved'].includes(cell.expected), 'missing admitted fixture: ' + id);
  return cell;
});
let profiles, baseline, native;
const checks = [], runtimes = [], fixtureHashes = {};
const countTAP = log => Object.fromEntries(['tests','pass','fail','skipped','cancelled'].map(key => [key, Number(log.match(new RegExp('^# ' + key + ' (\\d+)$', 'm'))?.[1] ?? -1)]));
before(async () => {
  await mkdir(output, { recursive: true });
  const run = await loggedRun(output, 'default-task-build', process.execPath, ['scripts/check-browser-size.mjs'], { env: { ...process.env, EDITAC_BROWSER_SIZE_OUTPUT: join(output, 'default-task') } });
  checks.push({ ...run, stdout: undefined });
  baseline = JSON.parse(await readFile(join(output, 'default-task/manifest.json')));
  profiles = await buildExtensionConsumers(output, config);
  native = await nativeInventory(output, config);
  const upstreamReceipt = JSON.parse(await readFile(join(upstream, 'receipt.json')));
  assert.equal(sha256(await readFile(corpusPath)), upstreamReceipt.sourceHashes['fixtures/extensions/conformance.json'], 'reuse only qualified unchanged corpus');
  for (const name of ['identity.json', ...config.fallbackCells.map(id => id + '.bin')]) {
    const bytes = await readFile(join(upstream, name));
    const expected = upstreamReceipt.evidenceHashes[name];
    assert(expected, 'missing upstream hash pin: ' + name);
    assert.equal(sha256(bytes), expected, 'upstream checkpoint changed: ' + name);
    fixtureHashes[name] = expected;
  }
});
after(async () => {
  await writeFile(join(output, 'results.json'), JSON.stringify({ gate: 'EXT-1.9', checks, runtimes, fixtureHashes, profileManifest: 'profiles.json', nativeManifest: 'native-terminal-inventory.json', scope: 'Actual loopback packed browser loading/editor/storage; prepared persisted content and no service/provider calls.' }, null, 2) + '\n');
});
const contributed = (manifest, pattern) => Object.values(manifest.outputs).flatMap(o => Object.entries(o.inputs)).filter(([p,d]) => pattern.test(p) && d.bytesInOutput > 0);
const optional = /\/modules\/(?:slash|references|reorder|content|math|math-renderer|vendor\/katex)\.(?:m?js)$/;
test('default Task retains canonical artifact inventory and passes both independent gzip caps', async () => {
  assert.equal(baseline.profile, 'default-task'); assert.equal(baseline.fixtureBaseline, false);
  assert.equal(baseline.productionFixtureAbsent, true);
  for (const asset of baseline.assets) assert.equal(sha256(await readFile(join(output, 'default-task/artifacts', asset.name))), asset.sha256);
  assert.deepEqual(evaluateBudget(baseline.assets, baseline.required), baseline.result);
  assertBudget(baseline.result);
  assert.equal(baseline.result.total.hard, 524288); assert.equal(baseline.result.js.hard, 32768);
  assert.equal(baseline.result.total.preferred, 256000); assert.equal(baseline.result.js.preferred, 16000);
  assert.equal(typeof baseline.result.total.preferredPass, 'boolean'); assert.equal(typeof baseline.result.js.preferredPass, 'boolean');
});
test('same measured default Task artifacts qualify actual editing, sync, clipboard and recovery in three browsers', {timeout:240000}, async () => {
  const result = await loggedRun(output, 'default-task-runtime', process.execPath, ['--test', '--test-reporter=tap', 'tests/browser-size-runtime.test.mjs'], { env: { ...process.env, EDITAC_SIZE_RUNTIME_ARTIFACTS: join(output, 'default-task'), EDITAC_SIZE_RUNTIME_RESULTS: join(output, 'default-task') } });
  const counts = countTAP(result.stdout);
  checks.push({ ...result, stdout: undefined, counts });
  assert.deepEqual(counts, { tests:3, pass:3, fail:0, skipped:0, cancelled:0 });
  const facts = JSON.parse(await readFile(join(output, 'default-task/runtime-harness.json')));
  assert.equal(facts.cases.length, 3);
  for (const fact of facts.cases) { assert.equal(fact.passed, true); assert.deepEqual(fact.cleanup, {browserExited:true,serverClosed:true}); }
});
for (const name of Object.keys(config.profiles)) test(`${name}: packed public graph inventories every static/lazy JS, WASM, CSS and asset`, async () => {
  const profile = profiles.profiles[name];
  assert.deepEqual(evaluateBudget(profile.assets, profile.required), profile.result);
  for (const asset of profile.assets) assert.equal(sha256(await readFile(join(output, name, asset.name))), asset.sha256);
  assert(profile.assets.every(a => a.brotli > 0 && a.raw > 0 && a.gzip > 0));
  assert(Object.keys(profile.inputs).some(p => p.endsWith('core/dist/extensions/registry.js')));
  const manifest = JSON.parse(await readFile(join(output, name + '-metafile.json')));
  if (name === 'minimal') assert.deepEqual(contributed(manifest, optional), []);
  else {
    for (const module of config.profiles.enabled.presenters) assert(contributed(manifest, new RegExp('/modules/' + module + '\\.js$')).length > 0, module);
    assert(contributed(manifest, /\/modules\/math-renderer\.js$/).length > 0);
    assert(contributed(manifest, /\/modules\/vendor\/katex\.mjs$/).length > 0);
    assert(Object.values(manifest.outputs).some(o => o.imports.some(i => i.kind === 'dynamic-import')));
  }
  assert.equal(profile.assets.some(a => /\.(?:woff|png|svg)$/.test(a.name)), false, 'MathML renderer has no unlisted fonts/images');
  assert(Object.keys(profile.inputs).every(p => !/markdown\/dist|clipboard\/markdown\.js/.test(p)));
});
test('packed archives, enabled incremental costs and consumer teardown are recorded', async () => {
  for (const pack of profiles.packs) assert.equal(sha256(await readFile(join(output,pack.filename))), pack.sha256);
  assert.equal(profiles.cleanup.removed, true);
  for (const scope of ['js','total']) {
    const delta = profiles.profiles.enabled.result[scope].bytes - profiles.profiles.minimal.result[scope].bytes;
    assert(delta > 0); assert.equal(profiles.enabledDeltaFromMinimalGzip[scope], delta);
  }
});
test('native and terminal inventories identify actual dependencies without claiming feature-flag binary savings', () => {
  assert.deepEqual(native.inventories.map(i => i.host), ['native','terminal']);
  const core = native.inventories[0].packages.find(p => p.name === 'editac-core');
  const ffi = native.inventories[0].packages.find(p => p.name === 'editac-ffi');
  assert(core); assert(ffi); assert.deepEqual(core.features, {});
  assert(core.dependencies.filter(d => d.kind === null).every(d => d.optional === false));
  assert.deepEqual(ffi.features.bindgen, ['uniffi/cli']);
  assert(native.android.includes('net.java.dev.jna:jna:5.17.0@aar'));
  assert(native.android.includes('com.google.code.gson:gson:2.13.1'));
  assert.equal(native.inventories[1].packages[0].name,'editac-cli');
  assert.deepEqual(native.inventories[1].packages[0].dependencies,[]);
  assert.deepEqual(native.rendererAssets,[]);
  assert.equal(Object.keys(native.sources).length, config.nativeInventory.length);
});
test('missing required lazy code or either independent hard-cap overrun fails admission', () => {
  const assets = baseline.assets;
  assert.throws(() => evaluateBudget(assets.filter(a=>a.kind!=='wasm'), baseline.required), /Missing required/);
  const requiredJS = assets.find(a=>a.kind==='js');
  assert.throws(() => evaluateBudget(assets.filter(a=>a!==requiredJS), baseline.required), /Missing required/);
  assert.throws(() => assertBudget({...baseline.result, js:{...baseline.result.js,hardPass:false,bytes:32769,gap:1}}),/js:/);
  assert.throws(() => assertBudget({...baseline.result, total:{...baseline.result.total,hardPass:false,bytes:524289,gap:1}}),/total:/);
});
for (const [engine, launcher] of Object.entries({chromium,firefox,webkit})) for (const profile of Object.keys(config.profiles)) test(`${engine}/${profile}: actual loading, fallback edit/recovery and lazy renderer activation`, {timeout:180000}, async () => {
  const resources = new Map();
  for (const asset of profiles.profiles[profile].assets) resources.set('/'+asset.name, {bytes:await readFile(join(output,profile,asset.name)),kind:asset.kind});
  for (const cell of requiredCases) resources.set('/fixtures/'+cell.id+'.bin',{bytes:await readFile(join(upstream,cell.id+'.bin')),kind:'asset'});
  const requests=[], errors=[];
  const fact={engine,profile,cases:[],requests,errors,passed:false,processes:[]}; runtimes.push(fact);
  let server, controller, browser;
  try {
    server=createServer((req,res)=>{
      if(req.url==='/'){res.setHeader('Content-Type','text/html');res.end('<!doctype html><link rel="stylesheet" href="/task.css"><div id="editor"></div>');return;}
      const resource=resources.get(req.url);
      if(!resource){res.statusCode=404;res.end();return;}
      res.setHeader('Content-Type',{js:'text/javascript',wasm:'application/wasm',css:'text/css'}[resource.kind]??'application/octet-stream');res.end(resource.bytes);
    });
    await new Promise((done,reject)=>{server.once('error',reject);server.listen(0,'127.0.0.1',done);});
    fact.processes.push({pid:process.pid,port:server.address().port,workspace:process.cwd(),purpose:`EXT-1.9 ${engine}/${profile} loopback resources`,log:output});
    controller=await launcher.launchServer({headless:true}); browser=await launcher.connect(controller.wsEndpoint());
    fact.processes.push({pid:controller.process().pid,launcher:controller.process().spawnfile,purpose:`EXT-1.9 ${engine}/${profile}`,workspace:process.cwd(),log:output});
    fact.version=browser.version();
    const page=await browser.newPage();
    page.on('request',req=>requests.push({url:req.url(),stage:fact.stage}));page.on('pageerror',e=>errors.push(e.message));
    await page.route('**/*',route=>new URL(route.request().url()).hostname==='127.0.0.1'?route.continue():route.abort());
    fact.stage='import'; await page.goto(`http://127.0.0.1:${server.address().port}`);
    await page.evaluate(async()=>{window.sdk=await import('/consumer.js');});
    assert.equal(requests.some(r=>/\.wasm$/.test(r.url)),false,'public import performs no engine I/O');
    const manifest=JSON.parse(await readFile(join(output,profile+'-metafile.json')));
    const lazyPaths=Object.entries(manifest.outputs).filter(([,o])=>Object.entries(o.inputs).some(([p,d])=>/math-renderer|vendor\/katex/.test(p)&&d.bytesInOutput>0)).map(([p])=>'/'+p.split('/').at(-1));
    assert.equal(requests.some(r=>lazyPaths.some(p=>r.url.endsWith(p))),false,'math assets stay lazy before mount');
    for (const cell of requiredCases) {
      fact.stage=cell.id;
      const identity=JSON.parse(await readFile(join(upstream,'identity.json')));
      const result=await page.evaluate(async ({cell,definitions,identity,enabled})=>{
        const sdk=window.sdk, runtime=await sdk.init('/wasm/editac_wasm_bg.wasm');
        const bytes=new Uint8Array(await (await fetch('/fixtures/'+cell.id+'.bin')).arrayBuffer());
        const doc=runtime.restoreEngine(identity,{identity,initialized:true,writerId:11,bytes});
        const project=e=>{const n=e.read().visible.find(n=>n.id==='n:11:1');return {blockAttributes:n.blockAttributes,runs:n.runs};};
        const expected=project(doc), databaseName='ext-bundles-'+cell.id;
        const store=await sdk.CheckpointStorage.open(indexedDB,databaseName);
        try{await store.publish(doc.checkpoint(),[]);}finally{store.close();doc.dispose();}
        let lookups=0;
        const options=()=>{
          const modules=new sdk.ModuleRegistry();
          if(!cell.disabled)for(const d of definitions)modules.register(d,enabled&&d.type==='editac.math'?{tag:'span'}:undefined);
          return {identity,databaseName,assetUrl:'/wasm/editac_wasm_bg.wasm',indexedDB,locks:navigator.locks,...sdk.taskPreset({plainPasteControl:false}),modules,
            ...(enabled?{slash:sdk.slashCommands([]),references:sdk.referenceSuggestions(async()=>{lookups++;return [];}),reorder:sdk.reorderControls(),content:sdk.contentModules(),moduleRuntime:{renderers:{'editac.math':sdk.mathRenderer()}}}: {})};
        };
        const root=document.querySelector('#editor');let editor;
        let mathState=null;
        try{
          editor=sdk.createEditor(root,options());await editor.ready;
          const before=project(editor);
          if(enabled&&cell.id==='builtin-math'){
            const deadline=performance.now()+10000;
            while(root.querySelector('[data-math-state]')?.dataset.mathState==='loading'&&performance.now()<deadline)await new Promise(r=>setTimeout(r,10));
            mathState=root.querySelector('[data-math-state]')?.dataset.mathState;
          }
          const owner=root.querySelector('[data-node-id="n:11:1"]');
          const renderedText=owner.textContent, controlValues=[...owner.querySelectorAll('textarea')].map(input=>input.value);
          const originalText=cell.run?.text??cell.text;
          // Baseline newlines are <br>; enabled table cells and image source use
          // native controls. Check the actual declared representation in its owner.
          const sourceVisible=enabled&&cell.id==='builtin-table'
            ? cell.blockAttributes[2].rows.every(row=>row.every(runs=>controlValues.includes(runs.map(r=>r[0]).join(''))))
            : renderedText.includes(originalText.replaceAll('\n',''))||controlValues.includes(originalText);
          const other=editor.read().visible.find(n=>n.id!=='n:11:1'&&n.runs?.length&&n.kind==='block');
          if(!other)throw Error('missing unrelated editable source');
          const at=editor.anchor(other.id,0,'right');
          try{editor.commit({kind:'text',origin:'local:extension-bundle-proof',command:{type:'insert',at,text:'!'}});}finally{editor.releaseAnchor(at);}
          const afterEdit=project(editor);
          await editor.flush({target:'local'});await editor.destroy({policy:'flush'});editor=undefined;
          editor=sdk.createEditor(root,options());await editor.ready;
          const recovered=project(editor), persistedEdit=editor.read().visible.find(n=>n.id===other.id).runs.map(r=>r.text).join('').startsWith('!');
          return {expected,before,afterEdit,recovered,persistedEdit,sourceVisible,renderedText,controlValues,mathState,lookups,fixtureAbsent:runtime.createFixture===undefined};
        }finally{if(editor)await editor.destroy({policy:'flush'});root.replaceChildren();}
      },{cell,definitions:corpus.definitions,identity,enabled:profile==='enabled'});
      fact.cases.push({id:cell.id,...result,passed:false});
      assert.deepEqual(result.before,result.expected,cell.id+' before');
      assert.deepEqual(result.afterEdit,result.expected,cell.id+' unrelated edit');
      assert.deepEqual(result.recovered,result.expected,cell.id+' stored recovery');
      assert.equal(result.persistedEdit,true);assert.equal(result.sourceVisible,true);assert.equal(result.lookups,0);assert.equal(result.fixtureAbsent,true);
      if(profile==='enabled'&&cell.id==='builtin-math')assert.equal(result.mathState,'rendered');
      fact.cases.at(-1).passed=true;
    }
    if(profile==='minimal')assert.equal(lazyPaths.length,0);
    else assert(lazyPaths.length>0&&lazyPaths.every(p=>requests.some(r=>r.url.endsWith(p)&&r.stage==='builtin-math')),'enabled renderer actually requested at explicit mount');
    const servedPaths = requests.map(r=>new URL(r.url).pathname);
    assert(servedPaths.every(p=>p==='/'||p==='/favicon.ico'||resources.has(p)), 'no hidden resource');
    assert.deepEqual(errors,[]);assert.equal(fact.cases.length,config.fallbackCells.length);fact.passed=true;
  } finally {
    try{await browser?.close();}finally{try{await controller?.close();}finally{
    if(server){server.closeAllConnections();await new Promise((done,reject)=>server.close(e=>e?reject(e):done()));}
    fact.teardown={browserExited:!controller||controller.process().exitCode!==null||controller.process().signalCode!==null,serverClosed:!server?.listening};
    await writeFile(join(output,`runtime-${engine}-${profile}.json`),JSON.stringify(fact,null,2)+'\n');
    }}
  }
});
test('all declared host/profile/fixture cells execute without omissions and no required teardown remains live',()=>{
  assert.equal(runtimes.length,config.hosts.length*Object.keys(config.profiles).length);
  for(const fact of runtimes){assert.equal(fact.passed,true);assert.equal(fact.cases.length,config.fallbackCells.length);assert(fact.cases.every(c=>c.passed));assert.deepEqual(fact.teardown,{browserExited:true,serverClosed:true});}
});
