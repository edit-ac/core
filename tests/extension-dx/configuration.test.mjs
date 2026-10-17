import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFile, writeFile } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { browserHarness } from '../browser/browser-harness.ts';

const evidence = resolve(process.env.EDITAC_EXTENSION_DX_OUTPUT);
process.env.EDITAC_CONFIGURATION_OUTPUT = join(evidence, 'browser');
const fixtureDirectory = resolve('tests/extension-dx/configuration-consumer');
const { probe } = browserHarness('configuration', fixtureDirectory, {
  autoMount: false, markdown: false, testFile: 'tests/extension-dx/configuration.test.mjs', assertSourcesUnchanged: true,
  sourcePaths: ['packages/web/src/extensions/contract.ts','packages/web/src/extensions/configuration.ts','packages/web/src/platform/preferences.ts','packages/web/src/sync/presence.ts','packages/web/src/sdk.ts','packages/web/src/editor.ts','packages/web/src/surface.ts','packages/web/src/input/keyboard.ts','packages/web/src/commands/catalog.ts','packages/web/src/ui/commands.ts','tests/extension-dx/configuration-consumer/session.mjs','tests/extension-dx/configuration-consumer/public-smoke.ts'],
  cleanup: page => page.evaluate(() => window.configurationFixture?.close()),
  async prepareConsumer(consumer, { output, facts, run }) {
    const packs = ['core','web'].map(name => join(consumer, name, facts.packs.find(p => p.name === name).file));
    await writeFile(join(consumer,'package.json'), JSON.stringify({ private:true, type:'module' }));
    await run('npm', ['install','--prefix',consumer,'--offline','--ignore-scripts','--no-audit','--no-fund',...packs], 'install.log');
    const pins = JSON.parse(await readFile('../architecture/evidence/extension-dx/contract-20261017/generated-artifacts.json','utf8'));
    facts.authenticatedRuntime = [];
    for (const pin of pins.filter(p => p.member.startsWith('package/dist/wasm/editac_wasm'))) {
      const extraction = spawnSync('tar',['-xOf',pin.pack,pin.member],{maxBuffer:16*1024*1024});
      assert.equal(extraction.status,0); const hash=createHash('sha256').update(extraction.stdout).digest('hex');
      assert.equal(hash,pin.authenticatedSha256,'admitted generated member');
      const relative=pin.member.replace('package/','');
      for(const directory of [join(consumer,'core/package'),join(consumer,'node_modules/@edit-ac/core')]) await writeFile(join(directory,relative),extraction.stdout);
      facts.authenticatedRuntime.push({ pack:pin.pack,member:pin.member,sha256:hash,localStaleDistUsed:false });
    }
    await writeFile(join(consumer,'public-smoke.ts'),await readFile(join(fixtureDirectory,'public-smoke.ts')));
    await run(process.execPath,['node_modules/typescript/bin/tsc','--strict','--skipLibCheck','--noEmit','--target','ES2022','--module','NodeNext','--moduleResolution','NodeNext',join(consumer,'public-smoke.ts')],'installed-typecheck.log');
    await run(process.execPath,['--input-type=module','-e',`globalThis.fetch=()=>{throw Error('SSR fetch')};for(const key of ['document','window','indexedDB'])Object.defineProperty(globalThis,key,{get(){throw Error('SSR '+key)}});const m=await import(${JSON.stringify(join(consumer,'node_modules/@edit-ac/web/dist/index.js'))});if(!m.DocumentSearch||!m.createEditor)throw Error('Missing public exports');`],'installed-ssr.log');
    facts.installedConsumer={typecheck:true,ssr:true,privateImports:false,install:'offline tarballs; no scripts'};
    return fixtureDirectory;
  },
});
async function ready(page) { await page.waitForFunction(() => !!window.configurationFixture); }
function browserCase(name, action) { test(name, () => probe(name, async (page,fact) => { await ready(page); await action(page,fact); })); }

