import { init } from '@edit-ac/core';
import { CheckpointStorage } from '@edit-ac/web';
import { installEditorHosts } from '@edit-ac/astro';
import { downloadRecovery } from '../../task-editor/recovery.mjs';

// Importing the server page never executes this browser script. The host opens
// an existing local identity; first-run creation is an explicit application action.
async function options(name) {
  const assetUrl = '/engine.wasm';
  const runtime = await init(assetUrl);
  const databaseName = `astro-task-${name}`;
  const identityKey = `editac-astro-identity-${name}`;
  let identity;
  await navigator.locks.request(`${databaseName}-creation`, async () => {
    identity = JSON.parse(localStorage.getItem(identityKey) ?? 'null');
    if (identity) return;
    const engine = runtime.createEngine({
      profile: 'v5', documentId: crypto.randomUUID(), epoch: crypto.randomUUID(),
      nodes: [{ text: name === 'task' ? 'alpha' : 'beta' }],
    });
    let storage;
    try {
      identity = engine.read().identity;
      localStorage.setItem(identityKey, JSON.stringify(identity));
      storage = await CheckpointStorage.open(indexedDB, databaseName);
      await storage.publish(engine.checkpoint(), []);
    } finally { storage?.close(); engine.dispose(); }
  });
  return { identity, databaseName, assetUrl, indexedDB, locks:navigator.locks, plainPasteControl:false };
}
export const editors = new Map();
const recoveryReports = [];
function status(text) { const node=document.querySelector('#save-status'); if(node) node.textContent=text; }
function retain(result) {
  if (result.unsaved) { recoveryReports.push(result); status('Unsaved content retained. Export recovery before leaving this tab.'); }
}
function controls() {
  const save=document.querySelector('#save');
  if(save) save.onclick=async()=>{ try { for(const editor of editors.values()) await editor.flush({target:'local'}); status('Saved locally. Remote durability is not confirmed.'); } catch(error) { status('Local save failed. Export recovery before closing.'); } };
  const recovery=document.querySelector('#export-recovery');
  if(recovery) recovery.onclick=()=>downloadRecovery([...recoveryReports,...[...editors.values()].filter(e=>e.state.phase==='ready').map(e=>e.recoveryExport())]);
  if(recoveryReports.length) status('Unsaved content retained. Export recovery before leaving this tab.');
}
export const cleanup=installEditorHosts(document, options, {
  onReady(editor,host) { editors.set(host.dataset.editorName,editor); controls(); if(!recoveryReports.length) status('Ready offline. Remote durability is not confirmed.'); },
  onError() { status('Editor loading/saving failed. Keep recovery content before closing.'); },
  onDispose(result,host) { editors.delete(host.dataset.editorName); retain(result); },
});
document.addEventListener('astro:page-load',controls);
