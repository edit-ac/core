import assert from 'node:assert/strict';
import {test} from 'node:test';
import {browserHarness} from './browser-harness.ts';
const {probe,facts}=browserHarness('assistive-dictation','fixtures/browser-assistive-dictation',{
 markdown:true,assertSourcesUnchanged:true,sourcePaths:[
 'packages/core/src/extensions/assistive-input.ts','packages/core/src/extensions/assistive-input-session.ts','packages/core/src/extensions/index.ts',
 'packages/web/src/modules/assistive-input.ts','packages/web/src/dom/selection.ts','packages/web/src/input/keyboard.ts',
 'packages/core/dist/extensions/assistive-input-session.js','packages/web/dist/modules/assistive-input.js',
 'fixtures/browser-assistive-dictation/session.mjs','fixtures/browser-assistive-dictation/mock-transport.mjs','fixtures/browser-assistive-dictation/index.html',
 'contracts/assistive-input-v1.md','packages/core/dist/wasm/editac_wasm_bg.wasm']});
facts.binding={gate:'AIN-1.3',profile:'editac-assistive-input-v1',scope:'Installed production BrowserEditor/Session/WASM/IndexedDB/history/stable anchors; prepared events/transcripts and malicious late mock callbacks. No microphone/provider/OS/IME/AT/device/performance qualification.'};
async function state(page,fact){const s=await page.evaluate(()=>window.inputFixture.state());fact.snapshots.push(s);assert.deepEqual(s.errors,[]);return s;}
async function start(page,a=1,b=4){await page.evaluate(({a,b})=>{const f=window.inputFixture;f.select(f.ids[0],a,b);f.start();},{a,b});}
async function emit(page,text='X',sequence=0,kind='final',index){await page.evaluate(({text,sequence,kind,index})=>window.mockTransport.result(text,sequence,kind,index),{text,sequence,kind,index});}
function unchanged(a,b,selection=true){for(const k of ['nodes','revision','history','journal','commands','patches',...(selection?['selection']:[])])assert.deepEqual(b[k],a[k],k);}
function cleaned(s){for(const t of s.transport){assert.equal(t.aborted,true);assert.equal(t.cancelled,1);assert.equal(t.disposed,1);assert.deepEqual(t.requestKeys,['version','session']);}}
function committed(s,text,offset){assert.equal(s.text[0],text);assert.equal(s.history.undoGroups,1);assert.equal(s.commands.filter(c=>c.origin==='assistive:final').length,1);assert.equal(s.journal.filter(o=>o==='editac:local:assistive:final').length,1);assert.equal(s.patches.filter(p=>p.origin==='editac:local:assistive:final'&&p.update).length,1);assert.equal(s.selection.focus.offset,offset);assert.equal(s.lifecycle.state,'completed');cleaned(s);}

test('provisional is bounded UI only; ordered final commits once with exact origin/history/selection',()=>probe('ordered-final',async(page,fact)=>{
 await start(page);const before=await state(page,fact);await emit(page,'private interim',0,'provisional');let s=await state(page,fact);unchanged(before,s);assert.equal(s.lifecycle.provisional,'private interim');assert.equal(await page.locator('[data-assistive-preview]').textContent(),'Uncommitted assistance preview: private interim');assert.equal(await page.locator('[data-assistive-preview]').getAttribute('aria-live'),'off');assert.ok(!(await page.locator('[role=status]').allTextContents()).join('').includes('private interim'));
 await emit(page,'ignored old',0);await emit(page,'X',1);s=await state(page,fact);committed(s,'aXa',2);
 await emit(page,'duplicate',1);await emit(page,'later',2);unchanged(s,await state(page,fact));
}));

test('captured target survives caret movement and remote rebase; selective undo/redo preserves peer text',()=>probe('remote-history',async(page,fact)=>{
 await start(page);await page.evaluate(async()=>{const f=window.inputFixture;await f.remote(0,'R');f.select(f.ids[0],6);});await emit(page);let s=await state(page,fact);committed(s,'RaXa',3);
 await page.keyboard.press('ControlOrMeta+z');s=await state(page,fact);assert.equal(s.text[0],'Ralpha');assert.equal(s.history.redoGroups,1);
 await page.keyboard.press('ControlOrMeta+Shift+z');s=await state(page,fact);assert.equal(s.text[0],'RaXa');
}));

