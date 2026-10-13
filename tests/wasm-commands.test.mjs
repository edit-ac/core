import assert from 'node:assert/strict';
import { test, before, after } from 'node:test';
import { readFile, writeFile, mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { spawnSync } from 'node:child_process';
import { createServer } from 'node:http';
import * as Y from 'yjs';
// Qualification may point at an independently unpacked npm artifact.
const packageRoot = process.env.EDITAC_WASM_COMMAND_PACKAGE
  ? pathToFileURL(`${process.env.EDITAC_WASM_COMMAND_PACKAGE}/`)
  : new URL('../packages/core/', import.meta.url);
const { init, EngineError } = await import(new URL('dist/index.js', packageRoot));
const { Engine: RawEngine } = await import(new URL('dist/wasm/editac_wasm.js', packageRoot));

const corpus = JSON.parse(await readFile(new URL('../fixtures/wasm-commands/cases.json', import.meta.url)));
const explicitEvidence = process.env.EDITAC_WASM_COMMAND_OUTPUT;
const evidence = explicitEvidence ?? await mkdtemp(join(tmpdir(), 'editac-wasm-commands-'));
let runtime, server;
const facts = { cases: [], process: { pid: process.pid, launcher: 'node --test tests/wasm-commands.test.mjs', workspace: new URL('../', import.meta.url).pathname, purpose: 'built-WASM command fixture HTTP asset', log: 'wasm-commands.log' } };
before(async () => {
  if (!explicitEvidence) {
    const native = spawnSync('cargo', ['test', '-p', 'editac-wasm', '--lib', '--locked', '--offline'], {
      cwd: fileURLToPath(new URL('../', import.meta.url)), encoding: 'utf8', timeout: 120_000,
      env: { ...process.env, EDITAC_WASM_COMMAND_OUTPUT: evidence },
    });
    await writeFile(`${evidence}/native.log`, (native.stdout ?? '') + (native.stderr ?? ''));
    assert.equal(native.error, undefined, `native fixture setup failed; log: ${evidence}/native.log`);
    assert.equal(native.status, 0, `native fixture setup failed; log: ${evidence}/native.log`);
    assert.match(native.stdout, /test result: ok\. [1-9][0-9]* passed; 0 failed; 0 ignored/, 'native setup must execute tests');
  }
  const bytes = await readFile(new URL('dist/wasm/editac_wasm_bg.wasm', packageRoot));
  server = createServer((req, res) => {
    if (req.url !== '/engine.wasm') { res.writeHead(404); res.end(); return; }
    res.setHeader('Content-Type', 'application/wasm'); res.end(bytes);
  });
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  facts.process.port = server.address().port;
  runtime = await init(`http://127.0.0.1:${server.address().port}/engine.wasm`);
});
after(async () => {
  if (server) { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); }
  facts.serverClosed = !server?.listening;
  await mkdir(evidence, { recursive: true }); await writeFile(`${evidence}/harness.json`, JSON.stringify(facts, null, 2));
  if (!explicitEvidence && facts.cases.length === corpus.cases.length) await rm(evidence, { recursive: true, force: true });
  else if (!explicitEvidence) console.log(`Preserved command fixture evidence: ${evidence}`);
});
function substitute(value, refs) {
  if (typeof value === 'string' && value.startsWith('$')) { assert.ok(refs.has(value.slice(1)), value); return refs.get(value.slice(1)); }
  if (Array.isArray(value)) return value.map(v => substitute(v, refs));
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, substitute(v, refs)]));
  return value;
}
function normalize(s, writer) {
  return ['n', 'c', 'o'].some(p => s.startsWith(`${p}:${writer}:`)) || s.startsWith(`${writer}:`) || s.startsWith(`<${writer}#`) || s.includes(`client: ClientID(${writer})`) ? s.replaceAll(writer, 'WRITER') : s;
}
function canonical(value, writer) {
  if (typeof value === 'string') return normalize(value, writer);
  if (Array.isArray(value)) {
    const result = value.map(v => canonical(v, writer));
    if (value.length === 7 && value[0] === 'split') {
      const bytes = Uint8Array.from(value[5]);
      const p = Y.decodeRelativePosition(bytes);
      assert.deepEqual(Y.encodeRelativePosition(p), bytes, 'noncanonical/trailing relative anchor bytes');
      const id = v => ({ client: String(v.client) === writer ? 'WRITER' : String(v.client), clock: v.clock });
      const decoded = { assoc: p.assoc };
      if (p.item) decoded.item = id(p.item);
      if (p.type) decoded.type = id(p.type);
      if (p.tname) decoded.tname = p.tname;
      result[5] = decoded;
    }
    return result;
  }
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([k, v]) => [normalize(k, writer), ["attributes", "text", "insert"].includes(k) ? v : canonical(v, writer)]));
  return value;
}
const text = n => n.runs.map(r => r.text).join('');
function expect(snapshot, step) {
  const blocks = snapshot.visible.filter(n => n.kind === 'block' && n.blockAttributes?.[0] !== 'separator');
  assert.deepEqual(blocks.map(text), step.texts);
  if (step.block) assert.deepEqual(blocks[0].blockAttributes, step.block);
  if (step.mark) assert.ok(blocks[0].runs.some(r => step.mark in r.attributes), `missing ${step.mark}`);
  if (step.absentMark) assert.ok(blocks[0].runs.every(r => !(step.absentMark in r.attributes)), `unexpected ${step.absentMark}`);
  if (step.unmarkedSuffix) { const r = blocks[0].runs.at(-1); assert.ok(r.text.endsWith(step.unmarkedSuffix)); assert.deepEqual(r.attributes, {}); }
  if (step.spans) assert.equal(blocks[0].spans.length, step.spans);
  if (step.numbers) assert.deepEqual(blocks.map(n => n.editor.number), step.numbers);
  if ('checked' in step) assert.equal(blocks[0].editor.checked, step.checked);
  if ('separators' in step) assert.equal(snapshot.visible.filter(n => n.blockAttributes?.[0] === 'separator').length, step.separators);
  if (step.rootBlock) assert.equal(blocks[0].parent, '@root');
}
for (const fixture of corpus.cases) test(`shared production engine fixture: ${fixture.id}`, async () => {
  const engine = runtime.createEngine(fixture.create);
  try {
    const initial = engine.read();
    const refs = new Map(initial.visible.map((n, i) => [String(i), n.id]));
    const writer = initial.visible[0].id.split(':')[1];
    const output = [canonical(initial, writer)];
    const rawOutput = [initial];
    for (const raw of fixture.steps) {
      const step = substitute(raw, refs);
      switch (step.action) {
        case 'anchor': refs.set(step.name, engine.anchor(step.node, step.offset, step.bias)); break;
        case 'commit': {
          const before = engine.history({ type: 'state' });
          const plan = engine.prepare(step.request);
          assert.deepEqual(engine.history({ type: 'state' }), before, 'preparation changed history/revision');
          engine.commit(plan); break;
        }
        case 'history': engine.history(step.request); break;
        case 'expect': { const s = engine.read(); expect(s, step); output.push(canonical(s, writer)); rawOutput.push(s); break; }
        case 'remember': {
          const selected = engine.read().visible.filter(n => step.kind === 'separator' ? n.blockAttributes?.[0] === 'separator' : n.kind === step.kind && n.blockAttributes?.[0] !== 'separator')[step.index];
          assert.ok(selected); refs.set(step.name, selected.id); break;
        }
        case 'resolve': { const r = engine.resolve(step.token); assert.equal(r.type, step.type); if ('offset' in step) assert.equal(r.offset, step.offset); output.push(canonical(r, writer)); rawOutput.push(r); break; }
        default: throw new Error(`unknown step ${step.action}`);
      }
    }
    // Native artifacts are mandatory: missing or zero native evidence fails parity.
    await writeFile(`${evidence}/wasm-raw-${fixture.id}.json`, JSON.stringify(rawOutput, null, 2));
    await writeFile(`${evidence}/wasm-${fixture.id}.json`, JSON.stringify(output, null, 2));
    assert.deepEqual(output, JSON.parse(await readFile(`${evidence}/native-${fixture.id}.json`)), 'native/WASM full snapshot parity');
    facts.cases.push(fixture.id);
  } finally { engine.dispose(); engine.dispose(); }
});
let serial = 100;
function fresh(texts = ['a😀b']) {
  const suffix = String(serial++).padStart(12, '0');
  return runtime.createEngine({ profile: 'v5', documentId: `75000000-0000-4000-8000-${suffix}`, epoch: `76000000-0000-4000-8000-${suffix}`, nodes: texts.map(text => ({ text })) });
}
function stable(engine) {
  const s = engine.read(); delete s.changedNodes; delete s.touchedRanges;
  return { snapshot: s, history: engine.history({ type: 'state' }) };
}
function rejectsUnchanged(engine, action, code) {
  const before = stable(engine);
  assert.throws(action, e => e instanceof EngineError && (!code || e.code === code));
  assert.deepEqual(stable(engine), before);
}
test('malformed JS shapes, unsafe numeric input and unknown fields reject before mutation', () => {
  const e = fresh();
  try {
    const node = e.read().visible[0].id;
    for (const offset of [-1, 0.5, NaN, Infinity, 2, 2 ** 32, '0', null]) rejectsUnchanged(e, () => e.anchor(node, offset, 'right'));
    for (const bias of ['forward', null, 1]) rejectsUnchanged(e, () => e.anchor(node, 0, bias));
    const valid = { kind: 'editor', origin: 'fixture', commands: [] };
    const cyclic = {}; cyclic.self = cyclic;
    const getter = { get kind() { throw new Error('must not invoke'); } };
    for (const request of [null, 1, [], {}, { ...valid, extra: true }, { ...valid, origin: 1 }, { ...valid, commands: [undefined] }, { ...valid, commands: Array(1) }, cyclic, getter, { ...valid, commands: [{ type: 'unknown' }] }, { ...valid, origin: 'x'.repeat(129) }]) rejectsUnchanged(e, () => e.prepare(request));
    rejectsUnchanged(e, () => e.history({ type: 'clear', extra: true }), 'InvalidInput');
    rejectsUnchanged(e, () => e.history({ type: 'typing', session: -1, time_ms: 1 }));
  } finally { e.dispose(); }
});
test('mixed valid and invalid command/format batches reject atomically', () => {
  const e = fresh();
  try {
    const node = e.read().visible[0].id;
    const a = e.anchor(node, 0, 'left'), b = e.anchor(node, 4, 'right');
    rejectsUnchanged(e, () => e.prepare({ kind: 'editor', origin: 'fixture', commands: [{ type: 'insert', at: a, text: 'valid' }, { type: 'join', first: node, second: 'missing' }] }));
    rejectsUnchanged(e, () => e.prepare({ kind: 'format', origin: 'fixture', marks: [{ range: { anchor: a, focus: b }, mark: 'bold', action: 'apply' }], blocks: [{ targets: [node], attributes: { type: 'heading', level: 7 }, action: 'apply' }] }));
    rejectsUnchanged(e, () => e.prepare({ kind: 'format', origin: 'fixture', marks: [{ range: { anchor: a, focus: b }, mark: 'link', action: 'apply', href: 'javascript:bad' }], blocks: [] }));
    rejectsUnchanged(e, () => e.prepare({ kind: 'editor', origin: 'fixture', commands: [{ type: 'convertSeparator', owner: node }] }));
    assert.equal(e.can({ kind: 'editor', origin: 'fixture', commands: [{ type: 'join', first: node, second: node }] }), false);
  } finally { e.dispose(); }
});
test('plans and anchors are scoped, single-use, explicitly releasable and stale-safe', () => {
  const a = fresh(), b = fresh();
  try {
    const node = a.read().visible[0].id, anchor = a.anchor(node, 0, 'left');
    const request = { kind: 'editor', origin: 'fixture', commands: [{ type: 'insert', at: anchor, text: 'x' }] };
    const first = a.prepare(request), stale = a.prepare(request), released = a.prepare(request);
    rejectsUnchanged(b, () => b.commit(first), 'InvalidHandle');
    rejectsUnchanged(b, () => b.resolve(anchor), 'InvalidHandle');
    rejectsUnchanged(b, () => b.prepare(request), 'InvalidHandle');
    a.releasePlan(released); a.releasePlan(released);
    rejectsUnchanged(a, () => a.commit(released), 'InvalidHandle');
    a.commit(first);
    rejectsUnchanged(a, () => a.commit(first), 'InvalidHandle');
    rejectsUnchanged(a, () => a.commit(stale), 'EngineRejected');
    a.releaseAnchor(anchor); a.releaseAnchor(anchor);
    rejectsUnchanged(a, () => a.resolve(anchor), 'InvalidHandle');
  } finally { a.dispose(); b.dispose(); }
});
test('can validates silently and disposal is explicit/idempotent for all operations', () => {
  const e = fresh(); const node = e.read().visible[0].id, anchor = e.anchor(node, 0, 'right');
  const request = { kind: 'editor', origin: 'fixture', commands: [{ type: 'insert', at: anchor, text: 'x' }] };
  const before = stable(e); assert.equal(e.can(request), true); assert.deepEqual(stable(e), before);
  const plan = e.prepare(request); e.dispose(); e.dispose();
  for (const call of [() => e.read(), () => e.anchor(node, 0, 'right'), () => e.resolve(anchor), () => e.prepare(request), () => e.can(request), () => e.commit(plan), () => e.history({ type: 'state' }), () => e.releaseAnchor(anchor), () => e.releasePlan(plan)]) assert.throws(call, x => x instanceof EngineError && x.code === 'Disposed');
});
test('raw built-WASM JSON errors are structured, byte bounded, and disposal rejects use', () => {
  const options = { profile: 'v5', documentId: '75000000-0000-4000-8000-000000000999', epoch: '76000000-0000-4000-8000-000000000999', nodes: [{ text: '' }] };
  for (const request of ['null', '{bad', JSON.stringify({ ...options, profile: 'v4' }), JSON.stringify({ ...options, nodes: [{ text: '', extra: 1 }] })]) assert.throws(() => new RawEngine(request), x => typeof x === 'string' && JSON.parse(x).code === 'InvalidInput');
  const e = new RawEngine(JSON.stringify(options));
  try {
    const before = e.read();
    assert.throws(() => e.prepare('x'.repeat(2 * 1024 * 1024 + 1)), x => JSON.parse(x).code === 'ResourceLimit');
    const after = JSON.parse(e.read()), original = JSON.parse(before); delete after.changedNodes; delete original.changedNodes; assert.deepEqual(after, original);
    e.dispose(); e.dispose();
    for (const call of [() => e.read(), () => e.prepare('{}'), () => e.anchor('{}'), () => e.resolve('x'), () => e.commit('x'), () => e.history('{}'), () => e.release_anchor('x'), () => e.release_plan('x')]) assert.throws(call, x => JSON.parse(x).code === 'Disposed');
  } finally { e.dispose(); e.free(); }
});
test('bounded anchor and plan tables reclaim released capacity', () => {
  const e = fresh(['']);
  try {
    const node = e.read().visible[0].id;
    const anchors = Array.from({ length: 4096 }, () => e.anchor(node, 0, 'left'));
    rejectsUnchanged(e, () => e.anchor(node, 0, 'left'), 'ResourceLimit');
    e.releaseAnchor(anchors[0]); e.anchor(node, 0, 'left');
    const request = { kind: 'editor', origin: 'fixture', commands: [] };
    const plans = Array.from({ length: 128 }, () => e.prepare(request));
    rejectsUnchanged(e, () => e.prepare(request), 'ResourceLimit');
    e.releasePlan(plans[0]); e.prepare(request);
  } finally { e.dispose(); }
});

