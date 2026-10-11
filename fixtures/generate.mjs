import { createHash } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

// Input recipes only: these trees are not a production schema or a Yrs replica.
export const SEED = 0x5eed1234;
export const CORPORA = Object.freeze({
  task: { blocks: 20, textBytes: 10 * 1024 },
  long: { blocks: 2_000, textBytes: 1024 * 1024 },
  large: { blocks: 10_000, textBytes: 5 * 1024 * 1024 },
});
export const NESTING_BOUNDARY = 32; // Fixture boundary, not an admitted engine limit.
export const KINDS = ['paragraph', 'heading', 'list-item', 'code', 'quote', 'table'];

export function random(seed) {
  let state = seed >>> 0;
  return () => (state = (Math.imul(state, 1664525) + 1013904223) >>> 0);
}

export function unicodeCases() {
  return [
    ['astral', 'a😀b', 1, 3, 'aXb', [0, 1, 3, 4], [2]],
    ['zwj', 'A👩‍💻B', 1, 6, 'AXB', [0, 1, 6, 7], [2, 5]],
    ['combining', 'Ae\u0301B', 1, 3, 'AXB', [0, 1, 3, 4], []],
    ['rtl', 'AשלוםB', 1, 5, 'AXB', [0, 1, 2, 3, 4, 5, 6], []],
    ['flag', 'A🇭🇺B', 1, 5, 'AXB', [0, 1, 5, 6], [2, 4]],
    ['modifier', 'A👍🏽B', 1, 5, 'AXB', [0, 1, 5, 6], [2, 4]],
    ['variation', 'A✈️B', 1, 3, 'AXB', [0, 1, 3, 4], []],
    ['crlf', 'A\r\nB', 1, 3, 'AXB', [0, 1, 3, 4], []],
  ].map(([id, original, from, to, expectedText, graphemeBoundariesUtf16, invalidOffsetsUtf16]) => ({
    id, original, rangeUtf16: [from, to], insert: 'X', expectedText,
    graphemeBoundariesUtf16,
    invalidOffsetsUtf16, invalidOffsetExpectedResult: 'reject-before-mutation',
    anchor: { kind: 'unapplied-input-position', offsetUtf16: from, affinity: 'before' },
    expectedAnchorAfterReplacementUtf16: from,
    engineAnchorResult: null,
  }));
}

function corpus(name, seed) {
  const { blocks: count, textBytes } = CORPORA[name];
  const next = random(seed);
  const samples = unicodeCases();
  const blocks = Array.from({ length: count }, (_, i) => {
    const kind = KINDS[i % KINDS.length];
    const prefix = `${name}:${i}:${next().toString(16)} ${samples[i % samples.length].original} `;
    const budget = Math.floor(textBytes / count) + (i < textBytes % count ? 1 : 0);
    const text = prefix + '.'.repeat(budget - Buffer.byteLength(prefix));
    const block = { id: `${name}-${i}`, kind };
    if (kind === 'table') block.rows = [[{ text, marks: [] }, { text: '', marks: [] }]];
    else {
      block.text = text;
      block.marks = [{ fromUtf16: 0, toUtf16: name.length, type: 'strong' }];
    }
    if (kind === 'heading') block.level = 1 + Math.floor(i / KINDS.length) % 3;
    if (kind === 'list-item') block.depth = 1 + Math.floor(i / KINDS.length) % 4;
    return block;
  });
  return { format: 'editac-input-recipe-v1', name, seed, state: 'input-only', blocks };
}

function nested(depth) {
  let node = { id: `nest-${depth}-leaf`, kind: 'paragraph', text: 'leaf', marks: [] };
  for (let level = depth - 1; level > 0; level--) {
    node = { id: `nest-${depth}-${level}`, kind: 'list-item', children: [node] };
  }
  return node;
}

function adversarial(seed) {
  const unicode = unicodeCases();
  return {
    format: 'editac-input-recipe-v1', name: 'adversarial', seed, state: 'input-only',
    nesting: { fixtureBoundary: NESTING_BOUNDARY, engineAdmission: 'unqualified',
      depths: [NESTING_BOUNDARY - 1, NESTING_BOUNDARY, NESTING_BOUNDARY + 1] },
    unicode,
    blocks: [
      { id: 'huge-paragraph', kind: 'paragraph', text: 'p'.repeat(250 * 1024), marks: [] },
      { id: 'fragmented', kind: 'paragraph', text: 'ab'.repeat(512),
        marks: Array.from({ length: 1024 }, (_, i) => ({ fromUtf16: i, toUtf16: i + 1,
          type: i % 2 ? 'emphasis' : 'strong' })) },
      ...unicode.map((c) => ({ id: c.id, kind: 'paragraph', text: c.original, marks: [] })),
      ...[31, 32, 33].map(nested),
      { id: 'wide-table', kind: 'table', rows: Array.from({ length: 4 }, (_, row) =>
        Array.from({ length: 128 }, (_, col) => ({ text: `r${row}c${col}`, marks: [] }))) },
    ],
  };
}

