import assert from 'node:assert/strict';
import {test} from 'node:test';
import {browserHarness} from './browser-harness.ts';
const {probe}=browserHarness('optional-markdown','fixtures/browser-input',{markdown:false,packages:['core','web','markdown']});

test('default typing and plain paste stay literal without any parser request',()=>probe('default-literal',async(page,fact)=>{
  const requests=[];page.on('request',r=>requests.push(r.url()));
  await page.keyboard.type(' **literal**');
  const result=await page.evaluate(async()=>{const f=window.inputFixture;f.protocol.clipboard.paste({getData:m=>m==='text/plain'?' [link](https://example.com)':''});const s=await f.state();return {s,available:f.engine.markdownAvailable,nodes:f.engine.read().visible};});
  assert.equal(result.available,false);assert.equal(result.s.text[0],'# **literal** [link](https://example.com)');
  assert.deepEqual(result.nodes[0].blockAttributes,['paragraph']);
  assert(!result.nodes[0].runs.some(r=>r.attributes.bold||r.attributes.link));assert(!fact.requests.some(u=>u.includes('/markdown/')));
  fact.snapshots.push({...result,requests});
},'#'));

test('unavailable named Markdown preserves exact source and admits safe HTML fallback',()=>probe('unavailable-fallback',async(page,fact)=>{
 const result=await page.evaluate(async()=>{const f=window.inputFixture;const raw='# **unavailable 😀**';
 const outcome=f.protocol.clipboard.paste({getData:m=>m==='text/markdown'?raw:m==='text/html'?'<strong>safe</strong> <a href="https://例え.テスト/道">international</a>':''});
 return {outcome,s:await f.state(),recovery:f.protocol.clipboard.recovery,diagnostics:f.protocol.clipboard.diagnostics,nodes:f.engine.read().visible};});
 assert.equal(result.outcome.disposition,'committed');assert(result.diagnostics.includes('markdown-codec-unavailable'));
 assert(result.recovery.some(r=>r.raw==='# **unavailable 😀**'&&r.reason==='markdown-codec-unavailable'));
 assert(result.nodes[0].runs.some(r=>r.attributes.bold));assert(result.nodes[0].runs.some(r=>String(r.attributes.link).startsWith('https://xn--')));
 fact.snapshots.push(result);
}));

test('explicit unavailable plain policy falls back literally without fetching or losing source',()=>probe('unavailable-policy',async(page,fact)=>{
 const requests=[];page.on('request',r=>requests.push(r.url()));
 const result=await page.evaluate(async()=>{const f=window.inputFixture;f.protocol.clipboard.plainTextPolicy='markdown';const raw='**source**';
 const outcome=f.protocol.clipboard.paste({getData:m=>m==='text/plain'?raw:''});return {outcome,s:await f.state(),recovery:f.protocol.clipboard.recovery};});
 assert.equal(result.outcome.disposition,'committed');assert.equal(result.s.text[0],'alpha**source**');
 assert(result.recovery.some(r=>r.raw==='**source**'&&r.reason==='markdown-codec-unavailable'));assert(!fact.requests.some(u=>u.includes('/markdown/')));
 fact.snapshots.push({...result,requests});
}));

