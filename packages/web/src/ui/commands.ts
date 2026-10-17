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
  #disposed = false;
  #pending = false;
  readonly #buttons = new Map<string, HTMLButtonElement>();
  readonly #unsubscribe: () => void;
  readonly #capture = (event: Event) => {
    if (event.type === 'keydown' && (event as KeyboardEvent).key !== 'Tab') return;
    if (this.editor.root.ownerDocument.activeElement !== this.editor.root) return;
    this.#release();
    for (const id of [...this.#buttons.keys()].filter(id => id !== 'search' && id !== 'paste')) {
      const target = this.editor.captureCommand(id, undefined, this.element);
      if (target) this.#targets.set(id, target);
    }
    this.#pasteTarget = this.editor.capturePlainPaste(this.element);
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
      if (entry) void this.activate(entry[0]);
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
    for (const [id, label] of [['search', 'Search commands'], ...commandCatalog.filter(c => ['break','undo','redo','indent','outdent','bold','italic','underline','link'].includes(c.id)).map(c => [c.id, c.label]), ['paste', 'Paste without formatting']]) {
      const button = doc.createElement('button'); button.type = 'button'; button.dataset.command = id;
      button.disabled = editor.state.readOnly; button.textContent = label!; if (id === 'search') button.setAttribute('aria-expanded', 'false'); button.style.cssText = 'min-width:44px;min-height:44px'; this.#buttons.set(id!, button); this.element.append(button);
    }
    this.status = doc.createElement('span'); this.status.setAttribute('role', 'status');
    this.element.append(this.search, this.status); editor.root.after(this.element);
    this.element.addEventListener('pointerdown', this.#capture); editor.root.addEventListener('keydown', this.#capture, true);
    this.element.addEventListener('click', this.#click);
    this.#unsubscribe = editor.subscribe(state => {
      if (!state.ready || state.readOnly) this.#release();
      for (const button of this.#buttons.values()) button.disabled = !state.ready || state.readOnly;
    });
  }
  #release(): void { this.#pasteTarget?.dispose(); this.#pasteTarget = undefined; for (const target of this.#targets.values()) target.dispose(); this.#targets.clear(); }
  /** Explicit activation can be supplied a host clipboard reader; completion
   * revalidates the captured intent and never restores focus asynchronously. */
  async activate(id: string, read?: () => Promise<string>): Promise<void> {
    if (this.#disposed || this.#pending) return;
    const target = id === 'paste' ? this.#pasteTarget : this.#targets.get(id);
    if (!target?.active) { this.status.textContent = 'Select text in the editor, then choose a command.'; this.#release(); return; }
    try {
      this.#pending = id === 'paste';
      if (id === 'paste') {
        const result = await this.#pasteTarget!.paste(read);
        if (this.#disposed) return;
        this.status.textContent = result.disposition === 'rejected' ? 'Paste canceled or clipboard unavailable. Select text and try again, or use native Paste.' : 'Pasted without formatting. Tap the editor to continue typing.';
      } else {
        const result = this.#targets.get(id)!.execute();
        this.status.textContent = result.reason === 'editor-focus-declined' ? 'Tap the editor to continue typing.' : result.disposition === 'rejected' ? 'Command unavailable for this selection.' : '';
      }
    } catch { if (!this.#disposed) this.status.textContent = 'Clipboard unavailable. Use native Paste or allow clipboard access.'; }
    finally { this.#pending = false; this.#release(); }
  }
  dispose(): void {
    if (this.#disposed) return; this.#disposed = true; this.#release(); this.#unsubscribe();
    this.element.removeEventListener('pointerdown', this.#capture); this.editor.root.removeEventListener('keydown', this.#capture, true);
    this.element.removeEventListener('click', this.#click); this.search.removeEventListener('input', this.#query); this.search.removeEventListener('keydown', this.#dismiss);
    this.element.remove();
  }
}
