import { createEditor, taskPreset, CheckpointStorage, init } from '/fixture/assets/task.js';
import { projectedSemantics, expectedSemantics, fixture } from '/fixture/harness/fixtures.mjs';
const hash = async value => Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(JSON.stringify(value)))), b => b.toString(16).padStart(2, '0')).join('');
const check = (ok, message) => { if (!ok) throw Error(message); };
window.loadingRun = (async () => {
  const { identity, databaseName, preset, mode, name } = JSON.parse(document.querySelector('#options').textContent);
  const samples = { moduleMs: performance.now() }, phases = [];
  let boundary = 0;
  // Contiguous navigation-clock intervals retain harness/oracle overhead rather
  // than subtracting it from the original accepted-edit budget observation.
  const phase = name => {
    const endMs = performance.now();
    phases.push({ name, startMs: boundary, endMs, durationMs: endMs - boundary }); boundary = endMs;
  };
  phase('module');
  const start = performance.now(); await init('/fixture/assets/wasm/editac_wasm_bg.wasm'); samples.initMs = performance.now() - start; phase('wasmInit');
  if (mode === 'cold') {
    const transfer = performance.now(), response = await fetch(`/fixture/corpus/${name}.checkpoint.json`);
    check(response.ok, 'Missing checkpoint transfer');
    const checkpointText = await response.text(); phase('checkpointFetch');
    const frozen = JSON.parse(checkpointText); phase('checkpointDecode');
    const storage = await CheckpointStorage.open(indexedDB, databaseName);
    phase('checkpointOpen');
    try { await storage.publish({ ...frozen.checkpoint, bytes: new Uint8Array(frozen.checkpoint.bytes) }, []); phase('checkpointPublish'); } finally { storage.close(); }
    phase('checkpointClose');
    samples.documentTransferMs = performance.now() - transfer;
  }
  let editor;
  try {
    const restore = performance.now();
    editor = createEditor(document.querySelector('#editor'), { databaseName, identity, indexedDB, locks: navigator.locks,
      assetUrl: '/fixture/assets/wasm/editac_wasm_bg.wasm', ...(preset === 'task' ? taskPreset() : { preset: 'minimal', typingShortcuts: false, plainPasteControl: false, plainTextPolicy: 'literal' }) });
    phase('editorCreate');
    await editor.ready; samples.restoreMs = performance.now() - restore; samples.readyMs = performance.now(); phase('editorReady');
    await new Promise(requestAnimationFrame); await new Promise(requestAnimationFrame); samples.firstFrameMs = performance.now(); phase('firstFrame');
    let initialSnapshot = editor.read(); phase('initialRead');
    let initialSemantics = projectedSemantics(initialSnapshot); phase('initialProjection');
    const initial = await hash(initialSemantics); phase('initialHash'); initialSnapshot = initialSemantics = null;
    let expected = expectedSemantics(fixture(name)); phase('expectedFixture');
    const expectedHash = await hash(expected); phase('expectedHash'); expected = null;
    check(initial === expectedHash, 'Restored corpus differs from independent generator');
    let targetSnapshot = editor.read(); phase('targetRead');
    const node = targetSnapshot.visible.find(n => n.kind === 'block' && n.runs?.length && /[A-Za-z]/.test(n.runs[0].text));
    targetSnapshot = null;
    check(node, 'Missing live edit target');
    const text = node.runs[0].text, offset = text.search(/[A-Za-z]/), alternate = text[offset] === 'z' ? 'q' : 'z';
    phase('targetSelect');
    const editStart = performance.now();
    for (const value of [alternate, text[offset]]) {
      const prefix = value === alternate ? 'edit' : 'restore';
      const at = editor.anchor(node.id, offset, 'right'), end = editor.anchor(node.id, offset + 1, 'left'); phase(`${prefix}Anchors`);
      try { const result = editor.chain('prf06').command({ type: 'delete', range: { anchor: at, focus: end } }).command({ type: 'insert', at, text: value }).run(); phase(`${prefix}Command`); if (result.caret) editor.releaseAnchor(result.caret); }
      finally { editor.releaseAnchor(at); editor.releaseAnchor(end); }
      phase(`${prefix}Release`);
      if (value === alternate) {
        samples.acceptedEditMs = phases.at(-1).endMs;
        check(editor.read().visible.find(n => n.id === node.id).runs.map(r => r.text).join('') === text.slice(0, offset) + alternate + text.slice(offset + 1), 'Public edit was not applied'); phase('editVerify');
      }
    }
    samples.commandRestoreMs = performance.now() - editStart;
    const finalSnapshot = editor.read(); phase('finalRead');
    const finalSemantics = projectedSemantics(finalSnapshot); phase('finalProjection');
    const final = await hash(finalSemantics); phase('finalHash'); check(initial === final, 'Public command did not preserve corpus');
    await editor.flush({ target: 'local' }); phase('flush');
    const resourceTimings = performance.getEntriesByType('resource').map(e => ({ name: new URL(e.name).pathname, initiatorType: e.initiatorType, startTime: e.startTime, duration: e.duration, transferSize: e.transferSize, encodedBodySize: e.encodedBodySize, decodedBodySize: e.decodedBodySize }));
    return { samples, phaseAttribution: 'navigation-phases-v1', phases, initialHash: initial, finalHash: final, sourcePreserved: true, persisted: true, resourceTimings };
  } finally { if (editor) { const closed = await editor.destroy({ policy: 'flush' }); check(closed.unsaved === false, 'Unacknowledged editor disposal'); } }
})();
