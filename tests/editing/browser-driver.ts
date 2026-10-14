import assert from 'node:assert/strict';
import type { Page } from 'playwright';
import type { Action, Expected, Recipe, Selection, State } from './fixture-loader.ts';
import { assertCheckpoint, type DriverResult } from './driver.ts';

export const browserCapabilities = new Set(['native-dom-fallback', 'intent-correlation']);
export const browserInputSources = [
  'tests/editing/browser-driver.ts', 'tests/editing/fixture-loader.ts', 'tests/editing/driver.ts',
  'scripts/test-editing.mjs', 'scripts/editing-suites.mjs',
  'fixtures/browser-input/session.mjs', 'fixtures/browser-input/index.html',
  ...['text', 'composition', 'protocol', 'reconcile', 'keyboard'].flatMap(name => [
    `packages/web/src/input/${name}.ts`, `packages/web/dist/input/${name}.js`,
  ]),
  ...['dom/render', 'dom/selection', 'storage/index', 'storage/writer', 'storage/journal', 'entry'].flatMap(name => [
    `packages/web/src/${name}.ts`, `packages/web/dist/${name}.js`,
  ]),
  'packages/core/dist/engine.js', 'packages/core/dist/index.js', 'packages/core/dist/wasm/editac_wasm_bg.wasm',
  '../architecture/decisions/004-browser-input-composition.md',
  '../architecture/evidence/browser-input-policy/receipt.json',
];

/** Prepared browser replay only. Actions use actual native DOM edits/listeners;
 * assertions read committed engine state, mapped DOM caret and attached storage.
 * This bounded profile deliberately rejects unsupported marks/blocks/actions. */
