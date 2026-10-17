import assert from 'node:assert/strict';
import { test } from 'node:test';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { browserHarness } from '../browser-harness.ts';

const {probe: rawProbe, facts} = browserHarness('interaction-whitespace', 'fixtures/browser-input', {
  markdown:true, autoMount:false, assertSourcesUnchanged:true,
  testFile:'tests/browser/interactions/whitespace.spec.ts',
  sourcePaths:['packages/web/src/input/characters.ts','packages/web/src/input/reconcile.ts',
    'packages/web/src/dom/render.ts','packages/web/src/dom/selection.ts','fixtures/browser-input/session.mjs',
    'packages/web/dist/input/characters.js','packages/web/dist/input/text.js','packages/web/dist/dom/render.js',
    'packages/web/dist/clipboard/fragment.js','packages/core/dist/wasm/editac_wasm_bg.wasm',
    'packages/markdown/dist/wasm/editac_markdown_wasm_bg.wasm','scripts/test-interactions.mjs'],
});
facts.binding={gate:'INT-1.8',ids:['SPC-01','SPC-02','SPC-03','SPC-04','SPC-05'],
  provenance:'Authored synthetic text/events, actual Playwright typing where labeled; production packed Session/WASM, DOM input/clipboard and IndexedDB restore. No OS clipboard, device or AT qualification.',
  profile:{os:process.platform,arch:process.arch,layout:'headless default 1280x720'}};
const primary=process.platform==='darwin'?'Meta':'Control';
function probe(name,action,initial='') {return rawProbe(name,async(page,fact)=>{
  await page.waitForFunction(()=>!!window.inputFixture);
  await page.evaluate(initial=>window.inputFixture.mount(initial,null),initial);
  await action(page,fact);
});}
const escaped=text=>Array.from(text,c=>`U+${c.codePointAt(0).toString(16).toUpperCase().padStart(4,'0')}`).join(' ');
async function state(page,fact,text,offset) {
  const s=await page.evaluate(()=>window.inputFixture.state());
  fact.snapshots.push({...s,codePoints:s.text.map(escapedText=>Array.from(escapedText,c=>c.codePointAt(0))),utf16:s.text.map(t=>t.length)});
  assert.deepEqual(s.errors,[]);assert.equal(s.storage,'localCommitted');
  assert.deepEqual(s.text,[text],escaped(text));assert.deepEqual(s.dom,[text]);
  if(offset!==undefined)assert.equal(s.caret?.offset,offset,'UTF-16 caret');
  return s;
}
async function copy(page,text) {
  const data=await page.evaluate(()=>{const f=window.inputFixture;f.select(f.ids[0],0,f.engine.read().visible[0].runs.map(r=>r.text).join('').length);
    const values={};const e=window.preparedClipboardEvent('copy',{getData:t=>values[t]??'',setData:(t,v)=>values[t]=v});f.root.dispatchEvent(e);return {values,outcome:f.protocol.clipboard.last,prevented:e.defaultPrevented};});
  assert.equal(data.prevented,true);assert.equal(data.outcome.disposition,'handled');
  assert.equal(data.values['text/plain'],text);
  const fragment=JSON.parse(data.values['application/x-edit-ac-fragment+json']);
  assert.equal(fragment.blocks.flatMap(b=>b.runs.map(r=>r.text)).join(''),text);
  const exported=await page.evaluate(html=>{const outer=document.createElement('div');outer.innerHTML=html;document.body.append(outer);let text='';const w=document.createTreeWalker(outer,NodeFilter.SHOW_ELEMENT|NodeFilter.SHOW_TEXT);for(let n=w.nextNode();n;n=w.nextNode()){if(n.nodeType===3)text+=n.data;else if(n.nodeName==='BR')text+='\n';}const whiteSpace=getComputedStyle(outer.firstElementChild).whiteSpace;outer.remove();return {text,whiteSpace};},data.values['text/html']);
  assert.equal(exported.text,text);assert.ok(['break-spaces','pre'].includes(exported.whiteSpace));
  return data.values;
}
async function paste(page,text) {return page.evaluate(text=>{const f=window.inputFixture;const e=window.preparedClipboardEvent('paste',{getData:t=>t==='text/plain'?text:'',setData:()=>{}});f.root.dispatchEvent(e);return f.protocol.clipboard.last;},text);}
async function undoRedo(page,fact,text,initial='') {
  const groups=await page.evaluate(()=>window.inputFixture.engine.history({type:'state'}).undoGroups);
  assert.ok(groups>0);
  for(let i=0;i<groups;i++)await page.keyboard.press(`${primary}+z`);await state(page,fact,initial);
  for(let i=0;i<groups;i++)await page.keyboard.press(`${primary}+Shift+z`);await state(page,fact,text);
}
async function reopen(page,fact,text) {await page.evaluate(()=>window.inputFixture.reopen());await state(page,fact,text);}

