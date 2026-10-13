import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtemp, mkdir, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { shareEngineStringAdapters } from '../scripts/share-wasm-glue.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));
let scratch, originalSource, original, shared;
before(async () => {
  scratch = await mkdtemp(join(tmpdir(), 'editac-glue-parity-'));
  const cli = process.env.WASM_BINDGEN || 'wasm-bindgen';
  const version = spawnSync(cli, ['--version'], { encoding: 'utf8' });
  assert.equal(version.status, 0);
  assert.equal(version.stdout.trim(), 'wasm-bindgen 0.2.129');
  const generated = spawnSync(cli, [join(root, 'target/browser-inputs/production/editac_wasm.wasm'), '--target', 'web', '--out-dir', scratch, '--out-name', 'editac_wasm'], { encoding: 'utf8' });
  await writeFile(join(scratch, 'generation.log'), (generated.stdout || '') + (generated.stderr || ''));
  assert.equal(generated.error, undefined);
  assert.equal(generated.status, 0);
  originalSource = await readFile(join(scratch, 'editac_wasm.js'), 'utf8');
  await writeFile(join(scratch, 'original.mjs'), originalSource);
  await writeFile(join(scratch, 'shared.mjs'), shareEngineStringAdapters(originalSource));
  const bytes = await readFile(join(scratch, 'editac_wasm_bg.wasm'));
  assert.deepEqual(bytes, await readFile(join(root, 'packages/core/dist/wasm/editac_wasm_bg.wasm')), 'compare the exact production WASM');
  assert.equal(shareEngineStringAdapters(originalSource), await readFile(join(root, 'packages/core/dist/wasm/editac_wasm.js'), 'utf8'), 'production uses the tested transform');
  original = await import(pathToFileURL(join(scratch, 'original.mjs')));
  shared = await import(pathToFileURL(join(scratch, 'shared.mjs')));
  original.initSync({ module: bytes }); shared.initSync({ module: bytes });
});
after(async () => { if (scratch) await rm(scratch, { recursive: true, force: true }); });

test('pinned complete-template checks reject ABI drift, duplicates and repeat processing', () => {
  for (const [from, to] of [
    ["typeof Response === 'function' && module instanceof Response", "module instanceof Response"],
    ['wasm.engine_anchor(retptr, this.__wbg_ptr, ptr0, len0);', 'wasm.engine_anchor(retptr, ptr0, len0);'],
    ['wasm.__wbindgen_add_to_stack_pointer(16);', 'wasm.__wbindgen_add_to_stack_pointer(32);'],
    ['wasm.__wbindgen_export4(deferred3_0, deferred3_1, 1);', 'wasm.__wbindgen_export4(deferred3_0, deferred3_1, 2);'],
    ['if (r3) {', 'if (r2) {'],
    ['    anchor(input) {', '    anchor(changed) {'],
    ['wasm.engine_checkpoint_bytes(retptr, this.__wbg_ptr);', 'wasm.engine_checkpoint_bytes(retptr, 0);'],
    ['getArrayU8FromWasm0(r0, r1).slice()', 'getArrayU8FromWasm0(r0, r1)'],
    ['wasm.engine_release_plan(retptr, this.__wbg_ptr, ptr0, len0);', 'wasm.engine_release_plan(retptr, 0, ptr0, len0);'],
  ]) assert.throws(() => shareEngineStringAdapters(originalSource.replace(from, to)), /template mismatch/);
  assert.throws(() => shareEngineStringAdapters(originalSource + originalSource), /template mismatch/);
  assert.throws(() => shareEngineStringAdapters(shareEngineStringAdapters(originalSource)), /already optimized/);
  assert.ok(shareEngineStringAdapters(originalSource + '\n// unrelated host marker\n').includes('// unrelated host marker'));
});

test('binary and void adapters preserve detached buffers, rejection and stack cleanup', () => {
  for (const Bindings of [original, shared]) {
    const input = JSON.parse(creation()); input.documentId = '87000000-0000-4000-8000-000000000002';
    const engine = new Bindings.Engine(JSON.stringify(input));
    try {
      const checkpoint = engine.checkpoint_bytes(), retained = new Uint8Array(checkpoint);
      const vector = engine.state_vector(), retainedVector = new Uint8Array(vector);
      assert(checkpoint.length > 0); assert(vector.length > 0);
      const update = engine.encode_update(new Uint8Array([0]));
      assert(update instanceof Uint8Array && update.length > 0);
      const copiedUpdate = new Uint8Array(update);
      const metadata = JSON.parse(engine.checkpoint_metadata());
      const peer = Bindings.Engine.restore(JSON.stringify({ expected: metadata.identity, ...metadata, journal: [] }), checkpoint);
      try {
        peer.apply_update(JSON.stringify(metadata.identity), update);
        assert.deepEqual(JSON.parse(peer.read()).visible.map(n => n.runs), JSON.parse(engine.read()).visible.map(n => n.runs));
      } finally { peer.free(); }
      for (let i = 0; i < 64; i++) {
        assert.throws(() => engine.encode_update(new Uint8Array([255])));
        assert.throws(() => engine.encode_update(undefined));
        assert.throws(() => engine.release_anchor(undefined));
        assert.throws(() => engine.release_plan(undefined));
        engine.read();
      }
      assert.deepEqual(checkpoint, retained);
      assert.deepEqual(vector, retainedVector);
      assert.deepEqual(update, copiedUpdate);
      assert.deepEqual(engine.checkpoint_bytes(), retained);
      engine.dispose();
      for (const method of ['checkpoint_bytes', 'state_vector', 'encode_update']) {
        assert.throws(() => engine[method](new Uint8Array([0])));
      }
    } finally { engine.free(); }
  }
});

