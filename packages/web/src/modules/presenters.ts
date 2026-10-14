import { extensionTransferRequest, type PreparedExtensionTransfer } from '@edit-ac/core/extensions';
import type { PrepareRequest, Patch, PatchSubscription } from '@edit-ac/core';
import type { ModuleEvent, ModuleRuntime, ModuleScope, ModuleViewContent } from './runtime.js';
import { ExtensionCommandSession } from './conformance.js';
import type { ExtensionCommandHost, ExtensionCommandResult } from './conformance.js';

export const PRESENTER_API_VERSION = 1 as const;
export const PRESENTER_HOSTS = Object.freeze(['browser', 'terminal', 'swift-ios', 'kotlin-android', 'desktop'] as const);
export type PresenterHost = typeof PRESENTER_HOSTS[number];
/** Capability records describe host obligations, not renderer/device qualification. */
export interface PresenterCapabilitiesV1 {
  readonly version: 1; readonly host: PresenterHost;
  readonly focus: 'dom' | 'terminal' | 'native' | 'desktop';
  readonly composition: 'host-temporary';
  readonly selection: 'engine-stable-utf16';
  readonly accessibility: 'semantic-label-actions';
  readonly clipboard: 'host-granted'; readonly source: 'inert-markdown-fallback';
  readonly patches: 'module-runtime'; readonly cancellation: 'abort-stale';
  readonly disposal: 'idempotent'; readonly theme: 'host-owned';
}
export const PRESENTER_CAPABILITIES: Readonly<Record<PresenterHost, PresenterCapabilitiesV1>> = Object.freeze(
  Object.fromEntries(PRESENTER_HOSTS.map(host => [host, Object.freeze({
    version: 1, host, focus: host === 'browser' ? 'dom' : host === 'terminal' ? 'terminal' : host === 'desktop' ? 'desktop' : 'native',
    composition: 'host-temporary', selection: 'engine-stable-utf16', accessibility: 'semantic-label-actions',
    clipboard: 'host-granted', source: 'inert-markdown-fallback', patches: 'module-runtime',
    cancellation: 'abort-stale', disposal: 'idempotent', theme: 'host-owned',
  })])) as Record<PresenterHost, PresenterCapabilitiesV1>);

export interface PresenterInputV1 {
  readonly version: 1; readonly nodeId: string; readonly sourceId: string;
  readonly content: ModuleViewContent; readonly selection: Patch['selection'];
  readonly readOnly: boolean; readonly theme: string;
  readonly capabilities: PresenterCapabilitiesV1;
}
export type PresenterUpdateV1 = { readonly input: PresenterInputV1; readonly event: ModuleEvent | null };
export interface PresenterFocusV1 { readonly owner: 'editor' | 'presenter' | 'nested-control'; readonly restore: boolean }
/** Preedit text stays in the host control. Only an explicit subsequent command can commit it. */
export type PresenterInputEventV1 = { readonly type: 'composition-start' | 'composition-update' | 'composition-end' | 'composition-cancel' | 'text'; readonly text: string };
export interface PresenterAccessibilityV1 { readonly label: string; readonly actions: readonly string[]; readonly readOnly: boolean }
export interface PresenterRepresentationV1 { readonly mime: 'text/plain' | 'text/markdown'; readonly text: string; readonly fallback: boolean }
export interface PresenterAdapterV1 {
  readonly host: PresenterHost;
  update(update: PresenterUpdateV1): void;
  focus(focus: PresenterFocusV1): void;
  input(event: PresenterInputEventV1): void;
  accessibility(): PresenterAccessibilityV1;
  representation(mime: PresenterRepresentationV1['mime']): PresenterRepresentationV1;
  cancel(): void;
  dispose(): void;
}

function frozen<T>(input: T): T {
  const copy = structuredClone(input);
  const freeze = (v: unknown): void => { if (v && typeof v === 'object' && !ArrayBuffer.isView(v)) { Object.values(v).forEach(freeze); Object.freeze(v); } };
  freeze(copy); return copy;
}
/** Complete host coverage is an explicit conformance precondition. */
export function validatePresenterAdapters(adapters: readonly PresenterAdapterV1[]): void {
  const seen = new Set<PresenterHost>();
  for (const adapter of adapters) {
    if (!PRESENTER_HOSTS.includes(adapter.host) || seen.has(adapter.host)) throw Error('Invalid/duplicate presenter host');
    for (const method of ['update', 'focus', 'input', 'accessibility', 'representation', 'cancel', 'dispose'] as const) {
      if (typeof adapter[method] !== 'function') throw Error('Missing presenter method: ' + method);
    }
    seen.add(adapter.host);
  }
  if (seen.size !== PRESENTER_HOSTS.length) throw Error('Missing presenter host adapter');
}

/** Per-view host resource, over existing filtered runtime and prepared commands.
 * Snapshot callbacks and adapters run after engine transactions. No semantic store,
 * direct engine mutation, OS clipboard, resolver or asset transport is owned here. */