for(const mode of ['typing','paste','native','composition'])test(`SPC-01 authored leading/repeated/trailing spaces ${mode}`,()=>probe(`SPC-01-${mode}`,async(page,fact)=>{
  const text='  a  b   ';fact.input=mode==='typing'?'actual Playwright typing':'prepared '+mode;
  if(mode==='typing')await page.keyboard.type(text);
  else if(mode==='paste')assert.equal((await paste(page,text)).disposition,'committed');
  else await page.evaluate(({text,mode})=>{const f=window.inputFixture;if(mode==='composition')f.event('compositionstart');f.mutate(text);f.event('input',{inputType:mode==='composition'?'insertCompositionText':'insertText',data:text,isComposing:mode==='composition'});if(mode==='composition')f.event('compositionend',{data:text});},{text,mode});
  let s=await state(page,fact,text,text.length);assert.ok(s.history.undoGroups>0);assert.equal(s.recovery.length,0);
  const geometry=await page.evaluate(()=>{const f=window.inputFixture,b=f.renderer.getBlock(f.ids[0]),n=document.createTreeWalker(b,NodeFilter.SHOW_TEXT).nextNode(),r=document.createRange();r.setStart(n,n.length-3);r.setEnd(n,n.length);const rect=r.getBoundingClientRect();return {width:rect.width,height:rect.height,whiteSpace:getComputedStyle(b).whiteSpace,text:b.textContent};});
  fact.geometry=geometry;assert.equal(geometry.whiteSpace,'break-spaces');assert.ok(geometry.width>0&&geometry.height>0);assert.equal(geometry.text,text);
  if(process.env.EDITAC_INTERACTION_WHITESPACE_OUTPUT){const file=`SPC-01-${mode}.png`;await writeFile(join(process.env.EDITAC_INTERACTION_WHITESPACE_OUTPUT,file),await page.screenshot());fact.screenshot=file;}
  await copy(page,text);await undoRedo(page,fact,text);await reopen(page,fact,text);
}));

const unicode=[['SPC-02','\u00a0\u202f\t\u200b\u200c\u200d\ufeff'],['SPC-04','é e\u0301 ﬁ Ａ 😀 \u2066אב\u2069\u200e\u200f'],['SPC-02-04',' \u00a0\t e\u0301 \u2067אב\u2069 ']];
for(const [id,text] of unicode)for(const mode of ['insert','paste'])test(`${id} exact characters ${mode}`,()=>probe(`${id}-${mode}`,async(page,fact)=>{
  if(mode==='insert')await page.keyboard.insertText(text);else assert.equal((await paste(page,text)).disposition,'committed');
  await state(page,fact,text,text.length);
  const positions=await page.evaluate(text=>{const f=window.inputFixture;let offset=0;const points=[0];for(const char of text){offset+=char.length;points.push(offset);}return points.map(offset=>{const at=f.selection.toDOM({node:f.ids[0],offset,bias:'right'});return [offset,at&&f.selection.toModel(at.node,at.offset)?.offset];});},text);
  fact.positions=positions;for(const [expected,actual]of positions)assert.equal(actual,expected,'Unicode scalar UTF-16 mapping');
  const values=await copy(page,text);fact.exports=values;
  const before=await page.evaluate(()=>window.inputFixture.state());
  const summary=await page.evaluate(()=>{const f=window.inputFixture;f.renderer.setInvisibleCharacters(true);return f.renderer.getBlock(f.ids[0]).title;});
  assert.match(summary,/Invisible characters \(UTF-16\):/);
  const after=await state(page,fact,text);assert.deepEqual(after.patches,before.patches);assert.deepEqual(after.history,before.history);assert.deepEqual(after.journal,before.journal);
  await page.evaluate(()=>window.inputFixture.renderer.setInvisibleCharacters(false));
  assert.equal(await page.evaluate(()=>window.inputFixture.renderer.getBlock(window.inputFixture.ids[0]).hasAttribute('title')),false);
  await undoRedo(page,fact,text);await reopen(page,fact,text);
  // Supported internal export is round-tripped through the real clipboard gate.
  await page.evaluate(async values=>{const f=window.inputFixture;await f.destroy();await f.mount('',null);f.root.dispatchEvent(window.preparedClipboardEvent('paste',{getData:t=>values[t]??'',setData:()=>{}}));},values);
  await state(page,fact,text,text.length);
  await page.evaluate(async html=>{const f=window.inputFixture;await f.destroy();await f.mount('',null);f.root.dispatchEvent(window.preparedClipboardEvent('paste',{getData:t=>t==='text/html'?html:'',setData:()=>{}}));},values['text/html']);
  await state(page,fact,text,text.length);
}));

