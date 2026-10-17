import assert from 'node:assert/strict';
import {test} from 'node:test';
import {join} from 'node:path';
import {browserHarness} from '../browser-harness.ts';
const {probe:rawProbe,facts}=browserHarness('interaction-accessibility','fixtures/browser-history',{
 markdown:true,assertSourcesUnchanged:true,testFile:'tests/browser/interactions/accessibility.spec.ts',sourcePaths:[
 'fixtures/browser-history/session.mjs','fixtures/browser-history/accessibility.mjs','fixtures/browser-history/index.html',
 'packages/web/src/dom/presentation.ts','packages/web/src/surface.ts','packages/web/src/dom/render.ts',
 'packages/web/src/input/keyboard.ts','packages/web/src/commands/formatting.ts','packages/web/src/modules/slash.ts',
 'packages/web/dist/dom/presentation.js','packages/web/dist/surface.js','packages/core/dist/wasm/editac_wasm_bg.wasm',
 'packages/markdown/dist/wasm/editac_markdown_wasm_bg.wasm','scripts/test-interactions.mjs']});
facts.binding={gate:'INT-1.13',ids:['A11-01','A11-03','A11-06'],provenance:'Real packed Session/WASM/IndexedDB, production surface/keyboard/formatting/slash and host toolbar. Optional assistance never loaded. Browser keyboard and mechanical presentation only; no screen reader/native dictation qualification.',profile:{os:process.platform,arch:process.arch,locale:'en-US',layout:'1280x720, 320px reflow, CSS 200% text/zoom; document Escape-then-Tab; WebKit Option+Tab all-controls traversal'}};
async function tab(page){
 if(await page.evaluate(()=>document.activeElement===window.inputFixture.root)){await page.keyboard.press('Escape');await page.keyboard.press('Tab');}
 else await page.keyboard.press(facts.engine==='webkit'?'Alt+Tab':'Tab');
}
const mod=process.platform==='darwin'?'Meta':'Control';
function probe(name,action,text='alpha'){return rawProbe(name,async(page,fact)=>{fact.caseIds=[name.slice(0,6)];await action(page,fact);},{text,accessibility:true});}
async function state(page,fact){const s=await page.evaluate(()=>window.inputFixture.state());fact.snapshots.push(s);assert.deepEqual(s.errors,[]);return s;}
function unchanged(a,b){for(const key of ['nodes','history','commands','journal','patches','revision'])assert.deepEqual(b[key],a[key],key);}
async function focused(page,selector){assert.equal(await page.locator(selector).evaluate(el=>el===document.activeElement),true,`focus ${selector}; actual ${await page.evaluate(()=>document.activeElement?.outerHTML?.slice(0,300))}`);}
async function outline(page,selector){const s=await page.locator(selector).evaluate(el=>{const c=getComputedStyle(el);return{style:c.outlineStyle,width:parseFloat(c.outlineWidth),color:c.outlineColor,focus:el.matches(':focus-visible')};});assert.equal(s.focus,true);assert.equal(s.style,'solid');assert.ok(s.width>=2);return s;}
async function screenshot(page,fact,name){const path=join(facts.server.log,`${name}.png`);await page.screenshot({path,fullPage:true});fact.screenshot=path;fact.snapshots.push(await page.locator('body').ariaSnapshot());}

