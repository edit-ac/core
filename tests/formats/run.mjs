import { readFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { performance } from 'node:perf_hooks';

export function counts(kind, output) {
  if (kind === 'rust-test') {
    const rows = [...output.matchAll(/test result: (?:ok|FAILED)\. (\d+) passed; (\d+) failed; (\d+) ignored; (\d+) measured; (\d+) filtered out/g)];
    if (!rows.length) throw Error('missing Rust test summary');
    return rows.reduce((r, m) => ({ passed: r.passed + +m[1], failed: r.failed + +m[2], skipped: r.skipped + +m[3] + +m[4] }), { passed: 0, failed: 0, skipped: 0 });
  }
  if (kind === 'node-test') {
    const get = key => {
      const match = output.match(new RegExp(`^# ${key} (\\d+)$`, 'm'));
      if (!match) throw Error(`missing Node ${key} summary`);
      return +match[1];
    };
    const r = { passed: get('pass'), failed: get('fail'), skipped: get('skipped') + get('cancelled') + get('todo') };
    if (get('tests') !== r.passed + r.failed + r.skipped) throw Error('inconsistent Node test counts');
    return r;
  }
  throw Error(`unknown check kind: ${kind}`);
}

export function execute(command, cwd, log) {
  if (!command || !['rust-test', 'node-test'].includes(command.kind)
      || !Array.isArray(command.args) || !command.args.every(x => typeof x === 'string')
      || !['cargo', 'node'].includes(command.program)) throw Error('invalid locked command');
  const start = performance.now();
  // A dispatcher can itself run under node:test. Its internal IPC reporter
  // context must not leak into a separately launched named test process.
  const env = { ...process.env };
  delete env.NODE_TEST_CONTEXT;
  const result = spawnSync(command.program === 'node' ? process.execPath : command.program, command.args,
    { cwd, env, encoding: 'utf8', maxBuffer: 32 * 1024 * 1024, timeout: 180000 });
  const output = (result.stdout ?? '') + (result.stderr ?? '');
  writeFileSync(log, output);
  const receipt = { ...command, exit: result.status, signal: result.signal, durationMs: performance.now() - start, log };
  if (result.error) throw Object.assign(Error(`command unavailable/failed: ${result.error.message}`), { receipt });
  let summary;
  try { summary = counts(command.kind, output); }
  catch (error) { throw Object.assign(error, { receipt }); }
  receipt.counts = { ...summary, executed: summary.passed + summary.failed };
  if (result.status !== 0 || summary.failed || summary.skipped || summary.passed === 0)
    throw Object.assign(Error('suite failed, skipped, or executed zero cases'), { receipt });
  return receipt;
}

export function select(manifest, scenario) {
  if (manifest.schemaVersion !== 1 || !Object.hasOwn(manifest.scenarios, scenario)
      || !manifest.scenarios[scenario]?.commands?.length) throw Error(`unknown or absent suite: ${scenario}`);
  return manifest.scenarios[scenario];
}

export function main() {
  const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
  const manifestPath = resolve(root, 'tests/formats/capabilities.json');
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
  const [scenario, ...extra] = process.argv.slice(2);
  if (extra.length) throw Error('expected one named suite');
  const suite = select(manifest, scenario);
  if (process.version !== manifest.toolchains.node) throw Error(`requires Node ${manifest.toolchains.node}`);
  const rust = spawnSync('rustc', ['--version'], { encoding: 'utf8' });
  if (rust.status !== 0 || !rust.stdout.startsWith(`rustc ${manifest.toolchains.rust} `)) throw Error('wrong or absent locked Rust toolchain');
  const output = resolve(process.env.EDITAC_FORMATS_OUTPUT ?? resolve(root, '.artifacts/formats', scenario));
  mkdirSync(output, { recursive: true });
  const checks = [];
  let error;
  try {
    for (const [i, command] of suite.commands.entries()) checks.push(execute(command, root, resolve(output, `${i}-${command.kind}.log`)));
  } catch (e) { error = e; if (e.receipt) checks.push(e.receipt); }
  const hashes = {};
  for (const path of ['tests/formats/capabilities.json', 'fixtures/formats/profiles.json', 'fixtures/formats/wcf05.json', 'fixtures/formats/jobs/wcf03.json', 'crates/editac-formats/Cargo.lock', 'crates/editac-formats/Cargo.toml', 'crates/editac-formats/src/job.rs', 'crates/editac-formats/tests/jobs.rs', ...(suite.inputs ?? [])])
    hashes[path] = createHash('sha256').update(readFileSync(resolve(root, path))).digest('hex');
  const receipt = { schemaVersion: 1, scenario, gate: suite.gate, boundary: scenario === 'pdf-export' ? 'partial-captured-job-bounded-text-rich-tables-authorized-original-png-independent-generated-artifact-oracles' : scenario === 'pdf-dependencies' ? 'optional-krilla-native-sandbox-pinned-fonts-and-wasm-compile-only' : scenario === 'docx-export' ? 'captured-shared-fragments-authorized-original-media-independent-package-and-macos-reader' : scenario === 'docx-import-structure' ? 'guarded-docx-structure-real-session-original-media-and-wasm-compile' : scenario === 'docx-import-text' ? 'guarded-docx-text-real-session-and-wasm-compile' : scenario === 'container-limits' ? 'guarded-opc-xml-png-real-session-staging-native-and-wasm-compile' : scenario === 'docx-dependencies' ? 'trusted-docx-candidate-native-and-wasm-compile' : scenario === 'jobs' ? 'real-session-asset-work-prepared-host-ports' : 'rust-local-boundary',
    state: error ? 'failed' : 'passed', checks, hashes, error: error?.message ?? null,
    claims: scenario === 'pdf-export' ? 'CNV-1.9 text, rich, bounded v1 table and authorized original PNG prerequisites only. Actual native Session with prepared execution ports and WASM compile. V2/merged tables, broader images, heterogeneous Arabic styles, document-process isolation and full WCF-13/14 qualification remain open; no aggregate PDF, PDF import, PDF/UA or release claim.' : scenario === 'pdf-dependencies' ? 'Candidate-only fixed-line/two-page native macOS probe, pinned approved font bytes, explicit tags and ActualText, denied ambient file/network/child authority, CPU/output/deadline and sampled RSS watchdog. WASM compile only. No production PDF mapping, PDF import, general pagination, PDF/UA, browser/native wiring or release claim.' : scenario === 'docx-export' ? 'Optional fixed-revision semantic DOCX subset, native Session and prepared asset/execution ports; independent ZIP/XML and macOS textutil reader fixtures. WASM compile only. No aggregate direction, source layout/package identity, broad viewer/platform sandbox or release claim.' : scenario === 'docx-import-structure' ? 'Optional guarded DOCX direct-list, simple-table and paragraph-isolated original-PNG subset with native Session commit and prepared media transport. WASM compile only; no aggregate direction, inline transfer, platform sandbox, viewer or release claim.' : scenario === 'docx-import-text' ? 'Optional guarded DOCX text subset mapping and native Session commit; prepared execution/asset ports. WASM compile only. No aggregate DOCX direction, platform isolation/wiring, viewer or release qualification.' : 'Local contract/candidate probes only; no production conversion, platform wiring, provider or release qualification.' };
  writeFileSync(resolve(output, 'receipt.json'), JSON.stringify(receipt, null, 2) + '\n');
  console.log(JSON.stringify(receipt));
  if (error) process.exitCode = 1;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try { main(); } catch (error) { console.error(error.message); process.exitCode = 1; }
}
