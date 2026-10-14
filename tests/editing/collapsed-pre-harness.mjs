import assert from 'node:assert/strict';
import { test, before, after } from 'node:test';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { loadSuite } from './fixture-loader.ts';
import { SemanticDriver, semanticProfile } from './semantic-adapter.ts';
import { packedRuntime, sha256 } from './packed-runtime.mjs';
import { variantStorage } from './variant-storage-harness.mjs';
import { collapsedPreCases, collapsedPreInitial, pasteCollapsedPre, undoCollapsedPre } from './collapsed-pre-oracle.mjs';

export function registerCollapsedPreTests({ withStorage = false } = {}) {
  const output = process.env.EDITAC_EDITING_OUTPUT;
  const facts = {
    child: 'RGS-1.2-C19', parent: 'RGS-1.2',
    layer: withStorage ? 'real packed-WASM + production LocalStorageLifecycle/StorageWriter/UpdateJournal + prepared IndexedDB' : 'real packed-WASM semantic collapsed pre',
    profile: { ...semanticProfile, clock: 'fixed driver clock 0; isolated default history groups', persistence: withStorage ? 'actual enqueue/completion; prepared IndexedDB delivery' : 'unattached' },
    fixtureHashes: loadSuite().hashes, cases: [], negativeControls: [],
    exclusions: ['Content undo only; history selection remains C3', 'Cross-owner paste remains C2', 'No native persistence/browser/gesture/device/deployment evidence'],
  };
  let pack, runtime;
  before(async () => {
    assert.ok(output, 'EDITAC_EDITING_OUTPUT must identify a fresh evidence directory');
    pack = await packedRuntime(process.env.EDITAC_EDITING_PACK_TARBALL); runtime = pack.runtime;
    pack.facts.process.launcher = `node --test tests/editing/collapsed-pre${withStorage ? '-storage' : ''}.test.mjs`;
  });
  after(async () => {
    if (pack) { await pack.close(); facts.runtime = pack.facts; }
    facts.sourceHashes = {};
    for (const path of ['tests/editing/collapsed-pre-oracle.mjs', 'tests/editing/collapsed-pre-harness.mjs', 'tests/editing/collapsed-pre.test.mjs', 'tests/editing/collapsed-pre-storage.test.mjs', 'tests/editing/variant-storage-harness.mjs', 'tests/editing/storage-harness.mjs', 'tests/editing/replica-state.mjs', 'tests/helpers/journal-storage.mjs', ...['index', 'writer', 'journal', 'transaction'].flatMap(n => [`packages/web/src/storage/${n}.ts`, `packages/web/dist/storage/${n}.js`]), 'scripts/editing-suites.mjs', 'scripts/test-editing.mjs', 'tests/editing/dispatcher.test.mjs', 'tests/editing/semantic.test.mjs', 'tests/editing/semantic-adapter.ts', 'tests/editing/driver.ts', 'tests/editing/fixture-loader.ts', 'tests/editing/packed-runtime.mjs', 'crates/editac-core/tests/editing_regressions.rs', 'Cargo.lock']) facts.sourceHashes[path] = sha256(await readFile(path));
    facts.counts = { executed: facts.cases.length, passed: facts.cases.filter(c => c.status === 'passed').length, failed: facts.cases.filter(c => c.status === 'failed').length, skipped: 0 };
    await mkdir(output, { recursive: true });
    await writeFile(join(output, `collapsed-pre${withStorage ? '-storage' : ''}-harness.json`), JSON.stringify(facts, null, 2) + '\n');
  });
  for (const v of collapsedPreCases) test(`REG-07 collapsed-${v.id}/pre-content-undo${withStorage ? '/storage' : ''}`, { timeout: 20000 }, async () => {
    const fact = { id: v.id, status: 'running', checkpoints: 0, controls: 0 }; facts.cases.push(fact);
    let d, storage, subscription;
    try {
      const initial = collapsedPreInitial(v);
      storage = withStorage ? await variantStorage(runtime, initial, fact, facts) : undefined;
      d = storage?.driver ?? new SemanticDriver(runtime, initial);
      const operations = [];
      subscription = d.engine.subscribe({ type: 'updates' }, p => operations.push(p.operation));
      const paste = pasteCollapsedPre(d, v, fact, facts);
      assert.deepEqual(operations, ['Editor']); fact.checkpoints++;
      if (storage) await storage.verifyStep('paste', 1, 'Editor');
      undoCollapsedPre(d, v, fact, facts, paste);
      assert.deepEqual(operations, ['Editor', 'Undo']); fact.checkpoints++;
      if (storage) {
        await storage.verifyStep('content-undo', 1, 'Undo');
        assert.equal(storage.commitCalls, 1);
        assert.equal(fact.storageSteps.length, 2);
        fact.storageEffects = storage.effects(); fact.preparedCommits = storage.commitCalls;
      }
      fact.operations = operations; fact.status = 'passed';
    } catch (error) { fact.status = 'failed'; fact.error = error.message; throw error; }
    finally {
      subscription?.dispose();
      if (storage) { fact.teardown = await storage.close(); if (fact.status === 'passed') assert.equal(fact.teardown.unsaved, false); }
      else d?.dispose();
    }
  });
}
