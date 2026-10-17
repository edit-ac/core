import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {test} from 'node:test';
import * as Y from 'yjs';
import {browserHarness} from '../browser-harness.ts';
import {selectAll,paste,state} from '../format-helpers.ts';
import {registerClipboardCases} from '../clipboard-cases.ts';
import {registerHtmlPasteCases} from '../html-paste-cases.ts';
import {registerClipboardFormatsCases} from '../clipboard-formats-cases.ts';
import {registerLargePasteCases} from '../large-paste-cases.ts';
const corpus=JSON.parse(await readFile(new URL('../../../fixtures/clipboard/editor-paste.json',import.meta.url),'utf8'));
const {probe:rawProbe,facts}=browserHarness('interaction-paste','fixtures/browser-input',{
  markdown:true,assertSourcesUnchanged:true,testFile:'tests/browser/interactions/paste.spec.ts',sourcePaths:[
    'tests/browser/clipboard-cases.ts','tests/browser/html-paste-cases.ts','tests/browser/clipboard-formats-cases.ts','tests/browser/large-paste-cases.ts',
    'fixtures/clipboard/editor-paste.json','fixtures/browser-input/session.mjs','packages/web/src/editor.ts',
    'packages/web/src/dom/selection.ts','packages/web/src/surface.ts','packages/web/src/sync/session.ts',
    'scripts/test-interactions.mjs','packages/web/dist/clipboard/fragment.js','packages/core/dist/wasm/editac_wasm_bg.wasm',
    'packages/markdown/dist/wasm/editac_markdown_wasm_bg.wasm']});
facts.binding={gate:'INT-1.10',ids:['PST-01','PST-02','PST-03','PST-04','PST-05','PST-06','PST-07'],
  provenance:corpus.provenance,profile:{os:process.platform,arch:process.arch,layout:'1280x720 headless; prepared clipboard events, no OS clipboard claim'}};
const MIME='application/x-edit-ac-fragment+json';
function probe(name,action,text='alpha'){return rawProbe(name,async(page,fact)=>{
  fact.caseIds=[name.slice(0,6)];await action(page,fact);
},text);}
const clipboardIds={literal:'02','rich-fragment':'07','menu-copy-cut':'05','code-literal':'02','inline-code':'02','write-failure':'05','async-plain':'06','async-canceled':'06','readonly-composition':'06','empty':'05'};
registerClipboardCases((name,action)=>probe(`PST-${clipboardIds[name]??(name.includes('fragment')||['malformed','unsupported-version','schema','oversize','unsafe-link'].includes(name)?'01':'04')}-clipboard-${name}`,action));
registerHtmlPasteCases((name,action)=>probe(`PST-${name==='palette'||name==='malformed'?'03':'04'}-html-${name}`,action));
registerClipboardFormatsCases((name,action)=>probe(`PST-${name==='producers'?'03':name==='codec-routing'?'01':'02'}-formats-${name}`,action));
registerLargePasteCases((name,action)=>probe(`PST-06-deferred-${name}`,action));

