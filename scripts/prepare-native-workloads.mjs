import { fixture, expectedSemantics, projectedSemantics } from '../benchmarks/fixtures.mjs';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import assert from 'node:assert/strict';
const [directory, executable] = process.argv.slice(2);
assert(directory && executable);
await mkdir(directory, { recursive: true });
for (const name of ['Task', 'Long']) {
  const document = fixture(name), base = resolve(directory, name);
  await writeFile(base + '.json', JSON.stringify(document));
  const child = spawnSync(executable, [base + '.json', base + '.native-checkpoint.json', base + '.native-snapshot.json'], { encoding: 'utf8', timeout: 600000 });
  await writeFile(base + '.producer.log', child.stdout + child.stderr);
  assert.equal(child.status, 0, `${name} seed producer failed: ${child.stderr}`);
  assert.deepEqual(projectedSemantics(JSON.parse(await readFile(base + '.native-snapshot.json'))), expectedSemantics(document));
  console.log(`${name}: independent full semantic oracle passed (${document.blocks.length} blocks)`);
}