test('parity normalization preserves literal content and opaque attributes', () => {
  const a = { id: 'n:11:1', spans: [{ identity: '<11#2>' }], runs: [{ text: 'n:11:1', attributes: { 'n:11:1': '<11#2>' } }] };
  const b = { id: 'n:22:1', spans: [{ identity: '<22#2>' }], runs: [{ text: 'n:11:1', attributes: { 'n:11:1': '<11#2>' } }] };
  assert.deepEqual(canonical(a, '11'), canonical(b, '22'));
  b.runs[0].text = 'n:22:1';
  assert.notDeepEqual(canonical(a, '11'), canonical(b, '22'));
});

test('explicitly empty creation adds no defaults and snapshots are detached values', () => {
  const empty = fresh([]), e = fresh();
  try {
    assert.deepEqual(empty.read().visible, []);
    assert.equal(empty.read().revision, 0);
    const before = stable(e), snapshot = e.read();
    snapshot.visible[0].runs[0].text = 'caller-mutated';
    snapshot.identity.documentId = 'caller-mutated';
    snapshot.visible.splice(0);
    assert.deepEqual(stable(e), before);
  } finally { empty.dispose(); e.dispose(); }
});

// Heading-end expectations are authored independently of native parity snapshots.
function headingText(node) { return node.runs.map(r => r.text).join(''); }
function headingNodes(e) { return e.read().visible.filter(n => n.kind === 'block'); }
function editorRequest(commands) { return { kind: 'editor', origin: 'heading-end:explicit', commands }; }
function headingFixture(texts = ['H😀Z', 'peer']) {
  const e = fresh(texts), owner = headingNodes(e)[0].id;
  const anchor = e.anchor(owner, 0, 'left'), focus = e.anchor(owner, texts[0].length, 'right');
  e.commit(e.prepare({ kind: 'format', origin: 'setup', marks: texts[0].length ? [{ range: { anchor, focus }, mark: 'bold', action: 'apply' }] : [], blocks: [{ targets: [owner], attributes: { type: 'heading', level: 2 }, action: 'apply' }] }));
  e.releaseAnchor(anchor); e.releaseAnchor(focus);
  e.history({ type: 'clear' });
  return e;
}
function headingFrozen(e) { e.read(); return { state: stable(e), checkpoint: e.checkpoint(), vector: e.stateVector() }; }
function headingReject(e, fn, code) {
  const before = headingFrozen(e), updates = [];
  const sub = e.subscribe({ type: 'updates' }, patch => updates.push(patch));
  try { assert.throws(fn, err => err instanceof EngineError && (!code || err.code === code)); assert.deepEqual(headingFrozen(e), before); assert.deepEqual(updates, []); }
  finally { sub.dispose(); }
}

