import { createEditor, taskPreset, CheckpointStorage, init } from '/fixture/assets/task.js';
import { projectedSemantics, expectedSemantics, fixture } from '/fixture/harness/fixtures.mjs';
const hash = async value => Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(JSON.stringify(value)))), b => b.toString(16).padStart(2, '0')).join('');
const check = (ok, message) => { if (!ok) throw Error(message); };
window.loadingRun = (async () => {
  const { identity, databaseName, preset, mode, name } = JSON.parse(document.querySelector('#options').textContent);
  const samples = { moduleMs: performance.now() };
  const start = performance.now(); await init('/fixture/assets/wasm/editac_wasm_bg.wasm'); samples.initMs = performance.now() - start;
  if (mode === 'cold') {
    const transfer = performance.now(), frozen = await (await fetch(`/fixture/corpus/${name}.checkpoint.json`)).json();
    const storage = await CheckpointStorage.open(indexedDB, databaseName);
    try { await storage.publish({ ...frozen.checkpoint, bytes: new Uint8Array(frozen.checkpoint.bytes) }, []); } finally { storage.close(); }
    samples.documentTransferMs = performance.now() - transfer;
  }
  let editor;
  try {
    const restore = performance.now();
    editor = createEditor(document.querySelector('#editor'), { databaseName, identity, indexedDB, locks: navigator.locks,
      assetUrl: '/fixture/assets/wasm/editac_wasm_bg.wasm', ...(preset === 'task' ? taskPreset() : { preset: 'minimal', typingShortcuts: false, plainPasteControl: false, plainTextPolicy: 'literal' }) });
    await editor.ready; samples.restoreMs = performance.now() - restore; samples.readyMs = performance.now();
    await new Promise(requestAnimationFrame); await new Promise(requestAnimationFrame); samples.firstFrameMs = performance.now();
    const initial = await hash(projectedSemantics(editor.read()));
    check(initial === await hash(expectedSemantics(fixture(name))), 'Restored corpus differs from independent generator');
    const node = editor.read().visible.find(n => n.kind === 'block' && n.runs?.length && /[A-Za-z]/.test(n.runs[0].text));
    check(node, 'Missing live edit target');
    const text = node.runs[0].text, offset = text.search(/[A-Za-z]/), alternate = text[offset] === 'z' ? 'q' : 'z';
    const editStart = performance.now();
    for (const value of [alternate, text[offset]]) {
      const at = editor.anchor(node.id, offset, 'right'), end = editor.anchor(node.id, offset + 1, 'left');
      try { const result = editor.chain('prf06').command({ type: 'delete', range: { anchor: at, focus: end } }).command({ type: 'insert', at, text: value }).run(); if (result.caret) editor.releaseAnchor(result.caret); }
      finally { editor.releaseAnchor(at); editor.releaseAnchor(end); }
      if (value === alternate) { samples.acceptedEditMs = performance.now(); check(editor.read().visible.find(n => n.id === node.id).runs.map(r => r.text).join('') === text.slice(0, offset) + alternate + text.slice(offset + 1), 'Public edit was not applied'); }
    }
    samples.commandRestoreMs = performance.now() - editStart;
    const final = await hash(projectedSemantics(editor.read())); check(initial === final, 'Public command did not preserve corpus');
    await editor.flush({ target: 'local' });
    const resourceTimings = performance.getEntriesByType('resource').map(e => ({ name: new URL(e.name).pathname, initiatorType: e.initiatorType, startTime: e.startTime, duration: e.duration, transferSize: e.transferSize, encodedBodySize: e.encodedBodySize, decodedBodySize: e.decodedBodySize }));
    return { samples, initialHash: initial, finalHash: final, sourcePreserved: true, persisted: true, resourceTimings };
  } finally { if (editor) { const closed = await editor.destroy({ policy: 'flush' }); check(closed.unsaved === false, 'Unacknowledged editor disposal'); } }
})();
