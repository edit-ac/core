import assert from 'node:assert/strict';
import test from 'node:test';
import { readFile } from 'node:fs/promises';
import init, { Engine } from '../packages/core/dist/wasm/editac_wasm.js';
import { restoreHandle } from '../packages/core/dist/engine.js';

await init({ module_or_path: await readFile(new URL('../packages/core/dist/wasm/editac_wasm_bg.wasm', import.meta.url)) });
const fixture = new URL('../fixtures/compound-fragment-order/', import.meta.url);
const checkpoint = { ...JSON.parse(await readFile(new URL('before-enter.json', fixture))), bytes: new Uint8Array(await readFile(new URL('before-enter.bin', fixture))) };
const restore = checkpoint => restoreHandle((json, bytes) => Engine.restore(json, bytes), checkpoint.identity, checkpoint);
const body = 'prefix alpha 😀literalBISUCLG';
const text = node => node.runs.map(run => run.text).join('');
const commit = (engine, request) => {
  const bytes = engine.checkpoint().bytes;
  const plan = engine.prepare(request);
  assert.deepEqual(engine.checkpoint().bytes, bytes, 'preparation stays isolated');
  try { return engine.commit(plan); } finally { engine.releasePlan(plan); }
};
function splitJoin(engine) {
  const before = engine.read().visible, owner = before[0].id;
  const at = engine.anchor(owner, text(before[0]).length, 'left');
  let result;
  try { result = commit(engine, { kind: 'editor', origin: 'local:compiled-terminal', commands: [{ type: 'split', owner, at }] }); }
  finally { engine.releaseAnchor(at); }
  try {
    const split = engine.read().visible;
    assert.equal(text(split[0]), text(before[0]));
    assert.equal(text(split[1]), '');
    assert.equal(engine.resolve(result.caret).node, split[1].id);
    assert.deepEqual(split.slice(2).map(n => ({ ...n, order: 0 })), before.slice(1).map(n => ({ ...n, order: 0 })));
    commit(engine, { kind: 'editor', origin: 'local:compiled-backspace', commands: [{ type: 'join', first: owner, second: split[1].id }] });
    assert.equal(text(engine.read().visible[0]), text(before[0]));
    assert.deepEqual(engine.read().visible.slice(1), before.slice(1));
  } finally { if (result?.caret) engine.releaseAnchor(result.caret); }
}

test('captured rich fragment lineage survives repeated compiled terminal split/join and peer recovery', () => {
  const engine = restore(checkpoint);
  let peer, recovered;
  try {
    assert.equal(text(engine.read().visible[0]), body);
    for (let i = 0; i < 3; i++) splitJoin(engine);
    peer = restore(engine.checkpoint());
    const at = peer.anchor(peer.read().visible[0].id, 0, 'right');
    try { commit(peer, { kind: 'editor', origin: 'local:compiled-peer', commands: [{ type: 'insert', at, text: 'remote ' }] }); }
    finally { peer.releaseAnchor(at); }
    engine.applyUpdate(peer.encodeUpdate(engine.stateVector()));
    assert.equal(text(engine.read().visible[0]), 'remote ' + body);
    recovered = restore(engine.checkpoint());
    assert.deepEqual(recovered.read().visible, engine.read().visible);
  } finally { recovered?.dispose(); peer?.dispose(); engine.dispose(); }
});
