import { AssistiveInputSession, captureAssistiveTarget, type AssistiveTransport, type AssistiveRegistration, type AssistivePresenterStatus, type AssistiveCommandApplicability } from '@edit-ac/core/extensions';
import type { EngineHandle, PrepareRequest, CommitResult } from '@edit-ac/core';
import type { DOMSelection, RetainedSelection } from '../dom/selection.js';
import { commandCatalog, type CapturedCommand } from '../commands/catalog.js';
import { touchPanel, touchTarget } from './touch-controls.js';

export interface AssistivePresenterContext {
  root: HTMLElement; engine: EngineHandle; selection: DOMSelection;
  captureCommand(name: string, focusOwner: HTMLElement): CapturedCommand | undefined;
  blocked(): boolean;
}
export interface AssistivePresenterOptions {
  /** IDs from the existing portable command catalog; no host edit callbacks. */
  commands?: readonly string[];
  /** Explicit host lifecycle actions; availability never implies microphone access. */
  cancel?(): void;
  recover?(): void;
  /** Explicit injected host only. Commit through this editor's existing Session
   * storage port; allowed must mirror the host permission for replacement. */
  host?: { transport: AssistiveTransport; commit(request: PrepareRequest): CommitResult; allowed(): boolean };
}
export type AssistivePresenterFactory = (context: AssistivePresenterContext) => AssistiveInputPresenter | undefined;
/** Optional existing presenter boundary. Disabled registration creates no UI/listeners. */
export function assistiveInput(registration: AssistiveRegistration, options: AssistivePresenterOptions = {}): AssistivePresenterFactory {
  const copy = { ...options, commands: [...(options.commands ?? ['bold', 'italic', 'undo', 'redo'])] };
  return context => registration.descriptor?.enabled && !registration.signal.aborted
    ? new AssistiveInputPresenter(context, registration, copy) : undefined;
}
let nextId = 0;
/** Disposable UI only: committed content, stable anchors, command applicability and
 * history remain owned by the existing engine/selection/keyboard adapters. */
