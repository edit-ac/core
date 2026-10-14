import { fixture, fixtureText, expectedSemantics, projectedSemantics, overwriteTarget } from './fixtures.mjs';

import { presets, presetOptions } from './presets.mjs';

const root = document.querySelector('#editor');
const assetUrl = '/fixture/wasm/editac_wasm_bg.wasm';
let sdk, runtime, editor, session, databaseName, sequence = 0, activePreset = 'baseline';
const check = (condition, message) => { if (!condition) throw Error(message); };
const textOf = node => node.runs.map(run => run.text).join('');
const blocks = () => editor.read().visible.filter(node => node.kind === 'block');
const allText = () => blocks().map(textOf).join('');
const nextFrame = () => new Promise(resolve => requestAnimationFrame(resolve));
const wait = ms => new Promise(resolve => setTimeout(resolve, ms));

function element(id) {
  const node = root.querySelector(`[data-node-id="${CSS.escape(id)}"]`);
  check(node, `Missing projected block ${id}`); return node;
}
function point(id, offset) {
  const owner = element(id);
  const walker = document.createTreeWalker(owner, NodeFilter.SHOW_TEXT);
  for (let node = walker.nextNode(); node; node = walker.nextNode()) {
    if (node.parentElement.closest('[contenteditable="false"]')) continue;
    if (offset <= node.length) return { node, offset };
    offset -= node.length;
  }
  check(offset === 0, 'Unmapped UTF-16 selection'); return { node: owner, offset: owner.childNodes.length };
}
function select(id, offset, endId = id, end = offset) {
  const a = point(id, offset), b = point(endId, end);
  root.focus(); document.getSelection().setBaseAndExtent(a.node, a.offset, b.node, b.offset);
}
function input(inputType, data = null) {
  const event = new InputEvent('beforeinput', { bubbles: true, cancelable: true, inputType, data });
  const selection = document.getSelection();
  if (inputType === 'deleteContentBackward' && selection.isCollapsed) {
    // Constructed events have no browser target range. Supply the known ASCII
    // character inserted by this scenario, without guessing Unicode deletion units.
    const node = selection.anchorNode, offset = selection.anchorOffset;
    check(node?.nodeType === Node.TEXT_NODE && offset > 0 && /[xmL]/.test(node.data[offset - 1]), 'Prepared deletion must target the inserted ASCII character');
    const target = new StaticRange({ startContainer: node, startOffset: offset - 1, endContainer: node, endOffset: offset });
    Object.defineProperty(event, 'getTargetRanges', { value: () => [target] });
  }
  root.dispatchEvent(event); check(event.defaultPrevented, `Editor did not own ${inputType}`);
}
function timed(action, id) {
  const start = performance.now();
  const result = action();
  // Force layout of the committed projection. This is not a compositor-paint measurement.
  (id ? element(id) : root).getBoundingClientRect();
  return { ms: performance.now() - start, result };
}
function range(id, start, endId = id, end = start) {
  const anchor = editor.anchor(id, start), focus = editor.anchor(endId, end);
  return { value: { anchor, focus }, release() { editor.releaseAnchor(anchor); editor.releaseAnchor(focus); } };
}
function format(id, mark) {
  const target = range(id, 0, id, 3);
  try {
    return timed(() => editor.commit({ kind: 'format', origin: 'benchmark:format', marks: [{ range: target.value, mark, action: 'toggle' }], blocks: [] }), id).ms;
  } finally { target.release(); }
}
function verifySemantics(snapshot, document, phase) {
  const actual = projectedSemantics(snapshot), expected = expectedSemantics(document);
  const mismatch = actual.findIndex((block, index) => JSON.stringify(block) !== JSON.stringify(expected[index]));
  const brief = block => block && { ...block, text: block.text.slice(0, 40), runs: block.runs.map(run => ({ ...run, text: run.text.slice(0, 40) })) };
  check(mismatch === -1 && actual.length === expected.length,
    `${phase} semantic snapshot mismatch at ${mismatch}: actual=${JSON.stringify(brief(actual[mismatch]))} expected=${JSON.stringify(brief(expected[mismatch]))}`);
}
async function seed(name, frozen) {
  if (frozen) {
    databaseName = `editac-benchmark-${++sequence}`;
    const storage = await sdk.CheckpointStorage.open(indexedDB, databaseName);
    try { await storage.publish({ ...frozen.checkpoint, bytes: new Uint8Array(frozen.checkpoint.bytes) }, []); }
    finally { storage.close(); }
    return { identity: frozen.identity, document: fixture(name), frozen };
  }
  const document = fixture(name);
  databaseName = `editac-benchmark-${++sequence}`;
  const engine = runtime.createEngine({ profile: 'v5', documentId: crypto.randomUUID(), epoch: crypto.randomUUID(),
    nodes: document.generator ? [{ text: '' }] : document.blocks.map(block => ({ text: block.runs.map(run => run.text).join('') })) });
  try {
    const initial = engine.read().visible.filter(node => node.kind === 'block');
    const identity = engine.read().identity;
    function commit(request) {
      const plan = engine.prepare(request);
      try { const result = engine.commit(plan); if (result.caret) engine.releaseAnchor(result.caret); }
      finally { engine.releasePlan(plan); }
    }
    if (document.generator) {
      // Public fragment admission is capped at128 blocks. Keep a trailing empty
      // destination between batches, so append cannot merge two fixture blocks.
      //117 is nine complete13-block patterns; list groups never cross a batch.
      for (let offset = 0; offset < document.blocks.length; offset += 117) {
        const last = engine.read().visible.filter(node => node.kind === 'block').at(-1);
        check(textOf(last) === '', 'Seed append destination must be empty');
        const imported = document.blocks.slice(offset, offset + 117);
        if (offset + 117 < document.blocks.length) imported.push({ runs: [{ text: '', marks: [] }], attributes: { type: 'paragraph' } });
        const anchor = engine.anchor(last.id, 0, 'right'), focus = engine.anchor(last.id, 0, 'right');
        try { commit({ kind: 'fragment', origin: 'benchmark:seed', range: { anchor, focus }, blocks: imported }); }
        finally { engine.releaseAnchor(anchor); engine.releaseAnchor(focus); }
        console.info('editac-benchmark-phase', name, 'seed fragment', offset, imported.length);
      }
    } else {
    // Public bulk creation admits these bounded documents. Apply structure using
    // the same public commands as hosts, outside all measurement windows.
    const headings = initial.filter((_, index) => document.blocks[index].attributes.type === 'heading').map(node => node.id);
    commit({ kind: 'format', origin: 'benchmark:seed', marks: [], blocks: [{ targets: headings, attributes: { type: 'heading', level: 2 }, action: 'apply' }] });
    const commands = initial.flatMap((node, index) => document.blocks[index].attributes.type === 'code' ? [{ type: 'setCode', owner: node.id, language: 'text' }] : []);
    const groups = new Map();
    for (let index = 0; index < document.blocks.length; index++) {
      const container = document.blocks[index].containers?.[0];
      if (container) { if (!groups.has(container.key)) groups.set(container.key, []); groups.get(container.key).push(initial[index].id); }
    }
    for (const targets of groups.values()) commands.push({ type: 'wrap', targets, style: { type: 'unordered' } });
    for (let index = 0; index < document.blocks.length; index++) {
      if (document.blocks[index].containers?.length > 1) commands.push({ type: 'indent', owner: initial[index].id });
    }
    for (let offset = 0; offset < commands.length; offset += 32) {
      commit({ kind: 'editor', origin: 'benchmark:seed', commands: commands.slice(offset, offset + 32) });
    }
    }
    if (document.generator) verifySemantics(engine.read(), document, 'Seed');
    const checkpoint = engine.checkpoint();
    const frozen = { identity, checkpoint: { ...checkpoint, bytes: Array.from(checkpoint.bytes) } };
    const storage = await sdk.CheckpointStorage.open(indexedDB, databaseName);
    try { await storage.publish(checkpoint, []); } finally { storage.close(); }
    return { identity, document, frozen };
  } finally { engine.dispose(); }
}
async function mount(identity, start = performance.now()) {
  root.spellcheck = false;
  editor = sdk.createEditor(root, { assetUrl, databaseName, identity, indexedDB, locks: navigator.locks,
    ...presetOptions(activePreset, sdk),
    recover: async options => { session = await sdk.recoverLocalDocument(options); return session; } });
  await editor.ready;
  const first = blocks()[0], before = textOf(first);
  const overwrite = overwriteTarget(before, 'start');
  select(first.id, overwrite.at, first.id, overwrite.at + 1);
  input('insertText', 'x'); element(first.id).getBoundingClientRect();
  const elapsed = performance.now() - start;
  check(element(first.id).textContent === before.slice(0, overwrite.at) + 'x' + before.slice(overwrite.at + 1), 'First edit was not projected');
  input('deleteContentBackward'); input('insertText', overwrite.original);
  check(textOf(blocks()[0]) === before, 'First edit cleanup failed');
  await editor.flush({ target: 'local' });
  session.writer.engine.history({ type: 'clear' });
  return elapsed;
}
async function unmount() {
  if (editor) {
    const closing = editor; editor = undefined;
    await closing.destroy({ policy: 'flush' });
    check(!closing.state.ready && root.contentEditable === 'false', 'Editor remained editable after destroy');
    root.replaceChildren(); session = undefined;
  }
}
async function removeDatabase() {
  if (!databaseName) return;
  await new Promise((resolve, reject) => {
    const request = indexedDB.deleteDatabase(databaseName);
    request.onsuccess = resolve; request.onerror = () => reject(request.error);
    request.onblocked = () => reject(Error('Benchmark database teardown blocked'));
  });
  databaseName = undefined;
}

