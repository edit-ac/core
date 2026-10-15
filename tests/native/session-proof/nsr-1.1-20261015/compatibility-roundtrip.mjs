import assert from 'node:assert/strict';
import {readFileSync, writeFileSync} from 'node:fs';
import {resolve} from 'node:path';
import {pathToFileURL} from 'node:url';
const output=process.env.EDITAC_COMPATIBILITY_OUTPUT;
assert(output);
const sdk=await import(pathToFileURL(resolve('packages/core/dist/index.js')));
const wasm=readFileSync('packages/core/dist/wasm/editac_wasm_bg.wasm');
const runtime=await sdk.init('data:application/wasm;base64,'+wasm.toString('base64'));
const metadata=JSON.parse(readFileSync(resolve(output,'native.json')));
const engine=runtime.restoreEngine(metadata.identity,{...metadata,bytes:new Uint8Array(readFileSync(resolve(output,'native.bin')))});
try {
  const view=engine.read();
  assert.deepEqual(view.visible,JSON.parse(readFileSync(resolve(output,'native-visible.json'))));
  const saved=engine.checkpoint();
  writeFileSync(resolve(output,'public-js.bin'),saved.bytes);
  writeFileSync(resolve(output,'public-js.json'),JSON.stringify({identity:saved.identity,initialized:saved.initialized,writerId:saved.writerId}));
  writeFileSync(resolve(output,'public-js-visible.json'),JSON.stringify(view.visible));
  console.log('Actual public JS SDK native-checkpoint roundtrip: 1 passed; 0 failed; 0 skipped');
} finally {engine.dispose();}