for(const [name,text,a,b,replacement,expected] of [
 ['surrogate','a😀b',1,3,'🧑‍💻','a🧑‍💻b'],['combining','aéb',1,3,'é','aéb'],['zwj','a👩‍💻b',1,6,'X','aXb'],['flag','a🇭🇺b',1,5,'X','aXb'],['rtl','aאבb',1,3,'גד','aגדb']
])test(`UTF-16 ${name} replacement uses engine offsets`,()=>probe('utf16-'+name,async(page,fact)=>{await start(page,a,b);await emit(page,replacement);committed(await state(page,fact),expected,a+replacement.length);},{text}));

for(const mode of ['cancel','blur','read-only','permission','registration'])test(`${mode} revokes acceptance before hostile late result`,()=>probe('revoke-'+mode,async(page,fact)=>{
 await start(page);await page.evaluate(mode=>{const f=window.inputFixture;if(mode==='cancel'){f.surface.assistive.session.cancel();f.surface.assistive.session.cancel();}if(mode==='blur'){const input=document.createElement('input');document.body.append(input);input.focus();}if(mode==='read-only')window.editor.setReadOnly(true);if(mode==='permission')window.commandPermission=false;if(mode==='registration')window.assistiveRegistration.dispose();},mode);
 const before=await state(page,fact);await emit(page);const after=await state(page,fact);unchanged(before,after,false);assert.equal(after.text[0],'alpha');cleaned(after);
}));

test('deleted captured text becomes stale with explicit bounded recovery; never redirects',()=>probe('deleted-range',async(page,fact)=>{
 await start(page);await page.evaluate(()=>window.inputFixture.remoteDelete(1,4));const before=await state(page,fact);await emit(page,'recover me');const s=await state(page,fact);unchanged(before,s,false);assert.equal(s.lifecycle.state,'stale');assert.equal(s.recoveryText,'recover me');cleaned(s);
 await page.evaluate(()=>window.editor.assistive.session.reset());await emit(page,'late',1);unchanged(s,await state(page,fact),false);
}));

test('deleted owner is never replaced by current owner after structural join',()=>probe('deleted-owner',async(page,fact)=>{
 await page.evaluate(()=>{const f=window.inputFixture;f.select(f.ids[1],0,4);f.start();f.session.storage.commit({kind:'editor',origin:'prepared-delete-owner',commands:[{type:'join',first:f.ids[0],second:f.ids[1]}]});});
 const before=await state(page,fact);await emit(page);const s=await state(page,fact);unchanged(before,s,false);assert.equal(s.lifecycle.state,'stale');cleaned(s);
}));

test('new generation rejects prior callback and mismatched session identity',()=>probe('generation',async(page,fact)=>{
 await start(page);await page.evaluate(()=>window.editor.assistive.session.cancel());await start(page,0,1);const before=await state(page,fact);await emit(page,'old',0,'final',0);
 await page.evaluate(()=>window.mockTransport.result('wrong',0,'final',1,{sessionId:'foreign',generation:2}));unchanged(before,await state(page,fact));await emit(page,'Z',0,'final',1);committed(await state(page,fact),'Zlpha',1);
}));

for(const reason of ['permission-denied','unavailable','disconnected'])test(`typed ${reason} error is nonmutating and cleans up`,()=>probe('error-'+reason,async(page,fact)=>{await start(page);const before=await state(page,fact);await page.evaluate(reason=>window.mockTransport.error(reason),reason);const s=await state(page,fact);unchanged(before,s);assert.equal(s.lifecycle.reason,reason);assert.equal(s.lifecycle.state,'failed');cleaned(s);await emit(page);unchanged(s,await state(page,fact));}));
for(const mode of ['oversized','malformed'])test(`${mode} result rejects atomically`,()=>probe('invalid-'+mode,async(page,fact)=>{await start(page);const before=await state(page,fact);await page.evaluate(mode=>{const t=window.mockTransport;if(mode==='oversized')t.result('x'.repeat(1025));else t.sessions[0].emit({type:'result',result:{version:99}});},mode);const s=await state(page,fact);unchanged(before,s);assert.equal(s.lifecycle.reason,mode);cleaned(s);}));

