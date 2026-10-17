import assert from 'node:assert/strict';
import {test} from 'node:test';
import {selectAll,paste,state} from './format-helpers.ts';

export function registerHtmlPasteCases(probe) {
test('safe headings, nested lists, marks, links and code import in one batch',()=>probe('palette',async(page,fact)=>{
  await selectAll(page);
  await paste(page,{'text/html':'<h2><strong>é😀</strong></h2><ol start="3"><li><em>one</em><ul><li><u>two</u></li></ul></li></ol><p><a href="https://example.com/a">link</a><s>strike</s><code>literal</code></p><pre>  x\n\ty</pre>'});
  let s=await state(page,fact);assert.equal(s.result.disposition,'committed');assert.equal(s.journal.length,1);assert.equal(s.history.undoGroups,1);
  const blocks=s.nodes.filter(n=>n.kind==='block');assert.deepEqual(blocks[0].blockAttributes,['heading',2]);assert.equal(blocks[0].runs[0].attributes.bold,true);
  assert.ok(blocks.some(n=>n.runs.some(r=>r.attributes.link==='https://example.com/a')));assert.equal(blocks.at(-1).runs[0].text,'  x\n\ty');
  assert.ok(s.nodes.some(n=>n.editor?.containerAttributes?.[0]==='ordered' && n.editor.containerAttributes[1]===3));
  await page.evaluate(()=>window.inputFixture.engine.history({type:'undo'}));s=await state(page,fact);assert.deepEqual(s.text,['alpha','independent']);
  await page.evaluate(()=>window.inputFixture.engine.history({type:'redo'}));s=await state(page,fact);assert.equal(s.text[0],'é😀');
}));
test('executable elements, handlers and CSS never execute or load',()=>probe('inert',async(page,fact)=>{
  const loads=[];page.on('request',r=>{if(r.url().includes('attack.invalid'))loads.push(r.url());});await selectAll(page);
  const raw='<script>window.compromised=1</script><iframe src="https://attack.invalid/frame"></iframe><style>@import "https://attack.invalid/css";</style><p onclick="window.compromised=1" style="background:url(https://attack.invalid/bg);font-weight:bold">safe</p>';
  await paste(page,{'text/html':raw});const s=await state(page,fact);assert.deepEqual(s.text,['safe']);assert.equal(await page.evaluate(()=>window.compromised),undefined);assert.deepEqual(loads,[]);assert.ok(s.diagnostics.includes('html-executable-dropped'));assert.equal(s.recovery[0].raw,raw);assert.equal(s.journal.length,1);
}));
test('decoded unsafe and relative URL attributes become inert text with recovery',()=>probe('urls',async(page,fact)=>{
  await selectAll(page);const raw=['java&#115;cript:alert(1)','data:text/html,x','https://user:password@example.com/','https://example.com/%0a','/relative','#local'].map(h=>`<a href="${h}">safe</a>`).join('');await paste(page,{'text/html':raw});const s=await state(page,fact);assert.equal(s.result.disposition,'committed');assert.ok(s.nodes.every(n=>n.runs.every(r=>!r.attributes.link)));assert.ok(s.diagnostics.includes('html-url-dropped'));assert.equal(s.recovery[0].raw,raw);
}));
test('optional resources and SVG stay recoverable and cannot load',()=>probe('optional',async(page,fact)=>{
  const loads=[];page.on('request',r=>{if(r.url().includes('attack.invalid'))loads.push(r.url());});const raw='<svg onload="window.compromised=1"></svg><img src="https://attack.invalid/image" onerror="window.compromised=1">';
  await selectAll(page);await paste(page,{'text/html':raw,'text/plain':'fallback'});const s=await state(page,fact);assert.deepEqual(s.text,['fallback']);assert.equal(s.recovery[0].raw,raw);assert.deepEqual(loads,[]);assert.equal(s.history.undoGroups,1);
}));
test('byte, nesting and attribute limits reject before history or storage mutation',()=>probe('limits',async(page,fact)=>{
  for(const raw of ['x'.repeat(1048577),'<div>'.repeat(34)+'x'+'</div>'.repeat(34),'<p title="'+'x'.repeat(4097)+'">x</p>']){
    const before=await page.evaluate(()=>Array.from(window.inputFixture.engine.checkpoint().bytes));await paste(page,{'text/html':raw});const s=await state(page,fact);assert.equal(s.result.disposition,'rejected');assert.equal(s.journal.length,0);assert.equal(s.history.undoGroups,0);assert.deepEqual(await page.evaluate(()=>Array.from(window.inputFixture.engine.checkpoint().bytes)),before);
  }
}));
test('malformed HTML normalizes safely and explicit literal paste ignores it',()=>probe('malformed',async(page,fact)=>{
  await selectAll(page);await paste(page,{'text/html':'<p><b>bold<i>nested</b> tail</i></p>'});let s=await state(page,fact);assert.equal(s.result.disposition,'committed');assert.equal(s.text.join(''),'boldnested tail');
  await page.evaluate(()=>window.inputFixture.engine.history({type:'undo'}));await selectAll(page);await paste(page,{'text/html':'<h1>wrong</h1>','text/plain':'<b>literal</b>'},{literal:true});s=await state(page,fact);assert.deepEqual(s.text,['<b>literal</b>']);
}));

}
