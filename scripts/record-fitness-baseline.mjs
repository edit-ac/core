import { readFile, writeFile } from 'node:fs/promises';
import { resolve, relative, isAbsolute } from 'node:path';
import { fileURLToPath } from 'node:url';
import { digest, validateFitnessProfile, inspectBaseline, verifyPins } from './architecture-budgets.mjs';
import { requireTestNode } from './test-toolchain.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));
await requireTestNode();
const args = process.argv.slice(2);
if (args.length !== 2 || args[0] !== '--directory') throw Error('Expected --directory <retained owning benchmark output>');
const directory = relative(root, resolve(root, args[1]));
if (!directory || directory.startsWith('..') || isAbsolute(directory)) throw Error('Benchmark output must be inside this repository');
const output = resolve(root, directory);
const profileBytes = await readFile(resolve(root, 'benchmarks/profiles/fitness-v1.json'));
const profile = JSON.parse(profileBytes);
validateFitnessProfile(profile, await readFile(resolve(root, 'benchmarks/config.json')), await readFile(resolve(root, '../architecture/specs/verification.md')));
const bytes = await readFile(resolve(output, 'results.json')), result = JSON.parse(bytes);
if (result.profileInputs?.['benchmarks/profiles/fitness-v1.json'] !== digest(profileBytes)) throw Error('Measured profile identity changed');
const observations = inspectBaseline(profile, result);
await verifyPins(root, result.profileInputs); await verifyPins(root, result.sourceInputs);
await verifyPins(output, result.artifactInputs);
await verifyPins(output, Object.fromEntries(result.fixtures.map(f => [`fixtures/${f.name}.json`, f.sha256])));
const path = resolve(root, 'benchmarks/profiles/baseline-evidence.json');
const previous = JSON.parse(await readFile(path));
// Retain independent exact loading receipts. A new baseline cannot upgrade their scope.
const index = { version: 1, directory, resultsHash: digest(bytes), scope: 'Actual baseline diagnostics, no FIT-1.8/full PRF qualification', optionalLoading: previous.optionalLoading };
await writeFile(path, JSON.stringify(index, null, 2) + '\n');
console.log(JSON.stringify({ directory, resultsHash: index.resultsHash, status: observations.status, qualification: observations.qualification, measuredCases: observations.observations.length }));
