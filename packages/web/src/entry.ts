import { init, type DocumentIdentity } from "@edit-ac/core";
import { CheckpointStorage } from "./storage/checkpoint.js";
import { UpdateJournal } from "./storage/journal.js";
import { StorageWriter } from "./storage/writer.js";
import { LocalStorageLifecycle } from "./storage/index.js";

/** Internal recovery prerequisite. Resolution means a real replica has its local
 * update subscription attached. The complete editor's input/DOM ready gate is separate.
 * Existing documents are never initialized from host content on recovery failure.
 */
export async function recoverLocalDocument(options: {
  assetUrl: string; databaseName: string; identity: DocumentIdentity;
  indexedDB: IDBFactory; locks: LockManager;
}): Promise<{ writer: StorageWriter; storage: LocalStorageLifecycle; source: "latest" | "previous" }> {
  // Capture trusted host identity before crossing asynchronous boundaries.
  const identity = { ...options.identity };
  const runtime = await init(options.assetUrl);
  const checkpoints = await CheckpointStorage.open(options.indexedDB, options.databaseName);
  let journal: UpdateJournal | undefined;
  let writer: StorageWriter | undefined;
  try {
    journal = await UpdateJournal.open(options.indexedDB, options.databaseName);
    const recovered = await checkpoints.restore(identity, state => StorageWriter.restore(runtime, options.locks,
      identity, state.checkpoint, state.tail.map(update => ({ identity: update.identity, bytes: update.bytes }))));
    writer = await recovered.value;
    const storage = new LocalStorageLifecycle(writer, journal);
    return { writer, storage, source: recovered.recovery.source };
  } catch (error) {
    writer?.dispose();
    journal?.close();
    throw error;
  } finally { checkpoints.close(); }
}
