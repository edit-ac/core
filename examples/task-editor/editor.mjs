import {markdownOptions} from './markdown.mjs';
import {retainRecovery,recoveryReports,downloadRecovery} from './recovery.mjs';
import { init } from '@edit-ac/core';
import { CheckpointStorage, createEditor, taskPreset } from '@edit-ac/web';

// This example owns one explicit local document. Recovery never seeds content.
const identity = { documentId: '', epoch: '', schema: 'editac.registry.editor.v5', offsets: 'utf16', profile: 'editac.yrs-yjs.editor.v5', protocolVersion: 1, updateEncoding: 1 };
const options = { assetUrl: '/core/wasm/editac_wasm_bg.wasm', databaseName: 'standalone-task', identity, indexedDB, locks: navigator.locks, ...taskPreset() };
const root = document.querySelector('#editor'), message = document.querySelector('#message');
const save = document.querySelector('#save'), reopen = document.querySelector('#reopen');
let unsubscribe;
export let editor;
async function open() {
  editor = createEditor(root, {...options, ...await markdownOptions()});
  unsubscribe = editor.subscribe(state => {
    if (state.error) message.textContent = 'Local save failed. Keep this tab open and export recovery content.';
    else if (state.localCommitted) message.textContent = 'Saved locally. Remote durability is not confirmed.';
  });
  await editor.ready;
  save.disabled = reopen.disabled = false;
  message.textContent = 'Task ready offline';
  return editor;
}
async function start() {
  // Persist creation intent before publishing. Subsequent opening never
  // re-seeds a missing/corrupt checkpoint; a new document uses a fresh identity.
  await navigator.locks.request('standalone-task-creation', async () => {
    const saved = localStorage.getItem('standalone-task-identity');
    if (saved) { Object.assign(identity, JSON.parse(saved)); return; }
    identity.documentId = crypto.randomUUID(); identity.epoch = crypto.randomUUID();
    localStorage.setItem('standalone-task-identity', JSON.stringify(identity));
    const runtime = await init(options.assetUrl);
    const engine = runtime.createEngine({ profile: 'v5', documentId: identity.documentId, epoch: identity.epoch, nodes: [{ text: 'Plan the task' }] });
    let checkpoints;
    try { checkpoints = await CheckpointStorage.open(indexedDB, options.databaseName); await checkpoints.publish(engine.checkpoint(), []); }
    finally { checkpoints?.close(); engine.dispose(); }
  });
  return open();
}
export const ready = start();
export async function saveLocally() { await editor.flush({ target: 'local' }); message.textContent = 'Saved locally. Remote durability is not confirmed.'; }
export async function reopenOffline() {
  save.disabled = reopen.disabled = true;
  unsubscribe?.();
  await editor.destroy({ policy: 'flush' });
  return open();
}
export function attachTaskSync(authorizedHostOptions) { return editor.attachSync(authorizedHostOptions); }
export async function close() { unsubscribe?.(); try { return await editor.destroy({policy:'flush'}); } catch(error) { const result=await editor.destroy({policy:'report'});retainRecovery(result);report(error);return result; } }
document.querySelector('#export-recovery').onclick=()=>downloadRecovery([...recoveryReports,...(editor?.state.ready?[editor.recoveryExport()]:[])]);
function report(error) { message.textContent = `Unable to open or save task: ${error.message}`; }
save.addEventListener('click', () => { void saveLocally().catch(report); });
reopen.addEventListener('click', () => { void reopenOffline().catch(report); });
void ready.catch(report);