export async function prepareFixture(name, frozen) {
  console.info('editac-benchmark-phase', name, 'seed');
  sdk = await import('./sdk.js'); runtime = await sdk.init(assetUrl);
  const seeded = await seed(name, frozen);
  return { identity: seeded.identity, databaseName, frozen: seeded.frozen };
}

export async function runScenario(name, config, prepared) {
  console.info('editac-benchmark-phase', name, 'cold/warm startup');
  activePreset = config.preset ?? 'baseline';
  check(presets[activePreset], 'Unknown configured preset');
  const metrics = {}, memory = {};
  const fitness = config.fitness ? { version: 1, provenance: 'browser-synthetic-input', preset: activePreset, featureSet: presets[activePreset].featureSet, providers: presets[activePreset].providers,
    endpoint: 'dispatch-layout-two-animation-frames-v1', replay: 'ascii-overwrite-delete-restore-v1', input: [], changedRegion: [], longTasks: [], disposal: [],
    gaps: ['Compositor presentation unobserved', 'Engine/FFI internal stages uninstrumented',
      'Continuous drag/scroll and native text services unmeasured', 'Optional table/highlighter and accessibility unmeasured'] } : null;
  let longTaskObserver;
  if (fitness && PerformanceObserver.supportedEntryTypes.includes('longtask')) {
    longTaskObserver = new PerformanceObserver(list => fitness.longTasks.push(...list.getEntries().map(e => ({ startTime: e.startTime, duration: e.duration }))));
    longTaskObserver.observe({ type: 'longtask', buffered: true });
    fitness.longTaskStatus = 'observed';
  } else if (fitness) fitness.longTaskStatus = 'unavailable';
  const record = (key, value) => (metrics[key] ??= []).push(value);
  check(prepared?.identity && prepared.databaseName, 'Missing prepared checkpoint');
  databaseName = prepared.databaseName;
  const document = fixture(name), expected = fixtureText(document);
  const loadStart = performance.now();
  sdk = await import('./sdk.js'); runtime = await sdk.init(assetUrl);
  record(`load.${name}.cold`, performance.now() - loadStart);
  const { identity } = prepared;
  try {
    record(`editable.${name}.cold`, await mount(identity, loadStart));
    check(allText() === expected, 'Fixture differs from its versioned source');
    if (document.generator) verifySemantics(editor.read(), document, 'Restored');
    check(root.querySelector('h2') && root.querySelector('pre') && root.querySelector('ul'), 'Mixed structure was not rendered');
    await unmount(); record(`editable.${name}.warm`, await mount(identity));
    if (name === 'large') memory.loaded = await window.benchmarkHeap();
    await window.benchmarkCheckpoint({ metrics, memory });
    const nodes = blocks();
    for (const position of ['start', 'middle', 'end']) {
      console.info('editac-benchmark-phase', name, 'typing', position);
      const index = position === 'start' ? 0 : position === 'end' ? nodes.length - 1 : Math.floor(nodes.length / 2);
      const node = nodes[index], before = textOf(node);
      const offset = position === 'start' ? 0 : position === 'end' ? before.length : Math.floor(before.length / 2);
      // Avoid splitting a surrogate pair; fixture offsets and public boundaries are UTF-16.
      const overwrite = document.generator ? overwriteTarget(before, position) : null;
      const at = overwrite?.at ?? (offset > 0 && /[\uDC00-\uDFFF]/.test(before[offset] ?? '') ? offset - 1 : offset);
      for (let sample = 0; sample < config.samples; sample++) {
        select(node.id, at, node.id, at + (overwrite ? 1 : 0));
        if (fitness) {
          const mutations = new MutationObserver(() => {});
          mutations.observe(root, { subtree: true, childList: true, characterData: true, attributes: true });
          try {
            const start = performance.now(); input('insertText', 'x'); const dispatched = performance.now();
            element(node.id).getBoundingClientRect(); const laidOut = performance.now();
            const records = mutations.takeRecords();
            const blockIds = new Set(nodes.map(n => n.id));
            const touched = [...new Set(records.flatMap(r => {
              const owner = r.target.nodeType === Node.ELEMENT_NODE ? r.target : r.target.parentElement;
              const affected = [owner?.closest('[data-node-id]'), ...r.addedNodes, ...r.removedNodes];
              return affected.flatMap(n => n?.nodeType === Node.ELEMENT_NODE ? [n.dataset?.nodeId, ...[...n.querySelectorAll('[data-node-id]')].map(el => el.dataset.nodeId)] : []);
            }).filter(id => blockIds.has(id)))];
            await nextFrame(); const firstFrame = performance.now(); await nextFrame(); const secondFrame = performance.now();
            fitness.input.push({ position, sample, dispatchMs: dispatched - start, layoutMs: laidOut - dispatched,
              firstFrameMs: firstFrame - start, secondFrameMs: secondFrame - start });
            fitness.changedRegion.push({ position, sample, documentBlocks: nodes.length, target: node.id, touched, mutationCount: records.length,
              scope: 'DOM mutation observations; not engine invalidation or a full-document scan proof' });
            record(`typing.${name}.${position}`, laidOut - start);
          } finally { mutations.disconnect(); }
        } else record(`typing.${name}.${position}`, timed(() => input('insertText', 'x'), node.id).ms);
        check(element(node.id).textContent === before.slice(0, at) + 'x' + before.slice(at + (overwrite ? 1 : 0)), 'Typing projection mismatch');
        record(`delete.${name}.${position}`, timed(() => input('deleteContentBackward'), node.id).ms);
        check(element(node.id).textContent === before.slice(0, at) + before.slice(at + (overwrite ? 1 : 0)), 'Backspace projection mismatch');
        if (overwrite) input('insertText', overwrite.original);
        check(element(node.id).textContent === before, 'Replay restoration mismatch');
        await wait(config.interKeyDelayMs);
      }
      await window.benchmarkCheckpoint({ metrics });
    }
    const first = blocks()[0];
    console.info('editac-benchmark-phase', name, 'format/history');
    for (const mark of ['bold', 'italic']) {
      for (let sample = 0; sample < config.formatSamples; sample++) {
        record(`${mark}.${name}`, format(first.id, mark));
        check(element(first.id).querySelector(mark === 'bold' ? 'strong' : 'em'), `${mark} projection mismatch`);
        format(first.id, mark);
        check(!element(first.id).querySelector(mark === 'bold' ? 'strong' : 'em'), `${mark} did not toggle off`);
      }
      await window.benchmarkCheckpoint({ metrics });
    }
    for (let sample = 0; sample < config.formatSamples; sample++) {
      const command = attributes => ({ kind: 'format', origin: 'benchmark:heading', marks: [], blocks: [{ targets: [first.id], attributes, action: 'apply' }] });
      record(`heading.${name}`, timed(() => editor.commit(command({ type: 'heading', level: 1 })), first.id).ms);
      check(element(first.id).matches('h1') || element(first.id).querySelector('h1'), 'Heading projection mismatch');
      editor.commit(command({ type: 'paragraph' }));
      const before = element(first.id).textContent;
      const overwrite = overwriteTarget(before, 'start');
      select(first.id, overwrite.at, first.id, overwrite.at + 1); session.writer.engine.history({ type: 'explicit' }); input('insertText', 'x');
      record(`undo.${name}`, timed(() => input('historyUndo'), first.id).ms);
      check(element(first.id).textContent === before, 'Undo mismatch');
      record(`redo.${name}`, timed(() => input('historyRedo'), first.id).ms);
      check(element(first.id).textContent === before.slice(0, overwrite.at) + 'x' + before.slice(overwrite.at + 1), 'Redo mismatch');
      select(first.id, overwrite.at + 1); input('deleteContentBackward'); input('insertText', overwrite.original);
    }
    check(allText() === expected, 'Core edit scenarios changed fixture text');
    if (document.generator) verifySemantics(editor.read(), document, 'After edits');
    await window.benchmarkCheckpoint({ metrics });
    if (name === 'large') {
      console.info('editac-benchmark-phase', name, 'large operations');
      await largeOperations(metrics, config);
      memory.afterLargeOperations = await window.benchmarkHeap();
    }
    if (name === 'large' && config.measureMemory) {
      console.info('editac-benchmark-phase', name, 'memory');
      // Measure editing/teardown on the fixed fixture independently of the
      // large-operation journal and its deliberately large temporary updates.
      await unmount(); await removeDatabase();
      const { identity: memoryIdentity } = await seed(name);
      await mount(memoryIdentity); memory.loaded = await window.benchmarkHeap();
      memory.afterLargeOperations = memory.loaded;
      await window.benchmarkCheckpoint({ metrics, memory });
      const target = blocks()[0], initialLength = allText().length;
      for (let index = 0; index < config.memoryEdits; index++) {
        select(target.id, 0); input('insertText', 'm');
        if (index % 20 === 0) await nextFrame();
      }
      check(allText().length === initialLength + config.memoryEdits, 'Sustained typing lost edits');
      await editor.flush({ target: 'local' });
      memory.afterEdits = await window.benchmarkHeap();
      await window.benchmarkCheckpoint({ metrics, memory });
      memory.cycles = [];
      for (let cycle = 0; cycle < config.mountCycles; cycle++) {
        await unmount(); await mount(memoryIdentity); await unmount();
        memory.cycles.push(await window.benchmarkHeap());
        await window.benchmarkCheckpoint({ metrics, memory });
      }
      memory.notes = 'CDP JS heap and backing storage (includes buffers, not exclusively WASM); forced GC only at snapshots, outside latency samples. WASM can retain a high-water allocation. No absolute memory gate yet.';
    }
    if (fitness) {
      await editor.flush({ target: 'local' });
      fitness.disposal.push({ phase: 'loaded', heap: await window.benchmarkHeap() });
      for (let cycle = 0; cycle < config.mountCycles; cycle++) {
        await unmount(); await mount(identity); await unmount();
        fitness.disposal.push({ phase: 'disposed', cycle, childNodes: root.childNodes.length,
          contentEditable: root.contentEditable, heap: await window.benchmarkHeap() });
        check(root.childNodes.length === 0 && root.contentEditable === 'false', 'Disposed surface retained editor DOM');
      }
      fitness.memoryStatus = 'diagnostic; no reviewed absolute plateau budget';
    }
    check(session?.writer.engine.takeObserverErrors().length === 0 || !session, 'Engine observer failed');
    await unmount();
    return { fixture: name, chars: document.chars, metrics, memory, fitness, correctness: 'passed' };
  } catch (error) {
    return { fixture: name, chars: document.chars, metrics, memory, fitness, correctness: 'failed', failure: error.stack ?? error.message };
  } finally {
    if (longTaskObserver) {
      fitness.longTasks.push(...longTaskObserver.takeRecords().map(e => ({ startTime: e.startTime, duration: e.duration })));
      longTaskObserver.disconnect();
    }
    await unmount(); await removeDatabase();
  }
}

