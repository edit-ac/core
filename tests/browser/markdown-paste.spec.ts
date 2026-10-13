import assert from 'node:assert/strict';
import { test } from 'node:test';
import { browserHarness } from './browser-harness.ts';
const { probe } = browserHarness('markdown-paste');
async function replace(page, flavors, policy = 'markdown', literal = false) {
  return page.evaluate(({flavors,policy,literal}) => {
    const f=window.inputFixture, n=f.engine.read().visible.filter(n=>n.kind==='block');
    const a=f.selection.toDOM({node:n[0].id,offset:0,bias:'right'}), b=f.selection.toDOM({node:n.at(-1).id,offset:n.at(-1).runs.map(r=>r.text).join('').length,bias:'left'});
    f.root.focus();document.getSelection().setBaseAndExtent(a.node,a.offset,b.node,b.offset);f.selection.capture();
    f.protocol.clipboard.plainTextPolicy=policy;
    return f.protocol.clipboard.paste({getData:m=>flavors[m]??''},{literal});
  },{flavors,policy,literal});
}
async function read(page,fact) {
  const s=await page.evaluate(async()=>{const f=window.inputFixture,s=await f.state();return {...s,nodes:f.engine.read().visible,result:f.protocol.clipboard.last,diagnostics:f.protocol.clipboard.diagnostics,recovered:f.protocol.clipboard.recovery};});
  fact.snapshots.push(s);assert.deepEqual(s.errors,[]);return s;
}
test('first frame is formatted; one update, storage record and undo group; repeated redo',()=>probe('atomic',async(page,fact)=>{
  await page.evaluate(()=>{const f=window.inputFixture;window.formattedFrames=[];f.engine.subscribe({type:'all'},p=>{if(p.update) window.formattedFrames.push({nodes:f.engine.read().visible,html:f.root.innerHTML});});});
  await replace(page,{'text/plain':'## **Bold**\n\n[ref][x]\n\n[x]: https://example.com'});
  let s=await read(page,fact);assert.equal(s.result.disposition,'committed');assert.deepEqual(s.text,['Bold','ref']);assert.deepEqual(s.nodes[0].blockAttributes,['heading',2]);assert.equal(s.nodes[0].runs[0].attributes.bold,true);assert.equal(s.nodes[1].runs[0].attributes.link,'https://example.com/');assert.equal(s.journal.length,1);assert.equal(s.history.undoGroups,1);
  const frames=await page.evaluate(()=>window.formattedFrames);assert.equal(frames.length,1);assert.match(frames[0].html,/<h2/);assert.match(frames[0].html,/<strong/);
  for(let i=0;i<2;i++){await page.evaluate(()=>window.inputFixture.engine.history({type:'undo'}));s=await read(page,fact);assert.deepEqual(s.text,['alpha','independent']);await page.evaluate(()=>window.inputFixture.engine.history({type:'redo'}));s=await read(page,fact);assert.deepEqual(s.text,['Bold','ref']);assert.equal(s.nodes[0].runs[0].attributes.bold,true);}
}));
test('whole parser sees nested fences lists and reference definitions',()=>probe('whole-document',async(page,fact)=>{
  await replace(page,{'text/markdown':'> - [x] **task**\n>   ```js\n>   **literal**\n>   ```\n\n[late][id]\n\n[id]: https://example.com/a'});
  const s=await read(page,fact),blocks=s.nodes.filter(n=>n.kind==='block');assert.equal(s.result.disposition,'committed');assert.ok(blocks.some(n=>n.editor.checked===true));assert.ok(blocks.some(n=>n.blockAttributes[0]==='code'&&n.runs.map(r=>r.text).join('')==='**literal**\n'));assert.ok(blocks.some(n=>n.runs.some(r=>r.attributes.link==='https://example.com/a')));assert.equal(s.history.undoGroups,1);
}));
test('minimal and explicit plain preserve Unicode whitespace and Markdown',()=>probe('literal',async(page,fact)=>{
  const raw='# 😀\n  **x**\t\r\n';await replace(page,{'text/plain':raw},'literal');let s=await read(page,fact);assert.deepEqual(s.text,[raw]);assert.deepEqual(s.nodes[0].blockAttributes,['paragraph']);await page.evaluate(()=>window.inputFixture.engine.history({type:'undo'}));await replace(page,{'text/markdown':'# wrong','text/plain':raw},'markdown',true);s=await read(page,fact);assert.deepEqual(s.text,[raw]);
}));
test('internal before Markdown before HTML before plain',()=>probe('precedence',async(page,fact)=>{
 const internal=JSON.stringify({version:1,schema:'editac.registry.editor.v5',blocks:[{attributes:{type:'paragraph'},runs:[{text:'internal',marks:[]}]}]});
 await replace(page,{'application/x-edit-ac-fragment+json':internal,'text/markdown':'# md','text/html':'<h2>html</h2>','text/plain':'plain'});let s=await read(page,fact);assert.deepEqual(s.text,['internal']);await page.evaluate(()=>window.inputFixture.engine.history({type:'undo'}));await replace(page,{'text/x-markdown':'# md','text/html':'<h2>html</h2>','text/plain':'plain'});s=await read(page,fact);assert.deepEqual(s.text,['md']);assert.deepEqual(s.nodes[0].blockAttributes,['heading',1]);
}));
test('disabled modules keep exact source with diagnostics and recovery',()=>probe('disabled',async(page,fact)=>{
 const raw='![alt](https://example.com/i.png)';await replace(page,{'text/markdown':raw});const s=await read(page,fact);assert.deepEqual(s.text,[raw]);assert.ok(s.diagnostics.includes('image-codec-disabled'));assert.equal(s.recovered[0].raw,raw);
}));
test('portable bridge is read-only and deterministic',()=>probe('bridge',async(page,fact)=>{
 const r=await page.evaluate(()=>{const f=window.inputFixture,before=f.engine.read(),p=f.engine.importMarkdown('# **é😀**'),e=f.engine.exportMarkdown(p.blocks);return {before,after:f.engine.read(),p,e};});assert.deepEqual(r.before,r.after);assert.equal(r.p.source,'# **é😀**');assert.equal(r.e.markdown,'# **é😀**\n');assert.deepEqual(r.e.diagnostics,[]);assert.equal((await read(page,fact)).journal.length,0);
}));
test('code destination overrides the Markdown policy',()=>probe('code',async(page,fact)=>{
 await page.evaluate(()=>{const f=window.inputFixture,n=f.engine.read().visible[0];f.engine.commit(f.engine.prepare({kind:'editor',origin:'setup',commands:[{type:'setCode',owner:n.id,language:'js'}]}));f.engine.history({type:'clear'});const p=f.selection.toDOM({node:n.id,offset:5,bias:'right'});f.root.focus();document.getSelection().setBaseAndExtent(p.node,p.offset,p.node,p.offset);f.selection.capture();f.protocol.clipboard.plainTextPolicy='markdown';f.protocol.clipboard.paste({getData:m=>m==='text/plain'?'**literal**':m==='text/markdown'?'# wrong':''});});const s=await read(page,fact);assert.equal(s.text[0],'alpha**literal**');assert.deepEqual(s.nodes[0].blockAttributes,['code','js']);assert.equal(s.history.undoGroups,1);
}));
