import type { FragmentBlock, MarkdownOptions } from '@edit-ac/core';
import type { RetainedSelection } from '../dom/selection.js';
import type { DocumentSearchContext } from './search.js';
import type { EditorViewport } from '../platform/viewport.js';
import { selectionFragment } from '../clipboard/fragment.js';
import { inputTextDiagnostic, literalLineEndings } from '../input/characters.js';
import { touchPanel, touchTarget } from './touch-controls.js';

export type BaselineFormat = 'text' | 'markdown';
export interface FormatControlsOptions {
  viewport?: EditorViewport;
  contentCodecs?: MarkdownOptions;
  /** Cooperative local scheduling only; codecs and committed semantics remain owned. */
  schedule?(signal: AbortSignal): Promise<void>;
  /** A host may lower, never raise, the existing clipboard/codec byte bound. */
  maxBytes?: number;
}
export interface FormatControlsContext extends DocumentSearchContext {
  viewport?: EditorViewport;
  contentCodecs?: MarkdownOptions;
}
export type FormatControlsFactory = (context: FormatControlsContext) => FormatControls;
/** Explicit optional import. The default editor never references this module at
 * runtime, so bundlers can omit its implementation and assets when disabled. */
export function formatControls(options: FormatControlsOptions = {}): FormatControlsFactory {
  return context => {
    const contentCodecs = options.contentCodecs ?? context.contentCodecs;
    return new FormatControls(context, { ...options,
      ...(context.viewport ? { viewport: context.viewport } : {}), ...(contentCodecs ? { contentCodecs } : {}),
    });
  };
}
export interface FormatArtifact {
  readonly format: BaselineFormat;
  readonly filename: string;
  readonly mediaType: string;
  readonly revision: number;
  readonly text: string;
  readonly bytes: Uint8Array;
  readonly diagnostics: readonly string[];
}
const profiles = {
  text: { label: 'UTF-8 text (literal text; formatting is not retained)', mediaType: 'text/plain', extension: '.txt' },
  markdown: { label: 'Markdown (edit-ac-gfm-v1 semantic subset; diagnostics apply)', mediaType: 'text/markdown', extension: '.md' },
} as const;

/** Optional host-mounted baseline format UI. No converter registry, serializer,
 * document, history, permission probe or browser API work is created on import.
 * Binary adapters are deliberately unavailable until their own browser proof. */
