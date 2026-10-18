import type { AssetGrant, AssetRequest, FragmentBlock } from '@edit-ac/core';
import type { DocumentSearchContext } from './search.js';
import type { RetainedSelection } from '../dom/selection.js';
import type { EditorStorageOwner } from '../storage/owner.js';
import type { AssetSession, AssetHostTransport, PreparedAssetCommitReceipt } from '../sync/assets.js';
import { touchTarget } from './touch-controls.js';
import { FRAGMENT_MIME } from '../clipboard/fragment.js';
import { EXTENSION_TRANSFER_MIME } from '@edit-ac/core/extensions';

export interface AssetInputOptions {
  /** Host allocates a stable non-secret identity and validates actual media.
   * This runs only after an explicit file/paste action, never during rendering. */
  describe(file: File, signal: AbortSignal): Promise<{ request: AssetRequest; descriptor: FragmentBlock }>;
  host: AssetHostTransport;
  /** A declared optional capture affordance; no permission/API probing. */
  capture?: 'user' | 'environment';
  maxBytes?: number;
  online?(): boolean;
}
export type AssetInputFactory = (context: DocumentSearchContext, owner: EditorStorageOwner) => AssetInputControls;
export function assetInputControls(options: AssetInputOptions): AssetInputFactory {
  return (context, owner) => new AssetInputControls(context, owner, options);
}
interface Work { job: string; target: RetainedSelection; revision: number; abort: AbortController; committed: boolean; picking: boolean }
/** Optional touch presenter. Rust/AssetSession own all content, history, bytes,
 * grants and fencing. There is no upload retry, codec or lifecycle journal here. */
