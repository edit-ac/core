import { init } from '@edit-ac/core';
import { initMarkdown } from '@edit-ac/markdown';
import { createEditor, CheckpointStorage, openEditorStorage, mountEditorSurface, Extension } from '@edit-ac/web';
import { ModuleRegistry } from '@edit-ac/core/extensions';
import { ExtensionCommandSession } from '@edit-ac/web/modules';
import { kickoffSource, prepareCallout, createKickoffExtensions, calloutPresenter, bindEmphasisMenu, highlightDefinition } from './recipe.mjs';
const assetUrl = new URL('/engine.wasm', location.href).href;
const runtime = await init(assetUrl), codec = await initMarkdown(new URL('/markdown.wasm', location.href).href);
const owned = [], borrowed = [], seeds = [], hosts = [], disposers = [];
const root = () => { const host = document.createElement('div'); host.style.cssText = 'border:1px solid;padding:20px;margin:10px'; document.body.append(host); hosts.push(host); return host; };
function seedEngine(text = 'Project kickoff') { const engine = runtime.createEngine({ profile: 'v5', documentId: crypto.randomUUID(), epoch: crypto.randomUUID(), nodes: [{ text }] }); seeds.push(engine); return engine; }
async function seed(checkpoint = seedEngine().checkpoint()) {
  const databaseName = 'kickoff-' + crypto.randomUUID(), store = await CheckpointStorage.open(indexedDB, databaseName);
  try { await store.publish(checkpoint, []); } finally { store.close(); }
  return { identity: checkpoint.identity, databaseName, indexedDB, locks: navigator.locks, assetUrl };
}
async function open({ checkpoint, options = {}, storage, enabled = true, advanced = false } = {}) {
  const config = storage ?? await seed(checkpoint), host = root(), stats = {}; let context;
  const assembly = advanced ? { modules: new ModuleRegistry().register(highlightDefinition, {tag:'mark'}).freeze(), content: calloutPresenter(codec, stats) } : { extensions: enabled ? createKickoffExtensions(codec, { onAttach(_, ctx) { context = ctx; } }) : [] };
  const editor = createEditor(host, { ...config, ...assembly, ...options }); owned.push(editor); await editor.ready;
  const button = document.createElement('button'); button.textContent = 'Emphasize Friday'; document.body.append(button);
  const disposeMenu = bindEmphasisMenu(editor, button, stats); disposers.push(disposeMenu);
  return { editor, host, stats, config, button, disposeMenu, get context() { return context; } };
}
function blocks(editor) { return editor.read().visible.filter(n => n.kind === 'block'); }
function select(editor, index = 0, start = 0, end = start) {
  const n = blocks(editor)[index], element = editor.root.querySelector(`[data-node-id="${n.id}"]`); const walker = document.createTreeWalker(element, NodeFilter.SHOW_TEXT); const text = walker.nextNode();
  if (!text) throw Error('Missing canonical selectable text');
  const texts=[text];for(let next; (next=walker.nextNode());)texts.push(next);
  const cut=offset=>{let left=offset;for(const value of texts){if(left<=value.length)return [value,left];left-=value.length;}throw Error('Selection outside canonical text');};
  const [a,from]=cut(start),[b,to]=cut(end);editor.root.focus();document.getSelection().setBaseAndExtent(a,from,b,to);document.dispatchEvent(new Event('selectionchange'));
}
function release(editor, result) { if (result?.caret) editor.releaseAnchor(result.caret); if (result?.selection) { editor.releaseAnchor(result.selection.anchor); editor.releaseAnchor(result.selection.focus); } }
function fill(editor, values) { const node = blocks(editor)[0], a = editor.anchor(node.id, 0, 'right'), b = editor.anchor(node.id, node.runs.reduce((n,r) => n+r.text.length,0), 'left'); try { const r = editor.commit({ kind: 'fragment', origin: 'local:kickoff-fixture', range: { anchor:a, focus:b }, blocks: values }); release(editor,r); } finally { editor.releaseAnchor(a); editor.releaseAnchor(b); } }
async function insert(value, source = kickoffSource) { select(value.editor,0,0,blocks(value.editor)[0].runs.map(r=>r.text).join('').length); const result = value.editor.runExtensionCommand('demo.kickoff','callout',source); await value.editor.settle(); return result; }
function snapshot(editor) { return JSON.parse(JSON.stringify(editor.read())); }
async function close() { for (const dispose of disposers) dispose(); for (const editor of owned) await editor.destroy({policy:'flush'}); for (const {surface,owner} of borrowed) { surface.dispose(); await owner.destroy({policy:'flush'}); } for (const engine of seeds) engine.dispose(); }
window.callout = { runtime,codec,root,seedEngine,seed,open,blocks,select,fill,insert,snapshot,release,close,owned,borrowed,openEditorStorage,mountEditorSurface,Extension,ModuleRegistry,ExtensionCommandSession,kickoffSource,prepareCallout,createKickoffExtensions,highlightDefinition };
