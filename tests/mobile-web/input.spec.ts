import assert from 'node:assert/strict';
import { test } from 'node:test';
import * as Y from 'yjs';
import { browserHarness } from '../browser/browser-harness.ts';
import { browserInputSources } from '../editing/browser-driver.ts';
import { installResourceCounters } from './resources.mjs';
const { probe, facts } = browserHarness('mobile-harness', 'fixtures/browser-mobile-web', {
 autoMount:false, markdown:true, testFile:'tests/mobile-web/input.spec.ts', assertSourcesUnchanged:true,
 contextOptions:{viewport:{width:390,height:740},hasTouch:true,isMobile:true},
 beforeNavigate:async page=>page.addInitScript(installResourceCounters),
 sourcePaths:[...browserInputSources,...['editor','surface','modules/slash','input/composition','input/reconcile','input/keyboard'].flatMap(n=>[`packages/web/src/${n}.ts`,`packages/web/dist/${n}.js`]),
 'fixtures/browser-mobile-web/session.mjs','fixtures/browser-mobile-web/index.html','tests/mobile-web/input.spec.ts','tests/mobile-web/resources.mjs','tests/mobile-web/catalog.mjs','tests/mobile-web/case-index.json','scripts/test-mobile-web.mjs',
 '../architecture/specs/mobile-web.md','../architecture/specs/editor-interactions.md','../architecture/tests/mobile-web-cases.md'],
});
facts.binding={gate:'MWF-1.3',ids:Array.from({length:8},(_,i)=>`MBI-0${i+1}`),
 provenance:'prepared platform event/DOM traces plus trusted desktop keyboard controls; production packed BrowserEditor/recovered Session/Rust-WASM/IndexedDB; no observed OS IME/voice/handwriting, device/API availability or performance claim'};
