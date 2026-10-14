import { init } from '@edit-ac/core';
import { initMarkdown } from '@edit-ac/markdown';
import { CheckpointStorage } from '@edit-ac/web';
import { openTutorial } from './tutorial.mjs';
const definitions = await (await fetch('/definitions.json')).json();
const identity = await (await fetch('/fixtures/identity.json')).json();
const runtime = await init('/engine.wasm'), codec = await initMarkdown('/markdown.wasm');
const store = await CheckpointStorage.open(indexedDB, 'extension-tutorial');
try {
  let exists = true;
  try { await store.restore(identity, state => {
    const restored = runtime.restoreEngine(identity, state.checkpoint, state.tail); restored.dispose();
  }); } catch (error) {
    if (error.message !== 'No valid recovery checkpoint: missing checkpoint') throw error;
    exists = false;
  }
  if (!exists) {
    const engine = runtime.restoreEngine(identity, { identity, initialized: true, writerId: 11,
      bytes: new Uint8Array(await (await fetch('/fixtures/custom-checkpoint.bin')).arrayBuffer()) });
    try { await store.publish(engine.checkpoint(), []); } finally { engine.dispose(); }
  }
} finally { store.close(); }
let tutorial, presenters = true, readOnly = false;
async function open() {
  tutorial = await openTutorial(document.querySelector('#editor'), { definitions, identity,
    databaseName: 'extension-tutorial', assetUrl: '/engine.wasm', indexedDB, locks: navigator.locks, presenters, readOnly });
  document.querySelector('#status').textContent = `Presenters ${presenters ? 'enabled' : 'disabled'}; ${readOnly ? 'read-only' : 'editable'}`;
}
await open();
document.querySelector('#toggle').onclick = async () => { await tutorial.dispose(); presenters = !presenters; await open(); };
document.querySelector('#readonly').onclick = () => { readOnly = !readOnly; tutorial.editor.setReadOnly(readOnly); };
document.querySelector('#note').onclick = async () => {
  const owner = tutorial.editor.read().visible.find(n => n.kind === 'block' && n.id !== 'n:11:1').id;
  const result = await tutorial.insertNote(codec, owner, '[note] Hello 😀');
  document.querySelector('#status').textContent = result.status;
};
// Explicit disposal is required before discarding a live replica.
window.tutorial = () => tutorial;
