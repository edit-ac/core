import { init } from '@edit-ac/core';
import { createEditor, mountEditorSurface, CheckpointStorage } from '@edit-ac/web';
import { createUrlInsert, preparedUrls, preparedUrlResolver } from './url-insert.js';
import { Notes, NOTE_MIME, NOTE_LIMITS, noteCodec } from './parsing.js';
const assetUrl = new URL('/core/wasm/editac_wasm_bg.wasm', location.href).href;
const runtime = await init(assetUrl);
const editors = [], engines = [], surfaces = [];
function root() { const host = document.createElement('div'); host.style.cssText = 'min-height:50px;padding:12px'; document.body.append(host); return host; }
function engine(text = 'Target') {
  const value = runtime.createEngine({ profile: 'v5', documentId: crypto.randomUUID(), epoch: crypto.randomUUID(), nodes: [{ text }] });
  engines.push(value); return value;
}
async function open(extensions, text, checkpoint) {
  checkpoint ??= engine(text).checkpoint();
  const databaseName = `task-links-${crypto.randomUUID()}`, store = await CheckpointStorage.open(indexedDB, databaseName);
  try { await store.publish(checkpoint, []); } finally { store.close(); }
  const value = createEditor(root(), { identity: checkpoint.identity, databaseName, indexedDB, locks: navigator.locks, assetUrl, extensions });
  editors.push(value); await value.ready; return value;
}
function content(value) { return value.read().visible.filter(n => n.kind === 'block').map(n => n.runs.map(r => r.text).join('')).join('\n'); }
function runs(value = window.task.editor) { return value.read().visible.find(n => n.kind === 'block').runs; }
function select(host, start = 0, end = start) {
  host.focus(); const walker = document.createTreeWalker(host, NodeFilter.SHOW_TEXT), nodes = []; let n;
  while ((n = walker.nextNode())) nodes.push(n);
  function at(offset) { for (const node of nodes) { if (offset <= node.length) return [node, offset]; offset -= node.length; } throw Error('Selection outside text'); }
  document.getSelection().setBaseAndExtent(...at(start), ...at(end));
  document.dispatchEvent(new Event('selectionchange'));
}
function selection(host = window.task.editor.root) {
  const s = document.getSelection(); const offset = (node, end) => { const r = document.createRange(); r.selectNodeContents(host); r.setEnd(node, end); return r.toString().length; };
  return [offset(s.anchorNode, s.anchorOffset), offset(s.focusNode, s.focusOffset)];
}
function insert(value, text, offset, origin = 'text-input:prepared') {
  const n = value.read().visible.find(n => n.kind === 'block'), at = value.anchor(n.id, offset ?? content(value).length, 'right');
  try { const request = { kind: 'text', origin, command: { type: 'insert', at, text } };
    const r = value.commit(typeof value.prepare === 'function' ? value.prepare(request) : request);
    if (r.caret) value.releaseAnchor(r.caret); if (r.selection) { value.releaseAnchor(r.selection.anchor); value.releaseAnchor(r.selection.focus); }
  } finally { value.releaseAnchor(at); }
}
function remove(value, from, to) {
  const n = value.read().visible.find(n => n.kind === 'block'), a = value.anchor(n.id, from, 'right'), b = value.anchor(n.id, to, 'left');
  try { value.commit({ kind: 'text', origin: 'local:fixture-delete', command: { type: 'delete', range: { anchor: a, focus: b } } }); }
  finally { value.releaseAnchor(a); value.releaseAnchor(b); }
}
function mark(value, key, from, to) {
  const n = value.read().visible.find(n => n.kind === 'block'), a = value.anchor(n.id, from, 'right'), b = value.anchor(n.id, to, 'left');
  try { value.commit({ kind: 'format', origin: 'local:fixture-mark', marks: [{ range: { anchor: a, focus: b }, mark: key, action: 'apply', ...(key === 'link' ? { href: 'https://manual.example/' } : {}) }], blocks: [] }); }
  finally { value.releaseAnchor(a); value.releaseAnchor(b); }
}
function history(action, value = window.task.editor) {
  select(value.root, 0); const h = value.captureHistory(); try { return h.execute(action); } finally { h.dispose(); }
}
async function flush() { await new Promise(r => setTimeout(r, 0)); await window.task.editor.settle(); }
function hostState() {
  const state = { permission: { principal: 'alice', tenant: 'prepared-team', authority: 'tasks', revision: 'catalog-1', lookup: true, apply: true }, calls: [], statuses: [], subscriptions: 0 };
  state.statusElement = document.createElement('p'); state.statusElement.setAttribute('role', 'status'); document.body.append(state.statusElement);
  state.host = {
    permission: () => state.permission,
    resolve: request => new Promise((resolve, reject) => state.calls.push({ ...request, resolve, reject,
      async release() { resolve(await preparedUrlResolver(request)); } })),
    onStatus: status => { state.statuses.push(status); state.statusElement.textContent = status; },
    subscribe: invalidate => { state.invalidate = invalidate; state.subscriptions++; return () => { state.subscriptions--; }; },
    attached: controller => { state.controller = controller; },
    literal: patch => patch.origin === 'editac:local:text-input:literal',
  };
  return state;
}
async function start({ notes = true, urls = true, representation = 'link', text = 'Target', options = {}, checkpoint, direct = false } = {}) {
  const state = hostState(), extensions = [...(notes ? [Notes.configure()] : []), ...(urls ? [createUrlInsert({ ...state.host, representation }).configure(options)] : [])];
  if (direct) {
    state.engine = engine(text); state.surface = mountEditorSurface(root(), state.engine, { extensions });
    surfaces.push(state.surface); await state.surface.ready;
  } else state.editor = await open(extensions, text, checkpoint);
  window.task = state; return state;
}
async function close() { for (const e of editors) await e.destroy({ policy: 'report' }); for (const s of surfaces) s.dispose(); for (const e of engines) e.dispose(); }
window.parsingFixture = { runtime, Notes, NOTE_MIME, NOTE_LIMITS, noteCodec, createUrlInsert, preparedUrls, preparedUrlResolver, start, open, root, engine,
  content, runs, select, selection, insert, remove, mark, history, flush, close, hostState, mountEditorSurface, surfaces };