test('headingEnd packed command preserves heading/marks, stable UTF-16 caret and one update/history group', () => {
  const e = headingFixture();
  try {
    const before = headingNodes(e), at = e.anchor(before[0].id, 4, 'right');
    const request = editorRequest([{ type: 'headingEnd', owner: before[0].id, at }]);
    const state = headingFrozen(e), updates = []; e.subscribe({ type: 'updates' }, p => updates.push(p));
    assert.equal(e.can(request), true); const plan = e.prepare(request);
    assert.deepEqual(headingFrozen(e), state); assert.deepEqual(updates, []);
    const commit = e.commit(plan); const after = headingNodes(e);
    assert.deepEqual(after.map(headingText), ['H😀Z', '', 'peer']);
    assert.equal(after[0].id, before[0].id); assert.deepEqual(after[0].blockAttributes, ['heading', 2]);
    assert.deepEqual(after[0].runs, before[0].runs); assert.deepEqual(after[2], { ...before[1], order: after[2].order });
    assert.deepEqual(after[1].blockAttributes, ['paragraph']); assert.equal(after[1].parent, before[0].parent);
    assert.deepEqual(e.resolve(commit.caret), { type: 'position', node: after[1].id, offset: 0, source: after[1].spans[0].source, sourceOffset: 0, bias: 'right' });
    assert.equal(e.resolve(at).node, before[0].id); assert.equal(e.resolve(at).offset, 4);
    e.releaseAnchor(commit.caret); assert.throws(() => e.resolve(commit.caret), err => err.code === 'InvalidHandle');
    assert.equal(updates.length, 1); assert.equal(updates[0].operation, 'Editor'); assert.ok(updates[0].update.bytes.length > 2);
    assert.equal(e.history({ type: 'state' }).undoGroups, 1); assert.equal(e.read().revision, state.state.snapshot.revision + 1);
    e.history({ type: 'undo' }); assert.deepEqual(headingNodes(e).map(headingText), ['H😀Z', 'peer']);
    e.history({ type: 'redo' }); assert.deepEqual(headingNodes(e).map(headingText), ['H😀Z', '', 'peer']);
    const restored = runtime.restoreEngine(e.checkpoint().identity, e.checkpoint());
    try { assert.deepEqual(headingNodes(restored).map(n => [headingText(n), n.blockAttributes]), [['H😀Z', ['heading', 2]], ['', ['paragraph']], ['peer', ['paragraph']]]); }
    finally { restored.dispose(); }
  } finally { e.dispose(); }
});

