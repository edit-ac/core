import { inputTextDiagnostic } from './characters.js';
import { TextDrag } from './drag.js';
import { errorMessage } from '../errors.js';
import type { AnchorToken, CommitResult, EngineHandle, PatchSubscription, PrepareRequest, StableRange, EditorPosition, EditorCommand } from '@edit-ac/core';
import type { DOMRenderer } from '../dom/render.js';
import type { DOMSelection } from '../dom/selection.js';
import { literalShortcuts, type TypingShortcutAdapter } from './shortcuts.js';
import { KeyboardInput } from './keyboard.js';
import { CompositionInput } from './composition.js';
import { reconcileMutation, type NativeRecovery } from './reconcile.js';
import { ClipboardInput, validateClipboardCodecs, type ClipboardCodec } from '../clipboard/fragment.js';

export interface TextIntent {
  id: string;
  generation: number;
  origin: 'key' | 'beforeinput' | 'native' | 'composition';
  disposition: 'native-pending' | 'committed' | 'handled' | 'rejected' | 'disposed' | 'canceled';
  reason?: string;
  text?: string;
}
interface Trace { type: string; trusted: boolean; generation: number; intent?: string; count?: number; inputType?: string; cancelable?: boolean }
interface NativeEdit { intent: TextIntent; node: string; before: string; range: StableRange; text: string; captured: string; caret?: { anchor: number; focus: number } }
let editorSequence = 0;
const ordinary = new Set(['insertText', 'insertReplacementText', 'deleteContentBackward', 'deleteContentForward', 'deleteWordBackward', 'deleteWordForward', 'deleteSoftLineBackward', 'deleteSoftLineForward', 'deleteHardLineBackward', 'deleteHardLineForward']);

/** Ordinary input adapter. Rust owns every committed edit; DOM text is read only
 * for a bounded native intent in one mapped text block. Unsupported mutations
 * retain explicit recovery text; composition and structural commands have separate owners.
 * Construct after renderer/selection and commit through attached local storage.
 */
