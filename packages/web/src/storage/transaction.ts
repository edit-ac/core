/** Internal IndexedDB mechanics shared by the durable adapters. No async work
 * runs inside a transaction; completion alone acknowledges its writes. */
export function strictTransaction(database: IDBDatabase, stores: string | string[]): IDBTransaction {
  try { return database.transaction(stores, "readwrite", { durability: "strict" }); }
  catch (error) {
    if (!(error instanceof TypeError) && !(error instanceof DOMException && error.name === "NotSupportedError")) throw error;
    return database.transaction(stores, "readwrite");
  }
}
export interface TransactionControl {
  abort(error: unknown): void;
  watch<T>(request: IDBRequest<T>, success?: (value: T) => void): void;
}
export function completeTransaction<T>(tx: IDBTransaction, message: string, result: () => T,
  setup: (control: TransactionControl) => void): Promise<T> {
  return new Promise((resolve, reject) => {
    let failure: unknown;
    tx.oncomplete = () => resolve(result());
    tx.onabort = () => reject(failure ?? tx.error ?? new DOMException(message, "AbortError"));
    tx.onerror = () => { failure ??= tx.error; };
    const abort = (error: unknown) => {
      failure = error;
      try { tx.abort(); } catch { reject(error); }
    };
    const watch = <V>(request: IDBRequest<V>, success?: (value: V) => void) => {
      request.onerror = () => { failure = request.error; };
      if (success) request.onsuccess = () => { try { success(request.result); } catch (error) { abort(error); } };
    };
    try { setup({ abort, watch }); } catch (error) { abort(error); }
  });
}
