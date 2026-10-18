import assert from 'node:assert/strict';
import { test } from 'node:test';
import { resolve, join } from 'node:path';
import { browserHarness } from '../browser/browser-harness.ts';
import { prepareSpellingConsumer } from './spellcheck-consumer.mjs';
const output = resolve(process.env.EDITAC_EXTENSION_DX_OUTPUT);
process.env.EDITAC_SPELLCHECK_OUTPUT = join(output, 'browser');
const { probe } = browserHarness('spellcheck', resolve('tests/extension-dx/spellcheck-consumer'), {
  autoMount: false, markdown: false, prepareConsumer: prepareSpellingConsumer,
  testFile: 'tests/extension-dx/spellcheck.test.mjs', assertSourcesUnchanged: true,
  sourcePaths: ['packages/web/src/extensions/authoring-metadata.ts','packages/web/src/extensions/spelling-metadata.ts','packages/web/src/modules/slash-metadata.ts','packages/web/src/dom/pattern-text.ts','packages/web/package.json','examples/extensions/spellcheck/spellcheck.ts', 'examples/extensions/spellcheck/README.md',
    'tests/extension-dx/spellcheck-consumer.mjs', 'tests/extension-dx/matching-consumer.mjs',
    'tests/extension-dx/spellcheck-consumer/session.mjs', 'tests/extension-dx/spellcheck-consumer/index.html', 'tests/extension-dx/spellcheck-consumer/public-smoke.ts',
    'packages/web/src/extensions/spelling.ts', 'packages/web/src/extensions/spelling-runtime.ts',
    'packages/web/src/extensions/matching.ts', 'packages/web/src/extensions/authoring.ts',
    'packages/web/src/extensions/configuration.ts', 'packages/web/src/platform/preferences.ts',
    'packages/web/src/commands/formatting.ts', 'scripts/test-extension-dx.mjs'],
  cleanup: page => page.evaluate(() => window.spellingFixture?.close()),
});
function check(name, run) { test(name, () => probe(name.replace(/[^a-zA-Z0-9-]/g,'-'), async (page, facts) => {
  page.setDefaultTimeout(5000); await page.waitForFunction(() => !!window.spellingFixture); await run(page, facts);
  if (await page.evaluate(() => !!window.spelling)) facts.spelling = await snapshot(page);
})); }
async function start(p, options = {}) { await p.evaluate(async options => { const f = window.spellingFixture, m = await f.start(options); f.insert(m.editor,' '); await f.flush(); }, options); }
async function ready(p) { await p.waitForFunction(() => window.spelling.container.querySelector('button')); }
async function snapshot(p) { return p.evaluate(async () => { const f = window.spellingFixture, s = window.spelling; await f.flush(); return {
  text: f.content(s.editor), calls: s.calls.length, loads: s.loads, groups: s.container.querySelectorAll('[role=group]').length,
  disposed: s.disposed, diagnostics: s.diagnostics, statuses: s.statuses,
  effects: s.effects, state: s.controller?.state, attrs: ['spellcheck','autocorrect','lang','autocapitalize'].map(k=>s.editor.root.getAttribute(k)),
}; }); }
async function accept(p) { await p.evaluate(() => window.spelling.suggestions.at(-1).accept(window.spelling.suggestions.at(-1).replacements[0])); await p.waitForFunction(() => window.spelling.statuses.includes('applied') || window.spelling.statuses.includes('stale') || window.spelling.statuses.includes('failed') || window.spelling.statuses.includes('cancelled')); }
check('ENV-01 platform inherits spelling and user defaults without forced enablement', async p => {
  await p.evaluate(() => document.body.setAttribute('spellcheck','false')); await start(p,{mode:'platform'});
  const s = await snapshot(p); assert.deepEqual(s.attrs,[null,null,'en',null]); assert.equal(s.loads,0); assert.equal(s.calls,0);
  assert.equal(await p.evaluate(()=>window.spelling.editor.platformPreferences.observed),'unknown');
});
check('ENV-01 explicit host spelling false survives platform mode', async p => { await start(p,{mode:'platform',attributes:{spellcheck:'false',autocorrect:'on',autocapitalize:'words'}}); const s=await snapshot(p);assert.deepEqual(s.attrs,['false','on','en','words']); });
for (const mode of ['platform','off','custom']) for (const autocorrection of ['inherit','on','off']) check(`ENV-03 independent ${mode} spelling ${autocorrection} autocorrection`, async p=>{
  await start(p,{mode,autocorrection,attributes:{spellcheck:'true',autocorrect:'on',autocapitalize:'words'}});
  if(mode==='custom') await ready(p);
  const s=await snapshot(p);assert.deepEqual(s.attrs,[mode==='platform'?'true':'false',autocorrection==='inherit'?'on':autocorrection,'en','words']);
  assert.equal(await p.evaluate(()=>window.spelling.editor.platformPreferences.observed),'unknown'); if(mode!=='custom')assert.equal(s.loads,0);
});
check('ENV-02 custom requires explicit checker and overlap resolution before attachment', async p=>{
  const errors=await p.evaluate(()=>{const f=window.spellingFixture;return [()=>f.Spelling.configure({mode:'custom'}),()=>f.Spelling.configure({mode:'custom',checker:f.hostState({}).host}),()=>f.Spelling.configure({mode:'off',checker:f.hostState({}).host})].map(fn=>{try{fn();return false;}catch{return true;}});});assert.deepEqual(errors,[true,true,true]);
});
check('ENV-02 unknown locale reports unavailable without checker download or text change', async p=>{ await start(p,{unknownLocale:true});await p.waitForFunction(()=>window.spelling.diagnostics.length);const s=await snapshot(p);assert.deepEqual(s.diagnostics,['unknown-locale']);assert.equal(s.loads,0);assert.equal(s.calls,0);assert.equal(s.text,'teh '); });
check('ENV-02 unavailable locale retains literal input without fallback',async p=>{await start(p,{locale:'zz'});await p.waitForFunction(()=>window.spelling.diagnostics.length);const s=await snapshot(p);assert.deepEqual(s.diagnostics,['unavailable-locale']);assert.equal(s.calls,0);assert.equal(s.groups,0);assert.equal(s.text,'teh ');});
check('ENV-02 unavailable checker keeps editing usable and does not invent suggestions',async p=>{await start(p,{loadFailure:true});await p.waitForFunction(()=>window.spelling.diagnostics.length);const s=await snapshot(p);assert.deepEqual(s.diagnostics,['unavailable-checker']);assert.equal(s.calls,0);assert.equal(s.text,'teh ');});
check('ENV-06 platform and off request no checker dictionary worker or optional spelling runtime',async(p,facts)=>{
  await start(p,{mode:'platform'});await start(p,{mode:'off'});const s=await snapshot(p);assert.equal(s.loads,0);assert.equal(s.calls,0);
  assert.deepEqual(facts.requests.filter(url=>/spelling-runtime|spellcheck\.js|dictionary|checker|worker/.test(url)),[]);
});
check('ENV-04 explicit suggestion applies one prepared correction at captured target and shared undo redo',async p=>{
  await start(p);await ready(p);await p.evaluate(()=>window.spellingFixture.select(window.spelling.editor.root,4));await accept(p);
  let s=await snapshot(p);assert.equal(s.text,'the ');assert.equal(s.effects.filter(e=>e.origin.includes('spelling-correction')).length,1);assert.equal(s.groups,0);assert.equal(s.calls,1);
  await p.evaluate(async()=>{window.spellingFixture.history('undo');await window.spellingFixture.flush();});s=await snapshot(p);assert.equal(s.text,'teh ');
  await p.evaluate(async()=>{window.spellingFixture.history('redo');await window.spellingFixture.flush();});assert.equal((await snapshot(p)).text,'the ');
});
check('ENV-04 real trusted browser input triggers bounded prepared checker',async p=>{
  await p.evaluate(async()=>{const f=window.spellingFixture,s=await f.start();f.select(s.editor.root,3);});await p.keyboard.type(' ');await ready(p);await accept(p);assert.equal((await snapshot(p)).text,'the ');
});
check('ENV-04 correction preserves bold formatting and replacement selection with one undo',async p=>{
  await p.evaluate(async()=>{const f=window.spellingFixture,s=await f.start();f.mark(s.editor,'bold',0,3);f.select(s.editor.root,3,0);f.insert(s.editor,' ');await f.flush();});await ready(p);await accept(p);
  const result=await p.evaluate(()=>({runs:window.spellingFixture.runs(),selection:window.spellingFixture.selection()}));assert.equal(result.runs.map(r=>r.text).join(''),'the ');assert.equal(result.runs[0].attributes.bold,true);assert.deepEqual(result.selection,[3,3]);
  await p.evaluate(()=>window.spellingFixture.history('undo'));const undone=await p.evaluate(()=>({runs:window.spellingFixture.runs(),selection:window.spellingFixture.selection()}));assert.equal(undone.runs.map(r=>r.text).join(''),'teh ');assert.equal(undone.runs[0].attributes.bold,true);assert.deepEqual(undone.selection,[0,3]);
});
check('ENV-04 Unicode decomposed word resolves in UTF16 and correction retains adjacent emoji',async p=>{await start(p,{text:'😀 café'});await ready(p);await accept(p);assert.equal((await snapshot(p)).text,'😀 café ');});
check('ENV-04 stale changed text cannot be corrected after delayed analysis',async p=>{await start(p,{delayed:true});await p.waitForFunction(()=>window.spelling.calls.length);await p.evaluate(async()=>{const f=window.spellingFixture;f.remove(window.spelling.editor,0,1);window.spelling.calls[0].resolve(['the']);await f.flush();});const s=await snapshot(p);assert.equal(s.text,'eh ');assert.equal(s.groups,0);assert.equal(s.effects.filter(e=>e.origin.includes('spelling-correction')).length,0);});
check('ENV-04 stale visible suggestion cannot apply after text changes',async p=>{await start(p);await ready(p);await p.evaluate(()=>{const s=window.spelling;window.spellingFixture.remove(s.editor,0,1);s.suggestions[0].accept('the');});assert.equal((await snapshot(p)).text,'eh ');});
check('ENV-04 readonly acceptance has zero replacement history effect',async p=>{await start(p);await ready(p);await p.evaluate(()=>window.spelling.editor.setReadOnly(true));await accept(p);const s=await snapshot(p);assert.equal(s.text,'teh ');assert.equal(s.effects.filter(e=>e.origin.includes('spelling-correction')).length,0);});
check('ENV-06 composition prevents suggestion acceptance and speculative mutation',async p=>{await start(p);await ready(p);await p.evaluate(()=>window.spelling.editor.root.dispatchEvent(new CompositionEvent('compositionstart',{bubbles:true,data:''})));await accept(p);assert.equal((await snapshot(p)).text,'teh ');});
check('ENV-06 composition suppresses changed-range checker work',async p=>{await p.evaluate(async()=>{const f=window.spellingFixture,s=await f.start();s.editor.root.dispatchEvent(new CompositionEvent('compositionstart',{bubbles:true,data:''}));f.insert(s.editor,' ');await f.flush();});const s=await snapshot(p);assert.equal(s.calls,0);assert.equal(s.loads,0);});
for(const mark of ['code','link'])check(`ENV-05 ${mark} exclusions retain literal source and load no checker`,async p=>{await p.evaluate(async mark=>{const f=window.spellingFixture,s=await f.start();f.mark(s.editor,mark,0,3);f.insert(s.editor,' ');await f.flush();},mark);const s=await snapshot(p);assert.equal(s.calls,0);assert.equal(s.loads,0);assert.equal(s.text,'teh ');});
check('ENV-06 invalid checker result has explicit diagnostic and no document effect',async p=>{await start(p,{invalidResult:true});await p.waitForFunction(()=>window.spelling.diagnostics.length);const s=await snapshot(p);assert.deepEqual(s.diagnostics,['invalid-result']);assert.equal(s.groups,0);assert.equal(s.text,'teh ');});
check('ENV-06 analysis rejection retains text and history',async p=>{await start(p,{delayed:true});await p.waitForFunction(()=>window.spelling.calls.length);await p.evaluate(()=>window.spelling.calls[0].reject(Error('prepared denied')));await p.waitForFunction(()=>window.spelling.diagnostics.length);assert.equal((await snapshot(p)).text,'teh ');});
check('ENV-06 unknown word creates no suggestion or semantic mark',async p=>{await start(p,{text:'unknown'});await p.waitForFunction(()=>window.spelling.statuses.includes('missing'));const s=await snapshot(p);assert.equal(s.text,'unknown ');assert.equal(s.groups,0);assert.equal(s.effects.filter(e=>e.origin.includes('spelling-correction')).length,0);});
check('ENV-05 disposal restores SDK attrs while preserving newer host choices',async p=>{await start(p,{direct:true,attributes:{spellcheck:'true',autocorrect:'on',lang:'hu'},autocorrection:'off'});await ready(p);const attrs=await p.evaluate(()=>{const s=window.spelling;s.editor.root.setAttribute('lang','fr');s.surface.dispose();s.surface.dispose();return ['spellcheck','autocorrect','lang'].map(k=>s.editor.root.getAttribute(k));});assert.deepEqual(attrs,['true','on','fr']);assert.equal((await snapshot(p)).groups,0);});
check('ENV-06 disposal cancels delayed checker and stale acceptance',async p=>{await start(p,{direct:true,delayed:true});await p.waitForFunction(()=>window.spelling.calls.length);await p.evaluate(async()=>{const s=window.spelling;s.surface.dispose();s.calls[0].resolve(['the']);await window.spellingFixture.flush();});const s=await snapshot(p);assert.equal(s.text,'teh ');assert.equal(s.groups,0);assert.equal(s.state.pending,0);});
check('ENV-04 foreign editable focus never retargets or applies a correction',async p=>{await start(p);await ready(p);await p.evaluate(()=>{const input=document.createElement('input');input.value='host';document.body.append(input);input.focus();window.spelling.suggestions[0].accept('the');});await p.waitForFunction(()=>window.spelling.statuses.includes('failed'));assert.equal((await snapshot(p)).text,'teh ');});
check('ENV-06 concurrent editor modes and mutable checker state remain isolated',async p=>{await p.evaluate(async()=>{const f=window.spellingFixture,a=await f.start(),b=await f.start({mode:'off'});window.otherSpelling=a;f.insert(a.editor,' ');f.insert(b.editor,' ');await f.flush();});await p.waitForFunction(()=>window.otherSpelling.calls.length===1);const result=await p.evaluate(()=>{const a=window.otherSpelling,b=window.spelling;return {a:a.calls.length,b:b.calls.length,loads:b.loads,attr:b.editor.root.getAttribute('spellcheck'),text:window.spellingFixture.content(b.editor)};});assert.deepEqual(result,{a:1,b:0,loads:0,attr:'false',text:'teh '});});
check('ENV-06 deadline removes ephemeral suggestions without text or history effects',async p=>{await start(p,{timeoutMs:200});await ready(p);await p.waitForFunction(()=>window.spelling.statuses.includes('deadline'));const s=await snapshot(p);assert.equal(s.groups,0);assert.equal(s.text,'teh ');assert.equal(s.state.pending,0);});
check('ENV-04 accessible suggestion button applies exactly once and disposes presentation',async p=>{await start(p);await ready(p);await p.getByRole('button',{name:'Replace teh with the',exact:true}).click();await p.waitForFunction(()=>window.spelling.statuses.includes('applied'));await p.evaluate(()=>window.spelling.suggestions[0].accept('the'));const s=await snapshot(p);assert.equal(s.text,'the ');assert.equal(s.disposed,1);assert.equal(s.effects.filter(e=>e.origin.includes('spelling-correction')).length,1);});
check('ENV-04 unrelated edit rebases captured correction while preserving independent text',async p=>{await start(p,{text:'prefix teh'});await ready(p);await p.evaluate(()=>window.spellingFixture.insert(window.spelling.editor,'X',0,'local:unrelated'));await accept(p);assert.equal((await snapshot(p)).text,'Xprefix the ');});
check('ENV-04 remote overlapping edit cancels visible suggestions without retargeting',async p=>{await start(p,{direct:true});await ready(p);await p.evaluate(async()=>{const f=window.spellingFixture,s=window.spelling,a=s.engine,c=a.checkpoint(),b=f.runtime.restoreEngine(c.identity,c);try{f.remove(b,0,1);a.applyUpdate(b.encodeUpdate());s.suggestions[0].accept('the');await f.flush();}finally{b.dispose();}});const s=await snapshot(p);assert.equal(s.text,'eh ');assert.equal(s.groups,0);assert.equal(s.effects.filter(e=>e.origin.includes('spelling-correction')).length,0);});
check('ENV-07 undo cancels pending spelling before late checker completion',async p=>{await start(p,{delayed:true});await p.waitForFunction(()=>window.spelling.calls.length);await p.evaluate(async()=>{const s=window.spelling,f=window.spellingFixture;f.history('undo');s.calls[0].resolve(['the']);await f.flush();});const s=await snapshot(p);assert.equal(s.text,'teh');assert.equal(s.groups,0);assert.equal(s.effects.filter(e=>e.origin.includes('spelling-correction')).length,0);});
check('ENV-05 literal input bypass does not load custom runtime analysis',async p=>{await p.evaluate(async()=>{const f=window.spellingFixture,s=await f.start();f.insert(s.editor,' ',undefined,'text-input:literal');await f.flush();});const s=await snapshot(p);assert.equal(s.loads,0);assert.equal(s.calls,0);});
check('ENV-06 dismiss cancels current suggestion with no replacement and bounded resource release',async p=>{await start(p);await ready(p);await p.getByRole('button',{name:'Dismiss',exact:true}).click();await p.waitForFunction(()=>window.spelling.controller.state.pending===0);const s=await snapshot(p);assert.equal(s.groups,0);assert.equal(s.text,'teh ');assert.equal(s.disposed,1);assert.equal(s.state.active,0);});
check('ENV-01 default platform preserves absent language hint and explicit host language',async p=>{await start(p,{mode:'platform',unknownLocale:true,attributes:{lang:'hu',spellcheck:'false'}});const s=await snapshot(p);assert.deepEqual(s.attrs,['false',null,'hu',null]);assert.equal(s.calls,0);});
check('ENV-05 code block excludes custom checking through engine semantics',async p=>{await p.evaluate(async()=>{const f=window.spellingFixture,s=await f.start(),owner=s.editor.read().visible.find(n=>n.kind==='block').id;s.editor.commit({kind:'editor',origin:'local:code-policy',commands:[{type:'setCode',owner,language:'text'}]});f.insert(s.editor,' ');await f.flush();});const s=await snapshot(p);assert.equal(s.loads,0);assert.equal(s.calls,0);assert.equal(s.text,'teh ');});
for (const text of ['123teh','teh_name','x-teh']) check(`ENV-05 identifier exclusion preserves ${text}`,async p=>{await start(p,{text});const s=await snapshot(p);assert.equal(s.calls,0);assert.equal(s.loads,0);assert.equal(s.text,text+' ');});
check('ENV-04 formatting boundary uses qualified first-character style and restores original mixed marks on undo',async p=>{
  await p.evaluate(async()=>{const f=window.spellingFixture,s=await f.start({text:'teh tail'});f.mark(s.editor,'bold',0,1);f.mark(s.editor,'italic',1,3);f.insert(s.editor,' ',3);await f.flush();});await ready(p);await accept(p);
  const result=await p.evaluate(()=>window.spellingFixture.runs());assert.equal(result[0].text,'the');assert.equal(result[0].attributes.bold,true);assert.equal(result[0].attributes.italic,undefined);assert.equal(result.map(r=>r.text).join(''),'the  tail');
  await p.evaluate(()=>window.spellingFixture.history('undo'));const undone=await p.evaluate(()=>window.spellingFixture.runs());assert.equal(undone[0].text,'t');assert.equal(undone[0].attributes.bold,true);assert.equal(undone[1].text,'eh ');assert.equal(undone[1].attributes.italic,true);
});
check('ENV-05 remount from custom to platform restores attributes and cancels former suggestions',async p=>{
  await start(p,{direct:true,attributes:{spellcheck:'true',autocorrect:'on'}});await ready(p);
  await p.evaluate(async()=>{const f=window.spellingFixture,s=window.spelling;s.surface.dispose();const surface=f.mountEditorSurface(s.editor.root,s.engine,f.Spelling.configure({mode:'platform'}));f.surfaces.push(surface);await surface.ready;s.suggestions[0].accept('the');await f.flush();});const s=await snapshot(p);assert.equal(s.text,'teh ');assert.equal(s.attrs[0],'true');assert.equal(s.attrs[1],'on');assert.equal(s.groups,0);
});
check('ENV-04 matching application families reject replacement injection into link consumers and link injection into spelling',async p=>{
  await p.evaluate(async()=>{const f=window.spellingFixture;await f.start({mode:'off'});window.familyProbes=[];
    for(const application of ['link','replacement']) {
      const statuses=[],engine=f.engine('teh'),host=f.root();
      const feature={...f.Spelling.configure({mode:'custom',overlap:'allow',checker:f.hostState({}).host}).extensions[0].feature,id:'probe.family-'+application};
      const extension=f.Extension.create({apiVersion:1,feature,semantics:{kind:'behavior'},defaults:{},validateOptions:()=>true,loading:'required-input',interests:[],onAttach(_,context){context.match({application,match:()=>[{start:0,end:3,text:'teh'}],permission:()=>({principal:'a',tenant:'t',authority:'fixture',revision:'1',lookup:true,apply:true}),resolve:()=>application==='link'?{status:'replacement',replacement:'wrong'}:{status:'available',href:'https://example.test/'},onStatus:status=>statuses.push(status)});}}).configure();
      const surface=f.mountEditorSurface(host,engine,{extensions:[extension]});f.surfaces.push(surface);await surface.ready;f.insert(engine,' ');window.familyProbes.push({engine,statuses});
    }
  });await p.waitForFunction(()=>window.familyProbes.every(p=>p.statuses.includes('invalid')));const result=await p.evaluate(()=>window.familyProbes.map(p=>window.spellingFixture.content(p.engine)));assert.deepEqual(result,['teh ','teh ']);
});

