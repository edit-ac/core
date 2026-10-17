import type { EngineHandle, StableRange, CommitResult, PlanToken } from '../engine.js';
import { AiHost, AiError, type AiRequest } from './ai.js';

export type AiSessionStatus = 'idle' | 'pending' | 'streaming' | 'review' | 'accepted' | 'rejected' | 'canceled' | 'failed' | 'stale' | 'disposed';
/** Owned capture. Host review ports must prepare before mutation and commit synchronously once. */
export interface AiReviewTarget {
  valid(): boolean;
  accept(text: string): CommitResult;
  dispose(): void;
}
/** Optional orchestration only. AiHost owns protocol validation, caps and abort propagation. */
export class AiSession {
  #generation = 0;
  #controller: AbortController | undefined;
  #target: AiReviewTarget | undefined;
  #status: AiSessionStatus = 'idle';
  #text = '';
  #error: string | undefined;
  #editable = false;
  get state(): Readonly<{ status: AiSessionStatus; text: string; error: string | undefined; generation: number }> {
    return Object.freeze({ status: this.#status, text: this.#text, error: this.#error, generation: this.#generation });
  }
  constructor(readonly host: AiHost) {}
  #release(): void { const target = this.#target; this.#target = undefined; target?.dispose(); }
  #stop(status: AiSessionStatus): void {
    ++this.#generation; this.#controller?.abort(); this.#controller = undefined;
    this.#release(); this.#status = status;
  }
  async start(request: AiRequest, target?: AiReviewTarget): Promise<void> {
    if (this.#status === 'disposed') { target?.dispose(); throw new Error('AI session disposed'); }
    this.#stop('pending'); this.#text = ''; this.#error = undefined; this.#target = target;
    const generation = this.#generation, controller = new AbortController(); this.#controller = controller;
    const operation = request.operation; this.#editable = operation !== 'ask'; // capture before any asynchronous host callback
    try {
      if (!target && operation !== 'ask') throw new Error('missing-target');
      if (target && !target.valid()) { this.#status = 'stale'; this.#release(); return; }
      for await (const event of this.host.send(request, controller.signal)) {
        if (generation !== this.#generation) return;
        if (this.#target && !this.#target.valid()) { this.#stop('stale'); return; }
        if (event.type === 'delta') { this.#text += event.text; this.#status = 'streaming'; }
        else if (event.type === 'error') throw new AiError(event.code);
        else {
          if (!this.#text.length) throw new AiError('invalid-response');
          this.#status = 'review';
        }
      }
      if (generation === this.#generation && this.#status !== 'review') throw new AiError('invalid-response');
    } catch (error) {
      if (generation !== this.#generation) return;
      this.#error = error instanceof AiError ? error.code : 'transport';
      this.#status = this.#error === 'canceled' ? 'canceled' : 'failed'; this.#release();
    } finally {
      controller.abort(); if (generation === this.#generation) this.#controller = undefined;
    }
  }
  accept(): CommitResult | undefined {
    if (this.#status !== 'review' || !this.#target || !this.#editable) return undefined; // answers never apply by default
    const target = this.#target; this.#target = undefined;
    try {
      if (!target.valid()) { this.#status = 'stale'; return undefined; }
      // Invalidate before entering host code: duplicate/reentrant acceptance cannot commit.
      this.#status = 'accepted'; ++this.#generation;
      return target.accept(this.#text);
    } catch { this.#status = 'stale'; return undefined; }
    finally { target.dispose(); }
  }
  cancel(): void { if (this.#status !== 'disposed') this.#stop('canceled'); }
  reject(): void { if (this.#status !== 'disposed') { this.#stop('rejected'); this.#text = ''; } }
  invalidate(): void { if (this.#status !== 'disposed') this.#stop('stale'); }
  /** Recovery is explicit and bounded by the admitted response cap; no automatic clipboard write. */
  recoveryCopy(): string { return this.#text; }
  dispose(): void { this.#stop('disposed'); this.#text = ''; }
}

/** Existing WASM anchors/prepared semantics, restricted to qualified plain-text blocks.
 * Context owners are checked in full (including marks/structure). Unrelated owners may rebase.
 * Call invalidate() on host permission/document switches; valid also rechecks permission at accept.
 */
export function captureAiTarget(engine: EngineHandle, range: StableRange, contextOwners: readonly string[], writable: () => boolean): AiReviewTarget {
  const initial = engine.read(), identity = JSON.stringify(initial.identity);
  const a = engine.resolve(range.anchor), f = engine.resolve(range.focus);
  if (a.type !== 'position' || f.type !== 'position' || a.node !== f.node) throw new Error('unsupported-ai-target');
  const ids = [...new Set([...contextOwners, a.node])];
  const projection = () => {
    const snapshot = engine.read();
    if (JSON.stringify(snapshot.identity) !== identity) throw new Error('stale');
    return JSON.stringify(ids.map(id => {
      const n = snapshot.visible.find(n => n.id === id);
      if (!n || n.kind !== 'block' || !Array.isArray(n.blockAttributes) || n.blockAttributes[0] !== 'paragraph') throw new Error('unsupported-ai-context');
      return n;
    }));
  };
  // Own independent anchor handles, never release the caller's selection handles.
  const anchor = engine.importAnchor(engine.exportAnchor(range.anchor));
  let focus;
  try { focus = engine.importAnchor(engine.exportAnchor(range.focus)); }
  catch (error) { engine.releaseAnchor(anchor); throw error; }
  const owned = { anchor, focus };
  let active = true, intact = true, baseline: string;
  let subscription;
  try { subscription = engine.subscribe({ type: 'nodes', ids }, patch => { if (patch.operation !== 'Selection') intact = false; }); }
  catch (error) { engine.releaseAnchor(owned.anchor); engine.releaseAnchor(owned.focus); throw error; }
  const dispose = () => { if (!active) return; active = false; subscription.dispose();
    for (const token of [owned.anchor, owned.focus]) { try { engine.releaseAnchor(token); } catch { /* engine disposal already released its handles */ } } };
  try { baseline = projection(); } catch (error) { dispose(); throw error; }
  const valid = () => {
    if (!active || !intact || !subscription.active) return false;
    try {
      if (!writable() || projection() !== baseline) return false;
      const start = engine.resolve(owned.anchor), end = engine.resolve(owned.focus);
      return start.type === 'position' && end.type === 'position' && start.node === a.node && end.node === a.node;
    } catch { return false; }
  };
  return {
    valid, dispose,
    accept(text) {
      if (!valid()) throw new Error('stale');
      let plan: PlanToken | undefined;
      try {
        const start = engine.resolve(owned.anchor), end = engine.resolve(owned.focus);
        if (start.type !== 'position' || end.type !== 'position') throw new Error('stale');
        const caret = Math.min(start.offset, end.offset) + text.length;
        plan = engine.prepare({ kind: 'editor', origin: 'ai:reviewed', commands: [
          { type: 'historySelectionAt', anchor: { owner: start.node, offset: start.offset, bias: start.bias }, focus: { owner: end.node, offset: end.offset, bias: end.bias } },
          { type: 'replace', range: owned, text },
          { type: 'selectionAt', anchor: { owner: start.node, offset: caret, bias: 'right' }, focus: { owner: start.node, offset: caret, bias: 'left' } },
        ] });
        if (!valid()) throw new Error('stale');
        engine.history({ type: 'boundary' });
        const consumed = plan; plan = undefined;
        const result = engine.commit(consumed);
        // An observer may dispose the editor after commit. Preserve the committed result.
        try { engine.history({ type: 'boundary' }); } catch { /* post-commit teardown */ }
        return result;
      } finally { if (plan) engine.releasePlan(plan); }
    },
  };
}
