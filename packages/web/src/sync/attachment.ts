import type { DocumentIdentity, EngineHandle } from '@edit-ac/core';
import type { DOMSelection } from '../dom/selection.js';
import type { LocalStorageLifecycle } from '../storage/index.js';
import { UpdateOutbox } from '../storage/outbox.js';
import { SyncSession, type SyncSessionOptions, type SyncTransport } from './session.js';

export interface SyncAttachment {
  readonly presence?: import('./presence.js').PresenceAttachment;
  readonly state: SyncSession['state'];
  receive(frame: Uint8Array): void;
  pump(now: number): Promise<void>;
  detach(): void;
}
export interface AttachSyncOptions extends SyncSessionOptions {
  presence?: import('./presence.js').PresenceOptions;
  transport: SyncTransport;
  peerIdentity: DocumentIdentity;
  authorized: boolean;
}
/** Both mounts use this existing outbox/session/presence assembly. No replica restoration. */
export async function attachStoredSync(ports: {
  root: HTMLElement; selection: DOMSelection; engine: EngineHandle; storage: LocalStorageLifecycle;
  indexedDB: IDBFactory; databaseName: string; current(): boolean; onDetach(attachment: SyncAttachment): void;
}, options: AttachSyncOptions): Promise<SyncAttachment> {
  const { transport, authorized, peerIdentity, presence: presenceOptions, ...limits } = options;
  const identity = { ...peerIdentity };
  const outbox = await UpdateOutbox.open(ports.indexedDB, ports.databaseName);
  let sync: SyncSession | undefined;
  let presence: import('./presence.js').EditorPresence | undefined;
  const requireCurrent = () => { if (!ports.current()) throw Error('Sync attachment superseded'); };
  try {
    requireCurrent(); sync = new SyncSession(ports.engine, outbox, limits); sync.attach(transport, identity, authorized);
    if (presenceOptions && authorized === true) {
      const { EditorPresence } = await import('./presence.js'); requireCurrent();
      presence = new EditorPresence(ports.root, ports.selection, ports.engine, presenceOptions);
    }
    const owned = sync;
    let latest = ports.storage.state.localCommitted?.updateId, detached = false;
    const unsubscribe = ports.storage.subscribe(state => {
      if (state.localCommitted && state.localCommitted.updateId !== latest) {
        latest = state.localCommitted.updateId; owned.localCommitted('local:sdk');
      }
    });
    const attachment: SyncAttachment = {
      get state() { return owned.state; }, ...(presence ? { presence } : {}),
      receive: frame => owned.receive(frame), pump: async now => { await owned.pump(now); presence?.pump(now); },
      detach() {
        if (detached) return; detached = true;
        unsubscribe(); presence?.dispose(); owned.dispose(); outbox.close(); ports.onDetach(attachment);
      },
    };
    return attachment;
  } catch (error) { presence?.dispose(); sync?.dispose(); outbox.close(); throw error; }
}