export class FormatControls {
  readonly element: HTMLElement;
  readonly panel: HTMLElement;
  readonly status: HTMLElement;
  readonly input: HTMLInputElement;
  readonly importFormat: HTMLSelectElement;
  readonly exportFormat: HTMLSelectElement;
  readonly filename: HTMLInputElement;
  readonly preview: HTMLTextAreaElement;
  readonly output: HTMLTextAreaElement;
  readonly #buttons = new Map<string, HTMLButtonElement>();
  readonly #listeners: [EventTarget, string, EventListener][] = [];
  readonly #releaseViewport: (() => void) | undefined;
  readonly #limit: number;
  #target: RetainedSelection | undefined;
  #revision: number | undefined;
  #blocks: readonly FragmentBlock[] | undefined;
  #artifact: FormatArtifact | undefined;
  #job: AbortController | undefined;
  #url: string | undefined;
  #disposed = false;
  #readOnly = false;
  constructor(readonly context: DocumentSearchContext, readonly options: FormatControlsOptions = {}) {
    this.#limit = options.maxBytes ?? 1048576;
    if (!Number.isSafeInteger(this.#limit) || this.#limit < 1 || this.#limit > 1048576) throw Error('format-limit');
    const doc = context.root.ownerDocument;
    this.element = doc.createElement('div'); this.element.contentEditable = 'false';
    this.element.setAttribute('role', 'group'); this.element.setAttribute('aria-label', 'File and sharing controls');
    this.element.dataset.formatControls = '';
    const open = this.#button('open', 'File and sharing', () => this.panel.hidden ? this.show() : this.close());
    open.setAttribute('aria-expanded', 'false');
    this.panel = doc.createElement('div'); this.panel.hidden = true; touchPanel(this.panel); this.element.append(this.panel);
    const label = (name: string, field: HTMLElement) => { const text = doc.createElement('label'); text.append(name, field); this.panel.append(text); touchTarget(field); };
    this.importFormat = doc.createElement('select'); this.importFormat.setAttribute('aria-label', 'Import format');
    this.exportFormat = doc.createElement('select'); this.exportFormat.setAttribute('aria-label', 'Export format');
    for (const format of ['text', ...(context.engine.markdownAvailable ? ['markdown'] : [])] as BaselineFormat[]) {
      for (const select of [this.importFormat, this.exportFormat]) { const option = doc.createElement('option'); option.value = format; option.textContent = profiles[format].label; select.append(option); }
    }
    label('Import format ', this.importFormat); label('Export format ', this.exportFormat);
    const unavailable = doc.createElement('p'); unavailable.textContent = 'DOCX, ODT, RTF, EPUB, CSV/TSV and PDF export are unavailable in this browser integration. PDF is export-only; import is always rejected.'; this.panel.append(unavailable);
    this.input = doc.createElement('input'); this.input.type = 'file'; this.input.accept = '.txt,.md,text/plain,text/markdown';
    this.input.setAttribute('aria-label', 'Import file (file-input fallback)'); label('Choose a local file ', this.input);
    this.#listen(this.input, 'change', () => { const file = this.input.files?.[0]; if (file) void this.prepareImport(file); else this.cancel(); this.input.value = ''; });
    this.#listen(this.importFormat, 'change', () => { this.#blocks = undefined; this.#buttons.get('confirm')!.disabled = true; });
    this.#button('picker', 'Use system file picker', () => { void this.pick(); });
    this.#button('confirm', 'Confirm import', () => this.confirm()); this.#buttons.get('confirm')!.disabled = true;
    this.preview = doc.createElement('textarea'); this.preview.readOnly = true; this.preview.setAttribute('aria-label', 'Import source preview'); label('Import source (retained for recovery) ', this.preview);
    this.filename = doc.createElement('input'); this.filename.value = 'document.txt'; this.filename.maxLength = 255; this.filename.setAttribute('aria-label', 'Output filename'); label('Output filename ', this.filename);
    this.#button('prepare', 'Prepare export', () => { void this.prepareExport(); });
    this.output = doc.createElement('textarea'); this.output.readOnly = true; this.output.setAttribute('aria-label', 'Prepared export text'); label('Prepared output (selectable for manual copy) ', this.output);
    for (const [id, name] of [['save', 'Save file'], ['download', 'Download file'], ['share', 'Share file'], ['copy', 'Copy output'], ['manual', 'Select output for manual copy']] as const) {
      this.#button(id, name, () => { void this.deliver(id); });
    }
    this.#button('cancel', 'Cancel preparation', () => this.cancel());
    this.#button('close', 'Close file and sharing', () => this.close());
    this.status = doc.createElement('span'); this.status.setAttribute('role', 'status'); this.status.setAttribute('aria-live', 'polite'); this.panel.append(this.status);
    this.#listen(open, 'pointerdown', event => { this.#capture(); if ((event as PointerEvent).pointerType === 'touch') open.focus({ preventScroll: true }); else event.preventDefault(); });
    this.#listen(open, 'pointercancel', () => this.#releaseTarget());
    this.#listen(this.element, 'keydown', event => { const key = event as KeyboardEvent; if (key.isComposing) return; if (key.key === 'Escape') { key.preventDefault(); this.close(); } else if (key.key === 'Enter' && event.target instanceof doc.defaultView!.HTMLInputElement && event.target !== this.input) key.preventDefault(); });
    this.#listen(context.root, 'compositionstart', () => this.cancel());
    this.#releaseViewport = options.viewport?.addControls(this.element);
  }
  #listen(target: EventTarget, type: string, listener: EventListener): void { target.addEventListener(type, listener); this.#listeners.push([target, type, listener]); }
  #button(id: string, label: string, action: () => void): HTMLButtonElement {
    const button = this.context.root.ownerDocument.createElement('button'); button.type = 'button'; button.textContent = label; touchTarget(button);
    // WebKit does not focus buttons on touch activation. The opening control
    // captures its native selection before focus in its own pointer handler.
    if (id !== 'open') this.#listen(button, 'pointerdown', event => { if ((event as PointerEvent).pointerType === 'touch') button.focus({ preventScroll: true }); });
    this.#listen(button, 'click', () => { if (id !== 'open') button.focus({ preventScroll: true }); action(); });
    this.#buttons.set(id, button); (this.panel ?? this.element).append(button); return button;
  }
  #blocked(write = false): boolean {
    return this.#disposed || !this.context.root.isConnected || this.context.selection.suspended || !!this.context.blocked?.() ||
      this.context.root.getAttribute('aria-busy') === 'true' || (write && (this.#readOnly || this.context.root.getAttribute('aria-readonly') === 'true'));
  }
  #message(text: string): void { if (!this.#disposed) this.status.textContent = text; }
  #releaseTarget(): void { this.#target?.dispose(); this.#target = undefined; this.#revision = undefined; this.#blocks = undefined; this.#buttons.get('confirm')!.disabled = true; }
  #capture(): void {
    this.#releaseTarget(); if (this.#blocked(true)) return;
    this.#target = this.context.selection.retain(); this.#revision = this.context.engine.read().revision;
  }
  #validTarget(): boolean { return !this.#blocked(true) && !!this.#target?.active && this.#revision === this.context.engine.read().revision; }
  #begin(): AbortController | undefined {
    if (this.#blocked() || this.#job) return;
    const job = new AbortController(); this.#job = job; return job;
  }
  #active(job: AbortController): boolean { return !job.signal.aborted && !this.#blocked() && this.#job === job; }
  #end(job: AbortController): void { if (this.#job === job) this.#job = undefined; }
  #checkBytes(value: string): Uint8Array { if (value.length > this.#limit) throw Error('format-byte-limit'); const bytes = new TextEncoder().encode(value); if (bytes.length > this.#limit) throw Error('format-byte-limit'); return bytes; }
  show(): void {
    if (this.#blocked()) return;
    if (!this.#target) this.#capture();
    this.panel.hidden = false; this.#buttons.get('open')!.setAttribute('aria-expanded', 'true'); this.#message('Choose a file to preview, or explicitly prepare an export. No file or permission request has started.');
  }
  close(): void { this.cancel(); this.panel.hidden = true; this.#buttons.get('open')!.setAttribute('aria-expanded', 'false'); this.#buttons.get('open')!.focus({ preventScroll: true }); }
  setReadOnly(value: boolean): void { this.#readOnly = value; if (value) this.cancel(); }
  cancel(): void {
    this.#job?.abort(); this.#job = undefined; this.#releaseTarget();
    this.#message('Canceled. The document is unchanged by this action; prepared output and preview remain available for recovery.');
  }
  async pick(): Promise<void> {
    const job = this.#begin(); if (!job) return;
    try {
      if (!this.#validTarget()) throw Error('import-target-unavailable; close and reopen at the intended selection');
      const w = this.context.root.ownerDocument.defaultView!;
      const picker = (w as unknown as { showOpenFilePicker?: () => Promise<{ getFile(): Promise<File> }[]> }).showOpenFilePicker;
      if (!w.isSecureContext || !w.navigator.userActivation?.isActive || typeof picker !== 'function') throw Error('system-picker-unavailable; use Choose a local file');
      const handles = await picker.call(w); if (!this.#active(job) || !handles[0]) return;
      const file = await handles[0].getFile(); if (!this.#active(job)) return;
      this.#end(job); await this.prepareImport(file);
    } catch (error) { if (this.#active(job)) this.#message(`${this.#reason(error)}. Use the file-input fallback.`); }
    finally { this.#end(job); }
  }
  async prepareImport(file: File): Promise<void> {
    const job = this.#begin(); if (!job) return;
    this.#blocks = undefined; this.#buttons.get('confirm')!.disabled = true;
    this.#message('Preparing import preview. Cancel preparation is available; no document change is confirmed.');
    try {
      if (!this.#validTarget()) throw Error('import-target-unavailable; close and reopen at the intended selection');
      if (file.size > this.#limit) throw Error('format-byte-limit');
      if (/\.pdf$/i.test(file.name) || file.type === 'application/pdf') throw Error('FORMAT_EXPORT_ONLY');
      const format = this.importFormat.value as BaselineFormat;
      const bytes = new Uint8Array(await file.arrayBuffer());
      if (!this.#active(job)) return;
      if (bytes.length > this.#limit) throw Error('format-byte-limit');
      if (String.fromCharCode(...bytes.subarray(0, 5)) === '%PDF-') throw Error('FORMAT_EXPORT_ONLY');
      const source = new TextDecoder('utf-8', { fatal: true }).decode(bytes); this.#checkBytes(source); this.preview.value = source;
      await this.options.schedule?.(job.signal);
      if (!this.#active(job)) return;
      if (!this.#validTarget() || this.importFormat.value !== format) throw Error('import-target-or-format-changed');
      const diagnostic = inputTextDiagnostic(source); if (diagnostic) throw Error(diagnostic);
      let diagnostics: readonly { code: string }[] = [];
      if (format === 'markdown') {
        if (!this.context.engine.markdownAvailable) throw Error('markdown-codec-unavailable');
        const prepared = this.context.engine.importMarkdown(source, this.options.contentCodecs); this.#blocks = prepared.blocks; diagnostics = prepared.diagnostics;
      } else if (format === 'text') this.#blocks = [{ attributes: null, runs: [{ text: literalLineEndings(source), marks: [] }] }];
      else throw Error('format-unavailable');
      const raw = JSON.stringify({ version: 1, schema: this.context.engine.read().identity.schema, blocks: this.#blocks });
      this.#checkBytes(raw);
      // These are internal codec/literal blocks, not an external fragment
      // envelope. The existing prepared command admits null/inherited styles.
      const plan = this.context.engine.prepare({ kind: 'fragment', origin: 'format-import-preview', range: this.#target!.range, blocks: this.#blocks! });
      this.context.engine.releasePlan(plan);
      this.#buttons.get('confirm')!.textContent = diagnostics.length ? 'Confirm import with reported diagnostics' : 'Confirm import';
      this.#buttons.get('confirm')!.disabled = false;
      this.#message(`Preview ready; document unchanged. ${profiles[format].label}. ${diagnostics.map(d => d.code).join(', ')}`);
    } catch (error) { this.#blocks = undefined; if (this.#active(job)) this.#message(`Import not prepared: ${this.#reason(error)}. Original file remains with you; preview is retained when decoded.`); }
    finally { this.#end(job); }
  }
  confirm(): void {
    if (this.#job) return;
    try {
      if (!this.#blocks || !this.#validTarget()) throw Error('import-target-changed; close and reopen to preview again');
      this.context.engine.history({ type: 'explicit' });
      try {
        const result = this.context.commit({ kind: 'fragment', origin: 'format-import', range: this.#target!.range, blocks: this.#blocks });
        for (const anchor of new Set([result.caret, result.selection?.anchor, result.selection?.focus])) if (anchor) this.context.engine.releaseAnchor(anchor);
      } finally { this.context.engine.history({ type: 'boundary' }); }
      this.#message('Import applied as one editor command. Local durability follows the existing Session save state.');
    } catch (error) { this.#message(`Import not applied: ${this.#reason(error)}. Preview retained.`); }
    finally { this.#releaseTarget(); }
  }
  async prepareExport(): Promise<void> {
    const job = this.#begin(); if (!job) return;
    this.#message('Preparing captured export. Cancel preparation is available; no file or share request has started.');
    try {
      const format = this.exportFormat.value as BaselineFormat, filename = this.filename.value;
      if (!filename || filename.length > 255 || /[\x00-\x1f\x7f/\\]/.test(filename)) throw Error('invalid-output-filename');
      const snapshot = this.context.engine.read(), nodes = snapshot.visible.filter(n => n.kind === 'block');
      if (!nodes.length || nodes.length > 4096) throw Error('format-node-limit');
      if (nodes.reduce((n, node) => n + node.runs.reduce((sum, r) => sum + r.text.length, 0), 0) > this.#limit) throw Error('format-byte-limit');
      const anchor = this.context.engine.anchor(nodes[0]!.id, 0, 'right');
      const last = nodes[nodes.length - 1]!;
      const focus = this.context.engine.anchor(last.id, last.runs.reduce((n, r) => n + r.text.length, 0), 'left');
      let text: string, diagnostics: readonly string[] = [];
      try {
        const selected = selectionFragment(this.context.engine, { anchor, focus });
        if (!selected) throw Error('empty-export');
        if (format === 'markdown') {
          if (!this.context.engine.markdownAvailable) throw Error('markdown-codec-unavailable');
          const result = this.context.engine.exportMarkdown(selected.encode().fragment.blocks, this.options.contentCodecs);
          text = result.markdown; diagnostics = result.diagnostics.map(d => d.code);
        } else if (format === 'text') text = selected.plain;
        else throw Error('format-unavailable');
      } finally { this.context.engine.releaseAnchor(anchor); this.context.engine.releaseAnchor(focus); }
      const bytes = this.#checkBytes(text);
      await this.options.schedule?.(job.signal);
      if (!this.#active(job)) return;
      // A disposed/replaced engine cannot publish a late artifact for another session.
      if (JSON.stringify(this.context.engine.read().identity) !== JSON.stringify(snapshot.identity)) throw Error('export-session-changed');
      this.#revoke(); this.#artifact = { format, filename, mediaType: profiles[format].mediaType, revision: snapshot.revision, text, bytes, diagnostics };
      this.output.value = text; this.#message(`Prepared revision ${snapshot.revision}; not saved or shared. ${profiles[format].label}. ${diagnostics.join(', ')}`);
    } catch (error) { if (this.#active(job)) this.#message(`Export not prepared: ${this.#reason(error)}. Previous output, if any, remains recoverable.`); }
    finally { this.#end(job); }
  }
  get artifact(): FormatArtifact | undefined { return this.#artifact ? { ...this.#artifact, bytes: this.#artifact.bytes.slice(), diagnostics: [...this.#artifact.diagnostics] } : undefined; }
  get disposed(): boolean { return this.#disposed; }
  get busy(): boolean { return !!this.#job; }
  async deliver(action: 'save' | 'download' | 'share' | 'copy' | 'manual'): Promise<void> {
    const artifact = this.#artifact; if (!artifact || this.#blocked() || this.#job) return;
    if (action === 'manual') { this.output.focus(); this.output.select(); this.#message('Output selected. Use the native Copy menu, then paste into a file or another app. Delivery is unverified.'); return; }
    const job = this.#begin(); if (!job) return;
    const w = this.context.root.ownerDocument.defaultView!, n = w.navigator;
    try {
      if (!w.isSecureContext || !n.userActivation?.isActive) throw Error('explicit-user-activation-required');
      const file = new w.File([artifact.bytes.slice() as Uint8Array<ArrayBuffer>], artifact.filename, { type: artifact.mediaType });
      if (action === 'share') {
        const data = { files: [file] };
        if (typeof n.share !== 'function' || typeof n.canShare !== 'function' || !n.canShare(data)) throw Error('file-share-unavailable');
        await n.share(data); if (this.#active(job)) this.#message('Share request completed; recipient delivery is unverified. Prepared output remains available.');
      } else if (action === 'copy') {
        if (typeof n.clipboard?.writeText !== 'function') throw Error('clipboard-unavailable');
        await n.clipboard.writeText(artifact.text); if (this.#active(job)) this.#message('Clipboard API accepted the output; pasting into the destination remains your next step.');
      } else if (action === 'download') {
        this.#revoke(); this.#url = w.URL.createObjectURL(file);
        const link = w.document.createElement('a'); link.href = this.#url; link.download = artifact.filename; link.hidden = true; this.element.append(link);
        try { link.click(); } finally { link.remove(); }
        this.#message('Download requested; actual file delivery is unverified. If no file appears, select the retained output for manual copy.');
      } else {
        type Writer = { write(data: File): Promise<void>; close(): Promise<void>; abort(): Promise<void> };
        const picker = (w as unknown as { showSaveFilePicker?: (options: unknown) => Promise<{ createWritable(): Promise<Writer> }> }).showSaveFilePicker;
        if (typeof picker !== 'function') throw Error('file-save-unavailable');
        const handle = await picker.call(w, { suggestedName: artifact.filename }); if (!this.#active(job)) return;
        const writer = await handle.createWritable();
        const abort = () => { void writer.abort().catch(() => {}); };
        if (!this.#active(job)) { abort(); return; }
        job.signal.addEventListener('abort', abort, { once: true });
        try { await writer.write(file); if (!this.#active(job)) return; await writer.close(); }
        catch (error) { abort(); throw error; }
        finally { job.signal.removeEventListener('abort', abort); }
        if (this.#active(job)) this.#message(`File API write and close completed for revision ${artifact.revision}; destination durability is unverified.`);
      }
    } catch (error) { if (this.#active(job)) this.#message(`${this.#reason(error)}. Output retained: retry Download file or Select output for manual copy. No delivery is claimed.`); }
    finally { this.#end(job); }
  }
  #reason(error: unknown): string { return error instanceof Error ? error.name === 'AbortError' ? 'Canceled by the user' : error.message : 'Unavailable or denied'; }
  #revoke(): void { if (this.#url) { this.context.root.ownerDocument.defaultView!.URL.revokeObjectURL(this.#url); this.#url = undefined; } }
  dispose(): void {
    if (this.#disposed) return; this.cancel(); this.#disposed = true; this.#revoke(); this.#releaseViewport?.();
    for (const [target, type, listener] of this.#listeners.splice(0)) target.removeEventListener(type, listener);
    this.#artifact = undefined; this.preview.value = ''; this.output.value = ''; this.element.remove();
  }
}
