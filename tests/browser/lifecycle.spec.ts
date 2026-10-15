import assert from 'node:assert/strict';
import { test } from 'node:test';
import { browserHarness } from './browser-harness.ts';
import { prepareEditor } from './editor-test-utils.ts';
const {probe}=browserHarness('lifecycle','fixtures/browser-input',{sourcePaths:['tests/browser/editor-test-utils.ts','packages/web/src/editor.ts','packages/web/src/surface.ts']});
test('public SDK methods reject unsupported targets and commands without fake success',()=>probe('sdk-errors',async(page,fact)=>{
  await prepareEditor(page);
  const result=await page.evaluate(async()=>{
    const editor=window.activeEditor=window.mountBrowserEditor(window.inputFixture.root,window.editorOptions);
    await editor.ready;
    const before=editor.read(), failures={};
    try { await editor.flush({target:'remote'}); } catch(error) { failures.flush=error.message; }
    try { editor.commit({kind:'editor',origin:'local:sdk',commands:[{type:'unsupported'}]}); } catch(error) { failures.command={code:error.code,operation:error.operation}; }
    try { await editor.destroy({policy:'unsupported'}); } catch(error) { failures.destroy=error.message; }
    const readyAfterInvalidDestroy=editor.state.ready;
    editor.setReadOnly(true);
    try { editor.commit({kind:'editor',origin:'local:sdk',commands:[]}); } catch(error) { failures.readOnly=error.message; }
    const after=editor.read();
    await editor.flush({target:'local'});
    let notifications=0;const unsubscribe=editor.subscribe(()=>notifications++);unsubscribe();
    const count=notifications;
    await editor.destroy({policy:'flush'});
    return {before,after,failures,readyAfterInvalidDestroy,unsubscribed:notifications===count};
  });
  fact.snapshots.push(result);
  assert.deepEqual(result.after,result.before);
  assert.equal(result.failures.flush,'Unsupported flush target');
  assert.deepEqual(result.failures.command,{code:'InvalidInput',operation:'prepare'});
  assert.equal(result.failures.destroy,'Explicit destroy policy required');
  assert.equal(result.failures.readOnly,'Editor is read-only');
  assert.equal(result.readyAfterInvalidDestroy,true);assert.equal(result.unsubscribed,true);
}));
test('stale preview is never editable and recovered content replaces it before ready',()=>probe('stale-preview',async(page,fact)=>{
  await prepareEditor(page);
  const s=await page.evaluate(async()=>{const root=window.inputFixture.root;root.textContent='stale preview';const e=window.activeEditor=window.mountBrowserEditor(root,{...window.editorOptions,preview:{identity:{...window.editorOptions.identity},revision:999}});const before={...e.state,editable:root.contentEditable};window.states=[];e.subscribe(s=>window.states.push({...s,error:!!s.error}));await e.ready;return {before,after:e.state,editable:root.contentEditable,text:root.textContent,states:window.states};});
  fact.snapshots.push(s);assert.equal(s.before.visible,true);assert.equal(s.before.ready,false);assert.equal(s.before.editable,'false');assert.equal(s.after.preview,'replaced');assert.equal(s.after.ready,true);assert.equal(s.editable,'true');assert.match(s.text,/alpha/);assert.doesNotMatch(s.text,/stale/);
}));
test('matching metadata still binds authoritative mappings instead of editable host DOM',()=>probe('matched-preview',async(page,fact)=>{
  await prepareEditor(page);const s=await page.evaluate(async()=>{const root=window.inputFixture.root;root.textContent='forged content';const e=window.activeEditor=window.mountBrowserEditor(root,{...window.editorOptions,preview:{identity:window.editorOptions.identity,revision:0}});await e.ready;return {state:e.state,text:root.textContent};});fact.snapshots.push(s);assert.equal(s.state.preview,'matched');assert.match(s.text,/alpha/);assert.doesNotMatch(s.text,/forged/);
}));
test('document identity/schema mismatch cannot adopt preview',()=>probe('identity-preview',async(page,fact)=>{await prepareEditor(page);const s=await page.evaluate(async()=>{const e=window.activeEditor=window.mountBrowserEditor(window.inputFixture.root,{...window.editorOptions,preview:{identity:{...window.editorOptions.identity,documentId:'wrong'},revision:0}});await e.ready;return e.state;});fact.snapshots.push(s);assert.equal(s.preview,'replaced');assert.equal(s.ready,true);}));
test('local activation needs no network after WASM asset initialization',()=>probe('offline-local',async(page,fact)=>{
  await prepareEditor(page);await page.route('**/*',route=>route.abort());const s=await page.evaluate(async()=>{const e=window.activeEditor=window.mountBrowserEditor(window.inputFixture.root,window.editorOptions);await e.ready;window.selectEditor(0,5);e.paste({getData:t=>t==='text/plain'?'offline':''},{literal:true});await e.flush({target:'local'});return {state:e.state,text:e.read().visible[0].runs.map(r=>r.text).join('')};});fact.snapshots.push(s);assert.equal(s.state.ready,true);assert.equal(s.text,'alphaoffline');assert.ok(s.state.localCommitted);
}));
test('initialization failure leaves accessible read-only preview and observable failure',()=>probe('recovery-failure',async(page,fact)=>{
  await prepareEditor(page);const s=await page.evaluate(async()=>{const root=window.inputFixture.root;root.textContent='recovery preview';const e=window.activeEditor=window.mountBrowserEditor(root,{...window.editorOptions,recover:async()=>{throw Error('fixture corrupt recovery');}});let failure;try{await e.ready;}catch(error){failure=error.message;}return {failure,state:{...e.state,error:!!e.state.error},editable:root.contentEditable,text:root.textContent,alert:root.nextElementSibling?.getAttribute('role')};});fact.snapshots.push(s);assert.equal(s.failure,'fixture corrupt recovery');assert.equal(s.state.phase,'failed');assert.equal(s.state.ready,false);assert.equal(s.editable,'false');assert.equal(s.text,'recovery preview');assert.equal(s.alert,'alert');
}));
test('ready and actual localCommitted are distinct, scoped observable events',()=>probe('commit-state',async(page,fact)=>{await prepareEditor(page);const s=await page.evaluate(async()=>{const e=window.activeEditor=window.mountBrowserEditor(window.inputFixture.root,window.editorOptions);await e.ready;const initial=e.state;window.states=[];const unsubscribe=e.subscribe(s=>window.states.push({phase:s.phase,commit:!!s.localCommitted,error:!!s.error}));window.selectEditor(0,5);e.paste({getData:t=>t==='text/plain'?'saved':''},{literal:true});await e.flush({target:'local'});unsubscribe();return {initial,final:e.state,states:window.states};});fact.snapshots.push(s);assert.equal(s.initial.ready,true);assert.equal(s.initial.localCommitted,null);assert.ok(s.final.localCommitted);assert.ok(s.states.some(s=>s.commit));}));
test('mount read-only, pre-ready transition and duplicate mount preserve authority',()=>probe('readonly-mount',async(page,fact)=>{await prepareEditor(page);const s=await page.evaluate(async()=>{const root=window.inputFixture.root,e=window.activeEditor=window.mountBrowserEditor(root,{...window.editorOptions,readOnly:false});e.setReadOnly(true);let duplicate;try{window.mountBrowserEditor(root,window.editorOptions);}catch(error){duplicate=error.message;}await e.ready;return {state:e.state,editable:root.contentEditable,duplicate,paste:e.paste({getData:()=> 'bad'})};});fact.snapshots.push(s);assert.equal(s.state.readOnly,true);assert.equal(s.editable,'false');assert.equal(s.paste.disposition,'rejected');assert.equal(s.duplicate,'Editor already mounted on this surface');}));

