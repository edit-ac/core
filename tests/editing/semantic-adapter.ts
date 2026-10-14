import assert from 'node:assert/strict';
import type { EngineHandle, EngineRuntime, EditorCommand, MarkCommand, PrepareRequest, FragmentBlock } from '../../packages/core/src/index.ts';
import { EditingDriver, type DriverResult } from './driver.ts';
import type { Action, State, Selection, Position } from './fixture-loader.ts';

export class MissingCapabilityError extends Error {}
export const semanticCapabilities = new Set(['compound-edit', 'result-selection', 'hard-break', 'utf16', 'range-format', 'pending-marks', 'atomic-rejection', 'multi-block-replace', 'grapheme-delete', 'boundary-noop', 'history']);
export const semanticActions = new Set(['insertText', 'insertParagraph', 'insertHardBreak', 'toggleMark', 'setSelection', 'applyBatch', 'backspace', 'deleteForward', 'undo', 'redo', 'pasteFragment']);
const markNames: MarkCommand['mark'][] = ['bold', 'italic', 'strike', 'underline', 'code', 'link'];
export const semanticProfile = Object.freeze({ name: 'rgs-semantic-v1', engine: 'v5', capabilities: [...semanticCapabilities], actions: [...semanticActions], historySelection: 'unsupported', persistence: 'unattached', graphemes: 'pinned Node ICU prepared command targets; matching native Unicode vectors' });