export class TextInput {
  readonly intents: TextIntent[] = [];
  readonly trace: Trace[] = [];
  readonly recovery: (NativeRecovery & { intent: string; generation: number })[] = [];
  readonly #scope: string;
  readonly #content = new Map<string, string>();
  readonly #subscription: PatchSubscription;
  readonly #observer: MutationObserver;
  readonly #events = new WeakMap<Event, TextIntent>();
  readonly #entrySelections = new WeakMap<TextIntent, { anchor: EditorPosition; focus: EditorPosition }>();
  readonly #listeners: [string, EventListener][] = [];
  shortcuts: TypingShortcutAdapter;
  references: import('../modules/references.js').ReferencePresenter | undefined;
  reorder: import('../modules/reorder.js').ReorderPresenter | undefined;
  slash: import('../modules/slash.js').SlashPresenter | undefined;
  #eligibleKey = false;
  #directKey: string | undefined;
  #sequence = 0;
  #generation = 1;
  #disposed = false;
  #readOnly = false;
  readonly #composition: CompositionInput;
  readonly keyboard: KeyboardInput;
  readonly clipboard: ClipboardInput;
  readonly textDrag: TextDrag;
  #rendering = false;
  #queued = false;
  #key: TextIntent | undefined;
  #pending: TextIntent | undefined;
  #jobs: NativeEdit[] = [];
  #suspended = false;
  #requestedReadOnly = false;
  get suspended(): boolean { return this.#suspended; }
  suspend(): void {
    if (this.#disposed || this.#suspended) return;
    // Finalize already observed native input while the original owner is live.
    this.#flushNative(); this.#composition.finish('blur');
    this.#key = undefined; this.#pending = undefined;
    this.#eligibleKey = false; this.#directKey = undefined;
    this.#suspended = true; this.#generation++;
    this.#selection.pointer.cancel();
    this.#applyReadOnly(true);
  }
  resume(): void {
    if (this.#disposed || !this.#suspended) return;
    this.#suspended = false; this.#applyReadOnly(this.#requestedReadOnly);
  }

  readonly #renderer: DOMRenderer;
  readonly #selection: DOMSelection;
  readonly #engine: EngineHandle;
  readonly #commit: (request: PrepareRequest) => CommitResult;
  constructor(renderer: DOMRenderer, selection: DOMSelection,
    engine: EngineHandle, commit: (request: PrepareRequest) => CommitResult, clipboardCodecs: readonly ClipboardCodec[] = []) {
    this.#renderer = renderer;
    this.#selection = selection;
    this.#engine = engine;
    this.#commit = commit;
    validateClipboardCodecs(clipboardCodecs);
    if (renderer.patchBoundary) throw new Error('Input owner already attached');
    const snapshot = engine.read();
    this.#scope = `${snapshot.identity.documentId}/${snapshot.identity.epoch}/${++editorSequence}`;
    for (const node of snapshot.visible) this.#content.set(node.id, node.runs.map(run => run.text).join(''));
    this.#readOnly = renderer.root.contentEditable === 'false';
    this.#subscription = engine.subscribe({ type: 'all' }, patch => {
      for (const change of patch.nodes) {
        if (change.type === 'visible') this.#content.set(change.node.id, change.node.runs.map(run => run.text).join(''));
        else this.#content.delete(change.type === 'removed' ? change.id : change.node.id);
      }
    });
    this.#composition = new CompositionInput(renderer, selection, engine, {
      begin: () => {
        this.#flushNative();
        const intent = this.#key?.disposition === 'native-pending' ? this.#key : this.#pending?.disposition === 'native-pending' ? this.#pending : this.#create('composition');
        intent.origin = 'composition'; this.#pending = intent; return intent;
      },
      content: node => this.#content.get(node),
      apply: (intent, range, text, moveCaret) => this.#apply(intent, range, text, undefined, moveCaret),
      recovery: (intent, value) => this.#recover(intent, value),
      preserve: (intent, value) => this.#preserve(intent, value),
      drain: () => this.#mutations(this.#observer.takeRecords())
    });
    this.shortcuts = literalShortcuts();
    this.keyboard = new KeyboardInput(renderer, selection, engine, commit, () => this.#readOnly || this.#disposed || this.#composition.active);
    this.clipboard = new ClipboardInput(renderer, selection, engine, commit, () => this.#readOnly || this.#disposed || this.#composition.active, clipboardCodecs);
    this.textDrag = new TextDrag(renderer, selection, engine, commit, () => this.#readOnly || this.#disposed || this.#composition.active);
    this.#observer = new MutationObserver(records => this.#mutations(records));
    this.#observer.observe(renderer.root, { subtree: true, childList: true, characterData: true });
    renderer.patchBoundary = {
      before: () => { this.#mutations(this.#observer.takeRecords()); this.#rendering = true; },
      after: () => {
        const records = this.#observer.takeRecords();
        if (records.length) this.#record({ type: 'renderer-echo', trusted: false, generation: this.#generation, count: records.length });
        this.#rendering = false;
      }
    };
    for (const type of ['keydown', 'keyup', 'beforeinput', 'input', 'compositionstart', 'compositionupdate', 'compositionend', 'blur', 'copy', 'cut', 'paste', 'drop']) {
      const listener: EventListener = event => this.#handle(event);
      this.#listeners.push([type, listener]); renderer.root.addEventListener(type, listener);
    }
  }
  #create(origin: TextIntent['origin']): TextIntent {
    const intent: TextIntent = { id: `${this.#scope}/${this.#generation}/${++this.#sequence}`, generation: this.#generation, origin, disposition: 'native-pending' };
    // Capture the user selection before native word/line deletion supplies a
    // wider affected range. History owns both entry and result bookmarks.
    const native = this.#renderer.root.ownerDocument.getSelection();
    if ((origin === 'key' || origin === 'beforeinput') && native?.anchorNode && native.focusNode) {
      const a = this.#selection.toModel(native.anchorNode, native.anchorOffset);
      const b = this.#selection.toModel(native.focusNode, native.focusOffset);
      if (a && b) this.#entrySelections.set(intent, {
        anchor: { owner: a.node, offset: a.offset, bias: a.bias },
        focus: { owner: b.node, offset: b.offset, bias: b.bias },
      });
    }
    this.intents.push(intent); if (this.intents.length > 128) this.intents.shift(); return intent;
  }
  #record(trace: Trace): void { this.trace.push(trace); if (this.trace.length > 256) this.trace.shift(); }
  #reject(intent: TextIntent, reason: string): void { intent.disposition = 'rejected'; intent.reason = reason; }
  #recover(intent: TextIntent, recovery: NativeRecovery): void {
    this.#reject(intent, recovery.reason); intent.text = recovery.text;
    this.#preserve(intent, recovery);
  }
  #preserve(intent: TextIntent, recovery: NativeRecovery): void {
    this.recovery.push({ ...recovery, intent: intent.id, generation: intent.generation });
    if (this.recovery.length > 32) this.recovery.shift();
  }
  #handle(event: Event, routedFromPopup = false): void {
    if (this.#disposed) return;
    const eventTarget=event.target as Element | null;
    // An observed key keeps its original popup target after focus restoration.
    // Only an explicit route from this surface's own popup may cross that boundary.
    const ownedPopup = routedFromPopup && event.type === 'keydown' && !event.defaultPrevented &&
      this.#renderer.root.ownerDocument.activeElement === this.#renderer.root &&
      (!!this.slash?.menu.contains(eventTarget) || !!this.references?.menu.contains(eventTarget));
    if (eventTarget !== this.#renderer.root && !ownedPopup) {
      if (eventTarget?.closest?.('input, textarea, select, button')) return;
      const editable = eventTarget?.closest?.<HTMLElement>('[contenteditable]');
      if (editable !== this.#renderer.root) {
        const owner = editable && this.#renderer.getNodeId(editable);
        // WebKit may target an edge atom for copy/beforeinput after Select All.
        // An actual presenter boundary belongs to this focused surface; foreign
        // editors and native controls retain their own event ownership.
        if (!owner || this.#renderer.getBlock(owner) !== editable || editable.contentEditable !== 'false' || this.#renderer.root.ownerDocument.activeElement !== this.#renderer.root) return;
      }
    }
    this.textDrag.beforeEvent(event);
    this.#flushNative();
    // A host capture listener may cancel native input before this surface sees
    // it. Do not turn that canceled delivery into a new semantic command.
    if (event.type === 'beforeinput' && event.defaultPrevented) return;
    if (['paste','cut','drop','compositionstart','compositionend','blur','keyup'].includes(event.type)) this.codeCommands?.handle(event);
    if (['compositionstart', 'paste', 'cut', 'beforeinput'].includes(event.type)) { this.slash?.handle(event); this.references?.handle(event); }
    const historyAction = this.#composition.active &&
      (event.type === 'beforeinput' && ['historyUndo', 'historyRedo'].includes((event as InputEvent).inputType) ||
        event.type === 'keydown' && ['z', 'y'].includes((event as KeyboardEvent).key.toLowerCase()))
      ? this.keyboard.action(event) : undefined;
    if (this.#composition.active && (['paste', 'cut', 'drop'].includes(event.type) ||
      historyAction === 'undo' || historyAction === 'redo')) {
      const owner = this.#composition.owner;
      this.#composition.finish(historyAction ? 'cancel' : 'blur');
      if (this.#key === owner) this.#key = undefined;
      if (this.#pending === owner) this.#pending = undefined;
    }
    if (this.textDrag.handle(event)) return;
    if (this.clipboard.handle(event)) return;
    const input = event as InputEvent, key = event as KeyboardEvent;
    const trace: Trace = { type: event.type, trusted: event.isTrusted, generation: this.#generation, inputType: input.inputType, cancelable: event.cancelable };
    this.#record(trace);
    if(['keyup','blur','compositionstart'].includes(event.type)){this.#eligibleKey=false;this.#directKey=undefined;}
    const owned = this.#events.get(event);
    if (owned) { trace.intent = owned.id; if (event.type === 'beforeinput' && event.cancelable && owned.disposition !== 'native-pending') event.preventDefault(); return; }
    const compositionOwner = this.#composition.handle(event, this.#readOnly);
    if (compositionOwner) {
      if (event.type === 'compositionstart' || event.type === 'keydown' || event.type === 'beforeinput') this.keyboard.resetFocusEscape();
      this.#events.set(event, compositionOwner); trace.intent = compositionOwner.id;
      // The composition lifecycle owns its final notifications and commit key.
      // Release ordinary routing references at its terminal boundary, even when
      // an IME does not deliver keyup, so later non-keyboard input is independent.
      if (event.type === 'keyup' || compositionOwner.disposition !== 'native-pending') {
        if (this.#key === compositionOwner) this.#key = undefined;
      }
      if (compositionOwner.disposition !== 'native-pending' && this.#pending === compositionOwner) this.#pending = undefined;
      return;
    }
    if (input.isComposing || key.isComposing) {
      if (event.type === 'keydown' || event.type === 'beforeinput') this.keyboard.resetFocusEscape();
      if (event.type === 'beforeinput') {
        const intent = this.#key ?? this.#create('beforeinput');
        this.#pending = intent; this.#events.set(event, intent); trace.intent = intent.id;
      }
      return;
    }
    if(event.type==='keydown') {
      this.shortcuts.key(key.key);
      this.#directKey=key.key;
      this.#eligibleKey=event.isTrusted&&!key.isComposing&&!key.ctrlKey&&!key.metaKey&&!key.altKey&&(key.key.length===1||key.key==='Enter');
      if(key.key==='Backspace'&&event.isTrusted&&!key.ctrlKey&&!key.metaKey&&!key.altKey&&!key.shiftKey&&!this.#composition.active&&!this.#readOnly) {
        const target=this.#selection.retain();
        try {const reversed=target&&this.shortcuts.reverse(target.range);
          if(reversed){event.preventDefault();this.#selection.place({...reversed,bias:'right'});this.#selection.capture();return;}
        } finally {target?.dispose();}
      }
      if(key.key==='Enter'&&this.#eligibleKey&&!this.#composition.active&&!this.#readOnly){
        const target=this.#selection.retain();
        try{const result=target&&this.shortcuts.convert(target.range,'\n','typing-shortcut:fence');if(result){event.preventDefault();this.#moveShortcut(result);return;}}finally{target?.dispose();}
      }
    }
    if (event.type === 'keyup' && /^(ArrowLeft|ArrowRight|ArrowUp|ArrowDown|Home|End|PageUp|PageDown)$/.test(key.key)) this.#selection.ensureVisible();
    if (event.type === 'keyup' || event.type === 'blur') {
      if (event.type === 'blur') this.keyboard.resetFocusEscape();
      this.#flushNative();
      if (this.#key?.disposition === 'native-pending') this.#key.disposition = 'handled';
      this.#key = undefined; this.#pending = undefined; return;
    }
    if (this.codeCommands?.handle(event) || this.references?.handle(event) || this.slash?.handle(event)) {
      const intent = this.#create('key'); intent.disposition = 'handled';
      this.#events.set(event, intent); trace.intent = intent.id; this.#key = intent; this.#pending = intent; return;
    }
    if (event.type === 'keydown' && this.keyboard.navigate(key)) { event.preventDefault(); return; }
    // A soft keyboard's reported deletion range is authoritative, including
    // when it differs from the current native selection. Physical key commands
    // and structural/native fallbacks retain their existing owners.
    const reportedDeletion = event.type === 'beforeinput' && ordinary.has(input.inputType) &&
      input.inputType.startsWith('delete') && input.getTargetRanges().length > 0;
    const action = reportedDeletion ? undefined : this.keyboard.action(event);
    // Native Tab belongs to the baseline literal-code/list/table profile.
    // Optional code convenience commands keep their explicit controls/bindings.
    if (action && (event.type === 'keydown' || event.type === 'beforeinput' && event.cancelable)) {
      this.#flushNative();
      const intent = event.type === 'beforeinput' ? this.#key ?? this.#create('beforeinput') : this.#create('key');
      const result = this.#readOnly ? { disposition: 'rejected' as const, reason: 'read-only' } : intent.disposition === 'native-pending' ? this.keyboard.execute(action, `keyboard:${intent.id}`) : { disposition: intent.disposition };
      if (result) {
        if (event.cancelable) event.preventDefault();
        Object.assign(intent, result); this.#events.set(event, intent); trace.intent = intent.id;
        if (event.type === 'keydown') this.#key = intent;
        this.#pending = intent; return;
      }
      // Native deletion/Tab is not an editor command intent.
      intent.disposition = 'handled';
    }
    if (event.type === 'keydown') {
      this.#flushNative();
      if (key.key.length === 1 || ['Backspace', 'Delete', 'Dead', 'Process', 'Unidentified'].includes(key.key)) {
        this.#key = this.#create('key'); this.#events.set(event, this.#key); trace.intent = this.#key.id;
      }
      return;
    }
    if (event.type === 'input') {
      this.#flushNative();
      if (this.#pending) { this.#events.set(event, this.#pending); trace.intent = this.#pending.id; }
      return;
    }
    if (event.type !== 'beforeinput') return;
    this.#flushNative();
    const intent = this.#key ?? this.#create('beforeinput');
    this.#pending = intent; this.#events.set(event, intent); trace.intent = intent.id;
    if (intent.disposition !== 'native-pending') { if (event.cancelable) event.preventDefault(); return; }
    if (this.#readOnly) { if (event.cancelable) event.preventDefault(); this.#reject(intent, 'read-only'); return; }
    const insertion = input.inputType === 'insertText' || input.inputType === 'insertReplacementText';
    if (!ordinary.has(input.inputType) || !event.cancelable || (insertion && input.data === null)) return;
    const reported = input.getTargetRanges();
    // A correction without a reported target belongs to bounded native fallback.
    // It must never replace the latest visible caret as a guessed target.
    if (input.inputType === 'insertReplacementText' && !reported.length) return;
    const target = this.#selection.retain();
    if (!target) { event.preventDefault(); this.#reject(intent, 'unmapped-selection'); return; }
    let range = target.range, ownedRange: StableRange | undefined;
    try {
      const directTyping = input.inputType === 'insertText' && event.isTrusted && this.#eligibleKey && input.data === this.#directKey && !input.isComposing;
      const collapsedReport = reported.length === 1 && reported[0]!.startContainer === reported[0]!.endContainer && reported[0]!.startOffset === reported[0]!.endOffset;
      // Chromium/WebKit may report a cut before an authored trailing BR. A
      // positively correlated typing key owns the captured visible target;
      // nonlocal/unclassified replacements still use their supplied range.
      if (reported.length && !(directTyping && collapsedReport)) {
        const native = reported.length === 1 ? reported[0] : undefined;
        const start = native && this.#selection.toModel(native.startContainer, native.startOffset, 'right');
        const collapsed = native && native.startContainer === native.endContainer && native.startOffset === native.endOffset;
        // At a freshly split empty block, left/right affinities may refer to
        // different structural owners. A collapsed reported target stays one cut.
        const end = collapsed ? start : native && this.#selection.toModel(native.endContainer, native.endOffset, 'left');
        if (!start || !end) { event.preventDefault(); this.#reject(intent, 'unmapped-replacement-target'); return; }
        const currentA = this.#engine.resolve(range.anchor), currentB = this.#engine.resolve(range.focus);
        const same = (point: typeof currentA, at: typeof start) => point.type === 'position' && point.node === at.node && point.offset === at.offset;
        // StaticRange is forward-only. When it reports the same semantic extent,
        // retain the user's directional range and its history affinities.
        if (!(same(currentA, start) && same(currentB, end) || same(currentA, end) && same(currentB, start))) {
          const anchor = this.#engine.anchor(start.node, start.offset, 'right');
          try { ownedRange = { anchor, focus: this.#engine.anchor(end.node, end.offset, collapsed ? 'right' : 'left') }; }
          catch (error) { this.#engine.releaseAnchor(anchor); throw error; }
          range = ownedRange;
        }
      }
      const a = this.#engine.resolve(range.anchor), b = this.#engine.resolve(range.focus);
      if (a.type !== 'position' || b.type !== 'position') {
        event.preventDefault(); this.#reject(intent, 'unsupported-ordinary-range'); return;
      }
      if (a.node !== b.node) {
        event.preventDefault();
        this.#apply(intent, range, insertion ? input.data! : '');
        this.#eligibleKey=false;
        return;
      }
      // The browser owns the deletion unit even for an expanded native
      // selection (prediction, word/line deletion and mixed keyboard input).
      // Without a nonempty reported/selected range, reconcile its actual DOM
      // mutation instead of guessing a UTF-16 code unit.
      if (!insertion && a.offset === b.offset) return;
      event.preventDefault();
      this.#apply(intent, range, insertion ? input.data! : '', undefined, true, input.inputType==='insertText'&&event.isTrusted&&this.#eligibleKey&&input.data===this.#directKey&&!input.isComposing);
      this.#eligibleKey=false;
    } catch (error) { event.preventDefault(); this.#reject(intent, errorMessage(error)); }
    finally { if (ownedRange) this.#release(ownedRange); target.dispose(); }
  }
  #mutations(records: MutationRecord[]): void {
    if (this.clipboard.ownsMutations || this.textDrag.ownsMutations) return;
    records = records.filter(record => !this.#renderer.ownsModuleDecoration(record.target));
    if (!records.length || this.#disposed || this.#rendering) return;
    if (this.#composition.active) {
      this.#record({ type: 'composition-mutations', trusted: false, generation: this.#generation, count: records.length, ...(this.#composition.owner ? { intent: this.#composition.owner.id } : {}) }); return;
    }
    // A fresh native mutation is an owner even when there was no beforeinput.
    // Terminal prior owners cannot consume independent deliberate mutations.
    const intent = this.#pending?.disposition === 'native-pending' ? this.#pending : this.#create('native');
    this.#pending = intent;
    this.#record({ type: 'native-mutations', trusted: false, generation: this.#generation, count: records.length, intent: intent.id });
    const mutation = reconcileMutation(this.#renderer, this.#content, records);
    if (mutation.type === 'unsupported') {
      this.#recover(intent, mutation.recovery);
      for (const node of mutation.nodes) this.#renderer.resume(node);
      // Unknown/root structure cannot be reconstructed by a bounded block patch.
      // Stop editing and expose the recovery result for host remount/recovery.
      if (!mutation.recovery.node || mutation.recovery.reason === 'native-limit') {
        this.#readOnly = true; this.#renderer.setReadOnly(true); this.#selection.clear();
        const native = this.#renderer.root.ownerDocument.getSelection();
        // A detached mapped block can leave stale native endpoints. Clear only
        // this editor's selection; unrelated page selections remain untouched.
        if (native?.anchorNode && (this.#renderer.root.contains(native.anchorNode) || this.#renderer.getNodeId(native.anchorNode))) native.removeAllRanges();
      }
      return;
    }
    if (mutation.type === 'unchanged') { intent.disposition = 'handled'; this.#renderer.resume(mutation.node); return; }
    if (this.#readOnly) {
      this.#recover(intent, { reason: 'read-only', node: mutation.node, text: mutation.captured, truncated: false });
      this.#renderer.resume(mutation.node); return;
    }
    const { node, before, start, end, text, captured, caret } = mutation;
    const anchor = this.#engine.anchor(node, start, 'right');
    let focus: AnchorToken;
    try { focus = this.#engine.anchor(node, end, 'left'); }
    catch (error) { this.#engine.releaseAnchor(anchor); throw error; }
    // If records arrive twice before dispatch, keep the final affected-block edit,
    // releasing the superseded preparation rather than committing intermediate DOM.
    const previous = this.#jobs.findIndex(job => job.intent === intent);
    if (previous >= 0) this.#release(this.#jobs.splice(previous, 1)[0]!.range);
    this.#jobs.push({ intent, node, before, range: { anchor, focus }, text, captured, ...(caret ? { caret } : {}) });
    if (!this.#queued) {
      this.#queued = true; const generation = this.#generation;
      queueMicrotask(() => { this.#queued = false; if (generation === this.#generation) this.#drain(); });
    }
  }
  #flushNative(): void { this.#mutations(this.#observer.takeRecords()); this.#drain(); }
  #drain(): void {
    for (const job of this.#jobs.splice(0)) {
      try {
        if (job.intent.disposition !== 'native-pending') continue;
        if (this.#content.get(job.node) !== job.before) {
          this.#recover(job.intent, { reason: 'native-baseline-changed', node: job.node, text: job.captured, truncated: false }); this.#renderer.resume(job.node); continue;
        }
        // Canonicalize only this block before engine patching; native wrappers
        // may have invalidated cached text nodes. Captured anchors remain valid.
        if (!job.caret) this.#selection.capture();
        this.#renderer.resume(job.node);
        this.#apply(job.intent, job.range, job.text, job.caret, false);
        if ((job.intent as TextIntent).disposition === 'rejected') {
          this.#recover(job.intent, { reason: job.intent.reason ?? 'native-commit-failed', node: job.node, text: job.captured, truncated: false });
          this.#renderer.resume(job.node);
        }
      } finally { this.#release(job.range); }
    }
  }
  #moveShortcut(result:CommitResult): void {
    try{if(result.caret)this.#selection.move(result.caret);else if(result.selection)this.#selection.move(result.selection.focus);}
    finally{if(result.caret)this.#engine.releaseAnchor(result.caret);if(result.selection){this.#engine.releaseAnchor(result.selection.anchor);this.#engine.releaseAnchor(result.selection.focus);}}
  }
  #apply(intent: TextIntent, range: StableRange, text: string, nativeCaret?: { anchor: number; focus: number }, moveCaret = true, shortcutEligible = false): void {
    if (this.#disposed || intent.generation !== this.#generation) { intent.disposition = 'disposed'; return; }
    if (this.#readOnly) { this.#reject(intent, 'read-only'); return; }
    const diagnostic = inputTextDiagnostic(text);
    if (diagnostic) { this.#recover(intent, { reason: diagnostic, text, truncated: false }); return; }
    const a = this.#engine.resolve(range.anchor), b = this.#engine.resolve(range.focus);
    if (a.type !== 'position' || b.type !== 'position') { this.#reject(intent, 'stale-target'); return; }
    if (a.node !== b.node) {
      // The shared fragment preparer owns structural replacement, including
      // whole-document ranges ending in an empty block and atomic rejection.
      const typing = this.keyboard.formatting.typing(range);
      const marks = Object.entries(typing).map(([mark, value]) => ({ mark: mark as import('@edit-ac/core').MarkCommand['mark'], ...(mark === 'link' ? { href: String(value) } : {}) }));
      let request: PrepareRequest = { kind: 'fragment', origin: `text-input:${intent.id}`, range,
        blocks: [{ attributes: null, runs: text ? [{ text, marks }] : [] }] };
      // A separator has no editable text witness for the fragment join path.
      // Compose existing paragraph conversion/join commands for the selected atoms
      // with ordinary range replacement in one prepared batch; failed applicability still makes no mutation.
      const nodes = this.#engine.read().visible.filter(node => node.kind === 'block');
      const ai = nodes.findIndex(node => node.id === a.node), bi = nodes.findIndex(node => node.id === b.node);
      const separators = nodes.slice(Math.min(ai, bi), Math.max(ai, bi) + 1).filter(node => Array.isArray(node.blockAttributes) && node.blockAttributes[0] === 'separator');
      if (ai >= 0 && bi >= 0 && separators.length) {
        const start = ai < bi ? a : b;
        const point = { owner: start.node, offset: start.offset + text.length, bias: 'right' as const };
        const commands: EditorCommand[] = [
          { type: 'historySelectionAt', anchor: { owner: a.node, offset: a.offset, bias: a.bias }, focus: { owner: b.node, offset: b.offset, bias: b.bias } },
          ...separators.map(node => ({ type: 'setParagraph' as const, owner: node.id })),
        ];
        const end = ai < bi ? b : a;
        for (const node of nodes.slice(Math.min(ai, bi), Math.max(ai, bi) + 1)) {
          const from = node.id === start.node ? start.offset : 0;
          const to = node.id === end.node ? end.offset : node.runs.reduce((n, run) => n + run.text.length, 0);
          commands.push({ type: 'replaceAt', owner: node.id, from, to, text: '' });
          if (node.id !== start.node) commands.push({ type: 'join', first: start.node, second: node.id });
        }
        commands.push({ type: 'replaceAt', owner: start.node, from: start.offset, to: start.offset, text });
        if (text) for (const mark of ['bold', 'italic', 'underline', 'strike', 'code', 'link'] as const) {
          const value = typing[mark];
          commands.push({ type: 'markAt', owner: start.node, from: start.offset, to: point.offset, mark, action: value ? 'apply' : 'remove', ...(mark === 'link' && value ? { href: String(value) } : {}) });
        }
        commands.push({ type: 'selectionAt', anchor: point, focus: point });
        request = { kind: 'editor', origin: `text-input:${intent.id}`, commands };
      }
      try {
        if (!this.#engine.can(request)) { this.#reject(intent, 'unsupported-ordinary-range'); return; }
        this.keyboard.resetFocusEscape(); this.#engine.history({type:'explicit'});
        const result = this.#commit(request);
        intent.disposition='committed'; intent.text=text;
        try {
          if (result.selection) this.#selection.restoreRange(result.selection);
          else if (result.caret) this.#selection.move(result.caret);
          else this.#selection.restore();
        } finally {
          if (result.caret) this.#engine.releaseAnchor(result.caret);
          if (result.selection) { this.#engine.releaseAnchor(result.selection.anchor); this.#engine.releaseAnchor(result.selection.focus); }
        }
        this.keyboard.formatting.remember(typing);
      } catch(error) { this.#reject(intent,errorMessage(error)); }
      finally { this.#engine.history({type:'boundary'}); }
      return;
    }
    if (a.offset === b.offset && !text) { intent.disposition = 'handled'; return; }
    if(shortcutEligible){const result=this.shortcuts.convert(range,text,`typing-shortcut:${intent.id}`);if(result){intent.disposition='committed';intent.text=text;this.#moveShortcut(result);return;}}
    // The upper endpoint survives replacement; a start anchor attached to the
    // deleted selection can collapse to its beginning instead of the new end.
    const slashEligible = shortcutEligible && this.slash?.eligibleAt(a.node, a.offset);
    const caretAnchor = this.#engine.anchor(a.node, Math.max(a.offset, b.offset), 'right');
    try {
      // Native input and observer-only reconciliation are edit intents too;
      // neither necessarily reaches KeyboardInput.action through beforeinput.
      this.keyboard.resetFocusEscape();
      this.#engine.history({ type: 'explicit' });
      const typing = this.keyboard.formatting.typing(range);
      const entry = this.#entrySelections.get(intent);
      let request: PrepareRequest = !text && entry ? { kind: 'editor', origin: `text-input:${intent.id}`, commands: [
        { type: 'historySelectionAt', ...entry },
        { type: 'delete', range },
        { type: 'selectionAt', anchor: { owner: a.node, offset: nativeCaret?.anchor ?? Math.min(a.offset, b.offset), bias: 'right' },
          focus: { owner: a.node, offset: nativeCaret?.focus ?? Math.min(a.offset, b.offset), bias: 'right' } },
      ] } : this.keyboard.formatting.replacement(range, text, `text-input:${intent.id}`);
      if (nativeCaret && (request.kind === 'editor' || request.kind === 'text')) {
        request = { kind: 'editor', origin: request.origin, commands: [
          ...(request.kind === 'editor' ? request.commands.filter(command => command.type !== 'selectionAt') : [request.command]),
          { type: 'selectionAt', anchor: { owner: a.node, offset: nativeCaret.anchor, bias: 'right' },
            focus: { owner: a.node, offset: nativeCaret.focus, bias: 'right' } },
        ] };
      }
      const result = this.#commit(request);
      if (result.caret) this.#engine.releaseAnchor(result.caret);
      if (result.selection) { this.#engine.releaseAnchor(result.selection.anchor); this.#engine.releaseAnchor(result.selection.focus); }
      intent.disposition = 'committed'; intent.text = text;
      const caret = this.#engine.resolve(caretAnchor);
      if (nativeCaret) {
        this.#selection.place({ node: a.node, offset: nativeCaret.anchor, bias: 'right' },
          { node: a.node, offset: nativeCaret.focus, bias: 'right' });
      } else if (moveCaret && caret.type === 'position') {
        this.#selection.place({ ...caret, bias: 'right' });
      }
      this.#selection.capture();
      this.keyboard.formatting.remember(typing);
      this.slash?.typed(a.node, a.offset, text, !!slashEligible && a.offset === b.offset);
      this.references?.typed(a.node, a.offset, text, shortcutEligible && a.offset === b.offset);
    } catch (error) { this.#reject(intent, errorMessage(error)); intent.text = text; }
    finally { this.#engine.releaseAnchor(caretAnchor); }
  }
  #release(range: StableRange): void { this.#engine.releaseAnchor(range.anchor); this.#engine.releaseAnchor(range.focus); }
  codeCommands: import('../extensions/code.js').CodeCommandsPresenter | undefined;
  attachCodeCommands(factory: import('../extensions/code.js').CodeCommandsFactory): void {
    if (this.codeCommands || this.#disposed) throw Error('Code commands already attached or disposed');
    this.codeCommands = factory({root:this.#renderer.root, selection:this.#selection, engine:this.#engine, commit:this.#commit,
      blocked:()=>this.#composition.active || !!this.slash?.open || !!this.references?.open});
    this.codeCommands.setReadOnly(this.#readOnly);
  }
  search: import('../modules/search.js').DocumentSearchPresenter | undefined;
  attachSearch(factory: import('../modules/search.js').DocumentSearchFactory): void {
    if (this.search || this.#disposed) throw Error('Search presenter already attached or disposed');
    this.search = factory({ root: this.#renderer.root, selection: this.#selection, engine: this.#engine, commit: this.#commit,
      blocked: () => this.#composition.active || !!this.slash?.open || !!this.references?.open });
    this.search.setReadOnly(this.#readOnly);
  }
  attachReorder(factory: import('../modules/reorder.js').ReorderFactory): void {
    if (this.reorder || this.#disposed) throw Error('Reorder presenter already attached or disposed');
    this.reorder = factory({ root: this.#renderer.root, selection: this.#selection, engine: this.#engine, commit: this.#commit, copyDrop: (event,target) => {
      if (!this.#selection.place({node:target,offset:0,bias:'right'})) return false;
      this.clipboard.handle(event);return this.clipboard.last.disposition==='committed';
    }, blocked: () => this.#composition.active || !!this.slash?.open || !!this.references?.open });
    this.reorder.setReadOnly(this.#readOnly);
  }
  attachReferences(factory: import('../modules/references.js').ReferenceFactory): void {
    if (this.references || this.#disposed) throw Error('Reference presenter already attached or disposed');
    this.references = factory({ root: this.#renderer.root, selection: this.#selection, engine: this.#engine, commit: this.#commit, route: event => this.#handle(event, true), focusEscape: event => { this.keyboard.action(event); } });
    this.references.setReadOnly(this.#readOnly);
  }
  attachSlash(factory: import('../modules/slash.js').SlashFactory): void {
    if (this.slash || this.#disposed) throw Error('Slash presenter already attached or disposed');
    this.slash = factory({ root: this.#renderer.root, selection: this.#selection, engine: this.#engine, commit: this.#commit, route: event => this.#handle(event, true), focusEscape: event => { this.keyboard.action(event); } });
    this.slash.setReadOnly(this.#readOnly);
  }
  setReadOnly(value: boolean): void {
    this.#requestedReadOnly = value; this.#applyReadOnly(value || this.#suspended);
  }
  #applyReadOnly(value: boolean): void {
    this.codeCommands?.setReadOnly(value); this.search?.setReadOnly(value); this.reorder?.setReadOnly(value); this.slash?.setReadOnly(value); this.references?.setReadOnly(value);
    if (value) {
      this.clipboard.cancel(); this.textDrag.cancel();
      const owner = this.#composition.owner;
      this.#composition.finish('readonly');
      // This terminal transition has no final event to release routing owners.
      if (this.#key === owner) this.#key = undefined;
      if (this.#pending === owner) this.#pending = undefined;
    }
    this.#flushNative(); this.#readOnly = value; this.#renderer.setReadOnly(value);
  }
  async settle(): Promise<void> {
    const generation = this.#generation;
    for (let turn = 0; turn < 8; turn++) {
      if (generation !== this.#generation) return;
      this.#flushNative(); await Promise.resolve();
      if (!this.#queued && !this.#jobs.length) return;
    }
    throw new Error('Ordinary input did not settle in eight microtask turns');
  }
  dispose(): void {
    if (this.#disposed) return;
    this.codeCommands?.dispose(); this.search?.dispose(); this.reorder?.dispose(); this.slash?.dispose(); this.references?.dispose();
    this.#composition.finish('dispose'); this.#composition.dispose(); this.keyboard.dispose(); this.clipboard.dispose(); this.textDrag.dispose();
    this.#disposed = true; this.#generation++; this.#observer.disconnect(); this.#subscription.dispose();
    this.#renderer.patchBoundary = undefined; this.#renderer.setReadOnly(true);
    for (const [type, listener] of this.#listeners) this.#renderer.root.removeEventListener(type, listener);
    for (const job of this.#jobs.splice(0)) { job.intent.disposition = 'disposed'; this.#release(job.range); }
    for (const intent of this.intents) if (intent.disposition === 'native-pending') intent.disposition = 'disposed';
    this.#content.clear();
  }
}
