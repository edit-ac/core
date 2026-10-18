import { init } from '@edit-ac/core';
import { createEditor, mountEditorSurface, CheckpointStorage } from '@edit-ac/web';
import { Extension, Spelling } from '@edit-ac/web';
let recipe;
const assetUrl = new URL('/core/wasm/editac_wasm_bg.wasm', location.href).href;
const runtime = await init(assetUrl);
const editors = [], engines = [], surfaces = [], states = [];
function root() { const host = document.createElement('div'); host.style.cssText = 'min-height:50px;padding:12px'; document.body.append(host); return host; }
function engine(text = 'ASD-123') {
  const value = runtime.createEngine({ profile: 'v5', documentId: crypto.randomUUID(), epoch: crypto.randomUUID(), nodes: [{ text }] });
  engines.push(value); return value;
}
async function open(configuration, text, checkpoint, attributes = {}) {
  checkpoint ??= engine(text).checkpoint();
  const databaseName = `spellcheck-${crypto.randomUUID()}`, store = await CheckpointStorage.open(indexedDB, databaseName);
  try { await store.publish(checkpoint, []); } finally { store.close(); }
  const host = root(); for (const [k,v] of Object.entries(attributes)) host.setAttribute(k,v);
  const value = createEditor(host, { identity: checkpoint.identity, databaseName, indexedDB, locks: navigator.locks, assetUrl, ...configuration });
  editors.push(value); await value.ready; return value;
}
function content(value) { return value.read().visible.filter(n => n.kind === 'block').map(n => n.runs.map(r => r.text).join('')).join('\n'); }
function runs(value = window.spelling.editor) { return value.read().visible.find(n => n.kind === 'block').runs; }
function select(host, start = 0, end = start) {
  host.focus(); const walker = document.createTreeWalker(host, NodeFilter.SHOW_TEXT), nodes = []; let n;
  while ((n = walker.nextNode())) nodes.push(n);
  function at(offset) { for (const node of nodes) { if (offset <= node.length) return [node, offset]; offset -= node.length; } throw Error('Selection outside text'); }
  document.getSelection().setBaseAndExtent(...at(start), ...at(end));
  document.dispatchEvent(new Event('selectionchange'));
}
function selection(host = window.spelling.editor.root) {
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
  try { const request = { kind: 'text', origin: 'local:fixture-delete', command: { type: 'delete', range: { anchor: a, focus: b } } }; value.commit(typeof value.prepare === 'function' ? value.prepare(request) : request); }
  finally { value.releaseAnchor(a); value.releaseAnchor(b); }
}
function mark(value, key, from, to) {
  const n = value.read().visible.find(n => n.kind === 'block'), a = value.anchor(n.id, from, 'right'), b = value.anchor(n.id, to, 'left');
  try { value.commit({ kind: 'format', origin: 'local:fixture-mark', marks: [{ range: { anchor: a, focus: b }, mark: key, action: 'apply', ...(key === 'link' ? { href: 'https://manual.example/' } : {}) }], blocks: [] }); }
  finally { value.releaseAnchor(a); value.releaseAnchor(b); }
}
function history(action, value = window.spelling.editor) {
  select(value.root, 0); const h = value.captureHistory(); try { return h.execute(action); } finally { h.dispose(); }
}
async function flush() { await new Promise(r => setTimeout(r, 0)); await window.spelling.editor.settle(); }
function hostState(options) {
  const state = { calls: [], loads: 0, suggestions: [], statuses: [], diagnostics: [], disposed: 0, effects: [] };
  state.container = document.createElement('aside'); state.container.setAttribute('aria-live','polite'); document.body.append(state.container);
  state.host = {
    async load(signal) { state.loads++; state.loadSignal = signal;
      if (options.loadDelayed) await new Promise(resolve => { state.releaseLoad = resolve; });
      if (signal.aborted) throw Error('prepared canceled');
      if (options.loadFailure) throw Error('prepared unavailable');
      recipe ??= await import('./spellcheck.js');
      return { locales: options.locales ?? ['en'], check(word, locale, signal) {
        return new Promise((resolve, reject) => {
          const call = { word, locale, signal, resolve, reject }; state.calls.push(call);
          if (!options.delayed) resolve(options.invalidResult ? ['bad\nresult'] : recipe.preparedChecker.check(word, locale, signal));
        });
      } };
    },
    present(suggestion) { state.suggestions.push(suggestion); const view = recipe.presentSpelling(state.container, suggestion);
      return { dispose() { state.disposed++; view.dispose(); } }; },
    diagnostic: status => state.diagnostics.push(status), status: status => state.statuses.push(status),
    attached: controller => { state.controller = controller; },
  };
  return state;
}
async function start(options = {}) {
  const state = hostState(options);
  const checker = options.classHost ? new class {
    #host = state.host;
    load(signal) { return this.#host.load(signal); }
    present(suggestion) { return this.#host.present(suggestion); }
    diagnostic(status) { this.#host.diagnostic(status); }
    status(status) { this.#host.status(status); }
    attached(controller) { this.#host.attached(controller); }
  }() : state.host;
  const policy = Spelling.configure({ mode: options.mode ?? 'custom', locale: options.unknownLocale ? undefined : options.locale ?? 'en',
    autocorrection: options.autocorrection ?? 'inherit',
    ...((options.mode ?? 'custom') === 'custom' ? { checker, overlap: 'allow' } : {}), timeoutMs: options.timeoutMs ?? 30000 });
  if (options.direct) {
    state.engine = engine(options.text ?? 'teh'); const host = root();
    for (const [k,v] of Object.entries(options.attributes ?? {})) host.setAttribute(k,v);
    state.surface = mountEditorSurface(host, state.engine, policy); surfaces.push(state.surface);
    state.editor = { root: host, read: () => state.engine.read(), commit: r => state.engine.commit(state.engine.prepare(r)),
      anchor: (...args) => state.engine.anchor(...args), releaseAnchor: a => state.engine.releaseAnchor(a),
      setReadOnly: value => state.surface.setReadOnly(value), settle: async () => {}, platformPreferences: state.surface.platformPreferences };
    await state.surface.ready;
  } else state.editor = await open(policy, options.text ?? 'teh', options.checkpoint, options.attributes);
  const value = state.engine ?? state.editor;
  const subscription = value.subscribe({ type: 'all' }, patch => state.effects.push({ operation: patch.operation, origin: patch.origin }));
  state.subscription = { dispose: typeof subscription === 'function' ? subscription : () => subscription.dispose() };
  states.push(state); window.spelling = state; return state;
}
async function close() {
  for (const state of states) state.subscription.dispose();
  for (const e of editors) await e.destroy({ policy: 'report' }); for (const s of surfaces) s.dispose(); for (const e of engines) e.dispose();
}
window.spellingFixture = { runtime, Extension, Spelling, start, open, root, engine, content, runs, select,
  selection, insert, remove, mark, history, flush, close, hostState, mountEditorSurface, surfaces };
