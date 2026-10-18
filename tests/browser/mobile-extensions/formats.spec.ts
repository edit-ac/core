import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { join } from 'node:path';
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
  },sourcePaths:[...browserInputSources,
    '../.roadmap-runner/overnight-features-20261018/.roadmap-runner/02-mobile-extension-features-f5cf70ae3d13/source-0d7e6b959a8a.md',
    '../architecture/specs/document-conversion.md','../architecture/specs/formats.md','../architecture/tests/mobile-extension-cases.md',
    'fixtures/browser-mobile-extensions/session.mjs','fixtures/browser-mobile-extensions/index.html','fixtures/browser-mobile-extensions/format-host.mjs',
    'tests/browser/mobile-extensions/formats.spec.ts','tests/browser/mobile-extensions/index.mjs','tests/browser/mobile-extensions/case-index.json',
    'tests/mobile-web/resources.mjs','tests/browser/mobile-extensions/resources.mjs','scripts/test-mobile-extensions.mjs','packages/web/package.json',
    ...['modules/formats','modules/touch-controls','clipboard/fragment','clipboard/html','dom/selection','editor','platform/viewport'].flatMap(n=>[`packages/web/src/${n}.ts`,`packages/web/dist/${n}.js`])],
});
facts.binding={gate:'MEX-1.6',ids:['MWX-C21','MWX-C22','MWX-C23','MWX-C24'],
  semantics:'actual installed production BrowserEditor/Session/WASM/IndexedDB/Markdown and format controls',
  platform:'prepared OS transports; browser download request only; no actual OS/device delivery claim',
  pending:'qualified binary converter browser entry/worker/consumer receipt; parent remains unchecked'};
const ui=page=>page.getByRole('group',{name:'File and sharing controls',exact:true});
const button=(page,name)=>ui(page).getByRole('button',{name,exact:true});
const status=page=>ui(page).getByRole('status');
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
