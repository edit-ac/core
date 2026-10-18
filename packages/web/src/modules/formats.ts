import type { EngineHandle, StableRange, FragmentBlock, MarkdownOptions, AssetGrant } from '@edit-ac/core';
import type { EditorStorageOwner } from '../storage/owner.js';
import type { AssetHostTransport, PreparedAssetCommitReceipt } from '../sync/assets.js';
import type { RetainedSelection } from '../dom/selection.js';
import type { DocumentSearchContext } from './search.js';
import type { EditorViewport } from '../platform/viewport.js';
import { selectionFragment } from '../clipboard/fragment.js';
import { inputTextDiagnostic, literalLineEndings } from '../input/characters.js';
import { touchPanel, touchTarget } from './touch-controls.js';
import { browserFormatProfiles, type FormatProfileSource, type FormatProfileDirection } from './format-profiles.js';
export type { FormatProfileSource, FormatProfileDirection } from './format-profiles.js';

export type BaselineFormat = 'text' | 'markdown';
export type DocumentFormat = 'rtf' | 'csv' | 'tsv' | 'docx' | 'odt' | 'epub' | 'pdf';
/** Structural port for the optional public createFormatClient. The host pins the
 * client and metadata to the same qualified package. No base dependency/loader. */
export interface PreparedDocumentImport {
  profile: string; revision: number; blocks: readonly FragmentBlock[]; sessionCommitted: boolean;
  diagnostics: readonly Record<string, unknown>[];
  commitAssets?(owner: EditorStorageOwner, job: string, host: AssetHostTransport, sourceGrant: AssetGrant): Promise<PreparedAssetCommitReceipt>;
}
export interface FormatImportAuthority {
  importGrants: readonly (AssetGrant & { sha256: readonly number[] })[];
  sourceGrant: AssetGrant;
  host: AssetHostTransport;
}
export interface DocumentFormatClient {
  prepareImport(engine: EngineHandle, options: DocumentFormatRequest & { source: Uint8Array; range: StableRange }): Promise<PreparedDocumentImport>;
  export(engine: EngineHandle, options: DocumentFormatRequest): Promise<{
    profile: string; revision: number; bytes: Uint8Array; diagnostics: readonly Record<string, unknown>[];
  }>;
  cancel(): void;
  dispose(): void;
}
export interface DocumentFormatRequest {
  format: DocumentFormat; signal: AbortSignal; filename: string; mediaType: string;
  newline: 'lf' | 'crlf'; header: boolean; approveLoss: boolean; selected?: string;
  importGrants?: FormatImportAuthority['importGrants'];
}
export interface FormatControlsOptions {
  viewport?: EditorViewport;
  contentCodecs?: MarkdownOptions;
  /** Cooperative local scheduling only; codecs and committed semantics remain owned. */
  schedule?(signal: AbortSignal): Promise<void>;
  /** A host may lower, never raise, the existing clipboard/codec byte bound. */
  maxBytes?: number;
  /** Host-authenticated installed metadata; called only by the named control.
   * Loaders must honor the signal and enforce a bounded local transport. */
  loadProfiles?(signal: AbortSignal): Promise<FormatProfileSource>;
  /** Explicitly loaded on preparation, after authenticated metadata is shown.
   * Ownership transfers to these controls, including late canceled loads. */
  loadClient?(signal: AbortSignal): Promise<DocumentFormatClient>;
  /** Explicit local host approval; no inferred authority from document locators.
   * Called on file selection, before conversion; opening the menu grants nothing. */
  authorizeImport?(file: File, signal: AbortSignal): Promise<FormatImportAuthority>;
}
export interface FormatControlsContext extends DocumentSearchContext {
  viewport?: EditorViewport;
  contentCodecs?: MarkdownOptions;
  storageOwner?: EditorStorageOwner;
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
  readonly format: BaselineFormat | DocumentFormat;
  readonly filename: string;
  readonly mediaType: string;
  readonly revision: number;
  readonly text: string;
  readonly bytes: Uint8Array;
  readonly diagnostics: readonly string[];
}
const documentMediaTypes: Record<DocumentFormat, string> = {
  rtf: 'application/rtf', csv: 'text/csv', tsv: 'text/tab-separated-values',
  docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  odt: 'application/vnd.oasis.opendocument.text', epub: 'application/epub+zip', pdf: 'application/pdf',
};
const profiles = {
  text: { label: 'UTF-8 text (literal text; formatting is not retained)', mediaType: 'text/plain', extension: '.txt' },
  markdown: { label: 'Markdown (edit-ac-gfm-v1 semantic subset; diagnostics apply)', mediaType: 'text/markdown', extension: '.md' },
} as const;

