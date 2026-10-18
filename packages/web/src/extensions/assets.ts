import type { ExtensionAssetsV1 } from './contract.js';

/** One host manifest/base override. URLs are host configuration, never document data. */
export function extensionAsset(assets: ExtensionAssetsV1 | undefined, key: string, filename: string): string | undefined {
  return assets?.baseURL ? new URL(filename, assets.baseURL).href : assets?.manifest?.[key];
}

/** Indirection keeps absent optional installations out of the baseline bundler graph. */
export async function importExtensionModule<T>(specifier: string): Promise<T> {
  return import(/* @vite-ignore */ specifier) as Promise<T>;
}

/** Package-relative native default; bundled hosts provide the existing asset manifest.
 * A computed specifier prevents disabled presenters being emitted as lazy chunks.
 * The ordinary browser ESM cache remains the only module cache.
 */
export function importPresenterModule<T>(assets: ExtensionAssetsV1 | undefined,
  name: 'search' | 'reorder' | 'slash' | 'references' | 'content'): Promise<T> {
  const url = extensionAsset(assets, name + 'Module', name + '.js')
    ?? new URL('./runtime/' + name + '.js', import.meta.url).href;
  return importExtensionModule<T>(url);
}
