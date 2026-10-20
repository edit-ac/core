import { createHash } from 'node:crypto';
export const sizes = { task: [20, 10240], long: [2000, 1048576] };
const sentence = 'Planning notes: preserve selection, undo history, and offline edits. café 😀 日本語. ';
export function corpus(name) {
  if (!sizes[name]) throw Error(`Unknown comparison fixture ${name}`);
  const [count, bytes] = sizes[name], width = Math.floor(bytes / count);
  const blocks = Array.from({ length: count }, (_, i) => {
    const length = width + (i < bytes % count ? 1 : 0);
    let text = '', used = 0;
    for (const character of sentence.repeat(Math.ceil(length / sentence.length))) {
      const size = Buffer.byteLength(character);
      if (used+size > length) break;
      text+=character; used+=size;
    }
    text+='.'.repeat(length-used);
    const type = i % 13 === 1 ? 'heading' : i % 13 === 2 ? 'code' : i % 13 >= 3 && i % 13 <= 6 ? 'list' : 'paragraph';
    return { type, text };
  });
  const text = blocks.map(b => b.text).join('');
  return { version: 2, name, blocks, textUtf16: text.length, textBytes: Buffer.byteLength(text), sha256: createHash('sha256').update(JSON.stringify(blocks)).digest('hex') };
}
export function summary(samples) {
  if (!samples.length || samples.some(x => !Number.isFinite(x) || x < 0)) throw Error('Invalid comparison samples');
  const sorted = [...samples].sort((a,b) => a-b), quantile = p => sorted[Math.max(0, Math.ceil(sorted.length*p)-1)];
  return { count: sorted.length, p50: quantile(.5), p95: sorted.length >= 100 ? quantile(.95) : null,
    p99: sorted.length >= 1000 ? quantile(.99) : null, min: sorted[0], max: sorted.at(-1),
    tailStatus: sorted.length >= 1000 ? 'measured' : 'Inconclusive: insufficient independent samples for tails' };
}