test('A11-01 keyboard document toolbar menu restoration and next control have no trap',()=>probe('A11-01-route',async(page,fact)=>{
 const before=await state(page,fact);await tab(page);await focused(page,'button[data-mark="bold"]');fact.focus=await outline(page,'button[data-mark="bold"]');
 for(let i=0;i<3;i++)await tab(page);await focused(page,'button[aria-haspopup="menu"]');await page.keyboard.press('Enter');
 const menu=page.getByRole('menu',{name:'Slash commands'});assert.equal(await menu.isVisible(),true);await focused(page,'[role="menuitem"][data-command="alpha"]');await outline(page,'[role="menuitem"][data-command="alpha"]');
 await page.keyboard.press('ArrowDown');await focused(page,'[data-command="slow"]');assert.equal(await page.locator('button[aria-haspopup="menu"]').getAttribute('aria-expanded'),'true');
 const status=await page.locator('[role="status"][aria-live="polite"]').textContent();assert.match(status,/2 slash commands.*Slow/);assert.ok(status.length<200);
 await screenshot(page,fact,'keyboard-menu');await page.keyboard.press('Escape');await focused(page,'#projection');assert.equal(await menu.isVisible(),false);
 assert.equal(await page.locator('button[aria-haspopup="menu"]').getAttribute('aria-expanded'),'false');await page.keyboard.press('Escape');await tab(page);await focused(page,'button[data-mark="bold"]');
 for(let i=0;i<4;i++)await tab(page);await focused(page,'#after-editor');unchanged(before,await state(page,fact));
},'/'));
for(const direction of ['forward','backward'])test(`A11-01 mixed pressed toolbar state and ${direction} target survive keyboard focus`,()=>probe(`A11-01-mixed-${direction}`,async(page,fact)=>{
 await page.evaluate(()=>{const f=window.inputFixture,e=f.engine;e.commit(e.prepare({kind:'editor',origin:'a11-fixture-mark',commands:[{type:'markAt',owner:f.ids[0],from:0,to:2,mark:'bold',action:'apply'}]}));e.history({type:'clear'});f.select(f.ids[0],0,5);});
 if(direction==='backward')await page.evaluate(()=>{const f=window.inputFixture;f.select(f.ids[0],5,0);});
 const before=await state(page,fact);await tab(page);const button=page.getByRole('button',{name:'Bold',exact:true});assert.equal(await button.getAttribute('aria-pressed'),'mixed');assert.equal(await button.isEnabled(),true);
 await page.keyboard.press('Space');await focused(page,'#projection');const after=await state(page,fact);assert.deepEqual(after.selection,before.selection);assert.ok(after.nodes[0].runs.every(r=>r.attributes.bold===true));assert.equal(after.history.undoGroups,1);assert.equal(after.journal.length-before.journal.length,1);assert.equal(after.commands.length-before.commands.length,1);
 await tab(page);assert.equal(await button.getAttribute('aria-pressed'),'true');await page.keyboard.press('Escape');await page.keyboard.press(`${mod}+z`);assert.deepEqual((await state(page,fact)).nodes,before.nodes);
}));
test('A11-01 read-only keeps named textbox focusable and disables controls',()=>probe('A11-01-readonly',async(page,fact)=>{
 await page.evaluate(()=>window.inputFixture.surface.setReadOnly(true));const before=await state(page,fact);const root=page.getByRole('textbox',{name:'Protocol document'});assert.equal(await root.getAttribute('aria-multiline'),'true');assert.equal(await root.getAttribute('aria-readonly'),'true');
 assert.equal(await page.getByRole('button',{name:'Bold',exact:true}).isDisabled(),true);assert.equal(await page.getByRole('button',{name:'Slash commands',exact:true}).isDisabled(),true);await root.focus();await page.keyboard.press(`${mod}+b`);await tab(page);await focused(page,'#after-editor');unchanged(before,await state(page,fact));
}));
for(const exit of ['Escape','Cancel link'])test(`A11-01 named link dialog ${exit} restores backward selection without mutation`,()=>probe(`A11-01-link-${exit.replaceAll(' ','-')}`,async(page,fact)=>{
 await page.evaluate(()=>{const f=window.inputFixture;f.select(f.ids[0],5,1);});const before=await state(page,fact);await page.keyboard.press(`${mod}+k`);assert.equal(await page.getByRole('dialog',{name:'Edit link'}).isVisible(),true);await focused(page,'input[type="url"]');assert.equal(await page.getByRole('textbox',{name:'Link URL'}).count(),1);await outline(page,'input[type="url"]');
 if(exit==='Escape')await page.keyboard.press('Escape');else{await tab(page);await tab(page);await focused(page,'button:has-text("Cancel link")');await page.keyboard.press('Space');}
 await focused(page,'#projection');const after=await state(page,fact);unchanged(before,after);assert.deepEqual(after.selection,before.selection);
}));
test('A11-01 invalid link has bounded atomic status and retains target',()=>probe('A11-01-error',async(page,fact)=>{
 const before=await state(page,fact);await page.keyboard.press(`${mod}+k`);await page.getByRole('textbox',{name:'Link URL'}).fill('javascript:alert(1)');await page.evaluate(()=>document.querySelector('input[type="url"]').type='text');await tab(page);await page.keyboard.press('Space');
 const status=page.getByRole('dialog',{name:'Edit link'}).getByRole('status');assert.ok((await status.textContent()).length>0);assert.ok((await status.textContent()).length<200);assert.equal(await status.getAttribute('aria-atomic'),'true');unchanged(before,await state(page,fact));await page.keyboard.press('Escape');await focused(page,'#projection');
}));
for(const profile of ['reflow','text-200','zoom-200','forced-colors','reduced-motion'])test(`A11-03 ${profile} retains text focus essential state and bounded layout`,()=>probe(`A11-03-${profile}`,async(page,fact)=>{
 if(profile==='reflow')await page.setViewportSize({width:320,height:720});if(profile==='text-200')await page.evaluate(()=>document.documentElement.style.fontSize='200%');if(profile==='zoom-200')await page.evaluate(()=>document.documentElement.style.zoom='2');if(profile==='forced-colors')await page.emulateMedia({forcedColors:'active'});if(profile==='reduced-motion')await page.emulateMedia({reducedMotion:'reduce'});
 const before=await state(page,fact);await tab(page);fact.outline=await outline(page,'button[data-mark="bold"]');const layout=await page.evaluate(()=>({scroll:document.documentElement.scrollWidth,client:document.documentElement.clientWidth,wrap:getComputedStyle(document.querySelector('#projection')).overflowWrap,forced:matchMedia('(forced-colors:active)').matches,reduced:matchMedia('(prefers-reduced-motion:reduce)').matches,text:document.querySelector('#projection').textContent}));fact.layout=layout;
 assert.ok(layout.scroll<=layout.client+1,JSON.stringify(layout));assert.equal(layout.wrap,'anywhere');assert.match(layout.text,/verylong/);if(profile==='forced-colors')assert.equal(layout.forced,true);if(profile==='reduced-motion')assert.equal(layout.reduced,true);await screenshot(page,fact,profile);unchanged(before,await state(page,fact));
},'verylong'.repeat(70)));
test('A11-03 code layout scrolls locally without widening the document',()=>rawProbe('A11-03-code',async(page,fact)=>{
 await page.setViewportSize({width:320,height:720});const before=await state(page,fact);const layout=await page.locator('pre').evaluate(el=>({space:getComputedStyle(el).whiteSpace,overflow:getComputedStyle(el).overflowX,width:el.clientWidth,scroll:el.scrollWidth,doc:document.documentElement.scrollWidth,view:document.documentElement.clientWidth}));fact.layout=layout;assert.equal(layout.space,'pre');assert.equal(layout.overflow,'auto');assert.ok(layout.scroll>layout.width);assert.ok(layout.doc<=layout.view+1);await screenshot(page,fact,'code-reflow');unchanged(before,await state(page,fact));
},{text:'literal '.repeat(100),code:true,accessibility:true}));
test('A11-06 baseline editing replacement undo and focus work without assistance',()=>probe('A11-06-baseline',async(page,fact)=>{
 const description=await page.locator('#projection').getAttribute('aria-describedby');assert.match(description,/editac-keyboard-help/);assert.match(await page.locator(`[id="${description}"]`).textContent(),/Escape then Tab/);
 await page.keyboard.type('!');await page.keyboard.press(`${mod}+b`);await page.keyboard.type('B');await page.keyboard.press(`${mod}+z`);assert.equal((await state(page,fact)).text[0],'alpha!');
 await page.evaluate(()=>{const f=window.inputFixture;f.select(f.ids[0],0,5);const r=document.getSelection().getRangeAt(0),event=new InputEvent('beforeinput',{inputType:'insertReplacementText',data:'corrected',bubbles:true,cancelable:true});Object.defineProperty(event,'getTargetRanges',{value:()=>[new StaticRange({startContainer:r.startContainer,startOffset:r.startOffset,endContainer:r.endContainer,endOffset:r.endOffset})]});f.root.dispatchEvent(event);});const replaced=await state(page,fact);assert.match(replaced.text[0],/^corrected/);assert.ok(replaced.history.undoGroups>0);assert.equal(fact.requests.some(url=>/assistive|assistance/i.test(url)),false);fact.optionalAssistance='not registered or fetched';fact.nativeDictation='unqualified; deterministic replacement only';
}));
test('A11-06 two view teardown shares then removes baseline presentation',()=>probe('A11-06-teardown',async(page,fact)=>{
 await page.evaluate(()=>window.inputFixture.second());assert.equal(await page.locator('style[data-editac-presentation]').count(),1);await page.evaluate(()=>window.inputFixture.disposeSurface());assert.equal(await page.locator('style[data-editac-presentation]').count(),1);assert.equal(await page.locator('#projection').getAttribute('data-editac-surface'),null);await page.evaluate(()=>window.inputFixture.destroy());assert.equal(await page.locator('style[data-editac-presentation]').count(),0);assert.equal(await page.locator('[data-editac-ui]').count(),0);fact.teardown={sharedStyleRemoved:true,controlsRemoved:true};
}));

test('A11-01 status announcements are bounded and repeated active results are quiet',()=>rawProbe('A11-01-bounded-status',async(page,fact)=>{
 await page.keyboard.press('Escape');await page.keyboard.press('Tab');for(let i=0;i<3;i++)await tab(page);await page.keyboard.press('Enter');
 const status=page.locator('[role="status"][aria-live="polite"]');assert.equal(await status.getAttribute('aria-atomic'),'true');const text=await status.textContent();assert.ok(Array.from(text).length<=240);assert.ok(text.includes('📝'.repeat(64)));assert.ok(!/[\uD800-\uDBFF]$/.test(text));
 await page.evaluate(()=>{window.announcements=0;window.statusObserver=new MutationObserver(records=>window.announcements+=records.length);window.statusObserver.observe(document.querySelector('[role="status"][aria-live="polite"]'),{childList:true});});
 await page.keyboard.press('Home');await page.keyboard.press('Home');assert.equal(await page.evaluate(()=>window.announcements),0);await page.evaluate(()=>window.statusObserver.disconnect());fact.announcement={codePoints:Array.from(text).length,repeatedMutations:0};
},{text:'/',accessibility:true,slashLabel:'📝'.repeat(64)}));
