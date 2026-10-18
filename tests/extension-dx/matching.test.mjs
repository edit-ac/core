import assert from 'node:assert/strict';
import { test } from 'node:test';
import { resolve, join } from 'node:path';
import { browserHarness } from '../browser/browser-harness.ts';
import { prepareMatchingConsumer } from './matching-consumer.mjs';
const output=resolve(process.env.EDITAC_EXTENSION_DX_OUTPUT);
process.env.EDITAC_MATCHING_OUTPUT=join(output,'browser');
const {probe}=browserHarness('matching',resolve('tests/extension-dx/matching-consumer'),{
 autoMount:false,markdown:false,prepareConsumer:prepareMatchingConsumer,testFile:'tests/extension-dx/matching.test.mjs',assertSourcesUnchanged:true,
 sourcePaths:['packages/web/src/extensions/authoring-metadata.ts','packages/web/src/extensions/spelling-metadata.ts','packages/web/src/modules/slash-metadata.ts','packages/web/src/dom/pattern-text.ts','packages/web/package.json','packages/web/src/extensions/matching.ts','packages/web/src/extensions/authoring.ts','packages/web/src/dom/render.ts','packages/web/src/surface.ts','packages/web/src/index.ts','packages/web/src/services/lifecycle.ts','packages/core/src/links/scope.ts','packages/core/src/links/locator.ts','tests/extension-dx/matching-consumer.mjs','tests/extension-dx/matching-consumer/session.mjs','tests/extension-dx/matching-consumer/public-smoke.ts','scripts/test-extension-dx.mjs'],
 cleanup:page=>page.evaluate(()=>window.configurationFixture?.close()),
});
function check(name,run){test(name,()=>probe(name.replace(/[^a-zA-Z0-9-]/g,'-'),async page=>{await page.waitForFunction(()=>!!window.configurationFixture);await run(page);}));}
check('opening and inspecting literal source makes zero requests',async p=>{
 const r=await p.evaluate(async()=>{const f=window.configurationFixture,m=await f.start();m.editor.read();await f.flush();return{calls:m.calls.length,windows:m.controller.state.windows,text:f.content(m.editor)};});assert.deepEqual(r,{calls:0,windows:0,text:'ASD-123'});
});
check('trusted delimiter input resolves and applies one safe link over unchanged source',async p=>{
 await p.evaluate(async()=>{const f=window.configurationFixture,m=await f.start();f.select(m.editor.root,7);});await p.keyboard.type(' ');
 const pending=await p.evaluate(async()=>{const f=window.configurationFixture;await f.flush();const m=window.matching;return{calls:m.calls.length,text:f.content(m.editor),runs:f.runs(),statuses:m.statuses};});assert.equal(pending.calls,1);assert.equal(pending.text,'ASD-123 ');assert.ok(pending.runs.every(r=>!r.attributes.link));
 const r=await p.evaluate(async()=>{const f=window.configurationFixture,m=window.matching;m.calls[0].resolve({status:'available',href:'https://tasks.example/ASD-123'});await f.flush();return{runs:f.runs(),text:f.content(m.editor),statuses:m.statuses,pending:m.controller.state.pending};});assert.equal(r.runs[0].text,'ASD-123');assert.equal(r.runs[0].attributes.link,'https://tasks.example/ASD-123');assert.equal(r.text,'ASD-123 ');assert.deepEqual(r.statuses,['pending','applied']);assert.equal(r.pending,0);
});
for(const status of ['missing','forbidden','unavailable'])check(`${status} retains exact authored content and creates no history action`,async p=>{
 const r=await p.evaluate(async status=>{const f=window.configurationFixture,m=await f.start();f.insert(m.editor,' ');await f.flush();const before=JSON.stringify(m.editor.read().visible);m.calls[0].resolve({status});await f.flush();const after=JSON.stringify(m.editor.read().visible);f.history('undo');return{same:before===after,text:f.content(m.editor),calls:m.calls.length,status:m.statuses.at(-1)};},status);assert.deepEqual(r,{same:true,text:'ASD-123',calls:1,status});
});
for(const href of ['javascript:alert(1)','data:text/html,x','https://user:secret@tasks.example/','https://tasks.example/'+ 'x'.repeat(2049)])check(`unsafe or oversized URL ${href.slice(0,24)} is inert`,async p=>{
 const r=await p.evaluate(async href=>{const f=window.configurationFixture,m=await f.start();f.insert(m.editor,' ');await f.flush();m.calls[0].resolve({status:'available',href});await f.flush();return{status:m.statuses.at(-1),linked:f.runs().some(r=>r.attributes.link),text:f.content(m.editor)};},href);assert.deepEqual(r,{status:'invalid',linked:false,text:'ASD-123 '});
});
check('resolver rejection retains source and sanitizes private error details',async p=>{
 const r=await p.evaluate(async()=>{const f=window.configurationFixture,m=await f.start();f.insert(m.editor,' ');await f.flush();m.calls[0].reject(Error('private bearer secret'));await f.flush();return{status:m.statuses.at(-1),text:f.content(m.editor),log:JSON.stringify(m.statuses)};});assert.equal(r.status,'failed');assert.equal(r.text,'ASD-123 ');assert.ok(!r.log.includes('secret'));
});
check('unrelated preceding edit rebases stable anchors without invalidating the match',async p=>{
 const r=await p.evaluate(async()=>{const f=window.configurationFixture,m=await f.start();f.insert(m.editor,' ');await f.flush();f.insert(m.editor,'Prefix ',0,'local:unrelated');m.calls[0].resolve({status:'available',href:'https://tasks.example/123'});await f.flush();return{runs:f.runs(),text:f.content(m.editor),status:m.statuses.at(-1)};});assert.equal(r.text,'Prefix ASD-123 ');assert.equal(r.status,'applied');assert.equal(r.runs.find(r=>r.attributes.link)?.text,'ASD-123');
});
check('edited then restored match invalidates intent even when final text is identical',async p=>{
 const r=await p.evaluate(async()=>{const f=window.configurationFixture,m=await f.start();f.insert(m.editor,' ');await f.flush();f.insert(m.editor,'X',2,'local:edit');const n=m.editor.read().visible.find(n=>n.kind==='block'),a=m.editor.anchor(n.id,2,'right'),b=m.editor.anchor(n.id,3,'left');try{m.editor.commit({kind:'text',origin:'local:restore',command:{type:'delete',range:{anchor:a,focus:b}}});}finally{m.editor.releaseAnchor(a);m.editor.releaseAnchor(b);}m.calls[0].resolve({status:'available',href:'https://tasks.example/123'});await f.flush();return{aborted:m.calls[0].signal.aborted,linked:f.runs().some(r=>r.attributes.link),text:f.content(m.editor)};});assert.deepEqual(r,{aborted:true,linked:false,text:'ASD-123 '});
});
check('deleted match cannot receive a late result',async p=>{
 const r=await p.evaluate(async()=>{const f=window.configurationFixture,m=await f.start();f.insert(m.editor,' ');await f.flush();f.select(m.editor.root,0,7);const target=m.editor.captureCommand('replace');target.execute('gone');target.dispose();m.calls[0].resolve({status:'available',href:'https://tasks.example/123'});await f.flush();return{text:f.content(m.editor),linked:f.runs().some(r=>r.attributes.link),aborted:m.calls[0].signal.aborted};});assert.deepEqual(r,{text:'gone ',linked:false,aborted:true});
});
check('manual link wins over pending automatic application',async p=>{
 const r=await p.evaluate(async()=>{const f=window.configurationFixture,m=await f.start();f.insert(m.editor,' ');await f.flush();f.mark(m.editor,'link',0,7);m.calls[0].resolve({status:'available',href:'https://tasks.example/123'});await f.flush();return{href:f.runs()[0].attributes.link,status:m.statuses.at(-1)};});assert.equal(r.href,'https://manual.example/');assert.ok(['stale','cancelled'].includes(r.status));
});
check('out of order responses apply only each current anchored target',async p=>{
 const r=await p.evaluate(async()=>{const f=window.configurationFixture,m=await f.start({text:''});f.insert(m.editor,'ASD-123 XYZ-9 ');await f.flush();const calls=[...m.calls];calls[1].resolve({status:'available',href:'https://tasks.example/XYZ-9'});await f.flush();calls[0].resolve({status:'available',href:'https://tasks.example/ASD-123'});await f.flush();return{queries:calls.map(c=>c.text),links:f.runs().filter(r=>r.attributes.link).map(r=>[r.text,r.attributes.link]),pending:m.controller.state.pending};});assert.deepEqual(r.queries,['ASD-123','XYZ-9']);assert.deepEqual(r.links,[['ASD-123','https://tasks.example/ASD-123'],['XYZ-9','https://tasks.example/XYZ-9']]);assert.equal(r.pending,0);
});
check('duplicate pending matches issue one request and release captures',async p=>{
 const r=await p.evaluate(async()=>{const f=window.configurationFixture,m=await f.start();f.insert(m.editor,' ');await f.flush();f.insert(m.editor,' ',7);await f.flush();const count=m.calls.length;m.calls[0].resolve({status:'missing'});await f.flush();return{count,pending:m.controller.state.pending};});assert.deepEqual(r,{count:1,pending:0});
});
check('concurrency queue and uncooperative timeout cannot create a replacement stampede',async p=>{
 const r=await p.evaluate(async()=>{const f=window.configurationFixture,m=await f.start({text:'',options:{concurrency:1,queue:1,timeoutMs:30}});f.insert(m.editor,'AA-1 BB-2 CC-3 ');await new Promise(r=>setTimeout(r,70));await f.flush();const first={calls:m.calls.length,state:m.controller.state,statuses:[...m.statuses]};f.insert(m.editor,'DD-4 ');await f.flush();const calls=m.calls.length;m.calls[0].resolve({status:'missing'});await f.flush();if(m.calls[1])m.calls[1].resolve({status:'missing'});await f.flush();return{first,calls,final:m.controller.state};});assert.equal(r.first.calls,1);assert.equal(r.first.state.active,1);assert.equal(r.first.state.pending,0);assert.ok(r.first.statuses.includes('saturated'));assert.ok(r.first.statuses.includes('deadline'));assert.equal(r.calls,1);assert.equal(r.final.active,0);
});
check('readonly transition invalidates delayed results even after editing is reenabled',async p=>{
 const r=await p.evaluate(async()=>{const f=window.configurationFixture,m=await f.start();f.insert(m.editor,' ');await f.flush();m.editor.setReadOnly(true);m.editor.setReadOnly(false);m.calls[0].resolve({status:'available',href:'https://tasks.example/123'});await f.flush();return{linked:f.runs().some(r=>r.attributes.link),text:f.content(m.editor)};});assert.deepEqual(r,{linked:false,text:'ASD-123 '});
});
check('principal tenant authority and policy replacement prevent cross scope application',async p=>{
 const r=await p.evaluate(async()=>{const f=window.configurationFixture,m=await f.start();f.insert(m.editor,' ');await f.flush();m.permission={...m.permission,principal:'bob',tenant:'team-b',authority:'other',revision:'2'};m.calls[0].resolve({status:'available',href:'https://tasks.example/123'});await f.flush();f.insert(m.editor,'ASD-123 ',8);await f.flush();return{linked:f.runs().some(r=>r.attributes.link),principals:m.calls.map(c=>[c.principal,c.tenant,c.authority])};});assert.equal(r.linked,false);assert.deepEqual(r.principals,[['alice','team-a','tasks'],['bob','team-b','other']]);
});
check('explicit revocation invalidation aborts and clears cached authorization',async p=>{
 const r=await p.evaluate(async()=>{const f=window.configurationFixture,m=await f.start();f.insert(m.editor,' ');await f.flush();m.permission.lookup=false;m.controller.invalidate();m.calls[0].resolve({status:'available',href:'https://tasks.example/123'});await f.flush();f.insert(m.editor,' ',8);await f.flush();return{calls:m.calls.length,aborted:m.calls[0].signal.aborted,cached:m.controller.state.cached,linked:f.runs().some(r=>r.attributes.link)};});assert.deepEqual(r,{calls:1,aborted:true,cached:0,linked:false});
});
check('instances never share pending work or principal caches',async p=>{
 const r=await p.evaluate(async()=>{const f=window.configurationFixture,a=await f.start(),b=await f.start();f.insert(a.editor,' ');f.insert(b.editor,' ');await f.flush();a.calls[0].resolve({status:'available',href:'https://tasks.example/a'});b.calls[0].resolve({status:'missing'});await f.flush();return{a:a.calls.length,b:b.calls.length,aLinks:a.editor.read().visible[0].runs.some(r=>r.attributes.link),bLinks:b.editor.read().visible[0].runs.some(r=>r.attributes.link)};});assert.deepEqual(r,{a:1,b:1,aLinks:true,bLinks:false});
});
check('disposal aborts requests removes subscriptions and rejects late completion',async p=>{
 const r=await p.evaluate(async()=>{const f=window.configurationFixture,m=await f.start();f.insert(m.editor,' ');await f.flush();const before=m.statuses.length;m.controller.dispose();m.calls[0].resolve({status:'available',href:'https://tasks.example/123'});await f.flush();f.insert(m.editor,' ',8);await f.flush();return{aborted:m.calls[0].signal.aborted,statuses:m.statuses.length===before,pending:m.controller.state.pending,cached:m.controller.state.cached,calls:m.calls.length,linked:f.runs().some(r=>r.attributes.link)};});assert.deepEqual(r,{aborted:true,statuses:true,pending:0,cached:0,calls:1,linked:false});
});
for(const mode of ['ignore','match'])check(`explicit paste ${mode} policy over real clipboard fragment commit`,async p=>{
 const r=await p.evaluate(async mode=>{const f=window.configurationFixture,m=await f.start({text:'plain',options:{paste:mode}});f.select(m.editor.root,0,5);const data=new DataTransfer();data.setData('text/plain','ASD-123 ');m.editor.root.dispatchEvent(window.preparedClipboardEvent('paste',data));await f.flush();return{calls:m.calls.length,text:f.content(m.editor)};},mode);assert.deepEqual(r,{calls:mode==='match'?1:0,text:'ASD-123 '});
});
check('literal bypass and non input origins never invoke matcher or resolver',async p=>{
 const r=await p.evaluate(async()=>{const f=window.configurationFixture,m=await f.start({options:{literal:()=>true}});f.insert(m.editor,' ');f.insert(m.editor,' ',8,'local:inspection');await f.flush();return{calls:m.calls.length,windows:m.controller.state.windows,text:f.content(m.editor)};});assert.deepEqual(r,{calls:0,windows:0,text:'ASD-123  '});
});
check('inline code is excluded before resolver admission',async p=>{
 const r=await p.evaluate(async()=>{const f=window.configurationFixture,m=await f.start();f.mark(m.editor,'code',0,7);f.insert(m.editor,' ');await f.flush();return{calls:m.calls.length,text:f.content(m.editor),code:f.runs()[0].attributes.code};});assert.equal(r.calls,0);assert.equal(r.text,'ASD-123 ');assert.equal(r.code,true);
});
check('bounded windows examine no full document and reject excessive match output',async p=>{
 const r=await p.evaluate(async()=>{const f=window.configurationFixture,seen=[];const m=await f.start({text:'x'.repeat(10000)+' ASD-123',options:{contextUtf16:32,maxMatches:2,match(w){seen.push(w.text.length);return Array.from({length:3},()=>({start:0,end:1,text:w.text[0]}));}}});f.insert(m.editor,' ');await f.flush();return{seen,calls:m.calls.length,state:m.controller.state};});assert.deepEqual(r.seen,[33]);assert.equal(r.calls,0);assert.equal(r.state.windows,1);assert.ok(r.state.examinedRuns<=128);
});
check('delimiter policy avoids partial matches and supports UTF16 source offsets',async p=>{
 const r=await p.evaluate(async()=>{const f=window.configurationFixture,m=await f.start({text:'🙂 ASD-123'});f.insert(m.editor,'x');await f.flush();const initial=m.calls.length;f.insert(m.editor,' ASD-42 ');await f.flush();m.calls[0].resolve({status:'available',href:'https://tasks.example/42'});await f.flush();return{initial,text:f.content(m.editor),linked:f.runs().filter(r=>r.attributes.link).map(r=>r.text)};});assert.deepEqual(r,{initial:0,text:'🙂 ASD-123x ASD-42 ',linked:['ASD-42']});
});
check('prepared application reentrancy rechecks current source and host authority',async p=>{
 const r=await p.evaluate(async()=>{const f=window.configurationFixture;let m;m=await f.start({options:{prepare(a){m.permission.apply=false;return{kind:'format',origin:'local:test',marks:[{range:a.range,mark:'link',action:'apply',href:a.href}],blocks:[]};}}});f.insert(m.editor,' ');await f.flush();m.calls[0].resolve({status:'available',href:'https://tasks.example/123'});await f.flush();return{status:m.statuses.at(-1),linked:f.runs().some(r=>r.attributes.link)};});assert.deepEqual(r,{status:'stale',linked:false});
});
check('one generated history action preserves formatting selection and undo redo without lookup',async p=>{
 const r=await p.evaluate(async()=>{const f=window.configurationFixture,m=await f.start();f.mark(m.editor,'bold',0,7);f.insert(m.editor,' ');await f.flush();f.select(m.editor.root,2,5);m.calls[0].resolve({status:'available',href:'https://tasks.example/123'});await f.flush();const before=f.runs(),selection=document.getSelection().toString();f.history('undo');const undone=f.runs(),undoText=f.content(m.editor);f.history('redo');const redone=f.runs();await f.flush();return{before,selection,undone,redone,undoText,calls:m.calls.length};});assert.equal(r.before[0].attributes.bold,true);assert.equal(r.before[0].attributes.link,'https://tasks.example/123');assert.equal(r.selection,'D-1');assert.ok(r.undone.every(run=>!run.attributes.link));assert.equal(r.undone[0].attributes.bold,true);assert.equal(r.undoText,'ASD-123 ');assert.equal(r.redone[0].attributes.link,'https://tasks.example/123');assert.equal(r.calls,1);
});
check('negative cache is bounded and scoped to permission revision',async p=>{
 const r=await p.evaluate(async()=>{const f=window.configurationFixture,m=await f.start({text:'',options:{cacheEntries:2}});f.insert(m.editor,'AA-1 BB-2 CC-3 ');await f.flush();m.calls.forEach(c=>c.resolve({status:'missing'}));await f.flush();const cached=m.controller.state.cached;f.insert(m.editor,'AA-1 BB-2 CC-3 ');await f.flush();return{cached,calls:m.calls.length};});assert.equal(r.cached,2);assert.equal(r.calls,4);
});
check('invalid resource configuration rejects before any lookup',async p=>{
 const r=await p.evaluate(async()=>{const f=window.configurationFixture,m=await f.start();let rejected=0;for(const options of [{concurrency:9},{queue:33},{contextUtf16:1025},{timeoutMs:0},{cacheEntries:65}])try{m.context.match({match:f.match,permission:()=>m.permission,resolve:()=>({status:'missing'}),...options});}catch{rejected++;}return{rejected,calls:m.calls.length};});assert.deepEqual(r,{rejected:5,calls:0});
});
check('remote replay neither resolves nor blocks unrelated local anchored application and converges',async p=>{
 const r=await p.evaluate(async()=>{const f=window.configurationFixture,e=f.engine('ASD-123'),checkpoint=e.checkpoint(),peer=f.runtime.restoreEngine(checkpoint.identity,checkpoint);let controller,calls=[];const factory=f.Extension.create({apiVersion:1,feature:f.feature('example.peer-match'),semantics:{kind:'behavior'},defaults:{},validateOptions:()=>true,loading:'required-input',interests:[],onAttach(_,ctx){controller=ctx.match({match:f.match,permission:()=>({principal:'a',tenant:'t',authority:'tasks',revision:'1',lookup:true,apply:true}),resolve:request=>new Promise(resolve=>calls.push({...request,resolve}))});}});const host=f.root(),surface=f.mountEditorSurface(host,e,{extensions:[factory.configure()]});f.surfaces.push(surface);await surface.ready;f.insert(peer,' ',7);e.applyUpdate(peer.encodeUpdate());await new Promise(r=>setTimeout(r,0));const remoteCalls=calls.length;f.insert(e,' ',7);await new Promise(r=>setTimeout(r,0));f.insert(peer,'Prefix ',0);e.applyUpdate(peer.encodeUpdate());calls[0].resolve({status:'available',href:'https://tasks.example/123'});await new Promise(r=>setTimeout(r,0));peer.applyUpdate(e.encodeUpdate());const result={remoteCalls,calls:calls.length,texts:[f.content(e),f.content(peer)],links:[e,peer].map(x=>x.read().visible[0].runs.filter(r=>r.attributes.link).map(r=>[r.text,r.attributes.link]))};surface.dispose();peer.dispose();return result;});assert.equal(r.remoteCalls,0);assert.equal(r.calls,1);assert.deepEqual(r.texts,['Prefix ASD-123  ','Prefix ASD-123  ']);assert.deepEqual(r.links,[[['ASD-123','https://tasks.example/123']],[['ASD-123','https://tasks.example/123']]]);
});
check('active composition suppresses resolver admission without changing authored engine content',async p=>{
 const r=await p.evaluate(async()=>{const f=window.configurationFixture,m=await f.start();f.select(m.editor.root,7);m.editor.root.dispatchEvent(new CompositionEvent('compositionstart',{bubbles:true,data:''}));f.insert(m.editor,' ');await f.flush();const during={calls:m.calls.length,text:f.content(m.editor)};m.editor.root.dispatchEvent(new CompositionEvent('compositionend',{bubbles:true,data:''}));await f.flush();return{during,calls:m.calls.length};});assert.deepEqual(r.during,{calls:0,text:'ASD-123 '});assert.equal(r.calls,0);
});
check('already linked source never requests another automatic lookup',async p=>{
 const r=await p.evaluate(async()=>{const f=window.configurationFixture,m=await f.start();f.mark(m.editor,'link',0,7);f.insert(m.editor,' ');await f.flush();return{calls:m.calls.length,href:f.runs()[0].attributes.link};});assert.deepEqual(r,{calls:0,href:'https://manual.example/'});
});

