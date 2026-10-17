import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync, statSync } from 'node:fs';
import { resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { performance } from 'node:perf_hooks';

test('actual guarded DOCX structure mapper compiles on WASM with optional jobs', () => {
  const output = resolve(process.env.EDITAC_FORMATS_OUTPUT);
  const args = ['build', '--manifest-path', 'crates/editac-formats/Cargo.toml', '--locked', '--offline', '--features', 'docx-codecs,jobs', '--example', 'docx_import_structure', '--target', 'wasm32-unknown-unknown'];
  const start = performance.now();
  const result = spawnSync('cargo', args, { encoding: 'utf8', timeout: 180000, maxBuffer: 32 * 1024 * 1024 });
  writeFileSync(resolve(output, 'docx-structure-wasm.log'), (result.stdout ?? '') + (result.stderr ?? ''));
  writeFileSync(resolve(output, 'docx-structure-wasm-command.json'), JSON.stringify({ program:'cargo',args,exit:result.status,signal:result.signal,durationMs:performance.now()-start,claim:'compile only; no browser runtime or sandbox qualification' },null,2)+'\n');
  assert.ifError(result.error);assert.equal(result.status,0,'see docx-structure-wasm.log');
  const artifact = resolve(process.env.CARGO_TARGET_DIR ?? 'crates/editac-formats/target', 'wasm32-unknown-unknown/debug/examples/docx_import_structure.wasm');
  assert.ok(statSync(artifact).size>8);assert.deepEqual([...readFileSync(artifact).subarray(0,4)],[0,97,115,109]);
});
