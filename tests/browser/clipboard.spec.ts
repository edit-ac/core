import assert from 'node:assert/strict';
import { test } from 'node:test';
import { fixture } from '../../benchmarks/fixtures.mjs';
import { browserHarness } from './browser-harness.ts';
const { probe } = browserHarness('clipboard', 'fixtures/browser-input', { sourcePaths: ['fixtures/browser-input/session.mjs', 'benchmarks/fixtures.mjs'] });
const MIME = 'application/x-edit-ac-fragment+json';
async function state(page, fact) {
  const s = await page.evaluate(async () => { const f = window.inputFixture, s = await f.state(); return { ...s, nodes: f.engine.read().visible, result: f.protocol.clipboard.last, diagnostics: f.protocol.clipboard.diagnostics }; });
  fact.snapshots.push(s); assert.deepEqual(s.errors, []); assert.deepEqual(s.dom.filter((_,i)=>s.nodes[i].kind==='block'), s.text.filter((_,i)=>s.nodes[i].kind==='block')); return s;
}
async function paste(page, flavors, literal = false) {
  return page.evaluate(({flavors,literal}) => window.inputFixture.protocol.clipboard.paste({ getData: mime => flavors[mime] ?? '' }, { literal }), { flavors, literal });
}
async function select(page, first, start, last = first, end = start) {
  await page.evaluate(({first,start,last,end}) => { const f = window.inputFixture, nodes = f.engine.read().visible.filter(n => n.kind === 'block'); const a = f.selection.toDOM({node:nodes[first].id,offset:start,bias:'right'}), b = f.selection.toDOM({node:nodes[last].id,offset:end,bias:'left'}); f.root.focus(); document.getSelection().setBaseAndExtent(a.node,a.offset,b.node,b.offset); f.selection.capture(); }, { first,start,last,end });
}
function fragment(blocks, schema = 'editac.registry.editor.v5', version = 1) { return JSON.stringify({version,schema,blocks}); }
const rich = fragment([{ attributes: {type:'heading',level:2}, runs:[{text:'Bold',marks:[{mark:'bold'}]}] },{ attributes:{type:'paragraph'},runs:[{text:'Link',marks:[{mark:'link',href:'https://example.com/'}]}] }]);

