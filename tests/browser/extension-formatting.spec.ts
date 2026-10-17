import assert from 'node:assert/strict';
import {test} from 'node:test';
import {readFile} from 'node:fs/promises';
import {browserHarness} from './browser-harness.ts';
const fixture=JSON.parse(await readFile('fixtures/rich-presenters/formatting/table-inline.json','utf8'));
const mime='application/x-edit-ac-table-cells+json';
const {probe}=browserHarness('extension-formatting','fixtures/browser-content-modules',{markdown:true,assertSourcesUnchanged:true,sourcePaths:[
 'packages/web/src/dom/render.ts','packages/web/src/modules/content.ts','packages/web/src/modules/tables/clipboard.ts','packages/web/src/modules/index.ts',
 'crates/editac-core/src/commands/table.rs','crates/editac-core/src/commands/format.rs','crates/editac-core/src/interchange.rs',
 'crates/editac-session/src/edit_service.rs','fixtures/rich-presenters/formatting/table-inline.json','fixtures/browser-content-modules/session.mjs',
]});
const section=p=>p.locator('[data-content-module="table"]');
const choose=(p,r,c,shift=false)=>p.getByRole('button',{name:`Select cell row ${r} column ${c}`,exact:true}).click(shift?{modifiers:['Shift']}:{});
const table=s=>s.nodes.find(n=>n.blockAttributes?.[0]==='module:editac.table');
const tuple=s=>table(s).blockAttributes;
const rows=s=>tuple(s)[2].rows;
async function state(p,f){const s=await p.evaluate(()=>window.inputFixture.state());f.snapshots.push(s);assert.deepEqual(s.errors,[]);return s;}
function unchanged(a,b){assert.deepEqual(b.nodes,a.nodes);assert.deepEqual(b.history,a.history);assert.deepEqual(b.journal,a.journal);}
function one(a,b){assert.equal(b.history.undoGroups,a.history.undoGroups+1);assert.equal(b.journal.length,a.journal.length+1);}
async function clip(p,type,data={}){return p.evaluate(({type,data})=>{const transfer=new DataTransfer();for(const [key,value] of Object.entries(data))transfer.setData(key,value);const event=window.preparedClipboardEvent(type,transfer);document.querySelector('[data-content-module="table"]').dispatchEvent(event);return{prevented:event.defaultPrevented,data:Object.fromEntries([...transfer.types].map(key=>[key,transfer.getData(key)]))};},{type,data});}
async function history(p,type){await p.evaluate(type=>window.inputFixture.engine.history({type}),type);}
for(const [label,mark,tag] of [['Bold cells','bold','strong'],['Italic cells','italic','em'],['Underline cells','underline','u'],['Strike cells','strike','s'],['Code cells','code','code'],['Link cells','link','a']])test(`scoped ${mark}: reverse rectangle, metadata, undo and storage`,()=>probe(`mark-${mark}`,async(p,f)=>{
 const before=await state(p,f);await choose(p,1,2);await choose(p,1,1,true);
 if(mark==='link')await p.getByRole('textbox',{name:'Table cell link',exact:true}).fill('https://EXAMPLE.test');
 await p.getByRole('button',{name:label,exact:true}).click();const after=await state(p,f);one(before,after);
 const expected=structuredClone(tuple(before));for(const cell of expected[2].rows[0])for(const run of cell)run[1]=[[mark,...(mark==='link'?['https://example.test/']:[])]];
 assert.deepEqual(tuple(after),expected);assert.equal(table(after).id,table(before).id);assert.deepEqual(table(after).runs,table(before).runs);
 assert.equal(await section(p).locator(`tr:first-child ${tag}`).count(),2);assert.equal(await p.locator('[data-cell-selected]').count(),2);assert.equal(after.commands.at(-1).commands[0].type,'tableFormat');
 await history(p,'undo');assert.deepEqual((await state(p,f)).nodes,before.nodes);await history(p,'redo');assert.deepEqual((await state(p,f)).nodes,after.nodes);await p.evaluate(()=>window.inputFixture.reopen());assert.deepEqual((await state(p,f)).nodes,after.nodes);
},{plainTable:true}));
test('toggle, mixed marks, code precedence and normalized links',()=>probe('precedence',async(p,f)=>{
 await choose(p,2,1);await p.getByRole('button',{name:'Bold cells',exact:true}).click();const bold=await state(p,f);
 await p.getByRole('button',{name:'Italic cells',exact:true}).click();const both=await state(p,f);one(bold,both);assert.deepEqual(rows(both)[1][0][0][1],[['bold'],['italic']]);
 await p.getByRole('button',{name:'Bold cells',exact:true}).click();const italic=await state(p,f);one(both,italic);assert.deepEqual(rows(italic)[1][0][0][1],[['italic']]);
 await p.getByRole('button',{name:'Code cells',exact:true}).click();const code=await state(p,f);one(italic,code);assert.deepEqual(rows(code)[1][0][0][1],[['code']]);
 await p.getByRole('button',{name:'Underline cells',exact:true}).click();unchanged(code,await state(p,f));assert.match(await section(p).getByRole('status').textContent(),/rejected/);
 await p.getByRole('button',{name:'Code cells',exact:true}).click();const plain=await state(p,f);one(code,plain);assert.deepEqual(rows(plain)[1][0][0][1],[]);
 await p.getByRole('textbox',{name:'Table cell link',exact:true}).fill('javascript:alert(1)');await p.getByRole('button',{name:'Link cells',exact:true}).click();unchanged(plain,await state(p,f));
 await p.getByRole('textbox',{name:'Table cell link',exact:true}).fill('mailto:team@example.test');await p.getByRole('button',{name:'Link cells',exact:true}).click();const linked=await state(p,f);one(plain,linked);
 await p.getByRole('button',{name:'Remove cell link',exact:true}).click();const removed=await state(p,f);one(linked,removed);assert.deepEqual(rows(removed)[1][0][0][1],[]);
},{plainTable:true}));
test('all mixed marks survive rich rectangle clipboard, undo/redo and reopen',()=>probe('rich-rectangle',async(p,f)=>{
 const before=await state(p,f);assert.deepEqual(tuple(before),fixture.tuple);await choose(p,2,2);await choose(p,1,1,true);
 const copy=await clip(p,'copy');unchanged(before,await state(p,f));assert.equal(copy.prevented,true);assert.deepEqual(JSON.parse(copy.data[mime]),{version:1,cells:fixture.tuple[2].rows});assert.equal(copy.data['text/plain'],'Header\té😀\n=SUM(A1)\tlinked');
 await section(p).press('Delete');const cleared=await state(p,f);one(before,cleared);
 await clip(p,'paste',copy.data);const after=await state(p,f);one(cleared,after);assert.deepEqual(tuple(after),tuple(before));assert.equal(table(after).id,table(before).id);assert.equal(after.commands.at(-1).commands[0].type,'tableRichRectangle');
 await history(p,'undo');assert.deepEqual((await state(p,f)).nodes,cleared.nodes);await history(p,'undo');assert.deepEqual((await state(p,f)).nodes,before.nodes);await history(p,'redo');await history(p,'redo');assert.deepEqual((await state(p,f)).nodes,after.nodes);
 await p.evaluate(()=>window.inputFixture.reopen());assert.deepEqual((await state(p,f)).nodes,after.nodes);
},{tableTuple:fixture.tuple}));
test('structured precedence rejects unknown codec version; explicit literal mode bypasses it',()=>probe('literal-precedence',async(p,f)=>{
 const before=await state(p,f);await choose(p,1,1);const data={[mime]:JSON.stringify({version:2,cells:[]}), 'text/plain':'literal =SUM(A1)'};
 await clip(p,'paste',data);unchanged(before,await state(p,f));await p.getByRole('checkbox',{name:'Paste cells as literal text',exact:true}).check();await clip(p,'paste',data);const after=await state(p,f);one(before,after);assert.deepEqual(rows(after)[0][0],[['literal =SUM(A1)',[]]]);assert.equal(after.commands.at(-1).commands[0].type,'tableRectangle');
},{plainTable:true}));
test('marks survive row/column shape operations and undo',()=>probe('shape-preservation',async(p,f)=>{
 const before=await state(p,f);await choose(p,2,2);await p.getByRole('button',{name:'Insert row before',exact:true}).click();const added=await state(p,f);one(before,added);assert.ok(added.inputs.every(i=>!i.readOnly),'shape-view diagnostics stay with the presenter, not native input recovery');assert.equal(await p.evaluate(()=>window.inputFixture.root.contentEditable),'true');assert.deepEqual(rows(added)[0],rows(before)[0]);assert.deepEqual(rows(added)[2],rows(before)[1]);
 await history(p,'undo');assert.deepEqual((await state(p,f)).nodes,before.nodes);await choose(p,2,1);await p.getByRole('button',{name:'Insert column after',exact:true}).click();const column=await state(p,f);assert.deepEqual(rows(column).map(r=>[r[0],r[2]]),rows(before));
 await choose(p,1,2);await p.getByRole('button',{name:'Remove columns',exact:true}).click();assert.deepEqual(tuple(await state(p,f)),tuple(before));await history(p,'undo');assert.deepEqual((await state(p,f)).nodes,column.nodes);await p.evaluate(()=>window.inputFixture.reopen());assert.deepEqual((await state(p,f)).nodes,column.nodes);
},{tableTuple:fixture.tuple}));
test('readonly, protection and stale targets preserve semantic/history/storage effects',()=>probe('rejections',async(p,f)=>{
 const before=await state(p,f);await choose(p,1,1);await p.evaluate(()=>window.inputFixture.config.protected=[[0,0]]);await p.getByRole('button',{name:'Bold cells',exact:true}).click();unchanged(before,await state(p,f));await clip(p,'paste',{[mime]:JSON.stringify({version:1,cells:[[[['blocked',[['bold']]]]]]})});unchanged(before,await state(p,f));
 await p.evaluate(()=>{window.inputFixture.config.protected=[];window.inputFixture.surface.setReadOnly(true);});assert.equal(await p.getByRole('button',{name:'Bold cells',exact:true}).isDisabled(),true);await clip(p,'paste',{[mime]:JSON.stringify({version:1,cells:[[[['blocked',[]]]]]})});unchanged(before,await state(p,f));
 await p.evaluate(()=>{window.inputFixture.surface.setReadOnly(false);const n=window.inputFixture.engine.read().visible.find(n=>n.blockAttributes?.[0]==='module:editac.table');window.staleCellFormat={type:'tableFormat',owner:n.id,expected:n.blockAttributes,row:0,column:0,rows:1,columns:1,mark:'bold',action:'apply',href:null,protected:[]};window.pendingCellFormat=window.inputFixture.engine.prepare({kind:'editor',origin:'delayed-cell-format',commands:[window.staleCellFormat]});});await choose(p,1,1);
 assert.equal(await p.evaluate(()=>window.inputFixture.peerCell('remote😀')),true);const remote=await state(p,f);assert.equal(await p.evaluate(()=>window.inputFixture.engine.can({kind:'editor',origin:'stale',commands:[window.staleCellFormat]})),false);assert.equal(await p.evaluate(()=>{try{window.inputFixture.engine.commit(window.pendingCellFormat);return false;}catch{return true;}}),true);unchanged(remote,await state(p,f));assert.equal(await p.locator('[data-cell-selected]').count(),0);
},{plainTable:true}));
test('invalid, unsupported and over-limit rich offers never fall back or mutate',()=>probe('invalid-offers',async(p,f)=>{
 const before=await state(p,f);await choose(p,1,1);const cells=text=>[[[[text,[]]]]];
 const invalid=[{version:1,cells:[]},{version:1,cells:cells('x'),extra:true},{version:1,cells:cells('a\nb')},
 {version:1,cells:[[[['x',[['link','javascript:alert(1)']]]]]]}, {version:1,cells:[[[['x',[['bold'],['bold']]]]]]}, {version:1,cells:[[[['x',[['code'],['italic']]]]]]}, {version:1,cells:[[[['x',[['heading']]]]]]},
 {version:1,cells:[[[{paragraphs:[],rowSpan:1,columnSpan:1,header:true}]]]}, {version:1,cells:cells('😀'.repeat(530000))}, {version:1,cells:[[[['one',[]]],[['two',[]]]]]}];
 for(const offer of invalid){await clip(p,'paste',{[mime]:JSON.stringify(offer),'text/plain':'must not fallback'});unchanged(before,await state(p,f));}await clip(p,'paste',{[mime]:'{broken','text/plain':'must not fallback'});unchanged(before,await state(p,f));
 const results=await p.evaluate(()=>{const e=window.inputFixture.engine,n=e.read().visible.find(n=>n.blockAttributes?.[0]==='module:editac.table'),command={type:'tableFormat',owner:n.id,expected:n.blockAttributes,row:0,column:0,rows:1,columns:1,mark:'bold',action:'apply',href:null,protected:[]};return [{...command,rows:0},{...command,rows:129},{...command,column:999},{...command,mark:'list'},{...command,href:'https://example.test'},{...command,protected:[[0,0]]}].map(c=>e.can({kind:'editor',origin:'invalid',commands:[c]}));});assert.deepEqual(results,[false,false,false,false,false,false]);unchanged(before,await state(p,f));
},{plainTable:true}));
