// Independent test observations through public engine APIs and raw readonly IDB.
// Product code never imports this module.
export const textOf = snapshot => snapshot.visible.flatMap(node => node.runs?.map(run => run.text) ?? []).join('');
const encode = value => JSON.stringify(value, (_key, item) => item instanceof Uint8Array ? { bytes: [...item] } : item);
export async function liveOracle(workspace) {
  const db = await new Promise((resolve, reject) => {
    const request = indexedDB.open(workspace.options.databaseName);
    request.onsuccess = () => resolve(request.result); request.onerror = () => reject(request.error);
  });
  let records;
  try {
    records = await new Promise((resolve, reject) => {
      const result = {}, transaction = db.transaction([...db.objectStoreNames], 'readonly');
      for (const name of db.objectStoreNames) {
        const request = transaction.objectStore(name).getAll(); request.onsuccess = () => { result[name] = request.result; };
      }
      transaction.oncomplete = () => resolve(result); transaction.onerror = () => reject(transaction.error);
    });
  } finally { db.close(); }
  const snapshot = workspace.owner.engine.read();
  return { snapshot, text: textOf(snapshot), checkpoint: encode(workspace.owner.engine.checkpoint()), journal: encode(records),
    journalUpdates: records.updates.length, retained: workspace.store.usage };
}