/** Optional host-mounted baseline format UI. No converter registry, serializer,
 * document, history, permission probe or browser API work is created on import.
 * Hosts may connect a qualified optional public format client explicitly. */
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
  readonly profileCatalog: HTMLElement;
  readonly fallbacks: HTMLElement;
  readonly newline: HTMLSelectElement;
  readonly header: HTMLInputElement;
  readonly approveLoss: HTMLInputElement;
  readonly table: HTMLSelectElement;
  readonly #buttons = new Map<string, HTMLButtonElement>();
  readonly #listeners: [EventTarget, string, EventListener][] = [];
  readonly #releaseViewport: (() => void) | undefined;
  readonly #limit: number;
  /** Exact caller File retained independently of decoded preview, including rejection. */
  recovery: File | undefined;
  receipt: PreparedAssetCommitReceipt | undefined;
  #prepared: { value: PreparedDocumentImport; authority: FormatImportAuthority } | undefined;
  #previewAbort: AbortController | undefined;
  #confirmation: Promise<void> | undefined;
  #profiles: readonly FormatProfileDirection[] = [];
  #client: DocumentFormatClient | undefined;
  #target: RetainedSelection | undefined;
  #revision: number | undefined;
  #blocks: readonly FragmentBlock[] | undefined;
  #artifact: FormatArtifact | undefined;
  #job: AbortController | undefined;
  #url: string | undefined;
  #disposed = false;
  #readOnly = false;
  constructor(readonly context: FormatControlsContext, readonly options: FormatControlsOptions = {}) {
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
      for (const select of [this.importFormat, this.exportFormat]) { const option = doc.createElement('option'); option.value = format; option.textContent = `${select === this.importFormat ? 'Import' : 'Export'}: ${profiles[format].label}`; select.append(option); }
    }
    label('Import format ', this.importFormat); label('Export format ', this.exportFormat);
    const unavailable = doc.createElement('p'); unavailable.textContent = options.loadClient && options.loadProfiles
      ? 'Show installed format profiles to enable qualified document actions. PDF is export-only. Original media adoption requires an asset-enabled host; unsupported content is reported before any change.'
      : 'DOCX, ODT, RTF, EPUB, CSV/TSV and PDF export are unavailable in this browser integration. PDF is export-only; import is always rejected.'; this.panel.append(unavailable);
    this.profileCatalog = doc.createElement('section'); this.profileCatalog.setAttribute('aria-label', 'Installed document format profiles');
    this.profileCatalog.textContent = options.loadProfiles ? 'Installed converter metadata has not been loaded. Baseline text and optional Markdown actions are available below.' : 'No installed document-format profile source is connected. Baseline text and optional Markdown actions are available below.'; this.panel.append(this.profileCatalog);
    if (options.loadProfiles) this.#button('profiles', 'Show installed format profiles', () => { void this.showProfiles(); });
    this.fallbacks = doc.createElement('p'); this.fallbacks.setAttribute('aria-label', 'File and sharing alternatives'); this.panel.append(this.fallbacks);
    this.newline = doc.createElement('select'); this.newline.setAttribute('aria-label', 'Table file line endings');
    for (const [value, name] of [['lf', 'LF'], ['crlf', 'CRLF']]) { const option = doc.createElement('option'); option.value = value!; option.textContent = name!; this.newline.append(option); }
    label('CSV/TSV explicit dialect ', this.newline);
    this.header = doc.createElement('input'); this.header.type = 'checkbox'; label('CSV/TSV first row is a header ', this.header);
    this.approveLoss = doc.createElement('input'); this.approveLoss.type = 'checkbox'; label('Approve reported format loss ', this.approveLoss);
    this.table = doc.createElement('select'); this.table.setAttribute('aria-label', 'Table to export'); label('CSV/TSV chosen table ', this.table);
    this.#refreshTables();
    this.input = doc.createElement('input'); this.input.type = 'file'; this.input.accept = '.txt,.md,text/plain,text/markdown';
    this.input.setAttribute('aria-label', 'Import file (file-input fallback)'); label('Choose a local file ', this.input);
    this.#listen(this.input, 'change', () => { const file = this.input.files?.[0]; if (file) void this.prepareImport(file); else this.cancel(); this.input.value = ''; });
    const invalidate = () => { this.#job?.abort(); this.#client?.cancel(); this.#job = undefined; this.#blocks = undefined; this.#prepared = undefined; this.#previewAbort?.abort(); this.#buttons.get('confirm')!.disabled = true; };
    for (const field of [this.importFormat, this.newline, this.header, this.approveLoss]) this.#listen(field, 'change', invalidate);
    this.#button('picker', 'Use system file picker', () => { void this.pick(); });
    this.#button('confirm', 'Confirm import', () => { void this.confirm(); });
    this.#button('original', 'Download original file', () => this.downloadOriginal()); this.#buttons.get('confirm')!.disabled = true;
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
    this.#listen(doc, 'visibilitychange', () => { if (doc.visibilityState === 'hidden') this.cancel(); });
    this.#listen(doc.defaultView!, 'pagehide', () => this.cancel());
    this.#listen(this.input, 'cancel', () => this.cancel());
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
  #releaseTarget(): void { this.#previewAbort?.abort(); this.#previewAbort = undefined; this.#prepared = undefined; this.#target?.dispose(); this.#target = undefined; this.#revision = undefined; this.#blocks = undefined; this.#buttons.get('confirm')!.disabled = true; }
  #capture(): void {
    this.cancel(); if (this.#blocked(true)) return;
    this.#target = this.context.selection.retain(); this.#revision = this.context.engine.read().revision;
  }
  #validTarget(): boolean { return !this.#blocked(true) && !!this.#target?.active && this.#revision === this.context.engine.read().revision; }
  #begin(): AbortController | undefined {
    if (this.#blocked() || this.#job || this.#confirmation) return;
    const job = new AbortController(); this.#job = job; return job;
  }
  #active(job: AbortController): boolean { return !job.signal.aborted && !this.#blocked() && this.#job === job; }
  #end(job: AbortController): void { if (this.#job === job) this.#job = undefined; }
  #checkBytes(value: string): Uint8Array { if (value.length > this.#limit) throw Error('format-byte-limit'); const bytes = new TextEncoder().encode(value); if (bytes.length > this.#limit) throw Error('format-byte-limit'); return bytes; }
  show(): void {
    if (this.#blocked()) return;
    if (!this.#target) this.#capture();
    this.#refreshTables(); this.panel.hidden = false; this.#buttons.get('open')!.setAttribute('aria-expanded', 'true'); this.#describeFallbacks(); this.#message('Choose a file to preview, or explicitly prepare an export. No file or permission request has started.');
  }
  #describeFallbacks(): void {
    const w = this.context.root.ownerDocument.defaultView!, n = w.navigator;
    const pickers = w as unknown as { showOpenFilePicker?: unknown; showSaveFilePicker?: unknown };
    const available = (value: unknown) => typeof value === 'function' ? 'available for an explicit tap; permission may be refused' : 'unavailable';
    this.fallbacks.textContent = `System file picker: ${available(pickers.showOpenFilePicker)}. Use Choose a local file (file-input fallback). ` +
      `System file save: ${available(pickers.showSaveFilePicker)}. Use Download file; delivery remains unverified. ` +
      `File sharing: ${available(typeof n.canShare === 'function' ? n.share : undefined)}. Clipboard: ${available(n.clipboard?.writeText)}. ` +
      'If refused, download the retained output. For text output, Select output for manual copy using the native Copy menu. ' +
      (!w.isSecureContext || !n.userActivation?.isActive ? 'Advanced actions require a secure context and a fresh explicit tap. ' : '') +
      'No permission has been requested; API presence does not establish permission or delivery.';
  }
  async showProfiles(): Promise<void> {
    if (!this.options.loadProfiles) return;
    const job = this.#begin(); if (!job) return;
    this.#message('Loading installed profile metadata; no conversion has started.');
    try {
      const source = await this.options.loadProfiles(job.signal);
      if (!this.#active(job)) return;
      const rows = browserFormatProfiles(source), doc = this.context.root.ownerDocument;
      const enabled = !!this.options.loadClient;
      const heading = doc.createElement('p'); heading.textContent = `Installed package: ${source.provenance}. ${enabled ? 'Qualified document actions are available in the selectors. Preparation starts only on an explicit request.' : 'These document-format actions are unavailable here; use the text or Markdown controls below.'} PDF is export-only.`;
      const list = doc.createElement('ul');
      for (const row of rows) { const item = doc.createElement('li'); item.textContent = `${row.format.toUpperCase()} ${row.direction}: ${row.profile}; fidelity: ${row.fidelity}`; list.append(item); }
      this.profileCatalog.replaceChildren(heading, list);
      if (enabled) {
        this.#profiles = rows;
        for (const select of [this.importFormat, this.exportFormat]) {
          for (const option of [...select.options]) if (option.dataset.documentProfile) option.remove();
          for (const row of rows.filter(row => row.direction === (select === this.importFormat ? 'import' : 'export'))) {
            const option = doc.createElement('option'); option.value = row.format; option.dataset.documentProfile = row.profile;
            option.textContent = `${row.direction === 'import' ? 'Import' : 'Export'}: ${row.format.toUpperCase()} — ${row.profile}; fidelity: ${row.fidelity}`; select.append(option);
          }
        }
        this.input.accept = '.txt,.md,text/plain,text/markdown,' + rows.filter(row => row.direction === 'import').map(row => `.${row.format}`).join(',');
      }
      this.#message('Installed profiles listed. Choose an available action below; no conversion or permission request has started.');
    } catch (error) {
      if (this.#active(job)) {
        this.profileCatalog.textContent = 'Installed profiles unavailable. Baseline file-input, download and selectable-text recovery remain available.';
        this.#message(`${this.#reason(error)}. Retry Show installed format profiles; no document change.`);
      }
    } finally { this.#end(job); }
  }
  #refreshTables(): void {
    const previous = this.table.value; this.table.replaceChildren();
    const doc = this.context.root.ownerDocument, placeholder = doc.createElement('option');
    placeholder.value = ''; placeholder.textContent = 'Choose one table explicitly'; this.table.append(placeholder);
    for (const node of this.context.engine.read().visible) {
      if (!Array.isArray(node.blockAttributes) || node.blockAttributes[0] !== 'module:editac.table') continue;
      const option = doc.createElement('option'); option.value = node.id; option.textContent = `Table ${node.id}`; this.table.append(option);
    }
    if ([...this.table.options].some(option => option.value === previous)) this.table.value = previous;
  }
  #profile(format: string, direction: 'import' | 'export'): FormatProfileDirection {
    const row = this.#profiles.find(row => row.format === format && row.direction === direction);
    if (!row || !this.options.loadClient) throw Error('format-unavailable; show installed profiles first');
    return row;
  }
  #request(format: string, job: AbortController, filename: string, mediaType: string): DocumentFormatRequest {
    return { format: format as DocumentFormat, signal: job.signal, filename, mediaType,
      newline: this.newline.value as 'lf' | 'crlf', header: this.header.checked, approveLoss: this.approveLoss.checked,
      ...(this.table.value ? { selected: this.table.value } : {}) };
  }
  async #formatClient(job: AbortController): Promise<DocumentFormatClient | undefined> {
    if (this.#client) return this.#client;
    const client = await this.options.loadClient!(job.signal);
    if (!this.#active(job)) { client.dispose(); return; }
    this.#client = client; return client;
  }
  close(): void { this.cancel(); this.panel.hidden = true; this.#buttons.get('open')!.setAttribute('aria-expanded', 'false'); this.#buttons.get('open')!.focus({ preventScroll: true }); }
  setReadOnly(value: boolean): void { this.#readOnly = value; if (value) this.cancel(); }
  cancel(): void {
    this.#job?.abort(); this.#client?.cancel(); this.#job = undefined; this.#releaseTarget();
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
    this.recovery = file; this.receipt = undefined;
    this.#previewAbort?.abort(); this.#previewAbort = job; this.#prepared = undefined;
    const target = this.#target, format = this.importFormat.value;
    this.#blocks = undefined; this.#buttons.get('confirm')!.disabled = true;
    this.#message('Preparing import preview. Cancel preparation is available; no document change is confirmed.');
    try {
      if (!this.#validTarget()) throw Error('import-target-unavailable; close and reopen at the intended selection');
      if (file.size > this.#limit) throw Error('format-byte-limit');
      if (/\.pdf$/i.test(file.name) || file.type === 'application/pdf') throw Error('FORMAT_EXPORT_ONLY');
      const bytes = new Uint8Array(await file.arrayBuffer());
      if (!this.#active(job)) return;
      if (this.#target !== target || !this.#validTarget()) throw Error('import-target-changed');
      if (bytes.length > this.#limit) throw Error('format-byte-limit');
      if (String.fromCharCode(...bytes.subarray(0, 5)) === '%PDF-') throw Error('FORMAT_EXPORT_ONLY');
      if (format !== 'text' && format !== 'markdown') {
        const row = this.#profile(format, 'import'), request = this.#request(format, job, file.name, file.type);
        this.preview.value = `Original file retained for Download original file: ${file.name} (${bytes.length} bytes). ${row.profile}; fidelity: ${row.fidelity}.`;
        const client = await this.#formatClient(job); if (!client || !this.#active(job)) return;
        const supplied = await this.options.authorizeImport?.(file, job.signal);
        if (!this.#active(job)) return;
        if (this.#target !== target || !this.#validTarget()) throw Error('import-target-changed');
        const authority = supplied ? { ...supplied, importGrants: structuredClone(supplied.importGrants), sourceGrant: structuredClone(supplied.sourceGrant) } : undefined;
        const prepared = await client.prepareImport(this.context.engine, { ...request, ...(authority ? { importGrants: authority.importGrants } : {}), source: bytes, range: target!.range });
        if (!this.#active(job)) return;
        if (this.#target !== target || !this.#validTarget() || this.importFormat.value !== format || prepared.revision !== this.#revision) throw Error('import-target-or-format-changed');
        if (prepared.profile !== row.profile) throw Error('format-profile-mismatch');
        const media = prepared.blocks.some(block => block.attributes?.type === 'content' && Array.isArray(block.attributes.tuple) && block.attributes.tuple[0] === 'module:editac.asset');
        if (media && (!authority || !prepared.commitAssets || !this.context.storageOwner)) throw Error('AssetOwnerRequired');
        // Media is a candidate until commitAssets stages/adopts it; the worker must not commit it.
        if ((!media && !prepared.sessionCommitted) || (!request.approveLoss && prepared.diagnostics.some(d => d.lossy))) throw Error(`LossApprovalRequired: ${prepared.diagnostics.map(d => d.code).join(', ')}. Review diagnostics, explicitly approve reported loss, then choose the file again`);
        const plan = this.context.engine.prepare({kind:'fragment', origin:'format-import-preview', range:this.#target!.range, blocks:prepared.blocks});
        this.context.engine.releasePlan(plan); this.#blocks = prepared.blocks;
        if (media) this.#prepared = { value: prepared, authority: authority! };
        this.#buttons.get('confirm')!.disabled = false;
        this.#buttons.get('confirm')!.textContent = prepared.diagnostics.length ? 'Confirm import with reported diagnostics' : 'Confirm import';
        this.#message(`Preview ready; document unchanged. ${row.profile}; fidelity: ${row.fidelity}. ${prepared.diagnostics.map(d => d.code).join(', ')}`); return;
      }
      const source = new TextDecoder('utf-8', { fatal: true }).decode(bytes); this.#checkBytes(source); this.preview.value = source;
      await this.options.schedule?.(job.signal);
      if (!this.#active(job)) return;
      if (this.#target !== target || !this.#validTarget() || this.importFormat.value !== format) throw Error('import-target-or-format-changed');
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
  confirm(): Promise<void> {
    if (this.#confirmation) return this.#confirmation;
    const promise = this.#confirm(); this.#confirmation = promise;
    void promise.finally(() => { if (this.#confirmation === promise) this.#confirmation = undefined; });
    return promise;
  }
  async settle(): Promise<void> { await this.#confirmation; }
  async #confirm(): Promise<void> {
    const job = this.#begin(); if (!job) return;
    const target = this.#target;
    try {
      if (!this.#blocks || !this.#validTarget()) throw Error('import-target-changed; close and reopen to preview again');
      if (this.#prepared) {
        const { value, authority } = this.#prepared;
        this.#buttons.get('confirm')!.disabled = true;
        this.#message('Adopting approved originals; cancel remains available.');
        this.receipt = await value.commitAssets!(this.context.storageOwner!, `format_${crypto.randomUUID().replaceAll('-', '')}`, authority.host, authority.sourceGrant);
        const result = this.receipt.content;
        try {
          if (this.#target === target && this.#active(job)) {
            if (result.selection) this.context.selection.restoreRange(result.selection);
            else if (result.caret) this.context.selection.move(result.caret);
          }
        } finally {
          for (const anchor of new Set([result.caret, result.selection?.anchor, result.selection?.focus])) if (anchor) this.context.engine.releaseAnchor(anchor);
          this.receipt = { ...this.receipt, content: { revision: result.revision } };
        }
        // Durable transaction won any concurrent cancel; report its actual receipt.
        this.#message('Import applied as one editor command with atomic local original/media adoption; host delivery is separate.');
        return;
      }
      this.context.engine.history({ type: 'explicit' });
      try {
        const result = this.context.commit({ kind: 'fragment', origin: 'format-import', range: this.#target!.range, blocks: this.#blocks });
        for (const anchor of new Set([result.caret, result.selection?.anchor, result.selection?.focus])) if (anchor) this.context.engine.releaseAnchor(anchor);
      } finally { this.context.engine.history({ type: 'boundary' }); }
      this.#message('Import applied as one editor command. Local durability follows the existing Session save state.');
    } catch (error) { this.#message(`Import not applied: ${this.#reason(error)}. Preview retained.`); }
    finally { if (this.#target === target) this.#releaseTarget(); this.#end(job); }
  }
  downloadOriginal(): void {
    if (this.#disposed || !this.recovery) return;
    const w = this.context.root.ownerDocument.defaultView!; this.#revoke();
    this.#url = w.URL.createObjectURL(this.recovery);
    const link = w.document.createElement('a'); link.href = this.#url; link.download = this.recovery.name; link.hidden = true; this.element.append(link);
    try { link.click(); } finally { link.remove(); }
    this.#message('Original-file download requested; actual device delivery is unverified. The selected File remains retained.');
  }
  async prepareExport(): Promise<void> {
    const job = this.#begin(); if (!job) return;
    this.#message('Preparing captured export. Cancel preparation is available; no file or share request has started.');
    try {
      const captured = this.context.engine.read();
      const identity = JSON.stringify(captured.identity), revision = captured.revision;
      const format = this.exportFormat.value, filename = this.filename.value;
      if (!filename || filename.length > 255 || /[\x00-\x1f\x7f/\\]/.test(filename)) throw Error('invalid-output-filename');
      if (format !== 'text' && format !== 'markdown') {
        const row = this.#profile(format, 'export'), request = this.#request(format, job, filename, documentMediaTypes[format as DocumentFormat]);
        if ((format === 'csv' || format === 'tsv') && !request.selected) throw Error('Choose one table explicitly');
        const client = await this.#formatClient(job); if (!client || !this.#active(job)) return;
        // The public client captures synchronously when export is invoked. A lazy
        // load must not silently move the user's requested revision forward.
        const current = this.context.engine.read();
        if (JSON.stringify(current.identity) !== identity) throw Error('export-session-changed');
        if (current.revision !== revision) throw Error('export-revision-changed; prepare again');
        const result = await client.export(this.context.engine, request); if (!this.#active(job)) return;
        if (JSON.stringify(this.context.engine.read().identity) !== identity) throw Error('export-session-changed');
        if (result.revision !== revision) throw Error('export-revision-mismatch');
        if (result.profile !== row.profile) throw Error('format-profile-mismatch');
        if (result.bytes.length > Math.min(8 * 1048576, this.options.maxBytes ?? 8 * 1048576)) throw Error('format-byte-limit');
        const text = ['rtf','csv','tsv'].includes(format) ? new TextDecoder('utf-8', {fatal:true}).decode(result.bytes) : '';
        this.#revoke(); this.#artifact = {format:format as DocumentFormat, filename, mediaType:request.mediaType, revision:result.revision, text, bytes:result.bytes.slice(), diagnostics:result.diagnostics.map(d => String(d.code))};
        this.output.value = text; this.#refreshTables();
        this.#message(`Prepared revision ${result.revision}; not saved or shared. ${row.profile}; fidelity: ${row.fidelity}. ${this.#artifact.diagnostics.join(', ')}${text ? '' : ' Binary output retained. Use Download file or Save file; binary bytes cannot be copied as text.'}`); return;
      }
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
    if ((action === 'copy' || action === 'manual') && !artifact.text && artifact.format !== 'text' && artifact.format !== 'markdown') {
      this.#message('Binary output retained. Use Download file or Save file. Text copy is unavailable for this artifact.'); return;
    }
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
        this.#message(`Download requested; actual file delivery is unverified. ${artifact.text || artifact.format === 'text' || artifact.format === 'markdown' ? 'If no file appears, select the retained output for manual copy.' : 'Binary output remains retained; retry Download file or Save file if no file appears.'}`);
      } else {
        type Writer = { write(data: File): Promise<void>; close(): Promise<void>; abort(): Promise<void> };
        const picker = (w as unknown as { showSaveFilePicker?: (options: unknown) => Promise<{ createWritable(): Promise<Writer> }> }).showSaveFilePicker;
        if (typeof picker !== 'function') throw Error('file-save-unavailable');
        const handle = await picker.call(w, { suggestedName: artifact.filename }); if (!this.#active(job)) return;
        const writer = await handle.createWritable();
        let aborted = false;
        const abort = () => { if (!aborted) { aborted = true; void writer.abort().catch(() => {}); } };
        if (!this.#active(job)) { abort(); return; }
        job.signal.addEventListener('abort', abort, { once: true });
        try { await writer.write(file); if (!this.#active(job)) return; await writer.close(); }
        catch (error) { abort(); throw error; }
        finally { job.signal.removeEventListener('abort', abort); }
        if (this.#active(job)) this.#message(`File API write and close completed for revision ${artifact.revision}; destination durability is unverified.`);
      }
    } catch (error) { if (this.#active(job)) this.#message(`${this.#reason(error)}. Output retained: retry Download file${artifact.text || artifact.format === 'text' || artifact.format === 'markdown' ? ' or Select output for manual copy' : ' or Save file; binary text copy is unavailable'}. No delivery is claimed.`); }
    finally { this.#end(job); }
  }
  #reason(error: unknown): string {
    if (error && typeof error === 'object' && 'code' in error && typeof error.code === 'string') {
      const failure = error as {code: string; report?: {reason?: string; action?: string; diagnostics?: readonly {code?: unknown}[]}};
      return [failure.code, failure.report?.reason, failure.report?.diagnostics?.map(d => String(d.code)).join(', '), failure.report?.action].filter(Boolean).join('. ');
    }
    return error instanceof Error ? error.name === 'AbortError' ? 'Canceled by the user' : error.message : 'Unavailable or denied';
  }
  #revoke(): void { if (this.#url) { this.context.root.ownerDocument.defaultView!.URL.revokeObjectURL(this.#url); this.#url = undefined; } }
  dispose(): void {
    if (this.#disposed) return; this.cancel(); this.#disposed = true; this.#revoke(); this.#releaseViewport?.();
    for (const [target, type, listener] of this.#listeners.splice(0)) target.removeEventListener(type, listener);
    this.#client?.dispose(); this.#client = undefined; this.#artifact = undefined; this.recovery = undefined; this.preview.value = ''; this.output.value = ''; this.element.remove();
  }
}