async function largeOperations(metrics, config) {
  const record = (key, value) => (metrics[key] ??= []).push(value);
  const iterations = config.operationSamples;
  for (let index = 0; index < iterations; index++) {
    console.info('editac-benchmark-phase', 'large', 'paste', index);
    let nodes = blocks(), first = nodes[0], last = nodes.at(-1);
    const before = allText();
    const payload = ('# Pasted heading\n\n' + 'bulk notes '.repeat(10000)).slice(0, 100000);
    const prepared = session.writer.engine.importMarkdown(payload);
    const inserted = prepared.blocks.map(block => block.runs.map(run => run.text).join('')).join('');
    select(first.id, 0); session.writer.engine.history({ type: 'explicit' });
    const paste = timed(() => editor.paste({ getData: mime => mime === 'text/markdown' ? payload : '' }));
    record('paste.large', paste.ms);
    check(paste.result.disposition === 'committed' && allText() === inserted + before, 'Large paste failed');
    input('historyUndo'); check(allText() === before, 'Large paste undo failed');
    await window.benchmarkCheckpoint({ metrics });
    nodes = blocks(); first = nodes[0]; last = nodes.at(-1);
    // Inline marks deliberately reject code blocks. Heading conversion is an
    // admitted all-block format, so measure it and verify undo restores styles.
    const styles = nodes.map(node => node.blockAttributes);
    console.info('editac-benchmark-phase', 'large', 'select-all format', index);
    select(first.id, 0, last.id, textOf(last).length);
    session.writer.engine.history({ type: 'explicit' });
    record('select-all-format.large', timed(() => editor.commit({ kind: 'format', origin: 'benchmark:all', marks: [],
      blocks: [{ targets: nodes.map(node => node.id), attributes: { type: 'heading', level: 1 }, action: 'apply' }] })).ms);
    check(blocks().every(node => JSON.stringify(node.blockAttributes) === '["heading",1]'), 'Select-all formatting failed');
    input('historyUndo');
    check(JSON.stringify(blocks().map(node => node.blockAttributes)) === JSON.stringify(styles), 'Select-all format undo failed');
    await window.benchmarkCheckpoint({ metrics });
    console.info('editac-benchmark-phase', 'large', 'range delete', index);
    // Prepare a 100k-character range in one admitted text owner. This extends
    // the document to 600k before timed deletion returns it to the 500k fixture.
    const prefix = 'D'.repeat(100000), at = editor.anchor(first.id, 0);
    try {
      const insertion = editor.commit({ kind: 'text', origin: 'benchmark:delete-setup', command: { type: 'insert', at, text: prefix } });
      if (insertion.caret) editor.releaseAnchor(insertion.caret);
    } finally { editor.releaseAnchor(at); }
    check(allText() === prefix + before, 'Large delete setup failed');
    session.writer.engine.history({ type: 'explicit' });
    const target = range(first.id, 0, first.id, prefix.length);
    try {
      const deletion = timed(() => editor.commit({ kind: 'text', origin: 'benchmark:delete', command: { type: 'delete', range: target.value } }));
      record('delete-range.large', deletion.ms);
      if (deletion.result.caret) editor.releaseAnchor(deletion.result.caret);
      check(allText() === before, 'Large range deletion failed');
    } finally { target.release(); }
    input('historyUndo'); check(allText() === prefix + before, 'Large delete undo failed');
    const cleanup = range(first.id, 0, first.id, prefix.length);
    try {
      const result = editor.commit({ kind: 'text', origin: 'benchmark:delete-cleanup', command: { type: 'delete', range: cleanup.value } });
      if (result.caret) editor.releaseAnchor(result.caret);
    } finally { cleanup.release(); }
    check(allText() === before, 'Large delete cleanup failed');
    await window.benchmarkCheckpoint({ metrics });
    console.info('editac-benchmark-phase', 'large', 'remote update', index);
    const local = session.writer.engine, peer = runtime.restoreEngine(local.read().identity, local.checkpoint());
    const vector = local.stateVector(), id = blocks()[0].id;
    const peerAt = peer.anchor(id, 0, 'right');
    try {
      const plan = peer.prepare({ kind: 'text', origin: 'benchmark:peer', command: { type: 'insert', at: peerAt, text: 'REMOTE' } });
      try { const result = peer.commit(plan); if (result.caret) peer.releaseAnchor(result.caret); } finally { peer.releasePlan(plan); }
      // A concurrent local edit precedes delivery of the prepared remote update.
      const tail = blocks().at(-1); select(tail.id, textOf(tail).length); input('insertText', 'L');
      const update = peer.encodeUpdate(vector);
      record('remote-update.large', timed(() => local.applyUpdate(update), id).ms);
      check(allText() === 'REMOTE' + before + 'L', 'Concurrent local/remote update mismatch');
      check(element(id).textContent.startsWith('REMOTE'), 'Remote update was not projected');
      select(id, 0, id, 6); input('deleteContentBackward');
      const end = blocks().at(-1); select(end.id, textOf(end).length); input('deleteContentBackward');
      check(allText() === before, 'Remote update cleanup failed');
    } finally { peer.releaseAnchor(peerAt); peer.dispose(); }
    await editor.flush({ target: 'local' });
  }
}
