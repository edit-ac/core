import type { ModuleRenderer, ModuleView, ModuleViewContent } from '../modules/runtime.js';
import type { ExtensionAssetsV1 } from './contract.js';
import { extensionAsset, importExtensionModule } from './assets.js';

/** Small view adapter only. Source/history stay in the existing runtime. */
export function managedMathRenderer(assets?: ExtensionAssetsV1): ModuleRenderer {
  const url = extensionAsset(assets, 'mathModule', 'math.js') ?? new URL('../modules/math.js', import.meta.url).href;
  return { mount(element, initial) {
    let current = initial, disposed = false, view: ModuleView | undefined;
    const pending = importExtensionModule<typeof import('../modules/math.js')>(url);
    element.dataset.mathState = 'loading';
    void pending.then(module => {
      if (disposed) return;
      try { view = module.mathRenderer().mount(element, current); }
      catch { element.dataset.mathState = 'source'; }
    }, () => { if (!disposed) element.dataset.mathState = 'source'; });
    return {
      update(content: ModuleViewContent) { current = content; view?.update(content); },
      dispose() { if (disposed) return; disposed = true; view?.dispose(); },
    };
  } };
}
