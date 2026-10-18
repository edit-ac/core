import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { cp, mkdir } from 'node:fs/promises';
import { browserHarness } from '../browser-harness.ts';
import { browserInputSources } from '../../editing/browser-driver.ts';
import { installResourceCounters } from '../../mobile-web/resources.mjs';
import { installExtensionCounters } from './resources.mjs';

const {probe,facts}=browserHarness('mobile-extensions','fixtures/browser-mobile-extensions',{
  markdown:true,autoMount:false,testFile:'tests/browser/mobile-extensions/formats.spec.ts',assertSourcesUnchanged:true,
  contextOptions:{viewport:{width:390,height:740},hasTouch:true,isMobile:process.env.EDITAC_MOBILE_EXTENSIONS_BROWSER!=='firefox'},
  serverOptions:{recordRequests:true},beforeNavigate:async(page,fact)=>{
    page.setDefaultTimeout(5000);fact.external=[];
    await page.route('**/*',route=>new URL(route.request().url()).origin===new URL(fact.origin).origin?route.continue():(fact.external.push(route.request().url()),route.abort()));
    await page.addInitScript(installResourceCounters);await page.addInitScript(installExtensionCounters);
  },prepareConsumer:async(consumer,{facts,run})=>{
    const fixture=join(consumer,'fixture');await cp('fixtures/browser-mobile-extensions',fixture,{recursive:true});
    const owner='../architecture/evidence/document-conversion/consumers-epub-import-20261018';
    const archive=join(owner,'canonical2/edit-ac-formats-0.0.0.tgz'),bytes=readFileSync(archive);
    const sha256=createHash('sha256').update(bytes).digest('hex');
    assert.equal(sha256,'f123c85f410fdb294a0ef880cccbe722f142e63fbb75622c07f4f8424adde0ec');
    const delivery=JSON.parse(readFileSync(join(owner,'delivery.json'),'utf8'));
    assert.equal(delivery.coreCommit,'c15ac91d47f2ddf51bf20056686bc912f5c76a36');
    await run('git',['merge-base','--is-ancestor',delivery.coreCommit,'HEAD'],'profile-owner-ancestry.log');
    const destination=join(fixture,'installed-formats');await mkdir(destination);
    await run('tar',['-xzf',archive,'--strip-components=1','-C',destination],'unpack-installed-formats.log');
    const manifest=JSON.parse(readFileSync(join(destination,'capabilities.json'),'utf8'));
    facts.installedProfiles={archiveSha256:sha256,receiptSha256:createHash('sha256').update(readFileSync(join(owner,'delivery.json'))).digest('hex'),coreCommit:delivery.coreCommit,directions:manifest.directions,
      manifestSha256:createHash('sha256').update(readFileSync(join(destination,'capabilities.json'))).digest('hex')};
    return fixture;
  },sourcePaths:[...browserInputSources,
    '../architecture/specs/document-conversion.md','../architecture/specs/formats.md','../architecture/tests/mobile-extension-cases.md',
    'fixtures/browser-mobile-extensions/session.mjs','fixtures/browser-mobile-extensions/index.html','fixtures/browser-mobile-extensions/format-host.mjs',
    'tests/browser/mobile-extensions/formats.spec.ts','tests/browser/mobile-extensions/index.mjs','tests/browser/mobile-extensions/case-index.json',
    'tests/mobile-web/resources.mjs','tests/browser/mobile-extensions/resources.mjs','scripts/test-mobile-extensions.mjs','packages/web/package.json',
    ...['modules/formats','modules/format-profiles','modules/touch-controls','clipboard/fragment','clipboard/html','dom/selection','editor','platform/viewport'].flatMap(n=>[`packages/web/src/${n}.ts`,`packages/web/dist/${n}.js`])],
});
facts.binding={gate:'MEX-1.6',ids:['MWX-C21','MWX-C22','MWX-C23','MWX-C24'],
  semantics:'actual installed BrowserEditor/Session/WASM/IndexedDB/Markdown, authenticated document-format worker, touch selectors and explicit Session confirmation',
  platform:'prepared OS transports; browser download request only; no actual OS/device delivery claim',
  pending:'stable original/media adoption and full captured export/share lifecycle remain MFA-1.2/1.3; complete original-case reconciliation remains MFA-1.4; broader MEX-1.6 stays unchecked'};
