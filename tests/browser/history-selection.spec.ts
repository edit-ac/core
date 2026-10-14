import assert from 'node:assert/strict';
import { test } from 'node:test';
import { browserHarness } from './browser-harness.ts';

// RGS-1.3/REG-01: permanent selection regression, separate from the
// independent direct-Enter/content-history baseline gate.
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
  const checkpoint = async (texts, owner, offset) => {
    const observed = await observe(); fact.snapshots.push(observed);
    const blocks = observed.nodes.filter(n => n.kind === 'block');
    assert.deepEqual(blocks.map(n => n.runs.map(r => r.text).join('')), texts);
    assert.equal(blocks[0].id, ids[0], 'heading identity survives history');
    assert.equal(blocks.at(-1).id, ids[1], 'independent list item survives history');
    assert.ok(observed.anchor && observed.focus, 'history must retain both mapped caret endpoints');
    for (const point of [observed.anchor, observed.focus]) {
      assert.equal(point.node, owner); assert.equal(point.offset, offset);
    }
    return blocks;
  };
  await page.locator('#projection h2').click(); await page.keyboard.press('End');
  await checkpoint(['alpha', 'independent'], ids[0], 5);
  await page.keyboard.press('Enter');
  const created = (await observe()).nodes.filter(n => n.kind === 'block')[1].id;
  assert.notEqual(created, ids[0]); assert.notEqual(created, ids[1]);
  await checkpoint(['alpha', '', 'independent'], created, 0);
  await page.keyboard.insertText('X');
  await checkpoint(['alpha', 'X', 'independent'], created, 1);
  const primary = await page.evaluate(() => /Mac|iPhone|iPad/.test(navigator.platform) ? 'Meta' : 'Control');
  await page.keyboard.press(`${primary}+z`);
  await checkpoint(['alpha', '', 'independent'], created, 0);
  await page.keyboard.press(`${primary}+z`);
  await checkpoint(['alpha', 'independent'], ids[0], 5);
  await page.keyboard.press(`${primary}+Shift+z`);
  await checkpoint(['alpha', '', 'independent'], created, 0);
  await page.keyboard.press(`${primary}+Shift+z`);
  await checkpoint(['alpha', 'X', 'independent'], created, 1);
}));


test('single-character cut and its input notifications retain separate history and mapped ranges', () => probe('cut-boundary-history-selection', async (page, fact) => {
  const observe = async (text, a, f = a) => {
    const s = await page.evaluate(async () => {
      const fixture = window.inputFixture, state = await fixture.state(), native = getSelection();
      return { ...state, anchor: native?.anchorNode ? fixture.selection.toModel(native.anchorNode, native.anchorOffset) : null, focus: native?.focusNode ? fixture.selection.toModel(native.focusNode, native.focusOffset) : null };
    });
    fact.snapshots.push(s); assert.equal(s.text[0], text);
    assert.equal(s.anchor?.node, s.ids[0]); assert.equal(s.focus?.node, s.ids[0]);
    assert.equal(s.anchor?.offset, a); assert.equal(s.focus?.offset, f);
    return s;
  };
  await page.evaluate(() => { const f = window.inputFixture; f.engine.history({ type: 'clear' }); f.select(f.ids[0], 1); });
  await page.keyboard.insertText('b'); await observe('ab', 2);
  await page.evaluate(() => { const f = window.inputFixture; f.select(f.ids[0], 1, 2); });
  const cut = await page.evaluate(() => {
    const f = window.inputFixture, data = new DataTransfer(), event = window.preparedClipboardEvent('cut', data);
    f.root.dispatchEvent(event);
    return { text: data.getData('text/plain'), prevented: event.defaultPrevented };
  });
  assert.deepEqual(cut, { text: 'b', prevented: true });
  const afterCut = await observe('a', 1);
  await page.evaluate(() => {
    const f = window.inputFixture;
    f.event('beforeinput', { inputType: 'deleteByCut', cancelable: true });
    f.event('input', { inputType: 'deleteByCut' });
  });
  const afterNotifications = await observe('a', 1);
  assert.equal(afterNotifications.journal.length, afterCut.journal.length);
  assert.equal(afterNotifications.history.undoGroups, afterCut.history.undoGroups);
  await page.keyboard.insertText('d'); const final = await observe('ad', 2);
  assert.equal(final.history.undoGroups, 3);
  const primary = await page.evaluate(() => /Mac|iPhone|iPad/.test(navigator.platform) ? 'Meta' : 'Control');
  for (const [text, a, f] of [['a', 1, 1], ['ab', 1, 2], ['a', 1, 1]]) {
    await page.keyboard.press(`${primary}+z`); await observe(text, a, f);
  }
  for (const [text, at] of [['ab', 2], ['a', 1], ['ad', 2]]) {
    await page.keyboard.press(`${primary}+Shift+z`); await observe(text, at);
  }
  fact.provenance = 'real WebDriver typing/history; prepared ClipboardEvent and accompanying input notifications; no OS clipboard claim';
}, 'a'));
