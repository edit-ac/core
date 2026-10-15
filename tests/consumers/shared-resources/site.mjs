// One installed production graph. Host navigation is deliberately explicit so
// teardown completes before another document gains the editable surface.
import { init } from '@edit-ac/core';
import { createEditor, CheckpointStorage, taskPreset } from '@edit-ac/web';
import assetUrl from '@edit-ac/core/wasm?url';
const release = Object.freeze({ ...__EDITAC_RELEASE__, assetUrl });
if (document.querySelector('meta[name=editac-build]').content !== release.build || document.querySelector('meta[name=editac-engine]').content !== release.engineSha256) throw Error('Incompatible deployed page/glue build');
// Deployment admission belongs to this host, not the shared engine loader.
// A stale page cannot silently initialize a different manifest's glue/binary.
function admitRelease(candidate) {
  if (candidate.build !== release.build || candidate.engineSha256 !== release.engineSha256) throw Error('Incompatible deployed build');
  if (candidate.assetUrl !== release.assetUrl) throw Error('Conflicting deployed asset URL');
  return init(candidate.assetUrl);
}
const records = new Map(JSON.parse(sessionStorage.getItem('site-documents') ?? '[]'));
const live = new Map(), timings = [], reports = [];
let runtime, sequence = 0;
const text = editor => editor.read().visible.filter(n => n.kind === 'block').map(n => n.runs.map(r => r.text).join('')).join('\n');
async function seed() {
  runtime = await init(assetUrl);
  for (const name of ['description', 'comment', 'document']) {
    if (records.has(name)) continue;
    const databaseName = 'site-' + name + '-' + crypto.randomUUID();
    const engine = runtime.createEngine({ profile: 'v5', documentId: crypto.randomUUID(), epoch: crypto.randomUUID(), nodes: [{ text: name }] });
    const store = await CheckpointStorage.open(indexedDB, databaseName);
    try { const checkpoint = engine.checkpoint(); await store.publish(checkpoint, []); records.set(name, { databaseName, identity: checkpoint.identity }); }
    finally { store.close(); engine.dispose(); }
  }
  sessionStorage.setItem('site-documents', JSON.stringify([...records]));
}
async function options(name, optional = false) {
  const extension = optional ? await import('@edit-ac/markdown').then(async ({ initMarkdown }) => {
    const { markdownExtension } = await import('@edit-ac/markdown/web');
    const { default: markdownUrl } = await import('@edit-ac/markdown/wasm?url');
    return markdownExtension(await initMarkdown(markdownUrl));
  }) : undefined;
  return { ...records.get(name), ...taskPreset(), assetUrl, indexedDB, locks: navigator.locks,
    markdown: extension, plainTextPolicy: optional ? 'markdown' : 'literal', label: name };
}
async function mount(binding = 'plain', name = 'description', optional = false) {
  const started = performance.now(), opts = await options(name, optional);
  const root = document.createElement('div'); root.id = 'site-' + ++sequence;
  document.querySelector('#editors').append(root);
  let editor, close;
  if (binding === 'react') {
    const [{ createElement }, { createRoot }, { EditorHost }] = await Promise.all([import('react'), import('react-dom/client'), import('@edit-ac/react')]);
    const react = createRoot(root);
    editor = await new Promise((resolve, reject) => react.render(createElement(EditorHost, { options: opts, onReady: resolve, onError: reject, onDispose: report => reports.push(report) })));
    close = async () => { const report = await editor.destroy(); react.unmount(); return report; };
  } else if (binding === 'astro') {
    const { mountEditorHost } = await import('@edit-ac/astro');
    // The HTML surface comes from the installed Editor.astro component, compiled
    // by Astro in the same site graph, rather than a synthetic framework host.
    root.innerHTML = document.querySelector('#astro-template').innerHTML;
    const host = mountEditorHost(root.querySelector('edit-ac-editor'), opts);
    editor = await host.ready; close = () => host.dispose();
  } else { editor = createEditor(root, opts); await editor.ready; close = () => editor.destroy(); }
  await new Promise(resolve => requestAnimationFrame(resolve));
  const sample = { binding, name, optional, readyAndFrameMs: performance.now() - started, realmToFrameMs: performance.now(), timingScope: 'mount invocation through options/runtime/DOM and next animation frame; realm sample includes page bootstrap' };
  timings.push(sample); live.set(root.id, { editor, root, close, sample }); return root.id;
}
async function cleanup() {
  for (const [key, value] of live) { reports.push(await value.close()); value.root.remove(); live.delete(key); }
}
function append(key, value) {
  const { editor, sample } = live.get(key), started = performance.now();
  const block = editor.read().visible.find(n => n.kind === 'block');
  const at = editor.anchor(block.id, block.runs.reduce((n, r) => n + r.text.length, 0));
  try { editor.chain().command({ type: 'insert', at, text: value }).run(); } finally { editor.releaseAnchor(at); }
  sample.acceptedEditMs = performance.now() - started;
}
async function route(name) {
  await cleanup(); history.pushState({}, '', '/fixture/' + name + '/index.html');
  return mount('plain', name === 'document' ? 'document' : 'description', name === 'document');
}
window.site = { seed, mount, cleanup, append, route, init, assetUrl, release, admitRelease, text: key => text(live.get(key).editor),
  state: () => ({ live: [...live.keys()], reports, timings, identities: [...live.values()].map(v => v.editor.read().identity), roots: document.querySelector('#editors').childElementCount }) };
window.siteEvaluations = (window.siteEvaluations ?? 0) + 1;
