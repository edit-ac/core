import assert from 'node:assert/strict';
import { test } from 'node:test';
import { browserHarness } from './browser-harness.ts';
const {probe}=browserHarness('markdown-extensions');
async function all(page){await page.evaluate(()=>{const f=window.inputFixture,n=f.engine.read().visible.filter(n=>n.kind==='block'),a=f.selection.toDOM({node:n[0].id,offset:0,bias:'right'}),b=f.selection.toDOM({node:n.at(-1).id,offset:n.at(-1).runs.map(r=>r.text).join('').length,bias:'left'});f.root.focus();document.getSelection().setBaseAndExtent(a.node,a.offset,b.node,b.offset);f.selection.capture();});}
async function state(page,fact){const s=await page.evaluate(async()=>{const f=window.inputFixture;return {...await f.state(),nodes:f.engine.read().visible,result:f.protocol.clipboard.last,diagnostics:f.protocol.clipboard.diagnostics,recovered:f.protocol.clipboard.recovery};});fact.snapshots.push(s);assert.deepEqual(s.errors,[]);return s;}
for(const [name,raw,tag]of [['image','![alt](https://example.com/i.png)','image'],['table','| A | B |\n|:-|:-:|\n| **bold** | 😀 |','table'],['callout','> [!WARNING]\n> **careful** 😀\n>\n> - detail\n','callout']]){
 test(`built-in ${name} option is atomic and preserves export`,()=>probe(name,async(page,fact)=>{await all(page);await page.evaluate(raw=>{const f=window.inputFixture;f.protocol.clipboard.contentCodecs={images:true,tables:true,callouts:true};f.protocol.clipboard.paste({getData:m=>m==='text/markdown'?raw:''});},raw);let s=await state(page,fact);assert.equal(s.result.disposition,'committed');assert.equal(s.journal.length,1);assert.equal(s.history.undoGroups,1);const content=s.nodes.find(n=>n.blockAttributes?.[0]===`module:editac.${tag}`);assert.ok(content);assert.equal(content.blockAttributes[2].source,raw);await page.evaluate(()=>window.inputFixture.engine.history({type:'undo'}));s=await state(page,fact);assert.deepEqual(s.text,['alpha','independent']);await page.evaluate(()=>window.inputFixture.engine.history({type:'redo'}));s=await state(page,fact);assert.ok(s.nodes.some(n=>n.blockAttributes?.[0]===`module:editac.${tag}`));}));
}
test('custom prepare and serialize hooks retain exact source and first-frame semantics',()=>probe('custom',async(page,fact)=>{await all(page);const r=await page.evaluate(()=>{const f=window.inputFixture,extension={name:'badge',prepare:p=>p.source.startsWith('[badge] ')?[{attributes:{type:'heading',level:2},runs:[{text:p.source.slice(8),marks:[{mark:'bold'}]}]}]:undefined,serialize:b=>b.length===1&&b[0].attributes?.type==='heading'?'[badge] '+b[0].runs.map(r=>r.text).join(''):undefined},options={extensions:[extension]};const before=f.engine.checkpoint().bytes,p=f.engine.importMarkdown('[badge] é😀',options),e=f.engine.exportMarkdown(p.blocks,options),after=f.engine.checkpoint().bytes;f.protocol.clipboard.contentCodecs=options;f.protocol.clipboard.paste({getData:m=>m==='text/markdown'?'[badge] é😀':''});return {p,e,before:Array.from(before),after:Array.from(after)};});assert.deepEqual(r.before,r.after);assert.equal(r.p.source,'[badge] é😀');assert.equal(r.e.markdown,r.p.source);assert.deepEqual(r.e.diagnostics,[]);const s=await state(page,fact);assert.deepEqual(s.text,['é😀']);assert.deepEqual(s.nodes[0].blockAttributes,['heading',2]);assert.equal(s.nodes[0].runs[0].attributes.bold,true);assert.equal(s.journal.length,1);
}));
test('duplicate names and unsafe extension output recover source with zero effects', () => probe('rejection', async (page, fact) => {
  const r = await page.evaluate(() => {
    const f = window.inputFixture, before = Array.from(f.engine.checkpoint().bytes), errors = [];
    const cases = [
      { extensions: [{ name: 'same' }, { name: 'same' }] },
      { extensions: [{ name: 'unsafe', prepare: () => [
        { attributes: { type: 'paragraph' }, runs: [{ text: 'bad', marks: [{ mark: 'link', href: 'javascript:alert(1)' }] }] }
      ] }] }
    ];
    for (const options of cases) {
      try { f.engine.importMarkdown('source', options); } catch (e) { errors.push(e.message); }
    }
    return { before, after: Array.from(f.engine.checkpoint().bytes), errors };
  });
  assert.deepEqual(r.before, r.after); assert.equal(r.errors.length, 2);
  assert.equal((await state(page, fact)).journal.length, 0);
}));
test('disabled callout and false custom serialization have explicit recovery',()=>probe('recovery',async(page,fact)=>{const r=await page.evaluate(()=>{const f=window.inputFixture,p=f.engine.importMarkdown('> [!NOTE]\n> body'),e=f.engine.exportMarkdown(f.engine.importMarkdown('**safe**').blocks,{extensions:[{name:'wrong',serialize:()=> 'lost'}]});return {p,e};});assert.ok(r.p.diagnostics.some(d=>d.code==='callout-codec-disabled'));assert.equal(r.e.diagnostics[0].code,'extension-unrepresentable');assert.ok(r.e.recovery.length);assert.equal((await state(page,fact)).journal.length,0);}));
