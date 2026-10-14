import assert from 'node:assert/strict';
import { SemanticDriver, semanticProfile } from './semantic-adapter.ts';
import type { Action } from './fixture-loader.ts';
import type { DriverResult } from './driver.ts';

export const historyProfile = Object.freeze({ ...semanticProfile, name: 'rgs-history-v1', clock: 'caller monotonic milliseconds; 500ms native typing interval', origins: 'stable typing session; explicit paste/cut/outer command', capabilities: [...semanticProfile.capabilities, 'history-boundaries', 'fixed-clock'], actions: [...semanticProfile.actions, 'pasteText', 'cut', 'outerBold'] });

/** Real public text/history operations; no fixture expectations enter this port. */
export class HistoryDriver extends SemanticDriver {
  override act(action: Action): DriverResult {
    if (action.type === 'outerBold') {
      const entry = structuredClone(this.selection);
      const block = this.snapshot().blocks.find(b => b.id === entry.anchor.block)!;
      const before = this.frozen();
      // The outer transaction captures entry before a nested helper selects all.
      super.act({ type: 'setSelection', selection: { anchor: { block: block.id, offset: 0 }, focus: { block: block.id, offset: block.text.length }, affinity: entry.affinity } });
      const temporary = structuredClone(this.selection);
      const operation = { type: 'applyMark', block: block.id, from: temporary.anchor.offset, to: temporary.focus.offset, mark: 'bold' };
      this.selection = entry;
      assert.deepEqual(this.frozen(), before, 'temporary helper selection creates no history or content');
      this.engine.history({ type: 'explicit' });
      return super.act({ type: 'applyBatch', operations: [operation], resultSelection: entry });
    }
    if (!['insertText', 'pasteText', 'cut', 'outerBold'].includes(action.type)) return super.act(action);
    if (action.clockMs !== undefined) this.clock.advance(action.clockMs);
    const typing = action.type === 'insertText';
    this.engine.history(typing ? { type: 'typing', session: typeof action.session === 'number' ? action.session : 1, time_ms: this.clock.now } : { type: 'explicit' });
    const bias = this.selection.affinity === 'backward' ? 'left' : 'right';
    const tokens = [this.selection.anchor, this.selection.focus].map(p => this.engine.anchor(this.ids.get(p.block)!, p.offset, bias));
    const upper = this.selection.anchor.offset >= this.selection.focus.offset ? this.selection.anchor : this.selection.focus;
    const caret = this.engine.anchor(this.ids.get(upper.block)!, upper.offset, 'right');
    let plan: ReturnType<typeof this.engine.prepare> | undefined;
    let events = 0;
    const subscription = this.engine.subscribe({ type: 'updates' }, () => events++);
    const before = this.frozen();
    try {
      plan = this.engine.prepare({ kind: 'text', origin: typeof action.origin === 'string' ? action.origin : typing ? 'rgs:typing:1' : `rgs:${action.type}`, command: { type: 'replace', range: { anchor: tokens[0], focus: tokens[1] }, text: action.type === 'cut' ? '' : action.text! } });
      assert.deepEqual(this.frozen(), before, 'prepared history command is isolated');
      const result = this.engine.commit(plan);
      assert.equal(events, 1, 'one publication per accepted command');
      const at = this.engine.resolve(caret);
      assert.equal(at.type, 'position');
      if (at.type !== 'position') throw new Error('missing result caret');
      const block = [...this.ids].find(([, id]) => id === at.node)![0];
      this.selection = { anchor: { block, offset: at.offset }, focus: { block, offset: at.offset }, affinity: 'forward' };
      this.pendingMarks = null;
      return { outcome: 'applied', state: this.snapshot(), effects: { localCommits: events, remoteCommits: 0 }, revision: result.revision };
    } finally {
      subscription.dispose(); if (plan) this.engine.releasePlan(plan);
      for (const token of [...tokens, caret]) this.engine.releaseAnchor(token);
    }
  }
}
