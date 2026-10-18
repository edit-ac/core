import assert from 'node:assert/strict';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { chromium, firefox, webkit } from 'playwright';
import { requireTestNode } from '../../scripts/test-toolchain.mjs';
import { prepareProductSite } from '../../examples/task-editor/product.mjs';
import { loadScenario, root } from './run.mjs';
import { sha } from './harness.mjs';
await requireTestNode();
const id = 'web-product-checkpoint';
const { manifest, scenario } = await loadScenario(id);
const output = resolve(root, '../architecture/evidence/browser-product-workflows-20261018/pwe-1.5', new Date().toISOString().replace(/[:.]/g, '-'));
await mkdir(output, { recursive: true });
const facts = { output, parent: scenario.parent, scenario: id, command: ['node','tests/scenarios/run.mjs',id], commands: [], cases: [], workflows: [], runtimes: [], scope: manifest.scope };
try {
  assert.deepEqual(scenario.engines, ['chromium','firefox','webkit']);
  const required = [];
  for (const engine of scenario.engines) for (const workflow of scenario.workflows) {
    const { scenario: child } = await loadScenario(workflow);
    required.push(...child.cases.map(id => engine + ':' + workflow + ':' + id));
  }
  assert.ok(required.length > 0); assert.deepEqual(scenario.cases, required);
  await prepareProductSite(output, facts);
  for (const engine of scenario.engines) {
    const browserType = { chromium, firefox, webkit }[engine];
    facts.runtimes.push({ engine, executable: browserType.executablePath() });
    for (const workflow of scenario.workflows) {
      const childOutput = join(output, engine, workflow); await mkdir(childOutput, { recursive: true });
      // Reuse only successful proofs whose actual scenario inputs and every
      // served artifact/package are byte-identical. Other workflows' runner
      // sources are not dependencies of this child.
      if (process.env.EDITAC_PRODUCT_PRIOR_CHECKPOINT) {
        const priorPath = resolve(process.env.EDITAC_PRODUCT_PRIOR_CHECKPOINT);
        const prior = JSON.parse(await readFile(priorPath));
        const priorWorkflow = prior.workflows.find(item => item.engine === engine && item.workflow === workflow && item.exit === 0);
        if (priorWorkflow) {
          const bytes = await readFile(priorWorkflow.receipt), proof = JSON.parse(bytes);
          assert.equal(sha(bytes), priorWorkflow.sha256, 'Prior workflow receipt changed');
          const { scenario: child } = await loadScenario(workflow);
          const dependencies = [...child.fixtures, ...(child.supportingSources??[]), child.command[1], 'fixtures/product-scenarios/web/manifest.json', 'tests/scenarios/run.mjs', 'tests/scenarios/harness.mjs', 'tests/browser/fixture-server.mjs'];
          const unchanged = dependencies.every(path => proof.sources.some(source => source.path === path && source.sha256 === facts.sources.find(current => current.path === path)?.sha256));
          const sameArtifacts = JSON.stringify(proof.artifacts) === JSON.stringify(facts.artifacts);
          const samePacks = JSON.stringify(proof.packs) === JSON.stringify(facts.packs);
          if (unchanged && sameArtifacts && samePacks && proof.profile.engine === engine && proof.toolchains.node === process.versions.node && proof.exit === 0 && proof.counts.executed === child.cases.length && proof.counts.failed === 0 && proof.counts.skipped === 0 && JSON.stringify(proof.cases.map(c=>c.id)) === JSON.stringify(child.cases)) {
            facts.workflows.push({ ...priorWorkflow, reused: true, scope: 'Exact scenario source/fixture/manifest, package and entire served-site hashes unchanged', priorCheckpoint: priorPath });
            facts.cases.push(...proof.cases.map(c => ({ ...c, id: engine + ':' + workflow + ':' + c.id, reused: true })));
            console.log(JSON.stringify({ engine, workflow, reused: proof.counts.passed, receipt: priorWorkflow.receipt }));
            continue;
          }
        }
      }
      const log = join(childOutput, 'dispatcher.log');
      const result = spawnSync(process.execPath, ['tests/scenarios/run.mjs',workflow], { cwd: root, env: { ...process.env, EDITAC_PRODUCT_SITE_RECEIPT: join(output,'prepared.json'), EDITAC_PRODUCT_BROWSER: engine, EDITAC_PRODUCT_CASE_OUTPUT: childOutput }, encoding: 'utf8', timeout: 180000, maxBuffer: 4 * 1024 * 1024 });
      await writeFile(log, (result.stdout ?? '') + (result.stderr ?? ''));
      const command = { command: ['node','tests/scenarios/run.mjs',workflow], engine, exit: result.status, error: result.error?.message, log };
      facts.commands.push(command);
      try {
        const path = join(childOutput,'receipt.json'), bytes = await readFile(path), receipt = JSON.parse(bytes);
        facts.workflows.push({ engine, workflow, receipt: path, sha256: sha(bytes), counts: receipt.counts, exit: receipt.exit, browserVersion: receipt.browserVersion, teardown: receipt.teardown });
        facts.cases.push(...receipt.cases.map(c => ({ ...c, id: engine + ':' + workflow + ':' + c.id })));
        if (receipt.exit !== 0 || receipt.counts.failed || receipt.counts.skipped || !receipt.counts.executed || result.status !== 0) process.exitCode = 1;
      } catch (error) { facts.workflows.push({ engine, workflow, failure: error.message }); process.exitCode = 1; }
      console.log(JSON.stringify({ engine, workflow, ...facts.workflows.at(-1).counts, exit: result.status, output: childOutput }));
    }
  }
  assert.deepEqual(new Set(facts.cases.map(c => c.id)), new Set(required), 'Required product cases missing');
} catch (error) { facts.failure = error.stack; process.exitCode = 1; }
finally {
  facts.counts = { required: scenario.cases.length, executed: facts.cases.filter(c=>!c.reused).length, passed: facts.cases.filter(c=>c.status==='passed'&&!c.reused).length, reused: facts.cases.filter(c=>c.reused).length, proven: facts.cases.filter(c=>c.status==='passed').length, failed: facts.cases.filter(c=>c.status==='failed').length, skipped: Math.max(0, scenario.cases.length-facts.cases.length) };
  if (facts.counts.failed || facts.counts.skipped || !facts.counts.executed) process.exitCode = 1;
  facts.exit = process.exitCode ?? 0;
  await writeFile(join(output,'receipt.json'),JSON.stringify(facts,null,2));
  console.log(JSON.stringify({ output, counts: facts.counts, exit: facts.exit, failure: facts.failure?.split('\n').slice(0,3) }));
}