test('headingEnd selected suffix deletion resolves the retained cut after one atomic batch', () => {
  const e = headingFixture();
  try {
    const owner = headingNodes(e)[0].id, at = e.anchor(owner, 1, 'right');
    const range = { anchor: e.anchor(owner, 1, 'left'), focus: e.anchor(owner, 4, 'right') };
    const updates = []; e.subscribe({ type: 'updates' }, p => updates.push(p));
    const commit = e.commit(e.prepare(editorRequest([{ type: 'delete', range }, { type: 'headingEnd', owner, at }])));
    const n = headingNodes(e); assert.deepEqual(n.map(headingText), ['H', '', 'peer']);
    assert.equal(n[0].id, owner); assert.deepEqual(n[0].blockAttributes, ['heading', 2]); assert.equal(n[0].runs[0].attributes.bold, true);
    assert.equal(e.resolve(commit.caret).node, n[1].id); assert.equal(e.resolve(commit.caret).offset, 0);
    assert.equal(updates.length, 1); assert.equal(e.history({ type: 'state' }).undoGroups, 1);
    e.history({ type: 'undo' }); assert.deepEqual(headingNodes(e).map(headingText), ['H😀Z', 'peer']);
    e.history({ type: 'redo' }); assert.deepEqual(headingNodes(e).map(headingText), ['H', '', 'peer']);
  } finally { e.dispose(); }
});

