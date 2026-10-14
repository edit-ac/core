import assert from 'node:assert/strict';
import { test, before, after } from 'node:test';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { loadSuite } from './fixture-loader.ts';
import { SemanticDriver, semanticProfile } from './semantic-adapter.ts';
import { packedRuntime, sha256 } from './packed-runtime.mjs';
import { variantStorage } from './variant-storage-harness.mjs';
import { atomicVectors, storageVectorIds, atomicInitial, atomicProbe, runAtomicVector } from './atomic-vector-oracle.mjs';

export function registerAtomicVectorTests({ withStorage = false, vectorIds = storageVectorIds, child = 'RGS-1.2-C20', artifact = `atomic-vector${withStorage ? '-storage' : ''}`, suiteFile = `tests/editing/atomic-vector${withStorage ? '-storage' : ''}.test.mjs` } = {}) {
  const output = process.env.EDITAC_EDITING_OUTPUT;
  const facts = {
    child, parent: 'RGS-1.2',
    layer: withStorage ? 'real packed-WASM + production LocalStorageLifecycle/StorageWriter/UpdateJournal + prepared IndexedDB' : 'real packed-WASM semantic atomic vectors',
    profile: { ...semanticProfile, clock: 'fixed driver clock 0; isolated default history groups', persistence: withStorage ? 'actual enqueue/completion; prepared IndexedDB delivery' : 'unattached' },
    fixtureHashes: loadSuite().hashes, cases: [], negativeControls: [],
    selectedVectorIds: vectorIds,
    exclusions: ['Invalid vectors use a separate live observer probe; not a valid policy retry', 'History selection remains C3', 'No native persistence/browser/gesture/device/deployment evidence'],
  };
  let pack, runtime;
  before(async () => {
    assert.ok(output, 'EDITAC_EDITING_OUTPUT must identify a fresh evidence directory');
    assert.ok(vectorIds.length > 0 && new Set(vectorIds).size === vectorIds.length, 'nonzero unique vector selection');
    for (const id of vectorIds) assert.equal(atomicVectors.filter(v => v.id === id).length, 1, `exact original vector ${id}`);
    pack = await packedRuntime(process.env.EDITAC_EDITING_PACK_TARBALL); runtime = pack.runtime;
    pack.facts.process.launcher = `node --test ${suiteFile}`;
  });
  after(async () => {
    if (pack) { await pack.close(); facts.runtime = pack.facts; }
    facts.sourceHashes = {};
    for (const path of ['tests/editing/atomic-vector-oracle.mjs', 'tests/editing/atomic-vector-harness.mjs', 'tests/editing/atomic-vector.test.mjs', 'tests/editing/atomic-vector-storage.test.mjs', 'tests/editing/remaining-atomic-vector-storage.test.mjs', 'tests/editing/variant-storage-harness.mjs', 'tests/editing/storage-harness.mjs', 'tests/editing/replica-state.mjs', 'tests/helpers/journal-storage.mjs', ...['index', 'writer', 'journal', 'transaction'].flatMap(n => [`packages/web/src/storage/${n}.ts`, `packages/web/dist/storage/${n}.js`]), 'scripts/editing-suites.mjs', 'scripts/test-editing.mjs', 'tests/editing/dispatcher.test.mjs', 'tests/editing/semantic.test.mjs', 'tests/editing/semantic-adapter.ts', 'tests/editing/driver.ts', 'tests/editing/fixture-loader.ts', 'tests/editing/packed-runtime.mjs', 'crates/editac-core/tests/editing_regressions.rs', 'fixtures/editing-failures/semantic-vectors.json', 'Cargo.lock']) facts.sourceHashes[path] = sha256(await readFile(path));
    facts.counts = { executed: facts.cases.length, passed: facts.cases.filter(c => c.status === 'passed').length, failed: facts.cases.filter(c => c.status === 'failed').length, skipped: 0 };
    await mkdir(output, { recursive: true });
    await writeFile(join(output, `${artifact}-harness.json`), JSON.stringify(facts, null, 2) + '\n');
  });
  for (const v of atomicVectors.filter(v => vectorIds.includes(v.id))) test(`native/WASM:${v.id}${withStorage ? '/storage' : ''}`, { timeout: 20000 }, async () => {
    const fact = { id: v.id, status: 'running', checkpoints: 0, controls: 0 }; facts.cases.push(fact);
    let d, storage;
    try {
      const initial = atomicInitial(v);
      storage = withStorage ? await variantStorage(runtime, initial, fact, facts) : undefined;
      d = storage?.driver ?? new SemanticDriver(runtime, initial);
      runAtomicVector(d, v, fact, facts);
      if (storage) {
        await storage.verifyStep('original-vector', v.rejected ? 0 : 1);
        if (v.rejected) {
          fact.separateLiveProbe = atomicProbe(v).id;
          runAtomicVector(d, atomicProbe(v), fact, facts);
          await storage.verifyStep('separate-live-observer-probe', 1);
        }
        assert.equal(storage.commitCalls, 1);
        fact.storageEffects = storage.effects(); fact.preparedCommits = storage.commitCalls;
      }
      fact.status = 'passed';
    } catch (error) { fact.status = 'failed'; fact.error = error.message; throw error; }
    finally {
      if (storage) { fact.teardown = await storage.close(); if (fact.status === 'passed') assert.equal(fact.teardown.unsaved, false); }
      else d?.dispose();
    }
  });
}