/** Test adapter over public qualified operations. It never reads expected state. */
export class SemanticDriver extends EditingDriver {
  constructor(runtime: EngineRuntime, initial: State, { restored = false }: { restored?: boolean } = {}) {
    super(runtime, { ...initial, pendingMarks: null, blocks: initial.blocks.map(b => ({ ...b, kind: 'paragraph', hardBreaks: [], marks: [] })) });
    try {
      const commands: EditorCommand[] = [];
      for (const block of initial.blocks) {
        if (block.kind === 'code') commands.push({ type: 'setCode', owner: this.id(block.id), language: '' });
        for (const mark of block.marks) commands.push({ type: 'markAt', owner: this.id(block.id), from: mark.from, to: mark.to, mark: mark.type as MarkCommand['mark'], action: 'apply' });
      }
      if (!restored && commands.length) {
        const plan = this.engine.prepare({ kind: 'editor', origin: 'fixture:setup', commands });
        try { this.releaseResult(this.engine.commit(plan)); } finally { this.engine.releasePlan(plan); }
      }
      if (restored) {
        const history = this.engine.history({ type: 'state' });
        assert.equal(history.undoGroups, 0, 'restored fixture starts with empty history');
        assert.equal(history.redoGroups, 0, 'restored fixture starts with empty redo');
      } else this.engine.history({ type: 'clear' });
      this.pendingMarks = initial.pendingMarks === null ? null : [...initial.pendingMarks];
      assert.deepEqual(this.snapshot(), initial, 'independent initial semantic fixture');
    } catch (error) { this.dispose(); throw error; }
  }
  override snapshot(): State {
    const aliases = new Map([...this.ids].map(([alias, id]) => [id, alias]));
    const blocks: State['blocks'] = this.engine.read().visible.filter(n => n.kind === 'block').map(node => {
      const id = aliases.get(node.id); if (!id) throw new Error(`Unbound engine identity: ${node.id}`);
      const kind = (node.blockAttributes as unknown[])?.[0];
      if (kind !== 'paragraph' && kind !== 'code') throw new MissingCapabilityError(`Unsupported semantic projection: ${kind}`);
      const text = node.runs.map(r => r.text).join('');
      const marks: State['blocks'][number]['marks'] = []; let offset = 0;
      for (const run of node.runs) {
        for (const type of Object.keys(run.attributes).sort()) {
          if (!markNames.includes(type as MarkCommand['mark'])) throw new MissingCapabilityError(`Unsupported mark: ${type}`);
          const last = marks.findLast(m => m.type === type);
          if (last?.to === offset) last.to += run.text.length;
          else marks.push({ from: offset, to: offset + run.text.length, type });
        }
        offset += run.text.length;
      }
      marks.sort((a, b) => a.from - b.from || a.to - b.to || a.type.localeCompare(b.type));
      return { id, kind, text, hardBreaks: kind === 'paragraph' ? [...text.matchAll(/\n/g)].map(m => m.index!) : [], marks };
    });
    this.assertSelection(this.selection);
    return { blocks, selection: structuredClone(this.selection), pendingMarks: this.pendingMarks === null ? null : [...this.pendingMarks] };
  }
  frozen() {
    const { changedNodes, touchedRanges, ...snapshot } = this.engine.read();
    return { snapshot, vector: Buffer.from(this.engine.stateVector()), checkpoint: Buffer.from(this.engine.checkpoint().bytes), history: this.engine.history({ type: 'state' }), state: this.snapshot() };
  }
  private releaseResult(result: ReturnType<EngineHandle['commit']>) {
    if (result.caret) this.engine.releaseAnchor(result.caret);
    if (result.selection) { this.engine.releaseAnchor(result.selection.anchor); this.engine.releaseAnchor(result.selection.focus); }
  }
  private position(p: Position) { return { owner: this.ids.get(p.block) ?? p.block, offset: p.offset, bias: this.selection.affinity === 'backward' ? 'left' as const : 'right' as const }; }
  private resultSelection(s: Selection): EditorCommand { return { type: 'selectionAt', anchor: this.position(s.anchor), focus: this.position(s.focus) }; }
  private collapsed(offset: number, block = this.selection.anchor.block): Selection { return { anchor: { block, offset }, focus: { block, offset }, affinity: this.selection.affinity }; }
  private commit(request: PrepareRequest, resultAffinity = this.selection.affinity): DriverResult {
    const before = this.frozen(); let events = 0; let plan: ReturnType<EngineHandle['prepare']> | undefined;
    const subscription = this.engine.subscribe({ type: 'updates' }, () => events++);
    try {
      try { plan = this.engine.prepare(request); }
      catch (error) { assert.deepEqual(this.frozen(), before, 'rejection preserves content, identity, revisions, vectors, history and pending state'); assert.equal(events, 0); return this.result('rejected', 0); }
      assert.deepEqual(this.frozen(), before, 'prepare is isolated');
      const result = this.engine.commit(plan);
      try {
        if (result.selection) {
          const points = [result.selection.anchor, result.selection.focus].map(token => {
            const p = this.engine.resolve(token); assert.equal(p.type, 'position');
            if (p.type !== 'position') throw new Error('Missing result endpoint');
            const block = [...this.ids].find(([, id]) => id === p.node)?.[0]; assert.ok(block, 'result endpoint has a bound stable identity');
            assert.equal(p.bias, resultAffinity === 'backward' ? 'left' : 'right', 'result affinity');
            return { block, offset: p.offset };
          });
          this.selection = { anchor: points[0], focus: points[1], affinity: resultAffinity };
        }
        assert.equal(events, result.revision === before.snapshot.revision ? 0 : 1, 'one attributable publication');
        return this.result(result.revision === before.snapshot.revision ? 'no-op' : 'applied', events);
      } finally { this.releaseResult(result); }
    } finally { subscription.dispose(); if (plan) this.engine.releasePlan(plan); }
  }
  private result(outcome: string, events: number): DriverResult { return { outcome, state: this.snapshot(), effects: { localCommits: events, remoteCommits: 0 }, revision: this.engine.read().revision }; }
  private contextMarks(): string[] {
    if (this.pendingMarks !== null) return [...this.pendingMarks];
    const block = this.snapshot().blocks.find(b => b.id === this.selection.anchor.block)!;
    const offset = Math.min(this.selection.anchor.offset, this.selection.focus.offset);
    return block.marks.filter(m => this.selection.affinity === 'backward' && offset > 0
      ? m.from < offset && offset <= m.to
      : m.from <= offset && (offset < m.to || offset === block.text.length && offset === m.to)).map(m => m.type);
  }
  override act(action: Action): DriverResult {
    if (this.disposed) throw new Error('Disposed driver');
    if (action.clockMs !== undefined) this.clock.advance(action.clockMs);
    const a = this.selection.anchor, f = this.selection.focus;
    if (action.type === 'setSelection') {
      if (!action.selection) throw new Error('Missing selection');
      this.assertSelection(action.selection); this.selection = structuredClone(action.selection); this.pendingMarks = null;
      return this.result('selection-only', 0);
    }
    if (action.type === 'undo' || action.type === 'redo') {
      const history = this.engine.history({ type: 'state' });
      if (action.type === 'undo' ? history.undoGroups : history.redoGroups) throw new MissingCapabilityError('History selection bookmark/result port is absent; do not restore a fabricated driver selection');
      const before = this.frozen(); this.engine.history({ type: action.type }); assert.deepEqual(this.frozen(), before); return this.result('no-op', 0);
    }
    if (action.type === 'applyBatch') {
      return this.applyBatch(action);
    }
    if (action.type === 'toggleMark') {
      const mark = action.mark as MarkCommand['mark'];
      if (a.block === f.block && a.offset === f.offset) {
        // Explicit profile admission precedes changing transient editor state.
        if (!markNames.includes(mark) || mark === 'link' || this.snapshot().blocks.find(b => b.id === a.block)!.kind === 'code') return this.result('rejected', 0);
        const next = new Set(this.contextMarks()); if (next.has(mark)) next.delete(mark); else next.add(mark);
        this.pendingMarks = [...next].sort(); return this.result('selection-only', 0);
      }
      if (a.block !== f.block) throw new MissingCapabilityError('Cross-owner format with result selection is not bound');
      return this.commit({ kind: 'editor', origin: 'local:rgs:format', commands: [{ type: 'markAt', owner: this.id(a.block), from: Math.min(a.offset, f.offset), to: Math.max(a.offset, f.offset), mark, action: 'toggle' }, this.resultSelection(this.selection)] });
    }
    if (action.type === 'insertParagraph' || action.type === 'insertHardBreak') return super.act(action);
    if (action.type === 'pasteFragment') return this.paste(action.blocks as FragmentBlock[], action.newBlockIds as string[] | undefined);
    if (action.type === 'insertText' || action.type === 'backspace' || action.type === 'deleteForward') {
      let from = Math.min(a.offset, f.offset), to = Math.max(a.offset, f.offset);
      if (a.block !== f.block) {
        if (action.type === 'insertText') throw new MissingCapabilityError('Cross-owner marked replacement requires a bound fragment selection policy');
        return this.paste([{ attributes: null, runs: [], containers: [] }]);
      }
      const text = action.type === 'insertText' ? action.text : '';
      if (typeof text !== 'string') throw new Error('Missing text');
      if (action.type !== 'insertText' && from === to) {
        const content = this.snapshot().blocks.find(b => b.id === a.block)!.text;
        const boundaries = [...new Intl.Segmenter('en', { granularity: 'grapheme' }).segment(content)].map(s => s.index).concat(content.length);
        const index = boundaries.indexOf(from);
        if (index < 0) return this.result('rejected', 0);
        if (action.type === 'backspace') { if (index === 0) return this.result('no-op', 0); from = boundaries[index - 1]; }
        else { if (index === boundaries.length - 1) return this.result('no-op', 0); to = boundaries[index + 1]; }
      }
      const commands: EditorCommand[] = [{ type: 'replaceAt', owner: this.id(a.block), from, to, text }];
      if (text.length) {
        const allowed = this.contextMarks();
        // Remove only inherited attributes that are absent from the requested set.
        const old = this.snapshot().blocks.find(b => b.id === a.block)!;
        const inherited = old.marks.filter(m => m.from < to && m.to > from || from === to && m.from <= from && from <= m.to).map(m => m.type);
        for (const name of new Set([...inherited, ...allowed])) commands.push({ type: 'markAt', owner: this.id(a.block), from, to: from + text.length, mark: name as MarkCommand['mark'], action: allowed.includes(name) ? 'apply' : 'remove' });
      }
      commands.push(this.resultSelection(this.collapsed(from + text.length)));
      return this.commit({ kind: 'editor', origin: 'local:rgs:text', commands });
    }
    throw new MissingCapabilityError(`Unsupported semantic action: ${action.type}`);
  }
  private applyBatch(action: Action): DriverResult {
    const operations = action.operations as Action[];
    if (!Array.isArray(operations)) throw new Error('Missing operations');
    const commands: EditorCommand[] = operations.map(op => {
      const owner = this.ids.get(op.block as string) ?? op.block as string; // Unknown IDs reach engine admission unchanged.
      if (op.type === 'insertText') return { type: 'replaceAt', owner, from: op.offset as number, to: op.offset as number, text: op.text! };
      if (op.type === 'replaceText') return { type: 'replaceAt', owner, from: op.from as number, to: op.to as number, text: op.text! };
      if (op.type === 'applyMark') return { type: 'markAt', owner, from: op.from as number, to: op.to as number, mark: op.mark as MarkCommand['mark'], action: 'apply' };
      throw new MissingCapabilityError(`Unbound batch operation: ${op.type}`);
    });
    const selection = action.resultSelection as Selection | undefined;
    if (selection) commands.push(this.resultSelection(selection));
    return this.commit({ kind: 'editor', origin: 'local:rgs:batch', commands }, selection?.affinity ?? this.selection.affinity);
  }
  private paste(blocks: FragmentBlock[], newIds?: string[]): DriverResult {
    const anchors = [this.selection.anchor, this.selection.focus].map(p => this.engine.anchor(this.id(p.block), p.offset, 'right'));
    let plan: ReturnType<EngineHandle['prepare']> | undefined, caret: ReturnType<EngineHandle['anchor']> | undefined;
    const before = this.frozen(); let events = 0; const subscription = this.engine.subscribe({ type: 'updates' }, () => events++);
    try {
      try { plan = this.engine.prepare({ kind: 'fragment', origin: 'local:rgs:fragment', range: { anchor: anchors[0], focus: anchors[1] }, blocks }); }
      catch { assert.deepEqual(this.frozen(), before); assert.equal(events, 0); return this.result('rejected', 0); }
      assert.deepEqual(this.frozen(), before); const result = this.engine.commit(plan); caret = result.caret;
      const created = this.engine.read().visible.filter(n => n.kind === 'block' && !before.snapshot.visible.some(old => old.id === n.id));
      if (created.length) {
        if (!newIds || newIds.length !== created.length) throw new Error('New fragment identities require an explicit alias binding');
        // Resulting ordered structural identities, never a search for expected text.
        created.forEach((node, index) => { assert.ok(!this.ids.has(newIds[index])); this.ids.set(newIds[index], node.id); });
      }
      const p = this.engine.resolve(caret ?? anchors[1]); assert.equal(p.type, 'position');
      if (p.type !== 'position') throw new Error('Fragment result did not resolve');
      const alias = [...this.ids].find(([, id]) => id === p.node)?.[0]; assert.ok(alias);
      this.selection = this.collapsed(p.offset, alias); assert.equal(events, 1);
      return this.result('applied', events);
    } finally { subscription.dispose(); if (plan) this.engine.releasePlan(plan); if (caret) this.engine.releaseAnchor(caret); anchors.forEach(a => this.engine.releaseAnchor(a)); }
  }
}
