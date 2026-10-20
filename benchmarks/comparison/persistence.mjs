import { Doc, applyUpdate, encodeStateAsUpdate, encodeStateVector } from 'yjs';
import { IndexeddbPersistence } from 'y-indexeddb';
import { check } from './shared.mjs';
export { Doc };
export async function persist(name, doc) {
  const provider = new IndexeddbPersistence(name, doc);
  await provider.whenSynced;
  return {
    flush: async () => { // Fence behind update transactions on the same IDB connection.
      await new Promise((resolve, reject) => {
        const tx = provider.db.transaction(['updates'], 'readonly');
        tx.objectStore('updates').getAllKeys(); tx.oncomplete = resolve; tx.onabort = tx.onerror = () => reject(tx.error);
      });
    },
    roundtrip: () => { const peer = new Doc(); try {
      applyUpdate(peer, encodeStateAsUpdate(doc));
      check(Array.from(encodeStateVector(peer)).join() === Array.from(encodeStateVector(doc)).join(), 'Yjs peer roundtrip mismatch');
    } finally { peer.destroy(); } },
    destroy: () => provider.destroy()
  };
}