test('stop asks host for one final result and synchronous start completion releases returned handle',()=>probe('stop-final',async(page,fact)=>{await start(page);await page.evaluate(()=>window.editor.assistive.session.stop());assert.equal((await state(page,fact)).transport[0].stopped,1);await emit(page);committed(await state(page,fact),'aXa',2);}));
test('synchronous transport final is accepted once and immediately disposed',()=>probe('sync-final',async(page,fact)=>{await start(page);committed(await state(page,fact),'aXa',2);await emit(page,'late');committed(await state(page,fact),'aXa',2);},{text:'alpha',synchronous:'X'}));
test('post-commit persistence callback failure consumes final without replay',()=>probe('after-commit-error',async(page,fact)=>{await start(page);await page.evaluate(()=>window.failAfterCommit=true);await emit(page);const s=await state(page,fact);committed(s,'aXa',2);await emit(page,'again',1);unchanged(s,await state(page,fact));}));

for(const mode of ['missing-beforeinput','noncancelable-beforeinput','composition'])test(`prepared OS ${mode} keeps existing reconciliation and excludes transport commit`,()=>probe('os-'+mode,async(page,fact)=>{
 await start(page,5,5);await page.evaluate(async mode=>{const f=window.inputFixture,block=f.root.querySelector('[data-node-id]');
  if(mode==='composition')f.event('compositionstart',{data:''});
  if(mode==='noncancelable-beforeinput')f.event('beforeinput',{inputType:'insertText',data:'字',cancelable:false});
  block.textContent='alpha字';const node=block.firstChild;document.getSelection().setBaseAndExtent(node,6,node,6);
  if(mode==='composition'){f.event('compositionupdate',{data:'字'});f.event('input',{inputType:'insertCompositionText',data:'字',isComposing:true});f.event('compositionend',{data:'字'});}
  else f.event('input',{inputType:'insertText',data:'字'});
  await f.settle();
 },mode);await emit(page,'DUPLICATE');const s=await state(page,fact);assert.equal(s.text[0],'alpha字');assert.equal(s.history.undoGroups,1);assert.equal(s.commands.filter(c=>c.origin==='assistive:final').length,0);cleaned(s);
}));

test('destroy and document/epoch replacement make late callbacks inert in both engines',()=>probe('document-epoch-destroy',async(page,fact)=>{
 await start(page);await page.evaluate(async()=>{const f=window.inputFixture;await f.second();window.beforeSecond=f.others[0].session.writer.engine.read();window.beforeAudit=f.audit();await f.disposeSurface();});
 await emit(page,'late');await page.evaluate(()=>{const f=window.inputFixture;window.afterSecond=f.others[0].session.writer.engine.read();});assert.deepEqual(await page.evaluate(()=>window.afterSecond),await page.evaluate(()=>window.beforeSecond));assert.deepEqual(await page.evaluate(()=>window.inputFixture.audit()),await page.evaluate(()=>window.beforeAudit));
 const audit=await page.evaluate(()=>window.mockTransport.audit());assert.equal(audit[0].aborted,true);assert.equal(audit[0].disposed,1);
}));