check('ENV-06 dictionary loading cancellation releases pending work and ignores late initialization',async p=>{await start(p,{direct:true,loadDelayed:true});await p.waitForFunction(()=>window.spelling.loads===1);const aborted=await p.evaluate(async()=>{const s=window.spelling;s.surface.dispose();s.releaseLoad();await window.spellingFixture.flush();return s.loadSignal.aborted;});assert.equal(aborted,true);const s=await snapshot(p);assert.equal(s.calls,0);assert.equal(s.groups,0);assert.equal(s.state.pending,0);assert.equal(s.text,'teh ');});

check('ENV-06 asset oracle detects a deliberately eager prepared dictionary control',async(p,facts)=>{await start(p,{mode:'off'});const forbidden=url=>/spelling-runtime|spellcheck\.js|dictionary|checker|worker/.test(url);assert.equal(facts.requests.filter(forbidden).length,0);await p.evaluate(()=>import('/fixture/spellcheck.js'));assert.equal(facts.requests.filter(forbidden).length,1);facts.negativeControl='deliberate eager fixture dictionary detected';});

check('ENV-06 checker class prototype callbacks retain their receiver and private host state',async p=>{await start(p,{classHost:true});await ready(p);await accept(p);const s=await snapshot(p);assert.equal(s.text,'the ');assert.equal(s.loads,1);assert.equal(s.calls,1);assert.deepEqual(s.diagnostics,[]);});
check('ENV-02 prepared dictionary does not mistake prototype names for known words',async p=>{await start(p,{text:'constructor'});await p.waitForFunction(()=>window.spelling.statuses.includes('missing'));const s=await snapshot(p);assert.equal(s.text,'constructor ');assert.equal(s.groups,0);assert.deepEqual(s.diagnostics,[]);});