test('literal normalizes CRLF once and preserves Markdown, spaces, Unicode and one undo group', () => probe('literal', async (page,fact) => {
  const text = '# title\n\n  **literal**\t😀\r\n<script>x</script>';
  const expected = '# title\n\n  **literal**\t😀\n<script>x</script>';
  await paste(page, {'text/plain':text},true); let s = await state(page,fact);
  assert.equal(s.text[0], 'alpha'+expected); assert.equal(s.history.undoGroups,1); assert.equal(s.journal.length,1);
  await page.evaluate(() => window.inputFixture.engine.history({type:'undo'})); s=await state(page,fact); assert.equal(s.text[0],'alpha');
  await page.evaluate(() => window.inputFixture.engine.history({type:'redo'})); s=await state(page,fact); assert.equal(s.text[0],'alpha'+expected);
}));
test('cross-block fragment round-trips headings, marks and links atomically', () => probe('rich-fragment', async (page,fact) => {
  await select(page,0,0,1,11); await paste(page,{[MIME]:rich,'text/plain':'wrong'}); let s=await state(page,fact);
  assert.deepEqual(s.text,['Bold','Link']); assert.deepEqual(s.nodes.map(n=>n.blockAttributes),[['heading',2],['paragraph']]);
  assert.equal(s.nodes[0].runs[0].attributes.bold,true); assert.equal(s.nodes[1].runs[0].attributes.link,'https://example.com/');
  assert.equal(s.history.undoGroups,1); assert.equal(s.journal.length,1);
  await select(page,0,0,1,4);
  const flavors=await page.evaluate(()=>{const flavors={};const f=window.inputFixture;f.protocol.clipboard.copy({getData:t=>flavors[t]??'',setData:(t,v)=>flavors[t]=v});return flavors;});
  assert.equal(flavors['text/plain'],'Bold\nLink'); assert.match(flavors['text/html'],/<strong>Bold<\/strong>/);
  await page.evaluate(()=>window.inputFixture.engine.history({type:'undo'})); await state(page,fact); await select(page,0,0,1,11);
  await paste(page,flavors); s=await state(page,fact); assert.deepEqual(s.text,['Bold','Link']); assert.equal(s.nodes[0].runs[0].attributes.bold,true);
}));
test('native menu copy/cut/paste events require no keyboard and cut follows successful write', () => probe('menu-copy-cut', async(page,fact)=>{
  await select(page,0,1,1,3);
  const flavors=await page.evaluate(()=>{const f=window.inputFixture, data=new DataTransfer(); const event=window.preparedClipboardEvent('cut',data); f.root.dispatchEvent(event); return {plain:data.getData('text/plain'),fragment:data.getData('application/x-edit-ac-fragment+json'),prevented:event.defaultPrevented};});
  assert.equal(flavors.plain,'lpha\nind'); assert.equal(flavors.prevented,true); let s=await state(page,fact); assert.deepEqual(s.text,['aependent']); assert.equal(s.journal.length,1);
  await page.evaluate(flavors=>{const f=window.inputFixture,data=new DataTransfer();data.setData('text/plain',flavors.plain);data.setData('application/x-edit-ac-fragment+json',flavors.fragment);f.root.dispatchEvent(window.preparedClipboardEvent('paste',data));},flavors);
  s=await state(page,fact); assert.deepEqual(s.text,['alpha','independent']); assert.equal(s.history.undoGroups,2);
}));
for (const [name,raw] of [['malformed','{'],['unsupported-version',fragment([],undefined,2)],['schema',fragment([], 'wrong')],['oversize','x'.repeat(1048577)],['unsafe-link',fragment([{attributes:{type:'paragraph'},runs:[{text:'bad',marks:[{mark:'link',href:'javascript:alert(1)'}]}]}])],['kernel-url-rejection',fragment([{attributes:{type:'paragraph'},runs:[{text:'bad',marks:[{mark:'link',href:'https://example.com/%0a'}]}]}])]]) {
  test(`${name} fragment falls back safely`,()=>probe(name,async(page,fact)=>{await paste(page,{[MIME]:raw,'text/plain':'safe'});const s=await state(page,fact);assert.equal(s.text[0],'alphasafe');assert.equal(s.journal.length,1);assert.ok(s.diagnostics.length);assert.equal(await page.evaluate(()=>document.querySelector('script[src="javascript:alert(1)"]')),null);}));
}
test('HTML retains supported formatting and never installs source nodes or handlers',()=>probe('html',async(page,fact)=>{
  await select(page,0,0,1,11); await paste(page,{'text/html':'<h3 onclick="window.pwned=1"><strong>A</strong><em>B</em><u>C</u><s>D</s><code>E</code><a href="https://example.com">F</a><a href="javascript:alert(1)">G</a></h3><pre>  literal\n**x**</pre><script>window.pwned=1</script>','text/plain':'fallback'});
  const s=await state(page,fact);assert.deepEqual(s.text,['ABCDEFG','  literal\n**x**']);assert.deepEqual(s.nodes[0].blockAttributes,['heading',3]);assert.equal(s.nodes[0].runs[0].attributes.bold,true);assert.equal(s.nodes[0].runs.at(-1).attributes.link,undefined);assert.equal(await page.evaluate(()=>window.pwned),undefined);
}));
test('HTML lists and quotes preserve portable container formatting',()=>probe('html-containers',async(page,fact)=>{
  await select(page,0,0,1,11);await paste(page,{'text/html':'<ol start="3"><li><strong>one</strong></li><li>two</li></ol><blockquote><p>quoted</p></blockquote>','text/plain':'fallback'});
  const s=await state(page,fact);assert.deepEqual(s.nodes.filter(n=>n.kind==='block').map(n=>n.runs.map(r=>r.text).join('')),['one','two','quoted']);assert.ok(s.nodes.some(n=>JSON.stringify(n.editor?.containerAttributes)==='["ordered",3]'));assert.ok(s.nodes.some(n=>JSON.stringify(n.editor?.containerAttributes)==='["quote"]'));assert.equal(s.journal.length,1);
  await select(page,0,0,1,3);const html=await page.evaluate(()=>{const f=window.inputFixture,flavors={};f.protocol.clipboard.copy({getData:t=>flavors[t]??'',setData:(t,v)=>flavors[t]=v});return flavors['text/html'];});assert.equal((html.match(/<ol /g)??[]).length,1);assert.equal((html.match(/<li>/g)??[]).length,2);assert.match(html,/start="3"/);
}));
test('direct quote text preserves quoted content and style',()=>probe('direct-quote',async(page,fact)=>{await select(page,0,0,1,11);await paste(page,{'text/html':'<blockquote>direct <strong>quote</strong></blockquote>','text/plain':'fallback'});const s=await state(page,fact);assert.deepEqual(s.nodes.filter(n=>n.kind==='block').map(n=>n.runs.map(r=>r.text).join('')),['direct quote']);assert.ok(s.nodes.some(n=>JSON.stringify(n.editor?.containerAttributes)==='["quote"]'));}));
test('unsupported table codec keeps inert rich source and explicit fallback diagnostics',()=>probe('extension-source',async(page,fact)=>{const raw='<table><tr><td><b>cell</b></td></tr></table>';await paste(page,{'text/html':raw,'text/plain':'cell'});const s=await state(page,fact);assert.equal(s.text[0],'alphacell');assert.ok(s.diagnostics.some(s=>s.includes('requires-extension-codec')));const recovery=await page.evaluate(()=>window.inputFixture.protocol.clipboard.recovery);assert.equal(recovery[0].raw,raw);assert.equal(recovery[0].mime,'text/html');}));
test('code target ignores rich flavors and keeps paste literal',()=>probe('code-literal',async(page,fact)=>{
  await page.evaluate(()=>{const f=window.inputFixture,p=f.engine.prepare({kind:'editor',origin:'fixture',commands:[{type:'setCode',owner:f.ids[0],language:'js'}]});try{f.engine.commit(p);}finally{f.engine.releasePlan(p);}f.engine.history({type:'clear'});});
  await paste(page,{[MIME]:rich,'text/html':'<b>rich</b>','text/plain':'**literal**'});const s=await state(page,fact);assert.equal(s.text[0],'alpha**literal**');assert.deepEqual(s.nodes[0].blockAttributes,['code','js']);assert.equal(s.nodes[0].runs.some(r=>r.attributes.bold===true),false);
}));
test('inline-code literal paste retains destination code formatting',()=>probe('inline-code',async(page,fact)=>{
  await page.evaluate(()=>{const f=window.inputFixture,a=f.engine.anchor(f.ids[0],0,'right'),b=f.engine.anchor(f.ids[0],5,'left');try{const p=f.engine.prepare({kind:'format',origin:'fixture',marks:[{range:{anchor:a,focus:b},mark:'code',action:'apply'}],blocks:[]});try{f.engine.commit(p);}finally{f.engine.releasePlan(p);}}finally{f.engine.releaseAnchor(a);f.engine.releaseAnchor(b);}f.engine.history({type:'clear'});});
  await select(page,0,2);await paste(page,{[MIME]:rich,'text/plain':'**literal**'});const s=await state(page,fact);assert.equal(s.text[0],'al**literal**pha');assert.ok(s.nodes[0].runs.every(r=>r.attributes.code===true));assert.equal(s.history.undoGroups,1);
}));
for(const [name,mods,platform] of [['control-shift-v',{ctrlKey:true,shiftKey:true},'Win32'],['command-shift-v',{metaKey:true,shiftKey:true},'MacIntel'],['command-option-shift-v',{metaKey:true,altKey:true,shiftKey:true},'MacIntel']]) {
  test(`${name} opts into paste without formatting`,()=>probe(name,async(page,fact)=>{fact.modifierProfile=platform;await page.evaluate(({mods,platform})=>{Object.defineProperty(navigator,'platform',{value:platform,configurable:true});const f=window.inputFixture;f.root.dispatchEvent(new KeyboardEvent('keydown',{key:'v',bubbles:true,cancelable:true,...mods}));const data=new DataTransfer();data.setData('text/plain','**literal**');data.setData('text/html','<b>formatted</b>');f.root.dispatchEvent(window.preparedClipboardEvent('paste',data));},{mods,platform});const s=await state(page,fact);assert.equal(s.text[0],'alpha**literal**');assert.equal(s.nodes[0].runs.some(r=>r.attributes.bold===true),false);}));
}
test('ordinary paste shortcut retains HTML formatting',()=>probe('ordinary-shortcut',async(page,fact)=>{await page.evaluate(()=>{const f=window.inputFixture;f.root.dispatchEvent(new KeyboardEvent('keydown',{key:'v',ctrlKey:true,bubbles:true,cancelable:true}));const data=new DataTransfer();data.setData('text/plain','literal');data.setData('text/html','<b>rich</b>');f.root.dispatchEvent(window.preparedClipboardEvent('paste',data));});const s=await state(page,fact);assert.equal(s.text[0],'alpharich');assert.equal(s.nodes[0].runs.at(-1).attributes.bold,true);}));
test('mobile beforeinput-only paste is independent of keydown',()=>probe('mobile-beforeinput',async(page,fact)=>{await page.evaluate(()=>window.inputFixture.event('beforeinput',{inputType:'insertFromPaste',data:'mobile',cancelable:true}));const s=await state(page,fact);assert.equal(s.text[0],'alphamobile');assert.equal(s.journal.length,1);}));
test('mobile noncancelable paste repairs native DOM and commits once',()=>probe('mobile-noncancelable',async(page,fact)=>{
  await page.evaluate(()=>{const f=window.inputFixture;f.event('beforeinput',{inputType:'insertFromPaste',data:'mobile',cancelable:false});f.mutate('alphamobile');f.event('input',{inputType:'insertFromPaste',data:'mobile'});});const s=await state(page,fact);assert.equal(s.text[0],'alphamobile');assert.equal(s.journal.length,1);assert.equal(s.history.undoGroups,1);
}));
test('paste plus beforeinput and input is deduplicated; repeated same payload stays deliberate',()=>probe('paste-events',async(page,fact)=>{
  await page.evaluate(()=>{const f=window.inputFixture;for(let i=0;i<2;i++){const data=new DataTransfer();data.setData('text/plain','same');f.root.dispatchEvent(window.preparedClipboardEvent('paste',data));f.event('beforeinput',{inputType:'insertFromPaste',data:'same',cancelable:true});f.event('input',{inputType:'insertFromPaste',data:'same'});}});const s=await state(page,fact);assert.deepEqual(s.text,['alphasamesame','independent']);assert.equal(s.journal.length,2);assert.equal(s.history.undoGroups,2);
}));
test('clipboard write failure cannot cut content or add history',()=>probe('write-failure',async(page,fact)=>{await select(page,0,0,0,5);const result=await page.evaluate(()=>window.inputFixture.protocol.clipboard.copy({getData:()=>'',setData:()=>{throw Error('denied');}},true));assert.equal(result.disposition,'rejected');const s=await state(page,fact);assert.equal(s.text[0],'alpha');assert.equal(s.journal.length,0);assert.equal(s.history.undoGroups,0);}));
test('read-only and active composition reject paste with zero updates',()=>probe('readonly-composition',async(page,fact)=>{await page.evaluate(()=>window.inputFixture.protocol.setReadOnly(true));assert.equal((await paste(page,{'text/plain':'bad'})).disposition,'rejected');await page.evaluate(()=>{const f=window.inputFixture;f.protocol.setReadOnly(false);f.event('compositionstart',{data:''});});assert.equal((await paste(page,{'text/plain':'bad'})).disposition,'rejected');const s=await state(page,fact);assert.equal(s.text[0],'alpha');assert.equal(s.journal.length,0);}));
for (const corpus of ['two-block-utf8-boundary', 'Long']) test(`full ${corpus} plain copy preserves every byte and rejects oversized paste or cut`,()=>probe(`large-copy-${corpus}`,async(page,fact)=>{
  const texts=corpus==='Long'?fixture('Long').blocks.map(block=>block.runs.map(run=>run.text).join('')):['é'.repeat(262144),'ö'.repeat(262144)];
  fact.corpus={name:corpus,blocks:texts.length,plainBytes:Buffer.byteLength(texts.join('\n'))};
  await page.evaluate(async texts=>{const f=window.inputFixture;await f.destroy();await f.mount('',null,texts);},texts);
  const end=await page.evaluate(()=>window.inputFixture.engine.read().visible.filter(n=>n.kind==='block').at(-1).runs.reduce((n,r)=>n+r.text.length,0));
  await select(page,0,0,texts.length-1,end);
  const result=await page.evaluate(expected=>{
    const f=window.inputFixture;
    if(f.engine.read().visible.filter(n=>n.kind==='block').map(n=>n.runs.map(r=>r.text).join('')).join('\n')!==expected)throw Error('Full independent corpus differs before copy');
    const before=f.engine.checkpoint().bytes,history=f.engine.history({type:'state'}),flavors={},cutFlavors={};let updates=0;
    const subscription=f.engine.subscribe({type:'updates'},()=>updates++);
    const data=store=>({getData:m=>store[m]??'',setData:(m,v)=>store[m]=v});
    const copied=f.protocol.clipboard.copy(data(flavors));
    const cut=f.protocol.clipboard.copy(data(cutFlavors),true);
    const pasted=f.protocol.clipboard.paste({getData:m=>m==='text/plain'?flavors[m]:''},{literal:true});
    const after=f.engine.checkpoint().bytes;subscription.dispose();
    return {copied,cut,pasted,bytes:new TextEncoder().encode(expected).length,exact:flavors['text/plain']===expected,flavors:Object.keys(flavors),cutFlavors:Object.keys(cutFlavors),unchanged:before.length===after.length&&before.every((b,i)=>b===after[i]),historyUnchanged:JSON.stringify(history)===JSON.stringify(f.engine.history({type:'state'})),updates};
  },texts.join('\n'));
  fact.copyBounds=result;
  assert(result.bytes>1048576);assert.equal(result.copied.disposition,'handled');assert.equal(result.exact,true);assert.deepEqual(result.flavors,['text/plain']);assert.deepEqual(result.cutFlavors,[]);assert.equal(result.cut.reason,'clipboard-limit');assert.equal(result.pasted.reason,'clipboard-limit');assert.equal(result.unchanged,true);assert.equal(result.historyUnchanged,true);assert.equal(result.updates,0);
}));