test('headingEnd cross-block selected replacement stages deletes/join and preserves authored caret/history', () => {
  const e = headingFixture(['H😀Z', 'remove', 'peer']);
  try {
    const n = headingNodes(e), owner = n[0].id, at = e.anchor(owner, 1, 'right');
    const range = (node, start, end) => ({ anchor: e.anchor(node, start, 'left'), focus: e.anchor(node, end, 'right') });
    const updates = []; e.subscribe({ type: 'updates' }, p => updates.push(p));
    const request = editorRequest([{ type: 'delete', range: range(owner, 1, 4) }, { type: 'delete', range: range(n[1].id, 0, 6) }, { type: 'join', first: owner, second: n[1].id }, { type: 'headingEnd', owner, at }]);
    const before = headingFrozen(e); assert.equal(e.can(request), true); assert.deepEqual(headingFrozen(e), before);
    const commit = e.commit(e.prepare(request)); const result = headingNodes(e);
    assert.deepEqual(result.map(headingText), ['H', '', 'peer']); assert.equal(result[0].id, owner);
    assert.deepEqual(result[0].blockAttributes, ['heading', 2]); assert.deepEqual(result[1].blockAttributes, ['paragraph']);
    assert.equal(e.resolve(commit.caret).node, result[1].id); assert.equal(e.resolve(commit.caret).offset, 0);
    assert.equal(updates.length, 1); assert.equal(e.history({ type: 'state' }).undoGroups, 1);
    e.history({ type: 'undo' }); assert.deepEqual(headingNodes(e).map(headingText), ['H😀Z', 'remove', 'peer']);
    e.history({ type: 'redo' }); assert.deepEqual(headingNodes(e).map(headingText), ['H', '', 'peer']);
  } finally { e.dispose(); }
});