const creation = () => JSON.stringify({profile:'v5',documentId:'87000000-0000-4000-8000-000000000001',epoch:'88000000-0000-4000-8000-000000000001',nodes:[{text:'A👩🏽‍💻 café שלום'}]});
function exercise(Bindings) {
  const engine = new Bindings.Engine(creation());
  const metadata = JSON.parse(engine.checkpoint_metadata());
  const peer = Bindings.Engine.restore(JSON.stringify({expected:metadata.identity, ...metadata, journal:[]}), engine.checkpoint_bytes());
  const facts = [];
  const call = (method, ...args) => {
    try { const value = engine[method](...args); facts.push({ method, value }); return value; }
    catch (error) { facts.push({ method, error: error instanceof Error ? {name:error.name,message:error.message} : error }); return undefined; }
  };
  try {
    const snapshot = JSON.parse(call('read'));
    call('take_patch'); call('checkpoint_metadata');
    const node = snapshot.visible[0].id;
    const anchor = JSON.parse(call('anchor', JSON.stringify({ node, offset: 1, bias: 'right' }))).token;
    const portable = call('export_anchor', anchor);
    const imported = JSON.parse(call('import_anchor', portable)).token;
    call('resolve', imported);
    const request = JSON.stringify({ kind: 'text', origin: 'glue:parity', command: { type: 'insert', at: anchor, text: 'é🙂' } });
    call('can', request);
    const plan = JSON.parse(call('prepare', request)).token;
    call('commit', plan); call('commit', plan); call('take_patch');
    call('history', JSON.stringify({ type: 'undo' })); call('take_patch');
    call('history', JSON.stringify({ type: 'redo' })); call('take_patch');

    const peerAt = JSON.parse(peer.anchor(JSON.stringify({ node: JSON.parse(peer.read()).visible[0].id, offset: 0, bias: 'right' }))).token;
    peer.commit(JSON.parse(peer.prepare(JSON.stringify({ kind: 'text', origin: 'glue:peer', command: { type: 'insert', at: peerAt, text: 'remote ' } }))).token);
    const metadata = JSON.parse(peer.checkpoint_metadata());
    call('apply_update', JSON.stringify(metadata.identity), peer.encode_update(new Uint8Array([0])));
    call('take_patch'); call('resolve', anchor); call('read');
    const beforeBytes = engine.checkpoint_bytes();
    for (const method of ['anchor', 'can', 'commit', 'export_anchor', 'history', 'import_anchor', 'prepare', 'resolve']) call(method, '{');
    call('apply_update', '{', new Uint8Array());
    assert.deepEqual(engine.checkpoint_bytes(), beforeBytes, 'rejected input cannot mutate');
    // Exercise JS marshalling throws before WASM entry and repeated error cleanup.
    for (let i = 0; i < 64; i++) { call('anchor', undefined); call('apply_update', '{}', undefined); call('read'); }
    engine.release_anchor(anchor); engine.release_anchor(imported);
    call('resolve', anchor);
    const retained = engine.checkpoint_bytes();
    engine.anchor(JSON.stringify({ node, offset: 0, bias: 'left' }));
    assert.deepEqual(retained, beforeBytes, 'returned byte buffers remain detached');
    engine.dispose();
    for (const method of ['read', 'checkpoint_metadata', 'take_patch']) call(method);
    for (const method of ['anchor', 'can', 'commit', 'export_anchor', 'history', 'import_anchor', 'prepare', 'resolve']) call(method, '{}');
    call('apply_update', '{}', new Uint8Array());
    return facts;
  } finally { engine.free(); peer.free(); }
}

test('original and shared compiled adapters preserve successes, errors, ownership and cleanup', () => {
  const summarize = facts => facts.map(({method,value,error}) => {
    if (error !== undefined) {
      if (typeof error === 'string') { const detail=JSON.parse(error); return {method,error:{code:detail.code,operation:detail.operation}}; }
      return {method,error};
    }
    const result=JSON.parse(value);
    if (method==='read') return {method,revision:result.revision,visible:result.visible.map(n=>({kind:n.kind,runs:n.runs,blockAttributes:n.blockAttributes})),recovery:result.recovery.map(n=>({kind:n.kind,runs:n.runs}))};
    if (method==='checkpoint_metadata') return {method,identity:result.identity,initialized:result.initialized};
    if (method==='take_patch') return {method,empty:result===null};
    if (method==='anchor'||method==='import_anchor'||method==='prepare') return {method,token:typeof result.token};
    if (method==='export_anchor') return {method,version:result.version,identity:result.identity};
    if (method==='resolve') return {method,type:result.type,offset:result.offset,bias:result.bias};
    if (method==='history') return {method,revision:result.revision,undoGroups:result.undoGroups,redoGroups:result.redoGroups};
    if (method==='commit') return {method,revision:result.revision,applied:result.applied};
    return {method,value:result};
  });
  const candidate=exercise(shared), baseline=exercise(original);
  assert.deepEqual(summarize(candidate), summarize(baseline));
  // Success and rejection must both execute; matching errors alone are insufficient.
  for (const facts of [candidate,baseline]) {
    for (const method of ['can','commit','history','apply_update']) assert(facts.some(f=>f.method===method&&f.value!==undefined), `${method} success missing`);
    assert(facts.some(f=>f.method==='commit'&&f.error!==undefined),'consumed-plan rejection missing');
  }
  assert.deepEqual(Object.getOwnPropertyNames(shared.Engine.prototype), Object.getOwnPropertyNames(original.Engine.prototype));
});
