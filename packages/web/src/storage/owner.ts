import type { EngineHandle } from '@edit-ac/core';
import { recoverLocalDocument } from '../entry.js';

type RecoveryOptions = Parameters<typeof recoverLocalDocument>[0];
type LocalSession = Awaited<ReturnType<typeof recoverLocalDocument>>;
/** Advanced borrowed-view bridge. The existing storage lifecycle owns the replica. */
export interface EditorStorageOwner {
  readonly engine: EngineHandle;
  readonly commit: LocalSession['storage']['commit'];
  readonly flush: LocalSession['storage']['flush'];
  readonly recoveryExport: LocalSession['storage']['recoveryExport'];
  /** View disposal never destroys this host-owned resource. */
  readonly destroy: LocalSession['storage']['destroy'];
}
const owners = new WeakMap<EditorStorageOwner, LocalSession & Pick<RecoveryOptions, 'indexedDB' | 'databaseName'>>();
/** Recover one local storage owner, then mount/remount views over its same engine. */
export async function openEditorStorage(options: RecoveryOptions): Promise<EditorStorageOwner> {
  const captured = { ...options, identity: { ...options.identity } };
  const session = await recoverLocalDocument(captured);
  const owner = Object.freeze({ engine: session.writer.engine,
    commit: session.storage.commit.bind(session.storage), flush: session.storage.flush.bind(session.storage),
    recoveryExport: session.storage.recoveryExport.bind(session.storage), destroy: session.storage.destroy.bind(session.storage) });
  owners.set(owner, { ...session, indexedDB: captured.indexedDB, databaseName: captured.databaseName });
  return owner;
}
/** Internal brand check prevents a borrowed view pairing another replica/database. */
export function editorStoragePorts(owner: EditorStorageOwner) {
  const ports = owners.get(owner);
  if (!ports) throw Error('Use openEditorStorage for the borrowed storage owner');
  return ports;
}
