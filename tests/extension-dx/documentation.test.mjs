import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFileSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { browserHarness } from '../browser/browser-harness.ts';
import { prepareDocumentationConsumer } from './documentation-consumer.mjs';
import { validateManifest, publicImports, sha } from '../../scripts/extension-documentation-manifest.mjs';
const manifest=JSON.parse(readFileSync('docs/extensions/recipe-manifest.json','utf8'));
const output=resolve(process.env.EDITAC_EXTENSION_DX_OUTPUT);
process.env.EDITAC_DOCUMENTATION_OUTPUT=join(output,'browser');
const {probe}=browserHarness('documentation',resolve('tests/extension-dx/documentation-consumer'),{
  autoMount:false,markdown:false,prepareConsumer:prepareDocumentationConsumer,
  testFile:'tests/extension-dx/documentation.test.mjs',assertSourcesUnchanged:true,
  sourcePaths:[...manifest.recipes.map(r=>r.source),...manifest.guides.map(g=>g.path),
    'docs/extensions/recipe-manifest.json','scripts/extension-documentation-manifest.mjs',
    'scripts/test-extension-dx.mjs','tests/extension-dx/documentation-consumer.mjs',
    'tests/extension-dx/documentation-consumer/session.mjs','tests/extension-dx/documentation-consumer/index.html'],
  cleanup:p=>p.evaluate(()=>window.documentationFixture?.close()),
});
function check(name,run){test(name,()=>probe(name.replace(/[^a-zA-Z0-9-]/g,'-'),async p=>{await p.waitForFunction(()=>!!window.documentationFixture);await run(p);}));}
test('DXC-22 all nine pinned ranges match six guides and current versions',()=>assert.equal(validateManifest(manifest).length,9));
for(const [label,change] of [
  ['source hash',m=>m.recipes[0].sha256='0'.repeat(64)],
  ['source range',m=>m.recipes[0].endLine+=100],
  ['package version',m=>m.packages['@edit-ac/web']='999.0.0'],
  ['guide hash',m=>m.guides[0].sha256='0'.repeat(64)],
  ['missing recipe',m=>m.recipes.pop()],
  ['export identity',m=>m.recipes[0].exports='missingExport'],
  ['output path',m=>m.recipes[0].output='../private.ts'],
]) test(`DXC-22 rejects stale ${label}`,()=>{const m=structuredClone(manifest);change(m);assert.throws(()=>validateManifest(m));});
for(const source of ["import x from '@edit-ac/web/src/editor.js'", "export * from '@edit-ac/web/dist/index.js'", "import x from '../../packages/web/src/index.js'", "const x = import('@edit-ac/core/wasm/private.js')", "const x = import(name)"])
  test(`DXC-22 rejects private or nonliteral module ${source}`,()=>assert.throws(()=>publicImports(source)));