export class AssistiveInputPresenter {
  readonly element: HTMLElement; readonly button: HTMLButtonElement; readonly panel: HTMLElement;
  readonly query: HTMLInputElement; readonly status: HTMLElement; readonly cancel: HTMLButtonElement; readonly recover: HTMLButtonElement;
  readonly preview: HTMLElement;
  readonly session: AssistiveInputSession | undefined;
  readonly startControl: HTMLButtonElement | undefined;
  readonly stopControl: HTMLButtonElement | undefined;
  readonly #hostAvailability: HTMLElement;
  readonly #commands = new Map<string, HTMLButtonElement>();
  readonly #targets = new Map<string, CapturedCommand>();
  readonly #reasons = new Map<string, HTMLElement>();
  readonly #listeners: (() => void)[] = [];
  #selection: RetainedSelection | undefined;
  #disposed = false; #open = false; #readOnly = false;
  #state: AssistivePresenterStatus['state'] = 'idle';
  #lastAnnouncement = '';
  constructor(readonly context: AssistivePresenterContext, readonly registration: AssistiveRegistration, readonly options: AssistivePresenterOptions = {}) {
    const descriptor = registration.descriptor!;
    const commands = registration.supports('commands') ? (options.commands ?? ['bold','italic','undo','redo']).map(id => {
      const command = commandCatalog.find(c => c.id === id && c.id !== 'replace');
      if (!command) throw Error('Unsupported assistive command');
      return {commandId: command.id, label: command.label, enabled: false, reason: 'unavailable' as const};
    }) : [];
    registration.supports('commands') && registration.validateCommands(commands);
    const doc = context.root.ownerDocument;
    this.element = doc.createElement('div'); this.element.contentEditable = 'false'; this.element.dataset.assistiveInput = '';
    this.element.style.minWidth = '0'; this.element.style.maxWidth = '100%';
    this.element.setAttribute('role','group'); this.element.setAttribute('aria-label','Editing assistance');
    const button = (label: string, action: () => void) => {
      const b = doc.createElement('button'); b.type = 'button'; b.textContent = label;
      touchTarget(b, true);
      // Preserve the native hidden attribute used by command filtering.
      b.style.removeProperty('display');
      this.#listen(b,'click',action); return b;
    };
    this.button = button('Editing assistance', () => this.show());
    this.panel = doc.createElement('section'); this.panel.hidden = true; this.panel.id = `editac-assistance-${++nextId}`;
    touchPanel(this.panel); this.panel.style.overflowWrap = 'anywhere';
    this.panel.setAttribute('aria-label','Assistance commands');
    this.button.setAttribute('aria-expanded','false'); this.button.setAttribute('aria-controls',this.panel.id);
    const label = doc.createElement('label'); label.textContent = 'Search assistance commands';
    label.style.display = 'block'; label.style.minWidth = '0';
    this.query = doc.createElement('input'); this.query.type = 'search'; this.query.maxLength = 128;
    touchTarget(this.query, true); this.query.style.minWidth = '0'; this.query.style.maxWidth = '100%';
    label.append(this.query); this.panel.append(label);
    const results = doc.createElement('div'); results.setAttribute('role','group'); results.setAttribute('aria-label','Available assistance commands');
    for (const command of commands) {
      const b = button(command.label, () => this.activate(command.commandId)); b.disabled = true;
      const reason = doc.createElement('span'); reason.id = `${this.panel.id}-${command.commandId}-reason`;
      b.setAttribute('aria-describedby',reason.id); this.#reasons.set(command.commandId,reason);
      this.#commands.set(command.commandId,b); results.append(b,reason);
    }
    this.panel.append(results);
    this.status = doc.createElement('p'); this.status.setAttribute('role','status'); this.status.setAttribute('aria-live','polite'); this.status.setAttribute('aria-atomic','true');
    this.preview=doc.createElement('p');this.preview.dataset.assistivePreview='';this.preview.setAttribute('aria-live','off');this.preview.hidden=true;
    this.preview.style.whiteSpace = 'pre-wrap'; this.preview.style.userSelect = 'text';
    const availability = doc.createElement('p');
    availability.textContent = !registration.supports('commands') ? 'Editing commands are unavailable in this extension.' : 'Choose commands for the captured editor selection.';
    const transport = descriptor.transport;
    this.#hostAvailability = doc.createElement('p');
    this.#hostAvailability.id = `${this.panel.id}-host-availability`;
    const privacy = doc.createElement('p'); privacy.textContent = transport
      ? `Host assistance: ${transport.input}; processing: ${transport.locality}; retention: ${transport.retention}; permission: host.`
      : 'Host transport is unsupported. Ordinary text input remains available.';
    if (options.host && registration.supports('host-transport')) {
      this.session = new AssistiveInputSession(registration, options.host.transport, value => this.update(value));
      this.startControl = button('Start assistance', () => this.start());
      this.stopControl = button('Stop assistance', () => this.session?.stop());
      this.startControl.setAttribute('aria-describedby', this.#hostAvailability.id);
      this.stopControl.setAttribute('aria-describedby', this.#hostAvailability.id);
      this.panel.append(this.startControl,this.stopControl);
    }
    this.cancel = button('Cancel assistance', () => this.#host('cancel'));
    this.recover = button('Recover assistance', () => this.#host('recover'));
    const reasons = doc.createElement('p'); reasons.textContent = [!options.cancel && !this.session && 'Cancellation is unsupported by this host.',!options.recover && !this.session && 'Recovery is unsupported by this host.'].filter(Boolean).join(' ');
    this.panel.append(availability,privacy,this.#hostAvailability,this.status,this.preview,this.cancel,this.recover,reasons,button('Close assistance', () => this.close()));
    this.element.append(this.button,this.panel); context.root.after(this.element);
    this.#listen(this.query,'input',() => this.#filter());
    this.#listen(this.panel,'keydown',event => {
      const key = event as KeyboardEvent; if (key.isComposing) return;
      if (key.key === 'Escape') { key.preventDefault(); this.close(); }
      else if (key.key === 'Enter' && key.target === this.query) {
        key.preventDefault(); const entry = [...this.#commands].find(([,b]) => !b.hidden && !b.disabled); if (entry) this.activate(entry[0]);
      }
    });
    this.#listen(this.element,'pointerdown',event => {
      this.#capture();
      // Keep mouse focus owned until the action restores the editor. Cancelling
      // a touch pointerdown suppresses WebKit's subsequent button activation;
      // capture above retains the selection while native touch focus proceeds.
      if ((event as PointerEvent).pointerType !== 'touch' && (event.target as Element).closest('button')) event.preventDefault();
    });
    this.#listen(context.root,'keydown',event => { if ((event as KeyboardEvent).key === 'Tab' && !(event as KeyboardEvent).isComposing) this.#capture(); },true);
    this.#listen(context.root,'focusout',() => this.#capture());
    // OS input retains its existing route, including missing/noncancelable beforeinput.
    for (const type of ['beforeinput','input','compositionstart']) this.#listen(context.root,type,() => this.session?.invalidate(type==='compositionstart'?'composing':'stale'),true);
    this.#listen(context.root,'compositionstart',() => { this.close(false); });
    this.#listen(context.root,'blur',event => {
      const next = (event as FocusEvent).relatedTarget as Node | null;
      if (!next || !this.element.contains(next)) this.session?.cancel();
    });
    this.#listen(doc,'focusin',event => {
      const node = event.target as Node;
      if (!this.element.contains(node) && node !== context.root) this.close(false);
    });
    // Leaving the tab or hiding the document also ends acceptance, even when
    // the focused element is an assistance control rather than the editor.
    if (doc.defaultView) this.#listen(doc.defaultView,'blur',() => this.close(false));
    this.#listen(doc,'visibilitychange',() => { if (doc.hidden) this.close(false); });
    this.#listen(registration.signal,'abort',() => this.dispose());
    const subscription = context.engine.subscribe({type:'all'},() => this.#refresh()); this.#listeners.push(() => subscription.dispose());
    this.#refresh();
  }
  get open(): boolean { return this.#open; }
  get applicability(): readonly AssistiveCommandApplicability[] {
    return [...this.#commands].map(([commandId,b]) => ({commandId,label:b.textContent!,enabled:!b.disabled,reason:!b.disabled ? null : this.#readOnly ? 'read-only' : this.context.blocked() ? 'composing' : 'unavailable'}));
  }
  #listen(target: EventTarget, type: string, action: (event: Event) => void, capture = false): void {
    target.addEventListener(type,action,capture); this.#listeners.push(() => target.removeEventListener(type,action,capture));
  }
  #capture(): void {
    if (this.#disposed || this.context.root.ownerDocument.activeElement !== this.context.root) return;
    this.#release(); if (this.#readOnly || this.context.blocked()) { this.#refresh(); return; }
    this.#selection = this.context.selection.retain();
    for (const id of this.#commands.keys()) { const target = this.context.captureCommand(id,this.element); if (target) this.#targets.set(id,target); }
    this.#refresh();
  }
  #release(): void { this.#selection?.dispose(); this.#selection = undefined; for (const target of this.#targets.values()) target.dispose(); this.#targets.clear(); }
  #refresh(): void {
    if (this.#disposed) return;
    for (const [id,b] of this.#commands) {
      b.disabled = this.#readOnly || this.context.blocked() || !this.#targets.get(id)?.active;
      const reason = this.#reasons.get(id)!;
      reason.textContent = !b.disabled ? '' : this.#readOnly ? 'Read-only editor.' : this.context.blocked()
        ? 'Finish composing text before using commands.' : 'Command unavailable. Select a supported target and reopen assistance.';
    }
    this.#hostAvailability.textContent = this.#readOnly ? 'Assistance is unavailable in a read-only editor.'
      : !this.session ? 'Host assistance is unavailable. Ordinary text input and editing commands remain available.'
      : this.context.blocked() ? 'Finish composing text before starting assistance.'
      : !this.options.host?.allowed() ? 'Host permission is unavailable. Use ordinary text input or editing commands.'
      : !this.registration.descriptor?.transport?.canStop ? 'This host cannot stop assistance. Use Cancel assistance or ordinary text input.'
      : this.session.active ? 'Assistance is pending. Stop requests a final result; Cancel discards pending results.'
      : 'Start assistance for the captured selection. Stop requests a final result; Cancel discards pending results.';
    if (this.startControl) this.startControl.disabled = !!this.session?.active || this.#readOnly || this.context.blocked() || !this.options.host?.allowed();
    if (this.stopControl) this.stopControl.disabled = !this.session?.active || !this.registration.descriptor?.transport?.canStop;
    this.cancel.disabled = (!this.options.cancel && !this.session) || !['starting','active','preparing'].includes(this.#state);
    this.recover.disabled = (!this.options.recover && !this.session) || !['failed','stale','cancelled'].includes(this.#state) || this.#readOnly || this.context.blocked();
  }
  #filter(): void { const q = this.query.value.toLocaleLowerCase(); for (const [id,b] of this.#commands) { b.hidden = !b.textContent!.toLocaleLowerCase().includes(q); this.#reasons.get(id)!.hidden = b.hidden; } }
  #announce(message: string): void {
    // Host envelopes reject oversize data; built-in messages fit even tiny limits.
    const limit = this.registration.descriptor?.limits.statusBytes ?? 0; let bounded = '';
    for (const char of message) { if (new TextEncoder().encode(bounded + char).length > limit) break; bounded += char; }
    if (bounded !== this.#lastAnnouncement) { this.#lastAnnouncement = bounded; this.status.textContent = bounded; }
  }
  show(): void {
    if (this.#disposed || this.context.blocked()) return;
    this.#capture(); this.#open = true; this.panel.hidden = false; this.button.setAttribute('aria-expanded','true'); this.#refresh(); this.query.focus();
  }
  close(restore = true): void {
    if (this.#disposed) return;
    const doc = this.context.root.ownerDocument, ownsFocus = this.element.contains(doc.activeElement);
    this.session?.cancel();
    this.#open = false; this.panel.hidden = true; this.button.setAttribute('aria-expanded','false'); this.query.value = ''; this.#filter();
    if (restore && ownsFocus) {
      try { if (this.#selection?.active && !this.context.blocked() && !this.#readOnly) { this.context.root.focus(); this.context.selection.restoreRetained(this.#selection); } else this.button.focus(); }
      catch { this.button.focus(); }
    }
    this.preview.textContent='';this.preview.hidden=true;
    this.#release(); this.#refresh();
  }
  activate(id: string): void {
    if (this.#disposed) return;
    const target = this.#targets.get(id);
    if (!target?.active || this.#readOnly || this.context.blocked()) { this.#announce('Command unavailable. Select text and reopen assistance.'); this.#refresh(); return; }
    try { const result = target.execute(); this.#announce(result.disposition === 'rejected' ? 'Command unavailable. Select text and try again.' : 'Command completed.'); }
    finally { this.close(false); }
  }
  /** Validate before changing UI. Provisional/private transcript is never announced. */
  update(value: AssistivePresenterStatus): void {
    if (this.#disposed) return;
    const status = this.registration.validateStatus(value); this.#state = status.state;
    const provisional=this.session?.active ? status.provisional : '';
    this.preview.textContent=provisional ? `Uncommitted assistance preview: ${provisional}` : '';this.preview.hidden=!provisional;
    this.#announce(status.message); this.#refresh();
  }
  /** Capture before host work; current caret changes never redirect the result. */
  start(): void {
    if (this.#disposed || !this.session || !this.options.host || this.session.active) return;
    this.#capture();
    if (this.#readOnly || this.context.blocked() || !this.options.host.allowed() || !this.#selection?.active) { this.#announce('Assistance unavailable. Select text and try again.');this.#refresh();return; }
    const host=this.options.host;
    const startedFromControl = this.context.root.ownerDocument.activeElement === this.startControl;
    try {
      const target=captureAssistiveTarget(this.context.engine,this.#selection.range,request=>host.commit(request),
        () => !this.#disposed && !this.#readOnly && !this.context.blocked() && host.allowed(),
        result => { this.context.root.focus();if(result.selection)this.context.selection.restoreRange(result.selection);else this.context.selection.restore(); });
      this.session.start(target);
    } catch { this.#announce('Assistance unavailable. Select text and try again.'); }
    this.#refresh();
    // Disabling a focused Start button may drop keyboard focus onto the body.
    // Keep Stop/Cancel reachable, but never steal focus after a terminal callback.
    if (startedFromControl && this.session.active) {
      (this.stopControl && !this.stopControl.disabled ? this.stopControl : this.cancel).focus();
    }
  }
  #host(action: 'cancel' | 'recover'): void {
    if (this.#disposed || (action === 'cancel' ? this.cancel : this.recover).disabled) return;
    if (this.session) {
      const hadFocus = this.context.root.ownerDocument.activeElement === (action === 'cancel' ? this.cancel : this.recover);
      if (action==='cancel') this.session.cancel();
      else {const text=this.session.recoveryText();this.session.reset();this.preview.textContent=text ? `Uncommitted recovery text: ${text}` : '';this.preview.hidden=!text;}
      this.#refresh();
      if (hadFocus) {
        const next = !this.recover.disabled ? this.recover : this.startControl && !this.startControl.disabled ? this.startControl : this.query;
        next.focus();
      }
      return;
    }
    try { this.options[action]?.(); this.#state = action === 'cancel' ? 'cancelled' : 'idle'; this.#announce(action === 'cancel' ? 'Assistance cancelled.' : 'Assistance ready. Select text and try again.'); }
    catch { this.#state = 'failed'; this.#announce('Assistance unavailable. Try recovery.'); }
    this.#refresh();
  }
  setReadOnly(value: boolean): void { this.#readOnly = value; if(value)this.session?.invalidate('read-only'); if (value) this.#release(); this.#refresh(); }
  dispose(): void { if (this.#disposed) return; this.#disposed = true; this.session?.dispose(); this.#release(); for (const remove of this.#listeners.splice(0)) remove(); this.element.remove(); }
}
