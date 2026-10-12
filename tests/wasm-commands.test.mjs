import assert from 'node:assert/strict';
import { test, before, after } from 'node:test';
import { readFile, writeFile, mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { createServer } from 'node:http';
import * as Y from 'yjs';
import { init, EngineError } from '../packages/core/dist/index.js';
import { Engine as RawEngine } from '../packages/core/dist/wasm/editac_wasm.js';

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
  const bytes = await readFile(new URL('../packages/core/dist/wasm/editac_wasm_bg.wasm', import.meta.url));
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
