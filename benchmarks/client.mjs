import { fixture, fixtureText } from './fixtures.mjs';

const root = document.querySelector('#editor');
const assetUrl = '/fixture/wasm/editac_wasm_bg.wasm';
let sdk, runtime, editor, session, databaseName, sequence = 0;
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
async function seed(name) {
  const document = fixture(name);
  databaseName = `editac-benchmark-${++sequence}`;
  const engine = runtime.createEngine({ profile: 'v5', documentId: crypto.randomUUID(), epoch: crypto.randomUUID(),
    nodes: document.blocks.map(block => ({ text: block.runs.map(run => run.text).join('') })) });
  try {
    const initial = engine.read().visible.filter(node => node.kind === 'block');
    const identity = engine.read().identity;
    function commit(request) {
      const plan = engine.prepare(request);
      try { const result = engine.commit(plan); if (result.caret) engine.releaseAnchor(result.caret); }
      finally { engine.releasePlan(plan); }
    }
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
    const storage = await sdk.CheckpointStorage.open(indexedDB, databaseName);
    try { await storage.publish(engine.checkpoint(), []); } finally { storage.close(); }
    return { identity, document };
  } finally { engine.dispose(); }
}
async function mount(identity, start = performance.now()) {
  root.spellcheck = false;
  editor = sdk.createEditor(root, { assetUrl, databaseName, identity, indexedDB, locks: navigator.locks,
    preset: 'minimal', typingShortcuts: false, plainPasteControl: false, plainTextPolicy: 'markdown',
    recover: async options => { session = await sdk.recoverLocalDocument(options); return session; } });
  await editor.ready;
  const first = blocks()[0], before = textOf(first);
  select(first.id, 0);
  input('insertText', 'x'); element(first.id).getBoundingClientRect();
  const elapsed = performance.now() - start;
  check(element(first.id).textContent === `x${before}`, 'First edit was not projected');
  input('deleteContentBackward');
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

export async function prepareFixture(name) {
  console.info('editac-benchmark-phase', name, 'seed');
  sdk = await import('./sdk.js'); runtime = await sdk.init(assetUrl);
  const { identity } = await seed(name);
  return { identity, databaseName };
}

export async function runScenario(name, config, prepared) {
  console.info('editac-benchmark-phase', name, 'cold/warm startup');
  const metrics = {}, memory = {};
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
      const at = offset > 0 && /[\uDC00-\uDFFF]/.test(before[offset] ?? '') ? offset - 1 : offset;
      for (let sample = 0; sample < config.samples; sample++) {
        select(node.id, at);
        record(`typing.${name}.${position}`, timed(() => input('insertText', 'x'), node.id).ms);
        check(element(node.id).textContent === before.slice(0, at) + 'x' + before.slice(at), 'Typing projection mismatch');
        record(`delete.${name}.${position}`, timed(() => input('deleteContentBackward'), node.id).ms);
        check(element(node.id).textContent === before, 'Backspace projection mismatch');
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
      select(first.id, 0); session.writer.engine.history({ type: 'explicit' }); input('insertText', 'x');
      record(`undo.${name}`, timed(() => input('historyUndo'), first.id).ms);
      check(element(first.id).textContent === before, 'Undo mismatch');
      record(`redo.${name}`, timed(() => input('historyRedo'), first.id).ms);
      check(element(first.id).textContent === `x${before}`, 'Redo mismatch');
      select(first.id, 1); input('deleteContentBackward');
    }
    check(allText() === expected, 'Core edit scenarios changed fixture text');
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
    check(session?.writer.engine.takeObserverErrors().length === 0 || !session, 'Engine observer failed');
    await unmount();
    return { fixture: name, chars: document.chars, metrics, memory, correctness: 'passed' };
  } catch (error) {
    return { fixture: name, chars: document.chars, metrics, memory, correctness: 'failed', failure: error.stack ?? error.message };
  } finally { await unmount(); await removeDatabase(); }
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
