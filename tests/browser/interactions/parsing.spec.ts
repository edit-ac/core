import assert from 'node:assert/strict';
import {test} from 'node:test';
import {browserHarness} from '../browser-harness.ts';
const {probe:rawProbe,facts}=browserHarness('interaction-parsing','fixtures/browser-parsing',{
 markdown:true,assertSourcesUnchanged:true,testFile:'tests/browser/interactions/parsing.spec.ts',sourcePaths:[
 'fixtures/browser-parsing/session.mjs','fixtures/browser-parsing/index.html','packages/web/src/surface.ts',
 'packages/markdown/src/shortcuts.ts','packages/web/src/input/shortcuts.ts','packages/web/src/input/text.ts',
 'scripts/test-interactions.mjs','scripts/test-parsing-vectors.mjs','fixtures/markdown/commonmark-0.31.2.json','fixtures/markdown/gfm-required.json',
 'packages/markdown/dist/shortcuts.js','packages/markdown/dist/wasm/editac_markdown_wasm_bg.wasm','packages/core/dist/wasm/editac_wasm_bg.wasm']});
facts.binding={gate:'INT-1.11',ids:Array.from({length:8},(_,i)=>`PAR-0${i+1}`),provenance:'Current packed Session/WASM, recovered IndexedDB and production DOM input; trusted Playwright keyboard, explicitly prepared nonlocal traces. No native/AT/device claim.'};
const mod=process.platform==='darwin'?'Meta':'Control';
function probe(name,action,value=''){return rawProbe(name,async(page,fact)=>{fact.caseIds=[name.slice(0,6)];await action(page,fact);},value);}
async function state(page,fact){const s=await page.evaluate(()=>window.inputFixture.state());fact.snapshots.push(s);assert.deepEqual(s.errors,[]);return s;}
async function codec(page,source){return page.evaluate(source=>{const c=window.inputFixture.codec,p=c.importMarkdown(source),e=c.exportMarkdown(p.blocks),again=c.importMarkdown(e.markdown);return {p,e,again};},source);}
const text=blocks=>blocks.map(b=>b.runs.map(r=>r.text).join('')).join('\n');
for(const [name,a,b]of [
 ['strong','**é😀**','__é😀__'],['emphasis','*e\u0301*','_e\u0301_'],['heading','# title\n','title\n=====\n'],
 ['heading-two','## title\n','title\n-----\n'],['fence','```js\nconst a = 1;\n```\n','~~~~js\nconst a = 1;\n~~~~\n'],
 ['ordered','3. three\n4. four\n','3) three\n4) four\n'],['unordered','- one\n- two\n','+ one\n+ two\n']
])test(`PAR-01 ${name} equivalent syntax has canonical semantics`,()=>probe(`PAR-01-${name}`,async(page,fact)=>{
 const x=await codec(page,a),y=await codec(page,b);fact.grammar={a,b,x,y};assert.deepEqual(x.p.diagnostics,[]);assert.deepEqual(y.p.diagnostics,[]);assert.equal(x.e.markdown,y.e.markdown);assert.deepEqual(x.again.blocks,x.p.blocks);assert.equal((await state(page,fact)).journal.length,0);
}));
for(const [prefix,last,mark]of [['**é😀*','*','bold'],['__bold_','_','bold'],['_italic','_','italic'],['~~strike~','~','strike'],['`code','`','code'],['***nested**','*','italic'],['\\*escaped* and **bold*','*','bold']])test(`PAR-02 local ${prefix} completion and source restoration`,()=>probe(`PAR-02-complete-${mark}-${Buffer.from(prefix).toString("hex")}`,async(page,fact)=>{
 await page.keyboard.type(last);let s=await state(page,fact);assert.ok(s.nodes[0].runs.some(r=>r.attributes[mark]===true));assert.equal(s.commands.filter(c=>c.origin.startsWith('typing-shortcut:')).length,1);assert.equal(s.history.undoGroups,1);
 await page.keyboard.press('Backspace');s=await state(page,fact);assert.equal(s.text[0],prefix+last);assert.deepEqual(s.nodes[0].blockAttributes,['paragraph']);assert.ok(s.nodes[0].runs.every(r=>!r.attributes[mark]));assert.equal(s.selection.anchor.offset,(prefix+last).length);
 await page.keyboard.press(`${mod}+z`);s=await state(page,fact);assert.equal(s.text[0],prefix);
},prefix));
for(const source of ['\\*escaped*','foo_bar_baz','**unfinished','*unmatched','`unmatched','[bad](javascript:alert(1))'])test(`PAR-02 ${source} remains literal`,()=>probe(`PAR-02-literal-${Buffer.from(source).toString("hex")}`,async(page,fact)=>{
 const result=await codec(page,source);fact.grammar=result;if(source.startsWith('[bad]')){assert.equal(result.p.source,source);assert.ok(result.p.diagnostics.length);}else assert.equal(text(result.p.blocks),source.replace('\\*','*'));assert.ok(result.p.blocks.every(b=>b.runs.every(r=>!r.marks.some(m=>m.mark==='bold'||m.mark==='italic'||m.mark==='link'))));
 await page.keyboard.type('x');const s=await state(page,fact);assert.equal(s.commands.filter(c=>c.origin.startsWith('typing-shortcut:')).length,0);
},source));
for(const [prefix,type,container,start]of [ ['#','heading'],['######','heading'],['-','paragraph','unordered'],['+','paragraph','unordered'],['*','paragraph','unordered'],['>','paragraph','quote'],['0.','paragraph','ordered',0],['3)','paragraph','ordered',3],['- [x]','paragraph','checklist'] ])test(`PAR-03 ${prefix} space trigger is one reversible semantic edit`,()=>probe(`PAR-03-block-${prefix.replaceAll(' ','')}`,async(page,fact)=>{
 await page.keyboard.press('Space');let s=await state(page,fact),block=s.nodes.find(n=>n.kind==='block');assert.equal(block.blockAttributes[0],type);assert.equal(s.text[0],'');if(container){const c=s.nodes.find(n=>n.editor?.containerAttributes?.[0]===container);assert.ok(c);if(start!==undefined)assert.equal(c.editor.containerAttributes[1],start);}
 assert.equal(s.commands.length,1);assert.equal(s.journal.length,1);assert.equal(s.history.undoGroups,1);
 await page.keyboard.press('Backspace');s=await state(page,fact);assert.equal(s.text[0],prefix+' ');assert.deepEqual(s.nodes[0].blockAttributes,['paragraph']);assert.equal(s.selection.anchor.offset,prefix.length+1);
 await page.keyboard.press(`${mod}+z`);s=await state(page,fact);assert.equal(s.text[0],prefix);
},prefix));
for(const prefix of ['```js','````rust','~~~text'])test(`PAR-03 ${prefix} Enter fence trigger and full reversal`,()=>probe(`PAR-03-fence-${prefix.length}`,async(page,fact)=>{
 await page.keyboard.press('Enter');let s=await state(page,fact);assert.equal(s.nodes[0].blockAttributes[0],'code');assert.equal(s.commands.length,1);assert.equal(s.history.undoGroups,1);
 await page.keyboard.press('Backspace');s=await state(page,fact);assert.equal(s.text[0],prefix+'\n');assert.deepEqual(s.nodes[0].blockAttributes,['paragraph']);
},prefix));
for(const source of ['Hi. there','Ex) aside','#######','1234567890.','foo_bar','**unfinished'])test(`PAR-03 incomplete/non-rule ${source} does not convert`,()=>probe(`PAR-03-nonrule-${Buffer.from(source).toString("hex")}`,async(page,fact)=>{await page.keyboard.press('Space');const s=await state(page,fact);assert.equal(s.text[0],source+' ');assert.equal(s.commands.filter(c=>c.origin.startsWith('typing-shortcut:')).length,0);},source));
for(const mode of ['ambiguous','replacement','dictation','paste','remote','composition','readonly','code','disabled','escape'])test(`PAR-04 ${mode} preserves literal rule source`,()=>probe(`PAR-04-${mode}`,async(page,fact)=>{
 if(mode==='remote')await page.evaluate(()=>window.inputFixture.remote(1,' '));
 else if(mode==='paste')await page.evaluate(()=>window.inputFixture.paste(' '));
 else if(mode==='composition')await page.evaluate(()=>{const f=window.inputFixture;f.event('compositionstart',{data:''});f.root.querySelector('[data-node-id]').textContent='# ';f.event('compositionend',{data:' '});});
 else if(['ambiguous','replacement','dictation'].includes(mode))await page.evaluate(mode=>{const f=window.inputFixture;if(mode==='replacement'){const s=document.getSelection(),range=new StaticRange({startContainer:s.anchorNode,startOffset:s.anchorOffset,endContainer:s.focusNode,endOffset:s.focusOffset});const event=new InputEvent('beforeinput',{bubbles:true,cancelable:true,inputType:'insertReplacementText',data:' '});Object.defineProperty(event,'getTargetRanges',{value:()=>[range]});f.root.dispatchEvent(event);}else f.event('beforeinput',{inputType:'insertText',data:' ',cancelable:true});},mode);
 else {if(mode==='escape')await page.keyboard.press('Escape');await page.keyboard.press('Space');}
 const s=await state(page,fact);assert.equal(s.commands.filter(c=>c.origin.startsWith('typing-shortcut:')).length,0);assert.equal(s.text[0],mode==='readonly'?'#':'# ');assert.equal(s.nodes[0].blockAttributes[0],mode==='code'?'code':'paragraph');
}, {text:'#',readOnly:mode==='readonly',code:mode==='code',typingShortcuts:mode!=='disabled'}));
test('PAR-04 rules and paste parsing are independent switches',()=>probe('PAR-04-independent',async(page,fact)=>{
 await page.keyboard.press('Space');let s=await state(page,fact);assert.equal(s.text[0],'# ');
 await page.evaluate(()=>window.inputFixture.paste('**bold**'));s=await state(page,fact);assert.ok(s.nodes[0].runs.some(r=>r.attributes.bold));
},{text:'#',typingShortcuts:false,pastePolicy:'markdown'}));
for(const [source,href]of [['https://example.com/a(b)).','https://example.com/a(b)'],['www.example.com。','http://www.example.com/'],['foo+bar@example.com，','mailto:foo+bar@example.com'],['javascript:alert(1)',null],['not@invalid',null]])test(`PAR-05 boundary ${source}`,()=>probe(`PAR-05-link-${Buffer.from(source).toString("hex")}`,async(page,fact)=>{
 await page.keyboard.press('Space');const s=await state(page,fact);const links=s.nodes[0].runs.filter(r=>r.attributes.link);if(href)assert.ok(links.some(r=>r.attributes.link===href));else assert.equal(links.length,0);assert.equal(s.text[0],source+' ');
},source));
test('PAR-05 literal enablement and Escape retain full source',()=>probe('PAR-05-literal',async(page,fact)=>{await page.keyboard.press('Space');const s=await state(page,fact);assert.equal(s.text[0],'https://example.com。 ');assert.ok(s.nodes[0].runs.every(r=>!r.attributes.link));},{text:'https://example.com。',typingShortcuts:false}));
test('PAR-06 literal multiline paste into inline code keeps all characters',()=>probe('PAR-06-inline-paste',async(page,fact)=>{
 await page.keyboard.type('`');await page.evaluate(()=>{const f=window.inputFixture;f.select(f.engine.read().visible[0].id,1);f.paste('a\nb');});const s=await state(page,fact);assert.equal(s.text[0],'xa\nby');assert.ok(s.commands.some(c=>c.origin.startsWith('clipboard')));assert.ok(s.nodes[0].runs.some(r=>r.text.includes('\n')));
},'`xy'));
test('PAR-06 unrepresentable alternate formatting retains recovery and diagnostic',()=>probe('PAR-06-unsupported',async(page,fact)=>{
 const result=await page.evaluate(()=>{const c=window.inputFixture.codec,source='<u>e\u0301 😀</u>',p=c.importMarkdown(source),e=c.exportMarkdown([{attributes:{type:'paragraph'},runs:[{text:source,marks:[{mark:'underline'}]}]}]);return {source,p,e};});fact.grammar=result;assert.equal(result.p.source,result.source);assert.ok(result.p.diagnostics.length);assert.equal(text(result.p.blocks),result.source);assert.ok(result.e.diagnostics.length);assert.equal(text(result.e.recovery),result.source);assert.equal((await state(page,fact)).journal.length,0);
}));
test('PAR-07 code fence export exceeds embedded backticks and reparses exactly',()=>probe('PAR-07-fence-export',async(page,fact)=>{
 const source='before\n```embedded\n````\nafter\n',r=await page.evaluate(source=>{const c=window.inputFixture.codec,e=c.exportMarkdown([{attributes:{type:'code',language:'js'},runs:[{text:source,marks:[]}]}]);return {e,p:c.importMarkdown(e.markdown)};},source);fact.grammar=r;assert.deepEqual(r.e.diagnostics,[]);assert.equal(r.p.blocks.length,1);assert.equal(text(r.p.blocks),source);assert.equal(r.p.blocks[0].attributes.type,'code');assert.match(r.e.markdown,/^`{5,}js/);
}));
test('PAR-08 only valid ordered markers form lists and preserve zero start',()=>probe('PAR-08-zero',async(page,fact)=>{
 for(const source of ['Hi. there','Ex) aside']){const r=await codec(page,source);fact.snapshots.push(r);assert.equal(text(r.p.blocks),source);assert.ok(r.p.blocks.every(b=>!b.containers?.length));}
 const r=await codec(page,'0. zero\n1. one\n');fact.grammar=r;assert.equal(r.p.blocks[0].containers[0].style.start,0);assert.equal(text(r.p.blocks),'zero\none');assert.deepEqual(r.again.blocks,r.p.blocks);
}));

test('PAR-03 full direct typing reversal retains source then undoes preceding typing',()=>probe('PAR-03-full-typing-history',async(page,fact)=>{
 await page.keyboard.type('#');await page.keyboard.press('Space');let s=await state(page,fact);assert.equal(s.nodes[0].blockAttributes[0],'heading');assert.equal(s.history.undoGroups,2);
 await page.keyboard.press('Backspace');s=await state(page,fact);assert.equal(s.text[0],'# ');assert.deepEqual(s.nodes[0].blockAttributes,['paragraph']);
 await page.keyboard.press(`${mod}+z`);s=await state(page,fact);assert.equal(s.text[0],'#');
 await page.keyboard.press(`${mod}+z`);s=await state(page,fact);assert.equal(s.text[0],'');
 const restored=await page.evaluate(()=>window.inputFixture.reopen());assert.equal(restored.find(n=>n.kind==='block').runs.map(r=>r.text).join(''),'');
}));
test('PAR-03 pointer-moved caret cannot reverse a previous conversion',()=>probe('PAR-03-moved-target',async(page,fact)=>{
 await page.keyboard.type('*');await page.evaluate(()=>{const f=window.inputFixture;f.select(f.engine.read().visible[0].id,2);});await page.keyboard.press('Backspace');const s=await state(page,fact);assert.equal(s.text[0],'bld');assert.ok(s.nodes[0].runs.some(r=>r.attributes.bold));assert.equal(s.commands.filter(c=>c.origin==='typing-rule:restore-source').length,0);
},'**bold*'));
test('PAR-04 read-only after conversion prevents reversal and mutation',()=>probe('PAR-04-readonly-reversal',async(page,fact)=>{
 await page.keyboard.press('Space');const before=await state(page,fact);await page.evaluate(()=>window.inputFixture.surface.setReadOnly(true));await page.keyboard.press('Backspace');const after=await state(page,fact);assert.deepEqual(after.nodes,before.nodes);assert.deepEqual(after.history,before.history);assert.deepEqual(after.journal,before.journal);
},'#'));
test('PAR-04 Escape cancels reversal and suppresses the next delimiter conversion',()=>probe('PAR-04-escape-inline',async(page,fact)=>{
 await page.keyboard.press('Escape');await page.keyboard.type('*');const s=await state(page,fact);assert.equal(s.text[0],'**bold**');assert.ok(s.nodes[0].runs.every(r=>!r.attributes.bold));
},'**bold*'));
test('PAR-04 an interrupted direct key cannot claim later ambiguous input',()=>probe('PAR-04-key-lifetime',async(page,fact)=>{
 await page.keyboard.press('Shift');await page.evaluate(()=>window.inputFixture.event('beforeinput',{inputType:'insertText',data:' ',cancelable:true}));const s=await state(page,fact);assert.equal(s.text[0],'# ');assert.deepEqual(s.nodes[0].blockAttributes,['paragraph']);
},'#'));

for(const interruption of ['history-clear','Escape'])test(`PAR-03 ${interruption} cancels the recorded reversal`,()=>probe(`PAR-03-interrupted-${interruption}`,async(page,fact)=>{
 await page.keyboard.type('*');if(interruption==='history-clear')await page.evaluate(()=>window.inputFixture.engine.history({type:'clear'}));else await page.keyboard.press('Escape');await page.keyboard.press('Backspace');const s=await state(page,fact);assert.equal(s.text[0],'bol');assert.ok(s.nodes[0].runs.some(r=>r.attributes.bold));assert.equal(s.commands.filter(c=>c.origin==='typing-rule:restore-source').length,0);
},'**bold*'));
