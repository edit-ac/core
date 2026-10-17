import assert from 'node:assert/strict';
import {test} from 'node:test';
export function registerSlashCases(probe) {
async function state(page,fact){const s=await page.evaluate(()=>window.inputFixture.state());fact.snapshots.push(s);assert.deepEqual(s.errors,[]);return s;}
async function type(page,text){await page.keyboard.type(text);}
async function select(page,start,end=start){await page.evaluate(({start,end})=>window.inputFixture.select(window.inputFixture.ids[0],start,end),{start,end});}

test('eligible start/whitespace typing opens bounded named menu; literal query persists',()=>probe('eligible',async(page,fact)=>{
 await type(page,'/Al');const s=await state(page,fact);assert.equal(s.open,true);assert.equal(s.query,'Al');assert.equal(s.text[0],'/Al');
 assert.equal(await page.locator('[role=menu]').getAttribute('aria-label'),'Slash commands');assert.equal(await page.locator('[role=menuitem]').count(),1);
 assert.equal(await page.locator('[role=menuitem]').getAttribute('aria-disabled'),'false');
},''));
for(const prefix of ['word','https:','path/','\\'])test(`ineligible boundary ${JSON.stringify(prefix)} stays literal`,()=>probe(`excluded-${prefix.replace(/\W/g,'')}`,async(page,fact)=>{
 await type(page,'/');const s=await state(page,fact);assert.equal(s.open,false);assert.equal(s.text[0],prefix+'/');
},prefix));
test('whitespace boundary and expanded selection exclusions',()=>probe('boundary-selection',async(page,fact)=>{
 await type(page,'/');let s=await state(page,fact);assert.equal(s.open,true);await page.keyboard.press('Escape');await select(page,0,2);await type(page,'/');s=await state(page,fact);assert.equal(s.open,false);assert.equal(s.text[0],'//');
},'a '));
test('imported, pasted, unclassified replacement and remote slash never auto-open',()=>probe('provenance',async(page,fact)=>{
 let s=await state(page,fact);assert.equal(s.open,false);
 await page.evaluate(()=>window.inputFixture.event('beforeinput',{inputType:'insertText',data:'/',cancelable:true}));s=await state(page,fact);assert.equal(s.open,false);
 await page.keyboard.insertText('/');s=await state(page,fact);assert.equal(s.open,false);
 await page.evaluate(()=>{const e=preparedClipboardEvent('paste',{getData:m=>m==='text/plain'?'/paste':''});window.inputFixture.root.dispatchEvent(e);});s=await state(page,fact);assert.equal(s.open,false);
 await page.evaluate(()=>window.inputFixture.remote(0,'/remote'));s=await state(page,fact);assert.equal(s.open,false);assert.ok(s.text[0].includes('/paste'));
},'/import'));
test('code/link contexts exclude automatic slash',()=>probe('context',async(page,fact)=>{
 await page.evaluate(()=>{const f=window.inputFixture,e=f.engine;e.commit(e.prepare({kind:'editor',origin:'fixture-code',commands:[{type:'setCode',owner:f.ids[0],language:'js'}]}));});await select(page,0);await type(page,'/');let s=await state(page,fact);assert.equal(s.open,false);
 await page.evaluate(()=>{const f=window.inputFixture,e=f.engine;e.commit(e.prepare({kind:'editor',origin:'fixture-paragraph',commands:[{type:'setParagraph',owner:f.ids[0]}]}));const anchor=e.anchor(f.ids[0],0,'right'),focus=e.anchor(f.ids[0],1,'left');try{e.commit(e.prepare({kind:'format',origin:'fixture-link',marks:[{range:{anchor,focus},mark:'link',action:'apply',href:'https://example.test'}],blocks:[]}));}finally{e.releaseAnchor(anchor);e.releaseAnchor(focus);}});await select(page,0);await type(page,'/');s=await state(page,fact);assert.equal(s.open,false);
},''));
test('keyboard skips disabled entries; successful command commits once and undo restores query/caret',()=>probe('keyboard-history',async(page,fact)=>{
 await type(page,'/');const before=await state(page,fact);await page.keyboard.press('ArrowDown');assert.equal((await state(page,fact)).active,'code');await page.keyboard.press('Home');assert.equal((await state(page,fact)).active,'alpha');await page.keyboard.press('End');assert.equal((await state(page,fact)).active,'zulu');await page.keyboard.press('Home');await page.keyboard.press('Enter');
 let s=await state(page,fact);assert.equal(s.open,false);assert.equal(s.text[0],'chosen');assert.equal(s.text[1],'independent');assert.equal(s.history.undoGroups,before.history.undoGroups+1);assert.equal(s.commands.filter(c=>c.origin==='slash:alpha').length,1);assert.equal(s.journal.filter(o=>o.includes('slash:alpha')).length,1);assert.equal(s.focus,true);assert.equal(s.caret,6);
 await page.evaluate(()=>window.inputFixture.engine.history({type:'undo'}));s=await state(page,fact);assert.equal(s.text[0],'/');assert.equal(s.history.undoGroups,before.history.undoGroups);assert.equal(s.open,false);
},''));
test('touch/pointer item activation survives editor blur and matches keyboard dispatch',()=>probe('pointer-focus',async(page,fact)=>{
 await type(page,'/Al');await page.locator('[data-command=alpha]').click();const s=await state(page,fact);assert.equal(s.text[0],'chosen');assert.equal(s.focus,true);assert.equal(s.commands.filter(c=>c.origin==='slash:alpha').length,1);
},''));
test('assistive composite focus and explicit command access preserve anchored query',()=>probe('composite-explicit',async(page,fact)=>{
 let s=await state(page,fact);assert.equal(s.open,false);await page.getByRole('button',{name:'Slash commands',exact:true}).click();s=await state(page,fact);assert.equal(s.open,true);assert.equal(s.active,'alpha');await page.locator('[data-command=alpha]').focus();await page.keyboard.press('Enter');s=await state(page,fact);assert.equal(s.text[0],'chosen');assert.equal(s.focus,true);
},'/Al'));
test('Escape retains query without reopening; Backspace filters/deletes trigger',()=>probe('escape-backspace',async(page,fact)=>{
 await type(page,'/Al');await page.keyboard.press('Backspace');let s=await state(page,fact);assert.equal(s.query,'A');await page.keyboard.press('Escape');s=await state(page,fact);assert.equal(s.text[0],'/A');assert.equal(s.open,false);await type(page,'l');s=await state(page,fact);assert.equal(s.open,false);
 await select(page,0,3);await page.keyboard.press('Backspace');await type(page,'/');await page.keyboard.press('Backspace');s=await state(page,fact);assert.equal(s.text[0],'');assert.equal(s.open,false);
},''));
test('zero/all-disabled results consume Enter without splitting; Shift+Enter hard breaks',()=>probe('empty-dispatch',async(page,fact)=>{
 await type(page,'/NoMatch');const before=await state(page,fact);await page.keyboard.press('Enter');let s=await state(page,fact);assert.equal(s.open,true);assert.equal(s.text[0],'/NoMatch');assert.deepEqual(s.history,before.history);assert.equal(s.nodes.length,2);
 await page.keyboard.press('Escape');await select(page,0,8);await page.keyboard.press('Backspace');await type(page,'/Blocked');await page.keyboard.press('Enter');s=await state(page,fact);assert.equal(s.text[0],'/Blocked');assert.equal(s.open,true);await page.keyboard.press('Shift+Enter');s=await state(page,fact);assert.equal(s.text[0],'/Blocked\n');assert.equal(s.open,false);assert.equal(s.nodes.length,2);
},''));
test('Tab dismisses without accepting, focus exit/caret movement/read-only dismiss',()=>probe('cancellation',async(page,fact)=>{
 await type(page,'/');await page.keyboard.press('Tab');let s=await state(page,fact);assert.equal(s.open,false);assert.equal(s.text[0],'/');assert.equal(s.commands.filter(c=>c.origin.startsWith('slash:')).length,0);
 await select(page,0,1);await type(page,'/');await select(page,0);s=await state(page,fact);assert.equal(s.open,false);
 await select(page,0,1);await type(page,'/');await page.evaluate(()=>{const outside=document.createElement('button');outside.id='outside';document.body.append(outside);outside.focus();});s=await state(page,fact);assert.equal(s.open,false);
 await select(page,0,1);await type(page,'/');await page.evaluate(()=>window.inputFixture.surface.setReadOnly(true));s=await state(page,fact);assert.equal(s.open,false);assert.equal(s.text[0],'/');
},''));
test('IME owns commit Enter before popup; composing/direct ambiguous events never trigger',()=>probe('ime-priority',async(page,fact)=>{
 await type(page,'/');assert.equal((await state(page,fact)).open,true);
 await page.evaluate(()=>{const f=window.inputFixture;f.event('compositionstart');f.event('keydown',{key:'Enter',isComposing:true});});let s=await state(page,fact);assert.equal(s.open,false);assert.equal(s.commands.filter(c=>c.origin.startsWith('slash:')).length,0);assert.equal(s.nodes.length,2);
 await page.evaluate(()=>{const f=window.inputFixture;f.event('compositionend',{data:''});f.event('keyup',{key:'Enter'});});s=await state(page,fact);assert.equal(s.open,false);
},''));
test('async errors retain query; query changes cancel stale/out-of-order results',()=>probe('async-stale',async(page,fact)=>{
 await type(page,'/Error');await page.keyboard.press('Enter');let s=await state(page,fact);assert.equal(s.text[0],'/Error');assert.equal(s.open,true);assert.match(s.status,/failed/);
 for(let i=0;i<5;i++)await page.keyboard.press('Backspace');await type(page,'Slow');await page.keyboard.press('Enter');await page.keyboard.press('Enter');s=await state(page,fact);assert.equal(s.text[0],'/Slow');assert.deepEqual(s.aborted,[false]);
 await type(page,'x');s=await state(page,fact);assert.deepEqual(s.aborted,[true]);await page.evaluate(()=>{const f=window.inputFixture;f.pending[0].resolve(f.fragment('STALE'));});s=await state(page,fact);assert.equal(s.text[0],'/Slowx');assert.equal(s.commands.filter(c=>c.origin==='slash:slow').length,0);
 await page.keyboard.press('Backspace');await page.keyboard.press('Enter');await page.evaluate(()=>{const f=window.inputFixture;f.pending[1].resolve(f.fragment('fresh'));});s=await state(page,fact);assert.equal(s.text[0],'fresh');assert.equal(s.commands.filter(c=>c.origin==='slash:slow').length,1);
},''));
test('remote/read-only/destruction abort in-flight actions and release popup resources',()=>probe('async-teardown',async(page,fact)=>{
 await type(page,'/Slow');await page.keyboard.press('Enter');await page.evaluate(()=>window.inputFixture.remote(0,'peer '));let s=await state(page,fact);assert.equal(s.open,false);assert.deepEqual(s.aborted,[true]);await page.evaluate(()=>{const f=window.inputFixture;f.pending[0].resolve(f.fragment('STALE'));});s=await state(page,fact);assert.equal(s.text[0],'peer /Slow');
 await select(page,5,10);await type(page,'/Slow');await page.keyboard.press('Enter');await page.evaluate(()=>window.inputFixture.surface.setReadOnly(true));s=await state(page,fact);assert.equal(s.open,false);assert.equal(s.aborted.at(-1),true);
 await page.evaluate(()=>{const f=window.inputFixture;f.surface.setReadOnly(false);f.select(f.ids[0],10);f.surface.slash.openExplicit();});await page.keyboard.press('Enter');await page.evaluate(()=>{const f=window.inputFixture;f.surface.dispose();for(const p of f.pending)p.resolve(f.fragment('STALE'));});s=await page.evaluate(()=>({text:window.inputFixture.engine.read().visible[0].runs.map(r=>r.text).join(''),menus:document.querySelectorAll('[role=menu]').length,aborted:window.inputFixture.pending.map(p=>p.signal.aborted)}));fact.snapshots.push(s);assert.equal(s.menus,0);assert.ok(s.aborted.every(Boolean));assert.equal(s.text,'peer /Slow');
},''));
test('editor command removes only query and performs semantic conversion atomically',()=>probe('editor-command',async(page,fact)=>{
 await type(page,'/Code');const before=await state(page,fact);await page.keyboard.press('Enter');let s=await state(page,fact);assert.equal(s.text[0],'prefix ');assert.deepEqual(s.nodes[0].blockAttributes,['code','js']);assert.equal(s.history.undoGroups,before.history.undoGroups+1);assert.equal(s.commands.filter(c=>c.origin==='slash:code').length,1);
 await page.evaluate(()=>window.inputFixture.engine.history({type:'undo'}));s=await state(page,fact);assert.equal(s.text[0],'prefix /Code');assert.deepEqual(s.nodes[0].blockAttributes,['paragraph']);
},'prefix '));

test('bounded query, paste and incompatible caret cancel without deleting source',()=>probe('bounds-paste',async(page,fact)=>{
 await type(page,'/'+ 'a'.repeat(65));let s=await state(page,fact);assert.equal(s.open,false);assert.equal(s.text[0].length,66);
 await select(page,0,66);await page.keyboard.press('Backspace');await type(page,'/');await page.evaluate(()=>window.inputFixture.root.dispatchEvent(preparedClipboardEvent('paste',{getData:m=>m==='text/plain'?'Al':''})));s=await state(page,fact);assert.equal(s.open,false);assert.equal(s.text[0],'/Al');
},''));
test('invalid prepared action retains source and creates no command/history update',()=>probe('invalid-command',async(page,fact)=>{
 await type(page,'/Slow');const before=await state(page,fact);await page.keyboard.press('Enter');await page.evaluate(()=>window.inputFixture.pending[0].resolve({type:'editor',commands:[{type:'setCode',owner:'missing-owner',language:'js'}]}));const s=await state(page,fact);assert.equal(s.open,true);assert.equal(s.text[0],'/Slow');assert.deepEqual(s.history,before.history);assert.equal(s.commands.filter(c=>c.origin==='slash:slow').length,0);assert.match(s.status,/unavailable/);
},''));

test('focused enabled/disabled items determine Enter action',()=>probe('focused-item',async(page,fact)=>{
 await type(page,'/');await page.locator('[data-command=blocked]').focus();await page.keyboard.press('Enter');let s=await state(page,fact);assert.equal(s.open,true);assert.equal(s.text[0],'/');assert.equal(s.commands.filter(c=>c.origin.startsWith('slash:')).length,0);
 await page.locator('[data-command=zulu]').focus();await page.keyboard.press('Enter');s=await state(page,fact);assert.equal(s.text[0],'last');assert.equal(s.commands.filter(c=>c.origin==='slash:zulu').length,1);
},''));
test('focused menu Backspace returns to native query filtering; Shift+Enter keeps same block',()=>probe('focused-editing',async(page,fact)=>{
 await type(page,'/Al');await page.keyboard.press('ArrowDown');await page.keyboard.press('Backspace');let s=await state(page,fact);assert.equal(s.text[0],'/A');assert.equal(s.query,'A');assert.equal(s.open,true);
 await page.keyboard.press('Home');await page.keyboard.press('Shift+Enter');s=await state(page,fact);assert.equal(s.text[0],'/A\n');assert.equal(s.nodes.length,2);assert.equal(s.open,false);
},''));
test('visible command button remains keyboard reachable for ambiguous input',()=>probe('keyboard-explicit',async(page,fact)=>{
 await page.keyboard.press('Tab');await page.keyboard.press('Enter');let s=await state(page,fact);assert.equal(s.open,true);assert.equal(s.active,'alpha');await page.keyboard.press('Enter');s=await state(page,fact);assert.equal(s.text[0],'chosen');assert.equal(s.focus,true);
},'/Al'));
test('literal configuration excludes auto/explicit triggers without changing source',()=>probe('literal',async(page,fact)=>{
 await type(page,'/Al');let s=await state(page,fact);assert.equal(s.open,false);await page.getByRole('button',{name:'Slash commands',exact:true}).click();s=await state(page,fact);assert.equal(s.open,false);assert.equal(s.text[0],'/Al');
},{text:'',literal:true}));

test('popup Escape arms the next Tab focus escape in a list without indentation',()=>probe('list-focus-escape',async(page,fact)=>{
 await page.evaluate(()=>{const f=window.inputFixture;f.engine.commit(f.engine.prepare({kind:'editor',origin:'fixture-list',commands:[{type:'wrap',targets:[f.ids[0]],style:{type:'unordered'}}]}));});await select(page,0);await type(page,'/');const before=await state(page,fact);await page.keyboard.press('Escape');await page.keyboard.press('Tab');const s=await state(page,fact);assert.equal(s.open,false);assert.equal(s.text.find(t=>t==='/'),'/');assert.deepEqual(s.history,before.history);assert.equal(s.commands.filter(c=>c.origin.includes('keyboard:')).length,0);assert.equal(s.focus,false);
},''));

}