test('explicit opt-in formats on the same document and disposal restores literal behavior',()=>probe('opt-in-dispose',async(page,fact)=>{
 const requests=[];page.on('request',r=>requests.push(r.url()));
 const before=await page.evaluate(()=>window.inputFixture.engine.read().identity);
 await page.evaluate(async()=>{const f=window.inputFixture;const {initMarkdown}=await import('/markdown/index.js');const {markdownExtension}=await import('/markdown/web.js');
 const adapter=markdownExtension(await initMarkdown('/markdown/wasm/editac_markdown_wasm_bg.wasm'));window.registration=f.engine.registerMarkdown(adapter.codec);
 f.protocol.shortcuts=adapter.createShortcuts(f.engine,request=>f.engine.commit(f.engine.prepare(request)));f.protocol.clipboard.plainTextPolicy='markdown';
 const id=f.engine.read().visible[0].id;f.select(id,0,5);f.protocol.clipboard.paste({getData:m=>m==='text/plain'?'# **enabled**':''});});
 const enabled=await page.evaluate(async()=>{const f=window.inputFixture;return {s:await f.state(),nodes:f.engine.read().visible,identity:f.engine.read().identity};});
 assert.deepEqual(enabled.identity,before);assert.deepEqual(enabled.nodes[0].blockAttributes,['heading',1]);assert.equal(enabled.nodes[0].runs[0].attributes.bold,true);
 const disabled=await page.evaluate(async()=>{const f=window.inputFixture;window.registration.dispose();f.engine.history({type:'undo'});f.select(f.engine.read().visible[0].id,0,5);
 f.protocol.clipboard.paste({getData:m=>m==='text/plain'?'# literal':''});return {s:await f.state(),nodes:f.engine.read().visible,available:f.engine.markdownAvailable};});
 assert.equal(disabled.available,false);assert.equal(disabled.s.text[0],'# literal');assert.deepEqual(disabled.nodes[0].blockAttributes,['paragraph']);
 assert.equal(requests.filter(u=>u.endsWith('/markdown/wasm/editac_markdown_wasm_bg.wasm')).length,1);
 fact.snapshots.push({before,enabled,disabled,requests});
}));

test('borrowed surface owns registration cleanup through disposal and remount',()=>probe('surface-lifecycle',async(page,fact)=>{
 const result=await page.evaluate(async()=>{const f=window.inputFixture;const {mountEditorSurface}=await import('/web/index.js');const {initMarkdown}=await import('/markdown/index.js');const {markdownExtension}=await import('/markdown/web.js');
 const markdown=markdownExtension(await initMarkdown('/markdown/wasm/editac_markdown_wasm_bg.wasm'));const root=document.createElement('div');document.body.append(root);f.engine.read();const before=f.engine.checkpoint();
 const first=mountEditorSurface(root,f.engine,{markdown,readOnly:true});const enabled=f.engine.markdownAvailable;first.dispose();first.dispose();const disabled=!f.engine.markdownAvailable;
 const second=mountEditorSurface(root,f.engine,{markdown,readOnly:true});const remounted=f.engine.markdownAvailable;second.dispose();root.remove();
 return {enabled,disabled,remounted,after:f.engine.checkpoint(),before,available:f.engine.markdownAvailable};});
 assert.equal(result.enabled,true);assert.equal(result.disabled,true);assert.equal(result.remounted,true);assert.equal(result.available,false);assert.deepEqual(result.after,result.before);fact.snapshots.push(result);
}));

test('failed optional surface setup releases registration and mount reservation',()=>probe('surface-failure',async(page,fact)=>{
 const result=await page.evaluate(async()=>{const f=window.inputFixture;const {mountEditorSurface}=await import('/web/index.js');const {initMarkdown}=await import('/markdown/index.js');const {markdownExtension}=await import('/markdown/web.js');
 const markdown=markdownExtension(await initMarkdown('/markdown/wasm/editac_markdown_wasm_bg.wasm'));const root=document.createElement('div');document.body.append(root);f.engine.read();const before=f.engine.checkpoint();let failure;
 try{mountEditorSurface(root,f.engine,{markdown:{codec:markdown.codec,createShortcuts(){throw Error('prepared adapter failure');}}});}catch(error){failure=error.message;}
 const unavailable=!f.engine.markdownAvailable;const view=mountEditorSurface(root,f.engine,{markdown,readOnly:true});view.dispose();root.remove();return {failure,unavailable,before,after:f.engine.checkpoint(),available:f.engine.markdownAvailable};});
 assert.equal(result.failure,'prepared adapter failure');assert.equal(result.unavailable,true);assert.equal(result.available,false);assert.deepEqual(result.before,result.after);fact.snapshots.push(result);
}));
