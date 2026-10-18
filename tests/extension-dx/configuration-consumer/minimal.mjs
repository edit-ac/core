import { init } from '@edit-ac/core';
import { createEditor, CheckpointStorage } from '@edit-ac/web';

const assetUrl = new URL('/core/wasm/editac_wasm_bg.wasm', location.href).href;
const runtime = await init(assetUrl);
const seed = runtime.createEngine({ profile: 'v5', documentId: crypto.randomUUID(), epoch: crypto.randomUUID(), nodes: [{ text: 'Alpha beta' }] });
const checkpoint = seed.checkpoint(); seed.dispose();
const databaseName = `minimal-${crypto.randomUUID()}`;
const store = await CheckpointStorage.open(indexedDB, databaseName);
try { await store.publish(checkpoint, []); } finally { store.close(); }
const root = document.createElement('div'); root.id = 'scroll-root'; root.style.cssText = 'min-height:80px;border:1px solid'; document.body.append(root);
const options = { identity: checkpoint.identity, databaseName, indexedDB, locks: navigator.locks, assetUrl, preset: 'default' };
let editor;
window.minimalFixture = {
  root, get editor() { return editor; },
  async mount() { editor = createEditor(root, options); await editor.ready; },
  text() { return editor.read().visible.filter(n => n.kind === 'block').map(n => n.runs.map(r => r.text).join('')).join('\n'); },
  select() { root.focus(); const text = document.createTreeWalker(root, NodeFilter.SHOW_TEXT).nextNode(); document.getSelection().setBaseAndExtent(text, 0, text, 0); document.dispatchEvent(new Event('selectionchange')); },
  async close() { await editor?.destroy({ policy: 'report' }); },
};
