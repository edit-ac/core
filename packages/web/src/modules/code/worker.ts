import { validHighlightProjection, validHighlightInput, sameHighlightInput } from './scheduler.js';
import type { HighlightInput, HighlightWorkerPort } from './scheduler.js';

export interface HighlightBackend {
  project(input: string): string; dispose(): void; free(): void;
}
export interface HighlightWorkerScope {
  onmessage: ((event: { data: unknown }) => void) | null;
  postMessage(value: unknown): void;
}
/** Host-owned optional URLs. No worker, grammar load or request occurs at import. */
export function createHighlightWorker(workerUrl: URL, backendModuleUrl: URL): HighlightWorkerPort {
  const worker = new Worker(workerUrl, { type: 'module', name: 'editac-highlighting' });
  worker.postMessage({ type: 'configure', moduleUrl: backendModuleUrl.href });
  const port: HighlightWorkerPort = {
    onmessage: null, onerror: null,
    postMessage: value => worker.postMessage(value),
    terminate: () => { worker.onmessage = null; worker.onerror = null; worker.terminate(); },
  };
  worker.onmessage = event => port.onmessage?.(event);
  worker.onerror = event => port.onerror?.(event);
  return port;
}
/** Same adapter runs in the browser integration and deterministic fault harness. */
export function installHighlightWorker(scope: HighlightWorkerScope,
  load: (url: string) => Promise<HighlightBackend> = async url => {
    const module = await import(/* @vite-ignore */ url);
    await module.default();
    return new module.BrowserHighlighter() as HighlightBackend;
  }, now: () => number = () => performance.now()): () => void {
  let moduleUrl: string | undefined, backend: HighlightBackend | undefined;
  let disposed = false, busy = false;
  scope.onmessage = event => {
    if (disposed || !event.data || typeof event.data !== 'object') return;
    const data = event.data as { type: string; moduleUrl: string; id: number; input: HighlightInput };
    if (data.type === 'configure' && !moduleUrl && !busy) { moduleUrl = data.moduleUrl; return; }
    if (data.type !== 'highlight' || busy || !moduleUrl) return;
    busy = true;
    const input = Object.freeze({ ...data.input });
    void (async () => {
      let startup = 0, work = 0;
      let projection: unknown = { status: 'backend-error', spans: [] };
      try {
        if (!validHighlightInput(input)) throw Error("invalid worker input");
        if (!backend) {
          const start = now(); const loaded = await load(moduleUrl!); startup = now() - start;
          if (disposed) { loaded.dispose(); loaded.free(); return; }
          backend = loaded;
        }
        const start = now();
        const output = JSON.parse(backend.project(JSON.stringify(input))) as { input: HighlightInput; projection: unknown };
        work = now() - start;
        if (!sameHighlightInput(input, output.input) || !validHighlightProjection(input, output.projection)) throw Error('invalid backend output');
        projection = output.projection;
      } catch { /* Safe plain source is carried by the immutable input. */ }
      finally { busy = false; }
      if (!disposed) scope.postMessage({ id: data.id, input, projection, timing: { startup, work } });
    })();
  };
  scope.postMessage({ type: 'ready' });
  return () => {
    disposed = true; scope.onmessage = null;
    backend?.dispose(); backend?.free(); backend = undefined;
  };
}