test('empty/unavailable clipboard never erases a replacement selection',()=>probe('empty',async(page,fact)=>{await select(page,0,0,0,5);assert.equal((await paste(page,{})).disposition,'rejected');const s=await state(page,fact);assert.equal(s.text[0],'alpha');assert.equal(s.journal.length,0);}));
test('explicit plain command captures stable target before OS permission and preserves later selection',()=>probe('async-plain',async(page,fact)=>{
  await page.evaluate(()=>{const f=window.inputFixture;window.pendingPlain=f.protocol.clipboard.pastePlainText(()=>new Promise(resolve=>window.finishRead=resolve));f.select(f.ids[1],2);});await page.evaluate(()=>window.finishRead('plain'));assert.equal((await page.evaluate(()=>window.pendingPlain)).disposition,'committed');const s=await state(page,fact);assert.equal(s.text[0],'alphaplain');assert.equal(s.caret.node,s.ids[1]);assert.equal(s.caret.offset,2);
}));
test('late plain paste after read-only transition is canceled',()=>probe('async-canceled',async(page,fact)=>{await page.evaluate(()=>{const f=window.inputFixture;window.pendingPlain=f.protocol.clipboard.pastePlainText(()=>new Promise(()=>{}));f.protocol.setReadOnly(true);});assert.equal((await page.evaluate(()=>window.pendingPlain)).disposition,'rejected');const s=await state(page,fact);assert.equal(s.text[0],'alpha');assert.equal(s.journal.length,0);}));

test('HTML mark aliases share presentation without admitting prototype names as marks',()=>probe('mark-aliases',async(page,fact)=>{
  await paste(page,{'text/html':'<b>B</b><i>I</i><del>S</del><strike>T</strike><u>U</u><code>C</code><constructor>X</constructor><a href="https://例え.テスト/道">L</a>'});
  const s=await state(page,fact);
  assert.equal(s.text[0],'alphaBISTUCXL');
  for(const [text,mark] of [['B','bold'],['I','italic'],['S','strike'],['T','strike'],['U','underline'],['C','code']]) assert(s.nodes[0].runs.some(run=>run.text.includes(text)&&run.attributes[mark]===true));
  const unmarked=s.nodes[0].runs.find(run=>run.text.includes('X'));assert.deepEqual(unmarked.attributes,{});
  assert(s.nodes[0].runs.some(run=>String(run.attributes.link).startsWith('https://xn--')));
  assert(s.diagnostics.includes('html-element-dropped'));
}));
