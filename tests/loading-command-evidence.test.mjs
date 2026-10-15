import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { digest, verifyPins } from '../scripts/architecture-budgets.mjs';
import { inspectLoadings, loadingInputs, summarizeLoading } from '../scripts/loading-evidence.mjs';
import { admitMeasuredConsumer } from '../scripts/consumers-loading.mjs';
import { summarizeCommand } from '../benchmarks/loading-command-attribution.mjs';

test('observer derivative admits current packed closure and all 192 real command windows separately from production sizes', async () => {
  const index = JSON.parse(await readFile('benchmarks/profiles/loading-command-evidence.json'));
  assert.match(index.directory, /^architecture-results\/fit-1\.8-[a-z0-9/-]+$/); assert(!index.directory.includes('..'));
  const bytes = await readFile(`${index.directory}/results.json`), record = JSON.parse(bytes);
  const profileBytes = await readFile('benchmarks/profiles/loading-v1.json'), profile = JSON.parse(profileBytes);
  assert.equal(digest(bytes), index.resultsHash); assert.equal(record.profileHash, digest(profileBytes));
  assert.equal(record.metadata.commandAttribution, 'packed-observer-exports-v1');
  assert.deepEqual(Object.keys(record.sourceInputs).sort(), [...loadingInputs].sort());
  await verifyPins(process.cwd(), record.sourceInputs);
  await verifyPins(resolve(index.directory), record.artifacts);
  assert.equal(inspectLoadings(profile, record).length, 24);
  assert.deepEqual(JSON.parse(await readFile(`${index.directory}/summary.json`)), summarizeLoading(profile, record));
  const production = JSON.parse(await readFile(`${index.directory}/packed/metafile.json`));
  const diagnostic = JSON.parse(await readFile(`${index.directory}/diagnostic/metafile.json`));
  const internal = record.metadata.engineAttribution === 'fitness-preparation-v1';
  const diagnosticInputs = Object.keys(diagnostic.inputs).filter(p => p !== 'observed.mjs').map(p => {
    if (internal && p.includes('/target/fitness-runtime/')) {
      const name = p.split('/').at(-1);
      assert(['editac_runtime.js','editac_wasm.js'].includes(name));
      return `node_modules/@edit-ac/core/dist/wasm/${name}`;
    }
    return p;
  });
  assert.deepEqual(diagnosticInputs.sort(), Object.keys(production.inputs).filter(p => p !== 'task.mjs').sort(), 'packed closure differs only by declared fitness WASM glue');
  const productionWasm = await readFile(`${index.directory}/packed/artifacts/wasm/editac_wasm_bg.wasm`);
  const imports = bytes => WebAssembly.Module.imports(new WebAssembly.Module(bytes)).map(i => i.name).join(' ');
  assert(!imports(productionWasm).includes('editacFitness'), 'Production WASM must have no benchmark callbacks');
  if (internal) {
    for (const name of ['editac_runtime.js','editac_wasm.js','editac_wasm_bg.wasm'])
      assert.equal(digest(await readFile(`target/fitness-runtime/${name}`)), record.artifacts[`diagnostic/${name}`]);
    const observedWasm = await readFile(`${index.directory}/diagnostic/editac_wasm_bg.wasm`);
    assert(imports(observedWasm).includes('editacFitness'), 'Missing compiled internal observer');
    assert.notEqual(digest(observedWasm), digest(productionWasm));
  }
  assert(Object.values(diagnostic.outputs).some(o => ['diagnosticEngine','diagnosticStorage','diagnosticRenderer'].every(e => o.exports.includes(e))));
  assert.notEqual(record.artifacts['diagnostic/task.js'], record.artifacts['packed/artifacts/task.js']);
  assert.deepEqual(record.consumer, await admitMeasuredConsumer(resolve(index.directory, 'packed')));
  for (const [path, hash] of Object.entries(record.consumer.inputHashes)) if (path !== 'task.mjs') assert.equal(digest(await readFile(path.replace('node_modules/@edit-ac/', 'packages/'))), hash);
  let windows = 0;
  for (const item of record.cases) {
    assert.equal(digest(JSON.stringify(item)), record.artifacts[`raw/${item.fixture}-${item.preset}.json`]);
    for (const pair of item.pairs) for (const mode of ['cold','warm']) for (const command of pair[mode].commands) {
      const summary = summarizeCommand(command.trace);
      assert(Math.abs(Object.values(summary.exclusiveMs).reduce((a,b) => a+b) - summary.elapsedMs) < 1e-6);
      windows++;
    }
  }
  assert.equal(windows, 192);
});
