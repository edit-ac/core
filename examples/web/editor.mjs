import { init } from '@edit-ac/core';
import { mountEditorSurface } from '@edit-ac/web';
import { documents } from './documents.mjs';

const root = document.querySelector('#editor');
const status = document.querySelector('#status');
const controls = Object.fromEntries(['undo', 'redo', 'read-only', 'reset', 'export'].map(id => [id, document.getElementById(id)]));
let runtime, current, active = documents[0], readOnly = false, busy = false;
const execute = (engine, request) => engine.commit(engine.prepare(request));

function buildDocument(example) {
  const engine = runtime.createEngine({ profile: 'v5', documentId: crypto.randomUUID(), epoch: crypto.randomUUID(), nodes: example.blocks.map(({ text }) => ({ text })) });
  try {
    const ids = engine.read().visible.map(node => node.id);
    example.blocks.forEach((block, index) => {
      if (block.heading) execute(engine, { kind: 'format', origin: 'example-seed', marks: [], blocks: [{ targets: [ids[index]], attributes: { type: 'heading', level: block.heading }, action: 'apply' }] });
      if (block.bold) {
        const offset = block.text.indexOf(block.bold);
        const anchor = engine.anchor(ids[index], offset, 'left'), focus = engine.anchor(ids[index], offset + block.bold.length, 'right');
        try { execute(engine, { kind: 'format', origin: 'example-seed', blocks: [], marks: [{ range: { anchor, focus }, mark: 'bold', action: 'apply' }] }); }
        finally { engine.releaseAnchor(anchor); engine.releaseAnchor(focus); }
      }
    });
    const listIds = ids.filter((_, index) => example.blocks[index].list);
    if (listIds.length) execute(engine, { kind: 'editor', origin: 'example-seed', commands: [{ type: 'wrap', targets: listIds, style: { type: 'unordered' } }] });
    engine.history({ type: 'clear' });
    return engine;
  } catch (error) { engine.dispose(); throw error; }
}

function dispose() {
  if (!current) return;
  current.subscription.dispose(); current.surface.dispose(); current.engine.dispose(); current = undefined;
}

function refresh() {
  if (!current) return;
  const history = current.engine.history({ type: 'state' });
  controls.undo.disabled = busy || readOnly || history.undoGroups === 0;
  controls.redo.disabled = busy || readOnly || history.redoGroups === 0;
  const text = current.engine.read().visible.map(node => node.runs.map(run => run.text).join('')).join(' ').trim();
  document.querySelector('#word-count').textContent = `${text ? text.split(/\s+/u).length : 0} words`;
  const recoveries = current.surface.recovery;
  document.querySelector('#recovery').hidden = recoveries.length === 0;
  document.querySelector('#recovery-text').textContent = recoveries.map(item => item.text).join('\n\n');
}

async function load(example) {
  busy = true;
  for (const button of Object.values(controls)) button.disabled = true;
  for (const button of document.querySelectorAll('.example')) button.disabled = true;
  let next;
  try {
    await current?.surface.settle();
    next = buildDocument(example);
    dispose();
    const surface = mountEditorSurface(root, next, { readOnly, label: 'Example document' });
    current = { engine: next, surface, subscription: next.subscribe({ type: 'all' }, () => queueMicrotask(refresh)) };
    active = example;
    document.querySelector('#document-title').textContent = example.title;
    for (const button of document.querySelectorAll('.example')) button.setAttribute('aria-pressed', String(button.dataset.id === example.id));
    status.textContent = 'Ready · Edits stay in this tab';
  } catch (error) {
    if (next && current?.engine !== next) next.dispose();
    status.textContent = `Could not open example: ${error.message}. Reload to retry.`;
  } finally {
    busy = false;
    for (const button of Object.values(controls)) button.disabled = !current;
    for (const button of document.querySelectorAll('.example')) button.disabled = !runtime;
    refresh();
  }
}

for (const example of documents) {
  const button = document.createElement('button');
  button.className = 'example'; button.dataset.id = example.id; button.disabled = true; button.setAttribute('aria-pressed', String(example === active));
  const title = document.createElement('strong'), description = document.createElement('small');
  title.textContent = example.title; description.textContent = example.description; button.append(title, description);
  button.addEventListener('click', () => { if (!busy) void load(example); });
  document.querySelector('#examples').append(button);
}

async function action(callback) {
  if (!current || busy) return;
  try { await current.surface.settle(); await callback(); refresh(); }
  catch (error) { status.textContent = `Action could not finish: ${error.message}`; }
}
for (const type of ['undo', 'redo']) controls[type].addEventListener('click', () => action(() => { if (!readOnly) { current.engine.history({ type }); root.focus(); } }));
controls['read-only'].addEventListener('click', () => action(() => {
  readOnly = !readOnly; current.surface.setReadOnly(readOnly);
  controls['read-only'].setAttribute('aria-pressed', String(readOnly));
  document.querySelector('#mode').textContent = readOnly ? 'Read only' : 'Editable';
  root.setAttribute('aria-readonly', String(readOnly));
}));
controls.reset.addEventListener('click', () => { if (!busy) void load(active); });
controls.export.addEventListener('click', () => action(() => {
  const text = current.engine.read().visible.filter(node => node.runs.length).map(node => node.runs.map(run => run.text).join('')).join('\n\n');
  const url = URL.createObjectURL(new Blob([text + '\n'], { type: 'text/plain;charset=utf-8' }));
  const link = document.createElement('a'); link.href = url; link.download = `${active.id}.txt`; link.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
  status.textContent = 'Text exported · Formatting stays in the editor';
}));
root.addEventListener('input', () => queueMicrotask(() => action(refresh)));
window.addEventListener('pagehide', dispose);
window.addEventListener('pageshow', event => { if (event.persisted && runtime) void load(active); });
try { runtime = await init('/core/wasm/editac_wasm_bg.wasm'); await load(active); }
catch (error) { status.textContent = `Editor could not load: ${error.message}. Build the packages and reload.`; }