test('headingEnd rejects empty/interior/nonheading/malformed targets and mixed batches without any effects', () => {
  const e = headingFixture(), empty = headingFixture(['']);
  try {
    const n = headingNodes(e), owner = n[0].id;
    for (const offset of [0, 1, 3]) {
      const request = editorRequest([{ type: 'headingEnd', owner, at: e.anchor(owner, offset, 'right') }]);
      const before = headingFrozen(e); assert.equal(e.can(request), false); assert.deepEqual(headingFrozen(e), before);
      headingReject(e, () => e.prepare(request), 'EngineRejected');
    }
    headingReject(e, () => e.anchor(owner, 2, 'right'));
    const at = e.anchor(owner, 4, 'right');
    for (const command of [{ type: 'headingEnd', owner: 'missing', at }, { type: 'headingEnd', owner: n[1].id, at: e.anchor(n[1].id, 4, 'right') }, { type: 'headingEnd', owner, at, extra: true }, { type: 'headingEnd', owner, at: 4 }]) headingReject(e, () => e.prepare(editorRequest([command])));
    headingReject(e, () => e.prepare(editorRequest([{ type: 'headingEnd', owner, at }, { type: 'join', first: owner, second: 'missing' }])));
    const range = { anchor: e.anchor(owner, 0, 'left'), focus: at };
    headingReject(e, () => e.prepare(editorRequest([{ type: 'delete', range }, { type: 'headingEnd', owner, at }])));
    headingReject(e, () => e.prepare(editorRequest(Array(4097).fill({ type: 'headingEnd', owner, at }))));
    const id = headingNodes(empty)[0].id;
    headingReject(empty, () => empty.prepare(editorRequest([{ type: 'headingEnd', owner: id, at: empty.anchor(id, 0, 'right') }])));
  } finally { e.dispose(); empty.dispose(); }
});

test('headingEnd stale/released/foreign anchors and disposed plans use the existing packed boundary', () => {
  const e = headingFixture(), peer = headingFixture();
  try {
    const owner = headingNodes(e)[0].id, at = e.anchor(owner, 4, 'right');
    const request = editorRequest([{ type: 'headingEnd', owner, at }]);
    const plan = e.prepare(request), otherPlan = e.prepare(request);
    headingReject(peer, () => peer.prepare(request), 'InvalidHandle');
    headingReject(peer, () => peer.commit(otherPlan), 'InvalidHandle');
    const n = headingNodes(e)[1]; e.commit(e.prepare(editorRequest([{ type: 'insert', at: e.anchor(n.id, 0, 'right'), text: 'R' }])));
    headingReject(e, () => e.commit(plan), 'EngineRejected');
    e.releaseAnchor(at); headingReject(e, () => e.prepare(request), 'InvalidHandle');
    const final = editorRequest([{ type: 'headingEnd', owner, at: e.anchor(owner, 4, 'right') }]);
    const p = e.prepare(final); e.dispose();
    for (const fn of [() => e.can(final), () => e.prepare(final), () => e.commit(p)]) assert.throws(fn, err => err instanceof EngineError && err.code === 'Disposed');
  } finally { e.dispose(); peer.dispose(); }
});

test('headingEnd peer-preserving undo/redo and replay retain the original heading with unrelated remote edits', () => {
  const e = headingFixture(); const peer = runtime.restoreEngine(e.checkpoint().identity, e.checkpoint());
  try {
    const n = headingNodes(e), at = e.anchor(n[0].id, 4, 'right');
    peer.commit(peer.prepare(editorRequest([{ type: 'insert', at: peer.anchor(n[1].id, 4, 'right'), text: 'R' }])));
    const remote = peer.encodeUpdate();
    e.commit(e.prepare(editorRequest([{ type: 'headingEnd', owner: n[0].id, at }])));
    peer.applyUpdate(e.encodeUpdate()); e.applyUpdate(remote);
    const expected = [['H😀Z', ['heading', 2]], ['', ['paragraph']], ['peerR', ['paragraph']]];
    const view = engine => headingNodes(engine).map(n => [headingText(n), n.blockAttributes]);
    assert.deepEqual(view(e), expected); assert.deepEqual(view(peer), expected); assert.equal(e.history({ type: 'state' }).undoGroups, 1);
    const updates = []; e.subscribe({ type: 'updates' }, p => updates.push(p));
    e.history({ type: 'undo' }); peer.applyUpdate(updates.at(-1).update);
    assert.deepEqual(view(e), [['H😀Z', ['heading', 2]], ['peerR', ['paragraph']]]); assert.deepEqual(view(peer), view(e));
    e.history({ type: 'redo' }); peer.applyUpdate(updates.at(-1).update);
    assert.deepEqual(view(e), expected); assert.deepEqual(view(peer), expected);
    assert.equal(e.resolve(at).offset, 4); assert.equal(e.resolve(at).node, n[0].id); assert.deepEqual(headingNodes(e)[0].runs, n[0].runs);
  } finally { e.dispose(); peer.dispose(); }
});

