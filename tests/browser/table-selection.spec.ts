import assert from 'node:assert/strict';
import {test} from 'node:test';
import {readFile} from 'node:fs/promises';
import {browserHarness} from './browser-harness.ts';
import {registerTableCommandCases} from './table-command-cases.ts';
const literal=JSON.parse(await readFile('fixtures/tables/selection/literal.json','utf8'));
const harness=browserHarness('table-selection','fixtures/browser-content-modules',{markdown:true,assertSourcesUnchanged:true,sourcePaths:[
 'packages/web/src/modules/content.ts','packages/web/src/modules/tables/clipboard.ts','packages/web/src/modules/reorder.ts',
 'packages/web/src/dom/render.ts','packages/web/src/dom/selection.ts','packages/web/src/surface.ts',
 'fixtures/browser-content-modules/session.mjs','fixtures/browser-content-modules/index.html','fixtures/tables/selection/literal.json',
 'tests/browser/table-command-cases.ts','crates/editac-core/src/commands/table.rs','crates/editac-core/src/interchange.rs',
]});
const {probe}=harness;
registerTableCommandCases(harness);
const section=p=>p.locator('[data-content-module="table"]');
const input=(p,r=2,c=1)=>p.getByRole('textbox',{name:`Table row ${r} column ${c}`,exact:true});
const choose=(p,r,c,shift=false)=>p.getByRole('button',{name:`Select cell row ${r} column ${c}`,exact:true}).click(shift?{modifiers:['Shift']}:{});
const selected=p=>p.locator('[data-cell-selected]').evaluateAll(cells=>cells.map(cell=>{const i=cell.querySelector('textarea');return[Number(i.dataset.row),Number(i.dataset.column)];}));
const table=s=>s.nodes.find(n=>n.blockAttributes?.[0]==='module:editac.table');
const cells=s=>table(s).blockAttributes[2].rows.map(r=>r.map(c=>c.map(run=>run[0]).join('')));
async function state(p,f){const s=await p.evaluate(()=>window.inputFixture.state());f.snapshots.push(s);assert.deepEqual(s.errors,[]);return s;}
function unchanged(a,b){assert.deepEqual(b.nodes,a.nodes);assert.deepEqual(b.history,a.history);assert.deepEqual(b.journal,a.journal);}
function oneEffect(a,b){assert.equal(b.history.undoGroups,a.history.undoGroups+1);assert.equal(b.journal.length,a.journal.length+1);assert.equal(b.commands.length,a.commands.length+1);}
async function clipboard(p,type,data={}){return p.evaluate(({type,data})=>{const transfer=new DataTransfer();for(const [key,value]of Object.entries(data))transfer.setData(key,value);const e=window.preparedClipboardEvent(type,transfer);document.querySelector('[data-content-module="table"]').dispatchEvent(e);return{prevented:e.defaultPrevented,data:Object.fromEntries([...transfer.types].map(t=>[t,transfer.getData(t)]))};},{type,data});}
test('Keyboard rectangle focus and anchor extend/reverse independently; navigation never writes',()=>probe('keyboard-rectangle',async(p,f)=>{
 const before=await state(p,f);await choose(p,2,2);await section(p).press('Shift+ArrowLeft');assert.deepEqual(await selected(p),[[1,0],[1,1]]);
 await section(p).press('Shift+ArrowUp');assert.deepEqual(await selected(p),[[0,0],[0,1],[1,0],[1,1]]);
 await section(p).press('Shift+ArrowRight');assert.deepEqual(await selected(p),[[0,1],[1,1]]);
 await section(p).press('ArrowDown');assert.deepEqual(await selected(p),[[1,1]]);
 await section(p).press('Control+Home');assert.deepEqual(await selected(p),[[0,0]]);
 await section(p).press('Control+Shift+End');assert.deepEqual(await selected(p),[[0,0],[0,1],[1,0],[1,1]]);
 await section(p).press('Home');assert.deepEqual(await selected(p),[[1,0]]);await section(p).press('End');assert.deepEqual(await selected(p),[[1,1]]);
 await section(p).press('ArrowRight');await section(p).press('ArrowDown');assert.deepEqual(await selected(p),[[1,1]]);assert.match(await section(p).getByRole('status').textContent(),/Table edge; no row or column added/);
 unchanged(before,await state(p,f));await section(p).press('Enter');assert.equal(await input(p,2,2).evaluate(el=>el===document.activeElement),true);unchanged(before,await state(p,f));
}));
test('Contextual textarea Tab preserves cells and appends one bounded final row; Alt+Enter selects a cell',()=>probe('native-tab',async(p,f)=>{
 const before=await state(p,f);await input(p).focus();await input(p).press('Tab');assert.equal(await input(p,2,2).evaluate(el=>el===document.activeElement),true);
 await input(p,2,2).press('Shift+Tab');assert.equal(await input(p).evaluate(el=>el===document.activeElement),true);
 await input(p).press('Alt+Enter');assert.deepEqual(await selected(p),[[1,0]]);await section(p).press('Escape');assert.deepEqual(await selected(p),[]);
 await input(p,2,2).focus();await section(p).evaluate(el=>{window.tabObservations=[];el.addEventListener('keydown',event=>{if(event.key==='Tab')window.tabObservations.push({prevented:event.defaultPrevented});});});
 await input(p,2,2).press('Tab');const boundary=await p.evaluate(()=>({events:window.tabObservations,active:document.activeElement?.outerHTML?.slice(0,300),leftLast:document.activeElement!==document.querySelector('[aria-label="Table row 2 column 2"]')}));f.nativeTabBoundary=boundary;
 // INT-1.6 owns cell Tab dispatch; ordinary table controls retain their native order.
 assert.deepEqual(boundary.events,[{prevented:true}]);assert.equal(boundary.leftLast,true);assert.deepEqual(await selected(p),[]);
 assert.equal(await input(p,3,1).evaluate(el=>el===document.activeElement),true);
 const after=await state(p,f);oneEffect(before,after);assert.deepEqual(cells(after).slice(0,2),cells(before));assert.deepEqual(cells(after)[2],['','']);
 await p.evaluate(()=>window.inputFixture.engine.history({type:'undo'}));assert.deepEqual((await state(p,f)).nodes,before.nodes);
}));
for(const mime of ['text/tab-separated-values','text/plain','text/html'])test(`Quoted literal tabs/quotes/empty/Unicode cells survive ${mime}, one history group and recovery`,()=>probe(`quoted-${mime.replaceAll('/','-')}`,async(p,f)=>{
 await choose(p,1,1);await choose(p,2,2,true);await clipboard(p,'paste',{'text/tab-separated-values':literal.tsv});const seeded=await state(p,f);assert.deepEqual(cells(seeded),literal.cells);
 await choose(p,1,1);await choose(p,2,2,true);const copy=await clipboard(p,'copy');assert.equal(copy.data['text/tab-separated-values'],literal.tsv);assert.equal(copy.data['text/plain'],literal.tsv);unchanged(seeded,await state(p,f));
 await section(p).press('Delete');const cleared=await state(p,f);assert.deepEqual(cells(cleared),[['',''],['','']]);await choose(p,1,1);await choose(p,2,2,true);
 await clipboard(p,'paste',{[mime]:copy.data[mime]});const after=await state(p,f);oneEffect(cleared,after);assert.deepEqual(cells(after),literal.cells);assert.equal(table(after).id,table(seeded).id);
 await p.evaluate(()=>window.inputFixture.engine.history({type:'undo'}));assert.deepEqual((await state(p,f)).nodes,cleared.nodes);await p.evaluate(()=>window.inputFixture.engine.history({type:'redo'}));assert.deepEqual((await state(p,f)).nodes,after.nodes);
 await p.evaluate(()=>window.inputFixture.reopen());assert.deepEqual((await state(p,f)).nodes,after.nodes);
},{plainTable:true}));
test('Malformed quoting and lossy HTML reject atomically, including fallback offers',()=>probe('lossless-rejection',async(p,f)=>{
 const before=await state(p,f);await choose(p,2,1);await choose(p,2,2,true);
 for(const data of literal.rejected){await clipboard(p,'paste',data);unchanged(before,await state(p,f));}
 for(const data of [{'text/plain':'😀'.repeat(270000)+'\tx'},{'text/plain':Array(129).fill('x').join('\t')},{'text/plain':'x'.repeat(1048577)}, {'text/html':'<table><tr><td>😀</td><td>'+ '😀'.repeat(270000)+'</td></tr></table>'}]){await clipboard(p,'paste',data);unchanged(before,await state(p,f));}
}));
test('CRLF rows retain the empty last column; quoted fields never flatten into a first cell',()=>probe('crlf-rectangle',async(p,f)=>{
 const before=await state(p,f);await choose(p,1,1);await choose(p,2,2,true);await clipboard(p,'paste',{'text/plain':'"a\tb"\t"c"\r\nd\t'});const after=await state(p,f);oneEffect(before,after);assert.deepEqual(cells(after),[['a\tb','c'],['d','']]);
},{plainTable:true}));
test('Cut copies explicit boundaries, clears once, and readonly cut preserves content',()=>probe('cut-rectangle',async(p,f)=>{
 const before=await state(p,f);await choose(p,2,1);await choose(p,2,2,true);const copy=await clipboard(p,'cut');assert.equal(copy.data['text/plain'],'alpha😀\tbeta');const after=await state(p,f);oneEffect(before,after);assert.deepEqual(cells(after),[['one','two'],['','']]);
 await p.evaluate(()=>window.inputFixture.engine.history({type:'undo'}));const undone=await state(p,f);assert.deepEqual(undone.nodes,before.nodes);await choose(p,2,1);await choose(p,2,2,true);await p.evaluate(()=>window.inputFixture.surface.setReadOnly(true));const cut=await clipboard(p,'cut');assert.equal(cut.data['text/plain'],'alpha😀\tbeta');unchanged(undone,await state(p,f));
},{plainTable:true}));
test('Keyboard and pointer oversized rectangles retain the last valid selection without writes',()=>probe('selection-limit',async(p,f)=>{
 const before=await state(p,f);await choose(p,1,1);await section(p).press('Control+Shift+End');assert.deepEqual(await selected(p),[[0,0]]);assert.match(await section(p).getByRole('status').textContent(),/128 cells/);
 await choose(p,9,16,true);assert.deepEqual(await selected(p),[[0,0]]);unchanged(before,await state(p,f));
},{tableSource:'|'+Array(16).fill('head').join('|')+'|\n|'+Array(16).fill('---').join('|')+'|\n'+Array(8).fill('|'+Array(16).fill('cell').join('|')+'|').join('\n')}));


