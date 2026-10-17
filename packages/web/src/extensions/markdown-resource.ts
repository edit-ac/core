import { configuredResource } from './resource.js';
import type { PreparedEditorConfigurationV1 } from './contract.js';
import type { MarkdownAdapter } from '../input/shortcuts.js';
import { extensionAsset, importExtensionModule } from './assets.js';

/** Dedicated optional codec, registered only with its current surface. */
export function markdownResource(prepared: PreparedEditorConfigurationV1 | undefined,
  attach: (adapter: MarkdownAdapter, input: boolean) => () => void) {
  const configured = prepared?.extensions.find(e => e.feature.id === 'editac.markdown');
  let adapter: MarkdownAdapter | undefined;
  const resource = configuredResource(prepared, 'editac.markdown', async signal => {
    const assets = prepared?.configuration.assets;
    const assetUrl = extensionAsset(assets, 'markdown', 'editac_markdown_wasm_bg.wasm');
    const moduleUrl = extensionAsset(assets, 'markdownModule', 'markdown.js') ?? '@edit-ac/markdown/web';
    const module = await importExtensionModule<{ loadMarkdownAdapter(url?: string): Promise<MarkdownAdapter> }>(moduleUrl);
    if (signal.aborted) return { dispose() {} };
    const value = await module.loadMarkdownAdapter(assetUrl);
    if (signal.aborted) return { dispose() {} };
    const detach = attach(value, configured?.options.input === true);
    adapter = value;
    return { dispose() { adapter = undefined; detach(); } };
  });
  return { ...resource, get status() { return resource.status; }, get adapter() { return adapter; } };
}