export class ExtensionPresenterSession {
  readonly #commands: ExtensionCommandSession;
  #subscription: PatchSubscription | undefined;
  #disposed = false;
  #composing = false;
  constructor(
    runtime: ModuleRuntime, private readonly adapter: PresenterAdapterV1,
    private readonly snapshot: () => PresenterInputV1, private readonly host: ExtensionCommandHost, scope: ModuleScope,
  ) {
    const session = this;
    this.#commands = new ExtensionCommandSession({
      get active() { return !session.#disposed && runtime.active && host.active; },
      revision() { const input = snapshot(); return JSON.stringify([host.revision(), input.nodeId, input.sourceId]); },
      can(request) { return !session.#composing && !snapshot().readOnly && host.can(request); },
      commit(request) {
        if (session.#disposed || !runtime.active || session.#composing || snapshot().readOnly || !host.active) throw Error('Presenter capability revoked');
        return host.commit(request);
      },
    });
    try {
      this.#update(null);
      this.#subscription = runtime.subscribe(scope, event => this.#guard(() => this.#update(event)));
    } catch (error) { this.dispose(); throw error; }
  }
  get active(): boolean { return !this.#disposed && this.#commands.active && (this.#subscription?.active ?? false); }
  #guard<T>(callback: () => T): T {
    if (this.#disposed) throw Error('Presenter disposed');
    try { return callback(); } catch (error) { this.dispose(); throw error; }
  }
  #update(event: ModuleEvent | null): void {
    const input = this.snapshot();
    const expected = PRESENTER_CAPABILITIES[this.adapter.host];
    if (!expected || input.version !== 1 || !input.nodeId || !input.sourceId ||
      Object.entries(expected).some(([key, value]) => (input.capabilities as unknown as Record<string, unknown>)[key] !== value)) throw Error('Invalid presenter input/capabilities');
    if (new TextEncoder().encode(JSON.stringify(input)).length > 1_048_576) throw Error('Presenter input resource limit');
    // Revision changes and target changes also suppress late preparations in the
    // owning command session. Never retain a second mutable semantic projection.
    this.adapter.update(frozen({ input, event }));
  }
  update(): void { this.#guard(() => this.#update(null)); }
  focus(focus: PresenterFocusV1): void {
    this.#guard(() => {
      if (!['editor', 'presenter', 'nested-control'].includes(focus.owner) || typeof focus.restore !== 'boolean') throw Error('Invalid presenter focus');
      this.adapter.focus(frozen(focus));
    });
  }
  input(event: PresenterInputEventV1): void {
    this.#guard(() => {
      if (!['composition-start', 'composition-update', 'composition-end', 'composition-cancel', 'text'].includes(event.type) ||
        typeof event.text !== 'string' || new TextEncoder().encode(event.text).length > 65_536) throw Error('Invalid/bounded presenter input event');
      if (event.type === 'composition-start') { this.#composing = true; this.#commands.cancel(); }
      if (event.type === 'composition-end' || event.type === 'composition-cancel') this.#composing = false;
      this.adapter.input(frozen(event));
    });
  }
  accessibility(): PresenterAccessibilityV1 {
    return this.#guard(() => {
      const result = this.adapter.accessibility();
      if (typeof result.label !== 'string' || new TextEncoder().encode(result.label).length > 65_536 ||
        typeof result.readOnly !== 'boolean' || !Array.isArray(result.actions) || result.actions.length > 64 ||
        result.actions.some(action => typeof action !== 'string' || action.length > 256)) throw Error('Invalid/bounded presenter accessibility');
      return frozen(result);
    });
  }
  representation(mime: PresenterRepresentationV1['mime']): PresenterRepresentationV1 {
    return this.#guard(() => {
      if (mime !== 'text/plain' && mime !== 'text/markdown') throw Error('Unsupported presenter representation');
      const result = this.adapter.representation(mime);
      if (result.mime !== mime || typeof result.fallback !== 'boolean' || typeof result.text !== 'string' || new TextEncoder().encode(result.text).length > 1_048_576) throw Error('Invalid/bounded presenter representation');
      return frozen(result);
    });
  }
  run(prepare: (signal: AbortSignal) => PrepareRequest | undefined | Promise<PrepareRequest | undefined>): Promise<ExtensionCommandResult> {
    if (!this.active || this.#composing) return Promise.resolve({ status: 'cancelled' });
    return this.#commands.run(prepare);
  }
  /** All hosts use identical formatted/literal policy and atomic prepared edits.
   * A prepared offer owns inert data, not source-view resources or clipboard authority. */
  transfer(prepared: PreparedExtensionTransfer, engine: import('@edit-ac/core').EngineHandle, range: import('@edit-ac/core').StableRange, origin = 'extension:paste'): Promise<ExtensionCommandResult> {
    return this.run(() => extensionTransferRequest(prepared, engine, range, origin));
  }
  cut(prepared: PreparedExtensionTransfer, engine: import('@edit-ac/core').EngineHandle, range: import('@edit-ac/core').StableRange,
    write: (offer: PreparedExtensionTransfer['recovery'], signal: AbortSignal) => Promise<boolean>): Promise<ExtensionCommandResult> {
    const target = { anchor: range.anchor, focus: range.focus };
    return this.run(async signal => {
      const request = extensionTransferRequest(prepared, engine, target, 'extension:cut', true);
      // Do not expose clipboard data before current mutation capability admission.
      if (this.snapshot().readOnly || !this.host.can(request) || signal.aborted || !this.active) return undefined;
      // Host must acknowledge every required flavor; refusal/throw/cancel never deletes.
      if (await write(prepared.recovery, signal) !== true || signal.aborted) return undefined;
      return extensionTransferRequest(prepared, engine, target, 'extension:cut', true);
    });
  }
  cancel(): void {
    if (this.#disposed) return;
    this.#composing = false; this.#commands.cancel();
    this.#guard(() => this.adapter.cancel());
  }
  dispose(): void {
    if (this.#disposed) return;
    this.#disposed = true; this.#composing = false;
    this.#subscription?.dispose(); this.#commands.dispose();
    // Teardown attempts every resource even if a trusted host callback throws.
    try { this.adapter.cancel(); } catch { /* detached already */ }
    try { this.adapter.dispose(); } catch { /* detached already */ }
  }
}