browserCase('both-public-mounts-assemble-qualified-presenters', async page => {
  const result=await page.evaluate(async()=>{const f=window.configurationFixture;
    const a=await f.open({extensions:[f.DocumentSearch.configure(),f.BlockReorder.configure()]}),b=f.surface({extensions:[f.DocumentSearch.configure()]});
    await b.surface.ready;
    return {a:!!a.search&&!!a.reorder,b:!!b.surface.search,absent:!b.surface.reorder,same:a.search===b.surface.search,states:[a.extensionStatus,b.surface.extensionStatus],text:[f.content(a),f.content(b.engine)]};});
  assert.deepEqual({a:result.a,b:result.b,absent:result.absent,same:result.same,text:result.text},{a:true,b:true,absent:true,same:false,text:['Alpha beta','Alpha beta']});
  for(const state of result.states)for(const status of Object.values(state))assert.equal(status.state,'ready');
});
browserCase('invalid-configuration-precedes-reservation-recovery-and-dom', async page => {
  const result=await page.evaluate(async()=>{const f=window.configurationFixture,root=f.root(),storage=await f.seed(),engine=f.engine();root.textContent='Host preview';const before=root.outerHTML;let recovery=0;const codes=[];
    for(const options of [{extensions:[f.DocumentSearch.configure(),f.DocumentSearch.configure()]},{extensions:[],typingShortcuts:false},{extensions:[],formatting:{marks:{bold:{commands:false}}}}]) {
      try{f.createEditor(root,{...storage,...options,recover:()=>{recovery++;throw Error('unexpected');}});}catch(e){codes.push(e.code);}
      try{f.mountEditorSurface(root,engine,options);}catch(e){codes.push(e.code);}
    }
    const preserved=before===root.outerHTML;const mounted=f.mountEditorSurface(root,engine,{extensions:[]});mounted.dispose();return{recovery,codes,preserved};});
  assert.deepEqual(result,{recovery:0,codes:['duplicate','duplicate','legacy-conflict','legacy-conflict','invalid-formatting','invalid-formatting'],preserved:true});
});
browserCase('captured-options-remain-isolated-during-local-recovery', async page => {
  const result=await page.evaluate(async()=>{const f=window.configurationFixture,options={extensions:[f.DocumentSearch.configure()],platform:{spellcheck:'off',autocorrection:'inherit'}};const storage=await f.seed();const root=f.root({autocorrect:'on'});const a=f.createEditor(root,{...storage,...options});f.editors.push(a);options.platform.spellcheck='platform';options.extensions.length=0;await a.ready;const b=await f.open({extensions:[]});return{a:!!a.search,b:!!b.search,spell:root.getAttribute('spellcheck'),auto:root.getAttribute('autocorrect'),frozen:Object.isFrozen(a.extensionConfiguration.configuration.platform)};});
  assert.deepEqual(result,{a:true,b:false,spell:'false',auto:'on',frozen:true});
});
browserCase('provider-free-local-input-history-and-recovery', async(page,fact)=>{
  await page.evaluate(async()=>{const f=window.configurationFixture;window.localEditor=await f.open({extensions:[]}, {}, 'Local');window.localEditor.root.id='local';f.select(window.localEditor.root,5);});
  await page.locator('#local').press('End');await page.keyboard.insertText(' saved');
  const result=await page.evaluate(async()=>{const f=window.configurationFixture,a=window.localEditor;const before=f.content(a);const history=a.captureHistory();const undo=history.execute('undo');history.dispose();const undone=f.content(a);const redo=a.captureHistory();redo.execute('redo');redo.dispose();await a.flush({target:'local'});const record={...a.recoveryExport()};return{before,undone,after:f.content(a),undo:undo.disposition,ready:a.state.ready,collaboration:a.collaborationStatus.state};});
  fact.snapshots.push(result);assert.equal(result.before,'Local saved');assert.equal(result.undone,'Local');assert.equal(result.after,'Local saved');assert.equal(result.ready,true);assert.equal(result.collaboration,'idle');
});
browserCase('mixed-editors-isolate-content-authority-selection-history', async page=>{
  const result=await page.evaluate(async()=>{const f=window.configurationFixture;const a=await f.open({extensions:[],readOnly:true},{},'Comment'),b=await f.open({extensions:[]},{},'Local'),c=await f.open({extensions:[],collaboration:{connect:()=>new Promise(()=>{})}},{},'Collaborative');f.replace(b,'B ');f.replace(c,'C ');let denied=false;try{f.replace(a,'bad');}catch{denied=true;}f.select(b.root,0,1);const h=b.captureHistory();h.execute('undo');h.dispose();return{denied,text:[f.content(a),f.content(b),f.content(c)],identity:new Set([a.read().identity.documentId,b.read().identity.documentId,c.read().identity.documentId]).size,ready:[a.state.ready,b.state.ready,c.state.ready]};});
  assert.equal(result.denied,true);assert.deepEqual(result.text,['Comment','Local','C Collaborative']);assert.equal(result.identity,3);assert.deepEqual(result.ready,[true,true,true]);
});
browserCase('format-command-policy-all-six-marks-retains-existing-content',async page=>{
  const result=await page.evaluate(async()=>{const f=window.configurationFixture,out=[];for(const mark of ['bold','italic','strike','underline','code','link']){const a=await f.open({extensions:[],formatting:{marks:{[mark]:{commands:false,shortcuts:false,controls:false}}}});f.select(a.root,0,5);const target=a.captureToolbar();out.push({mark,applicable:target.applicable(mark),result:target.apply({[mark]:mark==='link'?'https://example.test':true}).disposition,text:f.content(a)});target.dispose();}return out;});
  assert.equal(result.length,6);for(const item of result){assert.equal(item.applicable,false,item.mark);assert.equal(item.result,'rejected',item.mark);assert.equal(item.text,'Alpha beta');}
});
browserCase('control-shortcut-and-command-policies-are-independent',async page=>{
  const result=await page.evaluate(async()=>{const f=window.configurationFixture,a=await f.open({extensions:[],commandControls:true,formatting:{marks:{bold:{shortcuts:false,controls:false}}}});f.select(a.root,0,5);const target=a.captureCommand('bold');const result=target.execute();target.dispose();return{result:result.disposition,controls:a.commandControls.element.querySelector('[data-command="bold"]')===null,marks:a.read().visible.find(n=>n.kind==='block').runs};});
  assert.equal(result.result,'committed');assert.equal(result.controls,true);assert.equal(result.marks[0].attributes.bold,true);
});
browserCase('borrowed-surface-formatting-uses-the-existing-command-owner',async page=>{
  const result=await page.evaluate(()=>{const f=window.configurationFixture,{host,engine,surface}=f.surface({extensions:[],formatting:{marks:{italic:{commands:false,shortcuts:false,controls:false}}}});f.select(host,0,5);const no=surface.captureCommand('italic'),yes=surface.captureCommand('code');const outcome=yes.execute();yes.dispose();return{no:!!no,outcome:outcome.disposition,runs:engine.read().visible.find(n=>n.kind==='block').runs};});
  assert.equal(result.no,false);assert.equal(result.outcome,'committed');assert.equal(result.runs[0].attributes.code,true);
});
browserCase('default-platform-policy-preserves-host-and-inherited-values',async page=>{
  const result=await page.evaluate(async()=>{const f=window.configurationFixture;document.body.setAttribute('spellcheck','false');const a=await f.open({extensions:[]},{autocorrect:'off',autocapitalize:'words',spellcheck:'true'}),b=f.surface({extensions:[]});return{a:['spellcheck','autocorrect','autocapitalize'].map(k=>a.root.getAttribute(k)),b:['spellcheck','autocorrect'].map(k=>b.host.getAttribute(k)),observed:[a.platformPreferences.observed,b.surface.platformPreferences.observed]};});
  assert.deepEqual(result,{a:['true','off','words'],b:[null,null],observed:['unknown','unknown']});
});
browserCase('spelling-and-autocorrection-cross-product-is-independent',async page=>{
  const result=await page.evaluate(()=>{const f=window.configurationFixture,out=[];for(const spellcheck of ['platform','off'])for(const autocorrection of ['inherit','on','off']){const {host,surface}=f.surface({extensions:[],platform:{spellcheck,autocorrection}},{spellcheck:'true',autocorrect:'off',autocapitalize:'words',inputmode:'text'});out.push({spellcheck,autocorrection,attrs:['spellcheck','autocorrect','autocapitalize','inputmode'].map(k=>host.getAttribute(k)),observed:surface.platformPreferences.observed});}return out;});
  assert.equal(result.length,6);for(const row of result){assert.deepEqual(row.attrs,[row.spellcheck==='platform'?'true':'false',row.autocorrection==='inherit'?'off':row.autocorrection,'words','text']);assert.equal(row.observed,'unknown');}
});
browserCase('disposal-restores-only-editor-owned-preferences',async page=>{
  const result=await page.evaluate(()=>{const f=window.configurationFixture,a=f.surface({extensions:[],platform:{spellcheck:'off',autocorrection:'off',locale:'hu'}},{spellcheck:'true',autocorrect:'on',lang:'en'});a.host.setAttribute('lang','fr');a.surface.dispose();a.surface.dispose();return{attrs:['spellcheck','autocorrect','lang'].map(k=>a.host.getAttribute(k)),states:a.surface.extensionStatus};});
  assert.deepEqual(result.attrs,['true','on','fr']);
});
browserCase('custom-checker-is-explicitly-unavailable-without-fallback',async(page,fact)=>{
  const result=await page.evaluate(()=>{const f=window.configurationFixture,root=f.root({spellcheck:'true'}),engine=f.engine();const before=root.outerHTML;let error;try{f.mountEditorSurface(root,engine,{extensions:[],platform:{spellcheck:'custom',autocorrection:'off'}});}catch(e){error={code:e.code,option:e.option};}return{error,unchanged:root.outerHTML===before};});
  assert.deepEqual(result,{error:{code:'missing-checker',option:'platform.spellcheck'},unchanged:true});assert.ok(fact.requests.every(url=>!/dictionary|checker|worker/.test(url)));
});
browserCase('local-ready-does-not-wait-for-delayed-collaboration',async page=>{
  const result=await page.evaluate(async()=>{const f=window.configurationFixture;let resolve;const pending=new Promise(r=>resolve=r);const a=await f.open({extensions:[],collaboration:{connect:()=>pending}},{},'Local');f.replace(a,'Edited ');const before={state:a.collaborationStatus.state,text:f.content(a),ready:a.state.ready};resolve({transport:{send:()=>true},peerIdentity:a.read().identity,authorized:true});await new Promise(r=>setTimeout(r,30));await a.syncAttachment.pump(0);return{before,attached:a.collaborationStatus.state,text:f.content(a)};});
  assert.deepEqual(result,{before:{state:'loading',text:'Edited Local',ready:true},attached:'ready',text:'Edited Local'});
});
browserCase('denied-attachment-keeps-local-history-and-recovery',async page=>{
  const result=await page.evaluate(async()=>{const f=window.configurationFixture,a=await f.open({extensions:[],collaboration:{connect:()=>{throw Error('denied');}}},{},'Local');await new Promise(r=>setTimeout(r,0));f.replace(a,'Saved ');await a.flush({target:'local'});return{ready:a.state.ready,text:f.content(a),status:a.collaborationStatus.state,recovery:!!a.recoveryExport()};});
  assert.deepEqual(result,{ready:true,text:'Saved Local',status:'failed',recovery:true});
});
browserCase('identity-and-authority-rejection-never-replace-local-replica',async page=>{
  const result=await page.evaluate(async()=>{const f=window.configurationFixture,out=[];for(const failure of ['identity','authority']){const record=await f.seed('Local');const a=f.createEditor(f.root(),{...record,extensions:[],collaboration:{connect:()=>({transport:{send:()=>true},authorized:failure!=='authority',peerIdentity:{...record.identity,...(failure==='identity'?{documentId:'other'}:{})}})}});f.editors.push(a);await a.ready;let rejected=false;try{await a.connectCollaboration();}catch{rejected=true;}f.replace(a,'Kept ');out.push({rejected,text:f.content(a),ready:a.state.ready,status:a.collaborationStatus.state});}return out;});
  assert.deepEqual(result,[{rejected:true,text:'Kept Local',ready:true,status:'failed'},{rejected:true,text:'Kept Local',ready:true,status:'failed'}]);
});
browserCase('detach-invalidates-pending-connector-completion',async page=>{
  const result=await page.evaluate(async()=>{const f=window.configurationFixture;let resolve,calls=0;const a=await f.open({extensions:[],collaboration:{connect:()=>new Promise(r=>resolve=r)}});a.disconnectCollaboration();resolve({transport:{send:()=>{calls++;return true;}},authorized:true,peerIdentity:a.read().identity});await new Promise(r=>setTimeout(r,20));f.replace(a,'Kept ');return{calls,attachment:!!a.syncAttachment,status:a.collaborationStatus.state,text:f.content(a)};});
  assert.deepEqual(result,{calls:0,attachment:false,status:'cancelled',text:'Kept Alpha beta'});
});
browserCase('out-of-order-reconnect-does-not-override-new-attachment',async page=>{
  const result=await page.evaluate(async()=>{const f=window.configurationFixture,resolvers=[];let old=0,current=0;const a=await f.open({extensions:[],collaboration:{connect:()=>new Promise(r=>resolvers.push(r))}});const next=a.connectCollaboration();await new Promise(r=>setTimeout(r,0));resolvers[1]({transport:{send:()=>{current++;return true;}},authorized:true,peerIdentity:a.read().identity});await next;const attachment=a.syncAttachment;resolvers[0]({transport:{send:()=>{old++;return true;}},authorized:true,peerIdentity:a.read().identity});await new Promise(r=>setTimeout(r,0));await a.syncAttachment.pump(0);return{same:attachment===a.syncAttachment,old,current,status:a.collaborationStatus.state};});
  assert.equal(result.same,true);assert.equal(result.old,0);assert.ok(result.current>0);assert.equal(result.status,'ready');
});
browserCase('pending-remote-ready-cancels-on-destroy',async page=>{
  const result=await page.evaluate(async()=>{const f=window.configurationFixture,record=await f.seed();let signal;const a=f.createEditor(f.root(),{...record,extensions:[],collaboration:{readiness:'remote',connect:context=>{signal=context.signal;return new Promise(()=>{});}}});f.editors.push(a);await new Promise(r=>setTimeout(r,30));await a.destroy({policy:'report'});const settled=await Promise.race([a.ready.then(()=>true,()=>true),new Promise(r=>setTimeout(()=>r(false),200))]);return{settled,aborted:signal.aborted,attachment:!!a.syncAttachment};});
  assert.deepEqual(result,{settled:true,aborted:true,attachment:false});
});
browserCase('presence-opt-ins-are-instance-scoped-and-host-driven',async page=>{
  const result=await page.evaluate(async()=>{const f=window.configurationFixture,out=[];for(const [awareness,peerCarets] of [[false,false],[true,false],[true,true]]){let frames=0;const record=await f.seed();const a=f.createEditor(f.root(),{...record,extensions:[],collaboration:{presence:{awareness,peerCarets},connect:()=>({peerIdentity:record.identity,authorized:true,transport:{send:()=>true},presence:{clientId:7,transport:{send:()=>{frames++;return true;}}}})}});f.editors.push(a);await a.ready;await a.connectCollaboration();const attachment=a.syncAttachment;await attachment.pump(0);const peers=attachment.presence?.peers(0)??[];const layer=a.root.nextElementSibling?.hasAttribute('data-editac-presence')??false;a.disconnectCollaboration();out.push({awareness,peerCarets,active:!!attachment.presence,frames,layer,peers:peers.length,removed:!(a.root.nextElementSibling?.hasAttribute('data-editac-presence')??false),text:f.content(a)});}return out;});
  assert.equal(result.length,3);for(const row of result){assert.equal(row.active,row.awareness);assert.equal(row.frames>0,row.awareness);assert.equal(row.layer,row.peerCarets);assert.equal(row.removed,true);assert.equal(row.peers,0);assert.equal(row.text,'Alpha beta');}
});
browserCase('local-storage-reopens-the-same-document-without-a-provider',async page=>{
  const result=await page.evaluate(async()=>{const f=window.configurationFixture,record=await f.seed('Persisted');const a=f.createEditor(f.root(),{...record,extensions:[]});f.editors.push(a);await a.ready;f.replace(a,'Saved ');await a.flush({target:'local'});await a.destroy({policy:'flush'});const b=f.createEditor(f.root(),{...record,extensions:[]});f.editors.push(b);await b.ready;return{text:f.content(b),same:JSON.stringify(b.read().identity)===JSON.stringify(record.identity),sync:!!b.syncAttachment,ready:b.state.ready};});
  assert.deepEqual(result,{text:'Saved Persisted',same:true,sync:false,ready:true});
});
browserCase('legacy-task-defaults-and-explicit-conflicts-retain-compatibility',async page=>{
  const result=await page.evaluate(async()=>{const f=window.configurationFixture,a=await f.open(f.taskPreset());const root=f.root(),record=await f.seed();let code;try{f.createEditor(root,{...record,...f.taskPreset(),extensions:[]});}catch(e){code=e.code;}return{ready:a.state.ready,facade:!!a.extensionConfiguration,text:f.content(a),code,controls:!!a.commandControls};});
  assert.deepEqual(result,{ready:true,facade:false,text:'Alpha beta',code:'legacy-conflict',controls:false});
});
browserCase('unsupported-factory-and-borrowed-sync-fail-before-attachment',async page=>{
  const result=await page.evaluate(()=>{const f=window.configurationFixture,host=f.root(),engine=f.engine(),before=host.outerHTML,codes=[];const forged={...f.DocumentSearch.configure(),feature:{...f.DocumentSearch.configure().feature,id:'host.unavailable'}};for(const options of [{extensions:[forged]},{extensions:[],collaboration:{connect:()=>{throw Error('must not connect');}}}])try{f.mountEditorSurface(host,engine,options);}catch(e){codes.push(e.code);}return{codes,unchanged:host.outerHTML===before,text:f.content(engine)};});
  assert.deepEqual(result,{codes:['missing-adapter','requires-storage-owner'],unchanged:true,text:'Alpha beta'});
});
browserCase('explicit-remote-ready-blocks-input-until-authorized-attachment',async page=>{
  const result=await page.evaluate(async()=>{const f=window.configurationFixture,record=await f.seed('Remote');let resolve;const a=f.createEditor(f.root(),{...record,extensions:[],collaboration:{readiness:'remote',connect:()=>new Promise(r=>resolve=r)}});f.editors.push(a);for(let i=0;i<200&&!resolve;i++)await new Promise(r=>setTimeout(r,5));let denied=false;try{f.replace(a,'bad');}catch{denied=true;}const before={denied,ready:a.state.ready,editable:a.root.contentEditable};resolve({peerIdentity:record.identity,authorized:true,transport:{send:()=>true}});await a.ready;f.replace(a,'Ready ');return{before,after:{ready:a.state.ready,text:f.content(a),status:a.collaborationStatus.state}};});
  assert.deepEqual(result,{before:{denied:true,ready:false,editable:'false'},after:{ready:true,text:'Ready Remote',status:'ready'}});
});
browserCase('inspectable-presets-support-removal-addition-and-explicit-overrides',async page=>{
  const result=await page.evaluate(async()=>{const f=window.configurationFixture,defaults=f.defaultPreset(),document=f.documentPreset({remove:['editac.reorder'],overrides:[f.DocumentSearch.configure()]});const a=await f.open(defaults),b=await f.open(document),c=await f.open(f.defaultPreset({extensions:[f.BlockReorder.configure()]}));return{lists:[defaults.extensions.map(e=>e.feature.id),document.extensions.map(e=>e.feature.id)],enabled:[!!a.search,!!a.reorder,!!b.search,!!b.reorder,!!c.reorder],provenance:[a.extensionConfiguration.configuration.preset,b.extensionConfiguration.configuration.preset],frozen:Object.isFrozen(document.extensions),sync:[!!a.syncAttachment,!!b.syncAttachment,!!c.syncAttachment]};});
  assert.deepEqual(result,{lists:[[],['editac.search']],enabled:[false,false,true,false,true],provenance:['default','document'],frozen:true,sync:[false,false,false]});
});
browserCase('one-host-asset-override-retains-the-authenticated-engine',async page=>{
  const result=await page.evaluate(async()=>{const f=window.configurationFixture,baseURL=new URL('/core/wasm/',location.href).href;const a=await f.open({extensions:[],assets:{baseURL}}),b=await f.open({extensions:[],assets:{manifest:{engine:new URL('editac_wasm_bg.wasm',baseURL).href}}});return{ready:[a.state.ready,b.state.ready],text:[f.content(a),f.content(b)],assets:[a.extensionConfiguration.configuration.assets,b.extensionConfiguration.configuration.assets]};});
  assert.deepEqual(result.ready,[true,true]);assert.deepEqual(result.text,['Alpha beta','Alpha beta']);assert.ok(result.assets[0].baseURL.endsWith('/core/wasm/'));assert.ok(result.assets[1].manifest.engine.endsWith('/core/wasm/editac_wasm_bg.wasm'));
});
browserCase('real-sync-reconnect-preserves-unsent-local-edits-peer-edits-and-history',async(page,fact)=>{
  const result=await page.evaluate(async()=>{const f=window.configurationFixture,source=f.engine('Shared'),checkpoint=source.checkpoint(),records=[await f.seed(undefined,checkpoint),await f.seed(undefined,checkpoint)],inbox=[[],[]],presence=[[],[]];let deny=true;const editors=[];
    for(let i=0;i<2;i++){const record=records[i];const a=f.createEditor(f.root(),{...record,extensions:[],collaboration:{presence:{awareness:true,peerCarets:i===1},connect:()=>({peerIdentity:record.identity,authorized:true,transport:{send:bytes=>{if(i===0&&deny)return false;inbox[1-i].push(bytes.slice());return true;}},presence:{clientId:10+i,transport:{send:bytes=>{presence[1-i].push(bytes.slice());return true;}}}})}});f.editors.push(a);editors.push(a);await a.ready;await a.connectCollaboration();}
    const [a,b]=editors;f.replace(a,'A ');await a.flush({target:'local'});await a.syncAttachment.pump(0);a.disconnectCollaboration();f.replace(b,' Peer',6);await b.flush({target:'local'});deny=false;await a.connectCollaboration();
    let now=100;async function exchange(){for(let n=0;n<12;n++){for(let i=0;i<2;i++){while(inbox[i].length)editors[i].syncAttachment.receive(inbox[i].shift());while(presence[i].length)editors[i].syncAttachment.presence.receive(presence[i].shift(),now);await editors[i].syncAttachment.pump(now);}now+=100;}}
    await exchange();const merged=[f.content(a),f.content(b)];f.select(a.root,0,1);await exchange();const peers=b.syncAttachment.presence.peers(now).map(p=>({clientId:p.clientId,selection:!!p.selection}));const caret=b.root.nextElementSibling?.querySelector('[data-peer="10"]')!==null;f.select(a.root,0);const history=a.captureHistory();history.execute('undo');history.dispose();await a.flush({target:'local'});await exchange();return{merged,afterUndo:[f.content(a),f.content(b)],peers,caret,ready:[a.state.ready,b.state.ready],sameIdentity:JSON.stringify(a.read().identity)===JSON.stringify(b.read().identity)};
  });fact.snapshots.push(result);assert.deepEqual(result.merged,['A Shared Peer','A Shared Peer']);assert.deepEqual(result.afterUndo,['Shared Peer','Shared Peer']);assert.deepEqual(result.peers,[{clientId:10,selection:true}]);assert.equal(result.caret,true);assert.deepEqual(result.ready,[true,true]);assert.equal(result.sameIdentity,true);
});
browserCase('direct-detach-updates-status-and-disposes-only-the-current-attachment',async page=>{
  const result=await page.evaluate(async()=>{const f=window.configurationFixture,record=await f.seed(),a=f.createEditor(f.root(),{...record,extensions:[],collaboration:{connect:()=>({transport:{send:()=>true},authorized:true,peerIdentity:record.identity})}});f.editors.push(a);await a.ready;await a.connectCollaboration();const old=a.syncAttachment;const latest=await a.attachSync({transport:{send:()=>true},authorized:true,peerIdentity:record.identity});old.detach();const kept=latest===a.syncAttachment;latest.detach();latest.detach();f.replace(a,'Local ');return{kept,status:a.collaborationStatus.state,attached:!!a.syncAttachment,text:f.content(a)};});
  assert.deepEqual(result,{kept:true,status:'cancelled',attached:false,text:'Local Alpha beta'});
});
browserCase('failed-local-recovery-releases-surface-and-reports-feature-failure',async page=>{
  const result=await page.evaluate(async()=>{const f=window.configurationFixture,record=await f.seed(),root=f.root();root.textContent='Preserved preview';const a=f.createEditor(root,{...record,extensions:[f.DocumentSearch.configure()],recover:()=>Promise.reject(Error('prepared storage denial'))});f.editors.push(a);let rejected=false;try{await a.ready;}catch{rejected=true;}const state={rejected,phase:a.state.phase,ready:a.state.ready,editable:root.contentEditable,feature:a.extensionStatus['editac.search'].state};await a.destroy({policy:'report'});const b=f.createEditor(root,{...record,extensions:[]});f.editors.push(b);await b.ready;return{state,text:f.content(b),ready:b.state.ready};});
  assert.deepEqual(result,{state:{rejected:true,phase:'failed',ready:false,editable:'false',feature:'failed'},text:'Alpha beta',ready:true});
});
