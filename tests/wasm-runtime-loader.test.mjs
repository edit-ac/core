import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const artifact = new URL('../packages/core/dist/wasm/editac_wasm.js', import.meta.url);
const bytes = await readFile(new URL('../packages/core/dist/wasm/editac_wasm_bg.wasm', import.meta.url));
let sequence = 0;
const fresh = () => import(`${artifact.href}?loader-case=${++sequence}`);
const response = (type = 'default', mime = 'application/wasm', body = bytes) => {
  const value = new Response(body, { headers: { 'Content-Type': mime } });
  Object.defineProperty(value, 'type', { value: type });
  return value;
};
async function environment(fetch, streaming, run) {
  const priorFetch = globalThis.fetch, descriptor = Object.getOwnPropertyDescriptor(WebAssembly, 'instantiateStreaming');
  globalThis.fetch = fetch;
  Object.defineProperty(WebAssembly, 'instantiateStreaming', { ...descriptor, value: streaming });
  try { return await run(await fresh()); }
  finally { globalThis.fetch = priorFetch; Object.defineProperty(WebAssembly, 'instantiateStreaming', descriptor); }
}
const streaming = WebAssembly.instantiateStreaming;
const document = () => JSON.stringify({ profile: 'v5', documentId: 'a1000000-0000-4000-8000-000000000001', epoch: 'a2000000-0000-4000-8000-000000000001', nodes: [{ text: 'loader 😀' }] });
function readable(bindings) {
  const engine = new bindings.Engine(document());
  try { assert.equal(JSON.parse(engine.read()).visible[0].runs[0].text, 'loader 😀'); }
  finally { engine.free(); }
}

test('streamed SDK initialization and raw async/sync entries share one WASM owner', async () => {
  let fetches = 0;
  await environment(async () => { fetches++; return response(); }, streaming, async bindings => {
    const exports = await bindings.initRuntime('/engine.wasm'); readable(bindings);
    assert.equal(await bindings.default({ module_or_path: '/must-not-fetch' }), exports);
    assert.equal(bindings.initSync({ module: bytes }), exports);
    assert.equal(await bindings.initRuntime('/must-not-fetch'), exports);
    assert.equal(fetches, 1);
  });
});
for (const type of ['basic', 'cors', 'default']) test(`wrong MIME ${type} response retains buffered fallback`, async () => {
  const failure = new TypeError('prepared streaming MIME rejection'); let reads = 0;
  await environment(async () => { const value = response(type, 'application/octet-stream'); const read = value.arrayBuffer.bind(value); value.arrayBuffer = () => { reads++; return read(); }; return value; }, async () => { throw failure; }, async bindings => {
    await bindings.initRuntime('/engine.wasm'); readable(bindings); assert.equal(reads, 1);
  });
});
for (const [type, mime] of [['opaque', 'application/octet-stream'], ['default', 'application/wasm']]) test(`streaming failure for ${type}/${mime} is not hidden by fallback`, async () => {
  const failure = new WebAssembly.CompileError('prepared streaming failure'); let reads = 0;
  await environment(async () => { const value = response(type, mime); value.arrayBuffer = async () => { reads++; return bytes; }; return value; }, async () => { throw failure; }, async bindings => {
    await assert.rejects(bindings.initRuntime('/engine.wasm'), error => error === failure); assert.equal(reads, 0);
  });
});
test('missing streaming support retains compiled buffered initialization', async () => {
  await environment(async () => response(), undefined, async bindings => { await bindings.initRuntime('/engine.wasm'); readable(bindings); });
});
test('HTTP failure preserves its diagnostic and initialization can retry', async () => {
  let fetches = 0;
  await environment(async () => ++fetches === 1 ? new Response('', { status: 503, statusText: 'Prepared unavailable' }) : response(), streaming, async bindings => {
    await assert.rejects(bindings.initRuntime('/engine.wasm'), /failed to fetch Wasm: 503 Prepared unavailable/);
    await bindings.initRuntime('/engine.wasm'); readable(bindings); assert.equal(fetches, 2);
  });
});
test('fetch and malformed bytes reject and retain a successful retry path', async () => {
  const failure = new TypeError('prepared fetch failure'); let fetches = 0;
  await environment(async () => { if (++fetches === 1) throw failure; return response('default', 'application/wasm', fetches === 2 ? new Uint8Array([0]) : bytes); }, undefined, async bindings => {
    await assert.rejects(bindings.initRuntime('/engine.wasm'), error => error === failure);
    await assert.rejects(bindings.initRuntime('/engine.wasm'), WebAssembly.CompileError);
    await bindings.initRuntime('/engine.wasm'); readable(bindings); assert.equal(fetches, 3);
  });
});
test('public async SDK coalesces callers, retries failure and rejects a different URL', async () => {
  const prior = globalThis.fetch; let fetches = 0;
  globalThis.fetch = async () => ++fetches === 1 ? new Response('', { status: 503 }) : response();
  try {
    const { init } = await import(`../packages/core/dist/index.js?public-loader=${++sequence}`);
    const failed = init('/qualified.wasm'); assert.equal(init('/qualified.wasm'), failed);
    await assert.rejects(failed, /503/);
    const retry = init('/qualified.wasm'); assert.equal(init('/qualified.wasm'), retry);
    const runtime = await retry;
    await assert.rejects(init('/other.wasm'), /another asset URL/);
    const engine = runtime.createEngine(JSON.parse(document()));
    try { assert.equal(engine.read().visible[0].runs[0].text, 'loader 😀'); } finally { engine.dispose(); }
    assert.equal(fetches, 2);
  } finally { globalThis.fetch = prior; }
});