test('headingEnd keeps the parent under quote and admission failures cannot change its packed result', () => {
  const e = headingFixture();
  try {
    const owner = headingNodes(e)[0].id;
    e.commit(e.prepare(editorRequest([{ type: 'wrap', targets: [owner], style: { type: 'quote' } }]))); e.history({ type: 'clear' });
    const parent = headingNodes(e)[0].parent;
    e.commit(e.prepare(editorRequest([{ type: 'headingEnd', owner, at: e.anchor(owner, 4, 'right') }])));
    const n = headingNodes(e); assert.equal(n[0].parent, parent); assert.equal(n[1].parent, parent); assert.deepEqual(n[1].blockAttributes, ['paragraph']);
    const u = e.encodeUpdate(); headingReject(e, () => e.applyUpdate({ ...u, identity: { ...u.identity, epoch: '76000000-0000-4000-8000-999999999999' } }), 'EngineRejected');
    assert.equal(e.history({ type: 'state' }).undoGroups, 1);
  } finally { e.dispose(); }
});

test('headingEnd deleted remote target rejects rather than redirecting the retained anchor', () => {
  const e = headingFixture(); const remote = new Y.Doc();
  try {
    const owner = headingNodes(e)[0].id, at = e.anchor(owner, 4, 'right');
    Y.applyUpdate(remote, e.checkpoint().bytes); remote.getMap('registry-entity-controls').set(owner, ['enabled', false]);
    e.applyUpdate({ identity: e.checkpoint().identity, bytes: Y.encodeStateAsUpdate(remote) });
    assert.equal(e.resolve(at).type, 'deleted');
    const request = editorRequest([{ type: 'headingEnd', owner, at }]);
    const before = headingFrozen(e); assert.equal(e.can(request), false); assert.deepEqual(headingFrozen(e), before);
    headingReject(e, () => e.prepare(request), 'EngineRejected'); assert.deepEqual(headingNodes(e).map(headingText), ['peer']);
  } finally { remote.destroy(); e.dispose(); }
});

test('headingEnd admission honors the existing host read-only guard before preparation', async () => {
  const { KeyboardInput } = await import('../packages/web/dist/input/keyboard.js');
  const e = headingFixture();
  try {
    // This proves the existing host guard with a real packed engine. It is a
    // prepared boundary check, not a DOM/device or writable-route qualification.
    let prepared = 0;
    const keyboard = new KeyboardInput({}, { retain() { throw new Error('read-only must not capture a target'); } }, e,
      request => { prepared++; return e.commit(e.prepare(request)); }, () => true);
    const before = headingFrozen(e);
    assert.deepEqual(keyboard.execute('enter'), { disposition: 'rejected', reason: 'read-only-or-composing' });
    assert.equal(prepared, 0); assert.deepEqual(headingFrozen(e), before);
    keyboard.dispose();
    assert.deepEqual(keyboard.execute('enter'), { disposition: 'rejected', reason: 'disposed' });
    assert.deepEqual(headingFrozen(e), before);
  } finally { e.dispose(); }
});

test('headingEnd stable caret selects the new paragraph before an existing shared-source sibling', () => {
  const e = headingFixture(['H😀Ztail', 'peer']);
  try {
    const owner = headingNodes(e)[0].id, cut = e.anchor(owner, 4, 'right');
    e.commit(e.prepare(editorRequest([{ type: 'split', owner, at: cut }])));
    const sibling = e.resolve(cut).node;
    e.commit(e.prepare({ kind: 'format', origin: 'setup', marks: [], blocks: [{ targets: [sibling], attributes: { type: 'paragraph' }, action: 'apply' }] }));
    e.history({ type: 'clear' });
    const at = e.anchor(owner, 4, 'right');
    const commit = e.commit(e.prepare(editorRequest([{ type: 'headingEnd', owner, at }])));
    const result = headingNodes(e);
    assert.deepEqual(result.map(headingText), ['H😀Z', '', 'tail', 'peer']);
    assert.deepEqual(result[1].blockAttributes, ['paragraph']);
    assert.equal(e.resolve(commit.caret).node, result[1].id, 'caret must select the new paragraph rather than its shared-source sibling');
    assert.equal(e.resolve(commit.caret).offset, 0);
    assert.equal(e.resolve(at).node, sibling); assert.equal(e.resolve(at).offset, 0);
    const siblingBefore = result[2];
    e.commit(e.prepare(editorRequest([{ type: 'insert', at: commit.caret, text: 'X' }])));
    assert.deepEqual(headingNodes(e).map(headingText), ['H😀Z', 'X', 'tail', 'peer']);
    assert.deepEqual(headingNodes(e)[2], siblingBefore);
    const restored = runtime.restoreEngine(e.checkpoint().identity, e.checkpoint());
    try { assert.deepEqual(headingNodes(restored).map(n => [headingText(n), n.blockAttributes]), [['H😀Z', ['heading', 2]], ['X', ['paragraph']], ['tail', ['paragraph']], ['peer', ['paragraph']]]); } finally { restored.dispose(); }
    const other = headingFixture();
    try { assert.throws(() => other.resolve(commit.caret), err => err.code === 'InvalidHandle'); } finally { other.dispose(); }
    e.releaseAnchor(commit.caret); assert.throws(() => e.resolve(commit.caret), err => err.code === 'InvalidHandle');
  } finally { e.dispose(); }
});