test('ordinary activation avoids the preview-only full projection while preview admission remains canonical', () => probe('activation-projections', async (page, fact) => {
  await prepareEditor(page);
  const observations = await page.evaluate(async () => {
    const { recoverLocalDocument } = await import('/web/entry.js');
    const rows = [];
    for (const preview of [undefined, { identity: window.editorOptions.identity, revision: 0 }, { identity: { ...window.editorOptions.identity, documentId: 'wrong' }, revision: 0 }]) {
      let reads = 0;
      const root = document.createElement('div'); root.textContent = 'untrusted preview'; document.body.append(root);
      const editor = window.activeEditor = window.mountBrowserEditor(root, { ...window.editorOptions, preview,
        recover: async options => {
          const session = await recoverLocalDocument(options), engine = session.writer.engine, read = engine.read.bind(engine);
          // Engine handles are frozen; observe through a forwarding port instead
          // of assigning a method that browsers may silently leave unchanged.
          const observedEngine = new Proxy({}, { get: (_, key) => key === 'read' ? () => { reads++; return read(); } : Reflect.get(engine, key, engine) });
          const writer = new Proxy(session.writer, { get: (target, key) => key === 'engine' ? observedEngine : Reflect.get(target, key, target) });
          return { ...session, writer };
        } });
      try { await editor.ready; rows.push({ reads, preview: editor.state.preview, text: root.textContent, ready: editor.state.ready }); }
      finally { await editor.destroy({ policy: 'flush' }); root.remove(); }
    }
    return rows;
  });
  fact.snapshots.push(observations);
  assert.deepEqual(observations.map(r => r.preview), ['none', 'matched', 'replaced']);
  assert.equal(observations[0].reads > 0, true);
  assert.equal(observations[1].reads, observations[0].reads + 1);
  assert.equal(observations[2].reads, observations[0].reads + 1);
  for (const row of observations) { assert.equal(row.ready, true); assert.match(row.text, /alpha/); assert.doesNotMatch(row.text, /untrusted/); }
}));
