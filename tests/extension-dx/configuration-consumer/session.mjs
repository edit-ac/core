import { init } from '@edit-ac/core';
import { createEditor, mountEditorSurface, CheckpointStorage, DocumentSearch, BlockReorder, defaultPreset, documentPreset, taskPreset } from '@edit-ac/web';
const assetUrl = new URL('/core/wasm/editac_wasm_bg.wasm', location.href).href;
const runtime = await init(assetUrl);
const editors = [], surfaces = [], engines = [];
function root(attributes = {}) {
  const element = document.createElement('div');
  element.style.cssText = 'min-height:40px;border:1px solid;padding:8px;margin:8px';
  for (const [key, value] of Object.entries(attributes)) element.setAttribute(key, value);
  document.body.append(element); return element;
}
function engine(text = 'Alpha beta') {
  const value = runtime.createEngine({ profile: 'v5', documentId: crypto.randomUUID(), epoch: crypto.randomUUID(), nodes: [{ text }] });
  engines.push(value); return value;
}
async function seed(text = 'Alpha beta', suppliedCheckpoint) {
  const checkpoint = suppliedCheckpoint ?? engine(text).checkpoint(), databaseName = `dx-${crypto.randomUUID()}`;
  const store = await CheckpointStorage.open(indexedDB, databaseName);
  try { await store.publish(checkpoint, []); } finally { store.close(); }
  return { identity: checkpoint.identity, databaseName, indexedDB, locks: navigator.locks, assetUrl };
}
async function open(options = {}, attributes = {}, text) {
  const host = root(attributes), storage = await seed(text);
  const value = createEditor(host, { ...storage, ...options }); editors.push(value);
  await value.ready; return value;
}
function surface(options = {}, attributes = {}, text) {
  const host = root(attributes), value = engine(text);
  const mounted = mountEditorSurface(host, value, options); surfaces.push(mounted);
  return { host, engine: value, surface: mounted };
}
function content(value) { return value.read().visible.filter(n => n.kind === 'block').map(n => n.runs.map(r => r.text).join('')).join('\n'); }
function select(host, start = 0, end = start) {
  host.focus(); const walker = document.createTreeWalker(host, NodeFilter.SHOW_TEXT);
  const text = walker.nextNode(); if (!text) throw Error('Missing canonical text');
  document.getSelection().setBaseAndExtent(text, start, text, end);
  document.dispatchEvent(new Event('selectionchange'));
}
function replace(value, text, offset = 0) {
  const owner = value.read().visible.find(n => n.kind === 'block').id;
  const at = value.anchor(owner, offset);
  try { const result = value.commit({ kind: 'text', origin: 'local:configuration', command: { type: 'insert', at, text } });
    if (result.caret) value.releaseAnchor(result.caret);
    if (result.selection) { value.releaseAnchor(result.selection.anchor); value.releaseAnchor(result.selection.focus); }
  } finally { value.releaseAnchor(at); }
}
async function close() {
  for (const value of editors) await value.destroy({ policy: 'report' });
  for (const value of surfaces) value.dispose();
  for (const value of engines) value.dispose();
}
window.configurationFixture = { runtime, root, engine, seed, open, surface, content, select, replace, close, createEditor, mountEditorSurface, DocumentSearch, BlockReorder, defaultPreset, documentPreset, taskPreset, editors };