test('denied start and absent host capability construct no transport or edits',()=>probe('denied-start',async(page,fact)=>{await page.evaluate(()=>window.commandPermission=false);const before=await state(page,fact);await start(page);const s=await state(page,fact);unchanged(before,s,false);assert.equal(s.transport.length,0);}));
test('status-only descriptor preserves ordinary input without installing transport',()=>probe('no-host',async(page,fact)=>{const before=await state(page,fact);await start(page);const s=await state(page,fact);unchanged(before,s,false);assert.equal(s.transport.length,0);assert.equal(await page.getByRole('button',{name:'Start assistance',exact:true}).count(),0);},{text:'alpha',statusOnly:true}));
test('timeout revokes and releases transport; result after deadline cannot edit',()=>probe('timeout',async(page,fact)=>{await start(page);await page.waitForFunction(()=>window.editor.assistive.session.status.reason==='timeout');const before=await state(page,fact);await emit(page);const s=await state(page,fact);unchanged(before,s);cleaned(s);},{text:'alpha',timeoutMs:30}));

test('registration-wide session cap rejects a competing session without host work',()=>probe('session-cap',async(page,fact)=>{
 await start(page);const before=await state(page,fact);const denied=await page.evaluate(()=>window.inputFixture.competing());assert.equal(denied.status.reason,'unavailable');assert.equal(denied.disposed,1);unchanged(before,await state(page,fact));assert.equal((await state(page,fact)).transport.length,1);await emit(page);committed(await state(page,fact),'aXa',2);await page.evaluate(()=>window.competingSession.dispose());
}));
test('reentrant final during preparation and cleanup cannot duplicate the commit',()=>probe('reentrant-final',async(page,fact)=>{
 await start(page);await page.evaluate(()=>{const f=window.inputFixture;const original=f.session.storage.commit.bind(f.session.storage);f.session.storage.commit=request=>{window.mockTransport.result('reentrant',1);return original(request);};const item=window.mockTransport.sessions[0];item.signal.addEventListener('abort',()=>window.mockTransport.result('abort reentry',2));});await emit(page);committed(await state(page,fact),'aXa',2);
}));
test('pre-commit storage rejection is nonmutating, stale and explicitly recoverable',()=>probe('pre-commit-error',async(page,fact)=>{
 await start(page);await page.evaluate(()=>window.rejectCommand=true);const before=await state(page,fact);await emit(page,'retry text');const s=await state(page,fact);for(const key of ['nodes','revision','history','journal','patches','selection'])assert.deepEqual(s[key],before[key],key);assert.equal(s.commands.length,before.commands.length+1);assert.equal(s.lifecycle.state,'stale');assert.equal(s.recoveryText,'retry text');cleaned(s);await emit(page,'duplicate',1);unchanged(s,await state(page,fact));
}));
test('unsupported stop cancels safely and never pretends host completion',()=>probe('unsupported-stop',async(page,fact)=>{await start(page);const before=await state(page,fact);await page.evaluate(()=>window.editor.assistive.session.stop());const s=await state(page,fact);unchanged(before,s);assert.equal(s.lifecycle.reason,'unsupported');assert.equal(s.transport[0].stopped,0);cleaned(s);},{text:'alpha',noStop:true}));
for(const mode of ['readOnly','composition'])test(`initial ${mode} starts no host work`,()=>probe('initial-'+mode,async(page,fact)=>{if(mode==='composition')await page.evaluate(()=>window.inputFixture.event('compositionstart',{data:''}));const before=await state(page,fact);await start(page);const s=await state(page,fact);unchanged(before,s,false);assert.equal(s.transport.length,0);},{text:'alpha',readOnly:mode==='readOnly'}));
test('committed text persists through production checkpoint/recovery',()=>probe('persisted-final',async(page,fact)=>{await start(page);await emit(page);committed(await state(page,fact),'aXa',2);const nodes=await page.evaluate(()=>window.inputFixture.reopen());assert.equal(nodes[0].runs.map(r=>r.text).join(''),'aXa');}));
test('named keyboard controls start/stop/cancel/recover without printable shortcuts',()=>probe('keyboard-lifecycle',async(page,fact)=>{
 await page.evaluate(()=>{const f=window.inputFixture;f.select(f.ids[0],1,4);f.surface.assistive.show();});
 const startControl=page.getByRole('button',{name:'Start assistance',exact:true});await startControl.focus();await page.keyboard.press('Enter');let s=await state(page,fact);assert.equal(s.lifecycle.state,'active');
 await page.getByRole('button',{name:'Stop assistance',exact:true}).focus();await page.keyboard.press('Enter');assert.equal((await state(page,fact)).transport[0].stopped,1);
 await page.getByRole('button',{name:'Cancel assistance',exact:true}).focus();await page.keyboard.press('Enter');s=await state(page,fact);assert.equal(s.lifecycle.state,'cancelled');assert.equal(s.history.undoGroups,0);cleaned(s);
 await page.getByRole('button',{name:'Recover assistance',exact:true}).focus();await page.keyboard.press('Enter');assert.equal((await state(page,fact)).lifecycle.state,'idle');
}));

