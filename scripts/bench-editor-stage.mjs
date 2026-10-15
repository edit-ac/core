// Diagnostic sub-boundary of FIT-1.8: packed public FFI preparation/commit.
// No browser navigation/input-to-visible budget or native SDK claim.
import assert from 'node:assert/strict';
import { readFile, writeFile, mkdir, mkdtemp, rm } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { createServer } from 'node:http';
import { createHash } from 'node:crypto';
import { tmpdir, cpus, totalmem, platform, arch, release } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { requireTestNode } from './test-toolchain.mjs';
import { projectedSemantics, expectedSemantics, fixture, supportedFixtures } from '../benchmarks/fixtures.mjs';
await requireTestNode();
const args = process.argv.slice(2);
assert(args.length === 6 && args[0] === '--pack' && args[2] === '--seeds' && args[4] === '--output', 'Expected --pack <tarball> --seeds <owning directory> --output <unique directory>');
const pack = resolve(args[1]), seeds = resolve(args[3]), output = resolve(args[5]);
await mkdir(output); // Never overwrite historical or failed evidence.
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const semanticHash = engine => hash(JSON.stringify(projectedSemantics(engine.read())));
const record = { version: 1, scope: 'prepared fixed-corpus packed public FFI stage costs only; no navigation, render, tail, native or release qualification',
  command: [process.execPath, ...process.argv.slice(1)], revision: spawnSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).stdout.trim(),
  runtime: { node: process.version, cpu: cpus()[0].model, memoryBytes: totalmem(), hostOS: `${platform()}/${release()}/${arch()}` },
  features: ['engine', 'editor-v5', 'prepared-offset-text', 'stable-selection'],
  timingScope: 'public prepare and commit only, fresh restored engine per sample, one runtime per process, no discarded warmup, assertions excluded;12 samples cannot qualify tails',
  samplesPerFixture: 12, counts: { executed: 0, passed: 0, failed: 0, skipped: 24 }, artifacts: {}, cases: [], errors: [], cleanup: {} };
let temporary, server;
const retain = async (path, bytes) => { await writeFile(join(output, path), bytes); record.artifacts[path] = hash(bytes); };
try {
  const bytes = await readFile(pack); await retain('core.tgz', bytes);
  await retain('harness.mjs', await readFile(new URL(import.meta.url)));
  await retain('fixtures.mjs', await readFile(new URL('../benchmarks/fixtures.mjs', import.meta.url)));
  const seedBytes = await readFile(join(seeds, 'results.json')), seedRecord = JSON.parse(seedBytes);
  await retain('seed-results.json', seedBytes);
  temporary = await mkdtemp(join(tmpdir(), 'editac-stage-cost-'));
  const unpack = spawnSync('tar', ['-xzf', join(output, 'core.tgz'), '-C', temporary], { encoding: 'utf8' }); assert.equal(unpack.status, 0, unpack.stderr);
  const wasm = await readFile(join(temporary, 'package/dist/wasm/editac_wasm_bg.wasm')); record.wasmHash = hash(wasm);
  server = createServer((request, response) => { if (request.url !== '/engine.wasm') { response.writeHead(404); response.end(); return; } response.setHeader('Content-Type', 'application/wasm'); response.end(wasm); });
  await new Promise((yes, no) => { server.once('error', no); server.listen(0, '127.0.0.1', yes); });
  record.process = { pid: process.pid, port: server.address().port, workspace: process.cwd(), purpose: 'packed stage-cost fixture' };
  const { init } = await import(pathToFileURL(join(temporary, 'package/dist/index.js')));
  const runtime = await init(`http://127.0.0.1:${server.address().port}/engine.wasm`);
  for (const name of ['Task', 'Long']) {
    const bytes = await readFile(join(seeds, 'fixtures', `${name}.checkpoint.json`));
    assert.equal(hash(bytes), seedRecord.artifacts[`fixtures/${name}.checkpoint.json`]); await retain(`${name}.checkpoint.json`, bytes);
    const frozen = JSON.parse(bytes), expected = hash(JSON.stringify(expectedSemantics(fixture(name))));
    const item = { fixture: name, textBytes: supportedFixtures[name].textBytes, blocks: supportedFixtures[name].blocks, fixtureHash: expected, checkpointHash: hash(bytes), samples: [] }; record.cases.push(item);
    for (let index = 0; index < record.samplesPerFixture; index++) {
      let engine; const sample = { index }; item.samples.push(sample); record.counts.executed++; record.counts.skipped--;
      try {
        engine = runtime.restoreEngine(frozen.identity, { ...frozen.checkpoint, bytes: new Uint8Array(frozen.checkpoint.bytes) });
        assert.equal(semanticHash(engine), expected);
        const node = engine.read().visible.find(n => n.kind === 'block' && n.runs?.length && /[A-Za-z]/.test(n.runs[0].text)); assert(node);
        const text = node.runs.map(r => r.text).join(''), offset = text.search(/[A-Za-z]/), alternate = text[offset] === 'z' ? 'q' : 'z';
        for (const [mode, value] of [['edit', alternate], ['restore', text[offset]]]) {
          const request = { kind: 'editor', origin: 'stage-cost', commands: [
            { type: 'replaceAt', owner: node.id, from: offset, to: offset + 1, text: value },
            { type: 'selectionAt', anchor: { owner: node.id, offset: offset + 1, bias: 'left' }, focus: { owner: node.id, offset, bias: 'right' } },
          ] };
          const start = performance.now(), plan = engine.prepare(request), prepared = performance.now(), result = engine.commit(plan), committed = performance.now();
          sample[mode] = { prepareMs: prepared - start, commitMs: committed - prepared, totalMs: committed - start };
          try {
            assert.equal(engine.read().visible.find(n => n.id === node.id).runs.map(r => r.text).join(''), text.slice(0, offset) + value + text.slice(offset + 1));
            for (const [token, at, bias] of [[result.selection.anchor, offset + 1, 'left'], [result.selection.focus, offset, 'right']]) {
              const p = engine.resolve(token); assert.equal(p.type, 'position'); assert.equal(p.node, node.id); assert.equal(p.offset, at); assert.equal(p.bias, bias);
            }
          } finally { if (result.selection) { engine.releaseAnchor(result.selection.anchor); engine.releaseAnchor(result.selection.focus); } if (result.caret) engine.releaseAnchor(result.caret); }
        }
        const final = semanticHash(engine); assert.equal(final, expected);
        const reopened = runtime.restoreEngine(frozen.identity, engine.checkpoint());
        try { assert.equal(semanticHash(reopened), expected); } finally { reopened.dispose(); }
        sample.finalHash = final; sample.reopened = true; sample.status = 'passed'; record.counts.passed++;
      } catch (error) { sample.status = 'failed'; sample.error = String(error.stack); record.counts.failed++; }
      finally { engine?.dispose(); }
    }
  }
} catch (error) { record.errors.push(String(error.stack)); }
finally {
  if (server) { server.closeAllConnections(); await new Promise(yes => server.close(yes)); record.cleanup.serverClosed = !server.listening; }
  if (temporary) { await rm(temporary, { recursive: true, force: true }); record.cleanup.temporaryRemoved = true; }
  const failed = record.errors.length || record.counts.failed || record.counts.skipped || record.counts.passed !== 24;
  record.exit = failed ? 1 : 0; await writeFile(join(output, 'results.json'), JSON.stringify(record, null, 2));
  console.log(JSON.stringify({ exit: record.exit, counts: record.counts, cleanup: record.cleanup })); process.exitCode = record.exit;
}
