import type { StableRange, CommitResult } from '@edit-ac/core';
import { AiHost, AiSession, captureAiTarget } from '@edit-ac/core/extensions';
import { SlashPresenter, type SlashContext, type SlashFactory } from '../../modules/slash.js';

export interface AiCompletionOptions {
  /** Explicit per-editor opt-in. Host admission is also mandatory. */
  enabled?: boolean;
  debounceMs: number;
  contextBytes: number;
  outputBytes: number;
  acceptKey?: 'Tab' | 'Enter' | false;
  attached?(completion: AiCompletion): void;
}
let sequence = 0;
const bytes = (s: string) => new TextEncoder().encode(s).length;
/** Transient presentation only: the editable tree and semantic state never contain ghost text. */
export class AiCompletion {
  readonly element: HTMLElement;
  readonly ghost: HTMLElement;
  readonly status: HTMLElement;
  readonly session: AiSession;
  private range: StableRange | undefined;
  private guard: ReturnType<typeof captureAiTarget> | undefined;
  private signature = '';
  private timer: ReturnType<typeof setTimeout> | undefined;
  private listeners: (() => void)[] = [];
  private subscription: { dispose(): void } | undefined;
  private disposed = false;
  private readOnly = false;
  private composing = false;
  private dictating = false;
  private selecting = false;
  private enabled: boolean;
  private accepting = false;
  private acceptButton: HTMLButtonElement;
  constructor(readonly context: SlashContext, readonly host: AiHost, readonly options: AiCompletionOptions) {
    if (!Number.isSafeInteger(options.debounceMs) || options.debounceMs < 0 || options.debounceMs > 10000 ||
        !Number.isSafeInteger(options.contextBytes) || options.contextBytes < 1 || options.contextBytes > 32768 ||
        !Number.isSafeInteger(options.outputBytes) || options.outputBytes < 1 || options.outputBytes > 1024 ||
        ![undefined, false, 'Tab', 'Enter'].includes(options.acceptKey)) throw Error('Invalid completion configuration');
    this.options = Object.freeze({ ...options }); options = this.options;
    this.enabled = options.enabled === true; this.session = new AiSession(host);
    const { root } = context, doc = root.ownerDocument;
    this.element = doc.createElement('section'); this.element.dataset.editacUi = ''; this.element.setAttribute('aria-label', 'Writing completion');
    this.ghost = doc.createElement('span'); this.ghost.setAttribute('aria-hidden', 'true');
    Object.assign(this.ghost.style, { position: 'fixed', whiteSpace: 'pre-wrap', pointerEvents: 'none', userSelect: 'none', opacity: '0.55', maxWidth: '24em', maxHeight: '8em', overflow: 'hidden' });
    this.status = doc.createElement('p'); this.status.setAttribute('role', 'status'); this.status.setAttribute('aria-live', 'polite'); this.status.setAttribute('aria-atomic', 'true');
    const button = (label: string, action: () => void) => { const b = doc.createElement('button'); b.type = 'button'; b.textContent = label;
      this.listen(b, 'pointerdown', e => e.preventDefault()); this.listen(b, 'click', action); this.element.append(b); return b; };
    button('Suggest writing', () => { void this.complete(); });
    this.acceptButton = button('Accept completion', () => this.accept()); button('Dismiss completion', () => this.dismiss());
    this.element.append(this.status, this.ghost); root.after(this.element);
    this.listen(root, 'keydown', e => {
      const event = e as KeyboardEvent;
      if (event.isComposing || this.composing || event.altKey || event.ctrlKey || event.metaKey || event.shiftKey) return;
      if (event.key === 'Escape') { this.dismiss(); return; }
      if (event.key === (options.acceptKey === undefined ? 'Tab' : options.acceptKey) && this.applicable()) {
        event.preventDefault(); event.stopImmediatePropagation(); this.accept();
      }
    }, true);
    this.listen(root, 'keyup', e => {
      const key = e as KeyboardEvent;
      if (!key.isComposing && !key.ctrlKey && !key.metaKey && !key.altKey && (key.key.length === 1 || key.key === 'Backspace' || key.key === 'Delete')) this.schedule();
    });
    this.listen(root, 'compositionstart', () => { this.composing = true; this.dismiss(); });
    this.listen(root, 'compositionend', () => { this.composing = false; this.schedule(); });
    this.listen(root, 'beforeinput', e => {
      const input = e as InputEvent;
      if (input.isComposing) { this.composing = true; this.dismiss(); return; }
      // The real input middleware may prevent the native input event after committing.
      // Schedule after that synchronous commit, never from remote engine patches.
      queueMicrotask(() => this.schedule());
    }, true);
    this.listen(root, 'input', () => this.schedule());
    this.listen(root, 'pointerdown', () => { this.selecting = true; this.dismiss(); });
    this.listen(doc, 'pointerup', () => { this.selecting = false; });
    this.listen(doc, 'selectionchange', () => {
      if (this.range && this.currentSignature() !== this.signature) this.dismiss();
    });
    this.listen(doc, 'focusin', () => { if (doc.activeElement !== root && !this.element.contains(doc.activeElement)) this.dismiss(); });
    this.listen(root, 'focusout', () => queueMicrotask(() => { if (doc.activeElement !== root && !this.element.contains(doc.activeElement)) this.dismiss(); }));
    this.listen(doc.defaultView!, 'resize', () => this.render());
    this.listen(doc, 'scroll', () => this.render(), true);
    this.render();
  }
  private listen(target: EventTarget, name: string, fn: (event: Event) => void, capture = false): void {
    target.addEventListener(name, fn, capture); this.listeners.push(() => target.removeEventListener(name, fn, capture));
  }
  private writable(): boolean {
    if (!this.enabled || this.disposed || this.readOnly || this.composing || this.dictating || this.selecting ||
        this.context.root.getAttribute('aria-readonly') === 'true' || this.host.availability !== 'ready') return false;
    try { const policy = this.host.policy(); return policy.allowRemote && !policy.protectedDocument; } catch { return false; }
  }
  private currentSignature(): string {
    const selection = this.context.selection.retain();
    if (!selection) return '';
    try { const e = this.context.engine, a = e.resolve(selection.range.anchor), f = e.resolve(selection.range.focus);
      return a.type === 'position' && f.type === 'position' && a.node === f.node && a.offset === f.offset ? `${a.node}:${a.offset}` : '';
    } finally { selection.dispose(); }
  }
  private release(): void {
    this.subscription?.dispose(); this.subscription = undefined;
    this.guard?.dispose(); this.guard = undefined;
    if (this.range) for (const token of [this.range.anchor, this.range.focus]) this.context.engine.releaseAnchor(token);
    this.range = undefined; this.signature = '';
  }
  dismiss(): void {
    if (this.timer !== undefined) clearTimeout(this.timer); this.timer = undefined;
    if (!this.disposed) this.session.reject(); this.release(); this.render();
  }
  /** Host document/permission transitions invalidate the captured request. */
  invalidate(): void { this.dismiss(); }
  private schedule(): void {
    this.dismiss(); if (!this.writable() || this.context.root.ownerDocument.activeElement !== this.context.root) return;
    this.timer = setTimeout(() => { this.timer = undefined; void this.complete(); }, this.options.debounceMs);
  }
  /** Host dictation/marked-text lifecycle, when not exposed as DOM composition. */
  setDictating(value: boolean): void { this.dictating = value; if (value) this.dismiss(); }
  setEnabled(value: boolean): void { this.enabled = value; if (!value) this.dismiss(); this.render(); }
  setReadOnly(value: boolean): void { this.readOnly = value; if (value) this.dismiss(); this.render(); }
  async complete(): Promise<void> {
    this.dismiss(); if (!this.writable()) return;
    const selection = this.context.selection.retain(); if (!selection) return;
    try {
      const e = this.context.engine, a = e.resolve(selection.range.anchor), f = e.resolve(selection.range.focus);
      if (a.type !== 'position' || f.type !== 'position' || a.node !== f.node || a.offset !== f.offset) return;
      const node = e.read().visible.find(n => n.id === a.node);
      if (!node || node.kind !== 'block' || !Array.isArray(node.blockAttributes) || node.blockAttributes[0] !== 'paragraph' || node.runs.some(r => r.text.includes('\uFFFC') || r.attributes.code || Object.keys(r.attributes).some(key => key.startsWith('module:')))) return;
      const text = node.runs.map(r => r.text).join('').slice(0, a.offset);
      if (bytes(text) > this.options.contextBytes) { this.status.textContent = 'Completion unavailable: context limit'; return; }
      this.range = { anchor: e.importAnchor(e.exportAnchor(selection.range.anchor)), focus: e.importAnchor(e.exportAnchor(selection.range.focus)) };
      this.signature = `${a.node}:${a.offset}`;
      this.guard = captureAiTarget(e, this.range, [a.node], () => this.writable());
      this.subscription = e.subscribe({ type: 'nodes', ids: [a.node] }, patch => {
        if (patch.operation !== 'Selection' && !this.accepting) this.dismiss();
      });
      const range = this.range, guard = this.guard;
      const target = { valid: () => guard.valid(), dispose() {}, accept: (output: string): CommitResult => {
        if (!guard.valid()) throw Error('stale');
        const start = e.resolve(range.anchor); if (start.type !== 'position') throw Error('stale');
        const offset = start.offset + output.length;
        this.accepting = true; e.history({ type: 'boundary' });
        try { return this.context.commit({ kind: 'editor', origin: 'ai:reviewed', commands: [
          { type: 'historySelectionAt', anchor: { owner: start.node, offset: start.offset, bias: start.bias }, focus: { owner: start.node, offset: start.offset, bias: start.bias } },
          { type: 'replace', range, text: output },
          { type: 'selectionAt', anchor: { owner: start.node, offset, bias: 'right' }, focus: { owner: start.node, offset, bias: 'left' } },
        ] }); } finally { this.accepting = false; try { e.history({ type: 'boundary' }); } catch { /* observer may dispose after the successful commit */ } }
      } };
      const pending = this.session.start({ version: 1, requestId: `completion-${++sequence}`, operation: 'completion', scope: 'passage', instruction: 'Continue the passage with a short plain-text insertion only.', context: text, format: 'plain-text', outputBytes: this.options.outputBytes }, target);
      this.render(); await pending;
      if (!this.disposed && this.guard === guard) { if (!guard.valid()) this.session.reject(); this.render(); }
    } catch { this.dismiss(); this.status.textContent = 'Completion unavailable'; }
    finally { selection.dispose(); }
  }
  private applicable(): boolean { return this.session.state.status === 'review' && !!this.session.state.text && this.writable() && !!this.guard?.valid() && this.currentSignature() === this.signature; }
  accept(): void {
    if (!this.applicable()) { this.dismiss(); return; }
    const result = this.session.accept();
    try { if (result) { this.context.root.focus(); if (result.selection) this.context.selection.restoreRange(result.selection); else if (result.caret) this.context.selection.move(result.caret); } }
    finally { if (result?.caret) this.context.engine.releaseAnchor(result.caret); if (result?.selection) for (const t of [result.selection.anchor, result.selection.focus]) this.context.engine.releaseAnchor(t); this.release(); this.render(); }
  }
  private render(): void {
    if (this.disposed) return;
    const show = this.applicable(); this.ghost.hidden = !show; this.ghost.textContent = show ? this.session.state.text : ''; this.acceptButton.disabled = !show;
    const selection = this.context.root.ownerDocument.getSelection();
    if (show && selection?.rangeCount) { const rect = selection.getRangeAt(0).getBoundingClientRect(); this.ghost.style.left = `${rect.right}px`; this.ghost.style.top = `${rect.top}px`; }
    this.status.textContent = show ? `Suggestion: ${this.session.state.text}` : !this.enabled ? 'Completion disabled' : this.host.availability !== 'ready' ? 'Configure host quota, context and transport' : this.session.state.status;
  }
  dispose(): void { if (this.disposed) return; this.dismiss(); this.session.dispose(); this.disposed = true; this.subscription?.dispose(); for (const remove of this.listeners) remove(); this.listeners = []; this.element.remove(); }
}
/** Optional lifecycle composition through the existing indexed presenter port. */
export function aiCompletion(host: AiHost, options: AiCompletionOptions): SlashFactory {
  return context => {
    const presenter = new SlashPresenter(context, [], false);
    let completion!: AiCompletion;
    try { completion = new AiCompletion(context, host, options); options.attached?.(completion); }
    catch (error) { completion?.dispose(); presenter.dispose(); throw error; }
    const dispose = presenter.dispose.bind(presenter), readOnly = presenter.setReadOnly.bind(presenter);
    presenter.dispose = () => { completion.dispose(); dispose(); };
    presenter.setReadOnly = value => { completion.setReadOnly(value); readOnly(value); };
    return presenter;
  };
}