function unchanged(a,b){for(const key of ['text','nodes','history','journal'])assert.deepEqual(b[key],a[key],key);}
async function seedUnknownMark(page){
  const opening=await page.evaluate(()=>{const f=window.inputFixture;return {bytes:Array.from(f.engine.checkpoint().bytes),source:f.engine.read().visible[0].spans[0].source};});
  const peer=new Y.Doc();Y.applyUpdate(peer,new Uint8Array(opening.bytes));const vector=Y.encodeStateVector(peer);
  peer.getMap('registry-texts').get(opening.source).format(0,5,{'vendor-note':{color:'purple',untouched:true}});
  const update=Y.encodeStateAsUpdate(peer,vector);peer.destroy();await page.evaluate(bytes=>window.inputFixture.apply(bytes),Array.from(update));
  await page.evaluate(()=>{const f=window.inputFixture;f.engine.history({type:'clear'});f.select(f.ids[0],5,0);});
}
for(const f of corpus.cases)test(`PST-03 ${f.source}`,()=>probe(`PST-03-external-${f.id}`,async(page,fact)=>{
  fact.fixture={id:f.id,revision:corpus.revision,source:f.source};await selectAll(page);
  const requests=[];page.on('request',r=>requests.push(r.url()));
  await paste(page,f.flavors);const s=await state(page,fact);assert.equal(s.result.disposition,'committed');
  assert.deepEqual(s.text,f.text);assert.equal(s.history.undoGroups,1);assert.equal(s.journal.length,1);assert.deepEqual(requests,[]);
  if(f.mark)assert.ok(s.nodes.some(n=>n.runs.some(r=>r.attributes[f.mark]===true)));
  if(f.diagnostic)assert.ok(s.diagnostics.includes(f.diagnostic));
  await page.evaluate(()=>window.inputFixture.reopen());assert.deepEqual((await state(page,fact)).text,f.text);
}));
for(const flavor of ['fragment','markdown','x-markdown','html','plain'])test(`PST-01 precedence chooses ${flavor}`,()=>probe(`PST-01-precedence-${flavor}`,async(page,fact)=>{
  await selectAll(page);const all={
    [MIME]:JSON.stringify({version:1,schema:'editac.registry.editor.v5',blocks:[{attributes:{type:'paragraph'},runs:[{text:'fragment',marks:[]}]}]}),
    'text/markdown':'**markdown**','text/x-markdown':'**x-markdown**','text/html':'<b>html</b>','text/plain':'plain'};
  const ordered=Object.keys(all);const index=['fragment','markdown','x-markdown','html','plain'].indexOf(flavor);
  for(let i=0;i<index;i++)delete all[ordered[i]];
  await paste(page,all);const s=await state(page,fact);assert.equal(s.result.disposition,'committed');assert.deepEqual(s.text,[flavor]);assert.equal(s.history.undoGroups,1);assert.equal(s.journal.length,1);
}));
for(const flavor of ['fragment','markdown','html'])test(`PST-01 invalid ${flavor} retains source and falls back`,()=>probe(`PST-01-fallback-${flavor}`,async(page,fact)=>{
  await selectAll(page);const mime={fragment:MIME,markdown:'text/markdown',html:'text/html'}[flavor];
  const raw=flavor==='fragment'?'{':flavor==='markdown'?'bad\u0000source':'<div>'.repeat(34)+'x'+'</div>'.repeat(34);
  await paste(page,{[mime]:raw,'text/plain':'safe'});const s=await state(page,fact);assert.deepEqual(s.text,['safe']);assert.ok(s.recovery.some(r=>r.mime===mime&&r.raw===raw));assert.equal(s.history.undoGroups,1);
}));
for(const mime of ['text/rtf','text/tab-separated-values'])test(`PST-01 registered ${mime} is captured once before preparation`,()=>probe(`PST-01-capture-${mime.replace('/','-')}`,async(page,fact)=>{
  const result=await page.evaluate(async mime=>{const f=window.inputFixture,{ClipboardInput}=await import('/web/clipboard/fragment.js'),reads={};
    const c=new ClipboardInput(f.renderer,f.selection,f.engine,r=>f.commit(r),()=>false,[{mime,prepare:raw=>[{attributes:{type:'paragraph'},runs:[{text:raw,marks:[]}]}]}]);
    try {const outcome=c.paste({getData:m=>{reads[m]=(reads[m]??0)+1;return m===mime?(reads[m]===1?'captured':'changed-after-capture'):'';}});return {outcome,reads};}finally{c.dispose();}
  },mime);fact.capture=result;assert.equal(result.outcome.disposition,'committed');assert.ok(Object.values(result.reads).every(n=>n===1));assert.deepEqual((await state(page,fact)).text,['alphacaptured','independent']);
}));
test('PST-06 deferred capture retains unsupported RTF and TSV source once',()=>probe('PST-06-capture-fallback',async(page,fact)=>{
  const capture=await page.evaluate(()=>{const f=window.inputFixture,reads={},values={'text/rtf':'{synthetic RTF}','text/tab-separated-values':'a\tb','text/plain':'safe'};
    window.pasteJob=f.protocol.clipboard.pasteDeferred({getData:m=>{reads[m]=(reads[m]??0)+1;return values[m]??'';}},{schedule:()=>new Promise(resolve=>window.completePaste=resolve)});
    values['text/plain']='changed';return {reads,source:window.pasteJob.source};});fact.capture=capture;assert.ok(Object.values(capture.reads).every(n=>n===1));assert.equal(capture.source['text/plain'],'safe');
  await page.evaluate(()=>window.completePaste());assert.equal((await page.evaluate(()=>window.pasteJob.result)).disposition,'committed');const s=await state(page,fact);assert.deepEqual(s.text,['alphasafe','independent']);
  for(const [mime,raw]of Object.entries({'text/rtf':'{synthetic RTF}','text/tab-separated-values':'a\tb'}))assert.ok(s.recovery.some(r=>r.mime===mime&&r.raw===raw));assert.equal(s.history.undoGroups,1);assert.equal(s.journal.length,1);
}));
for(const literal of [false,true])test(`PST-03 multiline styled RTL midpoint ${literal?'literal':'host Markdown'} preserves prefix and suffix`,()=>probe(`PST-03-rtl-${literal}`,async(page,fact)=>{
  await selectAll(page);await paste(page,{'text/html':'<h2><b>אבגד</b><i>suffix</i></h2>'});
  await page.evaluate(()=>{const f=window.inputFixture;f.root.dir='rtl';f.engine.history({type:'clear'});f.protocol.clipboard.plainTextPolicy='markdown';f.select(f.engine.read().visible[0].id,2);});const before=await state(page,fact);
  fact.policy={paragraph:literal?'existing heading retained; LF is same-block hard break':'incoming Markdown paragraphs explicitly replace destination heading',marks:literal?'destination bold inherited':'incoming unmarked runs; original prefix/suffix marks retained',bidi:'host root dir=rtl inherited by every block; no stored bidi property is admitted'};
  await paste(page,{'text/plain':'one\n\ntwo'},{literal});const after=await state(page,fact);
  assert.deepEqual(after.text,literal?['אבone\n\ntwoגדsuffix']:['אבone','twoגדsuffix']);
  assert.deepEqual(after.nodes.map(n=>n.blockAttributes),literal?[['heading',2]]:[['paragraph'],['paragraph']]);
  assert.ok(after.nodes.at(-1).runs.some(r=>r.text.includes('suffix')&&r.attributes.italic===true));
  assert.ok(after.nodes[0].runs.some(r=>r.text.startsWith('אב')&&r.attributes.bold===true));
  if(literal)assert.ok(after.nodes[0].runs.some(r=>r.text.includes('one\n\ntwo')&&r.attributes.bold===true));
  else assert.ok(after.nodes.every(n=>n.runs.filter(r=>r.text.includes('one')||r.text.includes('two')).every(r=>Object.keys(r.attributes).length===0)));
  assert.deepEqual(await page.locator('#projection [data-node-id]').evaluateAll(nodes=>nodes.map(n=>getComputedStyle(n).direction)),after.nodes.map(()=> 'rtl'));
  assert.equal(after.history.undoGroups,1);assert.equal(after.journal.length,before.journal.length+1);
  await page.evaluate(()=>window.inputFixture.engine.history({type:'undo'}));assert.deepEqual((await state(page,fact)).nodes,before.nodes);
}));
for(const failure of ['plain-throw','plain-silent','fragment-throw','fragment-silent','html-throw'])test(`PST-05 cross-block cut ${failure} preserves content and history`,()=>probe(`PST-05-cut-${failure}`,async(page,fact)=>{
  await selectAll(page);const before=await state(page,fact);
  const outcome=await page.evaluate(failure=>{const c=window.inputFixture.protocol.clipboard,values={};const target=failure.split('-')[0],mime=target==='fragment'?'application/x-edit-ac-fragment+json':`text/${target}`;
    return c.copy({getData:m=>values[m]??'',setData:(m,v)=>{if(m===mime){if(failure.endsWith('throw'))throw Error('denied');return;}values[m]=v;}},true);},failure);
  assert.equal(outcome.disposition,'rejected');unchanged(before,await state(page,fact));
}));
for(const action of ['remote-text','move','delete','readonly','cancel','denied'])test(`PST-06 explicit plain delayed ${action}`,()=>probe(`PST-06-plain-${action}`,async(page,fact)=>{
  await page.evaluate(()=>{const f=window.inputFixture;f.select(f.ids[1],3);window.pendingPlain=f.protocol.clipboard.pastePlainText(()=>new Promise((resolve,reject)=>{window.finishRead=resolve;window.rejectRead=reject;}));});
  if(action==='remote-text')await page.evaluate(()=>window.inputFixture.remote(0,'remote ',window.inputFixture.ids[1]));
  if(action==='readonly')await page.evaluate(()=>window.inputFixture.protocol.setReadOnly(true));
  if(action==='cancel')await page.evaluate(()=>window.inputFixture.protocol.clipboard.cancel());
  if(action==='move'||action==='delete')await page.evaluate(action=>{const f=window.inputFixture,n=f.engine.read().visible.filter(n=>n.kind==='block');f.commit({kind:'editor',origin:'target-change',commands:action==='move'?[{type:'wrap',targets:[n[1].id],style:{type:'quote'}}]:[{type:'join',first:n[0].id,second:n[1].id}]});},action);
  await page.evaluate(()=>window.inputFixture.select(window.inputFixture.ids[0],1));const before=await state(page,fact);
  if(action==='denied')await page.evaluate(()=>window.rejectRead(Error('denied')));else await page.evaluate(()=>window.finishRead('**literal**\r\n'));
  const result=await page.evaluate(()=>window.pendingPlain);const after=await state(page,fact);
  if(action==='remote-text'){assert.equal(result.disposition,'committed');assert.deepEqual(after.text,['alpha','remote ind**literal**\nependent']);assert.equal(after.caret.node,after.ids[0]);assert.equal(after.caret.offset,1);assert.equal(after.history.undoGroups,1);}
  else {assert.equal(result.disposition,'rejected');unchanged(before,after);
    if(action==='move'||action==='delete')assert.ok(after.recovery.some(r=>r.raw==='**literal**\r\n'),'A stale read retains its recoverable source');
  }
}));
test('PST-06 explicit plain read cannot cross a disposed editor session',()=>probe('PST-06-plain-session',async(page,fact)=>{
  await page.evaluate(()=>{window.pendingPlain=window.inputFixture.protocol.clipboard.pastePlainText(()=>new Promise(resolve=>window.finishRead=resolve));});
  await page.evaluate(async()=>{const f=window.inputFixture;await f.destroy();await f.mount('new session');});const before=await state(page,fact);
  await page.evaluate(()=>window.finishRead('late'));assert.equal((await page.evaluate(()=>window.pendingPlain)).disposition,'rejected');unchanged(before,await state(page,fact));
}));
test('PST-02 visible plain action is focusable and uses captured target',()=>probe('PST-02-visible-literal',async(page,fact)=>{
  await page.evaluate(async()=>{const f=window.inputFixture,identity=f.engine.read().identity,root=f.root;await f.destroy();window.fixtureDisposed=true;
    const {mountEditor}=await import('/web/index.js');window.activeEditor=mountEditor(root,{assetUrl:'/core/wasm/editac_wasm_bg.wasm',databaseName:'browser-input',identity,indexedDB,locks:navigator.locks});await window.activeEditor.ready;
    Object.defineProperty(navigator,'clipboard',{configurable:true,value:{readText:async()=>'**plain**'}});
  });
  await page.locator('#projection [data-node-id]').first().click();await page.keyboard.press('End');
  const button=page.getByRole('button',{name:'Paste without formatting',exact:true});assert.equal(await button.isEnabled(),true);await button.click();
  await page.waitForFunction(()=>window.activeEditor.root.textContent.includes('**plain**'));
  assert.deepEqual(await page.evaluate(()=>window.activeEditor.read().visible.map(n=>n.runs.map(r=>r.text).join(''))),['alpha**plain**','independent']);
  fact.snapshots.push(await page.evaluate(()=>({html:window.activeEditor.root.innerHTML,state:window.activeEditor.state})));
}));
test('PST-07 unknown bounded mark survives internal backward copy and paste',()=>probe('PST-07-unknown-roundtrip',async(page,fact)=>{
  await seedUnknownMark(page);
  const before=await state(page,fact);const copied=await page.evaluate(()=>{const f=window.inputFixture,values={};const result=f.protocol.clipboard.copy({getData:m=>values[m]??'',setData:(m,v)=>values[m]=v});return {result,values};});fact.copy=copied;
  assert.equal(copied.result.disposition,'handled');assert.ok(copied.values[MIME],'Unknown bounded mark must have a lossless internal flavor');
  await page.evaluate(()=>window.inputFixture.select(window.inputFixture.ids[1],0,11));await paste(page,copied.values);const s=await state(page,fact);
  assert.deepEqual(s.nodes[1].runs,before.nodes[0].runs);
}));
test('PST-07 unrepresentable unknown-mark cut preserves the complete source',()=>probe('PST-07-unknown-cut-safety',async(page,fact)=>{
  await seedUnknownMark(page);const before=await state(page,fact);
  const result=await page.evaluate(()=>{const f=window.inputFixture,values={};return f.protocol.clipboard.copy({getData:m=>values[m]??'',setData:(m,v)=>values[m]=v},true);});
  assert.equal(result.disposition,'rejected');assert.equal(result.reason,'unsupported-fragment-mark');unchanged(before,await state(page,fact));
}));
test('PST-07 backward internal fragment preserves breaks, atom, marks and one undo',()=>probe('PST-07-break-atom-roundtrip',async(page,fact)=>{
  await selectAll(page);await paste(page,{[MIME]:JSON.stringify({version:1,schema:'editac.registry.editor.v5',blocks:[
    {attributes:{type:'paragraph'},runs:[{text:'one\n\n',marks:[{mark:'bold'}]}]},
    {attributes:{type:'separator'},runs:[]},
    {attributes:{type:'paragraph'},runs:[{text:'tail',marks:[{mark:'link',href:'https://example.com/'}]}]}
  ]})});const original=await state(page,fact);assert.equal(original.result.disposition,'committed');
  await page.evaluate(()=>{const f=window.inputFixture,n=f.engine.read().visible.filter(n=>n.kind==='block'),a=f.selection.toDOM({node:n[2].id,offset:4,bias:'right'}),b=f.selection.toDOM({node:n[0].id,offset:0,bias:'left'});f.root.focus();document.getSelection().setBaseAndExtent(a.node,a.offset,b.node,b.offset);f.selection.capture();});
  const before=await state(page,fact);const copy=await page.evaluate(()=>{const f=window.inputFixture,values={};const result=f.protocol.clipboard.copy({getData:m=>values[m]??'',setData:(m,v)=>values[m]=v});const c=f.selection.capture();return{values,result,selection:c.type==='captured'?{anchor:f.engine.resolve(c.selection.range.anchor),focus:f.engine.resolve(c.selection.range.focus)}:c};});
  assert.equal(copy.result.disposition,'handled');assert.equal(copy.selection.anchor.offset,4);assert.equal(copy.selection.focus.offset,0);unchanged(before,await state(page,fact));
  await page.evaluate(()=>window.inputFixture.engine.history({type:'undo'}));await selectAll(page);const entry=await state(page,fact);
  await paste(page,copy.values);const after=await state(page,fact);const semantic=s=>s.nodes.map(n=>({attributes:n.blockAttributes,runs:n.runs}));assert.deepEqual(semantic(after),semantic(original));
  assert.equal(after.history.undoGroups,entry.history.undoGroups+1);assert.equal(after.journal.length,entry.journal.length+1);
  await page.evaluate(()=>window.inputFixture.engine.history({type:'undo'}));assert.deepEqual(semantic(await state(page,fact)),semantic(entry));
  await page.evaluate(()=>window.inputFixture.engine.history({type:'redo'}));assert.deepEqual(semantic(await state(page,fact)),semantic(original));
}));