export class BrowserEditingDriver {
  readonly page: Page;
  readonly ids = new Map<string, string>();
  constructor(page: Page) { this.page = page; }
  async mount(initial: State) {
    if (initial.blocks.length !== 1 || initial.blocks[0].kind !== 'paragraph' ||
        initial.blocks[0].marks.length || initial.blocks[0].hardBreaks.length || initial.pendingMarks !== null)
      throw Error('Unsupported browser recipe profile: one unmarked paragraph, context marks');
    await this.page.waitForFunction(() => !!(window as any).inputFixture);
    const ids = await this.page.evaluate(async text => {
      const f = (window as any).inputFixture;
      await f.mount(text, null); return f.ids as string[];
    }, initial.blocks[0].text);
    this.ids.set(initial.blocks[0].id, ids[0]);
    await this.select(initial.selection);
    assert.deepEqual((await this.observe()).state, initial, 'independent initial snapshot');
  }
  id(alias: string) { const id = this.ids.get(alias); if (!id) throw Error(`Unbound logical ID: ${alias}`); return id; }
  async select(selection: Selection) {
    if (selection.anchor.block !== selection.focus.block) throw Error('Unsupported cross-block browser recipe range');
    await this.page.evaluate(({ id, a, b }) => (window as any).inputFixture.select(id, a, b),
      { id: this.id(selection.anchor.block), a: selection.anchor.offset, b: selection.focus.offset });
  }
  async settle() {
    return this.page.evaluate(async () => {
      const f = (window as any).inputFixture;
      let timer: ReturnType<typeof setTimeout> | undefined;
      try {
        // This is an upper-bound failure deadline, never a settlement sleep.
        await Promise.race([f.settle(), new Promise((_, reject) => {
          timer = setTimeout(() => reject(Error('Input/persistence failed to settle within 5s')), 5000);
        })]);
      } finally { clearTimeout(timer); }
      return { policy: 'production generation-aware eight-turn drain + local storage flush + drain',
        generations: [...new Set(f.protocol.intents.map((i: any) => i.generation))],
        pending: f.protocol.intents.filter((i: any) => i.disposition === 'native-pending') };
    });
  }
  async observe() {
    const settlement = await this.settle();
    const observed = await this.page.evaluate(async () => {
      const f = (window as any).inputFixture, s = await f.state(), native = getSelection();
      return { ...s, nodes: f.engine.read().visible,
        anchor: native?.anchorNode ? f.selection.toModel(native.anchorNode, native.anchorOffset) : null,
        focus: native?.focusNode ? f.selection.toModel(native.focusNode, native.focusOffset) : null };
    });
    assert.deepEqual(settlement.pending, [], 'all owned intents terminal at checkpoint');
    assert.deepEqual(observed.errors, [], 'no hidden observer failures');
    assert.deepEqual(observed.dom, observed.text, 'actual DOM agrees with engine');
    assert.equal(observed.storage, 'localCommitted', 'attached real storage flushed');
    assert.equal(observed.selectionSuspended, false, 'selection generation acknowledged');
    const aliases = new Map([...this.ids].map(([alias, id]) => [id, alias]));
    const alias = (id: string) => { const value = aliases.get(id); if (!value) throw Error(`Unbound engine ID: ${id}`); return value; };
    const blocks = observed.nodes.filter((n: any) => n.kind === 'block').map((n: any) => {
      assert.equal(n.blockAttributes?.[0], 'paragraph', 'declared browser snapshot profile');
      assert.ok(n.runs.every((r: any) => Object.keys(r.attributes).length === 0), 'unmarked profile');
      const text = n.runs.map((r: any) => r.text).join('');
      return { id: alias(n.id), kind: 'paragraph' as const, text, hardBreaks: [...text.matchAll(/\n/g)].map(m => m.index!), marks: [] };
    });
    assert.ok(observed.anchor && observed.focus, 'both actual mapped DOM endpoints present');
    const point = (p: any) => ({ block: alias(p.node), offset: p.offset });
    const state: State = { blocks, selection: { anchor: point(observed.anchor), focus: point(observed.focus),
      affinity: observed.anchor.offset <= observed.focus.offset ? 'forward' : 'backward' }, pendingMarks: null };
    return { state, observed, settlement };
  }
  async nativeInsert(action: Action) {
    if (action.type !== 'nativeInsert' || typeof action.text !== 'string') throw Error(`Unsupported browser action: ${action.type}`);
    const range = action.range as Selection;
    if (!range || !['missing', 'noncancelable'].includes(action.beforeinput as string)) throw Error('Unsupported nativeInsert boundary');
    const notifications = action.notifications as string[];
    if (!Array.isArray(notifications) || notifications.some(n => !['input', 'observer'].includes(n))) throw Error('Unsupported native notifications');
    await this.select(range);
    await this.page.evaluate(async ({ id, a, b, text, beforeinput, notifications }) => {
      const f = (window as any).inputFixture;
      if (beforeinput === 'noncancelable') f.event('beforeinput', { inputType: 'insertText', data: text, cancelable: false });
      // Compute only the action's native mutation from the live DOM and range.
      // No expected state enters this callback or the production engine.
      const block = f.renderer.getBlock(id), old = block.textContent;
      f.mutate(old.slice(0, Math.min(a, b)) + text + old.slice(Math.max(a, b)), id);
      for (const notification of notifications) {
        if (notification === 'input') f.event('input', { inputType: 'insertText', data: text });
        else await Promise.resolve(); // actual MutationObserver delivery, never a fabricated record
      }
    }, { id: this.id(range.anchor.block), a: range.anchor.offset, b: range.focus.offset,
      text: action.text, beforeinput: action.beforeinput, notifications });
  }
  async step(action: Action, expected: Expected) {
    const before = (await this.observe()).observed;
    await this.nativeInsert(action);
    const snapshot = await this.observe(), after = snapshot.observed;
    const local = (s: any) => s.patches.filter((p: any) => p.update && p.origin.startsWith('editac:local:')).length;
    const remote = (s: any) => s.patches.filter((p: any) => p.update && !p.origin.startsWith('editac:local:')).length;
    const result: DriverResult = { state: snapshot.state, outcome: 'applied', effects: {
      localCommits: local(after) - local(before), remoteCommits: remote(after) - remote(before) }, revision: after.patches.at(-1)?.revision ?? 0 };
    assertCheckpoint(result, expected);
    assert.equal(after.journal.length - before.journal.length, expected.effects.localCommits + expected.effects.remoteCommits, 'actual durable journal delta');
    assert.equal(after.history.undoGroups - before.history.undoGroups, expected.effects.localCommits, 'actual native history group delta');
    assert.equal(after.intents.filter((i: any) => i.disposition === 'committed').length - before.intents.filter((i: any) => i.disposition === 'committed').length, expected.effects.localCommits, 'committed intent delta');
    return { result, ...snapshot };
  }
  async replay(recipe: Recipe) {
    for (const capability of recipe.requires) if (!browserCapabilities.has(capability)) throw Error(`Unsupported browser capability: ${capability}`);
    await this.mount(recipe.initial);
    const results = [];
    for (const step of recipe.steps) results.push({ id: step.id, ...await this.step(step.action, step.expect) });
    return results;
  }
}
