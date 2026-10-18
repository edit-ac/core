import type { BrowserEditor } from '../editor.js';
import { commandCatalog, type CapturedCommand } from '../commands/catalog.js';

/** Optional host-mounted controls. No editing model, global listeners, keyboard
 * show requests or clipboard reads during construction/search. */
export class CommandControls {
  readonly element: HTMLElement;
  readonly search: HTMLInputElement;
  readonly status: HTMLElement;
  #targets = new Map<string, CapturedCommand>();
  #pasteTarget: ReturnType<BrowserEditor['capturePlainPaste']>;
  #formattedTarget: ReturnType<BrowserEditor['capturePaste']>;
  #disposed = false;
  #pending = false;
  #generation = 0;
  #cancelRead: (() => void) | undefined;
  #pendingCommand: string | undefined;
  readonly #cancel: HTMLButtonElement;
  readonly #buttons = new Map<string, HTMLButtonElement>();
  readonly #unsubscribe: () => void;
  readonly #releaseViewport: (() => void) | undefined;
  readonly #capture = (event: Event) => {
    if (this.#pending) return;
    if (event.type === 'keydown' && (event as KeyboardEvent).key !== 'Tab') return;
    if (this.editor.root.ownerDocument.activeElement !== this.editor.root) return;
    this.#release();
    for (const id of [...this.#buttons.keys()].filter(id => id !== 'search' && id !== 'paste' && id !== 'paste-formatted')) {
      const target = this.editor.captureCommand(id, undefined, this.element);
      if (target) this.#targets.set(id, target);
    }
    this.#pasteTarget = this.editor.capturePlainPaste(this.element);
    this.#formattedTarget = this.editor.capturePaste(this.element);
  };
  readonly #click = (event: Event) => {
    const button = (event.target as Element).closest<HTMLButtonElement>('button[data-command]');
    if (!button || !this.element.contains(button) || button.disabled) return;
    const id = button.dataset.command!;
    if (id === 'search') { this.search.hidden = !this.search.hidden; button.setAttribute('aria-expanded', String(!this.search.hidden)); if (!this.search.hidden) this.search.focus(); return; }
    void this.activate(id);
  };
  readonly #query = () => {
    const query = this.search.value.toLocaleLowerCase();
    for (const [id, button] of this.#buttons) if (id !== 'search') button.hidden = !button.textContent!.toLocaleLowerCase().includes(query);
  };
  readonly #dismiss = (event: KeyboardEvent) => {
    if (event.isComposing) return;
    if (event.key === 'Enter') {
      event.preventDefault();
      const entry = [...this.#buttons].find(([id, button]) => id !== 'search' && !button.hidden && !button.disabled);
      // Query submission chooses a control; activation remains explicit.
      if (entry) entry[1].focus();
      return;
    }
    if (event.key !== 'Escape') return;
    event.preventDefault(); this.search.hidden = true; this.search.value = ''; this.#query();
    this.#buttons.get('search')!.setAttribute('aria-expanded', 'false');
    this.#buttons.get('search')!.focus(); // dismiss to the owning control, never force the editor keyboard
  };
  constructor(readonly editor: BrowserEditor) {
    const doc = editor.root.ownerDocument;
    this.element = doc.createElement('div'); this.element.setAttribute('role', 'group'); this.element.setAttribute('aria-label', 'Editing commands');
    this.element.style.cssText = 'display:flex;flex-wrap:wrap;gap:4px;max-width:100%;max-height:40vh;overflow:auto';
    this.search = doc.createElement('input'); this.search.type = 'search'; this.search.hidden = true;
    this.search.setAttribute('aria-label', 'Search editing commands'); this.search.inputMode = 'search'; this.search.enterKeyHint = 'search';
    this.search.addEventListener('input', this.#query); this.search.addEventListener('keydown', this.#dismiss);
    for (const [id, label] of [['search', 'Search commands'], ...commandCatalog.filter(c => ['enter','break','undo','redo','indent','outdent','bold','italic','underline','link','strike','code'].includes(c.id)).filter(c => editor.extensionConfiguration?.configuration.formatting?.marks?.[c.id as import('../extensions/contract.js').CoreFormattingMarkV1]?.controls !== false).map(c => [c.id, c.label]), ['paste-formatted', 'Paste with formatting'], ['paste', 'Paste without formatting']]) {
      const button = doc.createElement('button'); button.type = 'button'; button.dataset.command = id;
      button.disabled = editor.state.readOnly; button.textContent = label!; if (id === 'search') button.setAttribute('aria-expanded', 'false'); button.style.cssText = 'min-width:44px;min-height:44px'; this.#buttons.set(id!, button); this.element.append(button);
    }
    this.status = doc.createElement('span'); this.status.setAttribute('role', 'status');
    this.#cancel = doc.createElement('button'); this.#cancel.type = 'button';
    this.#cancel.textContent = 'Cancel paste'; this.#cancel.hidden = true;
    this.#cancel.style.cssText = 'min-width:44px;min-height:44px';
    this.#cancel.addEventListener('click', this.#cancelClick);
    this.element.append(this.search, this.status, this.#cancel); editor.root.after(this.element);
    this.#releaseViewport = editor.viewport?.addControls(this.element);
    this.element.addEventListener('pointerdown', this.#capture); editor.root.addEventListener('keydown', this.#capture, true);
    this.element.addEventListener('click', this.#click);
    this.#unsubscribe = editor.subscribe(state => {
      if (!state.ready || state.readOnly) { this.cancelPendingPaste(); this.#release(); }
      for (const button of this.#buttons.values()) button.disabled = !state.ready || state.readOnly;
    });
  }
  readonly #cancelClick = () => {
    const button = this.#buttons.get(this.#pendingCommand ?? '');
    const focused = this.element.ownerDocument.activeElement === this.#cancel;
    this.cancelPendingPaste();
    if (focused && button && !button.disabled) button.focus();
  };
  /** Revoke the control's intent without waiting for an unabortable host read.
   * Its eventual result still passes through the existing clipboard guard. */
  cancelPendingPaste(): void {
    if (!this.#pending) return;
    this.#generation++; this.#release(); this.#pending = false;
    this.#cancelRead?.(); this.#cancelRead = undefined;
    this.#pendingCommand = undefined;
    this.#cancel.hidden = true; this.element.removeAttribute('aria-busy');
    if (!this.#disposed) this.status.textContent = 'Paste canceled. Select text and try again, or use native Paste.';
  }
  #release(): void { this.#formattedTarget?.dispose(); this.#formattedTarget = undefined; this.#pasteTarget?.dispose(); this.#pasteTarget = undefined; for (const target of this.#targets.values()) target.dispose(); this.#targets.clear(); }
  /** Explicit activation can be supplied a host clipboard reader; completion
   * revalidates the captured intent and never restores focus asynchronously. */
  async activate(id: string, read?: () => Promise<string | Pick<import('../clipboard/fragment.js').ClipboardData, 'getData'>>): Promise<void> {
    if (this.#disposed || this.#pending) return;
    const isPaste = id === 'paste' || id === 'paste-formatted';
    const target = id === 'paste' ? this.#pasteTarget : id === 'paste-formatted' ? this.#formattedTarget : this.#targets.get(id);
    if (!target?.active) { this.status.textContent = 'Select text in the editor, then choose a command.'; this.#release(); return; }
    const generation = ++this.#generation;
    try {
      this.#pending = isPaste;
      if (isPaste) {
        this.#pendingCommand = id;
        this.#cancel.hidden = false; this.element.setAttribute('aria-busy', 'true');
        this.status.textContent = 'Reading clipboard. Cancel paste to continue without waiting.';
        const cancellation = new Promise<undefined>(resolve => { this.#cancelRead = () => resolve(undefined); });
        const data = read ? async () => {
          const value = await read();
          return typeof value === 'string' ? { getData: (mime: string) => mime === 'text/plain' ? value : '' } : value;
        } : undefined;
        const operation = id === 'paste' ? this.#pasteTarget!.paste(data ? async () => (await data()).getData('text/plain') : undefined) : this.#formattedTarget!.paste(data);
        const result = await Promise.race([operation, cancellation]);
        if (this.#disposed || generation !== this.#generation || !result) return;
        this.status.textContent = result.disposition === 'rejected' ? 'Paste canceled or clipboard unavailable. Select text and try again, or use native Paste.' : id === 'paste' ? 'Pasted without formatting. Tap the editor to continue typing.' : 'Pasted with formatting. Tap the editor to continue typing.';
      } else {
        const result = this.#targets.get(id)!.execute();
        this.status.textContent = result.reason === 'editor-focus-declined' ? 'Tap the editor to continue typing.' : result.disposition === 'rejected' ? 'Command unavailable for this selection.' : '';
      }
    } catch { if (!this.#disposed && generation === this.#generation) this.status.textContent = 'Clipboard unavailable. Use native Paste or allow clipboard access.'; }
    finally { if (generation === this.#generation) {
      this.#pending = false; this.#cancelRead = undefined; this.#pendingCommand = undefined; this.#cancel.hidden = true;
      this.element.removeAttribute('aria-busy'); this.#release();
    } }
  }
  dispose(): void {
    if (this.#disposed) return; this.#disposed = true; this.cancelPendingPaste(); this.#release(); this.#unsubscribe(); this.#releaseViewport?.();
    this.#cancel.removeEventListener('click', this.#cancelClick);
    this.element.removeEventListener('pointerdown', this.#capture); this.editor.root.removeEventListener('keydown', this.#capture, true);
    this.element.removeEventListener('click', this.#click); this.search.removeEventListener('input', this.#query); this.search.removeEventListener('keydown', this.#dismiss);
    this.element.remove();
  }
}
