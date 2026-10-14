import assert from 'node:assert/strict';
import type { EngineHandle, EngineRuntime, FragmentBlock } from '../../packages/core/src/index.ts';
import type { Action, Recipe, State, Selection, Expected } from './fixture-loader.ts';

export const capabilities: ReadonlySet<string> = new Set(['compound-edit', 'result-selection', 'hard-break', 'utf16']);
export const supportedActions: ReadonlySet<string> = new Set(['insertText', 'insertParagraph', 'insertHardBreak', 'setSelection']);
export const profile = Object.freeze({ name: 'rgs-paragraph-v1', engine: 'v5', initial: 'unmarked paragraphs', capabilities: [...capabilities], actions: [...supportedActions] });
export class FixedClock {
  now = 0;
  advance(ms: number) {
    if (!Number.isSafeInteger(ms) || ms < this.now) throw new Error('clockMs must be monotonic');
    this.now = ms;
  }
}
export interface DriverResult { outcome: string; state: State; effects: { localCommits: number; remoteCommits: number }; revision: number }
let sessionSequence = 0;
export class EditingDriver {
  readonly engine: EngineHandle;
  readonly clock = new FixedClock();
  readonly ids = new Map<string, string>();
  protected selection: Selection;
  protected pendingMarks: null | string[];
  protected disposed = false;
  constructor(runtime: EngineRuntime, initial: State) {
    if (initial.blocks.some(b => b.kind !== 'paragraph' || b.marks.length || b.hardBreaks.length) || initial.pendingMarks !== null)
      throw new Error('Unsupported initial profile: requires unmarked paragraphs and context-derived marks');
    const session = String(++sessionSequence).padStart(12, '0');
    this.engine = runtime.createEngine({ profile: 'v5', documentId: `42000000-0000-4000-8000-${session}`, epoch: `42000000-0000-4000-9000-${session}`, nodes: initial.blocks.map(b => ({ text: b.text })) });
    this.engine.read().visible.forEach((node, i) => this.ids.set(initial.blocks[i].id, node.id));
    this.selection = structuredClone(initial.selection); this.pendingMarks = initial.pendingMarks;
    try { this.assertSelection(this.selection); } catch (error) { this.engine.dispose(); throw error; }
  }
  protected id(alias: string): string {
    const id = this.ids.get(alias); if (!id) throw new Error(`Unbound logical ID: ${alias}`); return id;
  }
  protected assertSelection(selection: Selection) {
    const anchors: ReturnType<EngineHandle['anchor']>[] = [];
    try { for (const p of [selection.anchor, selection.focus]) anchors.push(this.engine.anchor(this.id(p.block), p.offset, 'right')); }
    finally { anchors.forEach(a => this.engine.releaseAnchor(a)); }
  }
  snapshot(): State {
    const aliases = new Map([...this.ids].map(([alias, id]) => [id, alias]));
    const blocks = this.engine.read().visible.filter(n => n.kind === 'block').map(node => {
      const id = aliases.get(node.id); if (!id) throw new Error(`Unbound engine ID: ${node.id}`);
      const text = node.runs.map(r => r.text).join('');
      const kind = (node.blockAttributes as unknown[])?.[0];
      if (kind !== 'paragraph') throw new Error(`Unsupported snapshot kind: ${kind}`);
      if (node.runs.some(r => Object.keys(r.attributes).length)) throw new Error('Unsupported snapshot marks');
      return { id, kind: 'paragraph' as const, text, hardBreaks: [...text.matchAll(/\n/g)].map(m => m.index!), marks: [] };
    });
    this.assertSelection(this.selection);
    return { blocks, selection: structuredClone(this.selection), pendingMarks: this.pendingMarks === null ? null : [...this.pendingMarks] };
  }
  act(action: Action): DriverResult {
    if (this.disposed) throw new Error('Disposed driver');
    if (action.clockMs !== undefined) this.clock.advance(action.clockMs);
    if (!supportedActions.has(action.type)) throw new Error(`Unsupported action: ${action.type}`);
    if (action.type === 'setSelection') {
      if (!action.selection) throw new Error('Missing selection');
      this.assertSelection(action.selection); this.selection = structuredClone(action.selection);
      return { outcome: 'selection-only', state: this.snapshot(), effects: { localCommits: 0, remoteCommits: 0 }, revision: this.engine.read().revision };
    }
    const before = this.engine.read();
    const a = this.selection.anchor, f = this.selection.focus;
    const anchors: ReturnType<EngineHandle['anchor']>[] = [];
    let plan: ReturnType<EngineHandle['prepare']> | undefined;
    let caret: ReturnType<EngineHandle['anchor']> | undefined;
    let publications = 0;
    const subscription = this.engine.subscribe({ type: 'updates' }, () => publications++);
    try {
      // Preserve invalid action arguments: engine anchors/prepare reject them, not the loader.
      const anchor = this.engine.anchor(this.id(a.block), a.offset, this.selection.affinity === 'backward' ? 'left' : 'right'); anchors.push(anchor);
      const focus = this.engine.anchor(this.id(f.block), f.offset, this.selection.affinity === 'backward' ? 'left' : 'right'); anchors.push(focus);
      const range = { anchor, focus };
      if (action.type === 'insertParagraph' && (!action.newBlockId || this.ids.has(action.newBlockId))) throw new Error('Missing/duplicate newBlockId');
      if (action.type === 'insertText' && typeof action.text !== 'string') throw new Error('Missing insertion text');
      const blocks: FragmentBlock[] = action.type === 'insertParagraph'
        ? [{ runs: [], attributes: { type: 'paragraph' } }, { runs: [], attributes: { type: 'paragraph' } }]
        : [{ runs: [{ text: action.type === 'insertText' ? action.text! : '\n', marks: [] }], attributes: { type: 'paragraph' } }];
      plan = this.engine.prepare({ kind: 'fragment', origin: 'local:rgs', range, blocks });
      // As in the production text adapter, an upper-end right-biased anchor
      // survives replacement and resolves after inserted text. Structural creation
      // still requires the engine's returned result caret to bind a new alias.
      const upper = a.block === f.block && a.offset > f.offset ? anchor : focus;
      const result = this.engine.commit(plan); caret = result.caret;
      if (!caret && action.type === 'insertParagraph') throw new Error('Engine did not return structural result caret');
      const position = this.engine.resolve(caret ?? upper);
      if (position.type !== 'position') throw new Error('Result caret did not resolve');
      if (action.type === 'insertParagraph') {
        assert.ok(!before.visible.some(node => node.id === position.node), 'split must return a new stable identity');
        this.ids.set(action.newBlockId!, position.node);
      }
      const alias = [...this.ids].find(([, id]) => id === position.node)?.[0];
      if (!alias) throw new Error(`Unbound caret ID: ${position.node}`);
      this.selection = { anchor: { block: alias, offset: position.offset }, focus: { block: alias, offset: position.offset }, affinity: position.bias === 'left' ? 'backward' : 'forward' };
      return { outcome: result.revision === before.revision ? 'no-op' : 'applied', state: this.snapshot(), effects: { localCommits: publications, remoteCommits: 0 }, revision: result.revision };
    } finally {
      subscription.dispose(); if (plan) this.engine.releasePlan(plan); if (caret) this.engine.releaseAnchor(caret);
      anchors.forEach(anchor => this.engine.releaseAnchor(anchor));
    }
  }
  dispose() { this.disposed = true; this.engine.dispose(); }
}
export function assertCheckpoint(actual: DriverResult, expected: Expected) {
  assert.equal(actual.outcome, expected.outcome, 'outcome');
  assert.deepEqual(actual.state, expected.state, 'independent semantic/selection/pending-mark snapshot');
  assert.deepEqual(actual.effects, expected.effects, 'observed update publications');
}
export function replay(runtime: EngineRuntime, recipe: Recipe) {
  const driver = new EditingDriver(runtime, recipe.initial);
  const results: DriverResult[] = [];
  try {
    assert.deepEqual(driver.snapshot(), recipe.initial, 'initial independent snapshot');
    for (const step of recipe.steps) { const result = driver.act(step.action); assertCheckpoint(result, step.expect); results.push(result); }
    return results;
  } finally { driver.dispose(); }
}