const ui=page=>page.getByRole('group',{name:'File and sharing controls',exact:true});
const button=(page,name)=>ui(page).getByRole('button',{name,exact:true});
const status=page=>ui(page).getByRole('status');
const catalog=page=>ui(page).getByRole('region',{name:'Installed document format profiles',exact:true});
async function frames(page){await page.evaluate(()=>new Promise<void>(r=>requestAnimationFrame(()=>requestAnimationFrame(()=>r()))));}
async function mount(page,options={},mode='absent'){
 await page.waitForFunction(()=>!!(window as any).inputFixture);
 await page.evaluate(()=>{const style=document.querySelector('style')!;style.textContent=style.textContent!.replace(/button \{[^}]+\}/g,'');(window as any).mobileGeometry={visual:{left:0,top:0,width:390,height:740},scale:1};});
 const baseline=await page.evaluate(()=>(window as any).mobileResources());
 await page.evaluate(async({options,mode})=>{const host=await import('/fixture/format-host.mjs');host.installFormatPlatform(mode);await host.mountFormats(options);},{options,mode});
 await frames(page);return baseline;
}
async function state(page){return page.evaluate(async()=>{const s=await(window as any).inputFixture.state();return {nodes:s.nodes,history:s.history,patches:s.patches,journal:s.journal,selection:s.selection};});}
async function artifact(page){return page.evaluate(()=>{const a=(window as any).formats.artifact;return a?{...a,bytes:Array.from(a.bytes)}:null;});}
async function transport(page){return page.evaluate(()=>{const p=(window as any).formatPlatform;return {calls:p.calls,permissions:p.permissions,aborts:p.aborts,urls:[...p.urls],created:p.created,revoked:p.revoked};});}
async function finish(page,baseline,fact){
 const before=await state(page);
 await page.evaluate(async()=>{await(window as any).inputFixture.destroy();});await frames(page);
 fact.resources={baseline,after:await page.evaluate(()=>(window as any).mobileResources())};assert.deepEqual(fact.resources.after,baseline);
 fact.optional=await page.evaluate(()=>(window as any).mobileExtensionResources());assert.equal(fact.optional.listeners,0);
 fact.platform=await transport(page);assert.equal(fact.platform.permissions,0);assert.deepEqual(fact.platform.urls,[]);assert.deepEqual(fact.external,[]);
 fact.final={history:before.history,journalEntries:before.journal.length};
}
async function open(page){await button(page,'File and sharing').click();}
async function input(page,source='imported 😀',filename='fixture.txt',mimeType='text/plain'){
 await ui(page).getByLabel('Import file (file-input fallback)',{exact:true}).setInputFiles({name:filename,mimeType,buffer:Buffer.from(source)});
 await page.waitForFunction(()=>!(window as any).formats.input.files?.length);
 await page.waitForFunction(()=>(window as any).formatState.paused||!(window as any).formats.busy);
 await frames(page);
}
async function prepare(page,format='text',filename=format==='text'?'résumé exact.txt':'résumé exact.md'){
 await ui(page).getByLabel('Export format',{exact:true}).selectOption(format);await ui(page).getByLabel('Output filename',{exact:true}).fill(filename);
 await button(page,'Prepare export').click();await page.waitForFunction(()=>!!(window as any).formats.artifact);
}

test('MWX-C24 opening controls is inert and advertises only admitted directions',()=>probe('MWX-C24-inventory',async(page,fact)=>{
 const baseline=await mount(page),before=await state(page);await open(page);
 assert.deepEqual(await transport(page),{calls:[],permissions:0,aborts:0,urls:[],created:0,revoked:0});assert.equal(await artifact(page),null);
 assert.deepEqual(await ui(page).getByLabel('Import format',{exact:true}).locator('option').evaluateAll(options=>options.map(o=>(o as HTMLOptionElement).value)),['text','markdown']);
 assert.match(await ui(page).innerText(),/PDF export are unavailable/);assert.deepEqual(await state(page),before);await finish(page,baseline,fact);
}));
test('MFA-1.1-C1 installed profiles load only on an explicit touch control and retain exact package labels',()=>probe('MFA-1.1-installed-profiles',async(page,fact)=>{
 const baseline=await mount(page,{catalog:'installed'}),before=await state(page);await open(page);
 assert.equal(await page.evaluate(()=>(window as any).formatState.profileLoads),0);
 assert.equal(fact.requests.some(url=>url.includes('installed-formats')),false);
 const control=button(page,'Show installed format profiles');await control.tap();
 await page.waitForFunction(()=>document.querySelector('[aria-label="Installed document format profiles"] li'));
 const rows=facts.installedProfiles.directions.filter(r=>r.target==='browser-worker-wasm32');assert.equal(rows.length,13);
 assert.deepEqual(await catalog(page).getByRole('listitem').allTextContents(),rows.map(r=>`${r.format.toUpperCase()} ${r.direction}: ${r.profile}; fidelity: ${r.fidelity}`));
 assert.equal(rows.some(r=>r.format==='pdf'&&r.direction==='import'),false);assert.ok(rows.some(r=>r.format==='pdf'&&r.direction==='export'));
 assert.match(await catalog(page).innerText(),/document-format actions are unavailable here/);
 const imported=await ui(page).getByLabel('Import format',{exact:true}).locator('option').allTextContents();assert.ok(imported.every(label=>label.startsWith('Import:')));
 const exported=await ui(page).getByLabel('Export format',{exact:true}).locator('option').allTextContents();assert.ok(exported.every(label=>label.startsWith('Export:')));
 assert.deepEqual(await transport(page),{calls:[],permissions:0,aborts:0,urls:[],created:0,revoked:0});
 assert.deepEqual(await state(page),before);assert.equal(await artifact(page),null);
 const bounds=await control.boundingBox();assert.ok(bounds&&bounds.width>=44&&bounds.height>=44);
 fact.profileRequests=fact.requests.filter(url=>url.includes('installed-formats'));
 assert.deepEqual(fact.profileRequests.map(url=>new URL(url).pathname).sort(),['/fixture/installed-formats/capabilities.json','/fixture/installed-formats/dist/index.js']);
 await finish(page,baseline,fact);assert.equal(fact.optional.allocations.filter(row=>row.kind==='Worker').length,0);
}));
for(const [mode,error] of [['failed','prepared-profile-load-refused'],['pdf-import','format-profile-direction-invalid'],['duplicate','format-profile-direction-duplicate'],['invalid-row','format-profile-direction-invalid'],['unknown-schema','format-profile-manifest-invalid'],['over-limit','format-profile-manifest-invalid'],['empty','format-profile-browser-unavailable'],['native-only','format-profile-browser-unavailable']])
 test(`MFA-1.1-C2 ${mode} metadata preserves explicit baseline actions without partial claims`,()=>probe(`MFA-1.1-profiles-${mode}`,async(page,fact)=>{
  const baseline=await mount(page,{catalog:mode}),before=await state(page);await open(page);await button(page,'Show installed format profiles').click();
  await page.waitForFunction(()=>!(window as any).formats.busy);assert.match(await status(page).innerText(),new RegExp(error));
  assert.equal(await catalog(page).getByRole('listitem').count(),0);assert.match(await catalog(page).innerText(),/Baseline file-input, download and selectable-text recovery/);
  assert.deepEqual(await state(page),before);assert.equal(await ui(page).getByLabel('Import file (file-input fallback)',{exact:true}).isVisible(),true);
  // A metadata failure cannot poison the owning text exporter or recovery controls.
  await prepare(page);assert.equal((await artifact(page)).text,'alpha 😀');await button(page,'Select output for manual copy').click();
  assert.equal(await ui(page).getByLabel('Prepared export text',{exact:true}).evaluate(e=>(e as HTMLTextAreaElement).selectionEnd),'alpha 😀'.length);
  await finish(page,baseline,fact);
 }));
