import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { digest, verifyPins } from './architecture-budgets.mjs';
import { restorePinnedEvidence } from './restore-pinned-evidence.mjs';
import { requireTestNode } from './test-toolchain.mjs';

// Explicit read-only source worktrees. Never search for a merely similar result,
// repin a receipt, or reconstruct missing measurement evidence.
await requireTestNode();
const args = process.argv.slice(2);
if (args.length !== 4 || args[0] !== '--baseline-core' || args[2] !== '--loading-core') throw Error('Expected --baseline-core <retained core> --loading-core <retained core>');
const root = fileURLToPath(new URL('../', import.meta.url));
const bytes = await readFile(resolve(root, 'benchmarks/profiles/baseline-evidence.json'));
const index = JSON.parse(bytes);
for (const directory of [index.directory, index.optionalLoading.directory]) {
  if (!/^architecture-results\/[a-z0-9/.-]+$/.test(directory) || directory.split('/').includes('..')) throw Error('Invalid retained evidence directory');
}
const loadingSource = resolve(args[3], index.optionalLoading.directory);
await verifyPins(loadingSource, index.optionalLoading.pins);
const inventory = JSON.parse(await readFile(resolve(loadingSource, 'consumers-loading-inventory.json')));
// The authenticated inventory contains historical artifact identities. The full
// canonical checks still enforce current source applicability separately.
const pins = { ...inventory.artifacts, ...index.optionalLoading.pins };
await verifyPins(loadingSource, pins);
const baseline = await restorePinnedEvidence(resolve(args[1], index.directory), resolve(root, index.directory), { 'results.json': index.resultsHash });
const optionalLoading = await restorePinnedEvidence(loadingSource, resolve(root, index.optionalLoading.directory), pins);
console.log(JSON.stringify({ command: [process.execPath, ...process.argv.slice(1)], indexHash: digest(bytes), baseline, optionalLoading, qualification: 'Restored historical bytes only; current source/platform applicability is not established' }, null, 2));
