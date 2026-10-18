import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { counts, execute, select } from './run.mjs';

test('unknown and absent suites fail instead of falling through', () => {
  const manifest = JSON.parse(readFileSync(new URL('./capabilities.json', import.meta.url)));
  assert.equal(select(manifest, 'profiles').gate, 'CNV-1.1');
  assert.equal(select(manifest, 'jobs').gate, 'CNV-1.2');
  assert.equal(select(manifest, 'rtf-import').gate, 'CNV-1.12');
  assert.equal(select(manifest, 'rtf-export').gate, 'CNV-1.13');
  assert.equal(select(manifest, 'epub-export').gate, 'CNV-1.15');
  assert.equal(select(manifest, 'consumers').gate, 'CNV-1.18');
  for (const name of ['consumers-epub-export','consumers-epub-export-repair','consumers-epub-export-contract-repair']) assert.equal(select(manifest,name).gate,'CNV-1.18-C2-EX');
  assert.equal(select(manifest, 'table-text-import').gate, 'CNV-1.16');
  assert.equal(select(manifest, 'docx-dependencies').gate, 'CNV-1.3');
  assert.equal(select(manifest, 'container-limits').gate, 'CNV-1.4');
  assert.equal(select(manifest, 'docx-import-text').gate, 'CNV-1.5');
  assert.equal(select(manifest, 'pdf-dependencies').gate, 'CNV-1.8');
  for (const suite of ['no-such-suite', '__proto__']) assert.throws(() => select(manifest, suite), /unknown or absent/);
  assert.throws(() => select({ schemaVersion: 1, scenarios: { empty: { commands: [] } } }, 'empty'));
});

test('summaries preserve failures/skips and reject missing or inconsistent reports', () => {
  assert.deepEqual(counts('rust-test', 'test result: ok. 3 passed; 0 failed; 1 ignored; 0 measured; 0 filtered out'), { passed: 3, failed: 0, skipped: 1 });
  assert.deepEqual(counts('rust-test', 'test result: FAILED. 1 passed; 2 failed; 0 ignored; 0 measured; 0 filtered out'), { passed: 1, failed: 2, skipped: 0 });
  assert.throws(() => counts('rust-test', 'success'));
  assert.throws(() => counts('other', 'success'));
  assert.throws(() => counts('node-test', '# tests 1\n# pass 0\n# fail 0\n# skipped 0\n# cancelled 0\n# todo 0\n'));
});

test('real zero-matching Rust suite is a failure with durable counts', () => {
  const output = mkdtempSync(join(tmpdir(), 'editac-formats-zero-'));
  try {
    assert.throws(() => execute({ program: 'cargo', args: ['test', '--manifest-path', 'crates/editac-formats/Cargo.toml', '--locked', '--offline', '--test', 'profiles', '--', '--exact', 'no_such_case'], kind: 'rust-test' }, process.cwd(), join(output, 'zero.log')),
      error => error.receipt.exit === 0 && error.receipt.counts.executed === 0 && /zero cases/.test(error.message));
  } finally { rmSync(output, { recursive: true }); }
});

test('absent named test and unavailable binary cannot qualify', () => {
  const output = mkdtempSync(join(tmpdir(), 'editac-formats-absent-'));
  try {
    assert.throws(() => execute({ program: 'node', args: ['--test', 'tests/formats/does-not-exist.mjs'], kind: 'node-test' }, process.cwd(), join(output, 'absent.log')));
    const previous = process.env.PATH;
    try {
      process.env.PATH = output;
      assert.throws(() => execute({ program: 'cargo', args: ['test'], kind: 'rust-test' }, process.cwd(), join(output, 'binary.log')), /unavailable/);
    } finally { process.env.PATH = previous; }
  } finally { rmSync(output, { recursive: true }); }
});

test('real skipped and failed Node checks cannot qualify', () => {
  const output = mkdtempSync(join(tmpdir(), 'editac-formats-failure-'));
  try {
    for (const [name, body, key] of [
      ['skip', "test('prepared skip', { skip: true }, () => {});", 'skipped'],
      ['fail', "test('prepared failure', () => { throw Error('expected fixture failure'); });", 'failed'],
    ]) {
      const path = join(output, `${name}.mjs`);
      writeFileSync(path, `import test from 'node:test';\n${body}\n`);
      assert.throws(() => execute({ program: 'node', args: ['--test', '--test-reporter=tap', path], kind: 'node-test' }, process.cwd(), join(output, `${name}.log`)),
        error => error.receipt.counts[key] === 1 && /failed, skipped/.test(error.message));
    }
  } finally { rmSync(output, { recursive: true }); }
});