test('abort cleanup cannot reenter start; explicit restart works after release',()=>probe('cleanup-reentry',async(page,fact)=>{await start(page);await page.evaluate(()=>{const f=window.inputFixture;window.mockTransport.sessions[0].signal.addEventListener('abort',()=>f.start());f.surface.assistive.session.cancel();});let s=await state(page,fact);assert.equal(s.transport.length,1);cleaned(s);await start(page);await emit(page);s=await state(page,fact);committed(s,'aXa',2);}));
test('stale recovery is visible only on explicit action and never inserted automatically',()=>probe('explicit-recovery',async(page,fact)=>{await start(page);await page.evaluate(()=>window.inputFixture.remoteDelete(1,4));await emit(page,'saved recovery');let s=await state(page,fact);assert.equal(s.recoveryText,'saved recovery');assert.equal(await page.locator('[data-assistive-preview]').isHidden(),true);const before=s;await page.evaluate(()=>window.editor.assistive.show());await page.getByRole('button',{name:'Recover assistance',exact:true}).click();s=await state(page,fact);unchanged(before,s,false);assert.equal(await page.locator('[data-assistive-preview]').textContent(),'Uncommitted recovery text: saved recovery');assert.equal(s.recoveryText,'');await emit(page,'late',1);unchanged(s,await state(page,fact),false);}));

for(const backwards of [false,true])test(`shared cross-block replacement preserves ${backwards?'backward':'forward'} captured target`,()=>probe('cross-block-'+backwards,async(page,fact)=>{
 await page.evaluate(backwards=>{const f=window.inputFixture,blocks=f.root.querySelectorAll('[data-node-id]'),point=(block,at)=>{const walker=document.createTreeWalker(block,NodeFilter.SHOW_TEXT);return [walker.nextNode(),at];},a=point(blocks[0],2),b=point(blocks[1],3);f.root.focus();document.getSelection().setBaseAndExtent(...(backwards?b:a),...(backwards?a:b));f.start();},backwards);
 await emit(page);const s=await state(page,fact);committed(s,'alXependent',3);assert.equal(s.text.length,1);
 await page.keyboard.press('ControlOrMeta+z');assert.deepEqual((await state(page,fact)).text,['alpha','independent']);
}));
test('collapsed captured caret rebases past peer insertion at the same point without deleting peer text',()=>probe('collapsed-peer',async(page,fact)=>{await start(page,2,2);await page.evaluate(()=>window.inputFixture.remote(2,'R'));await emit(page);committed(await state(page,fact),'alRXpha',4);}));
test('empty final replaces only the captured selection with one history group',()=>probe('empty-final',async(page,fact)=>{await start(page);await emit(page,'');committed(await state(page,fact),'aa',1);}));

test('start while active releases the new target without replacing the accepted session',()=>probe('active-start',async(page,fact)=>{await start(page);const before=await state(page,fact);const disposed=await page.evaluate(()=>{let disposed=0;window.editor.assistive.session.start({valid(){throw Error('not admitted')},accept(){throw Error('not admitted')},dispose(){disposed++;}});return disposed;});assert.equal(disposed,1);unchanged(before,await state(page,fact));assert.equal((await state(page,fact)).transport.length,1);await emit(page);committed(await state(page,fact),'aXa',2);}));
