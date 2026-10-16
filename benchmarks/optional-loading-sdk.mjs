// Reuse the ordinary PRF-06 client and restoration oracle with the exact packed
// optional distribution. This wrapper is retained test-host code, never shipped.
import * as sdk from '/fixture/assets/task.js';
export * from '/fixture/assets/task.js';
const { optional } = JSON.parse(document.querySelector('#options').textContent);
const observation = window.optionalLoading = { enabled: optional, mounts: 0, init: null, firstUse: null };
let markdown;
if (optional) {
  const startMs = performance.now();
  const codec = await sdk.initMarkdown('/fixture/assets/wasm/editac_markdown_wasm_bg.wasm');
  const endMs = performance.now();
  observation.init = { startMs, endMs, durationMs: endMs - startMs };
  const useStart = performance.now();
  const prepared = codec.importMarkdown('**optional 😀**');
  const exported = codec.exportMarkdown(prepared.blocks).markdown;
  if (exported.trim() !== '**optional 😀**') throw Error('Optional parser round trip failed');
  const useEnd = performance.now();
  observation.firstUse = { startMs: useStart, endMs: useEnd, durationMs: useEnd - useStart, roundTrip: true };
  markdown = sdk.markdownExtension(codec);
}
export function createEditor(host, options) {
  observation.mounts++;
  return sdk.createEditor(host, { ...options, ...(optional ? { markdown } : {}) });
}
