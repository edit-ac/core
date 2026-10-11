import assert from 'node:assert/strict';
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { createFixtures, describeFixtures, generate, leaves, SEED, sha256, unicodeCases } from '../fixtures/generate.mjs';

const fixtures = createFixtures();
const manifest = describeFixtures(fixtures);
const expected = JSON.parse(await readFile(new URL('../fixtures/manifest.json', import.meta.url), 'utf8'));

test('fixed seed matches committed semantic snapshots and artifact hashes', () => {
  assert.equal(SEED, 0x5eed1234);
  assert.deepEqual(manifest, expected);
  const changedSeed = describeFixtures(createFixtures(SEED + 1));
  for (const name of ['task', 'long', 'large', 'aged']) {
    assert.notEqual(changedSeed.corpora[name].inputRecipeSha256, manifest.corpora[name].inputRecipeSha256);
  }
});

test('Task, Long and Large contain the declared exact text bytes and mixed block counts', () => {
  const specs = [
    ['task', 20, 10_240, [4, 4, 3, 3, 3, 3]],
    ['long', 2_000, 1_048_576, [334, 334, 333, 333, 333, 333]],
    ['large', 10_000, 5_242_880, [1667, 1667, 1667, 1667, 1666, 1666]],
  ];
  for (const [name, blocks, bytes, counts] of specs) {
    const recipe = fixtures[name];
    assert.equal(recipe.blocks.length, blocks);
    assert.equal(new Set(recipe.blocks.map((b) => b.id)).size, blocks);
    assert.equal(leaves(recipe.blocks).reduce((n, b) => n + Buffer.byteLength(b.text), 0), bytes);
    assert.equal(manifest.corpora[name].textBytes, bytes);
    assert.deepEqual(manifest.corpora[name].expectedSemanticShape.types,
      Object.fromEntries(['paragraph', 'heading', 'list-item', 'code', 'quote', 'table']
        .map((kind, i) => [kind, counts[i]])));
    assert.ok(recipe.blocks.some((b) => b.level === 3));
    assert.ok(recipe.blocks.some((b) => b.depth === 3));
  }
});

test('Unicode recipes specify original content, valid UTF-16 edits, graphemes and unapplied anchors', () => {
  const cases = unicodeCases();
  assert.deepEqual(cases.map((c) => c.id), ['astral', 'zwj', 'combining', 'rtl', 'flag', 'modifier', 'variation', 'crlf']);
  assert.deepEqual(cases.map((c) => c.original.length), [4, 7, 4, 6, 6, 6, 4, 4]);
  assert.deepEqual(cases.map((c) => Buffer.byteLength(c.original)), [6, 13, 5, 10, 10, 10, 8, 4]);
  const segmenter = new Intl.Segmenter('en', { granularity: 'grapheme' });
  for (const c of cases) {
    const boundaries = [...segmenter.segment(c.original)].map((s) => s.index).concat(c.original.length);
    assert.deepEqual(boundaries, c.graphemeBoundariesUtf16);
    const [from, to] = c.rangeUtf16;
    assert.ok(boundaries.includes(from));
    assert.ok(boundaries.includes(to));
    assert.equal(c.original.slice(0, from) + c.insert + c.original.slice(to), c.expectedText);
    assert.equal(c.anchor.offsetUtf16, from);
    assert.equal(c.anchor.affinity, 'before');
    assert.equal(c.expectedAnchorAfterReplacementUtf16, from);
    assert.equal(c.engineAnchorResult, null);
    assert.equal(fixtures.adversarial.blocks.find((b) => b.id === c.id).text, c.original);
  }
});

test('adversarial fixtures retain surrogate-interior positions as explicit invalid input cases', () => {
  const expectedInvalid = { astral: [2], zwj: [2, 5], combining: [], rtl: [],
    flag: [2, 4], modifier: [2, 4], variation: [], crlf: [] };
  for (const c of fixtures.adversarial.unicode) {
    const invalid = [];
    for (let i = 1; i < c.original.length; i++) {
      if (c.original.charCodeAt(i - 1) >= 0xd800 && c.original.charCodeAt(i - 1) <= 0xdbff &&
        c.original.charCodeAt(i) >= 0xdc00 && c.original.charCodeAt(i) <= 0xdfff) invalid.push(i);
    }
    assert.deepEqual(c.invalidOffsetsUtf16, expectedInvalid[c.id]);
    assert.deepEqual(invalid, c.invalidOffsetsUtf16);
    assert.equal(c.invalidOffsetExpectedResult, 'reject-before-mutation');
  }
});