test('headingEnd result reservations share anchor capacity and release on stale or released plans', () => {
  const e = headingFixture();
  try {
    const owner = headingNodes(e)[0].id, at = e.anchor(owner, 4, 'right');
    const request = editorRequest([{ type: 'headingEnd', owner, at }]);
    const anchors = Array.from({ length: 4094 }, () => e.anchor(owner, 0, 'left'));
    const before = headingFrozen(e);
    assert.equal(e.can(request), true);
    const plan = e.prepare(request);
    assert.equal(e.can(request), false);
    headingReject(e, () => e.anchor(owner, 0, 'left'), 'ResourceLimit');
    headingReject(e, () => e.prepare(request), 'ResourceLimit');
    e.releasePlan(plan); assert.equal(e.can(request), true);
    const stale = e.prepare(request);
    e.commit(e.prepare(editorRequest([{ type: 'insert', at, text: 'X' }])));
    headingReject(e, () => e.commit(stale), 'EngineRejected');
    const end = e.anchor(owner, 5, 'right');
    e.releaseAnchor(anchors.pop());
    const commit = e.commit(e.prepare(editorRequest([{ type: 'headingEnd', owner, at: end }])));
    assert.equal(e.resolve(commit.caret).node, headingNodes(e)[1].id);
    headingReject(e, () => e.anchor(owner, 0, 'left'), 'ResourceLimit');
    e.releaseAnchor(commit.caret); const replacement = e.anchor(owner, 0, 'left');
    e.releaseAnchor(replacement);
    assert.equal(before.state.snapshot.revision + 2, e.read().revision);
  } finally { e.dispose(); }
});

test('ordinary packed commands omit result carets and can does not consume token IDs', () => {
  const e = headingFixture();
  try {
    const owner = headingNodes(e)[0].id, at = e.anchor(owner, 4, 'right');
    const request = editorRequest([{ type: 'headingEnd', owner, at }]);
    const baseline = Number(at.split(':').at(-1));
    for (let i = 0; i < 32; i++) assert.equal(e.can(request), true);
    const next = e.anchor(owner, 0, 'left');
    assert.equal(Number(next.split(':').at(-1)), baseline + 1);
    const commit = e.commit(e.prepare(editorRequest([{ type: 'insert', at: next, text: 'X' }])));
    assert.deepEqual(Object.keys(commit), ['revision']);
  } finally { e.dispose(); }
});


test('headingEnd result caret and pending reservations expire with their owning engine', () => {
  const e = headingFixture();
  try {
    const owner = headingNodes(e)[0].id, at = e.anchor(owner, 4, 'right');
    const result = e.commit(e.prepare(editorRequest([{ type: 'headingEnd', owner, at }])));
    assert.equal(e.resolve(result.caret).offset, 0);
    e.prepare(editorRequest([{ type: 'headingEnd', owner, at }]));
    e.dispose();
    assert.throws(() => e.resolve(result.caret), err => err.code === 'Disposed');
    assert.throws(() => e.can(editorRequest([{ type: 'headingEnd', owner, at }])), err => err.code === 'Disposed');
    e.dispose();
  } finally { e.dispose(); }
});

test('fragment preflight survives a history boundary and revalidates after replica mutation', () => {
  const e=fresh(['alpha']), peer=runtime.restoreEngine(e.read().identity,e.checkpoint());
  const node=e.read().visible[0].id, anchor=e.anchor(node,0,'right'), focus=e.anchor(node,5,'left');
  const request={kind:'fragment',origin:'preflight-fixture',range:{anchor,focus},blocks:[{attributes:{type:'heading',level:2},runs:[{text:'safe',marks:[{mark:'bold'}]}]}]};
  try{
    const before=Array.from(e.checkpoint().bytes);assert.equal(e.can(request),true);assert.equal(e.can(request),true);assert.deepEqual(Array.from(e.checkpoint().bytes),before);assert.equal(e.history({type:'state'}).undoGroups,0);
    const vector=e.stateVector(),at=peer.anchor(node,0,'right');try{peer.commit(peer.prepare({kind:'text',origin:'prepared-peer',command:{type:'insert',at,text:'remote '}}));}finally{peer.releaseAnchor(at);}
    e.applyUpdate(peer.encodeUpdate(vector));assert.equal(e.can(request),true);e.history({type:'explicit'});const plan=e.prepare(request);try{e.commit(plan);}finally{e.releasePlan(plan);}
    assert.equal(e.read().visible[0].runs.map(r=>r.text).join(''),'remote safe');assert.equal(e.history({type:'state'}).undoGroups,1);
    e.history({type:'undo'});assert.equal(e.read().visible[0].runs.map(r=>r.text).join(''),'remote alpha');
  }finally{e.releaseAnchor(anchor);e.releaseAnchor(focus);e.dispose();peer.dispose();}
});