export class AssetInputControls {
  readonly element: HTMLElement;
  readonly input: HTMLInputElement;
  readonly camera: HTMLInputElement | undefined;
  readonly status: HTMLElement;
  /** Caller original remains available after failure/cancel; never an upload receipt. */
  recovery: File | undefined;
  receipt: PreparedAssetCommitReceipt | undefined;
  #assets: Promise<AssetSession> | undefined;
  #work: Work | undefined;
  #disposed = false;
  #disposal: Promise<void> | undefined;
  #readOnly = false;
  #pending = new Set<Promise<unknown>>();
  #listeners: [EventTarget, string, EventListener, boolean][] = [];
  readonly #limit: number;
  constructor(readonly context: DocumentSearchContext, readonly owner: EditorStorageOwner, readonly options: AssetInputOptions) {
    if (owner.engine !== context.engine) throw Error('Asset input requires the exact storage owner');
    const limit = options.maxBytes ?? 2 * 1024 * 1024;
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 2 * 1024 * 1024) throw Error('asset-input-limit');
    this.#limit = limit;
    const doc = context.root.ownerDocument;
    this.element = doc.createElement('section'); this.element.setAttribute('aria-label', 'Add assets');
    this.status = doc.createElement('p'); this.status.setAttribute('role', 'status'); this.status.textContent = 'Choose a local file';
    const picker = (label: string, capture?: 'user' | 'environment') => {
      const input = doc.createElement('input'); input.type = 'file'; input.hidden = true; input.setAttribute('aria-label', label);
      if (capture) { input.accept = 'image/*'; input.setAttribute('capture', capture); }
      const button = doc.createElement('button'); button.type = 'button'; button.textContent = label; touchTarget(button);
      this.#listen(button, 'pointerdown', event => { if (this.#begin()) event.preventDefault(); });
      this.#listen(button, 'click', () => { if (this.#work?.picking || this.#begin()) input.click(); });
      this.#listen(input, 'change', () => { const file = input.files?.[0]; input.value = ''; if (file) this.#track(this.#insert(file)); else this.#track(this.cancel()); });
      this.#listen(input, 'cancel', () => this.#track(this.cancel()));
      this.element.append(button, input); return input;
    };
    this.input = picker('Add file');
    this.camera = options.capture ? picker('Take photo (optional)', options.capture) : undefined;
    const cancel = doc.createElement('button'); cancel.type = 'button'; cancel.textContent = 'Cancel adding asset'; touchTarget(cancel);
    this.#listen(cancel, 'click', () => this.#track(this.cancel())); this.element.append(cancel, this.status);
    this.#listen(context.root, 'paste', event => {
      const e = event as ClipboardEvent, data = e.clipboardData;
      if (!data || data.getData(FRAGMENT_MIME) || data.getData(EXTENSION_TRANSFER_MIME)) return;
      // Internal structured transfer keeps its owning precedence. For external
      // binary+HTML representations, admit one file and suppress the HTML echo.
      const file = data.files?.[0]; if (!file || this.#blocked()) return;
      e.preventDefault(); e.stopImmediatePropagation();
      if (this.#begin()) this.#track(this.#insert(file));
    }, true);
    this.#listen(doc, 'visibilitychange', () => { if (doc.visibilityState === 'hidden') this.#track(this.cancel()); });
    this.#listen(doc.defaultView!, 'pagehide', () => this.#track(this.cancel()));
  }
  get disposed(): boolean { return this.#disposed; }
  #listen(target: EventTarget, type: string, listener: EventListener, capture = false): void {
    target.addEventListener(type, listener, capture); this.#listeners.push([target, type, listener, capture]);
  }
  #track(promise: Promise<unknown>): void {
    this.#pending.add(promise); void promise.catch(error => this.#message(String(error))).finally(() => this.#pending.delete(promise));
  }
  async settle(): Promise<void> { await Promise.allSettled([...this.#pending]); }
  #message(text: string): void { if (!this.#disposed) this.status.textContent = text; }
  #blocked(): boolean {
    return this.#disposed || this.#readOnly || this.context.selection.suspended || !!this.context.blocked?.() ||
      !this.context.root.isConnected || this.context.root.getAttribute('aria-readonly') === 'true' || this.context.root.getAttribute('aria-busy') === 'true';
  }
  #begin(): boolean {
    if (this.#blocked() || this.#work) return false;
    const target = this.context.selection.retain(); if (!target) return false;
    this.#work = { job: `picker_${crypto.randomUUID().replaceAll('-', '')}`, target,
      revision: this.context.engine.read().revision, abort: new AbortController(), committed: false, picking: true };
    this.receipt = undefined; this.#message('Waiting for a file; file selection remains available'); return true;
  }
  #valid(work: Work): void {
    if (this.#work !== work || work.abort.signal.aborted || this.#blocked() || !work.target.active || this.context.engine.read().revision !== work.revision) throw Error('Asset target changed or canceled; original file retained');
  }
  #session(): Promise<AssetSession> { return this.#assets ??= this.owner.enableAssets(); }
  async #insert(file: File): Promise<void> {
    const work = this.#work; if (!work || !work.picking) return;
    work.picking = false;
    this.recovery = file;
    try {
      this.#valid(work);
      if (!file.size || file.size > this.#limit) throw Error('File exceeds the bounded asset input limit');
      const bytes = new Uint8Array(await file.arrayBuffer()); this.#valid(work);
      if (!bytes.length || bytes.length > this.#limit) throw Error('File exceeds the bounded asset input limit');
      const {request, descriptor} = await this.options.describe(file, work.abort.signal); this.#valid(work);
      if (request.action !== 'ingest' || request.byteLimit < bytes.length || request.byteLimit > this.#limit) throw Error('Invalid bounded ingest request');
      const grant: AssetGrant = await this.options.host.authorize(request, work.abort.signal); this.#valid(work);
      const assets = await this.#session(); this.#valid(work);
      const reference = `${work.job}_original`;
      await assets.stageOriginal(work.job, reference, request, grant, bytes); this.#valid(work);
      this.#message('Adding asset; cancel remains available');
      if (!await assets.runOne(request.operationId, this.options.online?.() ?? true, this.options.host)) throw Error('Asset pending/offline/denied; original retained, choose file to try again');
      this.#valid(work);
      const plan = this.context.engine.prepare({kind:'fragment',origin:'asset-input',range:work.target.range,blocks:[descriptor]});
      try {
        this.receipt = await this.owner.commitPreparedAssets(plan, work.job, [reference], {signal:work.abort.signal});
        work.committed = true;
        const result = this.receipt.content;
        try {
          if (result.selection) this.context.selection.restoreRange(result.selection);
          else if (result.caret) this.context.selection.move(result.caret);
        } finally {
          for (const anchor of new Set([result.caret, result.selection?.anchor, result.selection?.focus])) if (anchor) this.context.engine.releaseAnchor(anchor);
          this.receipt = {...this.receipt, content:{revision:result.revision}};
        }
      } finally { this.context.engine.releasePlan(plan); }
      this.recovery = undefined; this.#message('Asset added locally; asset and document receipts are distinct');
    } catch (error) { this.#message(`${String(error)}. Add file remains available.`); }
    finally {
      if (!work.committed) await (await this.#session()).fenceJob(work.job);
      work.target.dispose(); if (this.#work === work) this.#work = undefined;
    }
  }
  async cancel(): Promise<void> {
    const work = this.#work; if (!work) return;
    this.#work = undefined; work.abort.abort(); work.target.dispose();
    // Fence even an empty job, before a delayed describe/stage callback returns.
    await (await this.#session()).fenceJob(work.job);
    this.#message('Canceled; Add file is available');
  }
  setReadOnly(value: boolean): void {
    this.#readOnly = value;
    for (const button of this.element.querySelectorAll('button')) button.disabled = value;
    if (value) this.#track(this.cancel());
  }
  dispose(): Promise<void> { return this.#disposal ??= this.#dispose(); }
  async #dispose(): Promise<void> {
    this.#disposed = true;
    for (const [target,type,listener,capture] of this.#listeners.splice(0)) target.removeEventListener(type,listener,capture);
    await this.cancel(); this.element.remove();
  }
}
