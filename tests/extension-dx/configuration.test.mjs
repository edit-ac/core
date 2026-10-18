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
  autoMount: false, markdown: true, serverOptions: { recordRequests: true }, testFile: 'tests/extension-dx/configuration.test.mjs', assertSourcesUnchanged: true,
  sourcePaths: ['packages/web/src/extensions/authoring-metadata.ts','packages/web/src/extensions/spelling-metadata.ts','packages/web/src/modules/slash-metadata.ts','packages/web/src/dom/pattern-text.ts','packages/web/package.json','packages/web/src/modules/runtime.ts','packages/web/src/storage/owner.ts','packages/web/src/sync/attachment.ts','packages/web/src/sync/configured.ts','packages/web/src/index.ts','packages/web/src/modules/math.ts','packages/web/src/extensions/resource.ts','packages/web/src/extensions/markdown-resource.ts','packages/web/src/dom/render.ts','packages/markdown/src/web.ts','packages/web/src/extensions/contract.ts','packages/web/src/extensions/configuration.ts','packages/web/src/platform/preferences.ts','packages/web/src/sync/presence.ts','packages/web/src/sdk.ts','packages/web/src/editor.ts','packages/web/src/surface.ts','packages/web/src/input/keyboard.ts','packages/web/src/commands/catalog.ts','packages/web/src/ui/commands.ts','tests/extension-dx/configuration-consumer/session.mjs','tests/extension-dx/configuration-consumer/public-smoke.ts'],
  cleanup: page => page.evaluate(() => window.configurationFixture?.close()),
  async prepareConsumer(consumer, { output, facts, run }) {
    const packs = ['core','web','markdown'].map(name => join(consumer, name, facts.packs.find(p => p.name === name).file));
    await writeFile(join(consumer,'package.json'), JSON.stringify({ private:true, type:'module' }));
    await run('npm', ['install','--prefix',consumer,'--offline','--ignore-scripts','--no-audit','--no-fund',...packs], 'install.log');
    const pins = JSON.parse(await readFile('../architecture/evidence/extension-dx/contract-20261017/generated-artifacts.json','utf8'));
    facts.authenticatedRuntime = [];
    for (const pin of pins) {
      const extraction = spawnSync('tar',['-xOf',pin.pack,pin.member],{maxBuffer:16*1024*1024});
      assert.equal(extraction.status,0); const hash=createHash('sha256').update(extraction.stdout).digest('hex');
      assert.equal(hash,pin.authenticatedSha256,'admitted generated member');
      const relative=pin.member.replace('package/','');
      const name=pin.member.includes('editac_markdown')?'markdown':'core';
      for(const directory of [join(consumer,name,'package'),join(consumer,'node_modules/@edit-ac',name)]) await writeFile(join(directory,relative),extraction.stdout);
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
  const result=await page.evaluate(async()=>{const f=window.configurationFixture;let resolve,started,calls=0;const connected=new Promise(r=>{started=r;});const a=await f.open({extensions:[],collaboration:{connect:()=>new Promise(r=>{resolve=r;started();})}});await connected;a.disconnectCollaboration();resolve({transport:{send:()=>{calls++;return true;}},authorized:true,peerIdentity:a.read().identity});await new Promise(r=>setTimeout(r,20));f.replace(a,'Kept ');return{calls,attachment:!!a.syncAttachment,status:a.collaborationStatus.state,text:f.content(a)};});
  assert.deepEqual(result,{calls:0,attachment:false,status:'cancelled',text:'Kept Alpha beta'});
});
browserCase('out-of-order-reconnect-does-not-override-new-attachment',async page=>{
  const result=await page.evaluate(async()=>{const f=window.configurationFixture,resolvers=[];let old=0,current=0,started;let connected=new Promise(r=>{started=r;});const a=await f.open({extensions:[],collaboration:{connect:()=>new Promise(r=>{resolvers.push(r);started();})}});await connected;connected=new Promise(r=>{started=r;});const next=a.connectCollaboration();await connected;resolvers[1]({transport:{send:()=>{current++;return true;}},authorized:true,peerIdentity:a.read().identity});await next;const attachment=a.syncAttachment;resolvers[0]({transport:{send:()=>{old++;return true;}},authorized:true,peerIdentity:a.read().identity});await new Promise(r=>setTimeout(r,0));await a.syncAttachment.pump(0);return{same:attachment===a.syncAttachment,old,current,status:a.collaborationStatus.state};});
  assert.equal(result.same,true);assert.equal(result.old,0);assert.ok(result.current>0);assert.equal(result.status,'ready');
});
browserCase('pending-remote-ready-cancels-on-destroy',async page=>{
  const result=await page.evaluate(async()=>{const f=window.configurationFixture,record=await f.seed();let signal,started;const connected=new Promise(r=>{started=r;});const a=f.createEditor(f.root(),{...record,extensions:[],collaboration:{readiness:'remote',connect:context=>{signal=context.signal;started();return new Promise(()=>{});}}});f.editors.push(a);await connected;await a.destroy({policy:'report'});const settled=await Promise.race([a.ready.then(()=>true,()=>true),new Promise(r=>setTimeout(()=>r(false),200))]);return{settled,aborted:signal.aborted,attachment:!!a.syncAttachment};});
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

browserCase('required-markdown-gates-both-mounts-and-uses-real-parser-history', async (page,fact)=>{
  let release;const delayed=new Promise(resolve=>{release=resolve;});let requests=0;let requested;const started=new Promise(resolve=>{requested=resolve;});
  await page.route('**/markdown/wasm/editac_markdown_wasm_bg.wasm',async route=>{requests++;requested();await delayed;await route.continue();});
  await page.evaluate(async()=>{const f=window.configurationFixture,record=await f.seed();window.requiredEditor=f.createEditor(f.root(),{...record,extensions:[f.Markdown.configure()]});f.editors.push(window.requiredEditor);window.requiredSurface=f.surface({extensions:[f.Markdown.configure()]});});
  await page.waitForFunction(()=>window.requiredEditor.extensionStatus['editac.markdown'].state==='loading'&&window.requiredSurface.surface.extensionStatus['editac.markdown'].state==='loading');
  const pending=await page.evaluate(()=>({managed:window.requiredEditor.state.ready,borrowed:window.requiredSurface.host.contentEditable,managedEditable:window.requiredEditor.root.contentEditable}));
  assert.deepEqual(pending,{managed:false,borrowed:'false',managedEditable:'false'});await started;assert.equal(requests,1);release();
  const result=await page.evaluate(async()=>{const f=window.configurationFixture,a=window.requiredEditor,b=window.requiredSurface;await Promise.all([a.ready,b.surface.ready]);await f.paste(a,a.root,'**Parsed**');await f.paste({...b.engine,settle:()=>b.surface.settle()},b.host,'*Borrowed*');const before=[a.read().visible.find(n=>n.kind==='block').runs,b.engine.read().visible.find(n=>n.kind==='block').runs];f.select(a.root,0);const h=a.captureHistory();h.execute('undo');h.dispose();const undone=f.content(a),r=a.captureHistory();r.execute('redo');r.dispose();return{before,undone,redone:f.content(a),status:[a.extensionStatus['editac.markdown'].state,b.surface.extensionStatus['editac.markdown'].state]};});
  fact.snapshots.push(result);assert.deepEqual(result.before.map(r=>r.map(v=>({text:v.text,attributes:v.attributes}))),[[{text:'Parsed',attributes:{bold:true}}],[{text:'Borrowed',attributes:{italic:true}}]]);assert.equal(result.undone,'Alpha beta');assert.equal(result.redone,'Parsed');assert.deepEqual(result.status,['ready','ready']);
});

browserCase('command-lazy-export-does-not-delay-typing-or-enable-siblings',async(page,fact)=>{
  let release;const delayed=new Promise(resolve=>{release=resolve;});let requests=0;
  await page.route('**/markdown/wasm/editac_markdown_wasm_bg.wasm',async route=>{requests++;await delayed;await route.continue();});
  const idle=await page.evaluate(async()=>{const f=window.configurationFixture,a=await f.open({extensions:[f.Markdown.configure({input:false})]}),b=await f.open({extensions:[]});window.lazyEditor=a;window.lazySibling=b;a.root.id='lazy';f.select(a.root,0);return{ready:a.state.ready,status:a.extensionStatus['editac.markdown'].state,sibling:b.state.ready};});
  assert.deepEqual(idle,{ready:true,status:'idle',sibling:true});assert.equal(requests,0);
  await page.evaluate(()=>{window.lazyExport=window.lazyEditor.exportMarkdown([{attributes:{type:'paragraph'},runs:[{text:'Export',marks:[{mark:'bold'}]}]}]);});
  await page.waitForFunction(()=>window.lazyEditor.extensionStatus['editac.markdown'].state==='loading');
  await page.locator('#lazy').press('Home');await page.keyboard.insertText('Live ');
  const during=await page.evaluate(()=>({ready:window.lazyEditor.state.ready,text:window.configurationFixture.content(window.lazyEditor),sibling:window.configurationFixture.content(window.lazySibling),editable:window.lazyEditor.root.contentEditable}));
  assert.deepEqual(during,{ready:true,text:'Live Alpha beta',sibling:'Alpha beta',editable:'true'});release();
  const result=await page.evaluate(async()=>({markdown:(await window.lazyExport).markdown.trim(),state:window.lazyEditor.extensionStatus['editac.markdown'].state,text:window.configurationFixture.content(window.lazyEditor)}));fact.snapshots.push(result);assert.deepEqual(result,{markdown:'**Export**',state:'ready',text:'Live Alpha beta'});assert.equal(requests,1);
});

browserCase('parser-failure-retains-source-and-explicit-retry-resumes-same-replicas',async(page,fact)=>{
  let attempts=0;await page.route('**/markdown/wasm/editac_markdown_wasm_bg.wasm',async route=>{attempts++;if(attempts===1)await route.fulfill({status:404,body:'prepared absent parser'});else {const response=await route.fetch();assert.equal(response.status(),200);await route.fulfill({response});}});
  const failure=await page.evaluate(async()=>{const f=window.configurationFixture,record=await f.seed('**Retained source**'),root=f.root(),a=f.createEditor(root,{...record,extensions:[f.Markdown.configure()]}),b=f.surface({extensions:[f.Markdown.configure()]},{},'**Borrowed source**');f.editors.push(a);window.retryEditor=a;window.retrySurface=b;const result=await Promise.allSettled([a.ready,b.surface.ready]);const sibling=await f.open({extensions:[]});return{outcomes:result.map(r=>r.status),text:[root.textContent,f.content(b.engine)],status:[a.extensionStatus['editac.markdown'],b.surface.extensionStatus['editac.markdown']],sibling:sibling.state.ready};});
  assert.deepEqual(failure.outcomes,['rejected','rejected']);assert.deepEqual(failure.text,['**Retained source**','**Borrowed source**']);assert.equal(failure.sibling,true);for(const status of failure.status){assert.equal(status.state,'failed');assert.equal(status.retryable,true);assert.equal(status.generation,1);}
  const result=await page.evaluate(async()=>{const f=window.configurationFixture,a=window.retryEditor,b=window.retrySurface;const identity=b.engine.read().identity;try{await Promise.all([a.loadExtension('editac.markdown'),b.surface.loadExtension('editac.markdown')]);}catch(error){throw Error('Retry cause: '+String(error.cause?.message));}return{ready:a.state.ready,editable:b.host.contentEditable,text:[f.content(a),f.content(b.engine)],same:JSON.stringify(identity)===JSON.stringify(b.engine.read().identity),generation:[a.extensionStatus['editac.markdown'].generation,b.surface.extensionStatus['editac.markdown'].generation]};});
  fact.snapshots.push({failure,result});assert.deepEqual(result,{ready:true,editable:'true',text:['**Retained source**','**Borrowed source**'],same:true,generation:[2,2]});assert.equal(attempts,2);
});

browserCase('pending-parser-disposal-cancels-both-mounts-before-late-completion',async page=>{
  let release;const delayed=new Promise(resolve=>{release=resolve;});let requested;const started=new Promise(resolve=>{requested=resolve;});
  await page.route('**/markdown/wasm/editac_markdown_wasm_bg.wasm',async route=>{requested();await delayed;await route.continue();});
  await page.evaluate(async()=>{const f=window.configurationFixture,record=await f.seed(),a=f.createEditor(f.root(),{...record,extensions:[f.Markdown.configure()]}),b=f.surface({extensions:[f.Markdown.configure()]});f.editors.push(a);window.disposedEditor=a;window.disposedSurface=b;window.disposedReady=Promise.allSettled([a.ready,b.surface.ready]);});
  await started;
  const cancelled=await page.evaluate(async()=>{const a=window.disposedEditor,b=window.disposedSurface;await a.destroy({policy:'report'});b.surface.dispose();return{ready:(await window.disposedReady).map(r=>r.status),states:[a.extensionStatus['editac.markdown'].state,b.surface.extensionStatus['editac.markdown'].state],registered:b.engine.markdownAvailable,text:b.host.textContent};});
  assert.deepEqual(cancelled,{ready:['rejected','rejected'],states:['cancelled','cancelled'],registered:false,text:'Alpha beta'});release();
  await page.waitForResponse('**/markdown/wasm/editac_markdown_wasm_bg.wasm');
  const late=await page.evaluate(async()=>{const b=window.disposedSurface;await new Promise(resolve=>setTimeout(resolve,30));return{registered:b.engine.markdownAvailable,text:b.host.textContent,editable:b.host.contentEditable};});assert.deepEqual(late,{registered:false,text:'Alpha beta',editable:'false'});
});

browserCase('facade-content-families-use-qualified-presenters-without-host-assembly',async(page,fact)=>{
  const result=await page.evaluate(async()=>{const f=window.configurationFixture,e=f.engine(''),blocks=[{attributes:{type:'paragraph'},runs:[{text:'Prose',marks:[]}]},{attributes:{type:'content',tuple:['module:editac.image',1,{url:'https://assets.invalid/image.png',alt:'Existing image',title:'',source:'![Existing image](https://assets.invalid/image.png)'}]},runs:[{text:'Existing image',marks:[]}]},{attributes:{type:'content',tuple:['module:editac.table',1,{alignments:['none'],rows:[[[['head',[]]]],[[['cell',[]]]]],source:'| head |\n| --- |\n| cell |'}]},runs:[{text:'head\ncell',marks:[]}]}];f.fill(e,blocks);e.history({type:'clear'});const record=await f.seed(undefined,e.checkpoint()),a=f.createEditor(f.root(),{...record,extensions:[f.Images.configure(),f.Tables.configure()]}),host=f.root(),b=f.mountEditorSurface(host,e,{extensions:[f.Tables.configure()]});f.editors.push(a);await Promise.all([a.ready,b.ready]);window.contentBorrowed=b;const before=e.read().visible.map(n=>({attributes:n.blockAttributes,runs:n.runs}));const cell=a.root.querySelectorAll('[data-content-module="table"] textarea')[1];cell.value='updated';cell.dispatchEvent(new InputEvent('input',{bubbles:true}));const updated=a.read().visible.find(n=>n.blockAttributes?.[0]==='module:editac.table').blockAttributes[2].rows[1][0][0][0];f.select(a.root,0);const h=a.captureHistory();h.execute('undo');h.dispose();const undone=a.read().visible.find(n=>n.blockAttributes?.[0]==='module:editac.table').blockAttributes[2].rows[1][0][0][0];const out={managed:[!!a.root.querySelector('[data-content-module="image"]'),!!a.root.querySelector('[data-content-module="table"]')],borrowed:[!!host.querySelector('[data-content-module="image"]'),!!host.querySelector('[data-content-module="table"]')],updated,undone,unmodified:JSON.stringify(before)===JSON.stringify(e.read().visible.map(n=>({attributes:n.blockAttributes,runs:n.runs}))),imageState:a.root.querySelector('[data-content-module="image"]').dataset.imageState};b.dispose();return out;});
  fact.snapshots.push(result);assert.deepEqual(result,{managed:[true,true],borrowed:[false,true],updated:'updated',undone:'cell',unmodified:true,imageState:'missing'});
});

browserCase('disabled-formatting-preserves-six-existing-marks-unknown-data-and-history',async(page,fact)=>{
  const result=await page.evaluate(async()=>{const f=window.configurationFixture,marks=['bold','italic','strike','underline','code','link'],e=f.engine('');
    const blocks=[{attributes:{type:'paragraph'},runs:marks.map((mark,i)=>({text:String(i),marks:[{mark,...(mark==='link'?{href:'https://example.test/existing'}:{})}],...(i===0?{opaqueMarks:[{key:'module:vendor-style',value:[1,{tone:'red'}]}]}:{})}))}];f.fill(e,blocks);
    const formatting={marks:Object.fromEntries(marks.map(mark=>[mark,{commands:false,shortcuts:false,controls:false}]))},host=f.root(),b=f.mountEditorSurface(host,e,{extensions:[],formatting});
    try {await b.ready;const original=e.read().visible.find(n=>n.kind==='block').runs;f.select(host,0,1);const denied=marks.map(mark=>!b.captureCommand(mark));const undo=b.captureHistory();undo.execute('undo');undo.dispose();const borrowedUndo=f.content(e);const redo=b.captureHistory();redo.execute('redo');redo.dispose();const borrowedRedo=e.read().visible.find(n=>n.kind==='block').runs;
      const record=await f.seed(undefined,e.checkpoint()),a=f.createEditor(f.root(),{...record,extensions:[],formatting,commandControls:true});f.editors.push(a);await a.ready;const before=a.read().visible.find(n=>n.kind==='block').runs;f.replace(a,'!',6);f.select(a.root,0);const h=a.captureHistory();h.execute('undo');h.dispose();const restored=a.read().visible.find(n=>n.kind==='block').runs;await a.flush({target:'local'});await a.destroy({policy:'flush'});const reopened=f.createEditor(f.root(),{...record,extensions:[],formatting});f.editors.push(reopened);await reopened.ready;
      return{original,before,restored,reopened:reopened.read().visible.find(n=>n.kind==='block').runs,borrowedUndo,borrowedRedo,denied,controls:marks.map(mark=>a.commandControls?.element.querySelector(`[data-command="${mark}"]`)===null)};
    } finally {b.dispose();}
  });
  fact.snapshots.push(result);const expected=['bold','italic','strike','underline','code','link'].map((mark,i)=>({text:String(i),attributes:{[mark]:mark==='link'?'https://example.test/existing':true,...(i===0?{'module:vendor-style':[1,{tone:'red'}]}:{})}}));
  for(const key of ['original','before','restored','reopened','borrowedRedo'])assert.deepEqual(result[key],expected,key);assert.equal(result.borrowedUndo,'');assert.deepEqual(result.denied,[true,true,true,true,true,true]);assert.deepEqual(result.controls,[true,true,true,true,true,true]);
});

browserCase('invalid-shipped-options-and-mutated-load-policy-fail-before-attachment',async page=>{
  const result=await page.evaluate(()=>{const f=window.configurationFixture,root=f.root(),engine=f.engine();root.textContent='Original host';const before=root.outerHTML,codes=[];for(const action of [()=>f.Markdown.configure({input:'lazy'}),()=>f.mountEditorSurface(root,engine,{extensions:[{...f.Markdown.configure(),loading:'command-lazy'}]}),()=>f.mountEditorSurface(root,engine,{extensions:[{...f.Tables.configure(),options:{unexpected:true}}]})]){try{action();}catch(error){codes.push(error.code);}}const preserved=before===root.outerHTML;const b=f.mountEditorSurface(root,engine,{extensions:[]});b.dispose();return{codes,preserved};});assert.deepEqual(result,{codes:['invalid-option','missing-adapter','unknown-option'],preserved:true});
});

browserCase('disabled-codec-performs-no-parser-initialization-or-additional-content-work',async(page,fact)=>{
  const baseline=await page.evaluate(()=>performance.getEntriesByType('resource').map(r=>r.name));fact.snapshots.push({baselineContentMembers:baseline.filter(url=>/\/web\/modules\/(content|images|tables)/u.test(url))});assert.deepEqual(baseline.filter(url=>/\/markdown\//u.test(url)),[]);
  const requests=[];page.on('request',request=>{if(/\/markdown\/|\/web\/modules\/(content|images|tables)/u.test(request.url()))requests.push(request.url());});
  const result=await page.evaluate(async()=>{const f=window.configurationFixture,a=await f.open({extensions:[]}),b=f.surface({extensions:[]});await b.surface.ready;f.replace(a,'Local ');return{ready:a.state.ready,text:f.content(a),borrowed:f.content(b.engine),statuses:[a.extensionStatus,b.surface.extensionStatus]};});assert.deepEqual(result,{ready:true,text:'Local Alpha beta',borrowed:'Alpha beta',statuses:[{},{}]});assert.deepEqual(requests,[]);
});

browserCase('borrowed-storage-owner-sync-reconnect-remount-preserves-peer-history-and-unsent-edits',async(page,fact)=>{
  const result=await page.evaluate(async()=>{const f=window.configurationFixture,seed=f.engine('Shared'),checkpoint=seed.checkpoint(),records=[await f.seed(undefined,checkpoint),await f.seed(undefined,checkpoint)],owner=await f.openEditorStorage(records[0]);f.storageOwners.push(owner);const inbox=[[],[]],presence=[[],[]];let deny=true;
    const policy=i=>({presence:{awareness:true,peerCarets:i===1},connect:()=>({peerIdentity:checkpoint.identity,authorized:true,transport:{send:bytes=>{if(i===0&&deny)return false;inbox[1-i].push(bytes.slice());return true;}},presence:{clientId:20+i,transport:{send:bytes=>{presence[1-i].push(bytes.slice());return true;}}}})});
    const host=f.root();let a=f.mountEditorSurface(host,owner.engine,{extensions:[],storageOwner:owner,collaboration:policy(0)});f.surfaces.push(a);const b=f.createEditor(f.root(),{...records[1],extensions:[],collaboration:policy(1)});f.editors.push(b);await Promise.all([a.ready,b.ready]);await Promise.all([a.connectCollaboration(),b.connectCollaboration()]);
    const at=owner.engine.anchor(owner.engine.read().visible.find(n=>n.kind==='block').id,0,'right');try{owner.commit({kind:'text',origin:'local:borrowed',command:{type:'insert',at,text:'A '}});}finally{owner.engine.releaseAnchor(at);}await owner.flush({target:'local'});await a.syncAttachment.pump(0);a.dispose();const retained=f.content(owner.engine);f.replace(b,' Peer',6);await b.flush({target:'local'});deny=false;
    a=f.mountEditorSurface(host,owner.engine,{extensions:[],storageOwner:owner,collaboration:policy(0)});f.surfaces.push(a);await a.ready;await a.connectCollaboration();let now=100;
    async function exchange(){for(let n=0;n<12;n++){for(let i=0;i<2;i++){const current=[a,b][i];while(inbox[i].length)current.syncAttachment.receive(inbox[i].shift());while(presence[i].length)current.syncAttachment.presence.receive(presence[i].shift(),now);await current.syncAttachment.pump(now);}now+=100;}}
    await exchange();const merged=[f.content(owner.engine),f.content(b)];f.select(host,0,1);await exchange();const peers=b.syncAttachment.presence.peers(now).map(p=>({clientId:p.clientId,selection:!!p.selection}));const h=a.captureHistory();h.execute('undo');h.dispose();await owner.flush({target:'local'});await exchange();return{retained,merged,undone:[f.content(owner.engine),f.content(b)],peers,states:[a.collaborationStatus.state,b.collaborationStatus.state]};});
  fact.snapshots.push(result);assert.deepEqual(result,{retained:'A Shared',merged:['A Shared Peer','A Shared Peer'],undone:['Shared Peer','Shared Peer'],peers:[{clientId:20,selection:true}],states:['ready','ready']});
});

browserCase('borrowed-remote-readiness-denial-and-explicit-retry-use-same-local-owner',async(page,fact)=>{
  const result=await page.evaluate(async()=>{const f=window.configurationFixture,record=await f.seed(),owner=await f.openEditorStorage(record);f.storageOwners.push(owner);const host=f.root();let allowed=false,resolve;const first=new Promise(r=>{resolve=r;});const surface=f.mountEditorSurface(host,owner.engine,{extensions:[],storageOwner:owner,collaboration:{readiness:'remote',connect:()=>allowed?{peerIdentity:record.identity,authorized:true,transport:{send:()=>true}}:first}});f.surfaces.push(surface);let commandDenied=false;try{surface.captureHistory();}catch{commandDenied=true;}surface.setReadOnly(false);const gated=host.contentEditable;resolve({peerIdentity:record.identity,authorized:false,transport:{send:()=>{throw Error('denied transport must not run');}}});let failed=false;try{await surface.ready;}catch{failed=true;}const failure={failed,status:surface.collaborationStatus.state,text:f.content(owner.engine),gated,commandDenied};allowed=true;await surface.connectCollaboration();f.select(host,0);const h=surface.captureHistory();const history=!!h;h?.dispose();return{failure,ready:host.contentEditable,status:surface.collaborationStatus.state,history,text:f.content(owner.engine)};});
  fact.snapshots.push(result);assert.deepEqual(result,{failure:{failed:true,status:'failed',text:'Alpha beta',gated:'false',commandDenied:true},ready:'true',status:'ready',history:true,text:'Alpha beta'});
});

browserCase('borrowed-pending-connector-disposal-is-inert-and-host-storage-stays-editable',async page=>{
  const result=await page.evaluate(async()=>{const f=window.configurationFixture,record=await f.seed(),owner=await f.openEditorStorage(record);f.storageOwners.push(owner);let resolve,signal,started,sends=0;let connected=new Promise(r=>{started=r;});const pending=new Promise(r=>{resolve=r;}),host=f.root(),surface=f.mountEditorSurface(host,owner.engine,{extensions:[],storageOwner:owner,collaboration:{connect:context=>{signal=context.signal;started();return pending;}}});f.surfaces.push(surface);await surface.ready;await connected;connected=new Promise(r=>{started=r;});const connecting=surface.connectCollaboration().then(()=>false,()=>true);await connected;surface.dispose();resolve({peerIdentity:record.identity,authorized:true,transport:{send:()=>{sends++;return true;}}});const cancelled=await connecting;const remounted=f.mountEditorSurface(host,owner.engine,{extensions:[],storageOwner:owner});f.surfaces.push(remounted);await remounted.ready;f.select(host,0);const at=owner.engine.anchor(owner.engine.read().visible[0].id,0,'right');try{owner.commit({kind:'text',origin:'local:after-dispose',command:{type:'insert',at,text:'Kept '}});}finally{owner.engine.releaseAnchor(at);}await owner.flush({target:'local'});return{cancelled,aborted:signal.aborted,sends,text:f.content(owner.engine),attached:!!surface.syncAttachment,state:surface.collaborationStatus.state};});assert.deepEqual(result,{cancelled:true,aborted:true,sends:0,text:'Kept Alpha beta',attached:false,state:'cancelled'});
});

browserCase('borrowed-storage-identity-and-commit-conflicts-fail-before-attachment',async page=>{
  const result=await page.evaluate(async()=>{const f=window.configurationFixture,record=await f.seed(),owner=await f.openEditorStorage(record);f.storageOwners.push(owner);const host=f.root(),other=f.engine();host.textContent='Host retained';const before=host.outerHTML,codes=[];for(const [engine,options] of [[other,{extensions:[],storageOwner:owner}],[owner.engine,{extensions:[],storageOwner:owner,commit:()=>{throw Error('must not run');}}]]){try{f.mountEditorSurface(host,engine,options);}catch(error){codes.push(error.code);}}const preserved=before===host.outerHTML;return{codes,preserved,text:f.content(owner.engine)};});assert.deepEqual(result,{codes:['incompatible-storage-owner','legacy-conflict'],preserved:true,text:'Alpha beta'});
});

browserCase('facade-reference-host-is-explicit-isolated-and-uses-existing-insertion-history',async(page,fact)=>{
  const initial=await page.evaluate(async()=>{const f=window.configurationFixture;window.referenceCalls=[];const configured=f.References.configure({host:request=>{window.referenceCalls.push(request.query);return[{targetId:'doc-42',label:'Verified reference'}];},triggers:['@']});const a=await f.open({extensions:[configured]}),b=f.surface({extensions:[f.References.configure({host:()=>{throw Error('Sibling resolver must stay idle');}})],readOnly:true});await b.surface.ready;window.referenceEditor=a;window.referenceSibling=b;const count=window.referenceCalls.length;f.select(a.root,0,5);a.references.openExplicit();return{count,a:!!a.references,b:!!b.surface.references,isolated:a.references!==b.surface.references};});
  assert.deepEqual(initial,{count:0,a:true,b:true,isolated:true});
  await page.waitForFunction(()=>window.referenceEditor.references.menu.getAttribute('aria-busy')==='false');
  const result=await page.evaluate(()=>{const f=window.configurationFixture,a=window.referenceEditor,b=window.referenceSibling;a.references.activate(0);const atom=a.read().visible.find(n=>n.blockAttributes?.[0]==='module:editac.reference');f.select(a.root,0);const h=a.captureHistory();h.execute('undo');h.dispose();b.surface.references.openExplicit();return{atom:{attributes:atom.blockAttributes,runs:atom.runs},undone:f.content(a),sibling:f.content(b.engine),siblingOpen:b.surface.references.open,requests:window.referenceCalls};});
  fact.snapshots.push(result);assert.deepEqual(result,{atom:{attributes:['module:editac.reference',1,{targetId:'doc-42',label:'Verified reference'}],runs:[{text:'Verified reference',attributes:{}}]},undone:'Alpha beta',sibling:'Alpha beta',siblingOpen:false,requests:['']});
});

browserCase('facade-slash-command-options-are-captured-once-and-apply-one-prepared-intent',async(page,fact)=>{
  const result=await page.evaluate(async()=>{const f=window.configurationFixture;let calls=0;const command={id:'insert',label:'Insert prepared content',prepare:()=>{calls++;return{type:'fragment',blocks:[{attributes:{type:'paragraph'},runs:[{text:'Inserted',marks:[{mark:'bold'}]}]}]};}};const configured=f.SlashCommands.configure({commands:[command]});command.label='Mutated';command.prepare=()=>{throw Error('Mutated callback must not run');};const a=await f.open({extensions:[configured]}),b=f.surface({extensions:[configured]});f.select(a.root,0);a.slash.openExplicit();const label=a.slash.menu.textContent;await a.slash.activate('insert');const inserted=a.read().visible.find(n=>n.kind==='block').runs;f.select(a.root,0);const h=a.captureHistory();h.execute('undo');h.dispose();return{calls,label:label.includes('Insert prepared content')&&!label.includes('Mutated'),inserted,undone:f.content(a),sibling:f.content(b.engine),distinct:a.slash!==b.surface.slash};});
  fact.snapshots.push(result);assert.deepEqual(result,{calls:1,label:true,inserted:[{text:'Inserted',attributes:{bold:true}},{text:'Alpha beta',attributes:{}}],undone:'Alpha beta',sibling:'Alpha beta',distinct:true});
});

browserCase('facade-math-admits-existing-data-and-uses-qualified-lazy-preview-on-both-mounts',async(page,fact)=>{
  await page.evaluate(async()=>{const f=window.configurationFixture,e=f.engine('');f.fill(e,[{attributes:{type:'paragraph'},runs:[{text:'LaTeX source: x^2',marks:[],attributes:{'module:editac.math':[1,{latex:'x^2',display:false}]}}]}]);e.history({type:'clear'});const record=await f.seed(undefined,e.checkpoint()),a=f.createEditor(f.root(),{...record,extensions:[f.MathNotation.configure()]}),host=f.root(),b=f.mountEditorSurface(host,e,{extensions:[f.MathNotation.configure()]});f.editors.push(a);f.surfaces.push(b);await Promise.all([a.ready,b.ready]);window.mathEditors={a,b,e,host};});
  await page.waitForFunction(()=>document.querySelectorAll('[data-math-state="rendered"]').length===2);
  const result=await page.evaluate(()=>{const {a,b,e,host}=window.mathEditors;return{managed:a.read().visible.find(n=>n.kind==='block').runs,borrowed:e.read().visible.find(n=>n.kind==='block').runs,states:[a.extensionStatus['editac.math'].state,b.extensionStatus['editac.math'].state],errors:[a.moduleRuntime.takeErrors(),b.moduleRuntime.takeErrors()],definitions:[a.extensionConfiguration.profile.registry.frozen,b.extensionConfiguration.profile.registry.frozen]};});fact.snapshots.push(result);const expected=[{text:'LaTeX source: x^2',attributes:{'module:editac.math':[1,{latex:'x^2',display:false}]}}];assert.deepEqual(result,{managed:expected,borrowed:expected,states:['ready','ready'],errors:[[],[]],definitions:[true,true]});
});

browserCase('one-config-composes-markdown-image-and-table-codecs-with-their-presenters',async(page,fact)=>{
  const result=await page.evaluate(async()=>{const f=window.configurationFixture,a=await f.open({extensions:[f.Markdown.configure(),f.Images.configure(),f.Tables.configure()],assets:{manifest:{markdown:new URL('/markdown/wasm/editac_markdown_wasm_bg.wasm?v=qualified',location.href).href}}});await f.paste(a,a.root,'Lead\n\n![alt](https://assets.invalid/image.png)\n\n| head |\n| --- |\n| cell |');const kinds=a.read().visible.map(n=>n.blockAttributes?.[0]),image=a.root.querySelector('[data-content-module="image"]'),table=a.root.querySelector('[data-content-module="table"]');f.select(a.root,0);const h=a.captureHistory();h.execute('undo');h.dispose();const undone=f.content(a);const r=a.captureHistory();r.execute('redo');r.dispose();return{images:kinds.filter(k=>k==='module:editac.image').length,tables:kinds.filter(k=>k==='module:editac.table').length,presenters:[!!image,!!table],undone,redone:a.read().visible.map(n=>n.blockAttributes?.[0]).filter(k=>k.startsWith('module:'))};});fact.snapshots.push(result);assert.deepEqual(result,{images:1,tables:1,presenters:[true,true],undone:'Alpha beta',redone:['module:editac.image','module:editac.table']});
});

browserCase('managed-remote-gate-can-retry-denial-without-recovery-or-readonly-bypass',async(page,fact)=>{
  const result=await page.evaluate(async()=>{const f=window.configurationFixture,record=await f.seed();let resolve,allowed=false;const pending=new Promise(r=>{resolve=r;}),a=f.createEditor(f.root(),{...record,extensions:[],commandControls:true,collaboration:{readiness:'remote',connect:()=>allowed?{peerIdentity:record.identity,authorized:true,transport:{send:()=>true}}:pending}});f.editors.push(a);while(a.collaborationStatus.state!=='loading')await new Promise(r=>setTimeout(r,0));a.setReadOnly(false);const gated=a.root.contentEditable;resolve({peerIdentity:record.identity,authorized:false,transport:{send:()=>{throw Error('Denied send');}}});let rejected=false;try{await a.ready;}catch{rejected=true;}const failure={rejected,ready:a.state.ready,status:a.collaborationStatus.state};allowed=true;await a.connectCollaboration();f.select(a.root,0);f.replace(a,'Resumed ');const h=a.captureHistory();h.execute('undo');h.dispose();return{gated,failure,ready:a.state.ready,status:a.collaborationStatus.state,text:f.content(a),same:JSON.stringify(record.identity)===JSON.stringify(a.read().identity),controls:!!a.commandControls};});fact.snapshots.push(result);assert.deepEqual(result,{gated:'false',failure:{rejected:true,ready:false,status:'failed'},ready:true,status:'ready',text:'Alpha beta',same:true,controls:true});
});

for (const feature of ['search', 'reorder', 'slash', 'references']) browserCase(`required-${feature}-keeps-synchronous-mount-and-cancels-before-attachment`, async (page, fact) => {
  const result = await page.evaluate(async feature => {
    const f = window.configurationFixture;
    let calls = 0;
    const extension = feature === 'search' ? f.DocumentSearch.configure() : feature === 'reorder' ? f.BlockReorder.configure() : feature === 'slash' ? f.SlashCommands.configure({ commands: [{ id: 'safe', label: 'Safe', prepare() { calls++; return undefined; } }] }) : f.References.configure({ host() { calls++; return []; } });
    const mounted = f.surface({ extensions: [extension] });
    const synchronous = typeof mounted.surface.dispose === 'function' && !('then' in mounted.surface);
    const loading = mounted.surface.extensionStatus[extension.feature.id].state;
    const before = f.content(mounted.engine);
    mounted.surface.dispose();
    const rejected = await mounted.surface.ready.then(() => false, () => true);
    await new Promise(resolve => setTimeout(resolve, 0));
    const absent = !mounted.surface[feature];
    const remounted = f.mountEditorSurface(mounted.host, mounted.engine, { extensions: [extension] });
    f.surfaces.push(remounted); await remounted.ready;
    const enabled = !!remounted[feature], state = remounted.extensionStatus[extension.feature.id].state;
    return { synchronous, loading, rejected, absent, enabled, state, calls, before, after: f.content(mounted.engine) };
  }, feature);
  assert.deepEqual(result, { synchronous: true, loading: 'loading', rejected: true, absent: true, enabled: true, state: 'ready', calls: 0, before: 'Alpha beta', after: 'Alpha beta' });
  fact.requiredPresenterLifecycle = result;
});
