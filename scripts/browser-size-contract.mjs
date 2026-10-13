import { createHash } from 'node:crypto';
import { gzipSync, brotliCompressSync, constants } from 'node:zlib';

export const budgets = Object.freeze({ total: { hard: 524288, preferred: 256000 }, js: { hard: 32768, preferred: 16000 } });
export const compression = Object.freeze({ gzip: { level: 9, mtime: 0 }, brotli: { quality: 11 }, counting: 'each distinct delivered resource once; required lazy code included' });
export function describeAsset(name, kind, bytes) {
  if (!['js', 'wasm', 'css', 'asset'].includes(kind)) throw new Error(`Unknown asset kind: ${kind}`);
  return { name, kind, sha256: createHash('sha256').update(bytes).digest('hex'), raw: bytes.length,
    gzip: gzipSync(bytes, { level: 9, mtime: 0 }).length,
    brotli: brotliCompressSync(bytes, { params: { [constants.BROTLI_PARAM_QUALITY]: 11 } }).length };
}
export function evaluateBudget(assets, required) {
  if (!Array.isArray(required) || !required.length) throw new Error('Required asset inventory is missing');
  const names = new Set();
  for (const asset of assets) {
    if (names.has(asset.name)) throw new Error(`Duplicate resource: ${asset.name}`);
    names.add(asset.name);
    if (!['js', 'wasm', 'css', 'asset'].includes(asset.kind) || !Number.isSafeInteger(asset.gzip) || asset.gzip <= 0 || !Number.isSafeInteger(asset.raw) || asset.raw <= 0 || !/^[a-f0-9]{64}$/.test(asset.sha256)) throw new Error(`Invalid measurement: ${asset.name}`);
  }
  for (const item of required) {
    const asset = assets.find(asset => asset.name === item.name);
    if (!asset || asset.kind !== item.kind) throw new Error(`Missing required ${item.kind}: ${item.name}`);
  }
  for (const kind of ['js', 'wasm', 'css']) if (!required.some(item => item.kind === kind)) throw new Error(`Incomplete required inventory: ${kind}`);
  const totals = { total: assets.reduce((n, a) => n + a.gzip, 0), js: assets.filter(a => a.kind === 'js').reduce((n, a) => n + a.gzip, 0) };
  return Object.fromEntries(Object.entries(totals).map(([scope, bytes]) => [scope, { bytes, ...budgets[scope], hardPass: bytes <= budgets[scope].hard, preferredPass: bytes <= budgets[scope].preferred, gap: Math.max(0, bytes - budgets[scope].hard) }]));
}
export function assertBudget(result) {
  const misses = Object.entries(result).filter(([, value]) => !value.hardPass);
  if (misses.length) throw new Error(misses.map(([scope, value]) => `${scope}: ${value.bytes} gzip bytes exceeds ${value.hard} by ${value.gap}`).join('; '));
}

export function auditTaskGraph(sources, {markdown = false} = {}) {
  const inputs = Object.keys(sources);
  if (!markdown && inputs.some(p=>/markdown\/dist|clipboard\/markdown\.js/.test(p))) throw new Error('Optional Markdown leaked into default Task graph');
  if (inputs.some(p => p !== 'task.mjs' && !p.startsWith('node_modules/@edit-ac/'))) throw new Error('Consumer resolved outside packed SDKs');
  const essentialInputs = ['core/dist/index.js', 'core/dist/engine.js', 'web/dist/editor.js', 'web/dist/storage/checkpoint.js', 'web/dist/sync/protocol.js', 'web/dist/surface.js'];
  for (const name of essentialInputs) if (!inputs.some(p => p.endsWith(name))) throw new Error(`Missing Task production dependency: ${name}`);
  if (markdown) for (const name of ['markdown/dist/index.js','markdown/dist/web.js','markdown/dist/shortcuts.js']) if (!inputs.some(p=>p.endsWith(name))) throw new Error(`Missing enabled Markdown dependency: ${name}`);
  const bundledParser = inputs.some(p=>p.endsWith('markdown/dist/wasm/editac_markdown_wasm.js'));
  const bundledGlue = inputs.some(p => p.endsWith('core/dist/wasm/editac_wasm.js'));
  for (const [name, source] of Object.entries(sources)) {
    const lazy = source.match(/\bimport\s*\(/g) || [];
    if (lazy.length && !(name.endsWith('core/dist/index.js') && lazy.length === 1 && ((source.includes('import(gluePath)') && source.includes('./wasm/editac_wasm.js')) || (bundledGlue && (source.includes('import("./wasm/editac_wasm.js")') || (inputs.some(p => p.endsWith('core/dist/wasm/editac_runtime.js')) && source.includes('import("./wasm/editac_runtime.js")')))))) && !(markdown && name.endsWith('markdown/dist/index.js') && lazy.length === 1 && bundledParser && source.includes("import('./wasm/editac_markdown_wasm.js')"))) throw new Error(`Uninventoried required lazy code: ${name}`);
  }
}
