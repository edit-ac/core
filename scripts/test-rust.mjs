import { spawnSync } from 'node:child_process';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { resolve, join } from 'node:path';
import { requireTestNode } from './test-toolchain.mjs';
await requireTestNode();
const output = resolve(process.env.EDITAC_RUST_OUTPUT || '../architecture/evidence/rust-check/current');
await mkdir(output, { recursive: true });
// Rust/Node exchange cases must never use shared historical evidence directories.
const keys = ['BLOCK_COMMAND_EXCHANGE','BLOCK_EXCHANGE','BLOCK_KINDS_EXCHANGE','CONFLICTS_OUTPUT','DELETE_EDIT_OUTPUT','EDITOR_EXCHANGE','EXTENSION_ENTRY_OUTPUT','FORMAT_BLOCK_EXCHANGE','FORMAT_EXCHANGE','GENERAL_EXCHANGE','HIERARCHY_OUTPUT','HISTORY_EXCHANGE','INTEROP_OUTPUT','LIST_EXCHANGE','MOVE_EXCHANGE','OWNERSHIP_EXCHANGE','REGISTRY_TRACE_OUTPUT','REPLICA_EVIDENCE','RETAINED_EXCHANGE','SCHEMA_INTEROP_OUTPUT','SPLIT_JOIN_EXCHANGE','SPLIT_JOIN_OUTPUT','STABLE_EDITOR_EXCHANGE','STABLE_JOIN_EXCHANGE','STRUCTURAL_EXCHANGE','STRUCTURE_OUTPUT','XML_TRACE_OUTPUT','MATH_FIXTURES','MODULE_REGISTRY_FIXTURES'];
const directories = Object.fromEntries(keys.map(key => ['EDITAC_' + key, join(output, 'fixtures', key.toLowerCase())]));
// Extension cases require explicit owned sinks too; never inherit a prior run's
// output location or fall back to a shared qualification directory.
for (const key of ['EXTENSION_CODECS_OUTPUT', 'EXTENSION_COMMANDS_OUTPUT', 'EXTENSION_CONTRACT_OUTPUT', 'EXTENSION_REFERENCES_OUTPUT', 'PRESENTER_ATOM_EXCHANGE', 'COMPATIBILITY_OUTPUT', 'CONFORMANCE_OUTPUT', 'SERVICE_EVIDENCE', 'ORIGINS_EVIDENCE', 'LIFECYCLE_EVIDENCE', 'NATIVE_STORE_EVIDENCE', 'REVISION_EVIDENCE', 'LOCAL_CHANNEL_EVIDENCE', 'PRIVATE_CACHE_EVIDENCE', 'KEY_EVIDENCE_DIR']) {
  directories['EDITAC_' + key] = join(output, 'fixtures', key.toLowerCase());
}
await Promise.all(Object.values(directories).map(path => mkdir(path, { recursive: true })));
// The native return-leg test consumes a checkpoint produced by the actual public
// JS SDK, rather than copied historical native evidence. Build the SDK first.
const seedInputs = {};
const seedRead = async path => {
  const bytes = await readFile(new URL('../' + path, import.meta.url));
  seedInputs[path] = createHash('sha256').update(bytes).digest('hex');
  return bytes;
};
const metadata = JSON.parse(await seedRead('fixtures/compatibility/v5.json'));
const sdk = await import('../packages/core/dist/index.js');
const runtime = await sdk.init('data:application/wasm;base64,' + (await seedRead('packages/core/dist/wasm/editac_wasm_bg.wasm')).toString('base64'));
const engine = runtime.restoreEngine(metadata.identity, { identity: metadata.identity, initialized: true, writerId: metadata.writerId, bytes: new Uint8Array(await seedRead('fixtures/compatibility/v5.bin')) },
  [{ identity: metadata.identity, bytes: new Uint8Array(await seedRead('fixtures/compatibility/v5-journal.bin')) }]);
try {
  const checkpoint = engine.checkpoint(), destination = directories.EDITAC_COMPATIBILITY_OUTPUT;
  await writeFile(join(destination, 'public-js.bin'), checkpoint.bytes);
  await writeFile(join(destination, 'public-js.json'), JSON.stringify({ identity: checkpoint.identity, initialized: checkpoint.initialized, writerId: checkpoint.writerId }));
  await writeFile(join(destination, 'public-js-visible.json'), JSON.stringify(engine.read().visible));
} finally { engine.dispose(); }
const args = ['test', '--workspace', '--locked', '--offline'];
const result = spawnSync('cargo', args, { env: { ...process.env, ...directories }, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
const log = (result.stdout || '') + (result.stderr || '');
await writeFile(join(output, 'cargo-test.log'), log);
const suites = [...log.matchAll(/test result: (\w+)\. (\d+) passed; (\d+) failed; (\d+) ignored; (\d+) measured; (\d+) filtered out/g)].map(m => ({ status: m[1], passed: +m[2], failed: +m[3], skipped: +m[4], filtered: +m[6] }));
const counts = suites.reduce((a, s) => ({ executed: a.executed + s.passed + s.failed, passed: a.passed + s.passed, failed: a.failed + s.failed, skipped: a.skipped + s.skipped, filtered: a.filtered + s.filtered }), { executed: 0, passed: 0, failed: 0, skipped: 0, filtered: 0 });
const receipt = { command: 'cargo ' + args.join(' '), exit: result.status, error: result.error?.message, seedInputs, directories, suites, counts, log: join(output, 'cargo-test.log') };
await writeFile(join(output, 'receipt.json'), JSON.stringify(receipt, null, 2) + '\n');
console.log(JSON.stringify({ output, exit: receipt.exit, counts, nonemptySuites: suites.filter(s => s.passed + s.failed > 0).length }));
if (result.error || result.status !== 0 || !counts.executed || counts.failed || counts.skipped || counts.filtered) throw new Error(`Rust acceptance incomplete; see ${output}/cargo-test.log`);
