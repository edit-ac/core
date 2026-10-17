import type { EngineHandle, StableRange } from '@edit-ac/core';
import type { DOMRenderer } from '../dom/render.js';
import type { DOMSelection, RetainedSelection, ModelPoint } from '../dom/selection.js';
import type { TextIntent } from './text.js';
import { captureComposingBlock, type NativeRecovery } from './reconcile.js';

interface Hooks {
  begin(): TextIntent;
  content(node: string): string | undefined;
  apply(intent: TextIntent, range: StableRange, text: string, moveCaret?: boolean): void;
  recovery(intent: TextIntent, value: NativeRecovery): void;
  preserve(intent: TextIntent, value: NativeRecovery): void;
  drain(): void;
}
interface Session {
  intent: TextIntent;
  target?: RetainedSelection;
  node?: string;
  before: string;
  start: number;
  end: number;
  selected: string;
}

/** Local composition lifecycle, called by TextInput's sole event/observer owner.
 * Native DOM and selection remain temporary until one stable-range final commit.
 * Prepared browser mechanics qualify this policy; OS IME support is separate.
 */
export class CompositionInput {
  #session: Session | undefined;
  #commitKeyOwner: TextIntent | undefined;
  #keyHeld = false;
  #terminal: TextIntent | undefined;
  #boundary: MessageChannel | undefined;
  readonly #renderer: DOMRenderer;
  readonly #selection: DOMSelection;
  readonly #engine: EngineHandle;
  readonly #hooks: Hooks;
  constructor(renderer: DOMRenderer, selection: DOMSelection,
    engine: EngineHandle, hooks: Hooks) {
    this.#renderer = renderer;
    this.#selection = selection;
    this.#engine = engine;
    this.#hooks = hooks;}
  get active(): boolean { return !!this.#session; }
  get owner(): TextIntent | undefined { return this.#session?.intent; }

  handle(event: Event, readOnly: boolean): TextIntent | undefined {
    const input = event as InputEvent, key = event as KeyboardEvent;
    if (event.type === 'compositionstart') {
      if (this.#session) this.finish('cancel');
      this.#releaseCommitKey(); this.#terminal = undefined;
      const intent = this.#hooks.begin();
      this.#session = { intent, before: '', start: 0, end: 0, selected: '' };
      const target = this.#selection.retain();
      if (readOnly || !target) {
        intent.disposition = 'rejected'; intent.reason = readOnly ? 'read-only' : 'unmapped-selection'; target?.dispose(); return intent;
      }
      const a = this.#engine.resolve(target.range.anchor), b = this.#engine.resolve(target.range.focus);
      if (a.type !== 'position' || b.type !== 'position' || a.node !== b.node) {
        intent.disposition = 'rejected'; intent.reason = 'unsupported-composition-range'; target.dispose(); return intent;
      }
      const before = this.#hooks.content(a.node);
      if (before === undefined || before.length > 256 * 1024) {
        intent.disposition = 'rejected'; intent.reason = 'native-limit'; target.dispose(); return intent;
      }
      const start = Math.min(a.offset, b.offset), end = Math.max(a.offset, b.offset);
      this.#session = { intent, target, node: a.node, before, start, end, selected: before.slice(start, end) };
      this.#selection.suspended = true; this.#renderer.hold(a.node);
      return intent;
    }
    if (event.type === 'compositionend') {
      const owner = this.#session?.intent ?? this.#terminal;
      if (this.#session) {
        this.finish((event as CompositionEvent).data === '' ? 'cancel' : 'final');
        this.#commitKeyOwner = owner;
        this.#dispatchBoundary();
      }
      return owner;
    }
    if (event.type === 'keyup' && (this.#commitKeyOwner || this.#session)) {
      const owner = this.#session?.intent ?? this.#commitKeyOwner; this.#releaseCommitKey(); return owner;
    }
    if (event.type === 'keydown' && key.key === 'Enter' && (this.#session || this.#commitKeyOwner)) {
      event.preventDefault(); this.#keyHeld = true;
      return this.#session?.intent ?? this.#commitKeyOwner;
    }
    if (event.type === 'beforeinput' && this.#commitKeyOwner && ['insertParagraph', 'insertLineBreak'].includes(input.inputType)) {
      if (event.cancelable) event.preventDefault(); return this.#commitKeyOwner;
    }
    if (!this.#session) {
      if (this.#terminal && ['beforeinput', 'input'].includes(event.type) && ['insertFromComposition', 'insertCompositionText', 'deleteCompositionText'].includes(input.inputType)) {
        if (event.type === 'beforeinput' && event.cancelable) event.preventDefault(); return this.#terminal;
      }
      return undefined;
    }
    const owner = this.#session.intent;
    if (event.type === 'blur') this.finish('blur');
    // Composition notifications, final input before end, and commit keys share
    // one session owner. They never enter ordinary input reconciliation.
    if (owner.disposition === 'rejected' && event.type === 'beforeinput' && event.cancelable) event.preventDefault();
    return owner;
  }

  finish(mode: 'final' | 'cancel' | 'blur' | 'readonly' | 'dispose'): void {
    const session = this.#session;
    if (!session) return;
    const { intent, target, node } = session;
    let projected = false;
    try {
      // Drain while the session still owns native observer records.
      this.#hooks.drain();
      if (!target || !node) return;
      const captured = captureComposingBlock(this.#renderer, node);
      const prefix = session.before.slice(0, session.start), suffix = session.before.slice(session.end);
      const valid = captured.text.startsWith(prefix) && captured.text.endsWith(suffix) && captured.text.length >= prefix.length + suffix.length;
      const text = valid ? captured.text.slice(prefix.length, captured.text.length - suffix.length) : captured.text;
      intent.text = text;
      if ((mode === 'dispose' || mode === 'readonly') && text !== session.selected && text) {
        this.#hooks.preserve(intent, { node, text, truncated: captured.truncated, reason: `composition-${mode}` });
      }
      if (mode === 'dispose') { intent.disposition = 'disposed'; return; }
      if (mode === 'cancel' || mode === 'readonly') { intent.disposition = 'canceled'; return; }
      if (captured.reason || !valid) {
        this.#hooks.recovery(intent, { ...captured, reason: captured.reason || 'unsupported-composition-shape' }); return;
      }
      const a = this.#engine.resolve(target.range.anchor), b = this.#engine.resolve(target.range.focus);
      // A retained range must still belong to the original composing block.
      // Never redirect recovery text to a surviving neighbouring owner.
      if (a.type !== 'position' || b.type !== 'position' || a.node !== node || b.node !== node) {
        this.#hooks.recovery(intent, { reason: 'stale-target', node, text, truncated: false }); return;
      }
      if (this.#hooks.content(a.node)?.slice(Math.min(a.offset, b.offset), Math.max(a.offset, b.offset)) !== session.selected) {
        this.#hooks.recovery(intent, { reason: 'remote-overlap', node, text, truncated: false }); return;
      }
      if (text === session.selected) { intent.disposition = 'canceled'; return; }
      // Restore canonical mapping only at the finalization boundary. The engine
      // receives one prepared replace and one intentionally separate undo group.
      let destination: { anchor: ModelPoint; focus: ModelPoint } | undefined;
      const native = this.#renderer.root.ownerDocument.getSelection();
      // The composing block's map is temporary, but a pointer destination in a
      // different mapped block remains canonical. It is view state, never a new
      // semantic target for the buffered composing text.
      if (native?.anchorNode && native.focusNode && this.#renderer.getNodeId(native.anchorNode) !== node && this.#renderer.getNodeId(native.focusNode) !== node) {
        const anchor = this.#selection.toModel(native.anchorNode, native.anchorOffset);
        const focus = this.#selection.toModel(native.focusNode, native.focusOffset);
        if (anchor && focus) destination = { anchor, focus };
      }
      this.#renderer.resume(node, true); projected = true; this.#selection.suspended = false;
      // Native selection placement can itself focus contenteditable. During a
      // real blur the document is between focus targets; don't interrupt that
      // transition while committing the captured text.
      const moveCaret = mode !== 'blur' || this.#renderer.root.ownerDocument.activeElement === this.#renderer.root;
      this.#hooks.apply(intent, target.range, text, moveCaret);
      if (intent.disposition === 'rejected') this.#hooks.recovery(intent, { reason: intent.reason ?? 'composition-commit-failed', node, text, truncated: false });
      else if (intent.disposition === 'committed' && moveCaret && destination && this.#selection.place(destination.anchor, destination.focus)) {
        this.#selection.capture({ anchor: destination.anchor.bias, focus: destination.focus.bias });
      }
    } finally {
      if (node && !projected) this.#renderer.resume(node, true);
      this.#selection.suspended = false;
      if (intent.disposition === 'rejected') {
        const native = this.#renderer.root.ownerDocument.getSelection();
        if (native?.anchorNode && (this.#renderer.root.contains(native.anchorNode) || this.#renderer.getNodeId(native.anchorNode))) native.removeAllRanges();
        this.#selection.clear();
      } else if (intent.disposition !== 'committed') this.#selection.restore();
      target?.dispose(); this.#terminal = intent; this.#session = undefined;
    }
  }

  #dispatchBoundary(): void {
    this.#boundary?.port1.close(); this.#boundary?.port2.close();
    const channel = new MessageChannel(); this.#boundary = channel;
    channel.port1.onmessage = () => {
      channel.port1.close(); channel.port2.close();
      if (this.#boundary !== channel) return;
      this.#boundary = undefined;
      if (!this.#keyHeld) this.#commitKeyOwner = undefined;
    };
    channel.port2.postMessage(null);
  }
  #releaseCommitKey(): void {
    this.#boundary?.port1.close(); this.#boundary?.port2.close(); this.#boundary = undefined;
    this.#commitKeyOwner = undefined; this.#keyHeld = false;
  }
  dispose(): void { this.#releaseCommitKey(); this.#terminal = undefined; }
}
