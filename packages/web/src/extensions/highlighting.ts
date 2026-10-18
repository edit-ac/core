import type { ProjectedNode } from '@edit-ac/core';
import type { DOMRenderer } from '../dom/render.js';
import type { CodeHighlightOptions, CodeHighlightPresenter } from '../modules/code/presenter.js';
import type { ExtensionAssetsV1, ExtensionStatusV1 } from './contract.js';
import { extensionAsset } from './assets.js';

/** The existing DOM renderer consumes this view-only lifetime port. */
export type CodeHighlightAttachment = Pick<CodeHighlightPresenter, 'update' | 'hold' | 'remove' | 'dispose'>;
export type ManagedCodeHighlightOptions = Omit<CodeHighlightOptions, 'createWorker'> & {
  assets?: ExtensionAssetsV1;
  createWorker?: CodeHighlightOptions['createWorker'];
};
export interface ManagedCodeHighlightAttachment extends CodeHighlightAttachment {
  readonly status: ExtensionStatusV1;
  load(): Promise<void>;
}
export type ManagedCodeHighlightFactory = (renderer: DOMRenderer) => ManagedCodeHighlightAttachment;

/** Advanced legacy adapter. Does not admit the still-unqualified Code facade. */
export function managedCodeHighlighting(options: ManagedCodeHighlightOptions = {}): ManagedCodeHighlightFactory {
  options = { ...options, ...(options.assets ? { assets: options.assets.baseURL ? { baseURL: options.assets.baseURL } : { manifest: { ...options.assets.manifest } } } : {}) };
  return renderer => {
    let disposed = false, presenter: CodeHighlightPresenter | undefined, pending: Promise<void> | undefined;
    let status: ExtensionStatusV1 = Object.freeze({ state: 'idle', generation: 0 });
    const latest = new Map<string, { node: ProjectedNode; revision: number }>();
    async function load(): Promise<void> {
      if (disposed) throw Error('Highlight attachment disposed');
      if (pending) return pending;
      if (presenter) return;
      if (status.generation >= 3) throw Error('Highlight retry limit reached');
      const generation = status.generation + 1;
      status = Object.freeze({ state: 'loading', generation });
      pending = import('../modules/code/presenter.js').then(async ({ codeHighlighting }) => {
        if (disposed) return;
        const { createHighlightWorker } = await import('../modules/code/worker.js');
        if (disposed) return;
        const worker = extensionAsset(options.assets, 'highlightWorker', 'highlight-worker.js') ?? new URL('../modules/code/worker-entry.js', import.meta.url).href;
        const backend = extensionAsset(options.assets, 'highlightBackend', 'editac_highlighting.js') ?? new URL('../modules/code/backend/editac_highlighting.js', import.meta.url).href;
        presenter = codeHighlighting({ ...options, createWorker: options.createWorker ?? (() => createHighlightWorker(new URL(worker), new URL(backend))) })(renderer);
        for (const value of latest.values()) presenter.update(value.node, value.revision);
        latest.clear(); status = Object.freeze({ state: 'ready', generation });
      }).catch(error => {
        if (!disposed) status = Object.freeze({ state: 'failed', generation, code: 'highlight-load-failed', retryable: generation < 3 });
        throw error;
      }).finally(() => { pending = undefined; });
      return pending;
    }
    return {
      get status() { return status; },
      load,
      update(node, revision) {
        if (disposed || options.enabled === false) return;
        if (presenter) presenter.update(node, revision);
        else { latest.set(node.id, { node, revision }); if (status.state === 'idle') void load().catch(() => {}); }
      },
      hold(id) { latest.delete(id); presenter?.hold(id); },
      remove(id) { latest.delete(id); presenter?.remove(id); },
      dispose() { if (disposed) return; disposed = true; latest.clear(); presenter?.dispose(); status = Object.freeze({ state: 'cancelled', generation: status.generation }); },
    };
  };
}
