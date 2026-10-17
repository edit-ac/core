import { ExtensionProfileActivation } from '@edit-ac/core/extensions';
import type { ProfileResource } from '@edit-ac/core/extensions';
import type { PreparedEditorConfigurationV1, ExtensionStatusV1 } from './contract.js';

/** Resource bookkeeping only; cancellation and cleanup use the admitted profile owner. */
export function configuredResource(prepared: PreparedEditorConfigurationV1 | undefined, id: string,
  attach: (signal: AbortSignal) => Promise<ProfileResource>) {
  const configured = prepared?.extensions.find(e => e.feature.id === id);
  let status: ExtensionStatusV1 = Object.freeze({ state: 'idle', generation: 0 });
  let activation: ExtensionProfileActivation | undefined;
  let pending: Promise<void> | undefined;
  let disposed = false;
  function load(): Promise<void> {
    if (!configured || !prepared) return Promise.reject(Error('Extension is not configured: ' + id));
    if (disposed) return Promise.reject(Error('Extension attachment is disposed'));
    if (pending) return pending;
    if (status.state === 'ready') return Promise.resolve();
    if (status.generation >= 3) return Promise.reject(Error(`Extension ${id} retry limit reached; remount after repairing the host configuration`));
    const generation = status.generation + 1;
    status = Object.freeze({ state: 'loading', generation });
    const owner = new ExtensionProfileActivation({ ...prepared.profile,
      features: prepared.profile.features.filter(f => f.id === id) }, 30000);
    activation = owner;
    let cause: unknown;
    pending = owner.activate({ [id]: async signal => {
      try { return await attach(signal); } catch (error) { cause = error; throw error; }
    } }).then(success => {
      if (disposed) throw Error('Extension attachment is disposed');
      if (!success) {
        status = Object.freeze({ state: 'failed', generation, code: 'adapter-load-failed', retryable: generation < 3 });
        throw Error(`Extension ${id} unavailable; source retained. Check optional package, asset URL, MIME/CSP/CORS; retry explicitly.`, { cause });
      }
      status = Object.freeze({ state: 'ready', generation });
    }).finally(() => { pending = undefined; });
    return pending;
  }
  return { id, get status() { return status; }, required: configured?.loading === 'required-input', configured: !!configured, load,
    dispose() {
      if (disposed) return; disposed = true;
      status = Object.freeze({ state: 'cancelled', generation: status.generation }); activation?.dispose();
    },
  };
}