check('pending dedup follows engine anchors after unrelated source rebasing',async p=>{
 const r=await p.evaluate(async()=>{const f=window.configurationFixture,m=await f.start();f.insert(m.editor,' ');await f.flush();f.insert(m.editor,'Prefix ',0,'local:unrelated');f.insert(m.editor,' ',14);await f.flush();const requests=m.calls.length;m.calls[0].resolve({status:'available',href:'https://tasks.example/123'});await f.flush();return{requests,text:f.content(m.editor),links:f.runs().filter(r=>r.attributes.link).map(r=>r.text),pending:m.controller.state.pending};});assert.deepEqual(r,{requests:1,text:'Prefix ASD-123  ',links:['ASD-123'],pending:0});
});

check('code block context suppresses matching over committed engine attributes',async p=>{
 const r=await p.evaluate(async()=>{const f=window.configurationFixture,m=await f.start();const owner=m.editor.read().visible.find(n=>n.kind==='block').id;m.editor.commit({kind:'editor',origin:'local:code-policy',commands:[{type:'setCode',owner,language:'text'}]});f.insert(m.editor,' ');await f.flush();return{attributes:m.editor.read().visible[0].blockAttributes,calls:m.calls.length,text:f.content(m.editor)};});assert.equal(r.attributes[0],'code');assert.equal(r.calls,0);assert.equal(r.text,'ASD-123 ');
});

check('invalidation releases targets synchronously before an immediate new local action',async p=>{
 const r=await p.evaluate(async()=>{const f=window.configurationFixture,m=await f.start();f.insert(m.editor,' ');await f.flush();m.controller.invalidate();const cleared=m.controller.state.pending;f.insert(m.editor,' ',7);await f.flush();const calls=m.calls.length;m.calls[0].resolve({status:'available',href:'https://tasks.example/old'});m.calls[1].resolve({status:'available',href:'https://tasks.example/new'});await f.flush();return{cleared,calls,links:f.runs().filter(r=>r.attributes.link).map(r=>r.attributes.link),pending:m.controller.state.pending};});assert.deepEqual(r,{cleared:0,calls:2,links:['https://tasks.example/new'],pending:0});
});
