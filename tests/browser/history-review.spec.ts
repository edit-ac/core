import assert from 'node:assert/strict';
import { test } from 'node:test';
import { browserHarness } from './browser-harness.ts';
const { probe } = browserHarness('history-review', 'fixtures/browser-history-review', { autoMount: false });
async function mount(page, options={}) { await page.waitForFunction(()=>!!window.historyFixture); return page.evaluate(options=>window.historyFixture.mount(options),options); }
const snapshot=page=>page.evaluate(()=>window.historyFixture.snapshot());
const texts=s=>s.visible.map(n=>n.runs.map(r=>r.text).join(''));
const inspect=page=>page.getByRole('button',{name:'Inspect Initial revision',exact:true}).click();
const preview=page=>page.getByRole('button',{name:'Preview restore as new edit',exact:true}).click();
const apply=page=>page.getByRole('button',{name:'Apply restore as new edit',exact:true}).click();

test('historical inspection is immutable and never rewinds live replica or history',()=>probe('immutable-inspection',async(page,fact)=>{
  await mount(page);const before=await snapshot(page);const history=await page.evaluate(()=>window.historyFixture.history());const patches=await page.evaluate(()=>window.historyFixture.patches.length);
  await inspect(page);assert.match(await page.getByRole('region',{name:'Readonly historical inspection'}).innerText(),/alpha.*old/s);
  assert.match(await page.getByRole('region',{name:'Readonly historical inspection'}).innerText(),/original source spelling is not retained/);
  assert.equal(await page.getByRole('region',{name:'Readonly historical inspection'}).locator('button,input,textarea,[contenteditable]').count(),0);
  assert.deepEqual(await snapshot(page),before);assert.deepEqual(await page.evaluate(()=>window.historyFixture.history()),history);assert.equal(await page.evaluate(()=>window.historyFixture.patches.length),patches);
  const read=await page.evaluate(()=>{const r=window.historyFixture.read().revision;return {frozen:Object.isFrozen(r.snapshot.visible[0].runs),write:Reflect.set(r.snapshot.visible[0].runs[0],'text','tampered'),again:window.historyFixture.read().revision.snapshot.visible[0].runs[0].text};});assert.equal(read.frozen,true);assert.equal(read.write,false);assert.match(read.again,/alpha/);fact.snapshots.push({live:before,history,read});
}));
test('preview is detached and application creates a durable new edit preserving identities',()=>probe('restore-new-edit',async(page,fact)=>{
  await mount(page);const before=await snapshot(page);await inspect(page);await preview(page);assert.deepEqual(await snapshot(page),before);assert.match(await page.getByRole('status').innerText(),/revalidated/);
  await apply(page);assert.match(await page.getByRole('status').innerText(),/Restored as a new edit/);const after=await snapshot(page);assert.deepEqual(texts(after),['alpha 🙂\r\nold','independent']);assert.deepEqual(after.visible.map(n=>n.id),before.visible.map(n=>n.id));assert.ok(after.revision>before.revision);
  const disk=await page.evaluate(()=>window.historyFixture.flush());assert.equal(disk.state.pending,0);assert.equal(disk.state.saved,true);assert.ok(disk.entries.some(e=>e.origin==='editac:local:history-restore'));assert.ok(await page.evaluate(()=>window.historyFixture.patches.some(p=>p.origin==='editac:local:history-restore'&&p.update)));
  const recovered=await page.evaluate(()=>window.historyFixture.reopen());assert.deepEqual(texts(recovered),texts(after));assert.deepEqual(recovered.visible.map(n=>n.id),after.visible.map(n=>n.id));fact.snapshots.push({before,after,origins:disk.entries.map(e=>e.origin),recovered});
}));
test('restoration is one isolated undo group and redo is a new current edit',()=>probe('restore-history-policy',async(page)=>{
  await mount(page);await inspect(page);await preview(page);await apply(page);const restored=await snapshot(page);await page.evaluate(()=>window.historyFixture.history('undo'));assert.equal(texts(await snapshot(page))[0],'current beta');await page.evaluate(()=>window.historyFixture.history('redo'));assert.deepEqual(texts(await snapshot(page)),texts(restored));await page.evaluate(()=>window.historyFixture.flush());
}));
for(const [name,value] of [['peer-content','peer changed'],['peer-deletion','']])test(`${name} after preview conflicts visibly and preserves remote state`,()=>probe(name,async(page,fact)=>{
  await mount(page);await inspect(page);await preview(page);const remote=await page.evaluate(text=>window.historyFixture.remote(text),value);const before=await snapshot(page);assert.equal(texts(before)[0],value);assert.deepEqual(texts(remote.peer),texts(before));
  await apply(page);assert.match(await page.getByRole('status').innerText(),/Restore conflict: stale/);assert.deepEqual(await snapshot(page),before);const recovery=await page.getByRole('region',{name:'Restore as new edit'}).innerText();for(const word of ['base','current','proposed'])assert.ok(recovery.includes(word));fact.snapshots.push(remote);
}));
test('refreshing preview after peer edit safely applies against latest observed state',()=>probe('peer-repreview',async(page)=>{
  await mount(page);await inspect(page);await preview(page);await page.evaluate(()=>window.historyFixture.remote('remote'));await apply(page);await page.evaluate(()=>window.historyFixture.inspect());await preview(page);await apply(page);assert.match(await page.getByRole('status').innerText(),/Restored as a new edit/);assert.deepEqual(texts(await snapshot(page)),['alpha 🙂\r\nold','independent']);
}));
test('unknown attribution is retained and a capture label never authenticates an author',()=>probe('unknown-attribution',async(page)=>{
  await mount(page,{label:'Alice <img src=x onerror=alert(1)>',provenance:{origin:'agent'}});await page.evaluate(()=>window.historyFixture.inspect());const value=await page.getByRole('region',{name:'Readonly historical inspection'}).innerText();assert.match(value,/Unknown \/ unverified attribution/);assert.match(value,/origin agent/);assert.equal(await page.locator('#review img').count(),0);
}));
test('authenticated host provenance is distinct from local generation and source representation',()=>probe('trusted-provenance',async(page)=>{
  await mount(page,{provenance:{origin:'human',authenticatedAuthor:'Host Alice'}});await inspect(page);const value=await page.getByRole('region',{name:'Readonly historical inspection'}).innerText();assert.match(value,/Authenticated host attribution: Host Alice/);assert.match(value,/not a global order/);assert.match(value,/semantic projection/);assert.match(value,/SHA-256 [a-f0-9]{64}/);
}));
test('pruned and missing revisions stay unavailable instead of falling back to current',()=>probe('pruned-missing',async(page)=>{
  await mount(page,{limits:{maxRevisions:1}});const before=await snapshot(page);await page.evaluate(()=>window.historyFixture.capture('Second'));await page.evaluate(()=>window.historyFixture.inspect());assert.match(await page.getByRole('status').innerText(),/unavailable: pruned/);assert.equal(await page.getByRole('region',{name:'Readonly historical inspection'}).innerText(),'');await page.evaluate(()=>window.historyFixture.inspect('not-issued'));assert.match(await page.getByRole('status').innerText(),/unavailable: missing/);assert.deepEqual(await snapshot(page),before);
}));
for(const reason of ['key-unavailable','incompatible'])test(`${reason} remains explicit and does not mutate or expose snapshot`,()=>probe(reason,async(page)=>{
  await mount(page,{keyProfile:'key-one'});const before=await snapshot(page);await page.evaluate(reason=>{if(reason==='key-unavailable')window.historyFixture.key('rotated');else window.historyFixture.scope('schema-next');window.historyFixture.inspect();},reason);assert.match(await page.getByRole('status').innerText(),new RegExp(`unavailable: ${reason}`));assert.equal(await page.getByRole('region',{name:'Readonly historical inspection'}).innerText(),'');assert.equal(await page.getByRole('button',{name:'Preview restore as new edit'}).count(),0);assert.deepEqual(await snapshot(page),before);
}));
test('retention loss after preview rejects application and retains recovery',()=>probe('pruned-preview',async(page)=>{
  await mount(page,{limits:{maxRevisions:1}});await inspect(page);await preview(page);await page.evaluate(()=>window.historyFixture.capture('Second'));const before=await snapshot(page);await apply(page);assert.match(await page.getByRole('status').innerText(),/conflict: unavailable/);assert.deepEqual(await snapshot(page),before);
}));
test('readonly history has no mutation controls and policy changes reject pending restore',()=>probe('readonly-policy',async(page)=>{
  await mount(page,{writable:false});await inspect(page);assert.equal(await page.getByRole('region',{name:'Restore as new edit'}).locator('button').count(),0);
  await mount(page);await inspect(page);await preview(page);await page.evaluate(()=>window.historyFixture.readonly());const before=await snapshot(page);await apply(page);assert.match(await page.getByRole('status').innerText(),/conflict: readonly/);assert.deepEqual(await snapshot(page),before);
}));
test('marked or unsupported structural restoration conflicts without hiding data',()=>probe('no-loss-unsupported',async(page)=>{
  await mount(page);await page.evaluate(()=>window.historyFixture.mark());const before=await snapshot(page);await inspect(page);await preview(page);assert.match(await page.getByRole('status').innerText(),/conflict: unsupported/);assert.deepEqual(await snapshot(page),before);assert.match(await page.getByRole('region',{name:'Restore as new edit'}).innerText(),/bold/);
  await mount(page);await page.evaluate(()=>{const e=window.historyFixture.engine,n=e.read().visible[0],a=e.anchor(n.id,3,'right');try{const p=e.prepare({kind:'editor',origin:'editac:local:fixture',commands:[{type:'split',owner:n.id,at:a}]});try{e.commit(p);}finally{e.releasePlan(p);}}finally{e.releaseAnchor(a);}});const split=await snapshot(page);await inspect(page);await preview(page);assert.match(await page.getByRole('status').innerText(),/conflict: unsupported/);assert.deepEqual(await snapshot(page),split);
}));
test('forged or reused previews cannot apply and unchanged restore does not emit updates',()=>probe('preview-ownership',async(page)=>{
  await mount(page,{edit:false});const result=await page.evaluate(()=>{const f=window.historyFixture;const p=f.restorer.preview(f.old);const before=f.patches.length;const forged=f.restorer.apply(structuredClone(p));const first=f.restorer.apply(p),second=f.restorer.apply(p);return {forged,first,second,before,after:f.patches.length};});assert.equal(result.forged.reason,'stale');assert.equal(result.first.kind,'unchanged');assert.equal(result.second.reason,'stale');assert.equal(result.before,result.after);
}));
test('history hash binds detached projection and bounded metadata before eviction',()=>probe('hash-bounds',async(page,fact)=>{
  await mount(page);const result=await page.evaluate(async()=>{const f=window.historyFixture,r=f.read().revision,{hash,handle,...body}=r;const bytes=new TextEncoder().encode(JSON.stringify(body));const actual=[...new Uint8Array(await crypto.subtle.digest('SHA-256',bytes))].map(b=>b.toString(16).padStart(2,'0')).join('');let rejected=false;try{await f.capture('x'.repeat(1024*1024));}catch{rejected=true;}return {hash,actual,rejected,available:f.read().kind,usage:f.store.usage};});assert.equal(result.hash,result.actual);assert.equal(result.rejected,true);assert.equal(result.available,'available');assert.equal(result.usage.revisions,1);fact.snapshots.push(result);
}));
test('captures detach before async hashing and are absent from ordinary typing',()=>probe('capture-boundary',async(page)=>{
  await mount(page,{edit:false});const result=await page.evaluate(async()=>{const f=window.historyFixture;const pending=f.capture('Async snapshot');await f.edit('after capture');const handle=await pending;return {historical:f.read(handle).revision.snapshot,current:f.snapshot(),usage:f.store.usage};});assert.equal(texts(result.historical)[0],'alpha 🙂\r\nold');assert.equal(texts(result.current)[0],'after capture');assert.equal(result.usage.revisions,2);
}));
test('bounded list and clipped inspection retain honest labels with native keyboard access',()=>probe('bounded-accessible',async(page,fact)=>{
  await mount(page,{text:'x'.repeat(10000),maxValueChars:200,pageSize:3});await page.evaluate(async()=>{for(let i=0;i<7;i++)await window.historyFixture.capture(`revision ${i}`);});assert.equal(await page.getByRole('button',{name:/^Inspect /}).count(),3);assert.match(await page.getByRole('region',{name:'Revision history'}).innerText(),/Page 1 of 3; 8 retained revisions/);
  const initial=page.getByRole('button',{name:'Inspect Initial revision',exact:true});await initial.focus();await initial.press('Enter');assert.match(await page.getByRole('region',{name:'Readonly historical inspection'}).innerText(),/Display truncated/);assert.ok((await page.getByRole('region',{name:'Readonly historical inspection'}).innerText()).length<1000);
  await page.getByRole('button',{name:'Next revisions',exact:true}).click();await page.getByRole('button',{name:'Next revisions',exact:true}).click();assert.equal(await page.getByRole('button',{name:/^Inspect /}).count(),2);assert.equal(await page.getByRole('button',{name:'Next revisions',exact:true}).isDisabled(),true);fact.snapshots.push({buttons:await page.locator('button').allTextContents()});
}));
test('destroy and repeated mount remove historical controller without retaining controls',()=>probe('dispose-history',async(page)=>{
  await mount(page);await inspect(page);await preview(page);await page.evaluate(()=>window.historyFixture.destroy());assert.equal(await page.locator('#review').innerText(),'');await mount(page);assert.equal(await page.getByRole('region',{name:'Revision history'}).count(),1);
}));

test('an intervening host callback cannot bypass Rust revision-bound plan admission',()=>probe('prepared-plan-race',async(page)=>{
  await mount(page);await inspect(page);await preview(page);await page.evaluate(()=>window.historyFixture.interfere());await apply(page);assert.match(await page.getByRole('status').innerText(),/conflict: rejected/);assert.equal(texts(await snapshot(page))[0],'intervening callback edit');
}));
