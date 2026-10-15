// Installed-tarball fixture: all semantics, recovery, persistence and disposal
// run through public production ports. Counters observe issued/released sessions.
import { init } from '@edit-ac/core';
import { Engine } from '/core/wasm/editac_wasm.js';
import { CheckpointStorage, createEditor, taskPreset } from '@edit-ac/web';
import { recoverLocalDocument } from '/web/entry.js';
const assetUrl = '/core/wasm/editac_wasm_bg.wasm';
// Observe the generated production restore/free boundary without replacing its
// runtime, allocation or semantics. All post-reload document opens use restore;
// explicit creation belongs to the preceding seed realm and is reported apart.
const nativeHandles = { restored: 0, freed: 0, live: 0, peak: 0 }, issued = new WeakSet();
const restore = Engine.restore, free = Engine.prototype.free;
Engine.restore = function (...args) { const engine = restore.apply(this, args); issued.add(engine); nativeHandles.restored++; nativeHandles.live++; nativeHandles.peak = Math.max(nativeHandles.peak, nativeHandles.live); return engine; };
Engine.prototype.free = function (...args) { const result = free.apply(this, args); if (issued.delete(this)) { nativeHandles.freed++; nativeHandles.live--; } return result; };
const records = new Map(), live = new Map();
const observations = { recovered: 0, released: 0, callbacks: {}, late: [], timings: {} };
let sequence = 0;
const text = editor => editor.read().visible.filter(n => n.kind === 'block').map(n => n.runs.map(r => r.text).join('')).join('\n');
async function seed(names = ['description', 'comment']) {
  const runtime = await init(assetUrl);
  for (const name of names) {
    const databaseName = `shared-${name}-${crypto.randomUUID()}`;
    const engine = runtime.createEngine({ profile: 'v5', documentId: crypto.randomUUID(), epoch: crypto.randomUUID(), nodes: [{ text: name }] });
    const store = await CheckpointStorage.open(indexedDB, databaseName);
    try { const checkpoint = engine.checkpoint(); await store.publish(checkpoint, []); records.set(name, { databaseName, identity: checkpoint.identity }); }
    finally { store.close(); engine.dispose(); }
  }
  sessionStorage.setItem('shared-records', JSON.stringify([...records]));
}
for (const [name, record] of JSON.parse(sessionStorage.getItem('shared-records') ?? '[]')) records.set(name, record);
async function markdown() {
  const [{ initMarkdown }, { markdownExtension }] = await Promise.all([import('@edit-ac/markdown'), import('/markdown/web.js')]);
  return markdownExtension(await initMarkdown('/markdown/wasm/editac_markdown_wasm_bg.wasm'));
}
function mount(name, { optional, readOnly = false, preset = 'task' } = {}) {
  const record = records.get(name); if (!record) throw Error(`Seed missing: ${name}`);
  const root = document.createElement('div'); root.id = `${name}-${++sequence}`; document.querySelector('#editors').append(root);
  const key = root.id;
  const started = performance.now();
  const editor = createEditor(root, { ...record, assetUrl, indexedDB, locks: navigator.locks,
    ...(preset === 'task' ? taskPreset() : { preset: 'minimal' }), markdown: optional,
    plainTextPolicy: optional ? 'markdown' : 'literal', readOnly, label: name,
    recover: async options => {
      const session = await recoverLocalDocument(options); observations.recovered++;
      const destroy = session.storage.destroy.bind(session.storage); let released = false;
      session.storage.destroy = async options => { const result = await destroy(options); if (!released) { released = true; observations.released++; } return result; };
      return session;
    },
  });
  observations.timings[key] = { started };
  void editor.ready.then(() => { observations.timings[key].readyMs = performance.now() - started; requestAnimationFrame(() => { observations.timings[key].firstFrameMs = performance.now() - started; }); }, () => {});
  const off = editor.subscribe(state => { observations.callbacks[key] = (observations.callbacks[key] ?? 0) + 1; if (state.phase === 'ready' && !root.isConnected) observations.late.push(key); });
  live.set(key, { editor, root, off }); return key;
}
function get(key) { const value = live.get(key); if (!value) throw Error(`Unknown mount ${key}`); return value.editor; }
async function destroy(key, policy = 'flush') {
  const value = live.get(key); if (!value) return;
  const report = await value.editor.destroy({ policy }); value.off(); value.root.remove(); live.delete(key); return report;
}
function append(key, value) {
  const started = performance.now();
  const editor = get(key), block = editor.read().visible.find(n => n.kind === 'block');
  const at = editor.anchor(block.id, block.runs.reduce((n, r) => n + r.text.length, 0));
  try { editor.chain().command({ type: 'insert', at, text: value }).run(); } finally { editor.releaseAnchor(at); }
  observations.timings[key].acceptedEditMs = performance.now() - started;
}
window.shared = { seed, markdown, mount, get, destroy, append, text: key => text(get(key)), observations, records,
  ready: key => get(key).ready, flush: key => get(key).flush({ target: 'local' }),
  async cleanup() { for (const key of [...live.keys()]) await destroy(key, 'report'); },
  state: () => ({ ...observations, nativeHandles: { ...nativeHandles }, callbacks: { ...observations.callbacks }, live: [...live.keys()], roots: document.querySelectorAll('#editors > [role=textbox]').length, domNodes: document.querySelector('#editors').childElementCount }),
};
