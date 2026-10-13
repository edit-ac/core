import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';
import * as Y from 'yjs';
import { browserHarness } from './browser-harness.ts';
const corpus=JSON.parse(await readFile(new URL('../../fixtures/modules/math.json',import.meta.url),'utf8'));
const directory=process.env.EDITAC_MATH_FIXTURES;
if(!directory)throw Error('EDITAC_MATH_FIXTURES must contain the executed portable Rust fixtures');
const bytes=Object.fromEntries(await Promise.all(corpus.cases.map(async c=>[c.name,[...await readFile(`${directory}/${c.name}.bin`)]])));
const {probe}=browserHarness('math','fixtures/browser-math');
const atom=page=>page.locator('[data-math-module]');
async function state(page,fact){const s=await page.evaluate(()=>window.inputFixture.state());fact.snapshots.push(s);return s;}
for(const c of corpus.cases)test(`${c.name}: safe lazy preview or literal source without document mutation`,()=>probe(c.name,async(page,fact)=>{
 await page.waitForFunction(expected=>document.querySelector('[data-math-module]')?.dataset.mathState===expected,c.expected);
 const s=await state(page,fact),run=s.nodes.find(n=>n.id==='n:11:1').runs[0];
 assert.equal(run.text,'LaTeX source: '+c.latex);assert.deepEqual(run.attributes['module:editac.math'],[1,{latex:c.latex,display:c.display}]);
 assert.match(s.text,/LaTeX source/);assert.equal(s.journal.length,0);assert.deepEqual(s.errors,[]);assert.deepEqual(s.moduleErrors,[]);
 assert.equal(await page.locator('script:not([type="module"]):not([type="importmap"]),img,iframe,a,[href],[src]:not(script)').count(),0);
 assert.equal(await atom(page).locator('math').count(),c.expected==='rendered'?1:0);
 if(c.expected==='rendered')assert.equal(await atom(page).locator('math').getAttribute('display'),c.display?'block':null);
 await page.evaluate(()=>window.inputFixture.reopen(true));const disabled=await state(page,fact);assert.deepEqual(disabled.nodes,s.nodes);assert.equal(await atom(page).count(),0);assert.match(disabled.text,/LaTeX source/);
},{bytes:bytes[c.name]}));
for(const mode of ['disabled','absentRenderer'])test(`${mode}: no lazy renderer request and source survives IndexedDB recovery`,()=>probe(mode,async(page,fact)=>{
 const requests=[];page.on('request',r=>requests.push(r.url()));const s=await state(page,fact);assert.equal(await atom(page).count(),0);assert.match(s.text,/LaTeX source/);
 await page.evaluate(()=>window.inputFixture.reopen(true));assert.deepEqual((await state(page,fact)).nodes,s.nodes);
 assert.equal(requests.filter(x=>/math-renderer|katex/.test(x)).length,0);
},{bytes:bytes.inline,[mode]:true}));
test('portable helper shares exact Rust definition and enforces UTF-16 and control bounds',()=>probe('helper',async(page,fact)=>{
 const value=await page.evaluate(async definition=>{const m=await import('/web/modules/math.js');const ok=m.mathAtom('😀'.repeat(2048),true);const failures=['😀'.repeat(2049),'x\u0000'].map(s=>{try{m.mathAtom(s);return false;}catch{return true;}});return{definition:m.mathModuleDefinition,ok,failures,frozen:Object.isFrozen(m.mathModuleDefinition.attributes.latex)};},corpus.definition);
 fact.snapshots.push(value);assert.deepEqual(value.definition,corpus.definition);assert.equal(value.ok.text.length,4110);assert.deepEqual(value.failures,[true,true]);assert.equal(value.frozen,true);
},{bytes:bytes.inline,disabled:true}));
test('renderer network failure preserves source and document state',()=>probe('load-error',async(page,fact)=>{
 const before=await state(page,fact);await page.route('**/math-renderer.js',route=>route.abort());await page.evaluate(()=>window.inputFixture.reopen());
 await page.waitForFunction(()=>document.querySelector('[data-math-module]')?.dataset.mathState==='source');
 const s=await state(page,fact);assert.deepEqual(s.nodes,before.nodes);assert.match(s.text,/LaTeX source/);assert.deepEqual(s.errors,[]);assert.equal(await page.locator('math').count(),0);
},{bytes:bytes.inline,disabled:true}));
test('direct pinned renderer disables URL and HTML execution without presenter filtering',()=>probe('renderer-safety',async(page,fact)=>{
 const value=await page.evaluate(async()=>{const {renderMath}=await import('/web/modules/math-renderer.js');return [String.raw`\href{https://external.invalid}{x}`,String.raw`\includegraphics{https://external.invalid/x}`,String.raw`\htmlStyle{background:url(https://external.invalid/x)}{x}`,String.raw`\input{https://external.invalid/macros}`].map(s=>{try{const result=renderMath(s,false,document);return{unsafe:!!result.querySelector('a,img,script,iframe,[href],[src],[style]'),text:result.textContent};}catch{return{unsafe:false,error:true};}});});
 fact.snapshots.push(value);assert.ok(value.every(v=>v.unsafe===false));
},{bytes:bytes.inline}));
test('unrelated edits and real native selection retain the math view',()=>probe('stable-view',async(page,fact)=>{
 await page.waitForFunction(()=>document.querySelector('[data-math-module]')?.dataset.mathState==='rendered');
 const value=await page.evaluate(async()=>{const f=window.inputFixture,view=f.root.querySelector('[data-math-module]'),math=view.querySelector('math'),n=f.engine.read().visible.find(n=>n.id==='n:11:2'),a=f.engine.anchor(n.id,0,'right');try{f.engine.commit(f.engine.prepare({kind:'text',origin:'prepared-unrelated',command:{type:'insert',at:a,text:'other'}}));}finally{f.engine.releaseAnchor(a);}f.root.focus();const text=f.root.querySelector('[data-module-type="editac.math"]').lastChild;document.getSelection().setBaseAndExtent(text,1,text,2);document.dispatchEvent(new Event('selectionchange'));await f.settle();return{view:view===f.root.querySelector('[data-math-module]'),math:math===view.querySelector('math')};});fact.snapshots.push(value);assert.deepEqual(value,{view:true,math:true});
},{bytes:bytes.inline}));
test('pending render disposal cannot recreate detached preview',()=>probe('dispose-pending',async(page,fact)=>{
 const value=await page.evaluate(async()=>{const {mathRenderer,mathAtom}=await import('/web/modules/math.js');const a=mathAtom('x'),element=document.createElement('span');document.body.append(element);const view=mathRenderer().mount(element,{type:'editac.math',version:1,kind:'inline-atom',text:a.text,attributes:a.attributes['module:editac.math'][1]});view.dispose();await import('/web/modules/math-renderer.js');await Promise.resolve();const empty=element.childNodes.length===0;element.remove();return empty;});assert.equal(value,true);
},{bytes:bytes.inline,disabled:true}));
test('prepared peer math update cancels older content and survives disabled recovery',()=>probe('peer-source',async(page,fact)=>{
 await page.waitForFunction(()=>document.querySelector('[data-math-module]')?.dataset.mathState==='rendered');
 const remote=new Y.Doc({gc:false});remote.clientID=73;Y.applyUpdate(remote,new Uint8Array(bytes.inline));const vector=Y.encodeStateVector(remote),text=remote.getMap('registry-texts').get('n:11:1');remote.transact(()=>{text.delete(0,text.length);text.insert(0,'LaTeX source: '+corpus.cases.find(c=>c.name==='invalid').latex,{'module:editac.math':[1,{latex:corpus.cases.find(c=>c.name==='invalid').latex,display:false}]});});const update=[...Y.encodeStateAsUpdate(remote,vector)];remote.destroy();
 await page.evaluate(update=>window.inputFixture.applyUpdate(update),update);await page.waitForFunction(()=>document.querySelector('[data-math-module]')?.dataset.mathState==='source');const s=await state(page,fact);assert.match(s.text,/\\frac\{/);assert.equal(await page.locator('math').count(),0);await page.evaluate(()=>window.inputFixture.reopen(true));assert.deepEqual((await state(page,fact)).nodes,s.nodes);
},{bytes:bytes.inline}));

test('pending preview update cannot paint an older source',()=>probe('pending-update',async(page,fact)=>{
 const value=await page.evaluate(async()=>{const {mathRenderer,mathAtom}=await import('/web/modules/math.js');const element=document.createElement('span');document.body.append(element);const content=s=>{const a=mathAtom(s);return{type:'editac.math',version:1,kind:'inline-atom',text:a.text,attributes:a.attributes['module:editac.math'][1]};};const view=mathRenderer().mount(element,content('x'));view.update(content(String.raw`\href{https://external.invalid}{stale}`));await import('/web/modules/math-renderer.js');await Promise.resolve();const result={state:element.dataset.mathState,math:element.querySelectorAll('math').length};view.dispose();element.remove();return result;});fact.snapshots.push(value);assert.deepEqual(value,{state:'source',math:0});
},{bytes:bytes.inline,disabled:true}));
test('decoration changes stay ephemeral while canonical mutations and forged attributes retain input ownership',()=>probe('mutation-ownership',async(page,fact)=>{
 await page.waitForFunction(()=>document.querySelector('[data-math-module]')?.dataset.mathState==='rendered');const before=await state(page,fact);assert.equal(before.journal.length,0);
 await page.evaluate(()=>{const f=window.inputFixture,text=f.root.querySelector('[data-node-id="n:11:2"] strong').firstChild;text.data+='native';});const changed=await state(page,fact);assert.equal(changed.nodes.find(n=>n.id==='n:11:2').runs.map(r=>r.text).join(''),'cאבdnative');assert.equal(changed.journal.length,1);
 const result=await page.evaluate(async()=>{const f=window.inputFixture,spoof=document.createElement('span');spoof.dataset.moduleView='';spoof.textContent='forged';f.root.querySelector('[data-node-id="n:11:2"] p').append(spoof);await f.settle();return{recovery:f.surface.recovery,exists:spoof.isConnected};});fact.snapshots.push(result);assert.ok(result.recovery.some(r=>r.reason==='unsupported-native-structure'));assert.equal(result.exists,false);assert.deepEqual((await state(page,fact)).nodes,changed.nodes);
},{bytes:bytes.inline}));