function aged(seed) {
  const next = random(seed);
  const edits = [];
  for (let pair = 0; pair < 50_000; pair++) {
    const target = `long-${Math.floor(next() / 0x100000000 * CORPORA.long.blocks)}`;
    const text = `e${next().toString(16)}😀`;
    edits.push({ op: 'insert', target, offsetUtf16: 0, text });
    edits.push({ op: 'delete', target, offsetUtf16: 0, lengthUtf16: text.length });
  }
  return {
    format: 'editac-input-recipe-v1', name: 'aged', seed, state: 'unapplied-recipe',
    base: 'long', edits,
    expected: { edits: 100_000, inserts: 50_000, deletes: 50_000,
      finalSemanticContent: 'same-as-long', engineState: null, engineAnchorResults: null },
  };
}

export function createFixtures(seed = SEED) {
  return { task: corpus('task', seed), long: corpus('long', seed),
    large: corpus('large', seed), aged: aged(seed), adversarial: adversarial(seed) };
}

export function leaves(blocks) {
  return blocks.flatMap((b) => b.children ? leaves(b.children) :
    b.kind === 'table' ? b.rows.flat() : [b]);
}

export function semanticShape(recipe) {
  const types = {};
  let maxTreeDepth = 0;
  let nodes = 0;
  const visit = (blocks, depth) => {
    maxTreeDepth = Math.max(maxTreeDepth, depth);
    for (const b of blocks) {
      nodes++;
      types[b.kind] = (types[b.kind] ?? 0) + 1;
      if (b.children) visit(b.children, depth + 1);
    }
  };
  visit(recipe.blocks, 1);
  const texts = leaves(recipe.blocks);
  const tables = new Map();
  for (const b of recipe.blocks.filter((b) => b.kind === 'table')) {
    const rows = b.rows.length;
    const columns = b.rows[0].length;
    const key = `${rows}:${columns}`;
    const prior = tables.get(key);
    tables.set(key, { rows, columns, count: (prior?.count ?? 0) + 1 });
  }
  return { topLevelBlocks: recipe.blocks.length, nodes, types, maxTreeDepth,
    textLeaves: texts.length, utf16Units: texts.reduce((n, b) => n + b.text.length, 0),
    marks: texts.reduce((n, b) => n + b.marks.length, 0),
    tables: [...tables.values()] };
}

export const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex');
export const encode = (value) => Buffer.from(`${JSON.stringify(value)}\n`);

export function describeFixtures(fixtures) {
  const corpora = {};
  for (const [name, recipe] of Object.entries(fixtures)) {
    const bytes = encode(recipe);
    const text = name === 'aged' ? null : Buffer.from(leaves(recipe.blocks).map((b) => b.text).join(''));
    corpora[name] = {
      file: `${name}.json`, inputRecipeBytes: bytes.length, inputRecipeSha256: sha256(bytes),
      textFile: text === null ? 'long.txt' : `${name}.txt`,
      textBytes: text === null ? corpora.long.textBytes : text.length,
      textSha256: text === null ? corpora.long.textSha256 : sha256(text),
      serializedCrdtBytes: null, serializedCrdtSha256: null,
      expectedSemanticShape: name === 'aged' ? corpora.long.expectedSemanticShape : semanticShape(recipe),
      ...(name === 'aged' ? { state: 'unapplied-recipe', expectedEdits: recipe.expected } : {}),
    };
  }
  return { format: 'editac-fixture-manifest-v1', seed: fixtures.task.seed,
    textEncoding: 'UTF-8', publicOffsets: 'UTF-16',
    textLayout: 'depth-first leaf text concatenation without separators; tree boundaries live in recipes',
    crdtState: 'not-generated; null is unmeasured, not zero bytes',
    corpora,
    multiEditor: { source: 'task', staticPreviews: 50, activeEditors: [1, 10],
      state: 'scenario-recipe; no runtime or performance qualification' },
  };
}

export async function generate(outputDir, seed = SEED) {
  const fixtures = createFixtures(seed);
  const manifest = describeFixtures(fixtures);
  await mkdir(outputDir, { recursive: true });
  for (const [name, recipe] of Object.entries(fixtures)) {
    await writeFile(resolve(outputDir, `${name}.json`), encode(recipe));
    if (name !== 'aged') await writeFile(resolve(outputDir, `${name}.txt`),
      Buffer.from(leaves(recipe.blocks).map((b) => b.text).join('')));
  }
  await writeFile(resolve(outputDir, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`);
  return manifest;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  if (process.argv.length !== 3) throw new Error('Usage: node fixtures/generate.mjs OUTPUT_DIRECTORY');
  const manifest = await generate(resolve(process.argv[2]));
  console.log(JSON.stringify({ seed: manifest.seed, corpora: Object.keys(manifest.corpora) }));
}