test('DXC-22 changed guide content with refreshed hash still rejects stale snippet',()=>{
  const m=structuredClone(manifest),path=m.recipes[0].guide;
  const changed=readFileSync(path,'utf8').replace('DocumentSearch.configure()', 'DocumentSearch.configure({stale:true})');
  m.guides.find(g=>g.path===path).sha256=sha(changed);
  assert.throws(()=>validateManifest(m,p=>p===path?changed:readFileSync(p,'utf8')),/Stale documented range/);
});
check('DXC-22 one import local configuration starts without provider and preserves content',async p=>{
 const r=await p.evaluate(async()=>{const f=window.documentationFixture,e=await f.local();return {text:f.content(e),providers:!!e.extensionConfiguration.collaboration,search:e.extensionConfiguration.extensions.map(x=>x.feature.id)};});
 assert.equal(r.text,'Alpha beta');assert.equal(r.providers,false);assert.ok(r.search.includes('editac.search'));
});
check('DXC-22 typed behavior command changes only bold and has one undo redo',async p=>{
 const r=await p.evaluate(async()=>{const f=window.documentationFixture,e=await f.open({extensions:[f.EmphasisShortcut.configure()]});f.select(e.root,0,5);e.runExtensionCommand('example.documented-emphasis','emphasize');const bold=f.runs(e).filter(r=>r.attributes.bold).map(r=>r.text);f.history(e,'undo');const undone=f.runs(e).some(r=>r.attributes.bold);f.history(e,'redo');return {bold,undone,redone:f.runs(e).some(r=>r.attributes.bold),text:f.content(e)};});
 assert.deepEqual(r,{bold:['Alpha'],undone:false,redone:true,text:'Alpha beta'});
});
for(const mode of ['disabled','readonly'])check(`DXC-22 behavior ${mode} leaves data unchanged`,async p=>{
 const r=await p.evaluate(async mode=>{const f=window.documentationFixture,e=await f.open({extensions:[f.EmphasisShortcut.configure({enabled:mode!=='disabled'})]});f.select(e.root,0,5);if(mode==='readonly')e.setReadOnly(true);const before=JSON.stringify(e.read().visible);let rejected=false;try {e.runExtensionCommand('example.documented-emphasis','emphasize');}catch(error){if(mode!=='readonly'||!error.message.startsWith('Extension attachment is readonly'))throw error;rejected=true;}if(mode==='readonly'&&!rejected)throw Error('Missing rejection');return before===JSON.stringify(e.read().visible);},mode);assert.equal(r,true);
});
for(const [factory,id] of [['ReviewMark','example.documented-review'],['TicketAtom','example.documented-ticket']])check(`DXC-22 ${factory} stores admitted data with source fallback and atomic undo`,async p=>{
 const r=await p.evaluate(async({factory,id})=>{const f=window.documentationFixture,e=await f.open({extensions:[f[factory].configure()]});f.select(e.root,0,5);e.runExtensionCommand(id,'insert','Review');const after={text:f.content(e),data:f.runs(e)[0].attributes['module:'+id]};f.history(e,'undo');return {after,undone:f.content(e)};},{factory,id});
 assert.deepEqual(r,{after:{text:'Review beta',data:[1,{label:'Review'}]},undone:'Alpha beta'});
});
check('DXC-22 oversized data command leaves source unchanged',async p=>assert.equal(await p.evaluate(async()=>{const f=window.documentationFixture,e=await f.open({extensions:[f.ReviewMark.configure()]});f.select(e.root,0,5);e.runExtensionCommand('example.documented-review','insert','x'.repeat(65));return f.content(e);}), 'Alpha beta'));
check('DXC-22 lifecycle input has prepared result history and complete resource teardown',async p=>{
 const r=await p.evaluate(async()=>{const f=window.documentationFixture,status=[],e=await f.open({extensions:[f.lifecycleRecipe(s=>status.push(s)).configure()]});f.select(e.root,0,5);e.root.dispatchEvent(new KeyboardEvent('keydown',{key:'F8',bubbles:true,cancelable:true}));await f.flush(e);const after=f.content(e);f.history(e,'undo');const undone=f.content(e);await e.destroy({policy:'report'});await f.flush(e).catch(()=>{});return {after,undone,status};});
 assert.equal(r.after,'Ready beta');assert.equal(r.undone,'Alpha beta');assert.deepEqual([...r.status].sort(),['attached','disposed','ready','resource-disposed'].sort());
});
check('DXC-22 actual prepared task catalog finds ASD-123 and returns missing independently',async p=>{
 const r=await p.evaluate(async()=>{const h=window.documentationFixture.preparedTaskCatalog;return [await h.resolve({text:'ASD-123'}),await h.resolve({text:'ASD-999'})];});assert.deepEqual(r,[{status:'available',href:'https://tasks.example.test/ASD-123'},{status:'missing'}]);
});
for(const kind of ['task','url']) {
 check(`DXC-22 ${kind} found result preserves source and undo redo`,async p=>{
  const r=await p.evaluate(async kind=>{const f=window.documentationFixture,{editor:e}=await f.resolved(kind);const text=f.content(e),links=f.runs(e).filter(r=>r.attributes.link).map(r=>[r.text,r.attributes.link]);f.history(e,'undo');const undone=f.runs(e).some(r=>r.attributes.link);f.history(e,'redo');return {text,links,undone,redone:f.runs(e).some(r=>r.attributes.link)};},kind);
  const source=kind==='task'?'ASD-123':'https://notes.example.test/one';assert.deepEqual(r,{text:source+' ',links:[[source,'https://tasks.example.test/ASD-123']],undone:false,redone:true});
 });
 for(const result of [{status:'missing'},{status:'forbidden'},{status:'available',href:'javascript:alert(1)'}])check(`DXC-22 ${kind} ${result.status} ${result.href??''} preserves literal source`,async p=>{
  const r=await p.evaluate(async({kind,result})=>{const f=window.documentationFixture,{editor:e}=await f.resolved(kind,{result});return {text:f.content(e),linked:f.runs(e).some(r=>r.attributes.link)};},{kind,result});assert.equal(r.linked,false);assert.equal(r.text,(kind==='task'?'ASD-123':'https://notes.example.test/one')+' ');
 });
 check(`DXC-22 ${kind} dispose aborts pending resolver and rejects late result`,async p=>{
  const r=await p.evaluate(async kind=>{const f=window.documentationFixture,m=await f.resolved(kind,{delayed:true}),call=m.calls[0];const before=JSON.stringify(m.editor.read().visible);await m.editor.destroy({policy:'report'});call.resolve({status:'available',href:'https://late.example.test/'});await new Promise(r=>setTimeout(r,10));return {aborted:call.request.signal.aborted,calls:m.calls.length,before};},kind);assert.equal(r.aborted,true);assert.equal(r.calls,1);assert.ok(r.before.includes(kind==='task'?'ASD-123':'https://notes.example.test/one'));
 });
}
check('DXC-22 parser prepares bold fragment atomically and undo restores original',async p=>{
 const r=await p.evaluate(async()=>{const f=window.documentationFixture,e=await f.open({extensions:[f.Notes.configure()]});f.select(e.root,0,10);e.paste({getData:type=>type===f.NOTE_MIME?'note/1\nb:Strong':''});const after={text:f.content(e),bold:f.runs(e)[0].attributes.bold};f.history(e,'undo');return {after,before:f.content(e)};});assert.deepEqual(r,{after:{text:'Strong',bold:true},before:'Alpha beta'});
});
check('DXC-22 parser unsupported source retains recovery and falls through literal',async p=>{
 const r=await p.evaluate(async()=>{const f=window.documentationFixture,e=await f.open({extensions:[f.Notes.configure()]});f.select(e.root,0,10);e.paste({getData:type=>type===f.NOTE_MIME?'note/2\np:Unsupported':type==='text/plain'?'Retained':''});return {text:f.content(e),recovery:e.clipboardRecovery};});assert.equal(r.text,'Retained');assert.ok(r.recovery.some(x=>x.raw==='note/2\np:Unsupported'));
});
check('DXC-22 prepared spelling accessible suggestion replaces one intent and disposes UI',async p=>{
 const r=await p.evaluate(async()=>{const f=window.documentationFixture,container=document.createElement('aside');document.body.append(container);const c=f.preparedSpelling(container),e=await f.open(c,{},'teh');f.insert(e,' ');for(let i=0;i<10&&!container.querySelector('button');i++)await f.flush(e);const b=container.querySelector('button[aria-label="Replace teh with the"]');if(!b)throw Error('Missing accessible suggestion');b.click();await f.flush(e);const after=f.content(e);f.history(e,'undo');const undone=f.content(e);await e.destroy({policy:'report'});return {after,undone,ui:container.children.length};});assert.deepEqual(r,{after:'the ',undone:'teh ',ui:0});
});
check('DXC-22 task edited target rejects stale authorized result',async p=>{
 const r=await p.evaluate(async()=>{const f=window.documentationFixture,m=await f.resolved('task',{delayed:true});f.select(m.editor.root,0,7);m.editor.paste({getData:t=>t==='text/plain'?'Changed':''});m.calls[0].resolve({status:'available',href:'https://stale.example.test/'});await f.flush(m.editor);return {text:f.content(m.editor),linked:f.runs(m.editor).some(r=>r.attributes.link)};});assert.deepEqual(r,{text:'Changed ',linked:false});
});
check('DXC-22 URL data representation retains exact fallback without presenter',async p=>{
 const r=await p.evaluate(async()=>{const f=window.documentationFixture,{editor:e}=await f.resolved('url',{representation:'reference'});return {text:f.content(e),data:f.runs(e)[0].attributes['module:example.url-reference']};});assert.deepEqual(r,{text:'https://notes.example.test/one ',data:[1,{href:'https://tasks.example.test/ASD-123',label:'https://notes.example.test/one'}]});
});
check('DXC-22 invalid configure fails with actionable fields before attachment',async p=>{
 const r=await p.evaluate(()=>{try{window.documentationFixture.EmphasisShortcut.configure({enabled:'wrong'});}catch(e){return {name:e.name,code:e.code,extension:e.extension,option:e.option,remedy:e.remedy};}});assert.equal(r.name,'ExtensionConfigurationError');assert.equal(r.extension,'example.documented-emphasis');assert.ok(r.code&&r.option&&r.remedy);
});
