import assert from 'node:assert/strict';
import { before, after, test } from 'node:test';
import { readFile, mkdtemp, rm, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { spawnSync } from 'node:child_process';
import { createServer } from 'node:http';
import { createHash } from 'node:crypto';
let runtime, temporary, server, sequence = 0;
const pack = process.env.EDITAC_ATOMIC_PACK_TARBALL;
const output = process.env.EDITAC_ATOMIC_BATCH_OUTPUT;
const facts = { qualification: 'prepared deterministic packed engine atomic primitive only', tests: [], serverClosed: false };
const recipe = JSON.parse(await readFile(new URL('../../../architecture/tests/editing-suite/recipes/seq-11.json', import.meta.url), 'utf8'));
before(async () => {
  assert.equal(process.version, 'v24.19.0'); assert.ok(pack, 'EDITAC_ATOMIC_PACK_TARBALL must identify the freshly built core tarball'); assert.ok(output, 'EDITAC_ATOMIC_BATCH_OUTPUT must be worktree-owned');
  temporary = await mkdtemp(join(tmpdir(), 'editac-atomic-pack-'));
  const unpack = spawnSync('tar', ['-xzf', resolve(pack), '-C', temporary], { encoding: 'utf8' }); assert.equal(unpack.status, 0, unpack.stderr);
  facts.packSha256 = createHash('sha256').update(await readFile(pack)).digest('hex');
  const bytes = await readFile(join(temporary, 'package/dist/wasm/editac_wasm_bg.wasm')); facts.wasmSha256 = createHash('sha256').update(bytes).digest('hex');
  server = createServer((request, response) => { if (request.url !== '/engine.wasm') { response.writeHead(404); response.end(); return; } response.setHeader('Content-Type', 'application/wasm'); response.end(bytes); });
  await new Promise((yes, no) => { server.once('error', no); server.listen(0, '127.0.0.1', yes); });
  facts.process = { pid: process.pid, port: server.address().port, workspace: resolve('.'), purpose: 'packed atomic WASM fixture' };
  const { init } = await import(pathToFileURL(join(temporary, 'package/dist/index.js'))); runtime = await init(`http://127.0.0.1:${server.address().port}/engine.wasm`);
});
after(async () => {
  if (server) { server.closeAllConnections(); await new Promise(yes => server.close(yes)); facts.serverClosed = !server.listening; }
  if (temporary) await rm(temporary, { recursive: true, force: true }); facts.temporaryPackageRemoved = true;
  if (output) { await mkdir(output, { recursive: true }); await writeFile(join(output, 'harness.json'), JSON.stringify(facts, null, 2)); }
});
function fixture(text = 'abc') {
  const serial = String(++sequence).padStart(12, '0');
  const engine = runtime.createEngine({ profile: 'v5', documentId: `42300000-0000-4000-8000-${serial}`, epoch: `42300000-0000-4000-9000-${serial}`, nodes: [{ text }] });
  const id = engine.read().visible[0].id;
  const commands = [ { type: 'replaceAt', owner: id, from: 1, to: 1, text: 'X' }, { type: 'markAt', owner: id, from: 1, to: 2, mark: 'bold', action: 'apply' }, { type: 'selectionAt', anchor: { owner: id, offset: 2, bias: 'left' }, focus: { owner: id, offset: 2, bias: 'right' } } ];
  const request = commands => ({ kind: 'editor', origin: 'atomic:fixture', commands });
  // Incremental projection diagnostics are consumed by reads; compare every persistent semantic field.
  const frozen = () => { const { changedNodes, touchedRanges, ...snapshot } = engine.read(); return { snapshot, checkpoint: Buffer.from(engine.checkpoint().bytes), vector: Buffer.from(engine.stateVector()), history: engine.history({ type: 'state' }) }; };
  return { engine, id, commands, request, frozen };
}
function reject(f, commands) { const old = f.frozen(); assert.equal(f.engine.can(f.request(commands)), false); assert.throws(() => f.engine.prepare(f.request(commands))); assert.deepEqual(f.frozen(), old); }
function release(engine, result) { if (result.selection) { engine.releaseAnchor(result.selection.anchor); engine.releaseAnchor(result.selection.focus); } if (result.caret) engine.releaseAnchor(result.caret); }
test('SEQ-11 invalid final operation and valid retry preserve identity and publish once', () => {
  const f = fixture(); const { engine, id, commands, request } = f; let events = 0; const subscription = engine.subscribe({ type: 'updates' }, () => events++);
  try {
    const original = engine.read().visible[0]; const invalid = structuredClone(commands); invalid[1].owner = 'missing'; reject(f, invalid); assert.equal(events, recipe.steps[0].expect.effects.localCommits);
    const before = f.frozen(); assert.equal(engine.can(request(commands)), true); const plan = engine.prepare(request(commands)); assert.deepEqual(f.frozen(), before);
    const result = engine.commit(plan); assert.equal(events, recipe.steps[1].expect.effects.localCommits); assert.equal(result.revision, before.snapshot.revision + 1);
    const node = engine.read().visible[0]; assert.equal(node.id, original.id); assert.equal(node.spans[0].source, original.spans[0].source); assert.equal(node.spans[0].identity, original.spans[0].identity);
    assert.equal(node.runs.map(r => r.text).join(''), recipe.steps[1].expect.state.blocks[0].text); assert.deepEqual(node.runs, [{ text: 'a', attributes: {} }, { text: 'X', attributes: { bold: true } }, { text: 'bc', attributes: {} }]);
    for (const token of [result.selection.anchor, result.selection.focus]) { const p = engine.resolve(token); assert.equal(p.type, 'position'); assert.equal(p.node, id); assert.equal(p.offset, 2); }
    assert.equal(engine.history({ type: 'state' }).undoGroups, 1); engine.history({ type: 'undo' }); assert.deepEqual(engine.read().visible[0].runs, [{ text: 'abc', attributes: {} }]); release(engine, result); facts.tests.push({ id: 'SEQ-11', invalidEffects: 0, validEffects: 1, ownerPreserved: true, sourcePreserved: true, resultOffsets: [2, 2] });
  } finally { subscription.dispose(); engine.dispose(); }
});
test('backward result preserves separate endpoints and biases', () => {
  const f = fixture(); try { f.commands[2].anchor.offset = 4; f.commands[2].focus.offset = 1; const r = f.engine.commit(f.engine.prepare(f.request(f.commands))); assert.equal(f.engine.resolve(r.selection.anchor).offset, 4); assert.equal(f.engine.resolve(r.selection.focus).offset, 1); assert.equal(f.engine.resolve(r.selection.anchor).bias, 'left'); assert.equal(f.engine.resolve(r.selection.focus).bias, 'right'); release(f.engine, r); } finally { f.engine.dispose(); }
});
test('post-insertion surrogate cuts and invalid final selection reject before mutation', () => {
  const f = fixture('a😀b'); try { const bad = structuredClone(f.commands); bad[1].from = 3; bad[1].to = 4; reject(f, bad); const badSelection = structuredClone(f.commands); badSelection[2].focus.offset = 99; reject(f, badSelection); reject(f, [f.commands[2], f.commands[0]]); } finally { f.engine.dispose(); }
});
test('ordered replacement and marks address the actual staged UTF-16 text', () => {
  const f = fixture(); try { f.commands[0].text = 'XY'; f.commands.splice(1, 0, { type: 'replaceAt', owner: f.id, from: 2, to: 3, text: 'Z' }); f.commands[2].to = 3; f.commands[3].anchor.offset = 3; f.commands[3].focus.offset = 3; const r = f.engine.commit(f.engine.prepare(f.request(f.commands))); assert.deepEqual(f.engine.read().visible[0].runs, [{ text: 'a', attributes: {} }, { text: 'XZ', attributes: { bold: true } }, { text: 'bc', attributes: {} }]); release(f.engine, r); } finally { f.engine.dispose(); }
});
test('stale plan cannot add phantom marks, updates or result handles', () => {
  const f = fixture(); let events = 0; const subscription = f.engine.subscribe({ type: 'updates' }, () => events++); try { const stale = f.engine.prepare(f.request(f.commands)); const other = f.engine.prepare(f.request([{ type: 'replaceAt', owner: f.id, from: 0, to: 0, text: 'Z' }])); f.engine.commit(other); assert.equal(events, 1); const before = f.frozen(); assert.throws(() => f.engine.commit(stale)); assert.deepEqual(f.frozen(), before); assert.throws(() => f.engine.commit(stale)); assert.equal(events, 1); } finally { subscription.dispose(); f.engine.dispose(); }
});
test('bounded batch and invalid mark schema reject without a live prefix', () => {
  const f = fixture(); try { reject(f, Array.from({ length: 129 }, () => f.commands[0])); const bad = structuredClone(f.commands); bad[1].mark = 'unsupported'; reject(f, bad); } finally { f.engine.dispose(); }
});
