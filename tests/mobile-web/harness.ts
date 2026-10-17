import assert from 'node:assert/strict';
import { assertCheckpoint } from '../editing/driver.ts';

/** Independent snapshots over the existing production mounted browser adapter. */
export class MobileHarness {
  readonly page: any;
  constructor(page: any) { this.page = page; }
  async requireEngine() {
    assert.equal(await this.page.evaluate(() => {
      const f = (window as any).inputFixture, e = f?.engine;
      return !!e && typeof e.prepare === 'function' && typeof e.commit === 'function' &&
        e.checkpoint().bytes.byteLength > 0 && f.surface.read().identity.documentId === e.read().identity.documentId;
    }), true, 'mobile harness requires a mounted real engine');
  }
  async mount(initial: any) {
    await this.page.waitForFunction(() => !!(window as any).inputFixture);
    assert.equal(initial.blocks.length, 1);
    await this.page.evaluate(text => (window as any).inputFixture.mount(text), initial.blocks[0].text);
    await this.requireEngine(); await this.select(initial.selection);
    const expected = { outcome: 'applied', state: initial, effects: { localCommits: 0, remoteCommits: 0 } };
    await this.checkpoint(expected, 0);
  }
  async select(selection: any) {
    await this.page.evaluate(s => { const f = (window as any).inputFixture; f.select(f.ids[0], s.anchor.offset, s.focus.offset); }, selection);
  }
  async observe() {
    await this.requireEngine();
    const observed = await this.page.evaluate(() => (window as any).inputFixture.state());
    assert.equal(observed.storage, 'localCommitted', 'real IndexedDB flush');
    assert.deepEqual(observed.errors, []);
    assert.equal(observed.nodes.length, 1);
    const node = observed.nodes[0]; assert.deepEqual(node.blockAttributes, ['paragraph']);
    const text = node.runs.map((r: any) => r.text).join('');
    const marks = node.runs.flatMap((r: any) => Object.entries(r.attributes));
    assert.deepEqual(marks, [], 'unmarked harness profile');
    assert.equal(observed.dom, text, 'native DOM and committed engine agree');
    const point = (p: any) => { assert.equal(p?.node, node.id); return { block: 'p1', offset: p.offset }; };
    const anchor = point(observed.selection.anchor), focus = point(observed.selection.focus);
    return { state: { blocks: [{ id: 'p1', kind: 'paragraph', text, hardBreaks: [], marks: [] }],
      selection: { anchor, focus, affinity: anchor.offset <= focus.offset ? 'forward' : 'backward' }, pendingMarks: null }, observed };
  }
  async checkpoint(expected: any, undo: number) {
    const result = await this.observe(), local = result.observed.patches.filter((p: any) => p.update && p.origin.startsWith('editac:local:')).length;
    const remote = result.observed.patches.filter((p: any) => p.update && !p.origin.startsWith('editac:local:')).length;
    assertCheckpoint({ outcome: 'applied', state: result.state, effects: { localCommits: local, remoteCommits: remote }, revision: 0 }, expected);
    assert.equal(result.observed.history.undoGroups, undo, 'semantic history');
    assert.equal(result.observed.journal.length, local + remote, 'actual durable journal');
    return result;
  }
  async nativeInsert(action: any) {
    await this.select(action.range);
    await this.page.evaluate(async action => {
      const f = (window as any).inputFixture, root = f.root;
      root.dispatchEvent(new InputEvent('beforeinput', { bubbles: true, cancelable: false, inputType: 'insertText', data: action.text }));
      const block = root.querySelector('[data-node-id]'), node = document.createTreeWalker(block, NodeFilter.SHOW_TEXT).nextNode() as Text;
      const a = Math.min(action.range.anchor.offset, action.range.focus.offset), b = Math.max(action.range.anchor.offset, action.range.focus.offset);
      node.replaceData(a, b - a, action.text);
      getSelection()!.setBaseAndExtent(node, a + action.text.length, node, a + action.text.length);
      for (const notification of action.notifications) {
        if (notification === 'input') root.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertText', data: action.text }));
        else await Promise.resolve();
      }
    }, action);
  }
}