async function mount(page,options:any={text:'alpha'},a=0,b=a){await page.waitForFunction(()=>!!(window as any).inputFixture);const baseline=await page.evaluate(()=>(window as any).mobileResources());await page.evaluate(async({options,a,b})=>{const f=(window as any).inputFixture;await f.mount(options);f.select(f.ids[0],a,b);await f.settle();},{options,a,b});return baseline;}
async function observe(page,fact){const s=await page.evaluate(()=>(window as any).inputFixture.state());fact.snapshots.push(s);assert.deepEqual(s.errors,[]);assert.equal(s.storage,'localCommitted');return s;}
const texts=s=>s.nodes.filter(n=>n.kind==='block').map(n=>n.runs.map(r=>r.text).join(''));
function content(s,expected,caret?:number){assert.deepEqual(texts(s),typeof expected==='string'?[expected]:expected);assert.equal(s.dom,texts(s).join(''));if(caret!==undefined){assert.equal(s.selection.anchor?.offset,caret);assert.equal(s.selection.focus?.offset,caret);assert.equal(s.selection.focus?.node,s.nodes[0].id);}}
function effects(s,local,remote=0){const commits=s.patches.filter(p=>p.update),l=commits.filter(p=>p.origin.startsWith('editac:local:')),r=commits.filter(p=>!p.origin.startsWith('editac:local:'));assert.equal(l.length,local,'local commit count');assert.equal(r.length,remote,'remote commit count');assert.equal(s.journal.length,local+remote,'durable journal entries');assert.equal(s.history.undoGroups,local,'one history group per intent');assert.equal(new Set(l.map(p=>p.origin)).size,local,'unique intent origins');}
async function clean(page,baseline,fact){await page.evaluate(()=>(window as any).inputFixture.destroy());await page.evaluate(()=>new Promise<void>(r=>requestAnimationFrame(()=>r())));const after=await page.evaluate(()=>(window as any).mobileResources());fact.resources={baseline,after};assert.deepEqual(after,baseline);}
async function event(page,type,options:any={},range?:any){return page.evaluate(({type,options,range})=>(window as any).inputFixture.deliver(type,options,range),{type,options,range});}
async function undo(page){return page.evaluate(async()=>{const f=(window as any).inputFixture,t=f.surface.captureHistory();try{const result=t?.execute('undo');await f.settle();return result;}finally{t?.dispose();}});}
for(const key of [null,'Unidentified'])test(`MBI-01 no physical key requirement (${key}) and distinct repeated intent`,()=>probe('MBI-01-'+key,async(page,fact)=>{
 const baseline=await mount(page,{text:'a'},1);fact.trace=[];
 for(let i=0;i<2;i++){if(key)fact.trace.push(await event(page,'keydown',{key}));fact.trace.push(await event(page,'beforeinput',{inputType:'insertText',data:'😀',cancelable:true}));await event(page,'input',{inputType:'insertText',data:'😀'});if(key)await event(page,'keyup',{key});}
 const s=await observe(page,fact);content(s,'a😀😀',5);effects(s,2);assert.ok(fact.trace.filter(e=>e.type==='beforeinput').every(e=>e.prevented));await clean(page,baseline,fact);
}));
for(const delivery of ['noncancelable','missing-beforeinput','observer-first'])test(`MBI-01 native fallback ${delivery} and duplicate echoes commit once`,()=>probe('MBI-01-'+delivery,async(page,fact)=>{
 const baseline=await mount(page,{text:'alpha'},5);fact.trace=await page.evaluate(async delivery=>{const f=(window as any).inputFixture,t=[];if(delivery==='noncancelable')t.push(f.deliver('beforeinput',{inputType:'insertText',data:'😀',cancelable:false}));f.mutate('alpha😀');if(delivery==='observer-first')await f.settle();t.push(f.deliver('input',{inputType:'insertText',data:'😀'}));await f.settle();f.deliver('input',{inputType:'insertText',data:'😀'});await f.settle();return t;},delivery);
 const s=await observe(page,fact);content(s,'alpha😀',7);effects(s,1);await clean(page,baseline,fact);
}));
for(const [name,text,from,to,replacement]of [
 ['prediction','teh cat',0,3,'the'],['punctuation','hello  ',5,7,'. '],['dictation','a wrong phrase z',2,14,'correct words'],['swipe','a old z',2,5,'new word'],
 ['emoji','a😀z',1,3,'👩🏽‍💻'],['indic','aकz',1,2,'क्षि'],['rtl','aאבz',1,3,'שָׁלוֹם'],['combining','aéz',1,3,'é'],
]as const)test(`MBI-02/04 ${name}: actual reported UTF-16 replacement over retained marks`,()=>probe('MBI-02-04-'+name,async(page,fact)=>{
 const baseline=await mount(page,{text,marks:[{from:0,to:text.length,type:'bold'}]},text.length,0);
 fact.trace=[await event(page,'beforeinput',{inputType:'insertReplacementText',data:replacement,cancelable:true},{from,to})];await event(page,'input',{inputType:'insertReplacementText',data:replacement});
 const s=await observe(page,fact);content(s,text.slice(0,from)+replacement+text.slice(to),from+replacement.length);effects(s,1);assert.ok(s.nodes[0].runs.every(r=>r.attributes.bold===true));assert.equal(fact.trace[0].prevented,true);
 assert.equal((await undo(page))?.disposition,'committed');const restored=await observe(page,fact);content(restored,text);assert.ok(restored.nodes[0].runs.every(r=>r.attributes.bold===true));await clean(page,baseline,fact);
}));
test('MBI-02 correction without target range uses actual native mutation rather than the visible selection',()=>probe('MBI-02-native-target',async(page,fact)=>{
 const baseline=await mount(page,{text:'teh cat',marks:[{from:0,to:7,type:'italic'}]},7);
 assert.equal((await event(page,'beforeinput',{inputType:'insertReplacementText',data:'the',cancelable:true})).prevented,false);
 await page.evaluate(()=>{const f=(window as any).inputFixture;f.mutate('the cat',0,3);f.deliver('input',{inputType:'insertReplacementText',data:'the'});});const s=await observe(page,fact);content(s,'the cat',3);effects(s,1);assert.ok(s.nodes[0].runs.every(r=>r.attributes.italic===true));await clean(page,baseline,fact);
}));
for(const type of ['deleteContentBackward','deleteContentForward','deleteWordBackward','deleteSoftLineBackward'])test(`MBI-05 ${type}: reported emoji range overrides expanded visible selection`,()=>probe('MBI-05-'+type,async(page,fact)=>{
 const baseline=await mount(page,{text:'a😀bc'},5,4);fact.trace=[await event(page,'beforeinput',{inputType:type,cancelable:true},{from:1,to:3})];const s=await observe(page,fact);content(s,'abc',1);effects(s,1);assert.equal(fact.trace[0].prevented,true);await clean(page,baseline,fact);
}));
test('MBI-05 native repeated deletion preserves graphemes, adjacent blocks and empty content',()=>probe('MBI-05-repeat',async(page,fact)=>{
 const baseline=await mount(page,{nodes:[{text:'a👩🏽‍💻'},{text:'untouched'}]},8);
 for(const text of ['a',''])await page.evaluate(async text=>{const f=(window as any).inputFixture;f.deliver('beforeinput',{inputType:'deleteWordBackward',cancelable:false});f.mutate(text);f.deliver('input',{inputType:'deleteWordBackward'});await f.settle();f.deliver('input',{inputType:'deleteWordBackward'});},text);
 const s=await observe(page,fact);content(s,['','untouched'],0);effects(s,2);await event(page,'beforeinput',{inputType:'deleteWordBackward',cancelable:false});await event(page,'input',{inputType:'deleteWordBackward'});const empty=await observe(page,fact);content(empty,['','untouched'],0);effects(empty,2);await clean(page,baseline,fact);
}));
test('MBI-05 repeated trusted Backspace joins only intended adjacent block and stops at empty editor',()=>probe('MBI-05-block-boundaries',async(page,fact)=>{
 const baseline=await mount(page,{nodes:[{text:'😀'},{text:'b'}]},0);await page.evaluate(()=>{const f=(window as any).inputFixture;f.select(f.ids[1],0);});await page.keyboard.press('Backspace');let s=await observe(page,fact);content(s,'😀b',2);effects(s,1);await page.keyboard.press('Backspace');s=await observe(page,fact);content(s,'b',0);effects(s,2);await page.keyboard.press('Delete');s=await observe(page,fact);content(s,'',0);effects(s,3);await page.keyboard.press('Backspace');s=await observe(page,fact);content(s,'',0);effects(s,3);await clean(page,baseline,fact);
}));
for(const order of ['keydown-first','end-first','missing-keyup'])test(`MBI-03 composition partial deletion / ${order} final Enter has one boundary`,()=>probe('MBI-03-'+order,async(page,fact)=>{
 const baseline=await mount(page,{text:'a😀z',marks:[{from:0,to:4,type:'bold'}]},3,1);
 fact.intermediate=await page.evaluate(async()=>{const f=(window as any).inputFixture;f.deliver('compositionstart');f.mutate('a日本z',0,3);f.deliver('compositionupdate',{data:'日本'});f.mutate('a日z',0,2);f.deliver('beforeinput',{inputType:'deleteCompositionText',isComposing:true,cancelable:false});f.deliver('input',{inputType:'insertCompositionText',data:'日',isComposing:true});await f.settle();return f.state();});assert.deepEqual(texts(fact.intermediate),['a😀z']);assert.equal(fact.intermediate.dom,'a日z');effects(fact.intermediate,0);
 await page.evaluate(order=>{const f=(window as any).inputFixture;if(order==='keydown-first')f.deliver('keydown',{key:'Enter',isComposing:true});f.deliver('compositionend',{data:'日'});if(order==='end-first')f.deliver('keydown',{key:'Enter'});f.deliver('beforeinput',{inputType:'insertParagraph',cancelable:true});f.deliver('input',{inputType:'insertFromComposition',data:'日'});f.deliver('compositionend',{data:'日'});if(order!=='missing-keyup')f.deliver('keyup',{key:'Enter'});},order);
 const s=await observe(page,fact);content(s,'a日z',2);effects(s,1);assert.ok(s.nodes[0].runs.every(r=>r.attributes.bold===true));
 if(order==='missing-keyup')await page.evaluate(()=>new Promise<void>(resolve=>{const c=new MessageChannel();c.port1.onmessage=()=>{c.port1.close();c.port2.close();resolve();};c.port2.postMessage(null);}));
 await page.keyboard.press('Enter');const next=await observe(page,fact);content(next,['a日','z']);effects(next,2);await clean(page,baseline,fact);
}));
for(const mode of ['blur','pagehide','readonly','cancel'])test(`MBI-06 composition ${mode} rejects duplicate late finalization`,()=>probe('MBI-06-'+mode,async(page,fact)=>{
 const baseline=await mount(page,{text:'alpha'},5);
 await page.evaluate(mode=>{const f=(window as any).inputFixture;f.deliver('compositionstart');f.mutate('alpha語');f.deliver('compositionupdate',{data:'語'});if(mode==='blur')document.querySelector<HTMLButtonElement>('#host-control')!.focus();else if(mode==='pagehide')window.dispatchEvent(new PageTransitionEvent('pagehide',{persisted:true}));else if(mode==='readonly')f.surface.setReadOnly(true);else f.deliver('compositionend',{data:''});f.deliver('compositionend',{data:'語'});f.deliver('input',{inputType:'insertFromComposition',data:'語'});},mode);
 const s=await observe(page,fact),committed=['blur','pagehide'].includes(mode);content(s,committed?'alpha語':'alpha');effects(s,committed?1:0);if(mode==='blur')assert.equal(s.focus,false);if(mode==='readonly')assert.deepEqual(s.recovery,[{text:'語',reason:'composition-readonly'}]);await clean(page,baseline,fact);
}));
for(const conflict of [false,true])test(`MBI-06 remote ${conflict?'overlap':'outside'} uses stable composition target and explicit recovery`,()=>probe('MBI-06-remote-'+conflict,async(page,fact)=>{
 const baseline=await mount(page,{text:'alpha'},4,1);
 await page.evaluate(async conflict=>{const f=(window as any).inputFixture;f.deliver('compositionstart');f.mutate('a語a',0,2);await f.remote(0,conflict?2:0,'!');f.deliver('compositionend',{data:'語'});},conflict);
 const s=await observe(page,fact);content(s,conflict?'al!pha':'!a語a');effects(s,conflict?0:1,1);if(conflict)assert.deepEqual(s.recovery,[{text:'語',reason:'remote-overlap'}]);else assert.deepEqual(s.recovery,[]);await clean(page,baseline,fact);
}));
test('MBI-06 toolbar cannot mutate a composing target; disposal rejects late notifications',()=>probe('MBI-06-toolbar-dispose',async(page,fact)=>{
 const baseline=await mount(page,{text:'alpha'},5);const capture=await page.evaluate(()=>{const f=(window as any).inputFixture;f.deliver('compositionstart');f.mutate('alpha語');const target=f.surface.captureToolbar();try{return target?target.apply({bold:true}):{disposition:'rejected'};}finally{target?.dispose();}});assert.equal(capture.disposition,'rejected');const s=await observe(page,fact);effects(s,0);
 const report=await page.evaluate(async()=>{const f=(window as any).inputFixture;const report=await f.destroy();f.deliver('compositionend',{data:'語'});f.deliver('input',{inputType:'insertFromComposition',data:'語'});window.dispatchEvent(new PageTransitionEvent('pagehide'));return report;});assert.deepEqual(report.provisional,[{text:'語',reason:'composition-dispose'}]);assert.equal(report.unsaved,false);await clean(page,baseline,fact);
}));
test('MBI-07 mixed physical/virtual, dead key, AltGraph and RTL preserve literal characters',()=>probe('MBI-07-mixed',async(page,fact)=>{
 const baseline=await mount(page,{text:''});await page.keyboard.type('a');fact.trace=[];
 for(const [key,data]of [['Dead','é'],['Unidentified','אב'],['q','@']]){fact.trace.push(await event(page,'keydown',{key,...(key==='q'?{ctrlKey:true,altKey:true,modifierAltGraph:true}:{})}));await event(page,'beforeinput',{inputType:'insertText',data,cancelable:true});await event(page,'keyup',{key});}
 await event(page,'beforeinput',{inputType:'insertText',data:'語',cancelable:true});await page.keyboard.type('z');const s=await observe(page,fact);content(s,'aéאב@語z',7);effects(s,6);assert.ok(s.nodes[0].runs.every(r=>!r.attributes.bold&&!r.attributes.italic));await clean(page,baseline,fact);
}));
for(const route of ['typing','replacement'])test(`MBI-08 Markdown ${route} requires positively qualified direct typing`,()=>probe('MBI-08-markdown-'+route,async(page,fact)=>{
 const baseline=await mount(page,{text:'#',triggers:true},1);
 if(route==='typing')await page.keyboard.press('Space');else await event(page,'beforeinput',{inputType:'insertReplacementText',data:'# ',cancelable:true},{from:0,to:1});
 const s=await observe(page,fact);if(route==='typing'){assert.deepEqual(s.nodes[0].blockAttributes,['heading',1]);content(s,'');}else{assert.deepEqual(s.nodes[0].blockAttributes,['paragraph']);content(s,'# ',2);}effects(s,1);await clean(page,baseline,fact);
}));
for(const route of ['typing','replacement'])test(`MBI-08 slash ${route} retains explicit command route`,()=>probe('MBI-08-slash-'+route,async(page,fact)=>{
 const baseline=await mount(page,{text:'',triggers:true});if(route==='typing')await page.keyboard.type('/');else await event(page,'beforeinput',{inputType:'insertReplacementText',data:'/',cancelable:true},{from:0,to:0});
 let s=await observe(page,fact);content(s,'/',1);effects(s,1);assert.equal(await page.evaluate(()=>(window as any).inputFixture.surface.slash.menu.hidden),route!=='typing');
 if(route==='replacement')await page.getByRole('button',{name:'Slash commands',exact:true}).click();await page.getByRole('menuitem',{name:'Insert mobile paragraph',exact:true}).click();s=await observe(page,fact);assert.ok(texts(s).join('').includes('mobile command'));effects(s,2);await clean(page,baseline,fact);
}));

