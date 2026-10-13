import assert from 'node:assert/strict';
import { test } from 'node:test';
import { browserHarness } from './browser-harness.ts';

// RGS-1.3/REG-01: an explicit failing regression, separate from the baseline
// direct-Enter/content-history gate until semantic history bookmarks are qualified.
const { probe } = browserHarness('history-selection');
test('undo paragraph creation restores the stored heading-end selection', () => probe('heading-end-history-selection', async (page, fact) => {
  const ids = await page.evaluate(() => {
    const f = window.inputFixture;
    f.engine.commit(f.engine.prepare({ kind: 'format', origin: 'fixture', marks: [], blocks: [{ targets: [f.ids[0]], attributes: { type: 'heading', level: 2 }, action: 'apply' }] }));
    f.engine.commit(f.engine.prepare({ kind: 'editor', origin: 'fixture', commands: [{ type: 'wrap', targets: [f.ids[1]], style: { type: 'unordered' } }] }));
    f.engine.history({ type: 'clear' }); return f.ids;
  });
  const observe = async () => page.evaluate(async () => {
    const f = window.inputFixture; await f.settle();
    const native = getSelection();
    return { nodes: f.engine.read().visible,
      anchor: native.anchorNode ? f.selection.toModel(native.anchorNode, native.anchorOffset) : null,
      focus: native.focusNode ? f.selection.toModel(native.focusNode, native.focusOffset) : null };
  });
  await page.locator('#projection h2').click(); await page.keyboard.press('End');
  await page.keyboard.press('Enter'); await page.keyboard.insertText('X');
  const primary = await page.evaluate(() => /Mac|iPhone|iPad/.test(navigator.platform) ? 'Meta' : 'Control');
  await page.keyboard.press(`${primary}+z`); await page.keyboard.press(`${primary}+z`);
  const undone = await observe(); fact.snapshots.push(undone);
  assert.deepEqual(undone.nodes.filter(n => n.kind === 'block').map(n => n.runs.map(r => r.text).join('')), ['alpha', 'independent']);
  assert.ok(undone.anchor && undone.focus, 'Undo must retain a mapped heading-end caret');
  for (const point of [undone.anchor, undone.focus]) { assert.equal(point.node, ids[0]); assert.equal(point.offset, 5); }
  await page.keyboard.press(`${primary}+Shift+z`); await page.keyboard.press(`${primary}+Shift+z`);
  const redone = await observe(); fact.snapshots.push(redone);
  const paragraph = redone.nodes.filter(n => n.kind === 'block')[1];
  for (const point of [redone.anchor, redone.focus]) { assert.equal(point?.node, paragraph.id); assert.equal(point?.offset, 1); }
}));