test('Quoted cell LF preserves boundaries and native previews through copy, history and reopen',()=>probe('quoted-cell-linefeed',async(p,f)=>{
 const before=await state(p,f);await choose(p,2,1);await choose(p,2,2,true);
 await clipboard(p,'paste',literal.admittedLinefeed.offer);const after=await state(p,f);oneEffect(before,after);
 assert.deepEqual(cells(after),literal.admittedLinefeed.cells);
 assert.equal(await section(p).getByRole('textbox',{name:'Table row 2 column 1',exact:true}).inputValue(),'new\nline');
 assert.equal(await section(p).locator('tr').count(),2);
 await choose(p,2,1);await choose(p,2,2,true);const copy=await clipboard(p,'copy');
 assert.equal(copy.data['text/plain'],literal.admittedLinefeed.copied);unchanged(after,await state(p,f));
 await p.evaluate(()=>window.inputFixture.engine.history({type:'undo'}));assert.deepEqual((await state(p,f)).nodes,before.nodes);
 await p.evaluate(()=>window.inputFixture.engine.history({type:'redo'}));assert.deepEqual((await state(p,f)).nodes,after.nodes);
 await p.evaluate(()=>window.inputFixture.reopen());assert.deepEqual((await state(p,f)).nodes,after.nodes);
 assert.equal(await section(p).getByRole('textbox',{name:'Table row 2 column 1',exact:true}).inputValue(),'new\nline');
}));