test('MBI-03 Indic composition preserves partial delete, final text and backward marked undo selection',()=>probe('MBI-03-indic',async(page,fact)=>{
 const baseline=await mount(page,{text:'a😀z',marks:[{from:0,to:4,type:'italic'}]},3,1);
 await page.evaluate(async()=>{const f=(window as any).inputFixture;f.deliver('compositionstart');f.mutate('aक्षिz',0,5);f.deliver('compositionupdate',{data:'क्षि'});f.mutate('aकz',0,2);f.deliver('input',{inputType:'deleteCompositionText',isComposing:true});await f.settle();f.mutate('aक्षिz',0,5);f.deliver('input',{inputType:'insertCompositionText',data:'क्षि',isComposing:true});f.deliver('compositionend',{data:'क्षि'});});
 const s=await observe(page,fact);content(s,'aक्षिz',5);effects(s,1);assert.ok(s.nodes[0].runs.every(r=>r.attributes.italic===true));assert.equal((await undo(page))?.disposition,'committed');const u=await observe(page,fact);content(u,'a😀z');assert.equal(u.selection.anchor.offset,3);assert.equal(u.selection.focus.offset,1);await clean(page,baseline,fact);
}));
test('MBI-06 deleted composition owner rejects stale target and exposes recovery without redirecting text',()=>probe('MBI-06-deleted-owner',async(page,fact)=>{
 const baseline=await mount(page,{nodes:[{text:'alpha'},{text:'other'}]},2);
 const initial=await page.evaluate(()=>{const f=(window as any).inputFixture;f.deliver('compositionstart');f.mutate('al語pha',0,3);return {bytes:[...f.engine.encodeUpdate().bytes],vector:[...f.engine.stateVector()],id:f.ids[0]};});
 const peer=new Y.Doc();peer.clientID=1901;let bytes;try{Y.applyUpdate(peer,new Uint8Array(initial.bytes));peer.getMap('delete-probe-tombstones').set(initial.id,true);bytes=[...Y.encodeStateAsUpdate(peer,new Uint8Array(initial.vector))];}finally{peer.destroy();}
 await page.evaluate(async bytes=>{const f=(window as any).inputFixture;f.engine.applyUpdate({identity:f.engine.read().identity,bytes:new Uint8Array(bytes)});await f.settle();f.deliver('compositionend',{data:'語'});},bytes);
 const s=await observe(page,fact);content(s,'other');effects(s,0,1);assert.deepEqual(s.recovery,[{reason:'stale-target',text:'語'}]);assert.equal(s.selection.anchor,null);assert.equal(s.selection.focus,null);
 assert.equal(await page.evaluate(()=>{const f=(window as any).inputFixture;const copy=f.surface.inputRecovery;copy[0].text='changed';return f.surface.inputRecovery[0].text;}),'語');await clean(page,baseline,fact);
}));
