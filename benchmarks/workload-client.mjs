import { workload, expectedWorkload, canonicalWorkload, projectedWorkload } from './workloads.mjs';
import { presetOptions } from './presets.mjs';
import { init, createEditor, taskPreset, CheckpointStorage, contentModules } from './sdk.js';
const check = (value, message) => { if (!value) throw Error(message); };
const semantics = editor => canonicalWorkload(projectedWorkload(editor.read()));
const frames = async () => { const times = []; for (let i = 0; i < 2; i++) times.push(await new Promise(requestAnimationFrame)); return times; };
export async function prepare(profile, scale, kind) {
  const document = workload(profile, scale, kind), runtime = await init('/fixture/wasm/editac_wasm_bg.wasm');
  // Constructor's per-block bound is unchanged. Seed a long logical line by
  // joining safe UTF-16 chunks through the same public semantic commands.
  const text = kind === 'long-line' ? document.blocks[0].runs[0].text : null, chunks = [];
  if (text !== null) for (let start = 0; start < text.length;) {
    let end = Math.min(start + 131072, text.length);
    if (end < text.length && /[\uD800-\uDBFF]/.test(text[end - 1])) end--;
    chunks.push(text.slice(start, end)); start = end;
  }
  const engine = runtime.createEngine({ profile: 'v5', documentId: crypto.randomUUID(), epoch: crypto.randomUUID(), nodes: kind === 'long-line' ? chunks.map(text => ({text})) : kind === 'bidi' ? document.blocks.map(b => ({text:b.runs[0].text})) : [{ text: '' }] });
  try {
    if (kind === 'long-line') {
      const nodes = engine.read().visible.filter(n => n.kind === 'block');
      for (const node of nodes.slice(1)) {
        const plan = engine.prepare({kind: 'editor', origin: 'prf04:seed-join', commands: [{type:'join',first:nodes[0].id,second:node.id}]});
        try { const result = engine.commit(plan); if (result.caret) engine.releaseAnchor(result.caret); } finally { engine.releasePlan(plan); }
      }
    } else if (kind === 'images' || kind === 'table-selection') {
      const node = engine.read().visible.find(n => n.kind === 'block'), at = engine.anchor(node.id, 0, 'right');
      try { const plan = engine.prepare({ kind: 'fragment', origin: 'prf04:seed', range: { anchor: at, focus: at }, blocks: document.blocks });
        try { const result = engine.commit(plan); if (result.caret) engine.releaseAnchor(result.caret); } finally { engine.releasePlan(plan); }
      } finally { engine.releaseAnchor(at); }
    }
    const actual = projectedWorkload(engine.read()), expected = expectedWorkload(document);
    const describe = nodes => nodes.map(n => ({textUnits:n.text.length,runLengths:n.runs.map(r=>r.text.length),attributes:n.attributes.slice(0,2)}));
    check(canonicalWorkload(actual) === canonicalWorkload(expected), 'Prepared workload mismatch: ' + JSON.stringify({actual:describe(actual),expected:describe(expected)}));
    engine.history({ type: 'clear' }); const checkpoint = engine.checkpoint();
    return { identity: engine.read().identity, checkpoint: { ...checkpoint, bytes: Array.from(checkpoint.bytes) } };
  } finally { engine.dispose(); }
}
export async function run(profile, scale, kind, preset, frozen) {
  await init('/fixture/wasm/editac_wasm_bg.wasm');
  const document = workload(profile, scale, kind), root = window.document.querySelector('#editor'), raw = { samples: [], memory: [], longTasks: [], cleanup: {}, dimensions: document.dimensions };
  const heap = async phase => raw.memory.push({ phase, at: performance.now(), ...(await window.workloadHeap()) });
  const databaseName = `prf04-${crypto.randomUUID()}`, store = await CheckpointStorage.open(indexedDB, databaseName);
  try { await store.publish({ ...frozen.checkpoint, bytes: new Uint8Array(frozen.checkpoint.bytes) }, []); } finally { store.close(); }
  let views = 0, imagePolicyCalls = 0, editor, observer;
  const factory = contentModules({ imageUrl(metadata) { imagePolicyCalls++; return new URL(`/fixture/workload-image.png?id=${encodeURIComponent(metadata.url)}`, location.href).href; } });
  const content = context => { const view = factory(context); if (!view) return; views++; let disposed = false; return { element: view.element, update: n => view.update(n), setReadOnly: v => view.setReadOnly(v), dispose() { if (!disposed) { disposed = true; views--; view.dispose(); } } }; };
  try {
    await heap('before-mount');
    observer = new PerformanceObserver(list => { for (const e of list.getEntries()) raw.longTasks.push({ startTime: e.startTime, duration: e.duration }); });
    observer.observe({ type: 'longtask', buffered: false });
    const start = performance.now();
    editor = createEditor(root, { databaseName, identity: frozen.identity, indexedDB, locks: navigator.locks, assetUrl: '/fixture/wasm/editac_wasm_bg.wasm', content, ...presetOptions(preset, { taskPreset }) });
    await editor.ready; await frames();
    if (kind === 'images') await Promise.all([...root.querySelectorAll('img')].map(image => image.decode()));
    root.getBoundingClientRect(); raw.mountMs = performance.now() - start; await heap('mounted');
    const expected = canonicalWorkload(expectedWorkload(document)); raw.initialRunSegments = editor.read().visible.filter(n => n.kind === 'block').map(n => n.runs.map(r => ({units:r.text.length,attributes:r.attributes}))); raw.initialSemantics = semantics(editor); check(raw.initialSemantics === expected, 'Restored complete workload mismatch');
    raw.dom = { blocks: root.querySelectorAll('[data-node-id]').length, controls: root.querySelectorAll('textarea').length, sourceControls: [...root.querySelectorAll('textarea[aria-label="Image source"]')].map(c => ({ readOnly: c.readOnly, value: c.value })), images: [...root.querySelectorAll('img')].map(i => ({ width: i.naturalWidth, height: i.naturalHeight, complete: i.complete })), imagePolicyCalls, views };
    const initial = editor.read().visible.filter(n => n.kind === 'block'), first = kind === 'table-selection' ? initial.find(n => n.blockAttributes?.[0] === 'module:editac.table') : initial[0];
    for (let index = 0; index < profile.samples; index++) {
      const sample = { index, frames: [], selection: null }, begin = performance.now(); sample.startTime = begin;
      if (kind === 'long-line' || kind === 'bidi') {
        const a = root.querySelector(`[data-node-id="${CSS.escape(first.id)}"]`), last = root.querySelector(`[data-node-id="${CSS.escape(initial.at(-1).id)}"]`), range = window.document.createRange();
        range.setStart(a, 0); range.setEnd(last, last.childNodes.length); const selection = getSelection(); selection.removeAllRanges(); selection.addRange(range);
        sample.selection = { units: range.toString().length, displayUnits: selection.toString().length, anchorNode: selection.anchorNode === a, anchorOffset: selection.anchorOffset, focusNode: selection.focusNode === last, focusOffset: selection.focusOffset };
        check(range.toString() === document.blocks.map(b => b.runs[0].text).join(''), 'Native full text range mismatch');
      } else if (kind === 'table-selection') {
        const table = root.querySelector('table'), range = window.document.createRange(); range.selectNodeContents(table); const selection = getSelection(); selection.removeAllRanges(); selection.addRange(range);
        const controls = [...root.querySelectorAll('textarea')], control = controls.at(-1); control.focus(); control.setSelectionRange(0, control.value.length);
        sample.selection = { units: range.toString().length, cells: controls.length, start: control.selectionStart, end: control.selectionEnd, valueUnits: control.value.length, firstValue: controls[0].value, lastValue: control.value };
        check(range.toString() === document.blocks[0].attributes.tuple[2].rows.flatMap(row => row.map(cell => cell[0][0])).join(''), 'Whole table native range mismatch');
      } else {
        const image = root.querySelectorAll('img')[index % document.dimensions.images]; image.scrollIntoView({ block: 'nearest' });
        const rect = image.getBoundingClientRect(); sample.selection = { image: index % document.dimensions.images, width: rect.width, height: rect.height, naturalWidth: image.naturalWidth, naturalHeight: image.naturalHeight };
      }
      root.getBoundingClientRect(); sample.selectionLayoutMs = performance.now() - begin;
      if (kind !== 'images') {
        const start = performance.now();
        if (kind === 'table-selection') {
          // One real table adapter edit and exact restoration, each through the Rust writer.
          const control = root.querySelector('textarea'), original = control.value;
          control.value = 'z' + original.slice(1); control.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertText', data: 'z' }));
          check(editor.read().visible.find(n => n.id === first.id).blockAttributes[2].rows[0][0][0][0] === control.value, 'Table adapter failed commit');
          control.value = original; control.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertText', data: original[0] }));
        } else {
          const original = first.runs[0].text, offset = original.search(/[A-Za-z]/); check(offset >= 0, 'Missing safe replacement');
          for (const value of ['z', original[offset]]) {
            const at = editor.anchor(first.id, offset, 'right'), end = editor.anchor(first.id, offset + 1, 'left');
            try { const result = editor.chain('prf04').command({ type: 'delete', range: { anchor: at, focus: end } }).command({ type: 'insert', at, text: value }).run(); if (result.caret) editor.releaseAnchor(result.caret); }
            finally { editor.releaseAnchor(at); editor.releaseAnchor(end); }
          }
        }
        sample.commandRestoreMs = performance.now() - start;
      }
      sample.frames = await frames(); sample.endTime = performance.now(); sample.replayMs = sample.endTime - begin;
      check(semantics(editor) === expected, 'Replay mutated/truncated full workload'); sample.semanticRestored = true;
      raw.samples.push(sample); await heap(`sample-${index}`);
    }
    if (profile.tableInputScope && kind === 'table-selection') {
      raw.tableAccessibility = { scope: profile.tableInputScope, samples: [] };
      window.__tableCommittedCell = at => editor.read().visible.find(n => n.id === first.id).blockAttributes[2].rows[Math.floor(at / document.dimensions.columns)][at % document.dimensions.columns][0][0];
      try {
        for (let index = 0; index < profile.samples; index++) {
          const sample = await window.workloadTableInput(index);
          raw.tableAccessibility.samples.push(sample);
          check(!sample.failure, 'Trusted table input failed: ' + JSON.stringify(sample.failure));
          check(semantics(editor) === expected, 'Trusted input changed full table semantics');
          sample.semanticRestored = true;
        }
      } finally { delete window.__tableCommittedCell; }
    }
    await editor.flush({ target: 'local' }); raw.finalSemantics = semantics(editor); raw.correctness = 'observed';
    if (profile.tableInputScope && kind === 'table-selection') {
      const closed = await editor.destroy({ policy: 'flush' });
      check(!closed.unsaved && views === 0, 'Pre-reopen table leaked unsaved state/views');
      const persisted = await CheckpointStorage.open(indexedDB, databaseName);
      try {
        const proof = await persisted.restore(frozen.identity, state => {
          const same = state.checkpoint.bytes.length === frozen.checkpoint.bytes.length
            && state.checkpoint.bytes.every((byte, i) => byte === frozen.checkpoint.bytes[i]);
          check(same && state.tail.length === profile.samples * 4, 'Table proof requires original checkpoint and every acknowledged journal update');
          return { source: state.source, rejected: state.rejected, checkpointSameAsSeed: same,
            checkpointBytes: state.checkpoint.bytes.length,
            entries: state.tail.map(entry => ({ identity: entry.identity, writerId: entry.writerId,
              sequence: entry.sequence, origin: entry.origin, updateId: entry.updateId,
              checksum: entry.checksum, byteLength: entry.bytes.length,
              payload: btoa(Array.from(entry.bytes, byte => String.fromCharCode(byte)).join('')) })) };
        });
        raw.tableAccessibility.persistedJournal = proof.value;
      } finally { persisted.close(); }
      editor = createEditor(root, { databaseName, identity: frozen.identity, indexedDB, locks: navigator.locks, assetUrl: '/fixture/wasm/editac_wasm_bg.wasm', content, ...presetOptions(preset, { taskPreset }) });
      await editor.ready;
      raw.tableAccessibility.reopenSemantics = semantics(editor);
      check(raw.tableAccessibility.reopenSemantics === expected, 'Trusted table edits failed exact persisted reopen');
      raw.tableAccessibility.reopened = true;
    }
    raw.memoryScope = profile.memoryScope; raw.inputScope = profile.inputScope;
    await new Promise(resolve => setTimeout(resolve, 30));
    raw.longTasks.push(...observer.takeRecords().map(e => ({ startTime: e.startTime, duration: e.duration })));
  } catch (error) { raw.failure = error.stack ?? String(error); }
  finally {
    observer?.disconnect(); getSelection()?.removeAllRanges();
    if (editor) { const result = await editor.destroy({ policy: 'flush' }); raw.cleanup.unsaved = result.unsaved; raw.cleanup.editorReady = editor.state.ready; }
    raw.cleanup.activeViews = views; raw.cleanup.activeImageSources = [...root.querySelectorAll('img')].filter(i => i.hasAttribute('src')).length;
    root.replaceChildren();
    await new Promise((resolve, reject) => { const request = indexedDB.deleteDatabase(databaseName); request.onsuccess = resolve; request.onerror = () => reject(request.error); request.onblocked = () => reject(Error('Database deletion blocked')); });
    raw.cleanup.databaseDeleted = true; await heap('disposed');
  }
  return raw;
}
