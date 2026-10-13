import { createElement as h, StrictMode, Profiler } from 'react';
import { createRoot } from 'react-dom/client';
import { EditorHost, useEditor, useEditorState } from '@edit-ac/react';
import { init } from '@edit-ac/core';
import { CheckpointStorage } from '@edit-ac/web';
import { recoverLocalDocument } from '/web/entry.js';

const runtime = await init('/core/wasm/editac_wasm_bg.wasm');
const facts = { recoveries: 0, disposed: 0, live: 0, peak: 0, renders: 0, ready: 0, reports: [], errors: [], statusRenders: 0 };
let reactRoot, toolbarRoot, editor, currentOptions, releaseRecovery, releaseSave;
let slowRecovery = false, slowSave = false, failSave = false;
const identities = [], options = [];
for (let i = 0; i < 2; i++) {
  const engine = runtime.createEngine({ profile:'v5', documentId:crypto.randomUUID(), epoch:crypto.randomUUID(), nodes:[{text:i ? 'beta' : 'alpha'}] });
  const identity = engine.read().identity; identities.push(identity);
  const databaseName = `react-fixture-${i}`;
  const checkpoints = await CheckpointStorage.open(indexedDB, databaseName);
  try { await checkpoints.publish(engine.checkpoint(), []); } finally { checkpoints.close(); engine.dispose(); }
  options.push({identity, databaseName, assetUrl:'/core/wasm/editac_wasm_bg.wasm', indexedDB, locks:navigator.locks, plainPasteControl:false, recover: async opts => {
    facts.recoveries++;
    if (slowRecovery) await new Promise(resolve => { releaseRecovery = resolve; });
    const session = await recoverLocalDocument(opts); facts.live++; facts.peak = Math.max(facts.peak, facts.live);
    const destroy = session.storage.destroy.bind(session.storage); let disposed = false;
    session.storage.destroy = async config => {
      if (config.policy === 'flush' && slowSave) await new Promise(resolve => { releaseSave = resolve; });
      if (config.policy === 'flush' && failSave) throw Error('prepared local save failure');
      const report = await destroy(config);
      if (!disposed) { disposed = true; facts.live--; facts.disposed++; }
      return report;
    };
    return session;
  }});
}
function Toolbar({editor}) {
  const state = useEditorState(editor); facts.statusRenders++;
  return h('output', null, state?.phase ?? 'none');
}
const events = {
  onReady(instance) { editor = instance; facts.ready++; toolbarRoot?.render(h(Toolbar, {editor})); },
  onError(error) { facts.errors.push(error.message); },
  onDispose(report) { facts.reports.push({unsaved:report.unsaved, recovery:!!report.recovery}); },
};
function HookHost({options}) {
  const ref = ReactRef(); const instance = useEditor(ref, options, events);
  return h('div', {ref, 'data-host':'editor'});
}
// A separate hook host exercises the public hook without owning document state.
import { useRef as ReactRef } from 'react';
function render(index = 0, config = {}) {
  currentOptions = config.failInit ? {...options[index], recover:async()=>{throw Error('prepared recovery failure');}} : options[index];
  if (!reactRoot) reactRoot = createRoot(document.querySelector('#host'));
  if (!toolbarRoot) toolbarRoot = createRoot(document.querySelector('#toolbar'));
  const host = config.hook ? h(HookHost, {options:currentOptions}) : h(EditorHost, {options:currentOptions, readOnly:config.readOnly ?? false, attributes:{'data-host':'editor'}, ...events});
  reactRoot.render(h(StrictMode, null, h(Profiler, {id:'host', onRender(){facts.renders++;}}, host)));
}
async function unmount() {
  toolbarRoot?.unmount(); toolbarRoot = undefined;
  reactRoot?.unmount(); reactRoot = undefined;
}
function select(start, end=start) {
  editor.root.focus(); const block = editor.read().visible.find(n=>n.kind==='block');
  const a = editor.selection.toDOM({node:block.id,offset:start,bias:'right'}), b = editor.selection.toDOM({node:block.id,offset:end,bias:'left'});
  document.getSelection().setBaseAndExtent(a.node,a.offset,b.node,b.offset); editor.selection.capture();
}
window.reactFixture = {facts, options, render, unmount, select, get editor(){return editor;},
  text(){return editor.read().visible.filter(n=>n.kind==='block').map(n=>n.runs.map(r=>r.text).join(''));},
  slowRecovery(){slowRecovery=true;}, releaseRecovery(){slowRecovery=false; releaseRecovery?.();},
  slowSave(){slowSave=true;}, releaseSave(){slowSave=false; releaseSave?.();}, failSave(){failSave=true;},
};
window.inputFixture = {async destroy(){await unmount(); window.reactFixture.releaseRecovery(); window.reactFixture.releaseSave();
  const pending = editor?.state.phase !== 'destroyed' ? editor?.destroy({policy:'report'}) : undefined; await pending;
}};
render();