for(const close of ['cancel','close','dispose'])test(`MFA-1.1-C2 ${close} fences a delayed profile load`,()=>probe(`MFA-1.1-profiles-${close}`,async(page,fact)=>{
 const baseline=await mount(page,{catalog:'paused'}),before=await state(page);await open(page);await button(page,'Show installed format profiles').click();
 await page.waitForFunction(()=>!!(window as any).formatState.releaseProfiles);
 const detached=await page.evaluate(()=>{const w=window as any;w.retainedCatalog=w.formats.profileCatalog;return w.retainedCatalog.textContent;});
 if(close==='dispose')await page.evaluate(()=>(window as any).formats.dispose());
 else await button(page,close==='close'?'Close file and sharing':'Cancel preparation').click();
 assert.equal(await page.evaluate(()=>(window as any).formatState.profileSignal.aborted),true);
 await page.evaluate(()=>(window as any).formatState.releaseProfiles());await frames(page);
 assert.equal(await page.evaluate(()=>(window as any).retainedCatalog.textContent),detached);
 assert.equal(fact.requests.some(url=>url.includes('installed-formats')),false);assert.deepEqual(await state(page),before);
 await finish(page,baseline,fact);
}));
test('MFA-1.1-C2 an older canceled metadata load cannot clear or replace a newer inventory',()=>probe('MFA-1.1-profile-generations',async(page,fact)=>{
 const baseline=await mount(page,{catalog:'paused'}),before=await state(page);await open(page);await button(page,'Show installed format profiles').click();
 await page.waitForFunction(()=>!!(window as any).formatState.releaseProfiles);
 await page.evaluate(()=>{const w=window as any;w.firstProfileRelease=w.formatState.releaseProfiles;});
 await button(page,'Cancel preparation').click();await button(page,'Show installed format profiles').click();
 await page.waitForFunction(()=>(window as any).formatState.profileLoads===2);
 await page.evaluate(()=>(window as any).formatState.releaseProfiles());await page.waitForFunction(()=>document.querySelectorAll('[aria-label="Installed document format profiles"] li').length===13);
 const current=await catalog(page).innerText(),message=await status(page).innerText();
 await page.evaluate(()=>(window as any).firstProfileRelease());await frames(page);
 assert.equal(await catalog(page).innerText(),current);assert.equal(await status(page).innerText(),message);assert.equal(await page.evaluate(()=>(window as any).formats.busy),false);
 assert.deepEqual(await state(page),before);await finish(page,baseline,fact);
}));
for(const mode of ['absent','denied','inactive'])test(`MFA-1.1-C2 ${mode} API state explains explicit file and manual alternatives`,()=>probe(`MFA-1.1-fallback-guidance-${mode}`,async(page,fact)=>{
 const baseline=await mount(page,{},mode),before=await state(page);await open(page);
 const guidance=await ui(page).getByLabel('File and sharing alternatives',{exact:true}).innerText();
 assert.match(guidance,/Choose a local file \(file-input fallback\)/);assert.match(guidance,/Download file/);assert.match(guidance,/Select output for manual copy/);
 assert.match(guidance,/API presence does not establish permission or delivery/);
 assert.match(guidance,mode==='absent'?/System file picker: unavailable/:/permission may be refused/);
 if(mode==='inactive')assert.match(guidance,/fresh explicit tap/);
 assert.equal((await transport(page)).calls.length,0);await button(page,'Use system file picker').click();await frames(page);
 assert.match(await status(page).innerText(),/file-input fallback/);assert.deepEqual(await state(page),before);
 await prepare(page);const a=await artifact(page),prepared=await state(page);
 assert.deepEqual({...prepared,selection:before.selection},before,'filename focus may leave the editor; no document/history mutation');
 await button(page,'Share file').click();await frames(page);assert.match(await status(page).innerText(),/Output retained/);assert.deepEqual(await artifact(page),a);
 await button(page,'Copy output').click();await frames(page);assert.match(await status(page).innerText(),/Output retained/);assert.deepEqual(await artifact(page),a);
 if(mode==='inactive')assert.equal((await transport(page)).calls.length,0);
 assert.deepEqual(await state(page),prepared);await finish(page,baseline,fact);
}));
test('MWX-C24 absent Markdown codec keeps literal text profile without claiming formatted support',()=>probe('MWX-C24-no-codec',async(page,fact)=>{
 const baseline=await mount(page,{markdown:false});await open(page);
 assert.deepEqual(await ui(page).getByLabel('Import format',{exact:true}).locator('option').evaluateAll(options=>options.map(o=>(o as HTMLOptionElement).value)),['text']);
 await input(page,'**literal**');await button(page,'Confirm import').click();assert.ok((await state(page)).nodes.some(n=>n.runs.some(r=>r.text.includes('**literal**'))));await finish(page,baseline,fact);
}));
for(const format of ['text','markdown'])test(`MWX-C21 ${format} preview is nonmutating and confirmation has one undo group`,()=>probe(`MWX-C21-${format}`,async(page,fact)=>{
 const baseline=await mount(page);await page.keyboard.type('Z');const before=await state(page);assert.equal(before.history.undoGroups,1);await open(page);await ui(page).getByLabel('Import format',{exact:true}).selectOption(format);
 await input(page,format==='markdown'?'**bold** 😀':'imported 😀',format==='markdown'?'fixture.md':'fixture.txt',format==='markdown'?'text/markdown':'text/plain');
 assert.deepEqual(await state(page),before);assert.equal(await button(page,'Confirm import').isDisabled(),false,await status(page).innerText());
 await button(page,'Confirm import').click();const after=await state(page);assert.equal(after.history.undoGroups,before.history.undoGroups+1);assert.ok(after.nodes.some(n=>n.runs.some(r=>r.text.includes(format==='markdown'?'bold':'imported'))));
 if(format==='markdown')assert.ok(after.nodes.some(n=>n.runs.some(r=>r.attributes.bold===true)));
 assert.equal(after.patches.filter(p=>p.update).length-before.patches.filter(p=>p.update).length,1);fact.committedOrigins=after.patches.filter(p=>p.update).map(p=>p.origin);
 await page.evaluate(()=>{const f=(window as any).inputFixture;f.root.focus();const command=f.surface.captureCommand('undo');try{command.execute();}finally{command.dispose();}});
 assert.deepEqual((await state(page)).nodes,before.nodes);await finish(page,baseline,fact);
}));
for(const [name,source,filename,mime] of [
 ['pdf-name','text','input.pdf','text/plain'],['pdf-mime','text','input.txt','application/pdf'],['pdf-signature','%PDF-1.7','input.txt','text/plain'],
 ['control','bad\u0000data','input.txt','text/plain'],['malformed-utf8',Buffer.from([0xff]),'input.txt','text/plain'],
] as const)test(`MWX-C21 reject ${name} before mutation`,()=>probe(`MWX-C21-${name}`,async(page,fact)=>{
 const baseline=await mount(page),before=await state(page);await open(page);await input(page,source,filename,mime);
 assert.equal(await button(page,'Confirm import').isDisabled(),true);assert.match(await status(page).innerText(),/Import not prepared/);if(name.startsWith('pdf'))assert.match(await status(page).innerText(),/FORMAT_EXPORT_ONLY/);
 assert.deepEqual(await state(page),before);await finish(page,baseline,fact);
}));
test('MWX-C21 bounded file rejects before allocation and cancellation preserves source/document',()=>probe('MWX-C21-limit-cancel',async(page,fact)=>{
 const baseline=await mount(page,{maxBytes:256}),before=await state(page);await open(page);await input(page,'x'.repeat(257));assert.match(await status(page).innerText(),/format-byte-limit/);
 await input(page,'retained source');assert.equal(await button(page,'Confirm import').isDisabled(),false);await button(page,'Cancel preparation').click();
 assert.equal(await ui(page).getByLabel('Import source preview',{exact:true}).inputValue(),'retained source');assert.equal(await button(page,'Confirm import').isDisabled(),true);assert.deepEqual(await state(page),before);await finish(page,baseline,fact);
}));
for(const mode of ['absent','denied','canceled','success'])test(`MWX-C21 prepared system picker ${mode} keeps file-input fallback`,()=>probe(`MWX-C21-picker-${mode}`,async(page,fact)=>{
 const baseline=await mount(page,{},mode),before=await state(page);await open(page);await button(page,'Use system file picker').click();await frames(page);
 assert.equal(await ui(page).getByLabel('Import file (file-input fallback)',{exact:true}).isVisible(),true);assert.deepEqual(await state(page),before);
 if(mode==='success'){await page.waitForFunction(()=>!(window as any).formats.busy);assert.equal(await button(page,'Confirm import').isDisabled(),false);assert.equal(await ui(page).getByLabel('Import source preview',{exact:true}).inputValue(),'picked 😀');}
 else assert.match(await status(page).innerText(),/fallback/);await finish(page,baseline,fact);
}));
test('MWX-C21 canceled delayed picker never reads the late handle',()=>probe('MWX-C21-picker-late',async(page,fact)=>{
 const baseline=await mount(page,{},'delayed'),before=await state(page);await open(page);await button(page,'Use system file picker').click();await button(page,'Cancel preparation').click();await page.evaluate(()=>(window as any).formatPlatform.release());await frames(page);
 assert.deepEqual((await transport(page)).calls.map(c=>c.action),['pick']);assert.deepEqual(await state(page),before);await finish(page,baseline,fact);
}));
test('MWX-C24 changed revision rejects a prepared import and preserves later selection',()=>probe('MWX-C24-stale-import',async(page,fact)=>{
 const baseline=await mount(page);await open(page);await input(page);await page.evaluate(async()=>{const f=(window as any).inputFixture;await f.remote(0,0,'remote ');f.select(f.ids[0],1);});const changed=await state(page);
 await button(page,'Confirm import').click();assert.match(await status(page).innerText(),/not applied/);assert.deepEqual(await state(page),changed);await finish(page,baseline,fact);
}));
test('MWX-C24 delayed import cancellation releases retained anchors and fences late preparation',()=>probe('MWX-C24-cancel-import',async(page,fact)=>{
 const baseline=await mount(page,{paused:true}),before=await state(page);await open(page);await input(page);await button(page,'Cancel preparation').click();await page.evaluate(()=>(window as any).formatState.release());await frames(page);
 assert.equal(await button(page,'Confirm import').isDisabled(),true);assert.deepEqual(await state(page),before);assert.ok(await page.evaluate(()=>(window as any).formatState.signals.every(s=>s.aborted)));await finish(page,baseline,fact);
}));
test('MWX-C24 read-only and composition prevent import preparation',()=>probe('MWX-C24-input-guards',async(page,fact)=>{
 const baseline=await mount(page,{readOnly:true}),before=await state(page);await open(page);await input(page);assert.equal(await button(page,'Confirm import').isDisabled(),true);assert.deepEqual(await state(page),before);
 await page.evaluate(()=>{const f=(window as any).inputFixture;f.surface.setReadOnly(false);f.select(f.ids[0],2);f.deliver('compositionstart',{data:''});});await button(page,'File and sharing').click();await page.evaluate(()=>(window as any).formats.show());
 assert.equal(await button(page,'Confirm import').isDisabled(),true);await page.evaluate(()=>(window as any).inputFixture.deliver('compositionend',{data:''}));await finish(page,baseline,fact);
}));
for(const format of ['text','markdown'])test(`MWX-C22 ${format} immutable exact-byte artifact is distinct from delivery`,()=>probe(`MWX-C22-${format}`,async(page,fact)=>{
 const baseline=await mount(page),before=await state(page);await open(page);await prepare(page,format);const a=await artifact(page),expected='alpha 😀'+(format==='markdown'?'\n':'');
 assert.equal(a.text,expected);assert.deepEqual(a.bytes,Array.from(Buffer.from(expected)));assert.equal(a.mediaType,format==='markdown'?'text/markdown':'text/plain');assert.equal(a.filename,format==='markdown'?'résumé exact.md':'résumé exact.txt');assert.deepEqual(a.diagnostics,[]);
 fact.artifact={...a,sha256:createHash('sha256').update(Buffer.from(a.bytes)).digest('hex')};assert.match(await status(page).innerText(),/not saved or shared/);
 const prepared=await state(page);fact.focusedControl=await page.evaluate(()=>document.activeElement?.textContent);assert.equal(fact.focusedControl,'Prepare export');
 assert.deepEqual({...prepared,selection:before.selection},before,'preparing output preserves semantic content/history/storage while the explicit prepare button owns native focus');
 await page.evaluate(async()=>{const f=(window as any).inputFixture;await f.remote(0,0,'new ');});assert.deepEqual(await artifact(page),a);await finish(page,baseline,fact);
}));
for(const mode of ['absent','denied','canceled','write-failure','close-failure','success'])test(`MWX-C22 prepared file save ${mode} retains exact output and truthful outcome`,()=>probe(`MWX-C22-save-${mode}`,async(page,fact)=>{
 const baseline=await mount(page,{},mode);await open(page);await prepare(page);const a=await artifact(page);await button(page,'Save file').click();await frames(page);const p=await transport(page);
 assert.deepEqual(await artifact(page),a);if(mode==='success')assert.match(await status(page).innerText(),/write and close completed/);else assert.match(await status(page).innerText(),/Output retained/);
 if(['write-failure','close-failure','success'].includes(mode)){const write=p.calls.find(c=>c.action==='write');assert.deepEqual(write,{action:'write',filename:a.filename,mediaType:a.mediaType,bytes:a.bytes});}
 if(['write-failure','close-failure'].includes(mode))assert.equal(p.aborts,1);await finish(page,baseline,fact);
}));
test('MWX-C22 actual browser download preserves requested metadata and bytes with OS filename observation separate',()=>probe('MWX-C22-download',async(page,fact)=>{
 const baseline=await mount(page);await open(page);await prepare(page);const a=await artifact(page);
 const received=page.waitForEvent('download');await button(page,'Download file').click();const download=await received;
 fact.download={requested:await page.evaluate(()=>(window as any).formatPlatform.downloads[0].filename),suggested:download.suggestedFilename(),qualification:'requested metadata exact; browser/OS Unicode spelling may normalize; actual destination delivery unverified'};
 assert.equal(fact.download.requested,a.filename);assert.equal(fact.download.suggested.normalize('NFC'),a.filename.normalize('NFC'));
 const path=join(process.env.EDITAC_MOBILE_EXTENSIONS_OUTPUT!,'download-exact.bin');await download.saveAs(path);assert.deepEqual(Array.from(readFileSync(path)),a.bytes);
 // ASCII delivery can additionally assert exact suggested code units without
 // claiming that a browser controls an OS filesystem's Unicode normalization.
 await page.evaluate(()=>(window as any).formats.filename.value='export exact.txt');await button(page,'Prepare export').click();await page.waitForFunction(()=>(window as any).formats.artifact.filename==='export exact.txt');
 const secondReceived=page.waitForEvent('download');await button(page,'Download file').click();const second=await secondReceived;assert.equal(second.suggestedFilename(),'export exact.txt');
 const secondPath=join(process.env.EDITAC_MOBILE_EXTENSIONS_OUTPUT!,'download-ascii.bin');await second.saveAs(secondPath);assert.deepEqual(Array.from(readFileSync(secondPath)),a.bytes);
 assert.match(await status(page).innerText(),/actual file delivery is unverified/);assert.equal((await transport(page)).urls.length,1);await finish(page,baseline,fact);
}));
for(const mode of ['absent','unsupported','denied','canceled','success'])test(`MWX-C23 prepared share ${mode} never discards artifact`,()=>probe(`MWX-C23-${mode}`,async(page,fact)=>{
 const baseline=await mount(page,{},mode);await open(page);await prepare(page);const a=await artifact(page);assert.deepEqual((await transport(page)).calls,[]);
 await button(page,'Share file').click();await frames(page);assert.deepEqual(await artifact(page),a);
 if(mode==='success')assert.match(await status(page).innerText(),/recipient delivery is unverified/);else assert.match(await status(page).innerText(),/No delivery is claimed/);
 if(mode==='canceled')assert.match(await status(page).innerText(),/Canceled by the user/);
 const share=(await transport(page)).calls.find(c=>c.action==='share');if(share)assert.deepEqual(share,{action:'share',filename:a.filename,mediaType:a.mediaType,bytes:a.bytes});await finish(page,baseline,fact);
}));
for(const mode of ['absent','denied','success'])test(`MWX-C24 prepared clipboard ${mode} leaves native manual selection reachable`,()=>probe(`MWX-C24-copy-${mode}`,async(page,fact)=>{
 const baseline=await mount(page,{},mode);await open(page);await prepare(page);const a=await artifact(page);await button(page,'Copy output').click();await frames(page);
 if(mode==='success')assert.match(await status(page).innerText(),/Clipboard API accepted/);else assert.match(await status(page).innerText(),/Output retained/);
 await button(page,'Select output for manual copy').click();assert.deepEqual(await page.evaluate(()=>{const e=(window as any).formats.output;return [e===document.activeElement,e.selectionStart,e.selectionEnd,e.value];}),[true,0,a.text.length,a.text]);assert.deepEqual(await artifact(page),a);await finish(page,baseline,fact);
}));
test('MWX-C24 background call without user activation cannot deliver',()=>probe('MWX-C24-no-activation',async(page,fact)=>{
 const baseline=await mount(page,{},'success');await open(page);await prepare(page);
 await page.evaluate(()=>{Object.defineProperty(navigator,'userActivation',{configurable:true,value:{isActive:false}});return(window as any).formats.deliver('share');});
 assert.deepEqual((await transport(page)).calls,[]);assert.match(await status(page).innerText(),/explicit-user-activation-required/);await finish(page,baseline,fact);
}));
test('MWX-C24 canceled write aborts the destination and cannot report late success',()=>probe('MWX-C24-write-late',async(page,fact)=>{
 const baseline=await mount(page,{},'delayed-write');await open(page);await prepare(page);await button(page,'Save file').click();await page.waitForFunction(()=>!!(window as any).formatPlatform.release);await button(page,'Cancel preparation').click();await page.evaluate(()=>(window as any).formatPlatform.release());await frames(page);
 assert.equal((await transport(page)).aborts,1);assert.equal((await transport(page)).calls.some(c=>c.action==='close'),false);assert.match(await status(page).innerText(),/^Canceled/);assert.ok(await artifact(page));await finish(page,baseline,fact);
}));
test('MWX-C24 replacing the Session fences a delayed export',()=>probe('MWX-C24-session-switch',async(page,fact)=>{
 const baseline=await mount(page,{paused:true});await open(page);await button(page,'Prepare export').click();await page.waitForFunction(()=>!!(window as any).formatState.release);
 await page.evaluate(async()=>{await(window as any).inputFixture.destroy();await(window as any).inputFixture.recover();(window as any).formatState.release();});await frames(page);
 assert.equal(await artifact(page),null);await finish(page,baseline,fact);
}));
test('MWX-C24 bounded export rejects oversized output without truncation',()=>probe('MWX-C24-export-limit',async(page,fact)=>{
 const baseline=await mount(page,{text:'x'.repeat(257),maxBytes:256}),before=await state(page);await open(page);await button(page,'Prepare export').click();await frames(page);
 assert.equal(await artifact(page),null);assert.match(await status(page).innerText(),/format-byte-limit/);assert.deepEqual(await state(page),before);await finish(page,baseline,fact);
}));
test('MWX-C24 production touch controls remain bounded under prepared viewport changes',()=>probe('MWX-C24-targets',async(page,fact)=>{
 const baseline=await mount(page),before=await state(page);await open(page);
 const buttons=await ui(page).getByRole('button').all();fact.targets=[];for(const control of buttons){if(!(await control.isVisible()))continue;const box=await control.evaluate(e=>{const s=getComputedStyle(e),r=e.getBoundingClientRect();return {name:e.textContent,width:r.width,height:r.height,minWidth:parseFloat(s.minWidth),minHeight:parseFloat(s.minHeight),touchAction:s.touchAction};});assert.ok(box.minWidth>=44&&box.minHeight>=44);assert.ok(box.width>=43.99&&box.height>=43.99);assert.notEqual(box.touchAction,'none');fact.targets.push(box);}
 await page.evaluate(()=>{(window as any).mobileGeometry={visual:{left:0,top:0,width:390,height:280},scale:2};(window as any).editor.viewport.invalidate();});await frames(page);
 fact.panel=await ui(page).evaluate(e=>{const p=(window as any).formats.panel;return {width:e.getBoundingClientRect().width,maxHeight:getComputedStyle(p).maxHeight,overflow:getComputedStyle(p).overflowY};});assert.equal(fact.panel.overflow,'auto');
 assert.deepEqual(await state(page),before);await button(page,'Close file and sharing').click();assert.equal(await button(page,'File and sharing').evaluate(e=>e===document.activeElement),true);await finish(page,baseline,fact);
}));
test('MWX-C21 import retains the opening target when the user later moves the caret',()=>probe('MWX-C21-retained-selection',async(page,fact)=>{
 const baseline=await mount(page);await open(page);await input(page,'insert');
 await page.evaluate(()=>{const f=(window as any).inputFixture;f.select(f.ids[0],5);});await frames(page);
 await button(page,'Confirm import').click();const after=await state(page);assert.equal(after.nodes.filter(n=>n.kind==='block').map(n=>n.runs.map(r=>r.text).join('')).join('\n'),'alinsertpha 😀');assert.equal(after.history.undoGroups,1);await finish(page,baseline,fact);
}));
test('MWX-C22 delayed export is a single captured revision and its public bytes are defensive copies',()=>probe('MWX-C22-delayed-snapshot',async(page,fact)=>{
 const baseline=await mount(page,{paused:true}),revision=await page.evaluate(()=>(window as any).inputFixture.engine.read().revision);await open(page);await button(page,'Prepare export').click();await page.waitForFunction(()=>!!(window as any).formatState.release);
 await page.evaluate(async()=>{const f=(window as any).inputFixture;await f.remote(0,0,'new ');(window as any).formatState.release();});await page.waitForFunction(()=>!!(window as any).formats.artifact);
 const a=await artifact(page);assert.equal(a.revision,revision);assert.ok(await page.evaluate(r=>(window as any).inputFixture.engine.read().revision>r,revision));assert.equal(a.text,'alpha 😀');
 await page.evaluate(()=>{(window as any).formats.artifact.bytes.fill(0);});assert.deepEqual(await artifact(page),a);assert.match(await status(page).innerText(),/not saved or shared/);await finish(page,baseline,fact);
}));
for(const action of ['save','share'])test(`MWX-C24 canceled delayed ${action} cannot report late success`,()=>probe(`MWX-C24-late-${action}`,async(page,fact)=>{
 const baseline=await mount(page,{},'delayed');await open(page);await prepare(page);const a=await artifact(page);await button(page,action==='save'?'Save file':'Share file').click();await page.waitForFunction(()=>!!(window as any).formatPlatform.release);
 await button(page,'Cancel preparation').click();await page.evaluate(()=>(window as any).formatPlatform.release());await frames(page);assert.match(await status(page).innerText(),/^Canceled/);assert.deepEqual(await artifact(page),a);
 if(action==='save')assert.equal((await transport(page)).calls.some(c=>c.action==='createWritable'),false);await finish(page,baseline,fact);
}));