for(const ending of ['\r\n','\r','\n'])for(const code of [false,true])for(const activated of [false,true])test(`SPC-03 ${JSON.stringify(ending)} ${code?'code':'prose'} literal final blank lines activated=${activated}`,()=>probe(`SPC-03-${escaped(ending).replaceAll(' ','-')}-${code}-${activated}`,async(page,fact)=>{
  if(code)await page.evaluate(()=>{const f=window.inputFixture;f.engine.commit(f.engine.prepare({kind:'editor',origin:'fixture',commands:[{type:'setCode',owner:f.ids[0],language:'txt'}]}));f.engine.history({type:'clear'});});
  const raw=` a${ending}${ending}b ${ending}${ending}`,text=' a\n\nb \n\n';fact.source=escaped(raw);
  const outcome=activated?await page.evaluate(raw=>window.inputFixture.protocol.clipboard.pastePlainText(async()=>raw),raw):await paste(page,raw);
  assert.equal(outcome.disposition,'committed');const s=await state(page,fact,text,text.length);assert.equal(s.history.undoGroups,1);
  const render=await page.evaluate(()=>{const f=window.inputFixture,b=f.renderer.getBlock(f.ids[0]);return {breaks:b.querySelectorAll('br:not([data-placeholder])').length,whiteSpace:getComputedStyle(b).whiteSpace};});
  fact.render=render;assert.equal(render.whiteSpace,code?'pre':'break-spaces');assert.equal(render.breaks,code?0:4);
  await copy(page,text);await undoRedo(page,fact,text);await reopen(page,fact,text);
}));

test('SPC-01/03 empty placeholder never becomes copied or restored content',()=>probe('SPC-01-placeholder',async(page,fact)=>{
  assert.equal(await page.evaluate(()=>window.inputFixture.root.querySelectorAll('br[data-placeholder]').length),1);
  await page.evaluate(()=>{const f=window.inputFixture;const b=f.renderer.getBlock(f.ids[0]);const placeholder=b.querySelector('br');const n=document.createTextNode(' ');b.prepend(n);document.getSelection().setBaseAndExtent(n,1,n,1);f.event('input',{inputType:'insertText',data:' '});});
  await state(page,fact,' ',1);await copy(page,' ');await undoRedo(page,fact,' ');await reopen(page,fact,' ');
}));

const invalid=['x\ud800','x\udfff','x\ud800y','x\u0000','x\u000b','x\u001f','x\u007f','x\u0085'];
for(const [index,text] of invalid.entries())for(const mode of ['insert','paste','activated','html','markdown','native','composition'])test(`SPC-05 reject ${index} ${mode} before mutation`,()=>probe(`SPC-05-${index}-${mode}`,async(page,fact)=>{
  await page.evaluate(()=>window.inputFixture.select(window.inputFixture.ids[0],1,4));
  const before=await page.evaluate(()=>window.inputFixture.state());
  if(mode==='activated')assert.equal((await page.evaluate(text=>window.inputFixture.protocol.clipboard.pastePlainText(async()=>text),text)).disposition,'rejected');
  else if(mode==='markdown')assert.equal(await page.evaluate(text=>{const f=window.inputFixture;f.root.dispatchEvent(window.preparedClipboardEvent('paste',{getData:t=>t==='text/markdown'?text:'',setData:()=>{}}));return f.protocol.clipboard.last.disposition;},text),'rejected');
  else if(mode==='html')assert.equal(await page.evaluate(text=>{const f=window.inputFixture;f.root.dispatchEvent(window.preparedClipboardEvent('paste',{getData:t=>t==='text/html'?`<p>${text}</p>`:'',setData:()=>{}}));return f.protocol.clipboard.last.disposition;},text),'rejected');
  else if(mode==='paste')assert.equal((await paste(page,text)).disposition,'rejected');
  else await page.evaluate(({text,mode})=>{const f=window.inputFixture;if(mode==='insert')f.event('beforeinput',{inputType:'insertText',data:text,cancelable:true});else {if(mode==='composition')f.event('compositionstart');f.mutate('a'+text+'a');f.event('input',{inputType:mode==='composition'?'insertCompositionText':'insertText',data:text,isComposing:mode==='composition'});if(mode==='composition')f.event('compositionend',{data:text});}},{text,mode});
  const s=await state(page,fact,'alpha');assert.deepEqual(s.history,before.history);assert.deepEqual(s.journal,before.journal);assert.deepEqual(s.patches,before.patches);
  const recovery=(mode==='paste'||mode==='activated'||mode==='html'||mode==='markdown')?await page.evaluate(()=>window.inputFixture.protocol.clipboard.recovery):s.recovery;
  const r=recovery.at(-1);assert.match(r.reason,/^(malformed-utf16|unsupported-control):/);assert.equal((mode==='paste'||mode==='activated'||mode==='html'||mode==='markdown')?r.raw:r.text,mode==='native'||mode==='composition'?'a'+text+'a':mode==='html'?`<p>${text}</p>`:text);
  if(mode==='paste'||mode==='activated'||mode==='html'||mode==='markdown'||mode==='insert')assert.equal(s.caret.offset,1);
  fact.rejectedSource=escaped(text);await reopen(page,fact,'alpha');
},'alpha'));