test('adversarial shape includes 250 KiB paragraph, 1024 fragmented marks and a 128-column table', () => {
  const [paragraph, fragmented] = fixtures.adversarial.blocks;
  assert.equal(Buffer.byteLength(paragraph.text), 256_000);
  assert.equal(fragmented.text.length, 1024);
  assert.equal(fragmented.marks.length, 1024);
  for (let i = 0; i < 1024; i++) {
    assert.deepEqual(fragmented.marks[i], { fromUtf16: i, toUtf16: i + 1,
      type: i % 2 ? 'emphasis' : 'strong' });
  }
  const table = fixtures.adversarial.blocks.find((b) => b.id === 'wide-table');
  assert.equal(table.rows.length, 4);
  assert.ok(table.rows.every((row) => row.length === 128));
  assert.equal(table.rows[3][127].text, 'r3c127');
  assert.equal(manifest.corpora.adversarial.expectedSemanticShape.nodes, 107);
  assert.equal(manifest.corpora.adversarial.expectedSemanticShape.textLeaves, 525);
});

test('nested input straddles a documented fixture boundary without asserting an engine limit', () => {
  const nested = fixtures.adversarial.blocks.filter((b) => b.children);
  const depths = nested.map((b) => {
    let depth = 1;
    while (b.children) { assert.equal(b.children.length, 1); b = b.children[0]; depth++; }
    assert.equal(b.text, 'leaf');
    return depth;
  });
  assert.deepEqual(depths, [31, 32, 33]);
  assert.deepEqual(fixtures.adversarial.nesting,
    { fixtureBoundary: 32, engineAdmission: 'unqualified', depths: [31, 32, 33] });
  assert.equal(manifest.corpora.adversarial.expectedSemanticShape.maxTreeDepth, 33);
});

test('Aged is a valid 100000-edit Long recipe with an independent semantic oracle, not CRDT state', () => {
  const aged = fixtures.aged;
  const texts = new Map(fixtures.long.blocks.map((b) => [b.id, b.kind === 'table' ? b.rows[0][0].text : b.text]));
  const originals = new Map(texts);
  assert.equal(aged.base, 'long');
  assert.equal(aged.state, 'unapplied-recipe');
  assert.equal(aged.edits.length, 100_000);
  const touched = new Set();
  let inserted = 0;
  let deleted = 0;
  for (const edit of aged.edits) {
    assert.ok(texts.has(edit.target));
    touched.add(edit.target);
    assert.equal(edit.offsetUtf16, 0);
    const text = texts.get(edit.target);
    if (edit.op === 'insert') { inserted++; texts.set(edit.target, edit.text + text); }
    else {
      assert.equal(edit.op, 'delete');
      deleted++;
      const previous = aged.edits[inserted + deleted - 2];
      assert.equal(edit.target, previous.target);
      assert.equal(edit.lengthUtf16, previous.text.length);
      assert.ok(!/[\uD800-\uDBFF]/u.test(text[edit.lengthUtf16 - 1]));
      texts.set(edit.target, text.slice(edit.lengthUtf16));
    }
  }
  assert.equal(inserted, 50_000);
  assert.equal(deleted, 50_000);
  assert.ok(touched.size > 900);
  assert.deepEqual(texts, originals);
  assert.equal(aged.expected.engineState, null);
  assert.equal(aged.expected.engineAnchorResults, null);
  assert.deepEqual(manifest.corpora.aged.expectedSemanticShape, manifest.corpora.long.expectedSemanticShape);
  assert.equal(manifest.corpora.aged.textSha256, manifest.corpora.long.textSha256);
});

test('text bytes, JSON input bytes and unmeasured update bytes stay distinct; editor scenarios are explicit', () => {
  for (const c of Object.values(manifest.corpora)) {
    assert.ok(c.inputRecipeBytes > c.textBytes);
    assert.equal(c.serializedCrdtBytes, null);
    assert.equal(c.serializedCrdtSha256, null);
  }
  assert.deepEqual(manifest.multiEditor, { source: 'task', staticPreviews: 50, activeEditors: [1, 10],
    state: 'scenario-recipe; no runtime or performance qualification' });
});

test('two independent directory generations are byte identical and match every committed hash', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'editac-fnd-fixtures-'));
  try {
    const a = join(dir, 'a');
    const b = join(dir, 'b');
    await generate(a);
    await generate(b);
    const files = (await readdir(a)).sort();
    assert.deepEqual(files, ['adversarial.json', 'adversarial.txt', 'aged.json', 'large.json',
      'large.txt', 'long.json', 'long.txt', 'manifest.json', 'task.json', 'task.txt']);
    assert.deepEqual(files, (await readdir(b)).sort());
    for (const file of files) {
      const left = await readFile(join(a, file));
      const right = await readFile(join(b, file));
      assert.ok(left.equals(right), `${file} differs between generations`);
    }
    assert.deepEqual(JSON.parse(await readFile(join(a, 'manifest.json'), 'utf8')), expected);
    for (const c of Object.values(expected.corpora)) {
      const recipe = await readFile(join(a, c.file));
      assert.equal(recipe.length, c.inputRecipeBytes);
      assert.equal(sha256(recipe), c.inputRecipeSha256);
      const text = await readFile(join(a, c.textFile));
      assert.equal(text.length, c.textBytes);
      assert.equal(sha256(text), c.textSha256);
    }
  } finally { await rm(dir, { recursive: true, force: true }); }
});