async function installed(page,options={},mode='absent') {
 const baseline=await mount(page,{text:'qualified body',catalog:'installed',client:true,...options},mode);await open(page);
 await button(page,'Show installed format profiles').tap();await page.waitForFunction(()=>!(window as any).formats.busy);
 return baseline;
}
async function prepareDocument(page,format,filename=`exact.${format}`){
 await ui(page).getByLabel('Export format',{exact:true}).selectOption(format);await ui(page).getByLabel('Output filename',{exact:true}).fill(filename);
 await button(page,'Prepare export').tap();await page.waitForFunction(()=>!(window as any).formats.busy);
}
test('MFA-1.1-C3 operational selectors preserve exact authenticated directions without starting a converter',()=>probe('MFA-1.1-operational-menu',async(page,fact)=>{
 const baseline=await installed(page),before=await state(page),rows=facts.installedProfiles.directions;
 for(const direction of ['import','export']){
  const values=await ui(page).getByLabel(`${direction==='import'?'Import':'Export'} format`,{exact:true}).locator('option').evaluateAll(options=>options.map(o=>({value:(o as HTMLOptionElement).value,label:o.textContent})));
  assert.deepEqual(values.slice(2),rows.filter(r=>r.direction===direction&&r.target==='browser-worker-wasm32').map(r=>({value:r.format,label:`${direction==='import'?'Import':'Export'}: ${r.format.toUpperCase()} — ${r.profile}; fidelity: ${r.fidelity}`})));
 }
 assert.equal(await page.evaluate(()=>(window as any).formatState.clientLoads),0);assert.equal(fact.requests.some(url=>/worker\.js|formats_wasm/.test(url)),false);
 assert.match(await catalog(page).innerText(),/Qualified document actions are available/);
 assert.equal(await ui(page).getByLabel('Import file (file-input fallback)',{exact:true}).getAttribute('accept').then(v=>v!.includes('.pdf')),false);
 assert.deepEqual(await transport(page),{calls:[],permissions:0,aborts:0,urls:[],created:0,revoked:0});assert.deepEqual(await state(page),before);await finish(page,baseline,fact);
}));
for(const format of ['rtf','docx','odt','epub','pdf'])test(`MFA-1.1-C4 actual installed ${format} export is available from touch controls`,()=>probe(`MFA-1.1-worker-export-${format}`,async(page,fact)=>{
 const baseline=await installed(page,{},'denied'),before=await state(page);
 await prepareDocument(page,format,`résumé exact.${format}`);const a=await artifact(page);assert.ok(a,await status(page).innerText());
 assert.equal(a.format,format);assert.equal(a.filename,`résumé exact.${format}`);assert.ok(a.bytes.length>20);
 assert.match(await status(page).innerText(),/Prepared revision .*not saved or shared/);
 assert.equal((await transport(page)).calls.length,0);const prepared=await state(page);assert.deepEqual({...prepared,selection:before.selection},before);
 const buffer=Buffer.from(a.bytes);fact.output={sha256:createHash('sha256').update(buffer).digest('hex'),bytes:buffer.length,mediaType:a.mediaType,revision:a.revision};
 if(format==='rtf')assert.ok(buffer.toString().startsWith('{\\rtf'));else if(format==='pdf')assert.equal(buffer.subarray(0,5).toString(),'%PDF-');else assert.equal(buffer.subarray(0,2).toString(),'PK');
 await button(page,'Share file').tap();await page.waitForFunction(()=>!(window as any).formats.busy);assert.match(await status(page).innerText(),/Output retained/);assert.deepEqual(await artifact(page),a);
 if(format!=='rtf'){
  assert.doesNotMatch(await status(page).innerText(),/Select output for manual copy/);
  await button(page,'Copy output').tap();assert.match(await status(page).innerText(),/Text copy is unavailable/);
  await button(page,'Select output for manual copy').tap();assert.match(await status(page).innerText(),/Binary output retained/);
  assert.equal((await transport(page)).calls.filter(c=>c.action==='copy').length,0);
 }
 const downloadPromise=page.waitForEvent('download');await button(page,'Download file').tap();const download=await downloadPromise;
 assert.equal(download.suggestedFilename(),a.filename);const stream=await download.createReadStream();const chunks=[];for await(const chunk of stream!)chunks.push(chunk);
 assert.deepEqual(Buffer.concat(chunks),buffer);assert.deepEqual(await artifact(page),a);assert.equal((await transport(page)).calls.some(c=>['save','write'].includes(c.action)),false);
 assert.ok(fact.requests.some(url=>url.includes('installed-formats/dist/worker.js')));assert.ok(fact.requests.some(url=>url.includes('editac_formats_wasm_bg.wasm')));
 await finish(page,baseline,fact);
}));
for(const format of ['rtf','docx','odt','epub'])test(`MFA-1.1-C4 installed ${format} file-input preview uses existing Session confirmation`,()=>probe(`MFA-1.1-worker-import-${format}`,async(page,fact)=>{
 const baseline=await installed(page);await prepareDocument(page,format);const exported=await artifact(page);assert.ok(exported,await status(page).innerText());
 await ui(page).getByLabel('Import format',{exact:true}).selectOption(format);
 const before=await state(page);
 const source = format==='rtf' ? Buffer.from('{\\rtf1\\ansi imported \\b bold\\b0 text}') : Buffer.from(exported.bytes);
 if(format!=='rtf')await ui(page).getByLabel('Approve reported format loss',{exact:true}).check();
 await ui(page).getByLabel('Import file (file-input fallback)',{exact:true}).setInputFiles({name:exported.filename,mimeType:exported.mediaType,buffer:source});
 await page.waitForFunction(()=>!(window as any).formats.busy);
 assert.match(await status(page).innerText(),/Preview ready; document unchanged/);const preview=await state(page);assert.deepEqual({...preview,selection:before.selection},before);
 const confirm=ui(page).getByRole('button',{name:/^Confirm import/});await confirm.tap();await frames(page);
 assert.match(await status(page).innerText(),/Import applied as one editor command/);const after=await state(page);
 assert.notDeepEqual(after.nodes,before.nodes);assert.equal(after.journal.length,before.journal.length+1);assert.equal(after.history.undoGroups,before.history.undoGroups+1);
 await page.evaluate(()=>{const f=(window as any).inputFixture;f.root.focus();const command=f.surface.captureCommand('undo');try{command.execute();}finally{command.dispose();}});await frames(page);
 const undone=await state(page);assert.deepEqual(undone.nodes.map(n=>n.runs),before.nodes.map(n=>n.runs));assert.deepEqual(await artifact(page),exported);await finish(page,baseline,fact);
}));
for(const format of ['csv','tsv'])test(`MFA-1.1-C4 explicit ${format} dialect and table selection use installed conversion`,()=>probe(`MFA-1.1-worker-table-${format}`,async(page,fact)=>{
 const baseline=await installed(page);await ui(page).getByLabel('Import format',{exact:true}).selectOption(format);
 await ui(page).getByLabel('Table file line endings',{exact:true}).selectOption('crlf');
 const source=format==='csv'?'"name","value"\r\n"a","b"\r\n':'"name"\t"value"\r\n"a"\t"b"\r\n';
 await input(page,source,`table.${format}`,format==='csv'?'text/csv':'text/tab-separated-values');assert.match(await status(page).innerText(),/Preview ready/);
 await ui(page).getByRole('button',{name:/^Confirm import/}).tap();await frames(page);
 await button(page,'Close file and sharing').tap();await open(page);
 await prepareDocument(page,format);assert.match(await status(page).innerText(),/Choose one table explicitly/);assert.equal(await artifact(page),null);
 const choices=await ui(page).getByLabel('Table to export',{exact:true}).locator('option').evaluateAll(options=>options.map(o=>(o as HTMLOptionElement).value));assert.equal(choices.length,2);
 await ui(page).getByLabel('Table to export',{exact:true}).selectOption(choices[1]);
 await ui(page).getByLabel('Approve reported format loss',{exact:true}).check();
 await prepareDocument(page,format);const a=await artifact(page);assert.ok(a,await status(page).innerText());assert.equal(a.text,source);assert.equal(Buffer.from(a.bytes).toString(),source);
 fact.output={sha256:createHash('sha256').update(Buffer.from(a.bytes)).digest('hex'),bytes:a.bytes.length,mediaType:a.mediaType};await finish(page,baseline,fact);
}));
for(const action of ['cancel','dispose'])test(`MFA-1.1-C4 ${action} releases late optional client without worker or output`,()=>probe(`MFA-1.1-client-${action}`,async(page,fact)=>{
 const baseline=await installed(page,{client:'paused'}),before=await state(page);
 await ui(page).getByLabel('Export format',{exact:true}).selectOption('docx');await button(page,'Prepare export').tap();
 await page.waitForFunction(()=>!!(window as any).formatState.releaseClient);
 if(action==='dispose')await page.evaluate(()=>(window as any).formats.dispose());else await button(page,'Cancel preparation').tap();
 await page.evaluate(()=>(window as any).formatState.releaseClient());await page.waitForFunction(()=>(window as any).formatState.clientDisposals===1);
 assert.equal(await artifact(page),null);assert.equal(fact.requests.some(url=>/worker\.js|formats_wasm/.test(url)),false);const after=await state(page);assert.deepEqual({...after,selection:before.selection},before);await finish(page,baseline,fact);
}));
